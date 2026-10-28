"""Loopback server and bounded asynchronous computation queue."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from collections import OrderedDict
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import gzip
import hmac
import json
import mimetypes
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import threading
import time
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import session_viewer
from session_viewer import explorer_core
from session_viewer.store import SessionStore

from . import __version__
from .exports import export_csv, export_json, export_membership, export_statistics, export_svg
from .annotations import annotate_result
from .configs import discover_configs
from .findings import FindingStore
from .preview import preview
from . import explorer


class Application:
    def __init__(self, store: SessionStore, findings_dir: str | Path | None = None, config_dirs=()):
        self.store = store
        self.findings = FindingStore(findings_dir) if findings_dir is not None else None
        self.config_dirs = [Path(d).expanduser().absolute() for d in config_dirs or ()]
        self.jobs = OrderedDict()
        self.preview_jobs = OrderedDict()
        self.lock = threading.RLock()
        self.store_lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="electro-compute")
        self.preview_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="electro-preview")

    def submit(self, request):
        action = request.get("action")
        if action not in ("load", "unit", "population", "preview", "annotate", "stable_selection"):
            raise ValueError("Action must be load, unit, population, preview, annotate, or stable_selection.")
        if action == "annotate":
            base_id = request.get("completed_job_id", request.get("job_id"))
            with self.lock:
                base = self.jobs.get(base_id)
            if not base or base.get("status") != "done" or base.get("result", {}).get("kind") not in ("unit", "population"):
                raise ValueError("Annotate requires a completed unit or population job.")
            # Retain the completed snapshot while the annotation job is queued;
            # preview eviction must never make an exportable result disappear.
            base_session = base["result"].get("session_id")
            if request.get("session_id") is not None and request.get("session_id") != base_session:
                raise ValueError("Annotation session_id must match the completed result session.")
            request = dict(request, session_id=base_session, _base_result=base["result"])
        if not isinstance(request.get("session_id"), str):
            raise ValueError("Select a session before computing.")
        target = self.preview_jobs if action == "preview" else self.jobs
        with self.lock:
            if sum(j["status"] in ("queued", "running") for j in target.values()) >= (2 if action == "preview" else 4):
                raise ValueError("Four computations are already pending; wait for them to finish.")
            # Preview entries have their own bounded store and never evict exportable results.
            while len(target) >= (8 if action == "preview" else 12):
                # Keep each workspace's most recent completed result even if
                # the other workspace performs many display-only updates.
                latest = {}
                if target is self.jobs:
                    for key, completed in target.items():
                        kind = completed.get("result", {}).get("kind")
                        if completed["status"] == "done" and kind in ("unit", "population"):
                            latest[kind] = key
                protected = set(latest.values())
                oldest = next((k for k, j in target.items() if j["status"] in ("done", "error") and k not in protected), None)
                if oldest is None:
                    break
                del target[oldest]
            job_id = uuid4().hex
            target[job_id] = {"id": job_id, "status": "queued", "message": "Waiting for the local computation worker."}
        if action == "preview":
            self.preview_executor.submit(self._run_preview, job_id, request)
        else:
            self.executor.submit(self._run, job_id, request)
        return {"id": job_id}

    def _run(self, job_id, request):
        start = time.monotonic()
        with self.lock:
            job = self.jobs[job_id]
            job.update(status="running", message="Loading the session file; the first load reads its complete fingerprint.")
        self.store_lock.acquire()
        try:
            loaded = self.store.get(request["session_id"])
            if request["action"] == "load":
                result = loaded.metadata()
            elif request["action"] == "stable_selection":
                from session_viewer.explorer_core import select_stable_population
                with self.lock:
                    job["message"] = "Selecting SUA/MUA units for shared stable neuron × trial coverage."
                result = select_stable_population(loaded)
            elif request["action"] == "annotate":
                base_result = request.get("_base_result")
                if not isinstance(base_result, dict) or base_result.get("session_id") != loaded.session_id:
                    raise ValueError("Annotation source session does not match the completed result.")
                base_sha = base_result.get("provenance", {}).get("computation_identity", {}).get("source", {}).get("sha256")
                current_sha = loaded.session.source_identity().get("sha256")
                if base_sha and current_sha and base_sha != current_sha:
                    raise ValueError("Annotation source session file changed since the completed result; recompute before annotating.")
                from session_viewer.cache import computation_identity, cache_key
                package = Path(__file__).resolve().parent
                annotation_parameters = {"layers": request.get("layers", []),
                                         "base_computation_key": base_result.get("provenance", {}).get("computation_key")}
                annotation_code = [package / name for name in ("annotations.py", "exports.py", "server.py")]
                identity = computation_identity(kind="electro_gui_annotations", schema=1,
                                                source=loaded.session.source_identity(), parameters=annotation_parameters,
                                                code_paths=annotation_code)
                result = annotate_result(base_result, loaded, request.get("layers", []))
                after = computation_identity(kind="electro_gui_annotations", schema=1,
                                             source=loaded.session.source_identity(), parameters=annotation_parameters,
                                             code_paths=annotation_code)
                if identity != after:
                    raise RuntimeError("Annotation source or code changed while running; retry the annotation update.")
                result.setdefault("provenance", {}).update(annotation_job=job_id, source_path=str(loaded.session.path),
                                                          annotation_identity=identity, annotation_key=cache_key(identity))
            else:
                from session_viewer.cache import computation_identity, cache_key
                from .analysis import compute_unit
                from .population import compute_population
                code = [path for root in _PACKAGES.values() for path in root.rglob("*.py")]
                code += list(getattr(loaded, "code_paths", []))
                identity = computation_identity(kind=f"electro_gui_{request['action']}", schema=1,
                                                source=loaded.session.source_identity(), parameters=request, code_paths=code)
                with self.lock:
                    job["message"] = "Computing eligibility, event selection and numerical results from the selected session."
                result = (compute_unit if request["action"] == "unit" else compute_population)(loaded, request)
                after = computation_identity(kind=f"electro_gui_{request['action']}", schema=1,
                                             source=loaded.session.source_identity(), parameters=request, code_paths=code)
                if identity != after:
                    raise RuntimeError("Computation code changed while running; retry using the current code.")
                provenance = result.setdefault("provenance", {})
                provenance.update(version=__version__, source_path=str(loaded.session.path),
                                  computation_identity=identity, computation_key=cache_key(identity),
                                  upstream_freshness="not audited; the exact exported session.h5 is the empirical source",
                                  repository=_git_identity(_REPO),
                                  session_viewer_repository=_session_viewer_identity())
            # Reject nonfinite / unserializable payloads before claiming completion.
            json.dumps(result, allow_nan=False)
            with self.lock:
                job.update(status="done", message=f"Completed in {time.monotonic() - start:.1f} s.", result=result)
        except Exception as exc:
            with self.lock:
                job.update(status="error", message="Computation stopped.", error=f"{type(exc).__name__}: {exc}")
        finally:
            self.store_lock.release()

    def _run_preview(self, job_id, request):
        start = time.monotonic()
        with self.lock:
            job = self.preview_jobs[job_id]
            job.update(status="running", message="Preparing selection support; no spikes, counts, fits, or tests are computed.")
        self.store_lock.acquire()
        try:
            loaded = self.store.get(request["session_id"])
            result = preview(loaded, request)
            result.setdefault("provenance", {}).update(source_identity=loaded.session.source_identity(), source_path=str(loaded.session.path))
            with self.lock:
                job.update(status="done", message=f"Preview ready in {time.monotonic() - start:.1f} s.", result=result)
        except Exception as exc:
            with self.lock:
                job.update(status="error", message="Preview stopped.", error=f"{type(exc).__name__}: {exc}")
        finally:
            self.store_lock.release()

    def explore(self, what, query):
        """Synchronous explorer reads; the session must load first (a ``load`` job)."""
        def one(name, default=None):
            value = query.get(name, [default])[0]
            if value is None:
                raise ValueError(f"Missing query parameter {name!r}.")
            return value
        with self.store_lock:
            loaded = self.store.get(one("session"))
            if what == "session":
                return explorer.session_summary(loaded)
            if what == "table":
                return explorer.alignment_table(loaded, one("alignment"))
            if what == "raster":
                try:
                    unit = int(one("unit"))
                except ValueError:
                    raise ValueError("unit must be an integer ID") from None
                policy = one("policy", "verified_stable")
                if policy not in ("verified_stable", "all_complete"):
                    raise ValueError("policy must be verified_stable or all_complete")
                return explorer.unit_raster(loaded, one("alignment"), unit, policy, one("lo"), one("hi"))
            if what == "spiketrain":
                try:
                    unit = int(one("unit"))
                except ValueError:
                    raise ValueError("unit must be an integer ID") from None
                return explorer.spike_train(loaded, unit)
            if what == "events":
                return explorer.event_times(loaded, one("event"))
            if what == "behavior":
                return explorer.behavior_timeline(loaded)
            if what == "popspans":
                try:
                    ids = [int(x) for x in one("units").split(",") if x.strip()]
                except ValueError:
                    raise ValueError("units must be comma-separated integer IDs") from None
                policy = one("policy", "verified_stable")
                if policy not in ("verified_stable", "all_complete"):
                    raise ValueError("policy must be verified_stable or all_complete")
                return explorer_core.population_spans(loaded, one("alignment"), ids, policy)
            if what == "stability":
                return explorer.stability_masks(loaded)
            if what == "stable_roster":
                from session_viewer.explorer_core import select_stable_population
                return select_stable_population(loaded)
        raise KeyError("Unknown explorer endpoint")

    def population_fit(self, request):
        with self.store_lock:
            loaded = self.store.get(request.get("session_id"))
            return explorer.population_fit(loaded, request)

    def population_probe(self, request):
        with self.store_lock:
            loaded = self.store.get(request.get("session_id"))
            return explorer.population_probe(loaded, request)

    def _findings(self):
        if self.findings is None:
            raise ValueError("Findings are disabled on this server (no --findings-dir).")
        return self.findings

    def list_findings(self):
        return self._findings().list()

    def finding(self, finding_id):
        return self._findings().get(finding_id)

    def finding_thumbnail(self, finding_id):
        return self._findings().thumbnail(finding_id)

    def save_finding(self, payload):
        """A finding as the page measured it, stamped with this machine and the code that drew it.

        The reply adds ``path``, where the JSON file now is, which the page shows (the record
        itself never holds it, so it cannot end up inside the file).
        """
        code = {"electro_gui": __version__, **_git_identity(_REPO),
                "session_viewer": _session_viewer_identity()}
        saved = self._findings().create(payload, saved_on=_HOST, code=code)
        return {**saved, "path": str(self._findings().file(saved["id"]))}

    def reveal_finding(self, finding_id):
        """Select the finding's file in a Finder window on this Mac."""
        path = self._findings().file(finding_id)
        if not REVEALS:
            raise ValueError("Show in Finder works only where electro_gui runs on a Mac.")
        _reveal_in_finder(path)
        return {"revealed": str(path)}

    def change_finding(self, finding_id, request):
        if request.get("delete") is True:
            return self._findings().delete(finding_id)
        return self._findings().update(finding_id, request, updated_on=_HOST)

    def configs(self):
        """JSON config files under ``--config-dir`` (see ``configs.py``); re-scanned on every call."""
        return discover_configs(self.config_dirs)

    def snapshot(self, job_id):
        with self.lock:
            if job_id in self.jobs:
                return dict(self.jobs[job_id])
            if job_id in self.preview_jobs:
                return dict(self.preview_jobs[job_id])
            raise KeyError(job_id)

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=True)
        self.preview_executor.shutdown(wait=True, cancel_futures=True)


