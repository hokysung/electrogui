"""Compact raster data for the interactive explorer (electro_gui 0.2).

The explorer does its display computations in the browser -- filtering,
grouping, sorting, binning, smoothing, markers and count-window rates -- so
that every knob redraws instantly.  This module supplies only what the
browser cannot compute from the session:

* ``alignment_table``: every candidate row of one alignment with its joined
  trial and previous-trial fields, in a dictionary-encoded columnar layout;
* ``unit_raster``: one unit's spike times around each row of that table, and
  each row's eligible span under a stability policy;
* ``event_times``: the times of one recorded event, for per-row markers;
* ``spike_train``: one unit's whole spike train, for the behavior timeline;
* ``behavior_timeline``: every trial's span, task, outcome, stimulation and events.

Row candidacy and eligibility follow :func:`electro_gui.analysis.prepare_rows`
exactly: complete trials only, finite times inside the ephys recording and
the sync-fit window, and a display window that, padded by the same fixed
0.4 s guard, lies inside the run of consecutive eligible trials that
contains the event.  The browser applies the window part of that rule from
the returned span, so moving the window never needs a server round trip.

The rows, spans, time grid, rates and basis fit themselves live in
:mod:`session_viewer.explorer_core` (phys-analysis); this module imports them.
"""
from __future__ import annotations

import json
import math
from collections import Counter, OrderedDict
from typing import Any, Mapping

import numpy as np

from session_viewer.explorer_core import (GUARD_S, UNION_ALIGNMENTS, alignment_rows, checked_unit_ids,
                                          eligible_spans, explorer_cache, fit_basis, grid, group_means, is_candidate,
                                          row_rates)
from session_viewer.store import HIDDEN_EVENTS

from .conditions import missing

MAX_WINDOW_S = 10.0    # analysis._validate_settings display limit
MAX_COMPONENTS = 50    # population fit; static/explorer.js MAX_NCOMP
SPIKE_DECIMALS = 5     # 10 us; well below a 30 kHz sample
SPIKE_TRAIN_TICK_S = 1e-4  # behavior timeline lane: far below one pixel at its tightest zoom

# Fields that identify rows rather than describe them, aliases, and fields that
# are constant by construction in a table of complete, in-recording rows.
_SKIP = {"row_id", "t", "session_time", "trial_index", "object_uid", "event", "complete",
         "within_ephys_recording", "within_sync_fit_window"}
_MAX_LEVELS = 400      # free-text columns (paths, sequences) are not useful to group by


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def alignment_counts(loaded: Any) -> dict[str, int]:
    """Candidate rows per alignment, including the pooled (union) alignments."""
    cache = explorer_cache(loaded)
    if "counts" not in cache:
        complete = {t["id"] for t in loaded.trials if t.get("complete") is True}
        counts = Counter(r["event"] for r in loaded.rows if is_candidate(r, complete))
        for name, members in UNION_ALIGNMENTS.items():
            counts[name] = sum(counts.get(k, 0) for k in members)
        cache["counts"] = dict(counts)
    return cache["counts"]


def _column(key: str, values: list, info: Mapping[str, Any], anchors: list[float]) -> dict | None:
    present = [v for v in values if not missing(v)]
    if not present:
        return None
    typ = info.get("type", "category")
    if typ == "number" and all(_finite(v) for v in present):
        relative = key.endswith("_t")
        data = [None if missing(v) else round(float(v) - (a if relative else 0.0), 6) for v, a in zip(values, anchors)]
        if len({d for d in data if d is not None}) < 2:
            return None
        return {"kind": "num", "data": data, "relative": relative}
    if typ == "boolean" or all(isinstance(v, bool) for v in present):
        levels = [False, True]
    else:
        levels = sorted({str(v) for v in present}, key=_natural)
        if len(levels) > _MAX_LEVELS:
            return None
    if len(levels) < 2 and len(present) == len(values):
        return None  # constant and never missing: nothing to filter, group or sort by
    index = {level: i for i, level in enumerate(levels)}
    codes = [-1 if missing(v) else index[v if isinstance(v, bool) and levels == [False, True] else str(v)] for v in values]
    return {"kind": "cat", "levels": levels, "codes": codes}


def _natural(text: str):
    try:
        return (0, float(text), text)
    except ValueError:
        return (1, 0.0, text)


