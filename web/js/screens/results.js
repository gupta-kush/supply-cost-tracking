/* Results: the header strip, the leaderboard and the worth-a-look panel.
 *
 * This module renders and nothing else. It reads `api.state`, it calls `api.answer`,
 * `api.confirmProposed` and `api.go` on a click, and it never writes to state or
 * touches pipeline.js. Everything it needs is passed in, so the preview harness in
 * tests/results-preview.html can drive the same code from a JSON fixture:
 *
 *   mountResults({ state, subscribe, go, answer, confirmProposed, moneyLine, fmt })
 *
 *   state            the app state object (read only)
 *   subscribe(fn)    fn runs after every state change
 *   go(screen)       router, "price" or "done"
 *   answer(k, f)     write one panel answer to the master and re-rank
 *   confirmProposed(keys)   confirm pack sizes the page proposed, no other change
 *   moneyLine()      {amount, itemsCounted, basisSentence} per spec section 4;
 *                    falls back to fmt.moneyLine(ranked, priceRows, top)
 *   fmt              format.js: money, int, plural, displayName, provenance
 *
 * Injecting the api rather than importing app.js keeps this file loadable before
 * app.js exists and keeps the two modules out of an import cycle.
 */

import { VENDORS, PILL_WORDS, toNumber, cheapestVendors } from "./vendor-prices.js";

/* Local view state. Nothing here is a decision, so none of it belongs in app state. */
const view = {
  showAll: false,
  reviewMode: false,
  panelOpen: true,
  lastRanks: new Map(),
};

let api = null;
let mounted = false;

export function mountResults(injected) {
  api = injected;
  if (!mounted) {
    wire();
    mounted = true;
  }
  api.subscribe(render);
  render();
}

/* ───────────────────────────── helpers ───────────────────────────── */

const $ = (sel) => document.querySelector(sel);

function esc(value) {
  return String(value ?? "")
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split('"').join("&quot;");
}

const num = toNumber;

const fmt = () => (api && api.fmt) || {};

/* format.js money(): whole dollars for the headline money line, and up to four
   places with {unit: true} for a price per each. Two places would print 0.0997 and
   0.10 as the same figure while filling one of them as the cheaper, which is the
   one thing a comparison screen must never do. */
function money(value, options) {
  const f = fmt().money;
  return f ? f(value, options) : String(value ?? "");
}

const price = (value) => money(value, { unit: true });

function int(value) {
  const f = fmt().int;
  return f ? f(value) : String(value ?? "");
}

function plural(n, word) {
  const f = fmt().plural;
  return f ? f(n, word) : `${n} ${word}${n === 1 ? "" : "s"}`;
}

function displayName(row) {
  const f = fmt().displayName;
  return f ? f(row) : String(row.canonical_name || row.raw_title || "");
}

/* Provenance wording lives in format.js so the leaderboard, the price card and the
   done screen cannot drift apart. The fallback is only for the preview harness. */
function provenance(row) {
  const f = fmt().provenance;
  if (f) return f(row);
  return String(row.upp_source || "");
}

function say(message) {
  const live = $("#status-live");
  if (live) live.textContent = message;
}

/** The master row behind a ranked item, for the full title on hover. */
function masterFor(row) {
  const s = api.state;
  const keys = String(row.keys || "").split("|").filter(Boolean);
  if (!keys.length) return null;
  if (s.master && typeof s.master.get === "function") {
    for (const key of keys) {
      const hit = s.master.get(key);
      if (hit) return hit;
    }
  }
  if (Array.isArray(s.masterRows)) {
    return s.masterRows.find((m) => keys.includes(m.key)) || null;
  }
  return null;
}

function fullTitle(row) {
  const m = masterFor(row);
  return String((m && m.raw_title) || row.raw_title || row.canonical_name || "");
}

/** Price rows for one item, keyed by vendor, plus every vendor at the lowest price. */
function pricesFor(name) {
  const rows = (api.state.priceRows || []).filter((r) => r.canonical_name === name);
  const byVendor = new Map(rows.map((r) => [r.vendor, r]));
  return { byVendor, best: cheapestVendors(byVendor).best };
}

/* ───────────────────────────── render ───────────────────────────── */

function render() {
  if (!api || !api.state) return;
  renderHead();
  renderLeaderboard();
  renderPanel();
}

