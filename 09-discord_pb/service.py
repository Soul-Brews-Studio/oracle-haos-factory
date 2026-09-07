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
from datetime import datetime, timezone
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
    if type(data.get("live", True)) is not bool:
        raise ValueError("live must be boolean")
    if type(data.get("allow_post", False)) is not bool:
        raise ValueError("allow_post must be boolean")
    for key in ("bot_token", "channels", "guilds", "post_channels", "admin_email", "admin_password", "auto_login_ha_user_ids"):
        if data.get(key) is not None and not isinstance(data[key], str):
            raise ValueError(f"{key} must be a string")
    if bool(data.get("admin_email")) != bool(data.get("admin_password")):
        raise ValueError("admin_email and admin_password must be supplied together")
    return data


def hooks_pool(value, default=4):
    """Goja runtime pool size for hooks: an integer 1..15, else the default."""
    try:
        size = int(str(value).strip()) if value not in (None, "") else default
    except ValueError:
        return default
    return size if 1 <= size <= 15 else default


def consume_marker(path):
    """Remove a request marker and report whether it existed, in one step."""
    try:
        Path(path).unlink()
        return True
    except FileNotFoundError:
        return False


def write_job(path, state, started_at=None):
    value = {"state": state, "started_at": started_at}
    if state in ("succeeded", "failed", "idle"):
        value["finished_at"] = datetime.now(timezone.utc).isoformat()
    temporary = Path(str(path) + ".tmp")
    temporary.write_text(json.dumps(value))
    temporary.chmod(0o600)
    temporary.replace(path)


def main():
    config = options(os.environ.get("DISCORD_PB_OPTIONS", "/data/options.json"))
    env = os.environ.copy()
    # Keep Discord credentials out of PB's environment and process arguments.
    env.pop("DISCORD_BOT_TOKEN", None)
    env.update(DISCORD_PB_INTERNAL_TOKEN=secrets.token_urlsafe(32),
               DISCORD_PB_BACKFILL_READY=str(bool(config.get("bot_token") or env.get("DISCORD_PB_FIXTURE") == "true")).lower(),
               DISCORD_PB_ADMIN_EMAIL=config.get("admin_email") or "admin@discord-pb.local",
               DISCORD_PB_ADMIN_PASSWORD=config.get("admin_password") or secrets.token_urlsafe(40),
               DISCORD_PB_SET_PASSWORD=str(bool(config.get("admin_password"))).lower(),
               DISCORD_PB_AUTO_LOGIN=str(config.get("auto_login", False)).lower(),
               DISCORD_PB_HA_ADMINS=str(config.get("auto_login_ha_admins", False)).lower(),
               DISCORD_PB_HA_USERS=config.get("auto_login_ha_user_ids") or "")
    # Shared only with the separately supervised s6 Gateway process; never /data.
    runtime = Path("/run/discord-pb")
    runtime.mkdir(mode=0o700, exist_ok=True)
    runtime.chmod(0o700)
    token_file = runtime / "internal-token"
    temporary_token = runtime / ".internal-token.tmp"
    temporary_token.write_text(env["DISCORD_PB_INTERNAL_TOKEN"])
    temporary_token.chmod(0o600)
    temporary_token.replace(token_file)
    Path("/data/pb_data").mkdir(exist_ok=True)
    pb = subprocess.Popen(["/pb/pocketbase", "serve", "--http=0.0.0.0:8110", "--dir=/data/pb_data",
        "--hooksDir=/pb/pb_hooks", "--migrationsDir=/pb/pb_migrations", "--publicDir=/pb/pb_public",
        "--hooksWatch=false",
        # PocketBase prewarms 15 goja runtimes for hooks by default; each holds
        # the required lib modules, and under a bulk backfill + selection burst
        # RSS reached ~300 MB and the 2 GB kvmlab1 guest OOM-killed the process
        # twice (2026-09-07 01:04Z, 01:10Z). A small pool caps that; hooks are
        # short and mostly serialized by SQLite anyway.
        f"--hooksPool={hooks_pool(os.environ.get('DISCORD_PB_HOOKS_POOL'))}"], env=env)
    job_path = Path("/data/backfill-job.json")
    request_path = Path("/data/backfill-request")
    channel_request_path = Path("/data/dc-import-request")
    write_job(job_path, "idle")
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
        backfill_env["DISCORD_GUILDS"] = config.get("guilds") or ""
        due = 0
        started_at = None
        while not stopped:
            if pb.poll() is not None:
                raise RuntimeError("PocketBase exited unexpectedly")
            if (time.monotonic() >= due or request_path.exists() or channel_request_path.exists()) and worker is None:
                # Consume the markers atomically: a full-run request written between
                # an exists() check and the unlink would otherwise be deleted unseen.
                full_request = consume_marker(request_path)
                consume_marker(channel_request_path)
                requested_only = time.monotonic() < due and not full_request
                if env["DISCORD_PB_BACKFILL_READY"] != "true":
                    write_job(job_path, "idle")
                    due = time.monotonic() + config.get("poll_minutes", 60) * 60
                else:
                    started_at = datetime.now(timezone.utc).isoformat()
                    write_job(job_path, "running", started_at)
                    worker_env = dict(backfill_env, DISCORD_PB_REQUESTED_ONLY=str(requested_only).lower())
                    worker = subprocess.Popen([sys.executable, "/app/backfill.py"], env=worker_env)
            if worker is not None and worker.poll() is not None:
                if worker.returncode:
                    print("backfill failed; next scheduled attempt will replay safely", flush=True)
                write_job(job_path, "succeeded" if worker.returncode == 0 else "failed", started_at)
                worker = None
                if not requested_only:
                    due = time.monotonic() + config.get("poll_minutes", 60) * 60
            time.sleep(.2)
    finally:
        token_file.unlink(missing_ok=True)
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
        # ValueError/RuntimeError messages are this file's own hand-written
        # sentences (never option values); OSError bodies may name paths, so only
        # the class is printed for those.
        detail = f": {error}" if isinstance(error, (ValueError, RuntimeError)) else ""
        print(f"discord_pb service failed: {type(error).__name__}{detail}", file=sys.stderr)
        sys.exit(1)
