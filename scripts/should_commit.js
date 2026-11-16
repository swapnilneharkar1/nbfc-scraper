// Exit 0 when output/run-log.json is safe to publish, 1 when a core master list is missing.
// Core = RBI NBFC lists. A run that lost them (blocked download and no previous workbook to reuse) must not overwrite data/.
import fs from "node:fs";
const CORE = ["rbi_nbfc", "rbi_nbfc_cancelled"];
const log = JSON.parse(fs.readFileSync("output/run-log.json", "utf8"));
const bad = CORE.filter((k) => { const r = log.find((x) => x.key === k); return !r || r.status === "error" || r.status === "empty" || !r.count; });
const stale = log.filter((r) => r.status === "stale_previous_run").map((r) => r.key);
if (stale.length) console.log(`NOTE: reused from the previous workbook (stale): ${stale.join(", ")}`);
if (bad.length) { console.log(`NOT publishing: core source(s) missing: ${bad.join(", ")}`); process.exit(1); }
console.log("run-log OK - publishing");
