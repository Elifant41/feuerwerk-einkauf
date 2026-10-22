'use strict';
// Feuerwerk-Einkauf – iPhone-App (PWA) zur Chrome-Erweiterung „Feuerwerk-Einkaufsliste“.
// Grenzwerte wie in der Erweiterung (specs.js → BORDER).

const BORDER = {
  allowed: { cat: ['F1', 'F2'], hazard: ['1.4S', '1.4G', '1.3G'] },
  freeGross: { heavy: 5000, light: 50000 }, // g brutto: 1.1–1.3 / 1.4 (GGVSEB Anlage 2)
  points: { '1.1G': 50, '1.2G': 50, '1.3G': 50, '1.4G': 3, '1.4S': 0 }, // je kg NEM (ADR 1.1.3.6)
  maxPoints: 1000,
};

const $ = (id) => document.getElementById(id);
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const dec = (v, d = 1) => v.toLocaleString('de-DE', { maximumFractionDigits: d });
// Für Eingabefelder: ohne Tausenderpunkt, sonst liest parseNum „1.600“ als 1,6
const inp = (v, d) => v.toLocaleString('de-DE', { maximumFractionDigits: d, useGrouping: false });
const kg = (g) => dec(g / 1000, g < 10000 ? 2 : 1) + ' kg';
const fmtG = (g) => (g >= 1000 ? kg(g) : dec(g, 1) + ' g');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const isHeavy = (hz) => /^1\.[123]/.test(hz || '');

// Produktarten (gleiche Namen wie tools/catalog_de.py) + Suchwörter, damit z. B. „Böller“ oder „Kuchen“ auch findet
const TYPES = {
  'Batterien': 'batterie batterien kuchen cake feuerwerksbatterie',
  'Verbunde': 'verbund verbundfeuerwerk compound batterie',
  'Raketen': 'rakete raketen rocket',
  'Single Shots': 'single shot singleshot einzelschuss bombe kugelbombe',
  'Römische Lichter': 'römisches licht römische kerze roman candle',
  'Böller & Knallteppiche': 'böller knaller kracher knallteppich',
  'Fontänen & Vulkane': 'fontäne vulkan brunnen fountain',
  'Boden- & Flugeffekte': 'bodenwirbel kreisel flieger schwärmer',
  'Jugend- & Kleinfeuerwerk': 'jugendfeuerwerk kinder knallerbsen kleinfeuerwerk',
  'Wunderkerzen': 'wunderkerze sparkler',
  'Rauch & Fackeln': 'rauch fackel bengalo',
  'Sortimente': 'sortiment set paket',
  'Zubehör & Fanartikel': 'zubehör fanartikel',
  'Sonstiges': '',
};
const TYPE_NAMES = Object.keys(TYPES);
// Für eigene Artikel / Shop-Artikel ohne Katalogeintrag: Art aus dem Namen raten
const GUESS = [
  [/rakete|rocket/i, 'Raketen'], [/single\s*shot|einzelschuss/i, 'Single Shots'], [/römisch|roman/i, 'Römische Lichter'],
  [/verbund|compound/i, 'Verbunde'], [/batterie|battery|cake|\d+\s*(schuss|sh|shots?|ran)\b/i, 'Batterien'],
  [/böller|knaller|kracher|cracker|knallteppich/i, 'Böller & Knallteppiche'], [/fontäne|vulkan|vulcan|fountain/i, 'Fontänen & Vulkane'],
  [/wunderkerze|sparkler/i, 'Wunderkerzen'], [/rauch|fackel|smoke|bengal/i, 'Rauch & Fackeln'],
  [/knallerbse|jugend/i, 'Jugend- & Kleinfeuerwerk'], [/sortiment|\bset\b/i, 'Sortimente'],
];
const guessType = (name) => GUESS.find(([rx]) => rx.test(name || ''))?.[1] || null;
let catSync = null; // geladener Katalog (für Art/Übersetzung von Artikeln mit Art.-Nr.)
let catFailed = false;
const fromCat = (it) => (it.sku && catSync?.bySku.get(it.sku.toLowerCase())) || null;
const itemType = (it) => it.type || fromCat(it)?.type || guessType(it.name) || 'Sonstiges';
const itemDe = (it) => it.nameDe || fromCat(it)?.nameDe || null;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

