/**
 * scraper.js
 * -----------
 * Entry point. Walks every source in sources.js, scrapes what it can,
 * and writes one consolidated Excel workbook matching the BRD's
 * "Annex-2 Combine List" schema:
 *   Name of the Active NBFCs / HFCs / Others | Category | Classification | Institution
 *
 * Run locally:
 *   npm install
 *   npm run scrape
 *
 * Run on a schedule: see .github/workflows/scrape.yml
 */

import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer";
import pdfParse from "pdf-parse";
import ExcelJS from "exceljs";
import { sources } from "./sources.js";
import { writeWorkbook } from "./excelWriter.js";
import { fetchNbfcStatusDeltas } from "./pressReleases.js";
import { fetchNbfcStatusDeltasFromArchive } from "./pressReleaseArchive.js";
import { mergeStatuses, extractMasterListDate } from "./statusMerge.js";
import { parseRbiBanksSection, parseRbiPssSection, parseSebiIntermediaryPage } from "./customParsers.js";
import { getRank } from "./priorityMatrix.js";

const OUTPUT_DIR = path.resolve("output");
const DOWNLOAD_DIR = path.resolve("output", "downloads");
const RUN_LOG_PATH = path.resolve("output", "run-log.json");
const MANUAL_DIR = path.resolve("manual-downloads");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
fs.mkdirSync(MANUAL_DIR, { recursive: true });

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Generic HTML <table> extractor. Assumes first row is a header row.
 * Returns array of row-objects keyed by header text, plus a raw array form.
 */
function extractTables(html, selector = "table") {
  const $ = cheerio.load(html);
  const tables = [];
  $(selector).each((_, tableEl) => {
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
    if (rows.length > 1) tables.push(rows);
  });
  return tables;
}

/** Same header-row heuristic used for xlsx sheets - see findHeaderRowIndex(). */
function findHeaderRowIndex(rows) {
  const labelPattern = /name|company|entity|institution|sl\.?\s*no/i;
  let fallback = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const nonEmptyCount = rows[i].filter(Boolean).length;
    if (nonEmptyCount < 2) continue; // likely a title/merged-cell row
    if (fallback === -1) fallback = i;
    if (rows[i].some((cell) => labelPattern.test(cell))) return i;
  }
  return fallback;
}

/** Guess which column in a scraped table is the entity/company name. */
function guessNameColumnIndex(headerRow) {
  const patterns = [/name/i, /company/i, /entity/i, /institution/i];
  for (const p of patterns) {
    const idx = headerRow.findIndex((h) => p.test(h));
    if (idx !== -1) return idx;
  }
  return 0; // fall back to first column
}

// A real entity name is a handful of words, not a page of prose. Pages
// like RBI's PSS/Banks listings aren't built from real <table> markup, so
// naive table scraping on them yields one giant blob per "row" - this cap
// throws those out instead of polluting the output with garbage.
const MAX_PLAUSIBLE_NAME_LENGTH = 180;

function rowsToNames(table) {
  const headerIdx = findHeaderRowIndex(table);
  if (headerIdx === -1) return [];
  const header = table[headerIdx];
  const nameIdx = guessNameColumnIndex(header);
  return table
    .slice(headerIdx + 1)
    .map((r) => (r[nameIdx] || "").trim())
    .filter((name) => name && !/^(sl\.?\s*no\.?|s\.?\s*no\.?)$/i.test(name))
    .filter((name) => name.length <= MAX_PLAUSIBLE_NAME_LENGTH);
}

async function scrapeHtmlTable(source) {
  const { data: html } = await axios.get(source.url, {
    headers: { "User-Agent": USER_AGENT },
    timeout: 30000,
  });
  const tables = extractTables(html, source.tableSelector || "table");
  const names = tables.flatMap(rowsToNames);
  return { names: dedupe(names), titleText: null };
}

/**
 * For ASPX pages that render content via postback/JS. We load the page in
 * a headless browser, wait for a table to appear, then read the rendered
 * DOM. If the page instead just links out to a PDF/XLS (common on RBI
 * pages), we fall back to treating it like a pdf_link source.
 */
