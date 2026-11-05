# ☠ Doomdays

2D top-down multiplayer survival game with an **endless world**. Survive apocalyptic
biomes online with other people:

- **Zombie City** — an endless ruined city, accumulating hordes
- **Flooded World** — the water never stops rising; climb forever toward high ground
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
  rations 🍖 and medkits 💊. Late joiners receive the true scavenged state.
- **[F] eat** a ration (restores hunger + a little health), **[G] heal** with a medkit.
- The map is **endless**: walk forever; each chunk regenerates deterministically
  from its (map, x, y) so the world is identical for every player.

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
