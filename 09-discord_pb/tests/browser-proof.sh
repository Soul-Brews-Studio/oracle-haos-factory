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
await openOrReuseTab(run.url + '_/', {wait:true,timeout:20});
await js(`(()=>{localStorage.setItem('__pb_superuser_auth__','petkeeper-auth-sentinel');localStorage.setItem('pb_superuser_file_token','petkeeper-file-sentinel');return true;})()`);
await gotoAndWait(run.url, {timeout:20});
const checks = await js(`(async()=>{
  const auth=JSON.parse(localStorage.getItem('__dc_superuser_auth__'));
  const refresh=await fetch('../api/collections/_superusers/auth-refresh',{method:'POST',headers:{Authorization:auth.token}});
  if(!refresh.ok)throw new Error('auth-refresh '+refresh.status);
  const session=await refresh.json();
  const rows=await fetch('../api/collections/discord_messages/records?perPage=1',{headers:{Authorization:session.token}});
  const data=await rows.json();
  return {refreshStatus:refresh.status,protectedRecordsStatus:rows.status,records:data.totalItems,
    petkeeperAuthUnchanged:localStorage.getItem('__pb_superuser_auth__')==='petkeeper-auth-sentinel',
    petkeeperFileUnchanged:localStorage.getItem('pb_superuser_file_token')==='petkeeper-file-sentinel',
    discordKeyPresent:!!auth.token,ingressPrefixPreserved:location.pathname.startsWith('/api/hassio_ingress/discord-proof/')};
})()`);
if(checks.refreshStatus!==200||checks.protectedRecordsStatus!==200||checks.records!==214||
   !checks.petkeeperAuthUnchanged||!checks.petkeeperFileUnchanged||!checks.discordKeyPresent||!checks.ingressPrefixPreserved) throw new Error('Browser proof failed');
const href = await js(`(()=>[...document.querySelectorAll('a')].find(a=>a.textContent.includes('discord_messages')).href)()`);
await gotoAndWait(href,{timeout:20});
fs.mkdirSync('evidence',{recursive:true});
const screenshot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
fs.writeFileSync('evidence/admin-ingress.png',Buffer.from(screenshot.data,'base64'));
fs.writeFileSync('evidence/browser-check.json',JSON.stringify(checks,null,2)+'\n');
cliLog(checks);
cliLog('Screenshot: '+path.resolve('evidence/admin-ingress.png'));
JS
} | ego-browser nodejs
