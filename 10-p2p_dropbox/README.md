# P2P Dropbox — local HAOS add-on

Self-contained Bun 1.3.14 + Hono HTTP/WS server, werift receiver and vendored
React UI. Two s6 services, one published TCP port (3847), no Cloudflare runtime.
New directory `10-p2p_dropbox`, slug `p2p_dropbox`; existing add-ons are untouched.

**Current status (2026-09-06): v0.1.1 deployed and started on kvmlab1.** Existing
options/key and original shared files were preserved. Live direct API gates and
Core admin lookup passed; local fake-ingress browser auto-connect passed. Nat's
actual HA browser session is not yet rechecked (browser control paused).
See [deployment evidence](evidence/autologin/deployment.txt).

**Earlier transfer proof (lead-reported, 2026-09-06): installed on kvmlab1 as
`local_p2p_dropbox` v0.1.0 and started.** The lead verified live ingress, the
401/200 auth gate, and real m5 HTTP (1.5 MB) and CLI WebRTC (2.5 MB) transfers
with matching SHA-256 at both ends and a receiver ledger entry. These deployment
results were reported by the lead, not independently rerun by this branch agent.
Nat manages the deployment auth key through add-on options; never commit it.
See [PROOF.md](PROOF.md) for historical local evidence and browser P2P/TURN gaps.

## Register a new local add-on

After copying `10-p2p_dropbox/` to `/addons/p2p_dropbox` on the authorized HAOS
host, **`ha store reload` is required to register a new local add-on**:

```sh
ha store reload
```

`ha addons reload` alone did not register this app on kvmlab1. Wait for the store
reload to finish and confirm `local_p2p_dropbox` is listed before installing.
Keep `build.yaml` image references as plain per-architecture version tags and
the Dockerfile `BUILD_FROM` default as a plain tag. Keep the empty-default auth
and TURN schema fields optional (`password?` / `str?`); startup still rejects an
empty auth key. See [DOCS.md](DOCS.md) for operational notes.

## Options Nat must set

Replace the placeholder locally in Supervisor, never in git:

```json
{
  "auth_key": "<NAT_SETS_A_STRONG_UNIQUE_KEY>",
  "auto_login": true,
  "auto_login_ha_admins": true,
  "auto_login_ha_user_ids": "",
  "save_dir": "/share/p2p",
  "stun_servers": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
  "max_file_mb": 1024,
  "turn_url": "",
  "turn_user": "",
  "turn_pass": ""
}
```

`auth_key` and `turn_pass` use HA password schemas. Empty auth is the shipped
configuration and intentionally stops the entire container before either service
starts. Options load on startup; restart after changing them. `save_dir` must be a
normalized non-symlink subdirectory of `/share`. Limits are per file (1–10240 MiB),
not a disk quota or an aggregate concurrent-transfer limit; size conservatively.
HTTP multipart fallback has an additional **32 MiB ceiling** and permits one active
HTTP upload at a time (429 when busy), because the existing multipart parser buffers
in memory. Larger files within `max_file_mb` require a working P2P connection. The
browser receives `http_max_file_mb` and explains this fallback limit.

TURN is opt-in: configure all three TURN fields or none. The fields map to the
existing `TURN_URLS`, `TURN_USER`, `TURN_CRED` process environment; no TURN server
is installed and no TURN ports are published. STUN may be an empty list for an
isolated, directly routable LAN. Runtime ICE configuration is returned only to
key-authenticated browsers. Authorized clients necessarily receive TURN credentials;
use credentials suitable for those clients. No demo coturn credentials are shipped.

## Storage and services

- `/share/p2p`: completed P2P/HTTP files, date directories, `index.jsonl` receiver
  ledger. Other add-ons/Samba can read the Supervisor share. Share backup coverage
  is managed separately from this add-on; do not assume it is in the add-on backup.
- `/data/logs`: persisted HTTP access and receiver logs. HA automatically provides
  the private `/data` volume. Logs have no retention cap yet; monitor disk usage.
- `/data/options.json`: Supervisor-owned input; secrets are copied into mode-0600
  files in mode-0700 `/run/p2p/env`, never logged or baked into the image.
- s6 `p2p-server`: serves UI, authenticated API, embedded `/ws` signaling.
- s6 `p2p-receiver`: identifies as `p2p-dropbox`, writes to the configured directory,
  reconnects on signaling loss and is restarted by s6 after process failure.
- Docker healthcheck authenticates `GET /api/files`; `/health` is a deliberately
  public liveness/readiness endpoint with no file or peer data.

