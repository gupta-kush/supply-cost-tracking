/* Headless harness against the real 2025 inputs: `node web/tests/headless-2025.js`.
 *
 * Serves web/ with `python -m http.server`, drives the page with Playwright, and asserts
 * against the live app state (`window.__supplytrackState`, app.js) rather than rendered text -
 * a screen is free to reword itself without breaking this. Phase 0 task 0.2, wired through to
 * Results by phase 1 task A5.
 *
 * Inputs are confidential and never committed. `SUPPLYTRACK_INBOX` names the project root that
 * holds `inbox/` and `data/`; it defaults to this repository's own sibling folders, which is
 * where they sit for anyone with the real 2025 data checked out alongside `src/`.
 *
 * Expected to fail against v1, which has no Results screen at all - that is the phase 1 exit
 * test the plan names it as.
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as csv from "../js/csv.js";
import * as fmt from "../js/format.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, "..");
const PROJECT_ROOT = process.env.SUPPLYTRACK_INBOX
  ? path.resolve(process.env.SUPPLYTRACK_INBOX)
  : path.resolve(HERE, "../../..");

const WORKBOOK = path.join(PROJECT_ROOT, "inbox", "Acme Widget Top 25 Items Comparison 2025.xlsx");
const ITEM_MASTER = path.join(PROJECT_ROOT, "data", "item_master.csv");
const PRICES_2025 = path.join(PROJECT_ROOT, "data", "2025", "prices.csv");
const RANKED_2025 = path.join(PROJECT_ROOT, "data", "2025", "ranked.csv");
const AMAZON_EXPORT = path.join(PROJECT_ROOT, "inbox", "exports-2025", "amazon-orders-2025.xlsx");
const PREFERRED_EXPORT = path.join(PROJECT_ROOT, "inbox", "exports-2025", "preferred-orders-2025.xlsx");

// ---------------------------------------------------------------- harness

let passed = 0;
let failed = 0;
const failures = [];

function ok() {
  passed += 1;
}

function bad(name, detail) {
  failed += 1;
  failures.push({ name, detail });
}

function assertEqual(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return ok();
  return bad(name, `expected: ${e}\n     actual: ${a}`);
}

function assertTrue(name, value, detail = "expected true") {
  return value ? ok() : bad(name, detail);
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

// ------------------------------------------------------------------ server

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
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server at ${url} never came up.`);
}

// -------------------------------------------------------------------- runs

/** The canonical_name column of a ranked.csv, in file order. */
function rankedNames(text) {
  return csv.parseObjects(text).rows.map((r) => r.canonical_name);
}

async function readState(page) {
  return page.evaluate(() => {
    const s = window.__supplytrackState;
    return {
      screen: s.screen,
      error: s.error,
      lines: s.lines ? s.lines.length : null,
      ranked: s.ranked,
      priceRows: s.priceRows,
      top: s.top,
      undecided: s.openCount,
      names: s.ranked.map((r) => r.canonical_name),
    };
  });
}

async function buildAndWait(page, url, files) {
  await page.goto(url);
  await page.waitForFunction(() => window.__supplytrackReady === true);
  await page.setInputFiles("#file-input", files);
  await page.click("#btn-build");
  await page.waitForFunction(
    () => {
      const s = window.__supplytrackState;
      return Boolean(s && (s.screen === "results" || s.error));
    },
    { timeout: 60000 }
  );
  return readState(page);
}

async function testWithCarriedMaster(browser, url) {
  const page = await browser.newPage();
  const state = await buildAndWait(page, url, [WORKBOOK, ITEM_MASTER, PRICES_2025]);

  assertEqual("with the carried master: no error", state.error, null);
  assertEqual("with the carried master: Results is reached", state.screen, "results");
  assertEqual("with the carried master: 1,238 order lines read", state.lines, 1238);
  assertEqual("with the carried master: 140 ranked", state.ranked.length, 140);
  assertEqual("with the carried master: 0 undecided", state.undecided, 0);

  const expected = rankedNames(fs.readFileSync(RANKED_2025, "utf8"));
  assertEqual("ranked names match data/2025/ranked.csv, in order", state.names, expected);

  // Reviewer, review-phase1-2.md item 8: the money line is the number the whole report exists
  // to surface, and the least loose check here was leaving it unasserted entirely.
  const money = fmt.moneyLine(state.ranked, state.priceRows, state.top);
  assertEqual("money line: $427 on the table", money.amount, 427);
  assertEqual("money line: 17 items priced at both", money.itemsCounted, 17);

  await page.close();
}

async function testExportsAlone(browser, url) {
  const page = await browser.newPage();
  const state = await buildAndWait(page, url, [AMAZON_EXPORT, PREFERRED_EXPORT]);

  assertEqual("exports alone: no error", state.error, null);
  assertEqual("exports alone: Results is reached", state.screen, "results");
  // Reviewer, review-phase1-2.md item 8: pinned exact counts, not just "> 0", so an
  // auto-decide regression that still leaves some undecided rows does not slip through.
  assertEqual("exports alone: 95 ranked", state.ranked.length, 95);
  assertEqual("exports alone: 286 undecided", state.undecided, 286);

  await page.close();
}

// ------------------------------------------------------------------ main

async function run() {
  requireFile(WORKBOOK, "the combined 2025 report workbook");
  requireFile(ITEM_MASTER, "the carried item master");
  requireFile(PRICES_2025, "the carried 2025 prices");
  requireFile(RANKED_2025, "the reference ranked.csv");
  requireFile(AMAZON_EXPORT, "the standalone Amazon export");
  requireFile(PREFERRED_EXPORT, "the standalone Preferred export");

  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const server = spawn("python", ["-m", "http.server", String(port), "--directory", WEB_DIR], {
    stdio: "ignore",
  });

  try {
    await waitForServer(url);
    const browser = await chromium.launch();
    try {
      await testWithCarriedMaster(browser, url);
      await testExportsAlone(browser, url);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }

  if (failures.length) {
    console.log("");
    for (const f of failures) console.log(`FAIL ${f.name}\n     ${f.detail}`);
  }
  console.log("");
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.log(`FAIL the harness itself threw: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
