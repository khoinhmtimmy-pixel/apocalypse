// server/SurvivalRoom.js — one authoritative room class for every biome.
// Simulates the endless world: input processing, movement + collision from
// chunk data, per-biome hazards (hordes, rising water, heat, frost, gas,
// meteors), hunger/starvation, loot scavenging and wildfires.
import { Room } from 'colyseus';
import { Player, Zombie, Fire, Drop, SurvivalState } from './state.js';
import {
  BIOMES, TILE_SIZE, CHUNK_TILES, SPAWNS, DIFFS,
  genChunkData, tileOf, isBlockedAt, isWallAt, heightAt,
} from '../shared/maps.js';
import { GUNS, gunOf, SHOP } from '../shared/guns.js';

const PLAYER_SPEED = 118;   // px/s baseline (up.spd + haste multiply)
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

// Đêm Xác Sống port: kill payouts and combat helpers (difficulty-scaled)
const KILL_COIN = 3;            // base coins per kill (× diff.coin)
const KILL_SCORE = 12;
const BULLET_RADIUS = 17;       // zombie hit radius vs bullets
const PET_RADIUS = 300;         // pet supports from this distance
const PET_CD_MS = 1300;
const REGEN_PER_S = 0.6;        // per up.reg level, after 6s without damage

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class SurvivalRoom extends Room {
  maxClients = 24;

  onCreate(options) {
    this.mapId = BIOMES[options.mapId] ? options.mapId : 'zombie_city';
    this.biome = BIOMES[this.mapId];
    this.rules = this.biome.rules;
    this.diff = DIFFS[clamp(Number(options?.diff) | 0, 0, DIFFS.length - 1)] || DIFFS[1];

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
    this.bullets = [];                // server-only projectiles {x,y,vx,vy,life,pid,gun,n}
    this.lastShot = new Map();        // sessionId -> ms of last shot
    this.reloadBy = new Map();        // sessionId -> ms when reload finishes
    this.lastHurtAt = new Map();      // sessionId -> ms of last damage taken (regen)
    this.hasteBy = new Map();         // sessionId -> ms when haste expires
    this.petCd = new Map();           // sessionId -> ms of last pet bite
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

  // derived stats from the selected difficulty + shop upgrades
  upOf(player, key) {
    return player?.up?.get(String(key)) || 0;
  }

  hpMaxOf(player) {
    return HP_MAX + this.upOf(player, 'hp') * 20;
  }

  moveSpeedOf(player, sessionId) {
    let spd = PLAYER_SPEED * (1 + 0.07 * this.upOf(player, 'spd'));
    const now = Date.now();
    if (now < (this.hasteBy.get(sessionId) || 0)) spd *= SHOP.haste.mul;
    return spd;
  }

  onJoin(client, options) {
    const name = String(options?.name || 'survivor').trim().slice(0, 12) || 'survivor';
    const spot = this.findSpawnSpot();

    const player = new Player({ name, hp: HP_MAX, hunger: HUNGER_MAX });
    player.x = Math.round(spot.px);
    player.y = Math.round(spot.py);
    player.own.set(String(SHOP.startGun), 1);
    player.ammo = gunOf(0).mag;
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
    this.lastShot.delete(client.sessionId);
    this.reloadBy.delete(client.sessionId);
    this.lastHurtAt.delete(client.sessionId);
    this.hasteBy.delete(client.sessionId);
    this.petCd.delete(client.sessionId);
  }

  // ------------------------------------------------------------ messages  ---
  messages = {
    // equip another owned gun (hotkeys 1-5 / mouse wheel client-side)
    'equip': (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const id = Number(data?.gun) | 0;
      if (!player.own.get(String(id))) return;
      player.gunId = id;
      player.ammo = gunOf(id).mag;
      this.reloadBy.delete(client.sessionId);
    },

    // [Space]/left-click fires the equipped gun — server checks cd, ammo, auth
    'shoot': (client, data) => {
      const sessionId = client.sessionId;
      const player = this.state.players.get(sessionId);
      if (!player) return;
      const now = Date.now();
      const gun = gunOf(player.gunId);
      const cdMs = gun.cd * 1000 * (1 - 0.06 * this.upOf(player, 'rate'));
      if (now - (this.lastShot.get(sessionId) || 0) < cdMs) return;
      if (this.reloadBy.has(sessionId)) return;
      if (player.ammo <= 0) { this.startReload(sessionId, player, gun); return; }

      this.lastShot.set(sessionId, now);
      player.ammo = Math.max(0, player.ammo - 1);

      let aim = Number(data?.angle);
      if (!Number.isFinite(aim)) aim = (player.angle / 255) * Math.PI * 2;
      for (let i = 0; i < gun.pel; i++) {
        // per-pellet fan (shotguns) plus a touch of per-bullet jitter
        const a = aim + (i - (gun.pel - 1) / 2) * Math.max(gun.spr, 0.09)
          + (Math.random() - 0.5) * gun.spr * 0.5;
        this.bullets.push({
          x: player.x, y: player.y,
          vx: Math.cos(a) * gun.v, vy: Math.sin(a) * gun.v,
          life: gun.life, pid: sessionId, gun: player.gunId,
          dmg: gun.dmg * (1 + 0.15 * this.upOf(player, 'dmg')),
        });
      }
      if (player.ammo <= 0) this.startReload(sessionId, player, gun);
      this.broadcast('shot', {
        sid: sessionId, x: player.x, y: player.y, angle: aim,
        gun: player.gunId, n: gun.pel, spr: gun.spr, v: gun.v, life: gun.life,
      });
    },

    // force a magazine change
    'reload': (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || this.reloadBy.has(client.sessionId)) return;
      this.startReload(client.sessionId, player, gunOf(player.gunId));
    },

    // the Đêm Xác Sống shop — coins are earned by surviving, spent mid-run
    'buy': (client, data) => {
      const sessionId = client.sessionId;
      const player = this.state.players.get(sessionId);
      if (!player) return;
      const kind = String(data?.kind || '');
      let ok = false, text = '';
      if (kind === 'gun' || kind === 'equip') {
        const gun = gunOf(Number(data?.id) | 0);
        if (kind === 'equip') {
          if (player.own.get(String(gun.id)) && gun.id !== player.gunId) {
            this.messages.equip(client, data); ok = true; text = `Equipped ${gun.name}`;
          }
        } else if (!player.own.get(String(gun.id)) && player.coin >= gun.price) {
          player.coin -= gun.price;
          player.own.set(String(gun.id), 1);
          player.gunId = gun.id;
          player.ammo = gun.mag;
          this.reloadBy.delete(sessionId);
          ok = true; text = `Bought ${gun.name} · equipped`;
        }
      } else if (kind === 'up') {
        const def = SHOP.up.find((u) => u.key === data?.key);
        const lvl = player.up.get(String(def?.key || '')) || 0;
        if (def && lvl < SHOP.upgradeCap) {
          const cost = Math.round(def.base * (1 + lvl * 1.1));
          if (player.coin >= cost) {
            player.coin -= cost;
            player.up.set(def.key, lvl + 1);
            if (def.key === 'hp') this.healPlayer(sessionId, 20 * (lvl + 1));
            ok = true; text = `${def.name} → level ${lvl + 1}`;
          }
        }
      } else if (kind === 'item') {
        if (data?.item === 'bomb' && player.bombs < SHOP.bombs.cap
          && player.coin >= SHOP.bombs.base) {
          player.coin -= SHOP.bombs.base; player.bombs++; ok = true; text = 'Bought bomb [Z]';
        } else if (data?.item === 'haste' && player.haste < SHOP.haste.cap
          && player.coin >= SHOP.haste.base) {
          player.coin -= SHOP.haste.base; player.haste++; ok = true; text = 'Bought rush [V]';
        }
      } else if (kind === 'pet') {
        const pet = SHOP.pets[Number(data?.id) | 0];
        if (pet && player.petId === 0 && player.coin >= pet.price) {
          player.coin -= pet.price;
          player.petId = Number(data.id);
          ok = true; text = `${pet.name} joins the party`;
        }
      }
      if (!ok) text = text || 'Not enough coins';
      client.send('system', { event: ok ? 'bought' : 'buyfail', text });
    },

    // [Z] bomb — validated by the server (charge + money spent earlier)
    'bomb': (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.bombs <= 0) return;
      player.bombs--;
      const r = SHOP.bombs.radius;
      let hits = 0;
      for (const [zid, zombie] of this.state.zombies) {
        if (Math.hypot(zombie.x - player.x, zombie.y - player.y) < r) { hits++; this.killZombie(zid, zombie, player, 'bomb'); }
      }
      this.broadcast('system', { event: 'bomb', x: player.x, y: player.y, hits });
    },

    // [V] rush — short speed boost charge
    'haste': (client) => {
      const sessionId = client.sessionId;
      const player = this.state.players.get(sessionId);
      if (!player || player.haste <= 0) return;
      const now = Date.now();
      if (now < (this.hasteBy.get(sessionId) || 0)) return;
      player.haste--;
      this.hasteBy.set(sessionId, now + SHOP.haste.ms);
      this.broadcast('system', { event: 'haste', name: player.name });
    },
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
      const waveEvery = (rules.waveInterval || 12000) * this.diff.waves;
      if (this.waveTimer >= waveEvery) {
        this.waveTimer -= waveEvery;
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

    // finish magazine changes
    for (const [sid, at] of this.reloadBy) {
      if (wall < at) continue;
      this.reloadBy.delete(sid);
      const player = this.state.players.get(sid);
      if (player) player.ammo = gunOf(player.gunId).mag;
    }

    // fly server-only bullets and settle their hits
    this.processBullets(dt);

    // --- players: movement, hazards, hunger, loot, pets ---
    for (const [sessionId, player] of this.state.players) {
      const input = this.inputs.get(sessionId) || { dx: 0, dy: 0 };
      this.moveCharacter(player, input.dx, input.dy, this.moveSpeedOf(player, sessionId), dt);
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

      // passive regen after a quiet stretch (shop upgrade)
      const regen = this.upOf(player, 'reg');
      const hpMax = this.hpMaxOf(player);
      if (regen > 0 && wall - (this.lastHurtAt.get(sessionId) || 0) > 6000
        && (this.hpFloat.get(sessionId) ?? 0) < hpMax) {
        const hp = Math.min(hpMax, (this.hpFloat.get(sessionId) ?? player.hp) + regen * REGEN_PER_S * dt);
        this.hpFloat.set(sessionId, hp);
        player.hp = Math.round(hp);
      }

      // pet AI: circle the owner, gnaw the nearest zombie (server-computed)
      const pet = SHOP.pets[player.petId];
      if (pet && wall - (this.petCd.get(sessionId) || 0) > PET_CD_MS) {
        let target = null, targetD = 1e9;
        for (const [zid, zombie] of this.state.zombies) {
          const d = Math.hypot(zombie.x - player.x, zombie.y - player.y);
          if (d < targetD && d < PET_RADIUS) { targetD = d; target = { zid, zombie }; }
        }
        if (target) {
          this.petCd.set(sessionId, wall);
          const petDmg = Math.round(pet.dmg * (1 + 0.12 * this.upOf(player, 'ptr')));
          target.zombie.hp = Math.max(0, target.zombie.hp - petDmg);
          this.broadcast('system', { event: 'pet', sid: sessionId, x: target.zombie.x, y: target.zombie.y });
          if (target.zombie.hp <= 0) this.killZombie(target.zid, target.zombie, player, 'pet');
        }
      }

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
        const speed = Math.min(rules.zombieSpeed + this.state.world.wave * 3.5, 120) * this.diff.spd;
        const nx = (best.x - zombie.x) / bestD, ny = (best.y - zombie.y) / bestD;
        this.zombieMove(zombie, nx * speed * dt, ny * speed * dt);
      } else if (wall - (this.lastZombieHit.get(bestSid) || 0) > rules.zombieAttackMs) {
        this.lastZombieHit.set(bestSid, wall);
        this.damagePlayer(bestSid, rules.zombieDamage * this.diff.dmg);
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
    this.killZombie(zid, zombie, player, 'melee');
  }

  // one unified payout path for every cause: melee, bullet, pet, bomb
  killZombie(zid, zombie, player, cause) {
    this.state.zombies.delete(zid);
    this.zombieFarSince.delete(zid);
    player.kills = Math.min(255, player.kills + 1);

    // Đêm Xác Sống economy: coins + score per kill, scaled by difficulty
    const gold = this.upOf(player, 'gold') * 0.12;
    const coin = Math.max(1, Math.round(KILL_COIN * this.diff.coin * (1 + gold)));
    player.coin = Math.min(65535, player.coin + coin);
    player.score += Math.max(1, Math.round(KILL_SCORE * this.diff.coin));

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
      event: 'kill', name: player.name, drop: kind || '', cause, coin,
      x: zombie.x, y: zombie.y,
    });
  }

  // server-only projectile flight: bullets never sync, only damage does
  processBullets(dt) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      let dead = b.life <= 0;
      if (!dead) {
        for (const [zid, zombie] of this.state.zombies) {
          if (Math.hypot(zombie.x - b.x, zombie.y - b.y) > BULLET_RADIUS) continue;
          const shooter = this.state.players.get(b.pid);
          let dmg = b.dmg;
          if (shooter && Math.random() < 0.06 * this.upOf(shooter, 'crit')) {
            dmg *= 2; // crit shot (shop upgrade)
            this.pushFx('crit', b.x, b.y);
          }
          zombie.hp = Math.max(0, zombie.hp - Math.round(dmg));
          dead = true; // each bullet hits one zombie at most
          if (zombie.hp <= 0 && shooter) this.killZombie(zid, zombie, shooter, 'gun');
          break;
        }
      }
      if (dead) this.bullets.splice(i, 1);
    }
    if (this.bullets.length > 240) this.bullets.splice(0, this.bullets.length - 240);
  }

  startReload(sessionId, player, gun) {
    if (this.reloadBy.has(sessionId) || player.ammo >= gun.mag) return;
    const rl = gun.rl * (1 - 0.08 * this.upOf(player, 'rl'));
    this.reloadBy.set(sessionId, Date.now() + Math.round(rl * 1000));
    this.broadcast('system', { event: 'reload', sid: sessionId });
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
    amount *= 1 - 0.07 * this.upOf(player, 'arm'); // shop armor plate
    const hp = Math.max(0, (this.hpFloat.get(sessionId) ?? player.hp) - amount);
    this.hpFloat.set(sessionId, hp);
    this.lastHurtAt.set(sessionId, Date.now());
    if (hp > 0.5) {
      player.hp = Math.min(this.hpMaxOf(player), Math.round(hp));
      return;
    }
    // died — respawn, restore the body (but keep the backpack)
    const hpMax = this.hpMaxOf(player);
    this.hpFloat.set(sessionId, hpMax);
    player.hp = Math.min(255, hpMax);
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
    const cap = this.hpMaxOf(player);
    const hp = Math.min(cap, (this.hpFloat.get(sessionId) ?? player.hp) + amount);
    this.hpFloat.set(sessionId, hp);
    player.hp = Math.round(hp);
  }

  pushFx(kind, x, y) {
    this.broadcast('system', { event: 'fx', kind, x: Math.round(x), y: Math.round(y) });
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
    const hp = Math.round((26 + this.state.world.wave * 1.6) * this.diff.hp);
    const zombie = new Zombie({ hp: Math.min(255, hp) });
    zombie.x = Math.round(px);
    zombie.y = Math.round(py);
    this.state.zombies.set(id, zombie);
  }
}
