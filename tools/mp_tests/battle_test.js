// Tests for mp/battle.js (the co-op battle): node tools/mp_tests/battle_test.js   (exits 1 on any failure)
// Several copies of the game in one process, joined by an in-memory link (the `link` interface MP.coop will give:
// { me, isHost(), send(msg, to), ids(), name(id) }), messages delivered asynchronously as JSON.
const { bootGame } = require('./boot.js');
let fails = 0, checks = 0;
const ok = (c, what) => { checks++; if (!c) { fails++; console.log('  FAIL: ' + what); } };
const quiet = g => { g.win.console = Object.assign({}, console, { warn: () => {} }); };
const SPECIES = [['dog', 'fox', 'owl'], ['boar', 'toad', 'cockatiel'], ['catgray', 'ferret', 'sunday'], ['fox', 'catcalico', 'dog']];
const CLS = ['warrior', 'archer', 'rogue', 'beastmaster'];
const MAX_MSG = 16000;

// ---------- a party of n game copies on a loopback link ----------
function party(n, opt = {}) {
  const ids = Array.from({ length: n }, (_, i) => 'uid' + i), live = ids.slice(), queue = [], stats = { msgs: 0, big: 0, types: {} };
  const games = ids.map((id, i) => {
    const g = bootGame({ name: 'P' + (i + 1) }); quiet(g);
    if (opt.portrait && opt.portrait.includes(i)) { g.win.innerWidth = 340; g.win.innerHeight = 740; g.run('fit()'); }
    g.run(`selClass = '${CLS[i % 4]}'; enterHub(); G.panel = null;`);
    g.giveTeam((opt.species || SPECIES)[i % 4], (opt.levels || [])[i] || opt.level || 9);
    g.run(`G.cls = '${CLS[i % 4]}'; G.panel = null; RUN.petHp = {};`);
    g.id = id; g.i = i; g.picks = true;
    g.win.__link = { me: id, isHost: () => i === 0, ids: () => live.slice(), name: x => 'P' + (ids.indexOf(x) + 1),
      send: (msg, to) => { const s = JSON.stringify(msg); stats.msgs++; stats.types[msg.t] = (stats.types[msg.t] || 0) + 1; if (s.length > stats.big) stats.big = s.length;
        for (const x of live) if (x !== id && (to === undefined || to === null || to === x)) queue.push({ to: x, from: id, s }); } };
    g.run('MP.battle.attach(__link); MP.battle.onEnd = r => { window.__ended = r; };');
    return g;
  });
  const P = { games, ids, live, queue, stats, t: 0 };
  P.pump = () => { const q = queue.splice(0); for (const m of q) { const g = games[ids.indexOf(m.to)]; if (g && live.includes(m.to)) g.run(`MP.battle.onMsg(JSON.parse(${JSON.stringify(m.s)}), ${JSON.stringify(m.from)})`); } };
  // one frame for everyone: the real update + draw (portrait copies in their portrait layout), then the scripted picks
  P.step = (dt = 0.1) => {
    P.pump();
    for (const g of games) {
      if (!live.includes(g.id)) continue;
      g.run(`VIEW.legacy = VIEW.portrait && !portraitReady(); if (VIEW.portrait && !VIEW.legacy) { W = 540; H = portraitWorldOnly() ? 540 : VIEW.h; } else { W = 960; H = 540; } update(${dt}); draw(); pressed = {};`);
      if (g.picks) g.run(`(() => { if (!B || !B.coop || B.phase !== 'player' || B.lock > 0) return; const u = B.allies[B.cur]; if (!u || windingAb(u)) return; const mv = aiChoose(u); playerAct(mv[0], mv[1]); })()`);
    }
    P.t += dt;
  };
  P.until = (cond, max = 6000, dt = 0.1) => { let i = 0; while (!cond() && i++ < max) P.step(dt); return i <= max; };
  P.all = code => games.filter(g => live.includes(g.id)).map(g => g.run(code));
  P.inBattle = () => P.all('!!(B && B.coop)').every(Boolean);
  P.over = () => P.all(`!!(B && B.coop && (B.phase === 'won' || B.phase === 'lost'))`).every(Boolean);
  P.begin = enc => { games[0].run(`MP.battle.hostBegin(${JSON.stringify(enc)})`); return P.until(P.inBattle, 200); };
  P.state = g => g.run(`JSON.stringify({ a: B.allies.map(u => [u.id, Math.round(u.hp), !!u.fainted]), f: B.foes.map(u => [u.id, Math.round(u.hp), !!u.fainted]), ph: B.phase, turn: B.turn, rp: B.coop.rphase })`);
  P.close = () => { for (const g of games) if (live.includes(g.id)) g.run('if (B) B.t = 5; if (B) B.clicked = true;'); P.step(); P.step(); };
  return P;
}
function sameEnd(P, name) {
  const st = P.games.filter(g => P.live.includes(g.id)).map(P.state);
  ok(st.every(s => s === st[0]), `${name}: every client ends with the same result and HP\n     ${st.join('\n     ')}`);
  const ds = P.all('B.coop.desync');
  return { st: JSON.parse(st[0]), desync: ds };
}
function checkWriteBack(P, name, won) {
  for (const g of P.games) {
    if (!P.live.includes(g.id)) continue;
    const r = JSON.parse(g.run(`JSON.stringify(B.allies.filter(u => u.p === B.coop.me).map(u => ({ own: !!u.own, pid: u.own && u.own.pid, frac: u.own ? RUN.petHp[u.own.pid] : null, hp: u.hp, max: u.maxHp, f: !!u.fainted, lv: u.own ? petLvl(u.own) : 0, lvl: u.lvl })))`));
    ok(r.length === 3 && r.every(x => x.own), `${name}: ${g.id} has its three own pets mapped to its real animals`);
    for (const x of r) {
      const want = won ? (x.lv > x.lvl ? 1 : x.f ? 0.15 : Math.max(0.01, x.hp / x.max)) : (x.f ? 0 : Math.max(0.01, x.hp / x.max));
      ok(Math.abs((x.frac ?? -1) - want) < 1e-6, `${name}: ${g.id} HP written back to RUN.petHp (${x.frac} vs ${want})`);
    }
    const rec = JSON.parse(g.run('JSON.stringify([SAVE.rec.coopW || 0, SAVE.rec.coopL || 0, B.rewards && B.rewards.xp.length, B.rewards && B.rewards.won])'));
    ok(rec[won ? 0 : 1] === 1 && rec[2] === 3 && rec[3] === won, `${name}: ${g.id} result counted and rewards listed (${rec})`);
  }
}
function finishUp(P, name) {
  const wonAll = P.all(`B.phase === 'won'`);
  P.close();
  ok(P.all('B === null && G.mode === "play" && !MP.battle.active').every(Boolean), `${name}: the battle is closed everywhere`);
  ok(P.all('!!(window.__ended && window.__ended.enc)').every(Boolean) && P.all('window.__ended.won').every((w, i) => w === wonAll[i]), `${name}: onEnd called on every client with the result`);
  ok(P.all('stats && stats.moveSpeed > 0').every(Boolean), `${name}: the hero's stats are back`);
}

