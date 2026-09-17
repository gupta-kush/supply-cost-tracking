/* app.js - v2: state, the pipeline adapter, the screen router, Build the list.
 *
 * Owns no DOM beyond showing/hiding the four `[data-screen]` sections and setting
 * `window.__supplytrackReady`. Screens are mounted here by injection (`mountResults(api)`,
 * `mountDrop(api)`) so no screen imports app.js and the two are never in a cycle. Every call
 * into the logic modules goes through the `pipe` adapter resolved once at boot -
 * `src/web/js/adapter-contract.md` and webapp-v2-spec.md section 7 are the frozen surface.
 */

import * as csvlib from "./csv.js";
import * as xlsxio from "./xlsxio.js";
import * as fmt from "./format.js";
import {
  masterIncluded, masterUnitsPerPackInt, uppCandidates, isPackPhrase,
  sequenceRatio, casefold, cmpCodePoint,
} from "./pipeline.js";
import { mountResults } from "./screens/results.js";
import { mountPrice } from "./screens/price.js";
import { mountDone } from "./screens/done.js";
import { mount as mountDrop } from "./screens/drop.js";

window.__supplytrackReady = true;

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SCREENS = ["drop", "results", "price", "done"];
// pipeline.js's own NEAR_DUPLICATE threshold (not exported; see pipeline.js:739 and the
// NEAR_DUPLICATE_NAMES check it feeds). Duplicated here rather than requesting an export for
// one numeric literal.
const NEAR_DUPLICATE = 0.9;

/* ───────────────────────────── state ───────────────────────────── */

export const state = {
  screen: "drop",
  files: [],
  exportFiles: [],
  classified: null,
  fileStats: [],
  master: null,
  year: null,
  top: 25,
  lines: null,
  run: null,
  queueRows: [],
  open: [],
  openCount: 0,
  counts: { lines: 0, distinct: 0, office: 0, top: 0, undecided: 0 },
  conflicts: [],
  duplicates: [],
  ranked: [],
  excluded: [],
  findings: [],
  priceRows: [],
  retiredRows: [],
  priceEdits: {},
  carriedPrices: null,
  uploadedRetired: [],
  topMoved: null,
  yearMovement: null,
  priceFocus: null,
  modelAvailable: false,
  busy: false,
  error: null,
};

// Read by web/tests/headless-2025.js only: a live handle for a headless browser to assert
// against directly (line counts, ranked order, undecided count) instead of scraping rendered
// text, which would make the harness depend on wording a screen is free to change.
window.__supplytrackState = state;

const listeners = new Set();

/** Call `fn(state)` on every change from here on; returns a function that stops it. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn(state);
}

/* ───────────────────────────── the logic modules ───────────────────────────── */

const pipe = {};
let reportModule = null;
let suggestModule = null;
const adapterNotes = [];

// Section 7: an undecided row is parked with a blank include via makeMasterRow, never through
// applyQueue, which rightly refuses a row that is not a complete decision.
const PIPE_CALLS = [
  "ingest", "classifyFiles", "carryRows", "buildQueue", "applyQueue", "rank",
  "pricesTemplate", "pricesUpdate", "loadPrices", "validateAll", "masterToCsv",
  "pricesToCsv", "runToJson", "masterFromRows", "sortMaster", "emptyMaster", "makeMasterRow",
];
const PIPE_REQUIRED = [
  "ingest", "classifyFiles", "carryRows", "buildQueue", "applyQueue", "rank",
  "validateAll", "makeMasterRow",
];

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
    // Not fatal: the AI pass is optional, and the panel says so on its own.
    adapterNotes.push(`suggest.js did not load: ${err && err.message}`);
  }

  for (const fn of PIPE_CALLS) {
    if (pipeline && typeof pipeline[fn] === "function") pipe[fn] = pipeline[fn];
    else adapterNotes.push(`pipeline.${fn} is missing`);
  }

  const ready = PIPE_REQUIRED.every((fn) => typeof pipe[fn] === "function");
  if (!ready) {
    state.error = `The calculation modules are not available. ${adapterNotes.join("; ")}`;
  }
  return ready;
}

/** The AI settings the gear sheet writes. The key lives here only, never in `state`. */
let aiSettings = { vendor: "anthropic", apiKey: "", model: "", askEverything: false };

