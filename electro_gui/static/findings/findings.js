/* electro_gui Findings page: every saved finding, its picture, notes and status (electro_gui/findings.py).
 * The saved settings and evidence are shown as they were saved and never edited here; the title, notes,
 * tags and status are.  "Open in electro_gui" reopens the figure, which compares its numbers again. */
(() => {
  'use strict';
  const C = window.EGCore;
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const STATUSES = ['lead', 'checking', 'supported', 'dropped'];
  const F = {all: [], errors: [], folder: '', status: null, q: '', open: null, dirty: false};

  async function getJSON(path, options) {
    const response = await fetch(path, options);
    const body = await response.json().catch(() => ({error: `HTTP ${response.status}`}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }
  const post = (path, body) => getJSON(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  let toastTimer = 0;
  function toast(message, error = false) {
    const t = $('toast');
    t.textContent = message; t.hidden = false; t.classList.toggle('error', error);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, error ? 6000 : 2600);
  }
  function applyTheme() {
    let pref = 'auto';
    try { pref = localStorage.getItem('eg-theme') || 'auto'; } catch (e) { /* private mode */ }
    const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }
  const shortSession = id => { const m = /^sub-([^_]+)_ses-(\d{4})_(\d{2})_(\d{2})(.*)$/.exec(id || ''); return m ? `${m[1]} · ${m[2]}-${m[3]}-${m[4]}${m[5]}` : (id || ''); };
  const when = iso => (iso ? new Date(iso).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'}) : '');
  const status = f => (STATUSES.includes(f.status) ? f.status : STATUSES[0]);
  // The figure's own words: its title (unit · channel · area · quality) and the alignment as its subtitle names it.
  function what(f) {
    const st = f.state || {}, ev = f.evidence || {};
    const align = (ev.subtitle || '').split(' · ')[0] || C.humanize(st.align || '');
    return `${st.mode === 'population' ? `${(st.roster || []).length} neurons` : ev.title || `unit ${st.unit}`} · ${align}`;
  }

  // ---------------------------------------------------------------- list
  async function load() {
    try {
      const r = await getJSON('/api/findings');
      F.all = r.findings; F.errors = r.errors || []; F.folder = r.folder || '';
    } catch (e) {
      F.all = []; F.errors = [];
      $('grid').innerHTML = '';
      $('empty').innerHTML = `<h3>Findings are not available</h3><p>${esc(e.message)}</p>`;
      $('empty').hidden = false;
      return;
    }
    renderList();
    const id = location.hash.slice(1);
    if (id && !F.open) openDetail(id);
  }
  function renderList() {
    const counts = Object.fromEntries(STATUSES.map(s => [s, F.all.filter(f => status(f) === s).length]));
    $('statusChips').innerHTML = [`<button type="button" class="chip${F.status ? '' : ' on'}" data-status="">all <small>${F.all.length}</small></button>`,
      ...STATUSES.map(s => `<button type="button" class="chip${F.status === s ? ' on' : ''}${counts[s] ? '' : ' zero'}" data-status="${s}">${s} <small>${counts[s]}</small></button>`)].join('');
    const shown = F.all.filter(f => (!F.status || status(f) === F.status) && C.findingMatches(f, F.q));
    $('count').textContent = shown.length === F.all.length ? `${F.all.length} finding${F.all.length === 1 ? '' : 's'}` : `${shown.length} of ${F.all.length}`;
    $('grid').innerHTML = shown.map(card).join('');
    const empty = $('empty');
    if (!F.all.length) {
      empty.innerHTML = '<h3>No findings yet</h3><p>In the explorer, <b>Save</b> (or ⋯ → Save finding) keeps the figure on screen with a title, your notes and the numbers it shows.</p><p><a class="primary" href="/" style="display:inline-flex;align-items:center;text-decoration:none">Open the explorer</a></p>';
      empty.hidden = false;
    } else if (!shown.length) {
      empty.innerHTML = '<h3>Nothing matches</h3><p>Every word of the search has to appear in the title, notes, tags, status, session, unit, channel, alignment or the machine it was saved on.</p>';
      empty.hidden = false;
    } else empty.hidden = true;
    const bad = F.errors.length ? `<span class="warn">${F.errors.length} file${F.errors.length > 1 ? 's' : ''} could not be read: ${esc(F.errors.slice(0, 3).map(e => `${e.file} (${e.error})`).join(' · '))}</span><br>` : '';
    $('foot').innerHTML = `${bad}Saved in <code>${esc(F.folder)}</code>, one JSON file and one picture per finding; each JSON is also a config file a deck can use as it stands.`;
  }
  function card(f) {
    const st = status(f), tags = (f.tags || []).map(t => `<span>${esc(t)}</span>`).join('');
    return `<button type="button" class="fcard${st === 'dropped' ? ' dropped' : ''}" data-id="${esc(f.id)}">` +
      `<div class="thumb">${f.has_thumbnail ? `<img loading="lazy" alt="" src="/api/findings/${encodeURIComponent(f.id)}/thumbnail">` : '<span>no picture</span>'}</div>` +
      `<div class="fc-body"><div class="fc-top"><span class="st st-${st}">${st}</span><b>${esc(f.title)}</b></div>` +
      `<small>${esc(shortSession((f.state || {}).session))} · ${esc(what(f))}</small>` +
      (f.note ? `<div class="fc-note">${esc(f.note)}</div>` : '') + (tags ? `<div class="fc-tags">${tags}</div>` : '') +
      `<small>saved ${esc(when(f.saved_at))}${f.saved_on ? ` on ${esc(f.saved_on)}` : ''}${f.updated_at ? ` · edited ${esc(when(f.updated_at))}` : ''}</small></div></button>`;
  }

  // -------------------------------------------------------------- detail
  function evidenceHtml(f) {
    const ev = f.evidence || {}, st = f.state || {}, src = ev.source || {}, sup = ev.support || {};
    const num = v => (Number.isFinite(v) ? C.fmtNum(v, 2) : '—');
    const u = ev.unit;
    const who = u ? `unit ${u.id} · ch ${u.peak_channel ?? '?'} · ${u.area || 'area ?'} · ${String(u.quality || '?').toUpperCase()} · ${u.n_spikes ?? '?'} spikes`
      : ev.roster ? `${ev.roster.length} neurons: ${ev.roster.slice(0, 30).map(r => `${r.id}${r.peak_channel !== null && r.peak_channel !== undefined ? ` (ch ${r.peak_channel})` : ''}`).join(', ')}${ev.roster.length > 30 ? ', …' : ''}` : '—';
    const supportBits = [`${sup.events ?? '?'} events`, `${sup.trials ?? '?'} trials`];
    if (sup.neurons) supportBits.push(`${sup.neurons} neurons`, `${sup.common_trials ?? '?'} trials shared by every neuron`);
    if (sup.filtered_out) supportBits.push(`${sup.filtered_out} filtered out`);
    if (sup.not_stable_or_complete) supportBits.push(`${sup.not_stable_or_complete} in trials not ${st.policy === 'all_complete' ? 'complete' : 'stable'}`);
    if (sup.window_leaves_stable_run) supportBits.push(`${sup.window_leaves_stable_run} whose window leaves the stable run`);
    if (sup.in_hidden_groups) supportBits.push(`${sup.in_hidden_groups} in hidden groups`);
    if (sup.yoked_trials) supportBits.push(`yoked to trials ${sup.yoked_trials.first}–${sup.yoked_trials.last}`);
    const rates = (ev.groups || []).some(g => g.rate_hz !== undefined);
    const rows = (ev.groups || []).map(g => `<tr><td>${esc(g.label)}${g.panel ? ` · ${esc(g.panel)}` : ''}</td><td class="n">${g.events ?? '—'}</td><td class="n">${g.trials ?? '—'}</td>` +
      (rates ? `<td class="n">${num(g.rate_hz)} ± ${num(g.rate_sem_hz)}</td>` : '') + '</tr>').join('');
    const cw = ev.count_window_s ? `[${ev.count_window_s.map(v => C.fmtNum(v)).join(', ')}) s` : '';
    const fit = ev.fit ? `<p>${esc(String(ev.fit.method || '').toUpperCase())} · ${ev.fit.components} components · rank ${ev.fit.rank ?? '?'} · ${ev.fit.fit_rows ?? '?'} fit rows · ` +
      `${ev.fit.converged === false ? 'did not converge' : 'converged'}${(ev.fit.dropped_constant_units || []).length ? ` · left out as constant: ${esc(ev.fit.dropped_constant_units.join(', '))}` : ''}</p>` +
      `<p>Variance explained by component: ${esc(((ev.fit.explained_variance_ratio || ev.fit.component_r2) || []).slice(0, 10).map(v => `${C.fmtNum(100 * v, 1)}%`).join(', ') || '—')}</p>` +
      ((ev.fit.warnings || []).length ? `<p>Warnings: ${esc(ev.fit.warnings.join(' · '))}</p>` : '') : '';
    const code = f.code || {};
    return `<div class="fd-sec"><h3>Saved evidence · as measured when it was saved, never edited</h3>` +
      `<p><b>${esc(ev.title || '')}</b>${ev.subtitle ? ` — ${esc(ev.subtitle)}` : ''}</p>` +
      `<p>${esc(st.session || '')} · session SHA256 <code>${esc(String(src.sha256 || 'not recorded').slice(0, 16))}${src.sha256 ? '…' : ''}</code>${(src.size_bytes || src.size) ? ` · ${((src.size_bytes || src.size) / 1e9).toFixed(2)} GB` : ''}</p>` +
      `<p>${esc(who)}</p><p>${esc(supportBits.join(' · '))}</p>` +
      (rows ? `<table class="fd-table"><thead><tr><th>group</th><th class="n">events</th><th class="n">trials</th>${rates ? `<th class="n">count window ${esc(cw)}, spikes/s (mean ± SEM)</th>` : ''}</tr></thead><tbody>${rows}</tbody></table>` : '') +
      fit + `<p>Saved ${esc(when(f.saved_at))}${f.saved_on ? ` on ${esc(f.saved_on)}` : ''} with electro_gui ${esc(code.electro_gui || '?')}` +
      `${code.commit ? ` at commit <code>${esc(code.commit.slice(0, 10))}</code>${code.dirty ? ' (with uncommitted changes)' : ''}` : ''}.</p></div>` +
      `<div class="fd-sec"><details><summary>Exact settings, as saved (the view state reopening restores)</summary><pre>${esc(JSON.stringify(st, null, 1))}</pre></details></div>`;
  }
  function openDetail(id) {
    const f = F.all.find(x => x.id === id);
    if (!f) { if (id) toast(`No finding ${id} in this folder.`, true); return; }
    F.open = f; F.dirty = false;
    if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
    const st = status(f);
    $('detail').innerHTML = `<div class="fd-head"><span class="st st-${st}" id="dStatusChip">${st}</span><h2 id="dTitleLabel">${esc(f.title)}</h2><button type="button" class="close" data-dclose aria-label="Close">×</button></div>` +
      `<div class="fd-body"><div class="fd-pic">${f.has_thumbnail ? `<img alt="The figure as saved" src="/api/findings/${encodeURIComponent(f.id)}/thumbnail">` : '<div class="none">No picture was saved with this finding.</div>'}</div>` +
      `<form class="fd-edit" id="dForm"><label><span>Title</span><input type="text" id="dTitle" maxlength="200" required value="${esc(f.title)}"></label>` +
      `<div class="row"><span>Status <small>your judgement, not a test</small></span><div class="seg" id="dStatus">${STATUSES.map(s => `<button type="button" data-st="${s}" class="${s === st ? 'on' : ''}">${s}</button>`).join('')}</div></div>` +
      `<label><span>Notes</span><textarea id="dNote" rows="7" maxlength="20000" placeholder="Why it matters · what this view does not control (eye movements?) · what to check next">${esc(f.note || '')}</textarea></label>` +
      `<label><span>Tags <small>separated by commas</small></span><input type="text" id="dTags" autocomplete="off" value="${esc((f.tags || []).join(', '))}"></label></form>` +
      evidenceHtml(f) + `</div>` +
      `<div class="fd-foot"><a class="primary" href="/#f=${encodeURIComponent(f.id)}">Open in electro_gui</a><button type="button" class="small" data-ddownload>Download file</button>` +
      `<span class="sp"></span><span class="msg" id="dMsg"></span><button type="button" class="small danger" data-ddelete>Delete…</button><button type="button" class="primary" id="dSave" disabled>Save changes</button></div>`;
    $('detail').hidden = false; $('scrim').hidden = false;
    const form = $('dForm');
    const mark = () => { F.dirty = true; $('dSave').disabled = false; $('dMsg').textContent = 'unsaved changes'; };
    form.addEventListener('input', mark);
    form.addEventListener('submit', e => { e.preventDefault(); saveDetail(); });
    form.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', () => { form.querySelectorAll('[data-st]').forEach(x => x.classList.toggle('on', x === b)); mark(); }));
  }
  function closeDetail(force = false) {
    if (!F.open) return true;
    if (!force && F.dirty && !confirm('Discard the changes to this finding?')) return false;
    F.open = null; F.dirty = false;
    $('detail').hidden = true; $('scrim').hidden = true; $('detail').innerHTML = '';
    history.replaceState(null, '', location.pathname);
    return true;
  }
  async function saveDetail() {
    const f = F.open, btn = $('dSave');
    if (!f || btn.disabled) return;
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const saved = await post(`/api/findings/${encodeURIComponent(f.id)}`, {title: $('dTitle').value, note: $('dNote').value,
        tags: $('dTags').value.split(','), status: ($('dStatus').querySelector('.on') || {dataset: {}}).dataset.st});
      F.all = F.all.map(x => (x.id === saved.id ? saved : x));
      F.open = saved; F.dirty = false;
      $('dMsg').textContent = `saved ${when(saved.updated_at)}`;
      $('dTitleLabel').textContent = saved.title;
      const chip = $('dStatusChip'); chip.className = `st st-${status(saved)}`; chip.textContent = status(saved);
      btn.textContent = 'Save changes';
      renderList();
      toast('Saved.');
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Save changes';
      toast(`Could not save: ${e.message}. Your text is still here.`, true);
    }
  }
  async function deleteOpen() {
    const f = F.open;
    if (!f || !confirm(`Delete “${f.title}”?\n\nIts files move to .deleted/ in the findings folder.`)) return;
    try {
      await post(`/api/findings/${encodeURIComponent(f.id)}`, {delete: true});
      F.all = F.all.filter(x => x.id !== f.id);
      closeDetail(true); renderList(); toast('Deleted.');
    } catch (e) { toast(`Could not delete: ${e.message}`, true); }
  }
  function download() {
    const f = F.open;
    if (!f) return;
    const {has_thumbnail, ...record} = f;   // eslint-disable-line no-unused-vars
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(record, null, 1)], {type: 'application/json'}));
    a.download = `${f.id}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // -------------------------------------------------------------- wiring
  function bind() {
    $('q').addEventListener('input', e => { F.q = e.target.value; renderList(); });
    $('statusChips').addEventListener('click', e => {
      const b = e.target.closest('[data-status]');
      if (!b) return;
      F.status = b.dataset.status || null; renderList();
    });
    $('grid').addEventListener('click', e => { const c = e.target.closest('[data-id]'); if (c) openDetail(c.dataset.id); });
    $('scrim').addEventListener('click', () => closeDetail());
    $('detail').addEventListener('click', e => {
      if (e.target.closest('[data-dclose]')) closeDetail();
      else if (e.target.closest('[data-ddelete]')) deleteOpen();
      else if (e.target.closest('[data-ddownload]')) download();
      else if (e.target.closest('#dSave')) saveDetail();
    });
    addEventListener('keydown', e => {
      if (e.key === 'Escape' && F.open) closeDetail();
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && F.open) { e.preventDefault(); saveDetail(); }
    });
    addEventListener('beforeunload', e => { if (F.dirty) { e.preventDefault(); e.returnValue = ''; } });
    addEventListener('hashchange', () => { const id = location.hash.slice(1); if (id && (!F.open || F.open.id !== id) && closeDetail()) openDetail(id); });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  }

  if (location.search.includes('token=')) history.replaceState(null, '', location.pathname + location.hash);
  applyTheme();
  bind();
  load();
})();
