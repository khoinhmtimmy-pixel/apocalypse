// client/save.js — solo run persistence. Multiplayer rooms are untouched: their
// economy still resets with the room, this only remembers an offline run.
import { DIFFS } from '../shared/maps.js';

const KEY = 'doomdays.solo.v1';

export function loadRun() {
  try {
    const raw = localStorage.getItem(KEY);
    const run = raw ? JSON.parse(raw) : null;
    return run && run.v === 1 && run.player ? run : null;
  } catch { return null; }
}

export function saveRun(world) {
  const p = world?.players?.get('local');
  if (!p) return;
  const run = {
    v: 1,
    mapId: world.mapId,
    diff: Math.max(0, DIFFS.indexOf(world.diff)),
    seed: world.seed,
    at: Date.now(),
    player: {
      x: p.x, y: p.y, hp: p.hp, hunger: p.hunger,
      food: p.food, med: p.med, kills: p.kills, deaths: p.deaths,
      coin: p.coin, score: p.score, gunId: p.gunId, ammo: p.ammo,
      petId: p.petId, bombs: p.bombs, haste: p.haste,
    },
    up: [...p.up.entries()],
    own: [...p.own.entries()],
  };
  try { localStorage.setItem(KEY, JSON.stringify(run)); } catch { /* private mode */ }
}

export function clearRun() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
