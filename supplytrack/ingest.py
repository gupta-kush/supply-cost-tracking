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
    read_table,
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

_AMAZON_REQUIRED = [norm_header(h) for h in AMAZON_HEADERS]
_PREFERRED_REQUIRED = [norm_header(h) for h in PREFERRED_HEADERS]


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


def ingest(data_dir: Path, year: int, amazon: Path, preferred: Path | None) -> IngestResult:
    """Read both exports, write ``<year>/lines.csv`` and ``<year>/run.json``."""
    data_dir = Path(data_dir)
    out_dir = year_dir(data_dir, year)

    amazon_rows, amazon_notes = _read_amazon(Path(amazon), year)
    preferred_rows: list[dict] = []
    preferred_notes: dict = {"warnings": [], "dates_out_of_year": [], "non_closed": []}
    if preferred is not None:
        preferred_rows, preferred_notes = _read_preferred(Path(preferred), year)

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
        amazon_file=Path(amazon).name,
        preferred_file=Path(preferred).name if preferred is not None else "",
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
    }
    result.run_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _read_amazon(path: Path, year: int) -> tuple[list[dict], dict]:
    headers, body = read_table(path)
    index = header_index(headers, path, _AMAZON_REQUIRED)
    notes: dict = {"warnings": [], "dates_out_of_year": [], "non_closed": []}
    rows: list[dict] = []

    for offset, raw in enumerate(body):
        where = f"{path.name} row {offset + 2}"
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
            f"{path.name}: read {len(body)} lines but wrote {len(rows)}. "
            "Nothing may be dropped at ingest; this is a bug, not a data problem."
        )
    notes["warnings"] = _summarise(path, notes, year)
    return rows, notes


def _read_preferred(path: Path, year: int) -> tuple[list[dict], dict]:
    headers, body = read_table(path)
    index = header_index(headers, path, _PREFERRED_REQUIRED)
    notes: dict = {"warnings": [], "dates_out_of_year": [], "non_closed": []}
    rows: list[dict] = []

    for offset, raw in enumerate(body):
        where = f"{path.name} row {offset + 2}"
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

    notes["warnings"] = _summarise(path, notes, year)
    return rows, notes


def _summarise(path: Path, notes: dict, year: int) -> list[str]:
    warnings: list[str] = []
    if notes["dates_out_of_year"]:
        sample = ", ".join(
            f"{d['order_id'] or '(no order id)'} on {d['order_date']}"
            for d in notes["dates_out_of_year"][:5]
        )
        warnings.append(
            f"{path.name}: {len(notes['dates_out_of_year'])} line(s) are dated outside {year}: "
            f"{sample}"
        )
    if notes["non_closed"]:
        sample = ", ".join(
            f"{d['order_id'] or '(no order id)'} is {d['status']}" for d in notes["non_closed"][:5]
        )
        warnings.append(
            f"{path.name}: {len(notes['non_closed'])} line(s) have a status other than Closed: "
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
