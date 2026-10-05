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
// Shared helpers for RBI's Banks and PSS pages
// ---------------------------------------------------------------------

/** Page text with all whitespace collapsed to single spaces (no line
 * structure). The original, unchanged section parsers use this. */
function flattenedText(html) {
  const $ = cheerio.load(html);
  return $.root().text().replace(/\s+/g, " ").trim();
}

/**
 * Text taken from the browser's rendered innerText: block elements and
 * <br> become line breaks, table cells become tabs. This keeps the
 * name/address and row boundaries that flattening throws away. Falls back
 * to flattened HTML text if innerText wasn't captured.
 */
function structuredText(html, innerText) {
  if (!innerText || !String(innerText).trim()) return flattenedText(html);
  return String(innerText)
    .replace(/ /g, " ")
    .replace(/[ ]+/g, " ")
    .replace(/ ?\t ?/g, "\t")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Splits a section into numbered entries ("1. Name ... 2. Name ...").
 *
 * A number only starts a new entry when it continues the sequence. This is
 * the fix for over-counting: addresses are full of numbers ("Plot No. 8.
 * Sector 5", "Floor 2. ...") that the previous "any number followed by a
 * dot" split treated as new entries, which is how the foreign-bank list
 * ended up with 56 names for 44 banks and PSS Ceased with 13 for 11.
 * `allowRestart` lets a list begin again at 1 (PSS section A has several
 * sub-lists, each numbered from 1).
 */
export function splitNumberedEntries(section, { allowRestart = false, rejectStart = null } = {}) {
  // "1. Name" / "1.Name" / "1) Name" and, for table cells in innerText,
  // "1<TAB>Name". Only the number itself is consumed, so a rejected
  // candidate (e.g. the "004." tail of a pin code) can never swallow the
  // whitespace that the NEXT real entry number needs.
  const re = /(?<![A-Za-z0-9])(\d{1,3})(?:[.)](?=\s+[A-Za-z0-9"'(])|[.)](?=[A-Za-z"'(])|(?=\t[A-Za-z0-9"'(]))/g;
  const marks = [];
  let last = 0;
  let m;
  while ((m = re.exec(section)) !== null) {
    if (m[1].length > 1 && m[1].startsWith("0")) continue; // "004." - tail of a pin code, not a serial number
    const n = parseInt(m[1], 10);
    const accept =
      marks.length === 0
        ? n <= 3
        : (n > last && n <= last + 2) || (allowRestart && n === 1 && last > 1);
    if (!accept) continue;
    let bodyStart = m.index + m[0].length;
    while (bodyStart < section.length && /\s/.test(section[bodyStart])) bodyStart++;
    // "...Building No. 8. Sector 25" must not start entry 8: an entry never
    // begins with an address word.
    if (rejectStart && rejectStart.test(section.slice(bodyStart, bodyStart + 40))) continue;
    marks.push({ n, start: m.index, bodyStart });
    last = n;
  }
  return marks.map((mk, i) => section.slice(mk.bodyStart, i + 1 < marks.length ? marks[i + 1].start : section.length));
}

// Legal-form words that END a company name. Deliberately excludes the
// ambiguous short ones (AG, SA, NV...) so a name that merely contains
// those letters is never cut early.
const LEGAL_START = [
  String.raw`Private\s+Limited`,
  String.raw`Pvt\.?\s*Ltd\.?`,
  String.raw`Pvt\.?`,
  String.raw`Limited`,
  String.raw`Ltd\.?`,
  String.raw`L\.?L\.?P\.?`,
  String.raw`L\.?L\.?C\.?`,
  String.raw`Incorporated`,
  String.raw`Inc\.?`,
  String.raw`Corporation(?:\s+of\s+India)?`,
  String.raw`Corp\.?`,
  String.raw`PLC`,
  String.raw`GmbH`,
  String.raw`Pte\.?(?:\s*Ltd\.?)?`,
].join("|");
const LEGAL_EXTEND = `${LEGAL_START}|Private|Company|Co\\.`;

const COUNTRY =
  String.raw`UAE|U\.A\.E\.?|Ireland|India|USA|U\.S\.A\.?|UK|U\.K\.?|United\s+(?:Arab\s+Emirates|Kingdom|States)|Singapore|Hong\s+Kong|Dubai|Netherlands|Germany|Japan|France|Australia|Canada|Cyprus|Switzerland|Luxembourg|Mauritius|Sri\s+Lanka|Nepal|Bangladesh|Malaysia|Thailand|Qatar|Bahrain|Kuwait|Oman|Saudi\s+Arabia|Philippines|Indonesia|China|Korea|Israel|Sweden|Spain|Italy|Belgium|Austria|Norway|Denmark|Finland|Poland|Estonia|Lithuania|Latvia|Malta|Bermuda|Cayman\s+Islands`;

/**
 * Cuts an entry such as "Card Pro Solutions Pvt. Ltd. Prepaid Payment
 * Instruments 12-03-2019 ..." down to the company name, ending at its
 * legal-form words ("Pvt. Ltd." is ONE unit - the previous cut stopped
 * after "Pvt." and left a truncated name), keeping an immediately
 * following "(formerly ...)" note and a ", <Country>" suffix, both of
 * which are part of the name as RBI publishes it
 * ("UAE Exchange Centre LLC, UAE", "Infibeam Avenues Limited (formerly
 * Avenues India Private Limited)"). Returns null if no legal form is found.
 */
export function cutNameAtLegalForm(raw) {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  const startRe = new RegExp(`(?<![A-Za-z0-9])(?:${LEGAL_START})(?![A-Za-z])`, "i");
  const m = startRe.exec(s);
  if (!m) return null;
  let end = m.index + m[0].length;

  // further legal-form words directly after ("Private" + "Limited", "Bank" + "Ltd.")
  const extendRe = new RegExp(`^\\s*(?:${LEGAL_EXTEND})(?![A-Za-z])`, "i");
  for (let guard = 0; guard < 4; guard++) {
    const e = extendRe.exec(s.slice(end));
    if (!e) break;
    end += e[0].length;
  }
  // an immediately following parenthetical note, e.g. "(formerly X Private Limited)"
  const paren = /^\s*\((?:[^()]|\([^()]*\))*\)/.exec(s.slice(end));
  if (paren) end += paren[0].length;
  // ", <Country>"
  const country = new RegExp(`^\\s*,\\s*(?:${COUNTRY})(?![A-Za-z])`, "i").exec(s.slice(end));
  if (country) end += country[0].length;

  return s.slice(0, end).trim().replace(/[,;:]+$/, "");
}

// Words that start the ADDRESS in entries such as "AB Bank PLC 41 / 42
// Liberty Building, Sir Vithaldas Thakersey Marg ...". "Express" alone is
// intentionally not a cue ("American Express Banking Corporation").
const ADDRESS_WORDS =
  "Plot|Unit|Level|Floor|Flr|Towers?|Building|Bldg|Block|Wing|Suite|Office|Cyber|Raheja|Maker|Nariman|World\\s+Trade|Centre|Center|Mittal|Hoechst|Sir|Dr\\.|Mahatma|Mumbai|Delhi|Gurgaon|Gurugram|Chennai|Kolkata|Bangalore|Bengaluru|Hyderabad|Ahmedabad|Pune|Fort|Bandra|Kurla|Worli|Lower|Veer|Jeevan|BKC|Road|Street|Marg|Nagar|Sector|Phase|Ground|Opp|Near|Behind|Apeejay|Mafatlal|Dalamal|Eros|Kakad|Cuffe|Colaba|Prabhadevi|Dadar|Lodha|Equinox|Peninsula|House|Chambers|Mansion|Plaza|Arcade|Complex|Heights|Square|Bhavan|Express\\s+Towers?";
const ADDRESS_CUE = new RegExp(`(?<![A-Za-z0-9])(?:\\d|${ADDRESS_WORDS})(?![A-Za-z])`, "i");
// An entry in a list of banks never BEGINS with a digit or an address word.
const BANK_ENTRY_REJECT_START = new RegExp(`^(?:\\d|${ADDRESS_WORDS})(?![A-Za-z])`, "i");
// Only STRONG corporate forms may trigger trimming. "Bank", "Banking",
// "Group" and "Branch" are excluded on purpose: they are often followed by
// more of the name ("Bank of America", "Bank of Nova Scotia").
const BANK_NAME_TOKEN =
  /(?<![A-Za-z0-9])(?:PLC\.?|Ltd\.?|Limited|N\.A\.?|A\.G\.?|AG|S\.A\.?|SA|N\.V\.?|NV|B\.S\.C\.?(?:\(c\))?|P\.J\.S\.C\.?|PJSC|Q\.P\.S\.C\.?|P\.S\.C\.?|TBK|Corporation|Corp\.?|Co\.|Company|LLC|Inc\.?|U\.A\.?|B\.A\.?|S\.A\.O\.G\.?)(?![A-Za-z])/gi;

/**
 * Cuts "<Bank name> <address...>" at the start of the address: the first
 * digit-led token or address word. Within what remains, the name is
 * trimmed back to its last corporate-form word so a stray address word
 * ("... N.A. Express") can't stay attached. Foreign banks do not end in
 * one consistent suffix ("Bank of America", "BNP Paribas"), which is why
 * this works from the address side instead.
 */
export function cutNameAtAddress(raw) {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  let segment = s;
  const cue = ADDRESS_CUE.exec(s);
  if (cue && cue.index >= 3) segment = s.slice(0, cue.index);

  if (segment.length === s.length) {
    // no address cue found - fall back to the legal-form cut, else the first words
    const byLegal = cutNameAtLegalForm(s);
    if (byLegal) return byLegal;
    return s.split(" ").slice(0, 6).join(" ");
  }

  let lastEnd = -1;
  let t;
  BANK_NAME_TOKEN.lastIndex = 0;
  while ((t = BANK_NAME_TOKEN.exec(segment)) !== null) lastEnd = t.index + t[0].length;
  let name = lastEnd > 0 ? segment.slice(0, lastEnd) : segment;
  // keep a closing bracket belonging to the last token, e.g. "(Q.P.S.C.)"
  const rest = segment.slice(name.length);
  if ((name.match(/\(/g) || []).length > (name.match(/\)/g) || []).length && /^\)/.test(rest)) name += ")";
  return name.trim().replace(/[,;:]+$/, "");
}

/** Cuts at the first Ltd./Limited/Maryadit style word (state co-operative bank names). */
export function cutNameAtFirstSuffix(raw) {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  const m = /(?<![A-Za-z])(?:Ltd\.?|Limited|Maryadita|Maryadit|Mydt\.?)(?![A-Za-z])/i.exec(s);
  if (!m) return null;
  return s.slice(0, m.index + m[0].length).trim();
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
  lab: null, // handled by its own parser below - see parseLocalAreaBanks()
};

// Where a section ends. Sections whose parsers are unchanged keep their
// ORIGINAL stop-heading set (so their results cannot shift); the newer
// parsers (foreign, state co-operative) also stop at each other.
const LEGACY_STOP_HEADINGS = BANK_SECTION_HEADINGS;
const STATE_COOP_HEADING = /State\s+Co-?operative\s+Banks[^0-9]{0,80}?(?=(?:^|\s)1[.)]\s+[A-Za-z])/i;
const NEW_STOP_HEADINGS = {
  ...BANK_SECTION_HEADINGS,
  state_coop: STATE_COOP_HEADING,
  rrb_loose: /Regional\s+Rural\s+Banks/i,
};