export function setAiSettings(next) {
  aiSettings = { ...aiSettings, ...next };
  state.modelAvailable = aiConfigured();
  notify();
}

export function aiConfigured() {
  return Boolean(aiSettings.apiKey);
}

/* ───────────────────────────── small helpers ───────────────────────────── */

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
}

function downloadText(text, filename, mime = "text/csv;charset=utf-8") {
  download(new Blob([text], { type: mime }), filename);
}

function masterRows(master) {
  if (!master) return [];
  if (master instanceof Map) return Array.from(master.values());
  if (Array.isArray(master)) return master;
  return Object.values(master);
}

function knownNames(master) {
  const names = [];
  for (const row of masterRows(master)) {
    if (row.canonical_name) names.push(row.canonical_name);
  }
  return names;
}

function readFile(file, asText) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(asText ? String(r.result ?? "") : r.result);
    r.onerror = () => reject(new Error(`${file.name} could not be read from disk.`));
    if (asText) r.readAsText(file); else r.readAsArrayBuffer(file);
  });
}

/** One uploaded export file as {file, sheets:[{name, grid}]}. A .csv is one unnamed sheet. */
async function readExportFile(file) {
  if (/\.csv$/i.test(file.name)) {
    const grid = csvlib.parse(await readFile(file, true));
    if (!grid.length) throw new Error(`${file.name} is empty.`);
    return { file: file.name, sheets: [{ name: "", grid }] };
  }
  const sheets = await xlsxio.readSheets(await readFile(file, false));
  return { file: file.name, sheets };
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function yearOf(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.getUTCFullYear();
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 20000 && value < 80000) {
      return new Date(EXCEL_EPOCH + value * 86400000).getUTCFullYear();
    }
    return null;
  }
  const m = String(value).match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

