"""Tests for supplytrack.prices: the vendor price template and loader."""
from __future__ import annotations

import csv
import sys
import types
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

import pytest


def _ensure_fallback_modules() -> None:
    """Stand in for errors.py / validate.py if they are not built yet.

    Another agent builds the rest of the ``supplytrack`` package
    concurrently. These tests only need ``SupplytrackError`` and
    ``Finding``; if the real modules are not there yet, register minimal
    stubs so ``import supplytrack.prices`` does not fail on an unrelated,
    still-being-written sibling module. Once the real modules land this
    function is a no-op (the ``try`` succeeds and nothing is stubbed).
    """
    try:
        import supplytrack.errors  # noqa: F401
    except ImportError:
        mod = types.ModuleType("supplytrack.errors")

        class SupplytrackError(Exception):
            pass

        mod.SupplytrackError = SupplytrackError
        sys.modules["supplytrack.errors"] = mod

    try:
        import supplytrack.validate  # noqa: F401
    except ImportError:
        mod = types.ModuleType("supplytrack.validate")

        @dataclass
        class Finding:
            level: str
            code: str
            message: str

        mod.Finding = Finding
        sys.modules["supplytrack.validate"] = mod


_ensure_fallback_modules()

from supplytrack.errors import SupplytrackError  # noqa: E402
from supplytrack.prices import (  # noqa: E402
    PRICES_HEADER,
    VENDORS,
    PriceCell,
    UpdateResult,
    check_prices,
    load_prices,
    update_prices,
    write_template,
)

RANKED_HEADER = [
    "rank", "canonical_name", "eaches", "packs", "units_per_pack", "unit_label",
    "keys", "sources", "last_paid_per_each", "upp_source",
]


