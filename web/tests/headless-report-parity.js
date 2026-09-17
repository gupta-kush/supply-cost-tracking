/* D2: the report Done downloads must match out/ cell for cell.
 * `node web/tests/headless-report-parity.js`
 *
 * Drives the real page in Chromium with the real 2025 inputs (the two order
 * exports, the carried item master, prices and retired prices), clicks
 * through to Done, downloads the report, and compares it against
 * out/Acme Widget Top 25 Items Comparison 2025.xlsx - the same workbook the
 * Python CLI (`python -m supplytrack report --year 2025 --data-dir data
 * --out-dir out`) builds from the same data/. Regenerate that reference
 * before running this if the master or prices change.
 *
 * The six data sheets (Top 25, All items, Excluded, Item master, Prices,
 * Prices retired) are compared cell for cell via xlsx-dump.js, the same
 * dump report-tests.js uses. Sources is compared by key, not by cell
 * address, and two kinds of key are logged rather than asserted on:
 * `SESSION_HISTORY_KEYS` (`warnings` - the CLI's accumulates across every
 * separate ingest/rank/validate/report invocation ever run against this
 * data/, which a clean one-pass browser session cannot and should not try
 * to reproduce), and keys that exist on only one side by the same kind of
 * architecture split (`ranked_at`/`included_lines`/etc. are CLI-only
 * bookkeeping the persisted run.json accumulates; `exports`/`vendors`/
 * `ignored` are browser-only bookkeeping `ingest()` already returns and
 * always has, in v1 too). Every other key must match exactly (timestamps
 * masked).
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newWorkbook } from "../js/xlsxio.js";
import { dumpWorkbook, deepEqual, maskScalar } from "./xlsx-dump.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, "..");
const PROJECT_ROOT = process.env.SUPPLYTRACK_INBOX
  ? path.resolve(process.env.SUPPLYTRACK_INBOX)
  : path.resolve(HERE, "../../..");

const AMAZON_EXPORT = path.join(PROJECT_ROOT, "inbox", "exports-2025", "amazon-orders-2025.xlsx");
const PREFERRED_EXPORT = path.join(PROJECT_ROOT, "inbox", "exports-2025", "preferred-orders-2025.xlsx");
const ITEM_MASTER = path.join(PROJECT_ROOT, "data", "item_master.csv");
const PRICES_2025 = path.join(PROJECT_ROOT, "data", "2025", "prices.csv");
const PRICES_RETIRED_2025 = path.join(PROJECT_ROOT, "data", "2025", "prices_retired.csv");
const REFERENCE = path.join(PROJECT_ROOT, "out", "Acme Widget Top 25 Items Comparison 2025.xlsx");

// Keys the Sources sheet carries only because the CLI accumulates run.json across separate,
// persisted ingest/rank/validate/report invocations - the browser builds everything in one
// pass and has no equivalent history. Logged, never asserted on; see the module docstring.
const SESSION_HISTORY_KEYS = new Set(["warnings"]);

const DATA_SHEETS = ["Top 25", "All items", "Excluded", "Item master", "Prices", "Prices retired"];

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

function assertTrue(name, value, detail = "expected true") {
  return value ? ok() : bad(name, detail);
}

function assertDeep(name, actual, expected) {
  return deepEqual(actual, expected)
    ? ok()
    : bad(name, `expected: ${JSON.stringify(expected)}\n     actual: ${JSON.stringify(actual)}`);
}

function requireFile(target, label) {
  if (!fs.existsSync(target)) {
    throw new Error(
      `${label} not found at ${target}. Set SUPPLYTRACK_INBOX to the project root that holds ` +
        "inbox/, data/ and out/ (it defaults to this repository's own, sibling to src/), and " +
        "regenerate out/ with: python -m supplytrack report --year 2025 --data-dir data --out-dir out"
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

// ------------------------------------------------------------- comparison

/** Column A/B pairs of a Sources sheet, keyed by A, masking timestamp-shaped values. */
function sourcesKeyValues(ws) {
  const map = new Map();
  const maxRow = ws.rowCount || 0;
  for (let r = 1; r <= maxRow; r += 1) {
    const key = ws.getCell(r, 1).value;
    if (key == null || key === "") continue;
    const raw = ws.getCell(r, 2).value;
    map.set(String(key), typeof raw === "string" ? maskScalar(raw) : raw);
  }
  return map;
}

function compareSources(actualWs, expectedWs) {
  const actualMap = sourcesKeyValues(actualWs);
  const expectedMap = sourcesKeyValues(expectedWs);
  const mismatched = [];
  const sessionHistory = [];
  for (const [key, value] of actualMap) {
    if (!expectedMap.has(key)) continue;
    if (deepEqual(value, expectedMap.get(key))) continue;
    if (SESSION_HISTORY_KEYS.has(key)) sessionHistory.push(key);
    else mismatched.push(`${key}: got ${JSON.stringify(value)} want ${JSON.stringify(expectedMap.get(key))}`);
  }
  const cliOnly = [...expectedMap.keys()].filter((k) => !actualMap.has(k));
  const browserOnly = [...actualMap.keys()].filter((k) => !expectedMap.has(k));
  return { mismatched, cliOnly, browserOnly, sessionHistory };
}

