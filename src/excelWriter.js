import ExcelJS from "exceljs";

/**
 * Writes results in the BRD's "Annex-2 Combine List" shape, now with
 * entity-level category resolution (BRD issues #1, #2, #5, #6):
 * Name | Category (as per Regulator) | Classification | Institution
 * plus an audit trail of every category an entity actually belongs to.
 */
export async function writeWorkbook(rows, outFile, statusReconciliation = null, multiCategoryEntities = [], audit = null) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "nbfc-fii-scraper";
  wb.created = new Date();

  const sheet = wb.addWorksheet("Combine List");
  sheet.columns = [
    { header: "Name of the Active NBFCs / HFCs / Others", key: "name", width: 55 },
    { header: "Category (as per Regulator)", key: "category", width: 32 },
    { header: "Category (as per Return)", key: "categoryAsPerReturn", width: 28 },
    { header: "Classification", key: "classification", width: 32 },
    { header: "Institution", key: "institution", width: 28 },
    { header: "Regulator", key: "regulator", width: 12 },
    { header: "Status", key: "status", width: 14 },
    { header: "Multiple Categories?", key: "multipleCategories", width: 18 },
    { header: "All Categories (audit)", key: "allCategories", width: 60 },
    { header: "Source Key", key: "sourceKey", width: 20 },
    { header: "Scraped At", key: "scrapedAt", width: 20 },
    { header: "Final Reporting Row? (Priority Matrix)", key: "isFinal", width: 20 },
  ];
  sheet.getRow(1).font = { bold: true };

  const scrapedAt = new Date().toISOString();
  // One row per (entity, category) membership, so filtering a category
  // gives exactly the number scraped for it (BRD #6: all valid category
  // relationships are retained). "Final Reporting Row?" = Yes marks the one
  // row per entity chosen by the Priority Matrix (BRD #5); filter it to Yes
  // for the de-duplicated entity list.
  const outRows = audit && audit.rawHits ? membershipRows(rows, audit.rawHits) : rows.map((r) => ({ ...r, isFinal: "Yes" }));
  for (const r of outRows) {
    const row = sheet.addRow({
      ...r,
      multipleCategories: r.categoryCount > 1 ? "Yes" : "No",
      scrapedAt,
    });
    if (r.isFinal === "No") {
      row.eachCell((cell) => { cell.font = { color: { argb: "FF7F7F7F" } }; });
    } else if (r.categoryCount > 1) {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2EFDA" } };
      });
    }
  }

  sheet.autoFilter = { from: "A1", to: "L1" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  if (multiCategoryEntities.length > 0) {
    writeMultiCategorySheet(wb, multiCategoryEntities);
  }

  if (audit && audit.rawHits) {
    writeSourceReconciliationSheet(wb, audit.rawHits, audit.runLog || [], rows);
  }

  if (statusReconciliation) {
    writeFinalStatusSheet(wb, statusReconciliation);
    writeStatusChangeLogSheet(wb, statusReconciliation);
    writePressReleaseSummarySheet(wb, statusReconciliation);
    writeUnmatchedSheet(wb, statusReconciliation);
  }

  await wb.xlsx.writeFile(outFile);
}

/**
 * "Multi-Category Entities" sheet - BRD issues #5 & #6: shows every entity
 * that legitimately belongs to more than one regulator category (e.g.
 * ICICI Securities as both a Stock Broker and a Merchant Banker), which
 * category the Priority Matrix picked as the FINAL one, and the full
 * ranked list of every category it actually belongs to, for audit.
 */
