// client/tiles.js — Minecraft-flavored procedural pixel art. Everything is
// chunky blocky pixels (8x8 blocks per 32px tile): grass/asphalt/sand ground,
// cobblestone buildings, leaf canopies, chest crates, blocky survivors.
// The full static map is painted once into a canvas texture; actor/prop
// sprites are generated at boot from the biome palette.
import Phaser from 'phaser';
import { BIOMES, TILE, TILE_SIZE, CHUNK_TILES, CHUNK_PX, CITY_PITCH, CITY_ROAD_W, genChunkData } from '../shared/maps.js';

const P = 4; // 1 "minecraft block pixel" = 4px in a 32px tile => 8 blocks/tile
const S = 32;

// ---------------------------------------------------------------- helpers ---

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shade(hex, delta) {
  const r = Math.max(0, Math.min(255, ((hex >> 16) & 255) + delta));
  const g = Math.max(0, Math.min(255, ((hex >> 8) & 255) + delta));
  const b = Math.max(0, Math.min(255, (hex & 255) + delta));
  return (r << 16) | (g << 8) | b;
}

function hash(n) { return ((n * 2654435761) >>> 0); }

function hexOf(n) { return '#' + (n >>> 0).toString(16).padStart(6, '0'); }

// ------------------------------------------------------- texture factory ---

function canvasTex(scene, key, w, h, draw) {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  scene.textures.addCanvas(key, canvas);
  return key;
}

// --------------------------------------------------- shared tile painters ---

// painter(ctx, absX, absY, tileIndex, seed) draws one tile at absolute coords
function paintGround(ctx, ax, ay, pal, groundLight, r) {
  const base = groundLight ? pal.ground1 : pal.ground2;
  ctx.fillStyle = '#' + base.toString(16).padStart(6, '0');
  ctx.fillRect(ax, ay, S, S);
  // chunky speckle blocks (lighter + darker)
  for (let i = 0; i < 5; i++) {
    const gx = Math.floor(r() * 8), gy = Math.floor(r() * 8);
    ctx.fillStyle = '#' + shade(base, r() > 0.5 ? 14 : -14).toString(16).padStart(6, '0');
    ctx.fillRect(ax + gx * P, ay + gy * P, P, P);
  }
  // grass tufts / asphalt cracks / sand ripples depending on palette warmth
  if (pal.tuft) {
    for (let i = 0; i < 2; i++) {
      const gx = Math.floor(r() * 7), gy = Math.floor(r() * 6);
      ctx.fillStyle = '#' + shade(base, -34).toString(16).padStart(6, '0');
      ctx.fillRect(ax + gx * P, ay + gy * P, 2, P + 2);
    }
  }
  if (pal.crack) {
    if (r() > 0.62) { // broken concrete crack
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      const sx = ax + Math.floor(r() * 6) * P, sy = ay + Math.floor(r() * 6) * P;
      ctx.fillRect(sx, sy, 2, P * 2);
      ctx.fillRect(sx - 2, sy + P, 2, P);
    }
  }
}

function paintWall(ctx, ax, ay, pal) {
  // cobblestone: dark mortar, 2x2 rounded stones with highlight/shadow edges
  const mortar = shade(pal.wall, -26), stone = pal.wall, top = pal.wallTop;
  ctx.fillStyle = '#' + mortar.toString(16).padStart(6, '0');
  ctx.fillRect(ax, ay, S, S);
  for (let sy = 0; sy < 2; sy++) {
    for (let sx = 0; sx < 2; sx++) {
      const x = ax + sx * 16 + 1, y = ay + sy * 16 + 1, w = 14, h = 14;
      ctx.fillStyle = '#' + stone.toString(16).padStart(6, '0');
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#' + top.toString(16).padStart(6, '0');
      ctx.fillRect(x, y, w, 3);          // top highlight
      ctx.fillRect(x, y, 3, h);          // left highlight
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.fillRect(x, y + h - 3, w, 3);  // bottom shadow
      ctx.fillRect(x + w - 3, y, 3, h);  // right shadow
    }
  }
}

