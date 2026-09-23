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
// SEBI "Recognised Intermediaries" pages
// ---------------------------------------------------------------------
// Confirmed by direct inspection: these pages have NO <table> element at
// all - they're a repeated "Name / Registration No. / E-mail / Telephone /
// Address / Contact Person / ... / Validity" label-value block per entity,
// server-rendered as plain HTML (no JS execution needed - a simple fetch
// sees the same content). The generic extractTables() approach in
// scraper.js was correctly finding nothing, because there genuinely is no
// <table> to find - this needs a bespoke label-value parser instead.

/**
 * @param {string} html - HTML of a SEBI OtherAction.do?doRecognisedFpi=yes&intmId=N page
 */
/**
 * Parses SEBI's "Recognised Intermediaries" hub page (doRecognised=yes,
 * no intmId) into {intmId -> {label, expectedCount}}. This page's own
 * table reliably shows the TRUE total record count per category (e.g.
 * "Stock Brokers in equity segment: 4994") - confirmed by direct
 * inspection. Used as a validation target: a category scrape that falls
 * short of this number is known-incomplete, not just suspected.
 */
export function parseSebiHubCounts(html) {
  const $ = cheerio.load(html);
  const counts = new Map();
  $("table").each((_, tableEl) => {
    const rows = [];
    $(tableEl)
      .find("tr")
      .each((__, trEl) => {
        const cells = $(trEl)
          .find("th,td")
          .map((___, el) => $(el).text().replace(/\s+/g, " ").trim())
          .get();
        const link = $(trEl).find("a[href*='intmId=']").attr("href") || null;
        if (cells.length > 0) rows.push({ cells, link });
      });
    if (rows.length < 2) return;

    const headerIdx = rows.findIndex((r) => r.cells.some((c) => /^count$/i.test(c)));
    if (headerIdx === -1) return;
    const countIdx = rows[headerIdx].cells.findIndex((c) => /^count$/i.test(c));

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const { cells, link } = rows[i];
      if (!link) continue;
      const match = link.match(/intmId=(\d+)/);
      if (!match) continue;
      const countText = cells[countIdx];
      if (!countText || !/^\d+$/.test(countText)) continue;
      counts.set(match[1], { label: cells[1] || cells[0], expectedCount: parseInt(countText, 10) });
    }
  });
  return counts;
}

export function parseSebiIntermediaryPage(html) {
  // SEBI's category pages actually use two different templates - confirmed
  // by direct inspection: some (Credit Rating Agency) render as label-value
  // blocks; others (e.g. broker/bank-style listings) render as a real
  // <table> with a "Sr. No. | Name | ..." header. Try the table format
  // first since it's the more common/structured one, fall back to the
  // label-value regex otherwise.
  const fromTable = extractSebiTable(html);
  if (fromTable.length > 0) return { names: fromTable, note: null };

  const $ = cheerio.load(html);
  const text = $.root().text().replace(/[ \t]+/g, " ").replace(/\n+/g, "\n").trim();

  // Every entity block starts with a "Name" label immediately followed by
  // the entity name, then "Registration No." - this pair is unique enough
  // to reliably delimit entities even though the page has no table markup.
  const matches = [...text.matchAll(/\bName\s*\n?\s*(.+?)\s*\n?\s*Registration No\./g)];
  const names = matches
    .map((m) => m[1].trim())
    .filter((name) => name.length >= 3 && name.length <= 150 && !/^\d+$/.test(name));

  return { names: [...new Set(names)], note: names.length === 0 ? "No table and no Name/Registration No. pairs found - SEBI may have changed this page's layout." : null };
}

function extractSebiTable(html) {
  const $ = cheerio.load(html);
  const names = [];
  $("table").each((_, tableEl) => {
    const rows = [];
    $(tableEl)
      .find("tr")
      .each((__, trEl) => {
        const cells = $(trEl)
          .find("th,td")
          .map((___, cellEl) => $(cellEl).text().replace(/\s+/g, " ").trim())
          .get();
        if (cells.some((c) => c.length > 0)) rows.push(cells);
      });
    if (rows.length < 2) return;
    const headerIdx = rows.findIndex((r) => r.some((cell) => /^name$/i.test(cell) || /^name\b/i.test(cell)));
    if (headerIdx === -1) return;
    const headerRow = rows[headerIdx];
    const nameIdx = headerRow.findIndex((h) => /^name$/i.test(h) || /^name\b/i.test(h));
    if (nameIdx === -1) return;
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const name = (rows[i][nameIdx] || "").trim();
      if (name && !/^(sl\.?\s*no\.?|s\.?\s*no\.?)$/i.test(name) && name.length <= 150) {
        names.push(name);
      }
    }
  });
  return [...new Set(names)];
}

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
  // Real heading text (confirmed): "D. Entities whose Certificate of
  // Authorisation to operate a Payment System have been cancelled on
  // account of voluntary surrender by the entity" - the gap between
  // "Authorisation" and "voluntary surrender" is ~65 chars, so the previous
  // {0,40} cap silently failed to match this section at all. Also splitting
  // D (voluntary surrender) and E (regulatory cancellation) into their own
  // categories - they were previously lumped into one "cancelled" bucket
  // and D's mismatch meant E's content leaked into it uncontrolled.
  surrendered: /D\.\s*Entities whose Certificate of Authorisation[\s\S]{0,150}voluntary surrender/i,
  cancelled_regulatory: /E\.\s*Entities whose Certificate of Authorisation[\s\S]{0,150}regulatory requirement/i,
};
// Case-insensitive on the letter too - RBI's page uses a lowercase "f." for
// the "under process of cancellation" section, confirmed by inspection.
const NEXT_SECTION_MARKER = /\b[A-Fa-f]\.\s*(Certificates|Authorised|Entities)/;

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
    const cut = chunk.split(/\s{2,}|(?<=Limited|Ltd\.?|Pvt\.?|LLP|LLC|Inc\.?|Corp\.?|Corporation|Co\.|PLC|GmbH|N\.V\.),?\s+(?=[A-Z])/)[0];
    const candidate = (cut || chunk).trim().replace(/[,;:]$/, "");
    if (looksLikeEntityName(candidate)) names.push(candidate);
  }

  return { names: [...new Set(names)], note: null };
}
