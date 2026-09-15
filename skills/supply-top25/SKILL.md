---
name: supply-top25
description: "Runs and maintains the office manager's yearly office-supply Top 25 Items By Quantity report using the supplytrack tool: ingesting the Amazon Business and Preferred exports, working the item master and review queue, filling the vendor price template, reading validator output, and explaining the finished report. Trigger phrases: top 25 items, office supply report, supplytrack, the office manager's supply comparison, review queue, item master."
---

# Supply Top 25 report (supplytrack)

This tool turns two vendor order exports into the office manager's once-a-year leadership workbook
ranking office supplies by units bought. It is deterministic: nothing is guessed silently.
The only place a model helps is proposing answers for new items, and a person confirms each
one before use.

Run everything from the project folder:

```
cd "U:/AI PROJECTS/project-management/supply-cost-tracking"
```

Data lives in `data/`, output in `out/`, both under this folder unless overridden with
`SUPPLYTRACK_DATA` / `SUPPLYTRACK_OUT` (or `--data-dir` / `--out-dir`). The two files the
person hands you (the Amazon Business export and the Preferred export) belong in `inbox/`
and are never moved elsewhere.

## 1. Running the yearly process

A year's run is one command, re-run until it finishes:

```
supplytrack run --year 2025 --amazon inbox/amazon-2025.xlsx --preferred inbox/preferred-2025.xlsx
```

Exit codes matter:

- **0**, it worked.
- **1**, something is wrong with the data. Read the printed FAIL lines (see the validator
  table below) and fix the cause; do not re-run blindly.
- **2**, the tool needs a person, at one of two points:
  - **New items to review**, printed "N new item(s) need a decision" with a path to
    `data/2025/review_queue.csv`. Work the queue (section 2), apply it, then re-run.
  - **Prices to fill in**, printed "Wrote a blank price sheet" with a path to
    `data/2025/prices.csv`. Fill it in (section 3), then re-run.

`run` can stop at review, then prices, then finish, each time, re-issue the same `run`
command; it picks up where it left off.

Each year produces, under `data/2025/`:

| File | What it is |
|---|---|
| `lines.csv` | One normalised row per order line from both exports |
| `run.json` | What was read, when, and anything that looked odd |
| `review_queue.csv` | Items needing a decision (written by `review`) |
| `ranked.csv` | Every included item, ranked by units bought |
| `excluded.csv` | Every dropped line, with its reason |
| `prices.csv` | What each vendor charges, typed by a person |

`data/item_master.csv` is not per-year, it is the persistent file that carries every
confirmed decision forward, so a returning item is never asked about again. The finished
workbook lands at `out/Acme Widget Top 25 Items Comparison 2025.xlsx`.

## 2. Working the review queue

Open `data/2025/review_queue.csv`. Every row already carries a `queue_reason`:

- **unknown key**, the item master has never seen this item. Blocks the build.
- **pack size missing**, it is included but has no pack size. Blocks the build.
- **pack size unconfirmed**, it has a pack size from a title guess or an earlier proposal,
  nobody has confirmed it. Does not block, but keeps showing up until confirmed.

For every row, work out a value and a one-line reason for `include` (y/n), `units_per_pack`,
`canonical_name`, and `unit_label` (EA or RM). Use:

- The `raw_title` text and `amazon_category`, Amazon's own categories `Office Product` and
  `Business, Industrial, & Scientific Supplies Basic` normally include; `Grocery`, `Kitchen`,
  `Apparel`, `Home`, `Sports`, `Toys`, `Pet Supplies`, `Baby Product` normally exclude.
  Preferred lines default to include (it is an office-supply vendor).
- The `upp_candidates` column, the pack sizes the title itself seems to state, each with the
  phrase that produced it. If it lists more than one number, say which one you picked and why,
  or leave it blank if you cannot tell.
- The existing `canonical_name` values in `data/item_master.csv`, if a new listing is
  obviously the same product as one already there (a repackaging, a near-identical title),
  give it that same canonical name so the two merge into one item. Say why in one line.

Rules that do not bend: never invent a pack size when the title gives no count, leave
`units_per_pack` blank and say so. For Preferred rows, use the `Pack` code instead (`CT10` =
10, `BX100` = 100, `CS1` = 1, `Each` = 1); if the code doesn't match, leave it blank and say
it needs a person to check the invoice. Never edit `data/item_master.csv` by hand, every
change goes through `review --apply`.

Present proposals as a compact table grouped by `queue_reason`, blocking rows (unknown key,
pack size missing) first, then pack size unconfirmed: title (shortened), proposed
include/units/name/label, and a one-line reason for each.

Apply only after an explicit yes:

- The person confirms the values are right:
  ```
  supplytrack review --year 2025 --apply data/2025/review_queue.csv
  ```
  This sets `upp_source=master`, a person confirmed it, and it will not be asked about again.
- The person says something like "just use your proposals for now" without checking them:
  ```
  supplytrack review --year 2025 --apply data/2025/review_queue.csv --proposed
  ```
  This sets `upp_source=proposed`. Tell them plainly: these rows will keep appearing in the
  queue as "pack size unconfirmed" and the validator will warn `UPP_UNCONFIRMED` on them, and
  the report's Sources sheet will list them, until somebody actually confirms them.

After applying, re-run `supplytrack review --year 2025` (no `--apply`) to see whether anything
still blocks, or re-issue the `run` command from section 1 to continue the pipeline.

## 3. The prices step