function parseNum(s) {
  s = String(s ?? '').replace(/[€\s]/g, '');
  if (!s) return null;
  if (s.includes(',') || /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  const v = parseFloat(s);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

let toastTimer;
function toast(text, ms = 2200, action = null) {
  const t = $('toast');
  t.replaceChildren(h('span', {}, text), action ? h('button', {
    class: 'link', onclick: () => { t.hidden = true; clearTimeout(toastTimer); action.run(); },
  }, action.label) : null);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
// Meldung mit „Rückgängig“: revert() stellt den alten Stand wieder her
function undoable(text, revert) {
  toast(text, 5000, { label: 'Rückgängig', run: () => { revert(); commit(); toast('Rückgängig gemacht'); } });
}
const short = (s) => (s.length > 28 ? s.slice(0, 26) + '…' : s);

// ---------- Speicher (IndexedDB, Fotos können groß werden) ----------
const db = new Promise((ok, fail) => {
  const r = indexedDB.open('feuerwerk-einkauf', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => ok(r.result);
  r.onerror = () => fail(r.error);
});
async function idb(mode, fn) {
  const d = await db;
  return new Promise((ok, fail) => {
    const tx = d.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => ok(req?.result);
    tx.onerror = () => fail(tx.error);
  });
}
const load = (k) => idb('readonly', (s) => s.get(k));
const save = (k, v) => idb('readwrite', (s) => s.put(v, k));

const DEFAULTS = { basis: 'all', sort: 'added', browse: { allowed: true, sort: '' } };
let state = { lists: [], activeId: null, ...DEFAULTS };
let filter = 'open';
let query = '';
let summaryOpen = true;

const active = () => state.lists.find((l) => l.id === state.activeId) || state.lists[0];

let saveTimer;
function commit() {
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save('state', state).catch((e) => toast('Speichern fehlgeschlagen: ' + e.message, 5000)), 150);
}

// ---------- Grenz-Check ----------
function blockReasons(it) {
  return [
    it.cat && !BORDER.allowed.cat.includes(it.cat) ? `Kategorie ${it.cat}` : null,
    it.hazard && !BORDER.allowed.hazard.includes(it.hazard) ? `Gefahrgut ${it.hazard}` : null,
  ].filter(Boolean);
}

function stats(items) {
  const s = { heavyGross: 0, lightGross: 0, heavyNem: 0, lightNem: 0, points: 0, price: 0, pieces: 0, miss: [] };
  for (const it of items) {
    if (blockReasons(it).length) continue;
    s.price += (it.price || 0) * it.qty;
    s.pieces += it.qty;
    if (!it.hazard) { s.miss.push(it); continue; }
    const heavy = isHeavy(it.hazard);
    if (it.nem == null) s.miss.push(it);
    else {
      s[heavy ? 'heavyNem' : 'lightNem'] += it.nem * it.qty;
      s.points += (it.nem * it.qty / 1000) * (BORDER.points[it.hazard] ?? 50);
    }
    if (it.gross == null) { if (!s.miss.includes(it)) s.miss.push(it); }
    else s[heavy ? 'heavyGross' : 'lightGross'] += it.gross * it.qty;
  }
  s.overFree = s.heavyGross > BORDER.freeGross.heavy || s.lightGross > BORDER.freeGross.light;
  s.overPoints = s.points > BORDER.maxPoints + 1e-9;
  s.tier = s.overPoints ? 'over' : s.overFree ? 'points' : 'free';
  return s;
}

// Wie viele Stück passen noch? (ohne das Stück selbst mitzurechnen, wenn es schon gezählt ist)
function fits(it, s) {
  if (!it.hazard || blockReasons(it).length) return null;
  const heavy = isHeavy(it.hazard);
  const free = it.gross
    ? Math.max(0, Math.floor((BORDER.freeGross[heavy ? 'heavy' : 'light'] - s[heavy ? 'heavyGross' : 'lightGross']) / it.gross + 1e-9))
    : null;
  const per = it.nem != null ? (it.nem / 1000) * (BORDER.points[it.hazard] ?? 50) : null;
  const points = per == null ? null : per === 0 ? Infinity : Math.max(0, Math.floor((BORDER.maxPoints - s.points) / per + 1e-9));
  return { free, points };
}

const basisItems = (l) => (state.basis === 'done' ? l.items.filter((i) => i.done) : l.items);

const TIER = {
  free: ['Innerhalb der Privat-Freigrenze', 'Keine weiteren Auflagen.'],
  points: ['Über der Freigrenze – 1000-Punkte-Regel', 'Nötig: UN-geprüfte Originalkartons und ein 2-kg-ABC-Feuerlöscher im Auto.'],
  over: ['Über 1000 Punkte', 'So privat nicht transportierbar – Menge reduzieren.'],
};

// ---------- Anzeige ----------
function render() {
  const l = active();
  $('listSelect').replaceChildren(...state.lists.map((x) => h('option', { value: x.id, selected: x === l }, x.name)));
  $('sortSel').value = state.sort;
  // Art und Übersetzung kommen für Artikel mit Art.-Nr. aus dem Katalog → einmal nachladen
  if (!catSync && !catFailed && l.items.some((i) => i.sku)) catalog().then(render).catch(() => { catFailed = true; });
  renderSummary(l);
  renderList(l);
}

function meter(label, doneV, allV, max, fmt) {
  const pct = (v) => Math.min(100, (v / max) * 100) + '%';
  const shown = state.basis === 'done' ? doneV : allV;
  return h('div', { class: 'meter' },
    h('div', { class: 'row' }, h('b', {}, label), h('span', {}, `${fmt(shown)} / ${fmt(max)}`)),
    h('div', { class: 'track' + (shown > max ? ' over' : '') },
      h('i', { class: 'plan', style: `width:${pct(allV)}` }),
      h('i', { class: 'done', style: `width:${pct(doneV)}` })),
  );
}

function renderSummary(l) {
  const all = stats(l.items);
  const done = stats(l.items.filter((i) => i.done));
  const s = state.basis === 'done' ? done : all;
  const [title, sub] = TIER[s.tier];

  $('mini').replaceChildren(
    h('span', { class: `dot t-${s.tier}` }),
    h('span', { class: 'txt' }, `1.3G ${kg(s.heavyGross)}/5 · 1.4 ${dec(s.lightGross / 1000)}/50 kg · ${Math.round(s.points)} P.`),
    h('span', { class: 'chev' }, summaryOpen ? '▴' : '▾'),
  );
  $('mini').setAttribute('aria-expanded', summaryOpen);
  $('summary').hidden = !summaryOpen;
  if (!summaryOpen) return;

  const blocked = l.items.filter((i) => blockReasons(i).length);
  $('summary').replaceChildren(
    h('div', { class: 'status' }, h('span', { class: `dot t-${s.tier}` }), h('div', {}, title, h('small', {}, sub))),
    meter('1.3G brutto', done.heavyGross, all.heavyGross, BORDER.freeGross.heavy, kg),
    meter('1.4G/1.4S brutto', done.lightGross, all.lightGross, BORDER.freeGross.light, (g) => dec(g / 1000) + ' kg'),
    meter('ADR-Punkte', done.points, all.points, BORDER.maxPoints, (p) => dec(p, 0)),
    h('div', { class: 'legend' }, `Kräftig = im Korb, hell = ganze Liste. Zahlen: ${state.basis === 'done' ? 'nur Abgehaktes' : 'ganze Liste'}.`),
    h('div', { class: 'kv' },
      h('span', {}, 'NEM 1.3G'), h('span', {}, `${fmtG(done.heavyNem)} von ${fmtG(all.heavyNem)}`),
      h('span', {}, 'NEM 1.4G/S'), h('span', {}, `${fmtG(done.lightNem)} von ${fmtG(all.lightNem)}`),
      h('span', {}, 'NEM gesamt'), h('span', {}, `${fmtG(done.heavyNem + done.lightNem)} von ${fmtG(all.heavyNem + all.lightNem)}`),
      h('span', {}, 'Stück'), h('span', {}, `${done.pieces} von ${all.pieces}`),
      h('span', {}, 'Preis'), h('span', {}, `${eur.format(done.price)} von ${eur.format(all.price)}`),
      l.budget ? [h('span', {}, 'Budget'), h('span', { class: all.price > l.budget ? 'danger' : '' },
        all.price > l.budget ? `${eur.format(all.price - l.budget)} drüber` : `${eur.format(l.budget - all.price)} übrig`)] : null,
    ),
    s.miss.length ? h('div', { class: 'miss' }, `Nicht mitgezählt (Angaben fehlen): ${s.miss.map((i) => i.sku || i.name).join(', ')} – Artikel antippen und ergänzen.`) : null,
    blocked.length ? h('div', { class: 'miss danger' }, `Nicht erlaubt, zählt nicht: ${blocked.map((i) => i.sku || i.name).join(', ')}`) : null,
  );
}

function chipsFor(it) {
  const r = blockReasons(it);
  return h('div', { class: 'chips' },
    r.length ? h('span', { class: 'chip bad' }, '⚠ ' + r.join(', ')) : null,
    it.hazard ? h('span', { class: 'chip' + (isHeavy(it.hazard) && !r.length ? ' h13' : '') }, it.hazard) : h('span', { class: 'chip warn' }, 'Gefahrgut ?'),
    it.cat ? h('span', { class: 'chip' }, it.cat) : null,
    it.nem != null ? h('span', { class: 'chip' }, 'NEM ' + fmtG(it.nem)) : h('span', { class: 'chip warn' }, 'NEM ?'),
    it.gross != null ? h('span', { class: 'chip' }, 'brutto ' + fmtG(it.gross)) : h('span', { class: 'chip warn' }, 'brutto ?'),
  );
}

function fitsLine(it, s) {
  const f = fits(it, s);
  if (!f || (f.free == null && f.points == null)) return null;
  const part = (n, label) => n == null ? null : n === Infinity ? `unbegrenzt ${label}` : h('span', { class: n === 0 ? 'low' : '' }, h('b', {}, `${n}×`), ` ${label}`);
  const parts = [part(f.free, 'bis Freigrenze'), part(f.points, 'bis 1000 P.')].filter(Boolean);
  return h('div', { class: 'fits' }, 'Passt noch: ', ...parts.flatMap((p, i) => (i ? [' · ', p] : [p])));
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s\-_/().]+/g, '');

function renderList(l) {
  const s = stats(basisItems(l));
  const q = norm(query);
  const items = l.items
    .filter((i) => (filter === 'open' ? !i.done : filter === 'done' ? i.done : true))
    .filter((i) => !q || norm(i.name).includes(q) || norm(i.sku).includes(q) || norm(itemDe(i)).includes(q));
  const name = (i) => itemDe(i) || i.name;
  if (state.sort === 'name') items.sort((a, b) => name(a).localeCompare(name(b), 'de'));
  if (state.sort === 'price') items.sort((a, b) => b.price * b.qty - a.price * a.qty);
  if (state.sort === 'type') {
    const groups = new Map(TYPE_NAMES.map((t) => [t, []]));
    for (const it of items) groups.get(itemType(it)).push(it);
    $('list').replaceChildren(...[...groups].filter(([, g]) => g.length).flatMap(([t, g]) => [
      h('h3', { class: 'group' }, t, h('span', {}, `${g.length} Artikel · ${g.reduce((n, i) => n + i.qty, 0)} Stück`)),
      ...g.map((it) => renderItem(it, s)),
    ]));
  } else $('list').replaceChildren(...items.map((it) => renderItem(it, s)));

  const e = $('empty');
  e.hidden = items.length > 0;
  if (!l.items.length) {
    e.replaceChildren(h('div', {}, 'Noch nichts auf dieser Liste.'),
      h('button', { class: 'wide', onclick: () => $('importFile').click() }, '📥 Liste aus Chrome importieren'),
      h('button', { class: 'wide', onclick: openAdd }, '＋ Produkt hinzufügen'));
  } else e.replaceChildren(filter === 'open' && !q ? '🎉 Alles im Korb!' : 'Keine Treffer.');
}

function renderItem(it, s) {
  const blocked = blockReasons(it).length > 0;
  const thumb = it.image
    ? h('img', { class: 'thumb', src: it.image, alt: '', loading: 'lazy', onclick: (e) => { e.stopPropagation(); view(it.image); } })
    : h('div', { class: 'thumb none' }, '🎆');
  const setQty = (d) => (e) => {
    e.stopPropagation();
    it.qty = Math.max(1, it.qty + d);
    commit();
  };
  const de = itemDe(it);
  return h('article', { class: 'item' + (it.done ? ' done' : '') + (blocked ? ' blocked' : ''), onclick: () => openItem(it) },
    thumb,
    h('div', { class: 'body' },
      h('div', { class: 'name' }, it.name),
      de ? h('div', { class: 'de' }, '≈ ' + de) : null,
      it.sku ? h('div', { class: 'sku' }, it.sku) : null,
      chipsFor(it),
      h('div', { class: 'line2' },
        h('div', { class: 'stepper', onclick: (e) => e.stopPropagation() },
          h('button', { onclick: setQty(-1), 'aria-label': 'weniger' }, '−'),
          h('span', {}, String(it.qty)),
          h('button', { onclick: setQty(1), 'aria-label': 'mehr' }, '+')),
        h('span', { class: 'price' }, [it.czk ? `${dec(it.czk, 0)} Kč` : null, it.price ? eur.format(it.price) : null, it.price && it.qty > 1 ? `zus. ${eur.format(it.price * it.qty)}` : null].filter(Boolean).join(' · ')),
      ),
      it.done ? null : fitsLine(it, s),
    ),
    h('button', {
      class: 'tick', 'aria-label': it.done ? 'Haken entfernen' : 'Abhaken',
      onclick: (e) => {
        e.stopPropagation();
        it.done = !it.done;
        if (navigator.vibrate) navigator.vibrate(10);
        commit();
        undoable(`„${short(it.name)}“ ${it.done ? 'im Korb' : 'wieder offen'}`, () => { it.done = !it.done; });
      },
    }, '✓'),
  );
}

function view(src) {
  $('viewerImg').src = src;
  $('viewer').showModal();
}
$('viewer').addEventListener('click', () => $('viewer').close());

// ---------- Listen ----------
function newList(name, extra = {}) {
  let n = name, i = 2;
  while (state.lists.some((l) => l.name === n)) n = `${name} (${i++})`;
  const l = { id: uid(), name: n, budget: null, items: [], ...extra, name: n };
  state.lists.push(l);
  state.activeId = l.id;
  return l;
}

$('listSelect').addEventListener('change', (e) => { state.activeId = e.target.value; commit(); });
$('mini').addEventListener('click', () => { summaryOpen = !summaryOpen; render(); });
$('filterSeg').addEventListener('click', (e) => {
  const f = e.target.closest('button')?.dataset.f;
  if (!f) return;
  filter = f;
  for (const b of $('filterSeg').children) b.classList.toggle('on', b.dataset.f === f);
  render();
});
$('search').addEventListener('input', (e) => { query = e.target.value; render(); });
$('sortSel').addEventListener('change', (e) => { state.sort = e.target.value; commit(); });

// Menü
for (const d of document.querySelectorAll('dialog.sheet')) {
  d.querySelector('.close')?.addEventListener('click', () => d.close());
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // Tipp auf den Hintergrund
}
function renderBasis() {
  for (const b of $('basisSeg').children) b.classList.toggle('on', b.dataset.b === state.basis);
}
$('menuBtn').addEventListener('click', () => { renderBasis(); $('menu').showModal(); });
$('basisSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button')?.dataset.b;
  if (!b) return;
  state.basis = b;
  renderBasis();
  commit();
});
$('mNew').addEventListener('click', () => {
  const name = prompt('Name der neuen Liste', 'Einkauf');
  if (!name?.trim()) return;
  newList(name.trim());
  $('menu').close();
  commit();
});
$('mRename').addEventListener('click', () => {
  const l = active();
  const name = prompt('Neuer Name', l.name);
  if (!name?.trim()) return;
  l.name = name.trim();
  commit();
});
$('mBudget').addEventListener('click', () => {
  const l = active();
  const v = prompt('Budget in € (leer = keins)', l.budget ? inp(l.budget, 2) : '');
  if (v == null) return;
  l.budget = parseNum(v) || null;
  commit();
});
$('mUncheck').addEventListener('click', () => {
  const l = active();
  const was = l.items.filter((i) => i.done);
  if (!was.length || !confirm('Alle Haken dieser Liste entfernen?')) return;
  for (const i of l.items) i.done = false;
  $('menu').close();
  commit();
  undoable(`${was.length} Haken entfernt`, () => { for (const i of was) i.done = true; });
});
$('mDelete').addEventListener('click', () => {
  const l = active();
  if (!confirm(`Liste „${l.name}“ mit ${l.items.length} Artikeln löschen?`)) return;
  const idx = state.lists.indexOf(l);
  state.lists = state.lists.filter((x) => x !== l);
  const filler = state.lists.length ? null : newList('Einkauf');
  state.activeId = state.lists[0].id;
  $('menu').close();
  commit();
  undoable(`Liste „${short(l.name)}“ gelöscht`, () => {
    if (filler && !filler.items.length) state.lists = state.lists.filter((x) => x !== filler);
    state.lists.splice(Math.min(idx, state.lists.length), 0, l);
    state.activeId = l.id;
  });
});

