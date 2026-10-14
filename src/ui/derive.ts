// View-model selectors: everything the 2D interface displays is derived here
// from the world state, so panels, lists, KPIs and the timeline stay consistent.
import { toPark, PARK_GATES, type GateCode } from '../data/park';
import { findBuilding, findVehicle, vehicleNow, getPark } from '../data/parkClient';
import type { WorldState, Truck, FacilityId, EntityRef, Forklift, Dock, Vessel, DeliveryVan, Store } from '../data/types';
import { SKUS, CARRIER_LABEL, carrierName } from '../data/seed';
import { LAYOUTS } from '../data/layouts';
import { MOOR_Z, QUAY_Z, storeBuilding } from '../data/city';
import { truckEtaSim, truckRemaining, cachedLength, TIME_SCALE, TRUCK_KMH, FORK_KMH } from '../sim/engine';

export type Tone = 'green' | 'blue' | 'orange' | 'grey' | 'yellow' | 'indigo';
export interface Badge { label: string; tone: Tone }

const PALLET_SIM_SECONDS = 100; // average simulated seconds per pallet move

export const fmtClock = (t: number): string => {
  const v = ((t % 86400) + 86400) % 86400;
  return `${String(Math.floor(v / 3600)).padStart(2, '0')}:${String(Math.floor(v / 60) % 60).padStart(2, '0')}`;
};
export const fmtNum = (n: number): string => Math.round(n).toLocaleString('en-US');
export const mins = (simSeconds: number): number => Math.max(1, Math.floor(simSeconds / 60));
export const shortCharger = (id: string): string => id.split('-').pop() ?? id;
export const fmtWeight = (kg: number): string => (kg >= 1000 ? `${(kg / 1000).toFixed(1)} t` : `${Math.round(kg)} kg`);

export function trucksOf(w: WorldState, fac: FacilityId): Truck[] {
  return Object.values(w.trucks).filter((t) => t.facilityId === fac);
}
export function docksOf(w: WorldState, fac: FacilityId): Dock[] {
  return Object.values(w.docks).filter((d) => d.facilityId === fac);
}
export function forkliftsOf(w: WorldState, fac: FacilityId): Forklift[] {
  return Object.values(w.forklifts).filter((f) => f.facilityId === fac);
}

const ON_SITE = new Set(['at_gate', 'docking', 'working', 'ready', 'departing']);

// ---------------------------------------------------------------- KPIs / header

export function kpis(w: WorldState, fac: FacilityId) {
  const f = w.facilities[fac];
  const trucks = trucksOf(w, fac);
  const onSite = trucks.filter((t) => ON_SITE.has(t.phase)).length;
  const inbound = trucks.filter((t) => t.direction === 'inbound' && t.phase !== 'away' && t.phase !== 'leaving').length;
  const otd = (f.onTime30d / Math.max(1, f.deliveries30d)) * 100;
  return {
    stock: f.stock,
    stockDelta: f.stock - f.stockStart,
    onSite,
    onSiteDelta: onSite - f.trucksOnSiteStart,
    inbound,
    otd,
    otdDelta: otd - f.otdPrevPct,
  };
}

export function facilityHeadline(w: WorldState, fac: FacilityId) {
  const f = w.facilities[fac];
  const docks = docksOf(w, fac);
  const docked = docks.filter((d) => d.truckId && ['working', 'ready'].includes(w.trucks[d.truckId]?.phase)).length;
  return { fullPct: Math.round((f.stock / f.capacity) * 100), docked, docksTotal: docks.length };
}

// ---------------------------------------------------------------- trucks

export function truckDone(t: Truck): number {
  return t.direction === 'inbound' ? t.capacity - t.cargo : t.cargo;
}

export function truckBadge(t: Truck): Badge {
  switch (t.phase) {
    case 'en_route': return { label: 'En route', tone: 'blue' };
    case 'at_gate': return { label: 'At gate', tone: 'orange' };
    case 'docking': return { label: 'Docking', tone: 'indigo' };
    case 'working': return t.direction === 'inbound' ? { label: 'Unloading', tone: 'green' } : { label: 'Loading', tone: 'green' };
    case 'ready': return { label: 'Ready', tone: 'green' };
    case 'departing':
    case 'leaving': return { label: 'Departing', tone: 'blue' };
    case 'away': return t.direction === 'outbound' ? { label: 'In transit', tone: 'blue' } : { label: 'Off site', tone: 'grey' };
  }
}

/** Simulated seconds until the current stage of the truck's work is complete. */
export function workRemainingSim(w: WorldState, t: Truck): number {
  const left = t.direction === 'inbound' ? t.cargo : t.capacity - t.cargo;
  const arrive = t.phase === 'en_route' ? truckEtaSim(t) + 420 : t.phase === 'at_gate' ? 360 : t.phase === 'docking' ? truckEtaSim(t) : 0;
  void w;
  return arrive + left * PALLET_SIM_SECONDS;
}

export function awayRemainingSim(w: WorldState, t: Truck): number {
  return Math.max(0, (t.awayUntil - w.realTime) * TIME_SCALE);
}

