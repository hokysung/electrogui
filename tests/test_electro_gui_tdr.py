"""Targeted dimensionality reduction in electro_gui's population fit."""
import tempfile
import unittest
from pathlib import Path

import numpy as np

from electro_gui import explorer, tdr
from session_viewer import explorer_core
from session_viewer.store import SessionStore

from tests.fixtures import UNITS, synthetic_session

PRE, POST, BIN = -0.5, 1.0, 0.05


def body(loaded, **extra):
    rows = explorer.alignment_rows(loaded, "stimuli_on")
    spans = explorer_core.population_spans(loaded, "stimuli_on", list(UNITS), "all_complete")["span"]
    groups = {}
    for row, span in zip(rows, spans):
        if span and PRE - 0.4 >= span[0] - 1e-9 and POST + 0.4 <= span[1] + 1e-9:
            groups.setdefault((row["task"], row["microstim"]), []).append(int(row["row_id"]))
    req = {"unit_ids": list(UNITS), "alignment": "stimuli_on", "policy": "all_complete", "pre": PRE, "post": POST,
           "bin": BIN, "sigma": 0, "weight": "event", "method": "tdr", "scaling": "zscore", "components": 3,
           "groups": [{"key": f"{t}|{m}", "label": f"{t} {'stim' if m else 'no stim'}", "row_ids": ids}
                      for (t, m), ids in sorted(groups.items())]}
    req.update(extra)
    return req


class TDRTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        path, sid, _ = synthetic_session(cls.temp.name)
        cls.loaded = SessionStore([], [path], Path(cls.temp.name) / "cache").get(sid)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_default_factors_are_task_and_microstim(self):
        self.assertEqual(explorer.TDR_DEFAULT_FACTORS, ("task", "microstim"))
        self.assertNotIn("world_coding", explorer._FIT_FIELDS)
        fit = explorer.population_fit(self.loaded, body(self.loaded))   # factors omitted: the defaults
        self.assertEqual(fit["tdr"]["factor_keys"], ["task", "microstim"])
        self.assertEqual(fit["components"], 2)
        self.assertNotIn("world_coding", fit["tdr"])
        self.assertNotIn("world", fit["tdr"]["coding"])

    def test_axes_are_orthonormal_and_probe_matches_trajectories(self):
        req = body(self.loaded, factors=["task", "microstim"], components=2)
        fit = explorer.population_fit(self.loaded, req)
        self.assertEqual(fit["method"], "tdr")
        self.assertEqual(len(fit["axis_names"]), 2)
        self.assertEqual([f["kind"] for f in fit["tdr"]["factors"]], ["category", "category"])
        self.assertEqual(fit["tdr"]["factors"][1]["levels"], ["False", "True"])
        q = np.array(fit["loadings"])
        np.testing.assert_allclose(q.T @ q, np.eye(2), atol=1e-5)
        self.assertEqual(fit["tdr"]["window"], [PRE, POST])
        # The projection is x @ Q; the probe must reproduce each group's trajectory centroid.
        req["probe_times"] = [0.25]
        probe = explorer.population_probe(self.loaded, req)["probes"][0]
        j = probe["bin_index"]
        for g, pg in zip(fit["groups"], probe["groups"]):
            self.assertEqual(g["key"], pg["key"])
            np.testing.assert_allclose(np.mean(pg["points"], axis=0), g["coords"][j], atol=1e-4)

    def test_planted_axes_are_recovered(self):
        rng = np.random.default_rng(0)
        n_units, n_bins, n_events = 12, 10, 240
        task = rng.choice(["memory_saccade", "pursuit", "fixation"], n_events)
        stim = rng.random(n_events) < 0.5
        target = rng.normal(size=n_events)
        planted = np.linalg.qr(rng.normal(size=(n_units, 3)))[0]
        rows = [{"task": t, "microstim": bool(m), "target_x": float(x)} for t, m, x in zip(task, stim, target)]
        registry = {"task": {"values": ["fixation", "memory_saccade", "pursuit"]}, "microstim": {"type": "boolean", "values": [False, True]},
                    "target_x": {"type": "number"}}
        X, keep, described = tdr.design(rows, ["task", "microstim", "target_x"], registry)
        self.assertEqual(X.shape, (n_events, 1 + 2 + 1 + 1))          # task: 2 effect columns
        self.assertEqual([d["kind"] for d in described], ["category", "category", "number"])
        # Each factor acts on its own axis in its own time bin (task 2, stim 5, target 8).
        signal = np.stack([(task == "memory_saccade") * 1.0 - (task == "pursuit"), stim * 2.0 - 1, (target - target.mean()) / target.std()])
        rates = rng.normal(0, .1, (n_events, n_bins, n_units))
        for f, t in enumerate((2, 5, 8)):
            rates[:, t, :] += np.outer(signal[f], planted[:, f]) * 3
        means = rates.reshape(n_events, n_bins, n_units)[:8]     # any (groups, times, units) array of the same units
        fit = tdr.fit_axes(means, list(range(n_units)), rates, X, described, np.arange(n_bins), "center")
        q = fit["loadings"]
        np.testing.assert_allclose(q.T @ q, np.eye(3), atol=1e-10)
        self.assertEqual([f["peak_bin"] for f in fit["tdr"]["factors"]], [2, 5, 8])
        for k in range(3):
            self.assertGreater(abs(float(q[:, k] @ planted[:, k])), .9)

    def test_single_level_and_collinear_factors_are_refused(self):
        rows = [{"task": "pursuit", "microstim": m} for m in (True, False) * 4]
        with self.assertRaisesRegex(ValueError, "single level"):
            tdr.design(rows, ["task", "microstim"], {})
        rows = [{"microstim": m, "sham": not m} for m in (True, False) * 4]
        with self.assertRaisesRegex(ValueError, "collinear"):
            tdr.design(rows, ["microstim", "sham"], {})

    def test_window_and_factor_choices_are_honoured_and_validated(self):
        fit = explorer.population_fit(self.loaded, body(self.loaded, factors=["task", "microstim"], tdr_window=[0.0, 0.5], components=2))
        self.assertEqual(fit["components"], 2)
        self.assertEqual(fit["tdr"]["window"], [0.0, 0.5])
        for f in fit["tdr"]["factors"]:
            self.assertTrue(0.0 - 1e-9 <= f["peak_time"] <= 0.5 + 1e-9)
        with self.assertRaisesRegex(ValueError, "TDR window"):
            explorer.population_fit(self.loaded, body(self.loaded, factors=["task", "microstim"], tdr_window=[0.5, 2.0]))
        with self.assertRaisesRegex(ValueError, "not available"):
            explorer.population_fit(self.loaded, body(self.loaded, factors=["task", "gaze_direction"]))
        with self.assertRaisesRegex(ValueError, "2-10"):
            explorer.population_fit(self.loaded, body(self.loaded, factors=["task"]))


if __name__ == "__main__":
    unittest.main()
