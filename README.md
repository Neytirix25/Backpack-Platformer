# Backpack Platformer

**Backpack Sanctuary** is a side-scrolling roguelike about raising a team of animal companions. Explore 20 floors of a dark-fantasy dungeon, run into wild animals to start turn-based battles, and collect their babies and eggs to grow your Sanctuary. Everything you pack in your 10×4 backpack powers up your pets.

## Play

Open `index.html` in a browser (double-click works). No install or build step needed.

| Key | Action |
| --- | --- |
| A / D | Move |
| W | Jump |
| S | Drop through ledges |
| Shift | Dash |
| E | In the Sanctuary: use / pet an animal |
| B | Open the backpack |
| T | Your pets: every pet you own, swap your team, talents (also the button by your team cards) |
| 1–6 / mouse | Battle: pick an ability, then click a target |
| R / right-click | Rotate an item while packing · cancel a target in battle |
| N | Toggle the minimap |
| P | Pause |
| M | Music off / all sound off / on |

## How it works

- **Your first companion:** a new game starts in the Sanctuary, where you pick a Shepherd Pup, a Fox Kit or a Cockatiel Chick.
- **Wild animals:** each floor has wild animal groups roaming its ledges. Run into one and a turn-based battle starts: your hero stands at the back, your pets line up front, middle and back, and the wild animals face them, **as many foes as you have pets**. Groups come in different compositions (packs, shield walls, healer-backed, hexers, venom), and Act II animals and Alphas know ultimate abilities.
- **Turn-based battles:** each pet picks one of its abilities (damage, heals, shields, buffs and curses such as Burn, Poison, Bleed, Stun, Blind, Weaken and Mark), then the foes act. The hero can use one backpack consumable per turn (heal, revive, cure, Strength, smoke, net). Long fights tire everyone out. If all your active pets faint, the run ends, but your pets keep every level.
- **Two acts of animals:** floors 1–10 are home to ordinary animals (Shepherd, cats, Cockatiel, Fox, Owl, Ferret, Boar, Toad). Floors 11–20 belong to mythical beasts only: the Dragon, the Shadow Wolf and eight fire beasts — the **Phoenix** (healer that rises from its ashes), **Hellhound** (burning bites, Three Heads), **Salamander** (stacks burns, regrows its tail), **Magma Tortoise** (molten-shell guardian), **Qilin** (sacred blessings), **Chimera** (lion, goat and serpent heads), **Sunmane Lion** (blazing roars) and **Ember Moth** (blinding spark dust). Each has six abilities, three talent trees and its own baby or egg, and new synergies: Hellfire (Hellhound + Phoenix), Pride (Lion + Chimera) and Magma Flow (Salamander + Tortoise).
- **Offspring:** beating a species you don't own always leaves its baby (Shepherd, cats, Fox, Ferret, Boar) or its egg (Cockatiel, Owl, Dragon, Toad). Eggs take up backpack space and hatch after 2 more wins. Species you already own sometimes leave another, which turns into experience.
- **Your collection is saved forever:** pets keep their levels (up to 30) and talents between runs. Bring any 3 into a run (front, middle, back) and swap them at the pet beds in the Sanctuary or from the backpack screen.
- **Talent trees:** every pet has three trees that read top to bottom (tiers open at levels 1, 5, 10, 16 and 22). Talents upgrade its abilities, add curses to its hits and power up the whole team, and each tree ends in an ultimate battle ability. Resetting is free.
- **Bosses:** the **Shadow Wolf** guards floor 10 (its shades vanish when it falls) and the **Elder Dragon** floor 20. Beat the Shadow Wolf within three turns to earn the achievement and its pup; beat the Elder Dragon without a pet fainting to earn its egg.
- **The Unicorn:** defeat a whole enemy team on the first turn of a battle and a Unicorn, impressed by your strength, joins your Sanctuary.
- **Clear tooltips:** hover any ability in battle to see exactly what it does with that pet's numbers: targets, damage, healing, every status with its chance and duration, and the cooldown.
- **Classes shape your team:**
  - **Warrior (Vanguard):** your front pet has +30% HP and +2 defense and starts every battle shielded.
  - **Archer (Volley):** you open each battle with arrows that hit every foe, and pets get +8% crit.
  - **Rogue (Poacher):** more offspring, faster-hatching eggs, and your pets' curses last longer.
  - **Beastmaster (Bond):** pets earn 50% more experience, and you can use two items per turn.
- **Awkward shapes:** almost nothing is a single square any more — horseshoes, wishbones, rings with holes, S and Z pieces, H-shaped wind chimes and crossed hex charms. The holes inside a shape are real: smaller items can sit in them.
- **Pet items:** collars, chew bones, harnesses and charms; family items for canines, cats, birds, drakes, toads and critters; front and back position items; legendaries like the Dragon Heart; and battle consumables. Items merge up to level V.
- **Team synergies:** Clowder (both cats), Pack Hunt (Shepherd + Fox) and Wildfire (Dragon + Toad).
- **Long levels:** chasms and arcane barriers you dash past, hazards that hurt your team, challenge courses with treasure chests, and buff plants that power up your next battle. Beat half of a floor's wild groups to open the exit, or all of them for the floor's chest. Camps on floors 5 and 15 fully heal your team.
- **A hand-made adventurer's look:** every menu is stitched leather, brass rivets, parchment notes and wooden buttons, with crisp pixel fonts (Jersey 10, Micro 5 and the blackletter Jacquarda Bastarda 9, all under the SIL Open Font License).
- **Animated abilities:** every ability has its own animation — Starfall rains stars on the foes, Howl sends sound waves rolling across the field, fireballs fly, claws slash, healing songs float notes to your pets, curses flash their runes. Damage numbers pop the moment each attack lands.
- **Original chiptune soundtrack and sound effects,** synthesized live with Web Audio. Every battle ability has its own animal voice: the Shepherd howls, bites come with a growl, the Cockatiel squawks and whistles its songs, the Toad croaks, the Owl hoots and shrieks, and the dragons roar.

## Project layout

```
index.html          the whole game (plain JavaScript + canvas, no libraries)
assets/             processed pixel art: items, characters, props, tiles, backgrounds, animations, the UI kit (assets/ui)
assets/fonts/       the bundled pixel fonts and their OFL licenses
tools/pixelate.py   turns raw art sheets into game sprites (Pillow)
tools/animate.py    slices animation sheets into frames + anims.js
```

The art was generated with ChatGPT in a dark-fantasy pixel style, then processed by the tools above. The raw sheets aren't included in the repo; the game only needs `assets/`.