/**
 * Extracts a numbered "1. Name 2. Name ..." list that appears after a given
 * heading, stopping at whichever comes first: the next bank-category
 * heading, or a generous length cap. (ORIGINAL logic, used unchanged for
 * Public / Private / SFB / PB / RRB. The only change: a name may start with
 * a lowercase letter if it is clearly a bank - "slice Small Finance Bank
 * Limited" is spelled that way by RBI and was being thrown away by the
 * capital-letter test.)
 */
function extractNumberedListAfter(text, headingPattern, sectionKey) {
  const headingMatch = text.match(headingPattern);
  if (!headingMatch) return [];

  const startIdx = headingMatch.index + headingMatch[0].length;
  const remainder = text.slice(startIdx, startIdx + 6000);

  let stopIdx = remainder.length;
  for (const [key, pattern] of Object.entries(LEGACY_STOP_HEADINGS)) {
    if (key === sectionKey || !pattern) continue;
    const m = remainder.match(pattern);
    if (m && m.index < stopIdx) stopIdx = m.index;
  }
  const section = remainder.slice(0, stopIdx);

  const rawParts = section.split(/(?:^|\s)(\d{1,3})[.)]\s+/);
  const names = [];
  for (let i = 1; i < rawParts.length; i += 2) {
    const part = rawParts[i + 1];
    if (!part) continue;
    const name = part.split(/\s{2,}|\n/)[0].trim().replace(/[,;]$/, "").replace(/\s+Top$/, "").trim();
    const startsOk = /^[A-Z]/.test(name) || (/^[a-z]/.test(name) && /\b(Bank|Limited|Ltd)\b/i.test(name));
    if (name.length >= 4 && name.length <= 100 && startsOk) {
      names.push(name);
    }
  }
  return [...new Set(names)];
}