P2P control protocol stays `files` (ordered DataChannel), 64 KiB binary chunks,
`file-start` → bytes → `file-end` → `file-received {ok,size}`. Success follows
stream flush, atomic publication and ledger append, then ACK. This is an OS write
completion guarantee, not an fsync/power-loss durability guarantee. Sender waits
30 seconds for ACK; the send stall deadline is 60 seconds. Transport failures exit
2, bugs/configuration failures exit 1. Concurrent channels cannot mix their bytes;
overlapping files on a single channel are rejected because chunks have no file ID.

## Ingress and trust boundary

The sidebar auto-connects by default for a verified HA admin (or explicitly
allowlisted HA user). Direct `:3847` access retains the key form. Denied ingress
users see **Not allowed**, their HA user ID and a copy button, plus manual-key
fallback. Set `auto_login: false` to require the key everywhere;
`auto_login_ha_admins: false` restricts auto-login to the comma-separated
`auto_login_ha_user_ids` list. Existing options remain valid: omitted new fields
use `true`, `true`, and `""` respectively; the existing auth key is not changed.

Trust requires the actual Supervisor socket peer (`172.30.32.2`), a valid ingress
path and HA user ID. Forwarded IP/admin headers cannot grant access. `panel_admin`
only gates the sidebar menu, so admin membership is checked server-side through
HA Core `config/auth/list` (active owner or `system-admin` group), not inferred
from seeing the panel. This requires **`homeassistant_api: true`**, which grants
Core API access to the add-on; `hassio_api` remains false. The implementation only
reads the user directory. Lookup failure denies the admin path; explicit ID
allowlisting and manual-key access remain available. Admin results cache for at
most 60 seconds; failed refresh discards prior grants.

The bootstrap returns a five-minute HMAC bearer bound to this app, HA user ID,
ingress path and API scope. It lives **only in SPA memory** (no auth cookie or
browser storage); all its API and derived WS tokens require the same trusted
ingress identity. It permits config/files/preview/upload, not logs or arbitrary
API routes. The master key and Supervisor token are never included in bootstrap
responses. Tokens renew before expiry; failures return to login, and Disconnect
stays disconnected until explicit HA reconnect or page reload. Manual key entry
retains the existing tab-session behavior.

The page uses relative
URLs under the HA ingress prefix, without external fonts or a remote signal server.
The browser stores its key only in path-namespaced sessionStorage; logout removes
that key without touching PocketBase/other add-on storage. Downloads/previews use
authenticated fetch/blob URLs. Signaling uses a five-minute, audience/scope-bound
HMAC token, refreshed on reconnect; the master key is never baked into HTML or
placed in browser URLs.

`/api/*` requires the master key or a valid route-scoped ingress API session; a
scoped signaling token cannot read or write files. `/ws` accepts the scoped signaling token or CLI master-key auth.
Token scope is not silently widened: **watch tokens are rejected**, and `/watch/*`
is explicitly 404. Terminal viewing, LIFF, D1 event logging, sharing, open/lock auth
bypass and the old Worker's admin routes are not shipped. Existing remote watch
pages/tokens and the Cloudflare deployment remain untouched.

The requested direct 3847/tcp mapping is also reachable outside HA ingress. Unlike
an ingress-only service, direct API/WS requests still require key-based authentication; an
`X-Ingress-Path` header never grants access. Keep this port on trusted LAN/NetBird,
never expose it publicly. HTTP/WS on the direct port has no application TLS; use
trusted mesh transport or an SSH tunnel. WebRTC encrypts file DataChannels.

Signaling state is in-memory with room isolation (`?room=`, default `dropbox`).
Server-issued IDs, offer/answer/ICE relay, 30-second JSON ping/pong and >60-second
zombie expiry replace the Worker's P2P semantics without porting its Durable Object.
A restart drops peer IDs; clients re-identify and browsers reselect the receiver.

## CLI

From this vendored `dropbox/` directory, install the pinned lockfile once:

```sh
bun install --frozen-lockfile
# AUTH_KEY must already be set securely in your shell, not pasted into git.
SIGNAL_URL=ws://kvmlab1.oracle.netbird:3847/ws bun send.ts --to p2p-dropbox file.bin
bun upload.ts --url http://kvmlab1.oracle.netbird:3847 file.bin
```

These are **post-install instructions, not proof that installation occurred**.
Optional CLI ICE env: `STUN_SERVERS` JSON array, `TURN_URLS`, `TURN_USER`, `TURN_CRED`.
Do not put a credential in SIGNAL_URL. Legacy CLI `?key=` WebSocket authentication
is retained for interoperability; it is not logged by this server. Do not record
full request URLs in an upstream proxy.