// street: asphalt with chunky wear and the odd tar patch
function paintAsphalt(ctx, ax, ay, pal, r) {
  const base = pal.road ?? 0x34373c;
  ctx.fillStyle = hexOf(base);
  ctx.fillRect(ax, ay, S, S);
  for (let i = 0; i < 7; i++) {
    const gx = Math.floor(r() * 8), gy = Math.floor(r() * 8);
    ctx.fillStyle = hexOf(shade(base, r() > 0.5 ? 12 : -12));
    ctx.fillRect(ax + gx * P, ay + gy * P, P, P);
  }
  if (r() > 0.82) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(ax + Math.floor(r() * 5) * P, ay + Math.floor(r() * 5) * P, P * 2, P * 2);
  }
}

// kerbside pavement: pale slabs, dark joints, and a lit kerb on road edges
function paintPavement(ctx, ax, ay, pal, r, sides = {}) {
  const base = pal.kerb ?? 0x6e737b;
  ctx.fillStyle = hexOf(base);
  ctx.fillRect(ax, ay, S, S);
  ctx.fillStyle = hexOf(shade(base, -18));
  for (let g = 8; g < S; g += 8) { ctx.fillRect(ax, ay + g, S, 1); ctx.fillRect(ax + g, ay, 1, S); }
  ctx.fillStyle = hexOf(shade(base, 12));
  for (let i = 0; i < 3; i++) {
    const gx = Math.floor(r() * 8), gy = Math.floor(r() * 8);
    ctx.fillRect(ax + gx * P, ay + gy * P, P, P);
  }
  if (r() > 0.86) {
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(ax + Math.floor(r() * 4) * P, ay + Math.floor(r() * 4) * P, P * 2, P);
  }
  // kerb: a pale lip where the pavement meets asphalt, shadowed on the far side
  ctx.fillStyle = 'rgba(255,255,255,0.20)';
  if (sides.up) ctx.fillRect(ax, ay, S, 2);
  if (sides.left) ctx.fillRect(ax, ay, 2, S);
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  if (sides.down) ctx.fillRect(ax, ay + S - 3, S, 3);
  if (sides.right) ctx.fillRect(ax + S - 3, ay, 3, S);
}

