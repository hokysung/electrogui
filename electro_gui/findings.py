"""Findings: saved explorer views that keep their picture, notes and the numbers they rest on.

A finding is one JSON file, plus the figure as a PNG, in the findings folder
(``--findings-dir``, default ``$ELECTRO_GUI_OUTPUT/findings``, else
``~/electro_gui_output/findings``, see paths.py):

* ``<id>.json`` is a config file (``electro_gui_config: 1``, see configs.py)
  holding ``title``, ``note`` and the page's view ``state``, so copying it into
  a deck's ``electro_gui_configs/`` makes it a slide config as it stands.  It
  adds ``tags``, a ``status`` (lead, checking, supported, dropped: the user's
  judgement, never set by the program), the ``evidence`` the page measured from
  the drawn figure when it was saved (session, session-file checksum, unit identity,
  events, trials and count-window rate per group, exclusions, fit diagnostics),
  and when, where and with which code it was saved.
* ``<id>.png`` is the figure as Export -> PNG draws it, taken at the same moment.

The state and evidence never change after saving; only the title, note, tags
and status can be edited, so a finding's numbers keep saying what was seen
then.  The page measures the evidence again when a finding is reopened and
reports every difference.  Nothing here reads a session file.

One file per finding, written atomically (temporary dotfile, then rename):
two machines sharing the folder (a synced or network folder) only ever write the
same file when they edit the same finding.  Deleting moves the files into ``.deleted/`` in the
same folder rather than erasing them.
"""
from __future__ import annotations

import base64
import binascii
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import threading

from .configs import CONFIG_VERSION, MAX_BYTES