function renderHead() {
  const s = api.state;
  const counts = s.counts || {};
  const top = s.top || 25;
  const lines = counts.lines ?? (Array.isArray(s.lines) ? s.lines.length : 0);
  const office = counts.office ?? (s.ranked || []).length;
  const undecided = openRows().length;

  $("#results-title").textContent = `Top ${top} office supplies, ${s.year || ""}`.trim();

  const parts = [
    `${int(lines)} order lines read`,
    `${int(office)} office items ranked`,
    undecided
      ? `${int(undecided)} left for you to decide`
      : "nothing left uncounted",
  ];
  $("#results-subtitle").textContent = `${parts.join(", ")}.`;

  renderMoney();

  // The finish link is always there. Only its wording moves with coverage, so a
  // person who leaves three items unpriced can still reach the download.
  const coverage = priceCoverage();
  const finish = $("#btn-finish");
  finish.textContent = coverage.complete
    ? "Everything is priced, finish"
    : "Finish and download";
}

function renderMoney() {
  const figure = $("#money-figure");
  const caption = $("#money-caption");
  const line = moneyLineNow();

  if (!line || line.itemsCounted === 0) {
    figure.classList.add("is-waiting");
    figure.textContent = "Price the items to see what is on the table";
    caption.textContent = "";
    return;
  }

  figure.classList.remove("is-waiting");
  if (num(line.amount) !== null && num(line.amount) <= 0) {
    figure.textContent = money(0);
    caption.textContent = "Amazon was already cheapest on every item priced.";
    return;
  }
  figure.textContent = money(line.amount);
  caption.textContent = line.basisSentence || "";
}

/** The app supplies this; format.js has the pure version behind it. */
function moneyLineNow() {
  if (api.moneyLine) return api.moneyLine();
  const f = fmt().moneyLine;
  const s = api.state;
  return f ? f(s.ranked || [], s.priceRows || [], s.top || 25) : null;
}

/** How many of the top N items have a price or a status on every vendor. */
function priceCoverage() {
  const s = api.state;
  const top = s.top || 25;
  const items = (s.ranked || []).slice(0, top);
  let filled = 0;
  let cells = 0;
  for (const item of items) {
    const { byVendor } = pricesFor(item.canonical_name);
    for (const vendor of VENDORS) {
      cells += 1;
      const row = byVendor.get(vendor);
      if (row && row.status && row.status !== "unpriced") filled += 1;
    }
  }
  return { filled, cells, complete: cells > 0 && filled === cells };
}

/* ───────────────────────────── leaderboard ───────────────────────────── */

/** Rows the page could not decide, in the place they would take if included. */
function openRows() {
  return Array.isArray(api.state.open) ? api.state.open : [];
}

/**
 * The ranked list with the undecided rows spliced in at the position their volume
 * earns them. They show where they would sit, greyed, and they count for nothing
 * until somebody answers them.
 */
function leaderboardRows() {
  const s = api.state;
  const ranked = (s.ranked || []).map((row) => ({ kind: "ranked", row, eaches: num(row.eaches) ?? 0 }));
  const open = openRows().map((row) => ({
    kind: "open",
    row,
    eaches: num(row.eaches) ?? num(row.packs) ?? 0,
  }));
  if (!open.length) return ranked;
  const all = ranked.concat(open);
  all.sort((a, b) => b.eaches - a.eaches);
  return all;
}

function renderLeaderboard() {
  const s = api.state;
  const top = s.top || 25;
  const body = $("#leaderboard-body");
  const all = leaderboardRows();

  if (!all.length) {
    body.innerHTML =
      `<tr><td class="leaderboard-empty" colspan="7">Nothing ranked yet.</td></tr>`;
    $("#btn-show-all").hidden = true;
    return;
  }

  const biggest = Math.max(...all.map((entry) => entry.eaches), 1);
  const shown = view.showAll ? all : firstNRanked(all, top);

  body.innerHTML = shown
    .map((entry, index) => rowHtml(entry, index + 1, top, biggest))
    .join("");

  // Width is a data value per row, not a style choice, so it cannot live in the
  // stylesheet. Everything else about the bar does.
  shown.forEach((entry, index) => {
    const fill = body.children[index] && body.children[index].querySelector(".vol-fill");
    if (fill) fill.style.setProperty("--lb-vol", String(entry.eaches / biggest));
  });

  flashMoved(shown);

  const more = $("#btn-show-all");
  if (all.length <= top) {
    more.hidden = true;
  } else {
    more.hidden = false;
    more.textContent = view.showAll
      ? `Show the top ${top}`
      : `Show all ${int(all.length)}`;
  }
}

