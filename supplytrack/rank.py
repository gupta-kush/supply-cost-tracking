"""Stage 3: rank items by how many units were actually bought.

The ranking is by *eaches*, not by pack count and not by spend: one order of a
1,000-pack of pens outranks ten orders of a 12-pack, which is what the
leadership question ("what do we buy most of") actually means.

Two listings that a person has given the same canonical name become one item
here, and their eaches add up. Every line that does not make it into the
ranking is written to ``excluded.csv`` with its reason, so the two files
together account for every line in ``lines.csv`` - the check that would have
caught the 2025 workbook losing its M-Z tail.
"""
from __future__ import annotations

import csv
from dataclasses import dataclass, field
from decimal import Decimal, DivisionByZero, InvalidOperation
from pathlib import Path

from . import validate as _validate
from .errors import SupplytrackError
from .ingest import load_lines, update_run
from .master import load_master, year_dir

RANKED_COLUMNS = [
    "rank",
    "canonical_name",
    "eaches",
    "packs",
    "units_per_pack",
    "unit_label",
    "keys",
    "sources",
    "last_paid_per_each",
    "upp_source",
]

EXCLUDED_COLUMNS = [
    "key",
    "source",
    "raw_title",
    "amazon_category",
    "packs",
    "reason",
]


@dataclass
class RankResult:
    """The ranking, plus the counts that prove nothing went missing."""

    year: int
    items: list[dict]
    ranked_path: Path
    excluded_path: Path
    total_lines: int
    included_lines: int
    excluded_lines: int
    warnings: list[str] = field(default_factory=list)

    @property
    def item_count(self) -> int:
        return len(self.items)


def rank(data_dir: Path, year: int) -> RankResult:
    """Write ``<year>/ranked.csv`` and ``<year>/excluded.csv``.

    Validation runs first and a failure stops the build: an item whose key is
    unknown or whose pack size is missing cannot be ranked, and producing a
    partial ranking that looks complete is worse than producing none.
    """
    data_dir = Path(data_dir)
    out_dir = year_dir(data_dir, year)

    findings = _validate.check_lines(data_dir, year) + _validate.check_master(data_dir, year)
    fails = [f for f in findings if f.level == "fail"]
    if fails:
        raise SupplytrackError(
            "The ranking cannot be built until these are fixed:\n  "
            + "\n  ".join(f"{f.code}: {f.message}" for f in fails)
        )
    warnings = [f.message for f in findings if f.level == "warn"]

    lines = load_lines(data_dir, year)
    master = load_master(data_dir)

    per_key: dict[str, dict] = {}
    excluded_rows: list[dict] = []

    for row in lines:
        key = row["key"]
        entry = master.get(key)
        if entry is None:  # pragma: no cover - check_master fails first
            excluded_rows.append(_excluded(row, "not in item master"))
            continue
        if not entry.included:
            excluded_rows.append(_excluded(row, "include=n"))
            continue

        agg = per_key.setdefault(
            key,
            {
                "key": key,
                "canonical_name": entry.canonical_name or entry.raw_title or key,
                "units_per_pack": entry.units_per_pack_int,
                "unit_label": entry.unit_label or "EA",
                "upp_source": entry.upp_source or "",
                "source": row["source"],
                "packs": 0,
                "lines": 0,
                "latest_date": "",
                "latest_ppu": "",
            },
        )
        agg["packs"] += int(row["packs"])
        agg["lines"] += 1
        if row["source"] == "amazon" and row["ppu_paid"]:
            if row["order_date"] >= agg["latest_date"]:
                agg["latest_date"] = row["order_date"]
                agg["latest_ppu"] = row["ppu_paid"]

    items = _group_items(per_key)
    items.sort(key=lambda i: (-i["eaches"], -i["packs"], i["canonical_name"].casefold()))
    for position, item in enumerate(items, start=1):
        item["rank"] = position

    included_lines = sum(agg["lines"] for agg in per_key.values())
    if included_lines + len(excluded_rows) != len(lines):  # pragma: no cover - defensive
        raise SupplytrackError(
            f"{included_lines} included plus {len(excluded_rows)} excluded lines do not add up "
            f"to the {len(lines)} lines read. Nothing may go uncounted; this is a bug."
        )

    ranked_path = out_dir / "ranked.csv"
    with ranked_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=RANKED_COLUMNS)
        writer.writeheader()
        for item in items:
            writer.writerow({c: item.get(c, "") for c in RANKED_COLUMNS})

    excluded_path = out_dir / "excluded.csv"
    with excluded_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=EXCLUDED_COLUMNS)
        writer.writeheader()
        writer.writerows(excluded_rows)

    existing = []
    try:
        from .ingest import load_run

        existing = list(load_run(data_dir, year).get("warnings") or [])
    except SupplytrackError:  # pragma: no cover - run.json is written by ingest
        existing = []
    merged: list[str] = []
    for message in existing + warnings:
        if message not in merged:
            merged.append(message)

    update_run(
        data_dir,
        year,
        ranked_at=_now(),
        ranked_items=len(items),
        included_lines=included_lines,
        excluded_lines=len(excluded_rows),
        warnings=merged,
    )

    return RankResult(
        year=int(year),
        items=items,
        ranked_path=ranked_path,
        excluded_path=excluded_path,
        total_lines=len(lines),
        included_lines=included_lines,
        excluded_lines=len(excluded_rows),
        warnings=warnings,
    )


