"""The item master: the file that carries the office manager's judgement calls forward.

Three decisions have to be made about every item bought, and none of them can
be derived reliably from an order export: is it an office supply that belongs
in the report, which listings are the same product, and how many units are in
a purchase unit. The master records each answer once, against a stable key, so
next year only genuinely new items need looking at.

Nothing here guesses silently. The suggestion helpers (:func:`upp_candidates`,
:func:`suggest_include`, :func:`decode_preferred_pack`) exist to fill the
review queue with proposals and reasons; a person confirms them before they
reach the master.
"""
from __future__ import annotations

import csv
import os
import re
from dataclasses import dataclass, fields
from pathlib import Path

from .errors import SupplytrackError

# Where a pack size came from, in descending order of trust:
#   master        - a person confirmed it
#   proposed      - a Claude or regex proposal somebody accepted without checking
#   title         - a single regex hit off the title, unconfirmed
#   2025-workbook - seeded from the office manager's own file
#   (blank)       - an excluded item, whose pack size is never used
#
# The middle two are usable but unconfirmed: they rank, and they keep showing up
# in the queue, in a validator warning and on the report's Sources sheet until
# somebody confirms them.
UNCONFIRMED_UPP_SOURCES = frozenset({"title", "proposed"})

MASTER_COLUMNS = [
    "key",
    "source",
    "raw_title",
    "include",
    "canonical_name",
    "units_per_pack",
    "unit_label",
    "upp_source",
    "amazon_category",
    "first_seen",
    "last_seen",
    "note",
    "display_name",
]

# Amazon's own product categories. Anything in neither list is a decision for a
# person, not a default, because the cost of quietly including a case of soda
# in an office-supply ranking is a leadership question nobody can answer later.
INCLUDE_CATEGORIES = {
    "Office Product",
    "Business, Industrial, & Scientific Supplies Basic",
}
EXCLUDE_CATEGORIES = {
    "Grocery",
    "Kitchen",
    "Apparel",
    "Home",
    "Sports",
    "Toys",
    "Pet Supplies",
    "Baby Product",
}
_INCLUDE_FOLDED = {c.casefold() for c in INCLUDE_CATEGORIES}
_EXCLUDE_FOLDED = {c.casefold() for c in EXCLUDE_CATEGORIES}


# ---------------------------------------------------------------- directories


def default_data_dir() -> Path:
    """Where runtime data lives: ``SUPPLYTRACK_DATA``, else ``./data``."""
    env = os.environ.get("SUPPLYTRACK_DATA")
    return Path(env).expanduser() if env else Path.cwd() / "data"


def default_out_dir() -> Path:
    """Where the finished workbook lands: ``SUPPLYTRACK_OUT``, else ``./out``."""
    env = os.environ.get("SUPPLYTRACK_OUT")
    return Path(env).expanduser() if env else Path.cwd() / "out"


def year_dir(data_dir: Path, year: int) -> Path:
    """``<data_dir>/<year>``, created if it does not exist."""
    path = Path(data_dir) / str(year)
    path.mkdir(parents=True, exist_ok=True)
    return path


def master_path(data_dir: Path) -> Path:
    return Path(data_dir) / "item_master.csv"


# --------------------------------------------------------------------- rows


@dataclass
class MasterRow:
    """One item-master row: one key and every decision recorded against it."""

    key: str
    source: str = ""
    raw_title: str = ""
    include: str = ""
    canonical_name: str = ""
    units_per_pack: str = ""
    unit_label: str = ""
    upp_source: str = ""
    amazon_category: str = ""
    first_seen: str = ""
    last_seen: str = ""
    note: str = ""
    # webapp-v2-spec.md section 5: a model's short leaderboard name, up to 40
    # characters. Blank means the page falls back to truncating canonical_name.
    display_name: str = ""

    @property
    def included(self) -> bool:
        return self.include.strip().casefold() in ("y", "yes", "true", "1")

    @property
    def upp_unconfirmed(self) -> bool:
        """True when the pack size is usable but nobody has vouched for it."""
        return self.upp_source.strip().casefold() in UNCONFIRMED_UPP_SOURCES

    @property
    def units_per_pack_int(self) -> int | None:
        """The pack size as a whole number, or None when missing or not one.

        Returning None rather than raising lets the validator report *which*
        items are unusable and carry on, instead of stopping at the first.
        """
        text = str(self.units_per_pack or "").strip()
        if not text:
            return None
        try:
            value = float(text)
        except ValueError:
            return None
        if value <= 0 or value != int(value):
            return None
        return int(value)

    def as_dict(self) -> dict[str, str]:
        return {f.name: str(getattr(self, f.name) or "") for f in fields(self)}


