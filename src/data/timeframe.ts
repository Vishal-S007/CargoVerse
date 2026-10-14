// The time machine: a "frame" is the state of the moving things in the city at one
// moment in the past. In Oracle mode the server reads it with Flashback Query
// (SELECT … AS OF SCN); without Oracle it comes from snapshots the server keeps in
// memory. The client lays a frame over a copy of the live world and renders that.
import type { WorldState, TruckPhase, ForkliftTask, Spot, VesselStatus, VanStatus, StoreOrderStatus, FacilityId, QuayCrane } from './types';

export interface FrameTruck {
  phase: TruckPhase; dockId: string | null; cargo: number; shipmentId: string; skuId: string; forkliftId: string | null;
  legIdx: number; legDist: number; x: number; z: number; heading: number; speed: number; away: number; lane: 'ROAD' | 'SEA';
}
export interface FrameForklift {
  battery: number; task: ForkliftTask; truckId: string | null; palletId: string | null; moves: number;
  x: number; z: number; heading: number; timer: number; pick: Spot | null; drop: Spot | null;
}
export interface FramePallet {
  facilityId: FacilityId; skuId: string; qty: number; weightKg: number; lot: string; received: string;
  slot: number | null; forkliftId: string | null; featured: boolean; reserved: boolean;
}
export interface FrameVessel {
  status: VesselStatus; berthId: string | null; hold: boolean; importBoxes: number; exportBoxes: number;
  discharged: number; loaded: number; dist: number; timer: number; waited: number; x: number; z: number; heading: number;
}
export interface FrameVan { status: VanStatus; orderId: string | null; storeId: string | null; dist: number; timer: number; x: number; z: number; heading: number }
export interface FrameOrder { status: StoreOrderStatus; units: number; vanId: string | null }

