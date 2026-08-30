# HAOS Add-on Traps — Start With the Symptom

A reader usually arrives because something observable is wrong. Each trap begins
with that observation, then follows it to the cause and the repair.

## 1. “Update succeeded,” but the running version did not change

**Symptom:** Supervisor reports a successful install or update, yet the old
version is still running. A fresh install may spend a long time downloading
build inputs on the Home Assistant machine and then fail with an unhelpful build
error.

**Cause:** `config.yaml` has no `image:` entry, or it points at a tag that CI did
not publish. Without a pullable image, Supervisor builds locally. Its success
message describes accepting the update request, not proving that the new image
was built and started.

**Fix:** Publish one image for every advertised architecture in CI and declare
it explicitly:

```yaml
image: "ghcr.io/soul-brews-studio/{arch}-addon-hello"
arch: [amd64, aarch64]
```

Verify that both tags are anonymously pullable before changing `config.yaml`,
then verify the **running version** after every update.

## 2. The add-on stays stopped after reboot, or restarts shut down badly

**Symptom:** An add-on that worked yesterday is stopped after the HA host
reboots. Alternatively, stop/restart waits for a kill timeout or process
lifecycle behavior is inconsistent.

**Cause:** `boot: manual` does not restore the service automatically, while
`init: true` adds an init layer even though Home Assistant base images already
run s6-overlay as PID 1.

**Fix:** Let Supervisor restore the service and let the base image own init:

```yaml
boot: auto
init: false
```

The entry script should finish with `exec <server>` so the application receives
s6 stop signals directly.

## 3. The sidebar works, but curl and API clients cannot connect

**Symptom:** A human can open the add-on in the Home Assistant sidebar, but
`curl http://host:8099/api/health`, an MCP client, or another service gets
connection refused or has no stable URL. Copying the ingress URL does not help
because it depends on a Home Assistant browser session and a rewritten path.

**Cause:** Ingress is a browser tunnel authenticated by Home Assistant. It is
not a general-purpose exposed port, and non-browser clients do not possess its
session token.

**Fix:** Keep ingress for the sidebar **and** publish a LAN port for APIs:

```yaml
ingress: true
ingress_port: 8099
ports:
  8099/tcp: 8099
```

Bind the application to `0.0.0.0:8099`, then prove the sidebar and LAN endpoint
separately.

## 4. Data survives a restart but disappears after an update or restore

**Symptom:** The container can restart and appear healthy, but an add-on update,
reinstall, or Home Assistant backup restore loses its database, generated files,
or home-directory state.

**Cause:** Container paths are ephemeral. Supervisor persists and includes only
`/data` in Home Assistant backups; writing to `/app`, `/root`, or another image
path only looks durable while the same container layer remains.

**Fix:** Mount `/data`, write all mutable state beneath it, and point `HOME` there
when libraries derive storage from the home directory:

```yaml
map:
  - data:rw
```

```dockerfile
ENV HOME=/data
```

## 5. The container never starts, and its add-on log is empty

**Symptom:** Saving configuration or starting the add-on fails before any boot
message appears. The add-on log is an empty string, so debugging the Dockerfile
or server produces no evidence.

**Cause:** Supervisor rejected the options against the schema **before creating
the container**. A common trigger is an optional `url?` field whose shipped
default is `""`; that empty value does not validate as a URL.

**Fix:** Use `str` for string options that may legitimately be blank, then
validate URLs inside the application only when a non-empty value is supplied:

```yaml
options:
  endpoint: ""
schema:
  endpoint: str
```

When the container log is empty, inspect the Supervisor log; the failure lives
one layer earlier than the add-on.

## 6. The UI shows the new option, but the process behaves as if it is unset

**Symptom:** The Configuration tab displays the field and saves a value. Reading
Supervisor options confirms the value is stored. After restart, however, the
server still uses its default, a feature logs “disabled,” or a health endpoint
reports the old behavior. This looks like a Supervisor persistence bug because
the visible configuration is correct. It is usually not.

**Cause:** An option crosses three separate contracts:

1. **`config.yaml`** declares the default and schema, so Supervisor can store it.
2. **`run.sh`** reads it with `bashio::config` and exports an environment variable.
3. **Application code** reads that environment variable and applies it.

These layers do not discover each other automatically. Adding only steps 1 and
3 creates the most deceptive failure: Supervisor truth says “configured,” while
process truth says “missing.” The symptom points at storage or application
parsing, even though the missing wire is the entry script between them.

`bashio::config` adds another trap: an unset optional string may arrive as the
literal text `null`. If the bridge exports that unchecked, the process receives
a real, non-empty string whose value happens to be wrong.

**Fix:** Treat every option as one atomic three-file change. For `greeting`:

```yaml
# config.yaml — declaration and validation
options:
  greeting: "hello"
schema:
  greeting: str
```

```bash
# run.sh — Supervisor-to-process bridge
GREETING="$(bashio::config 'greeting')"
[ "${GREETING}" = "null" ] && GREETING="hello"
export GREETING
```

```ts
// server.ts — runtime consumption
const greeting = process.env.GREETING ?? "hello";
```

Review and test the path in that same order. Use a deliberately non-default
value, restart the add-on, and assert it at a live endpoint. A default-value test
cannot prove the bridge exists because both broken and working code return the
same result.

When this fails, inspect evidence in layers instead of guessing:

1. Read Supervisor's stored options: was the value accepted?
2. Read the boot log: did `run.sh` observe the intended mode without printing secrets?
3. Query the live endpoint: did the application apply it?

A value present at step 1 and absent at steps 2–3 isolates the entrypoint bridge.
Do not rewrite the schema or application parser until `run.sh` has been checked.

## 7. CI is green, but Supervisor says the add-on or image is not found

**Symptom:** The build workflow is green and the store URL in Home Assistant is
correct, yet Supervisor cannot add the store, says the add-on is not found, or
fails to pull the image. The error often sounds like a missing repository or tag
and does not mention package visibility or authentication.

**Cause:** Supervisor is the consumer, and it clones add-on stores and pulls
container images **anonymously**. A private GitHub repository cannot be cloned as
a store. GHCR packages also publish private by default in this setup, so a green
workflow can successfully create both images while anonymous Supervisor pulls
still receive HTTP `401`. CI proved that the producer ran; it did not prove that
the consumer can reach the artifact.

**Fix:** Make the GitHub repository public, set both advertised GHCR packages
(`amd64-addon-hello` and `aarch64-addon-hello`) to public, and then probe the
registry without credentials:

```bash
curl -sS -o /dev/null -w '%{http_code}' \
  https://ghcr.io/v2/soul-brews-studio/aarch64-addon-hello/tags/list
```

Interpret the result before changing or installing anything:

- `200` — the package is anonymously reachable and Supervisor can pull it;
- `401` — the package exists but is private; fix package visibility;
- `404` — the image or tag is genuinely absent; fix the build, name, or tag.

Repeat the anonymous probe for `amd64-addon-hello`. Only after both architectures
return `200` should `config.yaml` point at the image. Pointing an installed
add-on at a tag that cannot be pulled breaks the **installed add-on**, not merely
a new installation.

The general rule is consumer-side verification: a green CI run proves the
workflow ran, not that its artifact is usable by the system that needs it.
