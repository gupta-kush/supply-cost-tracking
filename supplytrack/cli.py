"""The command line. The only module that prints.

Exit codes are part of the interface:

* ``0`` - it worked.
* ``1`` - something is wrong with the data and the build stopped.
* ``2`` - the tool needs a person: new items to review, or a price sheet to fill in.

Two of the stages live in modules another part of the project owns
(``prices`` and ``report``), so they are imported inside the handler that
needs them. That way every other command still works in a checkout where they
are not present yet, instead of the whole CLI failing to start.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from .errors import SupplytrackError
from .master import default_data_dir, default_out_dir
from .validate import Finding

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_NEEDS_PERSON = 2

DEFAULT_TOP = 25


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except SupplytrackError as exc:
        print(f"FAIL {exc}")
        return EXIT_FAIL
    except KeyboardInterrupt:  # pragma: no cover - interactive only
        print("Stopped.")
        return EXIT_FAIL


# ------------------------------------------------------------------ parsing


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="supplytrack",
        description=(
            "Build the annual office-supply comparison from the Amazon Business and "
            "Preferred order exports."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    ingest = _sub(subparsers, "ingest", "Read the vendor exports into one line file.")
    ingest.add_argument("--amazon", required=True, type=Path, help="the Amazon Business export")
    ingest.add_argument("--preferred", type=Path, help="the Preferred order history")
    ingest.set_defaults(handler=_cmd_ingest)

    review = _sub(subparsers, "review", "List what still needs a decision.")
    review.add_argument(
        "--apply", type=Path, metavar="FILE", help="merge a filled review queue into the master"
    )
    review.add_argument(
        "--proposed",
        action="store_true",
        help=(
            "record the pack sizes as proposed rather than confirmed, for a queue filled in "
            "by Claude without a person checking it"
        ),
    )
    review.set_defaults(handler=_cmd_review)

    rank = _sub(subparsers, "rank", "Rank items by how many units were bought.")
    _add_top(rank)
    rank.set_defaults(handler=_cmd_rank)

    prices = _sub(subparsers, "prices", "Write or check the vendor price sheet.")
    _add_top(prices)
    prices_mode = prices.add_mutually_exclusive_group()
    prices_mode.add_argument(
        "--template", action="store_true", help="write a blank price sheet to fill in"
    )
    prices_mode.add_argument(
        "--update",
        action="store_true",
        help=(
            "rewrite the price sheet for a re-ranked top N, keeping typed prices for items "
            "still in the top N, adding unpriced rows for new ones, and moving items that "
            "dropped out to prices_retired.csv"
        ),
    )
    prices.set_defaults(handler=_cmd_prices)

    report = _sub(subparsers, "report", "Build the leadership workbook.")
    _add_top(report)
    report.set_defaults(handler=_cmd_report)

    validate = _sub(subparsers, "validate", "Run every check against the current files.")
    _add_top(validate)
    validate.set_defaults(handler=_cmd_validate)

    run = _sub(subparsers, "run", "Run every stage, stopping where a person is needed.")
    run.add_argument("--amazon", required=True, type=Path, help="the Amazon Business export")
    run.add_argument("--preferred", type=Path, help="the Preferred order history")
    _add_top(run)
    run.set_defaults(handler=_cmd_run)

    return parser


def _sub(subparsers, name: str, help_text: str) -> argparse.ArgumentParser:
    parser = subparsers.add_parser(name, help=help_text, description=help_text)
    parser.add_argument("--year", required=True, type=int, help="the reporting year, e.g. 2025")
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=None,
        help="where the item master and yearly files live (default: SUPPLYTRACK_DATA or ./data)",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help="where the workbook is written (default: SUPPLYTRACK_OUT or ./out)",
    )
    return parser


def _add_top(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--top", type=int, default=DEFAULT_TOP, help=f"how many items to price and report (default {DEFAULT_TOP})"
    )


def _data_dir(args) -> Path:
    path = Path(args.data_dir) if args.data_dir else default_data_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path


def _out_dir(args) -> Path:
    path = Path(args.out_dir) if args.out_dir else default_out_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path


# ----------------------------------------------------------------- printing


def _print_findings(findings: list[Finding]) -> int:
    """Print every finding and return the number of failures."""
    for finding in findings:
        print(f"{finding.level.upper()} {finding.code} {finding.message}")
    return sum(1 for f in findings if f.level == "fail")


# ----------------------------------------------------------------- commands


def _cmd_ingest(args) -> int:
    from .ingest import ingest

    data_dir = _data_dir(args)
    result = ingest(data_dir, args.year, args.amazon, args.preferred)
    print(f"Read {result.amazon_rows} Amazon line(s) from {result.amazon_file}")
    if result.preferred_file:
        print(f"Read {result.preferred_rows} Preferred line(s) from {result.preferred_file}")
    span = f"{result.date_min} to {result.date_max}" if result.date_min else "no dates"
    print(f"Wrote {result.rows_written} line(s) covering {span} to {result.lines_path}")
    for warning in result.warnings:
        print(f"WARN {warning}")
    return EXIT_OK


def _cmd_review(args) -> int:
    from .review import (
        BLOCKING_REASONS,
        apply_queue,
        build_queue,
        queue_counts,
        queue_reason_counts,
    )

    data_dir = _data_dir(args)
    if args.apply:
        written = apply_queue(data_dir, args.year, args.apply, proposed=args.proposed)
        how = "proposed" if args.proposed else "confirmed"
        print(
            f"Wrote {written} {how} item(s) to the item master from {Path(args.apply).name}"
        )

    queue_path = build_queue(data_dir, args.year)
    blocking, unconfirmed = queue_counts(queue_path)

    for reason, count in queue_reason_counts(queue_path).items():
        if count:
            blocks = "blocks the build" if reason in BLOCKING_REASONS else "does not block"
            print(f"  {count:>4}  {reason} ({blocks})")

    if blocking:
        print(f"{blocking} item(s) must be decided before anything can be built: {queue_path}")
        print("Fill in include, units_per_pack and canonical_name, then run review --apply on it.")
        if unconfirmed:
            print(f"{unconfirmed} more item(s) in the same file have a pack size to confirm.")
        return EXIT_NEEDS_PERSON

    if unconfirmed:
        print(f"Nothing is blocking the build for {args.year}.")
        print(
            f"{unconfirmed} item(s) are ranked on a pack size nobody has confirmed: {queue_path}"
        )
        return EXIT_OK

    print("Nothing to review: every item in this year's orders has a confirmed pack size.")
    return EXIT_OK


def _cmd_rank(args) -> int:
    from .rank import rank

    data_dir = _data_dir(args)
    result = rank(data_dir, args.year)
    print(
        f"Ranked {result.item_count} item(s) from {result.included_lines} included line(s); "
        f"{result.excluded_lines} line(s) excluded of {result.total_lines} read"
    )
    print(f"Wrote {result.ranked_path}")
    print(f"Wrote {result.excluded_path}")
    for item in result.items[: max(args.top, 0)]:
        print(
            f"  {item['rank']:>3}  {item['eaches']:>7} {item['unit_label'] or 'EA':<4} "
            f"{item['canonical_name'][:60]}"
        )
    for warning in result.warnings:
        print(f"WARN {warning}")
    return EXIT_OK


def _cmd_prices(args) -> int:
    from . import prices

    data_dir = _data_dir(args)
    if args.template:
        path = prices.write_template(data_dir, args.year, args.top)
        print(f"Wrote a blank price sheet for the top {args.top}: {path}")
        print("Fill in unit_price and status for each vendor, then run prices again to check it.")
        return EXIT_NEEDS_PERSON

    if args.update:
        result = prices.update_prices(data_dir, args.year, args.top)
        print(
            f"Updated the price sheet for the top {args.top}: kept {result.kept}, "
            f"added {result.added}, retired {result.retired}."
        )
        print(f"Wrote {result.path}")
        if result.retired:
            print(f"Retired rows moved to {data_dir / str(args.year) / 'prices_retired.csv'}")
        if result.added:
            print(
                "Fill in unit_price and status for the newly added row(s), then run prices "
                "again to check it."
            )
            return EXIT_NEEDS_PERSON
        return EXIT_OK

    from .validate import check_prices

    findings = check_prices(data_dir, args.year, args.top)
    failures = _print_findings(findings)
    if failures:
        return EXIT_FAIL
    print(f"The price sheet for {args.year} is complete for the top {args.top}.")
    return EXIT_OK


def _cmd_report(args) -> int:
    from . import report

    data_dir = _data_dir(args)
    out_dir = _out_dir(args)
    path = report.build_report(data_dir, out_dir, args.year, args.top)
    print(f"Wrote {path}")
    return EXIT_OK


def _cmd_validate(args) -> int:
    from .validate import run_all

    data_dir = _data_dir(args)
    findings = run_all(data_dir, args.year, args.top)
    failures = _print_findings(findings)
    if failures:
        print(f"{failures} check(s) failed. The build is not publishable until they are fixed.")
        return EXIT_FAIL
    if findings:
        print(f"No failures. {len(findings)} warning(s) above are worth a look.")
    else:
        print("Every check passed.")
    return EXIT_OK


def _cmd_run(args) -> int:
    """Every stage in order, stopping wherever a person has to decide something."""
    from .ingest import ingest
    from .rank import rank
    from .review import build_queue, queue_counts

    data_dir = _data_dir(args)
    out_dir = _out_dir(args)

    result = ingest(data_dir, args.year, args.amazon, args.preferred)
    print(f"Ingested {result.rows_written} line(s) for {args.year}")
    for warning in result.warnings:
        print(f"WARN {warning}")

    queue_path = build_queue(data_dir, args.year)
    blocking, unconfirmed = queue_counts(queue_path)
    if blocking:
        print(f"{blocking} item(s) need a decision before the report can be built.")
        print(f"Review queue: {queue_path}")
        print(
            "Fill in include, units_per_pack and canonical_name, apply it with "
            f"`supplytrack review --year {args.year} --apply {queue_path}`, then run this again."
        )
        return EXIT_NEEDS_PERSON
    if unconfirmed:
        # Usable numbers, so the build carries on rather than stalling on a
        # confirmation that can happen any time.
        print(
            f"{unconfirmed} item(s) are ranked on a pack size nobody has confirmed. "
            f"Carrying on; they are listed in {queue_path}."
        )

    ranked = rank(data_dir, args.year)
    print(f"Ranked {ranked.item_count} item(s) from {ranked.included_lines} included line(s)")

    from . import prices
    from .validate import check_prices

    prices_path = data_dir / str(args.year) / "prices.csv"
    if not prices_path.exists():
        path = prices.write_template(data_dir, args.year, args.top)
        print(f"No prices yet for {args.year}. Wrote a blank price sheet: {path}")
        print("Fill in unit_price and status for each vendor, then run this again.")
        return EXIT_NEEDS_PERSON

    findings = check_prices(data_dir, args.year, args.top)
    if _print_findings(findings):
        return EXIT_FAIL

    from . import report

    path = report.build_report(data_dir, out_dir, args.year, args.top)
    print(f"Wrote {path}")
    return EXIT_OK


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
