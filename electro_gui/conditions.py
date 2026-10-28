"""Typed recipe validation and event conditioning for :mod:`electro_gui`.

The functions in this module are deliberately free of file-reading or plotting code.  A
``LoadedSession`` supplies JSON-like rows and a field registry; this module
validates a recipe, applies it, and records every exclusion.
"""
from __future__ import annotations

import math
from collections import Counter
from typing import Any, Mapping, Sequence

OPERATORS = {"eq", "ne", "in", "not_in", "gt", "gte", "lt", "lte", "between", "present", "missing"}
_NUMERIC = {"number", "integer"}
_OPERATORS_BY_TYPE = {
    "category": {"eq", "ne", "in", "not_in", "present", "missing"},
    "boolean": {"eq", "ne", "in", "not_in", "present", "missing"},
    "number": {"eq", "ne", "in", "not_in", "gt", "gte", "lt", "lte", "between", "present", "missing"},
    "integer": {"eq", "ne", "in", "not_in", "gt", "gte", "lt", "lte", "between", "present", "missing"},
}


def missing(value: Any) -> bool:
    return value is None or value == "" or (isinstance(value, float) and not math.isfinite(value))


def _field_map(loaded: Any = None) -> dict[str, Mapping[str, Any]]:
    fields = getattr(loaded, "fields", None) or []
    out: dict[str, Mapping[str, Any]] = {}
    for f in fields:
        if isinstance(f, Mapping) and f.get("key"):
            out[str(f["key"])] = f
    if not out and loaded is not None:
        rows = getattr(loaded, "rows", []) or []
        for key in {k for row in rows for k in row}:
            vals = [row.get(key) for row in rows if not missing(row.get(key))]
            if vals and all(isinstance(v, bool) for v in vals): typ = "boolean"
            elif vals and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals): typ = "number"
            else: typ = "category"
            out[key] = {"key": key, "type": typ, "values": sorted(set(vals), key=str) if typ == "category" else None}
    return out


def group_value(row: Mapping[str, Any], field: str, recipe: Mapping[str, Any] | None = None) -> Any:
    """Return a display/group label while preserving the source value.

    Numeric fields require ``recipe['group_bins'][field]``.  Edges define
    ``[left, right)`` intervals, except the final interval includes its upper
    edge.  Values below the first edge, above the last edge, and nonfinite or
    missing values return ``None`` (they remain available in the raw row).
    """
    value = row.get(field)
    bins = (recipe or {}).get("group_bins", {}).get(field)
    if not bins:
        return value
    if missing(value):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    for index in range(len(bins) - 1):
        left, right = float(bins[index]), float(bins[index + 1])
        if left <= number < right or (index == len(bins) - 2 and number == right):
            left_text = str(bins[index])
            right_text = str(bins[index + 1])
            close = "]" if index == len(bins) - 2 else ")"
            return f"[{left_text}, {right_text}{close}"
    return None


def _valid_value(field: Mapping[str, Any], value: Any) -> bool:
    if missing(value):
        return False
    typ = field.get("type", "category")
    if typ in _NUMERIC:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) and (typ != "integer" or float(value).is_integer())
    if typ == "boolean":
        return isinstance(value, bool)
    if not isinstance(value, str):
        return False
    values = field.get("values")
    return isinstance(values, (list, tuple)) and value in values


def validate_group(group: Any, label: str, fields: Mapping[str, Mapping[str, Any]], *, require_rules=False) -> list[str]:
    if not isinstance(group, Mapping) or group.get("mode") not in {"all", "any"} or not isinstance(group.get("rules"), list):
        return [f"{label}: requires mode all/any and a rules array."]
    rules = group["rules"]
    errors: list[str] = []
    if (require_rules or group["mode"] == "any") and not rules:
        errors.append(f"{label}: add at least one explicit condition.")
    for i, rule in enumerate(rules):
        where = f"{label}, condition {i + 1}"
        if not isinstance(rule, Mapping) or rule.get("field") not in fields:
            errors.append(f"{where}: unknown field.")
            continue
        field = fields[rule["field"]]
        if field.get("availability", "available") != "available":
            errors.append(f"{where}: {rule['field']} is unavailable.")
        op = rule.get("op")
        if op not in OPERATORS:
            errors.append(f"{where}: invalid operator.")
            continue
        if op in {"present", "missing"}:
            continue
        typ = field.get("type", "category")
        if op not in _OPERATORS_BY_TYPE.get(typ, set()):
            errors.append(f"{where}: operator {op!r} is incompatible with {typ} fields.")
            continue
        value = rule.get("value")
        if op in {"in", "not_in", "between"}:
            if not isinstance(value, list) or not value or not all(_valid_value(field, v) for v in value):
                errors.append(f"{where}: provide a nonempty array of typed values.")
            elif op == "between" and (len(value) != 2 or value[0] >= value[1]):
                errors.append(f"{where}: between requires two ascending finite endpoints.")
        elif not _valid_value(field, value):
            errors.append(f"{where}: invalid {typ} value.")
    return errors