export function truckView(w: WorldState, t: Truck) {
  const fac = w.facilities[t.facilityId];
  const dock = t.dockId ? w.docks[t.dockId] : null;
  const s = w.shipments[t.shipmentId];
  const sku = SKUS[t.skuId];
  const done = truckDone(t);
  let activity = '';
  let progress = 0;
  let right = '';
  let eta = '—';
  const leg = t.legs[t.legIdx];
  switch (t.phase) {
    case 'en_route': {
      const e = truckEtaSim(t);
      activity = `To ${fac.id} · ETA ${mins(e)} min`;
      progress = leg ? t.legDist / cachedLength(leg.pts) : 0;
      right = `${mins(e)} min left`;
      eta = `${fmtClock(w.simTime + e)} (${mins(e)} min)`;
      break;
    }
    case 'at_gate':
      activity = `Waiting for ${dock?.name ?? 'a free dock'} · ${fac.id}`;
      progress = 1;
      right = 'at gate';
      eta = `${fmtClock(w.simTime + 360)} (6 min)`;
      break;
    case 'docking': {
      const rem = truckRemaining(t);
      const total = t.legs.reduce((a, l) => a + cachedLength(l.pts), 0);
      activity = `${t.legIdx === 1 ? 'Reversing into' : 'Driving to'} ${dock?.name ?? 'dock'} · ${fac.id}`;
      progress = 1 - rem / Math.max(1, total);
      right = `${Math.round(rem)} m left`;
      const e = truckEtaSim(t);
      eta = `${fmtClock(w.simTime + e)} (${mins(e)} min)`;
      break;
    }
    case 'working': {
      activity = `${fac.id} · ${dock?.name ?? ''} · ${done}/${t.capacity} pallets`;
      progress = done / t.capacity;
      right = `${done}/${t.capacity}`;
      eta = `Done in ${mins(workRemainingSim(w, t))} min`;
      break;
    }
    case 'ready':
      activity = `${fac.id} · ${dock?.name ?? ''} · waiting to depart`;
      progress = 1;
      right = `${done}/${t.capacity}`;
      eta = 'Ready to depart';
      break;
    case 'departing':
    case 'leaving': {
      activity = `Leaving ${fac.id}`;
      const rem = truckRemaining(t);
      const total = t.legs.reduce((a, l) => a + cachedLength(l.pts), 0);
      progress = 1 - rem / Math.max(1, total);
      right = `${Math.round(rem)} m left`;
      eta = t.direction === 'outbound' && s ? fmtClock(w.simTime + s.transitMinutes * 60) : '—';
      break;
    }
    case 'away': {
      const r = awayRemainingSim(w, t);
      if (t.direction === 'outbound' && s) {
        activity = `To ${s.destination}`;
        progress = 1 - r / Math.max(1, s.transitMinutes * 60);
        right = `${mins(r)} min left`;
        eta = `${fmtClock(w.simTime + r)} (${mins(r)} min)`;
      } else {
        activity = 'Off site · next pickup';
        progress = 0;
        right = `back in ${mins(r)} min`;
      }
      break;
    }
  }
  const moved = done * (sku?.kgPerPallet ?? 0);
  return {
    header: CARRIER_LABEL[t.carrier].toUpperCase(),
    title: t.id,
    subtitle: `${t.driver} · ${t.plate}`,
    badge: truckBadge(t),
    activity,
    progress: Math.max(0, Math.min(1, progress)),
    right,
    rows: [
      { k: 'Shipment', v: s ? `#${s.id}` : '—', link: true },
      { k: 'Customer', v: s?.customer ?? '—', link: true },
      { k: 'Destination', v: s?.destination ?? '—', link: true },
      { k: 'ETA', v: eta },
      { k: 'Speed', v: `${Math.round(t.speed * TRUCK_KMH)} km/h` },
      { k: 'Bay', v: dock ? `${dock.name} · ${fac.id}` : '—', ref: dock ? ({ kind: 'dock', id: dock.id } as EntityRef) : undefined },
      { k: 'Cargo', v: `${done}/${t.capacity} pallets · ${fmtWeight(moved)}` },
      ...(s?.containerNo ? [{ k: 'Container', v: `${s.containerNo} · ${t.direction === 'inbound' ? 'import via Port Newark' : 'export by sea'}`, ref: { kind: 'building', id: 'PB-PORT' } as EntityRef }] : []),
    ],
  };
}

// ---------------------------------------------------------------- container port and vendor stores

export function vesselActivity(w: WorldState, v: Vessel): { text: string; badge: Badge; progress: number } {
  const berth = v.berthId ? w.port.berths[v.berthId]?.name ?? v.berthId : '';
  switch (v.status) {
    case 'AT_SEA': {
      const min = Math.max(1, Math.round((v.timer * TIME_SCALE) / 60));
      return { text: `At sea · ${v.hold ? 'held by the port' : `due in about ${min} min`} from ${v.origin}`, badge: { label: v.hold ? 'Held' : 'At sea', tone: 'grey' }, progress: 0 };
    }
    case 'ARRIVING': return { text: `Inbound from ${v.origin} to the anchorage`, badge: { label: 'Arriving', tone: 'blue' }, progress: 0.2 };
    case 'ANCHORED': return { text: v.hold ? 'Held at anchor by the port manager' : 'At anchor, waiting for a free berth', badge: { label: v.hold ? 'Held' : 'At anchor', tone: v.hold ? 'orange' : 'yellow' }, progress: 0.3 };
    case 'BERTHING': return { text: `Pilots bringing her alongside ${berth}`, badge: { label: 'Berthing', tone: 'blue' }, progress: 0.4 };
    case 'BERTHED': {
      const total = v.discharged + v.importBoxes + Math.max(v.exportTarget, v.loaded);
      const done = v.discharged + v.loaded;
      if (v.importBoxes > 0) return { text: `${berth} · discharging · ${v.importBoxes} boxes to go`, badge: { label: 'Discharging', tone: 'indigo' }, progress: done / Math.max(1, total) };
      if (v.hold) return { text: `${berth} · held alongside by the port manager`, badge: { label: 'Held', tone: 'orange' }, progress: done / Math.max(1, total) };
      return { text: `${berth} · loading exports · ${v.loaded}/${v.exportTarget}`, badge: { label: 'Loading', tone: 'green' }, progress: done / Math.max(1, total) };
    }
    case 'DEPARTING': return { text: `Sailed for ${v.nextPort} · ${v.discharged} off, ${v.loaded} on`, badge: { label: 'Departing', tone: 'grey' }, progress: 1 };
  }
}

