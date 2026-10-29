/**
 * entityKey.js
 * -------------
 * Decides which scraped rows are the SAME legal entity, so the Priority
 * Matrix (BRD #5/#6) sees every category the entity belongs to.
 *
 * The old key (upper-case, strip . , ( ) ) missed:
 *   - "Ltd" vs "Limited", "Pvt" vs "Private", "&" vs "and", spacing differences
 *   - "ABC Ltd (Formerly known as XYZ Ltd)" in one list and "XYZ Ltd" (the old
 *     name) in another list, or "Formerly known as ..." written WITHOUT brackets
 * Result: an HFC/NBFC also present in a SEBI/IRDAI list was kept as two
 * separate entities and the wrong category was reported.
 *
 * Matching uses canonicalKey() (same normaliser as the press-release
 * matcher) on the primary name AND on every former/alias name, and links
 * rows that share any key (union-find).
 */
import { canonicalKey, splitAnnotations } from "./statusMerge.js";

const UNBRACKETED_ALIAS =
  /\s*[,;(-]?\s*\b(?:formerly(?:\s+known\s+as)?|formely(?:\s+known\s+as)?|now\s+known\s+as|erstwhile(?:\s+known\s+as)?|previously(?:\s+known\s+as)?)\b\s*[-–—:,]*\s*/i;
const TRAILING_MERGE_NOTE = /[\s,;(-]*\b(?:merged\s+with|amalgamated\s+with|under\s+liquidation|in\s+liquidation)\b.*$/i;

/** { primary, aliases } for a raw scraped name, handling bracketed AND unbracketed "formerly known as". */
export function entityNames(raw) {
  const { primary, aliases } = splitAnnotations(raw);
  const out = [];
  let p = String(primary || "").replace(TRAILING_MERGE_NOTE, "").replace(/[)\s,;]+$/g, "").trim();
  const m = p.match(UNBRACKETED_ALIAS);
  if (m && m.index !== undefined) {
    const before = p.slice(0, m.index).replace(/[\s,;(-]+$/g, "").trim();
    const after = p.slice(m.index + m[0].length).replace(TRAILING_MERGE_NOTE, "").replace(/[)\s,;]+$/g, "").trim();
    if (before) {
      p = before;
      if (after) out.push(after);
    }
  }
  return { primary: p, aliases: [...aliases.map((a) => a.replace(/[)\s,;]+$/g, "").trim()), ...out].filter(Boolean) };
}

/**
 * Builds a function name -> group key for the given set of raw names.
 * Two names get the same group key when they share a canonical key
 * (primary or former name), directly or through a chain of such links.
 */
export function makeEntityKeyer(rawNames) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const primaryKeyOf = new Map();
  const keyFor = (raw) => {
    const { primary, aliases } = entityNames(raw);
    const pk = canonicalKey(primary) || String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
    return { pk, aks: aliases.map((a) => canonicalKey(a)).filter(Boolean) };
  };
  for (const raw of new Set(rawNames)) {
    const { pk, aks } = keyFor(raw);
    primaryKeyOf.set(raw, pk);
    find(pk);
    for (const a of aks) union(pk, a);
  }
  return (raw) => {
    const pk = primaryKeyOf.get(raw);
    if (pk !== undefined) return find(pk);
    return find(keyFor(raw).pk);
  };
}
