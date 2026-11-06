# ☠ Doomdays

2D top-down multiplayer survival game with an **endless world**. Survive apocalyptic
biomes online with other people:

- **Zombie City** — an endless ruined city, accumulating hordes. Melee swings ([Space] / left-click) take zombies down; they sometimes drop rations and medkits.
- **Flooded World** — the flood creeps toward its peak; chain forever between the dry highland islands
- **Heat Wastes** — heat waves + spreading wildfires across an endless desert
- **Frost Wastes** — freezing cold fronts; huddle at campfires or freeze
- **Toxic Bog** — fungal gas surges; Shelter in clean-air domes
- **Meteor Fall** — bombardment without warning; dodge the craters

## Stack

- **Client**: Phaser 4, procedural textures and deterministic infinite chunk
  generation (`shared/maps.js` is used by *both* the server simulation and the
  client renderer). Chunks (32×32 tiles) stream in around the camera; a zoomed
  world camera follows you closely while a second unzoomed camera renders the HUD.
- **Server**: Colyseus 0.18 authoritative rooms, Schema 5 patched state,
  `filterBy(['mapId'])` matchmaking so everyone picking the same map plays together.
- Chat, supply crates, hunger, per-biome hazards, wildfires, meteors: all
  server-authoritative.

## Survival systems

- **Hunger** drains constantly. At zero, you **starve and lose health**.
- **Loot**: walk onto supply crates scattered across the endless world to scavenge
  rations 🍖 and medkits 💊. Downed zombies drop some of their supplies too.
  Scavenged crates stay scavenged for everyone (late joiners get the true list).
- **Combat**: hold left-click shoots the equipped gun toward your mouse; [Space]
  swings a melee arc. The server arbitrates reach, cooldown, ammo, reloads, bullets,
  crits, knockback and every drop. [1]–[5] / mouse wheel switch guns.
- **Shop & coins** (ported from Đêm Xác Sống): zombies pay coins for every kill.
  Press [B] any time to buy 20 guns in 5 classes, 11 multi-level upgrades
  (damage, fire rate, mag, reload, speed, max HP, armor, regen, crit, coin magnet,
  pet training), bombs [Z] and rush charges [V]. The server validates every price.
- **Pets**: adopt a bat, wolf or owl — it orbits you and bites nearby zombies.
- **Difficulty**: Easy / Normal / Brutal / Doom picks on the biome screen scale
  zombie HP, speed, damage, wave pacing and coin rewards for the room.
- **[F] eat** a ration (restores hunger + a little health), **[G] heal** with a medkit.
- The map is **endless**: walk forever; each chunk regenerates deterministically
  from its (map, x, y) so the world is identical for every player. A pocket
  **radar** (bottom-right) trails your explored chunks and shows nearby threats.
- When you drift away, out-of-reach zombies fade out instead of chasing forever.

## Run it

```bash
npm install
npm run build     # bundles client/main.js -> public/dist/game.js
npm run dev       # server on http://localhost:2567, serving the client too
```

Open http://localhost:2567, pick a biome, move with WASD, Enter to chat.
Open two browser tabs to survive together (same biome = same room).

## Verify

```bash
npm run smoke   # headless joins all six biomes, moves, checks state sync,
                # hazards, hunger drain, matchmaking and biome isolation
```

## Controls

- WASD / arrows — move (server-authoritative: the client sends input intents, never positions)
- Hold left-click — shoot toward the mouse (R reload · 1–5 / wheel switch guns)
- [Space] — melee swing · [B] shop · [Z] bomb · [V] rush
- [F] eat a ration · [G] use a medkit
- Enter — chat, esc to stop
- Walk onto a supply crate — loot it (rations / medkits)
- F — eat a ration · G — use a medkit
- Watch the hunger bar and the biome hazard meter. Starving hurts.

## Roadmap (engine extension points)

- More biomes = one new entry in `shared/maps.js` BIOMES + hazard tick in `SurvivalRoom`.
- More loot types (weapons, tools, batteries) slot into the same loot/inventory pipeline.
- Tiled-authored piece packs can extend `genChunkData()` behind the same interface.
- Client-side prediction (Colyseus fixed timestep + input queue), persistence
  (`@colyseus/database`), inventory/crafting UI, safe-house building.
