// =====================================================================
//  THE COSMETICS SHOP (MP.shop) — Gold buys looks for the paper-doll hero. Nothing here is tradeable or refundable.
//
//  WHAT IS SOLD (the wares themselves are data in index.html, next to DOLL: DOLL_WINGS, DOLL_DYES, HAIR_COLORS,
//  DOLL_PRICE; the code that draws them is THE HERO section there: heroSheet bakes a look ONCE into one sheet):
//    · Wings (1000 Gold): worn in the cape slot (cape ids 'wingdemon', 'wingangel', 'wingdragon', 'wingfairy').
//      Owned as 'wing:demon' ... (one purchase covers both bodies). Art: assets/doll/cape_wing<kind>_<m|f>.png;
//      while that file is missing for your body the shelf says "Arriving soon" and does not sell it.
//    · Outfit colours (120 Gold): a colourway for EVERY piece of one slot (headwear, top, cape, bottoms, shoes).
//      Owned as 'dye:<slot>:<colour>' (e.g. 'dye:top:crimson'); a look carries it as `<slot>C` (topC: 'crimson').
//    · Hair colours (150 Gold): the wacky tints. Owned as 'hc:<colour>' (e.g. 'hc:pink').
//  Ownership is MP.econ.owns(id) / MP.econ.grant(id); paying is MP.econ.spend. Without mp/econ.js the shop is closed.
//
//  THE PANEL: G.panel === 'mpshop' (opened by the street's shop station through MP.stations.mp_shop). Three shelves
//  (tabs); every thing on a shelf is a card with your own hero wearing it; the chosen one is shown large, standing
//  or running (a toggle), with its name, price and ONE action button: Buy (asks once more) / Wear now / Wearing /
//  Not enough Gold / Arriving soon. Trying on is only ever the preview: your saved look changes only through
//  "Wear now" on something you own. Mouse, keys and touch (cards are picked when the press comes up without having
//  dragged the shelf; the wheel, a drag and the arrow keys scroll it).
//
//  Previews bake their looks through the real heroSheet (at most one new look per frame for the cards, so a shelf
//  never hitches); when the shop closes, the sheets that only the previews used are dropped again.
// =====================================================================
(() => {
  const SHOP = MP.shop = {};
  const TABS = [['wings', 'Wings'], ['dyes', 'Outfit colours'], ['hair', 'Hair colours']];
  const SLOT_WORD = { head: 'headwear', top: 'top', cape: 'cape', bottom: 'bottoms', shoe: 'shoes' };
  const FLAVOUR = 'The tailor: "Try on whatever you like, dear. Wings, dyes and hair tints: all sales are final."';
  const S = { tab: 0, sel: 0, scroll: 0, run: false, confirm: null, drag: null, note: '', noteT: 0, used: new Set(), known: new Set(), bakes: 0 };
  const econ = () => MP.econ || null;

  // ---------- the wares ----------
  function items(tab = S.tab) {
    const k = TABS[tab] ? TABS[tab][0] : 'wings';
    if (k === 'wings') return DOLL_WINGS.map(w => ({ kind: 'wing', id: 'wing:' + w[0].slice(4), name: w[1], price: DOLL_PRICE.wing, piece: w[0] }));
    if (k === 'hair') return HAIR_COLORS.filter(c => c[3] === 'shop').map(c => ({ kind: 'hc', id: 'hc:' + c[0], name: c[1] + ' hair', price: DOLL_PRICE.hc, hc: c[0], sw: c[2] }));
    return DOLL_DYE_SLOTS.flatMap(sl => DOLL_DYES.map(d => ({ kind: 'dye', id: 'dye:' + sl + ':' + d[0], name: d[1] + ' ' + SLOT_WORD[sl], price: DOLL_PRICE.dye, slot: sl, dye: d[0], sw: d[3] })));
  }
  const allItems = () => TABS.flatMap((t, i) => items(i));
  // my look with that thing on. A colourway needs a piece to show on: with nothing in that slot (or wings on your
  // back) it is shown, and worn, on the slot's first piece, which everybody has.
  function lookWith(it, base) {
    const L = Object.assign({}, base || heroLook(G.cls));
    if (it.kind === 'wing') { L.cape = it.piece; delete L.capeC; }
    else if (it.kind === 'hc') L.hc = it.hc;
    else { if (!L[it.slot] || dollWing(L[it.slot])) L[it.slot] = DOLL[L.sex][it.slot][0][0]; L[it.slot + 'C'] = it.dye; }
    return dollClean(L);
  }
  function wearing(it, L) {
    L = L || heroLook(G.cls);
    return it.kind === 'wing' ? L.cape === it.piece : it.kind === 'hc' ? L.hc === it.hc : L[it.slot + 'C'] === it.dye;
  }
  // 'soon' (its art has not arrived) | 'worn' | 'owned' | 'buy' | 'poor' | 'closed'
  function state(it) {
    const E = econ(); if (!E) return 'closed';
    if (it.kind === 'wing' && !dollHas('cape', it.piece, heroLook(G.cls).sex)) return 'soon';
    if (E.owns(it.id)) return wearing(it) ? 'worn' : 'owned';
    return E.gold() >= it.price ? 'buy' : 'poor';
  }
  function say(t) { S.note = t; S.noteT = 3.2; }
  // pay and own it (false: not for sale right now, or not enough Gold). No refunds: the only way back is a failed grant.
  function buy(it) {
    const E = econ(); if (!E || !it || state(it) !== 'buy') return false;
    if (!E.spend(it.price, it.name)) return false;
    if (E.grant(it.id) === false) { E.add(it.price, 'Shop: could not be stored'); say('The tailor could not wrap that one: your Gold is back.'); return false; }
    SFX.play('merge'); say(`${it.name}: yours now. Wear it?`);
    return true;
  }
  // put it on the class you are playing and save, like the dressing mirror does (only things you own)
  function wear(it) {
    const E = econ(); if (!E || !it || !E.owns(it.id) || state(it) === 'soon') return false;
    const L = lookWith(it), cls = G.cls;
    SAVE.skin[cls] = L.sex; SAVE.skin[cls + 'Look'] = Object.assign({}, L); saveData();
    const P = G.player; if (P) burst(P.x + P.w / 2, P.y + P.h / 2, '#e1bee7', 22, 180);
    SFX.play('merge'); say(`You now wear the ${it.name.toLowerCase()}.`);
    return true;
  }

  // ---------- opening and closing ----------
  function open() { Object.assign(S, { tab: 0, sel: 0, scroll: 0, run: false, confirm: null, drag: null, note: '', noteT: 0 }); G.panel = 'mpshop'; SFX.play('pick'); }
  function close() {
    G.panel = null; S.confirm = null; S.drag = null;
    // the looks only the shelves used are forgotten again (anyone really wearing one is simply baked afresh, once)
    const mine = heroSheet(G.cls);
    for (const k of S.used) if (k !== mine) { delete ART['anim/' + k]; delete window.ANIMS[k]; }
    S.used.clear(); S.known.clear(); DYE_CACHE.clear();
    SFX.play('pick');
  }
  // a look's sheet for a preview; card = one of the many small ones (those wait their turn: one new look a frame)
  function sheet(L, card) {
    const sig = JSON.stringify(L);
    if (card && !S.known.has(sig)) { if (S.bakes >= 1) return null; S.bakes++; }
    const k = heroSheet(G.cls, L);
    if (k) { S.known.add(sig); S.used.add(k); }
    return k && animFrames(k, 'idle') ? k : null;
  }

  // ---------- layout (landscape: the mirror on the left, the shelf on the right; portrait: mirror and buttons on top, the shelf under them) ----------
  function layout() {
    const port = PORTRAIT(), box = port ? { x: 6, y: 8, w: 528, h: H - 16 } : { x: 40, y: 18, w: 880, h: 504 };
    const top = box.y + 106, tabW = port ? 138 : 170;
    const tabs = TABS.map((t, i) => ({ x: box.x + 16 + i * (tabW + 4), y: box.y + 62, w: tabW, h: 36 }));
    const closeR = { x: box.x + box.w - 16 - (port ? 74 : 96), y: box.y + 62, w: port ? 74 : 96, h: 36 };
    const pv = port ? { x: box.x + 16, y: top, w: 236, h: 236 } : { x: box.x + 18, y: top, w: 280, h: 268 };
    const info = port ? { x: pv.x + pv.w + 12, y: top, w: box.w - 32 - pv.w - 12, h: pv.h } : { x: pv.x, y: pv.y + pv.h + 6, w: pv.w, h: box.y + box.h - 14 - (pv.y + pv.h + 6) };
    const act = { x: info.x, y: info.y + info.h - 42, w: info.w, h: 40 };
    const runR = port ? { x: info.x, y: act.y - 46, w: info.w, h: 38 } : { x: pv.x + pv.w - 104, y: pv.y + pv.h - 36, w: 98, h: 30 };
    const view = port ? { x: box.x + 14, y: top + pv.h + 12, w: box.w - 28 - 12, h: box.y + box.h - 34 - (top + pv.h + 12) } : { x: pv.x + pv.w + 14, y: top, w: box.x + box.w - 18 - 12 - (pv.x + pv.w + 14), h: box.h - 106 - 34 };
    const cols = 4, gap = 6, cw = Math.floor((view.w - gap * (cols - 1)) / cols), ch = 126, n = items().length, rows = Math.ceil(n / cols);
    const max = Math.max(0, rows * (ch + gap) - gap - view.h);
    const cb = { w: Math.min(440, W - 24), h: 190 }; cb.x = W / 2 - cb.w / 2; cb.y = H / 2 - cb.h / 2;
    return { port, box, tabs, closeR, pv, info, act, runR, view, cols, gap, cw, ch, rows, max, cb,
             yes: { x: cb.x + cb.w / 2 - 150, y: cb.y + cb.h - 56, w: 144, h: 40 }, no: { x: cb.x + cb.w / 2 + 6, y: cb.y + cb.h - 56, w: 144, h: 40 } };
  }
  const card = (Y, i) => ({ x: Y.view.x + (i % Y.cols) * (Y.cw + Y.gap), y: Y.view.y + Math.floor(i / Y.cols) * (Y.ch + Y.gap) - S.scroll, w: Y.cw, h: Y.ch });
  function cardAt(Y) {
    if (!inRect(mouse, Y.view)) return -1;
    const n = items().length; for (let i = 0; i < n; i++) if (inRect(mouse, card(Y, i))) return i;
    return -1;
  }
  function follow(Y) {   /* scroll so the chosen card is in view */
    const r = Math.floor(S.sel / Y.cols), y0 = r * (Y.ch + Y.gap);
    if (y0 < S.scroll) S.scroll = y0; else if (y0 + Y.ch > S.scroll + Y.view.h) S.scroll = y0 + Y.ch - Y.view.h;
    S.scroll = clamp(S.scroll, 0, Y.max);
  }
  // the one action button for the chosen thing: [text, what a press does ('' = nothing), colour]
  function action(it) {
    const st = it ? state(it) : 'closed';
    return st === 'buy' ? ['Buy', 'buy', PAL.gold] : st === 'owned' ? ['Wear now', 'wear', PAL.good] : st === 'worn' ? ['Wearing', '', null]
      : st === 'poor' ? ['Not enough Gold', '', null] : st === 'soon' ? ['Arriving soon', '', null] : ['Closed', '', null];
  }
  function setTab(i) { S.tab = (i + TABS.length) % TABS.length; S.sel = 0; S.scroll = 0; S.drag = null; SFX.play('rotate'); }
  function press(what) {
    const it = items()[S.sel];
    if (what === 'buy' && it && state(it) === 'buy') { S.confirm = it; SFX.play('pick'); }
    else if (what === 'wear') wear(it);
  }

  // ---------- input ----------
  function keys(dt) {
    if (!econ()) { if (hit('Escape', 'e', 'Enter')) close(); return; }
    if (S.confirm) {
      if (hit('Enter')) { buy(S.confirm); S.confirm = null; }
      else if (hit('Escape', 'e')) { S.confirm = null; SFX.play('pick'); }
      return;
    }
    if (hit('Escape', 'e')) { close(); return; }
    const Y = layout(), n = items().length, was = S.sel;
    if (hit('q')) setTab(S.tab - 1); else if (hit('Tab')) setTab(S.tab + 1);
    for (let i = 0; i < TABS.length; i++) if (hit(String(i + 1)) && S.tab !== i) setTab(i);
    if (hit('ArrowLeft', 'a')) S.sel = Math.max(0, S.sel - 1);
    if (hit('ArrowRight', 'd')) S.sel = Math.min(n - 1, S.sel + 1);
    if (hit('ArrowUp', 'w') && S.sel - Y.cols >= 0) S.sel -= Y.cols;
    if (hit('ArrowDown', 's')) S.sel = Math.min(n - 1, S.sel + Y.cols);
    if (S.sel !== was) { SFX.play('rotate'); follow(layout()); }
    if (hit('t')) { S.run = !S.run; SFX.play('rotate'); }
    if (hit('Enter')) press(action(items()[S.sel])[1]);
  }
  function click(btn) {
    if (btn !== 0) { if (S.confirm) S.confirm = null; else close(); return; }
    const Y = layout();
    if (!econ()) { close(); return; }
    if (S.confirm) {
      if (inRect(mouse, Y.yes)) { buy(S.confirm); S.confirm = null; }
      else if (inRect(mouse, Y.no) || !inRect(mouse, Y.cb)) { S.confirm = null; SFX.play('pick'); }
      return;
    }
    if (inRect(mouse, Y.closeR)) { close(); return; }
    for (let i = 0; i < TABS.length; i++) if (inRect(mouse, Y.tabs[i])) { if (S.tab !== i) setTab(i); return; }
    if (inRect(mouse, Y.runR)) { S.run = !S.run; SFX.play('rotate'); return; }
    if (inRect(mouse, Y.act)) { press(action(items()[S.sel])[1]); return; }
    if (inRect(mouse, Y.view)) S.drag = { y0: mouse.y, s0: S.scroll, moved: false };   /* a tap picks a card when it comes up; a drag scrolls */
  }
  function up(btn) {
    const d = S.drag; S.drag = null; if (!d || d.moved || G.panel !== 'mpshop') return;
    const i = cardAt(layout()); if (i >= 0 && i !== S.sel) { S.sel = i; SFX.play('rotate'); }
  }
  function wheel(px) { if (S.confirm) return; const Y = layout(); S.scroll = clamp(S.scroll + px, 0, Y.max); }

  // ---------- drawing ----------
  function drawHero(L, x, y, scale, isCard) {
    const k = sheet(L, isCard);
    if (k) drawAnim(k, !isCard && S.run ? 'run' : 'idle', TIME * (!isCard && S.run ? 10 : 6), x, y, 1, { scale });
    else label('…', x, y - 30, { align: 'center', size: 18, color: PAL.dim });
  }
  function clipTo(r, fn) { ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip(); try { fn(); } finally { ctx.restore(); } }
  function swatch(x, y, s, col) { ctx.fillStyle = col; rr(x, y, s, s, 3); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.lineWidth = 1; rr(x, y, s, s, 3); ctx.stroke(); }
  function stateLine(it, st, x, y, size) {   /* the price, or what stands in its place */
    if (st === 'worn' || st === 'owned') label(st === 'worn' ? 'Wearing' : 'Owned', x, y, { align: 'center', size, bold: true, color: PAL.good });
    else if (st === 'soon') label('Arriving soon', x, y, { align: 'center', size, color: PAL.dim });
    else econ().drawGold(x, y, { align: 'center', n: it.price, size, color: st === 'poor' ? PAL.bad : PAL.gold });
  }
  function draw() {
    const E = econ(), Y = layout(), B = Y.box; S.bakes = 0;
    ctx.fillStyle = 'rgba(8,5,3,0.74)'; ctx.fillRect(0, 0, W, H);
    if (!E) {   /* no purse, no shop */
      const w = Math.min(460, W - 24), x = W / 2 - w / 2, y = H / 2 - 90;
      panel(x, y, w, 180, 'parch'); banner('Cosmetics Shop', W / 2, y + 4, { size: 28, h: 46, pad: 100 });
      label('The shop is closed today.', W / 2, y + 76, { align: 'center', size: 18, bold: true, color: PAL.parchInk });
      label('(The tailor cannot count Gold right now.)', W / 2, y + 104, { align: 'center', size: 13, color: PAL.parchInk });
      label(TOUCH.on ? 'Tap to leave' : 'Esc to leave', W / 2, y + 146, { align: 'center', size: 13, color: PAL.parchInk });
      return;
    }
    const list = items(); S.sel = clamp(S.sel, 0, Math.max(0, list.length - 1));
    if (S.drag) { const dy = mouse.y - S.drag.y0; if (Math.abs(dy) > 6) S.drag.moved = true; if (S.drag.moved) S.scroll = S.drag.s0 - dy; }
    S.scroll = clamp(S.scroll, 0, Y.max);
    if (S.noteT > 0) S.noteT -= 1 / 60;
    panel(B.x, B.y, B.w, B.h, 'leather');
    banner('Cosmetics Shop', W / 2, B.y + 4, { size: 28, h: 46, pad: 110 });
    // the purse (always in sight) and the tailor
    const gw = E.drawGold(B.x + B.w - 20, B.y + 44, { align: 'right', size: 17 });
    ctx.font = `13px ${UI}`; label(fitText(FLAVOUR, B.w - 40 - gw - 60), B.x + 20, B.y + 44, { size: 13, color: PAL.dim });
    label('Gold', B.x + B.w - 26 - gw, B.y + 44, { align: 'right', size: 13, color: PAL.dim });
    TABS.forEach((t, i) => button(Y.tabs[i], t[1], { on: S.tab === i, hover: !S.confirm && inRect(mouse, Y.tabs[i]), size: Y.port ? 13 : 15 }));
    button(Y.closeR, 'Leave', { hover: !S.confirm && inRect(mouse, Y.closeR), size: 14 });
    // the chosen thing, on you
    const it = list[S.sel], st = it ? state(it) : 'closed', pv = Y.pv, fy = pv.y + pv.h - 44;
    panel(pv.x, pv.y, pv.w, pv.h, 'dark');
    const gl = ctx.createRadialGradient(pv.x + pv.w / 2, fy - 80, 10, pv.x + pv.w / 2, fy - 80, 150); gl.addColorStop(0, 'rgba(255,224,170,0.22)'); gl.addColorStop(1, 'rgba(255,224,170,0)');
    ctx.fillStyle = gl; ctx.fillRect(pv.x, pv.y, pv.w, pv.h);
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(pv.x + pv.w / 2, fy, 46, 8, 0, 0, 7); ctx.fill();
    if (it) clipTo({ x: pv.x + 4, y: pv.y + 4, w: pv.w - 8, h: pv.h - 8 }, () => drawHero(st === 'soon' ? heroLook(G.cls) : lookWith(it), pv.x + pv.w / 2, fy, Y.port ? 4 : 5, false));
    if (st === 'soon') label('Arriving soon', pv.x + pv.w / 2, pv.y + 20, { align: 'center', size: 14, bold: true, color: PAL.dim });
    if (!Y.port) button(Y.runR, S.run ? 'Stand' : 'Run', { hover: !S.confirm && inRect(mouse, Y.runR), size: 13 });
    // its name, price and the one thing you can do with it
    const I = Y.info, cx = I.x + I.w / 2, [txt, what, col] = action(it);
    if (it) {
      ctx.font = `bold 16px ${UI}`; label(fitText(it.name, I.w - 4), cx, I.y + 14, { align: 'center', size: 16, bold: true, color: PAL.cream });
      stateLine(it, st, cx, I.y + 38, 15);
      const more = S.noteT > 0 ? S.note : st === 'poor' ? `You need ${E.fmt ? E.fmt(it.price - E.gold()) : it.price - E.gold()} more Gold.` : st === 'soon' ? 'The tailor is still sewing these.'
        : st === 'buy' ? 'Tried on only: buy it to keep it.' : st === 'owned' ? 'Yours. Put it on here or at the mirror.' : it.kind === 'dye' ? `Colours every ${SLOT_WORD[it.slot]} you wear.` : '';
      wrapLines(more, I.w - 4, 12).slice(0, Y.port ? 3 : 2).forEach((l, i) => label(l, cx, I.y + 60 + i * 15, { align: 'center', size: 12, color: S.noteT > 0 ? PAL.gold : PAL.dim }));
    }
    if (Y.port) button(Y.runR, S.run ? 'Stand still' : 'See it run', { hover: !S.confirm && inRect(mouse, Y.runR), size: 14 });
    button(Y.act, txt, { off: !what, hover: !!what && !S.confirm && inRect(mouse, Y.act), size: 16, color: col || undefined });
    // the shelf
    const V = Y.view, hot = S.confirm || S.drag ? -1 : cardAt(Y);
    clipTo(V, () => {
      list.forEach((c, i) => {
        const r = card(Y, i); if (r.y + r.h < V.y || r.y > V.y + V.h) return;
        const cs = state(c), mx = r.x + r.w / 2;
        panel(r.x, r.y, r.w, r.h, 'dark');
        if (i === hot && i !== S.sel) { ctx.fillStyle = 'rgba(255,211,107,0.08)'; ctx.fillRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4); }
        clipTo({ x: Math.max(r.x + 3, V.x), y: Math.max(r.y + 3, V.y), w: r.w - 6, h: Math.max(0, Math.min(r.y + r.h - 40, V.y + V.h) - Math.max(r.y + 3, V.y)) }, () => drawHero(cs === 'soon' ? heroLook(G.cls) : lookWith(c), mx, r.y + r.h - 44, 2, true));
        if (c.sw) swatch(r.x + 7, r.y + 7, 14, c.sw);
        ctx.font = `12px ${UI}`; label(fitText(c.name, r.w - 8), mx, r.y + r.h - 29, { align: 'center', size: 12, bold: true, color: PAL.cream });
        stateLine(c, cs, mx, r.y + r.h - 13, 12);
        if (i === S.sel) { ctx.strokeStyle = PAL.gold; ctx.lineWidth = 2; rr(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 4); ctx.stroke(); }
      });
    });
    if (Y.max > 0) {   /* how far down the shelf you are */
      const bx = V.x + V.w + 4, th = Math.max(24, V.h * V.h / (V.h + Y.max)), ty = V.y + (V.h - th) * (S.scroll / Y.max);
      ctx.fillStyle = 'rgba(12,7,4,0.6)'; ctx.fillRect(bx, V.y, 6, V.h); ctx.fillStyle = PAL.brass; ctx.fillRect(bx + 1, Math.round(ty), 4, Math.round(th));
    }
    ctx.font = `12px ${UI}`;
    label(fitText(TOUCH.on ? 'Tap a thing to try it on  ·  drag the shelf for more' : Y.port ? 'Arrows choose · Enter buy / wear · T run · Tab shelf · Esc leave' : 'Arrows choose  ·  Enter buy / wear  ·  T run or stand  ·  Q / Tab change shelf  ·  Esc leave', V.w), V.x, B.y + B.h - 20, { size: 12, color: PAL.dim });
    if (S.confirm) drawConfirm(Y);
  }
  function drawConfirm(Y) {
    const c = Y.cb, it = S.confirm;
    ctx.fillStyle = 'rgba(8,5,3,0.6)'; ctx.fillRect(0, 0, W, H);
    panel(c.x, c.y, c.w, c.h, 'parch');
    ctx.font = `bold 17px ${UI}`;
    label(fitText(`Buy ${it.name} for ${it.price} Gold?`, c.w - 40), W / 2, c.y + 44, { align: 'center', size: 17, bold: true, color: PAL.parchInk });
    econ().drawGold(W / 2, c.y + 76, { align: 'center', n: it.price, size: 18, color: '#8a5a00' });
    label('No refunds, and cosmetics cannot be traded.', W / 2, c.y + 104, { align: 'center', size: 12, color: PAL.parchInk });
    button(Y.yes, 'Buy', { hover: inRect(mouse, Y.yes), size: 16, color: PAL.gold });
    button(Y.no, 'Not now', { hover: inRect(mouse, Y.no), size: 16 });
  }

  MP.panels.mpshop = { draw, click, keys, wheel, up };
  MP.stations.mp_shop = open;
  Object.assign(SHOP, { open, close, items, allItems, state, buy, wear, lookWith, wearing, TABS, _: { S, layout, card, action, sheet } });
})();