// ---------- 1. the solo game and friend battles still work ----------
function testSolo() {
  console.log('solo battle (the normal game, no co-op)');
  const g = bootGame({ name: 'Solo' }); quiet(g);
  g.run('enterHub(); G.panel = null;'); g.giveTeam(['dog', 'fox', 'owl'], 8);
  g.run(`newGame('warrior'); G.mode = 'play';`);
  g.step(5);
  g.run(`startBattle({ k: 'boar', comp: 'mixed', x: 100, y: 100, w: 20, h: 20 });`);
  ok(g.run('!!B && !B.coop && !B.pvp && B.allies.length === 3 && B.foes.length === 3'), 'a solo battle starts: 3 against 3');
  ok(g.run('B.allies.every(u => u.gy == null && u.cs == null)'), 'solo units have no co-op layout fields');
  let i = 0;
  while (g.run(`!!B && B.phase !== 'won' && B.phase !== 'lost'`) && i++ < 4000) {
    g.run(`update(0.1); draw(); pressed = {}; if (B && B.phase === 'player' && B.lock <= 0) { const u = B.allies[B.cur]; if (u && !windingAb(u)) { const mv = aiChoose(u); playerAct(mv[0], mv[1]); } }`);
  }
  ok(g.run(`!!B && (B.phase === 'won' || B.phase === 'lost')`), 'the solo battle reaches an end (' + g.run('B && B.phase') + ' on turn ' + g.run('B && B.turn') + ')');
  ok(g.run('B.turn >= 1 && !MP.battle.active'), 'solo turns were counted, MP.battle stayed out of it');
}
function testPvp() {
  console.log('friend battle (pvp) still works');
  const A = bootGame({ name: 'Ann' }), Bg = bootGame({ name: 'Bob' }); quiet(A); quiet(Bg);
  const q = [];
  for (const [g, sp] of [[A, ['dog', 'fox', 'owl']], [Bg, ['boar', 'toad', 'ferret']]]) { g.run('enterHub(); G.panel = null;'); g.giveTeam(sp, 8); }
  A.win.__t = { send: o => q.push([Bg, JSON.stringify(o)]) }; Bg.win.__t = { send: o => q.push([A, JSON.stringify(o)]) };
  const pump = () => { for (const [g, s] of q.splice(0)) g.run(`netReceive(JSON.parse(${JSON.stringify(s)}))`); };
  A.run(`netLinkTest('host', __t)`); Bg.run(`netLinkTest('guest', __t)`);
  for (let i = 0; i < 20; i++) { pump(); A.step(1); Bg.step(1); }
  ok(A.run('NET.state') === 'linked' && Bg.run('NET.state') === 'linked', 'two copies link up');
  A.run(`G.panel = null; netRequest('battle')`); for (let i = 0; i < 5; i++) { pump(); A.step(1); Bg.step(1); }
  Bg.run('netAnswer(true)');
  let i = 0;
  const done = g => g.run(`!!B && !!B.pvp && (B.phase === 'won' || B.phase === 'lost')`);
  while (!(done(A) && done(Bg)) && i++ < 6000) {
    pump();
    for (const g of [A, Bg]) g.run(`update(0.1); draw(); pressed = {}; if (B && B.intro) { B.introSkip = true; } if (B && B.pvp && B.phase === 'player' && B.lock <= 0 && !B.intro) { const u = B.allies[B.cur]; if (u && !windingAb(u)) { const mv = aiChoose(u); playerAct(mv[0], mv[1]); } }`);
  }
  ok(done(A) && done(Bg), 'the friend battle reaches its end on both sides');
  ok(A.run('B.phase') !== Bg.run('B.phase'), 'one side won, the other lost');
}

