/* Headless test for the Price screen (plan task P3).
 *
 * Drives the real page, in a browser, on the real 2025 exports. It drops the two
 * order exports and the carried item master, builds the list, prices one item
 * through the Price screen and asserts the two things that can only be checked end
 * to end:
 *
 *   1. the money line on Results is right, and it moved without a reload (P2);
 *   2. the `prices.csv` text `pipeline.js` builds from what the screen wrote is the
 *      exact v1 shape, and the Amazon prefill is NOT in it.
 *
 * The prefill checks are the point. `templateRow` leaves the Amazon row empty at
 * `status: "unpriced"` and puts last year's figure in `note`; if the screen ever
 * writes that figure at render time, `prices.csv`, the money line, the progress
 * ring and the `PRICES_UNPRICED` finding all move at once without anyone having
 * looked at the item. That is silent and expensive, so it is asserted.
 *
 * The carried `prices.csv` is deliberately NOT dropped. With it the page starts
 * almost fully priced, which is a fine state and the wrong one for this test: the
 * questions here are what an empty cell does and what a prefill does.
 *
 * Inputs are confidential and never committed. `SUPPLYTRACK_INBOX` names the
 * project root that holds `inbox/` and `data/`, as in `headless-2025.js`.
 *
 *   node tests/headless-price.js
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pricesToCsv } from "../js/pipeline.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, "..");
const PROJECT_ROOT = process.env.SUPPLYTRACK_INBOX
  ? path.resolve(process.env.SUPPLYTRACK_INBOX)
  : path.resolve(HERE, "../../..");

const AMAZON_EXPORT = path.join(PROJECT_ROOT, "inbox", "exports-2025", "amazon-orders-2025.xlsx");
const PREFERRED_EXPORT = path.join(PROJECT_ROOT, "inbox", "exports-2025", "preferred-orders-2025.xlsx");
const ITEM_MASTER = path.join(PROJECT_ROOT, "data", "item_master.csv");

// ---------------------------------------------------------------- harness

let passed = 0;
const failures = [];

function is(actual, expected, what) {
  if (actual === expected) { passed += 1; return; }
  failures.push(`${what}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}

function ok(value, what) {
  if (value) { passed += 1; return; }
  failures.push(what);
}

function requireFile(target, label) {
  if (!fs.existsSync(target)) {
    throw new Error(
      `${label} not found at ${target}. Set SUPPLYTRACK_INBOX to the project root that ` +
        "holds inbox/ and data/ (it defaults to this repository's own, sibling to src/)."
    );
  }
  return target;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForServer(url, tries = 50) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server at ${url} never came up.`);
}

// -------------------------------------------------------------------- run

async function typePrice(page, vendor, value) {
  const box = page.locator(`[data-price-input="${vendor}"]`);
  await box.fill(value);
  await box.dispatchEvent("change");
  await page.waitForTimeout(80);
}

async function main() {
  requireFile(AMAZON_EXPORT, "the 2025 Amazon export");
  requireFile(PREFERRED_EXPORT, "the 2025 Preferred export");
  requireFile(ITEM_MASTER, "the carried item master");

  const port = await freePort();
  const url = `http://127.0.0.1:${port}/index.html`;
  const server = spawn("python", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
    cwd: WEB_DIR,
    stdio: "ignore",
  });
  const browser = await chromium.launch();

  try {
    await waitForServer(url);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(url);
    await page.waitForFunction(() => window.__supplytrackReady === true);
    await page.setInputFiles("#file-input", [AMAZON_EXPORT, PREFERRED_EXPORT, ITEM_MASTER]);
    await page.click("#btn-build");
    await page.waitForFunction(
      () => { const s = window.__supplytrackState; return Boolean(s && (s.screen === "results" || s.error)); },
      { timeout: 90000 }
    );

    const state = await page.evaluate(() => {
      const s = window.__supplytrackState;
      return { top: s.top, ranked: s.ranked.length, first: s.ranked[0] };
    });
    is(state.ranked, 140, "140 items ranked");

    // ── the money line starts empty ──────────────────────────────────────────
    is(
      (await page.textContent('[data-test="money-figure"]')).trim(),
      "Price the items to see what is on the table",
      "money line before any price"
    );

    // Three flag colours share a truncated name, so the leaderboard has to name the
    // whole set at once rather than each row on its own. review-final.md item 1.
    const topNames = await page.$$eval('[data-test="lb-row"] .lb-name',
      (els) => els.slice(0, 3).map((e) => e.textContent.trim()));
    is(new Set(topNames).size, 3, "the top three rows are three different names");

    // ── into the price screen ────────────────────────────────────────────────
    await page.click('[data-test="btn-price"]');
    await page.waitForSelector('[data-test="price-card"]');

    is(
      (await page.textContent('[data-test="price-name"]')).trim(),
      topNames[0],
      "the price card names the item the leaderboard named"
    );
    is(
      (await page.textContent('[data-test="price-count"]')).trim(),
      `0 of ${state.top} items priced`,
      "nothing is priced before she types"
    );

    // The Amazon box carries last year's paid figure, and that is the whole of it:
    // the row behind it is still unpriced.
    const paid = String(state.first.last_paid_per_each || "");
    ok(paid.length > 0, "the top item has a last paid figure to prefill from");
    is(await page.inputValue('[data-price-input="Amazon"]'), paid, "Amazon box carries the prefill");
    is(await page.inputValue("#pv-status-Amazon"), "unpriced", "the prefill has not made the row priced");

    // Phase 2 fix list item 3: the first field with no answer has focus on entry.
    await page.waitForFunction(() =>
      document.activeElement && document.activeElement.hasAttribute("data-price-input"));
    is(
      await page.evaluate(() => document.activeElement.getAttribute("data-price-input")),
      "Office Depot",
      "the first unpriced field has focus on entry"
    );

    // Item 2: four prices in four presses.
    const tabbed = [];
    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press("Tab");
      tabbed.push(await page.evaluate(() => document.activeElement.getAttribute("data-price-input")));
    }
    is(tabbed.join(","), "Preferred,Amazon,Staples", "Tab moves across the four price fields");

    // Round figures, so the money line is a hand calculation: one dollar saved on
    // every each of the top item.
    await typePrice(page, "Office Depot", "1.00");
    await typePrice(page, "Amazon", "2.00");

    ok(
      (await page.getAttribute('[data-test="price-vendor"][data-vendor="Office Depot"]', "class"))
        .split(" ").includes("is-best"),
      "the cheaper vendor is marked as soon as two prices exist"
    );
    is(
      await page.$$eval('[data-test="price-vendor"].is-best', (els) => els.length),
      1,
      "and only that one, while the prices differ"
    );

    // A tie lights every vendor at the lowest price, not the first in vendor order.
    await typePrice(page, "Staples", "1.00");
    is(
      await page.$$eval('[data-test="price-vendor"].is-best',
        (els) => els.map((e) => e.dataset.vendor).join(",")),
      "Office Depot,Staples",
      "a tie for cheapest marks every vendor at that price"
    );
    await typePrice(page, "Staples", "");

    // ── Enter accepts the card and moves on, without throwing ────────────────
    // Phase 2 fix list item 1: this threw an uncaught DOMException on every run,
    // because a change event fires while the field is blurring and the card was
    // being replaced underneath it. The `errors` check at the end catches a
    // regression; this is the path that produced it.
    const before = await page.textContent('[data-test="price-name"]');
    await page.focus('[data-price-input="Preferred"]');
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    ok(
      (await page.textContent('[data-test="price-name"]')) !== before,
      "Enter accepts the card and moves to the next unfinished item"
    );

    await page.click('[data-test="price-dot"]');
    await page.waitForTimeout(200);
    is(
      (await page.textContent('[data-test="price-name"]')).trim(),
      topNames[0],
      "a dot jumps back to its item"
    );

    // ── back to Results, money line filled, no reload ─────────────────────────
    await page.click('[data-test="btn-price-close"]');
    await page.waitForSelector('[data-test="screen-results"]:not([hidden])');

    const eaches = Number(state.first.eaches);
    const expected = `$${Math.round(eaches).toLocaleString("en-US")}`;
    is((await page.textContent('[data-test="money-figure"]')).trim(), expected,
      `money line is one dollar per each over ${eaches} eaches`);
    ok(
      (await page.textContent('[data-test="money-caption"]')).includes("1 item priced at both"),
      "money line caption names the basis"
    );

    // ── the file that would be written ───────────────────────────────────────
    const priceRows = await page.evaluate(() => window.__supplytrackState.priceRows);
    const csv = pricesToCsv(priceRows);
    const lines = csv.trim().split(/\r?\n/);
    const name = state.first.canonical_name;

    is(
      lines[0],
      "rank,canonical_name,vendor,unit_price,status,url,checked_on,note",
      "prices.csv header is unchanged from v1"
    );
    is(
      lines.filter((l) => l.includes(",priced,")).length,
      2,
      "exactly the two cells she answered are priced"
    );
    ok(
      priceRows.some((r) => r.canonical_name === name && r.vendor === "Office Depot"
        && r.unit_price === "1.00" && r.status === "priced"),
      "the Office Depot price is written"
    );
    ok(
      priceRows.some((r) => r.canonical_name === name && r.vendor === "Amazon"
        && r.unit_price === "2.00" && r.status === "priced"),
      "the Amazon price is written once she typed it"
    );
    // A "last paid per each" note is in this file in v1 too, so the check is that no
    // prefill became a price: every other Amazon row carrying one is still empty.
    const leaked = priceRows.filter(
      (r) => r.vendor === "Amazon" && r.canonical_name !== name
        && String(r.note || "").startsWith("last paid per each")
        && String(r.unit_price || "").trim() !== ""
    );
    is(leaked.length, 0, "no prefill anywhere became a price");
    ok(
      priceRows.some((r) => r.canonical_name === name && r.vendor === "Preferred"
        && String(r.unit_price || "") === "" && r.status === "unpriced"),
      "a vendor she did not fill on the open card stays unpriced"
    );

    is(errors.join(" | "), "", "no page errors");
  } finally {
    await browser.close();
    server.kill();
  }

  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
