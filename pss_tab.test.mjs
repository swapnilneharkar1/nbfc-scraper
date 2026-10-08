import { parseRbiPssSection } from "../src/customParsers.js";
const inner = `A. Certificates of Authorisation issued to Payment System Operators
1.\tBank of India\tBank of India, Star House, Mumbai
2.\tPunjab National Bank\tPunjab National Bank, 7 Bhikaji Cama Place
3.\tRazorpay Payments Private Limited (formerly Razorpay Software Private Limited)\tPA
4.\tRazorpay Payments Private Limited\tPPI
5.\tCSC e – Governance Services India Ltd
6.\tCSC e-Governance Services India Limited
B. Certificates of Authorisation Revoked`;
const { names } = parseRbiPssSection(`<html><body>${inner.replace(/\n/g, "<br>")}</body></html>`, "operating", inner);
console.log(names);
const ok = names.includes("Bank of India") && names.includes("Punjab National Bank") && names.length === 4;
console.log(ok ? "PASS tab names cut to first cell, spelling variants merged" : "FAIL");
process.exit(ok ? 0 : 1);
