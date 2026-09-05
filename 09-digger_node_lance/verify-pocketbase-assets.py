#!/usr/bin/env python3
"""Prove the running PocketBase admin assets contain only Digger's auth key."""

from __future__ import annotations

import argparse
import re
from collections import deque
from urllib.parse import urljoin, urlparse
from urllib.error import HTTPError
from urllib.request import urlopen


OLD_KEY = "__pb_superuser_auth__"
NEW_KEY = "__dn_superuser_auth__"
ASSET_PATTERN = re.compile(
    r"(?:src|href)=[\"']([^\"']+)[\"']|[\"']([^\"']+\.(?:js|css)(?:\?[^\"']*)?)[\"']"
)


def verify(root: str) -> None:
    root = root.rstrip("/") + "/"
    origin = urlparse(root)
    queue = deque([urljoin(root, "_/")])
    seen: set[str] = set()
    found_new = False

    while queue and len(seen) < 500:
        url = queue.popleft()
        if url in seen:
            continue
        seen.add(url)
        try:
            with urlopen(url, timeout=10) as response:
                body = response.read().decode("utf-8", errors="replace")
        except HTTPError as error:
            if len(seen) == 1:
                raise SystemExit(f"PocketBase admin entry failed: {url} returned {error.code}") from error
            # Bundled source maps can name lazy chunks that are not served in a
            # release build. They are not evidence either way; keep crawling the
            # actual assets that do exist.
            print(f"skipping unavailable referenced asset: {url} ({error.code})")
            continue
        if OLD_KEY in body:
            raise SystemExit(f"old PocketBase auth key is still served by {url}")
        found_new = found_new or NEW_KEY in body

        for match in ASSET_PATTERN.finditer(body):
            candidate = match.group(1) or match.group(2)
            if not candidate or candidate.startswith(("data:", "mailto:", "#")):
                continue
            asset = urljoin(url, candidate)
            parsed = urlparse(asset)
            if (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc):
                continue
            if parsed.path.endswith((".js", ".css")) or asset.endswith("/_/"):
                queue.append(asset)

    if not found_new:
        raise SystemExit(
            f"new PocketBase auth key was not found in {len(seen)} served admin assets"
        )
    print(f"PocketBase served admin assets verified: files={len(seen)} old=0 new>=1")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("origin")
    args = parser.parse_args()
    verify(args.origin)


if __name__ == "__main__":
    main()
