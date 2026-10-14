// Street-level scenery for Port Harbor and the Maple Heights and Willow Grove housing estates: family houses,
// cars parked on driveways and kerbs, street lamps, benches, small parks, and the sidewalk
// loops that pedestrians walk. Everything here is generated deterministically on the client;
// it is decoration, not database records (the named buildings and vehicles are in park.ts).
import {
  HWY_Z, HWY_HALF, ART_W, ART_E, ART_HALF, STREET_HALF, STREETS,
  MARKET_Z, BAY_Z, SHORE_Z, CENTRAL_X, OCEAN_X, CEDAR_X, BEACH_Z0, SEA_Z0,
  SUB_X0, SUB_X1, MAPLE_X, SUB_STREETS, PARK_BUILDINGS, WIL_X0, WIL_X1, BIRCH_X,
} from './park';

export interface Rect { x0: number; x1: number; z0: number; z1: number }
export interface House { x: number; z: number; w: number; d: number; h: number; roof: number; rot: number; wall: string; roofColor: string; chimney: boolean }
export interface ParkedCar { x: number; z: number; rot: number; color: string }
export interface Lamp { x: number; z: number }
export interface Bench { x: number; z: number; rot: number }
export interface WalkLoop { pts: { x: number; z: number }[]; length: number }

// deterministic pseudo-random numbers
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const WALLS = ['#f8f1e5', '#f3e3c7', '#e9eef6', '#dbe7f3', '#f6dcd2', '#e3efe0', '#fff4d6', '#ece4f4', '#d9e2ec', '#f1e0c5'];
const ROOFS = ['#b5523b', '#8c4a3a', '#5c6474', '#3f4a5c', '#7a5c48', '#a0603f', '#4d5b6e'];
const CAR_COLORS = ['#f6f8fc', '#2b2d42', '#e4572e', '#3a86ff', '#8d99ae', '#ffb703', '#adb5bd', '#06d6a0', '#ef476f', '#1d3557', '#c92a2a', '#495057'];

const HWY_N = HWY_Z - HWY_HALF; // north edge of the highway
const HWY_S = HWY_Z + HWY_HALF;

/** Green spaces (lawn, trees, benches, no houses). */
export const GREENS: (Rect & { name: string })[] = [
  { name: 'Maple Park', x0: MAPLE_X + 12, x1: SUB_X1 - 12, z0: STREETS.B + 12, z1: SUB_STREETS.elm - 12 },
  { name: 'Hillcrest Green', x0: SUB_X0 + 14, x1: SUB_X0 + 84, z0: STREETS.A + 12, z1: SUB_STREETS.oak - 12 },
  { name: 'Willow Park', x0: BIRCH_X + STREET_HALF + 14, x1: WIL_X1 - ART_HALF - 14, z0: STREETS.B + 12, z1: SUB_STREETS.elm - 12 },
  { name: 'Birch Green', x0: WIL_X0 + ART_HALF + 14, x1: WIL_X0 + 80, z0: SUB_STREETS.elm + 12, z1: STREETS.A - 12 },
  { name: 'Ocean Gardens', x0: OCEAN_X + 12, x1: OCEAN_X + 60, z0: BAY_Z - 36, z1: BAY_Z - 12 },
];

const inRect = (x: number, z: number, r: Rect, m = 0) => x > r.x0 - m && x < r.x1 + m && z > r.z0 - m && z < r.z1 + m;

function blocked(x: number, z: number, hw: number, hd: number): boolean {
  for (const b of PARK_BUILDINGS) {
    const [w, d] = b.rotation === 90 || b.rotation === 270 ? [b.d, b.w] : [b.w, b.d];
    if (Math.abs(x - b.x) < w / 2 + hw + 3 && Math.abs(z - b.z) < d / 2 + hd + 3) return true;
  }
  for (const g of GREENS) if (inRect(x, z, g, Math.max(hw, hd) + 2)) return true;
  return false;
}

// avenues and streets that houses must keep clear of (centre, half width incl. sidewalk)
const NS_ROADS = [ART_W, ART_E, CENTRAL_X, OCEAN_X, CEDAR_X, WIL_X0, BIRCH_X].map((x) => ({ x, half: ART_HALF + 4 }));
const EW_ROADS = [MARKET_Z, BAY_Z, SHORE_Z, STREETS.A, STREETS.B, SUB_STREETS.hill, SUB_STREETS.elm, SUB_STREETS.oak].map((z) => ({ z, half: STREET_HALF + 4 }));
function onRoad(x: number, z: number, hw: number, hd: number): boolean {
  for (const r of NS_ROADS) if (Math.abs(x - r.x) < r.half + hw + 2) return true;
  for (const r of EW_ROADS) if (Math.abs(z - r.z) < r.half + hd) return true;
  return Math.abs(z - HWY_Z) < HWY_HALF + 14 + hd;
}

