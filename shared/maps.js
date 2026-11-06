// shared/maps.js — the data-driven map layer of the engine, now ENDLESS.
// The world is no longer a fixed 48×48 grid: it is an infinite plane of 32×32
// chunks, generated deterministically from (mapId, chunkX, chunkY). The server
// simulates collision/hazards from chunk data and the client paints chunk
// textures as they scroll into view — same chunk on both sides => same world.
// Lattice value-noise makes terrain continuous across chunk borders (flooded
// worlds get oceans/shorelines that drift forever as the water rises).

// ---------------------------------------------------------------- biomes ---

export const TILE = { GROUND: 0, WATER: 1, WALL: 2, SHADE: 3, ROAD: 4, SIDEWALK: 5 };
export const TILE_SIZE = 32;            // px per tile
export const CHUNK_TILES = 32;          // tiles per chunk edge
export const CHUNK_PX = CHUNK_TILES * TILE_SIZE;   // px per chunk edge

// the one guaranteed safe start area, near world origin (inside chunk 0,0)
export const PLAZA = { x: 23.5, y: 23.5 };
export const SPAWNS = [
  { tx: 23, ty: 23 }, { tx: 21, ty: 23 }, { tx: 25, ty: 23 },
  { tx: 23, ty: 21 }, { tx: 23, ty: 25 }, { tx: 21, ty: 21 },
  { tx: 25, ty: 25 }, { tx: 21, ty: 25 }, { tx: 25, ty: 21 },
];

export const BIOMES = {
  zombie_city: {
    id: 'zombie_city',
    name: 'Zombie City',
    desc: 'An endless ruined city overrun by accumulating hordes. Loot supplies, band together, stay alive.',
    palette: {
      ground1: 0x5b6169, ground2: 0x676e77, water: 0x1d4e5e,
      wall: 0x6f757e, wallTop: 0x8f959e, shade: 0x2d5f3f, waterTint: 0x224455,
      fire: 0xff7a33, sky: 0x1b1f26, crack: true,
      road: 0x3d4147, kerb: 0x878d95, lane: 0xe8c95a,
    },
    flooded: false, heat: false, frost: false, toxic: false,
    zombies: true, meteors: false, zoneKind: null, city: true,
    rules: {
      waveInterval: 12000,
      zombiesPerWave: 2,
      maxZombies: 40,
      zombieSpeed: 54,
      zombieDamage: 9,
      zombieAttackMs: 700,
      zombieContact: 20,
    },
  },

  flooded_world: {
    id: 'flooded_world',
    name: 'Flooded World',
    desc: 'Endless archipelago. The flood creeps toward its peak — climb and hop the dry highland islands forever.',
    palette: {
      ground1: 0x62914a, ground2: 0x578341, water: 0x16505c,
      wall: 0x6e6e73, wallTop: 0x8a8a90, shade: 0x2c6140, waterTint: 0x246a80,
      fire: 0xff7a33, sky: 0x20272e, tuft: true, dirt: 0x7a5a34,
    },
    flooded: true, heat: false, frost: false, toxic: false,
    zombies: false, meteors: false, zoneKind: null,
    rules: {
      waterRate: 0.0050,       // waterLevel 0..1, reaches the cap in ~200s
      waterCap: 0.90,          // the peak flood — dry highlands stay reachable
      submergedDps: 4,
    },
  },

  heat_wastes: {
    id: 'heat_wastes',
    name: 'Heat Wastes',
    desc: 'Lethal heat waves under a scorched endless desert, wildfires spreading. Find shade, keep moving.',
    palette: {
      ground1: 0xd6bd7e, ground2: 0xc9b071, water: 0x2b6f7c,
      wall: 0x8a6c40, wallTop: 0xa5834e, shade: 0x2f6a45, waterTint: 0x2b6f7c,
      fire: 0xff7a33, sky: 0x3a2d20, dirt: 0x8f713e,
    },
    flooded: false, heat: true, frost: false, toxic: false,
    zombies: false, meteors: false, zoneKind: 'shade',
    rules: {
      heatPeriodMs: 90000,
      heatMin: 26, heatMax: 55,
      heatDamageTemp: 40,
      heatDamageScale: 0.45,
      zoneRadius: 90,
      fireGrowth: 0.13,
      fireDps: 6,
      maxFireRadiusTiles: 12,
      fireSeedChance: 0.35,
    },
  },

  frost_wastes: {
    id: 'frost_wastes',
    name: 'Frost Wastes',
    desc: 'A frozen dark-ages world. The cold front sweeps in again and again — huddle at campfires or freeze.',
    palette: {
      ground1: 0xdde8f2, ground2: 0xcddcea, water: 0x27546b,
      wall: 0x7c8692, wallTop: 0x99a3b0, shade: 0x3d6f8c,
      fire: 0xff9a3a, sky: 0x27313d, stone: true,
    },
    flooded: false, heat: false, frost: true, toxic: false,
    zombies: false, meteors: false, zoneKind: 'campfire',
    rules: {
      coldPeriodMs: 80000,
      coldMin: -25, coldMax: 15,
      freezeTemp: 0,           // below this °C the cold hurts
      coldScale: 0.5,          // dps = (freezeTemp - cold) * scale
      zoneRadius: 90,
    },
  },

  toxic_bog: {
    id: 'toxic_bog',
    name: 'Toxic Bog',
    desc: 'Fungal green gas surges over an endless swamp. When the surge comes, Shelter in a clean-air dome.',
    palette: {
      ground1: 0x4d6b3f, ground2: 0x44603a, water: 0x274d33,
      wall: 0x54614d, wallTop: 0x6b7a63, shade: 0x6f944a, waterTint: 0x2b5b38,
      fire: 0x74ff5a, sky: 0x1b2418, tuft: true, dirt: 0x5c4a2e,
    },
    flooded: false, heat: false, frost: false, toxic: true,
    zombies: false, meteors: false, zoneKind: 'dome',
    rules: {
      toxinPeriodMs: 70000,    // gas surge pulse
      toxinThreshold: 0.55,    // above this surge strength, toxin hurts
      toxinDps: 5.5,
      zoneRadius: 90,
    },
  },

  meteor_fall: {
    id: 'meteor_fall',
    name: 'Meteor Fall',
    desc: 'An endless burnt bombardment zone. Meteors land without warning — watch the sky, dodge the craters.',
    palette: {
      ground1: 0x8f6f52, ground2: 0x836449, water: 0x2b5f6b,
      wall: 0x5f4a38, wallTop: 0x7a6047, shade: 0x356346,
      fire: 0xff5a1f, sky: 0x2c1d16, crack: true, dirt: 0x4d3c2c,
    },
    flooded: false, heat: false, frost: false, toxic: false,
    zombies: false, meteors: true, zoneKind: null,
    rules: {
      meteorIntervalMs: 16000, // between strikes (plus jitter)
      meteorLeadMs: 2600,      // from warning to impact
      meteorDamage: 34,
      meteorRadius: 80,        // px blast radius
      fireGrowth: 0.14,
      fireDps: 6,
      maxFireRadiusTiles: 9,
    },
  },
};

