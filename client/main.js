// client/main.js — Phaser 4 game: biome select scene + authoritative game scene.
// Loading is instant because every sprite and tile texture is generated
// procedurally (client/tiles.js) and the world is generated deterministically
// from the same shared/maps.js the server simulates.
import Phaser from 'phaser';
import { generateMap, BIOMES } from '../shared/maps.js';
import { buildTextures, paintStaticMap } from './tiles.js';
import { GameConnection } from './net.js';

let conn = null; // module-scoped so scene restarts can leave cleanly

// ------------------------------------------------------------ biome select ---

export class BiomeSelectScene extends Phaser.Scene {
  constructor() { super('biome_select'); }

  create() {
    if (conn) { conn.leave(); conn = null; }
    hideChat();
    // shareable deep link: /?map=zombie_city skips the menu
    const preset = new URLSearchParams(location.search).get('map');
    if (preset && BIOMES[preset]) {
      showChat();
      this.scene.start('game', { mapId: preset });
      return;
    }
    const W = this.scale.width;
    this.cameras.main.setBackgroundColor('#17181c');

    this.add.text(W / 2, 70, '☠ DOOMDAYS ☠', {
      fontFamily: 'monospace', fontSize: '40px', color: '#c0392b',
    }).setOrigin(0.5);
    this.add.text(W / 2, 112, 'survive the endtimes. together. or not.', {
      fontFamily: 'monospace', fontSize: '14px', color: '#777',
    }).setOrigin(0.5);

    let y = 170;
    for (const biome of Object.values(BIOMES)) {
      const h = 92;
      const box = this.add.rectangle(W / 2, y + h / 2, W - 120, h, 0x26292f)
        .setStrokeStyle(2, 0x44484f).setInteractive({ useHandCursor: true });
      this.add.text(52, y + 16, biome.name, {
        fontFamily: 'monospace', fontSize: '22px', color: '#e8e4d8',
      });
      this.add.text(52, y + 44, biome.desc, {
        fontFamily: 'monospace', fontSize: '12px', color: '#8a8f96', wordWrap: { width: W - 140 },
      });
      this.add.text(W - 78, y + 26, 'ENTER', {
        fontFamily: 'monospace', fontSize: '14px', color: '#5ecfff',
      }).setOrigin(1, 0);
      box.on('pointerover', () => box.setFillStyle(0x33373d));
      box.on('pointerout', () => box.setFillStyle(0x26292f));
      box.on('pointerdown', () => { showChat(); this.scene.start('game', { mapId: biome.id }); });
      y += h + 14;
    }
    this.add.text(W / 2, y + 8, 'WASD / arrows to move · Enter to chat · supplies heal · hazards kill', {
      fontFamily: 'monospace', fontSize: '11px', color: '#555',
    }).setOrigin(0.5);
  }
}

// ---------------------------------------------------------------- game scene ---

function makeNameTag(scene, name) {
  return scene.add.text(0, 0, name, {
    fontFamily: 'monospace', fontSize: '11px', color: '#fff',
    stroke: '#000', strokeThickness: 3,
  }).setOrigin(0.5, 1.7).setDepth(60);
}

export class GameScene extends Phaser.Scene {
  constructor() { super('game'); }

  init(data) { this.mapId = data.mapId || 'zombie_city'; }

