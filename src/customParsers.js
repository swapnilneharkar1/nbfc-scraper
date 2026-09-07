/**
 * customParsers.js
 * -----------------
 * RBI's Banks page and PSS page are NOT built from real <table> markup -
 * they're formatted prose/heading sections (confirmed by inspecting the
 * actual rendered page - generic table scraping on them returns either
 * nothing or one giant blob of unrelated text). BRD issues #2 and #4
 * require entity-wise extraction with correct bank/PSS sub-classification,
 * which means these two sources need bespoke parsers tuned to each page's
 * actual structure, not a generic table reader.
 *
 * Both parsers work the same way: find the clean, structurally-simple
 * "Sr.No. Name" summary list for the target section (RBI's pages do have
 * these, distinct from the messier prose used in the detailed sections
 * above them), and extract entries from that list specifically.
 */

import * as cheerio from "cheerio";

// ---------------------------------------------------------------------
// RBI Banks page
// ---------------------------------------------------------------------

// Maps our internal bankSection keys to the heading text that precedes each
// clean summary list on RBI's BanksInIndia.aspx page.
const BANK_SECTION_HEADINGS = {
  public: /Top\s+SBI\s*&\s*Nationalised\s+Banks/i,
  private: /Domestic\s+Private\s+Sector\s+Banks/i,
  foreign: /Foreign\s+banks\s+in\s+India/i,
  sfb: /Small\s+Finance\s+Banks[\s\S]{0,20}Sr\.?No/i,
  pb: /Payments\s+Banks[\s\S]{0,20}Sr\.?No/i,
  rrb: /Regional\s+Rural\s+Banks[\s\S]{0,20}Sr\.?No/i,
  lab: null, // RBI's page doesn't carry a distinct LAB summary list - see notes below
};

/**
 * Extracts a numbered "1. Name 2. Name ..." list that appears after a given
 * heading, stopping at whichever comes first: the next bank-category
 * heading, or a generous length cap.
 */
function extractNumberedListAfter(text, headingPattern, sectionKey) {
  const headingMatch = text.match(headingPattern);
  if (!headingMatch) return [];

  const startIdx = headingMatch.index + headingMatch[0].length;
  const remainder = text.slice(startIdx, startIdx + 6000);

  // Find the earliest occurrence of any OTHER section's heading - that's
  // where this section's list actually ends. Without this, one section's
  // extraction bleeds into the next (confirmed by testing against a
  // realistic multi-section fragment).
  let stopIdx = remainder.length;
  for (const [key, pattern] of Object.entries(BANK_SECTION_HEADINGS)) {
    if (key === sectionKey || !pattern) continue;
    const m = remainder.match(pattern);
    if (m && m.index < stopIdx) stopIdx = m.index;
  }
  const section = remainder.slice(0, stopIdx);

  // Split on the numbering. With a capturing group, split() interleaves
  // [pre-match-text, num, text, num, text, ...] - chunks[0] here is always
  // the "Sr.No. Name of the Bank" column-header text, not an entity, and
  // must be dropped explicitly (a pure-digit filter alone doesn't catch it).
  const rawParts = section.split(/(?:^|\s)(\d{1,3})[.)]\s+/);
  const names = [];
  for (let i = 1; i < rawParts.length; i += 2) {
    // rawParts[i] is the number just matched, rawParts[i+1] is the text
    // that follows it up to the next number - skip malformed trailing case.
    const part = rawParts[i + 1];
    if (!part) continue;
    const name = part.split(/\s{2,}|\n/)[0].trim().replace(/[,;]$/, "").replace(/\s+Top$/, "").trim();
    if (name.length >= 4 && name.length <= 100 && /^[A-Z]/.test(name)) {
      names.push(name);
    }
  }
  return [...new Set(names)];
}

/**
 * @param {string} html - rendered HTML of RBI's BanksInIndia.aspx page
 * @param {string} bankSection - key from BANK_SECTION_HEADINGS
 */
export function parseRbiBanksSection(html, bankSection) {
  const heading = BANK_SECTION_HEADINGS[bankSection];
  if (!heading) {
    return { names: [], note: "No distinct clean summary list found on RBI's page for this section." };
  }
  const $ = cheerio.load(html);
  const text = $.root().text().replace(/\s+/g, " ").trim();
  const names = extractNumberedListAfter(text, heading, bankSection);
  return { names, note: null };
}

// ---------------------------------------------------------------------
// RBI PSS page
// ---------------------------------------------------------------------

// RBI's PSS page uses lettered sections (A., B., C., D., E., F.) for each
// status category, each containing its own numbered entity list mixed with
// addresses/dates. We isolate the right lettered section, then reuse a
// numbered-list name extractor similar to pressReleases.js's, since the
// prose shape is comparable (numbered entity + address + description).
const PSS_SECTION_HEADINGS = {
  operating: /A\.\s*Certificates of Authorisation issued/i,
  revoked: /B\.\s*Certificates of Authorisation Revoked/i,
  ceased: /C\.\s*Authorised entities whose Payment System operations have ceased/i,
  cancelled: /D\.\s*Entities whose Certificate of Authorisation[\s\S]{0,40}voluntary surrender/i,
};
const NEXT_SECTION_MARKER = /\b[A-F]\.\s*(Certificates|Authorised|Entities)/;

function looksLikeEntityName(candidate) {
  const c = candidate.trim();
  if (c.length < 4 || c.length > 120) return false;
  if (/^[a-z]/.test(c)) return false;
  if ((c.match(/\. /g) || []).length > 1) return false;
  return true;
}

/**
 * @param {string} html - rendered HTML of RBI's PSS PublicationsView page
 * @param {string} pssSection - key from PSS_SECTION_HEADINGS
 */
export function parseRbiPssSection(html, pssSection) {
  const heading = PSS_SECTION_HEADINGS[pssSection];
  if (!heading) {
    return {
      names: [],
      note: `No heading pattern configured for PSS section '${pssSection}'.`,
    };
  }

  const $ = cheerio.load(html);
  const text = $.root().text().replace(/\s+/g, " ").trim();

  const headingMatch = text.match(heading);
  if (!headingMatch) {
    return { names: [], note: "Could not find this section's heading on the page - RBI may have reworded it." };
  }

  const startIdx = headingMatch.index + headingMatch[0].length;
  const remainder = text.slice(startIdx, startIdx + 20000);
  const nextMatch = remainder.slice(50).match(NEXT_SECTION_MARKER);
  const section = nextMatch ? remainder.slice(0, nextMatch.index + 50) : remainder;

  // Same interleaving caveat as extractNumberedListAfter() above - the
  // pre-first-match chunk (rawParts[0]) is never an entity, must be skipped
  // explicitly rather than relying on a pure-digit filter.
  const rawParts = section.split(/(?:^|\s)(\d{1,3})\.\s+/);
  const names = [];
  for (let i = 1; i < rawParts.length; i += 2) {
    const chunk = rawParts[i + 1];
    if (!chunk) continue;
    const cut = chunk.split(/\s{2,}|(?<=Limited|Ltd\.?|Pvt\.?|LLP)\s+(?=[A-Z])/)[0];
    const candidate = (cut || chunk).trim().replace(/[,;:]$/, "");
    if (looksLikeEntityName(candidate)) names.push(candidate);
  }

  return { names: [...new Set(names)], note: null };
}
