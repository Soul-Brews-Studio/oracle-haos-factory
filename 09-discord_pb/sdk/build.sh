#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun build --target=browser --format=cjs sdk/dc.ts --outfile=pb_hooks/lib/dc.js
