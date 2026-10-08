/**
 * sources.js
 * -----------
 * Rebuilt to follow the BRD's Annex-1 "Regulated entities" sheet directly.
 *
 * Each entry carries BOTH of the BRD's category columns, kept distinct per
 * BRD issue #1 (category tagging must come from the regulator-specific
 * column, not a generic worksheet-level label):
 *   - categoryAsPerReturn:      Annex-1 column "Categories of Entities - As
 *                                per Return" (broad reporting bucket)
 *   - categoryAsPerRegulator:   Annex-1 column "Categories of Entities - As
 *                                per Regulators" (the actual regulator-
 *                                specific category - this is what BRD issue
 *                                #1 says must drive entity-level tagging,
 *                                and what feeds the Priority Matrix)
 *
 * `type` tells the scraper which strategy to use - see scraper.js for the
 * implementation of each:
 *   - "html_table"        : a plain HTML <table> on the page
 *   - "aspx_dynamic"      : ASPX page needing Puppeteer to render before reading
 *   - "xlsx_direct"       : known direct .xlsx download URL
 *   - "pdf_link"          : list only published as a linked PDF
 *   - "rbi_banks_custom"  : bespoke entity-wise parser for RBI's Banks page
 *                            (BRD issue #4 - required bank sub-classification)
 *   - "rbi_pss_custom"    : bespoke entity-wise parser for RBI's PSS page
 *   - "manual"            : no realistic bulk-scrape target
 */

/**
 * RBI's Banks page does not separate scheduled from non-scheduled State
 * Co-operative Banks. These are the non-scheduled ones (RBI's own
 * classification); a bank whose name contains one of these words is
 * reported as Non-Scheduled, all others as (Scheduled) State Co-operative
 * Banks. Edit this list if RBI's classification changes - the run log
 * warns when a word here matches no bank on the page.
 */
export const NON_SCHEDULED_STATE_COOP_KEYWORDS = [
  "Andaman",
  "Arunachal",
  "Assam",
  "Chandigarh",
  "Daman",
  "Jammu",
  "Jharkhand",
  "Manipur",
  "Mizoram",
  "Nagaland",
];

