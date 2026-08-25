import ExcelJS from "exceljs";

/**
 * Writes results in the same shape as the BRD's "Annex-2 Combine List" sheet:
 * Name of the Active NBFCs / HFCs / Others | Category | Classification | Institution
 * plus two extra audit columns (Regulator, Source Key) so you can trace
 * every row back to where it came from.
 */
export async function writeWorkbook(rows, outFile) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "nbfc-fii-scraper";
  wb.created = new Date();

  const sheet = wb.addWorksheet("Combine List");
  sheet.columns = [
    { header: "Name of the Active NBFCs / HFCs / Others", key: "name", width: 55 },
    { header: "Category", key: "category", width: 28 },
    { header: "Classification", key: "classification", width: 32 },
    { header: "Institution", key: "institution", width: 28 },
    { header: "Regulator", key: "regulator", width: 12 },
    { header: "Source Key", key: "sourceKey", width: 18 },
    { header: "Scraped At", key: "scrapedAt", width: 20 },
  ];
  sheet.getRow(1).font = { bold: true };

  const scrapedAt = new Date().toISOString();
  for (const r of rows) {
    sheet.addRow({ ...r, scrapedAt });
  }

  sheet.autoFilter = { from: "A1", to: "G1" };

  await wb.xlsx.writeFile(outFile);
}