export function vanActivity(w: WorldState, v: DeliveryVan): { text: string; badge: Badge } {
  const st = v.storeId ? w.retail.stores[v.storeId] : undefined;
  const o = v.orderId ? w.retail.orders[v.orderId] : undefined;
  const what = o ? `${o.units} × ${SKUS[o.skuId]?.name ?? o.skuId}` : '';
  switch (v.status) {
    case 'IDLE': return { text: `At the ${w.facilities[v.facilityId]?.name ?? v.facilityId} depot`, badge: { label: 'At depot', tone: 'grey' } };
    case 'LOADING': return { text: `Loading ${what} for ${st?.name ?? ''}`, badge: { label: 'Loading', tone: 'yellow' } };
    case 'TO_STORE': return { text: `Delivering ${what} to ${st?.name ?? ''}`, badge: { label: 'Out for delivery', tone: 'blue' } };
    case 'UNLOADING': return { text: `Unloading at ${st?.name ?? ''}`, badge: { label: 'Unloading', tone: 'indigo' } };
    case 'RETURNING': return { text: `Returning to ${v.facilityId}`, badge: { label: 'Returning', tone: 'green' } };
  }
}

export function storeHealth(st: Store): { low: number; empty: number; badge: Badge } {
  const empty = st.lines.filter((l) => l.units === 0).length;
  const low = st.lines.filter((l) => l.units > 0 && l.units <= l.reorderAt).length;
  const badge: Badge = empty ? { label: `${empty} empty`, tone: 'orange' } : low ? { label: `${low} to restock`, tone: 'yellow' } : { label: 'Well stocked', tone: 'green' };
  return { low, empty, badge };
}

// ---------------------------------------------------------------- forklifts

export function forkliftActivity(w: WorldState, f: Forklift): { text: string; badge: Badge; panelBadge: Badge } {
  const t = f.truckId ? w.trucks[f.truckId] : null;
  if (t) {
    const dock = t.dockId ? w.docks[t.dockId]?.name : '';
    const verb = t.direction === 'inbound' ? 'Unloading' : 'Loading';
    return {
      text: `${verb} ${t.id} at ${dock}`,
      badge: { label: verb, tone: 'green' },
      panelBadge: { label: `${verb} truck`, tone: 'green' },
    };
  }
  if (f.task === 'charging') return { text: 'Charging at bay', badge: { label: 'Charging', tone: 'orange' }, panelBadge: { label: 'Charging', tone: 'orange' } };
  if (f.task === 'to_home' || f.palletId) return { text: 'Returning to charger', badge: { label: 'Returning', tone: 'blue' }, panelBadge: { label: 'Returning', tone: 'blue' } };
  return { text: 'Waiting for work', badge: { label: 'Idle', tone: 'grey' }, panelBadge: { label: 'Idle', tone: 'grey' } };
}

export function forkliftView(w: WorldState, f: Forklift) {
  const fac = w.facilities[f.facilityId];
  const a = forkliftActivity(w, f);
  const p = f.palletId ? w.pallets[f.palletId] : null;
  return {
    header: `FORKLIFT · ${fac.id}`,
    title: f.id,
    subtitle: `${f.operator} · ${f.model}`,
    badge: a.panelBadge,
    activity: a.text,
    progress: f.battery / 100,
    right: `Battery ${Math.round(f.battery)}%`,
    rows: [
      { k: 'Carrying', v: p ? `${p.id} · ${SKUS[p.skuId].name}` : 'Empty', ref: p ? ({ kind: 'pallet', id: p.id } as EntityRef) : undefined },
      { k: 'Moves today', v: String(f.movesToday) },
      { k: 'Speed', v: `${(f.speed * FORK_KMH).toFixed(1)} km/h` },
      { k: 'Charger', v: shortCharger(f.chargerId), ref: { kind: 'charger', id: f.chargerId } as EntityRef },
      { k: 'Site', v: fac.name, ref: { kind: 'facility', id: fac.id } as EntityRef },
    ],
  };
}

// ---------------------------------------------------------------- pallets / docks / chargers

export function palletLocation(w: WorldState, id: string): string {
  const p = w.pallets[id];
  if (!p) return '—';
  if (p.slot !== null) return `${p.facilityId} · Yard slot S${String(p.slot + 1).padStart(2, '0')}`;
  if (p.forkliftId) return `On ${p.forkliftId}`;
  return p.facilityId;
}

export function palletView(w: WorldState, id: string) {
  const p = w.pallets[id];
  const sku = SKUS[p.skuId];
  const fac = w.facilities[p.facilityId];
  const loc = palletLocation(w, id);
  return {
    header: `PALLET · ${sku.category.toUpperCase()}`,
    title: sku.name,
    subtitle: `${p.id} · ${sku.id}`,
    badge: p.slot !== null ? { label: 'Staged', tone: 'green' as Tone } : { label: 'Moving', tone: 'blue' as Tone },
    activity: loc,
    rows: [
      { k: 'Quantity', v: `${p.qty} units` },
      { k: 'Gross weight', v: `${p.weightKg} kg` },
      { k: 'Location', v: loc, ref: p.forkliftId ? ({ kind: 'forklift', id: p.forkliftId } as EntityRef) : ({ kind: 'pallet', id: p.id } as EntityRef) },
      { k: 'Lot', v: p.lot },
      { k: 'Received', v: p.received },
      { k: 'Site', v: fac.name, ref: { kind: 'facility', id: fac.id } as EntityRef },
    ],
  };
}

