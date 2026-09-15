"""The one-workbook round trip: the report carries the data files forward.

The office manager keeps one workbook per year. Before this, the item master
and the price sheet lived only as CSV files on whichever machine last ran the
tool, so a year later they were gone and every pack size was asked again. The
report workbook now carries all three files on sheets of its own, the sheet
classifier recognises them wherever they turn up, and ``import-report`` writes
them back out.

The test that matters most here is the byte-for-byte one: a CSV written into
the workbook and read back out has to be the same file, not merely the same
values. Excel widens a number on the way through, and a spelling that changes
(``1.250`` becoming ``1.25``, ``12`` becoming ``12.0``) is a silent edit to a
file somebody hand-maintains.
"""
from __future__ import annotations

import csv
import shutil
from pathlib import Path

import pytest
from openpyxl import load_workbook

from supplytrack.cli import main
from supplytrack.errors import SupplytrackError
from supplytrack.ingest import CARRY_LABELS, classify_exports
from supplytrack.master import MASTER_COLUMNS
from supplytrack.prices import PRICES_HEADER
from supplytrack.report import build_report, carry_forward, import_report

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "report"
EXPORT_FIXTURES = Path(__file__).resolve().parent / "fixtures"


# Deliberately awkward values, each one a way a round trip can quietly rewrite
# a file: a blank pack size, a pack size that must not come back as "12.0", a
# leading-zero string that int() would eat, a note holding a comma and a quote,
# and the Excel formula wrapper Amazon writes identifiers as - which openpyxl
# reads back as an empty formula cell unless the writer forces the cell to text.
MASTER_ROWS = [
    {
        "key": "amz:copy paper 8.5x11 white",
        "source": "amazon",
        "raw_title": "Copy Paper, 8.5 x 11, White",
        "include": "y",
        "canonical_name": "Copy Paper 8.5x11 White",
        "units_per_pack": "480",
        "unit_label": "RM",
        "upp_source": "master",
        "amazon_category": "Office Product",
        "first_seen": "2024",
        "last_seen": "2025",
        "note": 'title says 500, the case ships 480; "checked twice"',
    },
    {
        "key": "amz:bubly sparkling water",
        "source": "amazon",
        "raw_title": "Bubly Sparkling Water, Variety Pack",
        "include": "n",
        "canonical_name": "Bubly Sparkling Water",
        "units_per_pack": "",
        "unit_label": "",
        "upp_source": "",
        "amazon_category": "Grocery",
        "first_seen": "2025",
        "last_seen": "2025",
        "note": "excluded: not an office supply",
    },
    {
        "key": "pbs:UNV21200",
        "source": "preferred",
        "raw_title": "File Folders Letter Manila",
        "include": "y",
        "canonical_name": "File Folders Letter Manila",
        "units_per_pack": "100",
        "unit_label": "EA",
        "upp_source": "2025-workbook",
        "amazon_category": "",
        "first_seen": "2025",
        "last_seen": "2025",
        "note": '="0007" is the card, and 007 is not seven',
    },
    {
        "key": "amz:sticky notes neon 3x3",
        "source": "amazon",
        "raw_title": "Sticky Notes Neon 3x3",
        "include": "y",
        "canonical_name": "Sticky Notes Neon",
        "units_per_pack": "12",
        "unit_label": "EA",
        "upp_source": "master",
        "amazon_category": "Office Product",
        "first_seen": "2025",
        "last_seen": "2025",
        "note": "",
    },
]

RETIRED_ROWS = [
    {
        "rank": "26",
        "canonical_name": "Rubber Bands Assorted Size",
        "vendor": "Office Depot",
        "unit_price": "1.250",
        "status": "priced",
        "url": "https://example.com/rubber-bands",
        "checked_on": "2026-04-01",
        "note": "dropped out of the top 25 after the review",
    },
    {
        "rank": "27",
        "canonical_name": "Binder Clips Medium",
        "vendor": "Staples",
        "unit_price": "",
        "status": "unpriced",
        "url": "",
        "checked_on": "",
        "note": "",
    },
]