function writeMultiCategorySheet(wb, multiCategoryEntities) {
  const sheet = wb.addWorksheet("Multi-Category Entities");
  sheet.columns = [
    { header: "Entity Name", key: "name", width: 50 },
    { header: "Final Category (Priority Matrix)", key: "finalCategory", width: 35 },
    { header: "Final Category Rank", key: "finalCategoryRank", width: 18 },
    { header: "All Category Memberships (ranked)", key: "allMemberships", width: 90 },
  ];
  sheet.getRow(1).font = { bold: true };

  for (const m of multiCategoryEntities) {
    sheet.addRow({
      name: m.name,
      finalCategory: m.finalCategory,
      finalCategoryRank: m.finalCategoryRank,
      allMemberships: m.allMemberships
        .map((x) => `${x.category} (rank ${x.rank}, ${x.regulator})`)
        .join("  |  "),
    });
  }
  sheet.autoFilter = { from: "A1", to: "D1" };
}

/**
 * "Final Status" sheet - the BRD's core deliverable: master list entities
 * with their status as-of-master-list, and their FINAL status after
 * applying any press-release deltas found since that date.
 */
function writeFinalStatusSheet(wb, { masterListDate, merged }) {
  const sheet = wb.addWorksheet("Final Status (Reconciled)");
  sheet.columns = [
    { header: "Entity Name", key: "name", width: 50 },
    { header: `Status as of Master List (${masterListDate})`, key: "masterStatus", width: 32 },
    { header: "Final Status", key: "status", width: 16 },
    { header: "Status Changed?", key: "changed", width: 16 },
    { header: "Status Effective Date", key: "statusEffectiveDate", width: 20 },
    { header: "Status Source", key: "statusSource", width: 45 },
  ];
  sheet.getRow(1).font = { bold: true };

  for (const m of merged) {
    const changed = m.statusHistory.length > 0;
    const row = sheet.addRow({
      name: m.name,
      masterStatus: m.masterListStatus,
      status: m.status,
      changed: changed ? "Yes" : "No",
      statusEffectiveDate: m.statusEffectiveDate || "",
      statusSource: m.statusSource,
    });
    if (changed) {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
      });
    }
  }
  sheet.autoFilter = { from: "A1", to: "F1" };
}

/** Raw, unfiltered audit trail: every status-change delta found in press
 * releases, whether or not it matched an entity in the master list. */
function writeStatusChangeLogSheet(wb, { merged, unattributedDeltas }) {
  const sheet = wb.addWorksheet("Press Release Changes Log");
  sheet.columns = [
    { header: "Entity Name", key: "name", width: 50 },
    { header: "Action", key: "action", width: 16 },
    { header: "Effective Date", key: "effectiveDate", width: 16 },
    { header: "Press Release", key: "prTitle", width: 55 },
    { header: "Link", key: "prLink", width: 60 },
    { header: "Needs Manual Verification", key: "flag", width: 24 },
    { header: "Note", key: "note", width: 60 },
    { header: "Name as written in Press Release", key: "prName", width: 50 },
    { header: "Match Type", key: "matchType", width: 60 },
  ];
  sheet.getRow(1).font = { bold: true };

  for (const m of merged) {
    for (const h of m.statusHistory) {
      const row = sheet.addRow({
        name: m.name,
        action: h.status,
        effectiveDate: h.effectiveDate,
        prTitle: h.prTitle,
        prLink: h.prLink,
        flag: "Yes - verify against source press release",
        note: h.note || "",
        prName: h.prName || "",
        matchType: h.matchType || "",
      });
      // Count-mismatch notes (e.g. "title states 59, only 36 extracted")
      // get a strong visual flag - this is the single most actionable
      // signal that a specific release's extraction is known-incomplete.
      if (h.note) {
        row.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE4E4" } };
        });
      }
    }
  }
  for (const d of unattributedDeltas) {
    sheet.addRow({
      name: "(could not auto-extract - see press release)",
      action: d.action,
      effectiveDate: d.effectiveDate,
      prTitle: d.prTitle,
      prLink: d.prLink,
      flag: "Yes - names not extracted automatically",
      note: "",
    });
  }
  sheet.autoFilter = { from: "A1", to: "I1" };
}