export function dockStatus(w: WorldState, d: Dock): { badge: Badge; detail: string; truck: Truck | null } {
  const t = d.truckId ? w.trucks[d.truckId] : null;
  if (!t) return { badge: { label: 'Available', tone: 'grey' }, detail: 'No truck assigned', truck: null };
  switch (t.phase) {
    case 'en_route':
    case 'at_gate': {
      const e = t.phase === 'en_route' ? truckEtaSim(t) : 60;
      return { badge: { label: 'Booked', tone: 'orange' }, detail: `${t.id} due in ${mins(e)} min`, truck: t };
    }
    case 'docking':
      return { badge: { label: 'Docking', tone: 'indigo' }, detail: `${t.id} reversing in`, truck: t };
    case 'working':
      return { badge: truckBadge(t), detail: `${t.id} · ${truckDone(t)}/${t.capacity} pallets`, truck: t };
    default:
      return { badge: { label: 'Ready', tone: 'green' }, detail: `${t.id} departing`, truck: t };
  }
}

export function dockView(w: WorldState, d: Dock) {
  const fac = w.facilities[d.facilityId];
  const st = dockStatus(w, d);
  const open = st.truck && (st.truck.phase === 'working' || st.truck.phase === 'ready');
  return {
    header: `DOCK BAY · ${fac.id}`,
    title: d.name,
    subtitle: d.description,
    badge: st.badge,
    activity: st.detail,
    rows: [
      { k: 'Truck', v: st.truck ? `${st.truck.id} · ${carrierName(st.truck.carrier)}` : '—', ref: st.truck ? ({ kind: 'truck', id: st.truck.id } as EntityRef) : undefined },
      { k: 'Rear doors', v: open ? 'Open' : 'Closed' },
      { k: 'Trucks today', v: String(d.trucksToday) },
      { k: 'Site', v: fac.name, ref: { kind: 'facility', id: fac.id } as EntityRef },
    ],
  };
}

export function chargerView(w: WorldState, id: string) {
  const c = w.chargers[id];
  const fac = w.facilities[c.facilityId];
  const f = Object.values(w.forklifts).find((x) => x.chargerId === id) ?? null;
  let badge: Badge = { label: 'Free', tone: 'grey' };
  let activity = 'No forklift assigned';
  if (f) {
    if (f.task === 'charging') { badge = { label: 'Charging', tone: 'orange' }; activity = `${f.id} at ${Math.round(f.battery)}%`; }
    else if (f.task === 'idle') { badge = { label: 'Occupied', tone: 'blue' }; activity = `${f.id} parked · fully charged`; }
    else { activity = `${f.id} is out · ${forkliftActivity(w, f).text}`; }
  }
  return {
    header: `CHARGER · ${fac.id}`,
    title: shortCharger(id),
    subtitle: c.description,
    badge,
    activity,
    rows: [
      { k: 'Forklift', v: f ? `${f.id} · battery ${Math.round(f.battery)}%` : '—', ref: f ? ({ kind: 'forklift', id: f.id } as EntityRef) : undefined },
      { k: 'Sessions today', v: String(c.sessionsToday) },
      { k: 'Energy today', v: `${c.energyKwh.toFixed(1)} kWh` },
      { k: 'Charge rate', v: `${c.ratePctPerMin}% a minute` },
      { k: 'Site', v: fac.name, ref: { kind: 'facility', id: fac.id } as EntityRef },
    ],
  };
}

// ---------------------------------------------------------------- site panel

export function siteView(w: WorldState, fac: FacilityId) {
  const f = w.facilities[fac];
  const trucks = trucksOf(w, fac);
  const docks = docksOf(w, fac);
  const docked = trucks.filter((t) => t.phase === 'working' || t.phase === 'ready').length;
  const arriving = trucks.filter((t) => ['en_route', 'at_gate', 'docking'].includes(t.phase)).length;
  const staged = Object.values(w.pallets).filter((p) => p.facilityId === fac && p.slot !== null).length;
  const baysBusy = docks.filter((d) => d.truckId && ['docking', 'working', 'ready'].includes(w.trucks[d.truckId]?.phase)).length;
  const forks = forkliftsOf(w, fac);
  const working = forks.filter((x) => x.truckId);
  const lead = working[0] ?? forks[0];
  return {
    header: `${f.kindLabel.toUpperCase()} · ${f.id}`,
    title: f.name,
    subtitle: f.address,
    summary: `${docked} docked · ${arriving} arriving · ${staged} staged`,
    stock: f.stock,
    capacity: f.capacity,
    baysBusy,
    baysTotal: docks.length,
    outbound: f.outboundToday,
    putaways: f.putawaysToday,
    inventory: f.inventory.map((l) => ({
      sku: SKUS[l.skuId],
      units: l.units,
      badge: l.units < l.lowBelow ? ({ label: 'Low Stock', tone: 'yellow' } as Badge) : ({ label: 'In Stock', tone: 'green' } as Badge),
    })),
    fleet: { working: working.length, total: forks.length, lead, leadText: lead ? forkliftActivity(w, lead).text : '' },
  };
}

// ---------------------------------------------------------------- fleet list

export interface FleetRow {
  key: string;
  ref: EntityRef;
  title: string;
  sub: string;
  text: string;
  dot: boolean;
  badge: Badge;
  bar?: number;
  barTone?: Tone;
  right: string;
  muted?: boolean;
}

