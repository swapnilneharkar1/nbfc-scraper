/**
 * statusMerge.js
 * ---------------
 * Implements the BRD's "Final Status Determination" rules:
 *   - Baseline = RBI master list (Active / Cancelled) as of its stated date.
 *   - Apply press-release deltas dated after the master list date, in
 *     chronological order.
 *   - If multiple deltas hit the same entity, the most recent effective
 *     date wins (so Cancelled -> Restored ends as Active, matching the
 *     BRD's PQR Finance Ltd example).
 */

/** Normalises a company name for matching across sources (case, punctuation,
 * spacing, and common suffix variants all differ between RBI's master list
 * and press-release prose). This is intentionally aggressive - it trades a
 * small risk of over-matching for a much larger reduction in missed matches
 * caused by trivial formatting differences. */
export function normalizeName(name) {
  return name
    .toUpperCase()
    .replace(/[.,()]/g, "")
    .replace(/\bPRIVATE\b/g, "PVT")
    .replace(/\bLIMITED\b/g, "LTD")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tries to find a stated "as on <date>" / "as of <date>" phrase in a title
 * row pulled from RBI's master list spreadsheet. Falls back to null if none
 * is found - the caller should then require an explicit override date.
 */
export function extractMasterListDate(titleText) {
  if (!titleText) return null;
  const match = titleText.match(
    /as\s+(?:on|of)\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\s\-][A-Za-z]+[\s\-]\d{4})/i
  );
  if (!match) return null;
  const parsed = new Date(match[1].replace(/(\d{1,2})[\s-]/, "$1 "));
  return isNaN(parsed) ? null : parsed;
}

/**
 * @param {Array<{name: string, status: 'Active'|'Cancelled'}>} masterEntries
 * @param {Array<{entityName: string|null, action: string, effectiveDate: string}>} deltas
 * @returns {Array} merged entries with final status + audit trail
 */
export function mergeStatuses(masterEntries, deltas) {
  const byNormalizedName = new Map();

  for (const entry of masterEntries) {
    byNormalizedName.set(normalizeName(entry.name), {
      name: entry.name,
      status: entry.status,
      masterListStatus: entry.status, // preserved even after status is overwritten below
      statusSource: "RBI Master List",
      statusEffectiveDate: null,
      statusHistory: [],
    });
  }

  const usableDeltas = deltas
    .filter((d) => d.entityName) // skip unattributable deltas here - reported separately
    .slice()
    .sort((a, b) => new Date(a.effectiveDate) - new Date(b.effectiveDate));

  const unmatchedDeltas = [];

  for (const delta of usableDeltas) {
    const key = normalizeName(delta.entityName);
    const existing = byNormalizedName.get(key);

    const newStatus = delta.action === "Restored" ? "Active" : delta.action;

    if (existing) {
      existing.status = newStatus; // most recent effective date wins, since we process in date order
      existing.statusSource = `Press Release (${delta.prTitle})`;
      existing.statusEffectiveDate = delta.effectiveDate;
      existing.statusHistory.push({
        status: newStatus,
        effectiveDate: delta.effectiveDate,
        prTitle: delta.prTitle,
        prLink: delta.prLink,
        note: delta.note || null,
      });
    } else {
      // Entity mentioned in a press release but not found in the master
      // list at all - could be a name-matching mismatch (see normalizeName
      // caveat) or a genuinely new entity. Surfaced separately so it isn't
      // silently dropped or silently trusted.
      unmatchedDeltas.push(delta);
    }
  }

  return {
    merged: [...byNormalizedName.values()],
    unmatchedDeltas,
  };
}
