# Digger Node

digger-node on your own disk. The same application that runs at
`digger-node.laris.workers.dev` on Cloudflare Workers + D1, storing to a SQLite
file under `/data` instead.

A Drupal-shaped content store: nodes, vocabularies, terms, and the join between
them. Trigram full-text search. 19 MCP tools. OAuth 2.1 for claude.ai and a
static bearer token for Claude Code.

## Configuration

| Option | Meaning |
|---|---|
| `instance_name` | Shown in the page header. Useful when you run more than one. |
| `owner_passphrase` | Unlocks the web UI and authorizes OAuth clients. **Empty ships open** — see below. |
| `api_token` | A static bearer token for API and MCP clients that read a config file. |
| `rate_limit` | `on` (default) throttles the passphrase endpoints: five attempts, then exponential backoff. Reasonable to set `off` on a private network. |

### Set a passphrase before you expose the port

With both `owner_passphrase` and `api_token` empty the node is **open** on port
8108, and the add-on log says so on every start. The sidebar is still protected —
ingress puts Home Assistant's own login in front of it — but the mapped port is
not, and the mapped port is the one that exists so MCP clients can reach it.

The passphrase has an 8-character minimum *when set through the app's own
settings page*. The add-on option has no such floor, because it is the recovery
path: it is accepted whatever its length, so a forgotten UI passphrase never
locks you out of your own corpus.

## Where the data lives

`/data/digger.db`. That path is deliberate: `/data` is the only add-on directory
Supervisor keeps across an update and the only one included in a Home Assistant
backup. Anything stored elsewhere is gone at the first update.

The corollary is worth stating plainly: **your corpus rides inside your Home
Assistant backups**, along with whatever passphrase is stored in it. Treat those
backups accordingly.

Migrations are applied on every start and are idempotent, so restarting the
add-on is a safe recovery step rather than a data-loss event.

## Search is text-only here

On Cloudflare the app embeds with Workers AI. That is a Cloudflare binding with
no local equivalent, so a self-hosted node runs **trigram full-text search only**
and `/health` reports `"embedder": null` rather than implying a vector index that
is not there.

## Reaching it

- **Sidebar** — through ingress, authenticated by Home Assistant.
- **Port 8108** — the web UI, the REST API, and `/mcp`. An MCP client cannot
  authenticate to an ingress URL, which is why this port exists at all. It is
  guarded by `owner_passphrase` / `api_token`, *not* by Home Assistant's session.
- `GET /health` needs no credentials and reports the driver, the tool count and
  which auth modes are active.

## Updating the application

The image fetches digger-node at a pinned commit (`DIGGER_NODE_REF` in the
Dockerfile), never a branch. A branch would let two builds of the same add-on
version contain different application code. Bump `DIGGER_NODE_REF` and the
add-on `version:` together — never one alone.