// street furniture worn into the asphalt: manholes and standing water
function paintStreet(ctx, ax, ay, wx, wy) {
  const h = hash((wx * 7919) ^ (wy * 104729));
  if (h % 13 === 0) {                       // manhole cover
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.beginPath(); ctx.arc(ax + 16, ay + 16, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(122,128,136,0.55)';
    ctx.beginPath(); ctx.arc(ax + 16, ay + 16, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ax + 12, ay + 16); ctx.lineTo(ax + 20, ay + 16);
    ctx.moveTo(ax + 16, ay + 12); ctx.lineTo(ax + 16, ay + 20);
    ctx.stroke();
  } else if (h % 8 === 3) {                 // puddle with a pale sky glint
    ctx.fillStyle = 'rgba(126,176,206,0.15)';
    ctx.beginPath(); ctx.ellipse(ax + 16, ay + 18, 9, 4.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(214,240,255,0.12)';
    ctx.beginPath(); ctx.ellipse(ax + 13, ay + 16, 4, 1.8, 0, 0, Math.PI * 2); ctx.fill();
  }
}

// city block: concrete facade, sunlit top edge, 2×2 windows (some still lit)
function paintFacade(ctx, ax, ay, pal, r) {
  const base = pal.wall ?? 0x5e6067, top = pal.wallTop ?? 0x767a82;
  ctx.fillStyle = hexOf(base);
  ctx.fillRect(ax, ay, S, S);
  ctx.fillStyle = hexOf(top);
  ctx.fillRect(ax, ay, S, 4);                       // sunlit parapet
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(ax, ay + S - 3, S, 3);               // shadowed base
  const lit = r() > 0.72;
  for (let wy = 0; wy < 2; wy++) {
    for (let wx = 0; wx < 2; wx++) {
      const x = ax + 4 + wx * 14, y = ay + 8 + wy * 12;
      ctx.fillStyle = '#141a20';
      ctx.fillRect(x, y, 10, 8);                    // frame
      ctx.fillStyle = lit && r() > 0.4 ? '#e8b64a' : '#243040';
      ctx.fillRect(x + 1, y + 1, 8, 6);             // glass
    }
  }
}

function paintLeaves(ctx, ax, ay, pal, r) {
  // leaf canopy over the ground: dark foliage with lighter leaf clusters,
  // irregular transparent corners revealing the ground beneath
  const dark = shade(pal.shade, -30), mid = pal.shade, light = shade(pal.shade, 26);
  ctx.fillStyle = '#' + dark.toString(16).padStart(6, '0');
  for (let i = 0; i < 12; i++) {
    const gx = Math.floor(r() * 7), gy = Math.floor(r() * 7);
    ctx.fillRect(ax + gx * P, ay + gy * P, P * 2, P * 2);
  }
  ctx.fillStyle = '#' + mid.toString(16).padStart(6, '0');
  for (let i = 0; i < 8; i++) {
    const gx = Math.floor(r() * 7), gy = Math.floor(r() * 7);
    ctx.fillRect(ax + gx * P, ay + gy * P, P * 2, P);
  }
  ctx.fillStyle = '#' + light.toString(16).padStart(6, '0');
  for (let i = 0; i < 4; i++) {
    const gx = Math.floor(r() * 7), gy = Math.floor(r() * 7);
    ctx.fillRect(ax + gx * P, ay + gy * P, P, P);
  }
}

// // decorations drawn over ground (deterministic from tile index)
function paintDecor(ctx, ax, ay, pal, i, biomeName) {
  const h = hash(i);
  if (pal.tuft) {
    if (h % 13 === 0) { // tiny white flower
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect(ax + (h % 6) * P, ay + ((h >> 4) % 6) * P, P, P);
    } else if (h % 23 === 0) { // red flower
      ctx.fillStyle = '#d84b3f';
      ctx.fillRect(ax + (h % 5) * P, ay + ((h >> 6) % 5) * P, P, P);
    }
  } else if (pal.crack) {
    if (h % 19 === 0) { // pebbles / litter
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(ax + (h % 6) * P, ay + ((h >> 3) % 6) * P, P, P);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(ax + ((h >> 2) % 6) * P, ay + ((h >> 6) % 6) * P, 2, 2);
    }
  } else { // sand: occasional stones
    if (h % 17 === 0) {
      ctx.fillStyle = 'rgba(0,0,0,0.14)';
      ctx.fillRect(ax + (h % 6) * P, ay + ((h >> 5) % 6) * P, P * 2, P);
    }
  }
}

// dirt path around the spawn plaza (classic minecraft dirt block)
function paintDirt(ctx, ax, ay, pal, r) {
  const base = pal.dirt ?? shade(pal.ground1, -45);
  ctx.fillStyle = '#' + base.toString(16).padStart(6, '0');
  ctx.fillRect(ax, ay, S, S);
  for (let i = 0; i < 6; i++) {
    const gx = Math.floor(r() * 8), gy = Math.floor(r() * 8);
    ctx.fillStyle = '#' + shade(base, r() > 0.5 ? 12 : -16).toString(16).padStart(6, '0');
    ctx.fillRect(ax + gx * P, ay + gy * P, P, P);
  }
}

// ------------------------------------------------------------- public API ---

export function buildTextures(scene, palette) {
  const pal = palette;

  // blocky survivor: shirt + hair head (top-down), 1px dark outline
  // survivor: 32×36, outlined, shaded torso, legs and a lit rim so the sprite
  // still reads as a person when the camera zooms in close
  const drawCharacter = (shirt, hair, skin) => (ctx) => {
    const dark = shade2(shirt, -52), light = shade2(shirt, 26);
    // legs + boots
    ctx.fillStyle = '#141a24'; ctx.fillRect(10, 27, 5, 8); ctx.fillRect(18, 27, 5, 8);
    ctx.fillStyle = '#0d1119'; ctx.fillRect(9, 33, 6, 3); ctx.fillRect(18, 33, 6, 3);
    // torso: outline, cloth, shoulder light, hem shadow, belt buckle
    ctx.fillStyle = '#0a0d12'; ctx.fillRect(7, 15, 19, 14);
    ctx.fillStyle = shirt;     ctx.fillRect(8, 16, 17, 12);
    ctx.fillStyle = light;     ctx.fillRect(9, 16, 5, 12);
    ctx.fillStyle = dark;      ctx.fillRect(8, 25, 17, 3);
    ctx.fillStyle = '#c8ab72'; ctx.fillRect(15, 25, 3, 3);
    // arms and hands
    ctx.fillStyle = dark; ctx.fillRect(5, 17, 3, 10); ctx.fillRect(25, 18, 3, 9);
    ctx.fillStyle = skin; ctx.fillRect(5, 26, 3, 3); ctx.fillRect(25, 26, 3, 3);
    // head: hair cap with highlight, face, jaw shadow, eyes
    ctx.fillStyle = '#0a0d12'; ctx.fillRect(10, 2, 13, 15);
    ctx.fillStyle = hair;      ctx.fillRect(11, 3, 11, 7);
    ctx.fillStyle = shade2(hair, 30); ctx.fillRect(11, 3, 11, 2);
    ctx.fillStyle = skin;      ctx.fillRect(11, 10, 11, 5);
    ctx.fillStyle = shade2(skin, -34); ctx.fillRect(11, 14, 11, 2);
    ctx.fillStyle = '#1a1a1c'; ctx.fillRect(13, 11, 2, 2); ctx.fillRect(19, 11, 2, 2);
    // rim light along head and shoulders
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(11, 3, 11, 1); ctx.fillRect(9, 16, 15, 1);
  };
  canvasTex(scene, 'p_local', 32, 36, drawCharacter('#2f6fb3', '#4a2c14', '#c99a68'));
  canvasTex(scene, 'p_other', 32, 36, drawCharacter('#b38627', '#6b4a1f', '#b98a58'));

  // zombie: hunched, torn shirt, one arm reaching, sickly skin, glowing eyes
  canvasTex(scene, 'zombie', 32, 36, (ctx) => {
    ctx.fillStyle = '#141a24'; ctx.fillRect(10, 27, 5, 8); ctx.fillRect(18, 27, 5, 8);
    ctx.fillStyle = '#0d1119'; ctx.fillRect(9, 33, 6, 3); ctx.fillRect(18, 33, 6, 3);
    // torn shirt
    ctx.fillStyle = '#0a0d12'; ctx.fillRect(7, 15, 19, 14);
    ctx.fillStyle = '#3e5d1f'; ctx.fillRect(8, 16, 17, 12);
    ctx.fillStyle = '#2c4416'; ctx.fillRect(8, 24, 17, 4); ctx.fillRect(12, 16, 3, 6);
    ctx.fillStyle = '#8a3b2f'; ctx.fillRect(19, 20, 4, 3);
    // arms: one hanging, one reaching forward
    ctx.fillStyle = '#33501a'; ctx.fillRect(5, 17, 3, 9); ctx.fillRect(25, 19, 6, 3);
    ctx.fillStyle = '#7fa64a'; ctx.fillRect(5, 25, 3, 4); ctx.fillRect(29, 18, 3, 3);
    // head
    ctx.fillStyle = '#0a0d12'; ctx.fillRect(10, 2, 13, 15);
    ctx.fillStyle = '#6f9e3c'; ctx.fillRect(11, 3, 11, 12);
    ctx.fillStyle = '#51762c'; ctx.fillRect(11, 3, 11, 4);
    ctx.fillStyle = '#8fb84f'; ctx.fillRect(12, 16, 3, 2);
    ctx.fillStyle = '#c8f57a'; ctx.fillRect(13, 8, 2, 2); ctx.fillRect(19, 8, 2, 2);
    ctx.fillStyle = '#1c2a10'; ctx.fillRect(15, 12, 4, 1);
  });

  // chest-style supply crate
  canvasTex(scene, 'supply', 26, 24, (ctx) => {
    ctx.fillStyle = '#00000066'; ctx.fillRect(2, 20, 22, 4);
    ctx.fillStyle = '#7a5426'; ctx.fillRect(2, 2, 22, 20);
    ctx.fillStyle = '#8f6631'; ctx.fillRect(3, 3, 20, 8);
    ctx.fillStyle = '#6b461f'; ctx.fillRect(3, 12, 20, 9);
    ctx.fillStyle = '#3f2c12'; ctx.fillRect(3, 11, 20, 2); // lid seam
    ctx.fillStyle = '#5f5f66'; ctx.fillRect(11, 9, 4, 5);  // latch
    ctx.fillStyle = '#2b2b30'; ctx.fillRect(13, 11, 2, 3);
  });

  // campfire prop: stone ring, firewood, glowing embers (frost safe zone)
  canvasTex(scene, 'campfire', 30, 26, (ctx) => {
    ctx.fillStyle = '#00000066'; ctx.fillRect(3, 20, 24, 5);
    ctx.fillStyle = '#5a4630'; ctx.fillRect(4, 12, 22, 8);
    ctx.fillStyle = '#6d5638'; ctx.fillRect(5, 12, 20, 4);
    ctx.fillStyle = '#4a3418'; ctx.fillRect(8, 6, 14, 10);
    ctx.fillStyle = '#2f2210'; ctx.fillRect(10, 8, 10, 6);
    ctx.fillStyle = '#ff8c3a'; ctx.fillRect(12, 6, 6, 8);
    ctx.fillStyle = '#ffd166'; ctx.fillRect(13, 8, 4, 4);
  });

  // spawn banner flag
  canvasTex(scene, 'spawnflag', 24, 28, (ctx) => {
    ctx.fillStyle = '#333333'; ctx.fillRect(11, 2, 2, 24);
    ctx.fillStyle = '#c0392b'; ctx.fillRect(13, 3, 10, 3); ctx.fillRect(13, 6, 8, 3);
    ctx.fillStyle = '#8f1f14'; ctx.fillRect(13, 9, 6, 2);
  });

  // soft ellipse shadow under actors
  canvasTex(scene, 'shadow', 24, 12, (ctx) => {
    const g = ctx.createRadialGradient(12, 6, 1, 12, 6, 11);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.save(); ctx.translate(12, 6); ctx.scale(1, 0.55); ctx.translate(-12, -6);
    ctx.beginPath(); ctx.arc(12, 6, 11, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  });

  // minecraft hearts (full / half / empty)
  const heart = (fillColor, outline) => (ctx) => {
    ctx.fillStyle = outline; // heart silhouette 12x11
    ctx.fillRect(1, 0, 4, 2); ctx.fillRect(7, 0, 4, 2);
    ctx.fillRect(0, 1, 12, 5); ctx.fillRect(2, 6, 8, 2);
    ctx.fillRect(4, 8, 4, 2); ctx.fillRect(5, 10, 2, 1);
    if (fillColor) {
      ctx.fillStyle = fillColor;
      ctx.fillRect(1, 1, 10, 4); ctx.fillRect(2, 5, 8, 2); ctx.fillRect(4, 7, 4, 2); ctx.fillRect(5, 9, 2, 2);
      ctx.fillStyle = '#ffffff88'; ctx.fillRect(2, 1, 2, 2); // shine
    }
  };
  canvasTex(scene, 'heart_full', 12, 11, heart('#c0392b', '#2b0f0c'));
  canvasTex(scene, 'heart_half', 12, 11, (ctx) => {
    heart('#3a2622', '#2b0f0c')(ctx);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, 6, 11); ctx.clip();
    heart('#c0392b', '#2b0f0c')(ctx); ctx.restore();
    ctx.fillStyle = '#ffffff88'; ctx.fillRect(2, 1, 2, 2);
  });
  canvasTex(scene, 'heart_empty', 12, 11, heart(null, '#2b0f0c'));

  // warm pool of light the survivor carries (additive, follows the player)
  canvasTex(scene, 'light', 256, 256, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 6, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,238,196,0.40)');
    g.addColorStop(0.42, 'rgba(255,214,145,0.14)');
    g.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  });

  // the world art stays blocky pixel art at any zoom: nearest-neighbour scaling
  // on the chunky textures only, so HUD text keeps its antialiasing
  for (const key of ['p_local', 'p_other', 'zombie', 'supply', 'campfire', 'spawnflag']) {
    const tex = scene.textures.get(key);
    if (tex && tex.setFilter) tex.setFilter(Phaser.Textures.FilterMode.NEAREST);
  }
}