async function scrapeAspxDynamic(source, browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  try {
    await page.goto(source.url, { waitUntil: "networkidle2", timeout: 45000 });

    // Give any postback/AJAX table a moment to render.
    await page
      .waitForSelector(source.tableSelector || "table", { timeout: 8000 })
      .catch(() => null);

    const html = await page.content();
    const tables = extractTables(html, source.tableSelector || "table");
    const names = dedupe(tables.flatMap(rowsToNames));

    if (names.length > 0) return { names, titleText: null };

    // No usable table rendered - look for a downloadable list instead.
    const linkPattern = source.linkPattern || /(list|nbfc|hfc).*\.(pdf|xlsx?|csv)$/i;
    const links = await page.$$eval("a", (as) =>
      as.map((a) => ({ href: a.href, text: a.textContent || "" }))
    );
    const match = links.find(
      (l) => linkPattern.test(l.href) || linkPattern.test(l.text)
    );
    if (match) {
      return await downloadAndExtract(match.href, source);
    }

    return { names: [], titleText: null };
  } finally {
    await page.close();
  }
}

/**
 * Handles sources with a known, direct .xlsx download URL (e.g. RBI's NBFC
 * lists). Checks for a manually-supplied local copy first (see MANUAL_DIR),
 * since RBI's download host currently CAPTCHA-gates automated requests and
 * that cannot be solved by a script. If no local copy exists, attempts the
 * live download and clearly flags a captcha_block if that's what comes back.
 */
async function scrapeXlsxDirect(source) {
  const manualPath = path.join(MANUAL_DIR, `${source.key}.xlsx`);
  const opts = { captureClassification: !!source.captureClassificationColumn };
  if (fs.existsSync(manualPath)) {
    console.log(`  using manually-supplied file: ${manualPath}`);
    return await parseXlsxBuffer(fs.readFileSync(manualPath), opts);
  }

  const res = await axios.get(source.fileUrl, {
    responseType: "arraybuffer",
    headers: { "User-Agent": USER_AGENT },
    timeout: 60000,
    validateStatus: () => true,
  });

  const contentType = res.headers["content-type"] || "";
  const looksLikeHtml =
    contentType.includes("text/html") ||
    Buffer.from(res.data.slice(0, 200)).toString("utf8").includes("<html");

  if (looksLikeHtml) {
    // Save the response for debugging and raise a clear, specific error
    // rather than trying (and failing) to parse HTML as a spreadsheet.
    const debugPath = path.join(DOWNLOAD_DIR, `${source.key}.blocked.html`);
    fs.writeFileSync(debugPath, res.data);
    throw new Error(
      `CAPTCHA_OR_BLOCK: RBI returned an HTML challenge page instead of the ` +
        `.xlsx file (saved to ${debugPath}). This host blocks automated ` +
        `downloads. Fix: download the file manually in a browser and save it ` +
        `to manual-downloads/${source.key}.xlsx in the repo, then re-run.`
    );
  }

  const rawPath = path.join(DOWNLOAD_DIR, `${source.key}.xlsx`);
  fs.writeFileSync(rawPath, res.data);
  return await parseXlsxBuffer(res.data, opts);
}

/** Reads a real .xlsx buffer and returns the entity names found in it, plus
 * the title-row text (used elsewhere to auto-detect the master list's
 * "as on <date>" stamp), plus a name->classification map when the file has
 * a recognisable "Classification" column (RBI's NBFC file does - this is
 * what BRD issue #3 needs: ICC/CIC/IFC/MFI/P2P/Factor/AA/NOFHC/IDF/etc,
 * sourced from the regulator's own data instead of a generic label). */
async function parseXlsxBuffer(buffer, { captureClassification = false } = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const names = [];
  const classifications = new Map(); // entity name -> classification string
  let titleText = null;
  wb.worksheets.forEach((ws) => {
    const allRows = [];
    ws.eachRow((row) => {
      const values = row.values.slice(1).map((v) => (v == null ? "" : String(v).trim()));
      if (values.some(Boolean)) allRows.push(values);
    });

    const headerIdx = findHeaderRowIndex(allRows);
    if (headerIdx === -1) return;

    if (!titleText && headerIdx > 0) {
      titleText = allRows[0].filter(Boolean).join(" ");
    }

    const headerRow = allRows[headerIdx];
    const nameIdx = guessNameColumnIndex(headerRow);
    const classificationIdx = captureClassification
      ? headerRow.findIndex((h) => /^classification$/i.test(h.trim()))
      : -1;

    for (let i = headerIdx + 1; i < allRows.length; i++) {
      const name = (allRows[i][nameIdx] || "").trim();
      if (
        name &&
        !/^(sl\.?\s*no\.?|s\.?\s*no\.?)$/i.test(name) &&
        name.length <= MAX_PLAUSIBLE_NAME_LENGTH
      ) {
        names.push(name);
        if (classificationIdx !== -1) {
          const classification = (allRows[i][classificationIdx] || "").trim();
          if (classification) classifications.set(name, classification);
        }
      }
    }
  });
  return { names: dedupe(names), titleText, classifications };
}


