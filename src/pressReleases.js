/**
 * pressReleases.js
 * -----------------
 * Implements the "Press Release Delta" logic from the BRD:
 *
 *   1. Fetch RBI press releases published after the master list's date.
 *   2. Find the ones announcing NBFC status changes (cancelled / surrendered
 *      / suspended / restored).
 *   3. Pull out the affected entity names.
 *
 * DATA SOURCE: RBI's actual RSS feed (https://www.rbi.org.in/pressreleases_rss.xml).
 * This was chosen over scraping the press-release archive page because that
 * page filters by year/month through an ASPX postback that a script can't
 * drive without a full headless browser walking every month - fragile and
 * slow. The RSS feed is plain, stable XML.
 *
 * IMPORTANT LIMITATION - READ BEFORE RELYING ON THIS FOR COMPLIANCE:
 * RSS feeds only carry RBI's most recent press releases (observed: roughly
 * the last 10-50 items, not a full historical archive). That's fine for an
 * scraper that runs on a regular schedule (each run picks up whatever's new
 * since the last one), but it means:
 *   - If this scraper hasn't been running continuously since your master
 *     list's date, the RSS feed may no longer contain everything published
 *     in that gap. A long-idle first run can miss older changes.
 *   - Fix for that specific situation: manually check RBI's press release
 *     archive (https://rbi.org.in/scripts/BS_PressReleaseDisplay.aspx) for
 *     the gap period once, going forward the scheduled runs keep it current.
 *
 * NAME-EXTRACTION LIMITATION:
 * RBI's press releases are free-form prose, not structured data, and the
 * exact wording/formatting varies release to release (numbered list in some,
 * run-on prose in others, company names mixed with addresses in some). The
 * extractor below is a best-effort heuristic, not a guarantee. Every delta
 * it produces should be spot-checked against the source press release
 * (linked in the output) before being treated as authoritative - this is
 * flagged per-row in the output, not just in this comment.
 */

import axios from "axios";
import * as cheerio from "cheerio";

const RSS_URL = "https://www.rbi.org.in/pressreleases_rss.xml";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Title patterns that identify an NBFC status-change press release, and the
// status each maps to. Order matters - checked top to bottom, first match wins.
const ACTION_PATTERNS = [
  { action: "Restored", pattern: /restor(e|ed|ation)|reinstat/i },
  { action: "Cancelled", pattern: /cancel(s|led|lation)?/i },
  { action: "Surrendered", pattern: /surrender/i },
  { action: "Suspended", pattern: /suspend(s|ed|sion)?/i },
];

const NBFC_HINT = /\bNBFCs?\b|non-banking financial compan/i;
const COR_HINT = /certificate of registration|\bCoR\b|registration certificate/i;
// Same exclusion as pressReleaseArchive.js - confirmed via a real
// false-positive: procedural/administrative announcements (forms,
// checklists, guidelines) can match NBFC_HINT/COR_HINT/ACTION_PATTERNS
// without containing any actual entity list at all.
const PROCEDURAL_EXCLUSION = /application form|indicative checklist|guidelines|procedure for|framework for|master direction|circular on/i;

/**
 * Fetches the RSS feed and returns raw {title, descriptionHtml, link, pubDate} items.
 */
async function fetchFeedItems() {
  const { data: xml } = await axios.get(RSS_URL, {
    headers: { "User-Agent": USER_AGENT },
    timeout: 30000,
  });
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  $("item").each((_, el) => {
    items.push({
      title: $(el).find("title").text().trim(),
      descriptionHtml: $(el).find("description").text(),
      link: $(el).find("link").text().trim(),
      pubDate: new Date($(el).find("pubDate").text().trim()),
    });
  });
  return items;
}

/** Strips HTML tags/entities down to plain text for regex-based name extraction. */
function htmlToText(html) {
  const $ = cheerio.load(html);
  return $.root().text().replace(/\s+/g, " ").trim();
}

// A plausible extracted "name" chunk: starts with a capital/digit, is
// reasonably short, and doesn't span multiple sentences (a stray ". " deep
// inside almost always means the regex swallowed prose, not a company name).
function looksLikeEntityName(candidate) {
  const c = candidate.trim();
  if (c.length < 4 || c.length > 140) return false;
  if (/^[a-z]/.test(c)) return false; // real names start capitalised
  if ((c.match(/\. /g) || []).length > 1) return false; // multi-sentence blob
  return true;
}

/**
 * Extracts entity names from a genuine <table> in the release's HTML -
 * confirmed to be how RBI formats BULK cancellation notices (e.g. "cancels
 * ... of 59 NBFCs"): a real table with columns like "Sr. No. | Name of the
 * Company | Registered Office Address | ...". A numbered-prose regex
 * requiring "1." will never match this format's "1 Company Name" (no
 * period) - this was a real bug, confirmed by fetching an actual RBI
 * release page and finding zero matches despite the data being right there
 * in a table. NOTE: RSS <description> fields are sometimes truncated/
 * simplified compared to the full page, so this may not always have a
 * table to find even when the source page does - that's fine, it falls
 * through to the prose extractor below in that case.
 */