/**
 * One row per press release: how many entities its title says it covers,
 * how many were extracted, and where each one ended up. "Matched" +
 * "Not in master list" always equals "Extracted", so any gap between
 * "Expected" and "Extracted" is a genuine extraction shortfall, while a
 * large "Not in master list" means the company simply isn't in RBI's
 * active/cancelled list (see the Unmatched PR Mentions sheet).
 */
function writePressReleaseSummarySheet(wb, { releaseSummary = [] }) {
  const sheet = wb.addWorksheet("Press Release Summary");
  sheet.columns = [
    { header: "Press Release", key: "prTitle", width: 60 },
    { header: "Action", key: "action", width: 14 },
    { header: "Effective Date", key: "effectiveDate", width: 16 },
    { header: "Expected (from title)", key: "expectedCount", width: 20 },
    { header: "Extracted", key: "extracted", width: 12 },
    { header: "Matched to Master List", key: "matched", width: 22 },
    { header: "  of which exact", key: "exact", width: 16 },
    { header: "  of which normalised", key: "normalised", width: 20 },
    { header: "  of which alias", key: "alias", width: 16 },
    { header: "  of which approximate", key: "approximate", width: 20 },
    { header: "Not in Master List", key: "notInMaster", width: 18 },
    { header: "Extraction complete?", key: "complete", width: 20 },
    { header: "Link", key: "prLink", width: 60 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const r of releaseSummary) {
    const complete =
      r.expectedCount == null ? "n/a (no count in title)" : r.extracted === r.expectedCount ? "Yes" : `No (${r.extracted} of ${r.expectedCount})`;
    const row = sheet.addRow({
      ...r,
      expectedCount: r.expectedCount ?? "",
      matched: r.exact + r.normalised + r.alias + r.approximate,
      complete,
    });
    if (r.expectedCount != null && r.extracted !== r.expectedCount) {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE4E4" } };
      });
    }
  }
  sheet.autoFilter = { from: "A1", to: "M1" };
}

/** Entities mentioned in a press release status-change but not found in the
 * master list at all - could be a normalisation mismatch (see
 * statusMerge.js) or a genuinely new/unlisted entity. Needs a human look. */
