// client/net.js — connection layer: online Colyseus SDK, or the offline host.
import { Client, Callbacks } from '@colyseus/sdk';
import { createLocalSession } from './localRoom.js';

const clampAxis = (v) => Math.max(-1, Math.min(1, Number(v) || 0));

export class GameConnection {
  room = null;
  callbacks = null;
  inputTimer = 0;

  constructor() {
    const proto = location.protocol === 'https:' ? 'https' : 'http';
    this.client = new Client(`${proto}://${location.host}`);
  }

  async join(mapId, name, diff) {
    this.room = await this.client.joinOrCreate('survival', { mapId, name, diff });
    this.callbacks = Callbacks.get(this.room);
    return this;
  }

  onAdd(field, fn) { return this.callbacks?.onAdd(field, fn); }
  onRemove(field, fn) { return this.callbacks?.onRemove(field, fn); }
  onMessage(type, fn) { return this.room?.onMessage(type, fn); }
  onLeave(fn) { return this.room?.onLeave(fn); }

  send(type, data) { this.room?.send(type, data); }

  // Throttle input intents from the game loop (~50ms matches the patch rate).
  sendInput(dx, dy, nowMs) {
    if (nowMs - this.inputTimer < 50) return;
    this.inputTimer = nowMs;
    this.send('input', { dx: clampAxis(dx), dy: clampAxis(dy) });
  }

  leave() { this.room?.leave(); }
}

// Offline host: the exact same simulation as the server, run inside this tab.
// Same interface as GameConnection (plus tick), so GameScene cannot tell the
// difference — that is the whole design.
export class LocalConnection {
  room = null;
  inputTimer = 0;

  constructor(opts = {}) { this.opts = opts; }

  async join(mapId, name, diff) {
    this.room = createLocalSession({
      mapId, name, diff: diff ?? 1,
      seed: this.opts.seed,
      save: this.opts.save,
    });
    return this;
  }

  onAdd(field, fn) { return this.room?.onAdd(field, fn); }
  onRemove(field, fn) { return this.room?.onRemove(field, fn); }
  onMessage(type, fn) { return this.room?.onMessage(type, fn); }
  onLeave(fn) { return this.room?.onLeave(fn); }

  send(type, data) { this.room?.send(type, data); }

  sendInput(dx, dy, nowMs) {
    if (nowMs - this.inputTimer < 50) return;
    this.inputTimer = nowMs;
    this.send('input', { dx: clampAxis(dx), dy: clampAxis(dy) });
  }

  tick(nowMs) { this.room?.tick(nowMs); }

  leave() { this.room?.leave(); }
}
