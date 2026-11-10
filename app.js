'use strict';
/* Macro Tracker: local-first nutrition + weight log, synced to the user's own Google Sheet. */

const CFG = Object.assign({ GOOGLE_CLIENT_ID: '', SHEET_NAME: 'Macro Tracker Data' }, window.APP_CONFIG || {});
const DAY_START_HOUR = 3;     // a new "day" starts at 3 am
const MORNING_END_HOUR = 15;  // 3 am-3 pm = morning, 3 pm-3 am = night
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const BACKUP_REMINDER_DAYS = 14;

const NUTS = [
  { k: 'kcal', label: 'Calories', unit: 'kcal' },
  { k: 'carbs', label: 'Carbs', unit: 'g' },
  { k: 'protein', label: 'Protein', unit: 'g' },
  { k: 'fat', label: 'Fat', unit: 'g' },
  { k: 'fiber', label: 'Fiber', unit: 'g' },
  { k: 'sugar', label: 'Sugar', unit: 'g' },
  { k: 'sodium', label: 'Sodium', unit: 'mg' },
];
const NUT_KEYS = NUTS.map(n => n.k);
const MACROS = [
  { k: 'carbs', label: 'Carbs', type: 'limit', def: 200 },
  { k: 'protein', label: 'Protein', type: 'min', def: 150 },
  { k: 'fat', label: 'Fat', type: 'limit', def: 60 },
];

/* ---------------- helpers ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const num = v => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const r1 = n => Math.round(n * 10) / 10;
function fmt(n, unit) {
  if (n == null || !Number.isFinite(n)) return '–';
  const v = ((unit === 'g' || !unit) && Math.abs(n) < 10) ? r1(n) : Math.round(n);
  return unit ? `${v} ${unit}` : String(v);
}
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOf = (date = new Date()) => ymd(new Date(date.getTime() - DAY_START_HOUR * 3600e3));
const slotOf = (date = new Date()) => { const h = date.getHours(); return (h >= DAY_START_HOUR && h < MORNING_END_HOUR) ? 'morning' : 'night'; };
function parseDay(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return ymd(d); };
function fmtDay(s, long) {
  const today = dayOf();
  if (s === today) return 'Today';
  if (s === addDays(today, -1)) return 'Yesterday';
  return parseDay(s).toLocaleDateString(undefined, long ? { weekday: 'long', month: 'short', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' });
}
const fmtTime = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------------- storage ---------------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('mt_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mt_' + k, JSON.stringify(v)); return true; } catch { toast('Could not save on this device (storage blocked or full).'); return false; } },
};
// synced collections, each a map id -> record (deleted records are kept as tombstones for syncing)
const db = {
  foods: store.get('foods', {}),
  log: store.get('log', {}),
  weight: store.get('weight', {}),
  settings: store.get('settings', {}),
};
// device-only preferences (keys never leave this device)
const prefs = Object.assign({ geminiKey: '', geminiModel: '', usdaKey: '', sheetId: '', lastExport: 0, lastSync: 0, googleConnected: false }, store.get('prefs', {}));
const savePrefs = () => store.set('prefs', prefs);

function saveColl(coll) { store.set(coll, db[coll]); scheduleSync(); }
function upsert(coll, rec) { rec.updatedAt = Date.now(); rec.deleted = 0; db[coll][rec.id] = rec; saveColl(coll); return rec; }
function removeRec(coll, id) { const r = db[coll][id]; if (!r) return; r.deleted = 1; r.updatedAt = Date.now(); saveColl(coll); }
const live = coll => Object.values(db[coll]).filter(r => !r.deleted);
function getSetting(k, d) { const r = db.settings[k]; return (r && !r.deleted && r.value !== '' && r.value != null) ? r.value : d; }
function setSetting(k, v) { upsert('settings', { id: k, value: v }); }
const target = k => num(getSetting('target_' + k, MACROS.find(m => m.k === k).def));

/* ---------------- domain ---------------- */
function entryFactor(e) { return e.unit === 'g' ? (e.servingGrams ? e.amount / e.servingGrams : 0) : e.amount; }
function entryTotals(e) { const f = entryFactor(e); const o = {}; for (const k of NUT_KEYS) o[k] = (num(e['per_' + k]) || 0) * f; return o; }
function foodFactor(food, amount, unit) { return unit === 'g' ? (food.servingGrams ? amount / food.servingGrams : 0) : amount; }
function sumTotals(entries) { const t = Object.fromEntries(NUT_KEYS.map(k => [k, 0])); for (const e of entries) { const x = entryTotals(e); for (const k of NUT_KEYS) t[k] += x[k]; } return t; }
const entriesFor = day => live('log').filter(e => e.day === day).sort((a, b) => a.time.localeCompare(b.time));

function sevenDayAverages(endDay) {
  const days = []; for (let i = 0; i < 7; i++) days.push(addDays(endDay, -i));
  const logged = days.filter(d => entriesFor(d).length);
  if (!logged.length) return null;
  const t = Object.fromEntries(NUT_KEYS.map(k => [k, 0]));
  for (const d of logged) { const s = sumTotals(entriesFor(d)); for (const k of NUT_KEYS) t[k] += s[k]; }
  for (const k of NUT_KEYS) t[k] /= logged.length;
  t.days = logged.length; return t;
}

function macroStatus(m, value, tgt) {
  if (!tgt) return { cls: 'neutral', pct: 0 };
  const pct = value / tgt * 100;
  if (m.type === 'min') return { cls: pct >= 100 ? 'good' : 'neutral', pct };
  if (pct <= 100) return { cls: 'good', pct };
  if (pct <= 105) return { cls: 'warn', pct };
  return { cls: 'bad', pct };
}

function calorieCheck(f) {
  const kcal = num(f.kcal), c = num(f.carbs), p = num(f.protein), fat = num(f.fat);
  if (!kcal || c == null || p == null || fat == null) return null;
  const est = 4 * c + 4 * p + 9 * fat;
  const diff = Math.abs(est - kcal);
  if (diff > 20 && diff / kcal > 0.15) return `Check the numbers: carbs×4 + protein×4 + fat×9 = ${Math.round(est)} kcal, but the label says ${Math.round(kcal)} kcal.`;
  return null;
}

const weightFor = (day, slot) => { const r = db.weight[day + '_' + slot]; return r && !r.deleted ? r : null; };
function morningAvg(endDay) {
  const vals = []; for (let i = 0; i < 7; i++) { const w = weightFor(addDays(endDay, -i), 'morning'); if (w) vals.push(num(w.kg)); }
  return vals.length ? { avg: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length } : null;
}

