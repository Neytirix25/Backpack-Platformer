// Tests of Gold and the mission board (mp/econ.js): node tools/mp_tests/econ_test.js   (exits non-zero on a failure)
// Every copy of the game reads the time through MP.econ.now, which the tests set (missions are dated in UTC days).
// The co-op payout runs a real MP.coop raid for two players over the in-memory network, on virtual time, with a
// stand-in battle that the test decides (like coop_test.js does when mp/battle.js is missing).
const { bootGame } = require('./boot.js');

let fails = 0, checks = 0; const errors = [];
function ok(cond, what) { checks++; if (!cond) { fails++; console.log('  FAIL: ' + what); } }
function eq(a, b, what) { ok(a === b, `${what} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`); }
const quietConsole = Object.assign(Object.create(console), { error: (...a) => { errors.push(a.map(x => (x && x.stack) || String(x)).join(' ')); }, warn: () => {} });
const DAY = 86400000;

function player(name, opt = {}) {
  const g = bootGame({ name, globals: Object.assign({ console: quietConsole }, opt.globals), storage: opt.storage });
  g.name = name;
  g.J = code => JSON.parse(g.run(`JSON.stringify(${code})`) || 'null');
  g.frame = () => { g.win.__now += 1000 / 60; g.run(`VIEW.legacy = VIEW.portrait && !portraitReady(); if (VIEW.portrait && !VIEW.legacy) { W = 540; H = portraitWorldOnly() ? 540 : VIEW.h; } else { W = 960; H = 540; } update(1 / 60); draw(); pressed = {};`); };
  g.setPortrait = (on, vh = 900) => { g.run(`VIEW.portrait = ${!!on}; VIEW.w = ${on ? 540 : 960}; VIEW.h = ${on ? vh : 540}; if (VIEW.portrait) { W = 540; H = portraitWorldOnly() ? 540 : VIEW.h; } else { W = 960; H = 540; }`); };
  g.tap = k => { g.press(k); g.frame(); g.release(k); };
  g.clickAt = (x, y, btn = 0) => g.run(`mouse.x = ${x}; mouse.y = ${y}; onMouseDown(${btn}); onMouseUp(${btn});`);
  g.btn = (id, arg) => g.J(`MP.econ._.buttons().find(b => b.id === ${JSON.stringify(id)} && ${arg === undefined ? 'true' : 'b.arg === ' + JSON.stringify(arg)}) || null`);
  g.clickBtn = (id, arg) => { const b = g.btn(id, arg); if (!b) return false; g.clickAt(b.r.x + b.r.w / 2, b.r.y + b.r.h / 2); return true; };
  g.cell = i => g.J(`MP.econ._.gridLayout().rect(${i})`);
  g.clickCell = i => { const r = g.cell(i); g.clickAt(r.x + r.w / 2, r.y + r.h / 2); };
  g.view = () => g.run('MP.econ._.V().view');
  g.gold = () => g.run('MP.econ.gold()');
  g.day = d => g.run(`MP.econ.now = () => ${d} * ${DAY} + 3600000`);
  g.missions = () => g.J('MP.econ.missions()');
  // test helpers that live inside the game: T.findDay(from, pred) -> the first day whose missions satisfy pred(list)
  g.run(`var T = {
    findDay(from, pred, span = 4000) { for (let d = from; d < from + span; d++) { const l = MP.econ._.daily(d).concat(MP.econ._.weekly(MP.econ._.weekOf(d))); if (pred(l)) return d; } return -1; },
    fish(k) { return bagAdd('fish', makeItem('fish_' + k)); },
    dish(k, q) { const it = makeItem('dish_' + k); if (q != null) it.q = q; return bagAdd('pantry', it); },
    pet(k, lvl, nick, o) { const it = unlockPet(k, lvl, rollGenes(Object.assign({ shiny: false }, o))); if (nick) it.nick = nick; savePets(); return it.pid; },
    bag(kind) { return bagItems(kind).map(it => it.def.fish || it.def.dish); },
    inside() { return MP.econ._.buttons().every(b => b.r.x >= 0 && b.r.x + b.r.w <= W + 0.5 && b.r.y >= 0 && b.r.y + b.r.h <= H + 0.5); },
  };`);
  g.play = () => g.run(`G.mode = 'play'; G.fade = 0;`);   /* (skip the fade-in: keys only work once the room is up) */
  if (!opt.noHub) { g.run('enterHub()'); g.frame(); g.giveTeam(opt.team || ['dog', 'fox', 'owl'], opt.lv || 10); g.play(); g.frame(); }
  return g;
}

