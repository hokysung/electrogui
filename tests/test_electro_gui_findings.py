"""electro_gui findings: the store, its HTTP routes, the page's evidence comparison, and the page hooks."""
import base64
import http.client
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import threading
import unittest
from unittest import mock
import zlib

from electro_gui import __version__, server as server_module
from electro_gui.configs import discover_configs, parse_config
from session_viewer.store import SessionStore
from electro_gui.findings import FindingStore
from electro_gui.server import Application, make_server

from tests.fixtures import SUA, synthetic_session

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "electro_gui" / "static"
CORE_JS = STATIC / "core.js"
SID = "sub-Test_ses-2026_01_01"


def tiny_png(width=2, height=1):
    """A valid RGB PNG, written by hand so the tests need no imaging library."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    rows = b"".join(b"\x00" + b"\xff\x00\x00" * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def data_url(raw):
    return "data:image/png;base64," + base64.b64encode(raw).decode()


def evidence(**extra):
    return {"schema": 1, "mode": "raster", "session_id": SID, "source": {"sha256": "ab" * 32, "size_bytes": 1234},
            "unit": {"id": 315, "peak_channel": 28, "area": "ACC", "quality": "sua", "n_spikes": 4321},
            "support": {"events": 224, "trials": 120},
            "groups": [{"label": "sham", "panel": None, "events": 112, "trials": 60, "rate_hz": 16.9, "rate_sem_hz": 0.8, "n": 112},
                       {"label": "stim", "panel": None, "events": 112, "trials": 60, "rate_hz": 21.8, "rate_sem_hz": 0.9, "n": 112}],
            **extra}


def payload(**extra):
    return {"title": "Unit 315 fires more after target onset in pursuit trials", "note": "eye position not controlled here",
            "tags": ["task", "eye"], "status": "checking",
            "state": {"session": SID, "unit": 315, "align": "stimuli_on", "win": [-1, 1.5], "cw": [0.05, 0.25]},
            "evidence": evidence(), "thumbnail": data_url(tiny_png()), **extra}


class FindingStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "findings"
        self.store = FindingStore(self.root)

    def files(self):
        return sorted(p.name for p in self.root.iterdir()) if self.root.exists() else []

    def test_a_finding_is_a_config_file_with_its_picture_beside_it(self):
        saved = self.store.create(payload(), saved_on="imac", code={"electro_gui": "0.2", "commit": "abc", "dirty": False})
        fid = saved["id"]
        self.assertRegex(fid, r"^\d{8}T\d{6}Z-[0-9a-f]{6}$")
        self.assertEqual(self.files(), [f"{fid}.json", f"{fid}.png"])
        self.assertEqual(self.store.thumbnail(fid), tiny_png())
        on_disk = json.loads((self.root / f"{fid}.json").read_text())
        self.assertEqual((on_disk["electro_gui_config"], on_disk["finding"], on_disk["status"], on_disk["tags"], on_disk["saved_on"]),
                         (1, 1, "checking", ["task", "eye"], "imac"))
        self.assertEqual(on_disk["state"], payload()["state"])
        self.assertEqual(on_disk["evidence"], evidence())
        self.assertNotIn("has_thumbnail", on_disk)
        self.assertTrue(saved["has_thumbnail"])
        # Copied into a deck it is a slide config as it stands.
        entry = parse_config(on_disk, fid)
        self.assertEqual((entry["title"], entry["note"], entry["state"]), (saved["title"], saved["note"], saved["state"]))
        listed = discover_configs([self.root])
        self.assertEqual([c["title"] for c in listed["configs"]], [saved["title"]])

    def test_findings_survive_a_new_store_and_list_newest_first(self):
        first = self.store.create(payload(title="first"))
        (self.root / f"{first['id']}.json").write_text(
            (self.root / f"{first['id']}.json").read_text().replace(first["saved_at"], "2026-01-01T00:00:00Z"))
        second = self.store.create(payload(title="second", thumbnail=None))
        listed = FindingStore(self.root).list()
        self.assertEqual([f["title"] for f in listed["findings"]], ["second", "first"])
        self.assertEqual([f["has_thumbnail"] for f in listed["findings"]], [False, True])
        self.assertEqual((listed["errors"], listed["folder"]), ([], str(self.root)))
        self.assertIsNone(second["thumbnail"])

    def test_only_title_note_tags_and_status_can_change(self):
        fid = self.store.create(payload())["id"]
        before = json.loads((self.root / f"{fid}.json").read_text())
        changed = self.store.update(fid, {"note": "  the eye-only model still leaves a pursuit effect  ", "tags": "task, pursuit stim,  task ",
                                          "status": "supported"}, updated_on="macmini")
        self.assertEqual((changed["note"], changed["tags"], changed["status"], changed["updated_on"]),
                         ("the eye-only model still leaves a pursuit effect", ["task", "pursuit stim"], "supported", "macmini"))
        self.assertTrue(changed["updated_at"])
        self.assertEqual((changed["state"], changed["evidence"], changed["saved_at"]), (before["state"], before["evidence"], before["saved_at"]))
        for frozen in ({"state": {"session": SID, "unit": 1}}, {"evidence": {}}, {"note": "x", "saved_at": "now"}):
            with self.subTest(frozen=frozen), self.assertRaisesRegex(ValueError, "stay as saved"):
                self.store.update(fid, frozen)
        self.assertEqual(self.store.get(fid)["note"], changed["note"])  # a refused edit changes nothing
        with self.assertRaisesRegex(ValueError, "Status"):
            self.store.update(fid, {"status": "proven"})

    def test_a_bad_request_writes_nothing(self):
        cases = {"no title": payload(title="  "), "long title": payload(title="x" * 201), "status": payload(status="true"),
                 "tags": payload(tags=[1, 2]), "long tag": payload(tags=["a" * 41]), "comma tag": payload(tags=["a,b"]), "no session": payload(state={"unit": 1}),
                 "other session": payload(evidence=evidence(session_id="sub-Other_ses-2026_01_02")),
                 "no evidence": payload(evidence=None), "not png": payload(thumbnail="data:image/png;base64," + base64.b64encode(b"GIF89a").decode()),
                 "not base64": payload(thumbnail="data:image/png;base64,***"), "jpeg url": payload(thumbnail="data:image/jpeg;base64,AAAA"),
                 "too big": payload(evidence=evidence(blob="x" * 300_000))}
        for name, bad in cases.items():
            with self.subTest(name), self.assertRaises(ValueError):
                self.store.create(bad)
        self.assertEqual(self.files(), [])

    def test_ids_cannot_reach_outside_the_folder(self):
        self.store.create(payload())
        for bad in ("../findings", "x/../../etc", "20261008T000000Z-zzzzzz", "", None):
            with self.subTest(bad=bad), self.assertRaises(KeyError):
                self.store.get(bad)
        with self.assertRaises(KeyError):
            self.store.thumbnail("20261008T000000Z-000000")

    def test_a_findings_file_is_where_the_store_wrote_it(self):
        fid = self.store.create(payload())["id"]
        self.assertEqual(self.store.file(fid), self.root / f"{fid}.json")
        for bad in ("../findings", "20261008T000000Z-000000", None):
            with self.subTest(bad=bad), self.assertRaises(KeyError):
                self.store.file(bad)

    def test_delete_moves_the_files_aside(self):
        fid = self.store.create(payload())["id"]
        self.assertEqual(self.store.delete(fid), {"deleted": fid})
        self.assertEqual(self.store.list()["findings"], [])
        self.assertEqual(sorted(p.name for p in (self.root / ".deleted").iterdir()), [f"{fid}.json", f"{fid}.png"])
        with self.assertRaises(KeyError):
            self.store.delete(fid)

    def test_unreadable_files_are_listed_not_fatal(self):
        good = self.store.create(payload())
        (self.root / "broken.json").write_text("{not json")
        (self.root / "deck_config.json").write_text(json.dumps({"electro_gui_config": 1, "state": {"unit": 1}}))
        (self.root / f"._{good['id']}.json").write_bytes(b"\x00\x05\x16\x07")   # a macOS AppleDouble sidecar
        listed = self.store.list()
        self.assertEqual([f["id"] for f in listed["findings"]], [good["id"]])
        self.assertEqual(sorted(e["file"] for e in listed["errors"]), ["broken.json", "deck_config.json"])

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root ignores directory permissions")
    def test_a_folder_that_cannot_be_written_raises_and_leaves_nothing(self):
        self.root.mkdir()
        self.root.chmod(0o555)
        self.addCleanup(self.root.chmod, 0o755)
        with self.assertRaises(PermissionError):
            self.store.create(payload())
        self.assertEqual(self.files(), [])


class FindingRoutesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        path, self.sid, _ = synthetic_session(self.temp.name)
        self.root = Path(self.temp.name) / "findings"
        self.app = Application(SessionStore([], [path], Path(self.temp.name) / "cache"), findings_dir=self.root)
        self.addCleanup(self.app.close)

    def serve(self, app=None, **kwargs):
        server = make_server(app or self.app, port=0, **kwargs)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def request(self, port, path, method="GET", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
        connection.request(method, path, body=json.dumps(body) if body is not None else None,
                           headers={"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        result = response.status, response.getheader("Content-Type"), response.read()
        connection.close()
        return result

    def body(self, **extra):
        state = {"session": self.sid, "unit": SUA, "align": "stimuli_on"}
        return payload(state=state, evidence=evidence(session_id=self.sid), **extra)

    def test_save_list_edit_picture_and_delete(self):
        port = self.serve()
        # A picture well over the 256 KiB other POST routes accept.
        picture = b"\x89PNG\r\n\x1a\n" + os.urandom(600_000)
        status, _, raw = self.request(port, "/api/findings", "POST", self.body(thumbnail=data_url(picture)))
        self.assertEqual(status, 201, raw)
        saved = json.loads(raw)
        fid = saved["id"]
        self.assertEqual(saved["code"]["electro_gui"], __version__)
        self.assertIn("commit", saved["code"])
        status, _, raw = self.request(port, "/api/findings")
        self.assertEqual((status, [f["id"] for f in json.loads(raw)["findings"]]), (200, [fid]))
        status, kind, raw = self.request(port, f"/api/findings/{fid}/thumbnail")
        self.assertEqual((status, kind, raw), (200, "image/png", picture))
        status, _, raw = self.request(port, f"/api/findings/{fid}", "POST", {"note": "next: eye-only model", "status": "supported"})
        self.assertEqual(status, 200, raw)
        self.assertEqual(json.loads(self.request(port, f"/api/findings/{fid}")[2])["status"], "supported")
        status, _, raw = self.request(port, f"/api/findings/{fid}", "POST", {"state": {"session": self.sid, "unit": 2}})
        self.assertEqual(status, 400)
        self.assertIn("stay as saved", json.loads(raw)["error"])
        self.assertEqual(self.request(port, "/api/findings/../../pyproject.toml")[0], 404)
        self.assertEqual(self.request(port, "/api/findings/20261008T000000Z-000000/thumbnail")[0], 404)
        self.assertEqual(self.request(port, f"/api/findings/{fid}/other")[0], 404)
        status, _, raw = self.request(port, f"/api/findings/{fid}", "POST", {"delete": True})
        self.assertEqual((status, json.loads(raw)), (200, {"deleted": fid}))
        self.assertEqual(self.request(port, f"/api/findings/{fid}")[0], 404)

    def test_a_saved_finding_says_where_its_file_is_and_whether_finder_can_show_it(self):
        port = self.serve()
        lan = self.serve(token="s3cret")
        with mock.patch.object(server_module, "REVEALS", True):
            status, _, raw = self.request(port, "/api/findings", "POST", self.body())
            self.assertEqual(status, 201, raw)
            saved = json.loads(raw)
            path = self.root / f"{saved['id']}.json"
            self.assertEqual(saved["path"], str(path))
            self.assertIs(saved["can_reveal"], True)   # opened at localhost, on a Mac
            on_disk = json.loads(path.read_text())
            self.assertNotIn("path", on_disk)          # shown to the page, never written into the file
            self.assertNotIn("can_reveal", on_disk)
            # The same save from a page whose browser may be on another device (a LAN address, a tailnet name).
            via = {"Host": "node.local:8778", "Cookie": "electro_token=s3cret"}
            saved = json.loads(self.request(lan, "/api/findings", "POST", self.body(), headers=via)[2])
            self.assertEqual(saved["path"], str(self.root / f"{saved['id']}.json"))
            self.assertIs(saved["can_reveal"], False)
        with mock.patch.object(server_module, "REVEALS", False):   # no Finder off a Mac
            self.assertIs(json.loads(self.request(port, "/api/findings", "POST", self.body())[2])["can_reveal"], False)

    def test_show_in_finder_is_for_a_page_open_at_localhost_on_a_mac(self):
        fid = self.app.save_finding(self.body())["id"]
        path = self.root / f"{fid}.json"
        port, lan = self.serve(), self.serve(token="s3cret")
        route = f"/api/findings/{fid}/reveal"
        opened = mock.Mock()
        with mock.patch.object(server_module, "_reveal_in_finder", opened), mock.patch.object(server_module, "REVEALS", True):
            status, _, raw = self.request(port, route, "POST", {})
            self.assertEqual((status, json.loads(raw)), (200, {"revealed": str(path)}))
            opened.assert_called_once_with(path)
            for missing in ("20261008T000000Z-000000", "..%2F..%2Fpyproject"):   # no such finding; an id that is a path
                with self.subTest(missing=missing):
                    self.assertEqual(self.request(port, f"/api/findings/{missing}/reveal", "POST", {})[0], 404)
            self.assertEqual(self.request(port, route)[0], 404)   # only a POST acts
            via = {"Host": "node.local:8778", "Cookie": "electro_token=s3cret"}
            status, _, raw = self.request(lan, route, "POST", {}, headers=via)
            self.assertEqual(status, 400)
            self.assertIn("localhost", json.loads(raw)["error"])
            self.assertEqual(self.request(lan, route, "POST", {})[0], 403)   # and still needs the token
            opened.assert_called_once()   # none of those opened a Finder window
        with mock.patch.object(server_module, "REVEALS", False):
            status, _, raw = self.request(port, route, "POST", {})
            self.assertEqual((status, "Mac" in json.loads(raw)["error"]), (400, True))

    def test_open_r_selects_the_file_and_a_failure_says_so(self):
        target = self.root / "20261008T000000Z-000000.json"
        with mock.patch.object(server_module.subprocess, "run") as run:
            server_module._reveal_in_finder(target)
        self.assertEqual(run.call_args.args[0], ["open", "-R", str(target)])
        for failure in (subprocess.CalledProcessError(1, "open"), FileNotFoundError("open")):
            with self.subTest(failure=type(failure).__name__), \
                    mock.patch.object(server_module.subprocess, "run", side_effect=failure), \
                    self.assertRaisesRegex(ValueError, "Could not show the file in Finder"):
                server_module._reveal_in_finder(target)

    def test_a_refused_save_says_why(self):
        port = self.serve()
        status, _, raw = self.request(port, "/api/findings", "POST", self.body(title=""))
        self.assertEqual((status, json.loads(raw)["error"]), (400, "A finding needs a title."))
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            return
        self.root.mkdir()
        self.root.chmod(0o555)
        self.addCleanup(self.root.chmod, 0o755)
        status, _, raw = self.request(port, "/api/findings", "POST", self.body())
        self.assertEqual(status, 500, raw)
        message = json.loads(raw)["error"]
        self.assertIn("Could not write to the findings folder", message)
        self.assertTrue(message.endswith(f"({self.root})"), message)   # the folder, not a temporary file
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), [])

    def test_findings_keep_the_servers_access_rules(self):
        fid = self.app.save_finding(self.body())["id"]
        port = self.serve(token="s3cret")
        for path, method in (("/api/findings", "GET"), (f"/api/findings/{fid}", "GET"), (f"/api/findings/{fid}/thumbnail", "GET"),
                             ("/api/findings", "POST"), (f"/api/findings/{fid}", "POST")):
            with self.subTest(path=path, method=method):
                self.assertEqual(self.request(port, path, method, {} if method == "POST" else None)[0], 403)
        status, kind, _ = self.request(port, f"/api/findings/{fid}/thumbnail", headers={"Cookie": "electro_token=s3cret"})
        self.assertEqual((status, kind), (200, "image/png"))
        self.assertEqual(self.request(port, "/api/findings", headers={"Host": "attacker.test", "Cookie": "electro_token=s3cret"})[0], 200)
        open_port = self.serve(Application(self.app.store, findings_dir=self.root))
        self.assertEqual(self.request(open_port, "/api/findings", headers={"Host": "attacker.test"})[0], 403)

    def test_a_server_without_a_findings_folder_says_so(self):
        port = self.serve(Application(self.app.store))
        status, _, raw = self.request(port, "/api/findings")
        self.assertEqual(status, 400)
        self.assertIn("--findings-dir", json.loads(raw)["error"])

    def test_the_findings_page_is_served(self):
        port = self.serve()
        status, kind, raw = self.request(port, "/findings/")
        self.assertEqual((status, kind), (200, "text/html"))
        for needle in (b"/findings/findings.js", b"/core.js", b"/explorer.css"):
            self.assertIn(needle, raw)
        self.assertEqual(self.request(port, "/findings/findings.js")[0], 200)


# ---- the page's comparison of a reopened finding (core.js), in node or macOS's JavaScriptCore shell -------------

JSC = Path("/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc")


def js_engine():
    """node when it is installed, else the JavaScriptCore shell every Mac has; None skips the JS cases."""
    node = shutil.which("node")
    return [node] if node else [str(JSC)] if JSC.is_file() else None


def run_core(script, data):
    """Run ``script`` with ``C`` = core.js's API and ``input`` = data; the script ends by calling ``out(value)``."""
    program = ("const root = {};\n(function (self, module) {\n" + CORE_JS.read_text() + "\n})(root, undefined);\n"
               "const C = root.EGCore;\n"
               "const out = v => (typeof console !== 'undefined' ? console.log : print)(JSON.stringify(v));\n"
               f"const input = {json.dumps(data)};\n{script}\n")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "case.js"
        path.write_text(program)
        done = subprocess.run([*js_engine(), str(path)], capture_output=True, text=True, timeout=60)
    if done.returncode:
        raise AssertionError(done.stderr or done.stdout)
    return json.loads(done.stdout.strip().splitlines()[-1])


