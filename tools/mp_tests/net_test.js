// node tools/mp_tests/net_test.js : MP.net (mp/net.js) over the in-memory backend, with many copies of the game in one process.
// Every test prints PASS or FAIL; the process exits 1 when anything failed. Timings are shrunk (MP.net.T) so it runs in seconds.
const { bootGame } = require('./boot.js');
const REG = {};
const FAST_T = { pump: 25, pres: 40, fast: 25, ping: 100, hostDead: 500, guestDead: 700, hello: 500, stagger: 100, jitter: 30, retry: 50, give: 3000, grace: 600, bye: 40, linger: 30 };
const pool = [], rooms = [];
const quiet = console.error;
function game(i) {
  while (pool.length <= i) { const g = bootGame({ name: 'P' + pool.length, globals: { __MPMEM: REG } }); g.net = g.run('MP.net'); Object.assign(g.net.T, FAST_T); pool.push(g); }
  return pool[i];
}
// a room for copy i: `ev` collects its events
function mk(i, opts) {
  const ev = [], g = game(i);
  const room = g.net.room(Object.assign({ on: e => ev.push(e) }, opts));
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
  await end(host, p + '1');
  ok(await until(() => rest[0].state === 'migrating', 1500), 'the others should start migrating');
  eq(rest[0].send({ t: 'q', s: 'queued' }), true, 'send() while migrating queues');
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

(async () => {
  const t0 = Date.now();
  for (const [name, f] of tests) {
    try { await f(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e)); }
    for (const r of rooms.splice(0)) r.leave();
    await sleep(80);
  }
  console.log(`${failed ? 'FAILED' : 'ALL PASSED'}: ${tests.length - failed}/${tests.length} tests, ${pool.length} game copies, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exitCode = failed ? 1 : 0;
})();
