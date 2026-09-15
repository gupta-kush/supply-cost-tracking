"""Build the two synthetic vendor exports the tests run against.

Run from anywhere:

    python tests/fixtures/make_fixtures.py

The .xlsx files it writes are committed, so the tests need no build step. The
data is invented: made-up order numbers, made-up buyers, and product titles
chosen to exercise the awkward cases rather than to match anything real.
Nothing here comes from inbox/, and nothing here may be replaced with real
purchasing data.

The awkward cases, deliberately included:

* two different listings of one product (the name-tag inserts), which must end
  up as one item once a person gives them the same canonical name;
* a title stating two different pack sizes ("500 Sheets/Ream, 10
  Reams/Carton"), which must go to review with both candidates rather than
  being guessed;
* a Grocery line, which the include rule excludes;
* a category nobody has ruled on, which must come back blank rather than
  defaulted;
* an order that is not Closed, and a line dated in the previous year, both of
  which must be counted and warned about, never dropped;
* one date written as text and one header with a trailing space, because the
  real exports carry both;
* a Payment Identifier written as the formula string ="0000", which is ignored.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

from openpyxl import Workbook

HERE = Path(__file__).resolve().parent

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
    "Order Status ",  # trailing space on purpose: the real export carries them
    "Account User",
    "Account User Email",
    "Payment Date",
    "Payment Amount",
    "Payment Instrument Type",
    "Payment Identifier",
    "Amazon-Internal  Product Category",  # double space on purpose
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

OFFICE = "Office Product"
BIS = "Business, Industrial, & Scientific Supplies Basic"

# (order_date, order_id, status, category, title, ppu, item_qty, buyer)
AMAZON_ROWS = [
    (
        dt.datetime(2025, 2, 11),
        "111-0000001-0000001",
        "Closed",
        OFFICE,
        "Avery Printable Name Tags, 400 Printable Name Tag Inserts, 3 x 4 Inches",
        21.49,
        2,
        "Office Manager",
    ),
    (
        dt.datetime(2025, 6, 3),
        "111-0000002-0000002",
        "Closed",
        OFFICE,
        "Avery Name Badge Inserts, 400 Printable Name Tag Inserts, 3 x 4 in, White",
        22.10,
        1,
        "Office Manager",
    ),
    (
        "3/4/2025",  # a text date, as some exports produce
        "111-0000003-0000003",
        "Closed",
        OFFICE,
        "Hammermill Copy Paper, 8.5 x 11, 500 Sheets/Ream, 10 Reams/Carton",
        54.99,
        3,
        "Purchasing Staff",
    ),
    (
        dt.datetime(2025, 1, 20),
        "111-0000004-0000004",
        "Closed",
        OFFICE,
        "BIC Round Stic Ballpoint Pens, Medium Point, Black, 60-Count",
        6.24,
        4,
        "Office Manager",
    ),
    (
        dt.datetime(2025, 9, 9),
        "111-0000005-0000005",
        "Closed",
        OFFICE,
        "BIC Round Stic Ballpoint Pens, Medium Point, Black, 60-Count",
        5.98,
        6,
        "Office Manager",
    ),
    (
        dt.datetime(2025, 4, 2),
        "111-0000006-0000006",
        "Closed",
        OFFICE,
        "Post-it Notes, 3 x 3 Inches, Canary Yellow, 12 Pads",
        14.75,
        5,
        "Purchasing Staff",
    ),
    (
        dt.datetime(2025, 5, 14),
        "111-0000007-0000007",
        "Closed",
        "Grocery",
        "Bubly Sparkling Water, Variety Pack, 18 Count",
        9.48,
        6,
        "Purchasing Staff",
    ),
    (
        dt.datetime(2025, 7, 22),
        "111-0000008-0000008",
        "Cancelled",
        OFFICE,
        "Scotch Magic Tape, 3/4 x 1000 Inches, 6 Rolls",
        12.99,
        1,
        "Office Manager",
    ),
    (
        dt.datetime(2024, 12, 28),  # previous year: counted, and warned about
        "111-0000009-0000009",
        "Closed",
        OFFICE,
        "Sharpie Permanent Markers, Fine Point, Assorted, 12 Count",
        11.32,
        2,
        "Office Manager",
    ),
    (
        dt.datetime(2025, 3, 18),
        "111-0000010-0000010",
        "Closed",
        BIS,
        "Kleenex Professional Facial Tissue, Display Pack of 6",
        18.60,
        3,
        "Purchasing Staff",
    ),
    (
        dt.datetime(2025, 8, 5),
        "111-0000011-0000011",
        "Closed",
        "Tools & Home Improvement",  # a category with no rule either way
        "Cable Zip Ties, 8 Inch, Black (Bulk 1000 Pack)",
        13.45,
        1,
        "Purchasing Staff",
    ),
    (
        dt.datetime(2025, 10, 30),
        "111-0000012-0000012",
        "Closed",
        OFFICE,
        "EXPO Low-Odor Dry Erase Markers, Chisel Tip, Assorted, 48/Pack",
        39.99,
        2,
        "Office Manager",
    ),
]

PREFERRED_HEADERS = [
    "Company Name",
    "Code",
    "Description",
    "Pack",
    "Quan",
    "Customer Ref",
    "Contact Name",
    "Order Date ",  # trailing space on purpose
]

PREFERRED_ROWS = [
    ("Example Firm", "UNV21200", "Copy Paper 8.5 x 11 20lb White", "CT10", 2, "REF-1001",
     "Office Manager", dt.datetime(2025, 2, 4)),
    ("Example Firm", "UNV35668", "Binder Clips Medium Black", "BX100", 3, "REF-1002",
     "Office Manager", dt.datetime(2025, 4, 17)),
    ("Example Firm", "SAN30001", "Permanent Marker Fine Point Black", "Each", 12, "REF-1003",
     "Purchasing Staff", dt.datetime(2025, 6, 11)),
    ("Example Firm", "UNV21200", "Copy Paper 8.5 x 11 20lb White", "CT10", 1, "REF-1004",
     "Office Manager", dt.datetime(2025, 9, 23)),
    ("Example Firm", "PBS9001", "Letterhead Printed 2 Colour", "CS1", 4, "REF-1005",
     "Purchasing Staff", dt.datetime(2025, 11, 6)),
]


def _amazon_row(row: tuple) -> list:
    order_date, order_id, status, category, title, ppu, qty, buyer = row
    subtotal = round(ppu * qty, 2)
    return [
        order_date,
        order_id,
        "Office Operations",
        "",
        qty,
        subtotal,
        0,
        0,
        round(subtotal * 0.0825, 2),
        round(subtotal * 1.0825, 2),
        status,
        buyer,
        f"{buyer.split()[0].lower()}@example.invalid",
        order_date,
        round(subtotal * 1.0825, 2),
        "Corporate Credit Card",
        '="0000"',  # Excel formula wrapper, exactly as exported
        category,
        title,
        "Office Supplies",
        "Paper Products",
        "General",
        "Supplies",
        "BRND",
        title.split()[0],
        ppu,
        qty,
        subtotal,
        0,
        0,
        round(subtotal * 0.0825, 2),
        round(subtotal * 1.0825, 2),
    ]


def write_amazon(path: Path) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.title = "Order History"
    ws.append(AMAZON_HEADERS)
    for row in AMAZON_ROWS:
        ws.append(_amazon_row(row))
    wb.save(path)
    return path


def write_preferred(path: Path) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.title = "Orders"
    ws.append(PREFERRED_HEADERS)
    for row in PREFERRED_ROWS:
        ws.append(list(row))
    wb.save(path)
    return path


# ---------------------------------------------------------------------------
# The working workbook, and the awkward workbooks that must be refused
# ---------------------------------------------------------------------------
#
# The office manager keeps one workbook a year: the finished table on the first
# sheet, a scratch sheet or two, and the raw vendor exports pasted in at the
# back. Sheet recognition is by header row, not by position, so these fixtures
# carry exactly that shape. The Amazon and Preferred rows are the same rows as
# the two standalone exports above, so ingesting the workbook must produce the
# same line file as ingesting the two files.

# The finished table, as it is sent to leadership. No export columns at all.
FINISHED_HEADERS = ["Ranking", "Description", "Pack/Size", "Quantity", "Office Depot", "Amazon"]
FINISHED_ROWS = [
    [1, "Copy Paper 8.5 x 11", "10 RM", 30, 8.99, 9.49],
    [2, "Ballpoint Pens Black", "60 EA", 600, 0.12, 0.10],
]

# A scratch sheet: a pivot somebody left behind. Nothing here is a header the
# tool looks for, which is the point.
SCRATCH_HEADERS = ["Individual count", "Sum of Item Quantity", "Notes"]
SCRATCH_ROWS = [
    ["Copy Paper 8.5 x 11", 30, "merged with the Preferred code"],
    ["Ballpoint Pens Black", 600, ""],
]

# Columns added to the Amazon sheet in the variant workbook, to prove extras are
# ignored. Amazon lets an account admin add and reorder columns at will.
AMAZON_EXTRA_HEADERS = ["Seller Name", "Tax Exemption Applied", "ASIN"]


def _amazon_sheet(ws, headers: list[str] | None = None, lead_rows: int = 0) -> None:
    """Write the Amazon export rows onto a sheet, optionally below some filler."""
    headers = AMAZON_HEADERS if headers is None else headers
    for _ in range(lead_rows):
        ws.append([])
    ws.append(headers)
    for row in AMAZON_ROWS:
        ws.append(_amazon_row(row))


def _preferred_sheet(ws, lead: list[list] | None = None) -> None:
    for row in lead or []:
        ws.append(row)
    ws.append(PREFERRED_HEADERS)
    for row in PREFERRED_ROWS:
        ws.append(list(row))


def write_working_workbook(path: Path) -> Path:
    """Five sheets, the way the workbook actually arrives: exports at the back.

    The Preferred sheet has a title line and a blank row above its headers, so
    the header scan has to look past row 1 to find it. The Amazon sheet is last
    and its headers are on row 1, exactly as a paste from the raw export leaves
    them.
    """
    wb = Workbook()
    finished = wb.active
    finished.title = "Sheet1"
    finished.append(FINISHED_HEADERS)
    for row in FINISHED_ROWS:
        finished.append(row)

    notes = wb.create_sheet("Sheet2")
    notes.append(["Checked with the vendors March 2026"])

    scratch = wb.create_sheet("Sheet3")
    scratch.append(SCRATCH_HEADERS)
    for row in SCRATCH_ROWS:
        scratch.append(row)

    _preferred_sheet(wb.create_sheet("PBS Orders"), lead=[["Preferred order history"], []])
    _amazon_sheet(wb.create_sheet("orders_from_20250101_to_2025123"))
    wb.save(path)
    return path


def write_working_workbook_filtered(path: Path) -> Path:
    """The working workbook with the office manager's own filtered copy in it.

    The real file keeps an "office supplies only" sheet beside the raw export.
    Both carry the export's columns, so both are recognised, and reading either
    twice would double the lines. Every row of the filtered sheet is also in the
    raw one, which is how the full export is told from a view of it.
    """
    wb = Workbook()
    finished = wb.active
    finished.title = "Sheet1"
    finished.append(FINISHED_HEADERS)
    for row in FINISHED_ROWS:
        finished.append(row)

    scratch = wb.create_sheet("Sheet3")
    scratch.append(SCRATCH_HEADERS)
    for row in SCRATCH_ROWS:
        scratch.append(row)

    only = wb.create_sheet("AMZ Office Supply Orders ONLY")
    only.append(AMAZON_HEADERS)
    for row in AMAZON_ROWS:
        if row[3] == OFFICE:  # the category column: her filter, kept simple
            only.append(_amazon_row(row))

    _preferred_sheet(wb.create_sheet("PBS Orders"))
    _amazon_sheet(wb.create_sheet("orders_from_20250101_to_2025123"))
    wb.save(path)
    return path


def _reorder(headers: list[str]) -> list[str]:
    """Same columns, different order: the export is a user-chosen projection."""
    return list(reversed(headers))


def write_working_workbook_variant(path: Path) -> Path:
    """The same workbook after Amazon added columns and somebody reordered them.

    Extra columns must be ignored and the order must not matter, so this file
    has to ingest to exactly the same lines as the plain one.
    """
    wb = Workbook()
    amazon = wb.active
    amazon.title = "Orders export"
    headers = _reorder(AMAZON_HEADERS + AMAZON_EXTRA_HEADERS)
    extras = {"Seller Name": "Example Seller", "Tax Exemption Applied": "No", "ASIN": "B00EXAMPLE"}
    amazon.append(headers)
    for row in AMAZON_ROWS:
        values = dict(zip(AMAZON_HEADERS, _amazon_row(row)))
        values.update(extras)
        amazon.append([values[h] for h in headers])

    preferred = wb.create_sheet("Preferred")
    pref_headers = _reorder(PREFERRED_HEADERS) + ["Sales Rep"]
    preferred.append(pref_headers)
    for row in PREFERRED_ROWS:
        values = dict(zip(PREFERRED_HEADERS, row))
        values["Sales Rep"] = "Example Rep"
        preferred.append([values[h] for h in pref_headers])
    wb.save(path)
    return path


# Shaped like the Amazon Refunds report: it carries Order Date, Order ID and
# Title like the Orders report, but the refund columns give it away. Invented
# from the documented column names, not from a real refunds file.
REFUNDS_HEADERS = [
    "Order Date",
    "Order ID",
    "Title",
    "Item Quantity",
    "Refund Date",
    "Refund Reason",
    "Refund Status",
    "Refund Amount",
]
REFUNDS_ROWS = [
    [dt.datetime(2025, 3, 2), "111-0000004-0000004", "BIC Round Stic Ballpoint Pens", 1,
     dt.datetime(2025, 3, 9), "Ordered by mistake", "Completed", 6.24],
]


def write_refunds(path: Path) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.title = "Refunds"
    ws.append(REFUNDS_HEADERS)
    for row in REFUNDS_ROWS:
        ws.append(row)
    wb.save(path)
    return path


def write_two_amazon_sheets(path: Path) -> Path:
    """Two Amazon exports in one workbook: there is no honest way to pick one."""
    wb = Workbook()
    first = wb.active
    first.title = "orders 2025"
    _amazon_sheet(first)
    _amazon_sheet(wb.create_sheet("orders 2025 (copy)"))
    wb.save(path)
    return path


def write_amazon_missing_column(path: Path) -> Path:
    """Everything except Purchase PPU, which the pipeline needs and must name."""
    wb = Workbook()
    ws = wb.active
    ws.title = "Orders"
    drop = AMAZON_HEADERS.index("Purchase PPU")
    headers = [h for i, h in enumerate(AMAZON_HEADERS) if i != drop]
    ws.append(headers)
    for row in AMAZON_ROWS:
        values = _amazon_row(row)
        ws.append([v for i, v in enumerate(values) if i != drop])
    wb.save(path)
    return path


def main() -> int:
    amazon = write_amazon(HERE / "amazon_2025_sample.xlsx")
    preferred = write_preferred(HERE / "preferred_2025_sample.xlsx")
    print(f"wrote {amazon} ({len(AMAZON_ROWS)} lines)")
    print(f"wrote {preferred} ({len(PREFERRED_ROWS)} lines)")
    for path in (
        write_working_workbook(HERE / "working_workbook_2025_sample.xlsx"),
        write_working_workbook_filtered(HERE / "working_workbook_filtered_2025_sample.xlsx"),
        write_working_workbook_variant(HERE / "working_workbook_variant_2025_sample.xlsx"),
        write_refunds(HERE / "amazon_refunds_sample.xlsx"),
        write_two_amazon_sheets(HERE / "two_amazon_sheets_sample.xlsx"),
        write_amazon_missing_column(HERE / "amazon_missing_column_sample.xlsx"),
    ):
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
