"""The review queue: what it asks, what it proposes, and what it refuses."""
from __future__ import annotations

import pytest

from conftest import YEAR, fill_and_apply, fill_queue, read_csv, read_header, write_csv
from supplytrack.errors import SupplytrackError
from supplytrack.master import MasterRow, load_master, save_master
from supplytrack.review import REVIEW_COLUMNS, apply_queue, build_queue, queue_counts


def rows_by_title(path):
    return {row["raw_title"]: row for row in read_csv(path)}


def test_the_queue_has_the_agreed_columns(ingested):
    queue = build_queue(ingested, YEAR)
    assert read_header(queue) == REVIEW_COLUMNS


def test_every_unknown_item_is_asked_about_once(ingested):
    queue = build_queue(ingested, YEAR)
    rows = read_csv(queue)
    # 17 lines, but two Amazon orders repeat a title and two Preferred lines
    # repeat a code, so 15 distinct items need a decision.
    assert len(rows) == 15
    assert len({row["key"] for row in rows}) == 15


def test_repeat_orders_are_added_up_so_the_big_items_come_first(ingested):
    queue = build_queue(ingested, YEAR)
    rows = read_csv(queue)
    pens = [r for r in rows if r["raw_title"].startswith("BIC")][0]
    assert pens["packs_in_year"] == "10"  # 4 in January plus 6 in September
    assert [int(r["packs_in_year"]) for r in rows] == sorted(
        (int(r["packs_in_year"]) for r in rows), reverse=True
    )


def test_an_office_category_is_proposed_for_inclusion(ingested):
    row = rows_by_title(build_queue(ingested, YEAR))[
        "EXPO Low-Odor Dry Erase Markers, Chisel Tip, Assorted, 48/Pack"
    ]
    assert row["include"] == "y"
    assert row["units_per_pack"] == "48"
    assert row["upp_candidates"] == "48 (48/Pack)"


def test_groceries_are_proposed_for_exclusion(ingested):
    row = rows_by_title(build_queue(ingested, YEAR))["Bubly Sparkling Water, Variety Pack, 18 Count"]
    assert row["include"] == "n"
    assert "Grocery" in row["include_reason"]


def test_an_unruled_category_is_left_blank_for_a_person(ingested):
    row = rows_by_title(build_queue(ingested, YEAR))["Cable Zip Ties, 8 Inch, Black (Bulk 1000 Pack)"]
    assert row["include"] == ""
    assert "needs a decision" in row["include_reason"]


def test_two_pack_sizes_in_one_title_leave_the_answer_blank(ingested):
    """This is the case that must never be guessed: 500 sheets per ream and 10
    reams per carton are both in the title and only one is the multiplier."""
    row = rows_by_title(build_queue(ingested, YEAR))[
        "Hammermill Copy Paper, 8.5 x 11, 500 Sheets/Ream, 10 Reams/Carton"
    ]
    assert row["units_per_pack"] == ""
    assert row["upp_candidates"] == "500 (500 Sheets)|10 (10 Reams/Carton)"
    assert "2 different numbers" in row["upp_reason"]
    assert row["unit_label"] == "RM"


def test_a_preferred_pack_code_decodes_without_asking(ingested):
    rows = rows_by_title(build_queue(ingested, YEAR))
    assert rows["Copy Paper 8.5 x 11 20lb White"]["units_per_pack"] == "10"
    assert rows["Binder Clips Medium Black"]["units_per_pack"] == "100"
    assert rows["Permanent Marker Fine Point Black"]["units_per_pack"] == "1"
    assert "CT10" in rows["Copy Paper 8.5 x 11 20lb White"]["upp_reason"]


def test_a_close_existing_name_is_proposed_so_items_merge(ingested):
    save_master(
        ingested,
        {
            "amz:seed": MasterRow(
                key="amz:seed",
                source="amazon",
                raw_title="EXPO Low Odor Dry Erase Markers, Chisel Tip, Assorted, 48/Pack",
                include="y",
                canonical_name="EXPO Low Odor Dry Erase Markers, Chisel Tip, Assorted, 48/Pack",
                units_per_pack="48",
                unit_label="EA",
                upp_source="master",
            )
        },
    )
    row = rows_by_title(build_queue(ingested, YEAR))[
        "EXPO Low-Odor Dry Erase Markers, Chisel Tip, Assorted, 48/Pack"
    ]
    assert row["canonical_name"] == "EXPO Low Odor Dry Erase Markers, Chisel Tip, Assorted, 48/Pack"
    assert "close to the existing item" in row["canonical_reason"]