def load_master(data_dir: Path) -> dict[str, MasterRow]:
    """Read ``data/item_master.csv`` into ``{key: MasterRow}``.

    A missing file is not an error: on the very first run there is nothing to
    know yet, and every key lands in the review queue.
    """
    path = master_path(data_dir)
    if not path.exists():
        return {}
    rows: dict[str, MasterRow] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames is None:
            return {}
        missing = [c for c in MASTER_COLUMNS if c not in reader.fieldnames]
        if missing:
            raise SupplytrackError(
                f"{path} is missing the column(s): {', '.join(missing)}. "
                "The item master must keep its full set of columns; restore it from git history."
            )
        for line_no, raw in enumerate(reader, start=2):
            key = (raw.get("key") or "").strip()
            if not key:
                continue
            if key in rows:
                raise SupplytrackError(
                    f"{path} line {line_no}: the key {key!r} appears twice. "
                    "Each item may have only one row; merge the two by hand and retry."
                )
            rows[key] = MasterRow(**{c: (raw.get(c) or "").strip() for c in MASTER_COLUMNS})
    return rows


def save_master(data_dir: Path, rows: dict[str, MasterRow]) -> None:
    """Write the item master back, sorted by key so diffs stay readable."""
    path = master_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=MASTER_COLUMNS)
        writer.writeheader()
        for key in sorted(rows):
            writer.writerow(rows[key].as_dict())


# -------------------------------------------------------------- suggestions


def decode_preferred_pack(pack: str) -> int | None:
    """Decode a Preferred pack code: ``CT10`` -> 10, ``BX100`` -> 100, ``Each`` -> 1.

    Preferred's codes state the pack size directly, so unlike an Amazon title
    they need no guessing. An unrecognised code returns None and goes to
    review.
    """
    text = str(pack or "").strip()
    if not text:
        return None
    folded = text.casefold()
    if folded in ("each", "ea", "ea.", "1"):
        return 1
    m = re.fullmatch(r"([A-Za-z]{0,3})\s*(\d{1,6})", text)
    if m:
        value = int(m.group(2))
        return value if value > 0 else None
    return None


# Each pattern carries a priority so that when two of them find the same number
# the more specific phrase is the one shown to the reviewer.
_UPP_PATTERNS: list[tuple[int, str]] = [
    # "500 Sheets/Ream, 10 Reams/Carton" - the carton is the purchase unit
    (0, r"(\d{1,6})\s*reams?\s*(?:/|per\s+)\s*carton\b"),
    # "Pack of 6", "Display Pack of 6", "Box of 100"
    (1, r"(?:packs?|box(?:es)?|case|carton|set|sleeve|bundle|bag)\s+of\s+(\d{1,6})\b"),
    # "200 Pack", "48/Pack", "32 Count", "12-Count", "12 Ct", "12pk"
    (2, r"(\d{1,6})\s*(?:-|/)?\s*(?:packs?|pks?|counts?|ct|cnt)\b"),
    # "100/box", "50 per box"
    (3, r"(\d{1,6})\s*(?:/|per\s+)\s*(?:box|bx|case|carton)\b"),
    # "400 Printable Name Tag Inserts", "6 Pads", "500 Sheets"
    (
        4,
        r"(\d{1,6})\s+(?:[A-Za-z][\w'’-]*\s+){0,3}?"
        r"(?:sheets|labels|inserts|tags|pads|boxes|reams|rolls|envelopes|folders|"
        r"sleeves|pieces|tablets|cards|notes|pouches|binders|dividers)\b",
    ),
]
_UPP_COMPILED = [(p, re.compile(rx, re.IGNORECASE)) for p, rx in _UPP_PATTERNS]

# A number followed by one of these is describing the product, not counting it.
# "2 Inch Ring Binders" is one binder; "5 Tab Dividers" is one set of dividers.
# Before this list existed, both were read as pack sizes and every one of them
# turned into a pack-size warning a person had to dismiss by hand.
_MEASUREMENT_WORDS = frozenset(
    {
        "inch", "inches", "in", "mm", "cm", "m", "ft", "feet", "foot", "yd", "yard",
        "lb", "lbs", "pound", "pounds", "oz", "ounce", "ounces", "fl", "ml", "l", "gal",
        "gsm", "ply", "mil", "mils", "gauge", "pt", "point", "watt", "watts", "v", "volt",
        "mah", "amp", "sided", "side", "x", "ring", "rings", "tab", "tabs", "divider",
        "dividers", "hole", "holes", "page", "pages", "page-yield", "yield", "degree",
        "degrees", "percent", "year", "years", "month", "months", "day", "days",
    }
)
_MEASUREMENT_MARKS = frozenset({'"', "'", "″", "′"})

# Phrases that actually count purchase units. A candidate whose phrase is not
# one of these is still shown in the review queue - "320 Sheets" is worth
# knowing - but it is not evidence that the confirmed pack size is wrong.
_PACK_PHRASE_WORDS = frozenset(
    {
        "pack", "packs", "pk", "pks", "count", "counts", "ct", "cnt", "pad", "pads",
        "box", "boxes", "bx", "carton", "cartons", "case", "set", "sets", "dozen",
        "pcs", "piece", "pieces", "roll", "rolls", "cartridge", "cartridges",
        "label", "labels", "insert", "inserts", "tag", "tags", "card", "cards",
        "envelope", "envelopes", "folder", "folders", "notebook", "notebooks",
        "pen", "pens", "marker", "markers", "bundle", "sleeve", "sleeves",
    }
)
_WORD = re.compile(r"[A-Za-z][A-Za-z'’-]*")


