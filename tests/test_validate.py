"""The checks. A fail means a number would be wrong; a warn means look at it."""
from __future__ import annotations

import csv

import pytest

from conftest import YEAR, read_csv, write_csv
from supplytrack.master import MasterRow, load_master, save_master
from supplytrack.rank import EXCLUDED_COLUMNS, rank
from supplytrack.validate import (
    check_lines,
    check_master,
    check_prices,
    check_rank,
    run_all,
)


def codes(findings, level=None):
    return [f.code for f in findings if level is None or f.level == level]


@pytest.fixture
def ranked(reviewed):
    rank(reviewed, YEAR)
    return reviewed


def test_an_unreviewed_year_fails_on_the_unknown_items(ingested):
    findings = check_master(ingested, YEAR)
    assert "UNKNOWN_KEY" in codes(findings, "fail")
    message = [f for f in findings if f.code == "UNKNOWN_KEY"][0].message
    assert "15 item(s)" in message


def test_a_reviewed_year_has_nothing_failing(reviewed):
    assert codes(check_lines(reviewed, YEAR), "fail") == []
    assert codes(check_master(reviewed, YEAR), "fail") == []


def test_lines_outside_the_year_and_odd_statuses_are_warnings_not_failures(reviewed):
    findings = check_lines(reviewed, YEAR)
    assert codes(findings, "fail") == []
    assert set(codes(findings, "warn")) == {"DATE_OUT_OF_YEAR", "STATUS_NOT_CLOSED"}
    dates = [f for f in findings if f.code == "DATE_OUT_OF_YEAR"][0]
    assert "2024-12-28" in dates.message


def test_a_missing_line_file_says_to_ingest_first(data_dir):
    findings = check_lines(data_dir, YEAR)
    assert codes(findings, "fail") == ["LINES_MISSING"]
    assert "ingest" in findings[0].message


def test_an_edited_line_file_is_caught(reviewed):
    path = reviewed / str(YEAR) / "lines.csv"
    lines = path.read_text(encoding="utf-8").splitlines()
    path.write_text("\n".join(lines[:-1]) + "\n", encoding="utf-8")
    assert "LINE_COUNT_MISMATCH" in codes(check_lines(reviewed, YEAR), "fail")


def test_a_pack_size_that_contradicts_the_title_is_a_warning(reviewed):
    """The 2025 workbook used 100 where the title said 400. It is a judgement
    call, so it is flagged rather than overruled."""
    findings = check_master(reviewed, YEAR)
    warn = [f for f in findings if f.code == "UPP_TITLE_MISMATCH"]
    assert warn, "the 200-versus-400 name tag listing should be flagged"
    assert "master says 200" in warn[0].message


def test_an_item_included_against_its_category_is_flagged(reviewed):
    master = load_master(reviewed)
    grocery = [k for k, row in master.items() if row.amazon_category == "Grocery"][0]
    master[grocery].include = "y"
    master[grocery].units_per_pack = "18"
    save_master(reviewed, master)
    findings = check_master(reviewed, YEAR)
    assert "CATEGORY_UNUSUAL" in codes(findings, "warn")
    assert "Grocery" in [f for f in findings if f.code == "CATEGORY_UNUSUAL"][0].message


def test_two_names_that_should_probably_be_one_item_are_flagged(reviewed):
    master = load_master(reviewed)
    master["pbs:UNV35668"].canonical_name = "Binder Clips Medium Black"
    master["pbs:SAN30001"].canonical_name = "Binder Clips Medium Blacks"
    save_master(reviewed, master)
    findings = check_master(reviewed, YEAR)
    assert "NEAR_DUPLICATE_NAMES" in codes(findings, "warn")


def test_a_ranked_year_passes_the_accounting_check(ranked):
    assert codes(check_rank(ranked, YEAR), "fail") == []


def test_losing_rows_from_the_excluded_file_is_caught(ranked):
    """This is the check that would have caught the 2025 M-Z truncation: the
    parts stop adding up to the whole, even though every total still looks
    plausible on the page."""
    path = ranked / str(YEAR) / "excluded.csv"
    rows = read_csv(path)
    write_csv(path, EXCLUDED_COLUMNS, rows[:-1])
    findings = check_rank(ranked, YEAR)
    assert "UNCOUNTED_LINES" in codes(findings, "fail")
    assert "do not add up" in findings[0].message


