# Local proof — P2P Dropbox

## Current follow-up: 0.1.1 auto-login deployment

Implementation `6b7dfd41fd1d65f9581a3002814c695838151850` was pushed, then deployed
with explicit lead approval to only `local_p2p_dropbox` on kvmlab1. Fresh local
48-test / dual-arch build / CLI hash / browser-harness evidence is in
[evidence/autologin](evidence/autologin/README.md). Actual update/restart, state,
auth gates, preserved options and file-hash results are recorded in
[deployment.txt](evidence/autologin/deployment.txt). All original data remains;
a concurrent lab03 transfer accounts for the count rising from 10 to 11 entries.

The real HA browser recheck is a stated gap: the user took browser control, and
SSH/Core proxy ingress-session creation was denied. No protection mode, unrelated
add-on, deployment key or existing options were changed to work around it.
The earlier stop-before-install statements below describe the original phase,
not the later explicitly authorized deployment.

## Follow-up: Supervisor-compatible image tags (2026-09-06)

After the lead reported Supervisor falling back to `base:latest`, build.yaml and
Dockerfile references were changed to plain version tags. Previous digests remain
as provenance comments, not enforced pins. Docker Hub is still needed for the Bun
stage unless cached. No on-box changes were made by this follow-up.

Fresh local builds and host-mode `verify.sh` runs passed for both architectures:
[arm64 build](evidence/plain-tags/build-arm64.log),
[amd64 build](evidence/plain-tags/build-amd64.log),
[arm64 exact verification](evidence/plain-tags/verify-arm64.txt),
[amd64 exact verification](evidence/plain-tags/verify-amd64.txt).
Plain tags resolved to the previous digests and layers were cached; these were not
cache-free builds. amd64 ran under emulation on the same Colima arm64 host.
Both P2P and HTTP source/destination hashes match, empty auth fails startup,
unauthenticated HTTP/WS are rejected, size limits hold and both s6 services run.
[Regression tests](evidence/plain-tags/tests.log): 31 pass, 0 fail, 117 assertions.
TypeScript, build.yaml tag checks and `git diff --check` passed.

Commands (from the add-on directory, for each `arch=arm64/amd64`, with
`ha_arch=aarch64/amd64` respectively):

```sh
docker build --platform "linux/$arch" --build-arg BUILD_ARCH="$ha_arch" \
  --build-arg BUILD_FROM="ghcr.io/home-assistant/$ha_arch-base:3.22" \
  -t "p2p-dropbox:$arch" --progress=plain .
IMAGE="p2p-dropbox:$arch" PROOF_DIR="$PWD/proof/plain-tags-$arch" ./verify.sh
```

This does not prove Supervisor build-config acceptance; the lead is testing the
on-box copy separately. The original proof and its browser/HA/TURN gaps follow.

## Original local proof

**DONE for the requested local build/test phase. STOP before Supervisor install.**

- Branch: `lab/02-p2p-dropbox-kvmlab1` in `Soul-Brews-Studio/oracle-haos-factory`.
- Implementation: `9302579c043fbbbf103cb85d80592c977010e8a5`.
- Base: `2521e42` (factory main was read-only; new files only in `10-p2p_dropbox/`).
- Worktree: `/Users/beta/.local/state/incubate/worktrees/Soul-Brews-Studio/oracle-haos-factory/02-p2p-dropbox-kvmlab1`.
- Run date: 2026-09-06, Mac arm64 host, Colima Docker linux/arm64; amd64 image
  executed under emulation. No image push, Supervisor install, or kvmlab1 write.
- Runtime source equality checked: both built images match all 16 runtime TS/static
  files in the worktree. Immutable image config IDs are in [images.json](evidence/images.json).

## Validation summary

