"""The one exception this package raises for a failure a person must act on."""
from __future__ import annotations


class SupplytrackError(Exception):
    """A hard failure with a plain-language message.

    Raised instead of letting a KeyError or a ValueError escape, so the CLI can
    print something the office manager can act on ("the Amazon export is missing the
    column Item Quantity") rather than a traceback. Nothing in this package
    prints; ``cli.py`` catches this and turns it into a message and an exit
    code.
    """
