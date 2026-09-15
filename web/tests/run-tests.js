/* Parity tests for the browser port: `node src/web/tests/run-tests.js`.
 *
 * Every expectation in here was produced by the Python reference
 * implementation (`src/scripts/make_golden.py` into `src/tests/golden/`). A
 * failure means either the port is wrong or the Python changed deliberately;
 * in the second case regenerate the vectors from Python before touching this.
 *
 * No test framework and no dependencies - just Node 18+ and the two modules
 * under test, which are the same files the page loads.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as csv from "../js/csv.js";
import * as P from "../js/pipeline.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.resolve(HERE, "../../tests/golden");
const YEAR = 2025;
const TOP = 25;

// ---------------------------------------------------------------- harness

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function ok(name) {
  passed += 1;
}

function bad(name, detail) {
  failed += 1;
  failures.push({ name, detail });
}

function skip(name, why) {
  skipped += 1;
  console.log(`SKIP ${name} - ${why}`);
}

function assertEqual(name, actual, expected) {
  const a = typeof actual === "string" ? actual : JSON.stringify(actual);
  const e = typeof expected === "string" ? expected : JSON.stringify(expected);
  if (a === e) return ok(name);
  return bad(name, `expected: ${truncate(e)}\n     actual: ${truncate(a)}`);
}

function assertDeep(name, actual, expected) {
  assertEqual(name, JSON.stringify(actual), JSON.stringify(expected));
}

function assertTrue(name, value, detail = "expected true") {
  return value ? ok(name) : bad(name, detail);
}

function truncate(s, n = 600) {
  const text = String(s);
  return text.length <= n ? text : text.slice(0, n) + ` ... (${text.length} chars)`;
}

/** Line endings are the one difference we forgive; everything else is bytes. */
function normaliseEol(text) {
  return String(text).replace(/\r\n/g, "\n");
}

function assertCsvEqual(name, actual, expected) {
  const a = normaliseEol(actual);
  const e = normaliseEol(expected);
  if (a === e) return ok(name);
  const al = a.split("\n");
  const el = e.split("\n");
  let i = 0;
  while (i < al.length && i < el.length && al[i] === el[i]) i += 1;
  return bad(
    name,
    `first difference at line ${i + 1} of ${el.length}\n` +
      `     expected: ${truncate(el[i], 300)}\n` +
      `     actual:   ${truncate(al[i], 300)}`
  );
}

function read(...parts) {
  return fs.readFileSync(path.join(GOLDEN, ...parts), "utf8");
}

function exists(...parts) {
  return fs.existsSync(path.join(GOLDEN, ...parts));
}

function readJson(...parts) {
  return JSON.parse(read(...parts));
}

