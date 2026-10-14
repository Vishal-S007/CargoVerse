// Container terminal simulation: ships approach, wait at anchor for a free berth,
// berth, have their import boxes discharged and export boxes loaded by the quay
// cranes, then sail. Every container move is emitted for the database ledger.
import type { WorldState, Vessel, FacilityId, EntityRef } from '../data/types';
import {
  approachPath, berthingPath, departurePath, legLength, vesselPose, containerNo, voyageCode, vesselByPrefix,
  CRANE_CYCLE_S, SHIP_SPEED, LOCAL_PREFIX,
} from '../data/city';
import type { SimOp } from './engine';

type Emit = (op: SimOp) => void;
export type BoxMove = 'DISCHARGE' | 'LOAD' | 'GATE_OUT' | 'GATE_IN';

const EXT_EVERY = 6; // real seconds between hauliers / shippers not modelled as CargoVerse trucks

export function portLog(w: WorldState, text: string, ref?: EntityRef): void {
  w.port.log.unshift({ t: w.simTime, text, ref });
  if (w.port.log.length > 30) w.port.log.length = 30;
}

function box(w: WorldState, emit: Emit, move: BoxMove, no: string, o: { vessel?: Vessel; craneId?: string; truckId?: string; facilityId?: FacilityId } = {}): void {
  w.port.movesToday += move === 'DISCHARGE' || move === 'LOAD' ? 1 : 0;
  if (move === 'GATE_OUT') w.port.gateOutToday += 1;
  if (move === 'GATE_IN') w.port.gateInToday += 1;
  emit({
    k: 'box', move, containerNo: no, vesselId: o.vessel?.id ?? null, berthId: o.vessel?.berthId ?? null, craneId: o.craneId ?? null,
    truckId: o.truckId ?? null, facilityId: o.facilityId ?? null, t: w.simTime,
  });
}

/** A CargoVerse truck collects the oldest import box (returns its number, or null if the stack is empty). */
export function collectImport(w: WorldState, emit: Emit, truckId: string, facilityId: FacilityId): string | null {
  const no = w.port.importStack.shift();
  if (!no) return null;
  box(w, emit, 'GATE_OUT', no, { truckId, facilityId });
  const v = vesselByPrefix(no);
  portLog(w, `${truckId} collected ${no}${v ? ` (ex ${v.name})` : ''} for ${facilityId}`, { kind: 'truck', id: truckId });
  return no;
}

/** A CargoVerse truck drops an export box at the terminal. */
export function deliverExport(w: WorldState, emit: Emit, no: string, truckId: string, facilityId: FacilityId): void {
  w.port.exportStack.push(no);
  box(w, emit, 'GATE_IN', no, { truckId, facilityId });
  portLog(w, `${truckId} delivered export box ${no} from ${facilityId}`, { kind: 'truck', id: truckId });
}

export const newExportBox = (w: WorldState): string => containerNo(LOCAL_PREFIX, w.port.nextBox++);

function startVoyage(w: WorldState, v: Vessel): void {
  v.calls += 1;
  v.status = 'ARRIVING';
  v.dist = 0;
  v.berthId = null;
  v.importBoxes = 10 + ((v.calls * 7) % 7);
  v.exportTarget = 8 + ((v.calls * 5) % 6);
  v.exportBoxes = 0;
  v.discharged = 0;
  v.loaded = 0;
  v.waited = 0;
  v.arrivedAt = null;
  v.voyage = voyageCode(v.calls, v.calls % 2 === 0);
  portLog(w, `${v.name} (${v.voyage}) is approaching from ${v.origin} with ${v.importBoxes} boxes for this port`, { kind: 'vessel', id: v.id });
}

function canWork(w: WorldState, v: Vessel): 'discharge' | 'load' | null {
  const P = w.port;
  if (v.importBoxes > 0) return P.importStack.length < P.yardCapacity ? 'discharge' : null;
  const room = v.capacity - v.through - v.exportBoxes;
  if (v.exportBoxes < v.exportTarget && room > 0 && P.exportStack.length > 0) return 'load';
  return null;
}