/** The year most of the order dates fall in, across every recognised export. */
function detectYear() {
  const tally = new Map();
  for (const found of (state.classified && state.classified.recognised) || []) {
    const idx = (found.headers || []).findIndex((h) => String(h).includes("order date"));
    if (idx < 0) continue;
    for (const row of found.body || []) {
      const y = yearOf(row[idx]);
      if (y) tally.set(y, (tally.get(y) || 0) + 1);
    }
  }
  if (!tally.size) return null;
  return Array.from(tally.entries()).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

function exportStatsFor(found) {
  const rows = (found.body || []).length;
  return { vendor: found.vendor, file: found.file, sheet: found.sheet, rows };
}

/** Whatever the classifier found of last year's three carried tables. */
function carriedTables() {
  const out = {};
  for (const found of (state.classified && state.classified.recognised) || []) {
    if (!found.kind || found.vendor || out[found.kind]) continue;
    const rows = pipe.carryRows(found);
    out[found.kind] = found.kind === "item_master" ? pipe.masterFromRows(rows) : rows;
  }
  return out;
}

function topNames() {
  return state.ranked
    .filter((r) => { const n = Number(r.rank); return Number.isFinite(n) && n <= state.top; })
    .map((r) => String(r.canonical_name || ""));
}

/** What entered and left the top N between two snapshots, or null on a first run. */
function movement(before, after, reason) {
  if (!before.length) return null;
  const was = new Set(before);
  const now = new Set(after);
  const entered = after.filter((n) => !was.has(n));
  const left = before.filter((n) => !now.has(n));
  return entered.length || left.length ? { reason, entered, left } : null;
}

/** name -> rank, for names inside the top N only. */
function rankMap(ranked, top) {
  const map = new Map();
  for (const r of ranked || []) {
    const n = Number(r.rank);
    if (Number.isFinite(n) && n <= top) map.set(String(r.canonical_name || ""), n);
  }
  return map;
}

/**
 * Done's "movement since last year" (section 2.4). The frozen adapter carries
 * no prior year's rank (only item_master.csv/prices.csv are carry sheets),
 * so "last year" here is the carried master ranked against this year's lines
 * before auto-decide adds anything new to it - what the Top N would still be
 * if nothing this year were decided - diffed against the final rank once
 * auto-decide and every confirmation are in. A first year has no carried
 * master to rank, `baselineRanked` is empty, and this returns null, which is
 * "hidden entirely in a first year" without a separate gate.
 */
function computeYearMovement(baselineRanked, afterRanked, top) {
  const before = rankMap(baselineRanked, top);
  const after = rankMap(afterRanked, top);
  if (!before.size) return null;
  const entered = [];
  const left = [];
  const movers = [];
  for (const [name, rank] of after) {
    if (!before.has(name)) entered.push({ name, rank });
  }
  for (const name of before.keys()) {
    if (!after.has(name)) left.push(name);
  }
  for (const [name, afterRank] of after) {
    const beforeRank = before.get(name);
    if (beforeRank !== undefined && beforeRank !== afterRank) {
      movers.push({ name, before: beforeRank, after: afterRank, delta: beforeRank - afterRank });
    }
  }
  entered.sort((a, b) => a.rank - b.rank);
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { entered, left, movers };
}

/** Park every row auto-decide could not finish with a blank `include` (spec section 7): a
 *  decision not made, never a false one. `rank` excludes it as "no decision yet" and it is
 *  requeued next run instead of vanishing. */
function parkOpenRows(open) {
  for (const row of open) {
    state.master.set(row.key, pipe.makeMasterRow({
      key: row.key,
      source: row.source || "",
      raw_title: row.raw_title || "",
      include: "",
      canonical_name: row.canonical_name || "",
      units_per_pack: "",
      unit_label: row.unit_label || "",
      upp_source: "",
      amazon_category: row.amazon_category || "",
      first_seen: String(state.year),
      last_seen: String(state.year),
      note: row.note || "",
    }));
  }
}

/** A volume estimate so an undecided row can be placed on the leaderboard by the volume it
 *  would earn. Never written anywhere; the true pack size is exactly what is unknown. */
function estimatedEaches(row) {
  const packs = Number(row.packs_in_year) || 0;
  const units = Number(row.units_per_pack);
  return packs * (Number.isFinite(units) && units > 0 ? units : 1);
}

/** `run.undecided_items` names every parked row for Done and the report's Sources sheet.
 *  Absent, not an empty list, when nothing is undecided - report parity depends on it. */
function updateUndecidedRun() {
  const base = state.run || {};
  if (state.open.length) {
    state.run = {
      ...base,
      undecided_items: state.open.map((r) => r.canonical_name || r.raw_title || r.key),
    };
  } else if ("undecided_items" in base) {
    const { undecided_items, ...rest } = base;
    state.run = rest;
  }
}

/** Pack-size disagreements between the master and a title, for the panel's second entry kind.
 *  Computed from the master with pipeline.js's own `uppCandidates`, not parsed from the
 *  `UPP_TITLE_MISMATCH` finding text, so wording drift there cannot break this. Simpler than
 *  `checkMaster`'s own `contradictingCandidates` (no allowance for two candidates whose product
 *  explains the size); the only cost is an occasional row flagged here the validator would not
 *  have warned about, never the reverse. */
function computeConflicts() {
  const keys = Array.from(new Set((state.lines || []).map((l) => l.key))).sort(cmpCodePoint);
  const conflicts = [];
  for (const key of keys) {
    const entry = state.master.get(key);
    if (!entry || !masterIncluded(entry)) continue;
    const units = masterUnitsPerPackInt(entry);
    if (units === null) continue;
    const hits = uppCandidates(entry.raw_title).filter(([, phrase]) => isPackPhrase(phrase));
    if (!hits.length || hits.some(([value]) => value === units)) continue;
    conflicts.push({
      key,
      name: entry.canonical_name || entry.raw_title,
      master_units: units,
      title_units: hits[0][0],
      evidence: hits[0][1],
    });
  }
  return conflicts;
}

/** Near-duplicate canonical names among this run's included items, for the panel's third entry
 *  kind - same threshold and `sequenceRatio` as `checkMaster`'s `NEAR_DUPLICATE_NAMES`, as a
 *  pair of names rather than a sentence to parse. */
function computeDuplicates() {
  const used = new Set((state.lines || []).map((l) => l.key));
  const names = new Set();
  for (const [key, entry] of state.master.entries()) {
    if (used.has(key) && masterIncluded(entry) && entry.canonical_name) names.add(entry.canonical_name);
  }
  const sorted = Array.from(names).sort(cmpCodePoint);
  const duplicates = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const ratio = sequenceRatio(casefold(sorted[i]), casefold(sorted[j]));
      if (ratio >= NEAR_DUPLICATE) duplicates.push({ names: [sorted[i], sorted[j]], ratio });
    }
  }
  return duplicates;
}

