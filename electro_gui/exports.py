"""Portable exports of completed computations; never recompute a changed recipe."""
from __future__ import annotations

import csv
import io
import json


def export_json(result):
    return json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")


def export_csv(result):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    annotation_columns = _annotation_columns(result)
    if result["kind"] == "unit":
        writer.writerow(["session_id", "unit_id", "group", "time_s", "mean_hz", "sem_hz", "trials", "blocks", "source_sha256", *annotation_columns])
        for g in result["groups"]:
            for i, t in enumerate(result["times"]):
                writer.writerow([result["session_id"], result["unit"]["id"], g["label"], t,
                                 g["mean"][i], g["sem"][i], g["trials"], g["blocks"], _source_sha(result), *annotation_columns.values()])
    else:
        writer.writerow(["session_id", "group", "time_s", *[f"component_{i+1}" for i in range(result["components"])], "source_sha256", *annotation_columns])
        for g in result["groups"]:
            for t, point in zip(result["times"], g["coordinates"]):
                writer.writerow([result["session_id"], g["label"], t, *point, _source_sha(result), *annotation_columns.values()])
    return stream.getvalue().encode("utf-8")


def export_membership(result):
    rows = result.get("rows", [])
    fields = list(dict.fromkeys(k for row in rows for k in row if k not in ("spikes", "curve")))
    annotation_columns = _annotation_columns(result)
    columns = ["session_id", "unit_id", "source_sha256", *[k for k in fields if k not in ("session_id", "unit_id", "source_sha256")], *annotation_columns]
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=columns)
    writer.writeheader()
    for row in rows:
        writer.writerow({**{k: json.dumps(v) if isinstance(v, (dict, list)) else v for k, v in row.items() if k in fields}, **annotation_columns,
                         "session_id": result["session_id"], "unit_id": result.get("unit", {}).get("id", "population"),
                         "source_sha256": _source_sha(result)})
    return stream.getvalue().encode("utf-8")


def export_statistics(result):
    stats = result.get("statistics", result.get("diagnostics", {}))
    row = {"session_id": result["session_id"], "unit_id": result.get("unit", {}).get("id"),
           "kind": result["kind"], "source_sha256": _source_sha(result), **stats}
    row.update(_annotation_columns(result))
    if result["kind"] == "population":
        row.update(n_units=len(result["unit_ids"]), n_components=result["components"])
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=list(row))
    writer.writeheader()
    writer.writerow({k: json.dumps(v) if isinstance(v, (dict, list)) else v for k, v in row.items()})
    return stream.getvalue().encode("utf-8")


def _source_sha(result):
    provenance = result.get("provenance", {})
    return provenance.get("computation_identity", {}).get("source", {}).get("sha256", "")


def _annotation_columns(result):
    """Return reproducibility metadata appended to CSV rows when annotated."""
    annotations = result.get("annotations")
    if not isinstance(annotations, dict) or not annotations.get("layers"):
        return {}
    provenance = result.get("provenance", {})
    source_identity = provenance.get("source_identity") or provenance.get("computation_identity", {}).get("source", {})
    annotation_provenance = provenance.get("annotation") or annotations.get("provenance", {})
    return {
        "annotation_layers_json": json.dumps(annotations.get("layers", []), ensure_ascii=False, sort_keys=True),
        "annotation_provenance_json": json.dumps(annotation_provenance, ensure_ascii=False, sort_keys=True),
        "annotation_source_identity_json": json.dumps(source_identity, ensure_ascii=False, sort_keys=True),
    }


