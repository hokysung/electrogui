import argparse
import contextlib
import http.client
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from electro_gui import cli, server as server_module
from session_viewer.store import SessionStore
from electro_gui.server import Application, code_changed_since, make_server

from tests.fixtures import SUA, synthetic_session


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path, self.sid, self.root = synthetic_session(self.temp.name)
        store = SessionStore([self.root], [], Path(self.temp.name) / "cache")
        self.app = Application(store)
        self.server = make_server(self.app, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.app.close()
        self.thread.join()
        self.temp.cleanup()

    def get(self, path, method="GET", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=30)
        hdr = {"Content-Type": "application/json", **(headers or {})}
        connection.request(method, path, body=json.dumps(body) if body is not None else None, headers=hdr)
        response = connection.getresponse()
        data = response.read()
        status = response.status
        connection.close()
        return status, data

    def job(self, request):
        status, data = self.get("/api/jobs", "POST", request)
        self.assertEqual(status, 202, data)
        job_id = json.loads(data)["id"]
        for _ in range(200):
            _, raw = self.get("/api/jobs/" + job_id)
            result = json.loads(raw)
            if result["status"] in ("error", "done"):
                return job_id, result
            time.sleep(.025)
        self.fail("Synthetic job did not complete")

    def test_dynamic_load_computation_and_bound_export(self):
        status, data = self.get("/api/catalog")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["sessions"][0]["id"], self.sid)
        _, load = self.job({"action": "load", "session_id": self.sid})
        self.assertEqual(load["status"], "done", load)
        self.assertEqual(len(load["result"]["units"]), 3)
        request = {"action": "unit", "session_id": self.sid, "unit_id": SUA, "alignment": "stimuli_on",
                   "recipe": {"shared": {"mode": "all", "rules": []}, "facet": "none", "group_by": "task", "split_by": "none",
                              "overlap": "exclude", "strata": "none", "gate": "none",
                              "cohorts": [{"id": "all", "name": "all", "mode": "all",
                                           "rules": [{"field": "task", "op": "present"}]}]},
                   "pre": -.5, "post": .5, "bin": .05, "sigma": 0, "count_window": [0, .5], "stability": "all_complete"}
        job_id, computed = self.job(request)
        self.assertEqual(computed["status"], "done", computed)
        result = computed["result"]
        self.assertTrue(result["rows"])
        self.assertEqual(sorted(g["color_key"] for g in result["groups"]), ["memory_saccade", "pursuit_memory"])
        self.assertEqual(result["provenance"]["computation_identity"]["source"]["sha256"], load["result"]["source"]["sha256"])
        self.assertIn("session_viewer_repository", result["provenance"])
        self.assertNotIn("imitation_phys_repository", result["provenance"])
        # the target-locked burst of unit 3 (50-150 ms after stimuli_on) is in the PSTH
        times = result["times"]
        mean = result["groups"][0]["mean"]
        burst = [m for t, m in zip(times, mean) if 0.05 <= t < 0.15]
        before = [m for t, m in zip(times, mean) if -0.5 <= t < -0.1]
        self.assertGreater(min(burst), 3 * max(before))
        status, downloaded = self.get(f"/api/jobs/{job_id}/export?format=json")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(downloaded)["settings"], request)
        status, svg = self.get(f"/api/jobs/{job_id}/export?format=svg")
        self.assertEqual(status, 200)
        self.assertIn(b"<svg", svg)
        _, bad = self.job({**request, "unit_id": 99999})
        self.assertEqual(bad["status"], "error")

    def test_stable_selection_job_matches_verified_eligibility(self):
        _, job = self.job({"action": "stable_selection", "session_id": self.sid})
        self.assertEqual(job["status"], "done", job)
        result = job["result"]
        self.assertEqual(result["kind"], "stable_selection")
        self.assertEqual(result["session_id"], self.sid)
        loaded = self.app.store.get(self.sid)
        units = {u["id"]: u for u in loaded.units}
        self.assertTrue(result["unit_ids"])
        self.assertTrue(all(units[i]["quality"].lower() in ("sua", "mua") for i in result["unit_ids"]))
        eligible, _ = loaded.eligibility(result["unit_ids"], "verified_stable")
        self.assertEqual(set(result["trial_ids"]), eligible)
        self.assertEqual(result["coverage"], len(result["unit_ids"]) * len(eligible))

    def test_foreign_origin_host_and_unknown_paths_rejected(self):
        self.assertEqual(self.get("/api/catalog", headers={"Host": "attacker.test"})[0], 403)
        self.assertEqual(self.get("/api/jobs", "POST", {"action": "load", "session_id": self.sid}, {"Origin": "https://attacker.test"})[0], 403)
        self.assertEqual(self.get("/../../pyproject.toml")[0], 404)
        self.assertEqual(self.get("/api/jobs/missing")[0], 404)
        self.assertEqual(self.get("/api/jobs", "POST", {"action": "unknown"})[0], 400)


    def test_health_names_this_process_and_restart_stops_serving(self):
        status, data = self.get("/api/health")
        self.assertEqual(status, 200)
        health = json.loads(data)
        self.assertEqual((health["boot"], health["pid"]), (server_module.BOOT_ID, os.getpid()))
        self.assertIsInstance(health["code_changed"], list)
        self.assertEqual(self.get("/api/restart", "POST")[0], 400)  # a JSON body is required, as for every POST
        self.assertTrue(self.thread.is_alive())
        status, data = self.get("/api/restart", "POST", {})
        self.assertEqual(status, 202, data)
        self.assertEqual(json.loads(data), {"restarting": True, "boot": server_module.BOOT_ID})
        self.thread.join(5)
        self.assertFalse(self.thread.is_alive())  # stopped serving; cli.run does the re-exec
        self.assertTrue(self.server.restart_requested)

    def test_code_changed_since_lists_python_files_newer_than_the_start(self):
        self.assertIn("electro_gui/server.py", code_changed_since(0))
        self.assertEqual(code_changed_since(time.time() + 3600), [])