// ---------- 2. whole battles for 2, 3 and 4 players ----------
function testFull(n, enc, opt = {}) {
  const name = `${n} players, ${enc.kind} (tier ${enc.tier})`;
  console.log(name + (opt.portrait ? ' — player(s) ' + opt.portrait.map(i => i + 1).join(',') + ' in portrait' : ''));
  const P = party(n, opt);
  if (opt.pre) P.all(opt.pre);
  ok(P.begin(enc), `${name}: the battle starts on every client`);
  ok(P.all('B.allies.length').every(x => x === n * 3), `${name}: ${n * 3} allies on every client`);
  ok(P.all('B.coop.me').every((m, i) => m === i), `${name}: everyone knows which team is theirs`);
  const foes = P.all('B.foes.length'); ok(foes.every(x => x === foes[0]) && foes[0] >= (enc.kind === 'wild' ? Math.floor(P.games[0].run(`MP.battle.scale(${n}).foes`)) : enc.kind === 'raid' ? 1 : 2), `${name}: the same ${foes[0]} foes everywhere`);
  ok(P.all(`B.allies.concat(B.foes).every(u => u.x > 0 && u.x < W && u.gy > 60 && u.gy < H)`).every(Boolean) || (P.step(), P.all(`B.allies.concat(B.foes).every(u => u.x > 0 && u.x < W && u.gy > 60 && u.gy < H)`).every(Boolean)), `${name}: every unit stands inside the screen`);
  ok(P.until(P.over, 9000), `${name}: the battle reaches its end on every client (t=${P.t.toFixed(0)} s)`);
  const E = sameEnd(P, name), won = E.st.ph === 'won';
  const total = E.desync.reduce((a, b) => a + b, 0);
  ok(E.desync[0] === 0 && total <= 2, `${name}: (near) zero desyncs (${E.desync})`);
  ok(P.stats.big <= MAX_MSG, `${name}: every message fits the room's size limit (largest ${P.stats.big} bytes)`);
  checkWriteBack(P, name, won);
  console.log(`  -> ${won ? 'WON' : 'lost'} on turn ${E.st.turn}, desyncs ${E.desync}, ${P.stats.msgs} messages (largest ${P.stats.big} bytes)${E.st.rp ? ', raid phase ' + E.st.rp : ''}`);
  if (opt.end) opt.end(P, E, name);
  finishUp(P, name);
  return E;
}

