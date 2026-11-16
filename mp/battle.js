// =====================================================================
//  MP.battle — THE CO-OP BATTLE: 1-4 players (1 only for tests), each with up to 3 pets, against foes scaled to the
//  group. Host-authoritative like the friend battles (pvp* in index.html): the HOST runs the real battle (act /
//  aiChoose / tickSide / expireSide), every move goes out as 'b.act' with a dice seed and a full snapshot, the guests
//  replay it with the same dice for the animations and then take the snapshot as the truth. Guests decide nothing.
//
//  SHAPE: B.allies = every player's pets in play order (player 1's three, then player 2's, ...; u.p = player index,
//  u.oslot = the slot in its own team, u.owner = the player's uid, u.id = p * 3 + slot), B.foes = the scaled enemy
//  team (u.id from 100 up), B.coop = { host, link, pl: players, me, enc, S: scale row, stage, ask, rphase, ... }.
//
//  WHAT A PLAYER BRINGS (myTeam): pvpTeamData (pets with their level, talents, nature, grades and the hero's CLASS
//  bonuses baked in by petUnit; NO backpack items, no consumables) plus each pet's HP fraction from RUN.petHp
//  (a fainted pet stays fainted). After the battle every client writes its own pets' HP back to RUN.petHp.
//
//  SIDE BONUSES (decided here, the same on every client):
//   - per player, baked into that player's own pets at the start: team first-strike and status duration (added to
//     each pet's M.firstStrike / M.dur, so the Rogue's +1 turn only helps the Rogue's pets), team start statuses
//     and start shields, the Warrior's 15% front shield (the +30% HP / +2 DEF front pet and the Archer's +8% crit
//     are already inside petUnit's numbers);
//   - one merged object for the whole party (sideOf('ally')): a synergy counts when ANY player's team has it, the
//     team amps (stun / blind / poison) are the best of the players;
//   - curses a team puts on the foes at the start are applied once each (the longest wins);
//   - the Archer's opening volley: every archer adds 8% / players of each foe's HP (4% / players on a boss), so a
//     party of archers does exactly what one archer does alone;
//   - Phoenix Feather and other items do nothing here (stats are swapped for item-free ones during the battle).
//
//  TURNS: a coin decides who starts. Player phase: every living pet in order; the host picks for its own pets in the
//  normal UI, asks a remote player with 'b.yourmove' and waits for 'b.pick' (checked: owner, ability ready, target
//  valid; a bad pick becomes the AI's choice). TURN_T seconds per pet, then the AI (aiChoose) picks and that player
//  goes on autoplay until they click again; MP.battle.playerLeft(id) makes it permanent. Foe phase: the normal AI.
//
//  SCALING: MP.battle.scale(n), ONE table (SCALE below: how many foes, their HP / attack, boss HP / attack / actions,
//  helpers, raid adds, how hard foe area attacks land on a bigger party), plus each tier's own corrections (TIERS[t]
//  .wildMul / .bossMul[n] / .raidMul[n]); all fitted with tools/coop_sim.js until 2, 3 and 4 players of the same
//  level win about equally often in about as many rounds (results: tools/mp_tests/coop_sim_results.txt).
//  Foe level = the party's average pet level clamped into the tier's band. Without backpack items a party is much
//  weaker than a solo runner, so the foes are well under their solo strength at every size (the 1-player row too).
//  ENCOUNTERS: 'wild' (the solo game's buildFoes with more, tougher animals), 'boss' (the tier's boss kit with
//  scaled minions), 'raid' (the same boss as a 3-PHASE raid boss with more HP: phase 2 at 66% = enrage (Strength) +
//  its enrage move + adds for the group size, phase 3 at 33% = shield + cleanse + every move ready + one more action
//  a round). Bosses keep the solo rules (stun: 1 turn then immune for 3, and a stun only costs ONE of their actions;
//  half damage from burn / poison / bleed): with 12 attackers the sim showed no need to change them.
//
//  XP: winBattle's formula over the foes the battle STARTED with, counted as a solo-sized group (three wild animals,
//  or the boss and two minions), full for every player, x2 for a raid; bond +1 wild / +3 boss / +5 raid (+1 on a loss).
// =====================================================================
(() => {
  // the four acts as dungeon tiers. lo..hi: the level band of its foes (the party's average level, clamped into it).
  // wildMul / bossMul / raidMul: this tier's own [HP, attack] corrections on top of the scale table, fitted by the
  // simulation (the tiers' animals and boss kits differ a lot: the Shadow Wolf mostly bites one pet, the Elder Dragon
  // burns everybody; these make every tier land on the same win rates). wildMul = its animals, in every fight;
  // bossMul[n] / raidMul[n] = every foe of its boss fight / its raid, for n players.
  const TIERS = [null,
    { name: 'The Dungeon', lo: 4, hi: 13, themes: ['hall', 'cave', 'crypt'], boss: 'shadow', wildMul: [0.865, 1.5], bossMul: [null, [1.03, 0.55], [1.11, 0.75], [1.22, 1.02], [1.18, 1.13]], raidMul: [null, [0.78, 0.52], [0.86, 0.71], [1.04, 1.05], [0.98, 1.13]] },
    { name: 'The Burning Depths', lo: 14, hi: 26, themes: ['forge', 'hollow', 'sanctum'], boss: 'elder', wildMul: [0.975, 0.9], bossMul: [null, [1.03, 1.01], [0.98, 0.89], [0.94, 0.86], [0.96, 0.91]], raidMul: [null, [0.81, 0.79], [0.72, 0.86], [0.69, 1.12], [0.64, 1.17]] },
    { name: 'The Fey Wilds', lo: 25, hi: 34, themes: ['thornwood', 'glade', 'lake'], boss: 'wyrm', wildMul: [1.09, 0.62], bossMul: [null, [0.78, 1.9], [0.88, 2.15], [0.91, 2.5], [0.93, 2.62]], raidMul: [null, [0.55, 1.7], [0.59, 2.16], [0.7, 3.14], [0.69, 3.14]] },
    { name: 'The Drowned Deep', lo: 32, hi: 37, themes: ['temple', 'coral', 'trench'], boss: 'rune', wildMul: [1.11, 1.21], bossMul: [null, [0.76, 1.16], [0.85, 2.02], [0.9, 2.25], [0.97, 2.34]], raidMul: [null, [0.52, 1.83], [0.61, 2.14], [0.68, 3.06], [0.73, 3.02]] }];
  // ---------- the scale table: everything that changes with the number of players ----------
  // foes: wild animals in a group (x.5 = one more half the time) · hp / atk: each wild foe's multipliers (a boss's
  // helpers and raid adds use them too) · aoe: how hard a FOE's hit-everyone move lands on each of the party's pets
  // (there are 3n of them to hit) · minions / bossHp / bossAtk / bossActs: the dungeon boss
  // raidHp / raidAtk / raidActs / raidMin (helpers at the start) / adds (called in phase 2) / shield (phase 3, of max HP)
  const SCALE = [null,
    { foes: 3, hp: 0.447, atk: 0.782, aoe: 1, minions: 2, bossHp: 0.15, bossAtk: 0.4, bossActs: 2, raidHp: 0.3, raidAtk: 0.4, raidActs: 2, raidMin: 0, adds: 1, shield: 0.06 },
    { foes: 5, hp: 0.545, atk: 0.97, aoe: 0.8, minions: 3, bossHp: 0.32, bossAtk: 0.6, bossActs: 3, raidHp: 0.62, raidAtk: 0.6, raidActs: 3, raidMin: 0, adds: 2, shield: 0.06 },
    { foes: 6, hp: 0.78, atk: 1.18, aoe: 0.7, minions: 4, bossHp: 0.55, bossAtk: 0.8, bossActs: 3, raidHp: 1.05, raidAtk: 0.8, raidActs: 3, raidMin: 0, adds: 2, shield: 0.06 },
    { foes: 8, hp: 0.84, atk: 1.05, aoe: 0.65, minions: 5, bossHp: 0.8, bossAtk: 0.9, bossActs: 4, raidHp: 1.5, raidAtk: 0.9, raidActs: 4, raidMin: 0, adds: 3, shield: 0.06 }];
  // one dial per kind of fight over all of the above, for whoever designs the dungeons: every foe's attack is multiplied
  // by it (1 = the fitted targets: wild ~88% wins from full HP, boss ~70%, raid ~55%; lower = easier; the sim's --diff tries values)
  const DIFF = { wild: 1, boss: 0.85, raid: 0.8 };   /* shipped a little under the fitted numbers for bosses and raids: real players are not the simulation's tireless AI */
  const TURN_T = 25, AI_T = 0.7, CALL_T = 5, BOSS_ENRAGE = { elder: 'meteorrain', wyrm: 'moontide', rune: 'abyssalrune', shadow: 'callshades' };
  // PACING: how long the battle waits between moves, per group size (1 = the solo game's rhythm). ONE number per size:
  // every lock after a move, a stun note or a change of phase is multiplied by it (never under PACE_MIN seconds), on
  // the host and on the guests alike. It changes nothing about WHAT happens, only how long the pauses are.
  const PACE = [1, 1, 1, 0.6, 0.5], PACE_MIN = 0.3;
  const MB = MP.battle = { TIERS, SCALE, DIFF, TURN_T, PACE, active: false, onEnd: null, link: null, desync: 0 };
  let P = null, BID = 1, CUR = null, HOSTID = null;   /* HOSTID: who called the last battle (see 'b.call') */
  const lockT = t => { const k = B.coop.pace; return k < 1 ? Math.max(PACE_MIN, t * k) : t; };   /* P: a battle being set up (host: collecting teams · guest: waiting for the start) */
  MB.scale = n => SCALE[clamp(n | 0, 1, 4)];
  MB.attach = link => { MB.link = link; HOSTID = null; };
  const send = (m, to) => { try { if (MB.link) MB.link.send(m, to); } catch (e) { console.warn('mp battle send', e); } };
  const coopOn = () => !!(B && B.coop);
  const cast = mk => { if (!B.coop.quiet) send(mk()); };   /* the host tells everyone (the simulation runs quiet: nobody listens) */
  const ended = () => B.phase === 'won' || B.phase === 'lost';

  // ---------- what goes over the wire: cleaned on the way in, always ----------
  // a pet's talent numbers (M) come from another player's game: keep the shape, bound every number
  const M_CAP = { execute: 0.5, guard: 0.5, evade: 0.6, lifesteal: 1, double: 1, cleave: 1, killHeal: 1, shieldStart: 1, hp: 3, atk: 3, firstStrike: 2, dur: 4, stunCh: 1, windDR: 0.6, bleedDR: 0.6 };
  const stList = l => l.filter(x => Array.isArray(x) && STATUS[x[0]]).slice(0, 8).map(x => [x[0], clamp(x[1] | 0, 0, 9)]);
  function cleanM(M) {
    const o = {}; let n = 0;
    if (!M || typeof M !== 'object' || Array.isArray(M)) return o;
    for (const k of Object.keys(M)) {
      if (++n > 80) break;
      const v = M[k]; if (k === '__proto__' || k.length > 24) continue;
      if (k === 'ults') { if (Array.isArray(v)) o.ults = v.filter(a => typeof a === 'string' && ABIL[a]).slice(0, 4); }
      else if (/St$/.test(k)) { if (Array.isArray(v)) o[k] = stList(v); }
      else if (k === 'up') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        o.up = {};
        for (const a of Object.keys(v).slice(0, 12)) {
          const src = v[a], U = {}; if (!ABIL[a] || !src || typeof src !== 'object' || Array.isArray(src)) continue;
          for (const f of Object.keys(src).slice(0, 12)) {
            const x = src[f];
            if (typeof x === 'number' && Number.isFinite(x)) U[f] = clamp(x, -5, 20);
            else if (f === 'stx' && Array.isArray(x)) U.stx = x.filter(e => Array.isArray(e) && STATUS[e[0]]).slice(0, 6).map(e => [e[0], clamp(e[1] | 0, 0, 9)].concat(Number.isFinite(e[2]) ? [clamp(e[2], 0, 1)] : []));
          }
          o.up[a] = U;
        }
      } else if (typeof v === 'number') { if (Number.isFinite(v)) o[k] = M_CAP[k] !== undefined ? clamp(v, 0, M_CAP[k]) : clamp(v, -5, 60); }
      else if (typeof v === 'boolean') o[k] = v;
    }
    return o;
  }
  function cleanUnitDef(o) {   /* one pet as its owner sent it -> a plain, bounded description every client unpacks the same way */
    o = o && typeof o === 'object' ? o : {};
    const k = BS[o.k] && PETS[o.k] && ITEMS['pet_' + o.k] ? o.k : 'dog', lvl = numIn(o.lvl, 1, PET_MAX_LVL, 1) | 0, base = statLine(k, lvl);
    const M = cleanM(o.M), kit = BS[k].abil.concat(BS[k].ult || []), own = [...new Set((Array.isArray(o.abil) ? o.abil : []).filter(a => typeof a === 'string' && ABIL[a] && kit.includes(a)))].slice(0, 6);   /* (only its own species' moves) */
    if (M.ults) M.ults = M.ults.filter(a => kit.includes(a));
    return { k, name: String(o.name || PETS[k].name).replace(/[\u0000-\u001f]/g, '').slice(0, 20), lvl, plvl: lvl,
      maxHp: Math.round(numIn(o.maxHp, 1, base.hp * 4, base.hp)), atk: numIn(o.atk, 0, base.atk * 4, base.atk), def: numIn(o.def, 0, base.def * 4 + 12, base.def),
      crit: numIn(o.crit, 0, 0.9, 0.05), critMul: numIn(o.critMul, 1, 4, 1.5), heal: numIn(o.heal, 0, 4, 1), dot: numIn(o.dot, 0, 4, 1), regenPct: numIn(o.regenPct, 0, 0.3, 0),
      thorns: numIn(o.thorns, 0, 1.5, 0), dr: numIn(o.dr, 0, 0.6, 0), abil: own.length ? own : BS[k].abil.slice(),
      scale: numIn(o.scale, 0.3, 1.5, 1), dodge: numIn(o.dodge, 0, 0.6, 0), hitB: numIn(o.hitB, 0, 1, 0), M, g: cleanGenes(o.g), hpf: numIn(o.hpf, 0, 1, 1) };
  }
  function cleanEnc(e) {
    e = e && typeof e === 'object' ? e : {};
    const kind = e.kind === 'boss' || e.kind === 'raid' ? e.kind : 'wild', tier = clamp(e.tier | 0, 1, 4), T = TIERS[tier], o = { kind, tier };
    if (kind === 'wild') {
      o.theme = T.themes.includes(e.theme) ? e.theme : T.themes[0];
      if (typeof e.k === 'string' && BS[e.k] && PETS[e.k]) o.k = e.k;
      o.comp = COMPS[e.comp] ? e.comp : 'mixed'; o.floor = clamp(e.floor | 0, 1, 40);
      if (e.coat && Array.isArray(e.coat.col) && e.coat.col.length === 2 && e.coat.col.every(v => Number.isInteger(v) && v >= 0 && v <= COAT_MELAN)) o.coat = { col: e.coat.col.slice(), blend: !!e.coat.blend };
    }
    if (typeof e.bg === 'string') o.bg = e.bg.slice(0, 20);
    return o;
  }
  // my team: pets + class bonuses (no items), and how hurt each one is in this run
  MB.myTeam = () => {
    const syn0 = G.syn, t = pvpTeamData(), its = petSlots.filter(Boolean); G.syn = syn0;
    t.units.forEach((o, i) => { const f = RUN && RUN.petHp && its[i] ? RUN.petHp[its[i].pid] : undefined; o.hpf = f === undefined ? 1 : clamp(+f || 0, 0, 1); });
    return t;
  };
  MB._cleanTeam = t => cleanTeam(t);
  function cleanTeam(t) { const c = pvpCleanTeam(t); c.units = c.units.map(cleanUnitDef); return c; }

  // ---------- building the two sides ----------
  // a unit built for the solo game, moved to another level (its boss / alpha multipliers stay as they were)
  function relevel(u, L, hpMul = 1, atkMul = 1) {
    const a = statLine(u.k, u.lvl), b = statLine(u.k, L);
    u.maxHp = Math.max(1, Math.round(u.maxHp / a.hp * b.hp * hpMul)); u.atk = u.atk / a.atk * b.atk * atkMul; u.def = Math.max(0, u.def - a.def + b.def);
    u.lvl = L; u.hp = u.maxHp; return u;
  }
  // buildFoes reads the floor and the area from G.room: lend it a room of the right act while it works
  function withRoom(n, type, fn) { const R0 = G.room; G.room = Object.assign({}, R0 || {}, { n, type }); try { return fn(); } finally { G.room = R0; } }
  const tierFloor = (tier, floor) => (floor && actOf(floor) === tier ? floor : (tier - 1) * 10 + 6);
  const fcount = x => Math.floor(x) + (Math.random() < x - Math.floor(x) ? 1 : 0);
  MB.partyLevel = (teams, tier) => { const ls = teams.flatMap(t => t.units.map(u => u.lvl)); return clamp(Math.round(ls.reduce((a, b) => a + b, 0) / Math.max(1, ls.length)), TIERS[tier].lo, TIERS[tier].hi); };
  function buildCoopFoes(enc, n, L) {
    const S = MB.scale(n), T = TIERS[enc.tier], raid = enc.kind === 'raid', TW = T.wildMul, TB = (raid ? T.raidMul : T.bossMul)[clamp(n, 1, 4)]; let foes;
    if (enc.kind === 'wild') {
      const floor = tierFloor(enc.tier, enc.floor), k = enc.k || pick(THEME_POOL[enc.theme]), L0 = wildLevel(floor);
      foes = withRoom(floor, enc.theme, () => buildFoes({ k, comp: enc.comp }, fcount(S.foes)));
      for (const f of foes) relevel(f, Math.max(1, L + (f.lvl - L0)));
      if (enc.tier >= 2) for (const f of foes) if (f.abil.length < 4 && BS[f.k].ult.length) f.abil.push(pick(BS[f.k].ult));   /* (past Act I every wild animal knows an ultimate) */
    } else {
      const m = fcount(raid ? S.raidMin : S.minions);
      foes = withRoom(tierFloor(enc.tier, 0), T.themes[0], () => buildFoes({ boss: T.boss }, 1 + m));
      const Lm = foes[1] ? foes[1].lvl : foes[0].lvl - 2;
      foes.forEach((f, i) => relevel(f, Math.max(1, i ? L + (f.lvl - Lm) - 1 : L + 1)));
    }
    for (const f of foes) if (!f.boss && !f.coat && COATS[f.k] && f.k !== 'shade') f.coat = rollCoat();
    if (enc.coat) { const lead = foes.find(f => f.k === enc.k && !f.boss); if (lead) lead.coat = enc.coat; }
    const side = kitFoes(foes);
    for (const f of foes) {   /* the group-size knobs go on last, over talents and genes */
      if (f.boss) { f.maxHp = Math.round(f.maxHp * (raid ? S.raidHp : S.bossHp)); f.atk *= raid ? S.raidAtk : S.bossAtk; f.acts = raid ? S.raidActs : S.bossActs; }
      else { f.maxHp = Math.max(1, Math.round(f.maxHp * S.hp * TW[0])); f.atk *= S.atk * TW[1]; }
      if (enc.kind !== 'wild') { f.maxHp = Math.max(1, Math.round(f.maxHp * TB[0])); f.atk *= TB[1]; }
      f.atk *= DIFF[enc.kind] || 1;   /* the tier's correction for this fight: on the boss and its helpers alike */
      f.hp = f.maxHp;
    }
    return { foes, side };
  }
  // raid adds: the boss's own helpers, a level under the party
  function buildAdds(C, n) {
    const T = TIERS[C.enc.tier], S = C.S;
    const adds = withRoom(tierFloor(C.enc.tier, 0), T.themes[0], () => buildFoes({ boss: T.boss }, 1 + n)).slice(1);
    const Lm = adds[0] ? adds[0].lvl : 1;
    for (const f of adds) { relevel(f, Math.max(1, C.L - 1 + (f.lvl - Lm))); if (COATS[f.k] && f.k !== 'shade') f.coat = rollCoat(); }
    kitFoes(adds);
    const TB = T.raidMul[clamp(C.n, 1, 4)];
    for (const f of adds) { f.maxHp = Math.max(1, Math.round(f.maxHp * S.hp * T.wildMul[0] * TB[0])); f.atk *= S.atk * T.wildMul[1] * TB[1] * (DIFF.raid || 1); f.hp = f.maxHp; f.summoned = true; f.face = -1; }
    return adds;
  }
  const FOE_KEYS = ['id', 'k', 'name', 'lvl', 'maxHp', 'atk', 'def', 'crit', 'critMul', 'heal', 'dot', 'regenPct', 'thorns', 'dr', 'abil', 'acts', 'scale', 'sheet', 'boss', 'elite', 'coat', 'M', 'dodge', 'hitB', 'shiny', 'summoned'];
  const foeDef = u => { const o = {}; for (const k of FOE_KEYS) if (u[k] !== undefined && u[k] !== null && u[k] !== false) o[k] = u[k]; return JSON.parse(JSON.stringify(o)); };
  function unpackFoe(o) {   /* a foe as the host described it */
    o = o && typeof o === 'object' ? o : {};
    const k = BS[o.k] && PETS[o.k] ? o.k : 'dog', boss = ['shadow', 'elder', 'wyrm', 'rune'].includes(o.boss) ? o.boss : null;
    const abil = (Array.isArray(o.abil) ? o.abil : []).filter(a => typeof a === 'string' && ABIL[a]).slice(0, 8);
    const u = { side: 'foe', id: clamp(o.id | 0, 100, 9999), k, name: String(o.name || PETS[k].name).replace(/[\u0000-\u001f]/g, '').slice(0, 28), lvl: numIn(o.lvl, 1, 99, 1) | 0, M: cleanM(o.M),
      elite: !!o.elite, boss, maxHp: Math.round(numIn(o.maxHp, 1, 9999999, 50)), atk: numIn(o.atk, 0, 99999, 5), def: numIn(o.def, 0, 999, 1), crit: numIn(o.crit, 0, 1, 0.05), critMul: numIn(o.critMul, 1, 10, 1.5),
      heal: numIn(o.heal, 0, 10, 1), dot: numIn(o.dot, 0, 10, 1), regenPct: numIn(o.regenPct, 0, 1, 0), thorns: numIn(o.thorns, 0, 5, 0), dr: numIn(o.dr, 0, 0.9, 0),
      abil: abil.length ? abil : BS[k].abil.slice(), cd: {}, st: {}, acts: clamp(o.acts | 0, 1, 6), scale: numIn(o.scale, 0.3, 3, 1), dodge: numIn(o.dodge, 0, 0.9, 0), hitB: numIn(o.hitB, 0, 1, 0),
      shiny: !!o.shiny, summoned: !!o.summoned, face: -1, x: 0 };
    if (typeof o.sheet === 'string' && PETS[o.sheet]) u.sheet = o.sheet; else if (o.sheet === 'shadowwolf') u.sheet = 'shadowwolf';
    if (o.coat && Array.isArray(o.coat.col) && o.coat.col.length === 2 && o.coat.col.every(v => Number.isInteger(v) && v >= 0 && v <= COAT_MELAN)) u.coat = { col: o.coat.col.slice(), blend: !!o.coat.blend };
    u.hp = u.maxHp; u.fainted = false;
    return u;
  }
  function mkAlly(def, p, slot, pl) {   /* one player's pet as a battle unit (the same on every client) */
    const u = pvpUnpack(def, slot, 'ally');
    u.it.pid = 'coop-' + p + '-' + slot;
    u.M.firstStrike = (+u.M.firstStrike || 0) + pl.first; u.M.dur = (+u.M.dur || 0) + pl.dur;
    u.p = p; u.oslot = slot; u.owner = pl.id; u.id = p * 3 + slot; u.face = 1; u.x = 0;
    u.hp = Math.max(0, Math.round(u.maxHp * numIn(def.hpf, 0, 1, 1))); u.fainted = u.hp <= 0; if (u.fainted) u.faintT = 9;
    return u;
  }
  const xpTerm = f => (4 + 2 * f.lvl) * (f.boss ? 4 : f.elite ? 1.6 : 1);
  function xpBaseOf(foes, enc) {   /* a solo-sized group's worth: the boss and two helpers, or three wild animals */
    const boss = foes.filter(f => f.boss), rest = foes.filter(f => !f.boss && !f.summoned);
    const avg = rest.length ? rest.reduce((a, f) => a + xpTerm(f), 0) / rest.length : 0;
    return (boss.reduce((a, f) => a + xpTerm(f), 0) + avg * Math.min(rest.length, boss.length ? 2 : 3)) * (enc.kind === 'raid' ? 2 : 1);
  }

  // ---------- starting ----------
  // HOST: call everyone's team in, then build
  MB.hostBegin = enc => {
    if (!MB.link || !MB.link.isHost() || P || coopOn() || !G) return false;
    enc = cleanEnc(enc);
    P = { host: true, enc, bid: BID++, t: CALL_T, ids: MB.link.ids().slice(0, 4), teams: {} };
    MB.active = true;
    send({ t: 'b.call', bid: P.bid, enc });
    P.items = petSlots.filter(Boolean); P.teams[MB.link.me] = cleanTeam(MB.myTeam());
    return true;
  };
  function hostBuild() {
    const P0 = P; P = null;
    const now = MB.link.ids(), ids = P0.ids.filter(id => P0.teams[id] && P0.teams[id].units.length && now.includes(id));
    if (!ids.length) { MB.active = false; return; }
    MB._begin(P0.enc, ids.map(id => ({ id, team: P0.teams[id] })), P0.items, P0.bid);
  }
  // the host's part once the teams are known (the simulation calls this directly with made-up teams)
  MB._begin = (enc, list, items, bid, opt) => {
    enc = cleanEnc(enc);
    const n = list.length, teams = list.map(x => x.team), L = MB.partyLevel(teams, enc.tier), built = buildCoopFoes(enc, n, L);
    built.foes.forEach((f, i) => { f.id = 100 + i; });
    const FT = built.side.T || {};
    const start = { bid: bid || BID++, enc, n, L, first: Math.random() < 0.5 ? 'ally' : 'foe',
      pl: list.map(x => ({ id: x.id, name: String(x.team.name || 'Friend').slice(0, 14), cls: x.team.cls, look: x.team.look, first: x.team.first, dur: x.team.dur, syn: x.team.syn, amp: x.team.amp, units: x.team.units })),
      fo: built.foes.map(foeDef), fside: { syn: built.side.syn, first: built.side.first || 0, amp: { stunAmp: FT.stunAmp || 0, blindAmp: FT.blindAmp || 0, poisonAmp: FT.poisonAmp || 0 } } };
    const st = JSON.parse(JSON.stringify(start));
    if (!setup(st, true, items || [], opt)) { MB.active = false; return false; }
    const C = B.coop;
    // battle-start talents and class bonuses: each player's for their own pets, the wild team's for the foes
    list.forEach((x, p) => {
      const I = x.team, mine = B.allies.filter(u => u.p === p && !u.fainted);
      for (const u of mine) {
        if (u.M.shieldStart) addShield(u, u.maxHp * u.M.shieldStart);
        if (u.M.tauntStart) addSt(u, 'taunt', u.M.tauntStart + 1);
        if (I.shieldStart) addShield(u, u.maxHp * I.shieldStart);
        for (const [k, t] of (Array.isArray(u.M.startSt) ? u.M.startSt : []).concat(I.startSt || [])) if (STATUS[k]) addSt(u, k, clamp(t | 0, 0, 6) + 1, k === 'regen' ? Math.round(u.maxHp * 0.08) : undefined);
      }
      for (const f of B.foes) for (const [k, t] of I.foeSt || []) addSt(f, k, t);
      if (I.cls === 'warrior' && mine[0]) addShield(mine[0], mine[0].maxHp * 0.15);
    });
    for (const f of B.foes) if (!f.fainted) {
      if (f.M.shieldStart) addShield(f, f.maxHp * f.M.shieldStart);
      if (f.M.tauntStart) addSt(f, 'taunt', f.M.tauntStart + 1);
      if (FT.shieldStart) addShield(f, f.maxHp * FT.shieldStart);
      for (const [k, t] of (Array.isArray(f.M.startSt) ? f.M.startSt : []).concat(FT.startSt || [])) if (STATUS[k]) addSt(f, k, t + 1, k === 'regen' ? Math.round(f.maxHp * 0.08) : undefined);
    }
    for (const a of B.allies) if (!a.fainted) for (const [k, t] of FT.foeStartSt || []) addSt(a, k, t);
    waitUlts([...B.allies, ...B.foes]);
    B.fx = [];
    for (const f of B.foes) C.sent.add(f.id);
    if (!C.quiet) { start.snap = snap(); sendBig('b.start', start); }
    return true;
  };
  // a long message (the start: up to 12 pets and their talents) goes in pieces under the room's size limit
  function sendBig(t, obj) {
    const s = JSON.stringify(obj), N = 6000;
    if (s.length <= N) { send(Object.assign({ t }, obj)); return; }
    const n = Math.ceil(s.length / N), key = (obj.bid | 0) + ':' + Math.floor(NATIVE_RANDOM() * 1e6);
    for (let i = 0; i < n; i++) send({ t: 'b.part', k: key, of: t, i, n, s: s.slice(i * N, (i + 1) * N) });
  }
  let PARTS = null;
  function gotPart(m, from) {
    if (typeof m.s !== 'string' || m.s.length > 6100 || typeof m.k !== 'string') return;
    const n = m.n | 0, i = m.i | 0; if (n < 1 || n > 24 || i < 0 || i >= n) return;
    if (!PARTS || PARTS.k !== m.k || PARTS.from !== from) PARTS = { k: m.k, from, n, got: [], c: 0 };
    if (PARTS.got[i] === undefined) { PARTS.got[i] = m.s; PARTS.c++; }
    if (PARTS.c < PARTS.n) return;
    const s = PARTS.got.join(''); PARTS = null;
    let o = null; try { o = JSON.parse(s); } catch (e) { return; }
    if (o && typeof o === 'object' && m.of === 'b.start') { o.t = 'b.start'; MB.onMsg(o, from); }
  }
  // every client: the battle itself, from the start message (the host runs its own message through here too)
  function setup(m, host, items, opt) {
    if (!G || !m || !Array.isArray(m.pl) || !Array.isArray(m.fo) || !m.pl.length || !m.fo.length) return false;
    const enc = cleanEnc(m.enc), me = MB.link ? MB.link.me : null;
    const pl = m.pl.slice(0, 4).map((x, p) => {
      const pr = netCleanProfile(x), syn = {}, a = (x && x.amp) || {};
      for (const s of SYNERGIES) syn[s.id] = !!(x && x.syn && x.syn[s.id]);
      return { id: String((x && x.id) || '').slice(0, 24), name: pr.name, cls: pr.cls, look: pr.look, first: numIn(x && x.first, 0, 1, 0), dur: numIn(x && x.dur, 0, 4, 0) | 0, syn,
        amp: { stunAmp: numIn(a.stunAmp, 0, 2, 0), blindAmp: numIn(a.blindAmp, 0, 2, 0), poisonAmp: numIn(a.poisonAmp, 0, 2, 0) }, gone: false, afk: false, p,
        defs: (Array.isArray(x && x.units) ? x.units : []).slice(0, 3).map(cleanUnitDef) };
    });
    const allies = []; pl.forEach((o, p) => o.defs.forEach((d, s) => allies.push(mkAlly(d, p, s, o))));
    const foes = m.fo.slice(0, 16).map(unpackFoe);
    if (!allies.length) return false;
    const myP = pl.findIndex(o => o.id === me), n = pl.length, syn = {}, amp = { stunAmp: 0, blindAmp: 0, poisonAmp: 0 };
    for (const s of SYNERGIES) syn[s.id] = pl.some(o => o.syn[s.id]);
    for (const o of pl) for (const k in amp) amp[k] = Math.max(amp[k], o.amp[k]);
    const fs = m.fside && typeof m.fside === 'object' ? m.fside : {}, fsyn = {}, fa = fs.amp || {};
    for (const s of SYNERGIES) fsyn[s.id] = !!(fs.syn && fs.syn[s.id]);
    const C = { host, link: MB.link, pl, players: pl, me: myP, n, enc, bid: m.bid | 0, S: MB.scale(n), L: clamp(m.L | 0, 1, 99), first: m.first === 'foe' ? 'foe' : 'ally', stage: null, ai: -1, ask: null, q: [], pace: PACE[clamp(n, 1, 4)] || 1, plan: {}, mine: {}, acted: new Set(), planning: false, seen: new Set(foes.filter(f => !f.boss).map(f => f.k)),
      rphase: enc.kind === 'raid' ? 1 : 0, desync: 0, sent: new Set(), nid: 100 + foes.length, hostId: null, auto: !!(opt && opt.auto), fast: !!(opt && opt.fast), quiet: !!(opt && opt.quiet), archers: pl.filter(o => o.cls === 'archer').length,
      side: { ally: { syn, first: 0, amp, dur: 0 }, foe: { syn: fsyn, first: numIn(fs.first, 0, 1, 0), amp: { stunAmp: numIn(fa.stunAmp, 0, 2, 0), blindAmp: numIn(fa.blindAmp, 0, 2, 0), poisonAmp: numIn(fa.poisonAmp, 0, 2, 0) }, dur: 0 } },
      saved: { stats, team: G.team, syn: G.syn }, xp0: xpBaseOf(foes, enc), rounds: 0 };
    if (myP >= 0) allies.filter(u => u.p === myP).forEach(u => { u.own = (items || [])[u.oslot] || null; });
    stats = computeStats([], G.cls); G.panel = null; PK = null; G.coll = null;
    const boss = foes.find(f => f.boss);
    B = { ent: { coop: true, boss: boss ? boss.boss : undefined, comp: enc.comp }, allies, foes, turn: 0, phase: 'start', cur: -1, pick: null, lock: C.fast ? 0 : 1, fx: [], vfx: [], wait: 0, log: [], heroUses: 0, queue: [], faints: 0,
          boss: boss ? boss.boss : null, rewards: null, reviveUsed: true, t: 0, coop: C };
    G.mode = 'battle'; G.battleT = 0; MB.active = true; MB.desync = 0; CUR = C;
    bLog(enc.kind === 'raid' ? `RAID: ${boss ? boss.name : 'a great beast'} awaits!` : boss ? `${boss.name} blocks your way!` : `Wild ${[...new Set(foes.map(u => u.name))].slice(0, 4).join(', ')} appear!`);
    return true;
  }

  // ---------- snapshots: the host's numbers are the truth ----------
  const snapU = u => { const o = { i: u.id, hp: u.hp, f: u.fainted ? 1 : 0, st: u.st, cd: u.cd }; if (u.side === 'foe' && u.boss) { o.ab = u.abil; o.ac = u.acts; o.en = u.enraged ? 1 : 0; } return o; };
  function snap() {
    const C = B.coop, fresh = B.foes.filter(f => !C.sent.has(f.id));
    for (const f of fresh) C.sent.add(f.id);
    const s = { a: B.allies.map(snapU), f: B.foes.map(snapU), rp: C.rphase }; if (fresh.length) s.n = fresh.map(foeDef);
    return JSON.parse(JSON.stringify(s));
  }
  function tagNew() { const C = B.coop; for (const f of B.foes) if (f.id == null) { f.id = C.nid++; f.face = -1; } }   /* (the Shadow Wolf's shades) */
  function setU(u, v, quiet) {
    const C = B.coop, hp = Math.round(numIn(v.hp, 0, u.maxHp, u.hp)), f = !!v.f;
    if (!quiet && (Math.round(u.hp) !== hp || !!u.fainted !== f)) { C.desync++; MB.desync++; }
    u.hp = hp; u.st = f ? {} : cleanSt(v.st); u.cd = {};
    if (v.cd && typeof v.cd === 'object') for (const a of Object.keys(v.cd).slice(0, 12)) if (ABIL[a]) u.cd[a] = numIn(v.cd[a], 0, 20, 0) | 0;
    if (f && !u.fainted) { u.fainted = true; u.faintT = 0; u.faintWait = 0; } else if (!f && u.fainted) { u.fainted = false; u.faintT = 0; }
    if (u.side === 'foe' && u.boss) {
      if (Array.isArray(v.ab)) { const ab = v.ab.filter(a => typeof a === 'string' && ABIL[a]).slice(0, 8); if (ab.length) u.abil = ab; }
      if (v.ac) u.acts = clamp(v.ac | 0, 1, 6);
      u.enraged = !!v.en;
    }
  }
  function apply(s, quiet) {
    if (!s || typeof s !== 'object' || !coopOn()) return;
    const C = B.coop;
    for (const v of (Array.isArray(s.a) ? s.a : []).slice(0, 12)) { const u = v && B.allies.find(x => x.id === (v.i | 0)); if (u) setU(u, v, quiet); }
    if (Array.isArray(s.f) && s.f.length) {   /* the foes' line-up is the host's too (summons come and go) */
      const defs = new Map((Array.isArray(s.n) ? s.n : []).slice(0, 12).map(d => [d && d.id | 0, d])), next = [];
      for (const v of s.f.slice(0, 16)) {
        if (!v) continue;
        let u = B.foes.find(x => x.id === (v.i | 0));
        if (!u && defs.has(v.i | 0)) { u = unpackFoe(defs.get(v.i | 0)); setU(u, v, true); if (!quiet && !u.fainted) u.born = B.t; if (!u.boss) C.seen.add(u.k); }
        else if (u) setU(u, v, quiet);
        if (u && !next.includes(u)) next.push(u);
      }
      if (next.length) B.foes = next;
    }
    if (C.rphase) C.rphase = clamp(s.rp | 0, C.rphase, 3);
  }
  const byId = id => (Number.isInteger(id) && id >= 0 ? [...B.allies, ...B.foes].find(u => u.id === id) || null : null);

  // ---------- the raid's three phases (host) ----------
  function raidAnnounce(boss, ph) {
    const C = B.coop; C.rphase = ph; C.flash = 2.6; B.shakeT = 0.5; B.shakeA = 6;
    if (ph === 2) { bLog(`PHASE 2: ${boss.name} is ENRAGED and calls for help!`); bText(boss, 'PHASE 2 · ENRAGED', '#ff5252', 22); }
    else { bLog(`PHASE 3: ${boss.name} is cornered: it shields itself and strikes faster!`); bText(boss, 'PHASE 3 · LAST STAND', '#ffd54f', 22); }
    SFX.play('alert');
  }
  function raidCheck() {
    const C = B.coop; if (!C.rphase || !C.host) return;
    const boss = B.foes.find(f => f.boss); if (!boss || boss.fainted) return;
    while (C.rphase < 3 && boss.hp <= boss.maxHp * (C.rphase === 1 ? 0.66 : 0.33)) {
      const ph = C.rphase + 1;
      if (ph === 2) {
        boss.enraged = true; addSt(boss, 'str', 99);
        const ab = BOSS_ENRAGE[boss.boss]; if (ab && ABIL[ab] && !boss.abil.includes(ab)) boss.abil.push(ab);
        B.foes = B.foes.filter(f => f.boss || !f.fainted);   /* the fallen make room */
        const adds = buildAdds(C, Math.max(0, Math.min(fcount(C.S.adds), 9 - B.foes.length)));
        for (const a of adds) { a.id = C.nid++; a.born = B.t; B.foes.push(a); C.seen.add(a.k); }
      } else {
        cleanse(boss); delete boss.st.stun; addShield(boss, boss.maxHp * C.S.shield);
        for (const a in boss.cd) boss.cd[a] = 0;
        boss.acts = Math.min(6, (boss.acts || 1) + 1);
      }
      raidAnnounce(boss, ph);
      cast(() => ({ t: 'b.raid', ph, snap: snap() }));
    }
  }

  // ---------- the host's turn machine ----------
  const gone = o => o.gone || !MB.link || !MB.link.ids().includes(o.id);
  function setAfk(o, on) { if (!!o.afk === !!on) return; o.afk = !!on; if (on) dropPlans(o.p); if (B.coop.host) send({ t: 'b.afk', p: o.p, on: on ? 1 : 0 }); }
  function dropPlans(p) { const C = B.coop; for (const u of B.allies) if (u.p === p) { delete C.plan[u.id]; if (p === C.me) delete C.mine[u.id]; } }
  const newPhase = C => { C.plan = {}; C.mine = {}; C.acted.clear(); };
  function note(u, k) {
    if (k === 'stun') { bText(u, 'STUNNED', '#ffeb3b', 16); bLog(`${u.name} is stunned!`); B.coop.acted.add(u.id); }
    else if (k === 'rage') { bText(u, 'ENRAGED', '#ff5252', 20); }
    if (B.coop.host) cast(() => ({ t: 'b.note', i: u.id, k }));
  }
  function volley() {   /* every archer's share of the opening volley */
    const C = B.coop; if (!C.archers) return false;
    const part = C.archers / C.n;
    for (const f of B.foes) if (!f.fainted) dealDamage(null, f, 0, { flat: Math.max(1, Math.round(f.maxHp * (f.boss ? 0.04 : 0.08) * part)), dot: true });
    bLog('Arrows rain on the foes!'); SFX.play('bow');
    return true;
  }
  function hostCheckEnd() {
    if (ended()) return true;
    const foesOut = !bAlive('foe').length, alliesOut = !bAlive('ally').length;
    if (!foesOut && !alliesOut) return false;
    const won = foesOut && !alliesOut;
    cast(() => ({ t: 'b.end', won: won ? 1 : 0, snap: snap() })); finish(won);
    return true;
  }
  MB.checkEnd = () => (coopOn() && B.coop.host ? hostCheckEnd() : coopOn() && ended());
  function beginAlly() {
    const C = B.coop;
    if (C.first !== 'foe') B.turn++;
    C.stage = 'ally'; B.phase = 'wait'; C.ai = -1; C.ask = null; B.pick = null; C.rounds = B.turn; newPhase(C);
    tickSide('ally');
    const vol = B.turn === 1 && volley();
    cast(() => ({ t: 'b.phase', s: 'a', turn: B.turn, vol: vol ? 1 : 0, snap: snap() }));
    raidCheck(); hostCheckEnd();
  }
  function beginFoe() {
    const C = B.coop;
    if (C.first === 'foe') B.turn++;
    C.stage = 'foe'; B.phase = 'foe'; B.queue = []; C.ask = null; B.pick = null; C.rounds = B.turn; newPhase(C);
    tickSide('foe');
    cast(() => ({ t: 'b.phase', s: 'f', turn: B.turn, snap: snap() }));
    raidCheck();
    if (hostCheckEnd()) return;
    for (const u of B.foes) if (!u.fainted) for (let i = 0; i < (u.acts || 1); i++) B.queue.push(u);
    B.lock = lockT(0.5);
  }
  function doMove(u, ab, tgt) {
    const seed = Math.floor(NATIVE_RANDOM() * 2147483646) + 1;
    B.pick = null; if (B.phase === 'player') B.phase = 'wait';
    pvpSeeded(seed, () => act(u, ab, tgt));
    tagNew();
    cast(() => ({ t: 'b.act', i: u.id, ab, tg: tgt ? tgt.id : -1, seed, snap: snap() }));
    raidCheck();
    B.coop.acted.add(u.id); delete B.coop.plan[u.id]; delete B.coop.mine[u.id];
    B.lock = lockT(Math.max(0.55, (B.fxEnd || 0) + 0.1));
    return hostCheckEnd();
  }
  // PLAN AHEAD: a player may choose for every pet of theirs that has not acted yet in this player phase. The host keeps
  // one checked plan per pet (C.plan[unit id]) and plays it the moment that pet's turn comes, checking it AGAIN then:
  // a move on cooldown = ask the player after all; an attack whose target is gone = the weakest foe it may hit; a
  // heal / buff whose target is gone = ask. The order of the moves never changes: only the waiting disappears.
  function hostPlan(o, id, p) {
    const C = B.coop, u = B.allies.find(x => x.id === id), i = B.allies.indexOf(u);
    if (C.stage !== 'ally' || !o || o.gone || o.afk || !u || u.p !== o.p || u.fainted || i <= C.ai) return false;
    if (!p || typeof p.ab !== 'string' || !ABIL[p.ab] || !u.abil.includes(p.ab)) return false;
    C.plan[id] = { ab: p.ab, tg: p.tg | 0 }; return true;
  }
  function usePlan(u) {
    const C = B.coop, p = C.plan[u.id]; delete C.plan[u.id];
    if (!p || !ABIL[p.ab] || !u.abil.includes(p.ab) || u.cd[p.ab] > 0) return null;
    if (!needsTarget(p.ab)) return [p.ab, null];
    const v = validTargets(u, p.ab), t = byId(p.tg);
    if (t && v.includes(t)) return [p.ab, t];
    if (ABIL[p.ab].t !== 'foe' || !v.length) return null;
    return [p.ab, v.slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]];
  }
  function play(u, mv) {
    const C = B.coop;
    if (doMove(u, mv[0], mv[1])) return;
    if (u.again && !u.fainted) { u.again = false; C.ai--; }   /* Feral Maul and friends: the same pet goes again */
  }
  const aiMove = u => { const mv = aiChoose(u); return ABIL[mv[0]] ? mv : [u.abil[0], null]; };
  function validPick(u, p) {   /* a player's pick, checked; null = let the AI choose instead */
    if (!p || typeof p.ab !== 'string' || !ABIL[p.ab] || !u.abil.includes(p.ab) || u.cd[p.ab] > 0) return null;
    let tgt = null;
    if (needsTarget(p.ab)) { const t = byId(p.tg); if (t && validTargets(u, p.ab).includes(t)) tgt = t; else if (ABIL[p.ab].t === 'foe') { const v = validTargets(u, p.ab); tgt = v.length ? pick(v) : null; } }
    return [p.ab, tgt];
  }
  function hostAlly(dt) {
    const C = B.coop;
    if (C.ask) {
      const A = C.ask, u = A.u, o = C.pl[u.p]; let mv = null;
      if (u.fainted) { C.ask = null; return; }
      if (A.pick) { mv = validPick(u, A.pick) || aiMove(u); A.pick = null; }
      else {
        if (!A.ai && (gone(o) || o.afk)) { A.ai = true; A.t = Math.min(A.t, AI_T); }
        A.t -= dt;
        if (A.t <= 0 || (A.ai && C.fast)) { if (!A.ai && !gone(o)) setAfk(o, true); mv = aiMove(u); }
      }
      if (!mv) return;
      C.ask = null; play(u, mv);
      return;
    }
    for (let i = C.ai + 1; i < B.allies.length; i++) {
      const u = B.allies[i]; if (u.fainted) continue;
      C.ai = i;
      if (u.st.stun) { note(u, 'stun'); breakCharge(u); B.lock = lockT(0.35); return; }
      const w = windingAb(u);
      if (w) { doMove(u, w, null); return; }   /* a charge goes off by itself */
      const o = C.pl[u.p], ai = C.auto || gone(o) || o.afk, planned = ai ? null : usePlan(u);
      if (planned) { play(u, planned); return; }   /* planned ahead: no waiting */
      C.acted.delete(u.id); delete C.mine[u.id];
      C.ask = { u, t: ai ? AI_T : TURN_T + (u.p === C.me ? 0 : 2), ai, pick: null }; B.cur = i; B.pick = null;   /* (2 s of grace for the wire) */
      cast(() => ({ t: 'b.yourmove', i: u.id, tl: ai ? AI_T : TURN_T, ai: ai ? 1 : 0 }));
      return;
    }
    expireSide('ally'); beginFoe();
  }
  function hostFoe() {
    while (B.queue.length && (B.queue[0].fainted || !B.foes.includes(B.queue[0]))) B.queue.shift();
    const u = B.queue.shift();
    if (!u) { expireSide('foe'); if (!hostCheckEnd()) beginAlly(); return; }
    if (u.st.stun) { note(u, 'stun'); breakCharge(u); if (u.boss) delete u.st.stun; B.lock = lockT(0.5); return; }
    const en0 = !!u.enraged, w = windingAb(u), mv = w ? [w, null] : aiMove(u);
    if (u.enraged && !en0) note(u, 'rage');
    doMove(u, mv[0], mv[1]); B.lock = Math.max(B.lock, lockT(0.7));
  }

  // ---------- the guests: replay what the host says ----------
  function guestStep() {
    const C = B.coop, Q = C.q;
    while (Q.length && coopOn() && B.lock <= 0 && !ended()) {
      const m = Q.shift();
      try { guestMsg(C, m); } catch (e) { console.warn('mp battle replay', m && m.t, e); if (m && m.snap) apply(m.snap, true); }
      if (C.fast && coopOn()) B.lock = 0;
    }
  }
  function guestMsg(C, m) {
    if (m.t === 'b.phase') {
      const side = m.s === 'f' ? 'foe' : 'ally';
      if (C.stage) expireSide(C.stage);
      C.stage = side; C.ask = null; B.pick = null; B.turn = clamp(m.turn | 0, 0, 999); C.rounds = B.turn; newPhase(C);
      tickSide(side);
      if (m.vol) { bLog('Arrows rain on the foes!'); SFX.play('bow'); }
      apply(m.snap, !!m.vol);
      B.phase = side === 'foe' ? 'foe' : 'wait'; B.lock = lockT(0.3);
    } else if (m.t === 'b.yourmove') {
      const u = byId(m.i | 0); if (!u || u.side !== 'ally' || u.fainted) return;
      C.ask = { u, t: numIn(m.tl, 0, 120, TURN_T), ai: !!m.ai }; C.acted.delete(u.id); delete C.mine[u.id];   /* (asked after all: my plan for it was used up or thrown out) */
      if (!m.ai && u.p === C.me) SFX.play('pick');
    } else if (m.t === 'b.note') {
      const u = byId(m.i | 0); if (u) note(u, m.k === 'rage' ? 'rage' : 'stun');
    } else if (m.t === 'b.act') {
      const u = byId(m.i | 0), t = byId(m.tg | 0);
      C.ask = null; if (u) { C.acted.add(u.id); delete C.mine[u.id]; }
      if (u && !u.fainted && typeof m.ab === 'string' && ABIL[m.ab]) pvpSeeded(m.seed | 0, () => act(u, m.ab, t));
      B.foes = B.foes.filter(f => f.id != null);   /* (a shade summoned in the replay: the host's own comes with the snapshot) */
      apply(m.snap); B.lock = lockT(Math.max(0.55, (B.fxEnd || 0) + 0.1));
    } else if (m.t === 'b.raid') {
      apply(m.snap, true);
      const boss = B.foes.find(f => f.boss); if (boss) raidAnnounce(boss, clamp(m.ph | 0, 2, 3));
      B.lock = 0.6;
    } else if (m.t === 'b.afk') {
      const o = C.pl[m.p | 0]; if (o) o.afk = !!m.on;
    } else if (m.t === 'b.end') {
      apply(m.snap, true); finish(!!m.won);
    }
  }

  // ---------- one frame of a co-op battle (updateBattle hands over right after its animation timers) ----------
  MB.step = dt => {
    if (!coopOn()) return;
    const C = B.coop;
    if (C.flash > 0) C.flash -= dt;
    if (ended()) {
      if (C.paused) return;
      const go = B.t > 0.6 && (hit('Enter', ' ', 'e') || B.clicked);
      B.clicked = false;
      if (go) MB.close();
      return;
    }
    if (C.fast) { B.lock = 0; B.fx.length = 0; B.vfx.length = 0; }
    uiTurn();
    if (B.phase === 'player' && !C.paused && (C.planning || B.lock <= 0)) battleInput();   /* (planning does not wait for the animations) */
    if (!coopOn()) return;
    if (B.lock > 0) { B.lock -= dt; uiTurn(); return; }
    if (!C.host) {
      guestStep();
      if (coopOn() && C.ask && !ended()) C.ask.t = Math.max(0, C.ask.t - dt);
    } else if (B.phase === 'start') { if (C.first === 'foe') beginFoe(); else beginAlly(); }
    else if (C.stage === 'foe') hostFoe();
    else hostAlly(dt);
    if (coopOn()) uiTurn();
  };
  // what MY screen shows right now (every client, every frame): my pet's real turn (B.phase 'player', the clock runs),
  // PLANNING for my next pet that has no move yet (B.phase 'player' too, C.planning, no clock), or waiting.
  function nextPlan() {
    const C = B.coop, A = C.ask;
    return B.allies.find((u, i) => u.p === C.me && !u.fainted && !C.acted.has(u.id) && !u.st.stun && !windingAb(u) && !C.mine[u.id] && !(A && A.u === u) && !(C.host && i <= C.ai)) || null;
  }
  function uiTurn() {
    if (!coopOn() || ended() || B.phase === 'start') return;
    const C = B.coop, A = C.ask, o = C.pl[C.me]; let ph = C.stage === 'foe' ? 'foe' : 'wait', plan = false, cur = B.cur;
    if (A && C.stage === 'ally' && A.u.p === C.me && !A.ai && !A.sent && !A.pick && !A.u.fainted) { ph = 'player'; cur = B.allies.indexOf(A.u); }
    else if (o && C.stage === 'ally' && !o.afk && !o.gone && !C.auto) { const u = nextPlan(); if (u) { ph = 'player'; plan = true; cur = B.allies.indexOf(u); } }
    if (ph !== B.phase || plan !== C.planning || (ph === 'player' && cur !== B.cur)) B.pick = null;
    B.phase = ph; B.cur = cur; C.planning = plan;
  }
  const myPlans = () => (coopOn() ? Object.keys(B.coop.mine).length : 0);
  MB.plans = myPlans;
  // throw my plans away (the pets not yet played ask again, in order)
  MB.unplan = () => {
    if (!coopOn() || !myPlans()) return;
    const C = B.coop; C.mine = {};
    if (C.host) dropPlans(C.me); else send({ t: 'b.unpick', turn: B.turn }, C.hostId || undefined);
    uiTurn();
  };
  // the local player's pick (playerAct hands over): the host notes it, a guest sends it
  MB.pick = (ab, tgt) => {
    if (!coopOn() || B.phase !== 'player') return;
    const C = B.coop, u = B.allies[B.cur];
    if (!u || u.p !== C.me) return;
    const p = { ab, tg: tgt ? tgt.id : -1 };
    B.pick = null;
    if (C.planning) {   /* a plan for a pet whose turn has not come: the host keeps it (b.pick with the turn it was made in) */
      if (C.ask && C.ask.u === u) return;
      C.mine[u.id] = p;
      if (C.host) { if (!hostPlan(C.pl[C.me], u.id, p)) delete C.mine[u.id]; } else send({ t: 'b.pick', i: u.id, ab: p.ab, tg: p.tg, turn: B.turn }, C.hostId || undefined);
      uiTurn(); return;
    }
    if (!C.ask || C.ask.u !== u) return;
    if (C.host) C.ask.pick = p; else { C.ask.sent = true; send({ t: 'b.pick', i: u.id, ab: p.ab, tg: p.tg }, C.hostId || undefined); }
    uiTurn();
  };
  // "I'm back": autoplay off for my pets
  MB.back = () => {
    if (!coopOn()) return; const C = B.coop, o = C.pl[C.me]; if (!o || !o.afk) return;
    if (C.host) setAfk(o, false); else { o.afk = false; send({ t: 'b.back' }, C.hostId || undefined); }
  };
  MB.playerLeft = id => {
    if (P && P.host && P.ids.includes(id)) { P.ids = P.ids.filter(x => x !== id); delete P.teams[id]; }
    if (!coopOn()) return;
    const o = B.coop.pl.find(x => x.id === id); if (o) { o.gone = true; if (!ended()) bLog(`${o.name} left: their pets fight on by themselves.`); }
  };

  // ---------- messages ----------
  MB.onMsg = (m, from) => {
    if (!m || typeof m !== 'object' || typeof m.t !== 'string' || !MB.link) return;
    const host = MB.link.isHost();
    if (m.t === 'b.part') { if (!host) gotPart(m, from); return; }
    if (host) {
      if (m.t === 'b.team') { if (P && P.host && (m.bid | 0) === P.bid && P.ids.includes(from) && !P.teams[from]) P.teams[from] = cleanTeam(m.team); return; }
      if (!coopOn() || !B.coop.host) return;
      const C = B.coop, o = C.pl.find(x => x.id === from); if (!o) return;
      if (m.t === 'b.pick') {   /* for the pet being asked: its move · for a later pet of the same player, in the same turn: a plan */
        const A = C.ask, id = m.i | 0;
        if (A && A.u.id === id) { if (!A.ai && !A.pick && A.u.p === o.p) A.pick = { ab: m.ab, tg: m.tg | 0 }; }
        else if (Number.isInteger(m.turn) && m.turn === B.turn && !ended()) hostPlan(o, id, { ab: m.ab, tg: m.tg | 0 });
        return;
      }
      if (m.t === 'b.unpick') { if (m.turn === B.turn) dropPlans(o.p); return; }
      if (m.t === 'b.back') { if (!o.gone) setAfk(o, false); return; }
      return;
    }
    if (m.t === 'b.call') {
      // WHO MAY CALL A BATTLE: the room's host. A link that can name it (link.host()) is asked; one that cannot: the
      // first member who calls is remembered (HOSTID, forgotten with the next attach = the next party session) and
      // nobody else may call while that player is still in the room.
      const known = typeof MB.link.host === 'function' ? MB.link.host() : null, ids = MB.link.ids();
      if (coopOn() || !G || !ids.includes(from) || (known ? known !== from : HOSTID && HOSTID !== from && ids.includes(HOSTID))) return;
      HOSTID = from;
      P = { host: false, from, bid: m.bid | 0, t: 15, items: petSlots.filter(Boolean) }; MB.active = true;
      send({ t: 'b.team', bid: P.bid, team: MB.myTeam() }, from);
      return;
    }
    if (m.t === 'b.start') {
      if (coopOn() || !P || P.host || P.from !== from || (m.bid | 0) !== P.bid) return;
      const items = P.items; P = null;
      if (!setup(m, false, items)) { MB.active = false; return; }
      B.coop.hostId = from; B.coop.stage = null; B.phase = 'wait';
      apply(m.snap, true);
      return;
    }
    if (m.t === 'b.abort') { if (coopOn() && B.coop.hostId === from) MB.abort(typeof m.why === 'string' ? m.why.slice(0, 80) : 'The battle was called off.'); return; }
    if (coopOn() && !B.coop.host && B.coop.hostId === from && B.coop.q.length < 4000) B.coop.q.push(m);
  };

  // ---------- the end: XP, bond, HP back into the run ----------
  function finish(won) {
    if (!coopOn() || ended()) return;
    const C = B.coop, enc = C.enc, mineU = B.allies.filter(u => u.p === C.me && u.own && mine(u.own));
    B.phase = won ? 'won' : 'lost'; B.t = 0; B.pick = null; C.ask = null; B.lock = 0; SFX.play(won ? 'clear' : 'death');
    const R = { coop: true, won, xp: [], bond: 0, kind: enc.kind };
    const xpBase = C.xp0 * (1 + ((C.saved.stats && C.saved.stats.xp) || 0)) * (G.cls === 'beastmaster' ? 1.5 : 1) * (1 + ((TEAM() || {}).xp || 0));
    for (const u of mineU) {
      const it = u.own, rec = petRec(it); rec.f++; if (won) rec.w++;
      let gain = 0, ups = [];
      if (won) { gain = Math.round(xpBase * (u.fainted ? 0.5 : 1)); ups = givePetXp(it, gain); }
      if (RUN && RUN.petHp) RUN.petHp[it.pid] = won ? (ups.length ? 1 : u.fainted ? 0.15 : clamp(u.hp / u.maxHp, 0.01, 1)) : (u.fainted ? 0 : clamp(u.hp / u.maxHp, 0.01, 1));
      R.bond += addBond(it, won ? (enc.kind === 'raid' ? 5 : enc.kind === 'boss' ? 3 : 1) : 1);
      R.xp.push({ name: petName(it), gain, ups, fainted: u.fainted });
    }
    if (won && C.me >= 0) { try { R.off = offspring(C).map(it => ({ k: it.def.pet, shiny: !!(it.g && it.g.shiny), line: `${petBlurb(it)} joins your Sanctuary!` })); } catch (e) { console.warn('mp battle offspring', e); } }
    if (C.me >= 0) { const S = SAVE.rec; if (won) S.coopW = (S.coopW || 0) + 1; else S.coopL = (S.coopL || 0) + 1; try { savePets(); saveData(); } catch (e) { console.warn('mp battle save', e); } }
    B.rewards = R; C.result = { won, enc, rounds: B.turn, desync: C.desync };
  }
  // OFFSPRING (each player rolls for themselves, on their own game, after a win). A wild fight follows the solo rule
  // (winBattle): a sure baby from every species beaten that you do not own yet, a 25% chance (Rogue 50%) from each
  // you do. A boss fight or a raid: one sure baby of ONE random species among the boss's helpers / adds, if it had
  // any (never the boss itself, a shade or the Elder Dragon; no achievements). There is no backpack in co-op, so an
  // egg-laying species gives no egg item: its baby joins the Sanctuary at once, as a hatched egg would (unlockPet
  // keeps SAVE.coll and SAVE.rec.rescues / shinies right; born.how = 'hatched' or 'rescued').
  function offspring(C) {
    const okK = k => k !== 'shade' && k !== 'elder' && BS[k] && BS[k].off && ITEMS['pet_' + k], out = [];
    const give = k => {
      const g = rollGenes(), par = B.foes.find(f => f.k === k && f.coat); if (par) Object.assign(g, inheritCoat(par.coat, rollCoat()));
      const it = unlockPet(k, newcomerLevel(), g); it.born.how = BS[k].off === 'egg' ? 'hatched' : 'rescued'; out.push(it);
    };
    if (C.enc.kind === 'wild') { for (const k of [...new Set(B.foes.filter(f => !f.boss && !f.summoned).map(f => f.k))].filter(okK)) if (!owned(k) || Math.random() < (G.cls === 'rogue' ? 0.5 : 0.25) + ((stats && stats.offspring) || 0)) give(k); }
    else { const ks = [...C.seen].filter(okK); if (ks.length) give(ks[Math.floor(Math.random() * ks.length)]); }
    return out;
  }
  function restore(C) { stats = C.saved.stats; G.team = C.saved.team; G.syn = C.saved.syn; try { stats = computeStats(); G.team = teamMods(); } catch (e) {} }
  // the result screen is closed: back to the world, and tell the party session
  MB.close = () => {
    if (!coopOn()) return;
    const C = B.coop, res = C.result || { won: false, enc: C.enc };
    restore(C); B = null; G.mode = 'play'; MB.active = false; P = null; CUR = null;
    try { syncPets(); } catch (e) {}
    if (MB.onEnd) try { MB.onEnd({ won: !!res.won, enc: res.enc }); } catch (e) { console.warn('mp battle onEnd', e); }
  };
  // close whatever is going on, at once (the session ended, the host left...): nothing is recorded
  MB.abort = why => {
    P = null; PARTS = null; MB.active = false;
    if (!coopOn()) { CUR = null; return; }
    const C = B.coop; if (C.host && !ended()) send({ t: 'b.abort', why: String(why || '').slice(0, 80) });
    restore(C); B = null; CUR = null; if (G.mode === 'battle' || (G.mode === 'pause' && G.pauseFrom === 'battle')) G.mode = 'play';
    if (why) showMsg(String(why), 2.6);
  };
  MB.aoe = u => (u.side === 'foe' ? B.coop.S.aoe : 1);
  MB.sideOf = s => B.coop.side[s];

  // every frame (MP.ticks): the setup timers, and the battle keeps going while someone has the pause menu open
  MP.ticks.push(dt => {
    if (P) {
      P.t -= dt;
      if (P.host) { const ids = MB.link ? MB.link.ids() : []; P.ids = P.ids.filter(id => ids.includes(id)); if (P.t <= 0 || P.ids.every(id => P.teams[id])) hostBuild(); }
      else if (P.t <= 0) { P = null; MB.active = coopOn(); }
    }
    if (CUR && (!B || B.coop !== CUR)) {   /* the battle was thrown away from outside (a run abandoned from the pause menu...) */
      const C = CUR; CUR = null; MB.active = !!P;
      if (C.host && !C.result) send({ t: 'b.abort', why: 'The host left the battle.' });
    }
    if (coopOn() && G && G.mode === 'pause' && G.pauseFrom === 'battle') { B.coop.paused = true; try { updateBattle(dt); } finally { if (coopOn()) B.coop.paused = false; } }
  });

  // ---------- where everyone stands: up to 12 pets and a dozen foes, landscape and portrait ----------
  // The field is a set of CELLS that never overlap; every unit is shrunk (u.cs) until its sprite fits its cell (u.cw).
  //  - allies: each player's team is a BLOCK (a small hero, then three cells, the front pet nearest the foes) on a
  //    ground marker in the player's colour with the owner's name under it; your own block is the bright one.
  //    1 player: one block · 2: two blocks one behind the other (portrait on a short screen: side by side) · 3-4: two
  //    rows of two. Landscape: the blocks take the left 46-64% of the width (the more the fewer foes there are:
  //    bosses, raids); portrait: the whole width, under the foes.
  //  - foes: a grid of up to 3 rows right of the allies (portrait: above them); a boss gets a tall cell of its own.
  //    The grid is sized for the most foes seen so far (a raid: its adds too), so nobody jumps when one is summoned.
  //  - rows further back stand higher and are drawn first; every row leaves room for the labels over its sprites
  //    (status icons, name, HP bar) and under its feet (UNDER: the team's name).
  //  - a flying animal hovers just over its own cell's ground (u.hov) instead of 100 px up; a fainted unit shrinks
  //    (and is drawn grey and faint) so the living stand out.
  // MB.labels(u) is the one place that says where a unit's bar / name / icons go: drawing and the tests both use it.
  const TEAM_COL = ['#7ed87a', '#6fb7f2', '#f2b05e', '#d58cf0'], UNDER = 16, ST_MAX = 3;
  const overOf = cs => (cs >= 0.75 ? 48 : 40);   /* the height of the labels over a sprite: bar, name, one row of icons */
  const natural = u => { const c = u.cs, h = u.hov; u.cs = 1; u.hov = 0; const r = unitRect(u); u.cs = c; u.hov = h; return r; };
  function seat(u, cx, base, cw, capH, csMax) {
    const r = natural(u), fly = unitFly(u), down = u.fainted && !(u.faintWait > 0) ? 1 - 0.3 * clamp((u.faintT || 0) * 2, 0, 1) : 1;
    u.cw = cw; u.x = cx; u.gy = base; u.cs = Math.max(0.15, Math.min(csMax, (cw - 6) / r.w, (capH - (fly ? 6 : 0)) / r.h)) * down;
    if (fly) { const f = unitFrame(u), s = unitScale(u) * (ANIM_SCALE[unitSheet(u)] || 1); u.hov = (f[3] - f[5]) * s + 6; } else u.hov = 0;
  }
  MB.place = () => {
    const C = B.coop, port = PORTRAIT(), n = C.pl.length, ground = BX.ground, boss = B.foes.find(f => f.boss), rest = B.foes.filter(f => !f.boss), m = rest.length;
    const mL = C.mMax = Math.max(m, C.mMax || 0, C.enc.kind === 'raid' ? Math.ceil(C.S.adds) : 0);   /* cells to keep ready */
    const top = boss ? 86 : 54, avail = ground - top, stepMax = n <= 2 ? 150 : 122;
    // rows: ra of allies, fr of foes (a boss is at least two rows tall)
    const fr = mL <= (boss ? 2 : port ? 4 : 3) ? 1 : mL <= 8 ? 2 : 3, frB = boss ? Math.max(2, fr) : fr;
    const ra = n === 1 ? 1 : port && n === 2 && avail / (2 + frB) < 100 ? 1 : 2, perRow = n >= 3 || (n === 2 && ra === 1) ? 2 : 1;
    let stepA, stepF, baseF;
    if (port) { stepA = stepF = Math.min(stepMax, avail / (ra + frB)); baseF = ground - ra * stepA - Math.min(26, avail - (ra + frB) * stepA); }
    else { stepA = Math.min(stepMax, avail / ra); stepF = Math.min(stepMax, avail / frB); baseF = ground; }
    // widths
    const cols = Math.max(1, Math.ceil(mL / fr)), shA = port ? 0 : 18, shF = port ? 0 : 14, gapB = 8;
    const heroW = n === 1 ? 84 : perRow === 1 ? 46 : port ? 28 : 34, cellMax = n === 1 ? 130 : perRow === 1 ? 122 : 96;
    const csA = n === 1 ? 1 : perRow === 1 ? 0.85 : 0.68, csF = n === 1 ? 1 : mL <= 3 ? 0.85 : mL <= 6 ? 0.74 : 0.64;
    let aRight, fx0 = 6; const fx1 = W - 6;
    if (!port) {
      const need = (boss ? 176 : 0) + (mL ? cols * 92 + (fr - 1) * shF : 0) + 22, want = perRow * (heroW + 3 * cellMax) + (perRow - 1) * gapB + (ra - 1) * shA + 12;
      aRight = Math.round(Math.min(want, clamp(W - need, W * (n >= 3 ? 0.58 : 0.46), W * (n === 1 ? 0.5 : 0.64))));
      fx0 = aRight + 16;
    }
    const regionW = port ? W - 8 : aRight - 6, cell = Math.min(cellMax, ((regionW - (ra - 1) * shA - (perRow - 1) * gapB) / perRow - heroW) / 3), bw = heroW + 3 * cell;
    if (port) aRight = Math.round((W + perRow * bw + (perRow - 1) * gapB) / 2);
    const capA = stepA - overOf(csA) - UNDER;
    ctx.font = `bold 10px ${UI}`;
    C.blocks = C.pl.map((o, p) => {
      const row = perRow === 2 ? (ra === 1 ? 0 : p >> 1) : p, col = perRow === 2 ? p & 1 : 0, x1 = aRight - row * shA - col * (bw + gapB), base = ground - row * stepA;
      const txt = fitText(o.name + (p === C.me ? ' (you)' : '') + (o.gone ? ' (left)' : o.afk ? ' (auto)' : ''), bw - 8), tw = Math.min(bw - 8, ctx.measureText(txt).width);
      return { p, x0: x1 - bw, x1, base, row, hx: x1 - bw + heroW / 2, hs: 2.6 * Math.min(1, heroW / 62, (capA + 24) / 84), txt, lr: { x: x1 - bw / 2 - tw / 2, y: base + 5, w: tw, h: 11 } };
    });
    for (const u of B.allies) { const b = C.blocks[u.p]; seat(u, b.x1 - (u.oslot + 0.5) * cell, b.base, cell, capA, csA); }
    let gx1 = fx1;
    if (boss) {
      const bwB = Math.min(mL ? 190 : 240, (fx1 - fx0) * (mL ? 0.46 : 1));
      seat(boss, mL ? fx1 - bwB / 2 : (fx0 + fx1) / 2, baseF, bwB, frB * stepF - 56, 0.9); gx1 = fx1 - bwB - 4;
    }
    const gw = gx1 - fx0 - (fr - 1) * shF, cellF = Math.min(n === 1 ? 130 : 124, gw / cols), gx0 = fx0 + (gw - cellF * cols) / 2, capF = stepF - overOf(csF) - 4;
    rest.forEach((u, i) => { const r = Math.floor(i / cols), c = i % cols; seat(u, gx0 + (c + 0.5) * cellF + r * shF, baseF - r * stepF, cellF, capF, csF); });
  };
  // back rows first when drawing; front rows (and the living) first when clicking
  MB.order = front => { const l = [...B.allies, ...B.foes].map((u, i) => [u, i]).sort((a, b) => ((a[0].gy || 0) - (b[0].gy || 0)) || a[1] - b[1]).map(x => x[0]); return front ? l.reverse().sort((a, b) => (a.fainted ? 1 : 0) - (b.fainted ? 1 : 0)) : l; };
  const iconS = u => (u.boss ? 16 : (u.cs || 1) < 0.75 ? 13 : 16), barH = u => (u.boss ? 11 : (u.cs || 1) < 0.75 ? 6 : 9);
  // a unit's HP bar and name. full: the unit under the mouse (or pinned), drawn over its neighbours with everything
  // spelled out. Small foes show no name unless they are elites or bosses; a small bar has no numbers on it.
  MB.labels = (u, full) => {
    const R = unitRect(u), small = !u.boss && (u.cs || 1) < 0.75, cw = u.cw || 90, bh = barH(u);
    const bw = u.boss ? Math.min(130, cw - 8) : clamp(Math.round(R.w * 0.86), 34, Math.max(34, Math.min(84, cw - 8)));
    const bar = { x: u.x - bw / 2, y: R.y - 5 - bh, w: bw, h: bh }; let name = null;
    if (full || u.side === 'ally' || u.boss || u.elite || !small) {
      const size = u.boss ? 13 : small ? 10 : 11, maxW = full ? 230 : cw - 4; ctx.font = `bold ${size}px ${UI}`;
      const long = `${u.name}  Lv${u.lvl}` + (full && bh < 9 ? `  ·  ${Math.max(0, Math.ceil(u.showHp ?? u.hp))}/${u.maxHp}` : '');
      const txt = ctx.measureText(long).width <= maxW ? long : fitText(u.name, maxW), w = Math.min(maxW, ctx.measureText(txt).width);
      name = { x: clamp(u.x - w / 2, 2, Math.max(2, W - 2 - w)), y: bar.y - 3 - (size + 1), w, h: size + 1, txt, size };
    }
    return { R, bar, name, small, iy: (name ? name.y : bar.y) - 2 };   /* iy: where the status icons end */
  };
  // status icons: the ST_MAX most important and a "+n" marker; the unit under the mouse (or pinned: C.exp) shows them all
  const ST_PRI = ['stun', 'charging', 'taunt', 'shield', 'undying', 'burn', 'poison', 'bleed', 'mark', 'weak', 'blind', 'evade', 'guard', 'str', 'regen', 'lucky'];
  const stPri = k => { const i = ST_PRI.indexOf(k); return i < 0 ? 99 : i; };
  function stRow(u) {
    if (u.fainted) return { icons: [], more: null };
    const full = B.coop.exp === u, ks = Object.keys(u.st).filter(k => STATUS[k]).sort((a, b) => stPri(a) - stPri(b)), L = MB.labels(u, full), S = iconS(u), gap = 1;
    const per = full ? 5 : ST_MAX, show = full ? ks : ks.slice(0, ST_MAX), extra = ks.length - show.length, icons = [];
    show.forEach((k, i) => {
      const row = Math.floor(i / per), cnt = Math.min(per, show.length - row * per) + (extra ? 1 : 0), wRow = cnt * S + (cnt - 1) * gap, x0 = clamp(u.x - wRow / 2, 2, Math.max(2, W - 2 - wRow));
      icons.push({ u, k, x: x0 + (i % per) * (S + gap), y: L.iy - S - row * (S + gap), w: S, h: S });
    });
    const last = icons[icons.length - 1];
    return { icons, more: extra && last ? { u, n: extra, x: last.x + S + gap, y: last.y, w: S, h: S } : null };
  }
  MB.stIcons = u => stRow(u).icons;
  MB.stMore = u => stRow(u).more;
  const boxOf = rs => { const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y)); return { x, y, w: Math.max(...rs.map(r => r.x + r.w)) - x, h: Math.max(...rs.map(r => r.y + r.h)) - y }; };
  const hotOf = u => { const L = MB.labels(u, B.coop.exp === u), S = stRow(u); return boxOf([L.R, L.bar].concat(L.name || [], S.icons, S.more || [])); };
  // a unit's ring, name, HP bar and statuses
  MB.drawBars = (u, topmost) => {
    const C = B.coop, s = unitScale(u), exp = C.exp === u;
    if (exp && !topmost) return;   /* (drawn last, over its neighbours: MB.drawTop) */
    const L = MB.labels(u, exp), R = L.R, bar = L.bar, name = L.name, over = inRect(mouse, R), own = u.side === 'ally' && u.p === C.me, col = u.side === 'ally' ? TEAM_COL[u.p % 4] : null;
    const acting = !!(C.ask && C.ask.u === u && !ended()), planU = C.planning && B.allies[B.cur] === u && !ended(), tgtOk = B.pick && B.phase === 'player' && pickValid(u), S = stRow(u);
    if (acting) { ctx.strokeStyle = PAL.gold; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.ellipse(u.x, groundOf(u) + 2, 18 * s, 6 * s, 0, 0, 7); ctx.stroke(); }
    else if (planU) { ctx.strokeStyle = `rgba(255,244,214,${0.55 + 0.35 * Math.sin(B.t * 6)})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(u.x, groundOf(u) + 2, 18 * s, 6 * s, 0, 0, 7); ctx.stroke(); }
    if (tgtOk) { ctx.strokeStyle = over ? PAL.cream : `rgba(255,213,79,${0.5 + 0.4 * Math.sin(B.t * 8)})`; ctx.lineWidth = over ? 3 : 2; rr(R.x - 2, R.y - 2, R.w + 4, R.h + 4, 8); ctx.stroke(); }
    if (exp) { const b = boxOf([bar].concat(name || [], S.icons, S.more || [])); ctx.fillStyle = 'rgba(22,15,10,0.82)'; rr(b.x - 4, b.y - 4, b.w + 8, b.h + 7, 5); ctx.fill(); }
    const shown = u.showHp ?? u.hp, pct = Math.max(0, shown / u.maxHp);
    meter(bar.x, bar.y, bar.w, bar.h, pct, hpColor(pct));
    if (u.st.shield) { ctx.fillStyle = 'rgba(129,212,250,0.9)'; ctx.fillRect(bar.x, bar.y + bar.h + 1, bar.w * Math.min(1, u.st.shield.v / u.maxHp), 2); }
    else if (col) { ctx.globalAlpha = own ? 1 : 0.75; ctx.fillStyle = col; ctx.fillRect(bar.x, bar.y + bar.h + 1, bar.w, 2); ctx.globalAlpha = 1; }   /* whose pet: the team's colour under the bar */
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (bar.h >= 9) { ctx.font = `${u.boss ? 10 : 9}px ${UI}`; ctx.fillStyle = PAL.cream; ctx.fillText(`${Math.max(0, Math.ceil(shown))}/${u.maxHp}`, u.x, bar.y + bar.h / 2 + 0.5); }
    if (name) { ctx.font = `bold ${name.size}px ${UI}`; ctx.fillStyle = u.boss ? '#ff8a80' : u.side === 'ally' ? (own ? '#f4ffe8' : col) : PAL.gold; ctx.fillText(name.txt, name.x + name.w / 2, name.y + name.h / 2); }
    if (own && C.mine[u.id] && !ended()) { ctx.font = `bold 11px ${UI}`; ctx.fillStyle = PAL.gold; ctx.fillText('✓', bar.x + bar.w + 6, bar.y + bar.h / 2); }   /* a move is planned for it */
    for (const r of S.icons) drawStIcon(u, r);
    if (S.more) { const r = S.more; ctx.fillStyle = 'rgba(22,15,10,0.85)'; rr(r.x, r.y, r.w, r.h, 3); ctx.fill(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `bold 9px ${UI}`; ctx.fillStyle = PAL.cream; ctx.fillText('+' + r.n, r.x + r.w / 2, r.y + r.h / 2 + 0.5); }
  };
  // after every unit is drawn: the one under the mouse (or pinned by a tap on its "+n" / an icon) again, on top and in full
  MB.drawTop = () => {
    const C = B.coop; let e = null;
    if (!ended()) {
      const all = [...B.allies, ...B.foes], okU = u => u && !u.fainted && all.includes(u), cur = C.exp;
      if (B.stPin && okU(B.stPin.u)) e = B.stPin.u;
      else if (okU(C.expPin)) e = C.expPin;
      else if (okU(cur) && inRect(mouse, hotOf(cur))) e = cur;
      else { const u = unitAt(mouse); if (okU(u)) e = u; }
    }
    C.exp = e; if (e) MB.drawBars(e, true);
  };
  // every team's ground marker and name, and its hero behind the back pet
  MB.drawHeroes = () => {
    const C = B.coop, t = B.t * 5;
    for (const b of C.blocks || []) {
      const o = C.pl[b.p], own = b.p === C.me, col = TEAM_COL[b.p % 4];
      if (C.pl.length > 1) {
        ctx.globalAlpha = own ? 0.36 : 0.16; ctx.fillStyle = col; rr(b.x0, b.base - 7, b.x1 - b.x0, 13, 6); ctx.fill();
        if (own) { ctx.globalAlpha = 0.9; ctx.strokeStyle = col; ctx.lineWidth = 1.5; rr(b.x0, b.base - 7, b.x1 - b.x0, 13, 6); ctx.stroke(); }
        ctx.globalAlpha = 1;
        label(b.txt, b.lr.x + b.lr.w / 2, b.lr.y + b.lr.h / 2, { align: 'center', size: 10, bold: true, color: o.gone ? PAL.dim : own ? '#f4ffe8' : col });
      }
      let nm = own ? heroSheet(G.cls) : heroSheet(o.cls, o.look || cleanLook(null, o.cls)); if (!nm || !animFrames(nm, 'idle')) nm = animFrames(o.cls, 'idle') ? o.cls : null;
      if (nm && B.allies.some(u => u.p === b.p)) drawAnim(nm, 'idle', t + b.p * 1.7, b.hx, b.base, 1, { scale: b.hs });
    }
  };
  const n1 = C => C.pl.length === 1;
  const ownerName = u => { const C = B.coop, o = C.pl[u.p]; return !o ? '' : u.p === C.me ? 'Your' : o.name + '\'s'; };
  MB.bannerText = () => {
    const C = B.coop, rp = C.rphase ? `Phase ${C.rphase}/3 · ` : '';
    if (B.phase === 'won') return 'Victory!'; if (B.phase === 'lost') return 'Defeat...';
    if (!B.turn) return C.enc.kind === 'raid' ? 'Raid!' : 'Battle!';
    if (C.stage === 'foe') return `${rp}Turn ${B.turn} — the foes act...`;
    const A = C.ask; if (!A) return `${rp}Turn ${B.turn}`;
    return `${rp}Turn ${B.turn} — ${A.u.p === C.me && !A.ai ? 'your move' : C.pl[A.u.p] ? C.pl[A.u.p].name + '\'s move' : ''}`;
  };
  MB.drawBossBar = boss => {
    const C = B.coop, w = Math.min(456, W - 24);
    panel(W / 2 - w / 2, 44, w, 34, 'dark');
    meter(W / 2 - w / 2 + 16, 63, w - 32, 8, boss.hp / boss.maxHp, boss.enraged ? '#e0503a' : '#9d6fd6', { ticks: C.rphase ? 3 : 10 });
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `bold 13px ${UI}`; ctx.fillStyle = '#f2c3a8';
    ctx.fillText(fitText(boss.name.toUpperCase() + (C.rphase ? `   ·   RAID PHASE ${C.rphase}/3` : '') + `   ·   ${Math.max(0, Math.ceil(boss.hp))} / ${boss.maxHp}`, w - 30), W / 2, 53);
    if (C.flash > 0 && C.rphase > 1) { ctx.globalAlpha = Math.min(1, C.flash); banner(C.rphase === 2 ? 'PHASE 2 — ENRAGED!' : 'PHASE 3 — LAST STAND!', W / 2, PORTRAIT() ? 150 : 124, { plain: true, size: 20, h: 40, pad: 60, minW: 280 }); ctx.globalAlpha = 1; }
  };
  // the party list with the turn clock: where the hero's items are in a solo battle
  function drawParty(x, y, w) {
    const C = B.coop, A = C.ask;
    C.pl.forEach((o, p) => {
      const us = B.allies.filter(u => u.p === p), up = us.filter(u => !u.fainted).length, turn = A && A.u.p === p && C.stage === 'ally', yy = y + p * 19;
      ctx.font = `bold 12px ${UI}`;
      label(fitText((turn ? '▶ ' : '') + o.name + (p === C.me ? ' (you)' : ''), w - 150), x, yy, { size: 12, bold: true, color: turn ? PAL.gold : p === C.me ? PAL.good : PAL.cream });
      label(o.gone ? 'left · AI plays' : o.afk ? 'autoplay' : (CLASSES[o.cls] ? CLASSES[o.cls].name || o.cls : o.cls), x + w - 140, yy, { size: 11, color: o.gone || o.afk ? '#f0a070' : PAL.dim });
      label(`${up}/${us.length} up`, x + w, yy, { size: 11, align: 'right', color: up ? PAL.cream : '#f08a6a' });
    });
  }
  const clockTxt = A => (A && !A.ai ? ` (${Math.max(0, Math.ceil(A.t))})` : '');
  function drawResult(R) {
    const C = B.coop, port = PORTRAIT(), y0 = BX.panelY + (port ? 30 : 18);
    const head = R.won ? (R.kind === 'raid' ? 'The raid boss is down!' : R.kind === 'boss' ? 'The boss is beaten!' : 'Victory!') : 'Your party was defeated...';
    label(head, port ? W / 2 : 16, y0, { size: 17, bold: true, color: R.won ? PAL.gold : '#f08a6a', align: port ? 'center' : 'left' });
    let y = y0 + 24; const x = port ? 24 : 16;
    for (const r of R.xp) {
      const t = R.won ? `${r.name}  +${r.gain} XP${r.ups.length ? `  ▲ level ${r.ups[r.ups.length - 1]}!` : ''}${r.fainted ? '  (fainted: half)' : ''}` : `${r.name}${r.fainted ? ' fainted' : ' held on'}`;
      ctx.font = `13px ${UI}`; label(fitText(t, port ? W - 48 : 430), x, y, { size: 13, color: r.ups.length ? PAL.good : PAL.cream }); y += 17;
    }
    if (!R.xp.length) { label(C.me < 0 ? 'You watched this one.' : 'Your animals sat this one out.', x, y, { size: 13, color: PAL.dim }); y += 17; }
    const rx = port ? x : 480; let ry = port ? y + 8 : y0 + 24;
    const off = R.off || [], maxOff = port ? 5 : 2;   /* new animals first: they are the prize */
    off.slice(0, off.length > maxOff ? maxOff - 1 : maxOff).forEach(o => { ctx.font = `bold 13px ${UI}`; label(fitText(o.line, port ? W - 48 : 460), rx, ry, { size: 13, bold: true, color: o.shiny ? '#fff59d' : PAL.gold }); ry += 16; });
    if (off.length > maxOff) { label(`...and ${off.length - maxOff + 1} more new animals join your Sanctuary!`, rx, ry, { size: 13, bold: true, color: PAL.gold }); ry += 16; }
    if (R.bond) { label(`Your team's bond grows (+${Math.round(R.bond * 10) / 10})`, rx, ry, { size: 13, color: '#f8bbd0' }); ry += 16; }
    label(`Co-op battles: ${SAVE.rec.coopW || 0} won, ${SAVE.rec.coopL || 0} lost  ·  ${B.turn} turn${B.turn === 1 ? '' : 's'}`, rx, ry, { size: 12, color: PAL.dim });
    label(TOUCH.on ? 'Tap to continue' : 'Enter or click to continue', W - 14, H - 10, { align: 'right', size: 12, color: 'rgba(255,255,255,0.6)' });
  }
  // the bottom panel when it is not my pick: who is choosing (with the clock), or the result
  MB.drawPanel = () => {
    const C = B.coop, port = PORTRAIT();
    if (ended()) { if (B.rewards) drawResult(B.rewards); return; }
    const A = C.ask, o = C.pl[C.me];
    let line = C.stage === 'foe' ? 'The foes are taking their turn...' : A ? (A.ai ? `${ownerName(A.u)} ${A.u.name} acts...` : `Waiting for ${C.pl[A.u.p] ? C.pl[A.u.p].name : '...'}: ${ownerName(A.u)} ${A.u.name} is choosing...${clockTxt(A)}`) : '';
    ctx.font = `bold 14px ${UI}`; line = fitText(line, port ? W - 30 : 470);
    label(line, port ? W / 2 : 16, BX.panelY + (port ? 30 : 24), { size: 14, bold: true, color: PAL.cream, align: port ? 'center' : 'left' });
    if (o && o.afk && !o.gone) { const r = MB.backRect(); button(r, '', { hover: inRect(mouse, r), accent: '#66bb6a' }); label('Autoplay is on: take control again', r.x + r.w / 2, r.y + r.h / 2, { size: 13, bold: true, align: 'center' }); }
    else drawPlanBtn();
    if (port) drawParty(24, BX.panelY + 110, W - 48); else drawParty(512, BX.panelY + 26, 432);
  };
  MB.backRect = () => (PORTRAIT() ? { x: W / 2 - 150, y: BX.panelY + 50, w: 300, h: 36 } : { x: 16, y: BX.panelY + 48, w: 300, h: 36 });
  // "clear my plans": a small button in the header while I choose, the big one while I wait
  MB.planRect = () => (B.phase !== 'player' ? MB.backRect() : PORTRAIT() ? { x: W - 150, y: BX.panelY - 5, w: 138, h: 22 } : { x: 332, y: BX.panelY - 5, w: 138, h: 22 });
  function drawPlanBtn() {
    const n = myPlans(); if (!n || ended()) return;
    const r = MB.planRect(), big = r.h > 30;
    button(r, '', { hover: inRect(mouse, r), accent: '#c9a24a' });
    label(big ? `${n} move${n > 1 ? 's' : ''} planned ahead · clear` : `Clear plan (${n})`, r.x + r.w / 2, r.y + r.h / 2, { size: big ? 13 : 11, bold: true, align: 'center' });
  }
  // over the normal move buttons on my own turn: whose pet it is, the clock, the party
  MB.drawOver = () => {
    const C = B.coop; if (B.phase !== 'player' || ended()) return;
    const A = C.ask, port = PORTRAIT();
    if (A && !C.planning) { ctx.font = `bold 12px ${UI}`; label(`${Math.max(0, Math.ceil(A.t))} s`, (port ? W - 16 : 470) - (myPlans() ? 146 : 0), BX.panelY + 4, { size: 12, bold: true, align: 'right', color: A.t < 6 ? '#f08a6a' : PAL.gold }); }   /* the clock runs only on a real turn */
    drawPlanBtn();
    if (port) drawParty(24, BPORT().itemsY + 4, W - 48); else drawParty(512, BX.panelY + 26, 432);
  };
  // clicks the normal battle code doesn't know: taking control back from autoplay
  MB.click = () => {
    if (!coopOn() || ended()) return false;
    const C = B.coop, o = C.pl[C.me];
    if (o && o.afk && !o.gone && B.phase !== 'player' && inRect(mouse, MB.backRect())) { MB.back(); SFX.play('pick'); return true; }
    if (myPlans() && inRect(mouse, MB.planRect())) { MB.unplan(); SFX.play('pick'); return true; }
    for (const u of [...B.allies, ...B.foes]) { const r = MB.stMore(u); if (r && inRect(mouse, r)) { C.expPin = C.expPin === u ? null : u; return true; } }   /* "+n": show every status of that unit */
    if (C.expPin && !inRect(mouse, hotOf(C.expPin))) C.expPin = null;
    return false;
  };
})();
