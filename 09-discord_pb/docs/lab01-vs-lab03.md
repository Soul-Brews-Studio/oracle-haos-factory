# `lab/01-discord-pb-kvmlab1` vs `lab/03-discord-sidebar-kvmlab1`

Two branches of the same add-on, kept **separate on purpose** (Nat, 2026-09-07:
"we separate, do not merge"). Neither is merged into the other or into `main`.

| | `lab/01-discord-pb-kvmlab1` | `lab/03-discord-sidebar-kvmlab1` |
|---|---|---|
| Author | codex worker (incubated 2026-09-06 08:55, last commit 15:28) | Fable session in `7sep-mon2026-oracle/agents/codex` (2026-09-06 23:40 → 07 01:30) |
| Tip | `227b7ac` feat: add simple Discord room view | `2cbd07b` docs: live evidence (3 commits on top of `227b7ac`) |
| Add-on version | 0.1.10 | 0.2.1 |
| `config.yaml` | `homeassistant_api: false`, `url` → lab/01 | `homeassistant_api: true` (for the HA admin list), `url` → lab/03 |
| Worktree on m5 | `~/.local/state/incubate/worktrees/Soul-Brews-Studio/oracle-haos-factory/01-discord-pb-kvmlab1` (locked by the codex agent) | `…/03-discord-sidebar-kvmlab1` |
| On kvmlab1 | ran as `local_discord_pb` 0.1.10 until 2026-09-07 00:00 | runs as `local_discord_pb` 0.2.1 since 2026-09-07 00:30 |
| Common base | `227b7ac` — lab/03 contains every lab/01 commit; lab/01 has nothing lab/03 lacks (as of 2026-09-07 01:30) | |

## What lab/01 is

The whole add-on: PocketBase 0.29.3 with a namespaced admin SPA, `backfill.py`
(REST, high-water marks, 429 handling), `gateway.py` live feed, the declared
channel model (`dc_model.py`, `dc.config.yaml`), the operational `panel.html`
(archive, timeline, channel model, import), the `/api/dc/*` handles, the SDK,
the fixture-based local proof, and the first "simple rooms" reader
(`simple.html`: guild → channel → thread, flat, first six guilds in the rail).

## What lab/03 adds (27 files, +1456 / −85)

Feature — server-by-server sidebar:

- `pb_hooks/240_sidebar.pb.js`, `pb_hooks/lib/dc_sidebar.js`, `tests/test_sidebar.js`
  — `GET/POST /api/dc/sidebar`: guilds with counts, channels with Discord
  category (`raw.parent_id`) and position, shared open/hidden/collapsed/order
  preferences persisted in `dc_settings` (key `sidebar`).
- `pb_public/simple.js`, `pb_public/simple-tree.js`, `tests/test_simple_tree.js`
  — rooms view rebuilt as server → category → channel → thread; every server
  open/close and hide/show; categories collapse; Servers dialog with ordering;
  `?guild=` focus; ingress keep-alive when embedded in an HA dashboard;
  60 s token refresh + retry on 401; opens on a room that has messages.
- `tools/ha-sidebar.ts` + `just sidebar-*` — one HA dashboard per server
  (iframe strategy on the ingress entry), `show_in_sidebar` mirrors the app's
  hidden list (`list | servers | pin | sync | hide | show | unpin`).
- `justfile` — kvmlab1 deploy recipes (`push`, `deploy`, `restart`, `logs`,
  `status`, `options`, `set-option`), `DC_PYTHON` for the PyYAML venv, branch
  guard relaxed to `lab/*-discord*`.

Proof-read fixes (4-lens adversarial review, 44 agents, 10 confirmed):

- `ha_admins.py`, `rootfs/etc/services.d/ha-admins/run`, `pb_hooks/lib/ha_admins.js`,
  `pb_hooks/300_autologin.pb.js`, `tests/test_ha_admins.{py,js}` — `auto_login_ha_admins`
  no longer trusts `panel_admin` (a sidebar-visibility flag); the add-on reads
  HA's admin list through Supervisor and fails closed. Needs `homeassistant_api: true`.
- `backfill.py`, `tests/test_discover_skip.py` — guild discovery survives
  403/404 archive routes and a failing guild; `skipped_archives` in the summary.
- `pb_public/panel.js` — reads use the submitted filter; a failed reload no
  longer reconnects SSE at 1 Hz; `refresh()` reports per section
  (`allSettled`) and always starts timeline + live; periodic re-auth is silent
  and skips busy controls; page resets on timeline target change.
- `pb_hooks/110_entities.pb.js`, `pb_public/index.html` — name lookup requires
  superuser auth.
- `service.py` — request markers consumed atomically; readable
  `ValueError`/`RuntimeError` messages.
- `README.md`, `PROOF.md`, `evidence/sidebar-v0.2.*` — docs and live evidence.

## Consequences of keeping them apart

- `kvmlab1` follows lab/03. Redeploying from the lab/01 worktree would put
  0.1.10 back and re-open the `auto_login_ha_admins` hole. Deploy only with
  `just deploy` from `…/03-discord-sidebar-kvmlab1/09-discord_pb`.
- lab/01 stays the codex worker's branch. New commits there will **not** be in
  lab/03 unless cherry-picked; nothing is auto-synced.
- The add-on's `url:` in each branch points at its own branch, so the store
  entry on the box tells you which one is installed.
- `main` of `oracle-haos-factory` has neither (the store still lists 01–08).
