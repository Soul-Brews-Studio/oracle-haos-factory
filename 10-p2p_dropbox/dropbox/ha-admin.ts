// Read-only HA Core admin lookup; no user management commands are sent.
// Requires homeassistant_api:true. The Supervisor token never reaches the browser.
export function readAdminIds(endpoint: string, token: string, timeoutMs = 3000): Promise<Set<string>> {
  if (!token) return Promise.reject(new Error("HA Core credentials unavailable"));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint);
    let done = false;
    const finish = (ids?: Set<string>) => {
      if (done) return;
      done = true; clearTimeout(timer); ws.close();
      if (ids) resolve(ids); else reject(new Error("HA admin lookup unavailable"));
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    ws.onerror = () => finish();
    ws.onclose = () => finish();
    ws.onmessage = event => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.type === "auth_required") ws.send(JSON.stringify({type: "auth", access_token: token}));
        else if (msg.type === "auth_ok") ws.send(JSON.stringify({id: 1, type: "config/auth/list"}));
        else if (msg.type === "auth_invalid") finish();
        else if (msg.type === "result" && msg.id === 1) {
          if (!msg.success || !Array.isArray(msg.result)) return finish();
          finish(new Set(msg.result.filter((u: any) => typeof u.id === "string" && u.is_active === true &&
            (u.is_owner === true || (Array.isArray(u.group_ids) && u.group_ids.includes("system-admin"))))
            .map((u: any) => u.id)));
        }
      } catch { finish(); }
    };
  });
}

export function adminChecker(load: () => Promise<Set<string>>, now = Date.now) {
  let ids = new Set<string>();
  let expires = 0;
  let pending: Promise<void> | undefined;
  return async (id: string): Promise<boolean> => {
    if (now() >= expires) {
      pending ??= load().then(value => { ids = value; expires = now() + 60_000; })
        .catch(() => { ids = new Set(); expires = now() + 5000; })
        .finally(() => { pending = undefined; });
      await pending;
    }
    return ids.has(id);
  };
}
