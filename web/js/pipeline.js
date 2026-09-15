/* Supply Top 25 pipeline - a browser-safe port of the Python `supplytrack` package.
 *
 * Pure logic only: no DOM, no fetch, no Node APIs, no dependencies. Imports
 * cleanly in a browser (ES module, also from file://) and in Node 18+, so the
 * page and the parity test suite run the same code.
 *
 * The Python package in ../../supplytrack is the reference implementation. The
 * rule for this file is behaviour parity, not structural parity: the modules
 * there read and write files, and everything here takes values in and hands
 * values back, but the numbers, the ordering, the CSV bytes and the validator
 * messages must match. Where a Python function's job was "read the file and
 * decide", the JS counterpart keeps only the deciding half.
 *
 * Deliberate departures from the Python, all of them forced by the browser
 * having no filesystem, are marked with a `PARITY NOTE:` comment.
 */

import { parse as csvParse, parseObjects, serialiseObjects } from "./csv.js";

// ===========================================================================
// Errors
// ===========================================================================

/**
 * The one exception this module raises for a failure a person must act on.
 *
 * Thrown only where the return shape has no channel for the problem - a cell
 * that cannot be read, a missing column, a decision file that is not ready to
 * apply. Where a function returns findings or problems (`rank`, `loadPrices`,
 * `checkPrices`, `validateAll`), the problem goes in the return value instead,
 * so the page can render it rather than catch it.
 */
export class SupplytrackError extends Error {
  constructor(message) {
    super(message);
    this.name = "SupplytrackError";
  }
}

function fail(message) {
  throw new SupplytrackError(message);
}

// ===========================================================================
// Text helpers
// ===========================================================================

/**
 * Python's `str.casefold()`, close enough for the data this tool sees.
 *
 * PARITY NOTE: JS has no casefold. `toLowerCase` agrees with casefold on all
 * ASCII and nearly all Latin text; the handful of characters where full
 * casefolding expands or merges differently are mapped explicitly below. A
 * title containing something outside this table and outside ASCII could fold
 * differently from Python - none of the 2025 data does.
 */
const CASEFOLD_SPECIALS = [
  ["ß", "ss"], // LATIN SMALL LETTER SHARP S
  ["ẞ", "ss"], // LATIN CAPITAL LETTER SHARP S
  ["ﬀ", "ff"],
  ["ﬁ", "fi"],
  ["ﬂ", "fl"],
  ["ﬃ", "ffi"],
  ["ﬄ", "ffl"],
  ["ﬅ", "st"],
  ["ﬆ", "st"],
  ["ſ", "s"], // LATIN SMALL LETTER LONG S
  ["ς", "σ"], // final sigma folds to sigma
  ["İ", "i̇"], // LATIN CAPITAL LETTER I WITH DOT ABOVE
];

export function casefold(value) {
  let s = String(value ?? "");
  for (const [from, to] of CASEFOLD_SPECIALS) {
    if (s.indexOf(from) !== -1) s = s.split(from).join(to);
  }
  return s.toLowerCase();
}

/** Compare two strings by Unicode code point, the way Python's `sorted` does. */
export function cmpCodePoint(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (x === y) return 0;
  const A = Array.from(x);
  const B = Array.from(y);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i += 1) {
    const ca = A[i].codePointAt(0);
    const cb = B[i].codePointAt(0);
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  if (A.length === B.length) return 0;
  return A.length < B.length ? -1 : 1;
}

/** `s[:n]` by code point, not by UTF-16 unit, so an emoji is not cut in half. */
function slicePoints(value, n) {
  const s = String(value ?? "");
  const points = Array.from(s);
  return points.length <= n ? s : points.slice(0, n).join("");
}

/** Python's `repr()` of a string, for the error messages that quote a value. */
export function pyRepr(value) {
  if (value == null) return "None";
  const s = String(value);
  const quote = s.indexOf("'") !== -1 && s.indexOf('"') === -1 ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else {
      const code = ch.codePointAt(0);
      if (code < 0x20 || code === 0x7f) {
        out += "\\x" + code.toString(16).padStart(2, "0");
      } else {
        out += ch;
      }
    }
  }
  return out + quote;
}

/** Strip, case-fold and collapse internal whitespace, for header matching. */
export function normHeader(h) {
  return casefold(String(h ?? "").trim().replace(/\s+/g, " "));
}

/**
 * A cell as trimmed text, with Excel's formula wrapper removed.
 *
 * Amazon writes some identifier columns as the formula string `="0000"` so
 * Excel keeps the leading zeros. Anything shaped like that is unwrapped.
 */
export function cleanText(value) {
  if (value == null) return "";
  let text;
  if (value instanceof Date) text = isoDateUTC(value);
  else text = String(value).trim();
  if (value instanceof Date) return text;
  const m = /^=\s*"([\s\S]*)"$/.exec(text);
  if (m) return m[1].trim();
  return text;
}

/**
 * A cell read back as the CSV text it was written from. Ports
 * supplytrack.xlsx.csv_text - read that docstring for the reasoning.
 *
 * A blank cell is ""; a whole number is a canonical integer string (12, never
 * 12.0); any other number drops its trailing zeros; a date is an ISO
 * YYYY-MM-DD date; text is returned exactly as it is, with nothing stripped
 * and no formula wrapper removed, because anything else would change the bytes.
 */
export function csvText(value) {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return isoDateUTC(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    if (Number.isInteger(value)) return String(value);
    const d = decParse(String(value));
    return d ? decTrim(d) : String(value);
  }
  return String(value);
}

/**
 * True when `text` is already the one spelling csvText gives that integer.
 * Ports supplytrack.xlsx.is_canonical_int: only then is it safe to write the
 * value to a sheet as a number, because 007 would come back as 7.
 */
export function isCanonicalInt(text) {
  const s = String(text ?? "");
  return /^(0|-?[1-9]\d*)$/.test(s);
}

// ===========================================================================
// Decimal arithmetic
//
// Prices and quantities must not go through a JS float. `last_paid_per_each`
// is written into ranked.csv and compared byte for byte against the Python
// output, and Python computes it with `decimal.Decimal` - exact base-10
// arithmetic with round-half-even. These few helpers reproduce that with
// BigInt: a decimal is {neg, digits: BigInt, exp} meaning
// (neg ? -1 : 1) * digits * 10**exp.
// ===========================================================================

const DEC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Parse a decimal literal the way `Decimal(text)` does, or null if it cannot. */
export function decParse(text) {
  const s = String(text ?? "").trim();
  if (!s || !DEC_RE.test(s)) return null;
  let body = s;
  let neg = false;
  if (body[0] === "+" || body[0] === "-") {
    neg = body[0] === "-";
    body = body.slice(1);
  }
  let exp = 0;
  const e = body.search(/[eE]/);
  if (e !== -1) {
    exp = parseInt(body.slice(e + 1), 10);
    body = body.slice(0, e);
  }
  const dot = body.indexOf(".");
  if (dot !== -1) {
    exp -= body.length - dot - 1;
    body = body.slice(0, dot) + body.slice(dot + 1);
  }
  if (!body.length) return null;
  return { neg, digits: BigInt(body), exp };
}

/** `format(number, "f")`: the plain, non-scientific representation. */
export function decToPlain(d) {
  if (!d) return "";
  const sign = d.neg && d.digits !== 0n ? "-" : d.neg ? "-" : "";
  let digits = d.digits.toString();
  let out;
  if (d.exp >= 0) {
    out = digits + "0".repeat(d.exp);
  } else {
    const places = -d.exp;
    if (digits.length <= places) digits = "0".repeat(places - digits.length + 1) + digits;
    out = digits.slice(0, digits.length - places) + "." + digits.slice(digits.length - places);
  }
  return sign + out;
}

/** Python's `_trim`: the plain form with trailing zeros after a point removed. */
export function decTrim(d) {
  let text = decToPlain(d);
  if (text.indexOf(".") !== -1) {
    text = text.replace(/0+$/, "").replace(/\.$/, "");
  }
  if (text === "" || text === "-") return "0";
  return text;
}

/** True when the decimal is a whole number. */
function decIsIntegral(d) {
  if (d.exp >= 0) return true;
  const places = -d.exp;
  const s = d.digits.toString();
  if (s.length <= places) return d.digits === 0n;
  return /^0+$/.test(s.slice(s.length - places));
}

/** The decimal as a JS integer; only called after `decIsIntegral`. */
function decToInt(d) {
  const scaled = d.exp >= 0 ? d.digits * 10n ** BigInt(d.exp) : d.digits / 10n ** BigInt(-d.exp);
  const n = Number(scaled);
  return d.neg ? -n : n;
}

/**
 * `(value / divisor)` rounded half-to-even to `places` decimals, as a string.
 *
 * Python reaches the same number by dividing at 28 significant digits and then
 * quantizing, which is double rounding - but a quotient that terminates inside
 * 28 digits is exact at that point, and one that does not can never sit on a
 * 4-decimal midpoint, so the two agree for every input.
 */
export function decDivideRound(value, divisor, places) {
  if (divisor === 0) return null;
  const negDivisor = divisor < 0;
  const d = BigInt(Math.abs(divisor));
  const scale = 10n ** BigInt(places);
  // numerator = digits * 10^exp * 10^places, kept as an exact ratio.
  let num = value.digits * scale;
  let den = d;
  if (value.exp >= 0) num *= 10n ** BigInt(value.exp);
  else den *= 10n ** BigInt(-value.exp);

  let q = num / den;
  const r = num % den;
  const twice = r * 2n;
  if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;

  const neg = value.neg !== negDivisor;
  return { neg: neg && q !== 0n, digits: q, exp: -places };
}

/** Python's `float(text)` - accepts what it accepts, rejects what it rejects. */
function pyFloat(text) {
  const s = String(text ?? "").trim();
  if (!s) return NaN;
  const cleaned = s.replace(/_/g, "");
  if (/_/.test(s) && !/^[+-]?(\d(_?\d)*)?(\.(\d(_?\d)*)?)?([eE][+-]?\d(_?\d)*)?$/.test(s)) {
    return NaN;
  }
  if (/^[+-]?(inf(inity)?|nan)$/i.test(cleaned)) return Number(cleaned.toLowerCase().replace("infinity", "Infinity").replace("inf", "Infinity"));
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) return NaN;
  return Number(cleaned);
}

// ===========================================================================
// Cell coercion
// ===========================================================================

function at(where) {
  return where ? ` (${where})` : "";
}

function isoDateUTC(date) {
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const MONTHS_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTHS_FULL = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function buildDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null; // strptime rejects 30 February too
  }
  return isoDateUTC(date);
}

/** Excel's 1900 date system, via the 1899-12-30 epoch openpyxl uses. */
export function excelSerialToISO(serial) {
  const ms = Date.UTC(1899, 11, 30) + Math.round(Number(serial) * 86400000);
  return isoDateUTC(new Date(ms));
}

const TEXT_DATE_FORMATS = [
  [/^(\d{1,4})-(\d{1,2})-(\d{1,2})$/, (m) => buildDate(+m[1], +m[2], +m[3])], // %Y-%m-%d
  [/^(\d{1,2})\/(\d{1,2})\/(\d{1,4})$/, (m) => buildDate(+m[3], +m[1], +m[2])], // %m/%d/%Y
  [
    /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/,
    (m) => {
      const yy = +m[3];
      return buildDate(yy < 69 ? 2000 + yy : 1900 + yy, +m[1], +m[2]);
    },
  ], // %m/%d/%y
  [/^(\d{1,4})\/(\d{1,2})\/(\d{1,2})$/, (m) => buildDate(+m[1], +m[2], +m[3])], // %Y/%m/%d
  [
    /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{1,4})$/,
    (m) => {
      const i = MONTHS_ABBR.indexOf(m[1].toLowerCase());
      return i === -1 ? null : buildDate(+m[3], i + 1, +m[2]);
    },
  ], // %b %d, %Y
  [
    /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{1,4})$/,
    (m) => {
      const i = MONTHS_FULL.indexOf(m[1].toLowerCase());
      return i === -1 ? null : buildDate(+m[3], i + 1, +m[2]);
    },
  ], // %B %d, %Y
  [
    /^(\d{1,2})-([A-Za-z]{3})-(\d{1,4})$/,
    (m) => {
      const i = MONTHS_ABBR.indexOf(m[2].toLowerCase());
      return i === -1 ? null : buildDate(+m[3], i + 1, +m[1]);
    },
  ], // %d-%b-%Y
];

