"""Stage 2a (optional): ask a model to propose answers for the review queue.

The review queue already arrives with regex suggestions and a reason for each
one. What it cannot do is read a title the way a person does: "dozen" is 12, a
carton of paper is counted in reams, and two listings a year apart are the same
pen. For the 2025 run a Claude Code session worked those out by hand, 84 pack
sizes of them. This module makes that repeatable.

What it is not is a shortcut past the review. Everything here writes into the
suggestion columns of a queue file, prefixing each reason with ``AI:`` so the
person reading it can see which answers came from a model, and adds a
``confidence`` and a ``proposed_by`` column so they know how sure it claimed to
be and what produced it. Applying the result still goes through
``review --apply``; applying it with ``--proposed`` records
``upp_source = proposed``, which keeps every one of those rows in the queue, in
the validator's warnings and on the report's Sources sheet until a person
actually confirms it.

Two providers are implemented, both over ``urllib`` so the package keeps its
single dependency: the Anthropic Messages API (forced tool use against a
strict JSON schema) and Google Gemini (``responseSchema``). The prompt itself
is not in this file. It lives in ``prompts/proposal.json`` so the browser port
can load the identical bytes.

Only these queue fields are ever sent: ``key``, ``source``, ``raw_title``,
``amazon_category``, ``pack_desc`` when the caller has one, ``packs_in_year``
and ``upp_candidates``, plus the list of canonical names already in use. The
export's account user, email and payment columns are dropped at ingest and have
no path into a prompt; ``tests/test_propose.py`` asserts the request body holds
nothing else.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from .errors import SupplytrackError
from .master import default_data_dir, load_master, year_dir
from .review import BLOCKING_REASONS, REVIEW_COLUMNS

# The queue columns plus the two this stage adds. ``confidence`` is what the
# model said about its own answer; ``proposed_by`` is what produced the row, so
# a queue that has been through two different models can still be read.
PROPOSE_COLUMNS = [*REVIEW_COLUMNS, "confidence", "proposed_by"]

# The allow-list. Nothing outside this reaches a provider.
SENT_FIELDS = (
    "key",
    "source",
    "raw_title",
    "amazon_category",
    "pack_desc",
    "packs_in_year",
    "upp_candidates",
)

PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "proposal.json"

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

DEFAULT_MODELS = {
    "anthropic": "claude-sonnet-5",
    "gemini": "gemini-3.1-flash-lite",
}
# The cheap option per provider, for a first pass over a long queue.
CHEAP_MODELS = {
    "anthropic": "claude-haiku-4-5-20251001",
    "gemini": "gemini-3.1-flash-lite",
}
ENV_VARS = {"anthropic": "ANTHROPIC_API_KEY", "gemini": "GEMINI_API_KEY"}
KEYRING_SERVICE = "supplytrack"
VENDORS = ("anthropic", "gemini")

TOOL_NAME = "record_proposals"
MAX_TOKENS = 8000

_VALID_INCLUDE = ("y", "n")
_VALID_LABELS = ("EA", "RM")
_VALID_CONFIDENCE = ("high", "medium", "low")
_REASON_PREFIX = "AI: "


# ------------------------------------------------------------------- prompt


def load_prompt(path: Path | None = None) -> dict:
    """Read ``prompts/proposal.json``: the one source of truth for the prompt.

    The browser port loads a byte-identical copy from ``web/prompts/``. Both
    test suites assert the two files match, so a change made in one place
    cannot quietly diverge in the other.
    """
    prompt_path = Path(path) if path is not None else PROMPT_PATH
    if not prompt_path.exists():
        raise SupplytrackError(
            f"No prompt file at {prompt_path}. It ships with the package; reinstall supplytrack."
        )
    try:
        doc = json.loads(prompt_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SupplytrackError(f"{prompt_path} is not readable JSON: {exc}") from exc
    for field_name in ("system", "output_schema", "batch_size"):
        if field_name not in doc:
            raise SupplytrackError(f"{prompt_path} is missing the {field_name!r} field.")
    return doc


# ------------------------------------------------------- what gets sent out


def line_payload(row: dict) -> dict:
    """One queue row reduced to the fields a provider is allowed to see."""
    out: dict[str, object] = {}
    for name in SENT_FIELDS:
        value = row.get(name)
        text = "" if value is None else str(value).strip()
        if not text:
            continue
        if name == "packs_in_year":
            try:
                out[name] = int(float(text))
            except ValueError:
                continue
        else:
            out[name] = text
    return out


def build_payload(batch: list[dict], existing_names: list[str]) -> dict:
    """The user message content: the batch, plus the names already in use."""
    return {
        "existing_canonical_names": [str(n) for n in existing_names],
        "lines": [line_payload(row) for row in batch],
    }


def payload_text(payload: dict) -> str:
    """The payload as the exact JSON string both ports put in the message.

    ``indent=2`` with ASCII escaping off is what ``JSON.stringify(x, null, 2)``
    produces, character for character, which is what lets one request fixture
    prove both ports build the same body.
    """
    return json.dumps(payload, indent=2, ensure_ascii=False)


def batches(rows: list[dict], size: int) -> list[list[dict]]:
    """Split the queue into batches of at most ``size`` rows."""
    if size <= 0:
        raise SupplytrackError(f"Batch size must be a positive number, not {size}.")
    return [rows[i : i + size] for i in range(0, len(rows), size)]


# ------------------------------------------------------------------- keys


def _import_keyring():  # pragma: no cover - exercised through monkeypatching
    """The optional Windows Credential Manager backend, or None."""
    try:
        import keyring  # type: ignore
    except Exception:
        return None
    return keyring


def resolve_key(
    vendor: str,
    api_key: str | None = None,
    env: dict | None = None,
    keyring_module=None,
) -> str:
    """Find the API key: explicit argument, then environment, then keyring.

    The key is returned, never stored, never logged and never written to any
    file this package produces.
    """
    vendor = _check_vendor(vendor)
    if api_key and str(api_key).strip():
        return str(api_key).strip()

    environ = os.environ if env is None else env
    from_env = str(environ.get(ENV_VARS[vendor], "") or "").strip()
    if from_env:
        return from_env

    module = _import_keyring() if keyring_module is None else keyring_module
    if module is not None:
        try:
            stored = module.get_password(KEYRING_SERVICE, vendor)
        except Exception:  # a locked or broken backend is not a hard failure
            stored = None
        if stored and str(stored).strip():
            return str(stored).strip()

    raise SupplytrackError(
        f"No {vendor} API key. Set the {ENV_VARS[vendor]} environment variable, or store one "
        f"with: keyring set {KEYRING_SERVICE} {vendor}"
    )


def _check_vendor(vendor: str) -> str:
    folded = str(vendor or "").strip().casefold()
    if folded not in VENDORS:
        raise SupplytrackError(
            f"Unknown provider {vendor!r}. Use one of: {', '.join(VENDORS)}."
        )
    return folded


# --------------------------------------------------------------- transport


@dataclass
class Request:
    """One outgoing call, built before anything is sent so it can be inspected."""

    url: str
    body: dict
    headers: dict = field(default_factory=dict)
    method: str = "POST"

    def body_bytes(self) -> bytes:
        return json.dumps(self.body, ensure_ascii=False).encode("utf-8")

    def size(self) -> int:
        return len(self.body_bytes())


def urllib_transport(request: Request, timeout: float = 180.0) -> dict:
    """Send a request with the standard library and return the parsed JSON."""
    req = urllib.request.Request(
        request.url,
        data=request.body_bytes(),
        headers=dict(request.headers),
        method=request.method,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as fh:
            return json.loads(fh.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace").strip()[:400]
        raise SupplytrackError(
            f"The provider refused the request ({exc.code}). {detail}"
        ) from exc
    except urllib.error.URLError as exc:
        raise SupplytrackError(f"Could not reach the provider: {exc.reason}") from exc
    except ValueError as exc:
        raise SupplytrackError(f"The provider's reply was not JSON: {exc}") from exc


# --------------------------------------------------------------- providers


def gemini_schema(schema: dict) -> dict:
    """Translate the prompt's JSON schema into what Gemini accepts.

    Gemini takes an OpenAPI-flavoured subset: upper-case type names, no
    ``additionalProperties``, and nullability as a flag rather than a union.
    """
    if not isinstance(schema, dict):
        return schema

    out: dict[str, object] = {}
    raw_type = schema.get("type")
    types = [raw_type] if isinstance(raw_type, str) else list(raw_type or [])
    nullable = "null" in types
    concrete = [t for t in types if t != "null"]
    if concrete:
        out["type"] = str(concrete[0]).upper()
    if nullable:
        out["nullable"] = True
    for name in ("description", "enum"):
        if name in schema:
            out[name] = schema[name]
    if "properties" in schema:
        out["properties"] = {k: gemini_schema(v) for k, v in schema["properties"].items()}
    if "items" in schema:
        out["items"] = gemini_schema(schema["items"])
    if "required" in schema:
        out["required"] = list(schema["required"])
    return out


class Provider:
    """A model behind one request shape. Subclasses build and parse; this batches."""

    vendor = ""

    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
        prompt: dict | None = None,
        transport=None,
    ):
        self.model = str(model or DEFAULT_MODELS[self.vendor])
        self.prompt = prompt if prompt is not None else load_prompt()
        # Held on the instance only, never written out, never logged.
        self._api_key = api_key
        self._transport = transport or urllib_transport

    @property
    def name(self) -> str:
        """What goes in ``proposed_by``, e.g. ``anthropic:claude-sonnet-5``."""
        return f"{self.vendor}:{self.model}"

    def build_request(self, batch: list[dict], existing_names: list[str]) -> Request:
        raise NotImplementedError

    def parse_response(self, payload: dict) -> list[dict]:
        raise NotImplementedError

    def propose_batch(self, batch: list[dict], existing_names: list[str]) -> list[dict]:
        request = self.build_request(batch, existing_names)
        return self.parse_response(self._transport(request))


class AnthropicProvider(Provider):
    """Anthropic Messages API, forced tool use against the prompt's schema.

    A tool with ``strict`` set is the narrowest way to get one object per row
    back: the model cannot answer in prose, and the arguments are validated
    against the schema before they reach us.
    """

    vendor = "anthropic"

    def tool(self) -> dict:
        return {
            "name": TOOL_NAME,
            "description": "Record one proposal for every purchase line in this batch.",
            "strict": True,
            "input_schema": {
                "type": "object",
                "properties": {
                    "proposals": {
                        "type": "array",
                        "description": "One entry per line, in the order they were given.",
                        "items": self.prompt["output_schema"],
                    }
                },
                "required": ["proposals"],
                "additionalProperties": False,
            },
        }

    def build_request(self, batch: list[dict], existing_names: list[str]) -> Request:
        body = {
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "system": self.prompt["system"],
            "messages": [
                {
                    "role": "user",
                    "content": payload_text(build_payload(batch, existing_names)),
                }
            ],
            "tools": [self.tool()],
            "tool_choice": {"type": "tool", "name": TOOL_NAME},
        }
        headers = {
            "content-type": "application/json",
            "anthropic-version": ANTHROPIC_VERSION,
            "x-api-key": self._api_key or "",
        }
        return Request(url=ANTHROPIC_URL, body=body, headers=headers)

    def parse_response(self, payload: dict) -> list[dict]:
        blocks = (payload or {}).get("content") or []
        for block in blocks:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use" and block.get("name") == TOOL_NAME:
                proposals = (block.get("input") or {}).get("proposals")
                if isinstance(proposals, list):
                    return [p for p in proposals if isinstance(p, dict)]
        return []


class GeminiProvider(Provider):
    """Google Gemini, ``responseSchema`` with a JSON response type."""

    vendor = "gemini"

    def build_request(self, batch: list[dict], existing_names: list[str]) -> Request:
        body = {
            "systemInstruction": {"parts": [{"text": self.prompt["system"]}]},
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": payload_text(build_payload(batch, existing_names))}
                    ],
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": {
                    "type": "ARRAY",
                    "description": "One entry per line, in the order they were given.",
                    "items": gemini_schema(self.prompt["output_schema"]),
                },
            },
        }
        headers = {
            "content-type": "application/json",
            "x-goog-api-key": self._api_key or "",
        }
        return Request(url=GEMINI_URL.format(model=self.model), body=body, headers=headers)

    def parse_response(self, payload: dict) -> list[dict]:
        candidates = (payload or {}).get("candidates") or []
        for candidate in candidates:
            parts = ((candidate or {}).get("content") or {}).get("parts") or []
            text = "".join(str(p.get("text") or "") for p in parts if isinstance(p, dict))
            if not text.strip():
                continue
            try:
                parsed = json.loads(text)
            except ValueError as exc:
                raise SupplytrackError(
                    f"Gemini returned text that is not JSON: {exc}"
                ) from exc
            if isinstance(parsed, dict):
                parsed = parsed.get("proposals") or []
            if isinstance(parsed, list):
                return [p for p in parsed if isinstance(p, dict)]
        return []


PROVIDERS = {"anthropic": AnthropicProvider, "gemini": GeminiProvider}


def make_provider(
    vendor: str,
    model: str | None = None,
    api_key: str | None = None,
    prompt: dict | None = None,
    transport=None,
    env: dict | None = None,
    keyring_module=None,
) -> Provider:
    """Build a provider, resolving the key in the documented order."""
    folded = _check_vendor(vendor)
    key = resolve_key(folded, api_key=api_key, env=env, keyring_module=keyring_module)
    return PROVIDERS[folded](model=model, api_key=key, prompt=prompt, transport=transport)


# ----------------------------------------------------------------- merging


def coerce_units(value) -> str:
    """A pack size as a positive whole number in string form, or "" when it is not one."""
    if value is None or isinstance(value, bool):
        return ""
    text = str(value).strip()
    if not text:
        return ""
    try:
        number = float(text)
    except ValueError:
        return ""
    if number <= 0 or number != int(number):
        return ""
    return str(int(number))


def _reason(text) -> str:
    cleaned = str(text or "").strip()
    return f"{_REASON_PREFIX}{cleaned}" if cleaned else ""


def merge_proposals(batch: list[dict], proposals: list[dict], proposed_by: str) -> list[dict]:
    """Fold a model's answers into the queue rows it was asked about.

    Three rules hold the line. A proposal whose key was not in the batch is
    dropped, because a model inventing a row is exactly the failure this whole
    pipeline exists to prevent. A pack size that is not a positive whole number
    is treated as no answer, and the regex suggestion already on the row
    stands. A row the model said nothing about comes back untouched with
    ``confidence`` of ``none``, so it is visibly unanswered rather than
    silently blank.
    """
    by_key: dict[str, dict] = {}
    allowed = {str(row.get("key") or "") for row in batch}
    for proposal in proposals:
        key = str((proposal or {}).get("key") or "").strip()
        if key and key in allowed and key not in by_key:
            by_key[key] = proposal

    out: list[dict] = []
    for row in batch:
        merged = {column: str(row.get(column, "") or "") for column in REVIEW_COLUMNS}
        proposal = by_key.get(str(row.get("key") or ""))
        merged["proposed_by"] = proposed_by

        if proposal is None:
            merged["confidence"] = "none"
            out.append(merged)
            continue

        include = str(proposal.get("include") or "").strip().casefold()
        if include in _VALID_INCLUDE:
            merged["include"] = include
        include_reason = _reason(proposal.get("include_reason"))
        if include_reason:
            merged["include_reason"] = include_reason

        units = coerce_units(proposal.get("units_per_pack"))
        if units:
            merged["units_per_pack"] = units
        upp_reason = _reason(proposal.get("upp_reason"))
        if upp_reason:
            merged["upp_reason"] = upp_reason

        label = str(proposal.get("unit_label") or "").strip().upper()
        if label in _VALID_LABELS:
            merged["unit_label"] = label

        canonical = str(proposal.get("canonical_name") or "").strip()
        if canonical:
            merged["canonical_name"] = canonical
        canonical_reason = _reason(proposal.get("canonical_reason"))
        if canonical_reason:
            merged["canonical_reason"] = canonical_reason

        confidence = str(proposal.get("confidence") or "").strip().casefold()
        merged["confidence"] = confidence if confidence in _VALID_CONFIDENCE else "low"
        out.append(merged)
    return out


def propose(
    queue_rows: list[dict],
    existing_names: list[str],
    provider: Provider,
    model: str | None = None,
    batch_size: int | None = None,
) -> list[dict]:
    """Propose answers for every queue row; returns rows with the two extra columns.

    ``model`` is accepted for callers that want to override what the provider
    was built with. ``batch_size`` defaults to the number in the prompt file.
    """
    if model:
        provider.model = str(model)
    size = int(batch_size or provider.prompt.get("batch_size") or 25)
    rows = [dict(row) for row in queue_rows]
    out: list[dict] = []
    for batch in batches(rows, size):
        proposals = provider.propose_batch(batch, list(existing_names))
        out.extend(merge_proposals(batch, proposals, provider.name))
    return out


# ------------------------------------------------------------------- files


def read_queue(path: Path) -> list[dict]:
    """Read a review queue, keeping every column it happens to carry."""
    path = Path(path)
    if not path.exists():
        raise SupplytrackError(
            f"No such file: {path}. Run `supplytrack review --year <year>` first."
        )
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        names = reader.fieldnames or []
        missing = [c for c in ("key", "raw_title") if c not in names]
        if missing:
            raise SupplytrackError(
                f"{path.name} is missing the column(s): {', '.join(missing)}. "
                "Use the review_queue.csv the review command wrote."
            )
        return [{k: (v or "") for k, v in row.items() if k} for row in reader]


def write_rows(path: Path, rows: list[dict]) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=PROPOSE_COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow({c: row.get(c, "") for c in PROPOSE_COLUMNS})
    return path


def existing_canonical_names(data_dir: Path) -> list[str]:
    """Every canonical name already in the item master, first seen order kept."""
    names: list[str] = []
    seen: set[str] = set()
    master = load_master(data_dir)
    for key in sorted(master):
        name = (master[key].canonical_name or "").strip()
        if name and name not in seen:
            seen.add(name)
            names.append(name)
    return names


def only_blocking(rows: list[dict]) -> list[dict]:
    """Just the rows that stop the build: unknown keys and missing pack sizes."""
    return [r for r in rows if (r.get("queue_reason") or "").strip() in BLOCKING_REASONS]


# --------------------------------------------------------------------- cli


DESCRIPTION = (
    "Ask a model to propose review-queue answers. Writes a second queue file with the "
    "suggestion columns filled in, each reason prefixed 'AI:', plus confidence and "
    "proposed_by columns. Nothing is applied to the item master; that still goes through "
    "`supplytrack review --apply`."
)


def add_arguments(parser: argparse.ArgumentParser, common: bool = True) -> None:
    """Define this command's arguments on ``parser``.

    Both entry points call this, so ``supplytrack propose`` and
    ``python -m supplytrack.propose`` cannot drift apart. ``common=False``
    leaves out ``--year`` and ``--data-dir`` for a parser that already has
    them, which is how ``cli.py`` builds its subcommands.
    """
    if common:
        parser.add_argument(
            "--year", required=True, type=int, help="the reporting year, e.g. 2025"
        )
        parser.add_argument(
            "--data-dir",
            type=Path,
            default=None,
            help=(
                "where the item master and yearly files live "
                "(default: SUPPLYTRACK_DATA or ./data)"
            ),
        )
    parser.add_argument(
        "--provider",
        default="anthropic",
        choices=list(VENDORS),
        help="which API to ask (default: anthropic)",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="model id (default: %s for anthropic, %s for gemini)"
        % (DEFAULT_MODELS["anthropic"], DEFAULT_MODELS["gemini"]),
    )
    parser.add_argument("--in", dest="in_path", type=Path, default=None,
                        help="the queue to read (default: data/<year>/review_queue.csv)")
    parser.add_argument("--out", dest="out_path", type=Path, default=None,
                        help="where to write (default: data/<year>/review_queue_proposed.csv)")
    parser.add_argument("--only-blocking", action="store_true",
                        help="only rows that stop the build: unknown key, pack size missing")
    parser.add_argument("--dry-run", action="store_true",
                        help="print what would be sent, per batch, and stop")
    parser.add_argument("--batch-size", type=int, default=None,
                        help="rows per request (default: the number in the prompt file)")


def main(argv: list[str] | None = None) -> int:
    """``python -m supplytrack.propose --year 2025 --provider anthropic``.

    The same command is available as ``supplytrack propose``; both build their
    arguments with :func:`add_arguments` and run :func:`run_from_args`, so
    there is one implementation and two ways in.
    """
    parser = argparse.ArgumentParser(
        prog="python -m supplytrack.propose", description=DESCRIPTION
    )
    add_arguments(parser)
    args = parser.parse_args(argv)
    try:
        return run_from_args(args)
    except SupplytrackError as exc:
        print(f"FAIL {exc}")
        return 1


def run_from_args(args) -> int:
    """Do the work for parsed arguments. Raises ``SupplytrackError`` on a hard failure."""
    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    out_dir = year_dir(data_dir, args.year)
    in_path = Path(args.in_path) if args.in_path else out_dir / "review_queue.csv"
    out_path = Path(args.out_path) if args.out_path else out_dir / "review_queue_proposed.csv"

    rows = read_queue(in_path)
    total_rows = len(rows)
    if args.only_blocking:
        rows = only_blocking(rows)
    if not rows:
        print(f"Nothing to propose: {in_path} has no rows to work on.")
        return 0

    prompt = load_prompt()
    size = int(args.batch_size or prompt.get("batch_size") or 25)
    names = existing_canonical_names(data_dir)
    model = args.model or DEFAULT_MODELS[args.provider]

    if args.dry_run:
        # Built with an empty key: a dry run never sends anything, so it must
        # not require a key to be present either.
        provider = PROVIDERS[args.provider](model=model, api_key="", prompt=prompt)
        total = 0
        groups = batches(rows, size)
        for number, batch in enumerate(groups, start=1):
            request = provider.build_request(batch, names)
            total += request.size()
            print(f"batch {number}: {len(batch)} row(s), {request.size()} bytes")
        print(
            f"{len(rows)} row(s) in {len(groups)} batch(es), {total} bytes total, "
            f"to {provider.name}. Nothing was sent."
        )
        return 0

    provider = make_provider(args.provider, model=model, prompt=prompt)
    proposed = propose(rows, names, provider, batch_size=size)
    write_rows(out_path, proposed)

    counts: dict[str, int] = {}
    for row in proposed:
        counts[row["confidence"]] = counts.get(row["confidence"], 0) + 1
    summary = ", ".join(f"{n} {label}" for label, n in sorted(counts.items()))
    print(f"Wrote {out_path} - {len(proposed)} row(s) from {provider.name} ({summary}).")
    if len(proposed) < total_rows:
        # A file named review_queue_proposed.csv that silently holds part of the
        # queue is the kind of thing somebody applies whole. Say so.
        print(
            f"This is a subset: --only-blocking kept {len(proposed)} of the {total_rows} row(s) "
            f"in {in_path.name}. The rest are untouched and still in the queue."
        )
    print(
        "Read it, correct what is wrong, then apply it: "
        f"supplytrack review --year {args.year} --apply {out_path} --proposed"
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