def alignment_table(loaded: Any, alignment: str) -> dict:
    """Columnar joined fields for one alignment; the order defines row indices."""
    cache = explorer_cache(loaded).setdefault("tables", {})
    if alignment in cache:
        return cache[alignment]
    rows = alignment_rows(loaded, alignment)
    anchors = [float(r["t"]) for r in rows]
    trials = {t["id"]: t for t in loaded.trials}
    registry = {f["key"]: f for f in getattr(loaded, "fields", [])}
    keys = sorted({k for r in rows for k in r} | set(registry))
    columns = []
    for key in keys:
        info = registry.get(key, {})
        if key in _SKIP or info.get("alias_of") or info.get("availability") == "unavailable":
            continue
        column = _column(key, [r.get(key) for r in rows], info, anchors)
        if column is None:
            continue
        column.update(key=key, label=info.get("label", key), category=info.get("category", "advanced"),
                      timing=info.get("timing"), description=info.get("description"))
        columns.append(column)
    # Within-trial time is often the most useful sorting key and is not a registry field.
    since_start = [round(a - float(trials[r["trial"]]["start"]), 6) if _finite(trials.get(r["trial"], {}).get("start")) else None
                   for a, r in zip(anchors, rows)]
    if any(v is not None for v in since_start):
        columns.append({"key": "since_trial_start", "label": "Time since trial start", "kind": "num", "data": since_start,
                        "relative": False, "category": "task", "timing": "anchor",
                        "description": "Seconds from the trial's start to this event."})
    table = {"session_id": loaded.session_id, "alignment": alignment, "n": len(rows),
             "row_id": [int(r["row_id"]) for r in rows], "t": [round(a, 6) for a in anchors],
             "trial": [int(r["trial"]) for r in rows],
             "event": [str(r.get("event")) for r in rows] if alignment in UNION_ALIGNMENTS else None,
             "columns": columns}
    cache[alignment] = table
    return table


def _window(value: Any, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a number")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number") from None
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite")
    return number


def unit_raster(loaded: Any, alignment: str, unit_id: int, policy: str, lo: float, hi: float) -> dict:
    """Spike times in ``[t+lo, t+hi)`` for every table row, plus eligibility.

    ``span`` is the row's eligible run relative to its event, clipped to the
    recording: a row may be displayed over ``[pre, post]`` only when
    ``pre - GUARD_S >= span[0]`` and ``post + GUARD_S <= span[1]``.  Rows whose
    trial is ineligible, or whose event lies outside every eligible run, get
    ``None`` and a status code.
    """
    lo, hi = _window(lo, "lo"), _window(hi, "hi")
    if not -MAX_WINDOW_S - 1 <= lo < hi <= MAX_WINDOW_S + 1:
        raise ValueError("Spike window must increase and lie within [-11, 11] s.")
    if isinstance(unit_id, bool) or int(unit_id) not in {int(u["id"]) for u in loaded.units}:
        raise ValueError(f"Unknown unit ID: {unit_id!r}")
    unit_id = int(unit_id)
    rows = alignment_rows(loaded, alignment)
    eligible, provenance = loaded.eligibility([unit_id], policy)
    spans, status = eligible_spans(loaded, rows, set(eligible))
    spikes = np.sort(np.asarray(loaded.spikes(unit_id), dtype=float))
    anchors = np.array([float(r["t"]) for r in rows])
    starts = np.searchsorted(spikes, anchors + lo, side="left")
    stops = np.searchsorted(spikes, anchors + hi, side="left")
    out_spikes = [np.round(spikes[a:b] - t, SPIKE_DECIMALS).tolist() for a, b, t in zip(starts, stops, anchors)]
    unit = next(u for u in loaded.units if int(u["id"]) == unit_id)
    return {"session_id": loaded.session_id, "alignment": alignment, "unit": unit, "policy": policy,
            "window": [lo, hi], "guard_s": GUARD_S, "n": len(rows), "row_id": [int(r["row_id"]) for r in rows],
            "spikes": out_spikes, "span": spans, "status": status,
            "status_labels": {"0": "eligible", "1": "trial not eligible under this policy", "2": "event outside an eligible run"},
            "eligible_trials": len(eligible),
            "eligibility": {k: v for k, v in (provenance or {}).items() if k != "source"}}