/**
 * Return an ISO `YYYY-MM-DD` date from a date cell, an Excel serial or a text date.
 *
 * An unreadable value raises rather than quietly becoming blank, because a
 * wrong date moves a line into or out of the reporting year.
 *
 * PARITY NOTE: the Python never sees a bare serial number because openpyxl has
 * already turned it into a date. ExcelJS and a CSV both can, so the number
 * branch is added here; it uses the same 1899-12-30 epoch openpyxl does.
 * A `Date` is read in UTC, which is what ExcelJS and SheetJS produce for a
 * date-formatted cell.
 */
export function coerceDate(value, where = "") {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail(`Missing order date${at(where)}.`);
    return isoDateUTC(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return excelSerialToISO(value);
  }
  const raw = cleanText(value);
  if (!raw) fail(`Missing order date${at(where)}.`);
  const text = raw.split("T")[0].trim();
  for (const [re, make] of TEXT_DATE_FORMATS) {
    const m = re.exec(text);
    if (m) {
      const out = make(m);
      if (out) return out;
    }
  }
  // A serial that arrived as text, e.g. "45678" straight out of a CSV export.
  if (/^\d+(\.\d+)?$/.test(text)) return excelSerialToISO(Number(text));
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.+-]*)?$/.exec(raw);
  if (iso) {
    const out = buildDate(+iso[1], +iso[2], +iso[3]);
    if (out) return out;
  }
  return fail(
    `Could not read ${pyRepr(raw)} as an order date${at(where)}. ` +
      "Expected a date cell or a date such as 2025-01-05 or 1/5/2025."
  );
}

/** Return a whole number from a quantity cell. */
export function coerceInt(value, where = "") {
  if (typeof value === "boolean") {
    fail(`Expected a quantity but found a true/false value${at(where)}.`);
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value;
    fail(`Quantity ${value} is not a whole number${at(where)}.`);
  }
  const text = cleanText(value).split(",").join("");
  if (!text) fail(`Missing quantity${at(where)}.`);
  const d = decParse(text);
  if (d === null) fail(`Could not read ${pyRepr(text)} as a quantity${at(where)}.`);
  if (!decIsIntegral(d)) fail(`Quantity ${text} is not a whole number${at(where)}.`);
  return decToInt(d);
}

/** Return a money amount as a plain decimal string, or "" when blank. */
export function coerceDecimal(value, where = "") {
  if (typeof value === "boolean") {
    fail(`Expected an amount but found a true/false value${at(where)}.`);
  }
  if (typeof value === "number") {
    const d = decParse(String(value));
    if (d === null) fail(`Could not read ${pyRepr(String(value))} as an amount${at(where)}.`);
    return decTrim(d);
  }
  let text = cleanText(value);
  if (!text) return "";
  const negative = text.startsWith("(") && text.endsWith(")");
  text = text.replace(/^[()]+/, "").replace(/[()]+$/, "");
  text = text.split("$").join("").split(",").join("").trim();
  if (!text) return "";
  const d = decParse(text);
  if (d === null) fail(`Could not read ${pyRepr(text)} as an amount${at(where)}.`);
  if (negative) d.neg = !d.neg;
  return decTrim(d);
}

// ===========================================================================
// difflib.SequenceMatcher.ratio()
//
// Used in two places that both affect output: the canonical-name suggestion in
// the review queue (>= 0.85) and the NEAR_DUPLICATE_NAMES warning (>= 0.9).
// The ratio itself is 2*M/T, which is bit-identical between the two languages
// on these small integers; the whole risk is in computing M, so the matching
// algorithm is ported line for line, autojunk included.
// ===========================================================================

function buildB2J(b, autojunk) {
  const b2j = new Map();
  for (let i = 0; i < b.length; i += 1) {
    const elt = b[i];
    let idxs = b2j.get(elt);
    if (!idxs) {
      idxs = [];
      b2j.set(elt, idxs);
    }
    idxs.push(i);
  }
  const n = b.length;
  if (autojunk && n >= 200) {
    const ntest = Math.floor(n / 100) + 1;
    const popular = [];
    for (const [elt, idxs] of b2j) {
      if (idxs.length > ntest) popular.push(elt);
    }
    for (const elt of popular) b2j.delete(elt);
  }
  return b2j;
}

function findLongestMatch(a, b, b2j, alo, ahi, blo, bhi) {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map();

  for (let i = alo; i < ahi; i += 1) {
    const newj2len = new Map();
    const idxs = b2j.get(a[i]);
    if (idxs) {
      for (const j of idxs) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }

  // isjunk is always None here, so bjunk is empty and only these two loops run.
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    besti -= 1;
    bestj -= 1;
    bestsize += 1;
  }
  while (
    besti + bestsize < ahi &&
    bestj + bestsize < bhi &&
    a[besti + bestsize] === b[bestj + bestsize]
  ) {
    bestsize += 1;
  }
  return [besti, bestj, bestsize];
}

/**
 * `difflib.SequenceMatcher(None, a, b).ratio()`.
 *
 * Argument order matters: the total match count is not reliably symmetric, so
 * every call site here passes its arguments in the same order the Python does.
 */
export function sequenceRatio(aStr, bStr) {
  const a = Array.from(String(aStr ?? ""));
  const b = Array.from(String(bStr ?? ""));
  const total = a.length + b.length;
  if (!total) return 1.0;

  const b2j = buildB2J(b, true);
  let matches = 0;
  const queue = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return (2.0 * matches) / total;
}

/**
 * Python's `f"{ratio:.2f}"`.
 *
 * `toFixed` rounds exact binary midpoints up where Python rounds to even, but
 * the only midpoint reachable at two decimals in the >= 0.85 band this is used
 * in is 0.875 = 7/8, where both produce "0.88". Asserted in the test suite so a
 * later refactor cannot break it silently.
 */
export function formatRatio(ratio) {
  return Number(ratio).toFixed(2);
}

// ===========================================================================
// Column orders (spec.md Appendix A)
// ===========================================================================

export const LINES_COLUMNS = [
  "source", "order_date", "order_id", "key", "raw_title", "sku", "pack_desc",
  "amazon_category", "packs", "ppu_paid", "line_subtotal", "account_user",
];

export const MASTER_COLUMNS = [
  "key", "source", "raw_title", "include", "canonical_name", "units_per_pack",
  "unit_label", "upp_source", "amazon_category", "first_seen", "last_seen", "note",
];

export const REVIEW_COLUMNS = [
  "key", "source", "raw_title", "amazon_category", "packs_in_year", "queue_reason",
  "include", "include_reason", "units_per_pack", "upp_candidates", "upp_reason",
  "canonical_name", "canonical_reason", "unit_label", "note",
];

export const RANKED_COLUMNS = [
  "rank", "canonical_name", "eaches", "packs", "units_per_pack", "unit_label",
  "keys", "sources", "last_paid_per_each", "upp_source",
];

export const EXCLUDED_COLUMNS = ["key", "source", "raw_title", "amazon_category", "packs", "reason"];

export const PRICES_HEADER = [
  "rank", "canonical_name", "vendor", "unit_price", "status", "url", "checked_on", "note",
];

export const VENDORS = ["Office Depot", "Preferred", "Amazon", "Staples"];
export const VALID_STATUSES = new Set(["priced", "not_available", "discontinued", "unpriced"]);

// The columns this tool actually reads, and the only ones an export must have.
// Amazon documents its report columns as user-selectable and reorderable, and
// the selectable list keeps growing, so a sheet is matched on these names
// alone: extra columns are ignored and position and count are never checked.
//
// Personal data must never be added to either required list. Account User
// Email, Payment Identifier and Payment Instrument Type are not read anywhere
// in this port. Account User is read, but only to copy into the account_user
// column of lines.csv, so it sits in AMAZON_OPTIONAL_COLUMNS and an export
// without it still ingests.
export const AMAZON_REQUIRED_COLUMNS = [
  "Order Date", "Order ID", "Order Status", "Amazon-Internal Product Category",
  "Title", "Item Quantity", "Purchase PPU",
];

export const PREFERRED_REQUIRED_COLUMNS = ["Code", "Description", "Pack", "Quan", "Order Date"];

// Read when present, blank when not. None of these decides whether a sheet is
// recognised, so losing one costs a column of detail and nothing else.
export const AMAZON_OPTIONAL_COLUMNS = ["Item Subtotal", "Account User"];
export const PREFERRED_OPTIONAL_COLUMNS = ["Customer Ref", "Contact Name"];

// The other Amazon Business reports, so picking the wrong one in the "Show"
// dropdown is named rather than reported as a pile of missing columns.
//
// Each marker list holds only headers that do NOT appear in the Orders report's
// own column set, and two of them must be present before a sheet is called that
// report. Sourcing, honestly: the Refunds and Returns markers come from Amazon's
// own Business Analytics guide and are solid; Return Status, Return Quantity and
// the Shipments markers were only corroborated by secondary write-ups, so they
// are deliberately narrow. The Reconciliation markers are the invoice and
// statement fields of the report Amazon launched in 2026; the legacy
// Reconciliation layout looks like Orders without the item columns and is not
// detected here on purpose, because every header it carries is also an Orders
// header and guessing would misread a trimmed Orders export.
export const SIBLING_REPORTS = [
  ["Refunds", ["Refund Date", "Refund Reason", "Refund Status", "Refund Type"]],
  ["Returns", ["Return Date", "Return Reason", "Return Status", "Return Quantity"]],
  ["Reconciliation", [
    "Statement Number", "Invoice Number", "Invoice Due Date", "Document Issue Date",
    "Document Status", "Credit Memo Number",
  ]],
  ["Shipments", ["Carrier Tracking #", "Delivery Status", "Shipment Tracking Number"]],
];

// How far down a sheet the header row is looked for, how many markers of one
// sibling report name that report, and how many columns of a signature make the
// failure talk about missing columns rather than an unrecognised sheet.
export const MAX_HEADER_SCAN = 10;
export const SIBLING_MIN_MARKERS = 2;
export const NEAR_MISS_MIN_COLUMNS = 2;

const AMAZON_REQUIRED = AMAZON_REQUIRED_COLUMNS.map(normHeader);
const PREFERRED_REQUIRED = PREFERRED_REQUIRED_COLUMNS.map(normHeader);
const AMAZON_OPTIONAL = AMAZON_OPTIONAL_COLUMNS.map(normHeader);
const PREFERRED_OPTIONAL = PREFERRED_OPTIONAL_COLUMNS.map(normHeader);

const SIGNATURES = [["amazon", AMAZON_REQUIRED], ["preferred", PREFERRED_REQUIRED]];
const VENDOR_LABELS = { amazon: "Amazon", preferred: "Preferred" };

// ------------------------------------------------- the report's carry sheets
//
// Ports supplytrack.ingest's carry-sheet block. The report workbook carries the
// item master and the price sheet on three sheets of its own, so next year only
// that workbook and the new export are needed. They are recognised by header
// signature, exactly as an export is.

export const ITEM_MASTER_REQUIRED_COLUMNS = ["key", "include", "units_per_pack", "canonical_name"];
export const PRICES_REQUIRED_COLUMNS = ["rank", "canonical_name", "vendor", "unit_price", "status"];

// The review queue carries all four item-master columns as well, so without
// this the queue file would be read as the item master and pull its blank
// include and units_per_pack values in. No item master has this column.
export const QUEUE_MARKER = "queue_reason";

// The report's own sheets, which are output and never input. Only "Top N"
// varies, by the top the report was built with.
export const REPORT_SHEET_NAMES = new Set(["all items", "excluded", "sources"]);
const TOP_SHEET_RE = /^top \d+$/;
export const REPORT_SHEET_REASON = "part of a previous report, not an input";

export const CARRY_LABELS = {
  item_master: "Item master",
  prices: "Prices",
  prices_retired: "Prices retired",
};
export const CARRY_COLUMNS = {
  item_master: MASTER_COLUMNS,
  prices: PRICES_HEADER,
  prices_retired: PRICES_HEADER,
};
export const INTEGER_COLUMNS = new Set(["units_per_pack", "packs_in_year", "rank"]);

// Modest, readable widths for the carry sheets, by column name. Anything not
// named here gets CARRY_WIDTH_DEFAULT.
export const CARRY_WIDTHS = {
  key: 34, source: 11, raw_title: 46, include: 9, canonical_name: 34,
  units_per_pack: 15, unit_label: 11, upp_source: 14, amazon_category: 24,
  first_seen: 12, last_seen: 12, note: 36,
  rank: 7, vendor: 14, unit_price: 12, status: 14, url: 40, checked_on: 12,
};
export const CARRY_WIDTH_DEFAULT = 16;

const ITEM_MASTER_REQUIRED = ITEM_MASTER_REQUIRED_COLUMNS.map(normHeader);
const PRICES_REQUIRED = PRICES_REQUIRED_COLUMNS.map(normHeader);
const QUEUE_MARKER_NORM = normHeader(QUEUE_MARKER);
// Prices and Prices retired share one signature; which of the two a sheet is
// comes from its name (see carryKind), because the two files hold the same
// columns by design.
const CARRY_SIGNATURES = [["item_master", ITEM_MASTER_REQUIRED], ["prices", PRICES_REQUIRED]];
export const EXPORT_KINDS = ["amazon", "preferred"];

