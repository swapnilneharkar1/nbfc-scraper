/**
 * sebiUtils.js
 * -------------
 * Pure helpers for SEBI's "Recognised Intermediaries" categories.
 */

/** True when an href points at exactly this intmId (so id 2 never matches 21, 23, 25...). */
export function hrefHasIntmId(href, intmId) {
  return new RegExp(`[?&]intmId=${intmId}(?:&|$)`).test(href || "");
}

/**
 * Cross-checks a configured SEBI category against the labels on SEBI's own
 * hub page (the page lists every category with its intmId and record
 * count). If the configured id is labelled as something else, and exactly
 * one hub row matches the source's `hubLabelHint`, that row is used
 * instead - this protects against a wrong/changed id silently scraping a
 * different category.
 *
 * @param {{url:string, hubLabelHint?:RegExp|string}} source
 * @param {Map<string,{label:string, expectedCount:number}>} hubCounts - from parseSebiHubCounts()
 * @returns {{intmId:string|null, hubLabel:string|null, expectedCount:number|null, changedFrom:string|null, warning:string|null}}
 */
export function resolveSebiIntmId(source, hubCounts) {
  const configured = (String(source.url).match(/intmId=(\d+)/) || [])[1] || null;
  const hint = source.hubLabelHint ? new RegExp(source.hubLabelHint, "i") : null;
  const entryFor = (id) => (id && hubCounts ? hubCounts.get(id) : undefined);

  const configuredEntry = entryFor(configured);
  const base = {
    intmId: configured,
    hubLabel: configuredEntry ? configuredEntry.label : null,
    expectedCount: configuredEntry ? configuredEntry.expectedCount : null,
    changedFrom: null,
    warning: null,
  };
  if (!hint || !hubCounts || hubCounts.size === 0 || !configuredEntry) return base;
  if (hint.test(configuredEntry.label)) return base; // configured id is labelled as expected

  const matches = [...hubCounts.entries()].filter(([, v]) => hint.test(v.label));
  if (matches.length === 1) {
    const [id, v] = matches[0];
    return {
      intmId: id,
      hubLabel: v.label,
      expectedCount: v.expectedCount,
      changedFrom: configured,
      warning: `configured intmId=${configured} is "${configuredEntry.label}" on SEBI's hub page, not what this source expects; using intmId=${id} ("${v.label}") instead.`,
    };
  }
  return {
    ...base,
    warning: `configured intmId=${configured} is labelled "${configuredEntry.label}" on SEBI's hub page, which does not look like this category, and ${matches.length === 0 ? "no" : "more than one"} hub row matches - kept the configured id; please check.`,
  };
}
