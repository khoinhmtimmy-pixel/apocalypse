// shared/sim.js — the whole Doomdays simulation, host-agnostic.
//
// Both hosts run this exact code:
//   • server/SurvivalRoom.js — entities are Colyseus schema instances
//   • client/localRoom.js    — entities are plain objects and Maps
// The only thing that differs is the injected `store`, so offline and online
// play can never drift apart. Nothing here imports Colyseus or touches Node.
import {
  BIOMES, TILE_SIZE, CHUNK_TILES, SPAWNS, DIFFS,
  genChunkData, tileOf, isBlockedAt, isWallAt, heightAt,
} from './maps.js';
import { gunOf, SHOP } from './guns.js';

export const PLAYER_SPEED = 118;   // px/s baseline (up.spd + haste multiply)
export const HP_MAX = 100;
export const HUNGER_MAX = 100;
export const HUNGER_DRAIN = 0.38;      // hunger/s — a full belly lasts ~4.5 min
export const STARVING_DPS = 1.4;       // hp/s while hunger is empty
export const EAT_FOOD = 38;            // hunger restored per ration
export const EAT_HEAL = 8;             // hp restored per ration
export const MED_HEAL = 45;            // hp restored per medkit
export const FOOD_CAP = 9, MED_CAP = 5;
export const LOOT_PICKUP_MS = 1200;    // cooldown between scavenges
export const LOOT_RADIUS = 30;         // px
export const FIRE_CAP = 60;

// melee attack — [Space] / left-click swings
export const ATTACK_CD_MS = 450;       // swing cooldown per player
export const TAU = Math.PI * 2;
export const ATTACK_RANGE = 64;        // px reach from the attacker's center
export const ATTACK_HALF_ARC = 75 * Math.PI / 180;  // cone width is centered on the aim
export const ATTACK_DAMAGE = 40;       // one base zombie per swing
export const ATTACK_KNOCKBACK = 16;    // px the survivor knocks the zombie back
export const DROP_MED_CHANCE = 0.25;   // killed zombie drop rates
export const DROP_FOOD_CHANCE = 0.45;

// endless-map hygiene: idle far zombies stop chasing forever
export const ZOMBIE_LEASH_PX = 940;    // farther than this from every survivor...
export const ZOMBIE_LEASH_MS = 6000;   // ...for this long, and the zombie fades out

