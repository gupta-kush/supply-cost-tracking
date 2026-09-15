"""The item master and the suggestion helpers that fill the review queue."""
from __future__ import annotations

import pytest

from supplytrack.errors import SupplytrackError
from supplytrack.ingest import normalise_title
from supplytrack.master import (
    MASTER_COLUMNS,
    MasterRow,
    decode_preferred_pack,
    is_pack_phrase,
    load_master,
    save_master,
    suggest_include,
    upp_candidates,
)


class TestNormaliseTitle:
    """The key has to be identical to the one that seeded the master, or the
    same product seeds twice and its eaches are split across two items."""

    def test_case_and_spacing_are_flattened(self):
        assert normalise_title("  BIC  Round   Stic  ") == "bic round stic"

    def test_the_kept_punctuation_survives(self):
        assert normalise_title("3/4 x 1000 (Bulk) - 8.5") == "3/4 x 1000 (bulk) - 8.5"

    def test_everything_else_becomes_a_space(self):
        assert normalise_title("Sharpie®, Fine Point; #2") == "sharpie fine point 2"

    def test_an_accent_is_dropped_along_with_the_other_stray_characters(self):
        # Not "cafe": the keep-set is plain ASCII, so the accented letter goes
        # the way of a trademark sign. Both orders of the same product spell it
        # the same way, so the key still matches itself.
        assert normalise_title("Café Notebook") == "caf notebook"
        assert normalise_title("") == ""
        assert normalise_title(None) == ""


class TestUppCandidates:
    """Every phrasing the 2025 titles actually used has to be recognised."""

    @pytest.mark.parametrize(
        "title,expected",
        [
            ("400 Printable Name Tag Inserts", 400),
            ("48/Pack", 48),
            ("Pack of 6", 6),
            ("Display Pack of 6", 6),
            ("32 Count", 32),
            ("(Bulk 1000 Pack)", 1000),
            ("200 Pack", 200),
            ("6 Pads", 6),
            ("12-Count", 12),
            ("12 Ct", 12),
            ("12pk", 12),
            ("Box of 100", 100),
            ("3 Pack", 3),
        ],
    )
    def test_a_single_pack_size_is_found(self, title, expected):
        assert [value for value, _ in upp_candidates(title)] == [expected]

    def test_two_numbers_are_both_returned_in_title_order(self):
        """The carton is the purchase unit, but this is not the place to decide
        that - both go to the queue with the phrase that produced them."""
        hits = upp_candidates("500 Sheets/Ream, 10 Reams/Carton")
        assert [value for value, _ in hits] == [500, 10]
        assert hits[1][1] == "10 Reams/Carton"

    def test_the_phrase_explains_where_the_number_came_from(self):
        assert upp_candidates("Avery Inserts, 400 Printable Name Tag Inserts") == [
            (400, "400 Printable Name Tag Inserts")
        ]

    def test_repeated_numbers_are_listed_once(self):
        assert upp_candidates("12 Count, 12 Pack") == [(12, "12 Count")]

    def test_a_title_with_no_pack_size_returns_nothing(self):
        assert upp_candidates("Stapler, Heavy Duty, Black") == []
        assert upp_candidates("") == []


class TestDecodePreferredPack:
    @pytest.mark.parametrize(
        "code,expected",
        [("CT10", 10), ("BX100", 100), ("CS1", 1), ("Each", 1), ("EA", 1), ("pk12", 12)],
    )
    def test_known_codes_decode(self, code, expected):
        assert decode_preferred_pack(code) == expected

    @pytest.mark.parametrize("code", ["", "   ", "ASSORTED", "BX-", None])
    def test_an_unknown_code_goes_to_review_rather_than_guessing(self, code):
        assert decode_preferred_pack(code) is None


class TestSuggestInclude:
    def test_an_office_category_is_proposed_as_included(self):
        include, reason = suggest_include("Office Product", "amazon")
        assert include == "y"
        assert "Office Product" in reason

    def test_the_second_office_category_is_recognised(self):
        include, _ = suggest_include("Business, Industrial, & Scientific Supplies Basic", "amazon")
        assert include == "y"

    def test_a_stray_space_does_not_change_the_answer(self):
        assert suggest_include("  office product ", "amazon")[0] == "y"

    def test_groceries_are_proposed_as_excluded(self):
        include, reason = suggest_include("Grocery", "amazon")
        assert include == "n"
        assert "not an office supply" in reason

    def test_an_unruled_category_asks_rather_than_assuming(self):
        include, reason = suggest_include("Tools & Home Improvement", "amazon")
        assert include == ""
        assert "needs a decision" in reason

    def test_preferred_is_an_office_vendor(self):
        include, reason = suggest_include(None, "preferred")
        assert include == "y"
        assert "office-supply vendor" in reason


