// report-tests.js — Node test suite for xlsxio.js and report.js.
//
// Run:  node src/web/tests/report-tests.js
//
// Three layers:
//   1. xlsxio unit tests: readTable() round-tripped through a workbook this
//      file builds itself (dates, numbers, a formula's cached result, rich
//      text, and the firm's out-of-spec <font family="34">).
//   2. Golden comparison: builds the "Top 25" / "All items" / "Excluded" /
//      "Sources" workbook from src/tests/golden/{expected,inputs}/*.csv (the
//      same inputs supplytrack.report.build_report used to produce
//      src/tests/golden/expected/report.json) and diffs a structural dump of
//      the result against that JSON, cell by cell.
//   3. Two hand-checked spot tests against src/tests/fixtures/report/*.csv
//      (the same fixture supplytrack's own test_report.py uses), covering
//      shapes the golden fixture never exercises: a fully-populated
//      "Excluded" + run.json build, and the lenient path where run.json,
//      excluded.csv and item_master.csv are all absent, at a different
//      `top` (geometry-scales-with-top).
"use strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTable, normHeader, newWorkbook, toArrayBuffer } from "../js/xlsxio.js";
import { buildReport } from "../js/report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/web/tests -> src/web -> src
const SRC_DIR = path.resolve(__dirname, "..", "..");
const GOLDEN_DIR = path.join(SRC_DIR, "tests", "golden");
const PY_FIXTURES_DIR = path.join(SRC_DIR, "tests", "fixtures", "report");

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? " - " + detail : ""}`);
  }
}

function eq(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function checkDeep(label, actual, expected) {
  const ok = deepEqual(actual, expected);
  check(label, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Reports missing/extra/mismatched keys in a {addr: value} style dict
// (cells, fills) as one summarised check, instead of one assertion per cell.
function compareKeyedDict(label, actual, expected) {
  actual = actual || {};
  expected = expected || {};
  const actualKeys = new Set(Object.keys(actual));
  const expectedKeys = new Set(Object.keys(expected));
  const missing = [...expectedKeys].filter((k) => !actualKeys.has(k));
  const extra = [...actualKeys].filter((k) => !expectedKeys.has(k));
  const mismatched = [...expectedKeys].filter((k) => actualKeys.has(k) && !deepEqual(actual[k], expected[k]));
  const ok = missing.length === 0 && extra.length === 0 && mismatched.length === 0;
  let detail = "";
  if (!ok) {
    const parts = [];
    if (missing.length) parts.push(`missing ${missing.length} e.g. ${missing.slice(0, 5).join(", ")}`);
    if (extra.length) parts.push(`extra ${extra.length} e.g. ${extra.slice(0, 5).join(", ")}`);
    if (mismatched.length) {
      const examples = mismatched
        .slice(0, 5)
        .map((k) => `${k}: got ${JSON.stringify(actual[k])} want ${JSON.stringify(expected[k])}`);
      parts.push(`mismatched ${mismatched.length} e.g. ${examples.join(" | ")}`);
    }
    detail = parts.join("; ");
  }
  check(label, ok, detail);
}

// --------------------------------------------------------------- CSV utils
//
// A small RFC 4180 parser/reader for THIS TEST FILE ONLY - fixture and
// golden CSVs carry quoted fields with embedded commas (excluded.csv's
// raw_title), so a naive split(",") is not safe. Not a port of anything in
// csv.js (owned elsewhere); this never leaves the test file.

function parseCsvRows(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // skip
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseCsvObjects(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const headers = rows[0];
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c !== ""))
    .map((r) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = r[i] !== undefined ? r[i] : "";
      });
      return obj;
    });
}

function readCsvObjects(filePath) {
  return parseCsvObjects(fs.readFileSync(filePath, "utf-8"));
}

// prices.csv rows -> prices[canonical_name][vendor] = {status, unitPrice}.
// Cleans "$" and thousands commas the same way supplytrack.prices.
// _parse_unit_price does - report.js's contract expects an already-cleaned
// decimal string, mirroring the split of responsibility between prices.py
// (parses/validates) and report.py (only consumes clean PriceCell data).
function cleanUnitPrice(raw) {
  if (raw == null) return null;
  let text = String(raw).trim();
  if (!text) return null;
  if (text.startsWith("$")) text = text.slice(1).trim();
  text = text.replace(/,/g, "");
  return text;
}

function buildPricesMap(rows) {
  const prices = {};
  for (const row of rows) {
    const name = row.canonical_name;
    const vendor = row.vendor;
    if (!prices[name]) prices[name] = {};
    prices[name][vendor] = {
      status: row.status,
      unitPrice: row.status === "priced" ? cleanUnitPrice(row.unit_price) : null,
    };
  }
  return prices;
}

// ------------------------------------------------------- workbook dumping
//
// Mirrors src/scripts/make_golden.py's dump_workbook() closely enough to
// diff directly against src/tests/golden/expected/report.json: same
// {v,f,t} cell shape, same fill payload shape (fgColor/bgColor always
// present, defaulting to "00000000" the way openpyxl's PatternFill always
// carries both Color objects), same sorted merged_cells/conditional
// formatting, same freeze_panes representation, same "<TIMESTAMP>" masking
// for ISO-looking wall-clock strings.

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const TIMESTAMP_TOKEN = "<TIMESTAMP>";

function maskScalar(v) {
  if (typeof v === "string" && TIMESTAMP_RE.test(v)) return TIMESTAMP_TOKEN;
  return v;
}

function columnLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function argbColorPayload(argb) {
  return { type: "rgb", rgb: argb || "00000000" };
}

function fillPayload(fill) {
  return {
    patternType: fill.pattern,
    fgColor: argbColorPayload(fill.fgColor && fill.fgColor.argb),
    bgColor: argbColorPayload(fill.bgColor && fill.bgColor.argb),
  };
}

function cellPayload(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object" && "formula" in raw) {
    const f = "=" + raw.formula;
    return { v: f, f, t: "f" };
  }
  if (typeof raw === "number") {
    return { v: raw, f: null, t: "n" };
  }
  if (raw instanceof Date) {
    return { v: raw.toISOString(), f: null, t: "d" };
  }
  return { v: maskScalar(String(raw)), f: null, t: "s" };
}

function dumpSheet(ws) {
  const cells = {};
  const fills = {};
  const maxRow = Math.max(ws.rowCount || 0, 40);
  const maxCol = Math.max(ws.columnCount || 0, 20);
  for (let r = 1; r <= maxRow; r++) {
    for (let c = 1; c <= maxCol; c++) {
      const cellObj = ws.getCell(r, c);
      // A merged cell that is not its range's own master/anchor mirrors the
      // master's value/fill when read back (ExcelJS-only behaviour -
      // openpyxl leaves every non-anchor cell in a merge genuinely blank),
      // so skip it here or every merge would count as N extra populated
      // cells instead of the one the golden dump actually records.
      if (cellObj.master !== cellObj) continue;
      const fill = cellObj.fill;
      // An unfilled but otherwise-styled cell (e.g. bold-only) still comes
      // back with a fill object of {type:"pattern", pattern:"none"} rather
      // than undefined - "none" is not a real fill, just ExcelJS's way of
      // saying "this cell has a style record but no fill in it".
      if (fill && fill.pattern && fill.pattern !== "none") {
        fills[cellObj.address] = fillPayload(fill);
      }
      const payload = cellPayload(cellObj.value);
      if (payload) cells[cellObj.address] = payload;
    }
  }

  const columnWidths = {};
  for (let c = 1; c <= maxCol; c++) {
    const col = ws.getColumn(c);
    if (col.width !== undefined) columnWidths[columnLetter(c)] = col.width;
  }

  const frozenView = (ws.views || []).find((v) => v.state === "frozen");

  const cfRules = [];
  for (const cf of ws.conditionalFormattings || []) {
    for (const rule of cf.rules || []) {
      const fill = rule.style && rule.style.fill;
      cfRules.push({
        sqref: cf.ref,
        type: rule.type,
        formula: rule.formulae ? rule.formulae.slice() : [],
        highlight_fill: fill ? fillPayload(fill) : null,
      });
    }
  }
  cfRules.sort((a, b) => (a.sqref < b.sqref ? -1 : a.sqref > b.sqref ? 1 : 0));

  return {
    cells,
    fills,
    merged_cells: (ws.model.merges || []).slice().sort(),
    column_widths: columnWidths,
    freeze_panes: frozenView ? frozenView.topLeftCell : null,
    conditional_formatting: cfRules,
  };
}

function dumpWorkbook(workbook) {
  const sheets = {};
  for (const ws of workbook.worksheets) {
    sheets[ws.name] = dumpSheet(ws);
  }
  return { sheet_order: workbook.worksheets.map((w) => w.name), sheets };
}

function compareSheet(name, actualSheet, expectedSheet) {
  if (!actualSheet) {
    check(`${name}: sheet present`, false, "sheet missing from built workbook");
    return;
  }
  compareKeyedDict(`${name}: cells`, actualSheet.cells, expectedSheet.cells);
  compareKeyedDict(`${name}: fills`, actualSheet.fills, expectedSheet.fills);
  checkDeep(`${name}: merged_cells`, actualSheet.merged_cells, expectedSheet.merged_cells);
  checkDeep(`${name}: column_widths`, actualSheet.column_widths, expectedSheet.column_widths);
  eq(`${name}: freeze_panes`, actualSheet.freeze_panes, expectedSheet.freeze_panes);
  checkDeep(`${name}: conditional_formatting`, actualSheet.conditional_formatting, expectedSheet.conditional_formatting);
}

async function reloadedWorkbook(builtWorkbook) {
  const buf = await toArrayBuffer(builtWorkbook);
  const reloaded = await newWorkbook();
  await reloaded.xlsx.load(buf);
  return reloaded;
}

// --------------------------------------------------------------- 1. xlsxio

async function testXlsxio() {
  console.log("xlsxio.readTable() round trip");

  const wb = await newWorkbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.getCell("A1").value = "  Order   Date ";
  ws.getCell("B1").value = "Qty";
  ws.getCell("C1").value = "Amount";
  ws.getCell("D1").value = "Note";

  ws.getCell("A2").value = new Date(Date.UTC(2025, 0, 15));
  ws.getCell("B2").value = 3;
  ws.getCell("C2").value = 9.5;
  ws.getCell("D2").value = { formula: "B2*C2", result: 28.5 };

  // Rich text should flatten to its plain concatenated string.
  ws.getCell("A3").value = new Date(Date.UTC(2025, 5, 1));
  ws.getCell("B3").value = 1;
  ws.getCell("C3").value = 2;
  ws.getCell("D3").value = { richText: [{ text: "Hello " }, { text: "World", font: { bold: true } }] };

  // A short row: only two of four columns populated. Must pad, not drop.
  ws.getCell("A4").value = new Date(Date.UTC(2025, 5, 2));
  ws.getCell("B4").value = 2;

  // A blank row (whitespace-only cell) must be dropped entirely.
  ws.getCell("A5").value = "   ";

  // The out-of-spec <font family="34"> the firm's real exports carry.
  // ExcelJS does not validate this the way openpyxl does by default; this
  // just proves the vendored build tolerates it too, on a workbook this
  // test constructs itself (no real vendor export is read here).
  ws.getCell("A2").font = { name: "Arial", family: 34, size: 11 };

  const buf = await toArrayBuffer(wb);
  const { headers, rows } = await readTable(buf);

  checkDeep("headers are normalised (stripped/collapsed/casefolded)", headers, ["order date", "qty", "amount", "note"]);
  eq("row count (blank row dropped)", rows.length, 3);
  check("row 1 date is a Date object", rows[0][0] instanceof Date, `got ${rows[0][0]}`);
  eq("row 1 qty", rows[0][1], 3);
  eq("row 1 amount", rows[0][2], 9.5);
  eq("row 1 formula cell gives cached result, not the formula text", rows[0][3], 28.5);
  eq("row 2 rich text flattens to plain string", rows[1][3], "Hello World");
  eq("row 3 (short row) is padded to header width", rows[2].length, 4);
  eq("row 3 padded cell is null", rows[2][3], null);
  eq("odd font family=34 did not throw on read", normHeader(" A  B "), "a b");
}

// -------------------------------------------------------- 2. golden report

async function testGoldenReport() {
  console.log("golden report comparison (src/tests/golden)");

  const expectedDir = path.join(GOLDEN_DIR, "expected");
  const inputsDir = path.join(GOLDEN_DIR, "inputs");
  const golden = JSON.parse(fs.readFileSync(path.join(expectedDir, "report.json"), "utf-8"));

  const ranked = readCsvObjects(path.join(expectedDir, "ranked.csv"));
  const excluded = readCsvObjects(path.join(expectedDir, "excluded.csv"));
  const priceRows = readCsvObjects(path.join(inputsDir, "prices.csv"));
  const masterRows = readCsvObjects(path.join(expectedDir, "item_master.csv"));
  const prices = buildPricesMap(priceRows);
  const master = masterRows.length;

  // run.json itself isn't a committed golden file - make_golden.py never
  // saves it separately - but every key it held is right there in the
  // golden Sources dump, in order, before report.py's own derived rows
  // start ("item master rows" is always the first of those, verbatim).
  // Reconstructing `run` from those rows and feeding it back through
  // buildReport() exercises the exact same key-order/join/type-preserving
  // logic report.js implements, whatever run.json originally held.
  const sourcesCells = golden.sheets.Sources.cells;
  const run = {};
  for (let r = 1; ; r++) {
    const keyCell = sourcesCells[`A${r}`];
    if (!keyCell || keyCell.v === "item master rows") break;
    const valCell = sourcesCells[`B${r}`];
    run[keyCell.v] = valCell ? valCell.v : "";
  }

  // YEAR/TOP are fixed constants in scripts/make_golden.py.
  const YEAR = 2025;
  const TOP = 25;

  const workbook = await buildReport({
    ranked,
    excluded,
    prices,
    run,
    master,
    year: YEAR,
    top: TOP,
    builtAt: "2026-06-01T12:00:00+00:00",
  });
  const reloaded = await reloadedWorkbook(workbook);
  const actual = dumpWorkbook(reloaded);

  checkDeep("sheet_order", actual.sheet_order, golden.sheet_order);
  for (const name of golden.sheet_order) {
    compareSheet(name, actual.sheets[name], golden.sheets[name]);
  }
}

// --------------------------------------------------- 3a. hand fixture, full

async function testHandFixtureFull() {
  console.log("hand fixture: full run.json + excluded.csv (tests/fixtures/report)");

  const ranked = readCsvObjects(path.join(PY_FIXTURES_DIR, "ranked.csv"));
  const priceRows = readCsvObjects(path.join(PY_FIXTURES_DIR, "prices.csv"));
  const prices = buildPricesMap(priceRows);

  const excluded = [
    {
      key: "amz:zip-ties",
      source: "amazon",
      raw_title: "ARTISTRO Zip Ties",
      amazon_category: "Grocery",
      packs: "5",
      reason: "include=n",
    },
    {
      key: "amz:unknown-thing",
      source: "amazon",
      raw_title: "Mystery Widget",
      amazon_category: "Office Product",
      packs: "2",
      reason: "not in item master",
    },
  ];

  const run = {
    year: 2025,
    amazon_file: "amazon-2025.xlsx",
    preferred_file: "preferred-2025.xlsx",
    amazon_rows: 1212,
    preferred_rows: 26,
    date_min: "2025-01-02",
    date_max: "2025-12-30",
    ingested_at: "2026-03-01T00:00:00+00:00",
    warnings: ["3 lines outside the reporting year"],
  };

  const workbook = await buildReport({
    ranked,
    excluded,
    prices,
    run,
    master: 30,
    year: 2025,
    top: 25,
    builtAt: "2026-06-01T00:00:00+00:00",
  });
  const ws = await reloadedWorkbook(workbook);
  const top = ws.getWorksheet("Top 25");

  eq("sheet names", JSON.stringify(ws.worksheets.map((w) => w.name)), JSON.stringify(["Top 25", "All items", "Excluded", "Sources"]));

  eq("B4 title", top.getCell("B4").value, "Top 25 Items By Quantity");
  eq("B4 bold", top.getCell("B4").font.bold, true);
  eq("B4 size", top.getCell("B4").font.size, 14);
  check("B4:N4 merged", top.model.merges.includes("B4:N4"), JSON.stringify(top.model.merges));

  eq("F5 band caption", top.getCell("F5").value, "Unit Price (per each)");
  eq("K5 band caption", top.getCell("K5").value, "Total Cost at 2025 volume");

  eq("B7 rank", top.getCell("B7").value, 1);
  eq("C7 name", top.getCell("C7").value, "Copy Paper 8.5x11 White");
  eq("D7 pack/size", top.getCell("D7").value, "1 RM");
  eq("E7 quantity", top.getCell("E7").value, 9600);
  eq("E7 number format", top.getCell("E7").numFmt, "#,##0");
  eq("F7 number format", top.getCell("F7").numFmt, "$#,##0.00");
  eq("K7 formula", top.getCell("K7").value.formula, "F7*E7");
  eq("N7 formula", top.getCell("N7").value.formula, "I7*E7");
  eq("C7 wraps", top.getCell("C7").alignment.wrapText, true);

  // Rank 5 (row 11) Preferred not_available; rank 12 (row 18) Staples
  // discontinued; rank 9 (row 15) Amazon unpriced.
  eq("G11 status text", top.getCell("G11").value, "not available");
  eq("I18 status text", top.getCell("I18").value, "Discontinued");
  eq("H15 status text", top.getCell("H15").value, "not priced");
  eq("L11 total mirrors status text", top.getCell("L11").value, "not available");
  eq("N18 total mirrors status text", top.getCell("N18").value, "Discontinued");
  eq("M15 total mirrors status text", top.getCell("M15").value, "not priced");

  const last = 31;
  eq("K32 vendor total label", top.getCell("K32").value, "Office Depot Total Cost");
  eq("N32 vendor total label", top.getCell("N32").value, "Staples Total Cost");
  eq("K33 totals formula", top.getCell("K33").value.formula, `SUM(K7:K${last})`);
  eq("F33 has no totals formula (unit-price band)", top.getCell("F33").value, null);
  eq("F34 priced-items formula", top.getCell("F34").value.formula, `COUNT(F7:F${last})&" / 25"`);

  const basketFormula = top.getCell("K35").value.formula;
  check("K35 excludes not-fully-priced rows", !basketFormula.includes("K11") && !basketFormula.includes("K15") && !basketFormula.includes("K18"), basketFormula);
  check("K35 includes a fully-priced row", basketFormula.includes("K7"), basketFormula);

  eq("B37 legend text", top.getCell("B37").value, "Lowest price for row item");

  const cfRefs = (top.conditionalFormattings || []).map((cf) => cf.ref).sort();
  checkDeep("conditional formatting ranges", cfRefs, [`F7:I${last}`, `K7:N${last}`]);
  const priceRule = top.conditionalFormattings.find((cf) => cf.ref === `F7:I${last}`).rules[0];
  eq("price CF formula", priceRule.formulae[0], "AND(ISNUMBER(F7),F7=MIN($F7:$I7))");

  eq("column B width", top.getColumn("B").width, 9);
  eq("column C width", top.getColumn("C").width, 60);
  eq("column J width", top.getColumn("J").width, 2);
  const frozen = (top.views || []).find((v) => v.state === "frozen");
  eq("freeze panes", frozen && frozen.topLeftCell, "C7");

  const allItems = ws.getWorksheet("All items");
  eq("All items A1 header", allItems.getCell("A1").value, "rank");
  eq("All items A1 bold", allItems.getCell("A1").font.bold, true);
  const allFrozen = (allItems.views || []).find((v) => v.state === "frozen");
  eq("All items freeze panes", allFrozen && allFrozen.topLeftCell, "A2");
  eq("All items autofilter", allItems.autoFilter, "A1:J31");
  const names = [];
  for (let r = 2; r <= 31; r++) names.push(allItems.getCell(r, 2).value);
  eq("All items has all 30 rows", names.length, 30);
  check("All items includes an item outside the top 25", names.includes("Binder 3-Ring 2 Inch White"), "");

  const excludedWs = ws.getWorksheet("Excluded");
  eq("Excluded A1 header", excludedWs.getCell("A1").value, "key");
  eq("Excluded row 2", excludedWs.getCell(2, 1).value, "amz:zip-ties");
  eq("Excluded row 3", excludedWs.getCell(3, 1).value, "amz:unknown-thing");

  const sources = ws.getWorksheet("Sources");
  const kv = {};
  for (let r = 1; r <= sources.rowCount; r++) {
    const k = sources.getCell(r, 1).value;
    if (k == null) continue;
    kv[k] = sources.getCell(r, 2).value;
  }
  eq("Sources year", kv.year, 2025);
  eq("Sources amazon_file", kv.amazon_file, "amazon-2025.xlsx");
  eq("Sources amazon_rows", kv.amazon_rows, 1212);
  eq("Sources warnings (joined list)", kv.warnings, "3 lines outside the reporting year");
  eq("Sources item master rows", kv["item master rows"], 30);
  eq("Sources top_n", kv.top_n, 25);
  eq("Sources unpriced cells", kv["unpriced cells"], 1);
  check("Sources report built at present", typeof kv["report built at"] === "string" && kv["report built at"].length > 0, "");
  const nonMaster = kv["items with upp_source != master"];
  for (const name of ["Sticky Notes 3x3 Yellow", "Rubber Bands Assorted Size", "Colored Copy Paper Assorted"]) {
    check(`Sources non-master list includes ${name}`, nonMaster.includes(name), nonMaster);
  }
  check("Sources non-master list excludes a master-sourced item", !nonMaster.includes("Copy Paper 8.5x11 White"), nonMaster);
}

// ------------------------------------------------ 3b. hand fixture, lenient

async function testHandFixtureLenient() {
  console.log("hand fixture: run.json/excluded/master all absent, top=3 (geometry scales)");

  const ranked = readCsvObjects(path.join(PY_FIXTURES_DIR, "ranked.csv"));
  const priceRows = readCsvObjects(path.join(PY_FIXTURES_DIR, "prices.csv"));
  const prices = buildPricesMap(priceRows);

  const workbook = await buildReport({
    ranked,
    excluded: null,
    prices,
    run: {},
    master: null,
    year: 2025,
    top: 3,
    builtAt: "2026-06-01T00:00:00+00:00",
  });
  const ws = await reloadedWorkbook(workbook);

  eq(
    "Excluded sheet skipped when absent",
    JSON.stringify(ws.worksheets.map((w) => w.name)),
    JSON.stringify(["Top 3", "All items", "Sources"])
  );

  const top = ws.getWorksheet("Top 3");
  eq("sheet name scales with top", top.name, "Top 3");
  eq("B4 title scales with top", top.getCell("B4").value, "Top 3 Items By Quantity");

  const last = 9; // 6 + 3
  eq("last data row rank", top.getCell(`B${last}`).value, 3);
  eq("last data row formula", top.getCell(`K${last}`).value.formula, `F${last}*E${last}`);

  const labelRow = 10;
  const totalsRow = 11;
  const pricedRow = 12;
  const basketRow = 13;
  eq("label row scales", top.getCell(`K${labelRow}`).value, "Office Depot Total Cost");
  eq("totals row formula scales", top.getCell(`K${totalsRow}`).value.formula, `SUM(K7:K${last})`);
  eq("priced row formula scales", top.getCell(`F${pricedRow}`).value.formula, `COUNT(F7:F${last})&" / 3"`);
  // All three top-3 items are fully priced by all four vendors in this fixture.
  eq("basket row formula (all three qualify)", top.getCell(`K${basketRow}`).value.formula, "SUM(K7,K8,K9)");

  const legendRow = basketRow + 2;
  eq("legend row scales", top.getCell(`B${legendRow}`).value, "Lowest price for row item");

  const cfRefs = (top.conditionalFormattings || []).map((cf) => cf.ref).sort();
  checkDeep("CF ranges scale with top", cfRefs, [`F7:I${last}`, `K7:N${last}`]);

  const sources = ws.getWorksheet("Sources");
  const kv = {};
  for (let r = 1; r <= sources.rowCount; r++) {
    const k = sources.getCell(r, 1).value;
    if (k == null) continue;
    kv[k] = sources.getCell(r, 2).value;
  }
  eq("item master rows is null when master is absent", kv["item master rows"], null);
  eq("top_n still written with no run.json", kv.top_n, 3);
  check("report built at still present with no run.json", typeof kv["report built at"] === "string", "");
}

(async () => {
  try {
    await testXlsxio();
  } catch (e) {
    fail++;
    console.log(`  FAIL  xlsxio tests threw: ${e && e.stack ? e.stack : e}`);
  }

  try {
    if (fs.existsSync(path.join(GOLDEN_DIR, "expected", "report.json"))) {
      await testGoldenReport();
    } else {
      fail++;
      console.log("  FAIL  golden fixture missing: src/tests/golden/expected/report.json not found");
    }
  } catch (e) {
    fail++;
    console.log(`  FAIL  golden report test threw: ${e && e.stack ? e.stack : e}`);
  }

  try {
    await testHandFixtureFull();
  } catch (e) {
    fail++;
    console.log(`  FAIL  hand fixture (full) threw: ${e && e.stack ? e.stack : e}`);
  }

  try {
    await testHandFixtureLenient();
  } catch (e) {
    fail++;
    console.log(`  FAIL  hand fixture (lenient) threw: ${e && e.stack ? e.stack : e}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