/**
 * Sort object keys throughout, so two JSON values compare by content.
 *
 * `make_golden.py` dumps with `sort_keys=True`, while the CLI's own `run.json`
 * and this port both write in insertion order. Key order carries no meaning in
 * either, so comparing it would only assert the generator's formatting.
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- csv.js

function testCsv() {
  assertDeep("csv.parse simple", csv.parse("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
  assertDeep("csv.parse crlf", csv.parse("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
  assertDeep("csv.parse no trailing newline", csv.parse("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
  assertDeep("csv.parse bom stripped", csv.parse("﻿a,b\n"), [["a", "b"]]);
  assertDeep("csv.parse quoted comma", csv.parse('a,"b,c"\n'), [["a", "b,c"]]);
  assertDeep("csv.parse doubled quote", csv.parse('"he said ""hi"""\n'), [['he said "hi"']]);
  assertDeep("csv.parse embedded newline", csv.parse('"a\nb",c\n'), [["a\nb", "c"]]);
  assertDeep("csv.parse trailing empty field", csv.parse("a,\n"), [["a", ""]]);
  assertDeep("csv.parse empty text", csv.parse(""), []);

  // Python's csv.writer, QUOTE_MINIMAL: only the delimiter, the quote and the
  // line terminator force quoting. Leading/trailing spaces do not.
  assertEqual("csv.serialise plain", csv.serialise([["a", "b"]]), "a,b\r\n");
  assertEqual("csv.serialise comma", csv.serialise([["a,b"]]), '"a,b"\r\n');
  assertEqual("csv.serialise quote", csv.serialise([['say "hi"']]), '"say ""hi"""\r\n');
  assertEqual("csv.serialise spaces unquoted", csv.serialise([[" a ", "b"]]), " a ,b\r\n");
  assertEqual("csv.serialise newline", csv.serialise([["a\nb"]]), '"a\nb"\r\n');
  assertEqual("csv.serialise lone empty field", csv.serialise([[""]]), '""\r\n');
  assertEqual("csv.serialise empty among many", csv.serialise([["", "a"]]), ",a\r\n");
  assertEqual("csv.serialise null as blank", csv.serialise([[null, undefined]]), ",\r\n");

  const round = 'a,"b,c"\r\n"d""e",\r\n';
  assertEqual("csv round trip", csv.serialise(csv.parse(round)), round);
}

// ---------------------------------------------------------- unit vectors

function testUnitVectors() {
  if (!exists("unit")) return skip("unit vectors", "src/tests/golden/unit is not there yet");

  for (const { input, output } of readJson("unit", "normalise_title.json")) {
    assertEqual(`normaliseTitle(${JSON.stringify(input)})`, P.normaliseTitle(input), output);
  }
  for (const { input, output } of readJson("unit", "decode_preferred_pack.json")) {
    assertDeep(`decodePreferredPack(${JSON.stringify(input)})`, P.decodePreferredPack(input), output);
  }
  for (const { input, output } of readJson("unit", "upp_candidates.json")) {
    assertDeep(`uppCandidates(${JSON.stringify(truncate(input, 60))})`, P.uppCandidates(input), output);
  }
  for (const { input, output } of readJson("unit", "suggest_include.json")) {
    const [include, reason] = P.suggestInclude(input.amazon_category, input.source);
    assertDeep(
      `suggestInclude(${JSON.stringify(input)})`,
      { include, reason },
      { include: output.include, reason: output.reason }
    );
  }
}

/** Behaviour the golden vectors do not cover but the port must not lose. */
function testPureHelpers() {
  assertEqual("amazonKey prefix", P.amazonKey("Some Title"), "amz:some title");
  assertEqual("preferredKey uppercases", P.preferredKey(" san30001 "), "pbs:SAN30001");

  assertTrue("isPackPhrase counts packs", P.isPackPhrase("12/Pack"));
  assertTrue("isPackPhrase ignores contents", !P.isPackPhrase("320 Sheets"));

  // difflib parity: the two thresholds the pipeline actually branches on.
  assertEqual("sequenceRatio identical", P.sequenceRatio("abc", "abc"), 1);
  assertEqual("sequenceRatio disjoint", P.sequenceRatio("abc", "xyz"), 0);
  assertEqual("sequenceRatio both empty", P.sequenceRatio("", ""), 1);
  assertEqual("sequenceRatio known value", P.sequenceRatio("pens", "pen"), 6 / 7);
  // Python's f"{x:.2f}" rounds half-to-even; toFixed rounds up. 0.875 = 7/8 is
  // the only exact midpoint reachable in the >= 0.85 band, and both give 0.88.
  assertEqual("formatRatio midpoint 0.875", P.formatRatio(0.875), "0.88");
  assertEqual("formatRatio 6/7", P.formatRatio(6 / 7), "0.86");

  // Decimals must never go through a float.
  assertEqual("perEach exact", P.perEach("12.50", 4), "3.125");
  assertEqual("perEach trims zeros", P.perEach("10", 4), "2.5");
  assertEqual("perEach half-even down", P.perEach("0.00005", 1), "0");
  assertEqual("perEach half-even up", P.perEach("0.00015", 1), "0.0002");
  assertEqual("perEach blank ppu", P.perEach("", 4), "");
  assertEqual("perEach zero units", P.perEach("1.00", 0), "");
  assertEqual("coerceDecimal keeps precision", P.coerceDecimal("1.2500"), "1.25");
  assertEqual("coerceDecimal strips dollars", P.coerceDecimal("$1,234.50"), "1234.5");
  assertEqual("coerceDecimal parens negative", P.coerceDecimal("(2.50)"), "-2.5");
  assertEqual("coerceDecimal blank", P.coerceDecimal(""), "");
  assertEqual("coerceInt from float cell", P.coerceInt(2.0), 2);
  assertEqual("coerceInt from text", P.coerceInt("1,024"), 1024);

  // Dates arrive in three shapes; all three must land on the same ISO string.
  assertEqual("coerceDate from Date", P.coerceDate(new Date(Date.UTC(2025, 0, 5))), "2025-01-05");
  assertEqual("coerceDate from ISO text", P.coerceDate("2025-01-05"), "2025-01-05");
  assertEqual("coerceDate from US text", P.coerceDate("1/5/2025"), "2025-01-05");
  assertEqual("coerceDate from ISO datetime", P.coerceDate("2025-01-05 00:00:00"), "2025-01-05");
  assertEqual("coerceDate from Excel serial", P.coerceDate(45662), "2025-01-05");
  let threw = false;
  try { P.coerceDate("not a date"); } catch (e) { threw = e instanceof P.SupplytrackError; }
  assertTrue("coerceDate rejects nonsense", threw, "expected a SupplytrackError");

  // Sorting must follow Python, not the locale.
  assertTrue("cmpCodePoint is code-point order", P.cmpCodePoint("Z", "a") < 0);
  assertTrue("cmpCodePoint prefix shorter first", P.cmpCodePoint("pen", "pens") < 0);
}

