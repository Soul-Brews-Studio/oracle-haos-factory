"use strict";
const $ = (id) => document.getElementById(id);
const KEY = "__dc_superuser_auth__";
let session = null, page = 1, pages = 1, importBatch = null, authenticated = false, configModel = null;
let currentMessages = [], discoveredChannels = [], timelineTarget = null, activeDay = null;
let timelineData = null, timelineWindow = 0;
let messagesGeneration = 0, timelineGeneration = 0;
let realtimeController = null, realtimeGeneration = 0, realtimeConnected = false;
let gatewayConnectedSince = null;
// The channel filter that was actually submitted. Reads use this, never the
// live input value, so half-typed text cannot break a reconnect or a reload.
let submittedFilter = "";
const entityNames = new Map();

function notify(id, message, error = false) {
  $(id).textContent = message;
  $(id).classList.toggle("error", error);
}
async function request(path, options = {}) {
  const response = await fetch("./" + path, {cache: "no-store", ...options});
  let data;
  try { data = await response.json(); } catch (_) { throw new Error("Server returned an unreadable response. Try Refresh."); }
  if (!response.ok) {
    const error = new Error(data.error || data.message || ("Request failed: " + response.status));
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}
async function api(path, options = {}) {
  const headers = {...options.headers, Authorization: session.token};
  return request(path, {...options, headers});
}
async function apiText(path) {
  const response = await fetch("./" + path, {cache: "no-store", headers: {Authorization: session.token}});
  const text = await response.text();
  if (!response.ok) {
    let data; try { data = JSON.parse(text); } catch (_) {}
    throw new Error(data?.error || data?.message || ("Request failed: " + response.status));
  }
  return text;
}
function enableSession(value) {
  authenticated = value;
  for (const id of ["filter-button", "find-button", "import-file"]) $(id).disabled = !value;
  for (const id of ["channels-refresh", "config-validate", "config-save", "config-reload", "config-download"]) $(id).disabled = !value;
  for (const id of ["timeline-target", "timeline-bucket", "jump-date-button"]) $(id).disabled = !value;
  for (const input of document.querySelectorAll("#channel-list input, #channel-list button")) {
    if (input.dataset.busy === "true") continue; // a request of its own is in flight
    input.disabled = !value || input.dataset.locked === "true";
  }
}
// silent: the periodic token refresh. It must not disable (and so blur) the
// controls someone is typing into; only the initial load and a failure do.
async function authenticate(options = {}) {
  const silent = options.silent === true;
  if (!silent) enableSession(false);
  let fresh;
  try {
    fresh = await request("api/discord/admin-token", {method: "POST"});
  } catch (error) {
    const user = error.data?.haUser;
    if (user) {
      $("identity").hidden = false;
      $("ha-user-name").textContent = user.name || "(name not provided)";
      $("ha-user-id").textContent = user.id || "(ID not provided)";
      $("copy-user-id").disabled = !user.id;
      $("copy-user-id").onclick = () => copy(user.id, $("copy-user-id"));
    }
    // Existing manually signed-in PB sessions also work when auto_login is off.
    let stored;
    try { stored = JSON.parse(localStorage.getItem(KEY)); } catch (_) {}
    if (!stored?.token) throw error;
    fresh = await request("api/collections/_superusers/auth-refresh", {
      method: "POST", headers: {Authorization: stored.token}
    });
  }
  session = fresh;
  localStorage.setItem(KEY, JSON.stringify({token: fresh.token, record: fresh.record}));
  if (silent) return;
  $("identity").hidden = true;
  enableSession(true);
  notify("login-status", "Signed in · Archive and import tools are ready.");
}
async function copy(text, button) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const input = document.createElement("textarea");
      input.value = text; input.style.position = "fixed"; input.style.top = "-1000px";
      document.body.append(input); input.select();
      const copied = document.execCommand("copy"); input.remove();
      if (!copied) throw new Error("Clipboard unavailable");
    }
    button.textContent = "Copied";
  } catch (_) { button.textContent = "Select the ID to copy"; }
}
function copyButton(value) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "copy"; button.textContent = "Copy ID";
  button.onclick = () => copy(value, button); return button;
}
async function totals() {
  const data = await request("api/discord/status");
  notify("archive-status", data.total.toLocaleString() + " messages in " + data.channels.length + " channels");
}
function channelRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.channels)) return data.channels;
  throw new Error("Server returned an invalid channel list.");
}
async function setChannelSelected(row, input) {
  input.disabled = true; input.dataset.busy = "true";
  const wanted = input.checked;
  try {
    await api("api/dc/channels/" + encodeURIComponent(row.id) + "/select", {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({on: wanted})
    });
    row.selected = wanted;
    notify("channels-status", (wanted ? "Selected " : "Stopped polling ") + (row.name || row.id) + ".");
  } catch (error) {
    input.checked = !wanted;
    notify("channels-status", error.message, true);
  } finally { delete input.dataset.busy; input.disabled = !authenticated; }
}
function fieldInput(label, value, className = "channel-policy") {
  const input = document.createElement("input"); input.type = "text"; input.value = value || "";
  input.className = className; input.setAttribute("aria-label", label); input.placeholder = label;
  return input;
}
function compactDate(value) { return DCTime.absolute(value).replace(/:\d{2} \+07$/, " +07"); }
function activityValue(row) { return Date.parse(row.last_message_at || 0) || 0; }
function openTimeline(kind, id, name) {
  showTab("archive");
  const value = kind + ":" + id;
  $("timeline-target").value = value;
  timelineTarget = {kind, id, name}; page = 1;
  Promise.all([loadTimeline(), activeDay ? loadMessages() : Promise.resolve()]).catch(error => notify("timeline-range", error.message, true));
  $("timeline-title").scrollIntoView({behavior: "smooth", block: "start"});
}
function addChannelRow(container, row, policy) {
  const div = document.createElement("div"); div.className = "channel-choice" + (row.kind === "thread" ? " thread" : "");
  const selected = document.createElement("input"); selected.type = "checkbox"; selected.className = "import-toggle";
  selected.checked = !!row.selected && row.importable !== false;
  selected.setAttribute("aria-label", "Import " + (row.name || row.id)); selected.title = row.importable === false ? "This Discord channel type cannot be imported" : "Import and poll";
  if (row.importable === false) { selected.disabled = true; selected.dataset.locked = "true"; }
  const identity = document.createElement("span");
  const name = document.createElement("span"); name.className = "channel-name";
  name.textContent = (row.kind === "thread" ? "↳ " : "") + (row.name || "Unnamed");
  const metadata = document.createElement("span"); metadata.className = "channel-detail";
  metadata.textContent = row.id + " · " + Number(row.imported_count || 0).toLocaleString() + " imported" + (row.archived ? " · archived" : "");
  const dates = document.createElement("span"); dates.className = "channel-dates";
  const messageRange = row.first_message_at || row.last_message_at
    ? (row.first_message_at ? compactDate(row.first_message_at) : "Unknown") + " → " + (row.last_message_at ? compactDate(row.last_message_at) : "Unknown")
    : "No messages";
  dates.textContent = "Messages: " + messageRange + " · imported at " + (row.last_import_at ? compactDate(row.last_import_at) : "Not recorded");
  identity.append(name, metadata);
  identity.append(dates);
  const purpose = fieldInput("Purpose", policy.purpose);
  const owner = fieldInput("Owner", policy.owner);
  const postLabel = document.createElement("label"); postLabel.className = "field-label channel-policy"; postLabel.textContent = "Post ";
  const post = document.createElement("input"); post.type = "checkbox"; post.checked = policy.post === true; postLabel.append(post);
  const actions = fieldInput("Actions: thread, pin, archive", Array.isArray(policy.actions) ? policy.actions.join(", ") : "");
  const save = document.createElement("button"); save.type = "button"; save.className = "row-save"; save.textContent = "Save";
  const timeline = document.createElement("button"); timeline.type = "button"; timeline.className = "secondary row-timeline"; timeline.textContent = "Timeline";
  timeline.onclick = () => openTimeline("channel", row.id, row.name || row.id);
  if (row.importable !== false) selected.onchange = () => setChannelSelected(row, selected);
  save.onclick = async () => {
    save.disabled = true;
    try {
      const body = {purpose: purpose.value.trim(), owner: owner.value.trim(), import: selected.checked, post: post.checked,
        actions: actions.value.split(",").map(value => value.trim()).filter(Boolean)};
      await api("api/dc/config/channel/" + encodeURIComponent(row.id), {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
      notify("channels-status", "Saved " + (row.name || row.id) + ".");
      await loadChannels();
    } catch (error) { notify("channels-status", error.message, true); }
    finally { save.disabled = !authenticated; }
  };
  div.append(selected, identity, purpose, owner, postLabel, actions, timeline, save);
  container.append(div);
}
async function loadChannels() {
  notify("channels-status", "Loading declared model…");
  // Keep externally broken YAML editable even when resolved policy fails closed.
  const rawYaml = await apiText("api/dc/config.yaml");
  $("config-yaml").value = rawYaml;
  const [channelData, model] = await Promise.all([api("api/dc/channels"), api("api/dc/config")]);
  const rows = channelRows(channelData); discoveredChannels = rows; configModel = model;
  populateTimelineTargets(rows);
  const policies = model?.channels && typeof model.channels === "object" ? model.channels : {};
  $("channel-list").replaceChildren();
  const guilds = new Map();
  for (const row of rows) {
    const guildId = row.guild_id || "unknown:" + (row.guild || "Unknown guild");
    if (!guilds.has(guildId)) guilds.set(guildId, {name: row.guild || row.guild_id || "Unknown guild", rows: []});
    guilds.get(guildId).rows.push(row);
  }
  const activitySort = $("channel-sort").value === "activity";
  const guildEntries = [...guilds.entries()].sort((a, b) => activitySort
    ? Math.max(0, ...b[1].rows.map(activityValue)) - Math.max(0, ...a[1].rows.map(activityValue))
    : a[1].name.localeCompare(b[1].name) || a[0].localeCompare(b[0]));
  for (const [groupId, guildGroup] of guildEntries) {
    const guild = guildGroup.name, guildRows = guildGroup.rows;
    const group = document.createElement("section"); group.className = "guild-group";
    const heading = document.createElement("div"); heading.className = "guild-title";
    const titleBox = document.createElement("div"), title = document.createElement("h3"); title.textContent = guild;
    const guildDates = document.createElement("span"); guildDates.className = "channel-dates";
    const firstDates = guildRows.map(row => row.first_message_at).filter(Boolean).sort();
    const lastDates = guildRows.map(row => row.last_message_at).filter(Boolean).sort();
    const importDates = guildRows.map(row => row.last_import_at).filter(Boolean).sort();
    guildDates.textContent = firstDates.length
      ? `Messages: ${compactDate(firstDates[0])} → ${compactDate(lastDates[lastDates.length - 1])} · last channel import ${importDates.length ? compactDate(importDates[importDates.length - 1]) : "Not recorded"}`
      : `Messages: No messages · last channel import ${importDates.length ? compactDate(importDates[importDates.length - 1]) : "Not recorded"}`;
    titleBox.append(title, guildDates);
    const guildTimeline = document.createElement("button"); guildTimeline.type = "button"; guildTimeline.className = "secondary"; guildTimeline.textContent = "Timeline";
    const guildId = groupId.startsWith("unknown:") ? null : groupId;
    guildTimeline.disabled = !guildId; guildTimeline.dataset.locked = guildId ? "false" : "true";
    if (guildId) guildTimeline.onclick = () => openTimeline("guild", guildId, guild);
    heading.append(titleBox, guildTimeline); group.append(heading);
    const threads = guildRows.filter(row => row.kind === "thread");
    const channels = guildRows.filter(row => row.kind !== "thread").sort((a, b) => activitySort ? activityValue(b) - activityValue(a) : (a.name || a.id).localeCompare(b.name || b.id));
    for (const row of channels) {
      addChannelRow(group, row, policies[row.id] || {});
      for (const thread of threads.filter(item => item.parent === row.id).sort((a, b) => activitySort ? activityValue(b) - activityValue(a) : (a.name || a.id).localeCompare(b.name || b.id))) addChannelRow(group, thread, policies[thread.id] || {});
    }
    for (const thread of threads.filter(item => !channels.some(row => row.id === item.parent))) addChannelRow(group, thread, policies[thread.id] || {});
    $("channel-list").append(group);
  }
  notify("channels-status", rows.length ? rows.length.toLocaleString() + " discovered channels and threads · config " + (model?.exists ? "loaded" : "not created yet") + "." : "No channels discovered yet. Add a guild in the add-on options, then run backfill.");
}
async function loadMessages() {
  const generation = ++messagesGeneration;
  notify("message-status", "Loading messages…");
  const channel = submittedFilter;
  const query = new URLSearchParams({page, perPage: 20, sort: "-ts,-message_id"});
  const clauses = [];
  if (activeDay) {
    const bounds = DCTime.bounds(activeDay);
    clauses.push(`ts >= ${JSON.stringify(bounds.since.replace("T", " "))}`, `ts < ${JSON.stringify(bounds.before.replace("T", " "))}`);
    if (timelineTarget?.kind === "guild") clauses.push(`guild_id = ${JSON.stringify(timelineTarget.id)}`);
    if (timelineTarget?.kind === "channel") {
      const entity = discoveredChannels.find(row => row.id === timelineTarget.id);
      clauses.push(entity?.kind === "thread" ? `thread_id = ${JSON.stringify(timelineTarget.id)}`
        : `(channel_id = ${JSON.stringify(timelineTarget.id)} && (thread_id = "" || thread_id = null))`);
    }
  } else if (channel) clauses.push("(channel_id=" + JSON.stringify(channel) + " || thread_id=" + JSON.stringify(channel) + ")");
  if (clauses.length) query.set("filter", clauses.join(" && "));
  const data = await api("api/collections/discord_messages/records?" + query);
  if (generation !== messagesGeneration) return false;
  await hydrateEntityNames(data.items);
  if (generation !== messagesGeneration) return false;
  currentMessages = data.items;
  renderMessages();
  pages = Math.max(1, data.totalPages);
  notify("page-label", (activeDay ? DCTime.dayLabel(DCTime.bounds(activeDay).since) + " · " : "") + "Page " + page + " of " + pages);
  notify("message-status", data.totalItems ? data.totalItems.toLocaleString() + (activeDay ? " messages on this Bangkok date" : " matching messages") : (activeDay ? "No messages on this Bangkok date." : "No messages yet. Configure a Discord backfill or import a JSON batch."));
  $("previous").disabled = page <= 1; $("next").disabled = page >= pages;
  return true;
}
function populateTimelineTargets(rows) {
  const select = $("timeline-target"), previous = select.value;
  select.replaceChildren(new Option("Choose a target", ""));
  const guildGroup = document.createElement("optgroup"); guildGroup.label = "Guilds";
  const guilds = new Map();
  for (const row of rows) if (row.guild_id && !guilds.has(row.guild_id)) guilds.set(row.guild_id, row.guild || row.guild_id);
  for (const [id, name] of [...guilds].sort((a, b) => a[1].localeCompare(b[1]))) guildGroup.append(new Option(name + " · " + id, "guild:" + id));
  const channelGroup = document.createElement("optgroup"); channelGroup.label = "Channels and threads";
  for (const row of [...rows].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))) channelGroup.append(new Option((row.name || "Unnamed") + " · " + row.id, "channel:" + row.id));
  select.append(guildGroup, channelGroup);
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
  else if (rows.length) select.value = "channel:" + rows[0].id;
  const [kind, id] = select.value.split(":");
  const option = select.selectedOptions[0];
  timelineTarget = id ? {kind, id, name: option.textContent.replace(/ · \d{17,20}$/, "")} : null;
}
function timelinePath(target) {
  const resource = target.kind === "guild" ? "guilds" : "channels";
  return "api/dc/" + resource + "/" + encodeURIComponent(target.id) + "/timeline?bucket=" + encodeURIComponent($("timeline-bucket").value);
}
async function loadTimeline() {
  const generation = ++timelineGeneration;
  if (!timelineTarget) {
    timelineData = null; $("timeline-strip").replaceChildren(); $("timeline-older").disabled = true; $("timeline-newer").disabled = true;
    notify("timeline-window", ""); notify("timeline-range", "Choose a channel or guild to see its imported range."); return;
  }
  notify("timeline-range", "Loading " + timelineTarget.name + " timeline…");
  const data = await api(timelinePath(timelineTarget));
  if (generation !== timelineGeneration) return false;
  timelineData = data; timelineWindow = 0;
  notify("timeline-range", data.total
    ? `${Number(data.total).toLocaleString()} messages · ${DCTime.absolute(data.first)} → ${DCTime.absolute(data.last)}`
    : "No imported messages for this target.");
  renderTimelineWindow();
  const gaps = Array.isArray(data.gaps) ? data.gaps : [];
  notify("timeline-gaps", gaps.length
    ? gaps.slice(0, 20).map(gap => `${gap.days} empty day${gap.days === 1 ? "" : "s"}: ${gap.since} → ${gap.before}`).join(" · ") + (gaps.length > 20 ? ` · ${gaps.length - 20} more gaps` : "")
    : (data.total ? "No empty days inside this imported range." : ""));
  return true;
}
function renderTimelineWindow() {
  const strip = $("timeline-strip"); strip.replaceChildren();
  const all = Array.isArray(timelineData?.buckets) ? timelineData.buckets : [];
  const limit = timelineData?.bucket === "hour" ? 168 : 240;
  const windows = Math.max(1, Math.ceil(all.length / limit)); timelineWindow = Math.max(0, Math.min(timelineWindow, windows - 1));
  const end = all.length - timelineWindow * limit, start = Math.max(0, end - limit);
  const buckets = all.slice(start, end), maximum = Math.max(1, ...buckets.map(item => Number(item.count) || 0));
  delete strip.dataset.notice;
  for (const bucket of buckets) {
    const bar = document.createElement("button"); bar.type = "button"; bar.className = "timeline-bar"; bar.setAttribute("role", "listitem");
    bar.style.setProperty("--height", Math.max(8, Math.round((Number(bucket.count) || 0) / maximum * 100)) + "%");
    bar.title = `${bucket.label} · ${Number(bucket.count).toLocaleString()} messages`;
    bar.setAttribute("aria-label", bar.title); bar.dataset.date = bucket.date;
    const count = document.createElement("span"); count.textContent = Number(bucket.count).toLocaleString();
    const label = document.createElement("small"); label.textContent = bucket.label; bar.append(count, label);
    bar.onclick = () => jumpToDate(bucket.date);
    strip.append(bar);
  }
  if (!buckets.length) { const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "No active time buckets."; strip.append(empty); }
  $("timeline-older").disabled = !authenticated || start === 0;
  $("timeline-newer").disabled = !authenticated || timelineWindow === 0;
  notify("timeline-window", all.length > limit ? `Active buckets ${start + 1}–${end} of ${all.length}` : "");
}
async function jumpToDate(day) {
  DCTime.bounds(day); $("jump-date-input").value = day; activeDay = day; page = 1;
  await loadMessages();
  const separator = document.querySelector(`.day-separator[data-day="${CSS.escape(day)}"]`);
  (separator || $("messages-title")).scrollIntoView({behavior: "smooth", block: "start"});
}
async function hydrateEntityNames(rows) {
  const ids = [...new Set(rows.flatMap(row => [row.channel_id, row.thread_id, row.guild_id]).filter(Boolean))];
  if (!ids.length) return;
  const eq = new URLSearchParams({perPage: 100, filter: ids.map(id => "entity_id=" + JSON.stringify(id)).join(" || ")});
  const entities = await api("api/collections/discord_entities/records?" + eq);
  for (const entity of entities.items) entityNames.set(entity.entity_id, entity.name);
}
function renderMessages() {
  $("messages").replaceChildren();
  let previousDay = "";
  for (const row of currentMessages) {
    const day = DCTime.bangkokDay(row.ts);
    if (day !== previousDay) {
      const separator = document.createElement("li"); separator.className = "day-separator"; separator.dataset.day = day;
      const label = document.createElement("span"); label.textContent = DCTime.dayLabel(row.ts); separator.append(label);
      $("messages").append(separator); previousDay = day;
    }
    $("messages").append(messageElement(row));
  }
  tickRelativeTimes();
}
function deletedMessage(row) {
  let raw = row.raw;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch (_) {} }
  return raw?._discord_pb_deleted === true;
}
function messageElement(row, action = "") {
    const li = document.createElement("li"), meta = document.createElement("div");
    li.className = "message-row";
    li.dataset.messageId = row.message_id || "";
    meta.className = "message-meta";
    const author = document.createElement("strong"); author.textContent = row.author_name || row.author_id;
    const time = document.createElement("time"); time.dateTime = DCTime.iso(row.ts); time.title = DCTime.iso(row.ts);
    const absolute = document.createElement("span"); absolute.className = "absolute-time"; absolute.textContent = DCTime.absolute(row.ts);
    const relative = document.createElement("span"); relative.className = "relative-time"; relative.dataset.ts = DCTime.iso(row.ts);
    time.append(absolute, relative); meta.append(author, time);
    const content = document.createElement("p"); content.className = "message-content";
    const deleted = action === "delete" || deletedMessage(row);
    content.textContent = deleted ? "(Deleted message)" : (row.content || "(No text content)");
    if (deleted) li.classList.add("deleted-message");
    const detail = document.createElement("div"); detail.className = "message-ids";
    const target = row.thread_id || row.channel_id;
    detail.textContent = (entityNames.get(target) || "Unnamed target") + " · " + target + " · message " + row.message_id;
    li.append(meta, content, detail, copyButton(row.message_id));
    return li;
}
function tickRelativeTimes() {
  const now = Date.now();
  for (const node of document.querySelectorAll(".relative-time[data-ts]")) node.textContent = DCTime.relative(node.dataset.ts, now);
}
function matchesCurrentChannel(row) {
  if (activeDay) {
    if (DCTime.bangkokDay(row.ts) !== activeDay) return false;
    if (timelineTarget?.kind === "guild") return row.guild_id === timelineTarget.id;
    if (timelineTarget?.kind === "channel") {
      const entity = discoveredChannels.find(item => item.id === timelineTarget.id);
      return entity?.kind === "thread" ? row.thread_id === timelineTarget.id : row.channel_id === timelineTarget.id && !row.thread_id;
    }
    return true;
  }
  const channel = submittedFilter;
  return !channel || row.channel_id === channel || row.thread_id === channel;
}
function applyRealtimeMessage(row, action) {
  if (!row?.message_id) return;
  const index = currentMessages.findIndex(item => item.message_id === row.message_id);
  if (!matchesCurrentChannel(row)) { if (index >= 0) currentMessages.splice(index, 1); renderMessages(); return; }
  const normalized = action === "delete" ? {...row, raw: {...(typeof row.raw === "object" ? row.raw : {}), _discord_pb_deleted: true}} : row;
  if (index >= 0) currentMessages[index] = normalized;
  else if (page === 1) currentMessages.push(normalized);
  currentMessages.sort((a, b) => String(b.ts).localeCompare(String(a.ts)) || String(b.message_id).localeCompare(String(a.message_id)));
  currentMessages = currentMessages.slice(0, 20); renderMessages();
}
class PanelSSEDecoder {
  constructor() { this.buffer = ""; }
  feed(chunk) {
    this.buffer += chunk;
    this.buffer = this.buffer.replace(/\r\n/g, "\n").replace(/\r(?!$)/g, "\n");
    const events = []; let boundary;
    while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, boundary); this.buffer = this.buffer.slice(boundary + 2);
      let event = "message"; const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trimStart();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) events.push({event, data: data.join("\n")});
    }
    return events;
  }
}
function stopRealtime() {
  realtimeGeneration++; realtimeController?.abort(); realtimeController = null; realtimeConnected = false;
}
function startRealtime() {
  stopRealtime();
  const generation = realtimeGeneration, controller = new AbortController();
  realtimeController = controller;
  (async () => {
    while (!controller.signal.aborted && generation === realtimeGeneration) {
      let reader = null;
      try {
        notify("live-status", "Connecting panel updates…");
        const response = await fetch("./api/realtime", {headers: {Accept: "text/event-stream", Authorization: session.token}, signal: controller.signal, cache: "no-store"});
        if (!response.ok || !response.body) throw new Error("HTTP " + response.status);
        reader = response.body.getReader();
        const text = new TextDecoder(), decoder = new PanelSSEDecoder();
        let subscribed = false;
        while (!controller.signal.aborted) {
          const part = await reader.read(); if (part.done) break;
          for (const event of decoder.feed(text.decode(part.value, {stream: true}))) {
            let data; try { data = JSON.parse(event.data); } catch (_) { continue; }
            if (event.event === "PB_CONNECT") {
              const subscribe = await fetch("./api/realtime", {method: "POST", cache: "no-store", signal: controller.signal,
                headers: {Accept: "application/json", Authorization: session.token, "Content-Type": "application/json"},
                body: JSON.stringify({clientId: data.clientId, subscriptions: ["discord_messages/*"]})});
              if (!subscribe.ok) throw new Error("subscription HTTP " + subscribe.status);
              subscribed = true; realtimeConnected = true;
              notify("live-status", "Panel updates connected.");
              // Close the initial load -> subscribe race, and fill non-replayed
              // gaps after reconnect. Rendering is idempotent by message_id.
              // A failed reload is a data problem, not a transport one: report
              // it and keep the stream open instead of reconnecting every second.
              try { await loadMessages(); } catch (error) { notify("message-status", error.message, true); }
              continue;
            }
            if (!subscribed || (event.event !== "discord_messages/*" && event.event !== "discord_messages")) continue;
            if (["create", "update", "delete"].includes(data.action) && data.record) applyRealtimeMessage(data.record, data.action);
          }
        }
      } catch (error) {
        try { await reader?.cancel(); } catch (_) {}
        if (controller.signal.aborted) break;
        realtimeConnected = false; notify("live-status", "Panel updates reconnecting…", true);
      }
      if (!controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  })();
}
async function refreshGatewayStatus() {
  const data = await api("api/dc/status"), live = data.live_status || {};
  gatewayConnectedSince = live.connected && live.connected_since ? live.connected_since : null;
  notify("gateway-status", gatewayConnectedSince
    ? "Discord Gateway live since " + DCTime.absolute(gatewayConnectedSince) + "."
    : "Discord Gateway is not connected; polling remains the archive reconciler.");
}
async function loadJob() {
  const job = await api("api/discord/backfill");
  $("backfill").disabled = !job.configured || job.state === "running" || job.queued;
  notify("backfill-status", !job.configured
    ? "No bot token or targets configured. Set bot_token and channels or guilds in the add-on options, then restart. Or import JSON below."
    : (job.queued ? "Queued for the next available worker." : "Backfill: " + job.state + (job.finished_at ? " · " + new Date(job.finished_at).toLocaleString() : "")),
    job.state === "failed");
}
async function refresh() {
  $("refresh").disabled = true;
  try {
    await totals();
    await authenticate();
    // Each section reports its own failure in its own status line; one broken
    // section (an invalid dc.config.yaml, say) must not read as a sign-in
    // problem or stop the timeline and live updates from starting.
    const sections = [["message-status", loadMessages], ["backfill-status", loadJob], ["channels-status", loadChannels], ["gateway-status", refreshGatewayStatus]];
    const settled = await Promise.allSettled(sections.map(([, load]) => load()));
    settled.forEach((result, index) => { if (result.status === "rejected") notify(sections[index][0], result.reason?.message || String(result.reason), true); });
    try { await loadTimeline(); } catch (error) { notify("timeline-range", error.message, true); }
    startRealtime();
  } catch (error) {
    notify("login-status", error.message + " You can also sign in using Open PocketBase admin, then return and Refresh.", true);
  } finally { $("refresh").disabled = false; }
}
$("refresh").onclick = refresh;
function showTab(name) {
  const model = name === "model";
  $("archive-view").hidden = model; $("model-view").hidden = !model;
  $("archive-tab").classList.toggle("active", !model); $("model-tab").classList.toggle("active", model);
  $("archive-tab").setAttribute("aria-selected", String(!model)); $("model-tab").setAttribute("aria-selected", String(model));
}
$("archive-tab").onclick = () => showTab("archive");
$("model-tab").onclick = () => showTab("model");
$("channel-sort").onchange = () => loadChannels().catch(error => notify("channels-status", error.message, true));
$("timeline-target").onchange = () => {
  const [kind, id] = $("timeline-target").value.split(":");
  const option = $("timeline-target").selectedOptions[0];
  timelineTarget = id ? {kind, id, name: option.textContent.replace(/ · \d{17,20}$/, "")} : null; page = 1;
  Promise.all([loadTimeline(), activeDay ? loadMessages() : Promise.resolve()]).catch(error => notify("timeline-range", error.message, true));
};
$("timeline-bucket").onchange = () => loadTimeline().catch(error => notify("timeline-range", error.message, true));
$("timeline-older").onclick = () => { timelineWindow++; renderTimelineWindow(); };
$("timeline-newer").onclick = () => { timelineWindow--; renderTimelineWindow(); };
$("jump-date").onsubmit = event => {
  event.preventDefault();
  jumpToDate($("jump-date-input").value).catch(error => notify("message-status", error.message, true));
};
$("channels-refresh").onclick = async () => {
  $("channels-refresh").disabled = true;
  try { await loadChannels(); } catch (error) { notify("channels-status", error.message, true); }
  finally { $("channels-refresh").disabled = !authenticated; }
};
async function configRequest(path, body, success) {
  try {
    const result = await api("api/dc/config/" + path, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
    notify("config-status", success);
    return result;
  } catch (error) { notify("config-status", error.message, true); throw error; }
}
$("config-validate").onclick = async () => {
  $("config-validate").disabled = true;
  try { await configRequest("validate", {yaml: $("config-yaml").value}, "Configuration is valid. Nothing was saved."); }
  catch (_) {} finally { $("config-validate").disabled = !authenticated; }
};
$("config-save").onclick = async () => {
  $("config-save").disabled = true;
  try { await configRequest("save", {yaml: $("config-yaml").value}, "Configuration saved and applied."); await loadChannels(); }
  catch (_) {} finally { $("config-save").disabled = !authenticated; }
};
$("config-reload").onclick = async () => {
  $("config-reload").disabled = true;
  try { await configRequest("reload", {}, "Configuration reloaded from disk."); await loadChannels(); }
  catch (_) {} finally { $("config-reload").disabled = !authenticated; }
};
$("config-download").onclick = () => {
  const yaml = $("config-yaml").value;
  const url = URL.createObjectURL(new Blob([yaml], {type: "text/yaml;charset=utf-8"}));
  const link = document.createElement("a"); link.href = url; link.download = "dc.config.yaml"; link.click(); URL.revokeObjectURL(url);
  notify("config-status", "Downloaded dc.config.yaml.");
};
$("message-filter").onsubmit = async event => {
  event.preventDefault();
  const channel = $("channel-filter").value.trim();
  if (channel && !/^[0-9]{17,20}$/.test(channel)) { notify("message-status", "Use a 17–20 digit channel or thread ID. Find a name in the lookup box.", true); return; }
  submittedFilter = channel; page = 1; activeDay = null; $("jump-date-input").value = "";
  try { await loadMessages(); } catch (error) { notify("message-status", error.message, true); }
};
for (const [id, direction] of [["previous", -1], ["next", 1]]) $(id).onclick = async () => {
  const previous = page; page += direction;
  try { await loadMessages(); } catch (error) { page = previous; notify("message-status", error.message, true); }
};
$("entity-find").onsubmit = async event => {
  event.preventDefault(); $("find-button").disabled = true;
  try {
    const name = $("entity-name").value.trim();
    if (!name) throw new Error("Enter a name to find.");
    const query = new URLSearchParams({perPage: 100, sort: "kind,name,entity_id", filter: "name ~ " + JSON.stringify(name)});
    const data = await api("api/collections/discord_entities/records?" + query);
    $("entity-result").replaceChildren();
    if (!data.items.length) notify("entity-result", "No names found. Entities are discovered during a Discord backfill.");
    for (const row of data.items) {
      const div = document.createElement("div"); div.className = "entity-row";
      const label = document.createElement("div"); label.textContent = row.kind + ": " + row.name;
      const id = document.createElement("code"); id.textContent = row.entity_id;
      const parent = document.createElement("p"); parent.className = "hint"; parent.textContent = "Parent: " + (row.parent_id || "none") + " · Guild: " + (row.guild_id || "none");
      div.append(label, id, document.createElement("br"), copyButton(row.entity_id), parent);
      $("entity-result").append(div);
    }
    if (data.totalItems > data.items.length) {
      const note = document.createElement("p"); note.textContent = "Showing first 100 matches. Refine the name to narrow results."; $("entity-result").append(note);
    }
  } catch (error) { notify("entity-result", error.message, true); }
  finally { $("find-button").disabled = !authenticated; }
};
$("import-file").onchange = async () => {
  importBatch = null; $("import-button").disabled = true;
  const file = $("import-file").files[0];
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("File exceeds 2 MiB. Split it into smaller JSON batches.");
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.messages) || data.messages.length < 1 || data.messages.length > 100) throw new Error("Expected an object with a messages array containing 1–100 rows.");
    importBatch = data;
    notify("import-preview", file.name + " · " + data.messages.length + " messages ready. Existing IDs will be updated.");
    $("import-button").disabled = false;
  } catch (error) { notify("import-preview", error.message, true); }
};
$("import-button").onclick = async () => {
  if (!importBatch) return;
  $("import-button").disabled = true; $("import-file").disabled = true;
  notify("import-result", "Importing batch…");
  try {
    const result = await api("api/discord/import", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(importBatch)});
    notify("import-result", "Import complete: " + result.inserted + " inserted, " + result.updated + " updated.");
    importBatch = null;
    await totals(); page = 1; await loadMessages();
  } catch (error) {
    notify("import-result", error.message + " Verify the batch and retry. Reusing message IDs does not create duplicates.", true);
    $("import-button").disabled = false;
  } finally { $("import-file").disabled = !authenticated; }
};
$("backfill").onclick = async () => {
  $("backfill").disabled = true;
  try { await api("api/discord/backfill", {method: "POST"}); await loadJob(); }
  catch (error) { notify("backfill-status", error.message, true); }
};
setInterval(async () => {
  if (!authenticated || document.hidden) return;
  try { await authenticate({silent: true}); await loadJob(); await totals(); await refreshGatewayStatus(); }
  catch (_) { notify("login-status", "Session refresh failed. Use Refresh to reconnect.", true); }
}, 60000);
setInterval(tickRelativeTimes, 30000);
refresh();
