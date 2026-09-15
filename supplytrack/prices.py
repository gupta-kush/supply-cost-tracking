"""Vendor price template and loader for the annual top-N comparison.

The office manager fills in ``data/<year>/prices.csv`` by hand after checking each
vendor site. This module writes the empty template they fill in
(``write_template``) and, once it is filled, loads and fully validates it
(``load_prices``). Nothing here talks to a vendor site - that is phase 2
(see ``docs/spec.md`` section 8).
"""
from __future__ import annotations

import csv
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .errors import SupplytrackError

VENDORS = ["Office Depot", "Preferred", "Amazon", "Staples"]

PRICES_HEADER = [
    "rank",
    "canonical_name",
    "vendor",
    "unit_price",
    "status",
    "url",
    "checked_on",
    "note",
]

VALID_STATUSES = {"priced", "not_available", "discontinued", "unpriced"}

_UNPRICED_SAMPLE = 5


@dataclass
class PriceCell:
    rank: int
    canonical_name: str
    vendor: str
    unit_price: Decimal | None
    status: str
    url: str
    checked_on: str
    note: str


@dataclass
class UpdateResult:
    """Counts from :func:`update_prices`, for the CLI to print."""

    path: Path
    kept: int
    added: int
    retired: int


def _year_dir(data_dir: Path, year: int) -> Path:
    return Path(data_dir) / str(year)


def _ranked_path(data_dir: Path, year: int) -> Path:
    return _year_dir(data_dir, year) / "ranked.csv"


def _prices_path(data_dir: Path, year: int) -> Path:
    return _year_dir(data_dir, year) / "prices.csv"


def _read_ranked_top(data_dir: Path, year: int, top: int) -> list[dict[str, str]]:
    path = _ranked_path(data_dir, year)
    if not path.exists():
        raise SupplytrackError(
            f"{path} not found. Run `supplytrack rank --year {year}` before prices."
        )
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    rows.sort(key=lambda r: int(r["rank"]))
    return rows[:top]


def _parse_unit_price(raw: str) -> Decimal:
    """Parse a typed price, keeping the Decimal precision exactly as typed.

    Accepts a leading ``$`` and thousands separators (``1,234.50``).
    Anything else raises ``InvalidOperation`` so a typo is caught rather
    than quietly misparsed.
    """
    text = raw.strip()
    if text.startswith("$"):
        text = text[1:].strip()
    text = text.replace(",", "")
    return Decimal(text)


def write_template(data_dir: Path, year: int, top: int) -> Path:
    """Write the fill-in template for the top N items x vendor.

    One row per item x vendor, vendors in ``VENDORS`` order, status
    ``unpriced`` - nobody has looked any of them up yet, which is exactly
    what :func:`update_prices` writes for an item new to the top N, so a
    fresh template and a freshly-added row mean the same thing. Refuses to
    overwrite an existing, non-empty ``prices.csv`` - the office manager's typed prices
    are exactly the kind of thing a rerun must never silently discard.
    """
    ranked_rows = _read_ranked_top(data_dir, year, top)
    prices_path = _prices_path(data_dir, year)
    if prices_path.exists() and prices_path.read_text(encoding="utf-8-sig").strip():
        raise SupplytrackError(
            f"{prices_path} already exists and is not empty. Delete it first if you "
            "really want a fresh template - this would otherwise discard typed prices."
        )

    prices_path.parent.mkdir(parents=True, exist_ok=True)
    with prices_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(PRICES_HEADER)
        for row in ranked_rows:
            rank = row["rank"]
            canonical_name = row["canonical_name"]
            last_paid = (row.get("last_paid_per_each") or "").strip()
            for vendor in VENDORS:
                note = f"last paid per each: {last_paid}" if vendor == "Amazon" and last_paid else ""
                writer.writerow([rank, canonical_name, vendor, "", "unpriced", "", "", note])
    return prices_path


def _retired_path(data_dir: Path, year: int) -> Path:
    return _year_dir(data_dir, year) / "prices_retired.csv"


