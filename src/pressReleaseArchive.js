/**
 * pressReleaseArchive.js
 * ------------------------
 * Replaces the RSS-only approach in pressReleases.js with something more
 * durable: RBI's own press-release ARCHIVE page
 * (https://rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx), which is
 * filterable by year/month and goes back decades - unlike the RSS feed,
 * which only carries RBI's most recent ~10-50 items across ALL press
 * releases (auctions, money-market ops, appointments, everything), and so
 * loses NBFC-specific items within days given RBI's daily publishing
 * volume. Confirmed empirically: an Aug 11, 2026 "cancelled 59 NBFCs"
 * release had almost certainly already rolled out of the RSS feed by the
 * time a scraper run in early September checked it.
 *
 * MECHANISM: The archive page's year/month links are client-side postbacks
 * (`javascript:void(0)` in the raw markup - no direct URL per month), so
 * this requires a real browser click, not a URL pattern. For each
 * year/month between the master list date and today, Puppeteer clicks the
 * corresponding month link and reads whatever press-release list renders.
 *
 * HONESTY NOTE (same spirit as every other RBI-page parser in this
 * project): I could not execute this against the live site from my
 * sandbox (JS-driven interactions aren't testable via search/fetch tools).
 * The selectors below are a considered best effort based on the page's
 * confirmed static structure, not a verified-live implementation. Treat
 * the first real run as a calibration run - check the console output/notes
 * this module returns, and expect to adjust selectors if RBI's actual
 * click targets differ from what's assumed here.
 */

import axios from "axios";
import * as cheerio from "cheerio";

const ARCHIVE_URL = "https://rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Same classification patterns as pressReleases.js (RSS-based) - kept in
// sync deliberately since both approaches need to agree on what counts as
// an NBFC status-change release.
const ACTION_PATTERNS = [
  { action: "Restored", pattern: /restor(e|ed|ation)|reinstat/i },
  { action: "Cancelled", pattern: /cancel(s|led|lation)?/i },
  { action: "Surrendered", pattern: /surrender/i },
  { action: "Suspended", pattern: /suspend(s|ed|sion)?/i },
];
const NBFC_HINT = /\bNBFCs?\b|non-banking financial compan/i;
const COR_HINT = /certificate of registration|\bCoR\b|registration certificate/i;

// Confirmed by checking a real false-positive: "Voluntary Surrender of
// Certificate of Registration by NBFCs (including HFCs) for Cancellation -
// Application Form and Indicative Checklist" matched NBFC_HINT, COR_HINT,
// and the "Surrendered" action pattern, but is NOT a list of specific
// entities at all - it's a procedural announcement about a form/checklist
// being made available. Zero names is CORRECT for this release, but it
// should never have been classified as a status-change release in the
// first place. Titles matching this exclusion pattern are skipped outright
// rather than producing a false "could not auto-extract" row.
const PROCEDURAL_EXCLUSION = /application form|indicative checklist|guidelines|procedure for|framework for|master direction|circular on/i;

/** Every (year, month) pair from sinceDate through today, inclusive. */
function monthsBetween(sinceDate, today) {
  const months = [];
  let y = sinceDate.getFullYear();
  let m = sinceDate.getMonth(); // 0-indexed
  const endY = today.getFullYear();
  const endM = today.getMonth();
  while (y < endY || (y === endY && m <= endM)) {
    months.push({ year: y, month: MONTH_NAMES[m] });
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return months;
}

/**
 * Clicks through the archive for one (year, month) and returns whatever
 * press-release entries render: [{title, dateText, link}].
 * Defensive by design - a failure on one month should not sink the whole
 * backfill, so this returns an empty array (with a note) rather than
 * throwing, and the caller decides whether to log/continue.
 */
async function fetchMonthListing(page, year, month) {
  try {
    // Find the year heading, then the month link within its section, and
    // click it. Both are rendered as plain <a> text in the confirmed
    // static markup - matching by visible text is more robust against
    // markup changes than guessing at __doPostBack argument strings.
    const clicked = await page.evaluate(
      (year, month) => {
        const allLinks = Array.from(document.querySelectorAll("a"));
        const yearLink = allLinks.find((a) => a.textContent.trim() === String(year));
        if (!yearLink) return { ok: false, reason: `year link '${year}' not found` };

        // The month links for a given year sit in the DOM section
        // immediately following that year's heading, before the next
        // year heading - walk forward from the year link to find them.
        let node = yearLink.closest("h2, li, div") || yearLink;
        let monthLink = null;
        let cursor = node.nextElementSibling;
        let guard = 0;
        while (cursor && guard < 30) {
          const found = Array.from(cursor.querySelectorAll("a")).find(
            (a) => a.textContent.trim() === month
          );
          if (found) {
            monthLink = found;
            break;
          }
          // Stop if we've wandered into the next year's section.
          if (/^\d{4}$/.test(cursor.textContent.trim().slice(0, 4))) break;
          cursor = cursor.nextElementSibling;
          guard++;
        }
        if (!monthLink) return { ok: false, reason: `month link '${month} ${year}' not found near its year heading` };
        monthLink.click();
        return { ok: true };
      },
      year,
      month
    );

    if (!clicked.ok) {
      return { entries: [], note: `Archive navigation failed for ${month} ${year}: ${clicked.reason}` };
    }

    await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {});
    const html = await page.content();
    return { entries: parseListingHtml(html), note: null };
  } catch (err) {
    return { entries: [], note: `Archive navigation threw for ${month} ${year}: ${err.message}` };
  }
}

