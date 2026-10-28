import itertools
import unittest

import numpy as np

from electro_gui.analysis import _infer, prepare_rows
from electro_gui.conditions import select


def paired_rows(blocks, diffs=None):
    rows = []
    diffs = diffs or [1.0] * len(blocks)
    for i, (block, diff) in enumerate(zip(blocks, diffs)):
        trial = i + 1
        rows.extend([
            {"row_id": 2 * i, "trial": trial, "block_id": block, "cohort": "A", "rate": float(diff)},
            {"row_id": 2 * i + 1, "trial": trial, "block_id": block, "cohort": "B", "rate": 0.0},
        ])
    return rows


class MinimalLoaded:
    session_id = "regression"
    duration_s = 20.0
    units = [{"id": 1, "area": "ACC", "quality": "good", "n_spikes": 0}]
    fields = [
        {"key": "task", "type": "category", "values": ["fixation", "memory_saccade", "pursuit"]},
        {"key": "target_label", "type": "category", "values": ["left", "right", "NA"]},
    ]

    def __init__(self, trials, rows):
        self.trials, self.rows = trials, rows

    def eligibility(self, unit_ids, policy):
        return {t["id"] for t in self.trials if t.get("eligible", True)}, {"policy": policy}

    def spikes(self, unit_id):
        return np.array([], dtype=float)


class ElectroGuiRegressions(unittest.TestCase):
    def test_exact_block_sign_flip_is_one_sign_per_block(self):
        result = _infer(paired_rows([1, 2, 3]), {"recipe": {}, "seed": 0, "n_permutations": 99}, "paired_permutation")
        self.assertTrue(result["exact"])
        self.assertEqual(result["n_null"], 8)
        self.assertEqual(result["p_value"], 2 / 8)
        self.assertEqual(result["null_scheme"], "One sign flip per block, shared by every paired trial in that block.")

    def test_mc_sign_flip_matches_independent_seeded_block_draws(self):
        blocks = list(range(17))
        diffs = [float(i - 8) for i in range(17)]
        result = _infer(paired_rows(blocks, diffs), {"recipe": {}, "seed": 17, "n_permutations": 257}, "paired_permutation")
        rng = np.random.default_rng(17)
        expected = []
        for _ in range(257):
            signs = rng.choice((-1, 1), size=17)
            expected.append(float(np.dot(signs, np.asarray(diffs)) / 17))
        observed = float(np.mean(diffs))
        p = (sum(abs(x) >= abs(observed) - 1e-12 for x in expected) + 1) / (len(expected) + 1)
        self.assertEqual(result["exact"], False)
        self.assertAlmostEqual(result["p_value"], p)
        self.assertEqual(result["n_blocks"], 17)

    def test_exact_disjoint_block_permutation_uses_block_means(self):
        rows = []
        for i, (block, cohort, rate) in enumerate([(1, "A", 1), (2, "A", 2), (3, "B", 10), (4, "B", 11)]):
            rows.append({"row_id": i, "trial": i, "block_id": block, "cohort": cohort, "rate": rate})
        result = _infer(rows, {"recipe": {}, "seed": 0, "n_permutations": 10}, "block_permutation")
        null = []
        values = [1, 2, 10, 11]
        for a in itertools.combinations(range(4), 2):
            mask = set(a)
            null.append(np.mean([values[i] for i in mask]) - np.mean([values[i] for i in range(4) if i not in mask]))
        expected_p = sum(abs(x) >= 9.0 for x in null) / 6
        self.assertTrue(result["exact"])
        self.assertEqual(result["n_null"], 6)
        self.assertAlmostEqual(result["p_value"], expected_p)

    def test_overlap_blocks_and_source_events_are_blocked(self):
        rows = paired_rows([1, 2, 3])
        rows.append({"row_id": 0, "trial": 99, "block_id": 9, "cohort": "B", "rate": 2.0})
        result = _infer(rows, {"recipe": {}, "seed": 0}, "paired_permutation")
        self.assertEqual(result["status"], "blocked")
        self.assertIn("source event", result["reason"])

    def test_event_and_trial_weighting_are_explicit(self):
        rows = [
            {"row_id": 1, "trial": 1, "block_id": 1, "cohort": "A", "rate": 0.0},
            {"row_id": 2, "trial": 1, "block_id": 1, "cohort": "A", "rate": 0.0},
            {"row_id": 3, "trial": 2, "block_id": 1, "cohort": "A", "rate": 10.0},
            {"row_id": 6, "trial": 5, "block_id": 4, "cohort": "A", "rate": 8.0},
            {"row_id": 4, "trial": 3, "block_id": 2, "cohort": "B", "rate": 4.0},
            {"row_id": 5, "trial": 4, "block_id": 3, "cohort": "B", "rate": 6.0},
        ]
        result = _infer(rows, {"recipe": {}, "seed": 0, "n_permutations": 10}, "block_permutation")
        self.assertAlmostEqual(result["block_means_hz"][0], 5.0)
        self.assertEqual(result["estimator"], "Equal events within trial, equal trials within block, equal blocks within cohort; A minus B.")

    def test_count_window_overrides_stale_recipe_and_runs_bridge_iti(self):
        trials = [
            {"id": 1, "start": 0.0, "stop": 1.0, "complete": True, "task": "pursuit", "eligible": True},
            {"id": 2, "start": 2.0, "stop": 3.0, "complete": True, "task": "pursuit", "eligible": True},
            {"id": 3, "start": 4.0, "stop": 5.0, "complete": True, "task": "pursuit", "eligible": False},
        ]
        rows = [{"row_id": 7, "trial": 2, "t": 2.5, "event": "stimuli_on", "trial_end_t": 3.0, "task": "pursuit"}]
        recipe = {"shared": {"mode": "all", "rules": []}, "cohorts": [{"id": "A", "name": "A", "mode": "all", "rules": [{"field": "task", "op": "eq", "value": "pursuit"}]}], "gate": "before_trial_end", "window": [0.0, 1.0], "overlap": "exclude", "strata": "none", "facet": "none", "group_by": "cohort", "split_by": "none"}
        selected, support, provenance = prepare_rows(MinimalLoaded(trials, rows), {"alignment": "stimuli_on", "pre": -0.1, "post": 0.1, "bin": 0.1, "sigma": 0, "count_window": [0.0, 0.1], "stability": "all_complete", "recipe": recipe}, [1])
        self.assertEqual([r["row_id"] for r in selected], [7])
        self.assertEqual(provenance["recipe"]["window"], [0.0, 0.1])
        self.assertEqual(support["runs"], 1)

    def test_missing_category_does_not_match_literal_na(self):
        recipe = {"shared": {"mode": "all", "rules": []}, "cohorts": [{"id": "A", "name": "A", "mode": "all", "rules": [{"field": "target_label", "op": "eq", "value": "NA"}]}], "overlap": "exclude", "strata": "none", "facet": "none", "group_by": "cohort", "split_by": "none", "gate": "none"}
        rows = [{"row_id": 1, "target_label": None}, {"row_id": 2, "target_label": "NA"}]
        result = select(rows, recipe, MinimalLoaded([], []))
        self.assertEqual([r["row_id"] for r in result["rows"]], [2])


if __name__ == "__main__":
    unittest.main()
