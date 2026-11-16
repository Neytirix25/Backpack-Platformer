// node tools/mp_tests/net_test.js : MP.net (mp/net.js) over the in-memory backend, with many copies of the game in one process.
// Every test prints PASS or FAIL; the process exits 1 when anything failed. Timings are shrunk (MP.net.T) so it runs in seconds.
const { bootGame } = require('./boot.js');
const REG = {};
const FAST_T = { pump: 25, pres: 40, fast: 25, ping: 100, hostDead: 500, guestDead: 700, hello: 500, stagger: 100, jitter: 30, retry: 50, give: 3000, grace: 600, bye: 40, linger: 30, stuck: 1200, reclaim: 250 };
const pools = { mem: [], bc: [], peer: [] }, rooms = [];
const quiet = console.error;

// ----- stand-ins for the two browser transports, so their backends run here too (they model how BroadcastChannel and
// PeerJS 1.5.4 behave as read from their documentation and source: this checks our wiring, not the real libraries) -----
class FakeBC {
  constructor(name) { this.name = name; this.onmessage = null; this.dead = false; FakeBC.all.push(this); }
  postMessage(d) { if (this.dead) return; const s = JSON.stringify(d); for (const o of FakeBC.all) if (o !== this && o.name === this.name) setTimeout(() => { if (!o.dead && o.onmessage) o.onmessage({ data: JSON.parse(s) }); }, 1); }
  close() { this.dead = true; }
}
FakeBC.all = [];
class Emitter { constructor() { this._h = {}; } on(e, f) { (this._h[e] = this._h[e] || []).push(f); return this; } emit(e, ...a) { for (const f of (this._h[e] || []).slice()) f(...a); } }
// the broker: ids -> peer; an offer for an id nobody holds waits (and is delivered if somebody takes the id), then expires as 'peer-unavailable'
const BROKER = { ids: new Map(), expire: 300, peers: [], sent: 0, biggest: 0,
  offer(o) {
    const h = BROKER.ids.get(o.dst); if (o.from.destroyed || o.from.dead) return;
    if (h && h.dead) return;
    if (h) {
      const r = new FakeDC(h, o.from.want); r.other = o.dc; o.dc.other = r; h.dcs.push(r); h.emit('connection', r);
      setTimeout(() => { if (o.from.destroyed || h.destroyed || o.from.dead || h.dead) return; r.open = o.dc.open = true; r.emit('open'); o.dc.emit('open'); }, 5);
    } else if (Date.now() - o.t > BROKER.expire) o.from.emit('error', { type: 'peer-unavailable' });
    else setTimeout(() => BROKER.offer(o), 10);
  },
  of: tag => BROKER.peers.filter(p => p.tag === tag && !p.destroyed),
  // the tab closes: everything of that player is torn down properly · the network dies: silence, and the id stays taken for `lag` ms
  // (a closed tab runs no more code: its own listeners are removed first)
  closeTab(tag) { for (const p of BROKER.of(tag)) { p._h = {}; for (const d of p.dcs) d._h = {}; p.destroy(); } },
  cutNetwork(tag, lag) { for (const p of BROKER.of(tag)) { p.dead = true; setTimeout(() => { if (BROKER.ids.get(p.want) === p) BROKER.ids.delete(p.want); }, lag); } },
  dropSocket(tag) { for (const p of BROKER.of(tag)) if (p.open) { p.emit('error', { type: 'network' }); p.disconnect(); } } };
class FakeDC extends Emitter {
  constructor(peer, remote) { super(); this.provider = peer; this.peer = remote; this.open = false; this.other = null; }
  send(o) {
    if (!this.open) { this.emit('error', { type: 'not-open-yet' }); return; }
    const s = JSON.stringify(o), bytes = Buffer.byteLength(s); if (bytes >= 16300) { this.emit('error', { type: 'message-too-big' }); return; }
    BROKER.sent++; BROKER.biggest = Math.max(BROKER.biggest, bytes);
    const ot = this.other, me = this.provider; setTimeout(() => { if (ot && ot.open && !me.dead && !ot.provider.dead) ot.emit('data', JSON.parse(s)); }, 1);
  }
  close() { if (!this.open) return; this.open = false; this.emit('close'); const ot = this.other, me = this.provider; if (ot) setTimeout(() => { if (!me.dead && !ot.provider.dead) ot.close(); }, 1); }
}
function peerClass(tag) {
  return class FakePeer extends Emitter {
    constructor(id) { super(); this.tag = tag; this.want = typeof id === 'string' ? id : 'anon-' + (BROKER.peers.length + 1); this.id = null; this.open = false; this.destroyed = false; this.disconnected = false; this.dead = false; this.dcs = []; BROKER.peers.push(this); setTimeout(() => this._register(), 5); }
    _register() {
      if (this.destroyed || this.dead) return;
      if (BROKER.ids.has(this.want)) { this.emit('error', { type: 'unavailable-id' }); if (this._last) this.disconnect(); else this.destroy(); return; }
      BROKER.ids.set(this.want, this); this.id = this._last = this.want; this.open = true; this.disconnected = false; this.emit('open', this.id);
    }
    connect(dst) { const dc = new FakeDC(this, dst); this.dcs.push(dc); const o = { from: this, dc, dst, t: Date.now() }; setTimeout(() => BROKER.offer(o), 2); return dc; }
    disconnect() { if (this.disconnected) return; this.disconnected = true; this.open = false; if (BROKER.ids.get(this.want) === this) BROKER.ids.delete(this.want); this.id = null; this.emit('disconnected'); }
    reconnect() { if (!this.disconnected || this.destroyed) throw new Error('cannot reconnect'); this.disconnected = false; setTimeout(() => this._register(), 5); }
    destroy() { if (this.destroyed) return; this.disconnect(); for (const d of this.dcs) d.close(); this.destroyed = true; this.emit('close'); }
  };
}
const SETUP = {
  mem: () => ({ globals: { __MPMEM: REG } }),
  bc: () => ({ globals: { BroadcastChannel: FakeBC }, search: '?mpnet=bc' }),
  peer: i => ({ globals: { Peer: peerClass('peer' + i) } }) };
