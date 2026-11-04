// client/tiles.js — procedural texture generation. No art assets needed for the
// engine slice: the static map is painted once into a canvas texture, and every
// actor/prop sprite is generated at boot from the biome palette.
import Phaser from 'phaser';

function hex(n) { return '#' + n.toString(16).padStart(6, '0'); }

export function buildTextures(scene, palette) {
  makeCircle(scene, 'p_local', 0x5ecfff, 0x0b62a8);
  makeCircle(scene, 'p_other', 0xe8d38a, 0x8a6d1c);
  makeBlob(scene, 'zombie', 0x9ee05a, 0x436d22);
  makeCrate(scene, 'supply', 0x8a7a3c, 0x5f531f);
  makeFlag(scene, 'spawnflag', 0xc0392b);
}

// The full static map painted once into a single canvas texture (fast, no per-frame tile draws).
export function paintStaticMap(scene, map) {
  const key = 'map_' + map.id;
  if (scene.textures.exists(key)) scene.textures.remove(key);

  const T = map.tileSize;
  const canvas = document.createElement('canvas');
  canvas.width = map.px; canvas.height = map.py;
  const ctx = canvas.getContext('2d');
  const pal = map.biome.palette;

  const colorFor = (i, tx, ty) => {
    const tile = map.tiles[i];
    if (tile === 2) return hex(pal.wall);
    if (tile === 3) return hex(pal.shade);
    return ((tx * 7 + ty * 13) % 2 === 0) ? hex(pal.ground1) : hex(pal.ground2);
  };

  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      const i = ty * map.width + tx;
      ctx.fillStyle = colorFor(i, tx, ty);
      ctx.fillRect(tx * T, ty * T, T, T);
      if (map.tiles[i] === 2) { // subtle wall top edge
        ctx.fillStyle = hex(pal.wallTop);
        ctx.fillRect(tx * T, ty * T, T, 6);
      }
      // light speckle for organic texture
      if ((i * 2654435761 >>> 22) % 7 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(tx * T + (i * 13) % (T - 2), ty * T + (i * 7) % (T - 2), 2, 2);
      }
    }
  }
  scene.textures.addCanvas(key, canvas);
  scene.add.image(0, 0, key).setOrigin(0).setDepth(-10);
  return key;
}

function makeCircle(scene, key, fill, stroke) {
  if (scene.textures.exists(key)) return;
  const r = 11, s = r * 2 + 6;
  const g = scene.add.graphics();
  g.fillStyle(stroke, 1).fillCircle(s / 2, s / 2, r + 2);
  g.fillStyle(fill, 1).fillCircle(s / 2, s / 2, r);
  g.fillStyle(0xffffff, 0.22).fillCircle(s / 2 - 3, s / 2 - 3, r * 0.4);
  g.generateTexture(key, s, s);
  g.destroy();
}

function makeBlob(scene, key, fill, stroke) {
  if (scene.textures.exists(key)) return;
  const r = 12, s = r * 2 + 8;
  const g = scene.add.graphics();
  g.fillStyle(stroke, 1).fillEllipse(s / 2, s / 2 + 3, r * 2.2, r * 1.7);
  g.fillStyle(fill, 1).fillCircle(s / 2, s / 2 - 2, r * 0.8);
  g.fillStyle(0x33111a, 1).fillCircle(s / 2 - 4, s / 2 - 4, 2).fillCircle(s / 2 + 4, s / 2 - 4, 2);
  g.generateTexture(key, s, s);
  g.destroy();
}

function makeCrate(scene, key, base, dark) {
  if (scene.textures.exists(key)) return;
  const g = scene.add.graphics();
  g.fillStyle(dark, 1).fillRect(3, 3, 26, 26);
  g.fillStyle(base, 1).fillRect(5, 5, 22, 22);
  g.fillStyle(dark, 1).fillRect(5, 14, 22, 4);
  g.generateTexture(key, 32, 32);
  g.destroy();
}

function makeFlag(scene, key, color) {
  if (scene.textures.exists(key)) return;
  const g = scene.add.graphics();
  g.fillStyle(0x333333, 1).fillRect(14, 6, 3, 24);
  g.fillStyle(color, 1).fillTriangle(17, 6, 17, 16, 29, 11);
  g.generateTexture(key, 32, 32);
  g.destroy();
}