/* ---------------- sheet (bottom modal) ---------------- */
let sheetCleanup = null;
function openSheet(html, mount) {
  closeSheet();
  const root = $('#sheetRoot');
  root.innerHTML = `<div class="sheet-backdrop"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const back = $('.sheet-backdrop', root);
  back.addEventListener('click', e => { if (e.target === back) closeSheet(); });
  $$('[data-close]', root).forEach(b => b.addEventListener('click', closeSheet));
  sheetCleanup = mount ? mount($('.sheet', root)) : null;
}
function closeSheet() {
  if (typeof sheetCleanup === 'function') { try { sheetCleanup(); } catch { /* ignore */ } }
  sheetCleanup = null; $('#sheetRoot').innerHTML = '';
}
const sheetHead = (title, sub) => `<div class="head"><div><h2>${esc(title)}</h2>${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}</div><button class="iconbtn close" data-close type="button" aria-label="Close">✕</button></div>`;

/* ---------------- navigation ---------------- */
const state = { tab: 'today', day: dayOf(), search: '' };
function go(tab) { state.tab = tab; render(); window.scrollTo(0, 0); }
$$('.tabbar button').forEach(b => b.addEventListener('click', () => { if (b.dataset.tab === 'today' && state.tab === 'today') state.day = dayOf(); go(b.dataset.tab); }));

function render() {
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  renderSyncBadge();
  const v = $('#view');
  if (state.tab === 'today') renderToday(v);
  else if (state.tab === 'add') renderAdd(v);
  else if (state.tab === 'weight') renderWeight(v);
  else renderSettings(v);
}

/* ---------------- Today ---------------- */
function banners() {
  let h = '';
  if (CFG.GOOGLE_CLIENT_ID && prefs.googleConnected && syncState === 'needs-auth') {
    h += `<div class="banner row between"><span>Google sign-in expired. Your log is safe on this device.</span><button class="btn" data-act="reconnect" type="button">Reconnect</button></div>`;
  }
  const hasData = live('log').length + live('weight').length > 0;
  const stale = Date.now() - (prefs.lastExport || 0) > BACKUP_REMINDER_DAYS * 864e5;
  if (hasData && !prefs.googleConnected && stale) {
    h += `<div class="banner">Your data is only on this device. <button class="linkbtn" data-act="gosettings" type="button">Connect Google or export a backup</button>.</div>`;
  }
  return h;
}

function renderToday(v) {
  const day = state.day, isToday = day === dayOf();
  const entries = entriesFor(day);
  const tot = sumTotals(entries);
  const avg = sevenDayAverages(day);
  const wm = weightFor(day, 'morning'), wn = weightFor(day, 'night');

  const bars = MACROS.map(m => {
    const tgt = target(m.k), st = macroStatus(m, tot[m.k], tgt);
    const label = m.type === 'min' ? 'goal' : 'limit';
    return `<div class="macro"><div class="row"><strong>${m.label}</strong><span class="muted small">${label}</span>
      <span class="val ${st.cls !== 'neutral' ? 't-' + st.cls : ''}">${fmt(tot[m.k])} / ${fmt(tgt)} g</span></div>
      <div class="bar"><i class="c-${st.cls}" style="width:${Math.min(100, st.pct)}%"></i></div></div>`;
  }).join('');

  const list = entries.length ? `<ul class="list">${entries.map(e => {
    const t = entryTotals(e);
    const amt = e.unit === 'g' ? `${fmt(e.amount)} g` : `${r1(e.amount)} serving${e.amount === 1 ? '' : 's'}`;
    return `<li><span class="time">${fmtTime(e.time)}</span><button class="item" data-entry="${esc(e.id)}" type="button">
      <div class="name">${esc(e.name)}</div>
      <div class="sub">${amt} · C ${fmt(t.carbs)} · P ${fmt(t.protein)} · F ${fmt(t.fat)} · ${fmt(t.kcal)} kcal</div></button></li>`;
  }).join('')}</ul>` : `<div class="empty">Nothing logged ${isToday ? 'yet today' : 'on this day'}.</div>`;

  v.innerHTML = `${banners()}
  <div class="daynav">
    <button class="iconbtn" data-act="prev" type="button" aria-label="Previous day">‹</button>
    <div class="title"><strong>${esc(fmtDay(day, true))}</strong>${!isToday ? `<button class="linkbtn small" data-act="today" type="button">Back to today</button>` : `<span class="muted small">${esc(parseDay(day).toLocaleDateString())}</span>`}</div>
    <button class="iconbtn" data-act="next" type="button" aria-label="Next day" ${isToday ? 'disabled' : ''}>›</button>
  </div>
  <div class="statusline" style="margin-bottom:12px">
    <button class="pill ${wm ? 'done' : ''}" data-act="weigh" data-slot="morning" type="button">☀️ Morning ${wm ? `<strong>${r1(num(wm.kg))}</strong> kg ✓` : '–'}</button>
    <button class="pill ${wn ? 'done' : ''}" data-act="weigh" data-slot="night" type="button">🌙 Night ${wn ? `<strong>${r1(num(wn.kg))}</strong> kg ✓` : '–'}</button>
  </div>
  <div class="card">${bars}
    <div class="row between small muted" style="margin-top:10px">
      <span><strong style="color:var(--text)">${fmt(tot.kcal)}</strong> kcal</span>
      <span>Fiber ${fmt(tot.fiber, 'g')} · Sugar ${fmt(tot.sugar, 'g')} · Sodium ${fmt(tot.sodium, 'mg')}</span>
    </div>
  </div>
  <div class="card small">${avg ? `<strong>7-day average</strong> <span class="muted">(${avg.days} logged day${avg.days === 1 ? '' : 's'})</span><br>
    Carbs ${fmt(avg.carbs)} g · Protein ${fmt(avg.protein)} g · Fat ${fmt(avg.fat)} g · ${fmt(avg.kcal)} kcal` : '<span class="muted">7-day averages appear once you log food.</span>'}</div>
  <div class="card"><div class="row between"><h3 style="margin:0">Food log</h3><button class="btn primary" data-act="add" type="button">+ Add food</button></div>${list}</div>`;

  v.onclick = e => {
    const b = e.target.closest('[data-act],[data-entry]'); if (!b) return;
    if (b.dataset.entry) return editEntrySheet(db.log[b.dataset.entry]);
    const a = b.dataset.act;
    if (a === 'prev') { state.day = addDays(state.day, -1); render(); }
    else if (a === 'next') { state.day = addDays(state.day, 1); render(); }
    else if (a === 'today') { state.day = dayOf(); render(); }
    else if (a === 'add') go('add');
    else if (a === 'weigh') weightSheet(state.day, b.dataset.slot);
    else if (a === 'reconnect') startGoogleAuth();
    else if (a === 'gosettings') go('settings');
  };
}

function editEntrySheet(e) {
  if (!e) return;
  const food = db.foods[e.foodId] && !db.foods[e.foodId].deleted ? db.foods[e.foodId] : null;
  openSheet(`${sheetHead(e.name, `${fmtDay(e.day)} · ${fmtTime(e.time)}`)}<div id="amt"></div>
    <div class="row" style="margin-top:12px"><button class="btn danger" id="del" type="button">Delete entry</button>
    ${food ? `<button class="btn" id="editFood" type="button">Edit food</button>` : ''}</div>`, sh => {
    const per = Object.fromEntries(NUT_KEYS.map(k => [k, num(e['per_' + k])]));
    const pseudo = { name: e.name, servingGrams: num(e.servingGrams), servingDesc: food?.servingDesc || '', ...per };
    mountAmount($('#amt', sh), pseudo, { amount: e.amount, unit: e.unit, day: e.day, cta: 'Save changes' }, (amount, unit, day) => {
      upsert('log', { ...e, amount, unit, day });
      closeSheet(); toast('Entry updated'); render();
    });
    $('#del', sh).onclick = () => { if (confirm(`Delete "${e.name}" from ${fmtDay(e.day)}?`)) { removeRec('log', e.id); closeSheet(); toast('Entry deleted'); render(); } };
    if (food) $('#editFood', sh).onclick = () => foodFormSheet({ ...food });
  });
}

/* ---------------- Add food ---------------- */
function foodListsHtml() {
  const foods = live('foods');
  const q = state.search.trim().toLowerCase();
  const row = f => `<li><button class="item" data-food="${esc(f.id)}" type="button"><div class="name">${esc(f.name)}${f.brand ? ` <span class="muted small">· ${esc(f.brand)}</span>` : ''}</div>
    <div class="sub">${esc(f.servingDesc || (f.servingGrams ? f.servingGrams + ' g' : '1 serving'))} · C ${fmt(num(f.carbs))} · P ${fmt(num(f.protein))} · F ${fmt(num(f.fat))} · ${fmt(num(f.kcal))} kcal</div></button>
    <button class="star ${f.favorite ? 'on' : ''}" data-star="${esc(f.id)}" type="button" aria-label="Favorite">${f.favorite ? '★' : '☆'}</button></li>`;
  let lists = '';
  if (q) {
    const m = foods.filter(f => (f.name + ' ' + (f.brand || '')).toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
    lists = `<div class="card"><h3>Saved foods matching "${esc(state.search)}"</h3>${m.length ? `<ul class="list">${m.map(row).join('')}</ul>` : '<div class="empty">No saved food matches. Try USDA search or enter it manually.</div>'}</div>`;
  } else {
    const fav = foods.filter(f => f.favorite).sort((a, b) => a.name.localeCompare(b.name));
    const recent = foods.filter(f => !f.favorite && f.lastUsed).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 15);
    if (fav.length) lists += `<div class="card"><h3>★ Favorites</h3><ul class="list">${fav.map(row).join('')}</ul></div>`;
    if (recent.length) lists += `<div class="card"><h3>Recent</h3><ul class="list">${recent.map(row).join('')}</ul></div>`;
    if (!fav.length && !recent.length) lists = `<div class="empty">Foods you add are saved here for one-tap logging.</div>`;
  }
  return lists;
}

function renderAdd(v) {
  const lists = foodListsHtml();
  v.innerHTML = `<div class="muted small" style="margin-bottom:8px">Logging to <strong>${esc(fmtDay(state.day))}</strong>${state.day !== dayOf() ? ` · <button class="linkbtn" data-act="today" type="button">switch to today</button>` : ''}</div>
  <div class="actions">
    <button class="action" data-act="barcode" type="button"><span class="ai">📷</span>Scan barcode</button>
    <button class="action" data-act="label" type="button"><span class="ai">🏷️</span>Photo of label</button>
    <button class="action" data-act="usda" type="button"><span class="ai">🔎</span>Search USDA</button>
    <button class="action" data-act="manual" type="button"><span class="ai">✏️</span>Enter manually</button>
  </div>
  <input class="input" id="foodSearch" type="search" placeholder="Search saved foods" value="${esc(state.search)}" style="margin-bottom:12px">
  <div id="foodLists">${lists}</div>`;

  const s = $('#foodSearch', v);
  s.oninput = () => { state.search = s.value; $('#foodLists', v).innerHTML = foodListsHtml(); };
  v.onclick = e => {
    const b = e.target.closest('[data-act],[data-food],[data-star]'); if (!b) return;
    if (b.dataset.star) { const f = db.foods[b.dataset.star]; upsert('foods', { ...f, favorite: f.favorite ? 0 : 1 }); $('#foodLists', v).innerHTML = foodListsHtml(); return; }
    if (b.dataset.food) return amountSheet(db.foods[b.dataset.food]);
    const a = b.dataset.act;
    if (a === 'today') { state.day = dayOf(); render(); }
    else if (a === 'barcode') barcodeSheet();
    else if (a === 'label') pickLabelPhoto();
    else if (a === 'usda') usdaSheet();
    else if (a === 'manual') foodFormSheet({ source: 'Manual' });
  };
}

/* amount chooser (servings or grams) with live macro preview */
function mountAmount(el, food, opts, onSubmit) {
  const hasGrams = !!num(food.servingGrams);
  let unit = opts.unit === 'g' && hasGrams ? 'g' : (opts.unit || 'serving');
  if (unit === 'g' && !hasGrams) unit = 'serving';
  let amount = opts.amount ?? (unit === 'g' ? num(food.servingGrams) : 1);
  const showDay = opts.day !== undefined;
  el.innerHTML = `<div class="muted small" style="margin-bottom:8px">1 serving = ${esc(food.servingDesc || (hasGrams ? food.servingGrams + ' g' : 'as entered'))}${hasGrams ? '' : ' · add the serving weight to the food to log by grams'}</div>
    <div class="row" style="margin-bottom:10px"><div class="seg"><button type="button" data-u="serving">Servings</button><button type="button" data-u="g" ${hasGrams ? '' : 'disabled'}>Grams</button></div></div>
    <div class="grid2"><label class="field"><span id="amtLabel">Amount</span><input id="amtIn" type="number" inputmode="decimal" step="any" min="0"></label>
    ${showDay ? `<label class="field"><span>Day</span><input id="dayIn" type="date" max="${dayOf()}" value="${esc(opts.day)}"></label>` : ''}</div>
    <div class="card small" id="amtPreview" style="margin-bottom:10px"></div>
    <button class="btn primary block" id="amtGo" type="button">${esc(opts.cta || 'Log it')}</button>`;
  const inp = $('#amtIn', el);
  const sync = () => {
    $$('.seg button', el).forEach(b => b.classList.toggle('on', b.dataset.u === unit));
    $('#amtLabel', el).textContent = unit === 'g' ? 'Grams eaten' : 'Servings eaten';
    inp.value = amount ?? '';
    preview();
  };
  const preview = () => {
    const a = num(inp.value) || 0, f = foodFactor(food, a, unit);
    const t = k => (num(food[k]) || 0) * f;
    $('#amtPreview', el).innerHTML = `Carbs <strong>${fmt(t('carbs'))} g</strong> · Protein <strong>${fmt(t('protein'))} g</strong> · Fat <strong>${fmt(t('fat'))} g</strong> · ${fmt(t('kcal'))} kcal`;
  };
  $$('.seg button', el).forEach(b => b.onclick = () => {
    const nu = b.dataset.u; if (nu === unit) return;
    const cur = num(inp.value) || 0, g = num(food.servingGrams);
    amount = nu === 'g' ? r1(cur * g) : r1(cur / g);
    unit = nu; sync();
  });
  inp.oninput = preview;
  $('#amtGo', el).onclick = () => {
    const a = num(inp.value);
    if (!a || a <= 0) { toast('Enter an amount greater than 0'); return; }
    const day = showDay ? ($('#dayIn', el).value || opts.day) : undefined;
    onSubmit(a, unit, day);
  };
  sync();
}

function amountSheet(food) {
  openSheet(`${sheetHead(food.name, food.brand || '')}<div id="amt"></div>
    <div class="row" style="margin-top:10px"><button class="linkbtn small" id="editFood" type="button">Edit food details</button></div>`, sh => {
    mountAmount($('#amt', sh), food, { unit: food.lastUnit || (food.source === 'USDA' ? 'g' : 'serving'), cta: `Log to ${fmtDay(state.day)}` }, (amount, unit) => {
      logFood(food, amount, unit);
      closeSheet(); state.search = ''; toast(`Logged ${food.name}`); state.tab = 'today'; render();
    });
    $('#editFood', sh).onclick = () => foodFormSheet({ ...food });
  });
}

function logFood(food, amount, unit) {
  const now = new Date();
  const e = { id: uid(), day: state.day, time: now.toISOString(), foodId: food.id, name: food.name, amount, unit, servingGrams: num(food.servingGrams) || '' };
  for (const k of NUT_KEYS) e['per_' + k] = num(food[k]) ?? '';
  upsert('log', e);
  upsert('foods', { ...food, lastUsed: Date.now(), lastUnit: unit });
}

/* food create/edit form = the confirm screen */
function foodFormSheet(f, extra = {}) {
  const isNew = !f.id;
  const val = k => (f[k] ?? '') === '' ? '' : f[k];
  openSheet(`${sheetHead(isNew ? 'Check the values' : 'Edit food', f.source ? `Source: ${f.source}` : '')}
    ${extra.imageUrl ? `<img class="preview-img" src="${extra.imageUrl}" alt="Label photo">` : ''}
    ${extra.note ? `<div class="banner">${esc(extra.note)}</div>` : ''}
    <form id="ff">
      <label class="field"><span>Name</span><input name="name" required value="${esc(val('name'))}" placeholder="e.g. Greek yogurt"></label>
      <div class="grid2">
        <label class="field"><span>Brand (optional)</span><input name="brand" value="${esc(val('brand'))}"></label>
        <label class="field"><span>Barcode (optional)</span><input name="barcode" inputmode="numeric" value="${esc(val('barcode'))}"></label>
        <label class="field"><span>Serving (as on label)</span><input name="servingDesc" value="${esc(val('servingDesc'))}" placeholder="e.g. 1 cup (240 ml)"></label>
        <label class="field"><span>Serving weight (g)</span><input name="servingGrams" type="number" inputmode="decimal" step="any" min="0" value="${esc(val('servingGrams'))}"></label>
      </div>
      <div class="muted small" style="margin:2px 0 8px">Values <strong>per serving</strong>:</div>
      <div class="grid3">${NUTS.map(n => `<label class="field"><span>${n.label} (${n.unit})</span><input name="${n.k}" type="number" inputmode="decimal" step="any" min="0" value="${esc(val(n.k))}"></label>`).join('')}</div>
      <div id="kcalWarn"></div>
      <button class="btn primary block" type="submit">${isNew ? 'Save & choose amount' : 'Save food'}</button>
      ${!isNew ? `<button class="btn danger block" id="delFood" type="button" style="margin-top:8px">Delete this saved food</button>` : ''}
    </form>`, sh => {
    const form = $('#ff', sh);
    const check = () => {
      const fd = Object.fromEntries(new FormData(form));
      const w = calorieCheck(fd);
      $('#kcalWarn', sh).innerHTML = w ? `<div class="banner">${esc(w)}</div>` : '';
    };
    form.oninput = check; check();
    form.onsubmit = ev => {
      ev.preventDefault();
      const fd = Object.fromEntries(new FormData(form));
      if (!fd.name.trim()) { toast('Give the food a name'); return; }
      const rec = { ...f, id: f.id || uid(), name: fd.name.trim(), brand: fd.brand.trim(), barcode: fd.barcode.trim(), servingDesc: fd.servingDesc.trim(), servingGrams: num(fd.servingGrams) ?? '', source: f.source || 'Manual', favorite: f.favorite || 0, lastUsed: f.lastUsed || 0 };
      for (const n of NUTS) rec[n.k] = num(fd[n.k]) ?? '';
      upsert('foods', rec);
      if (isNew) amountSheet(rec); else { closeSheet(); toast('Food saved'); render(); }
    };
    const del = $('#delFood', sh);
    if (del) del.onclick = () => { if (confirm(`Delete "${f.name}" from saved foods? Past log entries stay.`)) { removeRec('foods', f.id); closeSheet(); toast('Food deleted'); render(); } };
  });
}

/* ---------------- Barcode ---------------- */
function barcodeSheet() {
  let scanner = null, done = false;
  openSheet(`${sheetHead('Scan barcode', 'Point the camera at the barcode')}
    <div id="reader"></div>
    <div class="row" style="margin-top:10px"><input class="input grow" id="codeIn" inputmode="numeric" placeholder="…or type the barcode number"><button class="btn primary" id="codeGo" type="button">Look up</button></div>
    <div class="row" style="margin-top:8px"><button class="linkbtn small" id="codePhoto" type="button">Take a photo of the barcode instead</button></div>
    <div id="codeStatus" class="muted small" style="margin-top:8px"></div>`, sh => {
    const status = m => { $('#codeStatus', sh).textContent = m; };
    const found = code => { if (done) return; done = true; stop().then(() => handleBarcode(code)); };
    const stop = async () => { if (scanner) { try { if (scanner.isScanning) await scanner.stop(); scanner.clear(); } catch { /* ignore */ } scanner = null; } };
    $('#codeGo', sh).onclick = () => { const c = $('#codeIn', sh).value.replace(/\D/g, ''); if (c.length < 6) return toast('Enter the digits under the barcode'); found(c); };
    $('#codePhoto', sh).onclick = () => { stop(); $('#barcodePhotoInput').click(); };
    if (!window.Html5Qrcode) { status('Barcode scanner could not load (offline?). Type the number instead.'); return stop; }
    try {
      const F = window.Html5QrcodeSupportedFormats;
      scanner = new Html5Qrcode('reader', { verbose: false, formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128] });
      scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: (w, h) => ({ width: Math.min(300, w * 0.9), height: Math.min(150, h * 0.6) }) }, text => found(text), () => {})
        .catch(err => status('Camera unavailable: ' + (err?.message || err) + '. Type the number or take a photo instead.'));
    } catch (err) { status('Camera unavailable. Type the number instead.'); }
    return () => { done = true; stop(); };
  });
}

$('#barcodePhotoInput').addEventListener('change', async ev => {
  const file = ev.target.files[0]; ev.target.value = ''; if (!file) return;
  if (!window.Html5Qrcode) return toast('Barcode reader not loaded');
  const tmp = document.createElement('div'); tmp.id = 'tmpReader'; tmp.hidden = true; document.body.appendChild(tmp);
  try { const r = new Html5Qrcode('tmpReader'); const code = await r.scanFile(file, false); r.clear(); handleBarcode(code); }
  catch { toast('No barcode found in that photo. Try again closer, or type the number.', 4000); }
  finally { tmp.remove(); }
});

async function handleBarcode(code) {
  code = String(code).replace(/\D/g, '');
  const local = live('foods').find(f => f.barcode && f.barcode.replace(/^0+/, '') === code.replace(/^0+/, ''));
  if (local) return amountSheet(local);
  openSheet(`${sheetHead('Looking up ' + code)}<div class="spinner"></div>`);
  try {
    const draft = await lookupOpenFoodFacts(code);
    if (draft) return foodFormSheet(draft, { note: 'Found on Open Food Facts. Compare with the package before saving.' });
    openSheet(`${sheetHead('Not in the database', 'Barcode ' + code)}
      <p>This product isn't on Open Food Facts yet. Take a photo of the nutrition label instead.</p>
      <button class="btn primary block" id="lbl" type="button">📷 Photo of label</button>
      <button class="btn block" id="man" type="button" style="margin-top:8px">✏️ Enter manually</button>`, sh => {
      $('#lbl', sh).onclick = () => { pendingBarcode = code; closeSheet(); pickLabelPhoto(); };
      $('#man', sh).onclick = () => foodFormSheet({ source: 'Manual', barcode: code });
    });
  } catch (e) {
    openSheet(`${sheetHead('Lookup failed')}<p>${esc(e.message)}</p><button class="btn block" data-close type="button">OK</button>`);
  }
}

async function lookupOpenFoodFacts(code) {
  const tries = [code]; if (code.length === 12) tries.push('0' + code);
  for (const c of tries) {
    let r;
    try { r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(c)}.json?fields=product_name,brands,nutriments,serving_size,serving_quantity`); }
    catch { throw new Error('Could not reach Open Food Facts. Check your connection.'); }
    if (r.status === 404) continue;
    if (!r.ok) throw new Error('Open Food Facts error ' + r.status);
    const j = await r.json();
    if (!j.product || j.status === 0) continue;
    const p = j.product, n = p.nutriments || {};
    const sq = num(p.serving_quantity);
    const key = { kcal: 'energy-kcal', carbs: 'carbohydrates', protein: 'proteins', fat: 'fat', fiber: 'fiber', sugar: 'sugars', sodium: 'sodium' };
    const get = (k, basis) => {
      let v = num(n[`${key[k]}_${basis}`]);
      if (k === 'kcal' && v == null) { const kj = num(n[`energy_${basis}`]); if (kj != null) v = kj / 4.184; }
      if (k === 'sodium' && v != null) v *= 1000; // g -> mg
      return v;
    };
    const draft = { source: 'Open Food Facts', barcode: c, name: p.product_name || '', brand: (p.brands || '').split(',')[0].trim() };
    const hasServing = get('carbs', 'serving') != null || get('kcal', 'serving') != null;
    if (hasServing) {
      draft.servingDesc = p.serving_size || ''; draft.servingGrams = sq ?? '';
      for (const k of NUT_KEYS) draft[k] = round2(get(k, 'serving') ?? (sq && get(k, '100g') != null ? get(k, '100g') * sq / 100 : null));
    } else if (sq) {
      draft.servingDesc = p.serving_size || `${sq} g`; draft.servingGrams = sq;
      for (const k of NUT_KEYS) { const v = get(k, '100g'); draft[k] = v == null ? '' : round2(v * sq / 100); }
    } else {
      draft.servingDesc = '100 g'; draft.servingGrams = 100;
      for (const k of NUT_KEYS) draft[k] = round2(get(k, '100g'));
    }
    return draft;
  }
  return null;
}
const round2 = v => v == null || !Number.isFinite(v) ? '' : Math.round(v * 100) / 100;