def _write_csv(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


@pytest.fixture
def data_dir(tmp_path) -> Path:
    """A data directory holding all three carry files plus what report needs."""
    data_dir = tmp_path / "data"
    year_dir = data_dir / "2025"
    year_dir.mkdir(parents=True)
    shutil.copy(FIXTURES / "ranked.csv", year_dir / "ranked.csv")
    shutil.copy(FIXTURES / "prices.csv", year_dir / "prices.csv")
    _write_csv(data_dir / "item_master.csv", MASTER_COLUMNS, MASTER_ROWS)
    _write_csv(year_dir / "prices_retired.csv", PRICES_HEADER, RETIRED_ROWS)
    return data_dir


@pytest.fixture
def report_path(data_dir, tmp_path) -> Path:
    return build_report(data_dir, tmp_path / "out", 2025, 25)


# --- the three sheets the report grew --------------------------------------


def test_report_carries_the_three_data_sheets(report_path):
    wb = load_workbook(report_path, data_only=False)
    assert wb.sheetnames == [
        "Top 25",
        "All items",
        "Sources",
        "Item master",
        "Prices",
        "Prices retired",
    ]

    master = wb["Item master"]
    assert [c.value for c in master[1]] == MASTER_COLUMNS
    assert master.freeze_panes == "A2"
    assert master.max_row == len(MASTER_ROWS) + 1
    assert master.column_dimensions["A"].width == 34

    prices = wb["Prices"]
    assert [c.value for c in prices[1]] == PRICES_HEADER

    retired = wb["Prices retired"]
    assert [c.value for c in retired[1]] == PRICES_HEADER
    assert retired.max_row == len(RETIRED_ROWS) + 1


def test_prices_retired_sheet_exists_even_with_no_retired_rows(tmp_path):
    data_dir = tmp_path / "data"
    year_dir = data_dir / "2025"
    year_dir.mkdir(parents=True)
    shutil.copy(FIXTURES / "ranked.csv", year_dir / "ranked.csv")
    shutil.copy(FIXTURES / "prices.csv", year_dir / "prices.csv")

    wb = load_workbook(build_report(data_dir, tmp_path / "out", 2025, 25))
    assert "Prices retired" in wb.sheetnames
    ws = wb["Prices retired"]
    assert [c.value for c in ws[1]] == PRICES_HEADER
    assert ws.max_row == 1  # the header and nothing else


def test_cell_typing_keeps_numbers_numeric_and_everything_else_text(report_path):
    wb = load_workbook(report_path, data_only=False)
    master = wb["Item master"]
    upp = MASTER_COLUMNS.index("units_per_pack") + 1
    assert master.cell(row=2, column=upp).value == 480  # a number, not "480"
    assert master.cell(row=3, column=upp).value is None  # blank stays blank

    note = MASTER_COLUMNS.index("note") + 1
    # A note starting with "=" must stay text; as a formula it would read back
    # as None and the value would be gone.
    assert master.cell(row=4, column=note).data_type == "s"
    assert master.cell(row=4, column=note).value.startswith('="0007"')

    retired = wb["Prices retired"]
    rank = PRICES_HEADER.index("rank") + 1
    price = PRICES_HEADER.index("unit_price") + 1
    checked = PRICES_HEADER.index("checked_on") + 1
    assert retired.cell(row=2, column=rank).value == 26
    assert retired.cell(row=2, column=price).value == "1.250"  # text, not 1.25
    assert retired.cell(row=2, column=checked).value == "2026-04-01"  # text, not a date


# --- the round trip ---------------------------------------------------------


def test_round_trip_is_byte_identical(data_dir, report_path, tmp_path):
    out = tmp_path / "extracted"
    written, missing = import_report(out, 2025, report_path)

    assert missing == []
    assert {label for _, _, label in written} == set(CARRY_LABELS.values())

    for relative in ("item_master.csv", "2025/prices.csv", "2025/prices_retired.csv"):
        assert (out / relative).read_bytes() == (data_dir / relative).read_bytes(), relative


def test_import_report_reports_row_counts(data_dir, report_path, tmp_path):
    written, _ = import_report(tmp_path / "extracted", 2025, report_path)
    counts = {label: rows for _, rows, label in written}
    assert counts["Item master"] == len(MASTER_ROWS)
    assert counts["Prices retired"] == len(RETIRED_ROWS)


def test_import_report_refuses_to_overwrite(data_dir, report_path, tmp_path):
    out = tmp_path / "extracted"
    (out / "2025").mkdir(parents=True)
    (out / "item_master.csv").write_text("key,source\nhand written,\n", encoding="utf-8")

    with pytest.raises(SupplytrackError) as exc:
        import_report(out, 2025, report_path)
    assert "item_master.csv" in str(exc.value)
    # Nothing was written, not even the files that had no clash.
    assert not (out / "2025" / "prices.csv").exists()
    assert (out / "item_master.csv").read_text(encoding="utf-8").startswith("key,source")


def test_import_report_force_overwrites(data_dir, report_path, tmp_path):
    out = tmp_path / "extracted"
    out.mkdir()
    (out / "item_master.csv").write_text("key,source\nhand written,\n", encoding="utf-8")

    import_report(out, 2025, report_path, force=True)
    assert (out / "item_master.csv").read_bytes() == (data_dir / "item_master.csv").read_bytes()


def test_import_report_rejects_a_workbook_with_no_carry_sheets(tmp_path):
    with pytest.raises(SupplytrackError) as exc:
        import_report(tmp_path, 2025, EXPORT_FIXTURES / "amazon_2025_sample.xlsx")
    assert "Item master" in str(exc.value)


def test_import_report_cli_writes_and_then_refuses(data_dir, report_path, tmp_path, capsys):
    out = tmp_path / "extracted"
    args = ["import-report", "--year", "2025", "--data-dir", str(out), str(report_path)]

    assert main(args) == 0
    printed = capsys.readouterr().out
    assert "Item master" in printed
    assert str(len(MASTER_ROWS)) in printed

    assert main(args) == 1  # a second run would overwrite
    assert "--force" in capsys.readouterr().out

    assert main(args + ["--force"]) == 0


# --- classification ---------------------------------------------------------


def test_a_report_workbook_classifies_into_five_kinds_and_ignored_sheets(report_path):
    recognised, ignored = classify_exports([report_path], require_export=False)

    assert [e.kind for e in recognised] == ["item_master", "prices", "prices_retired"]
    assert [e.sheet for e in recognised] == ["Item master", "Prices", "Prices retired"]
    assert all(not e.is_export for e in recognised)
    assert all(e.vendor == "" for e in recognised)

    reasons = {i.sheet: i.reason for i in ignored}
    assert set(reasons) == {"Top 25", "All items", "Sources"}
    assert set(reasons.values()) == {"part of a previous report, not an input"}


def test_a_report_workbook_alone_is_refused_when_an_export_is_required(report_path):
    with pytest.raises(SupplytrackError) as exc:
        classify_exports([report_path])
    message = str(exc.value)
    assert "previous report workbook" in message
    assert "order export" in message


def test_a_report_workbook_beside_an_export_reads_both(report_path):
    recognised, ignored = classify_exports(
        [EXPORT_FIXTURES / "amazon_2025_sample.xlsx", report_path]
    )
    kinds = {e.kind for e in recognised}
    assert kinds == {"amazon", "item_master", "prices", "prices_retired"}
    assert "part of a previous report, not an input" in {i.reason for i in ignored}


def test_the_carry_files_classify_as_csv_uploads_too(data_dir):
    recognised, _ = classify_exports(
        [
            data_dir / "item_master.csv",
            data_dir / "2025" / "prices.csv",
            data_dir / "2025" / "prices_retired.csv",
        ],
        require_export=False,
    )
    # A .csv has no sheet name, so prices_retired.csv is told from prices.csv
    # by its file name.
    assert [e.kind for e in recognised] == ["item_master", "prices", "prices_retired"]


def test_a_review_queue_is_not_mistaken_for_the_item_master(tmp_path):
    """The queue carries all four item-master columns; queue_reason disqualifies it."""
    queue = tmp_path / "review_queue.csv"
    _write_csv(
        queue,
        ["key", "source", "queue_reason", "include", "units_per_pack", "canonical_name"],
        [{"key": "amz:thing", "source": "amazon", "queue_reason": "unknown key",
          "include": "", "units_per_pack": "", "canonical_name": "Thing"}],
    )
    recognised, ignored = classify_exports([queue], require_export=False)
    assert recognised == []
    assert len(ignored) == 1


# --- run, with the workbook as its only carried-forward input ---------------


def test_run_takes_the_master_and_prices_from_a_report_workbook(report_path, data_dir, tmp_path):
    """Last year's report plus this year's export, and nothing else."""
    fresh = tmp_path / "fresh-data"
    filled = carry_forward(fresh, 2025, [report_path])

    labels = {label for _, _, label, _ in filled}
    assert labels == set(CARRY_LABELS.values())
    assert (fresh / "item_master.csv").read_bytes() == (data_dir / "item_master.csv").read_bytes()
    assert (fresh / "2025" / "prices.csv").exists()


def test_carry_forward_never_replaces_a_file_that_is_already_there(report_path, tmp_path):
    fresh = tmp_path / "fresh-data"
    (fresh / "2025").mkdir(parents=True)
    kept = fresh / "item_master.csv"
    kept.write_text("key,source\nmine,\n", encoding="utf-8")

    filled = carry_forward(fresh, 2025, [report_path])
    assert "Item master" not in {label for _, _, label, _ in filled}
    assert kept.read_text(encoding="utf-8") == "key,source\nmine,\n"


def test_run_says_what_it_took_from_the_workbook(report_path, tmp_path, capsys):
    out_dir = tmp_path / "out"
    fresh = tmp_path / "fresh-data"
    code = main(
        [
            "run",
            "--year",
            "2025",
            "--data-dir",
            str(fresh),
            "--out-dir",
            str(out_dir),
            str(EXPORT_FIXTURES / "amazon_2025_sample.xlsx"),
            str(report_path),
        ]
    )
    printed = capsys.readouterr().out
    assert "Took the Item master" in printed
    assert "part of a previous report, not an input" in printed
    # The sample export holds items this master has never seen, so the run stops
    # at the review queue. What matters here is that it got that far on a data
    # directory that started empty.
    assert code == 2
    assert (fresh / "item_master.csv").exists()


# --- the whole point: last year's workbook plus this year's export ----------

AMAZON_EXPORT_COLUMNS = [
    "Order Date", "Order ID", "Order Status", "Amazon-Internal Product Category",
    "Title", "Item Quantity", "Purchase PPU",
]

# Two items the master above already knows, so nothing blocks in review. One of
# them, Sticky Notes Neon, is not in the carried price sheet, which is the whole
# question: last year's prices are keyed to last year's top N.
AMAZON_EXPORT_ROWS = [
    ["2025-03-04", "111-0000001", "Closed", "Office Product",
     "Copy Paper 8.5x11 White", "3", "24.50"],
    ["2025-06-11", "111-0000002", "Closed", "Office Product",
     "Sticky Notes Neon 3x3", "5", "9.25"],
]


def _amazon_export(tmp_path: Path) -> Path:
    path = tmp_path / "amazon-orders-2025.csv"
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(AMAZON_EXPORT_COLUMNS)
        writer.writerows(AMAZON_EXPORT_ROWS)
    return path


def test_run_on_a_workbook_and_an_export_asks_for_the_new_prices(report_path, tmp_path, capsys):
    """The ordinary next-year run: it must ask for the missing prices, not fail.

    The carried price sheet is keyed to the ranking of the year the workbook was
    built for, so a straight check of it would report a missing cell for every
    item new to this year's top N and stop the build. Re-cutting it keeps the
    typed prices and asks only for what is genuinely new.
    """
    fresh = tmp_path / "fresh-data"
    code = main(
        [
            "run", "--year", "2025",
            "--data-dir", str(fresh),
            "--out-dir", str(tmp_path / "out"),
            str(_amazon_export(tmp_path)),
            str(report_path),
        ]
    )
    printed = capsys.readouterr().out

    assert code == 2, printed  # needs a person, not a failed build
    assert "Re-cut the carried price sheet" in printed
    assert "Fill in unit_price and status" in printed

    rows = list(csv.DictReader((fresh / "2025" / "prices.csv").open(encoding="utf-8-sig")))
    names = {row["canonical_name"] for row in rows}
    assert names == {"Copy Paper 8.5x11 White", "Sticky Notes Neon"}
    # The price typed last year for an item still in the top N is kept.
    kept = next(r for r in rows if r["canonical_name"] == "Copy Paper 8.5x11 White")
    assert kept["status"] == "priced" and kept["unit_price"]
    # The item new to the top N arrives unpriced rather than as a failed check.
    added = [r for r in rows if r["canonical_name"] == "Sticky Notes Neon"]
    assert len(added) == 4 and {r["status"] for r in added} == {"unpriced"}

    # Retiring appends, so last year's retired rows are still there.
    retired = list(csv.DictReader((fresh / "2025" / "prices_retired.csv").open(encoding="utf-8-sig")))
    assert any(r["canonical_name"] == "Rubber Bands Assorted Size" for r in retired)
