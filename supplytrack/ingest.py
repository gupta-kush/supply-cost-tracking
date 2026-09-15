"""Stage 1: turn the two vendor exports into one normalised line file.

Both exports describe the same thing - somebody bought N of something on a
date - in different shapes, so everything downstream reads ``lines.csv``
instead of either vendor's format. Nothing is dropped here: a line outside the
reporting year or with an unusual order status is written and *listed*, never
filtered away silently, because the count of lines written has to match the
count read for the later checks to mean anything.
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from .errors import SupplytrackError
from .master import year_dir
from .xlsx import (
    cell,
    clean_text,
    coerce_date,
    coerce_decimal,
    coerce_int,
    header_index,
    norm_header,
    normalise_grid,
    scan_headers,
    sheet_grids,
)

LINES_COLUMNS = [
    "source",
    "order_date",
    "order_id",
    "key",
    "raw_title",
    "sku",
    "pack_desc",
    "amazon_category",
    "packs",
    "ppu_paid",
    "line_subtotal",
    "account_user",
]

# The Amazon Business order-history export, exactly as it comes out.
AMAZON_HEADERS = [
    "Order Date",
    "Order ID",
    "Account Group",
    "PO Number",
    "Order Quantity",
    "Order Subtotal",
    "Order Shipping & Handling",
    "Order Promotion",
    "Order Tax",
    "Order Net Total",
    "Order Status",
    "Account User",
    "Account User Email",
    "Payment Date",
    "Payment Amount",
    "Payment Instrument Type",
    "Payment Identifier",
    "Amazon-Internal Product Category",
    "Title",
    "Segment",
    "Family",
    "Class",
    "Commodity",
    "Brand Code",
    "Brand",
    "Purchase PPU",
    "Item Quantity",
    "Item Subtotal",
    "Item Shipping & Handling",
    "Item Promotion",
    "Item Tax",
    "Item Net Total",
]

PREFERRED_HEADERS = [
    "Company Name",
    "Code",
    "Description",
    "Pack",
    "Quan",
    "Customer Ref",
    "Contact Name",
    "Order Date",
]

# The columns this tool actually reads, and the only ones an export must have.
# Amazon documents its report columns as user-selectable and reorderable, and
# the selectable list keeps growing, so a sheet is matched on these names
# alone: extra columns are ignored and position and count are never checked.
#
# Personal data must never be added to either required list. Account User
# Email, Payment Identifier and Payment Instrument Type are not read anywhere
# in this package. Account User is read, but only to copy into the
# account_user column of lines.csv, so it sits in AMAZON_OPTIONAL and an
# export without it still ingests.
AMAZON_REQUIRED = [
    "Order Date",
    "Order ID",
    "Order Status",
    "Amazon-Internal Product Category",
    "Title",
    "Item Quantity",
    "Purchase PPU",
]

PREFERRED_REQUIRED = [
    "Code",
    "Description",
    "Pack",
    "Quan",
    "Order Date",
]

# Read when present, blank when not. None of these decides whether a sheet is
# recognised, so losing one costs a column of detail and nothing else.
AMAZON_OPTIONAL = ["Item Subtotal", "Account User"]
PREFERRED_OPTIONAL = ["Customer Ref", "Contact Name"]

# The other Amazon Business reports, so picking the wrong one in the "Show"
# dropdown is named rather than reported as a pile of missing columns.
#
# Each marker list holds only headers that do NOT appear in the Orders report's
# own column set, and two of them must be present before a sheet is called that
# report. Sourcing, honestly: the Refunds and Returns markers come from Amazon's
# own Business Analytics guide and are solid; Return Status, Return Quantity and
# the Shipments markers were only corroborated by secondary write-ups, so they
# are deliberately narrow. The Reconciliation markers are the invoice and
# statement fields of the report Amazon launched in 2026; the legacy
# Reconciliation layout looks like Orders without the item columns and is not
# detected here on purpose, because every header it carries is also an Orders
# header and guessing would misread a trimmed Orders export.
SIBLING_REPORTS: list[tuple[str, list[str]]] = [
    ("Refunds", ["Refund Date", "Refund Reason", "Refund Status", "Refund Type"]),
    ("Returns", ["Return Date", "Return Reason", "Return Status", "Return Quantity"]),
    (
        "Reconciliation",
        [
            "Statement Number",
            "Invoice Number",
            "Invoice Due Date",
            "Document Issue Date",
            "Document Status",
            "Credit Memo Number",
        ],
    ),
    ("Shipments", ["Carrier Tracking #", "Delivery Status", "Shipment Tracking Number"]),
]

# How many markers of one sibling report a sheet needs before it is named as
# that report, and how many columns of a signature a sheet needs before the
# failure talks about missing columns rather than an unrecognised sheet.
SIBLING_MIN_MARKERS = 2
NEAR_MISS_MIN_COLUMNS = 2

_AMAZON_REQUIRED = [norm_header(h) for h in AMAZON_REQUIRED]
_PREFERRED_REQUIRED = [norm_header(h) for h in PREFERRED_REQUIRED]
_AMAZON_OPTIONAL = [norm_header(h) for h in AMAZON_OPTIONAL]
_PREFERRED_OPTIONAL = [norm_header(h) for h in PREFERRED_OPTIONAL]

_SIGNATURES = [("amazon", _AMAZON_REQUIRED), ("preferred", _PREFERRED_REQUIRED)]
_VENDOR_LABELS = {"amazon": "Amazon", "preferred": "Preferred"}
# Matching is on normalised headers; messages name the column the way it is
# spelled in the export, because that is what somebody looking at the file sees.
_SPELLING = {norm_header(h): h for h in AMAZON_REQUIRED + PREFERRED_REQUIRED}


def _spell(headers: list[str]) -> str:
    return ", ".join(_SPELLING.get(h, h) for h in headers)


@dataclass
class ExportSheet:
    """One sheet that was recognised as a vendor export."""

    vendor: str
    file: str
    sheet: str
    headers: list[str] = field(default_factory=list)
    body: list[list] = field(default_factory=list)

    @property
    def label(self) -> str:
        """How the sheet is named in an error: the file, and the sheet if it has one."""
        return f"{self.file} sheet {self.sheet!r}" if self.sheet else self.file


@dataclass
class IgnoredSheet:
    """One sheet that was not an export, and why it was passed over."""

    file: str
    sheet: str
    reason: str

    @property
    def label(self) -> str:
        return f"{self.file} sheet {self.sheet!r}" if self.sheet else self.file


@dataclass
class IngestResult:
    """What one ingest run did, and everything run.json records about it."""

    year: int
    amazon_file: str
    preferred_file: str
    amazon_rows: int
    preferred_rows: int
    date_min: str
    date_max: str
    ingested_at: str
    lines_path: Path
    run_path: Path
    warnings: list[str] = field(default_factory=list)
    dates_out_of_year: list[dict] = field(default_factory=list)
    non_closed: list[dict] = field(default_factory=list)
    exports: list[dict] = field(default_factory=list)
    vendors: list[str] = field(default_factory=list)
    ignored: list[dict] = field(default_factory=list)

    @property
    def rows_written(self) -> int:
        return self.amazon_rows + self.preferred_rows


def normalise_title(title: str) -> str:
    """The title reduced to a stable matching form, used to build the key.

    Amazon's export carries no ASIN, so the title is the only identity a line
    has. Case, spacing and stray punctuation all vary between orders of the
    same product, and this strips exactly that much and no more.

    Any change to this function changes every Amazon key, so it must stay
    identical to the copy that seeded the master from the 2025 workbook.
    """
    t = unicodedata.normalize("NFKC", title or "").casefold()
    t = re.sub(r"[^0-9a-z /\-.()]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def amazon_key(title: str) -> str:
    return "amz:" + normalise_title(title)


def preferred_key(code: str) -> str:
    """Preferred quotes a real manufacturer SKU, so the key can use it directly."""
    return "pbs:" + str(code or "").strip().upper()


# --------------------------------------------------------------- recognition


def classify_grids(sources: list[tuple[str, str, list[list]]]):
    """Sort raw sheets into the exports this tool reads and the ones it skips.

    ``sources`` is ``(file name, sheet name, raw grid)`` per sheet, in the order
    the files were given. A sheet is an export when its header row carries every
    required column of one signature; the header row is looked for in the first
    :data:`xlsx.MAX_HEADER_SCAN` rows, because a sheet somebody pasted an export
    into often has a title line above it.

    Returns ``(recognised, ignored)``. Raises when the same vendor turns up
    twice, since there is no honest way to choose between them, and when
    nothing at all was recognised.
    """
    recognised: list[ExportSheet] = []
    ignored: list[IgnoredSheet] = []
    skipped: list[tuple[IgnoredSheet, list[list]]] = []

    for file_name, sheet_name, grid in sources:
        rows = list(grid or [])
        match = _match_signature(rows)
        if match is None:
            sheet = IgnoredSheet(file_name, sheet_name, _ignore_reason(rows))
            ignored.append(sheet)
            skipped.append((sheet, rows))
            continue
        vendor, header_row = match
        headers, body = normalise_grid(rows, header_row)
        recognised.append(ExportSheet(vendor, file_name, sheet_name, headers, body))

    for vendor, required in _SIGNATURES:
        found = [e for e in recognised if e.vendor == vendor]
        if len(found) < 2:
            continue
        full = _pick_full_export(found, required)
        if full is None:
            raise SupplytrackError(
                f"Found {len(found)} {_VENDOR_LABELS[vendor]} exports and cannot tell which "
                "one to use: " + ", ".join(e.label for e in found) + ". "
                "Remove the copies you do not want and try again."
            )
        for other in found:
            if other is full:
                continue
            recognised.remove(other)
            ignored.append(
                IgnoredSheet(
                    other.file,
                    other.sheet,
                    f"a filtered view of {full.label}, which this tool reads in full",
                )
            )

    if not recognised:
        raise _nothing_recognised(skipped)
    return recognised, ignored


def classify_exports(paths: list[Path]):
    """:func:`classify_grids` over files on disk, workbooks or .csv files."""
    sources: list[tuple[str, str, list[list]]] = []
    for path in paths:
        path = Path(path)
        for sheet_name, grid in sheet_grids(path):
            sources.append((path.name, sheet_name, grid))
    return classify_grids(sources)


def _row_signature(export: ExportSheet, required: list[str]) -> Counter:
    """Every row of one export reduced to the columns that identify it."""
    index = {h: i for i, h in enumerate(export.headers) if h}
    columns = [index[h] for h in required]
    return Counter(
        tuple(clean_text(row[i]) if i < len(row) else "" for i in columns) for row in export.body
    )


def _contains(big: Counter, small: Counter) -> bool:
    return all(big[key] >= count for key, count in small.items())


def _pick_full_export(found: list[ExportSheet], required: list[str]) -> ExportSheet | None:
    """The one export that holds every row of the others, if there is one.

    The working workbook keeps a filtered copy of the Amazon export beside the
    raw one - the office manager's own "office supplies only" sheet. Both carry
    the export's columns, so both are recognised, and reading either one twice
    would double the lines. When one sheet strictly contains every row of the
    others it is the export and they are views of it, which is a fact about the
    rows rather than a guess from sheet names or row counts. Two sheets that
    hold the same rows, or that each hold rows the other does not, are a real
    ambiguity and the caller refuses them.
    """
    counts = [_row_signature(e, required) for e in found]
    winners = [
        found[i]
        for i, big in enumerate(counts)
        if all(_contains(big, small) and small != big for j, small in enumerate(counts) if j != i)
    ]
    return winners[0] if len(winners) == 1 else None


def _match_signature(grid: list[list]) -> tuple[str, int] | None:
    """The first row that is a header row, and which vendor it belongs to."""
    for row_number, headers in enumerate(scan_headers(grid)):
        present = {h for h in headers if h}
        for vendor, required in _SIGNATURES:
            if all(h in present for h in required):
                return vendor, row_number
    return None


def _scanned_headers(grid: list[list]) -> set[str]:
    """Every header-shaped value in the rows the scan looked at."""
    seen: set[str] = set()
    for headers in scan_headers(grid):
        seen.update(h for h in headers if h)
    return seen


def _sibling_report(grid: list[list]) -> str | None:
    present = _scanned_headers(grid)
    for name, markers in SIBLING_REPORTS:
        hits = [m for m in markers if norm_header(m) in present]
        if len(hits) >= SIBLING_MIN_MARKERS:
            return name
    return None


def _near_miss(grid: list[list]) -> tuple[str, list[str]] | None:
    """The signature this sheet came closest to, and what it is missing."""
    present = _scanned_headers(grid)
    best: tuple[int, str, list[str]] | None = None
    for vendor, required in _SIGNATURES:
        found = [h for h in required if h in present]
        if len(found) < NEAR_MISS_MIN_COLUMNS:
            continue
        missing = [h for h in required if h not in present]
        if best is None or len(found) > best[0]:
            best = (len(found), vendor, missing)
    return (best[1], best[2]) if best else None


def _ignore_reason(grid: list[list]) -> str:
    """Why one sheet was passed over, in the words the page and the CLI show.

    A sibling Amazon report is named first: it is the most specific thing that
    can be said, and it also carries Order Date and Order ID, so the
    missing-column wording would otherwise take over and hide the real problem.
    """
    sibling = _sibling_report(grid)
    if sibling:
        return f"this is the Amazon {sibling} report, not the Orders report"
    near = _near_miss(grid)
    if near:
        vendor, missing = near
        return (
            f"looks like the {_VENDOR_LABELS[vendor]} export but is missing "
            f"{len(missing)} required column(s): " + _spell(missing)
        )
    return "not an order export"


def _nothing_recognised(skipped: list[tuple[IgnoredSheet, list[list]]]) -> SupplytrackError:
    """The failure when no sheet in any file was an export.

    The sibling and missing-column cases are only raised here, once nothing has
    been recognised anywhere. A Refunds sheet sitting beside a good Orders sheet
    is a sheet to skip, not a reason to stop.
    """
    for sheet, grid in skipped:
        sibling = _sibling_report(grid)
        if sibling:
            return SupplytrackError(
                f"{sheet.label}: this is the Amazon {sibling} report. "
                "Export the Orders report instead."
            )
    for sheet, grid in skipped:
        near = _near_miss(grid)
        if near:
            vendor, missing = near
            return SupplytrackError(
                f"{sheet.label} looks like the {_VENDOR_LABELS[vendor]} export but is missing "
                f"{len(missing)} required column(s): " + _spell(missing) + ". "
                "Check that this is the full order-history export and not a filtered view."
            )
    listing = ", ".join(sheet.label for sheet, _ in skipped) or "no sheets at all"
    return SupplytrackError(
        "No order export was found in what you gave the tool. Looked at: "
        + listing
        + ". An Amazon Orders export needs the columns "
        + ", ".join(AMAZON_REQUIRED)
        + ". A Preferred export needs the columns "
        + ", ".join(PREFERRED_REQUIRED)
        + "."
    )


# -------------------------------------------------------------------- ingest


def ingest(data_dir: Path, year: int, *sources: Path | None) -> IngestResult:
    """Read the exports given, write ``<year>/lines.csv`` and ``<year>/run.json``.

    Any number of workbooks or .csv files may be given, in any order: every
    sheet of every file is looked at and the Amazon and Preferred exports are
    picked out by their columns. Either export on its own is enough to run.
    """
    data_dir = Path(data_dir)
    out_dir = year_dir(data_dir, year)

    paths = [Path(p) for p in sources if p is not None]
    if not paths:
        raise SupplytrackError(
            "No export file was given. Pass the workbook or .csv holding the order history."
        )
    recognised, ignored = classify_exports(paths)

    amazon_export = next((e for e in recognised if e.vendor == "amazon"), None)
    preferred_export = next((e for e in recognised if e.vendor == "preferred"), None)

    empty_notes: dict = {"warnings": [], "dates_out_of_year": [], "non_closed": []}
    amazon_rows: list[dict] = []
    amazon_notes: dict = dict(empty_notes)
    if amazon_export is not None:
        amazon_rows, amazon_notes = _read_amazon(amazon_export, year)
    preferred_rows: list[dict] = []
    preferred_notes: dict = dict(empty_notes)
    if preferred_export is not None:
        preferred_rows, preferred_notes = _read_preferred(preferred_export, year)

    # Amazon lines always come before Preferred lines, whatever order the files
    # or sheets arrived in, so the line file does not depend on how the exports
    # were handed over.
    rows = amazon_rows + preferred_rows
    if not rows:
        raise SupplytrackError(
            "Neither export contained any order lines. Check that the files cover the year "
            "you asked for and were exported with their header row."
        )

    lines_path = out_dir / "lines.csv"
    with lines_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=LINES_COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)

    dates = sorted(r["order_date"] for r in rows if r["order_date"])
    warnings = list(amazon_notes["warnings"]) + list(preferred_notes["warnings"])
    result = IngestResult(
        year=int(year),
        amazon_file=amazon_export.file if amazon_export is not None else "",
        preferred_file=preferred_export.file if preferred_export is not None else "",
        amazon_rows=len(amazon_rows),
        preferred_rows=len(preferred_rows),
        date_min=dates[0] if dates else "",
        date_max=dates[-1] if dates else "",
        ingested_at=dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        lines_path=lines_path,
        run_path=out_dir / "run.json",
        warnings=warnings,
        dates_out_of_year=amazon_notes["dates_out_of_year"] + preferred_notes["dates_out_of_year"],
        non_closed=amazon_notes["non_closed"] + preferred_notes["non_closed"],
        exports=[
            _export_record(export, vendor_rows)
            for export, vendor_rows in (
                (amazon_export, amazon_rows),
                (preferred_export, preferred_rows),
            )
            if export is not None
        ],
        vendors=[e.vendor for e in (amazon_export, preferred_export) if e is not None],
        ignored=[
            {"file": s.file, "sheet": s.sheet, "reason": s.reason} for s in ignored
        ],
    )
    _write_run_json(result)
    return result


def _write_run_json(result: IngestResult) -> None:
    payload = {
        "year": result.year,
        "amazon_file": result.amazon_file,
        "preferred_file": result.preferred_file,
        "amazon_rows": result.amazon_rows,
        "preferred_rows": result.preferred_rows,
        "date_min": result.date_min,
        "date_max": result.date_max,
        "ingested_at": result.ingested_at,
        "rows_written": result.rows_written,
        "warnings": result.warnings,
        "dates_out_of_year": result.dates_out_of_year,
        "non_closed": result.non_closed,
        # Added after the first release, so everything above keeps its name and
        # place: which sheet of which file each export came from, which vendors
        # the run covers (one vendor alone is a valid run and says so here), and
        # every sheet that was passed over with the reason.
        "exports": result.exports,
        "vendors": result.vendors,
        "ignored": result.ignored,
    }
    result.run_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _export_record(export: ExportSheet, rows: list[dict]) -> dict:
    """One line of run.json's `exports`: where it came from and what it held."""
    dates = sorted(r["order_date"] for r in rows if r["order_date"])
    return {
        "vendor": export.vendor,
        "file": export.file,
        "sheet": export.sheet,
        "rows": len(rows),
        "date_min": dates[0] if dates else "",
        "date_max": dates[-1] if dates else "",
    }


