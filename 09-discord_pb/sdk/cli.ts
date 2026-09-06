#!/usr/bin/env bun
import {createDC, type ReadOptions} from "./dc.ts";

export type CLICommand =
  | {kind: "channels"}
  | {kind: "guild"; guild: string}
  | {kind: "config"; action: "get" | "download"}
  | {kind: "channel"; channel: string; action: string; args: string[]; read: ReadOptions};

function usage(message?: string): never {
  const prefix = message ? message + "\n\n" : "";
  throw new Error(prefix + [
    "Usage:",
    "  bun sdk/cli.ts channels",
    "  bun sdk/cli.ts guild <id-or-name> channels",
    "  bun sdk/cli.ts config [get|download]",
    "  bun sdk/cli.ts channel <id-or-name> read [--limit N] [--since ISO] [--before ISO]",
    "  bun sdk/cli.ts channel <id-or-name> tail",
    "  bun sdk/cli.ts channel <id-or-name> import",
    "  bun sdk/cli.ts channel <id-or-name> post <text>",
    "  bun sdk/cli.ts channel <id-or-name> thread <name> <starter>",
    "  bun sdk/cli.ts channel <id-or-name> pin <message-id>",
    "  bun sdk/cli.ts channel <id-or-name> archive",
  ].join("\n"));
}

export function parseCLI(args: string[]): CLICommand {
  if (args[0] === "channels" && args.length === 1) return {kind: "channels"};
  if (args[0] === "config" && args.length <= 2) {
    const action = args[1] || "get";
    if (action !== "get" && action !== "download") usage("Unknown config action: " + action);
    return {kind: "config", action};
  }
  if (args[0] === "guild" && args[1] && args[2] === "channels" && args.length === 3) {
    return {kind: "guild", guild: args[1]};
  }
  if (args[0] !== "channel" || !args[1] || !args[2]) usage("Missing channel command");
  const [, channel, action, ...rest] = args;
  const allowed = new Set(["read", "tail", "import", "post", "thread", "pin", "archive"]);
  if (!allowed.has(action)) usage("Unknown channel action: " + action);
  const read: ReadOptions = {};
  if (action === "read") {
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i], value = rest[i + 1];
      if (!value || !["--limit", "--since", "--before"].includes(flag)) usage("Invalid read option: " + (flag || ""));
      if (flag === "--limit") {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1) usage("--limit must be a positive integer");
        read.limit = limit;
      } else if (flag === "--since") read.since = value;
      else read.before = value;
    }
  } else {
    const expected: Record<string, number> = {tail: 0, import: 0, post: 1, thread: 2, pin: 1, archive: 0};
    if (rest.length !== expected[action]) usage(action + " expects " + expected[action] + " argument(s)");
  }
  return {kind: "channel", channel, action, args: action === "read" ? [] : rest, read};
}

export function run(command: CLICommand, client: ReturnType<typeof createDC>) {
  if (command.kind === "channels") return client.channels();
  if (command.kind === "guild") return client.guild(command.guild).channels();
  if (command.kind === "config") return command.action === "download" ? client.configYaml() : client.config();
  const handle = client.channel(command.channel);
  if (command.action === "read") return handle.read(command.read);
  if (command.action === "tail") return handle.stream((record, action) => {
    console.log(JSON.stringify({action, record}));
  });
  if (command.action === "import") return handle.import();
  if (command.action === "post") return handle.post(command.args[0]);
  if (command.action === "thread") return handle.action.thread(command.args[0], command.args[1]);
  if (command.action === "pin") return handle.action.pin(command.args[0]);
  return handle.action.archive();
}

if (import.meta.main) {
  try {
    const command = parseCLI(Bun.argv.slice(2));
    const baseUrl = Bun.env.DC_URL || "";
    const token = Bun.env.DC_TOKEN || "";
    const result = await run(command, createDC({baseUrl, token}));
    if (command.kind === "channel" && command.action === "tail") {
      if (!result || typeof result !== "object" || !("ready" in result) || !("done" in result)) throw new Error("Realtime tail did not start");
      const stream = result as {ready: Promise<void>; done: Promise<void>; close(): void};
      const stop = () => stream.close();
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      await stream.ready;
      console.error("Live tail connected. Press Ctrl-C to stop.");
      await stream.done;
    } else if (command.kind === "config" && command.action === "download") {
      if (typeof result !== "string") throw new Error("Config YAML response was not text");
      await Bun.write("dc.config.yaml", result);
      console.log("dc.config.yaml");
    } else console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
