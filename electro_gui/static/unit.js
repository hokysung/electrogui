'use strict';
/* electro_gui unit page: everything that characterises one unit, with no setup. One URL per unit:
 *   /unit.html#session=<id>&sorting=<name or empty>&unit=<id>[&trial=<id>][&back=<url>]
 * Every number is computed here from the session's own data (core.js helpers + /api/explorer/*). */
(function () {
  const C = window.EGCore;
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }

  // ----------------------------------------------------------------- rules
  const MAX_LEN_S = 8;          // trial_rasters MAX_LEN_S: longer trials are paused / aborted
  const PRE = 0.5, POST = 1.5;  // shown before trial start / after the trial's end (RASTER_PRE_S, RASTER_POST_S)
  const BIN = 0.02, SIGMA = 0.05, MIN_N = 20;   // POP_BIN_S, POP_SMOOTH_S, POP_MIN_BIN_TRIALS
  const STIM_WIN = [-0.4, 0.9], COUNT_AFTER = [0.005, 0.205], BASE = [-0.3, -0.05];
  const TASKS = [
    {key: 'memory_saccade', short: 'MS', label: 'Memory saccade', color: '#1971c2'},
    {key: 'pursuit', short: 'SP', label: 'Smooth pursuit', color: '#2f9e44'},
    {key: 'pursuit_memory', short: 'PM', label: 'Pursuit memory', color: '#c2255c'},
  ];
  const TASK_BY = Object.fromEntries(TASKS.map(t => [t.key, t]));
  const STIM_C = '#e8590c', SHAM_C = '#495057';   // explorer.js SEM.stim_condition
  const EV = {fix_on: '#0c8599', stimuli_on: '#7048e8', response: '#e03131', reward: '#e69f00', end: '#c2188f'};
  const QUALITIES = ['sua', 'mua'];

  // ----------------------------------------------------------------- theme
  const THEME_KEY = 'eg-theme';
  let TH = {};
  function themePref() { let p = null; try { p = localStorage.getItem(THEME_KEY); } catch (e) { /* private mode */ } return ['light', 'dark', 'auto'].includes(p) ? p : 'light'; }
  const isDark = () => document.documentElement.dataset.theme === 'dark';
  function mix(hex, other, a) {
    const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const x = p(hex), y = p(other);
    return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * a).toString(16).padStart(2, '0')).join('');
  }
  const paint = hex => (isDark() ? mix(hex, '#ffffff', 0.18) : hex);
  function alpha(hex, a) { const p = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); return `rgba(${p[0]},${p[1]},${p[2]},${a})`; }
  function readColors() {
    const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
    TH = {ink: v('--fig-ink'), muted: v('--fig-muted'), grid: v('--fig-grid'), axis: v('--fig-axis'), bg: v('--fig-bg'),
      accent: v('--accent'), font: getComputedStyle(document.body).fontFamily};
  }
  function applyTheme() {
    const p = themePref();
    const dark = p === 'dark' || (p === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('themeBtn').textContent = {light: '☀ Light', dark: '☾ Dark', auto: '◐ Auto'}[p];
    readColors();
    redrawAll();
  }
  $('themeBtn').addEventListener('click', () => {
    const next = {light: 'dark', dark: 'auto', auto: 'light'}[themePref()];
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode */ }
    applyTheme();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePref() === 'auto') applyTheme(); });

  // ----------------------------------------------------------------- state
  let TOKEN = 0;
  let CUR = {session: '', sorting: '', unit: ''};
  let SESS = null;      // the open session: {key, summary, T, byId, ...}
  let U = null;         // the open unit
  let pinned = null;    // trial id
  const VIEWS = [];     // every drawn plot, for redraws
  let redrawTimer = 0;

  const fmt = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Number(v).toFixed(d));
  const int = v => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
  const secs = (v, d = 2) => (Number.isFinite(v) ? `${v.toFixed(d)} s` : '—');
  const plural = (n, w) => `${int(n)} ${w}${n === 1 ? '' : 's'}`;

  async function getJSON(path, options) {
    let r;
    try { r = await fetch(path, options); } catch (e) { throw new Error('Cannot reach electro_gui (is the server running?).'); }
    const body = await r.json().catch(() => ({error: `HTTP ${r.status}`}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }
  const q = obj => Object.entries(obj).filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  // --------------------------------------------------------------- address
  function params() {
    const p = new URLSearchParams(location.hash.slice(1));
    return {session: p.get('session') || '', sorting: p.get('sorting') || '', unit: p.get('unit') || '', trial: p.get('trial') || '', back: p.get('back') || ''};
  }
  function hashOf(P) {
    const p = new URLSearchParams();
    p.set('session', P.session); p.set('sorting', P.sorting || ''); p.set('unit', P.unit);
    if (P.trial) p.set('trial', P.trial);
    if (P.back) p.set('back', P.back);
    return p.toString();
  }
  function safeBack(url) {
    if (!url) return null;
    try { const u = new URL(url, location.href); return ['http:', 'https:', 'file:'].includes(u.protocol) ? u.href : null; } catch (e) { return null; }
  }
  const traceHref = (trial, unit = CUR.unit) => `/trace.html#${new URLSearchParams({session: CUR.session, sorting: CUR.sorting || '', unit: String(unit), trial: String(trial)})}`;
  const explorerHref = unit => `/#s=${C.encodeState({session: CUR.session, sorting: CUR.sorting || null, unit: Number(unit)})}`;

  // ------------------------------------------------------------ canvas bits
  function fit(cv, w, h) {
    const d = window.devicePixelRatio || 1;
    cv.style.height = h + 'px';
    cv.width = Math.max(1, Math.round(w * d)); cv.height = Math.max(1, Math.round(h * d));
    const g = cv.getContext('2d');
    g.setTransform(d, 0, 0, d, 0, 0);
    return g;
  }
  function niceStep(range, n) {
    const raw = range / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }
  const niceMax = v => { if (!(v > 0)) return 1; const s = niceStep(v, 3); return Math.ceil(v / s - 1e-9) * s; };
  function xTicks(a, b) {
    const range = b - a, s = range <= 3 ? 0.5 : range <= 6 ? 1 : range <= 14 ? 2 : niceStep(range, 7);
    const out = [];
    for (let v = Math.ceil(a / s - 1e-9) * s; v <= b + 1e-9; v += s) out.push(Math.abs(v) < 1e-9 ? 0 : +v.toFixed(6));
    return out;
  }
  const tickText = v => (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(1));

  /** A plot: a base canvas (data) and an overlay (hover, pinned trial). Rows (trial ids top to bottom) make it a raster. */
  class Plot {
    constructor(host, o) {
      this.o = o;
      this.wrap = el('div', 'u-stack');
      this.base = el('canvas'); this.ov = el('canvas', 'ov');
      this.base.style.width = '100%'; this.ov.style.width = '100%';
      this.wrap.append(this.base, this.ov);
      host.append(this.wrap);
      this.hk = -1;
      this.rows = o.rows || null;
      if (this.rows) {
        this.index = new Map();
        this.rows.forEach((id, k) => { if (id !== null) { if (!this.index.has(id)) this.index.set(id, []); this.index.get(id).push(k); } });
        this.ov.addEventListener('pointermove', e => this.hover(e));
        this.ov.addEventListener('pointerleave', () => this.leave());
        this.ov.addEventListener('click', e => { this.hover(e); const id = this.rows[this.hk]; if (id !== undefined && id !== null) setPin(id === pinned ? null : id, true); });
      }
      if (o.hover) {
        this.ov.style.cursor = 'crosshair';
        this.ov.addEventListener('pointermove', e => o.hover(this, e));
        this.ov.addEventListener('pointerleave', () => o.hover(this, null));
      }
      VIEWS.push(this);
    }
    layout() {
      const o = this.o;
      this.w = Math.max(160, Math.floor(this.wrap.clientWidth)); this.h = o.height;
      this.l = o.left ?? 44; this.r = this.w - (o.right ?? 8); this.t = o.top ?? 4; this.b = this.h - (o.bottom ?? 4);
      this.xmin = o.xmin; this.xmax = o.xmax;
      this.ymin = o.ymin ?? 0; this.ymax = o.ymax ?? 1;
    }
    X(t) { return this.l + (t - this.xmin) / (this.xmax - this.xmin) * (this.r - this.l); }
    Y(v) { return this.b - (v - this.ymin) / (this.ymax - this.ymin) * (this.b - this.t); }
    get rh() { return (this.b - this.t) / Math.max(1, this.rows.length); }
    draw() {
      this.layout();
      this.g = fit(this.base, this.w, this.h);
      this.o.paint(this.g, this);
      this.drawOverlay();
    }
    rowAt(e) {
      const rect = this.ov.getBoundingClientRect(), y = e.clientY - rect.top;
      const k = Math.floor((y - this.t) / this.rh);
      return k >= 0 && k < this.rows.length && this.rows[k] !== null ? k : -1;
    }
    hover(e) {
      const k = this.rowAt(e);
      if (k !== this.hk) { this.hk = k; this.drawOverlay(); }
      if (k < 0) { showTip(null); return; }
      showTip(tipText(this.rows[k]), e.clientX, e.clientY);
    }
    leave() { if (this.hk !== -1) { this.hk = -1; this.drawOverlay(); } showTip(null); }
    drawOverlay() {
      if (!this.w) return;
      const g = fit(this.ov, this.w, this.h);
      if (this.rows) {
        const rh = this.rh, band = (k, fill, min) => { const h = Math.max(rh, min); g.fillStyle = fill; g.fillRect(this.l, this.t + k * rh + rh / 2 - h / 2, this.r - this.l, h); };
        if (this.hk >= 0) band(this.hk, alpha(TH.ink.length === 7 ? TH.ink : '#888888', 0.16), 2);
        if (pinned !== null && this.index.has(pinned)) {
          for (const k of this.index.get(pinned)) {
            band(k, alpha(paint('#3b5bdb'), 0.30), 3);
            g.fillStyle = TH.accent;
            g.fillRect(this.l - 5, this.t + k * rh + rh / 2 - 1.5, 5, 3);
            g.fillRect(this.r, this.t + k * rh + rh / 2 - 1.5, 5, 3);
            g.fillRect(this.l, this.t + k * rh + rh / 2 - Math.max(rh, 3) / 2, this.r - this.l, 1);
            g.fillRect(this.l, this.t + k * rh + rh / 2 + Math.max(rh, 3) / 2 - 1, this.r - this.l, 1);
          }
        }
      }
      if (this.o.overlay) this.o.overlay(g, this);
    }
  }
  function redrawAll() { for (const v of VIEWS) { try { v.draw(); } catch (e) { console.error(e); } } }
  function overlaysAll() { for (const v of VIEWS) v.drawOverlay(); }
  let lastW = 0;
  new ResizeObserver(() => {
    const w = $('main').clientWidth;
    if (Math.abs(w - lastW) < 2) return;
    lastW = w;
    clearTimeout(redrawTimer); redrawTimer = setTimeout(redrawAll, 120);
  }).observe($('main'));

  // axes and text -----------------------------------------------------------------
  function text(g, s, x, y, o = {}) {
    g.font = `${o.size || 11}px ${TH.font}`; g.fillStyle = o.color || TH.muted; g.textAlign = o.align || 'left'; g.textBaseline = o.base || 'alphabetic';
    g.fillText(s, x, y);
  }
  function gridX(g, P, ticks, labels) {
    g.lineWidth = 1;
    for (const v of ticks) {
      const x = Math.round(P.X(v)) + 0.5;
      g.strokeStyle = v === 0 ? TH.axis : TH.grid; g.beginPath(); g.moveTo(x, P.t); g.lineTo(x, P.b); g.stroke();
      if (labels) text(g, tickText(v), x, P.b + 13, {align: 'center'});
    }
  }
  function axisY(g, P, unit) {
    const top = P.ymax, ticks = [0, top / 2, top];
    for (const v of ticks) {
      const y = Math.round(P.Y(v)) + 0.5;
      g.strokeStyle = TH.grid; g.lineWidth = 1; g.beginPath(); g.moveTo(P.l, y); g.lineTo(P.r, y); g.stroke();
      text(g, v >= 10 ? v.toFixed(0) : v === 0 ? '0' : v.toFixed(1), P.l - 4, y + 3.5, {align: 'right'});
    }
    if (unit) text(g, unit, P.l - 4, P.t - 4, {align: 'right'});
  }
  function curve(g, P, xs, ys, color, width = 1.6, n = xs.length) {
    g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round'; g.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(ys[i])) { pen = false; continue; }
      const x = P.X(xs[i]), y = P.Y(ys[i]);
      if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
    }
    g.stroke();
  }
  function band(g, P, xs, lo, hi, color) {
    g.fillStyle = color; g.beginPath(); let started = false, last = -1;
    for (let i = 0; i < xs.length; i++) { if (!Number.isFinite(hi[i])) continue; const x = P.X(xs[i]), y = P.Y(hi[i]); if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y); last = i; }
    for (let i = last; i >= 0; i--) { if (!Number.isFinite(lo[i])) continue; g.lineTo(P.X(xs[i]), P.Y(lo[i])); }
    g.closePath(); g.fill();
  }

  // ------------------------------------------------------------ tooltip, pin
  const tip = $('tip');
  function showTip(html, x, y) {
    if (!html) { tip.hidden = true; return; }
    tip.innerHTML = html; tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = clamp(x + 14, 4, innerWidth - w - 4) + 'px';
    tip.style.top = clamp(y + 16 > innerHeight - h - 4 ? y - h - 10 : y + 16, 4, innerHeight - h - 4) + 'px';
  }
  function trialDesc(id) {
    const T = SESS && SESS.byId.get(id);
    if (!T) return {task: '?', cond: null, bits: [`trial ${id}`]};
    const task = TASK_BY[T.task] ? TASK_BY[T.task].short : T.task || '?';
    const cond = T.train && T.train.cond ? T.train.cond : null;
    const bits = [`trial ${id}`, task, cond || (T.micro || T.sham ? (T.micro ? 'stim (connectivity)' : 'sham (connectivity)') : 'no train'),
      T.rewarded === true ? 'rewarded' : T.rewarded === false ? 'not rewarded' : null, `length ${secs(T.len)}`].filter(Boolean);
    return {task, cond, bits};
  }
  const tipText = id => trialDesc(id).bits.map(esc).join(' · ') + '<br><span style="color:var(--muted)">click to pin</span>';

  function setPin(id, write) {
    pinned = id === null || id === undefined || Number.isNaN(id) ? null : id;
    if (write) {
      const P = params(); P.trial = pinned === null ? '' : String(pinned);
      try { history.replaceState(null, '', location.pathname + '#' + hashOf(P)); } catch (e) { /* hash too long */ }
    }
    renderPin();
    overlaysAll();
  }
  function renderPin() {
    const bar = $('pinBar');
    if (pinned === null) { bar.hidden = true; bar.innerHTML = ''; return; }
    const d = trialDesc(pinned);
    let why = '';
    if (U) {
      const T = SESS.byId.get(pinned);
      if (!T) why = 'not a trial of this session';
      else if (!TASK_BY[T.task]) why = `${T.task || 'non-task'} trial: not in the task rasters`;
      else if (U.reason.get(pinned) && U.reason.get(pinned) !== 'ok') why = 'left out of the rasters: ' + REASON_TEXT[U.reason.get(pinned)];
    }
    bar.hidden = false;
    bar.innerHTML = `<span class="u-chip"><b>Pinned</b> ${d.bits.map(esc).join(' · ')}${why ? ` <span class="u-note" style="margin:0">(${esc(why)})</span>` : ''}<button type="button" id="unpin" aria-label="Unpin trial" title="Unpin (Esc)">×</button></span>`
      + `<a class="tr-btn" id="rawBtn" href="${esc(traceHref(pinned))}" target="_blank" rel="noopener" title="Open this unit's spikes on the raw voltage traces of this trial (read from the cluster; the first load takes a few seconds)">Raw traces ↗</a>`;
    $('unpin').addEventListener('click', () => setPin(null, true));
  }

  // ---------------------------------------------------------------- loading
  function showMsg(kind, html) {
    const m = $('msg');
    if (!kind) { m.hidden = true; m.textContent = ''; return; }
    m.hidden = false; m.className = 'tr-msg-inline' + (kind === 'err' ? ' err' : '');
    m.innerHTML = (kind === 'load' ? '<span class="tr-spin"></span>' : '') + html;
  }

  async function openSession(P, token) {
    const key = `${P.session}|${P.sorting}`;
    if (SESS && SESS.key === key) return SESS;
    showMsg('load', `Opening ${esc(P.session)}${P.sorting ? ' · ' + esc(P.sorting) : ''}. The first open of a session reads its session.h5, which can take a few seconds.`);
    const job = await getJSON('/api/jobs', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action: 'load', session_id: P.session, ...(P.sorting ? {sorting: P.sorting} : {})})});
    for (;;) {
      const j = await getJSON(`/api/jobs/${job.id}`);
      if (token !== TOKEN) return null;
      if (j.status === 'error') throw new Error(j.error || 'The session did not load.');
      if (j.status === 'done') break;
      await sleep(500);
    }
    const base = q({session: P.session, sorting: P.sorting});
    const [summary, beh, trains] = await Promise.all([getJSON(`/api/explorer/session?${base}`), getJSON(`/api/explorer/behavior?${base}`), getJSON(`/api/explorer/stimtrains?${base}`)]);
    if (token !== TOKEN) return null;
    SESS = buildSession(key, P, summary, beh, trains);
    return SESS;
  }

  function buildSession(key, P, summary, beh, trains) {
    const tr = beh.trials, ev = beh.events;
    const T = [], byId = new Map();
    for (let i = 0; i < tr.id.length; i++) {
      const t = {id: tr.id[i], start: tr.start[i], stop: tr.stop[i], len: tr.stop[i] - tr.start[i], complete: tr.complete[i] === true, task: tr.task[i],
        rewarded: tr.rewarded[i], micro: tr.microstim[i] === true, sham: tr.sham[i] === true, ev: {}, train: null};
      T.push(t); byId.set(t.id, t);
    }
    for (let k = 0; k < ev.t.length; k++) { const t = byId.get(ev.trial[k]); if (t && !(ev.event[k] in t.ev)) t.ev[ev.event[k]] = ev.t[k]; }
    for (let i = 0; i < trains.n; i++) {
      const t = byId.get(trains.trial[i]);
      if (t) t.train = {on: trains.t[i], dur: trains.dur_s[i], cond: trains.condition[i], conn: trains.connectivity[i]};
    }
    T.sort((a, b) => a.start - b.start || a.id - b.id);
    const units = summary.units.slice().sort((a, b) => a.id - b.id);
    return {key, session: P.session, sorting: P.sorting, summary, T, byId, units, unitMap: new Map(units.map(u => [u.id, u])), duration: summary.duration_s,
      hasStim: T.some(t => TASK_BY[t.task] && t.train && t.train.cond && !t.train.conn)};
  }

  const listed = () => SESS.units.filter(u => QUALITIES.includes(String(u.quality).toLowerCase()));

  async function loadAll() {
    const token = ++TOKEN;
    const P = params(); CUR = P;
    VIEWS.length = 0; $('main').textContent = ''; showTip(null);
    $('head').hidden = false;
    renderBack(P);
    if (!P.session) {
      $('title').textContent = 'Unit page'; $('meta').textContent = ''; $('stats').textContent = '';
      showMsg('err', 'The address needs a session and a unit: <code>/unit.html#session=…&amp;sorting=…&amp;unit=…</code>. Open this page from a report link or from the explorer\'s “Unit page” link.');
      return;
    }
    $('title').textContent = `Unit ${P.unit || ''}`; $('meta').textContent = `${P.session}${P.sorting ? ' · ' + P.sorting : ' · default sorting'}`; $('stats').textContent = ''; $('headNote').textContent = '';
    document.title = `unit ${P.unit} · ${P.session}`;
    $('explorerLink').href = P.unit ? explorerHref(P.unit) : '/';
    try {
      const S = await openSession(P, token);
      if (!S || token !== TOKEN) return;
      let unit = parseInt(P.unit, 10);
      if (!S.unitMap.has(unit)) {
        const first = (listed()[0] || S.units[0]);
        if (P.unit) { fillPicker(S, first.id); throw new Error(`Unit ${P.unit} is not in ${P.session}${P.sorting ? ' · ' + P.sorting : ' (default sorting)'}. Pick a unit above.`); }
        unit = first.id; P.unit = String(unit); CUR = P;
        try { history.replaceState(null, '', location.pathname + '#' + hashOf(P)); } catch (e) { /* ignore */ }
      }
      fillPicker(S, unit);
      $('explorerLink').href = explorerHref(unit);
      document.title = `unit ${unit} · ${P.session}`;
      showMsg('load', `Reading unit ${unit}.`);
      const base = q({session: P.session, sorting: P.sorting, unit});
      const [info, st] = await Promise.all([getJSON(`/api/explorer/unitinfo?${base}`), getJSON(`/api/explorer/spiketrain?${base}`)]);
      if (token !== TOKEN) return;
      U = buildUnit(S, unit, info, C.decodeSpikeTrain(st));
      showMsg(null);
      renderHead();
      renderMain();
      setPin(P.trial !== '' && Number.isFinite(parseInt(P.trial, 10)) ? parseInt(P.trial, 10) : null, false);
    } catch (e) {
      if (token !== TOKEN) return;
      U = null; $('main').textContent = '';
      showMsg('err', esc(e.message || String(e)));
    }
  }

  function renderBack(P) {
    const a = $('backLink'), href = safeBack(P.back);
    a.hidden = !href;
    if (href) a.href = href;
  }

  function fillPicker(S, current) {
    const sel = $('unitSel'), list = listed();
    const items = list.some(u => u.id === current) || !S.unitMap.has(current) ? list : [S.unitMap.get(current), ...list].sort((a, b) => a.id - b.id);
    sel.innerHTML = items.map(u => `<option value="${u.id}">${u.id} · ${esc(String(u.quality).toLowerCase())} · ch ${u.peak_channel ?? '?'} · ${fmt(u.n_spikes / Math.max(1, S.duration), 1)} Hz</option>`).join('');
    if (S.unitMap.has(current)) sel.value = String(current);
    const idx = list.findIndex(u => u.id > current);   // first listed unit after `current`
    const prev = idx < 0 ? list[list.length - 1] : idx > 0 ? list[idx - 1] : null;
    const cur = list.findIndex(u => u.id === current);
    const next = cur >= 0 ? list[cur + 1] : list[idx];
    const before = cur >= 0 ? list[cur - 1] : prev;
    $('prevUnit').disabled = !before; $('nextUnit').disabled = !next;
    $('prevUnit').dataset.id = before ? before.id : ''; $('nextUnit').dataset.id = next ? next.id : '';
    $('prevUnit').title = before ? `Previous unit: ${before.id} (←)` : 'No previous unit';
    $('nextUnit').title = next ? `Next unit: ${next.id} (→)` : 'No next unit';
  }
  function goUnit(id) {
    if (!id && id !== 0) return;
    const P = params(); P.unit = String(id);
    location.hash = hashOf(P);
  }
  $('unitSel').addEventListener('change', e => goUnit(e.target.value));
  $('prevUnit').addEventListener('click', () => goUnit($('prevUnit').dataset.id));
  $('nextUnit').addEventListener('click', () => goUnit($('nextUnit').dataset.id));
  addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target && e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
    if (e.key === 'ArrowLeft' && !$('prevUnit').disabled) { e.preventDefault(); goUnit($('prevUnit').dataset.id); }
    else if (e.key === 'ArrowRight' && !$('nextUnit').disabled) { e.preventDefault(); goUnit($('nextUnit').dataset.id); }
    else if (e.key === 'Escape' && pinned !== null) setPin(null, true);
  });
  addEventListener('hashchange', () => {
    const P = params();
    if (P.session !== CUR.session || P.sorting !== CUR.sorting || P.unit !== CUR.unit || P.back !== CUR.back) { loadAll(); return; }
    CUR = P;
    const id = parseInt(P.trial, 10);
    setPin(Number.isFinite(id) ? id : null, false);
  });

  // ------------------------------------------------------------- unit data
  const REASON_TEXT = {incomplete: 'not completed', outside: 'outside the recording', long: `longer than ${MAX_LEN_S} s`, unstable: 'not stable for this unit', ok: 'shown'};

  function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
  /** Spikes of the unit in [t + lo, t + hi), relative to t, as a sorted Float64Array. */
  function relSpikes(t, lo, hi) {
    const sp = U.sp, a = lowerBound(sp, t + lo), b = lowerBound(sp, t + hi);
    const out = new Float64Array(b - a);
    for (let i = a; i < b; i++) out[i - a] = sp[i] - t;
    return out;
  }

  function buildUnit(S, unit, info, sp) {
    const stable = new Set(info.stable);
    const reason = new Map(), counts = {task: 0, incomplete: 0, outside: 0, long: 0, unstable: 0, ok: 0};
    const base = [];   // task trials that pass every rule but stability: the fixed list the odd/even halves are cut from
    for (const T of S.T) {
      if (!TASK_BY[T.task]) continue;
      counts.task++;
      let r = 'ok';
      if (!T.complete) r = 'incomplete';
      else if (!(T.start - PRE >= 0 && T.stop + POST <= S.duration && 'trial_start' in T.ev)) r = 'outside';
      else if (!(T.len > 0 && T.len <= MAX_LEN_S)) r = 'long';
      else base.push(T);
      if (r === 'ok') { if (!stable.has(T.id)) r = 'unstable'; }
      counts[r]++; reason.set(T.id, r);
    }
    base.forEach((T, i) => { T.half = i % 2 === 0 ? 'odd' : 'even'; });   // 1st, 3rd, ... trial are the odd ones
    const shown = base.filter(T => stable.has(T.id));
    const qc = info.qc || {};
    return {S, unit, info, sp, stable, reason, counts, base, shown, qc, meta: S.unitMap.get(unit), rel: new Map()};
  }

  // ------------------------------------------------------------------ head
  function renderHead() {
    const u = U.meta, qc = U.qc, S = U.S;
    const t = $('title'); t.textContent = '';
    t.append(`Unit ${U.unit} `);
    const chips = [String(u.quality || '').toLowerCase()];
    for (const c of [qc.bc_unit_type, qc.manual_label]) if (c && !chips.includes(String(c).toLowerCase())) chips.push(String(c).toLowerCase());
    chips.forEach((c, i) => { const s = el('span', 'tq ' + c); s.textContent = i === 0 ? c : (i === 1 && c === String(qc.bc_unit_type || '').toLowerCase() ? `BombCell ${c}` : `label ${c}`); s.title = i === 0 ? 'quality in this export' : 'another label of this unit'; t.append(s, ' '); });
    $('meta').textContent = [S.session, S.sorting ? `sorting ${S.sorting}` : 'default sorting', u.area || 'area ?', `peak channel ${u.peak_channel ?? '?'}`,
      u.depth_um != null ? `depth ${Math.round(u.depth_um)} µm` : null, qc.source_unit_id != null && qc.source_unit_id !== U.unit ? `sorter unit ${qc.source_unit_id}` : null].filter(Boolean).join(' · ');
    const nStable = [...U.stable].filter(id => S.byId.has(id) && S.byId.get(id).complete).length;
    const dd = (k, v, small) => `<div><dt>${esc(k)}</dt><dd>${v}${small ? ` <small>${small}</small>` : ''}</dd></div>`;
    $('stats').innerHTML = [
      dd('mean rate', `${fmt(u.n_spikes / S.duration, 2)} Hz`, 'spikes ÷ session'),
      dd('spikes', int(u.n_spikes)),
      dd('stable trials', `${int(nStable)} <small>of ${int(U.info.n_complete)}</small>`),
      dd('SNR', fmt(qc.snr, 2)),
      dd('ISI violations', fmt(qc.isi_violations_ratio, 3)),
      dd('presence', fmt(qc.presence_ratio, 2)),
      dd('amplitude', fmt(qc.amplitude_median, 1), 'median'),
    ].join('');
    $('headNote').textContent = '';
  }

  // -------------------------------------------------------------- sections
  function section(title, sub) {
    const s = el('section', 'tr-card u-sec');
    s.innerHTML = `<h2>${esc(title)}</h2>${sub ? `<div class="u-sub">${sub}</div>` : ''}`;
    $('main').append(s);
    return s;
  }
  function legend(host, items) {
    const d = el('div', 'tr-legend');
    d.innerHTML = items.map(i => `<span><i class="${i.kind || ''}" style="background:${i.color}"></i>${esc(i.label)}</span>`).join('');
    host.append(d);
    return d;
  }
  function note(host, html, cls) { const d = el('div', 'u-note' + (cls ? ' ' + cls : ''), html); host.append(d); return d; }

  function renderMain() {
    const main = $('main'); main.textContent = '';
    VIEWS.length = 0;
    sectionWhole();
    if (U.S.hasStim) sectionStim();
    sectionEvents();
    sectionSession();
    sectionStats();
    sectionFigures();
    redrawAll();
  }

  // ----------------------------------------------------------- 2. whole trial
  function gaussNearest(a, sigma) {
    const rad = Math.floor(4 * sigma + 0.5), k = new Float64Array(2 * rad + 1);
    let s = 0;
    for (let i = 0; i < k.length; i++) { k[i] = Math.exp(-0.5 * ((i - rad) / sigma) ** 2); s += k[i]; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    const n = a.length, out = new Float64Array(n);
    for (let i = 0; i < n; i++) { let acc = 0; for (let j = 0; j < k.length; j++) acc += k[j] * a[clamp(i + j - rad, 0, n - 1)]; out[i] = acc; }
    return out;
  }
  /** Trial-averaged rate from trial start: 20 ms bins; a trial counts in a bin while it is running (to its end + 1.5 s);
   *  NaN where fewer than minN trials run; Gaussian-smoothed (50 ms) over the finite bins. Returns {rate, nb} */
  function rateMap(trs, nbMax, minN) {
    const cnt = new Float64Array(nbMax), n = new Float64Array(nbMax);
    for (const T of trs) {
      const nv = Math.min(nbMax, Math.floor((T.len + POST + PRE) / BIN + 1e-9));
      for (let b = 0; b < nv; b++) n[b]++;
      const s = trialSpikes(T);
      for (let i = 0; i < s.length; i++) { const b = Math.floor((s[i] + PRE) / BIN); if (b >= 0 && b < nv) cnt[b]++; }
    }
    const raw = new Float64Array(nbMax).fill(NaN);
    let nb = 0;
    for (let b = 0; b < nbMax; b++) if (n[b] >= minN) { raw[b] = cnt[b] / n[b] / BIN; nb = b + 1; }
    const fin = raw.subarray(0, nb);
    const sm = nb ? gaussNearest(fin, SIGMA / BIN) : new Float64Array(0);
    const rate = new Float64Array(nbMax).fill(NaN);
    rate.set(sm);
    return {rate, nb};
  }
  function peakOf(rate, nb) {
    let best = -Infinity, at = -1;
    for (let b = 0; b < nb; b++) if (rate[b] > best) { best = rate[b]; at = b; }
    return at < 0 ? null : {t: -PRE + (at + 0.5) * BIN, hz: best};
  }
  /** One shown trial's spikes from PRE before its start to POST after its end, relative to its start. */
  function trialSpikes(T) {
    let r = U.rel.get(T.id);
    if (!r) { r = relSpikes(T.start, -PRE, T.len + POST); U.rel.set(T.id, r); }
    return r;
  }

  function sectionWhole() {
    const shown = U.shown, c = U.counts;
    const sec = section('Whole trial, every trial',
      `<b>${int(shown.length)}</b> of ${int(c.task)} task trials are shown (stable for this unit, completed, inside the recording, at most ${MAX_LEN_S} s). Left out: `
      + `${int(c.unstable)} not stable for this unit, ${int(c.long)} longer than ${MAX_LEN_S} s, ${int(c.incomplete)} not completed, ${int(c.outside)} outside the recording. `
      + `Trials start at the top of the window at 0 s and are sorted by length, shortest at the bottom.`);
    if (!shown.length) { note(sec, 'No trial is left for this unit, so there is no whole-trial raster.', 'warn'); return; }
    legend(sec, [
      {kind: 'dot', color: 'var(--fig-ink)', label: 'spike'},
      {kind: 'tick', color: paintVar(EV.fix_on), label: 'fixation on'}, {kind: 'tick', color: paintVar(EV.stimuli_on), label: 'target on'},
      {kind: 'tick', color: paintVar(EV.response), label: 'response (saccade; pursuit start in SP)'}, {kind: 'tick', color: paintVar(EV.reward), label: 'reward start'},
      {kind: 'tick', color: paintVar(EV.end), label: 'trial end'}, {color: alpha(STIM_C, 0.55), label: 'stim train'}, {color: alpha(SHAM_C, 0.45), label: 'sham train'},
      ...TASKS.map(t => ({color: t.color, label: `${t.short}: ${t.label} (strip at the left edge, pooled panel)`}))]);
    const grid = el('div', 'u-grid'); sec.append(grid);
    const groups = [{key: 'all', label: 'All tasks', color: null, trials: shown}];
    for (const t of TASKS) { const tr = shown.filter(T => T.task === t.key); if (tr.length) groups.push({key: t.key, label: `${t.short} · ${t.label}`, color: t.color, trials: tr}); }
    U.wholePeaks = {};
    for (const g of groups) wholePanel(grid, g);
  }
  const paintVar = hex => hex;   // legend swatches use the light-theme hex; the CSS var below handles the dark ink

  function wholePanel(host, g) {
    const trials = g.trials.slice().sort((a, b) => b.len - a.len || a.start - b.start);   // longest first: top row
    const maxLen = trials[0].len, xmax = maxLen + POST;
    const nbMax = Math.floor((maxLen + POST + PRE) / BIN + 1e-9);
    const all = rateMap(trials, nbMax, MIN_N), odd = rateMap(trials.filter(T => T.half === 'odd'), nbMax, MIN_N / 2), even = rateMap(trials.filter(T => T.half === 'even'), nbMax, MIN_N / 2);
    const nbPk = Math.min(all.nb, odd.nb, even.nb);   // one search range for all three peaks: bins with >= 20 running trials and >= 10 in each half
    const pk = peakOf(all.rate, nbPk), po = peakOf(odd.rate, nbPk), pe = peakOf(even.rate, nbPk);
    const nOdd = trials.filter(T => T.half === 'odd').length;
    const panel = el('div', 'u-panel');
    panel.innerHTML = `<h3>${g.color ? `<i style="background:${g.color}"></i>` : ''}${esc(g.label)} <small>${int(trials.length)} trials, median length ${secs(medianOf(trials.map(T => T.len)))}</small></h3>`;
    host.append(panel);
    const height = clamp(Math.round(trials.length * 1.2), 110, 380);
    const strip = g.key === 'all';
    new Plot(panel, {
      rows: trials.map(T => T.id), height, xmin: -PRE, xmax, left: 44, top: 2, bottom: 2,
      paint: (c, P) => {
        const rh = P.rh;
        gridX(c, P, xTicks(-PRE, xmax), false);
        const evw = Math.max(1.6, 0.6 * (window.devicePixelRatio || 1)), evh = Math.max(rh, 1.3);
        trials.forEach((T, k) => {
          const y = P.t + k * rh, yc = y + rh / 2;
          if (strip) { c.fillStyle = paint(TASK_BY[T.task].color); c.fillRect(P.l - 11, y, 5, Math.max(rh, 0.8)); }
          const tr = T.train;
          if (tr && tr.cond && !tr.conn && Number.isFinite(tr.on)) {
            const on = tr.on - T.start, dur = Number.isFinite(tr.dur) ? tr.dur : 0.02;
            c.fillStyle = alpha(paint(tr.cond === 'stim' ? STIM_C : SHAM_C), 0.55);
            c.fillRect(P.X(on), yc - evh / 2, Math.max(1.6, P.X(on + dur) - P.X(on)), evh);
          }
          const mark = (t, color) => { if (Number.isFinite(t)) { c.fillStyle = paint(color); c.fillRect(P.X(t) - evw / 2, yc - evh / 2, evw, evh); } };
          mark(T.ev.fix_on - T.start, EV.fix_on); mark(T.ev.stimuli_on - T.start, EV.stimuli_on);
          mark((T.task === 'pursuit' ? T.ev.pursuit_start : T.ev.response) - T.start, EV.response);
          mark(('reward_start' in T.ev ? T.ev.reward_start : T.ev.reward) - T.start, EV.reward);
          mark(T.len, EV.end);
        });
        c.fillStyle = TH.ink;
        const sh = Math.max(rh * 0.86, 0.8);
        trials.forEach((T, k) => {
          const s = trialSpikes(T), y = P.t + k * rh + (rh - sh) / 2;
          for (let i = 0; i < s.length; i++) c.fillRect(P.X(s[i]) - 0.5, y, 1, sh);
        });
        text(c, 'trials', 2, P.t + 9);
      },
    });
    const ymax = niceMax(Math.max(1e-9, ...Array.from(all.rate.subarray(0, all.nb)).filter(Number.isFinite)) * 1.08);
    const lineColor = g.color ? paint(g.color) : TH.ink;
    new Plot(panel, {
      height: 144, xmin: -PRE, xmax, left: 44, top: 14, bottom: 30, ymax,
      paint: (c, P) => {
        const xs = new Float64Array(nbMax); for (let b = 0; b < nbMax; b++) xs[b] = -PRE + (b + 0.5) * BIN;
        gridX(c, P, xTicks(-PRE, xmax), true);
        axisY(c, P, 'Hz');
        if (all.nb < nbMax) {
          const x0 = P.X(-PRE + all.nb * BIN);
          c.fillStyle = alpha(TH.axis.length === 7 ? TH.axis : '#999999', 0.14); c.fillRect(x0, P.t, P.r - x0, P.b - P.t);
          if (P.r - x0 > 70) text(c, `fewer than ${MIN_N} trials running`, (x0 + P.r) / 2, P.b - 6, {align: 'center', size: 10.5});
        }
        curve(c, P, xs, all.rate, lineColor, 1.8, all.nb);
        const tickAt = (p, color, down) => {
          if (!p) return; const x = P.X(p.t);
          c.fillStyle = color; c.beginPath(); c.moveTo(x, P.b + 1); c.lineTo(x - 4, P.b + 8); c.lineTo(x + 4, P.b + 8); c.closePath(); c.fill();
        };
        if (pk) {
          const x = P.X(pk.t), y = P.Y(pk.hz);
          c.strokeStyle = TH.ink; c.setLineDash([3, 3]); c.lineWidth = 1; c.beginPath(); c.moveTo(x, P.t); c.lineTo(x, P.b); c.stroke(); c.setLineDash([]);
          c.fillStyle = TH.ink; c.beginPath(); c.arc(x, y, 3.2, 0, 7); c.fill();
          const left = x > P.l + (P.r - P.l) * 0.6;
          text(c, `peak ${pk.t.toFixed(2)} s`, x + (left ? -6 : 6), P.t + 20, {align: left ? 'right' : 'left', color: TH.ink, size: 11});
        }
        tickAt(po, paint('#7048e8')); tickAt(pe, paint('#0c8599'));
        text(c, 'time from trial start (s)', (P.l + P.r) / 2, P.h - 2, {align: 'center'});
      },
    });
    const peakTxt = pk ? `peak <b>${pk.t.toFixed(2)} s</b> (${fmt(pk.hz, 1)} Hz, Gaussian σ ${SIGMA * 1000} ms; all three peaks are searched over the bins up to ${(-PRE + nbPk * BIN).toFixed(2)} s, where at least ${MIN_N} trials still run and each half has at least ${MIN_N / 2})` : 'no peak: fewer than ' + MIN_N + ' trials';
    let split;
    if (po && pe) split = `odd-trial peak ${po.t.toFixed(2)} s, even-trial peak ${pe.t.toFixed(2)} s, gap <b>${Math.abs(po.t - pe.t).toFixed(2)} s</b>`;
    else split = `odd/even peaks not available (each half needs at least ${MIN_N / 2} running trials; ${nOdd} odd, ${trials.length - nOdd} even)`;
    U.wholePeaks[g.key] = {peak: pk, odd: po, even: pe, gap: po && pe ? Math.abs(po.t - pe.t) : null};
    const unstable = pk && po && pe && (Math.abs(pk.t - po.t) > 1 || Math.abs(pk.t - pe.t) > 1 || Math.abs(po.t - pe.t) > 1);
    U.wholePeaks[g.key].unstable = !!unstable;
    const n = note(panel, `${peakTxt}. ${split}.${unstable ? ' <b class="u-warn">peak not stable across halves</b>' : ''}`);
    n.insertAdjacentHTML('beforeend', `<br><span style="white-space:nowrap"><i style="display:inline-block;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:7px solid #7048e8;vertical-align:middle"></i> odd trials</span> <span style="white-space:nowrap"><i style="display:inline-block;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:7px solid #0c8599;vertical-align:middle"></i> even trials</span>`);
  }
  const medianOf = a => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // ----------------------------------------------------- 3. stim versus sham
  function sectionStim() {
    const S = U.S;
    const all = S.T.filter(T => TASK_BY[T.task] && T.train && T.train.cond && !T.train.conn);
    const c = {total: all.length, incomplete: 0, outside: 0, long: 0, unstable: 0, ok: 0, nodur: 0};
    const items = [];
    for (const T of all) {
      const r = U.reason.get(T.id) || 'incomplete';
      if (r !== 'ok') { c[r]++; continue; }
      if (!Number.isFinite(T.train.dur)) c.nodur++;
      items.push(T);
    }
    const stimN = items.filter(T => T.train.cond === 'stim').length, shamN = items.length - stimN;
    const sec = section('Stimulation, stim vs sham',
      `<b>${int(items.length)}</b> of ${int(c.total)} stim or sham trains in task trials are shown (${int(stimN)} stim, ${int(shamN)} sham): stable for this unit, trial completed, inside the recording, at most ${MAX_LEN_S} s. Left out: `
      + `${int(c.unstable)} not stable for this unit, ${int(c.long)} longer than ${MAX_LEN_S} s, ${int(c.incomplete)} not completed, ${int(c.outside)} outside the recording`
      + `${c.nodur ? `; ${int(c.nodur)} have no recorded duration and are drawn but not counted` : ''}. Stim is compared with sham, never with trials without a train. `
      + `Aligned to train onset, ${STIM_WIN[0]} to +${STIM_WIN[1]} s; the count window runs ${COUNT_AFTER[0] * 1000}–${COUNT_AFTER[1] * 1000} ms after the end of each trial's own train, the baseline ${BASE[0] * 1000} to ${BASE[1] * 1000} ms before onset.`);
    if (!items.length) { note(sec, 'No stim or sham train is left for this unit.', 'warn'); return; }
    legend(sec, [{color: STIM_C, label: 'stim'}, {color: SHAM_C, label: 'sham'}, {color: 'rgba(240,180,70,.35)', label: 'train (onset to its own end)'},
      {color: 'rgba(25,113,194,.45)', label: 'count window (after train end)'}, {color: 'rgba(120,128,140,.45)', label: 'baseline window'}]);
    const groups = [{label: 'All tasks', color: null, items}];
    for (const t of TASKS) { const it = items.filter(T => T.task === t.key); if (it.length) groups.push({label: `${t.short} · ${t.label}`, color: t.color, items: it}); }
    const grid = el('div', 'u-grid ' + (groups.length >= 4 ? 'c4' : groups.length === 3 ? 'c3' : '')); sec.append(grid);
    U.stimStats = {};
    for (const g of groups) stimPanel(grid, g);
    note(sec, 'Stimulation artifacts inside the train can add spurious spikes or hide real ones, so spikes between 0 and the end of the train are shown but should not be read as the unit\'s firing; the count window starts after the train.');
  }

  function stimPanel(host, g) {
    const grid = C.psthGrid(STIM_WIN[0], STIM_WIN[1], 0.01, 0.02);
    const trains = g.items.map(T => {
      const dur = T.train.dur, on = T.train.on;
      const hi = Math.max(STIM_WIN[1] + 0.7, (Number.isFinite(dur) ? dur : 0) + COUNT_AFTER[1] + 0.05);
      const rel = relSpikes(on, -1.1, hi);
      const cw = Number.isFinite(dur) ? [dur + COUNT_AFTER[0], dur + COUNT_AFTER[1]] : null;
      return {T, id: T.id, cond: T.train.cond, dur, rel, cw, curve: C.rowCurve(rel, grid),
        count: cw ? C.countIn(rel, cw[0], cw[1]) / (cw[1] - cw[0]) : NaN, base: C.countIn(rel, BASE[0], BASE[1]) / (BASE[1] - BASE[0])};
    });
    const byCond = cond => trains.filter(t => t.cond === cond).sort((a, b) => a.T.start - b.T.start);
    const stim = byCond('stim'), sham = byCond('sham');
    const rowsT = [...stim, null, ...sham].filter((t, i, a) => !(t === null && (!stim.length || !sham.length)));
    const mean = (arr, f) => { const v = arr.map(f).filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; };
    const st = {n: {stim: stim.length, sham: sham.length}, hz: {stim: mean(stim, t => t.count), sham: mean(sham, t => t.count)}, base: {stim: mean(stim, t => t.base), sham: mean(sham, t => t.base)}};
    st.ratio = st.hz.sham > 0 ? st.hz.stim / st.hz.sham : NaN;
    U.stimStats[g.label] = st;
    const durs = new Map(); for (const t of trains) if (Number.isFinite(t.dur)) durs.set(t.dur, (durs.get(t.dur) || 0) + 1);
    const modal = [...durs.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    const dMod = modal ? modal[0] : 0.3;
    const panel = el('div', 'u-panel');
    panel.innerHTML = `<h3>${g.color ? `<i style="background:${g.color}"></i>` : ''}${esc(g.label)} <small>${stim.length} stim · ${sham.length} sham</small></h3>`;
    host.append(panel);
    const ids = rowsT.map(t => (t ? t.id : null));
    new Plot(panel, {
      rows: ids, height: clamp(Math.round(rowsT.length * 1.6), 90, 300), xmin: STIM_WIN[0], xmax: STIM_WIN[1], left: 34, top: 2, bottom: 2,
      paint: (c, P) => {
        const rh = P.rh;
        gridX(c, P, xTicks(STIM_WIN[0], STIM_WIN[1]), false);
        rowsT.forEach((t, k) => {
          if (!t) return;
          const y = P.t + k * rh, h = Math.max(rh, 0.8);
          if (Number.isFinite(t.dur)) { c.fillStyle = isDark() ? 'rgba(240,180,70,.13)' : 'rgba(240,180,70,.20)'; c.fillRect(P.X(0), y, P.X(t.dur) - P.X(0), h); }
        });
        const sh = Math.max(rh * 0.86, 0.9);
        rowsT.forEach((t, k) => {
          if (!t) return;
          c.fillStyle = paint(t.cond === 'stim' ? STIM_C : SHAM_C);
          const y = P.t + k * rh + (rh - sh) / 2, s = t.rel;
          for (let i = lowerBound(s, STIM_WIN[0]); i < s.length && s[i] <= STIM_WIN[1]; i++) c.fillRect(P.X(s[i]) - 0.5, y, 1, sh);
        });
        text(c, 'trials', 1, P.t + 9);
      },
    });
    const cur = {};
    for (const [k, arr] of [['stim', stim], ['sham', sham]]) cur[k] = arr.length ? C.psthFromCurves(arr.map((_, i) => i), i => arr[i].curve, [], grid.n, 'event') : null;
    let ymax = 1; for (const k of ['stim', 'sham']) if (cur[k]) for (let i = 0; i < grid.n; i++) ymax = Math.max(ymax, cur[k].mean[i] + (cur[k].sem[i] || 0));
    new Plot(panel, {
      height: 150, xmin: STIM_WIN[0], xmax: STIM_WIN[1], left: 34, top: 14, bottom: 30, ymax: niceMax(ymax * 1.05),
      paint: (c, P) => {
        gridX(c, P, xTicks(STIM_WIN[0], STIM_WIN[1]), true);
        axisY(c, P, 'Hz');
        c.fillStyle = 'rgba(240,180,70,.22)'; c.fillRect(P.X(0), P.t, P.X(dMod) - P.X(0), P.b - P.t);
        c.fillStyle = 'rgba(25,113,194,.30)'; c.fillRect(P.X(dMod + COUNT_AFTER[0]), P.t - 10, P.X(dMod + COUNT_AFTER[1]) - P.X(dMod + COUNT_AFTER[0]), 8);
        c.fillStyle = 'rgba(120,128,140,.40)'; c.fillRect(P.X(BASE[0]), P.t - 10, P.X(BASE[1]) - P.X(BASE[0]), 8);
        for (const k of ['sham', 'stim']) {
          const r = cur[k]; if (!r) continue;
          const color = paint(k === 'stim' ? STIM_C : SHAM_C);
          const lo = Array.from(r.mean, (m, i) => m - (r.sem[i] || 0)), hi = Array.from(r.mean, (m, i) => m + (r.sem[i] || 0));
          band(c, P, grid.times, lo, hi, alpha(color, 0.22));
          curve(c, P, grid.times, r.mean, color, 1.7);
        }
        text(c, 'time from train onset (s)', (P.l + P.r) / 2, P.h - 2, {align: 'center'});
      },
    });
    const dtxt = durs.size > 1 ? `Train durations: ${[...durs.entries()].sort((a, b) => a[0] - b[0]).map(([d, n]) => `${Math.round(d * 1000)} ms × ${n}`).join(', ')}. The shading and windows are drawn for the commonest (${Math.round(dMod * 1000)} ms); the numbers use each trial's own end.`
      : durs.size === 1 ? `Train duration ${Math.round(dMod * 1000)} ms.` : 'Train duration not recorded.';
    const hz = v => `${fmt(v, 2)} Hz`;
    note(panel, `<b>n stim ${stim.length} · n sham ${sham.length}</b><br>`
      + `${COUNT_AFTER[0] * 1000}–${COUNT_AFTER[1] * 1000} ms after train end: <b>stim ${hz(st.hz.stim)} · sham ${hz(st.hz.sham)} · stim/sham ${fmt(st.ratio, 2)}</b><br>`
      + `baseline ${BASE[0] * 1000} to ${BASE[1] * 1000} ms: stim ${hz(st.base.stim)} · sham ${hz(st.base.sham)}<br>${dtxt}`);
  }

  // -------------------------------------------------------- 4. task events
  const EVENT_PANELS = [
    {key: 'fix_on', label: 'fixation on', win: [-0.5, 1.5], time: T => T.ev.fix_on},
    {key: 'stimuli_on', label: 'target on', win: [-0.5, 1.5], time: T => T.ev.stimuli_on},
    {key: 'response', label: 'response (saccade; pursuit start in SP)', win: [-1, 1], time: T => (T.task === 'pursuit' ? T.ev.pursuit_start : T.ev.response)},
    {key: 'reward', label: 'reward start', win: [-0.5, 1.5], time: T => ('reward_start' in T.ev ? T.ev.reward_start : T.ev.reward)},
  ];
  function sectionEvents() {
    const S = U.S;
    const pool = S.hasStim ? U.shown.filter(T => !T.micro && !T.sham) : U.shown;
    const sec = section('Task events',
      S.hasStim ? `<b>${int(pool.length)}</b> task trials without a stim or sham train (of ${int(U.shown.length)} shown), so no train disturbs the spikes; stable for this unit, completed, at most ${MAX_LEN_S} s.`
        : `<b>${int(pool.length)}</b> task trials (stable for this unit, completed, at most ${MAX_LEN_S} s). This session has no stim or sham trains in task trials.`);
    if (!pool.length) { note(sec, 'No trial is left for this unit.', 'warn'); return; }
    legend(sec, TASKS.filter(t => pool.some(T => T.task === t.key)).map(t => ({color: t.color, label: `${t.short}: ${t.label} (${pool.filter(T => T.task === t.key).length} trials)`})));
    const grid = el('div', 'u-grid c4'); sec.append(grid);
    for (const E of EVENT_PANELS) eventPanel(grid, E, pool);
    note(sec, 'Curves are trial means (20 ms bins, Gaussian σ 40 ms) of the tasks with at least 5 trials that have the event; the raster below each is the same trials, grouped by task.');
  }
  function eventPanel(host, E, pool) {
    const grid = C.psthGrid(E.win[0], E.win[1], 0.02, 0.04);
    const panel = el('div', 'u-panel');
    host.append(panel);
    const per = [];
    for (const t of TASKS) {
      const items = [];
      for (const T of pool) {
        if (T.task !== t.key) continue;
        const te = E.time(T);
        if (!Number.isFinite(te)) continue;
        const rel = relSpikes(te, E.win[0] - 0.7, E.win[1] + 0.7);
        items.push({T, rel, curve: C.rowCurve(rel, grid)});
      }
      if (items.length) per.push({t, items});
    }
    const nAll = per.reduce((s, p) => s + p.items.length, 0);
    panel.innerHTML = `<h3>${esc(E.label)} <small>${int(nAll)} trials</small></h3>`;
    if (!nAll) { note(panel, 'No trial has this event.', 'warn'); return; }
    const rowsT = []; for (const p of per) for (const it of p.items.sort((a, b) => a.T.start - b.T.start)) rowsT.push(it);
    new Plot(panel, {
      rows: rowsT.map(r => r.T.id), height: clamp(Math.round(rowsT.length * 0.5), 56, 150), xmin: E.win[0], xmax: E.win[1], left: 32, top: 2, bottom: 2,
      paint: (c, P) => {
        const rh = P.rh, sh = Math.max(rh * 0.86, 0.7);
        gridX(c, P, xTicks(E.win[0], E.win[1]), false);
        rowsT.forEach((r, k) => {
          c.fillStyle = paint(TASK_BY[r.T.task].color);
          const y = P.t + k * rh + (rh - sh) / 2, s = r.rel;
          for (let i = lowerBound(s, E.win[0]); i < s.length && s[i] <= E.win[1]; i++) c.fillRect(P.X(s[i]) - 0.5, y, 1, sh);
        });
      },
    });
    const cur = per.map(p => ({t: p.t, n: p.items.length, r: p.items.length >= 5 ? C.psthFromCurves(p.items.map((_, i) => i), i => p.items[i].curve, [], grid.n, 'event') : null}));
    let ymax = 1; for (const k of cur) if (k.r) for (let i = 0; i < grid.n; i++) ymax = Math.max(ymax, k.r.mean[i] + (k.r.sem[i] || 0));
    new Plot(panel, {
      height: 136, xmin: E.win[0], xmax: E.win[1], left: 32, top: 14, bottom: 28, ymax: niceMax(ymax * 1.05),
      paint: (c, P) => {
        gridX(c, P, xTicks(E.win[0], E.win[1]), true);
        axisY(c, P, 'Hz');
        for (const k of cur) {
          if (!k.r) continue;
          const color = paint(k.t.color);
          band(c, P, grid.times, Array.from(k.r.mean, (m, i) => m - (k.r.sem[i] || 0)), Array.from(k.r.mean, (m, i) => m + (k.r.sem[i] || 0)), alpha(color, 0.18));
          curve(c, P, grid.times, k.r.mean, color, 1.6);
        }
        text(c, 'time from event (s)', (P.l + P.r) / 2, P.h - 2, {align: 'center'});
      },
    });
  }

  // ------------------------------------------------------ 5. over the session
  function sectionSession() {
    const S = U.S, dur = S.duration, sp = U.sp;
    const sec = section('Over the session', `Firing rate against session time. Shaded: blocks of consecutive trials of one kind. The strip along the bottom is the unit's stability check for each trial (green stable, red not).`);
    const widths = [5, 10, 15, 30, 60, 120];
    const bw = widths.find(w => dur / w <= 700) || 120, nb = Math.ceil(dur / bw);
    const cnt = new Float64Array(nb);
    for (let i = 0; i < sp.length; i++) { const b = Math.floor(sp[i] / bw); if (b >= 0 && b < nb) cnt[b]++; }
    const rate = Array.from(cnt, (c, b) => c / (b === nb - 1 ? Math.max(1e-9, dur - b * bw) : bw));
    const kind = T => (TASK_BY[T.task] ? 'task' : T.task === 'fixation' ? 'fixation' : 'other');
    const KC = {task: '#f08c00', fixation: '#495057', other: '#9c36b5'};
    const KL = {task: 'task trials (MS, SP, PM)', fixation: 'fixation trials', other: 'other trials (e.g. freeview)'};
    const blocks = [];
    for (const T of S.T) {
      const k = kind(T), last = blocks[blocks.length - 1];
      if (last && last.k === k) last.t1 = T.stop; else blocks.push({k, t0: T.start, t1: T.stop, t: [T.id]});
    }
    for (let i = 0; i < blocks.length - 1; i++) { const m = (blocks[i].t1 + blocks[i + 1].t0) / 2; blocks[i].t1 = m; blocks[i + 1].t0 = m; }
    const runs = [];
    for (const T of S.T) {
      const ok = U.stable.has(T.id), last = runs[runs.length - 1];
      if (last && last.ok === ok) last.t1 = T.stop; else runs.push({ok, t0: T.start, t1: T.stop});
    }
    for (let i = 0; i < runs.length - 1; i++) { const m = (runs[i].t1 + runs[i + 1].t0) / 2; runs[i].t1 = m; runs[i + 1].t0 = m; }
    const stableRuns = runs.filter(r => r.ok);
    const nStable = S.T.filter(T => U.stable.has(T.id)).length;
    const kinds = [...new Set(blocks.map(b => b.k))];
    legend(sec, [...kinds.map(k => ({color: alpha(KC[k], 0.35), label: KL[k]})), {color: '#2f9e44', label: 'stable trial'}, {color: '#e03131', label: 'not stable'}, {kind: 'tick', color: paint('#3b5bdb'), label: 'pinned trial'}]);
    const ymax = niceMax(Math.max(1e-9, ...rate) * 1.05);
    const readout = el('div', 'u-readout');
    const P0 = new Plot(sec, {
      height: 206, xmin: 0, xmax: dur / 60, left: 44, top: 14, bottom: 34, ymax,
      paint: (c, P) => {
        for (const b of blocks) { c.fillStyle = alpha(paint(KC[b.k]), b.k === 'task' ? 0.13 : 0.10); const x0 = P.X(b.t0 / 60), x1 = P.X(b.t1 / 60); c.fillRect(x0, P.t, Math.max(1, x1 - x0), P.b - P.t); }
        const step = P.xmax > 120 ? 30 : P.xmax > 50 ? 10 : 5;
        const ticks = []; for (let v = 0; v <= P.xmax; v += step) ticks.push(v);
        gridX(c, P, ticks, true);
        axisY(c, P, 'Hz');
        const xs = Array.from(cnt, (_, b) => (b + 0.5) * bw / 60);
        curve(c, P, xs, rate, TH.ink, 1.4);
        const y0 = P.b + 17;
        for (const r of runs) { c.fillStyle = r.ok ? paint('#2f9e44') : paint('#e03131'); const x0 = P.X(r.t0 / 60), x1 = P.X(r.t1 / 60); c.fillRect(x0, y0, Math.max(1, x1 - x0), 7); }
        text(c, 'session time (min)', (P.l + P.r) / 2, P.h - 1, {align: 'center'});
      },
      overlay: (g, P) => {
        if (pinned !== null && S.byId.has(pinned)) { const x = P.X(S.byId.get(pinned).start / 60); g.fillStyle = TH.accent; g.fillRect(x - 1, P.t, 2, P.b - P.t + 24); }
        if (P.cursor !== undefined && P.cursor !== null) { const x = P.X(P.cursor); g.fillStyle = alpha(TH.ink.length === 7 ? TH.ink : '#888888', 0.5); g.fillRect(x, P.t, 1, P.b - P.t); }
      },
      hover: (P, e) => {
        if (!e) { P.cursor = null; P.drawOverlay(); readout.textContent = ''; return; }
        const rect = P.ov.getBoundingClientRect(), tm = P.xmin + (e.clientX - rect.left - P.l) / (P.r - P.l) * (P.xmax - P.xmin);
        if (tm < 0 || tm > P.xmax) { P.cursor = null; P.drawOverlay(); return; }
        P.cursor = tm; P.drawOverlay();
        const b = clamp(Math.floor(tm * 60 / bw), 0, nb - 1);
        const T = S.T.find(x => tm * 60 >= x.start && tm * 60 < x.stop);
        readout.textContent = `${tm.toFixed(1)} min · ${fmt(rate[b], 2)} Hz (${bw} s bin)${T ? ` · trial ${T.id}, ${TASK_BY[T.task] ? TASK_BY[T.task].short : T.task}${U.stable.has(T.id) ? ', stable' : ', not stable'}` : ''}`;
      },
    });
    sec.append(readout);
    const longest = stableRuns.reduce((a, r) => (!a || r.t1 - r.t0 > a.t1 - a.t0 ? r : a), null);
    note(sec, `Bins of ${bw} s. Stable on ${int(nStable)} of ${int(S.T.length)} trials, in ${plural(stableRuns.length, 'run')}`
      + (longest ? `; the longest is ${((longest.t1 - longest.t0) / 60).toFixed(1)} min, from ${(longest.t0 / 60).toFixed(1)} to ${(longest.t1 / 60).toFixed(1)} min` : '') + '.');
  }

  // ------------------------------------------------- 6. spike train statistics
  function sectionStats() {
    const sp = U.sp, n = sp.length;
    const sec = section('Spike train statistics', `All ${int(n)} spikes of the unit, the whole recording (spike times are kept to 0.1 ms).`);
    const grid = el('div', 'u-grid'); sec.append(grid);
    // ISI histogram, 0-50 ms in 1 ms bins; ACG +-100 ms in 1 ms bins
    const isi = new Float64Array(50); let nIsi = 0, viol = 0, sub1 = 0;
    for (let i = 1; i < n; i++) { const d = sp[i] - sp[i - 1]; nIsi++; if (d < 0.0015) viol++; if (d < 0.001) sub1++; if (d < 0.05) isi[Math.floor(d * 1000)]++; }
    const acg = new Float64Array(100);
    const step = n > 1.5e6 ? Math.ceil(n / 1.5e6) : 1;   // very busy units: every step-th spike is the reference
    let used = 0;
    for (let i = 0; i < n; i += step) {
      used++;
      for (let j = i + 1; j < n; j++) { const d = sp[j] - sp[i]; if (d >= 0.1) break; acg[Math.floor(d * 1000)]++; }
    }
    const pa = el('div', 'u-panel'), pb = el('div', 'u-panel');
    pa.innerHTML = `<h3>Inter-spike intervals <small>0–50 ms</small></h3>`; pb.innerHTML = `<h3>Autocorrelogram <small>±100 ms, 1 ms bins</small></h3>`;
    grid.append(pa, pb);
    const imax = niceMax(Math.max(1, ...isi) * 1.05);
    new Plot(pa, {
      height: 196, xmin: 0, xmax: 50, left: 48, top: 14, bottom: 32, ymax: imax,
      paint: (c, P) => {
        gridX(c, P, [0, 10, 20, 30, 40, 50], true); axisYInt(c, P);
        c.fillStyle = paint('#1971c2');
        const bw = (P.r - P.l) / 50;
        for (let b = 0; b < 50; b++) { const y = P.Y(isi[b]); c.fillRect(P.X(b) + 0.5, y, Math.max(1, bw - 1), P.b - y); }
        const x = P.X(1.5); c.strokeStyle = paint('#e03131'); c.lineWidth = 1.4; c.setLineDash([4, 3]); c.beginPath(); c.moveTo(x, P.t); c.lineTo(x, P.b); c.stroke(); c.setLineDash([]);
        text(c, '1.5 ms', x + 4, P.t + 10, {color: paint('#e03131')});
        text(c, 'interval (ms)', (P.l + P.r) / 2, P.h - 2, {align: 'center'}); text(c, 'count', P.l - 4, P.t - 4, {align: 'right'});
      },
    });
    note(pa, `<b>${int(viol)}</b> of ${int(nIsi)} intervals (${fmt(100 * viol / Math.max(1, nIsi), 3)} %) are shorter than 1.5 ms${sub1 ? `, ${int(sub1)} shorter than 1 ms` : ''}. The red line marks the 1.5 ms refractory period.`);
    const mean = n / Math.max(1e-9, U.S.duration);
    const rateAt = b => acg[b] / (used * 0.001);
    let amax = mean; for (let b = 0; b < 100; b++) amax = Math.max(amax, rateAt(b));
    new Plot(pb, {
      height: 196, xmin: -100, xmax: 100, left: 48, top: 14, bottom: 32, ymax: niceMax(amax * 1.08),
      paint: (c, P) => {
        gridX(c, P, [-100, -50, 0, 50, 100], true); axisY(c, P, 'Hz');
        c.fillStyle = paint('#495057');
        const bw = (P.r - P.l) / 200;
        for (let b = 0; b < 100; b++) {
          const y = P.Y(rateAt(b)), h = P.b - y;
          c.fillRect(P.X(b) + 0.5, y, Math.max(1, bw - 1), h);          // lag b..b+1 ms
          c.fillRect(P.X(-b - 1) + 0.5, y, Math.max(1, bw - 1), h);     // mirrored
        }
        const ym = P.Y(mean); c.strokeStyle = paint('#e8590c'); c.lineWidth = 1.2; c.setLineDash([4, 3]); c.beginPath(); c.moveTo(P.l, ym); c.lineTo(P.r, ym); c.stroke(); c.setLineDash([]);
        text(c, 'lag (ms)', (P.l + P.r) / 2, P.h - 2, {align: 'center'});
      },
    });
    note(pb, `Rate of other spikes at each lag from a spike (Hz). Dashed: the unit's mean rate, ${fmt(mean, 2)} Hz.${step > 1 ? ` Every ${step}th spike is used as the reference (the unit fires very often).` : ''}`);
  }
  function axisYInt(c, P) {
    for (const v of [0, P.ymax / 2, P.ymax]) {
      const y = Math.round(P.Y(v)) + 0.5;
      c.strokeStyle = TH.grid; c.lineWidth = 1; c.beginPath(); c.moveTo(P.l, y); c.lineTo(P.r, y); c.stroke();
      text(c, Math.round(v).toLocaleString('en-US'), P.l - 4, y + 3.5, {align: 'right'});
    }
  }

  // -------------------------------------------------------- 7. exported panels
  function sectionFigures() {
    const figs = U.info.figures || [];
    const sec = section('Exported panels', '');
    if (!figs.length) { note(sec, 'No exported figure was found for this unit in this session\'s figures folder.'); return; }
    const det = el('details', 'u-det');
    det.innerHTML = `<summary>${figs.length} exported figures for unit ${U.unit} (open to load)</summary>`;
    sec.append(det);
    let built = false;
    det.addEventListener('toggle', () => {
      if (!det.open || built) return;
      built = true;
      const box = el('div', 'u-figs');
      const groups = new Map();
      for (const f of figs) { if (!groups.has(f.group)) groups.set(f.group, []); groups.get(f.group).push(f); }
      for (const [name, list] of groups) {
        const h = el('div'); h.innerHTML = `<h4>${esc(name)}</h4>`;
        const gr = el('div', 'u-figgrid');
        for (const f of list) {
          const fig = el('figure', 'u-fig');
          const img = document.createElement('img');
          img.loading = 'lazy'; img.alt = f.title;
          img.src = `/api/figure?${q({session: CUR.session, sorting: CUR.sorting, path: f.path})}`;
          const cap = el('figcaption', '', `${esc(f.title)}${f.desc ? `<span>${esc(f.desc)}</span>` : ''}`);
          fig.append(img, cap); gr.append(fig);
        }
        h.append(gr); box.append(h);
      }
      det.append(box);
    });
  }

  // ----------------------------------------------------------------- start
  window.EGUnitPage = {state: () => ({params: CUR, pinned, unit: U && U.unit, counts: U && U.counts, wholePeaks: U && U.wholePeaks, stim: U && U.stimStats, nShown: U && U.shown.length}),
    pin: id => setPin(id, true), redraw: redrawAll};
  applyTheme();
  loadAll();
})();
