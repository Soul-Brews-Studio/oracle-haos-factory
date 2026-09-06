'use strict';
const assert = require('node:assert/strict');
const {buildTree, buildSidebar, findGuild, firstRoom, iconFor} = require('../pb_public/simple-tree.js');

// Legacy flat tree keeps its contract.
const tree = buildTree([
  {id:'guild-b',kind:'guild',name:'Bravo'}, {id:'guild-a',kind:'guild',name:'Alpha'},
  {id:'channel-b',kind:'channel',name:'Zulu',guild_id:'guild-a'}, {id:'channel-a',kind:'channel',name:'General',guild_id:'guild-a'},
  {id:'thread-b',kind:'thread',name:'Later',parent:'channel-a'}, {id:'thread-a',kind:'thread',name:'Earlier',parent:'channel-a'}
]);
assert.deepEqual(tree.map(row=>row.name),['Alpha','Bravo']);
assert.deepEqual(tree[0].channels.map(row=>row.name),['General','Zulu']);
assert.deepEqual(tree[0].channels[0].threads.map(row=>row.name),['Earlier','Later']);
const inferred=buildTree([{id:'c',kind:'channel',name:'General',guild_id:'g',guild:'Missing guild'}]);
assert.equal(inferred[0].name,'Missing guild');

// Server-by-server sidebar: categories, positions, threads, orphans, prefs.
const G1='1410301189123342488', G2='1500665320501940267', G3='1501421708077301761', CAT='1426480473252827166';
const data = {
  guilds: [{id:G2,name:'zeta',open:true}, {id:G1,name:'Alpha',open:true}, {id:G3,name:'beta',open:true}],
  channels: [
    {id:CAT,kind:'channel',name:'Workshop',guild_id:G1,discord_type:4,position:1},
    {id:'1000000000000000001',kind:'channel',name:'zz-last',guild_id:G1,discord_type:0,position:5,category_id:CAT,importable:true},
    {id:'1000000000000000002',kind:'channel',name:'aa-first',guild_id:G1,discord_type:0,position:2,category_id:CAT,importable:true},
    {id:'1000000000000000003',kind:'channel',name:'lobby',guild_id:G1,discord_type:2,position:0,importable:false},
    {id:'1000000000000000004',kind:'channel',name:'news',guild_id:G1,discord_type:5,position:1,importable:true},
    {id:'1000000000000000005',kind:'thread',name:'B thread',guild_id:G1,parent:'1000000000000000002',discord_type:11,importable:true},
    {id:'1000000000000000006',kind:'thread',name:'A thread',guild_id:G1,parent:'1000000000000000002',discord_type:11,importable:true},
    {id:'1000000000000000007',kind:'thread',name:'orphan',guild_id:G1,parent:'1999999999999999999',discord_type:11,importable:true},
    {id:'1000000000000000008',kind:'channel',name:'foreign-category',guild_id:G2,discord_type:0,position:0,category_id:CAT,importable:true},
  ],
  prefs: {hidden:[G3], open:{[G2]:false}, collapsed:{[CAT]:true}, order:[G2]},
};
const guilds = buildSidebar(data);
assert.deepEqual(guilds.map(g=>g.id), [G2, G1, G3], 'order pref first, then name');
const alpha = guilds[1];
assert.deepEqual(alpha.categories.map(c=>c.name), ['', 'Workshop'], 'uncategorised bucket first, then categories by position');
assert.deepEqual(alpha.categories[0].channels.map(c=>c.name), ['lobby','news','orphan'], 'position order; orphan thread stays visible');
assert.deepEqual(alpha.categories[1].channels.map(c=>c.name), ['aa-first','zz-last']);
assert.equal(alpha.categories[1].collapsed, true);
assert.deepEqual(alpha.categories[1].channels[0].threads.map(t=>t.name), ['A thread','B thread']);
assert.equal(alpha.channel_count, 5);
assert.equal(guilds[0].open, false); assert.equal(alpha.open, true);
assert.equal(guilds[2].hidden, true);
assert.equal(guilds[0].categories[0].name, '', 'a category from another guild is not trusted');
assert.equal(firstRoom(alpha).name, 'news', 'first importable room, voice skipped');
assert.equal(findGuild(guilds, G1).name, 'Alpha');
assert.equal(findGuild(guilds, 'alpha').id, G1);
assert.equal(findGuild(guilds, 'ET').id, G2, 'substring fallback');
assert.equal(findGuild(guilds, ''), null);
assert.equal(iconFor({kind:'channel',discord_type:2}), '🔊');
assert.equal(iconFor({kind:'thread'}), '↳');
const emptyGuild = buildSidebar({guilds:[{id:G3,name:'empty'}], channels:[], prefs:{}});
assert.equal(emptyGuild[0].categories.length, 0); assert.equal(emptyGuild[0].open, true); assert.equal(emptyGuild[0].hidden, false);
console.log('simple tree tests passed');
