/**
 * nameUtils.js
 * -------------
 * Small helpers for turning scraped table rows into entity names.
 */

/** Guess which column in a scraped table is the entity/company name. */
export function guessNameColumnIndex(headerRow) {
  const patterns = [/name/i, /company/i, /entity/i, /institution/i];
  for (const p of patterns) {
    const idx = headerRow.findIndex((h) => p.test(h));
    if (idx !== -1) return idx;
  }
  return 0; // fall back to first column
}

const DEVANAGARI = /[\u0900-\u097F]/;

/**
 * IRDAI's pages are bilingual: Marathi/Hindi text (Devanagari script) sits
 * next to - or inside the same cell as - the English name, and was being
 * collected as if it were extra entities. Removes the Devanagari text and
 * any separator left behind ("Life Insurance Corporation of India /").
 * Names without any Devanagari are returned untouched.
 */
export function stripDevanagari(name) {
  if (!DEVANAGARI.test(name)) return name;
  return name
    .replace(/[\u0900-\u097F]+/g, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+[/|\-\u2013\u2014]+\s*(?=$|\s[/|\-\u2013\u2014])/g, " ")
    .replace(/^[\s/|,;:\-\u2013\u2014]+|[\s/|,;:\-\u2013\u2014]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\(([^()]*)\)$/, "$1") // "Marathi (English name)" -> the English name was left wrapped in brackets
    .trim();
}

/**
 * Same as guessNameColumnIndex, but when the guessed column is mostly
 * Devanagari (a Marathi name column listed before the English one) it
 * switches to the name-like column that actually holds Latin text. Tables
 * with no Devanagari at all are handled exactly as before.
 */
export function pickNameColumn(headerRow, dataRows) {
  const guessed = guessNameColumnIndex(headerRow);
  const touchesDevanagari = dataRows.some((r) => DEVANAGARI.test(r[guessed] || ""));
  if (!touchesDevanagari) return guessed;
  const latinShare = (c) => {
    const vals = dataRows.map((r) => r[c] || "").filter(Boolean);
    return vals.length ? vals.filter((v) => /[A-Za-z]{3}/.test(v.replace(/[\u0900-\u097F]/g, ""))).length / vals.length : 0;
  };
  const candidates = headerRow
    .map((h, c) => ({ c, h }))
    .filter(({ h }) => /name|company|entity|institution|insurer|agent/i.test(h))
    .map(({ c }) => ({ c, share: latinShare(c) }))
    .sort((a, b) => b.share - a.share);
  return candidates.length && candidates[0].share >= 0.5 ? candidates[0].c : guessed;
}

/** Same header-row heuristic used for xlsx sheets - see findHeaderRowIndex(). */
export function findHeaderRowIndex(rows) {
  const labelPattern = /name|company|entity|institution|sl\.?\s*no/i;
  let fallback = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const nonEmptyCount = rows[i].filter(Boolean).length;
    if (nonEmptyCount < 2) continue; // likely a title/merged-cell row
    if (fallback === -1) fallback = i;
    if (rows[i].some((cell) => labelPattern.test(cell))) return i;
  }
  return fallback;
}

// A real entity name is a handful of words, not a page of prose. Pages
// like RBI's PSS/Banks listings aren't built from real <table> markup, so
// naive table scraping on them yields one giant blob per "row" - this cap
// throws those out instead of polluting the output with garbage.
export const MAX_PLAUSIBLE_NAME_LENGTH = 180;

export function rowsToNames(table) {
  const headerIdx = findHeaderRowIndex(table);
  if (headerIdx === -1) return [];
  const header = table[headerIdx];
  const dataRows = table.slice(headerIdx + 1);
  const nameIdx = pickNameColumn(header, dataRows);
  return dataRows
    .map((r) => stripDevanagari((r[nameIdx] || "").trim()))
    .filter((name) => name && !/^(sl\.?\s*no\.?|s\.?\s*no\.?)$/i.test(name))
    .filter((name) => name.length <= MAX_PLAUSIBLE_NAME_LENGTH);
}


/**
 * Picks entity names out of a page's tables, honouring optional per-source
 * settings (see PFRDA in sources.js):
 *   tableHeaderPattern  - use only tables whose header mentions this
 *   splitCombinedNames  - split two companies sitting in one cell
 *   nameKeywordFilter   - keep only names matching this
 * With none of these set it returns every table's names, as before.
 */
export function namesFromTables(tables, options = {}, log = () => {}) {
  const uniq = (arr) => [...new Set(arr.map((n) => n.trim()).filter(Boolean))];
  let candidate = tables;
  if (options.tableHeaderPattern) {
    const pattern = new RegExp(options.tableHeaderPattern, "i");
    const matching = tables.filter((t) => t.slice(0, 3).some((r) => r.some((c) => pattern.test(c))));
    if (matching.length > 0) {
      log(`  using ${matching.length} of ${tables.length} table(s) whose header matches /${options.tableHeaderPattern}/i`);
      candidate = matching;
    } else {
      log(`  no table header matched /${options.tableHeaderPattern}/i among ${tables.length} table(s) - using all tables, relying on the name filter`);
    }
  }
  let names = uniq(candidate.flatMap(rowsToNames));
  if (options.splitCombinedNames) {
    names = uniq(
      names.flatMap((n) => n.split(/(?<=\b(?:Limited|Ltd\.?|Private\s+Limited|Pvt\.?\s*Ltd\.?))\s+(?=[A-Z][A-Za-z])/))
    );
  }
  if (options.nameKeywordFilter) {
    const keep = new RegExp(options.nameKeywordFilter, "i");
    const before = names.length;
    names = names.filter((n) => keep.test(n));
    if (names.length !== before) log(`  name filter /${options.nameKeywordFilter}/i kept ${names.length} of ${before}`);
  }
  return names;
}
