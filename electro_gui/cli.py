"""Launch the local electro_gui application."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import time
import webbrowser

from . import __version__
from .paths import OUTPUT_ENV, output_root

#: Session roots, each holding <Subject>_<YYYYMMDD>/session.h5: $SESSION_VIEWER_ROOTS (os.pathsep-separated),
#: else ~/viewer_sessions.
ROOTS_ENV = "SESSION_VIEWER_ROOTS"
def default_roots():
    """``$SESSION_VIEWER_ROOTS`` split on ``os.pathsep``, else ``~/viewer_sessions``."""
    configured = os.environ.get(ROOTS_ENV)
    if configured:
        return [p for p in configured.split(os.pathsep) if p]
    return [str(Path("~/viewer_sessions").expanduser())]


# Set by _restart for the process that replaces this one: {"port": ..., "token": ...}.
RESTART_ENV = "ELECTRO_GUI_RESTART"


def add_arguments(parser):
    parser.add_argument("--version", action="version", version=f"electro_gui {__version__}")
    parser.add_argument("--data-root", action="append", help="Folder of <Subject>_<YYYYMMDD>/session.h5 exports; repeat for several "
                        f"(default: ${ROOTS_ENV}, else ~/viewer_sessions).")
    parser.add_argument("--session-file", action="append", help="One exported session.h5; repeat to add sessions.")
    parser.add_argument("--cache-dir", help=f"Disposable derived-result cache (default: ${OUTPUT_ENV}/cache, else ~/electro_gui_output/cache).")
    parser.add_argument("--port", type=int, default=8765, help="Port; 0 chooses a free port (default: %(default)s).")
    parser.add_argument("--host", default="127.0.0.1",
                        help="Interface to listen on (default: loopback only). Use --lan, or e.g. 0.0.0.0, to open it "
                             "from a tablet or phone on the same network; a random access token is then required.")
    parser.add_argument("--lan", action="store_true", help="Shorthand for --host 0.0.0.0 (tablet / phone access, token-protected).")
    parser.add_argument("--token", help="Access token for a non-loopback --host (default: random per launch).")
    parser.add_argument("--owner", metavar="LOGIN",
                        help="Tailnet login let in through tailscale serve without a token (default: this node's owner).")
    parser.add_argument("--findings-dir",
                        help="Folder of saved findings (one JSON file and one PNG each), shared by every device that opens "
                             f"this server (default: ${OUTPUT_ENV}/findings, else ~/electro_gui_output/findings).")
    parser.add_argument("--config-dir", action="append",
                        help="Directory of JSON config files for the Views menu (a deck's electro_gui_configs/, or a folder "
                             "holding decks); repeat for several. Relative to the current directory; a missing one is empty "
                             "(default: none).")
    parser.add_argument("--no-browser", action="store_true", help="Print the URL without opening a browser.")
    return parser


def _folders(args):
    """The cache, findings and config folders: the flags where given, else the output-folder defaults (paths.py)."""
    output = output_root()
    cache_dir = Path(args.cache_dir).expanduser() if args.cache_dir is not None else output / "cache"
    findings_dir = Path(args.findings_dir).expanduser() if args.findings_dir is not None else output / "findings"
    config_dirs = args.config_dir if args.config_dir is not None else []
    return cache_dir, findings_dir, config_dirs


def run(args):
    # A restart keeps the port (even one --port 0 chose) and the token (even a
    # random one), so open pages and phones reconnect, and opens no browser.
    restart = json.loads(os.environ.pop(RESTART_ENV, "") or "null")
    if restart:
        args.port, args.no_browser = int(restart["port"]), True
    cache_dir, findings_dir, config_dirs = _folders(args)
    os.environ.setdefault("MPLCONFIGDIR", str(cache_dir / "matplotlib"))
    from session_viewer.store import SessionStore
    from .server import Application, Tailnet, make_server
    roots = args.data_root if args.data_root is not None else default_roots()
    store = SessionStore(roots=roots, session_files=args.session_file or [], cache_dir=cache_dir)
    application = Application(store, findings_dir=findings_dir, config_dirs=config_dirs)
    host = "0.0.0.0" if args.lan else args.host
    token = args.token  # optional on loopback: tailscale serve lets this node's owner in without one (server.Tailnet)
    if restart and token is None:
        token = restart.get("token")
    if token is None and host not in ("127.0.0.1", "localhost", "::1"):
        token = secrets.token_urlsafe(12)
    for attempt in range(20 if restart else 1):  # the old socket may take a moment to let go
        try:
            server = make_server(application, host=host, port=args.port, token=token, tailnet=Tailnet(args.owner))
            break
        except OSError as exc:
            if attempt + 1 < (20 if restart else 1):
                time.sleep(0.5)
                continue
            application.close()
            raise SystemExit(f"Cannot start electro_gui: {exc}. Use --port 0 to choose a free port.") from None
    port = server.server_address[1]
    query = f"?token={token}" if token else ""
    specific = host not in ("0.0.0.0", "::", "", "127.0.0.1", "localhost", "::1")
    url = f"http://{host if specific else '127.0.0.1'}:{port}/{query}"
    print(f"electro_gui {__version__}: {url}", flush=True)
    if token:
        # Bound to one address, only that address answers.
        entries = [e for e in _lan_addresses() if e.split(" ")[0] == host] if specific else _lan_addresses()
        for entry in entries:
            address, _, label = entry.partition(" ")
            print(f"  tablet / phone {label}: http://{address}:{port}/{query}", flush=True)
        print("  Anyone with this URL can read the sessions it serves; stop the server when done.", flush=True)
    if host in ("127.0.0.1", "localhost", "::1"):
        print(f"  tailnet: `tailscale serve --bg --https={port} http://127.0.0.1:{port}` lets this node's owner in, "
              "no token needed.", flush=True)
    print(f"Found {len(store.catalog())} sessions in {', '.join(map(str, roots))}. Findings are saved in {application.findings.root}.", flush=True)
    print("Ctrl-C stops the server.", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever(poll_interval=.3)
    except KeyboardInterrupt:
        print("\nStopping electro_gui after any active computation finishes.", flush=True)
    finally:
        if getattr(server, "restart_requested", False):
            print("Restart requested: finishing any active computation, then restarting.", flush=True)
        server.server_close()
        application.close()
    if getattr(server, "restart_requested", False):
        _restart(port, token)


def _restart(port, token):
    """Replace this process with a fresh copy of itself, on the same port and token.

    ``exec`` keeps the PID, so a launchd ``KeepAlive`` agent, a terminal or a
    preview runner all keep the same process; the new interpreter imports the
    code now on disk.  Every descriptor but stdin/out/err is closed first, so
    open session files are not carried into the new process.
    """
    import resource
    argv = [sys.executable, *(getattr(sys, "orig_argv", None) or [sys.executable, "-m", "electro_gui", *sys.argv[1:]])[1:]]
    env = dict(os.environ, **{RESTART_ENV: json.dumps({"port": port, "token": token})})
    sys.stdout.flush()
    sys.stderr.flush()
    soft = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
    os.closerange(3, soft if 0 < soft < 65536 else 65536)
    os.execve(sys.executable, argv, env)


def _tailscale_addresses():
    """IPv4 addresses from the Tailscale CLI, when it is installed."""
    import shutil
    import subprocess
    for exe in (shutil.which("tailscale"), "/Applications/Tailscale.app/Contents/MacOS/Tailscale"):
        if exe and Path(exe).exists():
            try:
                out = subprocess.run([exe, "ip", "-4"], capture_output=True, text=True, timeout=3).stdout.split()
                return [a for a in out if a.count(".") == 3]
            except (OSError, subprocess.SubprocessError):
                return []
    return []


def _lan_addresses():
    """Best-effort addresses of this machine, labelled.

    Tailscale is recognised through its CLI, not by address: campus networks
    (MIT's included) also hand out 100.64.0.0/10 addresses.
    """
    import ipaddress
    import re
    import subprocess
    tailscale = set(_tailscale_addresses())
    found = list(tailscale)
    try:
        text = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=3).stdout
        found += re.findall(r"inet (\d+\.\d+\.\d+\.\d+)", text)
    except (OSError, subprocess.SubprocessError):
        pass
    out = []
    for address in dict.fromkeys(found):
        ip = ipaddress.ip_address(address)
        if ip.is_loopback or ip.is_link_local:
            continue
        label = "Tailscale" if address in tailscale else "local network" if ip.is_private else "campus / public network"
        out.append(f"{address} ({label})")
    name = socket.gethostname()
    if name:
        out.append(f"{name if '.' in name else name + '.local'} (local network name)")
    return out


def main(argv=None):
    parser = add_arguments(argparse.ArgumentParser(prog="electro-gui", description="Explore any unit of an exported session.h5, locally."))
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    run(args)
