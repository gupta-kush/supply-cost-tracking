/* app.js - v2: state, the pipeline adapter, the screen router, Build the list.
 *
 * This module owns no DOM of its own beyond showing/hiding the four `[data-screen]` sections
 * and setting `window.__supplytrackReady`. Every screen under js/screens/ is mounted here by
 * injection - `mountResults(api)`, `mountDrop(api)`, and the same pattern for price and done
 * once they exist (STATUS.md, orchestrator ruling 2026-09-17) - so no screen imports app.js and
 * the two are never in a cycle; `screens/results-preview.html` drives the same mount function
 * against a fixture instead of a live run.
 *
 * Every call into the logic modules goes through the `pipe` adapter resolved once at boot:
 * `src/web/js/adapter-contract.md` lists the frozen surface, and section 7 of
 * webapp-v2-spec.md is the complete list of what may change in it for v2. `state.conflicts` and
 * `state.duplicates` are computed here from the master directly, with the pipeline's own
 * exported helpers, rather than parsed back out of finding messages - see `computeConflicts`
 * and `computeDuplicates` below.
 */

import * as csvlib from "./csv.js";
import * as xlsxio from "./xlsxio.js";
import * as fmt from "./format.js";
import {
  masterIncluded, masterUnitsPerPackInt, uppCandidates, isPackPhrase,
  sequenceRatio, casefold, cmpCodePoint,
} from "./pipeline.js";
import { mountResults } from "./screens/results.js";
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
  focus: null,
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
  uploadedPrices: null,
  uploadedRetired: [],
  topMoved: null,
  modelAvailable: false,
  busy: false,
  error: null,
};

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

function bind(mod, target, key) {
  if (mod && typeof mod[key] === "function") {
    target[key] = mod[key];
    return true;
  }
  adapterNotes.push(`pipeline.${key} is missing`);
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
    // Not fatal: the AI pass is optional, and the panel says so on its own.
    adapterNotes.push(`suggest.js did not load: ${err && err.message}`);
  }

  if (pipeline) {
    for (const fn of [
      "ingest", "classifyFiles", "carryRows", "buildQueue", "applyQueue", "rank",
      "pricesTemplate", "pricesUpdate", "loadPrices", "validateAll",
    ]) {
      bind(pipeline, pipe, fn);
    }
    pipe.masterToCsv = pipeline.masterToCsv || null;
    pipe.pricesToCsv = pipeline.pricesToCsv || null;
    pipe.runToJson = pipeline.runToJson || null;
    pipe.masterFromRows = pipeline.masterFromRows || null;
    pipe.sortMaster = pipeline.sortMaster || null;
    pipe.emptyMaster = pipeline.emptyMaster || null;
    // webapp-v2-spec.md section 7: an undecided row is parked with a blank
    // include via makeMasterRow, never through applyQueue, which rightly
    // refuses a row that is not a complete decision.
    pipe.makeMasterRow = pipeline.makeMasterRow || null;
  }

  const ready = [
    "ingest", "classifyFiles", "carryRows", "buildQueue", "applyQueue", "rank",
    "validateAll", "makeMasterRow",
  ].every((fn) => typeof pipe[fn] === "function");
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

/** One uploaded export file as {file, sheets:[{name, grid}]}. A .csv is one unnamed sheet. */
async function readExportFile(file) {
  if (/\.csv$/i.test(file.name)) {
    const grid = csvlib.parse(await readAsText(file));
    if (!grid.length) throw new Error(`${file.name} is empty.`);
    return { file: file.name, sheets: [{ name: "", grid }] };
  }
  const sheets = await xlsxio.readSheets(await readAsArrayBuffer(file));
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

/**
 * Park every row auto-decide could not finish with a blank `include` - a
 * decision that has not been made, never a false one. `rank` then excludes it
 * with reason "no decision yet" (webapp-v2-spec.md section 7) and it is
 * requeued next run instead of vanishing.
 */
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

/**
 * A volume figure for an undecided row so the panel can place it on the
 * leaderboard at the position its volume would earn. The true pack size is
 * exactly what is unknown, so this is a plain estimate - the single pack
 * candidate if there is one, otherwise 1 - never a value written anywhere.
 */
function estimatedEaches(row) {
  const packs = Number(row.packs_in_year) || 0;
  const units = Number(row.units_per_pack);
  return packs * (Number.isFinite(units) && units > 0 ? units : 1);
}

/**
 * The run object's `undecided_items` key names every parked row so the Done
 * screen and the report's Sources sheet can say how many are left. Absent,
 * not an empty list, when nothing is undecided - report parity depends on it.
 */
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

/**
 * Pack-size disagreements between the master and a line's own title, for the
 * worth-a-look panel's second entry kind. Computed from the master directly
 * with the pipeline's own `uppCandidates`, not parsed from the
 * `UPP_TITLE_MISMATCH` finding text, so wording changes there cannot break
 * this. A simpler read than `checkMaster`'s own `contradictingCandidates`
 * (no allowance for two candidates whose product explains the pack size);
 * that trade only ever means an occasional row worth a second glance here
 * that the validator would not have warned about, never the reverse.
 */
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

/**
 * Near-duplicate canonical names among this run's included items, for the
 * panel's third entry kind. Same threshold `checkMaster` uses for
 * `NEAR_DUPLICATE_NAMES` (pipeline.js's own `NEAR_DUPLICATE`, 0.9), same
 * `sequenceRatio`, computed here so the shape is a pair of names, not a
 * sentence to parse.
 */
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

/**
 * The regex provider over every queued row, then the model over whatever it
 * left incomplete (or over everything, with "ask about everything"), then
 * autoAccept. webapp-v2-spec.md section 3, item 3.
 */
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
  state.focus = focus || null;
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

/**
 * webapp-v2-spec.md section 3, run end to end: read the files, auto-decide,
 * rank, price and validate, then show Results. `onStage(name, value)` fires
 * with each funnel figure as soon as it is known: lines, products, items, top.
 */
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
    state.uploadedPrices = carried.prices || null;
    state.uploadedRetired = carried.prices_retired || [];

    if (!state.year) state.year = detectYear() || new Date().getFullYear();

    const res = await pipe.ingest({ files: state.exportFiles, year: state.year });
    state.lines = res.lines ?? [];
    state.run = res.run ?? {};
    emit("lines", state.lines.length);
    emit("products", new Set(state.lines.map((l) => l.key)).size);

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

/**
 * One panel answer: a complete decision (`include`, `units_per_pack` and, for
 * a merge, `canonical_name`), always written as confirmed
 * (`upp_source = master`), and the ranking is redone. Section 2.2.
 */
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

/**
 * Confirm one or more already-proposed (unconfirmed) pack sizes with no
 * change in value - the review-mode "one-click confirm" in the panel.
 */
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
  if (state.uploadedPrices && state.uploadedPrices.length) {
    result = pipe.pricesUpdate({
      ranked: state.ranked, top: state.top, existing: state.uploadedPrices,
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

export async function downloadReport() {
  if (!reportModule) throw new Error("report.js is not available.");
  const build = reportModule.buildReport || reportModule.default;
  const workbook = await build({
    ranked: state.ranked,
    excluded: state.excluded,
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

/* ───────────────────────────── boot ───────────────────────────── */

const api = {
  state, subscribe, go, answer, confirmProposed, setPrice, moneyLine,
  buildList, aiConfigured, setAiSettings, downloadReport, downloadTables, fmt,
};

loadLogicModules.__ready = loadLogicModules().then((ok) => {
  notify();
  return ok;
});

mountResults(api);
mountDrop(api);
