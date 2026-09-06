# `maw dropbox` extras

An optional, dependency-free decorator for the existing **lab03 `maw dropbox` v1.1.0** plugin. It adds read-only statistics, a local HTML snapshot, and safe service-link sharing without replacing the tested transport.

## Commands

```bash
maw dropbox stats
maw dropbox stats --json
maw dropbox ui                 # print the HA ingress URL
maw dropbox ui --open
maw dropbox dashboard          # write a private, mode-0600 HTML snapshot
maw dropbox dashboard --open
maw dropbox share              # print a key-free VPN sharing recipe
```

Existing `send`, `ls`, `status`, `url`, and `config` commands remain delegated byte-for-byte to the installed plugin.

## New machine: install the existing transport first

Requires `gh` authentication with access to the private source repository, Bun
1.3.14, and an installed `maw` CLI. Do not overwrite an existing Dropbox plugin.

```bash
gh repo clone laris-co/p2p-oracle p2p-oracle-client -- \
  --branch lab/03-maw-dropbox-plugin --single-branch
git -C p2p-oracle-client checkout 059b565ae97d4aa97e2624ac8a95c0d06f7ca792
maw plugin install "$PWD/p2p-oracle-client/dropbox/maw-plugin" --root "$HOME/.maw/plugins"
```

The committed bundle supplies the existing transport; this Gist ships only the
new extras code, not the private transport source. If `maw` is unavailable, use
the vendored CLI recipe in the factory add-on DOCS.md. Provision the existing key
privately with `AUTH_KEY` or the plugin's secret store; never paste it into a gist.

## Install into an existing plugin

The target must already be the private lab03 plugin `dropbox` v1.1.0 with runtime `bun-dev`. The installer refuses unknown versions, symlinked plugin directories, and third-party wrappers.

```bash
cd 10-p2p_dropbox/client/maw-dropbox
bun install-extras.ts
maw dropbox stats
```

Remove only the decorator and restore the prior manifest:

```bash
bun install-extras.ts --remove
```

The installer never reads or changes `~/.config/maw/dropbox.json`, `AUTH_KEY`, or the bundled transport. It keeps a private `plugin.before-extras.json` backup while installed.

## VPN URLs and authentication

- Direct HTTP/WebSocket service: `http://kvmlab1.oracle.netbird:3847` / `ws://kvmlab1.oracle.netbird:3847/ws`
- Home Assistant UI: `http://kvmlab1.oracle.netbird/hassio/ingress/local_p2p_dropbox`
- Both are private service URLs intended for NetBird VPN peers. They are not anonymous public share links.
- Never put `AUTH_KEY` in a URL, prompt, Gist, shell history, or chat. Supply it privately through the installed plugin's existing secret mechanism.
- Direct `:3847` access retains the auth-key gate. HA ingress auto-login is scoped to permitted HA users and never exposes the raw key to the page.

## Named rooms

The existing lab03 maw v1.1.0 transport predates `ROOM` and would silently use the default room. This decorator therefore refuses `maw dropbox send` and `maw dropbox status` when `ROOM` is a non-default value.

For named rooms, use the add-on's vendored clients:

```bash
ROOM=project-a \
SIGNAL_URL=ws://kvmlab1.oracle.netbird:3847/ws \
PEER_NAME=m5-project-a-sender \
AUTH_KEY="$AUTH_KEY" \
bun ./send.ts --to project-a-receiver /absolute/path/file
```

Use a distinct `PEER_NAME` for each simultaneously connected process. Rooms isolate signaling traffic; they are not an authorization boundary.

## Dashboard semantics

`dashboard` fetches authenticated `/api/files`, writes one local HTML snapshot into a newly created private temporary directory, and prints its path. It does not start a server or embed credentials. The sender count comes from historical file metadata, not currently online peers. Treat filenames as private and do not publish generated dashboards.

Known transport limit: batches larger than 500 files can be unreliable; split them into smaller batches.

TURN is optional and unset. **TURN: none in the fleet today; add a coturn add-on on kvmlab1 if relay is ever needed.**

## Test

```bash
bun test ./dropbox-extras.test.ts
```