function writeUnmatchedSheet(wb, { unmatchedDeltas }) {
  const sheet = wb.addWorksheet("Unmatched PR Mentions");
  sheet.columns = [
    { header: "Entity Name (from press release)", key: "name", width: 50 },
    { header: "Action", key: "action", width: 16 },
    { header: "Effective Date", key: "effectiveDate", width: 16 },
    { header: "Press Release", key: "prTitle", width: 55 },
    { header: "Link", key: "prLink", width: 60 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const d of unmatchedDeltas) {
    sheet.addRow({
      name: d.entityName,
      action: d.action,
      effectiveDate: d.effectiveDate,
      prTitle: d.prTitle,
      prLink: d.prLink,
    });
  }
  sheet.autoFilter = { from: "A1", to: "E1" };
}


// Same key the Combine List uses to decide two rows are one entity.
const entityKey = (name) => String(name).toUpperCase().replace(/[.,()]/g, "").replace(/\s+/g, " ").trim();

/**
 * "Source Reconciliation" - one row per scraped source, tying the portal's
 * count to what ends up in the Combine List. The Combine List holds each
 * entity ONCE, under its highest-priority category (BRD #5), so a source's
 * share there is normally smaller than its scraped count; the difference is
 * entities that are also in a higher-priority category (they are kept in
 * "All Memberships" and "Multi-Category Entities") or repeated within the
 * source itself.
 */
function writeSourceReconciliationSheet(wb, rawHits, runLog, resolvedRows) {
  const winnerByKey = new Map(resolvedRows.map((r) => [entityKey(r.name), r.sourceKey]));
  const perSource = new Map();
  for (const h of rawHits) {
    if (!perSource.has(h.sourceKey)) perSource.set(h.sourceKey, { keys: new Set(), wins: 0 });
    const e = perSource.get(h.sourceKey);
    const k = entityKey(h.name);
    if (!e.keys.has(k)) {
      e.keys.add(k);
      if (winnerByKey.get(k) === h.sourceKey) e.wins++;
    }
  }

  const sheet = wb.addWorksheet("Source Reconciliation");
  sheet.columns = [
    { header: "Source Key", key: "key", width: 34 },
    { header: "Regulator", key: "regulator", width: 11 },
    { header: "Category (as per Regulator)", key: "category", width: 38 },
    { header: "Run Status", key: "status", width: 14 },
    { header: "Portal Count (SEBI hub page)", key: "expected", width: 16 },
    { header: "Scraped (this run)", key: "scraped", width: 14 },
    { header: "Scraped minus Portal", key: "diff", width: 14 },
    { header: "Unique Entities in Source", key: "unique", width: 16 },
    { header: "Rows in Combine List for this category (should equal Unique)", key: "wins", width: 20 },
    { header: "Of which marked Final Reporting Row = No (higher-priority category elsewhere)", key: "heldBack", width: 26 },
    { header: "Note", key: "note", width: 90 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { wrapText: true, vertical: "top" };
  for (const r of runLog) {
    const e = perSource.get(r.key) || { keys: new Set(), wins: 0 };
    const diff = r.expectedCount != null ? r.count - r.expectedCount : "";
    const row = sheet.addRow({
      key: r.key,
      regulator: r.regulator || "",
      category: r.category || "",
      status: r.status,
      expected: r.expectedCount ?? "",
      scraped: r.count,
      diff,
      unique: e.keys.size,
      wins: e.keys.size,
      heldBack: e.keys.size - e.wins,
      note: [r.scrapeNote, r.error].filter(Boolean).join(" | "),
    });
    if (diff !== "" && diff < 0) row.getCell("diff").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE4D6" } };
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/**
 * "All Memberships" - every (entity, category) pair that was scraped, one
 * row each, before the priority matrix picks a single reporting category.
 * Filtering this sheet by Category gives exactly the scraped count.
 */
function writeAllMembershipsSheet(wb, rawHits, resolvedRows) {
  const winnerByKey = new Map(resolvedRows.map((r) => [entityKey(r.name), r.sourceKey]));
  const sheet = wb.addWorksheet("All Memberships");
  sheet.columns = [
    { header: "Entity Name", key: "name", width: 55 },
    { header: "Category (as per Regulator)", key: "category", width: 38 },
    { header: "Regulator", key: "regulator", width: 11 },
    { header: "Source Key", key: "sourceKey", width: 32 },
    { header: "Reporting Category in Combine List?", key: "isFinal", width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };
  const seen = new Set();
  for (const h of rawHits) {
    const id = `${h.sourceKey}|${entityKey(h.name)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    sheet.addRow({
      name: h.name,
      category: h.categoryAsPerRegulator,
      regulator: h.regulator,
      sourceKey: h.sourceKey,
      isFinal: winnerByKey.get(entityKey(h.name)) === h.sourceKey ? "Yes" : "No",
    });
  }
  sheet.autoFilter = { from: "A1", to: "E1" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}


/** Expands the priority-resolved rows into one row per (entity, source) membership. */
export function membershipRows(resolvedRows, rawHits) {
  const byKey = new Map(resolvedRows.map((r) => [entityKey(r.name), r]));
  const seen = new Set();
  const out = [];
  for (const h of rawHits) {
    const k = entityKey(h.name);
    const id = `${h.sourceKey}|${k}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const r = byKey.get(k);
    out.push({
      name: h.name,
      category: h.categoryAsPerRegulator,
      categoryAsPerReturn: h.categoryAsPerReturn,
      classification: h.categoryAsPerRegulator,
      institution: h.categoryAsPerReturn,
      regulator: h.regulator,
      status: h.status,
      allCategories: r ? r.allCategories : h.categoryAsPerRegulator,
      categoryCount: r ? r.categoryCount : 1,
      sourceKey: h.sourceKey,
      isFinal: r && r.sourceKey === h.sourceKey ? "Yes" : "No",
    });
  }
  return out;
}