// ------------------------------------------------------------ end to end

/**
 * The golden `expected/lines.csv` is the ingest output, so the whole chain
 * downstream of ingest can be driven from it without reading a workbook.
 */
function testEndToEnd() {
  if (!exists("expected", "lines.csv")) {
    return skip("end-to-end chain", "src/tests/golden/expected is not there yet");
  }

  const linesText = read("expected", "lines.csv");
  const lines = P.linesFromCsv(linesText);
  assertCsvEqual("lines.csv round trip", P.linesToCsv(lines), linesText);

  // --- review queue, from an empty master (this is the fixture's first run)
  if (exists("expected", "review_queue.csv")) {
    const { queueRows, counts } = P.buildQueue({ lines, master: new Map(), year: YEAR });
    assertCsvEqual("review_queue.csv", P.queueToCsv(queueRows), read("expected", "review_queue.csv"));
    const expectedQueue = csv.parseObjects(read("expected", "review_queue.csv")).rows;
    const blocking = expectedQueue.filter((r) =>
      P.BLOCKING_REASONS.has(String(r.queue_reason).trim())
    ).length;
    assertEqual("buildQueue blocking count", counts.blocking, blocking);
  }

  // --- apply the decisions a person made
  let master = new Map();
  if (exists("inputs", "decisions.csv")) {
    const parsed = csv.parseObjects(read("inputs", "decisions.csv"));
    const applied = P.applyQueue({
      master: new Map(),
      decisions: { rows: parsed.rows, columns: parsed.header, name: "decisions.csv" },
      year: YEAR,
    });
    master = applied.master;
    assertEqual("applyQueue rows written", applied.written, parsed.rows.length);
    if (exists("expected", "item_master.csv")) {
      assertCsvEqual("item_master.csv", P.masterToCsv(master), read("expected", "item_master.csv"));
    }
  } else if (exists("expected", "item_master.csv")) {
    master = P.masterFromCsv(read("expected", "item_master.csv"));
  }

  // --- ranking
  const run = loadRun(lines);
  const ranking = P.rank({ lines, master, year: YEAR, run });
  assertTrue(
    "rank produced no failures",
    !ranking.findings.some((f) => f.level === "fail"),
    JSON.stringify(ranking.findings.filter((f) => f.level === "fail"))
  );
  if (exists("expected", "ranked.csv")) {
    assertCsvEqual("ranked.csv", P.rankedToCsv(ranking.ranked), read("expected", "ranked.csv"));
  }
  if (exists("expected", "excluded.csv")) {
    assertCsvEqual("excluded.csv", P.excludedToCsv(ranking.excluded), read("expected", "excluded.csv"));
  }
  assertEqual(
    "every line is counted once",
    ranking.includedLines + ranking.excludedLines,
    lines.length
  );

  // --- prices template
  if (exists("expected", "prices.csv")) {
    const template = P.pricesTemplate({ ranked: ranking.ranked, top: TOP });
    assertCsvEqual("prices.csv template", P.pricesToCsv(template.rows), read("expected", "prices.csv"));

    // prices --update over the template must be a no-op that keeps every row.
    const again = P.pricesUpdate({ ranked: ranking.ranked, top: TOP, existing: template.rows });
    assertCsvEqual("pricesUpdate keeps a matching sheet", P.pricesToCsv(again.rows), P.pricesToCsv(template.rows));
    assertDeep(
      "pricesUpdate counts on a no-op",
      { kept: again.kept, added: again.added, retired: again.retired },
      { kept: template.rows.length, added: 0, retired: 0 }
    );

    // An item that drops out is retired, not discarded.
    const shortlist = ranking.ranked.slice(0, Math.max(1, ranking.ranked.length - 1));
    const dropped = P.pricesUpdate({ ranked: shortlist, top: TOP, existing: template.rows });
    assertEqual("pricesUpdate retires the dropped item", dropped.retired, P.VENDORS.length);
    assertEqual(
      "pricesUpdate loses nothing",
      dropped.rows.length + dropped.retired,
      template.rows.length
    );
  }

  // --- the filled price sheet and the validator
  if (exists("inputs", "prices.csv")) {
    const priceRows = P.pricesFromCsv(read("inputs", "prices.csv"));
    const { cells, problems } = P.loadPrices({
      rows: priceRows, ranked: ranking.ranked, top: TOP, year: YEAR,
    });
    assertDeep("loadPrices has no problems", problems, []);

    // The shape report.js and app.js code against: cells[canonicalName][vendor].
    const flat = Object.values(cells).flatMap((byVendor) => Object.values(byVendor));
    assertEqual("loadPrices cell count", flat.length, priceRows.length);
    assertDeep(
      "cells are keyed by canonical name then vendor display name",
      Object.keys(cells[ranking.ranked[0].canonical_name]),
      P.VENDORS
    );
    assertDeep(
      "every cell carries the agreed field set",
      Object.keys(flat[0]).sort(),
      ["canonicalName", "checkedOn", "note", "rank", "status", "unitPrice", "url", "vendor"]
    );
    assertTrue(
      "every cell status is one of the four",
      flat.every((c) => P.VALID_STATUSES.has(c.status)),
      JSON.stringify([...new Set(flat.map((c) => c.status))])
    );
    assertTrue(
      "unitPrice is always a string, never null",
      flat.every((c) => typeof c.unitPrice === "string"),
      "found a non-string unitPrice"
    );
    assertTrue(
      "a cell with no price has unitPrice ''",
      flat.filter((c) => c.status === "unpriced").every((c) => c.unitPrice === ""),
      "an unpriced cell carried a price"
    );

    // Prices are kept as typed, never reformatted.
    const typed = priceRows.find((r) => r.status === "priced" && r.unit_price);
    if (typed) {
      const cell = cells[typed.canonical_name][typed.vendor];
      assertEqual("loadPrices keeps the typed price string", cell.unitPrice, typed.unit_price.trim());
      assertTrue(
        "a typed price is numeric without further cleaning",
        Number.isFinite(Number(cell.unitPrice)),
        cell.unitPrice
      );
    }
    // Trailing zeros are significant to a person reading the sheet and must survive.
    const precise = P.loadPrices({
      rows: [{ rank: "1", canonical_name: "X", vendor: "Amazon", unit_price: "$1,234.500",
               status: "priced", url: "", checked_on: "", note: "" }],
      ranked: [], top: 0, year: YEAR,
    });
    assertEqual(
      "loadPrices strips $ and commas but not precision",
      precise.cells.X.Amazon.unitPrice,
      "1234.500"
    );

    // checkPrices takes the same cells object.
    assertDeep(
      "checkPrices(cells) matches checkPrices(rows)",
      P.checkPrices({ cells, problems, ranked: ranking.ranked, top: TOP, year: YEAR }),
      P.checkPrices({ rows: priceRows, ranked: ranking.ranked, top: TOP, year: YEAR })
    );
    // cellsToRows is a value round trip, not a byte one: a price typed "$9.50"
    // comes back "9.50", because `unitPrice` holds the number without the
    // currency symbol so `Number()` works on it. Precision is untouched, and
    // re-reading the written sheet gives back exactly the same cells - which is
    // the invariant that matters, since Python's reader strips "$" too.
    const rewritten = P.cellsToRows(cells);
    const reread = P.loadPrices({
      rows: rewritten, ranked: ranking.ranked, top: TOP, year: YEAR,
    });
    assertDeep("cellsToRows round-trips by value", reread.cells, cells);
    assertDeep("re-reading a written sheet raises no problems", reread.problems, []);
    const dollars = priceRows.filter((r) => String(r.unit_price).startsWith("$"));
    assertTrue(
      "the fixture sheet exercises a typed currency symbol",
      dollars.length > 0,
      "no $-prefixed price in inputs/prices.csv, so the normalisation is untested"
    );
    assertEqual(
      "a typed $ is dropped, the digits are not",
      cells[dollars[0].canonical_name][dollars[0].vendor].unitPrice,
      dollars[0].unit_price.trim().replace(/^\$/, "")
    );

    if (exists("expected", "findings.json")) {
      const expected = readJson("expected", "findings.json");
      const actual = P.validateAll({
        lines, master, ranked: ranking.ranked, excluded: ranking.excluded,
        prices: priceRows, top: TOP, year: YEAR, run,
      });
      compareFindings(expected, actual, run.__reconstructed === true);
    }
  }
}

