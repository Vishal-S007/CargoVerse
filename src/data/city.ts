// The container port (berths, quay cranes, yard blocks, the ships that call) and
// the town's vendor stores with the CargoVerse delivery fleet that restocks them.
// Static catalogue + geometry shared by the simulation, the 3D scene and the
// Oracle seed generator. The changing state lives in WorldState.port / .retail.
import type {
  FacilityId, Vec2, Vessel, Berth, QuayCrane, PortState, Store, StoreKind, DeliveryVan, RetailState,
} from './types';
import {
  ART_W, ART_E, MARKET_Z, BAY_Z, SHORE_Z, STREETS, FACILITY_STREET, FACILITY_OFFSET, PARK_BUILDINGS, type ParkBuilding,
} from './park';
import { LAYOUTS, FENCE_Z } from './layouts';
import { roundCorners, pathLength, sampleAt } from '../sim/geometry';

// ---------------------------------------------------------------- terminal geometry (park coordinates)
export const TERMINAL = { x: -700, z: 301, w: 200, d: 78 } as const; // matches PB-PORT
export const QUAY_Z = TERMINAL.z + TERMINAL.d / 2; // 340: the quay wall
export const MOOR_Z = 349; // centre line of a ship alongside
export const SHIP_LENGTH = 80;
export const SHIP_BEAM = 13;
/** Import and export stacking blocks between the truck aisle and the quay apron. */
export const YARD_BLOCKS = {
  IMPORT: { x: -747, z: 309, w: 86, d: 24 },
  EXPORT: { x: -652, z: 309, w: 86, d: 24 },
} as const;
export const YARD_BAYS = 6; // along x
export const YARD_ROWS = 6; // along z
export const YARD_TIERS = 2;
export const YARD_CAPACITY = 60; // boxes per block
export const CRANE_CYCLE_S = 6; // real seconds per container move
export const SHIP_SPEED = { approach: 10, berthing: 5, departure: 7 }; // units per real second

/** Slot position of the i-th box in a yard block (fills bays, then rows, then tiers). */
export function yardSlot(block: keyof typeof YARD_BLOCKS, i: number): { x: number; y: number; z: number } {
  const b = YARD_BLOCKS[block];
  const bay = i % YARD_BAYS;
  const row = Math.floor(i / YARD_BAYS) % YARD_ROWS;
  const tier = Math.floor(i / (YARD_BAYS * YARD_ROWS));
  return {
    x: b.x - b.w / 2 + 7 + bay * ((b.w - 14) / (YARD_BAYS - 1)),
    y: 1.3 + tier * 2.6,
    z: b.z - b.d / 2 + 2 + row * ((b.d - 4) / (YARD_ROWS - 1)),
  };
}

export const BERTH_DEFS: { id: string; name: string; x: number }[] = [
  { id: 'B1', name: 'Berth 1 (west)', x: -745 },
  { id: 'B2', name: 'Berth 2 (east)', x: -655 },
];
export const CRANE_DEFS: { id: string; berthId: string; offset: number }[] = [
  { id: 'QC-01', berthId: 'B1', offset: -17 },
  { id: 'QC-02', berthId: 'B1', offset: 17 },
  { id: 'QC-03', berthId: 'B2', offset: -17 },
  { id: 'QC-04', berthId: 'B2', offset: 17 },
];
export const berthX = (id: string): number => BERTH_DEFS.find((b) => b.id === id)?.x ?? BERTH_DEFS[0].x;

// ---------------------------------------------------------------- ship routes on the water
const anchorage = (slot: number): Vec2 => ({ x: -1010 - slot * 46, z: 468 + slot * 26 });

const pathCache = new Map<string, Vec2[]>();
const cached = (key: string, make: () => Vec2[]): Vec2[] => {
  let p = pathCache.get(key);
  if (!p) { p = make(); pathCache.set(key, p); }
  return p;
};

