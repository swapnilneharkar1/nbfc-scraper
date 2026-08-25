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
import { sources } from "./sources.js";
import { writeWorkbook } from "./excelWriter.js";

const OUTPUT_DIR = path.resolve("output");
const DOWNLOAD_DIR = path.resolve("output", "downloads");
const RUN_LOG_PATH = path.resolve("output", "run-log.json");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

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

/** Guess which column in a scraped table is the entity/company name. */
function guessNameColumnIndex(headerRow) {
  const patterns = [/name/i, /company/i, /entity/i, /institution/i];
  for (const p of patterns) {
    const idx = headerRow.findIndex((h) => p.test(h));
    if (idx !== -1) return idx;
  }
  return 0; // fall back to first column
}

function rowsToNames(table) {
  const [header, ...body] = table;
  const nameIdx = guessNameColumnIndex(header);
  return body
    .map((r) => (r[nameIdx] || "").trim())
    .filter((name) => name && !/^(sl\.?\s*no\.?|s\.?\s*no\.?)$/i.test(name));
}

async function scrapeHtmlTable(source) {
  const { data: html } = await axios.get(source.url, {
    headers: { "User-Agent": USER_AGENT },
    timeout: 30000,
  });
  const tables = extractTables(html, source.tableSelector || "table");
  const names = tables.flatMap(rowsToNames);
  return dedupe(names);
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

    if (names.length > 0) return names;

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

    return [];
  } finally {
    await page.close();
  }
}

async function scrapePdfLink(source) {
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
    .find(
      (l) =>
        l.absHref &&
        (source.linkPattern.test(l.absHref) || source.linkPattern.test(l.text))
    );

  if (!match) {
    console.warn(`  no matching PDF/XLS link found on ${source.url}`);
    return [];
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
    return dedupe(namesFromPdfText(parsed.text));
  }

  // .xlsx/.xls/.csv - leave the raw file in output/downloads for manual
  // review; full binary spreadsheet parsing is out of scope here to keep
  // this script's dependency footprint small. Extend with `xlsx` npm
  // package if you need it parsed automatically too.
  console.warn(
    `  downloaded ${filename} but did not auto-parse it (non-PDF). ` +
      `Review it manually or extend downloadAndExtract().`
  );
  return [];
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

  const results = [];
  const runLog = [];

  try {
    for (const source of sources) {
      console.log(`Scraping [${source.key}] ${source.url}`);
      const started = Date.now();
      let names = [];
      let status = "ok";
      let error = null;

      try {
        if (source.type === "html_table") {
          names = await scrapeHtmlTable(source);
        } else if (source.type === "aspx_dynamic") {
          names = await scrapeAspxDynamic(source, browser);
        } else if (source.type === "pdf_link") {
          names = await scrapePdfLink(source);
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
        results.push({
          name,
          category: source.reportCategory,
          classification: source.classification,
          institution: source.reportCategory,
          regulator: source.regulator,
          sourceKey: source.key,
        });
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
  } finally {
    await browser.close();
  }

  const outFile = path.join(OUTPUT_DIR, "Combine_List_Output.xlsx");
  await writeWorkbook(results, outFile);
  fs.writeFileSync(RUN_LOG_PATH, JSON.stringify(runLog, null, 2));

  console.log(`\nWrote ${results.length} rows -> ${outFile}`);
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

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