const KIND_T = { mem: {}, bc: { bcClaim: 60, bcConn: 150, bcPing: 60, bcDead: 250 }, peer: { conn: 1500, connMig: 500, connEarly: 200, reconn: 150 } };
function game(i, kind = 'mem') {
  const pl = pools[kind];
  while (pl.length <= i) {
    const g = bootGame(Object.assign({ name: 'P' + pl.length }, SETUP[kind](pl.length))); g.net = g.run('MP.net'); g.T0 = Object.assign({}, g.net.T); Object.assign(g.net.T, FAST_T, KIND_T[kind]);
    if (g.net.backend !== kind) throw new Error('expected the ' + kind + ' backend, got ' + g.net.backend);
    if (kind === 'bc') g.channel = FakeBC.all[FakeBC.all.length - 1];
    g.tag = kind + pl.length; pl.push(g);
  }
  return pl[i];
}
// a room for copy i: `ev` collects its events
function mk(i, opts, kind) {
  const ev = [], g = game(i, kind);
  const room = g.net.room(Object.assign({ on: e => { ev.push(e); if (room.onEv) room.onEv(e); } }, opts));
  room.ev = ev; room.g = g; room.of = t => ev.filter(e => e.type === t); rooms.push(room);
  return room;
}
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
async function until(f, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(10); } return !!f(); }
const open = rs => until(() => rs.every(r => r.state === 'open'));
const ids = r => [...r.members.keys()].sort().join(',');
// a hand-made client speaking the raw wire (to send what the real one never would)
async function raw(i, id, hello) {
  const g = game(i), c = await g.net._backend().connect(id), got = [];
  c.onData(m => got.push(m)); c.onClose(() => { c.closed = true; });
  c.send(Object.assign({ t: '~hello', v: 1, id: 'raw' + String(i).padStart(7, '0'), k: 'rawkey-rawkey-' + i, p: { name: 'raw' }, f: null }, hello));
  c.got = got; return c;
}
let failed = 0, uniq = 0;
const tests = [];
const test = (name, f) => tests.push([name, f]);
const ok = (c, what) => { if (!c) throw new Error(what); };
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`); };
const pre = () => 't' + (++uniq) + '-';

test('first joiner hosts, second connects', async () => {
  const p = pre(), a = mk(0, { prefix: p, presence: { name: 'A' } }), b = mk(1, { prefix: p, presence: { name: 'B' } });
  eq(a.state, 'idle', 'state before join'); a.join(); eq(a.state, 'connecting', 'state right after join');
  ok(await open([a]), 'A never opened'); b.join(); ok(await open([b]), 'B never opened');
  ok(a.isHost && !b.isHost, 'A should host'); eq(b.hostId, a.me, 'hostId at B'); eq(a.hostId, a.me, 'hostId at A');
  eq(a.n, 1, 'instance'); eq(b.n, 1, 'instance at B'); eq(a.id, p + '1', 'room id'); eq(b.id, p + '1', 'room id at B');
  ok(a.me !== b.me && /^[a-z0-9]{10}$/.test(a.me) && a.me === a.g.net.uid, 'uids');
  ok(await until(() => a.members.size === 2 && b.members.size === 2), 'both should see 2 members');
  eq(a.of('join').length, 1, 'join events at A'); eq(a.of('join')[0].id, b.me, 'joined id'); eq(b.of('join')[0].id, a.me, 'B is told about A');
  eq(b.members.get(a.me).p.name, 'A', "A's presence at B"); eq(a.members.get(b.me).p.name, 'B', "B's presence at A");
  ok(a.members.get(a.me).seq < a.members.get(b.me).seq, 'join order');
});

test('roster and presences reach late joiners, presence changes spread', async () => {
  const p = pre(), a = mk(0, { prefix: p, presence: { name: 'A', lv: 3 } }), b = mk(1, { prefix: p, presence: { name: 'B' } }), c = mk(2, { prefix: p, presence: { name: 'C' } });
  a.join(); await open([a]); b.join(); await open([b]);
  b.setPresence({ pt: { kind: 'raid', tier: 2 } }); a.setPresence({ lv: 9 });
  ok(await until(() => a.members.get(b.me).p.pt && b.members.get(a.me).p.lv === 9), 'presence did not spread');
  ok(a.of('presence').some(e => e.id === b.me), 'presence event at the host'); ok(b.of('presence').some(e => e.id === a.me), 'presence event at the guest');
  c.join(); ok(await open([c]), 'C never opened');
  eq(c.members.size, 3, 'roster at the late joiner'); eq(c.members.get(a.me).p.lv, 9, "A's presence at C"); eq(c.members.get(b.me).p.pt.tier, 2, "B's presence at C"); eq(c.members.get(b.me).p.name, 'B', 'name kept');
  for (let i = 0; i < 20; i++) c.setPresence({ i });
  ok(await until(() => a.members.get(c.me).p.i === 19 && b.members.get(c.me).p.i === 19), 'the last presence must arrive');
  ok(b.of('presence').filter(e => e.id === c.me).length <= 3, 'presence is coalesced');
  ok(await until(() => a.members.size === 3 && b.members.size === 3), 'everyone sees 3');
});

test('send to everyone and to one member', async () => {
  const p = pre(), rs = [0, 1, 2].map(i => mk(i, { prefix: p })); for (const r of rs) { r.join(); await open([r]); }
  const [a, b, c] = rs;
  eq(b.send({ t: 'chat', s: 'hi all' }), true, 'send result');
  ok(await until(() => a.of('msg').length === 1 && c.of('msg').length === 1), 'broadcast from a guest');
  eq(b.of('msg').length, 0, 'no echo to the sender'); eq(c.of('msg')[0].from, b.me, 'from'); eq(c.of('msg')[0].msg.s, 'hi all', 'payload');
  a.send({ t: 'chat', s: 'host says' });
  ok(await until(() => b.of('msg').length === 1 && c.of('msg').length === 2), 'broadcast from the host'); eq(b.of('msg')[0].from, a.me, 'from the host');
  b.send({ t: 'w', s: 'psst' }, c.me); c.send({ t: 'w', s: 'to host' }, a.me); a.send({ t: 'w', s: 'to b' }, b.me);
  ok(await until(() => c.of('msg').length === 3 && a.of('msg').length === 2 && b.of('msg').length === 2), 'direct messages');
  await sleep(60);
  eq(a.of('msg').filter(e => e.msg.s === 'psst').length, 0, 'the host must not get a guest-to-guest whisper as an event'); eq(c.of('msg')[2].from, b.me, 'whisper from');
  eq(b.send({ t: 'w' }, 'nobody0000'), false, 'unknown member'); eq(b.send({ t: 'w' }, b.me), false, 'to myself');
  for (let i = 0; i < 30; i++) b.send({ t: 'n', i });
  ok(await until(() => c.of('msg').filter(e => e.msg.t === 'n').length === 30), 'burst arrives');
  eq(c.of('msg').filter(e => e.msg.t === 'n').map(e => e.msg.i).join(), [...Array(30).keys()].join(), 'in order');
});

test('`from` cannot be spoofed, a uid cannot be stolen', async () => {
  const p = pre(), a = mk(0, { prefix: p }), b = mk(1, { prefix: p }); a.join(); await open([a]); b.join(); await open([b]);
  const x = await raw(2, p + '1'); ok(await until(() => x.got.some(m => m.t === '~welcome')), 'raw client welcomed');
  x.send({ t: '~m', from: a.me, m: { t: 'chat', from: a.me, s: 'fake' } });
  ok(await until(() => b.of('msg').length === 1 && a.of('msg').length === 1), 'relayed');
  eq(b.of('msg')[0].from, 'raw0000002', 'the host stamps the real sender'); eq(a.of('msg')[0].from, 'raw0000002', 'also at the host');
  const y = await raw(3, p + '1', { id: b.me });
  ok(await until(() => y.got.some(m => m.t === '~no')), "taking B's uid with another key is refused");
  b.send({ t: 'still', s: 1 }); ok(await until(() => a.of('msg').some(e => e.msg.t === 'still' && e.from === b.me)), 'B is still connected');
  const z = await raw(3, p + '1', { id: a.me }); ok(await until(() => z.got.some(m => m.t === '~no')), "the host's uid is refused");
  x.close();
});

test('fast states arrive in batches', async () => {
  const p = pre(), rs = [0, 1, 2].map(i => mk(i, { prefix: p })); for (const r of rs) { r.join(); await open([r]); }
  const [a, b, c] = rs;
  a.setFast({ x: 1, y: 2 }); b.setFast({ x: 10, y: 20 }); c.setFast({ x: 100, y: 200 });
  ok(await until(() => rs.every(r => rs.every(o => r.members.get(o.me).f && r.members.get(o.me).f.x === o.members.get(o.me).f.x))), 'fast states everywhere');
  ok(b.of('fast').length >= 1 && a.of('fast').length >= 1, 'fast events');
  const n0 = c.of('fast').length; await sleep(200); eq(c.of('fast').length, n0, 'nothing is sent while nothing changes');
  const pos = { x: 0, y: 0 }; b.setFast(pos);
  for (let i = 1; i <= 40; i++) { pos.x = i; await sleep(5); }
  ok(await until(() => c.members.get(b.me).f.x === 40 && a.members.get(b.me).f.x === 40), 'the last position arrives');
  const got = c.of('fast').length - n0; ok(got >= 2 && got <= 30, 'batched, not one frame per change (got ' + got + ' batches for 40 changes)');
  const d = mk(3, { prefix: p }); d.join(); await open([d]); eq(d.members.get(b.me).f.x, 40, 'a late joiner gets the fast states too');
  b.setFast({ big: 'x'.repeat(2000) }); await sleep(150); eq(a.members.get(b.me).f.x, 40, 'an oversize fast state is not sent');
});

test('cap 3: the 4th joiner lands in instance 2', async () => {
  const p = pre(), rs = [0, 1, 2, 3, 4].map(i => mk(i, { prefix: p, cap: 3 })); for (const r of rs) { r.join(); ok(await open([r]), 'did not open'); }
  eq(rs.map(r => r.n).join(), '1,1,1,2,2', 'instances'); ok(rs[3].isHost && !rs[4].isHost, 'the 4th hosts instance 2'); eq(rs[3].id, p + '2', 'id of instance 2');
  eq(rs[0].members.size, 3, 'instance 1 holds 3'); eq(rs[4].members.size, 2, 'instance 2 holds 2'); eq(rs[4].hostId, rs[3].me, 'host of instance 2');
});

test('a fixed room with cap 4 refuses the 5th', async () => {
  const id = 'bps-party-' + pre(), rs = [0, 1, 2, 3].map(i => mk(i, { id, cap: 4 })); for (const r of rs) { r.join(); ok(await open([r]), 'did not open'); }
  ok(rs[0].isHost, 'the first claims it'); eq(rs[3].id, id, 'room id'); eq(rs[3].n, 0, 'no instance number');
  const e = mk(4, { id, cap: 4 }); e.join(); ok(await until(() => e.state === 'error'), 'the 5th should end in error, is ' + e.state);
  eq(e.errCode, 'full', 'errCode'); ok(/full/.test(e.err), 'err text'); eq(e.of('closed').length, 1, 'closed event'); eq(e.of('closed')[0].why, 'full', 'why');
  await sleep(80); eq(rs[0].members.size, 4, 'still 4 inside'); eq(rs[0].of('join').length, 3, 'no join event for the refused one');
  rs[3].leave(); ok(await until(() => rs[0].members.size === 3), 'one left'); e.join(); ok(await open([e]), 'a freed slot can be taken'); eq(e.errCode, '', 'error cleared');
});

test('a polite leave gives leave events', async () => {
  const p = pre(), rs = [0, 1, 2].map(i => mk(i, { prefix: p })); for (const r of rs) { r.join(); await open([r]); }
  const [a, b, c] = rs; b.leave();
  eq(b.state, 'closed', 'state'); eq(b.of('closed')[0].why, 'left', 'closed event');
  ok(await until(() => a.of('leave').length === 1 && c.of('leave').length === 1, 400), 'leave events (quickly, not by timeout)');
  eq(a.of('leave')[0].id, b.me, 'who left'); eq(c.of('leave')[0].id, b.me, 'who left at C'); eq(ids(a), ids(c), 'same roster');
  eq(b.send({ t: 'x' }), false, 'send after leave'); b.leave(); b.leave(); eq(b.of('closed').length, 1, 'closed only once');
});

// the body shared by the migration tests: `end(host, roomId)` makes the host go away
async function migration(end, count = 5, oldest = true) {
  const p = pre();
  const rs = []; for (let i = 0; i < count; i++) { const r = mk(i, { prefix: p, cap: count, presence: { name: 'P' + i } }); r.join(); ok(await open([r]), 'did not open'); rs.push(r); r.setFast({ x: i }); }
  ok(await until(() => rs.every(r => r.members.size === count)), 'everyone inside');
  const host = rs[0], rest = rs.slice(1), all = ids(rest[0]).split(',').filter(i => i !== host.me).sort().join(',');
  ok(await until(() => rest.every(r => rs.every(o => r.members.get(o.me).f))), 'fast states known');
  for (const r of rs) r.ev.length = 0;
  let queued = null; rest[0].onEv = e => { if (e.type === 'state' && e.state === 'migrating') queued = rest[0].send({ t: 'q', s: 'queued' }); };
  await end(host, p + '1');
  ok(await until(() => rest.every(r => r.of('state').some(e => e.state === 'migrating')), 1500), 'the others should start migrating');
  eq(queued, true, 'send() while migrating queues');
  ok(await until(() => rest.every(r => r.state === 'open'), 6000), 'everyone should be open again: ' + rest.map(r => r.state).join());
  const hosts = rest.filter(r => r.isHost); eq(hosts.length, 1, 'exactly one new host'); if (oldest) ok(hosts[0] === rest[0], 'the oldest member takes over');
  for (const r of rest) { eq(r.hostId, hosts[0].me, 'hostId'); eq(r.n, 1, 'the instance number is kept'); eq(r.id, p + '1', 'the room id is kept'); eq(r.of('host').length, 1, 'one host event'); eq(r.of('host')[0].id, hosts[0].me, 'host event id'); }
  ok(await until(() => rest.every(r => ids(r) === all)), 'everyone still sees everyone (and not the old host): ' + rest.map(r => r.members.size).join());
  for (const r of rest) { eq(r.of('leave').length, 1, 'one leave'); eq(r.of('leave')[0].id, host.me, 'only the old host left'); eq(r.of('join').length, 0, 'nobody re-joined as new'); }
  for (const r of rest) for (const o of rest) { eq(r.members.get(o.me).p.name, o.members.get(o.me).p.name, 'presence kept'); eq(r.members.get(o.me).f && r.members.get(o.me).f.x, o.members.get(o.me).f.x, 'fast state kept'); }
  ok(await until(() => rest.slice(1).every(r => r.of('msg').some(e => e.msg.s === 'queued' && e.from === rest[0].me))), 'the queued message is delivered after the migration');
  rest[2].send({ t: 'chat', s: 'after' }); rest[0].send({ t: 'chat', s: 'direct' }, rest[3].me); rest[3].send({ t: 'chat', s: 'direct2' }, rest[1].me); rest[1].setFast({ x: 77 }); rest[3].setPresence({ name: 'New' });
  ok(await until(() => rest.every(r => r === rest[2] || r.of('msg').some(e => e.msg.s === 'after' && e.from === rest[2].me))), 'messages flow again');
  ok(await until(() => rest[3].of('msg').some(e => e.msg.s === 'direct') && rest[1].of('msg').some(e => e.msg.s === 'direct2' && e.from === rest[3].me)), 'direct messages flow again');
  ok(await until(() => rest.every(r => r.members.get(rest[1].me).f.x === 77 && r.members.get(rest[3].me).p.name === 'New')), 'fast and presence flow again');
  await sleep(FAST_T.grace + 200);
  ok(rest.every(r => ids(r) === all), 'nobody is dropped after the grace time');
  const late = mk(10, { prefix: p, cap: count }); late.join(); ok(await open([late]), 'a newcomer can join the migrated room'); eq(late.n, 1, 'into the same instance'); eq(late.members.size, count, 'and sees everyone');
  ok(await until(() => rest.every(r => r.members.size === count)), 'everyone sees the newcomer');
  return { rs, rest, host };
}
test('the host is killed abruptly: one new host, everyone still there, messages flow', () => migration((h, id) => { ok(REG.kill(id), 'kill'); }));
test('the host leaves politely: same', async () => { const m = await migration(h => { h.leave(); }); eq(m.host.state, 'closed', 'old host closed'); });
test('the host dies silently (no close event): the heartbeat notices', () => migration((h, id) => { ok(REG.kill(id, true), 'kill'); }));
test("the dead host's id stays taken for a while (like the PeerJS broker): retries get through", async () => { REG.lag = 700; try { await migration((h, id) => { REG.kill(id); }, 5, false); } finally { REG.lag = 0; } });

test('members who do not come back are dropped after the grace time; a room of one migrates alone', async () => {
  const p = pre(), a = mk(0, { prefix: p }), b = mk(1, { prefix: p }), c = mk(2, { prefix: p }); a.join(); await open([a]); b.join(); await open([b]);
  const x = await raw(3, p + '1'); await until(() => x.got.length); c.join(); await open([c]);
  ok(await until(() => b.members.size === 4 && c.members.size === 4), '4 inside');
  REG.kill(p + '1'); ok(await until(() => b.state === 'open' && c.state === 'open' && b.isHost && c.hostId === b.me), 'migrated');
  ok(b.members.has('raw0000003') && c.members.has('raw0000003'), 'the missing member is kept during the grace time');
  ok(await until(() => !b.members.has('raw0000003') && !c.members.has('raw0000003'), FAST_T.grace + 800), 'then dropped');
  ok(b.of('leave').some(e => e.id === 'raw0000003') && c.of('leave').some(e => e.id === 'raw0000003'), 'with leave events');
  REG.kill(p + '1');
  ok(await until(() => c.of('host').length === 2 && c.state === 'open' && c.isHost), 'the last one left hosts alone'); ok(await until(() => c.members.size === 1, FAST_T.grace + 800), 'alone');
});

test('nobody can host or be reached: error after the give-up time', async () => {
  const g = game(5), T = g.net.T, id = 'dead-' + pre(), keep = T.give; T.give = 400;
  REG.holders[id] = { dead: true, links: [] };
  const r = mk(5, { id }); r.join(); const t = Date.now();
  try { ok(await until(() => r.state === 'error', 3000), 'should give up'); eq(r.errCode, 'unreachable', 'errCode'); ok(Date.now() - t >= 350, 'not before the give-up time'); eq(r.of('closed')[0].why, 'unreachable', 'closed event'); }
  finally { T.give = keep; delete REG.holders[id]; }
});

test('oversize and ~ messages are refused', async () => {
  const p = pre(), a = mk(0, { prefix: p, maxMsg: 500 }), b = mk(1, { prefix: p, maxMsg: 500 }); a.join(); await open([a]); b.join(); await open([b]);
  eq(b.send({ t: 'big', s: 'x'.repeat(600) }), false, 'oversize from a guest'); eq(a.send({ t: 'big', s: 'x'.repeat(600) }), false, 'oversize from the host');
  eq(b.send({ t: '~leave', id: a.me }), false, '~ type'); eq(a.send({ t: '~bye' }), false, '~ type from the host'); eq(b.send({ t: '' }), false, 'empty type');
  eq(b.send({ s: 1 }), false, 'no type'); eq(b.send('hello'), false, 'not an object'); eq(b.send(null), false, 'null'); eq(b.send([1]), false, 'an array'); eq(b.send({ t: 5 }), false, 'a number as type');
  const loop = { t: 'loop' }; loop.self = loop; eq(b.send(loop), false, 'not JSON');
  eq(b.send({ t: 'ok', s: 'x'.repeat(400) }), true, 'just under the cap');
  const x = await raw(2, p + '1'); await until(() => x.got.length);
  x.send({ t: '~m', m: { t: 'big', s: 'y'.repeat(600) } }); x.send({ t: '~m', m: { t: '~leave', id: b.me } }); x.send({ t: '~leave', id: b.me }); x.send({ t: '~join', id: 'ghost00000', p: {} });
  x.send({ t: '~m', m: 'text' }); x.send({ t: '~m' }); x.send('junk'); x.send(null); x.send([1, 2]); x.send({ t: 7 }); x.send({ t: '~pres', p: { s: 'z'.repeat(5000) } }); x.send({ t: '~fast', f: { s: 'z'.repeat(900) } }); x.send({ t: '~fast', f: 'nope' });
  x.send({ t: '~m', m: { t: 'fine' } });
  ok(await until(() => b.of('msg').some(e => e.msg.t === 'fine') && a.of('msg').some(e => e.msg.t === 'fine')), 'the valid one arrives');
  eq(a.of('msg').length, 2, 'only the valid messages at the host'); eq(b.of('msg').length, 1, 'only the valid message at the guest');
  eq(ids(a), ids(b), 'rosters agree'); eq(a.members.size, 3, 'nobody was removed or invented'); eq(a.members.get('raw0000002').p.name, 'raw', 'oversize presence ignored'); eq(a.members.get('raw0000002').f, null, 'bad fast ignored');
  x.close();
});

test('flood guard: the excess is dropped and the flooder is removed', async () => {
  const p = pre(), a = mk(0, { prefix: p }), b = mk(1, { prefix: p }); a.join(); await open([a]); b.join(); await open([b]);
  const x = await raw(2, p + '1'); await until(() => x.got.length);
  for (let i = 0; i < 150; i++) x.send({ t: '~m', m: { t: 'spam', i } });
  await sleep(120); const n = b.of('msg').length; ok(n >= 60 && n <= 95, 'about one burst gets through (got ' + n + ')'); ok(a.members.has('raw0000002'), 'not removed for one burst');
  for (let i = 0; i < 400; i++) x.send({ t: '~m', m: { t: 'spam', i } });
  ok(await until(() => !a.members.has('raw0000002') && !b.members.has('raw0000002')), 'removed after repeated abuse');
  ok(await until(() => x.got.some(m => m.t === '~kick') && x.closed), 'told and disconnected'); ok(b.of('msg').length < 140, 'the flood never reached the others (' + b.of('msg').length + ')');
  for (let i = 0; i < 60; i++) b.send({ t: 'ok', i }); ok(await until(() => a.of('msg').filter(e => e.msg.t === 'ok').length === 60), 'a normal burst from an honest member is fine');
});

test('a real client that is kicked ends in error', async () => {
  const p = pre(), a = mk(0, { prefix: p }), b = mk(1, { prefix: p }); a.join(); await open([a]); b.join(); await open([b]);
  for (let i = 0; i < 700; i++) b.send({ t: 'spam', i });
  ok(await until(() => b.state === 'error'), 'kicked'); eq(b.errCode, 'kicked', 'errCode'); ok(await until(() => a.members.size === 1), 'gone at the host');
});

test('20 members in one hub exchange fast states', async () => {
  const p = pre(), errs = []; console.error = (...a) => { errs.push(a.join(' ')); };
  try {
    const rs = []; for (let i = 0; i < 20; i++) { const r = mk(i, { prefix: p, cap: 20, presence: { name: 'P' + i } }); r.join(); rs.push(r); if (!i) await open([r]); }
    ok(await open(rs), 'all 20 open: ' + rs.map(r => r.state).join()); ok(rs.every(r => r.n === 1), 'all in instance 1'); eq(rs.filter(r => r.isHost).length, 1, 'one host');
    ok(await until(() => rs.every(r => r.members.size === 20)), 'everyone sees 20');
    for (let k = 1; k <= 12; k++) { rs.forEach((r, i) => r.setFast({ x: i * 100 + k, y: k, vx: 1, vy: 0, f: 1, g: 1 })); await sleep(30); }
    ok(await until(() => rs.every(r => rs.every((o, i) => { const f = r.members.get(o.me).f; return f && f.x === i * 100 + 12; }))), 'all 400 fast states are current');
    rs[7].send({ t: 'chat', s: 'hello hub' }); ok(await until(() => rs.every(r => r === rs[7] || r.of('msg').length === 1)), 'a chat line reaches 19 members');
    const x = mk(20, { prefix: p, cap: 20 }); x.join(); ok(await open([x]), 'the 21st opens'); eq(x.n, 2, 'in instance 2');
    eq(rs.reduce((n, r) => n + r.of('closed').length, 0), 0, 'nobody was closed'); eq(errs.length, 0, 'errors logged: ' + errs[0]);
    // and the big one: the host of 20 dies
    REG.kill(p + '1'); ok(await until(() => rs.slice(1).every(r => r.state === 'open' && r.members.size === 19), 8000), '19 survive a migration: ' + rs.slice(1).map(r => r.state[0] + r.members.size).join(' '));
    eq(rs.slice(1).filter(r => r.isHost).length, 1, 'one new host'); ok(rs.slice(1).every(r => r.hostId === rs[1].me), 'the oldest');
  } finally { console.error = quiet; }
});

test('leave() is safe in every state and a throwing listener does no harm', async () => {
  const p = pre(), errs = []; console.error = (...a) => { errs.push(a); };
  try {
    const a = mk(0, { prefix: p }); a.leave(); eq(a.state, 'closed', 'leave before join'); a.join(); a.leave(); eq(a.state, 'closed', 'leave while connecting');
    await sleep(60); eq(a.state, 'closed', 'stays closed'); ok(!REG.holders[p + '1'], 'a claim that finished after leave() is given back');
    const b = mk(1, { prefix: p, on: () => { throw new Error('listener bug'); } }), c = mk(2, { prefix: p }); b.join(); ok(await open([b]), 'opens although its listener throws'); c.join(); await open([c]);
    c.send({ t: 'x' }); await sleep(40); ok(errs.length > 0, 'the listener error is logged'); eq(b.members.size, 2, 'and the room works');
    REG.kill(p + '1'); await until(() => c.state === 'migrating'); c.leave(); eq(c.state, 'closed', 'leave while migrating'); await sleep(300); eq(c.state, 'closed', 'no zombie after a migration was cancelled'); ok(!REG.holders[p + '1'], 'no zombie host');
    c.join(); ok(await open([c]), 'join again after leave'); ok(c.isHost, 'hosting the empty room');
    for (const f of ['leave', 'pump', 'setFast', 'setPresence', 'send']) for (const v of [undefined, null, 5, 'x', [], {}]) c[f](v);
    b.leave();
  } finally { console.error = quiet; }
});

test('with the real timings: 10 batches a second, and a killed host is replaced within a few seconds', async () => {
  const gs = [0, 1, 2, 3].map(i => game(i)); for (const g of gs) Object.assign(g.net.T, g.T0);
  try {
    const p = pre(), rs = []; for (let i = 0; i < 4; i++) { const r = mk(i, { prefix: p }); r.join(); ok(await open([r]), 'opens'); rs.push(r); }
    const pos = { x: 0 }; rs[1].setFast(pos); const n0 = rs[2].of('fast').length, t = Date.now();
    while (Date.now() - t < 1000) { pos.x++; await sleep(4); }
    const n = rs[2].of('fast').length - n0; ok(n >= 7 && n <= 11, 'about 10 batches in a second, got ' + n);
    for (let i = 0; i < 30; i++) rs[3].setPresence({ i }); await sleep(1000);
    const pn = rs[2].of('presence').filter(e => e.id === rs[3].me).length; ok(pn >= 1 && pn <= 3, 'presence is coalesced, got ' + pn); eq(rs[2].members.get(rs[3].me).p.i, 29, 'the last presence');
    const t1 = Date.now(); REG.kill(p + '1'); const rest = rs.slice(1);
    ok(await until(() => rest.every(r => r.state === 'open' && r.members.size === 3 && r.hostId === rs[1].me), 8000), 'migrated: ' + rest.map(r => r.state).join());
    console.log('      (migration of 3 members with the real timings took ' + (Date.now() - t1) + ' ms)');
  } finally { for (const r of rooms) r.leave(); for (const g of gs) Object.assign(g.net.T, FAST_T); }
});

// ----- the BroadcastChannel backend (over the stand-in channel) -----
const bk = (i, opts) => mk(i, opts, 'bc');
test('bc backend: two tabs joining at the same moment give one host; chat, presence and fast states work', async () => {
  const p = pre(), a = bk(0, { prefix: p, presence: { name: 'A' } }), b = bk(1, { prefix: p, presence: { name: 'B' } }); a.join(); b.join();
  ok(await open([a, b]), 'both open: ' + a.state + ' ' + b.state); eq([a, b].filter(r => r.isHost).length, 1, 'exactly one host'); eq(a.n, 1, 'instance'); eq(b.n, 1, 'instance');
  const c = bk(2, { prefix: p, presence: { name: 'C' } }); c.join(); ok(await open([c]), 'C opens');
  ok(await until(() => [a, b, c].every(r => r.members.size === 3)), 'three inside'); eq(c.members.get(a.me).p.name, 'A', 'presence');
  c.send({ t: 'chat', s: 'hi' }); a.setFast({ x: 5 }); b.setPresence({ lv: 4 });
  ok(await until(() => a.of('msg').length === 1 && b.of('msg').length === 1 && c.members.get(a.me).f && c.members.get(a.me).f.x === 5 && c.members.get(b.me).p.lv === 4), 'everything flows');
  const d = bk(3, { id: 'bcfix-' + p, cap: 1 }), e = bk(4, { id: 'bcfix-' + p, cap: 1 }); d.join(); await open([d]); e.join(); ok(await until(() => e.state === 'error' && e.errCode === 'full'), 'full fixed room');
});
async function bcMigration(end) {
  const p = pre(), rs = []; for (let i = 0; i < 4; i++) { const r = bk(i, { prefix: p }); r.join(); ok(await open([r]), 'opens'); rs.push(r); }
  ok(await until(() => rs.every(r => r.members.size === 4)), 'four inside'); const rest = rs.slice(1);
  end(rs[0]);
  ok(await until(() => rest.every(r => r.of('state').some(e => e.state === 'migrating')), 2000), 'they notice');
  ok(await until(() => rest.every(r => r.state === 'open' && r.members.size === 3), 6000), 'settled: ' + rest.map(r => r.state + r.members.size).join(' '));
  eq(rest.filter(r => r.isHost).length, 1, 'one new host'); ok(rest.every(r => r.hostId === rs[1].me), 'the oldest'); ok(rest.every(r => r.of('host').length === 1), 'host events');
  rest[2].send({ t: 'chat', s: 'again' }); ok(await until(() => rest[0].of('msg').length === 1 && rest[1].of('msg').length === 1), 'messages flow again');
}
test('bc backend: the host leaves politely -> migration', () => bcMigration(h => h.leave()));
test('bc backend: the host tab dies without a word -> the silence is noticed -> migration', async () => {
  try { await bcMigration(h => { h.g.channel.dead = true; }); } finally { for (const r of rooms) r.leave(); await sleep(400); for (const g of pools.bc) g.channel.dead = false; }
});

// ----- the PeerJS backend (over the stand-in Peer and broker) -----
const pk = (i, opts) => mk(i, opts, 'peer');
test('peer backend: join, a roster and messages bigger than one PeerJS frame, to all and to one', async () => {
  const p = pre(), big = n => ({ name: 'P' + n, blob: String(n).repeat(3500) }), rs = [];
  for (let i = 0; i < 6; i++) { const r = pk(i, { prefix: p, presence: big(i) }); r.join(); ok(await open([r]), 'opens ' + i + ': ' + r.state + ' ' + r.errCode); rs.push(r); }
  eq(rs.filter(r => r.isHost).length, 1, 'one host'); ok(rs[0].isHost, 'the first'); ok(rs.every(r => r.n === 1), 'one instance');
  ok(await until(() => rs.every(r => r.members.size === 6)), 'six inside');
  ok(rs.every(r => rs.every((o, i) => r.members.get(o.me).p.blob === String(i).repeat(3500))), 'every presence arrived whole (the roster is ~21 KB)');
  const long = 'é'.repeat(7000); eq(rs[3].send({ t: 'snap', s: long }), true, 'a 7000-character message with accents (14 KB of UTF-8)');
  ok(await until(() => rs.every(r => r === rs[3] || r.of('msg').some(e => e.msg.s === long && e.from === rs[3].me))), 'arrives whole everywhere');
  rs[5].send({ t: 'w', s: 1 }, rs[2].me); ok(await until(() => rs[2].of('msg').some(e => e.msg.t === 'w' && e.from === rs[5].me)), 'direct');
  ok(BROKER.biggest < 16300, 'no frame over the PeerJS limit (biggest ' + BROKER.biggest + ' bytes)');
  rs[4].leave(); ok(await until(() => rs[0].members.size === 5 && rs[1].members.size === 5), 'polite leave'); ok(await until(() => BROKER.of('peer4').length === 0), "the leaver's peers are destroyed");
  const cap = pk(6, { id: 'pfix-' + p, cap: 1 }), no = pk(7, { id: 'pfix-' + p, cap: 1 }); cap.join(); await open([cap]); no.join(); ok(await until(() => no.state === 'error' && no.errCode === 'full'), 'full fixed room'); ok(await until(() => BROKER.of('peer7').length === 0), 'no peer left behind after an error');
});
async function peerMigration(end, wait = 6000) {
  const p = pre(), rs = []; for (let i = 0; i < 5; i++) { const r = pk(i, { prefix: p, presence: { name: 'P' + i } }); r.join(); ok(await open([r]), 'opens'); rs.push(r); }
  ok(await until(() => rs.every(r => r.members.size === 5)), 'five inside'); const rest = rs.slice(1);
  end(rs[0]);
  ok(await until(() => rest.every(r => r.of('state').some(e => e.state === 'migrating')), 2000), 'they notice');
  ok(await until(() => rest.every(r => r.state === 'open' && r.members.size === 4), wait), 'settled: ' + rest.map(r => r.state + r.members.size).join(' '));
  eq(rest.filter(r => r.isHost).length, 1, 'one new host'); ok(rest.every(r => r.of('host').length === 1 && r.n === 1), 'host events, same instance');
  rest[2].send({ t: 'chat', s: 'again' }); ok(await until(() => rest.every(r => r === rest[2] || r.of('msg').length === 1)), 'messages flow again');
  return { rs, rest };
}
test('peer backend: the host closes the tab -> migration, the oldest takes over', async () => { const m = await peerMigration(h => BROKER.closeTab(h.g.tag)); ok(m.rest[0].isHost, 'the oldest'); });
test('peer backend: the host leaves politely -> migration', async () => { const m = await peerMigration(h => h.leave()); ok(m.rest[0].isHost, 'the oldest'); });
test("peer backend: the host's network dies (no close event, the broker keeps its id 800 ms) -> heartbeat, retries, one host", async () => {
  let dead; try { await peerMigration(h => { dead = h.g; BROKER.cutNetwork(h.g.tag, 800); }, 9000); }
  finally { if (dead) { for (const r of rooms) if (r.g === dead) r.leave(); await sleep(100); for (const p of BROKER.peers) if (p.tag === dead.tag) { p.dead = false; p.destroy(); } } }
});
test("peer backend: the host loses the broker's socket, gets it back, and still takes guests", async () => {
  const p = pre(), a = pk(0, { prefix: p }), b = pk(1, { prefix: p }); a.join(); await open([a]); b.join(); await open([b]);
  BROKER.dropSocket('peer0'); ok(!BROKER.ids.has(p + '1'), 'the id is free for a moment');
  b.send({ t: 'chat', s: 'still here' }); ok(await until(() => a.of('msg').length === 1), 'the data channel lives on');
  ok(await until(() => BROKER.ids.has(p + '1'), 2000), 'the host re-registers its id');
  const c = pk(2, { prefix: p }); c.join(); ok(await open([c]), 'a newcomer joins'); eq(c.hostId, a.me, 'the same host'); eq(a.state, 'open', 'never migrated'); eq(b.of('host').length, 0, 'no migration at the guest');
});
test("peer backend: the host's id is taken by a newcomer while its socket is down -> the old room moves over to the new host", async () => {
  const p = pre(), a = pk(0, { prefix: p }), b = pk(1, { prefix: p }), c = pk(2, { prefix: p }); a.join(); await open([a]); b.join(); await open([b]);
  BROKER.dropSocket('peer0'); c.join(); ok(await open([c]), 'the newcomer opens'); ok(c.isHost, 'and holds the id now');
  ok(await until(() => [a, b, c].every(r => r.state === 'open' && r.members.size === 3 && r.hostId === c.me), 6000), 'everyone ends up in one room: ' + [a, b, c].map(r => r.state + r.members.size).join(' '));
  a.send({ t: 'chat', s: 'together' }); ok(await until(() => b.of('msg').some(e => e.msg.s === 'together') && c.of('msg').some(e => e.msg.s === 'together')), 'and can talk');
});

// ---------- claim: false · sizes in bytes · stuck ids (a host that died without letting go of its id) ----------
test('claim: false never claims: it waits for the host, and gives up when nobody comes', async () => {
  const id = 'fix-' + pre(), g1 = mk(1, { id, claim: false }), g2 = mk(2, { id, claim: false }), lead = mk(0, { id });
  g1.join(); g2.join(); await sleep(500);
  ok(g1.state === 'connecting' && g2.state === 'connecting' && !REG.holders[id], 'the guests wait and nobody holds the id');
  lead.join(); ok(await open([lead, g1, g2]), 'everyone opens once the host is there');
  ok(lead.isHost && !g1.isHost && !g2.isHost && g1.hostId === lead.me && lead.members.size === 3, 'the one who may claim hosts');
  // ...but in a migration a claim: false member takes part like anybody
  lead.leave(); ok(await until(() => g1.state === 'open' && g2.state === 'open' && g1.hostId === g2.hostId && (g1.isHost || g2.isHost)), 'a claim: false member takes over in a migration');
  const alone = mk(3, { id: 'fix-' + pre(), claim: false }); alone.g.net.T.give = 600;
  try { alone.join(); ok(await until(() => alone.state === 'error' && alone.errCode === 'unreachable', 3000), 'nobody came: unreachable'); } finally { alone.g.net.T.give = FAST_T.give; }
  const hub = mk(4, { prefix: pre(), claim: false }); hub.g.net.T.give = 600;
  try { hub.join(); ok(await until(() => hub.state === 'error', 3000), 'a hub joiner who may not claim gives up too'); eq(hub.n, 0, 'without wandering through the instances'); } finally { hub.g.net.T.give = FAST_T.give; }
});
test('size caps count bytes, not characters', async () => {
  const p = pre(), a = mk(0, { prefix: p, maxMsg: 400 }), b = mk(1, { prefix: p, maxMsg: 400 }); a.join(); await open([a]); b.join(); await open([b]);
  eq(b.send({ t: 'chat', s: 'x'.repeat(300) }), true, '300 ascii characters fit in 400');
  eq(b.send({ t: 'chat', s: '\u00e9'.repeat(300) }), false, '300 two-byte characters do not');
  eq(b.send({ t: 'chat', s: '\u4e16'.repeat(150) }), false, '150 three-byte characters do not');
  eq(b.send({ t: 'chat', s: '\ud83d\ude00'.repeat(90) }), true, '90 four-byte emoji (360 bytes) fit');
  eq(b.send({ t: 'chat', s: '\ud83d\ude00'.repeat(110) }), false, '110 emoji (440 bytes) do not');
  b.setPresence({ note: '\u4e16'.repeat(1400) }); a.setPresence({ ok: 1 }); await sleep(250);
  ok(!a.members.get(b.me).p.note, 'a presence over the byte cap is not spread');
});
// the host dies silently and its id stays taken for `lag` ms: -> { rs, rest, host, p }
async function stuck(count, lag, kind = 'mem') {
  const p = pre(), rs = [];
  for (let i = 0; i < count; i++) { const r = mk(i, { prefix: p, presence: { name: 'P' + i } }, kind); r.join(); ok(await open([r]), 'did not open'); rs.push(r); }
  ok(await until(() => rs.every(r => r.members.size === count)), 'everyone inside');
  const host = rs[0], rest = rs.slice(1); for (const r of rs) r.ev.length = 0;
  if (kind === 'mem') { REG.lag = lag; ok(REG.kill(p + '1', true), 'kill'); REG.lag = 0; } else BROKER.cutNetwork(host.g.tag, lag);
  return { rs, rest, host, p };
}
const together = (rs, n) => rs.every(r => r.state === 'open' && r.hostId === rs[0].hostId && r.members.size === n) && rs.filter(r => r.isHost).length === 1;
test('a stuck host id: the members move together to the successor id, newcomers find them, and the room takes its old id back', async () => {
  const { rest, host, p } = await stuck(5, 4500);
  ok(await until(() => together(rest, 4) && rest.every(r => r.id === p + '1-g1'), 8000), 'the four re-form on the successor id: ' + rest.map(r => r.state + ' ' + r.id + ' ' + r.members.size).join(' | '));
  ok(rest[0].isHost, 'the oldest member hosts it'); ok(rest.every(r => r.n === 1 && r.gen === 1), 'same instance number, generation 1');
  for (const r of rest) { eq(r.of('host').length, 1, 'one host event'); eq(r.of('join').length, 0, 'nobody re-joined as new'); ok(r.of('leave').every(e => e.id === host.me), 'only the old host left'); }
  rest[2].send({ t: 'chat', s: 'moved' }); ok(await until(() => rest.every(r => r === rest[2] || r.of('msg').some(e => e.msg.s === 'moved'))), 'messages flow in the moved room');
  ok(!!REG.holders[p + '1'], '(the old id is still taken)');
  const late = mk(10, { prefix: p }); late.join(); ok(await until(() => late.state === 'open', 3000), 'a newcomer gets in'); eq(late.n, 1, 'into the same instance'); eq(late.id, p + '1-g1', 'through the successor id'); eq(late.members.size, 5, 'and sees everyone');
  // the broker lets go of the old id: the host takes it back and everyone is told
  const all = rest.concat(late);
  ok(await until(() => all.every(r => r.id === p + '1' && r.gen === 0), 8000), 'the room has its plain id again: ' + all.map(r => r.id).join());
  ok(all.every(r => r.state === 'open' && r.of('state').filter(e => e.state === 'migrating').length <= 1), 'without another migration');
  const late2 = mk(11, { prefix: p }); late2.join(); ok(await open([late2]), 'a second newcomer'); ok(!late2.isHost && late2.id === p + '1' && late2.members.size === 6, 'joins the same room through the plain id');
  // the next migration happens on the plain id, for those who came in through the successor id too
  rest[0].leave(); const left = all.slice(1).concat(late2);
  ok(await until(() => together(left, 5) && left.every(r => r.id === p + '1'), 6000), 'next migration: one room on the plain id: ' + left.map(r => r.state + ' ' + r.id + ' ' + r.members.size).join(' | '));
});
test('a stuck host id: a newcomer who takes the freed id before the moved room does -> the moved room joins it (no two rooms with one number)', async () => {
  const { rest, p } = await stuck(4, 60000);
  for (const r of rest) r.g.net.T.reclaim = 700;
  try {
    ok(await until(() => together(rest, 3) && rest.every(r => r.id === p + '1-g1'), 8000), 'the three re-form on the successor id');

    delete REG.holders[p + '1'];   /* the broker lets go ... */
    const x = mk(10, { prefix: p, presence: { name: 'X' } }); x.join();   /* ... and a newcomer is quicker than the moved room */
    ok(await open([x]), 'the newcomer opens'); ok(x.isHost && x.id === p + '1', 'as the host of the plain id');
    const all = rest.concat(x);
    ok(await until(() => all.every(r => r.state === 'open' && r.hostId === x.me && r.members.size === 4 && r.id === p + '1' && r.gen === 0), 8000), 'one room in the end: ' + all.map(r => r.state + ' ' + r.id + ' ' + r.members.size).join(' | '));
    rest[1].send({ t: 'chat', s: 'one street' }); ok(await until(() => all.every(r => r === rest[1] || r.of('msg').some(e => e.msg.s === 'one street'))), 'and they can talk');
  } finally { for (const r of rest) r.g.net.T.reclaim = FAST_T.reclaim; delete REG.holders[p + '1']; }
});
test('a stuck host id that swallows connections (as the real broker does): members move on, a dead instance sends newcomers to the next', async () => {
  REG.hang = 300;
  try {
    const { rest, p } = await stuck(3, 60000);
    ok(await until(() => together(rest, 2) && rest.every(r => r.id === p + '1-g1'), 8000), 'the two re-form on the successor id: ' + rest.map(r => r.state + ' ' + r.id).join(' | '));
    const late = mk(10, { prefix: p }); late.join(); ok(await until(() => late.state === 'open', 4000), 'a newcomer gets in'); eq(late.id, p + '1-g1', 'through the successor id');
    delete REG.holders[p + '1'];
    // an instance whose host died with nobody else inside: taken, unreachable, no successor -> the newcomer opens the next one
    const q = pre(), solo = mk(11, { prefix: q }); solo.join(); await open([solo]); REG.lag = 60000; REG.kill(q + '1', true); REG.lag = 0;
    const nw = mk(12, { prefix: q }); nw.join(); ok(await until(() => nw.state === 'open', 6000), 'the newcomer does not hang on the dead instance: ' + nw.state); eq(nw.n, 2, 'it opened the next instance'); ok(nw.isHost, 'as its host');
    // a fixed room has no next instance: unreachable, as before
    const fid = 'fix-' + pre(), fa = mk(13, { id: fid }); fa.join(); await open([fa]); REG.lag = 60000; REG.kill(fid, true); REG.lag = 0;
    const fb = mk(14, { id: fid }); fb.g.net.T.give = 1500;
    try { fb.join(); ok(await until(() => fb.state === 'error' && fb.errCode === 'unreachable', 6000), 'fixed room: unreachable'); } finally { fb.g.net.T.give = FAST_T.give; }
    delete REG.holders[q + '1']; delete REG.holders[fid];
  } finally { REG.hang = 0; }
});
test('two hosts in a row die on stuck ids: generation 2, and still one room', async () => {
  const { rest, p } = await stuck(5, 60000);
  try {
    ok(await until(() => together(rest, 4) && rest.every(r => r.id === p + '1-g1'), 8000), 'first move');
    REG.lag = 60000; ok(REG.kill(p + '1-g1', true), 'kill the second host'); REG.lag = 0;
    const left = rest.slice(1);
    ok(await until(() => together(left, 3) && left.every(r => r.id === p + '1-g2' && r.gen === 2), 9000), 'second move: ' + left.map(r => r.state + ' ' + r.id + ' ' + r.members.size).join(' | '));
    const late = mk(10, { prefix: p }); late.join(); ok(await until(() => late.state === 'open', 4000), 'a newcomer gets in'); eq(late.id, p + '1-g2', 'through generation 2'); eq(late.members.size, 4, 'and sees everyone');
  } finally { delete REG.holders[p + '1']; delete REG.holders[p + '1-g1']; }
});
test("peer backend: the host's network dies and the broker keeps its id for a long time -> the room moves to the successor id and back", async () => {
  const { rest, host, p } = await stuck(4, 5000, 'peer'); const dead = host.g;
  try {
    ok(await until(() => together(rest, 3) && rest.every(r => r.id === p + '1-g1'), 9000), 'the three re-form on the successor id: ' + rest.map(r => r.state + ' ' + r.id + ' ' + r.members.size).join(' | '));
    const late = pk(5, { prefix: p }); late.join(); ok(await until(() => late.state === 'open', 6000), 'a newcomer gets in: ' + late.state); eq(late.n, 1, 'same instance'); eq(late.members.size, 4, 'sees everyone');
    const all = rest.concat(late);
    ok(await until(() => all.every(r => r.id === p + '1' && r.gen === 0 && r.state === 'open'), 9000), 'the plain id is taken back once the broker lets go: ' + all.map(r => r.id).join());
    const late2 = pk(6, { prefix: p }); late2.join(); ok(await open([late2]), 'a second newcomer'); ok(!late2.isHost && late2.members.size === 5, 'joins the same room through the plain id');
  } finally { for (const r of rooms) if (r.g === dead) r.leave(); await sleep(100); for (const q of BROKER.peers) if (q.tag === dead.tag) { q.dead = false; q.destroy(); } }
});

(async () => {
  const t0 = Date.now();
  for (const [name, f] of tests) {
    try { await f(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e)); }
    for (const r of rooms.splice(0)) r.leave();
    await sleep(80);
  }
  console.log(`${failed ? 'FAILED' : 'ALL PASSED'}: ${tests.length - failed}/${tests.length} tests, ${pools.mem.length + pools.bc.length + pools.peer.length} game copies, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exitCode = failed ? 1 : 0;
})();
