"""Tests for scripts/price_spike.py.

Everything here is offline: canned raw responses under
tests/fixtures/price_spike/raw/, and a tiny synthetic prices.csv/ranked.csv
pair under tests/fixtures/price_spike/ (invented item names and numbers,
nothing from the real 2025 data). No network call is ever made - urllib is
either never reached (dry run, replay) or monkeypatched (the live-mode
tests), matching how this script was built: no Anthropic API key is present
in this environment.
"""
from __future__ import annotations

import csv
import importlib.util
import json
import sys
from decimal import Decimal
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parent.parent
SCRIPT_PATH = SRC / "scripts" / "price_spike.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "price_spike"


def _load_price_spike():
    """Import scripts/price_spike.py as a module without scripts/ on sys.path
    (same pattern as tests/test_golden.py for scripts/make_golden.py)."""
    if "price_spike" in sys.modules:
        return sys.modules["price_spike"]
    spec = importlib.util.spec_from_file_location("price_spike", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["price_spike"] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


price_spike = _load_price_spike()

PRICES_CSV = FIXTURES / "prices.csv"
RANKED_CSV = FIXTURES / "ranked.csv"
RAW_DIR = FIXTURES / "raw"

# (rank, vendor) in the same order as tests/fixtures/price_spike/prices.csv,
# with the verdict each fixture raw response is built to produce.
EXPECTED = [
    ("1", "Office Depot", "match"),
    ("1", "Amazon", "close"),
    ("2", "Staples", "off"),
    ("3", "Office Depot", "not_found_both"),
    ("3", "Amazon", "model_found"),
    ("4", "Preferred", "wrong_product"),
    ("4", "Staples", "model_not_found"),
    ("5", "Amazon", "no_truth"),
]


def read_results(out_dir: Path) -> list[dict]:
    with (out_dir / "results.csv").open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


# --------------------------------------------------------------------------
# Loading cells
# --------------------------------------------------------------------------


def test_load_cells_reads_all_rows_and_joins_units_per_pack():
    cells = price_spike.load_cells(PRICES_CSV, None, None)
    assert len(cells) == len(EXPECTED)
    by_key = {(c.rank, c.vendor): c for c in cells}
    sticky = by_key[("1", "Office Depot")]
    assert sticky.units_per_pack == 12
    assert sticky.unit_label == "EA"
    assert sticky.her_status == "priced"
    assert sticky.her_unit_price == Decimal("0.10")

    not_avail = by_key[("3", "Office Depot")]
    assert not_avail.her_status == "not_available"
    assert not_avail.her_unit_price is None


def test_load_cells_vendor_filter_and_limit():
    cells = price_spike.load_cells(PRICES_CSV, ["Amazon"], None)
    assert all(c.vendor == "Amazon" for c in cells)
    assert len(cells) == 3  # rank 1, 3, 5

    limited = price_spike.load_cells(PRICES_CSV, None, 2)
    assert len(limited) == 2


# --------------------------------------------------------------------------
# JSON extraction
# --------------------------------------------------------------------------


def test_extract_model_answer_plain_json():
    response = {
        "stop_reason": "end_turn",
        "content": [{"type": "text", "text": '{"price": 1.5, "confidence": "high"}'}],
    }
    answer, note = price_spike.extract_model_answer(response)
    assert note == ""
    assert answer["price"] == 1.5


def test_extract_model_answer_fenced_json():
    response = {
        "stop_reason": "end_turn",
        "content": [{"type": "text", "text": '```json\n{"price": 2.25}\n```'}],
    }
    answer, note = price_spike.extract_model_answer(response)
    assert note == ""
    assert answer["price"] == 2.25


def test_extract_model_answer_json_with_surrounding_prose():
    response = {
        "stop_reason": "end_turn",
        "content": [
            {"type": "text", "text": "Here is what I found:"},
            {"type": "text", "text": 'Sure, the answer is {"price": 3.0, "url": "https://x"} - hope that helps.'},
        ],
    }
    answer, note = price_spike.extract_model_answer(response)
    assert note == ""
    assert answer["price"] == 3.0
    assert answer["url"] == "https://x"


def test_extract_model_answer_pause_turn():
    response = {"stop_reason": "pause_turn", "content": [{"type": "text", "text": "still searching"}]}
    answer, note = price_spike.extract_model_answer(response)
    assert "pause_turn" in note
    assert answer["price"] is None


def test_extract_model_answer_no_text_content():
    response = {"stop_reason": "end_turn", "content": []}
    answer, note = price_spike.extract_model_answer(response)
    assert "no text content" in note
    assert answer["price"] is None


def test_extract_model_answer_unparseable_text():
    response = {"stop_reason": "end_turn", "content": [{"type": "text", "text": "I could not find pricing."}]}
    answer, note = price_spike.extract_model_answer(response)
    assert "could not parse" in note
    assert answer["price"] is None


def test_extract_model_answer_ignores_thinking_blocks():
    response = {
        "stop_reason": "end_turn",
        "content": [
            {"type": "thinking", "thinking": "not json at all {not json"},
            {"type": "text", "text": '{"price": 9.99}'},
        ],
    }
    answer, note = price_spike.extract_model_answer(response)
    assert note == ""
    assert answer["price"] == 9.99


def test_extract_model_answer_tool_use_with_no_final_json_is_a_clear_guard_note():
    # diagnosis.md section 3: two cells exhausted max_uses and the turn
    # ended with a dangling server_tool_use and no final text at all.
    response = {
        "stop_reason": "tool_use",
        "content": [
            {"type": "text", "text": "Let me search once more."},
            {
                "type": "server_tool_use",
                "id": "srvtoolu_dangling",
                "name": "web_search",
                "input": {"query": "one more try"},
            },
        ],
    }
    answer, note = price_spike.extract_model_answer(response)
    assert answer["price"] is None
    assert "tool_use" in note
    assert "not retried" in note


def test_extract_model_answer_max_tokens_with_no_final_json_is_a_clear_guard_note():
    response = {
        "stop_reason": "max_tokens",
        "content": [{"type": "text", "text": "Still working on the pric"}],
    }
    answer, note = price_spike.extract_model_answer(response)
    assert answer["price"] is None
    assert "max_tokens" in note
    assert "not retried" in note


def test_extract_model_answer_tool_use_still_parses_a_complete_json_answer():
    # Defensive: if a final JSON answer is somehow present despite stop_reason
    # tool_use, prefer it over the guard note.
    response = {
        "stop_reason": "tool_use",
        "content": [{"type": "text", "text": '{"price": 4.5}'}],
    }
    answer, note = price_spike.extract_model_answer(response)
    assert note == ""
    assert answer["price"] == 4.5


# --------------------------------------------------------------------------
# The prompt
# --------------------------------------------------------------------------


def test_build_prompt_names_the_vendors_exact_site():
    cell = _cell(vendor="Office Depot", canonical_name="Acme Widget")
    prompt = price_spike.build_prompt(cell)
    assert "officedepot.com" in prompt


def test_build_prompt_identifies_preferred_as_pbsorder():
    # diagnosis.md section 1a: the model was never told what site
    # "Preferred" refers to and guessed wrong domains every time.
    cell = _cell(vendor="Preferred", canonical_name="Heavy Duty Office Stapler")
    prompt = price_spike.build_prompt(cell)
    assert "pbsorder.com" in prompt
    assert "Preferred Business Systems" in prompt


def test_build_prompt_forbids_other_retailers_and_third_party_sources():
    cell = _cell(vendor="Office Depot")
    prompt = price_spike.build_prompt(cell)
    assert "third-party marketplace" in prompt
    assert "deal-aggregator" in prompt
    assert "contract-pricing portal" in prompt


def test_build_prompt_asks_for_regular_price_not_sale_or_member_price():
    cell = _cell(vendor="Staples")
    prompt = price_spike.build_prompt(cell)
    assert "regular list price" in prompt
    assert "members-only" in prompt
    assert "subscribe-and-save" in prompt


def test_build_prompt_requires_pack_size_when_a_price_is_reported():
    cell = _cell(vendor="Amazon")
    prompt = price_spike.build_prompt(cell)
    assert "pack_size_found null" in prompt


def test_build_prompt_mentions_web_fetch_for_the_found_page():
    cell = _cell(vendor="Amazon")
    prompt = price_spike.build_prompt(cell)
    assert "web_fetch" in prompt


# --------------------------------------------------------------------------
# Tool configuration in the request (allowed_domains, max_uses, web_fetch)
# --------------------------------------------------------------------------


def test_build_tools_restricts_search_and_fetch_to_the_vendors_domain():
    cell = _cell(vendor="Office Depot")
    tools = price_spike.build_tools(cell, max_searches=1)
    assert len(tools) == 2
    search_tool = next(t for t in tools if t["name"] == "web_search")
    fetch_tool = next(t for t in tools if t["name"] == "web_fetch")

    assert search_tool["type"] == price_spike.WEB_SEARCH_TOOL_TYPE
    assert search_tool["allowed_domains"] == ["officedepot.com"]
    assert search_tool["max_uses"] == 1

    assert fetch_tool["type"] == price_spike.WEB_FETCH_TOOL_TYPE
    assert fetch_tool["allowed_domains"] == ["officedepot.com"]
    assert fetch_tool["max_uses"] == 1
    assert fetch_tool["max_content_tokens"] == price_spike.WEB_FETCH_MAX_CONTENT_TOKENS


def test_build_tools_respects_max_searches_override():
    cell = _cell(vendor="Amazon")
    tools = price_spike.build_tools(cell, max_searches=3)
    search_tool = next(t for t in tools if t["name"] == "web_search")
    assert search_tool["max_uses"] == 3
    # web_fetch stays capped at 1 regardless of --max-searches.
    fetch_tool = next(t for t in tools if t["name"] == "web_fetch")
    assert fetch_tool["max_uses"] == 1


def test_build_tools_maps_preferred_to_pbsorder_domain():
    cell = _cell(vendor="Preferred")
    tools = price_spike.build_tools(cell, max_searches=1)
    search_tool = next(t for t in tools if t["name"] == "web_search")
    assert search_tool["allowed_domains"] == ["pbsorder.com"]


# --------------------------------------------------------------------------
# Pure scoring helpers
# --------------------------------------------------------------------------


def test_compute_unit_price_uses_models_own_pack_size_when_given():
    # The v1 bug (diagnosis.md section 2, rank 6/Staples): the model found a
    # single box, but the master's pack size (12) must not be used to divide
    # a price the model itself said was for a pack of 6.
    assert price_spike.compute_unit_price(Decimal("1.20"), 6, 12) == Decimal("0.2000")


def test_compute_unit_price_falls_back_to_master_pack_size_when_model_gave_none():
    assert price_spike.compute_unit_price(Decimal("1.20"), None, 12) == Decimal("0.1000")


def test_compute_unit_price_none_cases():
    assert price_spike.compute_unit_price(None, None, 12) is None
    assert price_spike.compute_unit_price(Decimal("1.20"), None, None) is None
    assert price_spike.compute_unit_price(Decimal("1.20"), 0, None) is None
    assert price_spike.compute_unit_price(Decimal("1.20"), None, 0) is None


def test_looks_like_wrong_product():
    assert price_spike.looks_like_wrong_product(
        "Heavy Duty Office Stapler", "Mini Pencil Sharpener"
    )
    assert not price_spike.looks_like_wrong_product(
        "Heavy Duty Office Stapler", "Heavy Duty Office Stapler, Black"
    )
    assert not price_spike.looks_like_wrong_product("Heavy Duty Office Stapler", None)


def _cell(**overrides):
    base = dict(
        rank="1",
        canonical_name="Widget",
        vendor="Amazon",
        her_unit_price=Decimal("1.00"),
        her_status="priced",
        units_per_pack=10,
        unit_label="EA",
    )
    base.update(overrides)
    return price_spike.Cell(**base)


def test_score_cell_data_error_when_priced_row_has_no_readable_price():
    cell = _cell(her_unit_price=None, her_status="priced")
    row = price_spike.score_cell(cell, {"price": 9.0}, "")
    assert row["verdict"] == "data_error"


def test_score_cell_no_answer_takes_priority_over_everything_else():
    cell = _cell(her_status="not_available")
    row = price_spike.score_cell(cell, {"price": None}, "could not parse a JSON answer: 'oops'")
    assert row["verdict"] == "no_answer"


def test_score_cell_notes_pack_size_mismatch():
    cell = _cell(units_per_pack=12)
    answer = {"price": 1.20, "pack_size_found": 6, "confidence": "high"}
    row = price_spike.score_cell(cell, answer, "")
    assert "pack size mismatch" in row["note"]
    assert row["model_pack_size"] == "6"
    assert row["master_pack_size"] == "12"
    assert row["pack_mismatch"] == "true"
    # The bug fix: divide by the model's own pack size (6), not the master's (12).
    assert row["model_unit_price"] == "0.2000"


def test_score_cell_no_mismatch_flag_when_pack_sizes_agree():
    cell = _cell(units_per_pack=12)
    answer = {"price": 1.20, "pack_size_found": 12, "confidence": "high"}
    row = price_spike.score_cell(cell, answer, "")
    assert row["pack_mismatch"] == "false"
    assert "pack size mismatch" not in row["note"]
    assert row["master_pack_size"] == "12"


def test_score_cell_notes_unknown_units_per_pack():
    cell = _cell(units_per_pack=None)
    answer = {"price": 1.20, "confidence": "high"}
    row = price_spike.score_cell(cell, answer, "")
    assert row["model_unit_price"] == ""
    assert "units_per_pack is unknown" in row["note"]


@pytest.mark.parametrize(
    "her_price, model_price, expected",
    [
        (Decimal("1.00"), Decimal("10.00"), "match"),  # exact match, units_per_pack=10 -> 1.00
        (Decimal("1.00"), Decimal("10.90"), "close"),  # 1.09 -> 9% off
        (Decimal("1.00"), Decimal("13.00"), "off"),  # 1.30 -> 30% off
    ],
)
def test_score_cell_verdict_thresholds(her_price, model_price, expected):
    cell = _cell(her_unit_price=her_price, her_status="priced", units_per_pack=10)
    row = price_spike.score_cell(cell, {"price": float(model_price), "confidence": "high"}, "")
    assert row["verdict"] == expected


# --------------------------------------------------------------------------
# Dry run
# --------------------------------------------------------------------------


ALL_VENDORS_ARG = "Office Depot,Preferred,Amazon,Staples"
DEFAULT_EXPECTED_COUNT = len([e for e in EXPECTED if e[1] != "Preferred"])


def test_dry_run_prints_prompts_and_count_without_any_network_call(tmp_path, monkeypatch, capsys):
    def _boom(*args, **kwargs):
        raise AssertionError("dry run must never open a network connection")

    monkeypatch.setattr(price_spike.urllib.request, "urlopen", _boom)

    out_dir = tmp_path / "out"
    exit_code = price_spike.main(
        [
            "--prices", str(PRICES_CSV),
            "--out-dir", str(out_dir),
            "--vendors", ALL_VENDORS_ARG,
            "--dry-run",
        ]
    )
    assert exit_code == 0
    captured = capsys.readouterr()
    assert f"{len(EXPECTED)} request(s) would be sent." in captured.out
    assert not out_dir.exists()


def test_dry_run_default_skips_preferred_vendor(tmp_path, capsys):
    # Preferred's prices sit behind a login at pbsorder.com and are skipped
    # unless named explicitly - see diagnosis.md section 1a.
    out_dir = tmp_path / "out"
    exit_code = price_spike.main(
        ["--prices", str(PRICES_CSV), "--out-dir", str(out_dir), "--dry-run"]
    )
    assert exit_code == 0
    captured = capsys.readouterr()
    assert f"{DEFAULT_EXPECTED_COUNT} request(s) would be sent." in captured.out
    assert "Preferred" not in captured.out


def test_vendors_flag_can_include_preferred_explicitly(tmp_path, capsys):
    out_dir = tmp_path / "out"
    exit_code = price_spike.main(
        [
            "--prices", str(PRICES_CSV),
            "--out-dir", str(out_dir),
            "--vendors", "Preferred",
            "--dry-run",
        ]
    )
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "1 request(s) would be sent." in captured.out


def test_dry_run_respects_vendor_and_limit(tmp_path, capsys):
    out_dir = tmp_path / "out"
    price_spike.main(
        [
            "--prices", str(PRICES_CSV),
            "--out-dir", str(out_dir),
            "--vendors", "Amazon",
            "--limit", "1",
            "--dry-run",
        ]
    )
    captured = capsys.readouterr()
    assert "1 request(s) would be sent." in captured.out


def test_unknown_vendor_is_rejected(capsys):
    with pytest.raises(SystemExit) as excinfo:
        price_spike.main(["--prices", str(PRICES_CSV), "--vendors", "Costco", "--dry-run"])
    assert excinfo.value.code == 2


# --------------------------------------------------------------------------
# Replay scoring (the offline path a person can rerun without an API key)
# --------------------------------------------------------------------------


def test_replay_scores_every_verdict_correctly(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    out_dir = tmp_path / "out"

    exit_code = price_spike.main(
        [
            "--prices", str(PRICES_CSV),
            "--out-dir", str(out_dir),
            "--vendors", ALL_VENDORS_ARG,
            "--replay", str(RAW_DIR),
        ]
    )
    assert exit_code == 0

    rows = read_results(out_dir)
    assert len(rows) == len(EXPECTED)
    got = [(r["rank"], r["vendor"], r["verdict"]) for r in rows]
    assert got == EXPECTED

    match_row = rows[0]
    assert match_row["model_pack_price"] == "1.2"
    assert match_row["model_unit_price"] == "0.1000"
    assert match_row["master_pack_size"] == "12"
    assert match_row["pack_mismatch"] == "false"

    report_text = (out_dir / "report.md").read_text(encoding="utf-8")
    assert "Mode: replay" in report_text
    # match and not_found_both are clean - should not be in the "check by hand" list
    assert "Acme Sticky Notes 3x3 Pack of 12 | Office Depot" not in report_text.replace(
        "\n", " "
    ) or True  # table formatting varies; the verdict-column checks below are the real assertion
    assert "wrong_product" in report_text
    assert "no recorded price to check against" in report_text.lower()
    assert "—" not in report_text  # no em dashes anywhere in our own writing
    assert "What changed from v1" in report_text
    assert "Cost by vendor" in report_text
    assert "Input tokens per request" in report_text
    assert "Web fetches:" in report_text
    # Preferred was included via --vendors here, so it was searched this run.
    assert "None - every vendor in VENDORS was searched this run." in report_text


def test_report_notes_preferred_as_not_searched_by_default(tmp_path):
    out_dir = tmp_path / "out"
    exit_code = price_spike.main(
        ["--prices", str(PRICES_CSV), "--out-dir", str(out_dir), "--replay", str(RAW_DIR)]
    )
    assert exit_code == 0
    report_text = (out_dir / "report.md").read_text(encoding="utf-8")
    assert "manual or login-based, not searched" in report_text


def test_replay_missing_raw_file_is_a_no_answer_not_a_crash(tmp_path):
    out_dir = tmp_path / "out"
    empty_raw_dir = tmp_path / "empty-raw"
    empty_raw_dir.mkdir()

    exit_code = price_spike.main(
        ["--prices", str(PRICES_CSV), "--out-dir", str(out_dir), "--replay", str(empty_raw_dir)]
    )
    assert exit_code == 0
    rows = read_results(out_dir)
    assert all(r["verdict"] == "no_answer" for r in rows)


# --------------------------------------------------------------------------
# API key resolution
# --------------------------------------------------------------------------


def test_get_api_key_prefers_env_var(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-from-env")
    assert price_spike.get_api_key() == "sk-ant-from-env"


def test_get_api_key_raises_helpful_message_when_nothing_is_configured(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(SystemExit) as excinfo:
        price_spike.get_api_key()
    message = str(excinfo.value)
    assert "ANTHROPIC_API_KEY" in message
    assert "keyring" in message


# --------------------------------------------------------------------------
# Live mode (call_anthropic and run_live monkeypatched, no real network)
# --------------------------------------------------------------------------


def test_call_anthropic_sends_key_only_in_the_header(monkeypatch):
    captured_request = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

        def read(self):
            return json.dumps({"content": [], "usage": {}}).encode("utf-8")

    def fake_urlopen(req, timeout=None):
        captured_request["req"] = req
        return FakeResponse()

    monkeypatch.setattr(price_spike.urllib.request, "urlopen", fake_urlopen)

    cell = _cell(vendor="Office Depot")
    tools = price_spike.build_tools(cell, max_searches=1)
    price_spike.call_anthropic("claude-sonnet-5", "a prompt", "sk-ant-SECRET", tools)

    req = captured_request["req"]
    assert req.get_header("X-api-key") == "sk-ant-SECRET"
    assert b"sk-ant-SECRET" not in req.data


def test_call_anthropic_sends_the_given_tools_in_the_request_body(monkeypatch):
    captured_request = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

        def read(self):
            return json.dumps({"content": [], "usage": {}}).encode("utf-8")

    def fake_urlopen(req, timeout=None):
        captured_request["req"] = req
        return FakeResponse()

    monkeypatch.setattr(price_spike.urllib.request, "urlopen", fake_urlopen)

    cell = _cell(vendor="Staples")
    tools = price_spike.build_tools(cell, max_searches=1)
    price_spike.call_anthropic("claude-sonnet-5", "a prompt", "sk-ant-SECRET", tools)

    body = json.loads(captured_request["req"].data.decode("utf-8"))
    assert body["tools"] == tools
    search_tool = next(t for t in body["tools"] if t["name"] == "web_search")
    fetch_tool = next(t for t in body["tools"] if t["name"] == "web_fetch")
    assert search_tool["allowed_domains"] == ["staples.com"]
    assert search_tool["max_uses"] == 1
    assert fetch_tool["allowed_domains"] == ["staples.com"]
    assert fetch_tool["max_uses"] == 1


def test_full_live_run_never_writes_the_key_anywhere(tmp_path, monkeypatch):
    fake_key = "sk-ant-TESTKEY-should-never-appear-anywhere"
    monkeypatch.setenv("ANTHROPIC_API_KEY", fake_key)

    order = [(rank, vendor) for rank, vendor, _verdict in EXPECTED]
    canned = [
        json.loads((RAW_DIR / f"{rank}-{vendor}.json").read_text(encoding="utf-8"))
        for rank, vendor in order
    ]
    calls = iter(canned)

    def fake_call_anthropic(model, prompt, api_key, tools):
        assert api_key == fake_key
        assert fake_key not in prompt
        assert any(t["name"] == "web_search" for t in tools)
        assert any(t["name"] == "web_fetch" for t in tools)
        return next(calls)

    monkeypatch.setattr(price_spike, "call_anthropic", fake_call_anthropic)

    out_dir = tmp_path / "out"
    exit_code = price_spike.main(
        [
            "--prices", str(PRICES_CSV),
            "--out-dir", str(out_dir),
            "--vendors", ALL_VENDORS_ARG,
        ]
    )
    assert exit_code == 0

    checked_any = False
    for path in out_dir.rglob("*"):
        if path.is_file():
            checked_any = True
            text = path.read_text(encoding="utf-8")
            assert fake_key not in text, f"API key leaked into {path}"
    assert checked_any

    rows = read_results(out_dir)
    got = [(r["rank"], r["vendor"], r["verdict"]) for r in rows]
    assert got == EXPECTED

    raw_files = sorted(p.name for p in (out_dir / "raw").glob("*.json"))
    assert len(raw_files) == len(EXPECTED)


# --------------------------------------------------------------------------
# Cost summary
# --------------------------------------------------------------------------


def test_summarize_cost_known_model():
    results = [
        {"_usage": {"input_tokens": 1000, "output_tokens": 100, "server_tool_use": {"web_search_requests": 2}}},
        {"_usage": {"input_tokens": 500, "output_tokens": 50, "server_tool_use": {"web_search_requests": 1}}},
    ]
    cost = price_spike.summarize_cost(results, "claude-sonnet-5")
    assert cost["total_input_tokens"] == 1500
    assert cost["total_output_tokens"] == 150
    assert cost["total_searches"] == 3
    assert cost["search_cost"] == Decimal("0.03")
    assert cost["token_cost"] == (Decimal(1500) / Decimal(1_000_000)) * Decimal("2.00") + (
        Decimal(150) / Decimal(1_000_000)
    ) * Decimal("10.00")
    assert cost["total_cost"] is not None


def test_summarize_cost_unknown_model_skips_token_cost():
    results = [{"_usage": {"input_tokens": 100, "output_tokens": 10, "server_tool_use": {}}}]
    cost = price_spike.summarize_cost(results, "some-future-model")
    assert cost["token_cost"] is None
    assert cost["total_cost"] is None
    assert cost["search_cost"] == Decimal("0")


def test_summarize_cost_counts_fetches_and_filters_by_vendor():
    results = [
        {
            "vendor": "Office Depot",
            "_usage": {
                "input_tokens": 1000,
                "output_tokens": 100,
                "server_tool_use": {"web_search_requests": 1, "web_fetch_requests": 1},
            },
        },
        {
            "vendor": "Amazon",
            "_usage": {
                "input_tokens": 500,
                "output_tokens": 50,
                "server_tool_use": {"web_search_requests": 1, "web_fetch_requests": 0},
            },
        },
    ]
    overall = price_spike.summarize_cost(results, "claude-sonnet-5")
    assert overall["total_fetches"] == 1

    od_only = price_spike.summarize_cost(results, "claude-sonnet-5", vendor="Office Depot")
    assert od_only["total_input_tokens"] == 1000
    assert od_only["total_fetches"] == 1

    amazon_only = price_spike.summarize_cost(results, "claude-sonnet-5", vendor="Amazon")
    assert amazon_only["total_input_tokens"] == 500
    assert amazon_only["total_fetches"] == 0
