// node tools/mp_tests/coop_test.js [test name] — the party session (mp/coop.js): 2-4 copies of the game play co-op
// dungeons and raids from MP.coop.start() to the completion panel, over the real mp/net.js ('mem' backend).
// Time is VIRTUAL: every copy gets this file's Date / setTimeout / setInterval, and one frame = 1/60 s on that clock,
// so MP.net's rate limits, retries and heartbeats behave as in real time while the test runs as fast as it can.
// The battle is the real mp/battle.js when that file exists; until then a small stand-in that lives ONLY in this file.
const fs = require('fs'), path = require('path');
const { bootGame, ROOT } = require('./boot.js');
const REAL_BATTLE = fs.existsSync(path.join(ROOT, 'mp/battle.js'));
const ONLY = process.argv[2] || '';
let fails = 0, checks = 0;
const ok = (c, what) => { checks++; if (!c) { fails++; console.log('  FAIL: ' + what); } else if (process.env.V) console.log('  ok: ' + what); };
const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

// ---------- virtual time ----------
const CLOCK = { t: 1.7e12, timers: [], id: 1 };
class VDate extends Date { constructor(...a) { if (a.length) super(...a); else super(CLOCK.t); } static now() { return CLOCK.t; } }
const vTimeout = (f, ms, ...a) => { const id = CLOCK.id++; CLOCK.timers.push({ id, at: CLOCK.t + Math.max(0, +ms || 0), f, a }); return id; };
const vInterval = (f, ms, ...a) => { const id = CLOCK.id++; CLOCK.timers.push({ id, at: CLOCK.t + Math.max(1, +ms || 1), f, a, every: Math.max(1, +ms || 1) }); return id; };
const vClear = id => { const k = CLOCK.timers.findIndex(t => t.id === id); if (k >= 0) CLOCK.timers.splice(k, 1); };
const settle = () => new Promise(r => setImmediate(r));
async function runTimers() {
  for (let n = 0; n < 100; n++) {
    const due = CLOCK.timers.filter(t => t.at <= CLOCK.t).sort((a, b) => a.at - b.at || a.id - b.id);
    if (!due.length) break;
    for (const t of due) { if (!CLOCK.timers.includes(t)) continue; if (t.every) t.at = Math.max(t.at + t.every, CLOCK.t + 1); else vClear(t.id); try { t.f(...t.a); } catch (e) { console.error(e); } }
    await settle();
  }
  await settle();
}
const MEM = {};   // MP.net's in-memory registry, shared by every copy

// ---------- stand-in for MP.battle: opens for everyone on 'b.start', the test decides who wins ----------
function standInBattle() {
  const b = { active: false, link: null, onEnd: null, enc: null, left: [], begun: 0,
    attach(link) { b.link = link; b.active = false; b.enc = null; }, myTeam: () => [],
    hostBegin(enc) { b.link.send({ t: 'b.start', enc }); b.open(enc); },
    open(enc) { b.active = true; b.enc = clone(enc); b.begun++; },
    onMsg(msg) { if (msg.t === 'b.start') b.open(msg.enc); else if (msg.t === 'b.end') b.close(!!msg.won); },
    playerLeft(id) { b.left.push(id); },
    close(won) { if (!b.active) return; b.active = false; const enc = b.enc; if (b.onEnd) b.onEnd({ won, enc }); },
    finish(won) { b.link.send({ t: 'b.end', won }); b.close(won); } };
  return b;
}

