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

// WORLD: errors that the game catches and logs (MP.ticks / MP.worldDraw / MP.hudDraw run inside try / catch) are counted
const ERRS = { n: 0 }, logErr = console.error;
console.error = (...a) => { ERRS.n++; logErr(...a); };

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
    // the guests start BEFORE the leader (so one of them claims the room first and must let go)
    const inf = info(gs, 'dungeon', 2, 'T4A', 777);
    MEM.lag = 1500;   /* (a released id stays taken for a while, like at the PeerJS broker) */
    startAll(gs, inf, [B, C, D]); await frames([B, C, D], 200);
    ok([B, C, D].some(g => g.run('!!MP.coop.state().room && MP.coop.state().room.isHost')) || [B, C, D].some(g => g.run('MP.coop.state().retryT > 0')), 'a guest claimed the party room before the leader arrived');
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

  async leaderLeaves() {
    const gs = games.slice(0, 3), [A, B, C] = gs;
    C.portrait = true;
    await gather(gs, info(gs, 'dungeon', 3, 'T3L', 4242));
    ok(A.run('G.room.act') === 3, 'tier 3 floor');
    for (const g of gs) g.step(1, true);
    A.run("openPause(); pauseDo('leave'); pauseDo('leave')");
    await frames(gs, 40);
    ok(gs.every(g => g.run('!MP.coop.active && !!G.hub && !G.coop')), 'the leader left: the session ends cleanly for everyone');
    ok(/leader left/.test(B.run('G.msg')) && /leader left/.test(C.run('G.msg')), 'with a friendly message: ' + B.run('G.msg'));
    // the leader's connection drops in the middle of a battle
    await frames(gs, 60);
    await gather(gs, info(gs, 'raid', 1, 'T3M', 99));
    await frames(gs, 80); onto(B, 0); await until(gs, () => gs.every(battling), 400, 'raid battle');
    MEM.kill('bps-party-T3M');   /* the leader's connection dies without a goodbye */
    await frames(gs, 60);
    ok([B, C].every(g => g.run('!MP.coop.active && !!G.hub')), 'the leader dropped mid-battle: the others are back home');
    console.log('  (the killed leader itself: ' + (A.run('MP.coop.active') ? 'still in its session with ' + A.run('MP.coop.ids().length') + ' player(s), room ' + A.run('MP.coop.state().room.state') : 'home') + ')');
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
    A.run("openPause(); pauseDo('leave'); pauseDo('leave')"); await frames(gs, 30);
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

  // WORLD: seeded floors do not depend on the browser's sort algorithm. Bob's copy of the game gets another (correct,
  // but NOT stable) Array.prototype.sort: a selection sort, which asks the comparator in a different order than V8's
  // TimSort. A `sort(() => Math.random() - 0.5)` anywhere on the generation path gives another floor under it.
  async engines() {
    const [A, B] = games; let n = 0, bad = 0, calls = 0;
    B.run(`(() => { const AP = [].constructor.prototype; window.__sort = AP.sort; window.__sorts = 0;
      AP.sort = function (cmp) { window.__sorts++; const c = cmp || ((x, y) => (String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0)), a = this, n = a.length;
        for (let i = 0; i < n - 1; i++) { let m = i; for (let j = n - 1; j > i; j--) if (c(a[j], a[m]) < 0) m = j; if (m !== i) { const t = a[i]; a[i] = a[m]; a[m] = t; } }
        return a; }; })()`);
    ok(B.run('[5, 3, 9, 1, 4].sort((a, b) => a - b).join()') === '1,3,4,5,9' && B.run('window.__sorts') > 0, "Bob's game sorts with another algorithm (a selection sort)");
    try {
      for (let tier = 1; tier <= 4; tier++) for (const seed of [3, 501, 90210, 20261115, 4000000001, 8675309]) {
        for (const g of [A, B]) { g.win.__info = info([g], 'dungeon', tier, 'ENG' + tier, seed); g.run('MP.coop.start(__info)'); }
        const code = `JSON.stringify([0, 1, 2, 3].map(i => { const F = MP.coop.genFloor(i, (${seed} * 131 + i * 7919) >>> 0); return [F.sum, F.R.plan ? F.R.plan.join(' ') : '', F.wild.length, F.R.plants.length, F.R.decor.length + F.R.baked.length]; }))`;
        const a = JSON.parse(A.run(code)), b = JSON.parse(B.run(code));
        for (let i = 0; i < 4; i++) { n++; if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) { bad++; if (bad <= 4) console.log('  differs: tier ' + tier + ' seed ' + seed + ' floor ' + i + (a[i][1] !== b[i][1] ? ' (another plan of sections)' : a[i][0] !== b[i][0] ? ' (same sections, other contents)' : '')); } }
        for (const g of [A, B]) g.run('MP.coop.end()');
        await frames([A, B], 3);
      }
      calls = B.run('window.__sorts');
    } finally { B.run('[].constructor.prototype.sort = window.__sort'); }
    ok(bad === 0, n + ' seeded floors (4 tiers) are identical under two different sort algorithms' + (bad ? ': ' + bad + ' differ' : ''));
    console.log('  (' + n + ' floors compared; the other sort ran ' + calls + ' times)');
  },

  // WORLD: smash walls and crumbling blocks are the same for the whole party (host -> guests, guest -> host -> guests),
  // a late arrival through the full-floor fetch gets what changed, and moving platforms follow the leader's clock
  async tiles() {
    const all = games.slice(0, 4), [A, B, C, D] = all, gs = [A, B, D], e0 = ERRS.n;
    const grid = g => g.run('(() => { let h = 0; for (const t of G.room.grid) h = (h * 31 + t) >>> 0; return h; })()');
    const count = (g, t) => g.run(`(() => { const r = MP.coop.state().room, s = r.send; window.__sent = 0; r.send = (m, to) => { if (m && m.t === ${JSON.stringify(t)}) window.__sent++; return s(m, to); }; })()`);
    const thuds = g => g.run("(() => { window.__thud = 0; if (!window.__play) { window.__play = SFX.play; SFX.play = function (n, ...a) { if (n === 'thud' || n === 'flame') window.__thud++; return window.__play.call(this, n, ...a); }; } })()");
    C.run('window.__bl = buildLevel; buildLevel = function (R) { __bl(R); if (R.grid) { for (let x = 30; x < 40; x++) setTile(R, x, 3, SOLID); } };');
    const inf = info(all, 'dungeon', 4, 'TILE', 4);   /* (tier 4, seed 4: a first floor with crumbling blocks, smash walls and moving platforms) */
    startAll(gs, inf);
    if (!await until(gs, () => gs.every(g => fl(g) === 0 && g.run('G.mode') === 'play'), 3000, 'three of the four on floor 1 (the fourth comes late)')) return;
    for (const g of gs) g.run('for (const e of G.wild) e.beaten = true');   /* (no battles in this test) */
    ok(new Set(gs.map(grid)).size === 1, 'the floor starts identical on the three');
    // ---- smash walls ----
    const walls = JSON.parse(A.run('JSON.stringify(G.room.dashSpots.map((d, n) => [n, d.kind, d.x0, d.y1 === G.room.floorTop - 1 && [1, 2, 3].every(k => isSolidT(tileAt(d.x0 - k, G.room.floorTop)) && tileAt(d.x0 - k, G.room.floorTop - 1) === EMPTY)]).filter(d => d[1] === "barrier" && d[3]))'));
    const blocks = JSON.parse(A.run('JSON.stringify(G.room.crumbleTiles)'));
    ok(walls.length >= 2 && blocks.length >= 3 && A.run('G.room.movers.length') > 0, 'the test floor has ' + walls.length + ' smash walls on the ground, ' + blocks.length + ' crumbling blocks and ' + A.run('G.room.movers.length') + ' moving platforms');
    if (walls.length < 2 || blocks.length < 3) return;
    const beside = (g, w, dx) => g.run(`(() => { const R = G.room, P = G.player; P.x = ${w[2]} * TILE + ${dx}; P.y = R.floorTop * TILE - P.h; P.vx = P.vy = 0; P.face = 1; P.dashCd = 0; P.dashT = 0; P.onGround = true; })()`);
    const dash = async (g, w) => { beside(g, w, -50); await frames(gs, 4); g.press('d'); g.press('Shift'); await frames(gs, 1); g.release('Shift'); await frames(gs, 25); g.release('d'); };
    const broken = (g, w) => g.run(`G.room.dashSpots[${w[0]}].broken === true && tileAt(${w[2]}, G.room.floorTop - 1) === EMPTY`);
    const far = walls[walls.length - 1], near = walls[0];
    ok(far[2] * 30 > 1500, 'the far wall is far from the entrance (' + far[2] * 30 + ' px)');
    toEntry(B); beside(D, far, -110); await frames(gs, 30); thuds(B); thuds(D);
    await dash(A, far);
    ok(broken(A, far), 'the host dashes through a smash wall: broken on its own screen');
    await until(gs, () => broken(B, far) && broken(D, far), 60, "the host's wall is broken for both guests");
    ok(D.run('window.__thud') >= 1 && B.run('window.__thud') === 0, 'with the crash where it is on screen (' + D.run('window.__thud') + '), quietly far away (' + B.run('window.__thud') + ')');
    count(A, 'c.tile'); count(D, 'c.tile');
    toEntry(A); toEntry(D); await frames(gs, 10);
    await dash(B, near);
    ok(broken(B, near), 'a guest dashes through another wall');
    await until(gs, () => broken(A, near) && broken(D, near), 60, "the guest's wall is broken for the host and for the other guest");
    ok(new Set(gs.map(grid)).size === 1, 'the grids are identical again');
    // ---- crumbling blocks ----
    const [tx, ty] = blocks[0], key = `(${ty} * G.room.cols + ${tx})`, tileIs = (g, x, y) => g.run(`tileAt(${x}, ${y})`), CR = A.run('CRUMBLE');
    const stand = (g, x, y) => g.run(`(() => { const P = G.player; P.x = ${x} * TILE + 3; P.y = ${y} * TILE - P.h; P.vx = P.vy = 0; P.dashT = 0; })()`);
    stand(B, tx, ty); await until(gs, () => B.run(`G.room.crumbles.has(${key})`), 20, "a block starts to crumble under the guest's hero");
    toEntry(B);
    await until(gs, () => gs.every(g => g.run(`G.room.crumbles.has(${key})`)), 30, 'the same block is crumbling on every screen');
    const when = async (want, max, what) => { const at = gs.map(() => -1), f0 = FRAME; await until(gs, () => { gs.forEach((g, k) => { if (at[k] < 0 && (tileIs(g, tx, ty) === CR) === want) at[k] = FRAME - f0; }); return at.every(v => v >= 0); }, max, what); return at; };
    const fell = await when(false, 90, 'the block falls for everyone'), fellAt = FRAME;
    ok(Math.max(...fell) - Math.min(...fell) <= 12, 'it falls at about the same moment for all (frames ' + fell.join(', ') + ')');
    ok(new Set(gs.map(grid)).size === 1, 'identical grids with the block gone');
    const back = await when(true, 400, 'the block grows back for everyone');
    ok(Math.max(...back) - Math.min(...back) <= 12 && Math.abs((FRAME - fellAt) / 60 - 4) < 0.6, 'it grows back about 4 s later, at about the same moment for all (frames ' + back.join(', ') + ')');
    ok(A.run('window.__sent') === 0 && D.run('window.__sent') === 0, 'nobody echoes a tile it was told about');
    ok(gs.every(g => g.run('G.room.crumbles.size') === 0) && new Set(gs.map(grid)).size === 1, 'and the floor is whole and identical again');
    // ---- rubbish and floods ----
    const g0 = grid(A), send = (g, m) => { g.win.__m = clone(m); try { g.run('MP.coop.state().room.send(__m)'); } catch (e) {} };
    const chasm = A.run('G.room.dashSpots.findIndex(d => d.kind === "chasm")');
    for (const m of [{ t: 'c.tile', i: 0, e: [[0, 1e9, 2], [0, 'x', 1], [0, 2, 2, 0], [0, -1, -1], [0, 1.5, 2], [1, 99, 1, 0], [1, chasm, 1, 0], [1, 'a'], [7, 1, 1], 'no', null, {}] }, { t: 'c.tile', i: 0, e: 'zz' }, { t: 'c.tile', i: 3, e: [[0, tx, ty, 0]] }, { t: 'c.tile' },
      { t: 'c.tiles', i: 0, tl: { w: [0, 1, 2, 3, 4, 5], c: blocks.map(b => [b[0], b[1], 1, 40]) } }, { t: 'c.tiles', i: 0, tl: 'x' }]) send(B, m);
    await frames(gs, 12);
    ok(grid(A) === g0 && grid(D) === g0 && A.run('G.room.crumbles.size') === 0, "a guest's rubbish tile messages (outside the grid, not a block, no such wall, a forged snapshot) change nothing");
    for (let k = 0; k < 4; k++) send(B, { t: 'c.tile', i: 0, e: new Array(24).fill([0, 1, 1, 0]) });
    send(B, { t: 'c.tile', i: 0, e: [[0, blocks[1][0], blocks[1][1], 0]] });
    await frames(gs, 12);
    ok(A.run('G.room.crumbles.size') === 0, 'a flood of tile events is cut off (the one real event after 96 others is dropped)');
    await frames(gs, 240);
    send(B, { t: 'c.tile', i: 0, e: [[0, blocks[1][0], blocks[1][1], 0]] });
    await until(gs, () => A.run('G.room.crumbles.size') === 1 && D.run('G.room.crumbles.size') === 1, 30, 'a few seconds later that player is heard again');
    await until(gs, () => gs.every(g => g.run('G.room.crumbles.size') === 0 || g === B), 400, 'that block is back');
    B.run('G.room.crumbles.clear()'); B.run(`setTile(G.room, ${blocks[1][0]}, ${blocks[1][1]}, CRUMBLE)`);
    // ---- moving platforms: a guest's clock follows the leader's ----
    const clk = g => g.run('G.room.movers[0].t');
    await frames(gs, 60); const d0 = Math.abs(clk(B) - clk(A));
    B.run('for (const m of G.room.movers) m.t += 1.2'); await frames(gs, 300);
    ok(d0 < 0.3 && Math.abs(clk(B) - clk(A)) < 0.3, "a guest's platforms run with the leader's (" + d0.toFixed(2) + ' s apart; 1.2 s off is eased back to ' + Math.abs(clk(B) - clk(A)).toFixed(2) + ' s)');
    B.run('for (const m of G.room.movers) m.t -= 40'); await frames(gs, 40);
    ok(Math.abs(clk(B) - clk(A)) < 0.3, 'far off, they jump into step');
    A.run('openPause()'); const c0 = clk(A); await frames(gs, 120);
    ok(clk(A) - c0 > 1.8, "the leader's pause menu does not stop the platforms"); A.run('closePause()');
    // ---- the late arrival, through the full-floor fetch ----
    count(A, 'c.tiles');
    startAll([C], inf);
    await until(all, () => C.run('!!(MP.coop.state() && MP.coop.state().pend)'), 1200, 'the late player hears about the floor');
    stand(B, blocks[2][0], blocks[2][1]); await frames(all, 3); toEntry(B);   /* (a block goes while the late player's floor is still on its way) */
    await until(all, () => fl(C) === 0 && C.run('G.mode') === 'play', 1200, 'the late player is on the floor');
    ok(C.run('MP.coop.state().fulls') === 1 && A.run('window.__sent') >= 1, 'it came through the full-floor fetch, followed by the changed tiles');
    ok(broken(C, far) && broken(C, near), 'both smashed walls are open for the late player');
    const k2 = `(${blocks[2][1]} * G.room.cols + ${blocks[2][0]})`;
    ok(C.run(`G.room.crumbles.has(${k2})`) === A.run(`G.room.crumbles.has(${k2})`) && tileIs(C, blocks[2][0], blocks[2][1]) === tileIs(A, blocks[2][0], blocks[2][1]), 'and the block that crumbled meanwhile is in the same state as on the host');
    ok(grid(C) === grid(A) && grid(B) === grid(A) && grid(D) === grid(A), 'all four grids are identical');
    await frames(all, 330);
    ok(all.every(g => g.run('G.room.crumbles.size') === 0) && new Set(all.map(grid)).size === 1, 'five seconds later every block is back, for all four');
    C.portrait = true; await frames(all, 12); C.portrait = false;
    for (const g of [B, D]) g.run('if (window.__play) { SFX.play = window.__play; window.__play = null; }');
    C.run('buildLevel = window.__bl');
    ok(ERRS.n === e0, 'no error was logged on the way (' + (ERRS.n - e0) + ')');
  },

  // WORLD: the other players' pets follow their heroes on every screen, from the team in their presence alone
  async pets() {
    const [A, B] = games, gs = [A, B], e0 = ERRS.n;
    await gather(gs, info(gs, 'dungeon', 1, 'PETS', 21));
    for (const g of gs) g.run('for (const e of G.wild) e.beaten = true');
    await frames(gs, 30);
    const of = (g, o) => `MP.coop.state().others.get(${JSON.stringify(o.uid)})`;
    const pets = (g, o) => JSON.parse(g.run(`JSON.stringify((${of(g, o)}.pets || []).map(p => ({ k: p.k, x: p.x, y: p.y, lvl: p.it.plvl, col: p.it.g.col, shiny: p.it.g.shiny, face: p.face, g: p.g })))`));
    ok(pets(B, A).map(p => p.k).join() === 'dog,fox,owl' && pets(A, B).map(p => p.k).join() === 'boar,toad,ferret', "each player sees the other's team as followers (" + pets(B, A).map(p => p.k).join() + ' / ' + pets(A, B).map(p => p.k).join() + ')');
    ok(pets(B, A).map(p => p.lvl).join() === A.run('petSlots.filter(Boolean).map(petLvl).join()') && pets(B, A).every(p => Number.isFinite(p.x) && Number.isFinite(p.y)), 'with their level (baby or adult art) and a place in the world');
    ok(A.run(`Object.keys(MP.coop.state().room.members.get(MP.net.uid).f).join()`) === 'x,y,vx,vy,f,g,fl,h', 'the 10x/s hero state carries no pets (' + A.run(`Object.keys(MP.coop.state().room.members.get(MP.net.uid).f).join()`) + ')');
    // they follow: A walks right for two seconds
    const x0 = pets(B, A).map(p => p.x), hx0 = A.run('G.player.x');
    A.press('d'); await frames(gs, 120); A.release('d'); await frames(gs, 40);
    const moved = A.run('G.player.x') - hx0, p1 = pets(B, A), hero = B.run(`${of(B, A)}.P.x + 12`), feet = B.run(`${of(B, A)}.P.y + 46`);
    ok(moved > 150 && p1.every((p, k) => p.x > x0[k] + moved * 0.4), 'the hero walks ' + Math.round(moved) + ' px: every follower came along');
    ok(p1[0].x < hero - 15 && p1[1].x < p1[0].x - 10 && p1.every(p => hero - p.x < 140), 'the walkers trail behind it in a line (' + p1.map(p => Math.round(hero - p.x)).join(', ') + ' px behind)');
    ok(Math.abs(p1[0].y - feet) < 6 && p1[2].y < feet - 30, 'walkers on the ground at its feet, the owl in the air (' + Math.round(feet - p1[2].y) + ' px up)');
    // they hop where the hero hopped
    let top = 1e9; A.press('d'); A.press('w');
    await frames(gs, 70, () => { top = Math.min(top, pets(B, A)[0].y); }); A.release('d'); A.release('w'); await frames(gs, 60);
    ok(top < feet - 20, 'a walker hops where the hero hopped (' + Math.round(feet - top) + ' px up)');
    // drawn with the game's sprites, dimmer; nothing drawn when they are off screen
    const seen = () => B.run(`(() => { const f = drawAnim; let n = 0; drawAnim = (nm, an, i, x, y, fc, o) => { if (o && o.alpha === 0.82) n++; return f(nm, an, i, x, y, fc, o); }; try { draw(); } finally { drawAnim = f; } return n; })()`);
    ok(seen() >= 3, 'the three followers are drawn (dimmer than my own) while they are on screen');
    A.run('G.player.x = G.room.wpx - 300'); await frames(gs, 60);
    ok(seen() === 0 && pets(B, A).every(p => Math.abs(p.x - A.run('G.player.x')) < 200), 'far away they are with their hero, and not drawn here');
    toEntry(A); await frames(gs, 60);
    // the team changes: the presence follows
    A.run('petSlots[2] = null; syncPets()'); await until(gs, () => pets(B, A).length === 2, 120, "a changed team reaches the others' screens");
    // team health in the party list
    A.run('for (const it of petSlots) if (it) RUN.petHp[it.pid] = 0.4'); await frames(gs, 30);
    ok(Math.abs(B.run(`${of(B, A)}.hp`) - 0.4) < 0.02, "the party list knows the other player's team health (" + B.run(`${of(B, A)}.hp`) + ')');
    // rubbish in a presence is cleaned
    B.run(`MP.coop.state().room.setPresence({ tm: [['nosuch', 3], ['dog', 1e9, 'yes', 99, -5, 1], ['__proto__', 1], ['fox', 2], 'x'] })`); await frames(gs, 30);
    const junk = pets(A, B);
    ok(junk.length === 1 && junk[0].k === 'dog' && junk[0].lvl === A.run('PET_MAX_LVL') && junk[0].col.join() === A.run('COAT_MELAN') + ',0', 'a rubbish team in a presence is cleaned (' + JSON.stringify(junk.map(p => [p.k, p.lvl, p.col])) + ')');
    ok(JSON.stringify(A.run('MP.coop.cleanTeam("no")')) === '[]' && A.run('MP.coop.cleanTeam([[1], [null], {}]).length') === 0, 'and nonsense gives no followers at all');
    for (const g of gs) { g.portrait = true; } await frames(gs, 12); for (const g of gs) g.step(1, true);
    for (const g of gs) { g.portrait = false; } await frames(gs, 12); for (const g of gs) g.step(1, true);
    ok(ERRS.n === e0, 'draw() logged no error, in landscape and in portrait (' + (ERRS.n - e0) + ')');
  },

  // WORLD: the door countdown and "waiting at the door" are shown over the world, in landscape and in portrait
  async door() {
    const [A, B] = games, gs = [A, B], e0 = ERRS.n;
    await gather(gs, info(gs, 'dungeon', 1, 'DOOR', 33));
    const texts = g => g.run(`(() => { ${g.portrait ? 'VIEW.portrait = true; VIEW.w = 540; VIEW.h = 1100; W = 540; H = portraitWorldOnly() ? 540 : VIEW.h;' : 'VIEW.portrait = false; W = 960; H = 540;'} let s = ''; const f = label; label = (t, ...a) => { s += t + '|'; return f(t, ...a); }; try { draw(); } finally { label = f; } return s; })()`);
    ok(A.run('MP.coop.doorText()') === '' && !/at the door/.test(texts(A)), 'nothing about the door while the exit is shut');
    for (const g of gs) g.run('for (const e of G.wild) e.beaten = true');
    B.portrait = true; toEntry(B); toExit(A); await frames(gs, 40);
    ok(fl(A) === 0 && A.run('MP.coop.state().cd') > 0 && B.run('MP.coop.state().cd') > 0, 'one of two at the door: the countdown runs');
    const a = texts(A), b = texts(B);
    ok(/Waiting at the door \(1\/2\)  ·  leaving in \d+s/.test(a), 'landscape, at the door: "' + ((a.match(/Waiting at the door[^|]*/) || [])[0] || '') + '"');
    ok(/1\/2 at the door  ·  leaving in \d+s: come to the exit/.test(b), 'portrait, not there yet: "' + ((b.match(/\d\/\d at the door[^|]*/) || [])[0] || '') + '" over the world');
    ok(B.run('(() => { W = 540; H = 540; ctx.font = "bold 15px " + UI; return ctx.measureText(MP.coop.doorText()).width + 36 <= 540 - 16; })()'), 'and it fits the portrait width');
    A.portrait = true; B.portrait = false; await frames(gs, 6);
    ok(/Waiting at the door \(1\/2\)/.test(texts(A)) && /at the door  ·  leaving in/.test(texts(B)), 'and the other way round (portrait at the door, landscape on the way)');
    toExit(B); await until(gs, () => gs.every(g => fl(g) === 1 && g.run('G.mode') === 'play'), 600, 'both at the door: the next floor');
    ok(A.run('MP.coop.doorText()') === '', 'the door text is gone on the new floor');
    A.portrait = false;
    ok(ERRS.n === e0, 'no error was logged (' + (ERRS.n - e0) + ')');
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
  // WORLD: the shared-tile hooks stay out of a solo run (a smash wall, a crumbling block and its 4 s)
  async soloWorld() {
    const A = games[0], e0 = ERRS.n;
    A.run('G.panel = null; newGame(selClass)'); A.step(30);
    ok(A.run('!G.coop && !MP.coop.active && !MP.coop.state()'), 'a solo run, no session');
    A.run('for (const w of G.wild) w.beaten = true; G.graceT = 0');
    const w = JSON.parse(A.run('JSON.stringify(G.room.dashSpots.map((d, n) => [n, d.kind, d.x0, d.y1 === G.room.floorTop - 1 && [1, 2, 3].every(k => isSolidT(tileAt(d.x0 - k, G.room.floorTop)) && tileAt(d.x0 - k, G.room.floorTop - 1) === EMPTY)]).filter(d => d[1] === "barrier" && d[3])[0] || null)'));
    if (w) {
      A.run(`(() => { const R = G.room, P = G.player; P.x = ${w[2]} * TILE - 50; P.y = R.floorTop * TILE - P.h; P.vx = P.vy = 0; P.face = 1; P.dashCd = 0; P.dashT = 0; P.onGround = true; })()`);
      A.step(4); A.press('d'); A.press('Shift'); A.step(1); A.release('Shift'); A.step(25); A.release('d');
      ok(A.run(`G.room.dashSpots[${w[0]}].broken === true && tileAt(${w[2]}, G.room.floorTop - 1) === EMPTY`) && A.run('G.player.x') > w[2] * 30, 'solo: a dash smashes the wall and goes through');
    } else console.log('  (this solo floor has no smash wall on the ground: skipped)');
    A.run('(() => { const R = G.room, P = G.player; setTile(R, 6, R.floorTop, CRUMBLE); R.crumbleTiles.push([6, R.floorTop]); P.x = 6 * TILE + 3; P.y = R.floorTop * TILE - P.h; P.vx = P.vy = 0; P.dashT = 0; })()');
    A.step(4); ok(A.run('G.room.crumbles.size') === 1, 'solo: a block starts to crumble under the hero');
    A.step(40); ok(A.run('tileAt(6, G.room.floorTop)') === A.run('EMPTY'), 'solo: it falls');
    A.run('G.player.x = 2 * TILE; G.player.y = G.room.floorTop * TILE - G.player.h; G.player.vy = 0'); A.step(200);
    ok(A.run('tileAt(6, G.room.floorTop)') === A.run('EMPTY'), 'solo: still gone 3.3 s later');
    A.step(80); ok(A.run('tileAt(6, G.room.floorTop)') === A.run('CRUMBLE') && A.run('G.room.crumbles.size') === 0, 'solo: back after 4 s');
    A.run('VIEW.portrait = true; VIEW.w = 540; VIEW.h = 1100; W = 540; H = 540;'); A.step(3); A.run('VIEW.portrait = false; W = 960; H = 540;'); A.step(3);
    ok(ERRS.n === e0, 'no error was logged (' + (ERRS.n - e0) + ')');
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
