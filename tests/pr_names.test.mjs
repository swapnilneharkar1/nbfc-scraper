import { extractEntityNames } from "../src/pressReleaseArchive.js";
const html = `<table><tr><td>Sr. No.</td><td>Name of the Company</td><td>CoR No.</td><td>CoR restored on</td></tr>
<tr><td>1</td><td>Goli Finance Limited</td><td>B-13.01</td><td>31-Jul-26</td></tr></table>
<table><tr><td>July 09,1998</td></tr><tr><td>Express Fincap House Private Limited</td></tr><tr><td>31-Jul-26</td></tr><tr><td>CoR restored on</td></tr><tr><td>Cancellation Order Date</td></tr></table>`;
const names = extractEntityNames(html, 1);
const bad = names.filter((n) => /^(july|31-jul|cor restored|cancellation order)/i.test(n));
console.log(names);
if (bad.length) { console.log("FAIL", bad); process.exit(1); }
console.log("PASS no date/header strings extracted as names");