/** From the open sea to the ship's anchorage spot. */
export function approachPath(slot: number): Vec2[] {
  return cached(`a${slot}`, () => roundCorners([{ x: -1500, z: 660 + slot * 22 }, { x: -1180, z: 580 + slot * 10 }, anchorage(slot)], 40));
}
/** From the anchorage alongside the berth (the ship ends parallel to the quay, bow east). */
export function berthingPath(slot: number, berthId: string): Vec2[] {
  const bx = berthX(berthId);
  return cached(`b${slot}${berthId}`, () => roundCorners([anchorage(slot), { x: bx - 125, z: 402 }, { x: bx - 40, z: MOOR_Z + 9 }, { x: bx, z: MOOR_Z }], 30));
}
/** From the berth back out to sea, passing south of the other berth. */
export function departurePath(berthId: string): Vec2[] {
  const bx = berthX(berthId);
  return cached(`d${berthId}`, () => roundCorners([{ x: bx, z: MOOR_Z }, { x: bx + 55, z: MOOR_Z + 18 }, { x: -540, z: 420 }, { x: -730, z: 545 }, { x: -1120, z: 640 }, { x: -1520, z: 700 }], 40));
}
const lengths = new Map<Vec2[], number>();
export function legLength(pts: Vec2[]): number {
  let l = lengths.get(pts);
  if (l === undefined) { l = pathLength(pts); lengths.set(pts, l); }
  return l;
}

/** Position and heading of a ship from its status and the distance along its current leg. */
export function vesselPose(v: Pick<Vessel, 'status' | 'slot' | 'berthId' | 'dist'>): { pos: Vec2; heading: number } {
  switch (v.status) {
    case 'BERTHED':
      return { pos: { x: berthX(v.berthId ?? 'B1'), z: MOOR_Z }, heading: 0 };
    case 'BERTHING': {
      const pts = berthingPath(v.slot, v.berthId ?? 'B1');
      const len = legLength(pts);
      const s = sampleAt(pts, Math.min(v.dist, len));
      let heading = Math.atan2(s.dz, s.dx);
      // swing parallel to the quay over the last stretch
      const rem = len - v.dist;
      if (rem < 45) heading = heading * (rem / 45);
      return { pos: { x: s.x, z: s.z }, heading };
    }
    case 'DEPARTING': {
      const pts = departurePath(v.berthId ?? 'B1');
      const s = sampleAt(pts, Math.min(v.dist, legLength(pts)));
      return { pos: { x: s.x, z: s.z }, heading: Math.atan2(s.dz, s.dx) };
    }
    case 'ANCHORED': {
      const a = anchorage(v.slot);
      return { pos: a, heading: Math.atan2(-0.35, 1) };
    }
    case 'ARRIVING': {
      const pts = approachPath(v.slot);
      const s = sampleAt(pts, Math.min(v.dist, legLength(pts)));
      return { pos: { x: s.x, z: s.z }, heading: Math.atan2(s.dz, s.dx) };
    }
    default:
      return { pos: approachPath(v.slot)[0], heading: 0 };
  }
}

// ---------------------------------------------------------------- the ships that call here
interface VesselDef {
  id: string; name: string; line: string; prefix: string; flag: string; imo6: string; color: string;
  capacity: number; through: number; origin: string; nextPort: string;
}
const VESSEL_DEFS: VesselDef[] = [
  { id: 'VSL-01', name: 'Ocean Star', line: 'Oceanic Star Line', prefix: 'OSL', flag: 'Liberia', imo6: '941273', color: '#1d3557', capacity: 44, through: 14, origin: 'Rotterdam, NL', nextPort: 'Savannah, US' },
  { id: 'VSL-02', name: 'Nordhavn Express', line: 'Nordhavn Shipping', prefix: 'NDH', flag: 'Denmark', imo6: '952108', color: '#c92a2a', capacity: 44, through: 12, origin: 'Hamburg, DE', nextPort: 'Halifax, CA' },
  { id: 'VSL-03', name: 'Pacific Harmony', line: 'Pacifica Container Co.', prefix: 'PCC', flag: 'Singapore', imo6: '937645', color: '#2b8a3e', capacity: 44, through: 16, origin: 'Singapore, SG', nextPort: 'Norfolk, US' },
  { id: 'VSL-04', name: 'Bluewater Pride', line: 'Bluewater Lines', prefix: 'BWL', flag: 'Panama', imo6: '946512', color: '#1971c2', capacity: 44, through: 10, origin: 'Santos, BR', nextPort: 'Charleston, US' },
  { id: 'VSL-05', name: 'Orient Gateway', line: 'Orient Gateway Lines', prefix: 'OGW', flag: 'Hong Kong', imo6: '958330', color: '#e67700', capacity: 44, through: 14, origin: 'Shanghai, CN', nextPort: 'Miami, US' },
];