class TestMasterFile:
    def test_a_missing_master_is_an_empty_one(self, tmp_path):
        assert load_master(tmp_path) == {}

    def test_rows_round_trip_through_the_file(self, tmp_path):
        rows = {
            "amz:pens": MasterRow(
                key="amz:pens",
                source="amazon",
                raw_title="Pens, 60-Count",
                include="y",
                canonical_name="Ballpoint Pens",
                units_per_pack="60",
                unit_label="EA",
                upp_source="master",
                amazon_category="Office Product",
                first_seen="2025",
                last_seen="2025",
                note="",
            )
        }
        save_master(tmp_path, rows)
        assert (tmp_path / "item_master.csv").exists()
        reloaded = load_master(tmp_path)
        assert reloaded["amz:pens"].canonical_name == "Ballpoint Pens"
        assert reloaded["amz:pens"].units_per_pack_int == 60
        assert reloaded["amz:pens"].included is True

    def test_the_file_keeps_the_agreed_column_order(self, tmp_path):
        save_master(tmp_path, {"k": MasterRow(key="k")})
        header = (tmp_path / "item_master.csv").read_text(encoding="utf-8").splitlines()[0]
        assert header.split(",") == MASTER_COLUMNS

    def test_a_duplicated_key_is_refused(self, tmp_path):
        (tmp_path / "item_master.csv").write_text(
            ",".join(MASTER_COLUMNS)
            + "\namz:a,amazon,A,y,A,1,EA,master,Office Product,2025,2025,\n"
            + "amz:a,amazon,A,y,A,2,EA,master,Office Product,2025,2025,\n",
            encoding="utf-8",
        )
        with pytest.raises(SupplytrackError) as excinfo:
            load_master(tmp_path)
        assert "twice" in str(excinfo.value)

    @pytest.mark.parametrize("value", ["", "   ", "abc", "0", "-3", "1.5"])
    def test_an_unusable_pack_size_reads_as_missing(self, value):
        assert MasterRow(key="k", units_per_pack=value).units_per_pack_int is None


class TestMeasurementsAreNotPackSizes:
    """A number in a title is often describing the product, not counting it.

    On the first real run this was 13 pack-size warnings, most of them about
    binder rings and divider tabs. A warning a person dismisses every time
    teaches them to skim past the real ones, so these never become candidates.
    """

    @pytest.mark.parametrize(
        "title",
        [
            "Sturdy 2 Inch Ring Binders, Black",          # a size, not two binders
            "Heavy Duty 3 Ring Binder, Blue",             # three rings, one binder
            "Index Dividers, 5 Tab, Multicolour",         # five tabs, one set
            "Index Dividers, 26 Tab, A-Z",
            'Presentation Binder, 1" Capacity',           # an inch mark
            "Laminating Pouches, 5 mil, Letter Size",
            "Paper Towels, 2 Ply, White",
            "Copier Paper, 20 lb, Bright White",
            "Filing Envelopes 9 x 12, Kraft",             # half a dimension
            "Poster Board 22 x 28, Assorted",
            "Ink Cartridge PFI1000 Matte Black",          # a model number
            "Copy Paper (38111), White",                  # a catalogue reference
        ],
    )
    def test_a_measurement_never_becomes_a_pack_size(self, title):
        assert upp_candidates(title) == []

    def test_a_dimension_beside_a_real_count_leaves_the_count(self):
        assert upp_candidates("Filing Envelopes 9 x 12, 100 Count") == [(100, "100 Count")]

    def test_a_size_beside_a_real_count_leaves_the_count(self):
        assert upp_candidates("Ring Binders, 2 Inch, 4 Pack") == [(4, "4 Pack")]


class TestPackPhrases:
    """Which phrases actually count purchase units."""

    @pytest.mark.parametrize(
        "phrase", ["12/Pack", "32 Count", "6 Pads", "Box of 100", "Case of 10", "24 Rolls"]
    )
    def test_a_counting_phrase_is_pack_like(self, phrase):
        assert is_pack_phrase(phrase) is True

    @pytest.mark.parametrize("phrase", ["320 Sheets", "500 Sheets", "", "12 Reams"])
    def test_a_describing_phrase_is_not(self, phrase):
        assert is_pack_phrase(phrase) is False

    def test_the_sheet_count_is_still_offered_to_the_reviewer(self):
        """Not pack-like, but still worth seeing: it is sometimes the answer."""
        assert upp_candidates("Card Stock, 8.5 x 11, 320 Sheets") == [(320, "320 Sheets")]
