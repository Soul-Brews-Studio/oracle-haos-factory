# LINE Lance Elysia gateway

Node 24 front controller for the local Python/LanceDB archive. Version 0.3.0 proxies the
read-only archive API, owns an encrypted SQLite bot registry, serves the built
React SPA, and publishes Scalar/OpenAPI at `/api/openapi` and
`/api/openapi/json`.

## Runtime

```sh
npm ci
npm run build
npm start
```

Environment variables:

- `ARCHIVE_ORIGIN` — Python archive origin (default `http://127.0.0.1:4133`)
- `CONTROL_DB` — registry SQLite file (default `/data/line-lance-control.sqlite`)
- `CONTROL_KEY` — generated 32-byte AES key (default `/data/line-lance-control.key`)
- `STATIC_DIR` — React `dist` directory (default `../frontend/dist` from the gateway)
- `HOST` / `PORT` — listener (defaults `0.0.0.0:4134`)

The database and key are forced to mode `0600`. Credential columns contain
only versioned AES-256-GCM envelopes. API responses expose `has_secret` and
`has_token`, never credential values.

Bot routes require non-empty Home Assistant `X-Ingress-Path` and
`X-Remote-User-Id` headers. Mutations additionally require
`X-Line-Lance-Intent: manage-bots`. There is intentionally no CORS middleware.

The archive boundary accepts only GET/HEAD. It forwards no request headers or
bodies; all archive write verbs are rejected locally with `405 Allow: GET`.
