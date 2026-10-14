// Runs the shared operations simulation on the server, persists every change to
// the database, turns floor events into staff tasks, and serves live snapshots.
import type { WorldState, FacilityId } from '../src/data/types';
import type { SimControl, DbLiveStatus, DbCommit } from '../src/api/types';
import { stepWorld, syncPoses, setSimSink, type SimOp } from '../src/sim/engine';
import { SKUS } from '../src/data/seed';
import type { Repo, StockOp, EventOp, GateOp, BoxOp, CallOp, PersistBatch } from './db/repo';

const r1 = (n: number) => Math.round(n * 10) / 10;

export class SimHost {
  world!: WorldState;
  control: SimControl = { paused: false, speed: 1 };
  operators: Record<string, number> = {};
  versions = { tasks: 1, audit: 1, world: 1, gate: 1 };

  private stock: StockOp[] = [];
  private events: EventOp[] = [];
  private gate: GateOp[] = [];
  private box: BoxOp[] = [];
  private calls: CallOp[] = [];
  private ops: SimOp[] = [];
  private saved = new Map<string, string>();
  private last = performance.now();
  private tickTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private snapCache = new Map<string, { v: string; json: string }>();

  /** Write-through status of the database (shown live in the header and the Database tab). */
  db: DbLiveStatus;
  readonly commits: DbCommit[] = [];

  constructor(private repo: Repo, private persistEveryMs: number) {
    this.db = {
      engine: repo.kind, commits: 0, failures: 0, rowsWritten: 0, lastCommitAt: null, lastCommitMs: 0, lastRows: 0,
      lastTables: {}, lastError: null, lastErrorAt: null,
    };
  }

  private recordCommit(b: PersistBatch, ms: number, error?: string): void {
    const tables: Record<string, number> = {};
    const add = (t: string, n: number) => { if (n > 0) tables[t] = (tables[t] ?? 0) + n; };
    add('STOCK_MOVEMENTS', b.stock.length);
    add('OPERATION_EVENTS', b.events.length);
    add('PARK_GATE_LOG', b.gate.length);
    add('SHIPMENTS', b.shipments.length);
    add('TRUCKS', b.trucks.length);
    add('DOCKS', b.docks.length);
    add('PALLETS', b.pallets.length + b.deletedPallets.length);
    add('FORKLIFTS', b.forklifts.length);
    add('CHARGERS', b.chargers.length);
    add('FACILITIES', b.facilities.length);
    add('SIM_STATE', 1);
    const rows = Object.values(tables).reduce((a, n) => a + n, 0);
    const at = new Date().toISOString();
    const d = this.db;
    if (error) {
      d.failures++; d.lastError = error; d.lastErrorAt = at;
    } else {
      d.commits++; d.rowsWritten += rows; d.lastCommitAt = at; d.lastCommitMs = ms; d.lastRows = rows; d.lastTables = tables;
    }
    this.commits.push({ seq: d.commits + d.failures, at, ms, rows: error ? 0 : rows, tables: error ? {} : tables, ok: !error, error });
    if (this.commits.length > 40) this.commits.splice(0, this.commits.length - 40);
  }

  async start(): Promise<void> {
    const loaded = await this.repo.loadWorld();
    this.world = loaded.world;
    this.control = loaded.control;
    this.operators = loaded.operators;
    syncPoses(this.world);
    if (this.repo.kind === 'oracle') this.markAllSaved();
    setSimSink((op) => this.onOp(op));
    this.last = performance.now();
    this.tickTimer = setInterval(() => this.tick(), 50);
    this.flushTimer = setInterval(() => { void this.flush(); }, this.persistEveryMs);
    // make sure work already in progress at start-up has a task for its operator
    for (const t of Object.values(this.world.trucks)) {
      if (t.phase === 'working' && t.forkliftId) this.ops.push({ k: 'assigned', forkliftId: t.forkliftId, truckId: t.id });
    }
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    setSimSink(null);
    await this.flush();
  }

  setControl(c: SimControl): void {
    this.control = { ...c };
    this.versions.world++;
  }

  bump(kind: 'tasks' | 'audit'): void {
    this.versions[kind]++;
  }