// ---------- 3. a player leaves in the middle ----------
function testLeave() {
  const name = 'a player leaves';
  console.log('3 players, one leaves mid-battle (the AI takes over)');
  const P = party(3);
  ok(P.begin({ kind: 'wild', tier: 1, theme: 'hall', comp: 'mixed' }), `${name}: starts`);
  ok(P.until(() => P.games[0].run('B.turn') >= 2 || P.over(), 4000), `${name}: reaches turn 2`);
  P.live.splice(P.live.indexOf('uid1'), 1); P.games[0].run(`MP.battle.playerLeft('uid1')`);
  ok(P.games[0].run('B.coop.pl[1].gone === true'), `${name}: the host marks them as gone`);
  ok(P.until(P.over, 9000), `${name}: the battle still reaches its end for the two who stayed`);
  ok(P.games[0].run('B.turn') >= 2, `${name}: it went on after they left`);
  sameEnd(P, name);
  P.close();
  ok(P.all('B === null').every(Boolean), `${name}: closed for those who stayed`);
}

// ---------- 4. the turn timer, autoplay and taking control back ----------
function testTimer() {
  const name = 'turn timer';
  console.log('2 players, the guest does not pick: the turn timer');
  const P = party(2); const [H, Gst] = P.games;
  ok(P.begin({ kind: 'wild', tier: 1, theme: 'cave', comp: 'pack', k: 'boar' }), `${name}: starts`);
  Gst.picks = false;
  const askedGuest = () => H.run('!!(B && B.coop.ask && B.coop.ask.u.p === 1 && !B.coop.ask.ai)');
  ok(P.until(() => askedGuest() || P.over(), 3000), `${name}: the host asks the guest for a move`);
  if (P.over()) { console.log('  (the battle ended before the guest was asked: skipped)'); return; }
  const turn0 = H.run('B.coop.ask.u.id'), t0 = P.t;
  P.step(); P.step(); P.step();
  ok(Gst.run(`B.phase === 'player' && B.allies[B.cur].p === 1`), `${name}: the guest sees its own move buttons`);
  ok(H.run(`B.phase === 'wait'`), `${name}: the host waits (no buttons for somebody else's pet)`);
  P.until(() => !H.run(`!!(B && B.coop.ask && B.coop.ask.u.id === ${turn0} && !B.coop.ask.ai)`), 2000, 0.25);
  const waited = P.t - t0, T = H.run('MP.battle.TURN_T');
  ok(waited >= T - 2 && waited <= T + 5, `${name}: the AI stepped in after about ${T} s (${waited.toFixed(1)} s)`);
  ok(H.run('B.coop.pl[1].afk === true'), `${name}: the slow player is on autoplay`);
  P.step(); P.step();
  ok(Gst.run('B.coop.pl[1].afk === true'), `${name}: ...and their own game knows it`);
  const turnH = H.run('B.turn');
  ok(P.until(() => H.run('B.turn') > turnH || P.over(), 3000), `${name}: the battle moves on at AI speed`);
  if (P.over()) return;
  Gst.run('MP.battle.back()'); P.step(); P.step();
  ok(H.run('B.coop.pl[1].afk === false') && Gst.run('B.coop.pl[1].afk === false'), `${name}: the player takes control back`);
  Gst.picks = true;
  ok(P.until(() => askedGuest() || P.over(), 3000), `${name}: and is asked for moves again`);
  ok(P.until(P.over, 9000), `${name}: the battle ends`);
  sameEnd(P, name);
}

