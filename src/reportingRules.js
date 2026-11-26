/**
 * reportingRules.js
 * ------------------
 * Entity-level corrections to the category a scraped row is reported under.
 *   - RBI's NBFC list carries HFCs (Classification = "HFC"): report them as
 *     HFCs / "Housing Finance Companies", not as generic NBFC / "Other NBFCs".
 *   - ARCs (Asset Reconstruction Companies) are in RBI's NBFC file: report
 *     them under "Other Financial Entities" with classification "ARC".
 */
const ARC_TOKEN = /\bARCs?\b/; // upper-case only, so "Northern Arc Capital" is not an ARC
const ARC_WORDS = /\breconstruction\b/i; // "Asset(s) Reconstruction", "Securitisation & Reconstruction", "Assets Care & Reconstruction Enterprise"
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
  if (source.key === "rbi_nbfc" || source.key === "rbi_nbfc_cancelled") {
    if (classification === "ARC" || isArcName(String(name || ""))) {
      return { categoryAsPerRegulator: "ARC", categoryAsPerReturn: "Other Financial Entities" };
    }
  }
  return base;
}

/**
 * An RBI NBFC whose registration is cancelled (RBI's cancelled-CoR list, or a press-release cancellation / surrender
 * applied to the master list) is reported as "Cancelled NBFC" - not as an active NBFC category. It is ranked below the
 * active intermediary categories (brokers, depository participants ...), so such an entity is reported under its active
 * "Other Financial Entities" membership, and above CA-Insurer-List and cancelled PSS rows. ARCs stay under
 * "Other Financial Entities". Mutates and returns the hit.
 */
export const CANCELLED_NBFC = "Cancelled NBFC";
export function applyCancelledNbfc(hit) {
  if (hit.sourceKey !== "rbi_nbfc" && hit.sourceKey !== "rbi_nbfc_cancelled") return hit;
  if (!/cancel|surrender/i.test(String(hit.status || ""))) return hit;
  if (hit.categoryAsPerRegulator === "ARC") return hit;
  hit.categoryAsPerReturn = CANCELLED_NBFC;
  hit.rankCategory = CANCELLED_NBFC; // ranking only; Category (as per Regulator) keeps RBI's own classification
  return hit;
}
