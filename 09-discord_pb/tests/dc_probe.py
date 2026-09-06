#!/usr/bin/env python3
"""Isolated /api/dc proof. Runs inside the fixture app; never contacts Discord."""

import json
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


BASE = "http://127.0.0.1:8110"
FIXTURE = "http://fixture:18080"
CONFIG = Path("/data/dc.config.yaml")
OPTIONS = Path("/data/options.json")
PARENT = "900000000000000000"
THREAD = "900000000000000001"
GUILD = "900000000000000002"
PARENT2 = "900000000000000004"
NEW_THREAD = "900000000000000005"


def request(path, method="GET", body=None, token=None, raw=False):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = token
    req = Request(BASE + path, method=method, headers=headers,
                  data=None if body is None else json.dumps(body).encode())
    try:
        response = urlopen(req, timeout=20)
    except HTTPError as error:
        response = error
    with response:
        payload = response.read()
        if raw:
            value = payload.decode()
        else:
            try:
                value = json.loads(payload)
            except (UnicodeDecodeError, json.JSONDecodeError):
                value = payload.decode(errors="replace")
        return response.status, value


def fixture(path):
    with urlopen(FIXTURE + path, timeout=10) as response:
        return json.load(response)


def auth(options):
    status, data = request("/api/collections/_superusers/auth-with-password", "POST", {
        "identity": options["admin_email"], "password": options["admin_password"]
    })
    assert status == 200
    return data["token"]


def channels(token):
    status, rows = request("/api/dc/channels", token=token)
    assert status == 200 and isinstance(rows, list)
    return rows


def api_channel(target, suffix, token, method="GET", body=None):
    return request("/api/dc/channels/" + quote(target, safe="") + suffix, method, body, token)


def wait_idle(token):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        status, job = request("/api/discord/backfill", token=token)
        if status == 200 and job.get("state") != "running" and not job.get("queued") and not Path("/data/backfill-request").exists() and not Path("/data/dc-import-request").exists():
            return
        time.sleep(.2)
    raise AssertionError("backfill did not become idle")


def file_snapshot(path):
    return path.read_bytes() if path.exists() else None


def restore_file(path, content):
    if content is None:
        path.unlink(missing_ok=True)
    else:
        path.write_bytes(content)


def expect_status(result, expected):
    assert result[0] == expected, (expected, result)
    return result[1]