// --------------------------------------------------------- difficulty ---

// Difficulty picks for the select screen (Đêm Xác Sống-style). Applied by the
// room to zombie stats/hazards and coin payouts; everyone in a room shares the
// difficulty of whoever created it.
export const DIFFS = [
  { id: 0, name: 'Easy',   hp: 0.8, spd: 0.85, dmg: 0.7, coin: 0.8,  waves: 0.9 },
  { id: 1, name: 'Normal', hp: 1,   spd: 1,    dmg: 1,   coin: 1,    waves: 1 },
  { id: 2, name: 'Brutal', hp: 1.45, spd: 1.15, dmg: 1.4, coin: 1.5, waves: 1.3 },
  { id: 3, name: 'Doom',   hp: 2.1, spd: 1.32, dmg: 1.9, coin: 2.2,  waves: 1.6 },
];

// ------------------------------------------------------------ utilities ---

function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// Global lattice value-noise: node values come from (mapId, lattice coords),
// so terrain is continuous and infinite, with no chunk seams.
function nodeVal(mapId, nx, ny, ls) {
  return mulberry32(hashString(`lat:${mapId}:${ls}:${nx}:${ny}`))();
}

function noiseAt(mapId, tx, ty, ls) {
  const gx = tx / ls, gy = ty / ls;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const v00 = nodeVal(mapId, x0, y0, ls), v10 = nodeVal(mapId, x0 + 1, y0, ls);
  const v01 = nodeVal(mapId, x0, y0 + 1, ls), v11 = nodeVal(mapId, x0 + 1, y0 + 1, ls);
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = v00 + (v10 - v00) * sx, b = v01 + (v11 - v01) * sx;
  return clamp01(a + (b - a) * sy);
}

// Flooded worlds: 0..255 ground elevation at world tile (tx, ty).
export function heightAt(mapId, tx, ty) {
  const biome = BIOMES[mapId];
  if (!biome || !biome.flooded) return 255;
  const v = 0.50 * noiseAt(mapId, tx, ty, 24)
        + 0.34 * noiseAt(mapId, tx, ty, 6)
        + 0.16 * noiseAt(mapId, tx, ty, 2.5);
  const plateau = Math.max(0, 1 - Math.hypot(tx + .5 - PLAZA.x, ty + .5 - PLAZA.y) / 15) * 0.30;
  return clamp01(v * 0.82 + plateau) * 255;
}

