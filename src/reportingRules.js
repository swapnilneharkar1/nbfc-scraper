/**
 * reportingRules.js
 * ------------------
 * Entity-level corrections to the category a scraped row is reported under.
 *   - RBI's NBFC list carries HFCs (Classification = "HFC"): report them as
 *     HFCs / "Housing Finance Companies", not as generic NBFC / "Other NBFCs".
 *   - ARCs (Asset Reconstruction Companies) are in RBI's NBFC file: report
 *     them under "Other NBFCs" with classification "ARC".
 */
const ARC_TOKEN = /\bARCs?\b/; // upper-case only, so "Northern Arc Capital" is not an ARC
const ARC_WORDS = /asset[s]?\s+reconstruction|securiti[sz]ation\s+(?:and|&)\s+reconstruction/i;
const isArcName = (n) => ARC_TOKEN.test(n) || ARC_WORDS.test(n);
const HFC_CLASSIFICATION = /^\s*HFCs?\s*$/i;

export function reportingCategory(source, name, classification) {
  const base = {
    categoryAsPerRegulator: classification || source.categoryAsPerRegulator,
    categoryAsPerReturn: source.categoryAsPerReturn,
  };
  if (classification && HFC_CLASSIFICATION.test(classification)) {
    return { categoryAsPerRegulator: "HFCs", categoryAsPerReturn: "Housing Finance Companies" };
  }
  if (source.key === "rbi_nbfc") {
    if (classification === "ARC" || isArcName(String(name || ""))) {
      return { categoryAsPerRegulator: "ARC", categoryAsPerReturn: "Other NBFCs" };
    }
  }
  return base;
}
