#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Requires ego-browser. Uses only the loopback run emitted by local-proof.sh --keep.
ROOT_JSON=$(python3 -c 'import json,os; print(json.dumps(os.getcwd()))')
{
printf 'const ROOT = %s;\n' "$ROOT_JSON"
cat <<'JS'
const fs = await import('node:fs'), path = await import('node:path');
process.chdir(ROOT);
const run = JSON.parse(fs.readFileSync('proof-local/browser-run.json','utf8'));
if (!/^http:\/\/127\.0\.0\.1:\d+\/api\/hassio_ingress\/discord-proof\/$/.test(run.url)) throw new Error('Not a local proof URL');
await useOrCreateTaskSpace('discord-pb local proof');

await openOrReuseTab(run.url + 'panel.html', {wait:true,timeout:20});
await waitForElement('#messages .message-row', {timeout:20});
const checks = await js(`(async()=>{
  const token=JSON.parse(localStorage.getItem('__dc_superuser_auth__')).token;
  const headers={Authorization:token,'Content-Type':'application/json'};
  const base='./api/discord/';
  const guest=await fetch(base+'import',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"messages":[]}'});
  const job=await fetch(base+'backfill',{headers}); const state=await job.json();
  const queued=await fetch(base+'backfill',{method:'POST',headers});
  const records=await fetch('./api/collections/discord_messages/records?perPage=1',{headers});
  const record=(await records.json()).items[0];
  const row=Object.fromEntries(['message_id','channel_id','author_id','ts','content'].map(k=>[k,record[k]]));
  const invalid=await fetch(base+'import',{method:'POST',headers,body:JSON.stringify({messages:[row,{...row,message_id:123}]})});
  const channelResponse=await fetch('./api/dc/channels',{headers});
  const channelData=await channelResponse.json();
  const channels=Array.isArray(channelData)?channelData:channelData.channels;
  if(!channelResponse.ok||!channels.length)throw new Error('Channel list unavailable');
  const file=new File([JSON.stringify({messages:[row]})],'repeat-fixture.json',{type:'application/json'});
  const transfer=new DataTransfer(); transfer.items.add(file);
  document.getElementById('import-file').files=transfer.files;
  document.getElementById('import-file').dispatchEvent(new Event('change'));
  document.getElementById('entity-name').value='proof';
  document.getElementById('entity-find').requestSubmit();
  return {staysOnDashboard:location.pathname.endsWith('/panel.html'),
    visibleMessages:document.querySelectorAll('#messages .message-row').length,
    guestImportDenied:[401,403].includes(guest.status),jobStatus:job.status,
    jobConfigured:state.configured,jobState:state.state,queueStatus:queued.status,
    invalidBatchStatus:invalid.status,
    channelListStatus:channelResponse.status,channelCount:channels.length,
    petkeeperAuthUnchanged:localStorage.getItem('__pb_superuser_auth__')==='petkeeper-auth-sentinel'};
})()`);
if(!checks.staysOnDashboard||checks.visibleMessages!==20||!checks.guestImportDenied||checks.jobStatus!==200||
 !checks.jobConfigured||checks.queueStatus!==202||checks.invalidBatchStatus!==400||!checks.petkeeperAuthUnchanged||
 checks.channelListStatus!==200||checks.channelCount<1)
 throw new Error(JSON.stringify(checks));
await waitForElement('#entity-result .entity-row', {timeout:10});
await js(`document.getElementById('import-button').click()`);
for(let i=0;i<40;i++){
 const done=await js(`document.getElementById('import-result').textContent`);
 if(done.includes('Import complete: 0 inserted, 1 updated.'))break;
 if(i===39)throw new Error('Import UI failed: '+done);
 await new Promise(resolve=>setTimeout(resolve,100));
}
checks.uiImport='0 inserted, 1 updated';
checks.nameLookup=await js(`document.querySelectorAll('#entity-result .entity-row').length`);
if(checks.nameLookup<3)throw new Error('Name lookup did not show fixture entities');
checks.channelCheckboxes=await js(`document.querySelectorAll('#channel-list .import-toggle').length`);
if(checks.channelCheckboxes!==checks.channelCount)throw new Error('Panel did not render every channel import control');
await js(`document.getElementById('model-tab').click()`);
checks.modelTabVisible=await js(`!document.getElementById('model-view').hidden&&document.getElementById('archive-view').hidden`);
checks.guildGroups=await js(`document.querySelectorAll('#channel-list .guild-group').length`);
checks.rowSaveControls=await js(`document.querySelectorAll('#channel-list .row-save').length`);
checks.rawYamlLoaded=await js(`document.getElementById('config-yaml').value.length>0`);
const roundTripPurpose="browser-proof-"+Date.now();
const originalYaml=await js(`document.getElementById('config-yaml').value`);
await js(`(()=>{const row=[...document.querySelectorAll('.channel-choice')].find(r=>r.querySelector('.channel-detail').textContent.includes('900000000000000000'));row.querySelector('[aria-label="Purpose"]').value=${JSON.stringify(roundTripPurpose)};row.querySelector('.row-save').click()})()`);
for(let i=0;i<100;i++){
 if(await js(`document.getElementById('config-yaml').value.includes(${JSON.stringify(roundTripPurpose)})`))break;
 if(i===99)throw new Error('UI row save did not round-trip into YAML');
 await new Promise(resolve=>setTimeout(resolve,100));
}
await js(`document.getElementById('config-reload').click()`);
for(let i=0;i<100;i++){
 if(await js(`!document.getElementById('config-reload').disabled`))break;
 if(i===99)throw new Error('UI reload did not finish');
 await new Promise(resolve=>setTimeout(resolve,100));
}
checks.modelRoundTrip=await js(`(async()=>{const token=JSON.parse(localStorage.getItem('__dc_superuser_auth__')).token;const r=await fetch('./api/dc/config',{headers:{Authorization:token}});const m=await r.json();return m.channels['900000000000000000'].purpose===${JSON.stringify(roundTripPurpose)}})()`);
if(!checks.modelRoundTrip)throw new Error('UI save -> YAML -> reload failed');
await js(`(()=>{const e=document.getElementById('config-yaml');e.value='guilds: [\\n';document.getElementById('config-validate').click();})()`);
for(let i=0;i<40;i++){
 const isError=await js(`document.getElementById('config-status').classList.contains('error')`);
 if(isError)break;
 if(i===39)throw new Error('Invalid YAML did not show an inline error');
 await new Promise(resolve=>setTimeout(resolve,100));
}
checks.invalidYamlPreserved=await js(`document.getElementById('config-yaml').value==='guilds: [\\n'`);
await js(`document.getElementById('config-yaml').value=${JSON.stringify(originalYaml)}`);
await js(`document.getElementById('config-save').click()`);
for(let i=0;i<100;i++){
 if(await js(`!document.getElementById('config-save').disabled`))break;
 if(i===99)throw new Error('UI YAML save did not finish');
 await new Promise(resolve=>setTimeout(resolve,100));
}
checks.yamlSaveRoundTrip=await js(`(async()=>{const token=JSON.parse(localStorage.getItem('__dc_superuser_auth__')).token;return (await(await fetch('./api/dc/config.yaml',{headers:{Authorization:token}})).text())===${JSON.stringify(originalYaml)}})()`);
if(!checks.yamlSaveRoundTrip)throw new Error('UI raw YAML save did not persist');
if(!checks.modelTabVisible||checks.guildGroups<1||checks.rowSaveControls!==checks.channelCount||!checks.rawYamlLoaded||!checks.invalidYamlPreserved)
 throw new Error('Declared model UI failed: '+JSON.stringify(checks));
await js(`document.getElementById('archive-tab').click()`);
for(let i=0;i<100;i++){
 if(await js(`document.getElementById('live-status').textContent.includes('connected')`))break;
 if(i===99)throw new Error('Panel realtime subscription did not connect');
 await new Promise(resolve=>setTimeout(resolve,100));
}
const liveChecks=await js(`(async()=>{
  const token=JSON.parse(localStorage.getItem('__dc_superuser_auth__')).token;
  const headers={Authorization:token,'Content-Type':'application/json'};
  const listed=await(await fetch('./api/dc/channels',{headers})).json();
  const channels=Array.isArray(listed)?listed:listed.channels;
  const channel=channels.find(row=>row.kind!=='thread'&&row.importable!==false);
  if(!channel)throw new Error('No importable channel for realtime panel proof');
  const messageId='79000'+Date.now();
  const waitFor=async(predicate,label)=>{
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}
    throw new Error('Timed out waiting for panel realtime '+label);
  };
  const importRow=async(content,raw={})=>{
    const row={message_id:messageId,channel_id:String(channel.id),guild_id:channel.guild_id||null,
      author_id:'800000000000000099',author_name:'panel-realtime-proof',author_is_bot:true,
      content,attachments_json:[],embeds:[],ts:new Date().toISOString(),raw};
    const response=await fetch('./api/discord/import',{method:'POST',headers,body:JSON.stringify({messages:[row]})});
    if(!response.ok)throw new Error('Panel realtime import failed: '+response.status);
  };
  const matching=()=>[...document.querySelectorAll('#messages .message-row')].filter(row=>row.dataset.messageId===messageId);
  let result={liveCreate:false,liveUpdate:false,liveTombstone:false};
  try{
    await importRow('panel live create');
    await waitFor(()=>document.querySelector('#messages .message-row')?.dataset.messageId===messageId&&
      document.querySelector('#messages .message-row .message-content')?.textContent==='panel live create','create');
    result.liveCreate=true;
    await importRow('panel live update');
    await waitFor(()=>matching().length===1&&matching()[0].querySelector('.message-content')?.textContent==='panel live update','update dedupe');
    result.liveUpdate=true;
    await importRow('',{_discord_pb_deleted:true,_discord_pb_deleted_at:new Date().toISOString()});
    await waitFor(()=>matching().length===1&&matching()[0].querySelector('.message-content')?.textContent==='(Deleted message)','tombstone');
    result.liveTombstone=true;
    return result;
  }finally{
    const query=new URLSearchParams({perPage:'2',filter:'message_id='+JSON.stringify(messageId)});
    const records=await(await fetch('./api/collections/discord_messages/records?'+query,{headers})).json();
    for(const record of records.items||[])await fetch('./api/collections/discord_messages/records/'+encodeURIComponent(record.id),{method:'DELETE',headers});
    await loadMessages();
  }
})()`);
Object.assign(checks,liveChecks);
if(!checks.liveCreate||!checks.liveUpdate||!checks.liveTombstone)throw new Error('Panel realtime proof failed: '+JSON.stringify(checks));
await js(`document.getElementById('model-tab').click()`);
await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
for(const [name,width] of [['desktop',1280],['mobile',390]]){
 await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
 const overflow=await js(`document.documentElement.scrollWidth>window.innerWidth`);
 if(overflow)throw new Error(name+' horizontal overflow');
 const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
 fs.writeFileSync('evidence/panel-'+name+'.png',Buffer.from(shot.data,'base64'));
}
await cdp('Emulation.clearDeviceMetricsOverride');
fs.writeFileSync('evidence/panel-check.json',JSON.stringify(checks,null,2)+'\n');
cliLog(checks);
cliLog('PANEL PROOF PASS');
JS
} | ego-browser nodejs