export function dockRows(w: WorldState, fac: FacilityId): FleetRow[] {
  const rows: FleetRow[] = docksOf(w, fac).map((d) => {
    const st = dockStatus(w, d);
    const t = st.truck;
    let right = '';
    let bar: number | undefined;
    if (t?.phase === 'working') { bar = truckDone(t) / t.capacity; right = `${truckDone(t)}/${t.capacity}`; }
    else if (t?.phase === 'docking') right = 'docking';
    else if (t?.phase === 'en_route') right = `${mins(truckEtaSim(t))} min`;
    else if (t?.phase === 'at_gate') right = 'at gate';
    return {
      key: d.id, ref: { kind: 'dock', id: d.id }, title: d.name, sub: fac,
      text: t ? `${t.id} · ${carrierName(t.carrier)}` : 'No truck assigned', dot: !!t, badge: st.badge, bar, right, muted: !t,
    };
  });
  for (const t of trucksOf(w, fac)) {
    if (!t.dockId && (t.phase === 'en_route' || t.phase === 'at_gate')) {
      rows.push({
        key: `in-${t.id}`, ref: { kind: 'truck', id: t.id }, title: 'Inbound', sub: fac, text: `${t.id} · ${carrierName(t.carrier)}`,
        dot: true, badge: truckBadge(t), right: t.phase === 'en_route' ? `${mins(truckEtaSim(t))} min` : 'at gate',
      });
    }
  }
  return rows;
}

export function forkliftRows(w: WorldState, fac: FacilityId): FleetRow[] {
  return forkliftsOf(w, fac).map((f) => {
    const a = forkliftActivity(w, f);
    return {
      key: f.id, ref: { kind: 'forklift', id: f.id }, title: f.id, sub: fac, text: a.text, dot: false, badge: a.badge,
      bar: f.battery / 100, barTone: f.battery < 25 ? 'orange' : 'green', right: `${Math.round(f.battery)}%`,
    };
  });
}

export function truckRows(w: WorldState, fac: FacilityId): FleetRow[] {
  return trucksOf(w, fac).map((t) => {
    const dock = t.dockId ? w.docks[t.dockId] : null;
    const s = w.shipments[t.shipmentId];
    let text = '';
    if (t.phase === 'docking' || t.phase === 'working' || t.phase === 'ready') text = `${fac} · ${dock?.name ?? ''}`;
    else if (t.phase === 'en_route' || t.phase === 'at_gate') text = `To ${fac}`;
    else if (t.phase === 'away') text = t.direction === 'outbound' && s ? `To ${s.destination}` : 'Off site';
    else text = `Leaving ${fac}`;
    let right = '';
    let bar: number | undefined;
    if (t.phase === 'working' || t.phase === 'ready') { bar = truckDone(t) / t.capacity; right = `${truckDone(t)}/${t.capacity}`; }
    else if (t.phase === 'docking') right = 'docking';
    else if (t.phase === 'en_route') right = `${mins(truckEtaSim(t))} min`;
    else if (t.phase === 'at_gate') right = 'at gate';
    else if (t.phase === 'away') right = `${mins(awayRemainingSim(w, t))} min`;
    return {
      key: t.id, ref: { kind: 'truck', id: t.id }, title: t.id, sub: carrierName(t.carrier), text, dot: true, badge: truckBadge(t), bar, right,
    };
  });
}

// ---------------------------------------------------------------- shipment timeline

export type StepState = 'done' | 'current' | 'todo';
export interface TimelineStep { key: string; label: string; time: string; state: StepState; icon: 'order' | 'picked' | 'box' | 'truck' | 'check' }

export function defaultTimelineTruck(w: WorldState, fac: FacilityId, preferred: string | null | undefined): Truck | null {
  if (preferred) {
    const t = w.trucks[preferred];
    if (t && t.facilityId === fac) return t;
  }
  const order = docksOf(w, fac).map((d) => d.id);
  const ranked = trucksOf(w, fac).slice().sort((a, b) => {
    const pa = a.phase === 'working' ? 0 : a.phase === 'docking' ? 1 : 2;
    const pb = b.phase === 'working' ? 0 : b.phase === 'docking' ? 1 : 2;
    if (pa !== pb) return pa - pb;
    return order.indexOf(a.dockId ?? '') - order.indexOf(b.dockId ?? '');
  });
  return ranked[0] ?? null;
}

export function timeline(w: WorldState, t: Truck) {
  const s = w.shipments[t.shipmentId];
  const now = w.simTime;
  const done = truckDone(t);
  const steps: TimelineStep[] = [];
  const at = (x: number) => fmtClock(x);
  const eta = (x: number) => `ETA ${fmtClock(x)}`;
  const working = t.phase === 'working';
  const beforeDock = ['en_route', 'at_gate', 'docking'].includes(t.phase);
  if (!s) return { steps, shipment: null };
  if (t.direction === 'outbound') {
    const loadEnd = s.loadedAt ?? now + workRemainingSim(w, t);
    const departAt = s.transitAt ?? loadEnd + 120;
    const deliverAt = s.deliveredAt ?? departAt + s.transitMinutes * 60;
    steps.push({ key: 'c', label: 'Order Confirmed', time: at(s.confirmedAt), state: 'done', icon: 'order' });
    steps.push({ key: 'p', label: 'Picked', time: at(s.pickedAt), state: 'done', icon: 'picked' });
    steps.push({
      key: 'l', label: s.loadedAt ? 'Loaded' : `Loading ${done}/${t.capacity}`,
      time: s.loadedAt ? at(s.loadedAt) : eta(loadEnd), state: s.loadedAt ? 'done' : working ? 'current' : 'todo', icon: 'box',
    });
    steps.push({
      key: 't', label: 'In Transit', time: s.transitAt ? at(s.transitAt) : eta(departAt),
      state: s.deliveredAt ? 'done' : s.transitAt ? 'current' : 'todo', icon: 'truck',
    });
    steps.push({ key: 'd', label: 'Delivered', time: s.deliveredAt ? at(s.deliveredAt) : eta(deliverAt), state: s.deliveredAt ? 'done' : 'todo', icon: 'check' });
  } else {
    const unloadEnd = s.deliveredAt ?? now + workRemainingSim(w, t);
    steps.push({ key: 'c', label: 'Order Confirmed', time: at(s.confirmedAt), state: 'done', icon: 'order' });
    steps.push({ key: 'p', label: 'Picked', time: at(s.pickedAt), state: 'done', icon: 'picked' });
    steps.push({ key: 'l', label: 'Loaded', time: at(s.loadedAt ?? s.pickedAt), state: 'done', icon: 'box' });
    steps.push({ key: 't', label: 'In Transit', time: at(s.transitAt ?? s.pickedAt), state: beforeDock ? 'current' : 'done', icon: 'truck' });
    steps.push({
      key: 'd', label: working ? `Unloading ${done}/${t.capacity}` : 'Delivered',
      time: s.deliveredAt ? at(s.deliveredAt) : eta(unloadEnd), state: s.deliveredAt ? 'done' : working ? 'current' : 'todo', icon: 'check',
    });
  }
  return { steps, shipment: s };
}

