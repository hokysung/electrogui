"""electro_gui config files: discovery, /api/configs, the JS hooks, and drift of deck configs from the page's state."""
import argparse
import http.client
import json
from pathlib import Path
import re
import tempfile
import threading
import unittest

from electro_gui.cli import add_arguments
from electro_gui.configs import MAX_BYTES, discover_configs
from session_viewer.store import SessionStore
from electro_gui.server import Application, make_server

from tests.fixtures import synthetic_session

ROOT = Path(__file__).resolve().parents[1]
EXPLORER_JS = ROOT / "electro_gui" / "static" / "explorer.js"
INDEX_HTML = ROOT / "electro_gui" / "static" / "index.html"


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value if isinstance(value, str) else json.dumps(value))
    return path


def config(title, **extra):
    return {"electro_gui_config": 1, "title": title, "state": {"align": "stimuli_on", "unit": 3}, **extra}


class DiscoverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.tmp = Path(self.temp.name)
        self.root = self.tmp / "configs"
        self.root.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def files(self, result):
        return [c["file"] for c in result["configs"]]

    def test_three_accepted_shapes(self):
        write(self.root / "touch.json", config("Target on by task", hint="unit 3", group="Slide 6 · example neurons", slide=6, note="from the deck"))
        write(self.root / "settings_export.json", {"tool": "electro_gui 0.2 explorer", "session_id": "s", "state": {"align": "fix_on", "unit": 5}})
        write(self.root / "bare.json", {"align": "reward", "unit": 4, "win": [-1, 1]})
        result = discover_configs([self.root])
        self.assertEqual(result["errors"], [])
        by_file = {c["file"]: c for c in result["configs"]}
        self.assertEqual(by_file["touch.json"], {
            "id": "touch.json", "file": "touch.json", "title": "Target on by task", "hint": "unit 3", "group": "Slide 6 · example neurons",
            "slide": 6, "note": "from the deck", "state": {"align": "stimuli_on", "unit": 3}})
        export = by_file["settings_export.json"]
        self.assertEqual((export["title"], export["hint"], export["group"], export["slide"]), ("settings_export", "electro_gui 0.2 explorer", "", None))
        self.assertEqual(export["state"], {"align": "fix_on", "unit": 5})
        bare = by_file["bare.json"]
        self.assertEqual((bare["title"], bare["state"]), ("bare", {"align": "reward", "unit": 4, "win": [-1, 1]}))
        # A config without a title falls back to the file name.
        write(self.root / "untitled.json", {"electro_gui_config": 1, "state": {"align": "x"}})
        self.assertEqual({c["file"]: c["title"] for c in discover_configs([self.root])["configs"]}["untitled.json"], "untitled")

    def test_bad_files_are_errors_not_fatal(self):
        write(self.root / "ok.json", config("Fine"))
        write(self.root / "malformed.json", '{"electro_gui_config": 1, "state": ')
        write(self.root / "nonobject_state.json", {"electro_gui_config": 1, "title": "x", "state": [1, 2]})
        write(self.root / "state_no_tool.json", {"state": {"align": "a"}})
        write(self.root / "version.json", {"electro_gui_config": 2, "state": {"align": "a"}})
        write(self.root / "bool_version.json", {"electro_gui_config": True, "state": {"align": "a"}})
        write(self.root / "nan.json", '{"electro_gui_config": 1, "state": {"bin": NaN}}')
        write(self.root / "list.json", "[1, 2, 3]")
        write(self.root / "unrelated.json", {"name": "package", "version": "1.0"})
        write(self.root / "bad_hint.json", config("t", hint=3))
        write(self.root / "bad_slide.json", config("t", slide=[6]))
        write(self.root / "empty.json", "")
        (self.root / "latin1.json").write_bytes(b"\xff\xfe not utf-8")
        result = discover_configs([self.root])
        self.assertEqual(self.files(result), ["ok.json"])
        errors = {e["file"]: e["error"] for e in result["errors"]}
        self.assertEqual(sorted(errors), sorted(["malformed.json", "nonobject_state.json", "state_no_tool.json", "version.json", "bool_version.json",
                                                 "nan.json", "list.json", "unrelated.json", "bad_hint.json", "bad_slide.json", "empty.json", "latin1.json"]))
        self.assertIn("invalid JSON", errors["malformed.json"])
        self.assertIn('"state" must be an object', errors["nonobject_state.json"])
        self.assertIn("GUI settings export", errors["state_no_tool.json"])
        self.assertIn("version", errors["version.json"])
        self.assertIn("NaN", errors["nan.json"])
        json.dumps(result, allow_nan=False)  # the whole listing must be serialisable for /api/configs

    def test_sidecars_dotfiles_and_size_limit(self):
        write(self.root / "._sidecar.json", config("AppleDouble sidecar"))
        write(self.root / ".hidden.json", config("Dotfile"))
        write(self.root / ".dotdeck" / "electro_gui_configs" / "z.json", config("In a dot directory"))
        write(self.root / "notes.txt", "not json")
        write(self.root / "directory.json" / "inside.json", config("Not scanned: two levels down, not under electro_gui_configs"))
        write(self.root / "big.json", config("Huge", note="x" * MAX_BYTES))
        write(self.root / "edge.json", config("Just under", note="y" * (MAX_BYTES - 200)))
        result = discover_configs([self.root])
        self.assertEqual(self.files(result), ["edge.json"])
        self.assertEqual([e["file"] for e in result["errors"]], ["big.json"])
        self.assertIn("256 KiB", result["errors"][0]["error"])

    def test_nested_deck_layout_and_direct_dir(self):
        write(self.root / "deck_a" / "electro_gui_configs" / "s1.json", config("A1", group="A", slide=1))
        write(self.root / "deck_a" / "electro_gui_configs" / "s2.json", config("A2", group="A", slide=2))
        write(self.root / "deck_a" / "notes" / "stray.json", config("not in electro_gui_configs"))
        write(self.root / "deck_a" / "slides.json", config("deck-level json, not in electro_gui_configs"))
        write(self.root / "top.json", config("Top level", group="A", slide=3))
        result = discover_configs([self.root])
        self.assertEqual(sorted(self.files(result)), ["deck_a/electro_gui_configs/s1.json", "deck_a/electro_gui_configs/s2.json", "top.json"])
        self.assertEqual({c["id"] for c in result["configs"]}, set(self.files(result)))
        # Pointing straight at one deck's directory lists it with short ids.
        direct = discover_configs([self.root / "deck_a" / "electro_gui_configs"])
        self.assertEqual(self.files(direct), ["s1.json", "s2.json"])
        self.assertEqual([c["id"] for c in direct["configs"]], ["s1.json", "s2.json"])

    def test_ordering_group_slide_title_with_loose_files_last(self):
        write(self.root / "z_loose.json", {"align": "a"})
        write(self.root / "b10.json", config("Ten", group="B deck", slide=10))
        write(self.root / "b2.json", config("Two", group="B deck", slide=2))
        write(self.root / "b_str.json", config("Appendix", group="B deck", slide="A1"))
        write(self.root / "b_none.json", config("Unnumbered", group="B deck"))
        write(self.root / "a_tie_z.json", config("Zebra", group="a deck", slide=1))
        write(self.root / "a_tie_a.json", config("apple", group="a deck", slide=1))
        result = discover_configs([self.root])
        self.assertEqual([c["title"] for c in result["configs"]], ["apple", "Zebra", "Two", "Ten", "Appendix", "Unnumbered", "z_loose"])

    def test_missing_dirs_are_empty_and_symlinks_cannot_escape(self):
        outside = write(self.tmp / "outside" / "secret.json", config("Outside the config dir"))
        write(self.root / "ok.json", config("Fine"))
        (self.root / "link.json").symlink_to(outside)
        (self.root / "deck").mkdir()
        (self.root / "deck" / "electro_gui_configs").symlink_to(outside.parent, target_is_directory=True)
        result = discover_configs([self.tmp / "no_such_dir", self.root])
        self.assertEqual(self.files(result), ["ok.json"])
        self.assertEqual([e["file"] for e in result["errors"]], ["deck/electro_gui_configs/secret.json", "link.json"])
        self.assertTrue(all("outside" in e["error"] for e in result["errors"]))
        self.assertEqual(discover_configs([]), {"configs": [], "errors": []})
        self.assertEqual(discover_configs([self.tmp / "nope"]), {"configs": [], "errors": []})


class ConfigServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.tmp = Path(self.temp.name)
        self.path, _, _ = synthetic_session(self.tmp)
        self.cfgs = self.tmp / "presentation"
        write(self.cfgs / "deck" / "electro_gui_configs" / "one.json", config("One", group="Slide 6 · example neurons", slide=6, hint="first"))
        write(self.cfgs / "deck" / "electro_gui_configs" / "broken.json", "{")
        store = SessionStore([], [self.path], self.tmp / "cache")
        self.app = Application(store, config_dirs=[self.cfgs])
        self.server = make_server(self.app, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.app.close()
        self.thread.join()
        self.temp.cleanup()

    def get(self, path, method="GET", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=30)
        connection.request(method, path, body=json.dumps(body) if body is not None else None,
                           headers={"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        data = response.read()
        status = response.status
        connection.close()
        return status, data

    def test_lists_configs_and_errors_and_rescans_every_request(self):
        status, data = self.get("/api/configs")
        self.assertEqual(status, 200)
        listing = json.loads(data)
        self.assertEqual([c["id"] for c in listing["configs"]], ["deck/electro_gui_configs/one.json"])
        self.assertEqual(listing["configs"][0]["title"], "One")
        self.assertEqual(listing["configs"][0]["state"], {"align": "stimuli_on", "unit": 3})
        self.assertEqual([e["file"] for e in listing["errors"]], ["deck/electro_gui_configs/broken.json"])
        # Edited and new files show up without a restart.
        write(self.cfgs / "deck" / "electro_gui_configs" / "one.json", config("One, renamed"))
        write(self.cfgs / "deck" / "electro_gui_configs" / "two.json", config("Two", slide=2, group="G"))
        listing = json.loads(self.get("/api/configs")[1])
        self.assertEqual(sorted(c["title"] for c in listing["configs"]), ["One, renamed", "Two"])

    def test_read_only_and_local_only(self):
        self.assertEqual(self.get("/api/configs", headers={"Host": "attacker.test"})[0], 403)
        self.assertEqual(self.get("/api/configs", headers={"Origin": "https://attacker.test"})[0], 403)
        self.assertEqual(self.get("/api/configs", "POST", {"title": "x"})[0], 404)   # listing only: no write route
        self.assertEqual(self.get("/api/configs/one")[0], 404)

    def test_application_default_has_no_config_dirs(self):
        app = Application(SessionStore([], [self.path], self.tmp / "cache2"))
        try:
            self.assertEqual(app.config_dirs, [])
            self.assertEqual(app.configs(), {"configs": [], "errors": []})
        finally:
            app.close()

    def test_cli_flag_is_repeatable_and_defaults_to_none(self):
        parser = add_arguments(argparse.ArgumentParser())
        self.assertIsNone(parser.parse_args([]).config_dir)
        self.assertEqual(parser.parse_args(["--config-dir", "a", "--config-dir", "b/c"]).config_dir, ["a", "b/c"])


# ---- drift guard: config states and templates against the page's own state object ----------------

def js_defaults():
    """The ``DEFAULTS`` object literal of explorer.js as a Python dict."""
    source = EXPLORER_JS.read_text()
    match = re.search(r"const DEFAULTS = \{(.*?)\n  \};", source, re.S)
    assert match, "explorer.js no longer has a `const DEFAULTS = {...};` block"
    body = re.sub(r"'([^']*)'", lambda m: json.dumps(m.group(1)), match.group(1))            # single -> double quoted strings
    body = re.sub(r'("(?:[^"\\]|\\.)*")|([A-Za-z_]\w*)(?=\s*:)', lambda m: m.group(1) or json.dumps(m.group(2)), body)  # quote bare keys
    return json.loads("{" + re.sub(r",\s*$", "", body.strip()) + "}")


# Keys whose default is null: the type a config may give them.  color and style default to a field but null means "none".
NULLABLE = {"session": str, "unit": int, "panel": str, "ylock": (int, float), "heatGroup": str, "pin": dict}
ALSO_NULL = {"color", "style"}


def state_problems(state, defaults):
    """Everything about a config ``state`` that would be silently dropped or reset by the page."""
    problems = [f"unknown state key {k!r}" for k in state if k not in defaults]

    def kind(value):
        return "number" if isinstance(value, (int, float)) and not isinstance(value, bool) else type(value).__name__
    for key, value in state.items():
        if key not in defaults:
            continue
        default = defaults[key]
        if value is None and (default is None or key in ALSO_NULL):
            continue
        if default is None:
            ok = isinstance(value, NULLABLE[key]) and not isinstance(value, bool)
            expected = NULLABLE[key].__name__ if isinstance(NULLABLE[key], type) else "number"
        elif isinstance(default, bool):
            ok, expected = isinstance(value, bool), "bool"
        elif isinstance(default, (int, float)):
            ok, expected = kind(value) == "number", "number"
        else:
            ok, expected = isinstance(value, type(default)), type(default).__name__
        if not ok:
            problems.append(f"state.{key} is {kind(value)}, expected {expected}")
    for key in ("win", "cw"):
        pair = state.get(key)
        if pair is not None and not (isinstance(pair, list) and len(pair) == 2 and all(kind(x) == "number" for x in pair) and pair[0] < pair[1]):
            problems.append(f"state.{key} must be [lo, hi] with lo < hi")
    if "align" in state and not (isinstance(state["align"], str) and state["align"]):
        problems.append("state.align must be a non-empty string")
    for f in state.get("filters", []) if isinstance(state.get("filters"), list) else []:
        if not (isinstance(f, dict) and isinstance(f.get("k"), str) and isinstance(f.get("v"), list)):
            problems.append(f"filter {f!r} needs a field 'k' and a list 'v'")
    for m in state.get("markers", []) if isinstance(state.get("markers"), list) else []:
        if not (isinstance(m, dict) and isinstance(m.get("e"), str)):
            problems.append(f"marker {m!r} needs an event name 'e'")
    return problems


class ConfigDriftTests(unittest.TestCase):
    def test_templates_use_oculomotor_events_and_known_state_keys(self):
        source = EXPLORER_JS.read_text()
        block = source[source.index("const TEMPLATES = ["):source.index("const D = {")]
        aligns = re.findall(r"align: '([a-z_]+)'", block)
        self.assertEqual(aligns, ["stimuli_on", "stim_train", "reward", "fix_on", "pursuit_start"])
        self.assertEqual(re.findall(r"color: '([a-z_]+)'", block), ["task", "microstim", "task", "rewarded", "task"])
        self.assertNotRegex(block, r"unit:\s*\d")   # templates keep the current unit
        defaults = js_defaults()
        keys = set(re.findall(r"\b([a-z][A-Za-z]*):", block)) - {"name", "hint", "state", "e", "match", "occ", "label", "c", "k", "v", "id"}
        self.assertEqual(keys - set(defaults), set())

    def test_guard_reads_the_real_defaults_and_flags_drift(self):
        defaults = js_defaults()
        self.assertTrue({"session", "unit", "align", "policy", "win", "cw", "filters", "markers", "gstyle", "mode", "roster", "pin", "nsort"} <= set(defaults))
        self.assertEqual(defaults["nsort"], "loading:0")
        self.assertEqual(defaults["align"], "fix_on")
        self.assertEqual((defaults["color"], defaults["style"]), ("task", None))
        self.assertEqual(defaults["tdrFactors"], ["task", "microstim"])
        self.assertNotIn("worldCoding", defaults)
        self.assertIs(defaults["bt"], True)
        good = {"session": "s", "unit": 3, "align": "stimuli_on", "win": [-1, 1.5], "cw": [0.05, 0.25], "bin": 0.02, "sigma": 0,
                "filters": [{"k": "task", "v": ["pursuit"]}], "markers": [{"e": "fix_on"}], "color": "microstim", "style": None, "panel": None, "pin": None}
        self.assertEqual(state_problems(good, defaults), [])
        for bad, needle in (({"alignn": "x"}, "unknown state key"), ({"win": "wide"}, "state.win"), ({"win": [1, -1]}, "state.win"),
                            ({"unit": "893"}, "state.unit"), ({"filters": {"k": "a"}}, "state.filters"), ({"filters": [{"k": "a"}]}, "filter"),
                            ({"markers": [{"label": "no event"}]}, "marker"), ({"bars": "yes"}, "state.bars"), ({"bin": True}, "state.bin")):
            self.assertTrue(any(needle in p for p in state_problems(bad, defaults)), (bad, needle))


class ConfigHooksInPageTests(unittest.TestCase):
    def test_explorer_js_and_html_keep_the_config_menu_hooks(self):
        js, html = EXPLORER_JS.read_text(), INDEX_HTML.read_text()
        for needle in ("/api/configs", "Config files", "data-cfg", "data-openconfig", "Open config file", "readConfigObject",
                       "applyConfig", "openConfigFile", "electro_gui_config", "`Config: ${title}`", "$('cfgFile')", "configsHtml(cfg)"):
            self.assertIn(needle, js, needle)
        self.assertIn('id="cfgFile"', html)
        self.assertRegex(html, r'<input type="file" id="cfgFile" accept="\.json,application/json" hidden')
        # The section sits between Templates and Findings, and applying goes through sanitize() via applyView.
        self.assertLess(js.index("Templates · keep the current unit"), js.index("configsHtml(cfg) +"))
        self.assertLess(js.index("configsHtml(cfg) +"), js.index("Findings · reopen and check the numbers"))
        self.assertRegex(js, r"await applyView\(\{state\}\)")

    def test_opening_a_config_file_says_so_before_the_file_is_read(self):
        # Reading the file, verifying a session and fetching a raster are the slow steps; the loading card must be up
        # before the first await, and a config that is not applied must put the figure back.
        js = EXPLORER_JS.read_text()
        body = js[js.index("async function openConfigFile(file)"):js.index("function summarizeState")]
        self.assertLess(body.index("Reading the file…"), body.index("await file.text()"))
        self.assertIn("if (covered && !applied) schedule();", body)
        apply_body = js[js.index("async function applyConfig("):js.index("async function openConfigFile(file)")]
        self.assertIn("Applying the saved settings…", apply_body)
        self.assertLess(apply_body.index("Applying the saved settings…"), apply_body.index("await applyView({state})"))
        self.assertIn("return false; }", apply_body)


if __name__ == "__main__":
    unittest.main()
