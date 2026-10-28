# electro_gui internals

A loopback HTTP application serves a local interface and computes from one
exact exported `session.h5`.  No experimental data are shipped in this package.

## Internal interfaces

The session loader and the explorer arithmetic live in phys-analysis's
`session_viewer` package, and electro_gui imports them: `session_viewer.store`
(the loader below), `session_viewer.explorer_core` (alignment rows, eligible
spans, the time grid, rates, the basis fit and the stable roster) and
`session_viewer.cache` (the identity every derived result is stamped with).
No `session_viewer` module imports `electro_gui`.

`session_viewer.store.SessionStore(roots, session_files, cache_dir)` discovers
`<root>/<Subject>_<YYYYMMDD>/session.h5` files (explicit session files are also
accepted).  `catalog()` returns `{id, path}` entries, newest session first.
`get(session_id)` opens the file lazily and returns a `LoadedSession`:

- `file`: the `SessionFile`; `session`: its handle (`path`,
  `source_identity()` -> `{path, size, sha256, ...}`); `session_id`,
  `duration_s`, `cache_dir`, `code_paths`.
- `trials`: JSON-safe `{id, start, stop, complete, initiated, fixated, task,
  microstim, sham, rewarded, success, block_id, microstim_amplitude,
  target_x, ...}` rows.
- `rows`: one JSON-safe dict per recorded event: `row_id`, `t` (imec clock),
  `trial`, `event`, validity flags, every trial column, `trial_start_t`,
  `trial_end_t`, and the previous trial's `previous_task` / `previous_rewarded`.
- `fields`: registry dictionaries `{key, label, type, availability, timing,
  values?, description, timing_description, category, value_counts,
  missing_count, cardinality, units, range?, grouping_requires_bins}`.
- `units`: `{id, area, quality (sua|mua|noise), peak_channel, depth_um, n_spikes}`.
- `alignments`: the recorded events plus the pooled `stim_train`
  (`microstim` + `sham_microstim`, `explorer_core.UNION_ALIGNMENTS`).
- `spikes(unit_id)`: the unit's spike times.
- `eligibility(unit_ids, policy)`: `(set_of_common_trial_ids, provenance)`.
  `verified_stable` intersects the units' stable trials from the post-sorting
  stability check carried in the file; `all_complete` applies no stability
  filter.
- `metadata()`: source, units, fields, alignments, counts.

`analysis.compute_unit(loaded, request)` and `population.compute_population`
accept the same request: `{session_id, unit_id, alignment, pre, post, bin,
sigma, count_window:[lo,hi], stability, recipe, test}`.  Seconds throughout.
A recipe has `shared:{mode,rules}`, `cohorts:[{id,name,mode,rules}]`, `facet`,
`group_by`, `split_by`, `overlap`, `strata` (`none`, `trial`, `task`), `gate`
(`none`, `before_trial_end`) and optional `group_bins` (numeric field ->
finite ascending edges; bins are `[a, b)` except the last).  The default recipe
is one cohort per task the session lists.  Empty support is reported.

`analysis.prepare_rows(loaded, request, unit_ids)` returns
`(selected_rows, support, provenance)` and is shared by unit and population.
The full display window plus a fixed 0.4 s guard must fit in a run of
consecutive eligible trials inside the recording; sigma is at most 0.1 s.
Count intervals are half-open.  PSTHs average events within trial, then trials
equally.  Curve colours come from `analysis.COLORS` (tasks, stim / sham).

The explorer (`explorer.py`) supplies only what the browser cannot compute:
the columnar alignment table, one unit's spikes around each row with its
eligible span, event times for markers, a unit's whole spike train, the
behavior timeline (every trial's span, task, reward, stim / sham, and every
recorded event), stability bitmasks, and the population fit / probe
(PCA / ICA / FA via `explorer_core.fit_basis`, or TDR via `tdr.py` with
effect-coded categorical and boolean factors, default `task` x `microstim`).

## HTTP interface

- `GET /api/catalog`: `{version, sessions, default_session}`.
- `POST /api/jobs`: `{action: 'load'|'unit'|'population'|'preview'|'annotate'|'stable_selection', ...request}` -> `{id}`.
- `GET /api/jobs/<id>`: `{id, status: 'queued'|'running'|'done'|'error', message, result?, error?}`.
- `GET /api/jobs/<id>/export?format=json|csv|svg|membership|stats`: completed result download.
- `GET /api/explorer/{session,table,raster,events,spiketrain,behavior,popspans,stability,stable_roster}`,
  `POST /api/explorer/{popfit,popprobe}`: the explorer's synchronous reads.
- `GET|POST /api/findings...`, `GET /api/configs`, `GET /api/health`, `POST /api/restart`.

Every computed result carries `provenance.computation_identity`
(`session_viewer.cache.computation_identity`: `{kind, schema, source:{path,
size, sha256}, parameters, code}`) and its `computation_key`; a result whose
source file or code changed while it ran is refused.  Annotation layers
(`reference`, `event`, `interval`; source `recorded_events`; match
`same_trial`) are display-only: an `annotate` job never changes membership or
numbers.  Static assets are local; no CDN, remote data or cluster access.
