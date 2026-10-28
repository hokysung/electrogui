"""electro_gui 0.2 explorer: server payloads and browser-side computations.

The explorer computes rasters/PSTHs in the browser (``electro_gui/static/core.js``)
from three payloads built by ``electro_gui/explorer.py``.  These tests pin the
payloads to the v0.1 selection rules in ``analysis.prepare_rows`` and, when node
is available, pin core.js's PSTH to ``analysis.compute_unit`` on the same rows.
"""
import gzip
import http.client
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest import mock

import numpy as np

from electro_gui import explorer
from electro_gui.analysis import compute_unit, prepare_rows
from electro_gui.server import Application, make_server
from session_viewer import explorer_core
from session_viewer.store import HIDDEN_EVENTS, SessionStore, alignment_keys

from tests.fixtures import MUA, NOISE, SUA, UNITS, synthetic_session

CORE_JS = Path(__file__).resolve().parents[1] / "electro_gui" / "static" / "core.js"


class _Tailnet:
    """server.Tailnet stand-in: a fixed owner and MagicDNS name, no tailscale CLI."""

    def __init__(self, owner="owner@example.com", names=("mac.tail.ts.net",)):
        self.owner, self.names = owner, set(names)


class ExplorerPayloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        path, cls.sid, _ = synthetic_session(cls.temp.name)
        cls.store = SessionStore([], [path], Path(cls.temp.name) / "cache")
        cls.loaded = cls.store.get(cls.sid)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_table_rows_match_v01_candidates_in_session_order(self):
        table = explorer.alignment_table(self.loaded, "stimuli_on")
        complete = {t["id"] for t in self.loaded.trials if t["complete"] is True}
        expected = sorted((r for r in self.loaded.rows if r["event"] == "stimuli_on" and r["trial"] in complete),
                          key=lambda r: (r["t"], r["row_id"]))
        self.assertEqual(table["row_id"], [r["row_id"] for r in expected])
        self.assertEqual(table["n"], len(expected))
        self.assertEqual(table["t"], sorted(table["t"]))
        self.assertNotIn("object", table)
        columns = {c["key"]: c for c in table["columns"]}
        for key in ("task", "microstim", "sham", "rewarded", "previous_task"):
            self.assertIn(key, columns)
        task = columns["task"]
        self.assertEqual(task["kind"], "cat")
        decoded = [None if c < 0 else task["levels"][c] for c in task["codes"]]
        self.assertEqual(decoded, [r["task"] for r in expected])
        self.assertEqual(set(task["levels"]), {"memory_saccade", "pursuit_memory"})
        stim = columns["microstim"]
        self.assertEqual(stim["levels"], [False, True])
        for key in ("row_id", "t", "event", "complete", "session_time", "object_uid"):
            self.assertNotIn(key, columns)
        for column in table["columns"]:
            if column.get("relative"):
                self.assertTrue(column["key"].endswith("_t"))
        with self.assertRaises(KeyError):
            explorer.alignment_table(self.loaded, "no_such_event")

    def test_spikes_are_half_open_and_relative(self):
        lo, hi = -1.0, 1.5
        raster = explorer.unit_raster(self.loaded, "stimuli_on", SUA, "all_complete", lo, hi)
        table = explorer.alignment_table(self.loaded, "stimuli_on")
        spikes = np.sort(self.loaded.spikes(SUA))
        self.assertEqual(raster["row_id"], table["row_id"])
        for t, got in zip(table["t"], raster["spikes"]):
            want = spikes[(spikes >= t + lo) & (spikes < t + hi)] - t
            np.testing.assert_allclose(got, want, atol=1e-5)
        with self.assertRaises(ValueError):
            explorer.unit_raster(self.loaded, "stimuli_on", 99999, "all_complete", lo, hi)
        with self.assertRaises(ValueError):
            explorer.unit_raster(self.loaded, "stimuli_on", SUA, "all_complete", 1.0, -1.0)

    def test_span_rule_reproduces_prepare_rows_eligibility(self):
        for policy in ("all_complete", "verified_stable"):
            for pre, post in ((-0.5, 0.5), (-2.0, 1.0), (-6.0, 4.0)):
                raster = explorer.unit_raster(self.loaded, "stimuli_on", MUA, policy, pre - 1, post + 1)
                shown = {rid for rid, span in zip(raster["row_id"], raster["span"])
                         if span and pre - explorer.GUARD_S >= span[0] - 1e-9 and post + explorer.GUARD_S <= span[1] + 1e-9}
                request = {"pre": pre, "post": post, "bin": 0.05, "sigma": 0, "count_window": [pre, post],
                           "stability": policy, "alignment": "stimuli_on", "recipe": {"enabled": False, "cohorts": []}}
                rows, _, _ = prepare_rows(self.loaded, request, [MUA])
                self.assertEqual(shown, {r["row_id"] for r in rows}, (policy, pre, post))
        # unit 5 is stable on the first half only: verified_stable keeps fewer rows
        stable = explorer.unit_raster(self.loaded, "stimuli_on", MUA, "verified_stable", -1, 1)
        every = explorer.unit_raster(self.loaded, "stimuli_on", MUA, "all_complete", -1, 1)
        self.assertLess(sum(s is not None for s in stable["span"]), sum(s is not None for s in every["span"]))

    def test_every_recorded_event_is_offered_and_unknown_ones_refused(self):
        self.assertEqual(HIDDEN_EVENTS, frozenset())
        self.assertEqual(alignment_keys([{"event": "microstim"}, {"event": "fix_on"}]), ["fix_on", "microstim", "stim_train"])
        summary = explorer.session_summary(self.loaded)
        self.assertEqual(set(summary["events"]), {r["event"] for r in self.loaded.rows})
        self.assertIn("stim_train", [a["key"] for a in summary["alignments"]])
        with self.assertRaises(KeyError):
            explorer.event_times(self.loaded, "object_spawn")
        with self.assertRaises(KeyError):
            explorer.alignment_rows(self.loaded, "object_spawn")
        request = {"pre": -0.1, "post": 0.5, "bin": 0.05, "sigma": 0.05, "stability": "all_complete",
                   "alignment": "object_spawn", "recipe": {"enabled": False, "cohorts": []}}
        with self.assertRaises(ValueError):
            prepare_rows(self.loaded, request, [SUA])

    def test_stim_train_pools_stim_and_sham_onsets(self):
        rows = explorer.alignment_rows(self.loaded, "stim_train")
        self.assertTrue(rows)
        self.assertEqual({r["event"] for r in rows}, {"microstim", "sham_microstim"})
        self.assertEqual(len(rows), len(explorer.alignment_rows(self.loaded, "microstim"))
                         + len(explorer.alignment_rows(self.loaded, "sham_microstim")))
        self.assertEqual(explorer.alignment_counts(self.loaded)["stim_train"], len(rows))
        table = explorer.alignment_table(self.loaded, "stim_train")
        self.assertEqual(set(table["event"]), {"microstim", "sham_microstim"})
        stim = {c["key"]: c for c in table["columns"]}["microstim"]
        decoded = [stim["levels"][c] for c in stim["codes"]]
        self.assertEqual(decoded, [e == "microstim" for e in table["event"]])

    def test_event_times_cover_every_valid_occurrence(self):
        events = explorer.event_times(self.loaded, "reward")
        expected = [r for r in self.loaded.rows if r["event"] == "reward"]
        self.assertEqual(events["n"], len(expected))
        self.assertEqual(events["t"], sorted(events["t"]))
        self.assertNotIn("object", events)
        union = explorer.event_times(self.loaded, "stim_train")
        self.assertEqual(union["n"], explorer.event_times(self.loaded, "microstim")["n"] + explorer.event_times(self.loaded, "sham_microstim")["n"])

    def test_session_summary_carries_peak_channels_and_alignment_counts(self):
        summary = explorer.session_summary(self.loaded)
        self.assertTrue(all("peak_channel" in u for u in summary["units"]))
        self.assertEqual({u["id"]: u["peak_channel"] for u in summary["units"]}[SUA], 10)
        self.assertEqual({u["id"]: u["quality"] for u in summary["units"]}, {SUA: "sua", NOISE: "noise", MUA: "mua"})
        counts = {a["key"]: a["n"] for a in summary["alignments"]}
        self.assertEqual(counts["stimuli_on"], explorer.alignment_table(self.loaded, "stimuli_on")["n"])
        self.assertEqual(counts["stimuli_on"], 60)

    def test_spike_train_is_every_spike_of_the_unit(self):
        # The behavior timeline's spike lane: the unit's whole train, no eligibility rule, as
        # integer tick differences on the session clock.
        for uid in (SUA, MUA):
            train = explorer.spike_train(self.loaded, uid)
            expected = np.sort(self.loaded.spikes(uid))
            self.assertEqual(train["n"], len(expected))
            self.assertEqual(train["unit"]["id"], uid)
            self.assertTrue(all(isinstance(d, int) for d in train["dt"]))
            np.testing.assert_allclose(np.cumsum(train["dt"]) * train["tick_s"], expected, atol=train["tick_s"] / 2 + 1e-9)
        with self.assertRaises(ValueError):
            explorer.spike_train(self.loaded, 99999)
        with self.assertRaises(ValueError):
            explorer.spike_train(self.loaded, True)

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_core_js_spike_lane_helpers(self):
        train = explorer.spike_train(self.loaded, SUA)
        script = """
const C = require(process.argv[1]);
const train = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const t = C.decodeSpikeTrain(train);
const sparse = C.spikeColumns(Float64Array.from([0.05, 0.15, 0.95, 1.0, 2.5]), 0, 1, 10);
const dense = C.spikeColumns(Float64Array.from([...Array(20)].map((_, i) => 0.01 + i * 0.001).concat([0.55, 0.95])), 0, 1, 10);
const empty = C.spikeColumns(new Float64Array(0), 0, 1, 4);
process.stdout.write(JSON.stringify({t: Array.from(t), sparse: [Array.from(sparse.counts), sparse.ref, sparse.n],
  dense: [Array.from(dense.counts), dense.ref, dense.n], empty: [Array.from(empty.counts), empty.ref, empty.n]}));
"""
        done = subprocess.run(["node", "-e", script, str(CORE_JS)], input=json.dumps(train),
                              capture_output=True, text=True, timeout=60, check=True)
        js = json.loads(done.stdout)
        np.testing.assert_allclose(js["t"], np.sort(self.loaded.spikes(SUA)), atol=train["tick_s"] / 2 + 1e-9)
        # [t0, t1) into equal columns: 1.0 and 2.5 are outside; sparse spikes shade as plain ticks (ref 1).
        self.assertEqual(js["sparse"], [[1, 1, 0, 0, 0, 0, 0, 0, 0, 1], 1, 3])
        # A 20-spike burst in one column: ref is the 95th percentile of non-empty columns, so the
        # burst is at full shade and the lone spikes are faint.
        self.assertEqual(js["dense"], [[20, 0, 0, 0, 0, 1, 0, 0, 0, 1], 20, 22])
        self.assertEqual(js["empty"], [[0, 0, 0, 0], 1, 0])

    def test_behavior_timeline_lists_every_trial_and_event(self):
        behavior = explorer.behavior_timeline(self.loaded)
        trials = behavior["trials"]
        self.assertEqual(trials["start"], sorted(trials["start"]))
        by_id = {t["id"]: t for t in self.loaded.trials}
        self.assertEqual(set(trials["id"]), {t["id"] for t in self.loaded.trials if t["start"] is not None})
        for i, tid in enumerate(trials["id"]):
            for key in ("task", "rewarded", "microstim", "sham"):
                self.assertEqual(trials[key][i], by_id[tid][key], key)
            self.assertLessEqual(trials["start"][i], trials["stop"][i])
        self.assertEqual(sum(trials["microstim"]), 12)
        self.assertEqual(sum(trials["sham"]), 12)
        events = behavior["events"]
        self.assertNotIn("objects", behavior)
        self.assertEqual(len(events["t"]), len(self.loaded.rows))
        self.assertEqual(events["t"], sorted(events["t"]))
        rows = {r["row_id"]: r for r in self.loaded.rows}
        for trial, t, event, rid in zip(events["trial"], events["t"], events["event"], events["row_id"]):
            self.assertEqual((rows[rid]["trial"], rows[rid]["event"]), (trial, event))
            self.assertAlmostEqual(rows[rid]["t"], t, places=6)
        json.dumps(behavior, allow_nan=False)

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_core_js_behavior_helpers(self):
        full = explorer.behavior_timeline(self.loaded)
        # The first 8 trials: the yoke geometry below is worked out for 8.
        keep = set(full["trials"]["id"][:8])
        behavior = {**full, "trials": {k: v[:8] for k, v in full["trials"].items()},
                    "events": {k: [v for v, tr in zip(vals, full["events"]["trial"]) if tr in keep] for k, vals in full["events"].items()}}
        script = """
const C = require(process.argv[1]);
const fs = require('fs');
const behavior = JSON.parse(fs.readFileSync(0, 'utf8'));
const B = C.prepareBehavior(behavior);
const n = B.trials.n, pos = [];
for (let p = 0; p <= n; p += 0.25) pos.push([p, C.posAtTime(B, C.timeAtPos(B, p))]);
const v = C.behaviorView(B, 0, 3), w = C.behaviorView(B, n + 5, 3), all = C.behaviorView(B, 1, 10 * n);
const yk = (c, count, centre, min) => { const r = C.yokedTrials(B, C.behaviorView(B, c, count), centre, min); return [r.first, r.last]; };
const vt = (c, count) => { const r = C.viewTrials(B, C.behaviorView(B, c, count)); return [r.first, r.last]; };
const yoke = {view: [vt(1.5, 3), vt(4.5, 3), vt(5, 2.5)], widened: yk(1.5, 3, 1, 5), covers: yk(1.5, 3, 7, 5),
  centred: yk(5, 2, 5, 5), wide: yk(4, 6, 0, 5), all: yk(1.5, 3, 1, 20)};
process.stdout.write(JSON.stringify({yoke, tpos: Array.from(B.events.tpos), byTrial: B.byTrial, task: B.trials.task, pos,
  views: [[v.a, v.b], [w.a, w.b], [all.a, all.b]], starts: Array.from(B.trials.start).map((s, p) => C.timeAtPos(B, p) - s)}));
"""
        done = subprocess.run(["node", "-e", script, str(CORE_JS)], input=json.dumps(behavior),
                              capture_output=True, text=True, timeout=60, check=True)
        js = json.loads(done.stdout)
        for p, back in js["pos"]:
            self.assertAlmostEqual(p, back, places=6)
        np.testing.assert_allclose(js["starts"], 0, atol=1e-9)
        n = len(behavior["trials"]["id"])
        self.assertEqual(n, 8)
        self.assertEqual(js["views"], [[0, 3], [5, 8], [0, 8]])
        # Yoked rasters: the view's trials (centres in [a, b)), widened to `min` around the centre
        # trial but always covering the view, clamped to the session.
        self.assertEqual(js["yoke"], {"view": [[0, 2], [3, 5], [4, 5]], "widened": [0, 4], "covers": [0, 4],
                                      "centred": [3, 7], "wide": [1, 6], "all": [0, 7]})
        pos = {tid: i for i, tid in enumerate(behavior["trials"]["id"])}
        self.assertEqual(js["tpos"], [pos.get(t, -1) for t in behavior["events"]["trial"]])
        self.assertEqual(js["task"], behavior["trials"]["task"])
        for p, ks in enumerate(js["byTrial"]):
            self.assertEqual({behavior["events"]["trial"][k] for k in ks}, {behavior["trials"]["id"][p]})

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_core_js_psth_matches_compute_unit(self):
        pre, post, bin_, sigma = -1.0, 1.0, 0.05, 0.05
        table = explorer.alignment_table(self.loaded, "stimuli_on")
        raster = explorer.unit_raster(self.loaded, "stimuli_on", SUA, "all_complete", pre - 0.65, post + 0.65)
        request = {"unit_id": SUA, "alignment": "stimuli_on", "pre": pre, "post": post, "bin": bin_, "sigma": sigma,
                   "count_window": [-0.5, 0.0], "stability": "all_complete", "recipe": {"enabled": False, "cohorts": []}}
        v01 = compute_unit(self.loaded, request)
        self.assertEqual(len(v01["groups"]), 1)
        script = """
const C = require(process.argv[1]);
const fs = require('fs');
const [table, raster] = JSON.parse(fs.readFileSync(0, 'utf8'));
const T = C.prepareTable(table);
const spikes = raster.spikes.map(a => Float64Array.from(a));
const elig = C.eligibility(raster, %(pre)s, %(post)s);
const rows = []; for (let i = 0; i < T.n; i++) if (!elig[i]) rows.push(i);
const grid = C.psthGrid(%(pre)s, %(post)s, %(bin)s, %(sigma)s);
const byTrial = C.psth(rows, i => spikes[i], T.trial, grid, 'trial');
const rates = C.windowRates(rows, i => spikes[i], T.trial, -0.5, 0.0, 'event');
process.stdout.write(JSON.stringify({rows: rows.map(i => T.rowId[i]), times: Array.from(grid.times),
  mean: Array.from(byTrial.mean), sem: Array.from(byTrial.sem), n: byTrial.n, values: rates.values}));
""" % {"pre": pre, "post": post, "bin": bin_, "sigma": sigma}
        done = subprocess.run(["node", "-e", script, str(CORE_JS)], input=json.dumps([table, raster]),
                              capture_output=True, text=True, timeout=60, check=True)
        js = json.loads(done.stdout)
        group = v01["groups"][0]
        self.assertEqual(sorted(js["rows"]), sorted(r["row_id"] for r in v01["rows"]))
        self.assertEqual(js["n"], group["trials"])
        np.testing.assert_allclose(js["times"], v01["times"], atol=1e-9)
        np.testing.assert_allclose(js["mean"], group["mean"], atol=1e-6)
        np.testing.assert_allclose(js["sem"], group["sem"], atol=1e-6)
        by_id = {r["row_id"]: r["rate"] for r in v01["rows"]}
        np.testing.assert_allclose(js["values"], [by_id[r] for r in js["rows"]], atol=1e-9)


