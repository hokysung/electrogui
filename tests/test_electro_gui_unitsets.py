"""Unit annotation sets (electro_gui/unit_sets.py) and their routes."""
import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

from electro_gui.server import Application, make_server
from session_viewer.store import SessionStore

from tests.fixtures import synthetic_session

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 16


class UnitSetRoutes(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path, self.sid, self.root = synthetic_session(self.temp.name)
        (self.path.parent / "tables").mkdir(exist_ok=True)
        (self.path.parent / "tables" / "units.csv").write_text("unit_id,quality,area,peak_channel,mean_rate_hz,n_stable_trials\n3,sua,ACC,7,4.5,30\n")
        self.ann = Path(self.temp.name) / "ann"
        (self.ann / "demo_cards").mkdir(parents=True)
        (self.ann / "demo.csv").write_text(
            "session,sorting,unit,cls,score,flag,tags,note\n"
            f"{self.sid},,3,up,1.5,True,a;b,hello\n{self.sid},,4,down,,False,,\nOther_20200101,srt,9,up,2,,c,\n")
        (self.ann / "demo.json").write_text(json.dumps({"title": "Demo", "description": "d", "source": {"folder": "f", "commit": "c"}, "report": "/r.html", "columns": [
            {"key": "cls", "label": "Class", "group": "G", "type": "category", "help": ""}, {"key": "score", "label": "Score", "group": "G", "type": "number", "help": ""},
            {"key": "flag", "label": "Flag", "group": "H", "type": "flag", "help": ""}, {"key": "tags", "label": "Tags", "group": "H", "type": "tags", "help": ""},
            {"key": "note", "label": "Note", "group": "H", "type": "text", "help": ""}]}))
        (self.ann / "demo_cards" / f"{self.sid}@_u3.png").write_bytes(PNG)
        (Path(self.temp.name) / "secret.png").write_bytes(PNG)
        self.app = Application(SessionStore([self.root], [], Path(self.temp.name) / "cache"), annotations_dir=self.ann)
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

    def test_list_describes_the_set(self):
        status, data, _ = self.get("/api/annotations")
        self.assertEqual(status, 200)
        (info,) = json.loads(data)["sets"]
        self.assertEqual((info["name"], info["title"], info["n_units"], info["has_cards"], info["n_cards"]), ("demo", "Demo", 3, True, 1))
        self.assertEqual(info["sessions"][self.sid], [""])
        self.assertEqual(info["session_counts"], {self.sid: 2, "Other_20200101": 1})
        self.assertEqual([c["key"] for c in info["columns"]], ["cls", "score", "flag", "tags", "note"])

    def test_rows_are_json_safe_typed_and_joined_with_the_export(self):
        status, data, _ = self.get(f"/api/annotations/demo?session={self.sid}&sorting=")
        self.assertEqual(status, 200, data)
        d = json.loads(data)
        self.assertEqual(d["n"], 2)
        self.assertEqual(d["keys"][:3], ["session", "sorting", "unit"])
        row = dict(zip(d["keys"], d["rows"][0]))
        self.assertEqual((row["unit"], row["cls"], row["score"], row["flag"], row["tags"]), (3, "up", 1.5, True, "a;b"))
        self.assertEqual((row["export_quality"], row["peak_channel"], row["n_stable_trials"]), ("sua", 7.0, 30.0))
        other = dict(zip(d["keys"], d["rows"][1]))
        self.assertIsNone(other["score"])          # an empty number is null, never NaN
        self.assertIs(other["flag"], False)
        self.assertIsNone(other["export_quality"])  # unit 4 is not in the export table
        everything = json.loads(self.get("/api/annotations/demo")[1])
        self.assertEqual(everything["n"], 3)
        self.assertIsNone(dict(zip(everything["keys"], everything["rows"][2]))["flag"])

    def test_set_is_reread_when_its_files_change(self):
        self.assertEqual(json.loads(self.get("/api/annotations/demo")[1])["n"], 3)
        time.sleep(0.02)
        with open(self.ann / "demo.csv", "a") as handle:
            handle.write(f"{self.sid},,5,up,3,True,,\n")
        os.utime(self.ann / "demo.csv", None)
        self.assertEqual(json.loads(self.get("/api/annotations/demo")[1])["n"], 4)

    def test_card_route_serves_only_cards_of_the_set(self):
        status, data, kind = self.get(f"/api/annotations/demo/card?session={self.sid}&sorting=&unit=3")
        self.assertEqual((status, kind), (200, "image/png"))
        self.assertTrue(data.startswith(b"\x89PNG"))
        for query in (f"session={self.sid}&unit=4", "session=..%2F..&sorting=&unit=3", f"session={self.sid}&sorting=..%2F..%2Fsecret&unit=3",
                      f"session={self.sid}&sorting=&unit=3%2F..%2F..%2Fsecret", "unit=3", f"session={self.sid}&unit=abc"):
            self.assertIn(self.get(f"/api/annotations/demo/card?{query}")[0], (400, 404), query)

    def test_missing_or_unsafe_set_names_are_refused(self):
        for name in ("nothing", "..%2Fsecret", "%2e%2e", "demo.csv", "demo_cards"):
            self.assertEqual(self.get(f"/api/annotations/{name}")[0], 404, name)
            self.assertEqual(self.get(f"/api/annotations/{name}/card?session={self.sid}&unit=3")[0], 404, name)
        self.assertEqual(self.get("/api/annotations/demo/extra/more")[0], 404)

    def test_no_annotations_folder_lists_nothing(self):
        app = Application(SessionStore([self.root], [], Path(self.temp.name) / "cache2"))
        self.assertEqual(app.annotations(["api", "annotations"], {})[0], {"sets": []})
        with self.assertRaises(KeyError):
            app.annotations(["api", "annotations", "demo"], {})
        app.close()


if __name__ == "__main__":
    unittest.main()
