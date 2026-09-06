import {describe, expect, test} from "bun:test";
import {createDC, SSEDecoder, type StreamSubscription, type TransportRequest} from "./dc.ts";
import {parseCLI, run} from "./cli.ts";

describe("dc sdk", () => {
  test("sync injected transport supports handles and encodes names", () => {
    const seen: TransportRequest[] = [];
    const dc = createDC({baseUrl: "http://pb/", token: "session-token", transport(request) {
      seen.push(request);
      if (request.url.includes("/read")) return {messages: [{message_id: "1"}]};
      if (request.url.endsWith("/channels")) return {channels: [{id: "2"}]};
      return {ok: true};
    }});
    expect(dc.channel("general chat").read({limit: 5, since: "2026-09-06T00:00:00Z"})).toEqual([{message_id: "1"}]);
    expect(dc.channels()).toEqual([{id: "2"}]);
    expect(dc.channel("general chat").post("hello")).toEqual({ok: true});
    expect(seen[0].url).toContain("/api/dc/channels/general%20chat/read?");
    expect(seen[0].headers.Authorization).toBe("session-token");
    expect(seen[2].body).toBe('{"text":"hello"}');
  });

  test("reads declared config and allowed action decisions", async () => {
    const dc = createDC({baseUrl: "http://pb", token: "token", transport: async request => {
      if (request.url.endsWith("/config")) return {ok: true, exists: true, config: {}, channels: {}, oracles: {}, yaml: "guilds: {}\n"};
      if (request.url.endsWith("/config.yaml")) {
        expect(request.responseType).toBe("text");
        return "# exact raw bytes\nguilds: {}\n";
      }
      return {allowed: request.url.endsWith("allowed?verb=thread")};
    }});
    expect((await dc.config()).yaml).toBe("guilds: {}\n");
    expect(await dc.configYaml()).toBe("# exact raw bytes\nguilds: {}\n");
    expect(await dc.channel("general").allowed("thread")).toBe(true);
    expect(await dc.channel("general").allowed("archive")).toBe(false);
  });

  test("promise transport and guild list preserve the same API", async () => {
    const dc = createDC({baseUrl: "http://pb", token: "token", transport: async request => {
      expect(request.url).toEndWith("/api/dc/channels?guild=Soul%20Brews");
      return [{id: "9", name: "general"}];
    }});
    expect(await dc.guild("Soul Brews").channels()).toEqual([{id: "9", name: "general"}]);
  });

  test("validates write arguments before transport", () => {
    const dc = createDC({baseUrl: "http://pb", token: "token", transport: () => ({})});
    expect(() => dc.channel("general").post("  ")).toThrow("non-empty text");
    expect(() => dc.channel("general").action.thread("", "starter")).toThrow("requires a name");
    expect(() => dc.channel("")).toThrow("requires a channel ID or name");
  });
});

