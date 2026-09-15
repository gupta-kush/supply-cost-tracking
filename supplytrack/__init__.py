"""supplytrack - the annual office-supply spend comparison, as a repeatable command.

The pipeline is deterministic end to end. Every judgement call a person makes
(is this an office supply, are these two listings the same product, how many
units are in a pack) is recorded once in ``data/item_master.csv`` and carried
forward, so each year only genuinely new items need a decision.

Stages: ingest -> review -> rank -> prices -> report, with validate available
standalone and run inside rank.
"""
from __future__ import annotations

__version__ = "0.1.0"

from .errors import SupplytrackError

__all__ = ["SupplytrackError", "__version__"]
