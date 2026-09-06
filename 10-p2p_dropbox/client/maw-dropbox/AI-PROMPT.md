# Prompt: connect a new VPN machine to P2P Dropbox

Copy the prompt below to the AI on the new machine. Replace only the bracketed values. Transfer the auth key through a private secret channel, never inside the prompt.

---

You are configuring a client for our private P2P Dropbox on `kvmlab1`. Work autonomously, show exact commands and verification output, and stop before destructive or unrelated system changes.

## Fixed service facts

- Network: NetBird VPN is required.
- HTTP API: `http://kvmlab1.oracle.netbird:3847`
- WebSocket signaling: `ws://kvmlab1.oracle.netbird:3847/ws`
- Home Assistant UI: `http://kvmlab1.oracle.netbird/hassio/ingress/local_p2p_dropbox`
- Default receiver identity: `p2p-dropbox`
- Signaling room: `[ROOM, normally default]`
- This URL is a private service endpoint, not a public or per-file sharing link.
- Do not print, log, persist in source control, or append `AUTH_KEY` to any URL.
- Use a distinct `PEER_NAME` for every simultaneously connected sender/receiver process.
- TURN is optional and unset. TURN: none in the fleet today; add a coturn add-on on kvmlab1 if relay is ever needed.

## Goal

1. Confirm NetBird can resolve and reach `kvmlab1.oracle.netbird:3847`.
2. Obtain `AUTH_KEY` privately from the operator without echoing it.
3. Send `[ABSOLUTE_FILE_PATH]` to `[TARGET_PEER, normally p2p-dropbox]` using WebRTC.
4. If WebRTC cannot connect and the file is at most 32 MiB, use the explicit HTTP fallback.
5. Compare the local SHA-256 with the receiver-reported or downloaded file hash and report MATCH/MISMATCH.
6. Never change the server, Home Assistant, another add-on, firewall, VPN, or credentials.

## Preferred route when `maw dropbox` is installed

First inspect only public configuration (the command must redact credentials):

```bash
maw dropbox url
maw dropbox status
```

For the default room, send with:

```bash
maw dropbox send --to "[TARGET_PEER]" "[ABSOLUTE_FILE_PATH]"
```

HTTP fallback, only after reporting why WebRTC failed and only for files up to 32 MiB:

```bash
maw dropbox send --http "[ABSOLUTE_FILE_PATH]"
```

The installed maw v1.1.0 transport does not support named `ROOM`s. For any non-default room, use the vendored CLI route below instead of pretending maw used the requested room.

## Vendored CLI route (required for named rooms)

From a trusted checkout containing the add-on's vendored `dropbox/send.ts`, read the key silently for this shell only:

```bash
read -r -s -p 'P2P Dropbox auth key: ' AUTH_KEY; echo
export AUTH_KEY
export SIGNAL_URL='ws://kvmlab1.oracle.netbird:3847/ws'
export ROOM='[ROOM]'
export PEER_NAME='[UNIQUE_MACHINE_SENDER_NAME]'
bun ./send.ts --to '[TARGET_PEER]' '[ABSOLUTE_FILE_PATH]'
unset AUTH_KEY
```

Do not reuse the target receiver's identity as `PEER_NAME`. An `ID-TAKEN` response means another live peer already owns that name; choose a new, descriptive sender name and retry.

## Verification

Before sending:

```bash
sha256sum '[ABSOLUTE_FILE_PATH]' 2>/dev/null || shasum -a 256 '[ABSOLUTE_FILE_PATH]'
```

Report:

- selected transport (`WebRTC` or explicit `HTTP fallback`),
- room and sender/target peer names (never the auth key),
- byte count,
- local and receiver-side SHA-256,
- `MATCH` or `MISMATCH`,
- any connectivity error exactly as observed.

Do not claim success from a WebSocket connection alone. Success requires the transfer acknowledgement and matching file hash.

Known limit: batches larger than 500 files can be unreliable; split large batches.

---

The operator may safely share the two VPN service URLs and peer/room names. The operator must not put the auth key in a Gist or public prompt.
