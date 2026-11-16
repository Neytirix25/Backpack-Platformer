// The co-op battle's layout without a browser: where every sprite, HP bar, name, status icon and team label goes
// (MP.battle.place / MP.battle.labels, the game's own unitRect / unitAt), for 1-4 players x wild / boss / raid x
// landscape (960x540) / a tall phone / a short phone, plus a raid after its adds arrive and a crowd of statuses.
//   node tools/mp_tests/battle_layout_dump.js                  an ASCII sketch of every case + the problems found
//   node tools/mp_tests/battle_layout_dump.js --case "4p wild" only the cases whose name contains that
//   node tools/mp_tests/battle_layout_dump.js --json           the rectangles as JSON (one line per case)
// Sketch: 1-4 = that player's pets, f = a foe, B = the boss, x = a fainted unit, '=' HP bar, 'n' name, '*' status
// icons, '+' the "+n more" marker, '_' a team's name, '-' the top of the bottom panel. One character = 8 x 12 px.
// tools/mp_tests/battle_test.js runs the same cases and fails on any problem (see check()).
const { bootGame } = require('./boot.js');
const TEAMS = [['dragon', 'hellhound', 'phoenix'], ['tortoise', 'lion', 'qilin'], ['salamander', 'moth', 'chimera'], ['owl', 'fox', 'dog']];
const NAMES = ['Ann', 'Bartholomew the Long', 'Cy', 'Dee'], CLS = ['warrior', 'archer', 'rogue', 'beastmaster'];
const VIEWS = { land: [960, 540], port: [340, 740], short: [400, 600] };

function boot(view) {
  const g = bootGame({ name: 'Lay' }); g.win.console = Object.assign({}, console, { warn: () => {} });
  if (view !== 'land') { g.win.innerWidth = VIEWS[view][0]; g.win.innerHeight = VIEWS[view][1]; g.run('fit()'); }
  g.run(`enterHub(); G.panel = null;
    const LAY = { ids: [] };
    MP.battle.attach({ me: 'p0', isHost: () => true, send: () => {}, ids: () => LAY.ids, name: id => id });
    LAY.view = () => { VIEW.legacy = VIEW.portrait && !portraitReady(); if (VIEW.portrait && !VIEW.legacy) { W = 540; H = VIEW.h; } else { W = 960; H = 540; } };
    LAY.team = (ks, lvl, name, cls) => {
      petSlots = ks.map(k => newPet(k, lvl, rollGenes({ shiny: false }))); G.cls = cls; RUN.petHp = {};
      const t = MP.battle._cleanTeam(MP.battle.myTeam()); t.name = name; return t;
    };
    LAY.begin = (n, enc, sets, names, cls) => {
      if (B) MP.battle.abort('');
      LAY.ids = Array.from({ length: n }, (_, i) => 'p' + i);
      const teams = LAY.ids.map((id, i) => ({ id, team: LAY.team(sets[i], 22, names[i], cls[i]) }));
      if (!MP.battle._begin(enc, teams, [], 0, { quiet: true })) throw new Error('no battle');
      LAY.view(); draw();
    };
    // the raid's second phase: hurt the boss and let the host play (the AI for everyone) until the adds are there
    LAY.adds = () => { const b = B.foes.find(f => f.boss); b.hp = Math.round(b.maxHp * 0.6); B.coop.auto = true; let i = 0; while (B && B.coop && B.coop.rphase < 2 && i++ < 400) { B.lock = 0; MP.battle.step(0.1); } B.coop.auto = false; return B.coop.rphase; };
    LAY.crowd = () => { const ks = ['burn', 'poison', 'bleed', 'mark', 'weak', 'blind', 'str', 'regen', 'guard']; [...B.allies, ...B.foes].forEach((u, i) => { if (u.fainted) return; for (const k of ks.slice(0, 2 + (i * 3) % 8)) addSt(u, k, 3); addShield(u, 20); }); };
    LAY.faint = ids => { for (const u of [...B.allies, ...B.foes]) if (ids.includes(u.id)) { u.hp = 0; u.fainted = true; u.faintT = 9; u.st = {}; } };
    LAY.measure = () => {
      LAY.view(); mouse.x = -999; mouse.y = -999; B.coop.exp = null; B.coop.expPin = null; B.stPin = null; battleLayout(); placeUnits(); draw(); placeUnits();
      const C = B.coop, q = r => r && ({ x: r.x, y: r.y, w: r.w, h: r.h });
      return JSON.stringify({ W, H, panelY: BX.panelY, ground: BX.ground, top: B.foes.some(f => f.boss) ? 78 : 44, me: C.me,
        units: [...B.allies, ...B.foes].map(u => { const L = MP.battle.labels(u), r = unitRect(u), hit = unitAt({ x: r.x + r.w / 2, y: r.y + r.h / 2 }), mo = MP.battle.stMore(u);
          return { id: u.id, side: u.side, p: u.p, k: u.k, name: u.name, boss: !!u.boss, elite: !!u.elite, f: !!u.fainted, cs: u.cs, r: q(r), bar: q(L.bar), nm: L.name ? Object.assign(q(L.name), { txt: L.name.txt }) : null,
            ic: MP.battle.stIcons(u).map(q), more: mo ? Object.assign(q(mo), { n: mo.n }) : null, nst: Object.keys(u.st).filter(k => STATUS[k]).length, hit: hit ? hit.id : null }; }),
        blocks: C.pl.length > 1 ? C.blocks.map(b => ({ p: b.p, x0: b.x0, x1: b.x1, base: b.base, lr: q(b.lr), txt: b.txt })) : [] });
    };
    globalThis.LAY = LAY;`);
  return g;
}
const R1 = x => Math.round(x * 10) / 10, round = o => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? R1(v) : v)));
const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const who = u => (u.side === 'ally' ? `P${u.p + 1}'s ${u.name}` : u.name) + '#' + u.id;

