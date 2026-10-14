// Deterministic operations simulation. Mutates a WorldState in place.
// Every visible movement in the 3D scene is a consequence of these state changes.
import type {
  WorldState, Truck, Forklift, Spot, FacilityId, Vec2, Shipment, EntityRef,
} from '../data/types';
import { LAYOUTS } from '../data/layouts';
import { SKUS } from '../data/seed';
import {
  sampleAt, pathLength, legRoadIn, legYardIn, legReverseIn, legYardOut, legRoadOut, dockedPose,
  spotGeometry, forkliftRoute, homeRoute, FORK_SPEED, ROAD_SPEED, gateInDistance, gateOutDistance,
} from './paths';
import type { GateCode } from '../data/park';
import { stepPort, collectImport, deliverExport, newExportBox, type BoxMove } from './port';
import { stepRetail } from './retail';
import { vesselByPrefix } from '../data/city';

export const TIME_SCALE = 10; // simulated seconds per real second
export const LIFT_TIME = 1.4; // real seconds to pick / set down a pallet
export const TRUCK_KMH = 1.9; // display factor: scene units/s -> km/h
export const FORK_KMH = 2.6;
const INBOUND_TURNAROUND = 24;
const MAX_AWAY = 70; // real seconds a truck spends off the map (delivering / collecting)
const QUEUE_GAP = 16; // spacing of trucks waiting outside a site gate // real seconds a truck is away between inbound trips
const BOOK_WITHIN_SIM = 180; // book a dock when ETA is under 3 minutes

const lenCache = new WeakMap<Vec2[], number>();
export function cachedLength(pts: Vec2[]): number {
  let l = lenCache.get(pts);
  if (l === undefined) { l = pathLength(pts); lenCache.set(pts, l); }
  return l;
}

/** Business operations emitted by the simulation so a backend can persist them. */
export type StockReason = 'RECEIPT' | 'PUTAWAY' | 'PICK' | 'RETURN' | 'STORE_SHIP';
export type SimOp =
  | { k: 'stock'; facilityId: FacilityId; skuId: string; pallets: number; units: number; reason: StockReason; palletId?: string; shipmentId?: string; forkliftId?: string; t: number }
  | { k: 'event'; facilityId: FacilityId; t: number; text: string; ref?: EntityRef }
  | { k: 'docked'; truckId: string }
  | { k: 'workDone'; truckId: string }
  | { k: 'assigned'; forkliftId: string; truckId: string }
  | { k: 'released'; forkliftId: string; truckId: string | null }
  | { k: 'delivered'; shipmentId: string }
  | { k: 'gate'; gate: GateCode; direction: 'IN' | 'OUT'; trade: TradeType; truckId: string; facilityId: FacilityId; shipmentId: string; skuId: string; pallets: number; t: number }
  // container terminal: every box movement (ledger) and every ship's port call
  | { k: 'box'; move: BoxMove; containerNo: string; vesselId: string | null; berthId: string | null; craneId: string | null; truckId: string | null; facilityId: FacilityId | null; t: number }
  | { k: 'call'; phase: 'ARRIVE' | 'DEPART'; vesselId: string; berthId: string; voyage: string; discharged: number; loaded: number; t: number };

/** IMPORT = goods arriving into the park, EXPORT = goods leaving it, EMPTY = truck without cargo. */
export type TradeType = 'IMPORT' | 'EXPORT' | 'EMPTY';

let sink: ((op: SimOp) => void) | null = null;
export function setSimSink(fn: ((op: SimOp) => void) | null): void { sink = fn; }
const emit = (op: SimOp) => { if (sink) sink(op); };

export function pushEvent(w: WorldState, facilityId: FacilityId, text: string, ref?: EntityRef): void {
  emit({ k: 'event', facilityId, t: w.simTime, text, ref });
  w.events.unshift({ t: w.simTime, facilityId, text, ref });
  if (w.events.length > 40) w.events.length = 40;
  w.eventSeq += 1;
}

// ---------------------------------------------------------------- trucks

function poseFromLeg(t: Truck): void {
  const leg = t.legs[t.legIdx];
  if (!leg) return;
  const s = sampleAt(leg.pts, t.legDist);
  t.pos = { x: s.x, z: s.z };
  t.heading = Math.atan2(s.dz, s.dx) + (leg.reverse ? Math.PI : 0);
}

