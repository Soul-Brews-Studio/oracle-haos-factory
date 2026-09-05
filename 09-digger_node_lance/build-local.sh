#!/bin/bash
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE
readonly APP_WORKTREE="${APP_WORKTREE:-${HOME}/.local/state/incubate/worktrees/Soul-Brews-Studio/digger-node/02-digger-node-lance-pb}"
readonly PLATFORM="${PLATFORM:-linux/amd64}"

if [[ "$(git -C "${APP_WORKTREE}" branch --show-current)" != "lab/02-digger-node-lance-pb" ]]; then
  echo "app build context is not on lab/02-digger-node-lance-pb" >&2
  exit 1
fi
if [[ -n "$(git -C "${APP_WORKTREE}" status --porcelain)" ]]; then
  echo "app build context is dirty; commit it before assigning a provenance SHA" >&2
  exit 1
fi

APP_SOURCE_SHA="$(git -C "${APP_WORKTREE}" rev-parse HEAD)"
readonly APP_SOURCE_SHA
PLATFORM_TAG="${PLATFORM#linux/}"
PLATFORM_TAG="${PLATFORM_TAG//\//-}"
readonly PLATFORM_TAG
readonly TAG="digger-node-lance:0.1.0-${PLATFORM_TAG}-${APP_SOURCE_SHA:0:12}"
printf 'Building %s from digger-node %s for %s\n' "${TAG}" "${APP_SOURCE_SHA}" "${PLATFORM}"

exec docker buildx build \
  --load \
  --platform "${PLATFORM}" \
  --build-context "app=${APP_WORKTREE}" \
  --build-arg "APP_SOURCE_SHA=${APP_SOURCE_SHA}" \
  --build-arg "BUILD_VERSION=0.1.0" \
  --tag "${TAG}" \
  "${HERE}"
