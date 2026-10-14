// The Smart Warehouse engine: lots, bin contents, picking (FEFO), put-away (random or
// ABC slotting), temperature sensors and warehouse events. It listens to the operations
// simulation and keeps its own state in step with it; the server persists the changes
// to Oracle (OracleWms) or keeps them in memory. Business rules that must hold for any
// program (recall, holds, breach detection, scans) live in the WT_WMS package in Oracle;
// this engine applies the same rules when running without Oracle.
import { createHash } from 'node:crypto';
import type { WorldState, FacilityId } from '../../src/data/types';
import type { SimOp } from '../../src/sim/engine';
import { SKUS } from '../../src/data/seed';
import {
  SKU_HANDLING, siteStorage, binById, sensorDefs, sscc as makeSscc, hash01, WMS_FACILITIES, type SensorDef, type Bin,
} from '../../src/data/wms';
import type { QcStatus, WmsEvent, AbcClass } from '../../src/api/wms-types';

export type MoveType = 'OPENING' | 'RECEIVE' | 'PICK' | 'SHIP_STORE' | 'RETURN' | 'RELOCATE' | 'ADJUST';
export interface WmsLot {
  id: string; facilityId: FacilityId; skuId: string; supplier: string; shipmentId: string | null; containerNo: string | null;
  receivedAt: string; expiry: string | null; qc: QcStatus; qcReason: string | null; unitsReceived: number; units: number;
}
export interface WmsBinStock { binId: string; sscc: string; lotId: string; units: number; placedAt: string }
export interface WmsMove {
  seq: number; lotId: string; facilityId: FacilityId; skuId: string; type: MoveType; units: number; binId: string | null; toBinId: string | null;
  sscc: string | null; refKind: 'SHIPMENT' | 'ORDER' | 'TASK' | 'SCAN' | null; refId: string | null; metres: number | null; fefoOk: boolean | null;
  simTime: number; at: string; userId: number | null;
}
export interface WmsReading { sensorId: string; at: string; tempC: number }
export interface MemBreach { id: string; sensorId: string; facilityId: FacilityId; startedAt: string; endedAt: string | null; peakC: number; readings: number; lotsHeld: number; status: 'OPEN' | 'CLOSED' }
export interface LedgerEntry { seq: number; move: WmsMove; prev: string; hash: string }
export interface MemDamage { id: number; facilityId: FacilityId; skuId: string; lotId: string | null; sscc: string | null; severity: 'LOW' | 'MEDIUM' | 'HIGH'; text: string; reportedBy: string; at: string; vec: number[] | null; model: string | null }

interface SensorState { def: SensorDef; temp: number; doorOpen: boolean; doorUntil: number }
export interface PendingChanges {
  lots: WmsLot[];
  bins: Map<string, WmsBinStock | null>;
  moves: WmsMove[];
  readings: WmsReading[];
  events: { type: string; facilityId: string | null; title: string; detail: string | null; refKind: string | null; refId: string | null }[];
  policies: Map<FacilityId, 'RANDOM' | 'ABC'>;
}

