# Registration / rooms / client helpers proof

Local tests use disposable credentials, never deployment options. Both images
built from the 0.1.2 runtime with Bun 1.3.14 and plain Supervisor-compatible tags.
`verify-*.txt` are exact local host-to-container CLI WebRTC and HTTP outputs;
SHA256 values are independently computed at both ends. Their “no Supervisor
install” line describes only verify.sh, not the separate authorized deployment.

Commands: `bun test`; backend `tsc --noEmit -p tsconfig.json`; web `bun run build`
and `bun run lint`; shellcheck; Docker build linux/amd64 and linux/arm64, then
`IMAGE=p2p-dropbox:<arch> PROOF_DIR=evidence/registration/<arch> ./verify.sh`.
No TURN server was configured or contacted. Generic options/config wiring is
unit-tested; actual relay connectivity remains untested.

MAW extras reuse the existing private lab03 transport. Gist readback compares
all five code/document files byte-for-byte, unlisted visibility. The local
dashboard contains private filenames and is deliberately NOT published.