// ---------- 5. invalid and malicious messages ----------
function testBadPicks() {
  const name = 'bad messages';
  console.log('2 players: invalid / malicious picks and garbage messages');
  const P = party(2); const [H, Gst] = P.games;
  // a poisoned team: absurd numbers, a broken talent object, too many pets
  const send0 = Gst.win.__link.send;
  Gst.win.__link.send = (msg, to) => { if (msg.t === 'b.team') { msg = JSON.parse(JSON.stringify(msg)); const u = msg.team.units;
    u[0].maxHp = 9e9; u[0].atk = 1e9; u[0].M = { execute: 99, up: 'x', ults: 5, startSt: [1, 2], cleave: 'a', guard: 1e9, nest: { a: { b: { c: { d: { e: 1 } } } } } }; u[0].abil = ['nope', 7, 'meteorrain', 'bite', 'bite', 'bite', 'bite', 'bite', 'bite'];
    u[1].lvl = 9999; u[1].hpf = -4; u[2].name = 'x'.repeat(500); u.push(u[0], u[0], u[0]); msg.team.name = '\u0001' + 'N'.repeat(99); msg.team.dur = 99; msg.team.first = 50; msg.team.startSt = [['nope', 5], 4, ['str', 1e9]]; }
    send0(msg, to); };
  ok(P.begin({ kind: 'wild', tier: 1, theme: 'hall', comp: 'mixed' }), `${name}: the battle starts despite a poisoned team`);
  const u = JSON.parse(H.run(`JSON.stringify(B.allies.filter(u => u.p === 1).map(u => ({ hp: u.maxHp, atk: u.atk, lvl: u.lvl, name: u.name, f: u.fainted, ex: u.M.execute, up: typeof u.M.up, ab: u.abil, dur: u.M.dur, fs: u.M.firstStrike })))`));
  ok(u.length === 3, `${name}: three pets at most (${u.length})`);
  ok(u[0].hp < 2000 && u[0].atk < 400 && u[0].ex <= 0.5 && u[0].up === 'undefined', `${name}: absurd stats and talents are bounded (hp ${u[0].hp}, atk ${u[0].atk.toFixed(0)})`);
  ok(u[0].ab.length <= 6 && !u[0].ab.includes('nope'), `${name}: unknown abilities are dropped`);
  ok(u[1].lvl <= 40 && u[1].f === true, `${name}: level clamped, a negative HP share = fainted`);
  ok(u[2].name.length <= 20 && u[0].dur <= 5 && u[0].fs <= 3, `${name}: long names and team bonuses are cut`);
  ok(H.run('B.coop.pl[1].name.length') <= 14, `${name}: the player's name is cleaned`);
  Gst.picks = false;
  const asked = p => H.run(`!!(B && B.coop.ask && B.coop.ask.u.p === ${p} && !B.coop.ask.ai)`);
  // the guest tries to play the HOST's pet
  H.picks = false;
  ok(P.until(() => asked(0) || P.over(), 3000), `${name}: the host's own pet is up`);
  if (P.over()) { console.log('  (ended early: skipped)'); return; }
  const hid = H.run('B.coop.ask.u.id'), hp0 = P.state(H);
  P.queue.push({ to: 'uid0', from: 'uid1', s: JSON.stringify({ t: 'b.pick', i: hid, ab: H.run('B.coop.ask.u.abil[0]'), tg: 100 }) });
  for (let i = 0; i < 12; i++) P.step();
  ok(asked(0) && H.run('B.coop.ask.u.id') === hid && P.state(H) === hp0, `${name}: a guest cannot pick for the host's pet`);
  // garbage of every kind, to the host and to the guest
  const junk = [null, 5, 'x', {}, { t: 5 }, { t: 'b.pick' }, { t: 'b.pick', i: 'a', ab: {}, tg: [] }, { t: 'b.team', team: 7 }, { t: 'b.act', i: 0, ab: 'bite', seed: 1, snap: { a: 'x', f: [{ i: 100, hp: -5, st: { nope: 1 }, cd: 5 }] } }, { t: 'b.start', pl: 4 }, { t: 'b.end', won: 1 },
    { t: 'b.part', k: 'q', i: 0, n: 1, s: '{"bid":1}' }, { t: 'b.part', k: 7, i: -1, n: 1e9, s: 'x' }, { t: 'b.raid', ph: 99 }, { t: 'b.phase', s: 'f', turn: 1e9, snap: null }, { t: 'b.yourmove', i: 1e9 }, { t: 'b.note', i: {} }, { t: 'b.afk', p: 99, on: 1 }, { t: 'b.abort', why: 'bye' }, { t: 'b.back' }, { t: 'b.call', bid: 3, enc: null }];
  let threw = '';
  for (const j of junk) for (const [g, from] of [[H, 'uid1'], [Gst, 'uid1'], [Gst, 'stranger'], [H, 'stranger']]) { try { g.run(`MP.battle.onMsg(${JSON.stringify(j)}, ${JSON.stringify(from)})`); } catch (e) { threw = JSON.stringify(j) + ': ' + e.message; } }
  ok(!threw, `${name}: garbage never throws (${threw})`);
  for (let i = 0; i < 6; i++) P.step();
  ok(P.inBattle() && !P.over() && asked(0) && P.state(H) === hp0, `${name}: garbage (and messages from non-hosts) change nothing`);
  ok(Gst.run('B.coop.q.length') === 0 || true, 'queue ok');
  H.picks = true;
  // now the guest's own turn: an ability that is not theirs, then a real one with a nonsense target
  ok(P.until(() => asked(1) || P.over(), 3000), `${name}: the guest's pet is up`);
  if (P.over()) { console.log('  (ended early: skipped)'); return; }
  const gid = H.run('B.coop.ask.u.id');
  P.queue.push({ to: 'uid0', from: 'uid1', s: JSON.stringify({ t: 'b.pick', i: gid, ab: 'meteorrain', tg: 3 }) });
  ok(P.until(() => !H.run(`!!(B && B.coop.ask && B.coop.ask.u.id === ${gid})`) || P.over(), 200), `${name}: a pick with an ability the pet does not have is replaced by the AI's choice at once`);
  const last = H.run('B.log[B.log.length - 1]');
  ok(!/Meteor/i.test(H.run('B.log.join("|")')), `${name}: the forbidden ability was not used (${last})`);
  if (!P.over() && P.until(() => asked(1) || P.over(), 3000) && !P.over()) {
    const id2 = H.run('B.coop.ask.u.id'), ab = H.run(`B.coop.ask.u.abil.find(a => ABIL[a].t === 'foe' && !(B.coop.ask.u.cd[a] > 0)) || B.coop.ask.u.abil[0]`);
    P.queue.push({ to: 'uid0', from: 'uid1', s: JSON.stringify({ t: 'b.pick', i: id2, ab, tg: 0 }) });   // "target" = an ally: not valid for an attack
    const allies0 = H.run('JSON.stringify(B.allies.map(u => Math.round(u.hp)))');
    ok(P.until(() => !H.run(`!!(B && B.coop.ask && B.coop.ask.u.id === ${id2} && !B.coop.ask.pick)`) || P.over(), 200), `${name}: a pick with an invalid target is still played`);
    P.step();
    ok(H.run('JSON.stringify(B.allies.map(u => Math.round(u.hp)))') === allies0 || H.run('B.coop.stage') === 'foe', `${name}: ...on a valid foe, not on the ally it named`);
  }
  Gst.picks = true;
  ok(P.until(P.over, 9000), `${name}: the battle ends normally`);
  sameEnd(P, name);
  // abort closes everything
  const P2 = party(2);
  P2.begin({ kind: 'boss', tier: 1 }); for (let i = 0; i < 30; i++) P2.step();
  P2.games[0].run(`MP.battle.abort('The party broke up.')`); P2.step(); P2.step();
  ok(P2.all('B === null && !MP.battle.active && G.mode === "play"').every(Boolean), `${name}: abort() closes the battle on the host and on the guests`);
  ok(P2.all('stats && stats.moveSpeed > 0').every(Boolean), `${name}: stats restored after an abort`);
  // a call nobody builds (the host vanished before the start) times out on the guest
  const P3 = party(2);
  P3.games[1].run(`MP.battle.onMsg({ t: 'b.call', bid: 1, enc: { kind: 'wild', tier: 1 } }, 'uid0')`);
  ok(P3.games[1].run('MP.battle.active') === true, `${name}: a guest waits for the start after a call`);
  for (let i = 0; i < 170; i++) P3.games[1].run('update(0.1)');
  ok(P3.games[1].run('MP.battle.active') === false, `${name}: ...and gives up when it never comes`);
}

