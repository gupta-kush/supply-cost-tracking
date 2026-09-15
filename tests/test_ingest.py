"""Ingest: both exports in, one line file out, and nothing lost on the way."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from openpyxl import Workbook

from conftest import YEAR, read_csv, read_header
from supplytrack.errors import SupplytrackError
from supplytrack.ingest import (
    LINES_COLUMNS,
    amazon_key,
    ingest,
    load_lines,
    normalise_title,
    preferred_key,
)


def test_lines_file_has_the_agreed_columns_in_order(ingested):
    assert read_header(ingested / str(YEAR) / "lines.csv") == LINES_COLUMNS


def test_every_line_read_is_a_line_written(ingested):
    rows = read_csv(ingested / str(YEAR) / "lines.csv")
    assert len(rows) == 17  # 12 Amazon lines plus 5 Preferred
    run = json.loads((ingested / str(YEAR) / "run.json").read_text(encoding="utf-8"))
    assert run["amazon_rows"] == 12
    assert run["preferred_rows"] == 5
    assert run["rows_written"] == len(rows)


def test_run_json_records_the_files_and_the_date_range(ingested):
    run = json.loads((ingested / str(YEAR) / "run.json").read_text(encoding="utf-8"))
    assert run["year"] == YEAR
    assert run["amazon_file"] == "amazon_2025_sample.xlsx"
    assert run["preferred_file"] == "preferred_2025_sample.xlsx"
    assert run["date_min"] == "2024-12-28"
    assert run["date_max"] == "2025-11-06"
    assert run["ingested_at"]


def test_headers_match_despite_stray_spaces(ingested):
    """The export carries a trailing space and a double space in its headers."""
    rows = read_csv(ingested / str(YEAR) / "lines.csv")
    categories = {row["amazon_category"] for row in rows if row["source"] == "amazon"}
    assert "Office Product" in categories  # read through 'Amazon-Internal  Product Category'


def test_a_text_date_is_read_as_a_date(ingested):
    rows = read_csv(ingested / str(YEAR) / "lines.csv")
    paper = [r for r in rows if "Hammermill" in r["raw_title"]][0]
    assert paper["order_date"] == "2025-03-04"


def test_amazon_line_maps_onto_the_normalised_row(ingested):
    rows = read_csv(ingested / str(YEAR) / "lines.csv")
    expo = [r for r in rows if r["raw_title"].startswith("EXPO")][0]
    assert expo["source"] == "amazon"
    assert expo["key"] == amazon_key(expo["raw_title"])
    assert expo["sku"] == ""
    assert expo["pack_desc"] == ""
    assert expo["packs"] == "2"
    assert expo["ppu_paid"] == "39.99"
    assert expo["account_user"] == "Office Manager"


def test_preferred_line_maps_onto_the_normalised_row(ingested):
    rows = read_csv(ingested / str(YEAR) / "lines.csv")
    clips = [r for r in rows if r["sku"] == "UNV35668"][0]
    assert clips["source"] == "preferred"
    assert clips["key"] == "pbs:UNV35668"
    assert clips["pack_desc"] == "BX100"
    assert clips["packs"] == "3"
    assert clips["ppu_paid"] == ""  # Preferred quotes no prices
    assert clips["line_subtotal"] == ""
    assert clips["order_id"] == "REF-1002"


def test_lines_outside_the_year_are_kept_and_reported(data_dir, amazon_export, preferred_export):
    result = ingest(data_dir, YEAR, amazon_export, preferred_export)
    rows = read_csv(data_dir / str(YEAR) / "lines.csv")
    assert any(row["order_date"].startswith("2024-") for row in rows)
    assert any("dated outside 2025" in w for w in result.warnings)
    assert [d["order_date"] for d in result.dates_out_of_year] == ["2024-12-28"]


def test_an_order_that_is_not_closed_is_kept_and_reported(data_dir, amazon_export):
    result = ingest(data_dir, YEAR, amazon_export, None)
    assert [d["status"] for d in result.non_closed] == ["Cancelled"]
    assert any("other than Closed" in w for w in result.warnings)
    assert result.preferred_rows == 0
    assert result.preferred_file == ""


def test_a_missing_column_is_named_rather_than_crashing(tmp_path, data_dir):
    wb = Workbook()
    ws = wb.active
    ws.append(["Order Date", "Title", "Item Quantity"])
    ws.append(["2025-01-01", "Something", 1])
    path = tmp_path / "wrong_export.xlsx"
    wb.save(path)

    with pytest.raises(SupplytrackError) as excinfo:
        ingest(data_dir, YEAR, path, None)
    message = str(excinfo.value)
    assert "wrong_export.xlsx" in message
    assert "order id" in message  # the missing columns are listed by name


def test_keys_are_stable_across_spelling_and_spacing():
    assert normalise_title("  Post-it  Notes, 3x3  ") == "post-it notes 3x3"
    assert amazon_key("Sharpie® Markers, 12 Count") == amazon_key("SHARPIE  Markers  12 Count")
    assert preferred_key(" unv21200 ") == "pbs:UNV21200"


def test_load_lines_returns_packs_as_a_number(ingested):
    rows = load_lines(ingested, YEAR)
    assert all(isinstance(row["packs"], int) for row in rows)
    assert sum(row["packs"] for row in rows) == 58


def test_reading_a_year_that_was_never_ingested_says_so(data_dir):
    with pytest.raises(SupplytrackError) as excinfo:
        load_lines(data_dir, 1999)
    assert "ingest" in str(excinfo.value)


def test_a_csv_export_reads_the_same_as_the_xlsx(tmp_path, data_dir, amazon_export):
    """Amazon can be exported either way and the result must not differ."""
    from supplytrack.xlsx import read_table

    headers, rows = read_table(amazon_export)
    csv_path = tmp_path / "amazon.csv"
    import csv as _csv

    with csv_path.open("w", encoding="utf-8", newline="") as fh:
        writer = _csv.writer(fh)
        writer.writerow(headers)
        for row in rows:
            writer.writerow(["" if c is None else c for c in row])

    from_csv = ingest(data_dir, YEAR, csv_path, None)
    assert from_csv.amazon_rows == 12
    keys = {row["key"] for row in read_csv(Path(data_dir) / str(YEAR) / "lines.csv")}
    assert amazon_key("EXPO Low-Odor Dry Erase Markers, Chisel Tip, Assorted, 48/Pack") in keys
