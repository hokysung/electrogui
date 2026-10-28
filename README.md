# electro_gui

An interactive raster / PSTH and population explorer for Hokyung's oculomotor
monkey sessions (fixation, memory saccade, pursuit, FEF microstimulation with
ACC / DMFC recording): a raster over a PSTH with filters, grouping, sorting,
markers and instant display knobs; a behavior timeline of trials, tasks, stim
trains and events; findings (a saved figure with its notes, picture and
numbers, re-checked when reopened); and a Population view that fits one
PCA / ICA / FA / TDR basis across a neuron roster.  The manual is
[electro_gui/README.md](electro_gui/README.md); the internals are in
[electro_gui/DESIGN.md](electro_gui/DESIGN.md).

## Data

One file per session, `<root>/<Subject>_<YYYYMMDD>/session.h5`, exported on the
cluster by phys-analysis's `session_viewer` package:

```bash
python -m session_viewer build /orcd/data/mjaz/001/om4/hokyung/monkey_data/Nielsen/20261015 \
    --stream imec0:ms5_lar_v6:ACC --root ~/viewer_sessions
```

It holds the trial table (task, stim/sham, reward, targets, latencies), every
event on the imec clock, the units (sua / mua / noise from UnitRefine, area,
peak channel, depth), their spikes, and each unit's stable trials from the
post-sorting stability check.  electro_gui only reads it.

## Install

electro_gui needs `session_viewer` (phys-analysis) importable, plus numpy,
h5py, pandas, pyarrow, scikit-learn and matplotlib:

```bash
pip install -e <phys-analysis>        # or: export PYTHONPATH=<phys-analysis>
pip install -e .
```

## Run

```bash
ELECTRO_GUI_OUTPUT=~/electro_gui_output python -m electro_gui --data-root ~/viewer_sessions
python -m electro_gui --lan      # token-protected, for a tablet or phone
tailscale serve --bg --https=8765 http://127.0.0.1:8765   # tailnet, owner only, no token
```

Session roots default to `$SESSION_VIEWER_ROOTS` (`:`-separated), else
`~/viewer_sessions`; `--data-root` (repeatable) and `--session-file` add
others.  The cache and findings go to `$ELECTRO_GUI_OUTPUT/{cache,findings}`,
else `~/electro_gui_output/`.  Figure configs for the Views menu come only from
`--config-dir`.  On a shared login node set
`OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1` first.

## Tests

```bash
MPLBACKEND=Agg PYTHONPATH=.:<phys-analysis> python -m unittest discover -s tests -t . -v
```

They build a synthetic session with `session_viewer.synthetic.write_session_file`
(`tests/fixtures.py`) and need no experimental data; node, when installed, runs
the browser-side checks of `static/core.js`.
