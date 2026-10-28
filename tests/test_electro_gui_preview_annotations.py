import copy
import unittest

import numpy as np

from electro_gui.analysis import compute_unit, prepare_rows
from electro_gui.annotations import annotate_result
from electro_gui.preview import preview_population, preview_unit


class Fixture:
    session_id = "synthetic"
    duration_s = 20.0
    units = [{"id": 1, "area": "ACC", "quality": "SUA", "n_spikes": 5},
             {"id": 2, "area": "ACC", "quality": "MUA", "n_spikes": 5}]
    trials = [{"id": 1, "start": 0., "stop": 8., "complete": True, "task": "memory_saccade", "block_id": 1},
              {"id": 2, "start": 8., "stop": 16., "complete": True, "task": "pursuit", "block_id": 2}]
    rows = [
        {"row_id": 10, "trial": 1, "target_x": 1.0, "t": 2., "event": "anchor", "within_ephys_recording": True, "within_sync_fit_window": True},
        {"row_id": 11, "trial": 1, "target_x": 1.0, "t": 2.2, "event": "saccade_onset", "within_ephys_recording": True, "within_sync_fit_window": True},
        {"row_id": 12, "trial": 1, "t": 2.8, "event": "saccade_offset", "within_ephys_recording": True, "within_sync_fit_window": True},
        {"row_id": 13, "trial": 1, "t": 3.0, "event": "saccade_offset", "within_ephys_recording": True, "within_sync_fit_window": True},
        {"row_id": 14, "trial": 2, "target_x": 3.0, "t": 9., "event": "anchor", "within_ephys_recording": True, "within_sync_fit_window": True},
        {"row_id": 15, "trial": 2, "t": 9.9, "event": "saccade_onset", "within_ephys_recording": True, "within_sync_fit_window": True},
    ]
    fields = [{"key": "task", "type": "category", "values": ["memory_saccade", "pursuit"]}]
    alignments = ["anchor"]

    def eligibility(self, unit_ids, policy):
        return {1, 2}, {"policy": policy}

    def spikes(self, unit_id):
        return np.array([1., 2.1, 2.5, 9.2, 9.7])


def request():
    return {"session_id": "synthetic", "unit_id": 1, "alignment": "anchor", "pre": -.5, "post": .5,
            "bin": .1, "sigma": 0, "count_window": [0, .5], "stability": "all_complete",
            "recipe": {"enabled": False}, "test": "none"}


class PreviewAnnotationTests(unittest.TestCase):
    def test_preview_matches_compute_membership_without_counts(self):
        loaded = Fixture()
        req = request()
        computed = compute_unit(loaded, req)
        preview = preview_unit(loaded, req)
        self.assertEqual(preview["status"], "ready")
        self.assertEqual([r["row_id"] for r in preview["rows"]], [r["row_id"] for r in computed["rows"]])
        self.assertEqual(preview["support"]["selected_events"], computed["support"]["selected_events"])
        self.assertTrue(all("count" not in row and "spikes" not in row for row in preview["rows"]))

    def test_population_roster_reports_per_unit_and_mixed_area(self):
        loaded = Fixture()
        req = {**request(), "unit_ids": [1, 2], "workspace": "population", "components": 2}
        result = preview_population(loaded, req)
        self.assertEqual(result["eligibility"]["status"], "ready")
        self.assertEqual(result["support"]["common_eligible_trials"], 2)
        loaded.units[1]["area"] = "PMd"
        mixed = preview_population(loaded, req)
        self.assertEqual(mixed["status"], "ready")
        self.assertEqual(mixed["support"]["common_eligible_trials"], 2)
        self.assertEqual(mixed["roster"][1]["area"], "PMd")

    def test_annotation_identity_pairing_and_invariance(self):
        loaded = Fixture()
        base = compute_unit(loaded, request())
        before = [(r["row_id"], r["count"], r["rate"]) for r in base["rows"]]
        annotated = annotate_result(base, loaded, [
            {"id": "ref", "kind": "reference", "name": "200 ms", "time": .2},
            {"id": "move", "kind": "interval", "name": "Recorded saccade", "onset": "saccade_onset", "offset": "saccade_offset", "match": "same_trial", "occurrence": "first", "source": "recorded_events"},
            {"id": "ticks", "kind": "event", "name": "saccade offsets", "event": "saccade_offset", "match": "same_trial", "occurrence": "all", "source": "recorded_events"},
        ])
        self.assertEqual(before, [(r["row_id"], r["count"], r["rate"]) for r in annotated["rows"]])
        self.assertEqual(annotated["annotations"]["summary"]["layers"]["move"]["coverage"], 1)
        self.assertEqual(annotated["annotations"]["summary"]["layers"]["move"]["ambiguous"], 0)
        self.assertIn("annotation_intervals", annotated["rows"][0])

    def test_null_identity_does_not_match(self):
        loaded = Fixture()
        loaded.rows = [r for r in loaded.rows if r["event"] != "saccade_offset"]
        loaded.rows.append({"row_id": 99, "trial": None, "t": 2.4, "event": "saccade_offset"})   # no trial: matches no row
        base = compute_unit(loaded, request())
        out = annotate_result(base, loaded, [{"id": "m", "kind": "event", "name": "x", "event": "saccade_offset", "match": "same_trial", "occurrence": "all"}])
        self.assertEqual(out["annotations"]["summary"]["layers"]["m"]["missing"], 2)

    def test_repeated_onset_rejects_entire_interval_and_unknown_source_fails(self):
        loaded = Fixture()
        loaded.rows.insert(2, {"row_id": 101, "trial": 1, "t": 2.4, "event": "saccade_onset"})
        base = compute_unit(loaded, request())
        out = annotate_result(base, loaded, [{"id": "m", "kind": "interval", "name": "bad repeated", "onset": "saccade_onset", "offset": "saccade_offset", "match": "same_trial", "occurrence": "all"}])
        summary = out["annotations"]["summary"]["layers"]["m"]
        self.assertGreaterEqual(summary["ambiguous"], 1)
        self.assertEqual(sum(len(v.get("m", {}).get("intervals", [])) for v in out["annotations"]["rows"].values()), 0)
        with self.assertRaisesRegex(ValueError, "unknown recorded event"):
            annotate_result(base, loaded, [{"id": "bad", "kind": "event", "name": "bad", "event": "missing_event"}])

    def test_numeric_group_bins_are_used_for_compute_labels(self):
        loaded = Fixture()
        loaded.fields.append({"key": "target_x", "type": "number", "availability": "available"})
        recipe = {"shared": {"mode": "all", "rules": []}, "cohorts": [
            {"id": "ms", "name": "memory saccade", "mode": "all", "rules": [{"field": "task", "op": "eq", "value": "memory_saccade"}]},
            {"id": "pu", "name": "pursuit", "mode": "all", "rules": [{"field": "task", "op": "eq", "value": "pursuit"}]}],
            "facet": "none", "group_by": "target_x", "group_bins": {"target_x": [0, 2, 4]}, "split_by": "none", "overlap": "exclude", "strata": "none", "gate": "none"}
        rows, _, _ = prepare_rows(loaded, {**request(), "recipe": recipe}, [1])
        self.assertTrue(rows)
        self.assertEqual(rows[0]["group_label"], "memory saccade · [0, 2)")
        self.assertEqual(rows[-1]["group_label"], "pursuit · [2, 4]")


if __name__ == "__main__":
    unittest.main()
