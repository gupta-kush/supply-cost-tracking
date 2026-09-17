/* Price: one item at a time, four vendors, keyboard first.
 *
 * Same injection pattern as results.js, and the same rule: this module renders and
 * calls back. Every write goes through `api.setPrice(name, vendor, fields)`, which
 * is what keeps `prices.csv` the exact shape v1 wrote.
 *
 *   mountPrice({ state, subscribe, go, setPrice, fmt })
 *
 * `fmt` is format.js; the card names items with `distinctDisplayNames` over the set
 * being priced, not `displayName` per item, so two colours of the same product do
 * not appear under one name on consecutive cards.
 *
 * Entered from Results, either by the button or by a vendor pill. A pill sets
 * `state.priceFocus = {item, vendor}`; this module reads it once and clears it, so
 * `go("price", focus)` and a plain `go("price")` both work.
 *
 * The Amazon prefill is display only. `templateRow` in pipeline.js puts last year's
 * paid figure in the Amazon row's `note` and leaves `unit_price` empty at
 * `status: "unpriced"`, so the data model already says a prefill is not a price.
 * Nothing is written until the person edits the field or presses Enter on the card.
 */

import { VENDORS, toNumber, cheapestVendors } from "./vendor-prices.js";

const STATUS_LABELS = [
  ["unpriced", "not priced"],
  ["priced", "priced"],
  ["not_available", "not available"],
  ["discontinued", "discontinued"],
];

/**
 * Where a vendor name links to, opened in a new tab. Three of them take the display
 * name as a search query. Preferred is the Pettus order portal and its prices are
 * behind a login, so there is no query to send: it opens the portal home and she
 * searches there. `state.vendorSites` overrides any of them.
 */
const VENDOR_SEARCH = {
  "Office Depot": (q) => `https://www.officedepot.com/catalog/search.do?Ntt=${q}`,
  Amazon: (q) => `https://www.amazon.com/s?k=${q}`,
  Staples: (q) => `https://www.staples.com/search?query=${q}`,
  Preferred: () => "https://www.pbsorder.com/",
};

/** Said on the link, because one of the four does not land on the product. */
const VENDOR_LINK_TITLE = {
  Preferred: "Opens the Preferred order portal. Prices are behind the account login.",
};

/* Local view state. None of it is a decision, so none of it belongs in app state. */
const view = {
  index: 0,
  /* Item names whose Amazon prefill the person has accepted or overwritten. */
  accepted: new Set(),
  flash: false,
  wasVisible: false,
};

let api = null;
let mounted = false;

export function mountPrice(injected) {
  api = injected;
  if (!mounted) {
    wire();
    mounted = true;
  }
  api.subscribe(render);
  render();
}