def update_prices(data_dir: Path, year: int, top: int) -> UpdateResult:
    """Rewrite ``prices.csv`` to match a re-ranked top N without losing typed prices.

    A review changing the ranking is not the same event as a fresh year: the
    items that fall out of the top N were still priced by hand, and the items
    that enter it need attention but should not wipe out what is already
    there. So this rewrites ``prices.csv`` to hold exactly one row per current
    top-N item x vendor, in rank order:

    - an item still in the top N keeps its existing rows exactly as typed,
      with only ``rank`` refreshed to the new value;
    - an item new to the top N gets rows with status ``unpriced`` (the
      Amazon row's ``note`` carries ``last paid per each: X`` when available,
      same as :func:`write_template`);
    - an item that dropped out of the top N has its rows moved, unchanged,
      to ``data/<year>/prices_retired.csv`` (appended, with a header only if
      the file is new) so the typed prices are never simply discarded.

    If ``prices.csv`` does not exist yet (or is empty), this behaves exactly
    like :func:`write_template`.
    """
    ranked_rows = _read_ranked_top(data_dir, year, top)
    prices_path = _prices_path(data_dir, year)

    if not prices_path.exists() or not prices_path.read_text(encoding="utf-8-sig").strip():
        write_template(data_dir, year, top)
        return UpdateResult(
            path=prices_path, kept=0, added=len(ranked_rows) * len(VENDORS), retired=0
        )

    with prices_path.open("r", encoding="utf-8-sig", newline="") as fh:
        existing_rows = list(csv.DictReader(fh))

    # Index by (canonical_name, vendor) -> position in existing_rows, so a row
    # is retired whenever it is not reused - never decided by name alone.
    # That also catches a stray vendor spelling or a duplicate row, which
    # would otherwise match neither the "kept" lookup (only ever queried with
    # an exact VENDORS entry) nor a "dropped out of the top N" name check,
    # and so would vanish from both files instead of landing in one of them.
    existing_by_key: dict[tuple[str, str], int] = {}
    for i, row in enumerate(existing_rows):
        key = ((row.get("canonical_name") or "").strip(), (row.get("vendor") or "").strip())
        existing_by_key[key] = i  # last row wins if a key repeats

    kept = 0
    added = 0
    reused: set[int] = set()
    new_rows: list[list[str]] = []
    for row in ranked_rows:
        rank = row["rank"]
        canonical_name = row["canonical_name"]
        last_paid = (row.get("last_paid_per_each") or "").strip()
        for vendor in VENDORS:
            idx = existing_by_key.get((canonical_name, vendor))
            if idx is not None:
                existing = existing_rows[idx]
                reused.add(idx)
                kept += 1
                new_rows.append(
                    [
                        rank,
                        canonical_name,
                        vendor,
                        existing.get("unit_price") or "",
                        existing.get("status") or "",
                        existing.get("url") or "",
                        existing.get("checked_on") or "",
                        existing.get("note") or "",
                    ]
                )
            else:
                added += 1
                note = (
                    f"last paid per each: {last_paid}"
                    if vendor == "Amazon" and last_paid
                    else ""
                )
                new_rows.append([rank, canonical_name, vendor, "", "unpriced", "", "", note])

    retired_rows = [row for i, row in enumerate(existing_rows) if i not in reused]

    if retired_rows:
        retired_path = _retired_path(data_dir, year)
        write_header = (
            not retired_path.exists() or not retired_path.read_text(encoding="utf-8-sig").strip()
        )
        with retired_path.open("a", encoding="utf-8", newline="") as fh:
            writer = csv.writer(fh)
            if write_header:
                writer.writerow(PRICES_HEADER)
            for row in retired_rows:
                writer.writerow([row.get(col, "") for col in PRICES_HEADER])

    with prices_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(PRICES_HEADER)
        writer.writerows(new_rows)

    return UpdateResult(path=prices_path, kept=kept, added=added, retired=len(retired_rows))


