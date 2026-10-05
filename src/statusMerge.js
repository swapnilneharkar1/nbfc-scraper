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
 *
 * MATCHING (rewritten after comparing a real run's "Unmatched PR Mentions"
 * sheet against the master list): the press release and the master list
 * spell the SAME company differently in a handful of systematic ways, and
 * the previous matcher (upper-case + strip . , ( ) + Private->PVT +
 * Limited->LTD) missed all of them:
 *   - "(P) Ltd"  vs "Private Limited"
 *   - "Pvt.Ltd." vs "Pvt Ltd" (dots removed glued the words together)
 *   - "&" vs "And"
 *   - master-list names with a missing space ("MeltronVincom Pvt Ltd",
 *     "Mukesh Trade &Finance Pvt Ltd") vs the properly spaced press release
 *   - "M/s " prefix, "C.G." vs "C G"
 *   - annotations such as "(Formerly, X)", "(also known as X)",
 *     "(as per MCA - X)", "(Name as per MCA - X" (unclosed in the master)
 *   - one-character typos in the master list ("Lttd", "Pvt Lid",
 *     "Mehandipura" vs "Mehandipua")
 * Matching now goes: exact canonical key -> alias names from annotations ->
 * a guarded one-character-difference match. Every match records HOW it
 * matched so the audit sheet can show it.
 */

/** Legacy normaliser. Kept unchanged because the Final Status sheet is
 * keyed by it - changing it would change which master-list rows exist. */
export function normalizeName(name) {
  return name
    .toUpperCase()
    .replace(/[.,()]/g, "")
    .replace(/\bPRIVATE\b/g, "PVT")
    .replace(/\bLIMITED\b/g, "LTD")
    .replace(/\s+/g, " ")
    .trim();
}

// Annotation keywords whose parenthetical holds ANOTHER NAME of the company.
const ALIAS_KEYWORD =
  /(?:name\s+as\s+per\s+mca|as\s+per\s+mca|formerly(?:\s+known\s+as)?|formely(?:\s+known\s+as)?|also\s+known\s+as|now\s+known\s+as|erstwhile|previously(?:\s+known\s+as)?)\s*[-–—:,]*\s*/i;
const ANNOTATION_HINT =
  /name\s+as\s+per|as\s+per\s+mca|formerly|formely|also\s+known|now\s+known|erstwhile|previously|under\s+liquidation|in\s+liquidation/i;

/**
 * Splits a raw name into its primary part and any alias names that were
 * given in annotation parentheses. Parentheses that are part of the real
 * name (e.g. "SBM Bank (India) Limited") are left in place.
 * An unclosed "(" that starts an annotation (the master list has several,
 * e.g. "(Name as per MCA - Matrix InfraPro Finance Limited") is handled.
 */
