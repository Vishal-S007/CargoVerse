// Vendor stores in town sell stock off their shelves; when a line drops to its
// reorder point the store orders from a CargoVerse warehouse, a delivery van is
// loaded there (warehouse stock goes down), drives to the store, unloads (store
// stock goes up) and returns to its depot.
import type { WorldState, FacilityId, StoreOrder, DeliveryVan, EntityRef } from '../data/types';
import { SKUS } from '../data/seed';
import { vanPathOut, vanPathBack, vanDepot, legLength, VAN_SPEED, VAN_LOAD_S, VAN_UNLOAD_S } from '../data/city';
import { sampleAt } from './geometry';
import type { SimOp } from './engine';

export interface RetailHooks {
  emit: (op: SimOp) => void;
  event: (facilityId: FacilityId, text: string, ref?: EntityRef) => void;
  /** Take units off a warehouse inventory line (returns how many were available). */
  takeStock: (facilityId: FacilityId, skuId: string, units: number, orderId: string) => number;
}

const OPEN_STATUSES = new Set(['PLACED', 'LOADING', 'OUT_FOR_DELIVERY']);
const FACS: FacilityId[] = ['WH-01', 'WH-02', 'WH-04'];
const SIM_SPEED = 10; // simulated seconds per real second (TIME_SCALE)

export function retailLog(w: WorldState, text: string, ref?: EntityRef): void {
  w.retail.log.unshift({ t: w.simTime, text, ref });
  if (w.retail.log.length > 30) w.retail.log.length = 30;
}

const skuName = (id: string) => SKUS[id]?.name ?? id;

/** Warehouse that should supply an order: the store's usual one if it has the stock, else another that carries the item. */
export function chooseSupplier(w: WorldState, preferred: FacilityId, skuId: string, units: number): FacilityId | null {
  const has = (f: FacilityId) => (w.facilities[f]?.inventory.find((l) => l.skuId === skuId)?.units ?? 0) >= units;
  if (has(preferred)) return preferred;
  return FACS.find((f) => f !== preferred && has(f)) ?? null;
}

export function hasOpenOrder(w: WorldState, storeId: string, skuId: string): boolean {
  return Object.values(w.retail.orders).some((o) => o.storeId === storeId && o.skuId === skuId && OPEN_STATUSES.has(o.status));
}

/** Creates an order in the world (used by the automatic reorder and by managers in the UI). */
export function placeOrder(w: WorldState, o: { storeId: string; skuId: string; units: number; facilityId: FacilityId; source: 'AUTO' | 'MANUAL'; placedBy: number | null; id?: string }): StoreOrder {
  const id = o.id ?? `SO-${w.retail.nextOrder++}`;
  const order: StoreOrder = {
    id, storeId: o.storeId, facilityId: o.facilityId, skuId: o.skuId, units: o.units, status: 'PLACED', source: o.source,
    placedBy: o.placedBy, placedAt: w.simTime, dispatchedAt: null, deliveredAt: null, vanId: null,
  };
  w.retail.orders[id] = order;
  const store = w.retail.stores[o.storeId];
  retailLog(w, `${store?.name ?? o.storeId} ordered ${o.units} × ${skuName(o.skuId)} from ${o.facilityId} (${id}${o.source === 'MANUAL' ? ', manual' : ''})`, { kind: 'store', id: o.storeId });
  return order;
}

function setPose(v: DeliveryVan, pts: { x: number; z: number }[], d: number): void {
  const s = sampleAt(pts, d);
  v.pos = { x: s.x, z: s.z };
  v.heading = Math.atan2(s.dz, s.dx);
}

