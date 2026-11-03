"""Alternate sortings: ``<root>/<sid>/sortings/<name>/session.h5`` beside the default ``<sid>/session.h5``."""
import http.client
import json
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest

import h5py

from session_viewer.store import SessionStore

from electro_gui.findings import FindingStore
from electro_gui.server import Application, make_server
from electro_gui.sortings import SortingStore, normalize_sorting, sorting_label

from tests.fixtures import SUA, synthetic_session

ALT = "ks4_alt"


def add_sorting(default_path, name, streams):
    """A copy of the default export at ``sortings/<name>/session.h5`` whose meta names ``streams``."""
    folder = Path(default_path).parent / "sortings" / name
    (folder / "tables").mkdir(parents=True)
    path = folder / "session.h5"
    shutil.copy2(default_path, path)
    with h5py.File(path, "r+") as handle:
        meta = json.loads(handle.attrs["meta"])
        meta["streams"] = streams
        handle.attrs["meta"] = json.dumps(meta)
    return path


UNIT_REQUEST = {"action": "unit", "unit_id": SUA, "alignment": "stimuli_on",
                "recipe": {"shared": {"mode": "all", "rules": []}, "facet": "none", "group_by": "task", "split_by": "none",
                           "overlap": "exclude", "strata": "none", "gate": "none",
                           "cohorts": [{"id": "all", "name": "all", "mode": "all", "rules": [{"field": "task", "op": "present"}]}]},
                "pre": -.5, "post": .5, "bin": .05, "sigma": 0, "count_window": [0, .5], "stability": "all_complete"}


class SortingStoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.path, cls.sid, cls.root = synthetic_session(cls.temp.name)
        cls.alt = add_sorting(cls.path, ALT, [{"stream": "imec0", "sorting": ALT, "area": "ACC"}])
        cls.mixed = add_sorting(cls.path, "mixed", [{"stream": "imec0", "sorting": "ms5_lar_v8", "area": "ACC"},
                                                    {"stream": "imec1", "sorting": "ms5_lar_v6", "area": "FEF"}])
        (cls.path.parent / "sortings" / "empty").mkdir()            # no session.h5: not listed
        cls.store = SortingStore([cls.root], [], Path(cls.temp.name) / "cache")

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_sortings_folder_is_not_a_session(self):
        self.assertEqual([e["id"] for e in self.store.catalog()], [self.sid])

    def test_lists_default_first_then_alternates_by_name(self):
        listed = self.store.sortings(self.sid)
        self.assertEqual([o["name"] for o in listed], [None, ALT, "mixed"])
        self.assertEqual([o["is_default"] for o in listed], [True, False, False])
        self.assertEqual(listed[0]["label"], "ms5_lar_v6")       # what the synthetic export's streams name
        self.assertEqual(listed[1]["label"], ALT)
        self.assertEqual(listed[2]["label"], "imec0 ms5_lar_v8 · imec1 ms5_lar_v6")
        self.assertTrue(all(o["n_units"] == 3 for o in listed))
        catalog = self.store.catalog_with_sortings()
        self.assertEqual([o["name"] for o in catalog[0]["sortings"]], [None, ALT, "mixed"])

    def test_default_is_unchanged_and_alternate_resolves_to_its_file(self):
        default = self.store.get(self.sid)
        self.assertIsNone(default.sorting)
        self.assertEqual(Path(default.session.path), self.path.resolve())
        self.assertIs(self.store.get(self.sid, None), default)
        self.assertIs(self.store.get(self.sid, ""), default)
        alt = self.store.get(self.sid, ALT)
        self.assertEqual(alt.sorting, ALT)
        self.assertEqual(alt.sorting_label, ALT)
        self.assertEqual(Path(alt.session.path), self.alt.resolve())
        self.assertIsNot(alt, default)
        self.assertEqual(alt.session_id, self.sid)

    def test_unknown_or_malformed_sorting_is_refused(self):
        with self.assertRaises(KeyError):
            self.store.get(self.sid, "empty")
        with self.assertRaises(KeyError):
            self.store.get(self.sid, "nope")
        for bad in ("../x", "a/b", ".hidden", 3):
            with self.assertRaises(ValueError):
                normalize_sorting(bad)

    def test_explicit_session_file_has_only_its_default(self):
        store = SortingStore([], [self.path], Path(self.temp.name) / "cache2")
        self.assertEqual([o["name"] for o in store.sortings(self.sid)], [None])
        with self.assertRaises(KeyError):
            store.get(self.sid, ALT)
        self.assertIsNone(store.get(self.sid).sorting)

    def test_label(self):
        self.assertIsNone(sorting_label({}))
        self.assertEqual(sorting_label({"streams": [{"stream": "imec0", "sorting": "a"}, {"stream": "imec1", "sorting": "a"}]}), "a")


class SortingServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path, self.sid, self.root = synthetic_session(self.temp.name)
        self.alt = add_sorting(self.path, ALT, [{"stream": "imec0", "sorting": ALT, "area": "ACC"}])
        # A plain SessionStore, as the older tests pass: the Application still sees the alternates.
        self.app = Application(SessionStore([self.root], [], Path(self.temp.name) / "cache"),
                               findings_dir=Path(self.temp.name) / "findings")
        self.server = make_server(self.app, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.app.close()
        self.thread.join()
        self.temp.cleanup()

    def get(self, path, method="GET", body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=30)
        connection.request(method, path, body=json.dumps(body) if body is not None else None,
                           headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response.status, json.loads(data)

    def job(self, request):
        status, data = self.get("/api/jobs", "POST", request)
        self.assertEqual(status, 202, data)
        for _ in range(400):
            _, result = self.get("/api/jobs/" + data["id"])
            if result["status"] in ("error", "done"):
                return data["id"], result
            time.sleep(.025)
        self.fail("Synthetic job did not complete")

    def test_catalog_lists_sortings(self):
        status, cat = self.get("/api/catalog")
        self.assertEqual(status, 200)
        listed = cat["sessions"][0]["sortings"]
        self.assertEqual([(o["name"], o["is_default"]) for o in listed], [(None, True), (ALT, False)])

    def test_explorer_reads_follow_the_sorting_param(self):
        for sorting, path in ((None, self.path), (ALT, self.alt)):
            _, load = self.job({"action": "load", "session_id": self.sid, **({"sorting": sorting} if sorting else {})})
            self.assertEqual(load["status"], "done", load)
            self.assertEqual(Path(load["result"]["source"]["path"]), path.resolve())
            suffix = f"&sorting={sorting}" if sorting else ""
            status, summary = self.get(f"/api/explorer/session?session={self.sid}{suffix}")
            self.assertEqual(status, 200, summary)
            self.assertEqual(summary["sorting"], sorting)
            self.assertEqual(Path(summary["source"]["path"]), path.resolve())
        status, _ = self.get(f"/api/explorer/session?session={self.sid}&sorting=nope")
        self.assertEqual(status, 404)
        status, _ = self.get(f"/api/explorer/session?session={self.sid}&sorting=..%2Fx")
        self.assertEqual(status, 400)

    def test_results_say_their_sorting_and_default_request_is_unchanged(self):
        _, default = self.job(dict(UNIT_REQUEST, session_id=self.sid))
        _, alt = self.job(dict(UNIT_REQUEST, session_id=self.sid, sorting=ALT))
        self.assertEqual(default["status"], "done", default)
        self.assertEqual(alt["status"], "done", alt)
        self.assertIsNone(default["result"]["sorting"])
        self.assertEqual(alt["result"]["sorting"], ALT)
        # The default's computation identity has no sorting key, as before alternates existed.
        self.assertNotIn("sorting", default["result"]["provenance"]["computation_identity"]["parameters"])
        self.assertEqual(alt["result"]["provenance"]["computation_identity"]["parameters"]["sorting"], ALT)
        self.assertNotEqual(default["result"]["provenance"]["computation_key"], alt["result"]["provenance"]["computation_key"])

    def test_annotation_cannot_cross_sortings(self):
        job_id, alt = self.job(dict(UNIT_REQUEST, session_id=self.sid, sorting=ALT))
        self.assertEqual(alt["status"], "done", alt)
        status, data = self.get("/api/jobs", "POST", {"action": "annotate", "completed_job_id": job_id, "layers": [],
                                                      "sorting": None})
        self.assertEqual(status, 400, data)
        _, annotated = self.job({"action": "annotate", "completed_job_id": job_id, "layers": []})
        self.assertEqual(annotated["status"], "done", annotated)
        self.assertEqual(annotated["result"]["sorting"], ALT)

    def test_findings_are_keyed_by_sorting(self):
        store = FindingStore(Path(self.temp.name) / "f2")
        base = {"title": "t", "state": {"session": self.sid, "unit": SUA}, "evidence": {"session_id": self.sid}}
        old = store.create(base)                                      # a finding as saved before sortings: default
        self.assertNotIn("sorting", old["state"])
        alt = store.create({**base, "state": {**base["state"], "sorting": ALT}, "evidence": {**base["evidence"], "sorting": ALT}})
        self.assertEqual(alt["state"]["sorting"], ALT)
        store.create({**base, "state": {**base["state"], "sorting": None}})     # null is the default too
        with self.assertRaises(ValueError):
            store.create({**base, "state": {**base["state"], "sorting": ALT}})    # evidence from the default
        with self.assertRaises(ValueError):
            store.create({**base, "evidence": {**base["evidence"], "sorting": ALT}})


if __name__ == "__main__":
    unittest.main()
