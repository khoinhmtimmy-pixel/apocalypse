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
          // stay inside the server's melee reach (ATTACK_RANGE = 64px)
          target = [...room.state.zombies.values()]
            .find((z) => Math.hypot(z.x - me0.x, z.y - me0.y) < 48) || null;
        }
        if (target) {
          const hpSum = () => [...room.state.zombies.values()].reduce((a, z) => a + z.hp, 0);
          const kills0 = me0.kills, hp0 = hpSum();
          let landed = false;
          for (let i = 0; i < 6 && !landed; i++) {
            const me = room.state.players.get(room.sessionId);
            const t = [...room.state.zombies.values()]
              .find((z) => Math.hypot(z.x - me.x, z.y - me.y) < 48);
            if (!t) { await wait(400); continue; }
            room.send('attack', { angle: Math.atan2(t.y - me.y, t.x - me.x) });
            await wait(500);
            const after = room.state.players.get(room.sessionId);
            landed = after.kills > kills0 || hpSum() < hp0;
          }
          const me1 = room.state.players.get(room.sessionId);
          check('  melee swing connects', landed, `kills=${kills0} hpSum ${hp0}->${hpSum()}`);
          check('  kill pays coins + score', me1.coin > 5 || me1.score > 0,
            `coin=${me1.coin} score=${me1.score}`);
        } else {
          check('  zombie approach (attack path skipped)', false, 'none came close in 30s');
        }

        // Đêm Xác Sống port: shooting spends ammo, empty wallet cannot buy
        const me2 = room.state.players.get(room.sessionId);
        const gunMag = me2.ammo;
        room.send('shoot', { angle: 0 });
        await wait(400);
        check('  shooting drains the magazine', me2.ammo < gunMag, `${gunMag}->${me2.ammo}`);

        let buyEvent = null;
        room.onMessage('system', (m) => {
          if (m && (m.event === 'bought' || m.event === 'buyfail')) buyEvent = m;
        });
        const coinBefore = me2.coin;
        room.send('buy', { kind: 'gun', id: 1 }); // SMG Mk1 costs 50
        await wait(400);
        const me3 = room.state.players.get(room.sessionId);
        check('  shop rejects unaffordable purchases',
          me3.coin === coinBefore && !me3.own.get('1'),
          `coin=${me3.coin} event=${buyEvent ? buyEvent.event : 'none'}`);

        const upBefore = me2.up.get('mag') || 0;
        check('  upgrade map starts empty', upBefore === 0, `mag lvl=${upBefore}`);
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