def _group_items(per_key: dict[str, dict]) -> list[dict]:
    """Add the per-key totals up into one row per canonical name."""
    grouped: dict[str, dict] = {}
    for key in sorted(per_key):
        agg = per_key[key]
        name = agg["canonical_name"]
        item = grouped.setdefault(
            name,
            {
                "canonical_name": name,
                "eaches": 0,
                "packs": 0,
                "unit_labels": [],
                "upp_values": [],
                "keys": [],
                "sources": [],
                "upp_sources": [],
                "latest_date": "",
                "latest_ppu": "",
                "latest_upp": None,
            },
        )
        units = agg["units_per_pack"] or 0
        item["eaches"] += agg["packs"] * units
        item["packs"] += agg["packs"]
        item["keys"].append(key)
        item["upp_values"].append(agg["units_per_pack"])
        if agg["source"] not in item["sources"]:
            item["sources"].append(agg["source"])
        if agg["unit_label"] not in item["unit_labels"]:
            item["unit_labels"].append(agg["unit_label"])
        if agg["upp_source"] and agg["upp_source"] not in item["upp_sources"]:
            item["upp_sources"].append(agg["upp_source"])
        if agg["latest_ppu"] and agg["latest_date"] >= item["latest_date"]:
            item["latest_date"] = agg["latest_date"]
            item["latest_ppu"] = agg["latest_ppu"]
            item["latest_upp"] = agg["units_per_pack"]

    items: list[dict] = []
    for item in grouped.values():
        distinct = {v for v in item["upp_values"] if v is not None}
        items.append(
            {
                "canonical_name": item["canonical_name"],
                "eaches": item["eaches"],
                "packs": item["packs"],
                # Blank when merged listings come in different pack sizes: there
                # is no single true value, and eaches is still the right total.
                "units_per_pack": str(next(iter(distinct))) if len(distinct) == 1 else "",
                "unit_label": "|".join(item["unit_labels"]),
                "keys": "|".join(item["keys"]),
                "sources": "|".join(item["sources"]),
                "last_paid_per_each": _per_each(item["latest_ppu"], item["latest_upp"]),
                "upp_source": "|".join(item["upp_sources"]),
            }
        )
    return items


def _per_each(ppu: str, units: int | None) -> str:
    """The most recent Amazon price per unit, or blank when it cannot be known.

    Preferred quotes no prices at all, so blank is the normal answer for an
    item bought only there. It is a reference number, not a price to compare.
    """
    if not ppu or not units:
        return ""
    try:
        value = Decimal(str(ppu)) / Decimal(units)
    except (InvalidOperation, DivisionByZero, ValueError):  # pragma: no cover - guarded above
        return ""
    text = format(value.quantize(Decimal("0.0001")), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def _excluded(row: dict, reason: str) -> dict:
    return {
        "key": row["key"],
        "source": row["source"],
        "raw_title": row["raw_title"],
        "amazon_category": row["amazon_category"],
        "packs": row["packs"],
        "reason": reason,
    }


def _now() -> str:
    import datetime as dt

    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def load_ranked(data_dir: Path, year: int) -> list[dict]:
    """Read ``<year>/ranked.csv`` back, for prices, report and validate."""
    path = Path(data_dir) / str(year) / "ranked.csv"
    if not path.exists():
        raise SupplytrackError(
            f"No ranking for {year} at {path}. Run `supplytrack rank --year {year}` first."
        )
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        missing = [c for c in RANKED_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise SupplytrackError(
                f"{path} is missing the column(s): {', '.join(missing)}. "
                f"Run rank for {year} again."
            )
        return [{c: (row.get(c) or "").strip() for c in RANKED_COLUMNS} for row in reader]