/**
 * The second year: a queue built against a master that already holds decisions.
 *
 * The golden vectors cover a first run, where every key is unknown and the
 * master is empty. Every run after that takes the other branch - the one that
 * prefills from the master, asks only about unconfirmed and missing pack sizes,
 * and must not throw away a `first_seen` or a note the queue does not carry.
 * These outputs were compared byte for byte against the Python during the port;
 * what is asserted here is the behaviour that comparison pinned down.
 */
function testSecondRun() {
  if (!exists("expected", "lines.csv") || !exists("expected", "item_master.csv")) {
    return skip("second-run chain", "src/tests/golden/expected is not there yet");
  }
  const lines = P.linesFromCsv(read("expected", "lines.csv"));
  const master = P.masterFromCsv(read("expected", "item_master.csv"));

  // Age the master the way a real second year would: two pack sizes that came
  // from a regex or a proposal rather than a person, and one wiped entirely.
  const included = Array.from(master.values()).filter((r) => r.include === "y");
  assertTrue("second run has enough included items to age", included.length >= 3);
  included[0].upp_source = "title";
  included[1].upp_source = "proposed";
  included[2].units_per_pack = "";
  const firstSeenBefore = new Map(
    Array.from(master, ([k, r]) => [k, r.first_seen])
  );
  const masterBefore = P.masterToCsv(master);

  const { queueRows, counts } = P.buildQueue({ lines, master, year: 2025 });
  assertEqual("second run queues only what needs a person", queueRows.length, 3);
  assertDeep(
    "second run: blocking rows sort first",
    queueRows.map((r) => r.queue_reason),
    [P.REASON_MISSING, P.REASON_UNCONFIRMED, P.REASON_UNCONFIRMED]
  );
  assertDeep("second run counts", counts, { blocking: 1, unconfirmed: 2 });
  assertTrue(
    "second run prefills the pack size it is asking about",
    queueRows.slice(1).every((r) => r.units_per_pack !== ""),
    JSON.stringify(queueRows.slice(1).map((r) => r.units_per_pack))
  );
  assertTrue(
    "second run says where an unconfirmed number came from",
    queueRows[1].upp_reason.includes("nobody has confirmed it"),
    queueRows[1].upp_reason
  );
  assertTrue(
    "second run proposes a pack size for the missing one",
    queueRows[0].units_per_pack !== "" && queueRows[0].upp_reason !== "",
    JSON.stringify(queueRows[0])
  );

  // "Accept suggestions for now": usable, but still not confirmed by a person.
  const applied = P.applyQueue({ master, decisions: queueRows, year: 2025, proposed: true });
  assertEqual("applyQueue(proposed) writes every queue row", applied.written, queueRows.length);
  for (const row of queueRows) {
    const after = applied.master.get(row.key);
    assertEqual(`applyQueue(proposed) marks ${row.key} proposed`, after.upp_source, "proposed");
    assertEqual(
      `applyQueue keeps first_seen for ${row.key}`,
      after.first_seen,
      firstSeenBefore.get(row.key)
    );
  }
  // The whole master, byte for byte, not a proxy for it: the page hands the
  // same master to buildQueue and applyQueue and back again, so an in-place
  // edit here would quietly rewrite state the caller still thinks it owns.
  assertCsvEqual("applyQueue does not mutate the master it was given", P.masterToCsv(master), masterBefore);
  assertDeep(
    "applyQueue returns the master sorted by key",
    Array.from(applied.master.keys()),
    Array.from(applied.master.keys()).slice().sort(P.cmpCodePoint)
  );

  // A proposed pack size ranks, but keeps warning until somebody confirms it.
  const ranking = P.rank({ lines, master: applied.master, year: 2025 });
  assertTrue(
    "second run ranks without failing",
    !ranking.findings.some((f) => f.level === "fail"),
    JSON.stringify(ranking.findings.filter((f) => f.level === "fail"))
  );
  assertTrue(
    "second run still warns UPP_UNCONFIRMED",
    ranking.findings.some((f) => f.code === "UPP_UNCONFIRMED"),
    JSON.stringify(ranking.findings.map((f) => f.code))
  );
  assertEqual(
    "second run still counts every line",
    ranking.includedLines + ranking.excludedLines,
    lines.length
  );
}

