/**
 * manualOverrides.js
 * -------------------
 * One-time corrections for names the regulator has not yet updated.
 * Each entry renames the regulator's row to "<new name> (Formerly: <name as published>)", so the
 * entity key, the priority matrix and the name-check all know both names.
 * Delete an entry once the regulator's list carries the new name (it then simply stops applying).
 */
import { canonicalKey } from "./statusMerge.js";

export const NAME_OVERRIDES = [
  {
    sourceKeys: ["rbi_nbfc", "rbi_nbfc_cancelled"],
    publishedName: "Standard Chartered Investments & Loans (India) Limited",
    newName: "Standard Chartered Capital Limited",
  },
];

export function applyNameOverrides(sourceKey, names) {
  const rules = NAME_OVERRIDES.filter((r) => r.sourceKeys.includes(sourceKey));
  if (!rules.length) return { names, applied: 0 };
  let applied = 0;
  const out = names.map((n) => {
    for (const r of rules) {
      if (canonicalKey(n) === canonicalKey(r.publishedName)) {
        applied++;
        return `${r.newName} (Formerly: ${n.trim()})`;
      }
    }
    return n;
  });
  return { names: out, applied };
}