def is_pack_phrase(phrase: str) -> bool:
    """True when the phrase counts purchase units rather than describing one.

    "12/Pack" counts; "320 Sheets" describes what is in the one pack you buy.
    The distinction only matters when deciding whether a title contradicts a
    confirmed pack size - both still reach the reviewer.
    """
    words = {w.casefold() for w in _WORD.findall(str(phrase or ""))}
    return bool(words & _PACK_PHRASE_WORDS)


def _is_measurement(text: str, num_start: int, num_end: int) -> bool:
    """True when this number is a size, a model number or half a dimension."""
    before = text[:num_start]
    after = text[num_end:]

    # Glued to letters on the left: a model number such as PFI1000.
    if re.search(r"[A-Za-z]$", before):
        return True
    # A parenthesised bare number: a catalogue reference such as (38111).
    if before.endswith("(") and after.startswith(")"):
        return True
    # One side of a dimension: 9 x 12, 8.5 x 11.
    if re.search(r"(?:^|[\s(])[x×]\s*$", before, re.IGNORECASE):
        return True
    if re.match(r"\s*[x×](?:\s|$)", after, re.IGNORECASE):
        return True
    # Part of a decimal, as in the 5 of "8.5". A full stop that ends a word
    # ("Asst. 6 Pack") is not one, so the period must follow a digit.
    if re.search(r"\d\.$", before):
        return True

    m = re.match(r"\s*[-–]?\s*(\"|'|″|′|[A-Za-z][A-Za-z'’-]*)", after)
    if m:
        token = m.group(1)
        if token in _MEASUREMENT_MARKS:
            return True
        if token.casefold().rstrip(".") in _MEASUREMENT_WORDS:
            return True
    return False


def upp_candidates(title: str) -> list[tuple[int, str]]:
    """Pack sizes the title appears to state, as (value, phrase), in title order.

    Deliberately returns everything that looks like a count. A title such as
    "500 Sheets/Ream, 10 Reams/Carton" states two different numbers and only
    one of them is the purchase-unit multiplier; picking one here would be a
    silent guess that doubles or halves an item's ranking. Listing both is the
    review queue's job.

    What it does *not* return is a number that is plainly a measurement, a
    dimension or a model number. Those are not judgement calls a person needs
    to make - a binder is not sold in packs of two because it has two-inch
    rings - and offering them as candidates only buries the real ones.
    """
    text = str(title or "")
    if not text.strip():
        return []

    hits: list[tuple[int, int, int, str]] = []  # (start, priority, value, phrase)
    for priority, rx in _UPP_COMPILED:
        for m in rx.finditer(text):
            try:
                value = int(m.group(1))
            except (TypeError, ValueError):
                continue
            if not 0 < value <= 100000:
                continue
            if _is_measurement(text, *m.span(1)):
                continue
            hits.append((m.start(), priority, value, _tidy(m.group(0))))

    hits.sort(key=lambda h: (h[0], h[1]))
    out: list[tuple[int, str]] = []
    seen: set[int] = set()
    for _, _, value, phrase in hits:
        if value in seen:
            continue
        seen.add(value)
        out.append((value, phrase))
    return out


def _tidy(phrase: str) -> str:
    return re.sub(r"\s+", " ", phrase).strip(" ,;-")


def suggest_include(amazon_category: str | None, source: str) -> tuple[str, str]:
    """Propose ``y`` / ``n`` / blank for a new item, with the reason why.

    A blank is a real answer: it means the category is one nobody has ruled on,
    and the queue should ask rather than assume.
    """
    if str(source or "").strip().casefold() == "preferred":
        return "y", "Preferred is an office-supply vendor"

    category = str(amazon_category or "").strip()
    folded = re.sub(r"\s+", " ", category).casefold()
    if folded in _INCLUDE_FOLDED:
        return "y", f"category {category} is an office-supply category"
    if folded in _EXCLUDE_FOLDED:
        return "n", f"category {category} is not an office supply"
    if not category:
        return "", "no Amazon category on this line, needs a decision"
    return "", f"category {category} needs a decision"


def normalise_category(category: str | None) -> str:
    """A category value trimmed and case-folded, for comparing against the lists."""
    return re.sub(r"\s+", " ", str(category or "").strip()).casefold()


def category_is_known(category: str | None) -> bool:
    folded = normalise_category(category)
    return folded in _INCLUDE_FOLDED or folded in _EXCLUDE_FOLDED


def category_expected_include(category: str | None) -> str:
    """What the category alone would say: ``y``, ``n`` or blank."""
    folded = normalise_category(category)
    if folded in _INCLUDE_FOLDED:
        return "y"
    if folded in _EXCLUDE_FOLDED:
        return "n"
    return ""