  create() {
    window.__gameScene = this;
    this.map = generateMap(this.mapId);
    this.biome = this.map.biome;
    buildTextures(this, this.biome.palette);
    paintStaticMap(this, this.map);

    this.players = new Map();   // sessionId -> { sprite, tag, data }
    this.zombies = new Map();   // zombieId -> { sprite, data }
    this.chatActive = false;

    // static world visuals
    for (const s of this.map.spawns) {
      this.add.image((s.tx + 0.5) * this.map.tileSize, (s.ty + 0.5) * this.map.tileSize, 'spawnflag');
    }
    for (const s of this.map.supplies) {
      this.add.image((s.tx + 0.5) * this.map.tileSize, (s.ty + 0.5) * this.map.tileSize, 'supply').setDepth(5);
    }
    this.waterOverlay = this.add.graphics().setDepth(55);
    this.fireOverlay = this.add.graphics().setDepth(56).setAlpha(0.55);
    this.heatTint = this.add.rectangle(this.map.px / 2, this.map.py / 2, this.map.px + 2, this.map.py + 2, 0xff5500)
      .setDepth(58).setAlpha(0);

    this.cameras.main.setBounds(0, 0, this.map.px, this.map.py);
    this.cameras.main.setBackgroundColor('#101014');

    // connection to the authoritative server
    this.conn = conn || new GameConnection();
    conn = this.conn;
    this.status = this.add.text(this.scale.width / 2, this.scale.height / 2, 'connecting…', {
      fontFamily: 'monospace', fontSize: '18px', color: '#ccc',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(101);

    this.conn.join(this.mapId, localStorage.getItem('doomdays.name') || 'survivor')
      .then(() => this.wireRoom())
      .catch((err) => {
        console.error('Join failed', err);
        document.getElementById('conn-error').style.display = 'flex';
      });

    // input
    this.keys = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W, down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A, right: Phaser.Input.Keyboard.KeyCodes.D,
      u: Phaser.Input.Keyboard.KeyCodes.UP, d: Phaser.Input.Keyboard.KeyCodes.DOWN,
      l: Phaser.Input.Keyboard.KeyCodes.LEFT, r: Phaser.Input.Keyboard.KeyCodes.RIGHT,
    });
    this.input.keyboard.on('keydown-ENTER', () => openChat());

    // HUD
    this.hud = {
      bar: this.add.graphics().setScrollFactor(0).setDepth(100),
      biome: this.add.text(16, 68, '', {
        fontFamily: 'monospace', fontSize: '13px', color: '#8fd3a0',
        stroke: '#000', strokeThickness: 3,
      }).setScrollFactor(0).setDepth(101),
      statusRight: this.add.text(this.scale.width - 16, 16, '', {
        fontFamily: 'monospace', fontSize: '13px', color: '#777',
        stroke: '#000', strokeThickness: 3,
      }).setOrigin(1, 0).setScrollFactor(0).setDepth(101),
    };

    this.overlayTimer = 0;
  }

  wireRoom() {
    const c = this.conn;
    this.localSid = c.room.sessionId;
    this.status.setText('');
    window.__gameSend = (type, data) => c.send(type, data);

    c.onMessage('chat', (msg) => pushChat(msg));
    c.onMessage('system', (msg) => {
      if (msg.event === 'wave') {
        pushChat({ from: '☠ horizon', text: `Wave ${msg.wave}: the horde grows` });
        this.cameras.main.shake(300, 0.004);
      } else if (msg.event === 'died') {
        pushChat({ from: '☠ doom', text: `${msg.name} fell… the wasteland returned them` });
      }
    });

    c.onAdd('players', (player, sid) => {
      const isLocal = sid === this.localSid;
      const sprite = this.add.image(player.x, player.y, isLocal ? 'p_local' : 'p_other').setDepth(70);
      if (!isLocal) sprite.setAlpha(0.92);
      const tag = makeNameTag(this, player.name);
      this.players.set(sid, { sprite, tag, data: player });
      if (isLocal) {
        this.cameras.main.startFollow(sprite, true, 0.08, 0.08);
        pushChat({ from: '☠ doom', text: `You are ${player.name}. survive.` });
      }
    });

    c.onRemove('players', (_p, sid) => {
      const w = this.players.get(sid);
      if (w) { w.sprite.destroy(); w.tag.destroy(); this.players.delete(sid); }
    });

    c.onAdd('zombies', (zombie, zid) => {
      const sprite = this.add.image(zombie.x, zombie.y, 'zombie').setDepth(69).setAlpha(0.92);
      this.zombies.set(zid, { sprite, data: zombie });
    });

    c.onRemove('zombies', (_z, zid) => {
      const w = this.zombies.get(zid);
      if (w) { w.sprite.destroy(); this.zombies.delete(zid); }
    });
  }

  // ------------------------------------------------------------- update ---
  update(time, deltaMs) {
    const dt = deltaMs / 1000;

    // input intents (skip while typing in chat) — always report release as 0,0
    if (!this.chatActive) {
      const k = this.keys;
      const dx = (k.right.isDown || k.r.isDown ? 1 : 0) - (k.left.isDown || k.l.isDown ? 1 : 0);
      const dy = (k.down.isDown || k.d.isDown ? 1 : 0) - (k.up.isDown || k.u.isDown ? 1 : 0);
      this.conn.sendInput(dx, dy, time);
    } else {
      this.conn.sendInput(0, 0, time);
    }

    lerpGroup(this.players, dt, 12);
    lerpGroup(this.zombies, dt, 10);

    this.overlayTimer += deltaMs;
    if (this.overlayTimer >= 200) {
      this.overlayTimer = 0;
      this.redrawOverlays();
      this.redrawHUD();
    }
  }

  state() { return this.conn.room ? this.conn.room.state : null; }

  setChatState(active) { this.chatActive = !!active; }

