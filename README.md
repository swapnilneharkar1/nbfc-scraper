# NBFC / HFC / Insurance / Other-FII Entity Scraper

Scrapes the regulator sources listed in the BRD's "Annex-1 Regulated entities"
sheet (RBI, NHB, IRDAI, SEBI, PFRDA — AMFI's distributor list is excluded,
see below) and consolidates them into one Excel file shaped like the BRD's
"Annex-2 Combine List" sheet:

| Name of the Active NBFCs / HFCs / Others | Category | Classification | Institution | Regulator | Source Key | Scraped At |

## Quick start (local)

```bash
git clone <this-repo>
cd nbfc-scraper
npm install
npm run scrape
```

Output lands in `output/Combine_List_Output.xlsx`, with a `output/run-log.json`
summarising what succeeded/failed per source, and raw downloaded PDFs in
`output/downloads/` for anything the parser couldn't fully digest.

## Running on a schedule via GitHub

1. Push this folder to a new GitHub repo.
2. The workflow at `.github/workflows/scrape.yml` is already wired to run
   every **Monday 03:00 UTC** and can also be triggered manually from the
   **Actions** tab (`workflow_dispatch`).
3. Each run uploads `Combine_List_Output.xlsx` + `run-log.json` as a
   **build artifact** (Actions tab → run → Artifacts), retained 90 days.
4. If you'd rather have the file live at a fixed path in the repo instead of
   a per-run artifact, uncomment the "Commit updated output" step at the
   bottom of the workflow (requires `contents: write`, already granted).
5. Change the cron schedule to match how often the regulator actually
   updates each list (most are monthly/quarterly, not daily).

## What actually works out of the box vs. what needs attention

Government/regulator sites are the least stable things to scrape — ASPX
postbacks, embedded PDF viewers, WAFs, and layout changes are the norm, not
the exception. Being upfront about where this stands:

| Source | Type | Status |
|---|---|---|
| RBI NBFC list | PDF/XLS link off an ASPX page | Best-effort link discovery + PDF text parse. **Check `output/downloads/rbi_nbfc.pdf` after first run** — line-based name extraction from PDFs is fragile and may need tuning to RBI's actual layout. |
| RBI PSS (Operating/Revoked/Ceased/Cancelled) | ASPX table | Reads rendered table via headless Chrome. Selector is generic (`table`) — narrow it once you see the real markup. |
| NHB HFC list | Linked PDF | Same PDF-parsing caveat as RBI NBFC list. |
| RBI Banks (all sub-types) | ASPX table | Reads rendered table; classification currently defaults to "Banks" for all sub-types — extend to read the section heading if you need PSB/PVT/SFB/etc. split out. |
| IRDAI Life Insurers | HTML table | Should work directly; IRDAI's site is one of the more scrape-friendly ones here. |
| SEBI recognised intermediaries | HTML table | The **same page** serves ~15 of the BRD's Annex-1 rows (Credit Rating Agency, Stock Brokers × 6 segments, Portfolio Managers, etc.) via a dropdown/tab. This script currently scrapes the default view only — you'll need to add per-category query params or Puppeteer clicks to pull each segment separately. |
| PFRDA Pension Fund | HTML table | Should work directly. |
| AMFI Mutual Fund Distributor | Search-by-city widget, no bulk list | **Not scraped** — marked `manual` in `src/sources.js`. There's no bulk listing to scrape; source this one from AMFI's ARN master file/relationship contact instead. |
| RBI Cancelled NBFC/ARC | Linked PDF | Same as above — PDF parse, verify against `output/downloads/`. |

**In short: treat the first run as a calibration run.** Open
`output/run-log.json`, fix any source marked `error` or `empty` by adjusting
its selector/link pattern in `src/sources.js`, and re-run. This is normal
maintenance for scrapers against government sites, not a one-time setup.

## Extending

- Add a new regulator source: add one object to `src/sources.js`.
- Need XLS/XLSX downloads auto-parsed (not just PDFs)? Wire the `xlsx` npm
  package into `downloadAndExtract()` in `src/scraper.js` — left as an
  extension point to keep the base dependency footprint small.
- Need the ECL-matching / nomenclature-exception logic from the BRD's
  Process Note (steps 6–8, fuzzy-matching entities against your own ECL
  table)? That's a separate matching script, not a scraper — happy to build
  it as a follow-up once this consolidated list is flowing reliably.
