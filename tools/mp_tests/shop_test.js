// Tests of the Cosmetics Shop (mp/shop.js) and of the paper doll's shop wares (wings, outfit colours, hair colours:
// THE HERO in index.html):   node tools/mp_tests/shop_test.js   (exits non-zero on a failure)
//   node tools/mp_tests/shop_test.js --sheet out.png   also writes a contact sheet: every real dyeable piece (first idle
//   frame) as painted and in every colourway, made by the game's own dyePixels: to LOOK at the colours.
// The harness has no real canvas (drawing is a stub, images never load), so: the art is stood in by objects of the right
// size, the colour maths is tested as the pure functions it is (dyePlan / dyeColor / dyePixels on RGBA arrays, on a
// made-up sheet AND on the real PNGs, read with the small decoder below), and "baked once" is counted (DOLL_STATS).
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { bootGame, ROOT } = require('./boot.js');

let fails = 0, checks = 0;
function ok(cond, what) { checks++; if (!cond) { fails++; console.log('  FAIL: ' + what); } }
function eq(a, b, what) { ok(a === b, `${what} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`); }
const J = (g, expr) => JSON.parse(g.run(`JSON.stringify(${expr})`));

// ---------- PNG: size (IHDR), decode to RGBA, encode ----------
const DOLL_DIR = path.join(ROOT, 'assets', 'doll');
function pngSize(file) { const b = fs.readFileSync(file); return b.toString('ascii', 12, 16) === 'IHDR' ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null; }
function pngRead(file) {
  const b = fs.readFileSync(file); let p = 8, w = 0, h = 0, depth = 0, ct = 0, lace = 0, pal = null, trns = null; const idat = [];
  while (p < b.length) {
    const n = b.readUInt32BE(p), t = b.toString('ascii', p + 4, p + 8), d = b.subarray(p + 8, p + 8 + n); p += 12 + n;
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ct = d[9]; lace = d[12]; } else if (t === 'PLTE') pal = d; else if (t === 'tRNS') trns = d; else if (t === 'IDAT') idat.push(d); else if (t === 'IEND') break;
  }
  if (depth !== 8 || lace || ![2, 3, 6].includes(ct)) return null;   // (the doll's sheets are 8-bit RGBA; anything else is skipped)
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : 1, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, out = new Uint8ClampedArray(w * h * 4), cur = Buffer.alloc(stride); let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, u = prev[x], c = x >= ch ? prev[x - ch] : 0; let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += u; else if (f === 3) v += (a + u) >> 1; else if (f === 4) { const q = a + u - c, pa = Math.abs(q - a), pb = Math.abs(q - u), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? u : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (ct === 6) { out[o] = cur[x * 4]; out[o + 1] = cur[x * 4 + 1]; out[o + 2] = cur[x * 4 + 2]; out[o + 3] = cur[x * 4 + 3]; }
      else if (ct === 2) { out[o] = cur[x * 3]; out[o + 1] = cur[x * 3 + 1]; out[o + 2] = cur[x * 3 + 2]; out[o + 3] = 255; }
      else { const i = cur[x]; out[o] = pal[i * 3]; out[o + 1] = pal[i * 3 + 1]; out[o + 2] = pal[i * 3 + 2]; out[o + 3] = trns && i < trns.length ? trns[i] : 255; }
    }
    prev = Buffer.from(cur);
  }
  return { w, h, data: out };
}
function pngWrite(file, w, h, data) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = buf => { let c = 0xffffffff; for (const v of buf) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const o = Buffer.alloc(12 + d.length); o.writeUInt32BE(d.length, 0); o.write(t, 4, 'ascii'); d.copy(o, 8); o.writeUInt32BE(crc(o.subarray(4, 8 + d.length)), 8 + d.length); return o; };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// ---------- one headless game ----------
function game(opt = {}) {
  const g = bootGame({ name: opt.name || 'Shopper', storage: opt.storage, globals: opt.globals });
  g.run('enterHub()'); g.step(5);
  // stand-ins for the art: every ordinary doll file "loaded" at the real sheet size; the wings as they are on disk
  g.run(`for (const n of DOLL_FILES) ART['doll/' + n] = { width: 768, height: 280, name: n };`);
  g.setWings = present => g.run(`for (const n of DOLL_OPT_FILES) { const on = ${JSON.stringify(present)}.includes(n); DOLL_OPT[n] = on ? 1 : -1; if (on) ART['doll/' + n] = { width: 768, height: 280, name: n }; else delete ART['doll/' + n]; }`);
  g.frame = () => { g.win.__now += 1000 / 60; g.run(`VIEW.legacy = VIEW.portrait && !portraitReady(); if (VIEW.portrait && !VIEW.legacy) { W = 540; H = portraitWorldOnly() ? 540 : VIEW.h; } else { W = 960; H = 540; } update(1 / 60); draw(); pressed = {};`); };
  g.frames = n => { for (let i = 0; i < n; i++) g.frame(); };
  g.setPortrait = on => { g.run(`VIEW.portrait = ${!!on}; VIEW.w = ${on ? 540 : 960}; VIEW.h = ${on ? 900 : 540};`); g.frame(); };
  g.tap = k => { g.press(k); g.frame(); g.release(k); };
  g.down = (x, y) => g.run(`mouse.x = ${x}; mouse.y = ${y}; onMouseDown(0);`);
  g.up = () => g.run(`onMouseUp(0);`);
  g.clickAt = (x, y) => { g.down(x, y); g.up(); };
  g.clickR = r => g.clickAt(r.x + r.w / 2, r.y + r.h / 2);
  g.lay = () => J(g, 'MP.shop._.layout()');
  return g;
}
// every canvas made from now on refuses getImageData (as a browser does for art loaded from file://); its ctx.filter starts as given
const TAINT = filter => `(() => { const mk = document.createElement; window.__made = 0; document.createElement = t => { const c = mk(t), g0 = c.getContext('2d'); let flt = ${filter}; const g = new Proxy(g0, { get: (o, k) => (k === 'getImageData' ? () => { window.__made++; throw new Error('SecurityError: the canvas has been tainted'); } : k === 'filter' ? flt : o[k]), set: (o, k, v) => { if (k === 'filter') flt = v; else o[k] = v; return true; } }); c.getContext = () => g; return c; }; })()`;
const WING_FILES = ['m', 'f'].flatMap(s => ['wingdemon', 'wingangel', 'wingdragon', 'wingfairy'].map(w => `cape_${w}_${s}`));
const onDisk = WING_FILES.filter(n => fs.existsSync(path.join(DOLL_DIR, n + '.png')));