/** Jump to an item, for a leaderboard pill. Also honoured via `state.priceFocus`. */
export function focusPrice(focus) {
  if (!focus || !api) return;
  const at = items().findIndex((item) => item.canonical_name === focus.item);
  if (at >= 0) view.index = at;
  view.flash = false;
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

/* format.js money(): whole dollars plain, two places with {cents}, and up to four
   with {unit} for a per-each price, which is the only one this screen shows. */
function price(value) {
  const f = fmt().money;
  return f ? f(value, { unit: true }) : String(value ?? "");
}

function int(value) {
  const f = fmt().int;
  return f ? f(value) : String(value ?? "");
}

/**
 * The same set-at-a-time naming the leaderboard uses, so the card, the vendor
 * search links, the dot titles and the live region all say what the leaderboard
 * said. Calling `displayName` per item would show two of the three flag colours
 * under the same name on consecutive cards.
 */
let names = new Map();

function buildNames() {
  names = new Map();
  const f = fmt().distinctDisplayNames;
  if (!f) return;
  const rows = items();
  const distinct = f(rows);
  rows.forEach((row, i) => names.set(row, distinct[i]));
}

function displayName(row) {
  if (names.has(row)) return names.get(row);
  const f = fmt().displayName;
  return f ? f(row) : String(row.canonical_name || row.raw_title || "");
}

function say(message) {
  const live = $("#status-live");
  if (live) live.textContent = message;
}

/** The items being priced: the top N of the ranked list, in rank order. */
function items() {
  const s = api.state;
  return (s.ranked || []).slice(0, s.top || 25);
}

function current() {
  const all = items();
  if (!all.length) return null;
  view.index = Math.min(Math.max(view.index, 0), all.length - 1);
  return all[view.index];
}

/** The price rows for one item, by vendor. */
function rowsFor(name) {
  const rows = (api.state.priceRows || []).filter((r) => r.canonical_name === name);
  return new Map(rows.map((r) => [r.vendor, r]));
}

/** Last year's price for this item and vendor, when a report was carried in. */
function carried(name, vendor) {
  const rows = api.state.carriedPrices;
  if (!Array.isArray(rows)) return null;
  const hit = rows.find((r) => r.canonical_name === name && r.vendor === vendor);
  return hit ? num(hit.unit_price) : null;
}

/**
 * The Amazon figure the export already paid, which prefills the field. It is not a
 * price until accepted, so it is read from the ranked row and never from priceRows.
 */
function lastPaid(item) {
  return num(item.last_paid_per_each);
}

/** How far through: an item counts once every vendor cell has been answered. */
function progress() {
  const all = items();
  let done = 0;
  for (const item of all) {
    const rows = rowsFor(item.canonical_name);
    const answered = VENDORS.filter((v) => {
      const row = rows.get(v);
      return row && row.status && row.status !== "unpriced";
    }).length;
    if (answered === VENDORS.length) done += 1;
  }
  return { done, total: all.length };
}

/** empty, part or full, for one item's dot. */
function fillState(name) {
  const rows = rowsFor(name);
  const answered = VENDORS.filter((v) => {
    const row = rows.get(v);
    return row && row.status && row.status !== "unpriced";
  }).length;
  if (!answered) return "empty";
  return answered === VENDORS.length ? "full" : "part";
}

/**
 * Every vendor at the lowest price, once at least two are priced. Spec 2.3 wants
 * the comparison to appear as she types, and two figures are the least that can be
 * compared. A tie lights all of them, because none of them is the cheaper one.
 */
function cheapest(name) {
  const { best, priced } = cheapestVendors(rowsFor(name));
  return priced >= 2 ? best : new Set();
}

/* ───────────────────────────── render ───────────────────────────── */

function render() {
  if (!api || !api.state) return;

  const focus = api.state.priceFocus;
  if (focus) {
    const at = items().findIndex((item) => item.canonical_name === focus.item);
    if (at >= 0) view.index = at;
    delete api.state.priceFocus;
  }

  // Arriving on the screen is its own moment to take focus. Rebuilding the card
  // covers moving between items, but the card is usually already built when she
  // opens the screen, and then nothing would have claimed the caret.
  const screen = $("#screen-price");
  const visible = !!screen && !screen.hidden;

  buildNames();
  renderProgress();
  renderCard();
  renderDots();

  if (visible && !view.wasVisible) focusFirstUnpriced();
  view.wasVisible = visible;
}

function renderProgress() {
  const { done, total } = progress();
  $("#price-count").textContent = total
    ? `${int(done)} of ${int(total)} items priced`
    : "Nothing to price yet";
  // A fraction is a data value, so it rides in on a custom property and the
  // stylesheet owns everything else about the ring.
  const ring = $("#price-ring");
  if (ring) ring.style.setProperty("--ring-done", total ? String(done / total) : "0");
}

function renderCard() {
  const stage = $("#price-stage");
  const item = current();

  if (view.flash) {
    const { total } = progress();
    stage.innerHTML =
      `<p class="price-flash" data-test="price-flash">All ${esc(int(total))} priced</p>`;
    return;
  }

  if (!item) {
    stage.innerHTML =
      `<p class="price-flash">Nothing to price yet.</p>`;
    return;
  }

  const name = item.canonical_name;

  // A change event fires while the box is blurring. Replacing the card's markup at
  // that moment throws, and it would take the caret and the focus ring with it, on
  // the one screen that is meant to be driven from the keyboard. So the card is
  // rebuilt only when the item itself changes; an edit patches what it touched.
  const showing = stage.querySelector("[data-item]");
  if (showing && showing.dataset.item === name) {
    updateCard(item);
    return;
  }

  const rows = rowsFor(name);
  const best = cheapest(name);
  const short = displayName(item);
  const full = fullTitle(item);

  // Rebuilding the card takes away whatever is standing in it. If that happens
  // while a field is blurring, the browser is midway through removing the node the
  // blur handler is on and setting innerHTML throws. Standing down first makes the
  // change event fire and settle before anything is replaced.
  if (stage.contains(document.activeElement)) document.activeElement.blur();

  // The four price fields are adjacent in the DOM, which is the only way Tab can
  // move across them in four presses. The card is laid out as one grid with four
  // columns and four rows (vendor, price, status, note), so reading order and
  // tab order are the same thing and neither fights the layout.
  stage.innerHTML =
    `<article class="price-card" data-test="price-card" data-item="${esc(name)}">` +
    `<p class="price-rank">Rank ${esc(int(item.rank))}</p>` +
    `<h2 class="price-name" data-test="price-name">${esc(short)}</h2>` +
    (full && full !== short ? `<p class="price-full">${esc(full)}</p>` : "") +
    `<p class="price-facts">${esc(int(item.eaches))} bought` +
      (item.units_per_pack ? `, ${esc(int(item.units_per_pack))} per pack` : "") +
      `</p>` +
    `<div class="price-grid">` +
    VENDORS.map((v) => headHtml(item, v, best)).join("") +
    VENDORS.map((v) => inputHtml(item, v, rows.get(v))).join("") +
    VENDORS.map((v) => statusHtml(item, v, rows.get(v))).join("") +
    VENDORS.map((v) => noteHtml(item, v, rows.get(v))).join("") +
    `</div></article>`;

  focusFirstUnpriced();
}

/** The vendor name, its link, and the mark that says it is the cheapest so far. */
function headHtml(item, vendor, best) {
  const query = encodeURIComponent(displayName(item));
  const override = api.state.vendorSites && api.state.vendorSites[vendor];
  const site = override || (VENDOR_SEARCH[vendor] ? VENDOR_SEARCH[vendor](query) : "");
  const hint = VENDOR_LINK_TITLE[vendor];
  const label = site
    ? `<a href="${esc(site)}" target="_blank" rel="noopener noreferrer"` +
      `${hint ? ` title="${esc(hint)}"` : ""}>${esc(vendor)}</a>`
    : esc(vendor);
  return `<div class="pv-head${best.has(vendor) ? " is-best" : ""}" data-test="price-vendor"` +
    ` data-vendor="${esc(vendor)}">` +
    `<span class="pv-name">${label}</span>` +
    `<span class="pv-best-mark">cheapest</span></div>`;
}

function inputHtml(item, vendor, row) {
  const value = boxValue(item, vendor, row);
  return `<div class="pv-cell" data-vendor="${esc(vendor)}">` +
    `<label class="visually-hidden" for="pv-${esc(vendor)}">` +
      `${esc(vendor)} price per each for ${esc(displayName(item))}</label>` +
    `<input class="form-control pv-input" id="pv-${esc(vendor)}" type="text"` +
      ` inputmode="decimal" data-price-input="${esc(vendor)}" value="${esc(value)}"` +
      ` data-test="pv-input"></div>`;
}

function statusHtml(item, vendor, row) {
  const status = String((row && row.status) || "unpriced");
  return `<div class="pv-cell" data-vendor="${esc(vendor)}">` +
    `<label class="visually-hidden" for="pv-status-${esc(vendor)}">` +
      `${esc(vendor)} status for ${esc(displayName(item))}</label>` +
    `<select class="form-select form-select-sm" id="pv-status-${esc(vendor)}"` +
      ` data-price-status="${esc(vendor)}">` +
    STATUS_LABELS.map(([code, label]) =>
      `<option value="${code}"${status === code ? " selected" : ""}>${label}</option>`
    ).join("") +
    `</select></div>`;
}

function noteHtml(item, vendor, row) {
  const status = String((row && row.status) || "unpriced");
  return `<span class="pv-note" data-vendor="${esc(vendor)}">` +
    `${esc(noteFor(item, vendor, status))}</span>`;
}

/**
 * Item 3 of the phase 2 fix list: the screen opens with nothing focused, so even a
 * correct tab order starts from the top of the document. The first field with no
 * answer takes focus instead, and typing can start at once.
 */
function focusFirstUnpriced() {
  const screen = $("#screen-price");
  if (!screen || screen.hidden) return;
  const item = current();
  if (!item) return;
  const rows = rowsFor(item.canonical_name);
  const open = VENDORS.find((vendor) => {
    const row = rows.get(vendor);
    return !row || !row.status || row.status === "unpriced";
  });
  const box = document.querySelector(`[data-price-input="${open || VENDORS[0]}"]`);
  if (!box) return;

  // The click that brought her here focuses its own button after this render runs,
  // so focusing now would be undone a moment later. Taking the next frame puts the
  // card's first field last in that argument. It stands down if she has already
  // put the caret somewhere in the card herself.
  window.requestAnimationFrame(() => {
    if (screen.hidden || !box.isConnected) return;
    if (document.activeElement && screen.contains(document.activeElement)) return;
    box.focus({ preventScroll: true });
  });
}

/**
 * What a vendor's box shows: the stored price, or, for Amazon on an untouched row,
 * last year's paid figure as a prefill. The prefill lives in the input and nowhere
 * else, which is the whole of "display only": `status` stays `unpriced` until she
 * edits the box or presses Enter, so it never reaches prices.csv on its own.
 */
function boxValue(item, vendor, row) {
  const stored = String((row && row.unit_price) || "").trim();
  if (stored) return stored;
  if (vendor !== "Amazon" || view.accepted.has(item.canonical_name)) return "";
  const status = String((row && row.status) || "unpriced");
  if (status !== "unpriced") return "";
  const paid = lastPaid(item);
  return paid === null ? "" : String(paid);
}

/** The same card, moved to agree with state, without touching what has focus. */
function updateCard(item) {
  const rows = rowsFor(item.canonical_name);
  const best = cheapest(item.canonical_name);
  const active = document.activeElement;

  for (const vendor of VENDORS) {
    const row = rows.get(vendor);
    const status = String((row && row.status) || "unpriced");

    const head = document.querySelector(`.pv-head[data-vendor="${CSS.escape(vendor)}"]`);
    if (head) head.classList.toggle("is-best", best.has(vendor));

    // A box is only rewritten when what it should show has actually moved, and
    // never while it has focus. Rewriting a focused input resets the caret, which
    // on a keyboard-first screen shows up as typed digits landing out of order.
    const box = document.querySelector(`[data-price-input="${CSS.escape(vendor)}"]`);
    const should = boxValue(item, vendor, row);
    if (box && box !== active && box.value !== should) box.value = should;

    const select = document.querySelector(`[data-price-status="${CSS.escape(vendor)}"]`);
    if (select && select !== active && select.value !== status) select.value = status;

    const note = document.querySelector(`.pv-note[data-vendor="${CSS.escape(vendor)}"]`);
    if (note) note.textContent = noteFor(item, vendor, status);
  }
}

/** What sits under a vendor's field: the prefill mark, or last year, or nothing. */
function noteFor(item, vendor, status) {
  const name = item.canonical_name;
  const prefill = vendor === "Amazon" && lastPaid(item) !== null
    && !view.accepted.has(name) && status === "unpriced";
  if (prefill) return "last paid, change if the list price differs";
  const lastYear = carried(name, vendor);
  return lastYear !== null ? `last year ${price(lastYear)}` : "";
}

function fullTitle(item) {
  const s = api.state;
  const keys = String(item.keys || "").split("|").filter(Boolean);
  for (const key of keys) {
    const row = (s.master && typeof s.master.get === "function" && s.master.get(key))
      || (Array.isArray(s.masterRows) && s.masterRows.find((m) => m.key === key));
    if (row && row.raw_title) return row.raw_title;
  }
  return "";
}

function renderDots() {
  const all = items();
  $("#price-dots").innerHTML = all
    .map((item, index) => {
      const state = fillState(item.canonical_name);
      const classes = ["dot"];
      if (state === "full") classes.push("is-full");
      if (state === "part") classes.push("is-part");
      if (index === view.index && !view.flash) classes.push("is-current");
      const words = state === "full" ? "priced" : state === "part" ? "partly priced" : "not priced";
      return `<button type="button" class="${classes.join(" ")}" data-test="price-dot"` +
        ` data-jump="${index}" title="${esc(displayName(item))}"` +
        ` aria-label="${esc(displayName(item))}, ${words}"></button>`;
    })
    .join("");
}

/* ───────────────────────────── writes ───────────────────────────── */

/** One vendor cell. Typing a figure is itself the answer that it is priced. */
function commit(vendor, { value, status } = {}) {
  const item = current();
  if (!item) return;
  const name = item.canonical_name;
  if (vendor === "Amazon") view.accepted.add(name);

  if (status !== undefined) {
    api.setPrice(name, vendor, {
      status,
      unit_price: status === "priced" ? (value ?? "") : "",
    });
    return;
  }

  const text = String(value ?? "").trim();
  api.setPrice(name, vendor, {
    unit_price: text,
    status: text ? "priced" : "unpriced",
  });
}

/**
 * Enter accepts the card: any Amazon figure still sitting in the box as a prefill
 * becomes a real price, then the screen moves to the next item nobody has finished.
 */
function acceptCard() {
  const item = current();
  if (!item) return;
  const name = item.canonical_name;

  for (const vendor of VENDORS) {
    const box = document.querySelector(`[data-price-input="${vendor}"]`);
    if (!box) continue;
    const typed = box.value.trim();
    const row = rowsFor(name).get(vendor);
    const stored = String((row && row.unit_price) || "").trim();
    if (typed && typed !== stored) commit(vendor, { value: typed });
  }

  view.accepted.add(name);
  nextUnfinished();
}

function nextUnfinished() {
  const all = items();
  for (let step = 1; step <= all.length; step += 1) {
    const at = (view.index + step) % all.length;
    if (fillState(all[at].canonical_name) !== "full") {
      view.index = at;
      render();
      say(`${displayName(all[at])}, ${int(at + 1)} of ${int(all.length)}.`);
      return;
    }
  }

  // Nothing left anywhere: show the completion state, then hand back to Results
  // with the money line filled.
  view.flash = true;
  render();
  say(`All ${int(all.length)} priced.`);
  const wait = window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1200;
  window.setTimeout(() => {
    view.flash = false;
    api.go("results");
  }, wait);
}

/* ───────────────────────────── events ───────────────────────────── */

function wire() {
  $("#btn-price-close").addEventListener("click", () => api.go("results"));

  const stage = $("#price-stage");

  stage.addEventListener("change", (event) => {
    const box = event.target.closest("[data-price-input]");
    if (box) { commit(box.dataset.priceInput, { value: box.value }); return; }
    const select = event.target.closest("[data-price-status]");
    if (select) {
      const vendor = select.dataset.priceStatus;
      const input = document.querySelector(`[data-price-input="${vendor}"]`);
      commit(vendor, { status: select.value, value: input ? input.value.trim() : "" });
    }
  });

  // The cheapest field lights up as she types, not when she leaves the box.
  stage.addEventListener("input", (event) => {
    const box = event.target.closest("[data-price-input]");
    if (!box) return;
    if (box.dataset.priceInput === "Amazon") {
      const item = current();
      if (item) view.accepted.add(item.canonical_name);
    }
    markCheapestLive();
  });

  stage.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    acceptCard();
  });

  $("#price-dots").addEventListener("click", (event) => {
    const dot = event.target.closest("[data-jump]");
    if (!dot) return;
    view.index = Number(dot.dataset.jump);
    view.flash = false;
    render();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const screen = $("#screen-price");
    if (!screen || screen.hidden) return;
    if (document.querySelector("dialog[open]")) return;
    api.go("results");
  });
}

/**
 * The same comparison the stored rows drive, run against what is in the boxes right
 * now so the highlight keeps up with typing. It marks only; it writes nothing.
 */
function markCheapestLive() {
  const typed = [];
  for (const vendor of VENDORS) {
    const box = document.querySelector(`[data-price-input="${vendor}"]`);
    const select = document.querySelector(`[data-price-status="${vendor}"]`);
    if (!box) continue;
    const status = select ? select.value : "priced";
    if (status === "not_available" || status === "discontinued") continue;
    const value = num(box.value);
    if (value !== null) typed.push([vendor, value]);
  }
  let best = new Set();
  if (typed.length >= 2) {
    const lowest = Math.min(...typed.map(([, value]) => value));
    best = new Set(typed.filter(([, value]) => value === lowest).map(([v]) => v));
  }
  for (const cell of document.querySelectorAll("[data-test='price-vendor']")) {
    cell.classList.toggle("is-best", best.has(cell.dataset.vendor));
  }
}

export default mountPrice;
