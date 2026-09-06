import {describe, expect, test} from "bun:test";
import {createDC, type TransportRequest} from "./dc.ts";
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

describe("cli", () => {
  test("parses reads and rejects incomplete writes", () => {
    expect(parseCLI(["channel", "general", "read", "--limit", "10", "--before", "now"])).toEqual({
      kind: "channel", channel: "general", action: "read", args: [], read: {limit: 10, before: "now"}
    });
    expect(() => parseCLI(["channel", "general", "post"])).toThrow("post expects 1 argument");
    expect(parseCLI(["config"])).toEqual({kind: "config", action: "get"});
    expect(parseCLI(["config", "download"])).toEqual({kind: "config", action: "download"});
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
});