// Đêm Xác Sống port: kill payouts and combat helpers (difficulty-scaled)
export const KILL_COIN = 3;            // base coins per kill (× diff.coin)
export const KILL_SCORE = 12;
export const BULLET_RADIUS = 17;       // zombie hit radius vs bullets
export const PET_RADIUS = 300;         // pet supports from this distance
export const PET_CD_MS = 1300;
export const REGEN_PER_S = 0.6;        // per up.reg level, after 6s without damage

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Deterministic RNG: same seed + same intents => same run on either host.
export function mulberry32(seed) {
  let a = (Number(seed) | 0) || 1;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Field defaults shared by both stores (the schema mirrors these).
export function defaultPlayer() {
  return {
    name: 'survivor', x: 0, y: 0, angle: 0, hp: HP_MAX, hunger: HUNGER_MAX,
    food: 0, med: 0, kills: 0, deaths: 0,
    coin: 5, score: 0, gunId: SHOP.startGun, ammo: 0,
    petId: 0, bombs: 0, haste: 0,
    up: new Map(), own: new Map(),
  };
}

export function defaultWorldState() {
  return { wave: 0, temp: 21, cold: 15, toxin: 0, waterLevel: 0, clock: 0 };
}

const emptyDelta = () => ({
  added: { players: [], zombies: [], drops: [], fires: [] },
  removed: { players: [], zombies: [], drops: [], fires: [] },
});

// ------------------------------------------------------------------- world ---

export function createWorld(options = {}) {
  const store = options.store;
  const mapId = BIOMES[options.mapId] ? options.mapId : 'zombie_city';
  const biome = BIOMES[mapId];
  const diff = DIFFS[clamp(Number(options.diff) | 0, 0, DIFFS.length - 1)] || DIFFS[1];
  const seed = (Number(options.seed) | 0) || 1;
  const collections = store.collections();

  const world = {
    mapId, biome, rules: biome.rules, diff, store, seed,
    rng: mulberry32(seed),

    players: collections.players,
    zombies: collections.zombies,
    drops: collections.drops,
    fires: collections.fires,
    world: collections.world,

    meta: new Map(),        // sessionId -> unsynced per-player bookkeeping
    zombieFar: new Map(),   // zombieId -> ms since it left everyone's reach
    looted: new Set(),      // chunk loot spot keys already scavenged
    firesSeeded: new Set(), // chunk keys whose fire seeds were released
    pendingMeteors: [],     // {x, y, at}
    bullets: [],            // server-only projectiles {x,y,vx,vy,life,pid,gun,dmg}
    events: [],             // {type, payload} queue, drained by the host
    delta: emptyDelta(),    // entities added/removed during the last step

    simTime: 0,
    spawnCursor: 0,
    seq: { zombie: 0, drop: 0, fire: 0 },
    waveTimer: biome.rules.waveInterval ?? 0,
    meteorTimer: biome.rules.meteorIntervalMs ? biome.rules.meteorIntervalMs / 2 : 0,
    waterLevel: 0,
    waterCapAnnounced: false,
  };

  world.world.temp = biome.frost ? biome.rules.coldMax : 21;
  world.world.cold = biome.frost ? biome.rules.coldMax : 15;
  return world;
}

function emit(world, type, payload) {
  world.events.push({ type, payload });
}

function put(world, kind, id, entity) {
  world[kind].set(id, entity);
  world.delta.added[kind].push(id);
  return entity;
}

function remove(world, kind, id) {
  if (!world[kind].has(id)) return;
  world[kind].delete(id);
  world.delta.removed[kind].push(id);
}

function metaOf(world, sid) {
  let m = world.meta.get(sid);
  if (!m) {
    m = {
      hp: HP_MAX, hunger: HUNGER_MAX,
      input: { dx: 0, dy: 0 },
      lastZombieHit: 0, lastLoot: 0, lastAttack: 0, lastShot: 0,
      reloadAt: 0, lastHurt: 0, hasteUntil: 0, petAt: 0,
    };
    world.meta.set(sid, m);
  }
  return m;
}

// derived stats from the selected difficulty + shop upgrades
export function upOf(player, key) {
  return player?.up?.get(String(key)) || 0;
}

export function hpMaxOf(player) {
  return HP_MAX + upOf(player, 'hp') * 20;
}

export function moveSpeedOf(world, player, sid, nowMs) {
  let spd = PLAYER_SPEED * (1 + 0.07 * upOf(player, 'spd'));
  if (nowMs < (metaOf(world, sid).hasteUntil || 0)) spd *= SHOP.haste.mul;
  return spd;
}

// ----------------------------------------------------------------- players ---

export function findSpawnSpot(world) {
  for (let n = 0; n < SPAWNS.length; n++) {
    const s = SPAWNS[(world.spawnCursor + n) % SPAWNS.length];
    const px = (s.tx + 0.5) * TILE_SIZE, py = (s.ty + 0.5) * TILE_SIZE;
    if (!isBlockedAt(world.mapId, px, py, world.waterLevel)) {
      world.spawnCursor = (world.spawnCursor + n + 1) % SPAWNS.length;
      return { px, py };
    }
  }
  return { px: 24 * TILE_SIZE, py: 24 * TILE_SIZE };
}

export function addSurvivor(world, { id, name } = {}) {
  const clean = String(name || 'survivor').trim().slice(0, 12) || 'survivor';
  const spot = findSpawnSpot(world);

  const player = world.store.player({ name: clean, hp: HP_MAX, hunger: HUNGER_MAX });
  player.name = clean;
  player.hp = HP_MAX;
  player.hunger = HUNGER_MAX;
  player.x = Math.round(spot.px);
  player.y = Math.round(spot.py);
  player.own.set(String(SHOP.startGun), 1);
  player.ammo = gunOf(SHOP.startGun).mag;
  put(world, 'players', id, player);

  const m = metaOf(world, id);
  m.hp = HP_MAX;
  m.hunger = HUNGER_MAX;

  emit(world, 'chat', { from: '☠ doom', text: `${clean} joined the wasteland` });
  return player;
}

export function removeSurvivor(world, id) {
  const player = world.players.get(id);
  if (player) emit(world, 'chat', { from: '☠ doom', text: `${player.name} was lost` });
  remove(world, 'players', id);
  world.meta.delete(id);
}

// ---------------------------------------------------------------- intents ----

export function applyIntent(world, sid, type, data) {
  const player = world.players.get(sid);
  if (!player) return;
  const m = metaOf(world, sid);
  const now = Number(data?.__now) || Date.now();

  switch (type) {
    case 'equip': return equipGun(world, sid, Number(data?.gun) | 0);
    case 'shoot': return intentShoot(world, sid, player, m, data, now);
    case 'reload': return startReload(world, sid, player, gunOf(player.gunId), now);

    case 'buy': return intentBuy(world, sid, player, m, data, now);

    case 'bomb': {
      if (player.bombs <= 0) return;
      player.bombs--;
      const r = SHOP.bombs.radius;
      let hits = 0;
      for (const [zid, zombie] of world.zombies) {
        if (Math.hypot(zombie.x - player.x, zombie.y - player.y) < r) {
          hits++;
          killZombie(world, zid, zombie, player, 'bomb');
        }
      }
      emit(world, 'system', { event: 'bomb', x: player.x, y: player.y, hits });
      return;
    }

    case 'haste': {
      if (player.haste <= 0) return;
      if (now < (m.hasteUntil || 0)) return;
      player.haste--;
      m.hasteUntil = now + SHOP.haste.ms;
      emit(world, 'system', { event: 'haste', name: player.name });
      return;
    }

    case 'input': {
      m.input.dx = clamp(Number(data?.dx) || 0, -1, 1);
      m.input.dy = clamp(Number(data?.dy) || 0, -1, 1);
      return;
    }

    case 'chat': {
      const text = String(data?.text || '').slice(0, 140).trim();
      if (!text) return;
      emit(world, 'chat', { from: player.name, text });
      return;
    }

    case 'eat': {
      if (player.food <= 0) return;
      if (player.hunger > HUNGER_MAX - 5) return;          // already fed
      player.food--;
      m.hunger = Math.min(HUNGER_MAX, (m.hunger ?? HUNGER_MAX) + EAT_FOOD);
      player.hunger = Math.round(m.hunger);
      healPlayer(world, sid, EAT_HEAL);
      emit(world, 'system', { event: 'ate', name: player.name });
      return;
    }

    case 'heal': {
      if (player.med <= 0) return;
      if (player.hp > HP_MAX - 10) return;                 // healthy enough
      player.med--;
      healPlayer(world, sid, MED_HEAL);
      emit(world, 'system', { event: 'healed', name: player.name });
      return;
    }

    case 'attack': return intentAttack(world, sid, player, m, data, now);
    default: return;
  }
}

function equipGun(world, sid, id) {
  const player = world.players.get(sid);
  if (!player) return false;
  if (!player.own.get(String(id))) return false;
  if (player.gunId === id) return true;
  player.gunId = id;
  player.ammo = gunOf(id).mag;
  metaOf(world, sid).reloadAt = 0;
  return true;
}

function intentShoot(world, sid, player, m, data, now) {
  const gun = gunOf(player.gunId);
  const cdMs = gun.cd * 1000 * (1 - 0.06 * upOf(player, 'rate'));
  if (now - (m.lastShot || 0) < cdMs) return;
  if (m.reloadAt) return;
  if (player.ammo <= 0) { startReload(world, sid, player, gun, now); return; }

  m.lastShot = now;
  player.ammo = Math.max(0, player.ammo - 1);

  let aim = Number(data?.angle);
  if (!Number.isFinite(aim)) aim = (player.angle / 255) * TAU;
  for (let i = 0; i < gun.pel; i++) {
    // per-pellet fan (shotguns) plus a touch of per-bullet jitter
    const a = aim + (i - (gun.pel - 1) / 2) * Math.max(gun.spr, 0.09)
      + (world.rng() - 0.5) * gun.spr * 0.5;
    world.bullets.push({
      x: player.x, y: player.y,
      vx: Math.cos(a) * gun.v, vy: Math.sin(a) * gun.v,
      life: gun.life, pid: sid, gun: player.gunId,
      dmg: gun.dmg * (1 + 0.15 * upOf(player, 'dmg')),
    });
  }
  if (player.ammo <= 0) startReload(world, sid, player, gun, now);
  emit(world, 'shot', {
    sid, x: player.x, y: player.y, angle: aim,
    gun: player.gunId, n: gun.pel, spr: gun.spr, v: gun.v, life: gun.life,
  });
}

function intentBuy(world, sid, player, m, data, now) {
  const kind = String(data?.kind || '');
  let ok = false, text = '';

  if (kind === 'gun' || kind === 'equip') {
    const gun = gunOf(Number(data?.id) | 0);
    if (kind === 'equip') {
      if (player.own.get(String(gun.id)) && gun.id !== player.gunId) {
        equipGun(world, sid, gun.id);
        ok = true; text = `Equipped ${gun.name}`;
      }
    } else if (!player.own.get(String(gun.id)) && player.coin >= gun.price) {
      player.coin -= gun.price;
      player.own.set(String(gun.id), 1);
      player.gunId = gun.id;
      player.ammo = gun.mag;
      m.reloadAt = 0;
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
        if (def.key === 'hp') healPlayer(world, sid, 20 * (lvl + 1));
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
  emit(world, 'system', { event: ok ? 'bought' : 'buyfail', text, sid });
}

function intentAttack(world, sid, player, m, data, now) {
  if (now - (m.lastAttack || 0) < ATTACK_CD_MS) return;
  m.lastAttack = now;

  let aim = Number(data?.angle);
  if (!Number.isFinite(aim)) aim = (player.angle / 255) * TAU; // fall back to facing
  aim = ((aim % TAU) + TAU) % TAU;

  emit(world, 'system', {
    event: 'swing', sid,
    angle: Math.round(aim * 255 / TAU), x: player.x, y: player.y,
  });

  for (const [zid, zombie] of world.zombies) {
    const dx = zombie.x - player.x, dy = zombie.y - player.y;
    if (Math.hypot(dx, dy) > ATTACK_RANGE) continue;
    let off = Math.abs(Math.atan2(dy, dx) - aim);
    off = Math.min(off, TAU - off);
    if (off > ATTACK_HALF_ARC) continue;
    hitZombie(world, zid, zombie, player);
  }
}

// --------------------------------------------------------------- step loop ---

export function stepWorld(world, dtMs, nowMs) {
  const dt = Math.min(dtMs, 100) / 1000; // seconds
  const wall = Number(nowMs) || Date.now();
  const rules = world.rules;

  world.delta = emptyDelta();
  world.simTime += dt;
  world.world.clock = Math.floor(world.simTime);

  // --- environmental scalars (one authoritative value per hazard) ---
  if (world.biome.flooded) {
    world.waterLevel = Math.min(rules.waterCap ?? 0.90, world.waterLevel + rules.waterRate * dt);
    world.world.waterLevel = Math.round(world.waterLevel * 1000) / 1000;
    if (!world.waterCapAnnounced && world.waterLevel >= (rules.waterCap ?? 0.90)) {
      world.waterCapAnnounced = true;
      emit(world, 'chat', {
        from: '☠ doom',
        text: 'The flood has reached its peak. The highland islands stay dry — hop them forever.',
      });
    }
  }
  if (world.biome.heat) {
    world.world.temp = Math.round(
      (rules.heatMin + (rules.heatMax - rules.heatMin) *
        (0.5 + 0.5 * Math.sin(2 * Math.PI * world.simTime / (rules.heatPeriodMs / 1000)))) * 10) / 10;
  }
  if (world.biome.frost) {
    world.world.cold = Math.round(
      (rules.coldMin + (rules.coldMax - rules.coldMin) *
        (0.5 + 0.5 * Math.sin(2 * Math.PI * world.simTime / (rules.coldPeriodMs / 1000)))) * 10) / 10;
  }
  if (world.biome.toxic) {
    world.world.toxin = Math.round(
      (0.5 + 0.5 * Math.sin(2 * Math.PI * world.simTime / (rules.toxinPeriodMs / 1000))) * 100) / 100;
  }

  // --- zombie waves (zombie biomes) ---
  if (world.biome.zombies) {
    world.waveTimer += dtMs;
    const waveEvery = (rules.waveInterval || 12000) * world.diff.waves;
    if (world.waveTimer >= waveEvery) {
      world.waveTimer -= waveEvery;
      world.world.wave++;
      const players = world.players.size;
      const budget = Math.min(rules.maxZombies - world.zombies.size,
        Math.min(1 + world.world.wave, 5) * (players > 0 ? 1 : 0));
      for (let i = 0; i < budget; i++) spawnZombie(world, wall);
      if (budget > 0) emit(world, 'system', { event: 'wave', wave: world.world.wave });
    }
  }

  // --- meteor bombardment (meteor_fall) ---
  if (world.biome.meteors && world.players.size > 0) {
    world.meteorTimer += dtMs;
    if (world.meteorTimer >= rules.meteorIntervalMs) {
      world.meteorTimer = 0;
      const playersArr = [...world.players.values()];
      const t = playersArr[Math.floor(world.rng() * playersArr.length)];
      const px = Math.round(t.x + (world.rng() - 0.5) * 520);
      const py = Math.round(t.y + (world.rng() - 0.5) * 520);
      world.pendingMeteors.push({ x: px, y: py, at: wall + rules.meteorLeadMs });
      emit(world, 'system', { event: 'meteor', x: px, y: py });
    }
  }
  for (let i = world.pendingMeteors.length - 1; i >= 0; i--) {
    const m = world.pendingMeteors[i];
    if (wall < m.at) continue;
    world.pendingMeteors.splice(i, 1);
    emit(world, 'system', { event: 'impact', x: m.x, y: m.y });
    for (const [sid, player] of world.players) {
      if (Math.hypot(player.x - m.x, player.y - m.y) < rules.meteorRadius) {
        damagePlayer(world, sid, rules.meteorDamage, wall);
      }
    }
    addFire(world, m.x, m.y);
  }

  // finish magazine changes
  for (const [sid, m] of world.meta) {
    if (!m.reloadAt || wall < m.reloadAt) continue;
    m.reloadAt = 0;
    const player = world.players.get(sid);
    if (player) player.ammo = gunOf(player.gunId).mag;
  }

  // fly server-only bullets and settle their hits
  processBullets(world, dt);

  // --- players: movement, hazards, hunger, loot, pets ---
  for (const [sessionId, player] of world.players) {
    const m = metaOf(world, sessionId);
    const input = m.input;

    moveCharacter(world, player, input.dx, input.dy, moveSpeedOf(world, player, sessionId, wall), dt);
    if (input.dx || input.dy) {
      player.angle = clamp(Math.round(((Math.atan2(input.dy, input.dx) / TAU) * 255) % 256), 0, 255);
    }

    // hunger drains no matter what; an empty belly burns health
    const hung = Math.max(0, (m.hunger ?? HUNGER_MAX) - HUNGER_DRAIN * dt);
    m.hunger = hung;
    player.hunger = Math.round(hung);

    let dps = 0;
    if (hung <= 0) dps = Math.max(dps, STARVING_DPS);

    if (world.biome.flooded) {
      const t = tileOf(player.x, player.y);
      if (heightAt(world.mapId, t.tx, t.ty) < world.waterLevel * 255) {
        dps = Math.max(dps, rules.submergedDps);
      }
    }
    if (world.biome.heat) {
      const temp = world.world.temp;
      if (temp > rules.heatDamageTemp && !inSafeZone(world, player, 'shade')) {
        dps = Math.max(dps, (temp - rules.heatDamageTemp) * rules.heatDamageScale);
      }
    }
    if (world.biome.frost) {
      const cold = world.world.cold;
      if (cold < rules.freezeTemp && !inSafeZone(world, player, 'campfire')) {
        dps = Math.max(dps, (rules.freezeTemp - cold) * rules.coldScale);
      }
    }
    if (world.biome.toxic) {
      if (world.world.toxin > rules.toxinThreshold && !inSafeZone(world, player, 'dome')) {
        dps = Math.max(dps, rules.toxinDps);
      }
    }

    // wildfires burn everyone nearby
    for (const fire of world.fires.values()) {
      const r = Math.min(rules.maxFireRadiusTiles ?? 0, (rules.fireGrowth ?? 0) * (world.simTime - fire.born));
      if (r > 0 && Math.hypot(player.x - fire.x, player.y - fire.y) < r * TILE_SIZE) {
        dps = Math.max(dps, rules.fireDps ?? 6);
        break;
      }
    }

    if (dps > 0) damagePlayer(world, sessionId, dps * dt, wall);

    // passive regen after a quiet stretch (shop upgrade)
    const regen = upOf(player, 'reg');
    const hpMax = hpMaxOf(player);
    if (regen > 0 && wall - (m.lastHurt || 0) > 6000 && (m.hp ?? 0) < hpMax) {
      const hp = Math.min(hpMax, (m.hp ?? player.hp) + regen * REGEN_PER_S * dt);
      m.hp = hp;
      player.hp = Math.round(hp);
    }

    // pet AI: circle the owner, gnaw the nearest zombie (host-computed)
    const pet = SHOP.pets[player.petId];
    if (pet && wall - (m.petAt || 0) > PET_CD_MS) {
      let target = null, targetD = 1e9;
      for (const [zid, zombie] of world.zombies) {
        const d = Math.hypot(zombie.x - player.x, zombie.y - player.y);
        if (d < targetD && d < PET_RADIUS) { targetD = d; target = { zid, zombie }; }
      }
      if (target) {
        m.petAt = wall;
        const petDmg = Math.round(pet.dmg * (1 + 0.12 * upOf(player, 'ptr')));
        target.zombie.hp = Math.max(0, target.zombie.hp - petDmg);
        emit(world, 'system', { event: 'pet', sid: sessionId, x: target.zombie.x, y: target.zombie.y });
        if (target.zombie.hp <= 0) killZombie(world, target.zid, target.zombie, player, 'pet');
      }
    }

    ensureChunkFires(world, player);

    // scavenge: automatic pickup when walking onto a supply crate
    if (wall - (m.lastLoot || 0) > LOOT_PICKUP_MS) {
      tryLoot(world, sessionId, player, wall);
    }
  }

  // --- zombies: target nearest player, chase, bite; fade out far strays ---
  for (const [zid, zombie] of world.zombies) {
    let best = null, bestSid = null, bestD = 1e9;
    for (const [sid, player] of world.players) {
      const d = Math.hypot(player.x - zombie.x, player.y - zombie.y);
      if (d < bestD) { bestD = d; best = player; bestSid = sid; }
    }
    if (!best) continue;

    // endless-map leash: out of everyone's reach long enough => despawn
    if (bestD > ZOMBIE_LEASH_PX) {
      const since = world.zombieFar.get(zid) || wall;
      world.zombieFar.set(zid, since);
      if (wall - since > ZOMBIE_LEASH_MS) {
        remove(world, 'zombies', zid);
        world.zombieFar.delete(zid);
        continue;
      }
    } else if (world.zombieFar.has(zid)) {
      world.zombieFar.delete(zid);
    }

    if (bestD > rules.zombieContact) {
      const speed = Math.min(rules.zombieSpeed + world.world.wave * 3.5, 120) * world.diff.spd;
      const nx = (best.x - zombie.x) / bestD, ny = (best.y - zombie.y) / bestD;
      const step = speed * dt;
      if (!zombieMove(world, zombie, nx * step, ny * step)) {
        // wedged on a building corner: follow the wall instead of freezing
        const side = wallSide(zid);
        const sx = -ny * side, sy = nx * side;
        if (!zombieMove(world, zombie, sx * step, sy * step)) {
          zombieMove(world, zombie, -sx * step, -sy * step);
        }
      }
    } else if (wall - (metaOf(world, bestSid).lastZombieHit || 0) > rules.zombieAttackMs) {
      const bm = metaOf(world, bestSid);
      bm.lastZombieHit = wall;
      damagePlayer(world, bestSid, rules.zombieDamage * world.diff.dmg, wall);
      // small knockback separated from the player
      const nx = zombie.x - best.x, ny = zombie.y - best.y;
      const nd = Math.max(1, Math.hypot(nx, ny));
      zombieMove(world, zombie, nx / nd * 6, ny / nd * 6);
    }
  }

  const events = world.events.splice(0, world.events.length);
  return { events, added: world.delta.added, removed: world.delta.removed };
}

// ---------------------------------------------------------- zone checks ------

// Chunk-local scan of the 3×3 chunks around a player.
export function inSafeZone(world, player, kind) {
  const t = tileOf(player.x, player.y);
  const xc = Math.floor(t.tx / CHUNK_TILES), yc = Math.floor(t.ty / CHUNK_TILES);
  for (let cy = yc - 1; cy <= yc + 1; cy++) {
    for (let cx = xc - 1; cx <= xc + 1; cx++) {
      for (const z of genChunkData(world.mapId, cx, cy).safeZones) {
        if (z.kind !== kind) continue;
        if (Math.hypot(player.x - (z.x + .5) * TILE_SIZE,
          player.y - (z.y + .5) * TILE_SIZE) < z.r * TILE_SIZE) return true;
      }
    }
  }
  return false;
}

function tryLoot(world, sessionId, player, now) {
  const t = tileOf(player.x, player.y);
  const xc = Math.floor(t.tx / CHUNK_TILES), yc = Math.floor(t.ty / CHUNK_TILES);

  // scavengable crates generated into the endless chunks
  for (let cy = yc - 1; cy <= yc + 1; cy++) {
    for (let cx = xc - 1; cx <= xc + 1; cx++) {
      const chunk = genChunkData(world.mapId, cx, cy);
      for (let i = 0; i < chunk.lootSpots.length; i++) {
        const s = chunk.lootSpots[i];
        const key = `${cx}:${cy}:${i}`;
        if (world.looted.has(key)) continue;
        if (Math.hypot(player.x - (s.wtx + .5) * TILE_SIZE,
          player.y - (s.wty + .5) * TILE_SIZE) > LOOT_RADIUS) continue;

        grantLoot(world, sessionId, player, s.kind, now);
        world.looted.add(key);
        // everyone (including late joiners) must hide this crate sprite
        emit(world, 'looted', { keys: [key] });
        return;
      }
    }
  }

  // dynamic drops left behind by defeated zombies
  for (const [did, drop] of world.drops) {
    if (Math.hypot(player.x - drop.x, player.y - drop.y) > LOOT_RADIUS) continue;
    grantLoot(world, sessionId, player, drop.kind, now);
    remove(world, 'drops', did);
    return;
  }
}

function grantLoot(world, sessionId, player, kind, now) {
  metaOf(world, sessionId).lastLoot = now;
  const amount = kind === 'food' && world.rng() < 0.4 ? 2 : 1;
  if (kind === 'food') player.food = Math.min(FOOD_CAP, player.food + amount);
  else player.med = Math.min(MED_CAP, player.med + 1);
  emit(world, 'system', { event: 'loot', name: player.name, kind, amount });
}

// -------------------------------------------------------------- combat -------

export function hitZombie(world, zid, zombie, player) {
  const hp = Math.max(0, zombie.hp - ATTACK_DAMAGE);
  zombie.hp = hp;
  // knockback pushes the zombie away from the attacker
  const ang = Math.atan2(zombie.y - player.y, zombie.x - player.x);
  zombieMove(world, zombie, Math.cos(ang) * ATTACK_KNOCKBACK, Math.sin(ang) * ATTACK_KNOCKBACK);
  if (hp > 0) return;
  killZombie(world, zid, zombie, player, 'melee');
}

// one unified payout path for every cause: melee, bullet, pet, bomb
export function killZombie(world, zid, zombie, player, cause) {
  remove(world, 'zombies', zid);
  world.zombieFar.delete(zid);
  player.kills = Math.min(255, player.kills + 1);

  // Đêm Xác Sống economy: coins + score per kill, scaled by difficulty
  const gold = upOf(player, 'gold') * 0.12;
  const coin = Math.max(1, Math.round(KILL_COIN * world.diff.coin * (1 + gold)));
  player.coin = Math.min(65535, player.coin + coin);
  player.score += Math.max(1, Math.round(KILL_SCORE * world.diff.coin));

  const roll = world.rng();
  const kind = roll < DROP_MED_CHANCE ? 'med' : roll < DROP_MED_CHANCE + DROP_FOOD_CHANCE ? 'food' : null;
  if (kind) {
    const id = 'd' + (++world.seq.drop);
    const drop = world.store.drop({
      x: Math.round(zombie.x + (world.rng() - 0.5) * 22),
      y: Math.round(zombie.y + (world.rng() - 0.5) * 22),
      kind,
    });
    put(world, 'drops', id, drop);
  }
  emit(world, 'system', {
    event: 'kill', name: player.name, drop: kind || '', cause, coin,
    x: zombie.x, y: zombie.y,
  });
}

// host-only projectile flight: bullets never sync, only damage does
function processBullets(world, dt) {
  for (let i = world.bullets.length - 1; i >= 0; i--) {
    const b = world.bullets[i];
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    let dead = b.life <= 0;
    if (!dead) {
      for (const [zid, zombie] of world.zombies) {
        if (Math.hypot(zombie.x - b.x, zombie.y - b.y) > BULLET_RADIUS) continue;
        const shooter = world.players.get(b.pid);
        let dmg = b.dmg;
        if (shooter && world.rng() < 0.06 * upOf(shooter, 'crit')) {
          dmg *= 2; // crit shot (shop upgrade)
          pushFx(world, 'crit', b.x, b.y);
        }
        zombie.hp = Math.max(0, zombie.hp - Math.round(dmg));
        dead = true; // each bullet hits one zombie at most
        if (zombie.hp <= 0 && shooter) killZombie(world, zid, zombie, shooter, 'gun');
        break;
      }
    }
    if (dead) world.bullets.splice(i, 1);
  }
  if (world.bullets.length > 240) world.bullets.splice(0, world.bullets.length - 240);
}

function startReload(world, sessionId, player, gun, now) {
  const m = metaOf(world, sessionId);
  if (m.reloadAt || player.ammo >= gun.mag) return;
  const rl = gun.rl * (1 - 0.08 * upOf(player, 'rl'));
  m.reloadAt = now + Math.round(rl * 1000);
  emit(world, 'system', { event: 'reload', sid: sessionId });
}

// ------------------------------------------------------------------ fire -----

function addFire(world, px, py) {
  const id = 'f' + (++world.seq.fire);
  const fire = world.store.fire({ x: Math.round(px), y: Math.round(py), born: Math.floor(world.simTime) });
  put(world, 'fires', id, fire);
  trimFires(world);
}

// Release the deterministic fire seeds of chunks survivors actually visit.
function ensureChunkFires(world, player) {
  if (!world.biome.heat) return;
  const t = tileOf(player.x, player.y);
  const xc = Math.floor(t.tx / CHUNK_TILES), yc = Math.floor(t.ty / CHUNK_TILES);
  for (let cy = yc - 1; cy <= yc + 1; cy++) {
    for (let cx = xc - 1; cx <= xc + 1; cx++) {
      const ckey = `${cx}:${cy}`;
      if (world.firesSeeded.has(ckey)) continue;
      world.firesSeeded.add(ckey);
      for (const seed of genChunkData(world.mapId, cx, cy).fireSeeds) {
        addFire(world, (seed.wtx + .5) * TILE_SIZE, (seed.wty + .5) * TILE_SIZE);
      }
    }
  }
}

function trimFires(world) {
  if (world.fires.size <= FIRE_CAP) return;
  // remove the fires farthest from every player
  let worst = null, worstKey = null, worstD = -1;
  for (const [id, fire] of world.fires) {
    let d = 1e18;
    for (const p of world.players.values()) {
      d = Math.min(d, Math.hypot(p.x - fire.x, p.y - fire.y));
    }
    if (d > worstD) { worstD = d; worst = fire; worstKey = id; }
  }
  if (worst && worstD > 1500) remove(world, 'fires', worstKey);
}

// ------------------------------------------------------------- movement ------

function moveCharacter(world, char, dx, dy, speed, dt) {
  if (dx === 0 && dy === 0) return false;
  const len = Math.hypot(dx, dy);
  const vx = dx / len * speed * dt, vy = dy / len * speed * dt;
  let moved = false;
  if (!isBlockedAt(world.mapId, char.x + vx, char.y, world.waterLevel)) { char.x = Math.round(char.x + vx); moved = true; }
  if (!isBlockedAt(world.mapId, char.x, char.y + vy, world.waterLevel)) { char.y = Math.round(char.y + vy); moved = true; }
  return moved;
}

function zombieMove(world, zombie, vx, vy) {
  const nx = zombie.x + vx, ny = zombie.y + vy;
  let moved = false;
  if (!isWallAt(world.mapId, nx, zombie.y)) { zombie.x = Math.round(nx); moved = true; }
  if (!isWallAt(world.mapId, zombie.x, ny)) { zombie.y = Math.round(ny); moved = true; }
  return moved;
}

// Which way a zombie steps around a building corner. Picked per zombie so a
// horde piling on one facade spreads out instead of shoving on one point.
function wallSide(zid) {
  const n = parseInt(String(zid).slice(1), 10);
  return (Number.isFinite(n) ? n : 0) % 2 ? 1 : -1;
}

// ------------------------------------------------------------ life/death -----

export function damagePlayer(world, sessionId, amount, nowMs) {
  if (amount <= 0) return;
  const player = world.players.get(sessionId);
  if (!player) return;
  const m = metaOf(world, sessionId);
  amount *= 1 - 0.07 * upOf(player, 'arm'); // shop armor plate
  const hp = Math.max(0, (m.hp ?? player.hp) - amount);
  m.hp = hp;
  m.lastHurt = nowMs;
  if (hp > 0.5) {
    player.hp = Math.min(hpMaxOf(player), Math.round(hp));
    return;
  }
  // died — respawn, restore the body (but keep the backpack)
  const hpMax = hpMaxOf(player);
  m.hp = hpMax;
  player.hp = Math.min(255, hpMax);
  m.hunger = HUNGER_MAX;
  player.hunger = HUNGER_MAX;
  player.deaths = Math.min(255, player.deaths + 1);
  const spot = findSpawnSpot(world);
  player.x = Math.round(spot.px);
  player.y = Math.round(spot.py);
  m.lastZombieHit = nowMs; // brief grace period
  emit(world, 'system', { event: 'died', name: player.name });
}

export function healPlayer(world, sessionId, amount) {
  const player = world.players.get(sessionId);
  if (!player) return;
  const m = metaOf(world, sessionId);
  const cap = hpMaxOf(player);
  const hp = Math.min(cap, (m.hp ?? player.hp) + amount);
  m.hp = hp;
  player.hp = Math.round(hp);
}

function pushFx(world, kind, x, y) {
  emit(world, 'system', { event: 'fx', kind, x: Math.round(x), y: Math.round(y) });
}

// ------------------------------------------------------------- zombies -------

function spawnZombie(world, nowMs) {
  // gather nest sites from the chunks around one random player
  const playersArr = [...world.players.values()];
  if (!playersArr.length) return;
  const anchor = playersArr[Math.floor(world.rng() * playersArr.length)];
  const t = tileOf(anchor.x, anchor.y);
  const xc = Math.floor(t.tx / CHUNK_TILES), yc = Math.floor(t.ty / CHUNK_TILES);

  let best = null, bestD = -1;
  for (let cy = yc - 1; cy <= yc + 1; cy++) {
    for (let cx = xc - 1; cx <= xc + 1; cx++) {
      for (const nest of genChunkData(world.mapId, cx, cy).nests) {
        const nx = (nest.wtx + .5) * TILE_SIZE, ny = (nest.wty + .5) * TILE_SIZE;
        let d = 1e9;
        for (const p of world.players.values()) {
          d = Math.min(d, Math.hypot(p.x - nx, p.y - ny));
        }
        if (d > bestD) { bestD = d; best = { nx, ny }; }
      }
    }
  }
  if (!best) { // fallback: haunt a player from a short distance out
    const ang = world.rng() * Math.PI * 2;
    best = { nx: anchor.x + Math.cos(ang) * 7 * TILE_SIZE, ny: anchor.y + Math.sin(ang) * 7 * TILE_SIZE };
  }

  // jitter around the nest center, off walls
  let px = best.nx, py = best.ny;
  for (let k = 0; k < 6; k++) {
    const jx = px + (world.rng() - 0.5) * 2.5 * TILE_SIZE;
    const jy = py + (world.rng() - 0.5) * 2.5 * TILE_SIZE;
    if (!isWallAt(world.mapId, jx, jy)) { px = jx; py = jy; break; }
  }

  const id = 'z' + (++world.seq.zombie);
  const hp = Math.round((26 + world.world.wave * 1.6) * world.diff.hp);
  const zombie = world.store.zombie({ hp: Math.min(255, hp) });
  zombie.x = Math.round(px);
  zombie.y = Math.round(py);
  put(world, 'zombies', id, zombie);
}

// ---------------------------------------------------------- plain store ------

// Default store for hosts that want plain objects and Maps (the browser, tests).
export function makePlainStore() {
  return {
    collections: () => ({
      players: new Map(),
      zombies: new Map(),
      drops: new Map(),
      fires: new Map(),
      world: defaultWorldState(),
    }),
    player: (init) => Object.assign(defaultPlayer(), init || {}),
    zombie: (init) => Object.assign({ x: 0, y: 0, hp: 30 }, init || {}),
    drop: (init) => Object.assign({ x: 0, y: 0, kind: 'food' }, init || {}),
    fire: (init) => Object.assign({ x: 0, y: 0, born: 0 }, init || {}),
  };
}
