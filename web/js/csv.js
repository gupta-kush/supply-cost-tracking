/* RFC 4180 CSV parse and serialise, byte-compatible with Python's `csv` module.
 *
 * The CLI and this page write the same files (spec.md Appendix A), so a file
 * written by either has to read back identically in the other. That means
 * matching Python's `csv.writer` exactly rather than approximately: it quotes a
 * field only when the field itself forces it, and a naive serialiser that
 * quotes on leading whitespace produces a file that is still valid CSV but no
 * longer byte-identical to the reference implementation.
 *
 * Pure: no DOM, no fetch, no Node APIs. Imports cleanly in a browser and in
 * Node 18+.
 */

/** Python's default dialect writes CRLF, because the file is opened newline="". */
export const LINE_TERMINATOR = "\r\n";

/**
 * Parse CSV text into an array of arrays of strings.
 *
 * Tolerates CRLF, LF and lone CR line endings, strips a UTF-8 BOM, and reads
 * doubled quotes inside a quoted field as one literal quote. A trailing newline
 * does not produce a final empty row; a genuinely blank line in the middle of
 * the file does produce a `[""]` row, exactly as Python's `csv.reader` does.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parse(text) {
  let s = String(text ?? "");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // UTF-8 BOM

  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let inQuotes = false;
  let sawAnyChar = false;

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];

    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      sawAnyChar = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      sawAnyChar = true;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && s[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAnyChar = false;
      continue;
    }
    field += ch;
    sawAnyChar = true;
  }

  // A file ending in a newline has nothing pending; anything else is a last row.
  if (inQuotes || field !== "" || row.length > 0 || sawAnyChar) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * True when Python's QUOTE_MINIMAL would wrap this field in quotes.
 *
 * Only the delimiter, the quote character and the line terminator's own
 * characters force quoting. Leading and trailing spaces do not, which is where
 * most hand-rolled serialisers diverge.
 */
function needsQuoting(value) {
  return (
    value.indexOf(",") !== -1 ||
    value.indexOf('"') !== -1 ||
    value.indexOf("\r") !== -1 ||
    value.indexOf("\n") !== -1
  );
}

function quoteField(value, onlyFieldInRow) {
  // CPython's _csv.c special case: a row of exactly one empty field is written
  // as `""` so the line is not indistinguishable from a blank line.
  if (value === "" && onlyFieldInRow) return '""';
  if (needsQuoting(value)) return '"' + value.replace(/"/g, '""') + '"';
  return value;
}

/**
 * Serialise rows to CSV text with CRLF line endings, matching `csv.writer`.
 *
 * `null` and `undefined` become the empty string (Python writes "" for None);
 * everything else is stringified. A trailing line terminator is written after
 * the last row, as Python does.
 *
 * @param {Array<Array<unknown>>} rows
 * @returns {string}
 */
export function serialise(rows) {
  const out = [];
  for (const row of rows ?? []) {
    const cells = Array.from(row ?? []);
    const only = cells.length === 1;
    out.push(cells.map((c) => quoteField(c == null ? "" : String(c), only)).join(","));
  }
  return out.length ? out.join(LINE_TERMINATOR) + LINE_TERMINATOR : "";
}

/**
 * Parse CSV text into row objects keyed by the header row, like `csv.DictReader`.
 *
 * Short rows fill missing columns with "". Extra cells beyond the header are
 * dropped, which is what the pipeline wants: every reader here works from a
 * known column list.
 *
 * @param {string} text
 * @returns {{header: string[], rows: Array<Record<string,string>>}}
 */
export function parseObjects(text) {
  const table = parse(text);
  if (!table.length) return { header: [], rows: [] };
  const header = table[0].map((h) => String(h ?? ""));
  const rows = table.slice(1).map((cells) => {
    /** @type {Record<string,string>} */
    const obj = {};
    header.forEach((name, i) => {
      obj[name] = cells[i] == null ? "" : String(cells[i]);
    });
    return obj;
  });
  return { header, rows };
}

/**
 * Serialise row objects in an explicit column order, like `csv.DictWriter`.
 *
 * @param {string[]} columns
 * @param {Array<Record<string, unknown>>} rows
 * @returns {string}
 */
export function serialiseObjects(columns, rows) {
  const table = [columns.slice()];
  for (const row of rows ?? []) {
    table.push(columns.map((c) => (row[c] == null ? "" : row[c])));
  }
  return serialise(table);
}

export default { parse, serialise, parseObjects, serialiseObjects, LINE_TERMINATOR };