def spike_train(loaded: Any, unit_id: int) -> dict:
    """One unit's whole spike train, for the behavior timeline's spike lane.

    Times are on the session (ephys) clock, rounded to ``SPIKE_TRAIN_TICK_S``
    and sent as integer tick differences, ``t[i] = tick_s * (dt[0] + ... +
    dt[i])``: a few characters per spike, so a 570 000-spike unit is about a
    megabyte gzipped.  No eligibility rule applies; the lane shows every spike.
    """
    if isinstance(unit_id, bool) or int(unit_id) not in {int(u["id"]) for u in loaded.units}:
        raise ValueError(f"Unknown unit ID: {unit_id!r}")
    unit_id = int(unit_id)
    spikes = np.sort(np.asarray(loaded.spikes(unit_id), dtype=float))
    ticks = np.rint(spikes[np.isfinite(spikes)] / SPIKE_TRAIN_TICK_S).astype(np.int64)
    unit = next(u for u in loaded.units if int(u["id"]) == unit_id)
    return {"session_id": loaded.session_id, "unit": unit, "n": int(len(ticks)), "tick_s": SPIKE_TRAIN_TICK_S,
            "dt": np.diff(ticks, prepend=0).tolist()}


def event_times(loaded: Any, event: str) -> dict:
    """All valid occurrences of one recorded event (or a pooled alignment)."""
    cache = explorer_cache(loaded).setdefault("events", {})
    if event not in cache:
        known = {r.get("event") for r in loaded.rows} - HIDDEN_EVENTS
        if event not in UNION_ALIGNMENTS and event not in known:
            raise KeyError(f"Unknown event: {event}")
        names = UNION_ALIGNMENTS.get(event, {event})
        rows = [r for r in loaded.rows if r.get("event") in names and r.get("trial") is not None and _finite(r.get("t"))
                and r.get("within_ephys_recording", True) is not False and r.get("within_sync_fit_window", True) is not False]
        rows.sort(key=lambda r: float(r["t"]))
        cache[event] = {"event": event, "n": len(rows), "trial": [int(r["trial"]) for r in rows],
                        "t": [round(float(r["t"]), 6) for r in rows]}
    return cache[event]


def behavior_timeline(loaded: Any) -> dict:
    """Every trial's span and conditions, and every recorded event, for the behavior timeline.

    ``trials`` lists each trial with a finite start and stop, in session order, with its ``task``,
    ``rewarded``, ``microstim`` and ``sham``.  ``events`` lists every recorded event of those
    trials in time order (``trial``, ``t``, ``event``), with :func:`event_times`' validity rule:
    finite, inside the ephys recording and the sync-fit window.  Nothing is inferred.
    """
    cache = explorer_cache(loaded)
    if "behavior" in cache:
        return cache["behavior"]
    trials = [t for t in loaded.trials if _finite(t.get("start")) and _finite(t.get("stop"))]
    trials.sort(key=lambda t: (float(t["start"]), int(t["id"])))
    kept = {int(t["id"]) for t in trials}
    events = sorted((r for r in loaded.rows
                     if r.get("trial") is not None and int(r["trial"]) in kept and _finite(r.get("t"))
                     and r.get("event") not in HIDDEN_EVENTS
                     and r.get("within_ephys_recording", True) is not False
                     and r.get("within_sync_fit_window", True) is not False),
                    key=lambda r: (float(r["t"]), int(r["row_id"])))
    text = lambda v: None if missing(v) else str(v)
    flag = lambda v: v if isinstance(v, bool) else None
    out = {
        "session_id": loaded.session_id, "duration_s": getattr(loaded, "duration_s", None),
        "trials": {"id": [int(t["id"]) for t in trials], "start": [round(float(t["start"]), 6) for t in trials],
                   "stop": [round(float(t["stop"]), 6) for t in trials], "complete": [flag(t.get("complete")) for t in trials],
                   "initiated": [flag(t.get("initiated")) for t in trials],
                   "task": [text(t.get("task")) for t in trials], "rewarded": [flag(t.get("rewarded")) for t in trials],
                   "microstim": [flag(t.get("microstim")) for t in trials], "sham": [flag(t.get("sham")) for t in trials],
                   "success": [flag(t.get("success")) for t in trials]},
        "events": {"trial": [int(r["trial"]) for r in events], "t": [round(float(r["t"]), 6) for r in events],
                   "event": [str(r["event"]) for r in events], "row_id": [int(r["row_id"]) for r in events]},
    }
    cache["behavior"] = out
    return out


