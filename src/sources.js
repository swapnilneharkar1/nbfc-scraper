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
    type: "manual",
    notes: "Page section is name+address prose per state, not a clean per-entity list - see rbi_banks_custom limitations in scraper.js.",
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
    url: "https://irdai.gov.in/life-insurers1",
    type: "manual",
    notes: "Annex-1 points Non-Life at the same URL as Life insurers - that page (life-insurers1) is Life-specific; Non-Life almost certainly lives at a sibling IRDAI URL (e.g. general-insurers) not yet confirmed. Flagged rather than guessed.",
  },
  {
    key: "irdai_reinsurers",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Re insurers",
    regulator: "IRDAI",
    url: "https://irdai.gov.in/life-insurers1",
    type: "manual",
    notes: "Same URL-mismatch caveat as irdai_non_life.",
  },
  {
    key: "irdai_ca_insurer",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "CA-Insurer-List",
    regulator: "IRDAI",
    url: "https://irdai.gov.in/life-insurers1",
    type: "manual",
    notes: "Same URL-mismatch caveat as irdai_non_life.",
  },

  {
    key: "sebi_credit_rating",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Credit Rating Agency",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=7",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_venture_capital",
    categoryAsPerReturn: "Investment in Overseas JV Company",
    categoryAsPerRegulator: "Venture Capital Funds",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=21",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_foreign_vc",
    categoryAsPerReturn: "Investment in Overseas JV Company",
    categoryAsPerRegulator: "Registered Foreign Venture Capital Investors",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=25",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_investment_adviser",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Investment Adviser",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=13",
    type: "sebi_intermediary_custom",
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
  },
  {
    key: "sebi_mutual_funds",
    categoryAsPerReturn: "Mutual Fund Companies",
    categoryAsPerRegulator: "Mutual Funds",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=23",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_dp_cdsl",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Depository Participants - CDSL",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=18",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_dp_nsdl",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Depository Participants - NSDL",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=19",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_merchant_bankers",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Merchant Banker",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=9",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_debenture_trustee",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Debentures Trustee",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=6",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_custodians",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Registered Custodians",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=27",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_share_transfer_agent",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Share Transfer Agent",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=10",
    type: "sebi_intermediary_custom",
  },
  {
    key: "sebi_banker_to_issue",
    categoryAsPerReturn: "Other Financial Entities",
    categoryAsPerRegulator: "Banker to an Issue",
    regulator: "SEBI",
    url: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=5",
    type: "sebi_intermediary_custom",
  },

  {
    key: "pfrda_pension_fund",
    categoryAsPerReturn: "Pension Funds",
    categoryAsPerRegulator: "Pension Fund",
    regulator: "PFRDA",
    url: "https://www.pfrda.org.in/index1.cshtml?lsid=191",
    type: "aspx_dynamic",
    tableSelector: "table",
    notes:
      "Upgraded from html_table to aspx_dynamic (Puppeteer-rendered) after " +
      "this source returned zero rows in a real run - PFRDA's newer " +
      "intermediaries subdomain blocks automated fetching entirely (robots " +
      "disallow), so I could not directly verify this .cshtml page's exact " +
      "markup the way I did for SEBI. This is a reasonable improvement, not " +
      "a confirmed fix - check run-log.json for this source specifically " +
      "after the next run.",
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
