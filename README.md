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

## Master-list + press-release reconciliation (BRD requirement)

RBI's NBFC master list is only published periodically (e.g. "as on June 30,
2026"), so any cancellations/surrenders/suspensions/restorations announced
*after* that date won't show up in it until RBI's next refresh. The scraper
now handles this automatically:

1. After scraping `rbi_nbfc` (Active) and `rbi_nbfc_cancelled`, it reads the
   "as on `<date>`" text from the spreadsheet itself to find the master
   list's date. If that can't be found, set the `MASTER_LIST_DATE_OVERRIDE`
   env var (format `YYYY-MM-DD`) in the workflow or your shell.
2. It scans RBI's press-release RSS feed
   (`https://www.rbi.org.in/pressreleases_rss.xml`) for anything published
   after that date whose title mentions NBFC Certificate-of-Registration
   cancellation, surrender, suspension, or restoration.
3. It extracts the affected entity names from each matching press release
   and applies them on top of the master list — most recent effective date
   wins per entity (so Cancelled → Restored ends as Active).
4. Results land in three new sheets in `Combine_List_Output.xlsx`:
   - **Final Status (Reconciled)** — every master-list entity with its
     original status, final status, and whether it changed (changed rows
     are highlighted).
   - **Press Release Changes Log** — every delta applied, with a link back
     to the source press release.
   - **Unmatched PR Mentions** — entities mentioned in a press release but
     not found in the master list at all (could be a name-matching
     mismatch, or a genuinely new entity — needs a human look either way).

### Two limitations worth knowing about before trusting this for compliance

