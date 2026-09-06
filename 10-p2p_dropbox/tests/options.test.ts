import { test, expect } from "bun:test";
import { optionsEnvironment } from "../options";
const options = () => ({ auth_key: crypto.randomUUID() });
test("optional schema auth still fails closed when missing, null, empty or whitespace", () => {
  expect(() => optionsEnvironment({})).toThrow("auth_key");
  for (const auth_key of [null, "", "   "]) {
    expect(() => optionsEnvironment({auth_key})).toThrow("auth_key");
  }
});
test("empty or null optional TURN fields disable TURN", () => {
  for (const value of ["", null]) {
    const env = optionsEnvironment({...options(), turn_url: value, turn_user: value, turn_pass: value});
    expect(env.TURN_URLS).toBe("");
    expect(env.TURN_USER).toBe("");
    expect(env.TURN_CRED).toBe("");
  }
});
test("defaults use share and local signaling", () => {
  const env = optionsEnvironment(options());
  expect(env.SAVE_DIR).toBe("/share/p2p");
  expect(env.UPLOAD_DIR).toBe(env.SAVE_DIR);
  expect(env.SIGNAL_URL).toBe("ws://127.0.0.1:3847/ws");
  expect(env.TURN_CRED).toBe("");
});
test("configured TURN and empty STUN are supported", () => {
  const env = optionsEnvironment({...options(), stun_servers: [], turn_url: "turn:relay.invalid:3478", turn_user: "fixture", turn_pass: crypto.randomUUID()});
  expect(env.STUN_SERVERS).toBe("[]");
  expect(env.TURN_URLS).toBe("turn:relay.invalid:3478");
});
test("partial TURN fails closed", () => { expect(() => optionsEnvironment({...options(), turn_url: "turn:relay.invalid:3478"})).toThrow("set all"); });
test("unsafe paths and multiline env injection are rejected", () => {
  for (const save_dir of ["/data", "/share", "/share/../data", "relative", "/share/p2p/../x"]) expect(() => optionsEnvironment({...options(), save_dir})).toThrow("save_dir");
  expect(() => optionsEnvironment({auth_key: "invalid\nHOST=example"})).toThrow("single-line");
});
test("invalid size and STUN rejected", () => {
  for (const max_file_mb of [0, -1, 1.5, 10241, "12"]) expect(() => optionsEnvironment({...options(), max_file_mb})).toThrow("max_file_mb");
  expect(() => optionsEnvironment({...options(), stun_servers: ["https://example.org"]})).toThrow("STUN");
});
test("auto-login migration defaults preserve existing auth and support exact ID lists", () => {
  const original = options();
  const env = optionsEnvironment(original);
  expect(env.AUTH_KEY).toBe(original.auth_key);
  expect(env.AUTO_LOGIN).toBe("true");
  expect(env.AUTO_LOGIN_HA_ADMINS).toBe("true");
  expect(env.AUTO_LOGIN_HA_USER_IDS).toBe("");
  const restricted = optionsEnvironment({...original, auto_login: false, auto_login_ha_admins: false, auto_login_ha_user_ids: " user-1, user-2 "});
  expect(restricted.AUTO_LOGIN).toBe("false");
  expect(restricted.AUTO_LOGIN_HA_ADMINS).toBe("false");
  expect(restricted.AUTO_LOGIN_HA_USER_IDS).toBe(" user-1, user-2 ");
});
test("invalid auto-login booleans or user list fail closed", () => {
  for (const name of ["auto_login", "auto_login_ha_admins"]) {
    for (const value of ["true", "false", 0, 1, []]) expect(() => optionsEnvironment({...options(), [name]: value})).toThrow("boolean");
  }
  for (const auto_login_ha_user_ids of [[], "bad\nuser", "user.*", "x".repeat(129)]) expect(() => optionsEnvironment({...options(), auto_login_ha_user_ids})).toThrow();
});

test("room defaults migrate old options and validate configured room", () => {
  expect(optionsEnvironment(options()).ROOM).toBe("default");
  expect(optionsEnvironment({...options(), room: "lab-02"}).ROOM).toBe("lab-02");
  for (const room of ["../other", "a/b", "a b", "x".repeat(65), 42]) {
    expect(() => optionsEnvironment({...options(), room})).toThrow();
  }
});