def _write_ranked(data_dir: Path, year: int, rows: list[list]) -> None:
    year_dir = data_dir / str(year)
    year_dir.mkdir(parents=True, exist_ok=True)
    with (year_dir / "ranked.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(RANKED_HEADER)
        writer.writerows(rows)


def _write_prices(data_dir: Path, year: int, rows: list[list], header=PRICES_HEADER) -> Path:
    year_dir = data_dir / str(year)
    year_dir.mkdir(parents=True, exist_ok=True)
    path = year_dir / "prices.csv"
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        writer.writerows(rows)
    return path


THREE_ITEMS = [
    [1, "Copy Paper", 1000, 10, 100, "RM", "amz:copy-paper", "amazon", "4.10", "master"],
    [2, "Ballpoint Pens", 800, 8, 100, "EA", "pbs:PEN100", "preferred", "", "master"],
    [3, "Sticky Notes", 600, 6, 100, "EA", "amz:sticky-notes", "amazon", "0.09", "title"],
]


# --- write_template -----------------------------------------------------


def test_write_template_one_row_per_item_x_vendor_in_order(tmp_path):
    _write_ranked(tmp_path, 2025, THREE_ITEMS)

    out_path = write_template(tmp_path, 2025, top=2)

    assert out_path == tmp_path / "2025" / "prices.csv"
    with out_path.open(newline="", encoding="utf-8") as fh:
        rows = list(csv.reader(fh))

    assert rows[0] == PRICES_HEADER
    body = rows[1:]
    assert len(body) == 2 * len(VENDORS)

    # First 8 (canonical_name, vendor) pairs: item order from ranked.csv,
    # VENDORS order within each item.
    pairs = [(r[1], r[2]) for r in body]
    assert pairs == [
        ("Copy Paper", "Office Depot"),
        ("Copy Paper", "Preferred"),
        ("Copy Paper", "Amazon"),
        ("Copy Paper", "Staples"),
        ("Ballpoint Pens", "Office Depot"),
        ("Ballpoint Pens", "Preferred"),
        ("Ballpoint Pens", "Amazon"),
        ("Ballpoint Pens", "Staples"),
    ]

    # status prefilled priced, unit_price blank
    for row in body:
        assert row[4] == "unpriced"
        assert row[3] == ""

    # Amazon note carries last_paid_per_each as a reference; other vendors don't.
    amazon_row = next(r for r in body if r[1] == "Copy Paper" and r[2] == "Amazon")
    assert amazon_row[7] == "last paid per each: 4.10"
    non_amazon_row = next(r for r in body if r[1] == "Copy Paper" and r[2] == "Preferred")
    assert non_amazon_row[7] == ""
    # Ballpoint Pens has no last_paid_per_each -> no note even for Amazon.
    ballpoint_amazon = next(r for r in body if r[1] == "Ballpoint Pens" and r[2] == "Amazon")
    assert ballpoint_amazon[7] == ""


def test_write_template_refuses_to_overwrite_nonempty_file(tmp_path):
    _write_ranked(tmp_path, 2025, THREE_ITEMS)
    prices_path = tmp_path / "2025" / "prices.csv"
    prices_path.parent.mkdir(parents=True, exist_ok=True)
    prices_path.write_text("rank,canonical_name,vendor,unit_price,status,url,checked_on,note\n", encoding="utf-8")

    with pytest.raises(SupplytrackError):
        write_template(tmp_path, 2025, top=2)


def test_write_template_allows_overwrite_when_file_is_empty(tmp_path):
    _write_ranked(tmp_path, 2025, THREE_ITEMS)
    prices_path = tmp_path / "2025" / "prices.csv"
    prices_path.parent.mkdir(parents=True, exist_ok=True)
    prices_path.write_text("   \n", encoding="utf-8")  # whitespace-only counts as empty

    out_path = write_template(tmp_path, 2025, top=2)
    with out_path.open(newline="", encoding="utf-8") as fh:
        rows = list(csv.reader(fh))
    assert len(rows) == 1 + 2 * len(VENDORS)


# --- load_prices ---------------------------------------------------------


def _fully_priced_rows(items, prices_by_name_vendor=None):
    rows = []
    for item in items:
        rank, name = item[0], item[1]
        for vendor in VENDORS:
            price = (prices_by_name_vendor or {}).get((name, vendor), "1.00")
            rows.append([rank, name, vendor, price, "priced", "https://example.com", "2026-03-01", ""])
    return rows


def test_load_prices_success_preserves_decimal_precision_and_parses_dollar_and_commas(tmp_path):
    _write_ranked(tmp_path, 2025, THREE_ITEMS)
    prices = {
        ("Copy Paper", "Office Depot"): "$4.850",
        ("Copy Paper", "Preferred"): "4.10",
        ("Copy Paper", "Amazon"): "4.00",
        ("Copy Paper", "Staples"): "$1,050.00",
    }
    rows = _fully_priced_rows(THREE_ITEMS, prices)
    _write_prices(tmp_path, 2025, rows)

    cells = load_prices(tmp_path, 2025, top=3)

    assert isinstance(cells[("Copy Paper", "Office Depot")], PriceCell)
    assert str(cells[("Copy Paper", "Office Depot")].unit_price) == "4.850"
    assert cells[("Copy Paper", "Preferred")].unit_price == Decimal("4.10")
    assert cells[("Copy Paper", "Staples")].unit_price == Decimal("1050.00")
    assert str(cells[("Copy Paper", "Staples")].unit_price) == "1050.00"
    # every top-3 item x vendor present
    assert len(cells) == 3 * len(VENDORS)


def test_load_prices_raises_one_error_listing_every_defect(tmp_path):
    _write_ranked(tmp_path, 2025, THREE_ITEMS)
    rows = _fully_priced_rows(THREE_ITEMS)
    # Drop one item x vendor pair entirely (missing).
    rows = [r for r in rows if not (r[1] == "Sticky Notes" and r[2] == "Staples")]
    # Blank unit_price on a status='priced' row.
    for r in rows:
        if r[1] == "Ballpoint Pens" and r[2] == "Amazon":
            r[3] = ""
    # Unknown status.
    for r in rows:
        if r[1] == "Copy Paper" and r[2] == "Preferred":
            r[4] = "on_backorder"
    _write_prices(tmp_path, 2025, rows)

    with pytest.raises(SupplytrackError) as excinfo:
        load_prices(tmp_path, 2025, top=3)

    message = str(excinfo.value)
    assert "Sticky Notes" in message and "Staples" in message  # missing pair
    assert "Ballpoint Pens" in message and "Amazon" in message  # blank unit_price
    assert "on_backorder" in message  # unknown status


def test_load_prices_missing_row_points_at_update_not_template(tmp_path):
    _write_ranked(tmp_path, 2025, THREE_ITEMS)
    rows = _fully_priced_rows(THREE_ITEMS)
    rows = [r for r in rows if not (r[1] == "Sticky Notes" and r[2] == "Staples")]
    _write_prices(tmp_path, 2025, rows)

    with pytest.raises(SupplytrackError) as excinfo:
        load_prices(tmp_path, 2025, top=3)

    assert "supplytrack prices --year 2025 --update" in str(excinfo.value)


def test_load_prices_treats_unpriced_status_as_valid_with_none_price(tmp_path):
    _write_ranked(tmp_path, 2025, THREE_ITEMS)
    rows = _fully_priced_rows(THREE_ITEMS)
    for r in rows:
        if r[1] == "Sticky Notes" and r[2] == "Staples":
            r[3] = ""
            r[4] = "unpriced"
    _write_prices(tmp_path, 2025, rows)

    cells = load_prices(tmp_path, 2025, top=3)

    cell = cells[("Sticky Notes", "Staples")]
    assert cell.status == "unpriced"
    assert cell.unit_price is None
    # still every top-3 item x vendor present, no problem raised
    assert len(cells) == 3 * len(VENDORS)


# --- check_prices ----------------------------------------------------------


def test_check_prices_converts_incompleteness_into_fail_findings(tmp_path):
    _write_ranked(tmp_path, 2025, THREE_ITEMS)
    rows = _fully_priced_rows(THREE_ITEMS)
    rows = [r for r in rows if not (r[1] == "Sticky Notes" and r[2] == "Staples")]
    _write_prices(tmp_path, 2025, rows)

    findings = check_prices(tmp_path, 2025, top=3)

    assert findings, "expected at least one finding"
    assert all(f.level == "fail" for f in findings)
    assert all(f.code == "PRICES_INCOMPLETE" for f in findings)
    assert any("Sticky Notes" in f.message and "Staples" in f.message for f in findings)


def test_check_prices_warns_on_vendor_coverage_when_otherwise_complete(tmp_path):
    _write_ranked(tmp_path, 2025, THREE_ITEMS)
    rows = _fully_priced_rows(THREE_ITEMS)
    # Every item x vendor is present and valid (so no fail findings), but
    # Staples is "not_available" for two of the three items - fewer priced
    # items than the other vendors.
    for r in rows:
        if r[2] == "Staples" and r[1] in ("Ballpoint Pens", "Sticky Notes"):
            r[3] = ""
            r[4] = "not_available"
    _write_prices(tmp_path, 2025, rows)

    findings = check_prices(tmp_path, 2025, top=3)

    assert not any(f.level == "fail" for f in findings)
    warn_findings = [f for f in findings if f.level == "warn"]
    assert any(f.code == "VENDOR_COVERAGE" and "Staples" in f.message for f in warn_findings)


def test_check_prices_warns_on_unpriced_items(tmp_path):
    _write_ranked(tmp_path, 2025, THREE_ITEMS)
    rows = _fully_priced_rows(THREE_ITEMS)
    for r in rows:
        if r[1] == "Sticky Notes" and r[2] == "Staples":
            r[3] = ""
            r[4] = "unpriced"
    _write_prices(tmp_path, 2025, rows)

    findings = check_prices(tmp_path, 2025, top=3)

    assert not any(f.level == "fail" for f in findings)
    unpriced_findings = [f for f in findings if f.code == "PRICES_UNPRICED"]
    assert len(unpriced_findings) == 1
    assert unpriced_findings[0].level == "warn"
    assert "Sticky Notes" in unpriced_findings[0].message
    assert "Staples" in unpriced_findings[0].message
    assert "1 item" in unpriced_findings[0].message


# --- update_prices -----------------------------------------------------


UPDATE_RANKED_ITEMS = [
    [1, "Ballpoint Pens", 4800, 40, 120, "EA", "amz:pens", "amazon", "0.18", "master"],
    [2, "Notebook Wide Ruled", 4000, 40, 100, "EA", "amz:notebook", "amazon", "1.05", "master"],
    [3, "Copy Paper", 3600, 36, 100, "RM", "amz:copy-paper", "amazon", "4.10", "master"],
    [4, "Sticky Notes", 3000, 30, 100, "EA", "amz:sticky-notes", "amazon", "0.09", "title"],
]


def _typed_prices_rows():
    """The prices.csv the office manager typed before the review reshuffled the ranking:
    Copy Paper was rank 1, Ballpoint Pens rank 2, Sticky Notes rank 3."""
    rows = []
    for old_rank, name in [(1, "Copy Paper"), (2, "Ballpoint Pens"), (3, "Sticky Notes")]:
        for vendor in VENDORS:
            rows.append(
                [old_rank, name, vendor, "1.00", "priced", "https://example.com", "2026-03-01", ""]
            )
    return rows


def test_update_prices_keeps_adds_and_retires(tmp_path):
    _write_ranked(tmp_path, 2025, UPDATE_RANKED_ITEMS)
    _write_prices(tmp_path, 2025, _typed_prices_rows())

    result = update_prices(tmp_path, 2025, top=3)

    assert isinstance(result, UpdateResult)
    assert result.kept == 2 * len(VENDORS)  # Ballpoint Pens + Copy Paper
    assert result.added == 1 * len(VENDORS)  # Notebook Wide Ruled, new to the top 3
    assert result.retired == 1 * len(VENDORS)  # Sticky Notes, dropped to rank 4

    with (tmp_path / "2025" / "prices.csv").open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) == 3 * len(VENDORS)

    names_in_order = []
    for row in rows:
        if row["canonical_name"] not in names_in_order:
            names_in_order.append(row["canonical_name"])
    assert names_in_order == ["Ballpoint Pens", "Notebook Wide Ruled", "Copy Paper"]

    # kept rows: rank refreshed, everything else verbatim
    ballpoint = [r for r in rows if r["canonical_name"] == "Ballpoint Pens"]
    assert all(r["rank"] == "1" for r in ballpoint)
    assert all(r["unit_price"] == "1.00" and r["status"] == "priced" for r in ballpoint)
    assert all(r["checked_on"] == "2026-03-01" for r in ballpoint)

    copy_paper = [r for r in rows if r["canonical_name"] == "Copy Paper"]
    assert all(r["rank"] == "3" for r in copy_paper)
    assert all(r["unit_price"] == "1.00" and r["status"] == "priced" for r in copy_paper)

    # added rows: unpriced, Amazon carries the reference note
    notebook = {r["vendor"]: r for r in rows if r["canonical_name"] == "Notebook Wide Ruled"}
    assert all(r["status"] == "unpriced" and r["unit_price"] == "" for r in notebook.values())
    assert all(r["rank"] == "2" for r in notebook.values())
    assert notebook["Amazon"]["note"] == "last paid per each: 1.05"
    assert notebook["Office Depot"]["note"] == ""

    # retired rows: moved unchanged, including their old rank
    retired_path = tmp_path / "2025" / "prices_retired.csv"
    with retired_path.open(newline="", encoding="utf-8") as fh:
        retired_rows = list(csv.DictReader(fh))
    assert len(retired_rows) == 1 * len(VENDORS)
    assert all(r["canonical_name"] == "Sticky Notes" for r in retired_rows)
    assert all(r["rank"] == "3" for r in retired_rows)  # old rank, not renumbered
    assert all(r["unit_price"] == "1.00" and r["status"] == "priced" for r in retired_rows)


