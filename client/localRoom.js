// client/localRoom.js — a Colyseus-shaped room that runs the real simulation.
//
// The offline host. It exposes exactly the surface GameScene already uses
// (sessionId, send, onMessage, onAdd/onRemove, state) but there is no socket:
// shared/sim.js steps locally, with plain Maps and objects instead of schema.
import {
  createWorld, addSurvivor, applyIntent, stepWorld, makePlainStore,
} from '../shared/sim.js';
import { saveRun } from './save.js';

const SAVE_EVERY_MS = 10000;

export function createLocalSession({ mapId, diff = 1, seed, name, save } = {}) {
  const world = createWorld({
    mapId,
    diff,
    seed: seed || ((Date.now() ^ 0x5f3759df) & 0x7fffffff),
    store: makePlainStore(),
  });
  const sid = 'local';
  addSurvivor(world, { id: sid, name: name || 'solo' });
  if (save) restore(world, save);

  const subs = { add: {}, remove: {}, message: {}, leave: [] };
  const known = { players: new Set(), zombies: new Set(), drops: new Set(), fires: new Set() };

  const state = {
    mapId: world.mapId,
    players: world.players,
    zombies: world.zombies,
    drops: world.drops,
    fires: world.fires,
    world: world.world,
  };

  let lastMs = 0;
  let lastSave = 0;
  let stopped = false;

  function dispatch(type, payload) {
    for (const fn of subs.message[type] || []) fn(payload);
  }

  function diffCollections() {
    for (const field of Object.keys(known)) {
      const live = world[field];
      const seen = known[field];
      for (const id of live.keys()) {
        if (seen.has(id)) continue;
        seen.add(id);
        for (const fn of subs.add[field] || []) fn(live.get(id), id);
      }
      for (const id of [...seen]) {
        if (live.has(id)) continue;
        seen.delete(id);
        for (const fn of subs.remove[field] || []) fn(live.get(id), id);
      }
    }
  }

  const room = {
    sessionId: sid,
    state,

    send(type, data) {
      if (stopped) return;
      applyIntent(world, sid, type, data);
    },

    onMessage(type, fn) { (subs.message[type] ||= []).push(fn); },
    onAdd(field, fn) { (subs.add[field] ||= []).push(fn); },
    onRemove(field, fn) { (subs.remove[field] ||= []).push(fn); },
    onLeave(fn) { subs.leave.push(fn); },

    // Driven from GameScene.update: one fixed-ish step per frame, same clamp
    // the server applies (Math.min(deltaMs, 100) inside stepWorld).
    tick(nowMs) {
      if (stopped) return;
      if (!lastMs) { lastMs = nowMs; return; }
      const delta = Math.min(Math.max(nowMs - lastMs, 0), 100);
      lastMs = nowMs;
      if (delta <= 0) return;

      const { events } = stepWorld(world, delta, Date.now());
      for (const e of events) dispatch(e.type, e.payload);
      diffCollections();

      if (Date.now() - lastSave > SAVE_EVERY_MS) {
        lastSave = Date.now();
        saveRun(world);
      }
    },

    saveNow() { saveRun(world); },

    leave() {
      if (stopped) return;
      stopped = true;
      saveRun(world);
      for (const fn of subs.leave) fn(1000);
    },

    // test/debug hook
    get world() { return world; },
  };

  return room;
}

function restore(world, save) {
  const p = world.players.get('local');
  if (!p) return;
  const s = save.player || {};
  for (const k of ['x', 'y', 'hp', 'hunger', 'food', 'med', 'kills', 'deaths',
    'coin', 'score', 'gunId', 'ammo', 'petId', 'bombs', 'haste']) {
    if (Number.isFinite(s[k])) p[k] = s[k];
  }
  p.up.clear();
  for (const [k, v] of save.up || []) p.up.set(k, v);
  p.own.clear();
  for (const [k, v] of save.own || []) p.own.set(k, v);
  if (!p.own.get(String(p.gunId))) p.own.set('0', 1);

  const meta = world.meta.get('local');
  if (meta) { meta.hp = p.hp; meta.hunger = p.hunger; }
  if (Number.isFinite(s.x) && Number.isFinite(s.y)) { p.x = s.x; p.y = s.y; }
}
