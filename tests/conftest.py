"""Shared fixtures: the synthetic exports, a temporary data directory, and a
helper that fills in a review queue the way a person would.

Every test works against ``tmp_path``. Nothing here reads or writes the real
data directory, and the exports are the invented ones in ``tests/fixtures``.
"""
from __future__ import annotations

import csv
from pathlib import Path

import pytest

from supplytrack.ingest import ingest
from supplytrack.review import REVIEW_COLUMNS, apply_queue, build_queue

FIXTURES = Path(__file__).resolve().parent / "fixtures"

AMAZON_FIXTURE = FIXTURES / "amazon_2025_sample.xlsx"
PREFERRED_FIXTURE = FIXTURES / "preferred_2025_sample.xlsx"

YEAR = 2025

# How a person would answer this year's queue. Keyed by a distinctive piece of
# the title. The two name-tag listings are deliberately given one name and two
# different pack sizes: that is the merge case the ranking has to get right.
DECISIONS = {
    "Avery Printable Name Tags": {"include": "y", "units_per_pack": "400",
                                  "canonical_name": "Avery Name Tag Inserts"},
    "Avery Name Badge Inserts": {"include": "y", "units_per_pack": "200",
                                 "canonical_name": "Avery Name Tag Inserts"},
    "Hammermill Copy Paper": {"include": "y", "units_per_pack": "10", "unit_label": "RM"},
    "Bubly Sparkling Water": {"include": "n"},
    "Cable Zip Ties": {"include": "n", "note": "excluded by the office manager in 2025"},
}


@pytest.fixture(scope="session")
def amazon_export() -> Path:
    if not AMAZON_FIXTURE.exists():  # pragma: no cover - fixtures are committed
        pytest.skip("run tests/fixtures/make_fixtures.py first")
    return AMAZON_FIXTURE


@pytest.fixture(scope="session")
def preferred_export() -> Path:
    if not PREFERRED_FIXTURE.exists():  # pragma: no cover - fixtures are committed
        pytest.skip("run tests/fixtures/make_fixtures.py first")
    return PREFERRED_FIXTURE


@pytest.fixture
def data_dir(tmp_path) -> Path:
    path = tmp_path / "data"
    path.mkdir()
    return path


@pytest.fixture
def ingested(data_dir, amazon_export, preferred_export) -> Path:
    """A data directory with both exports ingested for 2025, nothing reviewed."""
    ingest(data_dir, YEAR, amazon_export, preferred_export)
    return data_dir


@pytest.fixture
def reviewed(ingested) -> Path:
    """A data directory with the queue answered, ready to rank."""
    fill_and_apply(ingested, YEAR)
    return ingested


def read_csv(path: Path) -> list[dict]:
    with Path(path).open("r", encoding="utf-8-sig", newline="") as fh:
        return [dict(row) for row in csv.DictReader(fh)]


def read_header(path: Path) -> list[str]:
    with Path(path).open("r", encoding="utf-8-sig", newline="") as fh:
        return next(csv.reader(fh))


def write_csv(path: Path, columns: list[str], rows: list[dict]) -> Path:
    with Path(path).open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow({c: row.get(c, "") for c in columns})
    return Path(path)


def fill_queue(queue_path: Path, out_path: Path, decisions: dict | None = None) -> Path:
    """Answer a queue the way a person would, and write it out to apply.

    Anything the decisions table does not mention keeps the tool's suggestion,
    except that a blank include becomes ``n``: a category nobody has ruled on
    is not an office supply until somebody says it is.
    """
    decisions = DECISIONS if decisions is None else decisions
    rows = read_csv(queue_path)
    for row in rows:
        for marker, answer in decisions.items():
            if marker.casefold() in (row.get("raw_title") or "").casefold():
                row.update(answer)
                break
        if not (row.get("include") or "").strip():
            row["include"] = "n"
        if row["include"] == "y" and not (row.get("units_per_pack") or "").strip():
            row["units_per_pack"] = "1"
    return write_csv(out_path, REVIEW_COLUMNS, rows)


def fill_and_apply(data_dir: Path, year: int, decisions: dict | None = None) -> int:
    queue = build_queue(data_dir, year)
    filled = fill_queue(queue, Path(data_dir) / f"{year}_decisions.csv", decisions)
    return apply_queue(data_dir, year, filled)