  redrawOverlays() {
    const world = this.state()?.world;
    if (!world) return;

    if (this.biome.flooded) {
      // rising water: tint every ground tile below the current level
      const g = this.waterOverlay;
      g.clear();
      g.fillStyle(this.biome.palette.waterTint, 0.78);
      const T = this.map.tileSize, cutoff = world.waterLevel * 255;
      for (let ty = 0; ty < this.map.height; ty++) {
        for (let tx = 0; tx < this.map.width; tx++) {
          const i = ty * this.map.width + tx;
          if (this.map.tiles[i] === 2) continue; // buildings still peek out
          if (this.map.heights[i] < cutoff) g.fillRect(tx * T, ty * T, T, T);
        }
      }
    }

    if (this.biome.heat) {
      // wildfires expand from each seed; radius is deterministic from world clock
      const r = Math.min(12, 0.13 * world.clock) * this.map.tileSize;
      const g = this.fireOverlay;
      g.clear();
      if (r > 0) {
        for (const f of this.map.fires) {
          g.fillStyle(this.biome.palette.fire, 0.5);
          g.fillCircle((f.tx + 0.5) * this.map.tileSize, (f.ty + 0.5) * this.map.tileSize, r);
        }
      }
      this.heatTint.setAlpha(Math.max(0, Math.min(0.26, (world.temp - 33) * 0.014)));
    }
  }

  redrawHUD() {
    const world = this.state()?.world;
    if (!world) return;
    const me = this.players.get(this.localSid)?.data;
    const hp = me ? me.hp : 100;

    const bar = this.hud.bar;
    bar.clear();
    bar.fillStyle(0x000000, 0.55).fillRect(10, 10, 224, 72);
    bar.fillStyle(0x2e4057, 1).fillRect(14, 14, 212, 10);
    bar.fillStyle(0xc0392b, 1).fillRect(14, 14, 212 * hp / 100, 10);

    let fraction = 0, color = 0x9ee05a, label = '';
    if (this.biome.flooded) {
      fraction = world.waterLevel; color = 0x2f89b5;
      label = `🌊 water ${(world.waterLevel * 100).toFixed(0)}% — high ground is life`;
    } else if (this.biome.heat) {
      fraction = Math.max(0, Math.min(1, (world.temp - 26) / 29));
      color = fraction > 0.6 ? 0xff5522 : 0xe8a83c;
      label = `🔥 ${world.temp.toFixed(0)}°C — find shade as it climbs`;
    } else {
      fraction = Math.min(1, world.wave / 20);
      label = `🧟 horde wave ${world.wave} — they keep coming`;
    }
    bar.fillStyle(color, 1).fillRect(14, 28, 212 * fraction, 9);
    this.hud.biome.setText(label);

    this.hud.statusRight.setText(
      `${this.biome.name} · ${this.players.size} survivors · ${world.clock}s survived`);
  }
}

function lerpGroup(map, dt, factor) {
  const t = 1 - Math.exp(-dt * factor);
  for (const w of map.values()) {
    if (!w.data) continue;
    w.sprite.x += (w.data.x - w.sprite.x) * t;
    w.sprite.y += (w.data.y - w.sprite.y) * t;
    if (w.tag) w.tag.setPosition(w.sprite.x, w.sprite.y - 12);
  }
}

// --------------------------------------------------------------- chat DOM ---

function pushChat(msg) {
  const log = document.getElementById('chat-log');
  if (!log) return;
  const line = document.createElement('div');
  line.innerHTML = `<b>${escapeHtml(String(msg.from || '?'))}:</b> ${escapeHtml(String(msg.text || ''))}`;
  log.appendChild(line);
  while (log.childElementCount > 8) log.removeChild(log.firstChild);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function openChat() {
  const box = document.getElementById('chat-box');
  const input = document.getElementById('chat-input');
  const scene = window.__gameScene;
  if (!box || !input) return;
  box.style.display = 'flex';
  input.value = '';
  input.focus();
  scene?.setChatState?.(true);
}

function hideChat() {
  const box = document.getElementById('chat-box');
  if (box) box.style.display = 'none';
}

function showChat() {
  const box = document.getElementById('chat-box');
  if (box) box.style.display = 'flex';
}

const chatInput = document.getElementById('chat-input');
chatInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const text = chatInput.value.trim();
    if (text) window.__gameSend?.('chat', { text });
    chatInput.value = '';
    chatInput.blur();
    window.__gameScene?.setChatState?.(false);
  } else if (e.key === 'Escape') {
    chatInput.blur();
    document.getElementById('chat-box').style.display = 'none';
    window.__gameScene?.setChatState?.(false);
  }
  e.stopPropagation();
});

// ------------------------------------------------------------------ boot ---

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('chat-box').style.display = 'none';
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: 960, height: 600,
    backgroundColor: '#101014',
    roundPixels: true,
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: [BiomeSelectScene, GameScene],
  });
});