def test_an_item_with_no_close_match_keeps_its_title(ingested):
    row = rows_by_title(build_queue(ingested, YEAR))["Letterhead Printed 2 Colour"]
    assert row["canonical_name"] == "Letterhead Printed 2 Colour"
    assert "no close match" in row["canonical_reason"]


def test_applying_the_queue_fills_the_master_and_empties_the_queue(ingested):
    added = fill_and_apply(ingested, YEAR)
    assert added == 15
    master = load_master(ingested)
    assert len(master) == 15
    assert master["pbs:UNV21200"].units_per_pack == "10"
    assert master["pbs:UNV21200"].upp_source == "master"
    assert master["pbs:UNV21200"].first_seen == "2025"
    assert read_csv(build_queue(ingested, YEAR)) == []


def test_two_listings_can_be_given_one_name(reviewed):
    master = load_master(reviewed)
    names = {row.canonical_name for row in master.values() if "Name" in row.raw_title}
    assert names == {"Avery Name Tag Inserts"}


def test_a_parked_row_with_blank_include_is_requeued(reviewed):
    """webapp-v2-spec.md section 7: the page parks an undecided row with a
    blank include rather than a real decision, and it must come back next run
    rather than vanishing the way a real include=n would."""
    master = load_master(reviewed)
    key = next(iter(master))
    master[key].include = ""
    save_master(reviewed, master)

    rows = read_csv(build_queue(reviewed, YEAR))
    parked = next(r for r in rows if r["key"] == key)
    assert parked["queue_reason"] == "unknown key"


def test_a_row_with_no_decision_is_refused_by_line_number(ingested, tmp_path):
    queue = build_queue(ingested, YEAR)
    rows = read_csv(queue)
    for row in rows:
        row["include"] = ""
        row["units_per_pack"] = ""
    path = write_csv(tmp_path / "blank.csv", REVIEW_COLUMNS, rows)

    with pytest.raises(SupplytrackError) as excinfo:
        apply_queue(ingested, YEAR, path)
    message = str(excinfo.value)
    assert "line 2" in message
    assert "include is blank" in message
    assert load_master(ingested) == {}  # nothing is written when anything is wrong


def test_an_included_row_with_no_pack_size_is_refused(ingested, tmp_path):
    queue = build_queue(ingested, YEAR)
    rows = read_csv(queue)
    for row in rows:
        row["include"] = "y"
        row["units_per_pack"] = ""
    path = write_csv(tmp_path / "nopack.csv", REVIEW_COLUMNS, rows)

    with pytest.raises(SupplytrackError) as excinfo:
        apply_queue(ingested, YEAR, path)
    assert "units_per_pack" in str(excinfo.value)


def test_an_excluded_row_needs_no_pack_size(ingested, tmp_path):
    """The office manager excluded around 600 grocery lines in 2025. Making them
    type a pack size for each of them would be asking for a number nothing uses."""
    queue = build_queue(ingested, YEAR)
    rows = read_csv(queue)
    for row in rows:
        row["include"] = "n"
        row["units_per_pack"] = ""
    path = write_csv(tmp_path / "excluded.csv", REVIEW_COLUMNS, rows)

    assert apply_queue(ingested, YEAR, path) == 15
    assert all(not row.included for row in load_master(ingested).values())


def test_an_unreadable_include_answer_is_refused(ingested, tmp_path):
    queue = build_queue(ingested, YEAR)
    rows = read_csv(queue)
    rows[0]["include"] = "maybe"
    path = write_csv(tmp_path / "maybe.csv", REVIEW_COLUMNS, rows)
    with pytest.raises(SupplytrackError) as excinfo:
        apply_queue(ingested, YEAR, path)
    assert "enter y or n" in str(excinfo.value)


def test_a_file_that_is_not_a_queue_is_refused(ingested, tmp_path):
    path = tmp_path / "notaqueue.csv"
    path.write_text("a,b\n1,2\n", encoding="utf-8")
    with pytest.raises(SupplytrackError) as excinfo:
        apply_queue(ingested, YEAR, path)
    assert "missing the column" in str(excinfo.value)


