// shared/guns.js — compact port of Đêm Xác Sống's armory: 5 classes × 4 grades.
// Both the server simulation and the client HUD/shop read these stats, so a
// gun's damage/cooldown/magazine is defined exactly once.

export const GRADE_NAMES = ['Mk1', 'Mk2', 'Mk3', 'Prime'];

export const GUN_CLASSES = [
  { kind: 'pistol', name: 'Pistol',  dmg: 12, cd: 0.18, mag: 12, rl: 1.1, pel: 1, spr: 0.05, v: 840, price: 0 },
  { kind: 'smg',    name: 'SMG',     dmg: 9,  cd: 0.08, mag: 30, rl: 1.5, pel: 1, spr: 0.14, v: 860, price: 50 },
  { kind: 'shotgun', name: 'Shotgun', dmg: 10, cd: 0.75, mag: 6,  rl: 1.8, pel: 5, spr: 0.36, v: 720, price: 70 },
  { kind: 'rifle',  name: 'Rifle',   dmg: 18, cd: 0.115, mag: 30, rl: 1.7, pel: 1, spr: 0.07, v: 900, price: 90 },
  { kind: 'sniper', name: 'Sniper',  dmg: 55, cd: 0.9,  mag: 5,  rl: 2.0, pel: 1, spr: 0.012, v: 1500, price: 400 },
];

export const GUN_KINDS = { pistol: 0, smg: 1, shotgun: 2, rifle: 3, sniper: 4 };
export const GUN_NAMES = ['Pistol', 'SMG', 'Shotgun', 'Rifle', 'Sniper'];

export const GUNS = [];
GUN_CLASSES.forEach((c, ci) => {
  for (let L = 0; L < 4; L++) {
    GUNS.push({
      id: GUNS.length, cls: ci, grade: L,
      name: `${c.name} ${GRADE_NAMES[L]}`,
      price: L === 0 ? c.price : Math.round((c.price + 40) * Math.pow(3.1, L)),
      dmg: Math.round(c.dmg * (1 + L * 0.38)),
      cd: c.cd * (1 - L * 0.05),
      mag: Math.round(c.mag * (1 + L * 0.15)),
      rl: c.rl * (1 - L * 0.06),
      pel: c.pel + (ci === 2 ? L : 0),
      spr: c.spr * (1 - L * 0.05),
      v: c.v, life: 1.2, // seconds of server-side flight
    });
  }
});

// Unpersisted per-room coin economy (Đêm Xác Sống's shop, server-authoritative).
export const SHOP = {
  startGun: 0,                  // everyone owns the pistol Mk1
  upgradeCap: 4,
  up: [
    { key: 'dmg', name: 'Damage up', desc: '+15% gun damage per level', base: 80 },
    { key: 'rate', name: 'Fire rate', desc: '-6% cooldown per level', base: 90 },
    { key: 'mag', name: 'Big mag', desc: '+30% magazine per level', base: 90 },
    { key: 'rl', name: 'Fast reload', desc: '-8% reload time per level', base: 70 },
    { key: 'spd', name: 'Run shoes', desc: '+7% move speed per level', base: 80 },
    { key: 'hp', name: 'Vest', desc: '+20 max HP per level (fills on buy)', base: 100 },
    { key: 'arm', name: 'Armor', desc: '-7% damage taken per level', base: 110 },
    { key: 'reg', name: 'Regen', desc: '+0.6 HP/s while unhit per level', base: 120 },
    { key: 'crit', name: 'Crit', desc: '+6% double-damage chance per level', base: 110 },
    { key: 'gold', name: 'Coin magnet', desc: '+12% coins per level', base: 100 },
    { key: 'ptr', name: 'Pet training', desc: '+12% pet damage per level', base: 130 },
  ],
  bombs: { base: 40, cap: 5, dmg: 60, radius: 150 },   // [Z]
  haste: { base: 35, cap: 5, ms: 5000, mul: 1.45 },   // [V]
  pets: {                                             // [F] active support AI
    1: { name: 'Batty', desc: 'Bat circles you, pecks nearby zombies', dmg: 9, price: 220 },
    2: { name: 'Wolfie', desc: 'Wolf bites hard, shorter cooldown', dmg: 17, price: 520 },
    3: { name: 'Owlbit', desc: 'Sniper owl: long reach, steady damage', dmg: 24, price: 950 },
  },
};

export function gunOf(id) { return GUNS[id] != null ? GUNS[id] : GUNS[0]; }