def export_svg(result, axes=(0, 1)):
    # Object API avoids pyplot's process-global mutable figure registry.
    from matplotlib.figure import Figure
    from matplotlib.backends.backend_svg import FigureCanvasSVG
    import numpy as np

    from .analysis import COLORS
    colors = dict(COLORS)   # tasks and stim/sham, as the explorer draws them
    annotations = result.get("annotations", {})
    annotation_layers = {str(x.get("id")): x for x in annotations.get("layers", []) if x.get("visible", True)}

    def draw_annotations(ax):
        for layer in annotation_layers.values():
            lid, color = str(layer["id"]), layer.get("color", "#b04a8b")
            if layer.get("kind") == "reference" and layer.get("time") is not None:
                ax.axvline(float(layer["time"]), color=color, lw=1.0, ls="-", alpha=.75, label=layer.get("name", lid))

    def draw_raster_row(ax, row, y0, n_rows):
        values = annotations.get("rows", {}).get(str(row.get("row_id")), {})
        for layer in annotation_layers.values():
            lid, color = str(layer["id"]), layer.get("color", "#b04a8b")
            value = values.get(lid, {})
            if layer.get("kind") == "event":
                for t in value.get("ticks", []):
                    ax.vlines(float(t), y0, y0 + .8, color=color, lw=.7, ls="--", alpha=.75)
            elif layer.get("kind") == "interval":
                for interval in value.get("intervals", []):
                    ax.fill_betweenx([y0, y0 + .8], float(interval["onset"]), float(interval["offset"]), color=color, alpha=.25)

    def draw_aggregate_strip(ax):
        """Draw event distributions/occupancy at the bottom of a timecourse."""
        aggregate = annotations.get("summary", {}).get("aggregates", {})
        ymin, ymax = ax.get_ylim()
        height = max(1.0, ymax - ymin) * .10
        for layer in annotation_layers.values():
            if layer.get("kind") == "reference":
                continue
            item = aggregate.get(str(layer["id"]), {})
            color = layer.get("color", "#b04a8b")
            if layer.get("kind") == "event" and item.get("times"):
                edges = np.linspace(float(result["settings"].get("pre", -1)), float(result["settings"].get("post", 1)), 41)
                hist, edges = np.histogram(item["times"], bins=edges)
                scale = hist / max(1, hist.max()) * height
                ax.fill_between(edges[:-1], ymin, ymin + scale, step="post", color=color, alpha=.28)
                ax.text(.01, .02, f"{layer.get('name', layer['id'])} event distribution · pooled valid rows (n={item.get('n_rows', 0)})", transform=ax.transAxes, fontsize=6, color=color)
            elif layer.get("kind") == "interval" and item.get("occupancy"):
                edges = np.asarray(item["occupancy"]["edges"], dtype=float)
                fraction = np.asarray(item["occupancy"]["fraction"], dtype=float)
                ax.fill_between(edges[:-1], ymin, ymin + fraction * height, step="post", color=color, alpha=.22)
                ax.text(.01, .02, f"{layer.get('name', layer['id'])} occupancy · equal selected-row weighting", transform=ax.transAxes, fontsize=6, color=color)
    times = np.array(result["times"])
    fig = Figure(figsize=(10, 7), layout="constrained")
    FigureCanvasSVG(fig)
    title = f"{result['session_id']} · "
    if result["kind"] == "unit":
        title += f"unit {result['unit']['id']}"
        facets = list(dict.fromkeys(g.get("facet_key", "all") for g in result["groups"])) or ["all"]
        fig.set_size_inches(10, max(6, 5 * len(facets)))
        plot_axes = fig.subplots(2 * len(facets), 1, squeeze=False)[:, 0]
        max_rate = max((max(np.array(g["mean"]) + np.array(g["sem"]), default=0) for g in result["groups"]), default=0)
        for fi, facet in enumerate(facets):
            raster, psth = plot_axes[fi * 2:fi * 2 + 2]
            offset = 0
            for g in [g for g in result["groups"] if g.get("facet_key", "all") == facet]:
                color = colors.get(str(g.get("color_key")), "#225f72")
                rs = [r for r in result["rows"] if r.get("group") == g["name"]]
                for row in rs:
                    raster.vlines(row.get("spikes", []), offset, offset + .8, linewidth=.45, color=color)
                    draw_raster_row(raster, row, offset, len(result["rows"]))
                    offset += 1
                mean, sem = np.array(g["mean"]), np.array(g["sem"])
                psth.plot(times, mean, color=color, ls="--" if g.get("line_dashed") else "-", label=f"{g['label']} (n={g['trials']} trials)")
                psth.fill_between(times, mean - sem, mean + sem, alpha=.12, color=color)
            raster.set_ylabel("Event row")
            raster.invert_yaxis()
            raster.set_title(str(facet))
            psth.set_ylabel("Firing rate (Hz)")
            psth.set_xlabel("Time from alignment (s)")
            psth.set_ylim(0, max(1, max_rate * 1.05))
            if result["groups"]:
                psth.legend(fontsize=7, loc="upper right")
            for ax in (raster, psth):
                ax.axvline(0, color="#77868e", lw=.8, ls=":")
                window = result["settings"].get("count_window", [0, .5])
                ax.axvspan(*window, color="#ffe7a8", alpha=.22)
                ax.set_xlim(result["edges"][0], result["edges"][-1])
                draw_annotations(ax)
            draw_aggregate_strip(psth)
    else:
        x, y = axes
        if x == y or not all(isinstance(i, int) and 0 <= i < result["components"] for i in axes):
            raise ValueError("Export axes must be two distinct valid component indices.")
        title += f"{result['diagnostics']['method'].upper()} · descriptive joint fit"
        trajectory = fig.add_subplot(121)
        course = fig.add_subplot(122)
        for g in result["groups"]:
            coords = np.array(g["coordinates"])
            color = colors.get(str(g.get("color_key")), "#225f72")
            ls = "--" if g.get("line_dashed") else "-"
            trajectory.plot(coords[:, x], coords[:, y], color=color, ls=ls, label=g["label"])
            trajectory.scatter(coords[0, x], coords[0, y], color=color, marker="o", s=16)
            course.plot(times, coords[:, x], color=color, ls=ls, label=g["label"])
        trajectory.set_xlabel(f"Component {x + 1}")
        trajectory.set_ylabel(f"Component {y + 1}")
        trajectory.legend(fontsize=7)
        course.set_xlabel("Time from alignment (s)")
        course.set_ylabel(f"Component {x + 1}")
        course.axvline(0, color="#77868e", ls=":", lw=.8)
        draw_annotations(course)
        draw_aggregate_strip(course)
    fig.suptitle(title, fontsize=11)
    fig.text(.01, .002, f"electro_gui 0.1 · session SHA256 {_source_sha(result)}", fontsize=6)
    stream = io.BytesIO()
    fig.savefig(stream, format="svg", metadata={"Description": json.dumps({"settings": result["settings"], "provenance": result["provenance"], "annotations": result.get("annotations", {})}, ensure_ascii=False)})
    return stream.getvalue()