def test_applying_twice_updates_rather_than_duplicates(ingested, tmp_path):
    queue = build_queue(ingested, YEAR)
    filled = fill_queue(queue, tmp_path / "decisions.csv")
    assert apply_queue(ingested, YEAR, filled) == 15
    assert apply_queue(ingested, YEAR, filled) == 15  # rows written, not rows new
    assert len(load_master(ingested)) == 15


class TestTheQueueIsNotJustNewItems:
    """(b) and (c): items already in the master that still need a look.

    On the seeded 2025 master this is the common case, not the edge case: 33
    included items have no pack size and 84 carry one taken straight from a
    title. Without these rows they would look settled forever.
    """

    def test_the_queue_reason_sits_next_to_the_volume(self, ingested):
        header = read_header(build_queue(ingested, YEAR))
        assert header == REVIEW_COLUMNS
        assert header[header.index("packs_in_year") + 1] == "queue_reason"

    def test_a_new_item_is_asked_about_as_an_unknown_key(self, ingested):
        rows = read_csv(build_queue(ingested, YEAR))
        assert {row["queue_reason"] for row in rows} == {"unknown key"}

    def test_an_included_item_with_no_pack_size_comes_back(self, reviewed):
        master = load_master(reviewed)
        master["pbs:UNV35668"].units_per_pack = ""
        save_master(reviewed, master)

        row = [r for r in read_csv(build_queue(reviewed, YEAR)) if r["key"] == "pbs:UNV35668"][0]
        assert row["queue_reason"] == "pack size missing"
        assert row["include"] == "y"  # prefilled from the master
        assert row["canonical_name"] == "Binder Clips Medium Black"
        assert row["include_reason"] == "already in the item master"

    def test_an_unconfirmed_pack_size_comes_back_prefilled(self, reviewed):
        master = load_master(reviewed)
        master["pbs:UNV35668"].upp_source = "title"
        save_master(reviewed, master)

        row = [r for r in read_csv(build_queue(reviewed, YEAR)) if r["key"] == "pbs:UNV35668"][0]
        assert row["queue_reason"] == "pack size unconfirmed"
        assert row["units_per_pack"] == "100"  # the value is kept; only the confirmation is missing
        assert "came from title" in row["upp_reason"]
        assert "leave it to accept" in row["upp_reason"]

    def test_a_confirmed_item_is_never_asked_about_again(self, reviewed):
        assert read_csv(build_queue(reviewed, YEAR)) == []

    def test_an_excluded_item_is_not_chased_for_a_pack_size(self, reviewed):
        master = load_master(reviewed)
        grocery = [k for k, row in master.items() if row.amazon_category == "Grocery"][0]
        master[grocery].units_per_pack = ""
        master[grocery].upp_source = "title"
        save_master(reviewed, master)
        assert read_csv(build_queue(reviewed, YEAR)) == []

    def test_blocking_rows_are_listed_before_the_ones_that_can_wait(self, reviewed):
        master = load_master(reviewed)
        master["pbs:UNV35668"].upp_source = "title"  # unconfirmed, 3 packs
        master["pbs:PBS9001"].units_per_pack = ""  # missing, 4 packs
        save_master(reviewed, master)

        rows = read_csv(build_queue(reviewed, YEAR))
        assert [row["queue_reason"] for row in rows] == [
            "pack size missing",
            "pack size unconfirmed",
        ]

    def test_the_counts_say_what_blocks_and_what_does_not(self, reviewed):
        master = load_master(reviewed)
        master["pbs:UNV35668"].upp_source = "proposed"
        master["pbs:PBS9001"].units_per_pack = ""
        save_master(reviewed, master)
        assert queue_counts(build_queue(reviewed, YEAR)) == (1, 1)

    def test_counting_a_queue_that_was_never_written_is_not_an_error(self, tmp_path):
        assert queue_counts(tmp_path / "nothing.csv") == (0, 0)


