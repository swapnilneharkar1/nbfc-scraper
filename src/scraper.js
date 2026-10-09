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
import * as XLSX from "xlsx";
import { sources } from "./sources.js";
import { writeWorkbook } from "./excelWriter.js";
import { fetchNbfcStatusDeltas } from "./pressReleases.js";
import { fetchNbfcStatusDeltasFromArchive } from "./pressReleaseArchive.js";
import { mergeStatuses, extractMasterListDate, canonicalKey } from "./statusMerge.js";
import { parseRbiBanksSection, parseRbiPssSection, parseRbiStateCoop, parseSebiIntermediaryPage, parseSebiHubCounts } from "./customParsers.js";
import { resolveSebiIntmId } from "./sebiUtils.js";
import { getRank } from "./priorityMatrix.js";
import { namesFromListLines, guessNameColumnIndex, findHeaderRowIndex, rowsToNames, namesFromTables, MAX_PLAUSIBLE_NAME_LENGTH } from "./nameUtils.js";

const OUTPUT_DIR = path.resolve("output");
const DOWNLOAD_DIR = path.resolve("output", "downloads");
const RUN_LOG_PATH = path.resolve("output", "run-log.json");
const MANUAL_DIR = path.resolve("manual-downloads");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
fs.mkdirSync(MANUAL_DIR, { recursive: true });

const DIAGNOSTICS_DIR = path.resolve("output", "diagnostics");

/** Best-effort: saves a page's raw HTML / rendered text so a source that
 * returns the wrong thing can be inspected after the run (the GitHub
 * Actions workflow uploads this folder). Never throws. */
function saveDiagnostic(fileName, content) {
  try {
    fs.mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
    fs.writeFileSync(path.join(DIAGNOSTICS_DIR, fileName), content);
  } catch {
    /* diagnostics are optional */
  }
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Generic HTML <table> extractor. Assumes first row is a header row.
 * Returns array of row-objects keyed by header text, plus a raw array form.
 */
function extractTables(html, selector = "table") {
  const $ = cheerio.load(html);
  // A <br> inside a cell separates two pieces of text; without this the
  // cell's text is glued together ("...LimitedAditya Birla...").
  $("br").replaceWith(" ");
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


async function scrapeHtmlTable(source) {
  const { data: html } = await axios.get(source.url, {
    headers: { "User-Agent": USER_AGENT },
    timeout: 30000,
  });
  saveDiagnostic(`${source.key}.html`, typeof html === "string" ? html : String(html));
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
    saveDiagnostic(`${source.key}.html`, html);
    try {
      saveDiagnostic(`${source.key}.txt`, await page.evaluate(() => (document.body ? document.body.innerText : "")));
    } catch {
      /* optional */
    }
    const tables = extractTables(html, source.tableSelector || "table");

    const names = namesFromTables(tables, source, (msg) => console.log(msg));

    if (names.length > 0) return { names, titleText: null };

    if (source.listFallback) {
      const lines = await page.evaluate(() => (document.body ? document.body.innerText : "").split(/\n+/));
      const { names: listNames, tier } = namesFromListLines(lines, source.listFallback);
      console.log(`  no usable table - read ${listNames.length} name(s) from page lines (${tier === 1 ? "under the list heading" : "page-wide match"})`);
      if (listNames.length > 0) return { names: listNames, titleText: null };
    }

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
      const values = row.values.slice(1).map((v) => cellText(v));
      if (values.some(Boolean)) allRows.push(values);
    });

    const headerIdx = findHeaderRowIndex(allRows);
    if (headerIdx === -1) return;

    if (!titleText && headerIdx > 0) {
      titleText = allRows[0].filter(Boolean).join(" ");
    }

    // ARCs (Asset Reconstruction Companies) are NOT one of the values
    // RBI's own "Classification" column uses (that column only carries
    // NBFC sub-types: ICC/CIC/MFI/P2P/etc). RBI's own document format
    // confirms ARCs are reported as an entirely separate section/count
    // ("Furthermore, there were 27 ARCs registered...") rather than a
    // classification value - so a sheet/section actually dedicated to ARCs
    // needs to be detected by its own name/title, not by a column that
    // simply doesn't carry this information for these entities.
    const sheetIsArcSection = /\bARC\b|Asset Reconstruction/i.test(ws.name || "") ||
      /\bARC\b|Asset Reconstruction/i.test(allRows[0]?.filter(Boolean).join(" ") || "");

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
        if (sheetIsArcSection) {
          classifications.set(name, "ARC");
        } else if (classificationIdx !== -1) {
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

/** Plain text of an ExcelJS cell value (rich text, hyperlink, formula result) - never "[object Object]". */
function cellText(v) {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text || "").join("").trim();
    if (v.text != null) return cellText(v.text);
    if (v.result != null) return cellText(v.result);
    if (v.hyperlink) return String(v.hyperlink).trim();
    return "";
  }
  return String(v).trim();
}

