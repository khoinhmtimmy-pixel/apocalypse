// server/SurvivalRoom.js — one authoritative room class for every biome.
// Simulates the endless world: input processing, movement + collision from
// chunk data, per-biome hazards (hordes, rising water, heat, frost, gas,
// meteors), hunger/starvation, loot scavenging and wildfires.
import { Room } from 'colyseus';
import { Player, Zombie, Fire, Drop, SurvivalState } from './state.js';
import {
  BIOMES, TILE_SIZE, CHUNK_TILES, SPAWNS,
  genChunkData, tileOf, isBlockedAt, isWallAt, heightAt,
} from '../shared/maps.js';

const PLAYER_SPEED = 118;   // px/s
const HP_MAX = 100;
const HUNGER_MAX = 100;
const HUNGER_DRAIN = 0.38;      // hunger/s — a full belly lasts ~4.5 min
const STARVING_DPS = 1.4;       // hp/s while hunger is empty
const EAT_FOOD = 38;            // hunger restored per ration
const EAT_HEAL = 8;             // hp restored per ration
const MED_HEAL = 45;            // hp restored per medkit
const FOOD_CAP = 9, MED_CAP = 5;
const LOOT_PICKUP_MS = 1200;    // cooldown between scavenges
const LOOT_RADIUS = 30;         // px
const FIRE_CAP = 60;

// melee attack — [Space] / left-click swings
const ATTACK_CD_MS = 450;       // swing cooldown per player
const TAU = Math.PI * 2;
const ATTACK_RANGE = 64;        // px reach from the attacker's center
const ATTACK_HALF_ARC = 75 * Math.PI / 180;  // cone width is centered on the aim
const ATTACK_DAMAGE = 40;       // one base zombie per swing
const ATTACK_KNOCKBACK = 16;    // px the survivor knocks the zombie back
const DROP_MED_CHANCE = 0.25;   // killed zombie drop rates
const DROP_FOOD_CHANCE = 0.45;

