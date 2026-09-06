#!/usr/bin/env python3
"""Probe the running app from its loopback. Secrets never leave this process."""
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def pb_environment():
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes().split(b"\x00")
            # QEMU prepends its executable; match the exact PB argv entry on both architectures.
            if b"/pb/pocketbase" in command and b"serve" in command:
                pairs = (entry / "environ").read_bytes().split(b"\x00")
                return dict(item.decode().split("=", 1) for item in pairs if b"=" in item)
        except (OSError, IndexError):
            continue
    raise RuntimeError("PocketBase process absent")


def upsert(messages):
    request = Request("http://127.0.0.1:8110/api/discord/internal/upsert", method="POST",
        data=json.dumps({"messages": messages}).encode(), headers={"Content-Type": "application/json",
        "X-Discord-PB-Token": pb_environment()["DISCORD_PB_INTERNAL_TOKEN"]})
    try:
        with urlopen(request, timeout=15) as response:
            return {"status": response.status, "body": json.load(response)}
    except HTTPError as error:
        return {"status": error.code}


if __name__ == "__main__":
    if sys.argv[1] == "backfill":
        env = os.environ.copy()
        env.update(DISCORD_PB_INTERNAL_TOKEN=pb_environment()["DISCORD_PB_INTERNAL_TOKEN"],
                   DISCORD_PB_FIXTURE="true", DISCORD_BOT_TOKEN="", DISCORD_API_BASE=sys.argv[2],
                   DISCORD_CHANNELS=sys.argv[3])
        sys.exit(subprocess.run([sys.executable, "/app/backfill.py"], env=env, timeout=90).returncode)
    if sys.argv[1] == "upsert":
        print(json.dumps(upsert(json.loads(sys.stdin.read()))))
