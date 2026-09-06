# Discord channel-handle SDK

This client talks only to the add-on's authenticated `/api/dc/*` routes. `DC_TOKEN`
is a PocketBase superuser token or a token minted by the Home Assistant ingress
session. Never copy the Discord bot token off the add-on.

```ts
import {createDC} from "./sdk/dc.ts";

const dc = createDC({baseUrl: process.env.DC_URL!, token: process.env.DC_TOKEN!});
const selected = await dc.channels();
const recent = await dc.channel("general").read({limit: 20});
const days = await dc.channel("general").timeline({bucket: "day"});
const guildHours = await dc.guild("Soul Brews").timeline({bucket: "hour"});
await dc.channel("general").import();
const mayPost = await dc.channel("general").allowed("post");
const declaredModel = await dc.config();
const rawYaml = await dc.configYaml();
```

## Live messages

```ts
const live = dc.channel("arra-01").stream((record, action) => {
  console.log(action, record.message_id, record.content);
});
await live.ready;
// Later: live.close(); await live.done;
```

The stream uses PocketBase realtime with the PocketBase superuser/session token in
the `Authorization` header; it never puts that token in the URL and never uses the
Discord bot token. PocketBase realtime has no replay cursor, so this is a live,
non-durable notification stream. After a disconnect the SDK reconnects and
resubscribes, but consumers that require gap-free history should call `read({since})`.
The callback receives `(record, action)`, where `action` is `create`, `update`, or
`delete`; tombstoned Discord messages also have `raw._discord_pb_deleted === true`.
Filtering matches `read()`: a channel handle excludes replies inside its child
threads, while a thread handle emits only records whose `thread_id` is that thread.

From a shell:

```sh
DC_URL=http://localhost:8110 DC_TOKEN="$POCKETBASE_TOKEN" \
  bun sdk/cli.ts channel arra-01 tail
```

`channel(x)` and `guild(x)` accept an ID or name. The server resolves an exact
name first, then a unique substring, and returns a clear ambiguity/not-found
error otherwise. Handles do not cache resolved IDs.

Writes use the same handle:

```ts
await dc.channel("announcements").post("hello");
await dc.channel("general").action.thread("Release", "First post");
await dc.channel("general").action.pin("12345678901234567");
await dc.channel("old-thread").action.archive();
```

The add-on refuses every Discord write unless `allow_post` is enabled and the
resolved target is in `post_channels`. The SDK cannot bypass that server gate.

## CLI

```bash
export DC_URL='http://kvmlab1.oracle.netbird:8110'
export DC_TOKEN='a-pocketbase-or-ingress-session-token'
bun sdk/cli.ts channels
bun sdk/cli.ts guild 'Soul Brews' channels
bun sdk/cli.ts channel general read --limit 20
bun sdk/cli.ts channel general timeline --bucket day
bun sdk/cli.ts channel general tail
bun sdk/cli.ts channel general import
bun sdk/cli.ts channel announcements post 'hello'
bun sdk/cli.ts channel general thread 'Release' 'First post'
bun sdk/cli.ts config get
bun sdk/cli.ts config download # writes ./dc.config.yaml
```

The CLI emits JSON and never logs credentials.

When `dc.config.yaml` exists, its `post` and `actions` policies are authoritative;
the legacy `allow_post` / `post_channels` options are used only when no declared
model exists. The add-on's PocketBase API is mapped on port **8110**.

## PocketBase JSVM

`pb_hooks/lib/dc.js` is the committed CommonJS build. Regenerate it from the
single TypeScript source with `./sdk/build.sh`. JSVM callers inject a
synchronous transport because JSVM does not provide browser `fetch`:

```js
const {createDC} = require(`${__hooks}/lib/dc.js`);
const dc = createDC({
  baseUrl: "http://127.0.0.1:8090",
  token: sessionToken,
  transport: function (request) {
    const response = $http.send({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error((response.json && (response.json.error || response.json.message)) || "Discord channel API request failed");
    }
    return request.responseType === "text" ? response.raw : response.json;
  }
});
```
