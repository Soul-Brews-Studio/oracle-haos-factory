import { afterEach, beforeAll, describe, expect, test } from "bun:test";

const values = new Map<string, string>();
const events = new EventTarget();
const originalFetch = globalThis.fetch;

Object.assign(globalThis, {
  window: Object.assign(events, { location: { pathname: "/api/hassio_ingress/example/" } }),
  document: { baseURI: "https://ha.example/api/hassio_ingress/example/" },
  sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
});

let api: typeof import("./web/src/lib/api");

beforeAll(async () => {
  api = await import("./web/src/lib/api");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  api.clearIngressSession();
  api.setApiKey("");
});

describe("browser ingress authentication", () => {
  test("keeps a scoped ingress token in memory and preserves manual storage", () => {
    api.setApiKey("manual-secret");
    api.setIngressSession({
      ok: true,
      ingress: true,
      token: "scoped-session-token",
      expires_at: 2_000_000_000,
      user_id: "ha-user-id",
      user_name: "Nat",
    });

    expect(api.getApiKey()).toBe("scoped-session-token");
    expect(api.getManualApiKey()).toBe("manual-secret");
    expect([...values.values()]).not.toContain("scoped-session-token");

    api.clearIngressSession();
    expect(api.getApiKey()).toBe("manual-secret");
  });

  test("bootstraps with a relative request and no authorization credential", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init };
      return Response.json({
        ok: false,
        ingress: true,
        error: "not allowed",
        user_id: "ha-user-id",
        user_name: "Nat",
        allowlistOption: "auto_login_ha_user_ids",
      }, { status: 403 });
    }) as unknown as typeof fetch;

    const result = await api.bootstrapIngressAuth();
    expect(result.ok).toBe(false);
    expect(request?.url).toBe("https://ha.example/api/hassio_ingress/example/auth/ingress");
    expect(request?.init?.method).toBe("POST");
    expect(new Headers(request?.init?.headers).has("Authorization")).toBe(false);
    expect(request?.init?.cache).toBe("no-store");
  });

  test("fails closed and clears an ingress token on HTTP 401", async () => {
    api.setIngressSession({
      ok: true,
      ingress: true,
      token: "expired-session-token",
      expires_at: 2_000_000_000,
      user_id: "ha-user-id",
      user_name: "Nat",
    });
    let authFailed = false;
    const unsubscribe = api.onAuthFailed(() => { authFailed = true; });
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    await expect(api.validateApiKey(api.getApiKey())).rejects.toThrow("Invalid auth key");
    expect(api.getIngressSession()).toBeNull();
    expect(authFailed).toBe(true);
    unsubscribe();
  });

  test("a stale HTTP 401 cannot clear a newer ingress session", async () => {
    api.setIngressSession({
      ok: true,
      ingress: true,
      token: "old-session-token",
      expires_at: 2_000_000_000,
      user_id: "old-user",
      user_name: "Old user",
    });
    let release!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { release = resolve; })) as unknown as typeof fetch;
    let authFailed = false;
    const unsubscribe = api.onAuthFailed(() => { authFailed = true; });

    const oldRequest = api.validateApiKey(api.getApiKey());
    api.setIngressSession({
      ok: true,
      ingress: true,
      token: "new-session-token",
      expires_at: 2_000_000_100,
      user_id: "new-user",
      user_name: "New user",
    });
    release(new Response("unauthorized", { status: 401 }));

    await expect(oldRequest).rejects.toThrow("Invalid auth key");
    expect(api.getIngressSession()?.token).toBe("new-session-token");
    expect(authFailed).toBe(false);
    unsubscribe();
  });

  test("a malformed refresh cannot replace the current valid session", () => {
    api.setIngressSession({
      ok: true,
      ingress: true,
      token: "current-session-token",
      expires_at: 2_000_000_000,
      user_id: "ha-user-id",
      user_name: "Nat",
    });

    expect(() => api.setIngressSession({
      ok: true,
      ingress: true,
      token: "",
      expires_at: Number.NaN,
      user_id: "ha-user-id",
      user_name: "Nat",
    })).toThrow("invalid ingress session");
    expect(api.getIngressSession()?.token).toBe("current-session-token");
  });
});