/**
 * The four convenience names `app.js` resolves against at boot.
 *
 * They are thin, but the page's boot sequence probes for them by name, so an
 * accidental rename here would strand the UI with "pipeline.js could not be
 * used" rather than a test failure.
 */
function testConvenienceNames() {
  if (!exists("expected", "item_master.csv")) {
    return skip("convenience names", "src/tests/golden/expected is not there yet");
  }
  const text = read("expected", "item_master.csv");
  const fromCsv = P.masterFromCsv(text);

  assertEqual("emptyMaster is an empty Map", P.emptyMaster().size, 0);
  assertTrue("emptyMaster is a Map", P.emptyMaster() instanceof Map);

  assertCsvEqual("parseMaster(text)", P.masterToCsv(P.parseMaster(text)), text);
  assertCsvEqual(
    "parseMaster(rows)",
    P.masterToCsv(P.parseMaster(Array.from(fromCsv.values()))),
    text
  );
  assertCsvEqual("parseMaster(Map)", P.masterToCsv(P.parseMaster(fromCsv)), text);
  assertEqual("parseMaster(null)", P.parseMaster(null).size, 0);

  // Every other function here is pure; these must not hand back the argument.
  const copy = P.parseMaster(fromCsv);
  assertTrue("parseMaster(Map) copies rather than aliases", copy !== fromCsv);
  copy.delete(Array.from(copy.keys())[0]);
  assertEqual("editing the copy leaves the original alone", P.masterToCsv(fromCsv), text);

  assertCsvEqual(
    "masterFromRows",
    P.masterToCsv(P.masterFromRows(Array.from(fromCsv.values()))),
    text
  );

  if (exists("inputs", "prices.csv")) {
    const priceText = read("inputs", "prices.csv");
    const rows = P.pricesFromCsv(priceText);
    assertCsvEqual("parsePrices(text)", P.pricesToCsv(P.parsePrices(priceText)), priceText);
    assertCsvEqual("parsePrices(rows)", P.pricesToCsv(P.parsePrices(rows)), priceText);
    assertCsvEqual("pricesFromRows", P.pricesToCsv(P.pricesFromRows(rows)), priceText);
    assertDeep("parsePrices(null)", P.parsePrices(null), []);
  }
}

