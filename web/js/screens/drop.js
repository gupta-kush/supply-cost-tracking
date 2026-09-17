/* screens/drop.js - the Drop screen: target, chips, funnel, error state, model settings.
 *
 * Mounted by injection from app.js (`mount(api)`), the same pattern `screens/results.js` uses:
 * this module renders into the markup `index.html` already has for `[data-screen="drop"]" and
 * never reaches into pipeline.js, report.js or suggest.js beyond the constants below, which are
 * plain configuration data, not pipeline calls.
 */

import { DEFAULT_MODELS, CHEAP_MODELS } from "../suggest.js";

const $ = (sel) => document.querySelector(sel);

const KIND_NAMES = {
  amazon: "Amazon export",
  preferred: "Preferred export",
  item_master: "Item master",
  prices: "Prices",
  prices_retired: "Prices retired",
};

// app.js's onStage names -> the markup's data-stage / data-test suffix. "items" (office items
// ranked) is spelled "office" in the markup (webapp-v2-spec.md section 3's own "office items").
const STAGE_ORDER = ["lines", "products", "items", "top"];
const STAGE_DOM_KEY = { lines: "lines", products: "products", items: "office", top: "top" };
// Per-stage floor so four real figures still read as a roughly two-second reveal even when the
// pipeline itself is instant; a slow run simply waits for the real value instead (never faked).
const STAGE_FLOOR_MS = 500;
const COUNT_UP_MS = 400;

let api = null;

export function mount(injected) {
  api = injected;
  wireFileInputs();
  wireBuild();
  wireSettings();
  api.subscribe(render);
  render();
}

/* ───────────────────────────── files ───────────────────────────── */