async function scrapePdfLink(source) {
  // If we already know the direct file URL (verified by hand rather than
  // discovered via link-pattern guessing), skip the landing-page search
  // entirely - it's both faster and more reliable than pattern-matching
  // link text/hrefs, which breaks the moment the actual filename doesn't
  // match the guessed pattern (confirmed happening for nhb_hfc).
  if (source.fileUrl) {
    return await downloadAndExtract(source.fileUrl, source);
  }

  const { data: html } = await axios.get(source.url, {
    headers: { "User-Agent": USER_AGENT },
    timeout: 30000,
  });
  const $ = cheerio.load(html);
  const links = $("a")
    .map((_, a) => ({ href: $(a).attr("href") || "", text: $(a).text() }))
    .get();

  const abs = (href) => {
    try {
      return new URL(href, source.url).toString();
    } catch {
      return null;
    }
  };

  const match = links
    .map((l) => ({ ...l, absHref: abs(l.href) }))
    .find((l) => {
      const pattern = source.linkPattern || /\.(pdf|xlsx?|csv)$/i;
      return l.absHref && (pattern.test(l.absHref) || pattern.test(l.text));
    });

  if (!match) {
    console.warn(`  no matching PDF/XLS link found on ${source.url}`);
    return { names: [], titleText: null };
  }

  return await downloadAndExtract(match.absHref, source);
}

async function downloadAndExtract(fileUrl, source) {
  const res = await axios.get(fileUrl, {
    responseType: "arraybuffer",
    headers: { "User-Agent": USER_AGENT },
    timeout: 60000,
  });
  const filename = path.join(DOWNLOAD_DIR, `${source.key}${path.extname(fileUrl) || ".pdf"}`);
  fs.writeFileSync(filename, res.data);

  if (/\.pdf$/i.test(fileUrl)) {
    const parsed = await pdfParse(res.data);
    return { names: dedupe(namesFromPdfText(parsed.text)), titleText: null };
  }

  // .xlsx/.xls/.csv - leave the raw file in output/downloads for manual
  // review; full binary spreadsheet parsing is out of scope here to keep
  // this script's dependency footprint small. Extend with `xlsx` npm
  // package if you need it parsed automatically too.
  console.warn(
    `  downloaded ${filename} but did not auto-parse it (non-PDF). ` +
      `Review it manually or extend downloadAndExtract().`
  );
  return { names: [], titleText: null };
}

/**
 * Very rough line-based name extractor for PDFs that list one entity per
 * line (RBI's NBFC/ARC PDFs look like this). Filters out header/footer
 * noise. This WILL need tuning per actual PDF layout - inspect
 * output/downloads/*.pdf when a source disappoints you.
 */
function namesFromPdfText(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 3)
    .filter((l) => !/^page \d+/i.test(l))
    .filter((l) => !/^(sl\.?\s*no\.?|s\.?\s*no\.?|name of the)/i.test(l))
    .filter((l) => !/^\d+$/.test(l));
}

function dedupe(names) {
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))];
}