function advanceTruck(t: Truck, dt: number): boolean {
  const leg = t.legs[t.legIdx];
  if (!leg) return true;
  const len = cachedLength(leg.pts);
  const remaining = len - t.legDist;
  const target = Math.min(leg.speed, 0.7 + remaining * 0.8);
  const dv = target - t.speed;
  t.speed += Math.max(-8 * dt, Math.min(3 * dt, dv));
  t.speed = Math.max(0.4, t.speed);
  t.legDist = Math.min(len, t.legDist + t.speed * dt);
  poseFromLeg(t);
  return t.legDist >= len - 1e-3;
}

export function truckRemaining(t: Truck): number {
  let rem = 0;
  for (let i = t.legIdx; i < t.legs.length; i++) {
    const len = cachedLength(t.legs[i].pts);
    rem += i === t.legIdx ? len - t.legDist : len;
  }
  return Math.max(0, rem);
}

/** Estimated simulated seconds until the truck reaches the gate (en route) or its dock. */
export function truckEtaSim(t: Truck): number {
  if (t.phase === 'en_route') return (truckRemaining(t) / ROAD_SPEED) * TIME_SCALE;
  if (t.phase === 'docking') return (truckRemaining(t) / 3.2) * TIME_SCALE;
  return 0;
}

function tryBook(w: WorldState, t: Truck): void {
  if (t.dockId) return;
  const want = t.direction === 'inbound' ? 'in' : 'out';
  const docks = Object.values(w.docks).filter((d) => d.facilityId === t.facilityId && !d.truckId && (d.kind === 'any' || d.kind === want));
  const d = docks[0];
  if (!d) return;
  d.truckId = t.id;
  t.dockId = d.id;
  pushEvent(w, t.facilityId, `${t.id} booked at ${d.name}`, { kind: 'truck', id: t.id });
}

function recordDelivery(w: WorldState, s: Shipment): void {
  s.deliveredAt = w.simTime;
  s.onTime = s.deliveredAt <= s.promisedAt;
  emit({ k: 'delivered', shipmentId: s.id });
  const f = w.facilities[s.facilityId];
  f.deliveries30d += 1;
  if (s.onTime) f.onTime30d += 1;
}

const OUT_CUSTOMERS: [string, string][] = [
  ['Liberty Supply Co.', 'Philadelphia, PA'], ['Harbor & Co.', 'Providence, RI'], ['Metro Office Supply', 'Hoboken, NJ'],
  ['Hudson Clinics', 'Jersey City, NJ'], ['Crestline Hardware', 'Stamford, CT'], ['Bayview Foods', 'Wilmington, DE'],
];
const IN_SUPPLIERS = ['Keystone Paper', 'Oakridge Market', 'Sunvale Grocers', 'Halcyon Retail', 'Atlas Furnishings', 'Brightline Medical'];
const SEA_BUYERS: [string, string][] = [
  ['Rotterdam Trading BV', 'Rotterdam, NL (by sea)'], ['Hanse Import GmbH', 'Hamburg, DE (by sea)'], ['Santos Comercial Ltda', 'Santos, BR (by sea)'],
  ['Lion City Supplies', 'Singapore, SG (by sea)'],
];
const SEA_SHIPPERS: Record<string, string> = {
  OSL: 'Maas Packaging BV', NDH: 'Nordic Workwear A/S', PCC: 'Straits Lighting Pte', BWL: 'Paulista Plásticos', OGW: 'Pearl River Office Co.',
};

