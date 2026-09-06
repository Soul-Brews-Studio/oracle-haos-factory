#!/usr/bin/env python3
"""Integration proof for POST /api/discord/import.

Pass secrets through PB_SUPERUSER_TOKEN/PB_REGULAR_TOKEN or a JSON document on
stdin. Nothing sensitive is accepted as a command-line argument or printed.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def request(url, method="GET", body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = token
    req = Request(url, method=method, headers=headers,
                  data=None if body is None else json.dumps(body).encode())
    try:
        response = urlopen(req, timeout=15)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read()
        try:
            payload = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            payload = raw.decode(errors="replace")
        return response.status, payload


def file_digest(path):
    if not path:
        return None
    candidate = Path(path)
    if not candidate.exists():
        return "absent"
    return hashlib.sha256(candidate.read_bytes()).hexdigest()


def main():
    supplied = json.load(sys.stdin) if not sys.stdin.isatty() else {}
    base = supplied.get("url") or os.environ.get("PB_URL", "http://127.0.0.1:8110")
    token = supplied.get("bearer") or os.environ.get("PB_SUPERUSER_TOKEN", "")
    regular = supplied.get("regular_bearer") or os.environ.get("PB_REGULAR_TOKEN", "")
    messages = supplied.get("messages")
    cursor_file = supplied.get("cursor_file") or os.environ.get("DISCORD_PB_STATE_FILE", "")
    if not token or not isinstance(messages, list) or not messages:
        raise SystemExit("provide a superuser bearer and at least one normalized message via stdin/environment")
    endpoint = base.rstrip("/") + "/api/discord/import"
    records_url = base.rstrip("/") + "/api/collections/discord_messages/records"

    def find(message_id):
        query = urlencode({"perPage": 2, "filter": f'message_id="{message_id}"'})
        status, result = request(records_url + "?" + query, token=token)
        assert status == 200, (status, result)
        return result["items"]

    cursor_before = file_digest(cursor_file)
    assert request(endpoint, "POST", {"messages": messages})[0] >= 400
    assert request(endpoint, "POST", {"messages": messages}, "not-a-valid-token")[0] >= 400
    if regular:
        assert request(endpoint, "POST", {"messages": messages}, regular)[0] >= 400
    if regular:
        print("PASS guest, invalid bearer, and supplied regular-auth bearer are denied")
    else:
        print("PASS guest and invalid bearer are denied (no regular-auth fixture supplied)")

    existed = {item["message_id"]: bool(find(item["message_id"])) for item in messages}
    status, first = request(endpoint, "POST", {"messages": messages}, token)
    assert status == 200 and first["ok"] is True and first["received"] == len(messages), (status, first)
    assert first["inserted"] == sum(not value for value in existed.values())
    assert first["updated"] == sum(existed.values())
    stored = find(messages[0]["message_id"])[0]
    created_at = stored["created_at"]

    # Server-owned fields must survive importer retries.
    sentinel = {"routed_to": "import-probe", "routed_at": "2026-09-06 00:00:00.000Z"}
    status, routed = request(records_url + "/" + stored["id"], "PATCH", sentinel, token)
    assert status == 200, (status, routed)
    status, repeated = request(endpoint, "POST", {"messages": messages}, token)
    assert status == 200 and repeated["inserted"] == 0 and repeated["updated"] == len(messages), (status, repeated)
    retried = find(messages[0]["message_id"])[0]
    assert retried["created_at"] == created_at
    assert retried["routed_to"] == sentinel["routed_to"] and retried["routed_at"] == sentinel["routed_at"]
    print("PASS valid import is idempotent by message_id and preserves created_at/routing")

    candidate = int(messages[0]["message_id"])
    while True:
        candidate += 1
        candidate_id = str(candidate)
        if 17 <= len(candidate_id) <= 20 and not find(candidate_id):
            break
    valid_new = dict(messages[0], message_id=candidate_id)
    invalid = dict(messages[0], message_id=str(candidate + 1), channel_id=int(messages[0]["channel_id"]))
    total_before = request(base.rstrip("/") + "/api/discord/status")[1]["total"]
    status, _ = request(endpoint, "POST", {"messages": [valid_new, invalid]}, token)
    assert status == 400 and not find(candidate_id)
    assert request(base.rstrip("/") + "/api/discord/status")[1]["total"] == total_before
    assert request(endpoint, "POST", {"messages": messages, "unexpected": True}, token)[0] == 400
    assert file_digest(cursor_file) == cursor_before
    print("PASS invalid batch is atomic; envelope is strict; backfill cursor is unchanged")
    print("IMPORT PROOF PASS")


if __name__ == "__main__":
    main()
