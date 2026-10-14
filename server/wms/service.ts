// Smart Warehouse service: runs the engine alongside the simulation, saves it, delivers events,
// and answers the API. With Oracle every report comes from SQL (see oracle-wms.ts); without
// Oracle the same reports are computed from the engine's state, and say so.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { WorldState, FacilityId, EntityRef } from '../../src/data/types';
import type { SimOp } from '../../src/sim/engine';
import { SKUS, createSeedWorld } from '../../src/data/seed';
import { vesselByPrefix, storeDef } from '../../src/data/city';
import {
  SKU_HANDLING, siteStorage, binById, demandHistory, DAMAGE_SEEDS, WMS_FACILITIES, pickSequence, shortestPath, nodeById, parseScan, validSscc, sscc as makeSscc,
} from '../../src/data/wms';
import type {
  WmsFeatures, WmsOverview, WmsSiteKpi, BinMap, AbcReport, AbcRow, ReslotResult, LotsReport, LotRow, TraceReport, TraceNode, ColdReport, SensorStatus,
  LedgerReport, ForecastReport, ForecastPoint, ReplenishReport, ReplenishRow, ScanResult, PalletLabel, RouteReport, SearchReport, SearchHit, DamageInput, WmsEvent, AbcClass, FefoViolation,
} from '../../src/api/wms-types';
import { AppError, type Repo } from '../db/repo';
import { WmsEngine, daysTo, palletSscc, type MemDamage } from './engine';
import { OracleWms, SQL, type WmsDeps } from './oracle-wms';
import { Embedder, cosine } from './embed';
import { REPORTERS } from '../db/gen-wms-seed';