function nearPlaza(wtx, wty, r) {
  return Math.abs(wtx + .5 - PLAZA.x) < r && Math.abs(wty + .5 - PLAZA.y) < r;
}

// ------------------------------------------------------------- chunks ------

const chunkCache = new Map();

// --------------------------------------------------------- city layout ---
// The ruined city is a street lattice, not scattered rubble: two-lane asphalt
// roads every CITY_PITCH tiles, a one-tile pavement ring, and one building
// inside each block. Every tile comes from its WORLD coordinate, so blocks line
// up across chunk seams and the server and the browser generate the same maze.
export const CITY_PITCH = 8;      // tiles per block, road included
export const CITY_ROAD_W = 2;     // asphalt tiles at the start of each pitch
const CITY_BLOCK_W = 4;           // buildable interior of a block

const mod = (n, m) => ((n % m) + m) % m;

function carveCity(mapId, tiles, wtx, wty) {
  // roads + pavements
  for (let ly = 0; ly < CHUNK_TILES; ly++) {
    for (let lx = 0; lx < CHUNK_TILES; lx++) {
      const gx = wtx(lx), gy = wty(ly);
      const i = ly * CHUNK_TILES + lx;
      if (nearPlaza(gx, gy, 6)) { tiles[i] = TILE.ROAD; continue; }  // paved spawn square
      const mx = mod(gx, CITY_PITCH), my = mod(gy, CITY_PITCH);
      if (mx < CITY_ROAD_W || my < CITY_ROAD_W) tiles[i] = TILE.ROAD;
      else if (mx === CITY_ROAD_W || my === CITY_ROAD_W ||
               mx === CITY_PITCH - 1 || my === CITY_PITCH - 1) tiles[i] = TILE.SIDEWALK;
    }
  }

  // one building per block, seeded by the block's own coordinates
  const b0x = Math.floor(wtx(0) / CITY_PITCH), b1x = Math.floor(wtx(CHUNK_TILES - 1) / CITY_PITCH);
  const b0y = Math.floor(wty(0) / CITY_PITCH), b1y = Math.floor(wty(CHUNK_TILES - 1) / CITY_PITCH);
  for (let by = b0y; by <= b1y; by++) {
    for (let bx = b0x; bx <= b1x; bx++) {
      const rng = mulberry32(hashString(`city:${mapId}:${bx}:${by}`));
      if (rng() < 0.12) continue;                        // park / empty lot
      const w = 2 + Math.floor(rng() * 3), h = 2 + Math.floor(rng() * 3);
      const ox = Math.floor(rng() * (CITY_BLOCK_W - w + 1));
      const oy = Math.floor(rng() * (CITY_BLOCK_W - h + 1));
      const x0 = bx * CITY_PITCH + CITY_ROAD_W + 1 + ox;
      const y0 = by * CITY_PITCH + CITY_ROAD_W + 1 + oy;
      const lx0 = wtx(0), ly0 = wty(0);
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          if (nearPlaza(x, y, 6)) continue;
          const lx = x - lx0, ly = y - ly0;
          if (lx < 0 || ly < 0 || lx >= CHUNK_TILES || ly >= CHUNK_TILES) continue;
          tiles[ly * CHUNK_TILES + lx] = TILE.WALL;
        }
      }
    }
  }
}