// Paint one endless-world chunk (32×32 tiles) into a canvas texture.
// Same shared/rules painter as the old static map, applied per chunk as the
// camera streams new chunks into view.
export function buildChunkTexture(scene, mapId, cx, cy) {
  const key = `chunk_${mapId}_${cx}_${cy}`;
  if (scene.textures.exists(key)) return key;

  const biome = BIOMES[mapId];
  const chunk = genChunkData(mapId, cx, cy);
  const canvas = document.createElement('canvas');
  canvas.width = CHUNK_PX; canvas.height = CHUNK_PX;
  const ctx = canvas.getContext('2d');
  const pal = biome.palette;
  const T = TILE_SIZE;
  const at = (lx, ly) => (lx < 0 || ly < 0 || lx >= CHUNK_TILES || ly >= CHUNK_TILES)
    ? TILE.GROUND : chunk.tiles[ly * CHUNK_TILES + lx];

  for (let ly = 0; ly < CHUNK_TILES; ly++) {
    for (let lx = 0; lx < CHUNK_TILES; lx++) {
      const i = ly * CHUNK_TILES + lx;
      const wx = cx * CHUNK_TILES + lx, wy = cy * CHUNK_TILES + ly;
      const ax = wx * T, ay = wy * T;
      const r = mulberry32(((wx * 73856093) ^ (wy * 19349663)) >>> 0);
      const nearCenter = Math.hypot(wx + .5 - 23.5, wy + .5 - 23.5) < 3.2;

      const tile = chunk.tiles[i];
      const mx = ((wx % CITY_PITCH) + CITY_PITCH) % CITY_PITCH;
      const my = ((wy % CITY_PITCH) + CITY_PITCH) % CITY_PITCH;

      if (tile === TILE.WALL) {           // building
        if (biome.city) paintFacade(ctx, ax, ay, pal, r);
        else paintWall(ctx, ax, ay, pal);
      } else if (tile === TILE.ROAD) {    // street: crossings, lane marks, wear
        paintAsphalt(ctx, ax, ay, pal, r);
        const hRoad = my < CITY_ROAD_W, vRoad = mx < CITY_ROAD_W;
        if (!nearCenter) {
          if (hRoad && vRoad) {           // junction: painted crossing bars
            ctx.fillStyle = 'rgba(236,240,244,0.22)';
            for (let s = 0; s < 4; s++) {
              ctx.fillRect(ax + 2 + s * 8, ay + 2, 5, 10);
              ctx.fillRect(ax + 2 + s * 8, ay + 20, 5, 10);
            }
          } else {                        // dashed centre line
            ctx.fillStyle = hexOf(pal.lane ?? 0xd8b64a);
            if (hRoad && (((wx % 4) + 4) % 4) < 2) ctx.fillRect(ax, ay + 15, S, 2);
            if (vRoad && (((wy % 4) + 4) % 4) < 2) ctx.fillRect(ax + 15, ay, 2, S);
          }
          paintStreet(ctx, ax, ay, wx, wy);
        }
      } else if (tile === TILE.SIDEWALK) { // pavement ring with kerb edges
        paintPavement(ctx, ax, ay, pal, r, {
          up: at(lx, ly - 1) === TILE.ROAD,
          down: at(lx, ly + 1) === TILE.ROAD,
          left: at(lx - 1, ly) === TILE.ROAD,
          right: at(lx + 1, ly) === TILE.ROAD,
        });
      } else if (nearCenter) {            // spawn plaza dirt path
        paintDirt(ctx, ax, ay, pal, r);
      } else {                            // ground + decor + canopies
        const groundLight = ((wx * 7 + wy * 13) % 2) === 0;
        paintGround(ctx, ax, ay, pal, groundLight, r);
        paintDecor(ctx, ax, ay, pal, i, biome.name);
        if (tile === TILE.SHADE) {        // leaf canopy over the ground
          paintLeaves(ctx, ax, ay, pal, r);
        }
      }

      // buildings throw a short shadow onto the tile below and to their right;
      // this is what makes the facades stand up out of the street
      if (tile !== TILE.WALL) {
        if (at(lx, ly - 1) === TILE.WALL) {
          ctx.fillStyle = 'rgba(0,0,0,0.30)'; ctx.fillRect(ax, ay, S, 5);
          ctx.fillStyle = 'rgba(0,0,0,0.13)'; ctx.fillRect(ax, ay + 5, S, 6);
        }
        if (at(lx - 1, ly) === TILE.WALL) {
          ctx.fillStyle = 'rgba(0,0,0,0.20)'; ctx.fillRect(ax, ay, 4, S);
        }
      }
    }
  }
  scene.textures.addCanvas(key, canvas);
  const tex = scene.textures.get(key);
  if (tex && tex.setFilter) tex.setFilter(Phaser.Textures.FilterMode.NEAREST);
  return key;
}

// Soft vignette over the viewport for mood
export function addVignette(scene, layer) {
  canvasTex(scene, 'vignette', 256, 256, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, w * 0.32, w / 2, h / 2, w * 0.52);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  });
  const w = scene.scale.width, h = scene.scale.height;
  const vign = scene.add.image(w / 2, h / 2, 'vignette')
    .setScrollFactor(0).setDepth(98).setActive(true);
  vign.setDisplaySize(w + 4, h + 4);
  if (layer) layer.add(vign);
  return vign;
}

function shade2(hex, delta) {
  const r = Math.max(0, Math.min(255, ((hex >>> 16) & 255) + delta));
  const g = Math.max(0, Math.min(255, ((hex >>> 8) & 255) + delta));
  const b = Math.max(0, Math.min(255, (hex & 255) + delta));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}
