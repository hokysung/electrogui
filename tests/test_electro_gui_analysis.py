import unittest

import numpy as np

from electro_gui.analysis import compute_unit
from electro_gui.conditions import default_recipe, select, validate


class Loaded:
    session_id = "synthetic"
    duration_s = 10.0
    units = [{"id": 1, "area": "ACC", "quality": "sua", "n_spikes": 8}]
    trials = [
        {"id": 1, "start": 0.0, "stop": 2.0, "complete": True, "task": "memory_saccade", "microstim": False, "block_id": 10},
        {"id": 2, "start": 2.0, "stop": 4.0, "complete": True, "task": "pursuit", "microstim": True, "block_id": 10},
        {"id": 3, "start": 4.0, "stop": 6.0, "complete": True, "task": "fixation", "microstim": False, "block_id": 11},
    ]
    rows = [
        {"row_id": 1, "t": 1.0, "trial": 1, "event": "stimuli_on", "task": "memory_saccade", "microstim": False, "trial_end_t": 2.0},
        {"row_id": 2, "t": 1.5, "trial": 1, "event": "stimuli_on", "task": "memory_saccade", "microstim": False, "trial_end_t": 2.0},
        {"row_id": 3, "t": 3.0, "trial": 2, "event": "stimuli_on", "task": "pursuit", "microstim": True, "trial_end_t": 3.2},
        {"row_id": 4, "t": 5.0, "trial": 3, "event": "stimuli_on", "task": "fixation", "microstim": False, "trial_end_t": 6.0},
    ]
    alignments = ["stimuli_on"]
    fields = [
        {"key": "task", "type": "category", "values": ["fixation", "memory_saccade", "pursuit"]},
        {"key": "microstim", "type": "boolean"},
        {"key": "trial_end_t", "type": "number"},
    ]

    def eligibility(self, unit_ids, policy):
        return {1, 2, 3}, {"policy": policy, "source": "synthetic"}

    def spikes(self, unit_id):
        return np.array([1.0, 1.1, 1.5, 3.0, 3.25, 5.0, 5.5, 5.75])


def _recipe(**kw):
    base = {"shared": {"mode": "all", "rules": []}, "overlap": "exclude", "strata": "none", "facet": "none",
            "group_by": "cohort", "split_by": "none", "gate": "none"}
    return {**base, **kw}


class ElectroAnalysisTests(unittest.TestCase):
    def test_half_open_count_and_equal_trial_weight(self):
        request = {"unit_id": 1, "alignment": "stimuli_on", "pre": -.5, "post": .5, "bin": .1, "sigma": 0, "count_window": [0, .5], "stability": "all_complete", "recipe": {"enabled": False}, "test": "none"}
        result = compute_unit(Loaded(), request)
        self.assertEqual([r["count"] for r in result["rows"]], [2, 1, 2, 1])
        self.assertEqual(result["groups"][0]["trials"], 3)

    def test_trial_end_gate(self):
        recipe = _recipe(cohorts=[{"id": "a", "name": "a", "mode": "all", "rules": [{"field": "task", "op": "in", "value": ["pursuit", "fixation"]}]}],
                         gate="before_trial_end", window=[0, .5])
        out = select([Loaded.rows[2], Loaded.rows[3]], recipe, Loaded())
        self.assertEqual([r["row_id"] for r in out["rows"]], [4])   # row 3's window ends after its trial
        self.assertEqual(out["summary"]["gate_excluded"], 1)
        self.assertTrue(validate(_recipe(cohorts=recipe["cohorts"], gate="before_next_outcome"), Loaded()))

    def test_overlap_is_excluded_and_unknown_fields_rejected(self):
        recipe = _recipe(cohorts=[{"id": "a", "name": "a", "mode": "all", "rules": [{"field": "task", "op": "in", "value": ["pursuit", "fixation"]}]},
                                  {"id": "b", "name": "b", "mode": "all", "rules": [{"field": "microstim", "op": "eq", "value": True}]}])
        out = select([Loaded.rows[2]], recipe, Loaded())
        self.assertEqual(out["rows"], [])
        self.assertEqual(out["summary"]["overlap_excluded"], 1)
        self.assertIn("unknown", validate({"shared": {"mode": "all", "rules": [{"field": "nope", "op": "eq", "value": "x"}]}, "cohorts": []}, Loaded())[0])

    def test_task_strata(self):
        recipe = _recipe(cohorts=[{"id": "s", "name": "stim", "mode": "all", "rules": [{"field": "microstim", "op": "eq", "value": True}]},
                                  {"id": "n", "name": "no stim", "mode": "all", "rules": [{"field": "microstim", "op": "eq", "value": False}]}],
                         strata="task")
        out = select(Loaded.rows, recipe, Loaded())
        self.assertEqual(out["rows"], [])          # no task has both stim and no-stim rows
        self.assertEqual(out["summary"]["strata_excluded"], 4)

    def test_default_recipe_is_one_cohort_per_task(self):
        self.assertEqual([c["id"] for c in default_recipe(Loaded())["cohorts"]], ["fixation", "memory_saccade", "pursuit"])
        self.assertEqual(len(default_recipe()["cohorts"]), 3)
        request = {"unit_id": 1, "alignment": "stimuli_on", "pre": -.5, "post": .5, "bin": .1, "sigma": 0, "count_window": [0, .5],
                   "stability": "all_complete", "test": "none"}
        result = compute_unit(Loaded(), request)
        self.assertEqual(sorted(g["color_key"] for g in result["groups"]), ["fixation", "memory_saccade", "pursuit"])
        with self.assertRaises(ValueError):
            compute_unit(Loaded(), dict(request, test="bogus"))


if __name__ == "__main__":
    unittest.main()