/**
 * A row of houses along an east–west street, between x0 and x1, on one side.
 * side = -1: north of the street (fronts face south), +1: south of the street (fronts face north).
 */
function row(out: House[], cars: ParkedCar[], sz: number, x0: number, x1: number, side: -1 | 1, seed: number, lot = 22, setback = 7) {
  const r = rng(seed);
  for (let x = x0 + lot / 2; x <= x1 - lot / 2; x += lot) {
    const w = 10 + Math.floor(r() * 5);
    const d = 9 + Math.floor(r() * 3);
    const twoStorey = r() < 0.55;
    const h = twoStorey ? 6.2 : 3.6;
    const cz = sz + side * (STREET_HALF + 3.4 + setback + d / 2);
    const cx = x + (r() - 0.5) * 3;
    if (blocked(cx, cz, w / 2, d / 2) || onRoad(cx, cz, w / 2, d / 2)) continue;
    out.push({
      x: cx, z: cz, w, d, h, roof: 2.4 + r() * 1.2,
      rot: side === -1 ? 0 : Math.PI,
      wall: WALLS[Math.floor(r() * WALLS.length)], roofColor: ROOFS[Math.floor(r() * ROOFS.length)],
      chimney: r() < 0.4,
    });
    // a car on the driveway next to the house
    if (r() < 0.55) {
      const dx = cx + (w / 2 + 3) * (r() < 0.5 ? -1 : 1);
      cars.push({ x: dx, z: sz + side * (STREET_HALF + 3.4 + 4), rot: Math.PI / 2, color: CAR_COLORS[Math.floor(r() * CAR_COLORS.length)] });
    }
  }
}