/** Finds the text between a heading match and the next stop heading. */
function sectionAfter(text, headingMatch, stopPatterns, selfKey, maxLen = 60000) {
  const startIdx = headingMatch.index + headingMatch[0].length;
  const remainder = text.slice(startIdx, startIdx + maxLen);
  let stopIdx = remainder.length;
  for (const [key, pattern] of Object.entries(stopPatterns)) {
    if (key === selfKey || !pattern) continue;
    const m = remainder.match(pattern);
    if (m && m.index < stopIdx) stopIdx = m.index;
  }
  return remainder.slice(0, stopIdx);
}

/** Foreign banks: numbered list of "Name + address" entries. */
function parseForeignBanks(html, innerText) {
  const text = structuredText(html, innerText);
  const heading = BANK_SECTION_HEADINGS.foreign;
  const re = new RegExp(heading.source, "gi");
  let best = [];
  let hm;
  while ((hm = re.exec(text)) !== null) {
    const section = sectionAfter(text, hm, NEW_STOP_HEADINGS, "foreign");
    const entries = splitNumberedEntries(section, { rejectStart: BANK_ENTRY_REJECT_START });
    const names = entries
      .map((e) => cutNameAtAddress(e.split("\n")[0]))
      .map((n) => n.replace(/^[\s.]+|[\s,;]+$/g, ""))
      .filter((n) => n.length >= 4 && n.length <= 120 && /^[A-Za-z]/.test(n));
    if (names.length > best.length) best = names;
  }
  return [...new Set(best)];
}

