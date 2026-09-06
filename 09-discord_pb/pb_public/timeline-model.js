(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  root.DCTimelineModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const WINDOWS = [['1h', 3600e3], ['24h', 86400e3], ['7d', 7 * 86400e3], ['30d', 30 * 86400e3], ['all', 0]];
  function text(value) { return String(value == null ? '' : value).trim(); }
  function sinceFor(preset, now) {
    const found = WINDOWS.find(([name]) => name === preset) || WINDOWS[1];
    return found[1] ? new Date(Number(now) - found[1]).toISOString() : null;
  }
  // "Server › Category › #channel ↳ thread" — the "where" of an event.
  function sourceLabel(event) {
    const parts = [];
    parts.push(event.guild || (event.guild_id ? 'server ' + event.guild_id : 'unknown server'));
    if (event.category) parts.push(event.category);
    if (event.channel || event.channel_id) parts.push('#' + (event.channel || event.channel_id));
    let label = parts.join(' › ');
    if (event.thread || event.thread_id) label += ' ↳ ' + (event.thread || event.thread_id);
    return label;
  }
  // A PocketBase realtime record (discord_messages) -> event, names resolved
  // from the sidebar payload so live rows carry the same "where" as loaded ones.
  function recordEvent(record, names) {
    if (!record || !record.message_id) return null;
    const lookup = (id) => (names && names[id]) || null;
    const channel = lookup(record.channel_id), thread = lookup(record.thread_id), guild = lookup(record.guild_id);
    const category = channel && channel.category_id ? lookup(channel.category_id) : null;
    const raw = record.raw && typeof record.raw === 'object' ? record.raw : {};
    return {
      key: 'm:' + record.message_id, kind: 'message', ts: text(record.ts) ? new Date(text(record.ts).replace(' ', 'T')).toISOString() : null,
      guild_id: text(record.guild_id) || null, guild: guild ? guild.name : null,
      channel_id: text(record.channel_id) || null, channel: channel ? channel.name : null,
      thread_id: text(record.thread_id) || null, thread: thread ? thread.name : null,
      category: category ? category.name : null,
      author_id: text(record.author_id) || null, author: text(record.author_name) || null, bot: !!record.author_is_bot,
      text: String(record.content == null ? '' : record.content),
      edited: !!text(record.edited_timestamp), deleted: !!raw._discord_pb_deleted,
      attachments: Array.isArray(record.attachments_json) ? record.attachments_json.length : 0,
      reply_to: text(record.reply_to) || null, message_id: text(record.message_id), entity_id: null,
    };
  }
  function matches(event, filter) {
    const f = filter || {};
    if (f.guilds && f.guilds.length && f.guilds.indexOf(event.guild_id) < 0) return false;
    if (f.kinds && f.kinds.length && f.kinds.indexOf(event.kind) < 0) return false;
    if (f.since && (!event.ts || event.ts < f.since)) return false;
    const q = text(f.q).toLowerCase();
    if (q && !((event.text || '') + ' ' + (event.author || '')).toLowerCase().includes(q)) return false;
    return true;
  }
  // Insert or replace by key, keep newest first. Returns a new array.
  function upsert(events, event) {
    const rest = events.filter(item => item.key !== event.key);
    rest.push(event);
    return rest.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  }
  function groupByDay(events, dayOf) {
    const groups = [];
    let current = null;
    for (const event of events) {
      const day = dayOf(event.ts);
      if (!current || current.day !== day) { current = { day, events: [] }; groups.push(current); }
      current.events.push(event);
    }
    return groups;
  }
  // Names index from the sidebar payload: id -> {name, category_id}
  function nameIndex(sidebar) {
    const out = {};
    for (const guild of sidebar && sidebar.guilds || []) out[guild.id] = { name: guild.name };
    for (const row of sidebar && sidebar.channels || []) out[row.id] = { name: row.name, category_id: row.category_id || null, kind: row.kind };
    return out;
  }
  return { WINDOWS, sinceFor, sourceLabel, recordEvent, matches, upsert, groupByDay, nameIndex };
});
