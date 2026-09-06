#!/usr/bin/env python3
"""Fresh Discord history walker; only stdlib, secrets stay in process env."""
import fcntl, ipaddress, json, os, random, socket, sys, tempfile, time
from contextlib import contextmanager
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

API = os.getenv("DISCORD_API_BASE", "https://discord.com/api/v10").rstrip("/")
PB = os.getenv("POCKETBASE_URL", "http://127.0.0.1:8110").rstrip("/")
STATE_FILE = os.getenv("DISCORD_PB_STATE_FILE", "/data/backfill-state.json")
THREAD_TYPES = {10, 11, 12}

def fixture_requested():
    return os.getenv("DISCORD_PB_FIXTURE", "").lower() in {"1", "true", "yes"}

def fixture_mode_enabled():
    if not fixture_requested(): return False
    parsed = urlparse(API)
    if parsed.scheme != "http" or not parsed.hostname: return False
    if parsed.hostname == "localhost": return True
    try:
        address = ipaddress.ip_address(parsed.hostname)
        return address.is_private or address.is_loopback
    except ValueError:
        try:
            addresses = {ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo(parsed.hostname, parsed.port)}
            return bool(addresses) and all(address.is_private or address.is_loopback for address in addresses)
        except (OSError, ValueError):
            return False

def _retry_after(error):
    delays = []
    for header in ("Retry-After", "X-RateLimit-Reset-After"):
        try: delays.append(float(error.headers.get(header)))
        except (TypeError, ValueError): pass
    body = error.read()
    try: delays.append(float(json.loads(body.decode()).get("retry_after")))
    except (AttributeError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError): pass
    return max((delay for delay in delays if delay >= 0), default=None)

def request_json(url, headers, retries=5):
    for attempt in range(retries + 1):
        try:
            with urlopen(Request(url, headers=headers), timeout=60) as response: return json.load(response)
        except HTTPError as error:
            if not (error.code == 429 or 500 <= error.code < 600) or attempt == retries: raise
            specified = _retry_after(error)
            time.sleep((specified if specified is not None else 2 ** attempt) + random.random() * .25)

def snowflake(value, field):
    value = str(value)
    if not (17 <= len(value) <= 20 and value.isascii() and value.isdigit()):
        raise ValueError(f"invalid Discord snowflake in {field}: {value!r}")
    return value

def snowflake_timestamp(message_id):
    milliseconds = (int(message_id) >> 22) + 1420070400000
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).isoformat()

def channel_context(metadata):
    if not isinstance(metadata, dict): raise ValueError("Discord channel metadata must be an object")
    channel_id = snowflake(metadata.get("id"), "channel.id")
    guild_id = metadata.get("guild_id")
    if guild_id is not None: guild_id = snowflake(guild_id, "channel.guild_id")
    if metadata.get("type") in THREAD_TYPES:
        return {"channel_id": snowflake(metadata.get("parent_id"), "channel.parent_id"), "thread_id": channel_id, "guild_id": guild_id}
    return {"channel_id": channel_id, "thread_id": None, "guild_id": guild_id}

def normalize(message, context):
    if not isinstance(message, dict): raise ValueError("Discord message must be an object")
    message_id = snowflake(message.get("id"), "message.id")
    author = message.get("author") or {}
    if not isinstance(author, dict): raise ValueError(f"message {message_id} has malformed author")
    reply_to = (message.get("message_reference") or {}).get("message_id")
    if reply_to is not None: reply_to = snowflake(reply_to, "message.reply_to")
    return {
        "message_id": message_id, "channel_id": context["channel_id"], "thread_id": context["thread_id"],
        "guild_id": context["guild_id"], "author_id": snowflake(author.get("id"), "message.author.id"),
        "author_name": author.get("global_name") or author.get("username"), "author_is_bot": bool(author.get("bot")),
        "content": message.get("content"), "attachments_json": message.get("attachments") or [],
        "ts": message.get("timestamp") or snowflake_timestamp(message_id),
        "edited_timestamp": message.get("edited_timestamp"), "embeds": message.get("embeds") or [],
        "reply_to": reply_to, "raw": message,
    }

def post_batch(messages):
    body = json.dumps({"messages": messages}).encode()
    req = Request(PB + "/api/discord/internal/upsert", data=body, method="POST", headers={
        "Content-Type": "application/json", "X-Discord-PB-Token": os.environ["DISCORD_PB_INTERNAL_TOKEN"]})
    with urlopen(req, timeout=60) as response: result = json.load(response)
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise RuntimeError("PocketBase upsert response did not report success")
    counts = (result.get("received"), result.get("inserted"), result.get("updated"))
    if any(type(value) is not int or value < 0 for value in counts):
        raise RuntimeError("PocketBase upsert response has invalid counts")
    received, inserted, updated = counts
    if received != len(messages) or inserted + updated != len(messages):
        raise RuntimeError("PocketBase upsert response counts do not match request")
    return result