export function stepPort(w: WorldState, dt: number, emit: Emit): void {
  const P = w.port;
  const vessels = Object.values(P.vessels);

  // berths go to the ship that has waited longest at anchor
  const waiting = vessels.filter((v) => v.status === 'ANCHORED' && !v.hold).sort((a, b) => b.waited - a.waited);
  for (const v of waiting) {
    const berth = Object.values(P.berths).find((b) => b.open && !b.vesselId);
    if (!berth) break;
    berth.vesselId = v.id;
    v.berthId = berth.id;
    v.status = 'BERTHING';
    v.dist = 0;
    portLog(w, `${v.name} cleared to ${berth.name} — pilots on board`, { kind: 'vessel', id: v.id });
  }

  for (const v of vessels) {
    switch (v.status) {
      case 'AT_SEA':
        if (!v.hold) v.timer -= dt;
        if (v.timer <= 0) startVoyage(w, v);
        break;
      case 'ARRIVING': {
        v.dist += SHIP_SPEED.approach * dt;
        if (v.dist >= legLength(approachPath(v.slot))) {
          v.status = 'ANCHORED';
          v.dist = 0;
          v.waited = 0;
          portLog(w, `${v.name} anchored in the bay, waiting for a berth`, { kind: 'vessel', id: v.id });
        }
        break;
      }
      case 'ANCHORED':
        v.waited += dt;
        break;
      case 'BERTHING': {
        v.dist += SHIP_SPEED.berthing * dt;
        if (v.dist >= legLength(berthingPath(v.slot, v.berthId ?? 'B1'))) {
          v.status = 'BERTHED';
          v.timer = 3; // lines made fast, lashing gangs aboard
          v.arrivedAt = w.simTime;
          P.callsToday += 1;
          emit({ k: 'call', phase: 'ARRIVE', vesselId: v.id, berthId: v.berthId ?? 'B1', voyage: v.voyage, discharged: 0, loaded: 0, t: w.simTime });
          portLog(w, `${v.name} alongside ${P.berths[v.berthId ?? 'B1']?.name ?? 'the quay'} — discharging ${v.importBoxes} boxes`, { kind: 'vessel', id: v.id });
        }
        break;
      }
      case 'BERTHED': {
        if (v.timer > 0) v.timer -= dt;
        const work = canWork(w, v);
        const busy = Object.values(P.cranes).some((c) => c.berthId === v.berthId && c.phase !== 'idle');
        // sail when there is nothing left to do (and the manager has not held the ship)
        if (!work && !busy && v.timer <= 0 && !v.hold && (v.importBoxes === 0)) {
          const berth = v.berthId ? P.berths[v.berthId] : null;
          emit({ k: 'call', phase: 'DEPART', vesselId: v.id, berthId: v.berthId ?? 'B1', voyage: v.voyage, discharged: v.discharged, loaded: v.loaded, t: w.simTime });
          portLog(w, `${v.name} sailed for ${v.nextPort} · ${v.discharged} off, ${v.loaded} on`, { kind: 'vessel', id: v.id });
          if (berth && berth.vesselId === v.id) berth.vesselId = null;
          v.status = 'DEPARTING';
          v.dist = 0;
        }
        break;
      }
      case 'DEPARTING': {
        v.dist += SHIP_SPEED.departure * dt;
        if (v.dist >= legLength(departurePath(v.berthId ?? 'B1'))) {
          v.status = 'AT_SEA';
          v.dist = 0;
          v.berthId = null;
          v.timer = 40 + ((v.calls * 13) % 40);
        }
        break;
      }
    }
    const p = vesselPose(v);
    v.pos = p.pos;
    v.heading = p.heading;
  }

  // quay cranes: one container per cycle, alternating between ship and quay
  for (const c of Object.values(P.cranes)) {
    const berth = P.berths[c.berthId];
    const v = berth?.vesselId ? P.vessels[berth.vesselId] : undefined;
    const ready = v && v.status === 'BERTHED' && v.timer <= 2.5;
    if (c.phase === 'idle') {
      const work = ready ? canWork(w, v!) : null;
      if (work) { c.phase = work; c.cycle = 0; }
      continue;
    }
    c.cycle += dt / CRANE_CYCLE_S;
    if (c.cycle < 1) continue;
    c.cycle = 0;
    if (!v || v.status !== 'BERTHED') { c.phase = 'idle'; continue; }
    if (c.phase === 'discharge' && v.importBoxes > 0 && P.importStack.length < P.yardCapacity) {
      v.importBoxes -= 1;
      v.discharged += 1;
      const no = containerNo(v.prefix, P.nextBox++);
      P.importStack.push(no);
      c.movesToday += 1;
      box(w, emit, 'DISCHARGE', no, { vessel: v, craneId: c.id });
      if (v.importBoxes === 0) portLog(w, `${v.name}: discharge complete (${v.discharged} boxes) — loading exports`, { kind: 'vessel', id: v.id });
    } else if (c.phase === 'load' && P.exportStack.length > 0 && v.exportBoxes < v.exportTarget) {
      const no = P.exportStack.shift()!;
      v.exportBoxes += 1;
      v.loaded += 1;
      c.movesToday += 1;
      box(w, emit, 'LOAD', no, { vessel: v, craneId: c.id });
    }
    v.timer = Math.max(v.timer, 2); // linger briefly after the last move
    const next = canWork(w, v);
    c.phase = next ?? 'idle';
  }

  // other hauliers and shippers keep the stacks moving
  P.extTimer += dt;
  if (P.extTimer >= EXT_EVERY) {
    P.extTimer = 0;
    if (P.importStack.length > 26) {
      const no = P.importStack.shift()!;
      box(w, emit, 'GATE_OUT', no);
    }
    if (P.exportStack.length < 18) {
      const prefixes = ['OSL', 'NDH', 'PCC', 'BWL', 'OGW'];
      const no = containerNo(prefixes[P.nextBox % prefixes.length], P.nextBox++);
      P.exportStack.push(no);
      box(w, emit, 'GATE_IN', no);
    }
  }
}