/** Shipping lines whose containers pass through the terminal (WTL = CargoVerse's own export boxes). */
export const VESSEL_LINES: { code: string; name: string }[] = [
  ...VESSEL_DEFS.map((d) => ({ code: d.prefix, name: d.line })),
  { code: 'WTL', name: 'CargoVerse Logistics (own containers)' },
];

/** IMO number with its check digit (the last digit). */
export function imoNumber(six: string): string {
  const sum = six.split('').reduce((a, d, i) => a + Number(d) * (7 - i), 0);
  return `IMO ${six}${sum % 10}`;
}

const ISO_LETTERS: Record<string, number> = {};
{
  let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v++;
    ISO_LETTERS[ch] = v++;
  }
}
/** ISO 6346 container number, e.g. OSLU 412305 7 (owner code + U, serial, check digit). */
export function containerNo(prefix: string, serial: number): string {
  const owner = `${prefix}U`;
  const digits = String(serial % 1000000).padStart(6, '0');
  const chars = owner + digits;
  let sum = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const val = c >= '0' && c <= '9' ? Number(c) : ISO_LETTERS[c];
    sum += val * 2 ** i;
  }
  const check = (sum % 11) % 10;
  return `${owner}${digits}${check}`;
}
export const vesselByPrefix = (prefix: string) => VESSEL_DEFS.find((d) => prefix.startsWith(d.prefix));
/** Owner prefix for CargoVerse's own export boxes. */
export const LOCAL_PREFIX = 'WTL';

export function voyageCode(callNo: number, eastbound: boolean): string {
  return `${String(callNo).padStart(3, '0')}${eastbound ? 'E' : 'W'}`;
}

export function seedPort(): PortState {
  const berths: Record<string, Berth> = {};
  for (const b of BERTH_DEFS) berths[b.id] = { id: b.id, name: b.name, x: b.x, open: true, vesselId: null };
  const cranes: Record<string, QuayCrane> = {};
  for (const c of CRANE_DEFS) cranes[c.id] = { id: c.id, berthId: c.berthId, offset: c.offset, phase: 'idle', cycle: 0, movesToday: 40 + c.offset * 0 + c.id.charCodeAt(4) * 3 };
  const vessels: Record<string, Vessel> = {};
  VESSEL_DEFS.forEach((d, i) => {
    const v: Vessel = {
      id: d.id, name: d.name, line: d.line, prefix: d.prefix, flag: d.flag, imo: imoNumber(d.imo6), color: d.color, slot: i,
      capacity: d.capacity, through: d.through, status: 'AT_SEA', berthId: null, dist: 0, pos: { x: 0, z: 0 }, heading: 0,
      timer: 20 + i * 35, importBoxes: 12 + (i % 3) * 2, exportBoxes: 0, exportTarget: 10 + (i % 2) * 2, discharged: 0, loaded: 0,
      hold: false, waited: 0, voyage: voyageCode(40 + i * 3, i % 2 === 0), calls: 40 + i * 3, arrivedAt: null, origin: d.origin, nextPort: d.nextPort,
    };
    vessels[v.id] = v;
  });
  // one ship alongside each berth when the shift starts, one on its way in
  const a = vessels['VSL-01'];
  Object.assign(a, { status: 'BERTHED', berthId: 'B1', importBoxes: 7, discharged: 7, timer: 0, arrivedAt: 27600 });
  berths.B1.vesselId = a.id;
  const b = vessels['VSL-04'];
  Object.assign(b, { status: 'BERTHED', berthId: 'B2', importBoxes: 0, discharged: 12, exportBoxes: 4, loaded: 4, timer: 0, arrivedAt: 26400 });
  berths.B2.vesselId = b.id;
  const c = vessels['VSL-02'];
  Object.assign(c, { status: 'ARRIVING', dist: legLength(approachPath(c.slot)) * 0.45, timer: 0 });
  for (const v of Object.values(vessels)) { const p = vesselPose(v); v.pos = p.pos; v.heading = p.heading; }
  cranes['QC-01'].phase = 'discharge';
  cranes['QC-02'].phase = 'discharge';
  cranes['QC-03'].phase = 'load';
  cranes['QC-04'].phase = 'load';
  // boxes already in the stacks at the start of the shift
  let serial = 411800;
  const importStack: string[] = [];
  const exportStack: string[] = [];
  const prefixes = VESSEL_DEFS.map((d) => d.prefix);
  for (let i = 0; i < 22; i++) importStack.push(containerNo(prefixes[i % prefixes.length], serial++));
  for (let i = 0; i < 14; i++) exportStack.push(containerNo(i % 3 === 0 ? LOCAL_PREFIX : prefixes[(i + 2) % prefixes.length], serial++));
  return {
    importStack, exportStack, yardCapacity: YARD_CAPACITY, movesToday: 312, callsToday: 3, gateOutToday: 64, gateInToday: 41,
    nextBox: 412300, extTimer: 0, vessels, berths, cranes, log: [],
  };
}

