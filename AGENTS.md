# AGENTS.md

Standing instructions for agents working in `electrogui`.  `CLAUDE.md` is a
pointer here.  `README.md` and `electro_gui/README.md` document the tool;
`electro_gui/DESIGN.md` documents its internals.

## The dependency runs one way

electro_gui imports phys-analysis's `session_viewer`; `session_viewer` never
imports electro_gui.  Session loading (`session_viewer.store`), the explorer
arithmetic (`session_viewer.explorer_core`: alignment rows, eligible spans,
rates, the PCA / ICA / FA basis, the stable roster) and the derived-result
identity (`session_viewer.cache`) belong to phys-analysis: change them there,
run both repositories' tests, and land phys-analysis first.

## Checks

```bash
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1
MPLBACKEND=Agg PYTHONPATH=.:<phys-analysis> python -m unittest discover -s tests -t . -v
```

The tests build a synthetic session with `session_viewer.synthetic`
(`tests/fixtures.py`) and need no experimental data.

## Data and outputs

Sessions are `<root>/<Subject>_<YYYYMMDD>/session.h5`, written by
`python -m session_viewer build ...` in phys-analysis (default root on the
cluster: `/orcd/data/mjaz/001/om4/hokyung/viewer_sessions`).  What the tasks,
events, stim conditions and unit labels mean is phys-analysis's business (its
notes in phys-context); electro_gui shows them as recorded.  The cache and
findings live in `$ELECTRO_GUI_OUTPUT` (default `~/electro_gui_output`,
`electro_gui/paths.py`); keep generated outputs out of Git.  On the shared HPC
login nodes keep commands scoped and never scan `/orcd/scratch` or
`/orcd/pool`.
