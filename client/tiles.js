// client/tiles.js — Minecraft-flavored procedural pixel art. Everything is
// chunky blocky pixels (8x8 blocks per 32px tile): grass/asphalt/sand ground,
// cobblestone buildings, leaf canopies, chest crates, blocky survivors.
// The full static map is painted once into a canvas texture; actor/prop
// sprites are generated at boot from the biome palette.
import Phaser from 'phaser';

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
  const drawCharacter = (shirt, hair, skin) => (ctx, w, h) => {
    // shadowed body
    ctx.fillStyle = '#00000088';
    ctx.fillRect(4, 18, 16, 10);
    ctx.fillStyle = shirt; ctx.fillRect(5, 17, 14, 9);
    ctx.fillStyle = shade2(shirt, -40); ctx.fillRect(5, 24, 14, 2);
    // head with hair
    ctx.fillStyle = hair; ctx.fillRect(6, 4, 12, 10);
    ctx.fillStyle = skin; ctx.fillRect(6, 12, 12, 3);
    ctx.fillStyle = '#000000aa';
    ctx.fillRect(6, 4, 12, 1); ctx.fillRect(6, 14, 12, 1);
    ctx.fillRect(6, 4, 1, 11); ctx.fillRect(17, 4, 1, 11);
  };
  canvasTex(scene, 'p_local', 24, 28, drawCharacter('#2f6fb3', '#4a2c14', '#c99a68'));
  canvasTex(scene, 'p_other', 24, 28, drawCharacter('#b38627', '#6b4a1f', '#b98a58'));

  // zombie: sickly green head, torn dark shirt, shambling asymmetric shoulders
  canvasTex(scene, 'zombie', 24, 28, (ctx) => {
    ctx.fillStyle = '#00000088';
    ctx.fillRect(4, 18, 15, 10);
    ctx.fillStyle = '#3e5d1f'; ctx.fillRect(5, 17, 14, 9);
    ctx.fillStyle = '#2c4416'; ctx.fillRect(9, 19, 3, 2); ctx.fillRect(14, 22, 2, 2);
    ctx.fillStyle = '#6f9e3c'; ctx.fillRect(6, 4, 12, 10);
    ctx.fillStyle = '#51762c'; ctx.fillRect(6, 4, 12, 3);
    ctx.fillStyle = '#c8f57a'; ctx.fillRect(8, 8, 2, 2); ctx.fillRect(13, 8, 2, 2); // glowing eyes
    ctx.fillStyle = '#000000aa'; ctx.fillRect(6, 4, 12, 1); ctx.fillRect(6, 13, 12, 1);
    ctx.fillRect(6, 4, 1, 10); ctx.fillRect(17, 4, 1, 10);
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
}

// Paint the full static map once (ground, cobble walls, canopies, decor, paths)
export function paintStaticMap(scene, map) {
  const key = 'map_' + map.id;
  if (scene.textures.exists(key)) scene.textures.remove(key);

  const canvas = document.createElement('canvas');
  canvas.width = map.px; canvas.height = map.py;
  const ctx = canvas.getContext('2d');
  const pal = map.biome.palette;
  const T = map.tileSize;
  const rng = mulberry32(hash('doomdays-art:' + map.id));

  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      const i = ty * map.width + tx;
      const ax = tx * T, ay = ty * T;
      const r = mulberry32(hash(i + 7));
      const nearCenter = Math.hypot(tx - 23.49, ty - 23.49) < 3.2;

      if (map.tiles[i] === 2) {           // building
        paintWall(ctx, ax, ay, pal);
      } else if (nearCenter) {            // spawn plaza dirt path
        paintDirt(ctx, ax, ay, pal, r);
      } else {
        const groundLight = (tx * 7 + ty * 13) % 2 === 0;
        paintGround(ctx, ax, ay, pal, groundLight, r);
        paintDecor(ctx, ax, ay, pal, i, map.biome.name);
        if (map.tiles[i] === 3) {         // leaf canopy over the ground
          paintLeaves(ctx, ax, ay, pal, r);
        }
      }
    }
  }
  scene.textures.addCanvas(key, canvas);
  scene.add.image(0, 0, key).setOrigin(0).setDepth(-10);
  return key;
}

// Soft vignette over the viewport for mood
export function addVignette(scene) {
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
}

function shade2(hex, delta) {
  const r = Math.max(0, Math.min(255, ((hex >>> 16) & 255) + delta));
  const g = Math.max(0, Math.min(255, ((hex >>> 8) & 255) + delta));
  const b = Math.max(0, Math.min(255, (hex & 255) + delta));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}