/** A decision row that is not ready to apply is rejected, and nothing is written. */
function testApplyQueueRejects() {
  const base = { key: "amz:x", raw_title: "Widget", canonical_name: "Widget" };
  const cases = [
    [{ ...base, include: "", units_per_pack: "5" }, "include is blank"],
    [{ ...base, include: "maybe", units_per_pack: "5" }, "include is 'maybe'"],
    [{ ...base, include: "y", units_per_pack: "" }, "units_per_pack is ''"],
    [{ ...base, include: "y", units_per_pack: "2.5" }, "units_per_pack is '2.5'"],
    [{ ...base, include: "y", units_per_pack: "0" }, "units_per_pack is '0'"],
    [{ ...base, key: "", include: "y", units_per_pack: "5" }, "line 2: no key"],
  ];
  for (const [row, fragment] of cases) {
    let message = "";
    try {
      P.applyQueue({ master: new Map(), decisions: [row], year: 2025 });
    } catch (err) {
      message = err instanceof P.SupplytrackError ? err.message : `wrong error: ${err}`;
    }
    assertTrue(
      `applyQueue rejects: ${fragment}`,
      message.includes(fragment),
      `got: ${truncate(message, 200)}`
    );
  }

  // An excluded item needs no pack size - it never reaches the ranking.
  const okRow = { ...base, include: "n", units_per_pack: "" };
  const result = P.applyQueue({ master: new Map(), decisions: [okRow], year: 2025 });
  assertEqual("applyQueue allows a blank pack size when include=n", result.written, 1);
  assertEqual(
    "an excluded item claims no pack-size source",
    result.master.get("amz:x").upp_source,
    ""
  );
}

