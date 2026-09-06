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
};

export type ReadOptions = {
  limit?: number;
  since?: string;
  before?: string;
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

function join(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, "") + "/api/dc" + path;
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
      import() { return request("POST", path + "/import", {}); },
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
      return {channels: () => channels({guild: x.trim()})};
    },
  };
}