export const sources = [
  {
    key: "rbi_nbfc",
    categoryAsPerReturn: "Other NBFCs",
    categoryAsPerRegulator: "NBFC",
    regulator: "RBI",
    url: "https://www.rbi.org.in/Scripts/BS_NBFCList.aspx",
    fileUrl:
      "https://rbidocs.rbi.org.in/rdocs/content/DOCs/List_of_NBFCs_and_ARCs_registered_with_the_RBI.XLSX",
    type: "xlsx_direct",
    captureClassificationColumn: true,
    notes:
      "RBI's file has SR No | NBFC Name | Regional Office | Whether CoR for " +
      "public deposits | Classification | CIN | Address | Email ID. The " +
      "Classification column is what BRD issue #3 asks for - captured " +
      "per-entity, not defaulted to a generic 'NBFC' label. " +
      "CAPTCHA caveat: see manual-downloads/rbi_nbfc.xlsx fallback in scraper.js.",
  },
  {
    key: "rbi_nbfc_cancelled",
    categoryAsPerReturn: "Other NBFCs",
    categoryAsPerRegulator: "NBFC",
    regulator: "RBI",
    url: "https://www.rbi.org.in/Scripts/BS_NBFCList.aspx",
    fileUrl:
      "https://rbidocs.rbi.org.in/rdocs/content/DOCs/List_of_NBFCs_and_ARCs_whose_CoR_has_been_cancelled_by_the_RBI.XLSX",
    type: "xlsx_direct",
    captureClassificationColumn: true,
    statusOverride: "Cancelled",
    notes: "Matches Annex-3 'Cancelled NBFC & ARC'. Same CAPTCHA caveat as rbi_nbfc.",
  },

  {
    key: "rbi_pss_operating",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "PSS Operating",
    regulator: "RBI",
    url: "https://www.rbi.org.in/Scripts/PublicationsView.aspx?id=12043",
    type: "rbi_pss_custom",
    pssSection: "operating",
  },
  {
    key: "rbi_pss_revoked",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "PSS Revoked",
    regulator: "RBI",
    url: "https://www.rbi.org.in/Scripts/PublicationsView.aspx?id=12043",
    type: "rbi_pss_custom",
    pssSection: "revoked",
  },
  {
    key: "rbi_pss_ceased",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "PSS Ceased",
    regulator: "RBI",
    url: "https://www.rbi.org.in/Scripts/PublicationsView.aspx?id=12043",
    type: "rbi_pss_custom",
    pssSection: "ceased",
  },
  {
    key: "rbi_pss_surrendered",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "PSS Surrender/Cancelled",
    regulator: "RBI",
    url: "https://www.rbi.org.in/Scripts/PublicationsView.aspx?id=12043",
    type: "rbi_pss_custom",
    pssSection: "surrendered",
    notes:
      "Section D (voluntary surrender). Previously lumped with section E " +
      "under one 'cancelled' key and the heading regex's character-gap cap " +
      "was too short to match the real heading text at all, so this section " +
      "silently returned zero rows - fixed and split into its own category.",
  },
  {
    key: "rbi_pss_cancelled",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "PSS Surrender/Cancelled",
    regulator: "RBI",
    url: "https://www.rbi.org.in/Scripts/PublicationsView.aspx?id=12043",
    type: "rbi_pss_custom",
    pssSection: "cancelled_regulatory",
    notes: "Section E (cancelled per regulatory requirement) - now separated from section D above.",
  },

  {
    key: "nhb_hfc",
    categoryAsPerReturn: "Housing Finance Companies",
    categoryAsPerRegulator: "HFCs",
    regulator: "NHB",
    url: "https://www.nhb.org.in/supervision/list-of-hfcs-in-india/",
    fileUrl: "https://www.nhb.org.in/Regulation/Registered_Companies.pdf",
    type: "pdf_link",
    notes:
      "Previous version searched the landing page for a link matching " +
      "/list.*hfc.*\\.pdf$/i and found nothing - the real file is named " +
      "Registered_Companies.pdf, which doesn't match that pattern at all. " +
      "Now points directly at the confirmed real URL instead of guessing " +
      "from a link-text pattern.",
  },

  {
    key: "rbi_bank_private",
    categoryAsPerReturn: "Banks",
    categoryAsPerRegulator: "Private Sector Banks in India",
    regulator: "RBI",
    url: "https://rbi.org.in/commonman/English/Scripts/BanksInIndia.aspx",
    type: "rbi_banks_custom",
    bankSection: "private",
  },
  {
    key: "rbi_bank_public",
    categoryAsPerReturn: "Banks",
    categoryAsPerRegulator: "Public Sector Banks in India",
    regulator: "RBI",
    url: "https://rbi.org.in/commonman/English/Scripts/BanksInIndia.aspx",
    type: "rbi_banks_custom",
    bankSection: "public",
  },
  {
    key: "rbi_bank_lab",
    categoryAsPerReturn: "Banks",
    categoryAsPerRegulator: "Local Area Banks (LAB)",
    regulator: "RBI",
    url: "https://rbi.org.in/commonman/English/Scripts/BanksInIndia.aspx",
    type: "rbi_banks_custom",
    bankSection: "lab",
    notes:
      "Now read from RBI's Banks page itself (every LAB name contains 'Local Area " +
      "Bank'). The previous source, LAB01112021.pdf, is a 2021 document and " +
      "produced the wrong banks.",
  },
  {
    key: "rbi_bank_sfb",
    categoryAsPerReturn: "Banks",
    categoryAsPerRegulator: "Small Finance Banks (SFB)",
    regulator: "RBI",
    url: "https://rbi.org.in/commonman/English/Scripts/BanksInIndia.aspx",
    type: "rbi_banks_custom",
    bankSection: "sfb",
  },
  {
    key: "rbi_bank_pb",
    categoryAsPerReturn: "Banks",
    categoryAsPerRegulator: "Payments Banks (PB)",
    regulator: "RBI",
    url: "https://rbi.org.in/commonman/English/Scripts/BanksInIndia.aspx",
    type: "rbi_banks_custom",
    bankSection: "pb",
  },
  {
    key: "rbi_bank_rrb",
    categoryAsPerReturn: "Banks",
    categoryAsPerRegulator: "Regional Rural Banks in India",
    regulator: "RBI",
    url: "https://rbi.org.in/commonman/English/Scripts/BanksInIndia.aspx",
    type: "rbi_banks_custom",
    bankSection: "rrb",
  },
  {
    key: "rbi_bank_foreign",
    categoryAsPerReturn: "Banks",
    categoryAsPerRegulator: "Foreign banks",
    regulator: "RBI",
    url: "https://rbi.org.in/commonman/English/Scripts/BanksInIndia.aspx",
    type: "rbi_banks_custom",
    bankSection: "foreign",
  },
  {
    key: "rbi_financial_institutions",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Financial Institutions in India",
    regulator: "RBI",
    url: "https://rbi.org.in/commonman/English/Scripts/BanksInIndia.aspx",
    type: "manual",
    notes:
      "Annex-1 points this row at the same Banks page, but the page doesn't " +
      "carry a distinct 'Financial Institutions' list separate from SBI/" +
      "Nationalised/Private/Foreign banks - likely meant to point at RBI's " +
      "actual All India Financial Institutions listing elsewhere on rbi.org.in. " +
      "Flagged for manual sourcing rather than guessing at a URL.",
  },
  {
    key: "rbi_bank_state_coop",
    categoryAsPerReturn: "Banks",
    categoryAsPerRegulator: "State Co-operative Banks",
    regulator: "RBI",
    url: "https://rbi.org.in/commonman/English/Scripts/BanksInIndia.aspx",
    type: "rbi_state_coop_custom",
    coopScope: "scheduled",
    nonScheduledKeywords: NON_SCHEDULED_STATE_COOP_KEYWORDS,
    notes:
      "RBI's Banks page lists ALL State Co-operative Banks in one numbered block " +
      "(34 entries, scheduled and non-scheduled together). The block is read from " +
      "the page and split using nonScheduledKeywords. The previous source, a 2014 " +
      "PDF, was out of date.",
  },
  {
    key: "rbi_bank_scheduled_urban_coop",
    categoryAsPerReturn: "Banks",
    categoryAsPerRegulator: "Scheduled Urban Co-operative Banks",
    regulator: "RBI",
    url: "https://rbi.org.in/commonman/English/Scripts/BanksInIndia.aspx",
    fileUrl: "https://www.rbi.org.in/commonman/upload/English/Content/pdfs/schedulecoop.pdf",
    type: "pdf_link",
    notes: "Found via search - direct RBI PDF of Scheduled Urban Co-operative Banks. Same PDF-extraction caveat as rbi_bank_state_coop.",
  },
  {
    key: "rbi_bank_non_scheduled_urban_coop",
    categoryAsPerReturn: "Banks",
    categoryAsPerRegulator: "Non-Scheduled Urban Co-operative Banks",
    regulator: "RBI",
    url: "https://rbi.org.in/commonman/English/Scripts/BanksInIndia.aspx",
    fileUrl: "https://rbidocs.rbi.org.in/rdocs/Content/pdfs/nonschedulecoop.pdf",
    type: "pdf_link",
    notes: "Found via search - a plausible match for Non-Scheduled Urban Co-op Banks based on its content (urban bank names/addresses), but the filename itself doesn't explicitly confirm Urban vs State scope - verify against the PDF directly.",
  },
  {
    key: "rbi_bank_non_scheduled_state_coop",
    categoryAsPerReturn: "Banks",
    categoryAsPerRegulator: "Non-Scheduled State Co-operative Banks",
    regulator: "RBI",
    url: "https://rbi.org.in/commonman/English/Scripts/BanksInIndia.aspx",
    type: "rbi_state_coop_custom",
    coopScope: "non_scheduled",
    nonScheduledKeywords: NON_SCHEDULED_STATE_COOP_KEYWORDS,
    notes: "Same State Co-operative Banks block as rbi_bank_state_coop; this entry takes the non-scheduled banks.",
  },

  {
    key: "irdai_life",
    categoryAsPerReturn: "Insurance Companies",
    categoryAsPerRegulator: "Life Insurance Companies",
    regulator: "IRDAI",
    url: "https://irdai.gov.in/life-insurers1",
    type: "html_table",
    tableSelector: "table",
  },
  {
    key: "irdai_non_life",
    categoryAsPerReturn: "Insurance Companies",
    categoryAsPerRegulator: "Non-Life Insurance Companies",
    regulator: "IRDAI",
    url: "https://irdai.gov.in/non-life-insurers1",
    type: "html_table",
    tableSelector: "table",
    notes: "Found via search, matching the same URL naming pattern as the already-working life-insurers1 (just life -> non-life).",
  },
  {
    key: "irdai_reinsurers",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Re insurers",
    regulator: "IRDAI",
    url: "https://irdai.gov.in/list-of-reinsurers",
    type: "html_table",
    tableSelector: "table",
    notes: "Confirmed real IRDAI page via search - different URL style than the -insurers1 pattern, but genuinely IRDAI's own page for this list.",
  },
  {
    key: "irdai_ca_insurer",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "CA-Insurer-List",
    regulator: "IRDAI",
    url: "https://irdai.gov.in/list-of-corporate-agents1",
    type: "html_table",
    tableSelector: "table",
    notes: "CA = Corporate Agents (confirmed). Same -1 suffix pattern as life-insurers1/non-life-insurers1.",
  },

  {
    key: "sebi_credit_rating",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Credit Rating Agency",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=7",
    type: "sebi_intermediary_custom",
    hubLabelHint: "credit\\s+rating",
  },
  {
    key: "sebi_venture_capital",
    categoryAsPerReturn: "Investment in Overseas JV Company",
    categoryAsPerRegulator: "Venture Capital Funds",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=21",
    type: "sebi_intermediary_custom",
    hubLabelHint: "venture\\s+capital\\s+fund",
  },
  {
    key: "sebi_foreign_vc",
    categoryAsPerReturn: "Investment in Overseas JV Company",
    categoryAsPerRegulator: "Registered Foreign Venture Capital Investors",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=25",
    type: "sebi_intermediary_custom",
    hubLabelHint: "foreign\\s+venture",
  },
  {
    key: "sebi_investment_adviser",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Investment Adviser",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=13",
    type: "sebi_intermediary_custom",
    hubLabelHint: "investment\\s+advis",
  },
  {
    key: "sebi_broker_equity",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Stock Brokers in equity segment",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=30",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_broker_equity_derivative",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Stock Brokers in Equity Derivative Segment",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=31",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_broker_commodity_derivative",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Stock Brokers in Commodity Derivative",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=2",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_broker_debt",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Stock Brokers in Debt Segement",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=37",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_broker_interest_rate_derivative",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Stock Brokers in Interest Rate Derivative",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=38",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_broker_currency_derivative",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Stock Brokers in Currency Derivative Segment",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=32",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_portfolio_managers",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Registered Portfolio Managers",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=33",
    type: "sebi_intermediary_custom",
    hubLabelHint: "portfolio\\s+manager",
  },
  {
    key: "sebi_mutual_funds",
    categoryAsPerReturn: "Mutual Fund Companies",
    categoryAsPerRegulator: "Mutual Funds",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=23",
    type: "sebi_intermediary_custom",
    hubLabelHint: "mutual\\s+fund",
  },
  {
    key: "sebi_dp_cdsl",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Depository Participants - CDSL",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=18",
    type: "sebi_intermediary_custom",
    hubLabelHint: "cdsl",
  },
  {
    key: "sebi_dp_nsdl",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Depository Participants - NSDL",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=19",
    type: "sebi_intermediary_custom",
    hubLabelHint: "nsdl",
  },
  {
    key: "sebi_merchant_bankers",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Merchant Banker",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=9",
    type: "sebi_intermediary_custom",
    hubLabelHint: "merchant\\s+banker",
  },
  {
    key: "sebi_debenture_trustee",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Debentures Trustee",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=6",
    type: "sebi_intermediary_custom",
    hubLabelHint: "debentures?\\s+trustee",
  },
  {
    key: "sebi_custodians",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Registered Custodians",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=27",
    type: "sebi_intermediary_custom",
    hubLabelHint: "custodian",
  },
  {
    key: "sebi_share_transfer_agent",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Share Transfer Agent",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=10",
    type: "sebi_intermediary_custom",
    hubLabelHint: "(share\\s+transfer|registrar)",
  },
  {
    key: "sebi_banker_to_issue",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Banker to an Issue",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=5",
    type: "sebi_intermediary_custom",
    hubLabelHint: "banker.*issue",
  },

  {
    key: "pfrda_pension_fund",
    categoryAsPerReturn: "Pension Funds",
    categoryAsPerRegulator: "Pension Fund",
    regulator: "PFRDA",
    url: "https://www.pfrda.org.in/web/pfrda/intermediaries/registered-intermediaries/pension-funds",
    type: "aspx_dynamic",
    tableSelector: "table",
    // The page carries several tables (other NPS intermediaries). Only a table
    // whose header mentions "Pension Fund" is the pension-fund list, and every
    // name must itself look like a pension fund company.
    // (The page's FIRST table is a fee-slab table whose header also says
    // "Pension Fund" - hence the stricter pattern - and the real list is a
    // bullet list under "List of Pension Funds", read via listFallback.)
    tableHeaderPattern: "name\\s+of\\s+(the\\s+)?pension|pension\\s+fund\\s+(manager|name|company)",
    nameKeywordFilter: "pension|retirement",
    listFallback: {
      headingPattern: "^list\\s+of\\s+pension\\s+funds",
      keywordPattern: "pension|retirement",
      stopPattern: "^(public\\s+disclosures|schemes|return\\s+of|investment\\s+management|note)",
    },
    // One cell can hold two companies on separate lines
    // ("Kotak Mahindra Pension Fund Limited / Aditya Birla Sun Life Pension Management Limited").
    splitCombinedNames: true,
    notes:
      "Previous version read EVERY table on the page and so picked up the wrong " +
      "one. The page's raw text/HTML is saved to output/diagnostics/ on every " +
      "run so the selection can be checked.",
  },

  {
    key: "amfi_distributor",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Mutual Fund Distributor",
    regulator: "AMFI",
    url: "https://www.amfiindia.com/locate-distributor",
    type: "manual",
    notes: "Distributor locator is a search-by-city/PIN widget with no bulk listing - source from AMFI's ARN master file instead.",
  },
];

export default sources;