describe("PocketBase realtime", () => {
  test("incremental SSE parser supports CRLF, split chunks, and multiline data", () => {
    const decoder = new SSEDecoder();
    expect(decoder.feed("event: PB_CONNECT\r\ndata: {\"clientId\":\"c1\"}\r")).toEqual([]);
    expect(decoder.feed("\n\r\nevent: x\ndata: one\ndata: two\n\n")).toEqual([
      {event: "PB_CONNECT", data: '{"clientId":"c1"}'},
      {event: "x", data: "one\ntwo"},
    ]);
  });

  test("authenticates the handshake, filters channel/thread events, and reconnects", async () => {
    const calls: Array<{url: string; init?: RequestInit}> = [];
    let gets = 0;
    let subscription: StreamSubscription;
    const received: Array<{id: unknown; action: string}> = [];
    const body = (text: string) => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); }
    });
    const realtimeFetch: typeof fetch = async (url, init) => {
      calls.push({url: String(url), init});
      if (init?.method === "POST") return new Response(null, {status: 204});
      gets++;
      const events = gets === 1
        ? 'event: PB_CONNECT\ndata: {"clientId":"first"}\n\nevent: discord_messages/*\ndata: {"action":"create","record":{"message_id":"skip","channel_id":"999"}}\n\n'
        : 'event: PB_CONNECT\ndata: {"clientId":"second"}\n\nevent: discord_messages/*\ndata: {"action":"update","record":{"message_id":"child-skip","channel_id":"42","thread_id":"77"}}\n\nevent: discord_messages/*\ndata: {"action":"update","record":{"message_id":"channel-hit","channel_id":"42"}}\n\nevent: discord_messages/*\ndata: {"action":"delete","record":{"message_id":"deleted","channel_id":"42","raw":{"_discord_pb_deleted":true}}}\n\n';
      return new Response(body(events), {status: 200, headers: {"Content-Type": "text/event-stream"}});
    };
    const dc = createDC({
      baseUrl: "http://pb/root/", token: "pb-superuser", realtimeFetch, realtimeBackoffMs: 0,
      transport: request => {
        expect(request.url).toEndWith("/api/dc/channels/general/read?limit=1");
        return {channel: {id: "42", kind: "channel"}, messages: []};
      },
    });
    subscription = dc.channel("general").stream((record, action) => {
      received.push({id: record.message_id, action});
      if (received.length === 2) subscription.close();
    });
    await subscription.ready;
    await subscription.done;
    expect(gets).toBe(2);
    expect(received).toEqual([{id: "channel-hit", action: "update"}, {id: "deleted", action: "delete"}]);
    const posts = calls.filter(call => call.init?.method === "POST");
    expect(posts).toHaveLength(2);
    expect(calls.every(call => call.init?.headers && (call.init.headers as Record<string, string>).Authorization === "pb-superuser")).toBe(true);
    expect(calls.every(call => !call.url.includes("pb-superuser"))).toBe(true);
    expect(JSON.parse(String(posts[1].init?.body))).toEqual({clientId: "second", subscriptions: ["discord_messages/*"]});
  });

  test("thread handles include only the exact thread", async () => {
    let subscription: StreamSubscription;
    const received: unknown[] = [];
    const realtimeFetch: typeof fetch = async (_url, init) => {
      if (init?.method === "POST") return new Response(null, {status: 204});
      const body = new ReadableStream<Uint8Array>({start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'event: PB_CONNECT\ndata: {"clientId":"thread"}\n\n' +
          'event: discord_messages/*\ndata: {"action":"create","record":{"message_id":"parent-skip","channel_id":"42"}}\n\n' +
          'event: discord_messages/*\ndata: {"action":"create","record":{"message_id":"thread-hit","channel_id":"42","thread_id":"77"}}\n\n'));
        controller.close();
      }});
      return new Response(body, {status: 200});
    };
    const dc = createDC({baseUrl: "http://pb", token: "secret", realtimeFetch, realtimeBackoffMs: 0,
      transport: () => ({channel: {id: "77", kind: "thread"}, messages: []})});
    subscription = dc.channel("release-thread").stream(record => {
      received.push(record.message_id);
      subscription.close();
    });
    await subscription.ready;
    await subscription.done;
    expect(received).toEqual(["thread-hit"]);
  });

  test("reports unsupported JSVM realtime before constructing browser primitives", () => {
    const originalFetch = globalThis.fetch;
    try {
      Object.defineProperty(globalThis, "fetch", {value: undefined, configurable: true, writable: true});
      const dc = createDC({baseUrl: "http://pb", token: "secret", transport: () => ({})});
      expect(() => dc.channel("general").stream(() => {})).toThrow("PocketBase JSVM callers cannot use realtime");
    } finally {
      Object.defineProperty(globalThis, "fetch", {value: originalFetch, configurable: true, writable: true});
    }
  });
});

describe("cli", () => {
  test("parses reads and rejects incomplete writes", () => {
    expect(parseCLI(["channel", "general", "read", "--limit", "10", "--before", "now"])).toEqual({
      kind: "channel", channel: "general", action: "read", args: [], read: {limit: 10, before: "now"}
    });
    expect(() => parseCLI(["channel", "general", "post"])).toThrow("post expects 1 argument");
    expect(parseCLI(["config"])).toEqual({kind: "config", action: "get"});
    expect(parseCLI(["config", "download"])).toEqual({kind: "config", action: "download"});
    expect(parseCLI(["channel", "general", "tail"])).toEqual({kind: "channel", channel: "general", action: "tail", args: [], read: {}});
  });

  test("dispatches channel actions without exposing credentials", async () => {
    const calls: TransportRequest[] = [];
    const client = createDC({baseUrl: "http://pb", token: "secret", transport: async request => { calls.push(request); return {ok: true}; }});
    await run(parseCLI(["channel", "general", "thread", "News", "First post"]), client);
    expect(calls[0].url).toEndWith("/channels/general/thread");
    expect(calls[0].body).toBe('{"name":"News","starter":"First post"}');
  });

  test("CLI config download uses the raw YAML endpoint", async () => {
    const client = createDC({baseUrl: "http://pb", token: "secret", transport: request => {
      expect(request.url).toEndWith("/api/dc/config.yaml");
      expect(request.responseType).toBe("text");
      return "# raw\n";
    }});
    expect(await run(parseCLI(["config", "download"]), client)).toBe("# raw\n");
  });

  test("CLI tail dispatches to the realtime channel handle", async () => {
    const realtimeFetch: typeof fetch = async (_url, init) => {
      if (init?.method === "POST") return new Response(null, {status: 204});
      const body = new ReadableStream<Uint8Array>({start(controller) {
        controller.enqueue(new TextEncoder().encode('event: PB_CONNECT\ndata: {"clientId":"tail"}\n\n'));
        controller.close();
      }});
      return new Response(body, {status: 200});
    };
    const client = createDC({baseUrl: "http://pb", token: "secret", realtimeFetch, realtimeBackoffMs: 60_000,
      transport: () => ({channel: {id: "42"}, messages: []})});
    const stream = run(parseCLI(["channel", "general", "tail"]), client) as StreamSubscription;
    await stream.ready;
    stream.close();
    await stream.done;
  });
});
