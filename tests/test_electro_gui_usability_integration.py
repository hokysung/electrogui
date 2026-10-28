"""HTTP regression checks for result retention and display-only annotations."""
import json
import unittest

from tests import test_electro_gui_server as base
from tests.fixtures import SUA


class UsabilityServerTests(unittest.TestCase):
    setUp = base.ServerTests.setUp
    tearDown = base.ServerTests.tearDown
    get = base.ServerTests.get
    job = base.ServerTests.job

    def test_preview_retains_exports_and_annotation_preserves_science(self):
        request = {"action": "unit", "session_id": self.sid, "unit_id": SUA,
                   "alignment": "stimuli_on", "pre": -.5, "post": .5,
                   "bin": .05, "sigma": 0, "count_window": [0, .5],
                   "stability": "all_complete", "test": "none"}
        base_id, original = self.job(request)
        self.assertEqual(original["status"], "done", original)
        for _ in range(15):
            _, check = self.job({**request, "action": "preview", "workspace": "unit"})
            self.assertEqual(check["status"], "done", check)
            self.assertEqual(check["result"]["support"]["selected_trials"],
                             original["result"]["support"]["selected_trials"])
        self.assertEqual(self.get(f"/api/jobs/{base_id}/export?format=json")[0], 200)
        layer = {"id": "reference", "kind": "reference", "name": "200 ms",
                 "time": .2, "visible": True, "color": "#225f72", "source": "recorded_events"}
        _, computed_with_layer = self.job({**request, "annotations": [layer]})
        self.assertEqual(computed_with_layer["status"], "done", computed_with_layer)
        self.assertEqual(computed_with_layer["result"]["annotations"]["layers"][0]["time"], .2)
        self.assertEqual(computed_with_layer["result"]["groups"], original["result"]["groups"])
        new_id, annotated = self.job({"action": "annotate", "completed_job_id": base_id,
                                      "session_id": self.sid, "layers": [layer]})
        self.assertEqual(annotated["status"], "done", annotated)
        for key in ("groups", "statistics", "support", "times"):
            self.assertEqual(original["result"][key], annotated["result"][key])
        columns = ("row_id", "cohort", "count", "rate", "spikes")
        self.assertEqual([[r.get(k) for k in columns] for r in original["result"]["rows"]],
                         [[r.get(k) for k in columns] for r in annotated["result"]["rows"]])
        status, raw = self.get(f"/api/jobs/{new_id}/export?format=json")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["annotations"]["layers"][0]["time"], .2)
        self.assertEqual(json.loads(raw)["settings"]["annotations"][0]["time"], .2)
        self.assertTrue(json.loads(raw)["provenance"]["annotation_identity"]["code"])
        self.assertEqual(json.loads(raw)["provenance"]["computation_key"],
                         original["result"]["provenance"]["computation_key"])
        status, raw = self.get(f"/api/jobs/{base_id}/export?format=json")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw).get("annotations", {}).get("layers", []), [])
        status, raw = self.get("/api/jobs", "POST", {"action": "annotate",
                               "completed_job_id": base_id, "session_id": "different-source", "layers": [layer]})
        # A different session must be rejected before producing an annotated result.
        if status == 202:
            bad_id = json.loads(raw)["id"]
            import time
            for _ in range(200):
                _, raw = self.get(f"/api/jobs/{bad_id}")
                bad = json.loads(raw)
                if bad["status"] in ("done", "error"):
                    break
                time.sleep(.025)
            self.assertEqual(bad["status"], "error", bad)
        else:
            self.assertEqual(status, 400)