/** Regex over every queued row, then the model over what it left incomplete (or everything,
 *  with "ask about everything"), then autoAccept. Spec section 3, item 3. */
async function autoDecide(queueRows) {
  if (!suggestModule) return { ready: [], open: queueRows };
  const names = knownNames(state.master);
  const withPack = suggestModule.attachPackDesc(queueRows, state.lines);
  let rows = await suggestModule.regexProvider.propose(withPack, names);
  if (aiConfigured()) {
    const afterRegex = suggestModule.autoAccept(rows);
    const targets = aiSettings.askEverything ? rows : afterRegex.open;
    if (targets.length) {
      const provider = suggestModule.makeApiProvider({
        vendor: aiSettings.vendor, apiKey: aiSettings.apiKey, model: aiSettings.model,
      });
      const modelRows = await provider.propose(targets, names);
      const byKey = new Map(modelRows.map((r) => [r.key, r]));
      rows = rows.map((r) => byKey.get(r.key) || r);
    }
  }
  return suggestModule.autoAccept(rows);
}

/** Rank, reprice and revalidate against the master as it stands right now. */
function recomputeRank(movementReason) {
  const before = topNames();
  const r = pipe.rank({
    lines: state.lines, master: state.master, year: state.year, run: state.run || {},
  });
  state.ranked = r.ranked ?? [];
  state.excluded = r.excluded ?? [];
  if (movementReason) state.topMoved = movement(before, topNames(), movementReason);
  rebuildPrices();
  updateUndecidedRun();
  state.conflicts = computeConflicts();
  state.duplicates = computeDuplicates();
  state.counts = {
    lines: (state.lines || []).length,
    distinct: new Set((state.lines || []).map((l) => l.key)).size,
    office: state.ranked.length,
    top: Math.min(state.top, state.ranked.length),
    undecided: state.openCount,
  };
  state.findings = pipe.validateAll({
    lines: state.lines, master: state.master, ranked: state.ranked, excluded: state.excluded,
    prices: state.priceRows, top: state.top, year: state.year, run: state.run,
  }).concat(r.findings ?? []);
}

/* ───────────────────────────── router ───────────────────────────── */

/** `focus` is an optional `{item, vendor}`, e.g. a leaderboard pill opening Price at that item. */
export function go(screen, focus) {
  if (!SCREENS.includes(screen)) return;
  state.screen = screen;
  state.priceFocus = focus || null;
  for (const section of document.querySelectorAll("[data-screen]")) {
    section.hidden = section.dataset.screen !== screen;
  }
  try {
    history.replaceState({ screen }, "", `#${screen}`);
  } catch {
    /* not fatal: only the deep link is lost */
  }
  notify();
}

/* ───────────────────────────── build the list ───────────────────────────── */

/** Section 3, run end to end: read the files, auto-decide, rank, price, validate, show Results.
 *  `onStage(name, value)` fires with each funnel figure as soon as it is known. */
