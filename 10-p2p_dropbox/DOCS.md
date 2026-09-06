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
