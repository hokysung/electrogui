'use strict';
/* Trial trace viewer: one unit's spikes over the voltage traces of the channels it was sorted from. */
(function () {
  const $ = id => document.getElementById(id);
  const MAGIC = 'PHYSTRC1';
  const NB_LIGHT = ['#b45309', '#0f766e', '#a21caf', '#4d7c0f', '#be123c', '#7c5e10'];
  const NB_DARK = ['#f0a35a', '#4fd1c5', '#e08af0', '#a3d65c', '#ff8aa1', '#d9c35a'];

  /* ---------------------------------------------------------------- theme */
  const THEME_KEY = 'eg-theme';            // same key as the explorer; this page opens light when unset
  let C = {};
  function themePref() { let p = null; try { p = localStorage.getItem(THEME_KEY); } catch (e) {} return ['light', 'dark', 'auto'].includes(p) ? p : 'light'; }
  function isDark() { return document.documentElement.dataset.theme === 'dark'; }
  function applyTheme() {
    const p = themePref();
    const dark = p === 'dark' || (p === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('themeBtn').textContent = { light: '☀ Light', dark: '☾ Dark', auto: '◐ Auto' }[p];
    readColors(); schedule();
  }
  function readColors() {
    const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
    C = { ink: v('--fig-ink'), muted: v('--fig-muted'), grid: v('--fig-grid'), axis: v('--fig-axis'), bg: v('--fig-bg'),
      accent: v('--accent'), line: v('--line'), danger: v('--danger'), nb: isDark() ? NB_DARK : NB_LIGHT,
      clean: isDark() ? 'rgba(240,180,70,.20)' : 'rgba(231,165,42,.22)' };
  }
  $('themeBtn').addEventListener('click', () => {
    const next = { light: 'dark', dark: 'auto', auto: 'light' }[themePref()];
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    applyTheme();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePref() === 'auto') applyTheme(); });

  /* ---------------------------------------------------------------- state */
  const S = { h: null, raw: [], src: 'sorted', ref: false, nb: false, gain: 1, v0: 0, v1: 1, w0: 0, w1: 1, hover: null, proc: {}, abort: null, params: null };

  /* ---------------------------------------------------------------- decode */
  function decode(buf) {
    const dv = new DataView(buf);
    let m = ''; for (let i = 0; i < 8; i++) m += String.fromCharCode(dv.getUint8(i));
    if (m !== MAGIC) throw new Error('The server sent data that is not a trace blob.');
    const n = dv.getUint32(8, true);
    const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, n)));
    let off = 12 + n; const nch = h.channels.length, raw = [];
    for (const s of h.sources) {
      const len = h.n_samples * nch * 2;
      raw.push(new Int16Array(buf.slice(off, off + len))); off += len;
    }
    return { h, raw };
  }
  window.__traceDecode = decode;

  /* ---------------------------------------------------------------- loading */
  function params() {
    const p = new URLSearchParams(location.hash.slice(1));
    return { session: p.get('session') || '', sorting: p.get('sorting') || '', unit: p.get('unit') || '', trial: p.get('trial') || '' };
  }
  function setMsg(kind, text, retry) {
    const m = $('msg'); m.className = 'tr-msg' + (kind === 'err' ? ' err' : ''); m.textContent = '';
    if (!kind) { m.hidden = true; $('stage').classList.remove('empty'); return; }
    m.hidden = false; $('stage').classList.add('empty');
    if (kind === 'load') { const s = document.createElement('div'); s.className = 'tr-spin'; m.appendChild(s); }
    const p = document.createElement('p'); p.textContent = text; m.appendChild(p);
    if (retry) { const b = document.createElement('button'); b.className = 'tr-btn'; b.type = 'button'; b.textContent = 'Retry'; b.addEventListener('click', load); m.appendChild(b); }
  }
  async function load() {
    const P = params(); S.params = P;
    if (S.abort) S.abort.abort();
    const ac = S.abort = new AbortController();
    S.h = null; S.hover = null;
    $('title').textContent = 'Trial traces'; $('meta').textContent = P.session ? `${P.session} · unit ${P.unit} · trial ${P.trial}` : ''; $('summary').textContent = '';
    $('counts').textContent = ''; $('legend').textContent = ''; $('srcInfo').textContent = '';
    document.title = `unit ${P.unit} trial ${P.trial} · traces`;
    updateTrialButtons(); draw();
    if (!P.session || !P.unit || !P.trial) { setMsg('err', 'The address needs session, unit and trial (…#session=…&unit=…&trial=…).', false); return; }
    setMsg('load', 'Reading the traces from the cluster. The first load of a trial takes about 5 seconds; later loads are cached.');
    try {
      const q = new URLSearchParams({ session: P.session, unit: P.unit, trial: P.trial });
      if (P.sorting) q.set('sorting', P.sorting);
      let r;
      try { r = await fetch('/api/trace?' + q, { signal: ac.signal }); }
      catch (e) { if (e.name === 'AbortError') return; throw new Error('Could not reach the electro_gui server.'); }
      if (!r.ok) {
        let msg = `The server answered ${r.status}.`;
        try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) {}
        throw new Error(msg);
      }
      const buf = await r.arrayBuffer();
      if (ac.signal.aborted) return;
      const d = decode(buf);
      S.h = d.h; S.raw = d.raw; S.proc = {};
      S.w0 = (d.h.t0 - d.h.trial_start); S.w1 = S.w0 + d.h.n_samples / d.h.fs;
      S.v0 = S.w0; S.v1 = S.w1;
      if (!d.h.sources.some(s => s.key === S.src)) S.src = d.h.sources[0].key;
      setMsg(null); fillHeader(); fillSource(); fillCounts(); fillLegend(); draw(); drawOverview();
    } catch (e) {
      if (ac.signal.aborted) return;
      setMsg('err', e.message || String(e), true);
    }
  }
  function updateTrialButtons() {
    const t = parseInt(params().trial, 10), ok = Number.isFinite(t);
    $('prevTrial').disabled = !ok; $('nextTrial').disabled = !ok;
  }
  function goTrial(d) {
    const P = params(), t = parseInt(P.trial, 10); if (!Number.isFinite(t)) return;
    const p = new URLSearchParams(location.hash.slice(1)); p.set('trial', String(t + d));
    location.hash = p.toString();
  }

  /* ---------------------------------------------------------------- header */
  function fillHeader() {
    const h = S.h, f = h.trial_fields || {};
    $('title').textContent = '';
    const t = $('title');
    t.append(`Unit ${h.unit} `);
    const q = document.createElement('span'); q.className = 'tq ' + h.quality; q.textContent = h.quality; t.append(q);
    t.append(` · trial ${h.trial}`);
    const bits = [h.session, h.depth_um != null ? `depth ${Math.round(h.depth_um)} µm` : null, `peak channel ${h.peak_channel}`,
      h.sorting ? `sorting ${h.sorting}` : 'default sorting', h.source_unit_id !== h.unit ? `sorter unit ${h.source_unit_id}` : null].filter(Boolean);
    $('meta').textContent = bits.join(' · ');
    const s = [];
    if (f.task) s.push(f.task);
    if (f.microstim) s.push('stim'); if (f.sham) s.push('sham');
    if (f.complete === false) s.push('incomplete'); else if (f.fixated === false) s.push('not fixated');
    if (f.rewarded != null) s.push(f.rewarded ? 'rewarded' : 'not rewarded');
    if (f.connectivity) s.push('connectivity');
    if (h.stable === false) s.push("not in this unit's stable run");
    $('summary').textContent = s.join(' · ');
  }
  const curSrc = () => S.h.sources.find(s => s.key === S.src) || S.h.sources[0];
  const srcIdx = () => S.h.sources.indexOf(curSrc());
  const rowsOf = () => { const s = curSrc(); return s.channels && s.channels.length ? s.channels : S.h.channels; };
  function fillSource() {
    document.querySelectorAll('#srcSeg button').forEach(b => {
      const has = S.h.sources.some(s => s.key === b.dataset.src);
      b.disabled = !has; b.classList.toggle('on', b.dataset.src === S.src);
    });
    const s = curSrc(), el = $('srcInfo'); el.textContent = '';
    const l = document.createElement('div'); l.textContent = s.label + (s.exact === false ? ' (approximate)' : ''); el.appendChild(l);
    if (s.key === 'raw' && s.shift_um != null) {
      const d = document.createElement('div'); d.textContent = `Motion shift ${(+s.shift_um).toFixed(1)} µm` + (s.match_r != null ? `, match r = ${(+s.match_r).toFixed(3)}` : ''); el.appendChild(d);
    }
    if (s.note) { const n = document.createElement('div'); n.className = 'note'; n.textContent = s.note; el.appendChild(n); }
    $('refLab').hidden = s.key !== 'raw';
    $('nbChk').disabled = !(S.h.neighbours && S.h.neighbours.length);
    $('nbChk').parentElement.title = $('nbChk').disabled ? 'No other units have their peak on these channels' : '';
  }
  function setSrc(k) {
    if (!S.h || !S.h.sources.some(s => s.key === k) || S.src === k) return;
    S.src = k; fillSource(); fillLegend(); draw();
  }

  /* ---------------------------------------------------------------- spikes */
  const tOf = s => s / S.h.fs + S.h.t0 - S.h.trial_start;     // sample offset -> s relative to trial start
  function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
  function fillCounts() {
    const h = S.h, ts = h.trial_start - h.t0, te = h.trial_stop - h.t0, fs = h.fs;
    let n = 0; for (const s of h.spikes) { const t = s / fs; if (t >= ts && t <= te) n++; }
    const el = $('counts'); el.textContent = '';
    if (!h.spikes.length) {
      const b = document.createElement('span'); b.className = 'zero'; b.textContent = `No spikes of unit ${h.unit} in this trial or in the ±${h.pad} s around it.`;
      el.appendChild(b); el.append(' Traces are shown anyway.'); S.cnt = null; return;
    }
    S.cnt = { n, all: h.spikes.length };
    updateCounts();
  }
  function updateCounts() {
    if (!S.cnt) return; const h = S.h;
    const a = lowerBound(h.spikes, (S.v0 - (h.t0 - h.trial_start)) * h.fs), b = lowerBound(h.spikes, (S.v1 - (h.t0 - h.trial_start)) * h.fs);
    const el = $('counts'); el.textContent = '';
    const add = (num, txt) => { const x = document.createElement('b'); x.textContent = num; el.append(x, ' ' + txt); };
    add(S.cnt.n, 'spikes in the trial · '); add(S.cnt.all, `in the ±${h.pad} s window · `); add(b - a, 'in view');
  }

  /* ---------------------------------------------------------------- processed traces */
  function median(a) { const b = Float32Array.from(a).sort(); return b.length ? b[b.length >> 1] : 0; }
  function proc() {
    const key = S.src + (S.src === 'raw' && S.ref ? '+ref' : '');
    if (S.proc[key]) return S.proc[key];
    const h = S.h, i = srcIdx(), src = curSrc(), raw = S.raw[i], nch = h.channels.length, n = h.n_samples, g = src.gain_uv || 1;
    const out = new Float32Array(nch * n), rows = rowsOf();
    for (let c = 0; c < nch; c++) {
      const step = Math.max(1, Math.floor(n / 20000)), samp = [];
      for (let k = 0; k < n; k += step) samp.push(raw[k * nch + c]);
      const med = median(samp), o = c * n;
      for (let k = 0; k < n; k++) out[o + k] = (raw[k * nch + c] - med) * g;
    }
    if (key.endsWith('+ref')) {
      const use = []; for (let c = 0; c < nch; c++) if (!(rows[c] && rows[c].bad)) use.push(c);
      const tmp = new Float32Array(use.length);
      for (let k = 0; k < n; k++) {
        for (let j = 0; j < use.length; j++) tmp[j] = out[use[j] * n + k];
        tmp.sort(); const m = tmp.length ? tmp[tmp.length >> 1] : 0;
        for (let c = 0; c < nch; c++) out[c * n + k] -= m;
      }
    }
    return (S.proc[key] = out);
  }

  /* ---------------------------------------------------------------- geometry */
  const G = {};
  function geom() {
    const cv = $('fig'), W = Math.max(280, cv.parentElement.clientWidth), narrow = W < 560;
    const rows = rowsOf().length;
    G.W = W; G.L = narrow ? 78 : 118; G.R = narrow ? 44 : 64; G.rowH = narrow ? 46 : 60;
    G.evt = 36; G.tick = 14; G.pulse = 8; G.top = G.evt + G.tick + G.pulse + 6;
    G.H = G.top + rows * G.rowH + 30; G.pw = W - G.L - G.R; G.rows = rows;
    return G;
  }
  const t2x = t => G.L + (t - S.v0) / (S.v1 - S.v0) * G.pw;
  const x2t = x => S.v0 + (x - G.L) / G.pw * (S.v1 - S.v0);
  const rowY = i => G.top + (i + .5) * G.rowH;
  const pxPerUV = () => G.rowH / 300 * S.gain;

  /* ---------------------------------------------------------------- draw */
  let raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); drawOverview(); }); }
  function setup(cv, w, h) {
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    cv.style.height = h + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); return ctx;
  }
  function niceStep(span, target) {
    const raw = span / target, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }
  let hatch = null, hatchKey = '';
  function hatchPattern(ctx) {
    if (hatchKey !== C.axis) {
      const c = document.createElement('canvas'); c.width = c.height = 8; const x = c.getContext('2d');
      x.strokeStyle = C.axis; x.lineWidth = 1.2; x.beginPath(); x.moveTo(0, 8); x.lineTo(8, 0); x.moveTo(-2, 2); x.lineTo(2, -2); x.moveTo(6, 10); x.lineTo(10, 6); x.stroke();
      hatch = c; hatchKey = C.axis;
    }
    return ctx.createPattern(hatch, 'repeat');
  }
  function draw() {
    const cv = $('fig'); if (!C.ink) readColors();
    if (!S.h) { const ctx = setup(cv, Math.max(280, cv.parentElement.clientWidth), 200); setup($('ov'), cv.clientWidth, 200); return; }
    const h = S.h; geom();
    const ctx = setup(cv, G.W, G.H); setup($('ov'), G.W, G.H); $('ov').style.width = G.W + 'px';
    const fs = h.fs, n = h.n_samples, data = proc(), rows = rowsOf(), src = curSrc(), k = pxPerUV(), clampPx = G.rowH * 1.6;
    const plotT = G.top - 4, plotB = G.top + G.rows * G.rowH;
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const ts = h.trial_start - h.trial_start, te = h.trial_stop - h.trial_start;

    // dimmed pad regions
    ctx.save(); ctx.beginPath(); ctx.rect(G.L, plotT, G.pw, plotB - plotT); ctx.clip();
    ctx.fillStyle = C.muted; ctx.globalAlpha = .1;
    const xa = t2x(ts), xb = t2x(te);
    ctx.fillRect(G.L, plotT, Math.max(0, xa - G.L), plotB - plotT); ctx.fillRect(xb, plotT, G.L + G.pw - xb, plotB - plotT);
    ctx.globalAlpha = 1;
    // cleaned / silenced bands
    ctx.fillStyle = C.clean;
    for (const [a, b] of (src.cleaned || [])) { const x0 = t2x(tOf(a)), x1 = t2x(tOf(b)); ctx.fillRect(x0, plotT, x1 - x0, plotB - plotT); }
    if (src.silenced && src.silenced.length) {
      ctx.fillStyle = hatchPattern(ctx); ctx.globalAlpha = .55;
      for (const [a, b] of src.silenced) { const x0 = t2x(tOf(a)), x1 = t2x(tOf(b)); ctx.fillRect(x0, plotT, x1 - x0, plotB - plotT); }
      ctx.globalAlpha = 1;
    }
    // row guides
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < G.rows; i++) { const y = Math.round(rowY(i)) + .5; ctx.moveTo(G.L, y); ctx.lineTo(G.L + G.pw, y); }
    ctx.stroke();
    // trial boundaries
    ctx.strokeStyle = C.axis; ctx.setLineDash([2, 3]);
    for (const x of [xa, xb]) if (x >= G.L && x <= G.L + G.pw) { ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, plotT); ctx.lineTo(Math.round(x) + .5, plotB); ctx.stroke(); }
    ctx.setLineDash([]);

    // traces
    const s0f = (S.v0 + h.trial_start - h.t0) * fs, s1f = (S.v1 + h.trial_start - h.t0) * fs, spp = (s1f - s0f) / G.pw;
    ctx.strokeStyle = C.ink; ctx.globalAlpha = .8; ctx.lineWidth = 1; ctx.lineJoin = 'round';
    for (let r = 0; r < G.rows && r < h.channels.length; r++) {
      const cy = rowY(r), o = r * n, Y = v => cy - Math.max(-clampPx, Math.min(clampPx, v * k));
      ctx.beginPath();
      if (spp > 1.5) {
        for (let x = 0; x < G.pw; x++) {
          let a = Math.floor(s0f + x * spp), b = Math.floor(s0f + (x + 1) * spp);
          if (b < 0 || a >= n) continue; a = Math.max(0, a); b = Math.min(n - 1, Math.max(a, b));
          let mn = Infinity, mx = -Infinity;
          for (let j = a; j <= b; j++) { const v = data[o + j]; if (v < mn) mn = v; if (v > mx) mx = v; }
          const px = G.L + x + .5, ya = Y(mx), yb = Y(mn);
          ctx.moveTo(px, ya); ctx.lineTo(px, Math.max(yb, ya + .6));
        }
      } else {
        const a = Math.max(0, Math.floor(s0f) - 1), b = Math.min(n - 1, Math.ceil(s1f) + 1);
        for (let j = a; j <= b; j++) { const x = G.L + (j - s0f) / spp, y = Y(data[o + j]); if (j === a) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // spike highlights
    const pr = rows.findIndex(c => c.peak); const peakRow = pr >= 0 ? pr : Math.max(0, rows.findIndex(c => c.index === h.peak_channel));
    const hl = (r, s, color, w, alpha) => {
      const cy = rowY(r), o = r * n, a = Math.max(0, s - 12), b = Math.min(n - 1, s + 24); ctx.beginPath();
      for (let j = a; j <= b; j++) { const x = G.L + (j - s0f) / spp, y = cy - Math.max(-clampPx, Math.min(clampPx, data[o + j] * k)); if (j === a) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.strokeStyle = color; ctx.lineWidth = w; ctx.globalAlpha = alpha; ctx.stroke();
    };
    const i0 = lowerBound(h.spikes, s0f - 30), i1 = lowerBound(h.spikes, s1f + 14);
    const many = i1 - i0 > 1500;
    for (let i = i0; i < i1; i++) {
      const s = h.spikes[i];
      if (!many) for (let r = 0; r < G.rows && r < h.channels.length; r++) if (r !== peakRow) hl(r, s, C.accent, 1.6, .4);
    }
    for (let i = i0; i < i1; i++) if (peakRow < h.channels.length) hl(peakRow, h.spikes[i], C.accent, 2.4, 1);
    if (S.nb) {
      h.neighbours.forEach((nb, j) => {
        const r = rows.findIndex(c => c.index === nb.peak_channel); if (r < 0) return;
        const col = C.nb[j % C.nb.length], a0 = lowerBound(nb.spikes, s0f - 30), a1 = lowerBound(nb.spikes, s1f + 14);
        for (let i = a0; i < a1; i++) hl(r, nb.spikes[i], col, 2.2, .95);
      });
    }
    ctx.globalAlpha = 1; ctx.restore();

    // row labels
    ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    rows.forEach((c, r) => {
      const y = rowY(r), x = G.L - 8, pk = c.peak;
      ctx.fillStyle = pk ? C.accent : C.ink; ctx.font = (pk ? '700 ' : '500 ') + (G.W < 560 ? '11px' : '12px') + ' -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(G.W < 560 ? `ch ${c.index}${pk ? ' peak' : ''}` : `ch ${c.index}${pk ? ' · peak' : ''}`, x, y - 8);
      ctx.fillStyle = C.muted; ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(`${Math.round(c.y_um)} µm`, x, y + 5);
      if (c.bad) { ctx.fillStyle = C.danger; ctx.font = 'italic 10.5px -apple-system, sans-serif'; ctx.fillText('zeroed for sort', x, y + 18); }
    });

    // spike ticks and pulse strip
    const yT = G.evt + 2;
    ctx.fillStyle = C.muted; ctx.font = '10.5px -apple-system, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText('spikes', G.L - 8, yT + 6); ctx.fillText('stim', G.L - 8, yT + G.tick + 4);
    ctx.fillStyle = C.accent; let lastX = -9;
    for (let i = lowerBound(h.spikes, s0f - 2); i < h.spikes.length && h.spikes[i] <= s1f + 2; i++) {
      const x = G.L + (h.spikes[i] - s0f) / spp;
      if (x - lastX < 1) continue; lastX = x; ctx.fillRect(Math.round(x) - .5, yT, 1.5, 12);
    }
    if (h.pulses && h.pulses.length) {
      ctx.fillStyle = C.ink; ctx.globalAlpha = .7; let lx = -9;
      for (const p of h.pulses) {
        const x = t2x(p - h.trial_start); if (x < G.L || x > G.L + G.pw) continue;
        if (x - lx < 1) continue; lx = x; ctx.fillRect(Math.round(x), yT + G.tick, 1, G.pulse);
      }
      ctx.globalAlpha = 1;
    }

    // events
    ctx.save(); ctx.beginPath(); ctx.rect(G.L, 0, G.pw + G.R, G.H); ctx.clip();
    ctx.font = '10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const ends = [-1e9, -1e9, -1e9], evs = (h.events || []).slice().sort((a, b) => a.t - b.t);
    for (const e of evs) {
      const x = t2x(e.t - h.trial_start); if (x < G.L - 1 || x > G.L + G.pw + 1) continue;
      ctx.strokeStyle = C.ink; ctx.globalAlpha = e.this_trial ? .5 : .2; ctx.lineWidth = 1;
      const xi = Math.round(x) + .5; ctx.beginPath(); ctx.moveTo(xi, 0); ctx.lineTo(xi, plotB); ctx.stroke();
      const label = e.event.replace(/_/g, ' '), w = ctx.measureText(label).width;
      for (let lv = 0; lv < 3; lv++) if (x > ends[lv] + 4) {
        ctx.globalAlpha = e.this_trial ? 1 : .5; ctx.fillStyle = e.this_trial ? C.ink : C.muted;
        ctx.fillText(label, x + 3, lv * 11 + 1); ends[lv] = x + 3 + w; break;
      }
    }
    ctx.restore(); ctx.globalAlpha = 1;

    // axis
    const ay = plotB + 4; ctx.strokeStyle = C.axis; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(G.L, ay + .5); ctx.lineTo(G.L + G.pw, ay + .5);
    const step = niceStep(S.v1 - S.v0, G.pw / 90), dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.font = '11px -apple-system, sans-serif';
    for (let t = Math.ceil(S.v0 / step) * step; t <= S.v1 + 1e-9; t += step) {
      const x = Math.round(t2x(t)) + .5; ctx.moveTo(x, ay); ctx.lineTo(x, ay + 4); ctx.fillText((Math.abs(t) < 1e-9 ? 0 : t).toFixed(dec), x, ay + 6);
    }
    ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText('s from trial start', G.L + G.pw, ay + 18 - 0);

    // scale bar
    const cands = [10, 20, 50, 100, 200, 500, 1000, 2000]; let bar = cands[0];
    for (const c of cands) { bar = c; if (c * k >= 24) break; }
    const bx = G.W - G.R + 18, by = rowY(G.rows - 1);
    ctx.strokeStyle = C.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(bx, by - bar * k / 2); ctx.lineTo(bx, by + bar * k / 2); ctx.stroke();
    ctx.fillStyle = C.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText(bar >= 1000 ? `${bar / 1000} mV` : `${bar} µV`, bx, by + bar * k / 2 + 3);
    updateCounts(); drawHover();
  }

  function drawOverview() {
    const cv = $('over'), W = Math.max(280, cv.parentElement.clientWidth), H = 44, ctx = setup(cv, W, H);
    if (!S.h) return; const h = S.h; geom();
    const L = G.L, pw = G.pw, span = S.w1 - S.w0, X = t => L + (t - S.w0) / span * pw;
    ctx.fillStyle = C.grid; ctx.fillRect(L, 6, pw, H - 12);
    ctx.fillStyle = C.muted; ctx.globalAlpha = .18; ctx.fillRect(X(0), 6, X(h.trial_stop - h.trial_start) - X(0), H - 12); ctx.globalAlpha = 1;
    ctx.fillStyle = C.accent; let lx = -9;
    for (const s of h.spikes) { const x = X(tOf(s)); if (x - lx < 1) continue; lx = x; ctx.fillRect(Math.round(x), 11, 1, H - 22); }
    const a = X(S.v0), b = X(S.v1);
    ctx.fillStyle = C.accent; ctx.globalAlpha = .14; ctx.fillRect(a, 3, Math.max(2, b - a), H - 6); ctx.globalAlpha = 1;
    ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.strokeRect(a + .5, 3.5, Math.max(2, b - a), H - 7);
    ctx.fillStyle = C.muted; ctx.font = '10.5px -apple-system, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText('overview', L - 8, H / 2);
  }

  /* hover crosshair on the overlay canvas */
  function drawHover() {
    const ov = $('ov'), ctx = ov.getContext('2d'), dpr = window.devicePixelRatio || 1; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, G.W, G.H);
    const ro = $('readout');
    if (!S.h || !S.hover) { ro.textContent = ' '; return; }
    const { x, y } = S.hover; if (x < G.L || x > G.L + G.pw) { ro.textContent = ' '; return; }
    const h = S.h, t = x2t(x), r = Math.max(0, Math.min(G.rows - 1, Math.floor((y - G.top) / G.rowH)));
    ctx.strokeStyle = C.ink; ctx.globalAlpha = .55; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, G.evt); ctx.lineTo(Math.round(x) + .5, G.top + G.rows * G.rowH); ctx.stroke(); ctx.globalAlpha = 1;
    const row = rowsOf()[r], si = Math.round((t + h.trial_start - h.t0) * h.fs);
    let txt = `t = ${t >= 0 ? '+' : '−'}${Math.abs(t * 1000).toFixed(1)} ms from trial start`;
    if (y >= G.top && row && si >= 0 && si < h.n_samples) { const v = proc()[r * h.n_samples + si]; txt += ` · ch ${row.index} (${Math.round(row.y_um)} µm) · ${v.toFixed(1)} µV`; }
    ro.textContent = txt;
  }

  function fillLegend() {
    const el = $('legend'); el.textContent = ''; if (!S.h) return; const s = curSrc();
    const add = (cls, style, text) => { const sp = document.createElement('span'), i = document.createElement('i'); i.className = cls; if (style) i.style.background = style; sp.append(i, text); el.appendChild(sp); };
    add('line', 'var(--accent)', `unit ${S.h.unit} spikes (−0.4 to +0.8 ms)`);
    add('line', 'var(--fig-ink)', 'voltage, median-subtracted');
    if (s.cleaned && s.cleaned.length) add('clean', '', 'artifact-cleaned window');
    if (s.silenced && s.silenced.length) add('hatch', '', 'silenced for sort');
    if (S.nb) S.h.neighbours.forEach((nb, j) => add('line', C.nb ? C.nb[j % C.nb.length] : '#888', `unit ${nb.unit} (${nb.quality}, ch ${nb.peak_channel})`));
  }

  /* ---------------------------------------------------------------- view control */
  function setView(a, b) {
    const full = S.w1 - S.w0, minSpan = 0.002; let w = Math.max(minSpan, Math.min(full, b - a));
    a = Math.max(S.w0, Math.min(S.w1 - w, a)); S.v0 = a; S.v1 = a + w; schedule();
  }
  function zoomAt(t, f) { setView(t - (t - S.v0) * f, t + (S.v1 - t) * f); }
  function jump(dir) {
    if (!S.h || !S.h.spikes.length) return;
    const c = (S.v0 + S.v1) / 2, eps = 0.4 / S.h.fs; let best = null;
    const sp = S.h.spikes;
    if (dir > 0) { for (let i = 0; i < sp.length; i++) if (tOf(sp[i]) > c + eps) { best = tOf(sp[i]); break; } }
    else { for (let i = sp.length - 1; i >= 0; i--) if (tOf(sp[i]) < c - eps) { best = tOf(sp[i]); break; } }
    if (best == null) return; setView(best - 0.01, best + 0.01);
  }
  function whole() { setView(S.w0, S.w1); }
  function trialOnly() { if (S.h) setView(0, S.h.trial_stop - S.h.trial_start); }

  function bindFigure() {
    const cv = $('fig'), pts = new Map(); let pinch = null, drag = null;
    const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    cv.addEventListener('pointerdown', e => {
      if (!S.h) return; cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, pos(e));
      if (pts.size === 1) drag = { x: pos(e).x, v0: S.v0, v1: S.v1 };
      else if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.abs(a.x - b.x) || 1, v0: S.v0, v1: S.v1, mid: x2t((a.x + b.x) / 2) }; drag = null; }
    });
    cv.addEventListener('pointermove', e => {
      const p = pos(e); S.hover = e.pointerType === 'mouse' || pts.size === 0 ? p : null;
      if (pts.has(e.pointerId)) pts.set(e.pointerId, p);
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()], d = Math.abs(a.x - b.x) || 1, f = pinch.d / d, m = pinch.mid;
        setView(m - (m - pinch.v0) * f, m + (pinch.v1 - m) * f);
      } else if (drag && pts.has(e.pointerId)) {
        const dt = (p.x - drag.x) / G.pw * (drag.v1 - drag.v0); setView(drag.v0 - dt, drag.v1 - dt);
      } else drawHover();
    });
    const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (pts.size === 0) drag = null; else if (pts.size === 1) { const p = [...pts.values()][0]; drag = { x: p.x, v0: S.v0, v1: S.v1 }; } if (e.pointerType !== 'mouse') { S.hover = null; drawHover(); } };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && pts.size === 0) { S.hover = null; drawHover(); } });
    cv.addEventListener('dblclick', whole);
    cv.addEventListener('wheel', e => {
      if (!S.h) return; e.preventDefault();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { const dt = (e.deltaX || e.deltaY) / G.pw * (S.v1 - S.v0); setView(S.v0 + dt, S.v1 + dt); return; }
      zoomAt(x2t(pos(e).x), Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    }, { passive: false });

    const ov = $('over'); let od = null;
    ov.addEventListener('pointerdown', e => {
      if (!S.h) return; ov.setPointerCapture(e.pointerId); const r = ov.getBoundingClientRect(), x = e.clientX - r.left, span = S.w1 - S.w0, t = S.w0 + (x - G.L) / G.pw * span;
      if (t < S.v0 || t > S.v1) { const w = S.v1 - S.v0; setView(t - w / 2, t + w / 2); }
      od = { x, v0: S.v0, v1: S.v1 };
    });
    ov.addEventListener('pointermove', e => { if (!od) return; const r = ov.getBoundingClientRect(), dt = (e.clientX - r.left - od.x) / G.pw * (S.w1 - S.w0); setView(od.v0 + dt, od.v1 + dt); });
    const oup = () => { od = null; }; ov.addEventListener('pointerup', oup); ov.addEventListener('pointercancel', oup);
  }

  function setGain(f) { S.gain = Math.max(.05, Math.min(60, S.gain * f)); schedule(); }

  /* ---------------------------------------------------------------- wiring */
  function init() {
    applyTheme();
    document.querySelectorAll('#srcSeg button').forEach(b => b.addEventListener('click', () => setSrc(b.dataset.src)));
    $('refChk').addEventListener('change', e => { S.ref = e.target.checked; schedule(); });
    $('nbChk').addEventListener('change', e => { S.nb = e.target.checked; fillLegend(); schedule(); });
    $('bWhole').addEventListener('click', whole); $('bTrial').addEventListener('click', trialOnly);
    $('bPrevSp').addEventListener('click', () => jump(-1)); $('bNextSp').addEventListener('click', () => jump(1));
    $('gUp').addEventListener('click', () => setGain(1.4)); $('gDn').addEventListener('click', () => setGain(1 / 1.4));
    $('prevTrial').addEventListener('click', () => goTrial(-1)); $('nextTrial').addEventListener('click', () => goTrial(1));
    bindFigure();
    document.addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'checkbox') return;
      const w = S.v1 - S.v0; let used = true;
      switch (e.key) {
        case 'ArrowLeft': setView(S.v0 - w * .1, S.v1 - w * .1); break;
        case 'ArrowRight': setView(S.v0 + w * .1, S.v1 + w * .1); break;
        case 'ArrowUp': setGain(1.25); break;
        case 'ArrowDown': setGain(1 / 1.25); break;
        case '[': case ',': jump(-1); break;
        case ']': case '.': jump(1); break;
        case 'r': case 'R': if (S.h) setSrc(S.src === 'raw' ? 'sorted' : 'raw'); break;
        default: used = false;
      }
      if (used) e.preventDefault();
    });
    window.addEventListener('hashchange', load);
    new ResizeObserver(() => schedule()).observe($('stage'));
    load();
  }
  init();
})();
