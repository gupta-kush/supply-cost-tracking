/* app.js - the page itself: files in, review, ranking, prices, downloads.
 *
 * This module owns the DOM and nothing else. Every rule about what an item is, what blocks a
 * build and what the report says lives in pipeline.js and report.js, which are ports of the
 * Python reference in ../../supplytrack. If a number looks wrong, it is wrong there, not here.
 *
 * Three things shape the code below:
 *
 *  - No network calls, ever. Files are read with FileReader, results are handed back as blobs.
 *    The page works with the machine offline, which is what makes the footer line true.
 *  - No state outside this tab. Nothing is written to storage except the theme and the top-N
 *    box, neither of which is data. Close the tab and the session is gone; the CSVs are the
 *    memory, exactly as the workbook was.
 *  - The logic modules are loaded with a dynamic import inside try/catch, and every call into
 *    them goes through the `pipe` adapter near the top. They are written by other hands and
 *    their exact export names may move; when they do, this is the one block that changes.
 */

import * as csvlib from "./csv.js";
import * as xlsxio from "./xlsxio.js";

// The inline script in index.html watches for this. Set it as early as possible: if the module
// graph loaded at all, the page can report its own problems from here on.
window.__supplytrackReady = true;

/* ───────────────────────────── constants ───────────────────────────── */

// spec.md Appendix A, exact column order. Files have to round-trip between the CLI and here.
const MASTER_COLUMNS = [
  "key", "source", "raw_title", "include", "canonical_name", "units_per_pack",
  "unit_label", "upp_source", "amazon_category", "first_seen", "last_seen", "note",
];
const PRICE_COLUMNS = [
  "rank", "canonical_name", "vendor", "unit_price", "status", "url", "checked_on", "note",
];
const VENDORS = ["Office Depot", "Preferred", "Amazon", "Staples"];

// spec.md 4.2: only "unknown key" and "pack size missing" stop the build.
const BLOCKING_REASONS = new Set(["unknown key", "pack size missing"]);
const REASON_ORDER = ["unknown key", "pack size missing", "pack size unconfirmed"];

const STATUS_OPTIONS = [
  ["unpriced", "unpriced"],
  ["priced", "priced"],
  ["not_available", "not available"],
  ["discontinued", "discontinued"],
];

/** How a vendor is named on screen. pipeline.js uses the lower-case keys. */
const VENDOR_NAMES = { amazon: "Amazon", preferred: "Preferred" };

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/* ───────────────────────────── state ───────────────────────────── */

const state = {
  files: { exports: [], master: null, prices: null },
  // One entry per uploaded export file: {file, sheets:[{name, grid}]}. A .csv is one
  // unnamed sheet. pipeline.js decides which sheets are exports; the page never guesses.
  exportFiles: [],
  classified: null,           // {recognised:[...], ignored:[...]} from pipeline.classifyFiles
  uploadedPrices: null,       // rows from the prices.csv the user loaded, untouched
  master: null,               // whatever pipeline.js hands back as a master
  year: null,
  top: 25,
  lines: null,
  run: null,
  ingestWarnings: [],
  queueRows: [],
  counts: { blocking: 0, unconfirmed: 0 },
  edits: {},                  // key -> the cells a person typed in the review table
  selected: new Set(),
  ranked: [],
  excluded: [],
  priceRows: [],
  retiredRows: [],
  priceEdits: {},             // "name||vendor" -> the cells a person typed in the price grid
  findings: [],
  reviewFilter: "",
  reviewHits: new Set(),      // keys/names a finding sent us back to look at
  // The optional AI pass over the queue. The key is deliberately not in here:
  // it lives in the password box and nowhere else, so nothing that dumps or
  // logs state can ever carry it.
  ai: { scope: "blocking", busy: false, lastRun: null },
  sort: { col: "rank", dir: "asc" },
  busy: false,
  // What the last write did, and what it moved. Both are plain state so the strips survive a
  // full re-render; render() rebuilds every step's markup from state and nothing else.
  lastChange: null,            // {title, written, proposed, notReady:[...]}
  topMoved: null,              // {reason, entered:[...], left:[...]}
  rankCounts: null,            // {totalLines, includedLines, excludedLines} straight from rank()
  fileStats: [],               // per recognised export: {vendor, file, sheet, rows, dateMin, dateMax}
};

/** Modules that were expected but are missing or shaped differently. Reported to the user. */
const adapterNotes = [];

/* ───────────────────────────── small helpers ───────────────────────────── */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/** Escape anything that came out of a vendor file before it goes near innerHTML. */
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A typed price as a number. Mirrors the pipeline: a leading "$" and thousands commas are
 *  tolerated, and nothing is reformatted - this is only used to count and to warn. */
function priceNumber(value) {
  let text = String(value ?? "").trim();
  if (text.startsWith("$")) text = text.slice(1).trim();
  return num(text);
}

function num(value) {
  const n = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/** "1 row" / "2 rows". Every count this file writes goes through here, so the page never
 *  says "row(s)". Messages that came out of the pipeline are left exactly as it worded them. */
function plural(n, one, many) {
  return `${n} ${Number(n) === 1 ? one : (many || one + "s")}`;
}

function say(message) {
  $("#status-live").textContent = message;
}

/** A dismissible message. Bootstrap's JS is not vendored, so the close button is ours. */
function alertUser(level, title, detail) {
  const cls = { error: "alert-danger", warn: "alert-warning", info: "alert-info",
                ok: "alert-success" }[level] || "alert-info";
  const icon = { error: "bi-exclamation-octagon-fill", warn: "bi-exclamation-triangle-fill",
                 info: "bi-info-circle-fill", ok: "bi-check-circle-fill" }[level] || "bi-info-circle-fill";
  const box = document.createElement("div");
  box.className = `alert ${cls} d-flex align-items-start gap-2`;
  box.innerHTML =
    `<i class="bi ${icon} mt-1" aria-hidden="true"></i>` +
    `<div class="flex-grow-1"><strong>${esc(title)}</strong>` +
    (detail ? ` <span>${esc(detail)}</span>` : "") +
    `</div>` +
    `<button type="button" class="btn-close" aria-label="Dismiss this message"></button>`;
  box.querySelector(".btn-close").addEventListener("click", () => box.remove());
  const area = $("#alerts");
  area.appendChild(box);
  while (area.children.length > 3) area.firstElementChild.remove();
  say(`${title}. ${detail || ""}`);
  return box;
}

/**
 * Turn anything thrown by the pipeline into a sentence a person can act on.
 * SupplytrackError carries a plain-language message by design; everything else is a bug and
 * says so, rather than showing a stack trace to somebody who did not cause it.
 */
function explain(err) {
  const name = err && (err.name || err.constructor?.name);
  if (name === "SupplytrackError") return err.message;
  if (err instanceof Error) {
    return `${err.message} (this one looks like a fault in the page rather than in your files)`;
  }
  return String(err);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  say(`${filename} downloaded`);
}

function downloadText(text, filename, mime = "text/csv;charset=utf-8") {
  download(new Blob([text], { type: mime }), filename);
}

/** Master rows as a plain array, whatever container the pipeline chose. */
function masterRows(master) {
  if (!master) return [];
  if (Array.isArray(master)) return master;
  if (master instanceof Map) return Array.from(master.values());
  if (typeof master.values === "function") return Array.from(master.values());
  if (typeof master === "object") return Object.values(master);
  return [];
}

function emptyMaster() {
  return pipe.emptyMaster ? pipe.emptyMaster() : new Map();
}

/* ───────────────────────────── the logic modules ───────────────────────────── */

/**
 * Everything this page asks of pipeline.js and report.js, resolved once at boot.
 *
 * `bind` takes the first name that exists, so a rename on the other side is a one-line fix
 * here instead of a search through the file. Anything missing is recorded in adapterNotes
 * and surfaced to the user rather than failing silently halfway through a run.
 */
const pipe = {};
let reportModule = null;
let suggestModule = null;   // suggest.js, the provider seam. Optional: no module, no panel.
// The proposal prompt, fetched once so the panel can count requests before a key is typed.
// Never the key: that lives in the password box and nowhere else.
let aiPrompt = null;
// False until loadLogicModules has run. Without it the first paint, which happens before
// the imports, cannot tell "not loaded yet" from "failed to load".
let modulesSettled = false;
// The loadLogicModules() call itself, kept so a handler that somehow runs before the button
// is enabled can await the real answer instead of calling into an adapter that is not there yet.
let modulesReadyPromise = null;

function bind(mod, target, key, ...names) {
  for (const n of names) {
    if (mod && typeof mod[n] === "function") {
      target[key] = mod[n];
      if (n !== names[0]) adapterNotes.push(`pipeline.${names[0]} resolved to ${n}`);
      return true;
    }
  }
  adapterNotes.push(`pipeline.${names[0]} is missing`);
  return false;
}

async function loadLogicModules() {
  let pipeline = null;
  try {
    pipeline = await import("./pipeline.js");
  } catch (err) {
    adapterNotes.push(`pipeline.js did not load: ${err && err.message}`);
  }
  try {
    reportModule = await import("./report.js");
  } catch (err) {
    adapterNotes.push(`report.js did not load: ${err && err.message}`);
  }
  try {
    suggestModule = await import("./suggest.js");
  } catch (err) {
    // Not fatal, and not worth an alert: the AI pass is optional and the panel
    // says so itself when the module is not there.
    adapterNotes.push(`suggest.js did not load: ${err && err.message}`);
  }

  if (pipeline) {
    bind(pipeline, pipe, "ingest", "ingest");
    bind(pipeline, pipe, "classifyFiles", "classifyFiles");
    bind(pipeline, pipe, "buildQueue", "buildQueue", "build_queue", "review");
    bind(pipeline, pipe, "applyQueue", "applyQueue", "apply_queue");
    bind(pipeline, pipe, "rank", "rank");
    bind(pipeline, pipe, "pricesTemplate", "pricesTemplate", "priceTemplate", "writeTemplate");
    bind(pipeline, pipe, "pricesUpdate", "pricesUpdate", "updatePrices");
    bind(pipeline, pipe, "loadPrices", "loadPrices");
    bind(pipeline, pipe, "validateAll", "validateAll", "runAll", "validate");
    // The Appendix A converters. Each takes or returns file text, not rows, so the page
    // never has to carry a column order the pipeline already knows.
    pipe.masterFromCsv = pipeline.masterFromCsv || null;
    pipe.masterToCsv = pipeline.masterToCsv || null;
    pipe.pricesFromCsv = pipeline.pricesFromCsv || null;
    pipe.pricesToCsv = pipeline.pricesToCsv || null;
    pipe.runToJson = pipeline.runToJson || null;
    pipe.asMasterMap = pipeline.asMasterMap || null;
    pipe.checkPrices = pipeline.checkPrices || null;
  }

  const ready = ["ingest", "classifyFiles", "buildQueue", "applyQueue", "rank", "validateAll"]
    .every((fn) => typeof pipe[fn] === "function");
  if (!ready) {
    alertUser(
      "error",
      "The calculation modules are not available.",
      "The page has loaded but pipeline.js could not be used, so no file can be processed yet. " +
        "Detail: " + adapterNotes.join("; ")
    );
  }
  if (!reportModule) {
    adapterNotes.push("report workbook cannot be built");
  }
  modulesSettled = true;
  return ready;
}

/* ───────────────────────────── file reading ───────────────────────────── */

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error(`${file.name} could not be read from disk.`));
    r.readAsText(file);
  });
}

