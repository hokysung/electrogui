"""Where electro_gui keeps its cache and findings.

* ``<output>/cache``    the derived-result cache (disposable)
* ``<output>/findings`` saved findings (JSON + PNG each)
* ``<output>/unit_annotations`` unit annotation sets for the unit browser (``--annotations-dir``;
                        ``unit_sets.py``)
* ``<output>/traces``   voltage snippets the trace page fetched from the cluster (disposable,
                        capped at 1 GB; ``session_viewer.trace_fetch``)

``<output>`` is ``$ELECTRO_GUI_OUTPUT``, else ``~/electro_gui_output``.
``--cache-dir`` and ``--findings-dir`` replace one folder each.  Figure
configs for the Views menu come only from ``--config-dir``.
"""
from __future__ import annotations

import os
from pathlib import Path

OUTPUT_ENV = "ELECTRO_GUI_OUTPUT"
DEFAULT_OUTPUT = Path("~/electro_gui_output")


def output_root() -> Path:
    """``$ELECTRO_GUI_OUTPUT``, else ``~/electro_gui_output``."""
    configured = os.environ.get(OUTPUT_ENV)
    return Path(configured).expanduser() if configured else DEFAULT_OUTPUT.expanduser()
