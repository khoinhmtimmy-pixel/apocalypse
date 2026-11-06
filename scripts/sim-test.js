// scripts/sim-test.js — headless checks for shared/sim.js.
// No Colyseus and no server: this is the same code the offline room runs.
import { readFileSync } from 'node:fs';
import {
  createWorld, addSurvivor, applyIntent, stepWorld, makePlainStore,
  HUNGER_MAX, HP_MAX, KILL_SCORE,
} from '../shared/sim.js';

let fails = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails++;
};

const STEP = 50;
const T0 = Date.parse('2026-01-01T00:00:00Z');

function boot(opts = {}) {
  const world = createWorld({
    mapId: opts.mapId || 'zombie_city',
    diff: opts.diff ?? 1,
    seed: opts.seed || 1234,
    store: makePlainStore(),
  });
  addSurvivor(world, { id: 'p1', name: 'tester' });
  return world;
}

// Run the sim for `seconds`, calling script(world, now, stepIndex) each tick.
function simulate(world, seconds, script) {
  const events = [];
  let now = T0;
  const steps = Math.round(seconds * 1000 / STEP);
  for (let i = 0; i < steps; i++) {
    now += STEP;
    if (script) script(world, now, i);
    events.push(...stepWorld(world, STEP, now).events);
  }
  return { events, now };
}

// 1. waves actually arrive
{
  const world = boot();
  simulate(world, 16);
  check('waves spawn zombies', world.world.wave >= 1 && world.zombies.size > 0,
    `wave=${world.world.wave} zombies=${world.zombies.size}`);
}

// 2. melee kill pays coins, score and broadcasts
{
  const world = boot();
  const p = world.players.get('p1');
  const coin0 = p.coin;
  world.zombies.set('ztest', world.store.zombie({ x: p.x + 20, y: p.y, hp: 10 }));
  const { events, now } = simulate(world, 0.2, (w, t, i) => {
    if (i === 0) applyIntent(w, 'p1', 'attack', { angle: 0, __now: t });
  });
  check('melee kill removes the zombie', !world.zombies.has('ztest'));
  check('melee kill pays coins', p.coin > coin0, `coin ${coin0}->${p.coin}`);
  check('melee kill pays score', p.score >= KILL_SCORE, `score=${p.score}`);
  check('kill event is emitted', events.some((e) => e.payload?.event === 'kill'));
}

// 3. the shop validates and debits
{
  const world = boot();
  const p = world.players.get('p1');
  p.coin = 500;
  applyIntent(world, 'p1', 'buy', { kind: 'up', key: 'mag' });
  check('upgrade debits coins', p.coin === 410, `coin=${p.coin}`);
  check('upgrade levels up', (p.up.get('mag') || 0) === 1);

  const poor = boot();
  const q = poor.players.get('p1');
  q.coin = 3;
  applyIntent(poor, 'p1', 'buy', { kind: 'gun', id: 5 });
  const { events } = simulate(poor, 0.1);
  check('unaffordable gun is rejected', q.coin === 3 && !q.own.get('5'), `coin=${q.coin}`);
  check('buyfail event is emitted', events.some((e) => e.payload?.event === 'buyfail'));
}

// 4. hunger drains
{
  const world = boot();
  simulate(world, 20);
  const p = world.players.get('p1');
  check('hunger drains over time', p.hunger < HUNGER_MAX, `hunger=${p.hunger}`);
}

// 5. zombies bite
{
  const world = boot();
  const p = world.players.get('p1');
  world.zombies.set('zbite', world.store.zombie({ x: p.x + 5, y: p.y, hp: 60 }));
  simulate(world, 3);
  check('zombies damage the survivor', p.hp < HP_MAX, `hp=${p.hp}`);
}

// 6. determinism: same seed + same intents => same run
{
  const script = (w, t, i) => {
    if (i % 10 === 0) {
      applyIntent(w, 'p1', 'input', { dx: Math.cos(i / 12), dy: Math.sin(i / 12) });
    }
    if (i % 12 === 0) applyIntent(w, 'p1', 'attack', { angle: i / 12, __now: t });
  };
  const a = boot({ seed: 777 });
  const b = boot({ seed: 777 });
  simulate(a, 30, script);
  simulate(b, 30, script);
  const pa = a.players.get('p1');
  const pb = b.players.get('p1');
  check('same seed keeps coin in sync', pa.coin === pb.coin, `${pa.coin} vs ${pb.coin}`);
  check('same seed keeps score in sync', pa.score === pb.score, `${pa.score} vs ${pb.score}`);
  check('same seed keeps kills in sync', pa.kills === pb.kills, `${pa.kills} vs ${pb.kills}`);
  check('same seed keeps positions in sync', pa.x === pb.x && pa.y === pb.y);
  check('same seed keeps the horde in sync', a.zombies.size === b.zombies.size,
    `${a.zombies.size} vs ${b.zombies.size}`);
}

// 7. host-independence: no server or Node imports, no wall-clock randomness
{
  const src = readFileSync(new URL('../shared/sim.js', import.meta.url), 'utf8');
  check('sim imports nothing from server/ or node:', !/from\s+['"](node:|.*server\/)/.test(src));
  check('sim uses the seeded rng, not Math.random', !/Math\.random/.test(src));
}

// 8. unsynced bookkeeping stays off the entity
{
  const world = boot();
  const p = world.players.get('p1');
  const keys = Object.keys(p);
  check('player exposes only synced fields',
    !keys.some((k) => /hpFloat|hungerFloat|lastAttack|lastShot|reloadAt/.test(k)),
    keys.join(','));
  check('per-player timers live in world.meta', world.meta.get('p1') != null);
}

if (fails) {
  console.error(`\n${fails} sim check(s) failed`);
  process.exit(1);
}
console.log('\nall sim checks passed');
