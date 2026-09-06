(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  root.DCSimpleTree = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CATEGORY = 4, VOICE = [2, 13], FORUM = [15, 16];
  function text(value) { return String(value || '').trim(); }
  function byName(a, b) { return text(a.name).localeCompare(text(b.name), undefined, {sensitivity:'base'}); }
  // Discord orders siblings by position, then by name; threads by name only.
  function byPosition(a, b) { return (Number(a.position) || 0) - (Number(b.position) || 0) || byName(a, b); }
  function has(map, key) { return Object.prototype.hasOwnProperty.call(map || {}, key); }

  function iconFor(row) {
    if (row.kind === 'thread') return '↳';
    if (VOICE.indexOf(row.discord_type) >= 0) return '🔊';
    if (FORUM.indexOf(row.discord_type) >= 0) return '▤';
    if (row.discord_type === 5) return '📣';
    return '#';
  }

  // Legacy flat tree (kept for the old test and any caller without prefs).
  function buildTree(rows) {
    return buildSidebar({channels: rows, guilds: [], prefs: {}}).map(guild => ({
      id: guild.id, name: guild.name,
      channels: guild.categories.flatMap(category => category.channels).sort(byName),
    }));
  }

  // rows: /api/dc/sidebar payload {guilds, channels, prefs}. Guilds come out in
  // preference order, each with categories (Discord type 4, plus one synthetic
  // "" category for uncategorised channels), and every channel carries its threads.
  function buildSidebar(data) {
    const prefs = Object.assign({hidden: [], open: {}, collapsed: {}, order: []}, data && data.prefs || {});
    const guilds = new Map();
    for (const row of data && data.guilds || []) guilds.set(row.id, Object.assign({}, row, {categories: []}));
    const categories = new Map(), channels = new Map(), rows = data && data.channels || [];
    for (const row of rows) {
      if (row.kind === 'guild') { if (!guilds.has(row.id)) guilds.set(row.id, Object.assign({}, row, {categories: []})); continue; }
      if (row.kind !== 'channel') continue; // threads attach to their parent below
      const guildId = row.guild_id || row.parent;
      if (!guilds.has(guildId)) guilds.set(guildId, {id: guildId, name: row.guild || guildId || 'Unknown server', categories: [], inferred: true});
      if (row.kind === 'channel' && row.discord_type === CATEGORY) { categories.set(row.id, Object.assign({}, row, {channels: []})); continue; }
      if (row.kind === 'channel') channels.set(row.id, Object.assign({}, row, {threads: [], icon: iconFor(row)}));
    }
    for (const row of rows) if (row.kind === 'thread') {
      const parent = channels.get(row.parent);
      if (parent) parent.threads.push(Object.assign({}, row, {icon: iconFor(row)}));
      else {
        // Orphan thread (parent not discovered): keep it visible under its guild.
        const guildId = row.guild_id, orphan = Object.assign({}, row, {threads: [], icon: iconFor(row), orphan: true, position: 1e9});
        if (guilds.has(guildId)) channels.set(row.id, orphan);
      }
    }
    const buckets = new Map(); // guildId -> Map(categoryId -> category)
    const bucket = (guildId, category) => {
      if (!buckets.has(guildId)) buckets.set(guildId, new Map());
      const map = buckets.get(guildId), key = category ? category.id : '';
      if (!map.has(key)) map.set(key, {id: key, name: category ? category.name : '', position: category ? category.position : -1, channels: [],
        collapsed: key ? !!prefs.collapsed[key] : false});
      return map.get(key);
    };
    for (const channel of channels.values()) {
      const guildId = channel.guild_id || channel.parent;
      const category = channel.category_id ? categories.get(channel.category_id) : null;
      const target = category && category.guild_id === guildId ? category : null;
      bucket(guildId, target).channels.push(channel);
    }
    for (const [guildId, map] of buckets) {
      const guild = guilds.get(guildId);
      if (!guild) continue;
      guild.categories = [...map.values()].sort(byPosition).map(category => Object.assign(category, {
        channels: category.channels.sort(byPosition).map(channel => Object.assign(channel, {threads: channel.threads.sort(byName)})),
      }));
    }
    const rank = {}; prefs.order.forEach((id, index) => { rank[id] = index; });
    return [...guilds.values()].map(guild => Object.assign(guild, {
      hidden: prefs.hidden.indexOf(guild.id) >= 0,
      open: has(prefs.open, guild.id) ? !!prefs.open[guild.id] : (guild.open !== false),
      channel_count: guild.categories.reduce((n, c) => n + c.channels.length, 0),
    })).sort((a, b) => {
      const ra = rank[a.id], rb = rank[b.id];
      if (ra !== undefined || rb !== undefined) return ra === undefined ? 1 : rb === undefined ? -1 : ra - rb;
      return byName(a, b);
    });
  }

  // Resolve a ?guild= query value (id or name) against the built sidebar.
  function findGuild(guilds, query) {
    const wanted = text(query);
    if (!wanted) return null;
    const byId = guilds.find(guild => guild.id === wanted);
    if (byId) return byId;
    const folded = wanted.toLowerCase();
    return guilds.find(guild => text(guild.name).toLowerCase() === folded) || guilds.find(guild => text(guild.name).toLowerCase().includes(folded)) || null;
  }

  // The room to open when a server is picked: a polled room first, then the
  // room holding the most archived messages, then the first importable one —
  // an archive should open on something readable, not on an empty #general.
  function firstRoom(guild) {
    const rooms = [];
    for (const category of guild && guild.categories || []) for (const channel of category.channels) if (channel.importable !== false) rooms.push(channel);
    if (!rooms.length) return null;
    const polled = rooms.find(room => room.selected);
    if (polled) return polled;
    const richest = rooms.reduce((best, room) => (Number(room.imported_count) || 0) > (Number(best.imported_count) || 0) ? room : best, rooms[0]);
    return (Number(richest.imported_count) || 0) > 0 ? richest : rooms[0];
  }

  return {buildTree, buildSidebar, findGuild, firstRoom, iconFor};
});
