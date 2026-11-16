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
    if (isObj(raw.own)) { let n = 0; for (const k of Object.keys(raw.own)) { if (n >= OWN_MAX) break; if (ID_RX.test(k) && raw.own[k]) { d.own[k] = 1; n++; } } }
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
    if (typeof id !== 'string' || !ID_RX.test(id)) return false;
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

  Object.assign(E, { load, save, gold, add, spend, owns, grant, drawGold, coin, hud, payout, fmt });
  E._ = { clean, plain, toasts, hudRect: () => hudRect, goldWidth, KEY };
  load();
  MP.hudDraw.push(drawToasts);
})();