def _read_amazon(export: ExportSheet, year: int) -> tuple[list[dict], dict]:
    headers, body = export.headers, export.body
    index = header_index(headers, export.label, _AMAZON_REQUIRED, _AMAZON_OPTIONAL)
    notes: dict = {"warnings": [], "dates_out_of_year": [], "non_closed": []}
    rows: list[dict] = []

    for offset, raw in enumerate(body):
        where = f"{export.label} row {offset + 2}"
        title = clean_text(cell(raw, index, norm_header("Title")))
        if not title:
            raise SupplytrackError(
                f"{where} has no Title, so the line cannot be identified. "
                "Re-export the order history; a blank title usually means a truncated download."
            )
        order_date = coerce_date(cell(raw, index, norm_header("Order Date")), where=where)
        order_id = clean_text(cell(raw, index, norm_header("Order ID")))
        status = clean_text(cell(raw, index, norm_header("Order Status")))
        category = clean_text(cell(raw, index, norm_header("Amazon-Internal Product Category")))

        rows.append(
            {
                "source": "amazon",
                "order_date": order_date,
                "order_id": order_id,
                "key": amazon_key(title),
                "raw_title": title,
                "sku": "",
                "pack_desc": "",
                "amazon_category": category,
                "packs": coerce_int(cell(raw, index, norm_header("Item Quantity")), where=where),
                "ppu_paid": coerce_decimal(
                    cell(raw, index, norm_header("Purchase PPU")), where=where
                ),
                "line_subtotal": coerce_decimal(
                    cell(raw, index, norm_header("Item Subtotal")), where=where
                ),
                "account_user": clean_text(cell(raw, index, norm_header("Account User"))),
            }
        )

        if not order_date.startswith(f"{year}-"):
            notes["dates_out_of_year"].append(
                {"source": "amazon", "order_id": order_id, "order_date": order_date, "title": title}
            )
        if status and status.casefold() != "closed":
            notes["non_closed"].append(
                {"source": "amazon", "order_id": order_id, "status": status, "title": title}
            )

    if len(rows) != len(body):  # pragma: no cover - defensive; the loop appends once per row
        raise SupplytrackError(
            f"{export.label}: read {len(body)} lines but wrote {len(rows)}. "
            "Nothing may be dropped at ingest; this is a bug, not a data problem."
        )
    notes["warnings"] = _summarise(export.file, notes, year)
    return rows, notes


