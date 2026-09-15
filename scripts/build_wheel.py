"""Build a wheel, and refuse to build one whose contents nobody can identify.

Why this exists
---------------
The same pattern as `tax-compliance/tax-form-automation/src/scripts/build_wheel.py`:
a wheel is how the package reaches a machine that is not this checkout, and a
wheel built from a working tree with uncommitted edits cannot be traced back to
any commit. When the output is a workbook leadership makes a purchasing
decision from, "which version of the code produced this?" has to have an
answer.

So the build stops on a dirty tree rather than producing a wheel whose source
is unknowable. Commit or stash first, or pass --allow-dirty and accept that the
wheel is stamped as built from an uncommitted tree.

Unlike the f5471 build this does not bake a hash into the package: supplytrack
has no version command to print one, and a stamp nothing ever reads is just a
file that can go stale. The commit is printed at build time and belongs in
whatever note accompanies the wheel.

Usage
-----
    python scripts/build_wheel.py [--outdir DIR] [--allow-dirty]
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def git(*args: str) -> str:
    out = subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f'git {" ".join(args)} failed:\n{out.stderr.strip()}')
    return out.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--outdir", default=os.path.join(REPO, "dist"))
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help="build even though the working tree has uncommitted edits",
    )
    args = parser.parse_args()

    commit = git("rev-parse", "--short", "HEAD")
    dirty = bool(git("status", "--porcelain", "--untracked-files=no"))

    if dirty and not args.allow_dirty:
        print("REFUSING to build: the working tree has uncommitted changes.", file=sys.stderr)
        print("The wheel would not correspond to any commit, so nobody could say later", file=sys.stderr)
        print("which code produced a given workbook. Commit or stash first, or pass", file=sys.stderr)
        print("--allow-dirty if you accept that.", file=sys.stderr)
        print(git("status", "--short", "--untracked-files=no"), file=sys.stderr)
        return 1

    stamp = commit + ("+" if dirty else "")
    built_at = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    print(f"building supplytrack from {stamp} at {built_at}")

    result = subprocess.run(
        [sys.executable, "-m", "build", "--wheel", "--outdir", args.outdir, REPO], cwd=REPO
    )
    if result.returncode != 0:
        return result.returncode

    print(f"\nwheel written to {args.outdir}")
    print(f"Record the commit with it: {stamp}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
