import { expect, test } from "bun:test";
import { adminChecker, readAdminIds } from "./ha-admin";
test("admin cache refreshes after 60s and fails closed instead of retaining stale grants", async () => {
  let now = 1000, calls = 0, fail = false;
  const check = adminChecker(async () => { calls++; if (fail) throw new Error("offline"); return new Set(["admin"]); }, () => now);
  expect(await check("admin")).toBeTrue(); expect(await check("user")).toBeFalse(); expect(calls).toBe(1);
  now += 60_000; fail = true;
  expect(await check("admin")).toBeFalse(); expect(calls).toBe(2);
  now += 5000; fail = false;
  expect(await check("admin")).toBeTrue(); expect(calls).toBe(3);
});
test("Core websocket uses only auth and config/auth/list; active owner/admin membership required", async () => {
  const credential = crypto.randomUUID(); const commands: string[] = [];
  const mock = Bun.serve({ hostname:"127.0.0.1", port:0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, {status:400}); },
    websocket: { open(ws) { ws.send(JSON.stringify({type:"auth_required"})); }, message(ws, data) {
      const m = JSON.parse(String(data)); commands.push(m.type);
      if (m.type === "auth") { expect(m.access_token).toBe(credential); ws.send(JSON.stringify({type:"auth_ok"})); }
      else ws.send(JSON.stringify({type:"result", id:1, success:true, result:[
        {id:"admin",is_active:true,group_ids:["system-admin"]}, {id:"owner",is_active:true,is_owner:true},
        {id:"inactive",is_active:false,group_ids:["system-admin"]}, {id:"user",is_active:true,group_ids:["system-users"]},
      ]}));
    } },
  });
  try { expect(await readAdminIds(`ws://127.0.0.1:${mock.port}`, credential)).toEqual(new Set(["admin","owner"]));
    expect(commands).toEqual(["auth","config/auth/list"]);
  } finally { mock.stop(true); }
});
test("missing Core credentials and unresponsive lookup reject", async () => {
  await expect(readAdminIds("ws://127.0.0.1:1", "")).rejects.toThrow("credentials");
  const mock = Bun.serve({hostname:"127.0.0.1",port:0,fetch(req,s) { if(s.upgrade(req)) return; return new Response(null); },websocket:{message(){}}});
  try { await expect(readAdminIds(`ws://127.0.0.1:${mock.port}`,crypto.randomUUID(),30)).rejects.toThrow("unavailable"); }
  finally { mock.stop(true); }
});