def session_summary(loaded: Any) -> dict:
    """What the explorer needs to populate its pickers."""
    counts = alignment_counts(loaded)
    meta = loaded.metadata()
    return {"session_id": loaded.session_id, "source": meta["source"], "duration_s": meta["duration_s"],
            "counts": meta["counts"], "notices": meta.get("notices", []), "units": meta["units"],
            "alignments": [{"key": a, "n": int(counts.get(a, 0))} for a in loaded.alignments],
            "events": sorted({r.get("event") for r in loaded.rows if r.get("event")} - HIDDEN_EVENTS)}


# --------------------------------------------------------------------------- #
# Population workspace
# --------------------------------------------------------------------------- #

def stability_masks(loaded: Any) -> dict:
    """Verified-stable trials of every unit as base64 bitmasks over complete trials."""
    import base64
    from session_viewer.store import get_session_stability
    loaded._check()
    stability = get_session_stability(loaded.file)
    trials = sorted(int(t["id"]) for t in loaded.trials if t.get("complete") is True)
    index = {t: i for i, t in enumerate(trials)}
    pairs = getattr(stability, "stable_trials", {}) or {}
    masks = {}
    for unit in loaded.units:
        bits = bytearray((len(trials) + 7) // 8)
        for t in pairs.get(int(unit["id"]), ()):
            i = index.get(int(t))
            if i is not None:
                bits[i >> 3] |= 1 << (i & 7)
        masks[str(unit["id"])] = base64.b64encode(bytes(bits)).decode()
    return {"session_id": loaded.session_id, "trials": trials, "units": masks, "cache_key": getattr(stability, "cache_key", None),
            "bit_order": "trial i (index into trials) is bit (i & 7) of byte (i >> 3)"}


_FIT_FIELDS = ("unit_ids", "alignment", "policy", "method", "scaling", "weight", "components", "pre", "post", "bin", "sigma", "groups", "factors", "tdr_window")
TDR_DEFAULT_FACTORS = ("task", "microstim")


def _fit_inputs(loaded: Any, request: Mapping[str, Any]) -> dict:
    """Validate a population request and resolve its groups to eligible rows."""
    ids = checked_unit_ids(loaded, request.get("unit_ids"), minimum=2)
    alignment = request.get("alignment")
    policy = request.get("policy", "verified_stable")
    if policy not in ("verified_stable", "all_complete"):
        raise ValueError("policy must be verified_stable or all_complete")
    method, scaling, weight = request.get("method", "pca"), request.get("scaling", "zscore"), request.get("weight", "trial")
    if method not in ("pca", "ica", "fa", "tdr"):
        raise ValueError("method must be pca, ica, fa or tdr")
    if scaling not in ("center", "zscore"):
        raise ValueError("scaling must be center or zscore")
    if weight not in ("trial", "event"):
        raise ValueError("weight must be trial or event")
    components = request.get("components", 3)
    factors = request.get("factors")
    if method == "tdr":
        factors = list(TDR_DEFAULT_FACTORS) if factors is None else factors
        registry = {f["key"]: f for f in getattr(loaded, "fields", [])}
        if (not isinstance(factors, list) or not 2 <= len(factors) <= 10 or len(set(factors)) != len(factors)
                or any(not isinstance(f, str) for f in factors)):
            raise ValueError("Choose 2-10 distinct TDR factors.")
        for f in factors:
            if registry.get(f, {}).get("availability") != "available":
                raise ValueError(f"TDR factor {f!r} is not available in this session.")
        components = len(factors)
    elif isinstance(components, bool) or not isinstance(components, int) or not 2 <= components <= MAX_COMPONENTS:
        raise ValueError(f"Choose 2-{MAX_COMPONENTS} components.")
    pre, post = _window(request.get("pre"), "pre"), _window(request.get("post"), "post")
    bin_s, sigma = _window(request.get("bin"), "bin"), _window(request.get("sigma", 0), "sigma")
    if not (-MAX_WINDOW_S <= pre < post <= MAX_WINDOW_S) or not 0.005 <= bin_s <= 0.2 or not 0 <= sigma <= 0.1:
        raise ValueError("Window must lie in [-10, 10] s, bin in [5, 200] ms and sigma in [0, 100] ms.")
    tdr_window = None
    if method == "tdr":
        win = request.get("tdr_window")
        lo, hi = (pre, post) if win is None else (_window(win[0], "tdr_window"), _window(win[1], "tdr_window")) if isinstance(win, list) and len(win) == 2 else (None, None)
        if lo is None or not pre - 1e-9 <= lo < hi <= post + 1e-9:
            raise ValueError("The TDR window must lie inside the display window.")
        tdr_window = [lo, hi]
    groups = request.get("groups")
    if not isinstance(groups, list) or not 1 <= len(groups) <= 24:
        raise ValueError("Send 1-24 groups.")
    rows = alignment_rows(loaded, alignment)
    by_id = {int(r["row_id"]): (i, r) for i, r in enumerate(rows)}
    eligible, provenance = loaded.eligibility(ids, policy)
    spans, _ = eligible_spans(loaded, rows, set(eligible))
    members, seen = [], set()
    for g in groups:
        row_ids = g.get("row_ids") if isinstance(g, Mapping) else None
        if not isinstance(row_ids, list) or not row_ids or any(isinstance(r, bool) or not isinstance(r, int) for r in row_ids):
            raise ValueError("Every group needs a nonempty list of integer row_ids.")
        picked = []
        for rid in row_ids:
            if rid not in by_id:
                raise ValueError(f"Row {rid} is not an event of alignment {alignment!r}.")
            if rid in seen:
                raise ValueError(f"Row {rid} belongs to more than one group.")
            seen.add(rid)
            i, row = by_id[rid]
            span = spans[i]
            if not span or pre - GUARD_S < span[0] - 1e-9 or post + GUARD_S > span[1] + 1e-9:
                raise ValueError(f"Row {rid} is not eligible for every roster unit over [{pre}, {post}] s (0.4 s guard).")
            picked.append(row)
        members.append(picked)
    n, radius, kernel, times = grid(pre, post, bin_s, sigma)
    flat = [row for picked in members for row in picked]
    if len(flat) * (n + 2 * radius) > 20_000_000:
        raise ValueError("Event x time matrix is too large; narrow the selection or widen the bins.")
    key = json.dumps({k: request.get(k) for k in _FIT_FIELDS}, sort_keys=True, default=str)
    return {"ids": ids, "alignment": alignment, "policy": policy, "method": method, "scaling": scaling, "weight": weight,
            "components": components, "factors": factors, "tdr_window": tdr_window, "pre": pre, "post": post, "bin": bin_s, "sigma": sigma, "groups": groups,
            "members": members, "flat": flat, "eligible": eligible, "provenance": provenance,
            "n": n, "radius": radius, "kernel": kernel, "times": times, "key": key}


def population_fit(loaded: Any, request: Mapping[str, Any]) -> dict:
    """Condition means and one jointly fitted basis for explorer-defined groups.

    The browser defines the groups (filters x colour x line style) and sends their
    row IDs; every row is re-checked here against the common-trial eligibility
    rule for this roster and window, so the fit never sees an ineligible event.
    The fitted transform is linear; its operator is cached so single-trial
    projections (:func:`population_probe`) never need a refit.
    """
    inp = _fit_inputs(loaded, request)
    ids, members, flat, weight = inp["ids"], inp["members"], inp["flat"], inp["weight"]
    method, scaling, components = inp["method"], inp["scaling"], inp["components"]
    pre, post, bin_s, sigma = inp["pre"], inp["post"], inp["bin"], inp["sigma"]
    n, radius, kernel, times = inp["n"], inp["radius"], inp["kernel"], inp["times"]
    groups, eligible, provenance, alignment, policy = inp["groups"], inp["eligible"], inp["provenance"], inp["alignment"], inp["policy"]
    anchors = np.array([float(r["t"]) for r in flat])
    weights = np.zeros((len(members), len(flat)))
    offset = 0
    for g, picked in enumerate(members):
        if weight == "event":
            weights[g, offset:offset + len(picked)] = 1.0 / len(picked)
        else:
            per_trial = Counter(r["trial"] for r in picked)
            for j, r in enumerate(picked):
                weights[g, offset + j] = 1.0 / (len(per_trial) * per_trial[r["trial"]])
        offset += len(picked)
    means = np.empty((len(members), n, len(ids)))
    for u, uid in enumerate(ids):
        means[:, :, u] = group_means(np.sort(np.asarray(loaded.spikes(uid), dtype=float)), anchors, weights, pre, bin_s, n, radius, kernel)
    tdr = None
    if method == "tdr":
        from .tdr import design, fit_axes
        registry = {f["key"]: f for f in getattr(loaded, "fields", [])}
        X, used, described = design(flat, inp["factors"], registry)
        if used.sum() * n * len(ids) > 60_000_000:
            raise ValueError("TDR event x time x neuron array is too large; narrow the selection, the TDR window or the roster.")
        lo, hi = inp["tdr_window"]
        bins = np.flatnonzero((times >= lo - 1e-9) & (times <= hi + 1e-9))
        if not len(bins):
            raise ValueError("The TDR window contains no time bin.")
        used_anchors = anchors[used]
        rates = np.stack([row_rates(np.sort(np.asarray(loaded.spikes(uid), dtype=float)), used_anchors, pre, bin_s, n, radius, kernel)[:, bins]
                          for uid in ids], axis=2)
        fit = fit_axes(means, ids, rates, X, described, bins, scaling)
        tdr = fit["tdr"]
        tdr.update(window=[lo, hi], bins=[int(bins[0]), int(bins[-1])], events_without_factor=int((~used).sum()),
                   factor_keys=list(inp["factors"]))
        for f in tdr["factors"]:
            f["peak_time"] = float(times[f["peak_bin"]])
        coords, loadings = np.array(fit["coordinates"], dtype=float), np.array(fit["loadings"], dtype=float)
        operator, offset_b = fit["operator"], fit["offset"]
        single, cumulative = fit["component_r2"], fit["cumulative_r2"]
        x = fit["x"]
    else:
        fit = fit_basis(means, ids, method, scaling, components)
        coords, loadings = np.array(fit["coordinates"], dtype=float), np.array(fit["loadings"], dtype=float)
        # The transform is linear: coords = x @ P + b, with x the centred/scaled rates.
        estimator, n_active = fit["estimator"], len(fit["active_ids"])
        offset_b = estimator.transform(np.zeros((1, n_active)))[0]
        operator = estimator.transform(np.eye(n_active)) - offset_b
        # Component signs are arbitrary; make each component's largest loading positive so
        # small knob changes do not flip trajectories.
        for k in range(components):
            j = int(np.argmax(np.abs(loadings[:, k])))
            if loadings[j, k] < 0:
                loadings[:, k] *= -1
                coords[:, k] *= -1
                operator[:, k] *= -1
                offset_b[k] *= -1
        x = fit["x"]
        xc = x - x.mean(axis=0)
        total = float(np.sum(xc ** 2)) or 1.0
        single = [1 - float(np.sum((xc - np.outer(coords[:, k] - coords[:, k].mean(), loadings[:, k])) ** 2)) / total
                  for k in range(components)]
        if method != "pca":
            # ICA/FA components have no natural order; list them by variance explained.
            order = sorted(range(components), key=lambda k: -single[k])
            coords, loadings, single = coords[:, order], loadings[:, order], [single[k] for k in order]
            operator, offset_b = operator[:, order], offset_b[order]
        # Components 1..k together, in the order shown, from the partial reconstruction
        # rather than summed: it equals the running sum of the single-component R^2 only
        # while the scores are uncorrelated (PCA, ICA; FA once converged), and it ends
        # at reconstruction_r2.
        resid, cumulative = xc.copy(), []
        for k in range(components):
            resid -= np.outer(coords[:, k] - coords[:, k].mean(), loadings[:, k])
            cumulative.append(1 - float(np.sum(resid ** 2)) / total)
    fits = explorer_cache(loaded).setdefault("fits", OrderedDict())
    fits[inp["key"]] = {"active_ids": list(fit["active_ids"]), "center": fit["center"][fit["varying"]], "scale": fit["scale"],
                        "operator": operator, "offset": offset_b}
    while len(fits) > 8:
        fits.popitem(last=False)
    traj = coords.reshape(len(members), n, components)
    active = fit["active_ids"]
    keep = [ids.index(u) for u in active]
    out_groups = []
    for g, picked in enumerate(members):
        spec = groups[g]
        out_groups.append({"key": spec.get("key", str(g)), "label": spec.get("label", str(g)), "events": len(picked),
                           "trials": len({r["trial"] for r in picked}),
                           "coords": np.round(traj[g], 6).tolist(),
                           "means": np.round(means[g][:, keep], 4).tolist()})
    evr = None if tdr else fit["operators"].get("explained_variance_ratio")
    return {"kind": "population_fit", "session_id": loaded.session_id, "alignment": alignment, "policy": policy,
            "unit_ids": ids, "active_unit_ids": active, "dropped_constant_units": fit["dropped_ids"],
            "times": np.round(times, 6).tolist(), "groups": out_groups, "components": components,
            "loadings": np.round(loadings, 6).tolist(), "component_r2": [round(v, 6) for v in single],
            "cumulative_r2": [round(v, 6) for v in cumulative],
            "explained_variance_ratio": evr, "reconstruction_r2": fit["reconstruction_r2"], "rank": fit["rank"],
            "fit_rows": int(x.shape[0]), "converged": fit["converged"], "warnings": fit["warnings"],
            "method": method, "scaling": scaling, "weight": weight, "window": [pre, post],
            **({"tdr": tdr, "axis_names": [f["label"] for f in tdr["factors"]]} if tdr else {}), "bin": bin_s, "sigma": sigma,
            "common_trials": len(eligible), "guard_s": GUARD_S,
            "scope": "Descriptive in-sample fit to all groups' condition means jointly; no held-out prediction or significance test.",
            "weighting": ("equal trials within group, events averaged within trial" if weight == "trial" else "equal events within group")
                         + "; equal condition-time rows in the fit",
            "provenance": {"source": loaded.metadata()["source"], "eligibility": {k: v for k, v in (provenance or {}).items() if k != "source"}}}


def population_probe(loaded: Any, request: Mapping[str, Any]) -> dict:
    """Every trial's (or event's) projection at a few times, with the fitted basis.

    Rates use the fit's own grid, kernel and normalisation, and the weighting unit
    of its group means (a trial = its events averaged; an event = one row), so each
    group's cloud is centred exactly on its trajectory point at that bin.
    """
    inp = _fit_inputs(loaded, request)
    fits = explorer_cache(loaded).setdefault("fits", OrderedDict())
    if inp["key"] not in fits:
        population_fit(loaded, request)
    op = fits[inp["key"]]
    fits.move_to_end(inp["key"])
    probes = request.get("probe_times")
    if not isinstance(probes, list) or not 1 <= len(probes) <= 12:
        raise ValueError("probe_times must list 1-12 times.")
    pre, post, bin_s, n, radius, kernel = inp["pre"], inp["post"], inp["bin"], inp["n"], inp["radius"], inp["kernel"]
    probe_bins = []
    for t in probes:
        t = _window(t, "probe time")
        if not pre <= t <= post:
            raise ValueError(f"Probe time {t} s lies outside the window [{pre}, {post}] s.")
        probe_bins.append((t, min(n - 1, max(0, int(math.floor((t - pre) / bin_s + 1e-9))))))
    flat, members = inp["flat"], inp["members"]
    anchors = np.array([float(r["t"]) for r in flat])
    spikes = {uid: np.sort(np.asarray(loaded.spikes(uid), dtype=float)) for uid in op["active_ids"]}
    out = []
    for t, j in probe_bins:
        # Padded bins j..j+2r of the fit's grid feed the smoothed rate at bin j.
        edges = pre + (j - radius + np.arange(2 * radius + 2)) * bin_s
        x = np.empty((len(flat), len(op["active_ids"])))
        for u, uid in enumerate(op["active_ids"]):
            counts = np.diff(np.searchsorted(spikes[uid], anchors[:, None] + edges[None, :], side="left"), axis=1)
            x[:, u] = counts @ kernel / bin_s
        groups, offset = [], 0
        for spec, picked in zip(inp["groups"], members):
            block = x[offset:offset + len(picked)]
            offset += len(picked)
            if inp["weight"] == "trial":
                order = list(dict.fromkeys(r["trial"] for r in picked))
                block = np.array([block[[k for k, r in enumerate(picked) if r["trial"] == tid]].mean(axis=0) for tid in order])
                ids = [int(tid) for tid in order]
            else:
                ids = [int(r["row_id"]) for r in picked]
            z = ((block - op["center"]) / op["scale"]) @ op["operator"] + op["offset"]
            groups.append({"key": spec.get("key"), "ids": ids, "points": np.round(z, 5).tolist()})
        out.append({"t": t, "bin_index": j, "bin_centre": round(float(inp["times"][j]), 6), "groups": groups})
    return {"kind": "population_probe", "unit": inp["weight"], "probes": out,
            "note": "centroid of each group's points equals its trajectory point at that bin"}