function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error(`${file.name} could not be read from disk.`));
    r.readAsArrayBuffer(file);
  });
}

/**
 * One uploaded export file as {file, sheets:[{name, grid}]}.
 *
 * Nothing is normalised here and no sheet is picked: a grid is the rows exactly as they sit
 * in the file, header row and all, which is what pipeline.js scans. A .csv is a single table
 * with no sheet to name. Reading it this way is what lets the working workbook be dropped in
 * whole, with the finished table and the scratch sheets still in it.
 */
async function readExportFile(file) {
  if (/\.csv$/i.test(file.name)) {
    const grid = csvlib.parse(await readAsText(file));
    if (!grid.length) throw new Error(`${file.name} is empty.`);
    return { file: file.name, sheets: [{ name: "", grid }] };
  }
  const sheets = await xlsxio.readSheets(await readAsArrayBuffer(file));
  return { file: file.name, sheets };
}

/* ───────────────────────────── year detection ───────────────────────────── */

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function yearOf(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.getUTCFullYear();
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 20000 && value < 80000) {
      return new Date(EXCEL_EPOCH + value * 86400000).getUTCFullYear();
    }
    if (value >= 1990 && value <= 2100) return Math.trunc(value);
    return null;
  }
  const m = String(value).match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

/** An order date as YYYY-MM-DD, so two files can be compared and shown the same way. */
function isoDate(value) {
  if (value == null || value === "") return null;
  let d = null;
  if (value instanceof Date) d = value;
  else if (typeof value === "number" && Number.isFinite(value) && value > 20000 && value < 80000) {
    d = new Date(EXCEL_EPOCH + value * 86400000);
  } else {
    const text = String(value).trim();
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[0];
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) d = new Date(parsed);
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Rows and first/last order date for one recognised export, for the strip on step 1.
 *
 * Read off the sheet as it arrived, before anything is filtered, which is the point: it is the
 * number to compare against what the ingest kept. If the sheet has no order date column the
 * range is left out rather than guessed at.
 */
function exportStatsFor(found) {
  const rows = found.body.length;
  const base = { vendor: found.vendor, file: found.file, sheet: found.sheet, rows };
  const idx = found.headers.findIndex((h) => String(h).includes("order date"));
  if (idx < 0) return { ...base, dateMin: null, dateMax: null };
  let min = null;
  let max = null;
  for (const row of found.body) {
    const d = isoDate(row[idx]);
    if (!d) continue;
    if (min === null || d < min) min = d;
    if (max === null || d > max) max = d;
  }
  return { ...base, dateMin: min, dateMax: max };
}

/** The item names currently inside the top N, used to report what a change moved. */
function topNames() {
  return state.ranked
    .filter((r) => { const n = num(r.rank); return n !== null && n <= state.top; })
    .map((r) => String(r.canonical_name || ""));
}

/**
 * What entered and what left the top N between two snapshots.
 *
 * Null when there was no ranking before this: on a first run every item is technically new,
 * and listing all of them as "entered" tells nobody anything they cannot see in the table.
 */
function movement(before, after, reason) {
  if (!before.length) return null;
  const was = new Set(before);
  const now = new Set(after);
  const entered = after.filter((n) => !was.has(n));
  const left = before.filter((n) => !now.has(n));
  return entered.length || left.length ? { reason, entered, left } : null;
}

/** The year most of the order dates fall in, across every recognised export. */
function detectYear() {
  const tally = new Map();
  for (const found of (state.classified && state.classified.recognised) || []) {
    const idx = found.headers.findIndex((h) => String(h).includes("order date"));
    if (idx < 0) continue;
    for (const row of found.body) {
      const y = yearOf(row[idx]);
      if (y) tally.set(y, (tally.get(y) || 0) + 1);
    }
  }
  if (!tally.size) return null;
  return Array.from(tally.entries()).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

/* ───────────────────────────── the run ───────────────────────────── */

/**
 * Rebuild everything downstream of the files from scratch.
 *
 * Deliberately not incremental. Every stage is cheap on a year of office supply orders, and
 * recomputing means the blocking counter, the step locks, the ranking and the findings can
 * never disagree with each other - they all come out of the same pass.
 */
async function recompute({ reingest = false, movementReason = null } = {}) {
  if (!pipe.ingest || !state.exportFiles.length || !state.year) return;
  state.busy = true;
  // Taken before anything is recalculated. A confirm can push an item into or out of the top N,
  // and the only way to see that in a table that just repaints is to compare the two lists.
  const topBefore = topNames();
  try {
    if (reingest || !state.lines) {
      const res = await pipe.ingest({ files: state.exportFiles, year: state.year });
      state.lines = res.lines ?? res.rows ?? [];
      state.run = res.run ?? {};
      state.ingestWarnings = res.warnings ?? [];
    }

    if (!state.master) state.master = emptyMaster();

    const queue = await pipe.buildQueue({
      lines: state.lines, master: state.master, year: state.year,
    });
    state.queueRows = queue.queueRows ?? queue.rows ?? [];
    state.counts = queue.counts ?? countQueue(state.queueRows);

    state.ranked = [];
    state.excluded = [];
    let rankFindings = [];

    state.rankCounts = null;

    if (state.counts.blocking === 0) {
      const r = await pipe.rank({
        lines: state.lines, master: state.master, year: state.year, run: state.run || {},
      });
      state.ranked = r.ranked ?? [];
      state.excluded = r.excluded ?? [];
      rankFindings = r.findings ?? [];
      state.rankCounts = {
        totalLines: r.totalLines ?? state.lines.length,
        includedLines: r.includedLines ?? null,
        excludedLines: r.excludedLines ?? state.excluded.length,
      };
      rebuildPrices();
    }

    if (movementReason) {
      state.topMoved = movement(topBefore, topNames(), movementReason);
    }

    state.findings = await validateNow(rankFindings);
  } catch (err) {
    alertUser("error", "That run stopped.", explain(err));
    console.error(err);
  } finally {
    state.busy = false;
    render();
  }
}

function countQueue(rows) {
  let blocking = 0;
  let unconfirmed = 0;
  for (const row of rows) {
    if (isBlocking(row)) blocking += 1;
    else unconfirmed += 1;
  }
  return { blocking, unconfirmed };
}

function isBlocking(row) {
  if (typeof row.blocking === "boolean") return row.blocking;
  return BLOCKING_REASONS.has(String(row.queue_reason || "").trim());
}

/** The price grid, rebuilt from the ranking and then repainted with whatever was typed. */
function rebuildPrices() {
  const existing = state.uploadedPrices;
  let result = null;
  try {
    if (existing && existing.length && pipe.pricesUpdate) {
      result = pipe.pricesUpdate({ ranked: state.ranked, top: state.top, existing });
    } else if (pipe.pricesTemplate) {
      result = pipe.pricesTemplate({ ranked: state.ranked, top: state.top });
    }
  } catch (err) {
    alertUser("warn", "The price grid could not be prefilled.", explain(err));
  }
  let rows = result && (result.rows ?? result);
  if (!Array.isArray(rows)) rows = fallbackPriceRows();
  state.retiredRows = ((result && result.retiredRows) || []).map((row) => {
    const edit = state.priceEdits[priceKey(row)];
    return edit ? { ...row, ...edit } : { ...row };
  });
  state.priceRows = rows.map((row) => {
    const edit = state.priceEdits[priceKey(row)];
    return edit ? { ...row, ...edit } : { ...row };
  });
}

/** Last resort so the grid still appears if pricesTemplate is not there yet. */
function fallbackPriceRows() {
  const rows = [];
  state.ranked.slice(0, state.top).forEach((item, i) => {
    for (const vendor of VENDORS) {
      rows.push({
        rank: item.rank ?? i + 1,
        canonical_name: item.canonical_name,
        vendor,
        unit_price: "",
        status: "unpriced",
        url: "",
        checked_on: "",
        note: vendor === "Amazon" && item.last_paid_per_each
          ? `last paid per each ${item.last_paid_per_each}` : "",
      });
    }
  });
  return rows;
}

const priceKey = (row) => `${row.canonical_name}||${row.vendor}`;

/**
 * The price map report.js takes: prices[canonicalName][vendor] = {status, unitPrice}.
 *
 * pipeline.loadPrices already builds exactly that shape, and does the cleaning with it - it
 * drops a leading "$" and thousands commas and leaves the digits as typed, so 1.250 stays
 * 1.250. The fallback below only runs if loadPrices is unavailable or throws.
 */
function priceMapForReport() {
  if (pipe.loadPrices) {
    try {
      const cells = pipe.loadPrices({
        rows: state.priceRows, ranked: state.ranked, top: state.top, year: state.year,
      }).cells;
      if (cells && typeof cells === "object" && !(cells instanceof Map)) return cells;
    } catch { /* validateAll has already said so; fall back to the raw rows. */ }
  }
  const out = {};
  for (const row of state.priceRows) {
    const name = row.canonical_name;
    if (!name) continue;
    let price = String(row.unit_price ?? "").trim();
    if (price.startsWith("$")) price = price.slice(1).trim();
    (out[name] || (out[name] = {}))[row.vendor] = {
      status: String(row.status || "unpriced"),
      unitPrice: price.split(",").join(""),
    };
  }
  return out;
}

async function validateNow(extra = []) {
  const findings = [...(extra || [])];
  if (!pipe.validateAll) return findings;

  // loadPrices here is only for the messages beside the grid. validateAll reads the rows
  // itself and turns the same problems into PRICES_INCOMPLETE findings.
  state.priceProblems = [];
  if (state.priceRows.length && pipe.loadPrices) {
    try {
      const loaded = pipe.loadPrices({
        rows: state.priceRows, ranked: state.ranked, top: state.top, year: state.year,
      });
      state.priceProblems = loaded.problems ?? [];
    } catch (err) {
      state.priceProblems = [explain(err)];
    }
  }
  try {
    const res = await pipe.validateAll({
      lines: state.lines,
      master: state.master,
      ranked: state.ranked,
      excluded: state.excluded,
      prices: state.priceRows.length ? state.priceRows : null,
      top: state.top,
      year: state.year,
      run: state.run || {},
    });
    for (const f of res || []) {
      if (!findings.some((g) => g.code === f.code && g.message === f.message)) findings.push(f);
    }
  } catch (err) {
    findings.push({ level: "fail", code: "VALIDATE_FAILED", message: explain(err) });
  }
  return findings;
}

const levelOf = (f) => String(f?.level ?? "").toLowerCase();
const isFail = (f) => levelOf(f).startsWith("fail");

/* ───────────────────────────── rendering ───────────────────────────── */

function render() {
  renderSteps();
  renderLoad();
  renderReview();
  renderRank();
  renderPrices();
  renderDownload();
}

function stepReady() {
  const loaded = Boolean(state.lines);
  const reviewed = loaded && state.counts.blocking === 0;
  return {
    1: true,
    2: loaded,
    3: reviewed && state.ranked.length > 0,
    4: reviewed && state.ranked.length > 0,
    5: reviewed && state.ranked.length > 0,
  };
}

function renderSteps() {
  const ready = stepReady();
  const done = {
    1: Boolean(state.lines),
    2: Boolean(state.lines) && state.counts.blocking === 0,
    3: state.ranked.length > 0,
    4: state.priceRows.some((r) => {
      const status = String(r.status || "").trim();
      return status !== "" && status !== "unpriced";
    }),
    5: false,
  };
  let current = 1;
  for (const n of [1, 2, 3, 4, 5]) if (done[n]) current = Math.min(5, n + 1);

  $$("#steps .step").forEach((btn) => {
    const n = Number(btn.dataset.goto);
    btn.classList.toggle("is-done", Boolean(done[n]));
    btn.disabled = !ready[n];
    if (n === current) btn.setAttribute("aria-current", "step");
    else btn.removeAttribute("aria-current");
  });
  for (const n of [1, 2, 3, 4, 5]) {
    $(`#step-${n}`).classList.toggle("is-locked", !ready[n]);
  }
}

/** One fact chip: a quiet label, the number, and an optional second line under it. */
function fact(label, value, sub) {
  return `<span class="fact"><span class="fact-label">${esc(label)}</span>` +
    `<span class="fact-value">${esc(value)}</span>` +
    (sub ? `<span class="fact-sub">${esc(sub)}</span>` : "") + `</span>`;
}

function renderLoad() {
  const f = state.files;
  $("#btn-read").disabled = !f.exports.length || state.busy || !modulesSettled;
  $("#load-state").textContent = !modulesSettled
    ? "Still loading, one moment."
    : state.lines
      ? `${plural(state.lines.length, "order line")} read`
      : (f.exports.length ? "Ready to read" : "Nothing loaded yet");

  const exportsNote = $("#note-exports");
  const exportsZone = document.querySelector('.dropzone[data-for="file-exports"]');
  if (exportsNote && exportsZone) {
    if (f.exports.length) {
      exportsNote.textContent = f.exports
        .map((file) => `${file.name} (${Math.round(file.size / 1024)} KB)`)
        .join(", ");
      exportsZone.classList.add("is-loaded");
    } else {
      exportsNote.textContent = "Drop the files here or choose them";
      exportsZone.classList.remove("is-loaded");
    }
  }

  for (const kind of ["master", "prices"]) {
    const note = $(`#note-${kind}`);
    const zone = document.querySelector(`.dropzone[data-for="file-${kind}"]`);
    if (!note || !zone) continue;
    if (f[kind]) {
      note.textContent = `${f[kind].name} (${Math.round(f[kind].size / 1024)} KB)`;
      zone.classList.add("is-loaded");
    } else {
      zone.classList.remove("is-loaded");
    }
  }

  const box = $("#load-summary");
  if (!state.lines) { box.innerHTML = ""; return; }

  const run = state.run || {};

  // What went in, one chip per export that was recognised: where it came from, the rows as
  // they sit in the sheet, and the dates those rows actually cover, which is how a wrong year
  // or a half export is spotted before it is ranked.
  const inputs = [];
  for (const stats of state.fileStats) {
    const range = stats.dateMin && stats.dateMax
      ? (stats.dateMin === stats.dateMax ? stats.dateMin : `${stats.dateMin} to ${stats.dateMax}`)
      : "no order dates in this sheet";
    const where = stats.sheet ? `${stats.file}, sheet ${stats.sheet}` : stats.file;
    inputs.push(fact(
      `${VENDOR_NAMES[stats.vendor] || stats.vendor} export`,
      `${plural(stats.rows, "row")} read`,
      `${where}. ${range}`
    ));
  }
  if (state.files.master) {
    inputs.push(fact("Item master", plural(masterRows(state.master).length, "item"), "loaded from file"));
  }
  if (state.files.prices) {
    inputs.push(fact("Prices", plural((state.uploadedPrices || []).length, "row"), "loaded from file"));
  }

  // What came out. The date range here is the ingest's own, over the lines it kept.
  const kept = [
    fact("Order lines kept", state.lines.length, `for ${state.year}`),
    fact("Dates covered",
      run.date_min && run.date_max ? `${run.date_min} to ${run.date_max}` : "not known",
      "after the year filter"),
    fact("Item master", plural(masterRows(state.master).length, "item"), "known pack sizes"),
  ];

  // Every sheet and file that was passed over, with the reason, so nothing goes missing
  // quietly: a wrong report or a sheet with a column removed says so here.
  const skipped = (state.run && state.run.ignored) || [];
  const skippedList = skipped.length
    ? `<ul class="caption caption-plain mb-3">` +
      skipped.map((item) => {
        const where = item.sheet ? `${item.file}, sheet ${item.sheet}` : item.file;
        return `<li>Not used: ${esc(where)}. ${esc(item.reason)}</li>`;
      }).join("") +
      `</ul>`
    : "";

  const oneVendor = state.run && (state.run.vendors || []).length === 1
    ? `<p class="caption caption-plain mb-3">Only the ` +
      `${esc(VENDOR_NAMES[state.run.vendors[0]] || state.run.vendors[0])} export was found, ` +
      `so this run covers that vendor alone.</p>`
    : "";

  const warnings = state.ingestWarnings || [];
  box.innerHTML =
    `<h3 class="caption mb-2">Files read</h3>` +
    `<div class="summary-strip mb-3">${inputs.join("")}</div>` +
    skippedList +
    oneVendor +
    `<h3 class="caption mb-2">What the tool kept</h3>` +
    `<div class="summary-strip mb-3">${kept.join("")}</div>` +
    (warnings.length
      ? `<div class="alert alert-warning py-2 mb-0">` +
        `<strong>${plural(warnings.length, "thing")} to know about these files</strong>` +
        `<ul class="mb-0 mt-1">` +
        warnings.map((w) => `<li>${esc(typeof w === "string" ? w : w.message)}</li>`).join("") +
        `</ul></div>`
      : `<p class="caption caption-plain mb-0">No problems found in the exports.</p>`);
}

/* ── review ── */

/** The head is rebuilt from this template on every review render, so "checked" has to be
 *  passed in rather than left on the markup - otherwise a rebuild silently unchecks it. */
function reviewHead(checked) {
  return `
<tr>
  <th scope="col" class="w-inc"><input type="checkbox" class="form-check-input" id="select-all"
      aria-label="Select every row shown"${checked ? " checked" : ""}></th>
  <th scope="col" class="w-title">Item</th>
  <th scope="col" class="w-inc">Include</th>
  <th scope="col">Suggested</th>
  <th scope="col" class="w-upp num">Units per pack</th>
  <th scope="col">Candidates</th>
  <th scope="col" class="w-unit">Unit</th>
  <th scope="col" class="w-name">Canonical name</th>
  <th scope="col">Suggested name</th>
  <th scope="col" class="w-note">Note</th>
  <th scope="col">Decision</th>
</tr>`;
}

/** Whether every currently visible row is selected - what the "select all shown" checkbox
 *  in the head should show, both on render and after a single row is ticked or unticked. */
function allVisibleSelected(rows) {
  return rows.length > 0 && rows.every((row) => state.selected.has(row.key));
}

function visibleQueueRows() {
  const needle = state.reviewFilter.trim().toLowerCase();
  const hits = state.reviewHits;
  return state.queueRows.filter((row) => {
    if (hits.size) {
      const name = String(row.canonical_name || "").toLowerCase();
      const title = String(row.raw_title || "").toLowerCase();
      const hit = Array.from(hits).some((h) => {
        const l = h.toLowerCase();
        return row.key === h || name.includes(l) || title.includes(l);
      });
      if (!hit) return false;
    }
    if (!needle) return true;
    return [row.key, row.raw_title, row.canonical_name, row.queue_reason, row.amazon_category]
      .some((v) => String(v ?? "").toLowerCase().includes(needle));
  });
}

function sortedQueueRows(rows) {
  const order = (row) => {
    const i = REASON_ORDER.indexOf(String(row.queue_reason || "").trim());
    return i < 0 ? REASON_ORDER.length : i;
  };
  return rows.slice().sort((a, b) =>
    order(a) - order(b) ||
    String(a.canonical_name || a.raw_title).localeCompare(String(b.canonical_name || b.raw_title))
  );
}

function candidateParts(row) {
  return String(row.upp_candidates || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^(\d+)/);
      return { value: m ? m[1] : "", label: part };
    })
    .filter((c) => c.value);
}

