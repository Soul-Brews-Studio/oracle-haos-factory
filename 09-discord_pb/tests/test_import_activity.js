const assert = require('node:assert/strict')
const {markImports} = require('../pb_hooks/lib/import_activity.js')
const ingest = require('../pb_hooks/lib/discord_ingest.js')
const rows=[]
global.Record=class{constructor(){this.data={}} set(k,v){this.data[k]=v}}
const app={findCollectionByNameOrId:()=>null,
  findRecordsByFilter:(_,__,___,____,_____,args)=>rows.filter(r=>r.data.key===args.key),
  save:r=>{if(!rows.includes(r))rows.push(r)}}
const before=Date.now()
markImports(app, {'900000000000000000':true,'900000000000000001':true})
assert.equal(rows.length,2)
assert(Date.parse(rows[0].data.value.at)>=before)
markImports(app, {'900000000000000000':true})
assert.equal(rows.length,2)
assert.equal(rows[0].data.key,'import:900000000000000000')
markImports(app,{})
assert.equal(rows.length,2)
let touched=null
const emptyApp={runInTransaction:fn=>fn({findCollectionByNameOrId:()=>null})}
ingest.upsertMessages(emptyApp,[],(_,targets)=>{touched=targets})
assert.deepEqual(touched,{})
console.log('Import activity: 6 assertions PASS')
