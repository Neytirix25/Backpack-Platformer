// =====================================================================
//  MP.net: HOST-RELAY ROOMS (the network layer under the Kingdom Street hub and the co-op parties)
// =====================================================================
//  A room is a star: whoever claims the room's id first is the HOST, everyone else holds ONE connection to the host,
//  and the host relays everything (stamping `from`, so a guest can't pretend to be somebody else). This file knows
//  nothing about the game except loadPeerLib() (index.html) for PeerJS. Everything that arrives is treated as hostile:
//  shapes and sizes are checked, and nothing here ever throws into the caller.
//
//  HOW A JOIN WORKS
//    hub rooms (opts.prefix): ids prefix+1, prefix+2, ... For n = 1..50: claim prefix+n (you are its host); taken ->
//    connect to it; its host answers '~full' -> try n+1. Fixed rooms (opts.id): the same with one id, and a full one is
//    an error. (Claim first because the PeerJS broker says "taken" at once but needs ~5 s to say "nobody has that id".) Lost races (someone claimed just before you, the host died just before you) are simply retried,
//    for up to T.give ms, then the room ends in state 'error' (room.err = text, room.errCode = 'unreachable' | 'full' |
//    'offline' | 'kicked' | 'refused').
//  HOST MIGRATION
//    When the host says '~bye', closes, or is silent for T.hostDead ms, every remaining member goes to state
//    'migrating' and re-runs the join for the SAME id, staggered by join order: the oldest member claims at once, the
//    k-th oldest only after k * T.stagger ms (+ jitter), and until its turn comes it just tries to connect to whoever
//    got the id. Everyone keeps uid, presence, fast state and join order. The new host keeps the instance number and
//    the old roster: members who haven't come back yet stay listed (their slot is reserved and '~m' messages for them
//    are kept, up to T.queue each) for T.grace ms, then they are dropped with 'leave'. When a member is settled it
//    gets { type: 'host', id }. room.send() while migrating QUEUES up to T.queue messages (more are refused, send()
//    returns false) and they go out as soon as the room is open again.
//  THE WIRE (every frame is a JSON object with a string `t`; all of the layer's own types start with '~', and
//  application messages may not, so the two can never collide)
//    guest -> host   ~hello { v, id, k, p, f, seq, mig }   first frame: my uid, my secret key, presence, fast state
//                    ~pres  { p }          my whole presence        ~fast { f }    my fast state (10x/s at most)
//                    ~m     { m, to }      an application message (to = a uid, or absent = everyone else)
//                    ~ping                 every T.ping ms          ~bye           polite goodbye
//    host -> guest   ~welcome { v, n, host, you, r: [{ id, p, f, seq, h }] }      the whole roster (h = hash of that
//                                          member's key: only whoever knows the key may reconnect under that uid)
//                    ~full  ~no { why }    refused (room full / bad hello or a uid that belongs to somebody else)
//                    ~join { id, p, f, seq, h }   ~leave { id }   ~pres { id, p }   ~fast { s: { uid: f, ... } }
//                    ~m { from, m }        ~pong   ~bye (the host is leaving: migrate now)   ~kick { why }
//  BACKENDS (one tiny interface: claim(id) -> Promise<{ onConn(cb), close(), onLost?(cb) }>, rejects { type: 'taken' };
//  connect(id, ms) -> Promise<conn>, rejects { type: 'nohost' }; conn = { send(obj), close(), onData(cb), onClose(cb) })
//    'peer'  PeerJS 1.5.4 (WebRTC data channels through the public PeerJS broker): the default. Frames longer than
//            T.chunk characters are cut into pieces (PeerJS's JSON channel refuses 16300 bytes or more).
//    'bc'    BroadcastChannel('bps-mpnet'): several tabs of ONE browser, no internet (?mpnet=bc in the address). Keep
//            the tabs in separate visible windows: browsers slow the timers of hidden tabs (batches drop to 1 a second).
//    'mem'   an in-memory registry shared by several copies of the game in one node process (window.__MPMEM, given
//            through bootGame({ globals: { __MPMEM: {} } }) to every copy). Tests can kill a host without a goodbye:
//            __MPMEM.kill(roomId)  (its guests see the connection close),  __MPMEM.kill(roomId, true)  (silently: only
//            the heartbeat notices), and __MPMEM.lag = ms keeps a killed id 'taken' for a while like the PeerJS broker.
//  EVENTS (opts.on): { type: 'state', state } · { type: 'join', id } (also once for every member already there when
//  you arrive: those come BEFORE the 'open' state event) · { type: 'leave', id } · { type: 'presence', id } (others
//  only) · { type: 'fast' } · { type: 'msg', from, msg } · { type: 'host', id } · { type: 'closed', why, text }
//  (why = 'left' after leave(), else room.errCode: the room is over, call join() to start again).
//  MP.net.T holds every timing (ms) and limit; tests shrink them.
(() => {
'use strict';
const T = { pump: 100, pres: 200, fast: 100, ping: 4000, hostDead: 10000, guestDead: 12000, hello: 6000, conn: 12000, connMig: 6000,
            connEarly: 2500, stagger: 1200, jitter: 300, retry: 700, give: 20000, grace: 8000, bye: 450, linger: 300, queue: 32,
            reconn: 1000, bcClaim: 300, bcConn: 800, bcPing: 1000, bcDead: 3500, chunk: 3500,
            rate: 40, burst: 80, kick: 120, maxPres: 4000, maxFast: 600, instances: 50 };
const ERR_TEXT = { full: 'That room is full.', unreachable: "Couldn't reach the room. Check your internet connection.", offline: "Couldn't reach the multiplayer service. Are you online?",
                   kicked: 'You were removed from the room.', refused: 'The room refused the connection.' };
const now = () => Date.now();
// (the game swaps Math.random for seeded dice during battles: ids and jitter must not use it)
const rnd = typeof NATIVE_RANDOM === 'function' ? NATIVE_RANDOM : Math.random;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
function rid(n) {
  const a = new Uint8Array(n); let s = '';
  try { window.crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < n; i++) a[i] = Math.floor(rnd() * 256); }
  for (let i = 0; i < n; i++) s += ID_CHARS[a[i] % 36];
  return s;
}
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const okId = v => typeof v === 'string' && /^[a-z0-9]{4,24}$/.test(v);
const size = o => { try { return JSON.stringify(o).length; } catch (e) { return Infinity; } };
const int = (v, lo, hi, d) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : d);
// a small one-way hash (cyrb53 style) of a member's secret key: the roster carries it, so a new host can check returning members
function hash(s) {
  let a = 0xdeadbeef, b = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (b >>> 0).toString(36) + '.' + (a >>> 0).toString(36);
}
const UID = rid(10), KEY = rid(20), KEY_HASH = hash(KEY);