// A foreign-bank name normally ends in one of these. A name that does not
// may still have address text attached, so it is reported for review.
const USUAL_BANK_NAME_END =
  /(?:bank|banking|ltd\.?|limited|plc\.?|n\.a\.?|a\.g\.?|ag|s\.a\.?|sa|n\.v\.?|nv|b\.s\.c\.?|p\.j\.s\.c\.?|pjsc|q\.p\.s\.c\.?|p\.s\.c\.?|tbk|corporation|corp\.?|co\.|company|llc|inc\.?|u\.a\.?|b\.a\.?|paribas|generale|\)|bank\))$/i;

/**
 * Local Area Banks. RBI's page has no clean standalone summary list for
 * them (the PDF the previous version used lists the wrong banks), but
 * every LAB name contains the words "Local Area Bank" and ends in
 * Ltd./Limited, which is distinctive enough to pick the names out of the
 * page directly.
 */
function parseLocalAreaBanks(html, innerText) {
  const found = [];
  if (innerText && String(innerText).trim()) {
    // one field per table cell / line, so a row's name can't absorb the previous row's address
    const fields = String(innerText).replace(/ /g, " ").split(/[\n\t]+/);
    for (const f of fields) {
      const m = /^\s*(?:\d{1,3}[.)]?\s+)?([A-Z][^|]*?\bLocal\s+Area\s+Banks?\s+(?:Ltd\.?|Limited))(?![A-Za-z])/.exec(f);
      if (m) found.push(m[1].replace(/\s+/g, " ").trim());
    }
  }
  if (found.length === 0) {
    // flattened fallback: drop leading words that belong to the previous row's address
    const text = flattenedText(html);
    const re = /((?:[A-Z][A-Za-z.&'’-]*\s+){1,6})Local\s+Area\s+Banks?\s+(?:Ltd\.?|Limited)(?![A-Za-z])/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      let lead = m[1].trim().split(/\s+/);
      const addressTail = /^(?:\d{5,6}|Pradesh|Nadu|Karnataka|Maharashtra|Gujarat|Kerala|Telangana|Bengal|Odisha|Bihar|Assam|Punjab|Haryana|Rajasthan|Goa|Delhi|Jharkhand|India)$/;
      let cut = -1;
      lead.forEach((w, i) => {
        if (addressTail.test(w)) cut = i;
      });
      lead = lead.slice(cut + 1);
      if (lead.length === 0) continue;
      found.push(`${lead.join(" ")} ${m[0].slice(m[1].length)}`.replace(/\s+/g, " ").trim());
    }
  }
  const seen = new Set();
  return found.filter((n) => {
    const k = n.toUpperCase().replace(/\b(LTD|LIMITED)\b\.?/g, "").replace(/[^A-Z0-9]/g, "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * State Co-operative Banks. RBI lists all of them in ONE numbered block
 * (scheduled and non-scheduled together, e.g. 34 entries), each as
 * "N. <Bank name> Ltd. <address>". Returns every bank in the block;
 * the caller splits scheduled / non-scheduled.
 */
function parseStateCoopBlock(html, innerText) {
  const text = structuredText(html, innerText);
  const re = new RegExp(STATE_COOP_HEADING.source, "gi");
  let best = [];
  let hm;
  while ((hm = re.exec(text)) !== null) {
    const section = sectionAfter(text, hm, NEW_STOP_HEADINGS, "state_coop");
    const names = splitNumberedEntries(section, { rejectStart: BANK_ENTRY_REJECT_START })
      .map((e) => {
        const first = e.split("\n")[0];
        return cutNameAtFirstSuffix(first) || cutNameAtAddress(first);
      })
      .map((n) => n.replace(/^[\s.]+|[\s,;]+$/g, ""))
      .filter((n) => n.length >= 6 && n.length <= 120);
    if (names.length > best.length) best = names;
  }
  return [...new Set(best)];
}

/**
 * Scheduled vs non-scheduled State Co-operative Banks. RBI's page does not
 * separate them; RBI's own classification is that these ten (smaller / NE
 * / UT) banks are non-scheduled. That list lives in sources.js
 * (`nonScheduledKeywords`) so it can be edited without touching code.
 */
export function parseRbiStateCoop(html, innerText, { scope, nonScheduledKeywords = [] } = {}) {
  const all = parseStateCoopBlock(html, innerText);
  if (all.length === 0) {
    return { names: [], note: "Could not find the State Co-operative Banks list on RBI's Banks page - RBI may have restructured it." };
  }
  const isNonScheduled = (n) => nonScheduledKeywords.some((k) => n.toLowerCase().includes(k.toLowerCase()));
  const nonScheduled = all.filter(isNonScheduled);
  const scheduled = all.filter((n) => !isNonScheduled(n));
  const unmatchedKeywords = nonScheduledKeywords.filter((k) => !all.some((n) => n.toLowerCase().includes(k.toLowerCase())));
  const notes = [`State Co-op block: ${all.length} banks (${scheduled.length} scheduled, ${nonScheduled.length} non-scheduled).`];
  if (unmatchedKeywords.length) notes.push(`Non-scheduled keyword(s) with no bank on the page: ${unmatchedKeywords.join(", ")}.`);
  return { names: scope === "non_scheduled" ? nonScheduled : scheduled, note: notes.join(" ") };
}

/**
 * @param {string} html - rendered HTML of RBI's BanksInIndia.aspx page
 * @param {string} bankSection - key from BANK_SECTION_HEADINGS
 * @param {string|null} innerText - browser innerText of the same page (optional but preferred)
 */
export function parseRbiBanksSection(html, bankSection, innerText = null) {
  if (bankSection === "lab") {
    const names = parseLocalAreaBanks(html, innerText);
    return { names, note: names.length ? null : "No bank with 'Local Area Bank' in its name found on RBI's page." };
  }
  if (bankSection === "foreign") {
    const names = parseForeignBanks(html, innerText);
    const suspect = names.filter((n) => !USUAL_BANK_NAME_END.test(n));
    return {
      names,
      note: suspect.length
        ? `${suspect.length} foreign-bank name(s) do not end in a usual bank/legal word and may carry address text - review: ${suspect.join(" | ")}`
        : null,
    };
  }
  const heading = BANK_SECTION_HEADINGS[bankSection];
  if (!heading) {
    return { names: [], note: "No distinct clean summary list found on RBI's page for this section." };
  }
  const names = extractNumberedListAfter(flattenedText(html), heading, bankSection);
  return { names, note: null };
}

// ---------------------------------------------------------------------
// RBI PSS page
// ---------------------------------------------------------------------

// RBI's PSS page uses lettered sections (A., B., C., D., E., F.) for each
// status category, each containing its own numbered entity list mixed with
// addresses/dates.
const PSS_SECTION_HEADINGS = {
  operating: /A\.\s*Certificates of Authorisation issued/i,
  revoked: /B\.\s*Certificates of Authorisation Revoked/i,
  ceased: /C\.\s*Authorised entities whose Payment System operations have ceased/i,
  surrendered: /D\.\s*Entities whose Certificate of Authorisation[\s\S]{0,150}voluntary surrender/i,
  cancelled_regulatory: /E\.\s*Entities whose Certificate of Authorisation[\s\S]{0,150}regulatory requirement/i,
};
// Case-insensitive on the letter too - RBI's page uses a lowercase "f." for
// the "under process of cancellation" section, confirmed by inspection.
const NEXT_SECTION_MARKER = /\b[A-Fa-f]\.\s*(Certificates|Authorised|Entities)/;

// Text describing the payment system / status that can follow a name.
const PAYMENT_STATUS_TEXT =
  /\b(?:Prepaid|PPI|Payment\s+(?:Aggregator|System|Status|Instruments?)|Cross[-\s]?Border|White\s+Label|ATM|Card\s+Network|Money\s+Transfer\s+Service|Authori[sz]ed|Authori[sz]ation|Ceased|Revoked|Surrendered|Cancelled|Operating)\b/i;

function looksLikeEntityName(candidate) {
  const c = candidate.trim();
  if (c.length < 4 || c.length > 220) return false;
  if (/^[a-z]/.test(c) && !cutNameAtLegalForm(c)) return false;
  if ((c.match(/\. /g) || []).length > 2) return false;
  return true;
}

/** Name for one PSS entry: legal-form cut, else cut where payment/status text begins. */
function pssNameFromEntry(entry) {
  const lines = entry.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines[0] || "";
  const byLegal = cutNameAtLegalForm(first) || (lines[1] ? cutNameAtLegalForm(`${first} ${lines[1]}`) : null);
  if (byLegal) return byLegal;
  const status = PAYMENT_STATUS_TEXT.exec(first);
  const cut = status && status.index > 8 ? first.slice(0, status.index) : first.split(" ").slice(0, 8).join(" ");
  return cut.trim().replace(/[,;:]+$/, "");
}

/**
 * @param {string} html - rendered HTML of RBI's PSS PublicationsView page
 * @param {string} pssSection - key from PSS_SECTION_HEADINGS
 * @param {string|null} innerText - browser innerText of the same page (optional but preferred)
 */
export function parseRbiPssSection(html, pssSection, innerText = null) {
  const heading = PSS_SECTION_HEADINGS[pssSection];
  if (!heading) {
    return {
      names: [],
      note: `No heading pattern configured for PSS section '${pssSection}'.`,
    };
  }

  const text = structuredText(html, innerText);

  const headingMatch = text.match(heading);
  if (!headingMatch) {
    return { names: [], note: "Could not find this section's heading on the page - RBI may have reworded it." };
  }

  const startIdx = headingMatch.index + headingMatch[0].length;
  // Was a hard 20,000-character window, which cut the long Operating list
  // short (45 names where RBI lists ~78). The next lettered heading is the
  // real end of the section.
  const remainder = text.slice(startIdx);
  const nextMatch = remainder.slice(50).match(NEXT_SECTION_MARKER);
  const section = nextMatch ? remainder.slice(0, nextMatch.index + 50) : remainder.slice(0, 200000);

  const names = splitNumberedEntries(section, { allowRestart: true })
    .map(pssNameFromEntry)
    .filter(looksLikeEntityName);

  return { names: [...new Set(names)], note: null };
}