/**
 * run.json carries the non-Closed statuses and the ingest row count, and
 * neither can be recovered from lines.csv. Use the golden copy when the
 * generator provides one; otherwise reconstruct what can be reconstructed and
 * say which findings that leaves unverifiable.
 */
function loadRun(lines) {
  for (const candidate of [["expected", "run.json"], ["inputs", "run.json"]]) {
    if (exists(...candidate)) return readJson(...candidate);
  }
  return { rows_written: lines.length, non_closed: [], warnings: [], __reconstructed: true };
}

const RUN_DEPENDENT_CODES = new Set(["STATUS_NOT_CLOSED", "LINE_COUNT_MISMATCH"]);

function compareFindings(expected, actual, runReconstructed) {
  let exp = expected;
  let act = actual;
  if (runReconstructed) {
    const dropped = expected.filter((f) => RUN_DEPENDENT_CODES.has(f.code)).map((f) => f.code);
    if (dropped.length) {
      skip(
        `findings ${dropped.join(", ")}`,
        "no golden run.json, and these are derived from it rather than from lines.csv"
      );
    }
    exp = expected.filter((f) => !RUN_DEPENDENT_CODES.has(f.code));
    act = actual.filter((f) => !RUN_DEPENDENT_CODES.has(f.code));
  }

  assertDeep(
    "findings (level, code) in order",
    act.map((f) => [f.level, f.code]),
    exp.map((f) => [f.level, f.code])
  );
  const n = Math.min(exp.length, act.length);
  for (let i = 0; i < n; i += 1) {
    assertEqual(`finding message ${exp[i].code}`, act[i].message, exp[i].message);
  }
}

