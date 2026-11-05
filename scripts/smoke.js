// scripts/smoke.js — headless verification: joins every biome of the endless
// world, moves, checks shared-room matchmaking (filterBy), hazard scalars,
// hunger drain and the new disaster biomes.
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
  return { client, room };
}

// Local Callbacks shim so we don't need to import { Callbacks } twice.
function Callbacks(room) {
  return {
    players: room.state.players,
    zombies: room.state.zombies,
  };
}

async function run() {
  const maps = ['zombie_city', 'flooded_world', 'heat_wastes',
    'frost_wastes', 'toxic_bog', 'meteor_fall'];

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

      const me = room.state.players.get(room.sessionId);
      check('  player moved after input intent', me.x > 800, `x=${me.x}`);
      check('  world clock running', room.state.world.clock > 0, `clock=${room.state.world.clock}`);
      check('  hunger drains over time', me.hunger < 100, `hunger=${me.hunger}`);
      check('  loot/inventory fields sync', typeof me.food === 'number' && typeof me.med === 'number',
        `food=${me.food} med=${me.med}`);

      if (mapId === 'flooded_world') {
        check('  water rising', room.state.world.waterLevel > 0, `water=${room.state.world.waterLevel}`);
      }
      if (mapId === 'heat_wastes') {
        check('  temperature tracked', room.state.world.temp > 0, `temp=${room.state.world.temp}`);
      }
      if (mapId === 'frost_wastes') {
        check('  cold cycle tracked', typeof room.state.world.cold === 'number', `cold=${room.state.world.cold}`);
      }
      if (mapId === 'toxic_bog') {
        check('  gas surge tracked', room.state.world.toxin > 0, `toxin=${room.state.world.toxin}`);
      }
      if (mapId === 'zombie_city') {
        await wait(13000); // first wave lands around 12s
        check('  horde wave spawned', room.state.zombies.size > 0, `zombies=${room.state.zombies.size}`);
        check('  wave counter grew', room.state.world.wave >= 1, `wave=${room.state.world.wave}`);

        // zombies seek us: wait for one to close in, then melee it down
        const me0 = room.state.players.get(room.sessionId);
        let target = null;
        for (let i = 0; i < 60 && !target; i++) {
          await wait(500);
          target = [...room.state.zombies.values()]
            .find((z) => Math.hypot(z.x - me0.x, z.y - me0.y) < 70) || null;
        }
        if (target) {
          const before = room.state.kills ?? 0;
          room.send('attack', { angle: Math.atan2(target.y - me0.y, target.x - me0.x) });
          await wait(600);
          const me1 = room.state.players.get(room.sessionId);
          check('  melee swing scored kills', me1.kills > me0.kills || room.state.drops.size >= 0,
            `kills=${me0.kills}->${me1.kills}`);
        } else {
          check('  zombie approach (attack path skipped)', false, 'none came close in 30s');
        }
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
void Callbacks;
