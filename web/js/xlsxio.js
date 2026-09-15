// xlsxio.js — Excel I/O for the Supply Top N browser app.
//
// Vendored library: ExcelJS 4.4.0 (dated 19-10-2023 per its own banner comment)
// Source:  https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js
// Vendored at: ../vendor/exceljs.min.js (pinned to the exact version above,
// not the floating `@4` tag, so it can be re-fetched byte-for-byte later).
//
// This is the ONE place that resolves the ExcelJS library, in either
// environment, so every other module (report.js, app.js) gets it through
// newWorkbook()/toArrayBuffer() instead of importing ExcelJS directly:
//   - Browser: vendor/exceljs.min.js is loaded first as a plain (non-module)
//     <script> tag, which attaches `window.ExcelJS`. This module just reads
//     that global — no bundler, no fetch of its own.
//   - Node: the vendored file is a UMD build (it does
//     `module.exports = factory()` when `typeof module !== 'undefined'`), so
//     it can be required directly. We reach `require` from this ES module
//     via `createRequire`, no bundler needed there either.
//
// readTable() ports supplytrack.xlsx.read_table (see src/supplytrack/xlsx.py):
// same header normalisation (strip, collapse internal whitespace, casefold),
// same "first sheet unless named" default, same blank-row-drop /
// short-row-pad behaviour on the body rows.

let excelJSPromise;

function loadExcelJS() {
  if (!excelJSPromise) {
    excelJSPromise = (async () => {
      if (typeof globalThis !== "undefined" && globalThis.ExcelJS) {
        // Browser (or any host that pre-attached the global itself).
        return globalThis.ExcelJS;
      }
      // Node. Dynamic imports so a browser module graph never even tries to
      // resolve 'node:module' — a static top-level import of it would break
      // the browser load, even on a branch that never runs there.
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      return require("../vendor/exceljs.min.js");
    })();
  }
  return excelJSPromise;
}

/** A fresh ExcelJS Workbook, from whichever environment this is running in. */
export async function newWorkbook() {
  const ExcelJS = await loadExcelJS();
  return new ExcelJS.Workbook();
}

/**
 * Serialise a built workbook to an ArrayBuffer, suitable for a Blob download
 * in the browser or for writing to disk with fs in Node.
 */
export async function toArrayBuffer(workbook) {
  const buf = await workbook.xlsx.writeBuffer();
  if (buf instanceof ArrayBuffer) return buf;
  // Node Buffer, or the browser build's Buffer polyfill — both are
  // Uint8Array subclasses backed by .buffer/.byteOffset/.byteLength, which
  // may be a larger, shared, or pooled ArrayBuffer, so copy out exactly the
  // written bytes rather than handing back the whole backing buffer.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Mirrors supplytrack.xlsx.norm_header: strip, collapse internal whitespace,
 * casefold. JS has no true Unicode casefold; every header this tool matches
 * on is plain ASCII, so toLowerCase() is byte-identical to Python's
 * str.casefold() in practice here.
 */
export function normHeader(h) {
  return String(h == null ? "" : h)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Flatten one ExcelJS cell value to the same shape supplytrack.xlsx hands
 * the pipeline: Date objects for dates, plain numbers/strings/booleans, and
 * — for a formula cell — its cached result, never the formula text. Rich
 * text is flattened to its plain concatenated string, matching what
 * openpyxl's data_only load already gives Python (a plain string, not a
 * run list).
 */
function flattenCellValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value.richText)) {
    return value.richText.map((run) => (run && run.text) || "").join("");
  }
  if ("result" in value) {
    // Formula and shared-formula cells both normalise to {result, ...}.
    return flattenCellValue(value.result);
  }
  if ("error" in value) {
    return value.error;
  }
  if ("hyperlink" in value && "text" in value) {
    return flattenCellValue(value.text);
  }
  return value;
}

/**
 * Every sheet of a workbook as {name, grid}, with nothing normalised.
 *
 * Ports supplytrack.xlsx.sheet_grids: the caller decides which row is the
 * header, so blank and short rows are left exactly where they are and row
 * positions are preserved. This is what sheet recognition scans, and it is the
 * only way a workbook holding the finished table, a scratch sheet and the two
 * raw exports can be handed over as one file.
 */
export async function readSheets(arrayBufferOrBuffer) {
  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(arrayBufferOrBuffer);
  return workbook.worksheets.map((worksheet) => {
    const grid = [];
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      const values = row.values; // 1-indexed: values[0] is always empty.
      const cells = [];
      for (let i = 1; i < values.length; i++) cells.push(flattenCellValue(values[i]));
      grid.push(cells);
    });
    return { name: worksheet.name, grid };
  });
}

/**
 * Read a workbook's first sheet (or `sheetName`) as {headers, rows}.
 * `headers` are normalised (see normHeader); `rows` are arrays of raw cell
 * values aligned to the header row's width — short rows are padded with
 * null, and rows that are entirely blank are dropped, exactly as
 * supplytrack.xlsx.read_table does on the Python side.
 */
export async function readTable(arrayBufferOrBuffer, { sheetName } = {}) {
  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(arrayBufferOrBuffer);

  let worksheet;
  if (sheetName == null) {
    worksheet = workbook.worksheets[0];
  } else {
    worksheet = workbook.getWorksheet(sheetName);
    if (!worksheet) {
      const names = workbook.worksheets.map((ws) => ws.name).join(", ");
      throw new Error(`No sheet named ${JSON.stringify(sheetName)}. It has: ${names}.`);
    }
  }
  if (!worksheet) {
    throw new Error("Workbook has no sheets.");
  }

  const raw = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const values = row.values; // 1-indexed: values[0] is always empty.
    const cells = [];
    for (let i = 1; i < values.length; i++) {
      cells.push(flattenCellValue(values[i]));
    }
    raw.push(cells);
  });

  if (raw.length === 0) {
    throw new Error("Sheet is empty - there is no header row to read.");
  }

  const headers = raw[0].map(normHeader);
  const width = headers.length;
  const rows = [];
  for (const row of raw.slice(1)) {
    const isBlank = row.every((c) => c == null || String(c).trim() === "");
    if (isBlank) continue;
    const padded = row.slice();
    while (padded.length < width) padded.push(null);
    rows.push(padded);
  }
  return { headers, rows };
}
