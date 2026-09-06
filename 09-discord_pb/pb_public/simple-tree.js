(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  root.DCSimpleTree = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function text(value) { return String(value || '').trim(); }
  function byName(a, b) { return text(a.name).localeCompare(text(b.name), undefined, {sensitivity:'base'}); }
  function buildTree(rows) {
    const guilds = new Map(); const channels = new Map();
    for (const row of rows || []) {
      if (row.kind === 'guild') guilds.set(row.id || row.entity_id, {...row, channels: []});
      if (row.kind === 'channel') channels.set(row.id || row.entity_id, {...row, threads: []});
    }
    for (const channel of channels.values()) {
      const guildId = channel.guild_id || channel.parent;
      const guild = guilds.get(guildId) || (guildId ? {id:guildId, name:channel.guild || guildId, channels:[]} : null);
      if (guild && !guilds.has(guildId)) guilds.set(guildId, guild);
      if (guild) guild.channels.push(channel);
    }
    for (const row of rows || []) if (row.kind === 'thread') {
      const parent = channels.get(row.parent);
      if (parent) parent.threads.push({...row});
    }
    return [...guilds.values()].sort(byName).map(guild => ({...guild, channels:guild.channels.sort(byName).map(channel => ({...channel, threads:channel.threads.sort(byName)}))}));
  }
  return {buildTree};
});
