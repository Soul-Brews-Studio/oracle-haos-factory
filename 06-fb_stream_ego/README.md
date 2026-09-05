# 06 — FB Stream Ego

Read-only Home Assistant add-on that mirrors the Messenger capture kept by the
`fb-stream-ego` lab on m5 (a LanceDB store fed by a Chrome extension inside ego lite).

```text
m5: ego lite + extension -> ws hub -> fb-stream-ego.lancedb -> exporter.py (127.0.0.1:8796)
        |  launchd: ssh -R 127.0.0.1:18794 kvmlab1 + ncat relay on 172.30.32.1:18795
        v
kvmlab1: this add-on polls http://a0d7b954-ssh:18795/api/snapshot every refresh_seconds
        -> Ingress UI (admin only, message text)  ·  :8105 /api/health + counts (no text)
```

Options: `exporter_url` (str), `refresh_seconds` (int), `exporter_token` (password, optional; the relay answers 401 without it). Both reach the process through
`config.yaml` -> `run.sh` -> `server.ts`; `server.test.ts` locks the routes:
health identity/version/freshness, 503 on missing or stale data, text only with the
`X-Ingress-Path` header Home Assistant adds, 405 for write methods, 404 otherwise.

The exporter, its tests, the launchd agents and the deploy/verify recipes live in the
lab: `ψ/lab/03-fb-stream-ego/justfile` (`exporter-deploy`, `haos-deploy`, `verify`).
