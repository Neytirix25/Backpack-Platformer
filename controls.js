// =====================================================================
//  CONTROLS (window.CTRL) — the pause menu's Controls screen, and the three ways to play:
//    · Keyboard: every action can be moved to other keys (two keys each). A rebound key "types" the action's own key
//      (the one the game reads: 'a' for left, 'w' for jump ...), so nothing else in the game changes. Keys that were
//      taken away from an action do nothing while walking about (menus keep their usual keys).
//    · Mouse: the hero runs toward the cursor (a stop zone round the hero), a quick flick of the mouse UP jumps (the
//      harder the flick, the higher), a flick DOWN drops through a ledge, a right click uses / talks, a double click
//      dashes. A left click stays with the buttons on screen. The keyboard still works too.
//    · Controller (the browser Gamepad API, "standard" layout): left stick / D-pad move, A jump, B dash, X use,
//      Y backpack, LB pets, RB map, Start pause, Back music (A/B can be swapped for Nintendo-style pads). In menus the
//      D-pad moves the highlight, A chooses, B goes back; in battles the D-pad steps through the moves (and then the
//      targets) and A picks. Anything else on screen: the right stick moves a pointer, RT clicks, LT right-clicks.
//      A controller works whenever one is plugged in; the toggle says which one you mean to play with (hints, mouse).
//  Everything presses the game's own keys behind the scenes (keys / pressed, like the touch controls' vkey), so the
//  game reads mouse and controller exactly like the keyboard. Settings are this device's (localStorage), not a save's.
//  Hooks in index.html: the keydown/keyup listeners (remap), mousemove/mousedown/dblclick, update() (tick),
//  frame() (drawOver), the pause menu (pauseItems / pauseDo / pauseKeys / pauseClick / drawPauseMenu).
// =====================================================================
(() => {
  const CTRL = window.CTRL = {};
  const STORE = 'bps_controls';
  // [id, name, the key the game reads, its default keys]
  const ACTIONS = [
    ['left', 'Move left', 'a', ['a', 'ArrowLeft']], ['right', 'Move right', 'd', ['d', 'ArrowRight']],
    ['jump', 'Jump / climb', 'w', ['w', 'ArrowUp']], ['drop', 'Drop down', 's', ['s', 'ArrowDown']],
    ['dash', 'Dash', 'Shift', ['Shift', 'l']], ['use', 'Use / talk', 'e', ['e', '']],
    ['pack', 'Backpack', 'b', ['b', 'Tab']], ['pets', 'Pets', 't', ['t', '']], ['map', 'Map', 'n', ['n', '']],
    ['pause', 'Pause', 'p', ['p', 'Escape']], ['music', 'Music', 'm', ['m', '']] ];
  const DEF = () => ({ mode: 'keyboard', binds: Object.fromEntries(ACTIONS.map(a => [a[0], a[3].slice()])), dead: 16, flick: 900, swapAB: false });
  let S = DEF();
  try { const j = JSON.parse(localStorage.getItem(STORE) || 'null'); if (j && typeof j === 'object') {
    S = Object.assign(DEF(), j); S.binds = Object.assign(DEF().binds, j.binds || {});
    for (const a of ACTIONS) { const b = S.binds[a[0]]; S.binds[a[0]] = Array.isArray(b) ? [String(b[0] || ''), String(b[1] || '')] : a[3].slice(); }
    if (!['keyboard', 'mouse', 'controller'].includes(S.mode)) S.mode = 'keyboard';
    S.dead = Math.max(4, Math.min(60, +S.dead || 16)); S.flick = Math.max(400, Math.min(2200, +S.flick || 900)); S.swapAB = !!S.swapAB;
  } } catch (e) {}
  const store = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) {} };
  CTRL.mode = () => S.mode;
  CTRL.settings = S;

  // ---------- keyboard: the remap ----------
  let MAP = null, OWNED = null;   // bound key -> the game's key; every key any action had by default
  function build() {
    MAP = {}; OWNED = new Set();
    for (const a of ACTIONS) { for (const k of a[3]) if (k) OWNED.add(k); for (const k of S.binds[a[0]]) if (k) MAP[k] = a[2]; }
  }
  build();
  const typingNow = () => (typeof NET !== 'undefined' && NET.typing) || (typeof accShown === 'function' && accShown()) ||
    (typeof MP !== 'undefined' && MP.auction && MP.auction.S && MP.auction.S.typing) || CAP.on;
  const held = {};   // physical key -> the key it pressed (so its release always lets go of the same one)
  const phys = new Set();   // game keys held down on the keyboard right now
  // keydown: returns the key the game should see ('' = none)
  CTRL.down = function (k) {
    if (CAP.on) { capture(k); return ''; }
    if (typingNow()) return k;
    let out = k;
    if (MAP[k] !== undefined) out = MAP[k];
    else if (OWNED.has(k) && typeof worldControls === 'function' && worldControls()) out = '';   // a key taken from its action: nothing while walking about
    held[k] = out; if (out) phys.add(out);
    return out;
  };
  CTRL.up = function (k) {
    const out = held[k] !== undefined ? held[k] : (MAP[k] !== undefined ? MAP[k] : k); delete held[k];
    if (out) phys.delete(out);
    return V.has(out) ? '' : out;   // (still held by the mouse or a controller: keep it down)
  };

  // ---------- virtual keys (mouse and controller press the game's keys) ----------
  const V = new Map();   // game key -> set of sources holding it
  function vset(src, k, on) {
    let s = V.get(k);
    if (on) { if (!s) V.set(k, (s = new Set())); if (!s.size && !keys[k]) pressed[k] = true; s.add(src); keys[k] = true; }
    else if (s && s.has(src)) { s.delete(src); if (!s.size) { V.delete(k); if (!phys.has(k)) keys[k] = false; } }
  }
  const taps = [];   // [game key, frames left]
  function vtapK(k) { if (!keys[k]) pressed[k] = true; keys[k] = true; taps.push([k, 2]); }
  function releaseAll(src) { for (const [k, s] of [...V]) if (s.has(src)) vset(src, k, false); }

  // ---------- mouse ----------
  const M = { inside: false, hist: [], jumpT: 0, dropCd: 0 };
  CTRL.mouseMove = function () { M.inside = true; M.hist.push([performance.now(), mouse.y]); if (M.hist.length > 12) M.hist.shift(); };
  CTRL.mouseLeave = function () { M.inside = false; };
  const mouseOn = () => S.mode === 'mouse' && !(typeof TOUCH !== 'undefined' && TOUCH.on) && typeof worldControls === 'function' && worldControls();
  // a right click while walking about uses (true: the click was taken)
  CTRL.mouseDown = function (btn) {
    if (!mouseOn() || btn !== 2) return false;
    vtapK('e'); return true;
  };
  CTRL.dblclick = function () { if (!mouseOn()) return; const P = G.player, d = mouse.x - heroScreenX(); if (Math.abs(d) > 4) P.face = d > 0 ? 1 : -1; vtapK('Shift'); };   // (dashes toward the cursor's side)
  // where the hero rests on screen: against the camera's TARGET (its look-ahead included), not the camera mid-glide.
  // Against the gliding camera the hero would never stop: the camera catching up slides him back under a still cursor.
  function heroScreenX() {
    const P = G.player, R = G.room, tx = Math.max(0, Math.min(Math.max(0, R.wpx - W), P.x + P.w / 2 - W / 2 + P.face * 50));
    return P.x + P.w / 2 - tx;
  }
  function mouseTick(dt) {
    if (!mouseOn() || !M.inside || (PORTRAIT() && mouse.y > 540)) { releaseAll('mouse'); M.jumpT = 0; return; }
    const dx = mouse.x - heroScreenX();
    vset('mouse', 'a', dx < -S.dead); vset('mouse', 'd', dx > S.dead);
    // a flick: how fast the cursor went up or down over the last tenth of a second (screen px per second)
    const now = performance.now(), h = M.hist.filter(q => now - q[0] < 100);
    let vy = 0; if (h.length >= 2) { const a = h[0], b = h[h.length - 1]; vy = (b[1] - a[1]) / Math.max(16, b[0] - a[0]) * 1000; }
    M.dropCd -= dt;
    if (vy < -S.flick && M.jumpT <= 0) { M.jumpT = Math.min(0.32, 0.1 + (-vy - S.flick) / 6000 + 0.1); vset('mouse', 'w', true); M.hist.length = 0; }
    if (M.jumpT > 0) { M.jumpT -= dt; if (M.jumpT <= 0) vset('mouse', 'w', false); }
    if (vy > S.flick && M.dropCd <= 0) { vtapK('s'); M.dropCd = 0.35; M.hist.length = 0; }
  }

  // ---------- controller ----------
  const PAD = { id: '', prev: [], used: -99, rep: {}, focus: 0, fkey: '', ptr: false, ptrT: -99, lastPick: null };
  const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
  function readPad() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    const p = pads.find(q => q.connected && q.mapping === 'standard') || pads.find(q => q.connected);
    PAD.id = p ? p.id : ''; return p;
  }
  CTRL.padName = () => PAD.id;
  const padUsedRecently = () => TIME - PAD.used < 6;
  function padTick(dt) {
    const p = readPad();
    if (!p) { releaseAll('pad'); return; }
    const b = i => { const q = p.buttons[i]; return !!q && (q.pressed || q.value > 0.5); };
    const swap = i => (S.swapAB && (i === 0 || i === 1) ? 1 - i : i);
    const now = p.buttons.map((_, i) => b(swap(i)));
    const edge = i => now[i] && !PAD.prev[i];
    const ax = p.axes[0] || 0, ay = p.axes[1] || 0, rx = p.axes[2] || 0, ry = p.axes[3] || 0;
    if (now.some(Boolean) || Math.abs(ax) > 0.5 || Math.abs(ay) > 0.5 || Math.hypot(rx, ry) > 0.3) PAD.used = TIME;
    const L = now[BTN.LEFT] || ax < -0.45, R = now[BTN.RIGHT] || ax > 0.45, U = now[BTN.UP] || ay < -0.6, D = now[BTN.DOWN] || ay > 0.6;
    const world = typeof worldControls === 'function' && worldControls();
    if (world) {
      vset('pad', 'a', L); vset('pad', 'd', R); vset('pad', 'w', now[BTN.A] || U); vset('pad', 's', D);
      vset('pad', 'Shift', now[BTN.B]);
      if (edge(BTN.X)) vtapK('e'); if (edge(BTN.Y)) vtapK('b'); if (edge(BTN.LB)) vtapK('t'); if (edge(BTN.RB)) vtapK('n');
    } else {
      releaseAll('pad');
      // menus and battles: the D-pad (and stick) with key repeat, A / B, the shoulder buttons as [ ]
      const dirs = [['ArrowLeft', L], ['ArrowRight', R], ['ArrowUp', U], ['ArrowDown', D]];
      for (const [k, on] of dirs) {
        const r = PAD.rep[k] || (PAD.rep[k] = { t: 0, on: false });
        if (on && !r.on) { r.t = 0.38; nav(k); } else if (on) { r.t -= dt; if (r.t <= 0) { r.t = 0.11; nav(k); } }
        r.on = on;
      }
      if (edge(BTN.A)) padA();
      if (edge(BTN.B)) { if (inBattleFocus()) { if (B.pick) B.pick = null; else vtapK('Escape'); } else vtapK('Escape'); }
      if (edge(BTN.LB)) vtapK('['); if (edge(BTN.RB)) vtapK(']');
      if (edge(BTN.Y)) vtapK('b');
    }
    if (edge(BTN.START)) vtapK('p');
    if (edge(BTN.BACK)) vtapK('m');
    // the pointer: the right stick moves the mouse, RT clicks, LT right-clicks
    const mag = Math.hypot(rx, ry);
    if (mag > 0.22) {
      const sp = 700 * Math.min(1, (mag - 0.22) / 0.7);
      mouse.x = Math.max(0, Math.min(W, mouse.x + rx / mag * sp * dt)); mouse.y = Math.max(0, Math.min(H, mouse.y + ry / mag * sp * dt));
      PAD.ptr = true; PAD.ptrT = TIME;
    }
    if (edge(BTN.RT)) { PAD.ptrT = TIME; click(0); }
    if (edge(BTN.LT)) { PAD.ptrT = TIME; click(2); }
    PAD.prev = now;
    if (inBattleFocus()) battleFocusTick();
  }
  function click(btn) { try { onMouseDown(btn); onMouseUp(btn); } catch (e) { console.error(e); } }
  function nav(k) { if (inBattleFocus()) battleNav(k); else vtapK(k); }
  function padA() { if (inBattleFocus()) { syncFocus(); const t = focusList()[PAD.focus]; if (t) { aim(t.r); click(0); } } else vtapK('Enter'); }

  // ---------- battles: the D-pad steps through the moves (then the targets), A picks ----------
  const inBattleFocus = () => !!(typeof G !== 'undefined' && G && G.mode === 'battle' && typeof B !== 'undefined' && B && B.phase === 'player' && !B.coop && !B.intro && B.allies && B.allies[B.cur]);
  function focusList() {
    if (B.pick) return [...B.allies, ...B.foes].filter(u => { try { return pickValid(u); } catch (e) { return false; } }).map(u => ({ r: unitRect(u), u }));
    const u = B.allies[B.cur];
    return [...abilityRects(u).map(r => ({ r })), ...itemRects().map(r => ({ r }))];
  }
  function aim(r) { mouse.x = r.x + r.w / 2; mouse.y = r.y + r.h / 2; }
  function syncFocus() { const key = (B.pick ? 'pick:' : 'move:') + B.cur; if (PAD.fkey !== key) { PAD.fkey = key; PAD.focus = 0; } }   // (a new turn or a new pick starts at the first entry)
  function battleNav(k) {
    syncFocus(); const L = focusList(); if (!L.length) return;
    const d = k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 1;
    PAD.focus = (PAD.focus + d + L.length) % L.length; aim(L[PAD.focus].r);
    try { SFX.play('rotate'); } catch (e) {}
  }
  function battleFocusTick() {
    syncFocus(); const L = focusList(); if (!L.length) return;
    PAD.focus = Math.min(PAD.focus, L.length - 1);
    if (padUsedRecently() && !PAD.ptr) aim(L[PAD.focus].r);
  }

  // ---------- each frame ----------
  CTRL.tick = function (dt) {
    for (let i = taps.length - 1; i >= 0; i--) { if (--taps[i][1] <= 0) { const k = taps[i][0]; taps.splice(i, 1); if (!V.has(k) && !phys.has(k)) keys[k] = false; } }
    try { mouseTick(dt); } catch (e) { releaseAll('mouse'); }
    try { padTick(dt); } catch (e) { releaseAll('pad'); }
    if (TIME - PAD.ptrT > 3) PAD.ptr = false;
  };
  // drawn last, over everything: the controller's pointer and its battle highlight
  CTRL.drawOver = function () {
    if (!PAD.id || !padUsedRecently()) return;
    ctx.save();
    if (inBattleFocus() && !PAD.ptr) {
      const L = focusList(), t = L[PAD.focus];
      if (t) { const r = t.r; ctx.strokeStyle = PAL.gold; ctx.lineWidth = 3; ctx.globalAlpha = 0.6 + 0.4 * Math.sin(TIME * 8); rr(r.x - 4, r.y - 4, r.w + 8, r.h + 8, 8); ctx.stroke(); }
    }
    if (PAD.ptr) {   // the pointer
      ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1a0e06'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(mouse.x, mouse.y); ctx.lineTo(mouse.x + 13, mouse.y + 9); ctx.lineTo(mouse.x + 7, mouse.y + 10); ctx.lineTo(mouse.x + 4, mouse.y + 16); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  };

  // ---------- the Controls screen (in the pause menu) ----------
  const CAP = { on: false, act: null, slot: 0 };   // waiting for a key to bind
  const UIS = { open: false, sel: 0, scroll: 0, drag: null, note: '', noteT: 0 };
  CTRL.isOpen = () => UIS.open;
  CTRL.open = function () { UIS.open = true; UIS.sel = 0; UIS.scroll = 0; CAP.on = false; try { SFX.play('pick'); } catch (e) {} };
  CTRL.close = function () { UIS.open = false; CAP.on = false; UIS.drag = null; store(); try { SFX.play('pick'); } catch (e) {} };
  const MODES = [['keyboard', 'Keyboard'], ['mouse', 'Mouse'], ['controller', 'Controller']];
  const NICE = { ' ': 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Shift: 'Shift', Tab: 'Tab', Enter: 'Enter', Control: 'Ctrl', Alt: 'Alt', Backspace: 'Bksp' };
  const keyName = k => (!k ? '—' : NICE[k] || (k.length === 1 ? k.toUpperCase() : k));
  function note(t) { UIS.note = t; UIS.noteT = 2.4; }
  function capture(k) {
    if (k === 'Escape') { CAP.on = false; note('Unchanged.'); return; }
    const a = CAP.act, b = S.binds[a];
    if (k === 'Backspace' || k === 'Delete') { b[CAP.slot] = ''; CAP.on = false; build(); store(); note('Key cleared.'); return; }
    for (const x of ACTIONS) { const bx = S.binds[x[0]]; for (let i = 0; i < 2; i++) if (bx[i] === k && !(x[0] === a && i === CAP.slot)) { bx[i] = ''; note(`${keyName(k)} moved from ${x[1]}.`); } }
    b[CAP.slot] = k; CAP.on = false; build(); store(); if (!UIS.noteT) note(`${ACTIONS.find(x => x[0] === a)[1]}: ${keyName(k)}`);
    try { SFX.play('merge'); } catch (e) {}
  }
  // layout (landscape 960x540 or portrait 540 x tall)
  function L() {
    const port = PORTRAIT(), w = port ? W - 16 : 800, h = port ? Math.min(H - 16, 980) : 500, x = (W - w) / 2, y = port ? Math.max(8, (H - h) / 2) : 20;
    return { port, x, y, w, h, tabs: MODES.map((m, i) => ({ x: x + 24 + i * ((w - 48) / 3), y: y + 64, w: (w - 48) / 3 - 10, h: 38 })), body: { x: x + 24, y: y + 114, w: w - 48, h: h - 114 - 64 }, done: { x: x + w - 170, y: y + h - 54, w: 150, h: 40 }, reset: { x: x + 20, y: y + h - 54, w: 190, h: 40 } };
  }
  const rowH = () => (PORTRAIT() ? 44 : 27);
  function keyRows() { const l = L(), rh = rowH(); return ACTIONS.map((a, i) => { const y = l.body.y + 24 + i * rh - UIS.scroll; return { a, y, slots: [0, 1].map(s => ({ x: l.body.x + l.body.w - (l.port ? 250 : 300) + s * (l.port ? 128 : 152), y: y + 2, w: l.port ? 120 : 140, h: rh - 6 })) }; }); }
  function sliders() {
    const l = L(), x = l.body.x + (l.port ? 10 : 240), w = l.body.w - (l.port ? 20 : 280), y0 = l.body.y + (l.port ? 300 : 210);
    return [{ id: 'dead', name: 'Stop zone round the hero', lo: 4, hi: 60, x, y: y0, w, h: 22, fmt: v => `${Math.round(v)} px` },
      { id: 'flick', name: 'How hard a flick must be', lo: 400, hi: 2200, x, y: y0 + (l.port ? 90 : 76), w, h: 22, fmt: v => (v < 750 ? 'gentle' : v < 1300 ? 'medium' : 'strong') + ` (${Math.round(v)})` }];
  }
  const swapRect = () => { const l = L(); return { x: l.body.x + (l.port ? 10 : 20), y: l.body.y + l.body.h - 50, w: l.port ? l.body.w - 20 : 330, h: 40 }; };
  CTRL.draw = function () {
    const l = L(); UIS.noteT = Math.max(0, UIS.noteT - 1 / 60);
    panel(l.x, l.y, l.w, l.h, 'leather');
    banner('Controls', W / 2, l.y + 4, { size: 30, h: 48, pad: 110 });
    MODES.forEach(([id, nm], i) => button(l.tabs[i], (S.mode === id ? '● ' : '') + nm, { on: S.mode === id, hover: inRect(mouse, l.tabs[i]), size: 15, color: S.mode === id ? PAL.gold : PAL.cream }));
    const b = l.body;
    ctx.save(); ctx.beginPath(); ctx.rect(b.x - 4, b.y, b.w + 8, b.h); ctx.clip();
    if (S.mode === 'keyboard') {
      label('Click a key to change it (Backspace clears it, Esc cancels). Menus keep their usual keys.', b.x, b.y + 10, { size: 12, color: PAL.dim });
      keyRows().forEach(({ a, y, slots }, i) => {
        if (y < b.y + 18 || y > b.y + b.h - 10) return;
        const sel = UIS.sel === i;
        if (sel) { ctx.fillStyle = 'rgba(255,211,107,0.12)'; rr(b.x - 6, y, b.w + 12, rowH() - 2, 6); ctx.fill(); }
        label(a[1], b.x + 8, y + rowH() / 2, { size: 15, bold: true, color: sel ? PAL.gold : PAL.cream });
        slots.forEach((r, s) => {
          const wait = CAP.on && CAP.act === a[0] && CAP.slot === s;
          button(r, wait ? 'press a key…' : keyName(S.binds[a[0]][s]), { hover: inRect(mouse, r), on: wait, size: 13, color: wait ? PAL.gold : S.binds[a[0]][s] ? PAL.cream : PAL.dim });
        });
      });
    } else if (S.mode === 'mouse') {
      const lines = ['The hero runs toward the cursor (it stands still inside the stop zone).', 'Flick the mouse UP to jump (a harder flick jumps higher), DOWN to drop through a ledge.',
        'Right click: use / talk.   Double click: dash.', 'Left click is for the buttons on screen. The keyboard still works too.'];
      lines.forEach((t, i) => label(fitText(t, b.w - 10), b.x + 4, b.y + 20 + i * (l.port ? 34 : 26), { size: l.port ? 13 : 14, color: i === 3 ? PAL.dim : PAL.cream }));
      for (const s of sliders()) {
        const v = S[s.id], f = (v - s.lo) / (s.hi - s.lo);
        label(s.name, s.x, s.y - 18, { size: 14, bold: true, color: UIS.sel === sliders().indexOf(s) || sliders().findIndex(q => q.id === s.id) === UIS.sel ? PAL.gold : PAL.cream });
        label(s.fmt(v), s.x + s.w, s.y - 18, { size: 13, align: 'right', color: PAL.gold });
        ctx.fillStyle = '#2a1a10'; rr(s.x, s.y + 7, s.w, 8, 4); ctx.fill();
        ctx.fillStyle = PAL.gold; rr(s.x, s.y + 7, s.w * f, 8, 4); ctx.fill();
        ctx.fillStyle = '#ffe9b0'; ctx.beginPath(); ctx.arc(s.x + s.w * f, s.y + 11, 10, 0, 7); ctx.fill(); ctx.strokeStyle = '#4a2e14'; ctx.lineWidth = 2; ctx.stroke();
      }
    } else {
      const name = PAD.id ? 'Connected: ' + PAD.id : 'No controller found: plug one in and press any button.';
      label(fitText(name, b.w - 10), b.x + 4, b.y + 14, { size: 13, color: PAD.id ? '#a5d6a7' : '#ffab91' });
      const ab = S.swapAB ? ['B', 'A'] : ['A', 'B'];
      const map = [['Left stick / D-pad', 'move · up climbs · down drops'], [ab[0], 'jump'], [ab[1], 'dash'], ['X', 'use / talk'], ['Y', 'backpack'], ['LB / RB', 'pets / map'],
        ['Start', 'pause'], ['Back', 'music'], ['Menus', `D-pad moves · ${ab[0]} chooses · ${ab[1]} back`], ['Battles', `D-pad: move, then target · ${ab[0]}`], ['Right stick', 'pointer · RT / LT click']];
      const col = l.port ? 1 : 2, cw = b.w / col, rh2 = l.port ? 36 : 34;
      map.forEach(([k, t], i) => {
        const cx = b.x + (i % col) * cw, cy = b.y + 44 + Math.floor(i / col) * rh2;
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; rr(cx, cy, cw - 12, rh2 - 6, 6); ctx.fill();
        label(k, cx + 10, cy + (rh2 - 6) / 2, { size: 13, bold: true, color: PAL.gold });
        label(fitText(t, cw - 150), cx + 140, cy + (rh2 - 6) / 2, { size: 13, color: PAL.cream });
      });
      const sr = swapRect();
      button(sr, S.swapAB ? '✓ A and B swapped (Nintendo style)' : 'Swap A and B (Nintendo style)', { hover: inRect(mouse, sr), on: S.swapAB, size: 13 });
    }
    ctx.restore();
    if (S.mode === 'keyboard') button(l.reset, 'Reset keys', { hover: inRect(mouse, l.reset), size: 14 });
    button(l.done, 'Done', { hover: inRect(mouse, l.done), size: 16, color: PAL.gold });
    const hint = UIS.noteT > 0 ? UIS.note : TOUCH.on ? 'Tap a choice' : S.mode === 'mouse' ? '[ ] mode  ·  ↑/↓ slider  ·  ←/→ move it  ·  Esc back' : S.mode === 'controller' ? '←/→ mode  ·  Enter swaps A/B  ·  Esc back' : '←/→ mode  ·  ↑/↓ pick  ·  Enter change  ·  Esc back';
    ctx.font = `12px ${UI}`; label(fitText(hint, l.w - 400 < 200 ? l.w - 40 : l.w - 400), l.port ? W / 2 : l.x + l.w / 2 - 20, l.port ? l.y + l.h - 62 : l.y + l.h - 34, { size: 12, align: 'center', color: UIS.noteT > 0 ? PAL.gold : PAL.dim });
  };
  function setMode(m) { if (S.mode !== m) { S.mode = m; store(); releaseAll('mouse'); try { SFX.play('rotate'); } catch (e) {} } }
  function sliderAt(p) { return sliders().find(s => p.x >= s.x - 12 && p.x <= s.x + s.w + 12 && p.y >= s.y - 4 && p.y <= s.y + s.h + 4); }
  function slideTo(s, x) { S[s.id] = Math.round(s.lo + Math.max(0, Math.min(1, (x - s.x) / s.w)) * (s.hi - s.lo)); }
  CTRL.click = function (btn) {
    const l = L(); if (btn !== 0) { if (CAP.on) { CAP.on = false; note('Unchanged.'); } return; }
    if (CAP.on) { CAP.on = false; note('Unchanged.'); return; }
    for (let i = 0; i < MODES.length; i++) if (inRect(mouse, l.tabs[i])) { setMode(MODES[i][0]); return; }
    if (inRect(mouse, l.done)) { CTRL.close(); return; }
    if (S.mode === 'keyboard') {
      if (inRect(mouse, l.reset)) { S.binds = DEF().binds; build(); store(); note('Keys reset.'); return; }
      keyRows().forEach(({ a, slots }, i) => slots.forEach((r, s) => { if (inRect(mouse, r) && r.y > l.body.y + 18) { UIS.sel = i; CAP.on = true; CAP.act = a[0]; CAP.slot = s; } }));
    } else if (S.mode === 'mouse') {
      const s = sliderAt(mouse); if (s) { UIS.drag = s; slideTo(s, mouse.x); }
    } else if (inRect(mouse, swapRect())) { S.swapAB = !S.swapAB; store(); try { SFX.play('pick'); } catch (e) {} }
  };
  CTRL.mouseUpUI = function () { if (UIS.drag) { UIS.drag = null; store(); } };
  CTRL.keys = function () {
    if (CAP.on) return;
    if (UIS.drag && typeof mouse !== 'undefined') slideTo(UIS.drag, mouse.x);
    if (hit('Escape', 'p')) { CTRL.close(); return; }
    const mi = MODES.findIndex(m => m[0] === S.mode);
    if (S.mode === 'mouse' && hit('ArrowLeft', 'ArrowRight')) { const s = sliders()[Math.min(UIS.sel, 1)]; S[s.id] = Math.max(s.lo, Math.min(s.hi, S[s.id] + (hit('ArrowLeft') ? -1 : 1) * (s.hi - s.lo) / 20)); store(); }
    else if (hit('ArrowLeft')) setMode(MODES[(mi + 2) % 3][0]);
    else if (hit('ArrowRight')) setMode(MODES[(mi + 1) % 3][0]);
    if (hit('[')) setMode(MODES[(mi + 2) % 3][0]);
    if (hit(']')) setMode(MODES[(mi + 1) % 3][0]);
    const n = S.mode === 'keyboard' ? ACTIONS.length : S.mode === 'mouse' ? 2 : 1;
    if (hit('ArrowUp')) UIS.sel = (UIS.sel + n - 1) % n;
    if (hit('ArrowDown')) UIS.sel = (UIS.sel + 1) % n;
    UIS.sel = Math.min(UIS.sel, n - 1);
    if (S.mode === 'keyboard') {   // keep the chosen row in view
      const rh = rowH(), l = L(), top = UIS.sel * rh, vis = l.body.h - 40;
      if (top - UIS.scroll > vis - rh) UIS.scroll = top - vis + rh; if (top < UIS.scroll) UIS.scroll = top;
      if (hit('Enter')) { CAP.on = true; CAP.act = ACTIONS[UIS.sel][0]; CAP.slot = 0; }
    } else if (S.mode === 'controller' && hit('Enter')) { S.swapAB = !S.swapAB; store(); }
  };
  CTRL.wheel = function (d) { if (S.mode !== 'keyboard') return; const max = Math.max(0, ACTIONS.length * rowH() - (L().body.h - 40)); UIS.scroll = Math.max(0, Math.min(max, UIS.scroll + d)); };
  CTRL.ACTIONS = ACTIONS;
  CTRL._ = { S, V, phys, MAP: () => MAP, PAD, M, focusList, inBattleFocus, keyName, reset: () => { Object.assign(S, DEF()); build(); store(); } };
})();