def pop_evidence(**extra):
    roster = [{"id": i, "peak_channel": 10 + i, "area": "ACC", "quality": "sua", "n_spikes": 1000 + i} for i in (1, 2, 3, 4)]
    return {"schema": 1, "mode": "population", "session_id": SID, "source": {"sha256": "ab" * 32, "size_bytes": 1234}, "roster": roster,
            "support": {"events": 300, "trials": 150, "neurons": 4, "common_trials": 140},
            "groups": [{"label": "sham", "panel": None, "events": 150, "trials": 75}, {"label": "stim", "panel": None, "events": 150, "trials": 75}],
            "fit": {"method": "pca", "components": 3, "rank": 3, "dropped_constant_units": [], "converged": True, "warnings": [],
                    "explained_variance_ratio": [0.41, 0.22, 0.1], "component_r2": [0.41, 0.22, 0.1]}, **extra}


@unittest.skipUnless(js_engine(), "no JavaScript engine (node or jsc)")
class CompareEvidenceTests(unittest.TestCase):
    def compare(self, saved, now):
        return run_core("out(C.compareEvidence(input[0], input[1]));", [saved, now])

    def test_the_same_data_gives_no_differences(self):
        self.assertEqual(self.compare(evidence(), evidence()), [])
        self.assertEqual(self.compare(pop_evidence(), pop_evidence()), [])
        tiny = evidence(groups=[{**evidence()["groups"][0], "rate_hz": 16.9004}, evidence()["groups"][1]])   # below display precision
        self.assertEqual(self.compare(evidence(), tiny), [])

    def test_a_rebuilt_session_file_and_a_renumbered_unit_are_named_first(self):
        now = evidence(source={"sha256": "cd" * 32, "size_bytes": 1234},
                       unit={"id": 315, "peak_channel": 30, "area": "ACC", "quality": "mua", "n_spikes": 4100})
        diff = self.compare(evidence(), now)
        self.assertIn("is not the file it was saved from", diff[0])
        self.assertEqual(diff[1], "Unit 315 is not the neuron it was saved for: peak channel 28 → 30, quality sua → mua, 4321 → 4100 spikes.")
        self.assertEqual(self.compare(evidence(), evidence(unit={**evidence()["unit"], "id": 1})),
                         ["It was saved for unit 315; the figure shows unit 1."])
        self.assertEqual(self.compare(evidence(), evidence(session_id="sub-Other_ses-2026_01_02"))[0],
                         f"It was saved from session {SID}; the figure shows sub-Other_ses-2026_01_02.")

    def test_changed_support_counts_and_rates_are_listed_per_group(self):
        sham, stim = evidence()["groups"]
        now = evidence(support={"events": 221, "trials": 119},
                       groups=[sham, {**stim, "events": 109, "trials": 59, "rate_hz": 21.2}, {"label": "no train", "panel": None, "events": 5, "trials": 5}])
        self.assertEqual(self.compare(evidence(), now), [
            "Support changed: events 224 → 221; trials 120 → 119.",
            "“stim”: 112 → 109 events, 60 → 59 trials, 21.80 → 21.20 spikes/s in the count window.",
            "Groups that were not in the saved figure: “no train”."])
        self.assertEqual(self.compare(evidence(), evidence(groups=[sham])), ["Group “stim” is not in the redrawn figure."])
        panelled = [{**sham, "panel": "memory_saccade"}, {**sham, "panel": "pursuit", "events": 3}]
        self.assertEqual(self.compare(evidence(groups=panelled), evidence(groups=[panelled[0], {**panelled[1], "events": 4}])),
                         ["“sham · pursuit”: 3 → 4 events."])

    def test_population_neurons_and_fit_changes(self):
        saved = pop_evidence()
        roster = [dict(r) for r in saved["roster"][:3]] + [{"id": 9, "peak_channel": 40, "area": "ACC", "quality": "sua", "n_spikes": 5}]
        roster[1]["peak_channel"] = 99
        fit = {**saved["fit"], "dropped_constant_units": [3], "converged": False, "warnings": ["FastICA did not converge"],
               "explained_variance_ratio": [0.38, 0.22, 0.1], "component_r2": [0.41, 0.22, 0.1]}
        diff = self.compare(saved, pop_evidence(roster=roster, fit=fit, support={**saved["support"], "common_trials": 120}))
        self.assertEqual(diff, [
            "Neurons in the saved population but not now: 4.",
            "Neurons in the population now but not when saved: 9.",
            "Neurons that are not the ones saved: 2 (peak channel 12 → 99).",
            "Support changed: trials shared by every neuron 140 → 120.",
            "Neurons left out of the fit as constant: none → 3.",
            "The fit no longer converges.",
            "New fit warnings: FastICA did not converge.",
            "Variance explained changed: component 1 41.0% → 38.0%."])