// ---------- the players ----------
const games = [];
function player(name, team) {
  const g = bootGame({ name, globals: { __MPMEM: MEM, Date: VDate, setTimeout: vTimeout, clearTimeout: vClear, setInterval: vInterval, clearInterval: vClear } });
  g.name = name; g.run('enterHub()'); g.giveTeam(team, 12); g.step(2);
  if (!REAL_BATTLE) { g.battle = g.win.__battle = standInBattle(); g.run('MP.battle = __battle'); }
  g.uid = g.run('MP.net.uid'); g.portrait = false;
  g.S = () => g.run('MP.coop.state()');
  g.q = code => g.run(code);
  games.push(g); return g;
}
let FRAME = 0;
// one frame for every game in `gs` (drawing every 6th frame, and the portrait player in portrait)
async function frames(gs, n = 1, each) {
  for (let i = 0; i < n; i++) {
    FRAME++; CLOCK.t += 1000 / 60;
    for (const g of gs) {
      g.run(g.portrait ? 'VIEW.portrait = true; VIEW.w = 540; VIEW.h = 1100; W = 540; H = portraitWorldOnly() ? 540 : VIEW.h;' : 'VIEW.portrait = false; W = 960; H = 540;');
      g.step(1, FRAME % 6 === 0);
    }
    await runTimers();
    if (each) each(i);
  }
}
async function until(gs, cond, max = 1500, what = '') { for (let i = 0; i < max; i++) { if (cond()) return true; await frames(gs, 1); } ok(false, 'timed out waiting for: ' + what); return false; }
const info = (gs, kind, tier, code, seed = 12345) => ({ code, kind, tier, seed, leader: gs[0].uid, members: gs.map(g => ({ id: g.uid, name: g.name })) });
const startAll = (gs, inf, order = gs) => { for (const g of order) { g.win.__info = clone(inf); ok(g.run('MP.coop.start(__info)') === true, g.name + ' starts the session'); } };
const fl = g => g.run('MP.coop.state() ? MP.coop.state().fl : null');
const phase = g => g.run('MP.coop.state() ? MP.coop.state().phase : null');
const gridSig = g => g.run('(() => { let h = 0; for (const t of G.room.grid) h = (h * 31 + t) >>> 0; return h + ":" + G.wild.map(e => e.k + (e.comp || "")).join(",") + ":" + G.room.entry.x + ":" + G.room.exitY + ":" + G.room.type + ":" + G.room.n; })()');
const onto = (g, w) => g.run(`(() => { const e = G.wild[${w}], P = G.player; P.x = e.x + e.w / 2 - P.w / 2; P.y = e.y + e.h - P.h; P.vx = P.vy = 0; })()`);
const toExit = g => g.run('(() => { const r = exitRect(G.room), P = G.player; P.x = r.x + 10; P.y = r.y + r.h - P.h; P.vx = P.vy = 0; })()');
const toEntry = g => g.run('(() => { const R = G.room, P = G.player; P.x = R.entry.x - P.w / 2; P.y = R.entry.y - P.h; P.vx = P.vy = 0; })()');
const battling = g => (REAL_BATTLE ? g.run('!!(MP.battle && MP.battle.active)') : g.battle.active);
// the encounter the battle module was given (once the battle is really open on that client)
const opened = gs => (REAL_BATTLE ? until(gs, () => gs.every(g => g.run('!!(B && B.coop) && G.mode === "battle"')), 1200, 'the battle screen is open for everyone') : Promise.resolve(true));
const encOf = g => (REAL_BATTLE ? JSON.parse(g.run('JSON.stringify(B && B.coop ? B.coop.enc : {})')) : g.battle.enc) || {};
const host = gs => gs.find(g => g.run('!!(MP.coop.state() && MP.coop.state().room.isHost)'));
// ---- finishing a battle: the stand-in's switch, or the real battle auto-played through its own API/UI ----
async function fight(gs, won) {
  if (!REAL_BATTLE) { host(gs).battle.finish(won); await frames(gs, 3); return; }
  await realFight(gs, won);
}
// the real battle: the host's game lets the AI play every pet at full speed, with the outcome forced (the foes, or the
// party, are one hit from fainting); then every player closes their own result screen
async function realFight(gs, won) {
  const H = host(gs);
  if (!await until(gs, () => gs.every(g => g.run('!!(B && B.coop) && G.mode === "battle"')), 1200, 'the battle screen is open for everyone')) return;
  const rig = () => H.run(`(() => { if (!B || !B.coop) return; B.coop.auto = true; B.coop.fast = true; ${won ? 'for (const f of B.foes) { f.hp = Math.min(f.hp, 1); f.shield = 0; f.atk = 0; } for (const u of B.allies) if (!u.fainted) u.hp = u.maxHp;' : 'for (const u of B.allies) { u.hp = Math.min(u.hp, 1); u.shield = 0; } for (const f of B.foes) f.atk = 9999;'} })()`);
  await until(gs, () => { rig(); return gs.every(g => g.run('!B || !B.coop || B.phase === "won" || B.phase === "lost"')); }, 9000, 'the battle is decided on every client');
  ok(gs.every(g => g.run('!B || !B.coop || B.phase') === (won ? 'won' : 'lost') || !g.run('!!(B && B.coop)')), 'every client saw the same outcome (' + (won ? 'won' : 'lost') + ')');
  for (const g of gs) g.step(1, true);
  for (let k = 0; k < 60 && gs.some(g => g.run('!!(B && B.coop)')); k++) { const still = gs.filter(g => g.run('!!(B && B.coop)')); for (const g of still) g.press('Enter'); await frames(gs, 2); for (const g of still) g.release('Enter'); await frames(gs, 20); }
}
// win one group: `g` walks into wild group w, everyone fights, the host's side wins
async function winGroup(gs, g, w) {
  onto(g, w);
  if (!await until(gs, () => gs.every(battling), 400, g.name + ' touching group ' + w + ' opens the battle for everyone')) return false;
  await fight(gs, true);
  return until(gs, () => gs.every(x => !battling(x) && x.run(`G.wild[${w}].beaten`) && !x.run('MP.coop.state().enc')), 600, 'group ' + w + ' beaten for everyone');
}
async function gather(gs, inf, order) {
  startAll(gs, inf, order);
  ok(gs.every(g => g.run('MP.coop.active && !!G.coop && !G.hub')), 'everyone is in the co-op world (antechamber), not the hub');
  return until(gs, () => gs.every(g => fl(g) === 0 && g.run('G.mode') === 'play'), 3000, 'everyone on floor 1');
}
async function clearFloor(gs, who = gs[0]) {   // win groups until the exit is open
  for (let w = 0; w < 12 && !gs[0].run('exitOpen()'); w++) if (gs[0].run(`!!G.wild[${w}] && !G.wild[${w}].beaten`)) { toEntry(who); await frames(gs, 80); if (!await winGroup(gs, who, w)) return false; }
  await frames(gs, 80);   // (the grace after a battle)
  return gs.every(g => g.run('exitOpen()'));
}
const backHome = async gs => { for (const g of gs) g.press('Enter'); await frames(gs, 3); for (const g of gs) g.release('Enter'); await frames(gs, 30); };

