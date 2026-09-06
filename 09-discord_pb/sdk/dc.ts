export type MaybePromise<T> = T | Promise<T>;

export type TransportRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  responseType?: "json" | "text";
};

export type Transport = (request: TransportRequest) => MaybePromise<unknown>;

export type DCConfig = {
  baseUrl: string;
  token: string;
  transport?: Transport;
  realtimeFetch?: typeof fetch;
  realtimeBackoffMs?: number;
};

export type ReadOptions = {
  limit?: number;
  since?: string;
  before?: string;
};

export type TimelineOptions = {bucket?: "day" | "hour"};
export type TimelineBucket = {start: string; date: string; label: string; count: number};
export type TimelineGap = {since: string; before: string; days: number};
export type Timeline = {
  ok: true;
  bucket: "day" | "hour";
  time_zone: "Asia/Bangkok";
  target: {id: string; name: string; kind: string};
  first: string | null;
  last: string | null;
  total: number;
  buckets: TimelineBucket[];
  gaps: TimelineGap[];
};

export type ChannelInfo = {
  id: string;
  name: string;
  guild: string;
  guild_id?: string;
  kind: string;
  parent: string | null;
  archived: boolean;
  imported_count: number;
  first_message_at?: string | null;
  last_message_at?: string | null;
  last_import_at?: string | null;
  selected: boolean;
  purpose?: string | null;
  owner?: string | null;
  post?: boolean;
  actions?: string[];
  importable?: boolean;
  discord_type?: number;
};

export type DCConfigModel = {
  ok: boolean;
  exists: boolean;
  config: Record<string, unknown>;
  channels: Record<string, Record<string, unknown>>;
  oracles: Record<string, unknown>;
  yaml: string;
};

type JsonMap = Record<string, unknown>;

export type RealtimeAction = "create" | "update" | "delete";
export type DiscordMessage = JsonMap & {
  message_id?: string;
  channel_id?: string;
  thread_id?: string;
  raw?: JsonMap;
};
export type StreamSubscription = {
  ready: Promise<void>;
  done: Promise<void>;
  close(): void;
};
export type SSEEvent = {event: string; data: string};

/** Incremental SSE decoder shared by the SDK and its protocol tests. */
export class SSEDecoder {
  private buffer = "";

  feed(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    this.buffer = this.buffer.replace(/\r\n/g, "\n").replace(/\r(?!$)/g, "\n");
    const events: SSEEvent[] = [];
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trimStart();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) events.push({event, data: data.join("\n")});
    }
    return events;
  }
}

function join(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, "") + "/api/dc" + path;
}

function pbJoin(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, "") + path;
}

function query(values: object): string {
  const record = values as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value !== undefined && value !== "") {
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
    }
  }
  return parts.length ? "?" + parts.join("&") : "";
}

function isPromise<T>(value: MaybePromise<T>): value is Promise<T> {
  return !!value && typeof (value as Promise<T>).then === "function";
}

function map<T, U>(value: MaybePromise<T>, fn: (item: T) => U): MaybePromise<U> {
  return isPromise(value) ? value.then(fn) : fn(value);
}

function errorMessage(data: unknown, status: number): string {
  if (data && typeof data === "object") {
    const row = data as JsonMap;
    if (typeof row.error === "string") return row.error;
    if (typeof row.message === "string") return row.message;
  }
  return "Discord channel API request failed (HTTP " + status + ")";
}

function defaultTransport(request: TransportRequest): Promise<unknown> {
  return fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  }).then((response) => response.text().then((text) => {
    if (request.responseType === "text") {
      if (!response.ok) {
        let data: unknown = null;
        try { data = JSON.parse(text); } catch (_) {}
        throw new Error(errorMessage(data, response.status));
      }
      return text;
    }
    let data: unknown = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch (_) { throw new Error("Discord channel API returned unreadable JSON (HTTP " + response.status + ")"); }
    }
    if (!response.ok) throw new Error(errorMessage(data, response.status));
    return data;
  }));
}

function arrayFrom(data: unknown, key: string): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray((data as JsonMap)[key])) {
    return (data as JsonMap)[key] as unknown[];
  }
  throw new Error("Discord channel API returned an invalid " + key + " response");
}

