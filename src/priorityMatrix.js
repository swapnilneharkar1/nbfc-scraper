/**
 * priorityMatrix.js
 * ------------------
 * Source of truth: the "Priority data" sheet in the BRD workbook
 * (List_of_NBFC_FIIs_BRD_Updated.xlsb), transcribed verbatim. Rank 1 = 
 * highest priority. When an entity qualifies under multiple regulator
 * categories, BRD points 5 & 6 require picking the single highest-priority
 * category as the final reporting classification while retaining every
 * category the entity actually belongs to for audit.
 *
 * If the BRD workbook's Priority data sheet is ever revised, update this
 * file to match - it's transcribed data, not derived/computed.
 */

export const PRIORITY_MATRIX = [
  { rank: 1, category: "Public Sector Bank" },
  { rank: 2, category: "Private Sector Banks" },
  { rank: 3, category: "foreign banks" },
  { rank: 4, category: "Local Area Banks" },
  { rank: 4, category: "Non-Scheduled State Co-operative Banks" },
  { rank: 4, category: "Non-Scheduled Urban Co-operative Banks" },
  { rank: 4, category: "Regional Rural Banks" },
  { rank: 4, category: "Scheduled Urban Co-operative Banks" },
  { rank: 4, category: "Small Finance Banks" },
  { rank: 4, category: "State Co-operative Banks" },
  { rank: 5, category: "Health insurer" },
  { rank: 5, category: "Life insurers" },
  { rank: 5, category: "Mutual Funds" },
  { rank: 5, category: "Non-Life (Ganeral) Insurance Companies" },
  { rank: 5, category: "Re insurers" },
  { rank: 5, category: "reinsurers" },
  { rank: 6, category: "Pension Fund" },
  { rank: 7, category: "HFCs" },
  { rank: 7, category: "NBFC" }, // BRD sheet lists "NBFC" at both rank 7 and rank 8 verbatim
  { rank: 8, category: "NBFC" },
  { rank: 9, category: "Financial Institutions in India" },
  { rank: 10, category: "ARC" },
  { rank: 10, category: "Banker to an Issue" },
  { rank: 10, category: "CA-Insurer-List" },
  { rank: 10, category: "Credit Rating Agency" },
  { rank: 10, category: "Debentures Trustee" },
  { rank: 10, category: "Depository Participants - CDSL" },
  { rank: 10, category: "Depository Participants - NSDL" },
  { rank: 10, category: "Investment Adviser" },
  { rank: 10, category: "Merchant Banker" },
  { rank: 10, category: "Payments Banks" },
  { rank: 10, category: "PSS Operating" },
  { rank: 10, category: "PSS Revoked" },
  { rank: 10, category: "Registered Custodians" },
  { rank: 10, category: "Registered Foreign Venture Capital Investors" },
  { rank: 10, category: "Registered Portfolio Managers" },
  { rank: 10, category: "Share Transfer Agent" },
  { rank: 10, category: "Stock Brokers in Commodity Derivative" },
  { rank: 10, category: "Stock Brokers in Currency Derivative Segment" },
  { rank: 10, category: "Stock Brokers in Debt Segement" },
  { rank: 10, category: "Stock Brokers in Equity Derivative Segment" },
  { rank: 10, category: "Stock Brokers in equity segment" },
  { rank: 10, category: "Stock Brokers in Interest Rate Derivative" },
  { rank: 10, category: "Venture Capital Funds" },
];

// Any category not explicitly in the BRD's Priority data sheet gets this
// rank - sorts after everything BRD did specify, but still resolvable
// rather than crashing, and flagged so it's visible in output that this
// category needs to be added to the matrix above if it recurs often.
export const UNRANKED_FALLBACK_RANK = 999;

function normalizeCategoryForMatch(category) {
  return (category || "")
    .toLowerCase()
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const LOOKUP = new Map(
  PRIORITY_MATRIX.map((entry) => [normalizeCategoryForMatch(entry.category), entry.rank])
);

// RBI's own NBFC Classification column (BRD issue #3) gives sub-types like
// ICC, CIC, IFC, MFI, P2P, Factor, AA, NOFHC, IDF, PD, Type-I NBFC, MGC -
// none of which appear verbatim in the BRD's Priority data sheet, which
// only lists the generic "NBFC" category. All of these sub-types are still
// NBFCs for priority-ranking purposes, so they inherit "NBFC"'s rank rather
// than falling through to "unranked".
const NBFC_SUBTYPE_PATTERN =
  /^(ICC|CIC|IFC|MFI|P2P|Factor|ARC|AA|Account Aggregator|NOFHC|IDF|PD|Primary Dealer|Type-?I NBFC|MGC)\b/i;
const NBFC_FALLBACK_RANK = LOOKUP.get(normalizeCategoryForMatch("NBFC"));

/**
 * Returns the BRD priority rank for a category string (lower = higher
 * priority). Matching happens in three stages, since the BRD's Priority
 * data sheet and Annex-1's category labels aren't always worded identically
 * (e.g. Priority sheet says "Private Sector Banks", Annex-1 says "Private
 * Sector Banks in India"):
 *   1. Exact match (after normalization) - most reliable, tried first.
 *   2. Substring match - one string contains the other, e.g. "Private
 *      Sector Banks in India" contains "private sector banks". This is the
 *      common case for the bank categories, which all follow this pattern.
 *   3. NBFC sub-type fallback - RBI's own classification values (ICC, CIC,
 *      MFI, ...) inherit the generic "NBFC" rank.
 * Falls back to UNRANKED_FALLBACK_RANK only if none of the above match,
 * which should be rare - treat it as a signal to add the category to
 * PRIORITY_MATRIX above rather than something to ignore.
 */
export function getRank(category) {
  const normalized = normalizeCategoryForMatch(category);

  const exact = LOOKUP.get(normalized);
  if (exact !== undefined) return exact;

  for (const [key, rank] of LOOKUP) {
    if (normalized.includes(key) || key.includes(normalized)) return rank;
  }

  if (NBFC_SUBTYPE_PATTERN.test(category || "") && NBFC_FALLBACK_RANK !== undefined) {
    return NBFC_FALLBACK_RANK;
  }

  return UNRANKED_FALLBACK_RANK;
}