// Matching is on normalised headers; messages name the column the way it is
// spelled in the export, because that is what somebody looking at the file sees.
const SPELLING = new Map(
  AMAZON_REQUIRED_COLUMNS.concat(PREFERRED_REQUIRED_COLUMNS).map((h) => [normHeader(h), h])
);

function spell(headers) {
  return headers.map((h) => SPELLING.get(h) || h).join(", ");
}

export const UNCONFIRMED_UPP_SOURCES = new Set(["title", "proposed"]);

export const INCLUDE_CATEGORIES = ["Office Product", "Business, Industrial, & Scientific Supplies Basic"];
export const EXCLUDE_CATEGORIES = [
  "Grocery", "Kitchen", "Apparel", "Home", "Sports", "Toys", "Pet Supplies", "Baby Product",
];
const INCLUDE_FOLDED = new Set(INCLUDE_CATEGORIES.map(casefold));
const EXCLUDE_FOLDED = new Set(EXCLUDE_CATEGORIES.map(casefold));

export const REASON_UNKNOWN = "unknown key";
export const REASON_MISSING = "pack size missing";
export const REASON_UNCONFIRMED = "pack size unconfirmed";
export const BLOCKING_REASONS = new Set([REASON_UNKNOWN, REASON_MISSING]);

const CANONICAL_MATCH = 0.85;
const NEAR_DUPLICATE = 0.9;
const SAMPLE = 8;
const UNPRICED_SAMPLE = 5;
const YES = ["y", "yes", "true", "1"];
const NO = ["n", "no", "false", "0"];

// ===========================================================================
// Keys
// ===========================================================================

/**
 * The title reduced to a stable matching form, used to build the key.
 *
 * Any change to this function changes every Amazon key, so it must stay
 * identical to the Python copy that seeded the master from the 2025 workbook.
 */
export function normaliseTitle(title) {
  let t = casefold(String(title ?? "").normalize("NFKC"));
  t = t.replace(/[^0-9a-z /\-.()]+/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

export function amazonKey(title) {
  return "amz:" + normaliseTitle(title);
}

export function preferredKey(code) {
  return "pbs:" + String(code ?? "").trim().toUpperCase();
}

// ===========================================================================
// Item master: row helpers and suggestions
// ===========================================================================

/** A master row with every column present as a string. */
export function makeMasterRow(fields = {}) {
  const row = {};
  for (const c of MASTER_COLUMNS) row[c] = fields[c] == null ? "" : String(fields[c]);
  return row;
}

export function masterIncluded(row) {
  return row ? YES.includes(casefold(String(row.include ?? "").trim())) : false;
}

export function masterUppUnconfirmed(row) {
  return row ? UNCONFIRMED_UPP_SOURCES.has(casefold(String(row.upp_source ?? "").trim())) : false;
}

/** The pack size as a whole number, or null when missing or not one. */
export function masterUnitsPerPackInt(row) {
  const text = String((row && row.units_per_pack) || "").trim();
  if (!text) return null;
  const value = pyFloat(text);
  if (Number.isNaN(value)) return null;
  // PARITY NOTE: Python raises OverflowError on `int(inf)` here; returning null
  // is what the docstring says the function does, and what every caller wants.
  if (!Number.isFinite(value)) return null;
  if (value <= 0 || value !== Math.trunc(value)) return null;
  return Math.trunc(value);
}

/** Decode a Preferred pack code: `CT10` -> 10, `BX100` -> 100, `Each` -> 1. */
export function decodePreferredPack(pack) {
  const text = String(pack ?? "").trim();
  if (!text) return null;
  const folded = casefold(text);
  if (folded === "each" || folded === "ea" || folded === "ea." || folded === "1") return 1;
  const m = /^([A-Za-z]{0,3})[ \t\n\r\f\v]*(\d{1,6})$/.exec(text);
  if (m) {
    const value = parseInt(m[2], 10);
    return value > 0 ? value : null;
  }
  return null;
}

// Each pattern carries a priority so that when two of them find the same number
// the more specific phrase is the one shown to the reviewer.
const PY_W = "[\\p{L}\\p{N}_]";
const UPP_PATTERNS = [
  [0, "(\\d{1,6})\\s*reams?\\s*(?:/|per\\s+)\\s*carton\\b"],
  [1, "(?:packs?|box(?:es)?|case|carton|set|sleeve|bundle|bag)\\s+of\\s+(\\d{1,6})\\b"],
  [2, "(\\d{1,6})\\s*(?:-|/)?\\s*(?:packs?|pks?|counts?|ct|cnt)\\b"],
  [3, "(\\d{1,6})\\s*(?:/|per\\s+)\\s*(?:box|bx|case|carton)\\b"],
  [
    4,
    "(\\d{1,6})\\s+(?:[A-Za-z](?:" + PY_W + "|['’\\-])*\\s+){0,3}?" +
      "(?:sheets|labels|inserts|tags|pads|boxes|reams|rolls|envelopes|folders|" +
      "sleeves|pieces|tablets|cards|notes|pouches|binders|dividers)\\b",
  ],
];
const UPP_COMPILED = UPP_PATTERNS.map(([p, rx]) => [p, new RegExp(rx, "giud")]);

const MEASUREMENT_WORDS = new Set([
  "inch", "inches", "in", "mm", "cm", "m", "ft", "feet", "foot", "yd", "yard",
  "lb", "lbs", "pound", "pounds", "oz", "ounce", "ounces", "fl", "ml", "l", "gal",
  "gsm", "ply", "mil", "mils", "gauge", "pt", "point", "watt", "watts", "v", "volt",
  "mah", "amp", "sided", "side", "x", "ring", "rings", "tab", "tabs", "divider",
  "dividers", "hole", "holes", "page", "pages", "page-yield", "yield", "degree",
  "degrees", "percent", "year", "years", "month", "months", "day", "days",
]);
const MEASUREMENT_MARKS = new Set(['"', "'", "″", "′"]);

const PACK_PHRASE_WORDS = new Set([
  "pack", "packs", "pk", "pks", "count", "counts", "ct", "cnt", "pad", "pads",
  "box", "boxes", "bx", "carton", "cartons", "case", "set", "sets", "dozen",
  "pcs", "piece", "pieces", "roll", "rolls", "cartridge", "cartridges",
  "label", "labels", "insert", "inserts", "tag", "tags", "card", "cards",
  "envelope", "envelopes", "folder", "folders", "notebook", "notebooks",
  "pen", "pens", "marker", "markers", "bundle", "sleeve", "sleeves",
]);
const WORD_RE = /[A-Za-z][A-Za-z'’\-]*/g;

/** True when the phrase counts purchase units rather than describing one. */
export function isPackPhrase(phrase) {
  const words = String(phrase ?? "").match(WORD_RE) || [];
  return words.some((w) => PACK_PHRASE_WORDS.has(casefold(w)));
}

/** True when this number is a size, a model number or half a dimension. */
function isMeasurement(text, numStart, numEnd) {
  const before = text.slice(0, numStart);
  const after = text.slice(numEnd);

  if (/[A-Za-z]$/.test(before)) return true;
  if (before.endsWith("(") && after.startsWith(")")) return true;
  if (/(?:^|[\s(])[x×]\s*$/i.test(before)) return true;
  if (/^\s*[x×](?:\s|$)/i.test(after)) return true;
  if (/\d\.$/.test(before)) return true;

  const m = /^\s*[-–]?\s*("|'|″|′|[A-Za-z][A-Za-z'’\-]*)/.exec(after);
  if (m) {
    const token = m[1];
    if (MEASUREMENT_MARKS.has(token)) return true;
    if (MEASUREMENT_WORDS.has(casefold(token).replace(/\.+$/, ""))) return true;
  }
  return false;
}

function tidy(phrase) {
  let s = String(phrase ?? "").replace(/\s+/g, " ");
  s = s.replace(/^[ ,;-]+/, "").replace(/[ ,;-]+$/, "");
  return s;
}

/** Pack sizes the title appears to state, as [value, phrase], in title order. */
export function uppCandidates(title) {
  const text = String(title ?? "");
  if (!text.trim()) return [];

  const hits = []; // [start, priority, value, phrase, order]
  for (const [priority, rx] of UPP_COMPILED) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(text)) !== null) {
      const value = parseInt(m[1], 10);
      if (!Number.isFinite(value)) continue;
      if (!(value > 0 && value <= 100000)) continue;
      const span = m.indices[1];
      if (isMeasurement(text, span[0], span[1])) continue;
      hits.push([m.index, priority, value, tidy(m[0]), hits.length]);
    }
  }

  hits.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[4] - y[4]);
  const out = [];
  const seen = new Set();
  for (const [, , value, phrase] of hits) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push([value, phrase]);
  }
  return out;
}

/** Propose `y` / `n` / blank for a new item, with the reason why. */
export function suggestInclude(amazonCategory, source) {
  if (casefold(String(source ?? "").trim()) === "preferred") {
    return ["y", "Preferred is an office-supply vendor"];
  }
  const category = String(amazonCategory ?? "").trim();
  const folded = casefold(category.replace(/\s+/g, " "));
  if (INCLUDE_FOLDED.has(folded)) return ["y", `category ${category} is an office-supply category`];
  if (EXCLUDE_FOLDED.has(folded)) return ["n", `category ${category} is not an office supply`];
  if (!category) return ["", "no Amazon category on this line, needs a decision"];
  return ["", `category ${category} needs a decision`];
}

export function normaliseCategory(category) {
  return casefold(String(category ?? "").trim().replace(/\s+/g, " "));
}

export function categoryIsKnown(category) {
  const folded = normaliseCategory(category);
  return INCLUDE_FOLDED.has(folded) || EXCLUDE_FOLDED.has(folded);
}

export function categoryExpectedInclude(category) {
  const folded = normaliseCategory(category);
  if (INCLUDE_FOLDED.has(folded)) return "y";
  if (EXCLUDE_FOLDED.has(folded)) return "n";
  return "";
}

// ===========================================================================
// Stage 1: ingest
// ===========================================================================

/**
 * Normalise a raw table the way `xlsx.read_table` does.
 *
 * First row is the header and comes back case-folded and whitespace-collapsed;
 * blank rows are dropped and short rows are padded to the header width.
 *
 * @param {Array<Array<unknown>>} table
 * @returns {{headers: string[], body: Array<Array<unknown>>}}
 */
export function normaliseTable(table, name = "the export") {
  const rows = Array.isArray(table) ? table : [];
  if (!rows.length) fail(`${name} is empty - there is no header row to read.`);
  return normaliseGrid(rows, 0);
}

/**
 * Split a raw grid into {headers, body} at `headerRow`.
 *
 * Rows above the header row are dropped, blank rows are dropped and short rows
 * are padded to the header width. Ports supplytrack.xlsx.normalise_grid.
 *
 * @param {Array<Array<unknown>>} rows
 * @param {number} headerRow
 */
export function normaliseGrid(rows, headerRow = 0) {
  const headers = (rows[headerRow] || []).map(normHeader);
  const width = headers.length;
  const body = [];
  for (const raw of rows.slice(headerRow + 1)) {
    const row = Array.from(raw || []);
    if (!row.some((c) => c != null && String(c).trim() !== "")) continue;
    while (row.length < width) row.push(null);
    body.push(row);
  }
  return { headers, body };
}

/** The first `limit` rows of a grid, each normalised as a header row. */
export function scanHeaders(grid, limit = MAX_HEADER_SCAN) {
  return grid.slice(0, limit).map((row) => (row || []).map(normHeader));
}

function headerIndex(headers, name, required, optional = []) {
  const index = new Map();
  headers.forEach((h, i) => {
    if (h && !index.has(h)) index.set(h, i);
  });
  const missing = required.filter((h) => !index.has(h));
  if (missing.length) {
    fail(
      `${name} is missing ${missing.length} required column(s): ` +
        spell(missing) +
        ". Check that this is the full order-history export and not a filtered view."
    );
  }
  const out = new Map();
  for (const h of required) out.set(h, index.get(h));
  for (const h of optional) if (index.has(h)) out.set(h, index.get(h));
  return out;
}

// =========================================================================
// Sheet recognition
// =========================================================================

/**
 * How one sheet is named in a message: the file, and the sheet if it has one.
 *
 * Python writes the sheet name with `repr`, so the two sides say the same
 * thing about the same file; every sheet name this tool meets is plain text,
 * where repr is a single-quoted string with backslashes and quotes escaped.
 */