def main():
    original_options = OPTIONS.read_bytes()
    original_config = file_snapshot(CONFIG)
    options = json.loads(original_options)
    token = auth(options)
    original_rows = channels(token)
    original_selected = {row["id"]: bool(row["selected"]) for row in original_rows}
    total_before = request("/api/discord/status")[1]["total"]
    try:
        assert request("/api/dc/channels")[0] in {401, 403}
        required = {"id", "name", "guild", "kind", "parent", "archived", "imported_count", "selected"}
        assert original_rows and all(required <= set(row) for row in original_rows)
        indexed = {row["id"]: row for row in original_rows}
        assert indexed[PARENT]["imported_count"] == 205
        assert indexed[THREAD]["imported_count"] == 3
        assert expect_status(api_channel(PARENT, "/read?limit=100", token), 200)["messages"]
        assert len(expect_status(api_channel(THREAD, "/read?limit=100", token), 200)["messages"]) == 3
        assert api_channel("proof", "/read", token)[0] == 409
        assert api_channel("definitely-missing", "/read", token)[0] == 404
        assert len(expect_status(api_channel(THREAD, "/read?since=2026-09-06T00:00:00Z&before=2026-09-07T00:00:00Z", token), 200)["messages"]) == 3
        print("PASS dc auth; channel fields/counts; channel/thread reads/date bounds; loud ambiguous/missing names")

        flipped = not original_selected[PARENT2]
        assert expect_status(api_channel(PARENT2, "/select", token, "POST", {"on": flipped}), 200)["selected"] is flipped
        assert {row["id"]: row["selected"] for row in channels(token)}[PARENT2] is flipped
        print("PASS selection persists in /data")

        status, model = request("/api/dc/config", token=token)
        assert status == 200 and model["ok"] is True and isinstance(model["channels"], dict)
        baseline = file_snapshot(CONFIG)
        invalid = [
            "guilds: [\n",
            f"guilds:\n  \"{GUILD}\":\n    channels:\n      \"{PARENT2}\": {{actions: [explode]}}\n",
            f"guilds:\n  \"{GUILD}\":\n    channels:\n      no-such-room: {{import: false}}\n",
            f"guilds:\n  \"{GUILD}\":\n    channels:\n      proof: {{import: false}}\n",
        ]
        for yaml in invalid:
            status, result = request("/api/dc/config/save", "POST", {"yaml": yaml}, token)
            assert status == 400 and result["ok"] is False and file_snapshot(CONFIG) == baseline, (status, result)
        print("PASS invalid YAML/action/unknown/ambiguous config rejected without overwrite")

        options["allow_post"] = True
        options["post_channels"] = PARENT2
        OPTIONS.write_text(json.dumps(options))
        locked_yaml = f"""guilds:
  "{GUILD}":
    channels:
      '*': {{import: false, post: false, actions: []}}
      "{PARENT2}": {{purpose: probe, owner: probe-oracle, import: false, post: false, actions: []}}
      "{THREAD}": {{import: false, post: false, actions: [archive]}}
oracles: {{}}
"""
        expect_status(request("/api/dc/config/save", "POST", {"yaml": locked_yaml}, token), 200)
        assert expect_status(api_channel(PARENT2, "/allowed?verb=post", token), 200)["allowed"] is False
        assert api_channel(PARENT2, "/post", token, "POST", {"text": "must be denied"})[0] == 403
        assert not fixture("/stats")["writes"]
        print("PASS declared model denies writes even when legacy options allow them")

        update = {"purpose": "fixture checks", "owner": "probe-oracle", "import": True,
                  "post": True, "actions": ["thread", "pin"]}
        updated = expect_status(request("/api/dc/config/channel/" + PARENT2, "POST", update, token), 200)
        assert updated["channels"][PARENT2]["owner"] == "probe-oracle"
        raw = expect_status(request("/api/dc/config.yaml", token=token, raw=True), 200)
        assert PARENT2 in raw and "probe-oracle" in raw
        expect_status(request("/api/dc/config/reload", "POST", {}, token), 200)
        assert {row["id"]: row["selected"] for row in channels(token)}[PARENT2] is True
        # Stop importing before fixture writes, then let any already queued empty poll finish.
        update["import"] = False
        expect_status(request("/api/dc/config/channel/" + PARENT2, "POST", update, token), 200)
        wait_idle(token)
        decisions = {verb: expect_status(api_channel(PARENT2, "/allowed?" + urlencode({"verb": verb}), token), 200)["allowed"]
                     for verb in ("post", "thread", "pin", "archive")}
        assert decisions == {"post": True, "thread": True, "pin": True, "archive": False}
        assert expect_status(api_channel(THREAD, "/allowed?verb=archive", token), 200)["allowed"] is True
        print("PASS row save -> canonical YAML -> reload -> selection; allowed verb gates")

        posted = expect_status(api_channel("proof-random", "/post", token, "POST", {"text": "fixture post"}), 201)
        expect_status(api_channel(PARENT2, "/pin", token, "POST", {"messageId": posted["id"]}), 200)
        expect_status(api_channel(PARENT2, "/thread", token, "POST", {"name": "fixture child", "starter": "fixture starter"}), 201)
        expect_status(api_channel(THREAD, "/archive", token, "POST", {}), 200)
        writes = fixture("/stats")["writes"]
        assert {row["kind"] for row in writes} >= {"message", "pin", "thread", "channel"}
        assert request("/api/discord/status")[1]["total"] == total_before
        print("PASS gated post/thread/pin/archive hit tokenless fixture only; PocketBase count unchanged")

        selected_before = {row["id"]: row["selected"] for row in channels(token)}[NEW_THREAD]
        queued = expect_status(api_channel(NEW_THREAD, "/import", token, "POST", {}), 202)
        assert queued["state"] == "queued"
        assert {row["id"]: row["selected"] for row in channels(token)}[NEW_THREAD] is selected_before
        wait_idle(token)
        assert json.loads(Path("/data/backfill-state.json").read_text())[NEW_THREAD] == "0"
        print("PASS explicit channel import completed without changing poll selection")
    finally:
        # Restore fixture Discord data before restoring a selected poll target.
        with urlopen(Request(FIXTURE + "/_fixture/restore-writes", method="POST", data=b"{}"), timeout=10) as response:
            assert response.status == 200
        # Restore database selection first while the temporary model still exists,
        # then restore the exact model/options bytes and reload without a restart.
        try:
            # PARENT2 is the only persistent selection row this probe changes.
            api_channel(PARENT2, "/select", token, "POST", {"on": original_selected[PARENT2]})
        finally:
            restore_file(CONFIG, original_config)
            OPTIONS.write_bytes(original_options)
            request("/api/dc/config/reload", "POST", {}, token)
            wait_idle(token)
    assert request("/api/discord/status")[1]["total"] == total_before
    print("DC PROBE PASS (model/options/selection restored; no live Discord)")


if __name__ == "__main__":
    main()