/**
 * The top N, counted in ranked items. An undecided row sitting above the Nth item
 * comes with it, so it is never an undecided row that pushes a real item off screen.
 */
function firstNRanked(all, top) {
  const out = [];
  let ranked = 0;
  for (const entry of all) {
    if (entry.kind === "ranked") {
      if (ranked === top) break;
      ranked += 1;
    }
    out.push(entry);
  }
  return out;
}

function rowHtml(entry, position, top, biggest) {
  const row = entry.row;
  const open = entry.kind === "open";
  const name = displayName(row);
  const title = fullTitle(row);
  const rank = num(row.rank);
  const inTop = !open && rank !== null && rank <= top;
  const confirmed = String(row.upp_source || "") === "master";

  const prov = open
    ? "left out until you decide"
    : `<span class="prov-dot${confirmed ? " is-confirmed" : ""}" aria-hidden="true"></span>${esc(provenance(row))}`;

  const cells = [
    `<td class="lb-rank">${open || rank === null ? "" : esc(int(rank))}</td>`,
    `<th scope="row" class="lb-item">` +
      `<div class="lb-name" title="${esc(title)}">${esc(name)}</div>` +
      `<div class="lb-prov">${open ? esc(prov) : prov}</div>` +
      `</th>`,
    `<td class="lb-vol-cell"><div class="lb-vol">` +
      `<span class="vol-track" aria-hidden="true"><span class="vol-fill"></span></span>` +
      `<span class="lb-eaches">${esc(int(entry.eaches))}</span>` +
      `</div></td>`,
  ];

  // Rows past the top N have no price rows behind them, so they get no pill area
  // rather than four "not priced" pills implying work nobody has to do.
  if (open || !inTop) {
    cells.push(`<td class="lb-vendor" colspan="4"></td>`);
  } else {
    const { byVendor, best } = pricesFor(row.canonical_name);
    for (const vendor of VENDORS) {
      cells.push(`<td class="lb-vendor">${pillHtml(row, vendor, byVendor.get(vendor), best)}</td>`);
    }
  }

  const classes = ["lb-row"];
  if (open) classes.push("is-open");
  return `<tr class="${classes.join(" ")}" data-test="lb-row" data-name="${esc(row.canonical_name || "")}"` +
    `${open ? ` data-key="${esc(row.key || "")}"` : ""}>${cells.join("")}</tr>`;
}

function pillHtml(row, vendor, priceRow, best) {
  const status = String((priceRow && priceRow.status) || "unpriced");
  const value = priceRow ? num(priceRow.unit_price) : null;
  const priced = status === "priced" && value !== null;
  const label = priced ? price(value) : (PILL_WORDS[status] || PILL_WORDS.unpriced);
  const classes = ["pill"];
  if (!priced) classes.push("is-empty");
  // Every vendor at the lowest price is filled. Filling one of a tie says it is
  // cheaper than the others when it is not.
  if (priced && best.has(vendor)) classes.push("is-best");
  return `<button type="button" class="${classes.join(" ")}" data-test="lb-pill"` +
    ` data-price-item="${esc(row.canonical_name || "")}" data-vendor="${esc(vendor)}">` +
    `${esc(label)}</button>`;
}

/** Highlight for a second any row whose rank moved since the last render. */
function flashMoved(shown) {
  const body = $("#leaderboard-body");
  const next = new Map();
  shown.forEach((entry, index) => {
    const name = entry.row.canonical_name || entry.row.key || "";
    const rank = entry.kind === "open" ? null : num(entry.row.rank);
    next.set(name, rank);
    const before = view.lastRanks.get(name);
    if (before !== undefined && before !== rank && rank !== null) {
      const tr = body.children[index];
      if (tr) {
        tr.classList.add("is-moved");
        setTimeout(() => tr.classList.remove("is-moved"), 1000);
      }
    }
  });
  view.lastRanks = next;
}

/* ───────────────────────────── panel ───────────────────────────── */

/**
 * The four kinds of entry, in the order the spec lists them. Only genuine questions
 * are here; the pack sizes the page read off a title are provenance on the row and
 * live in review mode instead.
 */
function panelEntries() {
  const out = [];

  for (const row of openRows()) {
    out.push({ kind: "undecided", row });
  }
  for (const c of conflicts()) {
    out.push({ kind: "conflict", conflict: c });
  }
  for (const d of duplicates()) {
    out.push({ kind: "duplicate", duplicate: d });
  }
  for (const n of notes()) {
    out.push({ kind: "note", note: n });
  }
  return out;
}

