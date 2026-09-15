# supplytrack

Builds the annual office-supply comparison for leadership from the two vendor order
exports, as one repeatable command instead of a once-a-year manual workbook.

The design spec is `../docs/spec.md`. Read it before changing anything here; the file
schemas and the module interfaces in its appendices are what the pieces agree on.

## What it does

Two exports go in - the Amazon Business order history and the Preferred order history, as one
file, several files, or sheets inside a bigger workbook, in any combination - and the leadership
workbook comes out. Sheets are found by their header row, not by file name or position, so the
working workbook can be handed over as it is; see "Reading the exports" below. In between, every
judgement call is recorded in a file that carries forward:

- **is this an office supply?** Amazon sells the firm paper and it sells the firm sparkling
  water, and only one of those belongs in the report.
- **are these the same product?** The same item is often listed twice under different
  titles, and counted separately it ranks as two smaller items.
- **how many units are in a pack?** The ranking is by units bought, so a 1,000-pack and a
  12-pack are not comparable until this is known.

Each answer is stored against a stable key in `data/item_master.csv`. A *confirmed* answer is
never asked about again, so a full review happens once and new items only.

Deterministic throughout: no model runs in the pipeline. The one place a model helps is
proposing answers for the review queue, which a person confirms.

## Commands

```
supplytrack ingest   --year 2025 <export-file>... [--amazon <file>] [--preferred <file>]
supplytrack review   --year 2025 [--apply <decisions.csv>]
supplytrack propose  --year 2025 [--provider anthropic|gemini] [--dry-run]
supplytrack rank     --year 2025 [--top 25]
supplytrack prices   --year 2025 [--template | --update]
supplytrack report   --year 2025 [--top 25]
supplytrack import-report --year 2025 --data-dir <d> <report.xlsx> [--force]
supplytrack validate --year 2025
supplytrack run      --year 2025 <export-file>... [--amazon <file>] [--preferred <file>]
```

`run` chains the lot and stops wherever a person is needed. It takes the same export files as
`ingest`, positionally; `--amazon` / `--preferred` are the older spelling and still work on both.

### Reading the exports

`ingest` looks at every sheet of every file it is given and picks out the Amazon and Preferred
exports by their header row, wherever they sit: sheet name, position and file count are never
checked. This means:

- The office manager's working workbook - the finished table, a scratch sheet, and the raw exports pasted in
  at the back - can be handed over whole, as `supplytrack ingest --year 2025 working.xlsx`.
