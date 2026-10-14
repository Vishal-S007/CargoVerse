// Site geometry for each facility. Pure configuration (no rendering code):
// the scene renders it and the simulation plans routes over it.
import type { FacilityId, Vec2, PalletLook } from './types';

export const DOOR_Z = 0; // south wall of every building
export const TRUCK_STOP_Z = 6.4; // truck centre when docked (rear at the door)
export const LANE_Z = 24; // yard manoeuvring lane
export const FENCE_Z = 44;
export const ROAD_Z = 52; // road centre line
export const ROAD_LANE_Z = 55; // eastbound lane used by trucks
export const ROAD_HALF = 7;
export const ROAD_X0 = -200;
export const ROAD_X1 = 200;
export const CORRIDOR_Z = 16; // forklift travel corridor

export type BuildingStyle = 'riverside' | 'southfield' | 'northgate';

export interface Block {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

export interface FacilityLayout {
  facilityId: FacilityId;
  style: BuildingStyle;
  building: { x0: number; x1: number; depth: number; height: number };
  annex?: { x0: number; x1: number; depth: number; height: number; z1: number };
  doors: Record<string, number>; // dock id -> door centre x
  storeOffset: number; // x offset from dock door to its put-away door
  extraDoors: number[];
  gateX: number;
  exitX: number;
  slots: Vec2[];
  chargers: Record<string, Vec2>;
  yard: { x0: number; x1: number; z0: number };
  trees: Vec2[];
  bgBlocks: Block[];
  decoPallets: { x: number; z: number; look: PalletLook; layers: number }[];
  racks: { x: number; z: number }[];
  crateStacks: { x: number; z: number; rot: number }[];
  shippingContainers: { x: number; z: number; rot: number; color: string }[];
  camera: { x: number; z: number; span: number }; // span = scene units visible across the viewport width
}

function row(x0: number, step: number, n: number, z: number): Vec2[] {
  return Array.from({ length: n }, (_, i) => ({ x: x0 + i * step, z }));
}

export const LAYOUTS: Record<FacilityId, FacilityLayout> = {
  'WH-01': {
    facilityId: 'WH-01',
    style: 'riverside',
    building: { x0: -24, x1: 20, depth: 26, height: 9 },
    annex: { x0: -40, x1: -24, depth: 22, height: 8, z1: -4 },
    doors: { 'WH-01-B1': -12, 'WH-01-B2': 4 },
    storeOffset: 8,
    extraDoors: [],
    gateX: -50,
    exitX: 36,
    slots: [...row(-30, 6, 5, 33), ...row(-30, 6, 5, 38), { x: 4, z: 33 }, { x: 10, z: 33 }, { x: 16, z: 33 }],
    chargers: { 'WH-01-C1': { x: -62, z: 6 }, 'WH-01-C2': { x: -62, z: 11 } },
    yard: { x0: -72, x1: 46, z0: -44 },
    trees: [
      { x: 24, z: -38 }, { x: 34, z: -30 }, { x: 44, z: -40 }, { x: 52, z: -18 }, { x: 58, z: -4 },
      { x: 12, z: -46 }, { x: -6, z: -52 }, { x: 64, z: 14 }, { x: 60, z: 30 }, { x: -80, z: -20 },
      { x: -84, z: 8 }, { x: 70, z: -30 },
    ],
    bgBlocks: [
      { x: 86, z: -20, w: 18, d: 30, h: 16 },
      { x: 88, z: 30, w: 16, d: 22, h: 12 },
      { x: 30, z: -84, w: 40, d: 18, h: 14 },
      { x: -40, z: -86, w: 30, d: 16, h: 10 },
    ],
    decoPallets: [
      { x: -60, z: 24, look: 'cardboard', layers: 2 }, { x: -56, z: 26, look: 'cardboard', layers: 1 },
      { x: -64, z: 30, look: 'cardboard', layers: 2 }, { x: -58, z: 32, look: 'cardboard', layers: 1 },
      { x: 28, z: -6, look: 'cardboard', layers: 2 }, { x: 30, z: 2, look: 'white', layers: 1 },
    ],
    racks: [{ x: 32, z: -16 }],
    crateStacks: [{ x: 6, z: -34, rot: 0 }, { x: 16, z: -36, rot: 0 }, { x: 40, z: 0, rot: 0.2 }],
    shippingContainers: [{ x: -70, z: -14, rot: Math.PI / 2, color: '#2aa39a' }],
    camera: { x: 0, z: 2, span: 148 },
  },
  'WH-04': {
    facilityId: 'WH-04',
    style: 'southfield',
    building: { x0: -56, x1: 58, depth: 38, height: 11 },
    doors: {
      'WH-04-I1': -42, 'WH-04-I2': -28, 'WH-04-I3': -14,
      'WH-04-O1': 6, 'WH-04-O2': 20, 'WH-04-O3': 34,
    },
    storeOffset: 7,
    extraDoors: [48],
    gateX: -70,
    exitX: 68,
    slots: [...row(-46, 6, 8, 33), ...row(4, 6, 7, 33), ...row(-46, 6, 4, 38), ...row(10, 6, 4, 38)],
    chargers: {
      'WH-04-C1': { x: -84, z: 2 }, 'WH-04-C2': { x: -84, z: 6.5 }, 'WH-04-C3': { x: -84, z: 11 },
      'WH-04-C4': { x: -84, z: 15.5 }, 'WH-04-C5': { x: -84, z: 20 },
    },
    yard: { x0: -96, x1: 80, z0: -50 },
    trees: [
      { x: -100, z: 40 }, { x: 92, z: 30 }, { x: 96, z: -10 }, { x: -104, z: -30 }, { x: 40, z: 68 },
      { x: -20, z: 70 }, { x: 90, z: 60 },
    ],
    bgBlocks: [
      { x: 120, z: -10, w: 22, d: 40, h: 14 },
      { x: -10, z: -96, w: 60, d: 20, h: 12 },
    ],
    decoPallets: [{ x: -76, z: -6, look: 'white', layers: 1 }, { x: -72, z: -10, look: 'cardboard', layers: 2 }],
    racks: [],
    crateStacks: [],
    shippingContainers: [],
    camera: { x: -2, z: 6, span: 210 },
  },
  'WH-02': {
    facilityId: 'WH-02',
    style: 'northgate',
    building: { x0: -48, x1: 46, depth: 34, height: 10 },
    annex: { x0: -64, x1: -48, depth: 34, height: 12, z1: 0 },
    doors: { 'WH-02-B1': -34, 'WH-02-B2': -18, 'WH-02-B3': -2, 'WH-02-B4': 14 },
    storeOffset: 8,
    extraDoors: [30, 40],
    gateX: -74,
    exitX: 58,
    slots: [...row(-44, 6, 6, 33), ...row(4, 6, 5, 33), ...row(-44, 6, 4, 38)],
    chargers: {
      'WH-02-C1': { x: -86, z: 4 }, 'WH-02-C2': { x: -86, z: 8.5 },
      'WH-02-C3': { x: -86, z: 13 }, 'WH-02-C4': { x: -86, z: 17.5 },
    },
    yard: { x0: -98, x1: 70, z0: -48 },
    trees: [
      { x: -104, z: 34 }, { x: -96, z: 70 }, { x: -60, z: 66 }, { x: 10, z: 64 }, { x: 46, z: 70 },
      { x: 84, z: 40 }, { x: 80, z: 14 }, { x: 84, z: -20 }, { x: -108, z: -10 },
    ],
    bgBlocks: [{ x: 110, z: -30, w: 24, d: 36, h: 12 }, { x: -20, z: -90, w: 70, d: 18, h: 10 }],
    decoPallets: [{ x: 26, z: -42, look: 'cardboard', layers: 2 }, { x: 32, z: -44, look: 'blue', layers: 1 }],
    racks: [],
    crateStacks: [{ x: 38, z: -42, rot: 0 }],
    shippingContainers: [],
    camera: { x: -4, z: 6, span: 210 },
  },
};

export function dockDoorX(fac: FacilityId, dockId: string): number {
  return LAYOUTS[fac].doors[dockId] ?? 0;
}
