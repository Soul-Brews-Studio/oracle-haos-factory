#!/usr/bin/env python3
"""Hermetic default-entrypoint Docker proof. No live Discord/HA or bot credentials."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from readonly_archive import snapshot

SOURCE = "/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/messages.sqlite"
SELECTED = ["1485581352354054215", "1500433583255457863", "1515643997828153476"]
PARENT, THREAD, GUILD, AUTHOR, PARENT2 = [str(900000000000000000 + index) for index in range(5)]


def command(*args, input=None, timeout=120):
    result = subprocess.run(args, input=input, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(args[:3])}\n{result.stderr[-1500:]}")
    return result.stdout.strip()


def http(url, method="GET", data=None, headers=None):
    request = Request(url, method=method, headers=headers or {},
                      data=None if data is None else json.dumps(data).encode())
    try:
        response = urlopen(request, timeout=10)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read()
        try:
            value = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            value = raw.decode(errors="replace")
        return response.status, value, dict(response.headers)


def wait_for(check, seconds=45):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        try:
            if check():
                return
        except (URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(.2)
    raise AssertionError("bounded readiness/condition timed out")


def source_hashes(path):
    result = {}
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(str(path) + suffix)
        if candidate.exists():
            result[suffix or "main"] = hashlib.sha256(candidate.read_bytes()).hexdigest()
    return result


def make_fixture(path):
    data = {}
    expected_ids = set()
    with snapshot(path) as db:
        totals = db.execute("SELECT COUNT(*), COUNT(DISTINCT channel_id) FROM discord_messages").fetchone()
        for channel in SELECTED:
            rows = db.execute("SELECT message_id, channel_id, thread_id, guild_id, ts FROM discord_messages WHERE channel_id=?", (channel,)).fetchall()
            assert rows, f"source selected channel absent: {channel}"
            for row in rows:
                mid, parent, thread, guild, timestamp = row
                target = thread or parent
                metadata = {"id": target, "name": "archive-" + target, "type": 11 if thread else 0, "guild_id": guild}
                if thread:
                    metadata["parent_id"] = parent
                data.setdefault(target, {"metadata": metadata, "messages": []})["messages"].append({
                    "id": mid, "timestamp": timestamp,
                    "author": {"id": AUTHOR, "username": "Local proof"},
                    "content": "Token-free archive-count fixture (not live Discord content)",
                    "attachments": [], "embeds": []})
                expected_ids.add(mid)
    # Deliberately synthetic history: 205 parent messages + 3 thread replies.
    for target, length in ((PARENT, 205), (THREAD, 3)):
        metadata = {"id": target, "name": "proof-general" if target == PARENT else "proof-thread", "type": 0 if target == PARENT else 11, "guild_id": GUILD}
        if target == THREAD:
            metadata["parent_id"] = PARENT
            metadata["thread_metadata"] = {"archived": True, "archive_timestamp": "2026-09-05T00:00:00+00:00"}
        data[target] = {"metadata": metadata, "rate_limit": target == PARENT,
            "messages": [{"id": str(900000000100000000 + index + (1000 if target == THREAD else 0)),
                "author": {"id": AUTHOR, "global_name": "Proof ✓", "bot": True},
                "content": "<script>do not execute</script> Unicode ไทย 🚀", "attachments": [],
                "embeds": [{"title": "Preserved JSON"}], "timestamp": "2026-09-06T00:00:00.000Z"}
                for index in range(length)]}
    data[PARENT2] = {"metadata": {"id": PARENT2, "name": "proof-random", "type": 0, "guild_id": GUILD}, "messages": []}
    for channel in data.values():
        for message in channel["messages"]:
            # Message-level keys from ref-live-cli. Channel metadata stays on /channels/id.
            for key, value in {"type": 0, "mentions": [], "mention_roles": [], "flags": 0,
                               "components": [], "pinned": False, "mention_everyone": False,
                               "tts": False, "edited_timestamp": None}.items():
                message.setdefault(key, value)
    return data, expected_ids, totals


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", action="store_true", help="leave only this run for browser proof; cleanup using emitted command")
    parser.add_argument("--image", default="discord-pb:proof")
    args = parser.parse_args()
    run = "discord-proof-" + secrets.token_hex(4)
    network, fixture, app = run + "-net", run + "-api", run + "-app"
    artifacts = ROOT / "proof-local"
    artifacts.mkdir(exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=run + "-", dir=artifacts))
    os.chmod(temporary, 0o700)
    data_dir = temporary / "data"
    data_dir.mkdir()
    config = {"live": False, "auto_login": False, "auto_login_ha_admins": False, "auto_login_ha_user_ids": "proof-admin", "poll_minutes": 60,
              "admin_email": "proof@example.test", "admin_password": secrets.token_urlsafe(32)}
    source = Path(os.environ.get("SQLITE_DB", SOURCE))
    before_hash = source_hashes(source)
    data, expected_ids, totals = make_fixture(source)
    archive_targets = [key for key in data if key not in {PARENT, THREAD}]
    config["channels"] = ",".join(archive_targets)
    options = data_dir / "options.json"
    options.write_text(json.dumps(config))
    options.chmod(0o600)
    (temporary / "fixture.json").write_text(json.dumps(data))
    kept = False
    app_port, proxy_port = free_port(), free_port()
    report = []

    def log(message):
        print(message, flush=True)
        report.append(message)

    try:
        command("docker", "network", "create", network)
        command("docker", "run", "-d", "--name", fixture, "--network", network, "--network-alias", "fixture",
            "-p", f"127.0.0.1:{proxy_port}:18111", "--entrypoint", "python3",
            "-v", f"{ROOT / 'tests'}:/tests:ro", "-v", f"{temporary / 'fixture.json'}:/fixture.json:ro",
            "-e", "FIXTURE_JSON=/fixture.json", "-e", "APP_HOST=archive", args.image, "/tests/fixture_discord.py")
        peer = command("docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", fixture)
        command("docker", "run", "-d", "--name", app, "--network", network, "--network-alias", "archive",
            "-p", f"127.0.0.1:{app_port}:8110", "-v", f"{data_dir}:/data", "-v", f"{ROOT / 'tests'}:/tests:ro",
            "-e", f"DISCORD_PB_INGRESS_PEER={peer}", "-e", "DISCORD_PB_FIXTURE=true",
            "-e", "DISCORD_API_BASE=http://fixture:18080", args.image)
        port = command("docker", "port", app, "8110/tcp").split(":")[-1]
        ingress_port = command("docker", "port", fixture, "18111/tcp").split(":")[-1]
        base = "http://127.0.0.1:" + port
        ingress = "http://127.0.0.1:" + ingress_port + "/api/hassio_ingress/discord-proof/"
        wait_for(lambda: http(base + "/api/discord/status")[1].get("total") == len(expected_ids))
        log(f"SOURCE rows={totals[0]} channels={totals[1]}")
        log("PASS default /init -> /run.sh -> service.py -> scheduled backfill (no bot token)")
        wait_for(lambda: '"complete": true' in command("docker", "logs", app))
        first_log = command("docker", "logs", app)
        assert '"inserted": 6' in first_log
        assert "__pb_superuser_auth__" not in first_log and "_/#/pbinst" not in first_log

        def auth():
            status, result, _ = http(base + "/api/collections/_superusers/auth-with-password", "POST",
                {"identity": config["admin_email"], "password": config["admin_password"]}, {"Content-Type": "application/json"})
            assert status == 200
            return {"Authorization": result["token"], "Content-Type": "application/json"}

        credentials = auth()

        def records(filter_value=None):
            query = {"perPage": 500}
            if filter_value:
                query["filter"] = filter_value
            status, result, _ = http(base + "/api/collections/discord_messages/records?" + urlencode(query), headers=credentials)
            assert status == 200
            return result["items"]

        original = records()
        assert {row["message_id"] for row in original} == expected_ids
        schema = http(base + "/api/collections/discord_messages", headers=credentials)[1]
        required = {"message_id", "channel_id", "thread_id", "guild_id", "author_id", "author_name", "author_is_bot",
                    "content", "attachments_json", "ts", "routed_to", "routed_at", "created_at"}
        assert required <= {field["name"] for field in schema["fields"]}
        assert all(schema[key] is None for key in ("listRule", "viewRule", "createRule", "updateRule", "deleteRule"))
        unauth = http(base + "/api/collections/discord_messages/records")[1]
        assert unauth.get("totalItems", 0) == 0
        log("PASS 13 source columns preserved + private rules + exact archive message IDs")
        verify_env = os.environ.copy()
        verify_env.update(CHANNELS=",".join(SELECTED), PB_URL=base, SQLITE_DB=str(source))
        verify = subprocess.run([str(ROOT / "verify.sh")], env=verify_env, capture_output=True, text=True, timeout=60)
        assert verify.returncode == 0, verify.stderr + verify.stdout
        log("VERIFY COMMAND: CHANNELS=" + ",".join(SELECTED) + " PB_URL=" + base + " SQLITE_DB=" + str(source) + " ./verify.sh")
        log(verify.stdout.rstrip())
        (artifacts / "verify-output.txt").write_text(verify.stdout)

        def backfill(targets):
            output = command("docker", "exec", app, "python3", "/tests/container_probe.py", "backfill",
                             "http://fixture:18080", ",".join(targets))
            if targets == archive_targets:
                log(output)
            result = json.loads(output.splitlines()[-1])
            assert result["complete"] is True
            return result

        log("SECOND ARCHIVE RUN (must use after=):")
        assert backfill(archive_targets)["inserted"] == 0
        query_stats = json.loads(command("docker", "exec", fixture, "wget", "-qO-", "http://127.0.0.1:18080/stats"))
        assert {item["channel"] for item in query_stats["after_requests"]} >= set(archive_targets)
        verify_again = subprocess.run([str(ROOT / "verify.sh")], env=verify_env, capture_output=True, text=True, timeout=60)
        assert verify_again.returncode == 0
        log(verify_again.stdout.rstrip())
        assert {row["message_id"]: row["created_at"] for row in records()} == {row["message_id"]: row["created_at"] for row in original}
        log("PASS second archive run inserted=0; created_at unchanged")
        synthetic = backfill([PARENT, THREAD])
        assert synthetic["inserted"] == 208
        synthetic_rows = records(f'channel_id="{PARENT}"')
        assert len(synthetic_rows) == 208
        assert sum(row["thread_id"] == THREAD for row in synthetic_rows) == 3
        assert all(row["guild_id"] == GUILD for row in synthetic_rows)
        stats = json.loads(command("docker", "exec", fixture, "wget", "-qO-", "http://127.0.0.1:18080/stats"))
        assert stats["rate_limits"] == 1 and stats["retry_wait"] >= .12 and stats["authorization_headers"] == 0
        log("PASS synthetic 205+3 thread messages; >100 pagination; HTTP 429 waited >=0.12s; Authorization headers=0")
        assert backfill([PARENT, THREAD])["inserted"] == 0
        log("PASS second synthetic run inserted=0")
        guild_output = command("docker", "exec", app, "python3", "/tests/container_probe.py", "guild",
                               "http://fixture:18080", "Proof Guild")
        assert json.loads(guild_output.splitlines()[-1])["complete"] is True
        entity_rows = http(base + "/api/collections/discord_entities/records?" + urlencode({"perPage": 500}), headers=credentials)[1]["items"]
        proof_entities = [row for row in entity_rows if row["guild_id"] == GUILD]
        assert {(row["kind"], row["name"]) for row in proof_entities} >= {
            ("guild", "Proof Guild"), ("channel", "proof-general"),
            ("channel", "proof-random"), ("thread", "proof-thread")}
        by_id = {row["entity_id"]: row for row in proof_entities}
        assert by_id[PARENT]["parent_id"] == GUILD and by_id[PARENT2]["parent_id"] == GUILD
        assert by_id[THREAD]["parent_id"] == PARENT and by_id[THREAD]["archived"] is True
        assert not by_id[GUILD]["parent_id"]
        log("PASS named guild: 2 channels + 1 archived thread; channel→guild/thread→channel hierarchy")
        repeat_guild = command("docker", "exec", app, "python3", "/tests/container_probe.py", "guild",
                               "http://fixture:18080", "Proof Guild", "proof-general")
        repeated = json.loads(repeat_guild.splitlines()[-1])
        assert repeated["complete"] is True and repeated["inserted"] == 0 and repeated["channels"] == 2
        state = json.loads(command("docker", "exec", app, "cat", "/data/backfill-state.json"))
        assert "900000000000000005" not in state
        discovered = http(base + "/api/collections/discord_entities/records?" + urlencode({"filter": 'entity_id="900000000000000005"'}), headers=credentials)[1]["items"]
        assert discovered[0]["name"] == "proof-new-thread" and discovered[0]["parent_id"] == PARENT2
        log("PASS next guild poll lists new thread without importing it; only 2 selected channels polled; inserted=0")
        lookup_proof = command("docker", "exec", app, "python3", "/tests/container_probe.py", "entity-pages")
        assert lookup_proof == "PASS 502 entities: chunked upsert; later-page exact/ambiguous/Unicode/missing lookup"
        log(lookup_proof)

        # Edit updates content without erasing server-owned routing/creation fields.
        item = original[0]
        status, _, _ = http(base + "/api/collections/discord_messages/records/" + item["id"], "PATCH",
            {"routed_to": "proof:1", "routed_at": "2026-09-06 00:00:00.000Z"}, credentials)
        assert status == 200
        spec = importlib.util.spec_from_file_location("backfill", ROOT / "backfill.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        edited_message = dict(item["raw"], content="Edited locally", edited_timestamp="2026-09-06T01:00:00.000Z")
        metadata = data[item["thread_id"] or item["channel_id"]]["metadata"]
        normalized = module.normalize(edited_message, module.channel_context(metadata))

        def upsert(rows):
            return json.loads(command("docker", "exec", "-i", app, "python3", "/tests/container_probe.py", "upsert", input=json.dumps(rows)))

        assert upsert([normalized])["body"]["updated"] == 1
        changed = records(f'message_id="{item["message_id"]}"')[0]
        assert changed["content"] == "Edited locally" and changed["routed_to"] == "proof:1" and changed["created_at"] == item["created_at"]
        log("PASS edits update content; created_at/routing preserved")
        total_before = http(base + "/api/discord/status")[1]["total"]
        bad = dict(normalized, message_id="900000000200000002", ts="not-a-date")
        good = dict(normalized, message_id="900000000200000001")
        assert upsert([good, bad])["status"] >= 400
        assert http(base + "/api/discord/status")[1]["total"] == total_before
        assert upsert([dict(normalized, id="attacker-id")])["status"] == 400
        assert upsert([{}])["status"] == 400
        log("PASS invalid batch rolls back all rows; unknown fields/missing IDs rejected")
        direct_status = http(base + "/api/discord/internal/upsert", "POST", {"messages": []}, {"Content-Type": "application/json"})[0]
        assert direct_status == 401
        log("PASS internal ingest rejects external/missing credentials")

        assert http(ingress + "api/discord/admin-token", "POST")[0] == 403
        config["auto_login"] = True
        options.write_text(json.dumps(config))
        previous_runs = command("docker", "logs", app).count('"complete": true')
        command("docker", "restart", app)
        wait_for(lambda: http(base + "/api/health")[0] == 200)
        wait_for(lambda: command("docker", "logs", app).count('"complete": true') > previous_runs)
        credentials = auth()
        assert http(base + "/api/discord/status")[1]["total"] == total_before
        assert backfill(archive_targets + [PARENT, THREAD])["inserted"] == 0
        log("PASS restart persists 214 fixture rows; post-restart replay inserted=0")
        spoofed = {"X-Forwarded-For": peer, "X-Ingress-Path": "/api/hassio_ingress/discord-proof", "X-Remote-User-Id": "proof-admin"}
        assert http(base + "/api/discord/admin-token", "POST", headers=spoofed)[0] == 403
        denied_status, denied, _ = http(ingress + "api/discord/admin-token", "POST",
            headers={"X-Proof-User": "untrusted-user", "X-Proof-User-Name": "Untrusted User"})
        assert denied_status == 403
        assert denied["haUser"] == {"id": "untrusted-user", "name": "Untrusted User"}
        assert denied["allowlistOption"] == "auto_login_ha_user_ids"
        status, token_data, headers = http(ingress + "api/discord/admin-token", "POST")
        assert status == 200, (status, token_data)
        assert token_data["key"] == "__dc_superuser_auth__" and headers["Cache-Control"] == "no-store"
        assert http(base + "/api/collections/discord_messages/records?perPage=1", headers={"Authorization": token_data["token"]})[0] == 200
        config["auto_login_ha_admins"] = True
        config["auto_login_ha_user_ids"] = ""
        options.write_text(json.dumps(config))
        command("docker", "restart", app)
        wait_for(lambda: http(base + "/api/health")[0] == 200)
        assert http(ingress + "api/discord/admin-token", "POST",
                    headers={"X-Proof-User": "another-admin"})[0] == 200
        log("PASS auto_login off=403; direct/spoofed/non-allowlisted=403 with HA identity; allowlisted=200; panel-admin opt-in=200; no-store")
        log(command("docker", "exec", app, "python3", "/tests/dc_probe.py"))
        log(command("docker", "exec", app, "python3", "/tests/live_probe.py"))
        sdk_env = dict(os.environ, PB_URL=base, PB_SUPERUSER_TOKEN=auth()["Authorization"])
        sdk = subprocess.run(["bun", "tests/realtime_probe.ts"], cwd=ROOT, env=sdk_env,
                             capture_output=True, text=True, timeout=30)
        assert sdk.returncode == 0, sdk.stdout + sdk.stderr
        log(sdk.stdout.rstrip())
        after_hash = source_hashes(source)
        assert before_hash == after_hash, "Source archive changed during proof (could be external writer); rerun for integrity proof"
        log("PASS source DB/WAL/SHM SHA256 unchanged")
        log("PASS source snapshot test is NOT live Discord or real Supervisor ingress proof")
        if args.keep:
            metadata = {"app": app, "fixture": fixture, "network": network, "data_dir": str(data_dir),
                        "temporary": str(temporary), "url": ingress, "direct_url": base, "image": args.image}
            (artifacts / "browser-run.json").write_text(json.dumps(metadata, indent=2))
            kept = True
            log("BROWSER URL: " + ingress)
            log("CLEANUP: docker stop " + app + " " + fixture + " && docker rm " + app + " " + fixture + " && docker network rm " + network)
        log("LOCAL PROOF PASS")
    finally:
        result = subprocess.run(["docker", "logs", app], capture_output=True, text=True, timeout=10)
        (artifacts / "container.log").write_text(result.stdout + result.stderr)
        (artifacts / "local-proof.txt").write_text("\n".join(report) + "\n")
        if not kept:
            for name in (app, fixture):
                subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=20)
            subprocess.run(["docker", "network", "rm", network], capture_output=True, timeout=20)
            import shutil
            shutil.rmtree(temporary)


if __name__ == "__main__":
    main()