export interface TimeFrame {
  /** 'flashback' = read from Oracle with AS OF SCN; 'memory' = the server's in-memory history. */
  source: 'flashback' | 'memory';
  at: string; // wall-clock time of the frame (ISO)
  secondsAgo: number;
  scn: number | null;
  simTime: number;
  realTime: number;
  trucks: Record<string, FrameTruck>;
  forklifts: Record<string, FrameForklift>;
  pallets: Record<string, FramePallet>;
  docks: Record<string, { truckId: string | null; trucksToday: number }>;
  vessels: Record<string, FrameVessel>;
  berths: Record<string, { open: boolean; vesselId: string | null }>;
  cranes: Record<string, { phase: QuayCrane['phase']; cycle: number; moves: number }>;
  importStack: string[];
  exportStack: string[];
  storeLines: Record<string, { units: number; soldToday: number }>; // key "ST-01:BOX-M"
  vans: Record<string, FrameVan>;
  orders: Record<string, FrameOrder>;
  /** What was read (table → rows) and the SQL that read it (Oracle mode). */
  rows: Record<string, number>;
  sql: string[];
  note?: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Captures the moving parts of the world (used for the in-memory history). */
export function captureFrame(w: WorldState, at = new Date()): TimeFrame {
  const f: TimeFrame = {
    source: 'memory', at: at.toISOString(), secondsAgo: 0, scn: null, simTime: w.simTime, realTime: w.realTime,
    trucks: {}, forklifts: {}, pallets: {}, docks: {}, vessels: {}, berths: {}, cranes: {}, importStack: [], exportStack: [],
    storeLines: {}, vans: {}, orders: {}, rows: {}, sql: [],
  };
  for (const t of Object.values(w.trucks)) {
    f.trucks[t.id] = {
      phase: t.phase, dockId: t.dockId, cargo: t.cargo, shipmentId: t.shipmentId, skuId: t.skuId, forkliftId: t.forkliftId,
      legIdx: t.legIdx, legDist: r2(t.legDist), x: r2(t.pos.x), z: r2(t.pos.z), heading: t.heading, speed: r2(t.speed),
      away: r2(Math.max(0, t.awayUntil - w.realTime)), lane: t.lane ?? 'ROAD',
    };
  }
  for (const k of Object.values(w.forklifts)) {
    f.forklifts[k.id] = {
      battery: r2(k.battery), task: k.task, truckId: k.truckId, palletId: k.palletId, moves: k.movesToday,
      x: r2(k.pos.x), z: r2(k.pos.z), heading: k.heading, timer: r2(k.timer), pick: k.pick, drop: k.drop,
    };
  }
  for (const p of Object.values(w.pallets)) {
    f.pallets[p.id] = {
      facilityId: p.facilityId, skuId: p.skuId, qty: p.qty, weightKg: p.weightKg, lot: p.lot, received: p.received,
      slot: p.slot, forkliftId: p.forkliftId, featured: p.featured, reserved: p.reserved,
    };
  }
  for (const d of Object.values(w.docks)) f.docks[d.id] = { truckId: d.truckId, trucksToday: d.trucksToday };
  if (w.port) {
    for (const v of Object.values(w.port.vessels)) {
      f.vessels[v.id] = {
        status: v.status, berthId: v.berthId, hold: v.hold, importBoxes: v.importBoxes, exportBoxes: v.exportBoxes,
        discharged: v.discharged, loaded: v.loaded, dist: r2(v.dist), timer: r2(v.timer), waited: r2(v.waited),
        x: r2(v.pos.x), z: r2(v.pos.z), heading: v.heading,
      };
    }
    for (const b of Object.values(w.port.berths)) f.berths[b.id] = { open: b.open, vesselId: b.vesselId };
    for (const c of Object.values(w.port.cranes)) f.cranes[c.id] = { phase: c.phase, cycle: r2(c.cycle), moves: c.movesToday };
    f.importStack = w.port.importStack.slice();
    f.exportStack = w.port.exportStack.slice();
  }
  if (w.retail) {
    for (const s of Object.values(w.retail.stores)) for (const l of s.lines) f.storeLines[`${s.id}:${l.skuId}`] = { units: Math.round(l.units), soldToday: l.soldToday };
    for (const v of Object.values(w.retail.vans)) {
      f.vans[v.id] = { status: v.status, orderId: v.orderId, storeId: v.storeId, dist: r2(v.dist), timer: r2(v.timer), x: r2(v.pos.x), z: r2(v.pos.z), heading: v.heading };
    }
    for (const o of Object.values(w.retail.orders)) f.orders[o.id] = { status: o.status, units: o.units, vanId: o.vanId };
  }
  return f;
}

/**
 * Lays a frame over a copy of the live world. Only things the live world already
 * knows about are moved (the snapshot is limited to the user's sites); pallets are
 * rebuilt for the sites in the copy, because pallets come and go.
 */
export function applyFrame(live: WorldState, f: TimeFrame): WorldState {
  const w: WorldState = JSON.parse(JSON.stringify(live));
  w.simTime = f.simTime;
  w.realTime = f.realTime;
  for (const [id, x] of Object.entries(f.trucks)) {
    const t = w.trucks[id];
    if (!t) continue;
    Object.assign(t, {
      phase: x.phase, dockId: x.dockId, cargo: x.cargo, skuId: x.skuId, forkliftId: x.forkliftId, legIdx: x.legIdx, legDist: x.legDist,
      pos: { x: x.x, z: x.z }, heading: x.heading, speed: x.speed, awayUntil: f.realTime + x.away, lane: x.lane,
    });
    if (w.shipments[x.shipmentId]) t.shipmentId = x.shipmentId;
  }
  for (const [id, x] of Object.entries(f.forklifts)) {
    const k = w.forklifts[id];
    if (!k) continue;
    Object.assign(k, {
      battery: x.battery, task: x.task, truckId: x.truckId, palletId: x.palletId, movesToday: x.moves, pos: { x: x.x, z: x.z },
      heading: x.heading, timer: x.timer, pick: x.pick, drop: x.drop, path: [], speed: 0,
    });
  }
  const sites = new Set(Object.keys(w.facilities));
  const pallets: WorldState['pallets'] = {};
  for (const [id, p] of Object.entries(f.pallets)) {
    if (!sites.has(p.facilityId)) continue;
    pallets[id] = { id, ...p };
  }
  w.pallets = pallets;
  for (const [id, d] of Object.entries(f.docks)) {
    const dock = w.docks[id];
    if (dock) { dock.truckId = d.truckId; dock.trucksToday = d.trucksToday; }
  }
  if (w.port) {
    for (const [id, x] of Object.entries(f.vessels)) {
      const v = w.port.vessels[id];
      if (!v) continue;
      Object.assign(v, {
        status: x.status, berthId: x.berthId, hold: x.hold, importBoxes: x.importBoxes, exportBoxes: x.exportBoxes, discharged: x.discharged,
        loaded: x.loaded, dist: x.dist, timer: x.timer, waited: x.waited, pos: { x: x.x, z: x.z }, heading: x.heading,
      });
    }
    for (const [id, b] of Object.entries(f.berths)) { const x = w.port.berths[id]; if (x) { x.open = b.open; x.vesselId = b.vesselId; } }
    for (const [id, c] of Object.entries(f.cranes)) { const x = w.port.cranes[id]; if (x) { x.phase = c.phase; x.cycle = c.cycle; x.movesToday = c.moves; } }
    w.port.importStack = f.importStack.slice();
    w.port.exportStack = f.exportStack.slice();
  }
  if (w.retail) {
    for (const s of Object.values(w.retail.stores)) {
      for (const l of s.lines) {
        const x = f.storeLines[`${s.id}:${l.skuId}`];
        if (x) { l.units = x.units; l.soldToday = x.soldToday; }
      }
    }
    for (const [id, x] of Object.entries(f.vans)) {
      const v = w.retail.vans[id];
      if (v) Object.assign(v, { status: x.status, orderId: x.orderId, storeId: x.storeId, dist: x.dist, timer: x.timer, pos: { x: x.x, z: x.z }, heading: x.heading });
    }
    for (const [id, o] of Object.entries(w.retail.orders)) {
      const x = f.orders[id];
      if (x) { o.status = x.status; o.units = x.units; o.vanId = x.vanId; } else if (Object.keys(f.orders).length) delete w.retail.orders[id];
    }
  }
  return w;
}

/** Interpolation-free nearest frame from a list sorted by time (oldest first). */
export function nearestFrame(frames: TimeFrame[], at: number): TimeFrame | null {
  if (!frames.length) return null;
  let best = frames[0];
  for (const f of frames) if (Math.abs(Date.parse(f.at) - at) < Math.abs(Date.parse(best.at) - at)) best = f;
  return best;
}
