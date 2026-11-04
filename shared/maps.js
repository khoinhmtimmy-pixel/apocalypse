// shared/maps.js — the data-driven map layer of the engine.
// One deterministic generator serves both the server (collision, hazards, spawns)
// and the client (tile rendering). Same mapId on both sides => identical world.
// Later, Tiled-authored JSON can replace/extend generateMap() without changing
// either consumer's interface.

// ---------------------------------------------------------------- biomes ---

export const TILE = { GROUND: 0, WATER: 1, WALL: 2, SHADE: 3 };

export const BIOMES = {
  zombie_city: {
    id: 'zombie_city',
    name: 'Zombie City',
    desc: 'A ruined city overrun by accumulating hordes. Hold the streets, loot supplies, stay alive.',
    palette: {
      ground1: 0x494d52, ground2: 0x555a61, water: 0x1d4e5e,
      wall: 0x5e6067, wallTop: 0x767a82, shade: 0x2d5f3f, waterTint: 0x224455,
      fire: 0xff7a33, sky: 0x2a2c31, crack: true,
    },
    flooded: false,
    heat: false,
    zombies: true,
    rules: {
      waveInterval: 12000,     // ms between waves
      zombiesPerWave: 2,       // grows every wave (+2)
      maxZombies: 40,
      zombieSpeed: 54,         // px/s base, +3.5 per wave, capped 120
      zombieDamage: 9,         // hp per hit
      zombieAttackMs: 700,
      zombieContact: 20,       // px hit distance
    },
  },

  flooded_world: {
    id: 'flooded_world',
    name: 'Flooded World',
    desc: 'Rising sea levels swallow the island. High ground is life — the water never stops coming.',
    palette: {
      ground1: 0x62914a, ground2: 0x578341, water: 0x16505c,
      wall: 0x6e6e73, wallTop: 0x8a8a90, shade: 0x2c6140, waterTint: 0x246a80,
      fire: 0xff7a33, sky: 0x20272e, tuft: true, dirt: 0x7a5a34,
    },
    flooded: true,
    heat: false,
    zombies: false,
    rules: {
      waterRate: 0.0050,       // waterLevel 0..1, reaches full in ~200s
      submergedDps: 4,         // hp/s while standing in water
    },
  },

  heat_wastes: {
    id: 'heat_wastes',
    name: 'Heat Wastes',
    desc: 'Climate breakdown: lethal heat waves on a scorched planet, wildfires spreading. Find shade.',
    palette: {
      ground1: 0xd6bd7e, ground2: 0xc9b071, water: 0x2b6f7c,
      wall: 0x8a6c40, wallTop: 0xa5834e, shade: 0x2f6a45, waterTint: 0x2b6f7c,
      fire: 0xff7a33, sky: 0x3a2d20, dirt: 0x8f713e,
    },
    flooded: false,
    heat: true,
    zombies: false,
    rules: {
      heatPeriodMs: 90000,     // temperature sine period
      heatMin: 26, heatMax: 55,
      heatDamageTemp: 40,      // above this, heat starts hurting
      heatDamageScale: 0.45,   // dps above threshold = (temp-40)*scale
      shadeRadius: 90,         // px of shade zones
      fireGrowth: 0.13,        // fire radius grows (tiles/s) from every seed
      fireDps: 6,              // hp/s while burning
      maxFireRadiusTiles: 12,
    },
  },
};

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

// Smooth value noise with bilinear interpolation over a random lattice.
function valueNoise(rng, width, height, freq) {
  const gw = freq + 2, lat = new Float32Array(gw * (freq + 2));
  for (let i = 0; i < lat.length; i++) lat[i] = rng();
  const out = new Float32Array(width * height);
  const step = width / freq;
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const gx = tx / step, gy = ty / step;
      const x0 = Math.min(freq, Math.floor(gx)), y0 = Math.min(freq, Math.floor(gy));
      const fx = gx - x0, fy = gy - y0;
      const v00 = lat[y0 * gw + x0], v10 = lat[y0 * gw + x0 + 1];
      const v01 = lat[(y0 + 1) * gw + x0], v11 = lat[(y0 + 1) * gw + x0 + 1];
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const top = v00 + (v10 - v00) * sx, bot = v01 + (v11 - v01) * sx;
      out[ty * width + tx] = Math.max(0, Math.min(1, top + (bot - top) * sy));
    }
  }
  return out;
}

// ------------------------------------------------------------- generator ---

const cache = new Map();

