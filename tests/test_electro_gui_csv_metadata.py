import csv
import io
import json
import unittest

from electro_gui.exports import export_csv, export_membership, export_statistics


def _result(kind):
    provenance = {"computation_identity": {"source": {"sha256": "abc123"}}}
    annotations = {"layers": [{"id": "target", "kind": "event", "name": "Target on", "event": "stimuli_on"}], "provenance": {"source": "loaded session event table"}}
    if kind == "unit":
        return {"kind": "unit", "session_id": "s", "unit": {"id": 3}, "times": [0.0], "groups": [{"label": "A", "mean": [1.0], "sem": [0.1], "trials": 2, "blocks": 1}], "rows": [{"row_id": 1, "group": "A", "annotation_ticks": {"target": [0.1]}}], "statistics": {"status": "not_run"}, "provenance": provenance, "annotations": annotations}
    return {"kind": "population", "session_id": "s", "components": 2, "times": [0.0], "groups": [{"label": "all", "coordinates": [[1.0, 2.0]]}], "rows": [{"row_id": 1, "group": "all"}], "diagnostics": {"method": "pca"}, "unit_ids": [1, 2], "provenance": provenance, "annotations": annotations}


class ElectroGuiCsvMetadata(unittest.TestCase):
    def _assert_annotation_columns(self, payload):
        row = next(csv.DictReader(io.StringIO(payload.decode())))
        self.assertEqual(json.loads(row["annotation_layers_json"])[0]["id"], "target")
        self.assertEqual(json.loads(row["annotation_provenance_json"])["source"], "loaded session event table")
        self.assertEqual(json.loads(row["annotation_source_identity_json"])["sha256"], "abc123")

    def test_unit_and_population_curve_csvs_append_metadata(self):
        self._assert_annotation_columns(export_csv(_result("unit")))
        self._assert_annotation_columns(export_csv(_result("population")))

    def test_membership_and_statistics_append_metadata(self):
        for kind in ("unit", "population"):
            result = _result(kind)
            self._assert_annotation_columns(export_membership(result))
            self._assert_annotation_columns(export_statistics(result))

    def test_unannotated_curve_schema_is_unchanged(self):
        result = _result("unit")
        result.pop("annotations")
        header = export_csv(result).decode().splitlines()[0]
        self.assertEqual(header, "session_id,unit_id,group,time_s,mean_hz,sem_hz,trials,blocks,source_sha256")


if __name__ == "__main__":
    unittest.main()
