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
| E | Class ability |
| Q | Drink a potion |
| B | Open the backpack |
| R / right-click | Rotate an item while packing |
| N | Toggle the minimap |
| P | Pause |
| M | Music off / all sound off / on |

## Features

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
- **Big levels:** platforming challenge courses with treasure chests at the end, buff plants, and an Explorer's Lantern that reveals more with each level.
- **Two acts:** floors 1–10 end with the Warden boss, and floors 11–20 bring new enemies and hazards (lava, flame vents, crumbling blocks). Endless mode unlocks after floor 20.
- **Original chiptune soundtrack and sound effects,** synthesized live with Web Audio.

## Project layout

```
index.html          the whole game (plain JavaScript + canvas, no libraries)
assets/             processed pixel art: items, characters, props, tiles, backgrounds, animations
tools/pixelate.py   turns raw art sheets into game sprites (Pillow)
tools/animate.py    slices animation sheets into frames + anims.js
```

The art was generated with ChatGPT in a dark-fantasy pixel style, then processed by the tools above. The raw sheets aren't included in the repo; the game only needs `assets/`.
