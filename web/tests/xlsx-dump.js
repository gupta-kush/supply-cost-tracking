/* xlsx-dump.js - structural workbook dump shared by report-tests.js and
 * headless-report-parity.js, so the two never compare workbooks two
 * different ways. Mirrors src/scripts/make_golden.py's dump_workbook():
 * same {v,f,t} cell shape, same fill payload shape, same sorted
 * merged_cells/conditional formatting, same "<TIMESTAMP>" masking for
 * ISO-looking wall-clock strings, which is what lets two workbooks built at
 * different moments still compare equal everywhere that is not the clock.
 *
 * No DOM, no pipeline import: this only ever receives an already-built
 * ExcelJS workbook (freshly built or reloaded from a file) and reads it.
 */

export const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
export const TIMESTAMP_TOKEN = "<TIMESTAMP>";

export function maskScalar(v) {
  if (typeof v === "string" && TIMESTAMP_RE.test(v)) return TIMESTAMP_TOKEN;
  return v;
}

export function deepEqual(a, b) {
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
      // master's value/fill when read back (ExcelJS-only behaviour), so skip
      // it here or every merge counts as N extra populated cells.
      if (cellObj.master !== cellObj) continue;
      const fill = cellObj.fill;
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

export function dumpWorkbook(workbook) {
  const sheets = {};
  for (const ws of workbook.worksheets) {
    sheets[ws.name] = dumpSheet(ws);
  }
  return { sheet_order: workbook.worksheets.map((w) => w.name), sheets };
}
