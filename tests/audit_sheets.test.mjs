import fs from "node:fs";
import ExcelJS from "exceljs";
import { writeWorkbook } from "../src/excelWriter.js";
const rawHits = [
  { name: "Acme Securities Ltd", categoryAsPerReturn: "O", categoryAsPerRegulator: "Stock Brokers in equity segment", regulator: "SEBI", sourceKey: "sebi_broker_equity", status: "Active" },
  { name: "Acme Securities Ltd", categoryAsPerReturn: "O", categoryAsPerRegulator: "Registered Portfolio Managers", regulator: "SEBI", sourceKey: "sebi_portfolio_managers", status: "Active" },
  { name: "Beta Brokers Ltd", categoryAsPerReturn: "O", categoryAsPerRegulator: "Stock Brokers in equity segment", regulator: "SEBI", sourceKey: "sebi_broker_equity", status: "Active" },
];
const resolved = [
  { name: "Acme Securities Ltd", category: "Registered Portfolio Managers", categoryAsPerReturn: "O", classification: "x", institution: "O", regulator: "SEBI", sourceKey: "sebi_portfolio_managers", status: "Active", allCategories: "a | b", categoryCount: 2 },
  { name: "Beta Brokers Ltd", category: "Stock Brokers in equity segment", categoryAsPerReturn: "O", classification: "x", institution: "O", regulator: "SEBI", sourceKey: "sebi_broker_equity", status: "Active", allCategories: "a", categoryCount: 1 },
];
const runLog = [
  { key: "sebi_broker_equity", status: "ok", count: 2, expectedCount: 3, category: "Stock Brokers in equity segment", regulator: "SEBI", scrapeNote: "n" },
  { key: "sebi_portfolio_managers", status: "ok", count: 1, expectedCount: 1, category: "Registered Portfolio Managers", regulator: "SEBI" },
];
const out = "/tmp/audit_test.xlsx";
await writeWorkbook(resolved, out, null, [], { rawHits, runLog });
const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(out);
const rec = wb.getWorksheet("Source Reconciliation");
const eq = rec.getRow(2).values.slice(1);
const mem = wb.getWorksheet("Combine List");
const ok = eq[5] === 2 && eq[7] === 2 && eq[8] === 2 && eq[9] === 1 && mem.rowCount === 4 && !wb.getWorksheet("All Memberships") && eq[6] === -1;
console.log(eq, "memberships rows", mem.rowCount);
console.log(ok ? "PASS source reconciliation + all memberships" : "FAIL");
fs.unlinkSync(out); process.exit(ok ? 0 : 1);