| Gate | Result | Evidence |
|---|---|---|
| Docker linux/arm64 + linux/amd64 builds | PASS, pinned Bun 1.3.14 and HA base digests | [arm64](evidence/build-arm64.log), [amd64](evidence/build-amd64.log) |
| Bun regressions | 30 pass, 0 fail, 108 assertions across 7 files | [tests](evidence/tests.log) |
| Add-on/backend TypeScript | `tsc --noEmit`, exit 0 | add-on tsconfig includes options, health, proxy, backend and tests |
| Frontend TypeScript + Vite | PASS, final bundle `index-D-XJSccH.js` | [build](evidence/web-build.log) |
| Frontend ESLint | PASS, exit 0 | [lint](evidence/web-lint.log) |
| ShellCheck | all launch, s6 and verify scripts, exit 0 | `shellcheck run.sh verify.sh rootfs/etc/cont-init.d/* rootfs/etc/services.d/*/run` |
| YAML syntax | config.yaml and build.yaml PASS | Ruby YAML parser |
| Host CLI → both add-on architectures | P2P ACK + both-side SHA match | exact output below |
| Independent bridge peer → both architectures | P2P ACK + both-side SHA match | exact output below |
| Host upload.ts → both architectures | saved HTTP file SHA match | exact output below |
| Empty auth and unauthenticated requests | container exits; HTTP/WS 401 | exact output below |
| Size bounds/concurrency | HTTP size rejection, 32 MiB ceiling + 429 regression; P2P overflow/sensitive rejection tests | tests and verify output |
| Ingress browser login/drop/logout | PASS via real Chromium + local prefix-stripping proxy, HTTP fallback SHA match | [browser result](evidence/browser-result.txt), [snapshot](evidence/browser.txt), [screenshot](evidence/browser.png) |
| Code/security review | approved after all 3 identified issues fixed | review notes below |
| Scope/secret checks | only new directory, no demo/master credentials or worker/turn/node_modules copied | staged diff check and source scan |

## Exact verify.sh output — host CLI into add-on

Fixture P2P file: 196731 deterministic bytes (multiple 64 KiB chunks).
HTTP fixture: `HTTP fixture: p2p_dropbox\n`. Each run uses a fresh random disposable
fixture auth key, never a deployment key. STUN is empty and TURN is empty for these
CLI tests. Only an ephemeral loopback TCP mapping of the add-on's 3847 is used;
no UDP ports or host networking are enabled.

Commands:

```sh
IMAGE=p2p-dropbox:arm64 PROOF_DIR="$PWD/proof/verify-arm64" ./verify.sh
IMAGE=p2p-dropbox:amd64 PROOF_DIR="$PWD/proof/verify-amd64" ./verify.sh
```

```text
IMAGE p2p-dropbox:arm64
STARTUP empty auth_key rejected
AUTH missing key: HTTP 401; WS 401
P2P mode=host source_sha256=a199f8633e990db39f94e1ec8384b241557e2b0edf325786e13ab31be4fa17ed receiver_sha256=a199f8633e990db39f94e1ec8384b241557e2b0edf325786e13ab31be4fa17ed MATCH
HTTP source_sha256=7534025daf463231f6051daa42c98a68e5ccac31ae13f81cf5442360f3f16e30 receiver_sha256=7534025daf463231f6051daa42c98a68e5ccac31ae13f81cf5442360f3f16e30 MATCH
LIMIT HTTP oversized upload rejected
S6 server=up receiver=up
PASS local verify; no Supervisor install; deployment auth_key unset
```

```text
IMAGE p2p-dropbox:amd64
STARTUP empty auth_key rejected
AUTH missing key: HTTP 401; WS 401
P2P mode=host source_sha256=a199f8633e990db39f94e1ec8384b241557e2b0edf325786e13ab31be4fa17ed receiver_sha256=a199f8633e990db39f94e1ec8384b241557e2b0edf325786e13ab31be4fa17ed MATCH
HTTP source_sha256=7534025daf463231f6051daa42c98a68e5ccac31ae13f81cf5442360f3f16e30 receiver_sha256=7534025daf463231f6051daa42c98a68e5ccac31ae13f81cf5442360f3f16e30 MATCH
LIMIT HTTP oversized upload rejected
S6 server=up receiver=up
PASS local verify; no Supervisor install; deployment auth_key unset
```

## Exact additional Docker bridge output

Here `send.ts` runs in a **different container with its own private IP**, not by
`docker exec` inside the receiver. This is an explicit extra topology, not a hidden
fallback. Commands set `PEER_MODE=bridge` and the corresponding `IMAGE`.

```text
IMAGE p2p-dropbox:arm64
STARTUP empty auth_key rejected
AUTH missing key: HTTP 401; WS 401
P2P mode=bridge source_sha256=a199f8633e990db39f94e1ec8384b241557e2b0edf325786e13ab31be4fa17ed receiver_sha256=a199f8633e990db39f94e1ec8384b241557e2b0edf325786e13ab31be4fa17ed MATCH
HTTP source_sha256=7534025daf463231f6051daa42c98a68e5ccac31ae13f81cf5442360f3f16e30 receiver_sha256=7534025daf463231f6051daa42c98a68e5ccac31ae13f81cf5442360f3f16e30 MATCH
LIMIT HTTP oversized upload rejected
S6 server=up receiver=up
PASS local verify; no Supervisor install; deployment auth_key unset
```