@unittest.skipUnless(js_engine(), "no JavaScript engine (node or jsc)")
class RestoreAndSearchTests(unittest.TestCase):
    def test_state_changes_ignore_key_order_and_name_what_the_page_replaced(self):
        saved = {"session": SID, "unit": 893, "align": "stimuli_on", "markers": [{"id": "m1", "e": "fix_on", "match": "trial"}],
                 "gstyle": {"a": {"c": "#fff", "d": 1}}, "retired_knob": 3}
        same = {"session": SID, "unit": 893, "align": "stimuli_on", "markers": [{"match": "trial", "e": "fix_on", "id": "m1"}],
                "gstyle": {"a": {"d": 1, "c": "#fff"}}, "retired_knob": 3}
        self.assertEqual(run_core("out(C.stateChanges(input[0], input[1]));", [saved, same]), [])
        replaced = {**same, "unit": 1, "align": "reward", "markers": []}
        del replaced["retired_knob"]
        changes = run_core("out(C.stateChanges(input[0], input[1]));", [saved, replaced])
        self.assertEqual([c["key"] for c in changes], ["unit", "align", "markers", "retired_knob"])
        self.assertEqual((changes[0]["saved"], changes[0]["now"]), (893, 1))
        self.assertNotIn("now", changes[3])   # gone from the applied state: the page does not know the key

    def test_search_needs_every_word_somewhere_in_the_finding(self):
        finding = {**payload(), "id": "x", "saved_on": "imac", "saved_at": "2026-10-08T20:00:00Z"}
        cases = {"": True, "pursuit target": True, "eye": True, "unit 315": True, "ch 28": True, "acc": True, "2026_01_01": True,
                 "stimuli on": True, "imac": True, "checking": True, "supported": False, "unit 893": False, "pursuit reward": False}
        got = run_core("out(input[1].map(q => C.findingMatches(input[0], q)));", [finding, list(cases)])
        self.assertEqual(dict(zip(cases, got)), cases)


