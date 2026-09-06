#!/usr/bin/env sh
set -eu
umask 077
exec bun /app/options.ts
