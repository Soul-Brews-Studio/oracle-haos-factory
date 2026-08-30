# Oracle HAOS Factory

A teaching vault of small, working Home Assistant OS add-ons. Each numbered
example isolates a pattern that future Oracles can read, build, install, break,
and verify without first untangling a production application.

This repository is also a Home Assistant add-on **store**. Add its repository URL
to Home Assistant once; Supervisor reads the root store metadata and discovers
each example add-on beneath it.

## Store versus add-on

```text
oracle-haos-factory/
├── repository.yaml               # store identity; one per repository
├── .github/workflows/builder.yml # publishes prebuilt images for advertised architectures
├── README.md                     # map and reading order
├── TRAPS.md                      # symptom-first failure guide
└── 01-hello/                     # one installable add-on
    ├── config.yaml               # Supervisor contract: identity, image, ports, options, schema
    ├── build.yaml                # per-architecture Home Assistant base images
    ├── Dockerfile                # immutable image
    ├── run.sh                    # Supervisor options -> process environment
    └── server.ts                 # application code
```

The root is the **store**; it is not installed as a container. Every numbered
directory is an independent **add-on** with its own `config.yaml`, image, slug,
runtime, and version. The numeric directory prefix is the reading order only:
`01-hello/` still installs with the stable slug `hello`.

## Worked examples

Read these in numeric order.

| Example | What it teaches |
|---|---|
| [`01-hello/`](01-hello/) | The smallest complete add-on: prebuilt amd64/aarch64 images, automatic boot, s6-compatible init, sidebar ingress plus a stable LAN API port, `/data` persistence, a typed option, the three-edit option bridge, and a real health endpoint. |

## How to study an example

1. Start with `config.yaml`; its comments explain failure modes, not decoration.
2. Follow every option through `config.yaml` -> `run.sh` -> application code.
3. Compare `build.yaml` with the Dockerfile's base and architecture handling.
4. Build the image before installing it; never use a Home Assistant host as CI.
5. Verify the running service and negative paths, not merely a successful command.
6. When something looks impossible, search [TRAPS.md](TRAPS.md) by symptom first.

## First example

`01-hello` serves the configured greeting at `GET /` and reports live state at
`GET /api/health`. Its default option is `greeting: hello`; changing that value
is the shortest proof that Supervisor configuration reached the process rather
than merely being stored in the UI.

## Preconditions before installation

Before anyone runs the install commands:

- The GitHub store repository must be **publicly cloneable without credentials**.
- Both advertised GHCR packages—`amd64-addon-hello` and
  `aarch64-addon-hello`—must be **publicly pullable without credentials**.
- An anonymous registry probe must return HTTP `200` for each architecture;
  `401` means private and `404` means the image or tag is genuinely absent.
- Only after those consumer-side checks pass should `config.yaml` point at the
  published image. A green CI badge proves the workflow ran, not that Supervisor
  can reach its output.

```bash
curl -sS -o /dev/null -w '%{http_code}' \
  https://ghcr.io/v2/soul-brews-studio/aarch64-addon-hello/tags/list
```

Repeat the probe for `amd64-addon-hello`. Supervisor clones stores and pulls
images anonymously, so permissions failures otherwise surface as misleading
“not found” or “cannot pull image” installation errors.

## Illustrated walkthrough

Follow [`docs/01-hello-walkthrough.md`](docs/01-hello-walkthrough.md) for the
complete store-to-runtime construction path, rendered architecture diagrams,
validation commands, and the final Home Assistant installation checklist.

## Scaffold new examples by construction

`bin/new-addon.ts` is not a typing shortcut. It makes Trap 6 structurally
impossible during scaffolding: each `--option` is parsed once, then the same
internal definition generates its default and schema in `config.yaml`, its
`bashio::config`/null-guard/export bridge in `run.sh`, and its typed environment
read in `server.ts`. The generator refuses to write if any surface is missing.

```bash
bun bin/new-addon.ts <slug> --port 8099 \
  --option greeting:str=hello \
  --option debug:bool=false
```

Slugs are restricted to `[a-z0-9_]+` because the value becomes both a
container name and a Supervisor API id. The scaffold hard-codes the prebuilt
GHCR image pattern, amd64+aarch64, `boot: auto`, `init: false`, ingress plus its
port mapping, `/data`, and `str` string schemas; these are not optional flags.

The next numeric reading-order prefix is selected from existing example
directories. With `01-hello/` present, this command creates `02-<slug>/` with
`config.yaml`, `build.yaml`, `Dockerfile`, `run.sh`, and `server.ts`.

The scaffold deliberately stops before installation: add the new target to the
CI builder, publish both architecture images, make the packages public, and run
the anonymous consumer-side probes in the preconditions above:

```bash
bun bin/new-addon.ts <slug> --check
```

The check prints `200 installable`, `401 private`, or `404 missing` independently
for amd64 and aarch64, and exits unsuccessfully unless both are installable.