export function sheetLabel(file, sheet) {
  if (!sheet) return String(file);
  const quoted = String(sheet).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `${file} sheet '${quoted}'`;
}

/** Every row of one export reduced to the columns that identify it. */
function rowSignature(exportSheet, required) {
  const index = new Map();
  exportSheet.headers.forEach((h, i) => {
    if (h && !index.has(h)) index.set(h, i);
  });
  const columns = required.map((h) => index.get(h));
  const counts = new Map();
  for (const row of exportSheet.body) {
    const key = JSON.stringify(columns.map((i) => (i < row.length ? cleanText(row[i]) : "")));
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function contains(big, small) {
  for (const [key, count] of small) if ((big.get(key) || 0) < count) return false;
  return true;
}

function sameCounts(a, b) {
  return a.size === b.size && contains(a, b) && contains(b, a);
}

/**
 * The one export that holds every row of the others, if there is one.
 *
 * The working workbook keeps a filtered copy of the Amazon export beside the
 * raw one - the office manager's own "office supplies only" sheet. Both carry
 * the export's columns, so both are recognised, and reading either one twice
 * would double the lines. When one sheet strictly contains every row of the
 * others it is the export and they are views of it, which is a fact about the
 * rows rather than a guess from sheet names or row counts. Two sheets that hold
 * the same rows, or that each hold rows the other does not, are a real
 * ambiguity and the caller refuses them.
 */
function pickFullExport(found, required) {
  const counts = found.map((e) => rowSignature(e, required));
  const winners = found.filter((_, i) =>
    counts.every((small, j) => j === i || (contains(counts[i], small) && !sameCounts(counts[i], small)))
  );
  return winners.length === 1 ? winners[0] : null;
}

/**
 * The first row that is a header row, and which of the five kinds it is.
 *
 * Export signatures are tried first, so nothing about the carry sheets can
 * change how an order export is recognised.
 */
function matchSignature(grid, file = "", sheet = "") {
  const scanned = scanHeaders(grid);
  for (let rowNumber = 0; rowNumber < scanned.length; rowNumber += 1) {
    const present = new Set(scanned[rowNumber].filter(Boolean));
    for (const [vendor, required] of SIGNATURES) {
      if (required.every((h) => present.has(h))) return { kind: vendor, headerRow: rowNumber };
    }
    for (const [kind, required] of CARRY_SIGNATURES) {
      if (!required.every((h) => present.has(h))) continue;
      if (kind === "item_master" && present.has(QUEUE_MARKER_NORM)) continue;
      return { kind: carryKind(kind, file, sheet), headerRow: rowNumber };
    }
  }
  return null;
}

/**
 * Prices or Prices retired: the same columns, told apart by the name.
 *
 * The two files hold the same columns on purpose, so there is nothing in the
 * rows to tell them apart. The sheet name says which it is in a report
 * workbook; a .csv has no sheet name at all, so the file name is read for a
 * dropped prices_retired.csv.
 */
function carryKind(kind, file, sheet) {
  if (kind !== "prices") return kind;
  return casefold(`${sheet} ${file}`).includes("retired") ? "prices_retired" : "prices";
}

/** True for the report's own output sheets, which are never an input. */
function isReportSheet(sheet) {
  const name = normHeader(sheet);
  return REPORT_SHEET_NAMES.has(name) || TOP_SHEET_RE.test(name);
}

/** Every header-shaped value in the rows the scan looked at. */
function scannedHeaders(grid) {
  const seen = new Set();
  for (const headers of scanHeaders(grid)) for (const h of headers) if (h) seen.add(h);
  return seen;
}

function siblingReport(grid) {
  const present = scannedHeaders(grid);
  for (const [name, markers] of SIBLING_REPORTS) {
    const hits = markers.filter((m) => present.has(normHeader(m)));
    if (hits.length >= SIBLING_MIN_MARKERS) return name;
  }
  return null;
}

/** The signature this sheet came closest to, and what it is missing. */
function nearMiss(grid) {
  const present = scannedHeaders(grid);
  let best = null;
  for (const [vendor, required] of SIGNATURES) {
    const found = required.filter((h) => present.has(h));
    if (found.length < NEAR_MISS_MIN_COLUMNS) continue;
    const missing = required.filter((h) => !present.has(h));
    if (best === null || found.length > best.found) best = { found: found.length, vendor, missing };
  }
  return best;
}

/**
 * Why one sheet was passed over, in the words the page and the CLI show.
 *
 * The report's own sheets are named first, by name: they hold finished output
 * and there is nothing useful to say about their columns. A sibling Amazon
 * report comes next, because it is the most specific thing that can be said and
 * it also carries Order Date and Order ID, so the missing-column wording would
 * otherwise take over and hide the real problem.
 */
function ignoreReason(grid, sheet = "") {
  if (isReportSheet(sheet)) return REPORT_SHEET_REASON;
  const sibling = siblingReport(grid);
  if (sibling) return `this is the Amazon ${sibling} report, not the Orders report`;
  const near = nearMiss(grid);
  if (near) {
    return (
      `looks like the ${VENDOR_LABELS[near.vendor]} export but is missing ` +
      `${near.missing.length} required column(s): ` + spell(near.missing)
    );
  }
  return "not an order export";
}

/**
 * The failure when no sheet in any file was an export.
 *
 * The sibling and missing-column cases are only raised here, once nothing has
 * been recognised anywhere. A Refunds sheet sitting beside a good Orders sheet
 * is a sheet to skip, not a reason to stop.
 */
function failNothingRecognised(skipped) {
  for (const { sheet, grid } of skipped) {
    const sibling = siblingReport(grid);
    if (sibling) {
      fail(
        `${sheetLabel(sheet.file, sheet.sheet)}: this is the Amazon ${sibling} report. ` +
          "Export the Orders report instead."
      );
    }
  }
  for (const { sheet, grid } of skipped) {
    const near = nearMiss(grid);
    if (near) {
      fail(
        `${sheetLabel(sheet.file, sheet.sheet)} looks like the ${VENDOR_LABELS[near.vendor]} ` +
          `export but is missing ${near.missing.length} required column(s): ` +
          spell(near.missing) +
          ". Check that this is the full order-history export and not a filtered view."
      );
    }
  }
  const listing =
    skipped.map(({ sheet }) => sheetLabel(sheet.file, sheet.sheet)).join(", ") || "no sheets at all";
  fail(
    "No order export was found in what you gave the tool. Looked at: " +
      listing +
      ". An Amazon Orders export needs the columns " +
      AMAZON_REQUIRED_COLUMNS.join(", ") +
      ". A Preferred export needs the columns " +
      PREFERRED_REQUIRED_COLUMNS.join(", ") +
      "."
  );
}

/**
 * Sort raw sheets into the exports this tool reads and the ones it skips.
 *
 * `sources` is `{file, sheet, grid}` per sheet, in the order the files were
 * given. A sheet is an export when its header row carries every required column
 * of one signature; the header row is looked for in the first MAX_HEADER_SCAN
 * rows, because a sheet somebody pasted an export into often has a title line
 * above it. Ports supplytrack.ingest.classify_grids.
 *
 * @returns {{recognised: object[], ignored: object[]}}
 */
export function classifyGrids(sources, { requireExport = true } = {}) {
  const recognised = [];
  const ignored = [];
  const skipped = [];

  for (const source of sources || []) {
    const grid = Array.isArray(source.grid) ? source.grid : [];
    const file = source.file == null ? "" : String(source.file);
    const sheet = source.sheet == null ? "" : String(source.sheet);
    const match = matchSignature(grid, file, sheet);
    if (!match) {
      const entry = { file, sheet, reason: ignoreReason(grid, sheet) };
      ignored.push(entry);
      skipped.push({ sheet: entry, grid });
      continue;
    }
    const { headers, body } = normaliseGrid(grid, match.headerRow);
    const kind = match.kind;
    recognised.push({
      kind,
      vendor: EXPORT_KINDS.includes(kind) ? kind : "",
      file,
      sheet,
      headers,
      body,
    });
  }

  // A carry table is one table, not something spread over several files, so a
  // second one is a copy rather than something to merge: the first is read and
  // the rest are named. The strict-subset rule below is for exports only.
  for (const kind of Object.keys(CARRY_LABELS)) {
    const found = recognised.filter((e) => e.kind === kind);
    for (const other of found.slice(1)) {
      recognised.splice(recognised.indexOf(other), 1);
      ignored.push({
        file: other.file,
        sheet: other.sheet,
        reason:
          `a second ${CARRY_LABELS[kind]} table; ` +
          `${sheetLabel(found[0].file, found[0].sheet)} was read instead`,
      });
    }
  }

  for (const [vendor, required] of SIGNATURES) {
    const found = recognised.filter((e) => e.kind === vendor);
    if (found.length < 2) continue;
    const full = pickFullExport(found, required);
    if (!full) {
      fail(
        `Found ${found.length} ${VENDOR_LABELS[vendor]} exports and cannot tell which one ` +
          "to use: " +
          found.map((e) => sheetLabel(e.file, e.sheet)).join(", ") +
          ". Remove the copies you do not want and try again."
      );
    }
    for (const other of found) {
      if (other === full) continue;
      recognised.splice(recognised.indexOf(other), 1);
      ignored.push({
        file: other.file,
        sheet: other.sheet,
        reason: `a filtered view of ${sheetLabel(full.file, full.sheet)}, ` +
          "which this tool reads in full",
      });
    }
  }

  if (requireExport && !recognised.some((e) => EXPORT_KINDS.includes(e.kind))) {
    if (recognised.length) {
      fail(
        "The only thing recognised was a previous report workbook: " +
          recognised
            .map((e) => `${CARRY_LABELS[e.kind]} on ${sheetLabel(e.file, e.sheet)}`)
            .join(", ") +
          ". That carries the item master and the prices forward but holds no order " +
          "lines, so hand over this year's order export as well."
      );
    }
    failNothingRecognised(skipped);
  }
  return { recognised, ignored };
}

/** classifyGrids over files as the page holds them: {file, sheets:[{name, grid}]}. */
export function classifyFiles(files, options = {}) {
  const sources = [];
  for (const entry of files || []) {
    for (const sheet of entry.sheets || []) {
      sources.push({ file: entry.file, sheet: sheet.name || "", grid: sheet.grid });
    }
  }
  return classifyGrids(sources, options);
}

/**
 * One carry sheet's rows as text, in the column order of the file it came from.
 * Ports supplytrack.ingest.carry_rows.
 *
 * Only the columns that file has are read, so an extra column somebody added on
 * the sheet is dropped rather than carried into a file whose shape the rest of
 * the pipeline depends on. Every value comes back as text: csvText turns the
 * numbers the integer columns are written as back into canonical integer
 * strings (12, never 12.0) and a blank cell into "".
 */
export function carryRows(sheet) {
  const columns = CARRY_COLUMNS[sheet.kind];
  if (!columns) return [];
  const index = new Map();
  sheet.headers.forEach((h, i) => {
    if (h && !index.has(h)) index.set(h, i);
  });
  return sheet.body.map((row) => {
    const out = {};
    for (const column of columns) {
      if (!index.has(column)) continue;
      const i = index.get(column);
      out[column] = csvText(i < row.length ? row[i] : null);
    }
    return out;
  });
}

function cellAt(row, index, header) {
  const i = index.get(header);
  if (i == null || i >= row.length) return null;
  return row[i];
}

function summarise(name, notes, year) {
  const warnings = [];
  if (notes.dates_out_of_year.length) {
    const sample = notes.dates_out_of_year
      .slice(0, 5)
      .map((d) => `${d.order_id || "(no order id)"} on ${d.order_date}`)
      .join(", ");
    warnings.push(
      `${name}: ${notes.dates_out_of_year.length} line(s) are dated outside ${year}: ${sample}`
    );
  }
  if (notes.non_closed.length) {
    const sample = notes.non_closed
      .slice(0, 5)
      .map((d) => `${d.order_id || "(no order id)"} is ${d.status}`)
      .join(", ");
    warnings.push(
      `${name}: ${notes.non_closed.length} line(s) have a status other than Closed: ${sample}`
    );
  }
  return warnings;
}

function readAmazon(exportSheet, year) {
  const { headers, body } = exportSheet;
  const label = sheetLabel(exportSheet.file, exportSheet.sheet);
  const name = exportSheet.file;
  const index = headerIndex(headers, label, AMAZON_REQUIRED, AMAZON_OPTIONAL);
  const notes = { warnings: [], dates_out_of_year: [], non_closed: [] };
  const rows = [];

  body.forEach((raw, offset) => {
    const where = `${label} row ${offset + 2}`;
    const title = cleanText(cellAt(raw, index, normHeader("Title")));
    if (!title) {
      fail(
        `${where} has no Title, so the line cannot be identified. ` +
          "Re-export the order history; a blank title usually means a truncated download."
      );
    }
    const orderDate = coerceDate(cellAt(raw, index, normHeader("Order Date")), where);
    const orderId = cleanText(cellAt(raw, index, normHeader("Order ID")));
    const status = cleanText(cellAt(raw, index, normHeader("Order Status")));
    const category = cleanText(cellAt(raw, index, normHeader("Amazon-Internal Product Category")));

    rows.push({
      source: "amazon",
      order_date: orderDate,
      order_id: orderId,
      key: amazonKey(title),
      raw_title: title,
      sku: "",
      pack_desc: "",
      amazon_category: category,
      packs: coerceInt(cellAt(raw, index, normHeader("Item Quantity")), where),
      ppu_paid: coerceDecimal(cellAt(raw, index, normHeader("Purchase PPU")), where),
      line_subtotal: coerceDecimal(cellAt(raw, index, normHeader("Item Subtotal")), where),
      account_user: cleanText(cellAt(raw, index, normHeader("Account User"))),
    });

    if (!orderDate.startsWith(`${year}-`)) {
      notes.dates_out_of_year.push({
        source: "amazon", order_id: orderId, order_date: orderDate, title,
      });
    }
    if (status && casefold(status) !== "closed") {
      notes.non_closed.push({ source: "amazon", order_id: orderId, status, title });
    }
  });

  notes.warnings = summarise(name, notes, year);
  return { rows, notes };
}

function readPreferred(exportSheet, year) {
  const { headers, body } = exportSheet;
  const label = sheetLabel(exportSheet.file, exportSheet.sheet);
  const name = exportSheet.file;
  const index = headerIndex(headers, label, PREFERRED_REQUIRED, PREFERRED_OPTIONAL);
  const notes = { warnings: [], dates_out_of_year: [], non_closed: [] };
  const rows = [];

  body.forEach((raw, offset) => {
    const where = `${label} row ${offset + 2}`;
    const code = cleanText(cellAt(raw, index, normHeader("Code")));
    if (!code) {
      fail(
        `${where} has no Code, so the line cannot be identified. ` +
          "Ask Preferred to re-send the history with the item codes included."
      );
    }
    const orderDate = coerceDate(cellAt(raw, index, normHeader("Order Date")), where);
    const orderId = cleanText(cellAt(raw, index, normHeader("Customer Ref")));

    rows.push({
      source: "preferred",
      order_date: orderDate,
      order_id: orderId,
      key: preferredKey(code),
      raw_title: cleanText(cellAt(raw, index, normHeader("Description"))),
      sku: code,
      pack_desc: cleanText(cellAt(raw, index, normHeader("Pack"))),
      amazon_category: "",
      packs: coerceInt(cellAt(raw, index, normHeader("Quan")), where),
      ppu_paid: "",
      line_subtotal: "",
      account_user: cleanText(cellAt(raw, index, normHeader("Contact Name"))),
    });

    if (!orderDate.startsWith(`${year}-`)) {
      notes.dates_out_of_year.push({
        source: "preferred", order_id: orderId, order_date: orderDate, title: code,
      });
    }
  });

  notes.warnings = summarise(name, notes, year);
  return { rows, notes };
}

/** One line of run.json's `exports`: where it came from and what it held. */
function exportRecord(exportSheet, rows) {
  const dates = rows.map((r) => r.order_date).filter(Boolean).sort(cmpCodePoint);
  return {
    vendor: exportSheet.vendor,
    file: exportSheet.file,
    sheet: exportSheet.sheet,
    rows: rows.length,
    date_min: dates.length ? dates[0] : "",
    date_max: dates.length ? dates[dates.length - 1] : "",
  };
}

/**
 * Turn the vendor exports into one normalised line list plus a run record.
 *
 * Takes `files`, one entry per uploaded file with every sheet it holds, and
 * picks the Amazon and Preferred exports out by their columns; either export
 * on its own is enough to run. The older `amazonTable` / `preferredTable`
 * form still works and is treated as one file holding one unnamed sheet.
 *
 * Nothing is dropped: a line outside the year or with an unusual order status
 * is kept and listed, never filtered away, because the count of lines written
 * has to match the count read for the later checks to mean anything.
 *
 * @param {object} args
 * @param {Array<{file: string, sheets: Array<{name: string, grid: Array<Array<unknown>>}>}>} [args.files]
 * @param {Array<Array<unknown>>} [args.amazonTable]  header row + rows
 * @param {Array<Array<unknown>>} [args.preferredTable]
 * @param {number|string} args.year
 * @param {string} [args.amazonFile]      name used in messages and run.json
 * @param {string} [args.preferredFile]
 * @param {string} [args.now]             ISO timestamp for `ingested_at`
 * @returns {{lines: object[], run: object, warnings: string[]}}
 */
export function ingest({
  files = null,
  amazonTable = null,
  preferredTable = null,
  year,
  amazonFile = "amazon.xlsx",
  preferredFile = "preferred.xlsx",
  now = null,
} = {}) {
  const yearNum = parseInt(year, 10);

  let given = files;
  if (!given) {
    given = [];
    if (amazonTable) given.push({ file: amazonFile, sheets: [{ name: "", grid: amazonTable }] });
    if (preferredTable) {
      given.push({ file: preferredFile, sheets: [{ name: "", grid: preferredTable }] });
    }
  }
  if (!given.length) {
    fail("No export file was given. Pass the workbook or .csv holding the order history.");
  }

  const { recognised, ignored } = classifyFiles(given);
  const amazonExport = recognised.find((e) => e.vendor === "amazon") || null;
  const preferredExport = recognised.find((e) => e.vendor === "preferred") || null;

  const noNotes = () => ({ warnings: [], dates_out_of_year: [], non_closed: [] });
  const amazon = amazonExport
    ? readAmazon(amazonExport, yearNum)
    : { rows: [], notes: noNotes() };
  const preferred = preferredExport
    ? readPreferred(preferredExport, yearNum)
    : { rows: [], notes: noNotes() };

  // Amazon lines always come before Preferred lines, whatever order the files
  // or sheets arrived in, so the line file does not depend on how the exports
  // were handed over.
  const lines = amazon.rows.concat(preferred.rows);
  if (!lines.length) {
    fail(
      "Neither export contained any order lines. Check that the files cover the year " +
        "you asked for and were exported with their header row."
    );
  }

  const dates = lines.map((r) => r.order_date).filter(Boolean).sort(cmpCodePoint);
  const warnings = amazon.notes.warnings.concat(preferred.notes.warnings);
  const pairs = [[amazonExport, amazon.rows], [preferredExport, preferred.rows]];
  const run = {
    year: yearNum,
    amazon_file: amazonExport ? amazonExport.file : "",
    preferred_file: preferredExport ? preferredExport.file : "",
    amazon_rows: amazon.rows.length,
    preferred_rows: preferred.rows.length,
    date_min: dates.length ? dates[0] : "",
    date_max: dates.length ? dates[dates.length - 1] : "",
    ingested_at: now == null ? new Date().toISOString().replace(/\.\d+Z$/, "+00:00") : now,
    rows_written: amazon.rows.length + preferred.rows.length,
    warnings,
    dates_out_of_year: amazon.notes.dates_out_of_year.concat(preferred.notes.dates_out_of_year),
    non_closed: amazon.notes.non_closed.concat(preferred.notes.non_closed),
    // Added after the first release, so everything above keeps its name and
    // place: which sheet of which file each export came from, which vendors the
    // run covers (one vendor alone is a valid run and says so here), and every
    // sheet that was passed over with the reason.
    exports: pairs.filter(([e]) => e).map(([e, rows]) => exportRecord(e, rows)),
    vendors: pairs.filter(([e]) => e).map(([e]) => e.vendor),
    ignored,
  };
  return { lines, run, warnings, ignored, exports: run.exports };
}

// ===========================================================================
// Stage 2: the review queue
// ===========================================================================

function queueReason(known) {
  if (!known) return REASON_UNKNOWN;
  if (!masterIncluded(known)) return "";
  if (masterUnitsPerPackInt(known) === null) return REASON_MISSING;
  if (UNCONFIRMED_UPP_SOURCES.has(casefold(String(known.upp_source ?? "").trim()))) {
    return REASON_UNCONFIRMED;
  }
  return "";
}

function candidateText(entry, title = "") {
  const hits = uppCandidates(title || entry.raw_title);
  return hits.map(([value, phrase]) => `${value} (${phrase})`).join("|");
}

function suggestUnits(entry, title = "") {
  const hits = uppCandidates(title || entry.raw_title);
  const candidates = hits.map(([value, phrase]) => `${value} (${phrase})`).join("|");

  if (entry.source === "preferred") {
    const decoded = decodePreferredPack(entry.pack_desc);
    if (decoded !== null) {
      return [
        String(decoded),
        candidates,
        `Preferred pack code ${entry.pack_desc} means ${decoded} per purchase unit`,
      ];
    }
    if (entry.pack_desc) {
      return [
        "",
        candidates,
        `pack code ${entry.pack_desc} is not one this tool knows; check the invoice`,
      ];
    }
  }

  const values = new Set(hits.map(([v]) => v));
  if (values.size === 1) {
    const [value, phrase] = hits[0];
    return [String(value), candidates, `the title says "${phrase}"`];
  }
  if (values.size > 1) {
    return [
      "",
      candidates,
      `the title states ${values.size} different numbers; ` +
        "enter how many units come in one purchase unit",
    ];
  }
  return ["", "", "no pack size in the title; check the listing or enter 1 if it is sold singly"];
}

function suggestCanonical(title, knownNames) {
  let bestName = "";
  let bestRatio = 0.0;
  const folded = casefold(title);
  for (const name of knownNames) {
    const ratio = sequenceRatio(folded, casefold(name));
    if (ratio > bestRatio) {
      bestName = name;
      bestRatio = ratio;
    }
  }
  if (bestName && bestRatio >= CANONICAL_MATCH) {
    return [bestName, `close to the existing item "${bestName}" (${formatRatio(bestRatio)})`];
  }
  return [title, "no close match to an existing item, so the title becomes the name"];
}

function suggestUnitLabel(title) {
  return /\breams?\b/i.test(String(title ?? "")) ? "RM" : "EA";
}

function suggestRow(entry, reason, known, knownNames) {
  const title = (known && known.raw_title ? known.raw_title : entry.raw_title) || "";
  const category = entry.amazon_category || (known ? known.amazon_category : "");

  let include, includeReason, units, candidates, uppReason, canonical, canonicalReason, unitLabel, note;

  if (!known) {
    [include, includeReason] = suggestInclude(category, entry.source);
    [units, candidates, uppReason] = suggestUnits(entry);
    [canonical, canonicalReason] = suggestCanonical(title, knownNames);
    unitLabel = suggestUnitLabel(title);
    note = "";
  } else {
    include = known.include || "y";
    includeReason = "already in the item master";
    candidates = candidateText(entry, title);
    canonical = known.canonical_name || title;
    canonicalReason = "the name already in the item master";
    unitLabel = known.unit_label || suggestUnitLabel(title);
    note = known.note;
    if (reason === REASON_MISSING) {
      [units, candidates, uppReason] = suggestUnits(entry, title);
    } else {
      units = known.units_per_pack;
      uppReason =
        `${units} came from ${known.upp_source || "an unknown source"} and nobody has ` +
        "confirmed it; leave it to accept, or correct it";
    }
  }

  return {
    key: entry.key,
    source: entry.source,
    raw_title: title,
    amazon_category: category,
    packs_in_year: entry.packs_in_year,
    queue_reason: reason,
    include,
    include_reason: includeReason,
    units_per_pack: units,
    upp_candidates: candidates,
    upp_reason: uppReason,
    canonical_name: canonical,
    canonical_reason: canonicalReason,
    unit_label: unitLabel,
    note,
  };
}

/**
 * Everything still waiting on a person, blocking rows first.
 *
 * `master` must be a Map in the order the item master file holds (sorted by
 * key, which is how the CLI writes it): the canonical-name suggestion walks
 * existing names in that order and keeps the first at the best ratio, so a
 * different iteration order produces different suggestions.
 *
 * @param {{lines: object[], master: Map<string,object>, year: number|string}} args
 * @returns {{queueRows: object[], counts: {blocking: number, unconfirmed: number},
 *            reasonCounts: Record<string, number>}}
 */
export function buildQueue({ lines, master, year } = {}) {
  const m = asMasterMap(master);
  const seen = new Map();
  for (const row of lines || []) {
    const key = row.key;
    let entry = seen.get(key);
    if (!entry) {
      entry = {
        key,
        source: row.source,
        raw_title: row.raw_title,
        amazon_category: row.amazon_category,
        pack_desc: row.pack_desc,
        packs_in_year: 0,
      };
      seen.set(key, entry);
    }
    entry.packs_in_year += Number(row.packs);
    if (!entry.amazon_category && row.amazon_category) entry.amazon_category = row.amazon_category;
    if (!entry.pack_desc && row.pack_desc) entry.pack_desc = row.pack_desc;
  }

  const pending = [];
  for (const entry of seen.values()) {
    const known = m.get(entry.key) || null;
    const reason = queueReason(known);
    if (reason) pending.push([entry, reason, known]);
  }

  const knownNames = [];
  for (const row of m.values()) {
    if (String(row.canonical_name ?? "").trim()) knownNames.push(row.canonical_name);
  }

  pending.sort((x, y) => {
    const bx = BLOCKING_REASONS.has(x[1]) ? 0 : 1;
    const by = BLOCKING_REASONS.has(y[1]) ? 0 : 1;
    if (bx !== by) return bx - by;
    if (x[0].packs_in_year !== y[0].packs_in_year) return y[0].packs_in_year - x[0].packs_in_year;
    const t = cmpCodePoint(x[0].raw_title, y[0].raw_title);
    if (t) return t;
    return cmpCodePoint(x[0].key, y[0].key);
  });

  const queueRows = [];
  for (const [entry, reason, known] of pending) {
    const row = suggestRow(entry, reason, known, knownNames);
    if (row.canonical_name) knownNames.push(row.canonical_name);
    queueRows.push(row);
  }

  const reasonCounts = queueReasonCounts(queueRows);
  const blocking = Object.entries(reasonCounts)
    .filter(([reason]) => BLOCKING_REASONS.has(reason))
    .reduce((sum, [, n]) => sum + n, 0);
  return {
    queueRows,
    counts: { blocking, unconfirmed: reasonCounts[REASON_UNCONFIRMED] },
    reasonCounts,
  };
}

/** How many queue rows carry each `queue_reason`, in the order they are reported. */
export function queueReasonCounts(queueRows) {
  const counts = {
    [REASON_UNKNOWN]: 0,
    [REASON_MISSING]: 0,
    [REASON_UNCONFIRMED]: 0,
  };
  for (const row of queueRows || []) {
    const reason = String(row.queue_reason ?? "").trim();
    if (reason in counts) counts[reason] += 1;
  }
  return counts;
}

function parseUnits(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const number = pyFloat(text);
  if (Number.isNaN(number) || !Number.isFinite(number)) return null;
  if (number <= 0 || number !== Math.trunc(number)) return null;
  return Math.trunc(number);
}

function rowLabel(row) {
  return slicePoints(row.raw_title || row.key || "", 60);
}

/**
 * Merge a filled queue into the item master; returns a new master, sorted by key.
 *
 * A row missing a decision is rejected by line number rather than defaulted,
 * because a default here is exactly the silent guess the queue exists to
 * prevent. `proposed: true` records `upp_source = proposed` instead of
 * `master`, for a queue a skill filled in without a person confirming it.
 *
 * @param {object} args
 * @param {Map<string,object>} args.master
 * @param {object[]|{rows: object[], columns?: string[], name?: string}} args.decisions
 * @param {number|string} args.year
 * @param {boolean} [args.proposed]
 * @returns {{master: Map<string,object>, written: number}}
 */
export function applyQueue({ master, decisions, year, proposed = false } = {}) {
  const rows = Array.isArray(decisions) ? decisions : (decisions && decisions.rows) || [];
  const name = (!Array.isArray(decisions) && decisions && decisions.name) || "review_queue.csv";
  const columns =
    (!Array.isArray(decisions) && decisions && decisions.columns) ||
    (rows.length ? Object.keys(rows[0]) : []);

  const required = ["key", "include", "units_per_pack", "canonical_name"];
  const missing = required.filter((c) => !columns.includes(c));
  if (missing.length) {
    fail(
      `${name} is missing the column(s): ${missing.join(", ")}. ` +
        "Fill in the review_queue.csv the review command wrote, keeping its columns."
    );
  }

  const next = new Map(asMasterMap(master));
  const problems = [];
  const staged = [];

  rows.forEach((raw, i) => {
    const lineNo = i + 2;
    const row = {};
    for (const [k, v] of Object.entries(raw || {})) {
      if (k) row[k] = String(v ?? "").trim();
    }
    const key = row.key || "";
    if (!key) {
      problems.push(`line ${lineNo}: no key`);
      return;
    }

    let include = casefold(row.include || "");
    if (YES.includes(include)) include = "y";
    else if (NO.includes(include)) include = "n";
    else if (!include) {
      problems.push(`line ${lineNo} (${rowLabel(row)}): include is blank - enter y or n`);
      return;
    } else {
      problems.push(
        `line ${lineNo} (${rowLabel(row)}): include is ${pyRepr(row.include)} - enter y or n`
      );
      return;
    }

    const units = row.units_per_pack || "";
    let parsed;
    if (include === "y") {
      parsed = parseUnits(units);
      if (parsed === null) {
        problems.push(
          `line ${lineNo} (${rowLabel(row)}): units_per_pack is ` +
            `${pyRepr(units)} - enter how many units come in one purchase unit`
        );
        return;
      }
    } else {
      parsed = parseUnits(units) || 1;
    }

    const canonical = row.canonical_name || row.raw_title || key;
    staged.push(
      makeMasterRow({
        key,
        source: row.source || "",
        raw_title: row.raw_title || "",
        include,
        canonical_name: canonical,
        units_per_pack: String(parsed),
        unit_label: (row.unit_label || "EA").toUpperCase(),
        // An excluded item's pack size is never used, so claiming a person
        // confirmed it would be a false record.
        upp_source: include === "y" ? (proposed ? "proposed" : "master") : "",
        amazon_category: row.amazon_category || "",
        first_seen: String(year),
        last_seen: String(year),
        note: row.note || "",
      })
    );
  });

  if (problems.length) {
    fail(
      `${name} has ${problems.length} row(s) that are not ready to apply, so ` +
        "nothing was written:\n  " +
        problems.join("\n  ")
    );
  }

  for (const row of staged) {
    const existing = next.get(row.key);
    if (existing) {
      // An update, not a replacement: the year the item first appeared is
      // history the queue does not carry, and a note somebody wrote about this
      // item is not thrown away by a row that left the field blank.
      row.first_seen = existing.first_seen || row.first_seen;
      row.note = row.note || existing.note;
      row.source = row.source || existing.source;
      row.raw_title = row.raw_title || existing.raw_title;
      row.amazon_category = row.amazon_category || existing.amazon_category;
    }
    next.set(row.key, row);
  }

  // The CLI writes the master sorted by key and every later stage reads it
  // back from there, so sorting here is what keeps a chained call identical.
  return { master: sortMaster(next), written: staged.length };
}

// ===========================================================================
// Stage 3: rank
// ===========================================================================

/** The most recent Amazon price per unit, or blank when it cannot be known. */
export function perEach(ppu, units) {
  if (!ppu || !units) return "";
  const d = decParse(String(ppu));
  if (d === null) return "";
  const rounded = decDivideRound(d, units, 4);
  if (rounded === null) return "";
  return decTrim(rounded);
}

function groupItems(perKey) {
  const grouped = new Map();
  const keys = Array.from(perKey.keys()).sort(cmpCodePoint);
  for (const key of keys) {
    const agg = perKey.get(key);
    const name = agg.canonical_name;
    let item = grouped.get(name);
    if (!item) {
      item = {
        canonical_name: name,
        eaches: 0,
        packs: 0,
        unit_labels: [],
        upp_values: [],
        keys: [],
        sources: [],
        upp_sources: [],
        latest_date: "",
        latest_ppu: "",
        latest_upp: null,
      };
      grouped.set(name, item);
    }
    const units = agg.units_per_pack || 0;
    item.eaches += agg.packs * units;
    item.packs += agg.packs;
    item.keys.push(key);
    item.upp_values.push(agg.units_per_pack);
    if (!item.sources.includes(agg.source)) item.sources.push(agg.source);
    if (!item.unit_labels.includes(agg.unit_label)) item.unit_labels.push(agg.unit_label);
    if (agg.upp_source && !item.upp_sources.includes(agg.upp_source)) {
      item.upp_sources.push(agg.upp_source);
    }
    if (agg.latest_ppu && agg.latest_date >= item.latest_date) {
      item.latest_date = agg.latest_date;
      item.latest_ppu = agg.latest_ppu;
      item.latest_upp = agg.units_per_pack;
    }
  }

  const items = [];
  for (const item of grouped.values()) {
    const distinct = new Set(item.upp_values.filter((v) => v !== null && v !== undefined));
    items.push({
      canonical_name: item.canonical_name,
      eaches: item.eaches,
      packs: item.packs,
      // Blank when merged listings come in different pack sizes: there is no
      // single true value, and eaches is still the right total.
      units_per_pack: distinct.size === 1 ? String(distinct.values().next().value) : "",
      unit_label: item.unit_labels.join("|"),
      keys: item.keys.join("|"),
      sources: item.sources.join("|"),
      last_paid_per_each: perEach(item.latest_ppu, item.latest_upp),
      upp_source: item.upp_sources.join("|"),
    });
  }
  return items;
}

function excludedRow(row, reason) {
  return {
    key: row.key,
    source: row.source,
    raw_title: row.raw_title,
    amazon_category: row.amazon_category,
    packs: row.packs,
    reason,
  };
}

/**
 * Rank items by eaches bought, and account for every line that is not ranked.
 *
 * Validation runs first. When it fails, `ranked` and `excluded` come back empty
 * and the reason is in `findings`: an item whose key is unknown or whose pack
 * size is missing cannot be ranked, and a partial ranking that looks complete
 * is worse than none.
 *
 * PARITY NOTE: the Python raises `SupplytrackError` here. The page needs to
 * render the failures rather than catch them, so they are returned instead -
 * the same findings, in the same order, with the same messages.
 *
 * @param {{lines: object[], master: Map<string,object>, year: number|string, run?: object}} args
 * @returns {{ranked: object[], excluded: object[], findings: object[],
 *            totalLines: number, includedLines: number, excludedLines: number}}
 */
export function rank({ lines, master, year, run = {} } = {}) {
  const m = asMasterMap(master);
  const findings = checkLines({ lines, year, run }).concat(checkMaster({ lines, master: m, year }));
  if (findings.some((f) => f.level === "fail")) {
    return {
      ranked: [], excluded: [], findings,
      totalLines: (lines || []).length, includedLines: 0, excludedLines: 0,
    };
  }

  const perKey = new Map();
  const excluded = [];

  for (const row of lines || []) {
    const entry = m.get(row.key);
    if (!entry) {
      excluded.push(excludedRow(row, "not in item master"));
      continue;
    }
    if (!masterIncluded(entry)) {
      excluded.push(excludedRow(row, "include=n"));
      continue;
    }
    let agg = perKey.get(row.key);
    if (!agg) {
      agg = {
        key: row.key,
        canonical_name: entry.canonical_name || entry.raw_title || row.key,
        units_per_pack: masterUnitsPerPackInt(entry),
        unit_label: entry.unit_label || "EA",
        upp_source: entry.upp_source || "",
        source: row.source,
        packs: 0,
        lines: 0,
        latest_date: "",
        latest_ppu: "",
      };
      perKey.set(row.key, agg);
    }
    agg.packs += Number(row.packs);
    agg.lines += 1;
    if (row.source === "amazon" && row.ppu_paid) {
      if (row.order_date >= agg.latest_date) {
        agg.latest_date = row.order_date;
        agg.latest_ppu = row.ppu_paid;
      }
    }
  }

  const items = groupItems(perKey);
  items.sort(
    (a, b) =>
      b.eaches - a.eaches ||
      b.packs - a.packs ||
      cmpCodePoint(casefold(a.canonical_name), casefold(b.canonical_name))
  );
  items.forEach((item, i) => {
    item.rank = i + 1;
  });

  let includedLines = 0;
  for (const agg of perKey.values()) includedLines += agg.lines;

  const ranked = items.map((item) => {
    const out = {};
    for (const c of RANKED_COLUMNS) out[c] = item[c] == null ? "" : item[c];
    return out;
  });

  return {
    ranked,
    excluded,
    findings,
    totalLines: (lines || []).length,
    includedLines,
    excludedLines: excluded.length,
  };
}

// ===========================================================================
// Stage 4: prices
// ===========================================================================

function readRankedTop(ranked, top) {
  const rows = Array.from(ranked || []);
  rows.sort((a, b) => (parseInt(a.rank, 10) || 0) - (parseInt(b.rank, 10) || 0));
  return rows.slice(0, top);
}

function templateRow(rankValue, canonicalName, vendor, lastPaid) {
  const note = vendor === "Amazon" && lastPaid ? `last paid per each: ${lastPaid}` : "";
  return {
    rank: String(rankValue),
    canonical_name: canonicalName,
    vendor,
    unit_price: "",
    status: "unpriced",
    url: "",
    checked_on: "",
    note,
  };
}

/**
 * The fill-in template for the top N items x vendor, all `unpriced`.
 *
 * @returns {{rows: object[], kept: number, added: number, retired: number, retiredRows: object[]}}
 */
export function pricesTemplate({ ranked, top = 25 } = {}) {
  const rows = [];
  for (const row of readRankedTop(ranked, top)) {
    const lastPaid = String(row.last_paid_per_each ?? "").trim();
    for (const vendor of VENDORS) {
      rows.push(templateRow(row.rank, row.canonical_name, vendor, lastPaid));
    }
  }
  return { rows, kept: 0, added: rows.length, retired: 0, retiredRows: [] };
}

/**
 * Rebuild the price sheet for a re-ranked top N without losing typed prices.
 *
 * An item still in the top N keeps its rows exactly as typed with only `rank`
 * refreshed; an item new to the top N gets `unpriced` rows; an item that
 * dropped out has its rows returned unchanged in `retiredRows` so nothing typed
 * is discarded. With no existing sheet this is `pricesTemplate`.
 */
export function pricesUpdate({ ranked, top = 25, existing = null } = {}) {
  const existingRows = Array.from(existing || []);
  if (!existingRows.length) {
    const made = pricesTemplate({ ranked, top });
    return { ...made, kept: 0 };
  }

  // Index by (canonical_name, vendor) so a row is retired whenever it is not
  // reused - never decided by name alone. That also catches a stray vendor
  // spelling or a duplicate row, which would otherwise vanish from both files.
  // Nested rather than a joined string key, so no separator character has to be
  // assumed absent from an item name.
  const existingByKey = new Map();
  existingRows.forEach((row, i) => {
    const name = String(row.canonical_name ?? "").trim();
    const vendor = String(row.vendor ?? "").trim();
    let byVendor = existingByKey.get(name);
    if (!byVendor) {
      byVendor = new Map();
      existingByKey.set(name, byVendor);
    }
    byVendor.set(vendor, i); // last row wins if a key repeats
  });

  let kept = 0;
  let added = 0;
  const reused = new Set();
  const rows = [];

  for (const row of readRankedTop(ranked, top)) {
    const rankValue = String(row.rank);
    const canonicalName = row.canonical_name;
    const lastPaid = String(row.last_paid_per_each ?? "").trim();
    for (const vendor of VENDORS) {
      const byVendor = existingByKey.get(canonicalName);
      const idx = byVendor ? byVendor.get(vendor) : undefined;
      if (idx != null) {
        const prev = existingRows[idx];
        reused.add(idx);
        kept += 1;
        rows.push({
          rank: rankValue,
          canonical_name: canonicalName,
          vendor,
          unit_price: prev.unit_price || "",
          status: prev.status || "",
          url: prev.url || "",
          checked_on: prev.checked_on || "",
          note: prev.note || "",
        });
      } else {
        added += 1;
        rows.push(templateRow(rankValue, canonicalName, vendor, lastPaid));
      }
    }
  }

  const retiredRows = existingRows
    .filter((_, i) => !reused.has(i))
    .map((row) => {
      const out = {};
      for (const c of PRICES_HEADER) out[c] = row[c] == null ? "" : row[c];
      return out;
    });

  return { rows, kept, added, retired: retiredRows.length, retiredRows };
}

function parseUnitPrice(raw) {
  let text = String(raw ?? "").trim();
  if (text.startsWith("$")) text = text.slice(1).trim();
  text = text.split(",").join("");
  return { text, dec: decParse(text) };
}

/**
 * Load the price sheet into `cells[canonicalName][vendor]`, and list every problem.
 *
 * `cells` is a nested plain object, per the shape report.js and app.js agreed
 * on. Each cell is `{rank, canonicalName, vendor, unitPrice, status, url,
 * checkedOn, note}`. `unitPrice` is the price as typed - the currency symbol
 * and thousands separators removed so `Number(cell.unitPrice)` works, but the
 * digits never reformatted, so `1.250` stays `1.250` and does not become
 * `1.25`. It is `""` when the cell holds no price at all, and a cell whose
 * price could not be read keeps the unreadable text rather than being blanked,
 * so a typo can be told apart from an empty box.
 *
 * Nothing is raised: `problems` carries what the Python raises about, worded
 * the same way, so the page can list every one at once.
 *
 * @returns {{cells: Record<string, Record<string, object>>, problems: string[]}}
 */
export function loadPrices({ rows, ranked, top = 25, year = "" } = {}) {
  const rankedTop = readRankedTop(ranked, top);
  const cells = {};
  const problems = [];

  for (const row of rows || []) {
    const canonicalName = String(row.canonical_name ?? "").trim();
    const vendor = String(row.vendor ?? "").trim();
    const status = String(row.status ?? "").trim();
    const raw = String(row.unit_price ?? "").trim();
    const parsed = raw ? parseUnitPrice(raw) : { text: "", dec: null };

    if (!VALID_STATUSES.has(status)) {
      problems.push(`${canonicalName} / ${vendor}: unknown status ${pyRepr(status)}`);
    } else if (status === "priced") {
      if (!raw) {
        problems.push(`${canonicalName} / ${vendor}: blank unit_price for status 'priced'`);
      } else if (parsed.dec === null) {
        problems.push(`${canonicalName} / ${vendor}: unit_price ${pyRepr(raw)} is not numeric`);
      }
    }

    const rankNum = parseInt(String(row.rank ?? "").trim(), 10);
    if (!cells[canonicalName]) cells[canonicalName] = {};
    cells[canonicalName][vendor] = {
      rank: Number.isFinite(rankNum) ? rankNum : 0,
      canonicalName,
      vendor,
      unitPrice: parsed.text,
      status,
      url: row.url || "",
      checkedOn: row.checked_on || "",
      note: row.note || "",
    };
  }

  for (const row of rankedTop) {
    for (const vendor of VENDORS) {
      if (!cells[row.canonical_name] || !cells[row.canonical_name][vendor]) {
        problems.push(
          `${row.canonical_name} / ${vendor}: missing from prices.csv. Run ` +
            `\`supplytrack prices --year ${year} --update\` to add it.`
        );
      }
    }
  }

  return { cells, problems };
}

/** Walk a nested cells object, items in insertion order, vendors within each. */
function eachCell(cells) {
  const out = [];
  for (const name of Object.keys(cells || {})) {
    for (const vendor of Object.keys(cells[name] || {})) out.push(cells[name][vendor]);
  }
  return out;
}

/**
 * The price-sheet findings: completeness, unpriced cells and vendor coverage.
 *
 * Takes the same nested `cells` object `loadPrices` returns. Pass `rows`
 * instead and it loads them first; pass both and `rows` decides the order
 * problems are reported in, which is the order they appear in the sheet.
 *
 * @returns {Array<{level: string, code: string, message: string}>}
 */
export function checkPrices({ cells, problems, rows, ranked, top = 25, year = "" } = {}) {
  let sheet = cells;
  let issues = problems;
  if (sheet == null || issues == null) {
    const loaded = loadPrices({ rows: rows || cellsToRows(sheet), ranked, top, year });
    sheet = sheet == null ? loaded.cells : sheet;
    issues = issues == null ? loaded.problems : issues;
  }

  const findings = issues.map((p) => warn0("fail", "PRICES_INCOMPLETE", p));
  if (issues.length) return findings;

  const all = eachCell(sheet);
  const unpriced = all
    .filter((cell) => cell.status === "unpriced")
    .map((cell) => `${cell.canonicalName} / ${cell.vendor}`);
  if (unpriced.length) {
    let text = unpriced.slice(0, UNPRICED_SAMPLE).join("; ");
    if (unpriced.length > UNPRICED_SAMPLE) {
      text += `; and ${unpriced.length - UNPRICED_SAMPLE} more`;
    }
    findings.push(
      warn0(
        "warn",
        "PRICES_UNPRICED",
        `${unpriced.length} item/vendor pair(s) still need a price: ${text}`
      )
    );
  }

  const counts = new Map(VENDORS.map((v) => [v, 0]));
  for (const cell of all) {
    // PARITY NOTE: Python raises KeyError on a vendor outside VENDORS here.
    // Skipping it keeps the page usable on a hand-edited sheet.
    if (cell.status === "priced" && counts.has(cell.vendor)) {
      counts.set(cell.vendor, counts.get(cell.vendor) + 1);
    }
  }
  const maxCount = Math.max(0, ...counts.values());
  for (const [vendor, count] of counts) {
    if (count < maxCount) {
      findings.push(
        warn0(
          "warn",
          "VENDOR_COVERAGE",
          `${vendor} has ${count} priced item(s), fewer than the ` +
            `best-covered vendor (${maxCount}).`
        )
      );
    }
  }
  return findings;
}

/** A nested cells object back to Appendix A price rows, in sheet order. */
export function cellsToRows(cells) {
  return eachCell(cells).map((cell) => ({
    rank: String(cell.rank ?? ""),
    canonical_name: cell.canonicalName,
    vendor: cell.vendor,
    unit_price: cell.unitPrice ?? "",
    status: cell.status,
    url: cell.url || "",
    checked_on: cell.checkedOn || "",
    note: cell.note || "",
  }));
}

// ===========================================================================
// Stage 5: validate
// ===========================================================================

function warn0(level, code, message) {
  return { level, code, message };
}

function sample(items) {
  let text = items.slice(0, SAMPLE).join("; ");
  if (items.length > SAMPLE) text += `; and ${items.length - SAMPLE} more`;
  return text;
}

/** The line file itself: is it there, is it whole, are the lines in the year. */
export function checkLines({ lines, year, run = {} } = {}) {
  if (!lines) {
    return [
      warn0("fail", "LINES_MISSING",
        `There is no line file for ${year}. Run ingest for ${year} before anything else.`),
    ];
  }
  const findings = [];
  const rowsWritten = run ? run.rows_written : undefined;
  if (Number.isInteger(rowsWritten) && rowsWritten !== lines.length) {
    findings.push(
      warn0("fail", "LINE_COUNT_MISMATCH",
        `The ingest recorded ${rowsWritten} lines for ${year} but lines.csv now holds ` +
          `${lines.length}. Run ingest again rather than editing lines.csv by hand.`)
    );
  }

  const outside = lines
    .filter((row) => !String(row.order_date).startsWith(`${year}-`))
    .map((row) => `${slicePoints(row.raw_title, 50)} on ${row.order_date}`);
  if (outside.length) {
    findings.push(
      warn0("warn", "DATE_OUT_OF_YEAR",
        `${outside.length} line(s) are dated outside ${year}: ${sample(outside)}. ` +
          "They are still counted; re-export with the right date range if that is wrong.")
    );
  }

  const nonClosed = (run && run.non_closed) || [];
  if (nonClosed.length) {
    const shown = nonClosed.map((item) => `${item.order_id || "(no order id)"} is ${item.status}`);
    findings.push(
      warn0("warn", "STATUS_NOT_CLOSED",
        `${nonClosed.length} line(s) have an order status other than Closed: ` +
          `${sample(shown)}. A cancelled or returned order still counts here.`)
    );
  }
  return findings;
}

/** Every whole number the title states, decimals and their parts excluded. */
export function numbersIn(title) {
  const out = new Set();
  const re = /(?<![\d.])\d{1,6}(?![\d.])/g;
  let m;
  const s = String(title ?? "");
  while ((m = re.exec(s)) !== null) out.add(parseInt(m[0], 10));
  return out;
}

/** The title's pack counts when they genuinely disagree with `units`, else "". */
export function contradictingCandidates(title, units) {
  const candidates = uppCandidates(title);
  if (!candidates.length) return "";
  const packLike = candidates.filter(([, phrase]) => isPackPhrase(phrase));
  if (!packLike.length) return "";

  if (numbersIn(title).has(units)) return "";
  const values = Array.from(new Set(candidates.map(([v]) => v))).sort((a, b) => a - b);
  const products = new Set();
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) products.add(values[i] * values[j]);
  }
  if (products.has(units)) return "";
  return packLike.map(([value, phrase]) => `${value} (${phrase})`).join(", ");
}