def discord_headers(token):
    if fixture_requested() and token:
        raise RuntimeError("DISCORD_PB_FIXTURE forbids DISCORD_BOT_TOKEN")
    headers = {"User-Agent": "discord-pb/0.1.0"}
    if token: headers["Authorization"] = "Bot " + token
    return headers

def load_state(path=STATE_FILE):
    try:
        with open(path, encoding="utf-8") as stream: state = json.load(stream)
    except FileNotFoundError:
        return {}
    if not isinstance(state, dict): raise ValueError("backfill state must be a JSON object")
    for channel, mark in state.items():
        snowflake(channel, "state channel")
        if not isinstance(mark, str): raise ValueError("state high-water mark must be a string")
        if mark != "0": snowflake(mark, "state high-water mark")
    return state

def save_state(state, path=STATE_FILE):
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".backfill-state.", dir=directory, text=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(state, stream, sort_keys=True, separators=(",", ":")); stream.write("\n")
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(directory, os.O_RDONLY)
        try: os.fsync(directory_fd)
        finally: os.close(directory_fd)
    finally:
        try: os.unlink(temporary)
        except FileNotFoundError: pass

@contextmanager
def state_lock(path=STATE_FILE):
    lock_path = path + ".lock"
    os.makedirs(os.path.dirname(lock_path) or ".", exist_ok=True)
    with open(lock_path, "a", encoding="utf-8") as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise RuntimeError("another discord_pb backfill is already running")
        yield

def backfill(channel, token, high_water=None):
    channel = snowflake(channel, "requested channel")
    if high_water is not None and high_water != "0": high_water = snowflake(high_water, "high-water mark")
    headers = discord_headers(token)
    context = channel_context(request_json(API + f"/channels/{channel}", headers))
    if (context["thread_id"] or context["channel_id"]) != channel: raise ValueError("Discord returned metadata for a different channel")
    mode = "incremental" if high_water is not None else "historical"
    cursor = high_water if high_water is not None else None
    maximum = int(high_water or 0)
    pages = inserted = updated = 0; seen_cursors = set()
    while True:
        query = {"limit": 100}
        if mode == "incremental": query["after"] = cursor
        elif cursor: query["before"] = cursor
        position = {"mode": mode, "channel_id": channel}
        position["after" if mode == "incremental" else "before"] = cursor if cursor is not None else "latest"
        path = f"/channels/{channel}/messages?{urlencode(query)}"
        position["request"] = path
        print(json.dumps(position, sort_keys=True), flush=True)
        page = request_json(API + path, headers)
        if not isinstance(page, list): raise ValueError("Discord messages response must be an array")
        if not page: break
        normalized = [normalize(message, context) for message in page]
        ids = [int(message["message_id"]) for message in normalized]
        if mode == "historical":
            if cursor is not None and any(message_id >= int(cursor) for message_id in ids):
                raise RuntimeError(f"Discord pagination did not advance before {cursor}")
            next_cursor = str(min(ids))
        else:
            if any(message_id <= int(cursor) for message_id in ids):
                raise RuntimeError(f"Discord pagination did not advance after {cursor}")
            next_cursor = str(max(ids))
        if next_cursor in seen_cursors: raise RuntimeError(f"Discord pagination repeated cursor {next_cursor}")
        result = post_batch(normalized)
        inserted += result["inserted"]; updated += result["updated"]; pages += 1
        maximum = max(maximum, max(ids)); seen_cursors.add(next_cursor); cursor = next_cursor
    result = {"channel_id": channel, "mode": mode, "pages": pages, "inserted": inserted,
              "updated": updated, "high_water": str(maximum)}
    print(json.dumps(result, sort_keys=True), flush=True)
    return result

def main():
    token = os.getenv("DISCORD_BOT_TOKEN", "")
    channels = [x.strip() for x in os.getenv("DISCORD_CHANNELS", "").split(",") if x.strip()]
    if fixture_requested() and token:
        raise RuntimeError("DISCORD_PB_FIXTURE forbids DISCORD_BOT_TOKEN")
    if not channels or (not token and not fixture_mode_enabled()):
        print("discord_pb: bot_token/channels absent; PocketBase stays available and backfill is idle", flush=True); return 0
    inserted = updated = 0; failures = []
    try:
        with state_lock(STATE_FILE):
            state = load_state(STATE_FILE)
            for channel in channels:
                try:
                    result = backfill(channel, token, state.get(channel))
                    candidate = dict(state); candidate[channel] = result["high_water"]
                    save_state(candidate, STATE_FILE); state = candidate
                    inserted += result["inserted"]; updated += result["updated"]
                except Exception as error:
                    failures.append({"channel_id": channel, "error": str(error)})
                    print(json.dumps({"channel_id": channel, "failed": True, "error": str(error)}, sort_keys=True), file=sys.stderr, flush=True)
    except Exception as error:
        failures.append({"channel_id": None, "error": str(error)})
    summary = {"complete": not failures, "inserted": inserted, "updated": updated,
               "channels": len(channels), "failures": failures}
    print(json.dumps(summary, sort_keys=True), flush=True)
    return 1 if failures else 0

if __name__ == "__main__": sys.exit(main())
