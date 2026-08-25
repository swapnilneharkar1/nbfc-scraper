/**
 * sources.js
 * -----------
 * One entry per row of "Annex-1 Regulated entities" in the BRD.
 *
 * `type` tells the scraper which strategy to use:
 *   - "html_table"   : a plain HTML <table> on the page (fastest, most reliable)
 *   - "aspx_dynamic" : an ASPX page that renders its table via postback/JS,
 *                      needs Puppeteer to click/wait before reading the DOM
 *   - "pdf_link"     : the list is only published as a linked PDF/XLS file;
 *                      we download the file and parse it (pdf-parse / xlsx)
 *   - "manual"       : no stable public scrape target found - flagged so a
 *                      human downloads it and drops it in /input, or the
 *                      Portal Link is followed by hand periodically.
 *
 * IMPORTANT: These are government/regulator sites. They change markup,
 * move pages, and rate-limit far more often than commercial sites. Treat
 * every selector below as a first draft - re-check it whenever a run fails.
 */

export const sources = [
  {
    key: "rbi_nbfc",
    reportCategory: "Other NBFCs",
    classification: "Non-Banking Financial Company (NBFC)",
    regulator: "RBI",
    url: "https://www.rbi.org.in/Scripts/BS_NBFCList.aspx",
    fileUrl:
      "https://rbidocs.rbi.org.in/rdocs/content/DOCs/List_of_NBFCs_and_ARCs_registered_with_the_RBI.XLSX",
    type: "xlsx_direct",
    notes:
      "IMPORTANT: rbidocs.rbi.org.in serves a CAPTCHA/bot-check page instead " +
      "of the file when hit by a script or headless browser without a prior " +
      "human-solved challenge. This means automated download WILL currently " +
      "fail in CI. Workaround: download the file manually each cycle and drop " +
      "it into /manual-downloads/rbi_nbfc.xlsx - the scraper will use that " +
      "local copy if present instead of re-fetching from RBI.",
  },
  {
    key: "rbi_pss",
    reportCategory: "Other Financial Entities",
    classification: "Payment and Settlement Systems (PSS)",
    regulator: "RBI",
    url: "https://www.rbi.org.in/Scripts/PublicationsView.aspx?id=12043",
    type: "aspx_dynamic",
    tableSelector: "table",
    notes:
      "CONFIRMED NOT SCRAPABLE AS A TABLE: this RBI page is formatted as long " +
      "prose/numbered-list paragraphs, not real <table> markup. Generic table " +
      "scraping correctly returns nothing here (a length filter blocks the " +
      "garbage it would otherwise produce). Getting real data out requires a " +
      "purpose-built regex/NLP extractor tuned to this page's exact wording, " +
      "which will break the moment RBI rephrases anything. Recommend manual " +
      "entry for this one, or ask for a bespoke parser if the wording is stable " +
      "enough to be worth it.",
  },
  {
    key: "nhb_hfc",
    reportCategory: "Housing Finance Companies",
    classification: "Housing Finance Companies (HFCs)",
    regulator: "NHB",
    url: "https://www.nhb.org.in/supervision/list-of-hfcs-in-india/",
    type: "pdf_link",
    linkPattern: /list.*hfc.*\.pdf$/i,
    notes: "NHB publishes the HFC list as a linked PDF, not an HTML table.",
  },
  {
    key: "rbi_banks",
    reportCategory: "Banks",
    classification:
      "Private/Public/Foreign/Local Area/Small Finance/Payments/Regional Rural/Co-operative Banks",
    regulator: "RBI",
    url: "https://rbi.org.in/commonman/English/Scripts/BanksInIndia.aspx",
    type: "aspx_dynamic",
    tableSelector: "table",
    notes:
      "Same issue as rbi_pss: this page is prose/heading-based, not real <table> " +
      "markup, so it correctly returns 0 rows rather than garbage. There IS a " +
      "cleaner numbered 'Sr.No. Name of the Bank' summary list further down the " +
      "same page for several categories (SBI, private banks, foreign banks, " +
      "RRBs) that could be regex-extracted specifically - worth a bespoke parser " +
      "if this category matters for your reporting.",
  },
  {
    key: "irdai_life",
    reportCategory: "Insurance Companies",
    classification: "Life Insurance Companies",
    regulator: "IRDAI",
    url: "https://irdai.gov.in/life-insurers1",
    type: "html_table",
    tableSelector: "table",
    notes: "Also carries Non-Life, Re-insurers and CA-Insurer-List elsewhere on the same IRDAI section - split by page tab.",
  },
  {
    key: "sebi_credit_rating",
    reportCategory: "Other Financial Entities",
    classification: "Credit Rating Agency",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognised=yes",
    type: "html_table",
    tableSelector: "table",
    notes: "This single SEBI 'recognised intermediaries' page is reused for ~15 rows in Annex-1 (Credit Rating Agency, Venture Capital Funds, Investment Adviser, Stock Brokers x6 segments, Portfolio Managers, Depository Participants x2, Merchant Bankers, Debenture Trustee, Registered Custodians). Select by the intermediary-type dropdown/tab before reading the table.",
  },
  {
    key: "pfrda_pension_fund",
    reportCategory: "Pension Funds",
    classification: "Pension Fund",
    regulator: "PFRDA",
    url: "https://www.pfrda.org.in/index1.cshtml?lsid=191",
    type: "html_table",
    tableSelector: "table",
  },
  {
    key: "amfi_distributor",
    reportCategory: "Other Financial Entities",
    classification: "Mutual Fund Distributor",
    regulator: "AMFI",
    url: "https://www.amfiindia.com/locate-distributor",
    type: "manual",
    notes: "Distributor locator is a search-by-city/PIN widget with no bulk listing - not realistically scrapable in bulk. Recommend sourcing this one from AMFI's published ARN master file instead (ask AMFI relationship contact), or drop this row from automated scope.",
  },
  {
    key: "rbi_nbfc_cancelled",
    reportCategory: "Other NBFCs",
    classification: "NBFC / ARC - Cancelled CoR",
    regulator: "RBI",
    url: "https://www.rbi.org.in/Scripts/BS_NBFCList.aspx",
    fileUrl:
      "https://rbidocs.rbi.org.in/rdocs/content/DOCs/List_of_NBFCs_and_ARCs_whose_CoR_has_been_cancelled_by_the_RBI.XLSX",
    type: "xlsx_direct",
    notes:
      "Same CAPTCHA caveat as rbi_nbfc above - same manual-download fallback applies " +
      "(/manual-downloads/rbi_nbfc_cancelled.xlsx). Matches Annex-3 'Cancelled NBFC & ARC' " +
      "sheet in the BRD workbook.",
  },
];

export default sources;
