// server/SurvivalRoom.js — one authoritative room class for every biome.
// The room loads the map data for its mapId (filterBy(['mapId']) keeps players
// who pick the same map together) and runs the simulation: input processing,
// movement + collision, per-biome hazards, zombie AI and supplies.
import { Room } from 'colyseus';
import { Player, Zombie, SurvivalState } from './state.js';
import { generateMap, BIOMES, TILE, isBlockedMap, tileIndexAt } from '../shared/maps.js';

const PLAYER_SPEED = 118;   // px/s
const HP_MAX = 100;
const T = 32;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class SurvivalRoom extends Room {
  maxClients = 24;

  onCreate(options) {
    this.mapId = BIOMES[options.mapId] ? options.mapId : 'zombie_city';
    this.biome = BIOMES[this.mapId];
    this.map = generateMap(this.mapId);
    this.rules = this.biome.rules;

    this.state = new SurvivalState();
    this.state.mapId = this.mapId;

    // private, unsynchronized per-room data
    this.inputs = new Map();          // sessionId -> {dx, dy}
    this.hpFloat = new Map();         // sessionId -> fractional hp accumulator
    this.lastZombieHit = new Map();   // sessionId -> ms timestamp of last zombie hit
    this.lastSupplyUse = new Map();   // sessionId -> ms timestamp of last supply use
    this.sessionByPlayer = new Map(); // Player instance -> sessionId
    this.zombieSeq = 0;
    this.spawnCursor = 0;
    this.waveTimer = this.rules.waveInterval ?? 0;
    this.waterLevel = 0;
    this.fireRadius = 0;              // tiles grown from every fire seed (heat)
    this.simTime = 0;                 // seconds, drives the heat cycle

    this.setTimestep((deltaMs) => this.tick(deltaMs));
  }

  // ------------------------------------------------------------ lifecycle ---
  findSpawnSpot() {
    const map = this.map;
    for (let n = 0; n < map.spawns.length; n++) {
      const s = map.spawns[(this.spawnCursor + n) % map.spawns.length];
      const px = (s.tx + 0.5) * T, py = (s.ty + 0.5) * T;
      if (!isBlockedMap(map, px, py, this.waterLevel)) {
        this.spawnCursor = (this.spawnCursor + n + 1) % map.spawns.length;
        return { px, py };
      }
    }
    return { px: map.px / 2, py: map.py / 2 };
  }

  onJoin(client, options) {
    const name = String(options?.name || 'survivor').trim().slice(0, 12) || 'survivor';
    const spot = this.findSpawnSpot();

    const player = new Player({ name, hp: HP_MAX });
    player.x = Math.round(spot.px);
    player.y = Math.round(spot.py);
    this.state.players.set(client.sessionId, player);
    this.sessionByPlayer.set(player, client.sessionId);

    this.inputs.set(client.sessionId, { dx: 0, dy: 0 });
    this.hpFloat.set(client.sessionId, HP_MAX);
    this.lastZombieHit.set(client.sessionId, 0);
    this.lastSupplyUse.set(client.sessionId, 0);

    this.broadcast('chat', { from: '☠ doom', text: `${name} joined the wasteland` });
    client.send('joined', { mapId: this.mapId, name, px: player.x, py: player.y });
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
    this.lastZombieHit.delete(client.sessionId);
    this.lastSupplyUse.delete(client.sessionId);
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
  };

  // ------------------------------------------------------------ simulation --
  tick(deltaMs) {
    const dt = Math.min(deltaMs, 100) / 1000; // seconds
    this.simTime += dt;
    const wall = Date.now();
    const map = this.map, rules = this.rules;

    // --- environmental scalars (one authoritative value per hazard) ---
    if (this.biome.flooded) {
      this.waterLevel = Math.min(1, this.waterLevel + rules.waterRate * dt);
      this.state.world.waterLevel = Math.round(this.waterLevel * 1000) / 1000;
    }
    if (this.biome.heat) {
      const cyc = 2 * Math.PI * this.simTime / (rules.heatPeriodMs / 1000);
      this.state.world.temp = Math.round(
        (rules.heatMin + (rules.heatMax - rules.heatMin) * (0.5 + 0.5 * Math.sin(cyc))) * 10) / 10;
      this.fireRadius = Math.min(rules.maxFireRadiusTiles, this.fireRadius + rules.fireGrowth * dt);
    }
    this.state.world.clock = Math.floor(this.simTime);

    // --- zombie waves (zombie_city) ---
    if (this.biome.zombies) {
      this.waveTimer += deltaMs;
      if (this.waveTimer >= rules.waveInterval) {
        this.waveTimer -= rules.waveInterval;
        this.state.world.wave++;
        const players = this.state.players.size;
        const budget = Math.min(rules.maxZombies - this.state.zombies.size, Math.min(1 + this.state.world.wave, 5) * (players > 0 ? 1 : 0));
        for (let i = 0; i < budget; i++) this.spawnZombie();
        if (budget > 0) this.broadcast('system', { event: 'wave', wave: this.state.world.wave });
      }
    }

    // --- players: movement, hazards, supplies ---
    for (const [sessionId, player] of this.state.players) {
      const input = this.inputs.get(sessionId) || { dx: 0, dy: 0 };
      const moved = this.moveCharacter(player, input.dx, input.dy, PLAYER_SPEED, dt);

      // environment damage
      let dps = 0;
      if (this.biome.flooded) {
        const h = map.heights[tileIndexAt(map, player.x, player.y)];
        if (h < this.waterLevel * 255) dps = Math.max(dps, rules.submergedDps);
      }
      if (this.biome.heat) {
        const temp = this.state.world.temp;
        if (temp > rules.heatDamageTemp) {
          const inShade = map.shadeZones.some(z =>
            Math.hypot(player.x - (z.tx + 0.5) * T, player.y - (z.ty + 0.5) * T) < z.r * T);
          if (!inShade) dps = Math.max(dps, (temp - rules.heatDamageTemp) * rules.heatDamageScale);
        }
        const burning = map.fires.some(f =>
          Math.hypot(player.x - (f.tx + 0.5) * T, player.y - (f.ty + 0.5) * T) <
          this.fireRadius * T);
        if (burning) dps = Math.max(dps, rules.fireDps);
      }
      if (dps > 0) this.damagePlayer(sessionId, dps * dt);

      // supply caches heal (proximity + cooldown)
      if (wall - (this.lastSupplyUse.get(sessionId) || 0) > 7000 && player.hp < HP_MAX) {
        for (const s of map.supplies) {
          if (Math.hypot(player.x - (s.tx + 0.5) * T, player.y - (s.ty + 0.5) * T) < 28) {
            this.healPlayer(sessionId, 25);
            this.lastSupplyUse.set(sessionId, wall);
            break;
          }
        }
      }
      void moved;
    }

    // --- zombies: target nearest player, chase, bite, die ---
    for (const [zid, zombie] of this.state.zombies) {
      let best = null, bestSid = null, bestD = 1e9;
      for (const [sid, player] of this.state.players) {
        const d = Math.hypot(player.x - zombie.x, player.y - zombie.y);
        if (d < bestD) { bestD = d; best = player; bestSid = sid; }
      }
      if (!best) continue;

      if (bestD > rules.zombieContact) {
        const speed = Math.min(rules.zombieSpeed + this.state.world.wave * 3.5, 120);
        this.zombieMove(zombie, (best.x - zombie.x) / bestD * speed * dt,
          (best.y - zombie.y) / bestD * speed * dt);
      } else if (wall - (this.lastZombieHit.get(bestSid) || 0) > rules.zombieAttackMs) {
        this.lastZombieHit.set(bestSid, wall);
        this.damagePlayer(bestSid, rules.zombieDamage);
        // small knockback separated from the player
        const nx = (zombie.x - best.x), ny = (zombie.y - best.y);
        const nd = Math.max(1, Math.hypot(nx, ny));
        this.zombieMove(zombie, nx / nd * 6, ny / nd * 6);
      } else {
        void zid;
      }
    }
  }

  moveCharacter(char, dx, dy, speed, dt) {
    if (dx === 0 && dy === 0) return false;
    const len = Math.hypot(dx, dy);
    const vx = dx / len * speed * dt, vy = dy / len * speed * dt;
    const map = this.map;
    let moved = false;
    if (!isBlockedMap(map, char.x + vx, char.y, this.waterLevel)) { char.x = Math.round(char.x + vx); moved = true; }
    if (!isBlockedMap(map, char.x, char.y + vy, this.waterLevel)) { char.y = Math.round(char.y + vy); moved = true; }
    char.x = clamp(char.x, 8, map.px - 8);
    char.y = clamp(char.y, 8, map.py - 8);
    return moved;
  }

  zombieMove(zombie, vx, vy) {
    const map = this.map;
    const nx = clamp(zombie.x + vx, 8, map.px - 8);
    const ny = clamp(zombie.y + vy, 8, map.py - 8);
    if (map.tiles[tileIndexAt(map, nx, zombie.y)] !== TILE.WALL) zombie.x = Math.round(nx);
    if (map.tiles[tileIndexAt(map, zombie.x, ny)] !== TILE.WALL) zombie.y = Math.round(ny);
  }

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
    // died — respawn at a spawn point, restore health
    this.hpFloat.set(sessionId, HP_MAX);
    player.hp = HP_MAX;
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

  spawnZombie() {
    const map = this.map;
    // pick the nest farthest from every player (variety across the map)
    let best = null, bestD = -1;
    for (const nest of map.nests) {
      const px = (nest.tx + 0.5) * T, py = (nest.ty + 0.5) * T;
      let d = 1e9;
      for (const p of this.state.players.values()) {
        d = Math.min(d, Math.hypot(p.x - px, p.y - py));
      }
      if (d > bestD) { bestD = d; best = { px, py }; }
    }
    if (!best) return;

    // jitter around the nest center, off walls
    let px = best.px, py = best.py;
    for (let k = 0; k < 6; k++) {
      const jx = px + (Math.random() - 0.5) * 2.5 * T;
      const jy = py + (Math.random() - 0.5) * 2.5 * T;
      if (jx > 8 && jy > 8 && jx < map.px - 8 && jy < map.py - 8 &&
        map.tiles[tileIndexAt(map, jx, jy)] !== TILE.WALL) { px = jx; py = jy; break; }
    }

    const id = 'z' + (++this.zombieSeq);
    const zombie = new Zombie({ hp: 26 + Math.round(this.state.world.wave * 1.6) });
    zombie.x = Math.round(px);
    zombie.y = Math.round(py);
    this.state.zombies.set(id, zombie);
  }
}