async function run() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  // Raw per-source hits, before priority-matrix resolution. Each entity can
  // legitimately appear more than once here (BRD issue #6 - multi-category
  // entities like ICICI Securities) - that's intentional and resolved below.
  const rawHits = []; // { name, categoryAsPerReturn, categoryAsPerRegulator, regulator, sourceKey, status }
  const runLog = [];
  const masterListEntries = []; // { name, status: 'Active' | 'Cancelled' }
  let masterListTitleText = null;
  let statusReconciliation = null;

  try {
    for (const source of sources) {
      console.log(`Scraping [${source.key}] ${source.url}`);
      const started = Date.now();
      let names = [];
      let titleText = null;
      let classifications = new Map(); // per-entity override of categoryAsPerRegulator (BRD #3)
      let status = "ok";
      let error = null;

      try {
        if (source.type === "html_table") {
          ({ names, titleText } = await scrapeHtmlTable(source));
        } else if (source.type === "aspx_dynamic") {
          ({ names, titleText } = await scrapeAspxDynamic(source, browser));
        } else if (source.type === "xlsx_direct") {
          ({ names, titleText, classifications } = await scrapeXlsxDirect(source));
        } else if (source.type === "pdf_link") {
          ({ names, titleText } = await scrapePdfLink(source));
        } else if (source.type === "rbi_banks_custom") {
          ({ names } = await scrapeRbiBanksCustom(source, browser));
        } else if (source.type === "rbi_pss_custom") {
          ({ names } = await scrapeRbiPssCustom(source, browser));
        } else if (source.type === "sebi_intermediary_custom") {
          ({ names } = await scrapeSebiIntermediaryCustom(source, browser));
        } else if (source.type === "manual") {
          status = "skipped_manual";
        } else {
          status = "unknown_type";
        }
      } catch (err) {
        status = "error";
        error = err.message;
        console.error(`  failed: ${err.message}`);
      }

      if (names.length === 0 && status === "ok") status = "empty";

      for (const name of names) {
        // BRD issue #1: category must come from the regulator-specific
        // column at the entity level. Per-entity classification (RBI's own
        // Classification column, when we have it - BRD #3) overrides the
        // source-level default; otherwise the source's Annex-1 category
        // applies to every entity from it.
        const categoryAsPerRegulator = classifications.get(name) || source.categoryAsPerRegulator;
        rawHits.push({
          name,
          categoryAsPerReturn: source.categoryAsPerReturn,
          categoryAsPerRegulator,
          regulator: source.regulator,
          sourceKey: source.key,
          status: source.statusOverride || "Active",
        });
      }

      if (source.key === "rbi_nbfc" && status === "ok") {
        masterListEntries.push(...names.map((name) => ({ name, status: "Active" })));
        masterListTitleText = masterListTitleText || titleText;
      }
      if (source.key === "rbi_nbfc_cancelled" && status === "ok") {
        masterListEntries.push(...names.map((name) => ({ name, status: "Cancelled" })));
        masterListTitleText = masterListTitleText || titleText;
      }

      runLog.push({
        key: source.key,
        url: source.url,
        status,
        count: names.length,
        ms: Date.now() - started,
        error,
        notes: source.notes || null,
      });

      console.log(`  -> ${status}, ${names.length} names`);
    }

    // --- Master list + press release reconciliation (BRD requirement) ---
    // Runs here, still inside the browser's lifetime, since the archive
    // crawler needs Puppeteer to click through RBI's month/year filters.
    if (masterListEntries.length > 0) {
      statusReconciliation = await reconcileWithPressReleases(masterListEntries, masterListTitleText, browser);
    } else {
      console.warn(
        "\nSkipped press-release reconciliation: rbi_nbfc/rbi_nbfc_cancelled " +
          "didn't produce a usable master list this run (check run-log.json)."
      );
    }
  } finally {
    await browser.close();
  }

  // --- Priority Matrix resolution (BRD issues #5 and #6) ---
  // An entity scraped under multiple categories keeps ALL of its category
  // memberships for audit, but gets exactly one final reporting
  // classification: whichever category ranks highest (lowest rank number)
  // in the BRD's Priority data sheet.
  const { resolved, multiCategoryEntities } = resolveWithPriorityMatrix(rawHits);

  const outFile = path.join(OUTPUT_DIR, "Combine_List_Output.xlsx");
  await writeWorkbook(resolved, outFile, statusReconciliation, multiCategoryEntities);
  fs.writeFileSync(RUN_LOG_PATH, JSON.stringify(runLog, null, 2));

  console.log(`\nWrote ${resolved.length} resolved entities -> ${outFile}`);
  console.log(`${multiCategoryEntities.length} entities had multiple category memberships (see 'Multi-Category Entities' sheet)`);
  console.log(`Run log -> ${RUN_LOG_PATH}`);

  const failed = runLog.filter((r) => r.status === "error" || r.status === "empty");
  if (failed.length > 0) {
    console.warn(
      `\n${failed.length} source(s) need attention: ${failed
        .map((f) => f.key)
        .join(", ")}. Check run-log.json and output/downloads/.`
    );
  }
}

