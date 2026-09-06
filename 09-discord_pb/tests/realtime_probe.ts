#!/usr/bin/env bun
import {createDC, type DiscordMessage, type RealtimeAction} from "../sdk/dc.ts";

const baseUrl = (Bun.env.PB_URL || Bun.env.DC_URL || "").replace(/\/+$/, "");
const token = Bun.env.PB_SUPERUSER_TOKEN || Bun.env.DC_TOKEN || "";
if (!baseUrl || !token) throw new Error("PB_URL and PB_SUPERUSER_TOKEN are required");

const headers = {Authorization: token, "Content-Type": "application/json"};

async function json(path: string, init: RequestInit = {}) {
  const response = await fetch(baseUrl + path, {...init, headers: {...headers, ...(init.headers || {})}});
  const text = await response.text();
  let data: any = null;
  if (text) { try { data = JSON.parse(text); } catch (_) {} }
  if (!response.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${response.status} for ${path}`);
  if (text && data === null) throw new Error(`non-JSON response for ${path}`);
  return data;
}

const snowflakeBase = 800000000000000000n + BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 700));
function snowflake(offset: number): string { return String(snowflakeBase + BigInt(offset)); }

async function main() {
  const listed = await json("/api/dc/channels");
  const rows = Array.isArray(listed) ? listed : listed?.channels;
  if (!Array.isArray(rows)) throw new Error("channel list was not an array");
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(String(row.name).toLocaleLowerCase(), (counts.get(String(row.name).toLocaleLowerCase()) || 0) + 1);
  const channel = rows.find(row => row.kind !== "thread" && row.importable !== false && counts.get(String(row.name).toLocaleLowerCase()) === 1);
  if (!channel) throw new Error("fixture has no uniquely named importable channel");

  const normalId = snowflake(1), childId = snowflake(2), threadId = snowflake(3);
  const synthetic = new Set([normalId, childId]);
  const events: Array<{record: DiscordMessage; action: RealtimeAction}> = [];
  const client = createDC({baseUrl, token});
  const stream = client.channel(channel.name).stream((record, action) => events.push({record, action}));

  const waitFor = async (predicate: (event: typeof events[number]) => boolean, label: string) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = events.find(predicate);
      if (found) return found;
      await Bun.sleep(25);
    }
    throw new Error(`timed out waiting for realtime ${label}`);
  };
  const message = (message_id: string, content: string, thread_id: string | null = null, raw: Record<string, unknown> = {}) => ({
    message_id, channel_id: String(channel.id), thread_id, guild_id: channel.guild_id || null,
    author_id: "800000000000000099", author_name: "realtime-probe", author_is_bot: true,
    content, attachments_json: [], embeds: [], ts: new Date().toISOString(), raw,
  });

  try {
    await stream.ready;
    await json("/api/discord/import", {method: "POST", body: JSON.stringify({messages: [
      message(normalId, "realtime create"), message(childId, "child must not leak", threadId),
    ]})});
    await waitFor(event => event.action === "create" && event.record.message_id === normalId, "create");
    await Bun.sleep(150);
    if (events.some(event => event.record.message_id === childId)) throw new Error("parent channel stream leaked a child-thread message");

    await json("/api/discord/import", {method: "POST", body: JSON.stringify({messages: [message(normalId, "realtime update")]})});
    await waitFor(event => event.action === "update" && event.record.message_id === normalId && event.record.content === "realtime update", "update");

    const deletedRaw = {_discord_pb_deleted: true, _discord_pb_deleted_at: new Date().toISOString()};
    await json("/api/discord/import", {method: "POST", body: JSON.stringify({messages: [message(normalId, "", null, deletedRaw)]})});
    await waitFor(event => event.record.message_id === normalId && event.record.raw?._discord_pb_deleted === true, "tombstone");
    console.log(`REALTIME PROBE PASS channel=${channel.name} create update thread-filter tombstone`);
  } finally {
    stream.close();
    await stream.done.catch(() => {});
    const query = new URLSearchParams({perPage: "10", filter: [...synthetic].map(id => `message_id=${JSON.stringify(id)}`).join(" || ")});
    try {
      const found = await json("/api/collections/discord_messages/records?" + query);
      for (const record of found.items || []) {
        await json("/api/collections/discord_messages/records/" + encodeURIComponent(record.id), {method: "DELETE"});
      }
    } catch (error) {
      console.error("WARNING realtime probe cleanup failed:", error instanceof Error ? error.message : String(error));
    }
  }
}

await main();
