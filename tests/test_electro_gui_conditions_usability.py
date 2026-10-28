import unittest

from electro_gui.conditions import group_value, select, validate, validate_group
from session_viewer.store import alignment_metadata, registry


class ElectroGuiConditionContract(unittest.TestCase):
    def setUp(self):
        self.rows = [
            {"event": "stimuli_on", "task": "memory_saccade", "microstim": False, "rewarded": True, "previous_task": None,
             "microstim_amplitude": 30.0, "t": 1.0, "trial": 1, "saccade_latency": None},
            {"event": "reward", "task": "pursuit", "microstim": True, "rewarded": None, "previous_task": "memory_saccade",
             "microstim_amplitude": None, "t": 2.0, "trial": 2, "saccade_latency": None},
        ]
        self.fields = {f["key"]: f for f in registry(self.rows)}

    def test_values_and_support_counts(self):
        task = self.fields["task"]
        self.assertEqual(task["values"], ["memory_saccade", "pursuit"])
        self.assertEqual(task["value_counts"], {"memory_saccade": 1, "pursuit": 1})
        self.assertEqual(task["missing_count"], 0)
        self.assertEqual(self.fields["microstim"]["type"], "boolean")
        self.assertEqual(self.fields["rewarded"]["missing_count"], 1)
        self.assertEqual(self.fields["previous_task"]["timing"], "previous_trial")

    def test_metadata_has_definitions_categories_units_ranges_and_grouping_policy(self):
        for key in ("task", "t", "microstim_amplitude"):
            field = self.fields[key]
            for required in ("description", "timing_description", "category", "value_counts", "missing_count", "cardinality", "grouping_eligible"):
                self.assertIn(required, field)
        self.assertEqual(self.fields["t"]["units"], "s")
        self.assertEqual(self.fields["t"]["range"], [1.0, 2.0])
        self.assertFalse(self.fields["t"]["grouping_eligible"])
        self.assertEqual(self.fields["saccade_latency"]["availability"], "unavailable")

    def test_validation_rejects_typos_and_incompatible_operators(self):
        self.assertEqual(validate_group({"mode": "all", "rules": [{"field": "task", "op": "eq", "value": "pursuit"}]}, "x", self.fields), [])
        self.assertTrue(validate_group({"mode": "all", "rules": [{"field": "task", "op": "eq", "value": "persuit"}]}, "x", self.fields))
        self.assertTrue(validate_group({"mode": "all", "rules": [{"field": "task", "op": "gt", "value": 1}]}, "x", self.fields))
        self.assertTrue(validate_group({"mode": "all", "rules": [{"field": "microstim", "op": "eq", "value": "yes"}]}, "x", self.fields))
        self.assertEqual(validate_group({"mode": "all", "rules": [{"field": "microstim", "op": "eq", "value": True}]}, "x", self.fields), [])
        self.assertEqual(validate_group({"mode": "all", "rules": [{"field": "t", "op": "between", "value": [0.0, 2.0]}]}, "x", self.fields), [])

    def test_alignment_metadata_is_grouped(self):
        # (session_viewer files stimuli_on under "stim": its stim keyword matches "stimuli"; the explorer
        # menus use static/explorer.js eventCategory instead, which keeps it under Stimulus.)
        entries = alignment_metadata(["fix_on", "microstim", "reward", "memory", "trial_start"])
        self.assertEqual([e["key"] for e in entries], ["fix_on", "microstim", "reward", "memory", "trial_start"])
        self.assertEqual([e["category"] for e in entries], ["eye", "stim", "reward", "stimulus", "trial"])
        self.assertEqual(set(entries[0]), {"key", "label", "category", "description"})

    def test_numeric_grouping_requires_valid_explicit_bins(self):
        loaded = type("Loaded", (), {"fields": list(self.fields.values())})()
        base = {"shared": {"mode": "all", "rules": []}, "cohorts": [{"id": "A", "name": "A", "mode": "all", "rules": [{"field": "task", "op": "eq", "value": "memory_saccade"}]}], "facet": "t"}
        self.assertTrue(any("requires explicit group_bins" in error for error in validate(base, loaded)))
        self.assertTrue(any("strictly ascending" in error for error in validate(dict(base, group_bins={"t": [0, 1, 1]}), loaded)))
        self.assertEqual(validate(dict(base, group_bins={"t": [1, 2]}), loaded), [])

    def test_numeric_group_boundaries_and_raw_values_are_preserved(self):
        recipe = {"group_bins": {"t": [0, 1, 2]}}
        self.assertEqual(group_value({"t": 0}, "t", recipe), "[0, 1)")
        self.assertEqual(group_value({"t": 1}, "t", recipe), "[1, 2]")
        self.assertIsNone(group_value({"t": 2.1}, "t", recipe))
        loaded = type("Loaded", (), {"fields": list(self.fields.values())})()
        full = dict(recipe, cohorts=[{"id": "A", "name": "A", "mode": "all", "rules": [{"field": "task", "op": "eq", "value": "memory_saccade"}]}], facet="t", shared={"mode": "all", "rules": []})
        result = select(self.rows, full, loaded)
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["rows"][0]["facet_value"], "[1, 2]")
        self.assertEqual(result["rows"][0]["facet_raw_value"], 1.0)
        self.assertEqual(result["rows"][0]["t"], 1.0)


if __name__ == "__main__":
    unittest.main()
