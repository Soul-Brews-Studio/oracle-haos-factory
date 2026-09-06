# Auto-login local validation — 2026-09-06

Version 0.1.1. Dual-arch Docker build and host-mode verify logs are adjacent;
arm64 native on Colima and amd64 emulated. Same `docker build` arguments as
PROOF.md's plain-tags follow-up, then IMAGE=p2p-dropbox:<arch> ./verify.sh.
Both API and P2P fixtures are disposable; deployment credentials are not used.

48 tests pass, 238 assertions. Backend typecheck and frontend build/lint pass.
ShellCheck and YAML schema/default checks pass. Separate read-only code/security
review approved the socket trust, actual Core admin lookup, scoped tokens, API
route scope, and frontend lifecycle protections.

Browser results are in browser.txt. The required admin/denial/direct flows were
observed with real Chromium and fake ingress/HA-Core headers/data. Further browser
interactions paused when the user took control of the task space; they are not
claimed. This is not Nat's real HA browser session.

Deployment permission was explicitly granted for only local_p2p_dropbox. Existing
options and all 10 /share/p2p files were snapshotted privately on the target before
any source shipping. GET /addons/local_p2p_dropbox/options returned 405; the options
were read from GET /addons/local_p2p_dropbox/info .data.options instead. No actual
key, user directory, ingress session, or options snapshot belongs in this evidence.

The first emulated amd64 verification stopped during the empty-auth assertion:
its empty container exited before the expected fatal-options log (only s6 preinit
lines were present). Re-running the same image passed all gates; the retained
verify-amd64.txt is that successful run's stdout, excluding shell trace and its
disposable test key. This transient emulated-startup failure was not hidden by a
bridge fallback or a relaxed assertion. arm64 passed on the first run.