def validate(recipe: Any, loaded: Any = None) -> list[str]:
    if recipe is None:
        return []
    if not isinstance(recipe, Mapping):
        return ["Recipe is required."]
    if recipe.get("enabled") is False:
        return []
    fields = _field_map(loaded)
    group_bins = recipe.get("group_bins", {})
    if group_bins is None:
        group_bins = {}
    if not isinstance(group_bins, Mapping):
        return ["group_bins must be an object mapping numeric fields to bin edges."]
    for field_key, edges in group_bins.items():
        if field_key not in fields:
            errors = [f"group_bins references unknown field {field_key!r}."]
            return errors
        if fields[field_key].get("type") not in _NUMERIC:
            errors = [f"group_bins field {field_key!r} must be numeric."]
            return errors
        if not isinstance(edges, list) or len(edges) < 2 or not all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(float(x)) for x in edges) or any(float(a) >= float(b) for a, b in zip(edges, edges[1:])):
            errors = [f"group_bins for {field_key!r} must contain at least two finite strictly ascending edges."]
            return errors
    shared = recipe.get("shared", {"mode": "all", "rules": []})
    errors = validate_group(shared, "Shared conditions", fields)
    cohorts = recipe.get("cohorts")
    if not isinstance(cohorts, list) or not cohorts:
        errors.append("At least one explicit cohort is required.")
        cohorts = []
    ids: set[str] = set()
    for i, cohort in enumerate(cohorts):
        if not isinstance(cohort, Mapping) or not isinstance(cohort.get("id"), str) or not cohort["id"].strip() or cohort["id"] in ids:
            errors.append(f"Cohort {i + 1}: a unique nonempty ID is required.")
        else:
            ids.add(cohort["id"])
        if not isinstance(cohort, Mapping) or not isinstance(cohort.get("name"), str) or not cohort["name"].strip():
            errors.append(f"Cohort {i + 1}: a name is required.")
        errors.extend(validate_group(cohort, f"Cohort {i + 1}", fields, require_rules=True))
    for key, default in (("facet", "none"), ("group_by", "cohort"), ("split_by", "none")):
        value = recipe.get(key, default)
        if value != default and (value not in fields or fields[value].get("availability", "available") != "available"):
            errors.append(f"{key} must be an available field or {default}.")
        elif value != default and fields[value].get("type") in _NUMERIC and value not in group_bins:
            errors.append(f"{key} numeric field {value!r} requires explicit group_bins edges.")
    if recipe.get("overlap", "exclude") not in {"exclude", "allow"}:
        errors.append("Overlap policy must be exclude or allow.")
    if recipe.get("strata", "none") not in {"none", "trial", "task"}:
        errors.append("Common support must be none, trial, or task.")
    if recipe.get("strata", "none") != "none" and len(cohorts) < 2:
        errors.append("Common support requires at least two cohorts.")
    if recipe.get("gate", "none") not in {"none", "before_trial_end"}:
        errors.append("Unknown temporal gate.")
    return errors


def _rule(row: Mapping[str, Any], rule: Mapping[str, Any], fields: Mapping[str, Mapping[str, Any]]) -> bool:
    value = row.get(rule.get("field"))
    op = rule.get("op")
    if op == "missing":
        return missing(value)
    if op == "present":
        return not missing(value)
    if missing(value) or rule.get("field") not in fields or not _valid_value(fields[rule["field"]], value):
        return False
    target = rule.get("value")
    if op == "eq": return value == target
    if op == "ne": return value != target
    if op == "in": return value in target
    if op == "not_in": return value not in target
    if op == "gt": return value > target
    if op == "gte": return value >= target
    if op == "lt": return value < target
    if op == "lte": return value <= target
    if op == "between": return target[0] <= value <= target[1]
    return False


def _group(row: Mapping[str, Any], group: Mapping[str, Any], fields: Mapping[str, Mapping[str, Any]]) -> bool:
    vals = [_rule(row, r, fields) for r in group.get("rules", [])]
    return all(vals) if group.get("mode") == "all" else any(vals)


