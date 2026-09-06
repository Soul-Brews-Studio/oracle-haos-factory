import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintIngressToken } from "./ingress";
const BunSocket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket };
const root = mkdtempSync(join(tmpdir(), "p2p-ingress-test-"));
const auth = crypto.randomUUID();
const port = 30_000 + Math.floor(Math.random()*10_000);
const base = `http://127.0.0.1:${port}`;
const identity = {user_id:"allowed",user_name:"Allowed",path:"/api/hassio_ingress/proof"};
const headers = {"x-ingress-path":identity.path,"x-remote-user-id":identity.user_id};
let child: ReturnType<typeof Bun.spawn>;
beforeAll(async () => {
  child = Bun.spawn(["bun", "server.ts"],{cwd:import.meta.dir, stdout:"ignore",stderr:"ignore",env:{...process.env,
    HOST:"127.0.0.1",PORT:String(port),AUTH_KEY:auth,UPLOAD_DIR:join(root,"uploads"),LOG_DIR:join(root,"logs"),
    INGRESS_TRUSTED_PEER:"127.0.0.1",AUTO_LOGIN:"true",AUTO_LOGIN_HA_ADMINS:"false",AUTO_LOGIN_HA_USER_IDS:"allowed", SUPERVISOR_TOKEN:"",
  }});
  for(let i=0;i<100;i++){ try {if((await fetch(base+"/health")).ok)return;} catch {} await Bun.sleep(20); }
  throw new Error("readiness failed");
});
afterAll(async()=>{ child?.kill(); if(child)await child.exited; rmSync(root,{recursive:true,force:true}); });
test("direct bootstrap denied, allowed ingress gets no-store scoped session; no master in response",async()=>{
  const direct = await fetch(base+"/auth/ingress",{method:"POST"}); expect(direct.status).toBe(403);
  expect((await direct.json()).ingress).toBeFalse();
  const response = await fetch(base+"/auth/ingress",{method:"POST",headers}); expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text(); expect(body).not.toContain(auth);
  const session = JSON.parse(body); expect(session.ingress).toBeTrue();
  const h={...headers,authorization:`Bearer ${session.token}`};
  const config = await fetch(base+"/api/config",{headers:h}); expect(config.status).toBe(200);
  expect((await fetch(base+"/api/files",{headers:h})).status).toBe(200);
  expect((await fetch(base+"/api/logs",{headers:h})).status).toBe(403);
  expect((await fetch(base+"/api/files",{headers:{authorization:h.authorization}})).status).toBe(401);
  expect((await fetch(base+"/api/files",{headers:{...h,"x-remote-user-id":"other"}})).status).toBe(401);
  expect((await fetch(base+"/api/files",{headers:{...h,"x-ingress-path":identity.path+"2"}})).status).toBe(401);
  expect((await fetch(base+"/api/files?key="+session.token,{headers})).status).toBe(401);
  const expired=mintIngressToken(auth,identity,"api",Date.now()-300_000);
  expect((await fetch(base+"/api/files",{headers:{...headers,authorization:`Bearer ${expired}`}})).status).toBe(401);
  const form=new FormData();form.append("file",new File(["ingress fixture"],"fixture.txt"));
  const upload=await fetch(base+"/api/upload",{method:"POST",headers:h,body:form});expect(upload.status).toBe(200);
  const file=await upload.json();expect(await(await fetch(base+"/api/files/"+file.name,{headers:h})).text()).toBe("ingress fixture");
  const signal=(await config.json()).signal_token;
  await new Promise<void>((resolve,reject)=>{ const ws=new BunSocket(`ws://127.0.0.1:${port}/ws?token=${signal}`,{headers});
    ws.onopen=()=>{ws.close();resolve();};ws.onerror=()=>reject(new Error("bound WS rejected")); });
  expect((await fetch(base+"/ws?token="+signal)).status).toBe(401);
  expect((await fetch(base+"/api/files",{headers:{...headers,authorization:`Bearer ${signal}`}})).status).toBe(401);
});
test("denied ingress gets safe identity and allowlist hint; forged admin header grants nothing",async()=>{
  const res=await fetch(base+"/auth/ingress",{method:"POST",headers:{...headers,"x-remote-user-id":"denied","x-remote-user-is-admin":"true"}});
  expect(res.status).toBe(403);const denied=await res.json();expect(denied.user_id).toBe("denied");expect(denied.allowlistOption).toBe("auto_login_ha_user_ids");expect(denied.token).toBeUndefined();
  expect((await fetch(base+"/api/files",{headers:{authorization:`Bearer ${auth}`}})).status).toBe(200);
});
