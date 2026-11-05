// client/main.js — Phaser 4 game: biome select scene + authoritative game scene.
// The world is ENDLESS: chunks (32×32 tiles) are painted and streamed around
// the camera as the player explores. Loading is instant because every sprite,
// prop and chunk texture is generated procedurally (client/tiles.js) and the
// world is generated deterministically from the same shared/maps.js the server
// simulates. A zoomed main camera renders the world; a second unzoomed camera
// renders the HUD so the UI stays pixel-stable at any zoom level.
import Phaser from 'phaser';
import {
  BIOMES, TILE_SIZE, CHUNK_TILES, CHUNK_PX, genChunkData, heightAt,
} from '../shared/maps.js';
import { buildTextures, buildChunkTexture, addVignette } from './tiles.js';
import { GameConnection } from './net.js';

let conn = null; // module-scoped so scene restarts can leave cleanly

const ZOOM = 1.55;            // how tightly the camera hugs the player
const CHUNK_KEEP = 16;        // max chunk textures/props held at once

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

    this.add.text(W / 2, 56, '☠ DOOMDAYS ☠', {
      fontFamily: 'monospace', fontSize: '38px', color: '#c0392b',
    }).setOrigin(0.5);
    this.add.text(W / 2, 94, 'a limitless world. survive the endtimes. together. or not.', {
      fontFamily: 'monospace', fontSize: '13px', color: '#777',
    }).setOrigin(0.5);

    // two-column grid of biome cards
    const list = Object.values(BIOMES);
    const cardW = (W - 90) / 2, cardH = 118, gap = 14;
    const x0 = 30, y0 = 124;
    list.forEach((biome, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = x0 + col * (cardW + gap), y = y0 + row * (cardH + 12);
      const box = this.add.rectangle(x + cardW / 2, y + cardH / 2, cardW, cardH, 0x26292f)
        .setStrokeStyle(2, 0x44484f).setInteractive({ useHandCursor: true });
      this.add.text(x + 14, y + 10, biome.name, {
        fontFamily: 'monospace', fontSize: '16px', color: '#e8e4d8',
      });
      this.add.text(x + 14, y + 32, biome.desc, {
        fontFamily: 'monospace', fontSize: '10px', color: '#8a8f96',
        wordWrap: { width: cardW - 40 },
      });
      this.add.text(x + cardW - 14, y + cardH - 12, 'ENTER', {
        fontFamily: 'monospace', fontSize: '12px', color: '#5ecfff',
      }).setOrigin(1, 1);
      box.on('pointerover', () => box.setFillStyle(0x33373d));
      box.on('pointerout', () => box.setFillStyle(0x26292f));
      box.on('pointerdown', () => { showChat(); this.scene.start('game', { mapId: biome.id }); });
    });

    this.add.text(W / 2, 590, 'WASD move · SPACE/left-click swing · walk onto crates to loot · [F] eat · [G] heal', {
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
    document.getElementById('conn-error').style.display = 'none';
    this.biome = BIOMES[this.mapId];
    buildTextures(this, this.biome.palette);

    // containers: one per camera — the zoomed world camera ignores ui objects,
    // the hud camera ignores world objects
    this.worldLayer = this.add.container(0, 0);
    this.hudLayer = this.add.container(0, 0).setScrollFactor(0);
    this.cameras.main.setZoom(ZOOM);
    this.cameras.main.setBackgroundColor('#101014');
    this.cameras.main.ignore(this.hudLayer);
    this.uiCam = this.cameras.add();
    this.uiCam.ignore(this.worldLayer);

    this.players = new Map();   // sessionId -> { sprite, shadow, tag, data }
    this.zombies = new Map();   // zombieId -> { sprite, shadow, data }
    this.drops = new Map();     // dropId -> { sprite, shadow, data }
    this.chunks = new Map();    // chunkKey -> { img, crates, props, used }
    this.lootedSet = new Set(); // loot spot keys already scavenged (server truth)
    this.crateByKey = new Map(); // lootKey -> crate sprite
    this.explored = new Set();  // chunk keys visited near the camera (radar trail)
    this.chunkCount = 0;
    this.meteors = [];          // {x, y, at} incoming meteor warnings
    this.swings = [];           // {x, y, angle, t} visible melee arcs
    this.faceAngle = 0;         // last move direction, fallback aim for swings
    this.chatActive = false;
    this.rejoining = false;

    this.hearts = [];
    for (let i = 0; i < 10; i++) {
      const h = this.add.image(26 + i * 15, 26, 'heart_empty')
        .setScrollFactor(0).setDepth(101).setOrigin(0, 0);
      this.hudLayer.add(h);
      this.hearts.push(h);
    }

    // layered overlays (world space)
    this.waterOverlay = this.add.graphics().setDepth(55);
    this.domeOverlay = this.add.graphics().setDepth(56).setAlpha(0.9);
    this.fireOverlay = this.add.graphics().setDepth(57).setAlpha(0.55);
    this.meteorOverlay = this.add.graphics().setDepth(58);
    this.worldLayer.add(this.waterOverlay, this.domeOverlay, this.fireOverlay, this.meteorOverlay);

    addVignette(this, this.hudLayer);

    // connection to the authoritative server (auto-retry: restarts, refreshes,
    // dead rooms — do not strand the player on the error screen)
    this.conn = conn || new GameConnection();
    conn = this.conn;
    this.status = this.add.text(this.scale.width / 2, this.scale.height / 2, 'connecting…', {
      fontFamily: 'monospace', fontSize: '18px', color: '#ccc',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(101);
    this.hudLayer.add(this.status);

    this.joinWithRetry(this.mapId)
      .then(() => this.wireRoom())
      .catch((err) => {
        console.error('Join failed after retries', err);
        document.getElementById('conn-error').style.display = 'flex';
      });

    // dropped room (server restart, crash, network blip): quietly re-enter the
    // world as a fresh survivor instead of freezing on a dead session
    this.conn.onLeave((code) => {
      if (this.rejoining) return;
      pushChat({ from: '☠ doom', text: 'connection lost — finding you a new world…' });
      this.rejoining = true;
      this.time.delayedCall(800, () => this.scene.restart({ mapId: this.mapId }));
    });

    // input
    this.keys = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W, down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A, right: Phaser.Input.Keyboard.KeyCodes.D,
      u: Phaser.Input.Keyboard.KeyCodes.UP, d: Phaser.Input.Keyboard.KeyCodes.DOWN,
      l: Phaser.Input.Keyboard.KeyCodes.LEFT, r: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      f: Phaser.Input.Keyboard.KeyCodes.F, g: Phaser.Input.Keyboard.KeyCodes.G,
      space: Phaser.Input.Keyboard.KeyCodes.SPACE,
    });
    this.input.keyboard.on('keydown-ENTER', () => openChat());
    this.input.keyboard.on('keydown-F', () => { if (!this.chatActive) this.conn?.send('eat'); });
    this.input.keyboard.on('keydown-G', () => { if (!this.chatActive) this.conn?.send('heal'); });
    this.input.keyboard.on('keydown-SPACE', () => {
      if (!this.chatActive) this.conn?.send('attack', { angle: this.faceAngle });
    });
    // left-click swings toward the mouse aim point
    this.input.on('pointerdown', (p) => {
      if (this.chatActive || !p?.leftButtonDown()) return;
      const me = this.players.get(this.localSid);
      if (!me) return;
      const ang = Math.atan2(p.worldY - me.sprite.y, p.worldX - me.sprite.x);
      if (Number.isFinite(ang)) this.conn?.send('attack', { angle: ang });
    });

    // HUD
    this.hud = {
      bar: this.add.graphics().setScrollFactor(0).setDepth(100),
      biome: this.add.text(16, 118, '', {
        fontFamily: 'monospace', fontSize: '13px', color: '#8fd3a0',
        stroke: '#000', strokeThickness: 3,
      }).setScrollFactor(0).setDepth(101),
      statusRight: this.add.text(this.scale.width - 16, 16, '', {
        fontFamily: 'monospace', fontSize: '12px', color: '#999',
        stroke: '#000', strokeThickness: 3,
      }).setOrigin(1, 0).setScrollFactor(0).setDepth(101),
      inv: this.add.text(252, 22, '', {
        fontFamily: 'monospace', fontSize: '12px', color: '#f0c674',
        stroke: '#000', strokeThickness: 3,
      }).setScrollFactor(0).setDepth(101),
    };
    this.hudLayer.add(this.hud.bar, this.hud.biome, this.hud.statusRight, this.hud.inv);

    this.overlayTimer = 0;

    // combat fx layer (world space) + hud radar
    this.swingFx = this.add.graphics().setDepth(76);
    this.worldLayer.add(this.swingFx);
    this.minimap = this.add.graphics().setScrollFactor(0).setDepth(102);
    this.hudLayer.add(this.minimap);
  }

  // retry a few times with backoff before surrendering to the error screen
  async joinWithRetry(mapId) {
    const delays = [1500, 3000, 5000];
    const name = localStorage.getItem('doomdays.name') || 'survivor';
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.conn.join(mapId, name);
      } catch (err) {
        if (attempt >= delays.length) throw err;
        this.status.setText(`connecting… retry ${attempt + 1}`);
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }

  wireRoom() {
    const c = this.conn;
    this.localSid = c.room.sessionId;
    this.status.setText('');
    window.__gameSend = (type, data) => c.send(type, data);

    c.onMessage('chat', (msg) => pushChat(msg));
    c.onMessage('looted', (msg) => {
      for (const key of msg.keys || []) {
        this.lootedSet.add(key);
        this.crateByKey.get(key)?.setVisible(false);
      }
    });
    c.onMessage('system', (msg) => {
      switch (msg.event) {
        case 'wave':
          pushChat({ from: '☠ horizon', text: `Wave ${msg.wave}: the horde grows` });
          this.cameras.main.shake(300, 0.004);
          break;
        case 'died':
          pushChat({ from: '☠ doom', text: `${msg.name} fell… the wasteland returned them` });
          break;
        case 'loot': {
          const icon = msg.kind === 'food' ? '🍖' : '💊';
          const label = msg.kind === 'food' ? 'rations' : 'medkit';
          pushChat({ from: '☠ doom', text: `${msg.name} looted ${icon} ${label} ×${msg.amount}` });
          if (msg.key) {
            this.lootedSet.add(msg.key);
            this.crateByKey.get(msg.key)?.setVisible(false);
          }
          break;
        }
        case 'ate':
          pushChat({ from: '☠ doom', text: `${msg.name} ate a ration 🍖` });
          break;
        case 'healed':
          pushChat({ from: '☠ doom', text: `${msg.name} patched up with a medkit 💊` });
          break;
        case 'swing':
          this.swings.push({
            x: msg.x, y: msg.y,
            angle: (msg.angle / 255) * Math.PI * 2, t: 0,
          });
          break;
        case 'kill': {
          const dropText = msg.drop === 'med' ? ' — dropped a 💊 medkit'
            : msg.drop === 'food' ? ' — dropped 🍖 rations' : '';
          pushChat({ from: '☠ doom', text: `${msg.name} took down a zombie${dropText}` });
          this.cameras.main.shake(120, 0.002);
          break;
        }
        case 'meteor':
          this.meteors.push({ x: msg.x, y: msg.y, at: performance.now() + this.biome.rules.meteorLeadMs });
          this.cameras.main.shake(400, 0.0025);
          pushChat({ from: '☠ sky', text: '⚠ meteor incoming — MOVE!' });
          break;
        case 'impact':
          this.cameras.main.shake(350, 0.006);
          break;
        default:
          break;
      }
    });

    c.onAdd('players', (player, sid) => {
      const isLocal = sid === this.localSid;
      const sprite = this.add.image(player.x, player.y, isLocal ? 'p_local' : 'p_other').setDepth(70);
      const shadow = this.add.image(player.x, player.y, 'shadow').setDepth(67).setAlpha(0.5);
      if (!isLocal) sprite.setAlpha(0.92);
      const tag = makeNameTag(this, player.name);
      this.worldLayer.add(sprite, shadow, tag);
      this.players.set(sid, { sprite, shadow, tag, data: player });
      if (isLocal) {
        this.cameras.main.startFollow(sprite, true, 0.08, 0.08);
        pushChat({ from: '☠ doom', text: `You are ${player.name}. survive. the map is endless.` });
      }
    });

    c.onRemove('players', (_p, sid) => {
      const w = this.players.get(sid);
      if (w) { w.sprite.destroy(); w.shadow?.destroy(); w.tag.destroy(); this.players.delete(sid); }
    });

    c.onAdd('zombies', (zombie, zid) => {
      const sprite = this.add.image(zombie.x, zombie.y, 'zombie').setDepth(69).setAlpha(0.92);
      const shadow = this.add.image(zombie.x, zombie.y, 'shadow').setDepth(66).setAlpha(0.45);
      this.worldLayer.add(sprite, shadow);
      this.zombies.set(zid, { sprite, shadow, data: zombie });
    });

    c.onRemove('zombies', (_z, zid) => {
      const w = this.zombies.get(zid);
      if (w) { w.sprite.destroy(); w.shadow?.destroy(); this.zombies.delete(zid); }
    });

    // dynamic ground drops from defeated zombies
    c.onAdd('drops', (drop, did) => {
      const sprite = this.add.image(drop.x, drop.y, 'supply')
        .setDepth(4).setOrigin(0.5, 1).setScale(0.8)
        .setTint(drop.kind === 'med' ? 0xff9ec4 : 0xffd27a);
      const shadow = this.add.image(drop.x, drop.y, 'shadow').setDepth(3).setAlpha(0.4);
      this.worldLayer.add(sprite, shadow);
      this.drops.set(did, { sprite, shadow, data: drop });
    });

    c.onRemove('drops', (_d, did) => {
      const w = this.drops.get(did);
      if (w) { w.sprite.destroy(); w.shadow?.destroy(); this.drops.delete(did); }
    });
  }

  // --------------------------------------------------- chunk streaming -----
  // Paint chunk textures around the camera, place crates/props, prune far ones.
  syncChunks() {
    const view = this.cameras.main.worldView;
    const c0x = Math.floor(view.x / CHUNK_PX) - 1, c1x = Math.floor(view.right / CHUNK_PX) + 1;
    const c0y = Math.floor(view.y / CHUNK_PX) - 1, c1y = Math.floor(view.bottom / CHUNK_PX) + 1;

    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const key = `${cx}:${cy}`;
        if (this.chunks.has(key)) {
          this.chunks.get(key).used = this.chunkCount;
          continue;
        }
        this.chunkCount++;
        const texKey = buildChunkTexture(this, this.mapId, cx, cy);
        const img = this.add.image(cx * CHUNK_PX, cy * CHUNK_PX, texKey)
          .setOrigin(0).setDepth(-10);
        this.worldLayer.add(img);

        const chunk = genChunkData(this.mapId, cx, cy);
        const crates = [], props = [];
        chunk.lootSpots.forEach((s, i) => {
          const lkey = `${cx}:${cy}:${i}`;
          const sprite = this.add.image((s.wtx + .5) * TILE_SIZE, (s.wty + .5) * TILE_SIZE, 'supply')
            .setDepth(5).setOrigin(0.5, 1).setVisible(!this.lootedSet.has(lkey));
          this.worldLayer.add(sprite);
          crates.push({ key: lkey, sprite });
          this.crateByKey.set(lkey, sprite);
        });
        for (const z of chunk.safeZones) {
          if (z.kind === 'campfire') {
            const sprite = this.add.image((z.x + .5) * TILE_SIZE, (z.y + .5) * TILE_SIZE, 'campfire')
              .setDepth(5).setOrigin(0.5, 1);
            this.worldLayer.add(sprite);
            props.push(sprite);
          }
          // shade canopies are painted into the chunk itself; domes get a glow ring drawn live
        }

        const entry = { img, texKey, crates, props, used: this.chunkCount };
        this.chunks.set(key, entry);
        this.explored.add(key);
      }
    }

    // prune the oldest chunks beyond our keep window
    if (this.chunks.size > CHUNK_KEEP) {
      for (const [key, entry] of this.chunks) {
        if (this.chunks.size <= CHUNK_KEEP) break;
        if (this.chunkCount - entry.used <= 2) continue; // cutting-edge chunks stay
        this.chunks.delete(key);
        entry.img.destroy();
        this.textures.exists(entry.texKey) && this.textures.remove(entry.texKey);
        for (const c of entry.crates) {
          this.crateByKey.delete(c.key);
          c.sprite.destroy();
        }
        for (const p of entry.props) p.destroy();
      }
    }
  }

  // ------------------------------------------------------------- update ---
  update(time, deltaMs) {
    const dt = deltaMs / 1000;

    // keep the endless world painted around the camera
    this.syncChunks();

    // input intents (skip while typing in chat) — always report release as 0,0
    if (!this.chatActive) {
      const k = this.keys;
      const dx = (k.right.isDown || k.r.isDown ? 1 : 0) - (k.left.isDown || k.l.isDown ? 1 : 0);
      const dy = (k.down.isDown || k.d.isDown ? 1 : 0) - (k.up.isDown || k.u.isDown ? 1 : 0);
      this.conn.sendInput(dx, dy, time);
      if (dx || dy) this.faceAngle = Math.atan2(dy, dx);

      void k.f; void k.g; void k.space; // handled by dedicated keydown handlers
    } else {
      this.conn.sendInput(0, 0, time);
    }

    // expire meteor warnings whose impact already happened
    const lead = this.biome.rules.meteorLeadMs || 2600;
    this.meteors = this.meteors.filter((m) => performance.now() < m.at + 900);

    lerpGroup(this.players, dt, 12);
    lerpGroup(this.zombies, dt, 10);

    this.drawSwings(dt);

    this.overlayTimer += deltaMs;
    if (this.overlayTimer >= 200) {
      this.overlayTimer = 0;
      this.redrawOverlays();
      this.redrawHUD();
      this.redrawMinimap();
    }
  }

  // melee swing arcs fade over ~0.25s
  drawSwings(dt) {
    const fx = this.swingFx;
    fx.clear();
    for (const s of this.swings) s.t += dt;
    this.swings = this.swings.filter((s) => s.t < 0.25);
    for (const s of this.swings) {
      const a = 1 - s.t / 0.25;
      fx.lineStyle(5, 0xffffff, a * 0.85);
      fx.beginPath();
      fx.arc(s.x, s.y, 54, s.angle - 1.25, s.angle + 1.25, false);
      fx.strokePath();
      fx.lineStyle(2, 0xffffff, a * 0.4);
      fx.beginPath();
      fx.arc(s.x, s.y, 62, s.angle - 1.25, s.angle + 1.25, false);
      fx.strokePath();
    }
  }

  // pocket radar: explored chunk trail + nearby threats, bottom-right
  redrawMinimap() {
    const me = this.players.get(this.localSid);
    if (!me?.data) { this.minimap.clear(); return; }
    const mm = this.minimap;
    mm.clear();
    const W = 120, H = 88, s = 8 / CHUNK_PX;
    const ox = this.scale.width - W - 12, oy = this.scale.height - H - 12;
    panel(mm, ox, oy, W, H);
    const cx0 = ox + W / 2 - me.sprite.x * s, cy0 = oy + H / 2 - me.sprite.y * s;

    mm.fillStyle(0x3d444d, 0.85);
    for (const key of this.explored) {
      const [cx, cy] = key.split(':').map(Number);
      const mx = cx0 + cx * CHUNK_PX * s, my = cy0 + cy * CHUNK_PX * s;
      if (mx < ox + 1 || my < oy + 1 || mx > ox + W - 9 || my > oy + H - 9) continue;
      mm.fillRect(mx, my, 7.6, 7.6);
    }

    const dot = (wx, wy, color, r) => {
      const mx = cx0 + wx * s, my = cy0 + wy * s;
      if (mx < ox + 2 || my < oy + 2 || mx > ox + W - 2 || my > oy + H - 2) return;
      mm.fillStyle(color, 0.95).fillCircle(mx, my, r);
    };
    for (const w of this.drops.values()) dot(w.data.x, w.data.y, 0xffd27a, 2);
    for (const z of this.zombies.values()) dot(z.data.x, z.data.y, 0xd83b2e, 2.4);
    for (const p of this.players.values()) {
      if (p.data === me.data) continue;
      dot(p.data.x, p.data.y, 0x5ecfff, 2.2);
    }
    dot(me.data.x, me.data.y, 0xffffff, 3);
  }

  state() { return this.conn.room ? this.conn.room.state : null; }

  setChatState(active) { this.chatActive = !!active; }

  redrawOverlays() {
    const world = this.state()?.world;
    if (!world) return;

    const view = this.cameras.main.worldView;
    const T = TILE_SIZE;
    const tx0 = Math.floor(view.x / T) - 1, ty0 = Math.floor(view.y / T) - 1;
    const tx1 = Math.ceil((view.x + view.width) / T), ty1 = Math.ceil((view.y + view.height) / T);

    // rising water: tint every ground tile below the current level
    if (this.biome.flooded) {
      const g = this.waterOverlay;
      g.clear();
      g.fillStyle(this.biome.palette.waterTint, 0.78);
      const cutoff = world.waterLevel * 255;
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          if (heightAt(this.mapId, tx, ty) >= cutoff) continue;
          const cx = Math.floor(tx / CHUNK_TILES), cy = Math.floor(ty / CHUNK_TILES);
          const tile = genChunkData(this.mapId, cx, cy)
            .tiles[((ty - cy * CHUNK_TILES) * CHUNK_TILES) + (tx - cx * CHUNK_TILES)];
          if (tile === 2) continue; // buildings still peek out
          g.fillRect(tx * T, ty * T, T, T);
        }
      }
    }

    // safe-zone glow rings: campfires + clean-air domes (shade is painted)
    const dg = this.domeOverlay;
    dg.clear();
    const pcx = Math.floor(view.centerX / TILE_SIZE / CHUNK_TILES);
    const pcy = Math.floor(view.centerY / TILE_SIZE / CHUNK_TILES);
    for (let cy = pcy - 1; cy <= pcy + 1; cy++) {
      for (let cx = pcx - 1; cx <= pcx + 1; cx++) {
        for (const z of genChunkData(this.mapId, cx, cy).safeZones) {
          const zx = (z.x + .5) * T, zy = (z.y + .5) * T, r = z.r * T;
          if (z.kind === 'dome') {
            dg.fillStyle(0x59ff4d, 0.13).fillCircle(zx, zy, r);
            dg.lineStyle(2, 0x59ff4d, 0.55).strokeCircle(zx, zy, r);
          } else if (z.kind === 'campfire') {
            dg.fillStyle(0xff9a3a, 0.12).fillCircle(zx, zy, r);
            dg.lineStyle(2, 0xff9a3a, 0.4).strokeCircle(zx, zy, r);
          }
        }
      }
    }

    // wildfires: circles grown from each blaze's birth time
    const fg = this.fireOverlay;
    fg.clear();
    if (world.fires) {
      const growth = this.biome.rules.fireGrowth ?? 0;
      const maxR = this.biome.rules.maxFireRadiusTiles ?? 0;
      if (growth > 0 && maxR > 0) {
        fg.fillStyle(this.biome.palette.fire, 0.5);
        for (const fire of world.fires.values()) {
          const r = Math.min(maxR, growth * (world.clock - fire.born)) * T;
          if (r <= 0) continue;
          if (Math.abs(fire.x - view.centerX) > view.width + r * 2 ||
            Math.abs(fire.y - view.centerY) > view.height + r * 2) continue;
          fg.fillCircle(fire.x, fire.y, r);
        }
      }
    }

    // incoming meteors: target circles that tighten until impact
    const mg = this.meteorOverlay;
    mg.clear();
    for (const m of this.meteors) {
      const f = Math.max(0, Math.min(1, (m.at - performance.now()) / this.biome.rules.meteorLeadMs));
      const r = this.biome.rules.meteorRadius;
      mg.lineStyle(3, 0xff3b1f, 0.8).strokeCircle(m.x, m.y, r * 2.6);
      mg.lineStyle(3, 0xff3b1f, 0.9).strokeCircle(m.x, m.y, r * 0.3 + (r * 0.9) * f);
      mg.fillStyle(0xff3b1f, 0.12).fillCircle(m.x, m.y, r);
    }

    // hazard screen tint (also blank on biomes without a tint)
    const tint = this.tintColor(world);
    if (tint.alpha > 0) {
      this.hudLayer.setAlpha(1);
      // draw the tint as the topmost hud element via the bar graphics state trick:
      if (!this.hudTint) {
        this.hudTint = this.add.rectangle(
          this.scale.width / 2, this.scale.height / 2, this.scale.width + 4, this.scale.height + 4, 0xff5500)
          .setScrollFactor(0).setDepth(99);
        this.hudLayer.add(this.hudTint);
      }
      this.hudTint.setFillStyle(tint.color);
      this.hudTint.setAlpha(tint.alpha);
    } else if (this.hudTint) {
      this.hudTint.setAlpha(0);
    }
  }

  tintColor(world) {
    if (this.biome.heat) {
      return { color: 0xff5500, alpha: Math.max(0, Math.min(0.26, (world.temp - 33) * 0.014)) };
    }
    if (this.biome.frost) {
      return { color: 0x9be8ff, alpha: world.cold < 8 ? Math.min(0.3, (8 - world.cold) * 0.02) : 0 };
    }
    if (this.biome.toxic) {
      return { color: 0x59ff4d, alpha: world.toxin > 0.35 ? Math.min(0.3, (world.toxin - 0.35) * 0.45) : 0 };
    }
    // flooded: a soft blue underwater tint while actually standing in the sea
    const me = this.players.get(this.localSid)?.data;
    if (me) {
      const h = heightAt(this.mapId, Math.floor(me.x / TILE_SIZE), Math.floor(me.y / TILE_SIZE));
      if (h < world.waterLevel * 255) return { color: 0x1766a8, alpha: 0.32 };
    }
    return { color: 0, alpha: 0 };
  }

  redrawHUD() {
    const world = this.state()?.world;
    if (!world) return;
    const me = this.players.get(this.localSid)?.data;
    const hp = me ? me.hp : 100;
    const hunger = me ? me.hunger : 100;

    // minecraft-style panel: hearts + hazard meter + hunger gauge
    const bar = this.hud.bar;
    bar.clear();
    panel(bar, 10, 10, 236, 74);
    for (let i = 0; i < 10; i++) {
      const v = hp - i * 10;
      this.hearts[i].setTexture(v > 5 ? 'heart_full' : v > 0 ? 'heart_half' : 'heart_empty');
    }

    // hazard meter (biome-dependent)
    let fraction = 0, color = 0x9ee05a, label = '';
    if (this.biome.flooded) {
      fraction = world.waterLevel; color = 0x2f89b5;
      label = world.waterLevel >= (this.biome.rules.waterCap ?? 0.9)
        ? `🌊 flood peaked — the highland islands are safe`
        : `🌊 water ${(world.waterLevel * 100).toFixed(0)}% — climb high`;
    } else if (this.biome.heat) {
      fraction = Math.max(0, Math.min(1, (world.temp - 26) / 29));
      color = fraction > 0.6 ? 0xff5522 : 0xe8a83c;
      label = `🔥 ${world.temp.toFixed(0)}°C — find shade as it climbs`;
    } else if (this.biome.frost) {
      fraction = Math.max(0, Math.min(1, (5 - world.cold) / 30));
      color = fraction > 0.35 ? 0x7fd4ff : 0x5a9bc9;
      label = `❄ ${world.cold.toFixed(0)}°C — shelter at campfires when it drops`;
    } else if (this.biome.toxic) {
      fraction = world.toxin;
      color = fraction > 0.55 ? 0x74ff5a : 0x3f9e57;
      label = `☣ gas surge ${(world.toxin * 100).toFixed(0)}% — shelter in domes`;
    } else if (this.biome.meteors) {
      fraction = Math.min(1, (world.clock % 20) / 20);
      color = 0xff6a33;
      label = `☄ meteor bombardment — watch the sky`;
    } else {
      fraction = Math.min(1, world.wave / 20);
      label = `🧟 horde wave ${world.wave} — they keep coming`;
    }
    bar.fillStyle(0x101010, 0.9).fillRect(14, 46, 216, 8);
    bar.fillStyle(color, 1).fillRect(14, 46, 216 * fraction, 8);
    this.hud.biome.setText(label);

    // hunger gauge + carried supplies
    const hungerFrac = Math.max(0, hunger / 100);
    bar.fillStyle(0x101010, 0.9).fillRect(14, 64, 216, 8);
    bar.fillStyle(hungerFrac < 0.2 ? 0xd83b2e : 0xe8a83c, 1).fillRect(14, 64, 216 * hungerFrac, 8);
    this.hud.inv.setText(hungerFrac <= 0
      ? `🍖 0 · STARVING! Eat! [F]`
      : `🍖 ×${me ? me.food : 0}  💊 ×${me ? me.med : 0}  ·  [F] eat  [G] heal  [SPACE] swing`);

    this.hud.statusRight.setText(
      `${this.biome.name} · ⚔${me ? me.kills : 0} · ${this.players.size} survivors · ${world.clock}s survived`);
  }
}

// beveled minecraft-style UI panel (light top-left, dark bottom-right edges)
function panel(g, x, y, w, h) {
  g.fillStyle(0x0f0f12, 0.72).fillRect(x, y, w, h);
  g.fillStyle(0xffffff, 0.10).fillRect(x, y, w, 2).fillRect(x, y, 2, h);
  g.fillStyle(0x000000, 0.45).fillRect(x + w - 2, y, 2, h).fillRect(x, y + h - 2, w, 2);
}

function lerpGroup(map, dt, factor) {
  const t = 1 - Math.exp(-dt * factor);
  for (const w of map.values()) {
    if (!w.data) continue;
    w.sprite.x += (w.data.x - w.sprite.x) * t;
    w.sprite.y += (w.data.y - w.sprite.y) * t;
    if (w.shadow) { w.shadow.x = w.sprite.x; w.shadow.y = w.sprite.y + 10; }
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