## Local build and proof

Requires Docker (arm64 emulation if building on amd64 or vice versa), Bun 1.3.14,
curl, shasum, and Bash. No Supervisor, SSH, deployment secrets or registry push.

```sh
# From 10-p2p_dropbox/
docker build --platform linux/amd64 --build-arg BUILD_ARCH=amd64 -t p2p-dropbox:amd64 .
docker build --platform linux/arm64 --build-arg BUILD_ARCH=aarch64 \
  --build-arg BUILD_FROM=ghcr.io/home-assistant/aarch64-base:3.22 \
  -t p2p-dropbox:arm64 .
(cd dropbox && bun install --frozen-lockfile)
bun test
IMAGE=p2p-dropbox:arm64 ./verify.sh
IMAGE=p2p-dropbox:amd64 ./verify.sh
# Optional isolated Docker-bridge peer test:
PEER_MODE=bridge IMAGE=p2p-dropbox:arm64 ./verify.sh
```

Build references use plain version tags for Supervisor compatibility; previous
digests remain in comments for provenance, not enforcement. Building requires
GHCR and Docker Hub access unless the required images are cached. The Bun binary
version is checked against 1.3.14 during the build.

`verify.sh` generates a disposable random fixture key, starts an add-on container,
asserts empty-key startup rejection and unauthenticated HTTP/WS rejection, runs
`send.ts` and `upload.ts` **from the host into the add-on container**, compares SHA-256 with the saved files, checks the HTTP
size limit and both s6 services, then removes its containers/network/temp key.
`PROOF_DIR` retains safe logs; default is a fresh temporary directory.
No UDP host port, host networking, CF Worker or external TURN is used.
`PEER_MODE=bridge` instead uses a separate CLI peer container/private IP; this is an
additional isolated topology test, never a silent fallback for a failed host test.

Build UI reproducibly (existing vendored dependencies only):
`cd dropbox/web && bun install --frozen-lockfile && bun run build && bun run lint`.
Backend typecheck uses the existing TypeScript toolchain (`tsc --noEmit` from the add-on directory).
Shell static analysis: `shellcheck run.sh verify.sh rootfs/etc/cont-init.d/* rootfs/etc/services.d/*/run`.
A loopback-only ingress test proxy lives at `tests/ingress-proxy.ts`.

## Known limits / remaining install gate

- **No kvmlab1 installation or real HA sidebar validation in this lab.** Nat's key
  and explicit install authorization are still required for that next stage.
- Local host-to-Docker and bridge P2P are not proof of the real kvmlab1 LAN/NetBird
  topology or TURN. An initial host timeout exposed an early-ICE/SDP-ordering bug;
  after the fix, the Mac-host → Colima add-on transfer succeeds with STUN disabled.
  See PROOF.md for real Chromium ingress transfer evidence and remaining gaps.
- Symmetric/double NAT can require external TURN. Only TCP 3847 is published; no
  implicit UDP range or host networking was added. HTTP fallback works when ICE
  cannot connect. Do not open extra ports without Nat's decision.
- Existing reliability limit: batches above roughly **500 files** / sustained bulk
  transfers may stall. Keep batches small; use SSH/rsync for bulk. Not fixed here.
- UI/senders retain shared-key peer trust, not individual user permissions. Anyone
  with the master key can upload/download, list peers and impersonate a peer name.
  The browser is sender-only and exposes only the exact configured receiver name.
  Duplicate receiver names are not auto-selected; the key is not an identity system.
- Atomic `.part` staging prevents partial files being presented as complete. A hard
  kill/power loss can leave hidden `.part` files for manual recovery; no automatic
  deletion of user files or other add-on data is performed.

Upstream provenance and bounded vendor changes: [VENDORED.md](VENDORED.md).

## Auto-login references and proof

- [HA ingress identity headers](https://developers.home-assistant.io/docs/apps/security/#authenticating-a-user-when-using-ingress)
- [HA Core access from add-ons](https://developers.home-assistant.io/docs/apps/communication/#home-assistant-core)
- [Core admin-only user listing](https://github.com/home-assistant/core/blob/dev/homeassistant/components/config/auth.py)
- Local browser harness: `bun tests/autologin-harness.ts` (Ctrl-C cleans up). It uses
  fake ingress headers, fake Core users, disposable credentials and a loopback-only
  server. `INGRESS_TRUSTED_PEER` / `HA_CORE_WS_URL` are runtime-only test overrides,
  not Supervisor options; do not override them in deployment.
- Fresh dual-arch build, CLI hash and regression evidence: `evidence/autologin/`.
