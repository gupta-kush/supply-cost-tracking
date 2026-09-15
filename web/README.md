# Supply Top 25 builder (browser version)

A single page that turns a year of Amazon Business and Preferred order exports into the
Top 25 supply comparison workbook. It is a port of the `supplytrack` Python package in the
folder above; that package stays the reference implementation and the command line tool, and
the parity tests in `tests/` check that this page produces the same files.

Everything runs in the browser. No file leaves this computer.

## What it does, in five steps

1. **Load files.** Amazon export (`.xlsx` or `.csv`), Preferred export (`.xlsx`), and last
   year's `item_master.csv` and `prices.csv` if you have them. The year is read from the order
   dates and can be corrected. Top N defaults to 25. After reading, two strips show what went
   in (rows and date range per file, as they sit in the export) and what the tool kept (order
   lines, the dates they cover, and how many items the master now knows).
2. **Review.** Every item the tool does not already know, blocking ones first, with a count
   per queue reason above the table. Set include, units per pack, unit, canonical name and a
   note. Suggestions sit read-only beside each cell with a **use** button.
   **Confirm selected** records the pack size as confirmed; **Accept suggestions for now**
   records it as proposed, which counts but stays flagged. Both buttons carry the number of
   ticked rows they would actually write, counted the same way the write counts it, and the
   line under them names the rows that will stay behind and what each one still needs. After a
   write, a note says what was written and what is left.
3. **Ranking.** Every included item ordered by eaches, top N highlighted, columns sortable.
   A strip above the table gives the lines read, the lines counted, the lines left out, the
   items that came out of the merge, and the eaches cut-off at rank N when there is one. When
   a confirm or a change to Top N moves items into or out of the top N, they are listed by
   name rather than the table just repainting. Warnings sit above that; **Review these** jumps
   back to step 2 filtered to the items a warning names.
4. **Prices.** One row per top item, four vendor columns, a price box and a status for each.
   Priced cells per vendor are counted live. Prices from the file you loaded are carried over,
   and any item that is new to the top N since that file is marked **new** and named above the
   grid. Items that dropped out of the top N are listed as retired and still get written out.
5. **Download.** The report workbook plus `item_master.csv`, `prices.csv`,
   `prices_retired.csv` and `run.json`, under the same names the command line tool uses. Every
   failing and warning check is listed first, then a plain line per file saying what is in it
   and how much of it, so nothing is downloaded blind. The report button stays disabled while
   any check is failing, and says which.

Nothing is stored between visits except the theme and the top-N box. Keep `item_master.csv`
and `prices.csv`: loading them next year is what stops the tool asking the same pack size
questions again.

## Opening it

**Hosted:** open the GitHub Pages address for this repository. Nothing else is needed.

**Locally:** serve this folder and open it over `http://`, for example

```
cd src/web
python -m http.server 8000
```

then open `http://localhost:8000/`.

Double-clicking `index.html` does **not** work. Browsers refuse to load JavaScript modules
straight from a folder (`file://`), which is a browser security rule, not a fault in the page.
The page detects that and says so instead of showing a blank screen. The companion spec
(`docs/webapp-spec.md` section 2) asks for `file://` support; that is not achievable alongside
ES modules, so the local route is the small server above.

## Layout

```
index.html            the page
css/app.css           page-specific rules only
js/app.js             DOM, state, file handling   (this is the only file that touches the DOM)
js/pipeline.js        the pipeline port: keys, ingest, review, rank, prices, validate
js/report.js          the workbook builder
js/csv.js             RFC 4180 CSV parse and serialise
js/xlsxio.js          the one place that resolves ExcelJS, in the browser and in Node
vendor/exceljs.min.js ExcelJS 4.4.0, pinned
vendor/main.css       the firm Style Guide's compiled Bootstrap build
vendor/bootstrap-icons.woff(2)   icon font, which must stay beside main.css
assets/mark.svg       neutral placeholder mark
tests/                the parity tests
```

Two notes on the vendored files:

- `vendor/main.css` is the Style Guide's own compiled CSS (house palette, Work Sans, Bootstrap
  Icons all baked in). The single change made when vendoring it was to remove its
  `@import` of Work Sans from Google Fonts, because this page makes no network calls at all.
  Work Sans is used when the machine already has it, otherwise the page falls back to the
  system sans-serif. Do not hand-edit anything else in that file; re-copy it from the Style
  Guide repository when it changes.
- The icon font files have to sit in the same folder as `main.css`. The compiled CSS refers to
  them by bare file name, so moving them into a `fonts/` folder makes every icon disappear
  without an error.

Bootstrap's JavaScript bundle is deliberately not vendored. The page uses no Bootstrap
component that needs it, and the few behaviours that would have come from it (dismissing a
message, locking a step, sorting a column) are a few lines each in `app.js`.

## Tests

```
node tests/run-tests.js
node tests/report-tests.js
```

They compare this port against golden vectors generated from the Python implementation
(`src/tests/golden/`). A failure means either the port has drifted or the Python changed on
purpose; in the second case regenerate the vectors from Python first. `js/app.js` is the DOM
layer and is not covered by them beyond a few pure helpers it exports.

## Deployment

`.github/workflows/pages.yml` publishes this folder to GitHub Pages on every push to `main`
or `master` that touches `web/`, after the tests above pass. Asset paths are all relative, so
the same folder also works under a subdirectory when the page eventually moves to the internal
directory site.

## Privacy

Everything runs in your browser. No file leaves this computer. The page makes no network
requests of any kind: it reads the files you choose, keeps the results in memory for the
session, and hands the outputs back as downloads. Closing the tab discards everything.