// ---------------------------------------------------------------- vendor stores in town
interface StoreDef {
  id: string; buildingId: string; name: string; chain: string; kind: StoreKind; facilityId: FacilityId;
  lines: [sku: string, max: number, reorderAt: number, perHour: number, start: number][];
}
export const STORE_DEFS: StoreDef[] = [
  { id: 'ST-01', buildingId: 'PB-FRESHCART', name: 'FreshCart Supermarket', chain: 'FRESHCART', kind: 'SUPERMARKET', facilityId: 'WH-01',
    lines: [['CNT-P', 120, 45, 50, 64], ['BOX-M', 200, 70, 80, 150], ['PKG-TAPE', 240, 80, 90, 98], ['GLV-NIT', 160, 60, 60, 120]] },
  { id: 'ST-02', buildingId: 'PB-CITYCARE', name: 'CityCare Pharmacy', chain: 'CITYCARE', kind: 'PHARMACY', facilityId: 'WH-04',
    lines: [['GLV-NIT', 180, 60, 70, 76], ['CNT-P', 60, 20, 18, 41]] },
  { id: 'ST-03', buildingId: 'PB-OFFICEWORKS', name: 'OfficeWorks Depot', chain: 'OFFICEWORKS', kind: 'OFFICE', facilityId: 'WH-02',
    lines: [['CHR-OFC', 24, 8, 6, 11], ['BOX-M', 150, 50, 45, 118], ['PKG-TAPE', 180, 60, 50, 66], ['LED-6060', 40, 14, 10, 30]] },
  { id: 'ST-04', buildingId: 'PB-VALUMART', name: 'ValuMart Superstore', chain: 'VALUMART', kind: 'SUPERMARKET', facilityId: 'WH-02',
    lines: [['CNT-P', 150, 50, 55, 58], ['BOX-M', 220, 80, 85, 181], ['LED-6060', 60, 20, 16, 37], ['GLV-NIT', 200, 70, 75, 95], ['CHR-OFC', 20, 6, 5, 14]] },
  { id: 'ST-05', buildingId: 'PB-BUILDRIGHT', name: 'BuildRight Hardware', chain: 'BUILDRIGHT', kind: 'HARDWARE', facilityId: 'WH-01',
    lines: [['PPE-HLM-Y', 90, 30, 26, 38], ['GLV-NIT', 150, 50, 48, 112], ['LED-6060', 50, 16, 12, 41], ['PKG-TAPE', 120, 40, 36, 77]] },
  { id: 'ST-06', buildingId: 'PB-CORNER', name: 'Corner Express', chain: 'CORNER', kind: 'CONVENIENCE', facilityId: 'WH-01',
    lines: [['PKG-TAPE', 48, 16, 14, 29], ['GLV-NIT', 40, 14, 12, 17]] },
  { id: 'ST-07', buildingId: 'PB-HOMEMART', name: 'HomeMart Superstore', chain: 'HOMEMART', kind: 'SUPERMARKET', facilityId: 'WH-04',
    lines: [['CNT-P', 160, 55, 60, 140], ['BOX-M', 200, 70, 70, 88], ['CHR-OFC', 30, 10, 7, 22], ['LED-6060', 70, 24, 18, 31], ['GLV-NIT', 160, 55, 55, 128]] },
  { id: 'ST-08', buildingId: 'PB-GARDEN', name: 'Harbor Home & Garden', chain: 'GARDEN', kind: 'HARDWARE', facilityId: 'WH-04',
    lines: [['GLV-NIT', 120, 40, 40, 51], ['CNT-P', 80, 28, 24, 70], ['PPE-HLM-Y', 40, 14, 10, 27]] },
  { id: 'ST-09', buildingId: 'PB-MALL', name: 'Harbor Point Mall', chain: 'HARBORPOINT', kind: 'SUPERMARKET', facilityId: 'WH-02',
    lines: [['CNT-P', 200, 70, 70, 120], ['BOX-M', 240, 80, 90, 210], ['LED-6060', 80, 26, 20, 44], ['CHR-OFC', 30, 10, 8, 17], ['GLV-NIT', 220, 75, 80, 160]] },
  { id: 'ST-10', buildingId: 'PB-VOLT', name: 'VoltCity Electronics', chain: 'VOLTCITY', kind: 'OFFICE', facilityId: 'WH-02',
    lines: [['LED-6060', 90, 30, 24, 52], ['CHR-OFC', 30, 10, 7, 24], ['PKG-TAPE', 100, 34, 30, 81]] },
  { id: 'ST-11', buildingId: 'PB-FISH', name: "Fisherman's Market", chain: 'FISHMKT', kind: 'CONVENIENCE', facilityId: 'WH-04',
    lines: [['CNT-P', 140, 48, 52, 63], ['GLV-NIT', 160, 55, 60, 140], ['BOX-M', 120, 40, 40, 98]] },
];