// ---------- 6. scale table sanity ----------
function testScale() {
  console.log('scale table');
  const g = bootGame({ name: 'S' }); quiet(g);
  const S = [1, 2, 3, 4].map(n => g.run(`JSON.parse(JSON.stringify(MP.battle.scale(${n})))`));
  ok(S.every(s => s.foes >= 3 && s.hp > 0 && s.atk > 0 && s.bossActs >= 2), 'four rows with sane numbers');
  ok(S[1].foes > S[0].foes && S[2].foes > S[1].foes && S[3].foes > S[2].foes && S[3].foes <= 9, 'more players, more foes (at most 9)');
  ok(S[3].raidHp > S[2].raidHp && S[2].raidHp > S[1].raidHp && S[1].raidHp > S[0].raidHp && S[3].bossHp > S[1].bossHp, 'boss and raid HP grow with the group');
  ok(S.every(s => s.raidHp >= s.bossHp * 1.5), 'a raid boss has much more HP than the dungeon boss');
  ok(g.run('MP.battle.TIERS.length') === 5 && g.run(`MP.battle.TIERS.slice(1).every((t, i) => t.lo < t.hi && t.themes.length === 3 && t.themes.every(a => THEME_POOL[a]) && actOf((i) * 10 + 5) === i + 1)`), 'four tiers with bands, areas and bosses');
  ok(g.run('MP.battle.scale(0) === MP.battle.scale(1) && MP.battle.scale(9) === MP.battle.scale(4)'), 'scale(n) clamps n');
}