  // ---------------------------------------------------------------- simulation
  private tick(): void {
    const now = performance.now();
    const dt = Math.min(1, (now - this.last) / 1000);
    this.last = now;
    if (this.control.paused) return;
    let remaining = dt * this.control.speed;
    while (remaining > 1e-6) {
      const step = Math.min(0.2, remaining);
      stepWorld(this.world, step);
      remaining -= step;
    }
    this.versions.world++;
  }

  private onOp(op: SimOp): void {
    if (op.k === 'stock') this.stock.push(op);
    else if (op.k === 'event') this.events.push(op);
    else if (op.k === 'gate') { this.gate.push(op); this.versions.gate++; }
    else if (op.k === 'box') this.box.push(op);
    else if (op.k === 'call') this.calls.push(op);
    else this.ops.push(op);
  }

  // ---------------------------------------------------------------- persistence
  private fp(kind: string, e: unknown): string {
    switch (kind) {
      case 'truck': {
        const t = e as WorldState['trucks'][string];
        return [t.phase, t.dockId, t.cargo, t.shipmentId, t.skuId, t.forkliftId, t.legIdx, r1(t.legDist), r1(t.pos.x), r1(t.pos.z),
          Math.round(Math.max(0, t.awayUntil - this.world.realTime))].join('|');
      }
      case 'forklift': {
        const f = e as WorldState['forklifts'][string];
        return [Math.round(f.battery * 2) / 2, f.task, f.truckId, f.palletId, f.movesToday, r1(f.pos.x), r1(f.pos.z),
          JSON.stringify(f.pick), JSON.stringify(f.drop)].join('|');
      }
      case 'pallet': {
        const p = e as WorldState['pallets'][string];
        return [p.slot, p.forkliftId, p.reserved, p.received].join('|');
      }
      case 'dock': { const d = e as WorldState['docks'][string]; return [d.truckId, d.trucksToday].join('|'); }
      case 'charger': { const c = e as WorldState['chargers'][string]; return [c.sessionsToday, r1(c.energyKwh)].join('|'); }
      case 'facility': { const f = e as WorldState['facilities'][string]; return [f.outboundToday, f.putawaysToday].join('|'); }
      case 'shipment': {
        const s = e as WorldState['shipments'][string];
        return [s.loadedAt, s.transitAt, s.deliveredAt, s.onTime, s.promisedAt].join('|');
      }
      case 'vessel': {
        const v = e as WorldState['port']['vessels'][string];
        return [v.status, v.berthId, r1(v.dist), v.importBoxes, v.exportBoxes, v.discharged, v.loaded, v.hold, v.voyage, Math.round(v.timer), Math.round(v.waited / 5)].join('|');
      }
      case 'berth': { const b = e as WorldState['port']['berths'][string]; return [b.open, b.vesselId].join('|'); }
      case 'crane': { const c = e as WorldState['port']['cranes'][string]; return [c.phase, Math.round(c.cycle * 5), c.movesToday].join('|'); }
      case 'store': { const st = e as WorldState['retail']['stores'][string]; return String(st.deliveriesToday); }
      case 'storeLine': { const l = e as WorldState['retail']['stores'][string]['lines'][number]; return [l.units, l.soldToday].join('|'); }
      case 'order': {
        const o = e as WorldState['retail']['orders'][string];
        return [o.status, o.units, o.vanId, o.dispatchedAt, o.deliveredAt].join('|');
      }
      case 'van': { const v = e as WorldState['retail']['vans'][string]; return [v.status, v.orderId, r1(v.dist), Math.round(v.timer), v.tripsToday].join('|'); }
      default: return '';
    }
  }

  private collections(): [string, Record<string, unknown>][] {
    const w = this.world;
    const lines: Record<string, unknown> = {};
    for (const st of Object.values(w.retail.stores)) for (const l of st.lines) lines[`${st.id}:${l.skuId}`] = l;
    return [['shipment', w.shipments], ['truck', w.trucks], ['dock', w.docks], ['pallet', w.pallets], ['forklift', w.forklifts],
      ['charger', w.chargers], ['facility', w.facilities], ['vessel', w.port.vessels], ['berth', w.port.berths], ['crane', w.port.cranes],
      ['store', w.retail.stores], ['storeLine', lines], ['order', w.retail.orders], ['van', w.retail.vans]];
  }

