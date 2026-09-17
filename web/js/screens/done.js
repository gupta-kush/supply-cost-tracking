/* screens/done.js - the summary screen: one screenshot, one download.
 *
 * Mounted by injection (`mountDone(api)`), same pattern as results.js and price.js, against
 * the markup already in index.html for `[data-screen="done"]`.
 *
 * webapp-v2-spec.md section 2.4. The one pipeline-shaped decision this screen makes -
 * "movement since last year" - is computed in app.js (`computeYearMovement`), not here: the
 * frozen adapter carries no prior year's rank (only item_master.csv/prices.csv are carry
 * sheets), so "last year" is the carried master ranked against this year's lines before
 * auto-decide touches it, diffed against the final rank. A first year has nothing to diff
 * against and `state.yearMovement` is null, which is what hides the section entirely.
 */

import { VENDORS, toNumber } from "./vendor-prices.js";

const $ = (sel) => document.querySelector(sel);

let api = null;

export function mountDone(injected) {
  api = injected;
  wire();
  api.subscribe(render);
  render();
}

function wire() {
  $("#btn-download").addEventListener("click", onDownload);
  $("#btn-done-back").addEventListener("click", () => api.go("results"));
  $("#dl-master").addEventListener("click", () => api.downloadTables("master"));
  $("#dl-prices").addEventListener("click", () => api.downloadTables("prices"));
  $("#dl-retired").addEventListener("click", () => api.downloadTables("retired"));
  $("#dl-run").addEventListener("click", () => api.downloadTables("run"));
}

async function onDownload() {
  const button = $("#btn-download");
  button.disabled = true;
  try {
    await api.downloadReport();
    render();
  } catch (err) {
    setBlocked(`The workbook could not be built. ${err && err.message ? err.message : err}`, {
      linkText: "Back to the list",
    });
  } finally {
    button.disabled = false;
  }
}

/* ───────────────────────────── render ───────────────────────────── */

function render() {
  if (!api) return;
  const s = api.state;
  const fmt = api.fmt;

  $("#h-done").textContent = `Top ${s.top} office supplies, ${s.year}. Ready.`;
  renderFigures(s, fmt);
  renderMoney(s, fmt);
  renderBasket(s, fmt);
  renderMovement(s);
  renderDecided(s, fmt);
  renderDownloadState(s, fmt);
}

function figureEl(value, label) {
  const li = document.createElement("li");
  li.className = "done-fig";
  const v = document.createElement("span");
  v.className = "done-fig-value";
  v.textContent = value;
  const l = document.createElement("span");
  l.className = "done-fig-label";
  l.textContent = label;
  li.append(v, l);
  return li;
}

function renderFigures(s, fmt) {
  const priced = (s.priceRows || []).filter((r) => r.status === "priced").length;
  const total = (s.priceRows || []).length;
  const list = $("#done-figures");
  list.textContent = "";
  list.appendChild(figureEl(fmt.int(s.counts.lines), "order lines read"));
  list.appendChild(figureEl(fmt.int(s.counts.office), "office items ranked"));
  // Always zero: rank() accounts for every line as included or excluded (run-tests.js's own
  // "every line is counted once" check), so there is nothing this figure could ever report but 0.
  list.appendChild(figureEl("0", "lines left uncounted"));
  list.appendChild(figureEl(`${total ? priced : 0} of ${total}`, "vendor prices filled"));
}

function renderMoney(s, fmt) {
  const money = api.moneyLine();
  // Same guard results.js uses (results.js:195): with nothing priced, "Amazon was already
  // cheapest" reads as a claim the run never made, not as "nothing to compare yet".
  if (!money || money.itemsCounted === 0) {
    $("#done-money").textContent = "No prices entered yet, so nothing to compare.";
    $("#done-money-caption").textContent = "";
    return;
  }
  $("#done-money").textContent = fmt.money(money.amount);
  $("#done-money-caption").textContent = money.basisSentence;
}

/** Vendor totals over the common basket: items priced at all four vendors, within the Top N. */
function basketTotals(s) {
  const eachesByName = new Map((s.ranked || []).map((r) => [r.canonical_name, Number(r.eaches) || 0]));
  const byName = new Map();
  for (const row of s.priceRows || []) {
    if (!byName.has(row.canonical_name)) byName.set(row.canonical_name, new Map());
    if (row.status === "priced") {
      const value = toNumber(row.unit_price);
      if (value !== null) byName.get(row.canonical_name).set(row.vendor, value);
    }
  }
  const totals = {};
  for (const vendor of VENDORS) totals[vendor] = 0;
  let qualifying = 0;
  for (const [name, prices] of byName) {
    if (!VENDORS.every((v) => prices.has(v))) continue;
    qualifying += 1;
    const eaches = eachesByName.get(name) || 0;
    for (const vendor of VENDORS) totals[vendor] += prices.get(vendor) * eaches;
  }
  return { totals, qualifying };
}

