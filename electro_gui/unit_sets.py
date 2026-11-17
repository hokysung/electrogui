"""Unit annotation sets: properties of units computed elsewhere, for the unit browser (static/units.html).

A set is three things sharing one name, in the annotations folder (``<output>/unit_annotations``, ``--annotations-dir``):

* ``<name>.csv``   one row per unit: ``session``, ``sorting`` (empty = the default sorting), ``unit``, then any columns;
* ``<name>.json``  ``{title, description, source: {folder, commit}, report, columns: [{key, label, group, type, help}]}``
                   with ``type`` one of category, tags (``;``-separated), flag, number, text;
* ``<name>_cards/<session>@<sorting>_u<unit>.png``  optional per-unit images.

Names, sessions, sortings and unit IDs are validated and the card path is built from them, never from a client path.
A set is read again when its csv or json file changes.  Nothing here needs a session to be loaded: the unit's own
export columns come from the session's ``tables/units.csv`` when it exists.
"""
from __future__ import annotations

import json
import math
import re
import threading
from pathlib import Path
from typing import Any

import pandas as pd

NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+-]*$")
SESSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+-]*$")
TYPES = ("category", "tags", "flag", "number", "text")
KEYS = ("session", "sorting", "unit")
#: Columns of a session's tables/units.csv that the browser can show for every unit.
EXPORT_COLUMNS = [
    {"key": "export_quality", "src": "quality", "label": "Quality (export)", "group": "In the session export", "type": "category",
     "help": "The quality label of the session export (sua, mua, noise)."},
    {"key": "export_area", "src": "area", "label": "Area", "group": "In the session export", "type": "category", "help": ""},
    {"key": "peak_channel", "src": "peak_channel", "label": "Peak channel", "group": "In the session export", "type": "number", "help": ""},
    {"key": "mean_rate_hz", "src": "mean_rate_hz", "label": "Mean rate (Hz)", "group": "In the session export", "type": "number", "help": ""},
    {"key": "n_stable_trials", "src": "n_stable_trials", "label": "Stable trials", "group": "In the session export", "type": "number", "help": ""},
]