/** Pack sizes where the master and the title disagree. */
function conflicts() {
  const s = api.state;
  if (Array.isArray(s.conflicts)) return s.conflicts;
  return parseFinding("UPP_TITLE_MISMATCH", (part) => {
    const m = /^(.*): master says (\d+), the title says (\d+)(?: \((.*)\))?$/.exec(part);
    if (!m) return null;
    return { key: "", name: m[1], master_units: m[2], title_units: m[3], evidence: m[4] || "" };
  });
}

/** Names the page thinks may be one product. */
function duplicates() {
  const s = api.state;
  if (Array.isArray(s.duplicates)) return s.duplicates;
  return parseFinding("NEAR_DUPLICATE_NAMES", (part) => {
    const m = /^"(.+)" and "(.+)" \((.+)\)$/.exec(part);
    if (!m) return null;
    return { names: [m[1], m[2]], ratio: m[3] };
  });
}

/** Lines outside the year and orders that are not closed, one line each. */
function notes() {
  const s = api.state;
  if (Array.isArray(s.notes)) return s.notes;
  const wanted = { DATE_OUT_OF_YEAR: true, STATUS_NOT_CLOSED: true };
  return (s.findings || [])
    .filter((f) => wanted[f.code])
    .map((f) => ({ code: f.code, text: plainSentence(f.message) }));
}

/**
 * Findings carry their detail as one sentence with the items joined by "; ". Worker A
 * is asked for these as arrays; until then this reads them back, and returns nothing
 * rather than a half-parsed entry if the wording ever changes.
 */
function parseFinding(code, parse) {
  const finding = (api.state.findings || []).find((f) => f.code === code);
  if (!finding) return [];
  const body = String(finding.message || "");
  const colon = body.indexOf(": ");
  if (colon < 0) return [];
  const tail = body.slice(colon + 2).replace(/\.\s*[A-Z][^.]*\.?\s*$/, "");
  const out = [];
  for (const part of tail.split("; ")) {
    if (/^and \d+ more$/.test(part.trim())) continue;
    const parsed = parse(part.trim());
    if (parsed) out.push(parsed);
  }
  return out;
}

/** The first sentence of a finding message, without the code or the advice. */
function plainSentence(message) {
  const text = String(message || "").trim();
  const stop = text.indexOf(". ");
  return stop > 0 ? text.slice(0, stop + 1) : text;
}

/** Master rows whose pack size the page decided on its own. */
function proposedRows() {
  const s = api.state;
  const rows = Array.isArray(s.masterRows)
    ? s.masterRows
    : (s.master && typeof s.master.values === "function" ? Array.from(s.master.values()) : []);
  return rows.filter((r) => {
    const source = String(r.upp_source || "").trim();
    return (source === "title" || source === "proposed") && String(r.include || "y") === "y";
  });
}

function renderPanel() {
  const entries = panelEntries();
  const list = $("#panel-list");
  const empty = $("#panel-empty");
  const title = $("#panel-title");

  if (view.reviewMode) {
    renderReviewMode();
    return;
  }

  // The count is the number of questions. The order-line notes are here so the
  // panel is the whole truth, but they ask nothing and answering them is not
  // possible, so counting them inflates what is waiting for her.
  const questions = entries.filter((entry) => entry.kind !== "note");
  const asides = entries.filter((entry) => entry.kind === "note");

  // A panel headed "0 things worth a look" above the sentence that says nothing
  // needs you reads as a contradiction. When the count is zero the sentence is the
  // title.
  if (!questions.length) {
    title.textContent = "Nothing needs you";
    empty.hidden = false;
    empty.textContent =
      "Everything ranked came from last year's decisions or a title that says its own pack size.";
  } else {
    title.textContent = `${int(questions.length)} ${questions.length === 1 ? "thing" : "things"} worth a look`;
    empty.hidden = true;
  }

  list.hidden = !entries.length;
  list.innerHTML =
    questions.map(entryHtml).join("") +
    (asides.length
      ? `<li class="panel-aside-head">Also worth knowing</li>` +
        asides.map(entryHtml).join("")
      : "");

  renderPanelFoot(questions.length);
}

