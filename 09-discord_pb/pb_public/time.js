"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DCTime = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  const TIME_ZONE = "Asia/Bangkok";
  const OFFSET = "+07";
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE, weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function date(value) {
    if (value === null || value === undefined || value === "") return null;
    const normalized = typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value) ? value.replace(" ", "T") : value;
    const result = normalized instanceof Date ? normalized : new Date(normalized);
    return Number.isNaN(result.getTime()) ? null : result;
  }
  function iso(value) { const parsed = date(value); return parsed ? parsed.toISOString() : String(value || ""); }
  function absolute(value) {
    const parsed = date(value);
    if (!parsed) return String(value || "Unknown time");
    const p = Object.fromEntries(formatter.formatToParts(parsed).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    const n = numericParts(parsed);
    return `${p.weekday} ${Number(p.day)} ${MONTHS[Number(n.month) - 1]} ${p.year}, ${p.hour}:${p.minute}:${p.second} ${OFFSET}`;
  }
  // formatToParts exposes a localized month name, so derive numeric Bangkok parts
  // independently to keep date input values stable.
  const numeric = new Intl.DateTimeFormat("en-CA", {timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"});
  function numericParts(value) {
    const parsed = date(value); if (!parsed) return null;
    return Object.fromEntries(numeric.formatToParts(parsed).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  }
  function bangkokDay(value) {
    const p = numericParts(value); return p ? `${p.year}-${p.month}-${p.day}` : "";
  }
  function dayLabel(value) {
    const parsed = date(value); if (!parsed) return String(value || "Unknown date");
    const p = Object.fromEntries(formatter.formatToParts(parsed).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    const n = numericParts(parsed);
    return `${p.weekday} ${Number(p.day)} ${MONTHS[Number(n.month) - 1]} ${p.year}`;
  }
  function bounds(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Choose a valid date.");
    const since = new Date(day + "T00:00:00+07:00");
    if (Number.isNaN(since.getTime()) || bangkokDay(since) !== day) throw new Error("Choose a valid date.");
    const before = new Date(since.getTime() + 86400000);
    return {since: since.toISOString(), before: before.toISOString()};
  }
  function relative(value, now = Date.now()) {
    const parsed = date(value); if (!parsed) return "unknown time";
    const seconds = Math.round((Number(now) - parsed.getTime()) / 1000);
    const future = seconds < 0, elapsed = Math.abs(seconds);
    let amount, unit;
    if (elapsed < 45) return future ? "in a moment" : "just now";
    if (elapsed < 3600) { amount = Math.round(elapsed / 60); unit = "min"; }
    else if (elapsed < 86400) { amount = Math.round(elapsed / 3600); unit = "hr"; }
    else if (elapsed < 2592000) { amount = Math.round(elapsed / 86400); unit = "day"; }
    else if (elapsed < 31536000) { amount = Math.round(elapsed / 2592000); unit = "mo"; }
    else { amount = Math.round(elapsed / 31536000); unit = "yr"; }
    return future ? `in ${amount} ${unit}` : `${amount} ${unit} ago`;
  }
  return {TIME_ZONE, absolute, bangkokDay, bounds, dayLabel, iso, relative};
});
