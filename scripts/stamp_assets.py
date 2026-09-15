"""Stamp a version query string onto every local asset reference before deploying `web/`.

Why this exists
----------------
GitHub Pages serves every file with `Cache-Control: max-age=600`, and the browser app is a
graph of ES modules loaded one file at a time (`index.html` -> `js/app.js` -> `js/pipeline.js`,
`js/report.js`, `js/xlsxio.js`, `js/csv.js`, `js/suggest.js`, plus `prompts/proposal.json`
fetched at runtime). A browser that already has one file cached can, for up to ten minutes
after a deploy, load that stale file next to a fresh one - an old `app.js` calling into a new
`pipeline.js`, for example. Appending `?v=<short commit sha>` to every reference makes each
deploy either fully old or fully new: the query string is part of the URL a browser caches
against, so a new sha is always a cache miss, and a browser that has not reloaded keeps getting
the old file it already cached under the old query string.

This script never edits `web/` in place. It copies it to a build directory and stamps only the
copy, so the source tree stays exactly what is committed and `git status` after a run shows
nothing changed. See `docs/webapp-spec.md` section 8 and `web/README.md` for how this fits into
the GitHub Pages workflow (`.github/workflows/pages.yml`), which calls this script before
`actions/upload-pages-artifact` and runs `node --check` on the result.

What gets stamped, in the copy only
------------------------------------
- `index.html`: every relative `src="...js"` / `href="...css"` (including the vendored
  `vendor/exceljs.min.js` and `vendor/main.css` - the file's own bytes are untouched, only the
  URL that loads it).
- `web/js/*.js`: every relative static import (`from "./x.js"`), every relative dynamic import
  (`import("./x.js")`), and the AI prompt's relative fetch path (`"../prompts/proposal.json"`
  inside `suggest.js`'s `new URL(...)` call).

A bare specifier such as `import("node:module")` (used by `xlsxio.js` on the Node side) has no
leading `./` or `../` and is left alone - it is never a same-origin file this deploy could be
stale about. Anything already carrying a query string is appended to with `&`, never
overwritten, so running this twice (or stamping a file some other tool already versioned) never
doubles up on `?v=`.

Usage
-----
    cd src && python scripts/stamp_assets.py web out/web-stamped abc1234

Standard library only, so it needs nothing installed beyond Python 3.10+.
"""
from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path

# ------------------------------------------------------------------ helpers

_EXTERNAL_PREFIXES = ("http://", "https://", "//", "data:")


def _is_local(path: str) -> bool:
    """False for anything that is not this deploy's own file: an absolute URL or a data URI."""
    return not path.startswith(_EXTERNAL_PREFIXES)


def _append_version(existing_query: str, version: str) -> str:
    """`existing_query` is `""` or a leading-`?` query string, taken verbatim from the match."""
    if existing_query:
        return f"{existing_query}&v={version}"
    return f"?v={version}"


def _stamp(text: str, pattern: "re.Pattern[str]", version: str, *, check_local: bool = False) -> str:
    def repl(match: "re.Match[str]") -> str:
        path = match.group("path")
        if check_local and not _is_local(path):
            return match.group(0)
        query = match.group("query") or ""
        prefix = match.group("prefix") if "prefix" in match.groupdict() else ""
        quote = match.group("quote")
        return f"{prefix}{quote}{path}{_append_version(query, version)}{quote}"

    return pattern.sub(repl, text)


# ------------------------------------------------------------------ index.html

# `src="js/app.js"`, `href="vendor/main.css"`, `src="vendor/exceljs.min.js"` - the attribute
# name plus a quoted path ending in .js or .css, an existing query string (if any) captured
# separately so it is extended rather than clobbered.
_HTML_ASSET_RE = re.compile(
    r'(?P<prefix>\b(?:src|href)\s*=\s*)(?P<quote>["\'])'
    r'(?P<path>[^"\']+?\.(?:js|css))(?P<query>\?[^"\']*)?(?P=quote)'
)


def stamp_html(text: str, version: str) -> str:
    """Version every relative `.js`/`.css` `src=`/`href=` in an HTML document."""
    return _stamp(text, _HTML_ASSET_RE, version, check_local=True)


# ------------------------------------------------------------------ web/js/*.js

# `import ... from "./pipeline.js"` / `export ... from "../x.js"`. Restricted to a leading
# `./` or `../` so a bare specifier (a Node built-in, a bundler alias) is never touched.
_JS_STATIC_IMPORT_RE = re.compile(
    r'(?P<prefix>\bfrom\s*)(?P<quote>["\'])'
    r'(?P<path>\.\.?/[^"\']+?\.m?js)(?P<query>\?[^"\']*)?(?P=quote)'
)

# `import("./pipeline.js")`, the dynamic-import form app.js uses to load the logic modules.
_JS_DYNAMIC_IMPORT_RE = re.compile(
    r'(?P<prefix>\bimport\s*\(\s*)(?P<quote>["\'])'
    r'(?P<path>\.\.?/[^"\']+?\.m?js)(?P<query>\?[^"\']*)?(?P=quote)'
)

# The one non-`.js` runtime fetch: suggest.js's `new URL("../prompts/proposal.json", ...)`.
# Matched by shape (a quoted relative path ending in .json) rather than by file name, so it
# does not silently stop working if the prompt is ever renamed.
_JS_JSON_PATH_RE = re.compile(
    r'(?P<quote>["\'])(?P<path>\.\.?/[^"\']+?\.json)(?P<query>\?[^"\']*)?(?P=quote)'
)


def stamp_js(text: str, version: str) -> str:
    """Version every relative import specifier and the relative JSON fetch path in one module."""
    text = _stamp(text, _JS_STATIC_IMPORT_RE, version)
    text = _stamp(text, _JS_DYNAMIC_IMPORT_RE, version)
    text = _stamp(text, _JS_JSON_PATH_RE, version)
    return text


# ------------------------------------------------------------------ the tree

def stamp_tree(src_dir: Path, out_dir: Path, version: str) -> list[Path]:
    """Copy `src_dir` to `out_dir` (replacing it if it already exists) and stamp the copy.

    Returns the list of files this function looked at for stamping (`index.html` plus every
    `out_dir/js/*.js`), whether or not stamping actually changed their bytes - a convenient set
    for a caller that wants to run `node --check` afterwards.
    """
    src_dir = Path(src_dir)
    out_dir = Path(out_dir)

    if out_dir.exists():
        shutil.rmtree(out_dir)
    shutil.copytree(src_dir, out_dir)

    touched: list[Path] = []

    index_html = out_dir / "index.html"
    if index_html.is_file():
        original = index_html.read_text(encoding="utf-8")
        stamped = stamp_html(original, version)
        if stamped != original:
            index_html.write_text(stamped, encoding="utf-8")
        touched.append(index_html)

    js_dir = out_dir / "js"
    if js_dir.is_dir():
        for js_file in sorted(js_dir.glob("*.js")):
            original = js_file.read_text(encoding="utf-8")
            stamped = stamp_js(original, version)
            if stamped != original:
                js_file.write_text(stamped, encoding="utf-8")
            touched.append(js_file)

    return touched


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Copy a web app folder and stamp ?v=<version> onto its local asset refs."
    )
    parser.add_argument("src", help="Folder to copy from, e.g. web")
    parser.add_argument("outdir", help="Folder to write the stamped copy to")
    parser.add_argument("version", help="Version token appended as ?v=<version>, e.g. a short sha")
    args = parser.parse_args(argv)

    touched = stamp_tree(Path(args.src), Path(args.outdir), args.version)
    print(f"Stamped {len(touched)} file(s) into {args.outdir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
