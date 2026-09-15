"""Lets the package run as `python -m supplytrack`."""
from __future__ import annotations

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