export async function buildList({ onStage } = {}) {
  const emit = (name, value) => { if (onStage) onStage(name, value); };
  state.busy = true;
  state.error = null;
  notify();
  try {
    const ready = await loadLogicModules.__ready;
    if (!ready) {
      throw new Error("The calculation modules did not load, so no file can be processed yet.");
    }

    state.exportFiles = [];
    for (const file of state.files) state.exportFiles.push(await readExportFile(file));
    state.classified = pipe.classifyFiles(state.exportFiles);
    state.fileStats = state.classified.recognised.filter((f) => f.vendor).map(exportStatsFor);

    const carried = carriedTables();
    state.master = carried.item_master || pipe.emptyMaster();
    state.carriedPrices = carried.prices || null;
    state.uploadedRetired = carried.prices_retired || [];

    if (!state.year) state.year = detectYear() || new Date().getFullYear();

    const res = await pipe.ingest({ files: state.exportFiles, year: state.year });
    state.lines = res.lines ?? [];
    state.run = res.run ?? {};
    emit("lines", state.lines.length);
    emit("products", new Set(state.lines.map((l) => l.key)).size);

    // Taken before buildQueue/autoDecide touch the master: exactly what was carried in,
    // ranked against this year's lines. computeYearMovement diffs the final rank against this.
    const baseline = pipe.rank({
      lines: state.lines, master: state.master, year: state.year, run: state.run || {},
    });

    const queue = pipe.buildQueue({ lines: state.lines, master: state.master, year: state.year });
    state.queueRows = queue.queueRows ?? [];

    const decided = await autoDecide(state.queueRows);
    if (decided.ready.length) {
      const applied = pipe.applyQueue({
        master: state.master, decisions: decided.ready, year: state.year, proposed: true,
      });
      state.master = applied.master;
    }
    state.open = decided.open.map((row) => ({ ...row, eaches: estimatedEaches(row) }));
    state.openCount = decided.open.length;
    parkOpenRows(decided.open);

    recomputeRank(null);
    state.yearMovement = computeYearMovement(baseline.ranked || [], state.ranked, state.top);
    emit("items", state.ranked.length);
    emit("top", Math.min(state.top, state.ranked.length));

    go("results");
  } catch (err) {
    state.error = explain(err);
  } finally {
    state.busy = false;
    notify();
  }
}

/* ───────────────────────────── decisions ───────────────────────────── */

/** One panel answer (`include`, `units_per_pack`, and `canonical_name` for a merge), always
 *  written as confirmed (`upp_source = master`); the ranking is redone. Section 2.2. */
export function answer(key, fields) {
  const row =
    state.queueRows.find((r) => r.key === key) ||
    state.open.find((r) => r.key === key) ||
    { key };
  const decision = { ...row, ...fields };
  const result = pipe.applyQueue({
    master: state.master, decisions: [decision], year: state.year, proposed: false,
  });
  state.master = result.master;
  state.open = state.open.filter((r) => r.key !== key);
  state.openCount = state.open.length;
  recomputeRank("a decision");
  notify();
}

/** Confirm one or more already-proposed pack sizes unchanged - the review-mode one-click
 *  confirm in the panel. */
export function confirmProposed(keys) {
  const rows = (keys || []).map((k) => state.queueRows.find((r) => r.key === k)).filter(Boolean);
  if (!rows.length) return;
  const result = pipe.applyQueue({
    master: state.master, decisions: rows, year: state.year, proposed: false,
  });
  state.master = result.master;
  recomputeRank("confirming pack sizes");
  notify();
}

/* ───────────────────────────── prices ───────────────────────────── */

function applyPriceEdit(row) {
  const edit = state.priceEdits[`${row.canonical_name}||${row.vendor}`];
  return edit ? { ...row, ...edit } : { ...row };
}

/** The price grid, rebuilt from the ranking and repainted with whatever was typed. */
export function rebuildPrices() {
  let result = null;
  if (state.carriedPrices && state.carriedPrices.length) {
    result = pipe.pricesUpdate({
      ranked: state.ranked, top: state.top, existing: state.carriedPrices,
    });
  } else {
    result = pipe.pricesTemplate({ ranked: state.ranked, top: state.top });
  }
  const rows = (result && result.rows) || [];
  state.retiredRows = (state.uploadedRetired || [])
    .map((row) => ({ ...row }))
    .concat(((result && result.retiredRows) || []).map(applyPriceEdit));
  state.priceRows = rows.map(applyPriceEdit);
}

export function setPrice(name, vendor, fields) {
  const key = `${name}||${vendor}`;
  state.priceEdits[key] = { ...(state.priceEdits[key] || {}), ...fields };
  rebuildPrices();
  notify();
}

export function moneyLine() {
  return fmt.moneyLine(state.ranked, state.priceRows, state.top);
}

/* ───────────────────────────── downloads ───────────────────────────── */