class FindingHooksInPageTests(unittest.TestCase):
    def test_explorer_saves_and_reopens_findings_through_one_measurement(self):
        js, html = (STATIC / "explorer.js").read_text(), (STATIC / "index.html").read_text()
        for needle in ("/api/findings", "function figureReady()", "function evidence()", "async function captureFinding()",
                       "C.compareEvidence(o.finding.evidence, evidence())", "C.stateChanges(o.finding.state, S)",
                       "fitStateToSession(summary);", "openFindingLink", "data-savefinding", "Your text is kept.",
                       "Findings · reopen and check the numbers", "function showSavedFinding(saved)", "saved.can_reveal",
                       "/reveal`", "id=\"fCopy\">Copy path", "Show in Finder"):
            self.assertIn(needle, js, needle)
        # Once saved, the dialog stays open to show the file instead of closing on a toast.
        submit = js[js.index("form.addEventListener('submit'"):js.index("async function copyText(")]
        self.assertIn("showSavedFinding(saved)", submit)
        self.assertNotIn("closePop()", submit)
        for gone in ("/api/views", "data-saveview", "openSaveView", "Saved views"):
            self.assertNotIn(gone, js, gone)
        self.assertIn('id="saveBtn"', html)
        self.assertIn('id="findingBar"', html)
        # The settings, numbers and picture come from one fresh drawing, checked before anything is read.
        body = js[js.index("async function captureFinding()"):js.index("function suggestTitle()")]
        self.assertLess(body.index("render();"), body.index("figureReady()"))
        self.assertLess(body.index("figureReady()"), body.index("clone(S)"))
        self.assertLess(body.index("evidence()"), body.index("await"))
        # A finding names its session first: one this server does not have changes nothing.
        reopen = js[js.index("async function openFinding(f)"):js.index("function checkFinding()")]
        self.assertLess(reopen.index("D.catalog.some(s => s.id === f.state.session)"), reopen.index("S = sanitize(state)"))

    def test_findings_page_lists_edits_and_reopens(self):
        page, js = (STATIC / "findings" / "index.html").read_text(), (STATIC / "findings" / "findings.js").read_text()
        self.assertIn('<script src="/findings/findings.js"></script>', page)
        for needle in ("C.findingMatches(f, F.q)", "/api/findings/", "/#f=", "{delete: true}", "thumbnail"):
            self.assertIn(needle, js, needle)


if __name__ == "__main__":
    unittest.main()
