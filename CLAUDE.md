# CLAUDE.md — Backpack Sanctuary

Guide for Claude Code sessions working on this project. Read this first, then grep `index.html` for the
function names below instead of reading the whole file (it is ~4,500 lines).

## What it is

A side-scrolling roguelike about raising a team of animal companions. You explore platforming floors as the
hero (no attacking); running into a wild animal group opens a **turn-based battle** between your 3 active pets
and that many wild animals. Defeated animals leave babies/eggs that join your saved collection. Backpack
items power up the pets. Plain JavaScript + `<canvas>`, no libraries, no build step: **the whole game is
`index.html`**, opened by double-click (must keep working from `file://`). Sprites load from `assets/`;
anything missing falls back to code-drawn graphics.

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
assets/ui/          the menu UI kit (leather/parchment panels, wooden buttons, slot, banner ribbon, wax seal), 9-sliced at 2x
assets/fonts/       pixel fonts (SIL OFL) + fonts.js (base64, loaded with FontFace so file:// works)
tools/animate.py    slices raw ChatGPT animation sheets -> assets/anim/*.png + anims.js   (SPECS dict, ROW_FIX)
tools/pixelate.py   slices raw item/prop/bg sheets -> assets/*   (classitems pets1..pets6 = the pet item icon sheets, pets4-6 drawn to their odd shapes and cut with fit_fill; vfx vfx1..vfx4 = the 48 ability-effect sprites -> assets/vfx, cut as a 4x3 grid; feyterrain = Act III tiles/ledges/props; also items2, tiles, plants, hubprops, bg <name>, uikit = assets_raw/ui_kit_sheet.png -> assets/ui)
assets_raw/         raw ChatGPT downloads (gitignored, local only)
```

Run Python tools with `python -P` (avoids local-module shadowing).

## Map of index.html (grep these banners: `^//  [A-Z]`)

| Section | What lives there |
|---|---|
| UI STYLE | `PAL` colours, `UI`/`TITLE` fonts, crisp text (`pixelFont`, `TEXT_CACHE`), `rr`, `fitText`, `UIKIT`/`nine`, `panel(x,y,w,h,'leather'|'parch'|'dark'|'slot')`, `button`, `banner`, `label`, `meter`, `hpColor` |
| ART | `ART_FILES` lists every static sprite to load, `drawAnim`, `drawSprite`, `whiteOf`/`blackOf`, `BG_CROP`/`BG_FLOOR` |
| SOUND / MUSIC | `SFX` synth, `SONGS`, `Music`, `musicDirector`, `LEVEL_POOLS`, `pickLevelSong` |
| ITEMS | `ITEMS` (pet passives, family items `fam:`, position items, consumables `use:`, eggs `egg:`, pet entries `pet_<k>`), `LVL_MULT` merges, `computeStats` (team bonuses), `rollItem` |
| CLASSES | `CLASSES` (Warrior Vanguard, Archer Volley, Rogue Poacher, Beastmaster Bond: their effects live in `petUnit`, `beginPlayerTurn`, `winBattle`, `heroUsesMax`), `SAVE` (`coll`, `rec`, `skin`, `pets`, `team`, `ach`), `heroSheet`, `logRun` |
| ENEMIES & ROOMS | `THEMES`, `newGame`, `nextRoom` (boss every 10th floor via `BOSS_OF`/`BOSS_INFO`: 10 Shadow Wolf, 20 Elder Dragon, 30 Lake Wyrm = `FINAL_FLOOR`; camps on 5/15/25) |
| THE SANCTUARY | hub: `enterHub` (starter panel when you own no pets), `HUB_SPOTS`, `hubStations` (incl. the team station at the pet beds), `hubInteract`, `hubPanelClick`, `drawHubHUD` |
| level generation | `SEGMENTS`, `buildLevel`/`tryBuild`, `buildArena`, `buildNav`, `populate` (calls `placeWild`) |
| BUFF PLANTS | `PLANTS` (charges for the next battle, Swiftleaf = hero speed), `pickPlant` |
| UPDATE | `updatePlayer` (no attacks; exit gated by `exitOpen()`), `updateWorld`, hazards hurt the team (`hurtTeam`), chasms |
| PETS | `PETS` (overworld body + art, incl. `shadowwolf`/`elder` with `fallback` sheets), battle data `FAMILY`/`BS` (stats, 3 base abilities, 3 tree ultimates, offspring)/`ABIL`/`STATUS`, `PET_TREES` (`S`/`UP`/`KEY`/`ULT` helpers), `petMods` → `M`, `teamMods`/`TEAM()`, talents, `syncPets` (overworld followers), trail-following |
| WILD ANIMALS | `placeWild`, `updateWild` (touch → `startBattle`), `drawWild`, `exitNeed`/`exitOpen`, `hurtTeam`/`healTeam` |
| BATTLES | collection `PET_ITEMS`/`loadPets`/`savePets`/`unlockPet`/`newcomerLevel`, XP `XP_NEED`/`givePetXp`, `petUnit`/`foeUnit`, `THEME_POOL`/`COMPS`/`wildLevel`/`buildFoes` (bosses too), `startBattle`, `act` (resolves any ability), `dealDamage`/`applyDamage`/`faint`, `aiChoose`, `tickSide`/`expireSide` (DoTs, fatigue from turn 15), `winBattle` (XP, offspring, eggs hatch, achievements), `heroUse`, `drawBattle`, roster + starter screens |
| BACKPACK SCREEN / DRAWING / MAIN LOOP | pack UI (team box opens the roster, right-click = talents), draw functions, `update(dt)` (`G.mode` play / pack / encounter / battle / pause / trans / dead / won), `frame()`; pause menu `openPause`/`pauseDo`/`drawPauseMenu` (run-ending choices confirm; quitting = `abandonRun`, counted in `SAVE.rec.abandoned`) |

Key constants: `W=960, H=540, TILE=30, PX=2, GRAV=1500`. Tiles: `EMPTY 0, SOLID 1, ONEWAY 2, SPIKES 3, LAVA 4, CRUMBLE 5, PHASE 6`.

## Systems worth knowing before changing things

- **Turn order:** player phase (each living pet acts in slot order front→back, the hero may use `heroUsesMax()`
  consumables), then every foe acts (`B.queue`; bosses act twice). Statuses: DoTs/regen tick at the start of
  the owner's phase (`tickSide`), durations count down at the end of it (`expireSide`). Curses put on the
  other side use the plain turn count; buffs on your own side get +1 (they're applied mid-phase).
- **Ability fields (`ABIL`):** `t` (foe/foes/rand/ally/allies/self/weakest/strongest), `pow`, `hits`, `repeat`,
  `heal`/`healPct`, `shieldOf`/`shieldAtk`/`shieldPct`, `st` (curses `[status, turns, chance]`), `self`,
  `allySt`, `cd`, `finisher`, `alwaysCrit`, `crit`, `devour`, `steal`, `cleanse`, `reviveAll`, `again`, `summon`, `ult`.
  Talents tweak abilities through `M.up[ab]` (`pow`, `cd`, `ch`, `turns`, `heal`, `shield`, `stx` extra curses).
- **Talent trees:** `TIER_LVL = [0,1,5,10,16,22]`; a talent needs a point in the tier above in the same tree
  (`talentBlock`). Tier 5 of each tree is `ULT(id, ability)` → pushes the ability onto `M.ults`.
- **Balance knobs:** `statLine` growth (+9% HP, +8% atk per level), `wildLevel(n)`, `foeUnit` multipliers,
  boss `mul`s in `buildFoes`, `XP_NEED`, XP per foe in `winBattle`, `FATIGUE_TURN`. Bosses take half DoT damage
  and resist stuns (1 turn, then immune for 3).
- **Saved data (localStorage):** `packrat_pets` (level/xp/talents per species), `packrat_team`, `packrat_ach`,
  `packrat_coll`, `packrat_records`, `packrat_skin`, `packrat_class`, `packrat_best`: always through `sk(key)`,
  which appends `@<SLOT>` (a hash of the game's folder) so each copy keeps its own progress. A folder named
  `backpack sanctuary` (or `pack-rat-dungeon`) adopts the old folder's / the unslotted save once.
- **Run state:** `RUN.petHp[k]` = HP fraction during a run (fainted = 0); +25% per new floor, camps heal fully.
- **Pets menu:** `T` / `PETS_BTN` → `openPetsMenu()` (the roster with `PK.rosterOnly`). Ability tooltips come from `abilityLines(u, ab)` + `drawTipBox`.
- **Entering a floor:** `petsEnterRoom()` keeps pets at the door (`p.waiting`) and lets them in one by one as you walk on.
- **Unicorn:** earned by `B.turn <= 1` wins (`SAVE.ach.first`), never wild.
- **UI look (leather & brass backpack):** draw menus with `panel`/`button`/`banner`/`label`/`meter` and `PAL` colours,
  never plain translucent boxes. Fonts: `UI` = Jersey 10 (body), `TITLE` = Jacquarda Bastarda 9 (short headings
  only; long or changing text uses `banner(..., { plain: true })`). The canvas `fillText`/`measureText` are wrapped:
  any size asked for is snapped to the font's pixel grid (body text is always 18.667px, 37.333px when 24px+;
  9px and below is Micro 5), each string is cached as solid pixels with a 1px ink shadow (`ctx.textShadowOff = true`
  turns it off). Because sizes snap, use `fitText(t, maxW)` / `wrap()` for text in fixed boxes. Pixelify Sans was
  tried and dropped: its 2 reads as an 8 at game sizes.
- **Three acts of animals:** `THEME_POOL` — hall/cave/crypt (floors 1-10) list only ordinary animals, forge/hollow/sanctum (11-20) only mythical ones (`BS[k].myth`), thornwood/glade/lake (21-30) only the fey (`BS[k].fey`) plus the wild Elder Dragon (it never drops the Elder Egg). Compositions pick roles from `ACT_ROLES[act]` through the `ROLE_OF` proxy. The 8 fire beasts (phoenix, hellhound, salamander, tortoise, qilin, chimera, lion, moth) follow the full recipe for a new animal: `ABIL` (6) + `AB` sound + `FXR` animation per ability, `BS`, `PETS` (with a `fallback` sheet + `STAND_IN` tint until art exists), `FAMILY`, `PET_TREES` (3 trees), `ITEMS.pet_<k>` (+ `egg_<k>` for egg layers, icons in pixelate pets6), `THEME_POOL`/`ACT_ROLES`, `animate.py` SPECS (their resting pose is the last row of the main sheet), `ROW_FIX`. The Sanctuary is 56 tiles wide for 21 beds. Pets with no item icon draw their idle frame (`drawPetIcon`).
- **Act III, the Fey Wilds (floors 21-30):** `actOf` 3, themes thornwood/glade/lake (bg + tiles from ChatGPT; `pixelate.py feyterrain` cuts the 4x3 terrain sheet into tiles, ledges and the thorns/shroom/vine props), songs act3/glimmer/moonlake (`LEVEL_POOLS[3]`). Hazards: `THORN` tiles hurt on touch, `VINE` tiles are climbable (`P.climbing`, `vineUnder`; open for standing via `isOpenT`), bounce mushrooms live in `R.shrooms` (`shroomBounce`, `BOUNCE_V`). The movement graph adds 'bounce' and 'climb' edges (player only, kept out of `rev`). Segment chars: t thorns, m mushroom, | vine. The Lake Wyrm (`lakewyrm`, `off: 'special'`) is the floor-30 boss with a fey court; beating it unlocks its Wyrmling at once (`SAVE.ach.wyrm`). Past floor 20 `wildLevel` climbs 0.8/floor.
- **Font:** one readable pixel font, DotGothic16 (OFL, Latin subset in assets/fonts/DotGothic16.ttf, base64 `dotgothic` in fonts.js), for UI and TITLE. The crispText wrapper draws it smoothly (no glyph snapping), never below 11px, with a 1px ink shadow (`textShadowOff` turns it off); Jersey 10 / Micro 5 / Jacquarda stay only as fallbacks.
- **Individual animals:** `HERD` (saved as `SAVE.herd`, key packrat_herd) holds every animal: an item with `pid`, level, xp, talents and `g` = { nat, atk, def, hp, bond, sex, shiny }. `PET_ITEMS` is now a Proxy (species -> your highest-level animal) for older code. `unlockPet(k, lvl, g)` always adds a NEW animal and returns it; `giveOffspring` rolls `rollGenes()` (eggs carry `it.g`). `RUN.petHp` and `runHp()` are keyed by pid. Old saves (`SAVE.pets` per species) migrate in `loadPets` (traits floored at 40-69). `applyGenes(u, it)` in `petUnit`: `statMul` (-15%..+15%), `NATURES`, `u.dodge` (bond * 0.001) and `u.hitB` (bond * 0.003, used in `dealDamage` to land misses/dodges). `addBond`: win +1 (boss +3), petting +1 once per animal per visit (`G.petted`), Pet Treats dropped on a team-box slot +5, run end +2. Shinies: `SHINY_ODDS`, `petFilter` (stand-in tint + `shinyFilter`), `shinySparkle`.
- **Sanctuary rooms:** `HUB_ROOMS` (yard / wardrobe / records / den), `buildHubRoom(room, from)`, `goHubRoom(to)` (fade via `G.hubTo` in the 'trans' mode), `hubStations` per room (kind 'door' etc.), `drawHubWorld` / `drawHubRoomProps` / `drawDoor`. Indoor rooms draw their whole background (`drawParallax`); the gate exists only in the Yard. Wardrobe dyes: `DYES`, `heroDye()` (`SAVE.skin[cls + 'Dye']`). Records Hall: `trophyList`/`drawTrophies`. Breeding Den: `SAVE.den` {m, f, ready}, `denPair`, `denRunEnded` (logRun/abandonRun), `breedGenes` (average + 0..10, shiny 2/40/90%), `openDen`/`drawDen`/`denClick`, `hatchDenEgg` -> `drawNewborn`. Room art: bg yard/wardrobe/records (den reuses bg/hub), props via `pixelate.py sanctprops` and `sparkles`.
- **Starting act:** `actsOpen()` reads `SAVE.rec.bestFloor` (saved the moment a floor is reached, in `nextRoom`): 11+ opens Act II, 21+ Act III. With more than one open, the gate opens `G.panel = 'acts'` (`drawActSelect`); `newGame(cls, startAct)` sets `G.roomNum = (startAct - 1) * 10` and `G.startAct` (Restart reuses it).
- **Into battle:** `updateWild` calls `startEncounter` (mode 'encounter': '!' bubbles, a 0.62 s freeze), which snapshots the canvas, then calls `startBattle` + `beginIntro`. `B.intro` holds the battle (`updateIntro`, skippable with Enter/click) while `drawIntro` draws the act wipe over it (1: cracks + falling blocks of the snapshot, 2: `fireFront` flames, 3: `makeVineCurtain` curtains + petals), then `drawVsCard` or `drawBossCinematic` (`BOSS_CINE`). Calling `startBattle` directly (the tests do) skips the intro.
- **Battle music:** `battleSong()` in `musicDirector`: battle1-3 per act; boss_shadow/elder/wyrm, plus their '2' version at half health or enrage (boss_shadow2 = `transposeSong` +2 semitones); bwin / blose stings (`once`).
- **Pet roster:** the 'All your pets' list scrolls (`ROSTER_GRID`, `rosterScroll`; wheel, scrollbar drag, arrow keys). Cards and portraits are clipped, and `drawPetCard` shrinks big sprites to fit their card.
- **Ability animations:** ABILITY ANIMATIONS section. `FXR[id] = [impact seconds, c => emitters]`; `fxCtx` gives `c.T` (foes struck), `c.H` (every hit, for multi-hits), `c.A` (allies helped) and emitters (shot, rain, slash, bite, waves, breath, rise, orbit, aura, beam, swirl, ground, above, toMe, flash, shake). `fxCues` adds a small cue for each status that landed. `act()` sets `B.wait` to the impact time: `bText`, hurt flashes (`hurtWait`), HP bars (`showHp`/`hpWait`) and faints (`faintWait`) wait for it, and `B.fxEnd` stretches the turn lock. Sprites: `VFX_SPR` (assets/vfx); a missing one draws as a glow in `VFX_COL`.
- **Ability sounds:** every `ABIL` entry has its own sound in the SOUND section: `voice()` (pitch contour + formant filters + roughness + breath) builds the animal calls in `V` (howl, darkHowl, growl, snarl, bark, yip, foxScream, squawk, whistle, meow, yowl, hoot, screech, dook, grunt, squeal, croak, roar, whinny...), and `AB[id]` composes each ability from them. `act()` plays `ab_<id>` (bosses 12% lower) and mutes the generic hit thud while it does (crits still ring). All of them run through one gain, `VOX_VOL`. A new ability needs an `AB` entry too.
- **Female heroes:** sheets `<cls>_f`; `heroSheet()` picks them.

## Art pipeline (ChatGPT in Chrome)

1. Type the prompt into the ChatGPT tab (transparent background, rows/frames or item order spelled out, "no text").
2. In that tab, inject a helper that fetches the newest generated `main img` as a blob and adds a big green
   SAVE button that downloads it; click the button with a real mouse click.
3. Copy the newest `*.tmp` (match it by byte size) from `Downloads` into `assets_raw/` (animations:
   `anim_<name>.png`; icon sheets: `items_<name>_sheet.png`), remove white backgrounds/halos if needed, then run
   `tools/animate.py <name>` or `tools/pixelate.py classitems <name>`. Check `assets_raw/anim_<name>_check.png`.
   Downloads: Chrome opens a Save As window and writes a `*.tmp` in Downloads meanwhile; cancelling it deletes the
   tmp, so copy it the moment it appears and check it's a complete PNG (a grab script that loops on that works well).
   If ChatGPT starts "cleaning the background" with code, just save the generated image (its haze is below the alpha cut).
   Ask for "just generate the image, no code or post-processing" to skip that detour.
4. New static sprites must be added to `ART_FILES` — animation sheets register themselves via `anims.js`.

## Testing

There is no test runner in the repo. Headless Node scripts stub canvas/audio and `eval` the game's `<script>`
(extract it with: `sed -n '/<script>$/,/<\/script>/p' index.html | sed '1d;$d'`), then drive it: a bot that
picks a starter, walks into each wild group, chooses abilities, and plays floors 1–20 is the best smoke test;
a boss simulator (fixed team/level/kit vs the boss, many runs) is the best balance check. Always at least
syntax-check after edits: `node --check` on the extracted script. To preview visually, run
`python -P -m http.server 8765 --bind 127.0.0.1` in this folder and open it in a new Chrome tab (freeze the
loop with `window.__U = update; window.update = () => {}` and step `__U(1/60)` + `draw()` manually, because
background tabs throttle animation frames).
