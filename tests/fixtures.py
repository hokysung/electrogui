"""The synthetic session every test opens: session_viewer's ``write_session_file`` (phys-analysis).

60 trials alternating memory_saccade / pursuit_memory; events fix_on, fix, stimuli_on,
pursuit_start (odd trials), response, microstim (k % 5 == 2), sham_microstim (k % 5 == 4),
reward (k % 7 != 0), start, end, trial_start, trial_end.  Units 3 (sua, a burst 50-150 ms
after stimuli_on), 4 (noise) and 5 (mua, stable on the first 30 trials only).
"""
from pathlib import Path

from session_viewer.synthetic import write_session_file

UNITS = (3, 4, 5)
SUA, NOISE, MUA = UNITS


def synthetic_session(tmp):
    """``(path, session_id, root)`` of a fresh synthetic ``session.h5`` under ``tmp``."""
    path = write_session_file(Path(tmp))
    return path, path.parent.name, path.parent.parent
