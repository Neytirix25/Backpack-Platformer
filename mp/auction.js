// =====================================================================
//  THE AUCTION HOUSE (MP.auction) — fixed-price listings kept online in Cloud Firestore, so they stay when nobody is
//  in a street and every player on every street sees the same ones. Animals, fish and cooked dishes can be listed.
//
//  ONE DOCUMENT PER LISTING: auctions/{id}   (id: 20 letters and digits, chosen by the seller's game BEFORE the write,
//  so a listing whose answer never arrived can be looked up again)
//    seller      uid of the seller                     sellerName  their street name (<= 16)
//    cat         'animal' | 'fish' | 'dish'            sub         species / fish key (<= 24)
//    title       a display name (<= 40)                price       integer 1..99999
//    item        the item as JSON text (<= 6000):  animal { k, lvl, xp, talents, g, nick } · fish { k } · dish { k, q }
//    lvl, rarity, shiny                                small facts (for a future server-side filter)
//    created     the SERVER's time of the write (a field transform; the rules insist on request.time)
//    state       'open' | 'sold'                       buyer, buyerName, soldAt   (null / '' / null until it is sold)
//  A listing lives 48 hours from `created`. There is no stored `expires` field on purpose: the browser's clock cannot
//  be trusted and the server's time is only known after the write, so "expires" is always created + 48 h, in the
//  rules (no buying after it), in the query (created > now - 48 h) and in the panel.
//  Everything read from a listing is untrusted: parseDoc checks every type and size, the item goes through the trade
//  code's cleaning (tradeItem / cleanGenes) and whatever is shown (name, level, rarity...) is derived from the cleaned
//  item, never from the document's own title / lvl / rarity fields. An impossible listing is skipped.
//
//  THE REST CALLS (plain fetch through index.html's fbJson / accToken; the Firestore REST API, v1):
//    browse   POST documents:runQuery   structuredQuery { from auctions, where created > (now - 48 h),
//             orderBy created DESCENDING, limit 50, startAt { values: [last created], before: false } }  (no sign-in)
//    mine     POST documents:runQuery   structuredQuery { from auctions, where seller == <uid>, limit 40 }
//    look     GET  documents/auctions/{id}
//    list     POST documents:commit     one write: update (all fields) + currentDocument { exists: false }
//             + updateTransforms [created = REQUEST_TIME]
//    buy      POST documents:commit     one write: update { state: 'sold', buyer, buyerName } with updateMask,
//             updateTransforms [soldAt = REQUEST_TIME], currentDocument { updateTime: <the version I looked at> }
//             (two buyers: the second one's version is stale, the write fails, nothing is paid)
//    remove   DELETE documents/auctions/{id}?currentDocument.updateTime=<version>   (seller only: cancel, expired, paid)
//  INDEXES: none to create. Both queries use one field each (created: range + order; seller: equality), which the
//  automatic single-field indexes serve. Category, state and the sub-filters are applied in the browser to the loaded
//  pages (50 documents each, "Load more" for the next page).
//
//  THE SELLER'S SIDE (nothing may be lost): the item leaves the game at once and waits in MP.econ.data.ah.esc
//  ("escrow") with the listing's id:  { id, uid, cat, it, price, st: 'new' | 'live' | 'back', at }
//    'new'   written and saved BEFORE the network call. If the create fails the item comes straight back; if the page
//            closes in between, the next visit looks the id up (there: 'live', not there: the item comes back, and
//            the id is remembered in ah.dead so a write that lands late is deleted, not adopted as a second copy).
//    'live'  the listing is online. `settle` (on opening the panel, on Refresh, and every few minutes in the street)
//            looks at my listings: SOLD -> the document is deleted, then price minus the 5% fee is paid in Gold;
//            EXPIRED (or cancelled) -> deleted, the item comes back. A listing of mine found online without an
//            escrow note (another device) is adopted from the document.
//    'back'  the item is mine again but did not fit (a full bag): it waits here, the panel shows a Collect button.
//  THE BUYER'S SIDE: Gold and room in the bag are checked first; a note { id, price } is saved in ah.buys before the
//  write and removed after it, so a purchase whose answer never arrived is finished (or dropped) at the next visit.
//  Gold is paid and the item handed over only after the write succeeded. A bought animal arrives like a traded one
//  (new id, bond 0).
//  FEE: 5% rounded down, at least 1 Gold, and the seller always receives at least 1 Gold.
//  LIMITS (checked by the game, not by the server): 8 active listings per player; the rules cap every field.
//  CLEAN-UP: sold / expired listings of players who never come back are not shown (the query's 48 h window) but stay
//  in the database. Idea for later: a Firestore TTL policy on a timestamp field, or a scheduled function that deletes
//  auctions older than ~30 days. (No server is part of this game.)
//
//  THE PANEL: MP.stations.mp_auction opens G.panel 'mpauction' (MP.panels.mpauction: draw, click, up, keys, wheel).
//  Buttons act on the press; a list's rows act on the release, and only when the list was not dragged in between
//  (a finger dragging the list arrives as press, move, release). Prices are typed with the digit keys or the
//  on-screen keypad; "Find by name" takes letters from the keyboard (it is hidden on touch screens).
//  No hook in index.html: the station, the panel and the tick use the MP.stations / MP.panels / MP.ticks tables.
// =====================================================================
(() => {
  const AH = MP.auction = { clock: () => Date.now(), timeout: 15000 };
  const COL = 'auctions', LIFE = 48 * 3600e3, MAX_LIST = 8, MAX_PRICE = 99999, PAGE = 50, MINE_MAX = 40, ITEM_CAP = 6000, COOL = 5000, SETTLE_EVERY = 180, ESC_MAX = 24, AH_ROOM = 50000;
  const CATS = { animal: { name: 'Animals', one: 'animal' }, fish: { name: 'Fish', one: 'fish', bag: 'fish', pre: 'fish_' }, dish: { name: 'Dishes', one: 'dish', bag: 'pantry', pre: 'dish_' } };
  const TABS = [{ id: 'all', name: 'All' }, { id: 'animal', name: 'Animals' }, { id: 'fish', name: 'Fish' }, { id: 'dish', name: 'Dishes' }, { id: 'mine', name: 'My listings' }, { id: 'cos', name: 'Cosmetics' }];
  const SORTS = { new: 'newest', lo: 'price ▲', hi: 'price ▼', lvl: 'level ▼' }, ROMAN = ['', 'I', 'II', 'III', 'IV'];
  const ID_RX = /^[A-Za-z0-9]{20}$/, TIME_RX = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;
  const MSG = { offline: "The auction house can't be reached right now.", closed: "The auction house isn't open yet.", login: 'Log in at the Records Hall to buy and sell (the account button on its board).' };
  const S = AH.S = { view: 'list', tab: 'all', rows: [], cursor: null, more: false, loading: false, err: null, last: 0, off: 0, mineDocs: new Map(), mineErr: null,
                     f: { act: 0, role: '', shiny: false, rar: '', sort: 'new', q: '' }, typing: false, sc: { list: 0, pick: 0 }, drag: null, sel: null, ask: false,
                     sell: { cat: 'animal', src: null, price: '' }, busy: '', note: null, chain: Promise.resolve(), tick: SETTLE_EVERY - 6 };

  // ---------- small helpers ----------
  const E = () => (MP.econ && MP.econ.data && typeof MP.econ.data === 'object' ? MP.econ : null);
  const me = () => (typeof ACC !== 'undefined' && ACC.user && typeof ACC.user.uid === 'string' && ACC.user.uid ? ACC.user : null);
  const serverNow = () => AH.clock() + S.off;
  const base = () => `https://firestore.googleapis.com/v1/projects/${FB.projectId}/databases/(default)/documents`;
  const docName = id => `projects/${FB.projectId}/databases/(default)/documents/${COL}/${id}`;
  const fee = p => Math.min(p - 1, Math.max(1, Math.floor(p * 0.05)));   /* 5%, at least 1; a 1 Gold sale still pays 1 */
  const payout = p => Math.max(1, p - Math.max(0, fee(p)));
  const fmt = n => (MP.econ && MP.econ.fmt ? MP.econ.fmt(n) : String(n));
  const cleanName = s => { let t = typeof s === 'string' ? s.replace(/[^\p{L}\p{N} '\-._!]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16) : ''; try { if (t && MP.hub && MP.hub._ && MP.hub._.censor) t = MP.hub._.censor(t); } catch (e) {} return t || 'Someone'; };
  const myStreetName = () => cleanName(typeof myName === 'function' ? myName() : (me() || {}).name);
  function newId() {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let b = null, s = '';
    try { b = crypto.getRandomValues(new Uint8Array(20)); } catch (e) { b = null; }
    for (let i = 0; i < 20; i++) s += A[(b ? b[i] : Math.floor(Math.random() * 256)) % A.length];
    return s;
  }
  function timeLeft(ms) { return ms <= 0 ? 'expired' : ms < 60e3 ? 'under a minute left' : ms < 3600e3 ? `${Math.ceil(ms / 60e3)} min left` : `${Math.floor(ms / 3600e3)} h left`; }
  function say(t, bad) { S.note = { t: String(t), bad: !!bad, until: TIME + 5 }; try { SFX.play(bad ? 'error' : 'pick'); } catch (e) {} if (G && G.panel !== 'mpauction') showMsg(String(t), 3.2); }
  const isOpen = () => !!G && G.panel === 'mpauction';

  // ---------- items: what is listed, what waits in escrow, what is shown ----------
  // a display item from untrusted data (null = impossible, the listing is skipped)
  function build(cat, o) {
    try {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
      if (cat === 'animal') return tradeItem(o);
      if (cat !== 'fish' && cat !== 'dish') return null;
      if (typeof o.k !== 'string' || !Object.prototype.hasOwnProperty.call(FISH, o.k) || !ITEMS[CATS[cat].pre + o.k]) return null;
      const it = makeItem(CATS[cat].pre + o.k);
      if (cat === 'dish') it.q = Number.isInteger(o.q) && o.q >= 0 && o.q < DISH_Q.length ? o.q : 2;
      return it;
    } catch (e) { return null; }
  }
  // the item as it goes into a listing document (small, nothing private)
  function lite(cat, it) {
    if (cat === 'animal') return { k: it.def.pet, lvl: petLvl(it), xp: Math.floor(it.xp || 0), talents: it.talents || {}, g: it.g, nick: it.nick || '' };
    return cat === 'dish' ? { k: it.def.dish, q: dishQ(it) } : { k: it.def.fish };
  }
  // the same, cleaned (from a document or from the saved escrow): what build() made of it, as plain data again
  function relite(cat, o, own) {
    const it = build(cat, o); if (!it) return null;
    const out = lite(cat, it);
    if (cat === 'animal' && own) {   /* my own animal in escrow also keeps its id and its story */
      if (typeof o.pid === 'string' && /^[\w-]{1,40}$/.test(o.pid)) out.pid = o.pid;
      for (const k of ['born', 'rec']) { try { if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) && JSON.stringify(o[k]).length <= 400) out[k] = JSON.parse(JSON.stringify(o[k])); } catch (e) {} }
    }
    return out;
  }
  function itemName(cat, it) { return cat === 'animal' ? petName(it) : cat === 'dish' ? dishName(it) : it.def.name; }
  function facts(cat, it) {   /* what the list shows and filters on: always derived from the cleaned item */
    const k = cat === 'animal' ? it.def.pet : cat === 'dish' ? it.def.dish : it.def.fish, g = it.g || {};
    const o = { name: itemName(cat, it), sub: k, rarity: it.def.rarity, lvl: cat === 'animal' ? petLvl(it) : 0, shiny: cat === 'animal' && !!g.shiny, act: 0, role: '' };
    if (cat === 'animal') { o.act = speciesAct(k); o.role = PETS[k].role || ''; o.line = `Lv ${o.lvl} ${sexSym(g)} ${gradeLine(g)} · ${o.role}`; o.search = (o.name + ' ' + it.def.name + ' ' + (BS[k].baby || '')).toLowerCase(); }
    else { const gn = cat === 'dish' ? dishGain(it) : null; o.line = RARITY[o.rarity].label + (cat === 'dish' ? ` dish · +${gn.xp} XP, +${gn.bond} bond` : ' fish'); o.search = o.name.toLowerCase(); }
    return o;
  }
  function roomFor(cat, it) { return cat === 'animal' ? true : !!fishBagFit(bagItems(CATS[cat].bag), it); }
  function petsChanged() { try { stats = computeStats(); syncPets(); } catch (e) {} savePets(); try { if (G && G.hub && G.room) spawnHubPets(G.room); } catch (e) {} }
  // why one of my animals cannot be listed (null = it can): the same locks as giving one away, and never the last one
  function animalLock(it) { return giveLock(it) || (HERD.length < 2 ? 'Your last animal' : null); }
  // an item joins my game: true when it did (false: the bag is full). how = 'bought' (bond 0, a new id) | 'back'
  function receive(cat, o, how, from) {
    const b = build(cat, o); if (!b) return true;   /* (impossible data: nothing to hand over; never keep it waiting) */
    if (cat !== 'animal') return bagAdd(CATS[cat].bag, b);
    const k = b.def.pet, fresh = !owned(k), got = newPet(k, b.plvl, Object.assign({}, b.g, how === 'bought' ? { bond: 0 } : {}));
    got.xp = b.xp || 0; got.talents = b.talents || {}; got.nick = cleanNick(b.nick);
    if (how === 'bought') {
      got.born = { how: 'bought', at: Date.now(), from: cleanName(from) };
      SAVE.coll[k] = (SAVE.coll[k] || 0) + 1; if (fresh) SAVE.rec.rescues++; if (got.g.shiny) SAVE.rec.shinies = (SAVE.rec.shinies || 0) + 1;
    } else {
      if (typeof o.pid === 'string' && o.pid && !HERD.some(x => x !== got && x.pid === o.pid)) got.pid = o.pid;
      if (o.born && typeof o.born === 'object') got.born = o.born; if (o.rec && typeof o.rec === 'object') got.rec = o.rec;
    }
    if (!petSlots.some(Boolean)) petSlots[0] = got;
    petsChanged(); return true;
  }

  // ---------- my saved state (MP.econ.data.ah): cleaned whenever MP.econ has (re)loaded it ----------
  const CLEANED = new WeakSet();
  function cleanEsc(x) {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !ID_RX.test(x.id) || !CATS[x.cat]) return null;
    const it = relite(x.cat, x.it, true); if (!it) return null;
    return { id: x.id, uid: typeof x.uid === 'string' ? x.uid.slice(0, 128) : '', cat: x.cat, it, price: clamp(Math.floor(+x.price) || 1, 1, MAX_PRICE), st: x.st === 'live' || x.st === 'back' ? x.st : 'new', at: Number.isFinite(+x.at) ? +x.at : 0 };
  }
  function ah() {
    const e = E(); if (!e) return null;
    let a = e.data.ah; if (!a || typeof a !== 'object' || Array.isArray(a)) a = e.data.ah = {};
    if (CLEANED.has(a)) return a;
    const seen = new Set();
    a.v = 1;
    a.esc = (Array.isArray(a.esc) ? a.esc : []).map(cleanEsc).filter(x => x && !seen.has(x.id) && seen.add(x.id)).slice(0, ESC_MAX + 8);
    a.buys = (Array.isArray(a.buys) ? a.buys : []).filter(b => b && typeof b === 'object' && typeof b.id === 'string' && ID_RX.test(b.id)).slice(0, 8).map(b => ({ id: b.id, uid: typeof b.uid === 'string' ? b.uid.slice(0, 128) : '', price: clamp(Math.floor(+b.price) || 1, 1, MAX_PRICE) }));
    a.notes = (Array.isArray(a.notes) ? a.notes : []).filter(s => typeof s === 'string').slice(-6).map(s => s.slice(0, 140));
    a.dead = (Array.isArray(a.dead) ? a.dead : []).filter(s => typeof s === 'string' && ID_RX.test(s)).slice(-16);
    CLEANED.add(a); return a;
  }
  const saveAh = () => { const e = E(); return e ? e.save() : false; };
  const activeCount = a => a.esc.filter(e => e.st !== 'back').length;
  // a listing that was looked up and was not there, so its item came back. Should its write land after all (a request
  // that outlived its time-out), that document must not be adopted as a second copy: settle deletes it instead.
  function declareDead(a, e) { if (e.st === 'new') { a.dead.push(e.id); if (a.dead.length > 16) a.dead.splice(0, a.dead.length - 16); } e.st = 'back'; }
  function addNote(a, t) { a.notes.push(String(t).slice(0, 140)); if (a.notes.length > 6) a.notes.splice(0, a.notes.length - 6); }
  // everything that waits to come back tries to (a full bag keeps it waiting). Returns how many came back.
  function giveBack(a, quiet) {
    let n = 0;
    for (const e of a.esc.slice()) {
      if (e.st !== 'back') continue;
      let ok = false; try { ok = receive(e.cat, e.it, 'back'); } catch (err) { ok = false; }
      if (!ok) continue;
      a.esc.splice(a.esc.indexOf(e), 1); n++;
      if (!quiet) { const b = build(e.cat, e.it); say(`${b ? itemName(e.cat, b) : 'Your item'} is back with you.`); }
    }
    if (n) saveAh();
    return n;
  }

  // ---------- the Firestore REST calls ----------
  const timed = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });
  // one call -> { ok, kind, j }.  kind: 'offline' (no answer: the outcome is unknown) | 'denied' (the rules said no)
  // | 'gone' (no such document) | 'changed' (a precondition failed) | 'login' | 'error'
  async function call(path, opt = {}) {
    const o = { method: opt.method || 'GET', headers: {} };
    if (opt.body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opt.body); }
    if (opt.auth) { try { o.headers.Authorization = 'Bearer ' + await timed(accToken(), AH.timeout); } catch (e) { return { ok: false, kind: me() ? 'offline' : 'login', j: {} }; } }
    let r, j;
    try { const x = await timed(fbJson(base() + path, o), AH.timeout); r = x.r; j = x.j; } catch (e) { return { ok: false, kind: 'offline', j: {} }; }
    const err = (Array.isArray(j) ? (j.find(x => x && x.error) || {}).error : j && j.error) || null;
    if (r && r.ok && !err) return { ok: true, kind: null, j };
    const status = (r && r.status) || (err && err.code) || 0, st = String((err && err.status) || '') + ' ' + String((err && err.message) || '');
    const kind = status === 403 || /PERMISSION_DENIED/.test(st) ? 'denied' : status === 404 || /NOT_FOUND/.test(st) ? 'gone' : status === 409 || /FAILED_PRECONDITION|ABORTED|ALREADY_EXISTS/.test(st) ? 'changed'
      : status === 401 || /UNAUTHENTICATED/.test(st) ? 'login' : status >= 500 || status === 429 || !status ? 'offline' : 'error';
    return { ok: false, kind, j };
  }
  const enc = v => (v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(Math.trunc(v)) } : { stringValue: String(v) });
  const fStr = (f, k, max) => { const v = f[k] && typeof f[k] === 'object' ? f[k].stringValue : null; return typeof v === 'string' && v.length <= max ? v : null; };
  function fTime(f, k) { const v = f[k] && typeof f[k] === 'object' ? f[k].timestampValue : null; if (typeof v !== 'string' || !TIME_RX.test(v)) return null; const ms = Date.parse(v); return Number.isFinite(ms) ? { ms, raw: v } : null; }
  function sawServerTime(t) { if (typeof t === 'string' && TIME_RX.test(t)) { const ms = Date.parse(t); if (Number.isFinite(ms)) S.off = ms - AH.clock(); } }
  // a listing document -> a row (null: not a listing I can make sense of). row.it = null: its item is impossible.
  function parseDoc(d) {
    try {
      if (!d || typeof d !== 'object' || typeof d.name !== 'string' || typeof d.updateTime !== 'string' || d.updateTime.length > 40) return null;
      const id = d.name.slice(d.name.lastIndexOf('/') + 1), f = d.fields;
      if (!ID_RX.test(id) || d.name !== docName(id) || !f || typeof f !== 'object') return null;
      const seller = fStr(f, 'seller', 128), cat = fStr(f, 'cat', 8), state = fStr(f, 'state', 8), created = fTime(f, 'created'), pv = f.price && typeof f.price === 'object' ? f.price.integerValue : null;
      const price = typeof pv === 'string' && /^\d{1,5}$/.test(pv) ? +pv : typeof pv === 'number' && Number.isInteger(pv) ? pv : 0;
      if (!seller || !CATS[cat] || (state !== 'open' && state !== 'sold') || !created || price < 1 || price > MAX_PRICE) return null;
      const row = { id, ut: d.updateTime, seller, sellerName: cleanName(fStr(f, 'sellerName', 16)), cat, price, state, created: created.ms, createdRaw: created.raw, buyer: fStr(f, 'buyer', 128) || '', buyerName: cleanName(fStr(f, 'buyerName', 16)), o: null, it: null };
      const text = fStr(f, 'item', ITEM_CAP); let o = null;
      if (text) { try { o = JSON.parse(text); } catch (e) { o = null; } }
      row.o = o ? relite(cat, o) : null; row.it = row.o ? build(cat, row.o) : null;
      if (row.it) Object.assign(row, facts(cat, row.it));
      return row;
    } catch (e) { return null; }
  }
  async function runQuery(sq) {
    const r = await call(':runQuery', { method: 'POST', body: { structuredQuery: sq } });
    if (!r.ok) return r;
    const list = Array.isArray(r.j) ? r.j : [], rows = []; let n = 0, last = null;
    for (const x of list) {
      if (!x || typeof x !== 'object') continue;
      sawServerTime(x.readTime);
      if (!x.document) continue;
      n++; const c = x.document.fields && fTime(x.document.fields, 'created'); if (c) last = c.raw;
      const row = parseDoc(x.document); if (row) rows.push(row);
    }
    return { ok: true, rows, n, last };
  }
  async function getDoc(id) {
    const r = await call(`/${COL}/${id}`);
    if (!r.ok) return r;
    return { ok: true, row: parseDoc(r.j) };
  }
  async function commit(write) {
    const r = await call(':commit', { method: 'POST', auth: true, body: { writes: [write] } });
    if (r.ok) sawServerTime(r.j && r.j.commitTime);
    return r;
  }
  const remove = (id, ut) => call(`/${COL}/${id}?currentDocument.updateTime=${encodeURIComponent(ut)}`, { method: 'DELETE', auth: true });

  // ---------- browsing ----------
  function browseQuery(cursor) {
    const sq = { from: [{ collectionId: COL }], where: { fieldFilter: { field: { fieldPath: 'created' }, op: 'GREATER_THAN', value: { timestampValue: new Date(serverNow() - LIFE).toISOString() } } },
                 orderBy: [{ field: { fieldPath: 'created' }, direction: 'DESCENDING' }], limit: PAGE };
    if (cursor) sq.startAt = { values: [{ timestampValue: cursor }], before: false };
    return sq;
  }
  async function loadPage(first) {
    if (S.loading) return false;
    S.loading = true;
    const r = await runQuery(browseQuery(first ? null : S.cursor));
    S.loading = false;
    if (!r.ok) { S.err = r.kind === 'denied' ? 'closed' : 'offline'; if (first) { S.rows = []; S.more = false; } return false; }
    S.err = null; S.last = AH.clock();
    const have = new Set(first ? [] : S.rows.map(x => x.id));
    S.rows = (first ? [] : S.rows).concat(r.rows.filter(x => !have.has(x.id)));
    S.cursor = r.last || S.cursor; S.more = r.n >= PAGE && !!r.last;
    return true;
  }
  const coolLeft = () => Math.max(0, COOL - (AH.clock() - (S.lastAsk || -1e9)));
  // Refresh: the list again from the top, and my own listings settled (paid, returned)
  function refresh(force) {
    if (!force && (coolLeft() > 0 || S.loading)) return Promise.resolve(false);
    S.lastAsk = AH.clock(); S.sc.list = 0;
    const p = loadPage(true);
    return Promise.all([p, settle(true)]).then(() => true);
  }
  function visible() {
    const t = S.tab, f = S.f, now = serverNow(), q = f.q.trim().toLowerCase();
    let rows = S.rows.filter(r => r.it && r.state === 'open' && r.created + LIFE > now && (t === 'all' || r.cat === t));
    if (t === 'animal') rows = rows.filter(r => (!f.act || r.act === f.act) && (!f.role || r.role === f.role) && (!f.shiny || r.shiny));
    if ((t === 'fish' || t === 'dish') && f.rar) rows = rows.filter(r => r.rarity === f.rar);
    if (q) rows = rows.filter(r => r.search.includes(q));
    const s = f.sort === 'lvl' && t !== 'animal' ? 'new' : f.sort;
    return rows.sort((a, b) => (s === 'lo' ? a.price - b.price : s === 'hi' ? b.price - a.price : s === 'lvl' ? b.lvl - a.lvl : 0) || b.created - a.created);
  }

  // ---------- my listings: settle (paid / returned / recovered), sell, cancel, buy ----------
  // one after another: selling, buying, cancelling and settling never run at the same time
  function serial(fn) { const p = S.chain.then(fn, fn); S.chain = p.then(() => {}, () => {}); return p; }
  function paid(a, e, d) {
    const b = build(e.cat, e.it), nm = b ? itemName(e.cat, b) : 'item', get = payout(d.price), ec = E();
    a.esc.splice(a.esc.indexOf(e), 1);
    if (ec) ec.add(get, 'Auction sale');
    const t = `Your ${nm} sold to ${d.buyerName} for ${fmt(d.price)} Gold (${fmt(get)} after the fee).`;
    addNote(a, t); saveAh(); say(t); try { SFX.play('coin'); } catch (err) {}
  }
  function settle(quiet) { return serial(() => settleNow(quiet).catch(() => false)); }
  async function settleNow(quiet) {
    const a = ah(); if (!a) return false;
    const U = me(); let docs = null, dirty = false;
    giveBack(a, quiet);
    if (U) {
      const q = await runQuery({ from: [{ collectionId: COL }], where: { fieldFilter: { field: { fieldPath: 'seller' }, op: 'EQUAL', value: { stringValue: U.uid } } }, limit: MINE_MAX });
      if (!q.ok) { S.mineErr = q.kind === 'denied' ? 'closed' : 'offline'; return false; }
      S.mineErr = null; docs = new Map(q.rows.filter(r => r.seller === U.uid).map(r => [r.id, r]));
      /* a listing of mine that this save has no note of (made on another device): its item is adopted from the document */
      for (const r of [...docs.values()]) {
        if (a.esc.some(e => e.id === r.id)) continue;
        if (a.dead.includes(r.id)) { if (r.state === 'open') { const x = await remove(r.id, r.ut); if (x.ok || x.kind === 'gone') docs.delete(r.id); } continue; }   /* (its item already came back: see declareDead) */
        if (r.o && a.esc.length < ESC_MAX + 8) { a.esc.push({ id: r.id, uid: U.uid, cat: r.cat, it: r.o, price: r.price, st: 'live', at: r.created }); dirty = true; }
      }
    }
    for (const e of a.esc.slice()) {
      if (e.st === 'back') continue;
      const mineNow = !!U && (!e.uid || e.uid === U.uid);
      if (!mineNow && e.st !== 'new') continue;   /* (another account's listing waits for that account; an unconfirmed one can be looked up by anyone) */
      let d = mineNow && docs ? docs.get(e.id) : null;
      if (!d) {
        const g = await getDoc(e.id);
        if (g.kind === 'gone') { declareDead(a, e); dirty = true; continue; }   /* never written, or already removed: the item comes back */
        if (!g.ok) continue;
        d = g.row;
        if (!d) { if (e.st === 'new') continue; d = { id: e.id, bad: true }; }
      }
      if (e.st === 'new') { if (d.seller && e.uid && d.seller !== e.uid) { e.st = 'back'; dirty = true; continue; } e.st = 'live'; dirty = true; }
      if (!mineNow || d.bad || d.seller !== U.uid) continue;
      if (docs) docs.set(e.id, d);
      const sold = d.state === 'sold', over = d.created + LIFE <= serverNow();
      if (!sold && !over) continue;
      const x = await remove(e.id, d.ut);
      if (x.ok) { if (docs) docs.delete(e.id); if (sold) paid(a, e, d); else { e.st = 'back'; dirty = true; if (!quiet || isOpen()) say('A listing ran out unsold: the item comes back to you.'); } }
      else if (x.kind === 'gone') { if (docs) docs.delete(e.id); if (sold) a.esc.splice(a.esc.indexOf(e), 1); else e.st = 'back'; dirty = true; }   /* settled from another device meanwhile */
    }
    if (U) {   /* purchases whose answer never arrived */
      for (const b of a.buys.slice()) {
        if (b.uid && b.uid !== U.uid) continue;
        const g = await getDoc(b.id);
        if (!g.ok && g.kind !== 'gone') continue;
        a.buys.splice(a.buys.indexOf(b), 1); dirty = true;
        if (g.ok && g.row && g.row.it && g.row.state === 'sold' && g.row.buyer === U.uid) gotIt(a, g.row);
      }
    }
    if (docs) S.mineDocs = docs;
    giveBack(a, quiet);
    if (dirty) saveAh();
    return true;
  }
  // the purchase went through: pay, and the item arrives (or waits for room)
  function gotIt(a, row) {
    const ec = E(); if (ec && !ec.spend(row.price, 'Auction: ' + row.name)) ec.spend(ec.gold(), 'Auction: ' + row.name);
    let ok = false; try { ok = receive(row.cat, row.o, 'bought', row.sellerName); } catch (e) { ok = false; }
    if (!ok) a.esc.push({ id: row.id, uid: (me() || {}).uid || '', cat: row.cat, it: row.o, price: row.price, st: 'back', at: AH.clock() });
    S.rows = S.rows.filter(r => r.id !== row.id);
    saveAh();
    say(ok ? `You bought ${row.name} for ${fmt(row.price)} Gold.` : `You bought ${row.name}. It waits under My listings until your bag has room.`);
    try { SFX.play('chest', true); } catch (e) {}
  }
  function buy(id) { return serial(() => buyNow(id)); }
  async function buyNow(id) {
    const row = S.rows.find(r => r.id === id), U = me(), ec = E(), a = ah();
    const no = t => { say(t, true); return false; };
    if (!U) return no(MSG.login);
    if (!ec || !a) return no('Gold is not part of this copy of the game.');
    if (!row || !row.it) return no('That listing is gone.');
    if (row.seller === U.uid) return no('That is your own listing.');
    if (row.state !== 'open' || row.created + LIFE <= serverNow()) return no('That listing has ended.');
    if (ec.gold() < row.price) return no(`You need ${fmt(row.price - ec.gold())} more Gold.`);
    if (!roomFor(row.cat, row.it)) return no(`Your ${BAGS[CATS[row.cat].bag].title} is full: make room first.`);
    a.buys = a.buys.filter(b => b.id !== id).slice(-7); a.buys.push({ id, uid: U.uid, price: row.price }); saveAh();
    S.busy = 'Buying...';
    const r = await commit({ update: { name: docName(id), fields: { state: enc('sold'), buyer: enc(U.uid), buyerName: enc(myStreetName()) } }, updateMask: { fieldPaths: ['state', 'buyer', 'buyerName'] },
                             updateTransforms: [{ fieldPath: 'soldAt', setToServerValue: 'REQUEST_TIME' }], currentDocument: { updateTime: row.ut } });
    S.busy = '';
    const drop = () => { a.buys = a.buys.filter(b => b.id !== id); saveAh(); };
    if (r.ok) { drop(); gotIt(a, row); return true; }
    if (r.kind === 'offline') return no(MSG.offline + ' If the purchase went through, it arrives at the next Refresh.');   /* (the note stays: settle finishes or drops it) */
    if (r.kind === 'login') { drop(); return no('Please log in again at the Records Hall.'); }
    /* a clear "no": look at the listing to say why */
    S.busy = 'Checking...'; const g = await getDoc(id); S.busy = '';
    if (!g.ok && g.kind !== 'gone') { if (r.kind === 'denied') S.err = 'closed'; drop(); return no(r.kind === 'denied' ? MSG.closed : MSG.offline); }
    drop();
    if (g.ok && g.row && g.row.it && g.row.state === 'sold' && g.row.buyer === U.uid) { gotIt(a, g.row); return true; }   /* (it was mine after all: an earlier try had landed) */
    if (g.ok && g.row && g.row.state === 'open' && g.row.ut === row.ut) {
      if (g.row.created + LIFE <= serverNow()) { S.rows = S.rows.filter(x => x.id !== id); return no('That listing has just run out.'); }
      return no('The auction house would not sell that one (it may have just run out). Try Refresh.');
    }
    if (g.ok && g.row && g.row.state === 'open') { Object.assign(row, { ut: g.row.ut }); return no('That listing changed. Try again.'); }
    S.rows = S.rows.filter(x => x.id !== id);
    return no('Too late: someone else just bought it. You keep your Gold.');
  }
  // what I could list in a category: [{ it, lock, src }] (src: the animal itself, or the index in its bag)
  function stock(cat) {
    if (cat === 'animal') return rosterList().map(it => ({ it, src: it, lock: animalLock(it) }));
    return bagItems(CATS[cat].bag).map((it, i) => ({ it, src: i, lock: null }));
  }
  function sell(cat, src, price) { return serial(() => sellNow(cat, src, price)); }
  async function sellNow(cat, src, price) {
    const U = me(), ec = E(), a = ah();
    const no = t => { say(t, true); return false; };
    if (!U) return no(MSG.login);
    if (!ec || !a) return no('Gold is not part of this copy of the game.');
    if (!CATS[cat]) return no('That cannot be listed.');
    if (!Number.isInteger(price) || price < 1 || price > MAX_PRICE) return no(`The price must be 1 to ${fmt(MAX_PRICE)} Gold.`);
    if (activeCount(a) >= MAX_LIST) return no(`You already have ${MAX_LIST} listings. Cancel one, or wait until one is sold.`);
    if (typeof SAVE_LOCK !== 'undefined' && SAVE_LOCK) return no('The game is about to restart with another save.');
    let it = null, bag = null;
    if (cat === 'animal') { it = HERD.includes(src) ? src : null; if (!it) return no('That animal is not in your Sanctuary.'); const l = animalLock(it); if (l) return no(`${petName(it)} can't be sold: ${l.toLowerCase()}.`); }
    else { bag = bagItems(CATS[cat].bag); it = Number.isInteger(src) ? bag[src] : null; if (!it) return no('That is not in your bag any more.'); }
    const own = cat === 'animal' ? Object.assign(lite(cat, it), { pid: it.pid, born: it.born, rec: it.rec }) : lite(cat, it), keep = relite(cat, own, true), doc = keep && relite(cat, keep);
    const text = doc ? JSON.stringify(doc) : '', F = doc && build(cat, doc) ? facts(cat, build(cat, doc)) : null;
    if (!F || text.length > ITEM_CAP) return no('That cannot be listed.');
    const id = newId(), entry = { id, uid: U.uid, cat, it: keep, price, st: 'new', at: AH.clock() };
    a.esc.push(entry);
    let size = AH_ROOM + 1; try { size = JSON.stringify(a).length; } catch (e) {}
    if (size > AH_ROOM || !saveAh()) { a.esc.splice(a.esc.indexOf(entry), 1); return no('The auction house has no room for more of your things right now.'); }
    /* the escrow note is saved: now the item leaves the game */
    if (cat === 'animal') { HERD.splice(HERD.indexOf(it), 1); petsChanged(); } else { bag.splice(src, 1); saveBag(CATS[cat].bag, bag); }
    S.busy = 'Listing...';
    const fields = { seller: enc(U.uid), sellerName: enc(myStreetName()), cat: enc(cat), sub: enc(String(F.sub).slice(0, 24)), title: enc(String(F.name).slice(0, 40) || '?'), price: enc(price), item: enc(text),
                     lvl: enc(F.lvl), rarity: enc(String(F.rarity).slice(0, 12)), shiny: enc(!!F.shiny), state: enc('open'), buyer: enc(null), buyerName: enc(''), soldAt: enc(null) };
    let r = await commit({ update: { name: docName(id), fields }, currentDocument: { exists: false }, updateTransforms: [{ fieldPath: 'created', setToServerValue: 'REQUEST_TIME' }] });
    if (!r.ok && r.kind === 'offline') {   /* no answer: did it land? */
      const g = await getDoc(id);
      if (g.ok) r = { ok: true }; else if (g.kind !== 'gone') { S.busy = ''; return no(MSG.offline + ' Your item is safe: the listing is checked again at the next Refresh.'); }
    }
    S.busy = '';
    if (!r.ok) declareDead(a, entry);
    if (r.ok) { entry.st = 'live'; saveAh(); say(`${F.name} is listed for ${fmt(price)} Gold.`); try { SFX.play('place'); } catch (e) {} return true; }
    saveAh(); giveBack(a, true);
    if (r.kind === 'denied') S.err = 'closed';
    return no((r.kind === 'denied' ? MSG.closed : r.kind === 'login' ? 'Please log in again at the Records Hall.' : MSG.offline) + ' Your item is back with you.');
  }
  function cancel(id) { return serial(() => cancelNow(id)); }
  async function cancelNow(id) {
    const a = ah(), U = me(), e = a && a.esc.find(x => x.id === id);
    const no = t => { say(t, true); return false; };
    if (!e) return false;
    if (e.st === 'back') { if (giveBack(a, false)) return true; return no(e.cat === 'animal' ? 'It could not come back just now.' : `Your ${BAGS[CATS[e.cat].bag].title} is full: make room, then Collect.`); }
    if (!U || (e.uid && e.uid !== U.uid)) return no(MSG.login);
    S.busy = 'Cancelling...';
    const g = await getDoc(id); let x = null;
    if (g.ok && g.row && g.row.seller === U.uid && g.row.state === 'open') x = await remove(id, g.row.ut);
    S.busy = '';
    if (g.kind === 'gone' || (x && (x.ok || x.kind === 'gone'))) { S.mineDocs.delete(id); S.rows = S.rows.filter(r => r.id !== id); declareDead(a, e); saveAh(); if (!giveBack(a, false)) say('Cancelled. It waits here until your bag has room.'); return true; }
    if ((g.ok && g.row && g.row.state === 'sold') || (x && x.kind === 'changed')) { say('It was just sold!'); await settleNow(true); return false; }
    return no(g.kind === 'denied' || (x && x.kind === 'denied') ? MSG.closed : MSG.offline);
  }

  // ---------- opening, closing, the quiet check in the street ----------
  function open() {
    Object.assign(S, { view: 'list', sel: null, ask: false, typing: false, drag: null, busy: '' }); S.sc.list = 0;
    G.panel = 'mpauction'; try { SFX.play('bag'); } catch (e) {}
    if (!S.last || S.err || coolLeft() <= 0) refresh(true);   /* (opened again within a few seconds: what is shown is fresh enough) */
  }
  function close() { S.typing = false; S.drag = null; if (G) G.panel = null; try { SFX.play('pick'); } catch (e) {} }
  function tick(dt) {
    if (!G || !G.hub || G.visit || isOpen()) return;
    S.tick += dt; if (S.tick < SETTLE_EVERY) return;
    S.tick = 0;
    const a = ah(); if (!a) return;
    /* in the street: my listings are looked at (sold? run out?). Anywhere else in the Sanctuary only loose ends are
       tied up: an unconfirmed listing or purchase, an item waiting to come back */
    if (G.hubRoom === 'street' ? a.esc.length || a.buys.length : a.buys.length || a.esc.some(e => e.st !== 'live')) settle(true);
  }

  // =====================================================================
  //  THE PANEL
  // =====================================================================
  function frame() {
    const port = PORTRAIT(), b = port ? { x: 8, y: 8, w: W - 16, h: H - 16 } : { x: 40, y: 14, w: W - 80, h: H - 28 };
    return { port, b, x: b.x + (port ? 16 : 24), w: b.w - (port ? 32 : 48), top: b.y + 52, bot: b.y + b.h - (port ? 16 : 14) };
  }
  // ---------- scrolling lists (the feel of the street's lists: wheel, drag, scrollbar, keys) ----------
  const listMax = L => Math.max(0, L.total - L.view.h);
  const listBar = L => ({ x: L.view.x + L.view.w + 4, y: L.view.y + 2, w: 8, h: L.view.h - 4 });
  function listThumb(L) { const b = listBar(L), M = listMax(L), th = Math.max(28, b.h * L.view.h / (L.view.h + M)); return { x: b.x, y: b.y + (M ? (b.h - th) * S.sc[L.key] / M : 0), w: b.w, h: th }; }
  function listScroll(L, dy) { S.sc[L.key] = clamp(S.sc[L.key] + dy, 0, listMax(L)); }
  function listDrag(L) {
    S.sc[L.key] = clamp(S.sc[L.key], 0, listMax(L));
    const d = S.drag; if (!d || d.key !== L.key) return;
    const M = listMax(L);
    if (d.off !== undefined) { const b = listBar(L), th = listThumb(L).h; S.sc[L.key] = clamp((mouse.y - d.off - b.y) / Math.max(1, b.h - th) * M, 0, M); return; }
    if (Math.abs(mouse.y - d.y0) > 6) d.moved = true;
    if (d.moved) S.sc[L.key] = clamp(d.s0 - (mouse.y - d.y0), 0, M);
  }
  // what is under the mouse in a list: 'btn:<i>' (a row's own button), 'row:<i>', or null
  function listHit(L) {
    if (!inRect(mouse, L.view)) return null;
    for (let i = 0; i < L.cells.length; i++) { const c = L.cells[i]; if (c.btn && inRect(mouse, c.btn)) return 'btn:' + i; if (inRect(mouse, c.r)) return 'row:' + i; }
    return null;
  }
  function listPress(L) {
    if (listMax(L) > 0) {
      const bar = listBar(L), t = listThumb(L);
      if (inRect(mouse, { x: bar.x - 6, y: bar.y, w: bar.w + 12, h: bar.h })) { if (inRect(mouse, { x: t.x - 6, y: t.y, w: t.w + 12, h: t.h })) S.drag = { key: L.key, off: mouse.y - t.y }; else listScroll(L, (mouse.y < t.y ? -1 : 1) * L.view.h * 0.8); return true; }
    }
    if (!inRect(mouse, L.view)) return false;
    S.drag = { key: L.key, y0: mouse.y, s0: S.sc[L.key], moved: false, hit: listHit(L) };
    return true;
  }
  function drawBar(L) {
    if (listMax(L) <= 0) return;
    const b = listBar(L), t = listThumb(L), on = S.drag && S.drag.key === L.key && S.drag.off !== undefined;
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; rr(b.x, b.y, b.w, b.h, 4); ctx.fill();
    ctx.fillStyle = on ? PAL.gold : PAL.brass; rr(t.x + 1, t.y + 1, t.w - 2, t.h - 2, 3); ctx.fill();
  }

  // ---------- what each view shows: its buttons and its list ----------
  function chips() {
    const t = S.tab, f = S.f, out = [];
    if (t === 'cos' || t === 'mine') return out;
    if (t === 'animal') out.push({ id: 'act', txt: f.act ? 'Act ' + ROMAN[f.act] : 'Any act', on: !!f.act }, { id: 'role', txt: f.role || 'Any role', on: !!f.role }, { id: 'shiny', txt: '★ Shiny only', on: f.shiny });
    if (t === 'fish' || t === 'dish') out.push({ id: 'rar', txt: f.rar ? RARITY[f.rar].label : 'Any rarity', on: !!f.rar });
    out.push({ id: 'sort', txt: 'Sort: ' + SORTS[f.sort === 'lvl' && t !== 'animal' ? 'new' : f.sort] });
    if (!TOUCH.on) out.push({ id: 'find', txt: S.typing ? f.q + (Math.floor(TIME * 2) % 2 ? '|' : ' ') : f.q ? 'Find: ' + f.q : 'Find by name', on: S.typing || !!f.q });
    return out;
  }
  const ROLES = () => [...new Set(PET_IDS.map(k => PETS[k].role).filter(Boolean))];
  function chipClick(id) {
    const f = S.f, next = (list, v) => list[(list.indexOf(v) + 1) % list.length];
    if (id === 'act') f.act = (f.act + 1) % 5;
    else if (id === 'role') f.role = next([''].concat(ROLES()), f.role);
    else if (id === 'shiny') f.shiny = !f.shiny;
    else if (id === 'rar') f.rar = next([''].concat(Object.keys(FISH_TIER)), f.rar);
    else if (id === 'sort') f.sort = next(S.tab === 'animal' ? ['new', 'lo', 'hi', 'lvl'] : ['new', 'lo', 'hi'], f.sort === 'lvl' && S.tab !== 'animal' ? 'new' : f.sort);
    else if (id === 'find') { if (S.typing) S.typing = false; else if (f.q) f.q = ''; else S.typing = true; }
    S.sc.list = 0;
  }
  // my listings as rows (from the escrow notes, with what is known of each online)
  function mineRows() {
    const a = ah(); if (!a) return [];
    return a.esc.map(e => {
      const it = build(e.cat, e.it), d = S.mineDocs.get(e.id), row = { id: e.id, mine: true, e, cat: e.cat, it, price: e.price, seller: e.uid, sellerName: 'you', created: d ? d.created : 0 };
      if (it) Object.assign(row, facts(e.cat, it)); else row.name = 'Item';
      if (e.st === 'back') { row.status = e.cat === 'animal' ? 'Waiting to come back' : `Waiting: your ${BAGS[CATS[e.cat].bag].title} is full`; row.do = 'Collect'; }
      else if (e.st === 'new') row.status = 'Checking with the auction house...';
      else { row.status = d && d.state === 'sold' ? 'Sold! Refresh to collect the Gold' : d ? (d.created + LIFE <= serverNow() ? 'Ran out: Refresh to get it back' : 'On sale · ' + timeLeft(d.created + LIFE - serverNow())) : 'On sale'; row.do = d && d.state === 'sold' ? null : 'Cancel'; }
      return row;
    });
  }
  function layList() {
    const F = frame(), { port, x, w } = F, btns = [];
    const per = port ? 3 : 6, tw = (w - (per - 1) * 4) / per;
    TABS.forEach((t, i) => btns.push({ id: 'tab', arg: t.id, txt: port && t.id === 'mine' ? 'Mine' : t.name, on: S.tab === t.id, size: 13, r: { x: x + (i % per) * (tw + 4), y: F.top + Math.floor(i / per) * 34, w: tw, h: 30 } }));
    let y = F.top + (port ? 68 : 34);
    const cs = chips();
    if (cs.length) { const cw = Math.min(180, (w - (cs.length - 1) * 6) / cs.length); cs.forEach((c, i) => btns.push({ id: 'chip', arg: c.id, txt: c.txt, on: c.on, size: port ? 11 : 12, r: { x: x + i * (cw + 6), y, w: cw, h: 26 } })); }
    y += 32;
    const fy = F.bot - 36, cool = coolLeft(), rtxt = cool > 0 ? `Refresh (${Math.ceil(cool / 1000)})` : 'Refresh', canSell = !!me() && !!E();
    let noteAt, bottom;
    if (port) {
      const bw = (w - 16) / 3;
      btns.push({ id: 'refresh', txt: rtxt, off: cool > 0 || S.loading, size: 14, r: { x, y: fy, w: bw, h: 36 } }, { id: 'sell', txt: 'Sell something', off: !canSell, size: 14, r: { x: x + bw + 8, y: fy, w: bw, h: 36 } }, { id: 'close', txt: 'Close', size: 14, r: { x: x + 2 * bw + 16, y: fy, w: bw, h: 36 } });
      noteAt = { x, y: fy - 16, w }; bottom = fy - 34;
    } else {
      btns.push({ id: 'refresh', txt: rtxt, off: cool > 0 || S.loading, size: 14, r: { x, y: fy, w: 130, h: 36 } }, { id: 'sell', txt: 'Sell something', off: !canSell, size: 14, r: { x: x + w - 270, y: fy, w: 160, h: 36 } }, { id: 'close', txt: 'Close', size: 14, r: { x: x + w - 100, y: fy, w: 100, h: 36 } });
      noteAt = { x: x + 142, y: fy + 18, w: w - 142 - 282 }; bottom = fy - 8;
    }
    const mine = S.tab === 'mine', rows = S.tab === 'cos' ? [] : mine ? mineRows() : visible(), RH = 60;
    const view = { x, y, w: w - 14, h: bottom - y }, L = { key: 'list', view, RH, rows, cells: [] };
    S.sc.list = clamp(S.sc.list, 0, Math.max(0, rows.length * RH + 44 - view.h));
    rows.forEach((row, i) => {
      const r = { x: view.x, y: view.y + i * RH - S.sc.list, w: view.w, h: RH - 4 };
      L.cells.push({ r, row, btn: mine && row.do ? { x: r.x + r.w - 96, y: r.y + 12, w: 88, h: 32 } : null });
    });
    const more = !mine && S.tab !== 'cos' && S.more;
    if (more) L.cells.push({ r: { x: view.x, y: view.y + rows.length * RH - S.sc.list, w: view.w, h: 40 }, more: true });
    L.total = rows.length * RH + (more ? 44 : 0);
    return { F, btns, list: L, noteAt };
  }
  function selRow() {
    const s = S.sel; if (!s) return null;
    return s.mine ? mineRows().find(r => r.id === s.id) || null : S.rows.find(r => r.id === s.id) || null;
  }
  function layDetail() {
    const F = frame(), { port, x, w } = F, btns = [], row = selRow(), fy = F.bot - 40, U = me();
    const bw = port ? (w - 8) / 2 : 190, bx = port ? x : x + w - 2 * bw - 8;
    if (row && row.mine) { if (row.do) btns.push({ id: 'mineAct', arg: row.id, txt: row.do === 'Cancel' ? 'Cancel this listing' : 'Collect', off: !!S.busy, size: 15, r: { x: bx, y: fy, w: bw, h: 40 } }); }
    else if (row) {
      const own = U && row.seller === U.uid, poor = !!E() && E().gold() < row.price;
      if (S.ask) btns.push({ id: 'buyYes', arg: row.id, txt: 'Yes, buy it', off: !!S.busy, size: 15, color: PAL.gold, r: { x: bx, y: fy, w: bw, h: 40 } });
      else btns.push({ id: 'buyAsk', txt: own ? 'Your own listing' : !U ? 'Log in to buy' : poor ? 'Not enough Gold' : `Buy for ${fmt(row.price)} Gold`, off: own || !U || !E() || poor || !!S.busy, size: 15, color: PAL.gold, r: { x: bx, y: fy, w: bw, h: 40 } });
    }
    btns.push({ id: 'back', txt: S.ask ? 'No' : 'Back', size: 15, r: { x: bx + bw + 8, y: fy, w: bw, h: 40 } });
    return { F, btns, row, fy };
  }
  function laySellCat() {
    const F = frame(), { port, x, w } = F, btns = [], a = ah(), full = !!a && activeCount(a) >= MAX_LIST;
    const bw = port ? w : (w - 24) / 3, y0 = F.top + (port ? 96 : 110);
    Object.keys(CATS).forEach((c, i) => { const n = stock(c).length; btns.push({ id: 'sellCat', arg: c, txt: `${CATS[c].name} (${n})`, off: !n || full, size: 17, r: port ? { x, y: y0 + i * 66, w: bw, h: 56 } : { x: x + i * (bw + 12), y: y0, w: bw, h: 70 } }); });
    btns.push({ id: 'back', txt: 'Back', size: 15, r: { x: x + w - 150, y: F.bot - 40, w: 150, h: 40 } });
    return { F, btns, full };
  }
  function laySellPick() {
    const F = frame(), { port, x, w } = F, btns = [], cat = S.sell.cat, items = stock(cat), fy = F.bot - 40;
    const CW = cat === 'animal' ? 112 : 100, CH = cat === 'animal' ? 108 : 100, view = { x, y: F.top + 30, w: w - 14, h: fy - 10 - (F.top + 30) }, cols = Math.max(1, Math.floor(view.w / CW)), ox = Math.floor((view.w - cols * CW) / 2);
    const L = { key: 'pick', view, RH: CH, cells: [], total: Math.ceil(items.length / cols) * CH + 4 };
    S.sc.pick = clamp(S.sc.pick, 0, listMax(L));
    items.forEach((s, i) => L.cells.push({ r: { x: view.x + ox + (i % cols) * CW + 3, y: view.y + 2 + Math.floor(i / cols) * CH - S.sc.pick, w: CW - 6, h: CH - 6 }, stock: s }));
    btns.push({ id: 'back', txt: 'Back', size: 15, r: { x: x + w - 150, y: fy, w: 150, h: 40 } });
    return { F, btns, list: L, items };
  }
  const sellPrice = () => clamp(parseInt(S.sell.price, 10) || 0, 0, MAX_PRICE);
  function sellItem() { const s = S.sell, list = stock(s.cat); return list.find(x => x.src === s.src) || null; }
  function laySellPrice() {
    const F = frame(), { port, x, w } = F, btns = [], fy = F.bot - 40, p = sellPrice(), ok = p >= 1 && !!sellItem() && !S.busy;
    const kw = port ? 74 : 62, kh = port ? 46 : 40, kx = port ? x + (w - 3 * kw - 16) / 2 : x + w - 3 * kw - 16 - 150, ky = port ? F.top + 290 : F.top + 96;
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].forEach((k, i) => btns.push({ id: 'key', arg: k, txt: k, size: 18, r: { x: kx + (i % 3) * (kw + 8), y: ky + Math.floor(i / 3) * (kh + 6), w: kw, h: kh } }));
    const sx = port ? x : x + w - 138, sy = port ? ky + 4 * (kh + 6) + 6 : ky, sw = port ? (w - 18) / 4 : 138;
    [[-100, '− 100'], [-10, '− 10'], [10, '+ 10'], [100, '+ 100']].forEach(([d, t], i) => btns.push({ id: 'step', arg: d, txt: t, size: 14, r: port ? { x: sx + i * (sw + 6), y: sy, w: sw, h: 38 } : { x: sx, y: sy + i * (kh + 6), w: sw, h: kh } }));
    const bw = port ? (w - 8) / 2 : 190, bx = port ? x : x + w - 2 * bw - 8;
    if (S.view === 'sellok') btns.length = 0;
    btns.push({ id: S.view === 'sellok' ? 'sellYes' : 'sellAsk', txt: S.view === 'sellok' ? 'Yes, list it' : p >= 1 ? `List for ${fmt(p)} Gold` : 'Set a price', off: !ok, size: 15, color: PAL.gold, r: { x: bx, y: fy, w: bw, h: 40 } });
    btns.push({ id: 'back', txt: S.view === 'sellok' ? 'No' : 'Back', size: 15, r: { x: bx + bw + 8, y: fy, w: bw, h: 40 } });
    return { F, btns, field: port ? { x: x + w / 2 - 130, y: F.top + 190, w: 260, h: 46 } : { x: kx - 290, y: ky + 30, w: 250, h: 50 }, p, fy };
  }
  function layout() {
    const v = S.view;
    return v === 'detail' ? layDetail() : v === 'sellcat' ? laySellCat() : v === 'sellpick' ? laySellPick() : v === 'sellprice' || v === 'sellok' ? laySellPrice() : layList();
  }

  // ---------- drawing ----------
  function drawIcon(cat, it, x, y, s) {
    panel(x, y, s, s, 'slot'); if (!it) return;
    ctx.save(); ctx.beginPath(); ctx.rect(x + 2, y + 2, s - 4, s - 4); ctx.clip();
    try {
      if (cat === 'animal') { if (!drawPetIcon(it.def.pet, x + 3, y + 3, s - 6, s - 6, it)) label('?', x + s / 2, y + s / 2, { align: 'center', size: 18, color: PAL.dim }); }
      else { const sh = it.shape, cs = Math.max(4, Math.floor(Math.min((s - 8) / sh[0].length, (s - 8) / sh.length))); drawItem(it, Math.round(x + (s - sh[0].length * cs) / 2), Math.round(y + (s - sh.length * cs) / 2), cs); }
    } catch (e) {}
    ctx.restore(); ctx.filter = 'none'; ctx.globalAlpha = 1;
  }
  function gold(n, x, y, o = {}) {
    if (MP.econ && MP.econ.drawGold) return MP.econ.drawGold(x, y, Object.assign({ n }, o));
    label(fmt(n) + ' Gold', x, y, { align: o.align, size: o.size || 14, bold: true, color: PAL.gold }); return 0;
  }
  function drawRow(c, hot) {
    const r = c.r, row = c.row, U = me();
    panel(r.x, r.y, r.w, r.h, 'dark');
    if (hot) { ctx.fillStyle = 'rgba(255,230,180,0.08)'; rr(r.x + 2, r.y + 2, r.w - 4, r.h - 4, 5); ctx.fill(); }
    drawIcon(row.cat, row.it, r.x + 4, r.y + 4, r.h - 8);
    const tx = r.x + r.h + 4, right = c.btn ? c.btn.x - 8 : r.x + r.w - 10, tw = right - tx - 96;
    ctx.font = `bold 14px ${UI}`; label(fitText((row.shiny ? '★ ' : '') + row.name, tw), tx, r.y + 14, { size: 14, bold: true, color: row.shiny ? PAL.gold : row.it ? RARITY[row.it.def.rarity].c : PAL.cream });
    ctx.font = `12px ${UI}`; label(fitText(row.line || '', tw + 90), tx, r.y + 31, { size: 12, color: PAL.cream });
    ctx.font = `11px ${UI}`;
    if (row.mine) label(fitText(row.status || '', tw + 90), tx, r.y + 46, { size: 11, color: row.e.st === 'back' ? '#ffab91' : PAL.dim });
    else label(fitText(`${U && row.seller === U.uid ? 'your listing' : 'by ' + row.sellerName} · ${timeLeft(row.created + LIFE - serverNow())}`, tw + 90), tx, r.y + 46, { size: 11, color: PAL.dim });
    gold(row.price, right, r.y + 15, { align: 'right', size: 15 });
    if (c.btn) button(c.btn, row.do, { hover: hot === 'btn', size: 13, off: !!S.busy });
  }
  function drawNote(at, extra) {
    const n = S.note && TIME < S.note.until ? S.note : null, t = S.busy || (n ? n.t : extra || '');
    if (!t) return;
    ctx.font = `12px ${UI}`; const lines = wrapLines(t, at.w, 12).slice(0, 2);
    lines.forEach((l, i) => label(l, at.x, at.y + (i - (lines.length - 1) / 2) * 14, { size: 12, color: S.busy ? PAL.gold : n ? (n.bad ? '#ffab91' : PAL.good) : PAL.dim }));
  }
  function drawHead(F, title) {
    ctx.fillStyle = 'rgba(0,0,0,0.72)'; ctx.fillRect(0, 0, W, H);
    panel(F.b.x, F.b.y, F.b.w, F.b.h, 'leather');
    label(title, F.x, F.b.y + 28, { title: true, size: F.port ? 24 : 28, color: PAL.gold });
    if (E()) gold(E().gold(), F.x + F.w, F.b.y + 28, { align: 'right', size: 16 });
    else label('Gold is not part of this copy', F.x + F.w, F.b.y + 28, { align: 'right', size: 12, color: PAL.dim });
  }
  function drawButtons(btns) { for (const b of btns) button(b.r, b.txt, { hover: !b.off && !S.drag && inRect(mouse, b.r), off: b.off, on: b.on, size: b.size || 15, color: b.color }); }
  function drawList(Y) {
    const L = Y.list, v = L.view, mine = S.tab === 'mine', U = me(), a = ah();
    listDrag(L);
    if (S.tab === 'cos') { label('Earned cosmetics: coming soon', v.x + v.w / 2, v.y + v.h / 2 - 10, { align: 'center', size: 18, bold: true, color: PAL.gold }); para('Cosmetics bought in the shop stay with you. Ones that are earned will be tradeable here one day.', v.x + 30, v.y + v.h / 2 + 22, v.w - 60, { size: 12, color: PAL.dim }); return; }
    const hit = !S.drag || !S.drag.moved ? listHit(L) : null;
    ctx.save(); ctx.beginPath(); ctx.rect(v.x, v.y, v.w, v.h); ctx.clip();
    L.cells.forEach((c, i) => {
      if (c.r.y + c.r.h < v.y || c.r.y > v.y + v.h) return;
      if (c.more) button({ x: c.r.x + c.r.w / 2 - 100, y: c.r.y + 2, w: 200, h: 34 }, S.loading ? 'Loading...' : 'Load more', { hover: hit === 'row:' + i, off: S.loading, size: 14 });
      else drawRow(c, hit === 'btn:' + i ? 'btn' : hit === 'row:' + i);
    });
    ctx.restore(); drawBar(L);
    if (!L.rows.length) {
      const err = mine ? S.mineErr : S.err, cx = v.x + v.w / 2, cy = v.y + v.h / 2;
      const t = mine ? (!E() ? 'Gold is not part of this copy of the game.' : !U ? 'Log in at the Records Hall to sell things and to see your listings.' : err ? MSG[err] : 'You have nothing on sale. Use "Sell something".')
        : err ? MSG[err] : S.loading ? 'Loading...' : S.rows.some(r => r.it && r.state === 'open') ? 'Nothing here matches. Try another tab or filter.' : 'Nothing is for sale right now. Be the first: "Sell something".';
      para(t, v.x + 30, cy - 8, v.w - 60, { size: 15, bold: true, color: err ? '#ffab91' : PAL.cream });
      if (err === 'closed') label('(the owner has not opened it on the server yet)', cx, cy + 40, { align: 'center', size: 12, color: PAL.dim });
    }
    let extra = mine ? (a && U ? `${activeCount(a)} of ${MAX_LIST} listings · a sale pays the price minus the 5% fee` : '') : S.last ? `Updated ${agoText(AH.clock() - S.last)}${S.err && S.rows.length ? ' · ' + MSG[S.err] : ''}` : '';
    if (!U && !mine) extra = (extra ? extra + ' · ' : '') + 'Browsing only: ' + MSG.login;
    if (mine && a && a.notes.length && !S.busy && !(S.note && TIME < S.note.until)) extra = a.notes[a.notes.length - 1];
    drawNote(Y.noteAt, extra);
  }
  const agoText = ms => (ms < 5000 ? 'just now' : ms < 60e3 ? `${Math.floor(ms / 1000)} s ago` : ms < 3600e3 ? `${Math.floor(ms / 60e3)} min ago` : 'long ago');
  // the big view of one thing: an animal as in a trade (card, traits, role), a fish or a dish with its picture
  function drawThing(cat, it, r) {
    if (!it) { label('This item can no longer be shown.', r.x, r.y + 20, { size: 13, color: PAL.dim }); return; }
    if (cat === 'animal') {
      const cw = Math.min(210, r.w), card = { x: r.x + (r.w - cw) / 2, y: r.y, w: cw, h: 130 };
      try { drawPetCard(it, card, { slot: true }); } catch (e) {}
      ctx.filter = 'none'; ctx.globalAlpha = 1;
      try { drawTraits(it, r.x, r.y + 148, r.w); } catch (e) {}
      label(fitText(`${PETS[it.def.pet].role} · ${ACT_NAMES[speciesAct(it.def.pet)] || ''}`, r.w), r.x, r.y + 148 + 132, { size: 11, color: PAL.dim });
      label(`${talentSpent(it)} talent points spent`, r.x, r.y + 148 + 148, { size: 11, color: PAL.dim });
      return;
    }
    const s = Math.min(150, r.w); drawIcon(cat, it, r.x + (r.w - s) / 2, r.y, s);
    label(itemName(cat, it), r.x + r.w / 2, r.y + s + 20, { align: 'center', size: 16, bold: true, color: RARITY[it.def.rarity].c });
    label(facts(cat, it).line, r.x + r.w / 2, r.y + s + 42, { align: 'center', size: 12, color: PAL.cream });
    para(cat === 'dish' ? 'Feed it to one of your animals from the Sanctuary Bag.' : 'An ingredient for the stone oven.', r.x, r.y + s + 64, r.w, { size: 12, color: PAL.dim });
  }
  function drawDetail(Y) {
    const F = Y.F, row = Y.row, U = me();
    if (!row) { label('That listing is gone.', F.x, F.top + 30, { size: 15, color: PAL.cream }); return; }
    const left = F.port ? { x: F.x + 20, y: F.top + 4, w: F.w - 40 } : { x: F.x + 10, y: F.top + 10, w: 330 };
    drawThing(row.cat, row.it, left);
    let x = F.port ? F.x : F.x + 380, y = F.port ? F.top + (row.cat === 'animal' ? 330 : 290) : F.top + 30; const w = F.port ? F.w : F.w - 380;
    ctx.font = `bold 18px ${UI}`; label(fitText((row.shiny ? '★ ' : '') + row.name, w), x, y, { size: 18, bold: true, color: row.shiny ? PAL.gold : row.it ? RARITY[row.it.def.rarity].c : PAL.cream }); y += 26;
    ctx.font = `13px ${UI}`; label(fitText(row.line || '', w), x, y, { size: 13, color: PAL.cream }); y += 24;
    label('Price', x, y, { size: 13, color: PAL.dim }); gold(row.price, x + 70, y, { size: 17 }); y += 26;
    if (row.mine) { y = para(row.status || '', x, y, w, { size: 13, color: row.e.st === 'back' ? '#ffab91' : PAL.cream }) + 6; y = para(`When it sells you receive ${fmt(payout(row.price))} Gold (the price minus the 5% fee).`, x, y, w, { size: 12, color: PAL.dim }); }
    else {
      label('Seller', x, y, { size: 13, color: PAL.dim }); label(U && row.seller === U.uid ? 'you' : row.sellerName, x + 70, y, { size: 14, bold: true }); y += 22;
      label('Ends', x, y, { size: 13, color: PAL.dim }); label(timeLeft(row.created + LIFE - serverNow()), x + 70, y, { size: 13 }); y += 26;
      if (row.cat === 'animal') y = para('It keeps its level, talents and traits, but its bond with you starts at 0.', x, y, w, { size: 12, color: PAL.dim }) + 4;
      if (S.ask) y = para(`Buy ${row.name} for ${fmt(row.price)} Gold?`, x, y + 6, w, { size: 15, bold: true, color: PAL.gold });
      else if (!U) y = para(MSG.login, x, y + 6, w, { size: 12, color: '#ffab91' });
    }
    drawNote({ x, y: Y.fy - 26, w }, '');
  }
  function drawSellCat(Y) {
    const F = Y.F, a = ah();
    let y = para('Pick what to sell. Listing is free; when it sells you receive the price minus a 5% fee. A listing stays up for 48 hours: unsold, it comes back to you.', F.x, F.top + 12, F.w, { size: 13, color: PAL.cream });
    label(a ? `${activeCount(a)} of ${MAX_LIST} listings in use` : '', F.x, y + 8, { size: 12, color: Y.full ? '#ffab91' : PAL.dim });
    drawNote({ x: F.x, y: F.bot - 20, w: F.w - 170 }, '');
  }
  function drawSellPick(Y) {
    const F = Y.F, L = Y.list, v = L.view, cat = S.sell.cat;
    listDrag(L);
    label(`${TOUCH.on ? 'Tap' : 'Click'} the ${CATS[cat].one} to sell`, F.x, F.top + 12, { size: 14, bold: true, color: PAL.gold });
    const hit = !S.drag || !S.drag.moved ? listHit(L) : null;
    ctx.save(); ctx.beginPath(); ctx.rect(v.x, v.y, v.w, v.h); ctx.clip();
    L.cells.forEach((c, i) => {
      const r = c.r, it = c.stock.it; if (r.y + r.h < v.y || r.y > v.y + v.h) return;
      if (cat === 'animal') {
        try { drawPetCard(it, r, { over: hit === 'row:' + i && !c.stock.lock }); } catch (e) {}
        ctx.filter = 'none'; ctx.globalAlpha = 1;
        if (c.stock.lock) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; rr(r.x + 3, r.y + 3, r.w - 6, r.h - 6, 6); ctx.fill(); label(c.stock.lock, r.x + r.w / 2, r.y + r.h / 2, { align: 'center', size: 12, bold: true, color: '#f8bbd0' }); }
      } else {
        panel(r.x, r.y, r.w, r.h, 'dark'); if (hit === 'row:' + i) { ctx.fillStyle = 'rgba(255,230,180,0.08)'; rr(r.x + 2, r.y + 2, r.w - 4, r.h - 4, 5); ctx.fill(); }
        drawIcon(cat, it, r.x + (r.w - 60) / 2, r.y + 5, 60);
        ctx.font = `11px ${UI}`; label(fitText(itemName(cat, it), r.w - 8), r.x + r.w / 2, r.y + r.h - 14, { align: 'center', size: 11, color: RARITY[it.def.rarity].c });
      }
    });
    ctx.restore(); drawBar(L);
    if (!Y.items.length) label('Nothing to sell here.', v.x + v.w / 2, v.y + 60, { align: 'center', size: 15, color: PAL.dim });
    drawNote({ x: F.x, y: F.bot - 20, w: F.w - 170 }, cat === 'animal' ? 'Animals in your team or in the Den, and your last animal, cannot be sold.' : '');
  }
  function drawSellPrice(Y) {
    const F = Y.F, s = sellItem(), cat = S.sell.cat, ok = S.view === 'sellok';
    if (!s) { label('That item is no longer with you.', F.x, F.top + 30, { size: 15, color: PAL.cream }); return; }
    const it = s.it, fc = facts(cat, it);
    drawIcon(cat, it, F.x, F.top + 6, 84);
    ctx.font = `bold 17px ${UI}`; label(fitText((fc.shiny ? '★ ' : '') + fc.name, F.w - 100), F.x + 96, F.top + 24, { size: 17, bold: true, color: fc.shiny ? PAL.gold : RARITY[it.def.rarity].c });
    ctx.font = `12px ${UI}`; label(fitText(fc.line, F.w - 100), F.x + 96, F.top + 48, { size: 12, color: PAL.cream });
    const f = Y.field, p = Y.p;
    if (ok) {
      let y = para(`List ${fc.name} for ${fmt(p)} Gold?`, F.x, F.top + 120, F.w, { size: 17, bold: true, color: PAL.gold });
      y = para(`The auction house keeps a 5% fee (${fmt(p - payout(p))} Gold): you receive ${fmt(payout(p))} Gold when it sells.`, F.x, y + 6, F.w, { size: 13, color: PAL.cream });
      y = para('It leaves your game now and is kept safe by the auction house. Unsold after 48 hours (or if you cancel), it comes back.', F.x, y + 4, F.w, { size: 12, color: PAL.dim });
      if (fc.shiny) para('This is a ★ SHINY animal. Are you sure?', F.x, y + 8, F.w, { size: 14, bold: true, color: PAL.gold });
    } else {
      label('Your price', f.x, f.y - 14, { size: 13, color: PAL.dim });
      ctx.fillStyle = '#fff6dc'; rr(f.x, f.y, f.w, f.h, 5); ctx.fill(); ctx.strokeStyle = PAL.brass; ctx.lineWidth = 2; ctx.stroke();
      if (MP.econ && MP.econ.coin) MP.econ.coin(f.x + 24, f.y + f.h / 2, 24);
      label((S.sell.price || '') + (Math.floor(TIME * 2) % 2 ? '|' : ' '), f.x + 46, f.y + f.h / 2 + 1, { size: 24, bold: true, color: PAL.parchInk });
      para(p >= 1 ? `You receive ${fmt(payout(p))} Gold after the 5% fee.` : `Type a price (1 to ${fmt(MAX_PRICE)}) or use the buttons.`, f.x, f.y + f.h + 18, f.w + 30, { size: 12, color: PAL.cream });
    }
    drawNote({ x: F.x, y: Y.fy - 22, w: F.w }, '');
  }
  function draw() {
    const Y = layout(), v = S.view;
    drawHead(Y.F, v === 'list' ? 'Auction House' : v === 'detail' ? (S.sel && S.sel.mine ? 'Your listing' : 'For sale') : 'Sell something');
    if (v === 'list') drawList(Y); else if (v === 'detail') drawDetail(Y); else if (v === 'sellcat') drawSellCat(Y); else if (v === 'sellpick') drawSellPick(Y); else drawSellPrice(Y);
    drawButtons(Y.btns);
  }

  // ---------- clicks, releases, keys, the wheel ----------
  function goBack() {
    const v = S.view; S.drag = null; S.typing = false;
    if (v === 'detail' && S.ask) S.ask = false;
    else if (v === 'detail') { S.view = 'list'; S.sel = null; }
    else if (v === 'sellok') S.view = 'sellprice';
    else if (v === 'sellprice') S.view = 'sellpick';
    else if (v === 'sellpick') S.view = 'sellcat';
    else if (v === 'sellcat') S.view = 'list';
    else { close(); return; }
    try { SFX.play('pick'); } catch (e) {}
  }
  function priceKey(k) {
    const s = S.sell;
    if (k === 'C') s.price = ''; else if (k === '⌫' || k === 'Backspace') s.price = s.price.slice(0, -1);
    else if (/^\d$/.test(k)) { const t = (s.price + k).replace(/^0+/, ''); if (t.length <= 5 && (+t || 0) <= MAX_PRICE) s.price = t; }
  }
  function act(b) {
    if (b.off) { try { SFX.play('error'); } catch (e) {} if (b.id === 'sell' || b.id === 'buyAsk') say(!E() ? 'Gold is not part of this copy of the game.' : !me() ? MSG.login : b.id === 'sell' ? MSG.login : 'You cannot buy this one.', true); return; }
    const snd = () => { try { SFX.play('pick'); } catch (e) {} };
    switch (b.id) {
      case 'tab': S.tab = b.arg; S.sc.list = 0; S.typing = false; snd(); if (b.arg === 'mine' && !S.mineDocs.size && me()) settle(true); break;
      case 'chip': chipClick(b.arg); snd(); break;
      case 'refresh': snd(); refresh(false); break;
      case 'close': close(); break;
      case 'back': goBack(); break;
      case 'sell': S.view = 'sellcat'; snd(); break;
      case 'sellCat': S.sell = { cat: b.arg, src: null, price: '' }; S.sc.pick = 0; S.view = 'sellpick'; snd(); break;
      case 'key': priceKey(b.arg); snd(); break;
      case 'step': S.sell.price = String(clamp(sellPrice() + b.arg, 0, MAX_PRICE) || ''); snd(); break;
      case 'sellAsk': S.view = 'sellok'; snd(); break;
      case 'sellYes': { const s = S.sell, x = sellItem(); if (!x) break; S.view = 'list'; S.tab = 'mine'; S.sc.list = 0; sell(s.cat, x.src, sellPrice()); break; }
      case 'buyAsk': S.ask = true; snd(); break;
      case 'buyYes': { const id = b.arg; S.ask = false; buy(id).then(ok => { if (S.view === 'detail' && S.sel && S.sel.id === id && (ok || !S.rows.some(r => r.id === id))) { S.view = 'list'; S.sel = null; } }); break; }
      case 'mineAct': { const id = b.arg; cancel(id).then(() => { if (S.view === 'detail' && !selRow()) { S.view = 'list'; S.sel = null; } }); break; }
    }
  }
  // a row (or its button) was clicked: without having dragged the list
  function hitAct(L, h) {
    const [part, n] = String(h).split(':'), c = L.cells[+n]; if (!c) return;
    if (L.key === 'pick') {
      if (c.stock.lock) { say(`${petName(c.stock.it)} can't be sold: ${c.stock.lock.toLowerCase()}.`, true); return; }
      S.sell.src = c.stock.src; S.sell.price = ''; S.view = 'sellprice'; try { SFX.play('pick'); } catch (e) {} return;
    }
    if (c.more) { if (!S.loading) loadPage(false); return; }
    if (part === 'btn' && c.row.mine) { if (!S.busy) cancel(c.row.id); return; }
    S.sel = { id: c.row.id, mine: !!c.row.mine }; S.ask = false; S.view = 'detail'; try { SFX.play('pick'); } catch (e) {}
  }
  function click(btn) {
    if (btn !== 0) { goBack(); return; }
    const Y = layout(), b = Y.btns.find(x => inRect(mouse, x.r));
    if (S.typing && !(b && b.id === 'chip' && b.arg === 'find')) S.typing = false;
    if (b) { act(b); return; }
    if (Y.list) listPress(Y.list);
  }
  function up(btn) {
    const d = S.drag; if (!d) return; S.drag = null;
    if (btn !== 0 || d.off !== undefined || d.moved || !d.hit || Math.abs(mouse.y - d.y0) > 6) return;
    const Y = layout(), L = Y.list; if (!L || L.key !== d.key) return;
    if (listHit(L) === d.hit) hitAct(L, d.hit);
  }
  function wheel(d) { const L = layout().list; if (L && Number.isFinite(d)) listScroll(L, d); }
  function keys() {
    if (S.typing) {   /* the "Find by name" chip: letters go to the search until Enter or Escape */
      for (const k of Object.keys(pressed)) {
        if (k === 'Enter' || k === 'Escape') S.typing = false;
        else if (k === 'Backspace') S.f.q = S.f.q.slice(0, -1);
        else if (k.length === 1 && /[\p{L}\p{N} '-]/u.test(k) && S.f.q.length < 16) S.f.q += k;
      }
      S.sc.list = 0; return;
    }
    if (S.view === 'sellprice') {
      for (const k of Object.keys(pressed)) if (/^\d$/.test(k) || k === 'Backspace') priceKey(k);
      if (hit('Enter') && sellPrice() >= 1 && sellItem()) S.view = 'sellok';
      else if (hit('Escape')) goBack();
      return;
    }
    if (hit('Escape', 'e')) { goBack(); return; }
    const Y = layout(), L = Y.list;
    if (L) { const d = hit('ArrowDown', 's') ? L.RH : hit('ArrowUp', 'w') ? -L.RH : hit('PageDown') ? L.view.h * 0.8 : hit('PageUp') ? -L.view.h * 0.8 : hit('End') ? 1e7 : hit('Home') ? -1e7 : 0; if (d) listScroll(L, d); }
    if (hit('Enter')) { const b = Y.btns.find(x => ['buyYes', 'sellYes', 'buyAsk'].includes(x.id)); if (b && !b.off) act(b); }
    else if (S.view === 'list' && hit('r')) refresh(false);
  }

  MP.panels.mpauction = { draw, click, up, keys, wheel };
  MP.stations.mp_auction = open;
  MP.ticks.push(tick);
  Object.assign(AH, { open, close, refresh, settle, buy, sell, cancel, loadMore: () => loadPage(false), fee, payout });
  AH._ = { S, ah, parseDoc, build, lite, relite, facts, visible, mineRows, stock, layout, frame, animalLock, receive, giveBack, call, browseQuery, serverNow, newId, tick, timeLeft, LIFE, MAX_LIST, MSG, CATS };
})();