def _read_preferred(export: ExportSheet, year: int) -> tuple[list[dict], dict]:
    headers, body = export.headers, export.body
    index = header_index(headers, export.label, _PREFERRED_REQUIRED, _PREFERRED_OPTIONAL)
    notes: dict = {"warnings": [], "dates_out_of_year": [], "non_closed": []}
    rows: list[dict] = []

    for offset, raw in enumerate(body):
        where = f"{export.label} row {offset + 2}"
        code = clean_text(cell(raw, index, norm_header("Code")))
        if not code:
            raise SupplytrackError(
                f"{where} has no Code, so the line cannot be identified. "
                "Ask Preferred to re-send the history with the item codes included."
            )
        order_date = coerce_date(cell(raw, index, norm_header("Order Date")), where=where)
        order_id = clean_text(cell(raw, index, norm_header("Customer Ref")))

        rows.append(
            {
                "source": "preferred",
                "order_date": order_date,
                "order_id": order_id,
                "key": preferred_key(code),
                "raw_title": clean_text(cell(raw, index, norm_header("Description"))),
                "sku": code,
                "pack_desc": clean_text(cell(raw, index, norm_header("Pack"))),
                "amazon_category": "",
                "packs": coerce_int(cell(raw, index, norm_header("Quan")), where=where),
                "ppu_paid": "",
                "line_subtotal": "",
                "account_user": clean_text(cell(raw, index, norm_header("Contact Name"))),
            }
        )

        if not order_date.startswith(f"{year}-"):
            notes["dates_out_of_year"].append(
                {
                    "source": "preferred",
                    "order_id": order_id,
                    "order_date": order_date,
                    "title": code,
                }
            )

    notes["warnings"] = _summarise(export.file, notes, year)
    return rows, notes