async function main() {
  const A = player('Mira'), B = player('Tom');
  const KEY = A.run('MP.econ._.KEY()');

  console.log('1. the core: gold, add, spend, owns, grant, the log, saving');
  eq(A.gold(), 0, 'a new player has no Gold');
  eq(A.run(`MP.econ.add(25, 'test')`), 25, 'add returns what was added'); eq(A.gold(), 25, '25 Gold');
  eq(A.run('MP.econ._.toasts.length'), 1, 'a "+25 Gold" toast is queued');
  for (const bad of ['-5', 'NaN', '"7"', 'null', 'undefined', '{}', 'Infinity', '0']) eq(A.run(`MP.econ.add(${bad}, 'bad')`), 0, `add(${bad}) adds nothing`);
  eq(A.gold(), 25, 'still 25 Gold');
  eq(A.run(`MP.econ.add(12.9, 'frac')`), 12, 'a fraction is floored'); eq(A.gold(), 37, '37 Gold');
  eq(A.run(`MP.econ.spend(100, 'too much')`), false, 'spend more than you have: false'); eq(A.gold(), 37, 'nothing taken');
  for (const bad of ['-1', 'NaN', '"5"', 'null', 'undefined', 'Infinity']) eq(A.run(`MP.econ.spend(${bad}, 'bad')`), false, `spend(${bad}) is refused`);
  eq(A.run(`MP.econ.spend(30, 'hat')`), true, 'spend 30'); eq(A.gold(), 7, '7 Gold left');
  eq(A.run('MP.econ.data.earned'), 37, 'lifetime earned'); eq(A.run('MP.econ.data.spent'), 30, 'lifetime spent');
  eq(JSON.parse(A.store[KEY]).gold, 7, 'saved under packrat_econ');
  eq(A.run(`MP.econ.owns('wing:demon')`), false, 'owns nothing yet'); eq(A.run(`MP.econ.grant('wing:demon')`), true, 'grant'); eq(A.run(`MP.econ.owns('wing:demon')`), true, 'owned now');
  eq(A.run(`MP.econ.grant('dye:top:knight:crimson')`), true, 'a longer id'); eq(JSON.parse(A.store[KEY]).own['dye:top:knight:crimson'], 1, 'saved');
  for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) eq(A.run(`MP.econ.owns(${JSON.stringify(id)})`), false, `owns('${id}') is false`);
  for (const bad of ['"__proto__"', '""', '"a b"', '"<x>"', '5', 'null', '"x".repeat(60)']) eq(A.run(`MP.econ.grant(${bad})`), false, `grant(${bad}) is refused`);
  A.run(`for (let i = 0; i < 50; i++) MP.econ.add(1, 'line ' + i)`);
  eq(A.run('MP.econ.data.log.length'), 30, 'the log keeps the last 30 movements'); eq(A.run('MP.econ.data.log[29].w'), 'line 49', 'newest last');
  eq(A.run('MP.econ._.toasts.length <= 6'), true, 'toasts are capped');
  A.run(`MP.econ.add(1e12, 'huge')`); eq(A.gold(), 9999999, 'the purse is capped at 9,999,999');
  eq(A.run(`MP.econ.add(5, 'over')`), 0, 'a full purse takes no more');
  A.run(`MP.econ.spend(9999999, 'reset')`); eq(A.gold(), 0, 'emptied');
  // a change tells the account sync (like saveData), except while the save is being read for an upload
  A.run(`var __acc = 0; accChanged = () => { __acc++; };`);
  A.run(`MP.econ.add(3, 'sync')`); eq(A.run('__acc'), 1, 'a change marks the cloud copy as stale (accChanged)');
  A.run(`accQuiet++; MP.econ.save(); accQuiet--;`); eq(A.run('__acc'), 1, 'quiet while the save is read for an upload');
  A.run(`MP.econ.spend(3, 'sync')`);

  console.log('2. hostile saved data is cleaned on load');
  const SHAPE = 'ah,earned,gold,log,mis,own,spent,v';
  const hostile = ['not json', '', '[]', 'null', '42', '"str"', '{"gold":-5}', '{"gold":"999"}', '{"gold":1e99}', '{"gold":12.7,"earned":-1,"spent":"x"}', '{"gold":null,"own":[1,2],"mis":"x","ah":7,"log":{}}',
    '{"gold":5,"evil":{"a":1},"v":99,"own":{"wing:demon":1,"bad id":1,"<script>":1,"ok_id":0,"__proto__":{"x":1},"constructor":1}}', '{"__proto__":{"gold":777,"polluted":1},"gold":3}',
    JSON.stringify({ gold: 10, own: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ['id' + i, 1])) }),
    JSON.stringify({ gold: 10, ah: { big: 'x'.repeat(100000) } }), JSON.stringify({ gold: 10, ah: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } }, list: Array.from({ length: 999 }, (_, i) => i), n: 1e400 } }),
    JSON.stringify({ gold: 10, log: Array.from({ length: 500 }, (_, i) => ({ t: 'x', n: 1e99, w: 'y'.repeat(999), extra: i })).concat([null, 5, 'x']) }),
    JSON.stringify({ gold: 10, mis: { d20000: { 0: { p: [1e9, -3, 'x', 4, 5, 6], done: 'yes' }, 9: { p: [1] }, x: 1 }, 'd-1': {}, w1: 'x', evil: { 0: { p: [1] } }, d99999999999: {}, w3000: { 0: { p: 'x', done: 0 } } } }),
    JSON.stringify({ gold: 10, mis: Object.fromEntries(Array.from({ length: 300 }, (_, i) => ['d' + (20000 + i), { 0: { p: [1], done: 1 } }])) })];
  for (const h of hostile) {
    A.store[KEY] = h; A.run('MP.econ.load()');
    const d = A.J('MP.econ.data'), what = h.slice(0, 50);
    eq(Object.keys(d).sort().join(','), SHAPE, `only the known fields after loading ${what}`);
    ok(Number.isInteger(d.gold) && d.gold >= 0 && d.gold <= 9999999 && Number.isInteger(d.earned) && d.earned >= 0 && Number.isInteger(d.spent) && d.spent >= 0 && d.v === 1, `integers in range after ${what}`);
    ok(Object.keys(d.own).length <= 600 && Object.keys(d.own).every(k => /^[a-z0-9][a-z0-9:_.-]{0,47}$/i.test(k) && d.own[k] === 1), `own holds only sane ids after ${what}`);
    ok(Array.isArray(d.log) && d.log.length <= 30 && d.log.every(l => Number.isInteger(l.t) && Number.isInteger(l.n) && typeof l.w === 'string' && l.w.length <= 40 && Object.keys(l).length === 3), `a clean log after ${what}`);
    ok(Object.keys(d.mis).length <= 12 && Object.keys(d.mis).every(k => /^[dw]\d{1,7}$/.test(k) && Object.keys(d.mis[k]).every(i => /^[0-3]$/.test(i) && d.mis[k][i].p.length <= 3 && d.mis[k][i].p.every(n => Number.isInteger(n) && n >= 0 && n <= 99) && (d.mis[k][i].done === 0 || d.mis[k][i].done === 1))), `clean mission progress after ${what}`);
    ok(JSON.stringify(d.ah).length <= 60000, `the auction state is size-capped after ${what}`);
    eq(A.run('({}).polluted === undefined && ({}).x === undefined && ({}).gold === undefined'), true, `no prototype pollution after ${what}`);
    eq(A.run(`MP.econ.owns('constructor') || MP.econ.owns('__proto__')`), false, `no fake ownership after ${what}`);
    A.frame();
  }
  A.store[KEY] = '{"gold":"999"}'; A.run('MP.econ.load()'); eq(A.gold(), 0, 'a text amount is not Gold');
  A.store[KEY] = '{"gold":12.7}'; A.run('MP.econ.load()'); eq(A.gold(), 12, 'a fraction is floored');
  A.store[KEY] = '{"gold":1e99}'; A.run('MP.econ.load()'); eq(A.gold(), 9999999, 'a huge amount is clamped');
  A.store[KEY] = hostile[11]; A.run('MP.econ.load()'); eq(A.run(`MP.econ.owns('wing:demon')`), true, 'a good id among bad ones is kept');
  A.store[KEY] = JSON.stringify({ gold: 4, ah: { mine: ['a1', 'b2'], escrow: [{ k: 'fox', lvl: 5, g: { atk: 50 } }] } }); A.run('MP.econ.load()');
  eq(A.run('JSON.stringify(MP.econ.data.ah)'), JSON.stringify({ mine: ['a1', 'b2'], escrow: [{ k: 'fox', lvl: 5, g: { atk: 50 } }] }), "the auction module's plain data passes through unchanged");
  delete A.store[KEY]; A.run('MP.econ.load()'); eq(A.gold(), 0, 'no saved value = a fresh object'); eq(Object.keys(A.J('MP.econ.data')).sort().join(','), SHAPE, 'fresh shape');

  console.log('3. Gold travels with save files and cloud saves');
  ok(A.run(`SAVE_KEYS.includes('packrat_econ')`), 'packrat_econ is in SAVE_KEYS');
  A.run(`MP.econ.add(77, 'before export'); MP.econ.grant('hc:pink')`);
  const text = A.run('saveFileText()');
  ok(/packrat_econ/.test(text), 'the save file carries the economy data');
  A.run(`MP.econ.spend(50, 'after export')`); eq(A.gold(), 27, 'spent after the export');
  A.win.__save = text;
  eq(A.run(`(() => { const c = saveFileCheck(__save); if (!c.ok) return c.why; saveFileApply(c.data); return 'ok'; })()`), 'ok', 'the save file imports');
  eq(A.gold(), 77, 'the import brings the exported Gold back (MP.econ.load after saveFileApply)'); eq(A.run(`MP.econ.owns('hc:pink')`), true, 'and the cosmetics');
  const kept = A.store[KEY]; A.run(`MP.econ.add(500, 'while locked')`);
  eq(A.store[KEY], kept, 'the old game never saves over an imported save (SAVE_LOCK)');
  B.win.__save = text; B.run(`MP.econ.add(5, 'own')`);
  eq(B.run(`(() => { const c = saveFileCheck(__save); if (!c.ok) return c.why; saveFileApply(c.data); return 'ok'; })()`), 'ok', 'another copy of the game imports it');
  eq(B.gold(), 77, 'the other copy has the Gold now');
  const B2 = player('Tom2', { storage: B.store });
  eq(B2.gold(), 77, 'and still has it after the restart'); eq(B2.run(`MP.econ.owns('hc:pink')`), true, 'with the cosmetics');
  B2.run(`MP.econ.add(1, 'x')`); const h1 = B2.run('dataHash(saveFileData())'); B2.run(`MP.econ.add(1, 'x')`);
  ok(h1 !== B2.run('dataHash(saveFileData())'), 'a Gold change changes the hash the cloud sync compares');
  // a save file from before Gold existed: importing it leaves no Gold behind
  const C0 = player('Old'); C0.run(`MP.econ.add(40, 'x')`);
  C0.run(`(() => { const d = saveFileData(); delete d.packrat_econ; saveFileApply(d); })()`); eq(C0.gold(), 0, 'a save without economy data imports as no Gold');

  console.log('4. the same date gives everyone the same missions');
  const P = player('Ana'), Q = player('Kofi', { team: ['boar', 'toad', 'cockatiel'], lv: 25 });
  const D0 = 20773;   /* 2026-11-16, a Monday */
  eq(new Date(D0 * DAY).toISOString().slice(0, 10), '2026-11-16', 'the test day'); eq(new Date(D0 * DAY).getUTCDay(), 1, 'is a Monday');
  P.day(D0); Q.run(`MP.econ.now = () => ${D0} * ${DAY} + 80000000`);
  const m1 = JSON.stringify(P.missions()), m2 = JSON.stringify(Q.missions());
  eq(m1, m2, 'two copies (different players, different hours of the day) see the same missions');
  eq(P.missions().length, 4, '3 dailies + 1 weekly'); eq(P.missions().filter(m => m.weekly).length, 1, 'one weekly'); eq(P.missions().map(m => m.id).join(','), `d${D0},d${D0},d${D0},w${P.run(`MP.econ._.weekOf(${D0})`)}`, 'ids from the day and the week');
  P.day(D0 + 1);
  ok(JSON.stringify(P.missions().slice(0, 3)) !== JSON.stringify(JSON.parse(m1).slice(0, 3)), 'another day: other dailies');
  eq(JSON.stringify(P.missions()[3]), JSON.stringify(JSON.parse(m1)[3]), 'the weekly stays all week');
  P.day(D0 + 6); eq(JSON.stringify(P.missions()[3]), JSON.stringify(JSON.parse(m1)[3]), 'still the same weekly on Sunday');
  P.day(D0 + 7); ok(P.missions()[3].id !== JSON.parse(m1)[3].id, 'a new weekly on the next Monday');
  P.day(D0 - 1); ok(P.missions()[3].id !== JSON.parse(m1)[3].id, 'and another one the Sunday before');
  P.run(`MP.econ.now = () => ${D0} * ${DAY} + ${DAY} - 61000`); eq(P.run('MP.econ._.timeLeft(MP.econ._.msLeft(false))'), '1m 1s', 'time left until the daily reset');
  eq(P.run('MP.econ._.timeLeft(MP.econ._.msLeft(true))'), '6d 0h', 'time left until the weekly reset');
  const dump = P.J(`[0, 1, 2, 3, 4, 5, 6].map(i => MP.econ._.daily(${D0} + i).map(m => m.parts.map(MP.econ._.partText).join(' + ') + ' = ' + m.reward))`);
  dump.forEach((d, i) => console.log('     day +' + i + ': ' + d.join('  |  ')));
  console.log('     weekly: ' + P.J(`[0, 7, 14, 21].map(i => { const m = MP.econ._.weekly(MP.econ._.weekOf(${D0} + i)); return m.parts.map(MP.econ._.partText).join(' + ') + ' = ' + m.reward; })`).join('  |  '));

  console.log('5. 400 consecutive days: every mission is valid and achievable in principle');
  const rep = P.J(`(() => {
    const _ = MP.econ._, pool = _.pool(), bad = [], kinds = {}, st = { pets: 0, act1: 0, fish: 0, easyFish: 0, lo: 1e9, hi: 0, wlo: 1e9, whi: 0 };
    const tiers = k => FISH_TIER[FISH[k].rarity];
    function part(p, m, weekly) {
      const why = s => bad.push(m.id + '/' + m.i + ': ' + s + ' ' + JSON.stringify(p));
      const kind = p.t + ':' + (p.sp ? 'species' : p.fam ? 'family' : p.role ? 'role' : p.eq != null ? 'exact' : p.min != null ? 'min' : 'act') + (p.sex ? '+sex' : '') + (p.lv ? '+lv' : '');
      kinds[kind] = (kinds[kind] || 0) + 1;
      if (!Number.isInteger(p.n) || p.n < 1 || p.n > 8) why('count');
      if ('shiny' in p) why('asks for a shiny');
      const txt = _.partText(p); if (typeof txt !== 'string' || !txt || /undefined|NaN|null/.test(txt) || txt.length > 90) why('text: ' + txt);
      if (p.t === 'fish' || p.t === 'dish') {
        if (p.t === 'dish' && p.sp) why('dish species');
        if (p.sp && !FISH[p.sp]) why('unknown fish');
        const can = FISH_IDS.filter(k => { const it = makeItem((p.t === 'dish' ? 'dish_' : 'fish_') + k); return _.fishOk(p, it); });
        if (!can.length) why('no fish can satisfy it');
        if (p.n > 35) why('more than a bag holds');
        if (p.t === 'fish') { const any = FISH_IDS.filter(k => _.fishOk(p, makeItem('dish_' + k))); if (any.length) why('a cooked dish counts as a fish'); }
        if (!weekly && p.t === 'fish') { st.fish++; if (can.some(k => tiers(k) === 0)) st.easyFish++; if (Math.min(...can.map(tiers)) > 2) why('a daily asks for an epic fish'); }
      } else if (p.t === 'pet') {
        if (p.sp && (!PETS[p.sp] || !BS[p.sp] || _.SPECIAL.includes(p.sp) || !pool.includes(p.sp))) why('a species that must not be asked for');
        const can = pool.filter(k => _.petOk(p, { def: { pet: k }, plvl: 40, g: { sex: p.sex || 'm' } }));
        if (!can.length) why('no ordinary species can satisfy it');
        if (p.lv && (p.lv < 1 || p.lv > (weekly ? 12 : 8))) why('level asked');
        if (p.sex && p.sex !== 'm' && p.sex !== 'f') why('sex');
        if (p.act && !(p.act >= 1 && p.act <= 4)) why('act');
        if (!weekly) { st.pets++; if (can.some(k => speciesAct(k) === 1)) st.act1++; if (p.act > 2 || (p.sp && speciesAct(p.sp) > 2)) why('a daily asks for an Act III+ animal'); }
      } else why('unknown kind');
    }
    const B = _.BOUNDS, seen = new Set();
    for (let d = ${D0}; d < ${D0} + 400; d++) {
      const day = _.daily(d), wk = _.weekly(_.weekOf(d));
      if (day.length !== 3) bad.push('d' + d + ': not 3 dailies');
      let sum = 0;
      day.forEach((m, i) => {
        if (m.id !== 'd' + d || m.i !== i || m.weekly || m.parts.length !== 1 || !m.title) bad.push('d' + d + ': shape');
        if (!Number.isInteger(m.reward) || m.reward < B.DAILY_LO || m.reward > B.DAILY_HI) bad.push('d' + d + ': reward ' + m.reward);
        sum += m.reward; st.lo = Math.min(st.lo, m.reward); st.hi = Math.max(st.hi, m.reward);
        m.parts.forEach(p => part(p, m, false));
      });
      if (sum !== B.DAILY_SUM) bad.push('d' + d + ': the three pay ' + sum);
      if (new Set(day.map(m => m.parts.map(_.partText).join())).size !== 3) bad.push('d' + d + ': two dailies ask for the same thing');
      if (new Set(day.map(m => m.title)).size !== 3) bad.push('d' + d + ': two dailies share a title');
      if (!wk.weekly || wk.id !== 'w' + _.weekOf(d) || wk.i !== 0 || !wk.title || wk.parts.length < 1 || wk.parts.length > 3) bad.push('w: shape');
      if (!Number.isInteger(wk.reward) || wk.reward < B.WEEKLY_LO || wk.reward > B.WEEKLY_HI) bad.push('w: reward ' + wk.reward);
      st.wlo = Math.min(st.wlo, wk.reward); st.whi = Math.max(st.whi, wk.reward);
      if (!seen.has(wk.id)) { seen.add(wk.id); wk.parts.forEach(p => part(p, wk, true)); }
      if (JSON.stringify(day) !== JSON.stringify(_.daily(d))) bad.push('d' + d + ': not deterministic');
    }
    return { bad: bad.slice(0, 12), nbad: bad.length, kinds, st, weeks: seen.size };
  })()`);
  eq(rep.nbad, 0, 'no invalid mission in 400 days' + (rep.nbad ? ': ' + rep.bad.join(' ;; ') : ''));
  ok(rep.st.act1 / rep.st.pets >= 0.75, `Act I animals dominate the dailies (${rep.st.act1}/${rep.st.pets})`);
  ok(rep.st.easyFish / rep.st.fish >= 0.55, `common fish dominate the dailies (${rep.st.easyFish}/${rep.st.fish})`);
  ok(Object.keys(rep.kinds).length >= 10, 'a good variety of mission kinds');
  console.log(`     dailies pay ${rep.st.lo}-${rep.st.hi} each (120 a day), weeklies ${rep.st.wlo}-${rep.st.whi}; ${rep.weeks} weeks; kinds:`, JSON.stringify(rep.kinds));

  console.log('6. turning in fish');
  const F = player('Fisher');
  const dF = F.run(`T.findDay(${D0}, l => l[0].parts[0].t === 'fish' && l[0].parts[0].min === 1 && l[0].parts[0].n === 3)`);
  ok(dF > 0, 'found a day asking for 3 fish of at least Uncommon rarity'); F.day(dF);
  eq(F.run('MP.econ._.partText(MP.econ.missions()[0].parts[0])'), '3 uncooked fish of at least Uncommon rarity', 'its text says uncooked');
  const rewF = F.missions()[0].reward;
  F.run(`MP.stations.mp_missions()`); eq(F.run('G.panel'), 'mpmissions', 'the board opens'); F.frame();
  eq(F.btn('turn', 0).off, true, 'nothing to turn in yet: the button is off');
  F.clickBtn('turn', 0); eq(F.view(), 'list', 'clicking it only explains'); ok(/Fish Bag/.test(F.run('G.msg')), 'with a hint about the Fish Bag');
  F.run(`T.fish('minnow'); T.fish('perch'); T.fish('minnow'); T.fish('pike'); T.dish('perch'); T.dish('carp', 3)`); F.frame();
  eq(F.btn('turn', 0).off, false, 'with fish in the bag the button is on');
  F.clickBtn('turn', 0); eq(F.view(), 'fish', 'the fish picker opens'); F.frame();
  eq(F.J('MP.econ._.gridLayout().items.map(e => e.it.def.fish)').join(','), 'perch,pike', 'only the eligible fish are offered (no Minnow, no cooked dish)');
  eq(F.btn('give').off, true, 'nothing picked: Give is off');
  F.clickCell(0); eq(F.J('MP.econ._.V().sel').length, 1, 'a click picks a fish'); F.clickCell(0); eq(F.J('MP.econ._.V().sel').length, 0, 'another click puts it back');
  F.clickCell(0); F.clickCell(1); F.frame(); eq(F.btn('give').txt, 'Give 2', 'two picked');
  F.clickBtn('give'); F.frame();
  eq(F.run(`T.bag('fish').join(',')`), 'minnow,minnow', 'the two fish left the bag; the Minnows stayed'); eq(F.run(`T.bag('pantry').join(',')`), 'perch,carp', 'the dishes were not touched');
  eq(F.run('MP.econ._.prog(MP.econ.missions()[0], 0)'), 2, '2 of 3 delivered'); eq(F.gold(), 0, 'no Gold for a part delivery');
  eq(JSON.parse(F.store[F.run('MP.econ._.KEY()')]).mis['d' + dF][0].p[0], 2, 'the partial progress is saved');
  eq(F.view(), 'fish', 'the picker stays for the rest'); eq(F.run('MP.econ._.gridLayout().items.length'), 0, 'nothing eligible is left'); F.frame();
  F.clickBtn('back'); eq(F.view(), 'list', 'back to the list');
  F.run(`MP.econ.load(); T.fish('carp'); T.fish('sunfish'); T.fish('eel')`); eq(F.run('MP.econ._.prog(MP.econ.missions()[0], 0)'), 2, 'still 2 of 3 after loading again');
  F.clickBtn('turn', 0); F.frame(); eq(F.run('MP.econ._.gridLayout().need'), 1, 'one more is needed');
  F.clickCell(0); F.clickCell(1); eq(F.J('MP.econ._.V().sel').length, 1, 'no more than needed can be picked');
  eq(F.run(`MP.econ._.giveFish(MP.econ.missions()[0], 0, [0, 1])`), 0, 'the Minnows are refused even when asked for directly'); eq(F.run(`T.bag('fish').length`), 5, 'the bag is untouched');
  F.clickBtn('give'); F.frame();
  eq(F.gold(), rewF, `the mission pays its ${rewF} Gold`); eq(F.run('MP.econ._.isDone(MP.econ.missions()[0])'), true, 'and is done'); eq(F.view(), 'list', 'back at the list');
  eq(F.run(`T.bag('fish').length`), 4, 'exactly one more fish left the bag');
  eq(F.btn('turn', 0), null, 'a finished mission has no Turn in button');
  eq(F.run(`MP.econ._.giveFish(MP.econ.missions()[0], 0, [2, 3])`), 0, 'it cannot be turned in again'); eq(F.gold(), rewF, 'paid once'); eq(F.run(`T.bag('fish').length`), 4, 'and takes no more fish');
  F.run('MP.econ.load()'); eq(F.run('MP.econ._.isDone(MP.econ.missions()[0])'), true, 'done survives a reload'); eq(F.gold(), rewF, 'so does the Gold');
  ok(F.run('MP.econ.data.log.some(l => l.w === "Daily mission" && l.n === ' + rewF + ')'), 'the log remembers it');
  // a dish mission: dishes from the Sanctuary Bag, never a charred one, never a raw fish
  const dD = F.run(`T.findDay(${D0}, l => l[2].parts[0].t === 'dish' && l[2].parts[0].n === 1)`); ok(dD > 0, 'found a day with a dish mission'); F.day(dD);
  F.run(`saveBag('pantry', []); T.dish('minnow', 0); T.dish('perch', 1)`); const rewD = F.missions()[2].reward, g0 = F.gold();
  F.run('G.panel = null; MP.stations.mp_missions()'); F.frame(); F.clickBtn('turn', 2); F.frame(); eq(F.view(), 'fish', 'the dish picker');
  eq(F.J('MP.econ._.gridLayout().items.map(e => e.it.def.dish + e.it.q)').join(','), 'perch1', 'offers the dish that is not charred, and no raw fish');
  F.clickCell(0); F.tap('Enter'); eq(F.gold(), g0 + rewD, 'Enter gives the picked dish: paid'); eq(F.run(`T.bag('pantry').join(',')`), 'minnow', 'the charred one stays');

  console.log('7. turning in an animal');
  const N = player('Nell');
  const dP = N.run(`T.findDay(${D0}, l => { const p = l[1].parts[0]; return p.t === 'pet' && p.sp === 'fox' && !p.sex && !p.lv; })`); ok(dP > 0, 'found a day asking for a Fox'); N.day(dP);
  const rewP = N.missions()[1].reward;
  N.run('MP.stations.mp_missions()'); N.frame();
  eq(N.btn('turn', 1).off, false, 'the team Fox counts as an animal like that: the picker will explain');
  const rusty = N.run(`T.pet('fox', 7, 'Rusty', { sex: 'm' })`), blaze = N.run(`T.pet('fox', 4, 'Blaze', { sex: 'f' })`), teamFox = N.run('petSlots[1].pid');
  eq(N.run('HERD.length'), 5, 'three in the team and two more Foxes');
  N.clickBtn('turn', 1); eq(N.view(), 'pet', 'the animal picker opens'); N.frame();
  const order = N.J('MP.econ._.gridLayout().items.map(it => it.pid)');
  eq(order.length, 3, 'every Fox you own is offered'); eq(order.slice().sort().join(), [rusty, blaze, teamFox].sort().join(), 'the three Foxes');
  const iTeam = order.indexOf(teamFox), iRusty = order.indexOf(rusty), iBlaze = order.indexOf(blaze);
  N.clickCell(iTeam); eq(N.view(), 'pet', 'the Fox in the team cannot be picked'); ok(/in your team/.test(N.run('G.msg')), 'and the game says why');
  eq(N.run(`MP.econ._.givePet(MP.econ.missions()[1], 1 - 1, ${JSON.stringify(teamFox)})`), false, 'not even directly'); eq(N.run('HERD.length'), 5, 'nobody left');
  N.run(`SAVE.den = { m: ${JSON.stringify(blaze)} }`); N.frame();
  N.clickCell(iBlaze); eq(N.view(), 'pet', 'a Fox in the Den pair cannot be picked'); ok(/Breeding Den/.test(N.run('G.msg')), 'and the game says why');
  eq(N.run(`MP.econ._.petLock(HERD.find(h => h.pid === ${JSON.stringify(blaze)}))`), 'In the Den', 'giveLock: the Den'); eq(N.run(`MP.econ._.petLock(petSlots[1])`), 'In your team', 'giveLock: the team');
  N.run('SAVE.den = {}');
  N.clickCell(iRusty); eq(N.view(), 'confirm', 'picking Rusty asks first'); N.frame();
  eq(N.run('MP.econ._.V().pid'), rusty, 'the chosen one');
  N.clickBtn('no'); eq(N.view(), 'pet', 'No: back to the picker'); eq(N.run('HERD.length'), 5, 'nobody left');
  N.clickCell(iRusty); N.frame(); N.clickBtn('yes'); N.frame();
  eq(N.run(`HERD.some(h => h.pid === ${JSON.stringify(rusty)})`), false, 'Rusty went to the mission board');
  eq(N.run(`HERD.some(h => h.pid === ${JSON.stringify(blaze)})`), true, 'Blaze, the other Fox, stayed'); eq(N.run(`petSlots[1] && petSlots[1].pid`), teamFox, 'the team is untouched');
  eq(N.run('HERD.length'), 4, 'one animal fewer'); eq(N.J('SAVE.herd.map(h => h.pid)').includes(rusty), false, 'saved without Rusty (savePets)'); eq(N.J('SAVE.herd').length, 4, 'the saved herd');
  eq(N.gold(), rewP, `the mission pays its ${rewP} Gold`); eq(N.view(), 'list', 'back at the list'); eq(N.run('MP.econ._.isDone(MP.econ.missions()[1])'), true, 'done');
  const xp = N.J('petSlots.map(it => it.xp + ":" + it.plvl)').join();
  eq(N.run(`MP.econ._.givePet(MP.econ.missions()[1], 0, ${JSON.stringify(blaze)})`), false, 'a finished mission takes no second Fox'); eq(N.run('HERD.length'), 4, 'Blaze is still here'); eq(N.gold(), rewP, 'paid once');
  eq(N.J('petSlots.map(it => it.xp + ":" + it.plvl)').join(), xp, 'no donate experience is shared');
  // an animal that does not fit, an unknown one
  N.day(dP + 0); eq(N.run(`MP.econ._.petOk(MP.econ.missions()[1].parts[0], petSlots[0])`), false, 'a Shepherd is not a Fox');
  // the last animal can never go
  const L1 = player('Lone', { noHub: true }); L1.run('enterHub()'); L1.frame(); L1.play(); L1.run(`T.pet('fox', 5); petSlots = [null, null, null];`); L1.day(dP);
  eq(L1.run('HERD.length'), 1, 'one animal only'); eq(L1.run('MP.econ._.petLock(HERD[0])'), 'Your last animal', 'the last animal is locked');
  eq(L1.run(`MP.econ._.givePet(MP.econ.missions()[1], 0, HERD[0].pid)`), false, 'and cannot be turned in'); eq(L1.run('HERD.length'), 1, 'it stays');
  L1.run('MP.stations.mp_missions()'); L1.frame(); L1.clickBtn('turn', 1); L1.frame(); L1.clickCell(0); eq(L1.view(), 'pet', 'the picker refuses it too'); ok(/last animal/.test(L1.run('G.msg')), 'and says why');
  // a shiny needs a second confirmation
  const dS = N.run(`T.findDay(${dP} + 1, l => { const p = l[1].parts[0]; return p.t === 'pet' && p.sp === 'fox' && !p.sex && !p.lv; })`); N.day(dS);
  const goldie = N.run(`T.pet('fox', 9, 'Goldie', { shiny: true })`), gS = N.gold(), rewS = N.missions()[1].reward;
  N.run('G.panel = null; MP.stations.mp_missions()'); N.frame(); N.clickBtn('turn', 1); N.frame();
  const iG = N.J('MP.econ._.gridLayout().items.map(it => it.pid)').indexOf(goldie);
  N.clickCell(iG); eq(N.view(), 'confirm', 'a shiny: the first question'); N.frame(); const yes1 = N.btn('yes').r; N.clickBtn('yes'); eq(N.view(), 'shiny', 'Yes leads to a second question'); N.frame();
  ok(N.btn('yes').r.x !== yes1.x, 'the second Yes is not under the first (a double click cannot answer both)');
  eq(N.run(`HERD.some(h => h.pid === ${JSON.stringify(goldie)})`), true, 'the shiny is still here'); eq(N.gold(), gS, 'nothing paid yet');
  N.clickBtn('no'); eq(N.view(), 'pet', 'No at the second question keeps it'); eq(N.run(`HERD.some(h => h.pid === ${JSON.stringify(goldie)})`), true, 'still here');
  N.clickCell(iG); N.frame(); N.tap('Enter'); eq(N.view(), 'shiny', 'by keyboard: Enter asks again'); N.tap('Escape'); eq(N.view(), 'pet', 'Escape backs out');
  N.clickCell(iG); N.clickBtn('yes'); N.frame(); N.clickBtn('yes'); N.frame();
  eq(N.run(`HERD.some(h => h.pid === ${JSON.stringify(goldie)})`), false, 'two Yes: the shiny is given'); eq(N.gold(), gS + rewS, 'and paid for');
  // several animals: partial progress is saved
  const W1 = player('Wes');
  const dW = W1.run(`T.findDay(${D0}, l => { const p = l[3].parts[0]; return l[3].parts.length === 1 && p.t === 'pet' && p.n === 3 && p.fam === 'canine' && !p.lv; })`); ok(dW > 0, 'found a week asking for 3 Canines'); W1.day(dW);
  const rewW = W1.missions()[3].reward; W1.run(`T.pet('fox', 3, 'One'); T.pet('dog', 3, 'Two'); T.pet('fox', 3, 'Three'); T.pet('catgray', 3, 'Cat')`);
  W1.run('MP.stations.mp_missions()'); W1.frame(); W1.clickBtn('turn', 3); W1.frame();
  eq(W1.run('MP.econ._.gridLayout().items.length'), 5, 'the five Canines are offered (two of them in the team), not the Cat');
  const free = () => W1.J('MP.econ._.gridLayout().items.map(it => MP.econ._.petLock(it))').indexOf(null);
  W1.clickCell(free()); W1.clickBtn('yes'); W1.frame(); W1.clickCell(free()); W1.clickBtn('yes'); W1.frame();
  eq(W1.run('MP.econ._.prog(MP.econ.missions()[3], 0)'), 2, '2 of 3 animals delivered'); eq(W1.gold(), 0, 'not paid yet'); eq(W1.view(), 'pet', 'the picker stays open for the third');
  const W2 = player('Wes2', { storage: W1.store, noHub: true }); W2.day(dW); W2.run('enterHub()'); W2.frame(); W2.play();
  eq(W2.run('MP.econ._.prog(MP.econ.missions()[3], 0)'), 2, 'after a restart: still 2 of 3'); eq(W2.run('HERD.length'), 5, 'and the two animals are gone for good');
  W1.clickCell(free()); W1.clickBtn('yes'); W1.frame();
  eq(W1.gold(), rewW, `the weekly pays its ${rewW} Gold`); eq(W1.view(), 'list', 'done: back at the list'); eq(W1.run('HERD.length'), 4, 'the team and the Cat remain');
  ok(W1.run('MP.econ.data.log.some(l => l.w === "Weekly mission")'), 'logged as a weekly mission');
  // the keyboard: down to the line, Enter, pick with Enter, confirm with Enter
  const K = player('Kay'); K.day(dP); K.run(`T.pet('fox', 2, 'Kit')`); K.run('MP.stations.mp_missions()'); K.frame();
  K.tap('ArrowDown'); eq(K.run('MP.econ._.V().cur'), 1, 'Down moves to the second mission'); K.tap('Enter'); eq(K.view(), 'pet', 'Enter opens its picker');
  const ik = K.J('MP.econ._.gridLayout().items.map(it => MP.econ._.petLock(it))').indexOf(null);
  for (let i = 0; i < ik; i++) K.tap('ArrowRight');
  K.tap('Enter'); eq(K.view(), 'confirm', 'Enter picks the animal'); K.tap('Enter'); eq(K.view(), 'list', 'Enter confirms'); eq(K.gold(), rewP, 'paid');
  K.tap('Escape'); eq(K.run('G.panel'), null, 'Escape closes the board');
  K.run('MP.stations.mp_missions()'); K.frame(); K.clickAt(5, 5); eq(K.run('G.panel'), null, 'a click outside closes it');
  K.run('MP.stations.mp_missions()'); K.frame(); K.clickAt(480, 270, 2); eq(K.run('G.panel'), null, 'a right click closes it');

  console.log('8. daily and weekly rollover');
  const R = player('Rolo'); R.day(dF); R.run(`for (const k of ['perch', 'carp', 'pike', 'perch']) T.fish(k)`);
  eq(R.run(`MP.econ._.giveFish(MP.econ.missions()[0], 0, [0, 1, 2])`), 3, 'day one: mission 0 delivered'); const gR = R.gold(); ok(gR > 0, 'and paid');
  const old = R.missions()[0]; R.win.__old = old;
  R.day(dF + 1);
  eq(R.run('MP.econ._.isDone(MP.econ.missions()[0])'), false, 'the next day: mission 0 is a new one, not done');
  eq(R.run(`MP.econ._.giveFish(__old, 0, [0])`), 0, "yesterday's mission can no longer be turned in");
  ok(R.run(`!!MP.econ.data.mis['d${dF}']`), "yesterday's progress is still remembered"); R.run('MP.stations.mp_missions()');
  R.day(dF + 2); R.day(dF); eq(R.run('MP.econ._.isDone(MP.econ.missions()[0])'), true, 'a clock set back finds the mission already done'); eq(R.run(`MP.econ._.giveFish(MP.econ.missions()[0], 0, [0])`), 0, 'no second reward'); eq(R.gold(), gR, 'paid once');
  R.day(dF + 9); R.run('G.panel = null; MP.stations.mp_missions()'); R.frame();
  ok(!R.run(`!!MP.econ.data.mis['d${dF}']`), 'old days are pruned when the board is opened'); ok(!JSON.parse(R.store[R.run('MP.econ._.KEY()')]).mis['d' + dF], 'in the saved data too');
  // midnight passes while a picker is open
  R.day(dF); R.run(`saveBag('fish', []); for (const k of ['perch', 'carp', 'pike']) T.fish(k); delete MP.econ.data.mis['d${dF}']`); R.run('G.panel = null; MP.stations.mp_missions()'); R.frame(); R.clickBtn('turn', 0); R.frame(); eq(R.view(), 'fish', 'a picker is open');
  R.clickCell(0); R.day(dF + 1); R.frame(); eq(R.view(), 'list', 'at midnight the picker closes'); ok(/new missions/.test(R.run('G.msg')), 'with a word about it'); eq(R.run(`T.bag('fish').length`), 3, 'and nothing was taken');
  // a weekly done on Monday stays done all week, and is new the next Monday
  const dWk = Math.floor((dW + 3) / 7) * 7 - 3; W1.day(dWk); eq(W1.run('MP.econ._.isDone(MP.econ.missions()[3])'), true, 'the weekly is done on the Monday of its week');
  W1.day(dWk + 6); eq(W1.run('MP.econ._.isDone(MP.econ.missions()[3])'), true, 'and on the Sunday'); W1.day(dWk + 7); eq(W1.run('MP.econ._.isDone(MP.econ.missions()[3])'), false, 'the next Monday brings a new weekly');

  console.log('9. the Gold counter, the toast and every panel state: landscape and portrait');
  const U = player('Una', { globals: { __MPMEM: {} } }); U.day(dW);
  U.run(`T.pet('fox', 3, 'One'); T.pet('dog', 3, 'Two', { shiny: true }); for (let i = 0; i < 30; i++) T.pet(i % 2 ? 'fox' : 'dog', 2 + i); for (const k of ['perch', 'carp', 'pike', 'minnow', 'eel', 'goldkoi']) T.fish(k); T.dish('perch'); T.dish('carp', 3); MP.econ.add(1234, 'show')`);
  const hudOk = (where, port) => {
    const r = U.J('MP.econ._.hudRect()'), sw = port ? 540 : 960;
    ok(!!r && r.x >= 8 && r.x + r.w <= sw - 8 && r.y >= 0, `${where}: the Gold counter is on the screen`);
    if (!r) return;
    const tw = U.run(`(() => { ctx.font = '24px ' + TITLE; return ctx.measureText(HUB_ROOMS[G.hubRoom || 'yard'].name).width; })()`);
    ok(r.x >= (port ? 20 : 24) + tw + 8, `${where}: it does not touch the room's title`);
    if (port) ok(r.y >= 540 && r.y + r.h <= 540 + 8 + 58, `${where}: inside the portrait HUD's title panel`);
    else ok(r.y >= 6 && r.y + r.h <= 64, `${where}: inside the HUD's title panel`);
  };
  for (const room of ['yard', 'wardrobe', 'records', 'den', 'menagerie', 'street']) {
    U.run(`G.mode = 'play'; G.panel = null; G.fade = 0; ${room === 'street' ? `enterHub('street')` : `enterHub('${room}')`}`); for (let i = 0; i < 3; i++) U.frame(); U.play();
    eq(U.run('G.hubRoom'), room, 'in the ' + room);
    for (const port of [false, true]) { U.setPortrait(port); U.frame(); U.frame(); hudOk(`${room} ${port ? 'portrait' : 'landscape'}`, port); }
    U.setPortrait(false);
  }
  // in the street the counter keeps clear of the street's own HUD (status line, group badge, chat)
  U.run(`MP.hub.party = null`);
  for (const port of [false, true]) {
    U.setPortrait(port); U.frame(); U.frame();
    const r = U.J('MP.econ._.hudRect()'), H0 = U.J('({ s: MP.hub._.statusRect(), b: MP.hub._.badgeRect(), c: MP.hub._.chatRects() })');
    const hits = (a, b) => a.w > 0 && b.w > 0 && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    ok(!hits(r, H0.s) && !hits(r, H0.b) && !hits(r, H0.c.row) && !hits(r, H0.c.box), `street ${port ? 'portrait' : 'landscape'}: clear of the status line, the badge and the chat`);
  }
  U.setPortrait(false);
  // the board through the real station: walk up and press E (the street is walkable offline)
  U.run(`G.player.x = MP.hub._.PLACES.find(p => p.kind === 'mp_missions').t * TILE - G.player.w / 2; G.player.vx = 0; G.player.y = G.room.floorTop * TILE - G.player.h; G.player.vy = 0;`); U.frame();
  U.tap('e'); eq(U.run('G.panel'), 'mpmissions', 'E at the mission board opens it'); U.tap('e'); eq(U.run('G.panel'), null, 'E closes it again');
  U.run(`MP.hub.leave()`); U.frame(); eq(U.run('!!MP.hub.room'), false, 'offline now'); U.tap('e'); eq(U.run('G.panel'), 'mpmissions', 'and it opens offline as well'); U.run('G.panel = null');
  const states = {
    list: () => { U.run('G.panel = null; MP.stations.mp_missions()'); },
    'fish picker': () => { U.run('G.panel = null; MP.stations.mp_missions()'); U.run(`MP.econ._.turnIn(MP.econ._.lines(MP.econ._.listLayout()).findIndex(q => q.p.t === 'fish'))`); U.frame(); U.run('MP.econ._.pickCell(0)'); },
    'dish picker': () => { U.run('G.panel = null; MP.stations.mp_missions()'); U.run(`MP.econ._.V().view = 'fish'; MP.econ._.V().m = { id: 'x', i: 0, parts: [{ t: 'dish', n: 2, min: 0 }], title: 'Test', reward: 5 };`); },
    'animal picker': () => { U.run('G.panel = null; MP.stations.mp_missions()'); U.run('MP.econ._.turnIn(3)'); },
    confirm: () => { states['animal picker'](); U.frame(); U.run(`MP.econ._.pickCell(MP.econ._.gridLayout().items.findIndex(it => !MP.econ._.petLock(it) && !it.g.shiny))`); },
    'shiny confirm': () => { states['animal picker'](); U.frame(); U.run(`MP.econ._.pickCell(MP.econ._.gridLayout().items.findIndex(it => !MP.econ._.petLock(it) && it.g.shiny))`); U.frame(); U.clickBtn('yes'); },
  };
  const wantView = { list: 'list', 'fish picker': 'fish', 'dish picker': 'fish', 'animal picker': 'pet', confirm: 'confirm', 'shiny confirm': 'shiny' };
  ok(U.missions()[3].parts[0].t === 'pet', 'this week asks for animals');
  for (const port of [false, true]) for (const vh of port ? [900, 700] : [540]) for (const [name, setup] of Object.entries(states)) {
    const where = `${name}, ${port ? 'portrait ' + vh : 'landscape'}`;
    U.setPortrait(port, vh); U.run('G.panel = null'); U.frame();
    let threw = '';
    try {
      if (name === 'dish picker') { setup(); for (let i = 0; i < 2; i++) { U.win.__now += 16; U.run('draw()'); } }   /* (a made-up mission: drawn, never stepped) */
      else { setup(); eq(U.view(), wantView[name], `${where}: the state is up`); for (let i = 0; i < 4; i++) U.frame(); U.run('mouse.x = W / 2; mouse.y = H / 2'); U.frame(); }
      ok(U.run('T.inside()'), `${where}: its buttons are inside the screen`);
      const b = U.J('MP.econ._.mbox()'); ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= (port ? 540 : 960) && b.y + b.h <= (port ? vh : 540), `${where}: the window is inside the screen`);
      if (wantView[name] === 'pet' || wantView[name] === 'fish') { const v = U.J('MP.econ._.gridLayout().view'); ok(v.x >= b.x && v.x + v.w <= b.x + b.w && v.y >= b.y && v.y + v.h <= b.y + b.h - 40, `${where}: the list is inside the window, above its buttons`); }
      if (name === 'dish picker') U.run('G.panel = null');
    } catch (e) { threw = String((e && e.stack) || e).slice(0, 400); }
    eq(threw, '', `${where}: draws without an error`);
  }
  // the animal picker scrolls (wheel, drag, keys) and a drag never picks
  U.setPortrait(false); states['animal picker'](); U.frame();
  ok(U.run('MP.econ._.gridLayout().max') > 0, 'more animals than fit: the list scrolls');
  U.run(`MP.panels.mpmissions.wheel(150)`); eq(U.run('MP.econ._.V().sc'), 150, 'the wheel scrolls it'); U.run(`MP.panels.mpmissions.wheel(-9999)`); eq(U.run('MP.econ._.V().sc'), 0, 'and back, clamped');
  const c0 = U.cell(6); U.run(`mouse.x = ${c0.x + 20}; mouse.y = ${c0.y + 60}; onMouseDown(0);`); U.run(`mouse.y = ${c0.y - 40};`); U.frame(); U.run('onMouseUp(0)');
  ok(U.run('MP.econ._.V().sc') > 50, 'dragging the list scrolls it'); eq(U.view(), 'pet', 'and picks nothing');
  U.tap('PageDown'); U.tap('ArrowDown'); U.tap('ArrowDown'); U.tap('ArrowDown'); ok(U.run('(() => { const L = MP.econ._.gridLayout(), r = L.rect(MP.econ._.V().hot); return r.y >= L.view.y - 1 && r.y + r.h <= L.view.y + L.view.h + 4; })()'), 'the keyboard cursor stays in view');
  U.tap('Escape'); eq(U.view(), 'list', 'Escape: back to the list');
  // the toast is drawn and goes away; the Records Hall shows Gold
  U.run('G.panel = null'); U.run(`MP.econ.add(25, 'toast')`); ok(U.run('MP.econ._.toasts.length') >= 1, 'a toast is waiting'); for (let i = 0; i < 200; i++) U.frame(); eq(U.run('MP.econ._.toasts.length'), 0, 'the toast has floated away');
  for (const port of [false, true]) { U.setPortrait(port); U.run(`G.panel = 'records'`); U.frame(); U.frame(); const rb = U.J('G.recBox'); ok(rb.by >= 0 && rb.by + rb.bh <= (port ? 900 : 540), `the Records Hall (with its Gold row) fits the screen, ${port ? 'portrait' : 'landscape'}`); }
  U.setPortrait(false); U.run('G.panel = null');

  console.log('10. co-op payouts: a completed raid pays 100, a dungeon 50');
  eq(P.run('MP.econ.PAY.dungeon'), 50, 'a dungeon pays 50'); eq(P.run('MP.econ.PAY.raid'), 100, 'a raid pays 100');
  const gp = P.gold(); eq(P.run(`MP.econ.payout('dungeon')`), 50, 'the dungeon hook'); eq(P.gold(), gp + 50, '+50 Gold'); eq(P.run('MP.econ.data.log[MP.econ.data.log.length - 1].w'), 'Dungeon cleared', 'logged');
  await coopRaid();

  eq(errors.length, 0, 'nothing was logged as an error' + (errors.length ? ': ' + errors[0].slice(0, 500) : ''));
  console.log(`\n${checks - fails}/${checks} checks passed`);
  process.exit(fails ? 1 : 0);
}

