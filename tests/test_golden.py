"""Guards ``tests/golden/`` against silent drift.

This regenerates every golden file into a temporary directory using the exact
same code ``scripts/make_golden.py`` runs, and diffs the result byte-for-byte
against what is committed under ``tests/golden/``. If supplytrack's behaviour
changes - deliberately or not - this is what turns that into a loud, specific
failure instead of a JavaScript port silently drifting out of sync with a set
of vectors nobody re-checked.

A failure here means one of two things:

* the change was deliberate: regenerate with ``python scripts/make_golden.py``,
  read the diff under ``tests/golden/`` to make sure it says what you expect,
  and commit the vectors alongside the change that caused them; or
* the change was not deliberate: something in ``supplytrack`` regressed.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent
GOLDEN = SRC / "tests" / "golden"
SCRIPT_PATH = SRC / "scripts" / "make_golden.py"


def _load_make_golden():
    """Import scripts/make_golden.py as a module without needing scripts/ on sys.path."""
    if "make_golden" in sys.modules:
        return sys.modules["make_golden"]
    spec = importlib.util.spec_from_file_location("make_golden", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["make_golden"] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_golden_vectors_match_committed_files(tmp_path):
    make_golden = _load_make_golden()
    produced = make_golden.build_everything(tmp_path)

    assert produced, "make_golden produced no files at all - something is badly wrong"

    stale: list[str] = []
    missing: list[str] = []
    for rel_path, content in produced.items():
        committed_path = GOLDEN / rel_path
        if not committed_path.exists():
            missing.append(rel_path)
            continue
        if committed_path.read_bytes() != content:
            stale.append(rel_path)

    problems = []
    if missing:
        problems.append(
            "not committed under tests/golden/ (run `python scripts/make_golden.py`): "
            + ", ".join(sorted(missing))
        )
    if stale:
        problems.append(
            "differ from the committed file (behaviour changed - regenerate and review "
            "the diff, or this is a regression): " + ", ".join(sorted(stale))
        )
    assert not problems, "\n".join(problems)


def test_make_golden_is_idempotent(tmp_path):
    """Running the generator twice must produce identical bytes every time.

    Anything that fails this - a timestamp that slipped past normalisation, an
    unordered dict or set leaking into the JSON dump - would otherwise show up
    only as an intermittent, hard-to-reproduce diff whenever someone regenerates
    the vectors on a different machine or at a different moment.
    """
    make_golden = _load_make_golden()
    first = make_golden.build_everything(tmp_path / "run1")
    second = make_golden.build_everything(tmp_path / "run2")
    assert first.keys() == second.keys()
    mismatched = [rel_path for rel_path in first if first[rel_path] != second[rel_path]]
    assert not mismatched, f"not deterministic between runs: {mismatched}"