function newCycle(w: WorldState, t: Truck): void {
  const n = w.nextShipment++;
  const fac = w.facilities[t.facilityId];
  const sku = fac.inventory[n % fac.inventory.length].skuId;
  const id = `SHP-${n}`;
  const now = w.simTime;
  const workSim = t.capacity * 100;
  const expectedArrival = now + 260 + 320;
  // sea freight: every other import comes in a container from the terminal, every third export leaves by ship
  let lane: Shipment['lane'] = 'ROAD';
  let containerNo: string | null = null;
  let [customer, destination] = t.direction === 'outbound'
    ? OUT_CUSTOMERS[n % OUT_CUSTOMERS.length]
    : [IN_SUPPLIERS[n % IN_SUPPLIERS.length], `${fac.id} ${fac.name}`];
  if (t.direction === 'inbound' && n % 2 === 0) {
    containerNo = collectImport(w, emit, t.id, t.facilityId);
    if (containerNo) {
      lane = 'SEA';
      const v = vesselByPrefix(containerNo);
      customer = `${SEA_SHIPPERS[containerNo.slice(0, 3)] ?? 'Overseas supplier'}${v ? ` · ex ${v.name}` : ''}`;
    }
  } else if (t.direction === 'outbound' && n % 3 === 0) {
    lane = 'SEA';
    containerNo = newExportBox(w);
    [customer, destination] = SEA_BUYERS[n % SEA_BUYERS.length];
  }
  const transitMinutes = t.direction === 'outbound' ? 24 + (n % 4) * 4 : 0;
  const s: Shipment = {
    id, truckId: t.id, facilityId: t.facilityId, direction: t.direction, customer, destination, skuId: sku, pallets: t.capacity,
    confirmedAt: now - 9000 + (n % 7) * 300,
    pickedAt: now - 3600 + (n % 5) * 240,
    loadedAt: t.direction === 'inbound' ? now - 1500 : null,
    transitAt: t.direction === 'inbound' ? now - 600 : null,
    deliveredAt: null,
    promisedAt: expectedArrival + workSim + transitMinutes * 60 + 900,
    transitMinutes,
    onTime: null,
    lane,
    containerNo,
  };
  w.shipments[id] = s;
  // keep the shipment table bounded
  const ids = Object.keys(w.shipments);
  if (ids.length > 60) {
    for (const old of ids.slice(0, ids.length - 60)) {
      if (!Object.values(w.trucks).some((tr) => tr.shipmentId === old)) delete w.shipments[old];
    }
  }
  t.shipmentId = id;
  t.skuId = sku;
  t.cargo = t.direction === 'inbound' ? t.capacity : 0;
  t.phase = 'en_route';
  t.lane = t.direction === 'inbound' ? lane : 'ROAD';
  t.legs = [legRoadIn(t.facilityId, t.lane)];
  t.legIdx = 0;
  t.legDist = 0;
  t.speed = ROAD_SPEED;
  t.dockId = null;
  t.forkliftId = null;
  poseFromLeg(t);
  pushEvent(w, t.facilityId, t.lane === 'SEA'
    ? `${t.id} left Port Newark with import container ${containerNo} for ${fac.id} (${id})`
    : `${t.id} en route to ${fac.id} with ${id}`, { kind: 'truck', id: t.id });
  // outbound trucks keep the trip's lane for the way out (sea exports go to the terminal)
  if (t.direction === 'outbound') t.lane = lane;
}

function passGate(w: WorldState, t: Truck, gate: GateCode): void {
  const inbound = gate === 'WEST';
  const trade: TradeType = t.cargo > 0 ? (inbound ? 'IMPORT' : 'EXPORT') : 'EMPTY';
  const f = w.facilities[t.facilityId];
  if (trade === 'IMPORT') { f.importsToday += 1; f.importPalletsToday += t.cargo; }
  if (trade === 'EXPORT') { f.exportsToday += 1; f.exportPalletsToday += t.cargo; }
  emit({ k: 'gate', gate, direction: inbound ? 'IN' : 'OUT', trade, truckId: t.id, facilityId: t.facilityId, shipmentId: t.shipmentId, skuId: t.skuId, pallets: t.cargo, t: w.simTime });
  const what = trade === 'EMPTY' ? 'empty' : `${trade.toLowerCase()} · ${t.cargo} pallets ${SKUS[t.skuId]?.name ?? ''}`.trim();
  pushEvent(w, t.facilityId, `${t.id} ${inbound ? 'checked in at the West Gate' : 'checked out at the East Gate'} (${what})`, { kind: 'truck', id: t.id });
}

/** Trucks for the same site queue outside its gate instead of stacking on one spot. */
function mustQueue(w: WorldState, t: Truck): boolean {
  const rem = truckRemaining(t);
  if (rem > QUEUE_GAP * 4) return false;
  let ahead = 0;
  for (const o of Object.values(w.trucks)) {
    if (o === t || o.facilityId !== t.facilityId) continue;
    if (o.phase === 'at_gate') ahead++;
    else if (o.phase === 'en_route' && (truckRemaining(o) < rem || (truckRemaining(o) === rem && o.id < t.id))) ahead++;
  }
  return ahead > 0 && rem <= QUEUE_GAP * ahead + 0.01;
}

