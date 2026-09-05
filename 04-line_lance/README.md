# LINE Lance add-on

Version `0.3.0` packages the LINE archive as a Node 24 + Python hybrid Home
Assistant add-on. An Elysia gateway owns the Ingress listener on `8103`, serves
the built React UI, proxies the read-only archive API to Python on
`127.0.0.1:4133`, and stores the encrypted local bot registry in `/data`.

## Private data boundaries

The private LanceDB archive is **never** tracked or baked into the image. The
add-on maps HA shared storage and opens only `/share/line-lance/line.lance`.
Supervisor-managed `/data` holds the bot registry SQLite database and its
generated 32-byte encryption key. The gateway forces those files to mode
`0600`; `run.sh` starts with `umask 077`.

Admin-only HA Ingress is the sole network entry point. Python binds only to
loopback, while Node binds `0.0.0.0:8103`. Bot credentials are write-only and
mutation routes require both HA Ingress identity headers and an explicit
management-intent header.

`lancedb-compat` is intentional: the target Ivy Bridge CPU has AVX but not
AVX2, while stock LanceDB wheels target Haswell. The compatibility wheel uses
runtime SIMD dispatch instead of terminating with `SIGILL` during import.

## Build and runtime

Pinned Node 24 stages typecheck/test/build the Elysia gateway and
typecheck/build the React frontend. The final glibc Python 3.12 image receives
only the Node executable, production gateway dependencies, and compiled assets.

At startup, `run.sh` applies `umask 077`, starts Python, waits for archive health,
starts Node, then terminates the sibling if either process exits. Set
`DRY_RUN=1` to print resolved commands without launching either service.

## Backup and restore

Treat the archive and control plane as separate backup units:

- Stop the add-on before copying `/share/line-lance/line.lance`; a cold tarball
  can live under `/share/line-lance/backups/line-lance-<timestamp>.tgz` with a
  recorded SHA-256 checksum.
- Let the Home Assistant add-on backup carry `/data`. The SQLite registry and
  `line-lance-control.key` must be restored together or encrypted credentials
  cannot be decrypted.
- Restore while the add-on is stopped, verify the archive checksum and file
  ownership, then start the same or newer compatible add-on version. Never put
  the private archive, control database, key, or backup tarballs in this source
  directory.

## Local checks

```sh
python -m unittest -v test_app.py test_run_sh.py
sh -n run.sh
npm --prefix gateway ci && npm --prefix gateway test
npm --prefix frontend ci && npm --prefix frontend run typecheck && npm --prefix frontend run build
docker build -t line-lance:0.3.0 .
```
