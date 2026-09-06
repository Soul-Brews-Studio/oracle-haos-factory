"use strict"

const assert = require("assert")
const fs = require("fs")
const api = require("../pb_hooks/lib/dc_api.js")

const rows = [
  { entity_id: "10000000000000001", kind: "channel", name: "general", guild_id: "20000000000000001" },
  { entity_id: "10000000000000002", kind: "channel", name: "general-chat", guild_id: "20000000000000001" },
  { entity_id: "10000000000000003", kind: "channel", name: "General", guild_id: "20000000000000002" },
  { entity_id: "10000000000000004", kind: "thread", name: "release notes", guild_id: "20000000000000001" },
]

assert.equal(api.resolveEntity(rows, "10000000000000004", api.CHANNEL_KINDS).kind, "thread")
assert.equal(api.resolveEntity(rows, "general-chat", api.CHANNEL_KINDS).entity_id, "10000000000000002")
assert.equal(api.resolveEntity(rows, "General", api.CHANNEL_KINDS).entity_id, "10000000000000003")
assert.equal(api.resolveEntity(rows, "release", api.CHANNEL_KINDS).entity_id, "10000000000000004")
assert.throws(() => api.resolveEntity(rows, "GeNeRaL", api.CHANNEL_KINDS), /ambiguous.*general.*General/)
assert.throws(() => api.resolveEntity(rows, "missing", api.CHANNEL_KINDS), /not found; candidates:/)
assert.equal(api.resolveEntity(rows, "general", api.CHANNEL_KINDS, "20000000000000001").entity_id, "10000000000000001")

assert.deepEqual(api.validateRead({ limit: "1", since: "2026-09-06T00:00:00Z" }), { limit: 1, since: "2026-09-06 00:00:00.000Z" })
assert.throws(() => api.validateRead({ limit: "101" }), /1 to 100/)
assert.throws(() => api.validateRead({ before: "yesterday" }), /ISO timestamp/)
assert.deepEqual(api.validateWrite("select", { on: false }), { on: false })
assert.throws(() => api.validateWrite("select", { on: "false" }), /boolean/)
assert.throws(() => api.validateWrite("post", { text: "" }), /1 to 2000/)
assert.throws(() => api.validateWrite("pin", { messageId: "../../bad" }), /snowflake/)

assert.throws(() => api.allowedToWrite(rows, rows[0], { allow_post: false, post_channels: "general" }), /allow_post=true/)
assert.throws(() => api.allowedToWrite(rows, rows[0], { allow_post: true, post_channels: "release notes" }), /not allowed/)
assert.equal(api.allowedToWrite(rows, rows[3], { allow_post: true, post_channels: "release notes" }), true)
assert.throws(() => api.allowedToWrite(rows, rows[0], { allow_post: true, post_channels: "GeNeRaL" }), /ambiguous/)
assert.equal(api.assertWritePolicy(rows, rows[0], "post", {ok: true, exists: true, channels: {"10000000000000001": {post: true, actions: []}}}, {}), true)
assert.throws(() => api.assertWritePolicy(rows, rows[0], "pin", {ok: true, exists: true, channels: {"10000000000000001": {post: true, actions: []}}}, {}), /pin is not allowed/)
assert.equal(api.assertWritePolicy(rows, rows[0], "pin", {ok: true, exists: true, channels: {"10000000000000001": {post: false, actions: ["pin"]}}}, {}), true)
assert.throws(() => api.assertWritePolicy(rows, rows[0], "post", {ok: false, exists: true, error: "bad model", channels: {}}, {allow_post: true, post_channels: rows[0].entity_id}), /invalid.*bad model/)

assert.equal(api.discordBase(false, "http://evil.invalid"), "https://discord.com/api/v10")
assert.equal(api.discordBase(true, "http://127.0.0.1:8080/"), "http://127.0.0.1:8080")
assert.throws(() => api.discordBase(true, "https://discord.com/api/v10"), /must be localhost/)
assert.throws(() => api.discordBase(true, "http://127.0.0.1.evil.test:8080"), /must be localhost/)

const hook = fs.readFileSync(require("path").join(__dirname, "../pb_hooks/220_dc.pb.js"), "utf8")
assert.equal((hook.match(/routerAdd\(/g) || []).length, (hook.match(/\$apis\.requireSuperuserAuth\(\)/g) || []).length, "every /api/dc route must require superuser auth")
assert(!hook.includes("DISCORD_API_BASE`)"), "Discord base URL must not come from a route parameter")
assert(hook.includes("allowed_mentions: { parse: [] }"), "outbound messages must suppress mention parsing")
assert(hook.includes("/messages/pins/${input.messageId}"), "pin must use Discord's current nondeprecated route")
assert(!hook.includes("}/pins/${input.messageId}"), "deprecated Discord pin route must not return")

assert.throws(() => api.assertImportable({discord_type: 4, name: "category", entity_id: "10000000000000001"}), /cannot be imported/)
assert.throws(() => api.assertImportable({discord_type: 15, name: "forum", entity_id: "10000000000000001"}), /individual thread/)
assert.doesNotThrow(() => api.assertImportable({discord_type: 11}))
assert(hook.slice(hook.indexOf('"/api/dc/config/reload"')).includes('$os.writeFile("/data/backfill-request"'), "valid reload must wake the running poller")
console.log("dc api helper: 35 assertions passed")