export function stepRetail(w: WorldState, dt: number, h: RetailHooks): void {
  const R = w.retail;
  const hour = Math.floor(w.simTime / 3600) % 24;
  const traffic = hour >= 7 && hour < 22 ? 1 : 0.15; // quiet overnight

  // shoppers buy from the shelves; low lines trigger a reorder
  for (const st of Object.values(R.stores)) {
    for (const line of st.lines) {
      line.acc += (line.salesPerHour * dt * SIM_SPEED * traffic) / 3600;
      const whole = Math.floor(line.acc);
      if (whole > 0) {
        line.acc -= whole;
        const sold = Math.min(whole, line.units);
        line.units -= sold;
        line.soldToday += sold;
      }
      if (line.units <= line.reorderAt && !hasOpenOrder(w, st.id, line.skuId)) {
        const units = Math.ceil((line.maxUnits - line.units) / 5) * 5;
        const fac = chooseSupplier(w, st.facilityId, line.skuId, units);
        if (fac) placeOrder(w, { storeId: st.id, skuId: line.skuId, units, facilityId: fac, source: 'AUTO', placedBy: null });
      }
    }
  }

  // dispatch waiting orders to free vans at the supplying warehouse (oldest first)
  const waiting = Object.values(R.orders).filter((o) => o.status === 'PLACED').sort((a, b) => a.placedAt - b.placedAt || a.id.localeCompare(b.id));
  for (const o of waiting) {
    const van = Object.values(R.vans).find((v) => v.facilityId === o.facilityId && v.status === 'IDLE');
    if (!van) continue;
    van.status = 'LOADING';
    van.timer = VAN_LOAD_S;
    van.orderId = o.id;
    van.storeId = o.storeId;
    van.dist = 0;
    setPose(van, vanPathOut(van.facilityId, o.storeId), 0);
    o.status = 'LOADING';
    o.vanId = van.id;
  }

  for (const v of Object.values(R.vans)) {
    const o = v.orderId ? R.orders[v.orderId] : undefined;
    switch (v.status) {
      case 'IDLE':
        break;
      case 'LOADING': {
        v.timer -= dt;
        if (v.timer > 0) break;
        if (!o || o.status === 'CANCELLED') { v.status = 'IDLE'; v.orderId = null; v.storeId = null; v.pos = vanDepot(v.facilityId); break; }
        const got = h.takeStock(v.facilityId, o.skuId, o.units, o.id);
        if (got <= 0) {
          o.status = 'CANCELLED';
          retailLog(w, `${o.id} cancelled — ${v.facilityId} is out of ${skuName(o.skuId)}`, { kind: 'store', id: o.storeId });
          v.status = 'IDLE'; v.orderId = null; v.storeId = null; v.pos = vanDepot(v.facilityId);
          break;
        }
        o.units = got;
        o.status = 'OUT_FOR_DELIVERY';
        o.dispatchedAt = w.simTime;
        v.status = 'TO_STORE';
        v.dist = 0;
        const st = R.stores[o.storeId];
        h.event(v.facilityId, `${v.id} out for delivery: ${got} × ${skuName(o.skuId)} to ${st?.name ?? o.storeId} (${o.id})`, { kind: 'van', id: v.id });
        break;
      }
      case 'TO_STORE': {
        const pts = vanPathOut(v.facilityId, v.storeId ?? '');
        v.dist += VAN_SPEED * dt;
        setPose(v, pts, v.dist);
        if (v.dist >= legLength(pts)) { v.status = 'UNLOADING'; v.timer = VAN_UNLOAD_S; }
        break;
      }
      case 'UNLOADING': {
        v.timer -= dt;
        if (v.timer > 0) break;
        if (o && o.status === 'OUT_FOR_DELIVERY') {
          const st = R.stores[o.storeId];
          const line = st?.lines.find((l) => l.skuId === o.skuId);
          if (line) line.units = Math.min(line.maxUnits + 20, line.units + o.units);
          if (st) st.deliveriesToday += 1;
          o.status = 'DELIVERED';
          o.deliveredAt = w.simTime;
          retailLog(w, `${v.id} delivered ${o.units} × ${skuName(o.skuId)} to ${st?.name ?? o.storeId}`, { kind: 'store', id: o.storeId });
        }
        v.tripsToday += 1;
        v.status = 'RETURNING';
        v.dist = 0;
        break;
      }
      case 'RETURNING': {
        const pts = vanPathBack(v.facilityId, v.storeId ?? '');
        v.dist += VAN_SPEED * dt;
        setPose(v, pts, v.dist);
        if (v.dist >= legLength(pts)) {
          v.status = 'IDLE';
          v.orderId = null;
          v.storeId = null;
          v.dist = 0;
          v.pos = vanDepot(v.facilityId);
        }
        break;
      }
    }
  }

  // keep the in-memory order list bounded (history stays in the database)
  const ids = Object.keys(R.orders);
  if (ids.length > 70) {
    const done = Object.values(R.orders).filter((o) => !OPEN_STATUSES.has(o.status)).sort((a, b) => a.placedAt - b.placedAt);
    for (const o of done.slice(0, ids.length - 70)) delete R.orders[o.id];
  }
}