/* ---------------- Label photo -> Gemini ---------------- */
let pendingBarcode = '';
function pickLabelPhoto() {
  if (!prefs.geminiKey) {
    openSheet(`${sheetHead('Add your Gemini key first')}<p>Reading label photos uses Google's free Gemini API. Add your own key in Settings (it takes about 2 minutes and stays on this device).</p>
      <button class="btn primary block" id="toSet" type="button">Open Settings</button>`, sh => { $('#toSet', sh).onclick = () => { closeSheet(); go('settings'); }; });
    return;
  }
  $('#labelInput').click();
}

$('#labelInput').addEventListener('change', async ev => {
  const file = ev.target.files[0]; ev.target.value = ''; if (!file) return;
  const barcode = pendingBarcode; pendingBarcode = '';
  openSheet(`${sheetHead('Reading the label…')}<div class="spinner"></div><p class="muted small" style="text-align:center">This usually takes a few seconds.</p>`);
  try {
    const { b64, url } = await imageToJpeg(file, 1400);
    const d = await readLabelWithGemini(b64);
    const per100 = d.basis === '100g';
    const draft = {
      source: 'Label photo', barcode, name: d.name || '', brand: '',
      servingDesc: per100 ? '100 g' : (d.serving_desc || ''),
      servingGrams: per100 ? 100 : (num(d.serving_grams) ?? ''),
      kcal: num(d.calories) ?? '', carbs: num(d.carbs_g) ?? '', protein: num(d.protein_g) ?? '', fat: num(d.fat_g) ?? '',
      fiber: num(d.fiber_g) ?? '', sugar: num(d.sugar_g) ?? '', sodium: num(d.sodium_mg) ?? '',
    };
    let note = 'Compare these numbers with the photo before saving.';
    if (d.confidence === 'low') note = 'The label was hard to read — please check every number. ' + (d.notes || '');
    else if (d.notes) note += ' Note: ' + d.notes;
    if (per100) note += ' This label only gives values per 100 g, so one "serving" here means 100 g.';
    foodFormSheet(draft, { imageUrl: url, note });
  } catch (e) {
    openSheet(`${sheetHead('Could not read the label')}<p>${esc(e.message)}</p>
      <button class="btn primary block" id="retry" type="button">Try another photo</button>
      <button class="btn block" id="man" type="button" style="margin-top:8px">Enter manually</button>`, sh => {
      $('#retry', sh).onclick = () => { closeSheet(); pendingBarcode = barcode; pickLabelPhoto(); };
      $('#man', sh).onclick = () => foodFormSheet({ source: 'Manual', barcode });
    });
  }
});