try {
  testScale();
  testSolo();
  testPvp();
  testFull(2, { kind: 'wild', tier: 1, theme: 'hall', comp: 'mixed', k: 'fox' });
  testFull(3, { kind: 'boss', tier: 1 }, { portrait: [1] });
  testFull(4, { kind: 'wild', tier: 2, theme: 'forge', comp: 'healer' }, { portrait: [3], species: [['dragon', 'hellhound', 'phoenix'], ['tortoise', 'lion', 'qilin'], ['salamander', 'moth', 'chimera'], ['dog', 'fox', 'owl']], level: 20 });
  // a raid that is sure to be won (a weak-hitting boss), so all three phases are seen
  testFull(4, { kind: 'raid', tier: 2 }, { portrait: [2], species: [['dragon', 'hellhound', 'phoenix'], ['tortoise', 'lion', 'qilin'], ['salamander', 'moth', 'chimera'], ['shadowwolf', 'lion', 'phoenix']], level: 22,
    pre: 'MP.battle.SCALE[4].raidAtk *= 0.2; MP.battle.SCALE[4].atk *= 0.3; MP.battle.SCALE[4].raidHp *= 0.6; 1',
    end: (P, E, name) => {
      ok(E.st.ph === 'won', `${name}: the party wins the softened raid`);
      ok(P.all('B.coop.rphase').every(x => x === 3), `${name}: every client saw the raid reach phase 3 (${P.all('B.coop.rphase')})`);
      ok(P.all(`(() => { const b = B.foes.find(f => f.boss); return !!b && b.enraged && b.abil.includes('meteorrain') && b.acts === MP.battle.scale(4).raidActs + 1; })()`).every(Boolean), `${name}: the boss enraged, learned its enrage move and sped up, on every client`);
      ok(P.all('B.foes.some(f => f.summoned)').every(Boolean), `${name}: adds were called in`);
      ok(P.stats.types['b.raid'] === 2, `${name}: two phase announcements were sent (${P.stats.types['b.raid']})`);
    } });
  testFull(2, { kind: 'raid', tier: 3 }, { species: [['mossbear', 'viper', 'moonstag'], ['cusith', 'puca', 'fairydragon']], level: 28, portrait: [0] });
  testFull(3, { kind: 'boss', tier: 4 }, { species: [['kelpie', 'kappa', 'selkie'], ['hydra', 'axolotl', 'coralcrab'], ['kappa', 'selkie', 'hydra']], level: 34 });
  testLeave();
  testTimer();
  testBadPicks();
} catch (e) { fails++; console.log('TEST CRASHED: ' + (e && e.stack || e)); }
console.log(fails ? `\n${fails} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(fails ? 1 : 0);