// ---------- one connection, whatever the backend: buffers what arrives before somebody listens ----------
function mkConn(send, close) {
  let dcb = null, ccb = null; const buf = [];
  const c = { open: true, gone: false,
    send(o) { if (c.open) try { send(o); } catch (e) {} },
    close() { if (!c.open) return; c.open = false; try { close(); } catch (e) {} },
    onData(f) { dcb = f; while (f && dcb === f && buf.length && c.open) f(buf.shift()); },
    onClose(f) { ccb = f; },
    _in(m) { if (!c.open) return; if (dcb) dcb(m); else if (buf.length < 64) buf.push(m); },
    _closed() { if (c.gone) return; c.gone = true; const was = c.open; c.open = false; if (was && ccb) ccb(); } };
  return c;
}

// ---------- backend 'mem': several copies of the game in one node process ----------
// The registry only ever carries STRINGS between copies (each side parses in its own realm), delivered with setTimeout 0.
function memBackend(R) {
  if (!R.holders) {
    R.holders = {}; R.lag = R.lag || 0;
    R.kill = (id, silent) => {
      const h = R.holders[id]; if (!h || h.dead) return false;
      h.dead = true; h.accept = null;
      if (R.lag > 0) setTimeout(() => { if (R.holders[id] === h) delete R.holders[id]; }, R.lag); else delete R.holders[id];
      for (const l of h.links) if (l.open) { l.open = false; if (!silent && l.a.closed) setTimeout(l.a.closed, 0); }
      return true;
    };
  }
  const end = (link, mine, theirs) => {
    const c = mkConn(o => { const s = JSON.stringify(o); setTimeout(() => { if (link.open && link[theirs].recv) link[theirs].recv(s); }, 0); },
                     () => { setTimeout(() => { if (!link.open) return; link.open = false; if (link[theirs].closed) link[theirs].closed(); }, 0); });
    link[mine].recv = s => c._in(JSON.parse(s)); link[mine].closed = () => c._closed();
    return c;
  };
  return { name: 'mem',
    claim: id => new Promise((ok, fail) => {
      if (R.holders[id]) return fail({ type: 'taken' });
      const h = R.holders[id] = { accept: null, links: [], dead: false };
      ok({ onConn(f) { if (!h.dead) h.accept = link => f(end(link, 'b', 'a')); },
           close() { h.dead = true; h.accept = null; if (R.holders[id] === h) delete R.holders[id]; } });
    }),
    connect: id => new Promise((ok, fail) => {
      const h = R.holders[id]; if (!h || h.dead || !h.accept) return fail({ type: 'nohost' });
      const link = { open: true, a: {}, b: {} }, c = end(link, 'a', 'b'); h.links.push(link);
      setTimeout(() => { if (h.dead || !h.accept) { link.open = false; c._closed(); } else h.accept(link); }, 0);
      ok(c);
    }) };
}

