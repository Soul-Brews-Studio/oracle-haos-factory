var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// sdk/dc.ts
var exports_dc = {};
__export(exports_dc, {
  createDC: () => createDC,
  SSEDecoder: () => SSEDecoder
});
module.exports = __toCommonJS(exports_dc);

class SSEDecoder {
  buffer = "";
  feed(chunk) {
    this.buffer += chunk;
    this.buffer = this.buffer.replace(/\r\n/g, `
`).replace(/\r(?!$)/g, `
`);
    const events = [];
    let boundary;
    while ((boundary = this.buffer.indexOf(`

`)) !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      let event = "message";
      const data = [];
      for (const line of block.split(`
`)) {
        if (line.startsWith("event:"))
          event = line.slice(6).trimStart();
        else if (line.startsWith("data:"))
          data.push(line.slice(5).trimStart());
      }
      if (data.length)
        events.push({ event, data: data.join(`
`) });
    }
    return events;
  }
}
function join(baseUrl, path) {
  return baseUrl.replace(/\/+$/, "") + "/api/dc" + path;
}
function pbJoin(baseUrl, path) {
  return baseUrl.replace(/\/+$/, "") + path;
}
function query(values) {
  const record = values;
  const parts = [];
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value !== undefined && value !== "") {
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
    }
  }
  return parts.length ? "?" + parts.join("&") : "";
}
function isPromise(value) {
  return !!value && typeof value.then === "function";
}
function map(value, fn) {
  return isPromise(value) ? value.then(fn) : fn(value);
}
function errorMessage(data, status) {
  if (data && typeof data === "object") {
    const row = data;
    if (typeof row.error === "string")
      return row.error;
    if (typeof row.message === "string")
      return row.message;
  }
  return "Discord channel API request failed (HTTP " + status + ")";
}
function defaultTransport(request) {
  return fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body
  }).then((response) => response.text().then((text) => {
    if (request.responseType === "text") {
      if (!response.ok) {
        let data2 = null;
        try {
          data2 = JSON.parse(text);
        } catch (_) {}
        throw new Error(errorMessage(data2, response.status));
      }
      return text;
    }
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        throw new Error("Discord channel API returned unreadable JSON (HTTP " + response.status + ")");
      }
    }
    if (!response.ok)
      throw new Error(errorMessage(data, response.status));
    return data;
  }));
}
function arrayFrom(data, key) {
  if (Array.isArray(data))
    return data;
  if (data && typeof data === "object" && Array.isArray(data[key])) {
    return data[key];
  }
  throw new Error("Discord channel API returned an invalid " + key + " response");
}
function createDC(config) {
  if (!config || typeof config.baseUrl !== "string" || !config.baseUrl.trim()) {
    throw new Error("createDC requires baseUrl");
  }
  if (typeof config.token !== "string" || !config.token.trim()) {
    throw new Error("createDC requires a PocketBase superuser or HA-ingress session token");
  }
  const transport = config.transport || defaultTransport;
  function request(method, path, body, responseType = "json") {
    const headers = {
      Accept: "application/json",
      Authorization: config.token
    };
    const outgoing = { method, url: join(config.baseUrl, path), headers, responseType };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      outgoing.body = JSON.stringify(body);
    }
    return transport(outgoing);
  }
  function channel(x) {
    if (typeof x !== "string" || !x.trim())
      throw new Error("channel(x) requires a channel ID or name");
    const path = "/channels/" + encodeURIComponent(x.trim());
    return {
      read(options = {}) {
        return map(request("GET", path + "/read" + query(options)), (data) => arrayFrom(data, "messages"));
      },
      timeline(options = {}) {
        if (options.bucket !== undefined && options.bucket !== "day" && options.bucket !== "hour") {
          throw new Error("timeline bucket must be day or hour");
        }
        return map(request("GET", path + "/timeline" + query(options)), (data) => {
          if (!data || typeof data !== "object" || !Array.isArray(data.buckets)) {
            throw new Error("Discord channel API returned an invalid timeline response");
          }
          return data;
        });
      },
      import() {
        return request("POST", path + "/import", {});
      },
      stream(onMessage) {
        if (typeof onMessage !== "function")
          throw new Error("stream(onMessage) requires a callback");
        const realtimeFetch = config.realtimeFetch || (typeof fetch === "function" ? fetch : null);
        if (!realtimeFetch || typeof AbortController !== "function" || typeof TextDecoder !== "function") {
          throw new Error("stream() requires fetch and Web Streams support; PocketBase JSVM callers cannot use realtime");
        }
        const controller = new AbortController;
        const backoffMs = Math.max(0, config.realtimeBackoffMs ?? 1000);
        let readyResolve, readyReject;
        let connected = false, activeReader = null;
        const ready = new Promise((resolve, reject) => {
          readyResolve = resolve;
          readyReject = reject;
        });
        ready.catch(() => {});
        const done = (async () => {
          let targetId = "", targetKind = "channel";
          try {
            const resolved = await request("GET", path + "/read?limit=1");
            if (!resolved || typeof resolved !== "object" || !resolved.channel?.id) {
              throw new Error("Discord channel API returned an invalid resolved channel");
            }
            const target = resolved.channel;
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
                headers: { Accept: "text/event-stream", Authorization: config.token },
                signal: controller.signal
              });
              if (!response.ok || !response.body)
                throw new Error("PocketBase realtime connection failed (HTTP " + response.status + ")");
              const reader = response.body.getReader();
              activeReader = reader;
              const text = new TextDecoder;
              const decoder = new SSEDecoder;
              let subscribed = false;
              while (!controller.signal.aborted) {
                const part = await reader.read();
                if (part.done)
                  break;
                for (const event of decoder.feed(text.decode(part.value, { stream: true }))) {
                  let data;
                  try {
                    data = JSON.parse(event.data);
                  } catch (_) {
                    continue;
                  }
                  if (event.event === "PB_CONNECT") {
                    if (typeof data.clientId !== "string" || !data.clientId)
                      throw new Error("PocketBase realtime did not provide a client ID");
                    const subscribedResponse = await realtimeFetch(pbJoin(config.baseUrl, "/api/realtime"), {
                      method: "POST",
                      headers: { Accept: "application/json", Authorization: config.token, "Content-Type": "application/json" },
                      body: JSON.stringify({ clientId: data.clientId, subscriptions: ["discord_messages/*"] }),
                      signal: controller.signal
                    });
                    if (!subscribedResponse.ok)
                      throw new Error("PocketBase realtime subscription failed (HTTP " + subscribedResponse.status + ")");
                    subscribed = true;
                    if (!connected) {
                      connected = true;
                      readyResolve();
                    }
                    continue;
                  }
                  if (!subscribed || event.event !== "discord_messages/*" && event.event !== "discord_messages")
                    continue;
                  const action = data.action;
                  const record = data.record;
                  if (action !== "create" && action !== "update" && action !== "delete" || !record || typeof record !== "object")
                    continue;
                  const message = record;
                  const matches = targetKind === "thread" ? message.thread_id === targetId : message.channel_id === targetId && !message.thread_id;
                  if (matches)
                    onMessage(message, action);
                }
              }
              activeReader = null;
            } catch (error) {
              activeReader?.cancel();
              activeReader = null;
              if (controller.signal.aborted)
                break;
              if (!connected && error instanceof Error && /HTTP (400|401|403|404)/.test(error.message)) {
                readyReject(error);
                throw error;
              }
            }
            if (!controller.signal.aborted)
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
          }
        })();
        done.catch(() => {});
        return { ready, done, close: () => {
          controller.abort();
          activeReader?.cancel();
        } };
      },
      allowed(verb) {
        if (typeof verb !== "string" || !verb.trim())
          throw new Error("allowed(verb) requires an action verb");
        return map(request("GET", path + "/allowed" + query({ verb: verb.trim() })), (data) => {
          if (!data || typeof data !== "object" || typeof data.allowed !== "boolean") {
            throw new Error("Discord channel API returned an invalid allowed response");
          }
          return data.allowed;
        });
      },
      post(text) {
        if (typeof text !== "string" || !text.trim())
          throw new Error("post(text) requires non-empty text");
        return request("POST", path + "/post", { text });
      },
      action: {
        thread(name, starter) {
          if (!name?.trim() || !starter?.trim())
            throw new Error("thread(name, starter) requires a name and starter text");
          return request("POST", path + "/thread", { name, starter });
        },
        pin(messageId) {
          if (!messageId?.trim())
            throw new Error("pin(messageId) requires a message ID");
          return request("POST", path + "/pin", { messageId });
        },
        archive() {
          return request("POST", path + "/archive", {});
        }
      }
    };
  }
  function channels(options = {}) {
    return map(request("GET", "/channels" + query(options)), (data) => arrayFrom(data, "channels"));
  }
  return {
    channel,
    channels,
    config() {
      return map(request("GET", "/config"), (data) => {
        if (!data || typeof data !== "object" || typeof data.yaml !== "string") {
          throw new Error("Discord channel API returned an invalid config response");
        }
        return data;
      });
    },
    configYaml() {
      return map(request("GET", "/config.yaml", undefined, "text"), (data) => {
        if (typeof data !== "string")
          throw new Error("Discord channel API returned an invalid config YAML response");
        return data;
      });
    },
    guild(x) {
      if (typeof x !== "string" || !x.trim())
        throw new Error("guild(x) requires a guild ID or name");
      const guildPath = "/guilds/" + encodeURIComponent(x.trim());
      return {
        channels: () => channels({ guild: x.trim() }),
        timeline(options = {}) {
          if (options.bucket !== undefined && options.bucket !== "day" && options.bucket !== "hour") {
            throw new Error("timeline bucket must be day or hour");
          }
          return map(request("GET", guildPath + "/timeline" + query(options)), (data) => {
            if (!data || typeof data !== "object" || !Array.isArray(data.buckets)) {
              throw new Error("Discord channel API returned an invalid timeline response");
            }
            return data;
          });
        }
      };
    }
  };
}
