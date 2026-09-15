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

# --amazon and --preferred came first and are still in written-down commands and in
# PROJECT.md, so they keep working. They name a file the classifier would have found
# anyway, which is why they are only an alias for putting the path on the line.
_ALIAS_HELP = "the {which} export (older spelling; just list the file instead)"


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
    # Imported here, not at the top, for the same reason prices and report are:
    # a checkout missing it still gets a working CLI for everything else. It
    # defines its own arguments so `supplytrack propose` and
    # `python -m supplytrack.propose` cannot come apart.
    from . import propose as propose_mod

    parser = argparse.ArgumentParser(
        prog="supplytrack",
        description=(
            "Build the annual office-supply comparison from the Amazon Business and "
            "Preferred order exports."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    ingest = _sub(subparsers, "ingest", "Read the vendor exports into one line file.")
    ingest.add_argument(
        "exports",
        nargs="*",
        type=Path,
        help=(
            "the export files: workbooks or .csv files, in any order. Every sheet is looked "
            "at and the Amazon and Preferred exports are picked out by their columns."
        ),
    )
    ingest.add_argument("--amazon", type=Path, help=_ALIAS_HELP.format(which="Amazon Business"))
    ingest.add_argument("--preferred", type=Path, help=_ALIAS_HELP.format(which="Preferred"))
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

    propose = subparsers.add_parser(
        "propose",
        help="Ask a model to fill in the review queue's suggestions.",
        description=propose_mod.DESCRIPTION,
    )
    # Its own parser rather than _sub: propose writes a queue file, not the
    # workbook, so --out-dir would be an argument that does nothing. The
    # arguments come from propose.py so the two ways in cannot drift.
    propose.add_argument("--year", required=True, type=int, help="the reporting year, e.g. 2025")
    propose.add_argument(
        "--data-dir",
        type=Path,
        default=None,
        help="where the item master and yearly files live (default: SUPPLYTRACK_DATA or ./data)",
    )
    propose_mod.add_arguments(propose, common=False)
    propose.set_defaults(handler=_cmd_propose)

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

    import_report = subparsers.add_parser(
        "import-report",
        help="Pull the item master and prices back out of a report workbook.",
        description=(
            "Read the Item master, Prices and Prices retired sheets of a report workbook "
            "this tool built and write them back as data/item_master.csv, "
            "data/<year>/prices.csv and data/<year>/prices_retired.csv. This is what makes "
            "last year's report the only file needed to start this year."
        ),
    )
    # Its own parser rather than _sub: this writes data files, never the
    # workbook, so --out-dir would be an argument that does nothing.
    import_report.add_argument(
        "--year", required=True, type=int, help="the reporting year the prices belong to"
    )
    import_report.add_argument(
        "--data-dir",
        type=Path,
        default=None,
        help="where the item master and yearly files live (default: SUPPLYTRACK_DATA or ./data)",
    )
    import_report.add_argument("report", type=Path, help="the report workbook to read")
    import_report.add_argument(
        "--force", action="store_true", help="replace files that are already there"
    )
    import_report.set_defaults(handler=_cmd_import_report)

    validate = _sub(subparsers, "validate", "Run every check against the current files.")
    _add_top(validate)
    validate.set_defaults(handler=_cmd_validate)

    run = _sub(subparsers, "run", "Run every stage, stopping where a person is needed.")
    run.add_argument(
        "exports",
        nargs="*",
        type=Path,
        help=(
            "the export files: workbooks or .csv files, in any order. Every sheet is looked "
            "at and the Amazon and Preferred exports are picked out by their columns."
        ),
    )
    run.add_argument("--amazon", type=Path, help=_ALIAS_HELP.format(which="Amazon Business"))
    run.add_argument("--preferred", type=Path, help=_ALIAS_HELP.format(which="Preferred"))
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


def _export_sources(args) -> list[Path]:
    """Every export path given, positional or through the older flags, in that order.

    One list feeds one classifier, so `run` and `ingest` cannot disagree about which
    file is which. An empty list is not rejected here: `ingest` already says what to
    do about it, in the words the rest of the pipeline uses.
    """
    return list(args.exports) + [p for p in (args.amazon, args.preferred) if p is not None]


def _report_exports(result) -> None:
    """What was read, what was skipped, and whether a vendor is missing."""
    for export in result.exports:
        where = f"{export['file']} sheet {export['sheet']!r}" if export["sheet"] else export["file"]
        label = "Amazon" if export["vendor"] == "amazon" else "Preferred"
        print(f"Read {export['rows']} {label} line(s) from {where}")
    for skipped in result.ignored:
        where = (
            f"{skipped['file']} sheet {skipped['sheet']!r}" if skipped["sheet"] else skipped["file"]
        )
        print(f"Skipped {where}: {skipped['reason']}")
    if len(result.vendors) == 1:
        other = "Preferred" if result.vendors[0] == "amazon" else "Amazon"
        print(f"Only one vendor was found, so this run has no {other} orders in it.")


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
    # Positional paths and the two named flags mean the same thing; the flags
    # stay so the commands written down elsewhere keep working.
    result = ingest(data_dir, args.year, *_export_sources(args))
    _report_exports(result)
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


def _cmd_propose(args) -> int:
    """The optional AI pass over the review queue. Writes a file, never the master."""
    from . import propose

    return propose.run_from_args(args)


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


def _cmd_import_report(args) -> int:
    """Turn last year's report workbook back into the files the pipeline reads."""
    from . import report

    data_dir = _data_dir(args)
    written, missing = report.import_report(data_dir, args.year, args.report, force=args.force)
    for path, rows, label in written:
        print(f"Wrote {rows} row(s) from {label} to {path}")
    for label in missing:
        print(f"{Path(args.report).name} has no {label} sheet, so nothing was written for it.")
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

    # Before anything is read as an export: if one of the files is last year's
    # report workbook and the data folder has no item master or prices of its
    # own, take them from it. Only ever fills a gap, so a run alongside work in
    # progress leaves that work alone.
    from . import report as report_mod

    carried = report_mod.carry_forward(data_dir, args.year, _export_sources(args))
    for path, rows, label, where in carried:
        print(f"Took the {label} ({rows} row(s)) from {where}; the data folder had none.")
        print(f"Wrote {path}")
    carried_prices = any(
        label == report_mod.CARRY_LABELS["prices"] for _, _, label, _ in carried
    )

    result = ingest(data_dir, args.year, *_export_sources(args))
    _report_exports(result)
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

    if carried_prices:
        # The price sheet came out of the report workbook, so it is keyed to the
        # ranking of the year that workbook was built for. Re-cut it against
        # this year's ranking rather than failing every cell the new top N asks
        # for: a price somebody typed is kept, an item new to the top N arrives
        # unpriced, and an item that dropped out moves to prices_retired.csv.
        update = prices.update_prices(data_dir, args.year, args.top)
        print(
            f"Re-cut the carried price sheet for this year's top {args.top}: "
            f"kept {update.kept}, added {update.added}, retired {update.retired}."
        )
        if update.retired:
            print(f"Retired rows moved to {data_dir / str(args.year) / 'prices_retired.csv'}")
        if update.added:
            print(
                "Fill in unit_price and status for the newly added row(s), then run this again."
            )
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