// ---------- backend 'bc': tabs of one browser talking over a BroadcastChannel (no internet needed) ----------
// frames: who { id, ts } "does anyone hold this id?" · held { id } "yes" · conn { id, cid } / ok { cid } open a virtual
// connection · d { cid, m: json } data · p / q { cid } ping / pong (the pong is sent from the message handler, so a
// background tab with throttled timers still counts as alive) · x { cid } closed. A connection silent for T.bcDead ms is gone.
function bcBackend() {
  const ch = new window.BroadcastChannel('bps-mpnet'), tab = rid(8);
  const held = new Map(), claiming = new Map(), waits = new Map(), conns = new Map(); let iv = null;
  const post = o => { o.from = tab; try { ch.postMessage(o); } catch (e) {} };
  const tick = () => {
    const t = now();
    for (const [cid, rec] of [...conns]) { if (t - rec.heard > T.bcDead) { conns.delete(cid); rec.conn._closed(); } else post({ k: 'p', cid, to: rec.peer }); }
    if (!conns.size && iv) { clearInterval(iv); iv = null; }
  };
  const mk = (cid, peer) => {
    const rec = { peer, heard: now(), conn: mkConn(o => post({ k: 'd', cid, to: peer, m: JSON.stringify(o) }), () => { conns.delete(cid); post({ k: 'x', cid, to: peer }); }) };
    conns.set(cid, rec); if (!iv) iv = setInterval(tick, T.bcPing);
    return rec.conn;
  };
  ch.onmessage = ev => {
    const d = ev.data; if (!isObj(d) || typeof d.from !== 'string' || d.from === tab || (d.to && d.to !== tab)) return;
    const rec = typeof d.cid === 'string' ? conns.get(d.cid) : null; if (rec && rec.peer === d.from) rec.heard = now();
    if (d.k === 'who') {
      // I hold it, or I asked first (the same computer's clock orders two tabs asking at once; the tab id breaks a tie)
      const mine = claiming.get(d.id);
      if (held.has(d.id) || (mine && (mine.ts < d.ts || (mine.ts === d.ts && tab < d.from)))) post({ k: 'held', id: d.id, to: d.from });
    } else if (d.k === 'held') { const c = claiming.get(d.id); if (c) c.taken(); }
    else if (d.k === 'conn') { const h = held.get(d.id); if (h && h.cb && typeof d.cid === 'string' && !conns.has(d.cid)) { const c = mk(d.cid, d.from); post({ k: 'ok', cid: d.cid, to: d.from }); h.cb(c); } }
    else if (d.k === 'ok') { const w = waits.get(d.cid); if (w) w(d.from); }
    else if (!rec || rec.peer !== d.from) return;
    else if (d.k === 'd') { let m = null; try { m = JSON.parse(d.m); } catch (e) { return; } rec.conn._in(m); }
    else if (d.k === 'p') post({ k: 'q', cid: d.cid, to: d.from });
    else if (d.k === 'x') { conns.delete(d.cid); rec.conn._closed(); }
  };
  const bye = () => { for (const [cid, rec] of conns) post({ k: 'x', cid, to: rec.peer }); conns.clear(); held.clear(); };
  try { window.addEventListener('pagehide', bye); window.addEventListener('beforeunload', bye); } catch (e) {}
  return { name: 'bc',
    claim: id => new Promise((ok, fail) => {
      if (held.has(id) || claiming.has(id)) return fail({ type: 'taken' });
      const ts = now(), t = setTimeout(() => {
        claiming.delete(id); const h = { cb: null }; held.set(id, h);
        ok({ onConn(f) { h.cb = f; }, close() { if (held.get(id) === h) held.delete(id); h.cb = null; } });
      }, T.bcClaim);
      claiming.set(id, { ts, taken() { clearTimeout(t); claiming.delete(id); fail({ type: 'taken' }); } });
      post({ k: 'who', id, ts });
    }),
    connect: id => new Promise((ok, fail) => {
      const cid = tab + '-' + rid(6), t = setTimeout(() => { waits.delete(cid); fail({ type: 'nohost' }); }, T.bcConn);
      waits.set(cid, from => { clearTimeout(t); waits.delete(cid); ok(mk(cid, from)); });
      post({ k: 'conn', id, cid });
    }) };
}