/** The decisions: every key known, every included item with a usable pack size. */
export function checkMaster({ lines, master, year } = {}) {
  if (!lines) {
    return [
      warn0("fail", "LINES_MISSING",
        `There is no line file for ${year}. Run ingest for ${year} before anything else.`),
    ];
  }
  const m = asMasterMap(master);
  const findings = [];

  const unknown = new Map();
  for (const row of lines) {
    if (!m.has(row.key) && !unknown.has(row.key)) {
      unknown.set(row.key, slicePoints(row.raw_title, 50));
    }
  }
  if (unknown.size) {
    const shown = Array.from(unknown, ([key, title]) => `${title} [${key}]`);
    findings.push(
      warn0("fail", "UNKNOWN_KEY",
        `${unknown.size} item(s) are not in the item master: ${sample(shown)}. ` +
          `Run review for ${year}, fill the queue in, and apply it.`)
    );
  }

  const used = Array.from(new Set(lines.map((r) => r.key))).sort(cmpCodePoint);
  const badUnits = [];
  const unconfirmed = [];
  const mismatched = [];
  const oddCategory = [];

  for (const key of used) {
    const entry = m.get(key);
    if (!entry || !masterIncluded(entry)) {
      if (entry && entry.include === "n" && entry.amazon_category) {
        if (categoryExpectedInclude(entry.amazon_category) === "y") {
          oddCategory.push(
            `${entry.canonical_name || slicePoints(entry.raw_title, 40)} is excluded but its ` +
              `category is ${entry.amazon_category}`
          );
        }
      }
      continue;
    }

    const units = masterUnitsPerPackInt(entry);
    if (units === null) {
      badUnits.push(
        `${entry.canonical_name || slicePoints(entry.raw_title, 40)} ` +
          `(units_per_pack is ${pyRepr(entry.units_per_pack)})`
      );
    } else {
      if (masterUppUnconfirmed(entry)) {
        unconfirmed.push(
          `${entry.canonical_name || slicePoints(entry.raw_title, 40)}: ${units} ` +
            `per pack came from ${entry.upp_source}`
        );
      }
      const stated = contradictingCandidates(entry.raw_title, units);
      if (stated) {
        mismatched.push(
          `${entry.canonical_name || slicePoints(entry.raw_title, 40)}: master says ${units}, ` +
            `the title says ${stated}`
        );
      }
    }

    if (entry.amazon_category && categoryIsKnown(entry.amazon_category)) {
      if (categoryExpectedInclude(entry.amazon_category) === "n") {
        oddCategory.push(
          `${entry.canonical_name || slicePoints(entry.raw_title, 40)} is included but its ` +
            `category is ${entry.amazon_category}`
        );
      }
    }
  }

  if (badUnits.length) {
    findings.push(
      warn0("fail", "UPP_MISSING",
        `${badUnits.length} included item(s) have no usable units_per_pack: ` +
          `${sample(badUnits)}. Every included item needs a whole number of units ` +
          "per purchase unit before it can be ranked.")
    );
  }
  if (unconfirmed.length) {
    findings.push(
      warn0("warn", "UPP_UNCONFIRMED",
        `${unconfirmed.length} included item(s) are ranked on a pack size nobody has ` +
          `confirmed: ${sample(unconfirmed)}. They are counted, and they stay in the ` +
          "review queue until somebody confirms them.")
    );
  }
  if (mismatched.length) {
    findings.push(
      warn0("warn", "UPP_TITLE_MISMATCH",
        `${mismatched.length} item(s) have a pack size that disagrees with the title: ` +
          `${sample(mismatched)}. Check which is right - this changes the ranking.`)
    );
  }
  if (oddCategory.length) {
    findings.push(
      warn0("warn", "CATEGORY_UNUSUAL",
        `${oddCategory.length} item(s) are classified against the usual rule for their ` +
          `category: ${sample(oddCategory)}.`)
    );
  }

  const nameSet = new Set();
  for (const key of used) {
    const entry = m.get(key);
    if (entry && masterIncluded(entry) && String(entry.canonical_name ?? "").trim()) {
      nameSet.add(entry.canonical_name);
    }
  }
  const names = Array.from(nameSet).sort(cmpCodePoint);
  const pairs = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const ratio = sequenceRatio(casefold(names[i]), casefold(names[j]));
      if (ratio >= NEAR_DUPLICATE) {
        pairs.push(`"${names[i]}" and "${names[j]}" (${formatRatio(ratio)})`);
      }
    }
  }
  if (pairs.length) {
    findings.push(
      warn0("warn", "NEAR_DUPLICATE_NAMES",
        `${pairs.length} pair(s) of item names are nearly identical and are being counted ` +
          `as separate items: ${sample(pairs)}. Give them one name to merge them.`)
    );
  }
  return findings;
}