// ---------- Import / Export ----------
$('mImport').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const prev = state.activeId;
    const l = /^\s*[{[]/.test(text) ? importJson(JSON.parse(text)) : await importCsv(text, file.name);
    $('menu').close();
    filter = 'open';
    for (const b of $('filterSeg').children) b.classList.toggle('on', b.dataset.f === 'open');
    commit();
    undoable(`„${short(l.name)}“ importiert: ${l.items.length} Artikel`, () => {
      state.lists = state.lists.filter((x) => x !== l);
      state.activeId = state.lists.some((x) => x.id === prev) ? prev : state.lists[0]?.id;
      if (!state.lists.length) newList('Einkauf');
    });
  } catch (err) {
    toast('Import fehlgeschlagen: ' + err.message, 5000);
  }
});

const cleanItem = (x) => ({
  id: x.id || uid(), name: String(x.name || x.sku || 'Artikel'), sku: x.sku || null,
  price: Number(x.price) || 0, qty: Math.max(1, Math.round(Number(x.qty) || 1)),
  cat: x.cat || null, hazard: x.hazard || null,
  nem: x.nem != null && x.nem !== '' ? Number(x.nem) : null, gross: x.gross != null && x.gross !== '' ? Number(x.gross) : null,
  image: typeof x.image === 'string' ? x.image : null, url: x.url || null, shop: x.shop || null,
  priceNote: x.priceNote || null, done: !!x.done, czk: Number(x.czk) || null,
  type: TYPE_NAMES.includes(x.type) ? x.type : null, nameDe: x.nameDe || null, effect: x.effect || null,
});