/** Strips leading punctuation / slash filler (". . . . . / NAME" -> "NAME"). */
function cleanLeadingJunk(name) {
  return String(name ?? "").replace(/^[\s.,;:/\\|_*•·–—-]+(?=[A-Za-z0-9("'])/, "").trim();
}

/** Header/label text that is never an entity name, whatever source it leaks in from. */
const NOT_AN_ENTITY_NAME =
  /^(?:name\s+of\s+(?:the\s+)?(?:company|companies|insurer|entity|entities|nbfc|nbfcs|bank)s?|nbfc\s+name|classification|sr\.?\s*no\.?|s\.?\s*no\.?|sl\.?\s*no\.?|list\s+of\s+.*\b(?:added|removed|deleted)\b.*|\[object Object\])$/i;

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

  // Fetch SEBI's real per-category record counts once up front, used as
  // the target the pagination walker below aims for - see
  // scrapeSebiIntermediaryCustom for why this matters (previous runs
  // silently capped at ~25 records per category with no way to tell).
  let sebiHubCounts = new Map();
  try {
    const { data: hubHtml } = await axios.get(
      "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognised=yes",
      { headers: { "User-Agent": USER_AGENT }, timeout: 30000 }
    );
    sebiHubCounts = parseSebiHubCounts(hubHtml);
    console.log(`Fetched SEBI hub counts for ${sebiHubCounts.size} categories`);
  } catch (err) {
    console.warn(`Could not fetch SEBI hub counts (${err.message}) - SEBI sources will run without a target count.`);
  }

  try {
    // Open one persistent "hub" tab, configured to capture real file
    // downloads to disk via CDP, reused across every SEBI source's
    // Download-button attempt - see tryDownloadFromHub / scrapeSebiIntermediaryCustom.
    let sebiHubPage = null;
    try {
      sebiHubPage = await browser.newPage();
      await sebiHubPage.setUserAgent(USER_AGENT);
      const client = await sebiHubPage.target().createCDPSession();
      fs.mkdirSync(SEBI_DOWNLOAD_DIR, { recursive: true });
      await client.send("Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: SEBI_DOWNLOAD_DIR,
      });
      await sebiHubPage.goto("https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognised=yes", {
        waitUntil: "networkidle2",
        timeout: 45000,
      });
    } catch (err) {
      console.warn(`Could not set up SEBI hub download page (${err.message}) - Download-button attempts will be skipped, pagination fallback only.`);
      sebiHubPage = null;
    }

    for (const source of sources) {
      console.log(`Scraping [${source.key}] ${source.url}`);
      const started = Date.now();
      let names = [];
      let titleText = null;
      let classifications = new Map(); // per-entity override of categoryAsPerRegulator (BRD #3)
      let status = "ok";
      let error = null;
      let scrapeNote = null;
      let expectedForLog = null;

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
          ({ names, note: scrapeNote } = await scrapeRbiBanksCustom(source, browser));
        } else if (source.type === "rbi_state_coop_custom") {
          ({ names, note: scrapeNote } = await scrapeRbiStateCoopCustom(source, browser));
        } else if (source.type === "rbi_pss_custom") {
          ({ names, note: scrapeNote } = await scrapeRbiPssCustom(source, browser));
        } else if (source.type === "sebi_intermediary_custom") {
          {
            const sebiPage = await browser.newPage();
            await sebiPage.setUserAgent(USER_AGENT);
            try {
              const resolved = resolveSebiIntmId(source, sebiHubCounts);
              if (resolved.warning) console.warn(`  ${resolved.warning}`);
              const effectiveSource = resolved.intmId && resolved.changedFrom
                ? { ...source, url: source.url.replace(/intmId=\d+/, `intmId=${resolved.intmId}`) }
                : source;
              const result = await scrapeSebiIntermediaryCustom(effectiveSource, sebiPage, resolved.expectedCount, sebiHubPage);
              names = result.names;
              expectedForLog = resolved.expectedCount ?? null;
              scrapeNote = [
                `hub label: ${resolved.hubLabel || "n/a"}`,
                `intmId used: ${resolved.intmId || "n/a"}${resolved.changedFrom ? ` (configured ${resolved.changedFrom})` : ""}`,
                `expected: ${resolved.expectedCount ?? "unknown"}`,
                `got: ${names.length}`,
                result.via ? `via: ${result.via}` : null,
                result.downloadStats
                  ? `download file rows: ${result.downloadStats.dataRows}, distinct names: ${result.downloadStats.uniqueNames}, blank: ${result.downloadStats.blankName}`
                  : null,
                resolved.warning,
              ].filter(Boolean).join("; ");
            } finally {
              await sebiPage.close();
            }
          }
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

      {
        // Leading filler such as ". . . . . / NAME" or ". , / NAME" (seen in the IRDAI
        // agent list) is not part of the name.
        const cleaned = [...new Set(names.map((n) => cleanLeadingJunk(n)).filter(Boolean))];
        if (cleaned.length !== names.length || cleaned.some((n, i) => n !== names[i])) {
          const changed = names.filter((n) => cleanLeadingJunk(n) !== n).length;
          if (changed) console.log(`  removed leading punctuation from ${changed} name(s)`);
        }
        names = cleaned;
      }
      {
        const kept = names.filter((n) => !NOT_AN_ENTITY_NAME.test(String(n).trim()));
        if (kept.length !== names.length) {
          console.log(`  dropped ${names.length - kept.length} header/label row(s) that are not entity names`);
          names = kept;
        }
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
        expectedCount: expectedForLog,
        category: source.categoryAsPerRegulator,
        regulator: source.regulator,
        ms: Date.now() - started,
        error,
        notes: source.notes || null,
        scrapeNote,
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
  await writeWorkbook(resolved, outFile, statusReconciliation, multiCategoryEntities, { rawHits, runLog });
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

// RBI's Banks page and PSS page are each read by many sources (8 bank
// categories, 5 PSS statuses). Load each URL once per run and keep both the
// HTML and the browser's rendered text (which preserves line/cell breaks
// that flattening the HTML loses - needed to separate a name from the
// address or status text that follows it).
const rbiPageCache = new Map(); // url -> { html, innerText }

async function loadRbiPage(url, browser, diagnosticName) {
  if (rbiPageCache.has(url)) return rbiPageCache.get(url);
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    const html = await page.content();
    const innerText = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
    saveDiagnostic(`${diagnosticName}.html`, html);
    saveDiagnostic(`${diagnosticName}.txt`, innerText);
    const loaded = { html, innerText };
    rbiPageCache.set(url, loaded);
    return loaded;
  } finally {
    await page.close();
  }
}

/** BRD issues #2 and #4: RBI's Banks page needs entity-wise extraction with
 * correct bank sub-classification - see customParsers.js for why this can't
 * be a generic table scrape. */
async function scrapeRbiBanksCustom(source, browser) {
  const { html, innerText } = await loadRbiPage(source.url, browser, "rbi-banks-page");
  const { names, note } = parseRbiBanksSection(html, source.bankSection, innerText);
  if (note) console.warn(`  ${note}`);
  return { names, note };
}

/** State Co-operative Banks: one numbered block on the Banks page, split
 * into scheduled / non-scheduled - see parseRbiStateCoop(). */
async function scrapeRbiStateCoopCustom(source, browser) {
  const { html, innerText } = await loadRbiPage(source.url, browser, "rbi-banks-page");
  const { names, note } = parseRbiStateCoop(html, innerText, {
    scope: source.coopScope,
    nonScheduledKeywords: source.nonScheduledKeywords || [],
  });
  if (note) console.log(`  ${note}`);
  return { names, note };
}

/** BRD issues #2 and #4: RBI's PSS page needs entity-wise extraction per
 * status category - see customParsers.js. */
async function scrapeRbiPssCustom(source, browser) {
  const { html, innerText } = await loadRbiPage(source.url, browser, "rbi-pss-page");
  const { names, note } = parseRbiPssSection(html, source.pssSection, innerText);
  if (note) console.warn(`  ${note}`);
  return { names, note };
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
/** Confirmed by direct inspection: SEBI's category pages paginate at 25
 * records per page for larger categories (e.g. "1 to 25 of 57 records"),
 * with a "Show All Records" link (onclick="javascript: searchAllIntm();")
 * meant to bypass it. A previous version clicked this link, but multiple
 * live runs still showed several categories capped at exactly 25 - a
 * strong sign the click isn't actually taking effect (page.evaluate's
 * .click() doesn't always trigger the same event chain a real user click
 * does, especially for javascript:-href links parsed oddly by some SEBI
 * pages, and a full page reload needs waitForNavigation, not just
 * waitForNetworkIdle, or the old DOM gets read before the new one loads).
 * This version: (a) tries multiple ways of triggering the same action,
 * (b) races waitForNavigation against waitForNetworkIdle since it's
 * unknown which mechanism SEBI actually uses, (c) crucially, compares the
 * extracted count BEFORE and AFTER the click attempt and logs a clear
 * diagnostic either way, so the next run's logs settle definitively
 * whether this is working - no more guessing from row counts alone. */
/**
 * Walks SEBI's real pagination page-by-page, accumulating names, rather
 * than betting on a single "Show All Records" click - a related SEBI-site
 * scraping attempt found that direct export endpoints couldn't be verified
 * reliably outside a real browser session either, so this follows the
 * same safer, proven path of paging through the actual HTML.
 *
 * Stops when: the accumulated count reaches expectedCount (from the hub
 * page - the authoritative target), OR no "next page" control can be
 * found, OR a page produces no new names (protects against an infinite
 * loop if a "next" link exists but doesn't actually advance), OR a safety
 * cap of iterations is hit.
 *
 * HONESTY NOTE: the exact next-page click target (numbered link vs "Next"
 * text vs something else) is unverified from my sandbox - this tries
 * several common patterns generically. Expect this to need tuning against
 * the real live page, same as every other custom parser in this project.
 */
const SEBI_DOWNLOAD_DIR = path.resolve("output", "sebi-downloads");

/**
 * Attempts to get a category's full record list via SEBI's own "Download"
 * button on the hub page (doRecognised=yes), using Chrome's native download
 * handling (via CDP Page.setDownloadBehavior) to capture whatever file it
 * produces - CSV, Excel, or PDF. This exists because the Download link's
 * real behaviour is wired through a JS event listener that isn't visible to
 * any static HTML fetch (confirmed by checking both markdown and raw HTML
 * extraction - the href is always the placeholder "javascript: void(0);"
 * either way), so the only way to find out what it actually produces is to
 * let a real browser click it and see what file appears.
 *
 * Returns null (not an empty array) if no file appeared in time, so the
 * caller can distinguish "genuinely got zero records" from "this approach
 * didn't work for this category, fall back to pagination."
 */
async function tryDownloadFromHub(hubPage, intmId, expectedCount = null) {
  fs.mkdirSync(SEBI_DOWNLOAD_DIR, { recursive: true });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Let any download still in flight from the previous category finish
  // first, so a late file can never be mistaken for this category's.
  const settleStart = Date.now();
  while (Date.now() - settleStart < 30000 && fs.readdirSync(SEBI_DOWNLOAD_DIR).some((f) => f.endsWith(".crdownload"))) {
    await sleep(500);
  }
  const before = new Set(fs.readdirSync(SEBI_DOWNLOAD_DIR));

  const clicked = await hubPage.evaluate((id) => {
    // EXACT intmId match. The previous a[href*="intmId=2"] selector also
    // matched intmId=21/23/25/27 and used whichever came first on the page,
    // so categories with a single-digit id (2, 5, 6, 7, 9) could download a
    // different category's file.
    const exact = new RegExp(`[?&]intmId=${id}(?:&|$)`);
    const rowLink = Array.from(document.querySelectorAll("a[href*='intmId=']")).find((a) =>
      exact.test(a.getAttribute("href") || "")
    );
    if (!rowLink) return false;
    const row = rowLink.closest("tr");
    if (!row) return false;
    const downloadLink = Array.from(row.querySelectorAll("a")).find((a) =>
      /download/i.test(a.textContent) || /download/i.test(a.getAttribute("title") || "")
    );
    if (!downloadLink) return false;
    downloadLink.click();
    return true;
  }, String(intmId));

  if (!clicked) return null;

  // Poll for a new file to land in the download directory. Big categories
  // (thousands of records) take longer to generate.
  const timeoutMs = expectedCount && expectedCount > 1000 ? 90000 : 30000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(500);
    const fresh = fs
      .readdirSync(SEBI_DOWNLOAD_DIR)
      .filter((f) => !before.has(f) && !f.endsWith(".crdownload"))
      .map((f) => ({ f, t: fs.statSync(path.join(SEBI_DOWNLOAD_DIR, f)).mtimeMs }))
      .sort((x, y) => y.t - x.t);
    if (fresh.length > 0) {
      // Give Chrome a moment to finish flushing the file to disk.
      await sleep(800);
      return path.join(SEBI_DOWNLOAD_DIR, fresh[0].f);
    }
  }
  return null;
}

/** Parses whatever file tryDownloadFromHub captured, based on its extension. */
// Row-level facts about the last parsed SEBI download (rows in the file vs
// distinct names), so a gap against SEBI's own count can be explained.
let lastDownloadStats = null;

async function parseSebiDownloadedFile(filePath) {
  lastDownloadStats = null;
  const buffer = fs.readFileSync(filePath);
  const head = buffer.slice(0, 1024).toString("utf8", 0, Math.min(1024, buffer.length));
  const headBytes = buffer.slice(0, 8);

  // Content-sniff rather than trust the file extension - confirmed
  // necessary: a real run's "Excel export" file failed to parse as a real
  // zip-based .xlsx ("Can't find end of central directory"), which is the
  // classic signature of a legacy government-site pattern: the "export"
  // button just serves an HTML table with a misleading .xls/.xlsx
  // extension (Excel opens these fine via permissive format-sniffing, but
  // they are not real spreadsheet files at all).
  const isZipXlsx = headBytes[0] === 0x50 && headBytes[1] === 0x4b; // "PK" zip signature
  const isOldBinaryXls =
    headBytes[0] === 0xd0 && headBytes[1] === 0xcf && headBytes[2] === 0x11 && headBytes[3] === 0xe0;
  const looksLikeHtml = /<html|<table|<!doctype html/i.test(head);

  if (looksLikeHtml) {
    console.log(`  downloaded file is HTML-disguised-as-Excel (common legacy pattern) - parsing as a table.`);
    const $ = cheerio.load(buffer.toString("utf8"));
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
      const nameIdx = rows[headerIdx].findIndex((h) => /^name$/i.test(h) || /^name\b/i.test(h));
      if (nameIdx === -1) return;
      for (let i = headerIdx + 1; i < rows.length; i++) {
        const name = (rows[i][nameIdx] || "").trim();
        if (name && !/^(sl\.?\s*no\.?|s\.?\s*no\.?)$/i.test(name) && name.length <= 150) names.push(name);
      }
    });
    return [...new Set(names)];
  }

  if (isZipXlsx) {
    const { names } = await parseXlsxBuffer(buffer, { captureClassification: false });
    return names;
  }

  if (isOldBinaryXls) {
    // Confirmed by a real run: SEBI's "Excel export" produces genuine old
    // BIFF8 .xls files (magic bytes d0cf11e0), which ExcelJS (this
    // project's main xlsx parser, used for RBI's files) can't read - it
    // only supports the newer zip-based OOXML .xlsx format. SheetJS
    // handles both, so it's used here specifically for this case.
    console.log(`  downloaded file is old binary .xls - parsing with SheetJS.`);
    const wb = XLSX.read(buffer, { type: "buffer" });
    const names = [];
    const stats = { dataRows: 0, blankName: 0, serialLabel: 0, tooLong: 0, uniqueNames: 0 };
    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" });
      const nonEmptyRows = rows.map((r) => r.map((c) => String(c ?? "").trim())).filter((r) => r.some(Boolean));
      const headerIdx = findHeaderRowIndex(nonEmptyRows);
      if (headerIdx === -1) continue;
      const nameIdx = guessNameColumnIndex(nonEmptyRows[headerIdx]);
      for (let i = headerIdx + 1; i < nonEmptyRows.length; i++) {
        stats.dataRows++;
        const name = (nonEmptyRows[i][nameIdx] || "").trim();
        if (!name) { stats.blankName++; continue; }
        if (/^(sl\.?\s*no\.?|s\.?\s*no\.?)$/i.test(name)) { stats.serialLabel++; continue; }
        if (name.length > 180) { stats.tooLong++; continue; }
        names.push(name);
      }
    }
    const unique = dedupe(names);
    stats.uniqueNames = unique.length;
    lastDownloadStats = stats;
    console.log(`  download file: ${stats.dataRows} data row(s), ${unique.length} distinct name(s), ${stats.blankName} blank, ${stats.tooLong} over-long, ${names.length - unique.length} repeated name(s)`);
    return unique;
  }

  // CSV as a last resort, since it has no reliable magic-byte signature -
  // only try it if the content looks like delimited text, not binary noise.
  const looksLikeCsv = /^[\x09\x0A\x0D\x20-\x7E,"]+$/.test(head.slice(0, 200));
  if (looksLikeCsv) {
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];
    const header = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
    const nameIdx = header.findIndex((h) => /^name$/i.test(h) || /name/i.test(h));
    if (nameIdx === -1) return [];
    return dedupe(
      lines.slice(1).map((line) => (line.split(",")[nameIdx] || "").replace(/"/g, "").trim()).filter(Boolean)
    );
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf" || head.startsWith("%PDF")) {
    const parsed = await pdfParse(buffer);
    return dedupe(namesFromPdfText(parsed.text));
  }

  console.warn(`  downloaded file's content didn't match any known format (checked zip/xlsx, old .xls, HTML, CSV, PDF) - not auto-parsed, check ${filePath} manually.`);
  return [];
}

async function scrapeSebiIntermediaryCustom(source, page, expectedCount, hubPage) {
  // Try the download route first - if SEBI's Download button produces a
  // genuine full-list file, this is far more reliable than paginating.
  // If the file is short of SEBI's own hub count, its names seed the
  // pagination walk below and the union is returned.
  let downloadNames = [];
  let downloadStats = null;
  let via = "pagination";
  if (hubPage) {
    const intmIdMatch = source.url.match(/intmId=(\d+)/);
    if (intmIdMatch) {
      try {
        const downloadedFile = await tryDownloadFromHub(hubPage, intmIdMatch[1], expectedCount);
        if (downloadedFile) {
          downloadNames = await parseSebiDownloadedFile(downloadedFile);
          downloadStats = lastDownloadStats;
          if (downloadNames.length > 0) {
            console.log(`  got ${downloadNames.length} names via Download button (${path.basename(downloadedFile)})`);
            // Requirement: when SEBI's attachment (Download file) is available it is
            // the source of truth - nothing is mixed in from the paginated pages.
            // (Set SEBI_TOPUP_WITH_PAGINATION=1 to restore the old top-up.)
            if (!expectedCount || downloadNames.length >= expectedCount || process.env.SEBI_TOPUP_WITH_PAGINATION !== "1") {
              if (expectedCount && downloadNames.length < expectedCount) {
                console.warn(`  NOTE: SEBI's downloaded file has ${downloadNames.length} distinct name(s) but its hub page says ${expectedCount}; using the file only, as required.`);
              }
              return { names: downloadNames, via: "download", downloadStats };
            }
            console.warn(`  downloaded file has ${downloadNames.length}, expected ${expectedCount} - topping up via pagination.`);
          } else {
            console.warn(`  downloaded file produced 0 names (${downloadedFile}) - falling back to pagination.`);
          }
        } else {
          console.log(`  no file appeared from Download button within timeout - falling back to pagination.`);
        }
      } catch (err) {
        console.warn(`  Download-button attempt failed (${err.message}) - falling back to pagination.`);
      }
    }
  }

  await page.goto(source.url, { waitUntil: "networkidle2", timeout: 45000 });

  let html = await page.content();
  let { names, note } = parseSebiIntermediaryPage(html);
  if (note) console.warn(`  ${note}`);
  // Union keyed on a canonical form so "XYZ Pvt Ltd" from the file and
  // "XYZ Private Limited" from the page are one entity, not two.
  const byKey = new Map();
  const addName = (n) => {
    const k = canonicalKey(n);
    if (k && !byKey.has(k)) byKey.set(k, n);
    return k;
  };
  downloadNames.forEach(addName);
  // Names seen on the paginated pages themselves. The "no progress" stop
  // below looks at THIS set, not the union - pages the Download file
  // already covered add nothing to the union but are still real pages.
  const pagedSeen = new Set();
  for (const n of names) { pagedSeen.add(canonicalKey(n)); addName(n); }
  const allNames = { get size() { return byKey.size; } };

  const target = expectedCount || null;
  if (target) console.log(`  target from hub page: ${target} records`);

  // A page's "signature" (first / last name + row count) is how we know a
  // click has really loaded different content. A fixed wait after the click
  // was the cause of pagination "repeating" a page and stopping early.
  const signatureOf = (htmlText) => {
    const r = parseSebiIntermediaryPage(htmlText).names;
    return r.length ? `${r[0]}|${r[r.length - 1]}|${r.length}` : "";
  };
  const clickNext = (currentPageNum) =>
    page.evaluate((cur) => {
      const nextPageLabel = String(cur + 1);
      const links = Array.from(document.querySelectorAll("a"));
      const txt = (a) => a.textContent.trim();
      // Order matters: the exact next page number, then a plain "Next" /
      // ">" control, and only last a jump-style "»" / ">>" (which can mean
      // "last page" on some pagers).
      const numbered = links.find((a) => txt(a) === nextPageLabel);
      const plainNext = links.find((a) => /^(next|>|›)$/i.test(txt(a)));
      const jumpNext = links.find((a) => /^(»|>>)$/.test(txt(a)));
      const el = numbered || plainNext || jumpNext;
      if (el) { el.click(); return true; }
      return false;
    }, currentPageNum);
  const waitForNewPage = async (prevSig, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const h = await page.content();
      const sg = signatureOf(h);
      if (sg && sg !== prevSig) return h;
    }
    return null;
  };

  const MAX_PAGES = 260; // covers the largest known category (~5000 / 25 = 200 pages) with headroom
  let pageNum = 1;
  let prevSig = signatureOf(html);
  const sigsSeen = new Set([prevSig]);
  let noNewStreak = 0;
  let stopReason = null;

  while (!target || allNames.size < target) {
    if (pageNum >= MAX_PAGES) { stopReason = `hit safety cap of ${MAX_PAGES} pages`; break; }

    if (!(await clickNext(pageNum))) { stopReason = `no page-${pageNum + 1} / Next control found`; break; }
    let newHtml = await waitForNewPage(prevSig, 15000);
    if (!newHtml) {
      // One retry: the click may have been swallowed while the page re-rendered.
      await clickNext(pageNum);
      newHtml = await waitForNewPage(prevSig, 10000);
    }
    if (!newHtml) { stopReason = `page ${pageNum + 1} never loaded different content`; break; }

    html = newHtml;
    const sg = signatureOf(html);
    if (sigsSeen.has(sg)) { stopReason = `page ${pageNum + 1} is identical to an earlier page (pager looped)`; break; }
    sigsSeen.add(sg);
    prevSig = sg;

    const result = parseSebiIntermediaryPage(html);
    const newOnThisPage = result.names.filter((n) => { const k = canonicalKey(n); return k && !pagedSeen.has(k); }).length;
    for (const n of result.names) { pagedSeen.add(canonicalKey(n)); addName(n); }

    // Pages made only of names seen before (a broker listed several times)
    // are tolerated; three in a row means the walk has run out of data.
    noNewStreak = newOnThisPage === 0 ? noNewStreak + 1 : 0;
    if (noNewStreak >= 3) { stopReason = `3 consecutive pages without a new name (page ${pageNum + 1})`; break; }

    pageNum++;
  }
  if (stopReason) console.log(`  pagination stopped: ${stopReason}; walked ${pageNum} page(s)`);

  const finalNames = [...byKey.values()];
  if (target && finalNames.length < target) {
    console.warn(
      `  WARNING: only got ${finalNames.length} of ${target} expected records for ${source.key} - incomplete, needs investigation.`
    );
  } else if (target) {
    console.log(`  reached full expected count: ${finalNames.length}/${target}`);
  }

  return { names: finalNames, via: downloadNames.length ? "download+pagination" : "pagination", downloadStats };
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
  console.log(`  master list sample names: ${JSON.stringify(masterListEntries.slice(0, 3).map((e) => e.name))}`);
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

  const { merged, unmatchedDeltas, releaseSummary } = mergeStatuses(masterListEntries, deltas);
  const changedCount = merged.filter((m) => m.statusHistory.length > 0).length;
  console.log(`  ${changedCount} entities had a status change applied`);
  for (const r of releaseSummary) {
    const matched = r.exact + r.normalised + r.alias + r.approximate;
    console.log(
      `    "${r.prTitle}": expected ${r.expectedCount ?? "n/a"}, extracted ${r.extracted}, matched ${matched} ` +
        `(exact ${r.exact}, normalised ${r.normalised}, alias ${r.alias}, approximate ${r.approximate}), not in master list ${r.notInMaster}`
    );
  }
  if (changedCount === 0 && unmatchedDeltas.length > 0) {
    console.log(`  DIAGNOSTIC: 0 matches despite ${unmatchedDeltas.length} unmatched deltas - sample unmatched entity names: ${JSON.stringify(unmatchedDeltas.slice(0, 5).map((d) => d.entityName))}`);
  }

  return {
    masterListDate: masterListDate.toISOString().slice(0, 10),
    merged,
    unmatchedDeltas,
    releaseSummary,
    unattributedDeltas: deltas.filter((d) => !d.entityName),
  };
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
