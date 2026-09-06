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
await waitForElement('#messages li', {timeout:20});
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
  const file=new File([JSON.stringify({messages:[row]})],'repeat-fixture.json',{type:'application/json'});
  const transfer=new DataTransfer(); transfer.items.add(file);
  document.getElementById('import-file').files=transfer.files;
  document.getElementById('import-file').dispatchEvent(new Event('change'));
  document.getElementById('entity-name').value='proof';
  document.getElementById('entity-find').requestSubmit();
  return {staysOnDashboard:location.pathname.endsWith('/panel.html'),
    visibleMessages:document.querySelectorAll('#messages li').length,
    guestImportDenied:[401,403].includes(guest.status),jobStatus:job.status,
    jobConfigured:state.configured,jobState:state.state,queueStatus:queued.status,
    invalidBatchStatus:invalid.status,
    petkeeperAuthUnchanged:localStorage.getItem('__pb_superuser_auth__')==='petkeeper-auth-sentinel'};
})()`);
if(!checks.staysOnDashboard||checks.visibleMessages!==20||!checks.guestImportDenied||checks.jobStatus!==200||
 !checks.jobConfigured||checks.queueStatus!==202||checks.invalidBatchStatus!==400||!checks.petkeeperAuthUnchanged)
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
