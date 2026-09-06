#!/usr/bin/env python3
"""Stream PocketBase logs while removing its first-run bootstrap credential."""

from __future__ import annotations

import re
import sys


INSTALL_URL = re.compile(r"(/_/#/pbinstal/)\S+")


for line in sys.stdin:
    sys.stdout.write(INSTALL_URL.sub(r"\1[REDACTED]", line))
    sys.stdout.flush()
