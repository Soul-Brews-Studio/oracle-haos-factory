# Facebook Lance add-on

Read-only Home Assistant add-on for the Facebook Lance Feed, Chats, semantic
search, and topic explorer. It targets `amd64` pre-Haswell hosts such as Ivy
Bridge by using the glibc `lancedb-compat==0.38.0` wheel.

## Private data boundary

No Facebook ZIP, Lance database, embedding model, or bearer token belongs in
this repository or image. Stage a previously imported database at:

```text
/share/facebook-lance/facebook.lancedb
```

The add-on mounts `/share` read-only. Build the canonical and derived tables on
a workstation, then copy the database directory to HAOS through the protected
SSH add-on. The original Facebook ZIP should remain off HAOS.

The image contains the same deterministic chunk, Thai `newmm-safe` lexical
field, dual Lance FTS, exact post/comment retrieval membership, semantic
generation-manifest, and topic code as the workstation package. Joined context
is expanded only after record-level ranking, never embedded as concatenated
text or inferred from timestamps/authors. It includes PyThaiNLP and the pinned
tokenizer runtime so those table contracts can be read and validated
consistently. HAOS still does not rebuild them because `/share` is mounted
read-only; generation remains a workstation operation.

## External query embedding

The image deliberately excludes ONNX Runtime and model files. Configure both:

- `embed_url`: trusted embedding service base URL, for example a NetBird-only
  workstation endpoint. The client appends `/v1/embeddings`.
- `embed_token`: bearer token shared with that service.

Leave both unset to disable semantic query embedding. Feed, Chats, precomputed
Topics, raw Thai/Unicode FTS, and exact archive browsing continue to work. When
configured, Search combines lexical and semantic candidates against the local
derived tables. The token is passed only through the child process environment;
it is never placed in argv or logs.

Environment overrides are available for non-Supervisor smoke tests:
`FACEBOOK_LANCE_EMBED_URL`, `FACEBOOK_LANCE_EMBED_TOKEN`, and
`FACEBOOK_LANCE_EMBED_TIMEOUT`.

## Runtime layout

```text
HA admin Ingress (container port 8104; no published host port)
        |
        v
service.py read-only proxy (0.0.0.0:8104)
        |
        v
Facebook Lance Studio (127.0.0.1:8791)
        |
        v
/share/facebook-lance/facebook.lancedb (read-only mount)
```

The proxy makes asset/API URLs ingress-relative and changes only the framing
headers needed for same-origin Home Assistant Ingress. Mutation methods remain
blocked, request bodies are capped at 4 KiB, and request targets are not logged.

## Local checks

```bash
python -m unittest discover -s 05-facebook_lance -p 'test_*.py'
python -m compileall -q 05-facebook_lance/app 05-facebook_lance/service.py
sh -n 05-facebook_lance/run.sh
docker build --platform linux/amd64 -t facebook-lance-addon:test 05-facebook_lance
```

This directory is installed as a local app, so Supervisor builds the image from
its Dockerfile. Confirm the private database exists, reload the app store, then
rebuild `local_facebook_lance`; no registry pull or published private-data image
is required.
