// Disposable localhost proof only: fake HA Core directory + fake ingress identity.
// Run: bun tests/autologin-harness.ts (Ctrl-C cleans up). Never use in deployment.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "p2p-autologin-proof-"));
const key = crypto.randomUUID() + crypto.randomUUID();
const coreKey = crypto.randomUUID();
const children: ReturnType<typeof Bun.spawn>[] = [];
mkdirSync(join(root,"uploads"));mkdirSync(join(root,"logs"));
writeFileSync(join(root,"uploads","browser-fixture.txt"),"browser auto-login fixture\n");
const core = Bun.serve({hostname:"127.0.0.1",port:0,
  fetch(req,s){ if(s.upgrade(req))return;return new Response(null,{status:400}); },
  websocket:{open(ws){ws.send(JSON.stringify({type:"auth_required"}));},message(ws,data){
    const m=JSON.parse(String(data));
    if(m.type==="auth") ws.send(JSON.stringify({type:m.access_token===coreKey?"auth_ok":"auth_invalid"}));
    else if(m.type==="config/auth/list") ws.send(JSON.stringify({type:"result",id:m.id,success:true,result:[
      {id:"fixture-admin",is_active:true,group_ids:["system-admin"]},
      {id:"fixture-denied",is_active:true,group_ids:["system-users"]},
    ]}));
  }},
});
const reserved=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return new Response(null);}});
const port=reserved.port;reserved.stop(true);
const env={...process.env,HOST:"127.0.0.1",PORT:String(port),AUTH_KEY:key,UPLOAD_DIR:join(root,"uploads"),SAVE_DIR:join(root,"uploads"),LOG_DIR:join(root,"logs"),
  STUN_SERVERS:"[]",TURN_URLS:"",TURN_USER:"",TURN_CRED:"",AUTO_LOGIN:"true",AUTO_LOGIN_HA_ADMINS:"true",AUTO_LOGIN_HA_USER_IDS:"fixture-allowed",
  INGRESS_TRUSTED_PEER:"127.0.0.1",HA_CORE_WS_URL:`ws://127.0.0.1:${core.port}`,SUPERVISOR_TOKEN:coreKey};
function spawn(script:string, more:Record<string,string>={}){const c=Bun.spawn(["bun",script],{cwd:join(import.meta.dir,".."),env:{...env,...more},stdout:"pipe",stderr:"pipe"});children.push(c);return c;}
spawn("dropbox/server.ts");
for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{}await Bun.sleep(30);}
spawn("dropbox/receiver.ts",{SIGNAL_URL:`ws://127.0.0.1:${port}/ws`,PEER_NAME:"p2p-dropbox"});
const urls: Record<string,string>={direct:`http://127.0.0.1:${port}/`};
for(const who of ["admin","denied","allowed"]){
  const c=spawn("tests/ingress-proxy.ts",{UPSTREAM:`http://127.0.0.1:${port}`,PROOF_PREFIX:`${who}-proof`,PROOF_USER_ID:`fixture-${who}`});
  const reader=c.stdout.getReader();const line=await reader.read();urls[who]=new TextDecoder().decode(line.value).trim();reader.releaseLock();
}
console.log(JSON.stringify(urls));
// Keep the disposable key local/private solely for optional manual-fallback proof.
writeFileSync(join(root,"fixture-key"),key,{mode:0o600});
console.log(`PRIVATE_PROOF_ROOT=${root}`);
let cleaned=false;
async function cleanup(){if(cleaned)return;cleaned=true;for(const child of children)child.kill();await Promise.all(children.map(c=>c.exited));core.stop(true);rmSync(root,{recursive:true,force:true});process.exit(0);}
process.on("SIGINT",()=>void cleanup());process.on("SIGTERM",()=>void cleanup());
await new Promise(()=>{});
