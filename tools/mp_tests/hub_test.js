// Tests of the Kingdom Street (mp/hub.js): node tools/mp_tests/hub_test.js   (exits non-zero on a failure)
// Several copies of the game share one in-memory network registry (window.__MPMEM: the 'mem' backend of mp/net.js),
// with the network's timings shrunk so the whole thing runs in well under a minute.
const { bootGame } = require('./boot.js');
const FAST_T = { pump: 25, pres: 40, fast: 25, ping: 100, hostDead: 500, guestDead: 700, hello: 500, stagger: 100, jitter: 30, retry: 50, give: 1500, grace: 600, bye: 40, linger: 30 };

let fails = 0, checks = 0; const errors = [];
function ok(cond, what) { checks++; if (!cond) { fails++; console.log('  FAIL: ' + what); } }
function eq(a, b, what) { ok(a === b, `${what} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quietConsole = Object.assign(Object.create(console), { error: (...a) => { errors.push(a.map(x => (x && x.stack) || String(x)).join(' ')); }, warn: () => {} });

function player(REG, name, opt = {}) {
  const g = bootGame({ name, globals: { __MPMEM: REG, console: quietConsole }, search: opt.search || '', storage: opt.storage });
  Object.assign(g.run('MP.net').T, FAST_T);
  g.name = name; g.portrait = false;
  g.giveTeam(opt.team || ['dog', 'fox', 'owl'], opt.lv || 10);
  g.run(`MP.coop = { active: false, calls: [], start(info) { this.calls.push(JSON.stringify(info)); this.active = true; MP.hub.leave(); } };`);
  // one frame like the real loop (W and H follow the orientation)
  g.frame = () => { g.win.__now += 1000 / 60; g.run(`VIEW.legacy = VIEW.portrait && !portraitReady(); if (VIEW.portrait && !VIEW.legacy) { W = 540; H = portraitWorldOnly() ? 540 : VIEW.h; } else { W = 960; H = 540; } update(1 / 60); draw(); pressed = {};`); try { g.run('MP.hub.room && MP.hub.room.pump && MP.hub.room.pump()'); } catch (e) {} };
  g.setPortrait = on => { g.portrait = on; g.run(`VIEW.portrait = ${!!on}; VIEW.w = ${on ? 540 : 960}; VIEW.h = ${on ? 900 : 540};`); };
  g.uid = () => g.run('MP.net.uid');
  g.at = t => g.run(`G.player.x = ${t} * TILE - G.player.w / 2; G.player.vx = 0; G.player.y = G.room.floorTop * TILE - G.player.h; G.player.vy = 0;`);
  g.tap = k => { g.press(k); g.frame(); g.release(k); };
  g.clickAt = (x, y) => g.run(`mouse.x = ${x}; mouse.y = ${y}; onMouseDown(0); onMouseUp(0);`);
  g.btn = (id, arg) => { const r = g.run(`(() => { const b = MP.hub._.panelButtons().find(b => b.id === ${JSON.stringify(id)} && ${arg === undefined ? 'true' : 'b.arg === ' + JSON.stringify(arg)}); return b ? JSON.stringify(b) : ''; })()`); return r ? JSON.parse(r) : null; };
  g.clickBtn = (id, arg) => { const b = g.btn(id, arg); if (!b) return false; g.clickAt(b.r.x + b.r.w / 2, b.r.y + b.r.h / 2); return true; };
  g.others = () => JSON.parse(g.run(`JSON.stringify([...MP.hub._.S.others.values()].map(o => ({ id: o.id, name: o.name, cls: o.cls, lv: o.lv, x: o.x, y: o.y, has: o.has, pt: o.pt, look: o.look })))`));
  g.chat = () => JSON.parse(g.run(`JSON.stringify(MP.hub._.S.chat.map(e => ({ sys: !!e.sys, name: e.name || '', s: e.s })))`));
  g.shown = () => JSON.parse(g.run(`JSON.stringify(MP.hub._.visibleLines().map(l => l.txt))`));
  g.party = () => JSON.parse(g.run(`JSON.stringify(MP.hub.party)`));
  g.type = s => { for (const ch of s) g.run(`netType({ key: ${JSON.stringify(ch)} })`); };
  g.sayLine = s => { g.tap('Enter'); g.type(s); g.run(`netType({ key: 'Enter' })`); };
  return g;
}
let ALL = [];
// settle: that many frames on every copy AND enough real time for the network (messages hop through timers, presence and positions go out in batches)
async function settle(frames = 20, ms = 170) { const t0 = Date.now(); for (let i = 0; i < frames; i++) { for (const g of ALL) g.frame(); if (i % 6 === 5) await sleep(1); } while (Date.now() - t0 < ms) { await sleep(8); for (const g of ALL) g.frame(); } }
async function until(fn, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; for (const g of ALL) g.frame(); await sleep(4); } return fn(); }
const inStreet = g => g.run(`!!(G && G.hub && G.hubRoom === 'street' && G.mode === 'play')`);
const open = g => g.run(`!!(MP.hub.room && MP.hub.room.state === 'open')`);
async function toStreet(...gs) { for (const g of gs) g.run(`MP.coop.active = false; enterHub('street')`); await until(() => gs.every(g => inStreet(g) && open(g))); }

async function main() {
  const REG = {};
  const A = player(REG, 'Mira', { lv: 14 }), B = player(REG, 'Tom', { lv: 9 }), C = player(REG, 'Ana', { lv: 22 }), D = player(REG, 'Kofi', { lv: 5 }), E = player(REG, 'Zed', { lv: 30 });
  ALL = [A, B, C, D, E];
  console.log('network: mp/net.js, backend', A.run('MP.net.backend'));

  console.log('1. the Yard has a signpost; the street is reached through it and directly');
  ok(A.run(`hubStations().some(s => s.kind === 'door' && s.to === 'street')`), 'the Yard has the street door');
  eq(A.run(`HUB_ROOMS.street.cols`), 72, 'street width');
  A.run(`G.mode = 'play'; G.fade = 0`); A.at(A.run('HUB_SPOTS.doors.street')); A.frame();
  eq(A.run(`(hubNearest() || {}).to`), 'street', 'standing at the signpost');
  A.tap('e'); await until(() => inStreet(A) && open(A));
  ok(inStreet(A), 'A walked into the street'); ok(open(A), 'A joined the hub room');
  ok(Math.abs(A.run('G.player.x + G.player.w / 2') - 4 * 30) < 40, 'A stands by the door back');
  eq(A.run('G.pets.length'), 0, "the Yard's animals stay in the Yard");
  ok(!A.run(`hubStations().some(s => ['fish', 'oven', 'doghouse', 'post', 'team', 'pet', 'creel'].includes(s.kind))`), 'no Yard stations in the street');
  eq(A.run(`hubStations().map(s => s.kind).join(',')`), 'door,mp_sign,mp_missions,mp_auction,mp_shop,mp_dungeon,mp_raid', 'the street stations, left to right');
  ok(A.run(`(() => { const s = hubStations().filter(s => s.kind !== 'door'); for (let i = 1; i < s.length; i++) if (s[i].x - s[i - 1].x < 190) return false; return s[s.length - 1].x < (HUB_ROOMS.street.cols - 5) * TILE; })()`), 'stations are spaced out');
  await toStreet(B, C);
  ok(inStreet(B) && open(B), "enterHub('street') works directly");
  await settle(30);

  console.log('2. players see each other: members, cleaned looks, positions');
  eq(A.others().length, 2, 'A sees two others'); eq(B.others().length, 2, 'B sees two others');
  const seenA = B.others().find(o => o.id === A.uid());
  ok(seenA && seenA.name === 'Mira' && seenA.lv === 14 && seenA.cls === A.run('G.cls'), 'B sees A with name, class and level');
  ok(seenA && seenA.look && seenA.look.v === 2, 'the look was cleaned into a paper-doll look');
  ok(seenA && seenA.has && Math.abs(seenA.x - A.run('G.player.x')) < 3, "B sees A at A's position");
  A.run('G.player.x += 300'); const x0 = seenA.x, x1 = A.run('G.player.x');
  let mid = null; for (let i = 0; i < 40 && mid === null; i++) { A.frame(); B.frame(); await sleep(1); const v = B.others().find(o => o.id === A.uid()).x; if (v > x0 + 1 && v < x1 - 1) mid = v; }
  ok(mid !== null, 'the position eases toward the newest one');
  await settle(60);
  ok(Math.abs(B.others().find(o => o.id === A.uid()).x - A.run('G.player.x')) < 3, 'and arrives');
  ok(/Kingdom Street \d+ · 3 players/.test(A.run('MP.hub._.status()[0]')), 'the HUD shows the street and the player count: ' + A.run('MP.hub._.status()[0]'));
  // hostile presence and position
  B.run(`MP.hub.room.setPresence({ name: 'x'.repeat(200) + '\\u0007', cls: 'wizard<script>', look: { v: 2, sex: 'q', hair: '<img>', top: 9 }, lv: 1e9, pt: { kind: 'dungeon', tier: 77, m: 'zzz', r: [1, 2] }, pj: {} })`);
  await settle(20);
  A.run(`MP.hub.room.members.get(${JSON.stringify(C.uid())}).f = { x: 1e12, y: 1e12, vx: 'a', vy: NaN, f: 'left', g: {} }`); A.frame();
  const evil = A.others().find(o => o.id === B.uid());
  ok(evil && evil.name.length <= 14 && evil.cls === 'warrior' && evil.lv <= 999 && ['m', 'f'].includes(evil.look.sex), 'a hostile presence is cleaned');
  ok(evil && evil.pt && evil.pt.tier === 4 && evil.pt.m.length === 1 && evil.pt.m[0] === B.uid() && evil.pt.r.length === 0, 'a hostile group advert is cleaned');
  ok(A.others().every(o => o.x >= 0 && o.x <= 72 * 30 && o.y <= 16 * 30 && Number.isFinite(o.x + o.y)), 'positions are clamped to the room');
  ok(A.run(`(() => { const o = MP.hub._.S.others.get(${JSON.stringify(C.uid())}); return o.tx === G.room.wpx - 24 && o.vx === 0 && o.vy === 0 && o.f === 1; })()`), 'a hostile position is cleaned');
  B.run(`MP.hub._.S.presSent = ''`); await settle(90);
  eq(A.others().find(o => o.id === B.uid()).name, 'Tom', "B's real presence is back");
  eq(A.others().find(o => o.id === B.uid()).pt, null, 'and no group advert');

  console.log('3. chat: typing, filter, limits, flood, mute, bubbles');
  A.tap('Enter'); eq(A.run('NET.typing'), 'chat', 'Enter opens the chat line');
  const px = A.run('G.player.x'); A.type('add  hello   there'); A.frame(); A.frame();
  eq(A.run('G.player.x'), px, 'typing does not move the hero'); eq(A.run('G.panel'), null, 'typing triggers no hotkeys');
  A.run(`netType({ key: 'Enter' })`); await settle(10);
  eq(A.run('NET.typing'), null, 'Enter sends and closes');
  ok(B.chat().some(e => e.name === 'Mira' && e.s === 'add hello there'), 'B got the line, whitespace collapsed');
  ok(B.shown().some(l => l.includes('Mira: add hello there')), 'and it is in the chat box');
  ok(B.run(`!!MP.hub._.S.others.get(${JSON.stringify(A.uid())}).bubble`), "a speech bubble over the sender's head"); ok(A.run('!!MP.hub._.S.bubble'), 'and over my own');
  A.tap('t'); A.type('never mind'); A.run(`netType({ key: 'Escape' })`); eq(A.run('NET.typing'), null, 'Escape cancels'); ok(!A.chat().some(e => e.s === 'never mind'), 'nothing was sent');
  await settle(70);
  A.sayLine('you f u c k no, you FUCK1NG sh!t and a$$ but class passes, Scunthorpe'); await settle(10);
  const filt = B.chat().filter(e => e.name === 'Mira').pop().s;
  ok(!/fuck|sh!t|a\$\$/i.test(filt) && filt.includes('****') && filt.includes('class passes'), 'the word filter works on send: ' + filt);
  await settle(70);
  // straight to the wire, around the sender's own checks
  A.run(`MP.hub.room.send({ t: 'chat', s: 'fuuuck <b onclick=x>hi</b>\\u0000\\u0007 \\u202e ok' })`); await settle(10);
  const raw = B.chat().filter(e => e.name === 'Mira').pop().s;
  ok(!/fuuuck/.test(raw) && raw.includes('<b onclick=x>hi</b>') && !/[\u0000-\u001f\u202e]/.test(raw), 'the receiver filters too; HTML is plain text, control characters are gone: ' + raw);
  await settle(70);
  const nB = B.chat().length; A.run(`MP.hub.room.send({ t: 'chat', s: 'x'.repeat(121) })`); A.run(`MP.hub.room.send({ t: 'chat', s: 12345 })`); A.run(`MP.hub.room.send({ t: 'chat' })`); await settle(10);
  eq(B.chat().length, nB, 'over-long and non-text lines are dropped');
  await settle(70);
  A.tap('Enter'); A.type('y'.repeat(200)); eq(A.run('NET.buf.length'), 120, 'the input stops at 120 characters'); A.run(`netType({ key: 'Escape' })`);
  // flood: the sender is told, the receiver throttles
  A.sayLine('one'); A.sayLine('two');
  ok(A.chat().some(e => e.sys && /too fast/.test(e.s)), 'the sender is told they are too fast'); eq(A.run('NET.typing'), 'chat', 'and keeps the line'); A.run(`netType({ key: 'Escape' })`);
  await settle(70);
  const nB2 = B.chat().filter(e => e.name === 'Mira').length;
  for (let i = 0; i < 30; i++) A.run(`MP.hub.room.send({ t: 'chat', s: 'spam ${'${i}'}' })`.replace('${i}', i));
  await settle(10);
  ok(B.chat().filter(e => e.name === 'Mira').length - nB2 <= 1, 'a burst of 30 raw lines lets one through');
  for (let k = 0; k < 12; k++) { await settle(45); A.run(`MP.hub.room.send({ t: 'chat', s: 'drip ${k}' })`); }
  await settle(10);
  ok(B.chat().filter(e => e.name === 'Mira').length - nB2 <= 9, 'a steady drip is capped per 10 s (' + (B.chat().filter(e => e.name === 'Mira').length - nB2) + ')');
  // mute and hide
  await settle(660);
  B.tap('Tab'); eq(B.run('G.panel'), 'mpplayers', 'Tab opens the players list'); B.frame();
  ok(B.clickBtn('mute', A.uid()), 'a Mute button for A'); B.frame();
  ok(!B.shown().some(l => l.startsWith('Mira:')), "A's lines are hidden once muted");
  B.tap('Escape'); eq(B.run('G.panel'), null, 'Escape closes the list');
  A.sayLine('can you hear me'); await settle(10);
  ok(!B.chat().some(e => e.s === 'can you hear me'), 'a muted player is not heard'); ok(C.chat().some(e => e.s === 'can you hear me'), 'others still hear them');
  ok(!B.run(`!!MP.hub._.S.others.get(${JSON.stringify(A.uid())}).bubble`), 'no bubble either');
  ok(/Mira/.test(B.store['packrat_mpmute@' + B.run('SLOT')] || ''), 'the mute is remembered by name');
  ok(!B.run(`SAVE_KEYS.includes('packrat_mpmute')`), 'but is not part of the save file');
  B.tap('Tab'); B.frame(); B.clickBtn('mute', A.uid()); B.clickBtn('hide', A.uid()); B.frame();
  ok(B.run(`MP.hub._.S.hide.has(${JSON.stringify(A.uid())})`), 'Hide hides the hero too'); B.clickBtn('hide', A.uid()); B.tap('Escape');
  await settle(70); A.sayLine('and now'); await settle(10);
  ok(B.chat().some(e => e.s === 'and now'), 'unmuted again');

  console.log('4. the coming-soon places');
  for (const [kind, title] of [['mp_missions', 'Mission Board'], ['mp_auction', 'Auction House'], ['mp_shop', 'Cosmetics Shop']]) {
    for (const port of [false, true]) {
      C.setPortrait(port); C.at(C.run(`MP.hub._.PLACES.find(p => p.kind === '${kind}').t`)); C.frame(); C.tap('e');
      eq(C.run('G.panel'), 'mpsoon', title + ' opens'); C.frame(); C.frame();
      eq(C.run('MP.hub._.panelButtons().map(b => b.id).join()'), 'close', 'only a Close button');
      if (port) C.clickBtn('close'); else C.tap('Escape');
      eq(C.run('G.panel'), null, title + ' closes');
    }
  }
  C.setPortrait(false);

  console.log('5. a dungeon group: open, join x3, a fifth is refused, ready, go');
  await toStreet(D, E); await settle(30);
  eq(A.others().length, 4, 'five players in the street');
  ok(A.chat().some(e => e.sys && /Kofi joined/.test(e.s)), 'a "joined" line in the chat');
  const tDun = A.run(`MP.hub._.PLACES.find(p => p.kind === 'mp_dungeon').t`);
  for (const g of ALL) g.at(tDun);
  A.frame(); A.tap('e'); eq(A.run('G.panel'), 'mpboard', 'E at the Dungeon board opens it'); A.frame();
  ok(A.clickBtn('new'), 'Open a group'); A.frame(); ok(A.clickBtn('pick', 2), 'choose Act II'); ok(A.clickBtn('open'), 'open it'); await settle(20);
  eq(A.party() && A.party().tier, 2, 'A leads a tier-2 group');
  eq(B.run(`MP.hub.groups('dungeon').length`), 1, 'B sees the group on the board'); eq(B.run(`MP.hub.groups('raid').length`), 0, 'not on the Raid board');
  // no team: no joining
  D.run(`D0 = petSlots.slice(); petSlots = [null, null, null]`); D.tap('e'); D.frame(); D.clickBtn('join', A.uid()); await settle(10);
  eq(D.party(), null, 'no animal in the team: no joining'); D.run(`petSlots = D0; G.panel = null`);
  for (const g of [B, C, D]) { g.frame(); g.tap('e'); g.frame(); ok(g.clickBtn('join', A.uid()), g.name + ' clicks Join'); await settle(15); }
  eq(A.party().m.length, 4, 'four members'); eq(D.party() && D.party().pend, false, 'D is in'); eq(D.party().m.length, 4, 'members see the roster');
  E.tap('e'); E.frame(); const full = E.btn('join', A.uid()); ok(full && full.off && full.txt === 'Full', 'the full group is not joinable');
  E.run(`MP.hub._.S.others.get(${JSON.stringify(A.uid())}).pt.m.length = 3; MP.hub.joinGroup(${JSON.stringify(A.uid())})`); await settle(15);
  eq(E.party(), null, "the leader refuses a fifth"); eq(A.party().m.length, 4, 'still four'); E.run('G.panel = null');
  ok(!A.run('MP.hub._.canGo()'), 'Go is off until everyone is ready'); A.clickBtn('go'); await settle(5); eq(A.run('MP.coop.calls.length'), 0, 'pressing it does nothing yet');
  // walking away keeps the group; G reopens the panel
  B.tap('Escape'); eq(B.run('G.panel'), null, 'B closes the board'); B.at(tDun - 12); B.frame(); await settle(30);
  ok(B.party() && A.party().m.includes(B.uid()), 'walking away does not leave the group');
  B.tap('g'); eq(B.run('G.panel'), 'mpboard', 'G reopens the group'); B.tap('Escape');
  const bd = JSON.parse(B.run('JSON.stringify(MP.hub._.badgeRect())')); B.clickAt(bd.x + 10, bd.y + 10); eq(B.run('G.panel'), 'mpboard', 'so does the badge');
  for (const g of [B, C, D]) { g.frame(); ok(g.clickBtn('ready'), g.name + ' readies up'); await settle(10); }
  eq(A.party().r.length, 3, 'three ready'); ok(A.run('MP.hub._.canGo()'), 'Go is on');
  // a forged go from someone who is not the leader
  E.run(`MP.hub.room.send({ t: 'p.go', info: { code: 'ABCDE', kind: 'dungeon', tier: 2, seed: 1, leader: MP.net.uid, members: [{ id: MP.net.uid, name: 'Zed' }, { id: ${JSON.stringify(B.uid())}, name: 'Tom' }] } }, ${JSON.stringify(B.uid())})`); await settle(10);
  eq(B.run('MP.coop.calls.length'), 0, 'a go from a non-leader is ignored');
  for (const g of ALL) { g.setPortrait(g === C || g === D); g.frame(); }
  ok(A.clickBtn('go'), 'A presses Go'); await settle(40);
  const infos = [A, B, C, D].map(g => g.run('MP.coop.calls[0] || ""'));
  ok(infos.every(i => i && i === infos[0]), 'MP.coop.start was called on all four with identical info');
  const info = JSON.parse(infos[0] || '{}');
  ok(/^[A-HJ-NP-Z2-9]{5}$/.test(info.code || '') && info.kind === 'dungeon' && info.tier === 2 && Number.isInteger(info.seed) && info.seed >= 0 && info.leader === A.uid() && (info.members || []).length === 4 && info.members[0].id === A.uid() && info.members[1].name === 'Tom', 'the info is complete: ' + infos[0]);
  eq(E.run('MP.coop.calls.length'), 0, 'the fifth player stays'); await until(() => open(E) && E.others().length === 0); await settle(20);
  ok(E.chat().some(e => e.sys && /You are now the host/.test(e.s)), 'the one who stayed became the host and is told so');
  eq(E.others().length, 0, 'and sees the others gone'); eq(A.run('MP.hub.room'), null, 'the four left the hub room'); eq(A.party(), null, 'the group is over');
  for (const g of ALL) g.setPortrait(false);

  console.log('6. back in the street: leader leaving dissolves, member leaving frees the slot (raid board)');
  await toStreet(A, B, C, D); await settle(30);
  eq(E.others().length, 4, 'everyone is back (enterHub after co-op)');
  const tRaid = A.run(`MP.hub._.PLACES.find(p => p.kind === 'mp_raid').t`);
  for (const g of ALL) { g.at(tRaid); g.frame(); }
  A.tap('e'); A.frame(); A.clickBtn('new'); A.frame(); A.clickBtn('pick', 3); A.clickBtn('open'); await settle(15);
  eq(A.party() && A.party().kind, 'raid', 'a raid group'); eq(B.run(`MP.hub.groups('raid').length`), 1, 'listed on the Raid board'); eq(B.run(`MP.hub.groups('dungeon').length`), 0, 'not on the Dungeon board');
  ok(/Lake Wyrm/.test(B.run(`MP.hub._.tierOf(3).boss`)), 'the raid tier names its boss');
  for (const g of [B, C]) { g.tap('e'); g.frame(); g.clickBtn('join', A.uid()); await settle(15); }
  eq(A.party().m.length, 3, 'three in the raid group');
  C.frame(); ok(C.clickBtn('leave'), 'C leaves the group'); await settle(15);
  eq(C.party(), null, 'C is out'); eq(A.party().m.length, 2, 'the slot is free'); eq(B.party().m.length, 2, 'B sees it');
  D.tap('e'); D.frame(); D.clickBtn('join', A.uid()); await settle(15); eq(A.party().m.length, 3, 'D takes the slot');
  D.run(`G.panel = null; MP.coop.active = false; enterHub('yard')`); await until(() => !D.run('!!MP.hub.room')); await settle(20);
  eq(D.run('!!MP.hub.room'), false, 'going back to the Yard leaves the room'); eq(A.party().m.length, 2, 'a member who leaves the street leaves the group');
  ok(A.chat().some(e => e.sys && /Kofi left/.test(e.s)), 'a "left" line in the chat');
  ok(!A.others().some(o => o.id === D.uid()), 'the player who left disappears');
  B.clickBtn('ready'); await settle(10); eq(A.party().r.length, 1, 'B is ready');
  A.frame(); ok(A.clickBtn('leave'), 'the leader closes the group'); await settle(15);
  eq(B.party(), null, 'the members are out'); eq(B.run(`MP.hub.groups('raid').length`), 0, 'the board is empty');
  // the leader walking out of the street dissolves it too
  B.run('G.panel = null'); B.tap('e'); B.frame(); B.clickBtn('new'); B.frame(); B.clickBtn('open'); await settle(15);
  C.run('G.panel = null'); C.tap('e'); C.frame(); C.clickBtn('join', B.uid()); await settle(15); eq(B.party().m.length, 2, 'a new group led by B');
  B.run(`G.panel = null; G = null; SCREEN = 'title'`); await settle(20);
  eq(B.run('!!MP.hub.room'), false, 'the title screen leaves the room'); eq(C.party(), null, 'the leader left the street: the group is dissolved');
  // solo switch for testing
  A.run('G.panel = null; MP.coop.calls = []'); A.run(`MP.hub.openGroup('raid', 1)`); await settle(5); ok(!A.run('MP.hub._.canGo()'), 'one member cannot go');
  A.run('MP.hub.debugSolo = true'); ok(A.run('MP.hub.go()'), 'with debugSolo they can'); await settle(40); eq(A.run('MP.coop.calls.length'), 1, 'and co-op starts');
  const S1 = player(REG, 'Solo', { search: '?mpsolo=1' }); eq(S1.run('MP.hub.debugSolo'), true, '?mpsolo=1 sets it');
  // no co-op module
  await toStreet(A); await settle(10); A.run('MP.hub.debugSolo = true; MP.coop = null'); A.run(`MP.hub.openGroup('dungeon', 1)`); ok(!A.run('MP.hub.go()'), 'without MP.coop Go only says so'); ok(/not available/.test(A.run('G.msg')), 'with a message');
  A.run(`MP.hub.leaveGroup(); MP.hub.debugSolo = false; MP.coop = { active: false, calls: [], start(info) { this.calls.push(JSON.stringify(info)); this.active = true; MP.hub.leave(); } };`);

  console.log('7. offline, visits, the other rooms');
  // the host vanishes without a goodbye: everyone else stays, one of them hosts, groups survive
  await toStreet(B, D); await settle(30);
  const host0 = ALL.find(g => g.run('!!(MP.hub.room && MP.hub.room.isHost)')), rest = ALL.filter(g => g !== host0), [P1, P2] = rest;
  ok(!!host0 && rest.length === 4, 'one host among five');
  for (const g of ALL) { g.run(`G.panel = null; if (MP.hub.party) MP.hub.leaveGroup()`); g.at(tDun); } await settle(20);
  P1.run(`MP.hub.openGroup('dungeon', 1)`); await settle(15); P2.run(`MP.hub.joinGroup(${JSON.stringify(P1.uid())})`); await settle(20);
  eq(P1.party() && P1.party().m.length, 2, 'a group of two before the host vanishes');
  const rid = host0.run('MP.hub.room.id'); ALL = rest; ok(REG.kill(rid), 'the host is killed');
  await until(() => rest.every(g => open(g) && g.others().length === 3 && !g.others().some(o => o.id === host0.uid())), 15000);
  ok(rest.every(g => open(g) && g.others().length === 3), 'after the migration the four still see each other: ' + rest.map(g => g.run('MP.hub.room && MP.hub.room.state') + g.others().length).join(' '));
  eq(rest.filter(g => g.run('MP.hub.room.isHost')).length, 1, 'exactly one new host');
  ok(rest.find(g => g.run('MP.hub.room.isHost')).chat().some(e => e.sys && /You are now the host/.test(e.s)), 'who is told so');
  await settle(240);
  ok(P1.party() && P1.party().m.length === 2 && P2.party() && P2.party().leader === P1.uid(), 'the group survived the migration');
  P2.sayLine('still here'); await settle(15); ok(P1.chat().some(e => e.s === 'still here'), 'chat works after the migration');
  P1.run('MP.hub.leaveGroup()'); await settle(15);
  host0.run(`G = null; SCREEN = 'title'`); host0.frame(); ALL = [A, B, C, D, E]; await toStreet(host0); await settle(20);
  eq(host0.others().length, 4, 'the old host can come back in as a guest');
  // offline: the street is walkable, the boards say you need a connection, the notice post retries
  const DEAD = `MP.net.useBackend({ claim: () => Promise.reject({ type: 'fatal', code: 'offline' }), connect: () => Promise.reject({ type: 'fatal', code: 'offline' }) })`;
  const O = player(REG, 'Offy'); ALL.push(O); O.run(DEAD);
  O.run(`enterHub('street')`); await until(() => inStreet(O) && /Offline/.test(O.run('MP.hub._.status()[0]')));
  ok(/Offline: couldn't reach the multiplayer service/.test(O.run('MP.hub._.status()[0]')), 'offline is shown: ' + O.run('MP.hub._.status()[0]'));
  const ox = O.run('G.player.x'); O.press('d'); for (let i = 0; i < 30; i++) O.frame(); O.release('d'); ok(O.run('G.player.x') > ox + 20, 'the street is walkable offline');
  O.at(tDun); O.frame(); O.tap('e'); eq(O.run('G.panel'), 'mpboard', 'the board opens'); O.frame(); O.frame(); O.clickBtn('new'); eq(O.run('MP.hub.party'), null, 'but needs a connection'); ok(/connected/.test(O.run('G.msg')), 'and says so'); O.tap('Escape');
  O.run(`MP.net.useBackend('mem'); if (MP.hub.room) MP.hub.leave()`); O.at(O.run(`MP.hub._.PLACES[0].t`)); O.frame(); O.tap('e'); await until(() => open(O)); ok(open(O), 'E at the notice post connects again');
  await settle(20); eq(O.others().length, 5, 'and sees everyone');
  O.run(DEAD); const rid2 = O.run('MP.hub.room.id'); ok(REG.kill(rid2), 'the host is killed again, and this player cannot reach the service');
  await until(() => /Offline/.test(O.run('MP.hub._.status()[0]')), 15000); ok(/Offline/.test(O.run('MP.hub._.status()[0]')), 'a lost connection is shown: ' + O.run('MP.hub._.status()[0]'));
  ok(O.chat().some(e => e.sys && /connection to the street was lost/.test(e.s)), 'with a line in the chat'); ok(inStreet(O), 'still in the street');
  O.run(`MP.net.useBackend('mem')`); await until(() => open(O), 20000); ok(open(O), 'and it reconnects by itself after a few seconds');
  O.run(`enterHub('yard'); G.mode = 'play'; G.panel = null; NET.visitor = { name: 'Friend' }`); O.at(O.run('HUB_SPOTS.doors.street')); O.frame(); O.tap('e'); await settle(40);
  eq(O.run('G.hubRoom'), 'yard', 'no Kingdom Street during a Yard visit'); ok(/visit/.test(O.run('G.msg')), 'and it says why'); O.run('NET.visitor = null');
  ok(/Kingdom Street/.test(E.run(`netCantDo('visit', true) || ''`)), 'no friend visit / battle / trade from the street');
  for (const room of ['wardrobe', 'records', 'den', 'menagerie', 'yard']) { O.run(`G.mode = 'play'; G.panel = null; goHubRoom('${room}')`); await until(() => O.run(`G.hubRoom === '${room}' && G.mode === 'play'`)); eq(O.run('G.hubRoom'), room, room + ' still works'); for (const port of [true, false]) { O.setPortrait(port); for (let i = 0; i < 4; i++) O.frame(); } eq(O.run('!!MP.hub.room'), false, 'not in the hub room there'); }
  ok(O.run(`G.pets.length > 0 && hubStations().some(s => s.kind === 'oven')`), 'the Yard has its animals and stations');

  console.log('8. drawing: every panel, landscape and portrait, never throws');
  await toStreet(A, C, D); await settle(20);
  A.run(`MP.hub.openGroup('dungeon', 4)`); await settle(10); C.run(`MP.hub.joinGroup(${JSON.stringify(A.uid())})`); await settle(10);
  A.sayLine('a long line for the bubble, to see that it wraps over three lines and then stops with dots at the very end of it'); await settle(5);
  const before = errors.length;
  for (const g of [A, C, D, E]) for (const port of [false, true]) {
    g.setPortrait(port); g.run('G.panel = null'); g.frame();
    for (const setup of [`G.panel = null`, `MP.hub.openChat(); NET.buf = 'typing...'`, `NET.typing = null; G.panel = 'mpplayers'`, `G.panel = 'mpsoon'; MP.hub._.S.soon = 'mp_shop'`, `G.panel = 'mpboard'; MP.hub._.S.board = { kind: 'dungeon', view: 'list', tier: 1, page: 0 }`,
                         `G.panel = 'mpboard'; MP.hub._.S.board = { kind: 'raid', view: 'new', tier: 3, page: 0 }`, `G.panel = 'mpboard'; MP.hub._.S.board = { kind: 'raid', view: 'list', tier: 1, page: 0 }`, `G.panel = null; openPause()`, `G.mode = 'play'; G.panel = 'net'`, `G.panel = null`]) {
      g.run(setup); for (let i = 0; i < 3; i++) g.frame();
      ok(g.run(`MP.hub._.panelButtons().every(b => b.r.x >= 0 && b.r.x + b.r.w <= W + 0.5 && b.r.y >= 0 && b.r.y + b.r.h <= H + 0.5)`), `${g.name} ${port ? 'portrait' : 'landscape'}: buttons inside the screen after ${setup.slice(0, 40)}`);
    }
    g.run(`NET.typing = null; G.panel = null; G.mode = 'play'`);
  }
  for (const g of ALL) g.setPortrait(false);
  // the code-drawn backdrop and props (no art in the tests), the Yard signpost
  A.run(`MP.hub.drawBg(G.room); MP.hub.drawProps(G.room.floorTop * TILE); MP.hub.drawYardSign(100, 400); drawParallax(G.room)`);
  // the art, when it exists, is drawn instead
  A.run(`for (const k of ['bg/street', 'props/mp_missions', 'props/mp_auction', 'props/mp_shop', 'props/mp_dungeon', 'props/mp_raid']) ART[k] = { width: k === 'bg/street' ? 480 : 120, height: k === 'bg/street' ? 270 : 90 };`); for (let i = 0; i < 3; i++) A.frame();
  A.run(`for (const k of ['bg/street', 'props/mp_missions', 'props/mp_auction', 'props/mp_shop', 'props/mp_dungeon', 'props/mp_raid']) delete ART[k];`);
  ok(A.run(`ART_FILES.bg.includes('street') && ['mp_missions', 'mp_auction', 'mp_shop', 'mp_dungeon', 'mp_raid'].every(n => ART_FILES.props.includes(n))`), 'the art is on the loading list');
  eq(errors.length, before, 'no errors while drawing');
  // the filter list itself
  const cz = s => A.run(`MP.hub._.censor(${JSON.stringify(s)})`);
  eq(cz('Hello class, pass the grass to Cockburn'), 'Hello class, pass the grass to Cockburn', 'clean words stay');
  ok(cz('sh1t') === '****' && cz('FUUUUCK') === '*******' && cz('b!tch') === '*****' && cz('@ss') === '***' && cz('ass!') === '***!', 'leetspeak and repeated letters are caught');

  if (errors.length) { fails++; console.log('  FAIL: errors were logged:\n    ' + errors.slice(0, 8).join('\n    ').slice(0, 3000)); }
  console.log(fails ? `\nhub_test: ${fails} of ${checks} checks FAILED` : `\nhub_test: all ${checks} checks passed`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
