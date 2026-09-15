"""Builds the leadership workbook: the Top N comparison plus supporting sheets.

Mirrors the 2025 deliverable's Top N page (``docs/spec.md`` section 4.5) with
three deliberate differences: total-cost cells are formulas instead of typed
numbers, the row-minimum highlight is a real conditional-formatting rule
instead of hand fill, and a Comparable-basket row totals only the items every
vendor could price. ``All items``, ``Excluded`` and ``Sources`` make the
reasoning one click away.
"""
from __future__ import annotations

import csv
import json
from datetime import datetime, timezone
from pathlib import Path

import openpyxl
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.workbook import Workbook

# The firm's workbooks (including the 2025 FINAL in inbox/) carry
# ``<font family="34">``, past what openpyxl's default validation allows.
# Widen it once, at import time of this module, so anything that reads a
# workbook afterwards - a later ``load_workbook`` call, including in tests -
# tolerates it too.
openpyxl.styles.fonts.Font.family.max = 99

from .errors import SupplytrackError
from .prices import VENDORS, load_prices

PRICE_FORMAT = "$#,##0.00"
QTY_FORMAT = "#,##0"

STATUS_TEXT = {
    "not_available": "not available",
    "discontinued": "Discontinued",
    "unpriced": "not priced",
}

# Light, distinct fills per vendor, reused for the header cell in both the
# unit-price band (F..I) and the total-cost band (K..N).
VENDOR_HEADER_FILLS = {
    "Office Depot": PatternFill(fill_type="solid", fgColor="DDEBF7"),
    "Preferred": PatternFill(fill_type="solid", fgColor="E2EFDA"),
    "Amazon": PatternFill(fill_type="solid", fgColor="FCE4D6"),
    "Staples": PatternFill(fill_type="solid", fgColor="E4DFEC"),
}

LEGEND_COLOR = "FFF2CC"
# Ordinary cell fill (legend cell, column-J divider): solid fill paints with
# the foreground color.
LEGEND_CELL_FILL = PatternFill(fill_type="solid", fgColor=LEGEND_COLOR)
# Conditional-formatting (dxf) fill: Excel's differential-style fill paints
# a solid fill from the *background* color, not the foreground - using
# fgColor here would add a rule that never visibly highlights anything.
CF_HIGHLIGHT_FILL = PatternFill(fill_type="solid", bgColor=LEGEND_COLOR)

TITLE_FONT = Font(bold=True, size=14)
BOLD = Font(bold=True)

PRICE_COLS = ["F", "G", "H", "I"]
TOTAL_COLS = ["K", "L", "M", "N"]


def build_report(data_dir: Path, out_dir: Path, year: int, top: int) -> Path:
    """Write ``out_dir / f"Acme Widget Top {top} Items Comparison {year}.xlsx"`` and return its path."""
    data_dir = Path(data_dir)
    out_dir = Path(out_dir)
    year_dir = data_dir / str(year)

    ranked_rows = _read_csv_rows(year_dir / "ranked.csv")
    if ranked_rows is None:
        raise SupplytrackError(
            f"{year_dir / 'ranked.csv'} not found. Run `supplytrack rank --year {year}` first."
        )
    top_rows = sorted(ranked_rows, key=lambda r: int(r["rank"]))[:top]

    excluded_rows = _read_csv_rows(year_dir / "excluded.csv")
    run_info = _read_json(year_dir / "run.json")
    master_row_count = _count_master_rows(data_dir / "item_master.csv")

    prices = load_prices(data_dir, year, top)

    wb = Workbook()
    wb.remove(wb.active)

    _build_top_sheet(wb, top_rows, prices, year, top)
    _build_table_sheet(wb, "All items", ranked_rows)
    if excluded_rows is not None:
        _build_table_sheet(wb, "Excluded", excluded_rows)
    unpriced_count = sum(1 for cell in prices.values() if cell.status == "unpriced")
    _build_sources_sheet(wb, run_info, master_row_count, ranked_rows, top, unpriced_count)

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"Acme Widget Top {top} Items Comparison {year}.xlsx"
    wb.save(out_path)
    return out_path


