# Backpack Platformer

**Pack Rat Dungeon** is a side-scrolling roguelike platformer about packing the perfect backpack. Fight down through 20 floors of a dark-fantasy dungeon, cram every item you find into a 10×4 grid, and merge duplicates to make them stronger.

## Play

Open `index.html` in a browser (double-click works). No install or build step needed.

| Key | Action |
| --- | --- |
| A / D | Move |
| W | Jump |
| S | Drop through ledges |
| Shift | Dash |
| Space | Attack |
| E | Class ability (in the Sanctuary: use / pet) |
| Q | Drink a potion |
| B | Open the backpack |
| R / right-click | Rotate an item while packing |
| N | Toggle the minimap |
| P | Pause |
| M | Music off / all sound off / on |

## Features

- **The Sanctuary:** a home base between runs. Walk around as your hero, switch class at the banners, pick a male or female look at the mirror, read your run records, and visit (and pet!) every animal you've ever rescued. Animals you haven't found yet wait as silhouettes. Walk through the gate to start a run.
- **Four classes**, each with its own ten class-only items and an E ability:
  - **Warrior:** Shield Block
  - **Archer:** Arcane Shot
  - **Rogue:** Bombs
  - **Beastmaster:** Spirit Wolf, plus +1 damage on every pet
- **Backpack management:** items have shapes, synergies (whetstones, charms, fletching kits) and merge up to level V.
- **Rescue animals:** monsters keep captured animals in guarded cages. Beat the guards, open the cage, and the animal joins you in one of 3 pet slots. There are 10 to find, each with its own ability:
  - **Common:** White Shepherd (stun), Gray Cat (finisher), Calico (mark), Ferret (weaken), Toad (poison).
  - **Uncommon:** Fox (triple crits), Boar (charge).
  - **Rare:** Cockatiel (heals you), Owl (blind).
  - **Legendary:** Dragon (burn).
- **Pet talents:** pets level up from the kills you make together. Right-click a pet in its slot to spend talent points across three tiers.
- **Team synergies:** Clowder (both cats), Pack Hunt (Shepherd + Fox) and Wildfire (Dragon + Toad).
- **Lively pets:** they follow you, hop off ledges and leap gaps, and wander, sniff, perch or lie down when you stand still.
- **The dungeon fights back:** monsters are tougher, hit harder, attack faster and come in larger numbers for every pet on your team (and a little more as your pets level up), so a full team still has a tough time.
- **Long levels:** one long stretch per floor, with chasms and arcane barriers you can only get past by dashing, challenge courses with treasure chests at the end, buff plants, and an Explorer's Lantern that reveals more with each level.
- **Two acts:** floors 1–10 end with the Warden boss, and floors 11–20 bring new enemies and hazards (lava, flame vents, crumbling blocks). Endless mode unlocks after floor 20.
- **Original chiptune soundtrack and sound effects,** synthesized live with Web Audio. Floors rotate through a pool of tracks without repeating the last two.

## Project layout

```
index.html          the whole game (plain JavaScript + canvas, no libraries)
assets/             processed pixel art: items, characters, props, tiles, backgrounds, animations
tools/pixelate.py   turns raw art sheets into game sprites (Pillow)
tools/animate.py    slices animation sheets into frames + anims.js
```

The art was generated with ChatGPT in a dark-fantasy pixel style, then processed by the tools above. The raw sheets aren't included in the repo; the game only needs `assets/`.
