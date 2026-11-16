// Co-op battle simulation: thousands of REAL battles (the game's own act / aiChoose / tickSide and MP.battle's host
// turn machine, no drawing, no waiting) to tune and check MP.battle.scale(n).
//   node tools/coop_sim.js                      every tier x group size x kind at level, then 3 levels under / over
//   node tools/coop_sim.js --n 500 --tiers 2 --kinds raid --sizes 2,3,4 --off 0
//   node tools/coop_sim.js --set '{"3":{"hp":1.6}}' --tier '{"2":{"wildMul":[1,0.9]}}'     try other numbers
//   node tools/coop_sim.js --out tools/mp_tests/coop_sim_results.txt
// Parties: random species a player of that tier would own (the tier's own animals, some from earlier tiers), levels
// around a point inside the tier's band, full talent builds (foeTalents), random natures / grades / classes; every
// pet (the players' too) is played by aiChoose. Players start at full HP.
const fs = require('fs'), path = require('path');
const { bootGame, ROOT } = require('./mp_tests/boot.js');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const N = +arg('n', 300), list = (k, d) => String(arg(k, d)).split(',').filter(Boolean);
const tiers = list('tiers', '1,2,3,4').map(Number), sizes = list('sizes', '1,2,3,4').map(Number), kinds = list('kinds', 'wild,boss,raid'), offs = list('off', '0,-3,3').map(Number);
const g = bootGame({ name: 'Sim' });
g.win.console = Object.assign({}, console, { warn: () => {} });
g.run('enterHub(); G.panel = null;');
if (arg('set')) g.run(`(() => { const o = ${arg('set')}; for (const n in o) Object.assign(MP.battle.SCALE[n], o[n]); })()`);
if (arg('tier')) g.run(`(() => { const o = ${arg('tier')}; for (const t in o) Object.assign(MP.battle.TIERS[t], o[t]); })()`);
g.run(`
  const SIM = {};
  bText = () => {}; bLog = () => {};   // (floating numbers and the log are only for show)
  SIM.ids = [];
  MP.battle.attach({ me: 'sim', isHost: () => true, send: () => {}, ids: () => SIM.ids, name: id => id });
  SIM.pool = tier => { const own = MP.battle.TIERS[tier].themes.flatMap(t => THEME_POOL[t]), old = []; for (let t = 1; t < tier; t++) old.push(...MP.battle.TIERS[t].themes.flatMap(x => THEME_POOL[x]));
    const ok = k => ITEMS['pet_' + k] && BS[k] && PET_TREES[k]; return { own: [...new Set(own)].filter(ok), old: [...new Set(old)].filter(ok) }; };
  SIM.team = (tier, base) => {
    const P = SIM.pool(tier), ks = [];
    while (ks.length < 3) { const k = P.old.length && Math.random() < 0.25 ? pick(P.old) : pick(P.own); if (!ks.includes(k) || Math.random() < 0.15) ks.push(k); }
    petSlots = ks.map(k => { const it = makeItem('pet_' + k); it.pid = 'sim' + (uid++); it.plvl = clamp(base + Math.floor(Math.random() * 3) - 1, 1, PET_MAX_LVL); it.g = rollGenes({ shiny: false }); it.g.bond = Math.floor(Math.random() * 60);
      it.talents = foeTalents(k, it.plvl); it.talV = 1; return it; });
    G.cls = pick(CLASS_ORDER); RUN.petHp = {};
    return MP.battle._cleanTeam(MP.battle.myTeam());
  };
  SIM.one = (tier, n, kind, off) => {
    const T = MP.battle.TIERS[tier], base = off < 0 ? T.lo + off : off > 0 ? T.hi + off : T.lo + 1 + Math.floor(Math.random() * (T.hi - T.lo - 1));
    const slots0 = petSlots, cls0 = G.cls;
    SIM.ids = Array.from({ length: n }, (_, i) => 'p' + i);
    const teams = SIM.ids.map(id => ({ id, team: SIM.team(tier, clamp(base, 1, PET_MAX_LVL)) }));
    petSlots = slots0; G.cls = cls0;
    const theme = pick(T.themes), enc = kind === 'wild' ? { kind, tier, theme, comp: pick(['pack', 'mixed', 'mixed', 'wall', 'hex', 'healer', 'venom']) } : { kind, tier };
    if (!MP.battle._begin(enc, teams, [], 0, { auto: true, fast: true, quiet: true })) throw new Error('battle did not start');
    let guard = 0; const C = B.coop;
    while (B && B.coop && B.phase !== 'won' && B.phase !== 'lost' && guard++ < 20000) MP.battle.step(1);
    if (!B || !B.coop || guard >= 20000) throw new Error('battle stuck: ' + (B && B.phase) + ' turn ' + (B && B.turn));
    const r = { won: B.phase === 'won', rounds: B.turn, down: B.allies.filter(u => u.fainted).length / B.allies.length, rp: C.rphase, foes: B.foes.length };
    MP.battle.abort('');
    return r;
  };
  SIM.run = (tier, n, kind, off, N) => { let w = 0, r = 0, d = 0, rw = 0; for (let i = 0; i < N; i++) { const x = SIM.one(tier, n, kind, off); if (x.won) { w++; rw += x.rounds; } r += x.rounds; d += x.down; }
    return { win: w / N, rounds: r / N, roundsWon: w ? rw / w : 0, down: d / N }; };
  globalThis.SIM = SIM;
`);
module.exports = { g };
if (require.main !== module) return;
const out = [], say = s => { out.push(s); console.log(s); };
const pct = x => (x * 100).toFixed(0).padStart(3) + '%', f1 = x => x.toFixed(1).padStart(5);
say(`Co-op battle simulation: ${N} battles per cell (win rate / average rounds / share of the party's pets down at the end)`);
say('scale table:'); for (let n = 1; n <= 4; n++) say(`  ${n}p ` + JSON.stringify(g.run(`MP.battle.SCALE[${n}]`)));
say('tiers:'); for (let t = 1; t <= 4; t++) say('  T' + t + ' ' + JSON.stringify(g.run(`(t => ({ name: t.name, lo: t.lo, hi: t.hi, wild: t.wildMul, boss: t.bossMul, raid: t.raidMul }))(MP.battle.TIERS[${t}])`)));
const t0 = Date.now();
for (const off of offs) {
  say(''); say(off === 0 ? '== party AT LEVEL (inside the tier band, full HP) ==' : off < 0 ? `== party ${-off} levels UNDER the band ==` : `== party ${off} levels OVER the band ==`);
  say('tier kind  | ' + sizes.map(n => `${n} player${n > 1 ? 's' : ' '}          `).join('| '));
  for (const tier of tiers) for (const kind of kinds) {
    const cells = sizes.map(n => { const r = g.run(`SIM.run(${tier}, ${n}, '${kind}', ${off}, ${N})`); return `${pct(r.win)} ${f1(r.rounds)}r ${pct(r.down)} dn `; });
    say(`T${tier}   ${kind.padEnd(5)} | ` + cells.join('| '));
  }
}
say(''); say(`(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
if (arg('out')) fs.writeFileSync(path.resolve(arg('out')), out.join('\n') + '\n');
