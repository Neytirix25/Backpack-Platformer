// node tools/mp_tests/auction_test.js — the auction house (mp/auction.js) against an in-memory fake of the Firestore
// REST API. NOTHING here touches the network: every copy of the game gets the fake as its `fetch`, and a request to
// any other address fails the run. The fake enforces the same checks as firestore.rules (see `rules` below, written
// to mirror that file line by line), document preconditions, the two queries the game uses (anything else is refused
// the way Firestore refuses a query without an index), and can be told to fail: offline, 403, lost answers, hanging.
const { bootGame } = require('./boot.js');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------
//  the fake Firestore
// ---------------------------------------------------------------------------------------------------------------
const PRE = 'https://firestore.googleapis.com/v1/projects/backpack-sanctuary/databases/(default)/documents';
const NAME = id => 'projects/backpack-sanctuary/databases/(default)/documents/auctions/' + id;
const H48 = 48 * 3600e3;
function makeFake() {
  const F = { docs: new Map(), now: Date.now(), seq: 0, log: [], fail: null, closed: false, rulesFirst: false, precond: [400, 'FAILED_PRECONDITION'], foreign: 0 };
  const stamp = () => { F.seq++; return new Date(F.now).toISOString().replace('Z', String(F.seq % 1000).padStart(3, '0') + 'Z'); };
  const tsNum = s => { const m = /^(.*?)(?:\.(\d+))?Z$/.exec(s); return m ? Date.parse(m[1] + 'Z') * 1000 + +((m[2] || '') + '000000').slice(0, 6) : NaN; };
  const dec = v => ('stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'booleanValue' in v ? v.booleanValue : 'timestampValue' in v ? { ts: v.timestampValue } : 'nullValue' in v ? null : undefined);
  const data = fields => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, dec(v)]));
  const isInt = v => typeof v === 'number' && Number.isInteger(v), isStr = v => typeof v === 'string';
  const KEYS = ['seller', 'sellerName', 'cat', 'sub', 'title', 'price', 'item', 'lvl', 'rarity', 'shiny', 'created', 'state', 'buyer', 'buyerName', 'soldAt'];
  // firestore.rules, in JavaScript (uid = request.auth.uid or null, t = request.time)
  const rules = {
    create: (id, d, uid, t) => uid != null && /^[A-Za-z0-9]{20}$/.test(id) && Object.keys(d).every(k => KEYS.includes(k)) && KEYS.every(k => k in d)
      && d.seller === uid && isStr(d.sellerName) && d.sellerName.length <= 16 && ['animal', 'fish', 'dish'].includes(d.cat) && isStr(d.sub) && d.sub.length <= 24
      && isStr(d.title) && d.title.length >= 1 && d.title.length <= 40 && isInt(d.price) && d.price >= 1 && d.price <= 99999 && isStr(d.item) && d.item.length <= 6000
      && isInt(d.lvl) && d.lvl >= 0 && d.lvl <= 100 && isStr(d.rarity) && d.rarity.length <= 12 && typeof d.shiny === 'boolean'
      && !!d.created && d.created.ts === t && d.state === 'open' && d.buyer === null && d.buyerName === '' && d.soldAt === null,
    update: (old, d, uid, t) => uid != null && old.state === 'open' && uid !== old.seller && !!old.created && tsNum(t) < tsNum(old.created.ts) + H48 * 1000
      && [...new Set([...Object.keys(old), ...Object.keys(d)])].filter(k => JSON.stringify(old[k]) !== JSON.stringify(d[k])).every(k => ['state', 'buyer', 'buyerName', 'soldAt'].includes(k))
      && d.state === 'sold' && d.buyer === uid && isStr(d.buyerName) && d.buyerName.length <= 16 && !!d.soldAt && d.soldAt.ts === t,
    remove: (old, uid) => uid != null && !!old && uid === old.seller,
  };
  const err = (code, status, message) => ({ status: code, j: { error: { code, status, message: message || status } } });
  const DENIED = () => err(403, 'PERMISSION_DENIED', 'Missing or insufficient permissions.');
  function commit(body, uid) {
    const ws = body && body.writes; if (!Array.isArray(ws) || ws.length !== 1 || !ws[0].update) return err(400, 'INVALID_ARGUMENT');
    const w = ws[0], name = w.update.name, id = String(name).slice(String(name).lastIndexOf('/') + 1); if (name !== NAME(id)) return err(400, 'INVALID_ARGUMENT');
    const old = F.docs.get(id), t = stamp(), cd = w.currentDocument || {};
    const pre = () => (cd.exists === false && old ? err(409, 'ALREADY_EXISTS') : 'updateTime' in cd && !old ? err(404, 'NOT_FOUND') : 'updateTime' in cd && cd.updateTime !== old.updateTime ? err(F.precond[0], F.precond[1], 'the stored version does not match the required base version') : null);
    let fields;
    if (w.updateMask) { fields = Object.assign({}, old ? old.fields : {}); for (const p of w.updateMask.fieldPaths) { if (p in w.update.fields) fields[p] = w.update.fields[p]; else delete fields[p]; } }
    else fields = Object.assign({}, w.update.fields);
    for (const tr of w.updateTransforms || []) { if (tr.setToServerValue !== 'REQUEST_TIME') return err(400, 'INVALID_ARGUMENT'); fields[tr.fieldPath] = { timestampValue: t }; }
    if (Object.values(fields).some(v => dec(v) === undefined)) return err(400, 'INVALID_ARGUMENT');
    const rule = () => ((old ? rules.update(data(old.fields), data(fields), uid, t) : rules.create(id, data(fields), uid, t)) ? null : DENIED());
    const no = F.rulesFirst ? rule() || pre() : pre() || rule();
    if (no) return no;
    F.docs.set(id, { fields, createTime: old ? old.createTime : t, updateTime: t });
    return { status: 200, j: { writeResults: [{ updateTime: t, transformResults: (w.updateTransforms || []).map(() => ({ timestampValue: t })) }], commitTime: t } };
  }
  function del(id, q, uid) {
    const old = F.docs.get(id), ut = q.get('currentDocument.updateTime');
    const pre = () => (ut && !old ? err(404, 'NOT_FOUND') : ut && ut !== old.updateTime ? err(F.precond[0], F.precond[1]) : null), rule = () => (old ? (rules.remove(data(old.fields), uid) ? null : DENIED()) : uid == null ? DENIED() : F.rulesFirst ? DENIED() : null);
    const no = F.rulesFirst ? rule() || pre() : pre() || rule();
    if (no) return no;
    F.docs.delete(id); stamp(); return { status: 200, j: {} };
  }
  function query(body) {
    const q = body && body.structuredQuery, arr = e => ({ status: e.status, j: [e.j] });
    if (!q || !Array.isArray(q.from) || q.from.length !== 1 || q.from[0].collectionId !== 'auctions') return arr(err(400, 'INVALID_ARGUMENT'));
    if (!(q.limit <= 100)) return arr(DENIED());   /* the rules' list limit */
    const ff = q.where && q.where.fieldFilter, ob = q.orderBy || [];
    if (!ff || Object.keys(q.where).length !== 1 || !['EQUAL', 'GREATER_THAN'].includes(ff.op)) return arr(err(400, 'INVALID_ARGUMENT', 'a filter the fake does not know'));
    const field = ff.field.fieldPath, val = dec(ff.value);
    /* only what the automatic single-field indexes can serve: one field, and an order on that same field */
    if (ob.length > 1 || (ob.length && (ob[0].field.fieldPath !== field || ff.op === 'EQUAL'))) return arr(err(400, 'FAILED_PRECONDITION', 'The query requires an index.'));
    if (ff.op === 'GREATER_THAN' && !ob.length) { /* (Firestore orders by the inequality field ascending then) */ }
    let list = [...F.docs.entries()].filter(([, d]) => field in d.fields).map(([id, d]) => ({ id, d, v: dec(d.fields[field]) }));
    if (ff.op === 'EQUAL') list = list.filter(x => x.v === val); else list = list.filter(x => x.v && x.v.ts && val && val.ts && tsNum(x.v.ts) > tsNum(val.ts));
    if (ob.length) { const s = ob[0].direction === 'DESCENDING' ? -1 : 1; list.sort((a, b) => s * (tsNum(a.v.ts) - tsNum(b.v.ts))); if (s > 0) return arr(err(400, 'INVALID_ARGUMENT', 'the fake only orders newest first')); }
    if (q.startAt) { if (!ob.length || q.startAt.before !== false || q.startAt.values.length !== 1) return arr(err(400, 'INVALID_ARGUMENT')); const c = tsNum(dec(q.startAt.values[0]).ts); list = list.filter(x => tsNum(x.v.ts) < c); }
    const readTime = new Date(F.now).toISOString();
    list = list.slice(0, q.limit);
    return { status: 200, j: list.length ? list.map(x => ({ document: Object.assign({ name: NAME(x.id) }, JSON.parse(JSON.stringify(x.d))), readTime })) : [{ readTime }] };
  }
  function handle(url, opt) {
    const method = (opt && opt.method) || 'GET', auth = opt && opt.headers && opt.headers.Authorization, uid = auth && /^Bearer tok:/.test(auth) ? auth.slice(11) : null;
    const rest = url.slice(PRE.length), body = opt && opt.body ? JSON.parse(opt.body) : null;
    if (F.closed) return rest === ':runQuery' ? { status: 403, j: [DENIED().j] } : DENIED();   /* the rules are not published yet: everything is refused */
    if (rest === ':runQuery' && method === 'POST') return query(body);
    if (rest === ':commit' && method === 'POST') return commit(body, uid);
    const m = /^\/auctions\/([^/?]+)(?:\?(.*))?$/.exec(rest); if (!m) return err(400, 'INVALID_ARGUMENT', 'unknown path ' + rest);
    if (method === 'GET') { const d = F.docs.get(m[1]); return d ? { status: 200, j: Object.assign({ name: NAME(m[1]) }, JSON.parse(JSON.stringify(d))) } : err(404, 'NOT_FOUND'); }
    if (method === 'DELETE') return del(m[1], new URLSearchParams(m[2] || ''), uid);
    return err(400, 'INVALID_ARGUMENT');
  }
  F.fetch = (url, opt) => {
    url = String(url);
    if (!url.startsWith(PRE)) { F.foreign++; return Promise.reject(new Error('a request left the fake: ' + url)); }
    const method = (opt && opt.method) || 'GET', kind = url.includes(':runQuery') ? 'query' : url.includes(':commit') ? 'commit' : method === 'DELETE' ? 'delete' : 'get';
    const req = { kind, method, url, body: opt && opt.body ? JSON.parse(opt.body) : null, auth: !!(opt && opt.headers && opt.headers.Authorization) }; F.log.push(req);
    const mode = F.fail ? F.fail(req) : null;
    if (mode === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
    if (mode === 'hang') return new Promise(() => {});
    const res = mode === '403' ? DENIED() : mode === '500' ? err(503, 'UNAVAILABLE') : handle(url, opt);
    if (mode === 'lost') return Promise.reject(new TypeError('Failed to fetch'));   /* it happened, but the answer never arrived */
    const out = { ok: res.status >= 200 && res.status < 300, status: res.status, json: () => Promise.resolve(JSON.parse(JSON.stringify(res.j))) };
    return mode === 'slow' ? sleep(60).then(() => out) : Promise.resolve(out);
  };
  // a document put straight into the database (hostile ones too)
  F.put = (id, fields) => { const t = stamp(); F.docs.set(id, { fields, createTime: t, updateTime: t }); return t; };
  F.S = v => ({ stringValue: v }); F.I = v => ({ integerValue: String(v) }); F.T = () => ({ timestampValue: stamp() });
  F.listing = (o = {}) => Object.assign({ seller: F.S('u_ghost'), sellerName: F.S('Ghost'), cat: F.S('fish'), sub: F.S('x'), title: F.S('x'), price: F.I(10), item: F.S('{}'), lvl: F.I(0), rarity: F.S('common'), shiny: { booleanValue: false },
                                          created: F.T(), state: F.S('open'), buyer: { nullValue: null }, buyerName: F.S(''), soldAt: { nullValue: null } }, o);
  return F;
}

