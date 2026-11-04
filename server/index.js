// server/index.js — Colyseus 0.18 server: rooms map the world, Express serves the client.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { defineServer, defineRoom } from 'colyseus';
import { SurvivalRoom } from './SurvivalRoom.js';
import { BIOMES } from '../shared/maps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = defineServer({
  rooms: {
    // filterBy keeps survivors who pick the same map in the same room.
    survival: defineRoom(SurvivalRoom).filterBy(['mapId']),
  },
  express: (app) => {
    app.use(express.static(path.join(__dirname, '..', 'public')));
    app.get('/healthz', (_req, res) => res.json({ ok: true }));
    app.get('/api/biomes', (_req, res) => res.json(Object.values(BIOMES).map(
      ({ id, name, desc }) => ({ id, name, desc }))));
  },
});

const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 2567;
server.listen(PORT).then(() => {
  console.log(`☠ Doomdays server listening on http://localhost:${PORT}`);
}).catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
