# Parity tests for the browser port

```
node src/web/tests/run-tests.js
```

Exits 0 and prints `N passed, 0 failed, M skipped`. No test framework, no
dependencies, no build step: Node 18 or newer and the same two module files the
page itself loads.

## What it proves

`src/supplytrack/` (Python) is the reference implementation and the CLI.
`src/web/js/pipeline.js` is a port of it. The two have to produce the same
numbers and the same files, because the office manager may build a year with either one and
the files round-trip between them. This suite is what holds that true.

The expectations come from `src/tests/golden/`, generated from the Python by
`src/scripts/make_golden.py` against the committed fixture exports in
`src/tests/fixtures/`. Nothing here is hand-written from reading the Python.

| Group | What it checks |
|---|---|
| `csv.js` | RFC 4180 parse, and a serialiser byte-compatible with Python's `csv.writer` (QUOTE_MINIMAL: a field is quoted only for a comma, a quote or a newline, never for surrounding spaces) |
| pure helpers | `normaliseTitle`, `uppCandidates`, `decodePreferredPack`, `suggestInclude` against `golden/unit/*.json`, plus the difflib ratio, decimal and date behaviour the vectors do not reach |
| ingest | the fixture sheets in, `expected/lines.csv` out, compared byte for byte |
| chain | `buildQueue` -> `applyQueue` -> `rank` -> `pricesTemplate` / `pricesUpdate` -> `loadPrices` -> `validateAll`, each stage's CSV compared byte for byte against `expected/` |
| findings | every validator finding compared by `(level, code)`, in order, and then by message |
| second run | the branch the golden vectors do not reach: a queue built against a master that already holds decisions, `applyQueue` with `proposed`, and the `first_seen` / note that must survive it |
| rejections | a decision row with a blank `include`, a fractional pack size or no key is refused, and nothing is written |

CSV comparisons normalise line endings and nothing else. A difference in
quoting, column order, number formatting or row order is a failure.

## Reading a failure

A failing parity test means one of two things:

1. **The port is wrong.** Fix `js/pipeline.js` or `js/csv.js`. The failure
   prints the first differing line with both sides.
2. **The Python changed on purpose.** Regenerate the vectors
   (`python src/scripts/make_golden.py`) *first*, confirm the new golden files
   are what the change intended, then bring the port up to them.

Never edit a file under `src/tests/golden/` by hand to make a test pass.

## Skips

The suite currently skips nothing. Two checks used to, because the golden
generator did not yet emit what they needed; `scripts/make_golden.py` now writes
both, so they run:

- **ingest parity** reads `golden/inputs/fixture_tables.json` - the two fixture
  sheets as raw tables (`{amazon, preferred, amazon_file, preferred_file}`).
  The fixtures are `.xlsx`, and reading a workbook is `js/xlsxio.js`'s job, not
  this suite's: depending on ExcelJS here would mean the parity suite no longer
  runs on Node alone.
- **`STATUS_NOT_CLOSED` and `LINE_COUNT_MISMATCH`** read
  `golden/inputs/run.json`. Both come from `run.json` rather than `lines.csv`,
  so neither can be reproduced without it.

The skip branches are kept rather than deleted: each prints what is missing and
where the runner looked, so a regenerated or partial vector set degrades into a
named skip instead of a confusing failure. If you see one, run
`python scripts/make_golden.py` from `src/`.

`run.json` is compared as parsed JSON with timestamps excluded and key order
ignored - the generator dumps with sorted keys, while both the CLI and this port
write the same content in insertion order.

## Parity notes

Places where the JS deliberately does not do what the Python does, each marked
`PARITY NOTE:` in `js/pipeline.js`:

- **`rank` returns its failures instead of raising.** The Python raises
  `SupplytrackError`; the page has to render the failures. Same findings, same
  order, same messages - `{ranked: [], excluded: [], findings}` when any is a
  fail. `SupplytrackError` is still thrown where the return value has no channel
  for the problem: cell coercion, a missing column, a decision row that is not
  ready to apply.
- **`coerceDate` also accepts a bare Excel serial number**, via the 1899-12-30
  epoch. The Python never sees one because openpyxl has already converted it;
  ExcelJS and a CSV both can.
- **`PRICES_MISSING` drops the file path** from its message. There is no path in
  a browser. Every other message is the Python's word for word.
- **`casefold`** is `toLowerCase` plus an explicit table for the characters where
  full Unicode casefolding differs (sharp s, the f-ligatures, long s, final
  sigma). JS has no `casefold`.
- **`masterUnitsPerPackInt`** returns null for a non-finite value where the
  Python raises `OverflowError` on `int(inf)`.
- **`checkPrices`** skips a vendor outside `VENDORS` when counting coverage,
  where the Python raises `KeyError` on a hand-edited sheet.
- **`loadPrices` returns a nested plain object**, `cells[canonicalName][vendor]`,
  with camelCase fields - the shape `report.js` and `app.js` agreed on, not a
  transcription of Python's `dict[(name, vendor)] -> PriceCell`. `unitPrice` is
  a string and never null: the price as typed with the currency symbol and
  thousands separators removed, so `Number(cell.unitPrice)` works while `1.250`
  stays `1.250`. A price that cannot be read keeps its unreadable text rather
  than being blanked, so a typo can be told apart from an empty box, and `""`
  means no price at all.

  The consequence worth knowing: `cellsToRows` round-trips by **value, not by
  bytes**. A price the office manager typed as `$9.50` is written back as `9.50`. Python's
  reader strips `$` too, so the file still reads identically in the CLI, and
  re-reading a written sheet gives back exactly the same cells - both asserted.
