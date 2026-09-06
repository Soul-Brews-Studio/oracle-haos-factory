#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT_JSON=$(python3 -c 'import json,os; print(json.dumps(os.getcwd()))')
{
printf 'const ROOT = %s;\n' "$ROOT_JSON"
cat <<'JS'
const fs = await import('node:fs');
process.chdir(ROOT);
const run = JSON.parse(fs.readFileSync('proof-local/browser-run.json','utf8'));
if (!/^http:\/\/127\.0\.0\.1:\d+\/api\/hassio_ingress\/discord-proof\/$/.test(run.url)) throw new Error('Not a local proof URL');
await useOrCreateTaskSpace('discord-pb local proof');
await openOrReuseTab(run.url + 'panel.html', {wait:true,timeout:20});
await waitForElement('#messages .message-row', {timeout:20});
await js(`(()=>{window.__timelineProof={done:false};(async()=>{
  activeDay=null;page=1;
  const auth=JSON.parse(localStorage.getItem('__dc_superuser_auth__'));
  const headers={Authorization:auth.token,'Content-Type':'application/json'};
  const seed=String(Date.now());
  const snow=(prefix,n)=>prefix+(BigInt(seed)*100n+BigInt(n)).toString().slice(-15);
  const guildId=snow('710',1), channelId=snow('720',1), olderChannelId=snow('720',2), threadId=snow('720',3);
  const authorId=snow('730',1), messageIds=[];
  const entities=[
    {entity_id:guildId,kind:'guild',name:'Timeline proof guild '+seed,parent_id:'',guild_id:guildId,discord_type:0,archived:false,raw:{proof:true},seen_at:new Date().toISOString()},
    {entity_id:channelId,kind:'channel',name:'Timeline active '+seed,parent_id:guildId,guild_id:guildId,discord_type:0,archived:false,raw:{proof:true},seen_at:new Date().toISOString()},
    {entity_id:olderChannelId,kind:'channel',name:'Timeline older '+seed,parent_id:guildId,guild_id:guildId,discord_type:0,archived:false,raw:{proof:true},seen_at:new Date().toISOString()},
    {entity_id:threadId,kind:'thread',name:'Timeline child '+seed,parent_id:channelId,guild_id:guildId,discord_type:11,archived:false,raw:{proof:true},seen_at:new Date().toISOString()}
  ];
  const collection='./api/collections/discord_entities/records';
  const cleanup=async()=>{
    const q=new URLSearchParams({perPage:'100',filter:'author_id='+JSON.stringify(authorId)});
    while(true){
      const messages=await(await fetch('./api/collections/discord_messages/records?'+q,{headers})).json();
      if(!(messages.items||[]).length)break;
      for(const row of messages.items)await fetch('./api/collections/discord_messages/records/'+encodeURIComponent(row.id),{method:'DELETE',headers});
    }
    for(const entity of entities){
      const eQ=new URLSearchParams({perPage:'2',filter:'entity_id='+JSON.stringify(entity.entity_id)});
      const rows=await(await fetch(collection+'?'+eQ,{headers})).json();
      for(const row of rows.items||[])await fetch(collection+'/'+encodeURIComponent(row.id),{method:'DELETE',headers});
    }
  };
  try{
    for(const entity of entities){const response=await fetch(collection,{method:'POST',headers,body:JSON.stringify(entity)});if(!response.ok)throw new Error('entity create '+response.status+' '+await response.text());}
    const rows=[];
    const add=(channel,ts,content)=>{const message_id=snow('790',messageIds.length+1);messageIds.push(message_id);rows.push({message_id,channel_id:channel,guild_id:guildId,author_id:authorId,author_name:'timeline-proof',author_is_bot:true,content,attachments_json:[],embeds:[],ts,raw:{proof:true}})};
    add(channelId,'2026-08-30T01:00:00.000Z','old date target');
    add(channelId,'2026-08-31T01:00:00.000Z','middle date');
    for(let i=0;i<105;i++)add(channelId,'2026-09-02T'+String(i%16).padStart(2,'0')+':'+String(i%60).padStart(2,'0')+':00.000Z','new page '+i);
    add(olderChannelId,'2026-08-29T01:00:00.000Z','older channel');
    const childId=snow('790',messageIds.length+1);messageIds.push(childId);rows.push({message_id:childId,channel_id:channelId,thread_id:threadId,guild_id:guildId,author_id:authorId,author_name:'timeline-proof',author_is_bot:true,content:'child thread excluded',attachments_json:[],embeds:[],ts:'2026-09-02T02:00:00.000Z',raw:{proof:true}});
    for(let offset=0;offset<rows.length;offset+=100){
      const imported=await fetch('./api/discord/import',{method:'POST',headers,body:JSON.stringify({messages:rows.slice(offset,offset+100)})});
      if(!imported.ok)throw new Error('fixture import '+imported.status+' '+await imported.text());
    }
    await loadChannels();
    const selector=document.getElementById('timeline-target');
    selector.value='channel:'+channelId;selector.dispatchEvent(new Event('change'));
    const waitFor=async(predicate,label)=>{const until=Date.now()+8000;while(Date.now()<until){if(predicate())return;await new Promise(r=>setTimeout(r,50));}throw new Error('timeout '+label)};
    await waitFor(()=>document.querySelectorAll('.timeline-bar').length===3,'channel day timeline');
    const channelBars=[...document.querySelectorAll('.timeline-bar')].map(row=>({date:row.dataset.date,title:row.title}));
    if(!channelBars.some(row=>row.date==='2026-09-02'&&row.title.includes('105 messages')))throw new Error('channel timeline included child thread');
    if(!channelBars.some(row=>row.date==='2026-09-01')){
      // Sparse bins intentionally omit the empty date; it must be represented in the gap summary.
      if(!document.getElementById('timeline-gaps').textContent.includes('2026-09-01'))throw new Error('gap not rendered');
    }
    const guildOption=[...selector.options].find(option=>option.value==='guild:'+guildId);
    if(!guildOption)throw new Error('guild target missing');
    selector.value=guildOption.value;selector.dispatchEvent(new Event('change'));
    await waitFor(()=>document.querySelectorAll('.timeline-bar').length>=3,'guild timeline');
    const guildTimeline=true;
    selector.value='channel:'+channelId;selector.dispatchEvent(new Event('change'));
    await waitFor(()=>document.querySelectorAll('.timeline-bar').length===3,'restore channel timeline');
    document.getElementById('channel-filter').value=channelId;
    document.getElementById('message-filter').requestSubmit();
    await waitFor(()=>document.querySelectorAll('#messages .message-row').length===20,'first page');
    if([...document.querySelectorAll('.message-content')].some(row=>row.textContent==='old date target'))throw new Error('old row unexpectedly on first page');
    document.querySelector('.timeline-bar[data-date="2026-09-02"]').click();
    await waitFor(()=>document.getElementById('page-label').textContent.includes('Page 1 of 6'),'day pagination');
    if(!document.getElementById('message-status').textContent.startsWith('105 messages'))throw new Error('channel day total included child thread');
    if([...document.querySelectorAll('.message-content')].some(row=>row.textContent==='child thread excluded'))throw new Error('channel day feed included child thread');
    document.getElementById('next').click();
    await waitFor(()=>document.getElementById('page-label').textContent.includes('Page 2 of 6'),'day next page');
    document.querySelector('.timeline-bar[data-date="2026-08-30"]').click();
    await waitFor(()=>[...document.querySelectorAll('.message-content')].some(row=>row.textContent==='old date target'),'bar jump');
    const message=document.querySelector('#messages .message-row');
    const timestamp=message.querySelector('time'), absolute=message.querySelector('.absolute-time'), relative=message.querySelector('.relative-time');
    if(!timestamp.title.endsWith('Z')||!absolute.textContent.includes('+07')||!relative.textContent)throw new Error('timestamp presentation incomplete');
    if(document.querySelector('.day-separator')?.textContent!=='Sun 30 Aug 2026')throw new Error('Bangkok day separator incorrect');
    const outside={message_id:snow('790',messageIds.length+1),channel_id:channelId,guild_id:guildId,author_id:authorId,author_name:'timeline-proof',author_is_bot:true,content:'outside active day',attachments_json:[],embeds:[],ts:new Date().toISOString(),raw:{proof:true}};
    messageIds.push(outside.message_id);
    const outsideImport=await fetch('./api/discord/import',{method:'POST',headers,body:JSON.stringify({messages:[outside]})});
    if(!outsideImport.ok)throw new Error('outside-day SSE import '+outsideImport.status);
    await new Promise(resolve=>setTimeout(resolve,500));
    if(![...document.querySelectorAll('.message-content')].some(row=>row.textContent==='old date target')||[...document.querySelectorAll('.message-content')].some(row=>row.textContent==='outside active day'))throw new Error('out-of-day SSE replaced historical feed');
    startRealtime();
    await waitFor(()=>document.getElementById('live-status').textContent.includes('connected'),'PB SSE reconnect');
    await new Promise(resolve=>setTimeout(resolve,300));
    if(![...document.querySelectorAll('.message-content')].some(row=>row.textContent==='old date target'))throw new Error('historical date lost on reconnect');
    const tickingRelative=document.querySelector('#messages .relative-time');
    const relativeBefore=tickingRelative.textContent; tickingRelative.dataset.ts=new Date(Date.now()-4*60000).toISOString();
    await new Promise(resolve=>setTimeout(resolve,31000));
    if(tickingRelative.textContent===relativeBefore||!tickingRelative.textContent.includes('min ago'))throw new Error('relative timestamp did not tick');
    document.getElementById('model-tab').click();
    document.getElementById('channel-sort').value='activity';document.getElementById('channel-sort').dispatchEvent(new Event('change'));
    await waitFor(()=>!document.getElementById('channels-status').textContent.includes('Loading')&&[...document.querySelectorAll('.channel-choice')].some(row=>row.textContent.includes(channelId)),'model reload');
    const proofRows=[...document.querySelectorAll('.channel-choice')].filter(row=>row.textContent.includes(channelId)||row.textContent.includes(olderChannelId));
    if(proofRows.length!==2||!proofRows[0].textContent.includes(channelId))throw new Error('last activity sort failed');
    if(!proofRows[0].querySelector('.channel-dates')?.textContent.includes('imported at'))throw new Error('model timestamp metadata missing');
    const live=await(await fetch('./api/dc/status',{headers})).json();
    const gatewayText=document.getElementById('gateway-status').textContent;
    if(live.live_status?.connected&&(!live.live_status.connected_since||!gatewayText.includes('live since')))throw new Error('connected since missing');
    return {channelBars,guildTimeline,gapRendered:true,jumpOlderPage:true,dayPagination:true,historicalSSE:true,reconnectKeepsDate:true,utcHover:true,bangkokAbsolute:true,relativeTick:true,modelMetadata:true,activitySort:true,gatewayConnected:!!live.live_status?.connected};
  }finally{
    await cleanup();activeDay=null;page=1;document.getElementById('channel-filter').value='';document.getElementById('jump-date-input').value='';
    await loadChannels();
    const visible=discoveredChannels.find(row=>Number(row.imported_count)>0)||discoveredChannels[0];
    if(visible){document.getElementById('timeline-target').value='channel:'+visible.id;timelineTarget={kind:'channel',id:visible.id,name:visible.name||visible.id};}
    await loadMessages();showTab('archive');await loadTimeline();
  }
})().then(result=>{window.__timelineProof={done:true,result}}).catch(error=>{window.__timelineProof={done:true,error:String(error?.stack||error)}});return true})()`);
let proofState;
for(let attempt=0;attempt<90;attempt++){
  proofState=await js(`window.__timelineProof`);
  if(proofState?.done)break;
  await new Promise(resolve=>setTimeout(resolve,1000));
}
if(!proofState?.done)throw new Error('Timeline browser proof timed out after 90s');
if(proofState.error)throw new Error(proofState.error);
const result=proofState.result;
result.layout=[];
for(const width of [1280,390]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
  for(const view of ['archive','model']){
    await js(`(async()=>{showTab('${view}');if('${view}'==='model'){document.getElementById('channel-sort').value='activity';await loadChannels();}const node=document.querySelector('${view==='archive'?'.time-tools':'#model-view'}');window.scrollTo(0,Math.max(0,node.getBoundingClientRect().top+window.scrollY-20));})()`);
    await wait(.3);
    const check=await js(`({width:${width},view:'${view}',documentWidth:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>${width}})`);
    result.layout.push(check);if(check.overflow)throw new Error('Layout exceeds requested viewport: '+JSON.stringify(check));
    const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync('evidence/timeline-'+view+'-'+width+'.png',Buffer.from(shot.data,'base64'));
  }
}
await cdp('Emulation.clearDeviceMetricsOverride');
fs.writeFileSync('evidence/timeline-check.json',JSON.stringify(result,null,2)+'\n');
cliLog(result);cliLog('TIMELINE PANEL PROOF PASS');
JS
} | ego-browser nodejs