def _git_identity(repo):
    def run(*args):
        try:
            return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=3, check=True).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return None
    return {"commit": run("rev-parse", "HEAD"), "dirty": bool(run("status", "--porcelain", "--untracked-files=no"))}


REVEALS = sys.platform == "darwin"   # Finder is a Mac thing


def _reveal_in_finder(path):
    """``open -R``: a Finder window with ``path`` selected, on the Mac this server runs on."""
    try:
        subprocess.run(["open", "-R", str(path)], capture_output=True, timeout=10, check=True, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError(f"Could not show the file in Finder: {exc}") from exc


LOOPBACK = ("127.0.0.1", "localhost", "::1")
_HOST = socket.gethostname().split(".")[0] or None
TAILSCALE_CANDIDATES = ("tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale",
                        "/Applications/Tailscale.app/Contents/MacOS/Tailscale")


class Tailnet:
    """This node's MagicDNS name and owner login, from ``tailscale status --json``.

    ``tailscale serve --https=<p> http://127.0.0.1:<p>`` forwards a tailnet
    device's request with its ``Host`` (``<node>.ts.net:<p>``) and adds
    ``Tailscale-User-Login``; the owner of this node is let in on that alone,
    as in result-viewer and the apps dashboard.  Read lazily and retried every
    30 s until found, so a server started at boot before Tailscale is up still
    learns them.  An ``owner`` given on the command line wins.
    """

    def __init__(self, owner=None):
        self._fixed_owner = owner
        self._owner = owner
        self._dns = None
        self._checked = None  # time.monotonic() may start near 0 at process start, so no 0.0 sentinel
        self._lock = threading.Lock()

    def _read(self):
        exe = next(filter(None, (shutil.which(c) for c in TAILSCALE_CANDIDATES)), None)
        if not exe:
            print("tailnet: no tailscale CLI found; tailnet requests are refused", file=sys.stderr, flush=True)
            return None
        try:
            done = subprocess.run([exe, "status", "--json"], capture_output=True, text=True, timeout=5,
                                  stdin=subprocess.DEVNULL)
            data = json.loads(done.stdout)
            me = data["Self"]
            return me.get("DNSName", "").rstrip(".").lower() or None, data["User"][str(me["UserID"])]["LoginName"]
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
            print(f"tailnet: `{exe} status --json` failed: {exc!r}", file=sys.stderr, flush=True)
            return None

    def refresh(self):
        with self._lock:
            if self._dns and self._owner:
                return
            if self._checked is not None and time.monotonic() - self._checked < 30:
                return
            self._checked = time.monotonic()
            found = self._read()
            if found:
                self._dns = found[0]
                self._owner = self._fixed_owner or found[1]

    @property
    def owner(self):
        self.refresh()
        return self._owner

    @property
    def names(self):
        self.refresh()
        return {self._dns} if self._dns else set()
# This process's identity: a restart (POST /api/restart, then cli.run re-execs
# itself) gets a new BOOT_ID, which is how a page knows the new code is up.
BOOT_ID = uuid4().hex[:12]
STARTED = time.time()
# The two packages the explorer runs, wherever each is installed: its own and
# the session backend's (session_viewer lives in the phys-analysis repository).
_PACKAGES = {"electro_gui": Path(__file__).resolve().parent,
             "session_viewer": Path(session_viewer.__file__).resolve().parent}
_REPO = _PACKAGES["electro_gui"].parent


def _session_viewer_identity():
    """session_viewer has no version string: its install path and the git state of the repository holding it."""
    root = _PACKAGES["session_viewer"]
    return {"path": str(root), **_git_identity(root.parent)}


def code_changed_since(started=None):
    """Python files of electro_gui and session_viewer modified after this server started, as ``package/path``.

    Those are what a restart picks up; static files are read from disk on every
    request, so a page reload already gets them.
    """
    started = STARTED if started is None else started
    changed = []
    for name, root in _PACKAGES.items():
        for path in sorted(root.rglob("*.py")):
            try:
                if path.stat().st_mtime > started:
                    changed.append(f"{name}/{path.relative_to(root).as_posix()}")
            except OSError:
                pass
    return changed
_COMPRESSIBLE = ("application/json", "text/", "application/javascript", "image/svg+xml")


def make_server(application, host="127.0.0.1", port=8765, token=None, tailnet=None):
    """Serve on ``host``.  Any non-loopback host requires ``token``.

    On loopback the Host header must be local (DNS-rebinding guard).  With a
    token, a request is served only when it carries ``?token=`` (which also
    sets a same-site cookie) or that cookie, so a phone or tablet on the LAN
    can open the printed URL once and then browse normally.  With ``tailnet``
    (a :class:`Tailnet`), a request through ``tailscale serve`` from this
    node's owner needs no token: its Host must be this node's MagicDNS name
    and its ``Tailscale-User-Login`` the owner.  That header is trusted only
    on loopback, which nothing but this Mac and ``tailscale serve`` can reach.
    """
    if host not in LOOPBACK and not token:
        raise ValueError("A non-loopback --host requires an access token.")
    if host not in LOOPBACK:
        tailnet = None  # anyone on the network could send Tailscale-User-Login
    static = Path(__file__).resolve().parent / "static"

    class Handler(BaseHTTPRequestHandler):
        _set_cookie = False

        def _send(self, body, status=200, content_type="application/json; charset=utf-8", filename=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, allow_nan=False, separators=(",", ":")).encode()
            gzipped = (len(body) > 1400 and content_type.startswith(_COMPRESSIBLE)
                       and "gzip" in self.headers.get("Accept-Encoding", ""))
            if gzipped:
                body = gzip.compress(body, compresslevel=5)
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            if gzipped:
                self.send_header("Content-Encoding", "gzip")
                self.send_header("Vary", "Accept-Encoding")
            if self._set_cookie:
                self.send_header("Set-Cookie", f"electro_token={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
            if filename:
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def _local_request(self):
            # A local tool must not be callable by arbitrary websites/DNS rebinding.
            login = self.headers.get("Tailscale-User-Login") if tailnet else None
            if login is not None:
                authority = (urlsplit("http://" + self.headers.get("Host", "")).hostname or "").lower()
                if authority not in LOOPBACK and authority not in tailnet.names:
                    self._send({"error": "Unknown Host header."}, 403)
                    return False
                owner = tailnet.owner
                if not owner or not hmac.compare_digest(login.encode(), owner.encode()):
                    self._send({"error": "Only this tailnet node's owner may use electro_gui."}, 403)
                    return False
            elif token:
                offered = parse_qs(urlsplit(self.path).query).get("token", [None])[0]
                cookie = SimpleCookie(self.headers.get("Cookie", "")).get("electro_token")
                if offered and hmac.compare_digest(offered, token):
                    self._set_cookie = True
                elif not (cookie and hmac.compare_digest(cookie.value, token)):
                    self._send({"error": "Open the URL with ?token=... printed by the launcher."}, 403)
                    return False
            else:
                authority = urlsplit("http://" + self.headers.get("Host", "")).hostname
                if authority not in LOOPBACK:
                    self._send({"error": "Local Host header required."}, 403)
                    return False
            origin = self.headers.get("Origin")
            if origin and urlsplit(origin).netloc != self.headers.get("Host"):  # scheme-agnostic: https via a proxy
                self._send({"error": "Same-origin requests required."}, 403)
                return False
            return True

        def _page_is_at_localhost(self):
            # Finder opens on this Mac's screen, so only a page loaded at localhost (not through
            # tailscale serve or a LAN address, whose browser may be on another device) may ask for it.
            return (urlsplit("http://" + self.headers.get("Host", "")).hostname or "").lower() in LOOPBACK

        def do_GET(self):
            if not self._local_request():
                return
            url = urlsplit(self.path)
            try:
                if url.path == "/api/catalog":
                    sessions = application.store.catalog()
                    self._send({"version": __version__, "sessions": sessions,
                                "default_session": sessions[0]["id"] if sessions else None})
                elif url.path == "/api/health":
                    self._send({"version": __version__, "boot": BOOT_ID, "started": STARTED, "pid": os.getpid(),
                                "code_changed": code_changed_since()})
                elif url.path.startswith("/api/explorer/"):
                    self._send(application.explore(url.path.rsplit("/", 1)[1], parse_qs(url.query)))
                elif url.path == "/api/findings":
                    self._send(application.list_findings())
                elif url.path.startswith("/api/findings/"):
                    parts = url.path.strip("/").split("/")
                    if len(parts) == 3:
                        self._send(application.finding(parts[2]))
                    elif len(parts) == 4 and parts[3] == "thumbnail":
                        self._send(application.finding_thumbnail(parts[2]), content_type="image/png")
                    else:
                        raise KeyError("Unknown findings endpoint")
                elif url.path == "/api/configs":
                    self._send(application.configs())
                elif url.path.startswith("/api/jobs/"):
                    parts = url.path.strip("/").split("/")
                    if len(parts) not in (3, 4):
                        raise KeyError("Unknown job endpoint")
                    job = application.snapshot(parts[2])
                    if len(parts) == 3:
                        self._send(job)
                    elif parts[3] == "export":
                        if job["status"] != "done" or job["result"].get("kind") not in ("unit", "population"):
                            raise ValueError("An analysis must complete before export.")
                        query = parse_qs(url.query)
                        fmt = query.get("format", ["json"])[0]
                        if fmt not in ("json", "csv", "svg", "membership", "stats"):
                            raise ValueError("Export format must be json, csv, svg, membership, or stats.")
                        result = job["result"]
                        if fmt == "svg":
                            axes = tuple(int(query.get(a, [str(i)])[0]) for i, a in enumerate(("x", "y")))
                            payload = export_svg(result, axes)
                        else:
                            payload = {"json": export_json, "csv": export_csv, "membership": export_membership, "stats": export_statistics}[fmt](result)
                        ext = "csv" if fmt in ("membership", "stats") else fmt
                        mime = {"json": "application/json", "csv": "text/csv", "svg": "image/svg+xml"}[ext]
                        self._send(payload, content_type=mime, filename=f"electro_gui_{result['kind']}_{parts[2][:8]}_{fmt}.{ext}")
                    else:
                        raise KeyError("Unknown job endpoint")
                elif url.path.startswith("/api/"):
                    raise KeyError("Unknown API endpoint")
                else:
                    relative = url.path.lstrip("/")
                    if relative == "" or relative.endswith("/"):
                        relative += "index.html"
                    path = (static / relative).resolve()
                    if not path.is_relative_to(static.resolve()) or not path.is_file():
                        raise KeyError("Unknown file")
                    self._send(path.read_bytes(), content_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream")
            except KeyError as exc:
                self._send({"error": str(exc)}, 404)
            except (ValueError, OSError) as exc:
                self._send({"error": str(exc)}, 400)

        def do_POST(self):
            if not self._local_request():
                return
            try:
                route = urlsplit(self.path).path
                finding = route.startswith("/api/findings/") and route.count("/") == 3
                reveal = route.startswith("/api/findings/") and route.endswith("/reveal") and route.count("/") == 4
                if route not in ("/api/jobs", "/api/findings", "/api/explorer/popfit", "/api/explorer/popprobe", "/api/restart") \
                        and not finding and not reveal:
                    self._send({"error": "Unknown endpoint"}, 404)
                    return
                if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                    raise ValueError("JSON request required.")
                length = int(self.headers.get("Content-Length", "0"))
                # Population fits carry row IDs; a new finding carries its figure as a PNG.
                limit = 12 * 1048576 if route == "/api/findings" else 8 * 1048576 if route.startswith("/api/explorer/pop") else 262144
                if not 0 < length <= limit:
                    raise ValueError(f"Request must be between 1 byte and {limit // 1024} KiB.")
                request = json.loads(self.rfile.read(length))
                if not isinstance(request, dict):
                    raise ValueError("Request must be a JSON object.")
                if route == "/api/findings":
                    # can_reveal: whether this page may also ask for the file to be shown in Finder.
                    self._send({**application.save_finding(request), "can_reveal": REVEALS and self._page_is_at_localhost()}, 201)
                    return
                if reveal:
                    if not self._page_is_at_localhost():
                        raise ValueError("Show in Finder works only from a page opened at localhost on the Mac that runs electro_gui.")
                    self._send(application.reveal_finding(route.split("/")[3]))
                    return
                if finding:
                    self._send(application.change_finding(route.rsplit("/", 1)[1], request))
                    return
                if route == "/api/restart":
                    # Stop serving; cli.run then waits for a running computation,
                    # closes, and replaces the process with a fresh copy of itself
                    # (same command line, port and token).  A server run some
                    # other way (tests, an embedding) just stops.
                    self._send({"restarting": True, "boot": BOOT_ID}, 202)
                    self.server.restart_requested = True
                    threading.Thread(target=self.server.shutdown, name="electro-restart", daemon=True).start()
                    return
                if route == "/api/explorer/popfit":
                    self._send(application.population_fit(request))
                    return
                if route == "/api/explorer/popprobe":
                    self._send(application.population_probe(request))
                    return
                self._send(application.submit(request), 202)
            except KeyError as exc:
                self._send({"error": str(exc).strip("'\"")}, 404)
            except (ValueError, TypeError) as exc:
                self._send({"error": str(exc)}, 400)
            except OSError as exc:
                if not urlsplit(self.path).path.startswith("/api/findings"):
                    raise
                # A findings folder that cannot be written: say so rather than drop the connection.
                self._send({"error": f"Could not write to the findings folder: {exc.strerror or exc}"
                                     f"{f' ({exc.filename})' if exc.filename else ''}"}, 500)

        def log_message(self, fmt, *args):
            # Polling is intentionally quiet. The UI reports progress and errors.
            pass

    server = ThreadingHTTPServer((host, port), Handler)
    server.restart_requested = False
    return server