function build() {
  const houses: House[] = [];
  const cars: ParkedCar[] = [];
  const driveways: ParkedCar[] = [];
  let seed = 11;
  // Maple Heights: rows on both sides of each east–west street, in the two columns of blocks
  const cols: [number, number][] = [[SUB_X0 + ART_HALF + 16, MAPLE_X - STREET_HALF - 10], [MAPLE_X + STREET_HALF + 10, SUB_X1 - ART_HALF - 10],
    // Willow Grove, west of Harbor Avenue
    [WIL_X0 + ART_HALF + 12, BIRCH_X - STREET_HALF - 10], [BIRCH_X + STREET_HALF + 10, WIL_X1 - ART_HALF - 14]];
  const subStreets = [SUB_STREETS.hill, STREETS.B, SUB_STREETS.elm, STREETS.A, SUB_STREETS.oak];
  for (const [x0, x1] of cols) {
    for (const sz of subStreets) {
      row(houses, cars, sz, x0, x1, -1, seed++);
      row(houses, cars, sz, x0, x1, 1, seed++);
    }
  }
  // Port Harbor: town houses on the north side of Bay Road and along Shore Road
  for (const [x0, x1] of [[ART_W + 14, CENTRAL_X - 12], [CENTRAL_X + 12, ART_E - 14], [ART_E + 14, OCEAN_X - 12], [OCEAN_X + 12, CEDAR_X - 12]]) {
    row(houses, cars, BAY_Z, x0, x1, -1, seed++, 18, 4);
    row(houses, cars, SHORE_Z, x0, x1, -1, seed++, 18, 4);
  }
  for (const c of cars) driveways.push(c);

  // cars parked along the kerbs of the town streets (gaps at junctions)
  const r = rng(97);
  const kerb: ParkedCar[] = [];
  const junctions = [ART_W, CENTRAL_X, ART_E, OCEAN_X, CEDAR_X, WIL_X0, BIRCH_X];
  for (const sz of [MARKET_Z, BAY_Z, SHORE_Z]) {
    for (let x = ART_W + 14; x < CEDAR_X - 12; x += 7.5) {
      if (junctions.some((j) => Math.abs(x - j) < 16)) continue;
      for (const s of [-1, 1]) {
        if (r() < 0.6) continue;
        kerb.push({ x, z: sz + s * (STREET_HALF - 1.4), rot: s < 0 ? Math.PI : 0, color: CAR_COLORS[Math.floor(r() * CAR_COLORS.length)] });
      }
    }
  }
  for (const sz of [SUB_STREETS.hill, SUB_STREETS.elm, SUB_STREETS.oak]) {
    for (let x = SUB_X0 + 20; x < SUB_X1 - 12; x += 9) {
      if (Math.abs(x - MAPLE_X) < 16 || r() < 0.7) continue;
      const s = r() < 0.5 ? -1 : 1;
      kerb.push({ x, z: sz + s * (STREET_HALF - 1.4), rot: s < 0 ? Math.PI : 0, color: CAR_COLORS[Math.floor(r() * CAR_COLORS.length)] });
    }
    for (let x = WIL_X0 + 18; x < WIL_X1 - 16; x += 9) {
      if (Math.abs(x - BIRCH_X) < 16 || r() < 0.7) continue;
      const s = r() < 0.5 ? -1 : 1;
      kerb.push({ x, z: sz + s * (STREET_HALF - 1.4), rot: s < 0 ? Math.PI : 0, color: CAR_COLORS[Math.floor(r() * CAR_COLORS.length)] });
    }
  }

  // street lamps along every street and avenue in town and in the estate
  const lamps: Lamp[] = [];
  const lampEW = (sz: number, x0: number, x1: number, step = 30) => {
    for (let x = x0; x <= x1; x += step) {
      if (junctions.some((j) => Math.abs(x - j) < 12)) continue;
      lamps.push({ x, z: sz - STREET_HALF - 2.6 }, { x: x + step / 2, z: sz + STREET_HALF + 2.6 });
    }
  };
  for (const sz of [MARKET_Z, BAY_Z, SHORE_Z]) lampEW(sz, ART_W + 16, CEDAR_X - 10);
  for (const sz of subStreets) lampEW(sz, SUB_X0 + 16, SUB_X1 - 10, 36);
  for (const sz of subStreets) lampEW(sz, WIL_X0 + 14, WIL_X1 - 14, 36);
  const lampNS = (ax: number, z0: number, z1: number, half: number, step = 30) => {
    for (let z = z0; z <= z1; z += step) {
      if ([MARKET_Z, BAY_Z, SHORE_Z, ...subStreets].some((s) => Math.abs(z - s) < 12)) continue;
      lamps.push({ x: ax - half - 2.6, z }, { x: ax + half + 2.6, z: z + step / 2 });
    }
  };
  for (const ax of [CENTRAL_X, OCEAN_X]) lampNS(ax, HWY_S + 12, SHORE_Z - 10, STREET_HALF);
  for (const ax of [ART_W, ART_E, CEDAR_X]) lampNS(ax, HWY_S + 12, SHORE_Z - 10, ART_HALF);
  for (const ax of [SUB_X0, SUB_X1]) lampNS(ax, SUB_STREETS.hill + 10, HWY_N - 14, ART_HALF, 34);
  lampNS(MAPLE_X, SUB_STREETS.hill + 10, HWY_N - 14, STREET_HALF, 34);
  lampNS(WIL_X0, SUB_STREETS.hill + 10, HWY_N - 14, ART_HALF, 34);
  lampNS(BIRCH_X, SUB_STREETS.hill + 10, HWY_N - 14, STREET_HALF, 34);
  // the beach promenade
  for (let x = ART_W; x <= CEDAR_X + 60; x += 26) lamps.push({ x, z: BEACH_Z0 - 2 });

  // benches in the parks and on the promenade
  const benches: Bench[] = [];
  for (const g of GREENS) {
    const cx = (g.x0 + g.x1) / 2, cz = (g.z0 + g.z1) / 2;
    benches.push({ x: cx - 8, z: cz, rot: Math.PI / 2 }, { x: cx + 8, z: cz, rot: -Math.PI / 2 }, { x: cx, z: cz - 8, rot: 0 }, { x: cx, z: cz + 8, rot: Math.PI });
  }
  for (let x = ART_W + 13; x <= CEDAR_X + 40; x += 52) benches.push({ x, z: BEACH_Z0 + 1.5, rot: Math.PI });

  // trees: back gardens, parks, the estate's streets, the beach promenade
  const trees: [number, number, number][] = [];
  const tr = rng(331);
  for (const h of houses) {
    if (tr() < 0.6) {
      const back = h.rot === 0 ? -1 : 1;
      const tx = h.x + (tr() - 0.5) * h.w, tz = h.z + back * (h.d / 2 + 4 + tr() * 3);
      if (!onRoad(tx, tz, 1, 1)) trees.push([tx, tz, 0.8 + tr() * 0.5]);
    }
  }
  for (const g of GREENS) {
    for (let x = g.x0 + 4; x <= g.x1 - 4; x += 10) {
      for (let z = g.z0 + 4; z <= g.z1 - 4; z += 10) {
        const cx = (g.x0 + g.x1) / 2, cz = (g.z0 + g.z1) / 2;
        if (Math.abs(x - cx) < 12 && Math.abs(z - cz) < 12) continue; // the plaza in the middle
        if (tr() < 0.55) trees.push([x + (tr() - 0.5) * 5, z + (tr() - 0.5) * 5, 0.9 + tr() * 0.6]);
      }
    }
  }
  for (const sz of subStreets) {
    for (let x = SUB_X0 + 22; x < SUB_X1 - 10; x += 16) {
      if (Math.abs(x - MAPLE_X) < 14) continue;
      for (const s of [-1, 1]) {
        const tz = sz + s * (STREET_HALF + 4.6);
        if (!blocked(x, tz, 1, 1) && tr() < 0.75) trees.push([x, tz, 0.75 + tr() * 0.3]);
      }
    }
    for (let x = WIL_X0 + 18; x < WIL_X1 - 14; x += 16) {
      if (Math.abs(x - BIRCH_X) < 14) continue;
      for (const s of [-1, 1]) {
        const tz = sz + s * (STREET_HALF + 4.6);
        if (!blocked(x, tz, 1, 1) && tr() < 0.75) trees.push([x, tz, 0.75 + tr() * 0.3]);
      }
    }
  }
  for (let x = ART_W - 20; x <= CEDAR_X + 120; x += 14) trees.push([x, BEACH_Z0 - 5.5, 0.9 + tr() * 0.4]); // promenade palms-ish row
  // the estate's northern edge: a wooded strip
  for (let x = WIL_X0 - 30; x <= WIL_X1 - 14; x += 9) {
    for (let k = 0; k < 3; k++) trees.push([x + (tr() - 0.5) * 6, SUB_STREETS.hill - 46 - k * 9 + (tr() - 0.5) * 4, 1 + tr() * 0.6]);
  }
  for (let x = SUB_X0 + 12; x <= SUB_X1 + 40; x += 9) {
    for (let k = 0; k < 3; k++) trees.push([x + (tr() - 0.5) * 6, SUB_STREETS.hill - 46 - k * 9 + (tr() - 0.5) * 4, 1 + tr() * 0.6]);
  }

  // sidewalk loops that pedestrians walk (inset from the street centre lines)
  const loops: WalkLoop[] = [];
  const inset = STREET_HALF + 1.7;
  const loop = (x0: number, x1: number, z0: number, z1: number) => {
    const pts = [{ x: x0 + inset, z: z0 + inset }, { x: x1 - inset, z: z0 + inset }, { x: x1 - inset, z: z1 - inset }, { x: x0 + inset, z: z1 - inset }];
    loops.push({ pts, length: 2 * (x1 - x0 - 2 * inset) + 2 * (z1 - z0 - 2 * inset) });
  };
  const townX = [ART_W, CENTRAL_X, ART_E, OCEAN_X, CEDAR_X];
  for (let i = 0; i < townX.length - 1; i++) {
    loop(townX[i], townX[i + 1], MARKET_Z, BAY_Z);
    loop(townX[i], townX[i + 1], BAY_Z, SHORE_Z);
  }
  const subX = [WIL_X0, BIRCH_X, WIL_X1, -1, SUB_X0, MAPLE_X, SUB_X1];
  for (let i = 0; i < subX.length - 1; i++) {
    if (subX[i] === -1 || subX[i + 1] === -1) continue;
    for (let k = 0; k < subStreets.length - 1; k++) loop(subX[i], subX[i + 1], subStreets[k], subStreets[k + 1]);
  }

  return { houses, driveways, kerb, lamps, benches, trees, loops };
}

