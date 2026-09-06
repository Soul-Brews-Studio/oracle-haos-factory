# Operating P2P Dropbox

See [README.md](README.md) for options, storage, security, CLI and local verification.
See [PROOF.md](PROOF.md) for historical local evidence and browser P2P/TURN gaps.

## Local add-on registration

After copying the add-on to `/addons/p2p_dropbox` on an authorized HAOS host,
**`ha store reload` is required to register a new local add-on**:

```sh
ha store reload
```

`ha addons reload` alone was insufficient on kvmlab1. Wait for store reload to
complete and confirm `local_p2p_dropbox` is listed before installation.

Deployment compatibility fixes mirrored in git:
- `build.yaml`: plain `amd64-base:3.22` / `aarch64-base:3.22` tags, no digest suffix.
- Dockerfile: plain-tag `BUILD_FROM` default; old digests are provenance comments.
- `config.yaml`: `auth_key: password?`, `turn_url: str?`, `turn_user: str?`,
  `turn_pass: password?` permit empty defaults in the Supervisor schema without
  relaxing startup authentication.

## Deployment status

On 2026-09-06 the lead reported `local_p2p_dropbox` v0.1.0 started on kvmlab1,
live ingress, correct 401/200 authentication, and m5 HTTP (1.5 MB) plus CLI
WebRTC (2.5 MB) transfers with matching SHA-256 at both ends and ledger written.
This is lead-reported evidence, not an independent on-box rerun by this agent.
Browser WebRTC and optional TURN are not established by the CLI transfer proof.

Do not start with a blank `auth_key`: the container deliberately refuses to run.
Nat sets it in Supervisor options; never commit a real key or TURN credential.
The branch itself does not authorize additional deployment or credential changes.

## Ingress auto-login (0.1.1)

Defaults: `auto_login: true`, `auto_login_ha_admins: true`,
`auto_login_ha_user_ids: ""` (comma-separated IDs). Existing missing fields use
these defaults without changing the deployment key. Restart to apply options.

Only the real Supervisor TCP peer can bootstrap a session. Admins are verified
through HA Core (requires `homeassistant_api: true`); `panel_admin` alone is not
a server-side authorization check. Explicit allowlisted IDs also work. A failed
Core lookup denies admin auto-login; it never grants everyone access. Results
cache at most 60 seconds. See README for the token scopes and trust boundary.

The sidebar needs no master-key entry for authorized users. Direct port access
still uses the key form. A denied HA user sees their ID and a copy button; add
that exact ID to the allowlist if intended, or use manual-key fallback. Browser
sessions are memory-only, five-minute HMAC tokens—not raw auth/Supervisor keys.

After shipping an update, run `ha store reload`, then
`ha addons update local_p2p_dropbox` (or rebuild for the same version), and
`ha addons restart local_p2p_dropbox`. Do not replace `/data/options.json` or
`/share/p2p`. GET `/addons/local_p2p_dropbox/options` returned 405 on this
Supervisor; read `.data.options` from GET `/addons/local_p2p_dropbox/info` instead,
keeping output private. Never print the options/key in deployment logs.

### Exact shipping/update sequence used for 0.1.1

From the factory worktree (after commit/push), only tracked add-on source is sent:

```sh
git archive HEAD:10-p2p_dropbox | ssh kvmlab1.oracle.netbird '
  set -eu
  umask 077
  D=$(mktemp -d /tmp/p2p-source.XXXXXX)
  tar -xf - -C "$D"
  rsync -a --delete "$D/" /addons/p2p_dropbox/
  ha store reload
  ha addons update local_p2p_dropbox
  ha addons restart local_p2p_dropbox
'
```

`--delete` is confined to this managed source directory, never `/share` or `/data`.
Take a private source/options/file-hash snapshot first, as done for this delivery.
For a same-version image change use `ha addons rebuild local_p2p_dropbox` instead
of update. Avoid printing unfiltered `ha addons info` output: it contains options.

