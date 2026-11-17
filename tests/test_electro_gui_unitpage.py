"""The unit page's read-only routes: unit info, stimulation trains and exported figures."""
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from electro_gui.server import Application, make_server
from session_viewer.store import SessionStore

from tests.fixtures import MUA, SUA, synthetic_session


class UnitPageRoutes(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path, self.sid, self.root = synthetic_session(self.temp.name)
        figures = self.path.parent / "figures"
        (figures / "panels" / f"unit_{SUA:04d}_sua_X_acc").mkdir(parents=True)
        (figures / "unit_rasters").mkdir()
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 16
        (figures / "panels" / f"unit_{SUA:04d}_sua_X_acc" / "stim_a.png").write_bytes(png)
        (figures / "panels" / "manifest.json").write_text(json.dumps(
            {"panels": [{"key": "stim_a", "group": "Stim", "title": "Stim A", "desc": "d"}]}))
        (figures / "unit_rasters" / f"unit_{SUA:04d}_sua_X_acc_rates_raster.png").write_bytes(png)
        (Path(self.temp.name) / "secret.png").write_bytes(png)
        self.app = Application(SessionStore([self.root], [], Path(self.temp.name) / "cache"))
        self.server = make_server(self.app, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.app.close()
        self.thread.join()
        self.temp.cleanup()

    def get(self, path):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=30)
        connection.request("GET", path)
        response = connection.getresponse()
        data, status, kind = response.read(), response.status, response.getheader("Content-Type")
        connection.close()
        return status, data, kind

    def test_unitinfo_has_qc_stable_trials_and_figures(self):
        status, data, _ = self.get(f"/api/explorer/unitinfo?session={self.sid}&unit={SUA}")
        self.assertEqual(status, 200, data)
        info = json.loads(data)
        self.assertEqual(info["unit"], SUA)
        self.assertEqual(info["n_complete"], 60)
        loaded = self.app.store.get(self.sid)
        self.assertEqual(info["stable"], sorted(loaded.file.stable_trials[SUA]))
        self.assertEqual(info["qc"]["bc_unit_type"], "GOOD")
        keys = {f["key"]: f for f in info["figures"]}
        self.assertEqual(keys["stim_a"]["title"], "Stim A")
        self.assertEqual(keys["stim_a"]["path"], f"panels/unit_{SUA:04d}_sua_X_acc/stim_a.png")
        self.assertIn("rates_raster", keys)
        # another unit has none; a stable run that stops early is reported as such
        status, data, _ = self.get(f"/api/explorer/unitinfo?session={self.sid}&unit={MUA}")
        other = json.loads(data)
        self.assertEqual(other["figures"], [])
        self.assertLess(len(other["stable"]), other["n_complete"])

    def test_unitinfo_rejects_unknown_unit(self):
        self.assertEqual(self.get(f"/api/explorer/unitinfo?session={self.sid}&unit=99999")[0], 400)
        self.assertEqual(self.get(f"/api/explorer/unitinfo?session={self.sid}&unit=x")[0], 400)

    def test_stimtrains_lists_one_train_per_stim_or_sham_trial(self):
        status, data, _ = self.get(f"/api/explorer/stimtrains?session={self.sid}")
        self.assertEqual(status, 200, data)
        trains = json.loads(data)
        loaded = self.app.store.get(self.sid)
        expected = sum(1 for t in loaded.trials if t.get("microstim") is True or t.get("sham") is True)
        self.assertEqual(trains["n"], expected)
        self.assertEqual(len(trains["t"]), expected)
        self.assertEqual(set(trains["condition"]) - {None}, {"stim", "sham"})
        self.assertEqual(trains["t"], sorted(trains["t"]))

    def test_figure_route_serves_only_pictures_inside_figures(self):
        rel = f"panels/unit_{SUA:04d}_sua_X_acc/stim_a.png"
        status, data, kind = self.get(f"/api/figure?session={self.sid}&path={rel}")
        self.assertEqual((status, kind), (200, "image/png"))
        self.assertTrue(data.startswith(b"\x89PNG"))
        for bad in ("../secret.png", "panels/../../secret.png", "/etc/passwd", "panels//stim_a.png", "panels/manifest.json",
                    "..%2Fsecret.png", "%2e%2e/secret.png", "panels\\..\\x.png", ""):
            status, _, _ = self.get(f"/api/figure?session={self.sid}&path={bad}")
            self.assertIn(status, (400, 404), bad)
        self.assertEqual(self.get(f"/api/figure?session={self.sid}&path=panels/nothing.png")[0], 404)
        self.assertEqual(self.get(f"/api/figure?session={self.sid}")[0], 400)
        self.assertEqual(self.get("/api/figure?path=x.png")[0], 400)

    def test_figure_route_refuses_a_symlink_out_of_figures(self):
        link = self.path.parent / "figures" / "out.png"
        link.symlink_to(Path(self.temp.name) / "secret.png")
        status, _, _ = self.get(f"/api/figure?session={self.sid}&path=out.png")
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
