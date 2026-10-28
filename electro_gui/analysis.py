"""Descriptive unit analysis for the electro GUI.

All windows are seconds.  Event intervals and spike windows use half-open
``[lo, hi)`` semantics.  This module accepts the small ``LoadedSession``
interface documented in ``electro_gui/DESIGN.md`` and does not open files.
"""
from __future__ import annotations

import itertools
import math
import copy
from collections import defaultdict
from typing import Any, Mapping, Sequence

import numpy as np

from session_viewer.explorer_core import UNION_ALIGNMENTS, eligible_runs
from session_viewer.store import HIDDEN_EVENTS

from .conditions import default_recipe, group_value, missing, select, validate

#: Curve colours by level (static/explorer.js SEM): tasks, and stimulation on/off.
TASK_COLORS = {"fixation": "#495057", "memory_saccade": "#1971c2", "pursuit": "#2f9e44", "reveal": "#f08c00",
               "overlap_saccade": "#9c36b5", "freeview": "#868e96", "pursuit_memory": "#c2255c"}
STIM_COLORS = {"True": "#e8590c", "stim": "#e8590c", "False": "#495057", "sham": "#495057"}
COLORS = {**TASK_COLORS, **STIM_COLORS}
COLOR_KEYS = frozenset(COLORS)


def _finite(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(float(x))


def _trial_id(row: Mapping[str, Any]) -> Any:
    return row.get("trial", row.get("trial_index"))


def _eligibility(loaded: Any, unit_ids: Sequence[Any], policy: str) -> tuple[set[Any], dict[str, Any]]:
    got = loaded.eligibility(list(unit_ids), policy)
    if isinstance(got, tuple) and len(got) == 2:
        return set(got[0]), dict(got[1])
    return set(got), {"policy": policy, "unit_ids": list(unit_ids)}


def _trial_map(loaded: Any) -> dict[Any, Mapping[str, Any]]:
    return {t.get("id"): t for t in getattr(loaded, "trials", [])}


def _validate_settings(request: Mapping[str, Any]) -> tuple[float, float, float, float, float, float]:
    raw = [request.get(k) for k in ("pre", "post", "bin", "sigma")]
    window = request.get("count_window")
    if any(isinstance(v, bool) for v in raw) or (isinstance(window, (list, tuple)) and any(isinstance(v, bool) for v in window)):
        raise ValueError("Window and bin settings must be numbers, not booleans.")
    try:
        pre, post = float(request.get("pre")), float(request.get("post"))
        bin_, sigma = float(request.get("bin")), float(request.get("sigma", 0.0))
        lo, hi = map(float, request.get("count_window", request.get("test_window", (pre, post))))
    except (TypeError, ValueError, KeyError):
        raise ValueError("pre, post, bin, sigma, and count_window are required finite settings")
    if not all(math.isfinite(v) for v in (pre, post, bin_, sigma, lo, hi)) or not pre < post:
        raise ValueError("Display window must increase and contain finite values.")
    if bin_ not in (.025, .05, .1) or sigma < 0 or sigma > .1:
        raise ValueError("bin must be one of 0.025, 0.05, or 0.1 seconds; sigma must lie in [0, 0.1].")
    if pre < -10 or post > 10 or (post - pre) / bin_ > 2000:
        raise ValueError("Display window must lie within [-10, 10] seconds and contain at most 2000 bins.")
    if not pre <= lo < hi <= post:
        raise ValueError("Count window must increase and fit inside the display window.")
    n = (post - pre) / bin_
    if abs(n - round(n)) > 1e-8:
        raise ValueError("Display window width must be an integer number of bins.")
    return pre, post, bin_, sigma, lo, hi


def prepare_rows(loaded: Any, request: Mapping[str, Any], unit_ids: Sequence[Any]) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    """Select event rows using common unit support and a fixed padding guard."""
    pre, post, bin_, sigma, count_lo, count_hi = _validate_settings(request)
    policy = request.get("stability", "verified_stable")
    eligible, elig_prov = _eligibility(loaded, unit_ids, policy)
    trials = _trial_map(loaded)
    runs = eligible_runs(loaded, eligible)
    recipe = request.get("recipe")
    if recipe is None:
        recipe = default_recipe(loaded)
    if recipe.get("blocked_reason"):
        raise ValueError(str(recipe["blocked_reason"]))
    errors = validate(recipe, loaded)
    if errors:
        raise ValueError("; ".join(errors))
    alignment = request.get("alignment", "fix_on")
    if alignment not in UNION_ALIGNMENTS and alignment not in set(getattr(loaded, "alignments", []) or []):
        known = {r.get("event") for r in getattr(loaded, "rows", []) if r.get("event")} - HIDDEN_EVENTS
        if alignment not in known:
            raise ValueError(f"Unknown alignment: {alignment}")
    effective_recipe = copy.deepcopy(recipe)
    effective_recipe["window"] = [count_lo, count_hi]
    excluded = {"incomplete": 0, "unstable": 0, "invalid_event": 0, "filter": 0, "window": 0}
    candidates = []
    for row in getattr(loaded, "rows", []):
        event = row.get("event")
        if alignment in UNION_ALIGNMENTS:
            if event not in UNION_ALIGNMENTS[alignment]: continue
        elif event != alignment:
            continue
        tid = _trial_id(row); trial = trials.get(tid)
        if trial is None or trial.get("complete") is not True:
            excluded["incomplete"] += 1
            continue
        if tid not in eligible:
            excluded["unstable"] += 1
            continue
        t = row.get("t")
        if not _finite(t) or row.get("within_ephys_recording", True) is False or row.get("within_sync_fit_window", True) is False:
            excluded["invalid_event"] += 1
            continue
        good = False
        for a, b, _ in runs:
            if float(t) + pre - .4 >= max(a, 0.0) - 1e-9 and float(t) + post + .4 <= min(b, float(getattr(loaded, "duration_s", b))) + 1e-9:
                good = True; break
        if not good:
            excluded["window"] += 1
            continue
        candidates.append(dict(row, trial=tid, block_id=row.get("block_id", trial.get("block_id")), task=row.get("task", trial.get("task"))))
    chosen = select(candidates, effective_recipe, loaded)
    if chosen["errors"]:
        raise ValueError("; ".join(chosen["errors"]))
    rows = chosen["rows"]
    if recipe.get("enabled") is False:
        for row in rows:
            row.update(cohort="all", cohort_name="All eligible events", facet_key="none")
    recipe_for_style = recipe
    group_by = recipe_for_style.get("group_by", "cohort")
    split_by = recipe_for_style.get("split_by", "none")
    facet = recipe_for_style.get("facet", "none")
    for row in rows:
        value = group_value(row, group_by, recipe) if group_by != "cohort" else row.get("cohort_name", row.get("cohort"))
        split = None if split_by == "none" else group_value(row, split_by, recipe)
        facet_value = None if facet == "none" else group_value(row, facet, recipe)
        if facet != "none":
            row["facet_raw_value"] = row.get(facet)
        row["facet_value"] = facet_value
        row["color_key"] = str(value) if str(value) in COLOR_KEYS or group_by != "cohort" else str(row.get("cohort"))
        row["line_dashed"] = bool(split_by != "none" and split is False)
        row["group"] = repr((row.get("cohort"), row.get("facet_key", "none"), value, split))
        row["group_label"] = f"{row.get('cohort_name', row.get('cohort'))}" + ("" if facet == "none" else f" · {facet}={facet_value if facet_value is not None else 'missing'}") + ("" if group_by == "cohort" else f" · {value if value is not None else 'missing'}") + ("" if split_by == "none" else f" · {split if split is not None else 'missing'}")
    if len({r["group"] for r in rows}) > 24:
        raise ValueError("More than 24 curves; restrict the recipe.")
    if len({r.get("facet_key", "none") for r in rows}) > 8:
        raise ValueError("More than 8 facets; restrict the recipe.")
    order = {c["id"]: i for i, c in enumerate(recipe.get("cohorts", []))}
    rows.sort(key=lambda r: (str(r.get("facet_key")), order.get(r.get("cohort"), 0), bool(r.get("line_dashed")), str(r.get("group")), r["trial"], r["t"]))
    for row in rows:
        row["count"] = None; row["rate"] = None
        row.setdefault("cohort", row.get("group", "all")); row.setdefault("group", row["cohort"])
    support = dict(chosen["summary"])
    excluded["filter"] = support.get("shared_excluded", 0) + support.get("cohort_excluded", 0)
    support["excluded"] = excluded
    support.update({"eligible_trials": len(eligible), "runs": len(runs), "selected_trials": len({_trial_id(r) for r in rows}),
                    "selected_blocks": len({r.get("block_id") for r in rows if not missing(r.get("block_id"))})})
    provenance = {"eligibility": elig_prov, "policy": policy, "padding_guard_s": .4,
                  "recipe": effective_recipe, "unit_ids": list(unit_ids), "alignment": alignment,
                  "source": (getattr(loaded, "metadata", lambda: {})().get("source", {}) if callable(getattr(loaded, "metadata", None)) else {})}
    return rows, support, provenance


def _count(spikes: np.ndarray, center: float, lo: float, hi: float) -> int:
    return int(np.searchsorted(spikes, center + hi, side="left") - np.searchsorted(spikes, center + lo, side="left"))


def _group_label(row: Mapping[str, Any]) -> str:
    return str(row.get("group_label", row.get("cohort_name", row.get("group", "all"))))


def _infer(rows: list[dict[str, Any]], request: Mapping[str, Any], test: str) -> dict[str, Any]:
    base = {"name": test, "status": "not_run", "p_value": None, "q_value": None,
            "correction": "One requested comparison; no correction for exploration across windows, units, or recipes.",
            "scope": "Exploratory association; block exchangeability/symmetry assumptions are not established by this test."}
    if test == "none":
        return base

    def blocked(reason):
        return {**base, "status": "blocked", "reason": reason}

    recipe = request.get("recipe") or {}
    if any(recipe.get(k, default) != default for k, default in
           (("facet", "none"), ("split_by", "none"), ("group_by", "cohort"))):
        return blocked("Tests require cohort-only grouping with no facets or subdivisions; choose the exact A/B contrast first.")
    n = request.get("n_permutations", 5000)
    seed = request.get("seed", 0)
    if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= 100000:
        return blocked("n_permutations must be an integer in 1..100000.")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**32:
        return blocked("seed must be an integer in 0..2**32-1.")
    configured = recipe.get("cohorts", [])
    if configured and len(configured) != 2:
        return blocked("Tests require exactly two declared cohorts.")
    groups = [c["id"] for c in configured] or list(dict.fromkeys(r["cohort"] for r in rows))
    if len(groups) != 2 or any(not any(r["cohort"] == g for r in rows) for g in groups):
        return blocked("Two nonempty cohorts are required.")
    seen, trial_blocks, per_trial = {}, {}, defaultdict(lambda: defaultdict(list))
    for row in rows:
        identity = row.get("row_id")
        if identity in seen and seen[identity] != row["cohort"]:
            return blocked("A source event belongs to both cohorts; exclude overlapping membership before testing.")
        seen[identity] = row["cohort"]
        trial, block = row["trial"], row.get("block_id")
        if missing(block):
            return blocked("Recorded block IDs are required for block-based inference.")
        if trial in trial_blocks and trial_blocks[trial] != block:
            return blocked("A trial has inconsistent block IDs.")
        trial_blocks[trial] = block
        per_trial[trial][row["cohort"]].append(float(row["rate"]))
    means = {t: {g: float(np.mean(v)) for g, v in data.items()} for t, data in per_trial.items()}
    rng = np.random.default_rng(seed)
    if test == "paired_permutation":
        paired = {t: data[groups[0]] - data[groups[1]] for t, data in means.items() if all(g in data for g in groups)}
        blocks = list(dict.fromkeys(trial_blocks[t] for t in paired))
        if len(blocks) < 3:
            return blocked("Within-trial A/B comparisons require paired trials in at least three blocks.")
        # Keeping all trial differences in a block under one sign preserves their
        # dependence. Weighting remains one vote per paired trial.
        block_sums = np.array([sum(d for t, d in paired.items() if trial_blocks[t] == b) for b in blocks])
        observed = float(sum(paired.values()) / len(paired))
        exact = len(blocks) <= 16
        signs = itertools.product((-1, 1), repeat=len(blocks)) if exact else (rng.choice((-1, 1), size=len(blocks)) for _ in range(n))
        null = np.fromiter((np.dot(sign, block_sums) / len(paired) for sign in signs), dtype=float)
        detail = {"null_scheme": "One sign flip per block, shared by every paired trial in that block.",
                  "n_trials": len(paired), "unpaired_trials_excluded": len(means) - len(paired),
                  "n_blocks": len(blocks), "block_ids": blocks, "block_sums_hz": block_sums.tolist(),
                  "estimator": "Mean within-trial A minus B rate difference across paired trials."}
    elif test == "block_permutation":
        block_trials = defaultdict(lambda: defaultdict(list))
        for trial, data in means.items():
            for g, value in data.items():
                block_trials[trial_blocks[trial]][g].append(value)
        if any(len(data) != 1 for data in block_trials.values()):
            return blocked("Independent block-label permutations require blocks disjoint between cohorts.")
        blocks = list(block_trials)
        labels = [next(iter(block_trials[b])) for b in blocks]
        counts = [labels.count(g) for g in groups]
        if min(counts) < 2:
            return blocked("At least two disjoint blocks per cohort are required.")
        values = np.array([np.mean(next(iter(block_trials[b].values()))) for b in blocks])
        mask = np.array([g == groups[0] for g in labels])
        observed = float(values[mask].mean() - values[~mask].mean())
        exact = math.comb(len(blocks), counts[0]) <= 50000
        permutations = itertools.combinations(range(len(blocks)), counts[0]) if exact else (rng.choice(len(blocks), size=counts[0], replace=False) for _ in range(n))
        null = []
        for indices in permutations:
            chosen = np.zeros(len(blocks), dtype=bool)
            chosen[list(indices)] = True
            null.append(float(values[chosen].mean() - values[~chosen].mean()))
        null = np.array(null)
        detail = {"null_scheme": "Permute disjoint block labels with cohort block counts fixed.",
                  "n_trials": len(means), "n_blocks": len(blocks), "blocks_per_cohort": counts,
                  "block_ids": blocks, "block_means_hz": values.tolist(),
                  "estimator": "Equal events within trial, equal trials within block, equal blocks within cohort; A minus B."}
    else:
        raise ValueError(f"Unsupported test: {test}")
    exceed = int(np.count_nonzero(np.abs(null) >= abs(observed) - 1e-12))
    p = exceed / len(null) if exact else (exceed + 1) / (len(null) + 1)
    return {**base, **detail, "status": "computed", "effect": observed, "effect_units": "Hz",
            "p_value": p, "n_null": len(null), "exact": exact, "seed": seed,
            "groups_order": groups, "two_sided": True, "count_window": request.get("count_window")}


def compute_unit(loaded: Any, request: Mapping[str, Any]) -> dict[str, Any]:
    test_name = request.get("test", "none")
    if test_name not in {"none", "paired_permutation", "block_permutation"}:
        raise ValueError("Unsupported test: " + str(test_name))
    unit_id = request.get("unit_id")
    if isinstance(unit_id, bool) or not isinstance(unit_id, int) or unit_id not in {int(u["id"]) for u in loaded.units}:
        raise ValueError(f"Unknown unit ID: {unit_id!r}")
    rows, support, provenance = prepare_rows(loaded, request, [unit_id])
    pre, post, bin_, sigma, count_lo, count_hi = _validate_settings(request)
    spikes = np.sort(np.asarray(loaded.spikes(unit_id), dtype=float).copy())
    n = int(round((post - pre) / bin_)); edges = pre + np.arange(n + 1) * bin_; times = (edges[:-1] + edges[1:]) / 2
    radius = int(math.ceil(4 * sigma / bin_)) if sigma else 0
    kernel = np.exp(-.5 * ((np.arange(2 * radius + 1) - radius) * bin_ / sigma) ** 2) if radius else np.array([1.0]); kernel /= kernel.sum()
    for row in rows:
        row["count"] = _count(spikes, float(row["t"]), count_lo, count_hi); row["rate"] = row["count"] / (count_hi - count_lo)
        raw = np.array([_count(spikes, float(row["t"]), float(a), float(b)) / bin_ for a, b in zip(edges[:-1], edges[1:])])
        if radius:
            padded_edges = pre - radius * bin_ + np.arange(n + 2 * radius + 1) * bin_
            ext = np.array([_count(spikes, float(row["t"]), float(a), float(b)) / bin_ for a, b in zip(padded_edges[:-1], padded_edges[1:])])
            row["curve"] = np.convolve(ext, kernel, mode="valid")
        else: row["curve"] = raw
        row["curve"] = row["curve"].tolist()
        row["spikes"] = (spikes[(spikes >= float(row["t"]) + pre) & (spikes < float(row["t"]) + post)] - float(row["t"])).tolist()
    groups = []
    for name in dict.fromkeys(r["group"] for r in rows):
        gr = [r for r in rows if r.get("group", r.get("cohort", "all")) == name]; trial_ids = list(dict.fromkeys(_trial_id(r) for r in gr))
        curves = []
        for tid in trial_ids:
            rs = [r for r in gr if _trial_id(r) == tid]; curves.append(np.mean([r["curve"] for r in rs], axis=0))
        arr = np.asarray(curves, dtype=float); mean = arr.mean(axis=0) if len(arr) else np.zeros(n); sem = arr.std(axis=0, ddof=1) / math.sqrt(len(arr)) if len(arr) > 1 else np.zeros(n)
        groups.append({"name": str(name), "label": _group_label(gr[0]), "color_key": gr[0].get("color_key", str(name)), "line_dashed": bool(gr[0].get("line_dashed", False)), "facet_key": gr[0].get("facet_key", "none"), "facet_value": gr[0].get("facet_value"), "trials": len(trial_ids), "blocks": len({r.get("block_id") for r in gr}), "mean": mean.tolist(), "sem": sem.tolist()})
    result = {"kind": "unit", "session_id": getattr(loaded, "session_id", request.get("session_id")), "unit": next((u for u in getattr(loaded, "units", []) if str(u.get("id")) == str(unit_id)), {"id": unit_id}), "settings": dict(request), "times": times.tolist(), "edges": edges.tolist(), "groups": groups, "rows": rows, "support": support, "provenance": provenance, "statistics": _infer(rows, request, test_name)}
    if request.get("annotations"):
        from .annotations import annotate_result
        result = annotate_result(result, loaded, request["annotations"])
    return result