function importJson(d) {
  if (d?.format !== 'feuerwerk-liste' || !d.list?.items) throw new Error('keine Feuerwerk-Liste (.fwliste.json)');
  return newList(d.list.name || 'Import', { budget: d.list.budget || null, items: d.list.items.map(cleanItem) });
}

// CSV der Erweiterung (Semikolon, Dezimalkomma) – Fotos werden über den Katalog ergänzt
async function importCsv(text, fileName) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true;
    else if (c === ';') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows;
  const col = (name) => head.findIndex((x) => x.trim().toLowerCase().startsWith(name));
  const c = { name: col('artikel'), sku: col('art.-nr'), cat: col('kategorie'), hz: col('gefahrgut'), nem: col('nem'), gross: col('brutto'), price: col('einzelpreis'), qty: col('menge'), url: col('link'), shop: col('shop') };
  if (c.name < 0) throw new Error('unbekanntes CSV-Format');
  const cat = await catalog().catch(() => null);
  const items = body.filter((r) => r[c.name]?.trim()).map((r) => {
    const sku = r[c.sku]?.trim() || null;
    const hit = sku && cat?.bySku.get(sku.toLowerCase());
    return cleanItem({
      name: r[c.name], sku, cat: r[c.cat] || null, hazard: r[c.hz] || null,
      nem: parseNum(r[c.nem]), gross: parseNum(r[c.gross]), price: parseNum(r[c.price]) || 0, qty: parseNum(r[c.qty]) || 1,
      url: r[c.url] || null, shop: r[c.shop] || null, image: hit?.image || null,
    });
  });
  return newList(fileName.replace(/\.csv$/i, '') || 'Import', { items });
}