function compareDataSheet(name, actualSheet, expectedSheet) {
  if (!actualSheet) {
    bad(`${name}: sheet present`, "sheet missing from the downloaded workbook");
    return;
  }
  const actualCells = actualSheet.cells || {};
  const expectedCells = expectedSheet.cells || {};
  const actualKeys = new Set(Object.keys(actualCells));
  const expectedKeys = new Set(Object.keys(expectedCells));
  const missing = [...expectedKeys].filter((k) => !actualKeys.has(k));
  const extra = [...actualKeys].filter((k) => !expectedKeys.has(k));
  const mismatched = [...expectedKeys].filter(
    (k) => actualKeys.has(k) && !deepEqual(actualCells[k], expectedCells[k])
  );
  const okAll = missing.length === 0 && extra.length === 0 && mismatched.length === 0;
  if (okAll) {
    ok();
    return;
  }
  const parts = [];
  if (missing.length) parts.push(`missing ${missing.length} e.g. ${missing.slice(0, 5).join(", ")}`);
  if (extra.length) parts.push(`extra ${extra.length} e.g. ${extra.slice(0, 5).join(", ")}`);
  if (mismatched.length) {
    const examples = mismatched
      .slice(0, 5)
      .map((k) => `${k}: got ${JSON.stringify(actualCells[k])} want ${JSON.stringify(expectedCells[k])}`);
    parts.push(`mismatched ${mismatched.length} e.g. ${examples.join(" | ")}`);
  }
  bad(`${name}: cell values`, parts.join("; "));
}

// ------------------------------------------------------------------ main

async function run() {
  requireFile(AMAZON_EXPORT, "the standalone Amazon export");
  requireFile(PREFERRED_EXPORT, "the standalone Preferred export");
  requireFile(ITEM_MASTER, "the carried item master");
  requireFile(PRICES_2025, "the carried 2025 prices");
  requireFile(PRICES_RETIRED_2025, "the carried 2025 retired prices");
  requireFile(REFERENCE, "the reference out/ workbook");

  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const server = spawn("python", ["-m", "http.server", String(port), "--directory", WEB_DIR], {
    stdio: "ignore",
  });

  try {
    await waitForServer(url);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.waitForFunction(() => window.__supplytrackReady === true);
      await page.setInputFiles(
        "#file-input",
        [AMAZON_EXPORT, PREFERRED_EXPORT, ITEM_MASTER, PRICES_2025, PRICES_RETIRED_2025]
      );
      await page.click("#btn-build");
      await page.waitForFunction(
        () => {
          const s = window.__supplytrackState;
          return Boolean(s && (s.screen === "results" || s.error));
        },
        { timeout: 60000 }
      );
      const afterBuild = await page.evaluate(() => window.__supplytrackState.error);
      assertTrue("build reaches Results with no error", afterBuild === null, `error was: ${afterBuild}`);

      await page.click("#btn-finish");
      await page.waitForFunction(() => window.__supplytrackState.screen === "done", { timeout: 10000 });

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.click("#btn-download"),
      ]);
      const downloadPath = await download.path();
      assertTrue("the report downloaded", Boolean(downloadPath), "no download event fired");
      if (!downloadPath) return;

      const builtWb = await newWorkbook();
      await builtWb.xlsx.load(fs.readFileSync(downloadPath));
      const referenceWb = await newWorkbook();
      await referenceWb.xlsx.load(fs.readFileSync(REFERENCE));

      const actual = dumpWorkbook(builtWb);
      const expected = dumpWorkbook(referenceWb);

      for (const name of DATA_SHEETS) {
        compareDataSheet(name, actual.sheets[name], expected.sheets[name]);
      }

      const sources = compareSources(
        builtWb.getWorksheet("Sources"),
        referenceWb.getWorksheet("Sources")
      );
      assertDeep("Sources: every non-session-history key matches the reference", sources.mismatched, []);
      if (sources.sessionHistory.length) {
        console.log(
          `  note  Sources: ${sources.sessionHistory.length} key(s) differ because the CLI's ` +
            `run.json accumulates across every invocation ever run against this data/, not ` +
            `asserted on: ${sources.sessionHistory.join(", ")}`
        );
      }
      if (sources.cliOnly.length) {
        console.log(
          `  note  Sources: ${sources.cliOnly.length} key(s) only the CLI's accumulated run.json ` +
            `carries, not asserted on: ${sources.cliOnly.join(", ")}`
        );
      }
      if (sources.browserOnly.length) {
        console.log(
          `  note  Sources: ${sources.browserOnly.length} key(s) only the browser's ingest() ` +
            `bookkeeping carries (true in v1 too), not asserted on: ${sources.browserOnly.join(", ")}`
        );
      }

      await page.close();
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