/**
 * What a Confirm or Accept would actually write, counted the way applyDecisions counts it.
 *
 * Deliberately the same predicate the action uses, so the number on the button and the number
 * in the message afterwards can never disagree: a row that is ticked but still missing a pack
 * size is not going to be written, and saying so before the click is the whole point.
 */
function selectionImpact() {
  const rows = Array.from(state.selected).map(decisionFor).filter(Boolean);
  const ready = rows.filter(readyToApply);
  const notReady = rows.filter((row) => !readyToApply(row));
  return { ready, notReady };
}

function renderQueueBreakdown() {
  const box = $("#queue-breakdown");
  if (!state.lines || !state.queueRows.length) { box.innerHTML = ""; return; }
  const byReason = new Map();
  for (const row of state.queueRows) {
    const reason = String(row.queue_reason || "other").trim();
    byReason.set(reason, (byReason.get(reason) || 0) + 1);
  }
  const ordered = Array.from(byReason.entries()).sort(
    (a, b) => {
      const ai = REASON_ORDER.indexOf(a[0]);
      const bi = REASON_ORDER.indexOf(b[0]);
      return (ai < 0 ? REASON_ORDER.length : ai) - (bi < 0 ? REASON_ORDER.length : bi);
    }
  );
  box.innerHTML = ordered.map(([reason, n]) =>
    fact(reason, plural(n, "row"),
      BLOCKING_REASONS.has(reason) ? "blocks the ranking" : "does not block")
  ).join("");
}

