#!/usr/bin/env python3
"""Version-specific, fail-closed patch of the embedded admin auth storage key."""
from pathlib import Path
import sys


def patch(path):
    binary = Path(path).read_bytes()
    for old, new in ((b"__pb_superuser_auth__", b"__dc_superuser_auth__"),
                     (b"pb_superuser_file_token", b"dc_superuser_file_token")):
        if len(old) != len(new) or binary.count(old) != 1 or binary.count(new):
            raise ValueError("PocketBase admin signature differs from pinned upstream")
        binary = binary.replace(old, new)
    Path(path).write_bytes(binary)
    print("Admin auth + file-token namespaces: old=0 new=1 each")


if __name__ == "__main__":
    patch(sys.argv[1])