def _clean(value: Any, kind: str) -> Any:
    """A JSON-safe cell: NaN / empty -> None; flags -> bool; numbers -> float."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, str):
        text = value.strip()
        if text == "" or text.lower() == "nan":
            return None
    else:
        text = value
    if kind == "number":
        try:
            number = float(text)
        except (TypeError, ValueError):
            return None
        return number if math.isfinite(number) else None
    if kind == "flag":
        if isinstance(text, bool):
            return text
        low = str(text).lower()
        return True if low in ("true", "yes", "1", "1.0") else False if low in ("false", "no", "0", "0.0") else None
    return str(text)


class UnitSets:
    def __init__(self, root: str | Path, session_roots=()):
        self.root = Path(root).expanduser()
        self.session_roots = [Path(r).expanduser() for r in session_roots]
        self._sets: dict[str, tuple] = {}
        self._units_csv: dict[tuple, tuple] = {}
        self._lock = threading.RLock()

    # ---------------------------------------------------------------- listing
    def names(self) -> list[str]:
        if not self.root.is_dir():
            return []
        found = []
        for path in sorted(self.root.glob("*.json")):
            if NAME.match(path.stem) and (self.root / f"{path.stem}.csv").is_file():
                found.append(path.stem)
        return found

    def _check(self, name: str) -> str:
        if not isinstance(name, str) or not NAME.match(name) or name not in self.names():
            raise KeyError(f"Unknown unit set: {name!r}")
        return name

    def _load(self, name: str) -> dict:
        name = self._check(name)
        csv_path, json_path = self.root / f"{name}.csv", self.root / f"{name}.json"
        stamp = (csv_path.stat().st_mtime_ns, json_path.stat().st_mtime_ns)
        with self._lock:
            hit = self._sets.get(name)
            if hit and hit[0] == stamp:
                return hit[1]
            meta = json.loads(json_path.read_text())
            frame = pd.read_csv(csv_path, dtype=str, keep_default_na=False)
            missing = [k for k in KEYS if k not in frame.columns]
            if missing:
                raise ValueError(f"{csv_path.name} lacks the column(s) {', '.join(missing)}")
            columns = []
            for column in meta.get("columns", []):
                key = column.get("key")
                if key in frame.columns and key not in KEYS:
                    columns.append({"key": key, "label": column.get("label") or key, "group": column.get("group") or "Other",
                                    "type": column.get("type") if column.get("type") in TYPES else "text", "help": column.get("help") or ""})
            known = {c["key"] for c in columns}
            for key in frame.columns:   # columns the json does not describe still show, as text
                if key not in KEYS and key not in known:
                    columns.append({"key": key, "label": key, "group": "Other", "type": "text", "help": ""})
            kinds = {c["key"]: c["type"] for c in columns}
            rows = []
            for record in frame.to_dict(orient="records"):
                unit = _clean(record["unit"], "number")
                if unit is None:
                    continue
                rows.append([record["session"].strip(), record["sorting"].strip(), int(unit)]
                            + [_clean(record.get(c["key"]), kinds[c["key"]]) for c in columns])
            cards = self.root / f"{name}_cards"
            n_cards = len(list(cards.glob("*.png"))) if cards.is_dir() else 0
            sessions: dict[str, set] = {}
            for row in rows:
                sessions.setdefault(row[0], set()).add(row[1])
            data = {"meta": meta, "columns": columns, "rows": rows, "n_cards": n_cards,
                    "sessions": {s: sorted(v) for s, v in sorted(sessions.items())}}
            self._sets[name] = (stamp, data)
            return data

    def list(self) -> dict:
        out = []
        for name in self.names():
            try:
                data = self._load(name)
            except (ValueError, OSError, KeyError) as exc:
                out.append({"name": name, "error": str(exc)})
                continue
            meta = data["meta"]
            counts: dict[str, int] = {}
            for row in data["rows"]:
                counts[row[0]] = counts.get(row[0], 0) + 1
            out.append({"name": name, "title": meta.get("title") or name, "description": meta.get("description") or "",
                        "source": meta.get("source") or {}, "report": meta.get("report") or "", "columns": data["columns"],
                        "sessions": data["sessions"], "session_counts": counts, "n_units": len(data["rows"]),
                        "has_cards": data["n_cards"] > 0, "n_cards": data["n_cards"]})
        return {"sets": out}

    # ------------------------------------------------------------------- rows
    def _export_units(self, session: str, sorting: str):
        """``{unit: {export column: value}}`` from the session's tables/units.csv, or {} when it is not there."""
        if not SESSION.match(session or "") or (sorting and not SESSION.match(sorting)):
            return {}
        for root in self.session_roots:
            path = root / session / "sortings" / sorting / "tables" / "units.csv" if sorting else root / session / "tables" / "units.csv"
            if not path.is_file():
                continue
            stamp = path.stat().st_mtime_ns
            with self._lock:
                hit = self._units_csv.get((str(path)))
                if hit and hit[0] == stamp:
                    return hit[1]
                frame = pd.read_csv(path, dtype=str, keep_default_na=False)
                out = {}
                for record in frame.to_dict(orient="records"):
                    unit = _clean(record.get("unit_id"), "number")
                    if unit is not None:
                        out[int(unit)] = {c["key"]: _clean(record.get(c["src"]), c["type"]) for c in EXPORT_COLUMNS}
                self._units_csv[str(path)] = (stamp, out)
                return out
        return {}

    def rows(self, name: str, session: str | None = None, sorting: str | None = None) -> dict:
        data = self._load(name)
        if session is not None and not SESSION.match(session):
            raise ValueError("Invalid session")
        if sorting is not None and sorting and not SESSION.match(sorting):
            raise ValueError("Invalid sorting")
        selected = [r for r in data["rows"] if (session is None or r[0] == session) and (sorting is None or r[1] == sorting)]
        lookups = {}
        for row in selected:
            key = (row[0], row[1])
            if key not in lookups:
                lookups[key] = self._export_units(*key)
        any_export = any(lookups.values())
        columns = list(data["columns"])
        if any_export:
            columns += [{k: v for k, v in c.items() if k != "src"} for c in EXPORT_COLUMNS]
        rows = []
        for row in selected:
            if any_export:
                values = lookups[(row[0], row[1])].get(row[2], {})
                row = row + [values.get(c["key"]) for c in EXPORT_COLUMNS]
            rows.append(row)
        meta = data["meta"]
        return {"name": name, "title": meta.get("title") or name, "keys": list(KEYS) + [c["key"] for c in columns],
                "columns": columns, "rows": rows, "n": len(rows), "has_cards": data["n_cards"] > 0}

    # ------------------------------------------------------------------ cards
    def card(self, name: str, session: str, sorting: str, unit: Any) -> bytes:
        name = self._check(name)
        if not SESSION.match(session or "") or (sorting and not SESSION.match(sorting)):
            raise KeyError("Unknown card")
        try:
            number = int(str(unit))
        except ValueError:
            raise ValueError("unit must be an integer ID") from None
        folder = (self.root / f"{name}_cards").resolve()
        path = (folder / f"{session}@{sorting or ''}_u{number}.png").resolve()
        if not folder.is_dir() or not path.is_relative_to(folder) or not path.is_file():
            raise KeyError("Unknown card")
        return path.read_bytes()
