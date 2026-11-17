'use strict';
/* electro_gui unit browser: filter, sort and browse the units of a unit annotation set (unitset.js, /api/annotations). */
(function () {
  const U = window.EGUnitSets, C = window.EGCore, esc = U.esc;
  const $ = id => document.getElementById(id);
  const clone = v => JSON.parse(JSON.stringify(v));

  // ----------------------------------------------------------------- theme
  const THEME_KEY = 'eg-theme';
  function themePref() { let p = null; try { p = localStorage.getItem(THEME_KEY); } catch (e) { /* private mode */ } return ['light', 'dark', 'auto'].includes(p) ? p : 'light'; }
  function applyTheme() {
    const p = themePref();
    const dark = p === 'dark' || (p === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('themeBtn').textContent = {light: '☀ Light', dark: '☾ Dark', auto: '◐ Auto'}[p];
  }
  $('themeBtn').addEventListener('click', () => {
    const next = {light: 'dark', dark: 'auto', auto: 'light'}[themePref()];
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode */ }
    applyTheme();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePref() === 'auto') applyTheme(); });

  // ----------------------------------------------------------------- state
  let ST = U.parseState(location.hash);
  let SETS = [], SET = null, INFO = null;
  let VIEW = [];            // filtered, sorted rows
  let lastHash = '';

  const PRESETS = {
    unit_profiles: [
      {label: 'Stim-modulated', f: {stim_class: ['fire more', 'fire less']}},
      {label: 'Real, clear response', f: {real_unit: ['yes', 'probably'], stim_read: ['clear'], stability_read: ['stable', 'partly']}},
    ],
  };
  const presetsFor = name => Object.entries(PRESETS).filter(([p]) => name.startsWith(p)).flatMap(([, v]) => v);
  const DEFAULT_COLS = ['stim_class', 'stim_mi', '_role', 'real_unit', 'stim_read', 'primary_role', 'well_isolated', 'snr', 'fixation_hz'];
  const DOT = {'fire more': '#e8590c', 'fire less': '#1971c2'};

  function commit(push) {
    const text = '#' + U.stateString(ST, true);
    if (text === location.hash) return;
    lastHash = text;
    try { push ? history.pushState(null, '', location.pathname + text) : history.replaceState(null, '', location.pathname + text); } catch (e) { /* ignore */ }
  }
  addEventListener('hashchange', () => {
    if (location.hash === lastHash) return;
    ST = U.parseState(location.hash);
    boot(true);
  });

  // ---------------------------------------------------------------- columns
  /** The columns of the set plus the virtual "Role" (role, else role_auto). */
  function columns() {
    const cols = SET.cols.slice();
    if (SET.byKey.has('role') && SET.byKey.has('role_auto')) cols.unshift({key: '_role', label: 'Role', group: 'Reading of the card', type: 'text', help: 'The reading of the card (role); the tests\' role where there is no reading.', virtual: true});
    return cols;
  }
  const getVal = (r, key) => (key === '_role' ? (U.isEmpty(r.role) ? r.role_auto : r.role) : r[key]);
  function visibleCols() {
    const all = columns(), by = new Map(all.map(c => [c.key, c]));
    const keys = ST.cols && ST.cols.length ? ST.cols : (SET.name.startsWith('unit_profiles') ? DEFAULT_COLS : all.filter(c => c.type !== 'text').slice(0, 7).map(c => c.key));
    return keys.filter(k => by.has(k)).map(k => by.get(k));
  }

  // ------------------------------------------------------------------ boot
  function msg(kind, html) {
    const m = $('msg');
    if (!kind) { m.hidden = true; return; }
    m.hidden = false; m.className = 'tr-msg-inline' + (kind === 'err' ? ' err' : ''); m.innerHTML = (kind === 'load' ? '<span class="tr-spin"></span>' : '') + html;
  }
  async function boot(again) {
    try {
      if (!again || !SETS.length) SETS = await U.sets();
      if (!SETS.length) { $('grid').hidden = true; $('setSel').innerHTML = ''; msg('err', 'No unit annotation sets were found. Sets live in <code>~/electro_gui_output/unit_annotations/</code> (<code>--annotations-dir</code>).'); return; }
      $('setSel').innerHTML = SETS.map(s => `<option value="${esc(s.name)}">${esc(s.title)}</option>`).join('');
      if (!SETS.some(s => s.name === ST.set)) { ST.set = SETS[0].name; commit(false); }
      $('setSel').value = ST.set;
      INFO = SETS.find(s => s.name === ST.set);
      msg('load', `Reading ${esc(INFO.title)}.`);
      SET = await U.rows(ST.set, null);
      msg(null);
      $('grid').hidden = false;
      $('qBox').value = ST.q;
      renderAll();
    } catch (e) { $('grid').hidden = true; msg('err', esc(e.message || String(e))); }
  }
  $('setSel').addEventListener('change', e => { ST = {set: e.target.value, session: '', sorting: null, f: {}, sort: '', q: '', sel: '', cols: null}; commit(true); boot(true); });

  // ----------------------------------------------------------------- render
  function renderAll() { renderInfo(); renderFilters(); renderTable(); renderDetail(); }
  function update(push) { commit(push); renderInfo(); renderFilters(); renderTable(); renderDetail(); }

  function renderInfo() {
    const s = INFO, src = s.source || {};
    const rep = U.reportUrl(s.report);
    const scoped = ST.session ? SET.rows.filter(r => r.session === ST.session) : SET.rows;
    const base = U.filter(SET, Object.assign({}, ST, {session: ''}));
    const chips = [`<button type="button" class="chip${!ST.session ? ' on' : ''}" data-s="">all <small>${base.length}</small></button>`]
      .concat(Object.keys(s.sessions).map(k => `<button type="button" class="chip${ST.session === k ? ' on' : ''}" data-s="${esc(k)}" title="${esc(k)}">${esc(U.shortSession(k))} <small>${base.filter(r => r.session === k).length}</small></button>`));
    $('setInfo').innerHTML = `<h1>${esc(s.title)}</h1><div class="desc">${esc(s.description)}</div>`
      + `<div class="meta">${src.folder ? `source: ${esc(src.folder)}${src.commit ? ' @ ' + esc(src.commit) : ''}` : ''}${rep ? ` · <a href="${esc(rep)}" target="_blank" rel="noopener">report ↗</a>` : ''} · ${scoped.length} units${s.has_cards ? `, ${s.n_cards} cards` : ''}</div>`
      + `<div class="ub-sess">${chips.join('')}</div>`;
    $('setInfo').querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => { ST.session = b.dataset.s; update(true); }));
  }

  function levelsOf(col) {
    const counts = new Map();
    for (const r of SET.rows) {
      const vs = col.type === 'tags' ? (U.tagsOf(r[col.key]).length ? U.tagsOf(r[col.key]) : ['']) : [U.isEmpty(r[col.key]) ? '' : String(r[col.key])];
      for (const v of vs) counts.set(v, (counts.get(v) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => (a[0] === '') - (b[0] === '') || b[1] - a[1] || a[0].localeCompare(b[0])).map(e => e[0]);
  }
  function renderFilters() {
    const presets = presetsFor(ST.set);
    $('presets').innerHTML = presets.map((p, i) => `<button type="button" class="chip${JSON.stringify(p.f) === JSON.stringify(ST.f) ? ' on' : ''}" data-p="${i}">${esc(p.label)}</button>`).join('');
    $('presets').querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => { ST.f = clone(presets[+b.dataset.p].f); update(true); }));
    const groups = [];
    for (const c of columns()) {
      if (c.type === 'text' || c.virtual) continue;
      let g = groups.find(x => x.name === c.group);
      if (!g) { g = {name: c.group, cols: []}; groups.push(g); }
      g.cols.push(c);
    }
    const root = $('fblocks'); root.textContent = '';
    for (const g of groups) {
      const gd = document.createElement('div'); gd.className = 'fb-group'; gd.innerHTML = `<h4>${esc(g.name)}</h4>`;
      for (const c of g.cols) gd.append(block(c));
      root.append(gd);
    }
  }
  function block(c) {
    const d = document.createElement('div'); d.className = 'fb' + (ST.f[c.key] !== undefined ? ' on' : '');
    d.innerHTML = `<label title="${esc(c.help || '')}">${esc(c.label)}</label>`;
    const others = U.filter(SET, ST, c.key);      // every filter but this column's own: the live counts
    if (c.type === 'category' || c.type === 'tags') {
      const lv = levelsOf(c), sel = Array.isArray(ST.f[c.key]) ? ST.f[c.key] : [];
      const cnt = new Map();
      for (const r of others) for (const v of (c.type === 'tags' ? (U.tagsOf(r[c.key]).length ? U.tagsOf(r[c.key]) : ['']) : [U.isEmpty(r[c.key]) ? '' : String(r[c.key])])) cnt.set(v, (cnt.get(v) || 0) + 1);
      const wrap = document.createElement('div'); wrap.className = 'chips';
      lv.forEach((v, i) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + (sel.includes(v) ? ' on' : '') + (!cnt.get(v) && !sel.includes(v) ? ' zero' : '');
        if (i >= 14 && !sel.includes(v)) b.hidden = true;
        b.innerHTML = `${esc(v === '' ? '(empty)' : v)} <small>${cnt.get(v) || 0}</small>`;
        b.addEventListener('click', () => { const s = sel.includes(v) ? sel.filter(x => x !== v) : [...sel, v]; if (s.length) ST.f[c.key] = s; else delete ST.f[c.key]; update(true); });
        wrap.append(b);
      });
      if (lv.length > 14) {
        const more = document.createElement('button'); more.type = 'button'; more.className = 'chip'; more.textContent = `+${lv.length - 14} more`;
        more.addEventListener('click', () => { wrap.querySelectorAll('[hidden]').forEach(x => { x.hidden = false; }); more.remove(); });
        wrap.append(more);
      }
      d.append(wrap);
    } else if (c.type === 'flag') {
      const seg = document.createElement('div'); seg.className = 'seg';
      const n = v => others.filter(r => r[c.key] === v).length;
      for (const [label, val, count] of [['any', undefined, others.length], ['yes', true, n(true)], ['no', false, n(false)]]) {
        const b = document.createElement('button'); b.type = 'button'; b.className = ST.f[c.key] === val ? 'on' : ''; b.innerHTML = `${label} <small>${count}</small>`;
        b.addEventListener('click', () => { if (val === undefined) delete ST.f[c.key]; else ST.f[c.key] = val; update(true); });
        seg.append(b);
      }
      d.append(seg);
    } else if (c.type === 'number') {
      const vals = SET.rows.map(r => r[c.key]).filter(Number.isFinite);
      if (!vals.length) { d.append(Object.assign(document.createElement('div'), {className: 'u-note', textContent: 'no values'})); return d; }
      const lo = Math.min(...vals), hi = Math.max(...vals), spec = ST.f[c.key] || {};
      const bins = new Array(16).fill(0), inb = new Array(16).fill(0);
      const bi = v => Math.min(15, Math.floor((v - lo) / (hi - lo || 1) * 16));
      for (const v of vals) bins[bi(v)]++;
      for (const r of others) if (Number.isFinite(r[c.key])) inb[bi(r[c.key])]++;
      const mx = Math.max(...bins, 1);
      const h = document.createElement('div'); h.className = 'hist';
      h.innerHTML = bins.map((b, i) => `<i class="${inb[i] ? 'in' : ''}" style="height:${Math.max(1, Math.round(26 * (inb[i] || b * 0.35) / mx))}px"></i>`).join('');
      d.append(h);
      const rng = document.createElement('div'); rng.className = 'rng';
      const fmt = v => String(+Number(v).toPrecision(4));
      rng.innerHTML = `<input type="number" step="any" data-b="min" value="${fmt(Number.isFinite(spec.min) ? spec.min : lo)}" aria-label="${esc(c.label)} minimum"> to <input type="number" step="any" data-b="max" value="${fmt(Number.isFinite(spec.max) ? spec.max : hi)}" aria-label="${esc(c.label)} maximum">`;
      rng.querySelectorAll('input').forEach(inp => inp.addEventListener('change', () => {
        const s = Object.assign({}, ST.f[c.key] || {}), v = parseFloat(inp.value), b = inp.dataset.b;
        const edge = b === 'min' ? lo : hi;
        if (!Number.isFinite(v) || Math.abs(v - edge) < 1e-9 * Math.max(1, Math.abs(edge)) || (b === 'min' ? v < lo : v > hi)) delete s[b]; else s[b] = v;
        if (Object.keys(s).length) ST.f[c.key] = s; else delete ST.f[c.key];
        update(true);
      }));
      d.append(rng);
    }
    return d;
  }
  $('clearBtn').addEventListener('click', () => { ST.f = {}; ST.q = ''; $('qBox').value = ''; update(true); });
  let qTimer = 0;
  $('qBox').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { ST.q = e.target.value.trim(); update(false); }, 200); });
  $('filterBtn').addEventListener('click', () => { const o = $('filters').classList.toggle('open'); $('filterBtn').setAttribute('aria-expanded', o); });

  // ------------------------------------------------------------------ table
  function cell(c, r) {
    const v = getVal(r, c.key);
    if (U.isEmpty(v)) return '<td></td>';
    const num = c.type === 'number';
    const dot = c.key === 'stim_class' && DOT[v] ? `<i class="dot" style="background:${DOT[v]}"></i>` : '';
    const text = c.type === 'tags' ? U.tagsOf(v).join(', ') : U.fmtValue(c, v);
    return `<td class="${num ? 'n' : ''}" title="${esc(c.type === 'text' || c.type === 'tags' ? String(v) : '')}">${dot}${esc(text)}</td>`;
  }
  function renderTable() {
    const cols = visibleCols();
    const sortKey = ST.sort ? ST.sort.replace(/^-/, '') : '';
    VIEW = U.sortRows(U.filter(SET, ST), ST.sort, ST.sort ? (r => getVal(r, sortKey)) : null);
    const total = ST.session ? SET.rows.filter(r => r.session === ST.session).length : SET.rows.length;
    $('count').textContent = `${VIEW.length} of ${total} units shown`;
    const CAP = 1500, shown = VIEW.slice(0, CAP);
    const head = `<thead><tr><th data-k="session">session${arrow('session')}</th><th data-k="unit" class="n">unit${arrow('unit')}</th>${cols.map(c => `<th data-k="${esc(c.key)}" class="${c.type === 'number' ? 'n' : ''}" title="${esc(c.help || c.label)}">${esc(c.label)}${arrow(c.key)}</th>`).join('')}</tr></thead>`;
    const body = shown.map(r => `<tr data-id="${esc(r.id)}"${r.id === ST.sel ? ' class="sel"' : ''}><td>${esc(U.shortSession(r.session))}</td><td class="n">${r.unit}</td>${cols.map(c => cell(c, r)).join('')}</tr>`).join('');
    $('tbl').innerHTML = head + `<tbody>${body}</tbody>`;
    $('tnote').textContent = VIEW.length > CAP ? `Showing the first ${CAP} of ${VIEW.length}; filter or sort to narrow the list.` : '';
    $('tbl').querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
      const k = th.dataset.k;
      ST.sort = ST.sort === k ? '-' + k : k;
      update(true);
    }));
    $('tbl').querySelector('tbody').addEventListener('click', e => { const tr = e.target.closest('tr'); if (tr) select(tr.dataset.id, true); });
    renderColsMenu(cols);
  }
  function arrow(k) { return ST.sort === k ? ' <span class="ar">▲</span>' : ST.sort === '-' + k ? ' <span class="ar">▼</span>' : ''; }
  function renderColsMenu(cols) {
    const on = new Set(cols.map(c => c.key)), groups = new Map();
    for (const c of columns()) { if (!groups.has(c.group)) groups.set(c.group, []); groups.get(c.group).push(c); }
    $('colsPop').innerHTML = [...groups].map(([g, list]) => `<h4>${esc(g)}</h4>` + list.map(c => `<label><input type="checkbox" data-c="${esc(c.key)}"${on.has(c.key) ? ' checked' : ''}> ${esc(c.label)}</label>`).join('')).join('');
    $('colsPop').querySelectorAll('input').forEach(i => i.addEventListener('change', () => {
      const keys = [...$('colsPop').querySelectorAll('input:checked')].map(x => x.dataset.c);
      ST.cols = keys.length ? keys : null;
      commit(false); renderTable();
      $('colsMenu').open = true;
    }));
  }

  // ----------------------------------------------------------------- detail
  function select(id, push) {
    ST.sel = id; commit(push);
    $('tbl').querySelectorAll('tr.sel').forEach(t => t.classList.remove('sel'));
    const tr = [...$('tbl').querySelectorAll('tbody tr')].find(t => t.dataset.id === id);
    if (tr) { tr.classList.add('sel'); tr.scrollIntoView({block: 'nearest'}); }
    renderDetail();
  }
  const listText = () => U.stateString(ST, false);
  function renderDetail() {
    const box = $('detail'), r = SET.rows.find(x => x.id === ST.sel);
    if (!r) { box.innerHTML = '<div class="u-empty">Click a unit to see its fields and card. ↑ ↓ move, Enter opens the unit page.</div>'; return; }
    const hasCard = SET.byKey.has('has_card') ? r.has_card === true : SET.hasCards;
    box.innerHTML = `<h2>Unit ${r.unit}</h2><div class="sub">${esc(r.session)}${r.sorting ? ' · ' + esc(r.sorting) : ' · default sorting'}</div>`
      + `<div class="btns"><a class="tr-btn" href="${esc(U.unitHref(r, listText()))}" target="_blank" rel="noopener">Unit page ↗</a><a class="tr-btn" href="${esc(U.explorerHref(r, C))}" target="_blank" rel="noopener">Explorer ↗</a></div>`
      + (hasCard ? `<a href="${esc(U.cardUrl(ST.set, r))}" target="_blank" rel="noopener"><img class="card" loading="lazy" alt="Card of unit ${r.unit}" src="${esc(U.cardUrl(ST.set, r))}"></a>` : '')
      + U.fieldsHtml(SET, r);
    const img = box.querySelector('img.card');
    if (img) img.addEventListener('error', () => img.closest('a').remove());
  }

  // --------------------------------------------------------------- keyboard
  addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target && e.target.tagName;
    const typing = t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
    if (e.key === '/' && !typing) { e.preventDefault(); $('qBox').focus(); $('qBox').select(); return; }
    if (e.key === 'Escape' && typing) { e.target.blur(); return; }
    if (typing || !VIEW.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = VIEW.findIndex(r => r.id === ST.sel), j = i < 0 ? 0 : Math.max(0, Math.min(VIEW.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      select(VIEW[j].id, false);
    } else if (e.key === 'Enter') {
      const r = VIEW.find(x => x.id === ST.sel);
      if (r) { e.preventDefault(); window.open(U.unitHref(r, listText()), '_blank', 'noopener'); }
    }
  });

  window.EGUnits = {state: () => clone(ST), view: () => VIEW.map(r => r.id), cols: () => visibleCols().map(c => c.key)};
  applyTheme();
  boot(false);
})();
