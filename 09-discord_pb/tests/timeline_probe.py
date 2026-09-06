#!/usr/bin/env python3
"""Authenticated timeline proof against the local PocketBase fixture."""

import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


BASE = "http://127.0.0.1:8110"
PARENT = "900000000000000000"
PARENT2 = "900000000000000004"
THREAD = "900000000000000001"
GUILD = "900000000000000002"
MESSAGE_IDS = ("900000000300000001", "900000000300000002", "900000000300000003")


def request(path, token=None, method="GET", body=None):
    headers = {"Authorization": token} if token else {}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    try:
        response = urlopen(Request(BASE + path, headers=headers, method=method, data=data), timeout=20)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read()
        return response.status, json.loads(raw) if raw else None


def main():
    options = json.loads(Path("/data/options.json").read_text())
    body = json.dumps({"identity": options["admin_email"], "password": options["admin_password"]}).encode()
    with urlopen(Request(BASE + "/api/collections/_superusers/auth-with-password", data=body,
                         headers={"Content-Type": "application/json"}), timeout=20) as response:
        token = json.load(response)["token"]

    created = []
    try:
        assert request(f"/api/dc/channels/{PARENT}/timeline")[0] in {401, 403}
        assert request(f"/api/dc/channels/{PARENT}/timeline?bucket=week", token)[0] == 400
        status, channels = request("/api/dc/channels", token)
        assert status == 200
        empty = next(row for row in channels if row["id"] == PARENT2)
        assert empty["imported_count"] == 0, "timeline fixture target must start empty"

        timestamps = ("2024-02-28T16:59:59Z", "2024-02-28T17:00:00Z", "2024-03-01T17:00:00Z")
        for message_id, timestamp in zip(MESSAGE_IDS, timestamps):
            record = {
                "message_id": message_id, "channel_id": PARENT2, "thread_id": "", "guild_id": GUILD,
                "author_id": "900000000300000099", "author_name": "timeline-proof", "content": message_id,
                "attachments_json": [], "ts": timestamp, "created_at": "2026-09-06T12:34:56Z",
                "embeds": [], "raw": {"timeline_proof": True},
            }
            status, saved = request("/api/collections/discord_messages/records", token, "POST", record)
            assert status == 200, (status, saved)
            created.append(saved["id"])

        status, channels = request("/api/dc/channels", token)
        assert status == 200
        target = next(row for row in channels if row["id"] == PARENT2)
        status, daily = request(f"/api/dc/channels/{PARENT2}/timeline?bucket=day", token)
        assert status == 200 and daily["time_zone"] == "Asia/Bangkok"
        assert daily["target"] == {"id": PARENT2, "name": target["name"], "kind": "channel"}
        assert daily["total"] == target["imported_count"] == 3
        assert [(row["date"], row["count"]) for row in daily["buckets"]] == [
            ("2024-02-28", 1), ("2024-02-29", 1), ("2024-03-02", 1)]
        assert daily["gaps"] == [{"since": "2024-03-01", "before": "2024-03-02", "days": 1}]
        assert daily["first"] == target["first_message_at"] == "2024-02-28T16:59:59.000Z"
        assert daily["last"] == target["last_message_at"] == "2024-03-01T17:00:00.000Z"
        assert target["last_import_at"] and target["last_import_at"] != target["last_message_at"]
        assert "2026-09-06" not in {row["date"] for row in daily["buckets"]}, "created_at/import time leaked into timeline"

        status, hourly = request(f"/api/dc/channels/{quote(target['name'])}/timeline?bucket=hour", token)
        assert status == 200 and hourly["total"] == 3
        assert [row["label"].rsplit(" ", 1)[-1] for row in hourly["buckets"]] == ["23:00", "00:00", "00:00"]

        status, thread = request(f"/api/dc/channels/{THREAD}/timeline?bucket=day", token)
        assert status == 200 and thread["total"] == 3
        status, guild = request(f"/api/dc/guilds/{GUILD}/timeline?bucket=day", token)
        assert status == 200 and guild["target"]["kind"] == "guild"
        expected = sum(row["imported_count"] for row in channels if row.get("guild_id") == GUILD)
        assert guild["total"] == expected == sum(row["count"] for row in guild["buckets"])
        print("TIMELINE PROBE PASS (SQL Bangkok midnight/leap-day buckets; gaps; create/import separation; channel/thread/guild totals)")
    finally:
        for record_id in created:
            status, _ = request("/api/collections/discord_messages/records/" + quote(record_id), token, "DELETE")
            assert status == 204


if __name__ == "__main__":
    main()