// ---------- a real MP.coop raid for two players (virtual time, in-memory network, stand-in battle) ----------
async function coopRaid() {
  const CLOCK = { t: 1.8e12, timers: [], id: 1 };
  class VDate extends Date { constructor(...a) { if (a.length) super(...a); else super(CLOCK.t); } static now() { return CLOCK.t; } }
  const vClear = id => { const k = CLOCK.timers.findIndex(t => t.id === id); if (k >= 0) CLOCK.timers.splice(k, 1); };
  const vTimeout = (f, ms, ...a) => { const id = CLOCK.id++; CLOCK.timers.push({ id, at: CLOCK.t + Math.max(0, +ms || 0), f, a }); return id; };
  const vInterval = (f, ms, ...a) => { const id = CLOCK.id++; CLOCK.timers.push({ id, at: CLOCK.t + Math.max(1, +ms || 1), f, a, every: Math.max(1, +ms || 1) }); return id; };
  const settle = () => new Promise(r => setImmediate(r));
  async function runTimers() {
    for (let n = 0; n < 100; n++) {
      const due = CLOCK.timers.filter(t => t.at <= CLOCK.t).sort((a, b) => a.at - b.at || a.id - b.id); if (!due.length) break;
      for (const t of due) { if (!CLOCK.timers.includes(t)) continue; if (t.every) t.at = Math.max(t.at + t.every, CLOCK.t + 1); else vClear(t.id); try { t.f(...t.a); } catch (e) { errors.push(String(e && e.stack)); } }
      await settle();
    }
    await settle();
  }
  const MEM = {}, clone = v => JSON.parse(JSON.stringify(v));
  function standIn() {
    const b = { active: false, link: null, onEnd: null, enc: null,
      attach(link) { b.link = link; b.active = false; b.enc = null; }, myTeam: () => [],
      hostBegin(enc) { b.link.send({ t: 'b.start', enc }); b.open(enc); }, open(enc) { b.active = true; b.enc = clone(enc); },
      onMsg(msg) { if (msg.t === 'b.start') b.open(msg.enc); else if (msg.t === 'b.end') b.close(!!msg.won); }, playerLeft() {},
      close(won) { if (!b.active) return; b.active = false; const enc = b.enc; if (b.onEnd) b.onEnd({ won, enc }); }, finish(won) { b.link.send({ t: 'b.end', won }); b.close(won); } };
    return b;
  }
  const mk = name => {
    const g = bootGame({ name, globals: { __MPMEM: MEM, console: quietConsole, Date: VDate, setTimeout: vTimeout, clearTimeout: vClear, setInterval: vInterval, clearInterval: vClear } });
    g.run('enterHub()'); g.giveTeam(['dog', 'fox', 'owl'], 12); g.step(2);
    g.battle = g.win.__battle = standIn(); g.run('MP.battle = __battle'); g.uid = g.run('MP.net.uid'); return g;
  };
  const gs = [mk('Hana'), mk('Ivo')];
  let FR = 0;
  const frames = async n => { for (let i = 0; i < n; i++) { FR++; CLOCK.t += 1000 / 60; for (const g of gs) g.step(1, FR % 6 === 0); await runTimers(); } };
  const until = async (cond, max, what) => { for (let i = 0; i < max; i++) { if (cond()) return true; await frames(1); } ok(false, 'timed out waiting for: ' + what); return false; };
  const phase = g => g.run('MP.coop.state() ? MP.coop.state().phase : null');
  for (const g of gs) g.run(`MP.econ.add(7, 'before')`);
  const info = { code: 'GOLD1', kind: 'raid', tier: 1, seed: 4242, leader: gs[0].uid, members: gs.map(g => ({ id: g.uid, name: g.run('SAVE.skin.name') })) };
  for (const g of gs) { g.win.__info = clone(info); ok(g.run('MP.coop.start(__info)') === true, 'the raid session starts'); }
  if (!await until(() => gs.every(g => g.run('MP.coop.state() && MP.coop.state().fl === 0 && G.mode === "play"')), 3000, 'both in the raid arena')) return;
  await frames(90);
  eq(gs.map(g => g.run('MP.econ.gold()')).join(), '7,7', 'no Gold for merely starting');
  gs[1].run(`(() => { const e = G.wild[0], P = G.player; P.x = e.x + e.w / 2 - P.w / 2; P.y = e.y + e.h - P.h; P.vx = P.vy = 0; })()`);
  if (!await until(() => gs.every(g => g.battle.active), 600, 'the raid battle opens for both')) return;
  eq(gs.map(g => g.run('MP.econ.gold()')).join(), '7,7', 'no Gold during the fight');
  const host = gs.find(g => g.run('!!(MP.coop.state() && MP.coop.state().room.isHost)')); host.battle.finish(true);
  if (!await until(() => gs.every(g => phase(g) === 'done'), 900, 'the raid is completed for both')) return;
  eq(gs.map(g => g.run('MP.econ.gold()')).join(), '107,107', 'each player got 100 Gold for the raid');
  ok(gs.every(g => /\+100 Gold/.test(g.run('MP.coop.state().result.lines.join(" | ")'))), 'the completion panel says "+100 Gold"');
  ok(gs.every(g => g.run('MP.econ.data.log[MP.econ.data.log.length - 1].w') === 'Raid cleared'), 'logged as a raid');
  await frames(40); for (const g of gs) g.step(1, true);
  eq(gs.map(g => g.run('MP.econ.gold()')).join(), '107,107', 'paid once, however long the panel stays');
  ok(gs.every(g => JSON.parse(g.store[g.run('MP.econ._.KEY()')]).gold === 107), 'and saved');
}

main().catch(e => { console.error(e); process.exit(1); });
