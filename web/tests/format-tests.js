/* Unit tests for format.js: `node web/tests/format-tests.js`.
 *
 * No test framework and no dependencies, matching the other suites. The money
 * line test reads the same 2025 fixture `run-tests.js` reads out of
 * `tests/golden`, and checks it against a hand calculation done in this file,
 * not against another call into `format.js`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as csv from "../js/csv.js";
import * as F from "../js/format.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.resolve(HERE, "../../tests/golden");

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
  if (actual === expected) return ok();
  return bad(name, `expected: ${JSON.stringify(expected)}\n     actual: ${JSON.stringify(actual)}`);
}

function assertTrue(name, value, detail = "expected true") {
  return value ? ok() : bad(name, detail);
}

// ------------------------------------------------------------------- int

function testInt() {
  assertEqual("int formats thousands", F.int(1238), "1,238");
  assertEqual("int rounds a float", F.int(24.6), "25");
  assertEqual("int of a numeric string", F.int("140"), "140");
  assertEqual("int of nothing is zero", F.int(""), "0");
  assertEqual("int of null is zero", F.int(null), "0");
}

// ----------------------------------------------------------------- money

function testMoney() {
  assertEqual("money whole dollars", F.money(3092), "$3,092");
  assertEqual("money rounds to whole dollars by default", F.money(3091.6), "$3,092");
  assertEqual("money with cents", F.money(1234.5, { cents: true }), "$1,234.50");
  assertEqual("money zero", F.money(0), "$0");
  assertEqual("money negative", F.money(-12), "-$12");
  assertEqual("money negative with cents", F.money(-1.5, { cents: true }), "-$1.50");

  // Per-each prices: at least two decimals, up to four, trailing zeros past
  // the cent trimmed. STATUS.md, worker B: two prices this close must not
  // render identically while the accent fill marks one of them cheaper.
  assertEqual("unit price keeps four decimals when they matter", F.money(0.0997, { unit: true }), "$0.0997");
  assertEqual("unit price trims a trailing zero", F.money(0.095, { unit: true }), "$0.095");
  assertEqual("unit price never drops below two decimals", F.money(1.25, { unit: true }), "$1.25");
  assertEqual("unit price of a whole number still shows cents", F.money(0.04, { unit: true }), "$0.04");
  assertEqual("unit price at three decimals stays put", F.money(0.038, { unit: true }), "$0.038");
  assertEqual("unit price of zero", F.money(0, { unit: true }), "$0.00");
  assertEqual("unit price negative", F.money(-0.0997, { unit: true }), "-$0.0997");
  assertEqual(
    "unit price with a large whole part keeps the thousands separator",
    F.money(1234.5, { unit: true }),
    "$1,234.50"
  );
  assertTrue(
    "0.0997 and 0.095 no longer render identically",
    F.money(0.0997, { unit: true }) !== F.money(0.095, { unit: true }),
    `${F.money(0.0997, { unit: true })} vs ${F.money(0.095, { unit: true })}`
  );
}

// ---------------------------------------------------------------- plural

function testPlural() {
  assertEqual("plural singular", F.plural(1, "line"), "1 line");
  assertEqual("plural many", F.plural(2, "line"), "2 lines");
  assertEqual("plural zero", F.plural(0, "item"), "0 items");
  assertEqual("plural formats thousands too", F.plural(1238, "line"), "1,238 lines");
}

// ------------------------------------------------------- display names

function testDisplayName() {
  // Never cut before 24 characters.
  assertEqual(
    "a comma before 24 characters is not where the cut happens",
    F.truncateCanonical("Pens, Blue, Medium Point, Box of 12"),
    "Pens, Blue, Medium Point"
  );
  // Exactly the phase-0 ruling's own example shape: run on to the next comma.
  assertEqual(
    "short name with no delimiter is returned whole",
    F.truncateCanonical("Copy Paper"),
    "Copy Paper"
  );
  assertEqual(
    "a name 24 characters or shorter is never touched",
    F.truncateCanonical("Binder Clips Med Black"),
    "Binder Clips Med Black"
  );
  assertEqual(
    "a delimiter that lands within the window is used",
    F.truncateCanonical("Sharpie Permanent Markers Fine Point (Pack of 12)"),
    "Sharpie Permanent Markers Fine Point"
  );
  assertEqual(
    "no delimiter and the whole name fits under 40 is returned whole",
    F.truncateCanonical("Sharpie Permanent Markers Assorted"),
    "Sharpie Permanent Markers Assorted"
  );
  // Longer than 40 with no delimiter inside the window: hard cut at 40 with an ellipsis.
  const long = F.truncateCanonical(
    "Really Long Vendor Title With No Punctuation At All To Break On Whatsoever"
  );
  assertEqual("a name with no usable delimiter is hard cut at 40", long.length, 41);
  assertTrue("the hard cut ends in an ellipsis", long.endsWith("…"));
  assertEqual(
    "the hard cut keeps exactly the first 40 characters",
    long.slice(0, 40),
    "Really Long Vendor Title With No Punctua"
  );

  assertEqual(
    "a model display_name wins over truncation",
    F.displayName({ canonical_name: "Avery Name Tag Inserts, 400 count", display_name: "Avery Name Tag Inserts" }),
    "Avery Name Tag Inserts"
  );
  assertEqual(
    "a blank display_name falls back to truncation",
    F.displayName({ canonical_name: "Copy Paper", display_name: "" }),
    "Copy Paper"
  );
  assertEqual(
    "no row at all is a blank name",
    F.displayName({ canonical_name: "" }),
    ""
  );
}

// ------------------------------------------------- distinct display names

function testDistinctDisplayNames() {
  // Synthetic: three names that share a 50-character common run, so they all
  // truncate to the same 40 characters plus an ellipsis before ever reaching
  // the parenthetical that actually tells them apart.
  const common = "A".repeat(50);
  const rows = [
    { canonical_name: `${common} (Alpha One)` },
    { canonical_name: `${common} (Beta Two)` },
    { canonical_name: `${common} (Gamma Three)` },
  ];
  const plain = rows.map((r) => F.displayName(r));
  assertEqual(
    "the plain names really do collide first",
    new Set(plain).size,
    1
  );
  const distinct = F.distinctDisplayNames(rows);
  assertEqual("distinctDisplayNames returns one name per row", distinct.length, 3);
  assertEqual("collision resolved: three distinct names", new Set(distinct).size, 3);
  assertTrue(
    "each extended name carries its own tail",
    distinct[0].includes("Alpha One") && distinct[1].includes("Beta Two") &&
      distinct[2].includes("Gamma Three"),
    JSON.stringify(distinct)
  );
  assertTrue(
    "every extended name stays at or under 60 characters",
    distinct.every((n) => n.length <= 60),
    JSON.stringify(distinct.map((n) => n.length))
  );

  // A row with nothing colliding is returned exactly as displayName would give it.
  const solo = F.distinctDisplayNames([{ canonical_name: "Copy Paper" }]);
  assertEqual("a lone row is untouched", solo[0], "Copy Paper");
  assertEqual("no rows means no names", F.distinctDisplayNames([]).length, 0);

  // The real case, when the real 2025 data is present: three Qeeenar flag
  // colours that render identically under truncateCanonical alone.
  const rankedPath = path.resolve(HERE, "../../../data/2025/ranked.csv");
  if (!fs.existsSync(rankedPath)) {
    console.log("SKIP real Qeeenar rows - data/2025/ranked.csv is not present");
    return;
  }
  const ranked = csv.parseObjects(fs.readFileSync(rankedPath, "utf8")).rows;
  const qeeenar = ranked.filter((r) => r.canonical_name.startsWith("Qeeenar"));
  assertEqual("the real fixture has the three Qeeenar rows", qeeenar.length, 3);
  const realPlain = qeeenar.map((r) => F.displayName(r));
  assertEqual("the three real rows collide under plain displayName", new Set(realPlain).size, 1);
  const realDistinct = F.distinctDisplayNames(qeeenar);
  assertEqual("distinctDisplayNames separates the three real rows", new Set(realDistinct).size, 3);
  assertTrue(
    "every real extended name stays at or under 60 characters",
    realDistinct.every((n) => n.length <= 60),
    JSON.stringify(realDistinct)
  );
}

// --------------------------------------------------------------- provenance

function testProvenance() {
  assertEqual(
    "confirmed",
    F.provenance({ units_per_pack: "36", upp_source: "master" }),
    "36 per pack, confirmed"
  );
  assertEqual(
    "from the title",
    F.provenance({ units_per_pack: "1250", upp_source: "title" }),
    "1,250 per pack, from the title"
  );
  assertEqual(
    "proposed by the model",
    F.provenance({ units_per_pack: "1", upp_source: "proposed" }),
    "1 per pack, proposed by the model"
  );
  assertEqual(
    "a merged row uses the first source",
    F.provenance({ units_per_pack: "12", upp_source: "title|proposed" }),
    "12 per pack, from the title"
  );
  assertEqual(
    "a blank pack size (a merge with no single answer) still names the source",
    F.provenance({ units_per_pack: "", upp_source: "master" }),
    "pack size varies, confirmed"
  );
  assertEqual(
    "a non-numeric pack size also reads as varying, not as zero",
    F.provenance({ units_per_pack: "12|10", upp_source: "master" }),
    "pack size varies, confirmed"
  );
  assertEqual(
    "an unrecognised source states only the pack size",
    F.provenance({ units_per_pack: "10", upp_source: "" }),
    "10 per pack"
  );
}

// --------------------------------------------------------------- money line

function readGolden(...parts) {
  return fs.readFileSync(path.join(GOLDEN, ...parts), "utf8");
}

function testMoneyLine() {
  const ranked = csv.parseObjects(readGolden("expected", "ranked.csv")).rows;
  const priceRows = csv.parseObjects(readGolden("inputs", "prices.csv")).rows;

  // Hand calculation over the 2025 fixture: for every item with both an
  // Amazon price and at least one other priced vendor, (Amazon - cheapest
  // priced vendor) * eaches. Item 8 (Preferred Copy Paper) has no Amazon
  // price and is left out, exactly as the definition says.
  const expectedAmount = 202; // 100 + 6 + 15 + 28.8 + 9 + 0.96 + 33.3 + 7.2 + 0.48 + 0.9 + 0.08, rounded
  const expectedItems = 11;

  const result = F.moneyLine(ranked, priceRows, 25);
  assertEqual("moneyLine amount matches the hand calculation", result.amount, expectedAmount);
  assertEqual("moneyLine counts every item priced at both", result.itemsCounted, expectedItems);
  assertTrue(
    "moneyLine's basis sentence names the item count",
    result.basisSentence.includes(`${expectedItems} items priced at both`),
    result.basisSentence
  );

  // An item priced only at Amazon (nothing else) is not counted at all.
  const amazonOnly = F.moneyLine(
    [{ rank: "1", canonical_name: "Solo Item", eaches: 100 }],
    [{ canonical_name: "Solo Item", vendor: "Amazon", unit_price: "5.00", status: "priced" }],
    25
  );
  assertEqual("an Amazon-only item counts nothing", amazonOnly.itemsCounted, 0);
  assertEqual("an Amazon-only item adds nothing to the total", amazonOnly.amount, 0);

  // Amazon already cheapest: the figure is zero or negative and the copy says so plainly.
  const alreadyCheapest = F.moneyLine(
    [{ rank: "1", canonical_name: "Cheap Item", eaches: 10 }],
    [
      { canonical_name: "Cheap Item", vendor: "Amazon", unit_price: "1.00", status: "priced" },
      { canonical_name: "Cheap Item", vendor: "Staples", unit_price: "1.50", status: "priced" },
    ],
    25
  );
  assertEqual("Amazon cheapest gives a zero amount", alreadyCheapest.amount, 0);
  assertEqual(
    "Amazon cheapest gives the plain sentence",
    alreadyCheapest.basisSentence,
    "Amazon was already cheapest on every item priced."
  );

  // Rank past top N does not count, even if priced at every vendor.
  const pastTop = F.moneyLine(
    [{ rank: "26", canonical_name: "Past Top", eaches: 1000 }],
    [
      { canonical_name: "Past Top", vendor: "Amazon", unit_price: "9.00", status: "priced" },
      { canonical_name: "Past Top", vendor: "Staples", unit_price: "1.00", status: "priced" },
    ],
    25
  );
  assertEqual("an item ranked past top N is not counted", pastTop.itemsCounted, 0);

  // A discontinued or unpriced vendor row is not a price.
  const notPriced = F.moneyLine(
    [{ rank: "1", canonical_name: "Item X", eaches: 10 }],
    [
      { canonical_name: "Item X", vendor: "Amazon", unit_price: "5.00", status: "priced" },
      { canonical_name: "Item X", vendor: "Staples", unit_price: "", status: "not_available" },
    ],
    25
  );
  assertEqual("a not_available vendor is not a second price", notPriced.itemsCounted, 0);
}

// ------------------------------------------------------------------ main

testInt();
testMoney();
testPlural();
testDisplayName();
testDistinctDisplayNames();
testProvenance();
testMoneyLine();

if (failures.length) {
  console.log("");
  for (const f of failures) console.log(`FAIL ${f.name}\n     ${f.detail}`);
}
console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
