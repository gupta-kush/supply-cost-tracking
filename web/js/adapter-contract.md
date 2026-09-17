# Adapter contract: what the v2 page may call

Frozen 2026-09-17 for the v2 build. These are the only entry points the page uses. Signatures
are lifted from `pipeline.js`, `report.js` and `suggest.js` as v1 `app.js` called them. None of
these modules changes in v2 except the two items in `docs/webapp-v2-spec.md` section 7.

`master` is always a `Map<key, row>` sorted by key (`asMasterMap` / `sortMaster`). Rows are
plain objects of string values. `lines` is the array `ingest` returns.

## pipeline.js

| Call | Input | Output |
|---|---|---|
| `classifyFiles(files)` | `files: [{file: name, sheets: [{name, grid: any[][]}]}]` (a `.csv` is one unnamed sheet; build `grid` with `xlsxio` / `csv.js` as v1 `readExportFile` did) | `{recognised: [{kind, vendor?, file, sheet, ...}], ignored: [{file, sheet, reason}]}`; throws `SupplytrackError` when nothing is an export |
| `carryRows(found)` | one `recognised` entry with `kind` in `item_master`, `prices`, `prices_retired` | `string[][]`-shaped rows as objects, file column order |
| `masterFromRows(rows)` | carry rows of kind `item_master` | `Map` |
| `emptyMaster()` | | empty `Map` |
| `ingest({files, year})` | same `files` as classify; `year` number | `{lines, run, warnings: string[]}` |
| `buildQueue({lines, master, year})` | | `{queueRows, counts: {blocking, unconfirmed}, reasonCounts}`. Row fields: `key, source, raw_title, amazon_category, packs_in_year, queue_reason, include, include_reason, units_per_pack, upp_candidates ("12 (12/Pack)\|10 (Case of 10)"), upp_reason, canonical_name, canonical_reason, unit_label, note`. Blocking reasons: `unknown key`, `pack size missing`. Non-blocking: `pack size unconfirmed`. |
| `applyQueue({master, decisions, year, proposed})` | `decisions`: array of queue rows with `include` (y/n), `units_per_pack` (integer text), `canonical_name` filled; `proposed: true` writes `upp_source = proposed`, false writes `master` | `{master, written}`; throws on a row missing a decision. Send only complete rows. |
| `rank({lines, master, year, run})` | | `{ranked, excluded, findings, totalLines, includedLines, excludedLines}`. `ranked` rows: `rank, canonical_name, eaches, packs, units_per_pack, unit_label, upp_source, sources, last_paid_per_each, ...`. If any finding has `level: "fail"`, `ranked` is empty. |
| `pricesTemplate({ranked, top})` | | `{rows, kept, added, retired, retiredRows}`; rows: `rank, canonical_name, vendor, unit_price, status, url, checked_on, note` (Amazon note carries `last paid per each: X`) |
| `pricesUpdate({ranked, top, existing})` | `existing`: carried or previously built price rows | same shape; keeps typed rows, adds `unpriced`, retires dropped items |
| `loadPrices({rows, ranked, top, year})` | | `{cells: {"name\|\|vendor": {...}}, problems: string[]}` (used by v1 only for messages; optional) |
| `validateAll({lines, master, ranked, excluded, prices, top, year, run})` | `prices`: price rows or null | `[{level: "fail"\|"warn", code, message}]` |
| `masterToCsv(master)`, `pricesToCsv(rows)`, `runToJson(run)` | | file text |
| `sortMaster(master)` | | `Map` in file order (use for `masterRows` when building the report) |
| Constants | `VENDORS` (`Office Depot, Preferred, Amazon, Staples`), `VALID_STATUSES`, `UNCONFIRMED_UPP_SOURCES` (`title, proposed`), `MASTER_COLUMNS`, `PRICES_HEADER` | |

## report.js

`buildReport({ranked, excluded, prices, run, master, masterRows, priceRows, retiredRows, year, top, builtAt})`
returns an ExcelJS workbook. `prices` is a map `"canonical_name||vendor" -> {unit_price, status}`
(v1 built it in `priceMapForReport()`; copy that helper). `master` is the master row **count**.
`masterRows` is `Array.from(sortMaster(master).values())`. Serialize with
`xlsxio.toArrayBuffer(workbook)` and download as
`Acme Widget Top ${top} Items Comparison ${year}.xlsx`.

## suggest.js

| Call | Notes |
|---|---|
| `regexProvider.propose(rows, existingNames)` | fills blanks only; returns rows with `confidence`, `proposed_by`; for Preferred rows attach `pack_desc` first with `attachPackDesc(rows, lines)` |
| `makeApiProvider({vendor, apiKey, model})` then `.propose(rows, existingNames)` | `vendor` in `anthropic`, `gemini`; `DEFAULT_MODELS`, `CHEAP_MODELS` |
| `blockingRows(rows)` | the blocking subset |
| `estimateRequests({rows, existingNames, prompt, vendor, model})` | for the settings sheet |
| `autoAccept(rows)` | **new in v2**, see spec section 7: `{ready, open}` |

## csv.js and xlsxio.js

`csv.parse(text)`, `csv.serialise(rows, columns)`. `xlsxio.readWorkbook(arrayBuffer)` returns
`[{name, grid}]`; `xlsxio.toArrayBuffer(workbook)`. Check the exact export names in the files
before use; they are short modules.

## What v1 did that v2 must keep doing

- Dynamic-import the three logic modules inside try/catch and fail with a plain sentence if one
  is missing (`loadLogicModules` in v1 `app.js`).
- Set `window.__supplytrackReady = true` first thing so the inline script in `index.html` can
  tell a module failure from a slow load.
- Dedupe files by name, size and lastModified.
- Rebuild price rows after every re-rank with `pricesUpdate` against what the page already holds,
  then re-apply `priceEdits` keyed `"name||vendor"`.
- Never store anything except the theme and Top N in `localStorage`. The API key lives in a
  closure, never in state.
