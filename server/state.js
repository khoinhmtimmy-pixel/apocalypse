// server/state.js — synchronized state, Schema 5 (Colyseus 0.18), plain JS builder style.
import { schema, t } from '@colyseus/schema';

export const Player = schema({
  name: t.string().default('survivor'),
  x: t.int32().default(0),        // pixels, unbounded world coords (endless map)
  y: t.int32().default(0),
  angle: t.uint8().default(0),     // facing, 0-255 mapped to 360deg
  hp: t.uint8().default(100),
  hunger: t.uint8().default(100),  // drains over time; at 0, health drains too
  food: t.uint8().default(0),      // rations carried — [F] to eat
  med: t.uint8().default(0),       // medkits carried — [G] to heal
  kills: t.uint8().default(0),
  deaths: t.uint8().default(0),
}, 'Player');

export const Zombie = schema({
  x: t.int32().default(0),
  y: t.int32().default(0),
  hp: t.uint8().default(30),
}, 'Zombie');

// Dynamic loot drops: killed zombies leave rations/medkits on the ground.
export const Drop = schema({
  x: t.int32().default(0),
  y: t.int32().default(0),
  kind: t.string().default('food'), // 'food' | 'med'
}, 'Drop');

// Wildfires: position + birth time (world seconds). Radius grows from birth
// and is computed on both sides from world.clock — no radius sync needed.
export const Fire = schema({
  x: t.int32().default(0),
  y: t.int32().default(0),
  born: t.uint32().default(0),
}, 'Fire');

export const World = schema({
  wave: t.uint8().default(0),        // zombie hordes (zombie_city)
  temp: t.number().default(21),      // °C (heat_wastes / frost_wastes)
  cold: t.number().default(15),      // °C (frost_wastes)
  toxin: t.number().default(0),      // 0..1 gas surge strength (toxic_bog)
  waterLevel: t.number().default(0), // 0..1 flooded fraction (flooded_world)
  clock: t.uint32().default(0),     // world seconds survived
}, 'World');

export const SurvivalState = schema({
  mapId: t.string().fullStateOnly(),
  players: t.map(Player),
  zombies: t.map(Zombie),
  fires: t.map(Fire),
  drops: t.map(Drop),
  world: World,
}, 'SurvivalState');
