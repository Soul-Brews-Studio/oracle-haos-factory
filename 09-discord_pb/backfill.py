#!/usr/bin/env python3
"""Fresh Discord history walker; only stdlib, secrets stay in process env."""
import json, os, random, sys, time
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

API = os.getenv("DISCORD_API_BASE", "https://discord.com/api/v10").rstrip("/")
PB = os.getenv("POCKETBASE_URL", "http://127.0.0.1:8110").rstrip("/")

def request_json(url, headers, retries=5):
    for attempt in range(retries + 1):
        try:
            with urlopen(Request(url, headers=headers), timeout=60) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code != 429 and error.code < 500: raise
            if attempt == retries: raise
            retry = error.headers.get("Retry-After")
            delay = min(float(retry) if retry else 2 ** attempt, 60) + random.random() * .25
            error.read(); time.sleep(delay)

def normalize(message, requested_channel):
    author = message.get("author") or {}
    channel = message.get("channel_id") or requested_channel
    thread = message.get("thread_id")
    return {
        "message_id": message["id"], "channel_id": message.get("parent_id") or channel,
        "thread_id": thread, "guild_id": message.get("guild_id"),
        "author_id": author.get("id") or "unknown",
        "author_name": author.get("global_name") or author.get("username"),
        "author_is_bot": bool(author.get("bot")), "content": message.get("content"),
        "attachments_json": message.get("attachments") or [],
        "ts": message.get("timestamp") or datetime.now(timezone.utc).isoformat(),
        "routed_to": None, "routed_at": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "edited_timestamp": message.get("edited_timestamp"), "embeds": message.get("embeds") or [],
        "reply_to": ((message.get("message_reference") or {}).get("message_id")), "raw": message,
    }

def post_batch(messages):
    body = json.dumps({"messages": messages}).encode()
    req = Request(PB + "/api/discord/internal/upsert", data=body, method="POST", headers={
        "Content-Type": "application/json", "X-Discord-PB-Token": os.environ["DISCORD_PB_INTERNAL_TOKEN"]})
    with urlopen(req, timeout=60) as response: return json.load(response)

def backfill(channel, token):
    before = None; pages = inserted = updated = 0
    while True:
        query = {"limit": 100}
        if before: query["before"] = before
        path = f"/channels/{channel}/messages?{urlencode(query)}"
        page = request_json(API + path, {"Authorization": "Bot " + token, "User-Agent": "discord-pb/0.1.0"})
        if not page: break
        result = post_batch([normalize(m, channel) for m in page])
        inserted += result["inserted"]; updated += result["updated"]; pages += 1
        before = page[-1]["id"]
        if len(page) < 100: break
    print(json.dumps({"channel_id": channel, "pages": pages, "inserted": inserted, "updated": updated}, sort_keys=True), flush=True)
    return inserted

def main():
    token = os.getenv("DISCORD_BOT_TOKEN", "")
    channels = [x.strip() for x in os.getenv("DISCORD_CHANNELS", "").split(",") if x.strip()]
    if not token or not channels:
        print("discord_pb: bot_token/channels absent; PocketBase stays available and backfill is idle", flush=True); return 0
    total = sum(backfill(channel, token) for channel in channels)
    print(json.dumps({"complete": True, "inserted": total, "channels": len(channels)}, sort_keys=True), flush=True)
    return 0

if __name__ == "__main__": sys.exit(main())