/**
 * Parses a month's rendered press-release listing into structured entries.
 * Based on the confirmed single-release page structure (bold Date line,
 * bold Title line, bullet summary) - a month listing is assumed to repeat
 * that same block per release. Falls back gracefully (empty array) if the
 * page doesn't match this shape, rather than guessing at partial data.
 */
function parseListingHtml(html) {
  const $ = cheerio.load(html);
  const entries = [];

  // Press release links on RBI's site consistently point at
  // BS_PressReleaseDisplay.aspx?prid=NNNNN - use that as the anchor for
  // finding each entry regardless of the surrounding table/list markup.
  $("a[href*='prid=']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const title = $(el).text().replace(/\s+/g, " ").trim();
    if (!title || title.length < 8) return;

    // Look for a nearby date - RBI's listing rows typically show
    // "Date : <Month DD, YYYY>" close to the title/link.
    const context = $(el).closest("tr, li, div").text().replace(/\s+/g, " ");
    const dateMatch = context.match(/Date\s*:\s*([A-Za-z]+ \d{1,2},? \d{4})/);

    entries.push({
      title,
      link: href.startsWith("http") ? href : new URL(href, ARCHIVE_URL).toString(),
      dateText: dateMatch ? dateMatch[1] : null,
    });
  });

  return entries;
}

function htmlToText(html) {
  const $ = cheerio.load(html);
  return $.root().text().replace(/\s+/g, " ").trim();
}

function looksLikeEntityName(candidate) {
  const c = candidate.trim();
  if (c.length < 4 || c.length > 140) return false;
  if (/^[a-z]/.test(c)) return false;
  if ((c.match(/\. /g) || []).length > 1) return false;
  return true;
}

/**
 * Extracts entity names from a genuine <table> on the press-release page -
 * confirmed to be how RBI formats BULK cancellation notices (e.g. "cancels
 * ... of 59 NBFCs"): a real table with columns like "Sr. No. | Name of the
 * Company | Registered Office Address | CoR No. | CoR Issued on |
 * Cancellation Order Date". Reuses the same header-detection approach as
 * the rest of this project (skip title rows, find the row with a
 * name/company-ish header, take that column).
 */