function imageToJpeg(file, maxSide) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL('image/jpeg', 0.85);
      resolve({ b64: data.split(',')[1], url: data });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not open that image.')); };
    img.src = url;
  });
}

const LABEL_PROMPT = `You are reading a photo of a packaged food's nutrition facts label.
Return ONLY a JSON object with these keys:
- "name": product name if visible on the photo, else ""
- "serving_desc": serving size exactly as printed (e.g. "2/3 cup (55g)"), else ""
- "serving_grams": weight in grams (or ml) of ONE serving as a number, null if not printed
- "basis": "serving" if the numbers you return are per serving, "100g" if the label only gives values per 100 g / 100 ml
- "calories": kcal (if only kJ is printed, divide by 4.184)
- "carbs_g": total carbohydrate in grams
- "protein_g": protein in grams
- "fat_g": total fat in grams
- "fiber_g": dietary fiber in grams
- "sugar_g": total sugars in grams
- "sodium_mg": sodium in mg (if only salt in g is printed, sodium_mg = salt_g * 400)
- "confidence": "high", "medium" or "low" depending on how clearly you could read the numbers
- "notes": short note about anything unusual (e.g. "two columns, used per serving"), else ""
Rules: If both per-serving and per-100g columns exist, use per serving. If there are "as sold" and "prepared" columns, use "as sold". Use null for any value you cannot read. Never guess a number you cannot see.`;