// every case: { name, d: the measured layout, problems: [...] }
function cases(filter) {
  const out = [], games = {};
  const run = (view, name, fn) => {
    if (filter && !name.includes(filter)) return;
    const g = games[view] || (games[view] = boot(view));
    fn(g); const d = round(JSON.parse(g.run('LAY.measure()')));
    out.push({ name, view, d, problems: check(d) });
  };
  for (const view of Object.keys(VIEWS)) {
    for (let n = 1; n <= 4; n++) for (const kind of ['wild', 'boss', 'raid']) {
      const enc = kind === 'wild' ? { kind, tier: 2, theme: 'forge', comp: 'mixed' } : { kind, tier: 2 };
      run(view, `${n}p ${kind} ${view}`, g => g.run(`LAY.begin(${n}, ${JSON.stringify(enc)}, ${JSON.stringify(TEAMS)}, ${JSON.stringify(NAMES)}, ${JSON.stringify(CLS)})`));
      if (kind === 'raid') run(view, `${n}p raid+adds ${view}`, g => g.run('LAY.adds()'));
    }
    run(view, `4p wild statuses ${view}`, g => g.run(`LAY.begin(4, { kind: 'wild', tier: 2, theme: 'forge', comp: 'mixed' }, ${JSON.stringify(TEAMS)}, ${JSON.stringify(NAMES)}, ${JSON.stringify(CLS)}); LAY.crowd()`));
    run(view, `4p wild fainted ${view}`, g => g.run('LAY.faint([1, 5, 9, 101, 103])'));
    run(view, `3p boss tier1 statuses ${view}`, g => g.run(`LAY.begin(3, { kind: 'boss', tier: 1 }, ${JSON.stringify([['dog', 'fox', 'owl'], ['boar', 'toad', 'cockatiel'], ['catgray', 'ferret', 'sunday']])}, ${JSON.stringify(NAMES)}, ${JSON.stringify(CLS)}); LAY.crowd()`));
  }
  for (const g of Object.values(games)) g.run(`if (B) MP.battle.abort('')`);
  return out;
}
// the geometry rules (living units only: the fainted are faded out and have no labels)
function check(d) {
  const P = [], live = d.units.filter(u => !u.f), TOL = 0.15;
  const labels = u => [['bar', u.bar], ['name', u.nm]].concat(u.ic.map(r => ['icon', r]), u.more ? [['more', u.more]] : []).filter(x => x[1]);
  for (const u of live) {
    const r = u.r;
    if (r.x < 0 || r.x + r.w > d.W || r.y < d.top || r.y + r.h > d.panelY) P.push(`${who(u)}: sprite outside the scene (${JSON.stringify(r)})`);
    for (const [k, l] of labels(u)) if (l.x < 0 || l.x + l.w > d.W || l.y < d.top || l.y + l.h > d.panelY) P.push(`${who(u)}: its ${k} is outside the scene (${JSON.stringify(l)})`);
    if (u.hit !== u.id) P.push(`${who(u)}: a click on its centre picks ${u.hit}`);
    if (u.ic.length > 3 || (u.nst > 3 ? !u.more || u.more.n !== u.nst - 3 : !!u.more) || u.ic.length !== Math.min(3, u.nst)) P.push(`${who(u)}: ${u.nst} statuses shown as ${u.ic.length} icons, marker ${u.more ? '+' + u.more.n : 'none'}`);
    if (r.w < 20 || r.h < 16) P.push(`${who(u)}: too small to read (${r.w} x ${r.h})`);
    if (u.side === 'ally' && !u.nm) P.push(`${who(u)}: no name`);
    if (u.side === 'foe' && (u.boss || u.elite) && !u.nm) P.push(`${who(u)}: an elite / boss without a name`);
  }
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i], b = live[j], o = inter(a.r, b.r), small = Math.min(a.r.w * a.r.h, b.r.w * b.r.h);
    if (o > small * TOL) P.push(`${who(a)} and ${who(b)}: sprites overlap by ${Math.round(o / small * 100)}%`);
    for (const [ka, la] of labels(a)) for (const [kb, lb] of labels(b)) if (inter(la, lb) > 1) P.push(`${who(a)}'s ${ka} overlaps ${who(b)}'s ${kb}`);
    for (const [x, y] of [[a, b], [b, a]]) for (const [k, l] of labels(x)) if (inter(l, y.r) > Math.min(l.w * l.h, y.r.w * y.r.h) * TOL) P.push(`${who(x)}'s ${k} lies over ${who(y)}'s sprite`);
  }
  for (const b of d.blocks) {
    if (b.lr.x < 0 || b.lr.x + b.lr.w > d.W || b.lr.y + b.lr.h > d.panelY + 1) P.push(`team ${b.p + 1}'s name is outside the scene`);
    for (const c of d.blocks) if (c.p > b.p && inter(b.lr, c.lr) > 1) P.push(`team ${b.p + 1}'s and team ${c.p + 1}'s names overlap`);
    for (const u of live) { if (inter(b.lr, u.r) > 6) P.push(`team ${b.p + 1}'s name lies over ${who(u)}`); for (const [k, l] of labels(u)) if (inter(b.lr, l) > 1) P.push(`team ${b.p + 1}'s name overlaps ${who(u)}'s ${k}`); }
  }
  return P;
}
function sketch(d) {
  const CW = 8, CH = 12, y0 = 36, cols = Math.ceil(d.W / CW), rows = Math.ceil((d.panelY + 6 - y0) / CH), G = Array.from({ length: rows }, () => Array(cols).fill(' '));
  const put = (r, ch, keep) => { if (!r) return; for (let y = Math.floor((r.y - y0) / CH); y <= Math.floor((r.y + r.h - 1 - y0) / CH); y++) for (let x = Math.floor(r.x / CW); x <= Math.floor((r.x + r.w - 1) / CW); x++) if (G[y] && x >= 0 && x < cols && !(keep && G[y][x] !== ' ')) G[y][x] = ch; };
  put({ x: 0, y: d.panelY, w: d.W, h: 1 }, '-');
  for (const b of d.blocks) put(b.lr, '_');
  for (const u of d.units) put(u.r, u.f ? 'x' : u.side === 'ally' ? String(u.p + 1) : u.boss ? 'B' : 'f');
  for (const u of d.units) if (!u.f) { put(u.bar, '='); put(u.nm, 'n'); for (const r of u.ic) put(r, '*'); put(u.more, '+'); }
  return G.map(r => r.join('').replace(/\s+$/, '')).join('\n');
}
module.exports = { cases, check, sketch, boot, TEAMS, NAMES, CLS };
if (require.main === module) {
  const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] || true : null; };
  const all = cases(typeof arg('case') === 'string' ? arg('case') : null); let bad = 0;
  for (const c of all) {
    if (arg('json')) { console.log(JSON.stringify({ name: c.name, problems: c.problems, ...c.d })); continue; }
    const live = c.d.units.filter(u => !u.f), ws = live.map(u => u.r.w), hs = live.map(u => u.r.h);
    console.log(`\n=== ${c.name}  (${c.d.W} x ${c.d.H}, panel at ${c.d.panelY}; ${c.d.units.filter(u => u.side === 'ally').length} allies, ${c.d.units.filter(u => u.side === 'foe').length} foes; sprites ${Math.min(...ws)}-${Math.max(...ws)} wide, ${Math.min(...hs)}-${Math.max(...hs)} tall) ===`);
    console.log(sketch(c.d));
    console.log(c.d.blocks.map(b => `team ${b.p + 1}${b.p === c.d.me ? ' (mine)' : ''}: "${b.txt}" x ${b.x0}-${b.x1} ground ${b.base}`).join(' | '));
    console.log(c.problems.length ? 'PROBLEMS:\n  ' + c.problems.join('\n  ') : 'no problems');
    bad += c.problems.length;
  }
  if (!arg('json')) console.log(`\n${all.length} cases, ${bad} problems`);
  process.exit(bad ? 1 : 0);
}