```text
IMAGE p2p-dropbox:amd64
STARTUP empty auth_key rejected
AUTH missing key: HTTP 401; WS 401
P2P mode=bridge source_sha256=a199f8633e990db39f94e1ec8384b241557e2b0edf325786e13ab31be4fa17ed receiver_sha256=a199f8633e990db39f94e1ec8384b241557e2b0edf325786e13ab31be4fa17ed MATCH
HTTP source_sha256=7534025daf463231f6051daa42c98a68e5ccac31ae13f81cf5442360f3f16e30 receiver_sha256=7534025daf463231f6051daa42c98a68e5ccac31ae13f81cf5442360f3f16e30 MATCH
LIMIT HTTP oversized upload rejected
S6 server=up receiver=up
PASS local verify; no Supervisor install; deployment auth_key unset
```

## Browser / ingress evidence

Real Chromium via ego-browser visited a local proxy at
`/api/hassio_ingress/local-proof/`. Proxy behavior matches the relevant HA URL
shape: strip that prefix upstream and forward `X-Ingress-Path`; local WS relay and
HTTP paths share the same listener. This is **not** a real Supervisor installation.

- Wrong-key login rejected; disposable configured-key login accepted.
- Authenticated local signaling discovers the exact `p2p-dropbox` receiver.
- Assets/config/files/upload HTTP URLs stay same-origin and ingress-prefixed; no
  master key in those URLs, no external HTTP resources.
- A browser File/DataTransfer drag-drop of `browser-fixture.txt` uses the visible
  HTTP fallback and lands in `/share/p2p/YYYY-MM-DD/` with this hash on both sides:
  `7df65a0f80f21f8bfcd3da651de696b62fb0e93cc5efd804ffb2f503d3e3ed07`.
- Logout clears only the session auth key; a PocketBase localStorage sentinel stays
  unchanged. Runtime fixture options, browser task space, containers and proxy were
  removed after proof. No deployment credential was chosen.

**Explicit gap:** browser P2P did not establish ICE on this Mac/Colima topology,
with either empty STUN or the normal STUN defaults. After the signaling fix its
remote SDP contains gathered candidates; browser stats show ICE failure before
DTLS, with mDNS-host/srflx versus container-host/srflx candidates. External TURN was
not supplied or tested. Do not infer that browser P2P or the eventual HA/LAN/NetBird
path is verified from the successful CLI and browser HTTP tests.

## Review fixes and simplifications

A separate read-only reviewer found and rechecked three blockers:

1. **Early ICE loss / candidate-free SDP:** werift can emit candidates before
   `setLocalDescription` returns. Sending the original `createOffer/createAnswer`
   draft loses gathered candidates. CLI and receiver now send post-gather
   `pc.localDescription`; browser queues early incoming ICE and sends its offer
   before outgoing ICE. Real-werift and fake-browser regressions cover both paths.
   The initial host→Docker CLI timeout disappeared after this fix: final tests pass
   on both architectures. It was not valid evidence of an unavoidable NAT failure.
2. **Browser receiver ACK mismatch:** browser is deliberately sender-only and the
   visible target list is limited to the exact configured receiver. Unsupported
   browser-as-target receiving and arbitrary-peer auto-routing were removed.
3. **Buffered HTTP OOM risk:** HTTP is limited to min(configured maximum, 32 MiB),
   one active upload, with a Bun transport body ceiling; the browser explains the
   cap. P2P keeps the configurable maximum. No new multipart package or bespoke
   streaming parser was added.

Other preserved/fixed safety: timing-safe key auth; master keys never embedded into
watch/browser pages; HMAC scope separation; no watch viewer or open-mode bypass;
channel-isolated binary framing; sensitive names/overflow rejected; partial files
hidden; publication and ledger precede success ACK. SHA checks are independent
verification, not a new on-wire checksum protocol.

## Remaining boundary / handoff

- **No Supervisor install, start, update or options changes on kvmlab1.** Actual HA
  sidebar, browser P2P, LAN/NetBird and optional TURN validation remain next-stage
  gates. Nat chooses the key and separately authorizes installation.
- Known upstream >500-file batch reliability ceiling remains documented, not fixed.
- Only ingress + 3847/tcp is configured; no additional inbound UDP range was opened.
- HTTP multipart fallback is capped at 32 MiB; larger files need a working P2P path.
- No all-power-loss durability claim: ACK follows OS stream completion and ledger
  append, not fsync. Monitor share capacity and unbounded logs; share backup is
  separate from add-on `/data` backup.

Exact options JSON is in [README.md](README.md#options-nat-must-set). The committed
`auth_key` default remains empty and fails loudly until Nat supplies it.

Signed [37-6sep-sun2026:02-p2p-dropbox-kvmlab1]