function extractFromTable(html) {
  const $ = cheerio.load(html);
  const names = [];

  // Same fix as pressReleaseArchive.js - a table's schema (which column
  // holds the name) needs to be learned once and applied to every <table>
  // on the page, since RBI's bulk lists sometimes split across multiple
  // tables where only the first repeats the header row. Treating tables
  // independently silently dropped every row in headerless continuation
  // tables - confirmed by testing, not hypothetical.
  const tables = [];
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
    if (rows.length > 0) tables.push(rows);
  });
  if (tables.length === 0) return [];

  let nameIdx = -1;
  let learnedColumnCount = null;
  let headerTableIdx = -1;
  for (let t = 0; t < tables.length; t++) {
    const rows = tables[t];
    const headerIdx = rows.findIndex((r) =>
      r.some((cell) => /name of the compan|name of company|\bname\b/i.test(cell))
    );
    if (headerIdx !== -1) {
      const headerRow = rows[headerIdx];
      const idx = headerRow.findIndex((h) => /name of the compan|name of company|\bname\b/i.test(h));
      if (idx !== -1) {
        nameIdx = idx;
        learnedColumnCount = headerRow.length;
        headerTableIdx = t;
        break;
      }
    }
  }
  if (nameIdx === -1) return [];

  // Tightened guard (same reasoning as pressReleaseArchive.js): a real run
  // showed the previous ±1 column-count tolerance was too loose and swept
  // in unrelated tables elsewhere on the page (e.g. 119 names extracted
  // from a page whose title stated 59 - almost exactly double). Now
  // requires an EXACT column-count match AND a genuine numeric serial-
  // number first column before treating a headerless table as a
  // continuation of the entity list.
  for (let t = 0; t < tables.length; t++) {
    const rows = tables[t];
    const isHeaderTable = t === headerTableIdx;
    const headerIdx = isHeaderTable
      ? rows.findIndex((r) => r.some((cell) => /name of the compan|name of company|\bname\b/i.test(cell)))
      : -1;

    if (!isHeaderTable) {
      const columnCountMatches = rows.every((r) => r.length === learnedColumnCount);
      const looksLikeSerialColumn = rows.every((r) => /^\d{1,4}$/.test((r[0] || "").trim()));
      if (!columnCountMatches || !looksLikeSerialColumn) continue;
    }

    const startRow = headerIdx !== -1 ? headerIdx + 1 : 0;
    for (let i = startRow; i < rows.length; i++) {
      const name = (rows[i][nameIdx] || "").trim();
      if (name && !/^(sl\.?\s*no\.?|s\.?\s*no\.?)$/i.test(name) && name.length <= 180) {
        names.push(name);
      }
    }
  }

  return [...new Set(names)];
}

/**
 * Best-effort extraction of entity names from a numbered/lettered list
 * embedded in press-release prose, e.g. "...of the following companies:
 * 1. ABC Finance Ltd 2. XYZ Capital Ltd ...". See file header for caveats.
 * Fallback for releases that aren't table-formatted.
 */
function extractFromProseList(plainText) {
  // Same interleaving fix as pressReleaseArchive.js and customParsers.js:
  // the pre-first-match chunk (index 0) is lead-in text, never an entity -
  // confirmed by testing that this was still slipping through here.
  const rawParts = plainText.split(/(?:^|\s)(\d{1,3})\.\s+/);

  const names = [];
  for (let i = 1; i < rawParts.length; i += 2) {
    const chunk = rawParts[i + 1];
    if (!chunk) continue;
    // Cut off at the next sentence boundary so trailing prose doesn't get
    // glued onto the name. Comma-tolerant so "XYZ LLC, Country ..." still
    // cuts right after "LLC".
    const cut = chunk.split(/\s{2,}|(?<=Limited|Ltd\.?|Pvt\.?|LLP|LLC|Inc\.?|Corp\.?|Corporation|Co\.|PLC|GmbH|N\.V\.),?\s+(?=[A-Z])/)[0];
    const candidate = (cut || chunk).trim().replace(/[,;:]$/, "");
    if (looksLikeEntityName(candidate)) names.push(candidate);
  }
  return [...new Set(names)];
}

/** Combined extractor: real table first (bulk notices), prose-list fallback
 * (smaller/differently-worded releases). */
function extractEntityNames(html) {
  const fromTable = extractFromTable(html);
  if (fromTable.length > 0) return fromTable;
  return extractFromProseList(htmlToText(html));
}

/**
 * Main entry point. Returns an array of status-change deltas:
 *   { entityName, action, effectiveDate, prTitle, prLink, needsVerification: true }
 * for every NBFC-related status-change press release published after
 * `sinceDate`.
 */
export async function fetchNbfcStatusDeltas(sinceDate) {
  const items = await fetchFeedItems();
  const deltas = [];
  const skippedOlderThanFeed =
    items.length > 0 && items[items.length - 1].pubDate > sinceDate;

  for (const item of items) {
    if (item.pubDate <= sinceDate) continue;
    if (!NBFC_HINT.test(item.title) && !COR_HINT.test(item.title)) continue;
    if (PROCEDURAL_EXCLUSION.test(item.title)) continue;

    const matched = ACTION_PATTERNS.find((p) => p.pattern.test(item.title));
    if (!matched) continue;

    const names = extractEntityNames(item.descriptionHtml);

    if (names.length === 0) {
      // Couldn't confidently pull names - still record that *something*
      // relevant happened, so a human knows to go check this press release
      // by hand rather than it silently vanishing.
      deltas.push({
        entityName: null,
        action: matched.action,
        effectiveDate: item.pubDate.toISOString().slice(0, 10),
        prTitle: item.title,
        prLink: item.link,
        needsVerification: true,
        note: "Could not auto-extract entity names from this press release - check it manually.",
      });
      continue;
    }

    for (const entityName of names) {
      deltas.push({
        entityName,
        action: matched.action,
        effectiveDate: item.pubDate.toISOString().slice(0, 10),
        prTitle: item.title,
        prLink: item.link,
        needsVerification: true,
        note: null,
      });
    }
  }

  return {
    deltas,
    // Lets the caller warn the user if the RSS feed's own history didn't
    // reach back as far as sinceDate - see file header limitation.
    feedMayNotCoverFullRange: !skippedOlderThanFeed && items.length > 0,
    oldestItemInFeed: items.length ? items[items.length - 1].pubDate : null,
  };
}
