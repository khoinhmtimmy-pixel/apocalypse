// client/net.js — connection layer: Colyseus SDK join + reconnection-aware wrapper.
import { Client, Callbacks } from '@colyseus/sdk';

export class GameConnection {
  room = null;
  callbacks = null;
  inputTimer = 0;

  constructor() {
    const proto = location.protocol === 'https:' ? 'https' : 'http';
    this.client = new Client(`${proto}://${location.host}`);
  }

  async join(mapId, name) {
    this.room = await this.client.joinOrCreate('survival', { mapId, name });
    this.callbacks = Callbacks.get(this.room);
    return this;
  }

  onAdd(field, fn) { return this.callbacks?.onAdd(field, fn); }
  onRemove(field, fn) { return this.callbacks?.onRemove(field, fn); }
  onMessage(type, fn) { return this.room?.onMessage(type, fn); }

  send(type, data) { this.room?.send(type, data); }

  // Throttle input intents from the game loop (~50ms matches the patch rate).
  sendInput(dx, dy, nowMs) {
    if (nowMs - this.inputTimer < 50) return;
    this.inputTimer = nowMs;
    this.send('input', { dx: Math.max(-1, Math.min(1, dx)), dy: Math.max(-1, Math.min(1, dy)) });
  }

  leave() { this.room?.leave(); }
}
