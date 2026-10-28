# electro_gui 0.2

A local application for exploring one exported `session.h5` of Hokyung's
oculomotor sessions, one unit at a time as a raster over a PSTH (**Rasters**)
or many neurons at once as a heatmap, component time courses and trajectories
(**Population**).  The **Rasters | Population** switch beside the logo (in the
⋯ menu on a phone) flips between them; both share the alignment, filters,
groups, markers, window and templates.  Display computations run in the
browser, so display knobs redraw immediately.  It works on a desktop, a tablet
or a phone.  The application contains no experimental data.

## Launch

```bash
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1   # shared login nodes
ELECTRO_GUI_OUTPUT=~/electro_gui_output python -m electro_gui --data-root ~/viewer_sessions
python -m electro_gui --no-browser --port 0      # any free port; open the printed URL
electro-gui --version                            # after pip install -e .
```

This serves `http://127.0.0.1:8765` (loopback only).  Stop it with Ctrl-C.

**Sessions** are `<root>/<Subject>_<YYYYMMDD>/session.h5`, written by
phys-analysis's `python -m session_viewer build <session_dir> --stream
imec0:<sorting>:<area> --root <root>`.  The roots are `--data-root` (repeatable),
else `$SESSION_VIEWER_ROOTS` (`:`-separated), else `~/viewer_sessions`;
`--session-file` adds one file.  A file whose embedded session ID differs from
its folder name is refused.

**Folders** (`electro_gui/paths.py`):

| what | default |
|---|---|
| `--cache-dir` | `$ELECTRO_GUI_OUTPUT/cache`, else `~/electro_gui_output/cache` |
| `--findings-dir` | `$ELECTRO_GUI_OUTPUT/findings`, else `~/electro_gui_output/findings` |
| `--config-dir` | none (repeatable; a missing directory is empty) |

### From the Mac, a tablet or a phone

On the cluster, run the server on the login node and tunnel its port:
`ssh -N -L 8765:127.0.0.1:8765 <login-node>`, then open
`http://127.0.0.1:8765/` on the Mac.  `--lan` listens on every interface and
prints a URL with a random `?token=` (a cookie keeps the device in for 30 days;
`--token` fixes it).  Through `tailscale serve --bg --https=8765
http://127.0.0.1:8765` this node's tailnet owner gets in without a token
(`--owner LOGIN` names another); other users, tagged devices and a foreign
`Host` get 403, and the identity header is trusted only on loopback.

**Restart server** (⋯ menu) re-executes the server in place (same PID, port and
token) to load new Python code; it says whether any `.py` file under
`electro_gui/` or `session_viewer/` changed since the start.  Static files are
read from disk on every request, so they need only a page reload.

## Explorer (the default page)

A figure card — title (`unit · ch · area · quality`), a legend of groups, the
raster over the PSTH, window-rate bars — beside a control panel (a bottom sheet
with Filter / Group / Markers / Display tabs on narrow screens).

- **Unit and alignment.**  `‹ ›` (or ← / →) step through units; the picker
  searches by unit ID, peak channel or area and filters by quality (sua and mua
  by default; noise on request) and area.  The alignment picker lists every
  recorded event with its candidate count, grouped as Stim, Stimulus,
  Eye & response, Reward and Trial; `stim_train` pools `microstim` and
  `sham_microstim` onsets.  The default is `fix_on`; a session without it opens
  on the first alignment with events.
- **Filter.**  Task, stim, sham and rewarded are one-tap chips with live counts.
  *Filter on any field* opens a searchable list (Task, Stimulation, Previous
  trial, Timing, Advanced) with category chips or a numeric range.  A filter on a
  field the current alignment lacks is kept, shown dashed, and ignored.
- **Group & sort.**  *Colour*, *Line style* and *Panels* each take any field;
  their product defines the groups (default: colour by task).  Tasks have fixed
  colours (fixation grey, memory saccade blue, pursuit green, pursuit memory
  magenta, overlap saccade violet, reveal orange, freeview light grey); stim is
  orange and no-stim grey; rewarded green and unrewarded red.  Numbers with at
  most 12 integer values group by value, others by quantile bins (2–5).  Click a
  legend entry to hide a group, double-click to show only it, right-click
  (long-press) to set its colour and dash.  Rows sort by session order, spikes
  in the count window, a marker's latency or any field.
- **Markers.**  A recorded event matched to each row in the same trial
  (nearest, first after, last before, or all); optionally *shade until* a second
  event.  Rows show a dot; the PSTH shows the median.  Presets: fixation point
  on, target on, response, reward, stim train onset.  Markers never change which
  events are counted.
- **Display.**  Window (−10 to 10 s), count window (or drag across the PSTH),
  bin 5–200 ms, Gaussian σ 0–100 ms, error band (SEM, 95% CI, none), averaging
  over events or trials, eligibility (*stable for unit*: the post-sorting
  stability check carried in the file; or *all complete*), tick style, raster
  height and a locked y-maximum.

### Behavior timeline and pinned trials

Below the raster, **Behavior** draws the session on its own clock: trial bands
shaded by task (a dashed line and label at each task change; ✕ after the number
if incomplete), a *Stim / sham* lane (▲ stim train, △ sham), a *Trial events*
lane (one tick per recorded event coloured by kind, ● reward, a red × at the end
of a complete unrewarded trial), an *aligned* strip with every row of the
current alignment coloured by its raster group, the current unit's whole spike
train (no eligibility rule; one tick per pixel column shaded by count), and the
whole session with the visible window boxed.  Hover an event for its name and
time in the trial, a trial for its task, reward, stim and event sequence.

