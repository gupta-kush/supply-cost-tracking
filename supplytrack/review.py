"""Stage 2: the review queue - what still needs a person, and why.

Three kinds of row land in the queue, and only the first two stop the build:

* **unknown key** - the master has never seen this item. Nothing can be said
  about it, so the build stops.
* **pack size missing** - it is included but has no pack size, so its eaches
  cannot be computed. The build stops.
* **pack size unconfirmed** - it has a pack size that came from a regex or a
  proposal rather than from a person (``upp_source`` of ``title`` or
  ``proposed``). The number is usable, so the build carries on; the row stays
  in the queue, the validator warns, and the report names it, until somebody
  confirms it.

That third kind is why the queue is not simply a list of new items. On the
seeded 2025 master, 84 items have a pack size taken straight from their title
and 33 included items have none at all: without a standing list, the unconfirmed
ones would look identical to the confirmed ones forever.

Confirming is a once-per-item cost. A confirmed pack size is never asked about
again.
"""
from __future__ import annotations

import csv
import difflib
import re
from pathlib import Path

from .errors import SupplytrackError
from .ingest import load_lines
from .master import (
    UNCONFIRMED_UPP_SOURCES,
    MasterRow,
    decode_preferred_pack,
    load_master,
    save_master,
    suggest_include,
    upp_candidates,
    year_dir,
)

REVIEW_COLUMNS = [
    "key",
    "source",
    "raw_title",
    "amazon_category",
    "packs_in_year",
    "queue_reason",
    "include",
    "include_reason",
    "units_per_pack",
    "upp_candidates",
    "upp_reason",
    "canonical_name",
    "canonical_reason",
    "unit_label",
    "note",
]

REASON_UNKNOWN = "unknown key"
REASON_MISSING = "pack size missing"
REASON_UNCONFIRMED = "pack size unconfirmed"

# The two that stop the build. An unconfirmed pack size is a number somebody
# should look at, not a number that cannot be used.
BLOCKING_REASONS = frozenset({REASON_UNKNOWN, REASON_MISSING})

_CANONICAL_MATCH = 0.85
_YES = ("y", "yes", "true", "1")
_NO = ("n", "no", "false", "0")


def build_queue(data_dir: Path, year: int) -> Path:
    """Write ``<year>/review_queue.csv``: everything still waiting on a person.

    Returns the path. The file is always written, header only when there is
    nothing to ask about, so the caller reports "nothing to review" from a real
    file rather than from an absence.
    """
    data_dir = Path(data_dir)
    out_dir = year_dir(data_dir, year)
    lines = load_lines(data_dir, year)
    master = load_master(data_dir)

    seen: dict[str, dict] = {}
    for row in lines:
        key = row["key"]
        entry = seen.setdefault(
            key,
            {
                "key": key,
                "source": row["source"],
                "raw_title": row["raw_title"],
                "amazon_category": row["amazon_category"],
                "pack_desc": row["pack_desc"],
                "packs_in_year": 0,
            },
        )
        entry["packs_in_year"] += int(row["packs"])
        if not entry["amazon_category"] and row["amazon_category"]:
            entry["amazon_category"] = row["amazon_category"]
        if not entry["pack_desc"] and row["pack_desc"]:
            entry["pack_desc"] = row["pack_desc"]

    pending: list[tuple[dict, str, MasterRow | None]] = []
    for entry in seen.values():
        known = master.get(entry["key"])
        reason = _queue_reason(known)
        if reason:
            pending.append((entry, reason, known))

    # Known names first, then names proposed earlier in this same queue, so two
    # new listings of one product are proposed under a single name rather than
    # arriving as two items that a person has to notice and merge.
    known_names = [r.canonical_name for r in master.values() if r.canonical_name.strip()]

    # Blocking rows first: they are what a person has to clear before anything
    # can be built, and the unconfirmed ones can wait for a quieter moment.
    pending.sort(
        key=lambda item: (
            item[1] not in BLOCKING_REASONS,
            -item[0]["packs_in_year"],
            item[0]["raw_title"],
            item[0]["key"],
        )
    )

    queue_path = out_dir / "review_queue.csv"
    with queue_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=REVIEW_COLUMNS)
        writer.writeheader()
        for entry, reason, known in pending:
            row = _suggest_row(entry, reason, known, known_names)
            if row["canonical_name"]:
                known_names.append(row["canonical_name"])
            writer.writerow(row)
    return queue_path