The 0.1.1 deployment preserved every pre-existing option. All nine original data
files retain their hashes; the original ledger bytes remain an exact prefix.
A concurrent lab03 transfer added a tenth data file and 302 ledger bytes during
the update, so the share now has **11 entries**, not the initial 10. Nothing was
removed to force the old count. See `evidence/autologin/deployment.txt` for outputs
and the explicit real-HA-browser validation gap.

## Join from a new machine

Prerequisites: Bun 1.3.14, access to the private factory branch, and the same
NetBird VPN as kvmlab1. The VPN name is not a public sharing URL.
Obtain the existing key privately from Nat; do not paste it into chat, a gist,
a URL, shell history or command arguments. Never choose/reset the deployment key.

```bash
gh repo clone Soul-Brews-Studio/oracle-haos-factory -- \
  --branch lab/02-p2p-dropbox-kvmlab1 --single-branch
cd oracle-haos-factory/10-p2p_dropbox/dropbox
bun install --frozen-lockfile
export SIGNAL_URL=ws://kvmlab1.oracle.netbird:3847/ws
export ROOM=default
read -r -s -p 'Existing auth key: ' AUTH_KEY; echo
export AUTH_KEY
# A lister is itself a connected peer; don't reuse a running receiver's name.
PEER_NAME="$(hostname -s)-list-$$" bun send.ts --list
printf 'join recipe fixture\n' > join-fixture.txt
PEER_NAME="$(hostname -s)-send-$$" bun send.ts --to p2p-dropbox join-fixture.txt
# HTTP is independent of ROOM and works if WebRTC ICE cannot connect.
bun upload.ts --url http://kvmlab1.oracle.netbird:3847 join-fixture.txt
shasum -a 256 join-fixture.txt
# Download the saved name from the listing (new fixture names should be unique).
# The key stays in Bun's environment, not curl arguments or URL.
bun -e '
const base="http://kvmlab1.oracle.netbird:3847";
const headers={Authorization:`Bearer ${process.env.AUTH_KEY}`};
const listing=await (await fetch(base+"/api/files",{headers})).json();
const file=listing.files.find(f=>f.name.endsWith("join-fixture.txt"));
if(!file)throw Error("destination missing");
const r=await fetch(base+"/api/files/"+encodeURIComponent(file.name)+"?date="+encodeURIComponent(file.date),{headers});
if(!r.ok)throw Error("download failed");
const hash=b=>new Bun.CryptoHasher("sha256").update(b).digest("hex");
const source=hash(await Bun.file("join-fixture.txt").arrayBuffer());
const destination=hash(await r.arrayBuffer());
console.log({source,destination,result:source===destination?"MATCH":"MISMATCH"});
if(source!==destination)process.exit(1);
'
unset AUTH_KEY
```

Optional laptop receiver: in another terminal provision the same key privately,
set the same SIGNAL_URL/ROOM, then run:

```bash
PEER_NAME="$(hostname -s)-recv-$$" SAVE_DIR="$HOME/Downloads/p2p-recipe" bun receiver.ts
```

Use that **exact printed receiver name** as `--to` from a different sender
identity. There is no central registration step: WebSocket upgrade authenticates,
`identify` claims the name, `welcome` supplies a connection ID, `list-peers` discovers
names. Welcome is a connection acknowledgement, not proof that identify succeeded.
An ID-TAKEN error means pick a distinct name; do not evict the incumbent.

The maintained local MAW lab03 v1.1.0 already points at kvmlab1; old docs claiming
its defaults still use external signaling are stale. Its bundled transport does
not yet support ROOM overrides; use the vendored CLI above for named rooms.
A TCP SSH tunnel carries HTTP/signaling only, not WebRTC UDP. The SSH add-on's
127.0.0.1 is not the HA host; do not use the inferred localhost tunnel recipe.
Use direct VPN access here; no host networking, public exposure or new UDP ports.

TURN: none in the fleet today; add a coturn add-on on kvmlab1 if relay is ever needed.
TURN remains unset, generic and optional. Keep batches below the known roughly
500-file reliability limit; this change does not fix bulk transfer behavior.