function entryHtml(entry) {
  if (entry.kind === "undecided") return undecidedHtml(entry.row);
  if (entry.kind === "conflict") return conflictHtml(entry.conflict);
  if (entry.kind === "duplicate") return duplicateHtml(entry.duplicate);
  return noteHtml(entry.note);
}

function undecidedHtml(row) {
  const name = displayName(row);
  const key = esc(row.key || "");
  const include = String(row.include || "").trim();
  let question;
  let controls;

  if (!include) {
    question = "Is this an office supply?";
    controls =
      `<span class="yn">` +
      `<button type="button" data-answer-include="y" data-key="${key}">Yes</button>` +
      `<button type="button" data-answer-include="n" data-key="${key}">No</button>` +
      `</span>`;
  } else {
    const candidates = String(row.upp_candidates || "")
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    const numbers = candidates.map((c) => (c.split(" ")[0] || "").trim()).filter(Boolean);
    question = numbers.length >= 2
      ? `${numbers.slice(0, 2).join(" or ")} per pack?`
      : "How many come in one pack?";
    controls =
      `<label class="visually-hidden" for="units-${key}">Units per pack for ${esc(name)}</label>` +
      `<input class="form-control entry-units" id="units-${key}" type="text" inputmode="numeric"` +
      ` data-units-for="${key}" value="${esc(row.units_per_pack || "")}">` +
      candidates
        .map((c) => {
          const value = (c.split(" ")[0] || "").trim();
          return `<button type="button" class="chip" data-units-chip="${esc(value)}"` +
            ` data-key="${key}" title="${esc(c)}">${esc(c)}</button>`;
        })
        .join("") +
      `<button type="button" class="btn btn-sm btn-outline-primary" data-answer-units="${key}">Set</button>`;
  }

  return entryShell(name, fullTitle(row), question, controls);
}

function conflictHtml(conflict) {
  const key = esc(conflict.key || "");
  const a = esc(conflict.master_units);
  const b = esc(conflict.title_units);
  const question = `${a} or ${b} per pack?`;
  const evidence = conflict.evidence
    ? ` The title says ${esc(conflict.evidence)}.`
    : "";
  const controls =
    `<button type="button" class="chip" data-units-chip="${a}" data-key="${key}"` +
    ` data-name="${esc(conflict.name)}">${a}, what is on file</button>` +
    `<button type="button" class="chip" data-units-chip="${b}" data-key="${key}"` +
    ` data-name="${esc(conflict.name)}">${b}, from the title</button>`;
  return entryShell(conflict.name, "", `${question}${evidence}`, controls);
}

function duplicateHtml(duplicate) {
  const [first, second] = duplicate.names || [];
  const question = `Same product as ${esc(second)}? Pick the name to keep for both.`;
  const controls =
    `<button type="button" class="chip" data-merge-from="${esc(second)}"` +
    ` data-merge-into="${esc(first)}">${esc(first)}</button>` +
    `<button type="button" class="chip" data-merge-from="${esc(first)}"` +
    ` data-merge-into="${esc(second)}">${esc(second)}</button>`;
  return entryShell(first, "", question, controls);
}

function noteHtml(note) {
  return `<li class="panel-entry is-note" data-test="panel-entry">` +
    `<p class="entry-q">${esc(note.text)}</p></li>`;
}

function entryShell(name, title, question, controls) {
  return `<li class="panel-entry" data-test="panel-entry">` +
    `<div class="entry-name"${title ? ` title="${esc(title)}"` : ""}>${esc(name)}</div>` +
    `<p class="entry-q">${question}</p>` +
    `<div class="entry-controls">${controls}</div></li>`;
}

function renderPanelFoot(entryCount) {
  const foot = $("#panel-foot");
  const proposed = proposedRows();
  const bits = [];

  if (proposed.length) {
    bits.push(
      `<button type="button" class="btn btn-link" id="btn-review-mode">` +
      `See every decision the page made (${int(proposed.length)})</button>`
    );
  }
  if (api.state.modelAvailable === false && entryCount) {
    bits.push(
      `<p>A model could decide ${int(entryCount)} of these for you. ` +
      `Add a key on the first screen.</p>`
    );
  }
  foot.innerHTML = bits.join("");
  foot.hidden = !bits.length || !view.panelOpen;
}

