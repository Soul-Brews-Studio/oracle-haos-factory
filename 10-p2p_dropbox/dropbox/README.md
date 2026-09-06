# 🛰️ PhD Satellite Dropbox — WebRTC + HTTP

File dropbox for the PhD satellite data fleet.
Upload files via drag-and-drop or HTTP POST → stored on m5 disk.

## Quick Start

```bash
cd phd/dropbox
bun install
bun run dev
```

Server starts at `http://127.0.0.1:3847` — **loopback only by default** (#80).
`AUTH_KEY` must be set in `.env` or the server refuses to start (FAIL LOUD).

## Authentication (#80)

Every `/api/*` route and the `/ws` signaling endpoint require the shared `AUTH_KEY`
(the same key the web login uses):

- Programmatic: `Authorization: Bearer <AUTH_KEY>` header
- Browser-loaded URLs (download links, previews) and `/ws`: `?key=<AUTH_KEY>` query param

Requests with a missing/wrong key get `401` and an `AUTH_FAIL` access-log entry.

## Remote access

Standing rule: **Dropbox = P2P only** — no public HTTP exposure, no Cloudflare Tunnel.
For occasional remote admin, use an SSH tunnel:

```bash
ssh -L 3847:127.0.0.1:3847 m5
# then open http://localhost:3847
```

Binding beyond loopback is an explicit opt-in (`HOST=0.0.0.0`) and still auth-gated.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Web UI (drag-and-drop) |
| GET | `/api/files` | List uploaded files |
| POST | `/api/upload` | Upload file (multipart form, field: `file`) |
| GET | `/api/files/:name` | Download file |
| WS | `/ws` | WebRTC signaling endpoint |

## Upload via curl

```bash
curl -H "Authorization: Bearer $AUTH_KEY" -F "file=@my_satellite_data.nc" http://127.0.0.1:3847/api/upload
```

## WebSocket Signaling

Connect to `/ws` for WebRTC peer discovery:

```json
→ {"type": "identify", "name": "my-oracle"}
← {"type": "welcome", "id": "uuid", "peers": 3}
← {"type": "peer-joined", "id": "uuid", "total": 4}

→ {"type": "offer", "target": "peer-id", "sdp": "..."}
← {"type": "answer", "from": "peer-id", "sdp": "..."}
→ {"type": "ice-candidate", "target": "peer-id", "candidate": "..."}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3847 | Server port |
| `HOST` | 127.0.0.1 | Bind address (`0.0.0.0` = explicit opt-in to expose) |
| `AUTH_KEY` | — (required) | Shared key gating `/api/*` + `/ws`; server exits if unset |
| `UPLOAD_DIR` | ./uploads | Where files are stored |

## Architecture

```
[Browser / Oracle CLI]
    ↓ HTTP upload (any time)
    ↓ WebRTC P2P (when peers online)
    ↓
[Cloudflare Tunnel]
    ↓
[m5: Bun + Hono]
    ├── HTTP upload handler
    ├── WebSocket signaling
    └── Static file serving
    ↓
[m5 disk: 5.6 TB free]
```
