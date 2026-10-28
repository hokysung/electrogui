"""Display-only event and interval annotations for completed GUI results.

Annotations are deliberately evaluated after membership and numerical results have
been produced.  They never participate in selection, counts, tests, or model fits.
Only recorded event rows from the loaded session are accepted here.
"""
from __future__ import annotations

import copy
import math
from collections import defaultdict
from typing import Any, Mapping, Sequence


KINDS = {"reference", "event", "interval"}
MATCHES = {"same_trial"}
OCCURRENCES = {"first", "last", "all"}


def _finite(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def validate_layers(layers: Any) -> list[str]:
    if layers is None:
        return []
    if not isinstance(layers, list):
        return ["annotations.layers must be an array."]
    errors: list[str] = []
    ids: set[str] = set()
    for i, layer in enumerate(layers):
        where = f"Annotation {i + 1}"
        if not isinstance(layer, Mapping):
            errors.append(f"{where} must be an object.")
            continue
        lid = layer.get("id")
        if not isinstance(lid, str) or not lid.strip() or lid in ids:
            errors.append(f"{where} requires a unique nonempty id.")
        else:
            ids.add(lid)
        kind = layer.get("kind")
        if kind not in KINDS:
            errors.append(f"{where} kind must be reference, event, or interval.")
        if not isinstance(layer.get("name", lid), str) or not str(layer.get("name", lid)).strip():
            errors.append(f"{where} requires a name.")
        source = layer.get("source", "recorded_events")
        if source != "recorded_events":
            errors.append(f"{where} source must be recorded_events; detected bouts are unavailable in this GUI.")
        if kind == "reference":
            if not _finite(layer.get("time")):
                errors.append(f"{where} reference time must be finite.")
            continue
        if layer.get("match", "same_trial") not in MATCHES:
            errors.append(f"{where} match must be same_trial.")
        if layer.get("occurrence", "all") not in OCCURRENCES:
            errors.append(f"{where} occurrence must be first, last, or all.")
        if kind == "event" and not isinstance(layer.get("event"), str):
            errors.append(f"{where} requires an event name.")
        if kind == "interval":
            if not isinstance(layer.get("onset"), str) or not isinstance(layer.get("offset"), str):
                errors.append(f"{where} requires onset and offset event names.")
    return errors


def _valid_source(row: Mapping[str, Any]) -> bool:
    return (_finite(row.get("t")) and row.get("within_ephys_recording", True) is not False
            and row.get("within_sync_fit_window", True) is not False)


def _identity(anchor: Mapping[str, Any], candidate: Mapping[str, Any], match: str):
    trial = anchor.get("trial", anchor.get("trial_index"))
    other_trial = candidate.get("trial", candidate.get("trial_index"))
    if trial is None or other_trial is None or trial != other_trial:
        return None
    return (trial,)


def _candidates(loaded: Any, anchor: Mapping[str, Any], event: str, match: str, index=None) -> list[Mapping[str, Any]]:
    rows = []
    source = (index or {}).get(event, getattr(loaded, "rows", []) or [])
    for row in source:
        if row.get("event") == event and _valid_source(row) and _identity(anchor, row, match) is not None:
            rows.append(row)
    rows.sort(key=lambda row: (float(row["t"]), int(row.get("row_id", 0))))
    return rows


def _pair_intervals(loaded, anchor, layer, index):
    """Pair endpoints within an identity, rejecting repeated/unmatched edges."""
    match, occurrence = layer.get("match", "same_trial"), layer.get("occurrence", "all")
    on = _candidates(loaded, anchor, layer["onset"], match, index)
    off = _candidates(loaded, anchor, layer["offset"], match, index)
    combined = [(float(x["t"]), "on", x) for x in on] + [(float(x["t"]), "off", x) for x in off]
    if not combined:
        return [], 0, 1
    groups = defaultdict(list)
    for t, kind, row in combined:
        groups[row.get("trial", row.get("trial_index"))].append((t, kind, row))
    pairs, ambiguous, missing_count = [], 0, 0
    for events in groups.values():
        events.sort(key=lambda x: (x[0], x[1] != "on", int(x[2].get("row_id", 0))))
        pending = None
        invalid = False
        for t, kind, row in events:
            if kind == "on":
                if pending is not None:
                    ambiguous += 1
                    invalid = True
                    pending = None
                    continue
                pending = (t, row)
            elif pending is None:
                missing_count += 1
            else:
                if not invalid:
                    pairs.append((pending[0], t, pending[1], row))
                pending = None
        if pending is not None:
            missing_count += 1
        if invalid:
            bad_ids = {event[2].get("row_id") for event in events}
            pairs = [pair for pair in pairs if pair[2].get("row_id") not in bad_ids and pair[3].get("row_id") not in bad_ids]
    pairs.sort(key=lambda x: (x[0], int(x[2].get("row_id", 0))))
    if occurrence == "first": pairs = pairs[:1]
    elif occurrence == "last": pairs = pairs[-1:] if pairs else []
    return pairs, ambiguous, missing_count


def _occurrence(rows: list[Mapping[str, Any]], occurrence: str) -> list[Mapping[str, Any]]:
    if occurrence == "first":
        return rows[:1]
    if occurrence == "last":
        return rows[-1:] if rows else []
    return rows


def _clip_interval(start: float, stop: float, lo: float, hi: float):
    if stop <= start:
        return None, "ambiguous"
    clipped = start < lo or stop > hi
    value = [max(lo, start), min(hi, stop)]
    if value[1] <= value[0]:
        return None, "outside"
    return {"onset": value[0], "offset": value[1], "raw_onset": start, "raw_offset": stop,
            "clipped": clipped}, "clipped" if clipped else "ok"


def _aggregate(layers, row_values, settings):
    lo = float(settings.get("pre", -1)) if isinstance(settings, Mapping) else -1.0
    hi = float(settings.get("post", 1)) if isinstance(settings, Mapping) else 1.0
    out = {}
    for layer in layers:
        vals = [per_row.get(layer["id"], {"ticks": [], "intervals": []}) for per_row in row_values.values()]
        if layer["kind"] == "reference":
            out[layer["id"]] = {"kind": "reference", "time": layer.get("time"), "weighting": "fixed reference"}
        elif layer["kind"] == "event":
            times = [float(v) for value in vals for v in value.get("ticks", [])]
            out[layer["id"]] = {"kind": "event", "times": times,
                "n_rows": len(vals), "valid_rows": sum(bool(value.get("ticks")) for value in vals),
                "weighting": "pooled event occurrences; repeated occurrences each contribute one event"}
        else:
            per_row_intervals = [value.get("intervals", []) for value in vals]
            intervals = [v for values in per_row_intervals for v in values]
            n = 100
            occupancy = []
            for i in range(n):
                a, b = lo + (hi - lo) * i / n, lo + (hi - lo) * (i + 1) / n
                occupied = 0.0
                for row_intervals in per_row_intervals:
                    spans = sorted((max(a, x["onset"]), min(b, x["offset"])) for x in row_intervals if x["offset"] > a and x["onset"] < b)
                    merged = []
                    for start, stop in spans:
                        if not merged or start > merged[-1][1]:
                            merged.append([start, stop])
                        else:
                            merged[-1][1] = max(merged[-1][1], stop)
                    occupied += sum(stop - start for start, stop in merged)
                occupancy.append(occupied / max(1, len(vals)) / max(b - a, 1e-12))
            out[layer["id"]] = {"kind": "interval", "intervals": intervals, "n_rows": len(vals),
                "occupancy": {"edges": [lo + (hi - lo) * i / n for i in range(n + 1)], "fraction": occupancy,
                              "weighting": "equal selected-row weighting; exact intervals remain per row"}}
    return out


def annotate_result(result: Mapping[str, Any], loaded: Any, layers: Sequence[Mapping[str, Any]] | None):
    """Return a cloned result with validated display overlays and provenance."""
    errors = validate_layers(layers or [])
    if errors:
        raise ValueError("; ".join(errors))
    layers = [dict(layer, source=layer.get("source", "recorded_events"), visible=bool(layer.get("visible", True))) for layer in (layers or [])]
    available_events = {row.get("event") for row in getattr(loaded, "rows", []) or [] if row.get("event")}
    unknown = []
    for layer in layers:
        for key in (("event",) if layer.get("kind") == "event" else ("onset", "offset") if layer.get("kind") == "interval" else ()):
            if layer.get(key) not in available_events:
                unknown.append(f"{layer.get('id')}: unknown recorded event {layer.get(key)!r}")
    if unknown:
        raise ValueError("; ".join(unknown))
    settings = result.get("settings", {})
    lo, hi = float(settings.get("pre", -1)), float(settings.get("post", 1))
    rows_by_id = {str(row.get("row_id")): row for row in getattr(loaded, "rows", []) or []}
    row_values: dict[str, dict[str, Any]] = defaultdict(dict)
    index = defaultdict(list)
    for source_row in getattr(loaded, "rows", []) or []:
        if _valid_source(source_row) and source_row.get("event"):
            index[source_row["event"]].append(source_row)
    summaries = {layer["id"]: {"coverage": 0, "missing": 0, "ambiguous": 0, "clipped": 0} for layer in layers}
    cloned = copy.deepcopy(dict(result))
    cloned_rows = cloned.get("rows", [])
    for output_row in cloned_rows:
        rid = str(output_row.get("row_id"))
        anchor = rows_by_id.get(rid, output_row)
        per_layer = {}
        for layer in layers:
            lid, kind = layer["id"], layer["kind"]
            if kind == "reference":
                t = float(layer["time"])
                per_layer[lid] = {"ticks": [t] if lo <= t <= hi else [], "intervals": []}
                if lo <= t <= hi: summaries[lid]["coverage"] += 1
                continue
            match, occurrence = layer.get("match", "same_trial"), layer.get("occurrence", "all")
            if kind == "event":
                candidates = _occurrence(_candidates(loaded, anchor, layer["event"], match, index), occurrence)
                ticks = [float(row["t"]) - float(anchor["t"]) for row in candidates if lo <= float(row["t"]) - float(anchor["t"]) <= hi]
                per_layer[lid] = {"ticks": ticks, "tick_records": [{"time": t, "row_id": c.get("row_id"), "trial": c.get("trial")} for t, c in [(float(x["t"]) - float(anchor["t"]), x) for x in candidates] if lo <= t <= hi], "intervals": []}
                if ticks: summaries[lid]["coverage"] += 1
                elif candidates: summaries[lid]["clipped"] += 1
                else: summaries[lid]["missing"] += 1
                continue
            pairs, pair_ambiguous, pair_missing = _pair_intervals(loaded, anchor, layer, index)
            intervals = []
            summaries[lid]["ambiguous"] += pair_ambiguous
            summaries[lid]["missing"] += pair_missing
            for start, stop, start_row, stop_row in pairs:
                interval, state = _clip_interval(start - float(anchor["t"]), stop - float(anchor["t"]), lo, hi)
                if interval is not None:
                    interval.update({"onset_row_id": start_row.get("row_id"), "offset_row_id": stop_row.get("row_id"), "trial": start_row.get("trial")})
                    intervals.append(interval)
                if state in ("clipped", "outside"): summaries[lid]["clipped"] += 1
                elif state == "ambiguous": summaries[lid]["ambiguous"] += 1
            per_layer[lid] = {"ticks": [], "tick_records": [], "intervals": intervals}
            if intervals: summaries[lid]["coverage"] += 1
        output_row["annotation_ticks"] = {lid: v["ticks"] for lid, v in per_layer.items()}
        output_row["annotation_tick_records"] = {lid: v.get("tick_records", []) for lid, v in per_layer.items()}
        output_row["annotation_intervals"] = {lid: v["intervals"] for lid, v in per_layer.items()}
        row_values[rid] = per_layer
    cloned["annotations"] = {"schema": 1, "layers": layers, "rows": row_values,
                              "summary": {"layers": summaries, "aggregates": _aggregate(layers, row_values, settings),
                                          "selected_rows": len(cloned_rows), "unique_anchor_rows": len(row_values),
                                          "coverage_unit": "selected membership rows with a visible annotation",
                                          "endpoint_diagnostics_unit": "endpoint problems accumulated over selected membership rows",
                                          "source": "recorded_events", "detected_bouts": "unavailable: GUI v0.1 does not derive continuous movement bouts"},
                              "provenance": {"source": "loaded session event table", "membership_unchanged": True,
                                             "counts_tests_model_unchanged": True}}
    cloned["settings"] = copy.deepcopy(result.get("settings", {}))
    cloned["settings"]["annotations"] = copy.deepcopy(layers)
    cloned["provenance"]["annotation"] = {"schema": 1, "module": "electro_gui.annotations",
                                           "source": "recorded_events", "display_only": True,
                                           "computation_identity_unchanged": True}
    return cloned