const r1 = (n: number) => Math.round(n * 10) / 10;
let seedUnits: Map<string, number> | null = null;
/** Opening stock per site and product (scales the demand history, as in 11_wms_seed.sql). */
const stockOf = (fac: string, sku: string): number | null => {
  if (!seedUnits) { seedUnits = new Map(); for (const f of Object.values(createSeedWorld().facilities)) for (const l of f.inventory) seedUnits.set(`${f.id}:${l.skuId}`, l.units); }
  return seedUnits.get(`${fac}:${sku}`) ?? null;
};
const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export class WmsService {
  readonly engine = new WmsEngine();
  readonly embedder: Embedder;
  private oracle: OracleWms | null = null;
  private feat: WmsFeatures;
  private world!: WorldState;
  private saveAt = 0;
  private lastDetect = 0;
  private stopped = false;
  private lastEventId = 0;
  private embedding = false;
  private products = new Map<string, number[]>();
  /** Genealogy facts gathered from the simulation (the in-memory recall trace). */
  private orderStore = new Map<string, string>();
  private shipCustomer = new Map<string, string>();
  private ready = false;
  onChange: (() => void) | null = null;
  bumpTasks: (() => void) | null = null;

  constructor(private repo: Repo, private file: string, deps: WmsDeps | null) {
    if (deps) this.oracle = new OracleWms(deps);
    this.embedder = new Embedder(resolve(dirname(file), 'models'));
    this.feat = { engine: repo.kind, installed: !deps, partitioned: false, partitions: 0, blockchain: false, vector: false, queue: null, jobs: [], graph: false, embedModel: this.embedder.model, note: deps ? null : 'Running without Oracle: the warehouse reports are computed by the server.' };
    this.engine.createTask = async (t) => {
      const id = await this.repo.createTask(null, { facilityId: t.facilityId, title: t.title, description: t.description, type: t.type, priority: t.priority, assigneeId: null, dueMinutes: t.dueMinutes, source: 'SYSTEM' });
      this.bumpTasks?.();
      return id;
    };
  }

  get source(): 'oracle' | 'memory' { return this.oracle && this.feat.installed ? 'oracle' : 'memory'; }

  // ---------------------------------------------------------------- lifecycle
  async start(world: WorldState): Promise<void> {
    this.world = world;
    if (this.oracle) {
      try {
        this.feat = await this.oracle.features(this.embedder.model, true);
      } catch (e) {
        this.feat = { ...this.feat, installed: false, note: `Smart Warehouse tables could not be read: ${(e as Error).message}` };
      }
      if (this.feat.installed) {
        this.engine.memoryEvents = false;
        this.engine.detectInMemory = false;
        const s = await this.oracle.load();
        this.engine.load(s);
        if (s.empty) {
          const n = this.engine.initFromInventory(world);
          console.log(`[wms] placed the opening stock in bins: ${n} pallets`);
          await this.persist();
        }
        this.lastEventId = await this.oracle.lastEventId().catch(() => 0);
        void this.eventLoop();
      } else {
        console.warn(`[wms] ${this.feat.note ?? 'Smart Warehouse not installed'} — running it in memory for now.`);
        this.engine.initFromInventory(world);
      }
    } else {
      if (!this.loadFile(world)) this.engine.initFromInventory(world);
      this.seedDamage();
    }
    void this.refreshAbc();
    void this.maintainEmbeddings();
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.flush(true);
  }

  onOp(op: SimOp, w: WorldState): void {
    if (!this.ready) return;
    if (op.k === 'stock' && op.reason === 'STORE_SHIP' && op.shipmentId) {
      const o = w.retail.orders[op.shipmentId];
      if (o) this.orderStore.set(op.shipmentId, o.storeId);
    }
    if (op.k === 'stock' && op.reason === 'PICK' && op.shipmentId) {
      const s = w.shipments[op.shipmentId];
      if (s) this.shipCustomer.set(op.shipmentId, s.customer);
    }
    this.engine.onOp(op, w);
  }

  tick(): void { if (this.ready && !this.stopped) this.engine.tickSensors(); }

  private persisting = false;
  private async persist(): Promise<void> {
    if (!this.oracle || !this.feat.installed || this.persisting) return;
    this.persisting = true;
    const p = this.engine.takePending();
    try {
      await this.oracle.persist(p);
    } catch (e) {
      this.engine.restorePending(p);
      console.error('[wms] saving failed:', (e as Error).message.split('\n')[0]);
    } finally {
      this.persisting = false;
    }
  }

  /** Called after each flush of the simulation. */
  async flush(force = false): Promise<void> {
    if (!this.ready) return;
    if (this.source === 'oracle') {
      await this.persist();
      try {
        const r = await this.oracle!.refresh();
        for (const q of r.qc) {
          const lot = this.engine.lots.get(q.lotId);
          if (lot && (lot.qc !== q.qc || lot.qcReason !== q.reason)) this.engine.setQc(q.lotId, q.qc, q.reason);
        }
        for (const [id, open] of Object.entries(r.doors)) {
          const st = this.engine.sensors.get(id);
          if (st && st.doorOpen !== open) this.engine.setDoor(id, open);
        }
        Object.assign(this.engine.policy, r.policy);
      } catch (e) {
        console.error('[wms] refresh failed:', (e as Error).message.split('\n')[0]);
      }
      // without the scheduler job the server runs the database's breach detector itself
      if (!this.feat.jobs.includes('CV_DETECT_BREACHES') && Date.now() - this.lastDetect > 10000) {
        this.lastDetect = Date.now();
        try { if (await this.oracle!.detectBreaches()) this.bumpTasks?.(); } catch (e) { console.error('[wms] breach detection failed:', (e as Error).message.split('\n')[0]); }
      }
    } else {
      this.engine.takePending(); // memory: the state itself is the record
      if (force || Date.now() - this.saveAt > 10000) this.saveFile();
    }
  }

  private async eventLoop(): Promise<void> {
    while (!this.stopped && this.oracle) {
      try {
        if (this.feat.queue) {
          const msgs = await this.oracle.dequeue(2);
          for (const m of msgs) this.deliver(m, 'queue');
        } else {
          const rows = await this.oracle.eventsAfter(this.lastEventId);
          for (const m of rows) { this.lastEventId = Math.max(this.lastEventId, Number(m.id)); this.deliver(m, 'table'); }
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (e) {
        const msg = (e as Error).message.split('\n')[0];
        if (this.feat.queue) { console.warn(`[wms] event queue unavailable (${msg}); reading WMS_EVENTS instead`); this.feat = { ...this.feat, queue: null }; }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  private deliver(m: Record<string, unknown>, via: 'queue' | 'table'): void {
    const e: WmsEvent = {
      id: String(m.id), type: String(m.type), facilityId: (m.facility as string) ?? null, title: String(m.title ?? ''), detail: (m.detail as string) ?? null,
      refKind: (m.refKind as string) ?? null, refId: (m.refId as string) ?? null, at: String(m.at ?? new Date().toISOString()), receivedAt: new Date().toISOString(), via,
    };
    if (e.type === 'RECALL' || e.type === 'BREACH') this.bumpTasks?.();
    this.engine.deliver(e);
    this.onChange?.();
  }

  // ---------------------------------------------------------------- memory persistence
  private loadFile(world: WorldState): boolean {
    try {
      const f = resolve(dirname(this.file), 'wms.json');
      if (!existsSync(f)) return false;
      const s = JSON.parse(readFileSync(f, 'utf8'));
      if (s.v !== 1 || !s.state?.lots?.length) return false;
      // only if it belongs to this world: every product's lots must add up to the book
      const sum = new Map<string, number>();
      for (const l of s.state.lots as { facilityId: string; skuId: string; units: number }[]) sum.set(`${l.facilityId}:${l.skuId}`, (sum.get(`${l.facilityId}:${l.skuId}`) ?? 0) + l.units);
      for (const fac of WMS_FACILITIES) for (const line of world.facilities[fac]?.inventory ?? []) {
        if ((sum.get(`${fac}:${line.skuId}`) ?? 0) !== line.units) return false;
      }
      this.engine.restore(s.state);
      return true;
    } catch { return false; }
  }
  private saveFile(): void {
    this.saveAt = Date.now();
    try {
      const f = resolve(dirname(this.file), 'wms.json');
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify({ v: 1, state: this.engine.snapshot() }));
    } catch (e) { console.error('[wms] could not save', (e as Error).message); }
  }
  private seedDamage(): void {
    if (this.engine.damage.length) return;
    DAMAGE_SEEDS.forEach((d, i) => this.engine.damage.push({
      id: i + 1, facilityId: d.facilityId, skuId: d.skuId, lotId: null, sscc: null, severity: d.severity, text: d.text, reportedBy: REPORTERS[d.facilityId],
      at: new Date(Date.now() - (d.daysAgo * 24 + 3) * 3600000).toISOString(), vec: null, model: null,
    }));
  }

  // ---------------------------------------------------------------- embeddings
  private async maintainEmbeddings(): Promise<void> {
    if (this.embedding) return;
    this.embedding = true;
    try {
      await this.embedder.ready;
      this.feat = { ...this.feat, embedModel: this.embedder.model };
      const model = this.embedder.model;
      if (this.source === 'oracle') {
        const todo = await this.oracle!.missingEmbeddings(model);
        for (let i = 0; i < todo.length; i += 16) {
          const chunk = todo.slice(i, i + 16);
          const vs = await this.embedder.embed(chunk.map((t) => t.text));
          await this.oracle!.saveEmbeddings(chunk.map((t, k) => ({ table: t.table, id: t.id, v: vs[k] })), model, this.feat.vector);
        }
        if (todo.length) console.log(`[wms] embedded ${todo.length} texts with ${model}`);
      } else {
        const todo = this.engine.damage.filter((d) => d.model !== model);
        const vs = await this.embedder.embed(todo.map((d) => d.text));
        todo.forEach((d, k) => { d.vec = vs[k]; d.model = model; });
      }
      const skus = Object.values(SKU_HANDLING);
      const pv = await this.embedder.embed(skus.map((h) => h.description));
      skus.forEach((h, k) => this.products.set(h.skuId, pv[k]));
    } catch (e) {
      console.error('[wms] embeddings:', (e as Error).message.split('\n')[0]);
    } finally {
      this.embedding = false;
    }
  }

  // ---------------------------------------------------------------- overview and 3D
  async features(): Promise<WmsFeatures> {
    if (this.oracle && this.feat.installed) {
      try { this.feat = await this.oracle.features(this.embedder.model); } catch { /* keep the last */ }
    }
    return { ...this.feat, embedModel: this.embedder.model, note: this.feat.note ?? this.embedder.note };
  }

  async overview(facs: FacilityId[]): Promise<WmsOverview> {
    const E = this.engine;
    const mpp = this.source === 'oracle' ? await this.oracle!.metresPerPick().catch(() => ({} as Record<string, number>)) : null;
    const sites: WmsSiteKpi[] = facs.filter((f) => WMS_FACILITIES.includes(f)).map((fac) => {
      const lots = [...E.lots.values()].filter((l) => l.facilityId === fac && l.units > 0);
      const sensors = [...E.sensors.values()].filter((s) => s.def.facilityId === fac);
      const status = sensors.map((s) => this.sensorStatus(s.def.id).status);
      const m = E.picksMetres[fac] ?? [];
      const cls = this.abcCache.get(fac);
      return {
        facilityId: fac, bins: siteStorage(fac).bins.length, occupied: E.binsOf(fac).length, lots: lots.length,
        held: lots.filter((l) => l.qc !== 'RELEASED').length,
        expiring: lots.filter((l) => l.qc === 'RELEASED' && l.expiry && (daysTo(l.expiry) ?? 999) <= 30).length,
        policy: E.policy[fac] ?? 'RANDOM',
        metresPerPick: mpp ? (mpp[fac] ?? null) : m.length ? r1(m.reduce((a, x) => a + x, 0) / m.length) : null,
        expectedMetresPerPick: cls ? E.expectedMetres(fac, new Map(cls.map((r) => [r.skuId, { cls: r.abc, units: r.units30d }]))) : null,
        sensorsOk: status.filter((s) => s === 'OK' || s === 'WARN').length, sensorsOut: status.filter((s) => s === 'OUT').length,
      };
    });
    return { source: this.source, features: await this.features(), sites, events: E.events.slice(-30).reverse() };
  }

  binMap(fac: FacilityId): BinMap {
    const E = this.engine;
    const cells = E.binsOf(fac).map((b) => {
      const lot = E.lots.get(b.lotId);
      return { b: b.binId, s: lot?.skuId ?? '?', l: b.lotId, u: b.units, e: daysTo(lot?.expiry ?? null), q: lot?.qc ?? 'RELEASED', c: E.abcClass.get(`${fac}:${lot?.skuId}`) ?? null };
    });
    return { facilityId: fac, policy: E.policy[fac] ?? 'RANDOM', cells, blocked: [] };
  }
  version(): number { return this.engine.version; }
  recentEvents(n = 6): WmsEvent[] { return this.engine.events.slice(-n); }

  // ---------------------------------------------------------------- ABC slotting
  private abcCache = new Map<FacilityId, AbcRow[]>();
  private async refreshAbc(): Promise<void> {
    for (const fac of WMS_FACILITIES) {
      try { await this.abc(fac); } catch { /* next time */ }
    }
  }
  private abcMemory(fac: FacilityId): AbcRow[] {
    const f = this.world.facilities[fac];
    if (!f) return [];
    const rows = f.inventory.map((l) => {
      const hist = demandHistory(fac, l.skuId, 29, stockOf(fac, l.skuId));
      const today = this.engine.demandToday.get(`${fac}:${l.skuId}`) ?? { units: 0, picks: 0 };
      return { skuId: l.skuId, units: hist.reduce((a, d) => a + d.units, 0) + today.units, picks: hist.reduce((a, d) => a + d.picks, 0) + today.picks };
    }).sort((a, b) => b.units - a.units || a.skuId.localeCompare(b.skuId));
    const total = rows.reduce((a, r) => a + r.units, 0) || 1;
    let cum = 0;
    return rows.map((r, i) => {
      const share = (100 * r.units) / total;
      cum += share;
      const ds = this.engine.binsOf(fac).filter((b) => this.engine.lots.get(b.lotId)?.skuId === r.skuId).map((b) => binById(b.binId)!.dockMetres);
      return {
        facilityId: fac, skuId: r.skuId, skuName: SKUS[r.skuId]?.name ?? r.skuId, units30d: r.units, picks30d: r.picks, sharePct: r1(share), cumulativePct: r1(cum), rank: i + 1,
        abc: (r1(cum) <= 80 || i === 0 ? 'A' : r1(cum) <= 95 ? 'B' : 'C') as AbcClass, avgDockMetres: ds.length ? r1(ds.reduce((a, d) => a + d, 0) / ds.length) : null, pallets: ds.length,
      };
    });
  }
  async abc(fac: FacilityId): Promise<AbcReport> {
    const rows = this.source === 'oracle' ? await this.oracle!.abc(fac) : this.abcMemory(fac);
    this.abcCache.set(fac, rows);
    for (const r of rows) this.engine.abcClass.set(`${fac}:${r.skuId}`, r.abc);
    const cls = new Map(rows.map((r) => [r.skuId, { cls: r.abc, units: r.units30d }]));
    const m = this.engine.picksMetres[fac] ?? [];
    return {
      source: this.source, facilityId: fac, policy: this.engine.policy[fac] ?? 'RANDOM', rows, expectedMetresPerPick: this.engine.expectedMetres(fac, cls),
      metresPerPick: m.length ? r1(m.reduce((a, x) => a + x, 0) / m.length) : null, sql: SQL.abc,
    };
  }
  async reslot(fac: FacilityId, userId: number): Promise<ReslotResult> {
    const rep = await this.abc(fac);
    const cls = new Map(rep.rows.map((r) => [r.skuId, { cls: r.abc, units: r.units30d }]));
    const res = this.engine.reslot(this.world, fac, cls, userId);
    let taskId: number | null = null;
    if (res.moves.length) {
      taskId = await this.repo.createTask(userId, {
        facilityId: fac, title: `Re-slot ${res.moves.length} pallets (ABC)`, type: 'PUTAWAY', priority: 'NORMAL', assigneeId: null, dueMinutes: 120, source: 'MANUAL',
        description: `Move fast movers (class A) next to the docks: expected travel per pick ${res.before} m → ${res.after} m. ${res.moves.slice(0, 8).map((m) => `${m.skuId} ${m.from}→${m.to}`).join(', ')}${res.moves.length > 8 ? ', …' : ''}`,
      }).catch(() => null);
      this.bumpTasks?.();
    }
    this.engine.announce('RESLOT', fac, `Re-slotted ${res.moves.length} pallets at ${fac}`, `Expected travel per pick ${res.before} m → ${res.after} m; new pallets now go to their ABC zone`, 'facility', fac);
    if (this.source === 'oracle') await this.persist();
    this.onChange?.();
    return { facilityId: fac, moved: res.moves.length, beforeMetres: res.before, afterMetres: res.after, taskId, moves: res.moves.slice(0, 40) };
  }

  // ---------------------------------------------------------------- lots, FEFO, expiry
  private lotRow(l: { id: string }, rank: number): LotRow {
    const lot = this.engine.lots.get(l.id)!;
    return {
      lotId: lot.id, facilityId: lot.facilityId, skuId: lot.skuId, skuName: SKUS[lot.skuId]?.name ?? lot.skuId, supplier: lot.supplier, shipmentId: lot.shipmentId,
      containerNo: lot.containerNo, receivedAt: lot.receivedAt, expiry: lot.expiry, daysToExpiry: daysTo(lot.expiry), qc: lot.qc, qcReason: lot.qcReason,
      units: lot.units, unitsReceived: lot.unitsReceived, pallets: this.engine.palletsOf(lot.id), fefoRank: rank,
    };
  }
  async lots(facs: FacilityId[]): Promise<LotsReport> {
    const set = new Set<string>(facs);
    if (this.source === 'oracle') {
      const r = await this.oracle!.lots();
      return { source: 'oracle', lots: r.lots.filter((l) => set.has(l.facilityId)), violations: r.violations.filter((v) => set.has(v.facilityId)), sql: `${SQL.lots}\n\n${SQL.violations}` };
    }
    const groups = new Map<string, string[]>();
    for (const l of this.engine.lots.values()) {
      if (!set.has(l.facilityId) || (l.units <= 0 && l.qc === 'RELEASED')) continue;
      const k = `${l.facilityId}:${l.skuId}`;
      groups.set(k, [...(groups.get(k) ?? []), l.id]);
    }
    const lots: LotRow[] = [];
    for (const ids of groups.values()) {
      const sorted = ids.map((id) => this.engine.lots.get(id)!).sort((a, b) =>
        Number(!(a.qc === 'RELEASED' && a.units > 0)) - Number(!(b.qc === 'RELEASED' && b.units > 0)) || (a.expiry ?? '9999').localeCompare(b.expiry ?? '9999') || a.receivedAt.localeCompare(b.receivedAt));
      sorted.forEach((l, i) => lots.push(this.lotRow(l, i + 1)));
    }
    lots.sort((a, b) => a.facilityId.localeCompare(b.facilityId) || a.skuId.localeCompare(b.skuId) || a.fefoRank - b.fefoRank);
    const violations: FefoViolation[] = this.engine.moves.filter((m) => m.fefoOk === false && set.has(m.facilityId)).slice(-30).reverse().map((m) => {
      const lot = this.engine.lots.get(m.lotId);
      const older = [...this.engine.lots.values()].filter((o) => o.facilityId === m.facilityId && o.skuId === m.skuId && o.id !== m.lotId && (o.expiry ?? '9999') < (lot?.expiry ?? '9999')).sort((a, b) => (a.expiry ?? '').localeCompare(b.expiry ?? ''))[0];
      return { moveId: m.seq, pickedAt: m.at, facilityId: m.facilityId, skuId: m.skuId, pickedLot: m.lotId, pickedExpiry: lot?.expiry ?? null, olderLot: older?.id ?? '?', olderExpiry: older?.expiry ?? null, units: -m.units, ref: m.refId };
    });
    return { source: 'memory', lots, violations, sql: 'Without Oracle: the same FEFO ordering is computed by the server.' };
  }

  // ---------------------------------------------------------------- recall trace
  private label(kind: string, id: string): { label: string; ref: EntityRef | null } {
    switch (kind) {
      case 'VESSEL': return { label: this.world.port.vessels[id]?.name ?? id, ref: { kind: 'vessel', id } };
      case 'CONTAINER': return { label: `Container ${id}`, ref: null };
      case 'SHIPMENT': { const s = this.world.shipments[id]; return { label: `${id}${s ? ` · ${s.direction === 'inbound' ? 'in from' : 'to'} ${s.customer}` : ''}`, ref: s ? { kind: 'truck', id: s.truckId } : null }; }
      case 'LOT': { const l = this.engine.lots.get(id); return { label: `Lot ${id}${l ? ` · ${SKUS[l.skuId]?.name ?? l.skuId}` : ''}`, ref: null }; }
      case 'ORDER': return { label: `Store order ${id}`, ref: null };
      case 'STORE': { const d = storeDef(id); return { label: d?.name ?? id, ref: { kind: 'store', id } }; }
      case 'CUSTOMER': return { label: id, ref: null };
      default: return { label: id, ref: null };
    }
  }
  private memLinks(): { pk: string; pid: string; ck: string; cid: string; units: number | null }[] {
    const out: { pk: string; pid: string; ck: string; cid: string; units: number | null }[] = [];
    const w = this.world;
    const containers = new Set<string>();
    for (const l of this.engine.lots.values()) {
      if (l.shipmentId) out.push({ pk: 'SHIPMENT', pid: l.shipmentId, ck: 'LOT', cid: l.id, units: l.unitsReceived });
      if (l.containerNo && l.shipmentId) { out.push({ pk: 'CONTAINER', pid: l.containerNo, ck: 'SHIPMENT', cid: l.shipmentId, units: null }); containers.add(l.containerNo); }
    }
    for (const c of containers) { const v = vesselByPrefix(c); if (v) out.push({ pk: 'VESSEL', pid: v.id, ck: 'CONTAINER', cid: c, units: null }); }
    const agg = new Map<string, { pk: string; pid: string; ck: string; cid: string; units: number }>();
    for (const m of this.engine.moves) {
      if ((m.type !== 'PICK' && m.type !== 'SHIP_STORE') || !m.refId || !m.refKind) continue;
      const k = `${m.lotId}|${m.refKind}|${m.refId}`;
      const a = agg.get(k) ?? { pk: 'LOT', pid: m.lotId, ck: m.refKind, cid: m.refId, units: 0 };
      a.units += -m.units;
      agg.set(k, a);
    }
    out.push(...agg.values());
    for (const [o, st] of this.orderStore) out.push({ pk: 'ORDER', pid: o, ck: 'STORE', cid: st, units: w.retail.orders[o]?.units ?? null });
    for (const [s, c] of this.shipCustomer) if (w.shipments[s]?.direction !== 'inbound') out.push({ pk: 'SHIPMENT', pid: s, ck: 'CUSTOMER', cid: c, units: null });
    return out;
  }
  async trace(kind: string, id: string, dir: 'down' | 'up'): Promise<TraceReport> {
    let rows: { kind: string; id: string; parent: string | null; depth: number; units: number | null }[];
    if (this.source === 'oracle') rows = await this.oracle!.trace(kind, id, dir);
    else {
      const links = this.memLinks();
      rows = [{ kind, id, parent: null, depth: 0, units: null }];
      const seen = new Set([`${kind}:${id}`]);
      const walk = (k: string, i: string, depth: number) => {
        if (depth >= 6) return;
        const next = dir === 'down' ? links.filter((l) => l.pk === k && l.pid === i).map((l) => ({ k: l.ck, i: l.cid, u: l.units }))
          : links.filter((l) => l.ck === k && l.cid === i).map((l) => ({ k: l.pk, i: l.pid, u: l.units }));
        for (const n of next.sort((a, b) => a.k.localeCompare(b.k) || a.i.localeCompare(b.i))) {
          const key = `${n.k}:${n.i}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({ kind: n.k, id: n.i, parent: `${k}:${i}`, depth: depth + 1, units: n.u });
          walk(n.k, n.i, depth + 1);
        }
      };
      walk(kind, id, 0);
    }
    const nodes: TraceNode[] = rows.map((r) => ({ key: `${r.kind}:${r.id}`, kind: r.kind, id: r.id, depth: r.depth, units: r.units, parent: r.parent, ...this.label(r.kind, r.id) }));
    return {
      source: this.source, root: { kind, id }, direction: dir, nodes,
      stores: [...new Set(nodes.filter((n) => n.kind === 'STORE').map((n) => n.id))], customers: [...new Set(nodes.filter((n) => n.kind === 'CUSTOMER').map((n) => n.id))],
      sql: dir === 'down' ? SQL.traceDown : SQL.traceUp,
    };
  }

  async recall(lotId: string, reason: string, userId: number): Promise<{ stores: number }> {
    const lot = this.engine.lots.get(lotId);
    if (this.source === 'oracle') {
      const stores = await this.oracle!.recall(lotId, reason, userId);
      this.engine.setQc(lotId, 'RECALLED', reason);
      this.bumpTasks?.();
      return { stores };
    }
    if (!lot) throw new AppError(404, `Lot ${lotId} not found`);
    this.engine.setQc(lotId, 'RECALLED', reason);
    const t = await this.trace('LOT', lotId, 'down');
    const pallets = this.engine.palletsOf(lotId);
    await this.engine.createTask?.({ facilityId: lot.facilityId, title: `Quarantine recalled lot ${lotId}`, type: 'OTHER', priority: 'URGENT', dueMinutes: 60,
      description: `Move ${pallets} pallet(s) of ${SKUS[lot.skuId]?.name} (lot ${lotId}) to the quarantine cage. Reason: ${reason}` });
    for (const st of t.stores) {
      await this.engine.createTask?.({ facilityId: lot.facilityId, title: `Recall: pull lot ${lotId} at ${storeDef(st)?.name ?? st}`, type: 'OTHER', priority: 'HIGH', dueMinutes: 240,
        description: `Collect every unit of ${SKUS[lot.skuId]?.name} from lot ${lotId} at ${storeDef(st)?.name ?? st} and return it. Reason: ${reason}` });
    }
    this.engine.announce('RECALL', lot.facilityId, `Lot ${lotId} recalled (${SKUS[lot.skuId]?.name})`, `${pallets} pallets quarantined, ${t.stores.length} stores notified. ${reason}`, 'lot', lotId);
    return { stores: t.stores.length };
  }
  async release(lotId: string, userId: number): Promise<void> {
    const lot = this.engine.lots.get(lotId);
    if (this.source === 'oracle') await this.oracle!.release(lotId, userId);
    else if (!lot) throw new AppError(404, `Lot ${lotId} not found`);
    else this.engine.announce('RELEASE', lot.facilityId, `Lot ${lotId} released`, 'Quality check passed; the lot can be picked again', 'lot', lotId);
    this.engine.setQc(lotId, 'RELEASED', null);
  }

  // ---------------------------------------------------------------- cold chain
  private sensorStatus(id: string): SensorStatus {
    const s = this.engine.sensors.get(id)!;
    const ring = this.engine.readings.get(id) ?? [];
    const last = ring[ring.length - 1];
    const t = last?.tempC ?? null;
    const status = t === null ? 'NO DATA' : t > s.def.maxC || t < s.def.minC ? 'OUT' : t > s.def.maxC - 1 || t < s.def.minC + 0.5 ? 'WARN' : 'OK';
    return {
      id, facilityId: s.def.facilityId, zone: s.def.zone, label: s.def.label, minC: s.def.minC, maxC: s.def.maxC, doorOpen: s.doorOpen || s.doorUntil > Date.now(),
      tempC: t, at: last?.at ?? null, status, series: ring.slice(-240).map((r) => ({ t: r.at, c: r.tempC })),
    };
  }
  async cold(facs: FacilityId[]): Promise<ColdReport> {
    const set = new Set<string>(facs);
    const sensors = [...this.engine.sensors.keys()].map((id) => this.sensorStatus(id)).filter((s) => set.has(s.facilityId));
    const held = (await this.lots(facs)).lots.filter((l) => l.qc === 'HOLD');
    if (this.source === 'oracle') {
      const r = await this.oracle!.cold();
      const series = new Map<string, { t: string; c: number }[]>();
      for (const x of r.series) series.set(x.SENSOR_ID, [...(series.get(x.SENSOR_ID) ?? []), { t: x.READ_UTC, c: Number(x.TEMP_C) }]);
      for (const s of sensors) { const ss = series.get(s.id); if (ss?.length) s.series = ss; }
      return {
        source: 'oracle', sensors, breaches: r.breaches.filter((b) => set.has(b.facilityId)), held, partitions: r.partitions, sql: SQL.breaches,
        detector: this.feat.jobs.includes('CV_DETECT_BREACHES') ? 'DBMS_SCHEDULER job CV_DETECT_BREACHES runs WT_WMS.DETECT_BREACHES every 15 s' : 'The server calls WT_WMS.DETECT_BREACHES every 10 s (no scheduler job)',
      };
    }
    return {
      source: 'memory', sensors, breaches: this.engine.breaches.filter((b) => set.has(b.facilityId)).slice(-15).reverse(), held, partitions: [], sql: SQL.breaches,
      detector: 'Without Oracle: the server applies the same rule (3+ readings in a row outside the range)',
    };
  }
  async door(sensorId: string, open: boolean, seconds: number, userId: number): Promise<void> {
    const s = this.engine.sensors.get(sensorId);
    if (!s) throw new AppError(404, `No sensor ${sensorId}`);
    if (seconds > 0) this.engine.setDoor(sensorId, true, seconds);
    else {
      if (this.source === 'oracle') await this.oracle!.setDoor(sensorId, open, userId);
      this.engine.setDoor(sensorId, open);
    }
    this.engine.announce('DOOR', s.def.facilityId, `${s.def.label} door ${open ? `opened${seconds ? ` for ${seconds} s` : ''}` : 'closed'}`, open ? 'Watch the temperature: three readings above the limit in a row is a breach' : null, 'sensor', sensorId);
  }

  // ---------------------------------------------------------------- tamper-proof ledger
  async ledger(): Promise<LedgerReport> {
    if (this.source === 'oracle') {
      const r = await this.oracle!.ledger();
      return {
        source: 'oracle', kind: r.kind, rows: r.rows, verified: r.verified, ok: r.ok, ms: r.ms, recent: r.recent, tamper: r.tamper, sql: SQL.ledger,
        note: r.kind === 'blockchain' ? 'Verified the rows of the last two hours with DBMS_BLOCKCHAIN_TABLE.VERIFY_ROWS.' : 'This database has no blockchain tables (Oracle 21c+); STOCK_LEDGER is a plain table.',
      };
    }
    const t0 = performance.now();
    const v = this.engine.verifyChain();
    const t = this.engine.tamperTest();
    return {
      source: 'memory', kind: 'hash-chain', rows: this.engine.ledger.length, verified: v.verified, ok: v.ok, ms: Math.round(performance.now() - t0),
      recent: this.engine.ledger.slice(-12).reverse().map((e) => ({ seq: e.seq, moveId: e.move.seq, lotId: e.move.lotId, facilityId: e.move.facilityId, skuId: e.move.skuId, type: e.move.type, units: e.move.units, binId: e.move.toBinId ?? e.move.binId, refId: e.move.refId, at: e.move.at, hash: e.hash.slice(0, 32) })),
      tamper: { attempted: `change units of ledger row ${t.row ?? '?'} in a copy and verify again`, error: t.detectedAt !== null ? `Chain broken at row ${t.detectedAt}: the hash no longer matches` : null, blocked: t.detectedAt !== null },
      sql: SQL.ledger, note: 'Without Oracle: a SHA-256 hash chain kept by the server stands in for the blockchain table.',
    };
  }

  // ---------------------------------------------------------------- forecasting and replenishment
  async forecast(fac: FacilityId, skuId: string): Promise<ForecastReport> {
    const points: ForecastPoint[] = [];
    let slope: number | null = null;
    let weekday: number[] = [];
    if (this.source === 'oracle') {
      const r = await this.oracle!.demand(fac, skuId);
      for (const h of r.history) points.push({ date: h.D, actual: Number(h.UNITS_OUT), forecast: null });
      const fmap = new Map(r.forecast.map((x) => [String(x.FORECAST_DATE), Number(x.FORECAST_UNITS)]));
      for (const [d, f] of fmap) { const p = points.find((x) => x.date === d); if (p) p.forecast = f; else points.push({ date: d, actual: null, forecast: f }); }
      slope = r.fit?.SLOPE !== null && r.fit?.SLOPE !== undefined ? r1(Number(r.fit.SLOPE)) : null;
      weekday = DOW_LABEL.map((_, i) => { const x = r.forecast.find((f) => new Date(`${String(f.FORECAST_DATE)}T00:00:00Z`).getUTCDay() === i); return x ? Number(x.WEEKDAY_INDEX) : 1; });
    } else {
      const hist = demandHistory(fac, skuId, 56, stockOf(fac, skuId));
      const today = this.engine.demandToday.get(`${fac}:${skuId}`);
      for (const h of hist) points.push({ date: h.date, actual: h.units, forecast: null });
      const xs = hist.map((h) => -h.daysAgo), ys = hist.map((h) => h.units);
      const mx = xs.reduce((a, x) => a + x, 0) / xs.length, my = ys.reduce((a, y) => a + y, 0) / ys.length;
      const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
      const b = sxx ? sxy / sxx : 0, a = my - b * mx;
      slope = r1(b);
      weekday = DOW_LABEL.map((_, d) => { const v = hist.filter((h) => h.weekday === d).map((h) => h.units); return v.length && my ? Math.round((v.reduce((s, x) => s + x, 0) / v.length / my) * 1000) / 1000 : 1; });
      const base = new Date();
      for (let k = 0; k < 14; k++) {
        const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + k));
        points.push({ date: d.toISOString().slice(0, 10), actual: k === 0 && today ? today.units : null, forecast: Math.max(0, Math.round((a + b * k) * weekday[d.getUTCDay()])) });
      }
    }
    const rep = (await this.replenishment([fac])).rows.find((r) => r.skuId === skuId) ?? null;
    return { source: this.source, facilityId: fac, skuId, points, slopePerDay: slope, weekday, replenish: rep, sql: `${SQL.forecast}\n\n${SQL.replenish}` };
  }
  async replenishment(facs: FacilityId[]): Promise<ReplenishReport> {
    const set = new Set<string>(facs);
    if (this.source === 'oracle') return { source: 'oracle', rows: (await this.oracle!.replenishment()).filter((r) => set.has(r.facilityId)), sql: SQL.replenish };
    const rows: ReplenishRow[] = [];
    for (const fac of facs) {
      const f = this.world.facilities[fac];
      if (!f) continue;
      for (const l of f.inventory) {
        const h = SKU_HANDLING[l.skuId];
        if (!h) continue;
        const hist = demandHistory(fac, l.skuId, 28, stockOf(fac, l.skuId)).map((d) => d.units);
        const avg = hist.reduce((a, x) => a + x, 0) / hist.length;
        const sd = Math.sqrt(hist.reduce((a, x) => a + (x - avg) ** 2, 0) / (hist.length - 1));
        const ss = Math.round(1.65 * sd * Math.sqrt(h.leadTimeDays));
        const rop = Math.round(avg * h.leadTimeDays + 1.65 * sd * Math.sqrt(h.leadTimeDays));
        const available = [...this.engine.lots.values()].filter((x) => x.facilityId === fac && x.skuId === l.skuId && x.qc === 'RELEASED').reduce((a, x) => a + x.units, 0);
        rows.push({
          facilityId: fac, skuId: l.skuId, skuName: SKUS[l.skuId]?.name ?? l.skuId, onHand: l.units, available, dailyDemand: r1(avg), dailySd: r1(sd), leadTimeDays: h.leadTimeDays,
          safetyStock: ss, reorderPoint: rop, eoq: Math.round(Math.sqrt((2 * avg * 365 * h.orderCost) / (0.25 * h.unitCost))), daysOfCover: avg ? r1(l.units / avg) : null,
          action: l.units <= rop ? 'REORDER' : 'OK',
        });
      }
    }
    rows.sort((a, b) => Number(a.action !== 'REORDER') - Number(b.action !== 'REORDER') || (a.daysOfCover ?? 999) - (b.daysOfCover ?? 999));
    return { source: 'memory', rows, sql: SQL.replenish };
  }
  async raiseReorders(facs: FacilityId[], userId: number): Promise<number> {
    const rows = (await this.replenishment(facs)).rows.filter((r) => r.action === 'REORDER');
    for (const r of rows) {
      await this.repo.createTask(userId, {
        facilityId: r.facilityId, title: `Raise purchase order: ${r.eoq} × ${r.skuName}`, type: 'OTHER', priority: (r.daysOfCover ?? 99) < (r.leadTimeDays) ? 'HIGH' : 'NORMAL',
        assigneeId: null, dueMinutes: 240, source: 'MANUAL',
        description: `On hand ${r.onHand} is at or below the reorder point ${r.reorderPoint} (demand ${r.dailyDemand}/day over a ${r.leadTimeDays}-day lead time + safety stock ${r.safetyStock}). Order the economic order quantity: ${r.eoq} units from ${SKU_HANDLING[r.skuId]?.supplier}.`,
      });
      this.engine.announce('REORDER', r.facilityId, `Reorder raised: ${r.eoq} × ${r.skuName}`, `Cover ${r.daysOfCover ?? '?'} days vs lead time ${r.leadTimeDays} days`, 'sku', r.skuId);
    }
    if (rows.length) this.bumpTasks?.();
    return rows.length;
  }

  // ---------------------------------------------------------------- scanning
  async scan(code: string, userId: number): Promise<ScanResult> {
    if (this.source === 'oracle') {
      const r = await this.oracle!.scan(code, userId);
      return {
        valid: r.valid === 'Y', code, sscc: r.sscc ?? null, where: r.where ?? null, result: r.result ?? (r.where === 'BIN' ? 'Pallet found in bin' : r.where === 'YARD' ? 'Pallet found on the yard' : r.where === 'MOVING' ? 'Pallet on a forklift' : ''),
        binId: r.binId, palletId: r.palletId, facilityId: r.facility, lotId: r.lotId, skuId: r.skuId, sku: r.sku, units: r.units, expiry: r.expiry ?? null, qc: r.qc,
        qcReason: r.qcReason ?? null, supplier: r.supplier, fefoLot: r.fefoLot ?? null, zone: r.zone, dockMetres: r.dockMetres, source: 'oracle',
      };
    }
    const s = parseScan(code);
    if (!validSscc(s)) {
      return { valid: false, code, sscc: null, where: null, result: `Invalid SSCC: ${s.length !== 18 || !/^\d+$/.test(s) ? 'needs 18 digits' : 'check digit does not match'}`, source: 'memory' };
    }
    const E = this.engine;
    const st = [...E.bins.values()].find((b) => b.sscc === s);
    let out: ScanResult;
    if (st) {
      const lot = E.lots.get(st.lotId)!;
      const bin = binById(st.binId)!;
      out = {
        valid: true, code, sscc: s, where: 'BIN', result: 'Pallet found in bin', binId: st.binId, facilityId: bin.facilityId, lotId: lot.id, skuId: lot.skuId,
        sku: SKUS[lot.skuId]?.name, units: st.units, expiry: lot.expiry, qc: lot.qc, qcReason: lot.qcReason, supplier: lot.supplier, fefoLot: E.fefoLot(lot.facilityId, lot.skuId),
        zone: bin.zone, dockMetres: bin.dockMetres, source: 'memory',
      };
    } else {
      const p = this.world.pallets[`PAL-${Number(s.slice(8, 17))}`];
      const lot = p ? E.lots.get(p.lot) : undefined;
      out = p ? {
        valid: true, code, sscc: s, where: p.slot !== null ? 'YARD' : 'MOVING', result: p.slot !== null ? 'Pallet found on the yard' : 'Pallet on a forklift', palletId: p.id,
        facilityId: p.facilityId, lotId: p.lot, skuId: p.skuId, sku: SKUS[p.skuId]?.name, units: p.qty, expiry: lot?.expiry ?? null, qc: lot?.qc ?? 'RELEASED', qcReason: lot?.qcReason ?? null,
        supplier: lot?.supplier, source: 'memory',
      } : { valid: true, code, sscc: s, where: 'NONE', result: 'Valid SSCC, but no pallet with this label is in stock', source: 'memory' };
    }
    E.announce('SCAN', out.facilityId ?? null, `Pallet ${s} scanned`, out.result, 'sscc', s);
    return out;
  }
  manualPick(sscc: string, userId: number): { ok: boolean; message: string; fefoOk: boolean | null } {
    const r = this.engine.manualPick(this.world, sscc, userId);
    if (!r.ok) throw new AppError(409, r.message);
    void this.persist();
    return { ok: r.ok, message: r.message, fefoOk: r.fefoOk };
  }
  labels(facs: FacilityId[]): PalletLabel[] {
    const out: PalletLabel[] = [];
    for (const fac of facs) {
      const bins = this.engine.binsOf(fac).sort((a, b) => a.binId.localeCompare(b.binId));
      // a few of each product, including the lot to pick next and a later one (to try a FEFO override)
      const bySku = new Map<string, typeof bins>();
      for (const b of bins) { const sku = this.engine.lots.get(b.lotId)?.skuId ?? '?'; bySku.set(sku, [...(bySku.get(sku) ?? []), b]); }
      for (const [sku, list] of bySku) {
        const sorted = list.sort((a, b) => (this.engine.lots.get(a.lotId)?.expiry ?? '9999').localeCompare(this.engine.lots.get(b.lotId)?.expiry ?? '9999'));
        for (const b of [sorted[0], sorted[sorted.length - 1]].filter((x, i, arr) => x && arr.indexOf(x) === i)) {
          const lot = this.engine.lots.get(b.lotId);
          out.push({ sscc: b.sscc, binId: b.binId, palletId: null, facilityId: fac, skuId: sku, lotId: b.lotId, units: b.units, expiry: lot?.expiry ?? null });
        }
      }
      for (const p of Object.values(this.world.pallets).filter((x) => x.facilityId === fac && x.slot !== null).slice(0, 3)) {
        out.push({ sscc: palletSscc(p.id), binId: null, palletId: p.id, facilityId: fac, skuId: p.skuId, lotId: p.lot, units: p.qty, expiry: this.engine.lots.get(p.lot)?.expiry ?? null });
      }
    }
    return out;
  }
  /** A deliberately wrong code (bad check digit) for the demonstration. */
  badLabel(): string { const g = makeSscc(123456789); return `${g.slice(0, 17)}${(Number(g[17]) + 3) % 10}`; }

  // ---------------------------------------------------------------- pick routes
  async route(fac: FacilityId, dock: string | null, binIds: string[]): Promise<RouteReport> {
    const site = siteStorage(fac);
    const docks = site.nodes.filter((n) => n.kind === 'DOCK');
    const d = docks.find((x) => x.id === dock) ?? docks[0];
    let bins = binIds.map((b) => binById(b)).filter((b): b is NonNullable<typeof b> => !!b && b.facilityId === fac);
    if (!bins.length) {
      // a pick list for the store orders waiting at this site: the FEFO bin of each product
      const want = Object.values(this.world.retail.orders).filter((o) => o.facilityId === fac && (o.status === 'PLACED' || o.status === 'LOADING')).map((o) => o.skuId);
      const skus = [...new Set([...want, ...(this.world.facilities[fac]?.inventory.map((l) => l.skuId) ?? [])])];
      for (const sku of skus) {
        const fb = this.engine.fefoBins(fac, sku).slice(0, 2);
        for (const x of fb) if (bins.length < 7) bins.push(x.bin);
      }
    }
    const stops = bins.map((b) => ({ binId: b.id, nodeId: b.nodeId, skuId: this.engine.lots.get(this.engine.bins.get(b.id)?.lotId ?? '')?.skuId ?? null }));
    const seq = pickSequence(site, d.id, stops.map((s) => s.nodeId));
    const legs = [d.id, ...seq.order, d.id];
    const path: { x: number; z: number }[] = [];
    let metres = 0;
    for (let i = 1; i < legs.length; i++) {
      let leg: { nodes: string[]; metres: number | null };
      if (this.source === 'oracle') leg = await this.oracle!.shortestPath(legs[i - 1], legs[i]);
      else leg = shortestPath(site, legs[i - 1], legs[i]);
      metres += leg.metres ?? 0;
      for (const n of leg.nodes) { const p = nodeById(fac, n); if (p && (!path.length || path[path.length - 1].x !== p.x || path[path.length - 1].z !== p.z)) path.push({ x: p.x, z: p.z }); }
    }
    const graph = this.source === 'oracle' && this.feat.graph ? { ...(await this.oracle!.graphQuery(d.id)), sql: SQL.graph } : null;
    return { source: this.source, facilityId: fac, dock: d.id, stops, order: seq.order, path, metres: r1(metres), naiveMetres: seq.naiveMetres, sql: SQL.route, graph };
  }

  // ---------------------------------------------------------------- semantic search
  async search(q: string): Promise<SearchReport> {
    const t0 = performance.now();
    const [v] = await this.embedder.embed([q]);
    let hits: SearchHit[];
    if (this.source === 'oracle') {
      if (this.feat.vector) hits = await this.oracle!.search(v);
      else hits = (await this.oracle!.allEmbeddings()).map((x) => ({ kind: x.kind, id: x.id, title: x.kind === 'DAMAGE' ? `Damage report #${x.id}` : x.id, text: x.text, facilityId: x.facilityId, skuId: x.skuId, score: Math.round(cosine(v, x.v) * 1000) / 1000, at: x.at, severity: x.severity })).sort((a, b) => b.score - a.score).slice(0, 8);
    } else {
      const docs: SearchHit[] = [
        ...this.engine.damage.filter((d) => d.vec).map((d) => ({ kind: 'DAMAGE' as const, id: String(d.id), title: `Damage report #${d.id}`, text: d.text, facilityId: d.facilityId, skuId: d.skuId, score: cosine(v, d.vec!), at: d.at, severity: d.severity })),
        ...[...this.products].map(([sku, pv]) => ({ kind: 'PRODUCT' as const, id: sku, title: sku, text: SKU_HANDLING[sku].description, facilityId: null, skuId: sku, score: cosine(v, pv), at: null, severity: null })),
      ];
      hits = docs.sort((a, b) => b.score - a.score).slice(0, 8).map((h) => ({ ...h, score: Math.round(h.score * 1000) / 1000 }));
    }
    for (const h of hits) if (h.kind === 'PRODUCT') h.title = SKUS[h.id]?.name ?? h.id;
    return { source: this.source, query: q, model: this.embedder.model, hits, ms: Math.round(performance.now() - t0), sql: this.feat.vector ? SQL.search : 'Embeddings compared by cosine similarity in the server (no VECTOR type in this database).' };
  }
  async addDamage(d: DamageInput, userId: number, reporter: string): Promise<number> {
    if (!SKUS[d.skuId]) throw new AppError(400, `Unknown product ${d.skuId}`);
    const text = d.text.trim();
    if (text.length < 8) throw new AppError(400, 'Describe the damage in a few words');
    let id: number;
    if (this.source === 'oracle') {
      id = await this.oracle!.addDamage({ facilityId: d.facilityId, skuId: d.skuId, severity: d.severity, text, sscc: d.sscc ?? null, lotId: d.lotId ?? null, reportedBy: reporter }, userId);
      void this.maintainEmbeddings();
    } else {
      id = Math.max(0, ...this.engine.damage.map((x) => x.id)) + 1;
      const [vec] = await this.embedder.embed([text]);
      const rec: MemDamage = { id, facilityId: d.facilityId, skuId: d.skuId, lotId: d.lotId ?? null, sscc: d.sscc ?? null, severity: d.severity, text, reportedBy: reporter, at: new Date().toISOString(), vec, model: this.embedder.model };
      this.engine.damage.push(rec);
      this.engine.announce('DAMAGE', d.facilityId, `Damage reported: ${d.skuId} (${d.severity.toLowerCase()})`, text.slice(0, 300), 'damage', String(id));
    }
    return id;
  }
}