/** The ranking artifacts: present, and accounting for every line read. */
export function checkRank({ lines, master, ranked, excluded, year } = {}) {
  if (!ranked || !excluded) {
    return [warn0("fail", "RANK_MISSING", `There is no ranking for ${year} yet. Run rank for ${year}.`)];
  }
  if (!lines) {
    return [
      warn0("fail", "LINES_MISSING",
        `There is no line file for ${year}. Run ingest for ${year} before anything else.`),
    ];
  }
  const m = asMasterMap(master);
  const findings = [];

  let expectedIncluded = 0;
  for (const row of lines) {
    const entry = m.get(row.key);
    if (entry && masterIncluded(entry)) expectedIncluded += 1;
  }
  if (expectedIncluded + excluded.length !== lines.length) {
    findings.push(
      warn0("fail", "UNCOUNTED_LINES",
        `${expectedIncluded} included plus ${excluded.length} excluded lines do not ` +
          `add up to the ${lines.length} lines read for ${year}. Some lines are in neither ` +
          "file, so the totals understate what was bought. Run rank again.")
    );
  }
  if (expectedIncluded && !ranked.length) {
    findings.push(
      warn0("fail", "RANK_EMPTY",
        `${expectedIncluded} line(s) are marked for inclusion but the ranking for ` +
          `${year} is empty. Run rank again.`)
    );
  }
  return findings;
}

