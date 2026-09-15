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


def main() -> int:
    amazon = write_amazon(HERE / "amazon_2025_sample.xlsx")
    preferred = write_preferred(HERE / "preferred_2025_sample.xlsx")
    print(f"wrote {amazon} ({len(AMAZON_ROWS)} lines)")
    print(f"wrote {preferred} ({len(PREFERRED_ROWS)} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
