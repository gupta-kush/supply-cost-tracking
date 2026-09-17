"""The checks that decide whether a build is publishable.

Two levels, and the difference matters. A **fail** means a number in the
report would be wrong or unaccounted for, so the build stops. A **warn** means
something looks unusual and a person should glance at it, but the arithmetic
still holds.

The load-bearing one is ``UNCOUNTED_LINES``: included plus excluded must equal
the lines read. The 2025 workbook quietly lost its M-Z tail, and no total on
the page looked wrong, because nothing in the process ever asked whether the
parts still added up to the whole.
"""
from __future__ import annotations

import csv
import difflib
import re
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path
from typing import Literal

from .errors import SupplytrackError
from .ingest import load_lines, load_run
from .master import (
    category_expected_include,
    category_is_known,
    is_pack_phrase,
    load_master,
    upp_candidates,
)

_NEAR_DUPLICATE = 0.9
_SAMPLE = 8


@dataclass
class Finding:
    """One check result. ``fail`` stops the build; ``warn`` is for a person to read."""

    level: Literal["fail", "warn"]
    code: str
    message: str

    def __str__(self) -> str:  # pragma: no cover - convenience only
        return f"{self.level.upper()} {self.code} {self.message}"


def _fail(code: str, message: str) -> Finding:
    return Finding("fail", code, message)


def _warn(code: str, message: str) -> Finding:
    return Finding("warn", code, message)


def _sample(items: list[str]) -> str:
    shown = items[:_SAMPLE]
    text = "; ".join(shown)
    if len(items) > _SAMPLE:
        text += f"; and {len(items) - _SAMPLE} more"
    return text


def check_lines(data_dir: Path, year: int) -> list[Finding]:
    """The line file itself: is it there, is it whole, are the lines in the year."""
    data_dir = Path(data_dir)
    path = data_dir / str(year) / "lines.csv"
    if not path.exists():
        return [
            _fail(
                "LINES_MISSING",
                f"There is no line file for {year}. Run ingest for {year} before anything else.",
            )
        ]

    findings: list[Finding] = []
    lines = load_lines(data_dir, year)
    run = load_run(data_dir, year)

    rows_written = run.get("rows_written")
    if isinstance(rows_written, int) and rows_written != len(lines):
        findings.append(
            _fail(
                "LINE_COUNT_MISMATCH",
                f"The ingest recorded {rows_written} lines for {year} but lines.csv now holds "
                f"{len(lines)}. Run ingest again rather than editing lines.csv by hand.",
            )
        )

    outside = [
        f"{row['raw_title'][:50]} on {row['order_date']}"
        for row in lines
        if not row["order_date"].startswith(f"{year}-")
    ]
    if outside:
        findings.append(
            _warn(
                "DATE_OUT_OF_YEAR",
                f"{len(outside)} line(s) are dated outside {year}: {_sample(outside)}. "
                "They are still counted; re-export with the right date range if that is wrong.",
            )
        )

    non_closed = run.get("non_closed") or []
    if non_closed:
        shown = [
            f"{item.get('order_id') or '(no order id)'} is {item.get('status')}"
            for item in non_closed
        ]
        findings.append(
            _warn(
                "STATUS_NOT_CLOSED",
                f"{len(non_closed)} line(s) have an order status other than Closed: "
                f"{_sample(shown)}. A cancelled or returned order still counts here.",
            )
        )
    return findings


