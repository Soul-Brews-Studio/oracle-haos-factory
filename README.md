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