def _queue_reason(known: MasterRow | None) -> str:
    """Why this key is in the queue, or "" when it needs nothing."""
    if known is None:
        return REASON_UNKNOWN
    # A row parked with a blank include (v2's undecided rows) is asked about
    # again next run rather than vanishing; a real include=n is a decision and
    # is not requeued.
    if not known.include.strip():
        return REASON_UNKNOWN
    if not known.included:
        return ""
    if known.units_per_pack_int is None:
        return REASON_MISSING
    if known.upp_source.strip().casefold() in UNCONFIRMED_UPP_SOURCES:
        return REASON_UNCONFIRMED
    return ""


def _suggest_row(
    entry: dict, reason: str, known: MasterRow | None, known_names: list[str]
) -> dict:
    """One queue row: the tool's proposal, and why it is proposing it.

    A row for an item already in the master is prefilled with what the master
    holds, so confirming it is a glance rather than a retyping exercise.
    """
    title = (known.raw_title if known and known.raw_title else entry["raw_title"]) or ""
    category = entry["amazon_category"] or (known.amazon_category if known else "")

    if known is None:
        include, include_reason = suggest_include(category, entry["source"])
        units, candidates, upp_reason = _suggest_units(entry)
        canonical, canonical_reason = _suggest_canonical(title, known_names)
        unit_label = _suggest_unit_label(title)
        note = ""
    else:
        include = known.include or "y"
        include_reason = "already in the item master"
        candidates = _candidate_text(entry, title)
        canonical = known.canonical_name or title
        canonical_reason = "the name already in the item master"
        unit_label = known.unit_label or _suggest_unit_label(title)
        note = known.note
        if reason == REASON_MISSING:
            units, candidates, upp_reason = _suggest_units(entry, title)
        else:
            units = known.units_per_pack
            upp_reason = (
                f"{units} came from {known.upp_source or 'an unknown source'} and nobody has "
                "confirmed it; leave it to accept, or correct it"
            )

    return {
        "key": entry["key"],
        "source": entry["source"],
        "raw_title": title,
        "amazon_category": category,
        "packs_in_year": entry["packs_in_year"],
        "queue_reason": reason,
        "include": include,
        "include_reason": include_reason,
        "units_per_pack": units,
        "upp_candidates": candidates,
        "upp_reason": upp_reason,
        "canonical_name": canonical,
        "canonical_reason": canonical_reason,
        "unit_label": unit_label,
        "note": note,
    }


def _candidate_text(entry: dict, title: str = "") -> str:
    hits = upp_candidates(title or entry["raw_title"])
    return "|".join(f"{value} ({phrase})" for value, phrase in hits)


def _suggest_units(entry: dict, title: str = "") -> tuple[str, str, str]:
    """Propose units per pack, list every candidate, and say where it came from."""
    hits = upp_candidates(title or entry["raw_title"])
    candidates = "|".join(f"{value} ({phrase})" for value, phrase in hits)

    if entry["source"] == "preferred":
        decoded = decode_preferred_pack(entry["pack_desc"])
        if decoded is not None:
            return (
                str(decoded),
                candidates,
                f"Preferred pack code {entry['pack_desc']} means {decoded} per purchase unit",
            )
        if entry["pack_desc"]:
            return (
                "",
                candidates,
                f"pack code {entry['pack_desc']} is not one this tool knows; check the invoice",
            )

    values = {value for value, _ in hits}
    if len(values) == 1:
        value, phrase = hits[0]
        return str(value), candidates, f'the title says "{phrase}"'
    if len(values) > 1:
        return (
            "",
            candidates,
            f"the title states {len(values)} different numbers; "
            "enter how many units come in one purchase unit",
        )
    return "", "", "no pack size in the title; check the listing or enter 1 if it is sold singly"


def _suggest_canonical(title: str, known_names: list[str]) -> tuple[str, str]:
    best_name = ""
    best_ratio = 0.0
    folded = title.casefold()
    for name in known_names:
        ratio = difflib.SequenceMatcher(None, folded, name.casefold()).ratio()
        if ratio > best_ratio:
            best_name, best_ratio = name, ratio
    if best_name and best_ratio >= _CANONICAL_MATCH:
        return best_name, f'close to the existing item "{best_name}" ({best_ratio:.2f})'
    return title, "no close match to an existing item, so the title becomes the name"


def _suggest_unit_label(title: str) -> str:
    return "RM" if re.search(r"\breams?\b", title or "", re.IGNORECASE) else "EA"