function stepTruck(w: WorldState, t: Truck, dt: number): void {
  const lane = t.facilityId;
  switch (t.phase) {
    case 'en_route': {
      if (!t.dockId && truckEtaSim(t) < BOOK_WITHIN_SIM) tryBook(w, t);
      if (mustQueue(w, t)) { t.speed = 0; break; }
      const before = t.legDist;
      const arrived = advanceTruck(t, dt);
      const g = gateInDistance(t.facilityId, t.direction === 'inbound' ? t.lane : 'ROAD');
      if (before < g && t.legDist >= g) passGate(w, t, 'WEST');
      if (arrived) {
        t.phase = 'at_gate';
        t.speed = 0;
        pushEvent(w, t.facilityId, `${t.id} arrived at the gate`, { kind: 'truck', id: t.id });
      }
      break;
    }
    case 'at_gate': {
      t.speed = 0;
      if (!t.dockId) tryBook(w, t);
      if (t.dockId && !w.laneLock[lane]) {
        w.laneLock[lane] = t.id;
        t.legs = [legYardIn(t.facilityId, t.dockId), legReverseIn(t.facilityId, t.dockId)];
        t.legIdx = 0;
        t.legDist = 0;
        t.phase = 'docking';
      }
      break;
    }
    case 'docking': {
      if (advanceTruck(t, dt)) {
        if (t.legIdx < t.legs.length - 1) {
          t.legIdx += 1;
          t.legDist = 0;
          t.speed = 0;
        } else {
          t.phase = 'working';
          t.speed = 0;
          t.legs = [];
          if (w.laneLock[lane] === t.id) w.laneLock[lane] = null;
          const d = t.dockId ? w.docks[t.dockId] : null;
          if (d) d.trucksToday += 1;
          emit({ k: 'docked', truckId: t.id });
          pushEvent(w, t.facilityId, `${t.id} docked at ${d?.name ?? 'dock'}`, { kind: 'truck', id: t.id });
        }
      }
      break;
    }
    case 'working': {
      t.speed = 0;
      const done = t.direction === 'inbound' ? t.cargo <= 0 : t.cargo >= t.capacity;
      if (done) {
        const s = w.shipments[t.shipmentId];
        if (s) {
          if (t.direction === 'inbound') recordDelivery(w, s);
          else s.loadedAt = w.simTime;
        }
        t.phase = 'ready';
        emit({ k: 'workDone', truckId: t.id });
        pushEvent(w, t.facilityId, `${t.id} ${t.direction === 'inbound' ? 'unloaded' : 'loaded'} · ${t.capacity} pallets`, { kind: 'truck', id: t.id });
      }
      break;
    }
    case 'ready': {
      t.speed = 0;
      if (!w.laneLock[lane] && t.dockId) {
        w.laneLock[lane] = t.id;
        t.legs = [legYardOut(t.facilityId, t.dockId), legRoadOut(t.facilityId, t.direction === 'outbound' ? t.lane : 'ROAD')];
        t.legIdx = 0;
        t.legDist = 0;
        t.phase = 'departing';
        const d = w.docks[t.dockId];
        if (d && d.truckId === t.id) d.truckId = null;
        const s = w.shipments[t.shipmentId];
        if (t.direction === 'outbound') {
          if (s) s.transitAt = w.simTime;
          w.facilities[t.facilityId].outboundToday += 1;
        }
        pushEvent(w, t.facilityId, `${t.id} departed ${d?.name ?? ''}`.trim(), { kind: 'truck', id: t.id });
      }
      break;
    }
    case 'departing': {
      if (advanceTruck(t, dt)) {
        if (w.laneLock[lane] === t.id) w.laneLock[lane] = null;
        t.legIdx = 1;
        t.legDist = 0;
        t.phase = 'leaving';
      }
      break;
    }
    case 'leaving': {
      const before = t.legDist;
      const done = advanceTruck(t, dt);
      const g = gateOutDistance(t.facilityId);
      if (t.legIdx === 1 && before < g && t.legDist >= g) passGate(w, t, 'EAST');
      if (done) {
        t.phase = 'away';
        t.speed = 0;
        t.dockId = null;
        const s = w.shipments[t.shipmentId];
        if (t.direction === 'outbound' && t.lane === 'SEA' && s?.containerNo) {
          deliverExport(w, emit, s.containerNo, t.id, t.facilityId);
          pushEvent(w, t.facilityId, `${t.id} handed export container ${s.containerNo} to Port Newark for ${s.destination.replace(' (by sea)', '')}`, { kind: 'truck', id: t.id });
        }
        t.awayUntil = w.realTime + Math.min(MAX_AWAY, t.direction === 'outbound' && s ? (s.transitMinutes * 60) / TIME_SCALE : INBOUND_TURNAROUND);
      }
      break;
    }
    case 'away': {
      if (w.realTime >= t.awayUntil) {
        const s = w.shipments[t.shipmentId];
        if (t.direction === 'outbound' && s && s.deliveredAt === null) {
          recordDelivery(w, s);
          pushEvent(w, t.facilityId, `${s.id} delivered to ${s.destination}${s.onTime ? '' : ' (late)'}`, { kind: 'truck', id: t.id });
        }
        newCycle(w, t);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------- forklifts

function slotTaken(w: WorldState, fac: FacilityId, slot: number): boolean {
  for (const p of Object.values(w.pallets)) if (p.facilityId === fac && p.slot === slot) return true;
  for (const f of Object.values(w.forklifts)) {
    if (f.facilityId === fac && f.drop?.type === 'slot' && f.drop.slot === slot) return true;
  }
  return false;
}

function stagedCount(w: WorldState, fac: FacilityId): number {
  return Object.values(w.pallets).filter((p) => p.facilityId === fac && p.slot !== null).length;
}

function adjustStock(
  w: WorldState, fac: FacilityId, skuId: string, pallets: number, units: number, reason: StockReason,
  refs: { palletId?: string; shipmentId?: string; forkliftId?: string } = {},
): void {
  const f = w.facilities[fac];
  const before = f.stock;
  f.stock = Math.max(0, f.stock + pallets);
  const line = f.inventory.find((l) => l.skuId === skuId);
  let du = 0;
  if (line) { const u0 = line.units; line.units = Math.max(0, line.units + units); du = line.units - u0; }
  const dp = f.stock - before;
  if (dp !== 0 || du !== 0) emit({ k: 'stock', facilityId: fac, skuId, pallets: dp, units: du, reason, t: w.simTime, ...refs });
}

function clock(simTime: number): string {
  const h = Math.floor(simTime / 3600) % 24, m = Math.floor(simTime / 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function spotPoints(w: WorldState, f: Forklift, spot: Spot) {
  return spotGeometry(f.facilityId, spot, w.trucks);
}

function planPath(w: WorldState, f: Forklift): void {
  f.pathDist = 0;
  if (f.task === 'to_home') {
    f.path = homeRoute(f.pos, LAYOUTS[f.facilityId].chargers[f.chargerId]);
    return;
  }
  const spot = f.task === 'to_pick' ? f.pick : f.drop;
  if (!spot) { f.path = [f.pos]; return; }
  const g = spotPoints(w, f, spot);
  f.path = forkliftRoute(f.pos, g.approach, g.target);
}

function moveForklift(f: Forklift, dt: number): boolean {
  const len = cachedLength(f.path);
  const remaining = len - f.pathDist;
  const vmax = f.palletId ? FORK_SPEED * 0.85 : FORK_SPEED;
  f.speed = Math.min(vmax, 0.5 + remaining * 1.2);
  f.pathDist = Math.min(len, f.pathDist + f.speed * dt);
  const s = sampleAt(f.path, f.pathDist);
  f.pos = { x: s.x, z: s.z };
  if (len > 0.01) {
    const target = Math.atan2(s.dz, s.dx);
    let d = target - f.heading;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    f.heading += d * Math.min(1, dt * 10);
  }
  f.battery = Math.max(0, f.battery - dt * 0.08);
  return f.pathDist >= len - 1e-3;
}

function findWork(w: WorldState, f: Forklift): boolean {
  const candidates = Object.values(w.trucks).filter((t) =>
    t.facilityId === f.facilityId && t.phase === 'working' && !t.forkliftId &&
    (t.direction === 'inbound' ? t.cargo > 0 : t.cargo < t.capacity));
  if (!candidates.length) return false;
  candidates.sort((a, b) => Math.hypot(a.pos.x - f.pos.x, a.pos.z - f.pos.z) - Math.hypot(b.pos.x - f.pos.x, b.pos.z - f.pos.z));
  const t = candidates[0];
  t.forkliftId = f.id;
  f.truckId = t.id;
  emit({ k: 'assigned', forkliftId: f.id, truckId: t.id });
  startCycle(w, f);
  return true;
}

function startCycle(w: WorldState, f: Forklift): void {
  const t = f.truckId ? w.trucks[f.truckId] : null;
  if (!t || !t.dockId) { release(w, f); return; }
  if (t.direction === 'inbound') {
    f.pick = { type: 'truck', truckId: t.id };
  } else {
    const staged = Object.values(w.pallets)
      .filter((p) => p.facilityId === f.facilityId && p.slot !== null && !p.featured && !p.reserved)
      .sort((a, b) => (a.skuId === t.skuId ? 0 : 1) - (b.skuId === t.skuId ? 0 : 1));
    const p = staged[0];
    if (p && p.slot !== null) {
      p.reserved = true;
      f.pick = { type: 'slot', slot: p.slot };
    } else {
      f.pick = { type: 'store', dockId: t.dockId };
    }
  }
  f.drop = null;
  f.task = 'to_pick';
  f.path = [];
}

function release(w: WorldState, f: Forklift): void {
  emit({ k: 'released', forkliftId: f.id, truckId: f.truckId });
  if (f.truckId) {
    const t = w.trucks[f.truckId];
    if (t && t.forkliftId === f.id) t.forkliftId = null;
  }
  f.truckId = null;
  f.pick = null;
  f.drop = null;
  f.task = 'to_home';
  f.path = [];
}

function doPick(w: WorldState, f: Forklift): void {
  const t = f.truckId ? w.trucks[f.truckId] : null;
  const spot = f.pick;
  if (!t || !spot) { release(w, f); return; }
  if (spot.type === 'truck') {
    if (t.cargo <= 0 || t.phase !== 'working') { release(w, f); return; }
    t.cargo -= 1;
    const sku = SKUS[t.skuId];
    const id = `PAL-${w.nextPallet++}`;
    w.pallets[id] = {
      id, facilityId: f.facilityId, skuId: sku.id, qty: sku.unitsPerPallet, weightKg: sku.kgPerPallet,
      lot: `L${2500 + (w.nextPallet % 9)}-${String(w.nextPallet % 1000).padStart(3, '0')}`,
      received: `Today, ${clock(w.simTime)}`, slot: null, forkliftId: f.id, featured: false, reserved: false,
    };
    f.palletId = id;
    let drop: Spot = { type: 'store', dockId: t.dockId ?? '' };
    const L = LAYOUTS[f.facilityId];
    if (stagedCount(w, f.facilityId) < Math.floor(L.slots.length * 0.55)) {
      const free = L.slots.findIndex((_, i) => !slotTaken(w, f.facilityId, i));
      if (free >= 0) drop = { type: 'slot', slot: free };
    }
    f.drop = drop;
  } else if (spot.type === 'slot') {
    const p = Object.values(w.pallets).find((pp) => pp.facilityId === f.facilityId && pp.slot === spot.slot);
    if (!p) { startCycle(w, f); return; }
    p.slot = null;
    p.reserved = false;
    p.forkliftId = f.id;
    f.palletId = p.id;
    adjustStock(w, f.facilityId, p.skuId, -1, -p.qty, 'PICK', { palletId: p.id, shipmentId: t.shipmentId, forkliftId: f.id });
    f.drop = { type: 'truck', truckId: t.id };
  } else {
    const sku = SKUS[t.skuId];
    const id = `PAL-${w.nextPallet++}`;
    w.pallets[id] = {
      id, facilityId: f.facilityId, skuId: sku.id, qty: sku.unitsPerPallet, weightKg: sku.kgPerPallet,
      lot: `L${2500 + (w.nextPallet % 9)}-${String(w.nextPallet % 1000).padStart(3, '0')}`,
      received: 'In stock', slot: null, forkliftId: f.id, featured: false, reserved: false,
    };
    f.palletId = id;
    adjustStock(w, f.facilityId, sku.id, -1, -sku.unitsPerPallet, 'PICK', { palletId: id, shipmentId: t.shipmentId, forkliftId: f.id });
    f.drop = { type: 'truck', truckId: t.id };
  }
  f.pick = null;
  f.task = 'to_drop';
  f.path = [];
}

function doDrop(w: WorldState, f: Forklift): void {
  const spot = f.drop;
  const p = f.palletId ? w.pallets[f.palletId] : null;
  const t = f.truckId ? w.trucks[f.truckId] : null;
  if (spot && p) {
    if (spot.type === 'truck') {
      const target = w.trucks[spot.truckId];
      if (target && target.phase === 'working' && target.cargo < target.capacity) {
        target.cargo += 1;
        delete w.pallets[p.id];
      } else {
        // truck left: put the pallet back into storage
        adjustStock(w, f.facilityId, p.skuId, 1, p.qty, 'RETURN', { palletId: p.id, forkliftId: f.id });
        delete w.pallets[p.id];
      }
    } else if (spot.type === 'slot') {
      p.slot = spot.slot;
      p.forkliftId = null;
      adjustStock(w, f.facilityId, p.skuId, 1, p.qty, 'RECEIPT', { palletId: p.id, shipmentId: t?.shipmentId, forkliftId: f.id });
    } else {
      adjustStock(w, f.facilityId, p.skuId, 1, p.qty, 'PUTAWAY', { palletId: p.id, shipmentId: t?.shipmentId, forkliftId: f.id });
      w.facilities[f.facilityId].putawaysToday += 1;
      delete w.pallets[p.id];
    }
    f.movesToday += 1;
  }
  f.palletId = null;
  f.drop = null;
  const needsMore = t && t.phase === 'working' && (t.direction === 'inbound' ? t.cargo > 0 : t.cargo < t.capacity);
  if (needsMore && f.battery >= 25) startCycle(w, f);
  else release(w, f);
}

function stepForklift(w: WorldState, f: Forklift, dt: number): void {
  const charger = w.chargers[f.chargerId];
  switch (f.task) {
    case 'idle': {
      f.speed = 0;
      if (f.battery >= 30 && findWork(w, f)) break;
      if (f.battery < 90) {
        f.task = 'charging';
        if (charger) charger.sessionsToday += 1;
      }
      break;
    }
    case 'charging': {
      f.speed = 0;
      if (f.battery >= 80 && findWork(w, f)) break;
      const gain = ((charger?.ratePctPerMin ?? 8) / 60) * TIME_SCALE * dt;
      f.battery = Math.min(100, f.battery + gain);
      if (charger) charger.energyKwh += gain * 0.012;
      if (f.battery >= 100) f.task = 'idle';
      break;
    }
    case 'to_pick':
    case 'to_drop':
    case 'to_home': {
      if (!f.path.length) planPath(w, f);
      if (moveForklift(f, dt)) {
        f.speed = 0;
        if (f.task === 'to_home') {
          f.task = f.battery < 90 ? 'charging' : 'idle';
          if (f.task === 'charging' && charger) charger.sessionsToday += 1;
        } else {
          f.task = f.task === 'to_pick' ? 'lifting' : 'dropping';
          f.timer = LIFT_TIME;
        }
        f.path = [];
      }
      break;
    }
    case 'lifting':
    case 'dropping': {
      f.speed = 0;
      f.timer -= dt;
      if (f.timer <= 0) {
        if (f.task === 'lifting') doPick(w, f);
        else doDrop(w, f);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------- public

export function syncPoses(w: WorldState): void {
  for (const t of Object.values(w.trucks)) {
    if ((t.phase === 'working' || t.phase === 'ready') && t.dockId) {
      const p = dockedPose(t.facilityId, t.dockId);
      t.pos = p.pos;
      t.heading = p.heading;
    } else if (t.legs.length) {
      poseFromLeg(t);
    }
  }
}

export function stepWorld(w: WorldState, dtReal: number): void {
  const dt = Math.min(Math.max(dtReal, 0), 0.25);
  w.realTime += dt;
  w.simTime += dt * TIME_SCALE;
  if (w.simTime >= 86400) w.simTime -= 86400;
  for (const t of Object.values(w.trucks)) stepTruck(w, t, dt);
  for (const f of Object.values(w.forklifts)) stepForklift(w, f, dt);
  if (w.port) stepPort(w, dt, emit);
  if (w.retail) {
    stepRetail(w, dt, {
      emit,
      event: (fac, text, ref) => pushEvent(w, fac, text, ref),
      takeStock: (fac, skuId, units, orderId) => {
        const line = w.facilities[fac]?.inventory.find((l) => l.skuId === skuId);
        if (!line) return 0;
        const got = Math.min(units, line.units);
        if (got <= 0) return 0;
        line.units -= got;
        emit({ k: 'stock', facilityId: fac, skuId, pallets: 0, units: -got, reason: 'STORE_SHIP', shipmentId: orderId, t: w.simTime });
        return got;
      },
    });
  }
}

export { clock as formatClock };
