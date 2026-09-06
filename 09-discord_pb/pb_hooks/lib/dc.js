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
  createDC: () => createDC
});
module.exports = __toCommonJS(exports_dc);
function join(baseUrl, path) {
  return baseUrl.replace(/\/+$/, "") + "/api/dc" + path;
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
      import() {
        return request("POST", path + "/import", {});
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
      return { channels: () => channels({ guild: x.trim() }) };
    }
  };
}
