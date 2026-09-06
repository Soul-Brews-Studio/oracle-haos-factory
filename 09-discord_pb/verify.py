#!/usr/bin/env python3
"""Compare exact per-channel counts in the m5 archive and PocketBase."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from readonly_archive import SnapshotError, snapshot


CHANNEL_ID = re.compile(r"^[0-9]{17,20}$")


class VerificationError(RuntimeError):
    pass


def archive_counts(connection: sqlite3.Connection) -> dict[str, int]:
    try:
        rows = connection.execute(
            "SELECT channel_id, COUNT(*) FROM discord_messages "
            "GROUP BY channel_id ORDER BY channel_id"
        ).fetchall()
    except sqlite3.Error as error:
        raise VerificationError(f"cannot count archive channels: {error}") from error
    counts: dict[str, int] = {}
    for channel_id, count in rows:
        if not isinstance(channel_id, str) or not CHANNEL_ID.fullmatch(channel_id):
            raise VerificationError(f"archive contains invalid channel_id: {channel_id!r}")
        if channel_id in counts:
            raise VerificationError(f"archive contains duplicate grouped channel: {channel_id}")
        counts[channel_id] = int(count)
    return counts


def fetch_status(pb_url: str, timeout: float = 10.0) -> object:
    url = f"{pb_url.rstrip('/')}/api/discord/status"
    try:
        with urlopen(url, timeout=timeout) as response:
            return json.load(response)
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, UnicodeError, OSError) as error:
        raise VerificationError(f"cannot read PocketBase status from {url}: {error}") from error


def status_counts(payload: object) -> tuple[dict[str, int], dict[str, str], int]:
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise VerificationError("PocketBase status must be an object with ok=true")
    total = payload.get("total")
    channels = payload.get("channels")
    if isinstance(total, bool) or not isinstance(total, int) or total < 0:
        raise VerificationError("PocketBase status total must be a non-negative integer")
    if not isinstance(channels, list):
        raise VerificationError("PocketBase status channels must be an array")

    counts: dict[str, int] = {}
    names: dict[str, str] = {}
    for index, item in enumerate(channels):
        if not isinstance(item, dict):
            raise VerificationError(f"PocketBase status channel {index} must be an object")
        channel_id = item.get("channel_id")
        count = item.get("count")
        if not isinstance(channel_id, str) or not CHANNEL_ID.fullmatch(channel_id):
            raise VerificationError(f"PocketBase status channel {index} has invalid channel_id")
        if channel_id in counts:
            raise VerificationError(f"PocketBase status has duplicate channel_id: {channel_id}")
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise VerificationError(f"PocketBase status count for {channel_id} must be a non-negative integer")
        counts[channel_id] = count
        name = item.get("name", "")
        if not isinstance(name, str): raise VerificationError(f"PocketBase status name for {channel_id} must be a string")
        names[channel_id] = name
    if sum(counts.values()) != total:
        raise VerificationError(
            f"PocketBase status total {total} does not equal channel sum {sum(counts.values())}"
        )
    return counts, names, total


def selected_channels(raw: str, archive: dict[str, int], pocketbase: dict[str, int], names: dict[str, str] | None = None) -> list[str]:
    if raw == "all":
        selected = sorted(set(archive) | set(pocketbase), key=int)
        if not selected:
            raise VerificationError("CHANNELS=all found no channels")
        return selected
    if not raw or raw.strip() != raw:
        raise VerificationError("CHANNELS must be 'all' or a comma-separated list without whitespace")
    selected = raw.split(",")
    resolved = []
    for item in selected:
        if CHANNEL_ID.fullmatch(item): resolved.append(item); continue
        matches = [(cid, name) for cid, name in (names or {}).items() if name.casefold() == item.casefold()]
        exact = [pair for pair in matches if pair[1] == item]
        chosen = exact or matches
        if len(chosen) != 1:
            candidates = ", ".join(f"{name} ({cid})" for cid, name in matches) or "none"
            reason = "ambiguous" if matches else "missing"
            raise VerificationError(f"CHANNELS name {item!r} is {reason}; candidates: {candidates}")
        resolved.append(chosen[0][0])
    selected = resolved
    if len(set(selected)) != len(selected):
        raise VerificationError("CHANNELS contains duplicate channel IDs")
    known = set(archive) | set(pocketbase)
    unknown = [item for item in selected if item not in known]
    if unknown:
        raise VerificationError(f"CHANNELS contains unknown channel ID(s): {','.join(unknown)}")
    return selected


def verify(sqlite_db: str, pb_url: str, channels: str, timeout: float = 10.0) -> int:
    payload = fetch_status(pb_url, timeout)
    pb_counts, names, _ = status_counts(payload)
    with snapshot(sqlite_db) as connection:
        source_counts = archive_counts(connection)

    selected = selected_channels(channels, source_counts, pb_counts, names)
    source_total = 0
    pb_total = 0
    mismatch = False
    print("name channel_id sqlite pocketbase result")
    for channel_id in selected:
        expected = source_counts.get(channel_id, 0)
        actual = pb_counts.get(channel_id, 0)
        source_total += expected
        pb_total += actual
        result = "OK" if expected == actual else "MISMATCH"
        mismatch |= result != "OK"
        print(f"{names.get(channel_id) or '-'} {channel_id} {expected} {actual} {result}")
    total_result = "OK" if source_total == pb_total else "MISMATCH"
    mismatch |= total_result != "OK"
    print(f"TOTAL {source_total} {pb_total} {total_result}")
    return 1 if mismatch else 0


def main() -> int:
    try:
        timeout = float(os.environ.get("HTTP_TIMEOUT", "10"))
        if timeout <= 0:
            raise ValueError
    except ValueError:
        print("verify: HTTP_TIMEOUT must be a positive number", file=sys.stderr)
        return 2
    try:
        return verify(
            os.environ.get(
                "SQLITE_DB",
                "/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/messages.sqlite",
            ),
            os.environ.get("PB_URL", "http://127.0.0.1:8110"),
            os.environ.get("CHANNELS", ""),
            timeout,
        )
    except (VerificationError, SnapshotError) as error:
        print(f"verify: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
