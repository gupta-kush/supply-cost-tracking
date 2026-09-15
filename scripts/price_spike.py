#!/usr/bin/env python3
"""Research spike: score a web-search-grounded Claude model against the office manager's
hand-checked vendor prices, to decide whether phase 2 price capture (spec
section 8, ``docs/spec.md``) should be an AI feature, a scraper, or stay
manual (see ``docs/brainstorm-inputs-and-ai-assist.md`` section 3, item 4).

For every row in ``prices.csv`` (one canonical item x one vendor), this asks
Claude to web-search that vendor's public US site for the item's current list
price, then compares the answer to what the office manager typed by hand in March 2026.
Rows she marked ``priced`` or ``not_available`` are the truth set; rows still
``unpriced`` or ``discontinued`` have nothing to check against and are scored
as ``no_truth`` (still looked up, so the run also previews what a full price
capture would find).

Talks to the Anthropic Messages API directly over ``urllib`` (standard
library only, no ``anthropic`` package) using the server-side web search tool
``web_search_20250305`` and, since v2, the web fetch tool ``web_fetch_20250910``
in the same request. Confirmed against the live docs on 2026-09-15:
https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool
https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools
Newer tool versions (``web_search_20260209``/``20260318``,
``web_fetch_20260209``/``20260309``/``20260318``) add dynamic filtering,
cache-bypass and response-inclusion controls that this spike does not need -
one search-and-fetch lookup per cell does not benefit from them, and the
basic tools keep the request shape simple and stay Zero Data Retention
eligible by default. Web search is $10 per 1,000 searches plus normal token
costs (unchanged from v1). Web fetch has no per-call fee, only standard token
costs for the fetched content - Anthropic's own sizing guide on the page
above: "Average web page (10 kB): ~2,500 tokens". Domain filtering
(``allowed_domains``) is documented in the server-tools page above: a bare
domain such as ``officedepot.com`` automatically covers its subdomains, so
per-vendor domains do not need to be listed separately. Token pricing for the
default model is from the bundled claude-api skill's cached model table
(dated 2026-06-24): Claude Sonnet 5 (``claude-sonnet-5``) is $2.00 / $10.00
per million tokens (input/output). Re-check both before relying on this for
a real budget.

v2 changes from the first live run (see ``data/2025/price-spike/diagnosis.md``):
Preferred (Pettus / Preferred Business Systems) is skipped by default - its
prices sit behind a login at pbsorder.com and were never reachable by search
(diagnosis section 1a); pass ``--vendors`` naming it to search it anyway.
``compute_unit_price()`` now divides by the model's own ``pack_size_found``
when it reports one, not blindly by the item master's pack size (diagnosis
section 2, rank 6/Staples). Each request restricts ``web_search`` to the
vendor's own domain and defaults ``max_uses`` to 1 (``--max-searches`` to
override), and adds a capped ``web_fetch`` call so the model can read the
product page it found instead of guessing from the search index's encrypted,
often-stale snapshot (diagnosis sections 1b and 4). The prompt names the
vendor's exact site, forbids third-party and other-retailer sources, asks
for the regular price rather than a member/sale/subscribe price, and
requires a pack size whenever a price is reported. A response that stops
(``stop_reason`` ``tool_use`` or ``max_tokens``) without a final answer is
recorded as ``no_answer`` and not retried (diagnosis section 3).

Does not call the ``anthropic`` SDK, does not talk to any vendor site itself,
and never writes the API key anywhere - it is read once per run and used only
in an HTTP request header.

Nothing here reads ``inbox/``. Real prices/ranked data (``data/2025/*.csv``)
is read only to build the request list and to score answers; its contents
are never written into this script, and results land under ``--out-dir``,
which defaults under the gitignored ``data/`` tree.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent.parent  # src/scripts -> src -> project root

DEFAULT_PRICES = PROJECT / "data" / "2025" / "prices.csv"
DEFAULT_OUT_DIR = PROJECT / "data" / "2025" / "price-spike"

# Duplicated from supplytrack/prices.py on purpose, same convention as
# scripts/bootstrap_2025.py: this script is meant to stand alone (run with
# `python scripts/price_spike.py`, no install/PYTHONPATH needed) rather than
# import the package. Keep in sync with supplytrack.prices.VENDORS /
# VALID_STATUSES if either changes.
VENDORS = ["Office Depot", "Preferred", "Amazon", "Staples"]
TRUTH_STATUSES = {"priced", "not_available"}

# v2: Preferred is skipped unless named explicitly with --vendors. Its prices
# sit behind a login at pbsorder.com (Pettus / Preferred Business Systems)
# and were never reachable by search - see diagnosis.md section 1a.
DEFAULT_VENDORS = [v for v in VENDORS if v != "Preferred"]

# Each vendor's own domain, used for both tools' allowed_domains so the model
# is confined to the vendor's own site (diagnosis.md section 2's "off"
# cells were mostly a wrong-source problem: Walmart, Staples Business
# Advantage, deal-aggregator sites). A bare domain covers its subdomains
# automatically, per
# https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools#domain-filtering
# ("Subdomains are automatically included") - no need to list www./m. etc.
# separately. pbsorder.com is included so --vendors Preferred still gets the
# domain restriction and the human-readable label below.
VENDOR_DOMAINS: dict[str, str] = {
    "Office Depot": "officedepot.com",
    "Staples": "staples.com",
    "Amazon": "amazon.com",
    "Preferred": "pbsorder.com",
}
# Human-readable site identification for the prompt (diagnosis.md section 1a:
# the model was never told what site "Preferred" refers to and guessed
# wrong domains every time). Falls back to the bare vendor name for any
# vendor not in this map.
VENDOR_SITE_LABEL: dict[str, str] = {
    "Office Depot": "officedepot.com",
    "Staples": "staples.com",
    "Amazon": "amazon.com",
    "Preferred": "pbsorder.com (Pettus / Preferred Business Systems)",
}

API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
WEB_SEARCH_TOOL_TYPE = "web_search_20250305"
# https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool
# retrieved 2026-09-15: base version, no per-call fee, ZDR-eligible by
# default. Dynamic filtering (20260209+) is not needed for one capped fetch.
WEB_FETCH_TOOL_TYPE = "web_fetch_20250910"
DEFAULT_MAX_SEARCHES = 1
WEB_FETCH_MAX_USES = 1
# Anthropic's own sizing guide: "Average web page (10 kB): ~2,500 tokens".
# 5,000 gives a product page room to be a bit larger than average while
# still bounding the worst case (diagnosis.md section 3's v2 cost estimate
# assumes 3,000-5,000 tokens landed per fetch).
WEB_FETCH_MAX_CONTENT_TOKENS = 5000
MAX_TOKENS = 4096
REQUEST_TIMEOUT_SECONDS = 90
MAX_ATTEMPTS = 3

# $ per million tokens (input, output). Source: claude-api skill's cached
# model table, dated 2026-06-24 - not independently re-verified against a
# live pricing page in this session. Add a model here before relying on the
# report's cost estimate for it; an unlisted --model still runs, it just
# skips the token-cost line.
MODEL_PRICING: dict[str, tuple[Decimal, Decimal]] = {
    "claude-sonnet-5": (Decimal("2.00"), Decimal("10.00")),
    "claude-haiku-4-5": (Decimal("1.00"), Decimal("5.00")),
    "claude-opus-5": (Decimal("5.00"), Decimal("25.00")),
}
# https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
# retrieved 2026-09-15: "$10 per 1,000 searches, plus standard token costs".
WEB_SEARCH_PRICE_PER_1000 = Decimal("10.00")

MATCH_THRESHOLD = Decimal("0.05")
CLOSE_THRESHOLD = Decimal("0.15")

RESULTS_HEADER = [
    "rank",
    "canonical_name",
    "vendor",
    "her_unit_price",
    "her_status",
    "model_pack_price",
    "model_pack_size",
    "master_pack_size",
    "pack_mismatch",
    "model_unit_price",
    "url",
    "verdict",
    "confidence",
    "note",
]

_STOPWORDS = {
    "the", "a", "an", "and", "or", "for", "of", "in", "on", "with", "to", "by",
    "pack", "packs", "each", "ea", "box", "boxes", "case", "cases", "set", "sets",
    "count", "ct", "pc", "pcs", "inch", "in", "x", "new",
}

_JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


@dataclass
class Cell:
    rank: str
    canonical_name: str
    vendor: str
    her_unit_price: Decimal | None
    her_status: str
    units_per_pack: int | None
    unit_label: str


# --------------------------------------------------------------------------
# Reading the inputs
# --------------------------------------------------------------------------


def _parse_her_price(raw: str | None) -> Decimal | None:
    """Same tolerance as supplytrack.prices._parse_unit_price: a leading '$'
    and thousands separators are fine, anything else is not a price."""
    text = (raw or "").strip()
    if not text:
        return None
    if text.startswith("$"):
        text = text[1:].strip()
    text = text.replace(",", "")
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def _load_units_per_pack(ranked_path: Path) -> dict[str, tuple[int | None, str]]:
    """canonical_name -> (units_per_pack, unit_label) from ranked.csv.

    Missing file or a blank units_per_pack (the merged-keys-disagree case,
    spec Appendix A) both just mean "unknown" here - the caller notes it on
    the affected row rather than guessing.
    """
    units_by_name: dict[str, tuple[int | None, str]] = {}
    if not ranked_path.exists():
        return units_by_name
    with ranked_path.open("r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            name = (row.get("canonical_name") or "").strip()
            raw_upp = (row.get("units_per_pack") or "").strip()
            upp: int | None
            try:
                upp = int(raw_upp) if raw_upp else None
            except ValueError:
                upp = None
            units_by_name[name] = (upp, (row.get("unit_label") or "").strip())
    return units_by_name


def load_cells(prices_path: Path, vendors: list[str] | None, limit: int | None) -> list[Cell]:
    """Build the request list from prices.csv, joined with ranked.csv (same
    directory) for units_per_pack. Every row in prices.csv is included
    regardless of status - discontinued/unpriced rows have no truth value
    to score against but are still worth looking up (see module docstring).
    """
    units_by_name = _load_units_per_pack(prices_path.parent / "ranked.csv")

    with prices_path.open("r", encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))

    vendor_filter = set(vendors) if vendors else None
    cells: list[Cell] = []
    for row in rows:
        vendor = (row.get("vendor") or "").strip()
        if vendor_filter is not None and vendor not in vendor_filter:
            continue
        name = (row.get("canonical_name") or "").strip()
        status = (row.get("status") or "").strip()
        upp, unit_label = units_by_name.get(name, (None, ""))
        her_price = _parse_her_price(row.get("unit_price")) if status == "priced" else None
        cells.append(
            Cell(
                rank=(row.get("rank") or "").strip(),
                canonical_name=name,
                vendor=vendor,
                her_unit_price=her_price,
                her_status=status,
                units_per_pack=upp,
                unit_label=unit_label,
            )
        )

    if limit is not None:
        cells = cells[:limit]
    return cells


# --------------------------------------------------------------------------
# The prompt
# --------------------------------------------------------------------------


def build_prompt(cell: Cell) -> str:
    site_label = VENDOR_SITE_LABEL.get(cell.vendor, cell.vendor)
    pack_hint = ""
    if cell.units_per_pack:
        pack_hint = (
            f" The office's own records normally buy this item in packs of "
            f"{cell.units_per_pack} {cell.unit_label or 'each'}, but the vendor may sell "
            f"a different pack size today - report the pack size you actually find, do "
            f"not assume it matches."
        )
    return (
        f"Search {site_label} - {cell.vendor}'s own site, and only that site - for the "
        f"current list price of this exact product:\n\n\"{cell.canonical_name}\"\n\n"
        "If web search finds a matching product page, use web_fetch to open that exact "
        "page and read the price and pack size directly from it, rather than answering "
        "from the search results alone.\n\n"
        "Find the price of the pack or case as it is actually sold on the site (not a "
        f"per-unit price unless that is literally how it is priced), and the pack size: "
        f"how many individual units are in that pack. Report the pack size shown on the "
        f"page whenever you report a price - do not leave pack_size_found null just "
        f"because it does not match what was expected.{pack_hint}\n\n"
        "Reply with a single JSON object and nothing else - no markdown fences, no "
        "words before or after it - in exactly this shape:\n"
        '{"price": <number or null>, "currency": "USD", "url": <string or null>, '
        '"product_title_found": <string or null>, "pack_size_found": <number or null>, '
        '"confidence": "high" | "medium" | "low", "note": <one short sentence>}\n\n'
        "Rules:\n"
        "- Set price to null if you cannot find this exact product for sale at this "
        "vendor, or the vendor does not carry it. Do not substitute a different "
        "product's price.\n"
        f"- Use only {site_label}. Do not price this from a different retailer, even if "
        "it carries the identical product (for example, do not use Walmart, Amazon or "
        "any other site for an Office Depot lookup). Do not use a third-party "
        "marketplace seller listing, a deal-aggregator or price-tracking site, or a "
        "business/contract-pricing portal separate from the vendor's own consumer "
        "retail site.\n"
        "- Report the regular list price shown to an ordinary visitor. Do not report a "
        "members-only price, a limited-time sale or clearance price, or a discounted "
        "subscribe-and-save price.\n"
        "- product_title_found should be the title or name exactly as shown on the page "
        "you used, so a person can tell whether it is really the same product.\n"
        "- note should say in one short sentence what you found, or why you could not."
    )


# --------------------------------------------------------------------------
# The API key
# --------------------------------------------------------------------------


def get_api_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key

    try:
        import keyring  # type: ignore[import-not-found]
    except ImportError:
        keyring = None  # type: ignore[assignment]

    if keyring is not None:
        try:
            key = keyring.get_password("supplytrack", "anthropic")
        except Exception:
            key = None
        if key:
            return key

    raise SystemExit(
        "No Anthropic API key found. Set one of these before running live:\n"
        "  - Environment variable ANTHROPIC_API_KEY, for example:\n"
        "      (PowerShell) $env:ANTHROPIC_API_KEY = 'sk-ant-...'\n"
        "      (bash)       export ANTHROPIC_API_KEY='sk-ant-...'\n"
        "  - Windows Credential Manager, via the optional `keyring` package:\n"
        "      pip install keyring\n"
        "      keyring set supplytrack anthropic\n"
        "    (service 'supplytrack', username 'anthropic' - this script reads it back "
        "with keyring.get_password('supplytrack', 'anthropic') if ANTHROPIC_API_KEY "
        "is not set).\n"
        "The key is never written to disk by this script."
    )


# --------------------------------------------------------------------------
# Calling the API
# --------------------------------------------------------------------------


def build_tools(cell: Cell, max_searches: int) -> list[dict[str, Any]]:
    """The web_search + web_fetch tool blocks for one cell's request.

    Both tools go in the same request's ``tools`` array - the web-fetch-tool
    docs' own "Combined search and fetch" example does exactly this, so v2
    does not need a second request (see the module docstring for the doc
    URLs). Each tool is restricted to the vendor's own domain
    (``VENDOR_DOMAINS``) so the model cannot substitute a different
    retailer's price (diagnosis.md section 2). web_search defaults to a
    single search (``--max-searches`` to override); web_fetch is capped at
    one fetch and a bounded content size, since this only ever needs to read
    the one product page web_search already located.
    """
    domain = VENDOR_DOMAINS.get(cell.vendor)
    search_tool: dict[str, Any] = {
        "type": WEB_SEARCH_TOOL_TYPE,
        "name": "web_search",
        "max_uses": max_searches,
    }
    fetch_tool: dict[str, Any] = {
        "type": WEB_FETCH_TOOL_TYPE,
        "name": "web_fetch",
        "max_uses": WEB_FETCH_MAX_USES,
        "max_content_tokens": WEB_FETCH_MAX_CONTENT_TOKENS,
    }
    if domain:
        search_tool["allowed_domains"] = [domain]
        fetch_tool["allowed_domains"] = [domain]
    return [search_tool, fetch_tool]


def call_anthropic(
    model: str, prompt: str, api_key: str, tools: list[dict[str, Any]]
) -> dict[str, Any]:
    body = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        # Low effort: this is a single factual lookup, not multi-step
        # reasoning, so the extra thinking budget higher efforts spend is
        # wasted cost here (see the claude-api skill's cost-optimization
        # guidance: chat/classification-shaped tasks do well at low effort).
        "output_config": {"effort": "low"},
        "tools": tools,
        "messages": [{"role": "user", "content": prompt}],
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=data,
        method="POST",
        headers={
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        },
    )

    last_error = "unknown error"
    for attempt in range(MAX_ATTEMPTS):
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            if exc.code == 429 or exc.code >= 500:
                last_error = f"HTTP {exc.code}: {error_body}"
                time.sleep(2**attempt)
                continue
            raise RuntimeError(f"HTTP {exc.code} from the Anthropic API: {error_body}") from exc
        except urllib.error.URLError as exc:
            last_error = str(exc.reason)
            time.sleep(2**attempt)

    raise RuntimeError(f"Anthropic API request failed after {MAX_ATTEMPTS} attempts: {last_error}")


# --------------------------------------------------------------------------
# Reading the model's answer back out of a raw response
# --------------------------------------------------------------------------


def _strip_fences(text: str) -> str:
    return _JSON_FENCE_RE.sub("", text).strip()


def _find_json_object(text: str) -> str | None:
    """First balanced {...} in text, string-aware so a brace inside a quoted
    value does not break the count."""
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


_EMPTY_ANSWER = {
    "price": None,
    "currency": None,
    "url": None,
    "product_title_found": None,
    "pack_size_found": None,
    "confidence": "low",
    "note": "",
}


def extract_model_answer(response: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """Returns (answer, parse_note). ``parse_note`` is empty on a clean parse,
    otherwise it explains what went wrong and ``answer`` is a safe empty
    stand-in - the caller never has to special-case "could not parse"
    separately from "the model said not found".
    """
    stop_reason = response.get("stop_reason")
    if stop_reason == "pause_turn":
        return (
            dict(_EMPTY_ANSWER),
            "the search paused (stop_reason=pause_turn) before finishing; this script "
            "does not resume a paused turn, so the cell was not resolved",
        )

    content = response.get("content") or []
    text_parts = [
        block.get("text", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    combined = "\n".join(t for t in text_parts if t).strip()

    if combined:
        candidates = [combined, _strip_fences(combined)]
        json_sub = _find_json_object(combined)
        if json_sub:
            candidates.append(json_sub)

        for candidate in candidates:
            try:
                parsed = json.loads(candidate)
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(parsed, dict):
                return parsed, ""

    # No usable final JSON. If the turn stopped because a tool call was left
    # hanging (stop_reason "tool_use" with no client tool in this script's
    # request - see diagnosis.md section 3: two cells exhausted max_uses and
    # the turn ended mid-flow with no final text at all) or the response was
    # cut off by the token limit ("max_tokens"), say so plainly instead of
    # falling through to a generic parse-failure message - this is a known,
    # diagnosable failure mode, not retried (cost control), and distinct
    # from "the model answered but the text wasn't JSON".
    if stop_reason in ("tool_use", "max_tokens"):
        return (
            dict(_EMPTY_ANSWER),
            f"the model stopped ({stop_reason}) before producing a final answer, likely "
            "after exhausting the search/fetch budget or hitting the token limit "
            "mid-search; not retried",
        )

    if not combined:
        return dict(_EMPTY_ANSWER), "the model returned no text content to parse"

    preview = combined[:200]
    return dict(_EMPTY_ANSWER), f"could not parse a JSON answer from the model's reply: {preview!r}"


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------


def _significant_tokens(text: str) -> set[str]:
    raw = re.split(r"[^a-z0-9]+", text.lower())
    return {t for t in raw if t and t not in _STOPWORDS and not t.isdigit()}


def looks_like_wrong_product(canonical_name: str, title_found: str | None) -> bool:
    """Simple token-overlap heuristic, not a real product match - it exists to
    flag a likely mismatch for a person to look at, not to decide anything on
    its own. Deliberately conservative: no title, or too few significant
    tokens on either side, means "cannot tell" rather than "wrong"."""
    if not title_found:
        return False
    a = _significant_tokens(canonical_name)
    b = _significant_tokens(title_found)
    if not a or not b:
        return False
    overlap = len(a & b)
    return (overlap / min(len(a), len(b))) < 0.25


def _to_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None


def compute_unit_price(
    pack_price: Decimal | None,
    model_pack_size: int | None,
    units_per_pack: int | None,
) -> Decimal | None:
    """Per-unit price from the model's own pack price.

    Divides by the model's own ``pack_size_found`` when it reported one -
    that is the pack the price actually belongs to - falling back to the
    item master's ``units_per_pack`` only when the model gave no pack size
    at all. Fixes the v1 bug (diagnosis.md section 2, rank 6/Staples): a
    model that finds a single box ($7.19, pack size 1) when the master
    expects a 36-box case must not have that $7.19 divided by 36 - the
    result ($0.1997) was never a real per-unit price. Dividing by the
    model's own pack size instead ($7.19/1) gives a genuine, if still badly
    mismatched, per-unit figure - the pack_mismatch flag in score_cell is
    what tells a person the comparison itself is apples-to-oranges.
    """
    divisor = model_pack_size if model_pack_size else units_per_pack
    if pack_price is None or not divisor:
        return None
    try:
        return (pack_price / Decimal(divisor)).quantize(Decimal("0.0001"))
    except (InvalidOperation, ZeroDivisionError):
        return None


def _fmt_decimal(value: Decimal | None) -> str:
    return "" if value is None else str(value)


def score_cell(cell: Cell, answer: dict[str, Any], parse_note: str) -> dict[str, Any]:
    """One row of results.csv. Verdict precedence (first match wins):

    no_answer        - the model's reply could not be read as an answer at all
    wrong_product    - product_title_found looks like a different product
    no_truth         - her_status is not priced/not_available, nothing to score against
    data_error       - her_status is priced but prices.csv has no readable unit_price
    model_not_found  - she had a price, the model found none
    not_found_both   - she had not_available, the model also found none
    model_found      - she had not_available, the model found a price
    match/close/off  - both have a price; how close they are, per unit
    """
    model_price = _to_decimal(answer.get("price"))
    raw_pack_size = answer.get("pack_size_found")
    try:
        model_pack_size = int(raw_pack_size) if raw_pack_size is not None else None
    except (TypeError, ValueError):
        model_pack_size = None
    model_unit_price = compute_unit_price(model_price, model_pack_size, cell.units_per_pack)
    title_found = answer.get("product_title_found")

    pack_mismatch = (
        model_pack_size is not None
        and cell.units_per_pack is not None
        and model_pack_size != cell.units_per_pack
    )

    notes: list[str] = []
    model_note = (answer.get("note") or "").strip()
    if model_note:
        notes.append(model_note)
    if parse_note:
        notes.append(parse_note)
    if pack_mismatch:
        notes.append(
            f"pack size mismatch: model found a pack of {model_pack_size}, the item "
            f"master says {cell.units_per_pack}"
        )
    if cell.units_per_pack is None and model_price is not None:
        notes.append("units_per_pack is unknown for this item; cannot compute a per-unit price")

    if parse_note:
        verdict = "no_answer"
    elif looks_like_wrong_product(cell.canonical_name, title_found):
        verdict = "wrong_product"
    elif cell.her_status not in TRUTH_STATUSES:
        verdict = "no_truth"
    elif cell.her_status == "priced" and cell.her_unit_price is None:
        verdict = "data_error"
        notes.append("prices.csv has status priced but no readable unit_price")
    elif cell.her_status == "priced" and model_price is None:
        verdict = "model_not_found"
    elif cell.her_status == "not_available" and model_price is None:
        verdict = "not_found_both"
    elif cell.her_status == "not_available" and model_price is not None:
        verdict = "model_found"
    elif model_unit_price is None:
        verdict = "off"
        notes.append("could not compute the model's per-unit price to compare against hers")
    else:
        diff = abs(model_unit_price - cell.her_unit_price) / cell.her_unit_price  # type: ignore[operator]
        if diff <= MATCH_THRESHOLD:
            verdict = "match"
        elif diff <= CLOSE_THRESHOLD:
            verdict = "close"
        else:
            verdict = "off"

    return {
        "rank": cell.rank,
        "canonical_name": cell.canonical_name,
        "vendor": cell.vendor,
        "her_unit_price": _fmt_decimal(cell.her_unit_price),
        "her_status": cell.her_status,
        "model_pack_price": _fmt_decimal(model_price),
        "model_pack_size": "" if model_pack_size is None else str(model_pack_size),
        "master_pack_size": "" if cell.units_per_pack is None else str(cell.units_per_pack),
        "pack_mismatch": "true" if pack_mismatch else "false",
        "model_unit_price": _fmt_decimal(model_unit_price),
        "url": answer.get("url") or "",
        "verdict": verdict,
        "confidence": answer.get("confidence") or "",
        "note": "; ".join(notes),
        "_usage": {},  # filled in by the caller, who has the raw response
    }


# --------------------------------------------------------------------------
# The three run modes
# --------------------------------------------------------------------------


def run_dry(cells: list[Cell]) -> None:
    for cell in cells:
        print(f"--- rank {cell.rank} | {cell.canonical_name} | {cell.vendor} ---")
        print(build_prompt(cell))
        print()
    print(f"{len(cells)} request(s) would be sent.")


def run_live(
    cells: list[Cell], model: str, out_dir: Path, max_searches: int = DEFAULT_MAX_SEARCHES
) -> list[dict[str, Any]]:
    api_key = get_api_key()
    raw_dir = out_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    results = []
    for i, cell in enumerate(cells, start=1):
        print(f"[{i}/{len(cells)}] {cell.canonical_name} @ {cell.vendor} ...", file=sys.stderr)
        prompt = build_prompt(cell)
        tools = build_tools(cell, max_searches)
        response = call_anthropic(model, prompt, api_key, tools)
        raw_path = raw_dir / f"{cell.rank}-{cell.vendor}.json"
        raw_path.write_text(json.dumps(response, indent=2), encoding="utf-8")
        answer, parse_note = extract_model_answer(response)
        row = score_cell(cell, answer, parse_note)
        row["_usage"] = response.get("usage", {}) or {}
        results.append(row)
    return results


def run_replay(cells: list[Cell], replay_dir: Path) -> list[dict[str, Any]]:
    results = []
    for cell in cells:
        raw_path = Path(replay_dir) / f"{cell.rank}-{cell.vendor}.json"
        if not raw_path.exists():
            row = score_cell(cell, {}, f"no saved raw response found: {raw_path.name}")
            results.append(row)
            continue
        response = json.loads(raw_path.read_text(encoding="utf-8"))
        answer, parse_note = extract_model_answer(response)
        row = score_cell(cell, answer, parse_note)
        row["_usage"] = response.get("usage", {}) or {}
        results.append(row)
    return results


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------


def write_results_csv(results: list[dict[str, Any]], out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "results.csv"
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=RESULTS_HEADER, extrasaction="ignore")
        writer.writeheader()
        for row in results:
            writer.writerow({k: row.get(k, "") for k in RESULTS_HEADER})
    return path


def summarize_cost(
    results: list[dict[str, Any]], model: str, vendor: str | None = None
) -> dict[str, Any]:
    """Cost summary across ``results``, or just one vendor's rows when
    ``vendor`` is given (used for the per-vendor breakdown in the report).
    Web fetch has no per-call fee (see the module docstring), so
    ``total_fetches`` is reported for visibility only and does not add to
    the cost.
    """
    if vendor is not None:
        results = [r for r in results if r.get("vendor") == vendor]

    total_in = sum(int(r.get("_usage", {}).get("input_tokens", 0) or 0) for r in results)
    total_out = sum(int(r.get("_usage", {}).get("output_tokens", 0) or 0) for r in results)
    total_searches = sum(
        int(r.get("_usage", {}).get("server_tool_use", {}).get("web_search_requests", 0) or 0)
        for r in results
    )
    total_fetches = sum(
        int(r.get("_usage", {}).get("server_tool_use", {}).get("web_fetch_requests", 0) or 0)
        for r in results
    )
    search_cost = (Decimal(total_searches) / Decimal(1000)) * WEB_SEARCH_PRICE_PER_1000

    pricing = MODEL_PRICING.get(model)
    token_cost = None
    if pricing:
        in_price, out_price = pricing
        token_cost = (Decimal(total_in) / Decimal(1_000_000)) * in_price + (
            Decimal(total_out) / Decimal(1_000_000)
        ) * out_price

    return {
        "total_input_tokens": total_in,
        "total_output_tokens": total_out,
        "total_searches": total_searches,
        "total_fetches": total_fetches,
        "search_cost": search_cost,
        "token_cost": token_cost,
        "total_cost": (search_cost + token_cost) if token_cost is not None else None,
    }


def write_report(results: list[dict[str, Any]], out_dir: Path, model: str, mode: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "report.md"

    scored = [r for r in results if r["verdict"] != "no_truth"]
    reference = [r for r in results if r["verdict"] == "no_truth"]

    verdict_order = [
        "match", "close", "off", "wrong_product", "not_found_both",
        "model_not_found", "model_found", "no_answer", "data_error",
    ]

    lines: list[str] = []
    lines.append("# Price spike report")
    lines.append("")
    lines.append(f"Model: {model}")
    lines.append(f"Mode: {mode}")
    lines.append(f"Cells processed: {len(results)}")
    lines.append(f"Cells scored against a recorded price or not-available: {len(scored)}")
    lines.append(f"Cells with no recorded price to check against: {len(reference)}")
    lines.append("")

    lines.append("## What changed from v1")
    lines.append("")
    lines.append(
        "Preferred is skipped by default (manual or login-based, not searched - see "
        "below); pass --vendors to include it. compute_unit_price now divides by the "
        "model's own pack_size_found when it reports one, with the item master's "
        "units_per_pack used only as a fallback, and a pack_mismatch flag recorded when "
        "the two disagree. Each request restricts web_search to the vendor's own domain "
        "and defaults max_uses to 1 (--max-searches to override), and adds a capped "
        "web_fetch call so the model can read the product page it found instead of "
        "guessing from the search index. The prompt names the vendor's exact site, "
        "forbids third-party and other-retailer sources, asks for the regular price "
        "rather than a member, sale or subscribe price, and requires a pack size "
        "whenever a price is reported. A response that stops (stop_reason tool_use or "
        "max_tokens) without a final answer is now recorded as no_answer with the "
        "reason, and is not retried."
    )
    lines.append("")

    vendors_present = {r["vendor"] for r in results}
    lines.append("## Vendors not searched this run")
    lines.append("")
    if "Preferred" not in vendors_present:
        lines.append(
            "- Preferred (Pettus / Preferred Business Systems, pbsorder.com): manual or "
            "login-based, not searched."
        )
    else:
        lines.append("None - every vendor in VENDORS was searched this run.")
    lines.append("")

    lines.append("## Accuracy summary")
    lines.append("")
    header = "| Vendor | " + " | ".join(verdict_order) + " | total |"
    sep = "|---|" + "---|" * (len(verdict_order) + 1)
    lines.append(header)
    lines.append(sep)
    per_vendor: dict[str, dict[str, int]] = {v: {k: 0 for k in verdict_order} for v in VENDORS}
    for row in scored:
        vendor = row["vendor"]
        if vendor not in per_vendor:
            per_vendor[vendor] = {k: 0 for k in verdict_order}
        if row["verdict"] in per_vendor[vendor]:
            per_vendor[vendor][row["verdict"]] += 1
    for vendor in VENDORS:
        counts = per_vendor.get(vendor, {k: 0 for k in verdict_order})
        total = sum(counts.values())
        lines.append(
            f"| {vendor} | " + " | ".join(str(counts[k]) for k in verdict_order) + f" | {total} |"
        )
    overall = {k: sum(per_vendor.get(v, {}).get(k, 0) for v in per_vendor) for k in verdict_order}
    lines.append(
        "| Overall | " + " | ".join(str(overall[k]) for k in verdict_order)
        + f" | {sum(overall.values())} |"
    )
    lines.append("")

    cost = summarize_cost(results, model)
    lines.append("## Cost of this run")
    lines.append("")
    lines.append(
        f"- Web searches: {cost['total_searches']}, at $10 per 1,000 searches: "
        f"${cost['search_cost']:.4f}"
    )
    lines.append(f"- Web fetches: {cost['total_fetches']} (no per-call fee, tokens only)")
    lines.append(
        f"- Tokens: {cost['total_input_tokens']} in, {cost['total_output_tokens']} out"
    )
    if cost["token_cost"] is not None:
        lines.append(f"- Estimated token cost at {model} rates: ${cost['token_cost']:.4f}")
        lines.append(f"- Estimated total: ${cost['total_cost']:.4f}")
    else:
        lines.append(
            f"- No pricing on file for model '{model}', token cost left out of the total."
        )
    lines.append("")
    lines.append(
        "Pricing sources: the web search and web fetch tool docs "
        "(https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool, "
        "https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool, "
        "retrieved 2026-09-15) and the claude-api skill's cached model table (dated "
        "2026-06-24). Check current rates before using this for a real budget."
    )
    lines.append("")

    lines.append("### Cost by vendor")
    lines.append("")
    lines.append("| Vendor | Searches | Fetches | Input tokens | Output tokens | Cost |")
    lines.append("|---|---|---|---|---|---|")
    for vendor in [v for v in VENDORS if v in vendors_present]:
        vcost = summarize_cost(results, model, vendor=vendor)
        cost_str = f"${vcost['total_cost']:.4f}" if vcost["total_cost"] is not None else "n/a"
        lines.append(
            f"| {vendor} | {vcost['total_searches']} | {vcost['total_fetches']} | "
            f"{vcost['total_input_tokens']} | {vcost['total_output_tokens']} | {cost_str} |"
        )
    lines.append("")

    lines.append("### Input tokens per request")
    lines.append("")
    input_token_counts = [
        int(r.get("_usage", {}).get("input_tokens", 0) or 0) for r in results
    ]
    if input_token_counts:
        lines.append("| Min | Median | Max |")
        lines.append("|---|---|---|")
        lines.append(
            f"| {min(input_token_counts)} | "
            f"{statistics.median(input_token_counts):.0f} | "
            f"{max(input_token_counts)} |"
        )
    else:
        lines.append("No requests processed.")
    lines.append("")

    review = [r for r in scored if r["verdict"] not in ("match", "not_found_both")]
    lines.append("## Cells to check by hand")
    lines.append("")
    if review:
        lines.append("| Rank | Item | Vendor | Verdict | Confidence | URL |")
        lines.append("|---|---|---|---|---|---|")
        for row in review:
            lines.append(
                f"| {row['rank']} | {row['canonical_name']} | {row['vendor']} | "
                f"{row['verdict']} | {row['confidence']} | {row['url']} |"
            )
    else:
        lines.append("None. Every scored cell matched or agreed the item was not available.")
    lines.append("")

    lines.append("## Reference only, no recorded price to check against")
    lines.append("")
    if reference:
        ref_counts: dict[str, int] = {}
        for row in reference:
            ref_counts[row["vendor"]] = ref_counts.get(row["vendor"], 0) + 1
        for vendor in VENDORS:
            if vendor in ref_counts:
                lines.append(f"- {vendor}: {ref_counts[vendor]}")
        lines.append(
            "These rows still have a model answer in results.csv (status was unpriced or "
            "discontinued in prices.csv, so there was nothing typed by hand to compare "
            "against). They could seed the price template instead of starting blank."
        )
    else:
        lines.append("None - every cell in this run had a recorded price or not-available status.")
    lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")
    return path


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Score a web-search-grounded Claude model's vendor price lookups against "
            "the office manager's hand-checked prices.csv, to decide phase 2 (see docs/spec.md "
            "section 8 and docs/brainstorm-inputs-and-ai-assist.md section 3)."
        )
    )
    parser.add_argument("--prices", type=Path, default=DEFAULT_PRICES, help="Path to prices.csv.")
    parser.add_argument(
        "--out-dir", type=Path, default=DEFAULT_OUT_DIR,
        help="Where raw/, results.csv and report.md are written.",
    )
    parser.add_argument(
        "--vendors", type=str, default=None,
        help=(
            f"Comma-separated subset of {VENDORS}. Default: {DEFAULT_VENDORS} - "
            "Preferred is skipped by default (manual or login-based; its prices sit "
            "behind a login at pbsorder.com, see diagnosis.md section 1a). Name it "
            "explicitly to search it anyway."
        ),
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Cap the number of cells processed (after --vendors), for a cheap test run.",
    )
    parser.add_argument("--model", type=str, default="claude-sonnet-5")
    parser.add_argument(
        "--max-searches", type=int, default=DEFAULT_MAX_SEARCHES,
        help=(
            f"web_search max_uses per cell (default {DEFAULT_MAX_SEARCHES}). Input "
            "tokens scale superlinearly with searches used - see diagnosis.md section 3."
        ),
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print the prompts that would be sent and how many, without calling the API.",
    )
    parser.add_argument(
        "--replay", type=Path, default=None,
        help=(
            "Directory of previously saved raw/<rank>-<vendor>.json responses (the "
            "out-dir/raw folder from an earlier live run). Scores from these instead "
            "of calling the API; no key is needed."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if args.vendors:
        vendors = [v.strip() for v in args.vendors.split(",") if v.strip()]
        unknown = [v for v in vendors if v not in VENDORS]
        if unknown:
            parser.error(f"unknown vendor(s) {unknown}; choose from {VENDORS}")
    else:
        # Preferred is skipped unless named explicitly - see DEFAULT_VENDORS.
        vendors = DEFAULT_VENDORS

    if not args.prices.exists():
        parser.error(f"prices file not found: {args.prices}")

    cells = load_cells(args.prices, vendors, args.limit)
    if not cells:
        print("No cells to process - check --prices, --vendors and --limit.")
        return 1

    if args.dry_run:
        run_dry(cells)
        return 0

    if args.replay:
        results = run_replay(cells, args.replay)
        mode = "replay"
    else:
        results = run_live(cells, args.model, args.out_dir, args.max_searches)
        mode = "live"

    results_path = write_results_csv(results, args.out_dir)
    report_path = write_report(results, args.out_dir, args.model, mode)
    print(f"Wrote {results_path}")
    print(f"Wrote {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