def apply_queue(
    data_dir: Path, year: int, decisions: Path, proposed: bool = False
) -> int:
    """Merge a filled queue into the item master; returns how many rows it wrote.

    A row missing a decision is rejected by line number rather than defaulted,
    because a default here is exactly the silent guess the queue exists to
    prevent. Pack size is only required for items being included: an item
    marked ``n`` never reaches the ranking, so its pack size is never used.

    ``proposed=True`` records ``upp_source = proposed`` instead of ``master``.
    That is for a queue a Claude skill filled in without a person confirming
    it: the value is good enough to rank with, so the build stops waiting, but
    the item stays in the queue and on the report's Sources sheet until
    somebody actually confirms it. Applying with ``proposed`` therefore does
    not clear a row from the queue, and is not meant to.
    """
    data_dir = Path(data_dir)
    decisions = Path(decisions)
    if not decisions.exists():
        raise SupplytrackError(f"No such file: {decisions}")

    with decisions.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        field_names = reader.fieldnames or []
        required = ["key", "include", "units_per_pack", "canonical_name"]
        missing = [c for c in required if c not in field_names]
        if missing:
            raise SupplytrackError(
                f"{decisions.name} is missing the column(s): {', '.join(missing)}. "
                "Fill in the review_queue.csv the review command wrote, keeping its columns."
            )
        rows = list(reader)

    master = load_master(data_dir)
    problems: list[str] = []
    staged: list[MasterRow] = []

    for line_no, raw in enumerate(rows, start=2):
        row = {k: (v or "").strip() for k, v in raw.items() if k}
        key = row.get("key", "")
        if not key:
            problems.append(f"line {line_no}: no key")
            continue

        include = row.get("include", "").casefold()
        if include in _YES:
            include = "y"
        elif include in _NO:
            include = "n"
        elif not include:
            problems.append(f"line {line_no} ({_label(row)}): include is blank - enter y or n")
            continue
        else:
            problems.append(
                f"line {line_no} ({_label(row)}): include is {row.get('include')!r} - enter y or n"
            )
            continue

        units = row.get("units_per_pack", "")
        if include == "y":
            parsed = _parse_units(units)
            if parsed is None:
                problems.append(
                    f"line {line_no} ({_label(row)}): units_per_pack is "
                    f"{units!r} - enter how many units come in one purchase unit"
                )
                continue
        else:
            parsed = _parse_units(units) or 1

        canonical = row.get("canonical_name") or row.get("raw_title") or key
        staged.append(
            MasterRow(
                key=key,
                source=row.get("source", ""),
                raw_title=row.get("raw_title", ""),
                include=include,
                canonical_name=canonical,
                units_per_pack=str(parsed),
                unit_label=(row.get("unit_label") or "EA").upper(),
                # An excluded item's pack size is never used, so claiming a
                # person confirmed it would be a false record.
                upp_source=("proposed" if proposed else "master") if include == "y" else "",
                amazon_category=row.get("amazon_category", ""),
                first_seen=str(year),
                last_seen=str(year),
                note=row.get("note", ""),
            )
        )

    if problems:
        raise SupplytrackError(
            f"{decisions.name} has {len(problems)} row(s) that are not ready to apply, so "
            "nothing was written:\n  " + "\n  ".join(problems)
        )

    for row in staged:
        existing = master.get(row.key)
        if existing is not None:
            # An update, not a replacement: the year the item first appeared is
            # history the queue does not carry, and a note somebody wrote about
            # this item is not thrown away by a row that left the field blank.
            row.first_seen = existing.first_seen or row.first_seen
            row.note = row.note or existing.note
            row.source = row.source or existing.source
            row.raw_title = row.raw_title or existing.raw_title
            row.amazon_category = row.amazon_category or existing.amazon_category
        master[row.key] = row
    save_master(data_dir, master)
    return len(staged)


def queue_reason_counts(queue_path: Path) -> dict[str, int]:
    """How many rows carry each ``queue_reason``, in the order they are reported.

    The three reasons ask for three different things, so a reviewer opening the
    file wants to know which of them they are in for before they open it.
    """
    counts = {REASON_UNKNOWN: 0, REASON_MISSING: 0, REASON_UNCONFIRMED: 0}
    path = Path(queue_path)
    if not path.exists():
        return counts
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            reason = (row.get("queue_reason") or "").strip()
            if reason in counts:
                counts[reason] += 1
    return counts


def queue_counts(queue_path: Path) -> tuple[int, int]:
    """How many rows in a queue block the build, and how many merely await a look."""
    counts = queue_reason_counts(queue_path)
    blocking = sum(n for reason, n in counts.items() if reason in BLOCKING_REASONS)
    return blocking, counts[REASON_UNCONFIRMED]


def _parse_units(value: str) -> int | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    if number <= 0 or number != int(number):
        return None
    return int(number)


def _label(row: dict) -> str:
    title = row.get("raw_title") or row.get("key") or ""
    return title[:60]
