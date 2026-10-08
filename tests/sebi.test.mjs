import { hrefHasIntmId, resolveSebiIntmId } from "../src/sebiUtils.js";
const h = (id) => `/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=${id}`;
let ok = true;
const t = (label, cond) => { ok &&= cond; console.log(cond ? "PASS" : "FAIL", label); };
t("id 2 does NOT match intmId=21", !hrefHasIntmId(h(21), 2));
t("id 2 does NOT match intmId=27", !hrefHasIntmId(h(27), 2));
t("id 2 matches intmId=2", hrefHasIntmId(h(2), 2));
t("id 9 matches intmId=9&x=1", hrefHasIntmId("a?intmId=9&x=1", 9));
t("id 9 does NOT match intmId=90", !hrefHasIntmId(h(90), 9));

const hub = new Map([
  ["2", { label: "Stock Brokers - Commodity Derivative", expectedCount: 2018 }],
  ["21", { label: "Venture Capital Funds", expectedCount: 149 }],
  ["33", { label: "Portfolio Managers", expectedCount: 504 }],
  ["34", { label: "Foreign Portfolio Investors", expectedCount: 9 }],
]);
// configured id correct -> unchanged
let r = resolveSebiIntmId({ url: h(33), hubLabelHint: "portfolio\\s+manager" }, hub);
t("correct id kept, expected count read from hub", r.intmId === "33" && r.expectedCount === 504 && !r.warning);
// configured id points at a different category; exactly one hub row matches -> switched
r = resolveSebiIntmId({ url: h(34), hubLabelHint: "^portfolio\\s+manager" }, hub);
t("wrong id switched to the one matching hub row", r.intmId === "33" && r.changedFrom === "34" && !!r.warning);
// no hint -> never changes anything
r = resolveSebiIntmId({ url: h(34) }, hub);
t("no hint -> untouched", r.intmId === "34" && !r.warning);
// hub unavailable -> untouched
r = resolveSebiIntmId({ url: h(34), hubLabelHint: "portfolio" }, new Map());
t("hub unavailable -> untouched", r.intmId === "34" && !r.warning);
// ambiguous -> keeps configured and warns
const hub2 = new Map([["5", { label: "Stock Brokers A", expectedCount: 1 }], ["6", { label: "Stock Brokers B", expectedCount: 2 }], ["7", { label: "Other", expectedCount: 3 }]]);
r = resolveSebiIntmId({ url: h(7), hubLabelHint: "stock brokers" }, hub2);
t("ambiguous match -> kept + warned", r.intmId === "7" && !!r.warning);
process.exit(ok ? 0 : 1);
