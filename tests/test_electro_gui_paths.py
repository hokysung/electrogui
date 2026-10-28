"""Where the explorer keeps its cache and findings and finds sessions (electro_gui/paths.py, cli._folders, cli.default_roots)."""
import argparse
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from electro_gui import cli, paths


def _env(**values):
    """os.environ without the variables the resolvers read, plus ``values``."""
    env = {k: v for k, v in os.environ.items() if k not in (paths.OUTPUT_ENV, cli.ROOTS_ENV, "HOME")}
    return mock.patch.dict(os.environ, {**env, **values}, clear=True)


class PathsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_output_defaults_to_the_home_folder(self):
        with _env(HOME=str(self.root)):
            self.assertEqual(paths.output_root(), self.root / "electro_gui_output")

    def test_the_environment_replaces_the_output_folder(self):
        with _env(HOME=str(self.root), **{paths.OUTPUT_ENV: "/elsewhere/out"}):
            self.assertEqual(paths.output_root(), Path("/elsewhere/out"))

    def test_cli_defaults_are_under_the_output_folder_and_there_are_no_config_dirs(self):
        args = cli.add_arguments(argparse.ArgumentParser()).parse_args([])
        self.assertIsNone(args.cache_dir)
        self.assertIsNone(args.findings_dir)
        with _env(HOME=str(self.root), **{paths.OUTPUT_ENV: "/o"}):
            cache, findings, configs = cli._folders(args)
        self.assertEqual(cache, Path("/o/cache"))
        self.assertEqual(findings, Path("/o/findings"))
        self.assertEqual(configs, [])

    def test_flags_replace_the_defaults_one_folder_each(self):
        args = cli.add_arguments(argparse.ArgumentParser()).parse_args(
            ["--findings-dir", "f", "--config-dir", "c1", "--config-dir", "c2"])
        with _env(HOME=str(self.root)):
            cache, findings, configs = cli._folders(args)
        self.assertEqual(cache, self.root / "electro_gui_output" / "cache")
        self.assertEqual(findings, Path("f"))
        self.assertEqual(configs, ["c1", "c2"])

    def test_session_roots_come_from_the_environment_else_home(self):
        with _env(HOME=str(self.root)):
            self.assertEqual(cli.default_roots(), [str(self.root / "viewer_sessions")])
        with _env(HOME=str(self.root), **{cli.ROOTS_ENV: os.pathsep.join(["/a", "/b", ""])}):
            self.assertEqual(cli.default_roots(), ["/a", "/b"])


if __name__ == "__main__":
    unittest.main()