class PopulationWorkspaceTests(unittest.TestCase):
    """The explorer's population fit reuses v0.1's basis and v0.1's eligibility rule."""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        path, cls.sid, _ = synthetic_session(cls.temp.name)
        cls.loaded = SessionStore([], [path], Path(cls.temp.name) / "cache").get(cls.sid)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def v01(self, method="pca", scaling="zscore"):
        request = {"unit_ids": list(UNITS), "alignment": "stimuli_on", "pre": -1.0, "post": 1.0, "bin": 0.05,
                   "sigma": 0.05, "count_window": [-0.5, 0.0], "stability": "all_complete", "method": method,
                   "scaling": scaling, "components": 2}
        from electro_gui.population import compute_population
        return request, compute_population(self.loaded, request)

    def fit(self, request, v01, **overrides):
        groups = [{"key": g["name"], "label": g["label"], "row_ids": [r["row_id"] for r in v01["rows"] if r["group"] == g["name"]]}
                  for g in v01["groups"]]
        body = {"unit_ids": request["unit_ids"], "alignment": request["alignment"], "policy": "all_complete",
                "pre": request["pre"], "post": request["post"], "bin": request["bin"], "sigma": request["sigma"],
                "weight": "trial", "method": request["method"], "scaling": request["scaling"],
                "components": request["components"], "groups": groups}
        body.update(overrides)
        return explorer.population_fit(self.loaded, body)

    def test_fit_reproduces_v01_means_and_variance(self):
        request, v01 = self.v01()
        got = self.fit(request, v01)
        self.assertEqual(got["active_unit_ids"], v01["active_unit_ids"])
        keep = [request["unit_ids"].index(u) for u in got["active_unit_ids"]]
        for mine, theirs in zip(got["groups"], v01["groups"]):
            np.testing.assert_allclose(mine["means"], np.array(theirs["input_means"])[:, keep], atol=1e-3)
            coords, ref = np.array(mine["coords"]), np.array(theirs["coordinates"])
            for k in range(2):  # signs are normalised in the explorer
                self.assertTrue(np.allclose(coords[:, k], ref[:, k], atol=1e-4) or np.allclose(coords[:, k], -ref[:, k], atol=1e-4))
        np.testing.assert_allclose(got["explained_variance_ratio"], v01["diagnostics"]["explained_variance_ratio"], atol=1e-6)
        np.testing.assert_allclose(got["component_r2"], got["explained_variance_ratio"], atol=1e-6)
        loadings = np.array(got["loadings"])
        for k in range(2):
            self.assertGreater(loadings[np.argmax(np.abs(loadings[:, k])), k], 0)

    def test_fit_rejects_rows_outside_the_eligibility_rule(self):
        request, v01 = self.v01()
        table = explorer.alignment_table(self.loaded, "stimuli_on")
        spans = explorer_core.population_spans(self.loaded, "stimuli_on", [SUA, MUA], "all_complete")
        wide = next((rid for rid, span in zip(spans["row_id"], spans["span"]) if span and -6 - 0.4 < span[0]), None)
        with self.assertRaises(ValueError):
            self.fit(request, v01, groups=[{"key": "a", "row_ids": [table["row_id"][0], table["row_id"][0]]}])
        with self.assertRaises(ValueError):
            self.fit(request, v01, groups=[{"key": "a", "row_ids": [999999]}])
        if wide is not None:
            with self.assertRaises(ValueError):
                self.fit(request, v01, pre=-6.0, groups=[{"key": "a", "row_ids": [wide]}])
        with self.assertRaises(ValueError):
            self.fit(request, v01, unit_ids=[SUA])

    def test_ica_and_fa_run_with_event_weighting(self):
        for method in ("ica", "fa"):
            request, v01 = self.v01(method=method, scaling="center")
            got = self.fit(request, v01, weight="event")
            self.assertEqual(got["method"], method)
            self.assertEqual(len(got["component_r2"]), 2)
            self.assertTrue(all(np.isfinite(np.array(g["coords"])).all() for g in got["groups"]))

    def test_cumulative_variance_ends_at_the_joint_fit(self):
        for method in ("pca", "ica", "fa"):
            with self.subTest(method=method):
                request, v01 = self.v01(method=method)
                # 2 of the 3 units: a full-rank PCA (components == units) trips session_viewer's fit_basis,
                # whose PCA noise_variance_ is then a plain float without .tolist().
                got = self.fit(request, v01, components=2)
                cum, single = np.array(got["cumulative_r2"]), np.array(got["component_r2"])
                self.assertEqual(len(cum), 2)
                self.assertAlmostEqual(cum[-1], got["reconstruction_r2"], places=5)
                self.assertTrue(np.all(np.diff(cum) >= -1e-6))
                if method != "fa":  # uncorrelated scores: the curve is the running sum of the bars
                    np.testing.assert_allclose(cum, np.cumsum(single), atol=1e-5)

    def test_component_count_is_capped_by_the_data_not_ten(self):
        request, v01 = self.v01()
        with self.assertRaisesRegex(ValueError, "units vary"):  # 3 units: the data, not the 2-10 check, refuses 4
            self.fit(request, v01, components=4)
        with self.assertRaisesRegex(ValueError, f"Choose 2-{explorer.MAX_COMPONENTS} components"):
            self.fit(request, v01, components=explorer.MAX_COMPONENTS + 1)

    def test_single_trial_cloud_is_centred_on_the_trajectory(self):
        for method in ("pca", "ica", "fa"):
            for weight in ("trial", "event"):
                with self.subTest(method=method, weight=weight):
                    request, v01 = self.v01(method=method, scaling="zscore")
                    fitted = self.fit(request, v01, weight=weight)
                    groups = [{"key": g["name"], "label": g["label"], "row_ids": [r["row_id"] for r in v01["rows"] if r["group"] == g["name"]]}
                              for g in v01["groups"]]
                    body = {"unit_ids": request["unit_ids"], "alignment": "stimuli_on", "policy": "all_complete",
                            "pre": -1.0, "post": 1.0, "bin": 0.05, "sigma": 0.05, "weight": weight, "method": method,
                            "scaling": "zscore", "components": 2, "groups": groups, "probe_times": [0.0, -0.37]}
                    probe = explorer.population_probe(self.loaded, body)
                    self.assertEqual(probe["unit"], weight)
                    for p in probe["probes"]:
                        self.assertEqual(p["bin_index"], int(np.floor((p["t"] + 1.0) / 0.05 + 1e-9)))
                        for mine, g in zip(p["groups"], fitted["groups"]):
                            points = np.array(mine["points"])
                            expected_n = g["trials"] if weight == "trial" else g["events"]
                            self.assertEqual(len(points), expected_n)
                            np.testing.assert_allclose(points.mean(axis=0), g["coords"][p["bin_index"]], atol=1e-4)
        with self.assertRaises(ValueError):
            explorer.population_probe(self.loaded, {**body, "probe_times": [5.0]})
        with self.assertRaises(ValueError):
            explorer.population_probe(self.loaded, {**body, "probe_times": []})

    def test_stability_masks_decode_to_eligibility(self):
        import base64
        masks = explorer.stability_masks(self.loaded)
        for unit in self.loaded.units:
            bits = base64.b64decode(masks["units"][str(unit["id"])])
            decoded = {t for i, t in enumerate(masks["trials"]) if bits[i >> 3] >> (i & 7) & 1}
            self.assertEqual(decoded, set(self.loaded.eligibility([unit["id"]], "verified_stable")[0]))
        common = explorer_core.population_spans(self.loaded, "stimuli_on", list(UNITS), "verified_stable")["common_trials"]
        self.assertEqual(common, len(self.loaded.eligibility(list(UNITS), "verified_stable")[0]))
        self.assertEqual(common, 30)   # unit 5 is stable on the first 30 trials only


class ExplorerServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        path, self.sid, _ = synthetic_session(self.temp.name)
        store = SessionStore([], [path], Path(self.temp.name) / "cache")
        self.app = Application(store, findings_dir=Path(self.temp.name) / "findings")
        self.servers = []

    def tearDown(self):
        for server, thread in self.servers:
            server.shutdown(); server.server_close(); thread.join()
        self.app.close()
        self.temp.cleanup()

    def serve(self, **kwargs):
        server = make_server(self.app, port=0, **kwargs)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.servers.append((server, thread))
        return server.server_address[1]

    def request(self, port, path, method="GET", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
        connection.request(method, path, body=json.dumps(body) if body is not None else None,
                           headers={"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        data = response.read()
        result = response.status, dict(response.getheaders()), data
        connection.close()
        return result

    def test_explorer_endpoints_findings_and_gzip(self):
        port = self.serve()
        status, _, body = self.request(port, f"/api/explorer/session?session={self.sid}")
        self.assertEqual(status, 200, body)
        summary = json.loads(body)
        self.assertEqual(summary["session_id"], self.sid)
        status, headers, body = self.request(port, f"/api/explorer/table?session={self.sid}&alignment=stimuli_on",
                                             headers={"Accept-Encoding": "gzip"})
        self.assertEqual(status, 200)
        table = json.loads(gzip.decompress(body) if headers.get("Content-Encoding") == "gzip" else body)
        self.assertGreater(table["n"], 0)
        status, _, body = self.request(port, f"/api/explorer/raster?session={self.sid}&alignment=stimuli_on&unit=3&policy=all_complete&lo=-1&hi=1")
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["n"], table["n"])
        status, _, body = self.request(port, f"/api/explorer/raster?session={self.sid}&alignment=stimuli_on&unit=3&policy=bogus&lo=-1&hi=1")
        self.assertEqual(status, 400)
        status, _, _ = self.request(port, f"/api/explorer/table?session={self.sid}&alignment=nope")
        self.assertEqual(status, 404)
        status, _, body = self.request(port, f"/api/explorer/behavior?session={self.sid}")
        self.assertEqual(status, 200, body)
        timeline = json.loads(body)
        self.assertEqual(len(timeline["trials"]["id"]), 60)
        self.assertGreater(len(timeline["events"]["t"]), 0)
        status, _, body = self.request(port, f"/api/explorer/spiketrain?session={self.sid}&unit=3")
        self.assertEqual(status, 200, body)
        train = json.loads(body)
        self.assertEqual((train["unit"]["id"], len(train["dt"])), (SUA, train["n"]))
        self.assertGreater(train["n"], 0)
        status, _, _ = self.request(port, f"/api/explorer/spiketrain?session={self.sid}&unit=abc")
        self.assertEqual(status, 400)
        status, _, body = self.request(port, "/api/findings", "POST", {"title": "demo", "state": {"session": self.sid, "unit": 3},
                                                                       "evidence": {"session_id": self.sid}})
        self.assertEqual(status, 201, body)
        saved = json.loads(body)
        status, _, body = self.request(port, "/api/findings")
        self.assertEqual([f["state"] for f in json.loads(body)["findings"]], [{"session": self.sid, "unit": 3}])
        self.request(port, f"/api/findings/{saved['id']}", "POST", {"delete": True})
        self.assertEqual(json.loads(self.request(port, "/api/findings")[2])["findings"], [])
        status, _, body = self.request(port, f"/api/explorer/popspans?session={self.sid}&alignment=stimuli_on&units=3,5&policy=all_complete")
        self.assertEqual(status, 200, body)
        spans = json.loads(body)
        self.assertEqual(spans["n"], table["n"])
        status, _, body = self.request(port, f"/api/explorer/stability?session={self.sid}")
        self.assertEqual(status, 200, body)
        self.assertEqual(set(json.loads(body)["units"]), {"3", "4", "5"})
        status, _, body = self.request(port, f"/api/explorer/stable_roster?session={self.sid}")
        self.assertEqual(status, 200, body)
        rows = [rid for rid, span in zip(spans["row_id"], spans["span"]) if span and -1.4 >= span[0] and 1.4 <= span[1]]
        fit = {"session_id": self.sid, "unit_ids": list(UNITS), "alignment": "stimuli_on", "policy": "all_complete",
               "pre": -1, "post": 1, "bin": 0.05, "sigma": 0.02, "weight": "event", "method": "pca", "scaling": "zscore",
               "components": 2, "groups": [{"key": "all", "label": "all", "row_ids": rows}]}
        status, _, body = self.request(port, "/api/explorer/popfit", "POST", fit)
        self.assertEqual(status, 200, body)
        self.assertEqual(len(json.loads(body)["groups"][0]["coords"]), 40)
        status, _, body = self.request(port, "/api/explorer/popfit", "POST", {**fit, "groups": [{"key": "x", "row_ids": [123456]}]})
        self.assertEqual(status, 400, body)
        status, _, body = self.request(port, "/api/explorer/popprobe", "POST", {**fit, "probe_times": [0.0]})
        self.assertEqual(status, 200, body)
        self.assertEqual(len(json.loads(body)["probes"][0]["groups"][0]["points"]), len(rows))
        status, _, body = self.request(port, "/")
        self.assertEqual(status, 200)
        self.assertIn(b"explorer.js", body)
        status, _, body = self.request(port, "/classic/")
        self.assertEqual(status, 404)   # the v0.1 workspace was for another task and is gone

    def test_lan_mode_requires_token(self):
        with self.assertRaises(ValueError):
            make_server(self.app, host="0.0.0.0", port=0)
        port = self.serve(token="s3cret")
        status, _, _ = self.request(port, "/api/catalog")
        self.assertEqual(status, 403)
        status, headers, _ = self.request(port, "/api/catalog?token=wrong")
        self.assertEqual(status, 403)
        status, headers, _ = self.request(port, "/api/catalog?token=s3cret")
        self.assertEqual(status, 200)
        self.assertIn("electro_token=s3cret", headers.get("Set-Cookie", ""))
        status, _, _ = self.request(port, "/api/catalog", headers={"Cookie": "electro_token=s3cret", "Host": "192.168.1.5:8765"})
        self.assertEqual(status, 200)

    def test_token_on_loopback_serves_behind_an_https_proxy(self):
        # tailscale serve forwards https://<host>:8443 to a loopback server: the Host header
        # is the public name and the browser's Origin is https, so neither may trip the guards.
        port = self.serve(token="s3cret")
        proxied = {"Host": "mac.tail.ts.net:8443", "Origin": "https://mac.tail.ts.net:8443"}
        status, _, _ = self.request(port, "/api/catalog?token=s3cret", headers=proxied)
        self.assertEqual(status, 200)
        status, _, _ = self.request(port, "/api/catalog", headers=proxied)
        self.assertEqual(status, 403)
        status, _, _ = self.request(port, "/api/catalog?token=s3cret",
                                   headers={"Host": "mac.tail.ts.net:8443", "Origin": "https://evil.example"})
        self.assertEqual(status, 403)

    def test_tailnet_owner_needs_no_token(self):
        # tailscale serve forwards the device's Host and adds Tailscale-User-Login for the
        # tailnet user; this node's owner is let in on that alone, nobody else.
        port = self.serve(tailnet=_Tailnet())
        node = {"Host": "mac.tail.ts.net:8443", "Origin": "https://mac.tail.ts.net:8443"}
        owner = {**node, "Tailscale-User-Login": "owner@example.com"}
        self.assertEqual(self.request(port, "/api/catalog", headers=owner)[0], 200)
        status, headers, body = self.request(port, "/api/findings", "POST", {"title": "t", "state": {"session": self.sid, "unit": 3},
                                                                            "evidence": {"session_id": self.sid}}, owner)
        self.assertEqual(status, 201, body)
        self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(self.request(port, "/api/catalog")[0], 200)  # this Mac's browser, as before
        refused = [node,  # no tailnet identity (a tagged device)
                   {**node, "Tailscale-User-Login": "someone@example.com"},  # another tailnet user
                   {"Host": "evil.example", "Tailscale-User-Login": "owner@example.com"},  # DNS rebinding
                   {**owner, "Origin": "https://evil.example"},
                   {"Tailscale-User-Login": "someone@example.com"}]  # loopback Host, wrong login
        for headers in refused:
            self.assertEqual(self.request(port, "/api/catalog", headers=headers)[0], 403, headers)
        unknown = self.serve(tailnet=_Tailnet(owner=None, names=()))  # tailscale CLI missing or down
        self.assertEqual(self.request(unknown, "/api/catalog", headers=owner)[0], 403)

    def test_tailnet_identity_is_not_trusted_off_loopback(self):
        # On --lan anyone on the network can send Tailscale-User-Login; only the token counts there.
        with mock.patch("electro_gui.server.ThreadingHTTPServer") as fake:
            make_server(self.app, host="0.0.0.0", port=0, token="s3cret", tailnet=_Tailnet())
        handler_class = fake.call_args.args[1]
        handler = handler_class.__new__(handler_class)
        handler.path = "/api/catalog"
        handler.headers = {"Host": "mac.tail.ts.net:8443", "Tailscale-User-Login": "owner@example.com"}
        sent = []
        handler._send = lambda body, status=200, **_: sent.append(status)
        self.assertFalse(handler._local_request())
        self.assertEqual(sent, [403])

    def test_tailnet_reads_this_nodes_name_and_owner(self):
        from electro_gui.server import Tailnet
        status = {"Self": {"DNSName": "Mac.tail.ts.net.", "UserID": 7}, "User": {"7": {"LoginName": "owner@example.com"}}}
        done = subprocess.CompletedProcess([], 0, stdout=json.dumps(status), stderr="")
        with mock.patch("electro_gui.server.shutil.which", return_value="/usr/bin/tailscale"), \
                mock.patch("electro_gui.server.subprocess.run", return_value=done) as run:
            tailnet = Tailnet()
            self.assertEqual((tailnet.owner, tailnet.names), ("owner@example.com", {"mac.tail.ts.net"}))
            self.assertEqual(Tailnet("other@example.com").owner, "other@example.com")  # --owner wins
        self.assertEqual(run.call_args.args[0], ["/usr/bin/tailscale", "status", "--json"])

    def test_cli_hands_the_owner_to_the_server(self):
        import argparse
        from electro_gui import cli
        args = cli.add_arguments(argparse.ArgumentParser()).parse_args(
            ["--data-root", self.temp.name, "--cache-dir", self.temp.name, "--findings-dir", str(Path(self.temp.name) / "f"),
             "--no-browser", "--port", "0", "--owner", "owner@example.com"])
        with mock.patch("electro_gui.server.make_server", side_effect=OSError("stop")) as fake, \
                mock.patch("electro_gui.server.Tailnet._read", return_value=None), self.assertRaises(SystemExit):
            cli.run(args)
        self.assertIsNone(fake.call_args.kwargs["token"])
        self.assertEqual(fake.call_args.kwargs["tailnet"].owner, "owner@example.com")

    def test_explicit_token_is_kept_on_a_loopback_host(self):
        import argparse
        from unittest import mock
        from electro_gui import cli
        args = cli.add_arguments(argparse.ArgumentParser()).parse_args(
            ["--data-root", self.temp.name, "--cache-dir", self.temp.name, "--findings-dir", str(Path(self.temp.name) / "f"),
             "--no-browser", "--port", "0", "--token", "fixed"])
        with mock.patch("electro_gui.server.make_server", side_effect=OSError("stop")) as fake, self.assertRaises(SystemExit):
            cli.run(args)
        self.assertEqual(fake.call_args.kwargs["token"], "fixed")
        args.token = None
        with mock.patch("electro_gui.server.make_server", side_effect=OSError("stop")) as fake, self.assertRaises(SystemExit):
            cli.run(args)
        self.assertIsNone(fake.call_args.kwargs["token"])  # plain loopback stays token-free


if __name__ == "__main__":
    unittest.main()