export function createDC(config: DCConfig) {
  if (!config || typeof config.baseUrl !== "string" || !config.baseUrl.trim()) {
    throw new Error("createDC requires baseUrl");
  }
  if (typeof config.token !== "string" || !config.token.trim()) {
    throw new Error("createDC requires a PocketBase superuser or HA-ingress session token");
  }
  const transport = config.transport || defaultTransport;

  function request(method: string, path: string, body?: unknown, responseType: "json" | "text" = "json"): MaybePromise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: config.token,
    };
    const outgoing: TransportRequest = {method, url: join(config.baseUrl, path), headers, responseType};
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      outgoing.body = JSON.stringify(body);
    }
    return transport(outgoing);
  }

  function channel(x: string) {
    if (typeof x !== "string" || !x.trim()) throw new Error("channel(x) requires a channel ID or name");
    const path = "/channels/" + encodeURIComponent(x.trim());
    return {
      read(options: ReadOptions = {}) {
        return map(request("GET", path + "/read" + query(options)), (data) => arrayFrom(data, "messages"));
      },
      timeline(options: TimelineOptions = {}) {
        if (options.bucket !== undefined && options.bucket !== "day" && options.bucket !== "hour") {
          throw new Error("timeline bucket must be day or hour");
        }
        return map(request("GET", path + "/timeline" + query(options)), (data) => {
          if (!data || typeof data !== "object" || !Array.isArray((data as JsonMap).buckets)) {
            throw new Error("Discord channel API returned an invalid timeline response");
          }
          return data as Timeline;
        });
      },
      import() { return request("POST", path + "/import", {}); },
      stream(onMessage: (record: DiscordMessage, action: RealtimeAction) => void): StreamSubscription {
        if (typeof onMessage !== "function") throw new Error("stream(onMessage) requires a callback");
        const realtimeFetch = config.realtimeFetch || (typeof fetch === "function" ? fetch : null);
        if (!realtimeFetch || typeof AbortController !== "function" || typeof TextDecoder !== "function") {
          throw new Error("stream() requires fetch and Web Streams support; PocketBase JSVM callers cannot use realtime");
        }
        const controller = new AbortController();
        const backoffMs = Math.max(0, config.realtimeBackoffMs ?? 1000);
        let readyResolve!: () => void, readyReject!: (error: unknown) => void;
        let connected = false, activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        ready.catch(() => {});

        const done = (async () => {
          let targetId = "", targetKind = "channel";
          try {
            const resolved = await request("GET", path + "/read?limit=1");
            if (!resolved || typeof resolved !== "object" || !((resolved as JsonMap).channel as JsonMap)?.id) {
              throw new Error("Discord channel API returned an invalid resolved channel");
            }
            const target = (resolved as JsonMap).channel as JsonMap;
            targetId = String(target.id);
            targetKind = String(target.kind || "channel");
          } catch (error) {
            readyReject(error);
            throw error;
          }

          while (!controller.signal.aborted) {
            try {
              const response = await realtimeFetch(pbJoin(config.baseUrl, "/api/realtime"), {
                method: "GET",
                headers: {Accept: "text/event-stream", Authorization: config.token},
                signal: controller.signal,
              });
              if (!response.ok || !response.body) throw new Error("PocketBase realtime connection failed (HTTP " + response.status + ")");
              const reader = response.body.getReader();
              activeReader = reader;
              const text = new TextDecoder();
              const decoder = new SSEDecoder();
              let subscribed = false;
              while (!controller.signal.aborted) {
                const part = await reader.read();
                if (part.done) break;
                for (const event of decoder.feed(text.decode(part.value, {stream: true}))) {
                  let data: JsonMap;
                  try { data = JSON.parse(event.data) as JsonMap; } catch (_) { continue; }
                  if (event.event === "PB_CONNECT") {
                    if (typeof data.clientId !== "string" || !data.clientId) throw new Error("PocketBase realtime did not provide a client ID");
                    const subscribedResponse = await realtimeFetch(pbJoin(config.baseUrl, "/api/realtime"), {
                      method: "POST",
                      headers: {Accept: "application/json", Authorization: config.token, "Content-Type": "application/json"},
                      body: JSON.stringify({clientId: data.clientId, subscriptions: ["discord_messages/*"]}),
                      signal: controller.signal,
                    });
                    if (!subscribedResponse.ok) throw new Error("PocketBase realtime subscription failed (HTTP " + subscribedResponse.status + ")");
                    subscribed = true;
                    if (!connected) { connected = true; readyResolve(); }
                    continue;
                  }
                  if (!subscribed || (event.event !== "discord_messages/*" && event.event !== "discord_messages")) continue;
                  const action = data.action;
                  const record = data.record;
                  if ((action !== "create" && action !== "update" && action !== "delete") || !record || typeof record !== "object") continue;
                  const message = record as DiscordMessage;
                  const matches = targetKind === "thread"
                    ? message.thread_id === targetId
                    : message.channel_id === targetId && !message.thread_id;
                  if (matches) onMessage(message, action);
                }
              }
              activeReader = null;
            } catch (error) {
              void activeReader?.cancel();
              activeReader = null;
              if (controller.signal.aborted) break;
              if (!connected && error instanceof Error && /HTTP (400|401|403|404)/.test(error.message)) {
                readyReject(error);
                throw error;
              }
            }
            if (!controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, backoffMs));
          }
        })();
        // A caller may only care about callbacks/close; avoid an unhandled rejection.
        done.catch(() => {});
        return {ready, done, close: () => { controller.abort(); void activeReader?.cancel(); }};
      },
      allowed(verb: string) {
        if (typeof verb !== "string" || !verb.trim()) throw new Error("allowed(verb) requires an action verb");
        return map(request("GET", path + "/allowed" + query({verb: verb.trim()})), (data) => {
          if (!data || typeof data !== "object" || typeof (data as JsonMap).allowed !== "boolean") {
            throw new Error("Discord channel API returned an invalid allowed response");
          }
          return (data as JsonMap).allowed as boolean;
        });
      },
      post(text: string) {
        if (typeof text !== "string" || !text.trim()) throw new Error("post(text) requires non-empty text");
        return request("POST", path + "/post", {text});
      },
      action: {
        thread(name: string, starter: string) {
          if (!name?.trim() || !starter?.trim()) throw new Error("thread(name, starter) requires a name and starter text");
          return request("POST", path + "/thread", {name, starter});
        },
        pin(messageId: string) {
          if (!messageId?.trim()) throw new Error("pin(messageId) requires a message ID");
          return request("POST", path + "/pin", {messageId});
        },
        archive() { return request("POST", path + "/archive", {}); },
      },
    };
  }

  function channels(options: {guild?: string} = {}) {
    return map(request("GET", "/channels" + query(options)), (data) => arrayFrom(data, "channels") as ChannelInfo[]);
  }

  return {
    channel,
    channels,
    config() {
      return map(request("GET", "/config"), (data) => {
        if (!data || typeof data !== "object" || typeof (data as JsonMap).yaml !== "string") {
          throw new Error("Discord channel API returned an invalid config response");
        }
        return data as DCConfigModel;
      });
    },
    configYaml() {
      return map(request("GET", "/config.yaml", undefined, "text"), (data) => {
        if (typeof data !== "string") throw new Error("Discord channel API returned an invalid config YAML response");
        return data;
      });
    },
    guild(x: string) {
      if (typeof x !== "string" || !x.trim()) throw new Error("guild(x) requires a guild ID or name");
      const guildPath = "/guilds/" + encodeURIComponent(x.trim());
      return {
        channels: () => channels({guild: x.trim()}),
        timeline(options: TimelineOptions = {}) {
          if (options.bucket !== undefined && options.bucket !== "day" && options.bucket !== "hour") {
            throw new Error("timeline bucket must be day or hour");
          }
          return map(request("GET", guildPath + "/timeline" + query(options)), (data) => {
            if (!data || typeof data !== "object" || !Array.isArray((data as JsonMap).buckets)) {
              throw new Error("Discord channel API returned an invalid timeline response");
            }
            return data as Timeline;
          });
        },
      };
    },
  };
}
