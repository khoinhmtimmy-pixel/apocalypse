// server/SurvivalRoom.js — the Colyseus transport around shared/sim.js.
//
// All gameplay lives in shared/sim.js so an offline browser room can run the
// exact same rules. This class only owns the synced schema, the client
// lifecycle and message wiring: intents go in, events come out.
import { Room } from 'colyseus';
import { Player, Zombie, Fire, Drop, SurvivalState } from './state.js';
import {
  createWorld, addSurvivor, removeSurvivor, applyIntent, stepWorld,
} from '../shared/sim.js';

export class SurvivalRoom extends Room {
  maxClients = 24;

  onCreate(options = {}) {
    this.state = new SurvivalState();

    // the store is the only host-specific part: schema instances on the server
    const state = this.state;
    const store = {
      collections: () => ({
        players: state.players,
        zombies: state.zombies,
        drops: state.drops,
        fires: state.fires,
        world: state.world,
      }),
      player: (init) => new Player(init),
      zombie: (init) => new Zombie(init),
      drop: (init) => new Drop(init),
      fire: (init) => new Fire(init),
    };

    this.world = createWorld({
      mapId: options.mapId,
      diff: options.diff,
      seed: (Math.random() * 0x7fffffff) | 0,
      store,
    });
    this.state.mapId = this.world.mapId;

    this.setTimestep((deltaMs) => this.tick(deltaMs));
  }

  // ------------------------------------------------------------ lifecycle ---
  onJoin(client, options) {
    addSurvivor(this.world, { id: client.sessionId, name: options?.name });
    // late joiners need to know what was already scavenged
    client.send('looted', { keys: [...this.world.looted] });
    this.flushEvents();
  }

  async onLeave(client) {
    try { await this.allowReconnection(client, 30); } catch { /* gone for good */ }
    removeSurvivor(this.world, client.sessionId);
    this.flushEvents();
  }

  // ------------------------------------------------------------ messages  ---
  messages = {
    equip: (client, data) => this.intent(client, 'equip', data),
    shoot: (client, data) => this.intent(client, 'shoot', data),
    reload: (client, data) => this.intent(client, 'reload', data),
    buy: (client, data) => this.intent(client, 'buy', data),
    bomb: (client, data) => this.intent(client, 'bomb', data),
    haste: (client, data) => this.intent(client, 'haste', data),
    input: (client, data) => this.intent(client, 'input', data),
    chat: (client, data) => this.intent(client, 'chat', data),
    eat: (client, data) => this.intent(client, 'eat', data),
    heal: (client, data) => this.intent(client, 'heal', data),
    attack: (client, data) => this.intent(client, 'attack', data),
  };

  intent(client, type, data) {
    applyIntent(this.world, client.sessionId, type, data);
    this.flushEvents();
  }

  // ------------------------------------------------------------ simulation ---
  tick(deltaMs) {
    stepWorld(this.world, deltaMs, Date.now());
    this.flushEvents();
  }

  // shop replies are private; everything else is a broadcast
  flushEvents() {
    const events = this.world.events.splice(0, this.world.events.length);
    for (const { type, payload } of events) {
      const p = payload || {};
      if ((p.event === 'bought' || p.event === 'buyfail') && p.sid) {
        this.clients.find((c) => c.sessionId === p.sid)?.send('system', p);
        continue;
      }
      this.broadcast(type, p);
    }
  }
}