const READ_EVERY_MS = 5000;
const RING_READINGS = 720; // an hour per sensor
const iso = () => new Date().toISOString();
const dayStr = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
export const palletSscc = (palletId: string) => makeSscc(Number(palletId.replace(/\D/g, '')) || 0);
export const daysTo = (expiry: string | null) => (expiry ? Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${dayStr(new Date())}T00:00:00Z`)) / 86400000) : null);

export class WmsEngine {
  readonly lots = new Map<string, WmsLot>();
  readonly bins = new Map<string, WmsBinStock>();
  readonly policy: Record<string, 'RANDOM' | 'ABC'> = { 'WH-01': 'RANDOM', 'WH-02': 'RANDOM', 'WH-04': 'RANDOM' };
  /** ABC class per site and product (from the ABC analysis; used by ABC put-away). */
  abcClass = new Map<string, AbcClass>();
  readonly sensors = new Map<string, SensorState>();
  readonly readings = new Map<string, WmsReading[]>();
  readonly breaches: MemBreach[] = [];
  readonly events: WmsEvent[] = [];
  /** Recent movements (analytics without Oracle, metres per pick). */
  readonly moves: WmsMove[] = [];
  readonly ledger: LedgerEntry[] = [];
  readonly damage: MemDamage[] = [];
  readonly demandToday = new Map<string, { units: number; picks: number }>();
  readonly picksMetres: Record<string, number[]> = { 'WH-01': [], 'WH-02': [], 'WH-04': [] };
  pending: PendingChanges = WmsEngine.emptyPending();
  version = 1;
  nextLot = 10001;
  nextSerial = 900000001;
  private seq = 1;
  private lastHash = '0'.repeat(64);
  private lotByShipment = new Map<string, string>();
  private handled = new Set<string>();
  private lastRead = 0;
  private evSeq = 1;
  /** In Oracle mode events come back from the database queue; without Oracle they are delivered here. */
  memoryEvents = true;
  onEvent: ((e: WmsEvent) => void) | null = null;
  /** Creates a task (wired to the repository by the server). */
  createTask: ((t: { facilityId: FacilityId; title: string; description: string; type: 'OTHER' | 'PUTAWAY' | 'CYCLE_COUNT'; priority: 'NORMAL' | 'HIGH' | 'URGENT'; dueMinutes: number }) => Promise<number | null>) | null = null;
  /** Breach detection runs here only without Oracle (in Oracle it is WT_WMS.DETECT_BREACHES). */
  detectInMemory = true;

  static emptyPending(): PendingChanges {
    return { lots: [], bins: new Map(), moves: [], readings: [], events: [], policies: new Map() };
  }

  constructor() {
    for (const def of sensorDefs()) {
      this.sensors.set(def.id, { def, temp: def.setpoint, doorOpen: false, doorUntil: 0 });
      this.readings.set(def.id, []);
    }
  }

  takePending(): PendingChanges {
    const p = this.pending;
    this.pending = WmsEngine.emptyPending();
    return p;
  }
  /** Puts changes back after a failed write (they are retried with the next flush). */
  restorePending(p: PendingChanges): void {
    const cur = this.pending;
    this.pending = {
      lots: [...p.lots, ...cur.lots],
      bins: new Map([...p.bins, ...cur.bins]),
      moves: [...p.moves, ...cur.moves],
      readings: [...p.readings, ...cur.readings].slice(-5000),
      events: [...p.events, ...cur.events],
      policies: new Map([...p.policies, ...cur.policies]),
    };
  }

  // ---------------------------------------------------------------- events
  announce(type: string, facilityId: string | null, title: string, detail: string | null = null, refKind: string | null = null, refId: string | null = null): void {
    if (this.memoryEvents) {
      const at = iso();
      this.deliver({ id: `M${this.evSeq++}`, type, facilityId, title, detail, refKind, refId, at, receivedAt: at, via: 'memory' });
    } else {
      this.pending.events.push({ type, facilityId, title, detail, refKind, refId });
    }
  }
  deliver(e: WmsEvent): void {
    this.events.push(e);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    this.version++;
    this.onEvent?.(e);
  }

  // ---------------------------------------------------------------- bookkeeping
  private record(m: Omit<WmsMove, 'seq' | 'at'> & { at?: string }): WmsMove {
    const move: WmsMove = { ...m, seq: this.seq++, at: m.at ?? iso() };
    this.moves.push(move);
    if (this.moves.length > 6000) this.moves.splice(0, this.moves.length - 6000);
    this.pending.moves.push(move);
    const lot = this.lots.get(move.lotId);
    if (lot) {
      lot.units += move.units;
      if (move.type === 'OPENING' || move.type === 'RECEIVE') lot.unitsReceived += move.units;
    }
    if (move.type === 'PICK' || move.type === 'SHIP_STORE') {
      const k = `${move.facilityId}:${move.skuId}`;
      const d = this.demandToday.get(k) ?? { units: 0, picks: 0 };
      d.units += -move.units; d.picks += 1;
      this.demandToday.set(k, d);
      if (move.metres !== null) {
        const arr = this.picksMetres[move.facilityId] ?? (this.picksMetres[move.facilityId] = []);
        arr.push(move.metres);
        if (arr.length > 60) arr.shift();
      }
    }
    // hash chain (the in-memory stand-in for Oracle's blockchain table)
    const hash = createHash('sha256').update(this.lastHash + JSON.stringify([move.seq, move.lotId, move.facilityId, move.skuId, move.type, move.units, move.toBinId ?? move.binId, move.refId, move.at])).digest('hex');
    this.ledger.push({ seq: move.seq, move, prev: this.lastHash, hash });
    if (this.ledger.length > 4000) this.ledger.splice(0, this.ledger.length - 4000);
    this.lastHash = hash;
    this.version++;
    return move;
  }
  private setBin(binId: string, stock: WmsBinStock | null): void {
    if (stock) this.bins.set(binId, stock); else this.bins.delete(binId);
    this.pending.bins.set(binId, stock ? { ...stock } : null);
  }
  addLot(lot: WmsLot): void {
    this.lots.set(lot.id, lot);
    this.pending.lots.push({ ...lot, units: 0, unitsReceived: 0 });
    if (lot.shipmentId) this.lotByShipment.set(`${lot.shipmentId}:${lot.skuId}`, lot.id);
  }
  newLotId(): string { return `LOT-${this.nextLot++}`; }

  /** Loads state (from Oracle or a memory snapshot) without recording it as new changes. */
  load(s: { lots: WmsLot[]; bins: WmsBinStock[]; policy?: Record<string, 'RANDOM' | 'ABC'>; nextLot?: number; nextSerial?: number; doors?: Record<string, boolean> }): void {
    this.lots.clear(); this.bins.clear(); this.lotByShipment.clear();
    for (const l of s.lots) { this.lots.set(l.id, l); if (l.shipmentId) this.lotByShipment.set(`${l.shipmentId}:${l.skuId}`, l.id); }
    for (const b of s.bins) this.bins.set(b.binId, b);
    if (s.policy) Object.assign(this.policy, s.policy);
    const maxLot = Math.max(10000, ...s.lots.map((l) => Number(l.id.replace(/\D/g, '')) || 0));
    this.nextLot = Math.max(s.nextLot ?? 0, maxLot + 1);
    const maxSerial = Math.max(900000000, ...s.bins.map((b) => Number(b.sscc.slice(8, 17)) || 0));
    this.nextSerial = Math.max(s.nextSerial ?? 0, maxSerial + 1);
    for (const [id, open] of Object.entries(s.doors ?? {})) { const st = this.sensors.get(id); if (st) st.doorOpen = open; }
    this.version++;
  }

  // ---------------------------------------------------------------- first start: lots and bins from the inventory
  /** Spreads each site's current inventory over lots and bins ("as found": placed at random, ages varied). */
  initFromInventory(w: WorldState): number {
    let pallets = 0;
    const today = new Date();
    for (const fac of WMS_FACILITIES) {
      const f = w.facilities[fac];
      if (!f) continue;
      for (const line of f.inventory) {
        const sku = SKUS[line.skuId];
        const h = SKU_HANDLING[line.skuId];
        if (!sku || !h || line.units <= 0) continue;
        // pallets already on the yard or on a forklift are part of the book: they get a lot of their own
        const loose = Object.values(w.pallets).filter((p) => p.facilityId === fac && p.skuId === line.skuId);
        let left = line.units;
        if (loose.length) {
          const lot: WmsLot = {
            id: this.newLotId(), facilityId: fac, skuId: line.skuId, supplier: h.supplier, shipmentId: null, containerNo: null,
            receivedAt: addDays(today, -1).toISOString(), expiry: h.shelfLifeDays === null ? null : dayStr(addDays(today, Math.round(h.shelfLifeDays * 0.8))),
            qc: 'RELEASED', qcReason: null, unitsReceived: 0, units: 0,
          };
          this.addLot(lot);
          for (const p of loose) {
            const units = Math.min(p.qty, left);
            p.lot = lot.id;
            if (units <= 0) continue;
            left -= units;
            this.record({ lotId: lot.id, facilityId: fac, skuId: line.skuId, type: 'OPENING', units, binId: null, toBinId: null, sscc: palletSscc(p.id), refKind: null, refId: null, metres: null, fefoOk: null, simTime: w.simTime, userId: null });
          }
        }
        if (left <= 0) continue;
        const n = Math.ceil(left / sku.unitsPerPallet);
        const lotsN = n < 2 ? 1 : Math.max(2, Math.min(4, Math.ceil(n / 6))); // at least two lots, so FEFO has a choice
        for (let j = 0; j < lotsN; j++) {
          const age = Math.round(60 - j * (50 / lotsN) - hash01(`${fac}${line.skuId}${j}`) * 6); // days since receipt, oldest first
          const received = addDays(today, -Math.max(1, age));
          // expiry: the oldest lot of a perishable product is close to its date, so FEFO has work to do
          const expiry = h.shelfLifeDays === null ? null
            : dayStr(addDays(today, Math.round(j === 0 ? Math.min(h.shelfLifeDays * 0.06, 21) + 4 : h.shelfLifeDays * (0.25 + 0.2 * j) + hash01(`${fac}${line.skuId}e${j}`) * 20)));
          const lot: WmsLot = {
            id: this.newLotId(), facilityId: fac, skuId: line.skuId, supplier: h.supplier, shipmentId: null, containerNo: null,
            receivedAt: received.toISOString(), expiry, qc: 'RELEASED', qcReason: null, unitsReceived: 0, units: 0,
          };
          this.addLot(lot);
          const palletsInLot = j === lotsN - 1 ? Math.ceil(left / sku.unitsPerPallet) : Math.max(1, Math.round(n / lotsN));
          for (let k = 0; k < palletsInLot && left > 0; k++) {
            const units = Math.min(sku.unitsPerPallet, left);
            left -= units;
            const sscc = makeSscc(this.nextSerial++);
            const bin = this.chooseBin(fac, line.skuId, sscc, 'RANDOM');
            if (bin) this.setBin(bin.id, { binId: bin.id, sscc, lotId: lot.id, units, placedAt: received.toISOString() });
            this.record({ lotId: lot.id, facilityId: fac, skuId: line.skuId, type: 'OPENING', units, binId: bin?.id ?? null, toBinId: null, sscc, refKind: null, refId: null, metres: null, fefoOk: null, simTime: w.simTime, userId: null });
            pallets++;
          }
        }
      }
    }
    this.announce('OPENING', null, `Opening stock placed in bins: ${pallets} pallets`, 'Lots created from the current inventory; pallets placed as found (random slots)');
    return pallets;
  }

  // ---------------------------------------------------------------- put-away and picking rules
  /** A free bin for a pallet: right temperature zone; random, or by ABC class (A nearest the docks). */
  chooseBin(fac: FacilityId, skuId: string, key: string, policy = this.policy[fac]): Bin | null {
    const zone = SKU_HANDLING[skuId]?.tempZone ?? 'AMBIENT';
    const free = siteStorage(fac).bins.filter((b) => b.zone === zone && !this.bins.has(b.id));
    if (!free.length) return null;
    if (policy === 'RANDOM') return free[Math.floor(hash01(key) * free.length)];
    free.sort((a, b) => a.dockMetres - b.dockMetres || a.id.localeCompare(b.id));
    const cls = this.abcClass.get(`${fac}:${skuId}`) ?? 'B';
    if (cls === 'A') return free[0];
    if (cls === 'C') return free[free.length - 1];
    return free[Math.floor(free.length * 0.4)];
  }

  /** Bins holding released stock of a product, in first-expiry-first-out order. */
  fefoBins(fac: FacilityId, skuId: string): { stock: WmsBinStock; lot: WmsLot; bin: Bin }[] {
    const out: { stock: WmsBinStock; lot: WmsLot; bin: Bin }[] = [];
    for (const st of this.bins.values()) {
      const lot = this.lots.get(st.lotId);
      const bin = binById(st.binId);
      if (!lot || !bin || lot.facilityId !== fac || lot.skuId !== skuId || lot.qc !== 'RELEASED') continue;
      out.push({ stock: st, lot, bin });
    }
    out.sort((a, b) => (a.lot.expiry ?? '9999').localeCompare(b.lot.expiry ?? '9999') || a.lot.receivedAt.localeCompare(b.lot.receivedAt)
      || a.lot.id.localeCompare(b.lot.id) || a.stock.units - b.stock.units || a.bin.dockMetres - b.bin.dockMetres);
    return out;
  }
  fefoLot(fac: FacilityId, skuId: string): string | null { return this.fefoBins(fac, skuId)[0]?.lot.id ?? null; }

  /** Takes units out of the racks, first expiry first out. Returns the lot that supplied most. */
  private allocate(w: WorldState, fac: FacilityId, skuId: string, units: number, type: 'PICK' | 'SHIP_STORE', refKind: 'SHIPMENT' | 'ORDER', refId: string | null): string | null {
    let left = units;
    const by = new Map<string, number>();
    let first = true;
    for (const { stock, lot, bin } of this.fefoBins(fac, skuId)) {
      if (left <= 0) break;
      const take = Math.min(left, stock.units);
      left -= take;
      by.set(lot.id, (by.get(lot.id) ?? 0) + take);
      const rest = stock.units - take;
      this.setBin(stock.binId, rest > 0 ? { ...stock, units: rest } : null);
      this.record({
        lotId: lot.id, facilityId: fac, skuId, type, units: -take, binId: bin.id, toBinId: null, sscc: stock.sscc, refKind, refId,
        metres: first ? Math.round(bin.dockMetres * 2 * 10) / 10 : 0, fefoOk: true, simTime: w.simTime, userId: null,
      });
      first = false;
    }
    if (left > 0) {
      // the racks are short: the rest comes from stock outside the bins (staged on the yard)
      const inBins = new Map<string, number>();
      for (const b of this.bins.values()) inBins.set(b.lotId, (inBins.get(b.lotId) ?? 0) + b.units);
      const loose = [...this.lots.values()].filter((l) => l.facilityId === fac && l.skuId === skuId && l.qc === 'RELEASED' && l.units - (inBins.get(l.id) ?? 0) > 0)
        .sort((a, b) => (a.expiry ?? '9999').localeCompare(b.expiry ?? '9999') || a.receivedAt.localeCompare(b.receivedAt));
      for (const lot of loose) {
        if (left <= 0) break;
        const take = Math.min(left, lot.units - (inBins.get(lot.id) ?? 0));
        left -= take;
        by.set(lot.id, (by.get(lot.id) ?? 0) + take);
        this.record({ lotId: lot.id, facilityId: fac, skuId, type, units: -take, binId: null, toBinId: null, sscc: null, refKind, refId, metres: null, fefoOk: true, simTime: w.simTime, userId: null });
      }
    }
    let best: string | null = null;
    for (const [id, n] of by) if (!best || n > (by.get(best) ?? 0)) best = id;
    return best;
  }

  private ensureLotForPallet(w: WorldState, palletId: string): WmsLot | null {
    const p = w.pallets[palletId];
    if (!p) return null;
    let lot = this.lots.get(p.lot);
    if (!lot) {
      // a pallet from before the warehouse module existed: give it a lot of its own
      const h = SKU_HANDLING[p.skuId];
      lot = {
        id: this.newLotId(), facilityId: p.facilityId, skuId: p.skuId, supplier: h?.supplier ?? 'Unknown', shipmentId: null, containerNo: null,
        receivedAt: iso(), expiry: h?.shelfLifeDays ? dayStr(addDays(new Date(), Math.round(h.shelfLifeDays * 0.7))) : null,
        qc: 'RELEASED', qcReason: null, unitsReceived: 0, units: 0,
      };
      this.addLot(lot);
      p.lot = lot.id;
    }
    return lot;
  }

  // ---------------------------------------------------------------- hooks called by the simulation
  receiveLot = (w: WorldState, fac: FacilityId, skuId: string, shipmentId: string): string => {
    const key = `${shipmentId}:${skuId}`;
    const have = this.lotByShipment.get(key);
    if (have && this.lots.has(have)) return have;
    const s = w.shipments[shipmentId];
    const h = SKU_HANDLING[skuId];
    const life = h?.shelfLifeDays ?? null;
    const lot: WmsLot = {
      id: this.newLotId(), facilityId: fac, skuId, supplier: (s?.customer ?? h?.supplier ?? 'Supplier').replace(/ · ex .*/, '').slice(0, 80),
      shipmentId, containerNo: s?.containerNo ?? null, receivedAt: iso(),
      expiry: life === null ? null : dayStr(addDays(new Date(), Math.round(life * (0.55 + 0.4 * hash01(shipmentId))))),
      qc: 'RELEASED', qcReason: null, unitsReceived: 0, units: 0,
    };
    this.addLot(lot);
    // with Oracle the insert trigger TRG_LOTS_AI publishes this event from the database
    if (this.memoryEvents) {
      this.announce('LOT_RECEIVED', fac, `Lot ${lot.id} received`, `${skuId} from ${lot.supplier}${lot.containerNo ? ` (container ${lot.containerNo})` : ''}${lot.expiry ? `, expires ${lot.expiry}` : ''}`, 'lot', lot.id);
    }
    return lot.id;
  };

  pickLot = (w: WorldState, fac: FacilityId, skuId: string, shipmentId: string, palletId: string): string => {
    const units = SKUS[skuId]?.unitsPerPallet ?? 1;
    const lot = this.allocate(w, fac, skuId, units, 'PICK', 'SHIPMENT', shipmentId);
    this.handled.add(palletId);
    return lot ?? 'UNTRACKED';
  };

  onOp(op: SimOp, w: WorldState): void {
    if (op.k !== 'stock') return;
    const fac = op.facilityId;
    if (!WMS_FACILITIES.includes(fac)) return;
    switch (op.reason) {
      case 'RECEIPT':
      case 'PUTAWAY':
      case 'RETURN': {
        if (!op.palletId || op.units <= 0) return;
        const lot = this.ensureLotForPallet(w, op.palletId);
        if (!lot) return;
        const sscc = palletSscc(op.palletId);
        let binId: string | null = null;
        if (op.reason !== 'RECEIPT') {
          const bin = this.chooseBin(fac, lot.skuId, sscc);
          if (bin) { binId = bin.id; this.setBin(bin.id, { binId: bin.id, sscc, lotId: lot.id, units: op.units, placedAt: iso() }); }
        }
        this.record({
          lotId: lot.id, facilityId: fac, skuId: lot.skuId, type: op.reason === 'RETURN' ? 'RETURN' : 'RECEIVE', units: op.units, binId, toBinId: null, sscc,
          refKind: op.shipmentId ? 'SHIPMENT' : null, refId: op.shipmentId ?? null, metres: null, fefoOk: null, simTime: op.t, userId: null,
        });
        return;
      }
      case 'PICK': {
        if (!op.palletId) return;
        if (this.handled.delete(op.palletId)) return; // taken out of the racks by pickLot (FEFO)
        const p = w.pallets[op.palletId];
        const lot = p ? this.lots.get(p.lot) : undefined;
        if (!lot || op.units >= 0) return;
        // a staged pallet from the yard goes onto the truck
        this.record({
          lotId: lot.id, facilityId: fac, skuId: lot.skuId, type: 'PICK', units: op.units, binId: null, toBinId: null, sscc: palletSscc(op.palletId),
          refKind: 'SHIPMENT', refId: op.shipmentId ?? null, metres: null, fefoOk: null, simTime: op.t, userId: null,
        });
        return;
      }
      case 'STORE_SHIP': {
        if (op.units >= 0) return;
        this.allocate(w, fac, op.skuId, -op.units, 'SHIP_STORE', 'ORDER', op.shipmentId ?? null);
        return;
      }
      default:
    }
  }

  // ---------------------------------------------------------------- manual actions
  /** A person picks a specific pallet (scanned), possibly against FEFO. */
  manualPick(w: WorldState, sscc: string, userId: number | null): { ok: boolean; message: string; fefoOk: boolean | null; lotId: string | null } {
    const stock = [...this.bins.values()].find((b) => b.sscc === sscc);
    if (!stock) return { ok: false, message: 'That pallet is not in a bin', fefoOk: null, lotId: null };
    const lot = this.lots.get(stock.lotId)!;
    const bin = binById(stock.binId)!;
    if (lot.qc !== 'RELEASED') return { ok: false, message: `Lot ${lot.id} is on ${lot.qc} (${lot.qcReason ?? ''}) and cannot be picked`, fefoOk: null, lotId: lot.id };
    const best = this.fefoBins(lot.facilityId, lot.skuId)[0];
    const fefoOk = !best || (best.lot.expiry ?? '9999') >= (lot.expiry ?? '9999');
    this.setBin(stock.binId, null);
    this.record({
      lotId: lot.id, facilityId: lot.facilityId, skuId: lot.skuId, type: 'PICK', units: -stock.units, binId: bin.id, toBinId: null, sscc,
      refKind: 'SCAN', refId: sscc, metres: Math.round(bin.dockMetres * 20) / 10, fefoOk, simTime: w.simTime, userId,
    });
    // the book follows the floor
    const line = w.facilities[lot.facilityId]?.inventory.find((l) => l.skuId === lot.skuId);
    if (line) line.units = Math.max(0, line.units - stock.units);
    if (!fefoOk) {
      this.announce('FEFO_OVERRIDE', lot.facilityId, `FEFO overridden: lot ${lot.id} picked before ${best!.lot.id}`,
        `${lot.skuId}: picked lot expires ${lot.expiry}, lot ${best!.lot.id} expires ${best!.lot.expiry}. Recorded for the audit.`, 'lot', lot.id);
    }
    return { ok: true, message: fefoOk ? `Picked ${stock.units} units of lot ${lot.id} from ${bin.id}` : `Picked against FEFO: lot ${best!.lot.id} expires first (${best!.lot.expiry})`, fefoOk, lotId: lot.id };
  }

  setQc(lotId: string, qc: QcStatus, reason: string | null): WmsLot | null {
    const lot = this.lots.get(lotId);
    if (!lot) return null;
    lot.qc = qc;
    lot.qcReason = qc === 'RELEASED' ? null : reason;
    this.version++;
    return lot;
  }

  /** Re-slotting: fastest movers to the bins nearest the docks. Returns the relocations made. */
  reslot(w: WorldState, fac: FacilityId, cls: Map<string, { cls: AbcClass; units: number }>, userId: number | null): { moves: { sscc: string; skuId: string; from: string; to: string }[]; before: number; after: number } {
    const before = this.expectedMetres(fac, cls);
    const moves: { sscc: string; skuId: string; from: string; to: string }[] = [];
    for (const zone of ['AMBIENT', 'COLD'] as const) {
      const binsZ = siteStorage(fac).bins.filter((b) => b.zone === zone).sort((a, b) => a.dockMetres - b.dockMetres || a.id.localeCompare(b.id));
      const stocks = [...this.bins.values()].filter((s) => binById(s.binId)?.facilityId === fac && binById(s.binId)?.zone === zone);
      const weight = (s: WmsBinStock) => {
        const lot = this.lots.get(s.lotId);
        const c = lot ? cls.get(lot.skuId) : undefined;
        return { rank: c?.cls === 'A' ? 0 : c?.cls === 'B' ? 1 : 2, units: c?.units ?? 0, expiry: lot?.expiry ?? '9999' };
      };
      // fastest movers first; within a product the lot to be picked first (FEFO) nearest
      stocks.sort((a, b) => {
        const x = weight(a), y = weight(b);
        return x.rank - y.rank || y.units - x.units || (this.lots.get(a.lotId)?.skuId ?? '').localeCompare(this.lots.get(b.lotId)?.skuId ?? '') || x.expiry.localeCompare(y.expiry) || a.sscc.localeCompare(b.sscc);
      });
      const target = new Map<string, string>(); // sscc → bin
      stocks.forEach((s, i) => { if (binsZ[i]) target.set(s.sscc, binsZ[i].id); });
      const changed = stocks.filter((s) => target.get(s.sscc) && target.get(s.sscc) !== s.binId);
      for (const s of changed) { this.bins.delete(s.binId); this.pending.bins.set(s.binId, null); }
      for (const s of changed) {
        const to = target.get(s.sscc)!;
        const nb = { ...s, binId: to, placedAt: iso() };
        this.setBin(to, nb);
        const lot = this.lots.get(s.lotId)!;
        const a = binById(s.binId)!, b = binById(to)!;
        this.record({
          lotId: lot.id, facilityId: fac, skuId: lot.skuId, type: 'RELOCATE', units: 0, binId: s.binId, toBinId: to, sscc: s.sscc,
          refKind: null, refId: null, metres: Math.round(Math.abs(a.dockMetres - b.dockMetres) * 10) / 10, fefoOk: null, simTime: w.simTime, userId,
        });
        moves.push({ sscc: s.sscc, skuId: lot.skuId, from: s.binId, to });
      }
    }
    this.policy[fac] = 'ABC';
    this.pending.policies.set(fac, 'ABC');
    for (const [skuId, c] of cls) this.abcClass.set(`${fac}:${skuId}`, c.cls);
    return { moves, before, after: this.expectedMetres(fac, cls) };
  }

  /** Expected round-trip metres per pick: demand share × average distance of the product's bins. */
  expectedMetres(fac: FacilityId, cls: Map<string, { cls: AbcClass; units: number }>): number {
    const total = [...cls.values()].reduce((a, c) => a + c.units, 0);
    if (!total) return 0;
    let m = 0;
    for (const [skuId, c] of cls) {
      const ds = [...this.bins.values()].filter((s) => this.lots.get(s.lotId)?.skuId === skuId && binById(s.binId)?.facilityId === fac).map((s) => binById(s.binId)!.dockMetres);
      if (!ds.length) continue;
      m += (c.units / total) * (ds.reduce((a, d) => a + d, 0) / ds.length) * 2;
    }
    return Math.round(m * 10) / 10;
  }

  // ---------------------------------------------------------------- temperature sensors
  setDoor(sensorId: string, open: boolean, seconds = 0): boolean {
    const s = this.sensors.get(sensorId);
    if (!s) return false;
    s.doorOpen = open && !seconds;
    s.doorUntil = open && seconds ? Date.now() + seconds * 1000 : 0;
    this.version++;
    return true;
  }

  /** Called every second or so; takes a reading from each sensor every five seconds. */
  tickSensors(now = Date.now()): void {
    if (now - this.lastRead < READ_EVERY_MS) return;
    this.lastRead = now;
    const at = new Date(now).toISOString();
    for (const s of this.sensors.values()) {
      const d = s.def;
      // now and then somebody props the cold room door open for half a minute
      if (d.zone === 'COLD' && d.id.endsWith('C1') && !s.doorOpen && s.doorUntil < now && hash01(`${d.id}:${Math.floor(now / READ_EVERY_MS)}`) < 1 / 300) {
        s.doorUntil = now + 30000;
      }
      const door = s.doorOpen || s.doorUntil > now;
      let target = d.setpoint;
      if (d.zone === 'COLD' && door) target = d.id.endsWith('C1') ? 13.5 : 10.5;
      if (d.zone === 'AMBIENT') target = d.setpoint + 2.5 * Math.sin(now / 900000);
      const noise = (hash01(`${d.id}:${now}`) - 0.5) * (d.zone === 'COLD' ? 0.3 : 0.5);
      s.temp += (target - s.temp) * (door ? 0.32 : 0.18) + noise;
      const r: WmsReading = { sensorId: d.id, at, tempC: Math.round(s.temp * 100) / 100 };
      const ring = this.readings.get(d.id)!;
      ring.push(r);
      if (ring.length > RING_READINGS) ring.shift();
      this.pending.readings.push(r);
    }
    if (this.pending.readings.length > 5000) this.pending.readings.splice(0, this.pending.readings.length - 5000);
    if (this.detectInMemory) void this.detectBreaches();
    this.version++;
  }

  /** Same rule as WT_WMS.DETECT_BREACHES: 3+ consecutive readings outside the range. */
  async detectBreaches(): Promise<number> {
    let found = 0;
    for (const s of this.sensors.values()) {
      const ring = this.readings.get(s.def.id)!;
      const out = (r: WmsReading) => r.tempC > s.def.maxC || r.tempC < s.def.minC;
      let i = 0;
      while (i < ring.length) {
        if (!out(ring[i])) { i++; continue; }
        let j = i;
        while (j < ring.length && out(ring[j])) j++;
        if (j - i >= 3) {
          const run = ring.slice(i, j);
          const startedAt = run[0].at;
          let b = this.breaches.find((x) => x.sensorId === s.def.id && x.startedAt === startedAt);
          const peak = Math.max(...run.map((r) => r.tempC));
          const low = Math.min(...run.map((r) => r.tempC));
          if (!b) {
            b = { id: `BR-M${this.breaches.length + 1}`, sensorId: s.def.id, facilityId: s.def.facilityId, startedAt, endedAt: null, peakC: peak, readings: run.length, lotsHeld: 0, status: 'OPEN' };
            this.breaches.push(b);
            const reason = `Temperature excursion at ${s.def.id} (${s.def.label}), peak ${peak.toFixed(1)} °C`;
            b.lotsHeld = this.holdZone(s.def.facilityId, s.def.zone, peak, low, reason);
            found++;
            this.announce('BREACH', s.def.facilityId, `Cold chain breach at ${s.def.id} — peak ${peak.toFixed(1)} °C`,
              `${run.length} readings in a row outside ${s.def.minC}–${s.def.maxC} °C; ${b.lotsHeld} lot(s) on hold`, 'breach', b.id);
            if (this.createTask) {
              await this.createTask({
                facilityId: s.def.facilityId, title: `Cold chain breach at ${s.def.id}`, type: 'OTHER', priority: 'URGENT', dueMinutes: 30,
                description: `${s.def.label}: ${run.length} readings outside ${s.def.minC}–${s.def.maxC} °C (peak ${peak.toFixed(1)} °C). ${b.lotsHeld} lot(s) put on hold until quality assurance checks them.`,
              }).catch(() => null);
            }
          } else {
            b.peakC = Math.max(b.peakC, peak);
            b.readings = run.length;
          }
          if (j < ring.length && b.status === 'OPEN') { b.status = 'CLOSED'; b.endedAt = ring[j].at; }
        }
        i = j;
      }
    }
    if (this.breaches.length > 50) this.breaches.splice(0, this.breaches.length - 50);
    return found;
  }

  holdZone(fac: FacilityId, zone: 'AMBIENT' | 'COLD', highC: number, lowC: number, reason: string): number {
    let n = 0;
    for (const lot of this.lots.values()) {
      if (lot.facilityId !== fac || lot.qc !== 'RELEASED') continue;
      const h = SKU_HANDLING[lot.skuId];
      if (!h || !(highC > h.maxC || lowC < h.minC)) continue;
      const inZone = [...this.bins.values()].some((b) => b.lotId === lot.id && binById(b.binId)?.zone === zone);
      if (!inZone) continue;
      lot.qc = 'HOLD';
      lot.qcReason = reason.slice(0, 200);
      n++;
    }
    if (n) this.version++;
    return n;
  }

  // ---------------------------------------------------------------- views of the state
  palletsOf(lotId: string): number { let n = 0; for (const b of this.bins.values()) if (b.lotId === lotId) n++; return n; }
  binsOf(fac: FacilityId): WmsBinStock[] { return [...this.bins.values()].filter((b) => binById(b.binId)?.facilityId === fac); }
  verifyChain(): { ok: boolean; verified: number; brokenAt: number | null } {
    for (let i = 0; i < this.ledger.length; i++) {
      const e = this.ledger[i];
      const m = e.move;
      const h = createHash('sha256').update(e.prev + JSON.stringify([m.seq, m.lotId, m.facilityId, m.skuId, m.type, m.units, m.toBinId ?? m.binId, m.refId, m.at])).digest('hex');
      if (h !== e.hash || (i > 0 && this.ledger[i - 1].hash !== e.prev)) return { ok: false, verified: i, brokenAt: e.seq };
    }
    return { ok: true, verified: this.ledger.length, brokenAt: null };
  }
  /** Tamper test without touching the real chain: change one units value in a copy and re-verify. */
  tamperTest(): { row: number | null; detectedAt: number | null } {
    if (this.ledger.length < 2) return { row: null, detectedAt: null };
    const k = Math.floor(this.ledger.length / 2);
    const copy = this.ledger.map((e) => ({ ...e, move: { ...e.move } }));
    copy[k].move.units += 1;
    for (let i = 0; i < copy.length; i++) {
      const e = copy[i];
      const m = e.move;
      const h = createHash('sha256').update(e.prev + JSON.stringify([m.seq, m.lotId, m.facilityId, m.skuId, m.type, m.units, m.toBinId ?? m.binId, m.refId, m.at])).digest('hex');
      if (h !== e.hash) return { row: copy[k].seq, detectedAt: e.seq };
    }
    return { row: copy[k].seq, detectedAt: null };
  }

  snapshot(): unknown {
    return {
      lots: [...this.lots.values()], bins: [...this.bins.values()], policy: this.policy, nextLot: this.nextLot, nextSerial: this.nextSerial,
      events: this.events.slice(-60), moves: this.moves.slice(-3000), damage: this.damage, breaches: this.breaches,
      abc: [...this.abcClass], demandToday: [...this.demandToday], day: dayStr(new Date()),
    };
  }
  restore(s: Record<string, unknown>): void {
    this.load({ lots: (s.lots as WmsLot[]) ?? [], bins: (s.bins as WmsBinStock[]) ?? [], policy: s.policy as Record<string, 'RANDOM' | 'ABC'>, nextLot: s.nextLot as number, nextSerial: s.nextSerial as number });
    this.events.push(...((s.events as WmsEvent[]) ?? []));
    this.moves.push(...((s.moves as WmsMove[]) ?? []));
    this.seq = Math.max(1, ...this.moves.map((m) => m.seq + 1));
    this.damage.push(...((s.damage as MemDamage[]) ?? []));
    this.breaches.push(...((s.breaches as MemBreach[]) ?? []));
    for (const [k, v] of (s.abc as [string, AbcClass][]) ?? []) this.abcClass.set(k, v);
    if (s.day === dayStr(new Date())) for (const [k, v] of (s.demandToday as [string, { units: number; picks: number }][]) ?? []) this.demandToday.set(k, v);
    this.evSeq = this.events.length + 1;
  }
}
