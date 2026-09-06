# Changelog

## 0.1.1

- HA ingress auto-login with actual Core admin verification or explicit user IDs.
- Five-minute, user/path-bound HMAC API and signaling tokens; no master-key injection.
- Direct key-form fallback, denied-user identity/copy UI and fail-closed refresh.
- Preserve Supervisor-compatible plain image tags, optional credential schemas and store reload instructions.

## 0.1.0

- New local P2P Dropbox add-on with pinned multi-arch Bun and two s6 services.
- Embedded room signaling with heartbeat/zombie cleanup; no Cloudflare runtime.
- Authenticated ingress UI, scoped signaling tokens, CLI P2P and HTTP fallback.
- Bounded, channel-isolated atomic receiver writes and local SHA-256 verification.
- Stop-before-install lab delivery; optional TURN and live HA proof remain gated.