// endless-map hygiene: idle far zombies stop chasing forever
const ZOMBIE_LEASH_PX = 940;    // farther than this from every survivor...
const ZOMBIE_LEASH_MS = 6000;   // ...for this long, and the zombie fades out

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class SurvivalRoom extends Room {
  maxClients = 24;

  onCreate(options) {
    this.mapId = BIOMES[options.mapId] ? options.mapId : 'zombie_city';
    this.biome = BIOMES[this.mapId];
    this.rules = this.biome.rules;

    this.state = new SurvivalState();
    this.state.mapId = this.mapId;
    this.state.world.temp = this.biome.frost ? this.rules.coldMax : 21;
    this.state.world.cold = this.biome.frost ? this.rules.coldMax : 15;

    // private, unsynchronized per-room data
    this.inputs = new Map();          // sessionId -> {dx, dy}
    this.hpFloat = new Map();         // sessionId -> fractional hp accumulator
    this.hungerFloat = new Map();     // sessionId -> fractional hunger accumulator
    this.lastZombieHit = new Map();   // sessionId -> ms timestamp of last zombie hit
    this.lastLootPickup = new Map();  // sessionId -> ms timestamp of last scavenge
    this.sessionByPlayer = new Map(); // Player instance -> sessionId
    this.looted = new Set();          // chunk loot spot keys already scavenged
    this.firesSeeded = new Set();     // chunk keys whose fire seeds were released
    this.pendingMeteors = [];         // {x, y, at}
    this.lastAttack = new Map();      // sessionId -> ms timestamp of last swing
    this.zombieFarSince = new Map();  // zombieId -> ms since out of everyone's reach
    this.dropsSeq = 0;
    this.waterCapAnnounced = false;
    this.meteorTimer = this.rules.meteorIntervalMs
      ? this.rules.meteorIntervalMs / 2 : 0;
    this.zombieSeq = 0;
    this.fireSeq = 0;
    this.spawnCursor = 0;
    this.waveTimer = this.rules.waveInterval ?? 0;
    this.waterLevel = 0;
    this.simTime = 0;                 // seconds, drives heat/cold/toxin cycles

    this.setTimestep((deltaMs) => this.tick(deltaMs));
  }

  // ------------------------------------------------------------ lifecycle ---
  findSpawnSpot() {
    for (let n = 0; n < SPAWNS.length; n++) {
      const s = SPAWNS[(this.spawnCursor + n) % SPAWNS.length];
      const px = (s.tx + 0.5) * TILE_SIZE, py = (s.ty + 0.5) * TILE_SIZE;
      if (!isBlockedAt(this.mapId, px, py, this.waterLevel)) {
        this.spawnCursor = (this.spawnCursor + n + 1) % SPAWNS.length;
        return { px, py };
      }
    }
    return { px: 24 * TILE_SIZE, py: 24 * TILE_SIZE };
  }

  onJoin(client, options) {
    const name = String(options?.name || 'survivor').trim().slice(0, 12) || 'survivor';
    const spot = this.findSpawnSpot();

    const player = new Player({ name, hp: HP_MAX, hunger: HUNGER_MAX });
    player.x = Math.round(spot.px);
    player.y = Math.round(spot.py);
    this.state.players.set(client.sessionId, player);
    this.sessionByPlayer.set(player, client.sessionId);

    this.inputs.set(client.sessionId, { dx: 0, dy: 0 });
    this.hpFloat.set(client.sessionId, HP_MAX);
    this.hungerFloat.set(client.sessionId, HUNGER_MAX);
    this.lastZombieHit.set(client.sessionId, 0);
    this.lastLootPickup.set(client.sessionId, 0);
    this.lastAttack.set(client.sessionId, 0);

    // late joiners need to know what was already scavenged
    client.send('looted', { keys: [...this.looted] });
    this.broadcast('chat', { from: '☠ doom', text: `${name} joined the wasteland` });
  }

  async onLeave(client) {
    try { await this.allowReconnection(client, 30); } catch { /* gone for good */ }
    const player = this.state.players.get(client.sessionId);
    if (player) {
      this.sessionByPlayer.delete(player);
      this.broadcast('chat', { from: '☠ doom', text: `${player.name} was lost` });
    }
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.hpFloat.delete(client.sessionId);
    this.hungerFloat.delete(client.sessionId);
    this.lastZombieHit.delete(client.sessionId);
    this.lastLootPickup.delete(client.sessionId);
    this.lastAttack.delete(client.sessionId);
  }

  // ------------------------------------------------------------ messages  ---
  messages = {
    'input': (client, data) => {
      const input = this.inputs.get(client.sessionId);
      if (!input) return;
      input.dx = clamp(Number(data?.dx) || 0, -1, 1);
      input.dy = clamp(Number(data?.dy) || 0, -1, 1);
    },

    'chat': (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const text = String(data?.text || '').slice(0, 140).trim();
      if (!text) return;
      this.broadcast('chat', { from: player.name, text });
    },

    'eat': (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.food <= 0) return;
      if (player.hunger > HUNGER_MAX - 5) return;          // already fed
      player.food--;
      this.hungerFloat.set(client.sessionId,
        Math.min(HUNGER_MAX, this.hungerFloat.get(client.sessionId) + EAT_FOOD));
      player.hunger = Math.round(this.hungerFloat.get(client.sessionId));
      this.healPlayer(client.sessionId, EAT_HEAL);
      this.broadcast('system', { event: 'ate', name: player.name });
    },

    'heal': (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.med <= 0) return;
      if (player.hp > HP_MAX - 10) return;                 // healthy enough
      player.med--;
      this.healPlayer(client.sessionId, MED_HEAL);
      this.broadcast('system', { event: 'healed', name: player.name });
    },

    // [Space] / left-click: server-authoritative melee swing toward the aim angle
    'attack': (client, data) => {
      const sessionId = client.sessionId;
      const player = this.state.players.get(sessionId);
      if (!player) return;
      const now = Date.now();
      if (now - (this.lastAttack.get(sessionId) || 0) < ATTACK_CD_MS) return;
      this.lastAttack.set(sessionId, now);

      let aim = Number(data?.angle);
      if (!Number.isFinite(aim)) aim = (player.angle / 255) * TAU; // fall back to facing
      aim = ((aim % TAU) + TAU) % TAU;

      this.broadcast('system', {
        event: 'swing', sid: sessionId,
        angle: Math.round(aim * 255 / TAU), x: player.x, y: player.y,
      });

      for (const [zid, zombie] of this.state.zombies) {
        const dx = zombie.x - player.x, dy = zombie.y - player.y;
        if (Math.hypot(dx, dy) > ATTACK_RANGE) continue;
        let diff = Math.abs(Math.atan2(dy, dx) - aim);
        diff = Math.min(diff, TAU - diff);
        if (diff > ATTACK_HALF_ARC) continue;
        this.hitZombie(zid, zombie, player);
      }
    },
  };

  // ------------------------------------------------------------ simulation --
  tick(deltaMs) {
    const dt = Math.min(deltaMs, 100) / 1000; // seconds
    this.simTime += dt;
    const wall = Date.now();
    const rules = this.rules;
    this.state.world.clock = Math.floor(this.simTime);

    // --- environmental scalars (one authoritative value per hazard) ---
    if (this.biome.flooded) {
      this.waterLevel = Math.min(rules.waterCap ?? 0.90, this.waterLevel + rules.waterRate * dt);
      this.state.world.waterLevel = Math.round(this.waterLevel * 1000) / 1000;
      if (!this.waterCapAnnounced && this.waterLevel >= (rules.waterCap ?? 0.90)) {
        this.waterCapAnnounced = true;
        this.broadcast('chat', { from: '☠ doom',
          text: 'The flood has reached its peak. The highland islands stay dry — hop them forever.' });
      }
    }
    if (this.biome.heat) {
      this.state.world.temp = Math.round(
        (rules.heatMin + (rules.heatMax - rules.heatMin) *
          (0.5 + 0.5 * Math.sin(2 * Math.PI * this.simTime / (rules.heatPeriodMs / 1000)))) * 10) / 10;
    }
    if (this.biome.frost) {
      this.state.world.cold = Math.round(
        (rules.coldMin + (rules.coldMax - rules.coldMin) *
          (0.5 + 0.5 * Math.sin(2 * Math.PI * this.simTime / (rules.coldPeriodMs / 1000)))) * 10) / 10;
    }
    if (this.biome.toxic) {
      this.state.world.toxin = Math.round(
        (0.5 + 0.5 * Math.sin(2 * Math.PI * this.simTime / (rules.toxinPeriodMs / 1000))) * 100) / 100;
    }

    // --- zombie waves (zombie biomes) ---
    if (this.biome.zombies) {
      this.waveTimer += deltaMs;
      if (this.waveTimer >= rules.waveInterval) {
        this.waveTimer -= rules.waveInterval;
        this.state.world.wave++;
        const players = this.state.players.size;
        const budget = Math.min(rules.maxZombies - this.state.zombies.size,
          Math.min(1 + this.state.world.wave, 5) * (players > 0 ? 1 : 0));
        for (let i = 0; i < budget; i++) this.spawnZombie();
        if (budget > 0) this.broadcast('system', { event: 'wave', wave: this.state.world.wave });
      }
    }

    // --- meteor bombardment (meteor_fall) ---
    if (this.biome.meteors && this.state.players.size > 0) {
      this.meteorTimer += deltaMs;
      if (this.meteorTimer >= rules.meteorIntervalMs) {
        this.meteorTimer = 0;
        const playersArr = [...this.state.players.values()];
        const t = playersArr[Math.floor(Math.random() * playersArr.length)];
        const px = Math.round(t.x + (Math.random() - 0.5) * 520);
        const py = Math.round(t.y + (Math.random() - 0.5) * 520);
        this.pendingMeteors.push({ x: px, y: py, at: wall + rules.meteorLeadMs });
        this.broadcast('system', { event: 'meteor', x: px, y: py });
      }
    }
    for (let i = this.pendingMeteors.length - 1; i >= 0; i--) {
      const m = this.pendingMeteors[i];
      if (wall < m.at) continue;
      this.pendingMeteors.splice(i, 1);
      this.broadcast('system', { event: 'impact', x: m.x, y: m.y });
      for (const [sid, player] of this.state.players) {
        if (Math.hypot(player.x - m.x, player.y - m.y) < rules.meteorRadius) {
          this.damagePlayer(sid, rules.meteorDamage);
        }
      }
      this.addFire(m.x, m.y);
    }

    // --- players: movement, hazards, hunger, loot ---
    for (const [sessionId, player] of this.state.players) {
      const input = this.inputs.get(sessionId) || { dx: 0, dy: 0 };
      this.moveCharacter(player, input.dx, input.dy, PLAYER_SPEED, dt);
      if (input.dx || input.dy) {
        player.angle = clamp(Math.round(((Math.atan2(input.dy, input.dx) / TAU) * 255) % 256), 0, 255);
      }

      // hunger drains no matter what; an empty belly burns health
      const hung = Math.max(0, (this.hungerFloat.get(sessionId) ?? HUNGER_MAX) - HUNGER_DRAIN * dt);
      this.hungerFloat.set(sessionId, hung);
      player.hunger = Math.round(hung);

      let dps = 0;
      if (hung <= 0) dps = Math.max(dps, STARVING_DPS);

      if (this.biome.flooded) {
        const t = tileOf(player.x, player.y);
        if (heightAt(this.mapId, t.tx, t.ty) < this.waterLevel * 255) {
          dps = Math.max(dps, rules.submergedDps);
        }
      }
      if (this.biome.heat) {
        const temp = this.state.world.temp;
        if (temp > rules.heatDamageTemp && !this.inSafeZone(player, 'shade')) {
          dps = Math.max(dps, (temp - rules.heatDamageTemp) * rules.heatDamageScale);
        }
      }
      if (this.biome.frost) {
        const cold = this.state.world.cold;
        if (cold < rules.freezeTemp && !this.inSafeZone(player, 'campfire')) {
          dps = Math.max(dps, (rules.freezeTemp - cold) * rules.coldScale);
        }
      }
      if (this.biome.toxic) {
        if (this.state.world.toxin > rules.toxinThreshold && !this.inSafeZone(player, 'dome')) {
          dps = Math.max(dps, rules.toxinDps);
        }
      }

      // wildfires burn everyone nearby
      for (const fire of this.state.fires.values()) {
        const r = Math.min(rules.maxFireRadiusTiles ?? 0, (rules.fireGrowth ?? 0) * (this.simTime - fire.born));
        if (r > 0 && Math.hypot(player.x - fire.x, player.y - fire.y) < r * TILE_SIZE) {
          dps = Math.max(dps, rules.fireDps ?? 6);
          break;
        }
      }

      if (dps > 0) this.damagePlayer(sessionId, dps * dt);

      this.ensureChunkFires(player);

      // scavenge: automatic pickup when walking onto a supply crate
      if (wall - (this.lastLootPickup.get(sessionId) || 0) > LOOT_PICKUP_MS) {
        this.tryLoot(sessionId, player);
      }
    }

    // --- zombies: target nearest player, chase, bite; fade out far strays ---
    for (const [zid, zombie] of this.state.zombies) {
      let best = null, bestSid = null, bestD = 1e9;
      for (const [sid, player] of this.state.players) {
        const d = Math.hypot(player.x - zombie.x, player.y - zombie.y);
        if (d < bestD) { bestD = d; best = player; bestSid = sid; }
      }
      if (!best) continue;

      // endless-map leash: out of everyone's reach long enough => despawn
      if (bestD > ZOMBIE_LEASH_PX) {
        const since = this.zombieFarSince.get(zid) || wall;
        this.zombieFarSince.set(zid, since);
        if (wall - since > ZOMBIE_LEASH_MS) {
          this.state.zombies.delete(zid);
          this.zombieFarSince.delete(zid);
          continue;
        }
      } else if (this.zombieFarSince.has(zid)) {
        this.zombieFarSince.delete(zid);
      }

      if (bestD > rules.zombieContact) {
        const speed = Math.min(rules.zombieSpeed + this.state.world.wave * 3.5, 120);
        const nx = (best.x - zombie.x) / bestD, ny = (best.y - zombie.y) / bestD;
        this.zombieMove(zombie, nx * speed * dt, ny * speed * dt);
      } else if (wall - (this.lastZombieHit.get(bestSid) || 0) > rules.zombieAttackMs) {
        this.lastZombieHit.set(bestSid, wall);
        this.damagePlayer(bestSid, rules.zombieDamage);
        // small knockback separated from the player
        const nx = zombie.x - best.x, ny = zombie.y - best.y;
        const nd = Math.max(1, Math.hypot(nx, ny));
        this.zombieMove(zombie, nx / nd * 6, ny / nd * 6);
      }
    }
  }

  // ---------------------------------------------------------- zone checks ---
  // Chunk-local scan of the 3×3 chunks around a player.
  inSafeZone(player, kind) {
    const t = tileOf(player.x, player.y);
    const xc = Math.floor(t.tx / CHUNK_TILES), yc = Math.floor(t.ty / CHUNK_TILES);
    for (let cy = yc - 1; cy <= yc + 1; cy++) {
      for (let cx = xc - 1; cx <= xc + 1; cx++) {
        for (const z of genChunkData(this.mapId, cx, cy).safeZones) {
          if (z.kind !== kind) continue;
          if (Math.hypot(player.x - (z.x + .5) * TILE_SIZE,
            player.y - (z.y + .5) * TILE_SIZE) < z.r * TILE_SIZE) return true;
        }
      }
    }
    return false;
  }

  tryLoot(sessionId, player) {
    const now = Date.now();
    const t = tileOf(player.x, player.y);
    const xc = Math.floor(t.tx / CHUNK_TILES), yc = Math.floor(t.ty / CHUNK_TILES);

    // scavengable crates generated into the endless chunks
    for (let cy = yc - 1; cy <= yc + 1; cy++) {
      for (let cx = xc - 1; cx <= xc + 1; cx++) {
        const chunk = genChunkData(this.mapId, cx, cy);
        for (let i = 0; i < chunk.lootSpots.length; i++) {
          const s = chunk.lootSpots[i];
          const key = `${cx}:${cy}:${i}`;
          if (this.looted.has(key)) continue;
          if (Math.hypot(player.x - (s.wtx + .5) * TILE_SIZE,
            player.y - (s.wty + .5) * TILE_SIZE) > LOOT_RADIUS) continue;

          this.grantLoot(sessionId, player, s.kind);
          this.looted.add(key);
          // everyone (including late joiners) must hide this crate sprite
          this.broadcast('looted', { keys: [key] });
          return;
        }
      }
    }

    // dynamic drops left behind by defeated zombies
    for (const [did, drop] of this.state.drops) {
      if (Math.hypot(player.x - drop.x, player.y - drop.y) > LOOT_RADIUS) continue;
      this.grantLoot(sessionId, player, drop.kind);
      this.state.drops.delete(did);
      return;
    }
  }

  grantLoot(sessionId, player, kind) {
    this.lastLootPickup.set(sessionId, Date.now());
    const amount = kind === 'food' && Math.random() < 0.4 ? 2 : 1;
    if (kind === 'food') player.food = Math.min(FOOD_CAP, player.food + amount);
    else player.med = Math.min(MED_CAP, player.med + 1);
    this.broadcast('system', { event: 'loot', name: player.name, kind, amount });
  }

  // -------------------------------------------------------------- combat ----
  hitZombie(zid, zombie, player) {
    const hp = Math.max(0, zombie.hp - ATTACK_DAMAGE);
    zombie.hp = hp;
    // knockback pushes the zombie away from the attacker
    const ang = Math.atan2(zombie.y - player.y, zombie.x - player.x);
    this.zombieMove(zombie, Math.cos(ang) * ATTACK_KNOCKBACK, Math.sin(ang) * ATTACK_KNOCKBACK);
    if (hp > 0) return;

    this.state.zombies.delete(zid);
    this.zombieFarSince.delete(zid);
    player.kills = Math.min(255, player.kills + 1);
    const roll = Math.random();
    const kind = roll < DROP_MED_CHANCE ? 'med' : roll < DROP_MED_CHANCE + DROP_FOOD_CHANCE ? 'food' : null;
    if (kind) {
      const id = 'd' + (++this.dropsSeq);
      const drop = new Drop({
        x: Math.round(zombie.x + (Math.random() - 0.5) * 22),
        y: Math.round(zombie.y + (Math.random() - 0.5) * 22),
        kind,
      });
      this.state.drops.set(id, drop);
    }
    this.broadcast('system', {
      event: 'kill', name: player.name, drop: kind || '',
    });
  }

  // ------------------------------------------------------------------ fire ---
  addFire(px, py) {
    const id = 'f' + (++this.fireSeq);
    const fire = new Fire({ x: Math.round(px), y: Math.round(py), born: Math.floor(this.simTime) });
    this.state.fires.set(id, fire);
    this.trimFires();
  }

  // Release the deterministic fire seeds of chunks survivors actually visit.
  ensureChunkFires(player) {
    if (!this.biome.heat) return;
    const t = tileOf(player.x, player.y);
    const xc = Math.floor(t.tx / CHUNK_TILES), yc = Math.floor(t.ty / CHUNK_TILES);
    for (let cy = yc - 1; cy <= yc + 1; cy++) {
      for (let cx = xc - 1; cx <= xc + 1; cx++) {
        const ckey = `${cx}:${cy}`;
        if (this.firesSeeded.has(ckey)) continue;
        this.firesSeeded.add(ckey);
        for (const seed of genChunkData(this.mapId, cx, cy).fireSeeds) {
          this.addFire((seed.wtx + .5) * TILE_SIZE, (seed.wty + .5) * TILE_SIZE);
        }
      }
    }
  }

  trimFires() {
    if (this.state.fires.size <= FIRE_CAP) return;
    // remove the fires farthest from every player
    let worst = null, worstKey = null, worstD = -1;
    for (const [id, fire] of this.state.fires) {
      let d = 1e18;
      for (const p of this.state.players.values()) {
        d = Math.min(d, Math.hypot(p.x - fire.x, p.y - fire.y));
      }
      if (d > worstD) { worstD = d; worst = fire; worstKey = id; }
    }
    if (worst && worstD > 1500) this.state.fires.delete(worstKey);
  }

  // ------------------------------------------------------------- movement ---
  moveCharacter(char, dx, dy, speed, dt) {
    if (dx === 0 && dy === 0) return false;
    const len = Math.hypot(dx, dy);
    const vx = dx / len * speed * dt, vy = dy / len * speed * dt;
    let moved = false;
    if (!isBlockedAt(this.mapId, char.x + vx, char.y, this.waterLevel)) { char.x = Math.round(char.x + vx); moved = true; }
    if (!isBlockedAt(this.mapId, char.x, char.y + vy, this.waterLevel)) { char.y = Math.round(char.y + vy); moved = true; }
    return moved;
  }

  zombieMove(zombie, vx, vy) {
    const nx = zombie.x + vx, ny = zombie.y + vy;
    if (!isWallAt(this.mapId, nx, zombie.y)) zombie.x = Math.round(nx);
    if (!isWallAt(this.mapId, zombie.x, ny)) zombie.y = Math.round(ny);
  }

  // ------------------------------------------------------------ life/death ---
  damagePlayer(sessionId, amount) {
    if (amount <= 0) return;
    const player = this.state.players.get(sessionId);
    if (!player) return;
    const hp = Math.max(0, (this.hpFloat.get(sessionId) ?? player.hp) - amount);
    this.hpFloat.set(sessionId, hp);
    if (hp > 0.5) {
      player.hp = Math.min(HP_MAX, Math.round(hp));
      return;
    }
    // died — respawn, restore the body (but keep the backpack)
    this.hpFloat.set(sessionId, HP_MAX);
    player.hp = HP_MAX;
    this.hungerFloat.set(sessionId, HUNGER_MAX);
    player.hunger = HUNGER_MAX;
    player.deaths = Math.min(255, player.deaths + 1);
    const spot = this.findSpawnSpot();
    player.x = Math.round(spot.px);
    player.y = Math.round(spot.py);
    this.lastZombieHit.set(sessionId, Date.now()); // brief grace period
    this.broadcast('system', { event: 'died', name: player.name });
  }

  healPlayer(sessionId, amount) {
    const player = this.state.players.get(sessionId);
    if (!player) return;
    const hp = Math.min(HP_MAX, (this.hpFloat.get(sessionId) ?? player.hp) + amount);
    this.hpFloat.set(sessionId, hp);
    player.hp = Math.round(hp);
  }

  // ------------------------------------------------------------- zombies ----
  spawnZombie() {
    // gather nest sites from the chunks around one random player
    const playersArr = [...this.state.players.values()];
    if (!playersArr.length) return;
    const anchor = playersArr[Math.floor(Math.random() * playersArr.length)];
    const t = tileOf(anchor.x, anchor.y);
    const xc = Math.floor(t.tx / CHUNK_TILES), yc = Math.floor(t.ty / CHUNK_TILES);

    let best = null, bestD = -1;
    for (let cy = yc - 1; cy <= yc + 1; cy++) {
      for (let cx = xc - 1; cx <= xc + 1; cx++) {
        for (const nest of genChunkData(this.mapId, cx, cy).nests) {
          const nx = (nest.wtx + .5) * TILE_SIZE, ny = (nest.wty + .5) * TILE_SIZE;
          let d = 1e9;
          for (const p of this.state.players.values()) {
            d = Math.min(d, Math.hypot(p.x - nx, p.y - ny));
          }
          if (d > bestD) { bestD = d; best = { nx, ny }; }
        }
      }
    }
    if (!best) { // fallback: haunt a player from a short distance out
      const ang = Math.random() * Math.PI * 2;
      best = { nx: anchor.x + Math.cos(ang) * 7 * TILE_SIZE, ny: anchor.y + Math.sin(ang) * 7 * TILE_SIZE };
    }

    // jitter around the nest center, off walls
    let px = best.nx, py = best.ny;
    for (let k = 0; k < 6; k++) {
      const jx = px + (Math.random() - 0.5) * 2.5 * TILE_SIZE;
      const jy = py + (Math.random() - 0.5) * 2.5 * TILE_SIZE;
      if (!isWallAt(this.mapId, jx, jy)) { px = jx; py = jy; break; }
    }

    const id = 'z' + (++this.zombieSeq);
    const zombie = new Zombie({ hp: 26 + Math.round(this.state.world.wave * 1.6) });
    zombie.x = Math.round(px);
    zombie.y = Math.round(py);
    this.state.zombies.set(id, zombie);
  }
}