interface VanDef { id: string; facilityId: FacilityId; kind: DeliveryVan['kind']; plate: string; driver: string }
export const VAN_DEFS: VanDef[] = [
  { id: 'VAN-101', facilityId: 'WH-01', kind: 'VAN', plate: 'NJ-WT1-101', driver: 'Luis Romero' },
  { id: 'VAN-102', facilityId: 'WH-01', kind: 'VAN', plate: 'NJ-WT1-102', driver: 'Kate Novak' },
  { id: 'VAN-103', facilityId: 'WH-01', kind: 'BOX_TRUCK', plate: 'NJ-WT1-103', driver: 'Jamal Wright' },
  { id: 'VAN-201', facilityId: 'WH-02', kind: 'VAN', plate: 'NJ-WT2-201', driver: 'Mei Tanaka' },
  { id: 'VAN-202', facilityId: 'WH-02', kind: 'VAN', plate: 'NJ-WT2-202', driver: 'Oscar Perez' },
  { id: 'VAN-203', facilityId: 'WH-02', kind: 'BOX_TRUCK', plate: 'NJ-WT2-203', driver: 'Hannah Fisher' },
  { id: 'VAN-401', facilityId: 'WH-04', kind: 'VAN', plate: 'NJ-WT4-401', driver: 'Ravi Kapoor' },
  { id: 'VAN-402', facilityId: 'WH-04', kind: 'VAN', plate: 'NJ-WT4-402', driver: 'Ella Brooks' },
  { id: 'VAN-403', facilityId: 'WH-04', kind: 'BOX_TRUCK', plate: 'NJ-WT4-403', driver: 'Tomás Silva' },
  { id: 'VAN-104', facilityId: 'WH-01', kind: 'VAN', plate: 'NJ-WT1-104', driver: 'Aisha Khan' },
  { id: 'VAN-204', facilityId: 'WH-02', kind: 'VAN', plate: 'NJ-WT2-204', driver: 'Noah Bennett' },
  { id: 'VAN-404', facilityId: 'WH-04', kind: 'VAN', plate: 'NJ-WT4-404', driver: 'Lena Fischer' },
];
export const VAN_SPEED = 12; // units per real second on town and park roads
export const VAN_LOAD_S = 6;
export const VAN_UNLOAD_S = 7;

