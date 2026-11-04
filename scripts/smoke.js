// scripts/smoke.js — headless verification: joins every biome, moves, checks
// shared-room matchmaking (filterBy) and hazard scalars moving.
import { Client } from '@colyseus/sdk';

const URL = process.env.SERVER_URL || 'http://localhost:2567';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const Results = { passed: 0, failed: 0 };
function check(label, ok, extra = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  ok ? Results.passed++ : Results.failed++;
}

async function join(name, mapId) {
  const client = new Client(URL);
  const room = await client.joinOrCreate('survival', { mapId, name });
  const callbacks = Callbacks(room);
  return { client, room, callbacks };
}

// Local Callbacks.get shim so we don't need to import { Callbacks } twice.
function Callbacks(room) {
  return {
    players: room.state.players,
    zombies: room.state.zombies,
  };
}

async function run() {
  const maps = ['zombie_city', 'flooded_world', 'heat_wastes'];

  // 1) each biome spawns a room, state syncs, hazards move, movement works
  for (const mapId of maps) {
    try {
      const { room } = await join('smoke-' + mapId.slice(0, 5), mapId);
      check(`join ${mapId} (roomId=${room.roomId})`, true);
      await wait(600); // let the first full state sync settle
      check(`  state.mapId === ${mapId}`, room.state.mapId === mapId);

      room.send('input', { dx: 1, dy: 0 });
      await wait(700);
      room.send('chat', { text: `smoke test on ${mapId}` });
      await wait(700);

      const { x } = room.state.players.get(room.sessionId);
      check('  player moved after input intent', x > 800, `x=${x}`);
      check('  world clock running', room.state.world.clock > 0, `clock=${room.state.world.clock}`);

      if (mapId === 'flooded_world') {
        check('  water rising', room.state.world.waterLevel > 0, `water=${room.state.world.waterLevel}`);
      }
      if (mapId === 'heat_wastes') {
        check('  temperature tracked', room.state.world.temp > 0, `temp=${room.state.world.temp}`);
      }
      if (mapId === 'zombie_city') {
        await wait(13000); // first wave lands around 12s
        check('  horde wave spawned', room.state.zombies.size > 0, `zombies=${room.state.zombies.size}`);
        check('  wave counter grew', room.state.world.wave >= 1, `wave=${room.state.world.wave}`);
      }

      room.leave();
      await wait(300);
    } catch (err) {
      check(`join ${mapId}`, false, String(err?.message || err));
    }
  }

  // 2) two players choosing the same map share one room (filterBy)
  try {
    const a = await join('smokeA', 'zombie_city');
    const b = await join('smokeB', 'zombie_city');
    check('same-map players share a room', a.room.roomId === b.room.roomId,
      `${a.room.roomId} vs ${b.room.roomId}`);
    // both visible to each other's full state
    await wait(400);
    check('both players in shared state', a.room.state.players.size >= 2, `n=${a.room.state.players.size}`);
    a.room.leave(); b.room.leave();
  } catch (err) {
    check('shared room matchmaking', false, String(err?.message || err));
  }

  // 3) different maps must NOT share rooms
  try {
    const a = await join('smokeX', 'zombie_city');
    const b = await join('smokeY', 'flooded_world');
    check('different maps are separate worlds', a.room.roomId !== b.room.roomId);
    a.room.leave(); b.room.leave();
  } catch (err) {
    check('separate rooms per map', false, String(err?.message || err));
  }

  console.log(`\n`);
  await wait(400);
  process.exit(Results.failed === 0 ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
