"""Tests for scripts/stamp_assets.py: the deploy-time cache-busting stamp.

Unit tests below build tiny synthetic HTML/JS strings so each case (a script tag, a stylesheet
link, a static import, a dynamic import, the AI prompt's JSON fetch, an already-versioned
specifier) is checked in isolation and stays readable when one of them fails. The last test runs
the real thing against `web/` itself and asks Node to parse every file that came out, which is
the check that would actually catch a regex mistake big enough to break the page.
"""
from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parent.parent
SCRIPT_PATH = SRC / "scripts" / "stamp_assets.py"
WEB_DIR = SRC / "web"


def _load_stamp_assets():
    """Import scripts/stamp_assets.py as a module without scripts/ on sys.path
    (same pattern as tests/test_golden.py for scripts/make_golden.py)."""
    if "stamp_assets" in sys.modules:
        return sys.modules["stamp_assets"]
    spec = importlib.util.spec_from_file_location("stamp_assets", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["stamp_assets"] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


stamp_assets = _load_stamp_assets()
VERSION = "abc1234"


# ------------------------------------------------------------------ index.html

def test_script_tag_is_stamped():
    html = '<script type="module" src="js/app.js"></script>'
    out = stamp_assets.stamp_html(html, VERSION)
    assert out == f'<script type="module" src="js/app.js?v={VERSION}"></script>'


def test_vendor_script_tag_is_stamped_the_same_way():
    # Keep vendor/ files versioned the same way: the reference is stamped, the
    # vendored file's own bytes are never touched by this script.
    html = '<script src="vendor/exceljs.min.js"></script>'
    out = stamp_assets.stamp_html(html, VERSION)
    assert out == f'<script src="vendor/exceljs.min.js?v={VERSION}"></script>'


def test_stylesheet_link_is_stamped():
    html = '<link rel="stylesheet" href="vendor/main.css">'
    out = stamp_assets.stamp_html(html, VERSION)
    assert out == f'<link rel="stylesheet" href="vendor/main.css?v={VERSION}">'


def test_non_asset_href_is_left_alone():
    # An icon/image reference is neither .js nor .css and must not be touched.
    html = '<link rel="icon" href="assets/mark.svg">'
    assert stamp_assets.stamp_html(html, VERSION) == html


def test_external_script_is_left_alone():
    html = '<script src="https://cdnjs.cloudflare.com/lib.js"></script>'
    assert stamp_assets.stamp_html(html, VERSION) == html


# ------------------------------------------------------------------ web/js/*.js

def test_static_import_specifier_is_stamped():
    js = 'import * as csvlib from "./csv.js";\nimport { parse } from "../lib/csv.js";\n'
    out = stamp_assets.stamp_js(js, VERSION)
    assert f'from "./csv.js?v={VERSION}"' in out
    assert f'from "../lib/csv.js?v={VERSION}"' in out


def test_dynamic_import_specifier_is_stamped():
    js = 'pipeline = await import("./pipeline.js");'
    out = stamp_assets.stamp_js(js, VERSION)
    assert out == f'pipeline = await import("./pipeline.js?v={VERSION}");'


def test_bare_specifier_is_never_touched():
    # xlsxio.js's Node-only branch: no leading ./ or ../, and not this deploy's file.
    js = 'const { createRequire } = await import("node:module");'
    assert stamp_assets.stamp_js(js, VERSION) == js


def test_prompt_fetch_path_is_stamped():
    js = 'export const PROMPT_URL = new URL("../prompts/proposal.json", import.meta.url);'
    out = stamp_assets.stamp_js(js, VERSION)
    assert out == (
        f'export const PROMPT_URL = new URL("../prompts/proposal.json?v={VERSION}", '
        f"import.meta.url);"
    )


def test_specifier_with_existing_query_string_is_not_double_appended():
    js = 'import("./pipeline.js?raw=1")'
    out = stamp_assets.stamp_js(js, VERSION)
    assert out == f'import("./pipeline.js?raw=1&v={VERSION}")'
    assert out.count("?") == 1


def test_html_href_with_existing_query_string_is_not_double_appended():
    html = '<link rel="stylesheet" href="css/app.css?already=1">'
    out = stamp_assets.stamp_html(html, VERSION)
    assert out == f'<link rel="stylesheet" href="css/app.css?already=1&v={VERSION}">'
    assert out.count("?") == 1


# ------------------------------------------------------------------ the real tree

def test_stamp_tree_copies_and_stamps_the_real_web_app(tmp_path):
    out_dir = tmp_path / "web-stamped"
    touched = stamp_assets.stamp_tree(WEB_DIR, out_dir, VERSION)

    assert (out_dir / "index.html").is_file()
    assert (out_dir / "vendor" / "exceljs.min.js").is_file()  # vendor file copied, untouched
    assert touched, "expected at least index.html and the js/ files to be looked at"

    index_html = (out_dir / "index.html").read_text(encoding="utf-8")
    assert f"js/app.js?v={VERSION}" in index_html
    assert f"vendor/main.css?v={VERSION}" in index_html
    assert f"css/app.css?v={VERSION}" in index_html
    assert f"vendor/exceljs.min.js?v={VERSION}" in index_html

    app_js = (out_dir / "js" / "app.js").read_text(encoding="utf-8")
    assert f'from "./csv.js?v={VERSION}"' in app_js
    assert f'import("./pipeline.js?v={VERSION}")' in app_js
    assert f'import("./report.js?v={VERSION}")' in app_js
    assert f'import("./suggest.js?v={VERSION}")' in app_js

    suggest_js = (out_dir / "js" / "suggest.js").read_text(encoding="utf-8")
    assert f'"../prompts/proposal.json?v={VERSION}"' in suggest_js

    xlsxio_js = (out_dir / "js" / "xlsxio.js").read_text(encoding="utf-8")
    assert 'import("node:module")' in xlsxio_js  # bare specifier untouched

    # The source tree itself must be untouched by this run.
    original_index = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    assert "?v=" not in original_index


def test_stamp_tree_is_idempotent_on_a_second_run(tmp_path):
    # Running twice into the same out_dir (a fresh commit re-deploying at the same sha, or a
    # local re-run while testing) must not pile up query strings.
    out_dir = tmp_path / "web-stamped"
    stamp_assets.stamp_tree(WEB_DIR, out_dir, VERSION)
    stamp_assets.stamp_tree(WEB_DIR, out_dir, VERSION)
    index_html = (out_dir / "index.html").read_text(encoding="utf-8")
    assert index_html.count(f"?v={VERSION}") == index_html.count("js/app.js") \
        + index_html.count("css/app.css") + index_html.count("vendor/main.css") \
        + index_html.count("vendor/exceljs.min.js")
    assert "&v=" not in index_html  # second run started from a clean copytree, not the stamped one


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not on PATH")
def test_stamped_js_files_still_pass_node_check(tmp_path):
    out_dir = tmp_path / "web-stamped"
    touched = stamp_assets.stamp_tree(WEB_DIR, out_dir, VERSION)
    js_files = [p for p in touched if p.suffix == ".js"]
    assert js_files, "expected js/*.js to have been stamped"
    for js_file in js_files:
        result = subprocess.run(
            ["node", "--check", str(js_file)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"{js_file}: {result.stderr}"