function renderBasket(s, fmt) {
  const box = $("#done-basket");
  box.textContent = "";
  const { totals, qualifying } = basketTotals(s);
  if (!qualifying) return;

  const caption = document.createElement("p");
  caption.className = "done-basket-caption";
  caption.textContent = `The four vendors, over the ${fmt.plural(qualifying, "item")} priced at all of them.`;
  box.appendChild(caption);

  const row = document.createElement("div");
  row.className = "done-basket-row";
  for (const vendor of VENDORS) {
    const cell = document.createElement("div");
    cell.className = "done-basket-cell";
    const name = document.createElement("div");
    name.className = "done-basket-vendor";
    name.textContent = vendor;
    const value = document.createElement("div");
    value.className = "done-basket-value";
    value.textContent = fmt.money(totals[vendor], { cents: true });
    cell.append(name, value);
    row.appendChild(cell);
  }
  box.appendChild(row);
}

function renderMovement(s) {
  const box = $("#done-movement");
  box.textContent = "";
  const m = s.yearMovement;
  if (!m || (!m.entered.length && !m.left.length && !m.movers.length)) return;

  const sentences = [];
  if (m.entered.length) {
    sentences.push(
      `Entered the Top ${s.top}: ${m.entered.map((e) => `${e.name} (rank ${e.rank})`).join(", ")}.`
    );
  }
  if (m.left.length) {
    sentences.push(`Left the Top ${s.top}: ${m.left.join(", ")}.`);
  }
  const up = m.movers.filter((mv) => mv.delta > 0).slice(0, 3);
  const down = m.movers.filter((mv) => mv.delta < 0).slice(0, 3);
  if (up.length) {
    sentences.push(`Biggest movers up: ${up.map((mv) => `${mv.name} (${mv.before} to ${mv.after})`).join(", ")}.`);
  }
  if (down.length) {
    sentences.push(`Biggest movers down: ${down.map((mv) => `${mv.name} (${mv.before} to ${mv.after})`).join(", ")}.`);
  }
  const p = document.createElement("p");
  p.textContent = sentences.join(" ");
  box.appendChild(p);
}

/** What the page decided on its own, from the run's own queue and master - no session-only
 *  tracking needed: a row only ever queues when it is not already a confirmed decision, so
 *  every queued key that ends this run with upp_source "master" was confirmed in this session. */
function computeDecided(s) {
  let fromTitle = 0;
  let checkedByYou = 0;
  for (const row of s.queueRows || []) {
    const entry = s.master.get(row.key);
    if (!entry) continue;
    const source = String(entry.upp_source || "").trim().toLowerCase();
    if (source === "master") checkedByYou += 1;
    else if (source === "title" || source === "proposed") fromTitle += 1;
  }
  return { fromTitle, checkedByYou, leftOpen: s.openCount };
}

function renderDecided(s, fmt) {
  const { fromTitle, checkedByYou, leftOpen } = computeDecided(s);
  $("#done-decided").textContent =
    `${fmt.plural(fromTitle, "pack size")} read from titles or proposed by the model, ` +
    `${fmt.int(checkedByYou)} checked by you, ${fmt.int(leftOpen)} left open.`;
}

function setBlocked(text, { linkText } = {}) {
  const blocked = $("#done-blocked");
  blocked.hidden = false;
  blocked.textContent = "";
  blocked.appendChild(document.createTextNode(text));
  if (linkText) {
    blocked.appendChild(document.createTextNode(" "));
    const link = document.createElement("button");
    link.type = "button";
    link.className = "btn btn-link btn-sm done-blocked-link";
    link.textContent = linkText;
    link.addEventListener("click", () => api.go("results"));
    blocked.appendChild(link);
  }
}

function clearBlocked() {
  const blocked = $("#done-blocked");
  blocked.hidden = true;
  blocked.textContent = "";
}

/**
 * Section 2.4: undecided items never block the download (spec change, 2026-09-17). The only
 * true block is nothing ranked at all - a failing check the page cannot work around - which
 * replaces the button with a sentence rather than showing it disabled.
 */
function renderDownloadState(s, fmt) {
  const button = $("#btn-download");
  const nothingRanked = (s.ranked || []).length === 0;

  if (nothingRanked) {
    button.hidden = true;
    setBlocked("Nothing could be ranked, so there is no report to build yet.", {
      linkText: "Back to the list",
    });
    return;
  }

  button.hidden = false;
  if (s.openCount > 0) {
    setBlocked(
      `${fmt.plural(s.openCount, "item")} still need a decision. They are named on the ` +
        "Sources sheet in the download.",
      { linkText: "Back to the things worth a look" }
    );
  } else {
    clearBlocked();
  }
}
