# Vendored source

Source: `/opt/Code/github.com/laris-co/p2p-oracle/dropbox/` (read-only).
Repository: `laris-co/p2p-oracle`, commit
`c8e1d156f5942c79f24b5f0705284c7175ee3fa8`.

Core server, receiver, send/upload CLI, types, package/lockfile, README and web-dist
were copied. The existing web source/build lockfile was also copied so the ingress
adaptation is reproducible. Original README remains under `dropbox/README.md` as
historical provenance, **not the add-on operating instructions**.

No `worker/`, `turn/`, `.env`, demo credentials, private logs, uploads, node_modules
or external service deployment configuration was vendored. No source repo files
or deployed Cloudflare resources were modified. `oracle-relay` was found locally
and inspected, but its PeerJS protocol would require unnecessary client migration.

## Bounded local changes

- Server: local room-isolated relay extracted for deterministic tests; 30s ping /
  >60s expiry; scoped HMAC signal auth, authenticated ICE configuration, health;
  bounded request/preview I/O, no partial/symlink file exposure, nonoverwriting
  atomic HTTP writes, correct log reads and attachment download headers.
- Receiver/CLI: local defaults, runtime ICE env, fail-loud auth, encoded WS query,
  channel-owned binary framing, size/sensitive-file checks, atomic writes, clean
  failure ACKs, bounded connect/stall/ACK waits and service shutdown.
- Web: relative ingress paths, no worker calls/open-mode controls/fonts, validated
  session-scoped auth, signal-token reconnect refresh, configured ICE/receiver,
  acknowledged sends, HTTP fallback, authenticated blob preview/download URLs.
- Final review fixes: send post-gather werift SDP (not candidate-free draft), queue
  early browser ICE, sender-only browser/exact receiver UI, cap buffered HTTP to
  32 MiB with a single active upload while preserving configured P2P size limits.
- Removed unused Cloudflare `tunnel` npm script. Existing dependency versions are
  frozen by vendored lockfiles; no new application npm dependencies were added.
- HMAC watch hardening from upstream commit
  `549ca40cff4be76c01c8fe3757caacf59a29faa1` remains a boundary: no master key in
  viewer HTML, no scope widening. This add-on has no terminal/watch viewer or token
  issuer; watch-scope tokens fail WS auth and watch pages return 404.

Runtime Hono 4.12.27 and werift 0.23.0 resolve from the upstream Bun lock.
Bun 1.3.14 and HA Alpine 3.22 base images are tag+digest pinned in Docker/build files.

## Evidence references read

- Oracle lab 02 charter and lab 01 README/REVIEW; lab 01 `09-discord_pb` source.
- `laris-co/petkeeper-oracle/haos/petkeeper_pb/{config.yaml,run.sh}`.
- Oracle `ψ/memory/learnings/{phd-oracle-p2p,p2p-signaling-inventory}.md`.
- Oracle `ψ/learn/laris-co/p2p-oracle/2026-09-06/1055_` API-SURFACE,
  QUICK-REFERENCE and CODE-SNIPPETS documents (including warnings about demo creds).
- DustBoy-Phd handoff `2026-06-11_07-15_dropbox-p2p-gems-full-session.md` and local
  Worker signaling implementation for protocol comparison, not Worker vendoring.
- [HA configuration](https://developers.home-assistant.io/docs/apps/configuration/),
  [HA ingress](https://developers.home-assistant.io/docs/apps/presentation/#ingress),
  [s6 overlay](https://github.com/just-containers/s6-overlay#usage).

## Original core + built assets SHA-256 (before adaptation)

```text
a94a4429b893201e9df4fb09a8b6ee5ffe34da3e0bc49017341a01d665e878ce  dropbox/server.ts
27c57cf1d889490f8c790bfe1f8e316f633496edaac35fc71543e43058fdfa0f  dropbox/receiver.ts
e96166c788bc196b4ea30bae2c1b363439cedfdc689f42b3a1a1422a53e3a59e  dropbox/send.ts
e4f6ef570068595fc4e5b6af8fe23998df0db752c4851bd710242b24e4a4b9c2  dropbox/upload.ts
55adf2f1388c0b631391dd7b5a3c30b65fbfd8089759ce1bf92e38b41ec85b65  dropbox/types.ts
8ff77f52037f86d97108a0e7dd09ebdfca526d60a35caa5e1a5b88c1e35ffc7a  dropbox/README.md
2c9e0eafc96a102bcf63eb871c2ad0bb76bd7a3e9f4e7bcdf70ca80d635948a2  dropbox/package.json
1ae7a42a32688abdf2ce342030062405d013ab360eaff3dee3d58fee616c208e  dropbox/bun.lock
2826627ffcf7ebbca9f53fec6410c58209d8d94fff6936570e44c01a9081cac5  dropbox/tsconfig.json
2229adaae9620d1bec74e86b3d27841388e623f2917206004fcbcb2a15cc438a  dropbox/web-dist/assets/index-D2Gwx8Ju.js
879a49bad77d5b04cf787acf6ee744028216e0dfc414c5184bace6899aa43202  dropbox/web-dist/favicon.svg
ecfaf5b1871429a54227fb430a815edad8f3ca3e32b23df941767e392f4b8ab8  dropbox/web-dist/icon-192.svg
f6ab8e43d43eb6249e5ac41deb0bda5de0668cc8b40139ccac6dadc3680489a9  dropbox/web-dist/icon-512.svg
9717f386ccd27632fc2ecf4937588fa165cbe81685b85a47cf71ac4e4ca790f5  dropbox/web-dist/index.html
5b2326e5190de789f09e1a6266577ae127d974e16ba8fba63399187295a1dcc5  dropbox/web-dist/manifest.json
```
