'use strict';
const assert = require('node:assert/strict');
const sidebar = require('../pb_hooks/lib/dc_sidebar.js');
const G1 = '1410301189123342488', G2 = '1500665320501940267', G3 = '1501421708077301761', CAT = '1426480473252827166';

// normalizePrefs: garbage in, empty prefs out — never an exception.
assert.deepEqual(sidebar.normalizePrefs(null), {hidden: [], open: {}, collapsed: {}, order: []});
assert.deepEqual(sidebar.normalizePrefs('x'), {hidden: [], open: {}, collapsed: {}, order: []});
assert.deepEqual(sidebar.normalizePrefs({hidden: ['nope', G1], open: {[G1]: 'yes'}, order: 5}), {hidden: [], open: {}, collapsed: {}, order: []});
assert.deepEqual(sidebar.normalizePrefs({hidden: [G1, G1], open: {[G2]: false}, collapsed: {[CAT]: true}, order: [G2, G1]}),
  {hidden: [G1], open: {[G2]: false}, collapsed: {[CAT]: true}, order: [G2, G1]});

// mergePrefs: hide/show add and remove, hidden replaces, open/collapsed merge, order replaces.
let prefs = sidebar.mergePrefs(null, {hide: [G1]});
assert.deepEqual(prefs.hidden, [G1]);
prefs = sidebar.mergePrefs(prefs, {hide: [G2], open: {[G2]: false}});
assert.deepEqual(prefs.hidden, [G1, G2]);
assert.deepEqual(prefs.open, {[G2]: false});
prefs = sidebar.mergePrefs(prefs, {show: [G1], collapsed: {[CAT]: true}});
assert.deepEqual(prefs.hidden, [G2]);
assert.deepEqual(prefs.collapsed, {[CAT]: true});
prefs = sidebar.mergePrefs(prefs, {hidden: [G3], order: [G3, G1]});
assert.deepEqual(prefs.hidden, [G3]);
assert.deepEqual(prefs.order, [G3, G1]);
assert.deepEqual(prefs.open, {[G2]: false}, 'open survives unrelated patches');
assert.throws(() => sidebar.mergePrefs(prefs, {hide: ['abc']}), /non-snowflake/);
assert.throws(() => sidebar.mergePrefs(prefs, {open: {[G1]: 'true'}}), /true or false/);
assert.throws(() => sidebar.mergePrefs(prefs, {bogus: 1}), /unknown sidebar key/);
assert.throws(() => sidebar.mergePrefs(prefs, []), /JSON object/);
assert.throws(() => sidebar.mergePrefs(prefs, {hide: Array.from({length: 501}, (_, i) => String(10 ** 17 + i))}), /at most 500/);

// guildSummary: counts, prefs applied, order then name.
const guilds = sidebar.guildSummary(
  [{entity_id: G2, name: 'zeta'}, {entity_id: G1, name: 'Alpha'}, {entity_id: G3, name: 'beta'}],
  [{guild_id: G1, kind: 'channel', imported_count: 3, last_message_at: '2026-09-01T00:00:00.000Z'},
   {guild_id: G1, kind: 'thread', imported_count: 2, last_message_at: '2026-09-03T00:00:00.000Z'},
   {guild_id: G2, kind: 'channel', imported_count: 0}],
  {[G1]: {count: 5, last: '2026-09-03T00:00:00.000Z'}},
  {hidden: [G3], open: {[G2]: false}, order: [G2]});
assert.deepEqual(guilds.map(g => g.id), [G2, G1, G3], 'ordered guild first, then by name');
assert.equal(guilds[1].channel_count, 1); assert.equal(guilds[1].thread_count, 1); assert.equal(guilds[1].imported_count, 5);
assert.equal(guilds[1].last_message_at, '2026-09-03T00:00:00.000Z');
assert.equal(guilds[0].open, false); assert.equal(guilds[1].open, true);
assert.equal(guilds[2].hidden, true); assert.equal(guilds[2].imported_count, 0); assert.equal(guilds[2].last_message_at, null);
console.log('sidebar prefs tests passed');
