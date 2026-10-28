"""Independent transform, membership and export checks for the local GUI."""
import copy
import csv
import io
import unittest

import numpy as np

from electro_gui.exports import export_csv, export_json, export_membership, export_statistics, export_svg
from electro_gui.population import compute_population


TASKS = ("fixation", "memory_saccade", "pursuit")


class PopulationFixture:
    session_id = "sub-test_ses-population"
    duration_s = 250.

    def __init__(self):
        self.units = [{"id": i, "area": "acc", "quality": "SUA"} for i in range(6)]
        self.trials = [{"id": i, "start": i * 10., "stop": i * 10. + 9., "complete": True,
                        "task": TASKS[i % 3], "block_id": i // 3} for i in range(24)]
        self.rows = [{"row_id": i, "trial": i, "t": i * 10. + 5., "event": "fix_on",
                      "task": t["task"], "block_id": t["block_id"], "within_ephys_recording": True,
                      "within_sync_fit_window": True} for i, t in enumerate(self.trials)]
        self.fields = [{"key": "task", "type": "category", "values": sorted(TASKS), "availability": "available"}]
        self.alignments = ["fix_on"]
        rng = np.random.default_rng(4)
        self._spikes = {}
        for unit in range(6):
            spikes = []
            for i in range(24):
                for j in range(40):
                    rate = 2 + unit + 12 * (np.sin(j / (2 + unit) + i % 3) + 1)
                    spikes.extend(i * 10 + 4 + .05 * j + rng.uniform(0, .05, rng.poisson(rate * .05)))
            self._spikes[unit] = np.sort(spikes)

    def eligibility(self, unit_ids, policy):
        return {t["id"] for t in self.trials}, {"policy": policy}

    def spikes(self, unit_id):
        return self._spikes[unit_id]

    def metadata(self):
        return {"source": {"sha256": "synthetic"}}


def request():
    return {"session_id": PopulationFixture.session_id, "unit_ids": list(range(6)), "alignment": "fix_on",
            "pre": -.8, "post": .8, "bin": .05, "sigma": 0, "count_window": [0, .5],
            "stability": "all_complete", "method": "pca", "scaling": "zscore", "components": 3}


class PopulationTests(unittest.TestCase):
    def setUp(self):
        self.loaded = PopulationFixture()

    def test_means_match_independent_half_open_counts_and_pca_projection(self):
        req = request()
        result = compute_population(self.loaded, req)
        self.assertEqual(result["support"]["selected_trials"], 24)
        self.assertEqual(len(result["rows"]), 24)
        for g in result["groups"]:
            rows = [r for r in result["rows"] if r["group"] == g["name"]]
            means = np.array(g["input_means"])
            expected = []
            for r in rows:
                unit_curves = []
                for uid in req["unit_ids"]:
                    spikes = self.loaded.spikes(uid)
                    edges = r["t"] + req["pre"] + np.arange(len(result["times"]) + 1) * req["bin"]
                    unit_curves.append([np.count_nonzero((spikes >= a) & (spikes < b)) / req["bin"] for a, b in zip(edges[:-1], edges[1:])])
                expected.append(np.array(unit_curves).T)
            np.testing.assert_allclose(means, np.mean(expected, axis=0), atol=1e-12)
            model = result["model"]
            x = (means - model["center"]) / model["scale"]
            projected = (x - model["operators"]["mean"]) @ np.array(model["operators"]["components"]).T
            np.testing.assert_allclose(projected, g["coordinates"], atol=1e-10)

    def test_ica_and_factor_analysis_reproducible_exports(self):
        for method in ("ica", "fa"):
            with self.subTest(method=method):
                req = {**request(), "method": method, "components": 2}
                result = compute_population(self.loaded, req)
                second = compute_population(self.loaded, req)
                np.testing.assert_allclose(result["groups"][0]["coordinates"], second["groups"][0]["coordinates"], atol=1e-12)
                self.assertEqual(result["model"]["unit_order"], req["unit_ids"])
                self.assertTrue(np.isfinite(np.array(result["loadings"])).all())
                self.assertIn(b'"input_means"', export_json(result))
                stats = list(csv.DictReader(io.StringIO(export_statistics(result).decode())))[0]
                self.assertEqual(stats["method"], method)
                self.assertAlmostEqual(float(stats["reconstruction_r2"]), result["diagnostics"]["reconstruction_r2"])
                table = list(csv.DictReader(io.StringIO(export_csv(result).decode())))
                self.assertEqual(len(table), len(result["times"]) * len(result["groups"]))
                self.assertEqual(len(list(csv.DictReader(io.StringIO(export_membership(result).decode())))), len(result["rows"]))
                self.assertIn(b"<svg", export_svg(result))

    def test_rejects_unknown_duplicate_and_constant_rosters(self):
        for ids in ([1, 1], [0, 100]):
            with self.assertRaises(ValueError):
                compute_population(self.loaded, {**request(), "unit_ids": ids})
        self.loaded.units[0]["area"] = "pmd"
        result = compute_population(self.loaded, request())
        self.assertEqual(result["units"][0]["area"], "pmd")
        self.assertEqual(result["unit_ids"], request()["unit_ids"])
        self.assertEqual(result["support"]["selected_trials"], 24)
        from electro_gui.preview import preview
        checked = preview(self.loaded, {**request(), "workspace": "population"})
        self.assertNotEqual(checked["status"], "error", checked)
        self.loaded.units[0]["area"] = "acc"
        self.loaded._spikes = {i: np.array([]) for i in range(6)}
        with self.assertRaisesRegex(ValueError, "units vary"):
            compute_population(self.loaded, request())


if __name__ == "__main__":
    unittest.main()
