// report.js — builds the leadership workbook (the Top N comparison plus
// supporting sheets), ported from supplytrack/report.py. Read that file
// alongside this one; comments here call out only where the JS port differs
// from the Python original and why.
//
// This module returns a built ExcelJS Workbook; callers serialise it with
// xlsxio.toArrayBuffer() for a download, or open it directly in Node tests.
import { newWorkbook } from "./xlsxio.js";
import {
  CARRY_COLUMNS,
  CARRY_LABELS,
  CARRY_WIDTH_DEFAULT,
  CARRY_WIDTHS,
  INTEGER_COLUMNS,
  isCanonicalInt,
} from "./pipeline.js";

const PRICE_FORMAT = "$#,##0.00";
const QTY_FORMAT = "#,##0";

// Mirrors supplytrack.prices.STATUS_TEXT.
const STATUS_TEXT = {
  not_available: "not available",
  discontinued: "Discontinued",
  unpriced: "not priced",
};

// Mirrors supplytrack.prices.VENDORS (column order, left to right).
const VENDORS = ["Office Depot", "Preferred", "Amazon", "Staples"];
const PRICE_COLS = ["F", "G", "H", "I"];
const TOTAL_COLS = ["K", "L", "M", "N"];

// Every ARGB below carries an "00" alpha byte, not "FF". That is not a typo:
// openpyxl's PatternFill(fgColor="DDEBF7") (a 6-hex-digit RGB with no alpha
// given) pads to "00DDEBF7", and Excel renders a solid fill from RGB only,
// ignoring the alpha byte either way. Verified bit-for-bit by building
// report.py against this port's own fixtures/report/*.csv and inspecting
// the raw styles.xml it writes - so a byte-level fill comparison against
// the Python-built golden workbook matches exactly.
const VENDOR_HEADER_ARGB = {
  "Office Depot": "00DDEBF7",
  Preferred: "00E2EFDA",
  Amazon: "00FCE4D6",
  Staples: "00E4DFEC",
};
const LEGEND_ARGB = "00FFF2CC";

// The order the three carry sheets are written in, mirroring
// supplytrack.report.CARRY_SOURCES.
const CARRY_ORDER = ["item_master", "prices", "prices_retired"];

// Printed on the Sources sheet rather than above a carry sheet's header row:
// the classifier looks for the header in row 1, so nothing may sit above it.
// Mirrors supplytrack.report.CARRY_NOTE.
const CARRY_NOTE =
  "The Item master, Prices and Prices retired sheets are read back next year. " +
  "Do not edit them by hand.";

const TITLE_FONT = Object.freeze({ bold: true, size: 14 });
const BOLD = Object.freeze({ bold: true });

