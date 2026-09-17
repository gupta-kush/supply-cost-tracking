/* Headless test for the Price screen (plan task P3).
 *
 * Drives the real `screens/price.js` and `screens/results.js` through a browser,
 * types two prices into the price card, and asserts the two things that can only be
 * checked end to end:
 *
 *   1. the money line on Results is right, and it updated without a reload (P2);
 *   2. the `prices.csv` text pipeline.js builds from what the screen wrote is the
 *      exact v1 shape, and the Amazon prefill is NOT in it.
 *
 * The prefill check is the point of the test. `templateRow` leaves the Amazon row
 * empty at `status: "unpriced"` and puts last year's figure in `note`; if the screen
 * ever writes that figure at render time, `prices.csv`, the money line, the ring and
 * the `PRICES_UNPRICED` finding all move at once without anyone having looked at the
 * item. That is silent and expensive, so it is asserted rather than eyeballed.
 *
 * Runs against `tests/results-preview.html` and its fixture, because `app.js` is not
 * yet the v2 one. When A2 lands, point PAGE at `/index.html`, drop the real inputs
 * on the drop screen and delete `seed()`; every assertion below stays as it is.
 *
 *   node tests/headless-price.js
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const PORT = Number(process.env.SUPPLYTRACK_PORT || 8091);
const PAGE = `http://127.0.0.1:${PORT}/tests/results-preview.html`;

let failures = 0;
let checks = 0;

function is(actual, expected, what) {
  checks += 1;
  if (actual === expected) return;
  failures += 1;
  console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
}

function ok(value, what) {
  checks += 1;
  if (value) return;
  failures += 1;
  console.error(`FAIL ${what}`);
}

/**
 * Playwright is a dev dependency of this folder (plan task 0.2). Until that landed
 * it is also resolvable from an npx cache, so the path can be handed in rather than
 * making the whole suite unrunnable.
 */
async function loadChromium() {
  const override = process.env.PLAYWRIGHT_MODULE;
  const from = override ? override : "playwright";
  try {
    return (await import(from)).chromium;
  } catch (error) {
    console.error(
      "Could not load playwright. Install it in src/web, or set PLAYWRIGHT_MODULE " +
      "to the module path.\n" + error.message
    );
    process.exit(2);
  }
}