export function timelineCard(w: WorldState, t: Truck) {
  const s = w.shipments[t.shipmentId];
  const fac = t.facilityId;
  const dock = t.dockId ? w.docks[t.dockId]?.name : null;
  let line = '';
  switch (t.phase) {
    case 'en_route': { const e = truckEtaSim(t); line = `Arriving ${fmtClock(w.simTime + e)} · ${mins(e)} min`; break; }
    case 'at_gate': line = `${fac} · at gate · waiting for ${dock ?? 'dock'}`; break;
    case 'docking': { const e = truckEtaSim(t); line = `Arriving ${fmtClock(w.simTime + e)} · ${mins(e)} min`; break; }
    case 'working': line = `${fac} · ${dock} · ${mins(workRemainingSim(w, t))} min left`; break;
    case 'ready': line = `${fac} · ${dock} · ready to depart`; break;
    case 'departing': case 'leaving': line = `Leaving ${fac}`; break;
    case 'away': line = t.direction === 'outbound' ? `In transit · ${mins(awayRemainingSim(w, t))} min left` : 'Delivered'; break;
  }
  return { id: s ? `#${s.id}` : '—', to: s ? `To: ${s.destination}` : '', badge: truckBadge(t), line };
}

// ---------------------------------------------------------------- search

export interface SearchResult { ref: EntityRef; title: string; sub: string; kind: string }

export function search(w: WorldState, q: string): SearchResult[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const out: SearchResult[] = [];
  const hit = (...fields: string[]) => fields.some((f) => f.toLowerCase().includes(needle));
  for (const f of Object.values(w.facilities)) {
    if (hit(f.id, f.name, f.address)) out.push({ ref: { kind: 'facility', id: f.id }, title: f.name, sub: `${f.id} · ${f.address}`, kind: 'Site' });
  }
  for (const t of Object.values(w.trucks)) {
    const s = w.shipments[t.shipmentId];
    if (hit(t.id, t.carrier, carrierName(t.carrier), t.driver, t.plate, s?.id ?? '', s?.customer ?? '', s?.destination ?? '')) {
      out.push({ ref: { kind: 'truck', id: t.id }, title: t.id, sub: `${carrierName(t.carrier)} · ${s ? '#' + s.id : ''} · ${t.facilityId}`, kind: 'Truck' });
    }
  }
  for (const f of Object.values(w.forklifts)) {
    if (hit(f.id, f.operator, f.model)) out.push({ ref: { kind: 'forklift', id: f.id }, title: f.id, sub: `${f.operator} · ${f.facilityId}`, kind: 'Forklift' });
  }
  for (const p of Object.values(w.pallets)) {
    const sku = SKUS[p.skuId];
    if (hit(p.id, sku.name, sku.id, p.lot)) out.push({ ref: { kind: 'pallet', id: p.id }, title: `${p.id} · ${sku.name}`, sub: palletLocation(w, p.id), kind: 'Pallet' });
  }
  for (const d of Object.values(w.docks)) {
    if (hit(d.name, `${d.facilityId} ${d.name}`, d.id)) out.push({ ref: { kind: 'dock', id: d.id }, title: d.name, sub: `Dock · ${w.facilities[d.facilityId].name}`, kind: 'Dock' });
  }
  for (const c of Object.values(w.chargers)) {
    if (hit(c.id, `charger ${shortCharger(c.id)}`)) out.push({ ref: { kind: 'charger', id: c.id }, title: `Charger ${shortCharger(c.id)}`, sub: w.facilities[c.facilityId].name, kind: 'Charger' });
  }
  // the logistics park: neighbouring companies, their buildings, gates and vehicles
  const park = getPark();
  for (const b of park.buildings) {
    if (b.facilityId) continue;
    const co = park.companies.find((c) => c.id === b.companyId);
    if (hit(b.name, b.id, co?.name ?? '', co?.industry ?? '', b.kind)) out.push({ ref: { kind: 'building', id: b.id }, title: b.name, sub: `${co?.name ?? ''} · ${b.street}`, kind: 'Building' });
  }
  for (const g of Object.values(PARK_GATES)) {
    if (hit(g.name, `${g.code} gate`, 'gate', g.code === 'WEST' ? 'import imports' : 'export exports')) out.push({ ref: { kind: 'gate', id: g.code }, title: g.name, sub: 'Park gate', kind: 'Gate' });
  }
  for (const v of park.vehicles) {
    const co = park.companies.find((c) => c.id === v.companyId);
    if (hit(v.plate, v.id, co?.name ?? '')) out.push({ ref: { kind: 'vehicle', id: v.id }, title: v.plate, sub: `${v.kind.toLowerCase()} · ${co?.name ?? 'public traffic'}`, kind: 'Vehicle' });
  }
  // the container port and the town's stores
  for (const v of Object.values(w.port?.vessels ?? {})) {
    if (hit(v.name, v.id, v.line, v.imo, v.voyage, 'ship vessel')) out.push({ ref: { kind: 'vessel', id: v.id }, title: v.name, sub: `${v.line} · ${vesselActivity(w, v).badge.label}`, kind: 'Ship' });
  }
  for (const c of Object.values(w.port?.cranes ?? {})) {
    if (hit(c.id, `crane ${c.id}`)) out.push({ ref: { kind: 'crane', id: c.id }, title: `Quay crane ${c.id}`, sub: w.port.berths[c.berthId]?.name ?? '', kind: 'Crane' });
  }
  for (const st of Object.values(w.retail?.stores ?? {})) {
    if (hit(st.name, st.id, st.chain, st.kind, 'store shop supermarket')) out.push({ ref: { kind: 'store', id: st.id }, title: st.name, sub: `${st.kind.toLowerCase()} · supplied by ${st.facilityId}`, kind: 'Store' });
  }
  for (const v of Object.values(w.retail?.vans ?? {})) {
    if (hit(v.id, v.plate, v.driver, 'van delivery')) out.push({ ref: { kind: 'van', id: v.id }, title: v.id, sub: `${v.driver} · ${vanActivity(w, v).badge.label}`, kind: 'Van' });
  }
  if (needle.length >= 4) {
    for (const s of Object.values(w.shipments)) {
      if (s.containerNo && s.containerNo.toLowerCase().includes(needle)) out.push({ ref: { kind: 'truck', id: s.truckId }, title: s.containerNo, sub: `Container on ${s.truckId} · ${s.id}`, kind: 'Container' });
    }
    const inYard = [...(w.port?.importStack ?? []), ...(w.port?.exportStack ?? [])].filter((n) => n.toLowerCase().includes(needle)).slice(0, 3);
    for (const n of inYard) out.push({ ref: { kind: 'building', id: 'PB-PORT' }, title: n, sub: `Container in the ${w.port.importStack.includes(n) ? 'import' : 'export'} stack`, kind: 'Container' });
  }
  return out.slice(0, 10);
}

