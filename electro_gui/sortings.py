"""Several spike sortings of one session.

``<root>/<sid>/session.h5`` is the session's default sorting, as before.  Other
sortings of the same recording, exported the same way, live at
``<root>/<sid>/sortings/<name>/session.h5`` (with their own ``figures/`` and
``tables/``), ``<name>`` being the sorting config (``ms5_lar_v6``,
``ks4_nwb_lar_v6``, ...).  An alternate is listed only when its ``session.h5``
exists.  Unit IDs belong to one sorting: unit 12 of one sorting is not unit 12
of another, so everything keyed by a unit is also keyed by the sorting.

``sorting`` is ``None`` for the default everywhere (API, view state, findings),
so a link, finding or result made before alternates existed means the default.
Explicit ``--session-file`` sessions have only their default sorting.

``session_viewer.store.SessionStore`` only globs ``<root>/*/session.h5``, so a
``sortings`` folder is never taken for a session.
"""
from __future__ import annotations

import json
from pathlib import Path
import re

import h5py

from session_viewer.session_file import SessionFile, SourceChangedError
from session_viewer.store import LoadedSession, SESSION_FILE, SessionStore

SORTINGS_DIR = "sortings"
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+-]*$")


def normalize_sorting(value) -> str | None:
    """``None`` / ``""`` -> ``None`` (the default sorting); else a folder name under ``sortings/``."""
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not _NAME.match(value) or len(value) > 128:
        raise ValueError(f"sorting must be a sorting folder name, not {value!r}")
    return value


def sorting_label(meta: dict) -> str | None:
    """The sorting as the file's ``meta["streams"]`` names it: one name, or ``imec0 a · imec1 b``."""
    streams = [s for s in meta.get("streams") or [] if isinstance(s, dict) and s.get("sorting")]
    names = {str(s["sorting"]) for s in streams}
    if not names:
        return None
    if len(names) == 1:
        return names.pop()
    return " · ".join(f"{s.get('stream')} {s['sorting']}" for s in streams)


class SortingStore(SessionStore):
    """A ``SessionStore`` that also opens ``<sid>/sortings/<name>/session.h5``.

    ``get(sid)`` is the default sorting, loaded and cached exactly as before;
    ``get(sid, name)`` an alternate.  Every loaded session carries
    ``loaded.sorting`` (``None`` for the default) and ``loaded.sorting_label``.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._summaries: dict[Path, tuple[tuple[int, int], dict]] = {}

    # ------------------------------------------------------------ listing
    def _default_path(self, session_id: str) -> Path:
        path = next((Path(e["path"]) for e in super().catalog() if e["id"] == str(session_id)), None)
        if path is None:
            raise KeyError(f"unknown session {session_id}")
        return path

    def _explicit(self, path: Path) -> bool:
        return Path(path).resolve() in self.session_files

    def _summary(self, path: Path) -> dict:
        """``{label, n_units}`` read from the file's attributes, cached until the file changes."""
        stat = path.stat()
        signature = (stat.st_size, stat.st_mtime_ns)
        cached = self._summaries.get(path)
        if cached and cached[0] == signature:
            return cached[1]
        label, n_units = None, None
        try:
            with h5py.File(path, "r") as handle:
                label = sorting_label(json.loads(handle.attrs["meta"]))
                n_units = int(handle["units/id"].shape[0]) if "units/id" in handle else None
        except (OSError, KeyError, ValueError, TypeError):
            pass
        summary = {"label": label, "n_units": n_units}
        self._summaries[path] = (signature, summary)
        return summary

    def sortings(self, session_id: str) -> list[dict]:
        """The default sorting first, then every ``sortings/<name>/session.h5``, sorted by name.

        Each entry: ``{name, label, is_default, n_units, path}``; ``name`` is ``None`` for the default.
        """
        path = self._default_path(session_id)
        summary = self._summary(path)
        out = [{"name": None, "label": summary["label"] or "default", "is_default": True,
                "n_units": summary["n_units"], "path": str(path)}]
        folder = path.parent / SORTINGS_DIR
        if self._explicit(path) or not folder.is_dir():
            return out
        for sub in sorted(folder.iterdir(), key=lambda p: p.name):
            alt = sub / SESSION_FILE
            if sub.name.startswith(".") or not _NAME.match(sub.name) or not alt.is_file():
                continue
            summary = self._summary(alt)
            out.append({"name": sub.name, "label": summary["label"] or sub.name, "is_default": False,
                        "n_units": summary["n_units"], "path": str(alt.resolve())})
        return out

    def catalog_with_sortings(self) -> list[dict]:
        """``catalog()`` with each session's ``sortings`` list (see ``sortings``)."""
        return [dict(entry, sortings=self.sortings(entry["id"])) for entry in super().catalog()]

    def sorting_path(self, session_id: str, sorting) -> Path:
        name = normalize_sorting(sorting)
        path = self._default_path(session_id)
        if name is None:
            return path
        alt = path.parent / SORTINGS_DIR / name / SESSION_FILE
        if self._explicit(path) or not alt.is_file():
            raise KeyError(f"session {session_id} has no sorting {name!r}")
        return alt.resolve()

    # ------------------------------------------------------------ loading
    def get(self, session_id: str, sorting=None) -> LoadedSession:
        sid, name = str(session_id), normalize_sorting(sorting)
        if name is None:
            loaded = super().get(sid)
            if not hasattr(loaded, "sorting"):
                loaded.sorting = None
                loaded.sorting_label = sorting_label(loaded.file.meta)
            return loaded
        path = self.sorting_path(sid, name)
        key = (sid, name)
        if key in self._loaded:
            loaded = self._loaded.pop(key)
            try:
                loaded._check()
                self._loaded[key] = loaded
                return loaded
            except SourceChangedError:
                pass
        session = SessionFile(path)
        if session.session_id != sid:
            raise ValueError(f"{path} holds session {session.session_id!r}, not {sid!r} (its session folder)")
        loaded = LoadedSession(session, self.cache_dir)
        loaded.sorting = name
        loaded.sorting_label = sorting_label(session.meta) or name
        self._loaded[key] = loaded
        while len(self._loaded) > 2:
            self._loaded.popitem(last=False)
        return loaded
