# CLAUDE.md — Pack Rat Dungeon

Guide for Claude Code sessions working on this project. Read this first, then grep `index.html` for the
function names below instead of reading the whole file (it is ~4,500 lines).

## What it is

A side-scrolling roguelike platformer about packing a 10x4 backpack. Plain JavaScript + `<canvas>`, no
libraries, no build step: **the whole game is `index.html`**, opened by double-click (must keep working from
`file://`). Sprites load from `assets/`; anything missing falls back to code-drawn graphics.

Owner: GitHub `Neytirix25`, repo https://github.com/Neytirix25/Backpack-Platformer (public).

## The owner's standing rules

- **All art is made with ChatGPT** (in their Chrome, conversation "Generate sprite sheet"), never drawn by
  hand or generated another way. Music/SFX are synthesized in code (ChatGPT can't make audio).
- **Ask about design choices** when a request is ambiguous (they like multiple-choice questions).
- Commits use the repo-local identity `Neytirix25 <352376354+Neytirix25@users.noreply.github.com>`;
  never put the owner's real email anywhere.
- Don't push or merge unless asked. When asked: branch from `origin/main`, push, open a PR via the GitHub
  compare page in Chrome (no `gh` CLI installed), merge it in the web UI, then `git pull` on `main`.
- If `git push` dies with HTTP 408 / "remote end hung up", retry with `git -c http.version=HTTP/1.1 push`.

## Files

```
index.html          the entire game
CLAUDE.md           this file
README.md           player-facing description + controls
assets/anim/        animation sheets (<name>.png + entries in anims.js, loaded via <script src>)
assets/items|props|tiles|bg|chars/   static sprites (items: 18 art px per backpack cell; world sprites drawn at 2x)
tools/animate.py    slices raw ChatGPT animation sheets -> assets/anim/*.png + anims.js   (SPECS dict, ROW_FIX)
tools/pixelate.py   slices raw item/prop/bg sheets -> assets/*   (subcommands: items2, tiles, plants, classitems <cls>, petcages, hubprops, bg <name>, floor <name>)
assets_raw/         raw ChatGPT downloads (gitignored, local only)
```

Run Python tools with `python -P` (avoids local-module shadowing).

## Map of index.html (grep these banners: `^//  [A-Z]`)

| Section | What lives there |
|---|---|
| ART | `ART_FILES` lists every sprite to load, `drawAnim`, `drawSprite`, `whiteOf`/`blackOf` silhouettes, `BG_CROP`/`BG_FLOOR` |
| SOUND / MUSIC | `SFX` synth, `SONGS`, `Music`, `musicDirector`, `LEVEL_POOLS`, `pickLevelSong` (never repeats the last 2) |
| ITEMS | `ITEMS` table (shape, rarity, stats, `only:` class, `noDrop`), `LVL_MULT` merge levels, `computeStats`, `rollItem` |
| CLASSES | `CLASSES`, `CLASS_ORDER`, `startItems`; `SAVE` (localStorage: collection, records, skins), `heroSheet(cls)`, `logRun` |
| ENEMIES & ROOMS | `ENEMIES`, `THEMES`, `THREAT`/`threat()`/`applyThreat` (pet-team scaling), `enemyHpCurve(n)` (per-floor HP), `makeEnemy`, `newGame`, `nextRoom` |
| THE SANCTUARY | hub between runs: `enterHub`, `HUB_SPOTS`, `updateHubPets`, `hubStations`/`hubNearest`/`hubInteract` (E key), `drawHubWorld`, `drawHubBubble`, `drawHubHUD` |
| level generation | `SEGMENTS` ASCII templates, `buildLevel`/`tryBuild` (one storey, 18 segments x 16 tiles), `buildArena` (camp/boss/hub), `buildNav`, `populate` (enemy budget + at least 3 per screen) |
| BUFF PLANTS | `PLANTS`, lantern reveal tiers |
| COMBAT / CLASS ABILITIES | `atkDmg`, `playerHit`, `damageEnemy`, `hurtPlayer`, `ABILITY` table + `useAbility` |
| UPDATE | `updatePlayer`, `updateEnemy`, `updateWorld`, camera, hazards, chasms (`fellInChasm`) |
| PETS | `PETS` roster (10), `petSlots`, `syncPets`, `TALENTS`, `SYNERGIES`, `updatePets`, trail-following (`recordTrail`, `petTrailStep`), `petRun`/`edgeAhead`, `drawPets` |
| CAGES | `makeCage`, `addCageGuards`, `freeCage` (also records the species in the collection) |
| BACKPACK SCREEN / DRAWING / MAIN LOOP | pack UI, all draw functions, `update(dt)` mode switch, `frame()` |

Key constants: `W=960, H=540, TILE=30, PX=2, GRAV=1500`. Tiles: `EMPTY 0, SOLID 1, ONEWAY 2, SPIKES 3, LAVA 4, CRUMBLE 5, PHASE 6`.

## Game flow

Title → **Sanctuary hub** (`G.hub = true`; pick class at banners, look at the mirror, records board, pet
animals, walk through the gate) → `newGame()` → floors 1–20 (boss on 10, camps on 5 and 15, Act II from 11,
endless after 20) → death/victory → back to the hub. `G.mode`: play / pack / pause / trans / dead / won.

## Systems worth knowing before changing things

- **Pets:** live only in 3 pet slots (`petSlots`), rescued from cages, level 1–10 from kills, talents via
  right-click. Ground pets follow the hero's recorded path (`G.trail`) with a delay; fighting, resting,
  flyers, boar charge, KO and the leash teleport use the older logic.
- **Difficulty:** `enemyHpCurve(n) = 1 + 0.4(n-1) + 0.025(n-1)^2` (halved for Act II types); `THREAT` adds
  HP/damage/count/attack speed per pet in your team (and a bit per pet level).
- **Saved data (localStorage):** `packrat_coll` (species rescued), `packrat_records`, `packrat_skin`
  (female looks), `packrat_class`, `packrat_best`, mute/music flags.
- **Female heroes:** sheets `<cls>_f`, plus `warrior_f_block`, `archer_f_arcane`; `heroSheet()` picks them.

## Art pipeline (ChatGPT in Chrome)

1. Type the prompt into the ChatGPT tab (transparent background, rows/frames spelled out, "no text").
2. In that tab, inject the helpers `window.__prd.prepLatest(name)` and `window.__grab3(name, prevSize)`
   (they find the newest generated image and add a big green SAVE button); click the button to download.
3. Copy the newest `*.tmp` from `Downloads` into `assets_raw/` (for animations: `anim_<name>.png`), remove
   white backgrounds/halos if needed, then run `tools/animate.py <name>` or the matching `pixelate.py` command.
   Check `assets_raw/anim_<name>_check.png` to see the sliced frames.
4. New sprites must be added to `ART_FILES` (static) — animation sheets register themselves via `anims.js`.

## Testing

There is no test runner in the repo. Past sessions used headless Node scripts that stub canvas/audio and
`eval` the game's `<script>` (extract it with: `sed -n '/<script>$/,/<\/script>/p' index.html | sed '1d;$d'`).
Always at least syntax-check after edits: `node --check` on the extracted script. To preview visually, run
`python -P -m http.server 8765 --bind 127.0.0.1` in this folder and open it in a new Chrome tab (freeze the
loop with `window.__U = update; window.update = () => {}` and step `__U(1/60)` + `draw()` manually, because
background tabs throttle animation frames).
