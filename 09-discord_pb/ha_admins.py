#!/usr/bin/env python3
"""Keep a fresh list of Home Assistant administrator user ids for the auto-login hook.

`panel_admin: true` only hides the sidebar entry from non-admins; the ingress
transport itself is open to every HA user who can mint an ingress session, and
Supervisor forwards their X-Remote-User-Id without any admin check. So the hook
must not treat "arrived through ingress" as "is an administrator". This sidecar
asks HA core who the administrators are (websocket `config/auth/list`, reached
through Supervisor with the add-on's own SUPERVISOR_TOKEN, which needs
`homeassistant_api: true`) and writes their ids to a private runtime file the
hook reads. A missing or stale file denies: the hook fails closed.

Runs as its own s6 service; exits quietly when the add-on has no Supervisor
token (fixture/local runs) so it never blocks PocketBase.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gateway_ws import WebSocket, WebSocketError  # noqa: E402

ADMIN_GROUP = "system-admin"
DEFAULT_OUTPUT = "/run/discord-pb/ha-admins.json"
DEFAULT_URL = "ws://supervisor/core/websocket"
REFRESH_SECONDS = 300


def admin_ids(users) -> list[str]:
    """Ids of active, human, administrator users. Owners are always administrators."""
    if not isinstance(users, list):
        raise ValueError("user list must be a list")
    result = []
    for user in users:
        if not isinstance(user, dict) or not isinstance(user.get("id"), str) or not user["id"]:
            continue
        if user.get("is_active") is False or user.get("system_generated") is True:
            continue
        groups = user.get("group_ids") or []
        if user.get("is_owner") is True or (isinstance(groups, list) and ADMIN_GROUP in groups):
            result.append(user["id"])
    return sorted(set(result))


def fetch_admins(url: str, token: str, timeout: float = 20) -> list[str]:
    socket = WebSocket.connect(url, timeout=timeout)
    try:
        hello = socket.recv_json()
        if not isinstance(hello, dict) or hello.get("type") != "auth_required":
            raise WebSocketError("HA websocket did not ask for auth")
        socket.send_json({"type": "auth", "access_token": token})
        reply = socket.recv_json()
        if not isinstance(reply, dict) or reply.get("type") != "auth_ok":
            raise WebSocketError("HA websocket rejected the Supervisor token")
        socket.send_json({"id": 1, "type": "config/auth/list"})
        while True:
            message = socket.recv_json()
            if isinstance(message, dict) and message.get("id") == 1:
                break
        if not message.get("success"):
            raise WebSocketError("config/auth/list failed: " + str((message.get("error") or {}).get("message", "")))
        return admin_ids(message.get("result"))
    finally:
        try:
            socket.close()
        except Exception:
            pass


def write_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".ha-admins-", dir=path.parent)
    try:
        with os.fdopen(handle, "w") as stream:
            json.dump(payload, stream, sort_keys=True)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def main() -> int:
    token = os.getenv("SUPERVISOR_TOKEN", "")
    output = Path(os.getenv("DISCORD_PB_HA_ADMINS_FILE", DEFAULT_OUTPUT))
    url = os.getenv("DISCORD_PB_HA_WS_URL", DEFAULT_URL)
    if not token:
        print("ha_admins: no SUPERVISOR_TOKEN; HA administrator check disabled (auto_login_ha_admins will deny)", flush=True)
        while True:  # s6 longrun: stay alive quietly instead of crash-looping
            time.sleep(3600)
    failures = 0
    while True:
        try:
            admins = fetch_admins(url, token)
            write_atomic(output, {"at": datetime.now(timezone.utc).isoformat(), "admins": admins})
            if failures:
                print("ha_admins: recovered", flush=True)
            failures = 0
        except Exception as error:  # noqa: BLE001 - keep the loop alive, log the class only
            failures += 1
            if failures in (1, 10, 100):
                print(f"ha_admins: refresh failed ({type(error).__name__}); the hook denies until it recovers", file=sys.stderr, flush=True)
        time.sleep(REFRESH_SECONDS if not failures else min(60 * failures, REFRESH_SECONDS))


if __name__ == "__main__":
    sys.exit(main())