  private markAllSaved(): void {
    for (const [kind, coll] of this.collections()) {
      for (const [id, e] of Object.entries(coll)) this.saved.set(`${kind}:${id}`, this.fp(kind, e));
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || !this.world) return;
    this.flushing = true;
    try {
      const w = this.world;
      const batch: PersistBatch = {
        world: w, stock: this.stock.splice(0), events: this.events.splice(0), gate: this.gate.splice(0),
        trucks: [], shipments: [], forklifts: [], pallets: [], deletedPallets: [], docks: [], chargers: [], facilities: [],
        box: this.box.splice(0), calls: this.calls.splice(0), vessels: [], berths: [], cranes: [], storeLines: [], stores: [], orders: [], vans: [],
      };
      const next = new Map<string, string>();
      const changed = <T>(kind: string, id: string, e: T, out: T[]) => {
        const f = this.fp(kind, e);
        next.set(`${kind}:${id}`, f);
        if (this.saved.get(`${kind}:${id}`) !== f) out.push(e);
      };
      for (const s of Object.values(w.shipments)) changed('shipment', s.id, s, batch.shipments);
      for (const t of Object.values(w.trucks)) changed('truck', t.id, t, batch.trucks);
      for (const d of Object.values(w.docks)) changed('dock', d.id, d, batch.docks);
      for (const p of Object.values(w.pallets)) changed('pallet', p.id, p, batch.pallets);
      for (const f of Object.values(w.forklifts)) changed('forklift', f.id, f, batch.forklifts);
      for (const c of Object.values(w.chargers)) changed('charger', c.id, c, batch.chargers);
      for (const f of Object.values(w.facilities)) changed('facility', f.id, f, batch.facilities);
      for (const v of Object.values(w.port.vessels)) changed('vessel', v.id, v, batch.vessels);
      for (const b of Object.values(w.port.berths)) changed('berth', b.id, b, batch.berths);
      for (const c of Object.values(w.port.cranes)) changed('crane', c.id, c, batch.cranes);
      for (const st of Object.values(w.retail.stores)) {
        changed('store', st.id, st, batch.stores);
        const touched: typeof st.lines = [];
        for (const l of st.lines) changed('storeLine', `${st.id}:${l.skuId}`, l, touched);
        for (const l of touched) batch.storeLines.push({ storeId: st.id, line: l });
      }
      for (const o of Object.values(w.retail.orders)) changed('order', o.id, o, batch.orders);
      for (const v of Object.values(w.retail.vans)) changed('van', v.id, v, batch.vans);
      for (const key of this.saved.keys()) {
        if (key.startsWith('pallet:') && !next.has(key)) batch.deletedPallets.push(key.slice(7));
      }
      // shipments and store orders pruned from memory stay in the database as history
      for (const [key, v] of this.saved) if ((key.startsWith('shipment:') || key.startsWith('order:')) && !next.has(key)) next.set(key, v);
      const t0 = performance.now();
      try {
        await this.repo.persist(batch);
        this.saved = next;
        this.recordCommit(batch, Math.round((performance.now() - t0) * 10) / 10);
      } catch (err) {
        this.recordCommit(batch, Math.round((performance.now() - t0) * 10) / 10, String((err as Error).message).split('\n')[0]);
        // keep ledger rows for the next attempt; entity rows are re-diffed anyway
        this.stock.unshift(...batch.stock);
        this.events.unshift(...batch.events);
        this.gate.unshift(...batch.gate);
        this.box.unshift(...batch.box);
        this.calls.unshift(...batch.calls);
        console.error('[persist] failed:', (err as Error).message);
        return;
      }
      await this.runAutomation();
    } finally {
      this.flushing = false;
    }
  }

  // ---------------------------------------------------------------- task automation
  private async runAutomation(): Promise<void> {
    const ops = this.ops.splice(0);
    let touched = false;
    for (const op of ops) {
      try {
        if (op.k === 'assigned') touched = (await this.onAssigned(op.forkliftId, op.truckId)) || touched;
        else if (op.k === 'workDone') touched = (await this.onWorkDone(op.truckId)) || touched;
      } catch (err) {
        console.error('[automation]', op.k, (err as Error).message);
      }
    }
    if (touched) this.bump('tasks');
  }