**RSS feed recency.** RBI's RSS feed only carries their most recent press
releases (observed: roughly the last 10–50 items), not a full historical
archive. That's fine once this scraper is running on its weekly schedule —
each run picks up whatever's new since the last one. But if the scraper sits
idle for a while and then runs, older changes from that gap may have already
rolled off the feed. The scraper logs a warning (`feedMayNotCoverFullRange`)
when this looks like it might be happening. Fix for a known gap: check RBI's
press release archive by hand
(https://rbi.org.in/scripts/BS_PressReleaseDisplay.aspx) for that period once.

**Name extraction from press releases is a best-effort heuristic, not a
guarantee.** RBI's press releases are free-form prose and the exact wording
varies release to release. The extractor looks for numbered-list patterns
in the text, which works for many releases but not all — some press
releases don't extract cleanly and show up as a row in the "Changes Log"
sheet with "could not auto-extract" instead of a name, flagging that one for
manual review. **Every row produced by this feature is worth spot-checking
against its linked source press release before being used in a compliance
report** — that's why every row carries a direct link and a verification
flag, not just a name.


- Add a new regulator source: add one object to `src/sources.js`.
- Need XLS/XLSX downloads auto-parsed (not just PDFs)? Wire the `xlsx` npm
  package into `downloadAndExtract()` in `src/scraper.js` — left as an
  extension point to keep the base dependency footprint small.
- Need the ECL-matching / nomenclature-exception logic from the BRD's
  Process Note (steps 6–8, fuzzy-matching entities against your own ECL
  table)? That's a separate matching script, not a scraper — happy to build
  it as a follow-up once this consolidated list is flowing reliably.

## Coverage against the 12-point issues list (this rebuild)

| # | Requirement | Status |
|---|---|---|
| 1 | Category from "As per Regulators" column, at entity level | **Done.** `sources.js` carries `categoryAsPerRegulator` per source (transcribed from your Annex-1 sheet), applied per-entity in `scraper.js`. |
| 2 | Every source captured entity-wise, not as a block | **Done for all sources now scraped.** RBI Banks and RBI PSS previously returned nothing (correctly - they aren't real tables) or garbage; `customParsers.js` now extracts them entity-wise. Sources still marked `manual` in `sources.js` (a few bank/insurance sub-categories, AMFI) remain unscraped rather than faked - see their `notes` field for why. |
| 3 | Granular NBFC classification (ICC/CIC/IFC/MFI/P2P/...) | **Done.** RBI's NBFC file has its own `Classification` column - `scraper.js` now reads it per-entity instead of defaulting to "NBFC". |
| 4 | Bank classification per BRD hierarchy | **Done for 7 of the ~11 bank sub-types** with a genuine per-category summary list on RBI's page (Public, Private, Foreign, SFB, PB, RRB, LAB placeholder). State/District/Urban Co-operative Banks are prose/address-book style on RBI's page, not a clean list - flagged `manual` rather than force-extracted into garbage. |
| 5 | Priority Matrix resolves multi-classification entities | **Done.** `priorityMatrix.js` transcribes your "Priority data" sheet exactly (rank 1-10) and `resolveWithPriorityMatrix()` in `scraper.js` picks the single highest-priority category per entity. |
| 6 | Multi-category entities (ICICI Securities etc.) preserved | **Done.** SEBI is now scraped per-category (via SEBI's own `intmId` URL scheme, confirmed directly from their site) instead of one blob, so an entity registered under several SEBI categories correctly appears in each. A dedicated **Multi-Category Entities** sheet lists every entity's full category membership and which one won by priority rank. |
| 10 | Specialised categories not folded into generic NBFC | **Done.** HFC, ARC, and each SEBI/PSS sub-type are separate `categoryAsPerRegulator` values, not generic buckets. Account Aggregator, CIC, MFI, P2P, Factor now come through as their own RBI Classification values (point 3) rather than being grouped as generic NBFC. |
| 11 | Press-release logic after master list date | **Done** (built in the previous round) - see the section above. |
| 12 | Most recent effective date / Restoration overrides prior status | **Done** (built in the previous round, verified against your exact example table). |

### What's honestly still open
- **Points 7-9** weren't in the document you pasted (looks like they were skipped in the copy) - if they exist, send them and I'll fold them in.
- A few Annex-1 rows are marked `manual` in `sources.js` with a `notes` field explaining exactly why (State/Co-op banks, IRDAI Non-Life/Reinsurers/CA-Insurer since their real URLs differ from what Annex-1 lists, AMFI, RBI "Financial Institutions in India"). These are flagged, not silently dropped or faked.
- The RBI Banks/PSS custom parsers are tested against realistic synthetic HTML matching the page's confirmed real structure, but haven't been run against the live page end-to-end (my sandbox can't reach rbi.org.in directly) - treat your first live run as a calibration run, same as the rest of this project.


## Observation-fix round (PSS, LAB, SFB, foreign banks, State Co-op, IRDAI, PFRDA, SEBI, press releases)

Existing behaviour was kept; changes are additive.

- **PSS**: names are cut at the legal form, so authorisation/ceased text no longer leaks into names (Ceased now 11). Operating no longer capped by a 20,000-char window.
- **LAB / SFB**: LABs come from the page; "Slice Small Finance Bank Limited" is captured.
- **Foreign banks**: address text trimmed from names; over-count removed. Heuristic - check `output/diagnostics/` if a name still carries an address.
- **State Co-op / Non-Scheduled State Co-op**: both are read from the single RBI list and split by scope.
- **IRDAI**: the English name column is used; Marathi/Devanagari text is stripped.
- **PFRDA**: only the Pension Fund table is read; two-company cells are split.
- **SEBI**: exact `intmId` matching (id 2 no longer matches 21/25/27); each source's id is checked against the hub page label (`hubLabelHint`); if the Download file is under 97% of the hub count, pagination tops it up. Run-log shows hub label, intmId used, expected vs got.
- **Press releases**: headers/serial numbers/PINs are rejected as names; count words ("Four") are read; table rows are topped up from prose; mismatches save the page to `output/diagnostics/press-release-<id>.html`. New "Press Release Summary" sheet and a "Match Type" column (Exact / Normalised / Alias / Approximate).

### Diagnostics
Every run uploads `output/diagnostics/**` with the artifact. If a count still differs from the portal, send that folder plus `run-log.json`.
