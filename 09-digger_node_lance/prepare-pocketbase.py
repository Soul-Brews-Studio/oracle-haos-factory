#!/usr/bin/env python3
"""Patch PocketBase's embedded admin UI to use Digger's isolated auth key."""

from __future__ import annotations

import argparse
from pathlib import Path


OLD_KEY = b"__pb_superuser_auth__"
NEW_KEY = b"__dn_superuser_auth__"


def patch_binary(path: Path) -> None:
    if len(OLD_KEY) != len(NEW_KEY):
        raise SystemExit("PocketBase auth storage keys must have equal byte lengths")

    original = path.read_bytes()
    old_count = original.count(OLD_KEY)
    new_count = original.count(NEW_KEY)
    if old_count != 1 or new_count != 0:
        raise SystemExit(
            "unexpected PocketBase auth-key signature before patch: "
            f"old={old_count}, new={new_count}"
        )

    patched = original.replace(OLD_KEY, NEW_KEY)
    if patched.count(OLD_KEY) != 0 or patched.count(NEW_KEY) != 1:
        raise SystemExit("PocketBase auth-key patch verification failed")

    path.write_bytes(patched)
    path.chmod(0o755)
    print("PocketBase admin auth key patched: old=0 new=1")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()
    patch_binary(args.binary)


if __name__ == "__main__":
    main()