/** The same panel, listing what the page decided on its own, one confirm each. */
function renderReviewMode() {
  const rows = proposedRows();
  const list = $("#panel-list");
  const empty = $("#panel-empty");

  $("#panel-title").textContent = "What the page decided";
  list.hidden = false;
  empty.hidden = true;
  list.innerHTML = rows.length
    ? rows
        .map(
          (row) =>
            `<li class="panel-entry" data-test="review-entry">` +
            `<div class="review-row">` +
            `<span class="entry-name" title="${esc(row.raw_title || "")}">${esc(displayName(row))}</span>` +
            `<span class="review-upp">${esc(row.units_per_pack)}</span>` +
            `<button type="button" class="chip" data-confirm="${esc(row.key)}">Confirm</button>` +
            `</div></li>`
        )
        .join("")
    : `<li class="panel-entry is-note"><p class="entry-q">Nothing left to confirm.</p></li>`;

  const foot = $("#panel-foot");
  foot.hidden = !view.panelOpen;
  foot.innerHTML =
    `<button type="button" class="btn btn-link" id="btn-review-back">Back to what needs you</button>`;
}

/* ───────────────────────────── events ───────────────────────────── */

function wire() {
  $("#btn-price").addEventListener("click", () => api.go("price"));
  $("#btn-finish").addEventListener("click", () => api.go("done"));

  $("#btn-show-all").addEventListener("click", () => {
    view.showAll = !view.showAll;
    renderLeaderboard();
  });

  $("#panel-toggle").addEventListener("click", () => {
    view.panelOpen = !view.panelOpen;
    $("#panel-body").hidden = !view.panelOpen;
    $("#panel-foot").hidden = !view.panelOpen;
    $("#panel-toggle").setAttribute("aria-expanded", String(view.panelOpen));
    $("#panel-toggle").querySelector(".panel-toggle-label").textContent =
      view.panelOpen ? "Hide" : "Show";
  });

  // A pill is a way into the price screen at that item, not an editable field.
  $("#leaderboard-body").addEventListener("click", (event) => {
    const pill = event.target.closest("[data-price-item]");
    if (!pill) return;
    api.go("price", { item: pill.dataset.priceItem, vendor: pill.dataset.vendor });
  });

  $("#panel-list").addEventListener("click", onPanelClick);
  $("#panel-foot").addEventListener("click", onFootClick);
}

function onPanelClick(event) {
  const target = event.target;

  const include = target.closest("[data-answer-include]");
  if (include) {
    const value = include.dataset.answerInclude;
    api.answer(include.dataset.key, { include: value });
    say(value === "y" ? "Counted as an office supply." : "Left out of the list.");
    return;
  }

  const chip = target.closest("[data-units-chip]");
  if (chip) {
    const value = chip.dataset.unitsChip;
    if (chip.dataset.key) {
      api.answer(chip.dataset.key, { units_per_pack: value });
      say(`Set to ${value} per pack.`);
    } else if (chip.dataset.name) {
      answerByName(chip.dataset.name, { units_per_pack: value });
      say(`Set to ${value} per pack.`);
    }
    return;
  }

  const set = target.closest("[data-answer-units]");
  if (set) {
    const key = set.dataset.answerUnits;
    const input = document.querySelector(`[data-units-for="${CSS.escape(key)}"]`);
    const value = input ? input.value.trim() : "";
    if (!value) return;
    api.answer(key, { units_per_pack: value });
    say(`Set to ${value} per pack.`);
    return;
  }

  const merge = target.closest("[data-merge-from]");
  if (merge) {
    answerByName(merge.dataset.mergeFrom, { canonical_name: merge.dataset.mergeInto });
    say(`Counted as ${merge.dataset.mergeInto}.`);
    return;
  }

  const confirm = target.closest("[data-confirm]");
  if (confirm) {
    api.confirmProposed([confirm.dataset.confirm]);
    say("Confirmed.");
  }
}

function onFootClick(event) {
  if (event.target.closest("#btn-review-mode")) {
    view.reviewMode = true;
    renderPanel();
    return;
  }
  if (event.target.closest("#btn-review-back")) {
    view.reviewMode = false;
    renderPanel();
  }
}

/**
 * Some panel entries come from a finding that names an item rather than a key, so
 * the write goes to every master key carrying that name.
 */
function answerByName(name, fields) {
  const s = api.state;
  const rows = Array.isArray(s.masterRows)
    ? s.masterRows
    : (s.master && typeof s.master.values === "function" ? Array.from(s.master.values()) : []);
  const keys = rows.filter((r) => r.canonical_name === name).map((r) => r.key);
  for (const key of keys) api.answer(key, fields);
}

export default mountResults;