// ====================================================================================================
const TESTS = {
  async dungeon2() {
    const [A, B] = games.slice(0, 2), gs = [A, B];
    const rec = gs.map(g => g.run('JSON.stringify([SAVE.rec.runs, SAVE.rec.bestFloor, SAVE.rec.deaths, SAVE.rec.wins, SAVE.rec.abandoned || 0])'));
    await gather(gs, info(gs, 'dungeon', 1, 'T2A'));
    ok(host(gs) === A, 'the leader hosts the party room');
    ok(gridSig(A) === gridSig(B), 'floor 1 is identical on both clients');
    ok(A.run('MP.coop.state().sums[0]') === B.run('MP.coop.state().sums[0]') && A.run('MP.coop.state().sums[0]') > 0, 'floor checksums match');
    ok(A.run('G.room.chests.length') === 0 && A.run('(G.room.cages || []).length') === 0, 'no chests or cages on a co-op floor');
    ok(A.run('G.roomNum') === 2 || A.run('G.roomNum') === 4 || A.run('G.roomNum') === 7, 'floor numbers stay inside the act (' + A.run('G.roomNum') + ')');
    ok(/Dungeon 1\/4/.test(A.run('MP.coop.where()')), 'HUD says Dungeon 1/4: ' + A.run('MP.coop.where()'));
    // remote heroes appear and move
    A.run('G.player.x += 90'); await frames(gs, 40);
    ok(B.run(`(() => { const o = MP.coop.state().others.get(${JSON.stringify(A.uid)}); return !!o && !!o.P && Math.abs(o.P.x - ${A.run('G.player.x')}) < 30; })()`), "A's hero is seen (and follows) on B's screen");
    const bx = B.run('G.player.x'); B.press('d'); await frames(gs, 50); B.release('d'); await frames(gs, 30);
    ok(B.run('G.player.x') > bx + 20 && A.run(`(() => { const o = MP.coop.state().others.get(${JSON.stringify(B.uid)}); return !!o && !!o.P && Math.abs(o.P.x - ${B.run('G.player.x')}) < 30; })()`), "B walks; A sees B's hero move");
    // wild animals follow the host
    await frames(gs, 240);
    const dmax = A.run('G.wild.map(e => e.x)').map((x, k) => Math.abs(x - B.run(`G.wild[${k}].x`)));
    ok(Math.max(...dmax) < 40, "wild positions on the guest follow the host's (max diff " + Math.round(Math.max(...dmax)) + ' px)');
    ok(A.run('G.wild.some(e => Math.abs(e.x + e.w / 2 - e.homeX) > 3)'), 'the wild animals roam on the host');
    // pausing does not freeze the session for the others
    A.run('openPause()'); ok(A.run('JSON.stringify(pauseItems().map(i => i[0]))') === '["resume","animals","leave"]', 'pause menu in co-op: resume / animals / leave');
    const wx = B.run('G.wild.map(e => Math.round(e.x)).join()'); await frames(gs, 200);
    ok(B.run('G.wild.map(e => Math.round(e.x)).join()') !== wx, 'the host pausing does not stop the world for the guest');
    A.run('closePause()');
    // the guest touches a group: battle for everyone, world frozen
    toEntry(A); await frames(gs, 5);
    onto(B, 0); await until(gs, () => gs.every(battling), 400, 'guest touch -> battle for both');
    await opened(gs);
    ok(encOf(A).kind === 'wild' && encOf(A).tier === 1 && !!encOf(A).k && encOf(B).kind === 'wild', 'the encounter describes a wild group of the tier');
    if (REAL_BATTLE) ok(A.run('B.coop.pl.length') === 2 && B.run('B.allies.length') === 6, "both players' teams are in the one battle");
    const ax = A.run('G.player.x'); A.press('d'); await frames(gs, 30); A.release('d');
    ok(Math.abs(A.run('G.player.x') - ax) < 2, 'the world is frozen during the battle');
    await fight(gs, true);
    await until(gs, () => gs.every(g => g.run('G.wild[0].beaten')), 600, 'group 0 beaten on both');
    ok(gs.every(g => g.run('MP.coop.state().won') === 1), 'battles won counted on both');
    ok(await clearFloor(gs, A), 'the exit opens for everyone once half the groups are beaten');
    // the door: A waits, the countdown shows, B arrives -> next floor at once
    toEntry(B); toExit(A); await frames(gs, 40);
    ok(fl(A) === 0 && B.run('MP.coop.state().cd') > 0 && A.run('MP.coop.state().cd') > 0, 'door countdown running on both');
    ok(/Waiting for the others at the door \(1\/2\)/.test(A.run(`(() => { let s = ''; const f = label; label = (t, ...a) => { s += t + '|'; return f(t, ...a); }; try { MP.coop.drawHUD(); } finally { label = f; } return s; })()`)), 'HUD shows "Waiting for the others at the door (1/2)"');
    toExit(B); await until(gs, () => gs.every(g => fl(g) === 1 && g.run('G.mode') === 'play'), 600, 'both at the door -> floor 2 at once');
    ok(gridSig(A) === gridSig(B), 'floor 2 identical');
    // floor 2: only A goes to the door; after 10 s the straggler is pulled along
    ok(await clearFloor(gs, B), 'floor 2 exit opens');
    A.run('for (const it of petSlots) if (it) RUN.petHp[it.pid] = 0.5'); toEntry(B); toExit(A);
    const t0 = FRAME; await until(gs, () => gs.every(g => fl(g) === 2 && g.run('G.mode') === 'play'), 900, 'countdown pulls the straggler to floor 3');
    ok(FRAME - t0 > 500, 'the countdown took about 10 s (' + ((FRAME - t0) / 60).toFixed(1) + ' s)');
    ok(Math.abs(A.run('RUN.petHp[petSlots[0].pid]') - 0.75) < 0.01, 'a new floor heals your team by 25%');
    ok(gridSig(A) === gridSig(B), 'floor 3 identical');
    ok(await clearFloor(gs, A), 'floor 3 exit opens');
    toExit(A); toExit(B); await until(gs, () => gs.every(g => fl(g) === 3 && g.run('G.mode') === 'play'), 600, 'boss floor reached');
    ok(gs.every(g => g.run('G.room.type') === 'boss' && g.run('G.room.boss') === 'shadow' && g.run('G.room.cols') === 64 && g.run('G.wild.length') === 1 && g.run('!!G.wild[0].boss')), 'floor 4 is the Shadow Wolf arena');
    await frames(gs, 80); onto(A, 0); await until(gs, () => gs.every(battling), 400, 'boss battle opens');
    await opened(gs);
    ok(encOf(B).kind === 'boss' && encOf(B).tier === 1, "enc.kind === 'boss'");
    await fight(gs, true);
    await until(gs, () => gs.every(g => phase(g) === 'done'), 600, 'completion panel for everyone');
    ok(gs.every(g => g.run('SAVE.rec.coopDungeons') === 1), 'SAVE.rec.coopDungeons += 1');
    await frames(gs, 60);   // (the panel is drawn; landscape)
    ok(gs.every(g => /Dungeon complete/.test(g.run('MP.coop.state().result.title'))), 'the completion panel is up');
    await backHome(gs);
    ok(gs.every(g => g.run('!MP.coop.active && !!G.hub && !G.coop')), 'back in the Sanctuary after the panel');
    ok(gs.every((g, k) => g.run('JSON.stringify([SAVE.rec.runs, SAVE.rec.bestFloor, SAVE.rec.deaths, SAVE.rec.wins, SAVE.rec.abandoned || 0])') === rec[k]), 'solo records untouched (runs, bestFloor, deaths, wins, abandoned)');
    ok(gs.every(g => g.run('MP.net.room({ id: "bps-party-T2A" }).state') === 'idle'), 'the session let go of its room');
  },

  async dungeon4() {
    const gs = games.slice(0, 4), [A, B, C, D] = gs;
    D.portrait = true;
    // C's own generation comes out different (as another browser's might): the full-floor fallback
    C.run('window.__bl = buildLevel; buildLevel = function (R) { __bl(R); if (R.grid) { for (let x = 30; x < 40; x++) setTile(R, x, 3, SOLID); } };');
    // the guests start BEFORE the leader: they only knock (claim: false), nobody but the leader ever holds the room
    const inf = info(gs, 'dungeon', 2, 'T4A', 777);
    MEM.lag = 1500;   /* (a released id stays taken for a while, like at the PeerJS broker) */
    startAll(gs, inf, [B, C, D]); await frames([B, C, D], 200);
    ok(!MEM.holders['bps-party-T4A'] && [B, C, D].every(g => g.run('MP.coop.state().room.state') === 'connecting' && !g.run('MP.coop.state().room.isHost')), 'no guest claims the party room before the leader arrives: they keep knocking');
    startAll(gs, inf, [A]);
    // ...and the leader's first answer to 'c.need' gets lost on the way: the guest asks again
    A.run("(() => { const r = MP.coop.state().room, s = r.send; window.__lostFull = 0; window.__pieces = 0; r.send = (m, to) => { if (m && m.t === 'c.full') window.__pieces = Math.max(window.__pieces, m.of); return m && m.t === 'c.full' && !window.__lostFull++ ? true : s(m, to); }; })()");
    const f0 = FRAME; await until(gs, () => gs.every(g => fl(g) === 0 && g.run('G.mode') === 'play'), 3000, 'everyone on floor 1');
    MEM.lag = 0; console.log('  (guests first, id lag 1.5 s: everyone on floor 1 ' + ((FRAME - f0) / 60).toFixed(1) + ' s after the leader started)');
    ok(host(gs) === A, 'the leader ends up hosting even when the guests started first');
    ok(gs.every(g => gridSig(g) === gridSig(A)), 'floor 1 identical on all four (one through the full-floor fallback)');
    ok(C.run('MP.coop.state().fulls') === 1 && B.run('MP.coop.state().fulls') === 0, 'only the client whose checksum differed fetched the full floor');
    ok(A.run('window.__lostFull') >= 2, 'a lost full-floor answer is asked for again');
    ok(A.run('window.__pieces') >= 2, 'the full floor travelled in ' + A.run('window.__pieces') + ' pieces');
    ok(C.run('G.wild.length') === A.run('G.wild.length') && C.run('G.wild.map(e => e.k + Math.round(e.homeX)).join()') === A.run('G.wild.map(e => e.k + Math.round(e.homeX)).join()'), 'the fetched floor has the same wild groups');
    ok(C.run('(G.room.plants || []).length') === A.run('G.room.plants.length') && C.run('(G.room.movers || []).length') === A.run('(G.room.movers || []).length') && C.run('G.room.vents.length') === A.run('G.room.vents.length'), 'and the same plants, platforms and vents');
    ok(A.run('MP.coop.ids().length') === 4, 'four players in the session');
    ok(A.run('G.room.act') === 2 && ['forge', 'hollow', 'sanctum'].includes(A.run('G.room.type')), 'tier 2 = the second act (' + A.run('G.room.type') + ')');
    await frames(gs, 30); for (const g of gs) g.step(1, true);
    // C walks around on the fetched floor (its nav and terrain work)
    C.press('d'); await frames(gs, 60); C.release('d');
    C.run('buildLevel = window.__bl');
    // a member leaves in the middle of the floor
    D.run("openPause(); pauseDo('leave')"); ok(D.run('G.confirm') === 'leave', 'leaving asks first'); D.step(1, true); D.run("pauseDo('leave')");
    await frames(gs, 20);
    ok(D.run('!MP.coop.active && !!G.hub'), 'D left the party: back in the Sanctuary');
    const rest = [A, B, C];
    ok(rest.every(g => g.run(`MP.coop.active && MP.coop.state().others.get(${JSON.stringify(D.uid)}).gone`)) && A.run('MP.coop.ids().length') === 3, "the others go on; D's hero is gone");
    // a member leaves in the middle of a battle
    toEntry(A); toEntry(B); onto(C, 0); await until(rest, () => rest.every(battling), 400, 'battle for the three');
    await opened(rest);
    B.run('MP.coop.end("test: B drops out")'); await frames(rest, 10);
    ok(REAL_BATTLE ? A.run(`B.coop.pl.find(o => o.id === ${JSON.stringify(B.uid)}).gone`) === true : A.battle.left.includes(B.uid), 'MP.battle.playerLeft(B) reached the battle on the host');
    ok(B.run('!MP.coop.active && !!G.hub && !B'), 'B is home, its battle closed');
    await fight([A, C], true);
    const two = [A, C];
    await until(two, () => two.every(g => g.run('G.wild[0].beaten') && !battling(g)), 600, 'the battle still ends for the two who stayed');
    // the two finish the floor; then C leaves too and the leader goes on alone (solo-in-party)
    ok(await clearFloor(two, C), 'exit opens for the two');
    toExit(A); toExit(C); await until(two, () => two.every(g => fl(g) === 1 && g.run('G.mode') === 'play'), 600, 'floor 2 for the two');
    C.run("openPause(); pauseDo('leave'); pauseDo('leave')"); await frames([A], 20);
    ok(A.run('MP.coop.active && MP.coop.ids().length') === 1, 'the last player may go on alone');
    ok(await clearFloor([A], A), 'alone: exit opens'); toExit(A);
    await until([A], () => fl(A) === 2 && A.run('G.mode') === 'play', 600, 'alone: next floor at once');
    A.run("openPause(); pauseDo('leave'); pauseDo('leave')"); await frames(gs, 20);
    ok(gs.every(g => g.run('!MP.coop.active && !!G.hub')), 'everyone is home');
    D.portrait = false;
  },

  // HOST MIGRATION inside a dungeon: the host vanishes mid-battle, at the door countdown and mid-floor, and the
  // others carry on under a new host until the dungeon is finished
  async leaderLeaves() {
    const gs = games.slice(0, 4), [A, B, C, D] = gs;
    const sOf = g => g.run('MP.coop.state()'), hostOf = g => g.run('MP.coop.state().room.hostId'), msgOf = g => g.run('G.msg');
    const seqOf = (g, of) => g.run(`MP.coop.state().room.members.get(${JSON.stringify(of.uid)}).seq`);
    // one room again: everyone open, the same host, and everybody sees everybody
    const settled = who => { const h = who.every(g => g.run('MP.coop.active && MP.coop.state().room.state === "open"')) && host(who); return !!h && who.every(g => hostOf(g) === h.uid && g.run('MP.coop.ids().length') === who.length); };
    // (no wild animal may walk into a hero while the test looks at something else: S.grace keeps touches off)
    const calm = (who, secs) => { for (const g of who) g.run('MP.coop.state().grace = ' + secs); };
    // ---- while gathering there is no migration: the leader says goodbye and everyone goes home ----
    startAll([A, B, C], info(gs, 'dungeon', 1, 'T3G', 5));   /* (the fourth never comes, so the leader waits) */
    await until([A, B, C], () => [B, C].every(g => g.run('MP.coop.state().room.state') === 'open'), 600, 'gathering');
    A.run("openPause(); pauseDo('leave'); pauseDo('leave')"); await frames([A, B, C], 40);
    ok([A, B, C].every(g => g.run('!MP.coop.active && !!G.hub && !G.coop')), 'the leader left while gathering: everyone is back home');
    ok(/before you set out/.test(msgOf(B)), 'with a friendly message: ' + msgOf(B));
    await frames(gs, 60);
    // ---- 1. mid-battle: the leader's connection dies ----
    C.portrait = true;
    const inf = info(gs, 'dungeon', 3, 'T3L', 4242), solo = gs.map(g => g.run('JSON.stringify([SAVE.rec.runs, SAVE.rec.deaths])'));
    await gather(gs, inf);
    ok(A.run('G.room.act') === 3 && host(gs) === A, 'tier 3 floor, the leader hosts');
    for (const g of gs) g.step(1, true);
    let rest = [B, C, D];
    const oldest = rest.slice().sort((x, y) => seqOf(A, x) - seqOf(A, y))[0];
    await frames(gs, 80); onto(C, 0); await until(gs, () => gs.every(battling), 400, 'a battle for the four'); await opened(gs);
    MEM.kill('bps-party-T3L');   /* the leader's connection dies without a goodbye */
    A.run('MP.coop.end("test: the dead leader")');
    await until(rest, () => settled(rest) && rest.every(g => !battling(g) && g.run('G.mode') === 'play' && !g.run('!!B')), 900, 'the three re-form under a new host, out of the battle');
    for (const g of rest) toEntry(g);   /* (off the group, or the touch would start the next battle at once) */
    calm(rest, 99);
    let H = host(rest);
    ok(H === oldest, 'the oldest guest is the new host (' + (H && H.name) + ')');
    ok(rest.every(g => /battle starts over/.test(msgOf(g))), 'everyone is told: ' + msgOf(C));
    ok(rest.every(g => phase(g) === 'play' && fl(g) === 0 && !g.run('G.wild[0].beaten') && !g.run('MP.coop.state().enc')), 'the session goes on, the group is unbeaten');
    ok(rest.every(g => !g.run('MP.coop.state().falls') && g.run('MP.coop.state().won') === 0), 'the called-off battle is no defeat (and no win)');
    ok(H.run('!!MP.coop.state().cur && MP.coop.state().cur.i === 0 && MP.coop.state().cur.full.length > 500'), 'the new host rebuilt the floor data for late joiners');
    // the wild animals roam again, simulated by the new host
    const G1 = rest.find(g => g !== H), wx = G1.run('G.wild.map(e => Math.round(e.x)).join()'); await frames(rest, 300);
    ok(G1.run('G.wild.map(e => Math.round(e.x)).join()') !== wx, 'the wild animals move again under the new host');
    ok(Math.max(...H.run('G.wild.map(e => e.x)').map((x, k) => Math.abs(x - G1.run(`G.wild[${k}].x`)))) < 40, "and a guest's follow the new host's");
    // a guest still cannot speak for the host
    G1.run("MP.coop.state().room.send({ t: 'c.over' }); MP.coop.state().room.send({ t: 'c.beat', i: 0, w: 0 })"); await frames(rest, 10);
    ok(rest.every(g => phase(g) === 'play') && !H.run('G.wild[0].beaten'), "a guest's forged host messages still change nothing");
    // the same group again, under the new host: won this time
    calm(rest, 0);
    ok(await winGroup(rest, G1, 0), 'the same group is fought again and beaten, under the new host');
    ok(rest.every(g => g.run('MP.coop.state().won') === 1), 'one battle won for everyone');
    // the old leader comes back (it was only offline): a late arrival, sent the floor by the CURRENT host
    startAll([A], inf);
    await until(gs, () => fl(A) === 0 && A.run('G.mode') === 'play' && hostOf(A) === H.uid && H.run('MP.coop.ids().length') === 4, 900, 'the old leader re-joins as a guest of the new host');
    ok(A.run('G.wild[0].beaten') && gridSig(A) === gridSig(H), 'on the same floor, with the beaten group beaten');
    A.run("openPause(); pauseDo('leave'); pauseDo('leave')"); await frames(gs, 30);
    ok(A.run('!MP.coop.active') && settled(rest) && host(rest) === H, 'a guest leaving (even the old leader) changes nothing for the others');
    // ---- 2. at the door countdown: the host leaves politely ----
    ok(await clearFloor(rest, G1), 'the exit opens under the new host');
    for (const g of rest) toEntry(g); calm(rest, 99); toExit(G1); await frames(rest, 90);
    ok(rest.every(g => sOf(g).cd > 0) && rest.every(g => fl(g) === 0), 'door countdown running (one of three at the door)');
    const f0 = FRAME; H.run("openPause(); pauseDo('leave'); pauseDo('leave')");
    const H1 = H; rest = rest.filter(g => g !== H1);
    await until(rest, () => settled(rest), 600, 'the two re-form under the next host');
    H = host(rest);
    ok(H1.run('!MP.coop.active && !!G.hub') && fl(H) === 0 && sOf(H).cd > 0, 'the countdown is still running on the new host');
    ok(rest.some(g => /leads? the party/.test(msgOf(g))), 'the party is told who leads now: ' + rest.map(msgOf).join(' / '));
    await until(rest, () => rest.every(g => fl(g) === 1 && g.run('G.mode') === 'play'), 900, 'the countdown runs out under the new host: floor 2 for both');
    ok(FRAME - f0 < 620, 'the countdown went on instead of starting over (' + ((FRAME - f0) / 60).toFixed(1) + ' s after the host left)');
    ok(gridSig(rest[0]) === gridSig(rest[1]), 'floor 2 identical');
    // ---- 3. mid-floor: the host's network dies silently and the broker keeps its id (a stuck id) ----
    calm(rest, 99); await frames(rest, 120);
    MEM.lag = 600000; MEM.kill('bps-party-T3L', true); MEM.lag = 0;
    const H2 = H, L = rest.find(g => g !== H2); rest = [L];   /* (H2 is dead from here on: not stepped any more, tidied up at the end) */
    await until(rest, () => settled(rest), 2400, 'the last player re-forms the room alone');
    ok(L.run('MP.coop.state().room.id') === 'bps-party-T3L-g1', 'on the successor id (the old one is stuck): ' + L.run('MP.coop.state().room.id'));
    ok(phase(L) === 'play' && fl(L) === 1 && /lead the party/.test(msgOf(L)), 'and the session goes on: ' + msgOf(L));
    // ...and the last one finishes the dungeon alone (13 battles in a row level its pets up: no evolution cutscenes in this test, the game waits under them)
    L.run('EVO_Q.length = 0; EVO_Q.push = () => 0');
    calm(rest, 0);
    ok(await clearFloor(rest, L), 'alone: floor 2 exit opens'); toExit(L);
    await until(rest, () => fl(L) === 2 && L.run('G.mode') === 'play', 600, 'alone: floor 3');
    ok(await clearFloor(rest, L), 'alone: floor 3 exit opens'); toExit(L);
    await until(rest, () => fl(L) === 3 && L.run('G.mode') === 'play', 600, 'alone: the boss floor');
    await frames(rest, 80); onto(L, 0); await until(rest, () => battling(L), 400, 'boss battle'); await fight(rest, true);
    await until(rest, () => phase(L) === 'done', 600, 'the dungeon is completed after three host changes');
    ok(/Dungeon complete/.test(L.run('(MP.coop.state().result || {}).title')), 'completion panel');
    await frames(rest, 60);
    await backHome(rest); L.run('delete EVO_Q.push');
    H2.run('MP.coop.end()'); await frames(gs, 20);
    ok(gs.every(g => g.run('!MP.coop.active && !!G.hub')), 'everyone is home: ' + gs.map(g => g.name + ' ' + g.run('MP.coop.active') + ' ' + g.run('!!G.hub') + ' ' + g.run('G.mode')).join(', '));
    ok(gs.every((g, k) => g.run('JSON.stringify([SAVE.rec.runs, SAVE.rec.deaths])') === solo[k]), 'solo records untouched');
    delete MEM.holders['bps-party-T3L'];
    C.portrait = false; await frames(gs, 30);
  },

  async raid() {
    const gs = games.slice(0, 3), [A, B, C] = gs; B.portrait = true;
    const before = gs.map(g => g.run('SAVE.rec.coopRaids || 0')), xp = A.run('petSlots[0].xp || 0') + '/' + A.run('petLvl(petSlots[0])');
    await gather(gs, info(gs, 'raid', 2, 'RAID1', 31337));
    ok(gs.every(g => g.run('G.room.type') === 'boss' && g.run('G.room.boss') === 'elder' && g.run('G.room.cols') === 64 && g.run('G.wild.length') === 1 && g.run('G.wild[0].boss') === 'elder'), 'the raid arena: 64 tiles, the Elder Dragon standing in it');
    ok(/Raid/.test(A.run('MP.coop.where()')), 'HUD says Raid: ' + A.run('MP.coop.where()'));
    for (const g of gs) g.step(1, true);
    await frames(gs, 90); onto(C, 0); await until(gs, () => gs.every(battling), 400, 'raid battle opens for all three');
    await opened(gs);
    ok(encOf(A).kind === 'raid' && encOf(A).tier === 2, "enc.kind === 'raid'");
    await fight(gs, true);
    await until(gs, () => gs.every(g => phase(g) === 'done'), 600, 'raid complete for everyone');
    ok(gs.every((g, k) => g.run('SAVE.rec.coopRaids') === before[k] + 1), 'SAVE.rec.coopRaids += 1');
    ok(A.run('petSlots[0].xp || 0') + '/' + A.run('petLvl(petSlots[0])') !== xp, 'the completion bonus gave pet XP');
    await frames(gs, 30); for (const g of gs) g.step(1, true);
    // the panel's button (a click) works too
    A.run('(() => { const b = MP.coop.state().result; b.t = 2; mouse.x = W / 2; mouse.y = H / 2 - 120 + 250 - 40; onMouseDown(0); })()');
    ok(A.run('!MP.coop.active && !!G.hub'), 'clicking "Back to the street" leaves');
    await backHome([B, C]);
    ok(gs.every(g => g.run('!MP.coop.active && !!G.hub')), 'everyone home after the raid');
    B.portrait = false;
  },

  async lost() {
    const gs = games.slice(0, 2), [A, B] = gs;
    const before = gs.map(g => g.run('JSON.stringify([SAVE.rec.runs, SAVE.rec.deaths, SAVE.rec.coopDungeons || 0])'));
    await gather(gs, info(gs, 'dungeon', 4, 'LOSE', 5));
    ok(A.run('G.room.act') === 4, 'tier 4 floor'); ok(gridSig(A) === gridSig(B), 'identical');
    // beaten back twice: the party gets up again at full health; the third defeat loses the dungeon
    for (let k = 0; k < 3; k++) {
      await frames(gs, k ? 330 : 80); onto(A, 1); await until(gs, () => gs.every(battling), 600, 'battle ' + (k + 1));
      await fight(gs, false);
      if (k < 2) { await until(gs, () => gs.every(g => !g.run('!!B')), 600, 'the lost battle closes'); await frames(gs, 10); ok(gs.every(g => phase(g) === 'play'), 'defeat ' + (k + 1) + ': the dungeon goes on'); ok(gs.every(g => g.run('petSlots.filter(Boolean).every(it => RUN.petHp[it.pid] === 1)')), 'the team is back at full health'); }
    }
    await until(gs, () => gs.every(g => phase(g) === 'over'), 600, 'the third lost battle fails the dungeon for everyone');
    await frames(gs, 40); for (const g of gs) g.step(1, true);
    ok(gs.every(g => /lost|failed/.test(g.run('MP.coop.state().result.title'))), 'the failure panel is up');
    await backHome(gs);
    ok(gs.every(g => g.run('!MP.coop.active && !!G.hub')), 'back home');
    ok(gs.every((g, k) => g.run('JSON.stringify([SAVE.rec.runs, SAVE.rec.deaths, SAVE.rec.coopDungeons || 0])') === before[k]), 'no death, no run, no completion recorded');
  },

  async nobody() {
    const [A, B] = games;
    A.win.__info = info([A, B], 'dungeon', 1, 'ALONE'); A.run('MP.coop.start(__info)');
    await frames([A], 600); ok(A.run('MP.coop.active') && phase(A) === 'gather', 'still gathering after 10 s'); A.step(1, true);
    await frames([A], 700);
    ok(A.run('!MP.coop.active && !!G.hub') && /Nobody else/.test(A.run('G.msg')), 'nobody came: back to the street after ~20 s: ' + A.run('G.msg'));
    // a guest whose leader never shows up
    B.win.__info = info([A, B], 'dungeon', 1, 'ALONE2'); B.run('MP.coop.start(__info)');
    await frames([B], 1300);
    ok(B.run('!MP.coop.active && !!G.hub'), 'a guest without a leader goes home too');
    // a party of one (the hub's debug switch) sets out at once
    A.win.__info = info([A], 'raid', 1, 'SOLO1'); A.run('MP.coop.start(__info)');
    await until([A], () => fl(A) === 0 && A.run('G.mode') === 'play', 400, 'a party of one starts'); A.run('MP.coop.end()'); await frames([A], 20);
    // rubbish from the hub is refused
    ok(A.run('MP.coop.start({ code: "x y", members: [] })') === false && A.run('MP.coop.start(null)') === false && !A.run('MP.coop.active'), 'a malformed info is refused');
  },

  async untrusted() {
    const gs = games.slice(0, 2), [A, B] = gs;
    await gather(gs, info(gs, 'dungeon', 1, 'EVIL', 8));
    const room = g => g.run('MP.coop.state().room');
    // a guest cannot speak for the host, and nonsense is ignored
    const junk = [{ t: 'c.floor', i: 2, seed: 1, sum: 1 }, { t: 'c.over' }, { t: 'c.done', s: 1, won: 99 }, { t: 'c.beat', i: 0, w: 0 }, { t: 'c.wild', i: 0, w: [0, 1e9, 'x', {}, null] }, { t: 'c.touch', i: 0, w: 999 }, { t: 'c.touch', i: 'a', w: -1 },
      { t: 'c.door', i: 0, on: 1 }, { t: 'c.full', i: 0, p: 0, of: 1, d: '{"c":1e9}' }, { t: 'c.need', i: 7 }, { t: 'c.cd', i: 0, s: 1e9 }, { t: 'c.enc', i: 0, w: 0, by: {} }, { t: 'c.zzz' }, { t: 'b.' }, { t: 5 }, null, 'hi', { t: 'c.wild', i: 0, w: 'no' }];
    for (const m of junk) { try { room(B).send(m); } catch (e) {} } await frames(gs, 10);
    ok(A.run('MP.coop.active') && phase(A) === 'play' && fl(A) === 0 && !A.run('G.wild[0].beaten') && !battling(A), "a guest's forged host messages change nothing on the host");
    for (const m of junk) { try { room(A).send(m); } catch (e) {} }
    // the HOST's wild message with wild numbers is clamped on the guest
    room(A).send({ t: 'c.wild', i: 0, w: [0, 1e12, -1e12, 7, 1e9] }); await frames(gs, 3);
    ok(B.run('G.wild[0].tx <= G.room.wpx + 60 && G.wild[0].ty >= -300 && Math.abs(G.wild[0].nvx) <= 400 && Math.abs(G.wild[0].face) === 1'), 'positions from the network are clamped');
    // a rubbish fast state does not break drawing
    room(B).setFast({ x: 'NaN', y: 1e99, vx: {}, vy: null, f: 'left', g: [], fl: 0 }); await frames([A], 3); A.step(1, true);
    ok(A.run(`(() => { const o = MP.coop.state().others.get(${JSON.stringify(B.uid)}); return Number.isFinite(o.tx) && Number.isFinite(o.ty) && o.ty <= G.room.hpx + 400; })()`), 'a rubbish fast state is cleaned');
    // unpackFloor refuses or cleans rubbish
    ok(A.run('MP.coop.unpackFloor({ c: 1e9, r: -4, g: "!!!" }, 0)') === null && A.run('MP.coop.unpackFloor(null, 0)') === null, 'a rubbish full floor is refused');
    ok(A.run('(() => { const s = MP.coop.state(), d = JSON.parse(s.cur.full); d.w.push({ k: "nosuch" }, { k: "dog", x: 1e9, y: "q", boss: "__proto__", coat: { col: [99, -4] } }); d.v = [[1e9, -5, "x"], "no"]; d.p = [[99, 99, 1e9, -1e9]]; const F = MP.coop.unpackFloor(d, 0); const e = F.wild[F.wild.length - 1]; return e.k === "dog" && !e.boss && e.x <= F.R.wpx && e.coat.col[0] === 9 && F.R.vents.length === 1 && F.R.vents[0].tx < F.R.cols && F.R.plants[0].x <= F.R.wpx; })()'), 'a full floor with bad entries is cleaned');
    // round trip: pack -> unpack gives the same checksum
    ok(A.run('(() => { const s = MP.coop.state(), F = MP.coop.unpackFloor(JSON.parse(s.cur.full), 0); return MP.coop.checksum(F) === s.cur.F.sum; })()'), 'pack -> unpack keeps the checksum');
    // the host leaves: the guest becomes the room's host, and now ITS word counts while a forged one from nobody does
    A.run("openPause(); pauseDo('leave'); pauseDo('leave')");
    await until([B], () => B.run('MP.coop.active && MP.coop.state().room.state === "open" && MP.coop.state().room.isHost'), 600, 'the guest hosts after the leader left');
    ok(A.run('!MP.coop.active && !!G.hub') && B.run('MP.coop.active') && B.run('MP.coop.ids().length') === 1, 'the leader is home, the guest keeps its session (alone)');
    B.run("openPause(); pauseDo('leave'); pauseDo('leave')"); await frames(gs, 30);
    ok(gs.every(g => g.run('!MP.coop.active && !!G.hub')), 'home');
  },

  // every tier, several seeds: generation is the same on two clients, repeatable, and survives pack -> unpack
  async floors() {
    const [A, B] = games; let n = 0, bad = 0, sizes = [];
    for (let tier = 1; tier <= 4; tier++) for (const seed of [1, 77, 4096, 123456789]) {
      for (const g of [A, B]) { g.win.__info = info([g], 'dungeon', tier, 'GEN' + tier, seed); g.run('MP.coop.start(__info)'); }
      const code = `JSON.stringify([0, 1, 2, 3].map(i => { const s = MP.coop.state(), sd = (${seed} * 31 + i * 7919) >>> 0, F = MP.coop.genFloor(i, sd), F2 = MP.coop.genFloor(i, sd), full = JSON.stringify(MP.coop.packFloor(F)), U = MP.coop.unpackFloor(JSON.parse(full), i);
        return [F.sum, F2.sum === F.sum, MP.coop.checksum(U) === F.sum, full.length, F.R.type, F.R.n, F.wild.length, F.R.chests.length, U.wild.length === F.wild.length && U.R.plants.length === F.R.plants.length && (U.R.movers || []).length === (F.R.movers || []).length]; }))`;
      const a = JSON.parse(A.run(code)), b = JSON.parse(B.run(code));
      for (let i = 0; i < 4; i++) { n++; sizes.push(a[i][3]); if (a[i][0] !== b[i][0] || !a[i][1] || !a[i][2] || a[i][7] !== 0 || !a[i][8] || !(a[i][6] >= 1) || (i === 3) !== (a[i][4] === 'boss') || Math.ceil(a[i][5] / 10) !== tier) { bad++; console.log('  bad floor: tier ' + tier + ' seed ' + seed + ' i ' + i + ' ' + JSON.stringify(a[i]) + ' / ' + JSON.stringify(b[i])); } }
      const order = A.run('MP.coop.state().order.join()'); ok(order === B.run('MP.coop.state().order.join()') && new Set(order.split(',')).size === 3, 'tier ' + tier + ' seed ' + seed + ': the same order of the three areas on both (' + order + ')');
      for (const g of [A, B]) g.run('MP.coop.end()');
      await frames([A, B], 5);
    }
    ok(bad === 0, n + ' floors: identical on two clients, repeatable, no chests, pack -> unpack keeps the checksum');
    ok(Math.max(...sizes) < 60000, 'a packed floor is ' + Math.min(...sizes) + ' to ' + Math.max(...sizes) + ' characters (sent in pieces of 6000)');
    console.log('  (packed floors: ' + Math.min(...sizes) + ' to ' + Math.max(...sizes) + ' characters)');
  },

  // the host's tab is hidden: no animation frames. index.html's bgTick() keeps update() going (here through its
  // setInterval fallback: the harness has no Worker), so the wild animals and a battle go on for the others
  async hiddenHost() {
    const gs = games.slice(0, 2), [A, B] = gs;
    ok(A.run('typeof bgTick') === 'function' && A.run('bgTick(performance.now() + 5000)') === 0 && A.run('bgSrc') === null, 'visible, no session: bgTick does nothing and no source runs');
    A.win.document.hidden = true; await frames([B], 90, () => { A.win.__now += 1000 / 60; });
    ok(A.run('bgTick(performance.now() + 5000)') === 0 && A.run('bgSrc') === null, 'hidden but no multiplayer session: still nothing');
    A.win.document.hidden = false;
    await gather(gs, info(gs, 'dungeon', 1, 'HID', 606));
    ok(host(gs) === A, 'the leader hosts'); await frames(gs, 60); for (const g of gs) g.run('MP.coop.state().grace = 99');
    // from here on the host gets NO frames: only its clock moves (and its timers, like in a hidden tab)
    A.run('window.__draws = 0; window.__ups = 0; window.__maxDt = 0; window.__d0 = draw; window.__u0 = update; draw = function () { __draws++; return __d0(); }; update = function (dt) { __ups++; __maxDt = Math.max(__maxDt, dt); return __u0(dt); };');
    const hidden = (n, cond) => (async () => { for (let i = 0; i < n; i++) { if (cond && cond()) return true; await frames([B], 1, () => { A.win.__now += 1000 / 60; }); } return !cond; })();
    A.win.document.hidden = true;
    const t0 = A.run('TIME'), wx = B.run('G.wild.map(e => Math.round(e.x)).join()');
    await hidden(360);
    const dT = A.run('TIME') - t0;
    ok(A.run('typeof bgSrc') === 'function', 'a background source is running on the hidden host');
    ok(dT > 4.2 && dT < 6.1, "the hidden host's game went on in real time: " + dT.toFixed(2) + ' s of game time in 6 s (it takes up to a second to notice)');
    ok(A.run('__draws') === 0 && A.run('__ups') > 100, 'by update() alone, never draw() (' + A.run('__ups') + ' updates, ' + A.run('__draws') + ' draws)');
    ok(A.run('__maxDt') <= 1 / 30 + 1e-9, 'in small steps (largest ' + A.run('__maxDt').toFixed(4) + ' s)');
    ok(B.run('G.wild.map(e => Math.round(e.x)).join()') !== wx, "the wild animals keep roaming on the guest's screen");
    ok(Math.max(...A.run('G.wild.map(e => e.x)').map((x, k) => Math.abs(x - B.run(`G.wild[${k}].x`)))) < 40, 'and follow the hidden host');
    // a long stall (the device slept): the catch-up is capped, never one giant step
    const u0 = A.run('__ups'); A.win.__now += 60000; await hidden(2);
    ok(A.run('__ups') - u0 <= 3 * 8 && A.run('__maxDt') <= 1 / 30 + 1e-9, 'a minute of sleep is not replayed: ' + (A.run('__ups') - u0) + ' updates in the next ticks');
    // a battle starts and runs while the host stays hidden
    for (const g of gs) g.run('MP.coop.state().grace = 0');
    onto(B, 0);
    ok(await hidden(900, () => battling(A) && battling(B) && B.run('!!(B && B.coop) && G.mode === "battle"') && A.run('!!(B && B.coop) && G.mode === "battle"')), 'the guest touches a group: the battle opens on both, the hidden host running it');
    A.run('if (B && B.coop) { B.coop.auto = true; B.coop.fast = true; for (const f of B.foes) { f.hp = Math.min(f.hp, 1); f.shield = 0; f.atk = 0; } }');
    ok(await hidden(3000, () => { A.run('if (B && B.coop) for (const f of B.foes) { f.hp = Math.min(f.hp, 1); f.shield = 0; f.atk = 0; }'); return gs.every(g => g.run('!B || !B.coop || B.phase === "won"')); }), 'and is fought to the end with the host hidden');
    ok(A.run('__draws') === 0, 'still without a single draw on the host');
    // visible again: the background source stops, the normal loop takes over (and bgTick refuses to run)
    A.win.document.hidden = false; A.run('update = __u0; draw = __d0;');
    await frames(gs, 70);
    ok(A.run('bgSrc') === null && A.run('bgTick(performance.now() + 5000)') === 0, 'visible again: the source is stopped and bgTick does nothing');
    for (let k = 0; k < 60 && gs.some(g => g.run('!!(B && B.coop)')); k++) { const still = gs.filter(g => g.run('!!(B && B.coop)')); for (const g of still) g.press('Enter'); await frames(gs, 2); for (const g of still) g.release('Enter'); await frames(gs, 20); }
    await until(gs, () => gs.every(g => g.run('G.wild[0].beaten') && !battling(g)), 600, 'the group is beaten for both');
    A.run('MP.coop.end()'); B.run('MP.coop.end()'); await frames(gs, 20);
  },

  async soloAfter() {
    const A = games[0], runs = A.run('SAVE.rec.runs');
    A.run('G.panel = null; newGame(selClass)'); A.step(30);
    ok(A.run('!G.coop && !G.hub && G.roomNum') === 1 && A.run('SAVE.rec.runs') === runs + 1, 'a solo run starts normally after co-op sessions');
    ok(A.run('G.room.chests.length + (G.room.chestSpots || []).length') > 0 || A.run('G.wild.length') > 0, 'the solo floor has its chests and animals');
    const x = A.run('G.player.x'); A.press('d'); A.step(60); A.release('d');
    ok(A.run('G.player.x') > x + 30, 'the solo hero walks');
    ok(A.run('JSON.stringify(pauseItems().map(i => i[0]))') === '["resume","animals","restart","hub","title"]', 'the solo pause menu is the old one');
    A.run('tryOpenPack()'); ok(A.run('G.mode') === 'pack', 'the backpack opens in solo'); A.run('closePack()');
    onto(A, 0); A.step(3); ok(A.run('G.mode') === 'encounter', 'touching a wild group starts a solo encounter');
    A.step(60); ok(A.run('G.mode') === 'battle' && A.run('!!B && !B.coop'), 'and a solo battle');
    A.run('B = null; G.mode = "play"; for (const w of G.wild) w.beaten = true; G.graceT = 0');
    toExit(A); A.step(90);
    ok(A.run('G.roomNum') === 2 && A.run('SAVE.rec.bestFloor') >= 2, 'the solo exit leads to floor 2 (and counts as best floor)');
    A.run('enterHub()'); A.step(10);
  },
};

(async () => {
  const t0 = Date.now();
  player('Ann', ['dog', 'fox', 'owl']); player('Bob', ['boar', 'toad', 'ferret']); player('Cat', ['catgray', 'owl', 'dog']); player('Dan', ['fox', 'dog', 'toad']);
  console.log(`booted 4 games in ${Date.now() - t0} ms · net: mp/net.js (mem, ${games[0].run('MP.net.backend')}) · battle: ${REAL_BATTLE ? 'mp/battle.js' : 'stand-in'}`);
  for (const [name, fn] of Object.entries(TESTS)) {
    if (ONLY && name !== ONLY) continue;
    const f0 = fails, t = Date.now();
    try { await fn(); } catch (e) { fails++; console.log('  THREW in ' + name + ': ' + (e && e.stack || e)); }
    for (const g of games) { try { if (g.run('MP.coop.active')) g.run('MP.coop.end("test cleanup")'); } catch (e) {} g.portrait = false; }
    await frames(games, 40);
    console.log(`${fails === f0 ? 'PASS' : 'FAIL'}  ${name}  (${Date.now() - t} ms)`);
  }
  console.log(`${checks} checks, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})();