function extractFromTable(html) {
  const $ = cheerio.load(html);
  const names = [];

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
  console.log(`    (found ${tables.length} <table> element(s) on the page)`);

  // Learn the schema (which column index holds the name) from whichever
  // table has a recognisable header.
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

  // VALIDATE, don't just trust, the learned column index. Confirmed by a
  // real run: this positional approach can land on the serial-number
  // column instead of the name column. A first attempt at self-correction
  // (requiring EVERY sampled row to look numeric before correcting) still
  // failed on a real run - too strict, defeated by a single noisy row in
  // a small 5-row sample. Rewritten to use a majority vote across ALL data
  // rows in the table, which is far more robust to occasional formatting
  // noise (blank cells, stray punctuation, merged rows).
  {
    const dataRows = tables[headerTableIdx].slice(
      tables[headerTableIdx].findIndex((r) =>
        r.some((cell) => /name of the compan|name of company|\bname\b/i.test(cell))
      ) + 1
    );
    const columnCount = Math.max(...dataRows.map((r) => r.length), 0);

    const scoreColumn = (c) => {
      let numericCount = 0;
      let textCount = 0;
      let total = 0;
      for (const r of dataRows) {
        const v = (r[c] || "").trim();
        if (!v) continue;
        total++;
        if (/^\d{1,4}$/.test(v)) numericCount++;
        else if (v.length >= 4 && /[A-Za-z]{3,}/.test(v) && !/^[A-Za-z]+\s+\d{1,2},?\s+\d{4}$/.test(v)) textCount++;
      }
      return { total, numericFraction: total ? numericCount / total : 0, textFraction: total ? textCount / total : 0 };
    };

    const chosenScore = scoreColumn(nameIdx);
    console.log(`    column ${nameIdx} (learned from header): ${Math.round(chosenScore.numericFraction * 100)}% numeric, ${Math.round(chosenScore.textFraction * 100)}% text-like, over ${chosenScore.total} rows`);

    if (chosenScore.numericFraction >= 0.7) {
      console.warn(`    learned name column (index ${nameIdx}) is mostly numeric - searching for the real name column by content instead.`);
      let bestCol = -1;
      let bestTextFraction = 0;
      for (let c = 0; c < columnCount; c++) {
        const s = scoreColumn(c);
        console.log(`    column ${c}: ${Math.round(s.numericFraction * 100)}% numeric, ${Math.round(s.textFraction * 100)}% text-like`);
        if (s.textFraction > bestTextFraction && s.textFraction >= 0.7) {
          bestTextFraction = s.textFraction;
          bestCol = c;
        }
      }
      if (bestCol !== -1) {
        console.log(`    corrected name column to index ${bestCol}.`);
        nameIdx = bestCol;
      } else {
        console.warn(`    could not find any column that looks like real names by content - abandoning table extraction for this page.`);
        return [];
      }
    }
  }

  // Real entity table rows start with a running serial number (RBI's
  // format: "Sr. No. | Name of the Company | ..."). A headerless table is
  // only treated as a genuine continuation of the SAME list if (a) its
  // column count matches EXACTLY (tightened from a previous ±1 tolerance
  // that proved too loose - confirmed by a real run massively
  // over-extracting, e.g. 119 names from a page stating 59, almost exactly
  // double - strongly suggesting an unrelated table on the same page, like
  // a "related links" or print-layout box, was being swept in), AND (b)
  // its first cell is actually numeric on every row, which unrelated page
  // furniture (nav/sidebar/metadata tables) essentially never is.
  for (let t = 0; t < tables.length; t++) {
    const rows = tables[t];
    const isHeaderTable = t === headerTableIdx;
    const headerIdx = isHeaderTable
      ? rows.findIndex((r) => r.some((cell) => /name of the compan|name of company|\bname\b/i.test(cell)))
      : -1;

    if (!isHeaderTable) {
      const columnCountMatches = rows.every((r) => r.length === learnedColumnCount);
      const looksLikeSerialColumn = rows.every((r) => /^\d{1,4}$/.test((r[0] || "").trim()));
      if (!columnCountMatches || !looksLikeSerialColumn) {
        console.log(`    (skipping headerless table ${t + 1}/${tables.length} - doesn't look like a continuation of the entity list)`);
        continue;
      }
      console.log(`    (treating headerless table ${t + 1}/${tables.length} as a continuation - column count and serial-number column both match)`);
    }

    const startRow = headerIdx !== -1 ? headerIdx + 1 : 0;
    for (let i = startRow; i < rows.length; i++) {
      const name = (rows[i][nameIdx] || "").trim();
      // Defensive filter against header text leaking through as data -
      // confirmed by a real run extracting "Sr. No." itself as if it were
      // an entity name, alongside the wrong-column bug fixed above. This
      // catches it regardless of why the header row wasn't cleanly
      // excluded by the startRow calculation.
      const isHeaderLikeText = /^(sl\.?\s*no\.?|s\.?\s*no\.?|sr\.?\s*no\.?|name(\s+of\s+the\s+compan(y|ies))?)$/i.test(name);
      if (name && !isHeaderLikeText && name.length <= 180) {
        names.push(name);
      }
    }
  }

  return [...new Set(names)];
}

/**
 * Extracts entity names from a numbered list embedded in free-form prose
 * (e.g. small notices: "...of the following companies: 1. ABC Finance Ltd
 * 2. XYZ Capital Ltd ..."). This is the fallback for releases that don't
 * use a real table - confirmed both formats exist across different RBI
 * press releases, not just one or the other.
 */
function extractFromProseList(plainText) {
  // Same interleaving fix applied elsewhere in this project: split() with a
  // capturing group puts the pre-first-match text at index 0, which is
  // never an entity (it's the lead-in sentence, e.g. "The following
  // entities:") - this was still being included here even though the
  // equivalent bug was already fixed in customParsers.js. Confirmed by
  // testing: "The following entities" was passing through as a fake name.
  const rawParts = plainText.split(/(?:^|\s)(\d{1,3})\.\s+/);
  const names = [];
  for (let i = 1; i < rawParts.length; i += 2) {
    const chunk = rawParts[i + 1];
    if (!chunk) continue;
    // Comma-tolerant: "UAE Exchange Centre LLC, UAE Dubai ..." needs the
    // cut to land after "LLC" even with a comma before the address starts.
    const cut = chunk.split(/\s{2,}|(?<=Limited|Ltd\.?|Pvt\.?|LLP|LLC|Inc\.?|Corp\.?|Corporation|Co\.|PLC|GmbH|N\.V\.),?\s+(?=[A-Z])/)[0];
    const candidate = (cut || chunk).trim().replace(/[,;:]$/, "");
    if (looksLikeEntityName(candidate)) names.push(candidate);
  }
  return [...new Set(names)];
}