def _diagnose(
    data_dir: Path, year: int, top: int
) -> tuple[dict[tuple[str, str], PriceCell], list[str]]:
    """Load whatever ``prices.csv`` has and report every problem, without raising.

    Shared by :func:`load_prices` (which raises on any problem) and
    :func:`check_prices` (which turns problems into Findings instead).
    """
    ranked_rows = _read_ranked_top(data_dir, year, top)
    prices_path = _prices_path(data_dir, year)
    if not prices_path.exists():
        raise SupplytrackError(
            f"{prices_path} not found. Run `supplytrack prices --template --year {year}` first."
        )
    with prices_path.open("r", encoding="utf-8-sig", newline="") as fh:
        price_rows = list(csv.DictReader(fh))

    cells: dict[tuple[str, str], PriceCell] = {}
    problems: list[str] = []

    for row in price_rows:
        canonical_name = (row.get("canonical_name") or "").strip()
        vendor = (row.get("vendor") or "").strip()
        status = (row.get("status") or "").strip()
        unit_price: Decimal | None = None

        if status not in VALID_STATUSES:
            problems.append(f"{canonical_name} / {vendor}: unknown status {status!r}")
        elif status == "priced":
            raw = (row.get("unit_price") or "").strip()
            if not raw:
                problems.append(f"{canonical_name} / {vendor}: blank unit_price for status 'priced'")
            else:
                try:
                    unit_price = _parse_unit_price(raw)
                except InvalidOperation:
                    problems.append(f"{canonical_name} / {vendor}: unit_price {raw!r} is not numeric")

        try:
            rank = int(row.get("rank") or 0)
        except ValueError:
            rank = 0

        cells[(canonical_name, vendor)] = PriceCell(
            rank=rank,
            canonical_name=canonical_name,
            vendor=vendor,
            unit_price=unit_price,
            status=status,
            url=row.get("url") or "",
            checked_on=row.get("checked_on") or "",
            note=row.get("note") or "",
        )

    for row in ranked_rows:
        canonical_name = row["canonical_name"]
        for vendor in VENDORS:
            if (canonical_name, vendor) not in cells:
                problems.append(
                    f"{canonical_name} / {vendor}: missing from prices.csv. Run "
                    f"`supplytrack prices --year {year} --update` to add it."
                )

    return cells, problems


def load_prices(data_dir: Path, year: int, top: int) -> dict[tuple[str, str], PriceCell]:
    """Load and fully validate ``prices.csv`` for the top N items.

    Raises one ``SupplytrackError`` listing every missing item x vendor
    pair, every ``priced`` row with a blank or non-numeric ``unit_price``,
    and every unknown status - all at once, so a single re-check catches
    everything wrong rather than one round trip per typo.
    """
    cells, problems = _diagnose(data_dir, year, top)
    if problems:
        raise SupplytrackError(
            f"prices.csv is incomplete for the top {top} items:\n- " + "\n- ".join(problems)
        )
    return cells


def check_prices(data_dir: Path, year: int, top: int) -> list:
    """Validator wrapper: ``load_prices``'s failure as Findings, plus a coverage warning.

    Returns a list of ``supplytrack.validate.Finding``. ``Finding`` is
    imported lazily, inside this function, so this module never depends on
    ``validate`` at import time: ``validate.py`` is expected to depend on
    ``prices.py`` (its own ``check_prices`` wraps this one), and a
    module-level import the other way round would make the two modules
    circular.
    """
    from .validate import Finding

    try:
        cells, problems = _diagnose(data_dir, year, top)
    except SupplytrackError as exc:
        return [Finding(level="fail", code="PRICES_INCOMPLETE", message=str(exc))]

    findings = [Finding(level="fail", code="PRICES_INCOMPLETE", message=p) for p in problems]
    if problems:
        return findings

    unpriced = [
        f"{canonical_name} / {vendor}"
        for (canonical_name, vendor), cell in cells.items()
        if cell.status == "unpriced"
    ]
    if unpriced:
        shown = unpriced[:_UNPRICED_SAMPLE]
        text = "; ".join(shown)
        if len(unpriced) > _UNPRICED_SAMPLE:
            text += f"; and {len(unpriced) - _UNPRICED_SAMPLE} more"
        findings.append(
            Finding(
                level="warn",
                code="PRICES_UNPRICED",
                message=f"{len(unpriced)} item/vendor pair(s) still need a price: {text}",
            )
        )

    counts = {vendor: 0 for vendor in VENDORS}
    for (_, vendor), cell in cells.items():
        if cell.status == "priced":
            counts[vendor] += 1
    max_count = max(counts.values(), default=0)
    for vendor, count in counts.items():
        if count < max_count:
            findings.append(
                Finding(
                    level="warn",
                    code="VENDOR_COVERAGE",
                    message=(
                        f"{vendor} has {count} priced item(s), fewer than the "
                        f"best-covered vendor ({max_count})."
                    ),
                )
            )
    return findings
