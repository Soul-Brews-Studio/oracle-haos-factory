'use strict';
const assert = require('node:assert/strict');
const ev = require('../pb_hooks/lib/dc_events.js');
const model = require('../pb_public/timeline-model.js');
const G = '1410301189123342488', C = '1500433583255457863', TH = '1536297481099550770';

// validateQuery
let q = ev.validateQuery({});
assert.equal(q.limit, 100); assert.deepEqual(q.kinds, ['message', 'thread', 'import']); assert.equal(q.since, null); assert.equal(q.cursor, null);
q = ev.validateQuery({limit: '50', since: '2026-09-06T00:00:00Z', before: '2026-09-07T00:00:00Z', guilds: `${G},${G}`, kinds: 'thread,message', q: 'hello', cursor: `2026-09-06T12:00:00Z|${C}`});
assert.equal(q.limit, 50); assert.equal(q.since, '2026-09-06T00:00:00.000Z'); assert.deepEqual(q.guilds, [G]); assert.deepEqual(q.kinds, ['message', 'thread']); assert.equal(q.q, 'hello');
assert.deepEqual(q.cursor, {ts: '2026-09-06T12:00:00.000Z', id: C});
for (const bad of [{limit: '0'}, {limit: '201'}, {limit: 'x'}, {since: 'yesterday'}, {since: '2026-09-07T00:00:00Z', before: '2026-09-06T00:00:00Z'}, {guilds: 'abc'}, {kinds: 'message,bogus'}, {q: 'x'.repeat(121)},
  {cursor: 'nope'}, {cursor: '2026-09-06T12:00:00Z|abc'}, {cursor: `2026-09-08T00:00:00Z|${C}`, before: '2026-09-07T00:00:00Z'}, {cursor: `2026-09-05T00:00:00Z|${C}`, since: '2026-09-06T00:00:00Z'}]) {
  assert.throws(() => ev.validateQuery(bad), (e) => e.status === 400, JSON.stringify(bad));
}
assert.throws(() => ev.validateQuery({guilds: Array.from({length: 51}, (_, i) => String(10 ** 17 + i)).join(',')}), /at most 50/);
assert.equal(ev.likePattern('50%_a\\b'), '%50\\%\\_a\\\\b%');
assert.equal(ev.pbDate('2026-09-07T01:02:03.000Z'), '2026-09-07 01:02:03.000Z');
assert.equal(ev.snowflakeTime('1410301189123342488'), '2025-08-27T16:33:25.616Z');
assert.equal(ev.snowflakeTime('abc'), null);

// messageEvent + cursor
const m = ev.messageEvent({message_id: '1500000000000000001', ts: '2026-09-07 01:02:03.000Z', edited: '2026-09-07 01:03:00.000Z', channel_id: C, thread_id: '', guild_id: G, author_id: '9', author_name: 'nat', author_is_bot: 0, content: 'hi', deleted: 1, attachments: 2, reply_to: '', channel: 'mawjs-oracle', thread: '', guild: 'Soul Brews', category: 'Bot'});
assert.equal(m.key, 'm:1500000000000000001'); assert.equal(m.ts, '2026-09-07T01:02:03.000Z'); assert.equal(m.edited, true); assert.equal(m.deleted, true); assert.equal(m.attachments, 2); assert.equal(m.thread_id, null); assert.equal(m.category, 'Bot');
assert.equal(model.sourceLabel(m), 'Soul Brews › Bot › #mawjs-oracle');
assert.equal(ev.cursorOf(m), '2026-09-07T01:02:03.000Z|1500000000000000001');
assert.equal(ev.cursorOf(null), null);

// threadEvents: created (+ archived when archived), snowflake fallback
const t = ev.threadEvents({entity_id: TH, name: 'hey', parent_id: C, guild_id: G, created: '2026-09-06T10:00:00.123000+00:00', archived_at: '', owner_id: '9', archived: 0, channel: 'mawjs-oracle', guild: 'Soul Brews'});
assert.equal(t.length, 1); assert.equal(t[0].kind, 'thread'); assert.equal(t[0].ts, '2026-09-06T10:00:00.123Z'); assert.equal(t[0].text, 'thread created: hey');
assert.equal(model.sourceLabel(t[0]), 'Soul Brews › #mawjs-oracle ↳ hey');
const ta = ev.threadEvents({entity_id: TH, name: 'hey', parent_id: C, guild_id: G, created: '2026-09-06T10:00:00Z', archived_at: '2026-09-07T09:00:00Z', archived: 1, channel: 'mawjs-oracle', guild: 'Soul Brews'});
assert.deepEqual(ta.map(x => [x.key, x.ts, x.text]), [['t:' + TH, '2026-09-06T10:00:00.000Z', 'thread created: hey'], ['ta:' + TH, '2026-09-07T09:00:00.000Z', 'thread archived: hey']]);
const old = ev.threadEvents({entity_id: '1410301189123342488', name: 'old', created: '', archived_at: '', archived: 0});
assert.equal(old.length, 1); assert.equal(old[0].ts, '2025-08-27T16:33:25.616Z', 'pre-2022 style thread falls back to snowflake time');
assert.equal(ev.threadEvents({entity_id: 'x', created: '', archived: 1, archived_at: '2026-09-07T09:00:00Z'}).length, 1, 'archived event alone when creation is unknown');