def _read_csv_rows(path: Path) -> list[dict[str, str]] | None:
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _count_master_rows(path: Path) -> int | None:
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return sum(1 for _ in csv.DictReader(fh))


def _build_top_sheet(wb, top_rows: list[dict[str, str]], prices, year: int, top: int):
    ws = wb.create_sheet(f"Top {top}")
    first = 7
    last = 6 + top

    ws.merge_cells("B4:N4")
    ws["B4"] = f"Top {top} Items By Quantity"
    ws["B4"].font = TITLE_FONT

    ws.merge_cells("F5:I5")
    ws["F5"] = "Unit Price (per each)"
    ws.merge_cells("K5:N5")
    ws["K5"] = f"Total Cost at {year} volume"

    ws["B6"] = "Ranking"
    ws["C6"] = "Description"
    ws["D6"] = "Pack/Size"
    ws["E6"] = "Quantity"
    for col in ("B", "C", "D", "E"):
        ws[f"{col}6"].font = BOLD
    for col, vendor in zip(PRICE_COLS, VENDORS):
        cell = ws[f"{col}6"]
        cell.value = vendor
        cell.font = BOLD
        cell.fill = VENDOR_HEADER_FILLS[vendor]
    for col, vendor in zip(TOTAL_COLS, VENDORS):
        cell = ws[f"{col}6"]
        cell.value = vendor
        cell.font = BOLD
        cell.fill = VENDOR_HEADER_FILLS[vendor]

    for offset, row in enumerate(top_rows):
        r = first + offset
        canonical_name = row["canonical_name"]
        unit_label = (row.get("unit_label") or "").strip()

        ws[f"B{r}"] = int(row["rank"])
        c_cell = ws[f"C{r}"]
        c_cell.value = canonical_name
        c_cell.alignment = Alignment(wrap_text=True)
        ws[f"D{r}"] = f"1 {unit_label}" if unit_label else "1"
        e_cell = ws[f"E{r}"]
        e_cell.value = int(row["eaches"])
        e_cell.number_format = QTY_FORMAT

        for price_col, total_col, vendor in zip(PRICE_COLS, TOTAL_COLS, VENDORS):
            price_cell = ws[f"{price_col}{r}"]
            total_cell = ws[f"{total_col}{r}"]
            cell_data = prices.get((canonical_name, vendor))
            if cell_data is not None and cell_data.status == "priced" and cell_data.unit_price is not None:
                price_cell.value = float(cell_data.unit_price)
                price_cell.number_format = PRICE_FORMAT
                total_cell.value = f"={price_col}{r}*E{r}"
                total_cell.number_format = PRICE_FORMAT
            else:
                status = cell_data.status if cell_data is not None else "not_available"
                text = STATUS_TEXT.get(status, status)
                price_cell.value = text
                total_cell.value = text

    # Column J is a visual divider between the unit-price and total-cost
    # bands, for the header row and every data row.
    for r in range(6, last + 1):
        ws[f"J{r}"].fill = LEGEND_CELL_FILL

    label_row = last + 1
    totals_row = last + 2
    priced_row = last + 3
    basket_row = last + 4

    for col, vendor in zip(TOTAL_COLS, VENDORS):
        cell = ws[f"{col}{label_row}"]
        cell.value = f"{vendor} Total Cost"
        cell.font = BOLD

    ws[f"C{totals_row}"] = "Total Cost"
    ws[f"C{totals_row}"].font = BOLD
    for col in TOTAL_COLS:
        cell = ws[f"{col}{totals_row}"]
        cell.value = f"=SUM({col}{first}:{col}{last})"
        cell.number_format = PRICE_FORMAT

    ws[f"C{priced_row}"] = "Priced items"
    ws[f"C{priced_row}"].font = BOLD
    for col in PRICE_COLS:
        ws[f"{col}{priced_row}"] = f'=COUNT({col}{first}:{col}{last})&" / {top}"'

    qualifying_rows = [
        first + offset
        for offset, row in enumerate(top_rows)
        if all(
            (cell_data := prices.get((row["canonical_name"], vendor))) is not None
            and cell_data.status == "priced"
            and cell_data.unit_price is not None
            for vendor in VENDORS
        )
    ]

    ws[f"C{basket_row}"] = "Comparable basket"
    ws[f"C{basket_row}"].font = BOLD
    for col in TOTAL_COLS:
        cell = ws[f"{col}{basket_row}"]
        if qualifying_rows:
            cell.value = "=SUM(" + ",".join(f"{col}{r}" for r in qualifying_rows) + ")"
        else:
            cell.value = 0
        cell.number_format = PRICE_FORMAT

    legend_row = basket_row + 2
    ws[f"B{legend_row}"] = "Lowest price for row item"
    ws[f"B{legend_row}"].fill = LEGEND_CELL_FILL

    ws.conditional_formatting.add(
        f"F{first}:I{last}",
        FormulaRule(
            formula=[f"AND(ISNUMBER(F{first}),F{first}=MIN($F{first}:$I{first}))"],
            fill=CF_HIGHLIGHT_FILL,
        ),
    )
    ws.conditional_formatting.add(
        f"K{first}:N{last}",
        FormulaRule(
            formula=[f"AND(ISNUMBER(K{first}),K{first}=MIN($K{first}:$N{first}))"],
            fill=CF_HIGHLIGHT_FILL,
        ),
    )

    ws.column_dimensions["B"].width = 9
    ws.column_dimensions["C"].width = 60
    ws.column_dimensions["D"].width = 10
    ws.column_dimensions["E"].width = 11
    for col in PRICE_COLS:
        ws.column_dimensions[col].width = 13
    ws.column_dimensions["J"].width = 2
    for col in TOTAL_COLS:
        ws.column_dimensions[col].width = 15
    ws.column_dimensions["C"].alignment = Alignment(wrap_text=True)

    ws.freeze_panes = "C7"
    return ws