export function seedRetail(): RetailState {
  const stores: Record<string, Store> = {};
  STORE_DEFS.forEach((d, i) => {
    stores[d.id] = {
      id: d.id, buildingId: d.buildingId, name: d.name, chain: d.chain, kind: d.kind, facilityId: d.facilityId, deliveriesToday: 2 + (i % 3),
      lines: d.lines.map(([skuId, maxUnits, reorderAt, salesPerHour, units], j) => ({
        skuId, units, reorderAt, maxUnits, salesPerHour, acc: 0, soldToday: Math.round(salesPerHour * (2.5 + ((i + j) % 4) * 0.4)),
      })),
    };
  });
  const vans: Record<string, DeliveryVan> = {};
  for (const d of VAN_DEFS) {
    const depot = vanDepot(d.facilityId);
    vans[d.id] = {
      id: d.id, facilityId: d.facilityId, kind: d.kind, plate: d.plate, driver: d.driver, status: 'IDLE', orderId: null, storeId: null,
      dist: 0, timer: 0, pos: depot, heading: Math.PI / 2, tripsToday: 3 + (d.id.charCodeAt(6) % 3),
    };
  }
  return { stores, orders: {}, vans, nextOrder: 5120, log: [] };
}

export const storeDef = (id: string) => STORE_DEFS.find((s) => s.id === id);
export const storeBuilding = (storeId: string): ParkBuilding | undefined => {
  const d = storeDef(storeId);
  return d ? PARK_BUILDINGS.find((b) => b.id === d.buildingId) : undefined;
};
export const storeByBuilding = (buildingId: string) => STORE_DEFS.find((s) => s.buildingId === buildingId);

// ---------------------------------------------------------------- delivery van routes (park coordinates)
/** Where vans leave a warehouse (its yard exit) and come back in (its gate). */
export function vanDepot(fac: FacilityId): Vec2 {
  const o = FACILITY_OFFSET[fac];
  return { x: LAYOUTS[fac].exitX + o.x, z: FENCE_Z - 3 + o.z };
}
function vanGate(fac: FacilityId): Vec2 {
  const o = FACILITY_OFFSET[fac];
  return { x: LAYOUTS[fac].gateX + o.x, z: FENCE_Z - 3 + o.z };
}
/** Loading bay in front of a store (on the Market Street side). */
export function storeDrop(storeId: string): Vec2 {
  const b = storeBuilding(storeId);
  if (!b) return { x: 0, z: MARKET_Z };
  const north = b.rotation === 0; // north side of Market Street, front faces south
  return { x: b.x + (north ? 1 : -1) * Math.min(18, b.w * 0.28), z: north ? b.z + b.d / 2 + 2.5 : b.z - b.d / 2 - 2.5 };
}

/** The town street a store's loading bay is on (Market Street, Bay Road or Shore Road). */
function storeStreetZ(d: Vec2): number {
  return [MARKET_Z, BAY_Z, SHORE_Z].reduce((best, z) => (Math.abs(z - d.z) < Math.abs(best - d.z) ? z : best), MARKET_Z);
}

/** Out to the store: street → avenue (southbound lane) → the store's street → loading bay. */
export function vanPathOut(fac: FacilityId, storeId: string): Vec2[] {
  return cached(`vo${fac}${storeId}`, () => {
    const e = vanDepot(fac);
    const d = storeDrop(storeId);
    const sz = STREETS[FACILITY_STREET[fac]];
    const av = (e.x + d.x) / 2 < 0 || d.x < ART_W + 40 ? ART_W : ART_E;
    const laneZ = sz + (av > e.x ? 3 : -3);
    const mz = storeStreetZ(d) + (d.x > av - 3 ? 3 : -3);
    return roundCorners([e, { x: e.x, z: laneZ }, { x: av - 3, z: laneZ }, { x: av - 3, z: mz }, { x: d.x, z: mz }, d], 6);
  });
}
/** Back to the warehouse: Market Street → avenue (northbound lane) → street → site gate. */
export function vanPathBack(fac: FacilityId, storeId: string): Vec2[] {
  return cached(`vb${fac}${storeId}`, () => {
    const g = vanGate(fac);
    const d = storeDrop(storeId);
    const sz = STREETS[FACILITY_STREET[fac]];
    const av = (g.x + d.x) / 2 < 0 || d.x < ART_W + 40 ? ART_W : ART_E;
    const mz = storeStreetZ(d) + (av + 3 > d.x ? 3 : -3);
    const laneZ = sz + (g.x > av + 3 ? 3 : -3);
    return roundCorners([d, { x: d.x, z: mz }, { x: av + 3, z: mz }, { x: av + 3, z: laneZ }, { x: g.x, z: laneZ }, g], 6);
  });
}