/**
 * Groups raw per-source hits by normalized entity name. Entities appearing
 * under one category pass through unchanged. Entities appearing under
 * multiple categories (BRD #6) get a single final category chosen by
 * Priority Matrix rank (BRD #5), while every category they actually belong
 * to is preserved in memberships for audit/traceability.
 */
function resolveWithPriorityMatrix(rawHits) {
  const byName = new Map();

  for (const hit of rawHits) {
    const key = hit.name.toUpperCase().replace(/[.,()]/g, "").replace(/\s+/g, " ").trim();
    if (!byName.has(key)) byName.set(key, { name: hit.name, memberships: [] });
    byName.get(key).memberships.push(hit);
  }

  const resolved = [];
  const multiCategoryEntities = [];

  for (const { name, memberships } of byName.values()) {
    const ranked = memberships
      .map((m) => ({ ...m, rank: getRank(m.categoryAsPerRegulator) }))
      .sort((a, b) => a.rank - b.rank);
    const winner = ranked[0];

    resolved.push({
      name,
      category: winner.categoryAsPerRegulator,
      categoryAsPerReturn: winner.categoryAsPerReturn,
      classification: winner.categoryAsPerRegulator,
      institution: winner.categoryAsPerReturn,
      regulator: winner.regulator,
      sourceKey: winner.sourceKey,
      status: winner.status,
      allCategories: memberships.map((m) => m.categoryAsPerRegulator).join(" | "),
      categoryCount: new Set(memberships.map((m) => m.categoryAsPerRegulator)).size,
    });

    const distinctCategories = new Set(memberships.map((m) => m.categoryAsPerRegulator));
    if (distinctCategories.size > 1) {
      multiCategoryEntities.push({
        name,
        finalCategory: winner.categoryAsPerRegulator,
        finalCategoryRank: winner.rank,
        allMemberships: ranked.map((m) => ({
          category: m.categoryAsPerRegulator,
          rank: m.rank,
          regulator: m.regulator,
          sourceKey: m.sourceKey,
        })),
      });
    }
  }

  return { resolved, multiCategoryEntities };
}

/** BRD issues #2 and #4: RBI's Banks page needs entity-wise extraction with
 * correct bank sub-classification - see customParsers.js for why this can't
 * be a generic table scrape. */
async function scrapeRbiBanksCustom(source, browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  try {
    await page.goto(source.url, { waitUntil: "networkidle2", timeout: 45000 });
    const html = await page.content();
    const { names, note } = parseRbiBanksSection(html, source.bankSection);
    if (note) console.warn(`  ${note}`);
    return { names };
  } finally {
    await page.close();
  }
}

/** BRD issues #2 and #4: RBI's PSS page needs entity-wise extraction per
 * status category - see customParsers.js. */
async function scrapeRbiPssCustom(source, browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  try {
    await page.goto(source.url, { waitUntil: "networkidle2", timeout: 45000 });
    const html = await page.content();
    const { names, note } = parseRbiPssSection(html, source.pssSection);
    if (note) console.warn(`  ${note}`);
    return { names };
  } finally {
    await page.close();
  }
}

/** BRD-relevant fix: SEBI's "Recognised Intermediaries" pages have no real
 * <table> markup - see customParsers.js's parseSebiIntermediaryPage for why
 * that made every SEBI source silently return zero rows. Confirmed these
 * pages are plain server-rendered HTML (a simple fetch sees full content),
 * so - unlike the RBI Banks/PSS pages - this doesn't need Puppeteer at all,
 * just a different parser than the generic table extractor. */
/** Confirmed by direct inspection: SEBI's category pages paginate at 25
 * records per page for larger categories (e.g. "1 to 25 of 57 records"),
 * which a plain HTTP fetch only ever sees page 1 of - this was the actual
 * cause of "not all considered" across most SEBI categories, not a
 * rendering issue. There is a "Show All Records" link
 * (onclick="javascript: searchAllIntm();") that bypasses pagination
 * entirely - Puppeteer clicks it before reading the page. Categories small
 * enough to never paginate (like Credit Rating Agency) simply won't have
 * this link, which is handled gracefully (click attempt just no-ops). */