// ---------- backend 'peer': PeerJS (the same library and broker the friend rooms use; this never touches NET's own peer) ----------
// claim(id) = a Peer created WITH that id ('unavailable-id' = taken); connect(id) = a Peer with a random id that connects
// to it ('peer-unavailable' = nobody holds it). Each guest connection owns its Peer and destroys it when it closes.
function peerBackend() {
  const lib = () => { try { return Promise.resolve(loadPeerLib()).catch(() => { throw { type: 'fatal', code: 'offline' }; }); } catch (e) { return Promise.reject({ type: 'fatal', code: 'offline' }); } };
  const destroy = p => { try { p.destroy(); } catch (e) {} };
  const bad = e => (e && e.type === 'browser-incompatible' ? { type: 'fatal', code: 'offline' } : { type: 'error', err: e && e.type });
  // the broker's socket dropped (the data channels live on): keep asking for it back, gently
  const keepAlive = (peer, dead) => peer.on('disconnected', () => setTimeout(() => { if (!dead() && !peer.destroyed && peer.disconnected) try { peer.reconnect(); } catch (e) {} }, T.reconn * (1 + rnd())));
  // PeerJS's JSON channel refuses frames of 16300 bytes or more (and reports that as an error on the connection), so a
  // long frame (a roster with 20 presences, a battle snapshot) travels in pieces: { '~c': id, i, n, d: part of the JSON }
  const wrap = (dc, peer) => {
    let out = 0, cur = null;
    const c = mkConn(o => {
      if (!dc.open) return;
      const s = JSON.stringify(o); if (typeof s !== 'string') return;
      if (s.length <= T.chunk) { dc.send(o); return; }
      const n = Math.ceil(s.length / T.chunk), id = ++out; if (n > 200) return;
      for (let i = 0; i < n; i++) dc.send({ '~c': id, i, n, d: s.substr(i * T.chunk, T.chunk) });
    }, () => { try { dc.close(); } catch (e) {} if (peer) destroy(peer); });
    const data = d => {
      if (!isObj(d) || typeof d['~c'] !== 'number') { cur = null; c._in(d); return; }
      if (d.i === 0 && Number.isInteger(d.n) && d.n > 1 && d.n <= 200) cur = { id: d['~c'], n: d.n, parts: [] };
      if (!cur || cur.id !== d['~c'] || d.i !== cur.parts.length || typeof d.d !== 'string' || d.d.length > 20000) { cur = null; return; }
      cur.parts.push(d.d); if (cur.parts.length < cur.n) return;
      let m; try { m = JSON.parse(cur.parts.join('')); } catch (e) { cur = null; return; }
      cur = null; c._in(m);
    };
    dc.on('data', data); dc.on('close', () => { c._closed(); if (peer) destroy(peer); }); dc.on('error', () => { c._closed(); if (peer) destroy(peer); });
    return c;
  };
  return { name: 'peer',
    claim: id => lib().then(() => new Promise((ok, fail) => {
      let done = false, dead = false, cb = null, lost = null; const early = [];
      const peer = new window.Peer(id, { debug: 0 });
      const to = setTimeout(() => { if (!done) { done = true; dead = true; destroy(peer); fail({ type: 'timeout' }); } }, T.conn);
      const gone = () => { if (dead) return; dead = true; destroy(peer); if (lost) lost(); };
      peer.on('open', () => {
        if (done) return; done = true; clearTimeout(to);
        // close(): stop taking guests now, but give the goodbyes already sent a moment before the channels are cut
        ok({ onConn(f) { cb = f; early.splice(0).forEach(f); }, onLost(f) { lost = f; }, close() { if (dead) return; dead = true; setTimeout(() => destroy(peer), T.linger + 100); } });
      });
      peer.on('connection', dc => {
        if (dead) { try { dc.close(); } catch (e) {} return; }
        const c = wrap(dc, null); let opened = false;
        const t = setTimeout(() => { if (!opened) c.close(); }, T.conn);
        dc.on('open', () => { opened = true; clearTimeout(t); if (dead) c.close(); else if (cb) cb(c); else early.push(c); });
      });
      peer.on('error', e => {
        if (!done) { done = true; dead = true; clearTimeout(to); destroy(peer); fail(e && e.type === 'unavailable-id' ? { type: 'taken' } : bad(e)); }
        else if (e && e.type === 'unavailable-id') gone();   /* the broker gave my id to somebody else while I was away */
      });
      peer.on('close', () => { if (done) gone(); });
      keepAlive(peer, () => dead);
    })),
    connect: (id, ms) => lib().then(() => new Promise((ok, fail) => {
      let done = false, shut = false;
      const peer = new window.Peer({ debug: 0 });
      const end = (err, c) => { if (done) return; done = true; clearTimeout(to); if (err) { shut = true; destroy(peer); fail(err); } else ok(c); };
      const to = setTimeout(() => end({ type: 'timeout' }), ms || T.conn);
      peer.on('open', () => {
        if (done) return;
        const dc = peer.connect(id, { reliable: true, serialization: 'json' }), c = wrap(dc, peer);
        c.onClose(() => end({ type: 'nohost' }));
        dc.on('open', () => { c.onClose(null); end(null, c); });
      });
      peer.on('error', e => end(e && e.type === 'peer-unavailable' ? { type: 'nohost' } : bad(e)));
      keepAlive(peer, () => shut || peer.destroyed);
    })) };
}

// ---------- which backend ----------
const MAKE = { peer: peerBackend, bc: bcBackend, mem: () => memBackend(window.__MPMEM || (window.__MPMEM = {})) };
let BE = null, forced = null;
function backend() {
  if (BE) return BE;
  let name = forced;
  if (!name) { const q = /[?&]mpnet=(\w+)/.exec((window.location && window.location.search) || ''); name = window.__MPMEM ? 'mem' : q && MAKE[q[1]] ? q[1] : 'peer'; }
  if (name === 'bc' && !window.BroadcastChannel) name = 'peer';
  return (BE = MAKE[name]());
}

