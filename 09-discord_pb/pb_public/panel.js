"use strict";
const $ = (id) => document.getElementById(id);
const KEY = "__dc_superuser_auth__";
let session = null, page = 1, pages = 1, importBatch = null, authenticated = false, configModel = null;

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
  for (const input of document.querySelectorAll("#channel-list input, #channel-list button")) input.disabled = !value || input.dataset.locked === "true";
}
async function authenticate() {
  enableSession(false);
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
  input.disabled = true;
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
  } finally { input.disabled = !authenticated; }
}
function fieldInput(label, value, className = "channel-policy") {
  const input = document.createElement("input"); input.type = "text"; input.value = value || "";
  input.className = className; input.setAttribute("aria-label", label); input.placeholder = label;
  return input;
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
  identity.append(name, metadata);
  const purpose = fieldInput("Purpose", policy.purpose);
  const owner = fieldInput("Owner", policy.owner);
  const postLabel = document.createElement("label"); postLabel.className = "field-label channel-policy"; postLabel.textContent = "Post ";
  const post = document.createElement("input"); post.type = "checkbox"; post.checked = policy.post === true; postLabel.append(post);
  const actions = fieldInput("Actions: thread, pin, archive", Array.isArray(policy.actions) ? policy.actions.join(", ") : "");
  const save = document.createElement("button"); save.type = "button"; save.className = "row-save"; save.textContent = "Save";
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
  div.append(selected, identity, purpose, owner, postLabel, actions, save);
  container.append(div);
}
async function loadChannels() {
  notify("channels-status", "Loading declared model…");
  // Keep externally broken YAML editable even when resolved policy fails closed.
  const rawYaml = await apiText("api/dc/config.yaml");
  $("config-yaml").value = rawYaml;
  const [channelData, model] = await Promise.all([api("api/dc/channels"), api("api/dc/config")]);
  const rows = channelRows(channelData); configModel = model;
  const policies = model?.channels && typeof model.channels === "object" ? model.channels : {};
  $("channel-list").replaceChildren();
  const guilds = new Map();
  for (const row of rows) {
    const guild = row.guild || "Unknown guild";
    if (!guilds.has(guild)) guilds.set(guild, []);
    guilds.get(guild).push(row);
  }
  for (const [guild, guildRows] of [...guilds.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const group = document.createElement("section"); group.className = "guild-group";
    const title = document.createElement("h3"); title.className = "guild-title"; title.textContent = guild; group.append(title);
    const threads = guildRows.filter(row => row.kind === "thread");
    const channels = guildRows.filter(row => row.kind !== "thread");
    for (const row of channels) {
      addChannelRow(group, row, policies[row.id] || {});
      for (const thread of threads.filter(item => item.parent === row.id)) addChannelRow(group, thread, policies[thread.id] || {});
    }
    for (const thread of threads.filter(item => !channels.some(row => row.id === item.parent))) addChannelRow(group, thread, policies[thread.id] || {});
    $("channel-list").append(group);
  }
  notify("channels-status", rows.length ? rows.length.toLocaleString() + " discovered channels and threads · config " + (model?.exists ? "loaded" : "not created yet") + "." : "No channels discovered yet. Add a guild in the add-on options, then run backfill.");
}
async function loadMessages() {
  notify("message-status", "Loading messages…");
  const channel = $("channel-filter").value.trim();
  if (channel && !/^[0-9]{17,20}$/.test(channel)) throw new Error("Use a 17–20 digit channel or thread ID. Find a name in the lookup box.");
  const query = new URLSearchParams({page, perPage: 20, sort: "-ts,-message_id"});
  if (channel) query.set("filter", "channel_id=" + JSON.stringify(channel) + " || thread_id=" + JSON.stringify(channel));
  const data = await api("api/collections/discord_messages/records?" + query);
  const ids = [...new Set(data.items.flatMap(row => [row.channel_id, row.thread_id, row.guild_id]).filter(Boolean))];
  const names = new Map();
  if (ids.length) {
    const eq = new URLSearchParams({perPage: 100, filter: ids.map(id => "entity_id=" + JSON.stringify(id)).join(" || ")});
    const entities = await api("api/collections/discord_entities/records?" + eq);
    for (const entity of entities.items) names.set(entity.entity_id, entity.name);
  }
  $("messages").replaceChildren();
  for (const row of data.items) {
    const li = document.createElement("li"), meta = document.createElement("div");
    meta.className = "message-meta";
    const author = document.createElement("strong"); author.textContent = row.author_name || row.author_id;
    const time = document.createElement("time"); time.dateTime = row.ts;
    const date = new Date(row.ts); time.textContent = Number.isNaN(date.getTime()) ? row.ts : date.toLocaleString();
    meta.append(author, time);
    const content = document.createElement("p"); content.className = "message-content";
    content.textContent = row.content || "(No text content)";
    const detail = document.createElement("div"); detail.className = "message-ids";
    const target = row.thread_id || row.channel_id;
    detail.textContent = (names.get(target) || "Unnamed target") + " · " + target + " · message " + row.message_id;
    li.append(meta, content, detail, copyButton(row.message_id));
    $("messages").append(li);
  }
  pages = Math.max(1, data.totalPages);
  notify("page-label", "Page " + page + " of " + pages);
  notify("message-status", data.totalItems ? data.totalItems.toLocaleString() + " matching messages" : "No messages yet. Configure a Discord backfill or import a JSON batch.");
  $("previous").disabled = page <= 1; $("next").disabled = page >= pages;
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
    await Promise.all([loadMessages(), loadJob(), loadChannels()]);
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
  event.preventDefault(); page = 1;
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
  try { await authenticate(); await loadJob(); await totals(); }
  catch (_) { notify("login-status", "Session refresh failed. Use Refresh to reconnect.", true); }
}, 60000);
refresh();