async function scrapeSebiIntermediaryCustom(source, browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  try {
    await page.goto(source.url, { waitUntil: "networkidle2", timeout: 45000 });

    const clicked = await page.evaluate(() => {
      const link = Array.from(document.querySelectorAll("a")).find(
        (a) => /show all records/i.test(a.textContent) || /searchAllIntm/.test(a.getAttribute("onclick") || "")
      );
      if (link) {
        link.click();
        return true;
      }
      return false;
    });

    if (clicked) {
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => {});
    }

    const html = await page.content();
    const { names, note } = parseSebiIntermediaryPage(html);
    if (note) console.warn(`  ${note}`);
    if (!clicked) console.log(`  (no 'Show All Records' link found - category likely small enough to fit one page)`);
    return { names };
  } finally {
    await page.close();
  }
}

/**
 * Runs the BRD's master-list + press-release delta logic. Requires a master
 * list date - tries to auto-detect it from the spreadsheet's own title text
 * ("... as on June 30, 2026"), falls back to the MASTER_LIST_DATE_OVERRIDE
 * env var, and skips reconciliation entirely (rather than guessing) if
 * neither is available.
 */
async function reconcileWithPressReleases(masterListEntries, titleText, browser) {
  const autoDetected = extractMasterListDate(titleText);
  const override = process.env.MASTER_LIST_DATE_OVERRIDE
    ? new Date(process.env.MASTER_LIST_DATE_OVERRIDE)
    : null;
  const masterListDate = override || autoDetected;

  if (!masterListDate || isNaN(masterListDate)) {
    console.warn(
      "\nCould not determine the RBI master list's 'as on' date (auto-detection " +
        `found: ${JSON.stringify(titleText)}). Skipping press-release reconciliation. ` +
        "Fix: set the MASTER_LIST_DATE_OVERRIDE env var (e.g. '2026-06-30') in the " +
        "workflow or your shell, matching the date shown on RBI's list."
    );
    return null;
  }

  console.log(`\nMaster list date: ${masterListDate.toISOString().slice(0, 10)}`);
  console.log("Scanning RBI's press-release archive since that date for status changes...");

  // Archive crawl is the primary, durable source (goes back as far as
  // needed via month-by-month navigation). RSS is kept as a fast
  // supplementary check afterward, purely in case something was published
  // in the last few hours and the archive page hasn't indexed it yet -
  // deduplicated against the archive results before merging.
  let archiveDeltas = [];
  try {
    const archiveResult = await fetchNbfcStatusDeltasFromArchive(masterListDate, browser);
    archiveDeltas = archiveResult.deltas;
    console.log(`  archive: scanned ${archiveResult.monthsScanned} month(s), found ${archiveDeltas.length} candidate mention(s)`);
    for (const note of archiveResult.monthNotes) console.warn(`  archive note: ${note}`);
  } catch (err) {
    console.error(`  archive scan failed: ${err.message}`);
  }

  let rssDeltas = [];
  try {
    const rssResult = await fetchNbfcStatusDeltas(masterListDate);
    rssDeltas = rssResult.deltas;
    console.log(`  RSS supplementary check: found ${rssDeltas.length} candidate mention(s)`);
  } catch (err) {
    console.error(`  RSS supplementary check failed: ${err.message}`);
  }

  const seen = new Set(archiveDeltas.map((d) => `${d.prLink}|${d.entityName}`));
  const dedupedRss = rssDeltas.filter((d) => !seen.has(`${d.prLink}|${d.entityName}`));
  const deltas = [...archiveDeltas, ...dedupedRss];
  console.log(`  ${deltas.length} total candidate status-change mention(s) after combining archive + RSS`);

  const { merged, unmatchedDeltas } = mergeStatuses(masterListEntries, deltas);
  const changedCount = merged.filter((m) => m.statusHistory.length > 0).length;
  console.log(`  ${changedCount} entities had a status change applied`);

  return {
    masterListDate: masterListDate.toISOString().slice(0, 10),
    merged,
    unmatchedDeltas,
    unattributedDeltas: deltas.filter((d) => !d.entityName),
  };
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
