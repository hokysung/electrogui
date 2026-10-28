"""Targeted dimensionality reduction (Mante et al. 2013) for the population view.

Each neuron's single-event rate, in every bin of a chosen window, is regressed on
task factors (task, microstim, target position, ...).  The coefficient vectors
across neurons say how strongly, and with what sign, each factor is carried by
the population at each time.  One axis per factor is read at the time its
coefficient vector is largest, restricted to the leading principal subspace of
the condition means (which removes regression noise from weakly driven
dimensions), and the axes are orthogonalised by QR so that they can be plotted
against each other.  Condition means are then projected onto those axes.
"""
from __future__ import annotations

import re

import numpy as np

from .conditions import missing

DENOISE_DIMS = 12   # Mante et al. keep 12 PCs
MAX_LEVELS = 8


def _natural(text):
    try:
        return (0, float(text), text)
    except ValueError:
        return (1, 0.0, text)


def design(rows, factors, registry):
    """Effect-coded design matrix for rows that have every factor.

    A categorical (or boolean) factor with L levels contributes L-1 sum-to-zero columns; a
    numeric factor contributes one standardised column.  Returns
    (X with an intercept column, keep mask, factor descriptions).
    """
    keep = np.array([all(not missing(r.get(f)) for f in factors) for r in rows])
    if keep.sum() < 4:
        raise ValueError("Fewer than 4 events have a value for every chosen factor; choose other factors or widen the selection.")
    used = [r for r, k in zip(rows, keep) if k]
    columns, described = [np.ones(len(used))], []
    for key in factors:
        info = registry.get(key, {})
        raw = [r[key] for r in used]
        if info.get("type") == "number":
            v = np.asarray(raw, dtype=float)
            sd = v.std()
            if not sd > 0:
                raise ValueError(f"Factor {key!r} is constant over the selected events.")
            first = len(columns)
            columns.append((v - v.mean()) / sd)
            described.append({"key": key, "label": info.get("label", key), "kind": "number", "levels": None,
                              "columns": [first], "column_labels": [info.get("label", key)]})
            continue
        text = [str(v) for v in raw]
        canonical = [str(v) for v in info.get("values", [])]
        present = set(text)
        levels = [v for v in canonical if v in present] + sorted(present - set(canonical), key=_natural)
        if len(levels) < 2:
            raise ValueError(f"Factor {key!r} has a single level ({levels[0]}) among the selected events; TDR needs it to vary.")
        if len(levels) > MAX_LEVELS:
            raise ValueError(f"Factor {key!r} has {len(levels)} levels; TDR supports up to {MAX_LEVELS}.")
        first, ref = len(columns), levels[-1]
        arr = np.array(text)
        for lv in levels[:-1]:
            columns.append((arr == lv).astype(float) - (arr == ref).astype(float))
        described.append({"key": key, "label": info.get("label", key), "kind": "category", "levels": levels,
                          "columns": list(range(first, len(columns))),
                          "column_labels": [f"{lv} vs {ref}" for lv in levels[:-1]]})
    X = np.column_stack(columns)
    if np.linalg.matrix_rank(X) < X.shape[1]:
        raise ValueError("The chosen factors are perfectly collinear over the selected events, so their effects cannot be separated; drop one.")
    return X, keep, described


def axis_name(label):
    return re.sub(r"\s+", " ", str(label)).strip()


def fit_axes(means, ids, rates, X, described, bins, scaling, dims=DENOISE_DIMS):
    """Axes, coordinates and diagnostics.

    ``means``  (groups, times, units) condition means, as :func:`session_viewer.explorer_core.fit_basis` takes.
    ``rates``  (events, window bins, units) single-event rates for the events in ``X``.
    ``bins``   indices into the time axis that ``rates`` covers.
    """
    raw = means.reshape(-1, len(ids))
    center = raw.mean(axis=0)
    std = raw.std(axis=0, ddof=0)
    varying = std > max(1e-12, float(std.max()) * 1e-12)
    active_ids = [u for u, k in zip(ids, varying) if k]
    dropped = [u for u, k in zip(ids, varying) if not k]
    F = len(described)
    if len(active_ids) < F:
        raise ValueError(f"Only {len(active_ids)} nonconstant units support this selection; TDR needs at least one per factor.")
    scale = std[varying] if scaling == "zscore" else np.ones(varying.sum())
    x = (raw[:, varying] - center[varying]) / scale
    rz = (rates[:, :, varying] - center[varying]) / scale
    n_rows, n_win, n_act = rz.shape
    beta = np.linalg.lstsq(X, rz.reshape(n_rows, -1), rcond=None)[0].reshape(X.shape[1], n_win, n_act)
    fitted = np.tensordot(X, beta, axes=(1, 0))
    tot = ((rz - rz.mean(axis=0)) ** 2).sum(axis=(0, 2))
    r2_t = 1 - ((rz - fitted) ** 2).sum(axis=(0, 2)) / np.where(tot > 0, tot, 1)

    xc = x - x.mean(axis=0)
    rank = int(np.linalg.matrix_rank(xc))
    npc = max(1, min(dims, rank, n_act))
    _, _, vt = np.linalg.svd(xc, full_matrices=False)
    basis = vt[:npc].T
    denoise = basis @ basis.T

    axes, info = [], []
    for d in described:
        block = beta[d["columns"]] @ denoise                    # (cols, window, units)
        norm_t = np.sqrt((block ** 2).sum(axis=(0, 2)))
        j = int(np.argmax(norm_t))
        if not norm_t[j] > 1e-12:
            raise ValueError(f"Factor {d['key']!r} explains nothing in the window after denoising; widen the window or drop it.")
        if len(d["columns"]) == 1:
            w = block[0, j]
        else:
            w = np.linalg.svd(block[:, j, :], full_matrices=False)[2][0]
        axes.append(w / np.linalg.norm(w))
        info.append({"key": d["key"], "label": d["label"], "kind": d["kind"], "levels": d["levels"],
                     "column_labels": d["column_labels"], "peak_bin": int(bins[j]), "peak_norm": float(norm_t[j]),
                     "effect_norm": norm_t.tolist()})
    W = np.column_stack(axes)
    if np.linalg.matrix_rank(W) < F:
        raise ValueError("Two factors point along the same population axis, so they cannot be told apart; drop one.")
    q, r = np.linalg.qr(W)
    q = q * np.sign(np.diag(r))
    cosines = W.T @ W
    coords = x @ q
    total = float(np.sum(xc ** 2)) or 1.0
    single = [1 - float(np.sum((xc - np.outer(coords[:, k] - coords[:, k].mean(), q[:, k])) ** 2)) / total for k in range(F)]
    resid, cumulative = xc.copy(), []
    for k in range(F):
        resid -= np.outer(coords[:, k] - coords[:, k].mean(), q[:, k])
        cumulative.append(1 - float(np.sum(resid ** 2)) / total)
    return {"coordinates": coords, "loadings": q, "operator": q, "offset": np.zeros(F), "active_ids": active_ids,
            "dropped_ids": dropped, "rank": rank, "converged": True, "warnings": [], "center": center,
            "varying": varying, "scale": scale, "x": x, "reconstruction_r2": cumulative[-1],
            "component_r2": single, "cumulative_r2": cumulative,
            "tdr": {"factors": info, "regression_r2": r2_t.tolist(), "denoise_dims": npc,
                    "axis_cosines_before_orthogonalisation": cosines.tolist(), "events": int(n_rows),
                    "coding": "categorical and boolean factors: sum-to-zero (effect) coding, last level is the reference; numeric factors: z-scored"}}
