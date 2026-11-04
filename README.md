# ☠ Doomdays

2D top-down multiplayer survival game. Survive apocalyptic biomes online
with other people: **Zombie City** (accumulating hordes), **Flooded World**
(rising water, high ground is life), **Heat Wastes** (heat waves +
spreading wildfires, find shade).

## Stack

- **Client**: Phaser 4, procedural textures and deterministic world generation
  (`shared/maps.js` is used by *both* the server simulation and the client renderer).
- **Server**: Colyseus 0.18 authoritative rooms, Schema 5 patched state,
  `filterBy(['mapId'])` matchmaking so everyone picking the same map plays together.
- Chat, supply caches, per-biome hazard tick: all server-authoritative.

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
npm run smoke   # headless joins both maps, moves, checks state sync + hazards
```

## Controls

- WASD / arrows — move (server-authoritative: the client sends input intents, never positions)
- Enter — chat, esc to stop
- Walk into a supply crate — heals. Watch the hazard meter.

## Roadmap (engine extension points)

- More biomes = one new entry in `shared/maps.js` + hazard tick in `SurvivalRoom`.
- Tiled-authored maps can replace `generateMap()` behind the same interface.
- Client-side prediction (Colyseus fixed timestep + input queue), persistence
  (`@colyseus/database`), inventory/crafting, safe-house building,
  Server-side `StateView` interest management for big maps.