/** What the last write did. Kept in state so it survives the next full render. */
function renderLastChange() {
  const box = $("#review-change");
  const change = state.lastChange;
  if (!change) { box.innerHTML = ""; return; }
  const left = state.queueRows.length;
  box.innerHTML =
    `<div class="change-note"><span class="caption">${esc(change.title)}</span>` +
    `${esc(plural(change.written, "item"))} written to the item master` +
    (change.proposed ? ", marked as proposed" : ", marked as confirmed") + `. ` +
    (left
      ? `${esc(plural(left, "row"))} still in the queue, ` +
        `${esc(String(state.counts.blocking))} of them blocking.`
      : `The queue is now empty.`) +
    (change.notReady.length
      ? `<ul class="mt-1">` + change.notReady.slice(0, 5).map((t) => `<li>${esc(t)}</li>`).join("") +
        (change.notReady.length > 5
          ? `<li>and ${esc(String(change.notReady.length - 5))} more</li>` : "") +
        `</ul>`
      : "") +
    `</div>`;
}

function renderReview() {
  const table = $("#review-table");
  $("#blocking-count").textContent = `${state.counts.blocking} blocking`;
  $("#blocking-count").className =
    `badge rounded-pill ${state.counts.blocking ? "bg-danger" : "bg-success"}`;
  $("#unconfirmed-count").textContent = `${state.counts.unconfirmed} unconfirmed`;
  $("#review-state").textContent = !state.lines
    ? "Load the files first"
    : (state.queueRows.length ? `${plural(state.queueRows.length, "row")} in the queue` : "Queue is empty");
  $("#btn-clear-filter").hidden = !(state.reviewFilter || state.reviewHits.size);
  $("#btn-confirm").disabled = state.selected.size === 0;
  $("#btn-accept").disabled = state.selected.size === 0;

  renderQueueBreakdown();
  renderLastChange();
  renderSelectionImpact();
  renderAiPanel();

  const rows = sortedQueueRows(visibleQueueRows());
  table.tHead.innerHTML = reviewHead(allVisibleSelected(rows));

  if (!rows.length) {
    table.tBodies[0].innerHTML =
      `<tr><td colspan="11" class="text-center py-4 caption caption-plain">` +
      (state.queueRows.length
        ? "Nothing matches that filter."
        : "Nothing to review. Every item in these files is already known.") +
      `</td></tr>`;
    fillNameList();
    return;
  }

  const names = new Set(
    masterRows(state.master).map((m) => m.canonical_name).filter(Boolean)
  );
  let html = "";
  let group = null;
  for (const row of rows) {
    const reason = String(row.queue_reason || "other").trim();
    if (reason !== group) {
      group = reason;
      const blocking = BLOCKING_REASONS.has(reason);
      html += `<tr class="group-row"><th colspan="11" scope="colgroup">` +
        `<span class="badge rounded-pill ${blocking ? "bg-danger" : "bg-warning text-dark"} me-2">` +
        `${blocking ? "blocking" : "warning"}</span>${esc(reason)}</th></tr>`;
    }
    html += reviewRow(row, names);
  }
  table.tBodies[0].innerHTML = html;
  fillNameList();
}

function reviewRow(row, names) {
  const key = row.key;
  const edit = state.edits[key] || {};
  const value = (field) => (edit[field] !== undefined ? edit[field] : "");
  const blocking = isBlocking(row);
  const checked = state.selected.has(key) ? " checked" : "";
  const includeSuggestion = String(row.include || "");
  const nameSuggestion = String(row.canonical_name || "");
  const uppSuggestion = String(row.units_per_pack || "");
  const candidates = candidateParts(row);

  const sel = (field, options, current) =>
    `<select class="form-select form-select-sm" data-edit="${field}" data-key="${esc(key)}"` +
    ` aria-label="${esc(field)} for ${esc(row.raw_title || key)}">` +
    options.map(([v, label]) =>
      `<option value="${esc(v)}"${String(current) === String(v) ? " selected" : ""}>${esc(label)}</option>`
    ).join("") + `</select>`;

  const useBtn = (field, v, label, title) =>
    `<button type="button" class="btn btn-link btn-sm p-0 ms-1" data-use="${field}"` +
    ` data-key="${esc(key)}" data-value="${esc(v)}" title="${esc(title || "Use this")}">${esc(label)}</button>`;

  return (
    `<tr data-key="${esc(key)}" class="${blocking ? "is-blocking" : ""}">` +
    `<td><input type="checkbox" class="form-check-input" data-select="${esc(key)}"${checked}` +
      ` aria-label="Select ${esc(row.raw_title || key)}"></td>` +
    `<td class="w-title"><div class="fw-semibold">${esc(row.raw_title || "")}</div>` +
      `<div class="caption caption-plain">${esc(key)}` +
      (row.amazon_category ? ` &middot; ${esc(row.amazon_category)}` : "") +
      (row.packs_in_year ? ` &middot; ${esc(row.packs_in_year)} packs this year` : "") +
      `</div></td>` +
    `<td>${sel("include", [["", "-"], ["y", "y"], ["n", "n"]], value("include"))}</td>` +
    `<td class="cell-suggestion">` +
      (includeSuggestion
        ? `<span title="${esc(row.include_reason || "")}">${esc(includeSuggestion)}</span>` +
          useBtn("include", includeSuggestion, "use", row.include_reason)
        : `<span class="caption caption-plain">no suggestion</span>`) +
    `</td>` +
    `<td class="num"><input type="text" inputmode="numeric" class="form-control form-control-sm text-end"` +
      ` data-edit="units_per_pack" data-key="${esc(key)}" value="${esc(value("units_per_pack"))}"` +
      ` aria-label="Units per pack for ${esc(row.raw_title || key)}"></td>` +
    `<td class="cell-suggestion">` +
      (candidates.length
        ? candidates.map((c) =>
            `<div>${esc(c.label)}${useBtn("units_per_pack", c.value, "use", row.upp_reason)}</div>`).join("")
        : uppSuggestion
          ? `${esc(uppSuggestion)}${useBtn("units_per_pack", uppSuggestion, "use", row.upp_reason)}`
          : `<span class="caption caption-plain">nothing in the title</span>`) +
    `</td>` +
    `<td>${sel("unit_label", [["", "-"], ["EA", "EA"], ["RM", "RM"]], value("unit_label"))}</td>` +
    `<td class="w-name"><input type="text" class="form-control form-control-sm" list="canonical-names"` +
      ` data-edit="canonical_name" data-key="${esc(key)}" value="${esc(value("canonical_name"))}"` +
      ` aria-label="Canonical name for ${esc(row.raw_title || key)}"></td>` +
    `<td class="cell-suggestion">` +
      (nameSuggestion
        ? `<span title="${esc(row.canonical_reason || "")}">${esc(nameSuggestion)}</span>` +
          (names.has(nameSuggestion) ? ` <i class="bi bi-link-45deg" title="merges with an existing item" aria-hidden="true"></i>` : "") +
          useBtn("canonical_name", nameSuggestion, "use", row.canonical_reason)
        : `<span class="caption caption-plain">no suggestion</span>`) +
    `</td>` +
    `<td class="w-note"><input type="text" class="form-control form-control-sm"` +
      ` data-edit="note" data-key="${esc(key)}" value="${esc(value("note"))}"` +
      ` aria-label="Note for ${esc(row.raw_title || key)}"></td>` +
    `<td class="text-nowrap">` +
      `<button type="button" class="btn btn-sm btn-primary" data-row-confirm="${esc(key)}">Confirm</button>` +
      `<button type="button" class="btn btn-sm btn-link" data-row-accept="${esc(key)}"` +
      ` title="Record the suggestions as proposed, not confirmed">Accept</button>` +
    `</td></tr>`
  );
}

function renderSelectionImpact() {
  const line = $("#review-impact");
  const confirmBtn = $("#btn-confirm");
  const acceptBtn = $("#btn-accept");
  if (!state.selected.size) {
    confirmBtn.querySelector(".btn-count")?.remove();
    acceptBtn.querySelector(".btn-count")?.remove();
    line.textContent = state.queueRows.length
      ? "Tick the rows you have answered, then confirm. Nothing is written until you do."
      : "";
    return;
  }
  const { ready, notReady } = selectionImpact();
  for (const btn of [confirmBtn, acceptBtn]) {
    let span = btn.querySelector(".btn-count");
    if (!span) {
      span = document.createElement("span");
      span.className = "btn-count";
      btn.appendChild(span);
    }
    span.textContent = ` (${ready.length})`;
  }
  line.textContent =
    `${plural(state.selected.size, "row")} ticked. ` +
    (ready.length
      ? `Confirm or Accept will write ${ready.length} of them. `
      : "None of them can be written yet. ") +
    (notReady.length
      ? `${plural(notReady.length, "row")} will stay in the queue: ` +
        notReady.slice(0, 3).map(whatIsMissing).join(". ") + "."
      : "");
}

/* -- the AI pass over the queue (optional, collapsed by default) -- */

/**
 * The panel is a second source of *suggestions*, not a second way to write.
 *
 * Everything it returns lands in the same suggestion columns the regular expressions fill,
 * with each reason prefixed "AI:" so the table shows which answers came from a model.
 * Confirm selected and Accept suggestions for now are unchanged, and are still the only
 * things that write to the item master.
 *
 * The key is read from the password box at the moment of the click and handed to suggest.js,
 * which keeps it in a closure. It is never put in state, never written to storage, never
 * logged, and gone on reload.
 */

function aiVendor() {
  return $("#ai-provider")?.value || "anthropic";
}

/** The rows the chosen scope would send, with the Preferred pack code attached. */
function aiRowsToSend() {
  if (!suggestModule) return [];
  const rows = state.ai.scope === "all"
    ? state.queueRows
    : suggestModule.blockingRows(state.queueRows);
  // The queue file has no pack_desc column, so the command line cannot send one.
  // The page has the lines in memory, so it can.
  return suggestModule.attachPackDesc(rows, state.lines || []);
}

function aiExistingNames() {
  const names = new Set();
  for (const m of masterRows(state.master)) if (m.canonical_name) names.add(m.canonical_name);
  return Array.from(names);
}

/** Fill the model select for the chosen provider, keeping the current choice if it still fits. */
function fillModelOptions() {
  const select = $("#ai-model");
  if (!select || !suggestModule) return;
  const vendor = aiVendor();
  const wanted = select.value;
  const options = new Map();
  options.set(suggestModule.DEFAULT_MODELS[vendor], "default");
  if (!options.has(suggestModule.CHEAP_MODELS[vendor])) {
    options.set(suggestModule.CHEAP_MODELS[vendor], "cheaper");
  }
  // renderReview repaints on every filter keystroke and every use-this click, and this
  // function runs with it. Rewriting the list under an open dropdown would shut it, so
  // the list is only rebuilt when it would actually be different.
  const ids = Array.from(options.keys()).join("|");
  if (select.dataset.forVendor === vendor && select.dataset.ids === ids) return;
  select.dataset.forVendor = vendor;
  select.dataset.ids = ids;
  select.innerHTML = Array.from(options.entries())
    .map(([id, label]) => `<option value="${esc(id)}">${esc(id)} (${esc(label)})</option>`)
    .join("");
  if (options.has(wanted)) select.value = wanted;
}