`supplytrack prices --year 2025 --template` writes `data/2025/prices.csv`: one row per
top-N item times vendor (`Office Depot`, `Preferred`, `Amazon`, `Staples`), columns
`rank, canonical_name, vendor, unit_price, status, url, checked_on, note`. `status` is
`priced`, `not_available`, `discontinued` or `unpriced` (nobody has looked yet; a fresh template
starts every row as `unpriced`); `unit_price` is the price for one each, required when `priced`. The Amazon row's `note` carries `last paid per each: X` as a reference only , 
it is what the firm paid last, not a current quote, and it is never treated as the price.

Claude does not fill these in, there is no web access to vendor sites here, and pricing
needs a live check of each one. A person (the office manager) fills `unit_price` and `status` by hand.

Once filled, check it:

```
supplytrack prices --year 2025
```

Without `--template` this validates the existing file instead of writing a new one: every
top-N item times vendor must have a row, and every `priced` row needs a numeric price.

If the ranking changed since the sheet was written (a review confirmed or corrected pack sizes,
for example), do not rewrite the sheet by hand. Run:

```
supplytrack prices --year 2025 --update
```

It keeps every typed row, adds `unpriced` rows for items new to the top N, and moves rows for
items that dropped out to `data/2025/prices_retired.csv`. Tell the person which items are new
and still `unpriced`; the report can be built with them showing as `not priced`, with a
`PRICES_UNPRICED` warning, but it should not go to leadership that way.

## 4. Reading validator output

`supplytrack validate --year 2025` runs every check; it also runs automatically inside
`rank`, `prices`, `report`, and `run`. A **FAIL** means a number in the report would be
wrong, and the build stops. A **WARN** means something is worth a look, but the arithmetic
still holds.

| Level | Code | Meaning | Fix |
|---|---|---|---|
| FAIL | `LINES_MISSING` | No `lines.csv` for the year | Run `ingest` for that year first |
| FAIL | `LINE_COUNT_MISMATCH` | `run.json`'s row count and `lines.csv`'s row count disagree | Re-run `ingest`; never hand-edit `lines.csv` |
| FAIL | `UNKNOWN_KEY` | A line's key is not in the item master | Run `review`, fill the queue, apply it |
| FAIL | `UPP_MISSING` | An included item has no usable `units_per_pack` | Resolve it in the review queue |
| FAIL | `RANK_MISSING` | No `ranked.csv` / `excluded.csv` yet | Run `rank` |
| FAIL | `RANK_EMPTY` | Items are included but the ranking is empty | Run `rank` again |
| FAIL | `UNCOUNTED_LINES` | Included plus excluded lines don't add up to lines read | Run `rank` again (this caught the 2025 M-Z truncation) |
| FAIL | `PRICES_MODULE_MISSING` | The prices step is not installed in this copy | Reinstall supplytrack |
| FAIL | `PRICES_MISSING` | No `prices.csv` for the year | Run `prices --template` and fill it in |
| FAIL | `PRICES_INCOMPLETE` | A top-N item×vendor cell is missing, blank, non-numeric, or has an unknown status | Fill in or correct the named cell(s) |
| WARN | `DATE_OUT_OF_YEAR` | Some lines are dated outside the year | Still counted; re-export with the right date range if that's wrong |
| WARN | `STATUS_NOT_CLOSED` | An order's status isn't Closed | Still counted; just a heads up |
| WARN | `UPP_UNCONFIRMED` | An included item's pack size came from a title guess or a proposal, not a person | Confirm it in the review queue (`--apply` without `--proposed`) |
| WARN | `UPP_TITLE_MISMATCH` | The master's pack size disagrees with what the title states | Check which is right; correct it via the review queue if needed |
| WARN | `CATEGORY_UNUSUAL` | An item's include/exclude decision goes against the usual rule for its Amazon category | Check whether it's really an exception |
| WARN | `NEAR_DUPLICATE_NAMES` | Two canonical names are nearly identical but not merged | Give them one name so they merge into one item |
| WARN | `VENDOR_COVERAGE` | One vendor priced fewer top-N items than the best-covered vendor | Compare the Comparable basket row, not raw column totals; price more items if possible |

## 5. The report

`supplytrack report --year 2025` writes `out/Acme Widget Top 25 Items Comparison 2025.xlsx`
with four sheets, in this order:

- **Top 25**, the leadership page: rank, description, pack/size, quantity, four vendor unit
  prices, four vendor total costs, a `Priced items` row (n / 25 per vendor), and a
  **Comparable basket** row that totals only items every vendor could price.
- **All items**, the full ranking, not just the top N.
- **Excluded**, every dropped line and why.
- **Sources**, export file names, row counts, date range, item master row count, and every
  item whose `upp_source` is not `master` (its pack size is still unconfirmed).

The rebuilt list can differ from a hand-built one on purpose: total-cost cells are formulas
instead of typed numbers, the meaningless sum of unit prices is dropped, row-minimum
highlighting is a real rule instead of hand fill, and the Comparable basket exists so the
four vendor totals can be compared honestly even when vendors didn't price the same items.
None of that is an error to chase down.

Always tell the person to review the workbook, especially the Sources sheet's list of
unconfirmed pack sizes, before it goes to anyone else. They can delete the All items,
Excluded, and Sources sheets before sending if they only want the Top 25 page, the extra
sheets stay one click away for when leadership asks, not because they must ship.

## 6. Guardrails

- `inbox/` files (the vendor exports) are firm-confidential. Never quote large parts of them,
  paste them into an external tool, or move them outside this project folder.
- Never commit `data/` or `out/`, both hold the firm's purchasing history.
- Never modify anything under `inbox/`.
- Never edit `data/item_master.csv` directly. Every change goes through `review --apply`.
- Never invent a pack size. Leave it blank and say so, or use the Preferred Pack code.