function main() {
  const g = game();
  g.setWings(onDisk);
  console.log(`wing art on disk: ${onDisk.length ? onDisk.join(', ') : 'none yet'}${onDisk.length < 8 ? '   (missing: ' + WING_FILES.filter(n => !onDisk.includes(n)).join(', ') + ')' : ''}`);

  console.log('1. the wares: wings in the cape slot, colourways, wacky hair colours');
  for (const sex of ['m', 'f']) eq(J(g, `DOLL.${sex}.cape.map(p => p[0]).slice(-4)`).join(), 'wingdemon,wingangel,wingdragon,wingfairy', `wings are the last four capes (${sex})`);
  eq(g.run(`DOLL.m.cape.find(p => p[0] === 'wingdemon')[1]`), 'Demon wings', 'the name');
  eq(J(g, 'DOLL_OPT_FILES').sort().join(), WING_FILES.slice().sort().join(), 'the eight wing files are loaded apart');
  ok(!J(g, 'DOLL_FILES').some(n => /wing/.test(n)), 'the ordinary loader does not wait for wings');
  ok(J(g, 'DOLL_FILES').every(n => fs.existsSync(path.join(DOLL_DIR, n + '.png'))), 'every ordinary doll file exists on disk');
  const shopHair = J(g, `HAIR_COLORS.filter(c => c[3] === 'shop').map(c => c[0])`);
  for (const c of ['pink', 'green', 'blue', 'purple', 'teal', 'fire', 'white']) ok(shopHair.includes(c), 'shop hair colour ' + c);
  ok(shopHair.length >= 8, 'at least one extra fun hair colour');
  ok(J(g, 'HAIR_COLORS').every(c => /^#[0-9a-f]{6}$/.test(c[2])), 'hair colours are flat tints');
  eq(J(g, `HAIR_COLORS.filter(c => c[3] !== 'shop').map(c => c[0])`).join(), 'black,brown,chestnut,auburn,blonde,silver', 'the six free hair colours are unchanged');
  ok(J(g, 'DOLL_DYES').length >= 6, 'about six colourways'); eq(J(g, 'DOLL_DYE_SLOTS').join(), 'head,top,cape,bottom,shoe', 'dyeable slots');
  eq(JSON.stringify(J(g, 'DOLL_PRICE')), '{"wing":1000,"hc":150,"dye":120}', 'prices');
  eq(g.run(`dollShopId('cape', 'wingdemon')`), 'wing:demon', 'id of wings'); eq(g.run(`dollShopId('hc', 'pink')`), 'hc:pink', 'id of a hair colour');
  eq(g.run(`dollShopId('topC', 'crimson')`), 'dye:top:crimson', 'id of a colourway'); eq(g.run(`dollShopId('cape', 'knight')`), null, 'a cape is not a shop thing');
  eq(g.run(`dollShopId('hc', 'brown')`), null, 'brown hair is free'); eq(g.run(`dollShopId('hairC', 'crimson')`), null, 'hair has no colourway');

  console.log('2. looks: cleaning, round trips, hostile input');
  const base = { v: 2, sex: 'm', s: 'fair', hc: 'brown', hair: 'crop', head: 'helm', top: 'plate', cape: 'knight', bottom: 'greaves', shoe: 'boots' };
  const clean = l => J(g, `dollClean(${JSON.stringify(l)})`);
  eq(JSON.stringify(clean(base)), JSON.stringify(base), 'a look without colours comes back exactly as before (no new fields)');
  const dyed = Object.assign({}, base, { headC: 'gold', topC: 'crimson', capeC: 'royal', bottomC: 'midnight', shoeC: 'snow', hc: 'pink' });
  eq(JSON.stringify(clean(dyed)), JSON.stringify(Object.assign({}, base, { hc: 'pink' }, { headC: 'gold', topC: 'crimson', capeC: 'royal', bottomC: 'midnight', shoeC: 'snow' })), 'colourways and a shop hair colour survive');
  eq(JSON.stringify(clean(clean(dyed))), JSON.stringify(clean(dyed)), 'cleaning twice changes nothing');
  eq(JSON.stringify(clean(JSON.parse(JSON.stringify(clean(dyed))))), JSON.stringify(clean(dyed)), 'through JSON and back');
  eq(clean(Object.assign({}, base, { cape: 'wingangel', capeC: 'crimson' })).capeC, undefined, 'wings take no colourway');
  eq(clean(Object.assign({}, base, { cape: 'wingangel' })).cape, 'wingangel', 'wings are a valid cape');
  eq(clean(Object.assign({}, base, { cape: '', capeC: 'crimson' })).capeC, undefined, 'no colourway without a piece');
  for (const bad of ['nope', '', 5, null, {}, ['crimson'], 'constructor', '__proto__', 'x'.repeat(5000), true]) { const c = clean(Object.assign({}, base, { topC: bad })); ok(!('topC' in c), 'hostile topC dropped: ' + String(JSON.stringify(bad)).slice(0, 20)); }
  eq(clean(Object.assign({}, base, { hc: 'rainbow' })).hc, 'brown', 'an unknown hair colour falls back');
  eq(Object.keys(clean(Object.assign({}, dyed, { hairC: 'crimson', wepC: 'gold', sC: 'x', junk: 1, tc: { top: 'gold' } }))).join(), 'v,sex,s,hc,hair,head,top,cape,bottom,shoe,headC,topC,capeC,bottomC,shoeC', 'only known fields come out');
  eq(g.run(`JSON.stringify(dollClean(JSON.parse('{"v":2,"__proto__":{"topC":"gold"},"top":"plate"}')))`).includes('topC'), false, 'nothing through __proto__');
  for (const junk of ['null', 'undefined', '7', '"x"', '[]', '{ v: 2, top: {}, cape: 9, capeC: [] }']) ok(g.run(`(() => { try { const l = cleanLook(${junk}, 'warrior'); return l.v === 2 && typeof l.cape === 'string'; } catch (e) { return false; } })()`), 'cleanLook survives ' + junk);
  // over the network: another player's look is cleaned but NOT checked against what I own
  const prof = J(g, `netCleanProfile({ name: 'Zed', cls: 'archer', look: ${JSON.stringify(Object.assign({}, dyed, { cape: 'wingdemon' }))} })`);
  eq(prof.look.cape, 'wingdemon', "a friend's wings arrive"); eq(prof.look.topC, 'crimson', "a friend's colourway arrives"); eq(prof.look.hc, 'pink', "a friend's pink hair arrives"); eq(prof.look.capeC, undefined, 'their wings carry no colourway');
  eq(g.run(`MP.econ.owns('wing:demon')`), false, '(I own none of it)');
  const oldKind = J(g, `cleanLook({ sex: 'f', o: 1, h: 'long', hc: 'blonde', s: 'tan' }, 'archer')`);
  ok(oldKind.v === 2 && oldKind.sex === 'f' && oldKind.hc === 'blonde' && !('topC' in oldKind), 'a pre-doll look still converts');

  console.log('3. what I own: locks, and a saved look with things I do not own');
  eq(g.run(`lookLock('cape', 'wingdemon', 'm')`), 'Sold at the Cosmetics Shop (1000 Gold)', 'wings are locked');
  eq(g.run(`lookLock('hc', 'pink', 'm')`), 'Sold at the Cosmetics Shop (150 Gold)', 'pink hair is locked');
  eq(g.run(`lookLock('topC', 'crimson', 'm')`), 'Sold at the Cosmetics Shop (120 Gold)', 'a colourway is locked');
  eq(g.run(`lookLock('hc', 'brown', 'm')`), null, 'brown hair is not'); eq(g.run(`lookLock('cape', 'ranger', 'm')`), null, 'a free cape is not');
  ok(/Shadow Wolf/.test(g.run(`lookLock('cape', 'knight', 'm')`) || ''), 'earned pieces keep their own lock text');
  const setSaved = l => g.run(`SAVE.skin.warrior = ${JSON.stringify(l.sex)}; SAVE.skin.warriorLook = ${JSON.stringify(l)}; G.cls = 'warrior';`);
  setSaved(Object.assign({}, dyed, { cape: 'wingdemon' }));
  let L = J(g, `heroLook('warrior')`);
  eq(L.cape, '', 'un-owned wings in an edited save are not worn'); eq(L.hc, 'brown', 'un-owned hair colour falls back to brown'); ok(!('topC' in L) && !('shoeC' in L), 'un-owned colourways are dropped'); eq(L.top, 'plate', 'the rest of the look stays');
  eq(g.run(`SAVE.skin.warriorLook.cape`), 'wingdemon', '(the save itself is not rewritten)');
  eq(J(g, `netProfile().look`).cape, '', 'and it is not what other players are sent');
  g.run(`MP.econ.grant('wing:demon'); MP.econ.grant('hc:pink'); MP.econ.grant('dye:top:crimson');`);
  L = J(g, `heroLook('warrior')`);
  eq(L.cape, 'wingdemon', 'owned wings are worn'); eq(L.hc, 'pink', 'owned hair colour'); eq(L.topC, 'crimson', 'owned colourway'); ok(!('shoeC' in L), 'the other colourways still are not');
  eq(g.run(`lookLock('cape', 'wingdemon', 'm')`), null, 'no lock on owned wings');
  g.run(`window.__econ = MP.econ; delete MP.econ;`);
  L = J(g, `heroLook('warrior')`); eq(L.cape, '', 'without mp/econ.js nothing from the shop is worn'); eq(g.run(`lookLock('hc', 'pink', 'm')`), 'Sold at the Cosmetics Shop (150 Gold)', 'and it shows as locked');
  g.run(`MP.econ = window.__econ; MP.econ.data.own = {}; MP.econ.save();`);

  console.log('4. the sheet: baked once per look, the same canvas every frame, the common grid');
  g.setWings(WING_FILES);   // (as if all the wings had arrived: the code path is the same for every one)
  const looks = [];
  for (const sex of ['m', 'f']) {
    const st = J(g, `dollClean(Object.assign({ v: 2, sex: '${sex}' }, DOLL_START.archer.${sex}))`);
    for (const cape of J(g, `DOLL.${sex}.cape.map(p => p[0])`)) looks.push(Object.assign({}, st, { cape }));
    for (const sl of ['head', 'top', 'cape', 'bottom', 'shoe']) for (const d of J(g, 'DOLL_DYES.map(d => d[0])')) looks.push(clean(Object.assign({}, st, { [sl]: st[sl] || J(g, `DOLL.${sex}.${sl}[0][0]`), [sl + 'C']: d })));
    for (const hc of shopHair) looks.push(Object.assign({}, st, { hc }));
  }
  let badBake = 0, badKey = 0, badCanvas = 0, badGrid = 0; const keys = new Set();
  for (const look of looks) {
    const r = J(g, `(() => {
      const L = ${JSON.stringify(look)}, b0 = DOLL_STATS.baked, d0 = DOLL_STATS.dyed; let key = null, cv = null, sameKey = true, sameCv = true, drawn = 0, grid = true;
      for (let f = 0; f < 300; f++) {
        const an = ['idle', 'run', 'jump'][Math.floor(f / 100)], k = heroSheet('archer', L);
        if (f === 0) { key = k; cv = ART['anim/' + k]; }
        if (k !== key) sameKey = false; if (ART['anim/' + k] !== cv) sameCv = false;
        if (drawAnim(k, an, f * 0.17, 100, 100, 1, { scale: 3 })) drawn++;
      }
      const A = window.ANIMS[key];
      for (const an of ['idle', 'run', 'jump', 'death', 'attack']) for (const fr of A.anims[an]) if (fr[2] !== 96 || fr[3] !== 56 || fr[4] !== 48 || fr[5] !== 48 || fr[0] % 96 || fr[1] % 56 || fr[0] + 96 > cv.width || fr[1] + 56 > cv.height) grid = false;
      return { key, baked: DOLL_STATS.baked - b0, dyed: DOLL_STATS.dyed - d0, sameKey, sameCv, drawn, grid, w: cv.width, h: cv.height };
    })()`);
    if (r.baked !== 1 || r.dyed > 1 || r.drawn !== 300) badBake++; if (!r.sameKey || keys.has(r.key)) badKey++; if (!r.sameCv || r.w !== 768 || r.h !== 280) badCanvas++; if (!r.grid) badGrid++;
    keys.add(r.key);
  }
  console.log(`   ${looks.length} looks (every cape and wing, every colourway of every slot, every shop hair colour; both bodies), 300 frames each`);
  eq(badBake, 0, 'every look is baked exactly once for 300 frames of idle / run / jump (and its piece dyed at most once)');
  eq(badKey, 0, 'every look has its own sheet name, the same on every frame'); eq(badCanvas, 0, 'the same 768x280 canvas on every frame'); eq(badGrid, 0, 'every frame is a 96x56 cell with the feet at (48, 48)');
  const again = J(g, `(() => { const b0 = DOLL_STATS.baked, d0 = DOLL_STATS.dyed; for (const L of ${JSON.stringify(looks)}) heroSheet('archer', L); return [DOLL_STATS.baked - b0, DOLL_STATS.dyed - d0]; })()`);
  eq(again.join(), '0,0', 'asking for all of them again bakes and dyes nothing');
  ok(/wingdemon/.test(g.run(`heroSheet('warrior', ${JSON.stringify(Object.assign({}, base, { cape: 'wingdemon' }))})`)), 'wings are part of the sheet name');
  ok(/plate~crimson/.test(g.run(`heroSheet('warrior', ${JSON.stringify(Object.assign({}, base, { topC: 'crimson' }))})`)), 'a colourway is part of the sheet name');
  // a dyed piece is shared by every look that wears it
  eq(J(g, `(() => { const d0 = DOLL_STATS.dyed; heroSheet('warrior', ${JSON.stringify(Object.assign({}, base, { topC: 'forest', hc: 'black' }))}); heroSheet('rogue', ${JSON.stringify(Object.assign({}, base, { topC: 'forest', hc: 'silver', cape: '' }))}); return DOLL_STATS.dyed - d0; })()`), 1, 'one dyed piece serves several looks');
  // missing wing art: the hero is drawn without them (never invisible), and with them once the art is there
  g.setWings([]);
  const noWing = g.run(`heroSheet('warrior', ${JSON.stringify(Object.assign({}, base, { cape: 'wingfairy' }))})`);
  ok(noWing && !/wing/.test(noWing), 'missing wing art: the look is baked without wings'); eq(noWing, g.run(`heroSheet('warrior', ${JSON.stringify(Object.assign({}, base, { cape: '' }))})`), '... as the same sheet as the look with no cape');
  g.run(`DOLL_OPT.cape_wingfairy_m = 0;`); eq(g.run(`heroSheet('warrior', ${JSON.stringify(Object.assign({}, base, { cape: 'wingfairy', hc: 'black' }))})`), null, 'wing art on its way: wait (like any piece)');
  g.setWings(WING_FILES); ok(/wingfairy/.test(g.run(`heroSheet('warrior', ${JSON.stringify(Object.assign({}, base, { cape: 'wingfairy' }))})`)), 'once the art is there the wings are in');
  // the real loop: my hero in an owned wing + colourway walks about for 300 frames
  g.run(`MP.econ.grant('wing:angel'); MP.econ.grant('dye:top:royal');`); setSaved(Object.assign({}, base, { cape: 'wingangel', topC: 'royal' }));
  g.frames(3); const b1 = g.run('DOLL_STATS.baked');
  g.press('d'); g.frames(150); g.release('d'); g.press(' '); g.frames(20); g.release(' '); g.frames(130);
  eq(g.run('DOLL_STATS.baked') - b1, 0, 'walking and jumping for 300 real frames bakes nothing more');
  ok(/wingangel/.test(g.run(`heroSheet(G.cls)`)) && /plate~royal/.test(g.run(`heroSheet(G.cls)`)), 'and the hero wears the wings and the colour');
  g.run(`MP.econ.data.own = {}; MP.econ.save();`);

  console.log('5. the colour maths (pure functions): the same colour -> the same colour in every cell');
  // a made-up 8x5 sheet: a red fabric ramp, a gold trim, outlines, skin, a steel buckle; each cell has them in different
  // places and amounts, some semi-transparent
  const CW = 96, CH = 56, W = 768, H = 280;
  const PALS = { fabric: [[92, 20, 26], [140, 30, 38], [184, 44, 52], [214, 78, 84], [236, 130, 132]], trim: [[232, 186, 60], [176, 128, 30]], outline: [[18, 12, 14], [30, 22, 20]], skin: [[234, 192, 159], [201, 148, 103]], steel: [[150, 152, 158]] };
  function synth(mainName) {
    const d = new Uint8ClampedArray(W * H * 4); let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const all = Object.entries(PALS).flatMap(([k, cs]) => cs.map(c => [k, c]));
    for (let cell = 0; cell < 40; cell++) {
      const cx = (cell % 8) * CW, cy = Math.floor(cell / 8) * CH, n = 300 + Math.floor(rnd() * 500);
      for (let i = 0; i < n; i++) {
        const pick = rnd() < 0.6 ? [mainName, PALS[mainName][Math.floor(rnd() * PALS[mainName].length)]] : all[Math.floor(rnd() * all.length)];
        const o = ((cy + Math.floor(rnd() * CH)) * W + cx + Math.floor(rnd() * CW)) * 4;
        d[o] = pick[1][0]; d[o + 1] = pick[1][1]; d[o + 2] = pick[1][2]; d[o + 3] = rnd() < 0.1 ? 128 : 255;
      }
      all.forEach(([k, c], j) => { const o = ((cy + 1) * W + cx + 1 + j) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; });   /* every colour at least once per cell */
    }
    return d;
  }
  g.win.__px = null;
  const dyes = J(g, 'DOLL_DYES');
  const hsl = (r, gg, b) => J(g, `rgbHsl(${r}, ${gg}, ${b})`), key = (d, o) => (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
  for (const mainName of ['fabric', 'steel']) for (const dye of dyes) {
    const src = synth(mainName), out = new Uint8ClampedArray(src); g.win.__px = out;
    g.run(`dyePixels(__px, DOLL_DYES.find(d => d[0] === '${dye[0]}')[2])`);
    const maps = []; let alphaSame = true, clearSame = true;
    for (let cell = 0; cell < 40; cell++) {
      const m = new Map(), cx = (cell % 8) * CW, cy = Math.floor(cell / 8) * CH; let one = true;
      for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
        const o = ((cy + y) * W + cx + x) * 4;
        if (src[o + 3] !== out[o + 3]) alphaSame = false;
        if (!src[o + 3]) { if (key(src, o) !== key(out, o)) clearSame = false; continue; }
        const k = key(src, o), v = key(out, o); if (m.has(k) && m.get(k) !== v) one = false; m.set(k, v);
      }
      maps.push([m, one]);
    }
    const tag = `${dye[0]} on a ${mainName} piece: `, first = maps[0][0];
    ok(maps.every(([m, one]) => one), tag + 'inside a cell, one source colour gives one colour');
    ok(maps.every(([m]) => m.size === first.size && [...m].every(([k, v]) => first.get(k) === v)), tag + 'the colour -> colour table is identical in all 40 cells');
    ok(alphaSame && clearSame, tag + 'alpha and empty pixels untouched');
    const of = c => { const v = first.get((c[0] << 16) | (c[1] << 8) | c[2]); return [v >> 16, (v >> 8) & 255, v & 255]; }, same = c => of(c).join() === c.join();
    ok(PALS.outline.every(same), tag + 'outlines keep their colour'); ok(PALS.skin.every(same), tag + 'skin colours keep theirs');
    ok(PALS.trim.every(same), tag + 'the trim (another hue) keeps its colour');
    ok(PALS[mainName].every(c => !same(c)), tag + 'every shade of the main fabric changes');
    ok((mainName === 'fabric' ? PALS.steel : PALS.fabric).every(same), tag + 'the other material is left alone');
    const ramp = PALS[mainName].map(c => hsl(...of(c)));
    if (ramp.length > 1) ok(ramp.every((c, i) => !i || c[2] > ramp[i - 1][2] + 0.01), tag + 'the shading ramp stays a ramp (dark to light, no two shades merged)');
    ok(ramp.every(c => c[1] < 0.03 || Math.min(Math.abs(c[0] - dye[2].h), 360 - Math.abs(c[0] - dye[2].h)) < 6), tag + "the fabric takes the dye's hue");
    // the same call again gives the same picture (nothing random, nothing remembered)
    const out2 = new Uint8ClampedArray(src); g.win.__px = out2; g.run(`dyePixels(__px, DOLL_DYES.find(d => d[0] === '${dye[0]}')[2])`);
    ok(Buffer.from(out.buffer).equals(Buffer.from(out2.buffer)), tag + 'dyeing is repeatable');
  }
  ok(J(g, `(() => { for (let i = 0; i < 4000; i++) { const r = (i * 37) % 256, gg = (i * 91) % 256, b = (i * 53) % 256, [h, s, l] = rgbHsl(r, gg, b), o = hslRgb(h, s, l); if (Math.abs(o[0] - r) > 1 || Math.abs(o[1] - gg) > 1 || Math.abs(o[2] - b) > 1) return false; } return true; })()`), 'rgb -> hsl -> rgb is the identity (within rounding)');
  ok(J(g, `(() => { const d = new Uint8ClampedArray(64); return dyePixels(d, DOLL_DYES[0][2]) === 0 && dyePlan(d).l === 0.5; })()`), 'an empty piece is no trouble');

  console.log('6. the real art: sizes (the common grid) and the colourways on every real piece');
  const files = fs.readdirSync(DOLL_DIR).filter(f => f.endsWith('.png'));
  const body = pngSize(path.join(DOLL_DIR, 'base_m.png'));
  eq(`${body.w}x${body.h}`, '768x280', 'the body sheet is 8x5 cells of 96x56');
  for (const f of files) { const s = pngSize(path.join(DOLL_DIR, f)); if (!s || s.w !== 768 || s.h !== 280) ok(false, `${f} is ${s && s.w}x${s && s.h}, not on the 768x280 grid`); else checks++; }
  for (const n of onDisk) { const s = pngSize(path.join(DOLL_DIR, n + '.png')); eq(`${s.w}x${s.h}`, '768x280', `wing art ${n} is on the common grid`); }
  if (!onDisk.length) console.log('   (no wing art yet: its size is checked as soon as the files exist)');
  const sheetArg = process.argv.indexOf('--sheet'), sheetOut = sheetArg > 0 ? process.argv[sheetArg + 1] : null, strips = [];
  let pieces = 0, idleBad = 0, alphaBad = 0, unchanged = [], skinHeavy = [];
  for (const f of files.filter(f => /^(head|top|cape|bottom|shoe)_/.test(f) && !/^cape_wing/.test(f)).sort()) {
    const img = pngRead(path.join(DOLL_DIR, f)); if (!img) { console.log('   (skipped ' + f + ': not 8-bit RGB/RGBA)'); continue; }
    pieces++; const strip = [img.data];
    for (const dye of dyes) {
      const out = new Uint8ClampedArray(img.data); g.win.__px = out;
      const changed = g.run(`dyePixels(__px, DOLL_DYES.find(d => d[0] === '${dye[0]}')[2])`);
      if (!changed) unchanged.push(f + ':' + dye[0]);
      // the four idle cells are one drawing in the art: they must still be one drawing; and no pixel appears or vanishes
      for (let c = 1; c < 4; c++) for (let y = 0; y < CH && idleBad < 5; y++) for (let x = 0; x < CW; x++) {
        const a = (y * W + x) * 4, b = (y * W + c * CW + x) * 4;
        if (key(img.data, a) === key(img.data, b) && img.data[a + 3] === img.data[b + 3] && img.data[a + 3] && key(out, a) !== key(out, b)) { idleBad++; break; }
      }
      for (let o = 3; o < out.length; o += 4) if (out[o] !== img.data[o]) { alphaBad++; break; }
      strip.push(out);
    }
    let opaque = 0, skin = 0; for (let o = 0; o < img.data.length; o += 4) if (img.data[o + 3] > 8) { opaque++; const [h, s, l] = hslFast(img.data[o], img.data[o + 1], img.data[o + 2]); if (h >= 10 && h <= 34 && s >= 0.28 && s <= 0.8 && l >= 0.5 && l <= 0.9) skin++; }
    if (opaque && skin / opaque > 0.12) skinHeavy.push(`${f.replace('.png', '')} ${Math.round(100 * skin / opaque)}%`);
    strips.push([f, strip]);
  }
  console.log(`   ${pieces} real pieces x ${dyes.length} colourways dyed with the game's dyePixels`);
  eq(idleBad, 0, 'pixels that match across the idle cells still match after dyeing'); eq(alphaBad, 0, 'no pixel appears or vanishes');
  eq(unchanged.length, 0, 'every colourway changes every piece' + (unchanged.length ? ' (unchanged: ' + unchanged.slice(0, 8).join(', ') + ')' : ''));
  if (skinHeavy.length) console.log('   note: pieces with many skin-coloured pixels (those pixels are never dyed): ' + skinHeavy.join(', '));
  if (sheetOut) {   // rows = pieces, columns = as painted + each colourway; the first idle cell, 2x
    const cols = dyes.length + 1, Z = 2, sw = cols * CW * Z, sh = strips.length * CH * Z, sheet = new Uint8ClampedArray(sw * sh * 4);
    for (let o = 0; o < sheet.length; o += 4) { sheet[o] = 58; sheet[o + 1] = 52; sheet[o + 2] = 66; sheet[o + 3] = 255; }
    strips.forEach(([f, strip], r) => strip.forEach((d, c) => { for (let y = 0; y < CH * Z; y++) for (let x = 0; x < CW * Z; x++) { const s = (Math.floor(y / Z) * W + Math.floor(x / Z)) * 4, a = d[s + 3] / 255, o = ((r * CH * Z + y) * sw + c * CW * Z + x) * 4; for (let k = 0; k < 3; k++) sheet[o + k] = Math.round(d[s + k] * a + sheet[o + k] * (1 - a)); } }));
    pngWrite(sheetOut, sw, sh, sheet); console.log(`   contact sheet: ${sheetOut}  (rows: ${strips.map(s => s[0].replace('.png', '')).join(', ')}; columns: as painted, ${dyes.map(d => d[0]).join(', ')})`);
  }

  console.log('7. reading pixels refused (the game opened from a folder): a filter instead, still once');
  {
    const h = game({ name: 'Folder' }); h.setWings(WING_FILES);
    h.run(TAINT('"none"'));
    const r = J(h, `(() => { const L = ${JSON.stringify(Object.assign({}, base, { topC: 'crimson', capeC: 'gold' }))}; let k = null, same = true; for (let f = 0; f < 300; f++) { const kk = heroSheet('warrior', L); if (f && kk !== k) same = false; k = kk; drawAnim(k, 'run', f * 0.2, 50, 50); } return { k, same, baked: DOLL_STATS.baked, dyed: DOLL_STATS.dyed, how: DOLL_STATS.how, blocked: DYE_BLOCKED, tries: window.__made }; })()`);
    ok(r.k && r.same && r.baked === 1, 'the look is still baked once and reused'); eq(r.how, 'filter', 'through ctx.filter'); eq(r.blocked, true, 'the refusal is remembered'); eq(r.tries, 1, 'and pixels are asked for only once'); eq(r.dyed, 2, 'each piece coloured once');
    ok(J(h, 'DOLL_DYES').every(d => typeof d[4] === 'string' && d[4].length > 5), 'every colourway has a filter');
    const p = game({ name: 'NoFilter' });
    p.setWings(WING_FILES); p.run(TAINT('undefined'));
    ok(/plate~snow/.test(p.run(`heroSheet('warrior', ${JSON.stringify(Object.assign({}, base, { topC: 'snow' }))})`)) && p.run('DOLL_STATS.how') === 'plain', 'no filter either: the piece is drawn as painted, no error');
  }

  console.log('8. the dressing mirror: trying on is not keeping');
  g.setWings(WING_FILES); setSaved(base);
  g.run(`G.panel = null; openDress();`); g.frames(2);
  ok(J(g, `dressOptions('cape').map(o => o[0])`).includes('wingdemon'), 'wings are offered in the cape row');
  ok(J(g, `dressOptions('hc').map(o => o[0])`).includes('pink'), 'pink is offered in the hair colour row');
  g.run(`G.dress.look.cape = 'wingdemon'; G.dress.look.hc = 'pink'; G.dress.sel = DRESS_ROWS.findIndex(r => r[0] === 'top'); dressDye('top', 1);`);
  eq(g.run('G.dress.look.topC'), J(g, 'DOLL_DYES[0][0]'), 'C / the square puts the first colourway on the top');
  g.frames(3);
  ok(/wingdemon/.test(g.run(`heroSheet(G.cls, G.dress.look)`)) && /~/.test(g.run(`heroSheet(G.cls, G.dress.look)`)), 'the mirror shows them on (try-on)');
  g.run(`dressDye('cape', 1)`); eq(g.run('G.dress.look.capeC'), undefined, 'no colourway button for wings');
  g.run(`dressDone()`);
  L = J(g, `SAVE.skin.warriorLook`);
  eq(L.cape, 'knight', 'un-owned wings are not kept: back to the cape worn before'); eq(L.hc, 'brown', 'un-owned hair colour is not kept'); ok(!('topC' in L), 'un-owned colourway is not kept'); eq(g.run('G.panel'), null, 'the mirror closed');
  ok(/buy/.test(g.run('G.msg') || ''), 'and it says so');
  g.run(`MP.econ.grant('wing:demon'); MP.econ.grant('hc:pink'); MP.econ.grant('dye:top:crimson'); openDress(); G.dress.look.cape = 'wingdemon'; G.dress.look.hc = 'pink'; G.dress.look.topC = 'crimson'; G.dress.look.shoeC = 'gold'; dressDone();`);
  L = J(g, `SAVE.skin.warriorLook`);
  eq(L.cape, 'wingdemon', 'owned wings are kept'); eq(L.hc, 'pink', 'owned hair colour is kept'); eq(L.topC, 'crimson', 'owned colourway is kept'); ok(!('shoeC' in L), 'the un-owned one next to it is not');
  // cycling a colourway goes all the way round; changing the piece keeps it; taking the piece off drops it; the other body keeps it
  g.run(`openDress();`);
  const cyc = J(g, `(() => { const out = []; G.dress.look.topC = undefined; delete G.dress.look.topC; for (let i = 0; i <= DOLL_DYES.length; i++) { dressDye('top', 1); out.push(G.dress.look.topC || ''); } return out; })()`);
  eq(cyc.join(), dyes.map(d => d[0]).concat(['']).join(), 'the colourways in order, then back to as painted');
  g.run(`G.dress.look.topC = 'crimson'; dressStep('top', 1);`); eq(g.run('G.dress.look.topC'), 'crimson', 'another top keeps the colour');
  g.run(`dressStep('sex', 1);`); eq(g.run('G.dress.look.sex'), 'f', 'the other body'); eq(g.run('G.dress.look.topC'), 'crimson', '... keeps the colourway'); eq(g.run('G.dress.look.cape'), 'wingdemon', '... and the wings');
  g.run(`G.dress.look.top = DOLL.f.top[0][0]; dressStep('top', -1);`); eq(g.run('G.dress.look.top'), '', 'no top'); eq(g.run('G.dress.look.topC'), undefined, '... no colourway left behind');
  for (const port of [false, true]) {
    g.setPortrait(port); g.run(`G.dress.sel = DRESS_ROWS.findIndex(r => r[0] === 'cape'); G.dress.look.cape = DOLL.f.cape[0][0]; G.dress.look.capeC = 'snow';`);
    let threw = ''; try { g.frames(4); g.tap('c'); for (const row of J(g, 'DRESS_ROWS.map(r => r[0])')) { const i = J(g, `DRESS_ROWS.findIndex(r => r[0] === '${row}')`); g.clickR(J(g, `DRESS_ARROW(${i}, 1)`)); g.frame(); if (g.run(`dressDyeable(G.dress.look, '${row}')`)) { g.clickR(J(g, `DRESS_DYE(${i})`)); g.frame(); } } } catch (e) { threw = String(e.stack || e).slice(0, 300); }
    eq(threw, '', `the mirror draws and takes clicks in ${port ? 'portrait' : 'landscape'}`);
    eq(g.run('G.panel'), 'dress', '... and is still open');
    const rects = J(g, `DRESS_ROWS.map((r, i) => [DRESS_ARROW(i, -1), DRESS_DYE(i), DRESS_ARROW(i, 1), DRESS_ROW(i)])`);
    ok(rects.every(([a, d, b, row]) => a.x + a.w <= d.x && d.x + d.w <= b.x && d.x >= row.x && b.x + b.w <= row.x + row.w + 1), '... the colour square sits between the arrows, inside the row');
  }
  g.setPortrait(false); g.tap('Escape'); eq(g.run('G.panel'), null, 'Esc leaves the mirror unchanged');
  // missing wing art: not offered in the mirror
  g.setWings(['cape_wingdemon_m']); g.run(`openDress(); G.dress.look.sex = 'm';`);
  eq(J(g, `dressOptions('cape').map(o => o[0]).filter(dollWing)`).join(), 'wingdemon', 'only the wings whose art arrived are offered'); g.run(`G.panel = null; G.dress = null;`);

  console.log('9. the shop: shelves, previews, buying, wearing');
  g.setWings(WING_FILES); setSaved(base); g.run(`MP.econ.data.own = {}; MP.econ.data.gold = 0; MP.econ.save();`);
  eq(typeof g.run(`MP.stations.mp_shop`), 'function', 'the street station opens the shop');
  g.run(`MP.stations.mp_shop()`); eq(g.run('G.panel'), 'mpshop', 'the panel is open'); g.frames(3);
  const all = J(g, 'MP.shop.allItems()');
  eq(all.filter(i => i.kind === 'wing').length, 4, 'four wings'); eq(all.filter(i => i.kind === 'hc').length, shopHair.length, 'every shop hair colour'); eq(all.filter(i => i.kind === 'dye').length, 5 * dyes.length, 'every colourway for every slot');
  ok(all.every(i => (i.kind === 'wing' ? i.price === 1000 : i.kind === 'hc' ? i.price === 150 : i.price === 120)), 'prices: wings 1000, hair 150, colours 120');
  eq(new Set(all.map(i => i.id)).size, all.length, 'ids are unique'); ok(all.every(i => /^[a-z0-9][a-z0-9:_.-]{0,47}$/i.test(i.id)), 'ids are ones MP.econ accepts');
  ok(all.every(i => g.run(`dollShopId(${JSON.stringify(i.kind === 'wing' ? 'cape' : i.kind === 'hc' ? 'hc' : i.slot + 'C')}, ${JSON.stringify(i.kind === 'wing' ? i.piece : i.kind === 'hc' ? i.hc : i.dye)})`) === i.id), 'the shop and the mirror agree on every id');
  const st = i => g.run(`MP.shop.state(MP.shop.items()[${i}])`), S = k => g.run(`MP.shop._.S.${k}`);
  eq(st(0), 'poor', 'no Gold: not enough'); eq(g.run(`MP.shop._.action(MP.shop.items()[0])[0]`), 'Not enough Gold', 'the button says so');
  let Y = g.lay(); g.clickR(Y.act); eq(S('confirm'), null, 'pressing it does nothing'); eq(g.run(`MP.shop.buy(MP.shop.items()[0])`), false, 'and buying is refused');
  // the preview is the try-on: my hero with the chosen thing, standing or running; nothing is saved
  ok(/wingdemon/.test(g.run(`MP.shop._.sheet(MP.shop.lookWith(MP.shop.items()[0]))`) || ''), 'the preview wears the wings (the real heroSheet)');
  eq(J(g, 'SAVE.skin.warriorLook').cape, 'knight', 'trying on changes nothing saved');
  eq(S('run'), false, 'standing first'); g.clickR(Y.runR); eq(S('run'), true, 'the toggle makes it run'); g.frames(5); g.tap('t'); eq(S('run'), false, 'T toggles too');
  g.run(`MP.econ.add(1500, 'test')`); eq(st(0), 'buy', 'with Gold: for sale'); eq(g.run(`MP.shop._.action(MP.shop.items()[0])[0]`), 'Buy', 'the button says Buy');
  g.clickR(Y.act); eq(S('confirm.id'), 'wing:demon', 'Buy asks first'); eq(g.run('MP.econ.gold()'), 1500, 'nothing paid yet'); g.frames(2);
  g.clickR(Y.no); eq(S('confirm'), null, '"Not now" backs out'); eq(g.run('MP.econ.gold()'), 1500, 'still nothing paid'); eq(g.run(`MP.econ.owns('wing:demon')`), false, 'nothing owned');
  g.clickR(Y.act); g.frames(2); g.clickR(Y.yes);
  eq(g.run('MP.econ.gold()'), 500, '1000 Gold paid'); eq(g.run(`MP.econ.owns('wing:demon')`), true, 'the wings are mine'); eq(st(0), 'owned', 'the shelf says Owned'); eq(S('confirm'), null, 'the question is gone');
  eq(J(g, `heroLook('warrior')`).cape, 'knight', 'bought is not yet worn');
  eq(g.run(`MP.shop.buy(MP.shop.items()[0])`), false, 'it cannot be bought twice'); eq(g.run('MP.econ.gold()'), 500, '(no second payment)');
  eq(g.run(`MP.shop._.action(MP.shop.items()[0])[0]`), 'Wear now', 'the button is now Wear now'); g.clickR(Y.act);
  eq(J(g, 'SAVE.skin.warriorLook').cape, 'wingdemon', 'Wear now saves the look'); eq(J(g, `heroLook('warrior')`).cape, 'wingdemon', 'and I wear it'); eq(st(0), 'worn', 'the shelf says Wearing');
  ok(JSON.parse(g.store[g.run(`sk('packrat_skin')`)]).warriorLook.cape === 'wingdemon', 'the look is in storage'); ok(JSON.parse(g.store[g.run(`sk('packrat_econ')`)]).own['wing:demon'] === 1, 'ownership is in storage');
  eq(J(g, `netProfile().look`).cape, 'wingdemon', 'other players are sent the wings');
  eq(st(1), 'poor', '500 Gold left: the next wings are too dear');
  // keys: the hair shelf, pick with the arrows, Enter = buy, Enter = yes, Enter = wear
  g.tap('3'); eq(S('tab'), 2, 'key 3: the hair shelf'); g.tap('ArrowRight'); eq(S('sel'), 1, 'arrow: the next card');
  const hairIt = J(g, 'MP.shop.items()[1]');
  g.tap('Enter'); eq(S('confirm.id'), hairIt.id, 'Enter: buy?'); g.tap('Escape'); eq(S('confirm'), null, 'Esc: no'); eq(g.run('G.panel'), 'mpshop', '(the shop stays open)');
  g.tap('Enter'); g.tap('Enter'); eq(g.run(`MP.econ.owns(${JSON.stringify(hairIt.id)})`), true, 'Enter, Enter: bought'); eq(g.run('MP.econ.gold()'), 350, '150 Gold paid');
  g.tap('Enter'); eq(J(g, `heroLook('warrior')`).hc, hairIt.hc, 'Enter again: worn'); eq(J(g, `heroLook('warrior')`).cape, 'wingdemon', 'the wings stay on');
  // a colourway: worn on the piece I have; with wings on my back a cape colour comes with the first cape
  g.tap('q'); eq(S('tab'), 1, 'Q: the colour shelf');
  const dyeItems = J(g, 'MP.shop.items()'), topI = dyeItems.findIndex(i => i.slot === 'top'), capeI = dyeItems.findIndex(i => i.slot === 'cape');
  g.run(`MP.shop._.S.sel = ${topI}`); g.tap('Enter'); g.tap('Enter'); g.tap('Enter');
  eq(g.run('MP.econ.gold()'), 230, '120 Gold paid'); eq(J(g, `heroLook('warrior')`).topC, dyeItems[topI].dye, 'the top wears the colour'); eq(J(g, `heroLook('warrior')`).top, 'plate', 'on the top I had');
  eq(J(g, `MP.shop.lookWith(MP.shop.items()[${capeI}])`).cape, 'ranger', 'a cape colour is previewed on the first cape when I wear wings');
  eq(g.run(`MP.shop.wear(MP.shop.items()[${capeI}])`), false, 'wearing something I do not own is refused'); eq(J(g, `heroLook('warrior')`).cape, 'wingdemon', '(nothing changed)');
  // no Gold is ever given back; a full wardrobe (MP.econ refuses the grant) gives the Gold back instead of eating it
  g.run(`window.__grant = MP.econ.grant; MP.econ.grant = () => false;`); const gBefore = g.run('MP.econ.gold()');
  eq(g.run(`MP.shop.buy(MP.shop.items()[${capeI}])`), false, 'a refused grant is not a sale'); eq(g.run('MP.econ.gold()'), gBefore, 'and costs nothing'); g.run(`MP.econ.grant = window.__grant;`);
  // wings whose art is missing: shown as arriving soon, never sold
  g.setWings(['cape_wingdemon_m', 'cape_wingdemon_f']); g.tap('1'); g.run(`MP.econ.add(5000, 'test')`); g.frames(2);
  eq(st(1), 'soon', 'missing art: arriving soon'); eq(g.run(`MP.shop._.action(MP.shop.items()[1])[0]`), 'Arriving soon', 'the button says so');
  const g2 = g.run('MP.econ.gold()'); g.run(`MP.shop._.S.sel = 1`); g.clickR(g.lay().act); g.tap('Enter'); eq(S('confirm'), null, 'no question'); eq(g.run(`MP.shop.buy(MP.shop.items()[1])`), false, 'not sold'); eq(g.run('MP.econ.gold()'), g2, 'no Gold taken');
  g.setWings(WING_FILES); eq(st(1), 'buy', 'once the art arrives it is for sale');
  // both layouts, every shelf: drawn, scrolled (wheel, drag, keys), cards picked by a tap
  for (const port of [false, true]) {
    g.setPortrait(port); let threw = '';
    try {
      for (let t = 0; t < 3; t++) {
        g.clickR(g.lay().tabs[t]); g.frames(3); Y = g.lay(); eq(S('tab'), t, `${port ? 'portrait' : 'landscape'}: tab ${t} by a click`);
        const n = J(g, 'MP.shop.items().length');
        ok(Y.box.x >= 0 && Y.box.x + Y.box.w <= (port ? 540 : 960) && Y.box.y >= 0 && Y.box.y + Y.box.h <= (port ? 900 : 540), '... the panel is on the screen');
        for (const r of [Y.pv, Y.act, Y.runR, Y.view, Y.closeR, ...Y.tabs]) ok(r.w > 20 && r.h > 20 && r.x >= Y.box.x && r.x + r.w <= Y.box.x + Y.box.w && r.y >= Y.box.y && r.y + r.h <= Y.box.y + Y.box.h, '... every part is inside the panel');
        ok(!(Y.act.x < Y.view.x + Y.view.w && Y.act.x + Y.act.w > Y.view.x && Y.act.y < Y.view.y + Y.view.h && Y.act.y + Y.act.h > Y.view.y), '... the button does not cover the shelf');
        // a tap on the second card picks it
        const c1 = J(g, `MP.shop._.card(MP.shop._.layout(), 1)`); g.clickR(c1); eq(S('sel'), 1, '... a tap picks a card');
        if (Y.max > 0) {
          g.run(`MP.panels.mpshop.wheel(99999)`); g.frame(); eq(S('scroll'), Y.max, '... the wheel scrolls to the end and stops'); g.run(`MP.panels.mpshop.wheel(-99999)`); g.frame(); eq(S('scroll'), 0, '... and back to the top');
          g.down(Y.view.x + 40, Y.view.y + Y.view.h - 20); g.run(`mouse.y -= 90`); g.frame(); g.frame(); const sc = S('scroll'), selWas = S('sel'); g.up();
          ok(sc >= Math.min(60, Y.max), '... a drag scrolls the shelf'); eq(S('sel'), selWas, '... and does not pick a card');
          for (let i = 0; i < n + 2; i++) g.tap('ArrowDown'); eq(S('sel'), n - 1, '... arrow down ends on the last card');
          const cl = J(g, `MP.shop._.card(MP.shop._.layout(), ${n - 1})`), V = g.lay().view; ok(cl.y >= V.y - 1 && cl.y + cl.h <= V.y + V.h + 1, '... which is scrolled into view');
          for (let i = 0; i < n + 2; i++) g.tap('ArrowUp'); ok(S('sel') < Y.cols && S('scroll') === 0, '... arrow up comes back to the first row');
        } else ok(Y.rows * (Y.ch + Y.gap) - Y.gap <= Y.view.h, '... everything fits without scrolling');
        g.frames(40);   /* (long enough for every card in view to get its preview) */
      }
      g.run(`MP.shop._.S.confirm = MP.shop.items()[0]`); g.frames(2); Y = g.lay(); ok(Y.yes.x >= Y.cb.x && Y.no.x + Y.no.w <= Y.cb.x + Y.cb.w && Y.cb.x >= 0 && Y.cb.x + Y.cb.w <= (port ? 540 : 960), '... the question fits'); g.run(`MP.shop._.S.confirm = null`);
    } catch (e) { threw = String(e.stack || e).slice(0, 400); }
    eq(threw, '', `the shop draws and works in ${port ? 'portrait' : 'landscape'}`);
  }
  g.setPortrait(false);
  // the shelves bake at most one new look per frame; closing forgets the looks only the previews used
  g.run(`MP.shop.close(); MP.shop.open(); MP.shop._.S.tab = 1;`);
  const bakes = []; for (let i = 0; i < 30; i++) { const b = g.run('DOLL_STATS.baked'); g.frame(); bakes.push(g.run('DOLL_STATS.baked') - b); }
  ok(Math.max(...bakes) <= 2, 'a shelf bakes at most one card (plus the big preview) per frame (most in a frame: ' + Math.max(...bakes) + ')'); ok(bakes.slice(-5).every(b => b === 0), 'and then nothing more: the previews reuse their sheets');
  const mineKey = g.run('heroSheet(G.cls)'), nBefore = J(g, `Object.keys(window.ANIMS).filter(k => k.startsWith('doll:')).length`);
  g.tap('Escape'); eq(g.run('G.panel'), null, 'Esc closes the shop');
  const nAfter = J(g, `Object.keys(window.ANIMS).filter(k => k.startsWith('doll:')).length`);
  ok(nAfter < nBefore, `closing drops the preview sheets (${nBefore} -> ${nAfter})`); ok(g.run(`!!(window.ANIMS[${JSON.stringify(mineKey)}] && ART['anim/' + ${JSON.stringify(mineKey)}])`), 'but never the one I wear');
  eq(g.run('DYE_CACHE.size'), 0, 'and the dyed pieces'); g.frames(3); eq(g.run('heroSheet(G.cls)'), mineKey, 'my hero is drawn as before');
  g.run(`MP.shop.open()`); g.tap('e'); eq(g.run('G.panel'), null, 'E closes it too');
  g.run(`MP.shop.open()`); g.run(`mouse.x = 5; mouse.y = 5; onMouseDown(2); onMouseUp(2);`); eq(g.run('G.panel'), null, 'and so does a right click');
  g.run(`MP.shop.open()`); g.clickR(g.lay().closeR); eq(g.run('G.panel'), null, 'and the Leave button');
  // Gold only ever goes down in the shop
  eq(g.run('MP.econ.gold()'), 1500 + 5000 - (1000 + 150 + 120), 'in all the purse paid for the wings, a hair colour and a colourway, nothing else');

  console.log('10. a save that claims things, another player, and no purse');
  // a fresh game loading a save whose look has shop things but whose purse owns nothing
  {
    const store = {}; const a = game({ name: 'Edit', storage: store });
    a.setWings(WING_FILES);
    a.run(`SAVE.skin.warrior = 'f'; SAVE.skin.warriorLook = { v: 2, sex: 'f', s: 'tan', hc: 'teal', hair: 'bob', head: '', top: 'corset', topC: 'gold', cape: 'wingdragon', bottom: 'slim', shoe: 'boots' }; saveData();`);
    const b = game({ name: 'Edit', storage: store }); b.setWings(WING_FILES); b.run(`G.cls = 'warrior'`);
    const l = J(b, `heroLook('warrior')`);
    eq(l.cape, '', 'reloaded: un-owned wings fall away'); eq(l.hc, 'brown', 'reloaded: un-owned hair colour falls back'); ok(!('topC' in l), 'reloaded: un-owned colourway falls away'); eq(l.top, 'corset', 'the honest part of the look stays');
    let threw = ''; try { b.frames(20); } catch (e) { threw = String(e).slice(0, 200); } eq(threw, '', 'and the game draws');
    ok(b.run('heroSheet(G.cls)') && !/wing|~/.test(b.run('heroSheet(G.cls)')), 'the sheet has no shop things');
    // another player's look is drawn as sent, whatever I own
    const o = J(b, `netCleanProfile({ name: 'Rich', cls: 'rogue', look: { v: 2, sex: 'm', s: 'deep', hc: 'fire', hair: 'mohawk', head: 'hood', headC: 'amethyst', top: 'mage', topC: 'snow', cape: 'wingdragon', bottom: 'kilt', shoe: 'fur' } })`);
    const k = b.run(`heroSheet('rogue', ${JSON.stringify(o.look)})`);
    ok(/wingdragon/.test(k) && /fire/.test(k) && /mage~snow/.test(k) && /hood~amethyst/.test(k), "another player's wings, hair and colours are drawn as sent: " + k);
    // no mp/econ.js: the shop is closed, nothing crashes, E leaves
    b.run(`delete MP.econ; MP.stations.mp_shop();`); threw = '';
    try { b.frames(3); b.setPortrait(true); b.frames(3); b.setPortrait(false); b.clickAt(480, 270); } catch (e) { threw = String(e.stack || e).slice(0, 300); }
    eq(threw, '', 'without MP.econ the closed shop draws in both layouts'); eq(b.run('G.panel'), null, 'and a click leaves it');
    b.run(`MP.stations.mp_shop()`); b.tap('e'); eq(b.run('G.panel'), null, 'E leaves it'); eq(b.run(`MP.shop.buy(MP.shop.items()[0])`), false, 'nothing can be bought');
  }

  console.log(`\n${checks - fails}/${checks} checks passed` + (fails ? `, ${fails} FAILED` : ''));
  process.exit(fails ? 1 : 0);
}
function hslFast(r, g, b) {
  r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn; if (d < 1e-9) return [0, 0, l];
  const s = d / (l > 0.5 ? 2 - mx - mn : mx + mn), h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [h * 60, s, l];
}
main();
