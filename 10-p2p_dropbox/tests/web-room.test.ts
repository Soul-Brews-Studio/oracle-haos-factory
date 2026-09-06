import { expect, test } from "bun:test";

test("web API URLs preserve ingress prefix, use scoped tokens and configured room", async () => {
  const originalWindow = globalThis.window, originalDocument = globalThis.document;
  Object.assign(globalThis, {
    window: { location: { pathname: "/api/hassio_ingress/fixture/", protocol: "https:" } },
    document: { baseURI: "https://ha.invalid/api/hassio_ingress/fixture/" },
  });
  try {
    const { signalingWsUrl } = await import("../dropbox/web/src/lib/api");
    const url = new URL(signalingWsUrl("scoped-fixture", "lab-02"));
    expect(url.pathname).toBe("/api/hassio_ingress/fixture/ws");
    expect(url.protocol).toBe("wss:");
    expect(url.searchParams.get("room")).toBe("lab-02");
    expect(url.searchParams.get("token")).toBe("scoped-fixture");
    expect(url.searchParams.has("key")).toBeFalse();
    expect(new URL(signalingWsUrl("scoped-fixture")).searchParams.get("room")).toBe("default");
    expect(() => signalingWsUrl("scoped-fixture", "../other")).toThrow("Invalid signaling room");
  } finally {
    Object.assign(globalThis, { window: originalWindow, document: originalDocument });
  }
});
