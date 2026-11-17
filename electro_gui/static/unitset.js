'use strict';
/* Unit annotation sets, shared by the unit browser (units.html) and the unit page (unit.html).
 * Server side: electro_gui/unit_sets.py (/api/annotations...). Filters live in the address:
 *   #set=<name>[&session=..][&sorting=..][&f=<encodeURIComponent(JSON)>][&sort=<key>|-<key>][&q=<text>][&sel=<session>@<sorting>:<unit>][&cols=a,b]
 * f maps a column key to its filter: category / tags -> array of allowed values ("" = empty), flag -> true / false,
 * number -> {min, max} (either may be absent). */
window.EGUnitSets = (function () {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const cache = {sets: null, rows: new Map()};

  async function getJSON(path) {
    let r;
    try { r = await fetch(path); } catch (e) { throw new Error('Cannot reach electro_gui (is the server running?).'); }
    const body = await r.json().catch(() => ({error: `HTTP ${r.status}`}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }
  const q = obj => Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  async function sets() {
    if (!cache.sets) cache.sets = getJSON('/api/annotations').then(d => d.sets.filter(s => !s.error));
    return cache.sets;
  }
  /** Rows of one set as objects (keys: session, sorting, unit, every column, id), for one session or all. */
  async function rows(name, session) {
    const key = `${name}|${session || ''}`;
    if (!cache.rows.has(key)) {
      cache.rows.set(key, getJSON(`/api/annotations/${encodeURIComponent(name)}?${q({session: session || null})}`).then(d => {
        const cols = d.columns, byKey = new Map(cols.map(c => [c.key, c]));
        const list = d.rows.map(r => { const o = {}; d.keys.forEach((k, i) => { o[k] = r[i]; }); o.id = rowId(o); return o; });
        return {name, title: d.title, cols, byKey, rows: list, hasCards: d.has_cards};
      }));
    }
    return cache.rows.get(key);
  }
  const rowId = r => `${r.session}@${r.sorting || ''}:${r.unit}`;
  function parseId(id) {
    const m = /^(.*)@(.*):(\d+)$/.exec(id || '');
    return m ? {session: m[1], sorting: m[2], unit: Number(m[3])} : null;
  }

  // ------------------------------------------------------------------ state
  function parseState(text) {
    const p = new URLSearchParams(String(text || '').replace(/^#/, ''));
    let f = {};
    try { const j = JSON.parse(p.get('f') || '{}'); if (j && typeof j === 'object' && !Array.isArray(j)) f = j; } catch (e) { f = {}; }
    return {set: p.get('set') || '', session: p.get('session') || '', sorting: p.get('sorting'), f, sort: p.get('sort') || '', q: p.get('q') || '',
      sel: p.get('sel') || '', cols: p.get('cols') ? p.get('cols').split(',').filter(Boolean) : null};
  }
  function stateString(st, withView) {
    const parts = [];
    const add = (k, v) => parts.push(`${k}=${encodeURIComponent(v)}`);
    add('set', st.set);
    if (st.session) add('session', st.session);
    if (st.sorting) add('sorting', st.sorting);
    if (st.f && Object.keys(st.f).length) add('f', JSON.stringify(st.f));
    if (st.sort) add('sort', st.sort);
    if (st.q) add('q', st.q);
    if (withView) { if (st.sel) add('sel', st.sel); if (st.cols && st.cols.length) add('cols', st.cols.join(',')); }
    return parts.join('&');
  }

  // ---------------------------------------------------------------- filters
  const isEmpty = v => v === null || v === undefined || v === '';
  const tagsOf = v => (isEmpty(v) ? [] : String(v).split(';').map(s => s.trim()).filter(Boolean));
  function colMatches(col, value, spec) {
    if (spec === undefined || spec === null) return true;
    switch (col.type) {
      case 'category': return Array.isArray(spec) ? spec.length === 0 || spec.includes(isEmpty(value) ? '' : String(value)) : true;
      case 'tags': { if (!Array.isArray(spec) || !spec.length) return true; const t = tagsOf(value); return t.length ? t.some(x => spec.includes(x)) : spec.includes(''); }
      case 'flag': return spec === true || spec === false ? value === spec : true;
      case 'number': {
        if (typeof spec !== 'object' || Array.isArray(spec)) return true;
        const hasMin = Number.isFinite(spec.min), hasMax = Number.isFinite(spec.max);
        if (!hasMin && !hasMax) return true;
        if (!Number.isFinite(value)) return false;
        return (!hasMin || value >= spec.min) && (!hasMax || value <= spec.max);
      }
      default: return true;
    }
  }
  function textMatches(set, row, text) {
    const words = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = [row.session, String(row.unit)];
    for (const c of set.cols) if (c.type === 'text' || c.type === 'category' || c.type === 'tags') { const v = row[c.key]; if (!isEmpty(v)) hay.push(String(v)); }
    const s = hay.join('\n').toLowerCase();
    return words.every(w => s.includes(w));
  }
  /** Rows passing every filter and the text; `skip` names one column whose own filter is left out (for live counts). */
  function filter(set, st, skip) {
    const active = Object.entries(st.f || {}).filter(([k]) => set.byKey.has(k) && k !== skip);
    return set.rows.filter(r => (!st.session || r.session === st.session) && (!st.sorting || r.sorting === st.sorting) && active.every(([k, spec]) => colMatches(set.byKey.get(k), r[k], spec)) && textMatches(set, r, st.q));
  }
  function sortRows(list, key, getter) {
    if (!key) return list;
    const dir = key[0] === '-' ? -1 : 1, k = key.replace(/^-/, '');
    const get = getter || (r => r[k]);
    return list.map((r, i) => [r, i]).sort((a, b) => {
      const x = get(a[0]), y = get(b[0]), nx = isEmpty(x), ny = isEmpty(y);
      if (nx || ny) return nx && ny ? a[1] - b[1] : nx ? 1 : -1;     // empty values last either way
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : typeof x === 'boolean' ? Number(x) - Number(y) : String(x).localeCompare(String(y), undefined, {numeric: true});
      return c ? c * dir : a[1] - b[1];
    }).map(a => a[0]);
  }
  /** The filtered, sorted list a browser state stands for. */
  async function list(stateText) {
    const st = parseState(stateText);
    if (!st.set) throw new Error('The list has no set.');
    const set = await rows(st.set, st.session || null);
    return {set, st, rows: sortRows(filter(set, st), st.sort)};
  }

  // ---------------------------------------------------------------- display
  function fmtValue(col, v) {
    if (isEmpty(v)) return '';
    if (col.type === 'flag') return v ? 'yes' : 'no';
    if (col.type === 'number') { const a = Math.abs(v); return a === 0 ? '0' : a >= 1000 ? Math.round(v).toLocaleString('en-US') : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 0.01 ? v.toFixed(2) : v.toPrecision(2); }
    return String(v);
  }
  /** Every non-empty field, grouped like the browser; long text is folded. */
  function fieldsHtml(set, row) {
    const groups = [];
    for (const c of set.cols) {
      const v = row[c.key];
      if (isEmpty(v) || (c.type === 'flag' && v === false && c.key === 'has_card')) continue;
      let g = groups.find(x => x.name === c.group);
      if (!g) { g = {name: c.group, items: []}; groups.push(g); }
      let body;
      if (c.type === 'tags') body = tagsOf(v).map(t => `<span class="ut">${esc(t)}</span>`).join(' ');
      else if (c.type === 'text' && String(v).length > 240) body = `<details class="ufold"><summary>${esc(String(v).slice(0, 160))}…</summary>${esc(v)}</details>`;
      else body = esc(fmtValue(c, v));
      g.items.push(`<div class="uf" title="${esc(c.help || '')}"><dt>${esc(c.label)}</dt><dd>${body}</dd></div>`);
    }
    return groups.filter(g => g.items.length).map(g => `<h4>${esc(g.name)}</h4><dl class="ufl">${g.items.join('')}</dl>`).join('');
  }
  const cardUrl = (name, r) => `/api/annotations/${encodeURIComponent(name)}/card?${q({session: r.session, sorting: r.sorting || '', unit: r.unit})}`;
  /** The report in the Reports app: the same host as this page, port 8767 (works on the Mac and through the tailnet name). */
  const reportUrl = report => (report ? `${location.protocol}//${location.hostname}:8767${report}` : '');
  const unitHref = (r, listText) => `/unit.html#${new URLSearchParams({session: r.session, sorting: r.sorting || '', unit: String(r.unit), ...(listText ? {list: listText} : {})})}`;
  const explorerHref = (r, C) => `/#s=${C.encodeState({session: r.session, sorting: r.sorting || null, unit: Number(r.unit)})}`;
  const shortSession = s => (/_(\d{8})$/.exec(s) ? /_(\d{8})$/.exec(s)[1].slice(4) : s);

  return {esc, sets, rows, rowId, parseId, parseState, stateString, colMatches, filter, sortRows, list, fmtValue, fieldsHtml, cardUrl, reportUrl,
    unitHref, explorerHref, shortSession, isEmpty, tagsOf, getJSON};
})();
