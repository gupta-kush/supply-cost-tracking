"""Regenerate the shared propose fixtures: `python scripts/make_propose_fixtures.py`.

The files under `tests/fixtures/propose/` are read by both test suites:
`tests/test_propose.py` in Python and `web/tests/suggest-tests.js` in Node.
One canned request per provider proves both ports build the same body from the
same queue rows; one canned response per provider proves both ports parse it
into the same proposal rows. That is the same trick the golden vectors use for
the pipeline itself, at a smaller scale.

The queue rows and the canned responses below are invented. They are shaped to
exercise the awkward cases on purpose: a dozen, a carton of paper counted in
reams, a title with no count at all, a pack size the model could not determine,
a merge onto a canonical name already in use, an exclusion, a proposal for a key
that was never sent, a row the model skipped entirely, and a pack size of zero.

Run it from `src/` after changing the prompt file, the request shape or the
merge rules; read the diff before committing it.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent
sys.path.insert(0, str(SRC))

from supplytrack.propose import (  # noqa: E402
    AnthropicProvider,
    GeminiProvider,
    merge_proposals,
)

OUT = SRC / "tests" / "fixtures" / "propose"

# The canonical names the item master already holds.
EXISTING_NAMES = [
    "Avery Name Tag Inserts",
    "Hammermill Copy Paper",
    "Post-it Sign Here Flags, Yellow",
]

# A batch as it comes off review_queue.csv. The columns nothing is allowed to
# send (queue_reason, include_reason, upp_reason, canonical_reason, note) carry
# distinctive text here so a leak would be obvious in the request fixture.
QUEUE_ROWS = [
    {
        "key": "amz:bic round stic ballpoint pens black 60 count",
        "source": "amazon",
        "raw_title": "BIC Round Stic Ballpoint Pens, Black, 5 Dozen",
        "amazon_category": "Office Product",
        "packs_in_year": "10",
        "queue_reason": "unknown key",
        "include": "y",
        "include_reason": "category Office Product is an office-supply category",
        "units_per_pack": "",
        "upp_candidates": "",
        "upp_reason": "no pack size in the title; check the listing or enter 1 if it is sold singly",
        "canonical_name": "BIC Round Stic Ballpoint Pens, Black, 5 Dozen",
        "canonical_reason": "no close match to an existing item, so the title becomes the name",
        "unit_label": "EA",
        "note": "confidential-note-do-not-send ordered by buyer@example.invalid",
    },
    {
        "key": "amz:hammermill copy paper 8.5 x 11 500 sheets/ream 10 reams/carton",
        "source": "amazon",
        "raw_title": "Hammermill Copy Paper, 8.5 x 11, 500 Sheets/Ream, 10 Reams/Carton",
        "amazon_category": "Office Product",
        "packs_in_year": "8",
        "queue_reason": "pack size unconfirmed",
        "include": "y",
        "include_reason": "already in the item master",
        "units_per_pack": "10",
        "upp_candidates": "10 (10 Reams/Carton)|500 (500 Sheets)",
        "upp_reason": "10 came from title and nobody has confirmed it",
        "canonical_name": "Hammermill Copy Paper",
        "canonical_reason": "the name already in the item master",
        "unit_label": "RM",
        "note": "",
    },
    {
        "key": "pbs:UNV21200",
        "source": "preferred",
        "raw_title": "FILE FOLDER LETTER 1/3 CUT MANILA",
        "amazon_category": "",
        "pack_desc": "BX100",
        "packs_in_year": "6",
        "queue_reason": "unknown key",
        "include": "y",
        "include_reason": "Preferred is an office-supply vendor",
        "units_per_pack": "",
        "upp_candidates": "",
        "upp_reason": "Preferred pack code BX100 means 100 per purchase unit",
        "canonical_name": "FILE FOLDER LETTER 1/3 CUT MANILA",
        "canonical_reason": "no close match to an existing item, so the title becomes the name",
        "unit_label": "EA",
        "note": "",
    },
    {
        "key": "amz:avery name badge inserts 200 inserts",
        "source": "amazon",
        "raw_title": "Avery Name Badge Inserts, 200 Inserts",
        "amazon_category": "Office Product",
        "packs_in_year": "4",
        "queue_reason": "unknown key",
        "include": "y",
        "include_reason": "category Office Product is an office-supply category",
        "units_per_pack": "200",
        "upp_candidates": "200 (200 Inserts)",
        "upp_reason": 'the title says "200 Inserts"',
        "canonical_name": "Avery Name Badge Inserts, 200 Inserts",
        "canonical_reason": "no close match to an existing item, so the title becomes the name",
        "unit_label": "EA",
        "note": "",
    },
    {
        "key": "amz:heavy duty stapler full strip",
        "source": "amazon",
        "raw_title": "Heavy Duty Stapler, Full Strip, Black",
        "amazon_category": "Office Product",
        "packs_in_year": "3",
        "queue_reason": "unknown key",
        "include": "y",
        "include_reason": "category Office Product is an office-supply category",
        "units_per_pack": "",
        "upp_candidates": "",
        "upp_reason": "no pack size in the title; check the listing or enter 1 if it is sold singly",
        "canonical_name": "Heavy Duty Stapler, Full Strip, Black",
        "canonical_reason": "no close match to an existing item, so the title becomes the name",
        "unit_label": "EA",
        "note": "",
    },
    {
        "key": "amz:bubly sparkling water 18 cans",
        "source": "amazon",
        "raw_title": "Bubly Sparkling Water, Assorted, 18 Cans",
        "amazon_category": "Grocery",
        "packs_in_year": "12",
        "queue_reason": "unknown key",
        "include": "n",
        "include_reason": "category Grocery is not an office supply",
        "units_per_pack": "18",
        "upp_candidates": "18 (18 Cans)",
        "upp_reason": 'the title says "18 Cans"',
        "canonical_name": "Bubly Sparkling Water, Assorted, 18 Cans",
        "canonical_reason": "no close match to an existing item, so the title becomes the name",
        "unit_label": "EA",
        "note": "",
    },
    {
        "key": "amz:post-it sign here flags red 2 x 50",
        "source": "amazon",
        "raw_title": "Post-it Sign Here Flags, Red, 2 x 50 Flags",
        "amazon_category": "Office Product",
        "packs_in_year": "5",
        "queue_reason": "unknown key",
        "include": "y",
        "include_reason": "category Office Product is an office-supply category",
        "units_per_pack": "",
        "upp_candidates": "50 (50 Flags)",
        "upp_reason": "the title states 2 different numbers; enter how many units come in one purchase unit",
        "canonical_name": "Post-it Sign Here Flags, Red, 2 x 50 Flags",
        "canonical_reason": "no close match to an existing item, so the title becomes the name",
        "unit_label": "EA",
        "note": "",
    },
    {
        "key": "amz:expo dry erase markers chisel tip assorted",
        "source": "amazon",
        "raw_title": "EXPO Dry Erase Markers, Chisel Tip, Assorted Colors",
        "amazon_category": "",
        "packs_in_year": "2",
        "queue_reason": "unknown key",
        "include": "",
        "include_reason": "no Amazon category on this line, needs a decision",
        "units_per_pack": "",
        "upp_candidates": "",
        "upp_reason": "no pack size in the title; check the listing or enter 1 if it is sold singly",
        "canonical_name": "EXPO Dry Erase Markers, Chisel Tip, Assorted Colors",
        "canonical_reason": "no close match to an existing item, so the title becomes the name",
        "unit_label": "EA",
        "note": "",
    },
]

# What a model answered. Deliberately imperfect: one proposal is for a key that
# was never sent, one pack size is zero, one is null, one confidence value is a
# word the schema does not allow, and the last queue row is not answered at all.
PROPOSALS = [
    {
        "key": "amz:bic round stic ballpoint pens black 60 count",
        "include": "y",
        "include_reason": "ballpoint pens are an office supply",
        "units_per_pack": 60,
        "upp_reason": "5 dozen is 5 times 12",
        "unit_label": "EA",
        "canonical_name": "BIC Round Stic Ballpoint Pens, Black",
        "canonical_reason": "brand and product without the pack size",
        "confidence": "high",
    },
    {
        "key": "amz:hammermill copy paper 8.5 x 11 500 sheets/ream 10 reams/carton",
        "include": "y",
        "include_reason": "copy paper is an office supply",
        "units_per_pack": 10,
        "upp_reason": "the carton holds 10 reams and paper counts by the ream",
        "unit_label": "RM",
        "canonical_name": "Hammermill Copy Paper",
        "canonical_reason": "same product as the existing Hammermill Copy Paper",
        "confidence": "high",
    },
    {
        "key": "pbs:UNV21200",
        "include": "y",
        "include_reason": "file folders are an office supply",
        "units_per_pack": 100,
        "upp_reason": "the Preferred pack code BX100 means 100 per box",
        "unit_label": "EA",
        "canonical_name": "Manila File Folders, Letter, 1/3 Cut",
        "canonical_reason": "plain name for the folder described by the code",
        "confidence": "high",
    },
    {
        "key": "amz:avery name badge inserts 200 inserts",
        "include": "y",
        "include_reason": "name badge inserts are an office supply",
        "units_per_pack": None,
        "upp_reason": "cannot tell whether 200 is the pack or the sheet count",
        "unit_label": "EA",
        "canonical_name": "Avery Name Tag Inserts",
        "canonical_reason": "same insert product as the existing Avery Name Tag Inserts",
        "confidence": "medium",
    },
    {
        "key": "amz:heavy duty stapler full strip",
        "include": "y",
        "include_reason": "a stapler is an office supply",
        "units_per_pack": 1,
        "upp_reason": "the title states no count, so one stapler per pack",
        "unit_label": "EA",
        "canonical_name": "Heavy Duty Stapler, Full Strip",
        "canonical_reason": "brand free name, colour is not a separate product here",
        "confidence": "low",
    },
    {
        "key": "amz:bubly sparkling water 18 cans",
        "include": "n",
        "include_reason": "sparkling water is a grocery item, not an office supply",
        "units_per_pack": 18,
        "upp_reason": "the title says 18 cans",
        "unit_label": "EA",
        "canonical_name": "Bubly Sparkling Water",
        "canonical_reason": "plain name without the pack size",
        "confidence": "high",
    },
    {
        "key": "amz:post-it sign here flags red 2 x 50",
        "include": "y",
        "include_reason": "flags are an office supply",
        "units_per_pack": 0,
        "upp_reason": "two dispensers of 50 flags, unclear which is the purchase unit",
        "unit_label": "EA",
        "canonical_name": "Post-it Sign Here Flags, Red",
        "canonical_reason": "colour variants stay separate from the yellow flags",
        "confidence": "certain",
    },
    {
        "key": "amz:this key was never in the batch",
        "include": "y",
        "include_reason": "invented row that must be dropped",
        "units_per_pack": 99,
        "upp_reason": "invented",
        "unit_label": "EA",
        "canonical_name": "Invented Item",
        "canonical_reason": "invented",
        "confidence": "high",
    },
]

# The value merge_proposals is given in the fixture. Both ports use this same
# string so the expected rows do not depend on which provider was asked.
PROPOSED_BY = "anthropic:claude-sonnet-5"


def write(name: str, doc) -> None:
    path = OUT / name
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    path.write_bytes(text.encode("utf-8"))
    print(f"wrote {path.relative_to(SRC)} ({len(text)} chars)")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)

    anthropic = AnthropicProvider(model="claude-sonnet-5", api_key="")
    gemini = GeminiProvider(model="gemini-3.1-flash-lite", api_key="")

    a_request = anthropic.build_request(QUEUE_ROWS, EXISTING_NAMES)
    g_request = gemini.build_request(QUEUE_ROWS, EXISTING_NAMES)

    anthropic_response = {
        "id": "msg_fixture",
        "type": "message",
        "role": "assistant",
        "model": "claude-sonnet-5",
        "stop_reason": "tool_use",
        "content": [
            {
                "type": "tool_use",
                "id": "toolu_fixture",
                "name": "record_proposals",
                "input": {"proposals": PROPOSALS},
            }
        ],
    }
    gemini_response = {
        "candidates": [
            {
                "content": {
                    "role": "model",
                    "parts": [{"text": json.dumps(PROPOSALS, ensure_ascii=False)}],
                },
                "finishReason": "STOP",
            }
        ]
    }

    expected = merge_proposals(QUEUE_ROWS, PROPOSALS, PROPOSED_BY)

    write("queue_rows.json", QUEUE_ROWS)
    write("existing_names.json", EXISTING_NAMES)
    write("anthropic_request.json", {"url": a_request.url, "body": a_request.body})
    write("gemini_request.json", {"url": g_request.url, "body": g_request.body})
    write("anthropic_response.json", anthropic_response)
    write("gemini_response.json", gemini_response)
    write("proposals.json", PROPOSALS)
    write("expected_rows.json", {"proposed_by": PROPOSED_BY, "rows": expected})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