- **Zoom** with the *trials* slider, pinch or ctrl-scroll; **pan** by dragging,
  swiping, `‹ ›` or the session strip.
- **Pin** by clicking a raster row, an event or a trial: the trial stays
  highlighted in every raster panel, and the pin chip says how many of its rows
  are in the raster or why none are.  `Esc` or its `×` clears it.
- **Yoke to rasters** restricts the rasters, PSTHs, counts and exports to the
  timeline's trials (at least 20), recorded as `yoked_trials` in exports.

## Population (the Population switch)

- **Neurons.**  *Shared-stable SUA + MUA* (the greedy search for the most
  neurons × stable trials they all share, `explorer_core.select_stable_population`),
  *All SUA*, *All SUA + MUA*, SUA per area, or a checklist.  Under *stable for
  unit*, a population uses only trials stable for every neuron.
- **Groups and fit.**  The groups are the raster view's (filters × colour ×
  line style).  One PCA, ICA or FA basis (`session_viewer.explorer_core.fit_basis`)
  is fitted to all groups' condition-time means jointly, or **TDR**: single-event
  rates regressed on chosen factors (default `task` and `microstim`; categories
  and booleans effect-coded, numbers z-scored), one axis per factor at its peak
  time, denoised in the leading PCs and orthogonalised.  Every event is
  re-checked on the server against the common-trial eligibility rule.
- **Figure.**  Trajectories (2D or 3D), component time courses, a neuron × time
  heatmap with loadings, variance explained per component and cumulatively, a
  time cursor, and an optional single-trial cloud projected with the fitted
  basis.  Exports: SVG/PNG, coordinates, loadings, the cloud and a settings &
  fit JSON.

The fit is descriptive and in-sample: no held-out prediction, no significance
test, no claim that a component is a latent variable.

### What the numbers mean

Rows are events on complete trials with finite times inside the recording; a
display window padded by a fixed 0.4 s guard must lie inside the run of
consecutive eligible trials containing the event.  PSTH bins are half-open
`[a, b)`; rates are counts / bin; the Gaussian kernel is sampled at the bin
spacing to ceil(4σ / bin) bins.  *Average over events* weights every row
equally; *trials* averages within a trial first.  SEM is SD (ddof 1) / √n.
`tests/test_electro_gui_explorer.py` checks the browser PSTH against
`analysis.compute_unit`.  Nothing corrects for browsing many units, windows or
groupings.  Rasters with more than about four rows per pixel are thinned for
drawing only.

### Views, links and export

- **Templates** (Views menu) keep the session and unit: *Target on, by task*,
  *Stim vs sham at train onset*, *Reward, by task*, *Fixation on, rewarded vs
  not*, *Pursuit start*.
- **Links.**  The address bar holds the complete view (`#s=…`).
- **Export**: SVG (settings and source SHA256 in `<metadata>`), PNG, PSTH CSV,
  rows CSV and settings JSON.

### Findings

**Save** keeps the figure with a title, notes, tags and a status (*lead*,
*checking*, *supported*, *dropped*; your judgement, never set by the program),
its exact settings, its picture and its evidence: the session ID and the
session file's SHA256 and size, the unit's ID, peak channel, area, quality and
spike count (or every neuron's), the support line and each group's events,
trials and count-window rate (or the fit's diagnostics).  **Reopening** redraws
it and lists every difference (another file checksum, a unit that changed,
moved support or rates, settings the page could not restore).  The
**Findings page** (`/findings/`) lists, searches and edits them.  Each finding
is `<id>.json` + `<id>.png` in `--findings-dir`, written atomically; deleting
moves them to `.deleted/`.  *Show in Finder* works only when the server runs on
a Mac and the page is at localhost; otherwise copy the path.

### Config files

A config file is a JSON view state: `{"electro_gui_config": 1, "title": ...,
"hint": ..., "group": ..., "slide": ..., "note": ..., "state": {...}}` (only
the version and `state` are required).  Views → **Config files** lists every
`*.json` (and `*/electro_gui_configs/*.json`) under `--config-dir`, re-scanned
each time; **Open config file…** applies one from disk.  The GUI's settings
export, a bare state object and a saved finding are accepted as they are.
`state` passes the same validation as a link.

```json
{"electro_gui_config": 1, "title": "Unit 12: target on by task", "group": "Example neurons",
 "state": {"session": "Nielsen_20261015", "unit": 12, "align": "stimuli_on", "color": "task",
           "win": [-1, 1.5], "cw": [0.05, 0.25]}}
```

### API

`GET /api/catalog`, `GET /api/health`, `POST /api/restart`;
`GET /api/explorer/session|table|raster|events|behavior|spiketrain|popspans|stability|stable_roster`
and `POST /api/explorer/popfit|popprobe`; `POST /api/jobs` (`load`, `unit`,
`population`, `preview`, `annotate`, `stable_selection`) with `GET /api/jobs/<id>`
and `/api/jobs/<id>/export?format=json|csv|svg|membership|stats`;
`GET /api/configs`; `GET|POST /api/findings…`.  A session must first be opened
with a `load` job.  Responses are gzip-compressed when the client accepts it.
Details in [DESIGN.md](DESIGN.md).

## Verification

```bash
MPLBACKEND=Agg PYTHONPATH=.:<phys-analysis> python -m unittest discover -s tests -t . -v
```
