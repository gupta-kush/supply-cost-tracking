# Supply Top 25 builder (browser version)

A single page that turns a year of Amazon Business and Preferred order exports into the
Top 25 supply comparison workbook. It is a port of the `supplytrack` Python package in the
folder above; that package stays the reference implementation and the command line tool, and
the parity tests in `tests/` check that this page produces the same files.

Everything runs in the browser except one optional call: if a person pastes their own AI
provider key into the settings sheet on the Drop screen, the page calls that provider directly
to help decide what an unfamiliar item is. No file, and nothing about the person's purchases
beyond what a proposal needs, ever leaves the browser otherwise, and nothing is stored between
visits except the theme, the top-N box and (in memory only, for the length of the visit) that key.

## What it does, in four screens

1. **Drop.** One drop target. Add this year's order exports - the working workbook as it is
   kept, each vendor's own file, or the `.csv` Amazon Business exports - and, on a returning
   year, last year's report workbook or the item master and prices files, so the page carries
   forward every decision it already made. The year is read from the order dates and can be
   corrected; Top N defaults to 25. A file's kind (Amazon export, Preferred export, item
   master, ...) shows on its chip as soon as it is recognised, before Build the list is
   pressed. **Build the list** runs the whole pipeline: reads every file, decides what it can
   on its own (a regular expression first, then a model if a key is configured), and shows a
   funnel of four real figures - order lines read, distinct products, office items ranked, the
   Top N - as each one is known, never a fake animation ahead of the number. A file that is not
   recognised, or files that do not fit together, show one plain sentence and the sheets that
   were looked at, with the drop target still there to try again.
2. **Results.** The leaderboard: rank, name, a volume bar, and the four vendors' prices with
   the cheapest filled in. Names come from `format.js`'s `displayName`/`distinctDisplayNames`,
   truncated at a sensible length and pried apart when two rows would otherwise read
   identically. A right-hand panel lists only what is worth a person's attention - rows the
   page could not decide, a pack size that disagrees with the title, near-duplicate names - and
   answering one re-ranks live. The money line shows what buying every item at its cheapest
   vendor instead of Amazon would save, once at least one item is priced at both. **Price the
   items** moves to the price screen; **finish** moves to the summary once coverage allows it.
3. **Price.** One item at a time: rank, name, four vendor fields, a vendor's name links to that
   vendor's own site search. Amazon is prefilled with the price last actually paid, marked
   "last paid" until accepted or changed - a display convenience, never written as a price
   until then. Tab moves across the four price fields, Enter accepts and moves to the next
   unpriced item, Escape returns to Results. A dot strip along the bottom shows every item's
   state and jumps to any of them.
4. **Done.** One screen meant to be screenshotted into an email: four figures, the money line
   and its basis, movement since last year (hidden in a first year), what the page decided on
   its own versus what needed a person, and **Download the report** - the same workbook the
   command line tool builds, plus a disclosure with the item master, prices, retired prices and
   `run.json` as separate downloads. Undecided items never block the download; a sentence above
   the button says how many there are and that they are named on the report's Sources sheet,
   with a link back to the panel. Only a run that ranked nothing at all replaces the button
   with a sentence instead.

Keep the report workbook: its Item master, Prices and Prices retired sheets are read back next
year, which is what stops the page asking the same pack size questions again. The separate CSV
downloads are the same tables the command line tool reads and writes.

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
The page detects that and says so instead of showing a blank screen.

## Layout

```
index.html                  shell: navbar, four <section data-screen> screens, one live region
css/app.css                 tokens (light/dark), screen layout, leaderboard, pills, funnel,
                             price mode, done screen - the only file with page-specific styling
js/app.js                   state, the pipeline adapter, the screen router, Build the list;
                             mounts every screen by injection so no screen imports this file
js/screens/drop.js          drop target, chips, funnel, model settings sheet
js/screens/results.js       leaderboard, money line, worth-a-look panel
js/screens/price.js         focused one-item-at-a-time pricing
js/screens/done.js          summary screen and downloads
js/screens/vendor-prices.js cheapest-vendor arithmetic shared by results.js and price.js
js/format.js                money, counts, plurals, display names, provenance - every number
                             or name a screen shows a person goes through here once
js/pipeline.js               the pipeline port: keys, ingest, review, rank, prices, validate
js/report.js                 the workbook builder
js/suggest.js                the AI provider seam: the regex provider, the model provider,
                              autoAccept - what decides an item on its own before asking a person
js/csv.js                    RFC 4180 CSV parse and serialise
js/xlsxio.js                 the one place that resolves ExcelJS, in the browser and in Node
prompts/proposal.json        the model's prompt; byte-identical to
                              supplytrack/prompts/proposal.json, checked by suggest-tests.js
vendor/exceljs.min.js        ExcelJS 4.4.0, pinned
vendor/main.css              the firm Style Guide's compiled Bootstrap build
vendor/bootstrap-icons.woff(2)   icon font, which must stay beside main.css
assets/mark.svg              neutral placeholder mark
tests/                       the parity tests and the headless browser harnesses
```

