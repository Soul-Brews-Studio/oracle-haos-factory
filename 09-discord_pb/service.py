#!/usr/bin/env python3
"""Supervise PocketBase and its own backfill; never load a token from elsewhere."""
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen


def options(path):
    data = json.loads(Path(path).read_text())
    if not isinstance(data, dict):
        raise ValueError("options must be an object")
    minutes = data.get("poll_minutes", 60)
    if type(minutes) is not int or not 1 <= minutes <= 10080:
        raise ValueError("poll_minutes must be 1..10080")
    if type(data.get("auto_login", False)) is not bool:
        raise ValueError("auto_login must be boolean")
    if type(data.get("auto_login_ha_admins", False)) is not bool:
        raise ValueError("auto_login_ha_admins must be boolean")
    for key in ("bot_token", "channels", "admin_email", "admin_password", "auto_login_ha_user_ids"):
        if data.get(key) is not None and not isinstance(data[key], str):
            raise ValueError(f"{key} must be a string")
    if bool(data.get("admin_email")) != bool(data.get("admin_password")):
        raise ValueError("admin_email and admin_password must be supplied together")
    return data


def main():
    config = options(os.environ.get("DISCORD_PB_OPTIONS", "/data/options.json"))
    env = os.environ.copy()
    # Keep Discord credentials out of PB's environment and process arguments.
    env.pop("DISCORD_BOT_TOKEN", None)
    env.update(DISCORD_PB_INTERNAL_TOKEN=secrets.token_urlsafe(32),
               DISCORD_PB_ADMIN_EMAIL=config.get("admin_email") or "admin@discord-pb.local",
               DISCORD_PB_ADMIN_PASSWORD=config.get("admin_password") or secrets.token_urlsafe(40),
               DISCORD_PB_SET_PASSWORD=str(bool(config.get("admin_password"))).lower(),
               DISCORD_PB_AUTO_LOGIN=str(config.get("auto_login", False)).lower(),
               DISCORD_PB_HA_ADMINS=str(config.get("auto_login_ha_admins", False)).lower(),
               DISCORD_PB_HA_USERS=config.get("auto_login_ha_user_ids") or "")
    Path("/data/pb_data").mkdir(exist_ok=True)
    pb = subprocess.Popen(["/pb/pocketbase", "serve", "--http=0.0.0.0:8110", "--dir=/data/pb_data",
        "--hooksDir=/pb/pb_hooks", "--migrationsDir=/pb/pb_migrations", "--publicDir=/pb/pb_public",
        "--hooksWatch=false"], env=env)
    stopped = False
    worker = None

    def stop(*_):
        nonlocal stopped
        stopped = True
        if worker is not None and worker.poll() is None:
            worker.terminate()
        if pb.poll() is None:
            pb.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        for _ in range(120):
            if stopped or pb.poll() is not None:
                raise RuntimeError("PocketBase stopped before readiness")
            try:
                with urlopen("http://127.0.0.1:8110/api/health", timeout=1) as response:
                    if response.status == 200:
                        break
            except (URLError, TimeoutError):
                time.sleep(.25)
        else:
            raise RuntimeError("PocketBase readiness timed out")
        backfill_env = env.copy()
        backfill_env.pop("DISCORD_PB_ADMIN_PASSWORD")
        backfill_env["DISCORD_BOT_TOKEN"] = config.get("bot_token") or ""
        backfill_env["DISCORD_CHANNELS"] = config.get("channels") or ""
        due = 0
        while not stopped:
            if pb.poll() is not None:
                raise RuntimeError("PocketBase exited unexpectedly")
            if time.monotonic() >= due and worker is None:
                worker = subprocess.Popen([sys.executable, "/app/backfill.py"], env=backfill_env)
            if worker is not None and worker.poll() is not None:
                if worker.returncode:
                    print("backfill failed; next scheduled attempt will replay safely", flush=True)
                worker = None
                due = time.monotonic() + config.get("poll_minutes", 60) * 60
            time.sleep(.2)
    finally:
        stop()
        for child in (worker, pb):
            if child is not None:
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        # Do not dump options, credentials or arbitrary exception bodies.
        print(f"discord_pb service failed: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