  private async onAssigned(forkliftId: string, truckId: string): Promise<boolean> {
    const w = this.world;
    const t = w.trucks[truckId];
    const f = w.forklifts[forkliftId];
    if (!t || !f || t.phase !== 'working') return false;
    const emp = this.operators[forkliftId] ?? null;
    const open = await this.repo.openSystemTasks(truckId);
    if (open.length) {
      const task = open[0];
      if (emp !== null && task.assigneeId !== emp) {
        await this.repo.assignTask(null, task.id, emp, `Reassigned to ${f.operator} on ${f.id}`);
        return true;
      }
      return false;
    }
    const s = w.shipments[t.shipmentId];
    const dock = t.dockId ? w.docks[t.dockId] : null;
    const verb = t.direction === 'inbound' ? 'Unload' : 'Load';
    const left = t.direction === 'inbound' ? t.cargo : t.capacity - t.cargo;
    await this.repo.createTask(null, {
      facilityId: t.facilityId,
      title: `${verb} ${t.id} at ${dock?.name ?? 'dock'}`,
      description: `${verb} ${t.capacity} pallets of ${SKUS[t.skuId]?.name ?? t.skuId} for ${s ? `${s.id} (${s.customer})` : 'the current shipment'} using ${f.id}.`,
      type: t.direction === 'inbound' ? 'UNLOAD' : 'LOAD',
      priority: 'NORMAL',
      assigneeId: emp,
      truckId: t.id,
      dockId: t.dockId,
      forkliftId: f.id,
      shipmentId: s?.id ?? null,
      dueMinutes: Math.max(5, Math.ceil((left * 100) / 60)),
      source: 'SYSTEM',
    });
    return true;
  }

  private async onWorkDone(truckId: string): Promise<boolean> {
    const t = this.world.trucks[truckId];
    const open = await this.repo.openSystemTasks(truckId);
    for (const task of open) {
      const note = `Truck ${t?.direction === 'inbound' ? 'unloaded' : 'loaded'} · ${t?.capacity ?? ''} pallets`;
      if (task.status === 'OPEN') { await this.repo.changeTaskStatus(null, task.id, 'CANCELLED', 'Completed by another crew'); continue; }
      if (task.status === 'ASSIGNED' || task.status === 'BLOCKED') await this.repo.changeTaskStatus(null, task.id, 'IN_PROGRESS', null);
      await this.repo.changeTaskStatus(null, task.id, 'DONE', note);
    }
    return open.length > 0;
  }

  // ---------------------------------------------------------------- live snapshots
  snapshot(facilities: FacilityId[]): string {
    const key = facilities.slice().sort().join(',');
    const v = `${this.versions.world}:${this.db.commits}:${this.db.failures}`;
    const hit = this.snapCache.get(key);
    if (hit && hit.v === v) return hit.json;
    const set = new Set<string>(facilities);
    const w = this.world;
    const pick = <T extends { facilityId: string }>(coll: Record<string, T>) =>
      Object.fromEntries(Object.entries(coll).filter(([, e]) => set.has(e.facilityId)));
    const trucks = pick(w.trucks);
    const shipIds = new Set(Object.values(trucks).map((t) => t.shipmentId));
    const forklifts = Object.fromEntries(Object.entries(pick(w.forklifts)).map(([id, f]) => [id, { ...f, path: [] }]));
    const out = {
      world: {
        version: w.version, simTime: w.simTime, realTime: w.realTime, nextShipment: w.nextShipment, nextPallet: w.nextPallet,
        facilities: Object.fromEntries(Object.entries(w.facilities).filter(([id]) => set.has(id))),
        docks: pick(w.docks), trucks, forklifts, pallets: pick(w.pallets), chargers: pick(w.chargers),
        shipments: Object.fromEntries(Object.entries(w.shipments).filter(([id]) => shipIds.has(id))),
        laneLock: w.laneLock, events: w.events.filter((e) => set.has(e.facilityId)).slice(0, 30), eventSeq: w.eventSeq,
        // the port and the town are shared by every site
        port: w.port, retail: w.retail,
      },
      control: this.control,
      versions: { tasks: this.versions.tasks, audit: this.versions.audit, gate: this.versions.gate },
      db: this.db,
    };
    const json = JSON.stringify(out);
    this.snapCache.set(key, { v, json });
    return json;
  }
}