export function generateMap(mapId) {
  if (cache.has(mapId)) return cache.get(mapId);
  if (!BIOMES[mapId]) mapId = 'zombie_city';
  const biome = BIOMES[mapId];

  const W = 48, H = 48, T = 32; // 1536x1536 px world
  const rng = mulberry32(hashString('doomdays:' + mapId));

  const tiles = new Array(W * H).fill(TILE.GROUND);
  const heights = new Array(W * H).fill(255);

  // Height field: used by flooded_world (water coverage) and as a subtle
  // variation hint everywhere. Center Spawn Plateau for flooded worlds.
  if (biome.flooded) {
    const n1 = valueNoise(rng, W, H, 6), n2 = valueNoise(rng, W, H, 12);
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const edge = 1 - Math.hypot(x + .5 - cx, y + .5 - cy) / R; // island falloff
      let v = 0.62 * n1[i] + 0.38 * n2[i];
      v = v * Math.max(0, edge + 0.25);            // drown the rim
      v += Math.max(0, 1 - Math.hypot(x + .5 - cx, y + .5 - cy) / (R * 0.45)) * 0.3; // plateau
      heights[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
    }
  }

  // Buildings: solid wall blocks with a 1-tile gap between them. The center
  // plaza (spawn area) stays clear.
  const clearZone = (x, y) => Math.abs(x - 23) < 5 && Math.abs(y - 23) < 5;
  const buildings = Math.round(W * H / 130); // ~17 buildings
  for (let b = 0; b < buildings; b++) {
    const bw = 2 + Math.floor(rng() * 5), bh = 2 + Math.floor(rng() * 5);
    const bx = 1 + Math.floor(rng() * (W - bw - 2));
    const by = 1 + Math.floor(rng() * (H - bh - 2));
    if (Math.abs(bx - 23) < 6 && Math.abs(by - 23) < 6) continue; // keep plaza clear
    // skip if it overlaps an existing wall region heading
    let overlaps = false;
    for (let y = by - 1; y <= by + bh; y++) for (let x = bx - 1; x <= bx + bw; x++)
      if (tiles[y * W + x] === TILE.WALL) overlaps = true;
    if (overlaps) continue;
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++)
      tiles[y * W + x] = TILE.WALL;
  }

  // Shade canopies (heat biomes) scattered on ground tiles.
  const shadeZones = [];
  if (biome.heat) {
    for (let k = 0; k < 6; k++) {
      let tx = 0, ty = 0, tries = 0;
      do {
        tx = 1 + Math.floor(rng() * (W - 2)); ty = 1 + Math.floor(rng() * (H - 2)); tries++;
      } while (tiles[ty * W + tx] !== TILE.GROUND && tries < 40);
      if (tiles[ty * W + tx] === TILE.GROUND) {
        tiles[ty * W + tx] = TILE.SHADE;
        shadeZones.push({ tx, ty, r: biome.rules.shadeRadius / T });
      }
    }
  }

  // Points of interest ------------------------------------------------------
  const freeTile = () => {
    for (let n = 0; n < 200; n++) {
      const tx = 1 + Math.floor(rng() * (W - 2)), ty = 1 + Math.floor(rng() * (H - 2));
      const i = ty * W + tx;
      if (tiles[i] === TILE.GROUND && !clearZone(tx, ty)) return { tx, ty };
    }
    return { tx: 23, ty: 18 };
  };

  // Supply caches: on high ground for flooded worlds, anywhere dry otherwise.
  const supplies = [];
  for (let k = 0; k < 14; k++) {
    if (biome.flooded) {
      // rank some random candidates by height, take the best
      let best = null;
      for (let n = 0; n < 12; n++) {
        const tx = 1 + Math.floor(rng() * (W - 2)), ty = 1 + Math.floor(rng() * (H - 2));
        const i = ty * W + tx;
        if (tiles[i] !== TILE.GROUND) continue;
        if (!best || heights[i] > best.h) best = { tx, ty, h: heights[i] };
      }
      if (best) supplies.push({ tx: best.tx, ty: best.ty });
    } else {
      const p = freeTile();
      supplies.push({ tx: p.tx, ty: p.ty });
    }
  }

  // Zombie nest sites (zombie biomes): spread to the four quadrants + edges.
  const nests = [];
  if (biome.zombies) {
    const quads = [[4, 4], [W - 5, 4], [4, H - 5], [W - 5, H - 5], [W / 2 | 0, 3], [W / 2 | 0, H - 4]];
    for (const [qx, qy] of quads) nests.push({ tx: qx, ty: qy });
  }

  // Wildfire seeds (heat biome): away from spawn center.
  const fires = [];
  if (biome.heat) {
    for (let k = 0; k < 4; k++) {
      let tx, ty, ok = false;
      for (let n = 0; n < 60 && !ok; n++) {
        tx = 2 + Math.floor(rng() * (W - 4)); ty = 2 + Math.floor(rng() * (H - 4));
        ok = Math.hypot(tx - 23, ty - 23) > 14 && tiles[ty * W + tx] === TILE.GROUND;
      }
      if (ok) fires.push({ tx, ty });
    }
  }

  // Spawn points: free tiles around the central plaza.
  const spawns = [
    { tx: 23, ty: 23 }, { tx: 21, ty: 23 }, { tx: 25, ty: 23 },
    { tx: 23, ty: 21 }, { tx: 23, ty: 25 }, { tx: 21, ty: 21 },
    { tx: 25, ty: 25 }, { tx: 21, ty: 25 }, { tx: 25, ty: 21 },
  ];

  const map = {
    id: mapId, name: biome.name, width: W, height: H, tileSize: T,
    px: W * T, py: H * T,
    tiles, heights, spawns, supplies, nests, fires, shadeZones,
    biome,
  };

  cache.set(mapId, map);
  return map;
}

// ------------------------------------------------- server helpers (pure) ---

// Is this pixel blocked for a character given current water level?
export function isBlockedMap(map, px, py, waterLevel) {
  if (px < 0 || py < 0 || px >= map.px || py >= map.py) return true;
  const T = map.tileSize;
  const tx = Math.floor(px / T), ty = Math.floor(py / T);
  const i = ty * map.width + tx;
  if (map.tiles[i] === TILE.WALL) return true;
  if (map.biome.flooded && map.heights[i] < waterLevel * 255) return true;
  return false;
}

export function tileIndexAt(map, px, py) {
  const T = map.tileSize;
  const tx = Math.min(map.width - 1, Math.max(0, Math.floor(px / T)));
  const ty = Math.min(map.height - 1, Math.max(0, Math.floor(py / T)));
  return ty * map.width + tx;
}