async function readLabelWithGemini(b64) {
  const model = (prefs.geminiModel || DEFAULT_GEMINI_MODEL).trim();
  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': prefs.geminiKey.trim() },
      body: JSON.stringify({
        contents: [{ parts: [{ text: LABEL_PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    });
  } catch { throw new Error('Could not reach Gemini. Check your connection.'); }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    if (r.status === 429) throw new Error('Gemini free quota is used up for now. Try again later, or enter the values manually.');
    if (r.status === 400 && /API key/i.test(t)) throw new Error('Gemini rejected the API key. Check it in Settings.');
    if (r.status === 403) throw new Error('Gemini refused the request (403). Check that your API key is correct and the Gemini API is enabled for it.');
    if (r.status === 404) throw new Error(`Gemini model "${model}" was not found. Change the model name in Settings.`);
    throw new Error(`Gemini error ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini returned no answer. Try a clearer photo.');
  try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { throw new Error('Gemini answered in an unexpected format. Try again.'); }
}

/* ---------------- USDA search ---------------- */
function usdaSheet() {
  openSheet(`${sheetHead('Search USDA', 'Whole foods like "banana", "chicken breast", "rice cooked"')}
    <form id="uf" class="row"><input class="input grow" id="uq" type="search" placeholder="Search foods" autofocus><button class="btn primary" type="submit">Search</button></form>
    <div id="ur" style="margin-top:10px"></div>`, sh => {
    $('#uf', sh).onsubmit = async ev => {
      ev.preventDefault();
      const q = $('#uq', sh).value.trim(); if (!q) return;
      const out = $('#ur', sh); out.innerHTML = '<div class="spinner"></div>';
      try {
        const res = await usdaSearch(q);
        if (!res.length) { out.innerHTML = '<div class="empty">No matches. Try simpler words.</div>'; return; }
        out.innerHTML = `<div class="muted small">Values per 100 g</div><ul class="list">${res.map((f, i) => `<li><button class="item" data-i="${i}" type="button"><div class="name">${esc(f.name)}</div>
          <div class="sub">C ${fmt(f.carbs)} · P ${fmt(f.protein)} · F ${fmt(f.fat)} · ${fmt(f.kcal)} kcal</div></button></li>`).join('')}</ul>`;
        out.onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; const f = res[b.dataset.i]; foodFormSheet({ ...f, source: 'USDA', servingDesc: '100 g', servingGrams: 100 }, { note: 'Values are per 100 g. You can rename it (e.g. "Banana") before saving.' }); };
      } catch (e) { out.innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; }
    };
  });
}

async function usdaSearch(q) {
  const key = (prefs.usdaKey || 'DEMO_KEY').trim();
  const p = new URLSearchParams({ api_key: key, query: q, pageSize: '25', dataType: 'Foundation,SR Legacy' });
  let r;
  try { r = await fetch('https://api.nal.usda.gov/fdc/v1/foods/search?' + p); }
  catch { throw new Error('Could not reach USDA. Check your connection.'); }
  if (r.status === 429) throw new Error('USDA rate limit reached. Add your own free USDA key in Settings, or try later.');
  if (!r.ok) throw new Error('USDA error ' + r.status);
  const j = await r.json();
  return (j.foods || []).map(f => {
    const by = {}; for (const n of f.foodNutrients || []) by[String(n.nutrientNumber)] = num(n.value);
    const o = { name: titleCase(f.description || ''), carbs: by['205'], protein: by['203'], fat: by['204'], fiber: by['291'], sugar: by['269'], sodium: by['307'] };
    o.kcal = by['208'] ?? by['958'] ?? by['957'] ?? ((o.carbs ?? 0) * 4 + (o.protein ?? 0) * 4 + (o.fat ?? 0) * 9);
    for (const k of NUT_KEYS) o[k] = round2(o[k]);
    return o;
  });
}
const titleCase = s => s.charAt(0) + s.slice(1).toLowerCase();

/* ---------------- Weight ---------------- */
function weightSheet(day, slot, existing) {
  day = day || dayOf(); slot = slot || slotOf();
  const cur = existing || weightFor(day, slot);
  openSheet(`${sheetHead(cur ? 'Edit weight' : 'Log weight')}
    <form id="wf">
      <label class="field"><span>Weight (kg)</span><input name="kg" type="number" inputmode="decimal" step="0.1" min="20" max="400" required value="${cur ? esc(cur.kg) : ''}" autofocus></label>
      <div class="grid2">
        <label class="field"><span>Day</span><input name="day" type="date" max="${dayOf()}" value="${esc(day)}"></label>
        <label class="field"><span>Slot</span><select name="slot"><option value="morning" ${slot === 'morning' ? 'selected' : ''}>☀️ Morning</option><option value="night" ${slot === 'night' ? 'selected' : ''}>🌙 Night</option></select></label>
      </div>
      <button class="btn primary block" type="submit">Save</button>
      ${cur ? `<button class="btn danger block" id="wdel" type="button" style="margin-top:8px">Delete this reading</button>` : ''}
    </form>`, sh => {
    const form = $('#wf', sh);
    form.onsubmit = ev => {
      ev.preventDefault();
      const fd = Object.fromEntries(new FormData(form));
      const kg = num(fd.kg); if (!kg) return toast('Enter your weight');
      const id = fd.day + '_' + fd.slot;
      const clash = weightFor(fd.day, fd.slot);
      if (clash && (!cur || clash.id !== cur.id)) {
        if (!confirm(`Replace ${fmtDay(fd.day)} ${fd.slot}'s ${r1(num(clash.kg))} kg with ${r1(kg)} kg?`)) return;
      }
      if (cur && cur.id !== id) removeRec('weight', cur.id);
      upsert('weight', { id, day: fd.day, slot: fd.slot, kg: r1(kg), time: new Date().toISOString() });
      closeSheet(); toast(`Saved ${r1(kg)} kg`); render();
    };
    const d = $('#wdel', sh);
    if (d) d.onclick = () => { if (confirm('Delete this weight reading?')) { removeRec('weight', cur.id); closeSheet(); render(); } };
  });
}