/** Position of an entity on the park map (park coordinates). */
export function entityWorldPos(w: WorldState, ref: EntityRef): { x: number; z: number } | null {
  const local = entityLocalPos(w, ref);
  if (!local) return null;
  if (local.fac) return toPark(local.fac, local.p);
  return local.p;
}

/** Position in the owning site's local frame (fac = null when already in park coordinates). */
export function entityLocalPos(w: WorldState, ref: EntityRef): { fac: FacilityId | null; p: { x: number; z: number } } | null {
  switch (ref.kind) {
    case 'truck': { const t = w.trucks[ref.id]; return t && t.phase !== 'away' ? { fac: t.facilityId, p: t.pos } : null; }
    case 'forklift': { const f = w.forklifts[ref.id]; return f ? { fac: f.facilityId, p: f.pos } : null; }
    case 'pallet': {
      const p = w.pallets[ref.id];
      if (!p) return null;
      if (p.slot !== null) return { fac: p.facilityId, p: LAYOUTS[p.facilityId].slots[p.slot] };
      const f = p.forkliftId ? w.forklifts[p.forkliftId] : null;
      return f ? { fac: f.facilityId, p: f.pos } : null;
    }
    case 'dock': {
      const d = w.docks[ref.id];
      return d ? { fac: d.facilityId, p: { x: LAYOUTS[d.facilityId].doors[d.id] ?? 0, z: 6 } } : null;
    }
    case 'charger': {
      const c = w.chargers[ref.id];
      return c ? { fac: c.facilityId, p: LAYOUTS[c.facilityId].chargers[c.id] } : null;
    }
    case 'facility': {
      const L = LAYOUTS[ref.id as FacilityId];
      return L ? { fac: ref.id as FacilityId, p: { x: L.camera.x, z: L.camera.z } } : null;
    }
    case 'asset': {
      const a = findAsset(ref.id);
      return a ? { fac: a.facilityId, p: a.pos } : null;
    }
    case 'building': {
      const b = findBuilding(ref.id);
      return b ? { fac: null, p: { x: b.x, z: b.z } } : null;
    }
    case 'gate': {
      const g = PARK_GATES[ref.id as GateCode];
      return g ? { fac: null, p: g.pos } : null;
    }
    case 'vehicle': {
      const v = findVehicle(ref.id);
      if (!v) return null;
      const pose = vehicleNow(v);
      return { fac: null, p: { x: pose.x, z: pose.z } };
    }
    case 'vessel': {
      const v = w.port?.vessels[ref.id];
      return v && v.status !== 'AT_SEA' ? { fac: null, p: v.pos } : null;
    }
    case 'berth': {
      const b = w.port?.berths[ref.id];
      return b ? { fac: null, p: { x: b.x, z: MOOR_Z } } : null;
    }
    case 'crane': {
      const c = w.port?.cranes[ref.id];
      const b = c ? w.port.berths[c.berthId] : undefined;
      return c && b ? { fac: null, p: { x: b.x + c.offset, z: QUAY_Z - 4 } } : null;
    }
    case 'store': {
      const b = storeBuilding(ref.id);
      return b ? { fac: null, p: { x: b.x, z: b.z } } : null;
    }
    case 'van': {
      const v = w.retail?.vans[ref.id];
      return v && v.status !== 'IDLE' ? { fac: null, p: v.pos } : null;
    }
  }
}

// ---------------------------------------------------------------- yard assets (racks, crates, containers, doors)

export type AssetType = 'rack' | 'crates' | 'container' | 'putaway' | 'building';
export interface YardAsset {
  id: string; // "<facility>|<type>|<index or dock id>"
  facilityId: FacilityId;
  type: AssetType;
  name: string;
  pos: { x: number; z: number };
  size: [number, number, number];
  rotation: number;
}