class _StoppedServer:
    """make_server stand-in: serve_forever returns at once, as after POST /api/restart."""

    def __init__(self, restart):
        self.server_address, self.restart_requested = ("127.0.0.1", 43210), restart

    def serve_forever(self, poll_interval):
        pass

    def server_close(self):
        pass


class RestartHandoverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        os.environ.pop(cli.RESTART_ENV, None)
        self.addCleanup(os.environ.pop, cli.RESTART_ENV, None)

    def run_cli(self, args):
        with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(cli, "_lan_addresses", return_value=[]):
            cli.run(args)

    def args(self, *extra):
        return cli.add_arguments(argparse.ArgumentParser()).parse_args(
            ["--data-root", self.temp.name, "--cache-dir", self.temp.name,
             "--findings-dir", str(Path(self.temp.name) / "f"), "--port", "0", *extra])

    def test_a_requested_restart_reexecs_the_same_command_on_the_same_port_and_token(self):
        # A random LAN token must survive the restart, or every phone would be locked out.
        with mock.patch("electro_gui.server.make_server", return_value=_StoppedServer(True)) as make, \
                mock.patch("webbrowser.open"), mock.patch("os.closerange"), mock.patch("os.execve") as execve:
            self.run_cli(self.args("--host", "0.0.0.0", "--no-browser"))
        token = make.call_args.kwargs["token"]
        self.assertTrue(token)
        exe, argv, env = execve.call_args.args
        self.assertEqual(exe, sys.executable)
        self.assertEqual(argv, [sys.executable, *sys.orig_argv[1:]])
        self.assertEqual(json.loads(env[cli.RESTART_ENV]), {"port": 43210, "token": token})

    def test_no_restart_means_no_reexec(self):
        with mock.patch("electro_gui.server.make_server", return_value=_StoppedServer(False)), \
                mock.patch("os.execve") as execve:
            self.run_cli(self.args("--no-browser"))
        execve.assert_not_called()

    def test_the_restarted_process_takes_over_port_and_token_and_opens_no_browser(self):
        os.environ[cli.RESTART_ENV] = json.dumps({"port": 4321, "token": "tok"})
        with mock.patch("electro_gui.server.make_server", return_value=_StoppedServer(False)) as make, \
                mock.patch("webbrowser.open") as browser, mock.patch("os.execve"):
            self.run_cli(self.args())
        self.assertEqual((make.call_args.kwargs["port"], make.call_args.kwargs["token"]), (4321, "tok"))
        browser.assert_not_called()
        self.assertNotIn(cli.RESTART_ENV, os.environ)  # not inherited by anything it starts

    def test_an_explicit_token_wins_over_the_handed_over_one(self):
        os.environ[cli.RESTART_ENV] = json.dumps({"port": 4321, "token": "old"})
        with mock.patch("electro_gui.server.make_server", return_value=_StoppedServer(False)) as make:
            self.run_cli(self.args("--token", "fixed"))
        self.assertEqual(make.call_args.kwargs["token"], "fixed")


if __name__ == "__main__":
    unittest.main()