function renderWeight(v) {
  const today = dayOf();
  const wm = weightFor(today, 'morning'), wn = weightFor(today, 'night');
  const avg = morningAvg(today), prev = morningAvg(addDays(today, -7));
  const goal = num(getSetting('goal_weight', ''));
  const nowSlot = slotOf();

  let summary = '<div class="muted">Log a few mornings to see your trend.</div>';
  if (avg) {
    const delta = prev ? avg.avg - prev.avg : null;
    summary = `<div class="muted small">7-day average (mornings)</div>
      <div class="big-number">${r1(avg.avg)} <span style="font-size:18px">kg</span></div>
      <div class="small">${delta != null ? `${delta > 0 ? '▲' : delta < 0 ? '▼' : '='} ${Math.abs(r1(delta))} kg vs previous 7 days` : `<span class="muted">Based on ${avg.n} morning${avg.n === 1 ? '' : 's'}</span>`}
      ${goal ? ` · ${Math.abs(r1(avg.avg - goal))} kg ${avg.avg > goal ? 'above' : 'below'} goal (${r1(goal)} kg)` : ''}</div>`;
  }

  const days = []; for (let i = 0; i < 30; i++) days.push(addDays(today, -i));
  const rows = days.map(d => ({ d, m: weightFor(d, 'morning'), n: weightFor(d, 'night') })).filter(x => x.m || x.n);

  v.innerHTML = `${banners()}
  <div class="statusline" style="margin-bottom:12px">
    <button class="pill ${wm ? 'done' : ''}" data-slot="morning" type="button">☀️ Morning ${wm ? `<strong>${r1(num(wm.kg))}</strong> kg ✓` : '– tap to log'}</button>
    <button class="pill ${wn ? 'done' : ''}" data-slot="night" type="button">🌙 Night ${wn ? `<strong>${r1(num(wn.kg))}</strong> kg ✓` : '– tap to log'}</button>
  </div>
  <button class="btn primary block" data-act="log" type="button" style="margin-bottom:12px">Log ${nowSlot === 'morning' ? '☀️ morning' : '🌙 night'} weight</button>
  <div class="card">${summary}<div style="margin-top:10px">${weightChart(today, goal)}</div>
    <div class="muted small">Dots: morning weights · line: 7-day average${goal ? ' · dashed: goal' : ''}. Night weights are not part of the trend.</div></div>
  <div class="card"><h3>Last 30 days</h3>${rows.length ? `<ul class="list">${rows.map(x => `<li><span class="grow">${esc(fmtDay(x.d))}</span>
    <button class="pill" style="flex:none;min-width:92px" data-day="${x.d}" data-slot="morning" type="button">☀️ ${x.m ? r1(num(x.m.kg)) : '–'}</button>
    <button class="pill" style="flex:none;min-width:92px" data-day="${x.d}" data-slot="night" type="button">🌙 ${x.n ? r1(num(x.n.kg)) : '–'}</button></li>`).join('')}</ul>` : '<div class="empty">No weights yet.</div>'}</div>`;

  v.onclick = e => {
    const b = e.target.closest('[data-act],[data-slot]'); if (!b) return;
    if (b.dataset.act === 'log') return weightSheet(today, nowSlot);
    if (b.dataset.act === 'reconnect') return startGoogleAuth();
    if (b.dataset.act === 'gosettings') return go('settings');
    weightSheet(b.dataset.day || today, b.dataset.slot);
  };
}

