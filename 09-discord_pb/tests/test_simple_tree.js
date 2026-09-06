'use strict';
const assert = require('node:assert/strict');
const {buildTree} = require('../pb_public/simple-tree.js');
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
console.log('simple tree tests passed');
