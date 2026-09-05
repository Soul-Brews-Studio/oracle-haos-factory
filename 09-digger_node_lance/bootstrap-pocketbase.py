#!/usr/bin/env python3
"""Create missing PocketBase owner/admin records over its private hook."""

from __future__ import annotations

import json
import os
from urllib.request import Request, urlopen


def main() -> None:
    owner_password = os.environ.get("OWNER_PASSPHRASE", "")
    if owner_password and len(owner_password) < 8:
        # PocketBase enforces eight characters; the compatibility passphrase
        # path deliberately continues accepting the deployed shorter secret.
        owner_password = ""

    payload = {
        "owner_email": os.environ.get("PB_OWNER_EMAIL", "") if owner_password else "",
        "owner_password": owner_password,
        "superuser_email": os.environ.get("PB_SUPERUSER_EMAIL", ""),
        "superuser_password": os.environ.get("PB_SUPERUSER_PASSWORD", ""),
    }
    token = os.environ.get("DIGGER_INTERNAL_TOKEN", "")
    if not token:
        raise SystemExit("DIGGER_INTERNAL_TOKEN is required for PocketBase bootstrap")
    request = Request(
        os.environ.get("POCKETBASE_URL", "http://127.0.0.1:8090")
        + "/api/digger/bootstrap",
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=15) as response:
        result = json.load(response)
    print(
        "PocketBase bootstrap complete: "
        f"owner_created={bool(result.get('owner_created'))} "
        f"superuser_created={bool(result.get('superuser_created'))}"
    )


if __name__ == "__main__":
    main()