// importEvent: keyed by entity, "last import"
const i = ev.importEvent(C, '2026-09-07T00:30:00Z', {kind: 'channel', name: 'mawjs-oracle', guild_id: G, guild: 'Soul Brews'});
assert.equal(i.kind, 'import'); assert.equal(i.key, 'i:' + C); assert.equal(i.channel_id, C); assert.equal(i.text, 'last import of mawjs-oracle');
const it = ev.importEvent(TH, '2026-09-07T00:30:00Z', {kind: 'thread', name: 'hey', guild_id: G, guild: 'Soul Brews', parent_id: C, parent: 'mawjs-oracle'});
assert.equal(it.thread_id, TH); assert.equal(it.channel_id, C);
assert.equal(ev.importEvent(C, 'garbage', null), null);
assert.equal(ev.inWindow('2026-09-07T00:00:00.000Z', '2026-09-06T00:00:00.000Z', '2026-09-08T00:00:00.000Z'), true);
assert.equal(ev.inWindow('2026-09-08T00:00:00.000Z', null, '2026-09-08T00:00:00.000Z'), false, 'before is exclusive');
assert.equal(ev.inWindow('2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z', null), true, 'since is inclusive');
assert.equal(ev.inWindow(null, null, null), false);
assert.equal(ev.textMatches(i, 'MAWJS'), true, 'text match is case-insensitive');
assert.equal(ev.textMatches(i, 'backFILL'), true, 'author counts too');
assert.equal(ev.textMatches(i, 'nothing'), false);
assert.equal(ev.textMatches(i, ''), true);

// mergeEvents: newest first, dedupe by key, stable ties
const merged = ev.mergeEvents([[m, {...m}], t, [i]]);
assert.deepEqual(merged.map(x => x.key), ['m:1500000000000000001', 'i:' + C, 't:' + TH]);

// client model
assert.equal(model.sinceFor('1h', Date.parse('2026-09-07T01:00:00Z')), '2026-09-07T00:00:00.000Z');
assert.equal(model.sinceFor('all', 0), null);
assert.equal(model.sinceFor('nope', Date.parse('2026-09-07T01:00:00Z')), '2026-09-06T01:00:00.000Z', 'unknown preset -> 24h');
const names = model.nameIndex({guilds: [{id: G, name: 'Soul Brews'}], channels: [{id: C, name: 'mawjs-oracle', category_id: '1426481478207799366', kind: 'channel'}, {id: '1426481478207799366', name: 'Bot', kind: 'channel'}]});
const live = model.recordEvent({message_id: '2', ts: '2026-09-07 02:00:00.000Z', channel_id: C, guild_id: G, author_id: '9', author_name: 'nat', content: 'live', attachments_json: [], raw: {}}, names);
assert.equal(live.guild, 'Soul Brews'); assert.equal(live.channel, 'mawjs-oracle'); assert.equal(live.category, 'Bot'); assert.equal(live.ts, '2026-09-07T02:00:00.000Z');
assert.equal(model.recordEvent({}, names), null);
assert.equal(model.recordEvent({message_id: '3', ts: 'garbage'}, names).ts, null, 'unparsable ts becomes null, never Invalid Date');
assert.equal(model.matches(live, {guilds: [G], kinds: ['message'], since: '2026-09-07T00:00:00Z', q: 'LIVE'}), true);
assert.equal(model.matches(live, {guilds: ['1']}), false);
assert.equal(model.matches(live, {guilds: []}), false, 'an explicitly empty server selection matches nothing');
assert.equal(model.matches(live, {guilds: null}), true, 'null means every server');
assert.equal(model.matches(live, {kinds: ['thread']}), false);
assert.equal(model.matches(live, {since: '2026-09-08T00:00:00Z'}), false);
assert.equal(model.matches(live, {before: '2026-09-07T02:00:00.000Z'}), false, 'before is exclusive');
assert.equal(model.matches(live, {q: 'nothing here'}), false);
const up = model.upsert([m], live);
assert.deepEqual(up.map(x => x.key), ['m:2', 'm:1500000000000000001']);
assert.equal(model.upsert(up, {...live, text: 'edited'}).find(x => x.key === 'm:2').text, 'edited', 'same key replaces');
const pageTwo = [{key: 'm:0', ts: '2026-09-06T23:00:00.000Z'}, {...live, text: 'newer copy'}];
const appended = model.mergeSorted(up, pageTwo);
assert.deepEqual(appended.map(x => x.key), ['m:2', 'm:1500000000000000001', 'm:0'], 'pages merge by key and stay newest-first');
assert.equal(appended[0].text, 'newer copy', 'incoming wins on a key collision');
const groups = model.groupByDay(up, ts => ts.slice(0, 10));
assert.deepEqual(groups.map(g => [g.day, g.events.length]), [['2026-09-07', 2]]);
assert.deepEqual(model.gatewayLabel({connected: true}), {text: 'connected', tone: 'ok'});
assert.deepEqual(model.gatewayLabel({connected: false, enabled: false}), {text: 'off', tone: 'muted'});
assert.deepEqual(model.gatewayLabel({connected: false, enabled: true, error: 'listener_not_running'}), {text: 'listener not running', tone: 'warn'});
assert.deepEqual(model.gatewayLabel(null), {text: 'disconnected', tone: 'warn'});
console.log('timeline events tests passed');