export function assetsOf(fac: FacilityId): YardAsset[] {
  const L = LAYOUTS[fac];
  const out: YardAsset[] = [];
  L.racks.forEach((r, i) => out.push({ id: `${fac}|rack|${i}`, facilityId: fac, type: 'rack', name: `Pallet rack R${i + 1}`, pos: r, size: [6.2, 6.6, 2.0], rotation: 0 }));
  L.crateStacks.forEach((c, i) => out.push({ id: `${fac}|crates|${i}`, facilityId: fac, type: 'crates', name: `Crate stack C${i + 1}`, pos: { x: c.x + 1, z: c.z + 0.5 }, size: [3.6, 2.2, 2.6], rotation: c.rot }));
  L.shippingContainers.forEach((c, i) => out.push({ id: `${fac}|container|${i}`, facilityId: fac, type: 'container', name: `Shipping container SC${i + 1}`, pos: c, size: [12.4, 3.0, 3.0], rotation: c.rot }));
  Object.entries(L.doors).forEach(([dockId, x]) => out.push({ id: `${fac}|putaway|${dockId}`, facilityId: fac, type: 'putaway', name: `Put-away door ${dockId.split('-').pop()}`, pos: { x: x + L.storeOffset, z: 0.6 }, size: [3.2, 3.6, 1.0], rotation: 0 }));
  return out;
}

export function findAsset(id: string): YardAsset | null {
  const fac = id.split('|')[0] as FacilityId;
  if (!LAYOUTS[fac]) return null;
  return assetsOf(fac).find((a) => a.id === id) ?? null;
}

export function assetView(w: WorldState, id: string) {
  const a = findAsset(id);
  if (!a) return null;
  const fac = w.facilities[a.facilityId];
  const rows: { k: string; v: string; ref?: EntityRef }[] = [];
  let activity = '';
  let header = 'YARD ASSET';
  switch (a.type) {
    case 'rack': {
      header = `STORAGE · ${a.facilityId}`;
      activity = 'Selective pallet racking beside the building';
      rows.push({ k: 'Levels', v: '3 beam levels' }, { k: 'Positions', v: '6 pallet positions (6 occupied)' },
        { k: 'Holding', v: 'Cardboard Box (M)' }, { k: 'Max load', v: '1,000 kg per level' });
      break;
    }
    case 'crates': {
      header = `RETURNABLES · ${a.facilityId}`;
      activity = 'Reusable plastic crates waiting for collection';
      rows.push({ k: 'Crates', v: '11 stacked' }, { k: 'Material', v: 'Blue HDPE, 60 × 40 cm' }, { k: 'Owner', v: 'CargoVerse pool' });
      break;
    }
    case 'container': {
      header = `CONTAINER · ${a.facilityId}`;
      activity = 'Parked 40 ft container used for overflow storage';
      rows.push({ k: 'Type', v: '40 ft dry van' }, { k: 'Use', v: 'Overflow storage' }, { k: 'Seal', v: 'Sealed · 4417-B' });
      break;
    }
    case 'putaway': {
      const dockId = id.split('|')[2];
      const dock = w.docks[dockId];
      header = `PUT-AWAY DOOR · ${a.facilityId}`;
      activity = `Forklifts store pallets through here from ${dock?.name ?? 'the dock'}`;
      const busy = Object.values(w.forklifts).filter((f) => f.facilityId === a.facilityId && f.drop?.type === 'store' && f.drop.dockId === dockId);
      rows.push({ k: 'Serves dock', v: dock?.name ?? dockId, ref: dock ? { kind: 'dock', id: dock.id } : undefined },
        { k: 'Forklifts heading here', v: busy.length ? busy.map((f) => f.id).join(', ') : 'None', ref: busy[0] ? { kind: 'forklift', id: busy[0].id } : undefined },
        { k: 'Put-aways today (site)', v: String(fac.putawaysToday) });
      break;
    }
    default: break;
  }
  rows.push({ k: 'Site', v: fac.name, ref: { kind: 'facility', id: fac.id } });
  return { header, title: a.name, subtitle: `${fac.id} · ${fac.name}`, activity, rows, asset: a };
}

/** Pallets of one product at a site, for the inventory highlight. */
export function palletsOfSku(w: WorldState, fac: FacilityId, skuId: string) {
  return Object.values(w.pallets).filter((p) => p.facilityId === fac && p.skuId === skuId);
}

/** Deliveries for the on-time popover: recent completions and current at-risk shipments. */
export function deliveryWatch(w: WorldState, fac: FacilityId) {
  const items: { id: string; truckId: string; text: string; tone: Tone; label: string }[] = [];
  for (const t of trucksOf(w, fac)) {
    const s = w.shipments[t.shipmentId];
    if (!s) continue;
    if (s.deliveredAt !== null) {
      items.push({ id: s.id, truckId: t.id, text: `${s.destination} · delivered ${fmtClock(s.deliveredAt)}`, tone: s.onTime ? 'green' : 'orange', label: s.onTime ? 'On time' : 'Late' });
      continue;
    }
    const expected = t.direction === 'outbound'
      ? (s.transitAt ?? w.simTime + workRemainingSim(w, t) + 120) + s.transitMinutes * 60
      : w.simTime + workRemainingSim(w, t);
    const slack = s.promisedAt - expected;
    items.push({
      id: s.id, truckId: t.id, text: `${s.destination} · due ${fmtClock(s.promisedAt)}, expected ${fmtClock(expected)}`,
      tone: slack < 0 ? 'orange' : slack < 600 ? 'yellow' : 'blue', label: slack < 0 ? 'At risk' : slack < 600 ? 'Tight' : 'On track',
    });
  }
  return items;
}
