"""The command line: what it prints, and what it exits with.

Exit codes are the contract a person and a script both rely on: 0 worked,
1 the data is wrong, 2 the tool needs a decision. Only the stages this module
owns are exercised here (ingest, review, rank, validate); prices and report
belong to their own tests.
"""
from __future__ import annotations

import pytest

from conftest import YEAR, fill_queue, read_csv
from supplytrack.cli import EXIT_FAIL, EXIT_NEEDS_PERSON, EXIT_OK, main


def run(args: list[str]) -> int:
    return main(args)


def test_help_works_without_the_optional_stages(capsys):
    with pytest.raises(SystemExit) as excinfo:
        main(["--help"])
    assert excinfo.value.code == 0
    assert "supplytrack" in capsys.readouterr().out


def test_every_subcommand_is_listed(capsys):
    with pytest.raises(SystemExit):
        main(["--help"])
    out = capsys.readouterr().out
    for command in ("ingest", "review", "rank", "prices", "report", "validate", "run"):
        assert command in out


def test_ingest_reports_what_it_read(data_dir, amazon_export, preferred_export, capsys):
    code = run(
        [
            "ingest",
            "--year",
            str(YEAR),
            "--data-dir",
            str(data_dir),
            "--amazon",
            str(amazon_export),
            "--preferred",
            str(preferred_export),
        ]
    )
    out = capsys.readouterr().out
    assert code == EXIT_OK
    assert "Read 12 Amazon line(s)" in out
    assert "Read 5 Preferred line(s)" in out
    assert "Wrote 17 line(s)" in out
    assert "WARN" in out  # the 2024 line and the cancelled order


def test_a_missing_file_is_a_plain_message_not_a_traceback(data_dir, tmp_path, capsys):
    code = run(
        [
            "ingest",
            "--year",
            str(YEAR),
            "--data-dir",
            str(data_dir),
            "--amazon",
            str(tmp_path / "nope.xlsx"),
        ]
    )
    out = capsys.readouterr().out
    assert code == EXIT_FAIL
    assert out.startswith("FAIL ")
    assert "nope.xlsx" in out


def test_review_asks_for_a_decision_and_says_where(ingested, capsys):
    code = run(["review", "--year", str(YEAR), "--data-dir", str(ingested)])
    out = capsys.readouterr().out
    assert code == EXIT_NEEDS_PERSON
    assert "15 item(s) must be decided" in out
    assert "review_queue.csv" in out


def test_applying_a_filled_queue_clears_it(ingested, tmp_path, capsys):
    run(["review", "--year", str(YEAR), "--data-dir", str(ingested)])
    capsys.readouterr()
    filled = fill_queue(
        ingested / str(YEAR) / "review_queue.csv", tmp_path / "decisions.csv"
    )
    code = run(
        ["review", "--year", str(YEAR), "--data-dir", str(ingested), "--apply", str(filled)]
    )
    out = capsys.readouterr().out
    assert code == EXIT_OK
    assert "Wrote 15 confirmed item(s)" in out
    assert "Nothing to review" in out


def test_review_after_applying_says_there_is_nothing_to_do(reviewed, capsys):
    code = run(["review", "--year", str(YEAR), "--data-dir", str(reviewed)])
    assert code == EXIT_OK
    assert "Nothing to review" in capsys.readouterr().out


def test_rank_prints_the_top_of_the_list(reviewed, capsys):
    code = run(["rank", "--year", str(YEAR), "--data-dir", str(reviewed), "--top", "3"])
    out = capsys.readouterr().out
    assert code == EXIT_OK
    assert "Ranked 12 item(s)" in out
    assert "Avery Name Tag Inserts" in out
    assert out.count("\n  ") == 3  # --top 3 listed three items
    assert read_csv(reviewed / str(YEAR) / "ranked.csv")


def test_rank_stops_when_items_are_unreviewed(ingested, capsys):
    code = run(["rank", "--year", str(YEAR), "--data-dir", str(ingested)])
    out = capsys.readouterr().out
    assert code == EXIT_FAIL
    assert "UNKNOWN_KEY" in out


def test_validate_fails_while_the_price_sheet_is_missing(reviewed, capsys):
    run(["rank", "--year", str(YEAR), "--data-dir", str(reviewed)])
    capsys.readouterr()
    code = run(["validate", "--year", str(YEAR), "--data-dir", str(reviewed)])
    out = capsys.readouterr().out
    assert code == EXIT_FAIL
    assert "PRICES" in out
    assert "check(s) failed" in out
    # the stages this module owns are clean; only the price sheet is missing
    assert "UNKNOWN_KEY" not in out
    assert "UNCOUNTED_LINES" not in out


def test_validate_prints_warnings_with_their_level(reviewed, capsys):
    run(["rank", "--year", str(YEAR), "--data-dir", str(reviewed)])
    capsys.readouterr()
    run(["validate", "--year", str(YEAR), "--data-dir", str(reviewed)])
    out = capsys.readouterr().out
    assert "WARN DATE_OUT_OF_YEAR" in out
    assert "WARN STATUS_NOT_CLOSED" in out


