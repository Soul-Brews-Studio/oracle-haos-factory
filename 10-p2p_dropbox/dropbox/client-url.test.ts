import { expect, test } from "bun:test";
import { signalingClientUrl } from "./client-url";
test("CLI room defaults and query/env precedence; keys safely encoded", () => {
  const key = "fixture&?#";
  const parse = (source: string, room?: string) => new URL(signalingClientUrl(source, key, room));
  expect(parse("ws://localhost/ws").searchParams.get("room")).toBe("default");
  expect(parse("ws://localhost/ws?room=lab").searchParams.get("room")).toBe("lab");
  const url = parse("wss://localhost/ws?room=lab&token=old", "new-lab");
  expect(url.searchParams.get("room")).toBe("new-lab");
  expect(url.searchParams.get("key")).toBe(key);
  expect(url.searchParams.has("token")).toBeFalse();
  for (const room of ["a/b", "a b", "x".repeat(65)]) expect(() => parse("ws://localhost/ws", room)).toThrow("ROOM");
  expect(() => parse("https://localhost/ws")).toThrow("SIGNAL_URL");
  expect(() => parse("ws://user:password@localhost/ws")).toThrow("SIGNAL_URL");
});
