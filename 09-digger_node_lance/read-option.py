#!/usr/bin/env python3
"""Read one Supervisor option without evaluating shell text."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: read-option.py OPTIONS_FILE KEY DEFAULT")
    path, key, default = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    try:
        values = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        values = {}
    value = values.get(key, default)
    if value is None:
        value = default
    if isinstance(value, bool):
        value = "true" if value else "false"
    if not isinstance(value, (str, int, float)):
        raise SystemExit(f"option {key!r} must be a scalar")
    sys.stdout.write(str(value))


if __name__ == "__main__":
    main()