/**
 * Every check, in pipeline order, deduplicated by (code, message).
 *
 * `prices` is the parsed prices.csv rows, or null when there is no sheet yet.
 *
 * PARITY NOTE: the PRICES_MISSING message drops the file path, which does not
 * exist in a browser. Every other message is the Python's word for word.
 *
 * @returns {Array<{level: string, code: string, message: string}>}
 */
export function validateAll({
  lines, master, ranked, excluded, prices = null, top = 25, year = "", run = {},
} = {}) {
  const m = asMasterMap(master);
  let findings = checkLines({ lines, year, run });
  findings = findings.concat(checkMaster({ lines, master: m, year }));
  findings = findings.concat(checkRank({ lines, master: m, ranked, excluded, year }));

  if (!prices) {
    findings.push(
      warn0("fail", "PRICES_MISSING",
        `There is no price sheet for ${year} yet. Build the price template and fill it in.`)
    );
  } else {
    findings = findings.concat(checkPrices({ rows: prices, ranked, top, year }));
  }

  const seen = new Set();
  const unique = [];
  for (const finding of findings) {
    const mark = JSON.stringify([finding.code, finding.message]);
    if (seen.has(mark)) continue;
    seen.add(mark);
    unique.push(finding);
  }
  return unique;
}

// ===========================================================================
// File round trips (spec.md Appendix A)
//
// Each pair converts between the exact column order on disk and the row objects
// the stages above use, so a file written here reads back in the Python CLI and
// the other way round.
// ===========================================================================