function serve() {
  const child = spawn("python", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
    cwd: WEB,
    stdio: "ignore",
  });
  return child;
}

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${url} never came up`);
}

/** Clear every price so the run starts from the state Kerryne actually sees. */
async function seed(page) {
  await page.click('[data-do="prices-none"]');
  await page.waitForTimeout(100);
}

async function typePrice(page, vendor, value) {
  const box = page.locator(`[data-price-input="${vendor}"]`);
  await box.fill(value);
  await box.dispatchEvent("change");
  await page.waitForTimeout(60);
}

async function main() {
  const chromium = await loadChromium();
  const server = serve();
  const browser = await chromium.launch();

  try {
    await waitFor(PAGE);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(PAGE, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__previewReady === true);

    await seed(page);

    // ── the money line starts empty ──────────────────────────────────────────
    await page.click('[data-do="screen-results"]');
    is(
      (await page.textContent('[data-test="money-figure"]')).trim(),
      "Price the items to see what is on the table",
      "money line before any price"
    );

    // ── price the first item ─────────────────────────────────────────────────
    await page.click('[data-test="btn-price"]');
    await page.waitForSelector('[data-test="price-card"]');

    is(
      (await page.textContent('[data-test="price-name"]')).trim(),
      "Avery Name Tag Inserts",
      "price screen opens on rank 1"
    );
    is(
      (await page.textContent('[data-test="price-count"]')).trim(),
      "0 of 10 items priced",
      "nothing is priced before she types"
    );

    // The Amazon box is prefilled with last year's paid figure, and that is the
    // whole of it: the row behind it is still unpriced.
    is(
      await page.inputValue('[data-price-input="Amazon"]'),
      "0.1105",
      "Amazon box carries the prefill"
    );
    is(
      await page.inputValue("#pv-status-Amazon"),
      "unpriced",
      "the prefill has not made the Amazon row priced"
    );

    // Item 3: the first field with no answer has focus the moment the card opens.
    await page.waitForFunction(() =>
      document.activeElement && document.activeElement.hasAttribute("data-price-input"));
    is(
      await page.evaluate(() => document.activeElement.getAttribute("data-price-input")),
      "Office Depot",
      "the first unpriced field has focus on entry"
    );

    // Item 2: four prices in four presses. The status controls and the vendor
    // links come after them, not between them.
    const tabbed = [];
    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press("Tab");
      tabbed.push(await page.evaluate(() => document.activeElement.getAttribute("data-price-input")));
    }
    is(
      tabbed.join(","),
      "Preferred,Amazon,Staples",
      "Tab moves across the four price fields"
    );

    await typePrice(page, "Office Depot", "0.10");
    await typePrice(page, "Amazon", "0.12");

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

    // ── a tie lights every vendor at the lowest price ────────────────────────
    await typePrice(page, "Staples", "0.10");
    is(
      await page.$$eval('[data-test="price-vendor"].is-best', (els) =>
        els.map((e) => e.dataset.vendor).join(",")),
      "Office Depot,Staples",
      "a tie for cheapest marks every vendor at that price"
    );
    await typePrice(page, "Staples", "");

    // ── Enter accepts the card and moves on, without throwing ────────────────
    // Item 1 of the phase 2 fix list: this threw an uncaught DOMException on every
    // run, because a change event fires while the field is blurring and the card
    // was being replaced underneath it. The `errors` check at the end is what
    // catches a regression; this is the path that produced it.
    const before = await page.textContent('[data-test="price-name"]');
    await page.focus('[data-price-input="Preferred"]');
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    ok(
      (await page.textContent('[data-test="price-name"]')) !== before,
      "Enter accepts the card and moves to the next unfinished item"
    );

    await page.click('[data-test="price-dot"]');
    await page.waitForTimeout(150);
    is(
      (await page.textContent('[data-test="price-name"]')).trim(),
      "Avery Name Tag Inserts",
      "a dot jumps back to its item"
    );

    // ── back to Results, money line filled, no reload ─────────────────────────
    await page.click('[data-test="btn-price-close"]');
    await page.waitForSelector('[data-test="screen-results"]:not([hidden])');

    // (0.12 minus 0.10) times 1,000 eaches.
    is((await page.textContent('[data-test="money-figure"]')).trim(), "$20", "money line figure");
    ok(
      (await page.textContent('[data-test="money-caption"]')).includes("1 item priced at both"),
      "money line caption names the basis"
    );

    // ── the file that would be written ───────────────────────────────────────
    const csv = await page.evaluate(() => window.__previewPricesCsv());
    const lines = csv.trim().split(/\r?\n/);

    is(
      lines[0],
      "rank,canonical_name,vendor,unit_price,status,url,checked_on,note",
      "prices.csv header is unchanged from v1"
    );
    ok(
      lines.includes("1,Avery Name Tag Inserts,Office Depot,0.10,priced,,2026-09-17,"),
      "the Office Depot price is written"
    );
    ok(
      lines.some((l) => l.startsWith("1,Avery Name Tag Inserts,Amazon,0.12,priced,")),
      "the Amazon price is written once she typed it"
    );
    // A "last paid per each" note is in this file in v1 too, so the check is that
    // no prefill became a price: the item she never opened is untouched, and so
    // are the vendors she did not fill on the item she did.
    ok(
      lines.includes("2,BIC Ballpoint Pens Black Medium,Amazon,,unpriced,,,last paid per each: 0.0997"),
      "an item she never opened keeps its prefill as a note and no price"
    );
    ok(
      lines.includes("1,Avery Name Tag Inserts,Preferred,,unpriced,,,"),
      "a vendor she did not fill on the open card stays unpriced"
    );
    is(
      lines.filter((l) => l.includes(",priced,")).length,
      2,
      "exactly the two cells she answered are priced"
    );

    is(errors.join(" | "), "", "no page errors");
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`${checks - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
