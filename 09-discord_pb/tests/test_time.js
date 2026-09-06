"use strict";
const assert = require("node:assert/strict");
const time = require("../pb_public/time.js");

assert.equal(time.TIME_ZONE, "Asia/Bangkok");
assert.equal(time.bangkokDay("2026-09-05T17:00:00.000Z"), "2026-09-06");
assert.equal(time.dayLabel("2026-09-05T17:00:00.000Z"), "Sun 6 Sep 2026");
assert.equal(time.absolute("2026-09-05T17:00:00.000Z"), "Sun 6 Sep 2026, 00:00:00 +07");
assert.deepEqual(time.bounds("2026-09-06"), {
  since: "2026-09-05T17:00:00.000Z", before: "2026-09-06T17:00:00.000Z"
});
assert.deepEqual(time.bounds("2028-02-29"), {
  since: "2028-02-28T17:00:00.000Z", before: "2028-02-29T17:00:00.000Z"
});
const now = Date.parse("2026-09-06T01:00:00.000Z");
assert.equal(time.relative("2026-09-06T00:58:31.000Z", now), "1 min ago");
assert.equal(time.relative("2026-09-05T23:00:00.000Z", now), "2 hr ago");
assert.equal(time.relative("2026-09-06T01:02:00.000Z", now), "in 2 min");
assert.equal(time.absolute(null), "Unknown time");
assert.equal(time.iso("2026-09-06 01:02:03.000Z"), "2026-09-06T01:02:03.000Z");
assert.throws(() => time.bounds("2026-02-30"), /valid date/);
console.log("Bangkok timestamp helpers PASS");