- Either export works alone; `ingest` says so when only one vendor was found.
- Only 12 columns are required in total (7 from Amazon's Orders report, 5 from Preferred), by
  name; extra columns, a different order, and a different total count are all fine. Full detail
  and the exact column names: `docs/spec.md` section 2.
- A sibling Amazon report (Refunds, Returns, Reconciliation, Shipments) is named and skipped
  rather than reported as a pile of missing columns. The finished FINAL workbook, which holds no
  raw order lines, is refused with a message naming every sheet looked at and the columns needed.
- If the working workbook carries both the raw export and the office manager's own filtered "office
  supplies only" copy of it, the fuller sheet is read and the other is listed as a filtered view
  of it, not read twice.
- A report workbook this tool built - the office manager's saved file from a previous year - can
  be handed over the same way. It carries the item master and both price tables forward on
  sheets of its own; `ingest` recognises those sheets but only reads the order lines from a file,
  while `run` takes whichever of the three files the data directory does not already have from
  it, and `import-report` (below) pulls them out on their own.

### Carrying the item master and prices forward

The report workbook this tool writes is also readable: it carries the item master and both price
tables forward on three sheets of its own (`Item master`, `Prices`, `Prices retired`), in the
exact CSV column order, written as text everywhere except the whole-number columns so a price
like `1.250` or an ISO date survives byte for byte. This is what makes a returning year simple:
hand over last year's report workbook alongside the new export and nothing else is needed.

```
supplytrack run --year 2026 inbox/amazon-2026.xlsx inbox/preferred-2026.xlsx "Acme Widget Top 25 Items Comparison 2025.xlsx"
```

`run` takes the item master and both price tables from the report workbook for whichever of the
three the data directory does not already have; it never overwrites work already in progress. To
pull the three files out on their own, without running the rest of the pipeline:

```
supplytrack import-report --year 2025 --data-dir data "Acme Widget Top 25 Items Comparison 2025.xlsx"
```

It refuses to overwrite a file that already has content, unless `--force` is given. The same
sheet recognition that finds these three tables in a workbook also finds them in loose
`item_master.csv`, `prices.csv` and `prices_retired.csv` files, so either form works.

### The review queue

Three kinds of row land in `review_queue.csv`, and the `queue_reason` column says which:

| `queue_reason` | Meaning | Blocks the build |
|---|---|---|
| `unknown key` | The master has never seen this item. | Yes |
| `pack size missing` | Included, but there is no pack size, so its units cannot be counted. | Yes |
| `pack size unconfirmed` | The pack size came from a regex or a proposal, not from a person. | No |

`review` prints the count for each reason before it says whether anything is blocking.

The third kind is the point of the queue being a standing list rather than a list of new items.
A pack size read off a title is usually right and is good enough to rank on, so it does not stop
the build; it keeps appearing in the queue, in a `UPP_UNCONFIRMED` warning and on the report's
`Sources` sheet until somebody confirms it. On the seeded 2025 master that is 84 items.

`review --apply` records the pack sizes as confirmed. `review --apply --proposed` records them as
proposed instead, which is what a Claude skill filling in the queue should use: it unblocks the
build without claiming a person checked anything, so those rows stay in the queue.

Exit codes are part of the interface:

| Code | Meaning |
|---|---|
| 0 | It worked. |
| 1 | Something is wrong with the data; the build stopped and said what. |
| 2 | The tool needs a person: new items to review, or a price sheet to fill in. |

A typical first run for a year:

```
supplytrack ingest --year 2025 amazon.xlsx preferred.xlsx     # or one workbook holding both
supplytrack review --year 2025                      # writes the queue, exits 2 if anything blocks
#   ... fill in include, units_per_pack and canonical_name ...
supplytrack review --year 2025 --apply data/2025/review_queue.csv
#   ... or --apply ... --proposed for values Claude filled in and nobody has checked ...
supplytrack rank   --year 2025
supplytrack prices --year 2025 --template           # writes the price sheet, exits 2
#   ... the office manager fills in unit_price and status ...
supplytrack prices --year 2025                      # checks the filled sheet
supplytrack report --year 2025
```

### Letting a model propose the queue first

`supplytrack propose --year 2025 --provider anthropic` reads `review_queue.csv` and writes
`review_queue_proposed.csv`: the same columns, plus `confidence` and `proposed_by`, every reason
prefixed `AI: `. It needs an API key (an explicit `--api-key`, then `ANTHROPIC_API_KEY` /
`GEMINI_API_KEY`, then Windows Credential Manager through the optional `keyring` package -
`pip install keyring` then `keyring set supplytrack anthropic`). `--dry-run` shows the batches it
would send, needs no key. Only the allow-listed fields (`key, source, raw_title,
amazon_category, pack_desc, packs_in_year, upp_candidates`, plus the canonical names already in
use) ever leave the machine; nothing else in the queue is sent. `python -m supplytrack.propose`
still works with the same flags, for a checkout that only has the module; both build their
arguments from the same function so the two cannot drift apart. Apply the result exactly like a
hand-filled queue - `--apply ... --proposed` if nobody has checked it yet. Full detail, including
how to read the proposals: `docs/spec.md` section 4.2, `src/skills/supply-top25/SKILL.md`
section 2.

The same pass is also on the page: step 2 (Review) has an "Advanced: AI suggestions" disclosure,
closed by default, with a provider, a model, a scope (blocking rows only or every queued row) and
a password-type key field kept in memory for the visit only. It sends the same allow-listed
fields and shows them before the click; answers still only reach the master through Confirm
selected or Accept suggestions for now. Not something to hand to the office manager: it is for the owner's
own key. See `docs/webapp-spec.md` section 9.

### The price sheet

`prices.csv` has one row per top-N item and vendor. `status` is `priced`, `not_available`,
`discontinued` or `unpriced` (nobody has looked yet). `--template` writes a fresh sheet with
every row `unpriced`. When a review changes the ranking, `prices --update` rewrites the sheet to
the current top N: typed rows are kept, new items arrive as `unpriced`, and rows for items that
dropped out move to `prices_retired.csv`. Nothing typed is ever lost. A missing row is a fail;
an `unpriced` row is a warning (`PRICES_UNPRICED`) and shows as `not priced` in the report.

## Where the data lives

Runtime files sit under a data directory, and the finished workbook under an output
directory. Neither is committed: they hold the firm's purchasing history.

| | Default | Override |
|---|---|---|
| Data | `./data` | `--data-dir`, or `SUPPLYTRACK_DATA` |
| Output | `./out` | `--out-dir`, or `SUPPLYTRACK_OUT` |

```
data/
  item_master.csv          every decision, carried forward year to year
  2025/
    lines.csv              one normalised row per order line
    run.json               what was read, when, and what looked odd
    review_queue.csv       items needing a decision or a confirmation (written by review)
    ranked.csv             every included item, ranked by units bought
    excluded.csv           every dropped line, with its reason
    prices.csv             what each vendor charges (typed by hand)
    prices_retired.csv     price rows for items that fell out of the top N (never deleted)
out/
  Acme Widget Top 25 Items Comparison 2025.xlsx
```

## Checks

`validate` runs standalone and inside the pipeline. A **fail** means a number in the
report would be wrong, and the build stops. A **warn** means something is worth a look but
the arithmetic holds.

`UPP_TITLE_MISMATCH` is deliberately hard to trigger. A number in a title is more often a
measurement than a count ("2 Inch Ring Binders", "5 Tab Dividers"), so those never become pack-size
candidates at all, and the warning only fires when a *counting* phrase disagrees with the confirmed
value. Matching any number in the title, or the product of two of them ("12/Pack, Case of 10 Packs"
against a master of 120), keeps it quiet. A warning that is usually wrong teaches people to skim
past the ones that are right.

The load-bearing check is `UNCOUNTED_LINES`: included lines plus excluded lines must equal
the lines read. The 2025 workbook quietly lost its M-Z tail and no total on the page looked
wrong, because nothing ever asked whether the parts still added up to the whole.

## Development

Python 3.10 or newer. `openpyxl` is the only runtime dependency; there is no pandas.

```
python -m pytest -q                      # from this directory
python tests/fixtures/make_fixtures.py   # rebuild the synthetic exports
python scripts/build_wheel.py            # wheel; refuses a dirty tree
```

Test fixtures are invented data and must stay that way. Nothing from `../inbox/` may be
copied into `tests/`, committed, or pasted into a prompt.

`scripts/price_spike.py` is a separate, standalone research script (not part of the
`supplytrack` package, no install needed) that scores a web-search model's vendor price lookups
against a set of hand-checked prices. See `docs/HANDOFF.md` for the live commands and where its
output lands.

The browser port in `web/` has its own test suites, including one for the AI-proposal provider
seam (`web/tests/suggest-tests.js`, alongside `web/tests/run-tests.js` and
`web/tests/report-tests.js`); see `web/README.md`.