def test_update_prices_retires_an_unreused_row_instead_of_dropping_it(tmp_path):
    """A row that matches no exact (canonical_name, vendor) in VENDORS - a typo'd
    vendor spelling, or a stray duplicate - must never simply vanish: it is
    retired like any other row nobody reused, even though its item's name is
    still in the top N."""
    _write_ranked(tmp_path, 2025, UPDATE_RANKED_ITEMS)
    rows = _typed_prices_rows()
    rows.append(
        [2, "Ballpoint Pens", "Stapels", "0.24", "priced", "", "2026-03-01", ""]
    )  # misspelled vendor - not in VENDORS
    _write_prices(tmp_path, 2025, rows)

    result = update_prices(tmp_path, 2025, top=3)

    assert result.retired == 1 * len(VENDORS) + 1  # Sticky Notes' 4, plus the typo'd row

    retired_path = tmp_path / "2025" / "prices_retired.csv"
    with retired_path.open(newline="", encoding="utf-8") as fh:
        retired_rows = list(csv.DictReader(fh))
    assert any(
        r["canonical_name"] == "Ballpoint Pens" and r["vendor"] == "Stapels" for r in retired_rows
    )
    # and it is not duplicated into the rewritten prices.csv either
    with (tmp_path / "2025" / "prices.csv").open(newline="", encoding="utf-8") as fh:
        prices_rows = list(csv.DictReader(fh))
    assert not any(r["vendor"] == "Stapels" for r in prices_rows)