class TestProposedPackSizes:
    """A Claude-filled queue unblocks the build without claiming a person checked it."""

    def test_applying_as_proposed_is_recorded_as_proposed(self, ingested, tmp_path):
        queue = build_queue(ingested, YEAR)
        filled = fill_queue(queue, tmp_path / "proposed.csv")
        assert apply_queue(ingested, YEAR, filled, proposed=True) == 15

        master = load_master(ingested)
        assert master["pbs:UNV35668"].upp_source == "proposed"
        assert master["pbs:UNV35668"].upp_unconfirmed is True

    def test_a_proposed_item_stays_in_the_queue_until_a_person_confirms_it(
        self, ingested, tmp_path
    ):
        queue = build_queue(ingested, YEAR)
        filled = fill_queue(queue, tmp_path / "proposed.csv")
        apply_queue(ingested, YEAR, filled, proposed=True)

        rows = read_csv(build_queue(ingested, YEAR))
        assert rows, "a proposal is not a confirmation"
        assert {row["queue_reason"] for row in rows} == {"pack size unconfirmed"}
        assert queue_counts(ingested / str(YEAR) / "review_queue.csv")[0] == 0  # nothing blocks

    def test_confirming_the_same_rows_clears_them(self, ingested, tmp_path):
        queue = build_queue(ingested, YEAR)
        filled = fill_queue(queue, tmp_path / "proposed.csv")
        apply_queue(ingested, YEAR, filled, proposed=True)

        confirmed = fill_queue(build_queue(ingested, YEAR), tmp_path / "confirmed.csv")
        apply_queue(ingested, YEAR, confirmed)
        assert read_csv(build_queue(ingested, YEAR)) == []
        assert load_master(ingested)["pbs:UNV35668"].upp_source == "master"

    def test_an_excluded_item_records_no_pack_size_source(self, reviewed):
        master = load_master(reviewed)
        grocery = [k for k, row in master.items() if row.amazon_category == "Grocery"][0]
        assert master[grocery].include == "n"
        assert master[grocery].upp_source == ""  # nobody confirmed a number nothing uses

    def test_the_first_year_an_item_was_seen_survives_an_update(self, reviewed, tmp_path):
        master = load_master(reviewed)
        master["pbs:UNV35668"].first_seen = "2024"
        master["pbs:UNV35668"].upp_source = "title"
        master["pbs:UNV35668"].note = "checked against the invoice"
        save_master(reviewed, master)

        filled = fill_queue(build_queue(reviewed, YEAR), tmp_path / "again.csv")
        apply_queue(reviewed, YEAR, filled)

        updated = load_master(reviewed)["pbs:UNV35668"]
        assert updated.first_seen == "2024"
        assert updated.last_seen == "2025"
        assert updated.note == "checked against the invoice"

    def test_applying_only_the_blocking_rows_leaves_the_rest_alone(self, reviewed, tmp_path):
        """The realistic Claude workflow: answer what blocks, leave the rest.

        The rows left out of the file must survive untouched - a partial apply
        that quietly dropped or rewrote them would be the worst kind of bug,
        because the master is the thing nobody re-derives.
        """
        master = load_master(reviewed)
        master["pbs:PBS9001"].units_per_pack = ""  # blocking
        master["pbs:UNV35668"].upp_source = "title"  # unconfirmed, left out below
        save_master(reviewed, master)

        rows = read_csv(build_queue(reviewed, YEAR))
        blocking = [r for r in rows if r["queue_reason"] == "pack size missing"]
        assert len(blocking) == 1
        blocking[0]["units_per_pack"] = "1"
        partial = write_csv(tmp_path / "blocking_only.csv", REVIEW_COLUMNS, blocking)

        assert apply_queue(reviewed, YEAR, partial) == 1

        after = load_master(reviewed)
        assert len(after) == 15  # nothing dropped
        assert after["pbs:PBS9001"].units_per_pack == "1"
        assert after["pbs:PBS9001"].upp_source == "master"
        assert after["pbs:UNV35668"].upp_source == "title"  # untouched
        assert after["pbs:UNV35668"].units_per_pack == "100"
        assert queue_counts(build_queue(reviewed, YEAR)) == (0, 1)

    def test_a_partly_confirmed_merged_item_reports_both_sources_in_key_order(
        self, reviewed, tmp_path
    ):
        """Two listings under one name can be confirmed one at a time, so the
        ranked upp_source column carries both. The order follows the keys, so
        the report gets the same string every run."""
        from supplytrack.rank import rank

        master = load_master(reviewed)
        avery = sorted(k for k, row in master.items() if row.canonical_name == "Avery Name Tag Inserts")
        assert len(avery) == 2
        master[avery[0]].upp_source = "master"
        master[avery[1]].upp_source = "title"
        save_master(reviewed, master)

        item = [i for i in rank(reviewed, YEAR).items if i["canonical_name"] == "Avery Name Tag Inserts"][0]
        assert item["upp_source"] == "master|title"
        assert item["keys"] == "|".join(avery)