def _build_table_sheet(wb, name: str, rows: list[dict[str, str]]):
    ws = wb.create_sheet(name)
    headers = list(rows[0].keys()) if rows else []
    for col_idx, header in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx, value=header)
        cell.font = BOLD
    for row_idx, row in enumerate(rows, start=2):
        for col_idx, header in enumerate(headers, start=1):
            ws.cell(row=row_idx, column=col_idx, value=row.get(header, ""))
    if headers:
        last_col = get_column_letter(len(headers))
        last_row = len(rows) + 1
        ws.auto_filter.ref = f"A1:{last_col}{last_row}"
    ws.freeze_panes = "A2"
    return ws


def _build_sources_sheet(
    wb,
    run_info: dict,
    master_row_count: int | None,
    ranked_rows: list[dict[str, str]],
    top: int,
    unpriced_count: int = 0,
):
    ws = wb.create_sheet("Sources")
    r = 1

    def write_pair(key, value):
        nonlocal r
        ws.cell(row=r, column=1, value=key)
        ws.cell(row=r, column=2, value=value)
        r += 1

    for key, value in run_info.items():
        if isinstance(value, list):
            value = "; ".join(str(v) for v in value)
        write_pair(key, value)

    write_pair("item master rows", master_row_count if master_row_count is not None else "")

    non_master = [
        row["canonical_name"] for row in ranked_rows if (row.get("upp_source") or "") != "master"
    ]
    write_pair("items with upp_source != master", "; ".join(non_master))

    write_pair("top_n", top)
    write_pair("unpriced cells", unpriced_count)
    write_pair("report built at", datetime.now(timezone.utc).isoformat())

    ws.column_dimensions["A"].width = 32
    ws.column_dimensions["B"].width = 70
    return ws