// One chunk of an endless world: 32×32 tiles + deterministic features.
// lootSpots: crates to scavenge · nests: zombie spawn sites · safeZones:
// shade canopies / campfires / clean-air domes · fireSeeds: wildfire origins.
export function genChunkData(mapId, cx, cy) {
  if (!BIOMES[mapId]) mapId = 'zombie_city';
  const key = `${mapId}:${cx}:${cy}`;
  let c = chunkCache.get(key);
  if (c) return c;

  const biome = BIOMES[mapId];
  const rng = mulberry32(hashString('dd:' + key));
  const tiles = new Array(CHUNK_TILES * CHUNK_TILES).fill(TILE.GROUND);
  const wtx = (tx) => cx * CHUNK_TILES + tx;
  const wty = (ty) => cy * CHUNK_TILES + ty;

  // Buildings: the zombie city carves a street grid; other biomes scatter
  // 1–2 ruin blocks per chunk, never inside the spawn plaza.
  if (biome.city) carveCity(mapId, tiles, wtx, wty);
  const buildingCount = biome.city ? 0 : 1 + Math.floor(rng() * 2);
  for (let b = 0; b < buildingCount; b++) {
    const bw = 2 + Math.floor(rng() * 4), bh = 2 + Math.floor(rng() * 4);
    const tx = 1 + Math.floor(rng() * (CHUNK_TILES - bw - 2));
    const ty = 1 + Math.floor(rng() * (CHUNK_TILES - bh - 2));
    let inPlaza = false;
    for (let y = ty; y < ty + bh && !inPlaza; y++)
      for (let x = tx; x < tx + bw && !inPlaza; x++)
        if (nearPlaza(wtx(x), wty(y), 6)) inPlaza = true;
    if (inPlaza) continue;
    let overlaps = false;
    for (let y = ty - 1; y <= ty + bh; y++)
      for (let x = tx - 1; x <= tx + bw; x++)
        if (tiles[y * CHUNK_TILES + x] === TILE.WALL) overlaps = true;
    if (overlaps) continue;
    for (let y = ty; y < ty + bh; y++)
      for (let x = tx; x < tx + bw; x++)
        tiles[y * CHUNK_TILES + x] = TILE.WALL;
  }

  // helper: a random ground tile in this chunk (world coords)
  const freeSpot = (minPlazaDist = 0) => {
    for (let n = 0; n < 40; n++) {
      const tx = Math.floor(rng() * CHUNK_TILES), ty = Math.floor(rng() * CHUNK_TILES);
      const i = ty * CHUNK_TILES + tx;
      if (tiles[i] === TILE.WALL || tiles[i] === TILE.SHADE) continue;
      if (minPlazaDist > 0) {
        const d = Math.hypot(wtx(tx) + .5 - PLAZA.x, wty(ty) + .5 - PLAZA.y);
        if (d < minPlazaDist) continue;
      }
      return { wtx: wtx(tx), wty: wty(ty), local: i };
    }
    return null;
  };

  const safeZones = [], lootSpots = [], fireSeeds = [], nests = [];

  // Safe zones (biome-dependent props): shade canopy / campfire / air dome.
  if (biome.zoneKind) {
    const count = 1 + (rng() < 0.5 ? 1 : 0);
    for (let k = 0; k < count; k++) {
      const p = freeSpot(9);
      if (!p) continue;
      safeZones.push({ x: p.wtx, y: p.wty, r: biome.rules.zoneRadius / TILE_SIZE, kind: biome.zoneKind });
      if (biome.zoneKind === 'shade') tiles[p.local] = TILE.SHADE;
    }
  }

  // Wildfire seed (heat biome).
  if (biome.heat && rng() < biome.rules.fireSeedChance) {
    const p = freeSpot(12);
    if (p) fireSeeds.push({ wtx: p.wtx, wty: p.wty });
  }

  // Loot crates: 3 per chunk, contents decided once and forever.
  for (let k = 0; k < 3; k++) {
    const p = freeSpot(4);
    if (p) lootSpots.push({ wtx: p.wtx, wty: p.wty, kind: rng() < 0.62 ? 'food' : 'med' });
  }

  // Zombie nest site (zombie biomes), away from the plaza.
  if (biome.zombies && rng() < 0.45) {
    const p = freeSpot(13);
    if (p) nests.push({ wtx: p.wtx, wty: p.wty });
  }

  c = { key, mapId, tiles, safeZones, lootSpots, fireSeeds, nests };
  if (chunkCache.size > 400) chunkCache.delete(chunkCache.keys().next().value);
  chunkCache.set(key, c);
  return c;
}

// Chunk-space helpers (handle negative world coords cleanly).
export function chunkOf(px, py) {
  return { cx: Math.floor(px / CHUNK_PX), cy: Math.floor(py / CHUNK_PX) };
}
export function tileOf(px, py) {
  return { tx: Math.floor(px / TILE_SIZE), ty: Math.floor(py / TILE_SIZE) };
}

// Server + client collision helpers -----------------------------------------

export function isWallAt(mapId, px, py) {
  const { cx, cy } = chunkOf(px, py);
  const chunk = genChunkData(mapId, cx, cy);
  const { tx, ty } = tileOf(px, py);
  const lx = tx - cx * CHUNK_TILES, ly = ty - cy * CHUNK_TILES;
  return chunk.tiles[ly * CHUNK_TILES + lx] === TILE.WALL;
}

// Blocked pixel check. Flooded worlds submerge tiles as waterLevel rises.
export function isBlockedAt(mapId, px, py, waterLevel) {
  const { tx, ty } = tileOf(px, py);
  if (heightAt(mapId, tx, ty) < waterLevel * 255) return true; // water everywhere else
  if (BIOMES[mapId] && BIOMES[mapId].flooded) return false;
  return isWallAt(mapId, px, py);
}