def test_a_year_that_was_never_ranked_says_to_rank_it(reviewed):
    findings = check_rank(reviewed, YEAR)
    assert codes(findings, "fail") == ["RANK_MISSING"]


def test_a_missing_price_sheet_fails_whether_or_not_the_step_is_installed(ranked):
    """Only the price sheet decides whether the report can be built, so this
    has to fail for a missing file the same way it fails for a missing step."""
    assert not (ranked / str(YEAR) / "prices.csv").exists()
    findings = check_prices(ranked, YEAR, 25)
    assert codes(findings, "fail"), "a missing price sheet must fail the build"
    assert findings[0].code in ("PRICES_MISSING", "PRICES_MODULE_MISSING")
    assert str(YEAR) in findings[0].message or "prices" in findings[0].message.casefold()


def test_a_vendor_that_priced_fewer_items_is_flagged(ranked):
    path = ranked / str(YEAR) / "prices.csv"
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(
            ["rank", "canonical_name", "vendor", "unit_price", "status", "url", "checked_on", "note"]
        )
        for position, name in enumerate(["Pens", "Paper"], start=1):
            for vendor in ["Office Depot", "Preferred", "Amazon", "Staples"]:
                status = "not_available" if (vendor == "Staples" and name == "Paper") else "priced"
                price = "" if status != "priced" else "1.00"
                writer.writerow([position, name, vendor, price, status, "", "2026-03-26", ""])

    from supplytrack.validate import _vendor_coverage

    findings = _vendor_coverage(path, 25)
    assert codes(findings, "warn") == ["VENDOR_COVERAGE"]
    assert "Staples priced 1 of 2" in findings[0].message


def test_run_all_reports_each_problem_once(reviewed):
    findings = run_all(reviewed, YEAR, 25)
    messages = [(f.code, f.message) for f in findings]
    assert len(messages) == len(set(messages))
    assert "RANK_MISSING" in codes(findings, "fail")


def test_a_clean_master_with_no_lines_is_not_silently_fine(data_dir):
    save_master(data_dir, {"amz:x": MasterRow(key="amz:x", include="y", units_per_pack="1")})
    assert codes(check_master(data_dir, YEAR), "fail") == ["LINES_MISSING"]


def test_an_unconfirmed_pack_size_is_a_warning_not_a_failure(reviewed):
    """84 items in the seeded master have a pack size read off their title. If
    that failed the build, nothing could be built until all 84 were checked."""
    master = load_master(reviewed)
    master["pbs:UNV35668"].upp_source = "title"
    master["pbs:UNV21200"].upp_source = "proposed"
    save_master(reviewed, master)

    findings = check_master(reviewed, YEAR)
    assert codes(findings, "fail") == []
    assert "UPP_UNCONFIRMED" in codes(findings, "warn")
    message = [f for f in findings if f.code == "UPP_UNCONFIRMED"][0].message
    assert "2 included item(s)" in message
    assert "came from title" in message
    assert "came from proposed" in message


def test_a_confirmed_pack_size_raises_no_warning(reviewed):
    assert "UPP_UNCONFIRMED" not in codes(check_master(reviewed, YEAR), "warn")


def test_an_unconfirmed_item_is_excluded_from_the_warning_when_it_is_not_included(reviewed):
    master = load_master(reviewed)
    grocery = [k for k, row in master.items() if row.amazon_category == "Grocery"][0]
    master[grocery].upp_source = "title"
    save_master(reviewed, master)
    assert "UPP_UNCONFIRMED" not in codes(check_master(reviewed, YEAR), "warn")


def test_an_unconfirmed_pack_size_still_ranks(reviewed):
    """The number is usable. Refusing to rank it would stall the whole report
    over a confirmation that can happen any time."""
    master = load_master(reviewed)
    master["pbs:UNV35668"].upp_source = "title"
    save_master(reviewed, master)

    result = rank(reviewed, YEAR)
    item = [i for i in result.items if i["canonical_name"] == "Binder Clips Medium Black"][0]
    assert item["eaches"] == 300
    assert item["upp_source"] == "title"
    assert any("nobody has confirmed" in w for w in result.warnings)