// ---------- a room ----------
function room(opts) {
  opts = opts || {};
  const fixed = typeof opts.id === 'string' && opts.id ? opts.id : null, prefix = fixed ? null : String(opts.prefix || 'bps-room-');
  const cap = int(opts.cap, 1, 100, 20), maxMsg = int(opts.maxMsg, 100, 200000, 16000), on = typeof opts.on === 'function' ? opts.on : () => {};
  const me = UID, mine = { id: me, p: {}, f: null, seq: 0 };
  if (isObj(opts.presence)) try { Object.assign(mine.p, JSON.parse(JSON.stringify(opts.presence))); } catch (e) {}
  const r = { state: 'idle', err: '', errCode: '', isHost: false, hostId: null, me, n: 0, id: fixed || '', cap, maxMsg, members: new Map([[me, mine]]) };
  const members = r.members;
  // host side: conns uid -> { c, tok, at, last, strikes } · pend = connections that haven't said hello · ghosts uid -> kept messages
  const conns = new Map(), pend = new Set(), ghosts = new Map(), keys = new Map(), dirty = new Set();
  let gen = 0, holder = null, hconn = null, ghostEnd = 0, nextSeq = 1, queue = [], iv = null, sleeper = null, shaking = null;
  let fastSent = 'null', fastAt = 0, presDirty = false, presAt = 0, pingAt = 0, heard = 0, oldHost = null, lastId = '';

  const emit = ev => { try { on(ev); } catch (e) { try { console.error(e); } catch (e2) {} } };
  const setState = s => {
    if (r.state === s) return; r.state = s;
    if (s === 'open') { if (!iv) iv = setInterval(r.pump, T.pump); } else if (iv) { clearInterval(iv); iv = null; }
    emit({ type: 'state', state: s });
  };
  const sleep = ms => new Promise(ok => { const s = sleeper = { ok, t: setTimeout(() => { if (sleeper === s) sleeper = null; ok(); }, Math.max(0, ms)) }; });
  const shut = (c, linger) => { if (!c) return; c.onData(() => {}); c.onClose(null); if (linger) setTimeout(() => c.close(), T.linger); else c.close(); };
  // drop every connection and timer (the roster stays: a migration needs it)
  function teardown(linger) {
    gen++;
    if (sleeper) { clearTimeout(sleeper.t); const s = sleeper; sleeper = null; s.ok(); }
    if (shaking) shaking();
    if (iv) { clearInterval(iv); iv = null; }
    if (holder) { const h = holder; holder = null; try { h.close(); } catch (e) {} }
    shut(hconn, linger); hconn = null;
    for (const k of conns.values()) shut(k.c, linger); conns.clear();
    for (const p of pend) { clearTimeout(p.t); shut(p.c); } pend.clear();
    ghosts.clear(); dirty.clear();
  }
  function fail(code) {
    teardown(); queue = []; r.isHost = false; r.err = ERR_TEXT[code] || ERR_TEXT.unreachable; r.errCode = code;
    setState('error'); emit({ type: 'closed', why: code, text: r.err });
  }
  const forget = id => { if (id === me || !members.delete(id)) return; keys.delete(id); ghosts.delete(id); dirty.delete(id); emit({ type: 'leave', id }); };
  const cleanP = p => (isObj(p) && size(p) <= T.maxPres ? p : {});
  const cleanF = f => (isObj(f) && size(f) <= T.maxFast ? f : null);

  // ----- finding the room: claim it or connect to whoever holds it (first join and migration share this loop) -----
  function shake(c, mig) {
    return new Promise((ok, no) => {
      const done = w => { clearTimeout(t); shaking = null; c.onData(null); c.onClose(null); if (w) ok(w); else no(); };
      const t = setTimeout(() => done(null), T.hello);
      shaking = () => done(null);
      c.onClose(() => done(null));
      c.onData(m => { if (isObj(m) && (m.t === '~full' || m.t === '~no' || (m.t === '~welcome' && okId(m.host) && Array.isArray(m.r)))) done(m); });
      c.send({ t: '~hello', v: 1, id: me, k: KEY, p: mine.p, f: cleanF(mine.f), seq: mine.seq, mig: mig ? 1 : 0 });
    });
  }
  async function seek(g, mig, rank, polite) {
    const live = () => g === gen;
    let be; try { be = backend(); } catch (e) { return fail('offline'); }
    let n = mig && r.n ? r.n : 1, t0 = now(), claimFirst = opts.first !== 'connect';
    let claimAt = mig ? t0 + (polite ? T.bye : 0) + Math.min(rank, 10) * T.stagger + (rank ? rnd() * T.jitter : 0) : 0;
    if (mig) { await sleep((polite ? T.bye : 0) + (rank ? T.stagger * 0.5 + rnd() * T.jitter : 0)); if (!live()) return; }
    for (;;) {
      const id = fixed || prefix + n, same = mig && id === lastId; let full = false, fatal = null;
      const tryClaim = async () => {
        let h; try { h = await be.claim(id); } catch (e) { if (e && e.type === 'fatal') fatal = e.code || 'offline'; return false; }
        if (!live()) { try { h.close(); } catch (e) {} return true; }
        beHost(h, id, n, same); return true;
      };
      const tryConn = async () => {
        let c, w; try { c = await be.connect(id, !mig ? T.conn : now() < claimAt ? Math.max(T.connEarly, claimAt - now()) : T.connMig); } catch (e) { if (e && e.type === 'fatal') fatal = e.code || 'offline'; return false; }
        if (!live()) { c.close(); return true; }
        try { w = await shake(c, same); } catch (e) { c.close(); return !live(); }
        if (!live()) { c.close(); return true; }
        if (w.t === '~welcome') { beGuest(c, id, n, w, same); return true; }
        shut(c); if (w.t === '~full') full = true; else fatal = 'refused';
        return false;
      };
      if (claimFirst && now() >= claimAt && await tryClaim()) return;
      if (!live()) return;
      if (!fatal && await tryConn()) return;
      if (!live()) return;
      if (!claimFirst && !full && !fatal && await tryClaim()) return;
      if (!live()) return;
      if (fatal) return fail(fatal);
      if (full) { if (fixed || n >= T.instances) return fail('full'); n++; t0 = now(); claimAt = 0; continue; }
      if (now() - t0 > T.give) return fail('unreachable');
      await sleep(T.retry + rnd() * T.jitter); if (!live()) return;
    }
  }
  function settle() {
    const mig = r.state === 'migrating'; heard = pingAt = now(); fastSent = ''; setState('open');
    if (mig) emit({ type: 'host', id: r.hostId });
    const q = queue; queue = []; for (const [m, to] of q) sendNow(m, to);
    if (presDirty) flushPres(now());
  }
  function beHost(h, id, n, same) {
    holder = h; r.isHost = true; r.hostId = me; r.n = fixed ? 0 : n; r.id = id; lastId = id; conns.clear(); dirty.clear(); ghosts.clear();
    if (same) {
      // I was a member of this very room: keep its roster, the others have T.grace ms to come back to me
      if (oldHost && oldHost !== me) forget(oldHost);
      for (const e of members.values()) if (e.id !== me) { ghosts.set(e.id, []); nextSeq = Math.max(nextSeq, e.seq + 1); }
      nextSeq = Math.max(nextSeq, mine.seq + 1); ghostEnd = now() + T.grace;
    } else { for (const id2 of [...members.keys()]) forget(id2); mine.seq = 0; nextSeq = 1; }
    h.onConn(c => accept(h, c));
    if (h.onLost) h.onLost(() => { if (holder === h) migrate(false); });
    settle();
  }
  function beGuest(c, id, n, w, same) {
    hconn = c; r.isHost = false; r.hostId = w.host; r.n = fixed ? 0 : int(w.n, 1, T.instances, n); r.id = id; lastId = id;
    mine.seq = int(w.you, 0, 1e9, mine.seq);
    const seen = new Set([me]);
    for (const e of w.r.slice(0, 400)) {
      if (!isObj(e) || !okId(e.id) || e.id === me) continue;
      seen.add(e.id); if (typeof e.h === 'string') keys.set(e.id, e.h.slice(0, 40));
      const had = members.get(e.id), v = { id: e.id, p: cleanP(e.p), f: cleanF(e.f), seq: int(e.seq, 0, 1e9, 0) };
      if (had) Object.assign(had, v); else members.set(e.id, v);
      emit({ type: had ? 'presence' : 'join', id: e.id });
    }
    for (const id2 of [...members.keys()]) if (!seen.has(id2)) forget(id2);
    c.onClose(() => { if (hconn === c) migrate(false); });
    c.onData(m => { try { guestData(c, m); } catch (e) { try { console.error(e); } catch (e2) {} } });
    settle();
    if (c.gone && hconn === c) migrate(false);
  }
  // the host is gone (or I am a host who lost the id): everyone still here looks for the room again, oldest first
  function migrate(polite) {
    if (r.state !== 'open') return;
    oldHost = r.isHost ? null : r.hostId;
    const order = [...members.values()].filter(e => e.id !== oldHost).sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1));
    const rank = Math.max(0, order.findIndex(e => e.id === me));
    teardown(); r.isHost = false; setState('migrating');
    seek(gen, true, rank, polite);
  }

  // ----- the host's side -----
  const cast = (w, except) => {
    for (const [id, k] of conns) if (id !== except) k.c.send(w);
    if (w.t === '~m') for (const [id, q] of ghosts) if (id !== except && q.length < T.queue) q.push(w);
  };
  const sendTo = (id, w) => { const k = conns.get(id), q = ghosts.get(id); if (k) k.c.send(w); else if (q && w.t === '~m' && q.length < T.queue) q.push(w); };
  const roster = () => [...members.values()].map(e => ({ id: e.id, p: e.p, f: cleanF(e.f), seq: e.seq, h: e.id === me ? KEY_HASH : keys.get(e.id) }));
  function accept(h, c) {
    if (holder !== h || r.state !== 'open' || pend.size >= 40) { c.close(); return; }
    const pd = { c, t: setTimeout(() => { pend.delete(pd); shut(c); }, T.hello) }; pend.add(pd);
    c.onClose(() => { clearTimeout(pd.t); pend.delete(pd); });
    c.onData(m => { clearTimeout(pd.t); pend.delete(pd); c.onData(null); c.onClose(null); try { hello(c, m); } catch (e) { shut(c); } });
  }
  function hello(c, m) {
    const refuse = (t, why) => { c.send({ t, why }); shut(c, true); };
    if (!isObj(m) || m.t !== '~hello' || !okId(m.id) || m.id === me || typeof m.k !== 'string' || m.k.length < 8 || m.k.length > 40) return refuse('~no', 'hello');
    const id = m.id, kh = hash(m.k), had = members.get(id);
    if (had && keys.has(id) && keys.get(id) !== kh) return refuse('~no', 'key');
    if (!had && members.size >= cap) return refuse('~full');
    const p = cleanP(m.p), f = cleanF(m.f); let e = had;
    if (e) { const old = conns.get(id); if (old) shut(old.c); e.p = p; e.f = f; }
    else {
      const used = s => { for (const x of members.values()) if (x.seq === s) return true; return false; };
      const seq = m.mig && Number.isInteger(m.seq) && m.seq >= 0 && m.seq < 1e9 && !used(m.seq) ? m.seq : nextSeq;
      nextSeq = Math.max(nextSeq, seq + 1); e = { id, p, f, seq }; members.set(id, e);
    }
    keys.set(id, kh);
    const q = ghosts.get(id); ghosts.delete(id);
    conns.set(id, { c, tok: T.burst, at: now(), last: now(), strikes: 0 });
    c.onClose(() => hostDrop(id, c));
    c.onData(d => { try { hostData(id, c, d); } catch (err) { try { console.error(err); } catch (e2) {} } });
    c.send({ t: '~welcome', v: 1, n: r.n, host: me, you: e.seq, r: roster() });
    if (q) for (const w of q) c.send(w);
    cast({ t: '~join', id, p, f, seq: e.seq, h: kh }, id);
    emit({ type: had ? 'presence' : 'join', id });
  }
  // ONE batch with every fast state that changed, at most every T.fast ms. It also goes out from the message handler
  // (not only from the timer), so a host whose tab is hidden (timers slowed to 1 a second) still relays smoothly.
  function flushFast(t) {
    if (!dirty.size || t - fastAt < T.fast - 15) return;
    fastAt = t; const s = {}; let others = false;
    for (const id of dirty) { const e = members.get(id); if (e) { s[id] = e.f; if (id !== me) others = true; } }
    dirty.clear(); cast({ t: '~fast', s }); if (others) emit({ type: 'fast' });
  }
  function hostDrop(id, c, why) {
    const k = conns.get(id); if (!k || k.c !== c) return;
    conns.delete(id); if (why) c.send({ t: '~kick', why }); shut(c, !!why);
    if (members.delete(id)) { keys.delete(id); dirty.delete(id); cast({ t: '~leave', id }); emit({ type: 'leave', id }); }
  }
  function hostData(id, c, m) {
    const k = conns.get(id), e = members.get(id); if (!k || k.c !== c || !e) return;
    const t = now(); k.last = t;
    // the flood guard: T.rate frames a second with a burst of T.burst; the rest is dropped, and a member who keeps at it is removed
    k.tok = Math.min(T.burst, k.tok + (t - k.at) * T.rate / 1000); k.at = t;
    if (k.tok >= T.burst) k.strikes = 0;
    if (k.tok < 1) { if (++k.strikes > T.kick) hostDrop(id, c, 'flood'); return; }
    k.tok -= 1;
    if (!isObj(m) || typeof m.t !== 'string') return;
    if (m.t === '~ping') c.send({ t: '~pong' });
    else if (m.t === '~fast') { if (m.f === null || (isObj(m.f) && size(m.f) <= T.maxFast)) { e.f = m.f; dirty.add(id); flushFast(t); } }
    else if (m.t === '~pres') { if (isObj(m.p) && size(m.p) <= T.maxPres) { e.p = m.p; cast({ t: '~pres', id, p: m.p }, id); emit({ type: 'presence', id }); } }
    else if (m.t === '~bye') hostDrop(id, c);
    else if (m.t === '~m') {
      const a = m.m; if (!isObj(a) || typeof a.t !== 'string' || !a.t || a.t[0] === '~' || size(a) > maxMsg) return;
      const w = { t: '~m', from: id, m: a };
      if (m.to === undefined || m.to === null) { cast(w, id); emit({ type: 'msg', from: id, msg: a }); }
      else if (m.to === me) emit({ type: 'msg', from: id, msg: a });
      else if (typeof m.to === 'string') sendTo(m.to, w);
    }
  }

  // ----- a guest's side -----
  function guestData(c, m) {
    if (hconn !== c || !isObj(m) || typeof m.t !== 'string') return;
    heard = now();
    if (m.t === '~fast') {
      if (!isObj(m.s)) return; let k = 0;
      for (const id in m.s) { if (++k > 400) break; const e = members.get(id), f = m.s[id]; if (e && id !== me && (f === null || isObj(f))) e.f = f; }
      emit({ type: 'fast' });
    } else if (m.t === '~m') { if (typeof m.from === 'string' && m.from !== me && isObj(m.m) && typeof m.m.t === 'string' && m.m.t && m.m.t[0] !== '~' && size(m.m) <= maxMsg) emit({ type: 'msg', from: m.from, msg: m.m }); }
    else if (m.t === '~pres') { const e = members.get(m.id); if (e && m.id !== me && isObj(m.p) && size(m.p) <= T.maxPres) { e.p = m.p; emit({ type: 'presence', id: m.id }); } }
    else if (m.t === '~join') {
      if (!okId(m.id) || m.id === me) return;
      const had = members.get(m.id), v = { id: m.id, p: cleanP(m.p), f: cleanF(m.f), seq: int(m.seq, 0, 1e9, 0) };
      if (!had && members.size >= 400) return;
      if (had) Object.assign(had, v); else members.set(m.id, v);
      if (typeof m.h === 'string') keys.set(m.id, m.h.slice(0, 40));
      emit({ type: had ? 'presence' : 'join', id: m.id });
    } else if (m.t === '~leave') { if (typeof m.id === 'string') forget(m.id); }
    else if (m.t === '~bye') migrate(true);
    else if (m.t === '~kick') fail('kicked');
  }

  // ----- what the game calls -----
  function sendNow(msg, to) {
    if (to != null && !members.has(to)) return false;
    if (r.isHost) { const w = { t: '~m', from: me, m: msg }; if (to == null) cast(w); else sendTo(to, w); }
    else if (hconn) hconn.send(to == null ? { t: '~m', m: msg } : { t: '~m', m: msg, to });
    return true;
  }
  function flushPres(t) {
    if (!presDirty || r.state !== 'open' || t - presAt < T.pres) return;
    presDirty = false; if (size(mine.p) > T.maxPres) return;
    presAt = t;
    if (r.isHost) cast({ t: '~pres', id: me, p: mine.p }); else if (hconn) hconn.send({ t: '~pres', p: mine.p });
  }
  r.join = () => {
    if (r.state === 'connecting' || r.state === 'open' || r.state === 'migrating') return r;
    teardown(); queue = []; for (const id of [...members.keys()]) if (id !== me) members.delete(id);
    keys.clear(); r.isHost = false; r.hostId = null; r.n = 0; r.id = fixed || ''; r.err = ''; r.errCode = ''; lastId = ''; oldHost = null; mine.seq = 0;
    setState('connecting'); seek(gen, false, 0, false);
    return r;
  };
  r.leave = () => {
    try {
      const was = r.state;
      if (was === 'open') { if (r.isHost) cast({ t: '~bye' }); else if (hconn) hconn.send({ t: '~bye' }); }
      teardown(true); queue = []; r.isHost = false;
      setState('closed');
      if (was === 'open' || was === 'connecting' || was === 'migrating') emit({ type: 'closed', why: 'left', text: '' });
    } catch (e) {}
    return r;
  };
  // returns true when the message was sent (or queued during a migration), false when it was refused
  r.send = (msg, to) => {
    try {
      if (!isObj(msg) || typeof msg.t !== 'string' || !msg.t || msg.t[0] === '~') return false;
      if (to != null && (typeof to !== 'string' || to === me)) return false;
      const s = JSON.stringify(msg); if (!s || s.length > maxMsg) return false;
      if (r.state === 'migrating') { if (queue.length >= T.queue) return false; queue.push([JSON.parse(s), to]); return true; }
      return r.state === 'open' && sendNow(msg, to);
    } catch (e) { return false; }
  };
  r.setPresence = patch => { try { if (!isObj(patch)) return; Object.assign(mine.p, patch); presDirty = true; flushPres(now()); } catch (e) {} };
  r.setFast = obj => { mine.f = isObj(obj) ? obj : null; };
  r.pump = () => {
    try {
      if (r.state !== 'open') return;
      const t = now(); flushPres(t);
      if (r.isHost) {
        const fs = JSON.stringify(mine.f) || 'null';
        if (fs !== fastSent && fs.length <= T.maxFast) { fastSent = fs; dirty.add(me); }
        flushFast(t);
        if (ghosts.size && t >= ghostEnd) for (const id of [...ghosts.keys()]) { ghosts.delete(id); if (members.delete(id)) { keys.delete(id); cast({ t: '~leave', id }); emit({ type: 'leave', id }); } }
        for (const [id, k] of [...conns]) if (t - k.last > T.guestDead) hostDrop(id, k.c);
      } else if (hconn) {
        if (t - fastAt >= T.fast - 15) { const fs = JSON.stringify(mine.f) || 'null'; if (fs !== fastSent && fs.length <= T.maxFast) { fastSent = fs; fastAt = t; hconn.send({ t: '~fast', f: mine.f }); } }
        if (t - pingAt >= T.ping) { pingAt = t; hconn.send({ t: '~ping' }); }
        if (t - heard > T.hostDead) migrate(false);
      }
    } catch (e) { try { console.error(e); } catch (e2) {} }
  };
  return r;
}

MP.net = { uid: UID, T, room, mkConn, _backend: backend,
  // 'peer' | 'bc' | 'mem', or your own { claim, connect }. Choose it before the first room.join().
  useBackend(b) { if (isObj(b) && typeof b.claim === 'function' && typeof b.connect === 'function') { BE = b; forced = null; } else if (MAKE[b]) { forced = b; BE = null; } return MP.net; },
  get backend() { try { return backend().name || 'custom'; } catch (e) { return 'none'; } } };
})();
