import ExcelJS from "exceljs";

/**
 * Writes results in the BRD's "Annex-2 Combine List" shape, now with
 * entity-level category resolution (BRD issues #1, #2, #5, #6):
 * Name | Category (as per Regulator) | Classification | Institution
 * plus an audit trail of every category an entity actually belongs to.
 */
export async function writeWorkbook(rows, outFile, statusReconciliation = null, multiCategoryEntities = []) {
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
  ];
  sheet.getRow(1).font = { bold: true };

  const scrapedAt = new Date().toISOString();
  for (const r of rows) {
    const row = sheet.addRow({
      ...r,
      multipleCategories: r.categoryCount > 1 ? "Yes" : "No",
      scrapedAt,
    });
    if (r.categoryCount > 1) {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2EFDA" } };
      });
    }
  }

  sheet.autoFilter = { from: "A1", to: "K1" };

  if (multiCategoryEntities.length > 0) {
    writeMultiCategorySheet(wb, multiCategoryEntities);
  }

  if (statusReconciliation) {
    writeFinalStatusSheet(wb, statusReconciliation);
    writeStatusChangeLogSheet(wb, statusReconciliation);
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
  sheet.autoFilter = { from: "A1", to: "G1" };
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