function renderAiPanel() {
  const panel = $("#ai-panel");
  if (!panel) return;
  const button = $("#btn-ai-propose");
  const preflight = $("#ai-preflight");
  const fields = $("#ai-fields");
  const stateLine = $("#ai-state");

  if (!suggestModule) {
    preflight.innerHTML = "";
    fields.textContent = modulesSettled
      ? "The suggestion module did not load, so this panel cannot run. Everything else on " +
        "the page works as usual."
      : "";
    button.disabled = true;
    button.textContent = "Propose";
    stateLine.textContent = "";
    renderAiResult();
    return;
  }

  const scopeSelect = $("#ai-scope");
  if (scopeSelect) scopeSelect.value = state.ai.scope;
  fillModelOptions();

  const rows = aiRowsToSend();
  const names = aiExistingNames();
  button.textContent = rows.length ? `Propose for ${plural(rows.length, "row")}` : "Propose";
  button.disabled = state.ai.busy || !rows.length;

  let estimate = null;
  if (aiPrompt && rows.length) {
    try {
      estimate = suggestModule.estimateRequests({
        rows,
        existingNames: names,
        prompt: aiPrompt,
        vendor: aiVendor(),
        model: $("#ai-model")?.value,
      });
    } catch {
      estimate = null;
    }
  }

  preflight.innerHTML = [
    fact("Rows to send", plural(rows.length, "row"),
      state.ai.scope === "all" ? "every row in the queue" : "the ones that block the build"),
    fact("Names shared", plural(names.length, "canonical name"),
      "so an item you already have can be merged onto"),
    estimate
      ? fact("Requests", plural(estimate.batches, "request"),
          `about ${Math.max(1, Math.round(estimate.bytes / 1024))} KB sent`)
      : fact("Requests", "counted on the first run",
          "the prompt is fetched when you press Propose"),
  ].join("");

  fields.textContent =
    "Each row sends only these fields: " + suggestModule.SENT_FIELDS.join(", ") +
    ". The account user, email and payment columns from the export are not included: they are " +
    "dropped when the files are read and never reach this page.";

  if (!state.ai.busy) {
    // A queue with nothing blocking left is the common case by the end of a session, and a
    // disabled button with no explanation reads as a fault. Say which switch to flick.
    stateLine.textContent =
      !rows.length && state.queueRows.length && state.ai.scope === "blocking"
        ? "No blocking rows left. Choose all queued rows to work the unconfirmed ones."
        : "";
  }
  renderAiResult();
}

function renderAiResult() {
  const box = $("#ai-result");
  if (!box) return;
  const run = state.ai.lastRun;
  if (!run) { box.innerHTML = ""; return; }

  if (run.error) {
    // suggest.js phrases a rejected request as "...refused the request (401). ...", so this is
    // the provider's own status code, not a guess at one. The line below is added after it,
    // never in place of it.
    const corsNote = /\(401\)/.test(run.error)
      ? `<div class="mt-1">For Anthropic keys, a 401 that mentions CORS means the ` +
        `organisation's Console setting that allows browser requests is off. The key's owner ` +
        `needs to turn it on.</div>`
      : "";
    box.innerHTML =
      `<div class="change-note"><span class="caption">The model did not answer</span>` +
      `${esc(run.error)}` +
      corsNote +
      `<div class="mt-1">Nothing was changed. Your key is still in the box; it is not saved ` +
      `anywhere, and reloading the page forgets it.</div></div>`;
    return;
  }

  const breakdown = ["high", "medium", "low", "none"]
    .filter((level) => run.counts[level])
    .map((level) => `${run.counts[level]} ${level}`)
    .join(", ");
  box.innerHTML =
    `<div class="change-note"><span class="caption">Suggestions from ${esc(run.provider)}</span>` +
    `${esc(plural(run.filled, "row"))} filled in` +
    (breakdown ? `, confidence ${esc(breakdown)}` : "") + `. ` +
    (run.counts.none
      ? `${esc(plural(run.counts.none, "row"))} came back without an answer and are unchanged. `
      : "") +
    `Nothing has been written yet: read the suggested columns, then use Confirm selected or ` +
    `Accept suggestions for now as usual.</div>`;
}

async function onAiPropose() {
  if (!suggestModule || state.ai.busy) return;
  const rows = aiRowsToSend();
  if (!rows.length) return;
  const key = $("#ai-key")?.value || "";
  const vendor = aiVendor();
  const model = $("#ai-model")?.value || undefined;

  state.ai.busy = true;
  state.ai.lastRun = null;
  $("#btn-ai-propose").disabled = true;
  $("#ai-state").textContent = "Asking the model. This can take a minute.";
  say(`Asking ${vendor} about ${plural(rows.length, "row")}.`);

  try {
    const provider = suggestModule.makeApiProvider({ vendor, apiKey: key, model });
    const proposed = await provider.propose(rows, aiExistingNames());
    // Kept so the next preflight can count requests without fetching again.
    aiPrompt = aiPrompt || (await suggestModule.loadPrompt());

    // Merged field by field onto the row already in the queue, so anything the pipeline put
    // on it that is not a queue column survives.
    const byKey = new Map(state.queueRows.map((row) => [row.key, row]));
    const counts = { high: 0, medium: 0, low: 0, none: 0 };
    let filled = 0;
    for (const row of proposed) {
      const level = String(row.confidence || "none");
      counts[level] = (counts[level] || 0) + 1;
      if (level !== "none") filled += 1;
      const existing = byKey.get(row.key);
      if (existing) Object.assign(existing, row);
    }
    state.ai.lastRun = { provider: provider.name, filled, counts, error: null };
    alertUser(
      "ok",
      "Suggestions filled in.",
      `${plural(filled, "row")} from ${provider.name}. Nothing is written until you confirm or accept.`
    );
  } catch (err) {
    // explain() never carries the request, and the request is the only thing that holds the key.
    state.ai.lastRun = { provider: vendor, filled: 0, counts: {}, error: explain(err) };
    alertUser("error", "The model did not answer.", explain(err));
  } finally {
    state.ai.busy = false;
    $("#ai-state").textContent = "";
    renderReview();
  }
}

function wireAi() {
  const provider = $("#ai-provider");
  const button = $("#btn-ai-propose");
  if (!provider || !button) return;

  provider.addEventListener("change", () => { fillModelOptions(); renderAiPanel(); });
  $("#ai-model")?.addEventListener("change", renderAiPanel);
  $("#ai-scope")?.addEventListener("change", (e) => {
    state.ai.scope = e.target.value === "all" ? "all" : "blocking";
    renderAiPanel();
  });
  button.addEventListener("click", onAiPropose);
}

/**
 * Fetch the prompt once, after the modules are in.
 *
 * It is a static file next to the page, so it can be read before anybody types a key, and
 * having it early is what lets the panel show the request count up front. suggest.js
 * resolves it relative to its own module URL, so this holds wherever the page is served
 * from. A failure is not worth a message: the panel already says the count comes on the
 * first run.
 */
function primeAiPrompt() {
  if (!suggestModule || aiPrompt) return;
  suggestModule.loadPrompt().then(
    (doc) => { aiPrompt = doc; renderAiPanel(); },
    () => {}
  );
}

function fillNameList() {
  const names = new Set();
  for (const m of masterRows(state.master)) if (m.canonical_name) names.add(m.canonical_name);
  for (const r of state.queueRows) if (r.canonical_name) names.add(r.canonical_name);
  $("#canonical-names").innerHTML = Array.from(names).sort()
    .map((n) => `<option value="${esc(n)}"></option>`).join("");
}

/* ── ranking ── */

const RANK_COLUMNS = [
  { key: "rank", label: "#", num: true },
  { key: "canonical_name", label: "Item" },
  { key: "eaches", label: "Eaches", num: true },
  { key: "packs", label: "Packs", num: true },
  { key: "units_per_pack", label: "Units per pack", num: true },
  { key: "unit_label", label: "Unit" },
  { key: "sources", label: "Sources" },
  { key: "last_paid_per_each", label: "Last paid per each", num: true },
  { key: "upp_source", label: "Pack size from" },
];

/** The eaches figure that decides the cut, or null when everything fits inside the top N. */
function cutOff() {
  if (state.ranked.length <= state.top) return null;
  const last = state.ranked.find((r) => num(r.rank) === state.top);
  return last ? String(last.eaches ?? "") : null;
}

function renderRankSummary() {
  const box = $("#rank-summary");
  if (!state.ranked.length) { box.innerHTML = ""; return; }
  const counts = state.rankCounts || {};
  const total = counts.totalLines ?? (state.lines ? state.lines.length : 0);
  const included = counts.includedLines;
  const excluded = counts.excludedLines ?? state.excluded.length;
  const cut = cutOff();
  const inTop = Math.min(state.top, state.ranked.length);

  box.innerHTML = [
    fact("Lines in", plural(total, "order line"), `read for ${state.year}`),
    fact("Lines counted",
      included == null ? "not reported" : plural(included, "line"),
      `${plural(excluded, "line")} left out`),
    fact("Items out", plural(state.ranked.length, "item"), "after merging by name"),
    fact(`Top ${state.top}`,
      cut ? `${inTop} of ${state.ranked.length}` : `all ${state.ranked.length}`,
      cut
        ? `cut-off is ${cut} eaches`
        : `fewer items than the top ${state.top}, so nothing is cut`),
  ].join("");
}

function renderRankMoved() {
  const box = $("#rank-moved");
  const moved = state.topMoved;
  if (!moved) { box.innerHTML = ""; return; }
  const list = (label, names) => names.length
    ? `<li>${esc(label)}: ${names.slice(0, 8).map(esc).join("; ")}` +
      (names.length > 8 ? ` and ${names.length - 8} more` : "") + `</li>`
    : "";
  box.innerHTML =
    `<div class="change-note"><span class="caption">What moved after ${esc(moved.reason)}</span>` +
    `<ul class="mt-1">` +
    list(`entered the top ${state.top}`, moved.entered) +
    list(`left the top ${state.top}`, moved.left) +
    `</ul></div>`;
}