def _summarise(name: str, notes: dict, year: int) -> list[str]:
    warnings: list[str] = []
    if notes["dates_out_of_year"]:
        sample = ", ".join(
            f"{d['order_id'] or '(no order id)'} on {d['order_date']}"
            for d in notes["dates_out_of_year"][:5]
        )
        warnings.append(
            f"{name}: {len(notes['dates_out_of_year'])} line(s) are dated outside {year}: "
            f"{sample}"
        )
    if notes["non_closed"]:
        sample = ", ".join(
            f"{d['order_id'] or '(no order id)'} is {d['status']}" for d in notes["non_closed"][:5]
        )
        warnings.append(
            f"{name}: {len(notes['non_closed'])} line(s) have a status other than Closed: "
            f"{sample}"
        )
    return warnings


def load_lines(data_dir: Path, year: int) -> list[dict]:
    """Read ``<year>/lines.csv`` back, with ``packs`` as an int.

    Shared by rank and validate so the two can never read the file in
    different ways.
    """
    path = Path(data_dir) / str(year) / "lines.csv"
    if not path.exists():
        raise SupplytrackError(
            f"No line file for {year} at {path}. Run `supplytrack ingest --year {year}` first."
        )
    rows: list[dict] = []
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        missing = [c for c in LINES_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise SupplytrackError(
                f"{path} is missing the column(s): {', '.join(missing)}. "
                f"Delete it and run ingest for {year} again."
            )
        for line_no, raw in enumerate(reader, start=2):
            row = {c: (raw.get(c) or "").strip() for c in LINES_COLUMNS}
            row["packs"] = coerce_int(row["packs"], where=f"{path.name} line {line_no}")
            rows.append(row)
    return rows


def load_run(data_dir: Path, year: int) -> dict:
    """Read ``<year>/run.json``, or an empty dict when there is none yet."""
    path = Path(data_dir) / str(year) / "run.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SupplytrackError(
            f"{path} is not readable as JSON ({exc}). Delete it and run ingest again."
        ) from exc


def update_run(data_dir: Path, year: int, **fields_to_set) -> dict:
    """Merge keys into ``run.json``; later stages record what they did there."""
    path = Path(data_dir) / str(year) / "run.json"
    payload = load_run(data_dir, year)
    payload.update(fields_to_set)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return payload
