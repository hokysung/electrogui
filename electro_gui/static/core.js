/* electro_gui explorer core: pure computations, no DOM.
 *
 * Loaded by the browser as window.EGCore and by node (tests) via require().
 * Everything the figure shows is computed here from three server payloads:
 * the alignment table (joined fields per row), the unit raster (spike times
 * around each row plus each row's eligible span) and marker event times.
 *
 * PSTH semantics follow electro_gui.analysis.compute_unit: bins are half-open
 * [a, b) from `pre` in steps of `bin`; rates are counts / bin; the optional
 * Gaussian kernel is sampled at bin spacing out to ceil(4 sigma / bin) bins,
 * normalised, and applied to bins that extend past the window ('valid'
 * convolution).  Weighting 'trial' averages rows within a trial before
 * averaging trials (v0.1's rule); 'event' treats every row as one unit.
 * SEM is the sample standard deviation (ddof 1) / sqrt(n units).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EGCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GUARD_S = 0.4;
  const MISSING = '∅';           // level key for a missing value
  const SEP = '␟';               // group-key separator

  // ---------------------------------------------------------------- labels
  const FIELD_LABELS = {
    task: 'task', microstim: 'stim', sham: 'sham', rewarded: 'rewarded', success: 'trial success',
    fixated: 'fixated', microstim_amplitude: 'stim amplitude (uA)', block_id: 'block', task_type: 'task type',
    trial: 'trial', since_trial_start: 'time in trial (s)', previous_task: 'previous task',
    previous_rewarded: 'previous rewarded', trial_end_t: 'trial end (s from event)', trial_start_t: 'trial start (s from event)',
  };
  const LEVEL_ORDER = {
    task: ['fixation', 'memory_saccade', 'pursuit', 'pursuit_memory', 'overlap_saccade', 'reveal', 'freeview'],
  };
  LEVEL_ORDER.previous_task = LEVEL_ORDER.task;

  const humanize = s => String(s).replace(/^trial\./, '').replace(/_/g, ' ');
  function fieldLabel(key, col) {
    if (FIELD_LABELS[key]) return FIELD_LABELS[key];
    const base = humanize(key);
    return col && col.relative ? base.replace(/ t$/, '') + ' (s from event)' : base;
  }

  /** Legend-ready text for one level of one field. */
  function formatLevel(key, value) {
    const missing = value === null || value === undefined;
    if (key === 'previous_task') return missing ? 'first trial' : `after ${humanize(value)}`;
    if (key === 'previous_rewarded') return missing ? 'first trial' : value ? 'after a rewarded trial' : 'after an unrewarded trial';
    if (missing) return `${fieldLabel(key)} missing`;
    if (key === 'task') return humanize(value);
    if (key === 'microstim') return value ? 'stim' : 'no stim';
    if (key === 'sham') return value ? 'sham' : 'no sham';
    if (key === 'rewarded') return value ? 'rewarded' : 'unrewarded';
    if (key === 'success') return value ? 'trial success' : 'trial failure';
    if (typeof value === 'boolean') return `${fieldLabel(key)}: ${value ? 'yes' : 'no'}`;
    if (typeof value === 'number') return `${fieldLabel(key)} ${fmtNum(value)}`;
    if (value && typeof value === 'object' && value.bin) return `${fieldLabel(key)} ${value.label}`;
    return humanize(value);
  }
  function fmtNum(v, digits) {
    if (!Number.isFinite(v)) return '—';
    if (digits !== undefined) return v.toFixed(digits);
    if (Number.isInteger(v)) return String(v);
    const a = Math.abs(v);
    return v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3).replace(/\.?0+$/, '');
  }

  // ----------------------------------------------------------------- table
  const levelKey = v => (v === null || v === undefined ? MISSING : String(v));

  /** Decode the server's columnar table into typed arrays plus lookup maps. */
  function prepareTable(json) {
    const n = json.n;
    const columns = json.columns.map(c => {
      const col = {key: c.key, kind: c.kind, label: fieldLabel(c.key, c), rawLabel: c.label, category: c.category,
        timing: c.timing, description: c.description, relative: !!c.relative};
      if (c.kind === 'cat') {
        col.levels = c.levels;
        col.codes = Int32Array.from(c.codes);
        const order = LEVEL_ORDER[c.key];
        col.levelOrder = c.levels.map((_, i) => i);
        if (order) col.levelOrder.sort((a, b) => rank(order, c.levels[a]) - rank(order, c.levels[b]));
        else if (c.levels.length === 2 && c.levels[0] === false) col.levelOrder = [1, 0];   // yes before no
      } else {
        col.data = Float64Array.from(c.data, v => (v === null ? NaN : v));
        const distinct = new Set();
        for (const v of col.data) { if (!Number.isNaN(v)) { distinct.add(v); if (distinct.size > 12) break; } }
        col.discrete = distinct.size <= 12 && [...distinct].every(Number.isInteger);
        if (col.discrete) col.values = [...distinct].sort((a, b) => a - b);
      }
      col.counts = countLevels(col, n);
      return col;
    });
    const byKey = new Map(columns.map(c => [c.key, c]));
    return {n, alignment: json.alignment, sessionId: json.session_id, rowId: Int32Array.from(json.row_id),
      t: Float64Array.from(json.t), trial: Int32Array.from(json.trial), event: json.event, columns, byKey};
  }
  function rank(order, v) { const i = order.indexOf(String(v)); return i < 0 ? order.length : i; }

  function countLevels(col, n) {
    const counts = new Map();
    for (let i = 0; i < n; i++) {
      const k = levelKey(rawValue(col, i));
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return counts;
  }

  /** The row's value: level for categories, number for numbers, null when missing. */
  function rawValue(col, i) {
    if (col.kind === 'cat') { const c = col.codes[i]; return c < 0 ? null : col.levels[c]; }
    const v = col.data[i];
    return Number.isNaN(v) ? null : v;
  }

  /** Ordered distinct level keys of a field, with display labels. */
  function fieldLevels(col) {
    if (col.kind === 'cat') {
      const out = col.levelOrder.map(i => ({key: levelKey(col.levels[i]), value: col.levels[i]}));
      if (col.counts.has(MISSING)) out.push({key: MISSING, value: null});
      return out.map(l => ({...l, label: formatLevel(col.key, l.value), count: col.counts.get(l.key) || 0}));
    }
    if (col.discrete) {
      const out = col.values.map(v => ({key: levelKey(v), value: v}));
      if (col.counts.has(MISSING)) out.push({key: MISSING, value: null});
      return out.map(l => ({...l, label: formatLevel(col.key, l.value), count: col.counts.get(l.key) || 0}));
    }
    return null;
  }

  // --------------------------------------------------------------- filters
  /** filters: [{k, v:[levelKeys]}] (include) or [{k, r:[min|null, max|null]}] (inclusive range). */
  function filterMask(table, filters) {
    const mask = new Uint8Array(table.n).fill(1);
    for (const f of filters || []) {
      const col = table.byKey.get(f.k);
      if (!col) continue;                       // unknown in this alignment: ignored and reported by the UI
      if (f.v) {
        const allowed = new Set(f.v);
        for (let i = 0; i < table.n; i++) if (mask[i] && !allowed.has(levelKey(rawValue(col, i)))) mask[i] = 0;
      } else if (f.r) {
        const lo = f.r[0], hi = f.r[1];
        for (let i = 0; i < table.n; i++) {
          if (!mask[i]) continue;
          const v = rawValue(col, i);
          if (v === null || (lo !== null && lo !== undefined && v < lo) || (hi !== null && hi !== undefined && v > hi)) mask[i] = 0;
        }
      }
    }
    return mask;
  }

  /** Row eligibility for a display window: returns 0 ok, 1/2 server status, 3 window crosses the eligible run. */
  function eligibility(raster, pre, post) {
    const out = new Uint8Array(raster.n);
    for (let i = 0; i < raster.n; i++) {
      const span = raster.span[i];
      if (!span) { out[i] = raster.status[i] || 1; continue; }
      out[i] = (pre - GUARD_S >= span[0] - 1e-9 && post + GUARD_S <= span[1] + 1e-9) ? 0 : 3;
    }
    return out;
  }

  // -------------------------------------------------------------- grouping
  /** Equal-count bin edges over finite values (k groups). */
  function quantileEdges(values, k) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return [];
    // Bins are [e0, e1), [e1, e2), ..., with the last bin closed at the maximum.
    const edges = [v[0]];
    for (let j = 1; j < k; j++) {
      const q = v[Math.min(v.length - 1, Math.floor(j * v.length / k))];
      if (q > edges[edges.length - 1]) edges.push(q);
    }
    edges.push(v[v.length - 1] > edges[edges.length - 1] ? v[v.length - 1] : Infinity);
    return edges;
  }

  function binner(col, rows, k) {
    // Categories and small integer sets group by value; other numbers by quantile bins.
    if (col.kind === 'cat' || col.discrete) return i => ({key: levelKey(rawValue(col, i)), value: rawValue(col, i)});
    const edges = quantileEdges(rows.map(i => col.data[i]), k);
    const labels = [];
    for (let j = 0; j + 1 < edges.length; j++) {
      const last = j + 2 === edges.length;
      labels.push(`${j + 1}/${edges.length - 1}: ${last && edges[j + 1] === Infinity ? '≥ ' + fmtNum(edges[j]) : `${fmtNum(edges[j])}–${fmtNum(edges[j + 1])}`}`);
    }
    return i => {
      const v = col.data[i];
      if (Number.isNaN(v)) return {key: MISSING, value: null};
      let j = 0;
      while (j + 2 < edges.length && v >= edges[j + 1]) j++;
      return {key: `bin${j}`, value: {bin: j, label: labels[j]}, order: j};
    };
  }

  function levelRank(col, key) {
    if (key === MISSING) return 1e9;
    if (col.kind === 'cat') {
      const idx = col.levels.findIndex(l => levelKey(l) === key);
      return col.levelOrder.indexOf(idx);
    }
    if (col.discrete) return Number(key);
    return Number(key.slice(3));
  }

  /**
   * Split rows into groups by up to three fields.
   * spec: {color, style, panel} field keys or null; qbins: quantile bins for continuous numbers.
   * Returns {panels:[{key,label,value}], groups:[{key,panel,color,style,label,colorKey,styleIndex,rows}]}.
   */
  function groupRows(table, rows, spec) {
    const dims = ['color', 'style', 'panel'].map(d => {
      const col = spec[d] ? table.byKey.get(spec[d]) : null;
      return {d, col, bin: col ? binner(col, rows, spec.qbins || 3) : null};
    });
    const map = new Map();
    for (const i of rows) {
      const parts = dims.map(x => (x.col ? x.bin(i) : {key: '', value: undefined}));
      const key = parts.map(p => p.key).join(SEP);
      let g = map.get(key);
      if (!g) {
        g = {key, rows: [], parts};
        map.set(key, g);
      }
      g.rows.push(i);
    }
    const groups = [...map.values()];
    const rankOf = (g, di) => (dims[di].col ? levelRank(dims[di].col, g.parts[di].key) : 0);
    groups.sort((a, b) => rankOf(a, 2) - rankOf(b, 2) || rankOf(a, 0) - rankOf(b, 0) || rankOf(a, 1) - rankOf(b, 1));
    const styleKeys = [...new Set(groups.slice().sort((a, b) => rankOf(a, 1) - rankOf(b, 1)).map(g => g.parts[1].key))];
    const colorKeys = [...new Set(groups.slice().sort((a, b) => rankOf(a, 0) - rankOf(b, 0)).map(g => g.parts[0].key))];
    const panels = [];
    for (const g of groups) {
      const [c, s, p] = g.parts;
      g.colorKey = c.key; g.colorIndex = colorKeys.indexOf(c.key); g.colorValue = c.value;
      g.styleKey = s.key; g.styleIndex = dims[1].col ? styleKeys.indexOf(s.key) : 0;
      g.panel = p.key;
      const bits = [];
      if (dims[0].col) bits.push(formatLevel(dims[0].col.key, c.value));
      if (dims[1].col) bits.push(formatLevel(dims[1].col.key, s.value));
      g.label = bits.length ? bits.join(' · ') : 'all events';
      g.panelLabel = dims[2].col ? formatLevel(dims[2].col.key, p.value) : '';
      if (!panels.some(x => x.key === p.key)) panels.push({key: p.key, label: g.panelLabel});
      delete g.parts;
    }
    return {groups, panels, colorField: spec.color, styleField: spec.style, panelField: spec.panel,
      nColors: colorKeys.length, nStyles: styleKeys.length};
  }

  // --------------------------------------------------------------- markers
  /** Index one event's occurrences by trial: Map(trial -> [{t}] sorted by t). */
  function indexEvents(json) {
    const byTrial = new Map();
    for (let j = 0; j < json.n; j++) {
      const trial = json.trial[j];
      if (!byTrial.has(trial)) byTrial.set(trial, []);
      byTrial.get(trial).push({t: json.t[j]});
    }
    for (const list of byTrial.values()) list.sort((a, b) => a.t - b.t);
    return byTrial;
  }

  function pick(list, anchor, occ) {
    if (!list.length) return [];
    if (occ === 'all') return list;
    if (occ === 'first') return [list[0]];
    if (occ === 'last') return [list[list.length - 1]];
    if (occ === 'first_after') { const x = list.find(e => e.t >= anchor - 1e-9); return x ? [x] : []; }
    if (occ === 'last_before') { let x = null; for (const e of list) if (e.t <= anchor + 1e-9) x = e; return x ? [x] : []; }
    let best = list[0];                                  // nearest
    for (const e of list) if (Math.abs(e.t - anchor) < Math.abs(best.t - anchor)) best = e;
    return [best];
  }

  /**
   * Per-row marker times relative to each row's event.
   * spec: {match:'trial', occ, end?}; start/end: indexEvents() maps (rows match events of their own trial).
   * Returns [{t, t2?}] per row (t2 = band end); empty array when unmatched.
   */
  function markerTimes(table, rows, start, spec, end) {
    const out = new Array(table.n);
    for (const i of rows) {
      const anchor = table.t[i], trial = table.trial[i];
      const hits = pick(start.get(trial) || [], anchor, spec.occ || 'nearest');
      const ends = end ? end.get(trial) || [] : null;
      out[i] = hits.map(h => {
        const m = {t: h.t - anchor};
        if (ends) {
          const stop = ends.find(e => e.t >= h.t - 1e-9);
          m.t2 = stop ? stop.t - anchor : NaN;
        }
        return m;
      });
    }
    return out;
  }

  function median(values) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return NaN;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  // ---------------------------------------------------------------- counts
  function lowerBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  /** Spikes with lo <= s < hi in one row's sorted relative spike list. */
  const countIn = (spikes, lo, hi) => lowerBound(spikes, hi) - lowerBound(spikes, lo);

  // ------------------------------------------------------------------ PSTH
  function psthGrid(pre, post, bin, sigma) {
    let n = Math.round((post - pre) / bin);
    if (Math.abs(n * bin - (post - pre)) > 1e-9) n = Math.ceil((post - pre) / bin - 1e-9);
    n = Math.max(1, n);
    const radius = sigma > 0 ? Math.ceil(4 * sigma / bin - 1e-9) : 0;
    const kernel = new Float64Array(2 * radius + 1);
    let sum = 0;
    for (let k = 0; k <= 2 * radius; k++) {
      kernel[k] = radius ? Math.exp(-0.5 * Math.pow((k - radius) * bin / sigma, 2)) : 1;
      sum += kernel[k];
    }
    for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;
    const times = new Float64Array(n);
    for (let j = 0; j < n; j++) times[j] = pre + (j + 0.5) * bin;
    return {n, pre, post, bin, sigma, radius, kernel, times, padLo: pre - radius * bin, padHi: pre + (n + radius) * bin};
  }

  /** One row's (smoothed) rate curve on the grid, spikes/s. */
  function rowCurve(spikes, grid) {
    const {n, radius, kernel, bin, padLo} = grid;
    const m = n + 2 * radius;
    const counts = new Float64Array(m);
    const first = lowerBound(spikes, padLo - 1e-12);
    for (let s = first; s < spikes.length; s++) {
      const j = Math.floor((spikes[s] - padLo) / bin + 1e-9);
      if (j >= m) break;
      if (j >= 0) counts[j] += 1;
    }
    const out = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      let acc = 0;
      for (let k = 0; k < kernel.length; k++) acc += counts[j + k] * kernel[k];
      out[j] = acc / bin;
    }
    return out;
  }

  function meanSem(units, n) {
    const mean = new Float64Array(n), sem = new Float64Array(n);
    const N = units.length;
    if (!N) return {mean: mean.fill(NaN), sem: sem.fill(NaN)};
    for (const u of units) for (let j = 0; j < n; j++) mean[j] += u[j];
    for (let j = 0; j < n; j++) mean[j] /= N;
    if (N > 1) {
      for (const u of units) for (let j = 0; j < n; j++) sem[j] += (u[j] - mean[j]) ** 2;
      for (let j = 0; j < n; j++) sem[j] = Math.sqrt(sem[j] / (N - 1)) / Math.sqrt(N);
    }
    return {mean, sem};
  }

  /** Collapse per-row vectors into weighting units (rows, or trial means). */
  function unitsOf(rows, perRow, trialOf, weight) {
    if (weight !== 'trial') return rows.map(i => perRow(i));
    const byTrial = new Map();
    for (const i of rows) {
      const t = trialOf[i];
      if (!byTrial.has(t)) byTrial.set(t, []);
      byTrial.get(t).push(perRow(i));
    }
    return [...byTrial.values()].map(list => {
      if (list.length === 1) return list[0];
      const acc = new Float64Array(list[0].length);
      for (const v of list) for (let j = 0; j < acc.length; j++) acc[j] += v[j];
      for (let j = 0; j < acc.length; j++) acc[j] /= list.length;
      return acc;
    });
  }

  /** Group PSTH from per-row curves (e.g. cached rowCurve results): {mean, sem, n (units), events, trials}. */
  function psthFromCurves(rows, curveOf, trialOf, n, weight) {
    const units = unitsOf(rows, curveOf, trialOf, weight);
    const {mean, sem} = meanSem(units, n);
    return {mean, sem, n: units.length, events: rows.length, trials: new Set(rows.map(i => trialOf[i])).size};
  }
  function psth(rows, spikesOf, trialOf, grid, weight) {
    return psthFromCurves(rows, i => rowCurve(spikesOf(i), grid), trialOf, grid.n, weight);
  }

  /** Evenly spaced subset of at most k items, keeping order (display thinning only). */
  function thin(items, k) {
    if (items.length <= k) return items;
    const out = [];
    for (let j = 0; j < k; j++) out.push(items[Math.floor((j + 0.5) * items.length / k)]);
    return out;
  }

  /** Count-window rate per row, and the group mean ± SEM under the weighting. */
  function windowRates(rows, spikesOf, trialOf, lo, hi, weight) {
    const rate = i => Float64Array.of(countIn(spikesOf(i), lo, hi) / (hi - lo));
    const units = unitsOf(rows, rate, trialOf, weight);
    const {mean, sem} = meanSem(units, 1);
    return {mean: mean[0], sem: sem[0], n: units.length, values: units.map(u => u[0])};
  }

  // --------------------------------------------------------------- sorting
  /** Sort keys: 'session' | 'count' | 'marker:<id>' | 'field:<key>'. Missing values last; ties by time. */
  function sortRows(table, rows, key, dir, ctx) {
    let value;
    if (key === 'count') value = i => ctx.count(i);
    else if (key && key.startsWith('marker:')) {
      const times = ctx.markers && ctx.markers[key.slice(7)];
      value = i => (times && times[i] && times[i].length ? times[i][0].t : NaN);
    } else if (key && key.startsWith('field:')) {
      const col = table.byKey.get(key.slice(6));
      if (col && col.kind === 'cat') value = i => (col.codes[i] < 0 ? NaN : col.levelOrder.indexOf(col.codes[i]));
      else if (col) value = i => col.data[i];
    }
    if (!value) value = i => table.t[i];
    const v = new Map(rows.map(i => [i, value(i)]));
    return rows.slice().sort((a, b) => {
      const x = v.get(a), y = v.get(b);
      const xm = !Number.isFinite(x), ym = !Number.isFinite(y);
      if (xm || ym) return xm && ym ? table.t[a] - table.t[b] : xm ? 1 : -1;
      return (x - y) * dir || table.t[a] - table.t[b];
    });
  }

  // ------------------------------------------------------------ population
  /** Base64 bitmask (bit i&7 of byte i>>3) to bytes. */
  function decodeMask(b64) {
    const bin = atob(b64);
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }
  function andMask(a, b) {
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] & (b[i] || 0);
    return out;
  }
  const POP8 = Uint8Array.from({length: 256}, (_, b) => { let n = 0; for (let x = b; x; x >>= 1) n += x & 1; return n; });
  /** Set bits among the first nbits. */
  function popcount(bytes, nbits) {
    const whole = nbits >> 3;
    let n = 0;
    for (let i = 0; i < whole; i++) n += POP8[bytes[i]];
    const rest = nbits & 7;
    if (rest) n += POP8[bytes[whole] & ((1 << rest) - 1)];
    return n;
  }
  /** popcount(a & b) over the first nbits, without allocating. */
  function andCount(a, b, nbits) {
    const whole = nbits >> 3;
    let n = 0;
    for (let i = 0; i < whole; i++) n += POP8[a[i] & b[i]];
    const rest = nbits & 7;
    if (rest) n += POP8[a[whole] & b[whole] & ((1 << rest) - 1)];
    return n;
  }
  /**
   * Subset of `masks` maximising (members x shared trials): multistart greedy growth,
   * as session_viewer.explorer_core.select_stable_population, over at most 60 seeds.
   * Returns indices into masks and the shared-trial count.
   */
  function bestSubset(masks, nbits, maxSeeds = 60) {
    const seen = new Set(), seeds = [];
    masks.forEach((m, i) => {
      const c = popcount(m, nbits);
      const key = Array.from(m).join(',');
      if (c && !seen.has(key)) { seen.add(key); seeds.push({i, c}); }
    });
    seeds.sort((a, b) => b.c - a.c || a.i - b.i);
    let best = null;
    for (const {i: seed} of seeds.slice(0, maxSeeds)) {
      let shared = masks[seed], chosen = [seed], count = popcount(shared, nbits);
      const remaining = new Set(masks.keys());
      remaining.delete(seed);
      for (;;) {
        let pick = -1, pickCount = -1;
        for (const j of remaining) { const c = andCount(shared, masks[j], nbits); if (c > pickCount) { pickCount = c; pick = j; } }
        if (pick < 0 || (chosen.length + 1) * pickCount < chosen.length * count) break;
        shared = andMask(shared, masks[pick]); chosen.push(pick); remaining.delete(pick); count = pickCount;
      }
      const score = chosen.length * count;
      if (!best || score > best.score || (score === best.score && count > best.count)) best = {score, count, chosen};
    }
    return best ? {indices: best.chosen.sort((a, b) => a - b), trials: best.count} : {indices: [], trials: 0};
  }
  /** All-ones mask over nbits (bits beyond nbits stay clear). */
  function fullMask(nbits) {
    const out = new Uint8Array((nbits + 7) >> 3);
    for (let i = 0; i < nbits; i++) out[i >> 3] |= 1 << (i & 7);
    return out;
  }

  const VIRIDIS = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
  /** Heatmap colour: 'z' is diverging blue-neutral-red over [-2.5, 2.5]; 'peak' is viridis over [0, 1]. */
  function heatColor(v, norm, dark) {
    if (!Number.isFinite(v)) return dark ? [40, 44, 52] : [235, 236, 240];
    const lerp = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
    if (norm === 'z') {
      const t = Math.max(-1, Math.min(1, v / 2.5));
      const mid = dark ? [30, 34, 42] : [247, 247, 247];
      return t < 0 ? lerp(mid, [33, 102, 172], -t) : lerp(mid, [178, 24, 43], t);
    }
    const t = Math.max(0, Math.min(1, v)) * (VIRIDIS.length - 1);
    const i = Math.min(VIRIDIS.length - 2, Math.floor(t));
    return lerp(VIRIDIS[i], VIRIDIS[i + 1], t - i);
  }

  /** Rotate a 3D point by yaw (about y) then pitch (about x); returns [x, y, depth]. */
  function project3d(x, y, z, yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const x1 = cy * x + sy * z, z1 = -sy * x + cy * z;
    return [x1, cp * y - sp * z1, sp * y + cp * z1];
  }

  /** 32-bit FNV-1a hash of a string, as hex (cache keys). */
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16);
  }

  // ----------------------------------------------------------------- state
  function encodeState(state) {
    const json = JSON.stringify(state);
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeState(text) {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  }

  // ------------------------------------------------------ behavior timeline
  /**
   * Index the behavior payload: trials in session order, and each recorded event's
   * trial position; byTrial[p] lists trial p's events in time order.
   */
  function prepareBehavior(json) {
    const tr = json.trials, ev = json.events;
    const nT = tr.id.length, nE = ev.t.length;
    const pos = new Map(tr.id.map((id, i) => [id, i]));
    const col = (v, d = null) => v || tr.id.map(() => d);
    const trials = {n: nT, id: Int32Array.from(tr.id), start: Float64Array.from(tr.start), stop: Float64Array.from(tr.stop),
      complete: tr.complete, initiated: col(tr.initiated), task: col(tr.task), rewarded: col(tr.rewarded),
      microstim: col(tr.microstim), sham: col(tr.sham), success: col(tr.success), pos};
    const events = {n: nE, trial: Int32Array.from(ev.trial), t: Float64Array.from(ev.t), event: ev.event,
      rowId: Int32Array.from(ev.row_id || ev.t.map(() => -1)), tpos: new Int32Array(nE)};
    const byTrial = Array.from({length: nT}, () => []);
    for (let k = 0; k < nE; k++) {
      const p = pos.has(ev.trial[k]) ? pos.get(ev.trial[k]) : -1;
      events.tpos[k] = p;
      if (p >= 0) byTrial[p].push(k);
    }
    // Events arrive in time order (the payload order), for range queries.
    return {sessionId: json.session_id, trials, events, byTrial};
  }

  /** A /api/explorer/spiketrain payload as sorted session times (s): t[i] = tick_s * (dt[0] + … + dt[i]). */
  function decodeSpikeTrain(json) {
    const t = new Float64Array(json.dt.length);
    let tick = 0;
    for (let i = 0; i < t.length; i++) { tick += json.dt[i]; t[i] = tick * json.tick_s; }
    return t;
  }

  /**
   * Spikes of sorted times `t` in [t0, t1) counted into `width` equal columns
   * (the timeline's pixels).  `ref` is the 95th percentile of the non-empty
   * columns' counts, at least 1, so shading a column by min(1, count / ref)
   * gives plain ticks while spikes are sparser than a pixel and a density strip
   * once they are not.  `n` is the number of spikes in the range.
   */
  function spikeColumns(t, t0, t1, width) {
    const counts = new Uint32Array(Math.max(1, width));
    const i0 = lowerBound(t, t0), i1 = lowerBound(t, t1), scale = counts.length / Math.max(1e-12, t1 - t0);
    for (let i = i0; i < i1; i++) counts[Math.min(counts.length - 1, Math.floor((t[i] - t0) * scale))]++;
    const full = Array.from(counts).filter(c => c > 0).sort((a, b) => a - b);
    const ref = full.length ? Math.max(1, full[Math.min(full.length - 1, Math.floor(0.95 * full.length))]) : 1;
    return {counts, ref, n: i1 - i0};
  }

  /** Session time at a fractional trial position: linear between consecutive trial starts. */
  function timeAtPos(B, p) {
    const T = B.trials, n = T.n;
    if (!n) return 0;
    if (p <= 0) return T.start[0] + p * (n > 1 ? T.start[1] - T.start[0] : T.stop[0] - T.start[0]);
    if (p >= n) return T.stop[n - 1] + (p - n) * (T.stop[n - 1] - T.start[n - 1]);
    const i = Math.floor(p), f = p - i;
    const next = i + 1 < n ? T.start[i + 1] : T.stop[n - 1];
    return T.start[i] + f * (next - T.start[i]);
  }
  /** Inverse of timeAtPos. */
  function posAtTime(B, t) {
    const T = B.trials, n = T.n;
    if (!n) return 0;
    if (t <= T.start[0]) return (t - T.start[0]) / Math.max(1e-9, n > 1 ? T.start[1] - T.start[0] : T.stop[0] - T.start[0]);
    const i = Math.min(n - 1, upperBound(T.start, t) - 1);
    const next = i + 1 < n ? T.start[i + 1] : T.stop[n - 1];
    if (t >= next && i === n - 1) return n + (t - T.stop[n - 1]) / Math.max(1e-9, T.stop[n - 1] - T.start[n - 1]);
    return i + (t - T.start[i]) / Math.max(1e-9, next - T.start[i]);
  }
  function upperBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  /**
   * The visible span of the timeline: `count` trials centred on trial position
   * `centre`, clamped to the session (or the whole session when it is shorter).
   */
  function behaviorView(B, centre, count) {
    const n = B.trials.n, c = Math.max(1, Math.min(count, n));
    let a = centre - c / 2;
    a = Math.max(0, Math.min(a, n - c));
    return {a, b: a + c, t0: timeAtPos(B, a), t1: timeAtPos(B, a + c)};
  }

  /** Trial positions first..last (inclusive) whose centre p + 0.5 lies in the view's [a, b). */
  function viewTrials(B, V) {
    const n = B.trials.n;
    const first = Math.min(n - 1, Math.max(0, Math.ceil(V.a - 0.5 - 1e-6)));
    const last = Math.min(n - 1, Math.max(first, Math.ceil(V.b - 0.5 - 1e-6) - 1));
    return {first, last};
  }
  /**
   * The trials a raster yoked to the timeline keeps: the view's trials, widened to
   * at least `min` (or every trial there is) and placed as close to centred on
   * trial position `centre` as covering the whole view allows.
   */
  function yokedTrials(B, V, centre, min) {
    const n = B.trials.n;
    let {first, last} = viewTrials(B, V);
    const m = Math.min(min, n);
    if (last - first + 1 < m) {
      let s = Math.round(centre) - Math.floor((m - 1) / 2);
      s = Math.min(first, Math.max(last - m + 1, s));
      s = Math.min(n - m, Math.max(0, s));
      first = s; last = s + m - 1;
    }
    return {first, last};
  }

  // -------------------------------------------------------------- findings
  /** JSON with object keys sorted, so two equal values always compare equal. */
  function stableJSON(v) {
    if (Array.isArray(v)) return `[${v.map(stableJSON).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableJSON(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
  }
  /** The keys of a saved view state that came back different once the page applied it: [{key, saved, now}]. */
  function stateChanges(saved, applied) {
    return Object.keys(saved || {}).filter(k => stableJSON(saved[k]) !== stableJSON((applied || {})[k]))
      .map(k => ({key: k, saved: saved[k], now: (applied || {})[k]}));
  }
  const RATE_TOL = 1e-3;   // spikes/s; the saved rates are rounded to 4 decimals
  const FRACTION_TOL = 1e-3;
  const listed = (items, k = 5) => items.slice(0, k).join(', ') + (items.length > k ? ` and ${items.length - k} more` : '');
  /** What differs between two {id, peak_channel, area, quality, n_spikes} records of one unit ID, as phrases. */
  function unitDrift(a, b) {
    const out = [];
    if (a.peak_channel !== b.peak_channel) out.push(`peak channel ${a.peak_channel ?? '?'} → ${b.peak_channel ?? '?'}`);
    if (a.area !== b.area) out.push(`area ${a.area ?? '?'} → ${b.area ?? '?'}`);
    if (String(a.quality ?? '').toLowerCase() !== String(b.quality ?? '').toLowerCase()) out.push(`quality ${a.quality ?? '?'} → ${b.quality ?? '?'}`);
    if (a.n_spikes !== b.n_spikes) out.push(`${a.n_spikes ?? '?'} → ${b.n_spikes ?? '?'} spikes`);
    return out;
  }
  /**
   * A finding's saved evidence against the same measurement of the redrawn figure
   * (explorer.js evidence()): one sentence per difference in the data or the numbers,
   * the identity of the data first.  An empty list means the same data gave the same
   * numbers.  Settings the page could not restore are reported by stateChanges().
   */
  function compareEvidence(saved, now) {
    if (!saved || !now) return ['The finding has no saved evidence to compare with.'];
    const out = [];
    if (saved.session_id !== now.session_id) out.push(`It was saved from session ${saved.session_id}; the figure shows ${now.session_id}.`);
    const a = (saved.source || {}).sha256, b = (now.source || {}).sha256;
    if (a && b && a !== b) out.push(`The session.h5 is not the file it was saved from (SHA256 ${a.slice(0, 12)}… then, ${b.slice(0, 12)}… now): unit IDs may name other neurons.`);
    else if (a && !b) out.push('The server did not report the session file checksum, so the file cannot be matched.');
    if (saved.unit && now.unit) {
      if (saved.unit.id !== now.unit.id) out.push(`It was saved for unit ${saved.unit.id}; the figure shows unit ${now.unit.id}.`);
      else {
        const drift = unitDrift(saved.unit, now.unit);
        if (drift.length) out.push(`Unit ${saved.unit.id} is not the neuron it was saved for: ${drift.join(', ')}.`);
      }
    }
    if (saved.roster && now.roster) {
      const was = new Map(saved.roster.map(u => [u.id, u])), is = new Map(now.roster.map(u => [u.id, u]));
      const gone = [...was.keys()].filter(id => !is.has(id)), added = [...is.keys()].filter(id => !was.has(id));
      const moved = [...was.keys()].filter(id => is.has(id) && unitDrift(was.get(id), is.get(id)).length)
        .map(id => `${id} (${unitDrift(was.get(id), is.get(id)).join(', ')})`);
      if (gone.length) out.push(`Neurons in the saved population but not now: ${listed(gone)}.`);
      if (added.length) out.push(`Neurons in the population now but not when saved: ${listed(added)}.`);
      if (moved.length) out.push(`Neurons that are not the ones saved: ${listed(moved, 3)}.`);
    }
    const sv = saved.support || {}, nv = now.support || {};
    const tot = [['events', 'events'], ['trials', 'trials'], ['common_trials', 'trials shared by every neuron']]
      .filter(([k]) => sv[k] !== undefined && sv[k] !== nv[k]).map(([k, label]) => `${label} ${sv[k]} → ${nv[k] ?? '?'}`);
    if (tot.length) out.push(`Support changed: ${tot.join('; ')}.`);
    const key = g => `${g.label}${g.panel ? ` · ${g.panel}` : ''}`;
    const was = new Map((saved.groups || []).map(g => [key(g), g])), is = new Map((now.groups || []).map(g => [key(g), g]));
    for (const [k, g] of was) {
      const h = is.get(k);
      if (!h) { out.push(`Group “${k}” is not in the redrawn figure.`); continue; }
      const bits = [];
      if (g.events !== h.events) bits.push(`${g.events} → ${h.events} events`);
      if (g.trials !== h.trials) bits.push(`${g.trials} → ${h.trials} trials`);
      if (Number.isFinite(g.rate_hz) && !(Math.abs(g.rate_hz - h.rate_hz) <= RATE_TOL)) bits.push(`${fmtNum(g.rate_hz, 2)} → ${fmtNum(h.rate_hz, 2)} spikes/s in the count window`);
      if (bits.length) out.push(`“${k}”: ${bits.join(', ')}.`);
    }
    const fresh = [...is.keys()].filter(k => !was.has(k));
    if (fresh.length) out.push(`Groups that were not in the saved figure: ${listed(fresh.map(k => `“${k}”`))}.`);
    const sf = saved.fit, nf = now.fit;
    if (sf && nf) {
      if (stableJSON(sf.dropped_constant_units || []) !== stableJSON(nf.dropped_constant_units || []))
        out.push(`Neurons left out of the fit as constant: ${listed(sf.dropped_constant_units || []) || 'none'} → ${listed(nf.dropped_constant_units || []) || 'none'}.`);
      if (sf.rank !== nf.rank) out.push(`Fit rank ${sf.rank} → ${nf.rank}.`);
      if (sf.converged !== false && nf.converged === false) out.push('The fit no longer converges.');
      const newWarnings = (nf.warnings || []).filter(w => !(sf.warnings || []).includes(w));
      if (newWarnings.length) out.push(`New fit warnings: ${listed(newWarnings, 3)}.`);
      for (const [k, label] of [['explained_variance_ratio', 'variance explained'], ['component_r2', 'R²']]) {
        const x = sf[k], y = nf[k];
        if (!Array.isArray(x) || !Array.isArray(y)) continue;
        const diff = x.map((v, i) => (Math.abs(v - y[i]) > FRACTION_TOL || !Number.isFinite(y[i]) ? `component ${i + 1} ${fmtNum(100 * v, 1)}% → ${Number.isFinite(y[i]) ? fmtNum(100 * y[i], 1) : '?'}%` : null)).filter(Boolean);
        if (diff.length) out.push(`${label[0].toUpperCase()}${label.slice(1)} changed: ${listed(diff, 3)}.`);
      }
    }
    return out;
  }
  /** Does a finding match every word of a search?  Title, note, tags, status, session, unit, channel, alignment, host. */
  function findingMatches(f, text) {
    const words = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const st = f.state || {}, ev = f.evidence || {}, u = ev.unit || {};
    const hay = [f.title, f.note, ...(f.tags || []), f.status, st.session, `unit ${st.unit}`, u.peak_channel !== undefined && u.peak_channel !== null ? `ch ${u.peak_channel}` : '',
      u.area, st.align, humanize(st.align || ''), st.mode, ev.title, f.saved_on, f.saved_at].filter(Boolean).join(' \n ').toLowerCase();
    return words.every(w => hay.includes(w));
  }

  return {GUARD_S, MISSING, SEP, FIELD_LABELS, LEVEL_ORDER, fieldLabel, formatLevel, fmtNum, humanize, levelKey,
    prepareBehavior, decodeSpikeTrain, spikeColumns, timeAtPos, posAtTime, behaviorView, viewTrials, yokedTrials, upperBound,
    prepareTable, rawValue, fieldLevels, filterMask, eligibility, quantileEdges, groupRows, indexEvents,
    markerTimes, median, countIn, lowerBound, psthGrid, rowCurve, psth, psthFromCurves, thin, windowRates, sortRows, encodeState, decodeState,
    decodeMask, andMask, andCount, popcount, fullMask, bestSubset, heatColor, project3d, hash,
    stableJSON, stateChanges, compareEvidence, findingMatches};
});
