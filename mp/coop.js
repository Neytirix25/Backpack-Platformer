// =====================================================================
//  MP.coop — THE PARTY SESSION: co-op platforming dungeons and raid arenas for 2-4 players.
//
//  MP.coop.start(info)   info = { code, kind: 'dungeon' | 'raid', tier: 1..4, seed, leader: uid, members: [{ id, name }] }
//  MP.coop.active        true from start() until back in the street
//  MP.coop.end(why)      leave the party room, enterHub('street'), show `why`
//
//  HOW A SESSION GOES
//  1. Gathering. start() leaves the hub, builds a little antechamber (the co-op world: G.coop is set, NOT G.hub; no
//     backpack, no chests, no solo records) and opens the party room 'bps-party-<code>'. The LEADER claims it (the
//     guests wait 2 s before their first try); if a guest got there first and became the room's host, everyone
//     lets go of that room and tries again a little later, until the leader hosts.
//     When every listed member is in, or 12 s after the first guest arrived, the leader starts with who is there.
//     Nobody after 20 s: back to the street. (A listed member who arrives late is sent the current floor.)
//  2. The world. A DUNGEON is 3 platforming floors (the tier's three areas, in an order picked by the seed; the
//     game's floor numbers (tier-1)*10 + 2, 4 and 7, so the act's own themes, hazards and group sizes apply) and
//     then the tier's boss arena (floor tier*10). A RAID is that boss arena alone, fought as enc.kind 'raid'.
//     Every client generates each floor itself inside a seeded scope (seed = mix(session seed, floor index)), so
//     the floors are identical; the leader sends a checksum with 'c.floor', and a client whose floor came out
//     different (another browser's sort, a different build) asks for the whole floor ('c.need' -> 'c.full').
//     No chests, cages, loot or eggs. Buff plants stay: they are personal (each player picks their own).
//     Crumbling blocks, smash walls and moving platforms are simulated locally by each client (v1).
//  3. Sync. Heroes: room.setFast({ x, y, vx, vy, f, g, fl }) and the others are drawn as paper-doll heroes, eased
//     toward their latest position. Pet followers are local only. Wild animals: the leader's game runs their
//     roaming (they are curious about the nearest hero) and broadcasts 'c.wild' 5x/s; the others ease toward it.
//     A hero touching a living group tells the leader ('c.touch'), who announces 'c.enc' and calls
//     MP.battle.hostBegin(enc): the world stands still for everyone and the shared battle opens for all.
//     Won: that group is beaten for everyone ('c.beat'); the exit opens by the solo rule (half the groups).
//     Lost: the dungeon has failed for everyone ('c.over'). The boss / raid boss beaten: 'c.done' (completion
//     panel, +1 SAVE.rec.coopDungeons / coopRaids, a pet XP bonus), then back to the street.
//  4. Leaving a floor: stand in the open exit ('c.door'). When everyone still here is at the door, or 10 s after
//     the first one got there ('c.cd'), the leader starts the next floor for all. A new floor heals your own
//     team by 25% like solo. Hazards hurt your own team only (they never knock a pet out); if your whole team
//     has fainted after a battle the party won, they get back up at 30% where you stand.
//  5. People leaving. A member who leaves ('c.bye' or a dropped connection) just drops out: the battle plays
//     their pets (MP.battle.playerLeft), their hero disappears; the last player left may finish alone.
//     The LEADER leaving (a 'host' change, 'closed' or 'error') ends the session for everyone with a friendly
//     message: there is no host migration inside a dungeon in v1.
//
//  MESSAGES (all validated; * = only accepted from the room's host)
//   c.floor* { i, seed, sum, b: [beaten ids] }   start floor i (generate it from seed; sum = its checksum)
//   c.need   { i }                               guest -> host: my floor i came out different, send it whole
//   c.full*  { i, p, of, d }                     the packed floor as JSON text, in pieces of 12000 characters
//   c.wild*  { i, w: [id, x, y, face, vx, ...] } the living wild groups, 5x/s
//   c.touch  { i, w }                            guest -> host: my hero touched group w
//   c.enc*   { i, w, by }                        the encounter begins (group w, touched by `by`)
//   c.encx*  { i }                               the encounter was called off (the battle never opened)
//   c.beat*  { i, w }                            group w is beaten
//   c.door   { i, on }                           I am (not) standing in the open exit
//   c.cd*    { i, s }                            the door countdown: s seconds left (0 = called off)
//   c.over*  { }                                 the battle was lost: the dungeon failed
//   c.done*  { s, won }                          completed in s seconds with `won` battles
//   c.bye    { }                                 I am leaving the party
//  Everything whose t starts with 'b.' is handed to MP.battle.onMsg(msg, from).
//
//  Hooks in index.html (all marked `// MP:`): logRun / abandonRun (no records), updatePlayer's exit, updateWild,
//  update()'s 'play' and 'trans' cases, drawHUD / drawPortraitHUD, the pause menu (pauseItems, pauseDo, its texts),
//  onMouseDown, tryOpenPack / openPetsMenu.
// =====================================================================
(() => {
  // the four acts as tiers (MP.battle.TIERS when the battle module is loaded; this copy otherwise)
  const TIERS0 = [null, { name: 'The Dungeon', themes: ['hall', 'cave', 'crypt'], boss: 'shadow' }, { name: 'The Burning Depths', themes: ['forge', 'hollow', 'sanctum'], boss: 'elder' },
    { name: 'The Fey Wilds', themes: ['thornwood', 'glade', 'lake'], boss: 'wyrm' }, { name: 'The Drowned Deep', themes: ['temple', 'coral', 'trench'], boss: 'rune' }];
  const tierOf = t => { const T = MP.battle && MP.battle.TIERS && MP.battle.TIERS[t]; return T && Array.isArray(T.themes) && T.themes.length === 3 && T.themes.every(k => THEMES[k]) ? T : TIERS0[t]; };
  const FLOOR_N = [2, 4, 7], GATHER_MAX = 20, GATHER_GO = 12, DOOR_WAIT = 10, PIECE = 12000, MAX_WILD = 12;
  const COMPS_OK = ['pack', 'mixed', 'wall', 'hex', 'healer', 'venom'], DECOR_OK = ['mush', 'fairy', 'candle'], BAKED_OK = ['tombstone', 'bones'];
  let S = null;

  // ---------- small helpers ----------
  const int = (v, lo, hi, d = lo) => (Number.isFinite(+v) ? clamp(Math.round(+v), lo, hi) : d);
  const idOk = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v);
  const mix = (seed, i) => { let h = (seed ^ Math.imul(i + 1, 0x9E3779B1)) >>> 0; h = Math.imul(h ^ h >>> 16, 0x85EBCA6B); h = Math.imul(h ^ h >>> 13, 0xC2B2AE35); return (h ^ h >>> 16) >>> 0; };
  const battleOn = () => !!(MP.battle && MP.battle.active) || (G && G.mode === 'battle');
  const me = () => (S && S.room ? S.room.me : MP.net ? MP.net.uid : 'me');
  const amHost = () => !!(S && S.room && S.room.isHost && S.room.state === 'open');
  const send = (msg, to) => { if (S && S.room && S.room.state === 'open') try { S.room.send(msg, to); } catch (e) {} };
  const nameOf = id => { const o = S && S.others.get(id); return id === me() ? myName() : o ? o.name : (S && S.names[id]) || 'Friend'; };
  // the players who are in the session right now (listed in the party and connected), me first
  function ids() {
    if (!S) return [];
    const out = [me()];
    if (S.room && S.room.members) for (const id of S.listed) if (id !== me() && S.room.members.has(id) && !(S.others.get(id) || {}).gone) out.push(id);
    return out;
  }
  function cleanInfo(info) {
    if (!info || typeof info !== 'object' || !/^[A-Za-z0-9_-]{1,24}$/.test(String(info.code || ''))) return null;
    const members = [];
    for (const m of Array.isArray(info.members) ? info.members.slice(0, 4) : []) if (m && idOk(m.id) && !members.some(o => o.id === m.id)) members.push({ id: m.id, name: String(m.name || 'Friend').replace(/[\u0000-\u001f]/g, '').slice(0, 14) || 'Friend' });
    if (!idOk(info.leader) || !members.some(m => m.id === info.leader)) return null;
    return { code: String(info.code), kind: info.kind === 'raid' ? 'raid' : 'dungeon', tier: int(info.tier, 1, 4, 1), seed: (+info.seed || 0) >>> 0, leader: info.leader, members };
  }

  // ---------- the session ----------
  function start(info) {
    info = cleanInfo(info);
    if (!info || !MP.net || !MP.net.room) { if (G) showMsg('The party could not set out (no connection).', 3); return false; }
    if (S) quit();
    try { if (MP.hub && MP.hub.leave) MP.hub.leave(); } catch (e) { console.error(e); }
    if (!info.members.some(m => m.id === MP.net.uid)) info.members.push({ id: MP.net.uid, name: myName() });
    S = { info, kind: info.kind, tier: info.tier, seed: info.seed, code: info.code, leader: info.leader, listed: info.members.map(m => m.id), names: Object.fromEntries(info.members.map(m => [m.id, m.name])),
          room: null, phase: 'gather', t: 0, firstGuest: null, retryT: 0, fl: -1, nFloors: info.kind === 'raid' ? 1 : 4, others: new Map(), enc: null, grace: 0, won: 0, t0: 0,
          door: {}, cd: 0, wildT: 0, touchT: 0, pend: null, cur: null, result: null, myDoor: false, order: null, sums: {}, fulls: 0 };
    MP.coop.active = true;
    makeWorld();
    S.retryT = info.leader === MP.net.uid ? 0 : 2;   /* (the leader gets a head start at claiming the room) */
    if (!S.retryT) openRoom();
    return true;
  }
  // the co-op world: a run's G without the run (no SAVE.rec.runs, no backpack screen), starting in the antechamber
  function makeWorld() {
    const cls = selClass;
    pack = startItems(cls); loadPets(); stats = null; RUN = { buffs: {}, petHp: {} }; B = null; PK = null;
    G = {
      roomNum: 0, mode: 'play', kills: 0, shake: 0, msg: '', msgT: 0, fade: 1, fadeDir: -1, deadT: 0, minimap: true, endless: false,
      player: { x: 60, y: 0, w: 24, h: 46, vx: 0, vy: 0, kb: 0, face: 1, onGround: true, hp: 20, inv: 0, atk: 0, swing: 0, hitSet: new Set(),
                dropT: 0, walk: 0, dashT: 0, dashCd: 0, dashDir: 1, airDashed: false, trail: [] },
      enemies: [], proj: [], parts: [], texts: [], corpses: [], pets: [], wolves: [], room: null, cam: { x: 0, y: 0 },
    };
    G.cls = cls; G.wild = []; G.startAct = S.tier; G.coop = S; G.battlesWon = 0;
    stats = computeStats(); G.team = teamMods();
    const R = skeleton(-1); buildArena(R, 32, 18); finishRoom(R); R.plants = []; R.lobby = true; R.cleared = true;
    place({ R, wild: [] }, -1);
    G.mode = 'trans';
  }
  function openRoom() {
    const s = S, room = MP.net.room({ id: 'bps-party-' + s.code, cap: 4, maxMsg: 60000, presence: profile(), on: ev => { if (S === s && s.room === room) onEv(ev); } });
    s.room = room;
    try { room.join(); } catch (e) { console.error(e); }
  }
  const profile = () => { const p = netProfile(); return { name: p.name, cls: p.cls, look: p.look }; };
  function attachBattle() {
    if (!MP.battle || !S) return;
    const s = S;
    try {
      if (MP.battle.attach) MP.battle.attach({ me: me(), isHost: () => S === s && amHost(), send: (msg, to) => { if (S === s) send(msg, to); }, ids: () => (S === s ? ids() : []), name: id => (S === s ? nameOf(id) : 'Friend') });
      MP.battle.onEnd = r => { if (S === s) battleEnded(r || {}); };
    } catch (e) { console.error(e); }
  }
  // leave everything behind without going anywhere (start() over an old session, or the world was replaced under us)
  function quit() {
    const s = S; if (!s) return;
    S = null; MP.coop.active = false;
    try { if (s.room && s.room.state !== 'closed') s.room.leave(); } catch (e) {}
    if (MP.battle && MP.battle.onEnd) MP.battle.onEnd = null;
  }
  function end(why) {
    if (!S) return;
    quit();
    if (B && B.coop) B = null;
    PK = null;
    enterHub('street');
    if (why && G) showMsg(why, 4.5);
  }
  function leaveParty() { if (!S) return; send({ t: 'c.bye' }); end('You left the party.'); }
  const leaderGone = () => end(S && S.phase === 'gather' ? 'The party leader left before you set out.' : 'The party leader left: back to the street. Your pets keep what they earned.');

  // ---------- the party room's events ----------
  function onEv(ev) {
    const room = S.room;
    if (ev.type === 'state') {
      if (room.state === 'open') { attachBattle(); other(null); }
      else if (room.state === 'error' || room.state === 'closed') lost();
      else if (room.state === 'migrating' && S.phase !== 'gather' && S.leader !== me()) leaderGone();
    } else if (ev.type === 'closed') lost();
    else if (ev.type === 'host') { if (S.phase !== 'gather' && room.hostId !== S.leader) { if (S.leader === me()) end('The connection to your party was lost.'); else leaderGone(); } }
    else if (ev.type === 'join') { other(ev.id); if (amHost() && S.phase === 'play' && S.cur && S.listed.includes(ev.id)) send(floorMsg(), ev.id); }
    else if (ev.type === 'presence') other(ev.id, true);
    else if (ev.type === 'leave') { if (ev.id === S.leader && S.phase !== 'gather') leaderGone(); else gone(ev.id); }
    else if (ev.type === 'msg') onMsg(ev.msg, ev.from);
  }
  // the room closed or failed: while gathering we simply try again; later the session is over
  function lost() {
    if (!S) return;
    if (S.phase === 'gather') { if (!S.retryT) S.retryT = 1.5; return; }
    if (S.phase === 'done' || S.phase === 'over') return;   /* (the result panel stays; its button leads to the street) */
    if (S.leader === me()) end('The connection to your party was lost.'); else leaderGone();
  }
  // (re)read the members' profiles: other(null) = everyone, other(id) = one
  function other(id, fresh) {
    if (!S || !S.room || !S.room.members) return;
    for (const [mid, m] of S.room.members) {
      if (mid === me() || !S.listed.includes(mid) || (id && mid !== id)) continue;
      let o = S.others.get(mid);
      if (!o || fresh || o.gone) {
        const p = netCleanProfile(m && m.p), was = o;
        o = Object.assign(was || { id: mid, P: null, tx: 0, ty: 0, vx: 0, vy: 0, f: 1, g: 1, fl: -99 }, { name: p.name, cls: p.cls, look: p.look, gone: false });
        if (!(m && m.p && m.p.name)) o.name = S.names[mid] || p.name;
        S.others.set(mid, o);
      }
    }
  }
  function gone(id) {
    const o = S && S.others.get(id); if (!o || o.gone) return;
    o.gone = true; o.P = null; delete S.door[id];
    if (S.phase === 'gather') { S.others.delete(id); return; }
    try { if (MP.battle && MP.battle.playerLeft) MP.battle.playerLeft(id); } catch (e) { console.error(e); }
    if (G && S.phase === 'play') showMsg(`${o.name} left the party.`, 2.6);
  }

  // ---------- messages ----------
  function onMsg(msg, from) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string' || !S.listed.includes(from) || from === me()) return;
    if (msg.t.startsWith('b.')) { try { if (MP.battle && MP.battle.onMsg) MP.battle.onMsg(msg, from); } catch (e) { console.error(e); } return; }
    const host = from === S.room.hostId && from === S.leader, i = int(msg.i, 0, S.nFloors - 1, -1);
    switch (msg.t) {
      case 'c.bye': if (from === S.leader) leaderGone(); else gone(from); break;
      case 'c.door': S.door[from] = { i, on: !!msg.on }; break;
      case 'c.touch': if (amHost() && i === S.fl) hostTouch(int(msg.w, 0, MAX_WILD - 1, -1), from); break;
      case 'c.need': if (amHost() && S.cur && i === S.cur.i) sendFull(from); break;
      case 'c.floor': if (host && i >= 0) gotFloor(i, (+msg.seed || 0) >>> 0, (+msg.sum || 0) >>> 0, Array.isArray(msg.b) ? msg.b.slice(0, MAX_WILD).map(v => int(v, 0, MAX_WILD - 1)) : []); break;
      case 'c.full': if (host) gotPiece(i, int(msg.p, 0, 15), int(msg.of, 1, 16), msg.d); break;
      case 'c.wild': if (host && i === S.fl && Array.isArray(msg.w)) gotWild(msg.w); break;
      case 'c.enc': if (host && i === S.fl) encounter(int(msg.w, 0, MAX_WILD - 1, -1), idOk(msg.by) ? msg.by : from); break;
      case 'c.encx': if (host && S.enc && !battleOn()) { S.enc = null; S.grace = 1.5; } break;
      case 'c.beat': if (host && i >= 0) { if (i === S.fl) beat(int(msg.w, 0, MAX_WILD - 1, -1)); else if (S.pend && S.pend.i === i) S.pend.b.push(int(msg.w, 0, MAX_WILD - 1)); if (S.enc && !battleOn()) { S.enc = null; S.grace = 1.2; } } break;
      case 'c.cd': if (host && i === S.fl) S.cd = int(msg.s, 0, DOOR_WAIT); break;
      case 'c.over': if (host) over(); break;
      case 'c.done': if (host) done(int(msg.s, 0, 86400), int(msg.won, 0, 999)); break;
    }
  }

  // ---------- floors: the same for everyone ----------
  // the room object nextRoom() makes, for floor i of this session (-1 = the antechamber)
  function skeleton(i) {
    const T = tierOf(S.tier), boss = S.kind === 'raid' || i === S.nFloors - 1;
    if (!S.order) { const r = mulberry32(mix(S.seed, 99)), a = T.themes.slice(); for (let k = a.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; } S.order = a; }
    const type = i < 0 ? S.order[0] : boss ? 'boss' : S.order[i % 3], n = i < 0 ? (S.tier - 1) * 10 + 1 : boss ? S.tier * 10 : (S.tier - 1) * 10 + FLOOR_N[i % 3];
    return { type, n, act: S.tier, theme: THEMES[type], bgKey: type, cleared: true, chests: [], cages: [], fire: null, decor: [], baked: [],
             vents: [], shrooms: [], crumbles: new Map(), crumbleBase: new Map(), lavaTiles: [], crumbleTiles: [], openT: 0 };
  }
  // what nextRoom() works out once the grid exists
  function finishRoom(R) {
    R.reachArr = standCells(R);
    for (let ty = 0; ty < R.rows; ty++) for (let tx = 0; tx < R.cols; tx++) {
      const t = R.grid[ty * R.cols + tx];
      if (t === LAVA) R.lavaTiles.push([tx, ty]);
      if (t === CRUMBLE) R.crumbleTiles.push([tx, ty]);
    }
    if (R.type === 'boss') {
      R.boss = BOSS_OF(R.n);
      R.theme = Object.assign({}, R.boss === 'wyrm' ? THEMES.lake : R.boss === 'rune' ? THEMES.temple : THEMES.boss, { name: BOSS_INFO[R.boss].lair });
      if (R.boss === 'wyrm') { R.bgKey = 'lake'; R.tileKey = 'lake'; }
      if (R.boss === 'rune') { R.bgKey = 'temple'; R.tileKey = 'temple'; }
    }
  }
  // generate floor i from its seed WITHOUT touching the world being played: -> F = { R, wild, sum }
  // (nothing of the player feeds generation: no stats, class, team size or save data; chests are left out)
  function genFloor(i, seed) {
    const keepRoom = G.room, keepWild = G.wild, R = skeleton(i);
    let wild = [];
    try {
      pvpSeeded(seed, () => {
        if (R.type === 'boss') buildArena(R, 64, 18); else buildLevel(R);
        if (!R.grid) return;
        finishRoom(R);
        R.chestSpots = [];
        G.room = R; G.wild = [];
        populate(R);
        wild = G.wild;
      });
    } finally { G.room = keepRoom; G.wild = keepWild; }
    if (!R.grid) return null;
    R.chests = []; R.cages = []; R.cleared = true;
    wild.forEach((e, k) => { e.id = k; });
    const F = { R, wild };
    F.sum = checksum(F);
    return F;
  }
  function checksum(F) {
    const R = F.R; let h = 2166136261;
    const add = v => { v = Math.round(+v || 0) | 0; h = Math.imul(h ^ (v & 255), 16777619); h = Math.imul(h ^ (v >>> 8 & 255), 16777619); h = Math.imul(h ^ (v >>> 16 & 255), 16777619); h = Math.imul(h ^ (v >>> 24 & 255), 16777619); };
    const str = s => { for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619); };
    add(R.cols); add(R.rows); for (let k = 0; k < R.grid.length; k++) h = Math.imul(h ^ R.grid[k], 16777619);
    add(R.entry.x); add(R.entry.y); add(R.exitY); add(R.floorTop);
    for (const e of F.wild) { str(e.k); str(e.comp || ''); str(e.boss || ''); add(e.x); add(e.y); }
    for (const p of R.plants || []) { str(p.kind); add(p.x); add(p.y); add(p.hidden || 0); }
    for (const v of R.vents || []) { add(v.tx); add(v.ty); }
    for (const m of R.shrooms || []) { add(m.tx); add(m.ty); }
    for (const m of R.movers || []) { str(m.kind); add(m.x); add(m.y); add(m.w); }
    return h >>> 0;
  }
  // ---- the whole floor as plain data (the fallback when a client's own generation came out different) ----
  const b64 = a => { let s = ''; for (let k = 0; k < a.length; k += 4096) s += String.fromCharCode.apply(null, a.subarray(k, k + 4096)); return btoa(s); };
  function packFloor(F) {
    const R = F.R, r1 = v => Math.round(v * 10) / 10, kinds = Object.keys(PLANTS);
    return { c: R.cols, r: R.rows, g: b64(R.grid), ft: R.floorTop, ex: R.entry.x, ey: R.entry.y, xy: R.exitY,
      v: (R.vents || []).map(v => [v.tx, v.ty, r1(v.t)]), s: (R.shrooms || []).map(m => [m.tx, m.ty]),
      m: (R.movers || []).map(m => (m.kind === 'h' ? [0, m.ax, m.bx, m.y, m.w, r1(m.period), r1(m.t)] : [1, m.x, m.w, m.ay, m.by, r1(m.period), r1(m.t)])),
      cb: [...R.crumbleBase], ds: (R.dashSpots || []).map(d => [d.kind === 'chasm' ? 0 : 1, d.x0, d.x1, d.y0 ?? -1, d.y1 ?? -1]),
      p: (R.plants || []).map(p => [kinds.indexOf(p.kind), p.hidden || 0, p.x, p.y, r1(p.ph || 0)]),
      w: F.wild.map(e => ({ k: e.k, x: r1(e.x), y: r1(e.y), f: e.face, hx: r1(e.homeX), hy: r1(e.homeY), d: e.dir, c: e.comp, coat: e.coat || null, boss: e.boss || null, t: r1(e.t) })),
      d: R.decor.map(o => [o.kind, r1(o.x), r1(o.y), r1(o.s || 0), o.c || '', r1(o.ph || 0)]), bk: R.baked.map(o => [o.kind, r1(o.x), r1(o.y), o.f]) };
  }
  // ...and back, trusting nothing: sizes, tiles, positions and ids are all checked or clamped
  function unpackFloor(d, i) {
    if (!d || typeof d !== 'object') return null;
    const C = int(d.c, 20, 400), RO = int(d.r, 10, 40), R = skeleton(i), arr = (v, n) => (Array.isArray(v) ? v.slice(0, n).filter(Array.isArray) : []);
    let bin; try { bin = atob(String(d.g || '').slice(0, 30000)); } catch (e) { return null; }
    if (bin.length !== C * RO) return null;
    const g = new Uint8Array(C * RO); for (let k = 0; k < g.length; k++) { const t = bin.charCodeAt(k); g[k] = t <= VINE ? t : SOLID; }
    const wpx = C * TILE, hpx = RO * TILE, X = v => int(v, 0, wpx), Y = v => int(v, -200, hpx + 200), TX = v => int(v, 0, C - 1), TY = v => int(v, 0, RO - 1), ft = int(d.ft, 2, RO - 1);
    Object.assign(R, { cols: C, rows: RO, grid: g, wpx, hpx, floorTop: ft, entry: { x: X(d.ex), y: Y(d.ey) }, exitY: Y(d.xy), dashSpots: [], plants: [], chestSpots: [], noSpawn: new Set() });
    R.vents = arr(d.v, 80).map(v => ({ tx: TX(v[0]), ty: TY(v[1]), t: numIn(v[2], 0, 10, 0), state: 'off' }));
    R.shrooms = arr(d.s, 80).map(m => ({ tx: TX(m[0]), ty: TY(m[1]), sq: 0 }));
    R.movers = arr(d.m, 40).map(m => (m[0] === 0
      ? { kind: 'h', ax: X(m[1]), bx: X(m[2]), x: X(m[1]), y: Y(m[3]), w: int(m[4], TILE, 8 * TILE), h: 14, period: numIn(m[5], 1, 120, 6), t: numIn(m[6], 0, 120, 0), dx: 0, dy: 0 }
      : { kind: 'v', x: X(m[1]), w: int(m[2], TILE, 8 * TILE), ay: Y(m[3]), by: Y(m[4]), y: Y(m[3]), h: 14, period: numIn(m[5], 1, 120, 6), t: numIn(m[6], 0, 120, 0), dx: 0, dy: 0 }));
    for (const [k, v] of arr(d.cb, 600)) R.crumbleBase.set(int(k, 0, C * RO - 1), int(v, 0, VINE));
    R.dashSpots = arr(d.ds, 12).map(s => (s[0] === 0 ? { kind: 'chasm', x0: TX(s[1]), x1: TX(s[2]) } : { kind: 'barrier', x0: TX(s[1]), x1: TX(s[2]), y0: TY(s[3] < 0 ? 1 : s[3]), y1: TY(s[4] < 0 ? ft - 1 : s[4]) }));
    const kinds = Object.keys(PLANTS);
    R.plants = arr(d.p, 16).map(p => ({ kind: kinds[int(p[0], 0, kinds.length - 1)], hidden: int(p[1], 0, 9), x: X(p[2]), y: Y(p[3]), taken: false, ph: numIn(p[4], 0, 7, 0) }));
    R.decor = arr(d.d, 40).filter(o => DECOR_OK.includes(o[0])).map(o => ({ kind: o[0], x: X(o[1]), y: Y(o[2]), s: numIn(o[3], 0.3, 2, 1), c: /^#[0-9a-fA-F]{6}$/.test(o[4]) ? o[4] : '#ffffff', ph: numIn(o[5], 0, 7, 0) }));
    R.baked = arr(d.bk, 30).filter(o => BAKED_OK.includes(o[0])).map(o => ({ kind: o[0], x: X(o[1]), y: Y(o[2]), f: o[3] < 0 ? -1 : 1 }));
    R.nav = buildNav(R); R.reach = navReach(R.nav, (ft - 1) * C + 2);
    finishRoom(R);
    const wild = [];
    for (const w of Array.isArray(d.w) ? d.w.slice(0, MAX_WILD) : []) {
      if (!w || typeof w !== 'object' || !PETS[w.k] || typeof w.k !== 'string') continue;
      const boss = typeof w.boss === 'string' && Object.prototype.hasOwnProperty.call(BOSS_INFO, w.boss) ? w.boss : null;
      const e = wildEntity(w.k, X(w.hx), Y(w.y), boss ? { boss, tint: BOSS_INFO[boss].tint } : { comp: COMPS_OK.includes(w.c) ? w.c : 'mixed' });
      const col = w.coat && Array.isArray(w.coat.col) && w.coat.col.length === 2 ? w.coat.col.map(v => int(v, 0, 9)) : null;
      Object.assign(e, { x: numIn(w.x, 0, wpx, e.x), y: numIn(w.y, -200, hpx, e.y), face: w.f < 0 ? -1 : 1, homeY: numIn(w.hy, -200, hpx, e.homeY), dir: w.d < 0 ? -1 : 1, t: numIn(w.t, 0, 10, 0),
                         coat: boss || !COATS[w.k] || !col ? null : { col, blend: !!w.coat.blend }, id: wild.length });
      wild.push(e);
    }
    return { R, wild, sum: 0 };
  }
  // put a floor into the world: what nextRoom() does after generating
  function place(F, i) {
    const R = F.R, P = G.player;
    G.room = R; G.wild = F.wild; G.enemies = []; G.proj = []; G.texts = []; G.corpses = []; G.roomNum = R.n; G.enc = null;
    if (i > 0) healTeam(0.25);
    R.terrain = bakeTerrain(R); R.mini = i < 0 ? null : bakeMinimap(R);
    P.x = R.entry.x - P.w / 2; P.y = R.entry.y - P.h; P.vx = P.vy = P.kb = 0; P.trail = []; P.dashT = 0; P.onGround = true; P.safeX = P.safeY = null; P.climbing = false;
    syncPets(); petsEnterRoom(); snapCamera();
    S.fl = i; S.cd = 0; S.enc = null; S.myDoor = false; S.grace = 1; S.wildT = 0; if (i >= 0) S.sums[i] = F.sum;
    if (i >= 0) {
      if (S.phase === 'gather') { S.phase = 'play'; S.t0 = S.t; }
      for (const w of F.beaten || []) if (G.wild[w]) G.wild[w].beaten = true;
      showMsg(R.type === 'boss' ? `${where()}. ${BOSS_INFO[R.boss].name} waits: walk up to it together!` : where(), R.type === 'boss' ? 4 : 2.4);
    }
  }
  // the leader starts floor i for everyone
  const floorMsg = () => ({ t: 'c.floor', i: S.cur.i, seed: S.cur.seed, sum: S.cur.F.sum, b: S.cur.i === S.fl ? G.wild.filter(e => e.beaten).map(e => e.id) : [] });
  function hostFloor(i) {
    const seed = mix(S.seed, i), F = genFloor(i, seed);
    if (!F) { end('The dungeon collapsed before you could enter (the floor could not be built).'); return; }
    S.cur = { i, seed, F, full: JSON.stringify(packFloor(F)) };
    S.pend = { i, F, b: [] };
    send(floorMsg());
  }
  function sendFull(to) {
    const s = S.cur.full, of = Math.ceil(s.length / PIECE);
    for (let p = 0; p < of; p++) send({ t: 'c.full', i: S.cur.i, p, of, d: s.slice(p * PIECE, (p + 1) * PIECE) }, to);
  }
  function gotFloor(i, seed, sum, b) {
    if (amHost() || (i === S.fl && !S.pend) || (S.pend && S.pend.i === i)) return;
    let F = null; try { F = genFloor(i, seed); } catch (e) { console.error(e); }
    S.pend = { i, F: F && F.sum === sum ? F : null, b, sum, parts: null };
    if (!S.pend.F) send({ t: 'c.need', i }, S.room.hostId);
  }
  function gotPiece(i, p, of, d) {
    const N = S.pend; if (!N || N.i !== i || N.F || typeof d !== 'string' || d.length > PIECE || p >= of) return;
    if (!N.parts || N.parts.length !== of) N.parts = new Array(of).fill(null);
    N.parts[p] = d;
    if (N.parts.some(x => x == null)) return;
    let F = null; try { F = unpackFloor(JSON.parse(N.parts.join('')), i); } catch (e) { console.error(e); }
    N.parts = null;
    if (!F) { end('The dungeon could not be shared with your game: back to the street.'); return; }
    F.sum = N.sum; N.F = F; S.fulls++;
    if (N.dark) { N.F.beaten = N.b; place(N.F, i); S.pend = null; G.fadeDir = -1; }
  }
  // the dark moment of the fade (update()'s 'trans' case): the next floor goes in, or we wait in the dark for it
  function mid() {
    const N = S && S.pend; if (!N) return;
    if (!N.F) { N.dark = true; G.fadeDir = 0; return; }
    N.F.beaten = N.b; place(N.F, N.i); S.pend = null;
  }

  // ---------- the wild animals: the leader's game moves them ----------
  const heroes = () => { const a = [G.player]; for (const o of S.others.values()) if (!o.gone && o.P && o.fl === S.fl) a.push({ x: o.P.x, y: o.P.y, w: 24, h: 46 }); return a; };
  function hostWild(dt) {
    const R = G.room, hs = heroes(), out = [];
    for (const e of G.wild) {
      if (e.beaten) continue;
      e.t += dt;
      let P = hs[0], best = 1e9; for (const h of hs) { const d = Math.abs(h.x - e.x) + Math.abs(h.y - e.y); if (d < best) { best = d; P = h; } }
      if (e.boss) { e.face = Math.sign(P.x - e.x) || e.face; if (!e.fly) { e.vx = 0; moveBody(e, dt); } else e.y = e.homeY + Math.sin(e.t * 1.2) * 8; }
      else if (e.fly) roamFlyer(e, dt, P);
      else { roamWalker(e, dt, P); if (e.y > R.hpx) { e.x = e.homeX - e.w / 2; e.y = e.homeY; e.vy = 0; e.vx = 0; e.span = null; } }
      out.push(e.id, Math.round(e.x), Math.round(e.y), e.face, Math.round(e.vx));
    }
    S.wildT -= dt;
    if (S.wildT <= 0 && out.length) { S.wildT = 0.2; send({ t: 'c.wild', i: S.fl, w: out }); }
  }
  function gotWild(w) {
    const R = G.room;
    for (let k = 0; k + 4 < Math.min(w.length, MAX_WILD * 5 + 1); k += 5) {
      const e = G.wild[int(w[k], 0, MAX_WILD - 1)]; if (!e || e.beaten) continue;
      e.tx = numIn(w[k + 1], -60, R.wpx + 60, e.x); e.ty = numIn(w[k + 2], -300, R.hpx + 60, e.y); e.face = w[k + 3] < 0 ? -1 : 1; e.nvx = numIn(w[k + 4], -400, 400, 0);
    }
  }
  function guestWild(dt) {
    const k = Math.min(1, dt * 9);
    for (const e of G.wild) { if (e.beaten) continue; e.t += dt; if (e.tx == null) continue; e.x += (e.tx - e.x) * k; e.y += (e.ty - e.y) * k; e.vx = e.nvx; }
  }

  // ---------- encounters ----------
  function hostTouch(w, by) {
    const e = G.wild[w];
    if (!e || e.beaten || S.enc || S.pend || battleOn() || S.phase !== 'play' || !ids().includes(by)) return;
    send({ t: 'c.enc', i: S.fl, w, by });
    encounter(w, by);
    const enc = e.boss ? { kind: S.kind === 'raid' ? 'raid' : 'boss', tier: S.tier } : { kind: 'wild', tier: S.tier, k: e.k, comp: e.comp, theme: G.room.type, coat: e.coat || null, floor: G.room.n };
    S.enc.enc = enc;
    try { if (MP.battle && MP.battle.hostBegin) MP.battle.hostBegin(enc); } catch (err) { console.error(err); }
  }
  // the '!' moment on every client; the world stands still until the battle is over
  function encounter(w, by) {
    const e = G.wild[w]; if (!e || S.phase !== 'play') return;
    S.enc = { w, by, t: 0, on: false, off: 0, enc: null };
    if (G.coll) G.coll = null;
    if (G.mode === 'pause') G.mode = 'play';
    G.player.vx = 0; SFX.play('alert');
  }
  function encTick(dt) {
    const E = S.enc; E.t += dt;
    if (battleOn()) { E.on = true; E.off = 0; return; }
    E.off += dt;
    if (amHost()) {
      // no battle module: the group simply runs off (so the dungeon can still be walked); a battle that never opened is called off
      if (!MP.battle || !MP.battle.hostBegin) { if (E.t > 0.9) battleEnded({ won: true }); }
      else if (E.on ? E.off > 4 : E.t > 15) { S.enc = null; S.grace = 1.5; send({ t: 'c.encx', i: S.fl }); }
    } else if (E.on ? E.off > 8 : E.t > 20) { S.enc = null; S.grace = 1.5; }
  }
  // MP.battle.onEnd: on every client, once its result screen is closed
  function battleEnded(r) {
    const E = S.enc; S.enc = null; S.grace = 1.2;
    if (G.mode === 'battle') G.mode = 'play';
    if (!E || S.phase !== 'play') return;
    if (r.won) {
      const e = G.wild[E.w], final = e && e.boss;
      beat(E.w);
      if (amHost()) { send({ t: 'c.beat', i: S.fl, w: E.w }); if (final) { const s = Math.round(S.t - S.t0); send({ t: 'c.done', s, won: S.won }); done(s, S.won); } }
      else if (final) done(Math.round(S.t - S.t0), S.won);
    } else { if (amHost()) send({ t: 'c.over' }); over(); }
  }
  function beat(w) {
    const e = G.wild[w]; if (!e || e.beaten) return;
    e.beaten = true; S.won++; G.battlesWon = S.won;
    burst(e.x + e.w / 2, e.y + e.h / 2, '#ffd54f', 16, 200);
    const R = G.room, n = G.wild.filter(x => x.beaten).length;
    if (R.type !== 'boss' && n === exitNeed()) { SFX.play('clear'); showMsg('The way down is open: gather at the exit ▶', 2.6); }
  }
  function over() {
    if (!S || S.phase === 'over' || S.phase === 'done') return;
    S.phase = 'over'; S.enc = null; S.pend = null;
    S.result = { title: S.kind === 'raid' ? 'The raid failed' : 'The dungeon is lost', lines: [`${title()}: your party was defeated.`, `${S.won} battle${S.won === 1 ? '' : 's'} won  ·  ${clock(S.t - S.t0)}`, 'Your pets keep every level they earned.'] };
  }
  function done(secs, won) {
    if (!S || S.phase === 'over' || S.phase === 'done') return;
    S.phase = 'done'; S.enc = null; S.pend = null;
    const raid = S.kind === 'raid', key = raid ? 'coopRaids' : 'coopDungeons', ups = [];
    SAVE.rec[key] = (SAVE.rec[key] || 0) + 1;
    for (const it of petSlots) if (it) { const u = givePetXp(it, Math.round(XP_NEED(petLvl(it)) * (raid ? 0.5 : 0.35))); if (u && u.length) ups.push(`${petName(it)} reached level ${u[u.length - 1]}`); }
    savePets(); saveData(); syncPets(); SFX.play('kill_boss');
    S.result = { title: raid ? 'Raid complete!' : 'Dungeon complete!', good: true, lines: [`${title()}  ·  ${ids().length} adventurer${ids().length === 1 ? '' : 's'}`, `Time ${clock(secs)}  ·  ${won} battle${won === 1 ? '' : 's'} won`,
      'Your pets learned from it: bonus experience for your team.' + (ups.length ? ' ' + ups.join(', ') + '!' : '')] };
  }
  const clock = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const title = () => (S.kind === 'raid' ? `Raid: ${BOSS_INFO[tierOf(S.tier).boss] ? BOSS_INFO[tierOf(S.tier).boss].name : 'the boss'}` : `${tierOf(S.tier).name} dungeon`);

  // ---------- every frame (MP.ticks): the session goes on whatever this player's screen shows ----------
  function tick(dt) {
    if (!S) return;
    if (!G || G.coop !== S) { quit(); return; }   /* the world was replaced under us */
    S.t += dt; S.grace -= dt; if (S.result) S.result.t = (S.result.t || 0) + dt;
    const room = S.room;
    if (S.retryT > 0 && (S.retryT -= dt) <= 0) { S.retryT = 0; S.room = null; try { if (room && room.state !== 'closed') room.leave(); } catch (e) {} openRoom(); return; }
    if (S.phase === 'gather') gatherTick();
    if (!S) return;
    const open = room && room.state === 'open', P = G.player;
    // heroes: mine goes out, the others ease toward their latest position
    if (open) {
      try { room.setFast({ x: Math.round(P.x), y: Math.round(P.y), vx: Math.round(P.vx), vy: Math.round(P.vy), f: P.face < 0 ? -1 : 1, g: P.onGround ? 1 : 0, fl: S.fl }); } catch (e) {}
      const R = G.room, k = Math.min(1, dt * 12);
      for (const [id, m] of room.members) {
        const o = S.others.get(id), f = m && m.f; if (!o || o.gone || !f || typeof f !== 'object') continue;
        o.fl = int(f.fl, -1, 8, -99); o.tx = numIn(f.x, -200, R.wpx + 200, 0); o.ty = numIn(f.y, -400, R.hpx + 400, 0); o.vx = numIn(f.vx, -2000, 2000, 0); o.vy = numIn(f.vy, -2000, 2000, 0); o.f = f.f < 0 ? -1 : 1; o.g = f.g ? 1 : 0;
        if (o.fl !== S.fl) o.P = null;
        else if (!o.P || Math.abs(o.tx - o.P.x) > 400 || Math.abs(o.ty - o.P.y) > 400) o.P = { x: o.tx, y: o.ty };
        else { o.P.x += (o.tx - o.P.x) * k; o.P.y += (o.ty - o.P.y) * k; }
      }
    }
    if (S.phase !== 'play') return;
    const busy = !!S.enc || battleOn(), world = G.mode === 'play' || G.mode === 'pause';
    // the next floor is waiting: fade out as soon as this player is back in the world
    if (S.pend && !S.pend.go && !busy && world) { S.pend.go = true; if (G.coll) G.coll = null; G.mode = 'trans'; G.fade = Math.max(0, G.fade || 0); G.fadeDir = 1; SFX.play('door'); }
    if (S.enc) encTick(dt);
    if (!S || S.phase !== 'play' || S.fl < 0 || S.pend || G.mode === 'trans') return;
    // my team fainted (a battle the party won without them): back on their feet at 30%
    if (!busy && petSlots.some(Boolean) && !teamAlive().length) { for (const it of petSlots) if (it) RUN.petHp[it.pid] = 0.3; syncPets(); showMsg('Your pets catch their breath: back on their feet.', 2.4); }
    if (!busy) { if (amHost()) hostWild(dt); else guestWild(dt); }
    // touching a wild group
    S.touchT -= dt;
    if (!busy && G.mode === 'play' && S.grace <= 0 && S.touchT <= 0) for (const e of G.wild) if (!e.beaten && overlap(P, e)) {
      S.touchT = 0.5;
      if (amHost()) hostTouch(e.id, me()); else send({ t: 'c.touch', i: S.fl, w: e.id }, room.hostId);
      break;
    }
    if (!S || S.phase !== 'play') return;
    // the door: everyone leaves a floor together
    const last = S.fl >= S.nFloors - 1, at = !last && world && !busy && overlap(P, exitRect(G.room)) && exitOpen();
    if (at !== S.myDoor) { S.myDoor = at; send({ t: 'c.door', i: S.fl, on: at }); }
    if (S.cd > 0 && !amHost()) S.cd = Math.max(0.01, S.cd - dt);
    if (amHost() && !last && !busy) {
      const here = ids(), n = here.filter(atDoor).length;
      if (n && n === here.length) hostFloor(S.fl + 1);
      else if (n) { if (!(S.cd > 0)) { S.cd = DOOR_WAIT; send({ t: 'c.cd', i: S.fl, s: DOOR_WAIT }); } else if ((S.cd -= dt) <= 0) { S.cd = 0; hostFloor(S.fl + 1); } }
      else if (S.cd > 0) { S.cd = 0; send({ t: 'c.cd', i: S.fl, s: 0 }); }
    }
  }
  const atDoor = id => (id === me() ? S.myDoor : !!(S.door[id] && S.door[id].on && S.door[id].i === S.fl));
  function gatherTick() {
    const room = S.room, open = room && room.state === 'open';
    const leader = S.leader === me(), here = open ? ids() : [me()];
    if (S.t > GATHER_MAX && here.length < 2 && !S.pend) { end('Nobody else made it to the party: back to the street.'); return; }
    if (S.t > GATHER_MAX + 16 && !S.pend) { end('The party never set out: back to the street.'); return; }
    // the room is hosted by somebody who is not the leader (a guest got there first): everyone lets go of it and
    // comes back a little later, each guest at its own moment, so the id is free for the leader to claim
    if (open && room.hostId !== S.leader) {
      S.tries = (S.tries || 0) + 1; S.retryT = leader ? 0.6 : 2 + 0.7 * S.listed.indexOf(me()) + 0.5 * Math.min(4, S.tries);
      S.room = null; S.others.clear(); S.firstGuest = null;
      try { room.leave(); } catch (e) {}
      return;
    }
    if (here.length > 1 && S.firstGuest == null) S.firstGuest = S.t;
    if (leader && open && room.isHost && !S.pend) {
      if (here.length >= 2 && (here.length >= S.listed.length || S.t - S.firstGuest > GATHER_GO)) { hostFloor(0); S.pend.go = true; G.mode = 'trans'; G.fade = 0; G.fadeDir = 1; SFX.play('door'); return; }
    }
    if (S.pend && !S.pend.go && (G.mode === 'play' || G.mode === 'pause')) { S.pend.go = true; if (G.coll) G.coll = null; G.mode = 'trans'; G.fade = 0; G.fadeDir = 1; SFX.play('door'); }
  }

  // ---------- update()'s 'play' case in a co-op world ----------
  function play(dt) {
    if (!S || G.coop !== S) { enterHub('street'); return; }   /* (a co-op world without its session: go home) */
    if (S.result) { updateFx(dt); G.player.vx = 0; if (S.result.t > 0.6 && hit('Enter', ' ', 'e', 'Escape')) end(); return; }
    if (hit('p', 'Escape')) { openPause(); return; }
    if (hit('n')) G.minimap = !G.minimap;
    if (S.enc || battleOn()) { G.player.vx = 0; updateFx(dt); return; }
    updateWorld(dt);
  }
  const pauseItems = () => [['resume', 'Resume'], ['animals', 'My Animals'], ['leave', 'Leave the party']];
  function click(btn) {
    if (btn !== 0 || !S) return;
    if (S.result && S.result.t > 0.6 && inRect(mouse, resultBtn())) end();
  }

  // ---------- drawing: the other heroes (world coordinates) ----------
  function drawOthers() {
    if (!S || !G || G.coop !== S) return;
    for (const o of S.others.values()) {
      if (o.gone || !o.P || o.fl !== S.fl || !inView(o.P.x, o.P.y, 160)) continue;
      const cx = o.P.x + 12, foot = o.P.y + 46;
      let nm = heroSheet(o.cls, o.look || cleanLook(null, o.cls)); if (!animFrames(nm, 'idle')) nm = o.cls;
      const anim = !o.g ? 'jump' : Math.abs(o.vx) > 25 ? 'run' : 'idle';
      const i = anim === 'jump' ? (o.vy < -260 ? 1 : o.vy < 140 ? 2 : 3) : anim === 'run' ? Math.floor(TIME * 9) : Math.floor(TIME * 5);
      footShadow(cx, foot, 16, o.g ? 1 : 0.5);
      if (animFrames(nm, 'idle')) drawAnim(nm, anim, i, cx, foot + 1, o.f || 1, {});
      else { ctx.fillStyle = PAL.gold; rr(o.P.x, o.P.y, 24, 46, 6); ctx.fill(); }
      ctx.font = `bold 12px ${UI}`; const tw = ctx.measureText(o.name).width + 18;
      panel(cx - tw / 2, o.P.y - 34, tw, 20, 'parch'); label(o.name, cx, o.P.y - 24, { align: 'center', size: 12, bold: true, color: PAL.parchInk });
    }
    // the '!' of an encounter, over my hero and the animal (the game's own alert)
    const E = S.enc, e = E && G.wild[E.w];
    if (e && E.t < 0.9 && !battleOn()) { const keep = G.enc; G.enc = { e, t: E.t }; try { drawEncounterAlert(); } finally { G.enc = keep; } }
  }

  // ---------- drawing: the HUD ----------
  function where() {
    if (!S || !G || !G.room) return '';
    if (S.fl < 0) return `${title()}  ·  the party gathers`;
    return S.kind === 'raid' ? `Raid  ·  ${G.room.theme.name}` : `Dungeon ${S.fl + 1}/${S.nFloors}  ·  ${G.room.theme.name}`;
  }
  function status() {
    const R = G.room, won = G.wild.filter(w => w.beaten).length, total = G.wild.length;
    if (S.fl < 0) return 'Setting out as soon as everyone is here';
    if (S.enc || battleOn()) return 'The party is fighting!';
    if (R.type === 'boss') return won ? 'Victory!' : `Walk up to ${BOSS_INFO[R.boss].name} to begin`;
    if (!exitOpen()) return `Win ${exitNeed() - won} more battle${exitNeed() - won > 1 ? 's' : ''} to open the exit (${won}/${total})`;
    const here = ids(), n = here.filter(atDoor).length;
    if (n) return S.myDoor ? `Waiting for the others at the door (${n}/${here.length})${S.cd > 0 ? '  ·  ' + Math.ceil(S.cd) + 's' : ''}` : `The party is leaving (${n}/${here.length} at the door)${S.cd > 0 ? '  ·  ' + Math.ceil(S.cd) + 's' : ''}`;
    return `Exit open ▶  gather at the door   (${won}/${total} beaten)`;
  }
  // the party: [name, dot colour, note] per player (me first)
  function partyRows() {
    const rows = [], fight = !!S.enc || battleOn();
    const row = (id, name, goneNow, there) => rows.push(goneNow ? [name, '#7a6a58', 'left'] : !there ? [name, '#b0a090', 'on the way'] : fight ? [name, '#ff8a65', 'fighting'] : atDoor(id) ? [name, PAL.gold, 'at the door'] : [name, '#81c784', '']);
    row(me(), myName(), false, true);
    for (const id of S.listed) { if (id === me()) continue; const o = S.others.get(id), inRoom = !!(S.room && S.room.members && S.room.members.has(id)); if (S.phase !== 'gather' && !o) continue; row(id, o ? o.name : S.names[id] || 'Friend', !!(o && o.gone) || (S.phase !== 'gather' && !inRoom), !!o && inRoom && (S.phase === 'gather' || o.fl === S.fl || S.fl < 0)); }
    return rows;
  }
  function drawParty(x, y, w, cols) {
    const rows = partyRows(), per = Math.ceil(rows.length / cols), cw = (w - 12) / cols;
    panel(x, y, w, 12 + per * 19, 'dark');
    rows.forEach(([name, col, note], k) => {
      const rx = x + 8 + Math.floor(k / per) * cw, ry = y + 16 + (k % per) * 19;
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(rx + 6, ry, 5, 0, Math.PI * 2); ctx.fill();
      ctx.font = `10px ${UI}`; const nw = note ? ctx.measureText(note).width + 8 : 0;
      ctx.font = `bold 12px ${UI}`; label(fitText(name, cw - 26 - nw), rx + 17, ry, { size: 12, bold: true, color: note === 'left' ? PAL.dim : PAL.cream });
      if (note) label(note, rx + cw - 8, ry, { align: 'right', size: 10, color: col });
    });
    return 12 + per * 19;
  }
  function drawTeam(x0, y, w, gap) {
    petSlots.forEach((it, i) => {
      const x = x0 + i * (w + gap);
      panel(x, y, w, 42, 'leather');
      if (!it) { label('empty slot', x + w / 2, y + 21, { align: 'center', size: 12, color: PAL.dim }); return; }
      const hp = runHp(it.pid) ?? 1, fainted = hp <= 0, lv = 'Lv' + petLvl(it);
      ctx.font = `bold 13px ${UI}`; const lvW = ctx.measureText(lv).width;
      label(fitText(petName(it), w - 34 - lvW), x + 12, y + 14, { size: 13, bold: true, color: fainted ? PAL.bad : PAL.cream });
      label(lv, x + w - 12, y + 14, { align: 'right', size: 13, bold: true, color: PAL.good });
      meter(x + 12, y + 26, w - 24, 7, fainted ? 0 : hp, hpColor(hp));
      if (fainted) label('FAINTED', x + w / 2, y + 30, { align: 'center', size: 11, bold: true, color: PAL.cream });
    });
  }
  function drawPlants(x, y) {
    let bx = x, any = false;
    for (const kk of ['ember', 'stone', 'catnip', 'swift']) {
      const t = RUN.buffs[kk]; if (!(t > 0)) continue; any = true;
      panel(bx, y, 60, 26, 'dark');
      const img = art('props/plant_' + kk);
      if (img) drawSprite(img, bx + 14, y + 21, 1, { scale: 1.2 }); else { ctx.fillStyle = PLANTS[kk].color; ctx.fillRect(bx + 8, y + 6, 12, 12); }
      label(kk === 'swift' ? Math.ceil(t) + 's' : 'x' + t, bx + 30, y + 13, { size: 13, bold: true });
      bx += 66;
    }
    return any;
  }
  const HINT = () => (TOUCH.on ? TOUCH_HINT.replace(' · tap to use', '') + ' · touch wild animals to battle together' : 'A/D move · W jump · S drop · Shift dash · run into wild animals to battle together · N map · P pause / leave · M ' + (SFX.muted ? 'sound on' : Music.on ? 'music off' : 'mute all'));
  function drawHUD() {
    if (!S || G.coop !== S) return;
    drawTeam(10, 6, 152, 6);
    const plants = drawPlants(12, 52);
    const wh = where(), st = status(), good = S.fl >= 0 && exitOpen() && !S.enc;
    ctx.font = `bold 14px ${UI}`; const pw = Math.min(W - 500, Math.max(ctx.measureText(wh).width, (ctx.font = `13px ${UI}`, ctx.measureText(st).width)) + 34);
    panel(W - pw - 8, 4, pw, 44, 'leather');
    ctx.font = `bold 14px ${UI}`; label(fitText(wh, pw - 26), W - 22, 17, { align: 'right', size: 14, bold: true, color: PAL.gold });
    ctx.font = `13px ${UI}`; label(fitText(st, pw - 26), W - 22, 33, { align: 'right', size: 13, color: good ? PAL.good : '#f0a070' });
    if (S.fl >= 0) drawMinimap();
    drawParty(10, plants ? 84 : 54, 190, 1);
    ctx.globalAlpha = 0.7; label(HINT(), W / 2, H - 12, { align: 'center', size: 12, color: PAL.cream }); ctx.globalAlpha = 1;
    if (G.msgT > 0 && G.msg) drawToast(G.msg, 104);
  }
  // portrait: the panel under the world's square (called with W x H = the whole tall screen, y = its first free row)
  function drawPortraitHUD(y) {
    if (!S || G.coop !== S) return;
    const Wv = W, Hv = H, R = G.room, good = S.fl >= 0 && exitOpen() && !S.enc;
    panel(6, y, Wv - 12, 46, 'leather');
    ctx.font = `bold 15px ${UI}`; label(fitText(where(), Wv - 40), Wv / 2, y + 16, { align: 'center', size: 15, bold: true, color: PAL.gold });
    ctx.font = `13px ${UI}`; label(fitText(status(), Wv - 40), Wv / 2, y + 33, { align: 'center', size: 13, color: good ? PAL.good : '#f0a070' });
    y += 50;
    drawTeam(6, y, 172, 6); y += 48;
    y += drawParty(6, y, Wv - 12, 2) + 6;
    if (drawPlants(8, y)) y += 32;
    if (R.mini && S.fl >= 0 && y + 60 < Hv - 40) {
      const mw = R.mini.width, mh = R.mini.height, sc = (Wv - 24) / mw, x = 12, k = (R.miniS || 2) * sc / TILE, yy = y + 6;
      panel(x - 6, y, mw * sc + 12, mh * sc + 12, 'dark');
      ctx.drawImage(R.mini, x, yy, mw * sc, mh * sc);
      ctx.fillStyle = exitOpen() ? '#69f0ae' : '#ef5350'; ctx.fillRect(x + (R.cols - 2) * (R.miniS || 2) * sc - 1, yy + R.exitY * k - 6, 4, 6);
      for (const e of G.wild || []) { if (e.beaten) continue; ctx.fillStyle = e.boss ? '#ff5252' : '#ffab40'; ctx.fillRect(x + (e.x + e.w / 2) * k - 2, yy + (e.y + e.h / 2) * k - 2, 4, 4); }
      for (const o of S.others.values()) if (!o.gone && o.P && o.fl === S.fl) { ctx.fillStyle = '#80deea'; ctx.fillRect(x + (o.P.x + 12) * k - 1.5, yy + (o.P.y + 23) * k - 2, 3, 5); }
      const P = G.player; ctx.fillStyle = '#ffffff'; ctx.fillRect(x + (P.x + P.w / 2) * k - 1.5, yy + (P.y + P.h / 2) * k - 2, 3, 5);
    }
    ctx.globalAlpha = 0.7;
    wrapLines(HINT(), Wv - 30, 12).forEach((l, i, a) => label(l, Wv / 2, Hv - 14 - (a.length - 1 - i) * 16, { align: 'center', size: 12 }));
    ctx.globalAlpha = 1;
    if (G.msgT > 0 && G.msg && portraitWorldOnly()) { W = 540; drawToast(G.msg, 40); W = Wv; }
  }
  // ---------- drawing: the panels over the world (MP.hudDraw; W x H = the world's view in both layouts) ----------
  const resultBox = () => { const w = Math.min(520, W - 16); return { x: Math.round(W / 2 - w / 2), y: Math.round(H / 2 - 120), w, h: 250 }; };
  const resultBtn = () => { const b = resultBox(); return { x: W / 2 - 120, y: b.y + b.h - 56, w: 240, h: 42 }; };
  function drawPanels() {
    if (!S || !G || G.coop !== S || G.mode === 'battle') return;
    if (S.phase === 'gather' && !(S.pend && S.pend.go)) {
      const rows = S.listed.map(id => [id === me() ? myName() : (S.others.get(id) || {}).name || S.names[id] || 'Friend', id === me() || (S.room && S.room.state === 'open' && S.room.members.has(id) && S.others.has(id))]);
      const w = Math.min(360, W - 16), x = Math.round(W / 2 - w / 2), y = PORTRAIT() ? 70 : 96, h = 74 + rows.length * 22;
      panel(x, y, w, h, 'parch');
      label('Gathering the party' + '.'.repeat(1 + Math.floor(TIME * 2) % 3), W / 2, y + 22, { align: 'center', size: 17, bold: true, color: PAL.parchInk });
      rows.forEach(([name, here], k) => {
        ctx.font = `bold 13px ${UI}`; label(fitText(name, w - 150), x + 28, y + 50 + k * 22, { size: 13, bold: true, color: PAL.parchInk });
        label(here ? 'here' : 'on the way...', x + w - 28, y + 50 + k * 22, { align: 'right', size: 12, color: here ? '#2e6b2e' : '#8a6a4a' });
      });
      const left = Math.max(0, Math.ceil((S.firstGuest != null ? S.firstGuest + GATHER_GO : GATHER_MAX) - S.t));
      ctx.font = `12px ${UI}`; label(fitText(S.firstGuest != null ? `Setting out in ${left}s at the latest  ·  P: leave` : `Waiting ${left}s for the others  ·  P: leave`, w - 30), W / 2, y + h - 18, { align: 'center', size: 12, color: '#6b4a2a' });
    }
    if (S.pend && S.pend.dark && !S.pend.F) { ctx.font = `14px ${UI}`; label('Fetching the floor from the party leader...', W / 2, H / 2, { align: 'center', size: 14, color: PAL.cream }); }
    const Q = S.result; if (!Q) return;
    ctx.fillStyle = 'rgba(8,5,3,0.6)'; ctx.fillRect(0, 0, W, H);
    const b = resultBox(), r = resultBtn();
    banner(Q.title, W / 2, b.y - 8, { size: PORTRAIT() ? 32 : 40, h: 58, pad: PORTRAIT() ? 60 : 110 });
    panel(b.x, b.y + 30, b.w, b.h - 30, 'parch');
    let y = b.y + 62;
    Q.lines.forEach((t, k) => { for (const l of wrapLines(t, b.w - 44, k ? 14 : 16, !k)) { label(l, W / 2, y, { align: 'center', size: k ? 14 : 16, bold: !k, color: k ? '#5a3d22' : PAL.parchInk }); y += k ? 20 : 24; } y += 4; });
    button(r, 'Back to the street', { hover: inRect(mouse, r), size: 16, color: Q.good ? PAL.gold : PAL.cream });
    if (!TOUCH.on) label('Enter', W / 2, r.y + r.h + 12, { align: 'center', size: 11, color: '#6b4a2a' });
  }

  CONFIRM_TXT.leave = 'Leave the party and return to the street?';
  MP.coop = { start, end, active: false, play, mid, click, pauseItems, leaveParty, drawHUD, drawPortraitHUD, where,
              /* for tests and debugging */ state: () => S, ids, checksum, genFloor, packFloor, unpackFloor };
  MP.ticks.push(tick); MP.worldDraw.push(drawOthers); MP.hudDraw.push(drawPanels);
})();