export const SCENERY = build();

/** Stretches of the beach and promenade where people stroll back and forth (x0, x1, z). */
export const PROMENADE = { x0: ART_W - 30, x1: CEDAR_X + 140, z: BEACH_Z0 - 2, beachZ0: BEACH_Z0 + 4, beachZ1: SEA_Z0 - 4 };

/** Where shoppers stand around (shop fronts, bus stops): [x, z]. */
export function crowdSpots(): [number, number][] {
  const out: [number, number][] = [];
  for (const b of PARK_BUILDINGS) {
    if (!['SUPERMARKET', 'STORE'].includes(b.kind) || b.z < HWY_S) continue;
    const front = b.rotation === 180 ? b.z - b.d / 2 - 4 : b.z + b.d / 2 + 4;
    out.push([b.x - b.w / 4, front], [b.x + b.w / 5, front]);
  }
  return out;
}

export function loopPoint(l: WalkLoop, s: number): { x: number; z: number; dx: number; dz: number } {
  let d = ((s % l.length) + l.length) % l.length;
  const n = l.pts.length;
  for (let i = 0; i < n; i++) {
    const a = l.pts[i], b = l.pts[(i + 1) % n];
    const seg = Math.abs(b.x - a.x) + Math.abs(b.z - a.z);
    if (d <= seg) {
      const t = seg ? d / seg : 0;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: Math.sign(b.x - a.x), dz: Math.sign(b.z - a.z) };
    }
    d -= seg;
  }
  return { x: l.pts[0].x, z: l.pts[0].z, dx: 1, dz: 0 };
}