def select(rows: Sequence[Mapping[str, Any]], recipe: Mapping[str, Any] | None, loaded: Any = None) -> dict[str, Any]:
    """Apply a recipe and return selected copied rows plus an exclusion ledger."""
    rows = list(rows)
    if recipe is None:
        return {"rows": rows, "summary": {"input_events": len(rows), "selected_events": len(rows), "unique_events": len(rows)}, "errors": []}
    errors = validate(recipe, loaded)
    summary: dict[str, Any] = {"input_events": len(rows), "shared_events": 0, "shared_excluded": 0,
        "missing_rule_events": 0, "overlap_events_before_policy": 0, "overlap_excluded": 0,
        "gate_excluded": 0, "gate_missing_endpoint": 0, "strata_excluded": 0, "common_strata": [],
        "selected_events": 0, "unique_events": 0, "cohorts": []}
    if errors:
        return {"rows": [], "summary": summary, "errors": errors}
    if recipe.get("enabled") is False:
        summary.update(shared_events=len(rows), selected_events=len(rows), unique_events=len(rows), disabled=True)
        return {"rows": rows, "summary": summary, "errors": []}
    fields = _field_map(loaded)
    shared = recipe.get("shared", {"mode": "all", "rules": []})
    cohorts = recipe["cohorts"]
    shared_rows = [r for r in rows if _group(r, shared, fields)]
    summary["shared_events"], summary["shared_excluded"] = len(shared_rows), len(rows) - len(shared_rows)
    rules = shared.get("rules", []) + [rule for c in cohorts for rule in c.get("rules", [])]
    summary["missing_rule_events"] = sum(any(missing(r.get(rule["field"])) and rule.get("op") not in {"missing", "present"} for rule in rules) for r in rows)
    memberships = [{"row": r, "cohorts": [c for c in cohorts if _group(r, c, fields)]} for r in shared_rows]
    summary["cohort_excluded"] = sum(not m["cohorts"] for m in memberships)
    memberships = [m for m in memberships if m["cohorts"]]
    summary["overlap_events_before_policy"] = sum(len(m["cohorts"]) > 1 for m in memberships)
    if recipe.get("overlap", "exclude") == "exclude":
        summary["overlap_excluded"] = summary["overlap_events_before_policy"]
        memberships = [m for m in memberships if len(m["cohorts"]) == 1]
    gate = recipe.get("gate", "none")
    window = recipe.get("window") or recipe.get("count_window")
    if gate != "none":
        if not isinstance(window, (list, tuple)) or len(window) != 2 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in window):
            return {"rows": [], "summary": summary, "errors": ["A finite count window is required for a temporal gate."]}
        endpoint = "trial_end_t"
        kept = []
        for m in memberships:
            r = m["row"]
            end = r.get(endpoint)
            if missing(end): summary["gate_missing_endpoint"] += 1; summary["gate_excluded"] += 1; continue
            if missing(r.get("t")) or r["t"] + float(window[1]) > end:
                summary["gate_excluded"] += 1; continue
            kept.append(m)
        memberships = kept
    strata = recipe.get("strata", "none")
    if strata != "none":
        strata_sets: dict[Any, set[str]] = {}
        field = "trial" if strata == "trial" else "task"
        for m in memberships:
            value = m["row"].get(field, m["row"].get("trial_index") if field == "trial" else None)
            if missing(value): continue
            strata_sets.setdefault(value, set()).update(c["id"] for c in m["cohorts"])
        common = {v for v, ids in strata_sets.items() if all(c["id"] in ids for c in cohorts)}
        summary["common_strata"] = sorted(common, key=lambda x: (type(x).__name__, x))
        kept = []
        for m in memberships:
            value = m["row"].get(field, m["row"].get("trial_index") if field == "trial" else None)
            if value in common: kept.append(m)
            else: summary["strata_excluded"] += 1
        memberships = kept
    selected = []
    facet = recipe.get("facet", "none")
    for m in memberships:
        for c in m["cohorts"]:
            raw_value = None if facet == "none" else m["row"].get(facet)
            value = None if facet == "none" else group_value(m["row"], facet, recipe)
            facet_key = "none" if facet == "none" else f"{facet}:{value!r}"
            out = dict(m["row"], cohort=c["id"], cohort_name=c["name"], facet_key=facet_key,
                       facet_value=value, facet_raw_value=raw_value, group=c["id"], group_label=c["name"])
            selected.append(out)
    summary["selected_events"] = len(selected); summary["unique_events"] = len(memberships)
    for c in cohorts:
        cr = [r for r in selected if r["cohort"] == c["id"]]
        summary["cohorts"].append({"id": c["id"], "name": c["name"], "events": len(cr),
            "trials": len({r.get("trial", r.get("trial_index")) for r in cr if not missing(r.get("trial", r.get("trial_index"))) }),
            "blocks": len({r.get("block_id") for r in cr if not missing(r.get("block_id"))})})
    return {"rows": selected, "summary": summary, "errors": []}


#: Task order for cohorts and legends (static/core.js LEVEL_ORDER.task).
TASK_ORDER = ("fixation", "memory_saccade", "pursuit", "pursuit_memory", "overlap_saccade", "reveal", "freeview")


def default_recipe(loaded: Any = None) -> dict[str, Any]:
    """One cohort per task: the tasks the session's ``task`` field lists, else the main ones."""
    field = _field_map(loaded).get("task") if loaded is not None else None
    tasks = [str(v) for v in (field or {}).get("values") or []] if field else []
    if not tasks:
        tasks = ["memory_saccade", "pursuit", "pursuit_memory"]
    tasks.sort(key=lambda t: (TASK_ORDER.index(t) if t in TASK_ORDER else len(TASK_ORDER), t))
    cohorts = [{"id": t, "name": t.replace("_", " "), "mode": "all", "rules": [{"field": "task", "op": "eq", "value": t}]}
               for t in tasks]
    return {"shared": {"mode": "all", "rules": []}, "cohorts": cohorts,
            "facet": "none", "group_by": "cohort", "split_by": "none", "overlap": "exclude", "strata": "none", "gate": "none"}
