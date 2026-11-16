// =====================================================================
//  GOLD AND THE MISSION BOARD (MP.econ)
//  Gold is the Kingdom Street's currency: paid by missions, auction sales and co-op clears (never by solo runs),
//  spent in the cosmetics shop and the auction house.
//
//  THE SAVED DATA: one localStorage key, sk('packrat_econ') (in SAVE_KEYS, so save files and cloud saves carry it):
//    MP.econ.data = { v: 1, gold, earned, spent,      (earned / spent: lifetime totals)
//                     mis: { 'd<day>' | 'w<week>': { '<mission index>': { p: [delivered per part], done: 0 | 1 } } },
//                     own: { '<cosmetic id>': 1 },    (MP.shop's)
//                     ah: { ... },                    (MP.auction's local state: any plain JSON, size-capped)
//                     log: [{ t, n, w }] }            (the last 30 Gold movements: when, +/- how much, why)
//  It is untrusted (a save file can be imported, a cloud save downloaded): `clean` rebuilds it field by field on
//  every load: integers clamped, unknown fields dropped, sizes capped; anything missing or broken = a fresh object.
//
//  THE INTERFACE (the auction house and the shop code against this):
//    MP.econ.load()               (re)read from storage: at boot, after a save import, after a cloud download
//    MP.econ.save()               write it (never over an imported save that waits for the restart: SAVE_LOCK) and
//                                 tell the account sync that something changed (accChanged, like saveData does)
//    MP.econ.gold()               -> integer >= 0
//    MP.econ.add(n, why)          + Gold (n > 0; the purse holds at most 9,999,999), a log line, a floating
//                                 "+n Gold" toast, saved. Returns what was really added.
//    MP.econ.spend(n, why)        -> true and takes it, or false when there is not enough (nothing changes)
//    MP.econ.owns(id) / grant(id) cosmetics (ids like 'wing:demon', 'hc:pink', 'dye:top:knight:crimson')
//    MP.econ.drawGold(x, y, opt)  a coin and an amount with its vertical middle at y; opt = { align: 'left' (x = left
//                                 edge, the default) | 'right' (x = right edge) | 'center', size: font px (14),
//                                 color, n: an amount to show instead of the purse (a price), bold }. Returns the width.
//    MP.econ.coin(x, y, s)        just the coin, centred on x,y, s pixels across (code-drawn, pixel style)
//    MP.econ.now()                the clock in ms (overridable: the tests inject it). Missions are dated in UTC.
//
//  index.html calls in through small hooks marked "// MP:": saveFileApply (import / cloud download) -> load();
//  drawHubHUD and drawPortraitHUD -> hud(x, y, w, h) (the Gold counter inside the Sanctuary's own title panel);
//  the Records Hall's rows. mp/coop.js pays through `payout` when a dungeon or a raid is completed.
// =====================================================================
(() => {
  const KEY = () => sk('packrat_econ');
  const MAX_GOLD = 9999999, LOG_MAX = 30, OWN_MAX = 600, AH_MAX = 60000;
  const ID_RX = /^[a-z0-9][a-z0-9:_.-]{0,47}$/i, MIS_RX = /^[dw][0-9]{1,7}$/;
  const PAY = { dungeon: 50, raid: 100 };   /* a completed co-op run, each player */
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const okId = id => typeof id === 'string' && ID_RX.test(id) && !(id in Object.prototype);   /* a cosmetic's id: short, plain, and never the name of something every object has */
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const int = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : lo);
  const fresh = () => ({ v: 1, gold: 0, earned: 0, spent: 0, mis: {}, own: {}, ah: {}, log: [] });

  // ---------- cleaning what was saved ----------
  // any JSON value, made harmless: depth, sizes and string lengths capped, odd keys and non-finite numbers dropped
  function plain(v, depth) {
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string') return v.slice(0, 2000);
    if (depth <= 0 || typeof v !== 'object') return null;
    if (Array.isArray(v)) return v.slice(0, 200).map(x => plain(x, depth - 1));
    const o = {}; let n = 0;
    for (const k of Object.keys(v)) { if (n >= 200) break; if (k.length > 64 || k === '__proto__' || k === 'constructor' || k === 'prototype') continue; o[k] = plain(v[k], depth - 1); n++; }
    return o;
  }
  function cleanMis(raw) {
    const out = {}; if (!isObj(raw)) return out;
    const ids = Object.keys(raw).filter(k => MIS_RX.test(k) && isObj(raw[k])).sort((a, b) => +b.slice(1) - +a.slice(1)).slice(0, 12);   /* the newest dozen */
    for (const id of ids) {
      const o = {};
      for (let i = 0; i < 4; i++) { const m = raw[id][i]; if (!isObj(m)) continue; o[i] = { p: (Array.isArray(m.p) ? m.p : []).slice(0, 3).map(n => int(n, 0, 99)), done: m.done ? 1 : 0 }; }
      out[id] = o;
    }
    return out;
  }
  function clean(raw) {
    const d = fresh(); if (!isObj(raw)) return d;
    d.gold = int(raw.gold, 0, MAX_GOLD); d.earned = int(raw.earned, 0, 2e9); d.spent = int(raw.spent, 0, 2e9);
    d.mis = cleanMis(raw.mis);
    if (isObj(raw.own)) { let n = 0; for (const k of Object.keys(raw.own)) { if (n >= OWN_MAX) break; if (okId(k) && raw.own[k]) { d.own[k] = 1; n++; } } }
    if (isObj(raw.ah)) { const a = plain(raw.ah, 7); let size = AH_MAX + 1; try { size = JSON.stringify(a).length; } catch (e) {} if (size <= AH_MAX) d.ah = a; }
    if (Array.isArray(raw.log)) d.log = raw.log.slice(-LOG_MAX).filter(isObj).map(l => ({ t: int(l.t, 0, 9e15), n: int(l.n, -MAX_GOLD, MAX_GOLD), w: typeof l.w === 'string' ? l.w.slice(0, 40) : '' }));
    return d;
  }

  // ---------- load / save ----------
  const E = MP.econ = { data: fresh(), PAY, MAX_GOLD, now: () => Date.now() };
  function load() {
    let raw = null;
    try { const s = localStorage.getItem(KEY()); if (typeof s === 'string' && s.length <= 400000) raw = JSON.parse(s); } catch (e) { raw = null; }
    E.data = clean(raw); toasts.length = 0;
    return E.data;
  }
  function save() {
    if (typeof SAVE_LOCK !== 'undefined' && SAVE_LOCK) return false;   /* another save was just put in place: the page is about to restart with it */
    try { localStorage.setItem(KEY(), JSON.stringify(E.data)); } catch (e) { return false; }
    try { if (!accQuiet) accChanged(); } catch (e) {}   /* (queues the upload to the account, like saveData) */
    return true;
  }
  function logLine(n, why) { const L = E.data.log; L.push({ t: int(E.now(), 0, 9e15), n, w: String(why || '').slice(0, 40) }); if (L.length > LOG_MAX) L.splice(0, L.length - LOG_MAX); }
  const gold = () => int(E.data.gold, 0, MAX_GOLD);
  function add(n, why) {
    n = int(n, 0, MAX_GOLD); if (n <= 0) return 0;
    const D = E.data, got = Math.min(n, MAX_GOLD - gold());
    D.gold = gold() + got; D.earned = int(D.earned + got, 0, 2e9); logLine(got, why);
    if (got > 0) { toasts.push({ n: got, t: 0 }); if (toasts.length > 6) toasts.shift(); }
    save();
    return got;
  }
  function spend(n, why) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return false;
    n = Math.floor(n); if (n === 0) return true;
    const D = E.data; if (gold() < n) return false;
    D.gold = gold() - n; D.spent = int(D.spent + n, 0, 2e9); logLine(-n, why); save();
    return true;
  }
  const owns = id => typeof id === 'string' && has(E.data.own, id) && E.data.own[id] === 1;
  function grant(id) {
    if (!okId(id)) return false;
    if (!owns(id)) { if (Object.keys(E.data.own).length >= OWN_MAX) return false; E.data.own[id] = 1; save(); }
    return true;
  }
  // a completed co-op run (from MP.coop's `done`): 50 Gold for a dungeon, 100 for a raid. Returns the amount.
  function payout(kind) { const n = kind === 'raid' ? PAY.raid : PAY.dungeon; add(n, kind === 'raid' ? 'Raid cleared' : 'Dungeon cleared'); return n; }

  // ---------- drawing: the coin, an amount, the HUD counter, the "+n Gold" toasts ----------
  const fmt = n => String(Math.max(0, Math.floor(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const COIN = ['..oooo..', '.oYYYYo.', 'oYWYYYDo', 'oYWYDYDo', 'oYYYDYDo', 'oYYYYDDo', '.oDDDDo.', '..oooo..'], COIN_C = { o: '#5a3a10', Y: '#ffd36b', W: '#fff3c4', D: '#c99a3e' };
  function coin(x, y, s = 16) {
    const c = Math.max(1, Math.round(s / 8)), x0 = Math.round(x - c * 4), y0 = Math.round(y - c * 4);
    for (let r = 0; r < 8; r++) for (let q = 0; q < 8; q++) { const ch = COIN[r][q]; if (ch === '.') continue; ctx.fillStyle = COIN_C[ch]; ctx.fillRect(x0 + q * c, y0 + r * c, c, c); }
    return c * 8;
  }
  function goldWidth(n, size, bold) { ctx.font = `${bold === false ? '' : 'bold '}${size}px ${UI}`; return Math.max(1, Math.round(size / 8)) * 8 + 5 + ctx.measureText(fmt(n)).width; }
  function drawGold(x, y, opt = {}) {
    const size = opt.size || 14, n = opt.n === undefined ? gold() : opt.n, txt = fmt(n), w = goldWidth(n, size, opt.bold), cs = Math.max(1, Math.round(size / 8)) * 8;
    const x0 = opt.align === 'right' ? x - w : opt.align === 'center' ? x - w / 2 : x;
    coin(x0 + cs / 2, y, size);
    label(txt, x0 + cs + 5, y + 1, { size, bold: opt.bold !== false, color: opt.color || PAL.gold });
    return w;
  }
  // The Sanctuary's Gold counter, inside the HUD's own title panel (x, y, w, h: that panel) at the right end of its
  // title line, so it can't collide with anything else on the screen; if the title is too long for that, a small
  // panel of its own just under the title panel's right end.
  const toasts = []; let anchor = null, hudRect = null, lastT = 0;
  function hudTitle() { try { return G.visit ? `${G.visit.name}'s Yard` : HUB_ROOMS[G.hubRoom || 'yard'].name; } catch (e) { return ''; } }
  function hud(x, y, w, h) {
    if (!G) return;
    const gw = goldWidth(gold(), 15); ctx.font = `24px ${TITLE}`;
    const tw = ctx.measureText(hudTitle()).width;
    if (16 + tw + 18 + gw + 14 <= w) hudRect = { x: x + w - 14 - gw, y: y + 9, w: gw, h: 22 };
    else { hudRect = { x: x + w - gw - 24 + 12, y: y + h + 2 + 4, w: gw, h: 22 }; panel(x + w - gw - 24, y + h + 2, gw + 24, 30, 'leather'); }
    drawGold(hudRect.x, hudRect.y + 11, { size: 15 });
    anchor = { x: hudRect.x + hudRect.w / 2, y: hudRect.y + hudRect.h + 14 };
  }
  // floating "+25 Gold" lines: they rise from the counter and fade (drawn last, over the HUD and any panel)
  function drawToasts() {
    const dt = clamp(TIME - lastT, 0, 0.1); lastT = TIME;
    if (!toasts.length || !G) { anchor = null; return; }
    const a = anchor || { x: W / 2, y: PORTRAIT() ? 150 : 120 }; anchor = null;
    ctx.save();
    for (let i = toasts.length - 1; i >= 0; i--) {
      const T = toasts[i]; T.t += dt; if (T.t > 2.4) { toasts.splice(i, 1); continue; }
      const txt = `+${fmt(T.n)} Gold`, k = T.t / 2.4, yy = a.y + 12 - k * 34 + (toasts.length - 1 - i) * 22;
      ctx.font = `bold 17px ${UI}`; const tw = ctx.measureText(txt).width + 26 + 22, xx = clamp(a.x - tw / 2, 6, Math.max(6, W - 6 - tw));
      ctx.globalAlpha = clamp(Math.min(T.t * 6, (2.4 - T.t) * 2), 0, 1);
      panel(xx, yy - 14, tw, 28, 'dark'); coin(xx + 18, yy, 16); label(txt, xx + 32, yy + 1, { size: 17, bold: true, color: PAL.gold });
    }
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // =====================================================================
  //  THE MISSION BOARD (the Kingdom Street; works offline too: nothing here needs a connection)
  //  3 DAILY missions and 1 WEEKLY, the same for every player: generated from the UTC day number (the week turns
  //  over on Monday 00:00 UTC) with a seeded RNG, out of the game's own tables (FISH, PETS, BS, FAMILY, THEME_POOL),
  //  so new fish and species are picked up by themselves. A mission is { id: 'd<day>' | 'w<week>', i, weekly, title,
  //  reward, parts: [part] }; a part asks for `n` things:
  //    { t: 'fish', n, sp | min | eq }             a species · at least that rarity tier · exactly that tier
  //    { t: 'dish', n, min }                       cooked dishes (never charred) of fish of at least that tier
  //    { t: 'pet', n, sp | fam | role, act, lv, sex }   animals: a species · a family · a role in an act · any of an act
  //  Boss / special species are never asked for and a shiny is never required. Progress per part is saved in
  //  data.mis[id][i] (so a mission pays exactly once, and "2 of 3 delivered" survives); old ids are pruned.
  //  Turning in is for good: fish leave the bag (saveBag); an animal leaves the herd the way giveDo removes it
  //  (never one in the team or the Den pair, never the last animal; a confirmation, and a second one for a shiny).
  // =====================================================================
  const DAY_MS = 86400000, RAR = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const SPECIAL = ['shadowwolf', 'elder', 'unicorn', 'lakewyrm', 'runeshell'];
  const DAILY_SUM = 120, DAILY_LO = 25, DAILY_HI = 60, WEEKLY_LO = 300, WEEKLY_HI = 400;
  const TITLES = { fish: ["The cook's order", 'Fresh catch', 'For the fishmonger', 'Supper for the inn', "The angler's wager"], dish: ['A hot meal', 'The feast table', 'Travellers are hungry'],
                   pet: ['A new home', 'The royal menagerie', 'A companion wanted', 'For the kennel master', 'A farm needs a friend'], weekly: ["The King's request", 'The grand order', 'A royal commission', "The guild's big ask"] };
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const an = w => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w;
  const seedOf = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const dayNum = () => Math.floor(E.now() / DAY_MS);
  const weekOf = d => Math.floor((d + 3) / 7);
  const actName = a => String(ACT_NAMES[a] || 'Act ' + a).split(' · ')[0];
  const fishTier = k => FISH_TIER[FISH[k].rarity] || 0;
  // the species a mission may ask for: ordinary ones that roam the wild (never a boss or a special one)
  function pool() {
    const wild = new Set(); if (typeof THEME_POOL === 'object' && THEME_POOL) for (const a of Object.values(THEME_POOL)) for (const k of a) wild.add(k);
    return PET_IDS.filter(k => BS[k] && ITEMS['pet_' + k] && !SPECIAL.includes(k) && BS[k].off !== 'special' && (!wild.size || wild.has(k)));
  }
  // the species of an act a mission names: the ones that both belong to it and roam its floors (ACT_ROLES)
  function actList(P, act) {
    const own = P.filter(k => speciesAct(k) === act), R = typeof ACT_ROLES === 'object' && ACT_ROLES && ACT_ROLES[act - 1], roam = R ? new Set([].concat(...Object.values(R))) : null, l = roam ? own.filter(k => roam.has(k)) : own;
    return l.length ? l : own;
  }
  // ---------- generating ----------
  function fishPart(R, weekly) {
    const ri = (a, b) => a + Math.floor(R() * (b - a + 1)), of = t => FISH_IDS.filter(k => fishTier(k) === t), rp = a => a[Math.floor(R() * a.length)], r = R();
    const sp = (t, a, b, w) => { const l = of(t); if (!l.length) return null; const n = ri(a, b); return { t: 'fish', n, sp: rp(l), pts: n * w }; };
    let p = null;
    if (weekly) p = r < 0.4 ? { t: 'fish', n: ri(2, 3), min: 2, pts: 0 } : r < 0.7 ? sp(2, 1, 2, 5) : r < 0.9 ? { t: 'fish', n: 1, eq: 3, pts: 8 } : { t: 'fish', n: ri(6, 8), min: 1, pts: 0 };
    else p = r < 0.4 ? sp(0, 2, 4, 1.2) : r < 0.55 ? sp(1, 1, 2, 2.4) : r < 0.78 ? { t: 'fish', n: ri(4, 6), min: 0, pts: 0 } : r < 0.92 ? { t: 'fish', n: ri(2, 3), min: 1, pts: 0 } : { t: 'fish', n: 1, eq: 2, pts: 4.5 };
    if (!p || (p.eq != null && !of(p.eq).length) || (p.min != null && !FISH_IDS.some(k => fishTier(k) >= p.min))) p = { t: 'fish', n: 3, min: 0, pts: 0 };   /* (a table without that rarity) */
    if (!p.pts) p.pts = p.n * [0.9, 2, 4.5, 8, 12][p.min || 0];
    return p;
  }
  function dishPart(R, weekly) { const n = weekly ? 3 + Math.floor(R() * 2) : 1 + Math.floor(R() * 2), min = weekly && FISH_IDS.some(k => fishTier(k) >= 1) ? 1 : 0; return { t: 'dish', n, min, pts: n * (weekly ? 3.5 : 2.5) }; }
  function petPart(R, weekly, solo) {
    const rp = a => a[Math.floor(R() * a.length)], P = pool(), ra = R(), rf = R(), rs = R(), rn = R();
    let act = weekly ? (ra < 0.5 ? 1 : ra < 0.85 ? 2 : 3) : ra < 0.85 ? 1 : 2, list = actList(P, act);
    if (!list.length) { act = 1; list = actList(P, 1); }
    if (!list.length) return fishPart(R, weekly);
    const k = rp(list), am = [0, 1, 1.5, 2, 2.5][act] || 1, p = { t: 'pet', n: 1 };
    if (weekly && !solo) {   /* several animals of a loose kind */
      p.n = 2 + Math.floor(rn * 2); p.lv = rp([0, 5, 8]);
      if (rf < 0.4 && FAMILY[k]) { p.fam = FAMILY[k]; p.pts = 4; } else if (rf < 0.75) { p.role = PETS[k].role; p.act = act; p.pts = 4 * am; } else { p.act = act; p.pts = 3 * am; }
    } else if (weekly) { p.sp = k; p.lv = rp([5, 8, 10]); p.pts = 5 * am; }
    else if (rf < 0.4) { p.sp = k; p.lv = rp([0, 0, 3, 5]); if (rs < 0.2) p.sex = rs < 0.1 ? 'f' : 'm'; p.pts = 5 * am + (p.sex ? 1.5 : 0); }
    else if (rf < 0.6 && FAMILY[k]) { p.fam = FAMILY[k]; p.lv = rp([0, 0, 3]); p.pts = 4; }
    else if (rf < 0.8) { p.role = PETS[k].role; p.act = act; p.lv = rp([0, 0, 3]); p.pts = 4 * am; }
    else { p.act = act; p.lv = rp([3, 5, 8]); p.pts = 3 * am; }
    if (!p.lv) delete p.lv;
    p.pts = (p.pts + (p.lv || 0) * 0.35) * p.n;
    return p;
  }
  function partText(p) {
    const n = p.n;
    if (p.t === 'fish') {
      if (p.sp) return `${n} ${FISH[p.sp].name}`;
      if (p.eq != null) return n === 1 ? `any ${cap(RAR[p.eq])} fish` : `${n} ${cap(RAR[p.eq])} fish`;
      if (p.min > 0) return n === 1 ? `a fish of at least ${cap(RAR[p.min])} rarity` : `${n} fish of at least ${cap(RAR[p.min])} rarity`;
      return n === 1 ? 'a fish of any kind' : `${n} fish of any kind`;
    }
    if (p.t === 'dish') return (n === 1 ? 'a cooked dish' : `${n} cooked dishes`) + (p.min > 0 ? ` of at least ${cap(RAR[p.min])} fish` : '') + ' (not charred)';
    const sex = p.sex === 'f' ? 'female ' : p.sex === 'm' ? 'male ' : ''; let s;
    if (p.sp) s = n === 1 ? an(sex + PETS[p.sp].name) : `${n} x ${sex}${PETS[p.sp].name}`;
    else if (p.fam) s = n === 1 ? `any ${sex}animal of the ${cap(p.fam)} family` : `${n} ${sex}animals of the ${cap(p.fam)} family`;
    else if (p.role) s = (n === 1 ? an(sex + p.role) : `${n} ${sex}${p.role}s`) + ` from ${actName(p.act)}`;
    else s = (n === 1 ? `any ${sex}animal` : `${n} ${sex}animals`) + ` from ${actName(p.act)}`;
    if (p.lv) s += n === 1 ? ` of level ${p.lv} or higher` : `, each of level ${p.lv} or higher`;
    return s;
  }
  function daily(day) {
    const R = mulberry32(seedOf('bps-daily-' + day)), parts = [], seen = new Set(), third = R();
    const makers = [() => fishPart(R, false), () => petPart(R, false), third < 0.4 ? () => fishPart(R, false) : third < 0.6 ? () => dishPart(R, false) : () => petPart(R, false)];
    for (const mk of makers) { let p = mk(); for (let i = 0; i < 6 && seen.has(partText(p)); i++) p = mk(); seen.add(partText(p)); parts.push(p); }
    // rewards follow the difficulty, and a day's three are worth DAILY_SUM in all
    const sum = parts.reduce((a, p) => a + p.pts, 0) || 1, rew = parts.map(p => clamp(Math.round(DAILY_SUM * p.pts / sum / 5) * 5, DAILY_LO, DAILY_HI));
    for (let guard = 0, diff = DAILY_SUM - rew.reduce((a, b) => a + b, 0); diff !== 0 && guard < 40; guard++) {
      const s = Math.sign(diff), order = parts.map((p, i) => i).sort((a, b) => s * (parts[b].pts - parts[a].pts) || a - b), i = order.find(j => rew[j] + 5 * s >= DAILY_LO && rew[j] + 5 * s <= DAILY_HI);
      if (i === undefined) break; rew[i] += 5 * s; diff -= 5 * s;
    }
    const used = new Set(), name = p => { const T = TITLES[p.t]; let t = T[Math.floor(R() * T.length)]; for (let i = 0; i < T.length && used.has(t); i++) t = T[(T.indexOf(t) + 1) % T.length]; used.add(t); return t; };
    return parts.map((p, i) => ({ id: 'd' + day, i, weekly: false, title: name(p), parts: [p], reward: rew[i] }));
  }
  function weekly(week) {
    const R = mulberry32(seedOf('bps-weekly-' + week)), r = R();
    const parts = r < 0.4 ? [petPart(R, true, false)] : r < 0.75 ? [fishPart(R, true), petPart(R, true, true)] : [fishPart(R, true), dishPart(R, true)];
    const pts = parts.reduce((a, p) => a + p.pts, 0);
    return { id: 'w' + week, i: 0, weekly: true, title: TITLES.weekly[Math.floor(R() * TITLES.weekly.length)], parts, reward: clamp(Math.round((290 + pts * 3) / 10) * 10, WEEKLY_LO, WEEKLY_HI) };
  }
  let BOARD = null;
  function board() {
    const day = dayNum(), week = weekOf(day);
    if (!BOARD || BOARD.day !== day) BOARD = { day, week, list: daily(day).concat(weekly(week)) };
    return BOARD;
  }
  const current = m => !!m && board().list.includes(m);
  const msLeft = wk => { const B = board(); return (wk ? (B.week + 1) * 7 - 3 : B.day + 1) * DAY_MS - E.now(); };
  function timeLeft(ms) { const s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`; }

  // ---------- progress ----------
  const prog = (m, pi) => { const o = E.data.mis[m.id], s = o && o[m.i]; return clamp((s && s.p[pi]) | 0, 0, m.parts[pi].n); };
  const isDone = m => { const o = E.data.mis[m.id], s = o && o[m.i]; return !!(s && s.done); };
  const partDone = (m, pi) => isDone(m) || prog(m, pi) >= m.parts[pi].n;
  function prune() {   /* forget the missions of days and weeks gone by (the last few are kept: enough against a clock set back) */
    const B = board(); let cut = false;
    for (const id of Object.keys(E.data.mis)) { const n = +id.slice(1); if (id[0] === 'd' ? n < B.day - 3 : n < B.week - 1) { delete E.data.mis[id]; cut = true; } }
    return cut;
  }
  // n more of a part were delivered; the last one of the last part pays the reward (once: `done` is saved with it)
  function bump(m, pi, n) {
    const o = E.data.mis[m.id] || (E.data.mis[m.id] = {}), s = o[m.i] || (o[m.i] = { p: [], done: 0 });
    for (let i = 0; i < m.parts.length; i++) s.p[i] = clamp(s.p[i] | 0, 0, m.parts[i].n);
    s.p[pi] = clamp(s.p[pi] + n, 0, m.parts[pi].n); prune();
    if (!s.done && m.parts.every((p, i) => s.p[i] >= p.n)) {
      s.done = 1; add(m.reward, m.weekly ? 'Weekly mission' : 'Daily mission');
      SFX.play('chest', true); if (G) showMsg(`Mission complete: ${m.title}! +${m.reward} Gold`, 3);
      return true;
    }
    save(); SFX.play('pick'); return false;
  }

  // ---------- what counts, and handing it over ----------
  const bagKind = p => (p.t === 'dish' ? 'pantry' : 'fish');
  function fishOk(p, it) {
    const k = it && it.def && (p.t === 'dish' ? it.def.dish : it.def.fish); if (!k || !FISH[k]) return false;   /* (a cooked dish never counts as a fish, nor a fish as a dish) */
    if (p.t === 'dish' && (it.q == null ? 2 : it.q) < 1) return false;
    const t = fishTier(k);
    return (!p.sp || p.sp === k) && (p.min == null || t >= p.min) && (p.eq == null || t === p.eq);
  }
  function petOk(p, it) {
    const k = it && it.def && it.def.pet; if (!k || !PETS[k] || p.t !== 'pet') return false;
    return (!p.sp || p.sp === k) && (!p.fam || FAMILY[k] === p.fam) && (!p.role || PETS[k].role === p.role) && (!p.act || speciesAct(k) === p.act) && (!p.lv || petLvl(it) >= p.lv) && (!p.sex || ((it.g && it.g.sex === 'f') ? 'f' : 'm') === p.sex);
  }
  const petLock = it => (HERD.length <= 1 ? 'Your last animal' : giveLock(it));   /* why this animal can't be turned in right now (null: it can) */
  const fishList = p => bagItems(bagKind(p)).map((it, i) => ({ i, it })).filter(e => fishOk(p, e.it));
  const petList = p => rosterList().filter(it => petOk(p, it));
  const eligible = p => (p.t === 'pet' ? petList(p).length : fishList(p).length);
  // hand over the fish / dishes at those places of the bag's list (only eligible ones, only as many as are still needed)
  function giveFish(m, pi, idxs) {
    if (!current(m) || partDone(m, pi) || !Array.isArray(idxs)) return 0;
    const p = m.parts[pi], kind = bagKind(p), list = bagItems(kind), left = p.n - prog(m, pi);
    const chosen = [...new Set(idxs)].filter(i => Number.isInteger(i) && list[i] && fishOk(p, list[i])).slice(0, left);
    if (!chosen.length) return 0;
    saveBag(kind, list.filter((it, i) => !chosen.includes(i)));
    bump(m, pi, chosen.length);
    return chosen.length;
  }
  // hand over one animal for good: giveDo's removal (herd, team slots, the Yard's animals, savePets), without the shared XP
  function givePet(m, pi, pid) {
    if (!current(m) || partDone(m, pi)) return false;
    const it = HERD.find(h => h.pid === pid); if (!it || !petOk(m.parts[pi], it) || petLock(it)) return false;
    HERD.splice(HERD.indexOf(it), 1);
    for (let i = 0; i < petSlots.length; i++) if (petSlots[i] === it) petSlots[i] = null;
    stats = computeStats(); syncPets(); savePets(); if (G && G.hub && G.hubRoom === 'yard' && !G.visit) spawnHubPets(G.room);
    bump(m, pi, 1);
    return true;
  }
  const petTitle = it => (it.nick ? `${it.nick} the ${PETS[it.def.pet].name}` : `this ${petName(it)}`);

  // ---------- the panel 'mpmissions': its state and layout (shared by drawing, clicks and keys) ----------
  // V.view: 'list' (the missions) | 'fish' (pick fish or dishes) | 'pet' (pick the animal) | 'confirm' | 'shiny' (the second confirmation)
  const newV = () => ({ view: 'list', cur: 0, m: null, pi: 0, sel: [], sc: 0, hot: 0, drag: null, pid: null });
  let V = newV();
  const INK_SOFT = '#4e3418', ROW_DIM = '#d2c2a4';
  const mbox = () => { const port = PORTRAIT(), w = port ? W - 12 : 780, h = Math.min(470, H - 8); return { x: W / 2 - w / 2, y: Math.max(4, H / 2 - h / 2 - (port ? 0 : 4)), w, h, port }; };
  function listLayout() {
    const b = mbox(), B = board(), x = b.x + 16, w = b.w - 32, rows = [], heads = []; let y = b.y + 48;
    const row = m => { const h = 30 + m.parts.length * 34; rows.push({ m, x, y, w, h, parts: m.parts.map((p, pi) => ({ p, pi, y: y + 26 + pi * 34, btn: { x: x + w - 102, y: y + 29 + pi * 34, w: 94, h: 28 } })) }); y += h + 4; };
    heads.push({ y: y + 10, txt: 'Daily missions', left: 'new ones in ' + timeLeft(msLeft(false)) }); y += 22;
    B.list.filter(m => !m.weekly).forEach(row);
    heads.push({ y: y + 11, txt: 'Weekly mission', left: timeLeft(msLeft(true)) + ' left' }); y += 23;
    B.list.filter(m => m.weekly).forEach(row);
    return { b, rows, heads, close: { x: b.x + b.w - 126, y: b.y + b.h - 46, w: 110, h: 34 } };
  }
  // every (mission, part) line of the list, top to bottom (the keyboard's cursor walks them)
  const lines = L => { const out = []; for (const r of L.rows) for (const q of r.parts) out.push({ m: r.m, pi: q.pi, p: q.p, btn: q.btn }); return out; };
  // a picker's scrolling grid: its cells (112 x 112 animal cards, 92 x 84 fish) in the box `view`
  function gridLayout() {
    const b = mbox(), pet = V.view !== 'fish', cw = pet ? 112 : 92, ch = pet ? 112 : 84, view = { x: b.x + 16, y: b.y + 84, w: b.w - 32 - 14, h: b.h - 84 - 58 };
    const p = V.m ? V.m.parts[V.pi] : null, items = !p ? [] : pet ? petList(p) : fishList(p), cols = Math.max(1, Math.floor(view.w / cw)), x0 = view.x + Math.floor((view.w - cols * cw) / 2) + 3;
    const total = Math.ceil(items.length / cols) * ch, max = Math.max(0, total - view.h);
    V.sc = clamp(V.sc, 0, max); V.hot = clamp(V.hot, 0, Math.max(0, items.length - 1));
    const rect = i => ({ x: x0 + (i % cols) * cw, y: view.y + 3 + Math.floor(i / cols) * ch - V.sc, w: cw - 6, h: ch - 6 });
    const at = () => (inRect(mouse, view) ? items.findIndex((e, i) => inRect(mouse, rect(i))) : -1);
    return { b, pet, p, items, view, cols, ch, max, rect, at, need: p ? p.n - prog(V.m, V.pi) : 0 };
  }
  const dlgBox = () => { const w = Math.min(480, W - 24); return { x: W / 2 - w / 2, y: H / 2 - 104, w, h: 208 }; };
  // the buttons of the view that is open: [{ id, r, txt, off, on, color, arg }]
  function buttons() {
    const out = [], addB = (id, r, txt, o) => out.push(Object.assign({ id, r, txt }, o));
    if (V.view === 'list') {
      const L = listLayout(), all = lines(L);
      all.forEach((q, i) => { if (!partDone(q.m, q.pi)) addB('turn', q.btn, 'Turn in', { arg: i, off: !eligible(q.p), on: i === V.cur && !TOUCH.on, size: 14, color: PAL.gold }); });
      addB('close', L.close, 'Close');
    } else if (V.view === 'fish' || V.view === 'pet') {
      const b = mbox(), fy = b.y + b.h - 46;
      if (V.view === 'fish') addB('give', { x: b.x + 16, y: fy, w: 150, h: 34 }, V.sel.length ? `Give ${V.sel.length}` : 'Give', { off: !V.sel.length, color: PAL.gold });
      addB('back', { x: b.x + b.w - 126, y: fy, w: 110, h: 34 }, 'Back');
    } else {
      const d = dlgBox(), sh = V.view === 'shiny', L = { x: W / 2 - 160, y: d.y + d.h - 52, w: 150, h: 36 }, R = { x: W / 2 + 10, y: d.y + d.h - 52, w: 150, h: 36 };   /* the second question has its Yes on the other side: a double click can't answer both */
      addB('yes', sh ? R : L, sh ? 'Yes, I am sure' : 'Yes, give', { color: '#ffab91' });
      addB('no', sh ? L : R, 'No');
    }
    return out;
  }
  const buttonAt = () => buttons().find(b => inRect(mouse, b.r));

  // ---------- what the buttons, cells and keys do ----------
  function openBoard() { V = newV(); if (prune()) save(); G.panel = 'mpmissions'; SFX.play('pick'); }
  function close() { V = newV(); if (G) G.panel = null; SFX.play('pick'); }
  function back() { if (V.view === 'confirm' || V.view === 'shiny') { V.view = 'pet'; V.pid = null; } else if (V.view === 'list') { close(); return; } else { const cur = V.cur; V = newV(); V.cur = cur; } SFX.play('pick'); }
  function turnIn(i) {
    const q = lines(listLayout())[i]; if (!q || partDone(q.m, q.pi)) return;
    V.cur = i;
    if (!eligible(q.p)) { showMsg(q.p.t === 'pet' ? 'You have no animal like that yet.' : q.p.t === 'dish' ? 'No dish in your Sanctuary Bag fits: cook fish at the stone oven in your Yard.' : 'No fish in your Fish Bag fits: catch some at the pond in your Yard.', 3); SFX.play('error'); return; }
    Object.assign(V, { view: q.p.t === 'pet' ? 'pet' : 'fish', m: q.m, pi: q.pi, sel: [], sc: 0, hot: 0, drag: null, pid: null }); SFX.play('pick');
  }
  function pickCell(i) {
    const L = gridLayout(), e = L.items[i]; if (!e) return;
    V.hot = i;
    if (L.pet) {
      const why = petLock(e);
      if (why) { showMsg(why === 'In your team' ? `${petName(e)} is in your team: take it out first.` : why === 'In the Den' ? `${petName(e)} is in the Breeding Den: take it out first.` : 'You can never give away your last animal.', 2.6); SFX.play('error'); return; }
      V.pid = e.pid; V.view = 'confirm'; SFX.play('pick');
    } else {
      const at = V.sel.indexOf(e.i);
      if (at >= 0) V.sel.splice(at, 1); else if (V.sel.length < L.need) V.sel.push(e.i); else { showMsg(`Only ${L.need} more ${L.need === 1 ? 'is' : 'are'} needed.`, 1.8); SFX.play('error'); return; }
      SFX.play('pick');
    }
  }
  function afterGive() { if (!V.m || !current(V.m) || partDone(V.m, V.pi)) { const cur = V.cur; V = newV(); V.cur = cur; } else { V.view = V.m.parts[V.pi].t === 'pet' ? 'pet' : 'fish'; V.sel = []; V.pid = null; } }
  function act(b) {
    if (!b) return;
    switch (b.id) {
      case 'close': close(); break;
      case 'back': case 'no': back(); break;
      case 'turn': turnIn(b.arg); break;
      case 'give': if (b.off) { SFX.play('error'); break; } if (!giveFish(V.m, V.pi, V.sel)) SFX.play('error'); afterGive(); break;
      case 'yes': {
        const it = HERD.find(h => h.pid === V.pid); if (!it) { back(); break; }
        if (V.view === 'confirm' && it.g && it.g.shiny) { V.view = 'shiny'; SFX.play('error'); break; }   /* a shiny: ask once more */
        if (!givePet(V.m, V.pi, V.pid)) SFX.play('error');
        afterGive(); break;
      }
    }
  }
  function click(btn) {
    V.drag = null;
    if (btn !== 0) { back(); return; }
    const b = buttonAt();
    if (b) { act(b); return; }
    if (V.view === 'confirm' || V.view === 'shiny') { if (!inRect(mouse, dlgBox())) back(); return; }
    const bx = mbox();
    if (!inRect(mouse, { x: bx.x, y: bx.y, w: bx.w, h: bx.h })) { close(); return; }
    if (V.view === 'fish' || V.view === 'pet') { const L = gridLayout(); if (inRect(mouse, L.view)) V.drag = { y0: mouse.y, s0: V.sc, moved: false, hit: L.at() }; }   /* a cell acts when the mouse comes up without having dragged the list */
  }
  function up(btn) {
    const d = V.drag; V.drag = null;
    if (!d || btn !== 0 || d.moved || Math.abs(mouse.y - d.y0) > 6 || (V.view !== 'fish' && V.view !== 'pet')) return;
    const i = gridLayout().at(); if (i >= 0 && i === d.hit) pickCell(i);
  }
  function wheel(d) { if ((V.view === 'fish' || V.view === 'pet') && Number.isFinite(d)) { V.sc += d; gridLayout(); } }
  function keysFn() {
    if (V.view === 'list') {
      const n = lines(listLayout()).length;
      if (hit('Escape', 'e')) close();
      else if (hit('ArrowDown', 's')) { V.cur = (V.cur + 1) % n; SFX.play('rotate'); }
      else if (hit('ArrowUp', 'w')) { V.cur = (V.cur + n - 1) % n; SFX.play('rotate'); }
      else if (hit('Enter', ' ')) turnIn(V.cur);
    } else if (V.view === 'confirm' || V.view === 'shiny') {
      if (hit('Escape', 'n')) back(); else if (hit('Enter', 'y')) act({ id: 'yes' });
    } else {
      const L = gridLayout(), n = L.items.length;
      if (hit('Escape')) { back(); return; }
      const mv = hit('ArrowRight', 'd') ? 1 : hit('ArrowLeft', 'a') ? -1 : hit('ArrowDown', 's') ? L.cols : hit('ArrowUp', 'w') ? -L.cols : 0;
      if (mv && n) { V.hot = clamp(V.hot + mv, 0, n - 1); const r = L.rect(V.hot); if (r.y < L.view.y) V.sc -= L.view.y - r.y + 3; else if (r.y + r.h > L.view.y + L.view.h) V.sc += r.y + r.h - L.view.y - L.view.h + 3; SFX.play('rotate'); }
      else if (hit('PageDown')) V.sc += L.view.h * 0.8; else if (hit('PageUp')) V.sc -= L.view.h * 0.8;
      else if (L.pet ? hit('Enter', ' ', 'e') : hit(' ', 'e')) pickCell(V.hot);
      else if (hit('Enter')) { if (V.sel.length) act(buttons().find(b => b.id === 'give')); else pickCell(V.hot); }
    }
  }

  // ---------- drawing ----------
  function drawButtons() { for (const b of buttons()) button(b.r, b.txt, { hover: !b.off && !V.drag && inRect(mouse, b.r), off: b.off, on: b.on, size: b.size || 15, color: b.color }); }
  function drawPurse(b) { const w = goldWidth(gold(), 15); drawGold(b.x + b.w - 20, b.y + 26, { align: 'right', size: 15, color: '#6b4a00' }); anchor = { x: b.x + b.w - 20 - w / 2, y: b.y + 56 }; }
  function drawList() {
    const L = listLayout(), b = L.b;
    panel(b.x, b.y, b.w, b.h, 'parch'); banner('Mission Board', W / 2, b.y + 4, { size: 30, h: 44, pad: b.port ? 60 : 100 }); drawPurse(b);
    for (const h of L.heads) { label(h.txt, b.x + 20, h.y, { size: 14, bold: true, color: PAL.parchInk }); label(h.left, b.x + b.w - 20, h.y, { align: 'right', size: 13, color: INK_SOFT }); }
    for (const r of L.rows) {
      const m = r.m, done = isDone(m);
      panel(r.x, r.y, r.w, r.h, 'dark');
      const gw = drawGold(r.x + r.w - 12, r.y + 15, { align: 'right', size: 14, n: m.reward, color: done ? PAL.dim : PAL.gold });
      if (done) label('✔ Done', r.x + r.w - 24 - gw, r.y + 15, { align: 'right', size: 13, bold: true, color: PAL.good });
      ctx.font = `bold 15px ${UI}`; label(fitText(m.title, r.w - 40 - gw - (done ? 70 : 0)), r.x + 12, r.y + 15, { size: 15, bold: true, color: done ? PAL.dim : PAL.gold });
      for (const q of r.parts) {
        const fin = partDone(m, q.pi), tw = r.w - 24 - 102 - 54, have = done ? q.p.n : prog(m, q.pi);
        ctx.font = `13px ${UI}`; const ls = wrapLines('Bring ' + partText(q.p), tw, 13).slice(0, 2); if (ls.length > 1) ls[1] = fitText(ls[1], tw);
        ls.forEach((l, i) => label(l, r.x + 12, q.y + 17 + (i - (ls.length - 1) / 2) * 16, { size: 13, color: fin ? ROW_DIM : PAL.cream }));
        label(`${have}/${q.p.n}`, q.btn.x - 10, q.y + 17, { align: 'right', size: 14, bold: true, color: fin ? PAL.good : have ? PAL.gold : ROW_DIM });
        if (fin) label('✔ delivered', q.btn.x + q.btn.w / 2, q.y + 17, { align: 'center', size: 13, bold: true, color: PAL.good });
      }
    }
    ctx.font = `12px ${UI}`; label(fitText(TOUCH.on ? 'What you turn in is gone for good. The same missions for everyone (UTC).' : 'What you turn in is gone for good  ·  ↑ ↓ and Enter, or click  ·  Esc: close', b.w - 170), b.x + 20, b.y + b.h - 28, { size: 12, color: INK_SOFT });
    drawButtons();
  }
  function drawBar(L) {
    if (L.max <= 0) return;
    const v = L.view, bar = { x: v.x + v.w + 5, y: v.y + 2, w: 8, h: v.h - 4 }, th = Math.max(28, bar.h * v.h / (v.h + L.max));
    ctx.fillStyle = 'rgba(12,7,4,0.7)'; rr(bar.x, bar.y, bar.w, bar.h, 4); ctx.fill();
    ctx.fillStyle = PAL.brass; rr(bar.x + 1, bar.y + 1 + (bar.h - th) * V.sc / L.max, bar.w - 2, th - 2, 3); ctx.fill();
  }
  function drawPicker() {
    if (V.drag) { if (Math.abs(mouse.y - V.drag.y0) > 6) V.drag.moved = true; if (V.drag.moved) V.sc = V.drag.s0 - (mouse.y - V.drag.y0); }
    const L = gridLayout(), b = L.b, v = L.view, p = L.p, n = L.items.length, over = V.drag && V.drag.moved ? -1 : L.at();
    panel(b.x, b.y, b.w, b.h, 'parch'); banner(L.pet ? 'Choose the animal' : p.t === 'dish' ? 'Choose the dishes' : 'Choose the fish', W / 2, b.y + 4, { size: 28, h: 44, pad: b.port ? 50 : 90 }); drawPurse(b);
    ctx.font = `bold 14px ${UI}`; label(fitText(`${V.m.title}: bring ${partText(p)}`, b.w - 40), b.x + 20, b.y + 50, { size: 14, bold: true, color: PAL.parchInk });
    ctx.font = `13px ${UI}`; label(fitText(L.pet ? `${prog(V.m, V.pi)} of ${p.n} delivered  ·  the animal you pick leaves your Sanctuary for good` : `${prog(V.m, V.pi)} of ${p.n} delivered  ·  pick up to ${L.need}, then Give (they are gone for good)`, b.w - 40), b.x + 20, b.y + 69, { size: 13, color: INK_SOFT });
    ctx.fillStyle = 'rgba(58,38,20,0.16)'; rr(v.x - 2, v.y - 2, v.w + 4, v.h + 4, 5); ctx.fill();
    if (!n) wrapLines(L.pet ? 'You have no animal like that any more.' : 'Nothing in the bag fits any more.', v.w - 40, 15, true).forEach((l, i) => label(l, v.x + v.w / 2, v.y + 60 + i * 22, { align: 'center', size: 15, bold: true, color: '#7a2e14' }));
    ctx.save(); ctx.beginPath(); ctx.rect(v.x, v.y, v.w, v.h); ctx.clip();
    try {
      L.items.forEach((e, i) => {
        const r = L.rect(i); if (r.y + r.h <= v.y || r.y >= v.y + v.h) return;
        const hot = i === over || (!TOUCH.on && i === V.hot);
        if (L.pet) {
          const why = petLock(e);
          drawPetCard(e, r, { sel: e.pid === V.pid, over: hot && !why, slot: true });
          if (why) { ctx.fillStyle = 'rgba(8,5,3,0.62)'; rr(r.x + 2, r.y + 2, r.w - 4, r.h - 4, 6); ctx.fill(); label(why, r.x + r.w / 2, r.y + r.h / 2 - 8, { align: 'center', size: 12, bold: true, color: '#ffb080' }); }
          else if (hot) { ctx.strokeStyle = PAL.cream; ctx.lineWidth = 1; rr(r.x + 2.5, r.y + 2.5, r.w - 5, r.h - 5, 6); ctx.stroke(); }
        } else {
          const it = e.it, sel = V.sel.includes(e.i), nm = it.def.dish ? dishName(it) : it.def.name;
          panel(r.x, r.y, r.w, r.h, 'dark');
          if (sel || hot) { ctx.strokeStyle = sel ? PAL.gold : 'rgba(243,227,195,0.6)'; ctx.lineWidth = sel ? 2 : 1; rr(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3, 4); ctx.stroke(); }
          if (sel) { ctx.fillStyle = 'rgba(255,211,107,0.14)'; rr(r.x + 3, r.y + 3, r.w - 6, r.h - 6, 4); ctx.fill(); }
          if (it.def.dish && typeof DISH_FILTER !== 'undefined') ctx.filter = DISH_FILTER[it.q == null ? 2 : it.q] || 'none';
          drawItem(Object.assign({}, it, { shape: [[1]] }), r.x + r.w / 2 - 20, r.y + 6, 40); ctx.filter = 'none';
          ctx.font = `11px ${UI}`; label(fitText(nm, r.w - 8), r.x + r.w / 2, r.y + r.h - 22, { align: 'center', size: 11, color: (RARITY[it.def.rarity] || {}).c || PAL.cream });
          label(sel ? '✔ picked' : cap(it.def.rarity), r.x + r.w / 2, r.y + r.h - 9, { align: 'center', size: 10, bold: sel, color: sel ? PAL.gold : ROW_DIM });
        }
      });
    } finally { ctx.restore(); ctx.filter = 'none'; }
    drawBar(L);
    ctx.font = `12px ${UI}`; const tip = L.pet ? (TOUCH.on ? 'Tap an animal · drag to scroll' : 'Click an animal, or arrows and Enter  ·  Esc: back') : TOUCH.on ? 'Tap to pick · drag to scroll' : 'Click to pick, or arrows and Space  ·  Enter: give  ·  Esc: back';
    label(fitText(tip, b.w - 170 - (L.pet ? 20 : 180)), b.x + (L.pet ? 20 : 180), b.y + b.h - 28, { size: 12, color: INK_SOFT });
  }
  function drawConfirm() {
    const it = HERD.find(h => h.pid === V.pid), d = dlgBox(), cx = W / 2; if (!it) { V.view = 'pet'; V.pid = null; return; }
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H);
    panel(d.x, d.y, d.w, d.h, 'leather');
    const g = it.g || {}, shiny = V.view === 'shiny';
    const title = shiny ? 'Give up a ★ shiny?' : `Give ${petTitle(it)} to the mission board for good?`;
    const tl = wrapLines(title, d.w - 50, 18, true).slice(0, 2); if (tl.length > 1) { ctx.font = `bold 18px ${UI}`; tl[1] = fitText(tl[1], d.w - 50); }
    tl.forEach((l, i) => label(l, cx, d.y + 34 + i * 24, { align: 'center', size: 18, bold: true, color: PAL.gold }));
    const y0 = d.y + 34 + tl.length * 24 + 4;
    const ls = shiny ? ['Shinies are very rare.', 'Are you really sure?'] : [`Lv ${petLvl(it)} ${sexSym(g)}  ·  ${gradeLine(g)}  ·  bond ${Math.round(g.bond || 0)}`, 'It leaves your Sanctuary. This can\'t be undone.'].concat(g.shiny ? ['(it is a ★ shiny)'] : []);
    ctx.font = `13px ${UI}`; ls.forEach((l, i) => label(fitText(l, d.w - 40), cx, y0 + i * 18, { align: 'center', size: 13, color: l.startsWith('(') ? PAL.gold : PAL.cream }));
  }
  function draw() {
    if (!G) return;
    if (V.m && !current(V.m)) { V = newV(); showMsg('The board has changed: new missions are up.', 2.6); }   /* midnight passed while a picker was open */
    ctx.fillStyle = 'rgba(8,5,3,0.55)'; ctx.fillRect(0, 0, W, H);
    if (V.view === 'list') { drawList(); return; }
    drawPicker();
    if (V.view === 'confirm' || V.view === 'shiny') drawConfirm();
    drawButtons();
  }
  MP.stations.mp_missions = openBoard;
  MP.panels.mpmissions = { draw, click, keys: keysFn, wheel, up };
  Object.assign(E, { board, missions: () => board().list });

  Object.assign(E, { load, save, gold, add, spend, owns, grant, drawGold, coin, hud, payout, fmt });
  E._ = { clean, plain, toasts, hudRect: () => hudRect, goldWidth, KEY, V: () => V, daily, weekly, pool, partText, prog, isDone, partDone, fishOk, petOk, petLock, fishList, petList, giveFish, givePet, buttons, listLayout, gridLayout,
          dlgBox, mbox, lines, pickCell, turnIn, timeLeft, msLeft, dayNum, weekOf, SPECIAL, BOUNDS: { DAILY_SUM, DAILY_LO, DAILY_HI, WEEKLY_LO, WEEKLY_HI } };
  load();
  MP.hudDraw.push(drawToasts);
})();
