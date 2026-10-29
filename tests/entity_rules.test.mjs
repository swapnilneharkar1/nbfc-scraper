import assert from "node:assert/strict";
import { makeEntityKeyer, entityNames } from "../src/entityKey.js";
import { reportingCategory } from "../src/reportingRules.js";
import { resolveWithPriorityMatrix } from "../src/resolve.js";

// --- same entity despite Ltd/Limited, Pvt/Private, "&"/"and", formerly-known-as (bracketed or not)
const names = [
  "Sammaan Capital Limited (Formerly: Indiabulls Housing Finance Limited)",
  "Indiabulls Housing Finance Ltd.",
  "Alpha Housing Finance Ltd formerly known as Beta Finance Pvt. Ltd.",
  "BETA FINANCE PRIVATE LIMITED",
  "Narven Finance & Investments Limited",
  "Narven Finance And Investments Ltd",
  "SBM Bank (India) Limited",
  "Other Co Ltd",
];
const k = makeEntityKeyer(names);
assert.equal(k(names[0]), k(names[1]), "formerly (bracketed)");
assert.equal(k(names[2]), k(names[3]), "formerly (no brackets)");
assert.equal(k(names[4]), k(names[5]), "& vs and, Limited vs Ltd");
assert.notEqual(k(names[6]), k(names[7]));
assert.deepEqual(entityNames("Piramal Finance Ltd, (Formerly Known As Piramal Finance Pvt Ltd) Merged With Piramal Housing Finance Ltd.").aliases, ["Piramal Finance Pvt Ltd"]);

// --- category rules
const nbfc = { key: "rbi_nbfc", categoryAsPerRegulator: "NBFC", categoryAsPerReturn: "Other NBFCs" };
assert.deepEqual(reportingCategory(nbfc, "X Housing Finance Ltd", "HFC"), { categoryAsPerRegulator: "HFCs", categoryAsPerReturn: "Housing Finance Companies" });
assert.equal(reportingCategory(nbfc, "Phoenix ARC Limited").categoryAsPerRegulator, "ARC");
assert.equal(reportingCategory(nbfc, "Phoenix ARC Limited").categoryAsPerReturn, "Other NBFCs");
assert.equal(reportingCategory(nbfc, "Edelweiss Asset Reconstruction Company Limited").categoryAsPerRegulator, "ARC");
assert.equal(reportingCategory(nbfc, "Northern Arc Capital Limited", "ICC*").categoryAsPerRegulator, "ICC*", "Northern Arc is an ICC, not an ARC");

// --- priority resolution: an HFC that is also a corporate agent under a slightly different spelling is reported as HFC
const hit = (name, cat, ret, src, status = "Active") => ({ name, categoryAsPerRegulator: cat, categoryAsPerReturn: ret, regulator: "R", sourceKey: src, status });
const hits = [
  hit("Niwas Housing Finance Private Limited", "HFCs", "Housing Finance Companies", "rbi_nbfc"),
  hit("NIWAS HOUSING FINANCE PVT LTD", "CA-Insurer-List", "Other Financial Entities", "irdai_ca_insurer"),
  hit("Supreme Securities Limited,", "NBFC", "Other NBFCs", "rbi_nbfc_cancelled", "Cancelled"),
  hit("Supreme Securities Limited", "PSS Surrender/Cancelled", "Other Financial Entities", "rbi_pss_surrendered", "Surrendered"),
];
const { resolved } = resolveWithPriorityMatrix(hits, makeEntityKeyer(hits.map((h) => h.name)));
assert.equal(resolved.length, 2);
const niwas = resolved.find((r) => /niwas/i.test(r.name));
assert.equal(niwas.category, "HFCs");
assert.equal(niwas.categoryAsPerReturn, "Housing Finance Companies");
const sup = resolved.find((r) => /supreme/i.test(r.name));
assert.equal(sup.status, "Cancelled");
console.log("entity_rules: all assertions passed");
