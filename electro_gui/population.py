"""Descriptive population transforms fitted jointly to selected condition means.

The rates and the basis fit are :mod:`session_viewer.explorer_core`'s
``smoothed_rates`` and ``fit_basis``.
"""
from __future__ import annotations

import numpy as np

from session_viewer.explorer_core import fit_basis, smoothed_rates

from .analysis import prepare_rows


def compute_population(loaded, request):
    """Fit a single within-session basis to the exact selected membership.

    Condition means first average events within trial and then trials equally.
    No pseudopopulation, condition-specific basis, predictive validation or
    inference is implied. Every output retains the fit matrix and operators.
    """
    ids = request.get("unit_ids")
    if not isinstance(ids, list) or len(ids) < 2:
        raise ValueError("Population analysis requires at least two explicit unit IDs.")
    if any(isinstance(i, bool) or not isinstance(i, int) for i in ids):
        raise ValueError("Population unit IDs must be integers.")
    if len(set(ids)) != len(ids):
        raise ValueError("Population unit roster contains duplicates.")
    unit_map = {int(u["id"]): u for u in loaded.units}
    if set(ids) - set(unit_map):
        raise ValueError(f"Unknown population units: {sorted(set(ids) - set(unit_map))}")
    method = request.get("method", "pca")
    if method not in ("pca", "ica", "fa"):
        raise ValueError("Population method must be pca, ica, or fa.")
    scaling = request.get("scaling", "center")
    if scaling not in ("center", "zscore"):
        raise ValueError("Population scaling must be center or zscore.")
    components = request.get("components", 3)
    if isinstance(components, bool) or not isinstance(components, int) or not 2 <= components <= 10:
        raise ValueError("Choose 2–10 population components.")
    rows, support, provenance = prepare_rows(loaded, request, ids)
    if not rows:
        raise ValueError("No common eligible events for the selected population and recipe.")
    pre, post = float(request.get("pre", -1)), float(request.get("post", 1))
    bin_s, sigma = float(request.get("bin", .05)), float(request.get("sigma", .05))
    n_bins = int(round((post - pre) / bin_s))
    times = pre + (np.arange(n_bins) + .5) * bin_s
    names = list(dict.fromkeys(row["group"] for row in rows))
    anchors = np.array([r["t"] for r in rows], dtype=float)
    # Bound the temporary event × time matrix, without limiting the unit roster.
    if len(rows) * (n_bins + 2 * int(np.ceil(4 * sigma / bin_s))) > 20_000_000:
        raise ValueError("Population event × time matrix is too large; narrow the event/window selection or increase bin width.")
    group_trials = []
    for name in names:
        idx = [i for i, row in enumerate(rows) if row["group"] == name]
        trials = list(dict.fromkeys(rows[i]["trial"] for i in idx))
        group_trials.append([np.array([i for i in idx if rows[i]["trial"] == t]) for t in trials])
    means = np.empty((len(names), n_bins, len(ids)), dtype=float)
    for u, unit_id in enumerate(ids):
        rates = smoothed_rates(loaded.spikes(unit_id), anchors, pre, post, bin_s, sigma)
        for g, trial_indices in enumerate(group_trials):
            means[g, :, u] = np.mean([rates[ix].mean(axis=0) for ix in trial_indices], axis=0)
    fit = fit_basis(means, ids, method, scaling, components)
    coordinates, loadings, models = fit["coordinates"], fit["loadings"], fit["operators"]
    active_ids, dropped, rank = fit["active_ids"], fit["dropped_ids"], fit["rank"]
    converged, notices, estimator = fit["converged"], fit["warnings"], fit["estimator"]
    center, varying, scale, x = fit["center"], fit["varying"], fit["scale"], fit["x"]
    reconstruction_r2 = fit["reconstruction_r2"]
    trajectories = coordinates.reshape(len(names), n_bins, components)
    groups = []
    for g, name in enumerate(names):
        selected = [r for r in rows if r["group"] == name]
        first = selected[0]
        groups.append({"name": name, "label": first.get("group_label", name),
                       "color_key": first.get("color_key", first.get("cohort", name)),
                       "line_dashed": bool(first.get("line_dashed", False)),
                       "facet_key": first.get("facet_key", "all"), "facet_value": first.get("facet_value"),
                       "trials": len(group_trials[g]), "events": len(selected),
                       "coordinates": trajectories[g].tolist(), "input_means": means[g].tolist()})
    result = {"kind": "population", "session_id": loaded.session_id, "settings": request,
            "times": times.tolist(), "groups": groups, "rows": rows,
            "unit_ids": ids, "active_unit_ids": active_ids, "dropped_constant_units": dropped,
            "units": [dict(unit_map[i]) for i in ids],
            "components": components, "loadings": loadings.tolist(),
            "support": support, "provenance": provenance,
            "diagnostics": {"method": method, "scaling": scaling, "fit_rows": len(x), "rank": rank,
                            "converged": converged, "warnings": notices,
                            "iterations": int(getattr(estimator, "n_iter_", 0)),
                            "reconstruction_r2": reconstruction_r2,
                            "explained_variance_ratio": models.get("explained_variance_ratio"),
                            "scope": "Descriptive, in-sample fit to all displayed condition means jointly; no held-out prediction or significance test."},
            "model": {"method": method, "unit_order": active_ids, "fit_group_order": names,
                      "center": center[varying].tolist(), "scale": scale.tolist(),
                      "weighting": "Equal events within trial, equal trials within condition; equal condition-time rows in the transform fit.",
                      "operators": models, "random_seed": 0}}
    if request.get("annotations"):
        from .annotations import annotate_result
        result = annotate_result(result, loaded, request["annotations"])
    return result