function renderRank() {
  const table = $("#rank-table");
  $("#rank-state").textContent = state.counts.blocking
    ? `${plural(state.counts.blocking, "blocking row")} to clear first`
    : (state.ranked.length
        ? (state.ranked.length > state.top
            ? `${plural(state.ranked.length, "item")} ranked, top ${state.top} highlighted`
            : `${plural(state.ranked.length, "item")} ranked, all inside the top ${state.top}`)
        : "Nothing ranked yet");

  renderRankSummary();
  renderRankMoved();
  renderFindings($("#rank-findings"), state.findings, { jump: true });

  table.tHead.innerHTML =
    `<tr>` + RANK_COLUMNS.map((c) =>
      `<th scope="col" class="sortable${c.num ? " num" : ""}" data-sort="${c.key}"` +
      ` aria-sort="${state.sort.col === c.key ? (state.sort.dir === "asc" ? "ascending" : "descending") : "none"}"` +
      ` tabindex="0" role="columnheader">${esc(c.label)}` +
      (state.sort.col === c.key ? ` <i class="bi bi-caret-${state.sort.dir === "asc" ? "up" : "down"}-fill" aria-hidden="true"></i>` : "") +
      `</th>`).join("") + `</tr>`;

  if (!state.ranked.length) {
    table.tBodies[0].innerHTML =
      `<tr><td colspan="${RANK_COLUMNS.length}" class="text-center py-4 caption caption-plain">` +
      `Nothing to rank yet.</td></tr>`;
    $("#rank-excluded").innerHTML = "";
    return;
  }

  const rows = state.ranked.slice().sort((a, b) => {
    const { col, dir } = state.sort;
    const av = a[col], bv = b[col];
    const an = num(av), bn = num(bv);
    let c;
    if (an !== null && bn !== null) c = an - bn;
    else c = String(av ?? "").localeCompare(String(bv ?? ""));
    return dir === "asc" ? c : -c;
  });

  table.tBodies[0].innerHTML = rows.map((row) => {
    const rank = num(row.rank);
    const top = rank !== null && rank <= state.top;
    const unconfirmed = ["title", "proposed"].includes(String(row.upp_source || "").trim());
    return `<tr class="${top ? "is-top" : ""}">` +
      RANK_COLUMNS.map((c) => {
        let v = row[c.key] ?? "";
        if (c.key === "sources") v = String(v).split("|").join(", ");
        let cell = esc(v);
        if (c.key === "upp_source" && unconfirmed) {
          cell = `<span class="badge rounded-pill bg-warning text-dark">${esc(v || "unconfirmed")}</span>`;
        }
        if (c.key === "canonical_name" && !String(row.units_per_pack ?? "").trim()) {
          cell += ` <i class="bi bi-exclamation-triangle-fill text-warning"` +
            ` title="The keys merged into this item disagree on pack size" aria-hidden="true"></i>`;
        }
        return `<td class="${c.num ? "num" : ""}">${cell}</td>`;
      }).join("") + `</tr>`;
  }).join("");

  $("#rank-excluded").innerHTML = state.excluded.length
    ? `<p class="caption caption-plain mb-0">${plural(state.excluded.length, "order line")} left out. ` +
      `Each one is listed with its reason on the Excluded sheet of the report.</p>`
    : `<p class="caption caption-plain mb-0">Every order line read was counted into an item above.</p>`;
}

/* ── findings ── */

/** The item names a finding is actually about, so the jump link can filter to them. */
function namesInFinding(finding) {
  const out = new Set();
  for (const item of finding.items || finding.keys || []) out.add(String(item));
  const message = String(finding.message || "");
  for (const m of message.matchAll(/\[((?:amz|pbs):[^\]]+)\]/g)) out.add(m[1]);
  for (const m of message.matchAll(/"([^"]{3,})"/g)) out.add(m[1]);
  if (!out.size) {
    for (const row of state.queueRows) {
      const name = String(row.canonical_name || "").trim();
      if (name.length >= 4 && message.includes(name)) out.add(name);
    }
  }
  return Array.from(out);
}

function renderFindings(box, findings, { jump = false } = {}) {
  if (!findings || !findings.length) {
    box.innerHTML = `<p class="caption caption-plain mb-0">No warnings and no failures.</p>`;
    return;
  }
  const order = { fail: 0, warn: 1 };
  const sorted = findings.slice().sort(
    (a, b) => (order[levelOf(a)] ?? 2) - (order[levelOf(b)] ?? 2)
  );
  box.innerHTML = sorted.map((f, i) => {
    const fail = isFail(f);
    const names = jump ? namesInFinding(f) : [];
    return `<div class="finding">` +
      `<span class="badge rounded-pill ${fail ? "bg-danger" : "bg-warning text-dark"}">` +
      `${fail ? "FAIL" : "WARN"}</span>` +
      `<div><code>${esc(f.code || "")}</code> ${esc(f.message || "")}` +
      (names.length
        ? ` <button type="button" class="btn btn-link btn-sm p-0" data-jump="${i}">Review these</button>`
        : "") +
      `</div></div>`;
  }).join("");
  box.__findings = sorted;
}

/* ── prices ── */

/**
 * The item names the uploaded prices file already covers.
 *
 * Null, not an empty set, when no prices file was loaded: with nothing to compare against
 * every item is trivially new, and marking all of them says nothing.
 */
function pricedLastTime() {
  if (!state.uploadedPrices || !state.uploadedPrices.length) return null;
  const names = new Set();
  for (const row of state.uploadedPrices) {
    if (row && row.canonical_name) names.add(String(row.canonical_name));
  }
  return names;
}

function renderPrices() {
  const table = $("#price-table");
  const items = state.ranked.slice(0, state.top);
  const known = pricedLastTime();
  const isNew = (name) => known !== null && !known.has(String(name));
  $("#prices-state").textContent = items.length
    ? `${plural(items.length, "item")} across ${VENDORS.length} vendors`
    : "Ranking has to run first";

  table.tHead.innerHTML =
    `<tr><th scope="col" class="num">#</th><th scope="col" class="w-name">Item</th>` +
    VENDORS.map((v) => `<th scope="col">${esc(v)}</th>`).join("") + `</tr>`;

  if (!items.length) {
    table.tBodies[0].innerHTML =
      `<tr><td colspan="${VENDORS.length + 2}" class="text-center py-4 caption caption-plain">` +
      `Nothing to price yet.</td></tr>`;
    $("#price-coverage").innerHTML = "";
    $("#price-new").innerHTML = "";
    $("#price-retired").innerHTML = "";
    $("#price-problems").innerHTML = "";
    return;
  }

  const byCell = new Map(state.priceRows.map((r) => [priceKey(r), r]));
  table.tBodies[0].innerHTML = items.map((item) => {
    const name = item.canonical_name;
    return `<tr>` +
      `<td class="num">${esc(item.rank ?? "")}</td>` +
      `<td class="w-name"><div class="fw-semibold">${esc(name)}` +
      (isNew(name) ? ` <span class="badge-new" title="Not in the prices file you loaded">new</span>` : "") +
      `</div>` +
      `<div class="helper">${esc(item.eaches ?? "")} eaches` +
      (item.unit_label ? ` &middot; ${esc(item.unit_label)}` : "") + `</div></td>` +
      VENDORS.map((vendor) => {
        const row = byCell.get(`${name}||${vendor}`) || { unit_price: "", status: "" };
        const helper = vendor === "Amazon" && item.last_paid_per_each
          ? `<div class="helper">last paid ${esc(item.last_paid_per_each)} per each</div>`
          : (row.note ? `<div class="helper">${esc(row.note)}</div>` : "");
        return `<td class="vendor-cell">` +
          `<div class="d-flex gap-1">` +
          `<input type="text" inputmode="decimal" class="form-control form-control-sm price-input"` +
            ` data-price="unit_price" data-name="${esc(name)}" data-vendor="${esc(vendor)}"` +
            ` value="${esc(row.unit_price ?? "")}" placeholder="0.00"` +
            ` aria-label="${esc(vendor)} price for ${esc(name)}">` +
          `<select class="form-select form-select-sm" data-price="status"` +
            ` data-name="${esc(name)}" data-vendor="${esc(vendor)}"` +
            ` aria-label="${esc(vendor)} status for ${esc(name)}">` +
          STATUS_OPTIONS.map(([v, label]) =>
            `<option value="${esc(v)}"${String(row.status || "unpriced") === v ? " selected" : ""}>${esc(label)}</option>`
          ).join("") + `</select></div>${helper}</td>`;
      }).join("") + `</tr>`;
  }).join("");

  renderCoverage();
  renderPriceNew(items, known);
  renderPriceProblems();

  $("#price-retired").innerHTML = state.retiredRows.length
    ? `<h3 class="h6">Retired rows <span class="badge rounded-pill bg-secondary">${state.retiredRows.length}</span></h3>` +
      `<p class="caption caption-plain">Priced last year but not in this year's top ${state.top}. ` +
      `They are written to prices_retired.csv so the history is kept.</p>` +
      `<ul class="mb-0">` + state.retiredRows.slice(0, 40).map((r) =>
        `<li class="small">${esc(r.canonical_name)} &middot; ${esc(r.vendor)} &middot; ${esc(r.unit_price || r.status || "")}</li>`
      ).join("") +
      (state.retiredRows.length > 40 ? `<li class="small caption caption-plain">and more in the file</li>` : "") +
      `</ul>`
    : "";
}

/** Which top-N items the loaded prices file has no row for, so they need typing from scratch. */
function renderPriceNew(items, known) {
  const box = $("#price-new");
  if (known === null) {
    box.innerHTML = state.ranked.length
      ? `<p class="caption caption-plain mb-0">No prices file was loaded, so every cell starts empty.</p>`
      : "";
    return;
  }
  const fresh = items.filter((i) => !known.has(String(i.canonical_name)));
  if (!fresh.length) {
    box.innerHTML = `<p class="caption caption-plain mb-0">` +
      `Every item in the top ${state.top} was in the prices file you loaded, so the carried-over ` +
      `prices cover the whole grid.</p>`;
    return;
  }
  box.innerHTML =
    `<div class="change-note"><span class="caption">New to the top ${esc(String(state.top))} ` +
    `since the prices file you loaded</span>` +
    `No carried-over price for ${esc(plural(fresh.length, "item"))}, so those cells start empty: ` +
    esc(fresh.slice(0, 8).map((i) => i.canonical_name).join("; ")) +
    (fresh.length > 8 ? esc(` and ${fresh.length - 8} more`) : "") + `.</div>`;
}

function renderCoverage() {
  const total = Math.min(state.top, state.ranked.length);
  $("#price-coverage").innerHTML = VENDORS.map((vendor) => {
    const priced = state.priceRows.filter(
      (r) => r.vendor === vendor && String(r.status) === "priced" && priceNumber(r.unit_price) !== null
    ).length;
    const short = total && priced < total;
    return `<span class="coverage-chip"><span class="caption">${esc(vendor)}</span> ` +
      `<strong class="${short ? "text-warning-emphasis" : "text-success-emphasis"}">${priced} / ${total}</strong> ` +
      `cells priced</span>`;
  }).join("");
}