def test_update_prices_appends_to_an_existing_retired_file(tmp_path):
    _write_ranked(tmp_path, 2025, UPDATE_RANKED_ITEMS)
    _write_prices(tmp_path, 2025, _typed_prices_rows())
    retired_path = tmp_path / "2025" / "prices_retired.csv"
    with retired_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(PRICES_HEADER)
        writer.writerow([9, "Old Item", "Amazon", "2.00", "priced", "", "2025-01-01", ""])

    update_prices(tmp_path, 2025, top=3)

    with retired_path.open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    # the pre-existing retired row is still there, plus Sticky Notes's 4
    assert len(rows) == 1 + 1 * len(VENDORS)
    assert rows[0]["canonical_name"] == "Old Item"


def test_update_prices_is_idempotent(tmp_path):
    _write_ranked(tmp_path, 2025, UPDATE_RANKED_ITEMS)
    _write_prices(tmp_path, 2025, _typed_prices_rows())

    update_prices(tmp_path, 2025, top=3)
    prices_path = tmp_path / "2025" / "prices.csv"
    first_pass = prices_path.read_text(encoding="utf-8")

    result = update_prices(tmp_path, 2025, top=3)
    second_pass = prices_path.read_text(encoding="utf-8")

    assert first_pass == second_pass
    assert result.kept == 3 * len(VENDORS)
    assert result.added == 0
    assert result.retired == 0

    # the second run does not touch the retired file again
    retired_path = tmp_path / "2025" / "prices_retired.csv"
    with retired_path.open(newline="", encoding="utf-8") as fh:
        retired_rows = list(csv.DictReader(fh))
    assert len(retired_rows) == 1 * len(VENDORS)


def test_update_prices_behaves_like_template_when_prices_csv_is_missing(tmp_path):
    _write_ranked(tmp_path, 2025, UPDATE_RANKED_ITEMS)

    result = update_prices(tmp_path, 2025, top=3)

    assert result.kept == 0
    assert result.added == 3 * len(VENDORS)
    assert result.retired == 0
    with (tmp_path / "2025" / "prices.csv").open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) == 3 * len(VENDORS)
    assert not (tmp_path / "2025" / "prices_retired.csv").exists()


def test_update_prices_behaves_like_template_when_prices_csv_is_empty(tmp_path):
    _write_ranked(tmp_path, 2025, UPDATE_RANKED_ITEMS)
    prices_path = tmp_path / "2025" / "prices.csv"
    prices_path.parent.mkdir(parents=True, exist_ok=True)
    prices_path.write_text("  \n", encoding="utf-8")

    result = update_prices(tmp_path, 2025, top=3)

    assert result.kept == 0
    assert result.added == 3 * len(VENDORS)
    assert result.retired == 0