def check_master(data_dir: Path, year: int) -> list[Finding]:
    """The decisions: every key known, every included item with a usable pack size."""
    data_dir = Path(data_dir)
    if not (data_dir / str(year) / "lines.csv").exists():
        return [
            _fail(
                "LINES_MISSING",
                f"There is no line file for {year}. Run ingest for {year} before anything else.",
            )
        ]

    findings: list[Finding] = []
    lines = load_lines(data_dir, year)
    master = load_master(data_dir)

    unknown: dict[str, str] = {}
    for row in lines:
        if row["key"] not in master:
            unknown.setdefault(row["key"], row["raw_title"][:50])
    if unknown:
        shown = [f"{title} [{key}]" for key, title in unknown.items()]
        findings.append(
            _fail(
                "UNKNOWN_KEY",
                f"{len(unknown)} item(s) are not in the item master: {_sample(shown)}. "
                f"Run review for {year}, fill the queue in, and apply it.",
            )
        )

    used = {row["key"] for row in lines}
    bad_units: list[str] = []
    unconfirmed: list[str] = []
    mismatched: list[str] = []
    odd_category: list[str] = []

    for key in sorted(used):
        entry = master.get(key)
        if entry is None or not entry.included:
            # A parked row (blank include) has no decision yet, so it cannot be
            # "odd for its category" - that warning is only for a real include=n.
            if entry is not None and entry.include.strip().casefold() == "n" and entry.amazon_category:
                if category_expected_include(entry.amazon_category) == "y":
                    odd_category.append(
                        f"{entry.canonical_name or entry.raw_title[:40]} is excluded but its "
                        f"category is {entry.amazon_category}"
                    )
            continue

        units = entry.units_per_pack_int
        if units is None:
            bad_units.append(
                f"{entry.canonical_name or entry.raw_title[:40]} "
                f"(units_per_pack is {entry.units_per_pack!r})"
            )
        else:
            if entry.upp_unconfirmed:
                unconfirmed.append(
                    f"{entry.canonical_name or entry.raw_title[:40]}: {units} "
                    f"per pack came from {entry.upp_source}"
                )
            stated = _contradicting_candidates(entry.raw_title, units)
            if stated:
                mismatched.append(
                    f"{entry.canonical_name or entry.raw_title[:40]}: master says {units}, "
                    f"the title says {stated}"
                )

        if entry.amazon_category and category_is_known(entry.amazon_category):
            if category_expected_include(entry.amazon_category) == "n":
                odd_category.append(
                    f"{entry.canonical_name or entry.raw_title[:40]} is included but its "
                    f"category is {entry.amazon_category}"
                )

    if bad_units:
        findings.append(
            _fail(
                "UPP_MISSING",
                f"{len(bad_units)} included item(s) have no usable units_per_pack: "
                f"{_sample(bad_units)}. Every included item needs a whole number of units "
                "per purchase unit before it can be ranked.",
            )
        )
    if unconfirmed:
        findings.append(
            _warn(
                "UPP_UNCONFIRMED",
                f"{len(unconfirmed)} included item(s) are ranked on a pack size nobody has "
                f"confirmed: {_sample(unconfirmed)}. They are counted, and they stay in the "
                "review queue until somebody confirms them.",
            )
        )
    if mismatched:
        findings.append(
            _warn(
                "UPP_TITLE_MISMATCH",
                f"{len(mismatched)} item(s) have a pack size that disagrees with the title: "
                f"{_sample(mismatched)}. Check which is right - this changes the ranking.",
            )
        )
    if odd_category:
        findings.append(
            _warn(
                "CATEGORY_UNUSUAL",
                f"{len(odd_category)} item(s) are classified against the usual rule for their "
                f"category: {_sample(odd_category)}.",
            )
        )

    names = sorted(
        {
            master[key].canonical_name
            for key in used
            if key in master and master[key].included and master[key].canonical_name.strip()
        }
    )
    pairs: list[str] = []
    for i, first in enumerate(names):
        for second in names[i + 1 :]:
            ratio = difflib.SequenceMatcher(None, first.casefold(), second.casefold()).ratio()
            if ratio >= _NEAR_DUPLICATE:
                pairs.append(f'"{first}" and "{second}" ({ratio:.2f})')
    if pairs:
        findings.append(
            _warn(
                "NEAR_DUPLICATE_NAMES",
                f"{len(pairs)} pair(s) of item names are nearly identical and are being counted "
                f"as separate items: {_sample(pairs)}. Give them one name to merge them.",
            )
        )
    return findings


def _contradicting_candidates(title: str, units: int) -> str:
    """The title's pack counts when they genuinely disagree with ``units``, else "".

    A warning a person dismisses every time is worse than no warning, because
    it teaches them to skim past the real ones. Three things therefore keep
    this quiet:

    * only *pack-like* phrases count as contradiction. "320 Sheets" says what
      is inside the one pack you buy, not how many packs came in the order.
    * matching any number anywhere in the title settles it - including one
      that was filtered out as a measurement. If the master says 500 and the
      title says "500 Sheets/Ream", or says 26 against "26 Tab", the number a
      person entered is visibly where they got it from, and a warning would be
      telling them something they already know.
    * two numbers that multiply to the master value settle it too: "12/Pack,
      Case of 10 Packs" with a master of 120 is a case of 120, correctly
      entered.
    """
    candidates = upp_candidates(title)
    if not candidates:
        return ""
    pack_like = [(value, phrase) for value, phrase in candidates if is_pack_phrase(phrase)]
    if not pack_like:
        return ""

    if units in _numbers_in(title):
        return ""
    values = {value for value, _ in candidates}
    products = {a * b for a, b in combinations(sorted(values), 2)}
    if units in products:
        return ""
    return ", ".join(f"{value} ({phrase})" for value, phrase in pack_like)