function fileId(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function addFiles(fileList) {
  const seen = new Set(api.state.files.map(fileId));
  for (const file of Array.from(fileList || [])) {
    const id = fileId(file);
    if (seen.has(id)) continue;
    seen.add(id);
    api.state.files.push(file);
  }
  render();
}

function removeFile(id) {
  api.state.files = api.state.files.filter((f) => fileId(f) !== id);
  render();
}

function wireFileInputs() {
  const input = $("#file-input");
  input.addEventListener("change", () => {
    addFiles(input.files);
    // A re-pick of the same file only fires `change` if the input is emptied first.
    input.value = "";
  });

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  for (const zone of [$("#drop-target"), $("#drop-strip")]) {
    if (!zone) continue;
    zone.addEventListener("dragover", (e) => { stop(e); zone.classList.add("is-over"); });
    zone.addEventListener("dragleave", (e) => { stop(e); zone.classList.remove("is-over"); });
    zone.addEventListener("drop", (e) => {
      stop(e);
      zone.classList.remove("is-over");
      addFiles(e.dataTransfer?.files);
    });
  }

  $("#file-chips").addEventListener("click", (e) => {
    const button = e.target.closest("[data-remove]");
    if (button) removeFile(button.dataset.remove);
  });
}

function kindFor(file) {
  const found = ((api.state.classified && api.state.classified.recognised) || [])
    .find((f) => f.file === file.name);
  if (!found) return "";
  return KIND_NAMES[found.kind || found.vendor] || "";
}

function renderChips() {
  const box = $("#file-chips");
  box.textContent = "";
  for (const file of api.state.files) {
    const chip = document.createElement("span");
    chip.className = "file-chip";

    const name = document.createElement("span");
    name.className = "file-chip-name";
    name.textContent = file.name;
    chip.appendChild(name);

    const kind = kindFor(file);
    if (kind) {
      const kindEl = document.createElement("span");
      kindEl.className = "file-chip-kind";
      kindEl.textContent = kind;
      chip.appendChild(kindEl);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "file-chip-remove";
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.dataset.remove = fileId(file);
    remove.textContent = "×";
    chip.appendChild(remove);

    box.appendChild(chip);
  }
}

/* ───────────────────────────── build ───────────────────────────── */

function wireBuild() {
  $("#year").addEventListener("change", () => {
    api.state.year = Number($("#year").value) || null;
  });
  $("#top-n").addEventListener("change", () => {
    api.state.top = Number($("#top-n").value) || 25;
    render();
  });
  $("#btn-build").addEventListener("click", () => {
    if (api.state.busy || !api.state.files.length) return;
    runBuild();
  });
}

function resetFunnel() {
  for (const domKey of new Set(Object.values(STAGE_DOM_KEY))) {
    const li = document.querySelector(`.funnel-fig[data-stage="${domKey}"]`);
    if (li) li.classList.remove("is-shown");
    const span = document.querySelector(`[data-test="funnel-${domKey}"]`);
    if (span) span.textContent = "0";
  }
}

function countUp(span, target) {
  const end = Number(target) || 0;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / COUNT_UP_MS);
    span.textContent = String(Math.round(end * t));
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function showFigure(stage, value) {
  const domKey = STAGE_DOM_KEY[stage] || stage;
  const span = document.querySelector(`[data-test="funnel-${domKey}"]`);
  if (!span) return;
  countUp(span, value);
  const li = document.querySelector(`.funnel-fig[data-stage="${domKey}"]`);
  if (li) li.classList.add("is-shown");
}

async function runBuild() {
  resetFunnel();
  $("#funnel").hidden = false;
  $("#drop-error").hidden = true;
  const started = performance.now();
  await api.buildList({
    onStage(name, value) {
      const idx = STAGE_ORDER.indexOf(name);
      const floorAt = (idx < 0 ? STAGE_ORDER.length : idx + 1) * STAGE_FLOOR_MS;
      const wait = Math.max(0, floorAt - (performance.now() - started));
      setTimeout(() => showFigure(name, value), wait);
    },
  });
  if (api.state.error) $("#funnel").hidden = true;
}

/* ───────────────────────────── errors ───────────────────────────── */

function renderError(message) {
  $("#drop-error").hidden = false;
  $("#drop-error-text").textContent = message;
  const list = $("#drop-error-sheets");
  list.textContent = "";
  const ignored = (api.state.classified && api.state.classified.ignored) || [];
  for (const sheet of ignored) {
    const li = document.createElement("li");
    const where = sheet.sheet ? `${sheet.file} - ${sheet.sheet}` : sheet.file;
    li.textContent = `${where}: ${sheet.reason}`;
    list.appendChild(li);
  }
}

/* ───────────────────────────── model settings ───────────────────────────── */

function fillModelOptions() {
  const vendor = $("#ai-provider").value;
  const select = $("#ai-model");
  const seen = new Set();
  select.textContent = "";
  for (const [label, model] of [["recommended", DEFAULT_MODELS[vendor]], ["cheaper", CHEAP_MODELS[vendor]]]) {
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const opt = document.createElement("option");
    opt.value = model;
    opt.textContent = `${model} (${label})`;
    select.appendChild(opt);
  }
}

function wireSettings() {
  const dialog = $("#settings-sheet");
  $("#btn-settings").addEventListener("click", () => dialog.showModal());
  $("#ai-provider").addEventListener("change", fillModelOptions);
  dialog.addEventListener("close", () => {
    api.setAiSettings({
      vendor: $("#ai-provider").value,
      model: $("#ai-model").value,
      apiKey: $("#ai-key").value.trim(),
      askEverything: $("#ai-all").checked,
    });
  });
  fillModelOptions();
}

/* ───────────────────────────── render ───────────────────────────── */

function render() {
  if (!api) return;
  const s = api.state;
  $("#screen-drop").classList.toggle("has-files", s.files.length > 0);
  $("#drop-strip").hidden = s.files.length === 0;
  renderChips();
  if (s.year) $("#year").value = String(s.year);
  $("#top-n").value = String(s.top || 25);
  $("#funnel-top-label").textContent = `top ${s.top || 25}`;
  $("#btn-build").disabled = s.busy || s.files.length === 0;
  if (s.error) renderError(s.error);
  else $("#drop-error").hidden = true;
}
