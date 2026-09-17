"""Ranking: eaches, merges, and the arithmetic that must account for every line."""
from __future__ import annotations

import json

import pytest

from conftest import YEAR, read_csv, read_header
from supplytrack.errors import SupplytrackError
from supplytrack.master import load_master, save_master
from supplytrack.rank import EXCLUDED_COLUMNS, RANKED_COLUMNS, rank


@pytest.fixture
def ranked(reviewed):
    return rank(reviewed, YEAR)


def by_name(result):
    return {item["canonical_name"]: item for item in result.items}


def test_the_ranked_file_has_the_agreed_columns(reviewed, ranked):
    assert read_header(reviewed / str(YEAR) / "ranked.csv") == RANKED_COLUMNS
    assert read_header(reviewed / str(YEAR) / "excluded.csv") == EXCLUDED_COLUMNS


def test_items_are_ranked_by_units_bought_not_by_orders(ranked):
    order = [item["canonical_name"] for item in ranked.items]
    assert order[0] == "Avery Name Tag Inserts"  # 3 packs, but 1,000 eaches
    assert order[1] == "BIC Round Stic Ballpoint Pens, Medium Point, Black, 60-Count"
    assert order[2] == "Binder Clips Medium Black"
    assert [item["rank"] for item in ranked.items] == list(range(1, len(ranked.items) + 1))


def test_two_listings_under_one_name_become_one_item(ranked):
    """The 2025 workbook counted these separately. 2 x 400 plus 1 x 200 is one
    item of 1,000 eaches, not two items of 800 and 200."""
    item = by_name(ranked)["Avery Name Tag Inserts"]
    assert item["eaches"] == 1000
    assert item["packs"] == 3
    assert item["keys"].count("|") == 1
    assert item["sources"] == "amazon"


def test_a_merged_item_with_different_pack_sizes_shows_no_single_pack_size(ranked):
    """There is no honest answer to "how many in a pack" when the merged
    listings differ, so the column is left blank and eaches carries the total."""
    assert by_name(ranked)["Avery Name Tag Inserts"]["units_per_pack"] == ""


def test_an_unmerged_item_keeps_its_pack_size(ranked):
    pens = by_name(ranked)["BIC Round Stic Ballpoint Pens, Medium Point, Black, 60-Count"]
    assert pens["units_per_pack"] == "60"
    assert pens["packs"] == 10  # two orders, four packs then six
    assert pens["eaches"] == 600


def test_a_tie_on_units_is_broken_by_name(ranked):
    """Both are 3 packs of 10 reams, one from each vendor. Which comes first
    has to be decided by the name, not by whichever was read first."""
    tied = [item for item in ranked.items if item["eaches"] == 30]
    assert [item["canonical_name"] for item in tied] == [
        "Copy Paper 8.5 x 11 20lb White",
        "Hammermill Copy Paper, 8.5 x 11, 500 Sheets/Ream, 10 Reams/Carton",
    ]
    assert [item["rank"] for item in tied] == [6, 7]


def test_more_packs_wins_before_the_name_is_consulted(reviewed):
    """packs is the second sort key. Two items on the same eaches are separated
    by how many purchase units were bought, and only then by name."""
    from supplytrack.master import load_master, save_master

    master = load_master(reviewed)
    marker = [k for k, row in master.items() if row.raw_title.startswith("Permanent Marker")][0]
    tape = [k for k, row in master.items() if row.raw_title.startswith("Scotch")][0]
    master[marker].canonical_name = "zzz Marker"  # would sort last on name
    master[tape].canonical_name = "aaa Tape"  # would sort first on name
    master[tape].units_per_pack = "12"  # 1 pack x 12 = 12 eaches, same as the marker
    save_master(reviewed, master)

    tied = [item for item in rank(reviewed, YEAR).items if item["eaches"] == 12]
    assert [(item["canonical_name"], item["packs"]) for item in tied] == [
        ("zzz Marker", 12),
        ("aaa Tape", 1),
    ]


def test_the_last_amazon_price_is_carried_per_each(ranked):
    pens = by_name(ranked)["BIC Round Stic Ballpoint Pens, Medium Point, Black, 60-Count"]
    assert pens["last_paid_per_each"] == "0.0997"  # the September price, not January
    avery = by_name(ranked)["Avery Name Tag Inserts"]
    assert avery["last_paid_per_each"] == "0.1105"  # 22.10 over the 200 of the later listing


def test_an_item_bought_only_from_preferred_has_no_amazon_price(ranked):
    assert by_name(ranked)["Binder Clips Medium Black"]["last_paid_per_each"] == ""


def test_excluded_lines_are_listed_with_their_reason(reviewed, ranked):
    rows = read_csv(reviewed / str(YEAR) / "excluded.csv")
    titles = {row["raw_title"]: row["reason"] for row in rows}
    assert titles["Bubly Sparkling Water, Variety Pack, 18 Count"] == "include=n"
    assert titles["Cable Zip Ties, 8 Inch, Black (Bulk 1000 Pack)"] == "include=n"
    assert all(row["reason"] in ("include=n", "not in item master") for row in rows)


def test_a_parked_row_is_excluded_as_no_decision_yet(reviewed):
    """webapp-v2-spec.md section 7: a blank include is not the same fact as a
    real include=n, and the excluded reason must say so rather than implying
    someone decided against the item."""
    master = load_master(reviewed)
    key = next(iter(master))
    master[key].include = ""
    save_master(reviewed, master)

    result = rank(reviewed, YEAR)
    rows = [r for r in read_csv(result.excluded_path) if r["key"] == key]
    assert rows and all(r["reason"] == "no decision yet" for r in rows)


def test_included_plus_excluded_equals_every_line_read(ranked):
    assert ranked.included_lines + ranked.excluded_lines == ranked.total_lines == 17
    assert ranked.excluded_lines == 2


def test_the_ranking_covers_every_included_item_not_just_the_top(ranked):
    assert ranked.item_count == 12  # 13 included keys, two of them merged


def test_the_run_file_records_what_the_ranking_did(reviewed, ranked):
    run = json.loads((reviewed / str(YEAR) / "run.json").read_text(encoding="utf-8"))
    assert run["ranked_items"] == 12
    assert run["included_lines"] == 15
    assert run["excluded_lines"] == 2
    assert run["ranked_at"]
    assert any("dated outside 2025" in w for w in run["warnings"])


def test_ranking_stops_when_an_item_has_never_been_reviewed(ingested):
    with pytest.raises(SupplytrackError) as excinfo:
        rank(ingested, YEAR)
    message = str(excinfo.value)
    assert "UNKNOWN_KEY" in message
    assert "review" in message


def test_ranking_stops_when_an_included_item_has_no_pack_size(reviewed):
    master = load_master(reviewed)
    master["pbs:UNV35668"].units_per_pack = ""
    save_master(reviewed, master)
    with pytest.raises(SupplytrackError) as excinfo:
        rank(reviewed, YEAR)
    assert "UPP_MISSING" in str(excinfo.value)
