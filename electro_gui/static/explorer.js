/* electro_gui explorer UI.  Computations live in core.js (EGCore). */
(() => {
  'use strict';
  const C = window.EGCore;
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const clone = v => JSON.parse(JSON.stringify(v));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const tidy = (v, d = 3) => Number(Number(v).toFixed(d));
  const f1 = v => Math.round(v * 10) / 10;
  const VERSION = '0.2';
  const MAX_NCOMP = 50;   // explorer.MAX_COMPONENTS; the slider covers 2-10, the number box the rest
  const TC_SHOWN = 8;     // on screen, more component time courses than this scroll in a fixed-height box
  const SPLIT_MIN = 240;  // px either side of the draggable trajectory | time-course divider

  // Spikes are fetched with this margin beyond the window: 4 sigma (<= 0.4 s) plus one bin (<= 0.2 s).
  const PAD = 0.65;
  const DASHES = ['', '6 4', '1.6 3', '9 3 2 3', '14 4', '3 3'];
  const INK = 'ink';

  // --------------------------------------------------------------- names
  const EVENT_NAMES = {
    fix_on: 'fixation point on', fix: 'fixation acquired', stimuli_on: 'target on', stimuli_off: 'target off',
    memory: 'memory period', response_wait: 'response window', response: 'response',
    pursuit_on: 'pursuit target on', pursuit_start: 'pursuit start', pursuit_end: 'pursuit end', pursuit_off: 'pursuit target off',
    wait_fix_off: 'wait for fixation off', feedback: 'feedback', reward: 'reward', failure: 'failure', break_fix: 'fixation break',
    microstim: 'stim train onset', sham_microstim: 'sham train onset', stim_train: 'stim or sham train onset',
    induced_saccade: 'stim-induced saccade', sham_induced_saccade: 'sham-period saccade', stim_blink: 'stim blink',
    sham_blink: 'sham blink', photodiode_on: 'photodiode on', start: 'MWorks trial start', end: 'MWorks trial end',
    trial_start: 'trial start (first event)', trial_end: 'trial end (last event)',
  };
  const eventLabel = e => EVENT_NAMES[e] || C.humanize(e);
  const PINNED_ALIGN = ['fix_on', 'stimuli_on', 'pursuit_start', 'response', 'reward', 'stim_train', 'microstim', 'sham_microstim'];
  function eventCategory(e) {
    if (/(microstim|stim_train|^stim_|^sham_|induced_saccade)/.test(e)) return 'Stim';
    if (/^(stimuli|pursuit_on|pursuit_off|memory|photodiode)/.test(e)) return 'Stimulus';
    if (/^(reward|feedback|failure)/.test(e)) return 'Reward';
    if (/^(fix|response|pursuit|saccade|break_fix|wait_fix|blink)/.test(e)) return 'Eye & response';
    return 'Trial';
  }
  const CATEGORY_ORDER = ['Stim', 'Stimulus', 'Eye & response', 'Reward', 'Trial'];

  const COMMON_FIELDS = ['task', 'microstim', 'sham', 'rewarded'];
  const QUICK_FIELDS = ['task', 'microstim', 'sham', 'rewarded'];
  function fieldGroup(col) {
    if (COMMON_FIELDS.includes(col.key) || col.key === 'success' || col.key === 'block_id') return 'Task';
    if (col.relative) return 'Timing (s from event)';
    if (/^previous_/.test(col.key)) return 'Previous trial';
    if (/^microstim|stim/.test(col.key)) return 'Stimulation';
    return 'Advanced';
  }
  const FIELD_GROUP_ORDER = ['Task', 'Stimulation', 'Previous trial', 'Timing (s from event)', 'Advanced'];

  // -------------------------------------------------------------- colours
  const TASK_COLORS = {fixation: '#495057', memory_saccade: '#1971c2', pursuit: '#2f9e44', reveal: '#f08c00',
    overlap_saccade: '#9c36b5', freeview: '#868e96', pursuit_memory: '#c2255c'};   // electro_gui/analysis.py TASK_COLORS
  const SEM = {
    task: TASK_COLORS,
    microstim: {true: '#e8590c', false: '#495057'},
    sham: {true: '#495057', false: '#e8590c'},
    rewarded: {true: '#2f9e44', false: '#e03131'},
  };
  SEM.previous_task = SEM.task;
  SEM.previous_rewarded = SEM.rewarded;
  const PALETTE = ['#1c7ed6', '#f08c00', '#2b8a3e', '#e03131', '#7048e8', '#0c8599', '#d6336c', '#5c940d', '#495057', '#e8590c'];
  const RAMP = ['#74c0fc', '#339af0', '#1c7ed6', '#1864ab', '#0b3d74'];
  const MISSING_COLOR = '#adb5bd';
  const MARKER_COLORS = [INK, '#0b7285', '#e8590c', '#ae3ec9', '#1971c2', '#f59f00', '#c2255c', '#2f9e44'];

  function mix(hex, other, amount) {
    const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const a = p(hex), b = p(other);
    return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * amount).toString(16).padStart(2, '0')).join('');
  }
  const isDark = () => document.documentElement.dataset.theme === 'dark';
  const figVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function paint(hex) {
    if (hex === INK) return figVar('--fig-ink');
    return isDark() ? mix(hex, '#ffffff', 0.18) : hex;
  }
  function groupColor(g, grouping, table) {
    if (!grouping.colorField) return grouping.nStyles > 1 ? figVar('--fig-ink') : paint('#3b5bdb');
    if (g.colorKey === C.MISSING) return paint(MISSING_COLOR);
    const sem = SEM[grouping.colorField];
    if (sem && sem[g.colorKey]) return paint(sem[g.colorKey]);
    const col = table.byKey.get(grouping.colorField);
    if (col && col.kind === 'num') {
      const k = Math.max(1, grouping.nColors - (grouping.hasMissingColor ? 1 : 0));
      const idx = Math.round((k === 1 ? 0.5 : g.colorIndex / (k - 1)) * (RAMP.length - 1));
      return paint(RAMP[clamp(idx, 0, RAMP.length - 1)]);
    }
    if (col && col.kind === 'cat' && col.levels.length === 2 && col.levels[0] === false) return paint(g.colorKey === 'true' ? '#1c7ed6' : '#f08c00');
    return paint(PALETTE[g.colorIndex % PALETTE.length]);
  }

  // ---------------------------------------------------------------- state
  const RASTER_MIN = 80, RASTER_MAX = 700, RASTER_FIT_MIN = 120, PSTH_MIN = 80, PSTH_MAX = 500;
  const DEFAULTS = {
    session: null, unit: null, align: 'fix_on', policy: 'verified_stable',
    win: [-1.5, 1], cw: [-0.5, 0], bin: 0.02, sigma: 0.04, weight: 'event', err: 'sem',
    filters: [], color: 'task', style: null, panel: null, qbins: 3, hidden: [],
    sort: 'session', dir: 1, grouped: true, markers: [], refs: [], medians: true,
    tick: 'line', rasterH: 260, rasterFit: true, psthH: 205, ylock: null, bars: true, unitQ: ['sua', 'mua'], unitArea: [], gstyle: {},
    mode: 'raster', roster: [], method: 'pca', scaling: 'zscore', ncomp: 3, tdrFactors: ['task', 'microstim'], tdrWin: null, dims: '2', heatNorm: 'z',
    nsort: 'loading:0', axes: [0, 1, 2], heatGroup: null, cloud: false, cloudAlpha: 0.3, cloudZero: true, cloudFit: 'traj',
    bt: true, btN: 16, pin: null, yoke: false, popSplit: 0.5,
  };
  const DISPLAY_DEFAULTS = {win: [-1.5, 1], cw: [-0.5, 0], bin: 0.02, sigma: 0.04, weight: 'event', err: 'sem', tick: 'line', rasterH: 260, rasterFit: true, psthH: 205, ylock: null, bars: true, popSplit: 0.5};
  let S = clone(DEFAULTS);

  const TEMPLATES = [
    {name: 'Target on, by task', hint: 'aligned to target onset, colour = task', state: {
      align: 'stimuli_on', filters: [], color: 'task', style: null, panel: null, win: [-1, 1.5], cw: [0.05, 0.25],
      markers: [{e: 'fix_on', match: 'trial', occ: 'last_before', label: 'fixation point on', c: INK}]}},
    {name: 'Stim vs sham at train onset', hint: 'stim and sham trains pooled, colour = stimulated', state: {
      align: 'stim_train', filters: [], color: 'microstim', style: null, panel: null, win: [-0.5, 1.0], cw: [0, 0.3]}},
    {name: 'Reward, by task', hint: 'aligned to reward, colour = task', state: {
      align: 'reward', filters: [], color: 'task', style: null, panel: null, win: [-1, 1], cw: [0, 0.5]}},
    {name: 'Fixation on, rewarded vs not', hint: 'aligned to the fixation point, colour = rewarded', state: {
      align: 'fix_on', filters: [], color: 'rewarded', style: null, panel: null, win: [-0.5, 2], cw: [0, 0.5],
      markers: [{e: 'stimuli_on', match: 'trial', occ: 'first_after', label: 'target on', c: INK}]}},
    {name: 'Pursuit start', hint: 'aligned to pursuit start, colour = task', state: {
      align: 'pursuit_start', filters: [], color: 'task', style: null, panel: null, win: [-1, 1.5], cw: [0, 0.5]}},
  ];

  const D = {
    catalog: [], summary: null, units: [], tables: new Map(), rasters: new Map(), events: new Map(),
    inflight: new Map(), sessionToken: 0, layout: null, model: null, findings: [], configs: [], fatal: null,
    unitMap: new Map(), popspans: new Map(), stab: null, fits: new Map(), fitErrors: new Map(), fitPending: null,
    heatCache: new Map(), view3d: {yaw: -0.6, pitch: 0.35}, cursor: null, playTimer: 0, popLayout: null, popFit: null, popModel: null,
    probes: new Map(), probeErrors: new Map(), probePending: null, probeShown: null, popReq: null,
    behavior: null, behaviorError: null, btC: null, btLayout: null, btDrag: null,
    trains: new Map(), trainErrors: new Map(),   // unit id -> spike times (s) for the timeline's spike lane
  };

  function sanitize(raw) {
    const s = {...clone(DEFAULTS), ...(raw && typeof raw === 'object' ? raw : {})};
    const pair = (v, d) => (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) && v[0] < v[1] ? v : d);
    s.win = pair(s.win, DEFAULTS.win); s.win = [clamp(s.win[0], -10, -0.05), clamp(s.win[1], 0.05, 10)];
    s.cw = pair(s.cw, DEFAULTS.cw);
    s.bin = Number.isFinite(s.bin) ? clamp(s.bin, 0.005, 0.2) : DEFAULTS.bin;
    s.sigma = Number.isFinite(s.sigma) ? clamp(s.sigma, 0, 0.1) : DEFAULTS.sigma;
    for (const [k, allowed] of Object.entries({weight: ['event', 'trial'], err: ['sem', 'ci', 'none'], policy: ['verified_stable', 'all_complete'], tick: ['line', 'dot']}))
      if (!allowed.includes(s[k])) s[k] = DEFAULTS[k];
    for (const k of ['filters', 'hidden', 'markers', 'refs', 'unitQ', 'unitArea']) if (!Array.isArray(s[k])) s[k] = clone(DEFAULTS[k]);
    s.markers = s.markers.filter(m => m && typeof m.e === 'string').map((m, i) => ({id: m.id || `m${i + 1}`, match: 'trial', occ: 'nearest', c: INK, ...m}));
    s.refs = s.refs.filter(Number.isFinite);
    s.rasterH = Number.isFinite(s.rasterH) ? clamp(s.rasterH, RASTER_MIN, RASTER_MAX) : DEFAULTS.rasterH;
    s.rasterFit = s.rasterFit !== false;
    s.psthH = Number.isFinite(s.psthH) ? clamp(Math.round(s.psthH), PSTH_MIN, PSTH_MAX) : DEFAULTS.psthH;
    s.qbins = [2, 3, 4, 5].includes(Number(s.qbins)) ? Number(s.qbins) : 3;
    s.dir = s.dir === -1 ? -1 : 1;
    if (!s.gstyle || typeof s.gstyle !== 'object' || Array.isArray(s.gstyle)) s.gstyle = {};
    for (const [k, allowed] of Object.entries({mode: ['raster', 'population'], method: ['pca', 'ica', 'fa', 'tdr'], scaling: ['zscore', 'center'], dims: ['2', '3'], heatNorm: ['z', 'peak'], cloudFit: ['traj', 'cloud']}))
      if (!allowed.includes(String(s[k]))) s[k] = DEFAULTS[k]; else s[k] = String(s[k]);
    s.roster = Array.isArray(s.roster) ? [...new Set(s.roster.filter(Number.isInteger))].sort((a, b) => a - b) : [];
    s.ncomp = Number.isInteger(s.ncomp) ? clamp(s.ncomp, 2, MAX_NCOMP) : DEFAULTS.ncomp;
    s.tdrFactors = Array.isArray(s.tdrFactors) ? [...new Set(s.tdrFactors.filter(k => typeof k === 'string'))].slice(0, 10) : clone(DEFAULTS.tdrFactors);
    s.tdrWin = Array.isArray(s.tdrWin) && s.tdrWin.length === 2 && s.tdrWin.every(Number.isFinite) && s.tdrWin[0] < s.tdrWin[1] ? s.tdrWin : null;
    s.popSplit = Number.isFinite(s.popSplit) ? clamp(s.popSplit, 0.15, 0.85) : DEFAULTS.popSplit;
    s.axes = Array.isArray(s.axes) && s.axes.length === 3 && s.axes.every(Number.isInteger) ? s.axes : clone(DEFAULTS.axes);
    if (typeof s.nsort !== 'string') s.nsort = DEFAULTS.nsort;
    s.cloud = s.cloud === true; s.cloudZero = s.cloudZero !== false;
    s.cloudAlpha = Number.isFinite(s.cloudAlpha) ? clamp(s.cloudAlpha, 0.05, 1) : DEFAULTS.cloudAlpha;
    s.bt = s.bt !== false;
    s.yoke = s.yoke === true;
    s.btN = Number.isInteger(s.btN) ? clamp(s.btN, 3, 5000) : DEFAULTS.btN;
    const p = s.pin;
    s.pin = p && typeof p === 'object' && Number.isInteger(p.trial)
      ? {trial: p.trial, uid: typeof p.uid === 'string' ? p.uid : null, row: Number.isInteger(p.row) ? p.row : null, t: Number.isFinite(p.t) ? p.t : null}
      : null;
    return s;
  }
  function clampCw() {
    const [pre, post] = S.win;
    let [a, b] = S.cw;
    a = clamp(a, pre, post); b = clamp(b, pre, post);
    if (b - a < 0.01) { a = clamp(Math.min(a, post - 0.05), pre, post); b = clamp(a + 0.05, pre, post); }
    S.cw = [tidy(a), tidy(b)];
  }
  let saveTimer = 0;
  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { history.replaceState(null, '', `${location.pathname}#s=${C.encodeState(S)}`); } catch (e) { /* hash too long */ }
      try { localStorage.setItem('eg-state', JSON.stringify(S)); } catch (e) { /* private mode */ }
    }, 250);
  }
  function loadState() {
    let parsed = null;
    const m = location.hash.match(/[#&]s=([^&]+)/);
    if (m) { try { parsed = C.decodeState(m[1]); } catch (e) { toast('Could not read the view in this link; using defaults.', true); } }
    if (!parsed) { try { parsed = JSON.parse(localStorage.getItem('eg-state') || 'null'); } catch (e) { parsed = null; } }
    S = sanitize(parsed);
  }

  // ------------------------------------------------------------- network
  let busyCount = 0;
  function busy(delta) { busyCount = Math.max(0, busyCount + delta); $('busy').hidden = busyCount === 0; }
  async function getJSON(path, options) {
    busy(1);
    try {
      const response = await fetch(path, options);
      const body = await response.json().catch(() => ({error: `HTTP ${response.status}`}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      return body;
    } finally { busy(-1); }
  }
  const query = obj => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  function once(key, factory) {
    if (!D.inflight.has(key)) D.inflight.set(key, factory().finally(() => D.inflight.delete(key)));
    return D.inflight.get(key);
  }
  const rasterKey = () => `${S.unit}|${S.align}|${S.policy}`;
  function fetchWindow() {
    return [clamp(Math.floor((S.win[0] - PAD) * 2) / 2 - 0.5, -11, 0), clamp(Math.ceil((S.win[1] + PAD) * 2) / 2 + 0.5, 0, 11)];
  }
  function rasterCovers(r) { return r && r.lo <= S.win[0] - PAD + 1e-9 && r.hi >= S.win[1] + PAD - 1e-9; }

  async function ensureData() {
    if (!D.summary || S.unit === null) return;
    const sid = D.summary.session_id, token = D.sessionToken;
    const jobs = [];
    const align = S.align;
    if (!D.tables.has(align)) {
      jobs.push(once(`t|${align}`, async () => {
        const raw = await getJSON(`/api/explorer/table?${query({session: sid, alignment: align})}`);
        if (token === D.sessionToken) D.tables.set(align, C.prepareTable(raw));
      }));
    }
    const key = rasterKey();
    if (S.mode === 'population') {
      if (!D.stab) {
        jobs.push(once('stab', async () => {
          const raw = await getJSON(`/api/explorer/stability?${query({session: sid})}`);
          if (token === D.sessionToken) D.stab = decodeStability(raw);
        }));
      }
      const pkey = popSpansKey();
      if (S.roster.length && !D.popspans.has(pkey)) {
        const units = S.roster.join(','), policy = S.policy;
        jobs.push(once(`p|${pkey}`, async () => {
          const raw = await getJSON(`/api/explorer/popspans?${query({session: sid, alignment: align, units, policy})}`);
          if (token !== D.sessionToken) return;
          D.popspans.set(pkey, raw);
          if (D.popspans.size > 8) D.popspans.delete(D.popspans.keys().next().value);
        }));
      }
    } else if (!rasterCovers(D.rasters.get(key))) {
      const [lo, hi] = fetchWindow();
      const unit = S.unit, policy = S.policy;
      jobs.push(once(`r|${key}|${lo}|${hi}`, async () => {
        const raw = await getJSON(`/api/explorer/raster?${query({session: sid, alignment: align, unit, policy, lo, hi})}`);
        if (token !== D.sessionToken) return;
        raw.spikesT = raw.spikes.map(a => Float64Array.from(a));
        delete raw.spikes;
        D.rasters.set(key, {lo, hi, data: raw});
        if (D.rasters.size > 8) D.rasters.delete(D.rasters.keys().next().value);
      }));
    }
    if (S.mode === 'raster' && S.bt && !D.behavior && !D.behaviorError) {
      jobs.push(once('behavior', async () => {
        try {
          const raw = await getJSON(`/api/explorer/behavior?${query({session: sid})}`);
          if (token === D.sessionToken) D.behavior = C.prepareBehavior(raw);
        } catch (e) {
          if (token === D.sessionToken) { D.behaviorError = e.message; renderBehavior(); }
          throw e;
        }
      }));
    }
    if (S.mode === 'raster' && S.bt && !D.trains.has(S.unit) && !D.trainErrors.has(S.unit)) {
      const unit = S.unit;
      jobs.push(once(`s|${unit}`, async () => {
        try {
          const raw = await getJSON(`/api/explorer/spiketrain?${query({session: sid, unit})}`);
          if (token !== D.sessionToken) return;
          D.trains.set(unit, C.decodeSpikeTrain(raw));
          if (D.trains.size > 6) D.trains.delete(D.trains.keys().next().value);
        } catch (e) {
          if (token === D.sessionToken) D.trainErrors.set(unit, e.message);   // shown in the lane, not retried
        }
      }));
    }
    for (const m of S.markers) for (const e of [m.e, m.end]) {
      if (!e || D.events.has(e)) continue;
      jobs.push(once(`e|${e}`, async () => {
        const raw = await getJSON(`/api/explorer/events?${query({session: sid, event: e})}`);
        if (token === D.sessionToken) D.events.set(e, C.indexEvents(raw));
      }));
    }
    if (!jobs.length) return;
    schedule();
    const results = await Promise.allSettled(jobs);
    const failed = results.find(r => r.status === 'rejected');
    if (failed) toast(failed.reason.message, true);
    if (token === D.sessionToken) { renderStructure(); schedule(); }
  }

  async function selectSession(sid) {
    const token = ++D.sessionToken;
    if (S.session !== sid) S.pin = null;   // trial IDs belong to one session
    S.session = sid;
    D.summary = null; D.tables.clear(); D.rasters.clear(); D.events.clear(); D.model = null;
    D.popspans.clear(); D.stab = null; D.fits.clear(); D.fitErrors.clear(); D.heatCache.clear(); D.popFit = null; D.popLayout = null; stopPlay();
    D.probes.clear(); D.probeErrors.clear(); D.probeShown = null;
    D.behavior = null; D.behaviorError = null; D.btC = null; D.btLayout = null; D.trains.clear(); D.trainErrors.clear();
    $('sessionSelect').value = sid;
    showLoading(`Opening ${sid}`, 'The first open of a session reads and fingerprints its session.h5. After that, units, alignments and knobs respond immediately.');
    try {
      const job = await getJSON('/api/jobs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action: 'load', session_id: sid})});
      const t0 = Date.now();
      for (;;) {
        const j = await getJSON(`/api/jobs/${job.id}`);
        if (token !== D.sessionToken) return;
        if (j.status === 'error') throw new Error(j.error || 'Session load failed');
        if (j.status === 'done') break;
        showLoading(`Opening ${sid}`, `${j.message} (${Math.round((Date.now() - t0) / 1000)} s)`);
        await sleep(700);
      }
      const summary = await getJSON(`/api/explorer/session?${query({session: sid})}`);
      if (token !== D.sessionToken) return;
      D.summary = summary;
      D.units = summary.units.map(u => ({...u, rate: u.n_spikes / Math.max(1, summary.duration_s)}));
      D.unitMap = new Map(D.units.map(u => [u.id, u]));
      fitStateToSession(summary);
      D.fatal = null;
      for (const n of summary.notices || []) toast(n);
      saveState();
      renderHeader();
      await ensureData();
    } catch (e) {
      if (token !== D.sessionToken) return;
      D.fatal = e.message;
      showEmpty('Could not open this session', esc(e.message));
    }
  }

  // Make S drawable with this session: a neuron, unit, alignment or marker event it does not have is dropped or
  // replaced.  Fine for a link; a reopened finding reports every one of these (see openFinding).
  function fitStateToSession(summary) {
    S.roster = S.roster.filter(id => D.unitMap.has(id));
    if (!D.units.some(u => u.id === S.unit)) S.unit = (unitList()[0] || D.units[0]).id;
    S.align = fallbackAlign(summary.alignments, S.align);
    // A saved marker on an event this session does not offer would 404.
    S.markers = S.markers.filter(m => [m.e, m.end].every(e => !e || unionAlignments(summary).includes(e) || summary.events.includes(e)));
  }

  // The alignment to draw: the wanted one if this session has events on it, else fix_on; an alignment only
  // counts when it has events, so failing both, the first one that does.
  function fallbackAlign(alignments, wanted) {
    const has = key => alignments.some(a => a.key === key && a.n > 0);
    for (const key of [wanted, 'fix_on']) if (has(key)) return key;
    const any = alignments.find(a => a.n > 0);
    return any ? any.key : 'fix_on';
  }
  // Pooled alignments (stim_train = microstim + sham_microstim): listed as alignments, not as recorded events.
  function unionAlignments(summary) {
    if (!summary) return [];
    return summary.alignments.filter(a => a.n > 0 && !summary.events.includes(a.key)).map(a => a.key);
  }

  // --------------------------------------------------------------- model
  function activeFilters(T) { return S.filters.filter(f => T.byKey.has(f.k)); }
  function validField(T, key) { return key && T.byKey.has(key) ? key : null; }

  function buildModel() {
    const T = D.tables.get(S.align);
    const R = D.rasters.get(rasterKey());
    if (!T || !rasterCovers(R) || R.data.n !== T.n) return null;
    const raster = R.data;
    if (yokeWanted() && !D.behavior && !D.behaviorError) return null;   // the yoked trials come from the timeline
    const yoke = yokeRange();
    const [pre, post] = S.win;
    clampCw();
    const elig = C.eligibility(raster, pre, post);
    const fmask = C.filterMask(T, activeFilters(T));
    const rows = [], excl = {1: 0, 2: 0, 3: 0};
    let filtered = 0, yoked = 0;
    for (let i = 0; i < T.n; i++) {
      if (!fmask[i]) { filtered++; continue; }
      if (yoke && !yoke.ids.has(T.trial[i])) { yoked++; continue; }
      if (elig[i]) excl[elig[i]]++; else rows.push(i);
    }
    const spec = {color: validField(T, S.color), style: validField(T, S.style), panel: validField(T, S.panel), qbins: S.qbins};
    const grouping = C.groupRows(T, rows, spec);
    grouping.hasMissingColor = grouping.groups.some(g => g.colorKey === C.MISSING);
    const hidden = new Set(S.hidden);
    const spikes = raster.spikesT, spikesOf = i => spikes[i];
    const grid = C.psthGrid(pre, post, S.bin, S.sigma);
    const cw = S.cw;
    const markerData = {};
    for (const m of S.markers) {
      if (m.off) continue;
      const start = D.events.get(m.e), end = m.end ? D.events.get(m.end) : null;
      if (!start || (m.end && !end)) continue;
      markerData[m.id] = C.markerTimes(T, rows, start, m, end);
    }
    // Per-row smoothed curves depend only on the unit's spikes and the grid, so
    // filtering, grouping, sorting and markers reuse them.
    const curveKey = `${rasterKey()}|${R.lo}|${R.hi}|${pre}|${post}|${S.bin}|${S.sigma}`;
    if (!D.curves || D.curves.key !== curveKey) D.curves = {key: curveKey, map: new Map()};
    const curveMap = D.curves.map;
    const curveOf = i => { let c = curveMap.get(i); if (!c) { c = C.rowCurve(spikes[i], grid); curveMap.set(i, c); } return c; };
    const counts = new Map();
    const count = i => { if (!counts.has(i)) counts.set(i, C.countIn(spikes[i], cw[0], cw[1])); return counts.get(i); };
    const ctx = {count, markers: markerData};
    for (const g of grouping.groups) {
      g.hidden = hidden.has(g.key);
      const own = S.gstyle[g.key] || {};
      g.color = own.c ? paint(own.c) : groupColor(g, grouping, T);
      g.dash = Number.isInteger(own.d) ? DASHES[own.d % DASHES.length] : DASHES[g.styleIndex % DASHES.length];
      g.sorted = C.sortRows(T, g.rows, S.sort, S.dir, ctx);
      if (!g.hidden) {
        g.psth = C.psthFromCurves(g.rows, curveOf, T.trial, grid.n, S.weight);
        g.rate = C.windowRates(g.rows, spikesOf, T.trial, cw[0], cw[1], S.weight);
      }
    }
    const visible = grouping.groups.filter(g => !g.hidden);
    const errMul = S.err === 'ci' ? 1.96 : S.err === 'sem' ? 1 : 0;
    let ymax = 0;
    for (const g of visible) for (let j = 0; j < grid.n; j++) {
      const v = g.psth.mean[j] + errMul * (g.psth.sem[j] || 0);
      if (Number.isFinite(v)) ymax = Math.max(ymax, v);
    }
    ymax = S.ylock || niceMax(Math.max(1, ymax * 1.06));
    const unit = D.units.find(u => u.id === S.unit) || raster.unit;
    return {T, raster, rows, grouping, visible, grid, cw, excl, filtered, markerData, ctx, ymax, errMul, unit, pre, post, spikes, elig, fmask,
      yoke, yoked, yokeKey: yoke ? yoke.key : null};
  }
  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  function niceTicks(lo, hi, target) {
    const span = hi - lo, raw = span / Math.max(1, target);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw) || 10 * p;
    const out = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(tidy(v, 6));
    return out;
  }

  // -------------------------------------------------------------- figure
  function unitName(u) {
    if (!u) return 'unit —';
    return `unit ${u.id}${u.peak_channel !== null && u.peak_channel !== undefined ? ` · ch ${u.peak_channel}` : ''}`;
  }
  const shortSession = id => { const m = /^sub-([^_]+)_ses-(\d{4})_(\d{2})_(\d{2})(.*)$/.exec(id); return m ? `${m[1]} · ${m[2]}-${m[3]}-${m[4]}${m[5]}` : id; };
  const policyText = () => (S.policy === 'verified_stable' ? 'stable trials' : 'all complete trials');

  /**
   * Build the figure SVG. Returns {svg, layout}. opts.export adds a title and legend
   * and inlines everything so the file stands alone.
   */
  function figureSVG(M, width, opts = {}) {
    const ink = figVar('--fig-ink'), muted = figVar('--fig-muted'), gridC = figVar('--fig-grid'),
      axisC = figVar('--fig-axis'), windowC = figVar('--fig-window'), bg = figVar('--fig-bg');
    const narrow = width < 560;
    const font = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif';
    const panels = M.grouping.panels.filter(p => M.visible.some(g => g.panel === p.key));
    if (!panels.length) panels.push({key: '', label: ''});
    const nP = panels.length;
    const cols = nP > 1 ? Math.max(1, Math.min(nP, Math.floor((width + 26) / 236))) : 1;
    const nRowsP = Math.ceil(nP / cols);
    const showN = S.grouped;
    const ml = narrow ? 42 : 52, mr = showN ? (narrow ? 30 : 38) : 10;
    const gapX = 26, gapY = 26;
    const rasterH = rasterHeight(narrow);
    const psthH = psthHeight(narrow);
    const titleH = nP > 1 ? 22 : 4;
    const markerLabelH = S.medians && Object.keys(M.markerData).length ? 14 : 0;
    const xAxisH = 40;
    const panelW = (width - (cols - 1) * gapX) / cols;
    const plotW = Math.max(60, panelW - ml - mr);
    let header = '', top = 0;
    if (opts.export) {
      const legendLines = exportLegend(M, width, font, ink, muted);
      header = `<text x="0" y="16" font-size="14" font-weight="600" fill="${ink}">${esc(opts.title)}</text>` +
        `<text x="0" y="34" font-size="11.5" fill="${muted}">${esc(opts.subtitle)}</text>` +
        `<g transform="translate(0,46)">${legendLines.svg}</g>`;
      top = 52 + legendLines.height;
    }
    const panelH = titleH + rasterH + 10 + markerLabelH + psthH + xAxisH;
    const height = top + nRowsP * panelH + (nRowsP - 1) * gapY;
    const [pre, post] = [M.pre, M.post];
    const out = [];
    const layout = {panels: [], pre, post, ymax: M.ymax, width, height};
    const f = v => f1(v);
    panels.forEach((p, pi) => {
      const cx = (pi % cols) * (panelW + gapX), cy = top + Math.floor(pi / cols) * (panelH + gapY);
      const x0 = cx + ml, x1 = x0 + plotW;
      const X = t => x0 + (t - pre) / (post - pre) * plotW;
      const rTop = cy + titleH, rBot = rTop + rasterH;
      const pTop = rBot + 10 + markerLabelH, pBot = pTop + psthH;
      const Y = v => pBot - clamp(v / M.ymax, 0, 1.02) * psthH;
      const gs = M.visible.filter(g => g.panel === p.key);
      const L = {key: p.key, x0, x1, plotW, rTop, rBot, pTop, pBot, blocks: [], groups: gs};
      layout.panels.push(L);
      if (nP > 1) out.push(`<text x="${f(x0)}" y="${f(cy + 14)}" font-size="12.5" font-weight="600" fill="${ink}">${esc(p.label)}</text>`);

      // ---- raster
      let blocks;
      if (S.grouped) blocks = gs.map(g => ({g, rows: g.sorted}));
      else {
        const all = C.sortRows(M.T, gs.flatMap(g => g.rows), S.sort, S.dir, M.ctx);
        const owner = new Map(); gs.forEach(g => g.rows.forEach(i => owner.set(i, g)));
        blocks = [{g: null, rows: all, owner}];
      }
      const total = blocks.reduce((a, b) => a + b.rows.length, 0);
      const cap = Math.max(300, Math.round(rasterH * 4));
      if (total > cap) {
        blocks.forEach(b => { b.all = b.rows.length; b.rows = C.thin(b.rows, Math.max(1, Math.round(b.rows.length * cap / total))); });
        L.thinned = {shown: blocks.reduce((a, b) => a + b.rows.length, 0), total};
      }
      const nRows = blocks.reduce((a, b) => a + b.rows.length, 0);
      const gap = S.grouped ? 3 : 0;
      const rowH = (rasterH - gap * Math.max(0, blocks.length - 1)) / Math.max(1, nRows);
      const cw0 = X(clamp(M.cw[0], pre, post)), cw1 = X(clamp(M.cw[1], pre, post));
      out.push(`<rect x="${f(cw0)}" y="${f(rTop)}" width="${f(cw1 - cw0)}" height="${rasterH}" fill="${windowC}" opacity="${isDark() ? 0.55 : 0.5}"/>`);
      const markers = S.markers.filter(m => !m.off && M.markerData[m.id]);
      let y = rTop;
      const tickH = Math.min(9, Math.max(1, rowH * 0.8));
      const bandPaths = new Map(), tickPaths = new Map(), dotPaths = new Map();
      for (const b of blocks) {
        const blockTop = y;
        b.rows.forEach((i, k) => {
          const yc = y + (k + 0.5) * rowH;
          const g = b.g || b.owner.get(i);
          const spikes = M.spikes[i];
          let d = tickPaths.get(g) || '';
          if (S.tick === 'dot') {
            const r = f(Math.min(1.5, Math.max(0.55, rowH * 0.42)));
            for (let s = C.lowerBound(spikes, pre); s < spikes.length && spikes[s] < post; s++)
              d += `M${f(X(spikes[s]) - r)} ${f(yc)}a${r} ${r} 0 1 0 ${f(2 * r)} 0a${r} ${r} 0 1 0 ${f(-2 * r)} 0`;
          } else {
            for (let s = C.lowerBound(spikes, pre); s < spikes.length && spikes[s] < post; s++)
              d += `M${f(X(spikes[s]))} ${f(yc - tickH / 2)}v${f(tickH)}`;
          }
          tickPaths.set(g, d);
          for (const m of markers) {
            const hits = M.markerData[m.id][i];
            if (!hits) continue;
            for (const h of hits) {
              if (m.end && Number.isFinite(h.t2)) {
                const a = clamp(h.t, pre, post), z = clamp(h.t2, pre, post);
                if (z > a) bandPaths.set(m, (bandPaths.get(m) || '') + `M${f(X(a))} ${f(yc - rowH / 2)}H${f(X(z))}v${f(Math.max(rowH, 0.6))}H${f(X(a))}Z`);
              }
              if (h.t >= pre && h.t <= post) {
                const r = f(clamp(rowH * 0.55, 1.1, 2.6));
                dotPaths.set(m, (dotPaths.get(m) || '') + `M${f(X(h.t) - r)} ${f(yc)}a${r} ${r} 0 1 0 ${f(2 * r)} 0a${r} ${r} 0 1 0 ${f(-2 * r)} 0`);
              }
            }
          }
        });
        const h = b.rows.length * rowH;
        L.blocks.push({g: b.g, owner: b.owner, rows: b.rows, top: blockTop, rowH, height: h});
        if (b.g) {
          out.push(`<rect x="${f(x0 - 7)}" y="${f(blockTop)}" width="3" height="${f(Math.max(h, 1))}" rx="1.5" fill="${b.g.color}"/>`);
          if (showN && h >= 10) out.push(`<text x="${f(x1 + 5)}" y="${f(blockTop + h / 2 + 3.5)}" font-size="10" fill="${b.g.color}">${b.all || b.rows.length}</text>`);
        }
        y += h + gap;
      }
      for (const [m, d] of bandPaths) out.push(`<path d="${d}" fill="${paint(m.c)}" opacity="0.16"/>`);
      for (const [g, d] of tickPaths) {
        if (!d) continue;
        out.push(S.tick === 'dot' ? `<path d="${d}" fill="${g.color}"/>` : `<path d="${d}" stroke="${g.color}" stroke-width="${rowH < 1.5 ? 0.9 : 1.1}" fill="none"/>`);
      }
      for (const [m, d] of dotPaths) out.push(`<path d="${d}" fill="${paint(m.c)}" stroke="${bg}" stroke-width="0.5"/>`);
      if (!nRows) out.push(`<text x="${f((x0 + x1) / 2)}" y="${f(rTop + rasterH / 2)}" text-anchor="middle" font-size="12" fill="${muted}">no events</text>`);
      const zeroX = X(0);
      if (pre < 0 && post > 0) out.push(`<line x1="${f(zeroX)}" x2="${f(zeroX)}" y1="${f(rTop)}" y2="${f(rBot)}" stroke="${ink}" stroke-width="1" stroke-dasharray="2 3" opacity="0.7"/>`);
      for (const r of S.refs) if (r > pre && r < post) out.push(`<line x1="${f(X(r))}" x2="${f(X(r))}" y1="${f(rTop)}" y2="${f(rBot)}" stroke="${muted}" stroke-width="1" stroke-dasharray="5 3"/>`);
      out.push(`<text transform="translate(${f(x0 - 16)},${f((rTop + rBot) / 2)}) rotate(-90)" text-anchor="middle" font-size="11" fill="${muted}">${L.thinned ? `events (${L.thinned.shown} of ${L.thinned.total} drawn)` : 'events'}</text>`);

      // ---- PSTH
      const yt = niceTicks(0, M.ymax, psthH > 180 ? 5 : 4);
      for (const v of yt) out.push(`<line x1="${f(x0)}" x2="${f(x1)}" y1="${f(Y(v))}" y2="${f(Y(v))}" stroke="${gridC}" stroke-width="1"/>`);
      out.push(`<rect x="${f(cw0)}" y="${f(pTop)}" width="${f(cw1 - cw0)}" height="${psthH}" fill="${windowC}" opacity="${isDark() ? 0.55 : 0.6}"/>`);
      if (pre < 0 && post > 0) out.push(`<line x1="${f(zeroX)}" x2="${f(zeroX)}" y1="${f(pTop)}" y2="${f(pBot)}" stroke="${ink}" stroke-width="1" stroke-dasharray="2 3" opacity="0.7"/>`);
      for (const r of S.refs) if (r > pre && r < post) out.push(`<line x1="${f(X(r))}" x2="${f(X(r))}" y1="${f(pTop)}" y2="${f(pBot)}" stroke="${muted}" stroke-width="1" stroke-dasharray="5 3"/>`);
      // marker medians
      if (S.medians) {
        let li = 0;
        for (const m of markers) {
          const rowsHere = gs.flatMap(g => g.rows);
          const med = C.median(rowsHere.map(i => (M.markerData[m.id][i] && M.markerData[m.id][i][0] ? M.markerData[m.id][i][0].t : NaN)));
          if (!(med >= pre && med <= post)) continue;
          const mx = X(med), c = paint(m.c);
          out.push(`<line x1="${f(mx)}" x2="${f(mx)}" y1="${f(pTop - markerLabelH + 2)}" y2="${f(pBot)}" stroke="${c}" stroke-width="1.2" stroke-dasharray="4 3"/>`);
          const anchor = mx > x1 - 110 ? 'end' : 'start';
          out.push(`<text x="${f(mx + (anchor === 'end' ? -4 : 4))}" y="${f(pTop - markerLabelH + 10 + (li % 2) * 11)}" font-size="10.5" fill="${c}" text-anchor="${anchor}">${esc(m.label || eventLabel(m.e))} (median)</text>`);
          for (const g of gs) {
            const gm = C.median(g.rows.map(i => (M.markerData[m.id][i] && M.markerData[m.id][i][0] ? M.markerData[m.id][i][0].t : NaN)));
            if (gm >= pre && gm <= post) out.push(`<path d="M${f(X(gm) - 3.5)} ${f(pTop)}h7l-3.5 5z" fill="${g.color}"/>`);
          }
          li++;
        }
      }
      out.push(`<g clip-path="url(#clip${pi})">`);
      out.push(`<clipPath id="clip${pi}"><rect x="${f(x0)}" y="${f(pTop - 2)}" width="${f(plotW)}" height="${f(psthH + 2)}"/></clipPath>`);
      const times = M.grid.times;
      for (const g of gs) {
        if (!M.errMul || g.psth.n < 2) continue;
        let d = '';
        for (let j = 0; j < times.length; j++) d += `${j ? 'L' : 'M'}${f(X(times[j]))} ${f(Y(g.psth.mean[j] + M.errMul * g.psth.sem[j]))}`;
        for (let j = times.length - 1; j >= 0; j--) d += `L${f(X(times[j]))} ${f(Y(Math.max(0, g.psth.mean[j] - M.errMul * g.psth.sem[j])))}`;
        out.push(`<path d="${d}Z" fill="${g.color}" opacity="${isDark() ? 0.22 : 0.15}"/>`);
      }
      for (const g of gs) {
        let d = '';
        for (let j = 0; j < times.length; j++) d += `${j ? 'L' : 'M'}${f(X(times[j]))} ${f(Y(g.psth.mean[j]))}`;
        out.push(`<path d="${d}" fill="none" stroke="${g.color}" stroke-width="${narrow ? 1.8 : 2}" stroke-linejoin="round" stroke-linecap="round"${g.dash ? ` stroke-dasharray="${g.dash}"` : ''}/>`);
      }
      out.push('</g>');
      // axes
      out.push(`<line x1="${f(x0)}" x2="${f(x0)}" y1="${f(pTop)}" y2="${f(pBot)}" stroke="${axisC}"/>`);
      out.push(`<line x1="${f(x0)}" x2="${f(x1)}" y1="${f(pBot)}" y2="${f(pBot)}" stroke="${axisC}"/>`);
      for (const v of yt) out.push(`<text x="${f(x0 - 6)}" y="${f(Y(v) + 3.5)}" text-anchor="end" font-size="10.5" fill="${muted}">${C.fmtNum(v)}</text>`);
      const xt = niceTicks(pre, post, Math.max(3, Math.round(plotW / 80)));
      for (const v of xt) {
        out.push(`<line x1="${f(X(v))}" x2="${f(X(v))}" y1="${f(pBot)}" y2="${f(pBot + 4)}" stroke="${axisC}"/>`);
        out.push(`<text x="${f(X(v))}" y="${f(pBot + 16)}" text-anchor="middle" font-size="10.5" fill="${muted}">${C.fmtNum(v)}</text>`);
      }
      out.push(`<text x="${f((x0 + x1) / 2)}" y="${f(pBot + 33)}" text-anchor="middle" font-size="11.5" fill="${ink}">time from ${esc(eventLabel(S.align))} (s)</text>`);
      out.push(`<text transform="translate(${f(cx + 11)},${f((pTop + pBot) / 2)}) rotate(-90)" text-anchor="middle" font-size="11.5" fill="${ink}">spikes/s</text>`);
      if (!opts.export) {
        out.push(`<rect class="hit" data-kind="raster" data-p="${pi}" x="${f(x0)}" y="${f(rTop)}" width="${f(plotW)}" height="${rasterH}" fill="transparent"/>`);
        out.push(`<rect class="hit" data-kind="psth" data-p="${pi}" x="${f(x0)}" y="${f(pTop)}" width="${f(plotW)}" height="${psthH}" fill="transparent"/>`);
        // The raster | PSTH divider: drag to trade height between them, double-click to reset the PSTH.
        const gapH = pTop - rBot, gy = rBot + gapH / 2;
        out.push(`<rect class="hit rsplit" data-kind="rsplit" data-p="${pi}" x="${f(x0)}" y="${f(rBot)}" width="${f(plotW)}" height="${f(gapH)}" fill="transparent"/>`,
          `<rect class="rgrip" x="${f((x0 + x1) / 2 - 22)}" y="${f(gy - 2.5)}" width="44" height="5" rx="2.5" pointer-events="none"/>`);
      }
    });
    const meta = opts.export ? `<metadata>${esc(JSON.stringify(provenance(M)))}</metadata>` : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.ceil(height)}" viewBox="0 0 ${width} ${Math.ceil(height)}" font-family="${font}">` +
      meta + (opts.export ? `<rect x="-20" y="-20" width="${width + 40}" height="${Math.ceil(height) + 40}" fill="${bg}"/>` : '') +
      header + out.join('') + (opts.export ? '' : '<g id="pinLayer" pointer-events="none"></g><g id="hoverLayer" pointer-events="none"></g>') + '</svg>';
    return {svg, layout};
  }

  function exportLegend(M, width, font, ink, muted) {
    let x = 0, y = 0;
    const parts = [];
    for (const g of M.visible) {
      const text = `${g.label}${g.panelLabel ? ` (${g.panelLabel})` : ''} · n=${g.psth.n}`;
      const w = 34 + text.length * 6.1 + 16;
      if (x + w > width && x > 0) { x = 0; y += 18; }
      parts.push(`<line x1="${x}" x2="${x + 26}" y1="${y + 6}" y2="${y + 6}" stroke="${g.color}" stroke-width="2.2"${g.dash ? ` stroke-dasharray="${g.dash}"` : ''}/>` +
        `<text x="${x + 32}" y="${y + 10}" font-size="11" fill="${ink}">${esc(text)}</text>`);
      x += w;
    }
    return {svg: parts.join(''), height: y + 18};
  }

  function barsSVG(M, width, height) {
    const ink = figVar('--fig-ink'), muted = figVar('--fig-muted'), gridC = figVar('--fig-grid'), axisC = figVar('--fig-axis');
    const gs = M.visible.filter(g => g.rate && g.rate.n);
    if (!gs.length) return '';
    const f = f1;
    const labelOf = g => g.label + (g.panelLabel ? ` · ${g.panelLabel}` : '');
    const ml = 36, mr = 6, mt = 26;
    const slotsGuess = gs.length + (new Set(gs.map(g => g.panel)).size - 1) * 0.6;
    const longestLine = Math.max(...gs.map(g => Math.max(...labelOf(g).split(' · ').map(x => x.length))));
    const many = gs.length > 6 || longestLine * 5.3 > (width - ml - mr) / slotsGuess * 0.96;
    const longest = Math.max(...gs.map(g => labelOf(g).length));
    const mb = many ? Math.min(130, 22 + longest * 4.3) : 22 + 11 * Math.max(...gs.map(g => Math.min(3, labelOf(g).split(' · ').length)));
    const w = width - ml - mr, h = Math.max(60, height - mt - mb);
    let max = 0;
    for (const g of gs) max = Math.max(max, g.rate.mean + (M.errMul || 1) * (g.rate.sem || 0));
    max = niceMax(Math.max(1, max * 1.08));
    const Y = v => mt + h - v / max * h;
    const panelsSeen = [];
    gs.forEach(g => { if (!panelsSeen.includes(g.panel)) panelsSeen.push(g.panel); });
    const slots = gs.length + (panelsSeen.length - 1) * 0.6;
    const step = w / slots, bw = Math.min(46, step * 0.72);
    const out = [];
    out.push(`<text x="0" y="12" font-size="11.5" font-weight="600" fill="${ink}">rate in [${C.fmtNum(M.cw[0])}, ${C.fmtNum(M.cw[1])}) s</text>`);
    for (const v of niceTicks(0, max, 4)) {
      out.push(`<line x1="${ml}" x2="${ml + w}" y1="${f(Y(v))}" y2="${f(Y(v))}" stroke="${gridC}"/>`);
      out.push(`<text x="${ml - 5}" y="${f(Y(v) + 3.5)}" text-anchor="end" font-size="10" fill="${muted}">${C.fmtNum(v)}</text>`);
    }
    let slot = 0, lastPanel = gs[0].panel;
    gs.forEach(g => {
      if (g.panel !== lastPanel) { slot += 0.6; lastPanel = g.panel; }
      const cx = ml + (slot + 0.5) * step;
      slot += 1;
      const top = Y(g.rate.mean), e = (M.errMul || 1) * (g.rate.sem || 0);
      const light = g.dash ? 0.45 : 0.88;
      out.push(`<rect x="${f(cx - bw / 2)}" y="${f(top)}" width="${f(bw)}" height="${f(mt + h - top)}" rx="2" fill="${g.color}" opacity="${light}"${g.dash ? ` stroke="${g.color}" stroke-dasharray="${g.dash}" stroke-width="1.4"` : ''}/>`);
      if (g.rate.n > 1) out.push(`<path d="M${f(cx)} ${f(Y(g.rate.mean + e))}V${f(Y(Math.max(0, g.rate.mean - e)))}M${f(cx - 4)} ${f(Y(g.rate.mean + e))}h8M${f(cx - 4)} ${f(Y(Math.max(0, g.rate.mean - e)))}h8" stroke="${ink}" stroke-width="1.2" fill="none"/>`);
      out.push(`<text x="${f(cx)}" y="${f(mt + h - 4)}" text-anchor="middle" font-size="9.5" fill="${light > 0.6 ? '#fff' : ink}">${g.rate.n}</text>`);
      const lines = labelOf(g).split(' · ');
      if (many) out.push(`<text transform="translate(${f(cx + 3)},${f(mt + h + 10)}) rotate(-40)" text-anchor="end" font-size="9.5" fill="${muted}">${esc(lines.join(' · '))}</text>`);
      else lines.slice(0, 3).forEach((line, k) => out.push(`<text x="${f(cx)}" y="${f(mt + h + 13 + k * 11)}" text-anchor="middle" font-size="9.5" fill="${muted}">${esc(line)}</text>`));
    });
    out.push(`<line x1="${ml}" x2="${ml + w}" y1="${f(mt + h)}" y2="${f(mt + h)}" stroke="${axisC}"/>`);
    out.push(`<text transform="translate(10,${f(mt + h / 2)}) rotate(-90)" text-anchor="middle" font-size="10.5" fill="${muted}">spikes/s (mean ± ${S.err === 'ci' ? '95% CI' : 'SEM'})</text>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif">${out.join('')}</svg>`;
  }

  // -------------------------------------------------------------- render
  // requestAnimationFrame coalesces slider drags; the timer covers hidden tabs, where frames never fire.
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    const run = () => { if (!pending) return; pending = false; render(); };
    requestAnimationFrame(run);
    setTimeout(run, 80);
  }
  function changed({data = false, structure = false} = {}) {
    saveState();
    if (structure) renderStructure();
    syncControls();
    if (data) ensureData();
    schedule();
  }

  function renderHeader() {
    const u = D.units.find(x => x.id === S.unit);
    $('unitLabel').textContent = u ? `${u.id}${u.peak_channel !== null && u.peak_channel !== undefined ? ` · ch ${u.peak_channel}` : ''}` : '—';
    $('unitBtn').title = u ? `${unitName(u)} · ${u.area || 'area ?'} · ${u.quality}` : '';
    $('rosterLabel').textContent = S.roster.length ? `${S.roster.length} neurons` : 'no neurons';
    const a = D.summary && D.summary.alignments.find(x => x.key === S.align);
    $('alignLabel').textContent = eventLabel(S.align) + (a ? ` · ${a.n}` : '');
  }

  function render() {
    renderHeader();
    if (D.fatal || !D.summary) { checkFinding(); return; }
    if (S.mode === 'population') { D.layout = null; renderPopulation(); checkFinding(); return; }
    renderRaster();
    drawPin();
    renderBehavior();
    fitRaster();  // after the timeline, so a just-collapsed panel is measured as collapsed
    checkFinding();
  }
  // Raster height.  On a desktop window it follows the window by default ("fit"): each
  // render measures where the behavior timeline ends and resizes the rasters so it ends at
  // the window's bottom edge.  Dragging the divider above the timeline (or the slider)
  // fixes an explicit height; double-clicking the divider returns to fit.
  const fitsWindow = () => S.rasterFit && !matchMedia('(max-width: 959px)').matches;
  function rasterHeight(narrow = false) {
    if (fitsWindow() && D.fitRasterH) return D.fitRasterH;
    return Math.round(S.rasterH * (narrow ? 0.8 : 1));
  }
  // Phones draw the PSTH at 170/205 of the stored height, as they always have.
  const psthHeight = (narrow = false) => Math.round(S.psthH * (narrow ? 170 / 205 : 1));
  const panelRows = L => (L ? new Set(L.panels.map(p => p.rTop)).size : 1) || 1;
  function fitRaster() {
    if (!fitsWindow() || S.mode !== 'raster' || !D.layout || $('figure').classList.contains('stale')) { D.fitPasses = 0; D.fitPrev = null; return; }
    const bottom = $('behavior').getBoundingClientRect().bottom + scrollY;
    const excess = bottom - (innerHeight - 14);
    const current = rasterHeight();
    // The page grows by about one pixel per raster pixel per panel row, more when the
    // side bar chart (which scales with the figure) is the taller column; take the slope
    // measured since the previous pass when there is one.
    const prev = D.fitPrev, rows = panelRows(D.layout);
    const slope = prev && Math.abs(current - prev.h) >= 1 ? clamp((bottom - prev.bottom) / (current - prev.h), 0.5 * rows, 4 * rows) : rows;
    const next = Math.round(clamp(current - excess / slope, RASTER_FIT_MIN, RASTER_MAX));
    if (Math.abs(next - current) >= 2 && (D.fitPasses || 0) < 6) {
      D.fitPasses = (D.fitPasses || 0) + 1; D.fitPrev = {h: current, bottom}; D.fitRasterH = next; schedule();
    } else { D.fitPasses = 0; D.fitPrev = null; if (!D.fitRasterH) D.fitRasterH = current; }
    syncRasterOut();
  }
  function syncRasterOut() {
    const h = rasterHeight();
    $('rasterH').value = h;
    $('rasterHOut').textContent = fitsWindow() ? `fit · ${h} px` : `${S.rasterH} px`;
    $('btSplit').title = fitsWindow() ? 'Drag to resize the rasters (fitted to the window now); double-click to fit again' : 'Drag to resize the rasters; double-click to fit them to the window';
  }

  function renderRaster() {
    const M = buildModel();
    const fig = $('figure');
    if (!M) {
      if (D.model && fig.querySelector('svg')) fig.classList.add('stale');
      else showLoading('Loading raster…', '');
      return;
    }
    fig.classList.remove('stale');
    D.model = M;
    $('empty').hidden = true;
    const u = M.unit;
    const title = `${unitName(u)} · ${u.area || 'area ?'} · ${String(u.quality || '').toUpperCase()}`;
    const subtitle = `${eventLabel(S.align)} · ${policyText()}${M.yoke ? ` · trials ${M.yoke.from}–${M.yoke.to}` : ''} · bin ${Math.round(S.bin * 1000)} ms · σ ${Math.round(S.sigma * 1000)} ms · ${S.weight === 'trial' ? 'trial-weighted' : 'event-weighted'} mean ± ${S.err === 'none' ? '—' : S.err === 'ci' ? '95% CI' : 'SEM'}`;
    $('title').textContent = title;
    $('subtitle').textContent = subtitle;
    renderSupport(M);
    renderLegend(M);
    renderQuickFilters(M);
    if (!M.rows.length) {
      fig.innerHTML = ''; $('bars').innerHTML = ''; D.layout = null;
      renderEmptyReason(M);
      return;
    }
    const wrap = document.querySelector('.figure-wrap');
    const stageW = $('stage').clientWidth - 36;
    const side = S.bars && stageW >= 760 && M.grouping.panels.length <= 1;
    wrap.classList.toggle('stacked', !side);
    const barsW = side ? 210 : 0;
    const width = Math.max(260, Math.floor((wrap.clientWidth || stageW) - barsW - (side ? 8 : 0)));
    const {svg, layout} = figureSVG(M, width);
    fig.innerHTML = svg;
    D.layout = layout;
    D.figMeta = {title, subtitle, width};
    if (S.bars) {
      // Beside the figure the chart runs from just above the PSTH to the figure's bottom
      // edge, so it never makes the page taller than the figure (which the fit relies on).
      const barsTop = Math.max(0, layout.panels[0].pTop - 30);
      const h = side ? Math.max(160, layout.height - barsTop) : 260;
      $('bars').innerHTML = barsSVG(M, side ? barsW : Math.min(Math.max(260, width), 140 + 70 * M.visible.length), h);
      $('bars').style.marginTop = side ? `${barsTop}px` : '';
    } else $('bars').innerHTML = '';
    $('foot').innerHTML = `Source <code>${esc(D.summary.source.path || '')}</code> · SHA256 <code>${esc(String(D.summary.source.sha256 || '').slice(0, 12))}…</code> · rows are events; half-open count window; ${S.policy === 'verified_stable' ? 'stability from the session file (post-sorting check, 0.4 s guard)' : 'no stability filter'} · electro_gui ${VERSION}`;
  }

  function renderSupport(M) {
    const shown = M.visible.reduce((a, g) => a + g.rows.length, 0);
    const trials = new Set(); M.visible.forEach(g => g.rows.forEach(i => trials.add(M.T.trial[i])));
    const ex = M.excl[1] + M.excl[2] + M.excl[3];
    const bits = [`<b>${shown}</b> events · <b>${trials.size}</b> trials`];
    const detail = [];
    if (M.filtered) detail.push(`${M.filtered} filtered out`);
    if (M.yoke) detail.push(`${M.yoked} outside trials ${M.yoke.from}–${M.yoke.to} (yoked to behavior)`);
    if (M.excl[1] + M.excl[2]) detail.push(`${M.excl[1] + M.excl[2]} in trials not ${S.policy === 'verified_stable' ? 'stable for this unit' : 'complete'}`);
    if (M.excl[3]) detail.push(`${M.excl[3]} whose window leaves the stable run`);
    const hiddenRows = M.grouping.groups.filter(g => g.hidden).reduce((a, g) => a + g.rows.length, 0);
    if (hiddenRows) detail.push(`${hiddenRows} in hidden groups`);
    $('support').innerHTML = bits.join('') + (detail.length ? `<br>${esc(detail.join(' · '))}` : '') + (ex && S.policy === 'verified_stable' && !M.rows.length ? '' : '');
  }

  function renderEmptyReason(M) {
    const e = $('empty');
    const reasons = [];
    const stab = M.excl[1] + M.excl[2];
    if (stab) reasons.push(`${stab} events are in trials that are not ${S.policy === 'verified_stable' ? 'stable for this unit' : 'complete'}.`);
    if (M.excl[3]) reasons.push(`${M.excl[3]} events have a window (plus the 0.4 s guard) that leaves the unit's stable run — try a shorter window.`);
    if (M.filtered === M.T.n) reasons.push('The filters exclude every event.');
    if (M.yoke && M.yoked) reasons.push(`The rasters are yoked to behavior trials ${M.yoke.from}–${M.yoke.to}; widen the behavior window or turn yoking off.`);
    e.innerHTML = `<h3>No events to show</h3>${reasons.map(r => `<p>${esc(r)}</p>`).join('')}` +
      (S.policy === 'verified_stable' && stab ? '<button class="primary" type="button" data-act="all-complete">Use all complete trials</button> ' : '') +
      (S.filters.length ? '<button class="small" type="button" data-act="clear-filters">Clear filters</button>' : '');
    e.hidden = false;
  }

  function renderLegend(M) {
    const groups = M.grouping.groups;
    const hiddenAny = groups.some(g => g.hidden);
    const html = groups.map(g => {
      const byTrial = S.weight === 'trial';
      const n = g.hidden ? g.rows.length : g.psth ? g.psth.n : byTrial ? new Set(g.rows.map(i => M.T.trial[i])).size : g.rows.length;
      const unitWord = byTrial ? 'trials' : 'events';
      return `<button class="lg${g.hidden ? ' off' : ''}" type="button" data-g="${esc(g.key)}" title="${g.hidden ? 'Show' : 'Hide'} this group · double-click to show only this group">` +
        `<svg viewBox="0 0 26 10"><line x1="1" x2="25" y1="5" y2="5" stroke="${g.color}" stroke-width="2.4" stroke-linecap="round"${g.dash ? ` stroke-dasharray="${g.dash}"` : ''}/></svg>` +
        `${esc(g.label)}${g.panelLabel ? ` <small>· ${esc(g.panelLabel)}</small>` : ''} <small>${n} ${g.hidden ? 'events' : unitWord}</small></button>`;
    }).join('');
    const hint = matchMedia('(hover: none)').matches ? 'tap to hide · hold to restyle' : 'click to hide · right-click to restyle';
    $('legend').innerHTML = html + (hiddenAny ? '<button class="link" type="button" data-g="__all">show all</button>' : '') + (groups.length ? `<span class="lg-hint">${hint}</span>` : '');
  }

  function showLoading(title, text) {
    $('figure').innerHTML = `<div class="loading-card"><div class="spinner"></div><div><b>${esc(title)}</b><p>${esc(text)}</p></div></div>`;
    $('figure').classList.remove('stale');
    $('bars').innerHTML = '';
    $('legend').innerHTML = '';
    D.layout = null;
  }
  function showEmpty(title, html) {
    $('figure').innerHTML = '';
    $('bars').innerHTML = '';
    $('empty').innerHTML = `<h3>${esc(title)}</h3><p>${html}</p>`;
    $('empty').hidden = false;
  }

  // ------------------------------------------------------------ controls
  function fieldOptions(T, {none = 'none', grouping = false, sortExtras = false} = {}) {
    const groups = new Map(FIELD_GROUP_ORDER.map(g => [g, []]));
    for (const col of T.columns) {
      if (grouping && col.kind === 'cat' && col.levels.length > 16) continue;
      const g = fieldGroup(col);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(col);
    }
    const common = groups.get('Common');
    common.sort((a, b) => COMMON_FIELDS.indexOf(a.key) - COMMON_FIELDS.indexOf(b.key));
    let html = none ? `<option value="">${esc(none)}</option>` : '';
    if (sortExtras) {
      html = '<optgroup label="Rows"><option value="session">session order</option><option value="count">spikes in count window</option>';
      for (const m of S.markers) html += `<option value="marker:${esc(m.id)}">marker: ${esc(m.label || eventLabel(m.e))}</option>`;
      html += '</optgroup>';
    }
    for (const [name, cols] of groups) {
      if (!cols.length) continue;
      if (name !== 'Common') cols.sort((a, b) => a.label.localeCompare(b.label));
      html += `<optgroup label="${esc(name)}">` + cols.map(c => {
        const v = sortExtras ? `field:${c.key}` : c.key;
        const extra = !sortExtras && c.kind === 'num' && !c.discrete ? ' (binned)' : '';
        return `<option value="${esc(v)}">${esc(c.label)}${extra}</option>`;
      }).join('') + '</optgroup>';
    }
    return html;
  }

  function renderStructure() {
    const T = D.tables.get(S.align);
    if (T) {
      $('colorBy').innerHTML = fieldOptions(T, {none: 'none', grouping: true});
      $('styleBy').innerHTML = fieldOptions(T, {none: 'none', grouping: true});
      $('panelBy').innerHTML = fieldOptions(T, {none: 'none', grouping: true});
      $('sortBy').innerHTML = S.mode === 'population'
        ? [...Array(nComp()).keys()].map(k => `<option value="loading:${k}">loading on ${compName(k)}</option>`).join('') +
          '<option value="peak">peak time (heatmap group)</option><option value="rate">mean rate</option><option value="channel">peak channel</option><option value="area">area, then channel</option><option value="id">unit ID</option>'
        : fieldOptions(T, {none: '', sortExtras: true});
    }
    renderFilterChips();
    renderMarkers();
    renderPresets();
    syncControls();
  }

  function syncControls() {
    const T = D.tables.get(S.align);
    const setSel = (id, v) => { const el = $(id); el.value = v || ''; if (el.value !== (v || '') && el.options.length) el.value = ''; };
    setSel('colorBy', S.color); setSel('styleBy', S.style); setSel('panelBy', S.panel);
    if (S.mode === 'population') { $('sortBy').value = S.nsort; if ($('sortBy').value !== S.nsort) { S.nsort = 'loading:0'; $('sortBy').value = S.nsort; } }
    else { $('sortBy').value = S.sort; if ($('sortBy').value !== S.sort) $('sortBy').value = 'session'; }
    $('sortLabel').textContent = S.mode === 'population' ? 'Sort neurons' : 'Sort rows by';
    document.querySelectorAll('[data-method]').forEach(el => { el.hidden = el.dataset.method !== S.method; });
    document.querySelectorAll('[data-not-method]').forEach(el => { el.hidden = el.dataset.notMethod === S.method; });
    if (S.method === 'tdr') {
      renderTdrFactors();
      const w = tdrWindow();
      if (document.activeElement !== $('tdrLoN')) $('tdrLoN').value = w[0];
      if (document.activeElement !== $('tdrHiN')) $('tdrHiN').value = w[1];
    }
    $('ncomp').value = Math.min(S.ncomp, 10); if (document.activeElement !== $('ncompN')) $('ncompN').value = S.ncomp;
    $('cloudOn').checked = S.cloud; $('cloudZero').checked = S.cloudZero;
    $('cloudAlpha').value = Math.round(S.cloudAlpha * 100); $('cloudAlphaOut').textContent = `${Math.round(S.cloudAlpha * 100)}%`;
    $('cloudKnob').classList.toggle('off', !S.cloud); $('cloudZeroWrap').classList.toggle('off', !S.cloud); $('cloudFitWrap').classList.toggle('off', !S.cloud);
    applyMode();
    $('sortDir').textContent = S.dir === 1 ? '↑' : '↓';
    $('grouped').checked = S.grouped;
    const cont = T && [S.color, S.style, S.panel].some(k => { const c = k && T.byKey.get(k); return c && c.kind === 'num' && !c.discrete; });
    $('qbinsField').hidden = !cont; $('qbins').value = String(S.qbins);
    $('showMedians').checked = S.medians;
    $('winLo').value = S.win[0]; $('winHi').value = S.win[1];
    if (document.activeElement !== $('winLoN')) $('winLoN').value = S.win[0];
    if (document.activeElement !== $('winHiN')) $('winHiN').value = S.win[1];
    $('cwLo').min = $('cwHi').min = S.win[0]; $('cwLo').max = $('cwHi').max = S.win[1];
    $('cwLo').value = S.cw[0]; $('cwHi').value = S.cw[1];
    if (document.activeElement !== $('cwLoN')) $('cwLoN').value = S.cw[0];
    if (document.activeElement !== $('cwHiN')) $('cwHiN').value = S.cw[1];
    $('bin').value = Math.round(S.bin * 1000); $('binOut').textContent = `${Math.round(S.bin * 1000)} ms`;
    $('sigma').value = Math.round(S.sigma * 1000); $('sigmaOut').textContent = S.sigma ? `${Math.round(S.sigma * 1000)} ms` : 'off';
    syncRasterOut();
    $('ylock').checked = S.ylock !== null; $('ymax').disabled = S.ylock === null;
    if (document.activeElement !== $('ymax')) $('ymax').value = S.ylock !== null ? S.ylock : (D.model ? tidy(D.model.ymax, 1) : '');
    $('showBars').checked = S.bars;
    document.querySelectorAll('.seg[data-key]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', S[seg.dataset.key] === b.dataset.v)));
  }

  function renderQuickFilters(M) {
    const T = M.T;
    const host = $('quickFilters');
    const parts = [];
    const elig = C.eligibility(M.raster, M.pre, M.post);
    for (const key of QUICK_FIELDS) {
      const col = T.byKey.get(key);
      if (!col) continue;
      const levels = C.fieldLevels(col);
      if (!levels || levels.length < 2) continue;
      const others = activeFilters(T).filter(f => f.k !== key);
      const mask = C.filterMask(T, others);
      const counts = new Map();
      for (let i = 0; i < T.n; i++) if (mask[i] && !elig[i] && !(M && M.yoke && !M.yoke.ids.has(T.trial[i]))) { const k = C.levelKey(C.rawValue(col, i)); counts.set(k, (counts.get(k) || 0) + 1); }
      const f = S.filters.find(x => x.k === key && x.v);
      const on = new Set(f ? f.v : []);
      const sem = SEM[key] || {};
      parts.push(`<div class="qf"><span>${esc(col.label)}</span><div class="chips">` + levels.map(l => {
        const c = counts.get(l.key) || 0;
        const color = sem[l.key] ? paint(sem[l.key]) : '';
        return `<button type="button" class="chip${on.has(l.key) ? ' on' : ''}${c ? '' : ' zero'}" data-qf="${esc(key)}" data-level="${esc(l.key)}"${color ? ` style="--c:${color}"` : ''}>${esc(l.key === C.MISSING ? 'missing' : C.formatLevel(key, l.value))} <small>${c}</small></button>`;
      }).join('') + '</div></div>');
    }
    host.innerHTML = parts.join('') || '<p class="pop-note" style="padding:0">No task fields for this alignment; use “Filter on any field”.</p>';
  }

  function filterText(f, T) {
    const col = T && T.byKey.get(f.k);
    const label = col ? col.label : C.fieldLabel(f.k);
    if (f.v) {
      const names = f.v.map(k => (k === C.MISSING ? 'missing' : col ? C.formatLevel(f.k, levelValue(col, k)) : k));
      return `<b>${esc(label)}</b>: ${esc(names.length > 3 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ') || 'none')}`;
    }
    const [lo, hi] = f.r;
    return `<b>${esc(label)}</b>: ${lo !== null && lo !== undefined ? C.fmtNum(lo) : '−∞'} to ${hi !== null && hi !== undefined ? C.fmtNum(hi) : '∞'}`;
  }
  function levelValue(col, key) {
    if (key === C.MISSING) return null;
    if (col.kind === 'cat') { const l = col.levels.find(x => C.levelKey(x) === key); return l === undefined ? key : l; }
    return Number(key);
  }
  function renderFilterChips() {
    const T = D.tables.get(S.align);
    const chips = S.filters.map((f, idx) => {
      if (QUICK_FIELDS.includes(f.k) && f.v && T && T.byKey.has(f.k)) return '';
      const stale = T && !T.byKey.has(f.k);
      return `<span class="chip fchip${stale ? ' stale' : ''}" data-f="${idx}" role="button" tabindex="0" title="${stale ? 'Not available for this alignment — ignored' : 'Edit filter'}">${filterText(f, T)}${stale ? ' (n/a)' : ''}<button class="x" type="button" data-fx="${idx}" aria-label="Remove filter">×</button></span>`;
    }).join('');
    $('otherFilters').innerHTML = chips;
  }

  function renderMarkers() {
    $('markerList').innerHTML = S.markers.map(m => {
      const where = 'same trial';
      const occ = {nearest: 'nearest', first_after: 'first after', last_before: 'last before', all: 'all', first: 'first in trial', last: 'last in trial'}[m.occ] || m.occ;
      return `<div class="marker${m.off ? ' off' : ''}" style="--c:${paint(m.c)}"><i class="${m.end ? 'band' : ''}"></i><div><b>${esc(m.label || eventLabel(m.e))}</b><small>${esc(eventLabel(m.e))}${m.end ? ` → ${esc(eventLabel(m.end))}` : ''} · ${where} · ${occ}</small></div>` +
        `<button type="button" data-medit="${esc(m.id)}" title="Edit" aria-label="Edit marker">✎</button><button type="button" data-mdel="${esc(m.id)}" title="Remove" aria-label="Remove marker">×</button></div>`;
    }).join('');
    $('refList').innerHTML = S.refs.map((r, i) => `<span class="chip fchip">${C.fmtNum(r)} s<button class="x" type="button" data-rdel="${i}" aria-label="Remove line">×</button></span>`).join('');
  }

  function renderPresets() {
    const T = D.tables.get(S.align);
    const avail = new Set(D.summary ? D.summary.events : []);
    const mk = [['fix_on', 'trial', 'first_after', 'fixation point on'], ['stimuli_on', 'trial', 'first_after', 'target on'],
      ['response', 'trial', 'first_after', 'response'], ['reward', 'trial', 'first_after', 'reward'],
      ['microstim', 'trial', 'first_after', 'stim train onset']];
    $('markerPresets').innerHTML = mk.filter(([e]) => avail.has(e) && !S.markers.some(m => m.e === e))
      .map(([e, match, occ, label]) => `<button type="button" class="preset" data-mp="${e}|${match}|${occ}|${label}">+ ${esc(label)}</button>`).join('');
    const gp = [['task', null, 'task'], ['microstim', null, 'stim / no stim'], ['rewarded', null, 'rewarded / not'],
      ['task', 'microstim', 'task × stim'], ['previous_task', null, 'previous task']];
    $('groupPresets').innerHTML = T ? gp.filter(([a, b]) => T.byKey.has(a) && (!b || T.byKey.has(b)))
      .map(([a, b, label]) => `<button type="button" class="preset" data-gp="${a}|${b || ''}">${esc(label)}</button>`).join('') : '';
  }

  // ------------------------------------------------------------- popovers
  let popAnchor = null;
  function openPop(anchor, html, {wide = false} = {}) {
    const pop = $('popover');
    pop.innerHTML = html;
    pop.hidden = false;
    $('scrim').hidden = false;
    $('scrim').style.background = matchMedia('(max-width: 959px)').matches ? '' : 'transparent';
    pop.style.width = wide ? 'min(460px, calc(100vw - 24px))' : '';
    popAnchor = anchor;
    placePop();
    const search = pop.querySelector('input[type=search]');
    if (search && !matchMedia('(hover: none)').matches) search.focus();
  }
  function placePop() {
    const pop = $('popover');
    if (pop.hidden || !popAnchor || matchMedia('(max-width: 959px)').matches) { pop.style.left = ''; pop.style.top = ''; return; }
    const r = popAnchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    // Below the anchor if it fits, else above; if neither fits, keep the whole popover
    // (and its footer actions) inside the window rather than hanging off the bottom.
    let left = clamp(r.left, 12, innerWidth - w - 12), top = r.bottom + 6;
    if (top + h > innerHeight - 12) top = r.top - h - 6 >= 12 ? r.top - h - 6 : Math.max(12, innerHeight - 12 - h);
    pop.style.left = `${left}px`; pop.style.top = `${top}px`;
  }
  function closePop() { $('popover').hidden = true; $('scrim').hidden = true; popAnchor = null; }
  const popHead = title => `<div class="pop-head"><h3>${esc(title)}</h3><button class="close" type="button" data-close aria-label="Close">×</button></div>`;

  function unitList() {
    return D.units.filter(u => (!S.unitQ.length || S.unitQ.includes(String(u.quality).toLowerCase())) && (!S.unitArea.length || S.unitArea.includes(u.area)));
  }
  function openUnitPicker() {
    const areas = [...new Set(D.units.map(u => u.area).filter(Boolean))];
    const qs = [...new Set(D.units.map(u => String(u.quality).toLowerCase()))];
    const html = popHead('Choose a unit') +
      `<div class="pop-search"><input type="search" id="unitSearch" placeholder="unit id, channel, area…" autocomplete="off">` +
      `<div class="chips">${qs.map(q => `<button type="button" class="chip${S.unitQ.includes(q) ? ' on' : ''}" data-uq="${esc(q)}">${esc(q.toUpperCase())}</button>`).join('')}` +
      `${areas.map(a => `<button type="button" class="chip${S.unitArea.includes(a) ? ' on' : ''}" data-ua="${esc(a)}">${esc(a)}</button>`).join('')}</div></div>` +
      `<div class="pop-body" id="unitItems"></div><div class="pop-note">← / → step through the listed units. Channel IDs survive a re-sort; unit IDs do not.</div>`;
    openPop($('unitBtn'), html);
    fillUnitItems('');
  }
  function fillUnitItems(text) {
    const t = text.trim().toLowerCase();
    const list = unitList().filter(u => !t || `${u.id} ch${u.peak_channel} ch ${u.peak_channel} ${u.area} ${u.quality}`.toLowerCase().includes(t));
    $('unitItems').innerHTML = list.slice(0, 600).map(u => `<button type="button" class="item${u.id === S.unit ? ' on' : ''}" data-unit="${u.id}"><span class="main"><b>unit ${u.id}${u.peak_channel !== null && u.peak_channel !== undefined ? ` · ch ${u.peak_channel}` : ''}</b><small>${esc(u.area || 'area ?')} · ${C.fmtNum(u.rate, 1)} spikes/s</small></span><span class="q ${esc(String(u.quality).toLowerCase())}">${esc(u.quality)}</span></button>`).join('') ||
      '<div class="pop-note">No units match.</div>';
    const on = $('unitItems').querySelector('.on');
    if (on) on.scrollIntoView({block: 'center'});
  }

  function openAlignPicker() {
    const html = popHead('Align rasters to') + `<div class="pop-search"><input type="search" id="alignSearch" placeholder="search events…" autocomplete="off"></div><div class="pop-body" id="alignItems"></div>`;
    openPop($('alignBtn'), html);
    fillAlignItems('');
  }
  function fillAlignItems(text) {
    const t = text.trim().toLowerCase();
    const items = D.summary.alignments.filter(a => a.n > 0 && (!t || `${a.key} ${eventLabel(a.key)}`.toLowerCase().includes(t)));
    const item = a => `<button type="button" class="item${a.key === S.align ? ' on' : ''}" data-align="${esc(a.key)}"><span class="main"><b>${esc(eventLabel(a.key))}</b><small>${esc(a.key)}</small></span><span class="n">${a.n}</span></button>`;
    let html = '';
    if (!t) {
      const pinned = PINNED_ALIGN.map(k => items.find(a => a.key === k)).filter(Boolean);
      html += `<div class="pop-group">Common</div>${pinned.map(item).join('')}`;
    }
    for (const cat of CATEGORY_ORDER) {
      const list = items.filter(a => eventCategory(a.key) === cat && (t || !PINNED_ALIGN.includes(a.key)));
      if (list.length) html += `<div class="pop-group">${esc(cat)}</div>${list.map(item).join('')}`;
    }
    $('alignItems').innerHTML = html || '<div class="pop-note">No events match.</div>';
  }

  function openFieldPicker(anchor, onPick, title = 'Filter on…') {
    const T = D.tables.get(S.align);
    if (!T) return;
    openPop(anchor, popHead(title) + `<div class="pop-search"><input type="search" id="fieldSearch" placeholder="search fields…" autocomplete="off"></div><div class="pop-body" id="fieldItems"></div>`);
    const fill = text => {
      const t = text.trim().toLowerCase();
      let html = '';
      for (const g of FIELD_GROUP_ORDER) {
        const cols = T.columns.filter(c => fieldGroup(c) === g && (!t || `${c.key} ${c.label}`.toLowerCase().includes(t)));
        if (g === 'Common') cols.sort((a, b) => COMMON_FIELDS.indexOf(a.key) - COMMON_FIELDS.indexOf(b.key)); else cols.sort((a, b) => a.label.localeCompare(b.label));
        if (!cols.length) continue;
        html += `<div class="pop-group">${esc(g)}</div>` + cols.map(c => {
          const lv = C.fieldLevels(c);
          const info = lv ? lv.slice(0, 4).map(l => l.label).join(', ') + (lv.length > 4 ? ` +${lv.length - 4}` : '') : 'number';
          return `<button type="button" class="item" data-field="${esc(c.key)}"><span class="main"><b>${esc(c.label)}</b><small>${esc(info)}</small></span></button>`;
        }).join('');
      }
      $('fieldItems').innerHTML = html || '<div class="pop-note">No fields match.</div>';
    };
    fill('');
    $('fieldSearch').addEventListener('input', e => fill(e.target.value));
    $('fieldItems').addEventListener('click', e => { const b = e.target.closest('[data-field]'); if (b) onPick(b.dataset.field); });
  }

  function openFilterEditor(anchor, key) {
    const T = D.tables.get(S.align);
    const col = T && T.byKey.get(key);
    if (!col) return;
    let idx = S.filters.findIndex(f => f.k === key);
    const levels = C.fieldLevels(col);
    if (idx < 0) {
      S.filters.push(levels ? {k: key, v: levels.map(l => l.key)} : {k: key, r: [null, null]});
      idx = S.filters.length - 1;
    }
    const draw = () => {
      const f = S.filters[idx];
      const M = D.model;
      const others = activeFilters(T).filter(x => x !== f);
      const mask = C.filterMask(T, others);
      const elig = M ? C.eligibility(M.raster, M.pre, M.post) : new Uint8Array(T.n);
      let body = '';
      if (levels) {
        const counts = new Map();
        for (let i = 0; i < T.n; i++) if (mask[i] && !elig[i] && !(M && M.yoke && !M.yoke.ids.has(T.trial[i]))) { const k = C.levelKey(C.rawValue(col, i)); counts.set(k, (counts.get(k) || 0) + 1); }
        const on = new Set(f.v);
        body = `<div class="editor"><div class="chips">${levels.map(l => `<button type="button" class="chip${on.has(l.key) ? ' on' : ''}" data-lv="${esc(l.key)}">${esc(l.key === C.MISSING ? 'missing' : l.label)} <small>${counts.get(l.key) || 0}</small></button>`).join('')}</div>` +
          `<div class="chips"><button type="button" class="preset" data-lvall>all</button><button type="button" class="preset" data-lvnone>none</button><button type="button" class="preset" data-lvinv>invert</button></div>` +
          `<p class="pop-note" style="padding:0">${esc(col.description || '')}${col.timing ? ` Timing: ${esc(String(col.timing).replace(/_/g, ' '))}.` : ''}</p></div>`;
      } else {
        const vals = [];
        for (let i = 0; i < T.n; i++) if (mask[i] && !elig[i] && !Number.isNaN(col.data[i])) vals.push(col.data[i]);
        vals.sort((a, b) => a - b);
        const lo = vals[0], hi = vals[vals.length - 1];
        const nb = 24, hist = new Array(nb).fill(0);
        vals.forEach(v => { hist[Math.min(nb - 1, Math.floor((v - lo) / ((hi - lo) || 1) * nb))]++; });
        const hmax = Math.max(1, ...hist);
        const [a, b] = f.r;
        const inR = j => { const c = lo + (j + 0.5) * (hi - lo) / nb; return (a === null || c >= a) && (b === null || c <= b); };
        body = `<div class="editor"><div class="hist">${hist.map((h, j) => `<i class="${inR(j) ? 'in' : ''}" style="height:${Math.max(2, h / hmax * 100)}%"></i>`).join('')}</div>` +
          `<div class="range"><input type="number" id="rLo" step="any" placeholder="${C.fmtNum(lo)}" value="${a ?? ''}"><span>to</span><input type="number" id="rHi" step="any" placeholder="${C.fmtNum(hi)}" value="${b ?? ''}"></div>` +
          `<p class="pop-note" style="padding:0">Observed ${C.fmtNum(lo)} to ${C.fmtNum(hi)} over ${vals.length} events (inclusive; empty = open). ${esc(col.description || '')}</p></div>`;
      }
      $('popover').innerHTML = popHead(col.label) + `<div class="pop-body">${body}</div><div class="pop-foot"><button type="button" class="small" data-fdel>Remove filter</button><button type="button" class="primary" data-close>Done</button></div>`;
      placePop();
      const apply = () => { renderFilterChips(); changed(); };
      $('popover').querySelectorAll('[data-lv]').forEach(b => b.addEventListener('click', () => {
        const set = new Set(f.v); set.has(b.dataset.lv) ? set.delete(b.dataset.lv) : set.add(b.dataset.lv);
        f.v = levels.map(l => l.key).filter(k => set.has(k)); apply(); draw();
      }));
      const q = sel => $('popover').querySelector(sel);
      if (q('[data-lvall]')) q('[data-lvall]').addEventListener('click', () => { f.v = levels.map(l => l.key); apply(); draw(); });
      if (q('[data-lvnone]')) q('[data-lvnone]').addEventListener('click', () => { f.v = []; apply(); draw(); });
      if (q('[data-lvinv]')) q('[data-lvinv]').addEventListener('click', () => { const s = new Set(f.v); f.v = levels.map(l => l.key).filter(k => !s.has(k)); apply(); draw(); });
      const num = el => (el.value === '' ? null : Number(el.value));
      if ($('rLo')) ['rLo', 'rHi'].forEach(id => $(id).addEventListener('change', () => { f.r = [num($('rLo')), num($('rHi'))]; apply(); draw(); }));
      q('[data-fdel]').addEventListener('click', () => { S.filters = S.filters.filter(x => x !== f); closePop(); renderFilterChips(); changed(); });
    };
    openPop(anchor, '');
    draw();
    renderFilterChips(); changed();
  }

  function eventOptions(selected, {none = null} = {}) {
    const evs = (D.summary ? D.summary.events : []).concat(unionAlignments(D.summary));
    let html = none ? `<option value="">${esc(none)}</option>` : '';
    for (const cat of CATEGORY_ORDER) {
      const list = [...new Set(evs.filter(e => eventCategory(e) === cat))].sort((a, b) => eventLabel(a).localeCompare(eventLabel(b)));
      if (list.length) html += `<optgroup label="${esc(cat)}">${list.map(e => `<option value="${esc(e)}"${e === selected ? ' selected' : ''}>${esc(eventLabel(e))}</option>`).join('')}</optgroup>`;
    }
    return html;
  }
  function newMarkerId() { let k = 1; while (S.markers.some(m => m.id === `m${k}`)) k++; return `m${k}`; }
  function addMarker(e, match, occ, label) {
    const m = {id: newMarkerId(), e, match: 'trial', occ: occ || 'nearest',
      label: label || eventLabel(e), c: MARKER_COLORS[S.markers.length % MARKER_COLORS.length]};
    S.markers.push(m);
    renderStructure(); changed({data: true});
    return m;
  }
  function openMarkerEditor(anchor, id) {
    let m = S.markers.find(x => x.id === id);
    if (!m) m = addMarker(D.summary && D.summary.events.includes('stimuli_on') ? 'stimuli_on' : (D.summary && D.summary.events[0]) || 'fix_on');
    const seg = (key, opts) => `<div class="seg" data-mkey="${key}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${m[key] === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const draw = () => {
      $('popover').innerHTML = popHead('Marker') + `<div class="pop-body"><div class="editor">` +
        `<label class="row"><span>Event</span><select id="mkEvent">${eventOptions(m.e)}</select></label>` +
        `<div class="row"><span>Which occurrence</span>${seg('occ', [['nearest', 'nearest'], ['first_after', 'first after'], ['last_before', 'last before'], ['all', 'all']])}</div>` +
        `<label class="row"><span>Shade until (optional band)</span><select id="mkEnd">${eventOptions(m.end || '', {none: 'no band — tick only'})}</select></label>` +
        `<label class="row"><span>Label</span><input type="text" id="mkLabel" value="${esc(m.label || '')}" placeholder="${esc(eventLabel(m.e))}"></label>` +
        `<div class="row"><span>Colour</span><div class="swatches">${MARKER_COLORS.map(c => `<button type="button" class="swatch${m.c === c ? ' on' : ''}" data-sw="${c}" style="--c:${paint(c)}" aria-label="colour"></button>`).join('')}</div></div>` +
        `<p class="pop-note" style="padding:0">Each raster row gets a dot at this event's time in the same trial; the PSTH shows the median. Markers never change which events are counted.</p>` +
        `</div></div><div class="pop-foot"><button type="button" class="small" data-mdel="${esc(m.id)}">Remove</button><button type="button" class="small" data-mtoggle>${m.off ? 'Show' : 'Hide'}</button><button type="button" class="primary" data-close>Done</button></div>`;
      placePop();
      const pop = $('popover');
      const upd = () => { renderMarkers(); renderStructure(); changed({data: true}); };
      $('mkEvent').addEventListener('change', e => { const old = eventLabel(m.e); m.e = e.target.value; if (!m.label || m.label === old) m.label = eventLabel(m.e); upd(); draw(); });
      $('mkEnd').addEventListener('change', e => { m.end = e.target.value || undefined; upd(); });
      $('mkLabel').addEventListener('input', e => { m.label = e.target.value; renderMarkers(); changed(); });
      pop.querySelectorAll('[data-mkey] button').forEach(b => b.addEventListener('click', () => { m[b.parentElement.dataset.mkey] = b.dataset.v; upd(); draw(); }));
      pop.querySelectorAll('[data-sw]').forEach(b => b.addEventListener('click', () => { m.c = b.dataset.sw; upd(); draw(); }));
      pop.querySelector('[data-mtoggle]').addEventListener('click', () => { m.off = !m.off; upd(); draw(); });
    };
    openPop(anchor, '');
    draw();
  }

  const STYLE_COLORS = ['#2b8a3e', '#8fcf9c', '#6741d9', '#b197fc', '#e03131', '#f4a3a3', '#1c7ed6', '#f08c00', '#0c8599', '#d6336c', '#495057', INK];
  function openGroupStyle(anchor, key) {
    const g = D.model && D.model.grouping.groups.find(x => x.key === key);
    if (!g) return;
    const own = S.gstyle[key] || {};
    const dashIdx = Number.isInteger(own.d) ? own.d : g.styleIndex % DASHES.length;
    const html = popHead(g.label) + `<div class="pop-body"><div class="editor">` +
      `<div class="row"><span>Colour</span><div class="swatches">${STYLE_COLORS.map(c => `<button type="button" class="swatch${own.c === c ? ' on' : ''}" data-gsc="${c}" style="--c:${paint(c)}" aria-label="colour"></button>`).join('')}</div></div>` +
      `<div class="row"><span>Line</span><div class="chips">${DASHES.map((d, i) => `<button type="button" class="chip${i === dashIdx ? ' on' : ''}" data-gsd="${i}" style="--c:var(--accent)"><svg viewBox="0 0 34 8" width="34" height="8"><line x1="1" x2="33" y1="4" y2="4" stroke="currentColor" stroke-width="2.2"${d ? ` stroke-dasharray="${d}"` : ''}/></svg></button>`).join('')}</div></div>` +
      `</div></div><div class="pop-foot"><button type="button" class="small" data-gsreset>Reset style</button><button type="button" class="small" data-gsonly>Show only this</button><button type="button" class="primary" data-close>Done</button></div>`;
    openPop(anchor, html);
    const pop = $('popover');
    const set = patch => { S.gstyle[key] = {...(S.gstyle[key] || {}), ...patch}; changed(); openGroupStyle(anchor, key); };
    pop.querySelectorAll('[data-gsc]').forEach(b => b.addEventListener('click', () => set({c: b.dataset.gsc})));
    pop.querySelectorAll('[data-gsd]').forEach(b => b.addEventListener('click', () => set({d: Number(b.dataset.gsd)})));
    pop.querySelector('[data-gsreset]').addEventListener('click', () => { delete S.gstyle[key]; changed(); closePop(); });
    pop.querySelector('[data-gsonly]').addEventListener('click', () => { S.hidden = D.model.grouping.groups.map(x => x.key).filter(k => k !== key); changed(); closePop(); });
  }

  async function openViews() {
    let found = null, cfg = null;
    try { found = await getJSON('/api/findings'); } catch (e) { found = null; }
    try { cfg = await getJSON('/api/configs'); } catch (e) { cfg = null; }   // an older server has no config route: no section
    D.findings = found ? found.findings : [];
    D.configs = cfg && Array.isArray(cfg.configs) ? cfg.configs : [];
    const findingsHtml = found === null ? '<div class="pop-note">Findings are unavailable on this server.</div>'
      : D.findings.length ? D.findings.slice(0, 6).map((f, i) => `<button type="button" class="item" data-finding="${i}"><span class="main"><b>${esc(f.title)}</b>` +
          `<small>${esc(findingLine(f))}</small></span><span class="st st-${esc(f.status)}">${esc(f.status)}</span></button>`).join('') +
        (D.findings.length > 6 ? `<a class="item" href="/findings/"><span class="main"><b>All ${D.findings.length} findings…</b></span></a>` : '')
      : '<div class="pop-note">No findings yet. <b>Save finding</b> keeps the figure with your notes and the numbers it shows; every device that opens this server sees them.</div>';
    const html = popHead('Views') + `<div class="pop-body"><div class="pop-group">Templates · keep the current unit</div>` +
      TEMPLATES.map((t, i) => `<button type="button" class="item" data-tpl="${i}"><span class="main"><b>${esc(t.name)}</b><small>${esc(t.hint)}</small></span></button>`).join('') +
      configsHtml(cfg) +
      `<div class="pop-group">Findings · reopen and check the numbers</div>${findingsHtml}</div>` +
      `<div class="pop-foot" style="flex-wrap:wrap"><button type="button" class="small" data-copylink>Copy link</button><button type="button" class="small" data-openconfig>Open config file…</button><a class="small" href="/findings/">All findings</a><button type="button" class="primary" data-savefinding${found === null ? ' disabled' : ''}>Save finding…</button></div>`;
    openPop($('viewsBtn').offsetParent ? $('viewsBtn') : $('menuBtn'), html, {wide: true});
  }
  // Config files: JSON view states kept in the repository (see electro_gui/configs.py), listed under their `group`.
  function configsHtml(cfg) {
    if (!cfg) return '';
    const grouped = D.configs.some(c => c.group);
    let last = null;
    const items = D.configs.map((c, i) => {
      const head = grouped && c.group !== last ? `<div class="pop-note" style="padding:8px 10px 2px"><b>${esc(c.group || 'Other')}</b></div>` : '';
      last = c.group;
      return `${head}<button type="button" class="item" data-cfg="${i}" title="${esc(c.note ? `${c.file} — ${c.note}` : c.file)}"><span class="main"><b>${esc(c.title)}</b><small>${esc(c.hint || summarizeState(c.state))}</small></span></button>`;
    }).join('');
    const bad = (cfg.errors || []).slice(0, 3).map(x => `${x.file}: ${String(x.error).slice(0, 90)}`).join(' · ');
    return `<div class="pop-group">Config files · restore a saved figure</div>` +
      (items || '<div class="pop-note">No config files found under --config-dir.</div>') +
      (bad ? `<div class="pop-note">Skipped ${(cfg.errors || []).length} unreadable file(s): ${esc(bad)}</div>` : '');
  }
  // The three shapes electro_gui/configs.py accepts: a config, a GUI settings export, a bare state.
  function readConfigObject(obj, name) {
    const stem = String(name || 'config').replace(/\.json$/i, '');
    const plain = o => o && typeof o === 'object' && !Array.isArray(o);
    if (!plain(obj)) throw new Error('the top level is not a JSON object');
    if ('electro_gui_config' in obj) {
      if (obj.electro_gui_config !== 1) throw new Error(`unsupported electro_gui_config version ${JSON.stringify(obj.electro_gui_config)}`);
      if (!plain(obj.state)) throw new Error('"state" must be an object');
      return {title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : stem, state: obj.state};
    }
    if ('state' in obj) {
      if (plain(obj.state) && typeof obj.tool === 'string') return {title: stem, state: obj.state};
      throw new Error('it has a "state" key but is neither a config ("electro_gui_config": 1) nor a GUI settings export');
    }
    if ('align' in obj || 'unit' in obj) return {title: stem, state: obj};
    throw new Error('not an electro_gui config, GUI settings export or bare view state');
  }
  // Only known state keys are taken (title, hint, ... never enter S) and the result goes through sanitize() in applyView.
  // A config that names no session or unit keeps the current ones; an unavailable session is refused before anything changes.
  async function applyConfig(title, raw) {
    const state = {};
    for (const k of Object.keys(DEFAULTS)) if (k in raw) state[k] = clone(raw[k]);
    if (typeof state.session !== 'string') state.session = S.session;
    if (!Number.isInteger(state.unit)) state.unit = S.unit;
    if (!state.session || !D.catalog.some(s => s.id === state.session)) { toast(`Config “${title}”: session ${state.session || '(none)'} is not available on this server.`, true); return false; }
    toast(`Config: ${title}`);
    // Same session: a raster or table not fetched yet can take a minute while the old figure stays up under a 2 px bar.
    // A different session shows its own opening card straight away.
    if (D.summary) showLoading(`Opening ${title}`, 'Applying the saved settings…');
    await applyView({state});
    return true;
  }
  // A config is slow to open in three places: reading the file (it may sit in a cloud folder), verifying a session file,
  // fetching a raster. The first and last leave the old figure up as if nothing had happened, so say what is going on
  // from the moment a file is chosen, and put the figure back when nothing was applied.
  async function openConfigFile(file) {
    const covered = !!D.summary;   // with no session loaded there is no figure to cover, and a session still opening shows its own card
    if (covered) showLoading(`Opening ${file.name}`, 'Reading the file…');
    let applied = false;
    try {
      if (file.size > 256 * 1024) throw new Error('the file is larger than 256 KiB');
      let obj;
      try { obj = JSON.parse(await file.text()); } catch (e) { throw new Error(`invalid JSON (${e.message})`); }
      const c = readConfigObject(obj, file.name);
      applied = await applyConfig(c.title, c.state);
    } catch (e) { toast(`Could not open ${file.name}: ${e.message}`, true); }
    if (covered && !applied) schedule();
  }
  function summarizeState(s) {
    if (!s) return '';
    return [s.unit !== undefined ? `unit ${s.unit}` : '', eventLabel(s.align || ''), [s.color, s.style].filter(Boolean).map(k => C.fieldLabel(k)).join(' × ')].filter(Boolean).join(' · ');
  }
  // ------------------------------------------------------------- findings
  // A finding is this figure saved with a title, optional notes, tags and a status, its exact settings, the
  // numbers it shows and a picture of it (electro_gui/findings.py).  Reopening one redraws it and compares.
  const STATUSES = ['lead', 'checking', 'supported', 'dropped'];
  const r4 = v => (Number.isFinite(v) ? Number(v.toFixed(4)) : null);
  const unitPrint = u => (u ? {id: u.id, peak_channel: u.peak_channel ?? null, area: u.area ?? null, quality: u.quality ?? null, n_spikes: u.n_spikes ?? null} : null);
  function findingLine(f) {
    const st = f.state || {};
    const who = st.mode === 'population' ? `${(st.roster || []).length} neurons` : `unit ${st.unit}`;
    return [shortSession(st.session || ''), who, eventLabel(st.align || ''), (f.saved_at || '').slice(0, 10)].filter(Boolean).join(' · ');
  }
  // Why the figure cannot be saved as a finding right now ('' when it can).  It must be drawn, for the current
  // settings, with nothing still loading or fitting, so the picture, the settings and the numbers agree.
  function figureReady() {
    if (D.fatal || !D.summary) return 'no session is open';
    const fig = $('figure');
    if (!$('empty').hidden || !fig.querySelector('svg') || !D.figMeta) return 'there is no figure to save';
    if (fig.classList.contains('stale')) return 'the figure is still updating';
    if (S.mode === 'population') return D.popFit && D.popModel ? '' : 'the fit has not finished';
    return D.model && D.model.rows.length ? '' : 'there is no figure to save';
  }
  /**
   * What a finding rests on, read off the figure as drawn: the data's identity (session, file checksum, the unit's
   * channel, area, quality and spike count, or every neuron's), the support line and each shown group's events,
   * trials and count-window rate (population: the fit's diagnostics).  It runs when a finding is saved and again
   * when it is reopened, and C.compareEvidence names every difference.  Nothing here is new arithmetic.
   */
  function evidence() {
    const src = D.summary.source || {}, pop = S.mode === 'population';
    const M = pop ? D.popModel : D.model;
    const trials = new Set(); M.visible.forEach(g => g.rows.forEach(i => trials.add(M.T.trial[i])));
    const support = {events: M.visible.reduce((a, g) => a + g.rows.length, 0), trials: trials.size, filtered_out: M.filtered,
      not_stable_or_complete: M.excl[1] + M.excl[2], window_leaves_stable_run: M.excl[3],
      in_hidden_groups: M.grouping.groups.filter(g => g.hidden).reduce((a, g) => a + g.rows.length, 0),
      yoked_trials: M.yoke ? {first: M.yoke.from, last: M.yoke.to} : null};
    const out = {schema: 1, mode: S.mode, session_id: D.summary.session_id, source: {sha256: src.sha256 || null, size_bytes: src.size_bytes ?? src.size ?? null},
      title: D.figMeta.title, subtitle: D.figMeta.subtitle, alignment: S.align, policy: S.policy, window_s: S.win.slice(),
      count_window_s: S.cw.slice(), weighting: S.weight, support};
    if (!pop) {
      out.unit = unitPrint(M.unit);
      out.groups = M.visible.map(g => ({label: g.label, panel: g.panelLabel || null, events: g.psth.events, trials: g.psth.trials,
        rate_hz: r4(g.rate.mean), rate_sem_hz: r4(g.rate.sem), n: g.rate.n}));
      return out;
    }
    const fit = D.popFit, shownKeys = new Set(M.visible.map(g => g.key));
    support.neurons = S.roster.length; support.common_trials = M.common;
    out.roster = S.roster.map(id => unitPrint(D.unitMap.get(id)) || {id});
    out.groups = fit.groups.filter(g => shownKeys.has(g.key)).map(g => ({label: g.label, panel: null, events: g.events, trials: g.trials}));
    out.fit = {method: fit.method, scaling: fit.scaling, components: fit.components, rank: fit.rank, fit_rows: fit.fit_rows,
      common_trials: fit.common_trials, dropped_constant_units: fit.dropped_constant_units || [], converged: fit.converged, warnings: fit.warnings || [],
      explained_variance_ratio: Array.isArray(fit.explained_variance_ratio) ? fit.explained_variance_ratio.map(r4) : null,
      component_r2: (fit.component_r2 || []).map(r4), reconstruction_r2: r4(fit.reconstruction_r2)};
    return out;
  }
  const dataURL = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  // The settings, the numbers and the picture, all from one drawing of the figure for the current S.
  async function captureFinding() {
    render();
    const why = figureReady();
    if (why) throw new Error(why);
    const state = clone(S), ev = evidence(), svg = S.mode === 'population' ? popExportSVG() : exportSVG();
    return {state, evidence: ev, thumbnail: await dataURL(await svgToPng(svg, 1.5))};
  }
  function suggestTitle() {
    if (S.mode === 'population') return `${$('title').textContent} · ${eventLabel(S.align)}`;
    const u = D.units.find(x => x.id === S.unit);
    return `${unitName(u)} · ${eventLabel(S.align)}${S.color ? ` · ${C.fieldLabel(S.color)}` : ''}${S.style ? ` × ${C.fieldLabel(S.style)}` : ''}`;
  }
  let findingDraft = null;   // what was typed in the save dialog: survives closing it, cleared once saved
  async function openSaveFinding() {
    closePop();
    render();
    const why = figureReady();
    if (why) { toast(`Nothing to save yet: ${why}.`, true); return; }
    const draft = {title: suggestTitle(), note: '', tags: '', status: STATUSES[0], ...(findingDraft || {})};
    if (findingDraft && !findingDraft.titleEdited) draft.title = suggestTitle();
    let used = [];
    try {
      const counts = new Map();
      for (const f of (await getJSON('/api/findings')).findings) for (const t of f.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
      used = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 14).map(x => x[0]);
    } catch (e) { /* tag suggestions only */ }
    const anchor = $('saveBtn').offsetParent ? $('saveBtn') : $('menuBtn');
    openPop(anchor, popHead('Save finding') + `<form class="editor finding-form" id="findingForm">` +
      `<label class="row"><span>Title</span><input type="text" id="fTitle" maxlength="200" required value="${esc(draft.title)}"></label>` +
      `<label class="row"><span>Notes <small>optional</small></span><textarea id="fNote" rows="5" maxlength="20000" placeholder="Why it matters · what this view does not control (eye movements?) · what to check next">${esc(draft.note)}</textarea></label>` +
      `<label class="row"><span>Tags <small>optional, separated by commas</small></span><input type="text" id="fTags" autocomplete="off" value="${esc(draft.tags)}" placeholder="memory saccade, stim"></label>` +
      (used.length ? `<div class="chips tag-picks">${used.map(t => `<button type="button" class="chip" data-addtag="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : '') +
      `<div class="row"><span>Status <small>your judgement, not a test</small></span><div class="seg" id="fStatus">${STATUSES.map(st => `<button type="button" data-st="${st}" class="${st === draft.status ? 'on' : ''}">${st}</button>`).join('')}</div></div>` +
      `<p class="pop-note" style="padding:0">Keeps a picture of the figure, every setting and the numbers it shows: events, trials and count-window rate per group, the unit's channel and the session file's checksum. Reopening it redraws the figure and says whether any of them has changed. Notes, tags and status can be edited later under Findings.</p>` +
      `<div class="pop-foot" style="padding:0;border:0"><button type="button" class="small" data-close>Cancel</button><button type="submit" class="primary" id="fSave">Save finding</button></div></form>`, {wide: true});
    const form = $('findingForm');
    const read = () => ({title: $('fTitle').value, note: $('fNote').value, tags: $('fTags').value,
      status: (form.querySelector('[data-st].on') || {dataset: {st: STATUSES[0]}}).dataset.st});
    const keep = () => { findingDraft = {...read(), titleEdited: (findingDraft && findingDraft.titleEdited) || $('fTitle').value !== draft.title}; };
    form.addEventListener('input', keep);
    form.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', () => { form.querySelectorAll('[data-st]').forEach(x => x.classList.toggle('on', x === b)); keep(); }));
    form.querySelectorAll('[data-addtag]').forEach(b => b.addEventListener('click', () => {
      const have = $('fTags').value.split(',').map(t => t.trim()).filter(Boolean);
      if (!have.some(t => t.toLowerCase() === b.dataset.addtag.toLowerCase())) $('fTags').value = [...have, b.dataset.addtag].join(', ');
      keep();
    }));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('fSave'), typed = read();
      btn.disabled = true; btn.textContent = 'Saving…';
      let saved;
      try {
        const snap = await captureFinding();
        saved = await getJSON('/api/findings', {method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({...typed, tags: typed.tags.split(','), ...snap})});
        findingDraft = null;
      } catch (err) {
        keep();
        btn.disabled = false; btn.textContent = 'Save finding';
        toast(`Could not save the finding: ${err.message}. Your text is kept.`, true);
        return;
      }
      // Still the open dialog: say where the file is.  Closed or replaced meanwhile: a toast does.
      if ($('findingForm') === form && !$('popover').hidden) showSavedFinding(saved);
      else toast(`Saved finding “${saved.title}” in ${saved.path}.`);
    });
    if (!matchMedia('(hover: none)').matches) { $('fTitle').focus(); $('fTitle').select(); }
  }
  // Copy to the clipboard; where the browser refuses (a plain-http LAN address), select the text so ⌘C works.
  async function copyText(text, field) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* insecure origin or denied */ }
    const range = document.createRange(), sel = getSelection();
    range.selectNodeContents(field); sel.removeAllRanges(); sel.addRange(range);
    try { return document.execCommand('copy'); } catch (e) { return false; }
  }
  // The save dialog once the finding is written: where its JSON file is (the picture is beside it), to copy, or
  // to select in Finder when this page is open on the Mac that holds the file (the server says so: can_reveal).
  function showSavedFinding(saved) {
    const path = saved.path || '', id = encodeURIComponent(saved.id);
    $('popover').innerHTML = popHead('Finding saved') + `<div class="editor finding-saved">` +
      `<p>Saved “${esc(saved.title)}”.</p>` +
      `<div class="row"><span>File <small>its picture, ${esc(saved.id)}.png, is beside it</small></span><code class="file-path" id="fPath">${esc(path)}</code></div>` +
      `<div class="saved-actions"><button type="button" class="small" id="fCopy">Copy path</button>` +
      (saved.can_reveal ? `<button type="button" class="small" id="fReveal">Show in Finder</button>` : '') + `</div>` +
      (saved.can_reveal ? '' : `<p class="pop-note" style="padding:0">The file is on the machine running electro_gui; copy the path to open it there.</p>`) +
      `<div class="pop-foot" style="padding:0;border:0"><a class="small" href="/findings/#${id}">Notes &amp; edit</a><button type="button" class="primary" data-close>Done</button></div></div>`;
    $('fCopy').addEventListener('click', async () => {
      toast(await copyText(path, $('fPath')) ? 'Path copied.' : 'Could not copy; the path is selected, press ⌘C.');
    });
    const reveal = $('fReveal');
    if (reveal) reveal.addEventListener('click', async () => {
      reveal.disabled = true;
      try {
        await getJSON(`/api/findings/${id}/reveal`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
        toast('Shown in Finder.');
      } catch (err) { toast(`Could not show it in Finder: ${err.message}`, true); }
      reveal.disabled = false;
    });
    placePop();
  }

  // Reopening.  The view is restored through the page's own checks, every setting it could not restore is listed,
  // and once the figure is drawn its numbers are measured again and compared with the saved ones.
  const NOT_RESTORED = new Set(['session', 'unit', 'align', 'roster', 'mode']);
  const STATE_LABELS = {align: 'alignment', roster: 'neurons', win: 'window', cw: 'count window', bin: 'bin width', sigma: 'smoothing σ',
    weight: 'averaging', err: 'error band', policy: 'trials', filters: 'filters', color: 'colour', style: 'line style', panel: 'panels',
    hidden: 'hidden groups', sort: 'row order', nsort: 'neuron order', axes: 'trajectory axes', ncomp: 'components', method: 'method'};
  let openedFinding = null;   // the finding whose bar is shown: {finding, pending, changes, diff, failed, refused, key, diverged}
  async function openFinding(f) {
    closePop();
    if (!f || !f.state || !D.catalog.some(s => s.id === f.state.session)) {
      openedFinding = {finding: f || {}, refused: `Its session ${f && f.state ? f.state.session : '(none)'} is not on this server, so nothing was changed.`};
      renderFindingBar();
      return false;
    }
    const state = {};   // keys this version knows; any other is reported, as a config file's would be dropped
    for (const k of Object.keys(DEFAULTS)) if (k in f.state) state[k] = clone(f.state[k]);
    openedFinding = {finding: f, pending: true, changes: [], diff: null};
    renderFindingBar();
    $('empty').hidden = true;   // the previous view's empty card is not this finding's
    stopPlay(); hideTip();
    S = sanitize(state);
    if (!D.summary || D.summary.session_id !== S.session) { saveState(); await selectSession(S.session); renderStructure(); }
    else { fitStateToSession(D.summary); afterBigChange(); }
    schedule();
    return true;
  }
  // Called after every render: completes a pending comparison, then watches for the view moving away from it.
  function checkFinding() {
    const o = openedFinding;
    if (!o || o.refused) return;
    if (o.pending) {
      const why = figureReady();
      if (why) {
        // An empty or error card once nothing is loading or fitting, not a figure still on its way.
        if (D.fatal || (D.summary && !$('empty').hidden && !D.inflight.size && !D.fitPending)) {
          o.pending = false;
          o.failed = D.fatal || ($('empty').querySelector('h3') || {}).textContent || why;
          o.changes = C.stateChanges(o.finding.state, S);
          renderFindingBar();
        }
        return;
      }
      o.pending = false;
      o.changes = C.stateChanges(o.finding.state, S);
      o.diff = C.compareEvidence(o.finding.evidence, evidence());
      o.key = C.stableJSON(S);
      renderFindingBar();
      return;
    }
    const diverged = !!o.key && C.stableJSON(S) !== o.key;
    if (diverged !== !!o.diverged) { o.diverged = diverged; renderFindingBar(); }
  }
  function stateText(c) {
    const show = v => (v === null || v === undefined ? 'none' : typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v));
    if (c.now === undefined) return `the setting “${c.key}” is not used by this version of electro_gui (saved as ${show(c.saved)})`;
    if (c.key === 'unit') return `unit ${c.saved} is not in this session; the figure shows unit ${c.now}`;
    if (c.key === 'align') return `the alignment ${eventLabel(c.saved)} is not in this session; the figure is aligned to ${eventLabel(c.now)}`;
    if (c.key === 'roster') {
      const gone = (c.saved || []).filter(id => !(c.now || []).includes(id));
      return `neuron${gone.length > 1 ? 's' : ''} ${gone.join(', ')} ${gone.length > 1 ? 'are' : 'is'} not in this session and left the population`;
    }
    if (c.key === 'markers') {
      const gone = (c.saved || []).filter(m => !(c.now || []).some(n => n.id === m.id)).map(m => m.label || eventLabel(m.e));
      return gone.length ? `marker${gone.length > 1 ? 's' : ''} ${gone.join(', ')} dropped: this session does not record the event` : `markers changed: ${show(c.saved)} → ${show(c.now)}`;
    }
    return `${STATE_LABELS[c.key] || c.key} was reset: saved ${show(c.saved)}, now ${show(c.now)}`;
  }
  function renderFindingBar() {
    const bar = $('findingBar'), o = openedFinding;
    if (!o) { bar.hidden = true; bar.innerHTML = ''; return; }
    const f = o.finding, pop = (f.state || {}).mode === 'population';
    const when = f.saved_at ? new Date(f.saved_at).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'}) : '';
    const status = STATUSES.includes(f.status) ? f.status : STATUSES[0];
    let tone, body;
    const lost = (o.changes || []).filter(c => NOT_RESTORED.has(c.key)), reset = (o.changes || []).filter(c => !NOT_RESTORED.has(c.key));
    const sentence = t => t.charAt(0).toUpperCase() + t.slice(1);
    const items = [...lost.map(c => `<li class="bad"><b>Not restored:</b> ${esc(stateText(c))}.</li>`),
      ...(o.diff || []).map(t => `<li>${esc(t)}</li>`), ...reset.map(c => `<li>${esc(sentence(stateText(c)))}.</li>`)];
    if (o.refused) { tone = 'bad'; body = `<p>${esc(o.refused)}</p>`; }
    else if (o.pending) { tone = 'wait'; body = '<p>Redrawing the saved figure, then comparing its numbers with the saved ones…</p>'; }
    else if (o.failed) { tone = 'bad'; body = `<p>The saved figure could not be redrawn: ${esc(o.failed)}.</p>${items.length ? `<ul>${items.join('')}</ul>` : ''}`; }
    else if (!items.length) {
      tone = 'ok';
      body = `<p>✓ Same data, same numbers: the session file, the ${pop ? 'neurons' : 'unit'} and every group's events, trials and ${pop ? 'fit' : 'count-window rate'} match what was saved.</p>`;
    } else {
      tone = lost.length ? 'bad' : 'warn';
      body = `<p>${items.length} difference${items.length > 1 ? 's' : ''} from when it was saved:</p><ul>${items.join('')}</ul>`;
    }
    const tags = (f.tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join('');
    bar.className = `finding-bar ${tone}`;
    if (o.notesOpen === undefined && !o.pending) o.notesOpen = !matchMedia('(max-width: 959px)').matches;   // on a phone the figure comes first
    bar.innerHTML = `<div class="fb-head"><div class="fb-title"><span class="st st-${status}">${status}</span><b>${esc(f.title || 'Finding')}</b>` +
      `<small>${when ? `saved ${esc(when)}` : ''}${f.saved_on ? ` on ${esc(f.saved_on)}` : ''}</small></div>` +
      (f.id ? `<a class="link" href="/findings/#${esc(f.id)}">Notes &amp; edit</a>` : '') +
      `<button type="button" class="close" data-fbclose aria-label="Close the finding">×</button></div>` + body +
      (f.note ? `<details class="fb-note"${o.notesOpen ? ' open' : ''}><summary>Notes</summary><p>${esc(f.note)}</p></details>` : '') +
      (tags ? `<div class="chips fb-tags">${tags}</div>` : '') +
      (o.diverged ? '<p class="fb-div">The view has changed since this finding was opened. <button type="button" class="link" data-fbback>Back to the saved view</button></p>' : '');
    bar.hidden = false;
  }

  function applyTemplate(t) {
    const keep = {session: S.session, unit: S.unit, policy: S.policy, unitQ: S.unitQ, unitArea: S.unitArea, tick: S.tick, rasterH: S.rasterH, rasterFit: S.rasterFit, psthH: S.psthH, bars: S.bars, err: S.err,
      mode: S.mode, roster: S.roster, method: S.method, scaling: S.scaling, ncomp: S.ncomp, tdrFactors: S.tdrFactors, tdrWin: S.tdrWin, dims: S.dims, heatNorm: S.heatNorm, nsort: S.nsort, axes: S.axes, popSplit: S.popSplit};
    S = sanitize({...clone(DEFAULTS), ...keep, ...clone(t.state)});
    afterBigChange();
    toast(`Template: ${t.name}`);
  }
  async function applyView(v) {
    const sessionChanged = v.state.session && v.state.session !== S.session;
    S = sanitize(clone(v.state));
    if (sessionChanged) { saveState(); await selectSession(S.session); renderStructure(); }
    else afterBigChange();
  }
  function afterBigChange() {
    if (!D.units.some(u => u.id === S.unit) && D.units.length) S.unit = D.units[0].id;
    renderStructure(); changed({data: true});
  }

  function openExport() {
    if (S.mode === 'population') {
      const html = popHead('Export') + `<div class="pop-body">` +
        `<button type="button" class="item" data-exp="svg"><span class="main"><b>Figure · SVG</b><small>vector, with title, legend and embedded settings</small></span></button>` +
        `<button type="button" class="item" data-exp="png"><span class="main"><b>Figure · PNG</b><small>2× resolution</small></span></button>` +
        `<button type="button" class="item" data-exp="coords"><span class="main"><b>Coordinates · CSV</b><small>every group's component time courses</small></span></button>` +
        `<button type="button" class="item" data-exp="loadings"><span class="main"><b>Loadings · CSV</b><small>one row per neuron: unit, channel, area, quality, loadings</small></span></button>` +
        (D.probeShown ? `<button type="button" class="item" data-exp="cloud"><span class="main"><b>Single-trial cloud · CSV</b><small>every ${D.probeShown.unit === 'event' ? 'event' : 'trial'}'s projection at t = 0 / reference lines</small></span></button>` : '') +
        `<button type="button" class="item" data-exp="json"><span class="main"><b>Settings & fit · JSON</b><small>roster, groups, method, variance explained, source SHA256</small></span></button></div>`;
      openPop($('exportBtn').offsetParent ? $('exportBtn') : $('menuBtn'), html);
      return;
    }
    const html = popHead('Export') + `<div class="pop-body">` +
      `<button type="button" class="item" data-exp="svg"><span class="main"><b>Figure · SVG</b><small>vector, with title, legend and embedded settings</small></span></button>` +
      `<button type="button" class="item" data-exp="png"><span class="main"><b>Figure · PNG</b><small>2× resolution, for slides and chat</small></span></button>` +
      `<button type="button" class="item" data-exp="psth"><span class="main"><b>PSTH · CSV</b><small>mean and SEM per group and time bin</small></span></button>` +
      `<button type="button" class="item" data-exp="rows"><span class="main"><b>Rows · CSV</b><small>one row per event: group, spike count and rate in the count window, marker times, fields</small></span></button>` +
      `<button type="button" class="item" data-exp="json"><span class="main"><b>Settings & provenance · JSON</b><small>source file, SHA256, unit, alignment, filters, knobs</small></span></button>` +
      `</div>`;
    openPop($('exportBtn').offsetParent ? $('exportBtn') : $('menuBtn'), html);
  }
  /** GET /api/health, or null from a server that predates it. */
  async function serverHealth() {
    try {
      const r = await fetch('/api/health', {cache: 'no-store'});
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }
  /**
   * Restart the server (it re-execs itself with the code now on disk, on the same
   * port and token), wait for a process with a new boot id, then reload the page.
   */
  async function restartServer() {
    if (!confirm('Restart the electro_gui server?\n\nIt loads the code now on disk and then reloads this page. A computation already running finishes first; queued ones are dropped.')) return;
    const overlay = document.createElement('div');
    overlay.className = 'restart-overlay';
    const say = (title, text) => { overlay.innerHTML = `<div class="loading-card"><div class="spinner"></div><div><b>${esc(title)}</b><p>${esc(text)}</p></div></div>`; };
    say('Restarting the server', 'Asking electro_gui to restart…');
    document.body.appendChild(overlay);
    let before;
    try {
      before = (await getJSON('/api/restart', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'})).boot;
    } catch (e) {
      overlay.remove();
      toast(/HTTP 404|Unknown endpoint/.test(e.message) ? 'This server predates the restart button: restart it once on the Mac.' : `Restart failed: ${e.message}`, true);
      return;
    }
    const t0 = Date.now();
    for (;;) {
      await sleep(1000);
      const h = await serverHealth();
      if (h && h.boot !== before) { location.reload(); return; }
      const s = Math.round((Date.now() - t0) / 1000);
      if (s > 180) {
        overlay.innerHTML = `<div class="loading-card"><div><b>The server has not come back</b><p>Nothing answered for 3 minutes. Reload this page to try again, or restart electro_gui on the Mac.</p><p><button class="primary" type="button">Reload</button></p></div></div>`;
        overlay.querySelector('button').addEventListener('click', () => location.reload());
        return;
      }
      say('Restarting the server', `Waiting for electro_gui to come back with the code on disk (${s} s)…`);
    }
  }
  function openMenu() {
    const theme = localStorage.getItem('eg-theme') || 'auto';
    const other = S.mode === 'population' ? ['raster', 'Rasters', 'one unit: raster over PSTH'] : ['population', 'Population', 'many neurons: heatmap, components, trajectories'];
    const html = popHead('electro_gui') + `<div class="pop-body"><button type="button" class="item" data-menu="mode:${other[0]}"><span class="main"><b>Switch to ${other[1]}</b><small>${other[2]}</small></span></button><button type="button" class="item" data-menu="views"><span class="main"><b>Views & templates</b><small>apply a template or config file, reopen a finding, copy a link</small></span></button>` +
      `<button type="button" class="item" data-menu="savefinding"><span class="main"><b>Save finding…</b><small>this figure, with notes and the numbers it shows</small></span></button>` +
      `<a class="item" href="/findings/"><span class="main"><b>Findings</b><small>every saved finding, with its picture, notes and status</small></span></a>` +
      `<button type="button" class="item" data-menu="export"><span class="main"><b>Export</b><small>SVG, PNG, CSV, settings</small></span></button>` +
      `<button type="button" class="item" data-menu="restart"><span class="main"><b>Restart server</b><small id="restartInfo">load the code now on disk, then reload this page</small></span></button><div class="editor">` +
      `<label class="row"><span>Session</span><select id="menuSession">${D.catalog.map(s => `<option value="${esc(s.id)}"${s.id === S.session ? ' selected' : ''}>${esc(shortSession(s.id))}</option>`).join('')}</select></label>` +
      `<div class="row"><span>Theme</span><div class="seg" id="themeSeg">${['auto', 'light', 'dark'].map(t => `<button type="button" data-theme="${t}" class="${theme === t ? 'on' : ''}">${t}</button>`).join('')}</div></div>` +
      `<p class="pop-note" style="padding:0"><b>Shortcuts</b> — ← / → previous / next unit · drag across the PSTH to set the count window · click a legend entry to hide a group, double-click to show only it.</p>` +
      `<p class="pop-note" style="padding:0">${D.summary ? `${esc(D.summary.session_id)} · ${D.summary.counts.units} units · ${D.summary.counts.trials} trials<br><code>${esc(D.summary.source.path || '')}</code>` : ''}</p>` +
      `</div></div>`;
    openPop($('menuBtn'), html);
    $('menuSession').addEventListener('change', e => { closePop(); selectSession(e.target.value).then(renderStructure); });
    serverHealth().then(h => {
      const el = document.getElementById('restartInfo');
      if (!el || !h) return;
      const since = new Date(h.started * 1000), n = h.code_changed.length;
      const when = since.toDateString() === new Date().toDateString() ? since.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : since.toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
      el.textContent = `running since ${when} · ${n ? `${n} file${n > 1 ? 's' : ''} changed` : 'code up to date'}`;
      el.title = n ? `Changed since the server started: ${h.code_changed.join(', ')}` : '';
      if (n) el.style.color = 'var(--accent)';
    });
    $('themeSeg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { localStorage.setItem('eg-theme', b.dataset.theme); applyTheme(); openMenu(); }));
  }

  // ============================================================ population
  // One joint basis over the condition means of the same groups the raster view
  // shows (filters x colour x line style), for an explicit neuron roster.
  const AREA_PALETTE = ['#0c8599', '#e8590c', '#7048e8', '#2b8a3e', '#c2255c', '#5c940d'];
  const popSpansKey = () => `${S.roster.join(',')}|${S.align}|${S.policy}`;
  const compName = (k, method = S.method) => {
    if (method === 'tdr') { const f = D.popFit; return (f && f.method === 'tdr' && f.axis_names && f.axis_names[k]) || tdrLabel(S.tdrFactors[k]) || `TDR${k + 1}`; }
    return `${method === 'pca' ? 'PC' : method === 'ica' ? 'IC' : 'F'}${k + 1}`;
  };
  const tdrLabel = key => { const T = D.tables.get(S.align), c = T && key && T.byKey.get(key); return c ? c.label : key; };
  /** Number of axes the fit will have: one per TDR factor, else the component knob. */
  const nComp = () => (S.method === 'tdr' ? S.tdrFactors.length : S.ncomp);
  /** The TDR window actually requested: the display window unless the user narrowed it. */
  const tdrWindow = () => { const w = S.tdrWin || S.win; return [Math.max(w[0], S.win[0]), Math.min(w[1], S.win[1])]; };
  function renderTdrFactors() {
    $('tdrLabel').textContent = S.tdrFactors.length ? S.tdrFactors.map(tdrLabel).join(' · ') : 'no factors';
  }
  function openTdrPicker() {
    const T = D.tables.get(S.align);
    const cols = T ? T.columns.filter(c => c.kind === 'cat' && c.levels.length <= 8 && !S.tdrFactors.includes(c.key)) : [];
    const chip = (k, on) => `<button type="button" class="chip${on ? ' on' : ''}" data-tdr="${esc(k)}" aria-pressed="${on}">${esc(tdrLabel(k))}</button>`;
    const html = popHead('TDR factors') + `<div class="pop-body">` +
      `<div class="pop-group">Factors · ${nComp()} axes · tap to add or remove</div>` +
      `<div class="chips tdr-chips">${S.tdrFactors.map(k => chip(k, true)).join('')}${cols.map(c => chip(c.key, false)).join('')}</div></div>` +
      `<div class="pop-foot"><button type="button" class="small" data-tdr-reset>Defaults</button><button type="button" class="primary" data-close>Done</button></div>`;
    const body = $('popover').hidden ? null : $('popover').querySelector('.pop-body');
    const scroll = body && $('popover').querySelector('.tdr-chips') ? body.scrollTop : 0;
    openPop($('tdrBtn'), html, {wide: true});
    const fresh = $('popover').querySelector('.pop-body');
    if (fresh) fresh.scrollTop = scroll;
  }
  const unitShort = u => (u ? `unit ${u.id}${u.peak_channel !== null && u.peak_channel !== undefined ? ` · ch ${u.peak_channel}` : ''}` : '');
  function areaColor(area) {
    const areas = [...new Set(D.units.map(u => u.area).filter(Boolean))].sort();
    const i = areas.indexOf(area);
    return paint(i < 0 ? MISSING_COLOR : AREA_PALETTE[i % AREA_PALETTE.length]);
  }

  function decodeStability(raw) {
    const masks = new Map();
    for (const [id, b64] of Object.entries(raw.units)) masks.set(Number(id), C.decodeMask(b64));
    return {trials: raw.trials, n: raw.trials.length, masks};
  }
  function sharedMask(ids) {
    let acc = C.fullMask(D.stab.n);
    for (const id of ids) acc = C.andMask(acc, D.stab.masks.get(id) || new Uint8Array(acc.length));
    return acc;
  }
  function sharedCount(ids) {
    if (S.policy === 'all_complete') return D.summary ? D.summary.counts.complete_trials : null;
    if (!D.stab) return null;
    return ids.length ? C.popcount(sharedMask(ids), D.stab.n) : 0;
  }
  /** Roster units whose removal would regain the most shared stable trials. */
  function limitingUnits(ids) {
    if (!D.stab || S.policy !== 'verified_stable' || ids.length < 2) return [];
    const N = ids.length, nt = D.stab.n;
    const masks = ids.map(id => D.stab.masks.get(id) || new Uint8Array((nt + 7) >> 3));
    const prefix = [], suffix = new Array(N);
    let acc = C.fullMask(nt);
    for (let i = 0; i < N; i++) { prefix.push(acc); acc = C.andMask(acc, masks[i]); }
    const base = C.popcount(acc, nt);
    acc = C.fullMask(nt);
    for (let i = N - 1; i >= 0; i--) { suffix[i] = acc; acc = C.andMask(acc, masks[i]); }
    return ids.map((id, i) => ({id, gain: C.popcount(C.andMask(prefix[i], suffix[i]), nt) - base}))
      .filter(x => x.gain > 0).sort((a, b) => b.gain - a.gain).slice(0, 3);
  }

  function rosterPresetList() {
    const q = u => String(u.quality || '').toLowerCase();
    const areas = [...new Set(D.units.map(u => u.area).filter(Boolean))].sort();
    const out = [{id: 'stable', label: 'Shared-stable SUA + MUA', hint: 'Greedy search for the most neurons × stable trials they all share (not a guaranteed optimum); sets Trials to stable.'}];
    out.push({id: 'sua', label: 'All SUA', ids: D.units.filter(u => q(u) === 'sua').map(u => u.id)});
    out.push({id: 'suamua', label: 'All SUA + MUA', ids: D.units.filter(u => q(u) === 'sua' || q(u) === 'mua').map(u => u.id)});
    for (const a of areas) out.push({id: `sua:${a}`, label: `${a} SUA`, ids: D.units.filter(u => q(u) === 'sua' && u.area === a).map(u => u.id)});
    return out;
  }
  async function applyRosterPreset(id) {
    if (id === 'stable') {
      try {
        const r = await getJSON(`/api/explorer/stable_roster?${query({session: S.session})}`);
        S.roster = r.unit_ids.slice().sort((a, b) => a - b);
        S.policy = 'verified_stable';
        toast(`${r.n_units} neurons sharing ${r.n_trials} stable trials (greedy heuristic).`);
      } catch (e) { toast(e.message, true); return; }
    } else {
      const p = rosterPresetList().find(x => x.id === id);
      if (!p) return;
      S.roster = p.ids.slice().sort((a, b) => a - b);
    }
    rosterChanged();
  }
  let rosterTimer = 0;
  function rosterChanged(delay = 0) {
    renderRosterSection();
    clearTimeout(rosterTimer);
    rosterTimer = setTimeout(() => changed({data: true}), delay);
  }

  function renderRosterSection() {
    if (!D.summary) return;
    const ids = S.roster;
    const areas = new Map(), quals = new Map();
    for (const id of ids) {
      const u = D.unitMap.get(id);
      const a = (u && u.area) || '?', q = u ? String(u.quality).toUpperCase() : '?';
      areas.set(a, (areas.get(a) || 0) + 1); quals.set(q, (quals.get(q) || 0) + 1);
    }
    const shared = sharedCount(ids);
    $('rosterLabel').textContent = ids.length ? `${ids.length} neurons` : 'no neurons';
    const sharedText = shared === null ? 'checking shared trials…'
      : S.policy === 'all_complete' ? `all <b>${shared}</b> complete trials (no stability filter)`
        : `<b>${shared}</b> stable trials shared by all of them`;
    $('rosterSummary').innerHTML = ids.length
      ? `<div class="big"><b>${ids.length}</b> neurons · ${[...areas].map(([a, n]) => `${esc(a)} ${n}`).join(' · ')}</div>` +
        `<div>${[...quals].map(([q, n]) => `${esc(q)} ${n}`).join(' · ')}</div><div class="${shared === 0 ? 'warn' : ''}">${sharedText}</div>`
      : '<div>No neurons chosen yet — pick a set below.</div>';
    $('rosterPresets').innerHTML = rosterPresetList().map(p =>
      `<button type="button" class="preset" data-rp="${esc(p.id)}" title="${esc(p.hint || `${p.ids.length} neurons`)}">${esc(p.label)}${p.ids ? ` · ${p.ids.length}` : ''}</button>`).join('');
    const lim = limitingUnits(ids);
    const zero = D.stab && S.policy === 'verified_stable' ? ids.filter(id => !D.stab.masks.has(id) || C.popcount(D.stab.masks.get(id), D.stab.n) === 0) : [];
    const trimRow = D.stab && S.policy === 'verified_stable' && ids.length > 2 && shared !== null && shared < 100
      ? `<div class="limit"><span>Keep the subset of these neurons with the most neurons × shared stable trials</span><button type="button" class="small" data-trim>trim</button></div>` : '';
    const zeroRow = zero.length ? `<div class="limit"><span>${zero.length} neuron${zero.length === 1 ? ' has' : 's have'} no stable trials at all</span><button type="button" class="small" data-rmzero>remove</button></div>` : '';
    $('rosterLimits').innerHTML = zeroRow + trimRow + (lim.length ? '<span class="mini-label" style="margin:0 0 2px">Most limiting — trials regained if removed</span>' +
      lim.map(x => { const u = D.unitMap.get(x.id); return `<div class="limit"><span>${esc(unitShort(u))} · ${esc((u && u.area) || '')}</span><b>+${x.gain}</b><button type="button" class="small" data-rmunit="${x.id}">remove</button></div>`; }).join('') : '');
  }

  const RF = {q: ['sua', 'mua'], a: [], text: ''};
  function rosterShown() {
    const t = RF.text.trim().toLowerCase();
    return D.units.filter(u => (!RF.q.length || RF.q.includes(String(u.quality).toLowerCase())) && (!RF.a.length || RF.a.includes(u.area)) &&
      (!t || `${u.id} ch${u.peak_channel} ch ${u.peak_channel} ${u.area} ${u.quality}`.toLowerCase().includes(t)));
  }
  function openRosterPicker(anchor) {
    const areas = [...new Set(D.units.map(u => u.area).filter(Boolean))].sort();
    const qs = [...new Set(D.units.map(u => String(u.quality).toLowerCase()))];
    const html = popHead('Choose neurons') +
      `<div class="pop-search"><input type="search" id="rosterSearch" placeholder="unit id, channel, area…" autocomplete="off" value="${esc(RF.text)}">` +
      `<div class="chips">${qs.map(q => `<button type="button" class="chip${RF.q.includes(q) ? ' on' : ''}" data-rq="${esc(q)}">${esc(q.toUpperCase())}</button>`).join('')}` +
      `${areas.map(a => `<button type="button" class="chip${RF.a.includes(a) ? ' on' : ''}" data-ra="${esc(a)}">${esc(a)}</button>`).join('')}</div>` +
      `<div class="pop-live" id="rosterLive"></div></div><div class="pop-body" id="rosterItems"></div>` +
      `<div class="pop-foot"><button type="button" class="small" data-rall>Add all listed</button><button type="button" class="small" data-rnone>Remove listed</button><button type="button" class="primary" data-close>Done</button></div>`;
    openPop(anchor, html, {wide: true});
    fillRosterItems();
  }
  function rosterLive() {
    const shared = sharedCount(S.roster);
    const el = $('rosterLive');
    if (el) el.innerHTML = `<b>${S.roster.length}</b> selected · <b>${shared === null ? '…' : shared}</b> ${S.policy === 'all_complete' ? 'complete' : 'shared stable'} trials · ${rosterShown().length} listed`;
  }
  function fillRosterItems() {
    const set = new Set(S.roster);
    const list = rosterShown();
    $('rosterItems').innerHTML = list.slice(0, 900).map(u => {
      const stable = D.stab && D.stab.masks.has(u.id) ? C.popcount(D.stab.masks.get(u.id), D.stab.n) : null;
      return `<button type="button" class="item${set.has(u.id) ? ' on' : ''}" data-ru="${u.id}"><span class="check">✓</span><span class="main"><b>${esc(unitShort(u))}</b>` +
        `<small>${esc(u.area || 'area ?')} · ${C.fmtNum(u.rate, 1)} spikes/s${stable === null ? '' : ` · ${stable} stable trials`}</small></span><span class="q ${esc(String(u.quality).toLowerCase())}">${esc(u.quality)}</span></button>`;
    }).join('') || '<div class="pop-note">No units match.</div>';
    rosterLive();
  }

  function buildPopModel() {
    const T = D.tables.get(S.align);
    if (!T) return null;
    if (!S.roster.length) return {T, needRoster: true};
    const P = D.popspans.get(popSpansKey());
    if (!P || P.n !== T.n) return null;
    const [pre, post] = S.win;
    clampCw();
    const elig = C.eligibility(P, pre, post);
    const fmask = C.filterMask(T, activeFilters(T));
    const rows = [], excl = {1: 0, 2: 0, 3: 0};
    let filtered = 0;
    for (let i = 0; i < T.n; i++) {
      if (!fmask[i]) { filtered++; continue; }
      if (elig[i]) excl[elig[i]]++; else rows.push(i);
    }
    const grouping = C.groupRows(T, rows, {color: validField(T, S.color), style: validField(T, S.style), panel: null, qbins: S.qbins});
    grouping.hasMissingColor = grouping.groups.some(g => g.colorKey === C.MISSING);
    const hidden = new Set(S.hidden);
    for (const g of grouping.groups) {
      const own = S.gstyle[g.key] || {};
      g.hidden = hidden.has(g.key);
      g.color = own.c ? paint(own.c) : groupColor(g, grouping, T);
      g.dash = Number.isInteger(own.d) ? DASHES[own.d % DASHES.length] : DASHES[g.styleIndex % DASHES.length];
    }
    const markerData = {};
    for (const m of S.markers) {
      if (m.off) continue;
      const start = D.events.get(m.e), end = m.end ? D.events.get(m.end) : null;
      if (start && (!m.end || end)) markerData[m.id] = C.markerTimes(T, rows, start, m, end);
    }
    return {T, raster: P, rows, grouping, visible: grouping.groups.filter(g => !g.hidden), excl, filtered, markerData,
      pre, post, cw: S.cw, common: P.common_trials, pop: true};
  }

  function fitRequest(M) {
    return {session_id: S.session, unit_ids: S.roster.slice(), alignment: S.align, policy: S.policy,
      pre: S.win[0], post: S.win[1], bin: S.bin, sigma: S.sigma, weight: S.weight, method: S.method,
      scaling: S.scaling, components: nComp(),
      ...(S.method === 'tdr' ? {factors: S.tdrFactors.slice(), tdr_window: tdrWindow()} : {}),
      groups: M.grouping.groups.map(g => ({key: g.key, label: g.label, row_ids: g.rows.map(i => M.T.rowId[i])}))};
  }
  function prepareFit(fit) {
    fit.groupIndex = new Map(fit.groups.map((g, i) => [g.key, i]));
    const U = fit.active_unit_ids.length, n = fit.times.length;
    const mu = new Float64Array(U), sd = new Float64Array(U), mx = new Float64Array(U);
    let count = 0;
    for (const g of fit.groups) for (const row of g.means) { count++; for (let u = 0; u < U; u++) { mu[u] += row[u]; mx[u] = Math.max(mx[u], row[u]); } }
    for (let u = 0; u < U; u++) mu[u] /= Math.max(1, count);
    for (const g of fit.groups) for (const row of g.means) for (let u = 0; u < U; u++) sd[u] += (row[u] - mu[u]) ** 2;
    for (let u = 0; u < U; u++) sd[u] = Math.sqrt(sd[u] / Math.max(1, count)) || 1;
    fit.stats = {mu, sd, mx, n};
  }
  let fitTimer = 0;
  function requestFit(req, key) {
    if (D.fits.has(key) || D.fitErrors.has(key) || D.fitPending === key) return;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(async () => {
      D.fitPending = key;
      schedule();
      try {
        const res = await getJSON('/api/explorer/popfit', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(req)});
        prepareFit(res);
        D.fits.set(key, res);
        if (D.fits.size > 6) D.fits.delete(D.fits.keys().next().value);
      } catch (e) { D.fitErrors.set(key, e.message); }
      finally { if (D.fitPending === key) D.fitPending = null; schedule(); }
    }, 300);
  }

  // t = 0 is a circle; reference lines take these shapes in time order, on trajectories and in the cloud.
  const REF_SHAPES = ['square', 'tri', 'tridown', 'plus'];
  const SHAPE_GLYPH = {circle: '●', square: '■', tri: '▲', tridown: '▼', plus: '✚'};
  function shapePath(kind, x, y, r) {
    const q = v => f1(v);
    if (kind === 'square') return `M${q(x - r)} ${q(y - r)}h${q(2 * r)}v${q(2 * r)}h${q(-2 * r)}z`;
    if (kind === 'tri') return `M${q(x)} ${q(y - 1.25 * r)}l${q(1.15 * r)} ${q(2 * r)}h${q(-2.3 * r)}z`;
    if (kind === 'tridown') return `M${q(x)} ${q(y + 1.25 * r)}l${q(1.15 * r)} ${q(-2 * r)}h${q(-2.3 * r)}z`;
    if (kind === 'plus') { const a = r * 0.42; return `M${q(x - a)} ${q(y - r)}h${q(2 * a)}v${q(r - a)}h${q(r - a)}v${q(2 * a)}h${q(a - r)}v${q(r - a)}h${q(-2 * a)}v${q(a - r)}h${q(a - r)}v${q(-2 * a)}h${q(r - a)}z`; }
    return `M${q(x - r)} ${q(y)}a${q(r)} ${q(r)} 0 1 0 ${q(2 * r)} 0a${q(r)} ${q(r)} 0 1 0 ${q(-2 * r)} 0`;
  }
  const shapeFor = (t, refTimes) => (t === 0 && !refTimes.includes(0) ? 'circle' : REF_SHAPES[Math.max(0, refTimes.indexOf(t)) % REF_SHAPES.length]);

  /** Times at which single trials are projected: t = 0 (optional) and every reference line in the window. */
  function cloudTimes(fit) {
    const [pre, post] = fit.window;
    const times = S.refs.filter(r => r >= pre && r <= post);
    if (S.cloudZero && pre <= 0 && post >= 0) times.push(0);
    return [...new Set(times.map(t => tidy(t, 4)))].sort((a, b) => a - b).slice(0, 12);
  }
  let probeTimer = 0;
  function requestProbe(req, key) {
    if (D.probes.has(key) || D.probeErrors.has(key) || D.probePending === key) return;
    clearTimeout(probeTimer);
    probeTimer = setTimeout(async () => {
      D.probePending = key;
      try {
        const res = await getJSON('/api/explorer/popprobe', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(req)});
        D.probes.set(key, res);
        if (D.probes.size > 8) D.probes.delete(D.probes.keys().next().value);
      } catch (e) { D.probeErrors.set(key, e.message); toast(`Single trials: ${e.message}`, true); }
      finally { if (D.probePending === key) D.probePending = null; schedule(); }
    }, 150);
  }

  function neuronOrder(fit, gi) {
    const U = fit.active_unit_ids.length, idx = [...Array(U).keys()];
    const [kind, arg] = String(S.nsort).split(':');
    const units = fit.active_unit_ids.map(id => D.unitMap.get(id) || {id});
    if (kind === 'loading') { const k = Math.min(Number(arg) || 0, fit.components - 1); idx.sort((a, b) => fit.loadings[b][k] - fit.loadings[a][k]); }
    else if (kind === 'peak') {
      const M = fit.groups[gi].means;
      const peak = idx.map(u => { let best = 0; for (let t = 1; t < M.length; t++) if (M[t][u] > M[best][u]) best = t; return best; });
      idx.sort((a, b) => peak[a] - peak[b] || a - b);
    } else if (kind === 'rate') idx.sort((a, b) => fit.stats.mu[b] - fit.stats.mu[a]);
    else if (kind === 'channel') idx.sort((a, b) => (units[a].peak_channel ?? 1e9) - (units[b].peak_channel ?? 1e9));
    else if (kind === 'area') idx.sort((a, b) => String(units[a].area).localeCompare(String(units[b].area)) || (units[a].peak_channel ?? 0) - (units[b].peak_channel ?? 0));
    else idx.sort((a, b) => fit.active_unit_ids[a] - fit.active_unit_ids[b]);
    return idx;
  }
  function heatImage(fit, gi, order) {
    const key = `${D.popKey}|${gi}|${S.heatNorm}|${S.nsort}|${isDark()}`;
    if (D.heatCache.has(key)) return D.heatCache.get(key);
    const M = fit.groups[gi].means, n = M.length, U = order.length;
    const canvas = document.createElement('canvas');
    canvas.width = n; canvas.height = U;
    const ctx = canvas.getContext('2d'), img = ctx.createImageData(n, U), dark = isDark();
    order.forEach((u, r) => {
      for (let t = 0; t < n; t++) {
        const v = S.heatNorm === 'z' ? (M[t][u] - fit.stats.mu[u]) / fit.stats.sd[u] : M[t][u] / (fit.stats.mx[u] || 1);
        const [R, G, B] = C.heatColor(v, S.heatNorm, dark);
        const o = (r * n + t) * 4;
        img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
      }
    });
    ctx.putImageData(img, 0, 0);
    const url = canvas.toDataURL('image/png');
    D.heatCache.set(key, url);
    if (D.heatCache.size > 12) D.heatCache.delete(D.heatCache.keys().next().value);
    return url;
  }
  const loadingComp = fit => (String(S.nsort).startsWith('loading:') ? Math.min(Number(S.nsort.split(':')[1]) || 0, fit.components - 1) : 0);
  function heatGroupIndex(M, fit) {
    const vis = M.visible.filter(g => fit.groupIndex.has(g.key));
    const pick = vis.find(g => g.key === S.heatGroup) || vis[0] || M.grouping.groups.find(g => fit.groupIndex.has(g.key));
    return pick ? {g: pick, gi: fit.groupIndex.get(pick.key)} : null;
  }

  /** The population figure as one SVG; opts.export adds title and legend. */
  function popFigureSVG(M, fit, width, opts = {}) {
    const ink = figVar('--fig-ink'), muted = figVar('--fig-muted'), gridC = figVar('--fig-grid'),
      axisC = figVar('--fig-axis'), windowC = figVar('--fig-window'), bg = figVar('--fig-bg');
    const font = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif';
    const f = f1, narrow = width < 760;
    const K = fit.components, times = fit.times, n = times.length, pre = fit.window[0], post = fit.window[1];
    const vis = M.visible.filter(g => fit.groupIndex.has(g.key)).map(g => ({g, fg: fit.groups[fit.groupIndex.get(g.key)]}));
    const pct = k => `${C.fmtNum(100 * fit.component_r2[k], 1)}%`;
    const out = [];
    let top = 0;
    if (opts.export) {
      const legend = exportLegend({visible: vis.map(({g}) => ({...g, psth: {n: S.weight === 'trial' ? new Set(g.rows.map(i => M.T.trial[i])).size : g.rows.length}}))}, width, font, ink, muted);
      out.push(`<text x="0" y="16" font-size="14" font-weight="600" fill="${ink}">${esc(opts.title)}</text>`,
        `<text x="0" y="34" font-size="11.5" fill="${muted}">${esc(opts.subtitle)}</text>`, `<g transform="translate(0,46)">${legend.svg}</g>`);
      top = 52 + legend.height;
    }
    const gap = 26;
    // Wide: the trajectory and the time courses split the row S.popSplit : 1 - S.popSplit
    // (drag the gap between them; double-click it for half each).  The trajectory box is
    // as tall as it is wide, up to 600 px, and keeps equal axis scales inside.
    const avail = width - gap;
    const trajW = narrow ? Math.min(width, 400) : Math.round(clamp(avail * S.popSplit, SPLIT_MIN, avail - SPLIT_MIN));
    const trajS = narrow ? trajW : Math.min(trajW, 600);
    // Exports draw every component; on screen, past TC_SHOWN the panels scroll under a
    // one-line header and above a fixed time axis.
    const tcShown = opts.export ? K : Math.min(K, TC_SHOWN), tcScroll = tcShown < K, tcHead = tcScroll ? 18 : 0;
    const tcPanel = clamp(Math.round((trajS - 34) / tcShown), 56, 110);
    const tcH = tcHead + tcPanel * tcShown + 34;
    const traj = {x: 0, y: top, w: trajW, h: trajS};
    const tc = narrow ? {x: 0, y: top + trajS + gap, w: width, h: tcH} : {x: trajW + gap, y: top, w: width - trajW - gap, h: tcH};
    const row1 = narrow ? trajS + gap + tcH : Math.max(trajS, tcH);
    const U = fit.active_unit_ids.length;
    const loadW = narrow ? 84 : 150;
    const heat = {x: 0, y: top + row1 + gap + 20, w: width - loadW - 14, h: clamp(U * 4, 150, 520)};
    const load = {x: width - loadW, y: heat.y, w: loadW, h: heat.h};
    const varY = heat.y + heat.h + 44 + gap;
    // Bars, then the cumulative curve to their right (below them on phones); the
    // diagnostics take what is left of the row, or go underneath.
    const vbox = {x: 0, y: varY, w: narrow ? width : Math.min(440, Math.round(width * 0.4)), h: 136};
    const cbox = narrow ? {x: 0, y: varY + vbox.h + 18, w: width, h: 136} : {x: vbox.w + 34, y: varY, w: Math.min(360, Math.round(width * 0.3)), h: 136};
    const dRight = !narrow && width - (cbox.x + cbox.w + 34) >= 540;
    const dbox = dRight ? {x: cbox.x + cbox.w + 34, y: varY + 10, w: width - cbox.x - cbox.w - 34} : {x: 0, y: cbox.y + cbox.h + 18, w: width};
    const height = Math.ceil(dRight ? varY + vbox.h + 8 : dbox.y + 96);
    const layout = {width, height, n, times, pre, post, vis, split: narrow ? null : {avail, w: trajW}};
    let tcOverlay = '';
    // A time marks the bin that contains it: the same rule the server uses for single-trial probes.
    const idxOf = t => clamp(Math.floor((t - pre) / fit.bin + 1e-9), 0, n - 1);
    const zeroIdx = pre <= 0 && post > 0 ? idxOf(0) : -1;
    const refTimes = [...new Set(S.refs.filter(r => r >= pre && r <= post))].sort((x, y) => x - y);
    const cwIdx = times.map((t, j) => (t >= M.cw[0] && t <= M.cw[1] ? j : -1)).filter(j => j >= 0);
    const markers = S.markers.filter(m => !m.off && M.markerData[m.id]);
    const medianIdx = (m, rows) => {
      const med = C.median(rows.map(i => (M.markerData[m.id][i] && M.markerData[m.id][i][0] ? M.markerData[m.id][i][0].t : NaN)));
      return med >= pre && med <= post ? {t: med, j: idxOf(med)} : null;
    };

    // ---- trajectory
    {
      let [a, b, c3] = S.axes;
      const three = S.dims === '3' && K >= 3;
      const pad = 34, inner = Math.min(traj.w, traj.h) - 2 * pad;
      const pts = vis.map(({fg}) => fg.coords);
      const cloud = [];
      if (D.probeShown && !opts.noCloud) {
        const byKey = new Map(vis.map(({g}) => [g.key, g]));
        for (const pr of D.probeShown.probes) for (const pg of pr.groups) {
          const g = byKey.get(pg.key);
          if (!g) continue;
          const keep = C.thin([...pg.points.keys()], 1500);
          for (const k of keep) cloud.push({g, t: pr.t, centre: pr.bin_centre, id: pg.ids[k], c: pg.points[k]});
        }
      }
      const quantile = (v, q) => { const a = v.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : NaN; };
      let project, cx = 0, cy = 0, scale = 1;
      if (three) {
        const mean = [0, 0, 0]; let cnt = 0;
        for (const P of pts) for (const p of P) { mean[0] += p[a]; mean[1] += p[b]; mean[2] += p[c3]; cnt++; }
        mean.forEach((v, i) => { mean[i] = v / Math.max(1, cnt); });
        let R = 1e-9;
        for (const P of pts) for (const p of P) R = Math.max(R, Math.hypot(p[a] - mean[0], p[b] - mean[1], p[c3] - mean[2]));
        if (cloud.length && S.cloudFit === 'cloud') R = Math.max(R, quantile(cloud.map(({c: p}) => Math.hypot(p[a] - mean[0], p[b] - mean[1], p[c3] - mean[2])), 0.98) || 0);
        scale = inner / (2.1 * R);
        project = p => { const q = C.project3d(p[a] - mean[0], p[b] - mean[1], p[c3] - mean[2], D.view3d.yaw, D.view3d.pitch); return [traj.x + traj.w / 2 + q[0] * scale, traj.y + traj.h / 2 - q[1] * scale]; };
        const axisEnd = R * 0.95;
        [[1, 0, 0, a], [0, 1, 0, b], [0, 0, 1, c3]].forEach(([ux, uy, uz, k]) => {
          const q = C.project3d(ux * axisEnd, uy * axisEnd, uz * axisEnd, D.view3d.yaw, D.view3d.pitch);
          const x2 = traj.x + traj.w / 2 + q[0] * scale, y2 = traj.y + traj.h / 2 - q[1] * scale;
          out.push(`<line x1="${f(traj.x + traj.w / 2)}" y1="${f(traj.y + traj.h / 2)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${axisC}" stroke-width="1" stroke-dasharray="3 3"/>`,
            `<text x="${f(x2 + (q[0] >= 0 ? 4 : -4))}" y="${f(y2 - 3)}" font-size="10.5" fill="${muted}" text-anchor="${q[0] >= 0 ? 'start' : 'end'}">${compName(k)}</text>`);
        });
      } else {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const P of pts) for (const p of P) { x0 = Math.min(x0, p[a]); x1 = Math.max(x1, p[a]); y0 = Math.min(y0, p[b]); y1 = Math.max(y1, p[b]); }
        if (cloud.length && S.cloudFit === 'cloud') {
          const xs = cloud.map(({c: p}) => p[a]), ys = cloud.map(({c: p}) => p[b]);
          x0 = Math.min(x0, quantile(xs, 0.01)); x1 = Math.max(x1, quantile(xs, 0.99));
          y0 = Math.min(y0, quantile(ys, 0.01)); y1 = Math.max(y1, quantile(ys, 0.99));
        }
        cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;
        scale = Math.min((traj.w - 2 * pad) / Math.max(x1 - x0, 1e-9), (traj.h - 2 * pad) / Math.max(y1 - y0, 1e-9)) / 1.08;
        project = p => [traj.x + traj.w / 2 + (p[a] - cx) * scale, traj.y + traj.h / 2 - (p[b] - cy) * scale];
        const zx = traj.x + traj.w / 2 - cx * scale, zy = traj.y + traj.h / 2 + cy * scale;
        if (zx > traj.x + pad && zx < traj.x + traj.w - pad) out.push(`<line x1="${f(zx)}" x2="${f(zx)}" y1="${f(traj.y + pad)}" y2="${f(traj.y + traj.h - pad)}" stroke="${gridC}"/>`);
        if (zy > traj.y + pad && zy < traj.y + traj.h - pad) out.push(`<line x1="${f(traj.x + pad)}" x2="${f(traj.x + traj.w - pad)}" y1="${f(zy)}" y2="${f(zy)}" stroke="${gridC}"/>`);
        out.push(`<text x="${f(traj.x + traj.w / 2)}" y="${f(traj.y + traj.h - 8)}" text-anchor="middle" font-size="11.5" fill="${ink}">${compName(a)} · ${pct(a)}</text>`,
          `<text transform="translate(${f(traj.x + 12)},${f(traj.y + traj.h / 2)}) rotate(-90)" text-anchor="middle" font-size="11.5" fill="${ink}">${compName(b)} · ${pct(b)}</text>`);
      }
      out.push(`<rect x="${f(traj.x + 0.5)}" y="${f(traj.y + 0.5)}" width="${f(traj.w - 1)}" height="${f(traj.h - 1)}" rx="10" fill="none" stroke="${gridC}"/>`);
      const screen = vis.map(({fg}) => fg.coords.map(project));
      out.push(`<clipPath id="trajClip"><rect x="${f(traj.x + 1)}" y="${f(traj.y + 1)}" width="${f(traj.w - 2)}" height="${f(traj.h - 2)}" rx="10"/></clipPath><g clip-path="url(#trajClip)">`);
      const cloudScreen = [];
      if (cloud.length) {
        const r = narrow ? 1.9 : 2.4, byGroup = new Map();
        let outside = 0;
        for (const pt of cloud) {
          const [x, y] = project(pt.c);
          if (x < traj.x || x > traj.x + traj.w || y < traj.y || y > traj.y + traj.h) outside++;
          cloudScreen.push({...pt, x, y});
          byGroup.set(pt.g, (byGroup.get(pt.g) || '') + shapePath(shapeFor(pt.t, refTimes), x, y, r));
        }
        layout.cloudOutside = outside;
        for (const [g, d] of byGroup) out.push(`<path d="${d}" fill="${g.color}" fill-opacity="${S.cloudAlpha}"/>`);
      }
      vis.forEach(({g}, vi) => {
        const P = screen[vi];
        if (cwIdx.length > 1) out.push(`<path d="${cwIdx.map((j, k) => `${k ? 'L' : 'M'}${f(P[j][0])} ${f(P[j][1])}`).join('')}" fill="none" stroke="${g.color}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity="0.28"/>`);
        out.push(`<path d="${P.map((p, j) => `${j ? 'L' : 'M'}${f(p[0])} ${f(p[1])}`).join('')}" fill="none" stroke="${g.color}" stroke-width="2" stroke-linejoin="round"${g.dash ? ` stroke-dasharray="${g.dash}"` : ''}/>`);
        out.push(`<circle cx="${f(P[0][0])}" cy="${f(P[0][1])}" r="3.6" fill="${bg}" stroke="${g.color}" stroke-width="1.6"/>`);
        if (zeroIdx >= 0) out.push(`<circle cx="${f(P[zeroIdx][0])}" cy="${f(P[zeroIdx][1])}" r="4.2" fill="${g.color}" stroke="${bg}" stroke-width="1.5"/>`);
        for (const r of refTimes) { const [x, y] = P[idxOf(r)]; out.push(`<path class="refmark" d="${shapePath(shapeFor(r, refTimes), x, y, 4.2)}" fill="${g.color}" stroke="${bg}" stroke-width="1.4"/>`); }
        for (const m of markers) {
          const mi = medianIdx(m, g.rows);
          if (mi) { const [x, y] = P[mi.j]; out.push(`<path d="M${f(x)} ${f(y - 4.5)}l4.5 4.5l-4.5 4.5l-4.5 -4.5z" fill="${paint(m.c)}" stroke="${bg}" stroke-width="1"/>`); }
        }
      });
      out.push('</g>');
      if (screen.length) {
        const lab = (t, j) => { const [x, y] = screen[0][j]; return `<text x="${f(x + 7)}" y="${f(y - 6)}" font-size="10" fill="${ink}" stroke="${bg}" stroke-width="3" paint-order="stroke" stroke-linejoin="round">${t === 0 ? 't = 0' : `${C.fmtNum(t)} s`}</text>`; };
        for (const r of refTimes) out.push(lab(r, idxOf(r)));
      }
      const unitWord = D.probeShown && D.probeShown.unit === 'event' ? 'events' : 'trials';
      out.push(`<text x="${f(traj.x + 10)}" y="${f(traj.y + 17)}" font-size="10.5" fill="${muted}" stroke="${bg}" stroke-width="3" paint-order="stroke" stroke-linejoin="round">${three ? 'drag to rotate · ' : ''}○ start${zeroIdx >= 0 ? ' · ● t = 0' : ''}${refTimes.map(r => ` · ${SHAPE_GLYPH[shapeFor(r, refTimes)]} ${C.fmtNum(r)} s`).join('')}${markers.length ? ' · ◆ marker median' : ''}</text>`);
      if (cloud.length) out.push(`<text x="${f(traj.x + 10)}" y="${f(traj.y + 31)}" font-size="10.5" fill="${muted}" stroke="${bg}" stroke-width="3" paint-order="stroke" stroke-linejoin="round">small shapes: single ${unitWord}, centred on the large ones${layout.cloudOutside ? ` · ${layout.cloudOutside} beyond the frame` : ''}</text>`);
      else if (S.cloud && D.probePending) out.push(`<text x="${f(traj.x + 10)}" y="${f(traj.y + 31)}" font-size="10.5" fill="${muted}">loading single ${S.weight === 'trial' ? 'trials' : 'events'}…</text>`);
      layout.traj = {box: traj, screen, project, three, cloud: cloudScreen};
      if (!opts.export) out.push(`<rect class="hit" data-kind="traj" x="${f(traj.x)}" y="${f(traj.y)}" width="${f(traj.w)}" height="${f(traj.h)}" fill="transparent"${three ? ' style="touch-action:none;cursor:grab"' : ''}/>`);
    }

    // ---- component time courses
    {
      const ml = 46, x0 = tc.x + ml, x1 = tc.x + tc.w - (tcScroll ? 16 : 8), pw = x1 - x0, py = tc.y + tcHead;
      const X = t => x0 + (t - pre) / (post - pre) * pw;
      const panels = [], po = tcScroll ? [] : out;
      for (let k = 0; k < K; k++) {
        const y0 = py + k * tcPanel, y1 = y0 + tcPanel - 10;
        let lo = Infinity, hi = -Infinity;
        for (const {fg} of vis) for (const p of fg.coords) { lo = Math.min(lo, p[k]); hi = Math.max(hi, p[k]); }
        if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
        const padY = (hi - lo) * 0.1 || 1; lo -= padY; hi += padY;
        const Y = v => y1 - (v - lo) / (hi - lo) * (y1 - y0);
        panels.push({k, y0, y1, Y});
        po.push(`<rect x="${f(X(Math.max(pre, M.cw[0])))}" y="${f(y0)}" width="${f(X(Math.min(post, M.cw[1])) - X(Math.max(pre, M.cw[0])))}" height="${f(y1 - y0)}" fill="${windowC}" opacity="${isDark() ? 0.5 : 0.55}"/>`);
        if (lo < 0 && hi > 0) po.push(`<line x1="${f(x0)}" x2="${f(x1)}" y1="${f(Y(0))}" y2="${f(Y(0))}" stroke="${gridC}" stroke-width="1.2"/>`);
        if (pre < 0 && post > 0) po.push(`<line x1="${f(X(0))}" x2="${f(X(0))}" y1="${f(y0)}" y2="${f(y1)}" stroke="${ink}" stroke-dasharray="2 3" opacity="0.6"/>`);
        for (const r of S.refs) if (r > pre && r < post) po.push(`<line x1="${f(X(r))}" x2="${f(X(r))}" y1="${f(y0)}" y2="${f(y1)}" stroke="${muted}" stroke-dasharray="5 3"/>`);
        if (S.medians) for (const m of markers) {
          const mi = medianIdx(m, vis.flatMap(({g}) => g.rows));
          if (mi) po.push(`<line x1="${f(X(mi.t))}" x2="${f(X(mi.t))}" y1="${f(y0)}" y2="${f(y1)}" stroke="${paint(m.c)}" stroke-width="1.1" stroke-dasharray="4 3"/>`);
        }
        for (const {g, fg} of vis) po.push(`<path d="${fg.coords.map((p, j) => `${j ? 'L' : 'M'}${f(X(times[j]))} ${f(Y(p[k]))}`).join('')}" fill="none" stroke="${g.color}" stroke-width="1.8" stroke-linejoin="round"${g.dash ? ` stroke-dasharray="${g.dash}"` : ''}/>`);
        po.push(`<line x1="${f(x0)}" x2="${f(x0)}" y1="${f(y0)}" y2="${f(y1)}" stroke="${axisC}"/>`);
        po.push(`<text x="${f(x0 + 6)}" y="${f(y0 + 12)}" font-size="11" font-weight="600" fill="${ink}" stroke="${bg}" stroke-width="3" paint-order="stroke" stroke-linejoin="round">${compName(k)} <tspan font-weight="400" fill="${muted}">${pct(k)}</tspan></text>`);
        for (const v of niceTicks(lo, hi, 2)) po.push(`<text x="${f(x0 - 5)}" y="${f(Y(v) + 3.5)}" text-anchor="end" font-size="9.5" fill="${muted}">${C.fmtNum(v)}</text>`);
        if (!opts.export) po.push(`<rect class="hit" data-kind="tc" data-k="${k}" x="${f(x0)}" y="${f(y0)}" width="${f(pw)}" height="${f(tcPanel)}" fill="transparent"/>`);
      }
      const yb = py + tcShown * tcPanel - 10;
      if (tcScroll) {
        // The box ends on the axis line, so scrolled to the end it shows the last panels exactly.
        const vw = tc.w - 10, fullH = K * tcPanel - 10;
        out.push(`<text id="tcRange" x="${f(x0)}" y="${f(tc.y + 11)}" font-size="10.5" fill="${muted}">${compName(0)}–${compName(tcShown - 1)} of ${K} · scroll for more</text>`);
        tcOverlay = `<div class="tc-scroll" style="left:${f(tc.x)}px;top:${f(py)}px;width:${f(tc.w)}px;height:${f(yb - py)}px">` +
          `<svg xmlns="http://www.w3.org/2000/svg" width="${f(vw)}" height="${f(fullH)}" viewBox="${f(tc.x)} ${f(py)} ${f(vw)} ${f(fullH)}" font-family="${font}">` +
          `${po.join('')}<g id="tcCursor" pointer-events="none"></g><g id="tcHover" pointer-events="none"></g></svg></div>`;
      }
      out.push(`<line x1="${f(x0)}" x2="${f(x1)}" y1="${f(yb)}" y2="${f(yb)}" stroke="${axisC}"/>`);
      for (const v of niceTicks(pre, post, Math.max(3, Math.round(pw / 80)))) out.push(`<text x="${f(X(v))}" y="${f(yb + 14)}" text-anchor="middle" font-size="10" fill="${muted}">${C.fmtNum(v)}</text>`);
      out.push(`<text x="${f((x0 + x1) / 2)}" y="${f(yb + 29)}" text-anchor="middle" font-size="11.5" fill="${ink}">time from ${esc(eventLabel(S.align))} (s)</text>`);
      layout.tc = {box: tc, x0, x1, X, panels, scroll: tcScroll, shown: tcShown, panelH: tcPanel};
    }
    if (!narrow && !opts.export) {
      const sx = traj.x + traj.w + gap / 2, sy = top + Math.min(trajS, tcH) / 2;
      out.push(`<rect class="hit split" data-kind="split" x="${f(traj.x + traj.w)}" y="${f(top)}" width="${gap}" height="${f(row1)}" fill="transparent"/>`,
        `<rect class="grip" x="${f(sx - 1.5)}" y="${f(sy - 20)}" width="3" height="40" rx="1.5" fill="${axisC}" pointer-events="none"/>`);
    }

    // ---- heatmap + loadings
    const hg = heatGroupIndex(M, fit);
    if (hg) {
      const order = neuronOrder(fit, hg.gi);
      const ml = 50, x0 = heat.x + ml, x1 = heat.x + heat.w, pw = x1 - x0, rowH = heat.h / Math.max(1, U);
      const X = t => x0 + (t - pre) / (post - pre) * pw;
      const sortName = {loading: `${compName(loadingComp(fit))} loading`, peak: 'peak time', rate: 'mean rate', id: 'unit ID', channel: 'peak channel', area: 'area'}[String(S.nsort).split(':')[0]] || 'unit ID';
      out.push(`<text x="${f(heat.x)}" y="${f(heat.y - 8)}" font-size="12" font-weight="600" fill="${ink}">neurons × time · <tspan fill="${hg.g.color}">${esc(hg.g.label)}</tspan><tspan font-weight="400" fill="${muted}"> · ${S.heatNorm === 'z' ? 'z-scored per neuron across all groups' : 'rate / neuron peak'} · sorted by ${sortName}</tspan></text>`);
      out.push(`<image href="${heatImage(fit, hg.gi, order)}" x="${f(x0)}" y="${f(heat.y)}" width="${f(pw)}" height="${f(heat.h)}" preserveAspectRatio="none" style="image-rendering:pixelated"/>`);
      let runStart = 0;
      for (let r = 1; r <= U; r++) {
        const area = r < U ? (D.unitMap.get(fit.active_unit_ids[order[r]]) || {}).area : null;
        const prev = (D.unitMap.get(fit.active_unit_ids[order[runStart]]) || {}).area;
        if (r === U || area !== prev) {
          out.push(`<rect x="${f(x0 - 8)}" y="${f(heat.y + runStart * rowH)}" width="5" height="${f(Math.max(0.6, (r - runStart) * rowH))}" fill="${areaColor(prev)}"/>`);
          runStart = r;
        }
      }
      if (pre < 0 && post > 0) out.push(`<line x1="${f(X(0))}" x2="${f(X(0))}" y1="${f(heat.y)}" y2="${f(heat.y + heat.h)}" stroke="${ink}" stroke-dasharray="2 3" opacity="0.7"/>`);
      for (const t of M.cw) if (t > pre && t < post) out.push(`<line x1="${f(X(t))}" x2="${f(X(t))}" y1="${f(heat.y)}" y2="${f(heat.y + heat.h)}" stroke="${ink}" stroke-width="0.8" opacity="0.45"/>`);
      const yb = heat.y + heat.h;
      for (const v of niceTicks(pre, post, Math.max(3, Math.round(pw / 80)))) out.push(`<line x1="${f(X(v))}" x2="${f(X(v))}" y1="${f(yb)}" y2="${f(yb + 4)}" stroke="${axisC}"/><text x="${f(X(v))}" y="${f(yb + 16)}" text-anchor="middle" font-size="10" fill="${muted}">${C.fmtNum(v)}</text>`);
      out.push(`<text x="${f((x0 + x1) / 2)}" y="${f(yb + 31)}" text-anchor="middle" font-size="11.5" fill="${ink}">time from ${esc(eventLabel(S.align))} (s)</text>`);
      out.push(`<text transform="translate(${f(heat.x + 14)},${f(heat.y + heat.h / 2)}) rotate(-90)" text-anchor="middle" font-size="11" fill="${muted}">${U} neurons</text>`);
      // colour bar and area key
      const cbW = Math.min(120, pw * 0.3), cbX = x1 - cbW, cbY = yb + 22;
      const stops = [0, 0.25, 0.5, 0.75, 1].map(s => { const v = S.heatNorm === 'z' ? -2.5 + 5 * s : s; const [R, G, B] = C.heatColor(v, S.heatNorm, isDark()); return `<stop offset="${s}" stop-color="rgb(${R},${G},${B})"/>`; }).join('');
      out.push(`<defs><linearGradient id="heatbar">${stops}</linearGradient></defs><rect x="${f(cbX)}" y="${f(cbY)}" width="${f(cbW)}" height="7" rx="2" fill="url(#heatbar)"/>`,
        `<text x="${f(cbX - 4)}" y="${f(cbY + 7)}" text-anchor="end" font-size="9.5" fill="${muted}">${S.heatNorm === 'z' ? '−2.5 z' : '0'}</text><text x="${f(x1)}" y="${f(cbY + 18)}" text-anchor="end" font-size="9.5" fill="${muted}">${S.heatNorm === 'z' ? '+2.5 z' : 'peak'}</text>`);
      const areas = [...new Set(fit.active_unit_ids.map(id => (D.unitMap.get(id) || {}).area))];
      let ax = x0;
      for (const a of areas) { out.push(`<rect x="${f(ax)}" y="${f(cbY)}" width="8" height="8" rx="2" fill="${areaColor(a)}"/><text x="${f(ax + 11)}" y="${f(cbY + 7.5)}" font-size="10" fill="${muted}">${esc(a || '?')}</text>`); ax += 22 + String(a || '?').length * 6; }
      // loadings aligned to heatmap rows
      const k = loadingComp(fit);
      const lmax = Math.max(1e-9, ...fit.loadings.map(l => Math.abs(l[k])));
      const mid = load.x + load.w / 2, half = load.w / 2 - 4;
      out.push(`<text x="${f(mid)}" y="${f(load.y - 8)}" text-anchor="middle" font-size="11" font-weight="600" fill="${ink}">${compName(k)} loading</text>`);
      let pos = '', neg = '';
      order.forEach((u, r) => {
        const l = fit.loadings[u][k] / lmax * half, y = load.y + r * rowH;
        const d = `M${f(mid)} ${f(y)}h${f(l)}v${f(Math.max(0.6, rowH * 0.86))}h${f(-l)}z`;
        if (l >= 0) pos += d; else neg += d;
      });
      out.push(`<path d="${pos}" fill="${paint('#e03131')}" opacity="0.8"/><path d="${neg}" fill="${paint('#1c7ed6')}" opacity="0.8"/>`,
        `<line x1="${f(mid)}" x2="${f(mid)}" y1="${f(load.y)}" y2="${f(load.y + load.h)}" stroke="${axisC}"/>`);
      layout.heat = {box: heat, x0, x1, X, rowH, order, gi: hg.gi, group: hg.g};
      layout.load = {box: load, rowH, order, k};
      if (!opts.export) out.push(`<rect class="hit" data-kind="heat" x="${f(x0)}" y="${f(heat.y)}" width="${f(pw)}" height="${f(heat.h)}" fill="transparent"/>`,
        `<rect class="hit" data-kind="load" x="${f(load.x)}" y="${f(load.y)}" width="${f(load.w)}" height="${f(load.h)}" fill="transparent"/>`);
    }

    // ---- variance explained and diagnostics
    {
      const ml = 34, x0 = vbox.x + ml, x1 = vbox.x + vbox.w, yb = vbox.y + vbox.h - 20, h = vbox.h - 44;
      const r2 = fit.component_r2, maxv = Math.max(0.05, ...r2) * 1.15, step = (x1 - x0) / K, bw = Math.min(34, step * 0.62);
      // Past about ten components, label every nth bar and drop the per-bar percentages.
      const every = Math.max(1, Math.ceil(30 / step)), valueLabels = step >= 22;
      const nameAt = k => (k % every === 0 ? `<text x="${f(x0 + (k + 0.5) * step)}" y="${f(yb + 13)}" text-anchor="middle" font-size="10" fill="${muted}">${compName(k)}</text>` : '');
      out.push(`<text x="${f(vbox.x)}" y="${f(vbox.y + 10)}" font-size="12" font-weight="600" fill="${ink}">${S.method === 'pca' ? 'variance explained' : 'variance explained by each component alone'}</text>`);
      r2.forEach((v, k) => {
        const cx = x0 + (k + 0.5) * step, y = yb - v / maxv * h;
        out.push(`<rect x="${f(cx - bw / 2)}" y="${f(y)}" width="${f(bw)}" height="${f(yb - y)}" rx="2" fill="${paint('#3b5bdb')}" opacity="${(0.9 - 0.45 * k / Math.max(9, K - 1)).toFixed(3)}"/>`,
          valueLabels ? `<text x="${f(cx)}" y="${f(y - 3)}" text-anchor="middle" font-size="9.5" fill="${muted}">${C.fmtNum(100 * v, 0)}%</text>` : '', nameAt(k));
      });
      out.push(`<line x1="${f(x0)}" x2="${f(x1)}" y1="${f(yb)}" y2="${f(yb)}" stroke="${axisC}"/>`);
      // Cumulative: components 1..k together, in the order shown (server-computed from
      // the partial reconstruction, so it is right for FA too).
      const cum = fit.cumulative_r2 || [];
      if (cum.length === K) {
        const cx0 = cbox.x + ml, cx1 = cbox.x + cbox.w, cyb = cbox.y + cbox.h - 20, ch = cbox.h - 44, cstep = (cx1 - cx0) / K;
        const cevery = Math.max(1, Math.ceil(30 / cstep));
        const CX = k => cx0 + (k + 0.5) * cstep, CY = v => cyb - clamp(v, 0, 1) * ch;
        out.push(`<text x="${f(cbox.x)}" y="${f(cbox.y + 10)}" font-size="12" font-weight="600" fill="${ink}">cumulative variance explained</text>`);
        for (const v of [0, 0.5, 1]) out.push(`<line x1="${f(cx0)}" x2="${f(cx1)}" y1="${f(CY(v))}" y2="${f(CY(v))}" stroke="${v ? gridC : axisC}"/>`,
          `<text x="${f(cx0 - 4)}" y="${f(CY(v) + 3.5)}" text-anchor="end" font-size="9.5" fill="${muted}">${v * 100}%</text>`);
        out.push(`<path d="${cum.map((v, k) => `${k ? 'L' : 'M'}${f(CX(k))} ${f(CY(v))}`).join('')}" fill="none" stroke="${paint('#3b5bdb')}" stroke-width="1.8" stroke-linejoin="round"/>`);
        cum.forEach((v, k) => {
          out.push(`<circle cx="${f(CX(k))}" cy="${f(CY(v))}" r="${cstep >= 10 ? 2.8 : 1.8}" fill="${paint('#3b5bdb')}"/>`);
          if (k % cevery === 0) out.push(`<text x="${f(CX(k))}" y="${f(cyb + 13)}" text-anchor="middle" font-size="10" fill="${muted}">${compName(k)}</text>`);
          if (cstep >= 30 || k === K - 1) out.push(`<text x="${f(CX(k))}" y="${f(CY(v) - 5)}" text-anchor="${k === K - 1 && cstep < 30 ? 'end' : 'middle'}" font-size="9.5" fill="${muted}" stroke="${bg}" stroke-width="3" paint-order="stroke" stroke-linejoin="round">${C.fmtNum(100 * v, 0)}%</text>`);
        });
      }
      const dropped = fit.dropped_constant_units.length;
      const lines = [
        `${fit.fit_rows} fit rows = ${fit.groups.length} group${fit.groups.length === 1 ? '' : 's'} × ${n} bins · ${fit.active_unit_ids.length} neurons${dropped ? ` (${dropped} constant, left out)` : ''}`,
        `all ${K} components together explain ${C.fmtNum(100 * fit.reconstruction_r2, 1)}% · rank ${fit.rank}${fit.converged ? '' : ' · did not converge'}`,
        `means: ${fit.weighting}`,
        'descriptive in-sample fit; no held-out prediction or significance test',
      ];
      if (fit.warnings && fit.warnings.length) lines.push(`warning: ${String(fit.warnings[0]).slice(0, 110)}`);
      lines.forEach((t, i) => out.push(`<text x="${f(dbox.x)}" y="${f(dbox.y + 12 + i * 16)}" font-size="11" fill="${i === 4 ? paint('#e8590c') : i < 2 ? ink : muted}">${esc(t)}</text>`));
    }
    const meta = opts.export ? `<metadata>${esc(JSON.stringify(popProvenance(M, fit)))}</metadata>` : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${font}">${meta}` +
      (opts.export ? `<rect x="-20" y="-20" width="${width + 40}" height="${height + 40}" fill="${bg}"/>` : '') + out.join('') +
      (opts.export ? '' : '<g id="cursorLayer" pointer-events="none"></g><g id="hoverLayer" pointer-events="none"></g>') + '</svg>' + tcOverlay;
    return {svg, layout};
  }

  function drawCursor() {
    const L = D.popLayout, layer = document.getElementById('cursorLayer'), tcLayer = document.getElementById('tcCursor');
    if (!L || !layer) return;
    const j = D.cursor;
    if (j === null || j === undefined || j >= L.n) { layer.innerHTML = ''; if (tcLayer) tcLayer.innerHTML = ''; $('cursorOut').textContent = 't —'; return; }
    const bg = figVar('--fig-bg'), t = L.times[j];
    let html = '';
    L.vis.forEach(({g}, vi) => { const p = L.traj.screen[vi][j]; html += `<circle cx="${f1(p[0])}" cy="${f1(p[1])}" r="5.2" fill="${g.color}" stroke="${bg}" stroke-width="2"/>`; });
    const x = L.tc.X(t);
    const tcLine = `<line x1="${f1(x)}" x2="${f1(x)}" y1="${f1(L.tc.panels[0].y0)}" y2="${f1(L.tc.panels[L.tc.panels.length - 1].y1)}" stroke="${figVar('--accent')}" stroke-width="1.4"/>`;
    if (L.tc.scroll && tcLayer) tcLayer.innerHTML = tcLine; else html += tcLine;
    if (L.heat) html += `<line x1="${f1(L.heat.X(t))}" x2="${f1(L.heat.X(t))}" y1="${f1(L.heat.box.y)}" y2="${f1(L.heat.box.y + L.heat.box.h)}" stroke="${figVar('--accent')}" stroke-width="1.4"/>`;
    layer.innerHTML = html;
    $('cursorOut').textContent = `t ${t >= 0 ? '+' : ''}${C.fmtNum(t, 2)} s`;
  }
  function stopPlay() { clearInterval(D.playTimer); D.playTimer = 0; const b = $('playBtn'); if (b) b.textContent = '▶'; }
  function togglePlay() {
    if (D.playTimer) { stopPlay(); return; }
    const L = D.popLayout; if (!L) return;
    if (D.cursor === null || D.cursor >= L.n - 1) D.cursor = 0;
    $('playBtn').textContent = '❚❚';
    D.playTimer = setInterval(() => {
      const L2 = D.popLayout; if (!L2) { stopPlay(); return; }
      D.cursor = D.cursor + 1;
      if (D.cursor >= L2.n) { D.cursor = L2.n - 1; stopPlay(); }
      $('cursor').value = D.cursor; drawCursor();
    }, 55);
  }

  function syncPopToolbar(fit, M) {
    const K = fit.components;
    let [a, b, c] = S.axes.map(x => clamp(Number(x) || 0, 0, K - 1));
    if (b === a) b = (a + 1) % K;
    if (c === a || c === b) c = [0, 1, 2, 3].find(x => x < K && x !== a && x !== b) ?? 0;
    S.axes = [a, b, c];
    const opt = sel => [...Array(K).keys()].map(k => `<option value="${k}"${k === sel ? ' selected' : ''}>${compName(k)} · ${C.fmtNum(100 * fit.component_r2[k], 0)}%</option>`).join('');
    $('axX').innerHTML = opt(a); $('axY').innerHTML = opt(b); $('axZ').innerHTML = opt(c);
    $('axZWrap').hidden = !(S.dims === '3' && K >= 3);
    const n = fit.times.length;
    $('cursor').max = n - 1;
    if (D.cursor !== null && D.cursor >= n) D.cursor = n - 1;
    if (D.cursor !== null) $('cursor').value = D.cursor;
    const vis = M.visible.filter(g => fit.groupIndex.has(g.key));
    const hg = heatGroupIndex(M, fit);
    $('heatGroup').innerHTML = vis.map(g => `<option value="${esc(g.key)}"${hg && hg.g.key === g.key ? ' selected' : ''}>${esc(g.label)}</option>`).join('');
  }

  function popEmpty(title, lines, buttons) {
    $('figure').innerHTML = ''; $('figure').classList.remove('stale');
    D.popLayout = null;
    $('empty').innerHTML = `<h3>${esc(title)}</h3>${lines.map(l => `<p>${l}</p>`).join('')}<div class="chips" style="justify-content:center;margin-top:12px">${buttons}</div>`;
    $('empty').hidden = false;
  }
  function renderPopulation() {
    const fig = $('figure');
    $('bars').innerHTML = '';
    document.querySelector('.figure-wrap').classList.add('stacked');
    renderRosterSection();
    const M = buildPopModel();
    if (!M) { if (fig.querySelector('svg')) fig.classList.add('stale'); else showLoading('Loading…', ''); return; }
    const presetButtons = rosterPresetList().slice(0, 5).map((p, i) => `<button type="button" class="${i ? 'small' : 'primary'}" data-act="rp:${esc(p.id)}">${esc(p.label)}${p.ids ? ` · ${p.ids.length}` : ''}</button>`).join('') +
      '<button type="button" class="small" data-act="choose">Choose neurons…</button>';
    if (M.needRoster) {
      $('title').textContent = 'Population'; $('subtitle').textContent = eventLabel(S.align); $('support').innerHTML = ''; $('legend').innerHTML = '';
      renderQuickFilters({T: M.T, raster: {n: M.T.n, span: new Array(M.T.n).fill([-1e9, 1e9]), status: []}, pre: S.win[0], post: S.win[1]});
      popEmpty('Choose neurons for the population', ['The population view fits one PCA / ICA / factor-analysis basis to the condition means of many neurons, using the same alignment, filters, groups and window as the raster view.',
        '<b>Shared-stable SUA + MUA</b> picks the most neurons that share many stable trials — the usual starting point.'], presetButtons);
      return;
    }
    D.popModel = M;
    const areas = [...new Set(S.roster.map(id => (D.unitMap.get(id) || {}).area).filter(Boolean))];
    $('title').textContent = `Population · ${S.roster.length} neurons${areas.length ? ` · ${areas.join(' + ')}` : ''}`;
    $('subtitle').textContent = `${eventLabel(S.align)} · ${S.policy === 'verified_stable' ? 'trials stable for every neuron' : 'all complete trials'} · bin ${Math.round(S.bin * 1000)} ms · σ ${Math.round(S.sigma * 1000)} ms · ${S.method.toUpperCase()} (${S.scaling === 'zscore' ? 'z-scored' : 'centred'}) · ${S.method === 'tdr' ? `axes: ${S.tdrFactors.map(tdrLabel).join(', ')} · window ${tdrWindow().map(v => C.fmtNum(v)).join(' to ')} s` : `${S.ncomp} components`} · ${S.weight === 'trial' ? 'trial' : 'event'}-weighted means`;
    const shown = M.visible.reduce((acc, g) => acc + g.rows.length, 0);
    const trials = new Set(); M.visible.forEach(g => g.rows.forEach(i => trials.add(M.T.trial[i])));
    const detail = [];
    if (M.filtered) detail.push(`${M.filtered} filtered out`);
    if (M.excl[1] + M.excl[2]) detail.push(`${M.excl[1] + M.excl[2]} outside the ${M.common} ${S.policy === 'verified_stable' ? 'shared stable' : 'complete'} trials`);
    if (M.excl[3]) detail.push(`${M.excl[3]} whose window leaves the shared run`);
    $('support').innerHTML = `<b>${shown}</b> events · <b>${trials.size}</b> trials · <b>${S.roster.length}</b> neurons` + (detail.length ? `<br>${esc(detail.join(' · '))}` : '');
    renderLegend(M);
    renderQuickFilters(M);
    if (S.roster.length < 2) { popEmpty('Add at least one more neuron', ['A population fit needs two or more neurons.'], presetButtons); return; }
    if (!M.rows.length) {
      const lines = [];
      if (M.excl[1] + M.excl[2]) lines.push(`${esc(String(M.excl[1] + M.excl[2]))} events fall outside the <b>${M.common}</b> trials that ${S.policy === 'verified_stable' ? 'are stable for all' : 'are complete for'} these ${S.roster.length} neurons.`);
      if (M.excl[3]) lines.push(`${M.excl[3]} events have a window (plus the 0.4 s guard) that leaves the shared run — try a shorter window.`);
      if (M.filtered === M.T.n) lines.push('The filters exclude every event.');
      popEmpty('No events to fit', lines, (S.policy === 'verified_stable' ? '<button type="button" class="primary" data-act="all-complete">Use all complete trials</button><button type="button" class="small" data-act="rp:stable">Shared-stable SUA + MUA</button>' : '') +
        (S.filters.length ? '<button type="button" class="small" data-act="clear-filters">Clear filters</button>' : ''));
      return;
    }
    if (S.method === 'tdr' && S.tdrFactors.length < 2) { popEmpty('Choose TDR factors', ['Targeted dimensionality reduction needs at least two factors (one axis each); pick them in Model & display.'], ''); return; }
    if (nComp() > S.roster.length) { popEmpty('Too many components', [`${nComp()} components need at least ${nComp()} neurons; this roster has ${S.roster.length}.`], ''); return; }
    const req = fitRequest(M), key = C.hash(JSON.stringify(req));
    const fit = D.fits.get(key);
    if (!fit) {
      const err = D.fitErrors.get(key);
      if (err) { popEmpty('The fit did not run', [esc(err)], '<button type="button" class="small" data-act="refit">Try again</button>'); return; }
      requestFit(req, key);
      if (fig.querySelector('svg') && D.popLayout) fig.classList.add('stale');
      else showLoading(`Fitting ${S.method.toUpperCase()} to ${S.roster.length} neurons…`, `${M.grouping.groups.length} groups · ${M.rows.length} events`);
      return;
    }
    fig.classList.remove('stale');
    $('empty').hidden = true;
    D.popFit = fit; D.popKey = key; D.popReq = req;
    D.probeShown = null;
    if (S.cloud) {
      const probeTimes = cloudTimes(fit);
      if (probeTimes.length) {
        const pkey = `${key}|${probeTimes.join(',')}`;
        if (D.probes.has(pkey)) D.probeShown = D.probes.get(pkey);
        else requestProbe({...req, probe_times: probeTimes}, pkey);
      }
    }
    syncPopToolbar(fit, M);
    const width = Math.max(300, Math.floor(document.querySelector('.figure-wrap').clientWidth || ($('stage').clientWidth - 36)));
    const {svg, layout} = popFigureSVG(M, fit, width);
    mountPopFigure(fig, svg, layout);
    D.figMeta = {title: $('title').textContent, subtitle: $('subtitle').textContent, width};
    drawCursor();
    $('foot').innerHTML = `Source <code>${esc(D.summary.source.path || '')}</code> · SHA256 <code>${esc(String(D.summary.source.sha256 || '').slice(0, 12))}…</code> · condition means per group, ${S.method === 'tdr' ? `one axis per factor: regression of single-event rates on the factors (categories and booleans effect-coded, numbers z-scored), read at each factor's peak time, denoised in the leading PC subspace and orthogonalised by QR` : `one joint ${S.method.toUpperCase()} basis (sklearn) · component signs set so each component's largest loading is positive`} · electro_gui ${VERSION}`;
  }
  function rerenderPopFigure() {
    const M = D.popModel, fit = D.popFit;
    if (!M || !fit || S.mode !== 'population') return;
    const width = D.figMeta ? D.figMeta.width : 800;
    const {svg, layout} = popFigureSVG(M, fit, width);
    mountPopFigure($('figure'), svg, layout); drawCursor();
  }
  // Redraws keep the time-course box where it was scrolled to.
  function mountPopFigure(fig, svg, layout) {
    fig.innerHTML = svg; D.popLayout = layout;
    const box = fig.querySelector('.tc-scroll');
    if (box) { box.scrollTop = D.tcScroll || 0; tcRangeLabel(box); }
  }
  function tcRangeLabel(box) {
    const L = D.popLayout, el = document.getElementById('tcRange');
    if (!L || !el || !L.tc.scroll) return;
    const K = L.tc.panels.length, a = clamp(Math.round(box.scrollTop / L.tc.panelH), 0, K - L.tc.shown);
    el.textContent = `${compName(a)}–${compName(a + L.tc.shown - 1)} of ${K} · scroll for more`;
  }

  // hover and 3D rotation in the population figure
  function popPoint(evt) {
    const svg = $('figure').querySelector('svg'), r = svg.getBoundingClientRect(), L = D.popLayout;
    return {x: (evt.clientX - r.left) * (L.width / r.width), y: (evt.clientY - r.top) * (L.height / r.height)};
  }
  function popHover(kind, hit, p, evt) {
    const L = D.popLayout, fit = D.popFit, hl = document.getElementById('hoverLayer'), tcl = document.getElementById('tcHover');
    if (!L || !fit || !hl) return;
    if (tcl) tcl.innerHTML = '';
    const names = fit.method;
    if (kind === 'traj') {
      let near = null;
      for (const pt of L.traj.cloud || []) { const d = (pt.x - p.x) ** 2 + (pt.y - p.y) ** 2; if (d < 42 && (!near || d < near.d)) near = {...pt, d}; }
      if (near) {
        hl.innerHTML = `<circle cx="${f1(near.x)}" cy="${f1(near.y)}" r="5" fill="none" stroke="${near.g.color}" stroke-width="2"/>`;
        const unit = D.probeShown && D.probeShown.unit === 'event' ? 'event row' : 'trial';
        tooltip(`<div class="tr" style="--c:${near.g.color}"><i></i><span><b>${esc(near.g.label)}</b></span></div><div class="kv"><span>${unit}</span><b>${near.id}</b><span>at</span><b>${near.t === 0 ? 't = 0' : `${C.fmtNum(near.t)} s`} (bin ${C.fmtNum(near.centre, 3)} s)</b>${S.axes.slice(0, S.dims === '3' ? 3 : 2).map(k => `<span>${compName(k, names)}</span><b>${C.fmtNum(near.c[k], 2)}</b>`).join('')}</div>`, evt.clientX, evt.clientY);
        return;
      }
      let best = null;
      L.vis.forEach(({g, fg}, vi) => L.traj.screen[vi].forEach((q, j) => { const d = (q[0] - p.x) ** 2 + (q[1] - p.y) ** 2; if (!best || d < best.d) best = {d, g, fg, j, q}; }));
      if (!best || best.d > 900) { hl.innerHTML = ''; $('tooltip').hidden = true; return; }
      hl.innerHTML = `<circle cx="${f1(best.q[0])}" cy="${f1(best.q[1])}" r="6" fill="none" stroke="${best.g.color}" stroke-width="2"/>`;
      const c = best.fg.coords[best.j];
      tooltip(`<div class="tr" style="--c:${best.g.color}"><i></i><span><b>${esc(best.g.label)}</b></span></div><div class="kv"><span>time</span><b>${C.fmtNum(fit.times[best.j], 3)} s</b>${S.axes.slice(0, S.dims === '3' ? 3 : 2).map(k => `<span>${compName(k, names)}</span><b>${C.fmtNum(c[k], 2)}</b>`).join('')}</div>`, evt.clientX, evt.clientY);
    } else if (kind === 'tc') {
      const k = Number(hit.dataset.k), t = D.popLayout.pre + (p.x - L.tc.x0) / (L.tc.x1 - L.tc.x0) * (L.post - L.pre);
      const j = clamp(Math.floor((t - L.pre) / fit.bin), 0, L.n - 1), x = L.tc.X(fit.times[j]);
      const last = L.tc.panels[L.tc.panels.length - 1];
      const line = `<line x1="${f1(x)}" x2="${f1(x)}" y1="${f1(L.tc.panels[0].y0)}" y2="${f1(last.y1)}" stroke="${figVar('--fig-muted')}"/>`;
      if (L.tc.scroll && tcl) { tcl.innerHTML = line; hl.innerHTML = ''; } else hl.innerHTML = line;
      tooltip(`<b>${compName(k, names)} · t = ${C.fmtNum(fit.times[j], 3)} s</b>${L.vis.map(({g, fg}) => `<div class="tr" style="--c:${g.color}"><i></i><span>${esc(g.label)}</span><em>${C.fmtNum(fg.coords[j][k], 2)}</em></div>`).join('')}`, evt.clientX, evt.clientY);
    } else if (kind === 'heat' || kind === 'load') {
      const box = kind === 'heat' ? L.heat : L.load, rowH = box.rowH;
      const r = clamp(Math.floor((p.y - box.box.y) / rowH), 0, box.order.length - 1), u = box.order[r];
      const id = fit.active_unit_ids[u], unit = D.unitMap.get(id) || {id};
      const kv = [['area · quality', `${unit.area || '?'} · ${String(unit.quality || '').toUpperCase()}`]];
      if (kind === 'heat') {
        const t = L.pre + (p.x - L.heat.x0) / (L.heat.x1 - L.heat.x0) * (L.post - L.pre);
        const j = clamp(Math.floor((t - L.pre) / fit.bin), 0, L.n - 1), v = fit.groups[L.heat.gi].means[j][u];
        kv.push(['time', `${C.fmtNum(fit.times[j], 3)} s`], ['rate', `${C.fmtNum(v, 1)} spikes/s`], ['z (all groups)', C.fmtNum((v - fit.stats.mu[u]) / fit.stats.sd[u], 2)]);
      }
      for (let k = 0; k < fit.components; k++) kv.push([`${compName(k, names)} loading`, C.fmtNum(fit.loadings[u][k], 3)]);
      hl.innerHTML = `<rect x="${f1(L.heat ? L.heat.x0 : 0)}" y="${f1(box.box.y + r * rowH)}" width="${f1(L.width - (L.heat ? L.heat.x0 : 0))}" height="${f1(Math.max(rowH, 1.5))}" fill="${figVar('--accent')}" opacity="0.18"/>`;
      tooltip(`<b>${esc(unitShort(unit))}</b><div class="kv">${kv.map(([a, v]) => `<span>${esc(a)}</span><b>${esc(v)}</b>`).join('')}</div>`, evt.clientX, evt.clientY);
    }
  }
  let rotate = null, split = null, splitDown = 0;
  function bindPopFigure(fig) {
    fig.addEventListener('pointerdown', evt => {
      if (S.mode !== 'population' || !D.popLayout) return;
      const hit = evt.target.closest && evt.target.closest('.hit');
      if (hit && hit.dataset.kind === 'split' && D.popLayout.split) {
        // Two presses within 400 ms reset to half each.  Counted here because, once the first
        // press captures the pointer, the browser sends the dblclick to the figure, not the divider.
        const now = performance.now();
        if (now - splitDown < 400) { splitDown = 0; S.popSplit = 0.5; saveState(); rerenderPopFigure(); evt.preventDefault(); return; }
        splitDown = now;
        const r = fig.querySelector('svg').getBoundingClientRect();
        split = {x: evt.clientX, w0: D.popLayout.split.w, avail: D.popLayout.split.avail, k: D.popLayout.width / r.width};
        fig.setPointerCapture(evt.pointerId); fig.style.cursor = 'col-resize'; hideTip(); evt.preventDefault();
      } else if (hit && hit.dataset.kind === 'traj' && D.popLayout.traj.three) {
        rotate = {x: evt.clientX, y: evt.clientY, yaw: D.view3d.yaw, pitch: D.view3d.pitch};
        fig.setPointerCapture(evt.pointerId); hideTip(); evt.preventDefault();
      } else if (hit && evt.pointerType !== 'mouse') {
        popHover(hit.dataset.kind, hit, popPoint(evt), evt);
        clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, 3500);
      }
    });
    fig.addEventListener('pointermove', evt => {
      if (S.mode !== 'population' || !D.popLayout) return;
      if (rotate) {
        D.view3d.yaw = rotate.yaw + (evt.clientX - rotate.x) * 0.01;
        D.view3d.pitch = clamp(rotate.pitch + (evt.clientY - rotate.y) * 0.01, -1.45, 1.45);
        if (!D.rotFrame) D.rotFrame = requestAnimationFrame(() => { D.rotFrame = 0; rerenderPopFigure(); });
        return;
      }
      if (split) {
        const w = clamp(split.w0 + (evt.clientX - split.x) * split.k, SPLIT_MIN, split.avail - SPLIT_MIN);
        if (Math.abs(w - D.popLayout.split.w) < 1) return;  // a still pointer must not redraw between the clicks of a double-click
        S.popSplit = w / split.avail;
        if (!D.rotFrame) D.rotFrame = requestAnimationFrame(() => { D.rotFrame = 0; rerenderPopFigure(); });
        return;
      }
      const hit = evt.target.closest && evt.target.closest('.hit');
      if (!hit || hit.dataset.kind === 'split') { if (evt.pointerType === 'mouse' || hit) hideTip(); return; }
      popHover(hit.dataset.kind, hit, popPoint(evt), evt);
    });
    const end = () => { rotate = null; if (split) { split = null; fig.style.cursor = ''; saveState(); } };
    fig.addEventListener('pointerup', end);
    fig.addEventListener('pointercancel', end);
    fig.addEventListener('scroll', evt => {  // scroll does not bubble; capture it from the time-course box
      if (!evt.target.classList || !evt.target.classList.contains('tc-scroll')) return;
      D.tcScroll = evt.target.scrollTop; tcRangeLabel(evt.target);
    }, true);
  }

  function popProvenance(M, fit) {
    return {tool: `electro_gui ${VERSION} explorer · population`, generated: new Date().toISOString(), session_id: D.summary.session_id,
      source: D.summary.source, alignment: S.align, policy: S.policy, unit_ids: S.roster.slice(),
      active_unit_ids: fit.active_unit_ids, dropped_constant_units: fit.dropped_constant_units, method: fit.method, scaling: fit.scaling,
      components: fit.components, component_r2: fit.component_r2, cumulative_r2: fit.cumulative_r2, explained_variance_ratio: fit.explained_variance_ratio,
      reconstruction_r2: fit.reconstruction_r2, rank: fit.rank, fit_rows: fit.fit_rows, converged: fit.converged, warnings: fit.warnings,
      weighting: fit.weighting, window: fit.window, bin: fit.bin, sigma: fit.sigma, common_trials: fit.common_trials,
      groups: fit.groups.map(g => ({key: g.key, label: g.label, events: g.events, trials: g.trials})), scope: fit.scope, tdr: fit.tdr || null, state: S};
  }
  function popExportSVG() {
    const width = Math.max(900, D.figMeta.width);
    return popFigureSVG(D.popModel, D.popFit, width, {export: true, title: D.figMeta.title, subtitle: `${D.summary.session_id} · ${D.figMeta.subtitle}`}).svg;
  }
  async function popExport(kind) {
    const M = D.popModel, fit = D.popFit;
    if (!M || !fit || S.mode !== 'population' || !D.popLayout) { toast('Nothing to export yet.', true); return; }
    const stem = `${D.summary.session_id}_population_${S.roster.length}neurons_${S.align}_${S.method}`;
    const names = [...Array(fit.components).keys()].map(k => compName(k, fit.method));
    if (kind === 'svg') download(`${stem}.svg`, new Blob([popExportSVG()], {type: 'image/svg+xml'}));
    else if (kind === 'png') await pngFromSVG(popExportSVG(), `${stem}.png`);
    else if (kind === 'coords') {
      const lines = [['group', 'time_s', ...names].join(',')];
      for (const g of fit.groups) g.coords.forEach((c, j) => lines.push([csv(g.label), tidy(fit.times[j], 4), ...c.map(v => tidy(v, 5))].join(',')));
      download(`${stem}_coordinates.csv`, new Blob([`# ${JSON.stringify(popProvenance(M, fit))}\n` + lines.join('\n')], {type: 'text/csv'}));
    } else if (kind === 'loadings') {
      const lines = [['unit_id', 'peak_channel', 'area', 'quality', ...names.map(n => `${n}_loading`)].join(',')];
      fit.active_unit_ids.forEach((id, u) => { const x = D.unitMap.get(id) || {}; lines.push([id, x.peak_channel ?? '', csv(x.area), csv(x.quality), ...fit.loadings[u].map(v => tidy(v, 6))].join(',')); });
      download(`${stem}_loadings.csv`, new Blob([`# ${JSON.stringify(popProvenance(M, fit))}\n` + lines.join('\n')], {type: 'text/csv'}));
    } else if (kind === 'cloud' && D.probeShown) {
      const lines = [['group', 'time_s', 'bin_centre_s', 'unit', 'id', ...names].join(',')];
      for (const pr of D.probeShown.probes) for (const pg of pr.groups) {
        const label = (fit.groups.find(g => g.key === pg.key) || {}).label || pg.key;
        pg.points.forEach((c, k) => lines.push([csv(label), tidy(pr.t, 4), tidy(pr.bin_centre, 4), D.probeShown.unit, pg.ids[k], ...c.map(v => tidy(v, 5))].join(',')));
      }
      download(`${stem}_single_trials.csv`, new Blob([`# ${JSON.stringify(popProvenance(M, fit))}\n# ${D.probeShown.note}\n` + lines.join('\n')], {type: 'text/csv'}));
    } else if (kind === 'json') download(`${stem}_settings.json`, new Blob([JSON.stringify(popProvenance(M, fit), null, 2)], {type: 'application/json'}));
  }
  function setMode(mode) {
    if (S.mode === mode) return;
    stopPlay(); hideTip();
    S.mode = mode;
    applyMode(); closeSheet();
    $('empty').hidden = true;
    $('figure').innerHTML = '';
    renderStructure();
    changed({data: true});
  }
  function applyMode() {
    document.documentElement.dataset.mode = S.mode;
    document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
  }

  // --------------------------------------------------------------- export
  function provenance(M) {
    return {tool: `electro_gui ${VERSION} explorer`, generated: new Date().toISOString(), session_id: D.summary.session_id,
      source: D.summary.source, unit: M.unit, alignment: S.align, policy: S.policy, guard_s: C.GUARD_S,
      yoked_trials: M.yoke ? {first: M.yoke.from, last: M.yoke.to, n: M.yoke.last - M.yoke.first + 1} : null,
      events_shown: M.visible.reduce((a, g) => a + g.rows.length, 0), state: S};
  }
  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function fileStem() {
    const u = D.model && D.model.unit;
    return `${D.summary.session_id}_unit${String(S.unit).padStart(4, '0')}${u && u.peak_channel !== null && u.peak_channel !== undefined ? `_ch${u.peak_channel}` : ''}_${S.align}`;
  }
  function exportSVG() {
    const M = D.model;
    const width = Math.max(720, D.figMeta.width);
    const {svg, layout} = figureSVG(M, width, {export: true, title: D.figMeta.title, subtitle: `${D.summary.session_id} · ${D.figMeta.subtitle}`});
    if (!S.bars) return svg;
    const bw = 230, bh = Math.min(360, Math.max(240, layout.height * 0.5));
    const bars = barsSVG(M, bw, bh).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    const W = width + bw + 16, H = Math.max(layout.height, bh);
    return svg.replace(/^<svg[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Math.ceil(H)}" viewBox="0 0 ${W} ${Math.ceil(H)}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif"><rect x="-20" y="-20" width="${W + 40}" height="${Math.ceil(H) + 40}" fill="${figVar('--fig-bg')}"/>`)
      .replace(/<\/svg>$/, `<g transform="translate(${width + 16},${Math.max(0, layout.panels[0].pTop - 40)})">${bars}</g></svg>`);
  }
  async function doExport(kind) {
    if (!D.model || !D.model.rows.length) { toast('Nothing to export yet.', true); return; }
    const M = D.model, stem = fileStem();
    if (kind === 'svg') download(`${stem}.svg`, new Blob([exportSVG()], {type: 'image/svg+xml'}));
    else if (kind === 'png') await pngFromSVG(exportSVG(), `${stem}.png`);
    else if (kind === 'psth') {
      const lines = [['group', 'panel', 'time_s', 'mean_hz', `${S.err === 'ci' ? 'sem' : 'sem'}_hz`, 'n_units', 'weighting', 'n_events', 'n_trials'].join(',')];
      for (const g of M.visible) M.grid.times.forEach((t, j) => lines.push([csv(g.label), csv(g.panelLabel), tidy(t, 4), tidy(g.psth.mean[j], 4), tidy(g.psth.sem[j], 4), g.psth.n, S.weight, g.psth.events, g.psth.trials].join(',')));
      download(`${stem}_psth.csv`, new Blob([`# ${JSON.stringify(provenance(M))}\n` + lines.join('\n')], {type: 'text/csv'}));
    } else if (kind === 'rows') {
      const fields = [...new Set(['task', 'microstim', 'sham', 'rewarded', 'previous_task', S.color, S.style, S.panel, ...S.filters.map(f => f.k)].filter(k => k && M.T.byKey.has(k)))];
      const markers = S.markers.filter(m => M.markerData[m.id]);
      const head = ['row_id', 'trial', 't_session_s', 'event', 'group', 'panel', 'count_window_spikes', 'count_window_rate_hz', ...markers.map(m => `marker_${m.label || m.e}_s`), ...fields];
      const lines = [head.map(csv).join(',')];
      for (const g of M.visible) for (const i of g.sorted) {
        const n = C.countIn(M.spikes[i], M.cw[0], M.cw[1]);
        lines.push([M.T.rowId[i], M.T.trial[i], tidy(M.T.t[i], 6), csv(M.T.event ? M.T.event[i] : S.align), csv(g.label), csv(g.panelLabel), n, tidy(n / (M.cw[1] - M.cw[0]), 4),
          ...markers.map(m => { const h = M.markerData[m.id][i]; return h && h[0] ? tidy(h[0].t, 5) : ''; }),
          ...fields.map(k => csv(C.rawValue(M.T.byKey.get(k), i)))].join(','));
      }
      download(`${stem}_rows.csv`, new Blob([`# ${JSON.stringify(provenance(M))}\n` + lines.join('\n')], {type: 'text/csv'}));
    } else if (kind === 'json') download(`${stem}_settings.json`, new Blob([JSON.stringify(provenance(M), null, 2)], {type: 'application/json'}));
  }
  async function svgToPng(svg, scale) {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], {type: 'image/svg+xml'}));
    try {
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('the figure could not be drawn as a picture')); img.src = url; });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d'); ctx.scale(scale, scale); ctx.drawImage(img, 0, 0);
      return await new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('the browser could not encode the picture'))), 'image/png'));
    } finally { URL.revokeObjectURL(url); }
  }
  async function pngFromSVG(svg, name) { download(name, await svgToPng(svg, 2)); }
  const csv = v => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

  // ---------------------------------------------------------- interaction
  function tooltip(html, x, y) {
    const tip = $('tooltip');
    tip.innerHTML = html; tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > innerWidth - 8) left = x - w - 14;
    if (top + h > innerHeight - 8) top = y - h - 14;
    tip.style.left = `${Math.max(8, left)}px`; tip.style.top = `${Math.max(8, top)}px`;
  }
  const hideTip = () => {
    $('tooltip').hidden = true;
    for (const id of ['hoverLayer', 'btHover', 'tcHover']) { const h = document.getElementById(id); if (h) h.innerHTML = ''; }
  };
  function svgPoint(evt) {
    const svg = $('figure').querySelector('svg');
    const r = svg.getBoundingClientRect();
    return {x: (evt.clientX - r.left) * (D.layout.width / r.width), y: (evt.clientY - r.top) * (D.layout.height / r.height)};
  }
  function timeAt(L, x) { return D.layout.pre + (x - L.x0) / L.plotW * (D.layout.post - D.layout.pre); }
  function hoverPsth(L, p, evt) {
    const M = D.model, t = timeAt(L, p.x);
    const j = clamp(Math.floor((t - M.grid.pre) / M.grid.bin), 0, M.grid.n - 1);
    const x = L.x0 + (M.grid.times[j] - D.layout.pre) / (D.layout.post - D.layout.pre) * L.plotW;
    const hl = document.getElementById('hoverLayer');
    if (hl) hl.innerHTML = `<line x1="${f1(x)}" x2="${f1(x)}" y1="${f1(L.rTop)}" y2="${f1(L.pBot)}" stroke="${figVar('--fig-muted')}" stroke-width="1"/>` +
      L.groups.map(g => { const v = g.psth.mean[j]; const y = L.pBot - clamp(v / M.ymax, 0, 1.02) * (L.pBot - L.pTop); return `<circle cx="${f1(x)}" cy="${f1(y)}" r="3.5" fill="${g.color}" stroke="${figVar('--fig-bg')}" stroke-width="1.5"/>`; }).join('');
    const rows = L.groups.map(g => `<div class="tr" style="--c:${g.color}"><i></i><span>${esc(g.label)}</span><em>${C.fmtNum(g.psth.mean[j], 1)}${M.errMul ? ` ± ${C.fmtNum(M.errMul * g.psth.sem[j], 1)}` : ''}</em></div>`).join('');
    tooltip(`<b>t = ${C.fmtNum(M.grid.times[j], 3)} s</b> <span style="opacity:.7">spikes/s</span>${rows}`, evt.clientX, evt.clientY);
  }
  /** The drawn raster row under a point of panel L: {b, k, i} or null. */
  function rowAt(L, p) {
    const b = L.blocks.find(x => p.y >= x.top && p.y < x.top + x.height);
    if (!b || !b.rows.length) return null;
    const k = clamp(Math.floor((p.y - b.top) / b.rowH), 0, b.rows.length - 1);
    return {b, k, i: b.rows[k]};
  }
  function hoverRaster(L, p, evt) {
    const r = rowAt(L, p);
    if (!r) { hideTip(); return; }
    const {b, k, i} = r, g = b.g || b.owner.get(i);
    const hl = document.getElementById('hoverLayer');
    const yc = b.top + (k + 0.5) * b.rowH;
    if (hl) hl.innerHTML = `<rect x="${f1(L.x0)}" y="${f1(yc - Math.max(b.rowH, 2) / 2)}" width="${f1(L.plotW)}" height="${f1(Math.max(b.rowH, 2))}" fill="${g.color}" opacity="0.18"/>`;
    tooltip(rowTip(D.model.T, i), evt.clientX, evt.clientY);
  }

  let brush = null, tipTimer = 0;
  // Raster | PSTH divider.  Height moves between the two and their sum stays put, so a
  // fitted page still fits; in fit mode the raster share lives in D.fitRasterH.
  let psplit = null, psplitDown = 0;
  // Drawn heights, with the figure's own narrow (< 560 px) scaling.
  const narrowFig = () => !!(D.layout && D.layout.width < 560);
  const psthScale = () => (narrowFig() ? 170 / 205 : 1);
  function setRasterPx(h) {
    if (fitsWindow()) D.fitRasterH = h;
    else S.rasterH = clamp(Math.round(h / (narrowFig() ? 0.8 : 1)), RASTER_MIN, RASTER_MAX);
  }
  function dragPsthSplit(evt) {
    const dy = (evt.clientY - psplit.y) * psplit.k;
    const r = clamp(Math.round(psplit.r0 + dy), fitsWindow() ? RASTER_FIT_MIN : RASTER_MIN, RASTER_MAX);
    const p = clamp(psplit.p0 - (r - psplit.r0), PSTH_MIN * psthScale(), PSTH_MAX * psthScale());
    const r2 = psplit.r0 + (psplit.p0 - p);  // the PSTH may have hit its limit first
    if (Math.abs(p - psthHeight(narrowFig())) < 1) return;  // a still pointer must not redraw between the clicks of a double-click
    S.psthH = clamp(Math.round(p / psthScale()), PSTH_MIN, PSTH_MAX);
    setRasterPx(r2);
    syncRasterOut(); schedule();
  }
  function resetPsthSplit() {
    const before = psthHeight(narrowFig());
    S.psthH = DEFAULTS.psthH;
    if (fitsWindow()) { D.fitPasses = 0; D.fitPrev = null; }  // the fit refills whatever the PSTH gave back
    else setRasterPx(rasterHeight(narrowFig()) + before - psthHeight(narrowFig()));
    changed();
  }

  function bindFigure() {
    const fig = $('figure');
    fig.addEventListener('pointermove', evt => {
      if (!D.layout || !D.model) return;
      if (psplit) { dragPsthSplit(evt); return; }
      const p = svgPoint(evt);
      if (brush) {
        const L = D.layout.panels[brush.p];
        const a = clamp(Math.min(brush.x, p.x), L.x0, L.x1), z = clamp(Math.max(brush.x, p.x), L.x0, L.x1);
        const hl = document.getElementById('hoverLayer');
        if (hl) hl.innerHTML = `<rect x="${f1(a)}" y="${f1(L.rTop)}" width="${f1(z - a)}" height="${f1(L.pBot - L.rTop)}" fill="${figVar('--accent')}" opacity="0.15"/>`;
        return;
      }
      const hit = evt.target.closest && evt.target.closest('.hit');
      if (!hit || hit.dataset.kind === 'rsplit') { if (evt.pointerType === 'mouse' || hit) hideTip(); return; }
      const L = D.layout.panels[Number(hit.dataset.p)];
      hit.dataset.kind === 'psth' ? hoverPsth(L, p, evt) : hoverRaster(L, p, evt);
    });
    fig.addEventListener('pointerleave', evt => { if (evt.pointerType === 'mouse' && !brush) hideTip(); });
    fig.addEventListener('pointerdown', evt => {
      const hit = evt.target.closest && evt.target.closest('.hit');
      if (!hit || !D.layout) return;
      if (hit.dataset.kind === 'rsplit') {
        // Two presses within 400 ms reset the PSTH height (the pointer is captured, so the
        // browser's dblclick would go to the figure rather than the divider).
        const now = performance.now();
        if (now - psplitDown < 400) { psplitDown = 0; resetPsthSplit(); evt.preventDefault(); return; }
        psplitDown = now;
        const r = fig.querySelector('svg').getBoundingClientRect();
        psplit = {y: evt.clientY, r0: rasterHeight(narrowFig()), p0: psthHeight(narrowFig()), k: D.layout.height / r.height};
        fig.setPointerCapture(evt.pointerId); fig.style.cursor = 'row-resize'; hideTip(); evt.preventDefault();
        return;
      }
      if (evt.pointerType === 'mouse' && evt.button === 0 && hit.dataset.kind === 'psth') {
        brush = {p: Number(hit.dataset.p), x: svgPoint(evt).x, moved: false};
        fig.setPointerCapture(evt.pointerId);
        hideTip();
      } else if (evt.pointerType !== 'mouse') {
        const L = D.layout.panels[Number(hit.dataset.p)], p = svgPoint(evt);
        hit.dataset.kind === 'psth' ? hoverPsth(L, p, evt) : hoverRaster(L, p, evt);
        clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, 3500);
      }
    });
    fig.addEventListener('pointerup', evt => {
      if (psplit) { psplit = null; fig.style.cursor = ''; saveState(); return; }
      if (!brush) return;
      const L = D.layout.panels[brush.p], x = svgPoint(evt).x;
      if (Math.abs(x - brush.x) > 4) {
        const snap = v => Math.round(v / 0.01) * 0.01;
        const a = snap(timeAt(L, clamp(Math.min(brush.x, x), L.x0, L.x1))), z = snap(timeAt(L, clamp(Math.max(brush.x, x), L.x0, L.x1)));
        if (z - a >= 0.01) { S.cw = [tidy(a), tidy(z)]; changed(); toast(`Count window [${C.fmtNum(S.cw[0])}, ${C.fmtNum(S.cw[1])}) s`); }
      }
      brush = null; hideTip();
    });
    fig.addEventListener('pointercancel', () => { brush = null; if (psplit) { psplit = null; fig.style.cursor = ''; saveState(); } hideTip(); });
    fig.addEventListener('click', evt => {
      const hit = evt.target.closest && evt.target.closest('.hit');
      if (!hit || hit.dataset.kind !== 'raster' || !D.layout || !D.model) return;
      const r = rowAt(D.layout.panels[Number(hit.dataset.p)], svgPoint(evt));
      if (r) setPin(pinFromRow(D.model.T, r.i));
    });
    bindPopFigure(fig);
  }

  // ---------------------------------------------------- behavior timeline
  // Session time on x; trial bands shaded by task; a stim lane (▲ stim train, △ sham)
  // and an event lane (one tick per recorded event, coloured by category; ● reward,
  // × unrewarded trial end).  A click on a raster row, an event, an alignment tick or
  // a trial pins that trial: it stays highlighted in every raster panel and the
  // timeline centres on it.
  const ERROR_COLOR = '#d62728';
  let btPending = false;
  function scheduleBehavior() {
    if (btPending) return;
    btPending = true;
    const run = () => { if (!btPending) return; btPending = false; renderBehavior(); };
    requestAnimationFrame(run);
    setTimeout(run, 80);
  }
  function btCentre(B) {
    if (D.btC === null) {
      const p = S.pin ? B.trials.pos.get(S.pin.trial) : undefined;
      D.btC = p !== undefined ? p + 0.5 : S.btN / 2;
    }
    return D.btC;
  }
  /** Index of each table row's visible group in the current model (-1: not in the raster). */
  function rowOwners(M) {
    if (!M) return null;
    if (!M.owner) {
      M.owner = new Int16Array(M.T.n).fill(-1);
      M.visible.forEach((g, gi) => g.rows.forEach(i => { M.owner[i] = gi; }));
    }
    return M.owner;
  }
  const tableFor = () => (D.model && D.model.T && D.model.T.alignment === S.align ? D.model.T : D.tables.get(S.align));

  // Yoked, the rasters keep only the timeline's trials: at least YOKE_MIN of them (or every
  // trial there is), centred on the pinned trial as far as covering the whole view allows.
  const YOKE_MIN = 20;
  const yokeWanted = () => S.yoke && S.bt && S.mode === 'raster';
  function yokeRange() {
    const B = D.behavior;
    if (!yokeWanted() || !B || !B.trials.n) return null;
    const V = C.behaviorView(B, btCentre(B), S.btN);
    const pinPos = S.pin ? B.trials.pos.get(S.pin.trial) : undefined;
    const {first, last} = C.yokedTrials(B, V, pinPos !== undefined ? pinPos : Math.floor((V.a + V.b) / 2), YOKE_MIN);
    const ids = new Set();
    for (let p = first; p <= last; p++) ids.add(B.trials.id[p]);
    return {first, last, ids, key: `${first}|${last}`, from: B.trials.id[first], to: B.trials.id[last]};
  }
  /** True when the rasters were drawn for a different yoked range than the timeline now implies. */
  function yokeStale() {
    const y = yokeRange();
    return (y ? y.key : null) !== (D.model && D.model.yokeKey ? D.model.yokeKey : null);
  }
  /** The timeline moved: redraw it, and the rasters too when their yoked trials changed. */
  function behaviorMoved() {
    if (yokeStale()) schedule(); else scheduleBehavior();
  }

  function renderBehavior() {
    const host = $('behavior');
    if (!host || S.mode !== 'raster') return;
    host.classList.toggle('collapsed', !S.bt);
    $('btToggle').setAttribute('aria-expanded', String(S.bt));
    renderPinInfo();
    if (!S.bt) { D.btLayout = null; return; }
    const fig = $('btFig'), B = D.behavior;
    if (!B) {
      fig.innerHTML = D.behaviorError
        ? `<p class="bt-note">Behavior timeline unavailable: ${esc(D.behaviorError)}. A server started before this feature needs a restart.</p>`
        : '<p class="bt-note">Loading behavior…</p>';
      D.btLayout = null; return;
    }
    if (!B.trials.n) { fig.innerHTML = '<p class="bt-note">No trials with recorded times in this session.</p>'; D.btLayout = null; return; }
    const width = Math.max(260, Math.floor(fig.clientWidth || $('stage').clientWidth - 36));
    const {svg, layout} = behaviorSVG(B, width);
    fig.innerHTML = svg;
    D.btLayout = layout;
    const tasks = $('btTasks');
    if (tasks) tasks.innerHTML = [...new Set(B.trials.task.filter(Boolean))]
      .map(t => `<i style="--c:${SEM.task[t] || '#868e96'}"></i>${esc(C.humanize(t))}`).join('');
    const n = B.trials.n;
    $('btN').max = String(n);
    $('btN').value = String(Math.min(S.btN, n));
    const {first, last} = C.viewTrials(B, layout.view);
    $('btNOut').textContent = S.btN >= n ? `all ${n} trials` : `${last - first + 1} trials · ${B.trials.id[first]}–${B.trials.id[last]}`;
    $('btYoke').checked = S.yoke;
    drawBehaviorPin();
  }

  const EVENT_CAT_COLOR = {Stim: '#e8590c', Stimulus: '#1971c2', 'Eye & response': '#9c36b5', Reward: '#2f9e44', Trial: '#868e96'};
  const STIM_EVENTS = new Set(['microstim', 'sham_microstim']);
  const taskC = (task, muted) => (task && SEM.task[task] ? paint(SEM.task[task]) : muted);
  function behaviorSVG(B, width) {
    const ink = figVar('--fig-ink'), muted = figVar('--fig-muted'), gridC = figVar('--fig-grid'), axisC = figVar('--fig-axis'), bg = figVar('--fig-bg');
    const narrow = width < 560, f = f1;
    const ml = narrow ? 52 : 88, mr = 10, x0 = ml, x1 = width - mr, plotW = x1 - x0;
    const labH = 16, rowH = 24, evH = 18, spH = 22, axH = 26, ovGap = 6, ovH = 14;
    const yStim = labH + rowH / 2, yEv = labH + rowH * 1.5, eTop = labH + 2 * rowH + 4, eBot = eTop + evH;
    const sTop = eBot + 3, sBot = sTop + spH;   // the unit's spike train
    const axY = sBot + 2, ovTop = axY + axH + ovGap, height = ovTop + ovH + 5;
    const T = B.trials, E = B.events;
    const V = C.behaviorView(B, btCentre(B), S.btN);
    D.btC = (V.a + V.b) / 2;
    const span = Math.max(1e-6, V.t1 - V.t0);
    const X = t => x0 + (t - V.t0) / span * plotW;
    const s0 = T.start[0], s1 = Math.max(T.stop[T.n - 1], s0 + 1e-6);
    const XO = t => x0 + (t - s0) / (s1 - s0) * plotW;
    const out = [];
    const firstP = clamp(Math.floor(V.a) - 1, 0, T.n - 1), lastP = clamp(Math.ceil(V.b), 0, T.n - 1);
    out.push(`<clipPath id="btClip"><rect x="${f(x0)}" y="0" width="${f(plotW)}" height="${f(axY)}"/></clipPath><g clip-path="url(#btClip)">`);
    // trial bands shaded by task, task changes, trial IDs
    let lastLabel = -Infinity, prevTask = null;
    for (let q = firstP - 1; q >= 0 && !prevTask; q--) prevTask = T.task[q];
    const errC = isDark() ? '#ff6b6b' : ERROR_COLOR;
    for (let p = firstP; p <= lastP; p++) {
      const a = X(T.start[p]), z = X(T.stop[p]);
      const task = T.task[p], change = prevTask && task && prevTask !== task;
      if (task) prevTask = task;
      if (z < x0 - 2 || a > x1 + 2) continue;
      const done = T.complete[p] === true;
      if (T.initiated[p] !== false) out.push(`<rect x="${f(a)}" y="${labH}" width="${f(Math.max(0.5, z - a))}" height="${f(sBot - labH)}" fill="${done ? taskC(task, muted) : muted}" opacity="${done ? (isDark() ? 0.16 : 0.09) : 0.05}"/>`);
      if (change) out.push(`<line x1="${f(a)}" x2="${f(a)}" y1="${labH - 2}" y2="${f(sBot)}" stroke="${ink}" stroke-width="1" stroke-dasharray="4 3" opacity="0.7"/>`);
      const cx = Math.max(a, x0) + 2;
      if (change) { out.push(`<text x="${f(cx)}" y="11" font-size="10.5" font-weight="650" fill="${taskC(task, muted)}">${esc(C.humanize(task))} ${T.id[p]}</text>`); lastLabel = cx + 6 * String(task).length + 30; }
      else if (cx > lastLabel + 4 && z - a > 16) { out.push(`<text x="${f(cx)}" y="11" font-size="10" fill="${muted}">${T.id[p]}${done ? '' : ' ✕'}</text>`); lastLabel = cx + 6 * String(T.id[p]).length + 8; }
      if (done && T.rewarded[p] === false && z > x0 && z < x1 + 2) {
        const r = 3;
        out.push(`<path d="M${f(z - 4 - r)} ${f(yEv - r)}l${2 * r} ${2 * r}M${f(z - 4 - r)} ${f(yEv + r)}l${2 * r} ${-2 * r}" stroke="${errC}" stroke-width="1.4" stroke-linecap="round"/>`);
      }
    }
    out.push(`<line x1="${f(x0)}" x2="${f(x1)}" y1="${f(labH + rowH)}" y2="${f(labH + rowH)}" stroke="${gridC}"/>`);
    const yoke = yokeRange();
    if (yoke) {   // the rasters' trials
      const a = X(T.start[yoke.first]), z = X(T.stop[yoke.last]);
      out.push(`<rect x="${f(a)}" y="${f(labH - 3)}" width="${f(Math.max(1, z - a))}" height="2.5" rx="1" fill="${figVar('--accent')}"/>`);
    }
    // events: stim/sham trains as triangles, rewards as dots, everything else a tick by category
    const k0 = C.lowerBound(E.t, V.t0 - 0.5), k1 = C.lowerBound(E.t, V.t1 + 0.5);
    const stride = Math.max(1, Math.ceil((k1 - k0) / (plotW * 2)));
    const sq = narrow ? 7.5 : 8.5;
    const glyphs = [], ticks = new Map();
    for (let k = k0; k < k1; k++) {
      const e = E.event[k], x = X(E.t[k]);
      if (STIM_EVENTS.has(e)) {
        glyphs.push({k, x, y: yStim});
        const stim = e === 'microstim', h = sq;
        out.push(`<path d="M${f(x)} ${f(yStim - h / 2)}l${f(h / 2)} ${f(h)}h${f(-h)}z" fill="${stim ? paint('#e8590c') : bg}" stroke="${stim ? paint('#e8590c') : muted}" stroke-width="1.5"/>`);
      } else if (e === 'reward') {
        glyphs.push({k, x, y: yEv});
        out.push(`<circle cx="${f(x)}" cy="${f(yEv)}" r="${f(sq / 2.4)}" fill="${paint('#2f9e44')}"/>`);
      } else if ((k - k0) % stride === 0) {
        glyphs.push({k, x, y: yEv});
        const c = EVENT_CAT_COLOR[eventCategory(e)] || '#868e96';
        ticks.set(c, (ticks.get(c) || '') + `M${f(x)} ${f(yEv - 6)}v12`);
      }
    }
    for (const [c, d] of ticks) out.push(`<path d="${d}" stroke="${paint(c)}" stroke-width="1.2" opacity="0.8"/>`);
    // this alignment's rows: ticks coloured by raster group, faint when not in the raster
    const Tab = tableFor(), owner = rowOwners(D.model && D.model.T === Tab ? D.model : null);
    const rowTicks = [];
    if (Tab) {
      const i0 = C.lowerBound(Tab.t, V.t0), i1 = C.lowerBound(Tab.t, V.t1);
      const rstride = Math.max(1, Math.ceil((i1 - i0) / (plotW * 1.5)));
      const paths = new Map();
      for (let i = i0; i < i1; i += rstride) {
        const gi = owner ? owner[i] : -1, x = X(Tab.t[i]);
        rowTicks.push({i, x});
        const c = gi >= 0 ? D.model.visible[gi].color : null;
        paths.set(c, (paths.get(c) || '') + (c ? `M${f(x)} ${f(eTop + 1)}v${evH - 2}` : `M${f(x)} ${f(eTop + 5)}v${evH - 10}`));
      }
      for (const [c, d] of paths) out.push(c ? `<path d="${d}" stroke="${c}" stroke-width="1.2"/>` : `<path d="${d}" stroke="${muted}" stroke-width="1" opacity="0.45"/>`);
    }
    // the unit's spike train, every spike (no eligibility rule), one tick per pixel
    // column shaded by its count: single spikes while they are sparser than a pixel,
    // a density strip when zoomed out
    const train = D.trains.get(S.unit);
    let spikeRate = null;
    if (train) {
      const W = Math.max(1, Math.round(plotW)), SHADES = 5;
      const {counts, ref, n} = C.spikeColumns(train, V.t0, V.t1, W);
      spikeRate = n / span;
      const shade = Array(SHADES + 1).fill('');
      for (let c = 0; c < W; c++) {
        if (!counts[c]) continue;
        const k = Math.min(SHADES, Math.ceil(counts[c] / ref * SHADES));
        shade[k] += `M${f(x0 + (c + 0.5) * plotW / W)} ${f(sTop + 1)}v${spH - 2}`;
      }
      for (let k = 1; k <= SHADES; k++) if (shade[k]) out.push(`<path d="${shade[k]}" stroke="${ink}" stroke-width="1" opacity="${(0.25 + 0.75 * k / SHADES).toFixed(2)}"/>`);
    } else {
      const note = D.trainErrors.has(S.unit) ? `spike train unavailable: ${D.trainErrors.get(S.unit)}` : 'loading spikes…';
      out.push(`<text x="${f(x0 + 6)}" y="${f(sTop + spH / 2 + 3.5)}" font-size="10" fill="${muted}">${esc(note)}</text>`);
    }
    out.push('</g>');
    // labels and axis
    const lab = (y, text) => out.push(`<text x="${f(x0 - 8)}" y="${f(y + 3.5)}" text-anchor="end" font-size="${narrow ? 10.5 : 11.5}" fill="${ink}">${esc(text)}</text>`);
    lab(yStim, narrow ? 'stim' : 'Stim / sham');
    lab(yEv, narrow ? 'events' : 'Trial events');
    out.push(`<text x="${f(x0 - 8)}" y="${f((eTop + eBot) / 2 + 3.5)}" text-anchor="end" font-size="10" fill="${muted}">aligned</text>`);
    out.push(`<text x="${f(x0 - 8)}" y="${f(sTop + (spikeRate === null ? spH / 2 + 3.5 : 9))}" text-anchor="end" font-size="10" fill="${muted}">spikes</text>`);
    if (spikeRate !== null) out.push(`<text x="${f(x0 - 8)}" y="${f(sTop + 19)}" text-anchor="end" font-size="9.5" fill="${muted}">${C.fmtNum(spikeRate, 1)}/s</text>`);
    out.push(`<line x1="${f(x0)}" x2="${f(x1)}" y1="${f(axY)}" y2="${f(axY)}" stroke="${axisC}"/>`);
    for (const v of niceTicks(V.t0, V.t1, Math.max(3, Math.round(plotW / 90)))) {
      if (v < V.t0 || v > V.t1) continue;
      out.push(`<line x1="${f(X(v))}" x2="${f(X(v))}" y1="${f(axY)}" y2="${f(axY + 4)}" stroke="${axisC}"/>`);
      out.push(`<text x="${f(X(v))}" y="${f(axY + 15)}" text-anchor="middle" font-size="10" fill="${muted}">${C.fmtNum(v)}</text>`);
    }
    out.push(`<text x="${f(x0 - 8)}" y="${f(axY + 15)}" text-anchor="end" font-size="10" fill="${muted}">time (s)</text>`);
    // whole-session overview with the visible window
    let ov = '';
    for (let p = 0; p < T.n; p++) {
      if (T.initiated[p] === false) continue;
      const a = XO(T.start[p]), z = XO(T.stop[p]);
      ov += `<rect x="${f(a)}" y="${f(ovTop)}" width="${f(Math.max(0.6, z - a))}" height="${ovH}" fill="${T.complete[p] === true ? taskC(T.task[p], muted) : muted}"/>`;
    }
    out.push(`<g opacity="${isDark() ? 0.55 : 0.4}">${ov}</g>`);
    if (yoke) {
      const a = XO(T.start[yoke.first]), z = XO(T.stop[yoke.last]);
      out.push(`<rect x="${f(a)}" y="${f(ovTop + ovH + 2)}" width="${f(Math.max(2, z - a))}" height="2.5" rx="1" fill="${figVar('--accent')}"/>`);
    }
    const va = XO(V.t0), vz = XO(V.t1);
    out.push(`<rect x="${f(va)}" y="${f(ovTop - 2)}" width="${f(Math.max(3, vz - va))}" height="${ovH + 4}" rx="2" fill="${figVar('--accent')}" fill-opacity="0.12" stroke="${figVar('--accent')}" stroke-width="1.5"/>`);
    out.push(`<text x="${f(x0 - 8)}" y="${f(ovTop + ovH / 2 + 3.5)}" text-anchor="end" font-size="10" fill="${muted}">session</text>`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.ceil(height)}" viewBox="0 0 ${width} ${Math.ceil(height)}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif">` +
      out.join('') + '<g id="btPinLayer" pointer-events="none"></g><g id="btHover" pointer-events="none"></g></svg>';
    return {svg, layout: {width, height, x0, x1, plotW, labH, rowH, eTop, eBot, sTop, sBot, axY, ovTop, ovH, yStim, yEv, sq, view: V, X, XO, s0, s1, glyphs, ticks: rowTicks, T: Tab}};
  }

  /** What is under a point of the timeline. */
  function behaviorHit(p) {
    const L = D.btLayout, B = D.behavior;
    if (!L || !B) return null;
    if (p.y >= L.ovTop - 4 && p.y <= L.ovTop + L.ovH + 4) return p.x >= L.x0 - 4 && p.x <= L.x1 + 4 ? {kind: 'overview'} : null;
    if (p.x < L.x0 || p.x > L.x1 || p.y > L.axY) return null;
    if (p.y < L.eTop - 2) {
      let best = null, bd = 9;
      for (const g of L.glyphs) { const d = Math.max(Math.abs(g.x - p.x), Math.abs(g.y - p.y)); if (d < bd) { bd = d; best = g; } }
      if (best) return {kind: 'event', k: best.k, x: best.x, y: best.y};
    } else if (p.y <= L.eBot + 2 && L.ticks.length) {
      let best = null, bd = 4;
      for (const tk of L.ticks) { const d = Math.abs(tk.x - p.x); if (d < bd) { bd = d; best = tk; } }
      if (best) return {kind: 'row', i: best.i, x: best.x};
    }
    const t = L.view.t0 + (p.x - L.x0) / L.plotW * (L.view.t1 - L.view.t0);
    const q = C.upperBound(B.trials.start, t) - 1;
    if (q >= 0 && t <= B.trials.stop[q]) return {kind: 'trial', p: q};
    return null;
  }
  function btPoint(evt) {
    const svg = $('btFig').querySelector('svg');
    const r = svg.getBoundingClientRect();
    return {x: (evt.clientX - r.left) * (D.btLayout.width / r.width), y: (evt.clientY - r.top) * (D.btLayout.height / r.height)};
  }
  const yesNo = v => (v === true ? 'yes' : v === false ? 'no' : '—');
  function eventTip(k) {
    const B = D.behavior, E = B.events, p = E.tpos[k], T = B.trials;
    const start = p >= 0 ? T.start[p] : NaN;
    const kv = [['trial', E.trial[k]], ['task', p >= 0 && T.task[p] ? C.humanize(T.task[p]) : '—'], ['at', `${C.fmtNum(E.t[k], 3)} s`]];
    if (Number.isFinite(start)) kv.push(['in trial', `${C.fmtNum(E.t[k] - start, 3)} s after its start`]);
    const c = paint(EVENT_CAT_COLOR[eventCategory(E.event[k])] || '#868e96');
    return `<div class="tr" style="--c:${c}"><i></i><span><b>${esc(eventLabel(E.event[k]))}</b></span></div>` +
      `<div class="kv">${kv.map(([a, v]) => `<span>${esc(a)}</span><b>${esc(v)}</b>`).join('')}</div><div class="hint">click to pin this trial</div>`;
  }
  function trialTip(p) {
    const B = D.behavior, T = B.trials, evs = B.byTrial[p], E = B.events;
    const kv = [['task', T.task[p] ? C.humanize(T.task[p]) : '—'], ['rewarded', yesNo(T.rewarded[p])], ['stim', yesNo(T.microstim[p])],
      ['sham', yesNo(T.sham[p])], ['complete', yesNo(T.complete[p])],
      ['time', `${C.fmtNum(T.start[p], 1)}–${C.fmtNum(T.stop[p], 1)} s (${C.fmtNum(T.stop[p] - T.start[p], 1)} s)`],
      ['events', String(evs.length)]];
    const order = evs.slice(0, 12).map(k => `${eventLabel(E.event[k])} ${C.fmtNum(E.t[k] - T.start[p], 2)}`);
    if (order.length) kv.push(['sequence (s)', order.join(' · ') + (evs.length > 12 ? ' …' : '')]);
    if (T.initiated[p] === false) kv.push(['fixated', 'no']);
    return `<b>trial ${T.id[p]}</b><div class="kv">${kv.map(([a, v]) => `<span>${esc(a)}</span><b>${esc(v)}</b>`).join('')}</div><div class="hint">click to pin this trial</div>`;
  }
  function btHover(hit, evt) {
    const L = D.btLayout, layer = document.getElementById('btHover');
    if (!layer) return;
    const muted = figVar('--fig-muted');
    if (!hit || hit.kind === 'overview') { layer.innerHTML = ''; $('tooltip').hidden = true; return; }
    if (hit.kind === 'event') {
      const s = L.sq + 6;
      layer.innerHTML = `<rect x="${f1(hit.x - s / 2)}" y="${f1(hit.y - s / 2)}" width="${f1(s)}" height="${f1(s)}" rx="2.5" fill="none" stroke="${muted}" stroke-width="1.4"/>`;
      tooltip(eventTip(hit.k), evt.clientX, evt.clientY);
    } else if (hit.kind === 'row') {
      layer.innerHTML = `<line x1="${f1(hit.x)}" x2="${f1(hit.x)}" y1="${f1(L.labH)}" y2="${f1(L.sBot)}" stroke="${muted}" stroke-width="1"/>`;
      tooltip(rowTip(L.T, hit.i), evt.clientX, evt.clientY);
    } else {
      const T = D.behavior.trials, a = L.X(T.start[hit.p]), z = L.X(T.stop[hit.p]);
      layer.innerHTML = `<rect x="${f1(a)}" y="${f1(L.labH)}" width="${f1(Math.max(1, z - a))}" height="${f1(L.sBot - L.labH)}" fill="none" stroke="${muted}" stroke-width="1.2"/>`;
      tooltip(trialTip(hit.p), evt.clientX, evt.clientY);
    }
  }
  /** Row tooltip body shared by the raster and the timeline's event ticks. */
  function rowTip(T, i) {
    const M = D.model && D.model.T === T ? D.model : null;
    const owner = rowOwners(M), g = M && owner[i] >= 0 ? M.visible[owner[i]] : null;
    const kv = [['trial', T.trial[i]], ['event time', `${C.fmtNum(T.t[i], 2)} s`]];
    if (T.event) kv.push(['event', eventLabel(T.event[i])]);
    for (const key of ['task', 'microstim', 'sham', 'rewarded', S.color, S.style, S.panel]) {
      const col = key && T.byKey.get(key);
      if (!col || kv.some(([a]) => a === col.label)) continue;
      const v = C.rawValue(col, i);
      kv.push([col.label, typeof v === 'number' ? C.fmtNum(v) : C.formatLevel(key, v)]);
    }
    if (M) {
      kv.push(['spikes in count window', g ? C.countIn(M.spikes[i], M.cw[0], M.cw[1]) : '—']);
      for (const m of S.markers) { const h = M.markerData[m.id] && M.markerData[m.id][i]; if (h && h.length) kv.push([m.label || eventLabel(m.e), `${h.map(x => C.fmtNum(x.t, 3)).join(', ')} s`]); }
    }
    const head = g ? `<div class="tr" style="--c:${g.color}"><i></i><span><b>${esc(g.label)}</b></span></div>` : `<b>${esc(eventLabel(S.align))}</b> <span style="opacity:.7">not in the raster</span>`;
    return `${head}<div class="kv">${kv.map(([a, v]) => `<span>${esc(a)}</span><b>${esc(v)}</b>`).join('')}</div><div class="hint">click to pin this trial</div>`;
  }

  /** Pin a trial (and optionally one of its rows), or clear with null. */
  function setPin(pin) {
    S.pin = pin;
    const B = D.behavior;
    if (pin && B && B.trials.pos.has(pin.trial)) D.btC = B.trials.pos.get(pin.trial) + 0.5;
    saveState();
    if (yokeStale()) { render(); return; }
    drawPin();
    renderBehavior();
  }
  function pinFromRow(T, i) {
    return {trial: T.trial[i], uid: null, row: T.rowId[i], t: T.t[i]};
  }
  function pinFromEvent(k) {
    const E = D.behavior.events, T = tableFor();
    let row = null;
    if (T) {
      // the row of this trial in the current alignment nearest the event
      let best = Infinity;
      for (let i = 0; i < T.n; i++) {
        if (T.trial[i] !== E.trial[k]) continue;
        const d = Math.abs(T.t[i] - E.t[k]);
        if (d < best) { best = d; row = T.rowId[i]; }
      }
    }
    return {trial: E.trial[k], uid: null, row, t: E.t[k]};
  }

  /** The pinned trial in every raster panel; the pinned row outlined. */
  function drawPin() {
    const layer = document.getElementById('pinLayer');
    if (!layer) return;
    const L = D.layout, M = D.model, pin = S.pin;
    if (!pin || !L || !M) { layer.innerHTML = ''; return; }
    const accent = figVar('--accent'), T = M.T, out = [];
    for (const P of L.panels) for (const b of P.blocks) {
      b.rows.forEach((i, k) => {
        if (T.trial[i] !== pin.trial) return;
        const h = Math.max(b.rowH, 3), y = b.top + (k + 0.5) * b.rowH - h / 2;
        const exact = pin.row !== null && T.rowId[i] === pin.row;
        out.push(`<rect x="${f1(P.x0)}" y="${f1(y)}" width="${f1(P.plotW)}" height="${f1(h)}" fill="${accent}" fill-opacity="${exact ? 0.42 : 0.28}"${exact ? ` stroke="${accent}" stroke-width="1.2"` : ''}/>`);
        const tx = S.grouped ? P.x1 + 28 : P.x1 + 1;   // clear of the group counts
        out.push(`<path d="M${f1(tx)} ${f1(y + h / 2)}l6 -4v8z" fill="${accent}"/>`);
      });
    }
    layer.innerHTML = out.join('');
  }
  function drawBehaviorPin() {
    const layer = document.getElementById('btPinLayer'), L = D.btLayout, B = D.behavior, pin = S.pin;
    if (!layer || !L || !B) return;
    if (!pin || !B.trials.pos.has(pin.trial)) { layer.innerHTML = ''; return; }
    const accent = figVar('--accent'), p = B.trials.pos.get(pin.trial), out = [];
    const a = clamp(L.X(B.trials.start[p]), L.x0, L.x1), z = clamp(L.X(B.trials.stop[p]), L.x0, L.x1);
    if (z > a) out.push(`<rect x="${f1(a)}" y="${f1(L.labH - 1)}" width="${f1(Math.max(1.5, z - a))}" height="${f1(L.sBot - L.labH + 1)}" fill="${accent}" fill-opacity="0.08" stroke="${accent}" stroke-width="1.6" rx="2"/>`);
    if (pin.t !== null && pin.t >= L.view.t0 && pin.t <= L.view.t1) {
      const x = L.X(pin.t);
      out.push(`<line x1="${f1(x)}" x2="${f1(x)}" y1="${f1(L.labH)}" y2="${f1(L.axY)}" stroke="${accent}" stroke-width="1.2" stroke-dasharray="3 2"/>`);
    }
    const xo = L.XO((B.trials.start[p] + B.trials.stop[p]) / 2);
    out.push(`<path d="M${f1(xo)} ${f1(L.ovTop - 3)}l-4 -5h8z" fill="${accent}"/>`);
    layer.innerHTML = out.join('');
  }
  function renderPinInfo() {
    const el = $('btPin');
    if (!el) return;
    const pin = S.pin;
    if (!pin) { el.innerHTML = '<span class="bt-hint">click a raster row, event or trial to pin it</span>'; return; }
    const B = D.behavior, M = D.model;
    const bits = [`<b>trial ${pin.trial}</b>`];
    const p = B ? B.trials.pos.get(pin.trial) : undefined;
    if (p !== undefined && B.trials.task[p]) bits.push(esc(C.humanize(B.trials.task[p])));
    if (p !== undefined && B.trials.microstim[p] === true) bits.push('stim');
    else if (p !== undefined && B.trials.sham[p] === true) bits.push('sham');
    if (p !== undefined && B.trials.complete[p] !== true) bits.push('incomplete · in no raster');
    else if (M) {
      const T = M.T, owner = rowOwners(M), why = {filtered: 0, yoked: 0, unstable: 0, window: 0, hidden: 0};
      let all = 0, shown = 0;
      for (let i = 0; i < T.n; i++) {
        if (T.trial[i] !== pin.trial) continue;
        all++;
        if (owner[i] >= 0) shown++;
        else if (!M.fmask[i]) why.filtered++;
        else if (M.yoke && !M.yoke.ids.has(T.trial[i])) why.yoked++;
        else if (M.elig[i] === 1 || M.elig[i] === 2) why.unstable++;
        else if (M.elig[i] === 3) why.window++;
        else why.hidden++;
      }
      const reason = why.unstable ? (S.policy === 'verified_stable' ? 'trial not stable for this unit' : 'trial not complete')
        : why.window ? 'window leaves the stable run' : why.filtered ? 'filtered out' : why.yoked ? 'outside the yoked trials' : why.hidden ? 'in hidden groups' : '';
      bits.push(!all ? `no ${esc(eventLabel(S.align))} rows` : shown === all ? `${all} row${all > 1 ? 's' : ''} in raster`
        : `${shown} of ${all} rows in raster${reason ? ` <span class="why">(${esc(reason)})</span>` : ''}`);
    }
    el.innerHTML = `<span class="pin-chip" title="Show the pinned trial"><i></i><span class="pin-text">${bits.join(' · ')}</span><button type="button" class="x" id="btUnpin" aria-label="Unpin trial" title="Unpin (Esc)">×</button></span>`;
  }

  function bindBehavior() {
    const fig = $('btFig');
    const act = (hit, evt) => {
      if (!hit) return;
      if (hit.kind === 'event') setPin(pinFromEvent(hit.k));
      else if (hit.kind === 'row') setPin(pinFromRow(D.btLayout.T, hit.i));
      else if (hit.kind === 'trial') setPin({trial: D.behavior.trials.id[hit.p], uid: null, row: null, t: null});
      if (evt.pointerType !== 'mouse') btHover(behaviorHit(btPoint(evt)), evt);
    };
    const overviewTo = evt => {
      const L = D.btLayout, x = clamp(btPoint(evt).x, L.x0, L.x1);
      D.btC = C.posAtTime(D.behavior, L.s0 + (x - L.x0) / L.plotW * (L.s1 - L.s0));
      behaviorMoved();
    };
    fig.addEventListener('pointerdown', evt => {
      if (!D.btLayout || (evt.pointerType === 'mouse' && evt.button !== 0)) return;
      const p = btPoint(evt), hit = behaviorHit(p);
      if (hit && hit.kind === 'overview') { D.btDrag = {overview: true}; fig.setPointerCapture(evt.pointerId); overviewTo(evt); return; }
      D.btDrag = {x: p.x, c: D.btC, moved: false, hit, id: evt.pointerId};
    });
    fig.addEventListener('pointermove', evt => {
      if (!D.btLayout) return;
      const drag = D.btDrag;
      if (drag && drag.overview) { overviewTo(evt); return; }
      const p = btPoint(evt);
      if (drag && (drag.moved || Math.abs(p.x - drag.x) > 5)) {
        if (!drag.moved) { drag.moved = true; try { fig.setPointerCapture(drag.id); } catch (e) { /* released */ } btHover(null); }
        const V = D.btLayout.view;
        D.btC = drag.c - (p.x - drag.x) / D.btLayout.plotW * (V.b - V.a);
        behaviorMoved();
        return;
      }
      if (evt.pointerType === 'mouse') btHover(behaviorHit(p), evt);
    });
    const end = evt => {
      const drag = D.btDrag;
      D.btDrag = null;
      if (!drag || drag.overview || drag.moved || evt.type === 'pointercancel') return;
      act(drag.hit, evt);
    };
    fig.addEventListener('pointerup', end);
    fig.addEventListener('pointercancel', end);
    fig.addEventListener('pointerleave', evt => { if (evt.pointerType === 'mouse' && !D.btDrag) btHover(null); });
    // Trackpad: horizontal swipe pans, pinch (ctrl + wheel) zooms; a vertical wheel still scrolls the page.
    fig.addEventListener('wheel', evt => {
      const L = D.btLayout, B = D.behavior;
      if (!L || !B) return;
      const V = L.view, count = V.b - V.a;
      if (evt.ctrlKey) {
        evt.preventDefault();
        const x = clamp(btPoint(evt).x, L.x0, L.x1), anchor = V.a + (x - L.x0) / L.plotW * count;
        const n = clamp(Math.round(count * Math.exp(evt.deltaY * 0.01)), 3, B.trials.n);
        S.btN = n;
        D.btC = anchor - (anchor - V.a) * n / count + n / 2;
        saveState(); behaviorMoved();
      } else if (Math.abs(evt.deltaX) > Math.abs(evt.deltaY)) {
        evt.preventDefault();
        D.btC += evt.deltaX / L.plotW * count;
        behaviorMoved();
      }
    }, {passive: false});
    $('btToggle').addEventListener('click', () => { S.bt = !S.bt; changed({data: S.bt}); });
    $('btYoke').addEventListener('change', e => { S.yoke = e.target.checked; changed({data: S.yoke}); });
    $('btN').addEventListener('input', e => { S.btN = Number(e.target.value); saveState(); behaviorMoved(); });
    const pan = dir => { if (!D.btLayout) return; const V = D.btLayout.view; D.btC += dir * Math.max(1, (V.b - V.a) / 2); behaviorMoved(); };
    $('btPrev').addEventListener('click', () => pan(-1));
    $('btNext').addEventListener('click', () => pan(1));
    $('btPin').addEventListener('click', e => {
      if (e.target.closest('#btUnpin')) { setPin(null); return; }
      if (e.target.closest('.pin-chip') && S.pin && D.behavior && D.behavior.trials.pos.has(S.pin.trial)) { D.btC = D.behavior.trials.pos.get(S.pin.trial) + 0.5; behaviorMoved(); }
    });
  }

  function stepUnit(delta) {
    const list = unitList();
    if (!list.length) return;
    let idx = list.findIndex(u => u.id === S.unit);
    if (idx < 0) idx = delta > 0 ? -1 : 0;
    S.unit = list[(idx + delta + list.length) % list.length].id;
    changed({data: true});
  }

  function bindControls() {
    $('sessionSelect').addEventListener('change', e => selectSession(e.target.value).then(renderStructure));
    $('prevUnit').addEventListener('click', () => stepUnit(-1));
    $('nextUnit').addEventListener('click', () => stepUnit(1));
    $('unitBtn').addEventListener('click', () => D.units.length && openUnitPicker());
    $('alignBtn').addEventListener('click', () => D.summary && openAlignPicker());
    $('viewsBtn').addEventListener('click', openViews);
    $('saveBtn').addEventListener('click', openSaveFinding);
    $('findingBar').addEventListener('toggle', e => { if (openedFinding && e.target.matches('.fb-note')) openedFinding.notesOpen = e.target.open; }, true);
    $('findingBar').addEventListener('click', e => {
      if (e.target.closest('[data-fbclose]')) { openedFinding = null; renderFindingBar(); }
      else if (e.target.closest('[data-fbback]') && openedFinding) openFinding(openedFinding.finding);
    });
    $('cfgFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) openConfigFile(f); });
    $('exportBtn').addEventListener('click', openExport);
    $('menuBtn').addEventListener('click', openMenu);
    $('scrim').addEventListener('click', closePop);
    addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const quiet = $('popover').hidden && !$('controls').classList.contains('open');
        closePop(); hideTip(); closeSheet();
        if (quiet && S.pin && S.mode === 'raster') setPin(null);
      }
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'select', 'textarea'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey || !$('popover').hidden) return;
      if (S.mode === 'population') {
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && D.popLayout) {
          e.preventDefault(); stopPlay();
          D.cursor = clamp((D.cursor ?? -1) + (e.key === 'ArrowRight' ? 1 : -1), 0, D.popLayout.n - 1);
          $('cursor').value = D.cursor; drawCursor();
        }
        if (e.key === ' ' && D.popLayout) { e.preventDefault(); togglePlay(); }
        return;
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepUnit(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); stepUnit(1); }
    });

    // popover delegation
    const pop = $('popover');
    pop.addEventListener('click', e => {
      const t = e.target.closest('button, [data-close]');
      if (!t) return;
      if (t.hasAttribute('data-close')) { closePop(); return; }
      if (t.dataset.menu) {
        closePop();
        if (t.dataset.menu.startsWith('mode:')) setMode(t.dataset.menu.slice(5));
        else if (t.dataset.menu === 'restart') restartServer();
        else if (t.dataset.menu === 'savefinding') openSaveFinding();
        else (t.dataset.menu === 'views' ? openViews : openExport)();
        return;
      }
      if (t.dataset.ru) {
        const id = Number(t.dataset.ru), set = new Set(S.roster);
        set.has(id) ? set.delete(id) : set.add(id);
        S.roster = [...set].sort((a, b) => a - b);
        t.classList.toggle('on', set.has(id)); rosterLive(); rosterChanged(450); return;
      }
      if (t.dataset.rq) { const q = t.dataset.rq; RF.q = RF.q.includes(q) ? RF.q.filter(x => x !== q) : [...RF.q, q]; t.classList.toggle('on'); fillRosterItems(); return; }
      if (t.dataset.ra) { const a = t.dataset.ra; RF.a = RF.a.includes(a) ? RF.a.filter(x => x !== a) : [...RF.a, a]; t.classList.toggle('on'); fillRosterItems(); return; }
      if (t.hasAttribute('data-rall')) { S.roster = [...new Set([...S.roster, ...rosterShown().map(u => u.id)])].sort((a, b) => a - b); fillRosterItems(); rosterChanged(300); return; }
      if (t.hasAttribute('data-rnone')) { const drop = new Set(rosterShown().map(u => u.id)); S.roster = S.roster.filter(id => !drop.has(id)); fillRosterItems(); rosterChanged(300); return; }
      if (t.dataset.unit) { S.unit = Number(t.dataset.unit); closePop(); changed({data: true}); return; }
      if (t.dataset.align) {
        const old = S.align; S.align = t.dataset.align; closePop();
        if (old !== S.align) { S.hidden = []; if (S.sort.startsWith('field:')) S.sort = 'session'; }
        renderHeader(); changed({data: true, structure: true}); ensureData().then(renderStructure); return;
      }
      if (t.dataset.uq) { const q = t.dataset.uq; S.unitQ = S.unitQ.includes(q) ? S.unitQ.filter(x => x !== q) : [...S.unitQ, q]; t.classList.toggle('on'); fillUnitItems($('unitSearch').value); saveState(); return; }
      if (t.dataset.ua) { const a = t.dataset.ua; S.unitArea = S.unitArea.includes(a) ? S.unitArea.filter(x => x !== a) : [...S.unitArea, a]; t.classList.toggle('on'); fillUnitItems($('unitSearch').value); saveState(); return; }
      if (t.dataset.tpl) { closePop(); applyTemplate(TEMPLATES[Number(t.dataset.tpl)]); return; }
      if (t.dataset.finding) { const f = D.findings[Number(t.dataset.finding)]; if (f) openFinding(f); return; }
      if (t.dataset.cfg) { closePop(); const c = D.configs[Number(t.dataset.cfg)]; if (c) applyConfig(c.title, c.state); return; }
      if (t.hasAttribute('data-openconfig')) { closePop(); $('cfgFile').click(); return; }
      if (t.hasAttribute('data-savefinding')) { openSaveFinding(); return; }
      if (t.hasAttribute('data-copylink')) { saveState(); setTimeout(() => navigator.clipboard.writeText(location.href).then(() => toast('Link copied — it restores this exact view.'), () => toast(location.href)), 300); return; }
      if (t.dataset.exp) { closePop(); (S.mode === 'population' ? popExport : doExport)(t.dataset.exp).catch(err => toast(err.message, true)); return; }
      if (t.dataset.mdel) { S.markers = S.markers.filter(m => m.id !== t.dataset.mdel); if (S.sort === `marker:${t.dataset.mdel}`) S.sort = 'session'; closePop(); renderStructure(); changed(); return; }
    });
    pop.addEventListener('input', e => {
      if (e.target.id === 'unitSearch') fillUnitItems(e.target.value);
      if (e.target.id === 'rosterSearch') { RF.text = e.target.value; fillRosterItems(); }
      if (e.target.id === 'alignSearch') fillAlignItems(e.target.value);
    });
    pop.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || !['unitSearch', 'alignSearch'].includes(e.target.id)) return;
      const first = pop.querySelector(e.target.id === 'unitSearch' ? '[data-unit]' : '[data-align]');
      if (first) first.click();
    });
    addEventListener('resize', () => { placePop(); schedule(); });
    // Pickers fill their lists after opening; re-place whenever the popover changes size.
    if (window.ResizeObserver) new ResizeObserver(() => placePop()).observe(pop);

    // filters
    $('quickFilters').addEventListener('click', e => {
      const b = e.target.closest('[data-qf]');
      if (!b) return;
      const key = b.dataset.qf, level = b.dataset.level;
      let f = S.filters.find(x => x.k === key && x.v);
      if (!f) { f = {k: key, v: []}; S.filters.push(f); }
      f.v = f.v.includes(level) ? f.v.filter(x => x !== level) : [...f.v, level];
      if (!f.v.length) S.filters = S.filters.filter(x => x !== f);
      changed();
    });
    $('otherFilters').addEventListener('click', e => {
      const x = e.target.closest('[data-fx]');
      if (x) { S.filters.splice(Number(x.dataset.fx), 1); renderFilterChips(); changed(); return; }
      const chip = e.target.closest('[data-f]');
      if (chip) { const f = S.filters[Number(chip.dataset.f)]; if (D.tables.get(S.align)?.byKey.has(f.k)) openFilterEditor(chip, f.k); }
    });
    $('addFilter').addEventListener('click', e => openFieldPicker(e.currentTarget, key => openFilterEditor($('addFilter'), key)));
    $('clearFilters').addEventListener('click', () => { S.filters = []; renderFilterChips(); changed(); });

    // grouping
    const regroup = () => { S.hidden = []; changed({structure: false}); syncControls(); };
    $('colorBy').addEventListener('change', e => { S.color = e.target.value || null; regroup(); });
    $('styleBy').addEventListener('change', e => { S.style = e.target.value || null; regroup(); });
    $('panelBy').addEventListener('change', e => { S.panel = e.target.value || null; regroup(); });
    $('qbins').addEventListener('change', e => { S.qbins = Number(e.target.value); regroup(); });
    $('groupPresets').addEventListener('click', e => { const b = e.target.closest('[data-gp]'); if (!b) return; const [a, c] = b.dataset.gp.split('|'); S.color = a; S.style = c || null; regroup(); });
    $('sortBy').addEventListener('change', e => { if (S.mode === 'population') S.nsort = e.target.value; else S.sort = e.target.value; changed(); });
    $('modes').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
    $('rosterBtn').addEventListener('click', e => D.units.length && openRosterPicker(e.currentTarget));
    $('chooseNeurons').addEventListener('click', e => D.units.length && openRosterPicker(e.currentTarget));
    $('clearRoster').addEventListener('click', () => { S.roster = []; rosterChanged(); });
    $('rosterPresets').addEventListener('click', e => { const b = e.target.closest('[data-rp]'); if (b) applyRosterPreset(b.dataset.rp); });
    $('rosterLimits').addEventListener('click', e => {
      const b = e.target.closest('[data-rmunit]');
      if (b) { S.roster = S.roster.filter(id => id !== Number(b.dataset.rmunit)); rosterChanged(); return; }
      if (e.target.closest('[data-trim]') && D.stab) {
        const masks = S.roster.map(id => D.stab.masks.get(id) || new Uint8Array((D.stab.n + 7) >> 3));
        const best = C.bestSubset(masks, D.stab.n);
        if (!best.indices.length) { toast('None of these neurons has stable trials.', true); return; }
        const before = S.roster.length;
        S.roster = best.indices.map(i => S.roster[i]);
        toast(`Kept ${S.roster.length} of ${before} neurons, sharing ${best.trials} stable trials (greedy heuristic).`);
        rosterChanged(); return;
      }
      if (e.target.closest('[data-rmzero]') && D.stab) { S.roster = S.roster.filter(id => D.stab.masks.has(id) && C.popcount(D.stab.masks.get(id), D.stab.n) > 0); rosterChanged(); }
    });
    $('tdrBtn').addEventListener('click', openTdrPicker);
    $('popover').addEventListener('click', e => {
      const t = e.target.closest('[data-tdr],[data-tdr-reset]'); if (!t) return;
      if (t.dataset.tdr) S.tdrFactors = S.tdrFactors.includes(t.dataset.tdr) ? S.tdrFactors.filter(x => x !== t.dataset.tdr) : [...S.tdrFactors, t.dataset.tdr].slice(0, 10);
      else S.tdrFactors = clone(DEFAULTS.tdrFactors);
      openTdrPicker(); renderStructure(); changed();
    });
    const tdrWinChange = () => {
      const lo = Number($('tdrLoN').value), hi = Number($('tdrHiN').value);
      const full = lo <= S.win[0] && hi >= S.win[1];
      S.tdrWin = $('tdrLoN').value !== '' && $('tdrHiN').value !== '' && lo < hi && !full ? [lo, hi] : null;
      changed();
    };
    $('tdrLoN').addEventListener('change', tdrWinChange); $('tdrHiN').addEventListener('change', tdrWinChange);
    $('ncomp').addEventListener('input', e => { S.ncomp = Number(e.target.value); $('ncompN').value = S.ncomp; renderStructure(); changed(); });
    $('ncompN').addEventListener('change', e => {
      const v = Number(e.target.value);
      if (!Number.isInteger(v) || v < 2) { syncControls(); return; }
      if (v > MAX_NCOMP) toast(`At most ${MAX_NCOMP} components.`, true);
      S.ncomp = Math.min(v, MAX_NCOMP); $('ncompN').value = S.ncomp; renderStructure(); changed();
    });
    for (const [id, i] of [['axX', 0], ['axY', 1], ['axZ', 2]]) $(id).addEventListener('change', e => { S.axes[i] = Number(e.target.value); saveState(); rerenderPopFigure(); });
    $('heatGroup').addEventListener('change', e => { S.heatGroup = e.target.value; saveState(); rerenderPopFigure(); });
    $('cursor').addEventListener('input', e => { stopPlay(); D.cursor = Number(e.target.value); drawCursor(); });
    $('playBtn').addEventListener('click', togglePlay);
    $('cloudOn').addEventListener('change', e => { S.cloud = e.target.checked; changed(); });
    $('cloudZero').addEventListener('change', e => { S.cloudZero = e.target.checked; changed(); });
    $('cloudAlpha').addEventListener('input', e => { S.cloudAlpha = Number(e.target.value) / 100; $('cloudAlphaOut').textContent = `${Math.round(S.cloudAlpha * 100)}%`; saveState(); rerenderPopFigure(); });
    $('sortDir').addEventListener('click', () => { S.dir = -S.dir; changed(); });
    $('grouped').addEventListener('change', e => { S.grouped = e.target.checked; changed(); });
    $('legend').addEventListener('click', e => {
      const b = e.target.closest('[data-g]');
      if (!b) return;
      if (b.dataset.g === '__all') S.hidden = [];
      else S.hidden = S.hidden.includes(b.dataset.g) ? S.hidden.filter(k => k !== b.dataset.g) : [...S.hidden, b.dataset.g];
      changed();
    });
    $('legend').addEventListener('contextmenu', e => {
      const b = e.target.closest('[data-g]');
      if (!b || b.dataset.g === '__all') return;
      e.preventDefault(); openGroupStyle(b, b.dataset.g);
    });
    let press = null;
    $('legend').addEventListener('pointerdown', e => {
      const b = e.target.closest('[data-g]');
      if (!b || e.pointerType === 'mouse' || b.dataset.g === '__all') return;
      press = setTimeout(() => { press = 'fired'; openGroupStyle(b, b.dataset.g); }, 520);
    });
    const cancelPress = () => { if (press && press !== 'fired') clearTimeout(press); };
    $('legend').addEventListener('pointerup', cancelPress);
    $('legend').addEventListener('pointercancel', cancelPress);
    $('legend').addEventListener('click', e => { if (press === 'fired') { press = null; e.stopImmediatePropagation(); } }, true);
    $('legend').addEventListener('dblclick', e => {
      const b = e.target.closest('[data-g]');
      if (!b || !D.model || b.dataset.g === '__all') return;
      S.hidden = D.model.grouping.groups.map(g => g.key).filter(k => k !== b.dataset.g);
      changed();
    });

    // markers
    $('addMarker').addEventListener('click', e => openMarkerEditor(e.currentTarget, null));
    $('markerPresets').addEventListener('click', e => { const b = e.target.closest('[data-mp]'); if (!b) return; const [ev, match, occ, label] = b.dataset.mp.split('|'); addMarker(ev, match, occ, label); });
    $('markerList').addEventListener('click', e => {
      const ed = e.target.closest('[data-medit]'); if (ed) { openMarkerEditor(ed, ed.dataset.medit); return; }
      const del = e.target.closest('[data-mdel]');
      if (del) { S.markers = S.markers.filter(m => m.id !== del.dataset.mdel); if (S.sort === `marker:${del.dataset.mdel}`) S.sort = 'session'; renderStructure(); changed(); }
    });
    $('refForm').addEventListener('submit', e => { e.preventDefault(); const v = Number($('refInput').value); if ($('refInput').value !== '' && Number.isFinite(v)) { S.refs.push(v); $('refInput').value = ''; renderMarkers(); changed(); } });
    $('refList').addEventListener('click', e => { const b = e.target.closest('[data-rdel]'); if (b) { S.refs.splice(Number(b.dataset.rdel), 1); renderMarkers(); changed(); } });
    $('showMedians').addEventListener('change', e => { S.medians = e.target.checked; changed(); });

    // display knobs
    const winChanged = () => { clampCw(); changed({data: !rasterCovers(D.rasters.get(rasterKey()))}); };
    $('winLo').addEventListener('input', e => { S.win[0] = tidy(Number(e.target.value), 2); winChanged(); });
    $('winHi').addEventListener('input', e => { S.win[1] = tidy(Number(e.target.value), 2); winChanged(); });
    $('winLoN').addEventListener('change', e => { const v = Number(e.target.value); if (Number.isFinite(v) && v < S.win[1] && v >= -10) { S.win[0] = v; winChanged(); } else syncControls(); });
    $('winHiN').addEventListener('change', e => { const v = Number(e.target.value); if (Number.isFinite(v) && v > S.win[0] && v <= 10) { S.win[1] = v; winChanged(); } else syncControls(); });
    $('cwLo').addEventListener('input', e => { S.cw[0] = Math.min(Number(e.target.value), S.cw[1] - 0.01); changed(); });
    $('cwHi').addEventListener('input', e => { S.cw[1] = Math.max(Number(e.target.value), S.cw[0] + 0.01); changed(); });
    $('cwLoN').addEventListener('change', e => { const v = Number(e.target.value); if (Number.isFinite(v) && v < S.cw[1]) S.cw[0] = v; changed(); });
    $('cwHiN').addEventListener('change', e => { const v = Number(e.target.value); if (Number.isFinite(v) && v > S.cw[0]) S.cw[1] = v; changed(); });
    $('bin').addEventListener('input', e => { S.bin = Number(e.target.value) / 1000; changed(); });
    $('sigma').addEventListener('input', e => { S.sigma = Number(e.target.value) / 1000; changed(); });
    $('rasterH').addEventListener('input', e => { S.rasterH = Number(e.target.value); S.rasterFit = false; changed(); });
    // The divider above the behavior timeline: drag to set the raster height, double-click
    // (two presses within 400 ms, as the population divider) to fit the window again.
    let rsplit = null, rsplitDown = 0;
    const bs = $('btSplit');
    const setFit = () => { S.rasterFit = true; D.fitRasterH = null; D.fitPasses = 0; changed(); };
    bs.addEventListener('pointerdown', evt => {
      const now = performance.now();
      if (now - rsplitDown < 400) { rsplitDown = 0; rsplit = null; setFit(); evt.preventDefault(); return; }
      rsplitDown = now;
      rsplit = {y: evt.clientY, h0: rasterHeight(), rows: panelRows(D.layout)};
      bs.setPointerCapture(evt.pointerId); bs.classList.add('dragging'); hideTip(); evt.preventDefault();
    });
    bs.addEventListener('pointermove', evt => {
      if (!rsplit) return;
      const h = Math.round(clamp(rsplit.h0 + (evt.clientY - rsplit.y) / rsplit.rows, RASTER_MIN, RASTER_MAX));
      if (Math.abs(h - rasterHeight()) < 1) return;  // a still pointer must not leave fit between the clicks of a double-click
      S.rasterFit = false; S.rasterH = h; syncRasterOut(); schedule();
    });
    const rsplitEnd = () => { if (!rsplit) return; rsplit = null; bs.classList.remove('dragging'); saveState(); };
    bs.addEventListener('pointerup', rsplitEnd); bs.addEventListener('pointercancel', rsplitEnd);
    bs.addEventListener('keydown', evt => {
      if (evt.key === 'Enter') { setFit(); evt.preventDefault(); return; }
      if (evt.key !== 'ArrowUp' && evt.key !== 'ArrowDown') return;
      evt.preventDefault();
      S.rasterH = clamp(rasterHeight() + (evt.key === 'ArrowDown' ? 10 : -10), RASTER_MIN, RASTER_MAX); S.rasterFit = false; changed();
    });
    // Collapsing the timeline or a wrapping header changes what has to fit.
    if (window.ResizeObserver) new ResizeObserver(() => { if (fitsWindow() && S.mode === 'raster') schedule(); }).observe($('behavior'));
    $('ylock').addEventListener('change', e => { S.ylock = e.target.checked ? (D.model ? tidy(D.model.ymax, 1) : 20) : null; changed(); });
    $('ymax').addEventListener('change', e => { const v = Number(e.target.value); if (v > 0) { S.ylock = v; changed(); } });
    $('showBars').addEventListener('change', e => { S.bars = e.target.checked; changed(); });
    document.querySelectorAll('.seg[data-key]').forEach(seg => seg.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const key = seg.dataset.key;
      S[key] = b.dataset.v;
      changed({data: key === 'policy', structure: key === 'method'});
    }));
    $('resetDisplay').addEventListener('click', () => { Object.assign(S, clone(DISPLAY_DEFAULTS)); changed({data: true}); });
    $('empty').addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'all-complete') { S.policy = 'all_complete'; changed({data: true}); }
      if (b.dataset.act === 'clear-filters') { S.filters = []; renderFilterChips(); changed(); }
      if (b.dataset.act.startsWith('rp:')) applyRosterPreset(b.dataset.act.slice(3));
      if (b.dataset.act === 'choose') openRosterPicker(b);
      if (b.dataset.act === 'refit') { D.fitErrors.clear(); schedule(); }
    });

    // bottom sheet (tablet / phone)
    $('bottomTabs').addEventListener('click', e => {
      const b = e.target.closest('[data-tab]'); if (!b) return;
      const ctl = $('controls');
      if (ctl.classList.contains('open') && ctl.dataset.tab === b.dataset.tab) closeSheet();
      else { ctl.dataset.tab = b.dataset.tab; ctl.classList.add('open'); ctl.scrollTop = 0; document.querySelectorAll('#bottomTabs button').forEach(x => x.classList.toggle('on', x === b)); }
    });
    $('sheetHandle').addEventListener('click', closeSheet);
    let sheetY = null;
    $('sheetHandle').addEventListener('touchstart', e => { sheetY = e.touches[0].clientY; }, {passive: true});
    $('sheetHandle').addEventListener('touchend', e => { if (sheetY !== null && e.changedTouches[0].clientY - sheetY > 30) closeSheet(); sheetY = null; });
    bindFigure();
    bindBehavior();
    new ResizeObserver(() => schedule()).observe($('stage'));
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  }
  function closeSheet() { $('controls').classList.remove('open'); document.querySelectorAll('#bottomTabs button').forEach(x => x.classList.remove('on')); }

  function applyTheme() {
    const pref = localStorage.getItem('eg-theme') || 'auto';
    const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    if (D.model) { renderQuickFilters(D.model); renderMarkers(); }
    schedule();
  }

  let toastTimer = 0;
  function toast(message, error = false) {
    const t = $('toast');
    t.textContent = message; t.hidden = false; t.classList.toggle('error', error);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, error ? 6000 : 2600);
  }

  // #f=<id> (the Findings page's Open) opens that finding once; the address bar then holds the view as usual.
  async function openFindingLink() {
    const m = location.hash.match(/[#&]f=([\w-]+)/);
    if (!m) return false;
    history.replaceState(null, '', location.pathname);
    try { return await openFinding(await getJSON(`/api/findings/${encodeURIComponent(m[1])}`)); }
    catch (e) { toast(`Could not open finding ${m[1]}: ${e.message}`, true); return false; }
  }
  async function start() {
    // Drop a one-time ?token= from the address bar once the cookie is set.
    if (location.search.includes('token=')) history.replaceState(null, '', location.pathname + location.hash);
    applyTheme();
    loadState();
    bindControls();
    syncControls();
    try {
      const cat = await getJSON('/api/catalog');
      D.catalog = cat.sessions;
      $('sessionSelect').innerHTML = D.catalog.map(s => `<option value="${esc(s.id)}" title="${esc(s.id)}">${esc(shortSession(s.id))}</option>`).join('') || '<option>No sessions</option>';
      if (await openFindingLink()) return;
      const sid = D.catalog.some(s => s.id === S.session) ? S.session : cat.default_session;
      if (!sid) { showEmpty('No sessions found', 'Export one with `python -m session_viewer build …` (phys-analysis) into ~/viewer_sessions, or start electro_gui with --data-root or --session-file.'); return; }
      await selectSession(sid);
      renderStructure();
    } catch (e) {
      showEmpty('Cannot reach electro_gui', esc(e.message));
    }
  }
  // Read-only hooks for QA scripts and the browser console.
  window.EGDebug = {state: () => clone(S), model: () => D.model, exportSVG: () => exportSVG(), layout: () => D.layout,
    popExportSVG: () => popExportSVG(), popFit: () => D.popFit, popLayout: () => D.popLayout,
    behavior: () => D.behavior, btLayout: () => D.btLayout, pin: p => (p === undefined ? S.pin : setPin(p)),
    evidence: () => evidence(), figureReady: () => figureReady(), finding: () => openedFinding};
  addEventListener('hashchange', () => {
    if (/[#&]f=/.test(location.hash)) { openFindingLink(); return; }
    const m = location.hash.match(/[#&]s=([^&]+)/);
    if (!m) return;
    try {
      const next = sanitize(C.decodeState(m[1]));
      if (JSON.stringify(next) === JSON.stringify(S)) return;
      const sessionChanged = next.session !== S.session;
      S = next;
      if (sessionChanged) selectSession(S.session).then(renderStructure); else afterBigChange();
    } catch (e) { /* ignore foreign hashes */ }
  });
  start();
})();