`package.json` sits one level up, at `src/package.json`: Playwright is a dev dependency for the
headless tests only, and the page itself ships no bundler and no framework.

Two notes on the vendored files:

- `vendor/main.css` is the Style Guide's own compiled CSS (house palette, Work Sans, Bootstrap
  Icons all baked in). The single change made when vendoring it was to remove its
  `@import` of Work Sans from Google Fonts, because this page makes no network calls of its own.
  Work Sans is used when the machine already has it, otherwise the page falls back to the
  system sans-serif. Do not hand-edit anything else in that file; re-copy it from the Style
  Guide repository when it changes.
- The icon font files have to sit in the same folder as `main.css`. The compiled CSS refers to
  them by bare file name, so moving them into a `fonts/` folder makes every icon disappear
  without an error.

Bootstrap's JavaScript bundle is deliberately not vendored. The page uses no Bootstrap
component that needs it, and the few behaviours that would have come from it (dismissing a
message, a native `<dialog>` for the settings sheet) are a few lines each in the JS above.

## Tests

Four suites need nothing but Node 18+, no real data, no network:

```
node tests/run-tests.js
node tests/report-tests.js
node tests/suggest-tests.js
node tests/format-tests.js
```

They compare this port against golden vectors generated from the Python implementation
(`src/tests/golden/`). A failure means either the port has drifted or the Python changed on
purpose; in the second case regenerate the vectors from Python first
(`python scripts/make_golden.py`).

Two more drive the real page in a headless Chromium (`npm install` once, at `src/`, for the
Playwright dev dependency) against the real, confidential 2025 data, which is never committed
(`inbox/`, `data/`, `out/` - see the repository root `.gitignore`). Set `SUPPLYTRACK_INBOX` to
the project root that holds them if it is not this repository's own:

```
node tests/headless-2025.js          # Build the list, both with and without a carried master
node tests/headless-report-parity.js # the report Done downloads, against a CLI-built out/
```

`js/app.js` and the four screens are the DOM layer and are not covered by the four Node suites
beyond what they export as pure functions; the headless harnesses are what exercise them.

**On this page, "done" means rendered, not exported.** Three times in this build a capability
was finished, unit tested, and green in every suite, while nothing on the page ever called it:
`app.js` never mounted `screens/price.js`'s screen, so Price rendered as an empty ring despite
a passing test suite that drove it directly; `done.js` emitted class names `app.css` had never
defined, so the summary screen rendered as unstyled runs of text; `format.js`'s
`distinctDisplayNames` (which resolves two Top N rows that would otherwise show the same
truncated name) was exported, tested, and passed through to every screen as `api.fmt`, and
still went uncalled. None of the four suites above catch a function nobody wired up, because a
suite proves a function is correct, not that a screen uses it. Load the real page against the
real 2025 data and look at it before calling a screen finished.

## Deployment

`.github/workflows/pages.yml` publishes this folder to GitHub Pages on every push to `main`
or `master` that touches `web/`, after the tests above pass. Asset paths are all relative, so
the same folder also works under a subdirectory when the page eventually moves to the internal
directory site.

GitHub Pages caches every file for ten minutes, so a browser open across a deploy can end up
mixing an old file with a new one. Before publishing, the workflow copies this folder into a
build directory and stamps a version onto every script, stylesheet, module import and the AI
prompt fetch, so a deploy is either fully old or fully new, never a mix. See
`scripts/stamp_assets.py` at the repository root for how, and `../docs/webapp-v2-spec.md`
section 8.

## Privacy

Everything runs in the browser except the one call described above. The page reads the files a
person chooses, keeps the results in memory for the session, and hands the outputs back as
downloads; closing the tab discards everything. A model provider call, when a key is
configured, sends only the queue fields `suggest.js`'s `SENT_FIELDS` allow-list names - never a
file, a price or anything from an `inbox/`-style folder - and the key itself lives in a closure
for the length of the visit, never in page state, never stored.
