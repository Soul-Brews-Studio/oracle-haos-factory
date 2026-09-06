const assert = require('node:assert/strict')
const ingest = require('../pb_hooks/lib/discord_ingest.js')
const live = require('../pb_hooks/lib/discord_live.js')
const C = '900000000000000000', T = '900000000000000001', G = '900000000000000002'
const A = '900000000000000003', M = '900000000100000000'
let assertions = 0
function check(actual, expected) { assert.deepEqual(actual, expected); assertions++ }
class Row {
  constructor(collection) { this.collection = collection; this.data = {} }
  set(k, v) { this.data[k] = v }
  getString(k) { return this.data[k] && typeof this.data[k] === 'object' ? JSON.stringify(this.data[k]) : String(this.data[k] || '') }
  publicExport() {
    const value=JSON.parse(JSON.stringify(this.data))
    // Match JSVM's JSONRaw wrappers, not Node's convenient plain objects.
    for(const key of ['raw','attachments_json','embeds']) if(key in value) value[key]=Array.from(Buffer.from(JSON.stringify(value[key])))
    return value
  }
}
global.Record = Row
class App {
  constructor() { this.tables = {discord_messages: [], discord_entities: [], dc_channel_selection: []} }
  runInTransaction(fn) { fn(this) }
  findCollectionByNameOrId(name) { return name }
  findRecordsByFilter(name, filter, sort, limit, offset, values) {
    return this.tables[name].filter(r => (r.data.message_id || r.data.entity_id) === values.id && (!filter.includes('on = true') || r.data.on))
  }
  save(r) { if (!this.tables[r.collection].includes(r)) this.tables[r.collection].push(r) }
}
const app = new App()
const ctx = {channel_id:C, thread_id:null, guild_id:G}
const message = {id:M, channel_id:C, guild_id:G, author:{id:A,username:'author',bot:false}, content:'original',
  timestamp:'2026-09-06T00:00:00.000Z', attachments:[{id:'attachment'}], embeds:[{title:'embed'}]}
let model = {ok:true,exists:true,channels:{[C]:{import:true}}}
const helper = {getModel:()=>model,IMPORTABLE_TYPES:[0,5,10,11,12]}
live.saveEntity(app, {id:C,type:0,name:'room',guild_id:G}, false)
live.saveEntity(app, {id:T,type:11,name:'thread',parent_id:C,guild_id:G}, false)
function send(event, data) { return live.dispatch(app,event,data,helper,ingest) }
check(send('MESSAGE_CREATE',message).stored,1)
check(app.tables.discord_messages.length,1)
const record=app.tables.discord_messages[0];record.set('routed_to','keep');const created=record.data.created_at
check(send('MESSAGE_CREATE',message).stored,0)
check(app.tables.discord_messages.length,1)
check(send('MESSAGE_UPDATE',{id:M,channel_id:C,content:'',edited_timestamp:'2026-09-06T00:01:00Z'}).stored,1)
check(record.data.content,'')
check(record.data.author_id,A)
check(record.data.attachments_json,[{id:'attachment'}])
check(record.data.created_at,created)
check(record.data.routed_to,'keep')
const stale=ingest.normalizeDispatch(message,ctx,null,'MESSAGE_CREATE','2026-09-06T00:00:00Z')
delete stale.raw._discord_pb_live_at
stale.raw._discord_pb_fetched_at='2026-09-06T00:00:00Z'
check(ingest.upsertMessages(app,[stale]),{inserted:0,updated:1})
check(record.data.content,'')
check(send('MESSAGE_DELETE',{id:M,channel_id:C}).stored,1)
check(record.data.raw._discord_pb_deleted,true)
check(send('MESSAGE_CREATE',message).stored,0)
check(ingest.upsertMessages(app,[stale]),{inserted:0,updated:1})
check(record.data.raw._discord_pb_deleted,true)
check(send('MESSAGE_CREATE',{...message,id:'900000000100000001',channel_id:T}).ignored,1)
check(app.tables.discord_messages.length,1)
model={ok:true,exists:true,channels:{[T]:{import:true}}}
check(send('MESSAGE_CREATE',{...message,id:'900000000100000001',channel_id:T}).stored,1)
check(app.tables.discord_messages[1].data.thread_id,T)
check(app.tables.discord_messages[1].data.channel_id,C)
model={ok:false,exists:true,error:'invalid'}
check(send('MESSAGE_CREATE',message).reason,'invalid_model')
model={ok:true,exists:false}
check(send('MESSAGE_CREATE',message).ignored,1)
const selection=new Row('dc_channel_selection');selection.set('entity_id',C);selection.set('on',true);app.save(selection)
check(send('MESSAGE_DELETE',{id:'900000000100000002',channel_id:C}).stored,1)
check(app.tables.discord_messages[2].data.author_id,'unknown')
check(app.tables.discord_messages[2].data.raw._discord_pb_deleted,true)
check(send('MESSAGE_UPDATE',{id:'900000000100000003',channel_id:C,content:'partial'}).stored,1)
check(app.tables.discord_messages[3].data.raw._discord_pb_partial,true)
check(send('MESSAGE_CREATE',{...message,id:'900000000100000003'}).stored,1)
check(app.tables.discord_messages[3].data.author_id,A)
check(app.tables.discord_messages[3].data.raw._discord_pb_partial,undefined)
check(send('THREAD_UPDATE',{id:T,type:11,thread_metadata:{archived:true}}).stored,1)
check(app.tables.discord_entities[1].data.parent_id,C)
check(app.tables.discord_entities[1].data.name,'thread')
check(send('MESSAGE_DELETE_BULK',{channel_id:C,ids:[M,'900000000100000003']}).stored,1)
check(live.status({updated_at:100,connected:true,event_times:[39,50,99],last_event_at:99},100).events_per_minute,2)
check(live.status({updated_at:10,connected:true},100).connected,false)
console.log(`Live ingest: ${assertions} assertions PASS`)