function priceMapForReport() {
  if (pipe.loadPrices) {
    try {
      const cells = pipe.loadPrices({
        rows: state.priceRows, ranked: state.ranked, top: state.top, year: state.year,
      }).cells;
      if (cells && typeof cells === "object") return cells;
    } catch { /* fall back below; validateAll has already said what is wrong */ }
  }
  const out = {};
  for (const row of state.priceRows) {
    if (!row.canonical_name) continue;
    let price = String(row.unit_price ?? "").trim();
    if (price.startsWith("$")) price = price.slice(1).trim();
    (out[row.canonical_name] || (out[row.canonical_name] = {}))[row.vendor] = {
      status: String(row.status || "unpriced"),
      unitPrice: price.split(",").join(""),
    };
  }
  return out;
}

/**
 * `rank`'s live output is genuinely numeric (`eaches`/`packs` are running sums); the CLI's
 * `ranked.csv`/`excluded.csv`, which `buildTableSheet` writes unmodified, are always text.
 * Stringified here so the downloaded workbook's "All items"/"Excluded" cells are text either
 * way, matching what running the report from a carried CSV always produced.
 */
function stringifyRows(rows) {
  return (rows || []).map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) out[key] = value == null ? "" : String(value);
    return out;
  });
}

export async function downloadReport() {
  if (!reportModule) throw new Error("report.js is not available.");
  const build = reportModule.buildReport || reportModule.default;
  const workbook = await build({
    ranked: stringifyRows(state.ranked),
    excluded: stringifyRows(state.excluded),
    prices: priceMapForReport(),
    run: state.run,
    master: masterRows(state.master).length,
    masterRows: pipe.sortMaster
      ? Array.from(pipe.sortMaster(state.master).values())
      : masterRows(state.master),
    priceRows: state.priceRows,
    retiredRows: state.retiredRows,
    year: state.year,
    top: state.top,
    builtAt: new Date().toISOString(),
  });
  const buffer = await xlsxio.toArrayBuffer(workbook);
  download(
    new Blob([buffer], { type: XLSX_MIME }),
    `Acme Widget Top ${state.top} Items Comparison ${state.year}.xlsx`
  );
}

/** One of the tables the Done screen's disclosure offers on its own: master, prices, retired, run. */
export function downloadTables(kind) {
  if (kind === "master") {
    downloadText(pipe.masterToCsv(state.master), "item_master.csv");
  } else if (kind === "prices") {
    downloadText(pipe.pricesToCsv(state.priceRows), "prices.csv");
  } else if (kind === "retired") {
    downloadText(pipe.pricesToCsv(state.retiredRows), "prices_retired.csv");
  } else if (kind === "run") {
    const payload = {
      ...(state.run || {}),
      year: state.year,
      top_n: state.top,
      warnings: (state.findings || []).map((f) => `${f.level}: ${f.code}: ${f.message}`),
    };
    downloadText(pipe.runToJson(payload), "run.json", "application/json");
  }
}

/* ───────────────────────────── theme ───────────────────────────── */

/** Ported from v1 unchanged. Never stores anything except the theme and Top N (adapter-contract.md). */
function wireTheme() {
  const toggle = document.getElementById("theme-toggle");
  const icon = document.getElementById("theme-icon");
  if (!toggle || !icon) return;
  const apply = (theme) => {
    document.documentElement.dataset.bsTheme = theme;
    const dark = theme === "dark";
    icon.className = `bi ${dark ? "bi-sun-fill" : "bi-moon-fill"} fs-5`;
    toggle.setAttribute("aria-pressed", String(dark));
    const label = toggle.querySelector(".visually-hidden");
    if (label) label.textContent = dark ? "Switch to light mode" : "Switch to dark mode";
  };
  let saved = null;
  try { saved = localStorage.getItem("supplytrack.theme"); } catch { /* private mode */ }
  apply(saved || (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  toggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.bsTheme === "dark" ? "light" : "dark";
    apply(next);
    try { localStorage.setItem("supplytrack.theme", next); } catch { /* fine */ }
  });
}

/* ───────────────────────────── boot ───────────────────────────── */

const api = {
  state, subscribe, go, answer, confirmProposed, setPrice, moneyLine,
  buildList, aiConfigured, setAiSettings, downloadReport, downloadTables, fmt,
};

loadLogicModules.__ready = loadLogicModules().then((ok) => {
  notify();
  return ok;
});

wireTheme();
mountResults(api);
mountPrice(api);
mountDone(api);
mountDrop(api);
