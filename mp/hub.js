// =====================================================================
//  THE KINGDOM STREET (MP.hub) — a Sanctuary room shared with other players
//  You walk in from the Yard (the signpost) and join a hub room of up to 20 players (MP.net.room, prefix 'bps-hub-').
//  Everyone sees everyone else's hero live, can chat (a filtered, rate-limited text line with speech bubbles), and
//  forms groups of 2-4 at the Dungeon board and the Raid board; the leader's Go hands the group over to MP.coop.
//  The mission board, the auction house and the cosmetics shop only say "coming soon".
//
//  index.html calls in through small hooks marked "// MP:" (stations, interact, keys, clicks, typing, drawing).
//  Everything that arrives from the network is cleaned before use (cleanPres, cleanPt, cleanInfo, cleanText) and
//  text is only ever drawn on the canvas.
//
//  Presence in the room: { name, cls, look, lv, pt, pj }  (pt = the group I lead: { kind, tier, m: [uids], r: [ready uids], go })
//  Fast state: { x, y, vx, vy, f, g }.   Messages: 'chat' { s } · to a group's leader: 'p.join', 'p.leave', 'p.ready' { on }
//  · from the leader: 'p.ok', 'p.no' { why }, 'p.end', 'p.go' { info }.
// =====================================================================
(() => {
  const HUB = MP.hub = { room: null, party: null, debugSolo: /[?&]mpsolo=1(&|$)/.test((window.location && location.search) || '') };

  // ---------- the street: where everything stands (tile x) ----------
  const PLACES = [
    { kind: 'mp_sign', t: 7.5, r: 34, name: 'Notice post' },
    { kind: 'mp_missions', t: 14, r: 44, name: 'Mission Board', label: 'Read the mission board' },
    { kind: 'mp_auction', t: 24.5, r: 60, name: 'Auction House', label: 'Visit the auction house' },
    { kind: 'mp_shop', t: 36.5, r: 60, name: 'Cosmetics Shop', label: 'Visit the cosmetics shop' },
    { kind: 'mp_dungeon', t: 48.5, r: 60, name: 'Dungeons', label: 'The Dungeon board: form a group' },
    { kind: 'mp_raid', t: 60.5, r: 60, name: 'Raids', label: 'The Raid board: form a group' },
  ];
  const SOON = {
    mp_missions: ['Mission Board', 'Daily and weekly missions for you and your animals will be posted here.'],
    mp_auction: ['Auction House', 'Trade animals, eggs and treasures with players from every street.'],
    mp_shop: ['Cosmetics Shop', 'The tailor is still stocking the shelves: outfits, capes and hats for your hero will be sold here. Nothing is for sale yet.'],
  };
  // the four acts as tiers (MP.battle.TIERS when the battle module is there)
  const TIERS_LOCAL = [null, { name: 'Act I · The Dungeon', lo: 3, hi: 12, boss: 'shadow' }, { name: 'Act II · The Burning Depths', lo: 12, hi: 22, boss: 'elder' },
                       { name: 'Act III · The Fey Wilds', lo: 22, hi: 30, boss: 'wyrm' }, { name: 'Act IV · The Drowned Deep', lo: 30, hi: 0, boss: 'rune' }];
  const BOSS_NAMES = { shadow: 'The Shadow Wolf', elder: 'The Elder Dragon', wyrm: 'The Lake Wyrm', rune: 'The Runeshell Leviathan' };
  const BOSS_ORDER = [null, 'shadow', 'elder', 'wyrm', 'rune'];
  function tierOf(t) {
    const L = TIERS_LOCAL[t] || TIERS_LOCAL[1], B = MP.battle && Array.isArray(MP.battle.TIERS) && MP.battle.TIERS[t];
    const bn = B && typeof B.name === 'string' && B.name ? B.name.slice(0, 40) : '', name = !bn ? L.name : /^Act /.test(bn) ? bn : L.name.split(' · ')[0] + ' · ' + bn, lo = B && B.lo > 0 ? B.lo | 0 : L.lo, hi = B && B.hi > 0 ? B.hi | 0 : L.hi;
    const boss = BOSS_NAMES[B && B.boss] || BOSS_NAMES[BOSS_ORDER[t]] || BOSS_NAMES.shadow;
    return { name, lo, hi, boss, lv: t >= 4 || !hi || hi <= lo ? `${lo}+` : `${lo}-${hi}` };
  }
  const tierTitle = (kind, t) => (kind === 'raid' ? tierOf(t).boss : tierOf(t).name);

  // ---------- chat rules ----------
  const CHAT_MAX = 120, CHAT_GAP = 1000, CHAT_BURST = 5, CHAT_WINDOW = 10000, CHAT_SHOW = 6, BUBBLE_T = 5;
  // The word filter: one list, easy to edit. A word ending in * is also caught inside longer words; the others only
  // as whole words. Matching ignores case, repeated letters (fuuuck), simple swaps (1 ! @ 4 3 0 $ 5 7) and full-width
  // letters. "Whole word" looks at Latin letters (accents included) and digits on both sides, so a word of another
  // language that merely contains one (fagócito) is left alone; text in other scripts never matches at all.
  const BAD_WORDS = ['fuck*', 'motherfuck*', 'shit*', 'bitch*', 'cunt*', 'asshole*', 'arsehole*', 'bastard*', 'dickhead*', 'whore*', 'slut*', 'wanker*', 'bollocks*',
                     'nigger*', 'nigga*', 'faggot*', 'retard*', 'dick', 'cock', 'ass', 'arse', 'fag', 'piss', 'twat', 'wank', 'prick', 'pussy', 'rape', 'rapist',
                     'kike', 'spic', 'chink', 'tranny', 'dyke', 'coon'];
  const LEET = { 1: 'i', '!': 'i', '|': 'i', '@': 'a', 4: 'a', 3: 'e', 0: 'o', $: 's', 5: 's', 7: 't' };
  const BAD_RX = BAD_WORDS.map(w => { const inside = w.endsWith('*'), core = inside ? w.slice(0, -1) : w; return { inside, rx: new RegExp(core.split('').map(c => c + '+').join(''), 'g') }; });
  function censor(s) {
    s = String(s); let norm = '';
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i), raw = code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : s[i];   /* (full-width forms: ｆ -> f) */
      let c = raw.toLowerCase(); if (c.length !== 1) c = raw; norm += LEET[c] || c;
    }
    const out = s.split(''), solid = c => /[a-z0-9@$À-ɏ]/i.test(c || '');
    for (const { inside, rx } of BAD_RX) {
      rx.lastIndex = 0; let m;
      while ((m = rx.exec(norm))) {
        const a = m.index, b = a + m[0].length;
        if (inside || ((a === 0 || !solid(s[a - 1])) && (b >= s.length || !solid(s[b])))) for (let i = a; i < b; i++) out[i] = '*';
        if (!m[0].length) rx.lastIndex++;
      }
    }
    return out.join('');
  }
  // text is counted and cut by whole characters (code points), never through the middle of a surrogate pair; a lone
  // half of a pair is dropped
  const chars = s => Array.from(String(s)).filter(c => !(c.length === 1 && c >= '\ud800' && c <= '\udfff'));
  const charLen = s => chars(s).length;
  const clipChars = (s, n) => chars(s).slice(0, n).join('');
  // one chat line: no control characters, no invisible ones (removed, so they can't split a filtered word), single
  // spaces, at most CHAT_MAX characters. The zero-width joiners stay where a script or an emoji needs them (between
  // two non-Latin characters).
  function cleanText(s) {
    s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202f]/g, ' ')
      .replace(/[\u200c\u200d]/g, (c, i, all) => (i > 0 && all.charCodeAt(i - 1) > 0x2ff && all.charCodeAt(i + 1) > 0x2ff ? c : ''))
      .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    return clipChars(s, CHAT_MAX).trim();
  }
  // the line while it is being typed: control characters (a pasted line break) become spaces, at most CHAT_MAX characters
  const liveText = v => clipChars(String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' '), CHAT_MAX);
  const UID_RX = /^[a-z0-9]{1,16}$/;
  const isUid = v => typeof v === 'string' && UID_RX.test(v);
  const now = () => performance.now();

  // ---------- state ----------
  const S = {
    others: new Map(),      /* uid -> the other players, cleaned (see newOther) */
    chat: [], chatT: 99,    /* the chat log and how long it has been quiet */
    sent: [], heard: new Map(),   /* my send times; per sender, the times I accepted a line from them */
    bubble: null,           /* my own speech bubble */
    mute: new Set(), hide: new Set(), names: null,   /* muted / hidden for this session (uids) and remembered (names) */
    joinedFor: null, err: '', retryT: 0, wasOpen: false, openAt: 0, graceT: 0, connT: 0, presT: 0, presSent: '',
    goInfo: null, goT: 0, missT: 0, btns: [], soon: null, board: null,
    sc: { players: 0, board: 0 }, drag: null,   /* how far each list is scrolled (px); the scrollbar or list being dragged */
    inMine: false, inPlaced: false, comp: false,   /* the text field: the chat has it; it lies over the chat line; an IME composition is going on */
    trip: null,             /* the co-op outing I left the street for: { kind, tier, rec } (see tripLine) */
  };
  const inStreet = () => !!(G && G.hub && G.hubRoom === 'street' && G.room && G.room.hubRoom === 'street');
  const isOpen = () => !!(HUB.room && HUB.room.state === 'open');
  const me = () => (HUB.room && HUB.room.me) || (MP.net && MP.net.uid) || 'me';
  const myLv = () => Math.max(0, ...petSlots.filter(Boolean).map(petLvl));
  const hasTeam = () => petSlots.some(Boolean);
  const coopBusy = () => !!(MP.coop && MP.coop.active);
  function toast(t, dur = 2.6, bad) { if (G) showMsg(t, dur); if (bad) SFX.play('error'); }

  // ---------- muting (this session by uid, and by name remembered on this computer) ----------
  function muteNames() {
    if (S.names) return S.names;
    let d = null; try { d = JSON.parse(localStorage.getItem(sk('packrat_mpmute')) || 'null'); } catch (e) {}
    const list = a => (Array.isArray(a) ? a.filter(n => typeof n === 'string').map(n => n.slice(0, 14)).slice(0, 200) : []);
    return (S.names = { m: list(d && d.m), h: list(d && d.h) });
  }
  function saveMutes() { try { localStorage.setItem(sk('packrat_mpmute'), JSON.stringify(muteNames())); } catch (e) {} }
  const isHidden = o => S.hide.has(o.id) || muteNames().h.includes(o.name);
  const isMuted = o => S.mute.has(o.id) || muteNames().m.includes(o.name) || isHidden(o);
  function setMute(id, kind, on) {   /* kind: 'm' mute (chat and bubbles) | 'h' hide (the hero too) */
    const o = S.others.get(id); if (!o) return;
    const set = kind === 'h' ? S.hide : S.mute, N = muteNames(), list = N[kind];
    if (on) { set.add(id); if (!list.includes(o.name)) list.push(o.name); if (list.length > 200) list.shift(); }
    else { set.delete(id); N[kind] = list.filter(n => n !== o.name); }
    if (on) o.bubble = null;
    saveMutes();
  }

  // ---------- the others ----------
  function newOther(id) { return { id, name: 'Player', cls: 'warrior', look: null, lv: 0, pt: null, pj: null, pRaw: undefined, x: 0, y: 0, tx: 0, ty: 0, vx: 0, vy: 0, f: 1, g: true, has: false, sheet: null, sheetT: 0, bubble: null }; }
  // a group advert from its leader's presence
  function cleanPt(pt, leader) {
    if (!pt || typeof pt !== 'object' || (pt.kind !== 'dungeon' && pt.kind !== 'raid')) return null;
    const m = [leader];
    if (Array.isArray(pt.m)) for (const id of pt.m.slice(0, 8)) if (isUid(id) && !m.includes(id) && m.length < 4) m.push(id);
    const r = Array.isArray(pt.r) ? pt.r.slice(0, 8).filter(id => m.includes(id) && id !== leader) : [];
    return { kind: pt.kind, tier: clamp(pt.tier | 0, 1, 4), m, r: [...new Set(r)], go: !!pt.go };
  }
  function cleanPres(o, p) {
    const c = netCleanProfile(p); p = p && typeof p === 'object' ? p : {};
    o.name = censor(c.name).replace(/^\*+$/, 'Player'); o.cls = c.cls; o.look = c.look; o.lv = clamp(p.lv | 0, 0, 999);
    o.pt = cleanPt(p.pt, o.id); o.pj = isUid(p.pj) ? p.pj : null; o.sheet = null; o.sheetT = 0;
  }
  function myPresence() {
    const p = netProfile(), P = HUB.party, mine = P && P.mine;
    return { name: p.name, cls: p.cls, look: p.look, lv: myLv(), pt: mine ? { kind: P.kind, tier: P.tier, m: P.m.slice(), r: P.r.slice(), go: P.go ? 1 : 0 } : null, pj: P && !P.mine && !P.pend ? P.leader : null };
  }
  function pushPresence() {
    if (!HUB.room) return; const p = myPresence(), js = JSON.stringify(p);
    if (js === S.presSent) return; S.presSent = js; S.presT = 1;
    try { HUB.room.setPresence(p); } catch (e) { console.error(e); }
  }
  const nameOf = id => (id === me() ? myName() : (S.others.get(id) || {}).name || 'Player');
  function infoOf(id) { if (id === me()) return { name: myName(), cls: G.cls, lv: myLv() }; const o = S.others.get(id); return o ? { name: o.name, cls: o.cls, lv: o.lv } : { name: 'Player', cls: 'warrior', lv: 0 }; }

  // ---------- joining and leaving the street's room ----------
  function enter(retry) {
    if (HUB.room) return;
    S.joinedFor = G && G.room; S.retryT = 0; S.wasOpen = false; if (!retry) S.err = ''; S.connT = 0; S.presT = 1;
    if (!MP.net) { S.err = 'nonet'; return; }
    try {
      const pres = myPresence(); S.presSent = JSON.stringify(pres);
      const room = MP.net.room({ prefix: 'bps-hub-', cap: 20, presence: pres, on: ev => { if (HUB.room === room) try { onEvent(ev); } catch (e) { console.error(e); } } });
      HUB.room = room; room.join();
    } catch (e) { console.error(e); HUB.room = null; S.err = 'error'; S.retryT = 6; }
  }
  function clearSession() {
    S.others.clear(); S.heard.clear(); S.goInfo = null; S.goT = 0; S.missT = 0; S.bubble = null; HUB.party = null; S.drag = null;
    closeChat();
  }
  // leaving on purpose (a door, a run, the title screen, a co-op start, the page closing)
  function leave() {
    const room = HUB.room; HUB.room = null; clearSession(); S.retryT = 0; S.err = '';
    if (G && (G.panel === 'mpboard' || G.panel === 'mpplayers' || G.panel === 'mpfriend')) G.panel = null;
    if (room) try { room.leave(); } catch (e) { console.error(e); }
  }
  // the connection broke: stay in the street, try again in a few seconds
  function drop(why) {
    const room = HUB.room, had = !!HUB.party; HUB.room = null; clearSession();
    if (room) try { room.leave(); } catch (e) {}
    S.err = String(why || 'lost').slice(0, 60); S.retryT = 6;
    if (S.wasOpen) sys('The connection to the street was lost. Trying again...');
    if (had) toast('The connection was lost: your group is gone.', 3);
    S.wasOpen = false;
  }
  function canEnter() {
    if (G && (G.visit || NET.visit || NET.visitor)) { toast('The Kingdom Street has to wait: finish the Yard visit with your friend first.', 3, true); return false; }
    return true;
  }
  // the message bar's line on arriving in the street (from enterHub)
  const welcome = () => (TOUCH.on ? 'Kingdom Street — form a group at the boards · tap Chat to talk' : 'Kingdom Street — E at the boards to form a group · Enter to chat');
  HUB.enter = enter; HUB.leave = leave; HUB.canEnter = canEnter; HUB.welcome = welcome;
  if (window.addEventListener) window.addEventListener('pagehide', () => { if (HUB.room) { leave(); S.joinedFor = null; } });

  // ---------- events from the room ----------
  function onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    const room = HUB.room;
    switch (ev.type) {
      case 'join': {
        if (ev.id === room.me || !isUid(ev.id)) break;
        const fresh = !S.others.has(ev.id); syncOthers();
        const o = S.others.get(ev.id);
        if (o && fresh && S.wasOpen && now() - S.openAt > 1500 && S.graceT <= 0 && !isHidden(o)) sys(`${o.name} joined`);
        break;
      }
      case 'leave': {
        const o = S.others.get(ev.id); if (!o) break;
        if (!isHidden(o)) sys(`${o.name} left`);
        S.others.delete(ev.id); S.heard.delete(ev.id); memberGone(ev.id);
        break;
      }
      case 'presence': { const o = S.others.get(ev.id); if (o) o.pRaw = undefined; syncOthers(); break; }
      case 'host': S.graceT = 3; if (ev.id === room.me) sys('You are now the host of this street'); break;
      case 'closed': if (HUB.room) drop(ev.why || 'closed'); break;
      case 'msg': if (isUid(ev.from) && ev.from !== room.me && ev.msg && typeof ev.msg === 'object' && typeof ev.msg.t === 'string') onMsg(ev.msg, ev.from); break;
    }
  }
  function onMsg(m, from) {
    const o = S.others.get(from) || (syncOthers(), S.others.get(from)); if (!o) return;
    if (m.t === 'chat') return heardChat(o, m.s);
    const P = HUB.party, room = HUB.room, answer = (t, extra) => { try { room.send(Object.assign({ t }, extra), from); } catch (e) {} };
    switch (m.t) {
      // ---- I lead a group ----
      case 'p.join':
        if (!P || !P.mine) return answer('p.no', { why: 'gone' });
        if (P.m.includes(from)) return answer('p.ok');
        if (P.go) return answer('p.no', { why: 'started' });
        if (P.m.length >= 4) return answer('p.no', { why: 'full' });
        if (o.pt) return answer('p.no', { why: 'busy' });
        P.m.push(from); pushPresence(); answer('p.ok'); sys(`${o.name} joined your group`); SFX.play('pick');
        return;
      case 'p.leave':
        if (P && P.mine && P.m.includes(from) && !P.go) { P.m = P.m.filter(id => id !== from); P.r = P.r.filter(id => id !== from); pushPresence(); sys(`${o.name} left your group`); }
        return;
      case 'p.ready':
        if (P && P.mine && P.m.includes(from) && !P.go) { P.r = P.r.filter(id => id !== from); if (m.on) P.r.push(from); pushPresence(); }
        return;
      // ---- I joined (or asked to join) a group ----
      case 'p.ok':
        if (P && !P.mine && P.pend && P.leader === from) { P.pend = false; S.missT = 0; pushPresence(); SFX.play('pick'); }
        return;
      case 'p.no':
        if (P && !P.mine && P.leader === from) {
          HUB.party = null; pushPresence();
          toast({ full: 'That group is already full.', started: 'That group has already set off.', busy: 'You already lead a group of your own.' }[m.why] || 'That group is gone.', 2.6, true);
        }
        return;
      case 'p.end':
        if (P && !P.mine && P.leader === from) { HUB.party = null; pushPresence(); toast(`${o.name} closed the group.`, 2.6); }
        return;
      case 'p.go': {
        if (!P || P.mine || P.pend || P.leader !== from) return;
        const info = cleanInfo(m.info, from);
        if (!info || info.kind !== P.kind) return;
        if (!inStreet() || G.mode === 'battle') { answer('p.leave'); HUB.party = null; pushPresence(); return; }
        start(info);
        return;
      }
    }
  }
  // the leader's "go": every field checked before it reaches MP.coop
  function cleanInfo(info, from) {
    if (!info || typeof info !== 'object' || info.leader !== from) return null;
    if (typeof info.code !== 'string' || info.code.length !== 5 || [...info.code].some(c => !CODE_CHARS.includes(c))) return null;
    if (info.kind !== 'dungeon' && info.kind !== 'raid') return null;
    if (!Number.isInteger(info.tier) || info.tier < 1 || info.tier > 4 || !Number.isInteger(info.seed) || info.seed < 0 || info.seed > 0x7fffffff) return null;
    if (!Array.isArray(info.members) || info.members.length < 1 || info.members.length > 4) return null;
    const members = [];
    for (const m of info.members) {
      if (!m || typeof m !== 'object' || !isUid(m.id) || members.some(x => x.id === m.id)) return null;
      members.push({ id: m.id, name: censor(String(m.name || 'Player').replace(/[\u0000-\u001f]/g, '').slice(0, 14)) || 'Player' });
    }
    if (members[0].id !== from || !members.some(m => m.id === me())) return null;
    return { code: info.code, kind: info.kind, tier: info.tier, seed: info.seed, leader: from, members };
  }
  function start(info) {
    if (!MP.coop) { toast('Co-op is not available in this copy of the game.', 3, true); if (HUB.party && !HUB.party.mine && HUB.room) { try { HUB.room.send({ t: 'p.leave' }, HUB.party.leader); } catch (e) {} } HUB.party = null; pushPresence(); return; }
    if (myPanel()) G.panel = null;
    closeChat();
    S.trip = { kind: info.kind, tier: info.tier, rec: recNow() };
    try { MP.coop.start(info); } catch (e) { console.error(e); }
    if (HUB.room && HUB.party) { HUB.party = null; pushPresence(); }   /* (the co-op module normally leaves the street itself) */
  }

  // ---------- back from a co-op outing: one line in the chat about how it went ----------
  // (read from the records the co-op modules keep: battles won and lost, dungeons and raids finished)
  const REC_KEYS = ['coopW', 'coopL', 'coopDungeons', 'coopRaids'];
  function recNow() { const r = (typeof SAVE === 'object' && SAVE && SAVE.rec) || {}, o = {}; for (const k of REC_KEYS) o[k] = Math.max(0, r[k] | 0); return o; }
  function tripLine(T) {
    const n = recNow(), d = k => Math.max(0, n[k] - (T.rec[k] | 0)), w = d('coopW'), l = d('coopL'), raid = T.kind === 'raid', done = d(raid ? 'coopRaids' : 'coopDungeons') > 0;
    const fights = w + l ? ` (${w} battle${w === 1 ? '' : 's'} won${l ? `, ${l} lost` : ''})` : '';
    if (done) return raid ? `Back from the raid: ${tierOf(T.tier).boss} is defeated!${fights}` : `Back from the dungeon: ${tierOf(T.tier).name} cleared!${fights}`;
    return w + l ? `Back from the ${raid ? 'raid' : 'dungeon'}: not finished this time${fights}` : '';
  }

  // ---------- groups (the boards) ----------
  // every open group of one kind in this street, mine first
  function groups(kind) {
    const out = [], P = HUB.party;
    if (P && P.mine && P.kind === kind) out.push({ leader: me(), pt: P });
    for (const o of S.others.values()) if (o.pt && o.pt.kind === kind && !isHidden(o)) out.push({ leader: o.id, pt: o.pt });
    return out;
  }
  function needRoom() { if (isOpen()) return true; toast('You need to be connected to the Kingdom Street to form a group.', 2.6, true); return false; }
  function needTeam() { if (hasTeam()) return true; toast('Put at least one animal in your team first (the post by the gate in your Yard).', 3, true); return false; }
  function openGroup(kind, tier) {
    if (HUB.party) { toast('You are already in a group.', 2, true); return false; }
    if (!needRoom() || !needTeam()) return false;
    HUB.party = { leader: me(), mine: true, kind: kind === 'raid' ? 'raid' : 'dungeon', tier: clamp(tier | 0, 1, 4), m: [me()], r: [], go: false };
    pushPresence(); SFX.play('pick'); return true;
  }
  function joinGroup(leader) {
    if (HUB.party) { toast('Leave your group first.', 2, true); return false; }
    if (!needRoom() || !needTeam()) return false;
    const o = S.others.get(leader); if (!o || !o.pt) { toast('That group is gone.', 2, true); return false; }
    if (o.pt.go) { toast('That group has already set off.', 2, true); return false; }
    if (o.pt.m.length >= 4) { toast('That group is already full.', 2, true); return false; }
    HUB.party = { leader, mine: false, pend: true, pendT: 6, kind: o.pt.kind, tier: o.pt.tier, m: o.pt.m.slice(), r: o.pt.r.slice(), go: false, want: false };
    HUB.room.send({ t: 'p.join' }, leader); return true;
  }
  function leaveGroup() {
    const P = HUB.party; if (!P) return;
    if (HUB.room) try { if (P.mine) { for (const id of P.m) if (id !== me()) HUB.room.send({ t: 'p.end' }, id); } else HUB.room.send({ t: 'p.leave' }, P.leader); } catch (e) {}
    HUB.party = null; S.goInfo = null; pushPresence(); SFX.play('pick');
  }
  function setReady(on) {
    const P = HUB.party; if (!P || P.mine || P.pend || !HUB.room) return;
    P.want = !!on; P.wantT = 2; HUB.room.send({ t: 'p.ready', on: on ? 1 : 0 }, P.leader); SFX.play('pick');
  }
  const amReady = () => { const P = HUB.party; return !!P && (P.mine || (P.wantT > 0 ? P.want : P.r.includes(me()))); };
  function setTier(t) { const P = HUB.party; if (!P || !P.mine || P.go) return; P.tier = clamp(t | 0, 1, 4); P.r = []; pushPresence(); SFX.play('pick'); }
  function canGo() { const P = HUB.party; return !!P && P.mine && !P.go && P.m.length >= (HUB.debugSolo ? 1 : 2) && P.m.length <= 4 && P.m.every(id => id === me() || P.r.includes(id)); }
  function go() {
    const P = HUB.party; if (!P || !P.mine || P.go) return false;
    if (P.m.length < (HUB.debugSolo ? 1 : 2)) { toast('A group needs at least 2 players.', 2.4, true); return false; }
    if (!canGo()) { toast('Everyone has to be ready first.', 2.4, true); return false; }
    if (!MP.coop) { toast('Co-op is not available in this copy of the game.', 3, true); return false; }
    const code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(NATIVE_RANDOM() * CODE_CHARS.length)]).join('');
    const info = { code, kind: P.kind, tier: P.tier, seed: Math.floor(NATIVE_RANDOM() * 0x7fffffff), leader: me(), members: P.m.map(id => ({ id, name: nameOf(id) })) };
    P.go = true; pushPresence();
    for (const id of P.m) if (id !== me()) try { HUB.room.send({ t: 'p.go', info }, id); } catch (e) { console.error(e); }
    S.goInfo = info; S.goT = 0.3;   /* (a moment for the message to leave before I leave the street myself) */
    return true;
  }
  // someone left the street: out of my group; my leader leaving ends the group
  function memberGone(id) {
    const P = HUB.party; if (!P) return;
    if (P.mine) { if (P.m.includes(id) && !P.go) { P.m = P.m.filter(x => x !== id); P.r = P.r.filter(x => x !== id); pushPresence(); } }
    else if (P.leader === id) { HUB.party = null; pushPresence(); toast('The leader left the street: the group is closed.', 3); }
  }
  function partyTick(dt) {
    const P = HUB.party; if (!P) return;
    if (S.goInfo) { S.goT -= dt; if (S.goT <= 0) { const info = S.goInfo; S.goInfo = null; start(info); } return; }
    if (!isOpen() || S.graceT > 0) return;
    if (P.mine) { for (const id of P.m.slice()) if (id !== me() && !S.others.has(id)) memberGone(id); return; }
    if (P.wantT > 0) P.wantT -= dt;
    const o = S.others.get(P.leader);
    if (!o) return memberGone(P.leader);
    if (P.pend) { P.pendT -= dt; if (P.pendT <= 0) { HUB.party = null; toast("The group's leader didn't answer.", 2.6, true); } return; }
    if (o.pt && o.pt.m.includes(me())) { S.missT = 0; P.kind = o.pt.kind; P.tier = o.pt.tier; P.m = o.pt.m.slice(); P.r = o.pt.r.slice(); P.go = o.pt.go; if (P.wantT > 0 && P.r.includes(me()) === P.want) P.wantT = 0; }
    else { S.missT += dt; if (S.missT > 3) { HUB.party = null; S.missT = 0; pushPresence(); toast('You are no longer in that group.', 2.6); } }
  }
  Object.assign(HUB, { openGroup, joinGroup, leaveGroup, setReady, setTier, go, groups });

  // ---------- chat ----------
  function addLine(e) { e.at = now(); S.chat.push(e); if (S.chat.length > 60) S.chat.shift(); S.chatT = 0; }
  function sys(s) { addLine({ sys: true, s }); }
  function bubbleOf(s) {
    const all = wrapLines(s, 150, 12, true), lines = all.slice(0, 3);
    if (all.length > 3) lines[2] = lines[2].slice(0, Math.max(1, lines[2].length - 1)) + '…';
    return { lines: lines.map(l => (l.length > 40 ? l.slice(0, 39) + '…' : l)), t: BUBBLE_T };
  }
  function heardChat(o, raw) {
    if (typeof raw !== 'string' || raw.length > CHAT_MAX * 2 || charLen(raw) > CHAT_MAX) return;   /* over-long lines are dropped, not trimmed (counted in characters, like the sender does) */
    const s = censor(cleanText(raw)); if (!s) return;
    const t = now(), list = (S.heard.get(o.id) || []).filter(x => t - x < CHAT_WINDOW);
    if ((list.length && t - list[list.length - 1] < CHAT_GAP * 0.7) || list.length >= CHAT_BURST + 1) { S.heard.set(o.id, list); return; }   /* a little slack for network jitter */
    list.push(t); S.heard.set(o.id, list);
    if (isMuted(o)) return;
    addLine({ id: o.id, name: o.name, s }); o.bubble = bubbleOf(s);
  }
  // send what was typed; false = not sent (too fast, or nobody to hear it)
  function say(text) {
    const s = censor(cleanText(text)); if (!s) return true;
    const t = now(); S.sent = S.sent.filter(x => t - x < CHAT_WINDOW);
    if ((S.sent.length && t - S.sent[S.sent.length - 1] < CHAT_GAP) || S.sent.length >= CHAT_BURST) { sys("You're chatting too fast: wait a moment."); SFX.play('error'); return false; }
    if (!isOpen()) { sys("You're not connected: nobody can hear you."); SFX.play('error'); return false; }
    S.sent.push(t);
    try { HUB.room.send({ t: 'chat', s }); } catch (e) { console.error(e); }
    addLine({ id: me(), mine: true, name: myName(), s }); S.bubble = bubbleOf(s);
    return true;
  }
  // ---------- typing the chat line ----------
  // The line is typed into a real text field (the page's hidden #ttype, the one phones already type names with), so
  // the system's own text input works: IME composition (Japanese, Chinese, Korean), dead keys (accents), emoji
  // pickers, paste, the caret keys and selections. The field itself is never visible: on a computer it is laid over
  // the chat line (so an IME's candidate window opens there) fully transparent, and NET.buf, a cleaned copy of its
  // value, is what the canvas draws. index.html's own handlers on #ttype step aside while NET.typing === 'chat' and the
  // listeners below take over; while the field has the focus no key reaches the game's key handler at all, and without
  // it (the focus was lost) the keys still come here through netType -> type(), so hotkeys stay blocked either way.
  const chatInput = () => { try { return document.getElementById('ttype') || null; } catch (e) { return null; } };
  const inputHasFocus = inp => { try { return !!inp && document.activeElement === inp; } catch (e) { return false; } };
  // lay the field over the chat line (computers only: on a phone it stays off-screen so the page never scrolls or zooms to it)
  function placeInput(inp, on) {
    try {
      const st = inp.style; if (!st) return;
      if (!on || TOUCH.on) { if (S.inPlaced) { st.left = '-1000px'; st.top = '0'; st.width = '10px'; st.height = '10px'; st.pointerEvents = ''; S.inPlaced = false; } return; }
      const r = cv.getBoundingClientRect(), C = chatRects(), kx = r.width / VIEW.w, ky = r.height / VIEW.h;
      st.left = Math.round(r.left + C.row.x * kx) + 'px'; st.top = Math.round(r.top + C.row.y * ky) + 'px';
      st.width = Math.max(10, Math.round((C.row.w - 66) * kx)) + 'px'; st.height = Math.max(10, Math.round(C.row.h * ky)) + 'px';
      st.pointerEvents = 'none'; st.fontSize = '16px'; S.inPlaced = true;
    } catch (e) {}
  }
  function focusInput() {
    const inp = chatInput(); if (!inp) return;
    if (inp.value !== NET.buf) inp.value = NET.buf;
    placeInput(inp, true); S.inMine = true;
    try { inp.focus(); } catch (e) {}
  }
  // give the keyboard back to the game (a focused field would swallow every key)
  function releaseInput() {
    const inp = chatInput(); S.inMine = false; S.comp = false; if (!inp) return;
    inp.value = ''; placeInput(inp, false);
    try { if (!TOUCH.on || inputHasFocus(inp)) inp.blur(); } catch (e) {}
  }
  function stopKeys() { for (const k in keys) keys[k] = false; }   /* a key held when the line opens must not keep the hero walking */
  function openChat() {
    if (!inStreet() || NET.typing) return;
    NET.typing = 'chat'; NET.buf = ''; S.chatT = 0; S.comp = false; SFX.play('pick');
    stopKeys(); focusInput();
  }
  function closeChat() { if (NET.typing === 'chat') NET.typing = null; NET.buf = ''; if (S.inMine) releaseInput(); }
  // the field's text changed (typing, an IME step, a paste, a cut): NET.buf follows it, cleaned and cut to the limit.
  // The field itself is only corrected between compositions (writing into it would break the IME's work in progress).
  function inputChanged(e) {
    const inp = chatInput(); if (NET.typing !== 'chat' || !inp) return;
    S.chatT = 0;
    const v = liveText(inp.value), composing = S.comp || !!(e && e.isComposing);
    NET.buf = v;
    if (!composing && inp.value !== v) { const at = typeof inp.selectionStart === 'number' ? Math.min(inp.selectionStart, v.length) : v.length; inp.value = v; try { inp.setSelectionRange(at, at); } catch (err) {} }
  }
  // a key in the field: Enter sends and Escape cancels, but never in the middle of an IME composition (there Enter
  // picks a candidate; keyCode 229 = "the IME has this key"); every other key is the field's own business
  function inputKey(e) {
    if (NET.typing !== 'chat' || !e) return;
    S.chatT = 0;
    if (e.isComposing || e.keyCode === 229 || S.comp) return;
    const k = e.key, eat = () => { if (e.preventDefault) e.preventDefault(); };
    if (!inStreet()) { eat(); closeChat(); return; }
    if (k === 'Escape') { eat(); closeChat(); }
    else if (k === 'Enter') { eat(); inputChanged(); if (say(NET.buf)) closeChat(); }
    else if (k === 'Tab') eat();
  }
  function inputComp(on, e) { if (NET.typing !== 'chat') { S.comp = false; return; } S.comp = !!on; if (!on) inputChanged(); }
  // the field lost the focus while the line is open (a click on the page, a tab switch): the line and its text stay,
  // the keys stay blocked (see type), and the focus comes back as soon as the page has it again
  function inputBlur() {
    S.comp = false; if (NET.typing !== 'chat') return;
    setTimeout(() => { let has = true; try { if (document.hasFocus) has = document.hasFocus(); } catch (e) {} if (NET.typing === 'chat' && inStreet() && (TOUCH.on || has)) focusInput(); }, 50);
  }
  // a paste while the line is open: with the field focused the browser pastes into it (at the caret) and inputChanged
  // cleans the result; true = leave it to the field
  function paste() { return NET.typing === 'chat' && inputHasFocus(chatInput()); }
  // keys while the chat line is open and the field does NOT have the focus (from netType: the game's own keys never
  // see them); the field is asked to take over again
  function type(e) {
    const k = e.key; S.chatT = 0;
    if (!inStreet()) { closeChat(); return; }
    if (e.isComposing || e.keyCode === 229) return;
    if (k === 'Escape') { closeChat(); return; }
    if (k === 'Enter') { if (say(NET.buf)) closeChat(); return; }
    if (k === 'Backspace') setBuf(chars(NET.buf).slice(0, -1).join(''));
    else if (typeof k === 'string' && chars(k).length === 1 && !e.ctrlKey && !e.metaKey) setBuf(NET.buf + k);
    if (e.isTrusted && !inputHasFocus(chatInput())) focusInput();
  }
  function setBuf(s) { NET.buf = liveText(s); const inp = chatInput(); if (inp && S.inMine && inp.value !== NET.buf) inp.value = NET.buf; }
  (() => {   /* the field's listeners (index.html's own ones return at once while the chat line is open) */
    const inp = chatInput(); if (!inp || !inp.addEventListener) return;
    inp.addEventListener('keydown', e => { if (NET.typing === 'chat') inputKey(e); });
    inp.addEventListener('input', e => { if (NET.typing === 'chat') inputChanged(e); });
    inp.addEventListener('compositionstart', e => inputComp(true, e));
    inp.addEventListener('compositionend', e => inputComp(false, e));
    inp.addEventListener('blur', () => inputBlur());
    if (window.addEventListener) window.addEventListener('focus', () => { if (NET.typing === 'chat' && inStreet()) focusInput(); });
  })();
  Object.assign(HUB, { say, type, openChat, closeChat, setMute, paste, input: { key: inputKey, changed: inputChanged, comp: inputComp, blur: inputBlur } });

  // ---------- every frame ----------
  function syncOthers() {
    const room = HUB.room; if (!room || !room.members) return;
    const R = G && G.room, maxX = R ? R.wpx - 24 : 99999, maxY = R ? R.floorTop * TILE - 46 : 99999;
    for (const [id, m] of room.members) {
      if (id === room.me || !isUid(id) || !m) continue;
      let o = S.others.get(id);
      if (!o) { if (S.others.size >= 40) continue; o = newOther(id); S.others.set(id, o); }
      if (m.p !== o.pRaw || o.pRaw === undefined) { o.pRaw = m.p; cleanPres(o, m.p); }
      const f = m.f;
      if (f && typeof f === 'object') {
        o.tx = numIn(f.x, 0, maxX, o.tx); o.ty = numIn(f.y, -200, maxY, o.ty); o.vx = numIn(f.vx, -2000, 2000, 0); o.vy = numIn(f.vy, -3000, 3000, 0); o.f = f.f < 0 ? -1 : 1; o.g = !!f.g;
        if (!o.has) { o.has = true; o.x = o.tx; o.y = o.ty; }
      }
    }
    for (const id of [...S.others.keys()]) if (!room.members.has(id)) { S.others.delete(id); S.heard.delete(id); }
  }
  function tick(dt) {
    if (S.inMine && NET.typing !== 'chat') releaseInput();   /* (the chat line was closed from outside: the keyboard goes back to the game) */
    if (!inStreet()) {
      if (NET.typing === 'chat') closeChat();
      if (HUB.room || S.joinedFor) { leave(); S.joinedFor = null; S.chat = []; }
      if (S.trip && G && G.hub && !coopBusy()) S.trip = null;   /* (came home another way) */
      return;
    }
    if (NET.typing === 'chat' && (G.panel || PK || G.coll || (G.mode !== 'play' && G.mode !== 'trans'))) closeChat();   /* a window opened over the street */
    if (G.panel === 'net') { G.panel = 'mpfriend'; if (NET.typing && NET.typing !== 'chat') NET.typing = null; }   /* the friend panel has its own short version here (see drawFriend) */
    if (S.trip && !coopBusy()) { S.trip.t = (S.trip.t || 0) + dt; if ((HUB.room && S.wasOpen) || S.trip.t > 5) { const line = tripLine(S.trip); S.trip = null; if (line) sys(line); } }   /* (after the welcome line when there is one) */
    S.chatT += dt; if (NET.typing === 'chat') S.chatT = 0;
    if (S.bubble && (S.bubble.t -= dt) <= 0) S.bubble = null;
    if (!HUB.room) {
      if (coopBusy()) return;
      if (S.joinedFor !== G.room) enter();
      else if (S.retryT > 0 && (S.retryT -= dt) <= 0) enter(true);
      return;
    }
    const room = HUB.room, st = room.state;
    if (st === 'error' || st === 'closed') { drop(room.err || st); return; }
    if (st === 'connecting' || st === 'idle') { S.connT += dt; if (S.connT > 25) drop('timeout'); return; }
    S.connT = 0; if (S.graceT > 0) S.graceT -= dt;
    if (st === 'open') {
      if (!S.wasOpen) { S.wasOpen = true; S.err = ''; S.openAt = now(); sys(`Welcome to Kingdom Street ${room.n || 1}. ${TOUCH.on ? 'Tap Chat to talk.' : 'Press Enter to chat.'}`); }
      S.presT -= dt; if (S.presT <= 0) { S.presT = 1; pushPresence(); }
      const P = G.player;
      try { room.setFast({ x: Math.round(P.x), y: Math.round(P.y), vx: Math.round(P.vx), vy: Math.round(P.vy), f: P.face < 0 ? -1 : 1, g: P.onGround ? 1 : 0 }); } catch (e) { console.error(e); }
    }
    syncOthers();
    const k = Math.min(1, dt * 12);
    for (const o of S.others.values()) { o.x += (o.tx - o.x) * k; o.y += (o.ty - o.y) * k; if (o.bubble && (o.bubble.t -= dt) <= 0) o.bubble = null; }
    partyTick(dt);
  }
  MP.ticks.push(tick);

  // ---------- stations and what E does ----------
  function stations(out, ft) {
    for (const p of PLACES) out.push({ kind: p.kind, x: p.t * TILE, y: ft, r: p.r, label: p.kind === 'mp_sign' ? (isOpen() ? 'Notice post: who is in the street' : HUB.room ? 'Notice post' : 'Notice post: connect to the street') : p.label });
  }
  function openBoard(kind) { S.board = { kind: kind === 'raid' ? 'raid' : 'dungeon', view: 'list', tier: clamp(tierForLv(myLv()), 1, 4) }; S.sc.board = 0; S.drag = null; G.panel = 'mpboard'; SFX.play('pick'); }
  function openPlayers() { G.panel = 'mpplayers'; S.sc.players = 0; S.drag = null; SFX.play('pick'); }
  // the friend panel's short version for the street (friend battles, trades and visits wait for the Yard: see netCantDo)
  function openFriend() { G.panel = 'mpfriend'; if (NET.typing && NET.typing !== 'chat') NET.typing = null; SFX.play('pick'); }
  function tierForLv(lv) { let t = 1; for (let i = 1; i <= 4; i++) if (lv >= tierOf(i).lo) t = i; return t; }
  function interact(s) {
    if (!s || typeof s.kind !== 'string' || !s.kind.startsWith('mp_')) return false;
    if (SOON[s.kind]) { S.soon = s.kind; G.panel = 'mpsoon'; SFX.play('pick'); }
    else if (s.kind === 'mp_dungeon' || s.kind === 'mp_raid') openBoard(s.kind === 'mp_raid' ? 'raid' : 'dungeon');
    else if (s.kind === 'mp_sign') {
      if (isOpen()) openPlayers();
      else if (!HUB.room) { if (!MP.net) toast('Multiplayer is not part of this copy of the game.', 3, true); else if (coopBusy()) toast('You are in a co-op group right now.', 2); else { enter(); toast('Connecting to the Kingdom Street...', 2); } }
      else toast('Still connecting...', 1.6);
    }
    return true;
  }
  const myPanel = () => !!G && (G.panel === 'mpboard' || G.panel === 'mpplayers' || G.panel === 'mpsoon' || G.panel === 'mpfriend');
  const newBoard = () => ({ kind: 'dungeon', view: 'list', tier: 1 });

  // ---------- scrolling lists (the Players panel, a board's groups): the feel of the pet roster ----------
  // A list is { key, view: the box its rows are drawn (and clipped) in, total: the height of all its rows, RH: one row }.
  // S.sc[key] = how far it is scrolled. The wheel, a finger or the mouse dragging the list, the scrollbar (drag the
  // thumb, click the track for a page), the arrow keys, PageUp / PageDown and Home / End all move it.
  const listMax = L => Math.max(0, L.total - L.view.h);
  const listBar = L => ({ x: L.view.x + L.view.w + 6, y: L.view.y + 2, w: 8, h: L.view.h - 4 });
  function listThumb(L) { const b = listBar(L), M = listMax(L), th = Math.max(28, b.h * L.view.h / (L.view.h + M)); return { x: b.x, y: b.y + (M ? (b.h - th) * S.sc[L.key] / M : 0), w: b.w, h: th }; }
  function listScroll(L, dy) { S.sc[L.key] = clamp(S.sc[L.key] + dy, 0, listMax(L)); }
  // the list of the street panel that is open now (null = none)
  function curList() {
    if (!G || PK || G.coll || !inStreet()) return null;
    if (G.panel === 'mpplayers') return playersLayout().list;
    if (G.panel === 'mpboard' && !HUB.party && S.board && S.board.view === 'list') return boardList();
    return null;
  }
  // the wheel, or a finger dragging over the panel (true = a street list is open: the scroll was mine)
  function wheel(d) { const L = curList(); if (!L) return false; if (Number.isFinite(d)) listScroll(L, d); return true; }
  const scrolls = () => !!curList();
  function listKeys(L) {
    if (!L) return false;
    const d = hit('ArrowDown', 's') ? L.RH : hit('ArrowUp', 'w') ? -L.RH : hit('PageDown') ? L.view.h * 0.8 : hit('PageUp') ? -L.view.h * 0.8 : hit('End') ? 1e7 : hit('Home') ? -1e7 : 0;
    if (d) listScroll(L, d);
    return !!d;
  }
  // a press on the list (true = it started a drag or moved the bar). A press on one of the list's own buttons only
  // counts as a click when the mouse comes up again without having dragged the list (see mouseUp).
  function listPress(L, b) {
    if (!L) return false;
    if (listMax(L) > 0) {
      const bar = listBar(L), t = listThumb(L);
      if (inRect(mouse, { x: bar.x - 6, y: bar.y, w: bar.w + 12, h: bar.h })) {
        if (inRect(mouse, { x: t.x - 6, y: t.y, w: t.w + 12, h: t.h })) S.drag = { key: L.key, off: mouse.y - t.y }; else listScroll(L, (mouse.y < t.y ? -1 : 1) * L.view.h * 0.8);
        return true;
      }
    }
    if (!inRect(mouse, L.view)) return false;
    S.drag = { key: L.key, y0: mouse.y, s0: S.sc[L.key], moved: false, hit: b && b.clip ? { id: b.id, arg: b.arg } : null };
    return true;
  }
  // while a drag is on, the list follows the mouse (called when the list is laid out to be drawn)
  function listDrag(L) {
    const d = S.drag; if (!d || d.key !== L.key) return;
    const M = listMax(L);
    if (d.off !== undefined) { const b = listBar(L), th = listThumb(L).h; S.sc[L.key] = clamp((mouse.y - d.off - b.y) / Math.max(1, b.h - th) * M, 0, M); return; }
    if (Math.abs(mouse.y - d.y0) > 6) d.moved = true;
    if (d.moved) S.sc[L.key] = clamp(d.s0 - (mouse.y - d.y0), 0, M);
  }
  // the mouse button came up (from onMouseUp): the end of a drag, or the click on a row's button
  function mouseUp(btn) {
    const d = S.drag; if (!d) return; S.drag = null;
    if (btn !== 0 || !d.hit || !myPanel()) return;
    const L = curList(); if (!L || L.key !== d.key) return;
    if (Math.abs(mouse.y - d.y0) > 6 || d.moved) return;
    const b = buttonAt(); if (b && b.clip && b.id === d.hit.id && b.arg === d.hit.arg) act(b);
  }

  // the street's keys, from the Sanctuary's key block: true = a street panel has the keys (the world waits)
  function streetKeys() {
    if (!inStreet()) return false;
    if (G.panel === 'net') openFriend();
    if (!myPanel()) {
      if (G.panel || PK) return false;
      if (hit('Enter', 't')) openChat();
      else if (hit('Tab')) openPlayers();
      else if (hit('g') && HUB.party) openBoard(HUB.party.kind);
      else if (hit('f')) { openFriend(); return true; }
      return false;
    }
    if (G.panel === 'mpsoon') { if (hit('Escape', 'e', 'Enter')) { G.panel = null; SFX.play('pick'); } return true; }
    if (G.panel === 'mpfriend') { if (hit('Escape', 'e', 'Enter', 'f')) { G.panel = null; SFX.play('pick'); } return true; }
    if (G.panel === 'mpplayers') { if (hit('Escape', 'e', 'Tab')) { G.panel = null; SFX.play('pick'); } else listKeys(curList()); return true; }
    const D = S.board || (S.board = newBoard()), P = HUB.party;
    if (P) {   /* inside a group */
      if (hit('Escape', 'e', 'g')) { G.panel = null; SFX.play('pick'); }
      else if (hit('Enter')) { if (P.mine) go(); else if (!P.pend) setReady(!amReady()); }
      else if (hit('r') && !P.mine && !P.pend) setReady(!amReady());
      else if (P.mine && hit('ArrowLeft', 'a')) setTier(P.tier - 1);
      else if (P.mine && hit('ArrowRight', 'd')) setTier(P.tier + 1);
    } else if (D.view === 'new') {
      if (hit('Escape')) { D.view = 'list'; SFX.play('pick'); }
      else if (hit('Enter', 'e')) { if (openGroup(D.kind, D.tier)) D.view = 'list'; }
      else if (hit('ArrowUp', 'w')) D.tier = clamp(D.tier - 1, 1, 4);
      else if (hit('ArrowDown', 's')) D.tier = clamp(D.tier + 1, 1, 4);
      else for (let t = 1; t <= 4; t++) if (hit(String(t))) D.tier = t;
    } else {
      if (hit('Escape', 'e')) { G.panel = null; SFX.play('pick'); }
      else if (hit('o', 'Enter')) { if (needRoom() && needTeam()) { D.view = 'new'; SFX.play('pick'); } }
      else if (!listKeys(boardList())) { const L = boardList(), list = L.items.slice(boardFirst(L)); for (let i = 1; i <= 4; i++) if (hit(String(i)) && list[i - 1]) joinGroup(list[i - 1].leader); }   /* 1-4: the rows in view, from the top */
    }
    return true;
  }
  Object.assign(HUB, { stations, interact, keys: streetKeys, wheel, scrolls, mouseUp });

  // ---------- layout shared by drawing and clicking ----------
  // The chat: in landscape at the bottom left of the screen. In portrait it lives in the HUD area under the world's
  // square, so nothing covers the street the hero walks along: the log (as many lines as the screen's height leaves
  // room for) and under it the Chat / Players buttons. On a short portrait screen only the buttons fit there and the
  // log goes to the top of the square, under the status line, while somebody is talking.
  function chatRects() {
    const port = PORTRAIT(), w = port ? W - 16 : 350; let row, box, lines = CHAT_SHOW, under = false;
    if (port) {
      const y0 = 658, n = clamp(Math.floor((VIEW.h - 64 - y0 - 30 - 16) / 16), 0, CHAT_SHOW);
      under = n >= 2; lines = under ? n : 4;
      box = under ? { x: 8, y: y0, w, h: lines * 16 + 16 } : { x: 8, y: 136, w, h: lines * 16 + 16 };
      row = { x: 8, y: under ? box.y + box.h + 4 : y0, w, h: 26 };
    } else {
      row = { x: 8, y: H - 26 - 26, w, h: 26 }; box = { x: 8, y: row.y - 4 - (CHAT_SHOW * 16 + 16), w, h: CHAT_SHOW * 16 + 16 };
    }
    return { row, box, lines, under, top: port && !under, chat: { x: 8, y: row.y, w: 128, h: 26 }, players: { x: 142, y: row.y, w: 128, h: 26 }, send: { x: 8 + w - 62, y: row.y, w: 62, h: 26 } };
  }
  function badgeText() { const P = HUB.party; if (!P) return ''; return `Your group ${P.m.length}/4 · ${P.pend ? 'asking to join...' : P.go ? 'setting off!' : P.mine ? (canGo() ? 'ready to go!' : 'waiting') : amReady() ? 'ready' : 'not ready yet'}${TOUCH.on ? '' : '  (G)'}`; }
  // The status line ("Kingdom Street 1 · 7 players") and the group badge. Landscape: the bottom right corner, on the
  // chat buttons' row (the top left belongs to the Sanctuary's own panel and the message bar under it). Portrait: the
  // top left of the world's square, under the message bar.
  function statusLayout() {
    const [full, col] = status(), bt = badgeText(); ctx.font = `bold 13px ${UI}`;
    if (PORTRAIT()) {
      const txt = fitText(full, W - 12 - 30), s = { x: 6, y: 74, w: ctx.measureText(txt).width + 30, h: 26 };
      return { txt, col, s, badge: bt ? { x: 6, y: 104, w: Math.min(W - 12, ctx.measureText(bt).width + 30), h: 26 } : null };
    }
    const C = chatRects(), left = C.row.x + C.row.w + 12, txt = fitText(full, W - 8 - left - 30), w = ctx.measureText(txt).width + 30, s = { x: W - 8 - w, y: C.row.y, w, h: 26 };
    if (!bt) return { txt, col, s, badge: null };
    const bw = Math.min(W - 8 - left, ctx.measureText(bt).width + 30), beside = s.x - 6 - bw >= left;   /* next to the status line when there is room, else above it */
    return { txt, col, s, badge: beside ? { x: s.x - 6 - bw, y: s.y, w: bw, h: 26 } : { x: W - 8 - bw, y: s.y - 30, w: bw, h: 26 } };
  }
  const statusRect = () => statusLayout().s;
  const badgeRect = () => statusLayout().badge || { x: -9, y: -9, w: 0, h: 0 };
  function status() {
    const r = HUB.room;
    if (!MP.net) return ['Offline: multiplayer is not part of this copy of the game', PAL.bad];
    if (!r) return coopBusy() ? ['Joining your group...', PAL.gold] : S.err ? ["Offline: couldn't reach the multiplayer service (E at the signpost to retry)", PAL.bad] : ['Not connected (E at the signpost to connect)', PAL.dim];
    if (r.state === 'open') { const n = S.others.size + 1; return [`Kingdom Street ${r.n || 1} · ${n} player${n === 1 ? '' : 's'}`, PAL.good]; }
    if (r.state === 'migrating') return ['The host left: finding a new one...', PAL.gold];
    return S.err ? ["Offline: couldn't reach the multiplayer service (trying again...)", PAL.bad] : ['Connecting...', PAL.cream];
  }
  function boardBox() { const port = PORTRAIT(), bw = port ? W - 12 : 660, bh = port ? 540 : 452; return { bx: W / 2 - bw / 2, by: Math.max(6, H / 2 - bh / 2 - (port ? 0 : 6)), bw, bh, port }; }
  // a board's open groups as a scrolling list (rows of 68 px between the heading and the footer)
  function boardList() {
    const B = boardBox(), D = S.board || (S.board = newBoard()), items = groups(D.kind), RH = 68;
    const L = { key: 'board', RH, items, view: { x: B.bx + 20, y: B.by + 66, w: B.bw - 40 - 16, h: B.bh - 66 - 86 }, total: items.length * RH };
    S.sc.board = clamp(S.sc.board, 0, listMax(L));
    return L;
  }
  const boardFirst = L => Math.max(0, Math.ceil((S.sc.board - 14) / L.RH));   /* the first row that is (nearly) whole in view */
  const boardRowY = (L, i) => L.view.y + i * L.RH - S.sc.board;
  const rowSeen = (L, y, h) => y + h > L.view.y && y < L.view.y + L.view.h;
  // the buttons of whatever street panel is open: [{ id, r, arg, txt, off, on, clip }] (clip = the list box a row's button lives in)
  function panelButtons() {
    const out = [], add = (id, r, txt, o) => out.push(Object.assign({ id, r, txt }, o));
    if (!G) return out;
    if (G.panel === 'mpsoon') { const b = soonBox(); add('close', { x: W / 2 - 60, y: b.by + b.bh - 56, w: 120, h: 38 }, 'Close'); }
    else if (G.panel === 'mpfriend') {
      const b = soonBox();
      if (NET.state === 'linked') ['Battle', 'Trade', 'Visit their Yard'].forEach((t, i) => add('foff', { x: W / 2 - 237 + i * 162, y: b.by + 150, w: 150, h: 40 }, t, { off: true, arg: i }));
      add('close', { x: W / 2 - 60, y: b.by + b.bh - 56, w: 120, h: 38 }, 'Close');
    } else if (G.panel === 'mpplayers') {
      const L = playersLayout();
      L.rows.forEach(row => { if (row.me) return; const o = row.o; add('mute', row.mute, isMuted(o) && !isHidden(o) ? 'Unmute' : 'Mute', { arg: o.id, on: isMuted(o), off: isHidden(o), size: 12, clip: L.list.view }); add('hide', row.hide, isHidden(o) ? 'Show' : 'Hide', { arg: o.id, on: isHidden(o), size: 12, clip: L.list.view }); });
      add('close', { x: L.bx + L.bw - 140, y: L.by + L.bh - 54, w: 120, h: 38 }, 'Close');
    } else if (G.panel === 'mpboard') {
      const B = boardBox(), D = S.board || newBoard(), P = HUB.party, fy = B.by + B.bh - 54, x0 = B.bx + 20, x1 = B.bx + B.bw - 20;
      add('close', { x: x1 - 110, y: fy, w: 110, h: 38 }, 'Close');
      if (P) {
        if (P.mine) {
          add('go', { x: x0, y: fy, w: 130, h: 38 }, 'Go!', { off: !canGo(), color: PAL.gold });
          add('leave', { x: x0 + 140, y: fy, w: B.port ? 150 : 170, h: 38 }, 'Close the group');
          add('tier', { x: x1 - 86, y: B.by + 262, w: 40, h: 32 }, '◂', { arg: P.tier - 1, off: P.tier <= 1 || P.go }); add('tier', { x: x1 - 40, y: B.by + 262, w: 40, h: 32 }, '▸', { arg: P.tier + 1, off: P.tier >= 4 || P.go });
        } else {
          add('ready', { x: x0, y: fy, w: 150, h: 38 }, amReady() ? '✔ Ready' : 'Ready up', { off: P.pend, on: amReady(), color: amReady() ? PAL.good : PAL.cream });
          add('leave', { x: x0 + 160, y: fy, w: 150, h: 38 }, 'Leave group');
        }
      } else if (D.view === 'new') {
        for (let t = 1; t <= 4; t++) add('pick', { x: x0, y: B.by + 62 + (t - 1) * 60, w: B.bw - 40, h: 54 }, '', { arg: t, on: D.tier === t });
        add('open', { x: x0, y: fy, w: 170, h: 38 }, 'Open the group', { color: PAL.gold }); add('back', { x: x0 + 180, y: fy, w: 100, h: 38 }, 'Back');
      } else {
        const L = boardList();
        L.items.forEach((g, i) => { const y = boardRowY(L, i); if (g.leader !== me() && rowSeen(L, y, 62)) add('join', { x: L.view.x + L.view.w - 100, y: y + 13, w: 92, h: 36 }, g.pt.go ? 'Gone' : g.pt.m.length >= 4 ? 'Full' : 'Join', { arg: g.leader, off: g.pt.go || g.pt.m.length >= 4 || !isOpen(), clip: L.view }); });
        add('new', { x: x0, y: fy, w: 170, h: 38 }, 'Open a group', { off: !isOpen(), color: PAL.gold });
      }
    }
    return out;
  }
  // the button under the mouse (a row's button only where its list shows it)
  const buttonAt = () => panelButtons().find(b => inRect(mouse, b.r) && (!b.clip || inRect(mouse, b.clip)));
  function soonBox() { const bw = PORTRAIT() ? W - 20 : 540, bh = 270; return { bx: W / 2 - bw / 2, by: H / 2 - bh / 2 - 10, bw, bh }; }
  // the Players panel: everyone in the street, me first, as a scrolling list (two columns in landscape, one in portrait)
  function playersLayout() {
    const port = PORTRAIT(), cols = port ? 1 : 2, RH = port ? 40 : 38, bw = port ? W - 12 : 880, vis = port ? clamp(Math.floor((H - 8 - 126) / RH), 4, 14) : 9, bh = 62 + vis * RH + 64;
    const bx = W / 2 - bw / 2, by = Math.max(4, H / 2 - bh / 2), view = { x: bx + 14, y: by + 58, w: bw - 28 - 16, h: vis * RH }, cw = view.w / cols;
    const all = [{ me: true, o: { id: me(), name: myName(), cls: G.cls, lv: myLv() } }].concat([...S.others.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(o => ({ o })));
    const list = { key: 'players', RH, view, total: Math.ceil(all.length / cols) * RH };
    S.sc.players = clamp(S.sc.players, 0, listMax(list));
    const rows = [];
    all.forEach((row, i) => {
      const x = view.x + (i % cols) * cw, y = view.y + Math.floor(i / cols) * RH - S.sc.players + 2, h = RH - 4;
      if (rowSeen(list, y, h)) rows.push(Object.assign(row, { x, y, w: cw - 6, h, mute: { x: x + cw - 6 - 130, y: y + 3, w: 66, h: h - 6 }, hide: { x: x + cw - 6 - 60, y: y + 3, w: 56, h: h - 6 } }));
    });
    return { bx, by, bw, bh, rows, list, total: all.length };
  }

  // ---------- clicks ----------
  // a click on the street's HUD while walking about (true = it was mine)
  function click(btn) {
    if (!inStreet() || G.mode !== 'play' || G.panel || PK || G.coll) return false;
    const C = chatRects();
    if (NET.typing === 'chat') {
      if (btn === 0 && inRect(mouse, C.send)) { if (say(NET.buf)) closeChat(); }
      else if (btn !== 0 || !(inRect(mouse, C.row) || inRect(mouse, C.box))) closeChat();
      return true;
    }
    if (NET.typing || btn !== 0) return false;
    if (inRect(mouse, C.chat) || ((C.under || (S.chatT < 9 && visibleLines().length)) && inRect(mouse, C.box))) { openChat(); return true; }
    if (inRect(mouse, C.players)) { openPlayers(); return true; }
    if (HUB.party && inRect(mouse, badgeRect())) { openBoard(HUB.party.kind); return true; }
    return false;
  }
  function panelClick(btn) {
    if (!myPanel()) return false;
    if (btn !== 0) { S.drag = null; if (G.panel === 'mpboard' && S.board && S.board.view === 'new' && !HUB.party) S.board.view = 'list'; else G.panel = null; SFX.play('pick'); return true; }
    const b = buttonAt();
    if (listPress(curList(), b)) return true;   /* (a list's own buttons act when the mouse comes up: see mouseUp) */
    if (!b || b.clip) {   /* a click outside the window closes it */
      const box = G.panel === 'mpsoon' || G.panel === 'mpfriend' ? soonBox() : G.panel === 'mpplayers' ? playersLayout() : boardBox();
      if (!inRect(mouse, { x: box.bx, y: box.by, w: box.bw, h: box.bh })) { G.panel = null; SFX.play('pick'); }
      return true;
    }
    act(b);
    return true;
  }
  // what a panel's button does
  function act(b) {
    if (b.off && b.id !== 'join' && b.id !== 'new' && b.id !== 'go') return;
    const D = S.board;
    switch (b.id) {
      case 'close': G.panel = null; SFX.play('pick'); break;
      case 'mute': setMute(b.arg, 'm', !b.on); SFX.play('pick'); break;
      case 'hide': setMute(b.arg, 'h', !b.on); SFX.play('pick'); break;
      case 'join': if (b.off && isOpen()) toast(b.txt === 'Full' ? 'That group is already full.' : 'That group has already set off.', 2, true); else joinGroup(b.arg); break;
      case 'new': if (needRoom() && needTeam()) { D.view = 'new'; SFX.play('pick'); } break;
      case 'pick': D.tier = b.arg; SFX.play('pick'); break;
      case 'open': if (openGroup(D.kind, D.tier)) D.view = 'list'; break;
      case 'back': D.view = 'list'; SFX.play('pick'); break;
      case 'ready': setReady(!amReady()); break;
      case 'leave': leaveGroup(); break;
      case 'tier': setTier(b.arg); break;
      case 'go': go(); break;
    }
  }
  Object.assign(HUB, { click, panelClick });

  // ---------- drawing: the world ----------
  function sign(name, x, top) { ctx.font = `bold 12px ${UI}`; const tw = ctx.measureText(name).width + 18; panel(x - tw / 2, top, tw, 22, 'parch'); label(name, x, top + 11, { align: 'center', size: 12, bold: true, color: PAL.parchInk }); }
  const box = (c, x, y, w, h) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); };
  function tri(c, x0, y0, x1, y1, x2, y2) { ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.closePath(); ctx.fill(); }
  // a notice board on two posts, with pinned papers
  function drawBoardShape(x, ft, w, h, papers) {
    box('#4a3020', x - w / 2 + 6, ft - h - 30, 6, h + 30); box('#4a3020', x + w / 2 - 12, ft - h - 30, 6, h + 30);
    box('#3a2414', x - w / 2, ft - h - 26, w, h); box('#8a6238', x - w / 2 + 3, ft - h - 23, w - 6, h - 6);
    tri('#5a3a22', x - w / 2 - 6, ft - h - 26, x, ft - h - 40, x + w / 2 + 6, ft - h - 26);
    papers.forEach(([px, py, pw, ph, c]) => { box(c || '#e8d4a6', x + px, ft - h - 23 + py, pw, ph); box('#c94a3a', x + px + pw / 2 - 1, ft - h - 23 + py + 1, 3, 3); box('rgba(58,38,20,0.5)', x + px + 3, ft - h - 23 + py + 7, pw - 6, 1); box('rgba(58,38,20,0.5)', x + px + 3, ft - h - 23 + py + 11, pw - 8, 1); });
  }
  // the code-drawn stand-ins (until the ChatGPT art exists); each returns its height in px
  const FALLBACK = {
    mp_sign(x, ft) { box('#4a3020', x - 3, ft - 66, 6, 66); box('#3a2414', x - 22, ft - 70, 44, 30); box('#8a6238', x - 19, ft - 67, 38, 24); box('#e8d4a6', x - 14, ft - 63, 12, 15); box('#e8d4a6', x + 2, ft - 62, 12, 11); return 72; },
    mp_missions(x, ft) { drawBoardShape(x, ft, 84, 56, [[-34, 6, 18, 22], [-12, 5, 20, 16], [12, 8, 20, 24, '#f3e3c3'], [-10, 26, 16, 18, '#d8c090']]); return 98; },
    mp_auction(x, ft) {
      box('#5a4632', x - 100, ft - 110, 200, 110); box('#7a6246', x - 96, ft - 106, 192, 106);
      for (const dx of [-96, -34, 28, 90]) box('#4a3524', x + dx, ft - 106, 6, 106);
      tri('#7a3324', x - 116, ft - 106, x, ft - 170, x + 116, ft - 106); tri('#96422e', x - 100, ft - 110, x, ft - 162, x + 100, ft - 110);
      box('#2e1c10', x - 20, ft - 64, 40, 64); box('#5a361c', x - 16, ft - 60, 32, 60); box(PAL.brass, x + 8, ft - 32, 4, 4);
      for (const dx of [-74, 46]) { box('#2e1c10', x + dx, ft - 82, 30, 34); box('#f2cd73', x + dx + 3, ft - 79, 24, 28); box('#2e1c10', x + dx + 14, ft - 79, 2, 28); box('#2e1c10', x + dx + 3, ft - 66, 24, 2); }
      box('#3a2414', x - 26, ft - 96, 52, 22); box('#c99a3e', x - 23, ft - 93, 46, 16); box('#5a361c', x - 10, ft - 89, 14, 6); box('#5a361c', x - 2, ft - 87, 12, 3);
      return 172;
    },
    mp_shop(x, ft) {
      box('#4a3524', x - 78, ft - 96, 6, 96); box('#4a3524', x + 72, ft - 96, 6, 96);
      box('#5a4632', x - 82, ft - 44, 164, 44); box('#7a6246', x - 78, ft - 40, 156, 36); box('#8a6238', x - 86, ft - 50, 172, 8);
      for (let i = 0; i < 8; i++) box(i % 2 ? '#e8d4a6' : '#b8463a', x - 88 + i * 22, ft - 122, 22, 30);
      for (let i = 0; i < 8; i++) tri(i % 2 ? '#e8d4a6' : '#b8463a', x - 88 + i * 22, ft - 92, x - 77 + i * 22, ft - 82, x - 66 + i * 22, ft - 92);
      box('#3a2414', x - 90, ft - 126, 180, 5);
      box('#6a8fc8', x - 60, ft - 76, 18, 26); box('#c8704a', x - 30, ft - 78, 18, 28); box('#7cbf4a', x, ft - 74, 18, 24); tri('#8a5ac8', x + 30, ft - 50, x + 42, ft - 80, x + 54, ft - 50);
      return 128;
    },
    mp_dungeon(x, ft) { drawArch(x - 26, ft, 120, 130, '#6b7083', '#4a4e5e', '#0c0a12', null); drawBoardShape(x + 78, ft, 60, 44, [[-24, 5, 16, 20], [-4, 6, 16, 14], [-2, 22, 18, 14, '#d8c090']]); return 140; },
    mp_raid(x, ft) { drawArch(x - 26, ft, 150, 160, '#5a5560', '#3a3640', '#16060a', '#b8322a'); drawBoardShape(x + 92, ft, 60, 44, [[-24, 5, 18, 22, '#f3e3c3'], [0, 6, 16, 16]]); return 170; },
  };
  // a stone archway (the dungeon's mouth, the raid's gate); banner = the colour of the hangings beside it
  function drawArch(x, ft, w, h, c1, c2, dark, bannerCol) {
    box(c2, x - w / 2, ft - h, w, h); box(c1, x - w / 2 + 4, ft - h + 4, w - 8, h - 4);
    for (let i = 0; i < 5; i++) box(c2, x - w / 2 - 4 + i * (w / 4.4), ft - h - 12, w / 8, 14);
    const iw = w * 0.52, ih = h * 0.72; ctx.fillStyle = dark; ctx.beginPath(); ctx.moveTo(x - iw / 2, ft); ctx.lineTo(x - iw / 2, ft - ih + iw / 2); ctx.arc(x, ft - ih + iw / 2, iw / 2, Math.PI, 0); ctx.lineTo(x + iw / 2, ft); ctx.closePath(); ctx.fill();
    for (let yy = ft - h + 18; yy < ft - 6; yy += 18) { box('rgba(0,0,0,0.18)', x - w / 2 + 4, yy, (w - iw) / 2 - 6, 2); box('rgba(0,0,0,0.18)', x + iw / 2 + 2, yy, (w - iw) / 2 - 6, 2); }
    if (bannerCol) { for (const s of [-1, 1]) { const bx = x + s * (w / 2 - 14); box(bannerCol, bx - 8, ft - h + 20, 16, 54); tri(bannerCol, bx - 8, ft - h + 74, bx, ft - h + 64, bx + 8, ft - h + 74); box(PAL.brass, bx - 3, ft - h + 36, 6, 6); } for (let i = -2; i <= 2; i++) box('#2a2028', x + i * (iw / 5) - 2, ft - ih + 6, 4, ih - 6); }
    else { const g = ctx.createRadialGradient(x, ft - 30, 4, x, ft - 30, iw / 2); g.addColorStop(0, 'rgba(120,90,200,0.35)'); g.addColorStop(1, 'rgba(120,90,200,0)'); ctx.fillStyle = g; ctx.fillRect(x - iw / 2, ft - ih, iw, ih); }
  }
  // a station's name: a bigger parchment sign than the name tags, with a drop shadow and brass pins, so it reads against the busy backdrop
  function stationSign(name, x, top) {
    ctx.font = `bold 15px ${UI}`; const tw = Math.round(ctx.measureText(name).width) + 30, l = Math.round(x - tw / 2);
    ctx.fillStyle = 'rgba(10,6,3,0.45)'; rr(l - 1, top + 2, tw + 4, 30, 7); ctx.fill();
    ctx.fillStyle = '#2a1a0c'; rr(l - 2, top - 2, tw + 4, 32, 7); ctx.fill();
    panel(l, top, tw, 28, 'parch');
    for (const px of [l + 7, l + tw - 9]) { box(PAL.brassDk || '#6b4a1e', px - 1, top + 12, 4, 4); box(PAL.brass, px, top + 13, 2, 2); }
    label(name, x, top + 14, { align: 'center', size: 15, bold: true, color: '#2a1a0c' });
  }
  // what makes a station stand out from the painted street: a soft pool of light behind it and a shadow on the ground under it
  function propGlow(x, ft, w, h) {
    if (Math.abs(x - (G.cam.x + W / 2)) > W / 2 + 280) return;
    const cy = ft - h * 0.5, r = Math.max(70, Math.max(w, h) * 0.72);
    const g = ctx.createRadialGradient(x, cy, r * 0.15, x, cy, r); g.addColorStop(0, 'rgba(255,238,190,0.34)'); g.addColorStop(0.6, 'rgba(255,230,170,0.12)'); g.addColorStop(1, 'rgba(255,230,170,0)');
    ctx.fillStyle = g; ctx.fillRect(x - r, cy - r, r * 2, r * 2);
    const sw = Math.max(40, w * 0.56), s = ctx.createRadialGradient(x, ft + 3, 2, x, ft + 3, sw); s.addColorStop(0, 'rgba(10,6,12,0.5)'); s.addColorStop(0.7, 'rgba(10,6,12,0.22)'); s.addColorStop(1, 'rgba(10,6,12,0)');
    ctx.save(); ctx.translate(x, ft + 3); ctx.scale(1, 0.16); ctx.translate(-x, -(ft + 3)); ctx.fillStyle = s; ctx.fillRect(x - sw, ft + 3 - sw, sw * 2, sw * 2); ctx.restore();
  }
  const FALLBACK_W = { mp_sign: 44, mp_missions: 84, mp_auction: 232, mp_shop: 180, mp_dungeon: 200, mp_raid: 240 };
  function drawProps(ft) {
    for (const p of PLACES) {
      const x = p.t * TILE, img = art('props/' + p.kind); let h;
      if (img) { h = img.height * PX; propGlow(x, ft, img.width * PX, h); drawSprite(img, x, ft + 2, 1); }
      else { propGlow(x, ft, FALLBACK_W[p.kind] || 80, { mp_sign: 72, mp_missions: 98, mp_auction: 172, mp_shop: 128, mp_dungeon: 140, mp_raid: 170 }[p.kind] || 90); h = FALLBACK[p.kind](x, ft); }
      stationSign(p.name, x, ft - h - 34);
      if (p.kind === 'mp_dungeon' || p.kind === 'mp_raid') { const n = groups(p.kind === 'mp_raid' ? 'raid' : 'dungeon').length; if (n) label(`${n} group${n === 1 ? '' : 's'} open`, x, ft - h - 48 + Math.sin(TIME * 3) * 2, { align: 'center', size: 13, bold: true, color: PAL.gold }); }
    }
  }
  // the Yard's signpost that points down the road
  function drawYardSign(x, ft) {
    box('#4a3020', x - 4, ft - 78, 8, 78); box('#3a2414', x - 6, ft - 82, 12, 6);
    ctx.fillStyle = '#3a2414'; ctx.beginPath(); ctx.moveTo(x - 34, ft - 70); ctx.lineTo(x + 30, ft - 70); ctx.lineTo(x + 44, ft - 59); ctx.lineTo(x + 30, ft - 48); ctx.lineTo(x - 34, ft - 48); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#8a6238'; ctx.beginPath(); ctx.moveTo(x - 31, ft - 67); ctx.lineTo(x + 29, ft - 67); ctx.lineTo(x + 39, ft - 59); ctx.lineTo(x + 29, ft - 51); ctx.lineTo(x - 31, ft - 51); ctx.closePath(); ctx.fill();
    box('#e8d4a6', x - 22, ft - 62, 40, 2); box('#e8d4a6', x - 22, ft - 57, 30, 2);
    sign('Kingdom Street', x, ft - 82 - 26);
  }
  // the backdrop while bg/street doesn't exist: sky, a far castle, rooftops and the town wall, each scrolling at its own speed
  const hash = i => { const v = Math.sin(i * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
  function drawBg(R) {
    const fx = R.wpx > W ? clamp(G.cam.x / (R.wpx - W), 0, 1) : 0.5, gy = R.floorTop * TILE - Math.round(G.cam.y), span = R.wpx - W;
    const sky = ctx.createLinearGradient(0, 0, 0, gy); sky.addColorStop(0, '#5f9bd0'); sky.addColorStop(0.7, '#b9dcee'); sky.addColorStop(1, '#f1e3c0');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 7; i++) { const cx = ((hash(i) * 1600 + TIME * (4 + hash(i + 9) * 5) - fx * span * 0.04) % 1500 + 1500) % 1500 - 200, cy = 40 + hash(i + 3) * 150; ctx.fillStyle = 'rgba(255,255,255,0.75)'; for (const [dx, dy, r] of [[0, 0, 22], [26, 6, 17], [-24, 7, 15], [8, -10, 15]]) { ctx.beginPath(); ctx.ellipse(cx + dx, cy + dy, r * 1.5, r * 0.7, 0, 0, 7); ctx.fill(); } }
    // the castle on its hill
    const cxp = W * 0.62 - (fx - 0.5) * span * 0.1, far = '#93a9c6';
    ctx.fillStyle = '#a8bbd2'; ctx.beginPath(); ctx.ellipse(cxp, gy + 30, 420, 150, 0, 0, 7); ctx.fill();
    box(far, cxp - 90, gy - 190, 180, 90); for (let i = 0; i < 9; i++) box(far, cxp - 90 + i * 21, gy - 200, 12, 12);
    for (const [dx, w, h] of [[-120, 44, 150], [76, 44, 150], [-22, 44, 200]]) { box(far, cxp + dx, gy - 110 - h, w, h); tri('#7a8fb0', cxp + dx - 8, gy - 110 - h, cxp + dx + w / 2, gy - 150 - h, cxp + dx + w + 8, gy - 110 - h); box('#f2e2a8', cxp + dx + w / 2 - 4, gy - 90 - h, 8, 14); }
    box('#c94a3a', cxp - 1, gy - 372, 2, 24); tri('#c94a3a', cxp + 1, gy - 372, cxp + 22, gy - 365, cxp + 1, gy - 358);
    // rooftops
    const off = fx * span * 0.3; let hx = -off - 40;
    for (let i = 0; hx < W + 40 && i < 80; i++) {
      const w = 70 + Math.floor(hash(i + 20) * 60), h = 70 + Math.floor(hash(i + 40) * 70), c = ['#6f7f9a', '#7a8598', '#687692'][i % 3];
      if (hx + w > -40) { box(c, hx, gy - h, w, h); tri(['#7a4a40', '#5a5f78', '#6a5040'][i % 3], hx - 8, gy - h, hx + w / 2, gy - h - 34 - hash(i) * 20, hx + w + 8, gy - h); for (let k = 0; k < 2; k++) box('#f2e2a8', hx + 14 + k * (w - 42), gy - h + 18, 12, 16); if (hash(i + 60) > 0.5) box(c, hx + w * 0.7, gy - h - 40, 10, 26); }
      hx += w + 6;
    }
    // the town wall
    const o2 = (fx * span * 0.55) % 48; box('#565f76', 0, gy - 64, W, 64); for (let x = -o2 - 48; x < W + 48; x += 48) { box('#565f76', x, gy - 78, 26, 16); box('rgba(0,0,0,0.14)', x + 10, gy - 44, 22, 3); box('rgba(0,0,0,0.14)', x + 30, gy - 22, 22, 3); }
    box('rgba(20,16,30,0.18)', 0, 0, W, H);
  }

  // one other player: the paper-doll hero like drawRemoteHero, with a name tag
  function drawOther(o) {
    const cx = o.x + 12, foot = o.y + 46;
    if (!o.sheet && o.sheetT <= TIME) { const nm = heroSheet(o.cls, o.look || cleanLook(null, o.cls)); o.sheet = nm && animFrames(nm, 'idle') ? nm : null; o.sheetT = TIME + 0.5; }   /* (still loading: ask again in a moment) */
    const nm = o.sheet || o.cls;
    if (animFrames(nm, 'idle')) {
      const anim = !o.g ? 'jump' : Math.abs(o.vx) > 25 ? 'run' : 'idle';
      const i = anim === 'jump' ? (o.vy < -260 ? 1 : o.vy < 140 ? 2 : 3) : anim === 'run' ? Math.floor(TIME * 9) : Math.floor(TIME * 5);
      footShadow(cx, foot, 16, o.g ? 1 : 0.5);
      drawAnim(nm, anim, i, cx, foot + 1, o.f || 1, {});
    } else { footShadow(cx, foot, 16, 1); box(CLASSES[o.cls].color || '#888', cx - 9, o.y + 10, 18, 36); box('#e8c39e', cx - 7, o.y - 2, 14, 13); }
    const P = HUB.party, mate = P && P.m.includes(o.id);
    ctx.font = `bold 12px ${UI}`; const tw = ctx.measureText(o.name).width + 18;
    panel(cx - tw / 2, o.y - 34, tw, 20, 'parch'); label(o.name, cx, o.y - 24, { align: 'center', size: 12, bold: true, color: mate ? '#2e5a1c' : PAL.parchInk });
  }
  function drawBubble(b, cx, bottom) {
    ctx.font = `bold 12px ${UI}`; const w = Math.max(...b.lines.map(l => ctx.measureText(l).width)) + 22, h = b.lines.length * 15 + 14, x = cx - w / 2, y = bottom - h;
    ctx.globalAlpha = Math.min(1, b.t * 2);
    panel(x, y, w, h, 'parch'); tri(PAL.parch, cx - 5, y + h - 2, cx, y + h + 6, cx + 5, y + h - 2);
    b.lines.forEach((l, i) => label(l, cx, y + 14 + i * 15, { align: 'center', size: 12, bold: true, color: PAL.parchInk }));
    ctx.globalAlpha = 1;
  }
  function drawWorld() {
    if (!inStreet()) return;
    const x0 = G.cam.x - 110, x1 = G.cam.x + W + 110, seen = [];
    for (const o of S.others.values()) { if (!o.has || o.x < x0 || o.x > x1 || isHidden(o)) continue; drawOther(o); seen.push(o); }
    for (const o of seen) if (o.bubble && !isMuted(o)) drawBubble(o.bubble, o.x + 12, o.y - 40);
    if (S.bubble) drawBubble(S.bubble, G.player.x + G.player.w / 2, G.player.y - 16);
  }
  MP.worldDraw.push(drawWorld);
  Object.assign(HUB, { drawProps, drawYardSign, drawBg });

  // ---------- drawing: the HUD ----------
  // the chat log as display lines (wrapped to the box), newest last
  function visibleLines() {
    const C = chatRects(), maxW = C.box.w - 20, out = [];
    for (let i = S.chat.length - 1; i >= 0 && out.length < C.lines; i--) {
      const e = S.chat[i];
      if (!e.sys && !e.mine) { const o = S.others.get(e.id); if (o ? isMuted(o) : muteNames().m.includes(e.name) || muteNames().h.includes(e.name)) continue; }
      if (!e.wl || e.wlW !== maxW) { e.wl = wrapLines(e.sys ? e.s : e.name + ': ' + e.s, maxW, 13).map(l => { ctx.font = `13px ${UI}`; return fitText(l, maxW); }); e.wlW = maxW; }
      for (let k = e.wl.length - 1; k >= 0 && out.length < C.lines; k--) out.unshift({ e, txt: e.wl[k], first: k === 0 });
    }
    return out;
  }
  // the line being typed, cut to what fits around the caret: [text before the caret, text after it]
  function typedParts(maxW) {
    const inp = chatInput(), all = chars(NET.buf); let at = all.length;
    if (inputHasFocus(inp) && typeof inp.selectionStart === 'number' && inp.value === NET.buf) at = chars(NET.buf.slice(0, inp.selectionStart)).length;
    let a = all.slice(0, at), b = all.slice(at);
    ctx.font = `13px ${UI}`;
    while (a.length > 1 && ctx.measureText(a.join('')).width > maxW * (b.length ? 0.8 : 1)) a = a.slice(1);
    while (b.length && ctx.measureText(a.join('') + b.join('')).width > maxW) b = b.slice(0, -1);
    return [a.join(''), b.join('')];
  }
  function drawChat() {
    const C = chatRects(), typing = NET.typing === 'chat', lines = visibleLines();
    const a = typing || C.under ? 1 : clamp((10 - S.chatT) / 2, 0, 1);
    if (a > 0 && (lines.length || typing || C.under)) {
      const bh = C.under ? C.box.h : Math.min(C.box.h, Math.max(1, lines.length) * 16 + 18);   /* over the street only as tall as what is said: the street stays in view */
      const by = C.top ? C.box.y : C.box.y + C.box.h - bh;
      ctx.globalAlpha = a * 0.92; panel(C.box.x, by, C.box.w, bh, 'leather');
      if (!lines.length && C.under) label(TOUCH.on ? 'Nobody has said anything yet. Tap here to chat.' : 'Nobody has said anything yet.', C.box.x + 14, C.box.y + C.box.h / 2, { size: 12, color: PAL.dim });
      lines.forEach((l, i) => {
        const y = C.top ? by + 17 + i * 16 : C.box.y + C.box.h - 16 - (lines.length - 1 - i) * 16, e = l.e;
        if (e.sys) { label(l.txt, C.box.x + 11, y, { size: 13, color: '#cdbfa6' }); return; }
        label(l.txt, C.box.x + 11, y, { size: 13, color: PAL.cream });
        if (l.first) { const nm = e.name + ':'; if (l.txt.startsWith(nm)) label(nm, C.box.x + 11, y, { size: 13, color: e.mine ? PAL.gold : PAL.sky }); }
      });
      ctx.globalAlpha = 1;
    }
    if (typing) {
      const inp = chatInput(); if (S.inPlaced && inp) placeInput(inp, true);   /* (the window may have been resized) */
      panel(C.row.x, C.row.y, C.row.w - 66, C.row.h, 'dark');
      const n = charLen(NET.buf), [before, after] = typedParts(C.row.w - 66 - 66), caret = Math.floor(TIME * 2.5) % 2 ? '' : '▌';
      label(before, C.row.x + 9, C.row.y + 13, { size: 13, color: PAL.cream });
      ctx.font = `13px ${UI}`; const bw = ctx.measureText(before).width;
      if (caret) label(caret, C.row.x + 9 + bw - (after ? 3 : 0), C.row.y + 13, { size: 13, color: PAL.gold });
      if (after) label(after, C.row.x + 9 + bw + 4, C.row.y + 13, { size: 13, color: PAL.cream });
      if (!n) { ctx.globalAlpha = 0.75; label(TOUCH.on ? 'Say something...' : 'Say something  (Enter sends, Esc cancels)', C.row.x + 18, C.row.y + 13, { size: 12, color: PAL.dim }); ctx.globalAlpha = 1; }
      label(`${n}/${CHAT_MAX}`, C.row.x + C.row.w - 72, C.row.y + 13, { align: 'right', size: 11, color: n >= CHAT_MAX ? PAL.bad : PAL.dim });
      button(C.send, 'Send', { hover: inRect(mouse, C.send), size: 13 });
    } else {
      ctx.globalAlpha = 0.9;
      button(C.chat, TOUCH.on ? 'Chat' : 'Chat (Enter)', { hover: inRect(mouse, C.chat), size: 13 });
      button(C.players, `Players (${S.others.size + 1})`, { hover: inRect(mouse, C.players), size: 13 });
      ctx.globalAlpha = 1;
    }
  }
  function drawStatus() {
    const L = statusLayout(), s = L.s;
    panel(s.x, s.y, s.w, s.h, 'leather'); label(L.txt, s.x + 15, s.y + 13, { size: 13, bold: true, color: L.col });
    if (L.badge) { const b = L.badge, hot = inRect(mouse, b); panel(b.x, b.y, b.w, b.h, hot ? 'parch' : 'leather'); ctx.font = `bold 13px ${UI}`; label(fitText(badgeText(), b.w - 24), b.x + 15, b.y + 13, { size: 13, bold: true, color: hot ? PAL.parchInk : canGo() || (!HUB.party.mine && amReady()) ? PAL.good : PAL.gold }); }
  }
  // a panel's buttons: the ones outside any list, or (clip given) the ones of the rows of that list
  function drawButtons(skip, clip) {
    for (const b of panelButtons()) {
      if (!!b.clip !== !!clip || (skip && skip.includes(b.id))) continue;
      button(b.r, b.txt, { hover: !b.off && !S.drag && inRect(mouse, b.r) && (!clip || inRect(mouse, clip)), off: b.off, on: b.on, size: b.size || 15, color: b.color });
    }
  }
  // a scrolling list: its rows (drawn by `rows`) and their buttons clipped to the list's box, soft shadows where
  // there is more above or below, and the scrollbar
  function drawList(L, rows) {
    const v = L.view, M = listMax(L), sc = S.sc[L.key];
    ctx.save(); ctx.beginPath(); ctx.rect(v.x, v.y, v.w, v.h); ctx.clip();
    try { rows(); drawButtons(null, v); } finally { ctx.restore(); }
    if (sc > 0) { const g = ctx.createLinearGradient(0, v.y, 0, v.y + 16); g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(v.x, v.y, v.w, 16); }
    if (sc < M) { const g = ctx.createLinearGradient(0, v.y + v.h - 16, 0, v.y + v.h); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.5)'); ctx.fillStyle = g; ctx.fillRect(v.x, v.y + v.h - 16, v.w, 16); }
    if (M > 0) {
      const b = listBar(L), t = listThumb(L), dragging = S.drag && S.drag.key === L.key && S.drag.off !== undefined, hot = dragging || inRect(mouse, { x: b.x - 4, y: b.y, w: b.w + 8, h: b.h });
      ctx.fillStyle = 'rgba(12,7,4,0.7)'; rr(b.x, b.y, b.w, b.h, 4); ctx.fill();
      ctx.fillStyle = dragging ? PAL.gold : hot ? PAL.brassLt || PAL.brass : PAL.brass; rr(t.x + 1, t.y + 1, t.w - 2, t.h - 2, 3); ctx.fill();
    }
  }
  function shade() { ctx.fillStyle = 'rgba(8,5,3,0.55)'; ctx.fillRect(0, 0, W, H); }
  function drawSoon() {
    const b = soonBox(), [title, text] = SOON[S.soon] || SOON.mp_missions;
    shade(); panel(b.bx, b.by, b.bw, b.bh, 'parch'); banner(title, W / 2, b.by + 4, { size: 30, h: 44, pad: 100 });
    wrapLines(text, b.bw - 70, 15).forEach((l, i) => label(l, W / 2, b.by + 62 + i * 21, { align: 'center', size: 15, color: PAL.parchInk }));
    label('Coming soon', W / 2, b.by + b.bh - 86, { align: 'center', size: 22, bold: true, color: '#8a5a00' });
    drawButtons();
  }
  // F in the street: playing with a friend waits for the Yard (the buttons are shown, switched off)
  function drawFriend() {
    const b = soonBox(), linked = NET.state === 'linked' && NET.friend, name = linked ? String(NET.friend.name || 'your friend').slice(0, 14) : '';
    shade(); panel(b.bx, b.by, b.bw, b.bh, 'parch'); banner('Play with a friend', W / 2, b.by + 4, { size: 28, h: 44, pad: 100 });
    label('Friend battles, trades and visits work from the Yard.', W / 2, b.by + 74, { align: 'center', size: 16, bold: true, color: PAL.parchInk });
    const more = linked ? `You stay connected with ${name} while you are here: walk back to the Yard to play together.` : NET.state === 'off' ? 'Host or join a room at the friend post in your Yard.' : 'Your friend room stays open while you are here: walk back to the Yard to use it.';
    wrapLines(more, b.bw - 70, 14).slice(0, 2).forEach((l, i) => label(l, W / 2, b.by + 104 + i * 19, { align: 'center', size: 14, color: INK_SOFT }));
    drawButtons();
  }
  const INK_SOFT = '#4e3418', ROW_DIM = '#d2c2a4';   /* small print on parchment, and on the dark rows: dark and light enough to read */
  function drawPlayers() {
    let L = playersLayout(); listDrag(L.list); L = playersLayout();
    shade(); panel(L.bx, L.by, L.bw, L.bh, 'leather');
    banner(`Players in the street (${L.total})`, W / 2, L.by + 4, { size: 24, h: 40, pad: 80 });
    drawList(L.list, () => {
      for (const row of L.rows) {
        const o = row.o, y = row.y + row.h / 2; panel(row.x, row.y, row.w, row.h, 'dark');
        ctx.font = `bold 14px ${UI}`; label(fitText(o.name, 112), row.x + 10, y, { size: 14, bold: true, color: row.me ? PAL.gold : isHidden(o) ? PAL.dim : PAL.cream });
        const grp = row.me ? (HUB.party ? ' · group' : '') : o.pt || o.pj ? ' · group' : '';
        ctx.font = `12px ${UI}`; label(fitText(row.me ? `you · ${CLASSES[o.cls].name} · Lv ${o.lv}${grp}` : `${CLASSES[o.cls].name} · Lv ${o.lv}${grp}`, row.w - 128 - (row.me ? 8 : 138)), row.x + 128, y, { size: 12, color: ROW_DIM });
      }
    });
    const more = listMax(L.list) > 0;
    ctx.font = `12px ${UI}`; label(fitText(more ? (TOUCH.on ? 'Drag the list to see everyone · Mute: no chat · Hide: not even their hero' : 'Wheel, drag or ↑ ↓ to scroll  ·  Mute: no chat from them  ·  Hide: not even their hero') : TOUCH.on ? 'Mute: no chat from them · Hide: not even their hero' : 'Mute: no chat from them  ·  Hide: not even their hero  ·  remembered by name', L.bw - 190), L.bx + 22, L.by + L.bh - 35, { size: 12, color: ROW_DIM });
    drawButtons();
  }
  function drawBoard() {
    const B = boardBox(), D = S.board || (S.board = newBoard()), P = HUB.party, x0 = B.bx + 20, iw = B.bw - 40;
    shade(); panel(B.bx, B.by, B.bw, B.bh, 'parch');
    const ink = PAL.parchInk, soft = INK_SOFT;
    if (P) {   /* my group */
      banner(P.kind === 'raid' ? 'Your raid group' : 'Your dungeon group', W / 2, B.by + 4, { size: 28, h: 44, pad: 90 });
      for (let i = 0; i < 4; i++) {
        const id = P.m[i], y = B.by + 56 + i * 48;
        if (!id) {   /* an empty slot: a dashed outline on the parchment, in ink */
          ctx.fillStyle = 'rgba(58,38,20,0.14)'; rr(x0, y, iw, 42, 4); ctx.fill();
          ctx.strokeStyle = 'rgba(58,38,20,0.7)'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); rr(x0 + 1, y + 1, iw - 2, 40, 4); ctx.stroke(); ctx.setLineDash([]);
          label(P.go ? 'empty slot' : 'empty slot · waiting for a player', x0 + 36, y + 21, { size: 14, bold: true, color: soft });
          continue;
        }
        panel(x0, y, iw, 42, 'dark');
        const f = infoOf(id), lead = i === 0, rdy = lead || P.r.includes(id) || (id === me() && amReady());
        label(lead ? '★' : rdy ? '✔' : '…', x0 + 18, y + 21, { align: 'center', size: 16, bold: true, color: lead ? PAL.gold : rdy ? PAL.good : ROW_DIM });
        ctx.font = `bold 15px ${UI}`; label(fitText(f.name + (id === me() ? ' (you)' : ''), iw * 0.42), x0 + 36, y + 21, { size: 15, bold: true, color: PAL.cream });
        ctx.font = `13px ${UI}`; label(fitText(`${CLASSES[f.cls].name} · best pet Lv ${f.lv}`, iw * 0.34), x0 + 36 + iw * 0.44, y + 21, { size: 13, color: ROW_DIM });
        label(lead ? 'Leader' : rdy ? 'Ready' : 'Not ready', x0 + iw - 12, y + 21, { align: 'right', size: 13, bold: true, color: lead ? PAL.gold : rdy ? PAL.good : '#ffb080' });
      }
      const T = tierOf(P.tier), lvs = P.m.map(id => infoOf(id).lv), avg = Math.round(lvs.reduce((a, b) => a + b, 0) / Math.max(1, lvs.length));
      ctx.font = `bold 15px ${UI}`; label(fitText(P.kind === 'raid' ? `Raid: ${T.boss}` : T.name, iw - (P.mine ? 100 : 0)), x0, B.by + 270, { size: 15, bold: true, color: ink });
      ctx.font = `13px ${UI}`; label(fitText(`${P.kind === 'raid' ? T.name + ' · ' : ''}for pets about level ${T.lv} · your group's best pets average level ${avg}`, iw - (P.mine ? 100 : 0)), x0, B.by + 292, { size: 13, color: soft });
      const n = P.m.length, tip = P.pend ? 'Asking the leader...' : P.go ? 'Setting off!' : P.mine ? (n < 2 && !HUB.debugSolo ? 'Waiting for players: others join at this board (2 to 4 players).' : canGo() ? 'Everyone is ready: press Go!' : 'Waiting for everyone to be ready.') : amReady() ? 'Waiting for the leader to press Go.' : 'Press Ready when your team is set.';
      wrapLines(tip, iw, 14, true).slice(0, 2).forEach((l, i) => label(l, x0, B.by + 322 + i * 18, { size: 14, bold: true, color: '#7a2e14' }));
      ctx.font = `13px ${UI}`; label(fitText(TOUCH.on ? 'You can walk around: your group stays (tap the group badge to come back).' : 'You can walk around: your group stays. G opens this again.', iw), x0, B.by + B.bh - 72, { size: 13, color: soft });
    } else if (D.view === 'new') {
      banner(D.kind === 'raid' ? 'Open a raid group' : 'Open a dungeon group', W / 2, B.by + 4, { size: 28, h: 44, pad: 90 });
      drawButtons(['open', 'back', 'close']);
      for (let t = 1; t <= 4; t++) {
        const T = tierOf(t), y = B.by + 62 + (t - 1) * 60;
        ctx.font = `bold 15px ${UI}`; label(fitText(D.kind === 'raid' ? T.boss : T.name, iw - 40), x0 + 20, y + 19, { size: 15, bold: true, color: D.tier === t ? PAL.gold : PAL.cream });
        ctx.font = `12px ${UI}`; label(fitText(`${D.kind === 'raid' ? T.name + ' · ' : ''}for pets about level ${T.lv}`, iw - 40), x0 + 20, y + 38, { size: 12, color: ROW_DIM });
      }
      label(fitText(`Every tier is open to everyone. Your best pet is level ${myLv()}.`, iw), x0, B.by + 62 + 4 * 60 + 14, { size: 13, color: soft });
      for (const b of panelButtons()) if (['open', 'back', 'close'].includes(b.id)) button(b.r, b.txt, { hover: inRect(mouse, b.r), size: 15, color: b.color });
    } else {
      banner(D.kind === 'raid' ? 'Raid Board' : 'Dungeon Board', W / 2, B.by + 4, { size: 30, h: 44, pad: 100 });
      listDrag(boardList()); const L = boardList(), list = L.items, v = L.view;
      ctx.font = `13px ${UI}`; label(fitText(D.kind === 'raid' ? 'Groups of 2-4 gathering to fight a raid boss together:' : 'Groups of 2-4 gathering to explore a dungeon together:', iw), x0, B.by + 54, { size: 13, color: soft });
      if (!isOpen()) wrapLines('You need to be connected to the Kingdom Street to form a group. ' + (HUB.room ? 'Connecting...' : 'Press E at the notice post to try again.'), iw - 20, 15, true).forEach((l, i) => label(l, W / 2, B.by + 130 + i * 22, { align: 'center', size: 15, bold: true, color: '#7a2e14' }));
      else if (!list.length) { label('No group is open right now.', W / 2, B.by + 140, { align: 'center', size: 16, bold: true, color: ink }); label('Open one and wait for others to join!', W / 2, B.by + 166, { align: 'center', size: 14, color: soft }); }
      drawList(L, () => list.forEach((g, i) => {
        const y = boardRowY(L, i), T = tierOf(g.pt.tier); if (!rowSeen(L, y, 62)) return;
        panel(v.x, y, v.w, 62, 'dark');
        ctx.font = `bold 15px ${UI}`; label(fitText(`${nameOf(g.leader)}'s group  ·  ${g.pt.m.length}/4`, v.w - 130), v.x + 14, y + 16, { size: 15, bold: true, color: PAL.gold });
        ctx.font = `13px ${UI}`; label(fitText((D.kind === 'raid' ? T.boss : T.name) + `  ·  level ${T.lv}`, v.w - 130), v.x + 14, y + 35, { size: 13, color: PAL.cream });
        ctx.font = `12px ${UI}`; label(fitText(g.pt.m.map(nameOf).join(', '), v.w - 130), v.x + 14, y + 51, { size: 12, color: ROW_DIM });
        if (g.leader === me()) label('yours', v.x + v.w - 16, y + 31, { align: 'right', size: 13, bold: true, color: PAL.good });
      }));
      const more = listMax(L) > 0 ? (TOUCH.on ? `${list.length} groups: drag the list to see them all.` : `${list.length} groups  ·  wheel, drag or ↑ ↓ to scroll  ·  O: open a group  ·  1-4: join`) : '';
      if (!hasTeam()) label(fitText('Put an animal in your team first (the post by the gate in your Yard).', iw), x0, B.by + B.bh - 72, { size: 13, bold: true, color: '#7a2e14' });
      else { ctx.font = `13px ${UI}`; label(fitText(more || (TOUCH.on ? `Your best pet is level ${myLv()}.` : `Your best pet is level ${myLv()}.  ·  O: open a group  ·  1-4: join  ·  Esc: close`), iw), x0, B.by + B.bh - 72, { size: 13, color: soft }); }
    }
    if (P || D.view !== 'new') drawButtons();
  }
  // the street's HUD and windows (from drawHubPanels: landscape and portrait)
  function drawUI() {
    if (!inStreet()) return;
    if (S.drag && !curList()) S.drag = null;
    if (!G.panel && !PK && !G.coll && (G.mode === 'play' || G.mode === 'trans')) { drawStatus(); drawChat(); }
    if (G.panel === 'mpsoon') drawSoon();
    else if (G.panel === 'mpfriend') drawFriend();
    else if (G.panel === 'mpplayers') drawPlayers();
    else if (G.panel === 'mpboard') drawBoard();
  }
  HUB.drawUI = drawUI;
  // for the tests and the console
  HUB._ = { S, PLACES, censor, cleanText, liveText, charLen, cleanPt, cleanInfo, panelButtons, chatRects, badgeRect, statusRect, statusLayout, playersLayout, boardList, boardBox, curList, listMax, listBar, listThumb, status, visibleLines, tierOf, tripLine, amReady, canGo, BAD_WORDS };
})();