function renderPriceProblems() {
  const problems = state.priceProblems || [];
  const typed = state.priceRows.filter(
    (r) => String(r.status) === "priced" && priceNumber(r.unit_price) === null
  );
  const items = [
    ...typed.map((r) => `${r.canonical_name} - ${r.vendor} is marked priced but the price is not a number.`),
    ...problems.map((p) => (typeof p === "string" ? p : p.message)),
  ];
  $("#price-problems").innerHTML = items.length
    ? `<div class="alert alert-warning py-2 mb-0"><ul class="mb-0">` +
      items.slice(0, 20).map((t) => `<li>${esc(t)}</li>`).join("") + `</ul></div>`
    : "";
}

/* ── download ── */

/** One line per file: the name it downloads under, what is inside it, and how much of it. */
function renderDownloadFiles(canReport) {
  const box = $("#download-files");
  if (!state.ranked.length) {
    box.innerHTML = `<p class="caption caption-plain mb-0">` +
      `Nothing is ready to download until the ranking has run.</p>`;
    return;
  }
  const inTop = Math.min(state.top, state.ranked.length);
  const pricedCells = state.priceRows.filter((r) => String(r.status) === "priced").length;
  const files = [
    {
      name: `Acme Widget Top ${state.top} Items Comparison ${state.year}.xlsx`,
      what: `Four sheets. Top ${state.top}: the ${inTop} items you priced, one column per vendor, ` +
        `with the comparison formulas. All items: every one of the ${state.ranked.length} ranked ` +
        `items. Excluded: the ${state.excluded.length} order lines left out, with the reason for ` +
        `each. Sources: the files, counts and dates this run came from.`,
      held: !canReport,
    },
    {
      name: "item_master.csv",
      what: `${plural(masterRows(state.master).length, "item")} with the pack size, unit and ` +
        `canonical name you settled on. Load it next year so the queue starts nearly empty.`,
      held: masterRows(state.master).length === 0,
    },
    {
      name: "prices.csv",
      what: `${plural(state.priceRows.length, "row")} for this year's top ${state.top}, ` +
        `${pricedCells} of them marked priced. Load it next year to carry the prices over.`,
      held: state.priceRows.length === 0,
    },
    {
      name: "prices_retired.csv",
      what: state.retiredRows.length
        ? `${plural(state.retiredRows.length, "row")} priced before but outside this year's ` +
          `top ${state.top}. Kept so the history is not lost.`
        : "Nothing dropped out of the top this year, so there is nothing to write.",
      held: state.retiredRows.length === 0,
    },
    {
      name: "run.json",
      what: `The run itself: file names, row counts, date range, year, top N and every check ` +
        `listed above. Useful when somebody asks where a number came from.`,
      held: !state.run,
    },
  ];
  box.innerHTML = `<div class="file-list">` + files.map((f) =>
    `<div class="file-row${f.held ? " is-held" : ""}">` +
    `<span class="file-name">${esc(f.name)}</span>` +
    `<span class="file-what">${esc(f.what)}</span></div>`
  ).join("") + `</div>`;
}

function renderDownload() {
  const findings = state.findings || [];
  const fails = findings.filter(isFail);
  const warns = findings.length - fails.length;
  renderFindings($("#download-findings"), findings);

  const canReport = Boolean(state.ranked.length) && fails.length === 0 && Boolean(reportModule);
  $("#dl-report").disabled = !canReport;
  $("#dl-report-reason").textContent = canReport
    ? `The workbook downloads as Acme Widget Top ${state.top} Items Comparison ${state.year}.xlsx.`
    : (!state.ranked.length
        ? "The report needs a ranking first."
        : !reportModule
          ? "The workbook builder (report.js) is not available in this copy of the page."
          : `The report is held back while ${plural(fails.length, "check")} ` +
            `${fails.length === 1 ? "is" : "are"} failing: ` +
            fails.map((f) => f.code).join(", ") + ".");

  renderDownloadFiles(canReport);

  $("#download-state").textContent = state.ranked.length
    ? `${fails.length} failing, ${plural(warns, "warning")}`
    : "Nothing to download yet";

  $("#dl-master").disabled = masterRows(state.master).length === 0;
  $("#dl-prices").disabled = state.priceRows.length === 0;
  $("#dl-retired").disabled = state.retiredRows.length === 0;
  $("#dl-run").disabled = !state.run;
}

/* ───────────────────────────── actions ───────────────────────────── */

async function onReadFiles() {
  $("#alerts").innerHTML = "";
  state.lastChange = null;
  state.topMoved = null;
  try {
    // Second guard against the picker-to-click race: the button stays disabled until the
    // modules resolve, but wait for the real promise too rather than trust that alone.
    const ready = await (modulesReadyPromise || Promise.resolve(false));
    if (!ready) {
      alertUser(
        "error",
        "Those files could not be read.",
        "The calculation modules did not load, so no file can be processed yet."
      );
      return;
    }
    say("Reading the files");
    state.exportFiles = [];
    for (const file of state.files.exports) state.exportFiles.push(await readExportFile(file));
    // pipeline.js is the one place that decides what a sheet is, so the page and the command
    // line agree about every file. It throws with the reason when nothing is an export.
    state.classified = pipe.classifyFiles(state.exportFiles);
    state.fileStats = state.classified.recognised.map(exportStatsFor);

    if (state.files.master) {
      const text = await readAsText(state.files.master);
      state.master = pipe.masterFromCsv
        ? pipe.masterFromCsv(text, state.files.master.name)
        : rowsToMasterMap(csvlib.parseObjects(text).rows);
    } else if (!state.master) {
      state.master = emptyMaster();
    }

    if (state.files.prices) {
      const text = await readAsText(state.files.prices);
      state.uploadedPrices = pipe.pricesFromCsv
        ? pipe.pricesFromCsv(text)
        : csvlib.parseObjects(text).rows;
    }

    const detected = detectYear();
    if (detected && !$("#year").value) {
      state.year = detected;
      $("#year").value = String(detected);
    } else {
      state.year = Number($("#year").value) || detected || new Date().getFullYear();
      $("#year").value = String(state.year);
    }
    $("#year-note").textContent = detected
      ? (detected === state.year ? "Detected from the order dates" : `The dates look like ${detected}`)
      : "Could not tell from the dates, please check";

    await recompute({ reingest: true });
    alertUser("ok", "Files read.", `${state.lines ? state.lines.length : 0} order lines for ${state.year}.`);
  } catch (err) {
    alertUser("error", "Those files could not be read.", explain(err));
    console.error(err);
    render();
  }
}

/** Fallback master container when pipeline.js offers no parser of its own. */
function rowsToMasterMap(rows) {
  const map = new Map();
  for (const row of rows) if (row.key) map.set(row.key, row);
  return map;
}

function decisionFor(key) {
  const row = state.queueRows.find((r) => r.key === key);
  if (!row) return null;
  const edit = state.edits[key] || {};
  const merged = { ...row };
  for (const [field, v] of Object.entries(edit)) if (String(v).trim() !== "") merged[field] = v;
  return merged;
}

/**
 * Whether applyQueue will take this row, checked the same way it checks.
 *
 * applyQueue is all or nothing by design: one row missing a pack size and the whole batch is
 * refused. That is right for a file the CLI applies in one go, and wrong for somebody working
 * down a table, so a bulk action here sends the rows that are ready and says which are not.
 */
function readyToApply(row) {
  const include = String(row.include || "").trim().toLowerCase();
  if (!["y", "n", "yes", "no"].includes(include)) return false;
  if (include === "n" || include === "no") return true;
  const units = String(row.units_per_pack || "").trim();
  return /^\d+$/.test(units) && Number(units) > 0;
}

function whatIsMissing(row) {
  const include = String(row.include || "").trim().toLowerCase();
  if (!["y", "n", "yes", "no"].includes(include)) {
    return `${row.canonical_name || row.raw_title || row.key}: say y or n for include`;
  }
  return `${row.canonical_name || row.raw_title || row.key}: enter how many units come in one pack`;
}

async function applyDecisions(keys, proposed) {
  const all = keys.map(decisionFor).filter(Boolean);
  if (!all.length) return;
  const decisions = all.filter(readyToApply);
  const notReady = all.filter((row) => !readyToApply(row));

  if (!decisions.length) {
    alertUser("warn", "Nothing was written.",
      `${plural(notReady.length, "row")} still need something. ` +
      notReady.slice(0, 3).map(whatIsMissing).join(". ") + ".");
    return;
  }
  try {
    const res = await pipe.applyQueue({
      master: state.master, decisions, year: state.year, proposed,
    });
    state.master = res.master ?? res;
    const written = res.written ?? decisions.length;
    for (const row of decisions) { state.selected.delete(row.key); delete state.edits[row.key]; }
    state.lastChange = {
      title: proposed ? "Suggestions accepted for now" : "Confirmed",
      written,
      proposed,
      notReady: notReady.map(whatIsMissing),
    };
    alertUser(
      notReady.length ? "warn" : "ok",
      proposed ? "Suggestions accepted for now." : "Confirmed.",
      `${plural(written, "item")} written to the item master${proposed ? ", marked as proposed" : ""}.` +
      (notReady.length
        ? ` ${plural(notReady.length, "row")} left in the queue because something is still missing. ` +
          notReady.slice(0, 3).map(whatIsMissing).join(". ") + "."
        : ""));
    await recompute({
      movementReason: proposed ? "accepting suggestions" : "confirming rows",
    });
  } catch (err) {
    alertUser("error", "Those rows were not accepted.", explain(err));
    console.error(err);
  }
}

function useEverySuggestion() {
  for (const row of visibleQueueRows()) {
    const edit = state.edits[row.key] || (state.edits[row.key] = {});
    if (row.include) edit.include = row.include;
    if (row.canonical_name) edit.canonical_name = row.canonical_name;
    const candidates = candidateParts(row);
    const upp = String(row.units_per_pack || "") || (candidates.length === 1 ? candidates[0].value : "");
    if (upp) edit.units_per_pack = upp;
    if (row.unit_label) edit.unit_label = row.unit_label;
    state.selected.add(row.key);
  }
  renderReview();
  say("Suggestions copied into the editable cells. Nothing is saved until you confirm.");
}

async function buildAndDownloadReport() {
  try {
    say("Building the workbook");
    const build = reportModule.buildReport || reportModule.default;
    const workbook = await build({
      ranked: state.ranked,
      excluded: state.excluded,
      prices: priceMapForReport(),
      run: state.run,
      master: masterRows(state.master).length,   // report.js wants the row count, not the master
      year: state.year,
      top: state.top,
      builtAt: new Date().toISOString(),
    });
    const buffer = await xlsxio.toArrayBuffer(workbook);
    download(new Blob([buffer], { type: XLSX_MIME }),
      `Acme Widget Top ${state.top} Items Comparison ${state.year}.xlsx`);
  } catch (err) {
    alertUser("error", "The workbook could not be built.", explain(err));
    console.error(err);
  }
}