function fgFill(argb) {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

// Conditional-formatting (dxf) fill: verified against the same reference
// build that a *solid* dxf fill's visible color is bgColor, not fgColor -
// the same quirk report.py's CF_HIGHLIGHT_FILL comment describes for
// openpyxl, and ExcelJS reproduces it identically (both just implement the
// OOXML differential-style-fill rule). Using fgColor here would add a rule
// that never visibly highlights anything.
function bgFill(argb) {
  return { type: "pattern", pattern: "solid", bgColor: { argb } };
}

const LEGEND_CELL_FILL = fgFill(LEGEND_ARGB);
const CF_HIGHLIGHT_FILL = bgFill(LEGEND_ARGB);

function columnLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function hasUsablePrice(cellData) {
  return (
    !!cellData &&
    cellData.status === "priced" &&
    cellData.unitPrice != null &&
    String(cellData.unitPrice).trim() !== ""
  );
}

function getPriceCell(prices, canonicalName, vendor) {
  const byVendor = prices[canonicalName];
  return (byVendor && byVendor[vendor]) || null;
}

// Works around a real bug in the vendored ExcelJS 4.4.0: Column#isCustomWidth
// is implemented as `width !== undefined && width !== 9` (verified by
// reading the vendored source directly), so a column whose width is set to
// EXACTLY 9 is indistinguishable from an untouched, default-width column and
// is silently dropped from the saved <cols> element - the sheet falls back
// to its implicit default width instead. Confirmed by round-tripping a
// worksheet through writeBuffer()/load(): width 8, 8.43, 9.1 and 10 all
// survive; only 9 does not. report.py sets column B's width to exactly 9,
// so this bites on every "Top N" sheet unless worked around. The width
// value itself was never wrong - only ExcelJS's "does this column need an
// explicit entry" check - so shadow the prototype getter with an own-property
// override forcing this one column to always be treated as custom.
function setColumnWidth(ws, letter, width) {
  const column = ws.getColumn(letter);
  column.width = width;
  if (width === 9) {
    Object.defineProperty(column, "isCustomWidth", { value: true, configurable: true });
  }
  return column;
}

/**
 * Build the full workbook: "Top N", "All items", optional "Excluded", and
 * "Sources". Returns an ExcelJS Workbook (not yet serialised).
 *
 * @param {object} args
 * @param {Array<object>} args.ranked - every row of ranked.csv (already
 *   parsed to plain objects with STRING values, one property per CSV
 *   column - i.e. exactly what csv.js/pipeline.js hand back, mirroring
 *   Python's csv.DictReader rows). Used in full for "All items" and sliced
 *   to the top N (sorted by `rank`) for the "Top N" sheet. Must include at
 *   least: rank, canonical_name, eaches, unit_label, upp_source.
 * @param {Array<object>|null|undefined} args.excluded - excluded.csv rows in
 *   the same shape as `ranked`, or null/undefined when excluded.csv does not
 *   exist at all (mirrors report.py: the "Excluded" sheet is only built when
 *   the file is present - not merely non-empty; an existing-but-empty file
 *   should be passed as `[]`, which still yields the sheet, just with
 *   nothing written to it, exactly as _build_table_sheet behaves on an
 *   empty row list).
 * @param {object} args.prices - prices[canonicalName][vendor] = { status,
 *   unitPrice }. `status` is one of "priced" | "not_available" |
 *   "discontinued" | "unpriced" (supplytrack.prices.VALID_STATUSES).
 *   `unitPrice` is a CLEANED decimal string (no "$", no thousands commas -
 *   the same shape supplytrack.prices._parse_unit_price produces) or
 *   null/"" when not priced. Only entries for canonicalName/vendor pairs
 *   that exist need be present; a missing pair is treated the same as
 *   status "not_available", matching report.py's `cell_data is None` branch.
 * @param {object} args.run - parsed run.json (or {} if absent). Every key
 *   is written to "Sources" via a small pair loop; an array value is joined
 *   with "; ", matching report.py exactly.
 * @param {number|null} args.master - item_master.csv row count, or null/
 *   undefined when that file does not exist (mirrors `master_row_count`).
 * @param {Array<object>} args.masterRows - item_master.csv rows, in the order
 *   that file holds them (sorted by key - what masterToCsv writes), as plain
 *   objects of STRING values. Written to the "Item master" sheet so next
 *   year's upload can read them straight back out.
 * @param {Array<object>} args.priceRows - prices.csv rows for this year, in
 *   file order, for the "Prices" sheet.
 * @param {Array<object>} args.retiredRows - prices_retired.csv rows, for the
 *   "Prices retired" sheet. All three default to empty; each sheet is written
 *   either way, so a workbook always carries the same three sheets.
 * @param {number} args.year
 * @param {number} args.top
 * @param {string} args.builtAt - ISO 8601 timestamp for the "report built
 *   at" row. report.py computes this itself at call time
 *   (datetime.now(timezone.utc).isoformat()); the JS port takes it as an
 *   argument instead so a build is reproducible/testable without a clock.
 * @returns {Promise<import("exceljs").Workbook>}
 */
export async function buildReport({
  ranked,
  excluded,
  prices,
  run,
  master,
  masterRows,
  priceRows,
  retiredRows,
  year,
  top,
  builtAt,
}) {
  const rankedRows = ranked || [];
  const priceMap = prices || {};
  const runInfo = run || {};

  const topRows = rankedRows
    .slice()
    .sort((a, b) => Number(a.rank) - Number(b.rank))
    .slice(0, top);

  const workbook = await newWorkbook();

  buildTopSheet(workbook, topRows, priceMap, year, top);
  buildTableSheet(workbook, "All items", rankedRows);
  if (excluded != null) {
    buildTableSheet(workbook, "Excluded", excluded);
  }
  const unpricedCount = countUnpriced(priceMap);
  buildSourcesSheet(workbook, runInfo, master, rankedRows, top, unpricedCount, builtAt);

  const carry = {
    item_master: masterRows || [],
    prices: priceRows || [],
    prices_retired: retiredRows || [],
  };
  for (const kind of CARRY_ORDER) buildCarrySheet(workbook, kind, carry[kind]);

  return workbook;
}

/**
 * One carry-sheet cell, typed so the CSV survives the round trip. Ports
 * supplytrack.report._write_carry_cell.
 *
 * Everything is written as text except the whole-number columns
 * (INTEGER_COLUMNS), so a unit price typed as 1.250 comes back spelled that way
 * instead of as 1.25, and a date stays the ISO string the rest of the pipeline
 * writes rather than becoming a date cell with a display format of its own. An
 * integer column is only written as a number when its text is already that
 * integer's one spelling - 007 stays text, because 7 would not be the same file.
 *
 * report.py also forces the cell's type to text, because openpyxl reads a
 * string starting with "=" as a formula. ExcelJS has no such rule - a string is
 * a string - so there is nothing to force here, and the two agree anyway.
 */
function carryCellValue(text, column) {
  if (text === "") return null;
  if (INTEGER_COLUMNS.has(column) && isCanonicalInt(text)) return parseInt(text, 10);
  return text;
}

/**
 * One of the three sheets that carry a data file forward into next year.
 *
 * The header row is row 1 with nothing above it, because that is where the
 * sheet classifier looks for it; the guidance that these sheets are machine
 * read lives on the Sources sheet instead (CARRY_NOTE). The sheet is written
 * even when there is nothing in it, so next year's upload finds the same three
 * sheets whether or not any prices were retired this year.
 */
function buildCarrySheet(workbook, kind, rows) {
  const columns = CARRY_COLUMNS[kind];
  const ws = workbook.addWorksheet(CARRY_LABELS[kind]);
  columns.forEach((header, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = header;
    cell.font = BOLD;
  });
  rows.forEach((row, rIdx) => {
    columns.forEach((header, cIdx) => {
      const raw = row[header];
      const text = raw == null ? "" : String(raw);
      ws.getCell(rIdx + 2, cIdx + 1).value = carryCellValue(text, header);
    });
  });
  columns.forEach((header, i) => {
    setColumnWidth(
      ws,
      columnLetter(i + 1),
      Object.prototype.hasOwnProperty.call(CARRY_WIDTHS, header)
        ? CARRY_WIDTHS[header]
        : CARRY_WIDTH_DEFAULT
    );
  });
  ws.views = [{ state: "frozen", ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft" }];
  return ws;
}

function countUnpriced(prices) {
  let count = 0;
  for (const byVendor of Object.values(prices)) {
    for (const cellData of Object.values(byVendor)) {
      if (cellData && cellData.status === "unpriced") count++;
    }
  }
  return count;
}

function buildTopSheet(workbook, topRows, prices, year, top) {
  const ws = workbook.addWorksheet(`Top ${top}`);
  const first = 7;
  const last = 6 + top;

  ws.getCell("B4").value = `Top ${top} Items By Quantity`;
  ws.getCell("B4").font = TITLE_FONT;
  ws.mergeCells("B4:N4");

  ws.getCell("F5").value = "Unit Price (per each)";
  ws.mergeCells("F5:I5");
  ws.getCell("K5").value = `Total Cost at ${year} volume`;
  ws.mergeCells("K5:N5");

  ws.getCell("B6").value = "Ranking";
  ws.getCell("C6").value = "Description";
  ws.getCell("D6").value = "Pack/Size";
  ws.getCell("E6").value = "Quantity";
  for (const col of ["B", "C", "D", "E"]) {
    ws.getCell(`${col}6`).font = BOLD;
  }
  PRICE_COLS.forEach((col, i) => {
    const vendor = VENDORS[i];
    const cell = ws.getCell(`${col}6`);
    cell.value = vendor;
    cell.font = BOLD;
    cell.fill = fgFill(VENDOR_HEADER_ARGB[vendor]);
  });
  TOTAL_COLS.forEach((col, i) => {
    const vendor = VENDORS[i];
    const cell = ws.getCell(`${col}6`);
    cell.value = vendor;
    cell.font = BOLD;
    cell.fill = fgFill(VENDOR_HEADER_ARGB[vendor]);
  });

  topRows.forEach((row, offset) => {
    const r = first + offset;
    const canonicalName = row.canonical_name;
    const unitLabel = (row.unit_label || "").trim();

    ws.getCell(`B${r}`).value = parseInt(row.rank, 10);
    const cCell = ws.getCell(`C${r}`);
    cCell.value = canonicalName;
    // Per-cell wrap, not a column-wide default: see the note by
    // getColumn("C") below on why a column-level style is deliberately not
    // used here.
    cCell.alignment = { wrapText: true };
    ws.getCell(`D${r}`).value = unitLabel ? `1 ${unitLabel}` : "1";
    const eCell = ws.getCell(`E${r}`);
    eCell.value = parseInt(row.eaches, 10);
    eCell.numFmt = QTY_FORMAT;

    PRICE_COLS.forEach((priceCol, i) => {
      const totalCol = TOTAL_COLS[i];
      const vendor = VENDORS[i];
      const priceCell = ws.getCell(`${priceCol}${r}`);
      const totalCell = ws.getCell(`${totalCol}${r}`);
      const cellData = getPriceCell(prices, canonicalName, vendor);
      if (hasUsablePrice(cellData)) {
        priceCell.value = Number(cellData.unitPrice);
        priceCell.numFmt = PRICE_FORMAT;
        totalCell.value = { formula: `${priceCol}${r}*E${r}` };
        totalCell.numFmt = PRICE_FORMAT;
      } else {
        const status = cellData ? cellData.status : "not_available";
        const text = STATUS_TEXT[status] || status;
        priceCell.value = text;
        totalCell.value = text;
      }
    });
  });

  // Column J is a visual divider between the unit-price and total-cost
  // bands, for the header row and every data row.
  for (let r = 6; r <= last; r++) {
    ws.getCell(`J${r}`).fill = LEGEND_CELL_FILL;
  }

  const labelRow = last + 1;
  const totalsRow = last + 2;
  const pricedRow = last + 3;
  const basketRow = last + 4;

  TOTAL_COLS.forEach((col, i) => {
    const cell = ws.getCell(`${col}${labelRow}`);
    cell.value = `${VENDORS[i]} Total Cost`;
    cell.font = BOLD;
  });

  ws.getCell(`C${totalsRow}`).value = "Total Cost";
  ws.getCell(`C${totalsRow}`).font = BOLD;
  for (const col of TOTAL_COLS) {
    const cell = ws.getCell(`${col}${totalsRow}`);
    cell.value = { formula: `SUM(${col}${first}:${col}${last})` };
    cell.numFmt = PRICE_FORMAT;
  }

  ws.getCell(`C${pricedRow}`).value = "Priced items";
  ws.getCell(`C${pricedRow}`).font = BOLD;
  for (const col of PRICE_COLS) {
    ws.getCell(`${col}${pricedRow}`).value = {
      formula: `COUNT(${col}${first}:${col}${last})&" / ${top}"`,
    };
  }

  const qualifyingRows = [];
  topRows.forEach((row, offset) => {
    const r = first + offset;
    const canonicalName = row.canonical_name;
    const allPriced = VENDORS.every((vendor) => hasUsablePrice(getPriceCell(prices, canonicalName, vendor)));
    if (allPriced) qualifyingRows.push(r);
  });

  ws.getCell(`C${basketRow}`).value = "Comparable basket";
  ws.getCell(`C${basketRow}`).font = BOLD;
  for (const col of TOTAL_COLS) {
    const cell = ws.getCell(`${col}${basketRow}`);
    if (qualifyingRows.length) {
      cell.value = { formula: `SUM(${qualifyingRows.map((r) => `${col}${r}`).join(",")})` };
    } else {
      cell.value = 0;
    }
    cell.numFmt = PRICE_FORMAT;
  }

  const legendRow = basketRow + 2;
  ws.getCell(`B${legendRow}`).value = "Lowest price for row item";
  ws.getCell(`B${legendRow}`).fill = LEGEND_CELL_FILL;

  ws.addConditionalFormatting({
    ref: `F${first}:I${last}`,
    rules: [
      {
        type: "expression",
        formulae: [`AND(ISNUMBER(F${first}),F${first}=MIN($F${first}:$I${first}))`],
        style: { fill: CF_HIGHLIGHT_FILL },
      },
    ],
  });
  ws.addConditionalFormatting({
    ref: `K${first}:N${last}`,
    rules: [
      {
        type: "expression",
        formulae: [`AND(ISNUMBER(K${first}),K${first}=MIN($K${first}:$N${first}))`],
        style: { fill: CF_HIGHLIGHT_FILL },
      },
    ],
  });

  setColumnWidth(ws, "B", 9);
  setColumnWidth(ws, "C", 60);
  setColumnWidth(ws, "D", 10);
  setColumnWidth(ws, "E", 11);
  for (const col of PRICE_COLS) setColumnWidth(ws, col, 13);
  setColumnWidth(ws, "J", 2);
  for (const col of TOTAL_COLS) setColumnWidth(ws, col, 15);
  // report.py also sets ws.column_dimensions["C"].alignment = wrap_text, as
  // a column-wide default alongside the per-row wrap set above (belt and
  // braces on the Python side - every C-column data cell already gets its
  // own explicit alignment in the same loop). That is deliberately NOT
  // ported: ExcelJS's column `.alignment` becomes part of the *merged*
  // style of every other styled cell in that column (verified against a
  // reference build - a column alignment default plus a cell's own
  // unrelated font produced ONE merged style carrying both, where
  // openpyxl/Excel keep a cell's own explicit style independent of the
  // column default unless the cell has no style of its own). Column C's
  // BOLD-only label cells (C{totalsRow}, C{pricedRow}, C{basketRow}) must
  // NOT wrap in the source workbook, so adding the column-level style here
  // would wrap them anyway - a regression a plain per-row wrap avoids. Net
  // visual result is identical to report.py's: every cell that should wrap
  // does, and no cell that shouldn't gets wrapped.

  ws.views = [
    { state: "frozen", xSplit: 2, ySplit: 6, topLeftCell: "C7", activePane: "bottomRight" },
  ];

  return ws;
}

function buildTableSheet(workbook, name, rows) {
  const ws = workbook.addWorksheet(name);
  const headers = rows.length ? Object.keys(rows[0]) : [];

  headers.forEach((header, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = header;
    cell.font = BOLD;
  });
  rows.forEach((row, rIdx) => {
    headers.forEach((header, cIdx) => {
      // A blank CSV field must land as a genuinely empty cell, not a cell
      // holding "". openpyxl round-trips a cell explicitly written with ""
      // back to None (verified directly), so report.py's
      // `row.get(header, "")` produces no visible cell at all for a blank
      // field - not an empty-string one. ExcelJS does not have that same
      // round-trip collapse (an explicit "" stays "" on reload, confirmed
      // by testing), so it has to be done here instead: write null, never
      // "", to match what the golden workbook actually contains.
      const value = row[header];
      ws.getCell(rIdx + 2, cIdx + 1).value = value == null || value === "" ? null : value;
    });
  });
  if (headers.length) {
    const lastCol = columnLetter(headers.length);
    const lastRow = rows.length + 1;
    ws.autoFilter = `A1:${lastCol}${lastRow}`;
  }
  ws.views = [{ state: "frozen", ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft" }];
  return ws;
}

function buildSourcesSheet(workbook, runInfo, masterRowCount, rankedRows, top, unpricedCount, builtAt) {
  const ws = workbook.addWorksheet("Sources");
  let r = 1;
  const writePair = (key, value) => {
    ws.getCell(r, 1).value = key;
    // See the identical note in buildTableSheet: "" must become null so an
    // empty value renders as no cell at all, matching what openpyxl's own
    // "" -> None round-trip leaves in the golden workbook.
    ws.getCell(r, 2).value = value === "" ? null : value;
    r += 1;
  };

  for (const [key, value] of Object.entries(runInfo)) {
    writePair(key, Array.isArray(value) ? value.join("; ") : value);
  }

  writePair("item master rows", masterRowCount != null ? masterRowCount : "");

  const nonMaster = rankedRows
    .filter((row) => (row.upp_source || "") !== "master")
    .map((row) => row.canonical_name);
  writePair("items with upp_source != master", nonMaster.join("; "));

  writePair("top_n", top);
  writePair("unpriced cells", unpricedCount);
  writePair("report built at", builtAt);
  // Last, so nothing is inserted above the run.json rows a reader walks.
  writePair("keep this workbook", CARRY_NOTE);

  setColumnWidth(ws, "A", 32);
  setColumnWidth(ws, "B", 70);
  return ws;
}
