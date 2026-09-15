"""The AI proposal step: what it sends, what it refuses, and where the key comes from.

Nothing in here makes a network call. Every provider is driven by a canned
response out of ``tests/fixtures/propose/``, which is the same set of files the
Node suite reads, so the two ports are proved to build the same request and
parse the same reply into the same rows.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from conftest import YEAR, read_csv, read_header
from supplytrack import propose as P
from supplytrack.errors import SupplytrackError
from supplytrack.master import load_master
from supplytrack.review import REVIEW_COLUMNS, apply_queue, build_queue

SRC = Path(__file__).resolve().parent.parent
FIXTURES = SRC / "tests" / "fixtures" / "propose"
PY_PROMPT = SRC / "supplytrack" / "prompts" / "proposal.json"
WEB_PROMPT = SRC / "web" / "prompts" / "proposal.json"


def fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def queue_rows() -> list[dict]:
    return fixture("queue_rows.json")


@pytest.fixture(scope="module")
def existing_names() -> list[str]:
    return fixture("existing_names.json")


class FakeProvider:
    """A provider that answers from a list instead of from the network."""

    def __init__(self, replies, name="fake:model", batch_size=25):
        self.replies = list(replies)
        self.name = name
        self.model = "model"
        self.prompt = {"batch_size": batch_size}
        self.seen: list[list[dict]] = []

    def propose_batch(self, batch, existing_names):
        self.seen.append(list(batch))
        return self.replies.pop(0) if self.replies else []


# --------------------------------------------------------------- the prompt


def test_the_two_prompt_copies_are_byte_identical():
    py_bytes = PY_PROMPT.read_bytes()
    web_bytes = WEB_PROMPT.read_bytes()
    assert hashlib.sha256(py_bytes).hexdigest() == hashlib.sha256(web_bytes).hexdigest(), (
        "supplytrack/prompts/proposal.json and web/prompts/proposal.json have drifted. "
        "Edit one, copy it over the other; they are one file in two places."
    )


def test_the_prompt_has_the_fields_the_providers_need():
    doc = P.load_prompt()
    assert doc["batch_size"] == 25
    assert doc["output_schema"]["type"] == "object"
    assert "notes" in doc
    required = doc["output_schema"]["required"]
    assert "units_per_pack" in required and "confidence" in required


def test_the_prompt_states_the_rules_that_are_not_negotiable():
    system = P.load_prompt()["system"]
    for phrase in ("dozen", "ream", "Never invent a count", "null"):
        assert phrase in system


def test_no_em_dashes_anywhere_in_the_prompt():
    text = PY_PROMPT.read_text(encoding="utf-8")
    # Written as code points so this file stays free of them too.
    assert not any(chr(point) in text for point in (0x2014, 0x2013))


# -------------------------------------------------------------- the request


def test_the_anthropic_request_matches_the_shared_fixture(queue_rows, existing_names):
    provider = P.AnthropicProvider(model="claude-sonnet-5", api_key="")
    request = provider.build_request(queue_rows, existing_names)
    expected = fixture("anthropic_request.json")
    assert request.url == expected["url"]
    assert request.body == expected["body"]


def test_the_gemini_request_matches_the_shared_fixture(queue_rows, existing_names):
    provider = P.GeminiProvider(model="gemini-3.1-flash-lite", api_key="")
    request = provider.build_request(queue_rows, existing_names)
    expected = fixture("gemini_request.json")
    assert request.url == expected["url"]
    assert request.body == expected["body"]


def test_the_key_travels_in_a_header_and_never_in_the_body(queue_rows, existing_names):
    anthropic = P.AnthropicProvider(api_key="sk-secret-value").build_request(
        queue_rows, existing_names
    )
    gemini = P.GeminiProvider(api_key="sk-secret-value").build_request(
        queue_rows, existing_names
    )
    assert anthropic.headers["x-api-key"] == "sk-secret-value"
    assert gemini.headers["x-goog-api-key"] == "sk-secret-value"
    for request in (anthropic, gemini):
        assert "sk-secret-value" not in request.body_bytes().decode("utf-8")


def test_the_python_request_does_not_send_the_browser_header(queue_rows, existing_names):
    # Only a browser needs the direct-access opt-in; sending it from a script
    # would claim a risk this path does not take.
    request = P.AnthropicProvider(api_key="k").build_request(queue_rows, existing_names)
    assert "anthropic-dangerous-direct-browser-access" not in request.headers


@pytest.mark.parametrize("vendor", ["anthropic", "gemini"])
def test_the_body_carries_no_queue_column_outside_the_allow_list(
    vendor, queue_rows, existing_names
):
    """The one test that has to keep passing if nothing else does.

    Product titles and categories are the only firm data a model ever sees. An
    order's account user, email and payment columns are dropped at ingest, and
    the queue's own working columns (why a row is here, what a person noted
    about it) have no business leaving the building either.
    """
    provider = P.PROVIDERS[vendor](api_key="k")
    request = provider.build_request(queue_rows, existing_names)
    body = request.body_bytes().decode("utf-8")

    # The exact check: every key on every line sent, against the allow-list.
    # A scan for leaked strings can only catch the distinctive ones.
    if vendor == "anthropic":
        sent_text = request.body["messages"][0]["content"]
    else:
        sent_text = request.body["contents"][0]["parts"][0]["text"]
    sent = json.loads(sent_text)
    assert set(sent) == {"existing_canonical_names", "lines"}
    sent_keys = {name for line in sent["lines"] for name in line}
    assert sent_keys <= set(P.SENT_FIELDS), sorted(sent_keys - set(P.SENT_FIELDS))

    assert "@" not in body, "an address-shaped value reached the request body"

    banned = [c for c in REVIEW_COLUMNS if c not in P.SENT_FIELDS]
    for row in queue_rows:
        for column in banned:
            value = str(row.get(column) or "").strip()
            # Short or shared values (a bare "y", a name that is also the title)
            # would false-positive; the distinctive ones are what matter.
            if len(value) > 20 and value not in (row.get("raw_title") or ""):
                assert value not in body, f"{column} leaked into the request"

    assert "confidential-note-do-not-send" not in body


def test_a_row_the_queue_has_no_pack_code_for_simply_omits_it():
    payload = P.line_payload({"key": "amz:x", "source": "amazon", "raw_title": "Pens"})
    assert "pack_desc" not in payload
    assert payload == {"key": "amz:x", "source": "amazon", "raw_title": "Pens"}


def test_packs_in_year_is_sent_as_a_number():
    assert P.line_payload({"key": "k", "packs_in_year": "10"})["packs_in_year"] == 10
    assert "packs_in_year" not in P.line_payload({"key": "k", "packs_in_year": "many"})


# ------------------------------------------------------------- the response


def test_both_providers_parse_their_canned_reply_into_the_same_proposals():
    anthropic = P.AnthropicProvider(api_key="k").parse_response(
        fixture("anthropic_response.json")
    )
    gemini = P.GeminiProvider(api_key="k").parse_response(fixture("gemini_response.json"))
    assert anthropic == gemini == fixture("proposals.json")


def test_the_merged_rows_match_the_shared_fixture(queue_rows):
    expected = fixture("expected_rows.json")
    rows = P.merge_proposals(queue_rows, fixture("proposals.json"), expected["proposed_by"])
    assert rows == expected["rows"]


def test_a_proposal_for_a_key_that_was_never_sent_is_dropped(queue_rows):
    rows = P.merge_proposals(
        queue_rows,
        [
            {
                "key": "amz:this key was never in the batch",
                "include": "y",
                "units_per_pack": 99,
                "canonical_name": "Invented Item",
                "confidence": "high",
            }
        ],
        "fake:model",
    )
    assert [r["confidence"] for r in rows] == ["none"] * len(queue_rows)
    assert not any(r["canonical_name"] == "Invented Item" for r in rows)


def test_a_row_the_model_skipped_comes_back_unchanged_but_marked(queue_rows):
    rows = P.merge_proposals(queue_rows, [], "fake:model")
    for before, after in zip(queue_rows, rows):
        assert after["confidence"] == "none"
        # The run happened, so it is recorded, even where it produced nothing.
        assert after["proposed_by"] == "fake:model"
        for column in REVIEW_COLUMNS:
            assert after[column] == str(before.get(column, "") or "")


def test_a_pack_size_that_is_not_a_positive_whole_number_is_no_answer():
    for value in (0, -3, 2.5, "", None, "twelve", True, False):
        assert P.coerce_units(value) == ""
    assert P.coerce_units("12") == "12"
    assert P.coerce_units(12.0) == "12"


def test_a_null_pack_size_keeps_the_regex_suggestion_already_on_the_row():
    row = {
        "key": "k",
        "raw_title": "Avery Inserts, 200 Inserts",
        "units_per_pack": "200",
        "upp_candidates": "200 (200 Inserts)",
    }
    merged = P.merge_proposals(
        [row],
        [{"key": "k", "units_per_pack": None, "upp_reason": "cannot tell", "confidence": "low"}],
        "fake:model",
    )[0]
    assert merged["units_per_pack"] == "200"
    assert merged["upp_reason"] == "AI: cannot tell"


def test_an_unrecognised_confidence_word_is_treated_as_low():
    merged = P.merge_proposals(
        [{"key": "k"}], [{"key": "k", "confidence": "certain"}], "fake:model"
    )[0]
    assert merged["confidence"] == "low"


def test_an_answer_outside_the_allowed_values_is_ignored_not_written():
    merged = P.merge_proposals(
        [{"key": "k", "include": "y", "unit_label": "EA"}],
        [{"key": "k", "include": "maybe", "unit_label": "BOX", "confidence": "high"}],
        "fake:model",
    )[0]
    assert merged["include"] == "y"
    assert merged["unit_label"] == "EA"


def test_a_reply_in_a_shape_nobody_expected_yields_nothing_rather_than_guessing():
    assert P.AnthropicProvider(api_key="k").parse_response({"content": [{"type": "text"}]}) == []
    assert P.GeminiProvider(api_key="k").parse_response({}) == []
    with pytest.raises(SupplytrackError):
        P.GeminiProvider(api_key="k").parse_response(
            {"candidates": [{"content": {"parts": [{"text": "sorry, no"}]}}]}
        )


# ------------------------------------------------------------- the schemas


def test_the_gemini_schema_is_translated_not_passed_through():
    schema = P.gemini_schema(P.load_prompt()["output_schema"])
    assert schema["type"] == "OBJECT"
    assert "additionalProperties" not in schema
    units = schema["properties"]["units_per_pack"]
    assert units == {
        "type": "INTEGER",
        "nullable": True,
        "description": units["description"],
    }
    assert schema["properties"]["include"]["enum"] == ["y", "n"]


def test_the_anthropic_tool_is_strict_and_wraps_the_prompt_schema():
    tool = P.AnthropicProvider(api_key="k").tool()
    assert tool["strict"] is True
    assert tool["input_schema"]["additionalProperties"] is False
    assert tool["input_schema"]["properties"]["proposals"]["items"] == (
        P.load_prompt()["output_schema"]
    )


# -------------------------------------------------------------- batching


def test_the_queue_is_split_into_batches_of_the_size_asked_for():
    rows = [{"key": str(n)} for n in range(8)]
    assert [len(b) for b in P.batches(rows, 3)] == [3, 3, 2]
    assert [len(b) for b in P.batches(rows, 25)] == [8]
    assert P.batches([], 25) == []
    with pytest.raises(SupplytrackError):
        P.batches(rows, 0)


def test_propose_sends_one_request_per_batch_and_keeps_the_order():
    rows = [{"key": f"k{n}", "raw_title": f"Item {n}"} for n in range(5)]
    replies = [
        [{"key": "k0", "confidence": "high"}, {"key": "k1", "confidence": "high"}],
        [{"key": "k2", "confidence": "low"}, {"key": "k3", "confidence": "low"}],
        [{"key": "k4", "confidence": "medium"}],
    ]
    provider = FakeProvider(replies, name="fake:model")
    out = P.propose(rows, [], provider, batch_size=2)
    assert [len(b) for b in provider.seen] == [2, 2, 1]
    assert [r["key"] for r in out] == ["k0", "k1", "k2", "k3", "k4"]
    assert [r["confidence"] for r in out] == ["high", "high", "low", "low", "medium"]
    assert {r["proposed_by"] for r in out} == {"fake:model"}


def test_propose_falls_back_to_the_batch_size_in_the_prompt_file():
    rows = [{"key": str(n)} for n in range(7)]
    provider = FakeProvider([[], []], batch_size=4)
    P.propose(rows, [], provider)
    assert [len(b) for b in provider.seen] == [4, 3]


# ------------------------------------------------------------ key lookup


class FakeKeyring:
    def __init__(self, stored=None, raises=False):
        self.stored = stored or {}
        self.raises = raises
        self.asked: list[tuple[str, str]] = []

    def get_password(self, service, username):
        self.asked.append((service, username))
        if self.raises:
            raise RuntimeError("the credential store is locked")
        return self.stored.get((service, username))


def test_an_explicit_key_wins_over_everything():
    ring = FakeKeyring({("supplytrack", "anthropic"): "from-keyring"})
    key = P.resolve_key(
        "anthropic", api_key="explicit", env={"ANTHROPIC_API_KEY": "from-env"}, keyring_module=ring
    )
    assert key == "explicit"
    assert ring.asked == []


def test_the_environment_wins_over_the_credential_store():
    ring = FakeKeyring({("supplytrack", "anthropic"): "from-keyring"})
    key = P.resolve_key("anthropic", env={"ANTHROPIC_API_KEY": "from-env"}, keyring_module=ring)
    assert key == "from-env"
    assert ring.asked == []


def test_the_credential_store_is_asked_when_the_environment_is_empty():
    ring = FakeKeyring({("supplytrack", "gemini"): "from-keyring"})
    assert P.resolve_key("gemini", env={}, keyring_module=ring) == "from-keyring"
    assert ring.asked == [("supplytrack", "gemini")]


def test_a_locked_credential_store_is_not_a_crash(monkeypatch):
    with pytest.raises(SupplytrackError) as err:
        P.resolve_key("anthropic", env={}, keyring_module=FakeKeyring(raises=True))
    assert "ANTHROPIC_API_KEY" in str(err.value)


def test_no_key_anywhere_says_exactly_what_to_do():
    monkeyless = FakeKeyring()
    with pytest.raises(SupplytrackError) as err:
        P.resolve_key("gemini", env={}, keyring_module=monkeyless)
    message = str(err.value)
    assert "GEMINI_API_KEY" in message
    assert "keyring set supplytrack gemini" in message


def test_the_real_environment_is_used_when_none_is_passed(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "from-real-env")
    monkeypatch.setattr(P, "_import_keyring", lambda: None)
    assert P.resolve_key("anthropic") == "from-real-env"


def test_an_unknown_provider_is_refused():
    with pytest.raises(SupplytrackError):
        P.resolve_key("openai", env={"OPENAI_API_KEY": "x"})
    with pytest.raises(SupplytrackError):
        P.make_provider("openai")


# -------------------------------------------------------------------- cli


def write_queue(path: Path, rows: list[dict]) -> Path:
    import csv as _csv

    columns = list(dict.fromkeys([c for row in rows for c in row]))
    with Path(path).open("w", encoding="utf-8", newline="") as fh:
        writer = _csv.DictWriter(fh, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    return Path(path)


def test_a_dry_run_prints_the_batches_and_sends_nothing(tmp_path, capsys, queue_rows):
    def explode(request, timeout=0):  # pragma: no cover - must never be called
        raise AssertionError("a dry run sent a request")

    data_dir = tmp_path / "data"
    (data_dir / "2025").mkdir(parents=True)
    write_queue(data_dir / "2025" / "review_queue.csv", queue_rows)

    code = P.main(
        ["--year", "2025", "--data-dir", str(data_dir), "--batch-size", "3", "--dry-run"]
    )
    out = capsys.readouterr().out
    assert code == 0
    assert "batch 1: 3 row(s)" in out
    assert "batch 3: 2 row(s)" in out
    assert "Nothing was sent." in out
    assert not (data_dir / "2025" / "review_queue_proposed.csv").exists()


def test_a_dry_run_needs_no_api_key(tmp_path, monkeypatch, queue_rows):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(P, "_import_keyring", lambda: None)
    data_dir = tmp_path / "data"
    (data_dir / "2025").mkdir(parents=True)
    write_queue(data_dir / "2025" / "review_queue.csv", queue_rows)
    assert P.main(["--year", "2025", "--data-dir", str(data_dir), "--dry-run"]) == 0


def test_a_run_writes_the_proposed_queue_with_the_two_extra_columns(
    tmp_path, monkeypatch, capsys, queue_rows
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    sent: list[P.Request] = []

    def fake_transport(request, timeout=180.0):
        sent.append(request)
        return fixture("anthropic_response.json")

    monkeypatch.setattr(P, "urllib_transport", fake_transport)

    data_dir = tmp_path / "data"
    (data_dir / "2025").mkdir(parents=True)
    write_queue(data_dir / "2025" / "review_queue.csv", queue_rows)

    code = P.main(["--year", "2025", "--data-dir", str(data_dir)])
    assert code == 0
    out_path = data_dir / "2025" / "review_queue_proposed.csv"
    assert read_header(out_path) == P.PROPOSE_COLUMNS
    rows = read_csv(out_path)
    assert len(rows) == len(queue_rows)
    assert rows[0]["units_per_pack"] == "60"
    assert rows[0]["include_reason"].startswith("AI: ")
    assert rows[0]["proposed_by"] == "anthropic:claude-sonnet-5"
    assert len(sent) == 1
    assert sent[0].headers["x-api-key"] == "test-key"
    printed = capsys.readouterr().out
    assert "--apply" in printed and "--proposed" in printed


def test_only_blocking_leaves_the_unconfirmed_rows_alone(
    tmp_path, monkeypatch, capsys, queue_rows
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    seen: list[int] = []

    def fake_transport(request, timeout=180.0):
        body = json.loads(request.body_bytes().decode("utf-8"))
        seen.append(len(json.loads(body["messages"][0]["content"])["lines"]))
        return {"content": []}

    monkeypatch.setattr(P, "urllib_transport", fake_transport)
    data_dir = tmp_path / "data"
    (data_dir / "2025").mkdir(parents=True)
    write_queue(data_dir / "2025" / "review_queue.csv", queue_rows)

    assert P.main(["--year", "2025", "--data-dir", str(data_dir), "--only-blocking"]) == 0
    # One of the eight fixture rows is "pack size unconfirmed", so seven remain.
    assert seen == [7]
    # And the output file says out loud that it is only part of the queue.
    printed = capsys.readouterr().out
    assert "subset" in printed and "7 of the 8" in printed


def test_a_missing_queue_file_fails_with_a_plain_message(tmp_path, capsys):
    code = P.main(["--year", "2025", "--data-dir", str(tmp_path / "data")])
    assert code == 1
    assert "No such file" in capsys.readouterr().out


def test_the_provider_choice_shows_up_in_proposed_by(tmp_path, monkeypatch, queue_rows):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(
        P, "urllib_transport", lambda request, timeout=180.0: fixture("gemini_response.json")
    )
    data_dir = tmp_path / "data"
    (data_dir / "2025").mkdir(parents=True)
    write_queue(data_dir / "2025" / "review_queue.csv", queue_rows)

    P.main(["--year", "2025", "--data-dir", str(data_dir), "--provider", "gemini"])
    rows = read_csv(data_dir / "2025" / "review_queue_proposed.csv")
    assert {r["proposed_by"] for r in rows} == {"gemini:gemini-3.1-flash-lite"}


# --------------------------------------------------- back into the pipeline


def test_review_apply_tolerates_the_two_extra_columns(ingested, monkeypatch):
    """The whole point: a proposed queue goes straight back into `review --apply`.

    ``apply_queue`` only checks that the columns it needs are present, so the
    extra two ride along harmlessly. This proves it rather than assuming it.
    """
    queue = build_queue(ingested, YEAR)
    rows = read_csv(queue)
    proposals = [
        {
            "key": row["key"],
            "include": "y",
            "include_reason": "office supply",
            "units_per_pack": 12,
            "upp_reason": "pack of 12",
            "unit_label": "EA",
            "canonical_name": row["raw_title"],
            "canonical_reason": "the title, tidied",
            "confidence": "medium",
        }
        for row in rows
    ]
    provider = FakeProvider([proposals], name="anthropic:claude-sonnet-5", batch_size=100)
    proposed = P.propose(rows, [], provider)
    out_path = P.write_rows(Path(ingested) / f"{YEAR}" / "review_queue_proposed.csv", proposed)

    assert read_header(out_path) == P.PROPOSE_COLUMNS
    written = apply_queue(ingested, YEAR, out_path, proposed=True)
    assert written == len(rows)

    master = load_master(ingested)
    assert len(master) == len(rows)
    for row in rows:
        entry = master[row["key"]]
        assert entry.upp_source == "proposed"
        assert entry.units_per_pack == "12"
    # And a proposed pack size is still an unconfirmed one: every row comes
    # straight back into the queue for a person to look at.
    again = read_csv(build_queue(ingested, YEAR))
    assert len(again) == len(rows)
    assert {r["queue_reason"] for r in again} == {"pack size unconfirmed"}


def test_the_proposed_queue_keeps_the_review_columns_in_order():
    assert P.PROPOSE_COLUMNS[: len(REVIEW_COLUMNS)] == REVIEW_COLUMNS
    assert P.PROPOSE_COLUMNS[len(REVIEW_COLUMNS) :] == ["confidence", "proposed_by"]


def test_the_prompt_ships_inside_the_package_and_is_named_in_the_wheel():
    """The prompt is data the package reads at runtime, so it has to travel with it.

    ``load_prompt`` resolves the file from the package directory rather than
    from the current directory, and ``pyproject.toml`` names it as package data
    so it is not dropped from the wheel. Both halves are checked here because
    either one alone silently breaks an installed copy.
    """
    assert PY_PROMPT.parent.parent.name == "supplytrack"
    assert P.PROMPT_PATH == PY_PROMPT
    assert P.PROMPT_PATH.parent.parent == Path(P.__file__).resolve().parent
    pyproject = (SRC / "pyproject.toml").read_text(encoding="utf-8")
    assert "[tool.setuptools.package-data]" in pyproject
    assert 'supplytrack = ["prompts/*.json"]' in pyproject
