// server/state.js — synchronized state, Schema 5 (Colyseus 0.18), plain JS builder style.
import { schema, t } from '@colyseus/schema';

export const Player = schema({
  name: t.string().default('survivor'),
  x: t.uint16().default(0),        // pixels, world coords
  y: t.uint16().default(0),
  angle: t.uint8().default(0),     // facing, 0-255 mapped to 360deg
  hp: t.uint8().default(100),
  kills: t.uint8().default(0),
  deaths: t.uint8().default(0),
}, 'Player');

export const Zombie = schema({
  x: t.uint16().default(0),
  y: t.uint16().default(0),
  hp: t.uint8().default(30),
}, 'Zombie');

export const World = schema({
  wave: t.uint8().default(0),          // zombie hordes (zombie_city)
  temp: t.number().default(26),        // °C (heat_wastes)
  waterLevel: t.number().default(0),   // 0..1 flooded fraction (flooded_world)
  clock: t.uint32().default(0),        // world seconds survived
}, 'World');

export const SurvivalState = schema({
  mapId: t.string().fullStateOnly(),
  players: t.map(Player),
  zombies: t.map(Zombie),
  world: World,
}, 'SurvivalState');