function requireColumns(header, columns, name, remedy) {
  const missing = columns.filter((c) => !header.includes(c));
  if (missing.length) {
    fail(`${name} is missing the column(s): ${missing.join(", ")}. ${remedy}`);
  }
}

function pick(row, columns) {
  const out = {};
  for (const c of columns) out[c] = String(row[c] ?? "").trim();
  return out;
}

export function linesToCsv(lines) {
  return serialiseObjects(LINES_COLUMNS, lines);
}

/** Read lines.csv back, with `packs` as a number - shared by rank and validate. */
export function linesFromCsv(text, name = "lines.csv") {
  const { header, rows } = parseObjects(text);
  requireColumns(header, LINES_COLUMNS, name, "Delete it and run ingest again.");
  return rows.map((raw, i) => {
    const row = pick(raw, LINES_COLUMNS);
    row.packs = coerceInt(row.packs, `${name} line ${i + 2}`);
    return row;
  });
}

export function masterToCsv(master) {
  const sorted = sortMaster(asMasterMap(master));
  return serialiseObjects(MASTER_COLUMNS, Array.from(sorted.values()));
}

export function masterFromCsv(text, name = "item_master.csv") {
  const { header, rows } = parseObjects(text);
  if (!header.length) return new Map();
  requireColumns(
    header, MASTER_COLUMNS, name,
    "The item master must keep its full set of columns; restore it from git history."
  );
  const out = new Map();
  rows.forEach((raw, i) => {
    const key = String(raw.key ?? "").trim();
    if (!key) return;
    if (out.has(key)) {
      fail(
        `${name} line ${i + 2}: the key ${pyRepr(key)} appears twice. ` +
          "Each item may have only one row; merge the two by hand and retry."
      );
    }
    out.set(key, makeMasterRow(pick(raw, MASTER_COLUMNS)));
  });
  return out;
}

/** The master as a Map sorted by key, which is how the CLI writes the file. */
export function sortMaster(master) {
  const m = asMasterMap(master);
  const out = new Map();
  for (const key of Array.from(m.keys()).sort(cmpCodePoint)) out.set(key, m.get(key));
  return out;
}

/** Accept a Map, a plain object, or an array of rows, and hand back a Map. */
export function asMasterMap(master) {
  if (!master) return new Map();
  if (master instanceof Map) return master;
  if (Array.isArray(master)) return new Map(master.map((r) => [r.key, r]));
  return new Map(Object.entries(master));
}

export function queueToCsv(rows) {
  return serialiseObjects(REVIEW_COLUMNS, rows);
}

export function queueFromCsv(text) {
  return parseObjects(text).rows;
}

export function rankedToCsv(rows) {
  return serialiseObjects(RANKED_COLUMNS, rows);
}

export function rankedFromCsv(text, name = "ranked.csv") {
  const { header, rows } = parseObjects(text);
  requireColumns(header, RANKED_COLUMNS, name, "Run rank again.");
  return rows.map((raw) => pick(raw, RANKED_COLUMNS));
}

export function excludedToCsv(rows) {
  return serialiseObjects(EXCLUDED_COLUMNS, rows);
}

export function excludedFromCsv(text) {
  return parseObjects(text).rows.map((raw) => pick(raw, EXCLUDED_COLUMNS));
}

export function pricesToCsv(rows) {
  return serialiseObjects(PRICES_HEADER, rows);
}

export function pricesFromCsv(text) {
  return parseObjects(text).rows.map((raw) => pick(raw, PRICES_HEADER));
}

// --- compatibility aliases -------------------------------------------------
// A caller that already has row objects should not have to serialise them to
// CSV just to parse them back. `parseMaster` and `parsePrices` take either the
// text or the rows, so a caller with one does not have to know which.

/** An item master with nothing in it yet - the state of a very first run. */
export function emptyMaster() {
  return new Map();
}

/** Rows -> the master Map, keyed by `key`, in the order given. */
export function masterFromRows(rows) {
  const out = new Map();
  for (const raw of rows || []) {
    const key = String(raw.key ?? "").trim();
    if (key) out.set(key, makeMasterRow(pick(raw, MASTER_COLUMNS)));
  }
  return out;
}

/**
 * The item master from CSV text, row objects or another master.
 *
 * Always a fresh Map: every other function here is pure, and handing back the
 * caller's own Map would make a later edit leak into state they thought they
 * had copied.
 */
export function parseMaster(source, name = "item_master.csv") {
  if (source == null) return new Map();
  if (typeof source === "string") return masterFromCsv(source, name);
  if (source instanceof Map) return new Map(source);
  return masterFromRows(source);
}

/** Price rows normalised to the Appendix A column order. */
export function pricesFromRows(rows) {
  return (rows || []).map((raw) => pick(raw, PRICES_HEADER));
}

/** The price sheet from CSV text or from row objects. */
export function parsePrices(source) {
  if (source == null) return [];
  return typeof source === "string" ? pricesFromCsv(source) : pricesFromRows(source);
}

/** run.json, formatted the way the CLI writes it (2-space indent, trailing newline). */
export function runToJson(run) {
  return JSON.stringify(run, null, 2) + "\n";
}

export { csvParse };

export default {
  SupplytrackError,
  normaliseTitle, amazonKey, preferredKey,
  uppCandidates, decodePreferredPack, suggestInclude, isPackPhrase,
  ingest, buildQueue, applyQueue, rank,
  pricesTemplate, pricesUpdate, loadPrices, checkPrices,
  checkLines, checkMaster, checkRank, validateAll,
};