export function splitAnnotations(raw) {
  let s = String(raw || "").replace(/[‘’`]/g, "'");
  const aliases = [];

  // "(P)" is "Private", not an annotation.
  s = s.replace(/\(\s*P\s*\)/gi, " PVT ");

  // Closed annotation groups.
  s = s.replace(/\(([^()]*)\)/g, (whole, inner) => {
    if (!ANNOTATION_HINT.test(inner)) return whole; // genuine part of the name
    const aliasText = inner.replace(new RegExp("^.*?" + ALIAS_KEYWORD.source, "i"), "").trim();
    if (aliasText && aliasText !== inner.trim()) aliases.push(aliasText);
    return " ";
  });

  // Unclosed annotation running to the end of the string.
  const open = s.lastIndexOf("(");
  if (open !== -1 && s.indexOf(")", open) === -1) {
    const inner = s.slice(open + 1);
    if (ANNOTATION_HINT.test(inner)) {
      const aliasText = inner.replace(new RegExp("^.*?" + ALIAS_KEYWORD.source, "i"), "").trim();
      if (aliasText && aliasText !== inner.trim()) aliases.push(aliasText);
      s = s.slice(0, open);
    }
  }
  return { primary: s.replace(/\s+/g, " ").trim(), aliases };
}

/**
 * Canonical comparison key: insensitive to case, spacing (including
 * missing spaces), punctuation, "&"/"and", "Private Limited"/"Pvt Ltd"/
 * "(P) Ltd", "M/s" and a leading "The".
 */
export function canonicalKey(raw) {
  let s = String(raw || "").toUpperCase().replace(/[‘’`]/g, "'");
  s = s.replace(/^\s*(?:M\/S\.?|MESSRS\.?)\s+/, "");
  s = s.replace(/&/g, " AND ");
  s = s.replace(/'/g, ""); // "Trafin's" -> "Trafins"
  s = s.replace(/[.,;:/\\\-–—_"“”()\[\]]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^THE\s+/, "");
  // Legal-form suffix, matched at the END without needing a left word
  // boundary (the master list has glued forms like "MercantilesPvt Ltd").
  s = s.replace(/(?:\bP|PRIVATE|PVT)\s*(?:LIMITED|LTD)\s*$/, "PVTLTD");
  s = s.replace(/\bPRIVATE\b/g, "PVT");
  s = s.replace(/\s*\bLIMITED\s*$/, " LTD");
  return s.replace(/[^A-Z0-9]/g, "");
}

/** True when a and b differ by at most one inserted/deleted/substituted char. */
function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1); // one substitution
  if (la > lb) return a.slice(i + 1) === b.slice(i); // one deletion from a
  return a.slice(i) === b.slice(i + 1); // one insertion into a
}

const digitsOf = (s) => s.replace(/\D/g, "");

function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * @param {Array<{name: string, status: 'Active'|'Cancelled'}>} masterEntries
 * @param {Array<{entityName: string|null, action: string, effectiveDate: string}>} deltas
 * @returns {{merged: Array, unmatchedDeltas: Array, releaseSummary: Array}}
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

  // Secondary indexes for matching. Built over the same entry objects, so
  // the Final Status sheet keeps exactly one row per legacy-normalised name.
  const canonIndex = new Map(); // canonicalKey -> entry[]
  const aliasIndex = new Map(); // canonicalKey (of an alias name) -> entry[]
  const push = (map, key, entry) => {
    if (!key) return;
    const list = map.get(key);
    if (!list) map.set(key, [entry]);
    else if (!list.includes(entry)) list.push(entry);
  };
  for (const entry of byNormalizedName.values()) {
    const { primary, aliases } = splitAnnotations(entry.name);
    push(canonIndex, canonicalKey(primary), entry);
    for (const a of aliases) push(aliasIndex, canonicalKey(a), entry);
  }
  // Keys bucketed by length for the one-edit search.
  const keysByLength = new Map();
  for (const key of canonIndex.keys()) {
    const l = key.length;
    if (!keysByLength.has(l)) keysByLength.set(l, []);
    keysByLength.get(l).push(key);
  }

  const findMatch = (delta) => {
    const legacy = byNormalizedName.get(normalizeName(delta.entityName));
    if (legacy) return { entries: [legacy], matchType: "Exact" };

    const { primary, aliases } = splitAnnotations(delta.entityName);
    const key = canonicalKey(primary);

    if (key && canonIndex.has(key)) {
      return { entries: canonIndex.get(key), matchType: "Normalised (spelling/format differences ignored)" };
    }
    // The press release may give the OTHER name of the company in an annotation.
    for (const a of aliases) {
      const k = canonicalKey(a);
      if (k && canonIndex.has(k)) {
        return { entries: canonIndex.get(k), matchType: `Alias (matched on "${a}")` };
      }
    }
    // The master list may carry the press release's name as an annotation.
    if (key && aliasIndex.has(key)) {
      return { entries: aliasIndex.get(key), matchType: "Alias (press release name is listed as a former/other name in the master list)" };
    }

    // Guarded approximate match: one character off, long enough that this
    // is meaningful, identical digits (so "ABC Finance 1" never matches
    // "ABC Finance 2"), the first 5 characters identical (genuine typos
    // are almost never in the first letters, whereas short initial-style
    // names such as "AJ Finance" / "AK Finance" are different companies),
    // and exactly one candidate.
    if (key.length >= 16) {
      const hits = [];
      for (const l of [key.length - 1, key.length, key.length + 1]) {
        for (const k of keysByLength.get(l) || []) {
          if (
            k !== key &&
            commonPrefixLength(key, k) >= 5 &&
            withinOneEdit(key, k) &&
            digitsOf(k) === digitsOf(key)
          ) {
            hits.push(k);
          }
        }
      }
      if (hits.length === 1) {
        const entries = canonIndex.get(hits[0]);
        return {
          entries,
          matchType: `Approximate (1-character difference from master-list name "${entries[0].name}")`,
        };
      }
    }
    return null;
  };

  const usableDeltas = deltas
    .filter((d) => d.entityName) // skip unattributable deltas here - reported separately
    .slice()
    .sort((a, b) => new Date(a.effectiveDate) - new Date(b.effectiveDate));

  const unmatchedDeltas = [];
  const summaryByRelease = new Map();
  const bucketFor = (d) => {
    const k = d.prLink || d.prTitle;
    if (!summaryByRelease.has(k)) {
      summaryByRelease.set(k, {
        prTitle: d.prTitle,
        prLink: d.prLink,
        action: d.action,
        effectiveDate: d.effectiveDate,
        expectedCount: d.expectedCount ?? null,
        extracted: 0,
        exact: 0,
        normalised: 0,
        alias: 0,
        approximate: 0,
        notInMaster: 0,
      });
    }
    return summaryByRelease.get(k);
  };

  for (const delta of usableDeltas) {
    const bucket = bucketFor(delta);
    bucket.extracted++;

    const match = findMatch(delta);
    const newStatus = delta.action === "Restored" ? "Active" : delta.action;

    if (match) {
      if (match.matchType === "Exact") bucket.exact++;
      else if (match.matchType.startsWith("Normalised")) bucket.normalised++;
      else if (match.matchType.startsWith("Alias")) bucket.alias++;
      else bucket.approximate++;

      for (const existing of match.entries) {
        existing.status = newStatus; // most recent effective date wins, since we process in date order
        existing.statusSource = `Press Release (${delta.prTitle})`;
        existing.statusEffectiveDate = delta.effectiveDate;
        existing.statusHistory.push({
          status: newStatus,
          effectiveDate: delta.effectiveDate,
          prTitle: delta.prTitle,
          prLink: delta.prLink,
          note: delta.note || null,
          prName: delta.entityName,
          matchType: match.matchType,
        });
      }
    } else {
      // Entity mentioned in a press release but not found in the master
      // list even after normalisation, alias and approximate matching -
      // most likely a company that is not in RBI's active or cancelled
      // master list at all. Surfaced separately so it isn't silently
      // dropped or silently trusted.
      bucket.notInMaster++;
      unmatchedDeltas.push(delta);
    }
  }

  return {
    merged: [...byNormalizedName.values()],
    unmatchedDeltas,
    releaseSummary: [...summaryByRelease.values()],
  };
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