// --------------------------------------------------------- ingest parity
//
// The fixture exports are .xlsx and ExcelJS is not this module's dependency, so
// ingest is tested only when the golden generator has also dumped the fixture
// sheets as tables. Everything downstream is covered regardless, because
// expected/lines.csv IS the ingest output.

const FIXTURE_TABLE_CANDIDATES = [
  ["inputs", "fixture_tables.json"],
  ["inputs", "tables.json"],
  ["inputs", "exports.json"],
];

function findFixtureTables() {
  for (const candidate of FIXTURE_TABLE_CANDIDATES) {
    if (exists(...candidate)) return readJson(...candidate);
  }
  const amazon = ["inputs", "amazon_table.json"];
  const preferred = ["inputs", "preferred_table.json"];
  if (exists(...amazon)) {
    return {
      amazon: readJson(...amazon),
      preferred: exists(...preferred) ? readJson(...preferred) : null,
    };
  }
  return null;
}

function testIngest() {
  const tables = findFixtureTables();
  if (!tables) {
    return skip(
      "ingest parity",
      "no golden dump of the fixture sheets as tables (looked for inputs/fixture_tables.json " +
        "and inputs/amazon_table.json); the fixtures are .xlsx and ExcelJS is not a test dependency"
    );
  }
  if (!exists("expected", "lines.csv")) return skip("ingest parity", "no expected/lines.csv");

  const amazonTable = tables.amazon || tables.amazonTable || tables.amazon_table;
  const preferredTable = tables.preferred || tables.preferredTable || tables.preferred_table || null;
  const result = P.ingest({
    amazonTable,
    preferredTable,
    year: YEAR,
    amazonFile: tables.amazon_file || "amazon_2025_sample.xlsx",
    preferredFile: tables.preferred_file || "preferred_2025_sample.xlsx",
    now: "2026-01-01T00:00:00+00:00",
  });
  assertCsvEqual("ingest -> lines.csv", P.linesToCsv(result.lines), read("expected", "lines.csv"));

  for (const candidate of [["expected", "run.json"], ["inputs", "run.json"]]) {
    if (!exists(...candidate)) continue;
    const expectedRun = readJson(...candidate);
    const strip = (r) => {
      const { ingested_at, ranked_at, reported_at, __reconstructed, ...rest } = r;
      return sortKeysDeep(rest);
    };
    assertDeep("ingest -> run.json (timestamps excluded)", strip(result.run), strip(expectedRun));
    // The generator normalises the wall clock to a token; the port writes a real
    // one. Both must be there, and the port's must be a real ISO timestamp.
    assertEqual("the golden run.json has its timestamp normalised", expectedRun.ingested_at, "<TIMESTAMP>");
    assertTrue(
      "ingest stamps a real ISO time",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(
        P.ingest({
          amazonTable, preferredTable, year: YEAR,
        }).run.ingested_at
      ),
      "ingested_at was not an ISO timestamp"
    );
    break;
  }
}

// ------------------------------------------------------------------ main

testCsv();
testPureHelpers();
testUnitVectors();
testIngest();
testEndToEnd();
testSecondRun();
testConvenienceNames();
testApplyQueueRejects();

if (failures.length) {
  console.log("");
  for (const f of failures) console.log(`FAIL ${f.name}\n     ${f.detail}`);
}
console.log("");
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