function downloadMaster() {
  const text = pipe.masterToCsv
    ? pipe.masterToCsv(state.master)
    : csvlib.serialiseObjects(MASTER_COLUMNS, masterRows(state.master));
  downloadText(text, "item_master.csv");
}

function downloadPrices(rows, filename) {
  const text = pipe.pricesToCsv
    ? pipe.pricesToCsv(rows)
    : csvlib.serialiseObjects(PRICE_COLUMNS, rows);
  downloadText(text, filename);
}

function downloadRun() {
  const payload = {
    ...(state.run || {}),
    year: state.year,
    top_n: state.top,
    ranked_at: state.ranked.length ? new Date().toISOString() : undefined,
    warnings: (state.findings || []).map((f) => `${f.level}: ${f.code}: ${f.message}`),
  };
  const text = pipe.runToJson ? pipe.runToJson(payload) : JSON.stringify(payload, null, 2);
  downloadText(text, "run.json", "application/json");
}

function resetAll() {
  for (const kind of ["exports", "master", "prices"]) {
    const input = $(`#file-${kind}`);
    if (input) input.value = "";
  }
  Object.assign(state, {
    files: { exports: [], master: null, prices: null },
    exportFiles: [], classified: null,
    uploadedPrices: null, master: null, lines: null, run: null, ingestWarnings: [],
    queueRows: [], counts: { blocking: 0, unconfirmed: 0 }, edits: {},
    selected: new Set(), ranked: [], excluded: [], priceRows: [], retiredRows: [],
    priceEdits: {}, findings: [], reviewFilter: "", reviewHits: new Set(),
    lastChange: null, topMoved: null, rankCounts: null, fileStats: [],
    ai: { scope: "blocking", busy: false, lastRun: null },
  });
  $("#alerts").innerHTML = "";
  $("#review-filter").value = "";
  // "Cleared. Nothing was kept." has to be true of the key as well.
  const keyBox = $("#ai-key");
  if (keyBox) keyBox.value = "";
  $("#year").value = "";
  render();
  say("Cleared. Nothing was kept.");
}

/* ───────────────────────────── wiring ───────────────────────────── */

/** The order-exports zone holds a list; the other two hold one file each. */
function takeFiles(input, fileList) {
  const files = Array.from(fileList || []);
  if (input.multiple) state.files[input.dataset.kind] = files;
  else state.files[input.dataset.kind] = files[0] || null;
}

function wireFileInputs() {
  for (const input of $$('input[type="file"]')) {
    input.addEventListener("change", () => {
      takeFiles(input, input.files);
      renderLoad();
    });
  }
  for (const zone of $$(".dropzone")) {
    const input = document.getElementById(zone.dataset.for);
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    zone.addEventListener("dragover", (e) => { stop(e); zone.classList.add("is-over"); });
    zone.addEventListener("dragleave", (e) => { stop(e); zone.classList.remove("is-over"); });
    zone.addEventListener("drop", (e) => {
      stop(e);
      zone.classList.remove("is-over");
      const dropped = Array.from(e.dataTransfer?.files || []);
      if (!dropped.length) return;
      const dt = new DataTransfer();
      for (const file of input.multiple ? dropped : dropped.slice(0, 1)) dt.items.add(file);
      input.files = dt.files;
      takeFiles(input, dt.files);
      renderLoad();
    });
  }
}

function wireReview() {
  const table = $("#review-table");

  table.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.edit) {
      const key = t.dataset.key;
      (state.edits[key] || (state.edits[key] = {}))[t.dataset.edit] = t.value;
      renderSelectionImpact();
    }
  });

  table.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "select-all") {
      const on = t.checked;
      for (const row of visibleQueueRows()) {
        if (on) state.selected.add(row.key); else state.selected.delete(row.key);
      }
      renderReview();
      return;
    }
    if (t.dataset.select) {
      if (t.checked) state.selected.add(t.dataset.select);
      else state.selected.delete(t.dataset.select);
      $("#btn-confirm").disabled = state.selected.size === 0;
      $("#btn-accept").disabled = state.selected.size === 0;
      // Not a full renderReview() here - that would blow away focus and any cell someone is
      // mid-edit on - so the head checkbox is kept honest directly instead.
      const selectAll = $("#select-all");
      if (selectAll) selectAll.checked = allVisibleSelected(visibleQueueRows());
      renderSelectionImpact();
      return;
    }
    if (t.dataset.edit) {
      const key = t.dataset.key;
      (state.edits[key] || (state.edits[key] = {}))[t.dataset.edit] = t.value;
      renderSelectionImpact();
    }
  });

  table.addEventListener("click", (e) => {
    const use = e.target.closest("[data-use]");
    if (use) {
      const { key, use: field, value } = use.dataset;
      (state.edits[key] || (state.edits[key] = {}))[field] = value;
      state.selected.add(key);
      renderReview();
      return;
    }
    const confirmRow = e.target.closest("[data-row-confirm]");
    if (confirmRow) { applyDecisions([confirmRow.dataset.rowConfirm], false); return; }
    const acceptRow = e.target.closest("[data-row-accept]");
    if (acceptRow) { applyDecisions([acceptRow.dataset.rowAccept], true); }
  });

  $("#btn-confirm").addEventListener("click", () => applyDecisions(Array.from(state.selected), false));
  $("#btn-accept").addEventListener("click", () => applyDecisions(Array.from(state.selected), true));
  $("#btn-use-all").addEventListener("click", useEverySuggestion);
  $("#review-filter").addEventListener("input", (e) => {
    state.reviewFilter = e.target.value;
    renderReview();
  });
  $("#btn-clear-filter").addEventListener("click", () => {
    state.reviewFilter = "";
    state.reviewHits = new Set();
    $("#review-filter").value = "";
    renderReview();
  });
}

function wireRank() {
  const head = $("#rank-table").tHead;
  const sortBy = (col) => {
    if (!col) return;
    if (state.sort.col === col) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    else state.sort = { col, dir: col === "canonical_name" ? "asc" : "desc" };
    renderRank();
  };
  head.addEventListener("click", (e) => sortBy(e.target.closest("[data-sort]")?.dataset.sort));
  head.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const th = e.target.closest("[data-sort]");
    if (!th) return;
    e.preventDefault();
    sortBy(th.dataset.sort);
  });

  $("#rank-findings").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-jump]");
    if (!btn) return;
    const finding = ($("#rank-findings").__findings || [])[Number(btn.dataset.jump)];
    if (!finding) return;
    state.reviewHits = new Set(namesInFinding(finding));
    state.reviewFilter = "";
    $("#review-filter").value = "";
    renderReview();
    $("#step-2").scrollIntoView({ behavior: "smooth", block: "start" });
    say(`Review filtered to ${plural(state.reviewHits.size, "item")} named by ${finding.code}.`);
  });
}

function wirePrices() {
  const table = $("#price-table");
  const update = (t) => {
    const { name, vendor, price: field } = t.dataset;
    const key = `${name}||${vendor}`;
    const edit = state.priceEdits[key] || (state.priceEdits[key] = {});
    edit[field] = t.value;                 // kept as typed: 1.250 stays 1.250
    const row = state.priceRows.find((r) => priceKey(r) === key);
    if (row) row[field] = t.value;
    renderCoverage();
    renderPriceProblems();
  };
  table.addEventListener("input", (e) => { if (e.target.dataset.price) update(e.target); });
  table.addEventListener("change", (e) => {
    if (!e.target.dataset.price) return;
    update(e.target);
    validateNow().then((findings) => { state.findings = findings; renderDownload(); });
  });
}

function wireDownloads() {
  $("#dl-report").addEventListener("click", buildAndDownloadReport);
  $("#dl-master").addEventListener("click", downloadMaster);
  $("#dl-prices").addEventListener("click", () => downloadPrices(state.priceRows, "prices.csv"));
  $("#dl-retired").addEventListener("click", () => downloadPrices(state.retiredRows, "prices_retired.csv"));
  $("#dl-run").addEventListener("click", downloadRun);
}

function wireTheme() {
  const apply = (theme) => {
    document.documentElement.dataset.bsTheme = theme;
    const dark = theme === "dark";
    $("#theme-icon").className = `bi ${dark ? "bi-sun-fill" : "bi-moon-fill"} fs-5`;
    $("#theme-toggle").setAttribute("aria-pressed", String(dark));
    $("#theme-toggle").querySelector(".visually-hidden").textContent =
      dark ? "Switch to light mode" : "Switch to dark mode";
  };
  let saved = null;
  try { saved = localStorage.getItem("supplytrack.theme"); } catch { /* private mode */ }
  apply(saved || (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.bsTheme === "dark" ? "light" : "dark";
    apply(next);
    try { localStorage.setItem("supplytrack.theme", next); } catch { /* fine */ }
  });
}

function wireSettings() {
  const topBox = $("#top-n");
  try {
    const saved = Number(localStorage.getItem("supplytrack.top"));
    if (saved >= 1 && saved <= 200) { topBox.value = String(saved); state.top = saved; }
  } catch { /* fine */ }

  topBox.addEventListener("change", async () => {
    const v = Number(topBox.value);
    if (!(v >= 1 && v <= 200)) { topBox.value = String(state.top); return; }
    // The top N box does not re-run the pipeline, it only re-cuts the list that is already
    // there, so the snapshot has to be taken here as well as in recompute().
    const topBefore = topNames();
    const was = state.top;
    state.top = v;
    try { localStorage.setItem("supplytrack.top", String(v)); } catch { /* fine */ }
    if (state.ranked.length) {
      rebuildPrices();
      state.findings = await validateNow();
      state.topMoved = movement(topBefore, topNames(), `top ${was} changed to top ${v}`);
    }
    render();
  });

  $("#year").addEventListener("change", async () => {
    const v = Number($("#year").value);
    if (!(v >= 2000 && v <= 2100)) { $("#year").value = state.year ? String(state.year) : ""; return; }
    state.year = v;
    if (state.exportFiles.length) await recompute({ reingest: true });
  });

  $("#btn-read").addEventListener("click", onReadFiles);
  $("#btn-reset").addEventListener("click", resetAll);

  $("#steps").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-goto]");
    if (btn && !btn.disabled) $(`#step-${btn.dataset.goto}`).scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

/* ───────────────────────────── boot ───────────────────────────── */

async function boot() {
  wireTheme();
  wireFileInputs();
  wireReview();
  wireAi();
  wireRank();
  wirePrices();
  wireDownloads();
  wireSettings();
  render();

  modulesReadyPromise = loadLogicModules();
  const ready = await modulesReadyPromise;
  if (ready && adapterNotes.length) console.info("supplytrack adapter notes:", adapterNotes);
  primeAiPrompt();
  render();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

// Exported for the Node test runner, which has no DOM and only wants the pure helpers.
export { yearOf, esc, namesInFinding, MASTER_COLUMNS, PRICE_COLUMNS, VENDORS };