function weightChart(endDay, goal) {
  const N = 30, W = 320, H = 150, L = 30, R = 8, T = 8, B = 18;
  const pts = [];
  for (let i = N - 1; i >= 0; i--) {
    const d = addDays(endDay, -i), w = weightFor(d, 'morning'), a = morningAvg(d);
    pts.push({ x: N - 1 - i, d, w: w ? num(w.kg) : null, a: a ? a.avg : null });
  }
  const vals = pts.flatMap(p => [p.w, p.a]).filter(v => v != null);
  if (goal) vals.push(goal);
  if (!pts.some(p => p.w != null)) return '<div class="empty small">The chart appears after your first morning weigh-in.</div>';
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 2) { const m = (hi + lo) / 2; lo = m - 1; hi = m + 1; }
  lo = Math.floor(lo * 2) / 2 - 0.5; hi = Math.ceil(hi * 2) / 2 + 0.5;
  const X = x => L + x / (N - 1) * (W - L - R), Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const ticks = [lo, (lo + hi) / 2, hi];
  let path = '', pen = false;
  for (const p of pts) { if (p.a == null) { pen = false; continue; } path += `${pen ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.a).toFixed(1)}`; pen = true; }
  const lbl = s => parseDay(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Morning weight over the last 30 days">
    ${ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--border)" stroke-width="1"/><text x="${L - 4}" y="${Y(t) + 3}" text-anchor="end">${r1(t)}</text>`).join('')}
    ${goal ? `<line x1="${L}" x2="${W - R}" y1="${Y(goal)}" y2="${Y(goal)}" stroke="var(--good)" stroke-width="1.5" stroke-dasharray="4 4"/>` : ''}
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${pts.filter(p => p.w != null).map(p => `<circle cx="${X(p.x)}" cy="${Y(p.w)}" r="3" fill="var(--surface)" stroke="var(--muted)" stroke-width="1.5"><title>${lbl(p.d)}: ${r1(p.w)} kg</title></circle>`).join('')}
    <text x="${L}" y="${H - 4}">${lbl(pts[0].d)}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">${lbl(pts[N - 1].d)}</text>
  </svg>`;
}

/* ---------------- Settings ---------------- */
function renderSettings(v) {
  const g = CFG.GOOGLE_CLIENT_ID;
  const googleBlock = !g
    ? `<p class="muted small">Google sync isn't set up in this copy of the app yet. Whoever hosts the app adds a Google Client ID to <code>config.js</code> (see SETUP.md).</p>`
    : prefs.googleConnected
      ? `<p class="small">Connected. ${prefs.lastSync ? 'Last sync: ' + new Date(prefs.lastSync).toLocaleString() : 'Not synced yet.'}</p>
         <div class="row" style="flex-wrap:wrap">
           <button class="btn primary" data-act="syncnow" type="button">Sync now</button>
           ${prefs.sheetId ? `<a class="btn" href="https://docs.google.com/spreadsheets/d/${esc(prefs.sheetId)}" target="_blank" rel="noopener">Open my sheet</a>` : ''}
           <button class="btn danger" data-act="disconnect" type="button">Disconnect</button>
         </div>
         <p class="muted small">Editing values in the sheet is fine; please don't rename tabs or move columns.</p>`
      : `<p class="small">Sign in to keep a copy of your data in a Google Sheet in your own Drive. This also syncs your phone and laptop.</p>
         <button class="btn primary" data-act="connect" type="button">Connect Google</button>`;

  v.innerHTML = `
  <form class="card" id="tf"><h3>Daily targets</h3>
    <div class="grid3">${MACROS.map(m => `<label class="field"><span>${m.label} (g) · ${m.type === 'min' ? 'goal' : 'limit'}</span><input name="${m.k}" type="number" inputmode="decimal" min="0" step="any" value="${esc(target(m.k))}"></label>`).join('')}</div>
    <label class="field"><span>Goal weight (kg, optional)</span><input name="goal" type="number" inputmode="decimal" min="0" step="0.1" value="${esc(getSetting('goal_weight', ''))}"></label>
    <div class="muted small" style="margin-bottom:10px">Carbs and fat turn amber up to 5% over the limit, then red. Protein turns green once you reach the goal.</div>
    <button class="btn primary" type="submit">Save targets</button>
  </form>

  <div class="card"><h3>Google Sheet sync</h3>${googleBlock}</div>

  <form class="card" id="kf"><h3>Label reading (Gemini)</h3>
    <p class="small muted">Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. It stays on this device only.</p>
    <label class="field"><span>Gemini API key</span><input name="geminiKey" type="password" autocomplete="off" value="${esc(prefs.geminiKey)}"></label>
    <label class="field"><span>Model (change only if Gemini says the model is not found)</span><input name="geminiModel" placeholder="${DEFAULT_GEMINI_MODEL}" value="${esc(prefs.geminiModel)}"></label>
    <label class="field"><span>USDA API key (optional; the shared demo key has low limits)</span><input name="usdaKey" type="password" autocomplete="off" value="${esc(prefs.usdaKey)}"></label>
    <p class="small muted">Free USDA key: <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener">fdc.nal.usda.gov/api-key-signup</a></p>
    <button class="btn primary" type="submit">Save keys</button>
  </form>

  <div class="card"><h3>Backup & sharing</h3>
    <div class="stack">
      <button class="btn block" data-act="exportall" type="button">Export everything (backup file)</button>
      <button class="btn block" data-act="exportfoods" type="button">Export saved foods (to share with a friend)</button>
      <button class="btn block" data-act="import" type="button">Import a file</button>
    </div>
    <p class="muted small">${prefs.lastExport ? 'Last export: ' + new Date(prefs.lastExport).toLocaleDateString() : 'Never exported.'} Importing merges with what's here; nothing is deleted.</p>
  </div>
  <p class="muted small" style="text-align:center">A new day starts at 3 am. Weights from 3 am–3 pm count as morning, 3 pm–3 am as night.</p>`;

  $('#tf', v).onsubmit = ev => {
    ev.preventDefault(); const fd = Object.fromEntries(new FormData(ev.target));
    for (const m of MACROS) { const n = num(fd[m.k]); if (n != null && n > 0) setSetting('target_' + m.k, n); }
    setSetting('goal_weight', num(fd.goal) ?? '');
    toast('Targets saved');
  };
  $('#kf', v).onsubmit = ev => {
    ev.preventDefault(); const fd = Object.fromEntries(new FormData(ev.target));
    prefs.geminiKey = fd.geminiKey.trim(); prefs.geminiModel = fd.geminiModel.trim(); prefs.usdaKey = fd.usdaKey.trim();
    savePrefs(); toast('Keys saved on this device');
  };
  v.onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'connect') startGoogleAuth();
    else if (a === 'syncnow') { if (getToken()) sync(); else startGoogleAuth(); }
    else if (a === 'disconnect') { if (confirm('Disconnect Google? Data stays on this device and in your sheet.')) { prefs.googleConnected = false; prefs.sheetId = ''; clearToken(); savePrefs(); setSyncState('off'); render(); } }
    else if (a === 'exportall') exportData('all');
    else if (a === 'exportfoods') exportData('foods');
    else if (a === 'import') $('#importInput').click();
  };
}

/* ---------------- Export / import ---------------- */
async function exportData(kind) {
  const data = kind === 'foods' ? { foods: live('foods').map(f => ({ ...f, favorite: 0, lastUsed: 0 })) } : { foods: Object.values(db.foods), log: Object.values(db.log), weight: Object.values(db.weight), settings: Object.values(db.settings) };
  const payload = JSON.stringify({ app: 'macro-tracker', version: 1, kind, exportedAt: new Date().toISOString(), data }, null, 1);
  const name = kind === 'foods' ? `macro-foods-${dayOf()}.json` : `macro-backup-${dayOf()}.json`;
  const file = new File([payload], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); }
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
    if (kind === 'all') { prefs.lastExport = Date.now(); savePrefs(); render(); }
  } catch (e) { if (e.name !== 'AbortError') toast('Export failed: ' + e.message); }
}

$('#importInput').addEventListener('change', async ev => {
  const file = ev.target.files[0]; ev.target.value = ''; if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    if (j.app !== 'macro-tracker' || !j.data) throw new Error('This is not a Macro Tracker file.');
    let n = 0;
    for (const coll of ['foods', 'log', 'weight', 'settings']) {
      for (const r of j.data[coll] || []) {
        if (!r || !r.id) continue;
        const l = db[coll][r.id];
        if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) { db[coll][r.id] = r; n++; }
      }
      store.set(coll, db[coll]);
    }
    scheduleSync(); render(); toast(`Imported ${n} item${n === 1 ? '' : 's'}`);
  } catch (e) { toast('Import failed: ' + e.message, 4000); }
});

/* ---------------- Google auth (redirect flow, no server) ---------------- */
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');
function getToken() { const t = store.get('gtoken', null); return t && t.exp > Date.now() ? t.value : null; }
function clearToken() { try { localStorage.removeItem('mt_gtoken'); } catch { /* ignore */ } }
function startGoogleAuth() {
  if (!CFG.GOOGLE_CLIENT_ID) return toast('Google sync is not configured (config.js).');
  const st = uid(); store.set('oauth_state', st);
  const p = new URLSearchParams({ client_id: CFG.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE, include_granted_scopes: 'true', state: st });
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p;
}
function handleAuthRedirect() {
  if (!location.hash || location.hash.length < 2) return;
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has('access_token') && !h.has('error')) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (h.get('error')) { toast('Google sign-in was cancelled.'); return; }
  if (h.get('state') !== store.get('oauth_state', '')) { toast('Google sign-in could not be verified. Please try again.'); return; }
  store.set('gtoken', { value: h.get('access_token'), exp: Date.now() + (Number(h.get('expires_in')) || 3600) * 1000 - 60000 });
  prefs.googleConnected = true; savePrefs();
  toast('Google connected');
}