$('mExport').addEventListener('click', async () => {
  const l = active();
  const data = { format: 'feuerwerk-liste', version: 1, exportedAt: new Date().toISOString(), list: { name: l.name, border: true, budget: l.budget, items: l.items } };
  const name = `${l.name.replace(/[\\/:*?"<>|]+/g, '_')}.fwliste.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], title: l.name });
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  const a = h('a', { href: URL.createObjectURL(file), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

// ---------- Katalog (Klásek, mit der App ausgeliefert) ----------
let catalogP = null;
function catalog() {
  catalogP ??= fetch('katalog.json').then((r) => {
    if (!r.ok) throw new Error('Katalog nicht ladbar');
    return r.json();
  }).then((d) => {
    const bySku = new Map();
    d.products.forEach((p, i) => {
      p._i = i;
      p.type = TYPE_NAMES.includes(p.type) ? p.type : guessType(p.name) || 'Sonstiges';
      // _main: Art.-Nr. und Namen (für die Rangfolge), _key: zusätzlich Effekt (deutsch), Art, Kaliber
      p._main = [p.sku, p.name, p.nameDe].map(norm).join(' ');
      p._key = p._main + ' ' + [p.effect, p.type, TYPES[p.type], p.cal].map(norm).join(' ');
      bySku.set(p.sku.toLowerCase(), p);
    });
    catSync = { ...d, bySku };
    return catSync;
  }).catch((e) => { catalogP = null; throw e; });
  return catalogP;
}

const PAGE = 20;
const browse = { type: '', page: 0, hits: [] };

function openAdd() {
  $('catSearch').value = '';
  $('catAllowed').checked = state.browse.allowed;
  $('catSort').value = state.browse.sort;
  browse.type = '';
  $('catResults').replaceChildren();
  $('catPager').replaceChildren();
  $('catTypes').replaceChildren();
  $('addSheet').showModal();
  $('addSheet').scrollTop = 0;
  $('catInfo').textContent = 'Katalog wird geladen …';
  catalog().then(() => searchCatalog())
    .catch(() => { $('catInfo').textContent = 'Katalog nicht verfügbar (offline?) – „Ohne Katalog eintragen“ geht trotzdem.'; });
}
$('addBtn').addEventListener('click', openAdd);
$('manualBtn').addEventListener('click', () => { $('addSheet').close(); openItem(null); });

// Suche + Filter → Trefferliste (alle Seiten). Ohne Suchwort: ganzer Katalog zum Durchblättern.
async function searchCatalog() {
  const c = await catalog().catch(() => null);
  if (!c) return;
  let raw = $('catSearch').value;
  let shots = null, cal = null;
  raw = raw.replace(/(\d+)\s*(?:schuss|schüsse|sch|sh|shots?|ran)\b/i, (_, n) => { shots = Number(n); return ' '; });
  raw = raw.replace(/(\d+)\s*mm\b/i, (_, n) => { cal = Number(n); return ' '; });
  const words = raw.split(/\s+/).map(norm).filter(Boolean);
  const q = norm(raw);

  const base = c.products.filter((p) =>
    (!state.browse.allowed || !blockReasons(p).length)
    && (shots == null || p.shots === shots)
    && (cal == null || String(p.cal || '').split('+').some((x) => parseInt(x) === cal))
    && words.every((w) => p._key.includes(w)));

  const counts = new Map();
  for (const p of base) counts.set(p.type, (counts.get(p.type) || 0) + 1);
  if (browse.type && !counts.get(browse.type)) browse.type = '';
  $('catTypes').replaceChildren(
    h('button', { class: browse.type ? '' : 'on', onclick: () => setType('') }, `Alle ${base.length}`),
    ...TYPE_NAMES.filter((t) => counts.get(t)).map((t) =>
      h('button', { class: browse.type === t ? 'on' : '', onclick: () => setType(t) }, `${t} ${counts.get(t)}`)),
  );

  let hits = browse.type ? base.filter((p) => p.type === browse.type) : base;
  // Rangfolge bei Suche: Art.-Nr. beginnt mit dem Suchwort > Treffer im Namen > Treffer in Effekt/Art
  const rank = (p) => (q && p._main.startsWith(q) ? 2 : 0) + (words.length && words.every((w) => p._main.includes(w)) ? 1 : 0);
  const sk = state.browse.sort.replace('-', ''), dir = state.browse.sort.startsWith('-') ? -1 : 1;
  const val = (p) => (sk === 'price' ? p.price || null : sk === 'shots' ? p.shots : sk === 'nem' ? p.nem : null);
  hits = [...hits].sort((a, b) => {
    if (words.length) { const r = rank(b) - rank(a); if (r) return r; }
    if (sk === 'name') return a.name.localeCompare(b.name, 'de');
    if (sk) {
      const va = val(a), vb = val(b);
      if (va == null || vb == null) return (va == null) - (vb == null);
      if (va !== vb) return (va - vb) * dir;
    }
    return TYPE_NAMES.indexOf(a.type) - TYPE_NAMES.indexOf(b.type) || a._i - b._i;
  });
  browse.hits = hits;
  browse.page = 0;
  renderPage();
}

function setType(t) {
  browse.type = t;
  searchCatalog();
}

function renderPage() {
  const hits = browse.hits;
  const pages = Math.max(1, Math.ceil(hits.length / PAGE));
  browse.page = Math.min(browse.page, pages - 1);
  const from = browse.page * PAGE;
  const inList = new Set(active().items.map((i) => (i.sku || '').toLowerCase()));
  $('catInfo').textContent = hits.length
    ? `${hits.length} Artikel${pages > 1 ? ` · Seite ${browse.page + 1} von ${pages}` : ''} · ${catSync.source}, Stand ${catSync.builtAt}`
    : '';
  $('catResults').replaceChildren(
    ...hits.slice(from, from + PAGE).map((p) => {
      const r = blockReasons(p);
      return h('button', { class: 'res' + (r.length ? ' blocked' : ''), onclick: () => { $('addSheet').close(); openItem(null, p); } },
        p.image ? h('img', { class: 'thumb', src: p.image, alt: '', loading: 'lazy' }) : h('div', { class: 'thumb none' }, '🎆'),
        h('div', { class: 'body' },
          h('div', { class: 'name' }, p.name),
          p.nameDe ? h('div', { class: 'de' }, '≈ ' + p.nameDe) : null,
          h('div', { class: 'sku' }, p.sku, h('span', { class: 'type' }, ' · ' + p.type), inList.has(p.sku.toLowerCase()) ? h('span', { class: 'onlist' }, ' · ✓ auf der Liste') : null),
          p.effect ? h('div', { class: 'effect' }, p.effect) : null,
          h('div', { class: 'meta' }, r.length ? '⚠ ' + r.join(', ') : [p.cat, p.hazard, p.shots ? `${p.shots} Schuss` : null, p.cal, p.nem != null ? 'NEM ' + fmtG(p.nem) : null, p.czk ? `${dec(p.czk, 0)} Kč` : null].filter(Boolean).join(' · ')),
        ));
    }),
    hits.length ? '' : h('div', { class: 'fine' }, state.browse.allowed
      ? 'Nichts gefunden. Evtl. „Nur erlaubte“ ausschalten – oder „Ohne Katalog eintragen“.'
      : 'Nichts gefunden – „Ohne Katalog eintragen“ nutzen.'),
  );
  renderPager(pages);
}

// Seitenleiste: ‹ 1 … 4 5 6 … 12 ›
function renderPager(pages) {
  const p = browse.page;
  const go = (i) => () => {
    browse.page = i;
    renderPage();
    $('addSheet').scrollTo({ top: $('catTypes').offsetTop - 64 });
  };
  if (pages < 2) return $('catPager').replaceChildren();
  const nums = [...new Set([0, p - 1, p, p + 1, pages - 1])].filter((i) => i >= 0 && i < pages).sort((a, b) => a - b);
  const out = [h('button', { disabled: p === 0, onclick: go(p - 1), 'aria-label': 'Vorherige Seite' }, '‹')];
  nums.forEach((i, k) => {
    if (k && i - nums[k - 1] > 1) out.push(h('span', { class: 'gap' }, '…'));
    out.push(h('button', { class: i === p ? 'on' : '', onclick: go(i), 'aria-current': i === p ? 'page' : null }, String(i + 1)));
  });
  out.push(h('button', { disabled: p === pages - 1, onclick: go(p + 1), 'aria-label': 'Nächste Seite' }, '›'));
  $('catPager').replaceChildren(...out);
}

$('catSearch').addEventListener('input', () => searchCatalog());
$('catAllowed').addEventListener('change', (e) => { state.browse.allowed = e.target.checked; commit(); searchCatalog(); });
$('catSort').addEventListener('change', (e) => { state.browse.sort = e.target.value; commit(); searchCatalog(); });

// ---------- Artikel-Formular ----------
let editing = null; // bestehender Artikel oder null (neu)
let formImage = null;
let formCzk = null; // Kč-Preis aus dem Katalog (Preisschild im Laden)
let formExtra = {}; // Übersetzung und Effekt aus dem Katalog
const form = $('itemForm');
form.type.replaceChildren(h('option', { value: '' }, 'automatisch'), ...TYPE_NAMES.map((t) => h('option', {}, t)));

function openItem(it, fromCatalog = null) {
  editing = it;
  const src = it || fromCatalog || {};
  // Gleicher Katalog-Artikel schon auf der Liste → diesen bearbeiten statt doppelt anlegen
  if (!it && fromCatalog) {
    const dup = active().items.find((i) => i.sku && i.sku.toLowerCase() === fromCatalog.sku.toLowerCase());
    if (dup) { editing = dup; toast('Schon auf der Liste – Menge hier anpassen'); return openItem(dup); }
  }
  $('itemTitle').textContent = it ? 'Artikel bearbeiten' : 'Neuer Artikel';
  form.name.value = src.name || '';
  form.sku.value = src.sku || '';
  form.hazard.value = src.hazard || '';
  form.cat.value = src.cat || '';
  form.type.value = src.type || (it && fromCat(it)?.type) || '';
  formExtra = { nameDe: src.nameDe || (it && fromCat(it)?.nameDe) || null, effect: src.effect || null };
  form.nem.value = src.nem != null ? inp(src.nem, 3) : '';
  form.gross.value = src.gross != null ? inp(src.gross, 0) : '';
  form.price.value = src.price ? inp(src.price, 2) : '';
  form.qty.value = it ? it.qty : 1;
  form.done.checked = it ? !!it.done : true; // im Laden: was man hinzufügt, liegt meist schon im Korb
  $('cartonKg').value = '';
  $('cartonPcs').value = '';
  form.querySelector('.carton').open = false;
  setPhoto(src.image || null);
  formCzk = src.czk || null;
  $('itemDelete').hidden = !it;
  $('itemSave').textContent = it ? 'Speichern' : 'Hinzufügen';
  $('itemSheet').showModal();
  preview();
}

function setPhoto(src) {
  formImage = src;
  $('photoImg').hidden = !src;
  $('photoPh').hidden = !!src;
  if (src) $('photoImg').src = src;
}

$('photoFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const bmp = await createImageBitmap(f);
    const sc = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * sc);
    c.height = Math.round(bmp.height * sc);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    setPhoto(c.toDataURL('image/jpeg', 0.8));
  } catch {
    toast('Foto konnte nicht gelesen werden');
  }
});

form.querySelector('.stepper').addEventListener('click', (e) => {
  const d = Number(e.target.dataset.d);
  if (!d) return;
  form.qty.value = Math.max(1, (parseInt(form.qty.value) || 1) + d);
  preview();
});

for (const id of ['cartonKg', 'cartonPcs']) {
  $(id).addEventListener('input', () => {
    const k = parseNum($('cartonKg').value), n = parseNum($('cartonPcs').value);
    if (k && n) form.gross.value = inp((k * 1000) / n, 0);
    preview();
  });
}

function readForm() {
  return {
    name: form.name.value.trim(), sku: form.sku.value.trim() || null,
    hazard: form.hazard.value || null, cat: form.cat.value || null,
    nem: parseNum(form.nem.value), gross: parseNum(form.gross.value),
    price: parseNum(form.price.value) || 0, qty: Math.max(1, parseInt(form.qty.value) || 1),
    done: form.done.checked, image: formImage, czk: formCzk,
    type: form.type.value || null, ...formExtra,
  };
}

// Vorschau: Stand der Liste nach dem Speichern
function preview() {
  const l = active();
  const x = readForm();
  const others = basisItems(l).filter((i) => i !== editing);
  const counted = state.basis === 'done' && !x.done ? others : [...others, x];
  const s = stats(counted);
  const r = blockReasons(x);
  const before = stats(others);
  const f = fits(x, before);
  const el = $('itemPreview');
  if (r.length) return el.replaceChildren(h('span', { class: 'bad' }, `⚠ Nicht erlaubt (${r.join(', ')}) – zählt nicht mit.`));
  if (!x.hazard) return el.replaceChildren('Gefahrgutklasse fehlt – ohne sie wird der Artikel nicht mitgezählt.');
  el.replaceChildren(
    h('div', {}, 'Danach: ', h('b', {}, `1.3G ${kg(s.heavyGross)} / 5 kg`), ` · 1.4 ${dec(s.lightGross / 1000)} / 50 kg · ${dec(s.points, 0)} P.`),
    h('div', { class: s.tier === 'free' ? 'ok' : s.tier === 'over' ? 'bad' : '' }, TIER[s.tier][0]),
    f && (f.free != null || f.points != null)
      ? h('div', { class: 'fine' }, `Von diesem Artikel passen insgesamt ${f.free != null ? `${f.free}× bis zur Freigrenze` : ''}${f.free != null && f.points != null ? ' und ' : ''}${f.points != null ? `${f.points === Infinity ? 'unbegrenzt' : f.points + '×'} bis 1000 Punkte` : ''}.`)
      : null,
  );
}
form.addEventListener('input', preview);

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const x = readForm();
  if (!x.name) return form.name.focus();
  const l = active();
  const target = editing;
  $('itemSheet').close();
  if (target) {
    const before = { ...target };
    Object.assign(target, x);
    commit();
    undoable('Gespeichert', () => Object.assign(target, before));
  } else {
    const added = { id: uid(), url: null, shop: 'Eigene Einträge', priceNote: null, ...x };
    l.items.push(added);
    commit();
    undoable(x.done ? 'Hinzugefügt und abgehakt' : 'Hinzugefügt', () => { l.items = l.items.filter((i) => i !== added); });
  }
});

$('itemDelete').addEventListener('click', () => {
  if (!editing || !confirm(`„${editing.name}“ löschen?`)) return;
  const l = active();
  const gone = editing, idx = l.items.indexOf(gone);
  l.items = l.items.filter((i) => i !== gone);
  $('itemSheet').close();
  commit();
  undoable(`„${short(gone.name)}“ gelöscht`, () => l.items.splice(idx, 0, gone));
});

// ---------- Start ----------
(async () => {
  try {
    const s = await load('state');
    if (s?.lists?.length) state = { ...DEFAULTS, ...s, browse: { ...DEFAULTS.browse, ...s.browse } };
  } catch (e) {
    toast('Speicher nicht verfügbar: ' + e.message, 5000);
  }
  if (!state.lists.length) newList('Einkauf');
  if (!active()) state.activeId = state.lists[0].id;
  render();
  navigator.storage?.persist?.(); // Daten vor automatischem Löschen schützen

  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !standalone && localStorage.getItem('hideInstall') !== '1') $('installHint').hidden = false;
  $('installHide').addEventListener('click', () => { $('installHint').hidden = true; try { localStorage.setItem('hideInstall', '1'); } catch {} });

  // Offline-Cache. Neue Version (sw.js geändert) → Hinweis mit „Neu laden“
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('Neue Version der App ist da', 30000, { label: 'Neu laden', run: () => location.reload() });
    });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // Vom Home-Bildschirm wird die App oft nur fortgesetzt, nicht neu geladen → beim Zurückkehren nach Updates schauen
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
  }
})();