class TestThePackSizeWarningStaysQuietWhenItShould:
    """UPP_TITLE_MISMATCH fired 13 times on the first real run and was mostly
    wrong. A warning nobody trusts is worse than no warning at all."""

    def set_title(self, data_dir, key, title, units):
        """Give one item a title and a confirmed pack size, and name it distinctly.

        The fixture year already contains one genuine mismatch (the name tag
        listings), so each test asks about its own item rather than about the
        warning list as a whole.
        """
        master = load_master(data_dir)
        master[key].raw_title = title
        master[key].canonical_name = "Item Under Test"
        master[key].units_per_pack = str(units)
        master[key].upp_source = "master"
        save_master(data_dir, master)
        return "Item Under Test"

    def warned_about_the_item(self, data_dir) -> str:
        """The mismatch text for the item under test, or "" when it is quiet."""
        for finding in check_master(data_dir, YEAR):
            if finding.code != "UPP_TITLE_MISMATCH":
                continue
            for part in finding.message.split("; "):
                if part.startswith("Item Under Test:"):
                    return part
        return ""

    def test_a_measurement_in_the_title_is_not_a_contradiction(self, reviewed):
        self.set_title(reviewed, "pbs:UNV35668", "Ring Binders, 2 Inch, Black", 1)
        assert self.warned_about_the_item(reviewed) == ""

    def test_a_sheet_count_is_not_a_contradiction(self, reviewed):
        """The pack holds 320 sheets and you buy one pack. Both are true."""
        self.set_title(reviewed, "pbs:UNV35668", "Card Stock, 8.5 x 11, 320 Sheets", 1)
        assert self.warned_about_the_item(reviewed) == ""

    def test_matching_any_number_in_the_title_settles_it(self, reviewed):
        self.set_title(
            reviewed, "pbs:UNV35668", "Copy Paper, 500 Sheets/Ream, 10 Reams/Carton", 500
        )
        assert self.warned_about_the_item(reviewed) == ""

    def test_two_numbers_that_multiply_to_the_master_value_settle_it(self, reviewed):
        """A case of ten 12-packs is 120, correctly entered."""
        self.set_title(reviewed, "pbs:UNV35668", "Ballpoint Pens, 12/Pack, Case of 10 Packs", 120)
        assert self.warned_about_the_item(reviewed) == ""

    def test_a_real_contradiction_still_warns(self, reviewed):
        self.set_title(reviewed, "pbs:UNV35668", "Name Tag Inserts, 400 Count", 200)
        warned = self.warned_about_the_item(reviewed)
        assert "master says 200" in warned
        assert "400 (400 Count)" in warned

    def test_only_the_counting_phrases_are_quoted_back(self, reviewed):
        self.set_title(
            reviewed, "pbs:UNV35668", "Note Pads, 8.5 x 11, 50 Sheets Each, 6 Pads", 12
        )
        warned = self.warned_about_the_item(reviewed)
        assert "6 (6 Pads)" in warned
        assert "50 Sheets" not in warned  # describes the pad, does not count pads

    def test_a_number_filtered_out_as_a_measurement_still_settles_it(self, reviewed):
        """26 tabs per set is where the 26 came from. Telling a person their
        own number disagrees with the title they read it off is noise."""
        self.set_title(reviewed, "pbs:UNV35668", "Index Dividers, 26 Tab, 4 Pack", 26)
        assert self.warned_about_the_item(reviewed) == ""

    def test_a_value_that_appears_nowhere_in_the_title_still_warns(self, reviewed):
        self.set_title(reviewed, "pbs:UNV35668", "Index Dividers, 26 Tab, 4 Pack", 30)
        assert "4 (4 Pack)" in self.warned_about_the_item(reviewed)

    def test_a_full_stop_before_a_count_is_not_a_decimal(self, reviewed):
        """"Asst. 6 Pack" states a pack size; "8.5" does not."""
        self.set_title(reviewed, "pbs:UNV35668", "Dry Erase Markers Asst. 6 Pack", 12)
        assert "6 (6 Pack)" in self.warned_about_the_item(reviewed)