/* ---------------- Google Sheet sync ---------------- */
const NUMERIC = new Set(['updatedAt', 'deleted', 'servingGrams', 'amount', 'kg', 'favorite', 'lastUsed', ...NUT_KEYS, ...NUT_KEYS.map(k => 'per_' + k)]);
const SCHEMA = {
  Log: { coll: 'log', cols: ['day', 'time', 'name', 'amount', 'unit', 'kcal', 'carbs', 'protein', 'fat', 'fiber', 'sugar', 'sodium', 'id', 'updatedAt', 'deleted', 'foodId', 'servingGrams', ...NUT_KEYS.map(k => 'per_' + k)], computed: new Set(NUT_KEYS) },
  Weight: { coll: 'weight', cols: ['day', 'slot', 'kg', 'time', 'id', 'updatedAt', 'deleted'] },
  Foods: { coll: 'foods', cols: ['name', 'brand', 'servingDesc', 'servingGrams', ...NUT_KEYS, 'barcode', 'source', 'favorite', 'lastUsed', 'lastUnit', 'id', 'updatedAt', 'deleted'] },
  Settings: { coll: 'settings', cols: ['id', 'value', 'updatedAt', 'deleted'] },
};
const TABS = Object.keys(SCHEMA);

function recsToRows(tab) {
  const s = SCHEMA[tab];
  let recs = Object.values(db[s.coll]);
  if (tab === 'Log') recs.sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time));
  if (tab === 'Weight') recs.sort((a, b) => a.id.localeCompare(b.id));
  return [s.cols, ...recs.map(r => {
    const tot = tab === 'Log' ? entryTotals(r) : null;
    return s.cols.map(c => {
      if (tot && s.computed.has(c)) return r.deleted ? '' : round2(tot[c]);
      const v = r[c]; return v == null ? '' : v;
    });
  })];
}
function rowsToRecs(tab, rows) {
  if (!rows.length) return [];
  const s = SCHEMA[tab], head = rows[0];
  return rows.slice(1).map(row => {
    const r = {};
    head.forEach((c, i) => {
      if (!c || (s.computed && s.computed.has(c))) return;
      let v = row[i]; if (v === undefined) v = '';
      if (NUMERIC.has(c)) v = v === '' ? '' : (Number(v) || 0);
      else if (c === 'value') v = v; // settings keep their type
      else v = String(v);
      r[c] = v;
    });
    if (s.coll === 'settings' && typeof r.value === 'string' && r.value !== '' && !isNaN(r.value)) r.value = Number(r.value);
    return r;
  }).filter(r => r.id);
}

let syncState = 'off', syncTimer = null, syncing = false, syncAgain = false, tabsChecked = false;
function setSyncState(s, msg) { syncState = s; renderSyncBadge(msg); }
function renderSyncBadge(msg) {
  const b = $('#syncBadge');
  if (!CFG.GOOGLE_CLIENT_ID || !prefs.googleConnected) { b.hidden = true; return; }
  b.hidden = false; b.className = 'sync-badge';
  if (syncState === 'syncing') b.textContent = 'Syncing…';
  else if (syncState === 'needs-auth') { b.textContent = 'Reconnect Google'; b.classList.add('needs'); }
  else if (syncState === 'error') { b.textContent = 'Sync error'; b.classList.add('err'); b.title = msg || ''; }
  else if (!navigator.onLine) b.textContent = 'Offline';
  else b.textContent = 'Synced ✓';
}
$('#syncBadge').addEventListener('click', () => { if (syncState === 'needs-auth') startGoogleAuth(); else if (syncState === 'error') { toast(lastSyncError || 'Sync error', 5000); sync(); } else sync(); });

function scheduleSync() {
  if (!CFG.GOOGLE_CLIENT_ID || !prefs.googleConnected) return;
  clearTimeout(syncTimer); syncTimer = setTimeout(sync, 2500);
}

async function gapi(method, url, body) {
  const token = getToken();
  if (!token) { const e = new Error('Not signed in'); e.status = 401; throw e; }
  const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { const t = await r.text().catch(() => ''); const e = new Error(`Google ${r.status}: ${t.slice(0, 160)}`); e.status = r.status; throw e; }
  return r.status === 204 ? null : r.json();
}

async function ensureSheet() {
  if (prefs.sheetId) return prefs.sheetId;
  const q = `name='${CFG.SHEET_NAME.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`;
  const list = await gapi('GET', `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&orderBy=createdTime`);
  if (list.files && list.files.length) prefs.sheetId = list.files[0].id;
  else {
    const created = await gapi('POST', 'https://sheets.googleapis.com/v4/spreadsheets', {
      properties: { title: CFG.SHEET_NAME },
      sheets: TABS.map(t => ({ properties: { title: t, gridProperties: { frozenRowCount: 1 } } })),
    });
    prefs.sheetId = created.spreadsheetId;
  }
  savePrefs(); tabsChecked = false;
  return prefs.sheetId;
}

async function ensureTabs(sid) {
  if (tabsChecked) return;
  const meta = await gapi('GET', `https://sheets.googleapis.com/v4/spreadsheets/${sid}?fields=sheets.properties.title`);
  const have = new Set((meta.sheets || []).map(s => s.properties.title));
  const missing = TABS.filter(t => !have.has(t));
  if (missing.length) await gapi('POST', `https://sheets.googleapis.com/v4/spreadsheets/${sid}:batchUpdate`, { requests: missing.map(t => ({ addSheet: { properties: { title: t, gridProperties: { frozenRowCount: 1 } } } })) });
  tabsChecked = true;
}

let lastSyncError = '';
async function sync() {
  if (!CFG.GOOGLE_CLIENT_ID || !prefs.googleConnected) return;
  if (!getToken()) { setSyncState('needs-auth'); if (state.tab === 'today' || state.tab === 'weight') render(); return; }
  if (!navigator.onLine) { setSyncState('ok'); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true; setSyncState('syncing');
  try {
    let sid = await ensureSheet();
    try { await ensureTabs(sid); }
    catch (e) { if (e.status === 404) { prefs.sheetId = ''; savePrefs(); sid = await ensureSheet(); await ensureTabs(sid); } else throw e; }
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
    const got = await gapi('GET', `${base}/values:batchGet?${TABS.map(t => 'ranges=' + encodeURIComponent(t)).join('&')}&valueRenderOption=UNFORMATTED_VALUE`);
    let changed = false;
    (got.valueRanges || []).forEach((vr, i) => {
      const coll = SCHEMA[TABS[i]].coll;
      let c = false;
      for (const r of rowsToRecs(TABS[i], vr.values || [])) {
        const l = db[coll][r.id];
        if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) { db[coll][r.id] = { ...(l || {}), ...r }; c = true; }
      }
      if (c) { store.set(coll, db[coll]); changed = true; }
    });
    const data = TABS.map(t => ({ range: `${t}!A1`, values: recsToRows(t) }));
    await gapi('POST', `${base}/values:batchUpdate`, { valueInputOption: 'RAW', data });
    await gapi('POST', `${base}/values:batchClear`, { ranges: data.map((d, i) => `${TABS[i]}!A${d.values.length + 1}:ZZ`) });
    prefs.lastSync = Date.now(); savePrefs();
    lastSyncError = ''; setSyncState('ok');
    if (changed && !$('#sheetRoot').innerHTML) render();
  } catch (e) {
    if (e.status === 401) { clearToken(); setSyncState('needs-auth'); }
    else { lastSyncError = e.message; setSyncState('error', e.message); }
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(); }
  }
}

/* ---------------- startup ---------------- */
handleAuthRedirect();
if (CFG.GOOGLE_CLIENT_ID && prefs.googleConnected && !getToken()) syncState = 'needs-auth';
render();
sync();
// keep "Today" correct if the app stays open past 3 am, and sync when coming back
let lastDay = dayOf();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const d = dayOf(); if (d !== lastDay) { if (state.day === lastDay) state.day = d; lastDay = d; render(); }
  sync();
});
window.addEventListener('online', () => sync());
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
