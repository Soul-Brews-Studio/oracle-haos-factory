// Run inside ONLY addon_local_p2p_dropbox after an authorized deployment.
// Uses its existing Supervisor token to check the real HA Core/admin/ingress path.
// No options/file mutations, no raw tokens, IDs or ingress paths are printed.
import { readAdminIds } from "../dropbox/ha-admin";
const key = process.env.SUPERVISOR_TOKEN || "";
const path = process.env.P2P_PROOF_INGRESS_PATH || "";
if (!key || !/^\/api\/hassio_ingress\/[A-Za-z0-9_-]+$/.test(path)) throw new Error("proof needs existing Supervisor token and ingress path");
const endpoint = "ws://supervisor/core/websocket";
const adminIds = await readAdminIds(endpoint, key);
const ws = new WebSocket(endpoint);
let seq = 0;
const waiting = new Map<number, {resolve:(v:any)=>void;reject:(e:Error)=>void}>();
let authResolve:()=>void, authReject:(e:Error)=>void;
const ready = new Promise<void>((resolve,reject)=>{authResolve=resolve;authReject=reject;});
ws.onmessage = event => {
  const m=JSON.parse(String(event.data));
  if(m.type==="auth_required")ws.send(JSON.stringify({type:"auth",access_token:key}));
  else if(m.type==="auth_ok")authResolve();
  else if(m.type==="auth_invalid")authReject(new Error("Core auth failed"));
  else if(m.type==="result") {const p=waiting.get(m.id);waiting.delete(m.id);if(m.success)p?.resolve(m.result);else p?.reject(new Error("Core proof command failed"));}
};
ws.onerror=()=>authReject(new Error("Core connection failed"));
const timeout=setTimeout(()=>{console.error("FAIL live ingress proof timeout");process.exit(1);},15000);
function call(payload:Record<string,unknown>):Promise<any>{return new Promise((resolve,reject)=>{const id=++seq;waiting.set(id,{resolve,reject});ws.send(JSON.stringify({id,...payload}));});}
try {
  await ready;
  const user=await call({type:"auth/current_user"});
  if(!adminIds.has(user.id))throw new Error("Core caller is not a verified active admin");
  console.log("HA_ADMIN verified via real Core user directory (ID not printed)");
  const session=await call({type:"hassio/api",endpoint:"/ingress/session",method:"post"});
  if(typeof session.session!=="string")throw new Error("no ingress session");
  const base=`http://supervisor/ingress/${path.split("/").pop()}`;
  const headers={cookie:`ingress_session=${session.session}`,"x-ingress-path":path};
  const boot=await fetch(base+"/auth/ingress",{method:"POST",headers});
  const data=await boot.json();
  if(boot.status!==200||!data.ok||!data.ingress||data.user_id!==user.id||typeof data.token!=="string")throw new Error(`ingress bootstrap failed HTTP ${boot.status}`);
  const options=await Bun.file("/data/options.json").json();
  if(JSON.stringify(data).includes(options.auth_key)||JSON.stringify(data).includes(key))throw new Error("credential disclosure");
  console.log("INGRESS bootstrap=200 auto_login=true scoped_session=true raw_key_exposed=false");
  const h={...headers,authorization:`Bearer ${data.token}`};
  const files=await fetch(base+"/api/files",{headers:h});if(files.status!==200)throw new Error("ingress API failed");
  console.log(`INGRESS api/files=200 listed_files=${(await files.json()).total}`);
  const config=await fetch(base+"/api/config",{headers:h});if(config.status!==200)throw new Error("config failed");
  const signal=(await config.json()).signal_token;
  const BunSocket=WebSocket as unknown as {new(url:string,options:Bun.WebSocketOptions):WebSocket};
  await new Promise<void>((resolve,reject)=>{const socket=new BunSocket(base.replace("http:","ws:")+"/ws?token="+encodeURIComponent(signal),{headers});
    socket.onmessage=event=>{const m=JSON.parse(String(event.data));if(m.type==="welcome"){socket.close();resolve();}};
    socket.onerror=()=>reject(new Error("ingress signaling failed"));
  });
  console.log("INGRESS websocket=connected");
  const forged=await fetch("http://127.0.0.1:3847/auth/ingress",{method:"POST",headers:{"x-ingress-path":path,"x-remote-user-id":user.id,"x-forwarded-for":"172.30.32.2"}});
  if(forged.status!==403)throw new Error("direct header spoof accepted");
  const replay=await fetch("http://127.0.0.1:3847/api/files",{headers:{authorization:`Bearer ${data.token}`}});
  if(replay.status!==401)throw new Error("direct session replay accepted");
  console.log("DIRECT forged_ingress=403 scoped_session_replay=401");
  console.log("PASS real Supervisor ingress/Core proof; no options or shared-file writes");
} finally {clearTimeout(timeout);ws.close();}