FORMAT = 1
STATUSES = ("lead", "checking", "supported", "dropped")
EDITABLE = ("title", "note", "tags", "status")
MAX_TITLE, MAX_NOTE, MAX_TAGS, MAX_TAG = 200, 20000, 20, 40
MAX_PNG = 8 * 1024 * 1024
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_ID = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{6}$")


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def clean_title(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("A finding needs a title.")
    value = " ".join(value.split())
    if len(value) > MAX_TITLE:
        raise ValueError(f"The title is longer than {MAX_TITLE} characters.")
    return value


def clean_note(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("The note must be text.")
    if len(value) > MAX_NOTE:
        raise ValueError(f"The note is longer than {MAX_NOTE} characters.")
    return value.strip()


def clean_tags(value):
    """A list of tags, or one comma-separated string; spaces collapse, duplicates (any case) go."""
    if value is None:
        return []
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, list) or not all(isinstance(t, str) for t in value):
        raise ValueError("Tags must be a list of words.")
    tags, seen = [], set()
    for tag in (" ".join(t.split()) for t in value):
        if not tag or tag.casefold() in seen:
            continue
        if len(tag) > MAX_TAG or "," in tag:
            raise ValueError(f"A tag must be at most {MAX_TAG} characters, without commas: {tag[:60]!r}")
        seen.add(tag.casefold())
        tags.append(tag)
    if len(tags) > MAX_TAGS:
        raise ValueError(f"A finding takes at most {MAX_TAGS} tags.")
    return tags


def clean_status(value):
    if value is None:
        return STATUSES[0]
    if value not in STATUSES:
        raise ValueError(f"Status must be one of {', '.join(STATUSES)}.")
    return value


def _png(data_url):
    """``data:image/png;base64,...`` -> PNG bytes."""
    prefix = "data:image/png;base64,"
    if not isinstance(data_url, str) or not data_url.startswith(prefix):
        raise ValueError("The thumbnail must be a PNG data URL.")
    try:
        raw = base64.b64decode(data_url[len(prefix):], validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("The thumbnail is not valid base64.") from None
    if not raw.startswith(PNG_MAGIC):
        raise ValueError("The thumbnail is not a PNG image.")
    if len(raw) > MAX_PNG:
        raise ValueError(f"The thumbnail is larger than {MAX_PNG // 1048576} MiB.")
    return raw


class FindingStore:
    def __init__(self, root):
        self.root = Path(root).expanduser().absolute()
        self.lock = threading.Lock()

    def _path(self, finding_id, suffix=".json"):
        if not isinstance(finding_id, str) or not _ID.match(finding_id):
            raise KeyError(f"No finding {str(finding_id)[:40]!r}")
        return self.root / f"{finding_id}{suffix}"

    @contextmanager
    def _writing(self):
        """A failed write names the folder, not the temporary file it was writing."""
        try:
            yield
        except OSError as exc:
            raise OSError(exc.errno, exc.strerror or str(exc), str(self.root)) from exc

    def _write(self, path, data):
        tmp = path.with_name(f".{path.name}.tmp")
        try:
            tmp.write_bytes(data)
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)

    def _read(self, path):
        record = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(record, dict) or record.get("finding") != FORMAT or not isinstance(record.get("state"), dict):
            raise ValueError("not an electro_gui finding (format 1)")
        record["has_thumbnail"] = path.with_suffix(".png").is_file()
        return record

    def list(self):
        """Every finding, newest first, plus the files that could not be read."""
        findings, errors = [], []
        paths = sorted(self.root.glob("*.json")) if self.root.is_dir() else []
        for path in paths:
            if path.name.startswith("."):
                continue
            try:
                findings.append(self._read(path))
            except (OSError, ValueError) as exc:
                errors.append({"file": path.name, "error": str(exc)})
        findings.sort(key=lambda f: str(f.get("saved_at", "")), reverse=True)
        return {"findings": findings, "errors": errors, "folder": str(self.root)}

    def file(self, finding_id):
        """The finding's JSON file (its picture is beside it); KeyError when there is none."""
        path = self._path(finding_id)
        if not path.is_file():
            raise KeyError(f"No finding {finding_id}")
        return path

    def get(self, finding_id):
        return self._read(self.file(finding_id))

    def thumbnail(self, finding_id):
        path = self._path(finding_id, ".png")
        if not path.is_file():
            raise KeyError(f"Finding {finding_id} has no picture")
        return path.read_bytes()

    def create(self, payload, saved_on=None, code=None):
        """Validate a page's save request and write the finding; returns the stored record."""
        state, evidence = payload.get("state"), payload.get("evidence")
        if not isinstance(state, dict) or not isinstance(state.get("session"), str) or not state["session"]:
            raise ValueError("A finding needs the view state, including its session.")
        if not isinstance(evidence, dict) or evidence.get("session_id") != state["session"]:
            raise ValueError("A finding's evidence must be measured from the session its state names.")
        png = _png(payload["thumbnail"]) if payload.get("thumbnail") is not None else None
        finding_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(3)}"
        record = {"electro_gui_config": CONFIG_VERSION, "title": clean_title(payload.get("title")),
                  "note": clean_note(payload.get("note")), "state": state, "finding": FORMAT, "id": finding_id,
                  "tags": clean_tags(payload.get("tags")), "status": clean_status(payload.get("status")),
                  "saved_at": _now(), "saved_on": saved_on, "updated_at": None, "updated_on": None,
                  "code": code or {}, "evidence": evidence, "thumbnail": f"{finding_id}.png" if png else None}
        data = json.dumps(record, indent=1, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(data) > MAX_BYTES:  # past this, configs.py would refuse the file in a deck
            raise ValueError(f"The finding's settings and evidence come to more than {MAX_BYTES // 1024} KiB.")
        path = self._path(finding_id)
        with self.lock, self._writing():
            self.root.mkdir(parents=True, exist_ok=True)
            if png:  # the picture first, so a listed finding always has it
                self._write(path.with_suffix(".png"), png)
            try:
                self._write(path, data)
            except OSError:
                path.with_suffix(".png").unlink(missing_ok=True)
                raise
        return self.get(finding_id)

    def update(self, finding_id, patch, updated_on=None):
        """Change the title, note, tags or status; the state and evidence stay as saved."""
        frozen = sorted(set(patch) - set(EDITABLE))
        if frozen:
            raise ValueError(f"Only {', '.join(EDITABLE)} can be edited; a finding's settings and evidence stay as saved "
                             f"(not {', '.join(frozen)}).")
        cleaners = {"title": clean_title, "note": clean_note, "tags": clean_tags, "status": clean_status}
        changes = {key: cleaners[key](value) for key, value in patch.items()}
        path = self._path(finding_id)
        with self.lock, self._writing():
            if not path.is_file():
                raise KeyError(f"No finding {finding_id}")
            record = self._read(path)
            record.pop("has_thumbnail", None)
            record.update(changes, updated_at=_now(), updated_on=updated_on)
            self._write(path, json.dumps(record, indent=1, ensure_ascii=False, allow_nan=False).encode("utf-8"))
        return self.get(finding_id)

    def delete(self, finding_id):
        """Move the finding's files into ``.deleted/`` beside them."""
        path = self._path(finding_id)
        with self.lock, self._writing():
            if not path.is_file():
                raise KeyError(f"No finding {finding_id}")
            bin_ = self.root / ".deleted"
            bin_.mkdir(exist_ok=True)
            for item in (path.with_suffix(".png"), path):
                if item.is_file():
                    os.replace(item, bin_ / item.name)
        return {"deleted": finding_id}
