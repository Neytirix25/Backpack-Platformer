// Headless boot of the game for tests and simulations (node tools/mp_tests/<something>.js).
// bootGame() runs index.html's script (plus anims.js and every mp/*.js) inside its own vm context with a stubbed
// canvas / audio / storage, so several copies of the game can live in one process (one per simulated player).
//   const g = bootGame({ name: 'A' });  g.run('enterHub()');  g.run('G.mode');  g.step(60)   (60 frames of update + draw)
//   g.ctx is the game's global object (window): put test transports there, read globals with g.run('expr').
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let SRC = null;
function sources() {
  if (SRC) return SRC;
  const html = read('index.html');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const mp = [...html.matchAll(/<script src="(mp\/[^"?]+)/g)].map(m => m[1]).filter(f => fs.existsSync(path.join(ROOT, f)));
  return (SRC = { anims: read('assets/anim/anims.js'), bgfx: fs.existsSync(path.join(ROOT, 'assets/bgfx/bgfx.js')) ? read('assets/bgfx/bgfx.js') : '', inline, mp: mp.map(f => [f, read(f)]) });
}
function bootGame(opt = {}) {
  const S = sources(), noop = () => {};
  const grad = { addColorStop: noop };
  const mk2d = () => new Proxy({}, { get: (t, k) => {
    if (k === 'createRadialGradient' || k === 'createLinearGradient' || k === 'createPattern') return () => grad;
    if (k === 'measureText') return s => ({ width: String(s).length * 7 });
    if (k === 'getImageData' || k === 'createImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)), width: w | 0, height: h | 0 });
    if (k === 'canvas') return t.canvas;
    return k in t ? t[k] : noop;
  }, set: (t, k, v) => { t[k] = v; return true; } });
  const mkCanvas = () => { const c = { width: 960, height: 540, style: {}, addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }), toDataURL: () => '', focus: noop, blur: noop }; const x = mk2d(); x.canvas = c; c.getContext = () => x; return c; };
  const el = () => Object.assign(mkCanvas(), { classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, appendChild: noop, removeChild: noop, setAttribute: noop, click: noop, children: [], value: '', innerHTML: '', textContent: '', select: noop, remove: noop });
  const els = {};
  const store = opt.storage || {};
  const win = {
    console, Math: Object.create(Math), JSON, Date, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Uint8Array, Uint8ClampedArray, Float32Array, Map, Set, WeakMap, Proxy, Symbol, Array, Object, String, Number, Boolean, RegExp, Error, TypeError, parseInt, parseFloat, isNaN, isFinite, Reflect, Intl, encodeURIComponent, decodeURIComponent, structuredClone,
    innerWidth: 960, innerHeight: 540, devicePixelRatio: 1, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }),
    location: { href: 'http://test/Backpack%20Sanctuary/index.html', pathname: '/Backpack%20Sanctuary/index.html', search: opt.search || '', protocol: 'http:', reload: noop }, navigator: { userAgent: 'node', maxTouchPoints: 0, clipboard: { writeText: () => Promise.resolve() } },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }, key: i => Object.keys(store)[i] || null, get length() { return Object.keys(store).length; } },
    document: { getElementById: id => els[id] || (els[id] = el()), createElement: () => el(), addEventListener: noop, removeEventListener: noop, body: el(), head: el(), documentElement: el(), fonts: { add: noop, ready: Promise.resolve(), load: () => Promise.resolve([]) }, querySelector: () => null, querySelectorAll: () => [], hidden: false, activeElement: null },
    Image: function () { this.addEventListener = noop; }, FontFace: function () { this.load = () => Promise.resolve(this); }, Audio: function () {}, AudioContext: undefined, webkitAudioContext: undefined,
    performance: { now: () => win.__now }, requestAnimationFrame: f => { win.__raf = f; return 1; }, cancelAnimationFrame: noop, __now: 0, __raf: null, fetch: () => Promise.reject(new Error('no fetch in tests')),
    URL: { createObjectURL: () => '', revokeObjectURL: noop }, Blob: function () {}, FileReader: function () {}, atob: s => Buffer.from(s, 'base64').toString('binary'), btoa: s => Buffer.from(s, 'binary').toString('base64'),
    BroadcastChannel: undefined, TextEncoder, TextDecoder, crypto: { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; } },
  };
  win.window = win; win.self = win; win.globalThis = win; win.top = win;
  if (opt.globals) Object.assign(win, opt.globals);
  const ctx = vm.createContext(win);
  const run = (code, file = 'test') => vm.runInContext(code, ctx, { filename: file });
  run(S.anims, 'anims.js'); if (S.bgfx) run(S.bgfx, 'bgfx.js');
  run(S.inline, 'index.html');
  for (const [f, src] of S.mp) run(src, f);
  if (opt.name) run(`SAVE.skin.name = ${JSON.stringify(opt.name)};`);
  // step(n): n frames at 60 fps (update + draw, like the real loop, clearing one-frame key presses)
  const step = (n = 1, drawToo = true) => { for (let i = 0; i < n; i++) { win.__now += 1000 / 60; run(drawToo ? 'update(1/60); draw(); pressed = {};' : 'update(1/60); pressed = {};'); } };
  const press = k => run(`pressed[${JSON.stringify(k)}] = true; keys[${JSON.stringify(k)}] = true;`);
  const release = k => run(`keys[${JSON.stringify(k)}] = false;`);
  // giveTeam(['dog', 'fox', 'owl'], 12): three animals of that level, as the active team (front, middle, back)
  const giveTeam = (ks, lvl = 10) => run(`(() => { if (!G) enterHub(); G.panel = null; const its = ${JSON.stringify(ks)}.map(k => { const it = unlockPet(k, ${lvl}, rollGenes({ shiny: false })); it.plvl = ${lvl}; return it; }); petSlots = [its[0] || null, its[1] || null, its[2] || null]; savePets(); return petSlots.filter(Boolean).map(i => i.def.pet + ':' + petLvl(i)).join(','); })()`);
  return { ctx, win, run, step, press, release, store, giveTeam };
}
module.exports = { bootGame, ROOT };
if (require.main === module) {   // smoke test: boot, enter the Sanctuary, walk a little
  const g = bootGame({ name: 'Tester' });
  g.run('enterHub()'); g.step(120); console.log('team:', g.giveTeam(['dog', 'fox', 'owl'], 12));
  console.log('booted:', g.run('G.mode'), g.run('G.hubRoom'), 'herd', g.run('HERD.length'), 'panel', g.run('G.panel'));
}