// ---------------------------------------------------------------------------------------------------------------
//  players
// ---------------------------------------------------------------------------------------------------------------
const FAKE = makeFake();
let idN = 0;
const mkId = () => ('T' + String(++idN).padStart(4, '0') + 'abcdefghijklmnopqrstuvwxyz').slice(0, 20);
function player(name, uid, opt = {}) {
  const g = bootGame({ name, storage: opt.storage, globals: { fetch: FAKE.fetch, __clock: () => FAKE.now } });
  g.name = name; g.uid = uid;
  g.run('enterHub()'); g.step(3);
  g.run('MP.auction.clock = __clock; MP.auction.timeout = 400;');
  if (uid) g.run(`ACC.user = { uid: ${JSON.stringify(uid)}, name: ${JSON.stringify(name.toLowerCase())}, idToken: 'tok:' + ${JSON.stringify(uid)}, refresh: 'r', exp: Date.now() + 3600000 };`);
  g.J = code => JSON.parse(g.run(`JSON.stringify(${code})`));
  g.A = code => g.run(`MP.auction.${code}`);
  g.gold = () => g.run('MP.econ.gold()');
  g.note = () => g.run('MP.auction.S.note ? MP.auction.S.note.t : ""');
  g.esc = () => g.J('MP.auction._.ah().esc.map(e => ({ id: e.id, st: e.st, cat: e.cat, price: e.price }))');
  g.rows = () => g.J('MP.auction._.visible().map(r => ({ id: r.id, cat: r.cat, name: r.name, price: r.price, lvl: r.lvl, shiny: r.shiny, act: r.act, role: r.role, rarity: r.rarity }))');
  g.setPortrait = on => { g.run(`VIEW.portrait = ${!!on}; VIEW.w = ${on ? 540 : 960}; VIEW.h = ${on ? 900 : 540};`); };
  g.frame = () => { g.win.__now += 1000 / 60; g.run(`VIEW.legacy = VIEW.portrait && !portraitReady(); if (VIEW.portrait && !VIEW.legacy) { W = 540; H = portraitWorldOnly() ? 540 : VIEW.h; } else { W = 960; H = 540; } update(1 / 60); draw(); pressed = {};`); };
  g.clickAt = (x, y) => g.run(`mouse.x = ${x}; mouse.y = ${y}; onMouseDown(0); onMouseUp(0);`);
  g.btn = (id, arg) => { const b = g.J(`MP.auction._.layout().btns.filter(b => b.id === ${JSON.stringify(id)}${arg === undefined ? '' : ` && b.arg === ${JSON.stringify(arg)}`}).map(b => b.r)[0] || null`); if (!b) return false; g.clickAt(b.x + b.w / 2, b.y + b.h / 2); return true; };
  g.idle = () => g.run('MP.auction.S.chain');
  return g;
}
const fishOf = (g, k) => g.run(`bagAdd('fish', makeItem('fish_' + ${JSON.stringify(k)}))`);
const count = g => g.J(`{ herd: HERD.length, fish: bagItems('fish').length, dish: bagItems('pantry').length }`);
const drawsOk = (g, what) => { try { g.frame(); g.frame(); return true; } catch (e) { console.log('  draw threw in ' + what + ': ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)); return false; } };
const inside = g => g.run(`MP.auction._.layout().btns.every(b => b.r.x >= 0 && b.r.x + b.r.w <= W + 0.5 && b.r.y >= 0 && b.r.y + b.r.h <= H + 0.5)`);

(async () => {
  const seller = player('Sela', 'u_seller'), b1 = player('Mira', 'u_b1'), b2 = player('Otto', 'u_b2'), guest = player('Guest', null);
  for (const g of [seller, b1, b2, guest]) { g.giveTeam(['dog', 'fox', 'owl'], 12); g.run('MP.econ.add(1000, "test")'); }
  seller.run(`unlockPet('toad', 9, rollGenes({ shiny: false })); unlockPet('boar', 25, rollGenes({ shiny: true })); unlockPet('kelpie', 31, rollGenes({ shiny: false })); HERD.forEach(it => { if (it.def.pet === 'toad') { it.nick = 'Hoppy'; it.g.bond = 77; it.xp = 5; } }); savePets();`);
  const FISHK = seller.J('FISH_IDS'), small = seller.J(`FISH_IDS.slice().sort((a, b) => FISH[a].shape.flat().filter(Boolean).length - FISH[b].shape.flat().filter(Boolean).length)[0]`);
  const rare = seller.J(`FISH_IDS.find(k => FISH[k].rarity !== FISH[${JSON.stringify(small)}].rarity)`);

  console.log('1. listing an animal: locks, escrow, the document');
  {
    const g = seller, c0 = count(g), g0 = g.gold();
    eq(await g.A(`sell('animal', petSlots[0], 100)`), false, 'an animal in the team cannot be listed');
    ok(/in your team/i.test(g.note()), 'and the panel says why: ' + g.note());
    g.run(`SAVE.den = { m: HERD.find(it => it.def.pet === 'toad').pid };`);
    eq(await g.A(`sell('animal', HERD.find(it => it.def.pet === 'toad'), 100)`), false, 'one of the Den pair cannot be listed');
    g.run('SAVE.den = {};');
    eq(g.run(`(() => { const keep = HERD.slice(), slots = petSlots.slice(); HERD.length = 1; petSlots = [null, null, null]; const l = MP.auction._.animalLock(HERD[0]); HERD.length = 0; HERD.push(...keep); petSlots = slots; return l; })()`), 'Your last animal', 'your last animal cannot be listed');
    eq(await g.A(`sell('animal', HERD.find(it => it.def.pet === 'toad'), 0)`), false, 'price 0 is refused');
    eq(await g.A(`sell('animal', HERD.find(it => it.def.pet === 'toad'), 100000)`), false, 'price 100,000 is refused');
    eq(await g.A(`sell('animal', HERD.find(it => it.def.pet === 'toad'), 12.5)`), false, 'a price that is not a whole number is refused');
    eq(count(g).herd, c0.herd, 'nothing left the herd for the refused tries'); eq(FAKE.docs.size, 0, 'and nothing was written');
    const pid = g.run(`HERD.find(it => it.def.pet === 'toad').pid`);
    eq(await g.A(`sell('animal', HERD.find(it => it.def.pet === 'toad'), 120)`), true, 'the toad is listed for 120');
    eq(count(g).herd, c0.herd - 1, 'it left the herd at once'); ok(!g.J('SAVE.herd.map(r => r.pid)').includes(pid), 'and the saved herd');
    eq(g.esc().map(e => [e.st, e.cat, e.price]), [['live', 'animal', 120]], 'it is in escrow, live');
    ok(JSON.parse(g.store[g.run(`sk('packrat_econ')`)]).ah.esc.length === 1, 'the escrow note is in the saved economy data');
    eq(g.gold(), g0, 'listing is free');
    const [id, d] = [...FAKE.docs.entries()][0], f = d.fields;
    eq([f.seller.stringValue, f.sellerName.stringValue, f.cat.stringValue, f.sub.stringValue, f.price.integerValue, f.state.stringValue, f.buyer.nullValue, f.lvl.integerValue], ['u_seller', 'Sela', 'animal', 'toad', '120', 'open', null, '9'], 'the document has the listing');
    eq(f.title.stringValue, 'Hoppy', 'titled with its name'); ok(f.created.timestampValue === d.updateTime, 'created is the server time of the write');
    const item = JSON.parse(f.item.stringValue); eq([item.k, item.lvl, item.nick, item.g.bond, 'pid' in item, 'born' in item], ['toad', 9, 'Hoppy', 77, false, false], 'the item text is the animal, without its id or story');
    eq(g.esc()[0].id, id, 'the escrow note carries the listing id'); ok(/^[A-Za-z0-9]{20}$/.test(id), 'a 20-character id');
    const c = FAKE.log.filter(r => r.kind === 'commit').pop(), w = c.body.writes[0];
    ok(c.auth && w.currentDocument.exists === false && w.updateTransforms[0].setToServerValue === 'REQUEST_TIME' && w.updateTransforms[0].fieldPath === 'created', 'created with exists:false and a server-time transform');
  }

  console.log('2. listing fish and dishes; the limit of 8');
  {
    const g = seller;
    fishOf(g, small); fishOf(g, rare); g.run(`(() => { const d = makeItem('dish_' + ${JSON.stringify(rare)}); d.q = 3; bagAdd('pantry', d); const e = makeItem('dish_' + ${JSON.stringify(small)}); bagAdd('pantry', e); })()`);
    eq(await g.A(`sell('fish', 1, 40)`), true, 'the rarer fish is listed'); eq(count(g).fish, 1, 'it left the Fish Bag');
    eq(g.J(`bagItems('fish').map(i => i.def.fish)`), [small], 'the other fish stays');
    eq(await g.A(`sell('dish', 0, 75)`), true, 'the golden dish is listed'); eq(count(g).dish, 1, 'it left the pantry');
    eq(await g.A(`sell('fish', 7, 40)`), false, 'a fish that is not there cannot be listed');
    const dishDoc = [...FAKE.docs.values()].find(d => d.fields.cat.stringValue === 'dish');
    eq(JSON.parse(dishDoc.fields.item.stringValue), { k: rare, q: 3 }, 'the dish keeps its quality');
    eq(await g.A(`sell('animal', HERD.find(it => it.def.pet === 'boar'), 900)`), true, 'the shiny boar is listed');
    eq(await g.A(`sell('animal', HERD.find(it => it.def.pet === 'kelpie'), 300)`), true, 'the kelpie is listed');
    for (let i = 0; i < 4; i++) fishOf(g, small);
    for (let i = 0; i < 3; i++) eq(await g.A(`sell('fish', 0, ${10 + i})`), true, `small fish ${i + 1} listed`);
    eq(g.esc().length, 8, 'eight listings');
    eq(await g.A(`sell('fish', 0, 5)`), false, 'a ninth is refused'); ok(/8 listings/.test(g.note()), 'with the reason: ' + g.note());
    eq(FAKE.docs.size, 8, 'eight documents online'); eq(count(g).fish, 2, 'the refused fish stayed in the bag');
  }

  console.log('3. browsing (logged out too), tabs, filters, sorting, search');
  {
    const g = guest;
    eq(await g.A('refresh(true)'), true, 'a logged-out player can refresh');
    eq(g.rows().length, 8, 'and sees all eight listings');
    ok(FAKE.log.filter(r => r.kind === 'query').pop().auth === false, 'the browse query carries no sign-in');
    const q = FAKE.log.filter(r => r.kind === 'query' && r.body.structuredQuery.orderBy).pop().body.structuredQuery;
    eq([q.where.fieldFilter.field.fieldPath, q.where.fieldFilter.op, q.orderBy.length, q.orderBy[0].field.fieldPath, q.orderBy[0].direction, q.limit], ['created', 'GREATER_THAN', 1, 'created', 'DESCENDING', 50], 'the query: created > t, newest first, 50');
    const tab = t => { g.run(`MP.auction.S.tab = ${JSON.stringify(t)}`); return g.rows(); };
    eq(tab('animal').map(r => r.name).sort(), g.J(`['Hoppy', BS.boar.baby && 25 < EVO_LVL ? BS.boar.baby : PETS.boar.name, PETS.kelpie.name].sort()`), 'Animals: three');
    eq(tab('fish').length, 4, 'Fish: four'); eq(tab('dish').length, 1, 'Dishes: one'); eq(tab('all').length, 8, 'All: eight');
    eq(tab('all').map(r => r.price)[0], 12, 'newest first');
    g.run(`MP.auction.S.tab = 'animal'; MP.auction.S.f.shiny = true`); eq(g.rows().map(r => r.price), [900], 'shiny only: the boar');
    g.run(`MP.auction.S.f.shiny = false; MP.auction.S.f.act = 4`); eq(g.rows().map(r => r.price), [300], 'Act IV: the kelpie');
    g.run(`MP.auction.S.f.act = 0; MP.auction.S.f.role = PETS.toad.role`); ok(g.rows().some(r => r.name === 'Hoppy') && g.rows().every(r => r.role === g.run('PETS.toad.role')), 'by role');
    g.run(`MP.auction.S.f.role = ''; MP.auction.S.f.sort = 'lo'`); eq(g.rows().map(r => r.price), [120, 300, 900], 'price up');
    g.run(`MP.auction.S.f.sort = 'hi'`); eq(g.rows().map(r => r.price), [900, 300, 120], 'price down');
    g.run(`MP.auction.S.f.sort = 'lvl'`); eq(g.rows().map(r => r.lvl), [31, 25, 9], 'level down');
    g.run(`MP.auction.S.tab = 'fish'; MP.auction.S.f.rar = FISH[${JSON.stringify(rare)}].rarity`); eq(g.rows().map(r => r.price), [40], 'fish by rarity');
    g.run(`MP.auction.S.f.rar = ''; MP.auction.S.f.sort = 'new'; MP.auction.S.tab = 'all'; MP.auction.S.f.q = 'hop'`); eq(g.rows().map(r => r.name), ['Hoppy'], 'search by name');
    g.run(`MP.auction.S.f.q = ''`);
    console.log('   ... logged out: no listing, no buying');
    const n = FAKE.log.length, id = g.rows()[0].id, c0 = count(g);
    eq(await g.A(`sell('animal', HERD.find(it => !petSlots.includes(it)) || HERD[0], 50)`), false, 'logged out: cannot list'); ok(/Records Hall/.test(g.note()), 'told to log in at the Records Hall');
    eq(await g.A(`buy(${JSON.stringify(id)})`), false, 'logged out: cannot buy');
    eq(FAKE.log.length, n, 'and no request was even sent'); eq(count(g), c0, 'nothing changed'); eq(g.gold(), 1000, 'Gold untouched');
    /* and the server would refuse it anyway */
    const r = await FAKE.fetch(PRE + ':commit', { method: 'POST', body: JSON.stringify({ writes: [{ update: { name: NAME(id), fields: { state: FAKE.S('sold'), buyer: FAKE.S('x'), buyerName: FAKE.S('x') } }, updateMask: { fieldPaths: ['state', 'buyer', 'buyerName'] }, updateTransforms: [{ fieldPath: 'soldAt', setToServerValue: 'REQUEST_TIME' }] }] }) });
    eq(r.status, 403, 'the rules refuse a write without sign-in');
  }

  console.log('4. the rules themselves (the fake mirrors firestore.rules)');
  {
    const tok = uid => ({ Authorization: 'Bearer tok:' + uid }), post = (uid, w) => FAKE.fetch(PRE + ':commit', { method: 'POST', headers: uid ? tok(uid) : {}, body: JSON.stringify({ writes: [w] }) });
    const good = () => ({ seller: FAKE.S('u_x'), sellerName: FAKE.S('X'), cat: FAKE.S('fish'), sub: FAKE.S(small), title: FAKE.S('Fish'), price: FAKE.I(5), item: FAKE.S('{}'), lvl: FAKE.I(0), rarity: FAKE.S('common'), shiny: { booleanValue: false }, state: FAKE.S('open'), buyer: { nullValue: null }, buyerName: FAKE.S(''), soldAt: { nullValue: null } });
    const create = (uid, fields, id, tr = true) => post(uid, { update: { name: NAME(id || mkId()), fields }, currentDocument: { exists: false }, updateTransforms: tr ? [{ fieldPath: 'created', setToServerValue: 'REQUEST_TIME' }] : [] });
    const bad = async (m, f, uid = 'u_x', id) => eq((await create(uid, f, id)).status, 403, 'create refused: ' + m);
    await bad('as somebody else', good(), 'u_other');
    await bad('price 0', Object.assign(good(), { price: FAKE.I(0) })); await bad('price 100000', Object.assign(good(), { price: FAKE.I(100000) })); await bad('price as text', Object.assign(good(), { price: FAKE.S('5') }));
    await bad('a giant item', Object.assign(good(), { item: FAKE.S('x'.repeat(6001)) })); await bad('a long name', Object.assign(good(), { sellerName: FAKE.S('x'.repeat(17)) }));
    await bad('already sold', Object.assign(good(), { state: FAKE.S('sold') })); await bad('with a buyer', Object.assign(good(), { buyer: FAKE.S('u_x') }));
    await bad('an extra field', Object.assign(good(), { admin: { booleanValue: true } })); await bad('a missing field', (() => { const f = good(); delete f.rarity; return f; })());
    await bad('an unknown category', Object.assign(good(), { cat: FAKE.S('weapon') })); await bad('a bad id', good(), 'u_x', 'short');
    eq((await create('u_x', Object.assign(good(), { created: { timestampValue: '2020-01-01T00:00:00.000000Z' } }), null, false)).status, 403, 'create refused: its own (old) creation time');
    const id = mkId(); eq((await create('u_x', good(), id)).status, 200, 'a correct create is accepted'); eq((await create('u_x', good(), id)).status, 409, 'the same id again: already exists');
    const ut = FAKE.docs.get(id).updateTime, buyW = (fields, mask, cur) => ({ update: { name: NAME(id), fields }, updateMask: { fieldPaths: mask }, updateTransforms: [{ fieldPath: 'soldAt', setToServerValue: 'REQUEST_TIME' }], currentDocument: cur || { updateTime: ut } });
    const sold = uid => ({ state: FAKE.S('sold'), buyer: FAKE.S(uid), buyerName: FAKE.S('B') });
    eq((await post('u_x', buyW(sold('u_x'), ['state', 'buyer', 'buyerName']))).status, 403, 'the seller cannot buy their own listing');
    eq((await post('u_y', buyW(sold('u_z'), ['state', 'buyer', 'buyerName']))).status, 403, 'nobody can buy in another name');
    eq((await post('u_y', buyW(Object.assign(sold('u_y'), { price: FAKE.I(1) }), ['state', 'buyer', 'buyerName', 'price']))).status, 403, 'a buyer cannot change the price');
    eq((await post('u_y', buyW(Object.assign(sold('u_y'), { seller: FAKE.S('u_y') }), ['state', 'buyer', 'buyerName', 'seller']))).status, 403, 'nor the seller');
    eq((await post('u_y', buyW(sold('u_y'), ['state', 'buyer', 'buyerName'], { updateTime: '2020-01-01T00:00:00.000000Z' }))).status, 400, 'a stale version fails the precondition');
    eq((await FAKE.fetch(PRE + '/auctions/' + id, { method: 'DELETE', headers: tok('u_y') })).status, 403, 'only the seller can delete');
    eq((await FAKE.fetch(PRE + ':runQuery', { method: 'POST', body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'auctions' }], where: { fieldFilter: { field: { fieldPath: 'seller' }, op: 'EQUAL', value: FAKE.S('u_x') } }, limit: 5000 } }) })).status, 403, 'a query for more than 100 is refused');
    eq((await post('u_y', buyW(sold('u_y'), ['state', 'buyer', 'buyerName']))).status, 200, 'a correct purchase is accepted');
    eq((await post('u_z', buyW(sold('u_z'), ['state', 'buyer', 'buyerName'], { updateTime: FAKE.docs.get(id).updateTime }))).status, 403, 'a sold listing cannot be bought again');
    eq((await FAKE.fetch(PRE + '/auctions/' + id + '?currentDocument.updateTime=' + encodeURIComponent(FAKE.docs.get(id).updateTime), { method: 'DELETE', headers: tok('u_x') })).status, 200, 'the seller deletes it');
    eq(FAKE.docs.size, 8, 'back to the eight listings');
  }

  console.log('5. buying: Gold moves, the item arrives cleaned; the seller is paid with the fee');
  let toadId;
  {
    await b1.A('refresh(true)'); b1.run(`MP.auction.S.tab = 'all'`);
    const toad = b1.rows().find(r => r.name === 'Hoppy'); toadId = toad.id;
    const c0 = count(b1), sh0 = b1.run('SAVE.coll.toad || 0');
    eq(await b1.A(`buy(${JSON.stringify(toad.id)})`), true, 'Mira buys the toad');
    eq(b1.gold(), 880, '120 Gold paid'); eq(count(b1).herd, c0.herd + 1, 'the toad arrived');
    const got = b1.J(`(() => { const it = HERD.find(i => i.def.pet === 'toad'); return { lvl: petLvl(it), nick: it.nick, bond: it.g.bond, xp: it.xp, how: it.born.how, from: it.born.from, pid: it.pid }; })()`);
    eq([got.lvl, got.nick, got.bond, got.xp, got.how, got.from], [9, 'Hoppy', 0, 5, 'bought', 'Sela'], 'level, name and xp kept; bond starts at 0');
    ok(b1.J('SAVE.herd.map(r => r.pid)').includes(got.pid), 'and it is saved'); eq(b1.run('SAVE.coll.toad'), sh0 + 1, 'counted in the collection');
    const f = FAKE.docs.get(toad.id).fields; eq([f.state.stringValue, f.buyer.stringValue, f.buyerName.stringValue, f.soldAt.timestampValue === FAKE.docs.get(toad.id).updateTime, f.price.integerValue], ['sold', 'u_b1', 'Mira', true, '120'], 'the document is sold to Mira');
    const w = FAKE.log.filter(r => r.kind === 'commit').pop().body.writes[0];
    ok(w.currentDocument.updateTime && w.updateMask.fieldPaths.join() === 'state,buyer,buyerName' && w.updateTransforms[0].fieldPath === 'soldAt', 'one write: masked update, soldAt transform, updateTime precondition');
    ok(!b1.rows().some(r => r.id === toad.id), 'it is off the list'); eq(b1.J('MP.auction._.ah().buys'), [], 'no pending purchase note is left');
    eq(await b1.A(`buy(${JSON.stringify(toad.id)})`), false, 'it cannot be bought twice');
    /* the seller */
    const s0 = seller.gold();
    await seller.A('settle(true)');
    eq(seller.gold(), s0 + 114, 'the seller receives 114 (120 minus the 5% fee)');
    eq(seller.note(), 'Your Hoppy sold to Mira for 120 Gold (114 after the fee).', 'with the sale message');
    ok(!FAKE.docs.has(toad.id), 'the sold document is deleted'); eq(seller.esc().length, 7, 'and its escrow note is gone');
    await seller.A('settle(true)'); eq(seller.gold(), s0 + 114, 'settling again pays nothing more');
    eq([seller.A('payout(1)'), seller.A('payout(10)'), seller.A('payout(19)'), seller.A('payout(20)'), seller.A('payout(99999)')], [1, 9, 18, 19, 95000], 'the fee: 5% rounded down, at least 1, and at least 1 Gold is paid');
    /* own listings */
    await seller.A('refresh(true)'); const own = seller.J(`MP.auction.S.rows.find(r => r.seller === 'u_seller').id`);
    eq(await seller.A(`buy(${JSON.stringify(own)})`), false, 'you cannot buy your own listing'); ok(/your own/.test(seller.note()), 'and are told so');
    /* not enough Gold */
    b2.run('MP.econ.spend(MP.econ.gold() - 50, "test")'); await b2.A('refresh(true)');
    const boar = b2.J(`MP.auction.S.rows.find(r => r.price === 900).id`), n = FAKE.log.length;
    eq(await b2.A(`buy(${JSON.stringify(boar)})`), false, 'not enough Gold: refused'); eq(FAKE.log.length, n, 'before anything is sent'); eq(b2.gold(), 50, 'Gold untouched');
    b2.run('MP.econ.add(950, "test")');
  }

  console.log('6. a full bag refuses the purchase before paying');
  {
    const g = b1; let n = 0; while (fishOf(g, small) && n < 200) n++;
    ok(n > 0 && n < 200, `the Fish Bag is full after ${n} fish`);
    await g.A('refresh(true)'); const fish = g.J(`MP.auction.S.rows.find(r => r.cat === 'fish').id`), gold0 = g.gold(), reqs = FAKE.log.length;
    eq(await g.A(`buy(${JSON.stringify(fish)})`), false, 'refused'); ok(/Fish Bag is full/.test(g.note()), 'with the reason: ' + g.note());
    eq(g.gold(), gold0, 'no Gold taken'); eq(FAKE.log.length, reqs, 'no request sent'); eq(FAKE.docs.get(fish).fields.state.stringValue, 'open', 'the listing is still open');
    g.run(`saveBag('fish', bagItems('fish').slice(0, 3))`);
    const dish = g.J(`MP.auction.S.rows.find(r => r.cat === 'dish').id`);
    eq(await g.A(`buy(${JSON.stringify(dish)})`), true, 'the dish fits the pantry and is bought'); eq(g.J(`bagItems('pantry').map(i => [i.def.dish, i.q])`), [[rare, 3]], 'it arrives with its quality'); eq(g.gold(), gold0 - 75, '75 Gold paid');
    eq(await g.A(`buy(${JSON.stringify(fish)})`), true, 'with room, the fish is bought'); eq(count(g).fish, 4, 'and it is in the bag');
    await seller.A('settle(true)');
  }

  console.log('7. two buyers race for one listing: exactly one wins');
  for (const [mode, rulesFirst, precond] of [['precondition checked first (400)', false, [400, 'FAILED_PRECONDITION']], ['rules checked first (403)', true, [400, 'FAILED_PRECONDITION']], ['precondition as 409', false, [409, 'ABORTED']]]) {
    FAKE.rulesFirst = rulesFirst; FAKE.precond = precond;
    fishOf(seller, small); eq(await seller.A(`sell('fish', bagItems('fish').length - 1, 33)`), true, `[${mode}] a fish is listed`);
    await b1.A('refresh(true)'); await b2.A('refresh(true)');
    const id = b1.J(`MP.auction.S.rows.find(r => r.price === 33).id`), g1 = b1.gold(), g2 = b2.gold(), f1 = count(b1).fish, f2 = count(b2).fish;
    const res = await Promise.all([b1.A(`buy(${JSON.stringify(id)})`), b2.A(`buy(${JSON.stringify(id)})`)]);
    eq(res.filter(Boolean).length, 1, `[${mode}] exactly one buyer wins`);
    const [win, lose, gw, gl, fw, fl] = res[0] ? [b1, b2, g1, g2, f1, f2] : [b2, b1, g2, g1, f2, f1];
    eq([win.gold(), count(win).fish], [gw - 33, fw + 1], `[${mode}] the winner paid and has the fish`);
    eq([lose.gold(), count(lose).fish], [gl, fl], `[${mode}] the other keeps their Gold and gets nothing`);
    ok(/someone else just bought it/.test(lose.note()), `[${mode}] and is told: ${lose.note()}`);
    eq(lose.J('MP.auction._.ah().buys'), [], `[${mode}] no pending note is left`); ok(!lose.rows().some(r => r.id === id), `[${mode}] the listing left their list`);
    const s0 = seller.gold(); await seller.A('settle(true)'); eq(seller.gold(), s0 + 32, `[${mode}] the seller is paid once (33 - 1)`);
  }
  FAKE.rulesFirst = false; FAKE.precond = [400, 'FAILED_PRECONDITION'];

  console.log('8. cancelling; a cancel that loses to a sale');
  {
    const g = seller; await g.A('settle(true)');
    const kel = g.J(`MP.auction._.mineRows().find(r => r.cat === 'animal' && r.price === 300).id`), h0 = count(g).herd;
    eq(await g.A(`cancel(${JSON.stringify(kel)})`), true, 'the kelpie listing is cancelled');
    eq(count(g).herd, h0 + 1, 'the kelpie is back'); ok(!FAKE.docs.has(kel), 'the document is gone'); ok(!g.esc().some(e => e.id === kel), 'the escrow note too');
    eq(g.J(`(() => { const it = HERD.find(i => i.def.pet === 'kelpie'); return [petLvl(it), !!it.born, it.pid.length > 3]; })()`), [31, true, true], 'as it was (level, story, id)');
    const d = FAKE.log.filter(r => r.kind === 'delete').pop(); ok(d.auth && /currentDocument\.updateTime=/.test(d.url), 'deleted with an updateTime precondition, signed in');
    /* the buyer is faster than the cancel */
    await b2.A('refresh(true)'); const boar = g.J(`MP.auction._.mineRows().find(r => r.price === 900).id`), s0 = g.gold();
    let raced = false; FAKE.fail = req => { if (req.kind === 'delete' && !raced) { raced = true; FAKE.fail = null; const ut = FAKE.docs.get(boar).updateTime; FAKE.docs.get(boar).fields = Object.assign({}, FAKE.docs.get(boar).fields, { state: FAKE.S('sold'), buyer: FAKE.S('u_b2'), buyerName: FAKE.S('Otto') }); FAKE.docs.get(boar).updateTime = ut.replace(/\d{3}Z$/, '999Z'); } return null; };
    eq(await g.A(`cancel(${JSON.stringify(boar)})`), false, 'a cancel that arrives after the sale does not cancel'); FAKE.fail = null;
    eq(g.gold(), s0 + 855, 'the seller is paid for the boar instead (900 - 45)'); ok(!g.J(`HERD.map(i => i.def.pet)`).includes('boar'), 'and the boar did not come back');
    ok(!FAKE.docs.has(boar), 'the sold document is cleared');
  }

  console.log('9. expiry after 48 hours: off the list, cannot be bought, comes back to the seller');
  {
    const g = seller; await g.A('settle(true)'); const left = g.esc(); ok(left.length >= 3 && left.every(e => e.cat === 'fish'), `the seller still has ${left.length} fish listings`);
    await b2.A('refresh(true)'); const stale = b2.J(`MP.auction.S.rows.filter(r => r.seller === 'u_seller').map(r => r.id)`); ok(stale.length === left.length, 'the buyer sees them');
    FAKE.now += H48 - 60e3; eq(b2.rows().filter(r => stale.includes(r.id)).length, left.length, 'one minute before the end they are still listed');
    eq([1, 59e3, 61e3, 3600e3 * 5.5, -5].map(ms => b2.A(`_.timeLeft(${ms})`)), ['under a minute left', 'under a minute left', '2 min left', '5 h left', 'expired'], 'time left in words');
    FAKE.now += 2 * 60e3;
    eq(b2.rows().filter(r => stale.includes(r.id)).length, 0, 'after 48 hours they are off the list');
    const g2 = b2.gold(); eq(await b2.A(`buy(${JSON.stringify(stale[0])})`), false, 'and cannot be bought'); eq(b2.gold(), g2, 'no Gold taken');
    /* a buyer whose clock is behind: the server refuses */
    b2.run('MP.auction.clock = () => __clock() - 3600000; MP.auction.S.off = 0;'); const reqs = FAKE.log.length;
    eq(await b2.A(`buy(${JSON.stringify(stale[0])})`), false, 'a buyer with a slow clock is refused by the server'); ok(FAKE.log.length > reqs, '(the request was sent)'); eq(b2.gold(), g2, 'and keeps their Gold');
    ok(/run out|ended|Refresh/.test(b2.note()), 'told that it ran out: ' + b2.note()); eq(FAKE.docs.get(stale[0]).fields.state.stringValue, 'open', 'the listing was not sold');
    b2.run('MP.auction.clock = __clock;'); await b2.A('refresh(true)'); eq(b2.rows().filter(r => stale.includes(r.id)).length, 0, 'a fresh query leaves the expired ones out');
    /* the seller's bag is full: the fish wait in escrow, with Collect */
    let n = 0; while (fishOf(g, small) && n < 200) n++;
    const f0 = count(g).fish, s0 = g.gold(); await g.A('settle(true)');
    eq(g.gold(), s0, 'no Gold for expired listings'); eq(stale.filter(id => FAKE.docs.has(id)).length, 0, 'the expired documents are deleted');
    eq(g.esc().map(e => e.st), left.map(() => 'back'), 'the fish wait in escrow (the bag is full)'); eq(count(g).fish, f0, 'nothing was forced into the bag');
    ok(g.J('MP.auction._.mineRows().map(r => [r.do, r.status])').every(([a, s]) => a === 'Collect' && /Fish Bag is full/.test(s)), 'the panel says so, with a Collect button');
    eq(await g.A(`cancel(${JSON.stringify(left[0].id)})`), false, 'Collect with a full bag: still waiting'); eq(g.esc().length, left.length, 'nothing lost');
    g.run(`saveBag('fish', bagItems('fish').slice(0, 2))`);
    eq(await g.A(`cancel(${JSON.stringify(left[0].id)})`), true, 'Collect with room'); eq(g.esc().length, 0, 'everything came back'); eq(count(g).fish, 2 + left.length, 'the fish are in the bag again');
  }

  console.log('10. a failed create returns the item; lost answers; a crash between escrow and create');
  {
    const g = seller, c0 = count(g);
    FAKE.fail = req => (req.kind === 'commit' ? '403' : null);
    eq(await g.A(`sell('fish', 0, 20)`), false, '403 on create: not listed'); eq(count(g), c0, 'the fish is back in the bag'); eq(g.esc().length, 0, 'no escrow left');
    ok(/isn't open yet/.test(g.note()) && /back with you/.test(g.note()), 'the message: ' + g.note()); eq(g.A('S.err'), 'closed', 'the panel knows the house is not open');
    FAKE.fail = req => (req.kind === 'commit' ? '500' : null);
    eq(await g.A(`sell('fish', 0, 20)`), false, 'server error on create: not listed'); eq(count(g), c0, 'the fish is back');
    FAKE.fail = req => (req.kind === 'commit' ? 'offline' : null);
    eq(await g.A(`sell('fish', 0, 20)`), false, 'offline create (then the look-up says it is not there): not listed'); eq(count(g), c0, 'the fish is back'); eq(g.esc().length, 0, 'no escrow left'); eq(FAKE.docs.size, [...FAKE.docs.keys()].length, '');
    FAKE.fail = req => (req.kind === 'commit' ? 'lost' : null);
    eq(await g.A(`sell('fish', 0, 21)`), true, 'the answer to the create is lost, but the look-up finds it: listed'); eq(g.esc().map(e => e.st), ['live'], 'live in escrow'); eq(count(g).fish, c0.fish - 1, 'the fish left once');
    FAKE.fail = () => 'offline';
    eq(await g.A(`sell('fish', 0, 22)`), false, 'fully offline: unknown outcome'); eq(g.esc().map(e => e.st), ['live', 'new'], 'the item stays in escrow, unconfirmed'); eq(count(g).fish, c0.fish - 2, 'it is not duplicated');
    ok(/safe/.test(g.note()), 'the message: ' + g.note()); ok(g.J('MP.auction._.mineRows().map(r => r.status)').some(s => /Checking/.test(s)), 'My listings shows it as being checked');
    eq(await g.A('settle(true)'), false, 'still offline: settle changes nothing'); eq(g.esc().map(e => e.st), ['live', 'new'], 'escrow as before');
    FAKE.fail = null; await g.A('settle(true)');
    eq(g.esc().map(e => e.st), ['live'], 'back online: the unconfirmed one was never written, so it came back'); eq(count(g).fish, c0.fish - 1, 'into the bag');
    FAKE.fail = req => (req.kind === 'commit' ? 'slow' : null);
    eq(await g.A(`sell('fish', 0, 23)`), true, 'a slow answer is fine'); FAKE.fail = null;
    eq(g.esc().length, 2, 'two listings now');
    /* the page closes between the escrow note and the create */
    const before = count(g), toad2 = g.run(`unlockPet('ferret', 14, rollGenes({ shiny: false })).pid`);
    FAKE.fail = req => (req.kind === 'commit' || req.kind === 'get' ? 'hang' : null);
    g.A(`sell('animal', HERD.find(it => it.pid === ${JSON.stringify(toad2)}), 60)`);
    await sleep(30);
    const saved = JSON.parse(g.store[g.run(`sk('packrat_econ')`)]).ah.esc;
    ok(saved.some(e => e.st === 'new' && e.cat === 'animal'), 'the escrow note was saved before the network answered'); ok(!JSON.parse(g.store[g.run(`sk('packrat_herd')`)]).some(r => r.pid === toad2), 'and the animal is out of the saved herd');
    FAKE.fail = null;
    const again = player('Sela', 'u_seller', { storage: Object.assign({}, g.store) });   /* the same browser, opened again */
    eq(again.esc().filter(e => e.st === 'new').length, 1, 'after the restart the unconfirmed listing is still noted');
    await again.A('settle(true)');
    ok(again.J('HERD.map(i => i.pid)').includes(toad2), 'the ferret is recovered, with its own id'); eq(again.J(`petLvl(HERD.find(i => i.pid === ${JSON.stringify(toad2)}))`), 14, 'at its level');
    eq(again.esc().map(e => e.st), ['live', 'live'], 'the two real listings are still live'); eq(count(again).herd, before.herd + 1, 'herd count right');
    await sleep(900);   /* the old page's hanging calls time out: it sorts itself out too */
    FAKE.fail = null; await g.idle(); await g.A('settle(true)');
    ok(g.J('HERD.map(i => i.pid)').includes(toad2) && g.esc().every(e => e.st === 'live'), 'the old page recovers the animal too once its calls time out'); const deadId = saved.find(e => e.st === 'new').id; ok(g.J('MP.auction._.ah().dead').includes(deadId), 'and remembers that id as never written');
    /* that write lands after all (a request that outlived its time-out): it is deleted, never adopted as a second copy */
    { const dead = deadId, any = [...FAKE.docs.values()].find(d => d.fields.seller.stringValue === 'u_seller'); FAKE.put(dead, JSON.parse(JSON.stringify(any.fields))); const n = g.esc().length, h = count(g).herd;
      await g.A('settle(true)'); ok(!FAKE.docs.has(dead), 'a late-landing listing is deleted'); eq([g.esc().length, count(g).herd], [n, h], 'and nothing is adopted or returned twice'); }
    /* the purchase whose answer is lost */
    await b2.A('refresh(true)'); const id = b2.J(`MP.auction.S.rows.find(r => r.price === 21).id`), g0 = b2.gold(), f0 = count(b2).fish;
    FAKE.fail = req => (req.kind === 'commit' ? 'lost' : null);
    eq(await b2.A(`buy(${JSON.stringify(id)})`), false, 'a purchase whose answer is lost: unknown'); eq([b2.gold(), count(b2).fish], [g0, f0], 'nothing paid, nothing received yet'); eq(b2.J('MP.auction._.ah().buys.length'), 1, 'a pending note is kept');
    FAKE.fail = null; await b2.A('settle(true)');
    eq([b2.gold(), count(b2).fish], [g0 - 21, f0 + 1], 'the next settle finishes it: paid once, the fish arrives'); eq(b2.J('MP.auction._.ah().buys.length'), 0, 'the note is cleared');
    await b2.A('settle(true)'); eq([b2.gold(), count(b2).fish], [g0 - 21, f0 + 1], 'and never twice');
    await g.A('settle(true)');
  }

  console.log('11. hostile listing documents are cleaned or skipped');
  {
    const S = FAKE.S, I = FAKE.I, L = FAKE.listing, before = FAKE.docs.size;
    const animal = o => S(JSON.stringify(o));
    FAKE.put(mkId(), L({ price: S('cheap') })); FAKE.put(mkId(), L({ price: I(-5) })); FAKE.put(mkId(), L({ price: I(1e9) })); FAKE.put(mkId(), L({ price: { doubleValue: 2.5 } }));
    FAKE.put(mkId(), L({ cat: S('weapon') })); FAKE.put(mkId(), L({ cat: I(3) })); FAKE.put(mkId(), L({ item: S('not json {') })); FAKE.put(mkId(), L({ item: S('x'.repeat(50000)) }));
    FAKE.put(mkId(), L({ item: S('{"k":"dragonzilla"}') })); FAKE.put(mkId(), L({ item: S('{"k":"__proto__"}') })); FAKE.put(mkId(), L({ item: S('{"k":"constructor"}') })); FAKE.put(mkId(), L({ item: S('null') })); FAKE.put(mkId(), L({ item: S('[1,2]') }));
    FAKE.put(mkId(), L({ cat: S('animal'), item: animal({ k: 'nosuchbeast', lvl: 5 }) })); FAKE.put(mkId(), L({ cat: S('animal'), item: animal({ k: 'toString' }) }));
    FAKE.put(mkId(), L({ state: S('weird') })); FAKE.put(mkId(), L({ seller: I(5) })); FAKE.put(mkId(), L({ created: S('yesterday') }));
    FAKE.put('short', L({ item: S(JSON.stringify({ k: small })) })); FAKE.put(mkId(), { junk: { mapValue: { fields: {} } }, created: FAKE.T() }); FAKE.put(mkId(), L({ sellerName: { arrayValue: { values: [] } }, item: S(JSON.stringify({ k: small })), price: I(7) }));
    const evil = mkId(), dishy = mkId(), longName = mkId();
    FAKE.put(evil, L({ cat: S('animal'), price: I(11), sellerName: S('<img src=x onerror=alert(1)>'), title: S('FREE GOLD'), lvl: I(1), item: animal({ k: 'fox', lvl: 9999, xp: -50, pid: 'x'.repeat(500), nick: '<b>' + 'Z'.repeat(2000), talents: { nope: 99, __proto__: 5, ['a'.repeat(300)]: 1 }, g: { atk: 1e9, def: -4, hp: 'lots', bond: 100, nat: 'evil', sex: 'q', shiny: 'yes', col: [999, -1, 4], blend: 1 }, born: { how: 'x'.repeat(500) } }) }));
    FAKE.put(mkId(), L({ cat: S('animal'), price: I(13), item: animal({ k: 'fox', lvl: 5, nick: 'N'.repeat(7000) }) }));
    FAKE.put(dishy, L({ cat: S('dish'), price: I(9), item: S(JSON.stringify({ k: small, q: 99, x: 'y'.repeat(3000) })) }));
    FAKE.put(longName, L({ price: I(8), sellerName: S('N'.repeat(5000)), item: S(JSON.stringify({ k: small })) }));
    const g = b2; let threw = null;
    try { await g.A('refresh(true)'); } catch (e) { threw = e; }
    ok(!threw, 'refreshing over hostile documents does not throw' + (threw ? ': ' + threw : ''));
    const P = d => g.run(`MP.auction._.parseDoc(${JSON.stringify(d)})`), base = { name: NAME(evil), updateTime: '2026-01-01T00:00:00.000000Z', fields: L() };
    ok(P(base) !== null, 'parseDoc: a plain listing parses');
    for (const [m, d] of [['null', null], ['a number', 5], ['no fields', { name: NAME(evil), updateTime: 'x' }], ['a foreign path', Object.assign({}, base, { name: 'projects/evil/databases/(default)/documents/auctions/' + evil })], ['a garbage time', Object.assign({}, base, { fields: L({ created: { timestampValue: 'garbage' } }) })],
      ['a giant version', Object.assign({}, base, { updateTime: 'x'.repeat(5000) })], ['fields as an array', Object.assign({}, base, { fields: [1, 2] })], ['a field as a string', Object.assign({}, base, { fields: L({ seller: 'u' }) })]]) eq(P(d), null, 'parseDoc: ' + m + ' is skipped');
    eq(g.rows().filter(r => [evil, dishy, longName].includes(r.id)).length, 3, 'the cleanable ones are shown'); eq(g.J(`MP.auction.S.rows.find(r => r.id === ${JSON.stringify(longName)}).sellerName`), 'Someone', 'an over-long seller name is not shown at all');
    const shown = g.J(`MP.auction._.visible().map(r => r.id)`), ghost = g.J(`MP.auction.S.rows.filter(r => r.seller === 'u_ghost' && r.it).map(r => r.price).sort((a, b) => a - b)`);
    eq(ghost, [7, 8, 9, 11], 'only the four sane ghost listings survive (an item text over 6000 is skipped)');
    const e = g.J(`(() => { const r = MP.auction.S.rows.find(r => r.id === ${JSON.stringify(evil)}); return { lvl: petLvl(r.it), max: PET_MAX_LVL, nick: r.it.nick, name: r.name, seller: r.sellerName, g: r.it.g, tal: Object.keys(r.it.talents), o: Object.keys(r.o).sort() }; })()`);
    eq(e.lvl, e.max, 'an impossible level is clamped'); ok(e.nick.length <= 16 && !/[<>]/.test(e.nick), 'the nickname is cleaned: ' + e.nick); ok(!/[<>=()]/.test(e.seller) && e.seller.length <= 16, 'the seller name is cleaned: ' + e.seller);
    ok(e.g.atk <= 100 && e.g.def >= 0 && e.g.hp <= 100 && e.g.sex === 'm' && typeof e.g.shiny === 'boolean' && e.g.col.length === 2, 'the genes are cleaned'); eq(e.tal, [], 'unknown talents are dropped'); eq(e.o, ['g', 'k', 'lvl', 'nick', 'talents', 'xp'], 'nothing but the known fields is kept');
    ok(e.name !== 'FREE GOLD', 'the shown name comes from the item, not the document title');
    for (const port of [false, true]) { g.setPortrait(port); g.run(`MP.stations.mp_auction()`); for (const t of ['all', 'animal', 'fish', 'dish']) { g.run(`MP.auction.S.tab = '${t}'`); ok(drawsOk(g, 'hostile ' + t), `hostile rows draw (${t}, ${port ? 'portrait' : 'landscape'})`); } g.run(`MP.auction.S.sel = { id: ${JSON.stringify(evil)} }; MP.auction.S.view = 'detail'`); ok(drawsOk(g, 'hostile detail'), 'the hostile animal draws in the detail view'); g.A('close()'); }
    g.setPortrait(false); await g.idle();
    const h0 = count(g).herd, g0 = g.gold();
    eq(await g.A(`buy(${JSON.stringify(evil)})`), true, 'the cleaned animal can be bought');
    const fox = g.J(`(() => { const it = HERD[HERD.length - 1]; return { k: it.def.pet, lvl: petLvl(it), bond: it.g.bond, xp: it.xp, pid: it.pid, nick: it.nick, from: it.born.from }; })()`);
    ok(fox.k === 'fox' && fox.lvl === e.max && fox.bond === 0 && fox.xp === 0 && fox.pid.length < 40 && !/[<>]/.test(fox.nick + fox.from), 'and arrives clean: ' + JSON.stringify(fox)); eq(g.gold(), g0 - 11, '11 Gold paid'); eq(count(g).herd, h0 + 1, 'one animal more');
    eq(await g.A(`buy(${JSON.stringify(dishy)})`), true, 'the dish with a silly quality is bought'); eq(g.J(`bagItems('pantry').map(i => i.q)`).pop(), 2, 'as a plain dish');
    /* hostile saved state */
    g.run(`MP.econ.data.ah = { esc: [null, 5, { id: 'x' }, { id: 'A'.repeat(20), cat: 'fish', it: { k: 'nope' } }, { id: 'B'.repeat(20), cat: 'animal', it: { k: 'fox', lvl: 1e9 }, price: 'a', st: 'evil' }, { id: 'B'.repeat(20), cat: 'fish', it: { k: ${JSON.stringify(small)} } }], buys: 'no', notes: [1, 'x'.repeat(999)] }; MP.econ.save(); MP.econ.load();`);
    const a = g.J('MP.auction._.ah()'); eq([a.esc.length, a.esc[0].st, a.esc[0].price, a.esc[0].it.lvl, a.buys, a.notes.length, a.notes[0].length], [1, 'new', 1, e.max, [], 1, 140], 'a hostile saved escrow is cleaned on load');
    ok(drawsOk(g, 'hostile ah'), 'and draws'); g.run('MP.econ.data.ah = {}; MP.econ.save();');
    for (const id of [...FAKE.docs.keys()]) if (FAKE.docs.get(id).fields.seller === undefined || FAKE.docs.get(id).fields.seller.stringValue !== 'u_seller') FAKE.docs.delete(id);
    ok(before >= FAKE.docs.size, 'cleaned up');
  }

  console.log('12. not open yet (permission denied), offline, empty');
  {
    const g = guest; g.run(`MP.stations.mp_auction()`); await g.idle(); await sleep(5);
    FAKE.closed = true; g.run('MP.auction.S.lastAsk = -1e9'); await g.A('refresh(true)');
    eq(g.A('S.err'), 'closed', 'a permission-denied answer: the house is not open yet'); eq(g.rows().length, 0, 'no rows'); eq(g.A('_.MSG.closed'), "The auction house isn't open yet.", 'the wording');
    for (const port of [false, true]) { g.setPortrait(port); ok(drawsOk(g, 'closed'), `the "not open yet" state draws (${port ? 'portrait' : 'landscape'})`); }
    await seller.A('settle(true)'); eq(seller.A('S.mineErr'), 'closed', 'My listings knows it too'); ok(seller.esc().length > 0, 'and no escrow is touched while it is closed');
    FAKE.closed = false; FAKE.fail = () => 'offline'; await g.A('refresh(true)');
    eq(g.A('S.err'), 'offline', 'no network: offline'); eq(g.A('_.MSG.offline'), "The auction house can't be reached right now.", 'the wording');
    for (const port of [false, true]) { g.setPortrait(port); ok(drawsOk(g, 'offline'), `the offline state draws (${port ? 'portrait' : 'landscape'})`); }
    FAKE.fail = null; g.setPortrait(false);
    const keep = new Map(FAKE.docs); FAKE.docs.clear(); await g.A('refresh(true)'); eq([g.A('S.err'), g.rows().length], [null, 0], 'an empty house is not an error'); ok(drawsOk(g, 'empty'), 'the empty state draws');
    for (const [k, v] of keep) FAKE.docs.set(k, v);
    FAKE.fail = req => (req.kind === 'query' ? 'hang' : null); g.A('refresh(true)'); await sleep(5); eq(g.A('S.loading'), true, 'while the query is out: loading'); ok(drawsOk(g, 'loading'), 'the loading state draws');
    await sleep(500); FAKE.fail = null; await g.idle(); eq(g.A('S.loading'), false, 'a query that never answers times out'); eq(g.A('S.err'), 'offline', 'as offline');
    g.A('close()');
  }

  console.log('13. paging: 50 at a time with Load more; the Refresh cool-down');
  {
    for (let i = 0; i < 120; i++) { FAKE.now += 1000; FAKE.put(mkId(), FAKE.listing({ price: FAKE.I(1000 + i), item: FAKE.S(JSON.stringify({ k: FISHK[i % FISHK.length] })) })); }
    const g = guest; await g.A('refresh(true)'); g.run(`MP.auction.S.tab = 'all'`);
    eq([g.A('S.rows.length'), g.A('S.more')], [50, true], 'the first page: 50, and there is more'); eq(g.rows()[0].price, 1119, 'newest first');
    await g.A('loadMore()'); eq([g.A('S.rows.length'), g.A('S.more')], [100, true], 'Load more: 100');
    ok(FAKE.log.filter(r => r.kind === 'query').pop().body.structuredQuery.startAt.before === false, 'the next page starts after the last one');
    await g.A('loadMore()'); const total = g.A('S.rows.length'); ok(total >= 120 && total < 150 && g.A('S.more') === false, `the last page: ${total} in all, nothing more`);
    eq(new Set(g.J('MP.auction.S.rows.map(r => r.id)')).size, total, 'no listing twice');
    const n = FAKE.log.length; eq(await g.A('refresh(false)'), false, 'Refresh right after a refresh: cooling down'); eq(FAKE.log.length, n, 'nothing is sent');
    FAKE.now += 6000; eq(await g.A('refresh(false)'), true, 'after the cool-down it works again');
    for (const id of [...FAKE.docs.keys()]) if (FAKE.docs.get(id).fields.seller.stringValue === 'u_ghost') FAKE.docs.delete(id);
  }

  console.log('14. the panel by hand: mouse, keys, wheel, drag; every view in landscape and portrait');
  {
    const g = seller; await g.A('settle(true)');
    g.run(`unlockPet('owl', 8, rollGenes({ shiny: true }));`); for (let i = 0; i < 3; i++) fishOf(g, FISHK[i]); g.run(`bagAdd('pantry', makeItem('dish_' + ${JSON.stringify(small)}))`);
    for (const port of [false, true]) {
      const where = port ? 'portrait' : 'landscape'; g.setPortrait(port);
      g.run('MP.stations.mp_auction()'); eq(g.run('G.panel'), 'mpauction', `[${where}] the station opens the panel`); await g.idle(); await sleep(5);
      ok(drawsOk(g, 'list') && inside(g), `[${where}] the list draws, buttons on screen`);
      for (const t of ['animal', 'fish', 'dish', 'mine', 'cos', 'all']) { ok(g.btn('tab', t), `[${where}] tab ${t} clicked`); eq(g.A('S.tab'), t, `[${where}] tab ${t} is shown`); ok(drawsOk(g, 'tab ' + t) && inside(g), `[${where}] tab ${t} draws`); }
      g.btn('tab', 'animal'); for (const c of ['act', 'role', 'shiny', 'sort']) ok(g.btn('chip', c) && drawsOk(g, 'chip ' + c), `[${where}] filter ${c} works`);
      eq([g.A('S.f.act'), g.A('S.f.shiny'), g.A('S.f.sort')], [1, true, 'lo'], `[${where}] the filters changed`); g.run(`Object.assign(MP.auction.S.f, { act: 0, role: '', shiny: false, sort: 'new' })`);
      g.btn('chip', 'find'); g.run(`pressed = { h: true, o: true }`); g.frame(); eq(g.A('S.f.q'), 'ho', `[${where}] typing in Find by name`); g.run(`pressed = { e: true }`); g.frame(); eq([g.A('S.f.q'), g.run('G.panel')], ['hoe', 'mpauction'], `[${where}] E types, it does not close`);
      g.run(`pressed = { Enter: true }`); g.frame(); g.run(`MP.auction.S.f.q = ''`); g.btn('tab', 'all');
      /* sell with the mouse and the keypad */
      const n0 = g.esc().length; ok(g.btn('sell'), `[${where}] Sell something`); eq(g.A('S.view'), 'sellcat', `[${where}] pick a category`); ok(drawsOk(g, 'sellcat') && inside(g), `[${where}] it draws`);
      for (const cat of ['dish', 'fish', 'animal']) {
        g.run(`MP.auction.S.view = 'sellcat'`); g.frame(); ok(g.btn('sellCat', cat), `[${where}] category ${cat}`); eq([g.A('S.view'), g.A('S.sell.cat')], ['sellpick', cat], `[${where}] pick a ${cat}`); ok(drawsOk(g, 'sellpick ' + cat) && inside(g), `[${where}] the ${cat} picker draws`);
      }
      const cells = g.J(`MP.auction._.layout().list.cells.map(c => ({ x: c.r.x + c.r.w / 2, y: c.r.y + c.r.h / 2, lock: c.stock.lock, k: c.stock.it.def.pet }))`);
      const locked = cells.find(c => c.lock), free = cells.find(c => !c.lock && c.k === 'owl');
      g.clickAt(locked.x, locked.y); eq(g.A('S.view'), 'sellpick', `[${where}] a locked animal cannot be picked`); ok(/can't be sold/.test(g.note()), `[${where}] with the reason`);
      g.run(`mouse.x = ${free.x}; mouse.y = ${free.y}; onMouseDown(0); mouse.y -= 60;`); g.frame(); g.run('onMouseUp(0)'); eq(g.A('S.view'), 'sellpick', `[${where}] dragging the grid does not pick`);
      g.run('MP.auction.S.sc.pick = 0'); g.frame(); g.clickAt(free.x, free.y); eq(g.A('S.view'), 'sellprice', `[${where}] a click picks the animal`); ok(drawsOk(g, 'sellprice') && inside(g), `[${where}] the price view draws`);
      eq(g.J(`MP.auction._.layout().btns.find(b => b.id === 'sellAsk').off`), true, `[${where}] no price yet: cannot list`);
      g.btn('key', '4'); g.btn('key', '5'); g.btn('key', '⌫'); g.btn('key', '2'); g.run(`pressed = { 0: true }`); g.frame(); eq(g.A('S.sell.price'), '420', `[${where}] keypad and keyboard digits`);
      g.btn('step', 100); g.btn('step', -10); eq(g.A('S.sell.price'), '510', `[${where}] the step buttons`); for (let i = 0; i < 4; i++) g.btn('key', '9'); eq(g.A('S.sell.price'), '51099', `[${where}] never above 99,999`); g.btn('key', 'C'); g.btn('key', '6'); g.btn('key', '0');
      ok(g.btn('sellAsk'), `[${where}] List for 60`); eq(g.A('S.view'), 'sellok', `[${where}] asks to confirm`); ok(drawsOk(g, 'sellok') && inside(g), `[${where}] the confirmation draws (with the fee and the shiny warning)`);
      ok(g.btn('sellYes'), `[${where}] Yes`); await g.idle(); eq(g.esc().length, n0 + 1, `[${where}] it is listed`); eq([g.A('S.view'), g.A('S.tab')], ['list', 'mine'], `[${where}] and My listings is shown`); ok(drawsOk(g, 'mine') && inside(g), `[${where}] My listings draws`);
      /* My listings: detail, cancel through the row's button */
      const row = g.J(`MP.auction._.layout().list.cells.map(c => ({ id: c.row.id, price: c.row.price, x: c.r.x + 80, y: c.r.y + 20, bx: c.btn && c.btn.x + 10, by: c.btn && c.btn.y + 10 })).find(c => c.price === 60)`);
      g.clickAt(row.x, row.y); eq(g.A('S.view'), 'detail', `[${where}] a click on my listing opens it`); ok(drawsOk(g, 'mine detail') && inside(g), `[${where}] my listing's detail draws`);
      g.run(`pressed = { Escape: true }`); g.frame(); eq(g.A('S.view'), 'list', `[${where}] Escape goes back`);
      g.clickAt(row.bx, row.by); await g.idle(); eq(g.esc().length, n0, `[${where}] the row's Cancel button cancels`); ok(g.J('HERD.map(i => i.def.pet)').filter(k => k === 'owl').length === 2, `[${where}] the owl is back`);
      /* a long list scrolls */
      for (let i = 0; i < 14; i++) { FAKE.now += 1000; FAKE.put(mkId(), FAKE.listing({ price: FAKE.I(200 + i), item: FAKE.S(JSON.stringify({ k: FISHK[i % FISHK.length] })) })); }
      FAKE.put(mkId(), FAKE.listing({ cat: FAKE.S('animal'), price: FAKE.I(77), item: FAKE.S(JSON.stringify({ k: 'fox', lvl: 22, g: { shiny: true, sex: 'f' }, nick: 'Vix' })) })); FAKE.put(mkId(), FAKE.listing({ cat: FAKE.S('dish'), price: FAKE.I(66), item: FAKE.S(JSON.stringify({ k: rare, q: 0 })) }));
      g.btn('tab', 'all'); FAKE.now += 6000; ok(g.btn('refresh'), `[${where}] Refresh clicked`); await g.idle(); await sleep(5); ok(g.rows().length >= 16, `[${where}] the new listings are shown`); ok(drawsOk(g, 'long list'), `[${where}] the long list draws`);
      eq(g.J(`MP.auction._.layout().btns.find(b => b.id === 'refresh').off`), true, `[${where}] Refresh is cooling down`);
      g.run(`MP.panels.mpauction.wheel(150)`); ok(g.A('S.sc.list') > 0 || port, `[${where}] the wheel scrolls`); g.run('MP.auction.S.sc.list = 0');
      const v = g.J('MP.auction._.layout().list.view'); g.run(`mouse.x = ${v.x + 200}; mouse.y = ${v.y + v.h - 20}; onMouseDown(0); mouse.y -= 120;`); g.frame(); g.run('onMouseUp(0)');
      ok(g.A('S.sc.list') > 0 || g.J('MP.auction._.layout().list.total') <= v.h, `[${where}] dragging scrolls the list`); eq(g.A('S.view'), 'list', `[${where}] and does not open a row`);
      g.run('MP.auction.S.sc.list = 0'); g.run(`pressed = { ArrowDown: true }`); g.frame();
      g.run('MP.auction.S.sc.list = 0'); g.frame();
      /* a buyer: detail of each kind, buy with clicks */
      const b = b1; b.setPortrait(port); b.run('MP.stations.mp_auction()'); await b.idle(); await sleep(5);
      for (const price of [77, 66, 200]) {
        b.run(`MP.auction.S.view = 'list'; MP.auction.S.tab = 'all'; MP.auction.S.f.sort = 'lo'; MP.auction.S.sc.list = 0`); b.frame();
        const c = b.J(`MP.auction._.layout().list.cells.filter(c => c.row && c.row.price === ${price}).map(c => ({ id: c.row.id, x: c.r.x + 90, y: c.r.y + 20, vy: c.r.y }))[0]`);
        if (c.vy > b.J('MP.auction._.layout().list.view').y + b.J('MP.auction._.layout().list.view').h - 30) { b.run(`MP.auction.S.sel = { id: ${JSON.stringify(c.id)} }; MP.auction.S.view = 'detail'`); } else b.clickAt(c.x, c.y);
        eq(b.A('S.view'), 'detail', `[${where}] the ${price} Gold listing opens`); ok(drawsOk(b, 'detail ' + price) && inside(b), `[${where}] its detail draws`);
        const g0 = b.gold(); ok(b.btn('buyAsk'), `[${where}] Buy`); eq(b.A('S.ask'), true, `[${where}] asks first`); ok(drawsOk(b, 'ask') && inside(b), `[${where}] the question draws`);
        if (price === 200) { b.btn('back'); eq(b.A('S.ask'), false, `[${where}] No: nothing bought`); eq(b.gold(), g0, `[${where}] Gold kept`); continue; }
        ok(b.btn('buyYes'), `[${where}] Yes`); await b.idle(); await sleep(5); eq(b.gold(), g0 - price, `[${where}] bought for ${price}`); eq(b.A('S.view'), 'list', `[${where}] back at the list`);
      }
      b.run(`MP.auction.S.f.sort = 'new'`); b.run(`pressed = { e: true }`); b.frame(); eq([b.run('G.panel'), b.A('S.view')], ['mpauction', 'list'], `[${where}] E goes back from the detail`); b.run(`pressed = { e: true }`); b.frame(); eq(b.run('G.panel'), null, `[${where}] E at the list closes the panel`);
      /* logged out: browse only */
      const x = guest; x.setPortrait(port); x.run('MP.stations.mp_auction()'); await x.idle(); await sleep(5); ok(drawsOk(x, 'guest list') && inside(x), `[${where}] logged out: the list draws`);
      eq(x.J(`MP.auction._.layout().btns.find(b => b.id === 'sell').off`), true, `[${where}] logged out: Sell is off`); x.btn('sell'); eq(x.A('S.view'), 'list', `[${where}] and does nothing`); ok(/Records Hall/.test(x.note()), `[${where}] but says where to log in`);
      x.btn('tab', 'mine'); ok(drawsOk(x, 'guest mine'), `[${where}] logged out: My listings draws its hint`); x.btn('tab', 'all'); x.frame();
      const c = x.J(`MP.auction._.layout().list.cells.filter(c => c.row).map(c => ({ x: c.r.x + 90, y: c.r.y + 20 }))[0]`); x.clickAt(c.x, c.y); eq(x.A('S.view'), 'detail', `[${where}] logged out: a listing opens`); ok(drawsOk(x, 'guest detail'), `[${where}] and draws`);
      eq(x.J(`MP.auction._.layout().btns.find(b => b.id === 'buyAsk').txt`), 'Log in to buy', `[${where}] the Buy button says to log in`); x.run('onMouseDown(2)'); eq(x.A('S.view'), 'list', `[${where}] right-click goes back`); x.btn('close'); eq(x.run('G.panel'), null, `[${where}] Close closes`);
      g.btn('close'); for (const id of [...FAKE.docs.keys()]) if (FAKE.docs.get(id).fields.seller.stringValue === 'u_ghost') FAKE.docs.delete(id);
    }
    for (const p of [seller, b1, guest]) p.setPortrait(false);
  }

  console.log('15. the quiet check in the street; a listing made on another device; without MP.econ');
  {
    const g = seller; await g.A('settle(true)'); const live = g.esc().find(e => e.st === 'live'); ok(!!live, 'the seller has a live listing');
    await b2.A('refresh(true)'); eq(await b2.A(`buy(${JSON.stringify(live.id)})`), true, 'Otto buys it');
    const s0 = g.gold(); g.run(`G.panel = null; G.hubRoom = 'street'; MP.auction.S.tick = 0; for (let i = 0; i < 100; i++) MP.auction._.tick(1);`); await g.idle(); eq(g.gold(), s0, 'in the street, nothing for the first minutes');
    g.run(`for (let i = 0; i < 90; i++) MP.auction._.tick(1);`); await g.idle(); eq(g.gold(), s0 + g.A(`payout(${live.price})`), 'then the sale is collected quietly'); ok(/sold to Otto/.test(g.run('G.msg')), 'with a message on the screen: ' + g.run('G.msg'));
    g.run(`G.hubRoom = 'yard'`);
    /* another device: the same account lists from a second browser with its own save */
    const dev2 = player('Sela', 'u_seller'); dev2.giveTeam(['dog', 'fox', 'owl'], 12); fishOf(dev2, small); eq(await dev2.A(`sell('fish', 0, 15)`), true, 'the second device lists a fish');
    const n0 = g.esc().length; await g.A('settle(true)'); eq(g.esc().length, n0 + 1, 'the first device adopts that listing from the document'); ok(g.J('MP.auction._.mineRows().map(r => r.price)').includes(15), 'and shows it under My listings');
    { const n = FAKE.log.length; g.run(`MP.auction.S.tick = 0; for (let i = 0; i < 200; i++) MP.auction._.tick(1);`); await g.idle(); eq(FAKE.log.length, n, 'outside the street, live listings are left alone');
      g.run(`MP.auction._.ah().esc.find(e => e.st === 'live').st = 'new'; for (let i = 0; i < 200; i++) MP.auction._.tick(1);`); await g.idle(); ok(FAKE.log.length > n && g.esc().every(e => e.st === 'live'), 'but an unconfirmed listing is looked up anywhere in the Sanctuary'); }
    /* the game without the Gold module */
    const bare = player('Bare', 'u_bare'); bare.run('delete MP.econ; MP.stations.mp_auction()'); await bare.idle(); await sleep(5);
    ok(drawsOk(bare, 'no econ') && bare.A('S.rows.length') > 0, 'without MP.econ the house can still be browsed'); eq(await bare.A(`buy(${JSON.stringify(bare.J('MP.auction.S.rows[0].id'))})`), false, 'but not bought from'); bare.run(`MP.auction.S.tab = 'mine'`); ok(drawsOk(bare, 'no econ mine'), 'and My listings draws');
  }

  eq(FAKE.foreign, 0, 'no request ever left the fake Firestore');
  ok(FAKE.log.every(r => r.url.startsWith(PRE)), 'every call went to the documented Firestore REST address');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('TEST CRASHED', e); process.exit(1); });