def _numbers_in(title: str) -> set[int]:
    """Every whole number the title states, decimals and their parts excluded."""
    return {int(n) for n in re.findall(r"(?<![\d.])\d{1,6}(?![\d.])", str(title or ""))}


def check_rank(data_dir: Path, year: int) -> list[Finding]:
    """The ranking artifacts: present, and accounting for every line read."""
    data_dir = Path(data_dir)
    folder = data_dir / str(year)
    ranked_path = folder / "ranked.csv"
    excluded_path = folder / "excluded.csv"

    if not ranked_path.exists() or not excluded_path.exists():
        return [
            _fail(
                "RANK_MISSING",
                f"There is no ranking for {year} yet. Run rank for {year}.",
            )
        ]
    if not (folder / "lines.csv").exists():
        return [
            _fail(
                "LINES_MISSING",
                f"There is no line file for {year}. Run ingest for {year} before anything else.",
            )
        ]

    findings: list[Finding] = []
    lines = load_lines(data_dir, year)
    master = load_master(data_dir)
    excluded_rows = _read_rows(excluded_path)

    expected_included = sum(
        1 for row in lines if row["key"] in master and master[row["key"]].included
    )
    if expected_included + len(excluded_rows) != len(lines):
        findings.append(
            _fail(
                "UNCOUNTED_LINES",
                f"{expected_included} included plus {len(excluded_rows)} excluded lines do not "
                f"add up to the {len(lines)} lines read for {year}. Some lines are in neither "
                "file, so the totals understate what was bought. Run rank again.",
            )
        )

    ranked_rows = _read_rows(ranked_path)
    if expected_included and not ranked_rows:
        findings.append(
            _fail(
                "RANK_EMPTY",
                f"{expected_included} line(s) are marked for inclusion but the ranking for "
                f"{year} is empty. Run rank again.",
            )
        )
    return findings


def check_prices(data_dir: Path, year: int, top: int) -> list[Finding]:
    """The price sheet: one cell per top-N item and vendor, with a number where priced."""
    data_dir = Path(data_dir)
    path = data_dir / str(year) / "prices.csv"

    try:
        from . import prices as prices_module
    except ImportError:
        return [
            _fail(
                "PRICES_MODULE_MISSING",
                "The prices step is not installed in this copy of the tool, so the price sheet "
                "cannot be checked. Reinstall supplytrack.",
            )
        ]

    if not path.exists():
        return [
            _fail(
                "PRICES_MISSING",
                f"There is no price sheet for {year} at {path}. Run "
                f"`supplytrack prices --year {year} --template` and fill it in.",
            )
        ]

    # prices.check_prices owns the detail: completeness, unpriced cells and
    # vendor coverage. Delegating keeps one definition of what a good sheet is.
    return list(prices_module.check_prices(data_dir, year, top))


def _vendor_coverage(path: Path, top: int) -> list[Finding]:
    """Warn when one vendor priced noticeably fewer items than the others.

    A vendor that could only price half the list makes its column total look
    cheap for a reason that has nothing to do with its prices, which is the
    comparison mistake the report exists to avoid.
    """
    rows = _read_rows(path)
    if not rows:
        return []
    priced: dict[str, int] = {}
    for row in rows:
        vendor = (row.get("vendor") or "").strip()
        if not vendor:
            continue
        priced.setdefault(vendor, 0)
        if (row.get("status") or "").strip().casefold() == "priced":
            priced[vendor] += 1
    if len(priced) < 2:
        return []
    best = max(priced.values())
    thin = [f"{vendor} priced {count} of {best}" for vendor, count in priced.items() if count < best]
    if not thin:
        return []
    return [
        _warn(
            "VENDOR_COVERAGE",
            "Not every vendor could price the same items: "
            + _sample(thin)
            + ". Compare the basket of items all of them priced, not the column totals.",
        )
    ]


def _read_rows(path: Path) -> list[dict]:
    with Path(path).open("r", encoding="utf-8-sig", newline="") as fh:
        return [dict(row) for row in csv.DictReader(fh)]


def run_all(data_dir: Path, year: int, top: int) -> list[Finding]:
    """Every check, in pipeline order, so the first failure names the earliest stage."""
    findings = check_lines(data_dir, year)
    findings += check_master(data_dir, year)
    findings += check_rank(data_dir, year)
    findings += check_prices(data_dir, year, top)

    # Several checks report the same missing file, and one problem should be
    # read once rather than three times.
    seen: set[tuple[str, str]] = set()
    unique: list[Finding] = []
    for finding in findings:
        mark = (finding.code, finding.message)
        if mark in seen:
            continue
        seen.add(mark)
        unique.append(finding)
    return unique