/**
 * Combined extractor: tries the real-table format first (confirmed to be
 * how RBI's bulk cancellation notices are built), falls back to the
 * prose-list format for smaller/differently-worded releases.
 */
function extractEntityNames(html) {
  const fromTable = extractFromTable(html);
  if (fromTable.length > 0) return fromTable;
  return extractFromProseList(htmlToText(html));
}

/**
 * Main entry point - the archive-based replacement for
 * pressReleases.js's fetchNbfcStatusDeltas(). Same return shape, so
 * scraper.js can swap between them (or use both) without other changes.
 *
 * @param {Date} sinceDate - master list date; only releases after this are considered
 * @param {import('puppeteer').Browser} browser
 */
export async function fetchNbfcStatusDeltasFromArchive(sinceDate, browser) {
  const today = new Date();
  const months = monthsBetween(sinceDate, today);
  const deltas = [];
  const monthNotes = [];

  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);

  try {
    await page.goto(ARCHIVE_URL, { waitUntil: "networkidle2", timeout: 45000 });

    for (const { year, month } of months) {
      const { entries, note } = await fetchMonthListing(page, year, month);
      if (note) monthNotes.push(note);

      for (const entry of entries) {
        const entryDate = entry.dateText ? new Date(entry.dateText) : null;
        if (entryDate && entryDate < sinceDate) continue; // outside our window

        if (!NBFC_HINT.test(entry.title) && !COR_HINT.test(entry.title)) continue;
        if (PROCEDURAL_EXCLUSION.test(entry.title)) continue; // procedural announcement, not an entity-status-change list
        const matched = ACTION_PATTERNS.find((p) => p.pattern.test(entry.title));
        if (!matched) continue;

        // Fetch the individual release for its entity list - reuses the
        // same axios path as the RSS-based approach, no Puppeteer needed
        // for this part since individual release pages are plain HTML.
        let names = [];
        try {
          const { data: releaseHtml } = await axios.get(entry.link, {
            headers: { "User-Agent": USER_AGENT },
            timeout: 20000,
          });
          names = extractEntityNames(releaseHtml);
          // Diagnostic: this pipeline found 425 candidate mentions in a
          // real run but 0 matched the master list, despite roughly
          // correct row COUNTS - meaning either the extracted "names" are
          // actually wrong content (e.g. reading the wrong column), or a
          // real formatting mismatch is breaking every single match.
          // Logging a sample here (not the whole list, to keep output
          // readable) settles which one it is from the next run's log,
          // rather than guessing again.
          if (names.length > 0) {
            console.log(`    sample extracted names for "${entry.title}": ${JSON.stringify(names.slice(0, 3))}`);
          }
        } catch (err) {
          monthNotes.push(`Failed to fetch release detail at ${entry.link}: ${err.message}`);
        }

        const effectiveDate = entryDate
          ? entryDate.toISOString().slice(0, 10)
          : `${year}-${String(MONTH_NAMES.indexOf(month) + 1).padStart(2, "0")}-01`;

        // RBI's own bulk-notice titles state the expected count (e.g. "...
        // of 59 NBFCs"), which gives a free, cheap sanity check on whether
        // extraction actually got everything. A mismatch here doesn't
        // pinpoint the exact cause, but it stops an under-extraction from
        // silently passing as if it were complete - flagged directly on
        // every row from this release so it's visible in the output sheet,
        // not just a console log that scrolls by during the Actions run.
        const titleCountMatch = entry.title.match(
          /\b(\d+)\s+NBFCs?\b|of\s+(\d+)\s+NBFCs?\b/i
        );
        const expectedCount = titleCountMatch
          ? parseInt(titleCountMatch[1] || titleCountMatch[2], 10)
          : null;
        const countMismatch =
          expectedCount !== null && names.length > 0 && names.length !== expectedCount;
        const countNote = countMismatch
          ? `Title states ${expectedCount} entities but only ${names.length} were extracted - likely incomplete, verify against the source press release.`
          : null;
        if (countMismatch) monthNotes.push(`Count mismatch on "${entry.title}": expected ${expectedCount}, got ${names.length}`);

        if (names.length === 0) {
          deltas.push({
            entityName: null,
            action: matched.action,
            effectiveDate,
            prTitle: entry.title,
            prLink: entry.link,
            needsVerification: true,
            note: "Could not auto-extract entity names from this press release - check it manually.",
          });
        } else {
          for (const entityName of names) {
            deltas.push({
              entityName,
              action: matched.action,
              effectiveDate,
              prTitle: entry.title,
              prLink: entry.link,
              needsVerification: true,
              note: countNote,
            });
          }
        }
      }
    }
  } finally {
    await page.close();
  }

  return { deltas, monthsScanned: months.length, monthNotes };
}
