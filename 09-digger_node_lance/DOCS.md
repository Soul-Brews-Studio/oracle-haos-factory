# Digger Node Lance

This side-by-side add-on keeps Digger Node's web UI, REST routes, 19 MCP tools,
static bearer authentication and OAuth compatibility endpoints while moving the
corpus to LanceDB. PocketBase is bundled as the private auth/admin database.

## Services and persistent data

Only the Bun service is published:

| Service | Listener | State |
|---|---|---|
| Digger Node | `0.0.0.0:8111` | public UI, API, MCP and `/health` |
| Python Lance service | `127.0.0.1:8110` | `/data/lancedb` |
| PocketBase | `127.0.0.1:8090` | `/data/pb_data` |

The multilingual FastEmbed model is downloaded while the image is built and
stored read-only under `/opt/models`; production startup is offline. A shared
internal service token is generated once under `/data`, mode `0600`, and never
appears in command arguments or logs. This add-on neither reads nor writes the
existing Digger Node add-on's `/data/digger.db`.

The entrypoint supervises all three processes. If any dependency exits, the
other two are stopped so Supervisor can restart one coherent application.

## Configuration

| Option | Meaning |
|---|---|
| `instance_name` | Safe instance label returned by the application. |
| `owner_passphrase` | Existing Digger owner/passphrase compatibility secret. |
| `api_token` | Static bearer token for MCP/API clients. |
| `rate_limit` | `on` enables the existing passphrase throttling behavior. |
| `auto_login` | Enables ordinary HA ingress login for the Digger UI. |
| `public_url` | External origin advertised by OAuth metadata; blank derives it from the request. |
| `pb_auto_login` | Permits the admin-token relay, subject to every check below. |
| `pb_admin_ha_user_ids` | Comma-separated HA user IDs allowed to obtain a PB superuser token. Empty denies everyone. |
| `pb_owner_email` | Email of the PocketBase owner-auth record created on first bootstrap. |
| `pb_superuser_email` | Email of the private PocketBase administrator created on first bootstrap. |
| `pb_superuser_password` | Optional initial PB admin password. If omitted, a random value is generated and persisted mode `0600`. Existing records are never silently reset. |

`panel_admin: true` only restricts the Home Assistant menu item. Superuser
auto-login additionally requires the actual Supervisor ingress peer, the
trusted ingress metadata and an explicit match in `pb_admin_ha_user_ids`.
Mapped-port callers—including valid normal Digger bearer tokens—cannot use that
shortcut. Ordinary PocketBase credential login remains available when it is
disabled or denied.

PocketBase's embedded admin SPA is build-time patched to use
`__dn_superuser_auth__` rather than its global `__pb_superuser_auth__` key. The
image build starts the patched binary and crawls the real served admin assets;
the build fails unless the new key is present and the old key is absent.

## Health and access

- Sidebar: **Digger Node Lance** (admin menu entry), through HA ingress.
- LAN/mesh API: port `8111`, protected by the configured Digger credentials.
- PocketBase admin: the Digger Access panel's **PocketBase admin →** action,
  proxied through the application under `/pb/`; port `8090` is not published.
- Health: `GET /health` remains public and must report `driver: "lancedb"`,
  `tools: 19`, and a non-null `embedder`.

Installation and any access to a live guest require a separate approval. This
source tree contains no install or deployment command.