def test_the_data_directory_can_come_from_the_environment(
    tmp_path, amazon_export, monkeypatch, capsys
):
    monkeypatch.setenv("SUPPLYTRACK_DATA", str(tmp_path / "elsewhere"))
    code = run(["ingest", "--year", str(YEAR), "--amazon", str(amazon_export)])
    capsys.readouterr()
    assert code == EXIT_OK
    assert (tmp_path / "elsewhere" / str(YEAR) / "lines.csv").exists()


def test_the_year_is_required(capsys):
    with pytest.raises(SystemExit) as excinfo:
        main(["rank"])
    assert excinfo.value.code == 2  # argparse usage error
    assert "--year" in capsys.readouterr().err


def test_an_unknown_command_is_refused():
    with pytest.raises(SystemExit):
        main(["frobnicate", "--year", "2025"])


def test_review_does_not_block_on_a_pack_size_that_only_needs_confirming(reviewed, capsys):
    from supplytrack.master import load_master, save_master

    master = load_master(reviewed)
    master["pbs:UNV35668"].upp_source = "title"
    save_master(reviewed, master)

    code = run(["review", "--year", str(YEAR), "--data-dir", str(reviewed)])
    out = capsys.readouterr().out
    assert code == EXIT_OK  # usable, so nothing is waiting on it
    assert "Nothing is blocking the build" in out
    assert "1 item(s) are ranked on a pack size nobody has confirmed" in out


def test_review_blocks_when_something_cannot_be_ranked(reviewed, capsys):
    from supplytrack.master import load_master, save_master

    master = load_master(reviewed)
    master["pbs:UNV35668"].units_per_pack = ""
    master["pbs:UNV21200"].upp_source = "title"
    save_master(reviewed, master)

    code = run(["review", "--year", str(YEAR), "--data-dir", str(reviewed)])
    out = capsys.readouterr().out
    assert code == EXIT_NEEDS_PERSON
    assert "1 item(s) must be decided" in out
    assert "1 more item(s) in the same file have a pack size to confirm" in out


def test_applying_a_claude_filled_queue_is_recorded_as_proposed(ingested, tmp_path, capsys):
    run(["review", "--year", str(YEAR), "--data-dir", str(ingested)])
    capsys.readouterr()
    filled = fill_queue(ingested / str(YEAR) / "review_queue.csv", tmp_path / "proposed.csv")

    code = run(
        [
            "review",
            "--year",
            str(YEAR),
            "--data-dir",
            str(ingested),
            "--apply",
            str(filled),
            "--proposed",
        ]
    )
    out = capsys.readouterr().out
    assert code == EXIT_OK  # proposals unblock the build
    assert "Wrote 15 proposed item(s)" in out
    assert "nobody has confirmed" in out

    from supplytrack.master import load_master

    assert load_master(ingested)["pbs:UNV35668"].upp_source == "proposed"


def test_validate_reports_the_unconfirmed_items(reviewed, capsys):
    from supplytrack.master import load_master, save_master

    master = load_master(reviewed)
    master["pbs:UNV35668"].upp_source = "proposed"
    save_master(reviewed, master)
    run(["rank", "--year", str(YEAR), "--data-dir", str(reviewed)])
    capsys.readouterr()

    run(["validate", "--year", str(YEAR), "--data-dir", str(reviewed)])
    assert "WARN UPP_UNCONFIRMED" in capsys.readouterr().out


def test_review_breaks_the_queue_down_by_reason(reviewed, capsys):
    """Three reasons ask for three different things, so the counts are split."""
    from supplytrack.master import load_master, save_master

    master = load_master(reviewed)
    master["pbs:UNV35668"].units_per_pack = ""  # blocks
    master["pbs:UNV21200"].upp_source = "title"  # does not block
    save_master(reviewed, master)

    run(["review", "--year", str(YEAR), "--data-dir", str(reviewed)])
    out = capsys.readouterr().out
    assert "1  pack size missing (blocks the build)" in out
    assert "1  pack size unconfirmed (does not block)" in out
    assert "unknown key" not in out  # nothing of that kind, so it is not listed


def test_a_first_run_reports_every_item_as_an_unknown_key(ingested, capsys):
    run(["review", "--year", str(YEAR), "--data-dir", str(ingested)])
    out = capsys.readouterr().out
    assert "15  unknown key (blocks the build)" in out


def test_a_settled_year_prints_no_queue_breakdown(reviewed, capsys):
    run(["review", "--year", str(YEAR), "--data-dir", str(reviewed)])
    out = capsys.readouterr().out
    assert "Nothing to review" in out
    assert "blocks the build" not in out  # no zero rows for reasons with nothing in them
    assert "does not block" not in out
