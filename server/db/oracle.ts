// Oracle Database implementation of the storage interface (node-oracledb, Thin mode).
// Business rules live in the database: WT_AUTH / WT_WORK packages and triggers.
// Every transaction identifies the acting user via DBMS_SESSION.SET_IDENTIFIER so
// audit triggers can attribute changes.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  WorldState, FacilityId, Truck, TruckPhase, Forklift, ForkliftTask, Pallet, Dock, Shipment, Carrier, Leg, Spot,
} from '../../src/data/types';
import type {
  SessionUser, Task, TaskUpdate, TaskStatus, AuditEntry, Employee, UserRecord, SimControl, KpiRow, WorkloadRow,
  LowStockRow, Role, JobTitle, RoleInfo, Permission, ParkData, BuildingPatch, GateEntry, TradeRow, DbOverview, DbTableDetail,
  SqlResult, SqlActivity, DbConstraint, DbLiveRow, ContainerMoveRow, VesselCallRow, StoreOrderRow,
} from '../../src/api/types';
import type { Vessel, VesselStatus, StoreOrder, StoreOrderStatus, DeliveryVan, VanStatus, QuayCrane, TradeLane } from '../../src/data/types';
import { seedPort, seedRetail, vesselPose } from '../../src/data/city';
import type { ParkCompany, ParkBuilding, ParkVehicle, BuildingKind, BuildingStatus, VehicleKind, RouteCode } from '../../src/data/park';
import { TABLE_GROUPS, checkReadOnlySql } from './schema-meta';
import { WORLD_VERSION } from '../../src/data/seed';
import { legRoadIn, legYardIn, legReverseIn, legYardOut, legRoadOut } from '../../src/sim/paths';
import {
  AppError, type Repo, type PersistBatch, type LoginRow, type SessionRow, type NewTask, type NewUser,
  type UserPatch, type TaskFilter, type AuditFilter, type SqlSource, type NewStoreOrder,
} from './repo';

type Conn = any;
type Row = Record<string, any>;

const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : d ? new Date(String(d)).toISOString() : null);
const yn = (b: boolean) => (b ? 'Y' : 'N');
const round = (n: number, p = 3) => Math.round(n * 10 ** p) / 10 ** p;
const clampSec = (n: number | null) => (n === null ? null : Math.max(0, Math.min(9999999, Math.round(n))));

function placeholders(prefix: string, values: string[]): { sql: string; binds: Record<string, string> } {
  const binds: Record<string, string> = {};
  const names = values.map((v, i) => { binds[`${prefix}${i}`] = v; return `:${prefix}${i}`; });
  return { sql: names.length ? names.join(', ') : 'NULL', binds };
}

export class OracleRepo implements Repo {
  readonly kind = 'oracle' as const;
  private oracledb: any;
  private pool: any;

  constructor(private cfg: { user: string; password: string; connectString: string }) {}

  async init(): Promise<void> {
    try {
      const pkg = 'oracledb'; // loaded at runtime; the driver ships without TypeScript types
      const mod = await import(pkg);
      this.oracledb = (mod as any).default ?? mod;
    } catch {
      throw new Error('The "oracledb" package is not installed. Run `npm install` in the project folder.');
    }
    this.oracledb.outFormat = this.oracledb.OUT_FORMAT_OBJECT;
    this.oracledb.fetchAsString = [this.oracledb.CLOB];
    this.pool = await this.oracledb.createPool({ ...this.cfg, poolMin: 1, poolMax: 8, poolIncrement: 1 });
    // the port and store tables arrived with schema version 6: an older database must be recreated
    const t = await this.q(null, "SELECT COUNT(*) AS n FROM user_tables WHERE table_name IN ('VESSELS', 'STORE_ORDERS', 'CONTAINER_MOVES')");
    const st = Number(t[0]?.N ?? 0) < 3 ? [] : await this.q(null, "SELECT (SELECT COUNT(*) FROM stores WHERE store_id = 'ST-11') + (SELECT COUNT(*) FROM park_vehicles WHERE vehicle_id = 'VEH-478') - 1 AS n FROM dual");
    if (Number(t[0]?.N ?? 0) < 3 || Number(st[0]?.N ?? 0) < 1) {
      throw new Error('The Oracle database was created by an older version of CargoVerse (it is missing the port, the stores or the newest districts). Run `npm run db:reset` once to recreate it, then `npm run dev`.');
    }
    const r = await this.q(null, 'SELECT COUNT(*) AS n FROM facilities');
    if (!r.length || Number(r[0].N) === 0) {
      throw new Error('The CargoVerse schema is empty. Run `npm run db:setup` to create tables and load the seed data.');
    }
    await this.rebrand();
  }

  /**
   * The project was renamed from WareTrack to CargoVerse. Databases created before the rename keep
   * the old brand in a few display texts; update them in place (idempotent, no reset needed).
   * Keys such as company id WARETRACK, carrier name 'WareTrack' and the schema owner are unchanged.
   */
  private async rebrand(): Promise<void> {
    try {
      await this.tx(null, async (c) => {
        await c.execute(`UPDATE park_companies SET name = REPLACE(name, 'WareTrack', 'CargoVerse'),
          contact_email = REPLACE(contact_email, '@waretrack.', '@cargoverse.')
          WHERE name LIKE '%WareTrack%' OR contact_email LIKE '%@waretrack.%'`);
        await c.execute(`UPDATE park_buildings SET description = REPLACE(description, 'WareTrack', 'CargoVerse') WHERE description LIKE '%WareTrack%'`);
        await c.execute(`UPDATE carriers SET display_name = REPLACE(display_name, 'WareTrack', 'CargoVerse') WHERE display_name LIKE '%WareTrack%'`);
        await c.execute(`UPDATE shipping_lines SET name = REPLACE(name, 'WareTrack', 'CargoVerse') WHERE name LIKE '%WareTrack%'`);
        await c.execute(`UPDATE employees SET email = REPLACE(email, '@waretrack.io', '@cargoverse.io') WHERE email LIKE '%@waretrack.io'`);
      }, 'api');
    } catch (e) {
      console.warn(`[cargoverse] could not update old display names: ${(e as Error).message}`);
    }
  }

  async close(): Promise<void> { await this.pool?.close(5); }

  // ---------------------------------------------------------------- plumbing
  /** Recent statements executed by this server (for the Database tab). */
  readonly activity: (SqlActivity & { source: SqlSource })[] = [];
  sqlActivity() { return this.activity.slice(-300).reverse(); }
  private record(source: SqlSource, sql: string, t0: number, rows: number, error?: string): void {
    this.activity.push({ at: new Date().toISOString(), ms: Math.round((performance.now() - t0) * 10) / 10, rows, ok: !error, sql: sql.replace(/\s+/g, ' ').trim().slice(0, 400), error, source });
    if (this.activity.length > 400) this.activity.splice(0, this.activity.length - 400);
  }

  private instrument(c: Conn, source: SqlSource): Conn {
    const exec = c.execute.bind(c);
    return {
      execute: async (sql: string, binds?: unknown, opts?: unknown) => {
        const t0 = performance.now();
        try {
          const r = await exec(sql, binds ?? {}, opts ?? {});
          this.record(source, sql, t0, r.rows?.length ?? r.rowsAffected ?? 0);
          return r;
        } catch (e) {
          this.record(source, sql, t0, 0, String((e as Error).message).split('\n')[0]);
          throw e;
        }
      },
      raw: c,
    };
  }

  private async tx<T>(userId: number | null, fn: (c: Conn) => Promise<T>, source: SqlSource = 'api'): Promise<T> {
    const raw = await this.pool.getConnection();
    const c = this.instrument(raw, source);
    try {
      raw.module = 'cargoverse-api';
      if (userId === null) await c.execute('BEGIN DBMS_SESSION.CLEAR_IDENTIFIER; END;');
      else await c.execute('BEGIN DBMS_SESSION.SET_IDENTIFIER(:id); END;', { id: String(userId) });
      const out = await fn(c);
      await raw.commit();
      return out;
    } catch (e) {
      try { await raw.rollback(); } catch { /* ignore */ }
      throw this.mapError(e);
    } finally {
      await raw.close();
    }
  }

  private async q(userId: number | null, sql: string, binds: Record<string, unknown> = {}): Promise<Row[]> {
    return this.tx(userId, async (c) => (await c.execute(sql, binds)).rows ?? []);
  }

  private mapError(e: any): Error {
    if (e instanceof AppError) return e;
    const num = Number(e?.errorNum);
    const msg = String(e?.message ?? e).replace(/^ORA-\d+:\s*/, '').split('\n')[0];
    switch (num) {
      case 20001: return new AppError(404, msg);
      case 20002: return new AppError(409, msg);
      case 20003: return new AppError(403, msg);
      case 20004: return new AppError(400, msg);
      case 20005: return new AppError(403, msg);
      case 20006: return new AppError(400, msg);
      case 1: return new AppError(409, 'That value is already in use (unique constraint)');
      case 2290: return new AppError(400, `Rejected by a check constraint: ${msg}`);
      case 2291: return new AppError(400, `Referenced record does not exist: ${msg}`);
      default: return e instanceof Error ? e : new Error(String(e));
    }
  }

  // ---------------------------------------------------------------- world
  async loadWorld() {
    return this.tx(null, async (c) => {
      const rows = async (sql: string, b: Record<string, unknown> = {}) => ((await c.execute(sql, b)).rows ?? []) as Row[];
      const w: WorldState = {
        version: WORLD_VERSION, simTime: 0, realTime: 0, nextShipment: 0, nextPallet: 0,
        facilities: {}, docks: {}, trucks: {}, shipments: {}, forklifts: {}, pallets: {}, chargers: {},
        laneLock: { 'WH-01': null, 'WH-02': null, 'WH-04': null }, events: [], eventSeq: 0,
        port: seedPort(), retail: seedRetail(),
      };
      const st = (await rows('SELECT * FROM sim_state WHERE state_id = 1'))[0];
      if (!st) throw new Error('sim_state row missing — run `npm run db:setup`');
      w.simTime = Number(st.SIM_TIME_S);
      w.realTime = Number(st.REAL_TIME_S);
      w.nextShipment = Number(st.NEXT_SHIPMENT);
      w.nextPallet = Number(st.NEXT_PALLET);
      const control: SimControl = { paused: st.PAUSED === 'Y', speed: Number(st.SPEED) };

      const kpi = new Map<string, Row>((await rows('SELECT facility_id, deliveries_30d, on_time_30d FROM v_facility_kpi')).map((r) => [r.FACILITY_ID, r]));
      for (const r of await rows('SELECT * FROM facilities ORDER BY facility_id')) {
        const k = kpi.get(r.FACILITY_ID);
        w.facilities[r.FACILITY_ID] = {
          id: r.FACILITY_ID, name: r.NAME, shortName: r.SHORT_NAME, kindLabel: r.FACILITY_KIND, address: r.ADDRESS,
          capacity: Number(r.CAPACITY_PALLETS), stock: Number(r.STOCK_PALLETS), stockStart: Number(r.STOCK_START_PALLETS),
          outboundToday: Number(r.OUTBOUND_TODAY), putawaysToday: Number(r.PUTAWAYS_TODAY),
          onTime30d: Number(k?.ON_TIME_30D ?? 0), deliveries30d: Number(k?.DELIVERIES_30D ?? 0),
          otdPrevPct: Number(r.OTD_PREV_PCT), trucksOnSiteStart: Number(r.TRUCKS_ON_SITE_START),
          importsToday: Number(r.IMPORTS_TODAY), importPalletsToday: Number(r.IMPORT_PALLETS_TODAY),
          exportsToday: Number(r.EXPORTS_TODAY), exportPalletsToday: Number(r.EXPORT_PALLETS_TODAY), inventory: [],
        };
      }
      for (const r of await rows('SELECT facility_id, sku_id, units, reorder_level FROM inventory ORDER BY facility_id, display_order, sku_id')) {
        w.facilities[r.FACILITY_ID]?.inventory.push({ skuId: r.SKU_ID, units: Number(r.UNITS), lowBelow: Number(r.REORDER_LEVEL) });
      }
      for (const r of await rows('SELECT * FROM docks ORDER BY facility_id, dock_id')) {
        w.docks[r.DOCK_ID] = {
          id: r.DOCK_ID, facilityId: r.FACILITY_ID, name: r.DOCK_NAME, kind: String(r.DOCK_KIND).toLowerCase() as Dock['kind'],
          description: r.DESCRIPTION ?? '', truckId: r.TRUCK_ID ?? null, trucksToday: Number(r.TRUCKS_TODAY),
        };
      }
      for (const r of await rows(`SELECT t.*, c.name AS carrier_name, d.full_name AS driver_name
                                    FROM trucks t JOIN carriers c ON c.carrier_id = t.carrier_id
                                    JOIN drivers d ON d.driver_id = t.driver_id ORDER BY t.truck_id`)) {
        const phase = String(r.STATUS).toLowerCase() as TruckPhase;
        const t: Truck = {
          id: r.TRUCK_ID, facilityId: r.FACILITY_ID, carrier: r.CARRIER_NAME as Carrier, driver: r.DRIVER_NAME, plate: r.PLATE,
          direction: String(r.DIRECTION).toLowerCase() as Truck['direction'], phase, dockId: r.DOCK_ID ?? null,
          shipmentId: r.CURRENT_SHIPMENT_ID, capacity: Number(r.CAPACITY_PALLETS), cargo: Number(r.CARGO_PALLETS), skuId: r.SKU_ID,
          legs: [], legIdx: Number(r.LEG_IDX), legDist: Number(r.LEG_DIST), pos: { x: Number(r.POS_X), z: Number(r.POS_Z) },
          heading: Number(r.HEADING), speed: Number(r.SPEED), awayUntil: w.realTime + Number(r.AWAY_REMAINING_S), forkliftId: r.FORKLIFT_ID ?? null,
          lane: (r.TRADE_LANE ?? 'ROAD') as TradeLane,
        };
        t.legs = rebuildLegs(t);
        w.trucks[t.id] = t;
      }
      const shipIds = Object.values(w.trucks).map((t) => t.shipmentId);
      const ph = placeholders('s', shipIds);
      for (const r of await rows(`SELECT * FROM shipments WHERE shipment_id IN (${ph.sql})`, ph.binds)) {
        const s: Shipment = {
          id: r.SHIPMENT_ID, truckId: r.TRUCK_ID, facilityId: r.FACILITY_ID, direction: String(r.DIRECTION).toLowerCase() as Shipment['direction'],
          customer: r.CUSTOMER, destination: r.DESTINATION, skuId: r.SKU_ID, pallets: Number(r.PALLETS),
          confirmedAt: Number(r.CONFIRMED_S), pickedAt: Number(r.PICKED_S), loadedAt: numOrNull(r.LOADED_S), transitAt: numOrNull(r.TRANSIT_S),
          deliveredAt: numOrNull(r.DELIVERED_S), promisedAt: Number(r.PROMISED_S), transitMinutes: Number(r.TRANSIT_MINUTES),
          onTime: r.ON_TIME === 'Y' ? true : r.ON_TIME === 'N' ? false : null,
          lane: (r.TRADE_LANE ?? 'ROAD') as TradeLane, containerNo: r.CONTAINER_NO ?? null,
        };
        w.shipments[s.id] = s;
      }
      const operators: Record<string, number> = {};
      for (const r of await rows('SELECT * FROM forklifts ORDER BY forklift_id')) {
        const f: Forklift = {
          id: r.FORKLIFT_ID, facilityId: r.FACILITY_ID, operator: '', model: r.MODEL, battery: Number(r.BATTERY_PCT),
          task: String(r.TASK_STATE).toLowerCase() as ForkliftTask, truckId: r.TRUCK_ID ?? null, palletId: r.PALLET_ID ?? null,
          movesToday: Number(r.MOVES_TODAY), chargerId: r.CHARGER_ID, pos: { x: Number(r.POS_X), z: Number(r.POS_Z) },
          heading: Number(r.HEADING), speed: 0, path: [], pathDist: 0, timer: Number(r.TIMER_S),
          pick: r.PICK_JSON ? (JSON.parse(r.PICK_JSON) as Spot) : null, drop: r.DROP_JSON ? (JSON.parse(r.DROP_JSON) as Spot) : null,
        };
        if (r.OPERATOR_ID !== null && r.OPERATOR_ID !== undefined) operators[f.id] = Number(r.OPERATOR_ID);
        w.forklifts[f.id] = f;
      }
      const names = new Map<number, string>((await rows('SELECT employee_id, full_name FROM employees')).map((r) => [Number(r.EMPLOYEE_ID), r.FULL_NAME]));
      for (const f of Object.values(w.forklifts)) f.operator = names.get(operators[f.id]) ?? '—';
      for (const r of await rows('SELECT * FROM pallets')) {
        const p: Pallet = {
          id: r.PALLET_ID, facilityId: r.FACILITY_ID, skuId: r.SKU_ID, qty: Number(r.QTY), weightKg: Number(r.WEIGHT_KG), lot: r.LOT_NO,
          received: r.RECEIVED_LABEL, slot: numOrNull(r.YARD_SLOT), forkliftId: r.FORKLIFT_ID ?? null,
          featured: r.IS_FEATURED === 'Y', reserved: r.IS_RESERVED === 'Y',
        };
        w.pallets[p.id] = p;
      }
      for (const r of await rows('SELECT * FROM chargers')) {
        w.chargers[r.CHARGER_ID] = {
          id: r.CHARGER_ID, facilityId: r.FACILITY_ID, description: r.DESCRIPTION, sessionsToday: Number(r.SESSIONS_TODAY),
          energyKwh: Number(r.ENERGY_KWH), ratePctPerMin: Number(r.RATE_PCT_MIN),
        };
      }
      for (const t of Object.values(w.trucks)) {
        if (t.phase === 'docking' || t.phase === 'departing') w.laneLock[t.facilityId] = t.id;
      }
      const ev = await rows(`SELECT * FROM (SELECT * FROM operation_events ORDER BY event_id DESC) WHERE ROWNUM <= 40`);
      w.events = ev.map((r) => ({
        t: Number(r.SIM_TIME_S), facilityId: r.FACILITY_ID, text: r.MESSAGE,
        ref: r.ENTITY_KIND ? { kind: r.ENTITY_KIND, id: r.ENTITY_ID } : undefined,
      }));
      w.eventSeq = Number((await rows('SELECT NVL(MAX(event_id), 0) AS n FROM operation_events'))[0].N);
      await this.loadPortAndStores(w, st, rows);
      return { world: w, control, operators };
    });
  }

  async persist(b: PersistBatch): Promise<void> {
    await this.tx(null, async (c) => {
      // one execute per row keeps bind types exact for nullable columns (batches are small: a few rows per flush)
      const many = async (sql: string, data: Row[]) => { for (const row of data) await c.execute(sql, row); };

      await many(`INSERT INTO stock_movements (facility_id, sku_id, pallets_delta, units_delta, reason, pallet_id, shipment_id, forklift_id, sim_time_s)
                  VALUES (:fac, :sku, :pallets, :units, :reason, :pallet, :shipment, :forklift, :t)`,
        b.stock.map((s) => ({ fac: s.facilityId, sku: s.skuId, pallets: s.pallets, units: s.units, reason: s.reason,
          pallet: s.palletId ?? null, shipment: s.shipmentId ?? null, forklift: s.forkliftId ?? null, t: clampSec(s.t) })));

      await many(`INSERT INTO operation_events (facility_id, sim_time_s, message, entity_kind, entity_id)
                  VALUES (:fac, :t, :msg, :kind, :id)`,
        b.events.map((e) => ({ fac: e.facilityId, t: clampSec(e.t), msg: e.text.slice(0, 300), kind: e.ref?.kind ?? null, id: e.ref?.id ?? null })));

      await many(`MERGE INTO shipments d
                  USING (SELECT :id AS shipment_id FROM dual) s ON (d.shipment_id = s.shipment_id)
                  WHEN MATCHED THEN UPDATE SET d.loaded_s = :loaded, d.transit_s = :transit, d.delivered_s = :delivered,
                       d.on_time = :onTime, d.promised_s = :promised
                  WHEN NOT MATCHED THEN INSERT (shipment_id, truck_id, facility_id, direction, customer, destination, sku_id, pallets,
                       confirmed_s, picked_s, loaded_s, transit_s, delivered_s, promised_s, transit_minutes, on_time, trade_lane, container_no)
                  VALUES (:id, :truck, :fac, :dir, :customer, :dest, :sku, :pallets, :confirmed, :picked, :loaded, :transit,
                          :delivered, :promised, :transitMin, :onTime, :lane, :box)`,
        b.shipments.map((s) => ({
          id: s.id, truck: s.truckId, fac: s.facilityId, dir: s.direction.toUpperCase(), customer: s.customer, dest: s.destination,
          sku: s.skuId, pallets: s.pallets, confirmed: clampSec(s.confirmedAt), picked: clampSec(s.pickedAt), loaded: clampSec(s.loadedAt),
          transit: clampSec(s.transitAt), delivered: clampSec(s.deliveredAt), promised: clampSec(s.promisedAt), transitMin: s.transitMinutes,
          onTime: s.onTime === null ? null : yn(s.onTime), lane: s.lane ?? 'ROAD', box: s.containerNo ?? null,
        })));

      // imports / exports through the park gates (trg_gate_log_ai updates the facility counters)
      await many(`INSERT INTO park_gate_log (gate_code, direction, trade_type, truck_id, facility_id, shipment_id, sku_id, pallets, sim_time_s)
                  VALUES (:gate, :dir, :trade, :truck, :fac, :ship, :sku, :pallets, :t)`,
        b.gate.map((g) => ({ gate: g.gate, dir: g.direction, trade: g.trade, truck: g.truckId, fac: g.facilityId, ship: g.shipmentId,
          sku: g.trade === 'EMPTY' ? null : g.skuId, pallets: g.trade === 'EMPTY' ? 0 : g.pallets, t: clampSec(g.t) })));

      await many(`UPDATE trucks SET status = :status, dock_id = :dock, cargo_pallets = :cargo, current_shipment_id = :ship, sku_id = :sku,
                         forklift_id = :fl, leg_idx = :legIdx, leg_dist = :legDist, pos_x = :x, pos_z = :z, heading = :h, speed = :v,
                         away_remaining_s = :away, trade_lane = :lane, updated_at = SYSTIMESTAMP
                   WHERE truck_id = :id`,
        b.trucks.map((t) => ({
          id: t.id, status: t.phase.toUpperCase(), dock: t.dockId, cargo: t.cargo, ship: t.shipmentId, sku: t.skuId, fl: t.forkliftId,
          legIdx: t.legIdx, legDist: round(t.legDist), x: round(t.pos.x), z: round(t.pos.z), h: round(t.heading, 5), v: round(t.speed),
          away: round(Math.max(0, t.awayUntil - b.world.realTime), 2), lane: t.lane ?? 'ROAD',
        })));

      await many('UPDATE docks SET truck_id = :truck, trucks_today = :today WHERE dock_id = :id',
        b.docks.map((d) => ({ id: d.id, truck: d.truckId, today: d.trucksToday })));

      // clear slots first so pallets can swap slots inside one batch without tripping the unique index
      await many('UPDATE pallets SET yard_slot = NULL, forklift_id = NULL WHERE pallet_id = :id', b.pallets.map((p) => ({ id: p.id })));
      await many('DELETE FROM pallets WHERE pallet_id = :id', b.deletedPallets.map((id) => ({ id })));
      await many(`MERGE INTO pallets d
                  USING (SELECT :id AS pallet_id FROM dual) s ON (d.pallet_id = s.pallet_id)
                  WHEN MATCHED THEN UPDATE SET d.yard_slot = :slot, d.forklift_id = :fl, d.is_reserved = :res, d.received_label = :recv
                  WHEN NOT MATCHED THEN INSERT (pallet_id, facility_id, sku_id, qty, weight_kg, lot_no, received_label, yard_slot, forklift_id, is_featured, is_reserved)
                  VALUES (:id, :fac, :sku, :qty, :kg, :lot, :recv, :slot, :fl, :feat, :res)`,
        b.pallets.map((p) => ({
          id: p.id, fac: p.facilityId, sku: p.skuId, qty: p.qty, kg: p.weightKg, lot: p.lot, recv: p.received.slice(0, 40),
          slot: p.slot, fl: p.forkliftId, feat: yn(p.featured), res: yn(p.reserved),
        })));

      await many(`UPDATE forklifts SET battery_pct = :b, task_state = :task, truck_id = :truck, pallet_id = :pallet, moves_today = :moves,
                         pos_x = :x, pos_z = :z, heading = :h, timer_s = :timer, pick_json = :pickJson, drop_json = :dropJson, updated_at = SYSTIMESTAMP
                   WHERE forklift_id = :id`,
        b.forklifts.map((f) => ({
          id: f.id, b: Math.max(0, Math.min(100, round(f.battery, 2))), task: f.task.toUpperCase(), truck: f.truckId, pallet: f.palletId,
          moves: f.movesToday, x: round(f.pos.x), z: round(f.pos.z), h: round(f.heading, 5), timer: round(Math.max(0, f.timer)),
          pickJson: f.pick ? JSON.stringify(f.pick) : null, dropJson: f.drop ? JSON.stringify(f.drop) : null,
        })));

      await many('UPDATE chargers SET sessions_today = :s, energy_kwh = :e WHERE charger_id = :id',
        b.chargers.map((ch) => ({ id: ch.id, s: ch.sessionsToday, e: round(ch.energyKwh, 2) })));

      await many('UPDATE facilities SET outbound_today = :o, putaways_today = :p WHERE facility_id = :id',
        b.facilities.map((f) => ({ id: f.id, o: f.outboundToday, p: f.putawaysToday })));

      await this.persistPortAndStores(b, many);

      const P = b.world.port;
      await c.execute(`UPDATE sim_state SET sim_time_s = :t, real_time_s = :r, next_shipment = :ns, next_pallet = :np,
                              next_box = :nb, next_order = :no, port_moves_today = :pm, port_calls_today = :pc,
                              port_gate_in_today = :pgi, port_gate_out_today = :pgo, port_ext_timer_s = :pet, updated_at = SYSTIMESTAMP
                        WHERE state_id = 1`,
        { t: round(b.world.simTime), r: round(b.world.realTime), ns: b.world.nextShipment, np: b.world.nextPallet,
          nb: P.nextBox, no: b.world.retail.nextOrder, pm: P.movesToday, pc: P.callsToday, pgi: P.gateInToday, pgo: P.gateOutToday,
          pet: round(P.extTimer, 2) });
    }, 'sim');
  }

  async saveControl(control: SimControl, userId: number | null): Promise<void> {
    await this.tx(userId, (c) => c.execute(
      'UPDATE sim_state SET paused = :p, speed = :s, updated_by = :u, updated_at = SYSTIMESTAMP WHERE state_id = 1',
      { p: yn(control.paused), s: control.speed, u: userId }));
  }

  // ---------------------------------------------------------------- auth
  async findLogin(username: string): Promise<LoginRow | null> {
    const r = (await this.q(null, 'SELECT user_id, username, password_hash, is_active FROM app_users WHERE username = :u', { u: username.toLowerCase() }))[0];
    return r ? { userId: Number(r.USER_ID), username: r.USERNAME, passwordHash: r.PASSWORD_HASH, active: r.IS_ACTIVE === 'Y' } : null;
  }

  async recordLogin(userId: number | null, username: string, success: boolean): Promise<void> {
    await this.tx(userId, (c) => c.execute('BEGIN wt_auth.record_login(:id, :ok, :u); END;', { id: userId, ok: yn(success), u: username }));
  }

  async createSession(sessionId: string, userId: number, days: number, agent: string): Promise<void> {
    await this.tx(userId, (c) => c.execute('BEGIN wt_auth.create_session(:s, :u, :d, :a); END;', { s: sessionId, u: userId, d: days, a: agent }));
  }

  async getSession(sessionId: string): Promise<SessionRow | null> {
    const r = (await this.q(null, 'SELECT user_id, expires_at, revoked, remember_me FROM user_sessions WHERE session_id = :s', { s: sessionId }))[0];
    return r ? { userId: Number(r.USER_ID), expiresAt: new Date(r.EXPIRES_AT), revoked: r.REVOKED === 'Y', remember: r.REMEMBER_ME === 'Y' } : null;
  }

  async extendSession(sessionId: string, days: number): Promise<void> {
    await this.q(null, `UPDATE user_sessions SET last_seen_at = SYSTIMESTAMP, expires_at = SYSTIMESTAMP + NUMTODSINTERVAL(:d, 'DAY')
                         WHERE session_id = :s AND revoked = 'N'`, { s: sessionId, d: days });
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.tx(null, (c) => c.execute('BEGIN wt_auth.revoke_session(:s); END;', { s: sessionId }));
  }

  async sessionUser(userId: number): Promise<SessionUser | null> {
    const r = (await this.q(null, `SELECT * FROM v_user_directory WHERE user_id = :u AND is_active = 'Y'`, { u: userId }))[0];
    if (!r) return null;
    const perms = (await this.q(null, 'SELECT perm_code FROM role_permissions WHERE role_code = :r', { r: r.ROLE_CODE })).map((p) => p.PERM_CODE as Permission);
    const facilities = perms.includes('VIEW_ALL_FACILITIES')
      ? (await this.q(null, 'SELECT facility_id FROM facilities ORDER BY facility_id')).map((f) => f.FACILITY_ID as FacilityId)
      : String(r.FACILITIES ?? '').split(',').filter(Boolean) as FacilityId[];
    return {
      userId: Number(r.USER_ID), username: r.USERNAME, fullName: r.FULL_NAME, email: r.EMAIL, role: r.ROLE_CODE as Role, roleName: r.ROLE_NAME,
      jobCode: r.JOB_CODE, jobTitle: r.JOB_TITLE, employeeId: Number(r.EMPLOYEE_ID), homeFacility: r.HOME_FACILITY ?? null,
      facilities, permissions: perms, forkliftId: r.FORKLIFT_ID ?? null,
    };
  }

  // ---------------------------------------------------------------- people
  async listUsers(): Promise<UserRecord[]> {
    return (await this.q(null, 'SELECT * FROM v_user_directory ORDER BY user_id')).map((r) => ({
      id: Number(r.USER_ID), username: r.USERNAME, role: r.ROLE_CODE, active: r.IS_ACTIVE === 'Y', employeeId: Number(r.EMPLOYEE_ID),
      fullName: r.FULL_NAME, email: r.EMAIL, jobCode: r.JOB_CODE, jobTitle: r.JOB_TITLE,
      facilities: String(r.FACILITIES ?? '').split(',').filter(Boolean) as FacilityId[],
      lastLoginAt: iso(r.LAST_LOGIN_AT), createdAt: iso(r.CREATED_AT) ?? '',
    }));
  }

  async createUser(adminId: number, u: NewUser): Promise<number> {
    return this.tx(adminId, async (c) => {
      const r = await c.execute(
        `BEGIN wt_auth.create_user(:admin, :username, :hash, :role, :name, :email, :phone, :job, :home, :facs, :id); END;`,
        {
          admin: adminId, username: u.username, hash: u.passwordHash, role: u.role, name: u.fullName, email: u.email, phone: u.phone,
          job: u.jobCode, home: u.homeFacility, facs: u.facilities.join(',') || u.homeFacility || '-',
          id: { dir: this.oracledb.BIND_OUT, type: this.oracledb.NUMBER },
        });
      return Number(r.outBinds.id);
    });
  }

  async updateUser(adminId: number, userId: number, p: UserPatch): Promise<void> {
    await this.tx(adminId, (c) => c.execute('BEGIN wt_auth.update_user(:admin, :id, :role, :active, :facs, :hash); END;', {
      admin: adminId, id: userId, role: p.role ?? null, active: p.active === undefined ? null : yn(p.active),
      facs: p.facilities === undefined ? null : p.facilities.join(',') || '-', hash: p.passwordHash ?? null,
    }));
  }

  async listEmployees(facilities: FacilityId[] | null): Promise<Employee[]> {
    const ph = placeholders('f', facilities ?? []);
    const where = facilities === null ? '' : `WHERE e.facility_id IN (${ph.sql})`;
    const rows = await this.q(null, `
      SELECT e.employee_id, e.full_name, e.email, e.phone, e.job_code, j.title AS job_title, e.facility_id, e.emp_status,
             u.user_id, u.username, u.role_code,
             (SELECT MIN(fl.forklift_id) FROM forklifts fl WHERE fl.operator_id = e.employee_id) AS forklift_id,
             (SELECT COUNT(*) FROM tasks k WHERE k.assigned_to = e.employee_id AND k.task_status IN ('OPEN','ASSIGNED','IN_PROGRESS','BLOCKED')) AS open_tasks
        FROM employees e
        JOIN job_titles j ON j.job_code = e.job_code
        LEFT JOIN app_users u ON u.employee_id = e.employee_id
        ${where}
       ORDER BY e.facility_id NULLS FIRST, j.title, e.full_name`, ph.binds);
    return rows.map((r) => ({
      id: Number(r.EMPLOYEE_ID), fullName: r.FULL_NAME, email: r.EMAIL, phone: r.PHONE ?? null, jobCode: r.JOB_CODE, jobTitle: r.JOB_TITLE,
      facilityId: r.FACILITY_ID ?? null, status: r.EMP_STATUS, userId: r.USER_ID === null ? null : Number(r.USER_ID),
      username: r.USERNAME ?? null, role: r.ROLE_CODE ?? null, forkliftId: r.FORKLIFT_ID ?? null, openTasks: Number(r.OPEN_TASKS),
    }));
  }

  async listJobTitles(): Promise<JobTitle[]> {
    return (await this.q(null, 'SELECT * FROM job_titles ORDER BY title')).map((r) => ({ code: r.JOB_CODE, title: r.TITLE, responsibilities: r.RESPONSIBILITIES ?? '' }));
  }

  async listRoles(): Promise<RoleInfo[]> {
    const roles = await this.q(null, 'SELECT * FROM roles ORDER BY CASE role_code WHEN \'ADMIN\' THEN 1 WHEN \'MANAGER\' THEN 2 ELSE 3 END');
    const perms = await this.q(null, 'SELECT role_code, perm_code FROM role_permissions');
    return roles.map((r) => ({
      code: r.ROLE_CODE, name: r.ROLE_NAME, description: r.DESCRIPTION ?? '',
      permissions: perms.filter((p) => p.ROLE_CODE === r.ROLE_CODE).map((p) => p.PERM_CODE as Permission),
    }));
  }

  // ---------------------------------------------------------------- tasks
  private toTask(r: Row): Task {
    return {
      id: Number(r.TASK_ID), facilityId: r.FACILITY_ID, title: r.TITLE, description: r.DESCRIPTION ?? '', type: r.TASK_TYPE, priority: r.PRIORITY,
      status: r.TASK_STATUS, source: r.SOURCE, assigneeId: r.ASSIGNED_TO === null ? null : Number(r.ASSIGNED_TO), assigneeName: r.ASSIGNEE_NAME ?? null,
      createdById: r.CREATED_BY === null ? null : Number(r.CREATED_BY), createdByName: r.CREATED_BY_NAME, truckId: r.TRUCK_ID ?? null,
      dockId: r.DOCK_ID ?? null, forkliftId: r.FORKLIFT_ID ?? null, dueAt: iso(r.DUE_AT), createdAt: iso(r.CREATED_AT) ?? '',
      startedAt: iso(r.STARTED_AT), completedAt: iso(r.COMPLETED_AT), lastNote: r.LAST_NOTE ?? null,
    };
  }

  async listTasks(f: TaskFilter): Promise<Task[]> {
    const ph = placeholders('f', f.facilities);
    const binds: Record<string, unknown> = { ...ph.binds, lim: f.limit ?? 200 };
    let where = `facility_id IN (${ph.sql})`;
    if (f.assigneeId !== undefined) { where += ' AND assigned_to = :a'; binds.a = f.assigneeId; }
    if (!f.includeClosed) where += ` AND task_status IN ('OPEN','ASSIGNED','IN_PROGRESS','BLOCKED')`;
    const rows = await this.q(null, `SELECT * FROM v_task_board WHERE ${where} ORDER BY task_id DESC FETCH FIRST :lim ROWS ONLY`, binds);
    return rows.map((r) => this.toTask(r));
  }

  async getTask(id: number): Promise<Task | null> {
    const r = (await this.q(null, 'SELECT * FROM v_task_board WHERE task_id = :id', { id }))[0];
    return r ? this.toTask(r) : null;
  }

  async createTask(userId: number | null, t: NewTask): Promise<number> {
    return this.tx(userId, async (c) => {
      const r = await c.execute(
        `BEGIN wt_work.create_task(:u, :fac, :title, :descr, :type, :prio, :assignee, :truck, :dock, :fl, :ship, :due, :src, :id); END;`,
        {
          u: userId, fac: t.facilityId, title: t.title, descr: t.description, type: t.type, prio: t.priority, assignee: t.assigneeId,
          truck: t.truckId ?? null, dock: t.dockId ?? null, fl: t.forkliftId ?? null, ship: t.shipmentId ?? null, due: t.dueMinutes ?? null,
          src: t.source, id: { dir: this.oracledb.BIND_OUT, type: this.oracledb.NUMBER },
        });
      return Number(r.outBinds.id);
    });
  }

  async changeTaskStatus(userId: number | null, taskId: number, status: TaskStatus, note: string | null): Promise<void> {
    await this.tx(userId, (c) => c.execute('BEGIN wt_work.change_status(:u, :id, :s, :n); END;', { u: userId, id: taskId, s: status, n: note }));
  }

  async assignTask(userId: number | null, taskId: number, assigneeId: number, note: string | null): Promise<void> {
    await this.tx(userId, (c) => c.execute('BEGIN wt_work.assign(:u, :id, :a, :n); END;', { u: userId, id: taskId, a: assigneeId, n: note }));
  }

  async taskUpdates(taskId: number): Promise<TaskUpdate[]> {
    const rows = await this.q(null, `
      SELECT tu.*, NVL(e.full_name, 'System') AS user_name
        FROM task_updates tu
        LEFT JOIN app_users u ON u.user_id = tu.user_id
        LEFT JOIN employees e ON e.employee_id = u.employee_id
       WHERE tu.task_id = :id ORDER BY tu.update_id`, { id: taskId });
    return rows.map((r) => ({
      id: Number(r.UPDATE_ID), taskId: Number(r.TASK_ID), userId: r.USER_ID === null ? null : Number(r.USER_ID), userName: r.USER_NAME,
      oldStatus: r.OLD_STATUS ?? null, newStatus: r.NEW_STATUS, note: r.NOTE ?? null, createdAt: iso(r.CREATED_AT) ?? '',
    }));
  }

  async openSystemTasks(truckId: string): Promise<Task[]> {
    const rows = await this.q(null, `SELECT * FROM v_task_board WHERE source = 'SYSTEM' AND truck_id = :t
                                       AND task_status IN ('OPEN','ASSIGNED','IN_PROGRESS','BLOCKED')`, { t: truckId });
    return rows.map((r) => this.toTask(r));
  }

  // ---------------------------------------------------------------- history & reports
  async listAudit(f: AuditFilter): Promise<AuditEntry[]> {
    const binds: Record<string, unknown> = { lim: f.limit };
    let where = '1 = 1';
    if (f.beforeId) { where += ' AND a.audit_id < :before'; binds.before = f.beforeId; }
    if (f.facilities !== null) {
      const ph = placeholders('f', f.facilities);
      Object.assign(binds, ph.binds);
      where += ` AND (a.facility_id IN (${ph.sql})
                 OR (a.facility_id IS NULL AND EXISTS (SELECT 1 FROM app_users u JOIN employees e ON e.employee_id = u.employee_id
                                                        WHERE u.user_id = a.user_id AND e.facility_id IN (${ph.sql}))))`;
    }
    const rows = await this.q(null, `SELECT * FROM v_audit_feed a WHERE ${where} ORDER BY a.audit_id DESC FETCH FIRST :lim ROWS ONLY`, binds);
    return rows.map((r) => ({
      id: Number(r.AUDIT_ID), at: iso(r.CREATED_AT) ?? '', userId: r.USER_ID === null ? null : Number(r.USER_ID), username: r.USERNAME ?? null,
      action: r.ACTION, entity: r.ENTITY, entityId: r.ENTITY_ID ?? null, facilityId: r.FACILITY_ID ?? null, details: r.DETAILS ?? null,
    }));
  }

  async latestAuditId(): Promise<number> {
    return Number((await this.q(null, 'SELECT NVL(MAX(audit_id), 0) AS n FROM audit_log'))[0].N);
  }

  async kpis(facilities: FacilityId[]): Promise<KpiRow[]> {
    const ph = placeholders('f', facilities);
    return (await this.q(null, `SELECT * FROM v_facility_kpi WHERE facility_id IN (${ph.sql}) ORDER BY facility_id`, ph.binds)).map((r) => ({
      facilityId: r.FACILITY_ID, name: r.NAME, stock: Number(r.STOCK_PALLETS), capacity: Number(r.CAPACITY_PALLETS), fillPct: Number(r.FILL_PCT),
      trucksOnSite: Number(r.TRUCKS_ON_SITE), inbound: Number(r.TRUCKS_INBOUND), otdPct: Number(r.OTD_PCT), deliveries30d: Number(r.DELIVERIES_30D),
      openTasks: Number(r.OPEN_TASKS), lowStockLines: Number(r.LOW_STOCK_LINES),
    }));
  }

  async workload(facilities: FacilityId[]): Promise<WorkloadRow[]> {
    const ph = placeholders('f', facilities);
    return (await this.q(null, `SELECT * FROM v_employee_workload WHERE facility_id IN (${ph.sql}) ORDER BY facility_id, full_name`, ph.binds)).map((r) => ({
      employeeId: Number(r.EMPLOYEE_ID), fullName: r.FULL_NAME, jobTitle: r.JOB_TITLE, facilityId: r.FACILITY_ID ?? null,
      open: Number(r.OPEN_TASKS), inProgress: Number(r.IN_PROGRESS), doneToday: Number(r.DONE_TODAY),
    }));
  }

  async lowStock(facilities: FacilityId[]): Promise<LowStockRow[]> {
    const ph = placeholders('f', facilities);
    return (await this.q(null, `SELECT * FROM v_low_stock WHERE facility_id IN (${ph.sql}) ORDER BY shortfall DESC`, ph.binds)).map((r) => ({
      facilityId: r.FACILITY_ID, skuId: r.SKU_ID, skuName: r.SKU_NAME, units: Number(r.UNITS), reorderLevel: Number(r.REORDER_LEVEL),
    }));
  }

  // ---------------------------------------------------------------- logistics park
  async park(): Promise<ParkData> {
    return this.tx(null, async (c) => {
      const rows = async (sql: string) => ((await c.execute(sql)).rows ?? []) as Row[];
      const companies: ParkCompany[] = (await rows('SELECT * FROM park_companies ORDER BY is_operator DESC, name')).map((r) => ({
        id: r.COMPANY_ID, name: r.NAME, industry: r.INDUSTRY, contactName: r.CONTACT_NAME ?? '', email: r.CONTACT_EMAIL ?? '', phone: r.PHONE ?? '',
        color: r.BRAND_COLOR, isOperator: r.IS_OPERATOR === 'Y',
      }));
      const buildings: ParkBuilding[] = (await rows('SELECT * FROM park_buildings ORDER BY building_id')).map((r) => ({
        id: r.BUILDING_ID, companyId: r.COMPANY_ID, facilityId: r.FACILITY_ID ?? null, name: r.NAME, kind: r.BUILDING_KIND as BuildingKind,
        street: r.STREET, x: Number(r.POS_X), z: Number(r.POS_Z), w: Number(r.WIDTH_M), d: Number(r.DEPTH_M), h: Number(r.HEIGHT_M),
        rotation: Number(r.ROTATION_DEG) as ParkBuilding['rotation'], floors: Number(r.FLOORS), staff: Number(r.STAFF_COUNT),
        status: r.BLDG_STATUS as BuildingStatus, leaseStart: dateOnly(r.LEASE_START), leaseEnd: dateOnly(r.LEASE_END), description: r.DESCRIPTION ?? '',
      }));
      const vehicles: ParkVehicle[] = (await rows(`SELECT * FROM park_vehicles WHERE is_active = 'Y' ORDER BY vehicle_id`)).map((r) => ({
        id: r.VEHICLE_ID, companyId: r.COMPANY_ID ?? null, kind: r.VEHICLE_KIND as VehicleKind, plate: r.PLATE, color: r.COLOR_HEX,
        route: r.ROUTE_CODE as RouteCode, speedKmh: Number(r.SPEED_KMH), offset: Number(r.ROUTE_OFFSET),
      }));
      return { companies, buildings, vehicles };
    });
  }

  async updateBuilding(userId: number, buildingId: string, p: BuildingPatch): Promise<void> {
    await this.tx(userId, (c) => c.execute(
      `BEGIN wt_park.update_building(:u, :id, :status, :staff, TO_DATE(:lease, 'YYYY-MM-DD')); END;`,
      { u: userId, id: buildingId, status: p.status ?? null, staff: p.staff ?? null, lease: p.leaseEnd ?? null }));
  }

  async gateLog(facilities: FacilityId[], limit: number): Promise<GateEntry[]> {
    const ph = placeholders('f', facilities);
    const rows = await this.q(null, `SELECT * FROM v_gate_log WHERE facility_id IN (${ph.sql}) ORDER BY gate_event_id DESC FETCH FIRST :lim ROWS ONLY`,
      { ...ph.binds, lim: limit });
    return rows.map((r) => ({
      id: Number(r.GATE_EVENT_ID), at: iso(r.CREATED_AT) ?? '', simTime: Number(r.SIM_TIME_S), gate: r.GATE_CODE, direction: r.DIRECTION,
      trade: r.TRADE_TYPE, truckId: r.TRUCK_ID, carrier: r.CARRIER, facilityId: r.FACILITY_ID, shipmentId: r.SHIPMENT_ID ?? null,
      skuId: r.SKU_ID ?? null, skuName: r.SKU_NAME ?? null, pallets: Number(r.PALLETS),
    }));
  }

  async trade(facilities: FacilityId[]): Promise<TradeRow[]> {
    const ph = placeholders('f', facilities);
    return (await this.q(null, `SELECT * FROM v_trade_today WHERE facility_id IN (${ph.sql}) ORDER BY facility_id`, ph.binds)).map((r) => ({
      facilityId: r.FACILITY_ID, name: r.NAME, importTrucks: Number(r.IMPORTS_TODAY), importPallets: Number(r.IMPORT_PALLETS_TODAY),
      exportTrucks: Number(r.EXPORTS_TODAY), exportPallets: Number(r.EXPORT_PALLETS_TODAY), emptyMoves: Number(r.EMPTY_MOVES_TODAY),
    }));
  }

  // ---------------------------------------------------------------- database workspace
  async dbOverview(): Promise<DbOverview> {
    return this.tx(null, async (c) => {
      const rows = async (sql: string) => ((await c.execute(sql)).rows ?? []) as Row[];
      let engine = 'Oracle Database';
      for (const sql of [`SELECT banner_full AS v FROM v$version WHERE ROWNUM = 1`, `SELECT product || ' ' || version_full AS v FROM product_component_version WHERE ROWNUM = 1`,
        `SELECT product || ' ' || version AS v FROM product_component_version WHERE ROWNUM = 1`]) {
        try { const r = await rows(sql); if (r[0]?.V) { engine = String(r[0].V).split('\n')[0]; break; } } catch { /* try the next one */ }
      }
      const schema = String((await rows('SELECT USER AS u FROM dual'))[0].U);
      const tabs = await rows(`SELECT t.table_name, NVL(c.comments, ' ') AS comments FROM user_tables t
                                 LEFT JOIN user_tab_comments c ON c.table_name = t.table_name ORDER BY t.table_name`);
      const safe = tabs.map((t) => String(t.TABLE_NAME)).filter((n) => /^[A-Z][A-Z0-9_$#]*$/.test(n));
      const counts = new Map<string, number>();
      if (safe.length) {
        const r = await rows(safe.map((n) => `SELECT '${n}' AS t, COUNT(*) AS n FROM "${n}"`).join(' UNION ALL '));
        for (const x of r) counts.set(String(x.T), Number(x.N));
      }
      const objects = await rows(`SELECT object_name, object_type, status FROM user_objects
                                   WHERE object_type IN ('PACKAGE', 'PACKAGE BODY', 'TRIGGER', 'VIEW') ORDER BY object_type, object_name`);
      return {
        mode: 'oracle', engine, schema,
        tables: tabs.map((t) => ({ name: t.TABLE_NAME, rows: counts.get(t.TABLE_NAME) ?? 0, group: TABLE_GROUPS[t.TABLE_NAME] ?? 'Other', comment: String(t.COMMENTS).trim() })),
        objects: objects.map((o) => ({ name: o.OBJECT_NAME, type: o.OBJECT_TYPE, status: o.STATUS })),
      };
    });
  }

  async dbTable(name: string): Promise<DbTableDetail> {
    const table = name.toUpperCase();
    return this.tx(null, async (c) => {
      const rows = async (sql: string, b: Record<string, unknown> = {}) => ((await c.execute(sql, b)).rows ?? []) as Row[];
      if (!(await rows('SELECT 1 FROM user_tables WHERE table_name = :t', { t: table })).length) throw new AppError(404, `Table ${table} not found`);
      const cols = await rows(`SELECT c.column_name, c.data_type, c.data_length, c.data_precision, c.data_scale, c.nullable, c.data_default,
                                      c.virtual_column, c.identity_column, m.comments
                                 FROM user_tab_cols c
                                 LEFT JOIN user_col_comments m ON m.table_name = c.table_name AND m.column_name = c.column_name
                                WHERE c.table_name = :t AND c.hidden_column = 'NO' ORDER BY c.column_id`, { t: table });
      const typeOf = (r: Row) => {
        const t = String(r.DATA_TYPE);
        if (t === 'NUMBER') return r.DATA_PRECISION === null ? 'NUMBER' : `NUMBER(${r.DATA_PRECISION}${r.DATA_SCALE ? `,${r.DATA_SCALE}` : ''})`;
        if (/CHAR/.test(t)) return `${t}(${r.DATA_LENGTH})`;
        return t;
      };
      const cons = await rows(`SELECT c.constraint_name, c.constraint_type, c.search_condition_vc, c.deferrable, c.delete_rule,
                                      (SELECT LISTAGG(cc.column_name, ',') WITHIN GROUP (ORDER BY cc.position) FROM user_cons_columns cc
                                        WHERE cc.constraint_name = c.constraint_name) AS cols,
                                      r.table_name AS r_table,
                                      (SELECT LISTAGG(rc.column_name, ',') WITHIN GROUP (ORDER BY rc.position) FROM user_cons_columns rc
                                        WHERE rc.constraint_name = c.r_constraint_name) AS r_cols
                                 FROM user_constraints c
                                 LEFT JOIN user_constraints r ON r.constraint_name = c.r_constraint_name
                                WHERE c.table_name = :t AND c.constraint_type IN ('P', 'R', 'U', 'C') ORDER BY c.constraint_type, c.constraint_name`, { t: table });
      const KIND: Record<string, DbConstraint['type']> = { P: 'PRIMARY KEY', R: 'FOREIGN KEY', U: 'UNIQUE', C: 'CHECK' };
      const constraints: DbConstraint[] = cons
        .filter((r) => !(r.CONSTRAINT_TYPE === 'C' && /^"?\w+"? IS NOT NULL$/i.test(String(r.SEARCH_CONDITION_VC ?? ''))))
        .map((r) => ({
          name: r.CONSTRAINT_NAME, type: KIND[r.CONSTRAINT_TYPE], columns: r.COLS ?? '',
          detail: r.CONSTRAINT_TYPE === 'C' ? `(${r.SEARCH_CONDITION_VC})`
            : r.CONSTRAINT_TYPE === 'R' ? `→ ${r.R_TABLE} (${r.R_COLS})${r.DELETE_RULE === 'CASCADE' ? ' ON DELETE CASCADE' : ''}${r.DEFERRABLE === 'DEFERRABLE' ? ' DEFERRABLE' : ''}` : '',
        }));
      const idx = await rows(`SELECT i.index_name, i.uniqueness,
                                     (SELECT LISTAGG(NVL2(e.column_expression, 'expr', ic.column_name), ',') WITHIN GROUP (ORDER BY ic.column_position)
                                        FROM user_ind_columns ic
                                        LEFT JOIN user_ind_expressions e ON e.index_name = ic.index_name AND e.column_position = ic.column_position
                                       WHERE ic.index_name = i.index_name) AS cols
                                FROM user_indexes i WHERE i.table_name = :t ORDER BY i.index_name`, { t: table });
      const sample = await c.execute(`SELECT * FROM "${table}" FETCH FIRST 25 ROWS ONLY`, {}, { outFormat: this.oracledb.OUT_FORMAT_ARRAY });
      return {
        name: table,
        columns: cols.map((r) => ({
          name: r.COLUMN_NAME,
          type: typeOf(r) + (r.VIRTUAL_COLUMN === 'YES' ? ' (virtual)' : r.IDENTITY_COLUMN === 'YES' ? ' (identity)' : ''),
          nullable: r.NULLABLE === 'Y', defaultValue: r.DATA_DEFAULT === null || r.DATA_DEFAULT === undefined ? null : String(r.DATA_DEFAULT).trim(),
          comment: r.COMMENTS ?? null,
        })),
        constraints,
        indexes: idx.map((r) => ({ name: r.INDEX_NAME, columns: r.COLS ?? '', unique: r.UNIQUENESS === 'UNIQUE' })),
        sample: { columns: (sample.metaData ?? []).map((m: any) => m.name), rows: (sample.rows ?? []).map((row: unknown[]) => row.map(cell)) },
      };
    });
  }

  async runSql(userId: number, input: string): Promise<SqlResult> {
    let sql: string;
    try { sql = checkReadOnlySql(input); } catch (e) { throw new AppError(400, (e as Error).message); }
    const raw = await this.pool.getConnection();
    const c = this.instrument(raw, 'api');
    const t0 = performance.now();
    let result: SqlResult;
    try {
      raw.callTimeout = 15000; // ms; long-running queries are cancelled
      await c.execute('SET TRANSACTION READ ONLY'); // Oracle itself rejects any change made by this statement
      const r = await c.execute(sql, {}, { outFormat: this.oracledb.OUT_FORMAT_ARRAY, maxRows: 501 });
      const rows = (r.rows ?? []) as unknown[][];
      result = {
        columns: (r.metaData ?? []).map((m: any) => m.name), rows: rows.slice(0, 500).map((row) => row.map(cell)),
        rowCount: Math.min(rows.length, 500), truncated: rows.length > 500, ms: Math.round(performance.now() - t0), statement: sql,
      };
    } catch (e) {
      throw new AppError(400, String((e as Error).message).split('\n')[0]);
    } finally {
      try { await raw.rollback(); } catch { /* ignore */ }
      raw.callTimeout = 0;
      await raw.close();
    }
    // record who ran what in the audit trail (separate transaction: the query itself was read-only)
    await this.tx(userId, (cc) => cc.execute(`BEGIN wt_core.log_audit('SQL_QUERY', 'DATABASE', NULL, NULL, :d); END;`,
      { d: `${result.rowCount} rows · ${sql.replace(/\s+/g, ' ').slice(0, 1800)}` }));
    return result;
  }

  // ---------------------------------------------------------------- container port and vendor stores
  private async persistPortAndStores(b: PersistBatch, many: (sql: string, data: Row[]) => Promise<void>): Promise<void> {
    // ledger first: trg_container_moves_ai stacks / unstacks the boxes in YARD_CONTAINERS
    await many(`INSERT INTO container_moves (container_no, move_type, vessel_id, berth_code, crane_id, truck_id, facility_id, sim_time_s)
                VALUES (:no, :move, :vessel, :berth, :crane, :truck, :fac, :t)`,
      b.box.map((m) => ({ no: m.containerNo, move: m.move, vessel: m.vesselId, berth: m.berthId, crane: m.craneId, truck: m.truckId, fac: m.facilityId, t: clampSec(m.t) })));
    await many(`BEGIN wt_port.log_call(:vessel, :voyage, :berth, :phase, :disc, :loaded, :t); END;`,
      b.calls.map((k) => ({ vessel: k.vesselId, voyage: k.voyage, berth: k.berthId, phase: k.phase, disc: k.discharged, loaded: k.loaded, t: clampSec(k.t) })));
    await many(`UPDATE vessels SET vessel_status = :status, berth_code = :berth, voyage_no = :voyage, calls_total = :calls,
                       import_boxes = :imp, export_boxes = :exp, export_target = :target, discharged = :disc, loaded = :loaded,
                       on_hold = :hold, waited_s = :waited, timer_s = :timer, leg_dist = :dist, pos_x = :x, pos_z = :z, heading = :h,
                       arrived_s = :arrived, updated_at = SYSTIMESTAMP
                 WHERE vessel_id = :id`,
      b.vessels.map((v) => ({
        id: v.id, status: v.status, berth: v.berthId, voyage: v.voyage, calls: v.calls, imp: v.importBoxes, exp: v.exportBoxes,
        target: v.exportTarget, disc: v.discharged, loaded: v.loaded, hold: yn(v.hold), waited: round(v.waited, 2),
        timer: round(Math.max(-9999, v.timer), 2), dist: round(v.dist), x: round(v.pos.x), z: round(v.pos.z), h: round(v.heading, 5),
        arrived: v.arrivedAt === null ? null : clampSec(v.arrivedAt),
      })));
    await many('UPDATE port_berths SET is_open = :open, vessel_id = :vessel, updated_at = SYSTIMESTAMP WHERE berth_code = :id',
      b.berths.map((x) => ({ id: x.id, open: yn(x.open), vessel: x.vesselId })));
    await many('UPDATE quay_cranes SET crane_phase = :phase, cycle_pct = :cycle, moves_today = :moves, updated_at = SYSTIMESTAMP WHERE crane_id = :id',
      b.cranes.map((q) => ({ id: q.id, phase: q.phase.toUpperCase(), cycle: round(Math.min(1, Math.max(0, q.cycle)), 4), moves: q.movesToday })));
    await many('UPDATE stores SET deliveries_today = :n, updated_at = SYSTIMESTAMP WHERE store_id = :id',
      b.stores.map((st) => ({ id: st.id, n: st.deliveriesToday })));
    await many('UPDATE store_stock SET units = :units, sold_today = :sold, updated_at = SYSTIMESTAMP WHERE store_id = :store AND sku_id = :sku',
      b.storeLines.map(({ storeId, line }) => ({ store: storeId, sku: line.skuId, units: Math.max(0, Math.round(line.units)), sold: line.soldToday })));
    // orders before vans: a van points at its current order
    await many(`MERGE INTO store_orders d
                USING (SELECT :id AS order_id FROM dual) s ON (d.order_id = s.order_id)
                WHEN MATCHED THEN UPDATE SET d.order_status = :status, d.units = :units, d.van_id = :van,
                     d.dispatched_s = :dispatched, d.delivered_s = :delivered
                WHEN NOT MATCHED THEN INSERT (order_id, store_id, sku_id, facility_id, units, order_status, order_source, placed_by, van_id,
                     placed_s, dispatched_s, delivered_s)
                VALUES (:id, :store, :sku, :fac, :units, :status, :src, :placedBy, :van, :placed, :dispatched, :delivered)`,
      b.orders.map((o) => ({
        id: o.id, store: o.storeId, sku: o.skuId, fac: o.facilityId, units: o.units, status: o.status, src: o.source, placedBy: o.placedBy,
        van: o.vanId, placed: clampSec(o.placedAt), dispatched: clampSec(o.dispatchedAt), delivered: clampSec(o.deliveredAt),
      })));
    await many(`UPDATE delivery_vans SET van_status = :status, order_id = :ord, store_id = :store, leg_dist = :dist, timer_s = :timer,
                       pos_x = :x, pos_z = :z, heading = :h, trips_today = :trips, updated_at = SYSTIMESTAMP
                 WHERE van_id = :id`,
      b.vans.map((v) => ({
        id: v.id, status: v.status, ord: v.status === 'IDLE' ? null : v.orderId, store: v.storeId, dist: round(v.dist), timer: round(Math.max(0, v.timer), 2),
        x: round(v.pos.x), z: round(v.pos.z), h: round(v.heading, 5), trips: v.tripsToday,
      })));
  }

  private async loadPortAndStores(w: WorldState, st: Row, rows: (sql: string, b?: Record<string, unknown>) => Promise<Row[]>): Promise<void> {
    const P = w.port;
    P.nextBox = Number(st.NEXT_BOX ?? P.nextBox);
    P.movesToday = Number(st.PORT_MOVES_TODAY ?? 0);
    P.callsToday = Number(st.PORT_CALLS_TODAY ?? 0);
    P.gateInToday = Number(st.PORT_GATE_IN_TODAY ?? 0);
    P.gateOutToday = Number(st.PORT_GATE_OUT_TODAY ?? 0);
    P.extTimer = Number(st.PORT_EXT_TIMER_S ?? 0);
    w.retail.nextOrder = Number(st.NEXT_ORDER ?? w.retail.nextOrder);
    for (const r of await rows('SELECT * FROM port_berths')) {
      const b = P.berths[r.BERTH_CODE];
      if (b) { b.open = r.IS_OPEN === 'Y'; b.vesselId = r.VESSEL_ID ?? null; }
    }
    for (const r of await rows('SELECT * FROM vessels')) {
      const v = P.vessels[r.VESSEL_ID] as Vessel | undefined;
      if (!v) continue;
      Object.assign(v, {
        status: r.VESSEL_STATUS as VesselStatus, berthId: r.BERTH_CODE ?? null, voyage: r.VOYAGE_NO, calls: Number(r.CALLS_TOTAL),
        importBoxes: Number(r.IMPORT_BOXES), exportBoxes: Number(r.EXPORT_BOXES), exportTarget: Number(r.EXPORT_TARGET),
        discharged: Number(r.DISCHARGED), loaded: Number(r.LOADED), hold: r.ON_HOLD === 'Y', waited: Number(r.WAITED_S),
        timer: Number(r.TIMER_S), dist: Number(r.LEG_DIST), arrivedAt: numOrNull(r.ARRIVED_S),
      });
      const p = vesselPose(v);
      v.pos = p.pos;
      v.heading = p.heading;
    }
    for (const r of await rows('SELECT * FROM quay_cranes')) {
      const q = P.cranes[r.CRANE_ID] as QuayCrane | undefined;
      if (q) { q.phase = String(r.CRANE_PHASE).toLowerCase() as QuayCrane['phase']; q.cycle = Number(r.CYCLE_PCT); q.movesToday = Number(r.MOVES_TODAY); }
    }
    const yard = await rows('SELECT container_no, block_code FROM yard_containers ORDER BY arrived_move_id');
    P.importStack = yard.filter((r) => r.BLOCK_CODE === 'IMPORT').map((r) => r.CONTAINER_NO);
    P.exportStack = yard.filter((r) => r.BLOCK_CODE === 'EXPORT').map((r) => r.CONTAINER_NO);

    const R = w.retail;
    for (const r of await rows('SELECT store_id, deliveries_today FROM stores')) {
      const s = R.stores[r.STORE_ID];
      if (s) s.deliveriesToday = Number(r.DELIVERIES_TODAY);
    }
    for (const r of await rows('SELECT * FROM store_stock')) {
      const line = R.stores[r.STORE_ID]?.lines.find((l) => l.skuId === r.SKU_ID);
      if (line) Object.assign(line, { units: Number(r.UNITS), reorderAt: Number(r.REORDER_AT), maxUnits: Number(r.MAX_UNITS), salesPerHour: Number(r.SALES_PER_HOUR), soldToday: Number(r.SOLD_TODAY) });
    }
    // open orders and the most recent finished ones
    for (const r of await rows(`SELECT * FROM (SELECT * FROM store_orders
                                  WHERE order_status IN ('PLACED', 'LOADING', 'OUT_FOR_DELIVERY') OR placed_at > SYSTIMESTAMP - INTERVAL '30' MINUTE
                                  ORDER BY placed_at DESC) WHERE ROWNUM <= 60`)) {
      const o: StoreOrder = {
        id: r.ORDER_ID, storeId: r.STORE_ID, facilityId: r.FACILITY_ID, skuId: r.SKU_ID, units: Number(r.UNITS), status: r.ORDER_STATUS as StoreOrderStatus,
        source: r.ORDER_SOURCE, placedBy: numOrNull(r.PLACED_BY), placedAt: Number(r.PLACED_S), dispatchedAt: numOrNull(r.DISPATCHED_S),
        deliveredAt: numOrNull(r.DELIVERED_S), vanId: r.VAN_ID ?? null,
      };
      R.orders[o.id] = o;
    }
    for (const r of await rows('SELECT * FROM delivery_vans')) {
      const v = R.vans[r.VAN_ID] as DeliveryVan | undefined;
      if (!v) continue;
      Object.assign(v, {
        status: r.VAN_STATUS as VanStatus, orderId: r.ORDER_ID ?? null, storeId: r.STORE_ID ?? null, dist: Number(r.LEG_DIST), timer: Number(r.TIMER_S),
        pos: { x: Number(r.POS_X), z: Number(r.POS_Z) }, heading: Number(r.HEADING), tripsToday: Number(r.TRIPS_TODAY),
      });
    }
  }

  async setVesselHold(userId: number, vesselId: string, hold: boolean): Promise<void> {
    await this.tx(userId, (c) => c.execute('BEGIN wt_port.set_vessel_hold(:u, :v, :h); END;', { u: userId, v: vesselId, h: yn(hold) }));
  }

  async setBerthOpen(userId: number, berthId: string, open: boolean): Promise<void> {
    await this.tx(userId, (c) => c.execute('BEGIN wt_port.set_berth_open(:u, :b, :o); END;', { u: userId, b: berthId, o: yn(open) }));
  }

  async placeStoreOrder(userId: number, o: NewStoreOrder): Promise<void> {
    await this.tx(userId, (c) => c.execute('BEGIN wt_retail.place_order(:u, :id, :store, :sku, :units, :fac, :t); END;',
      { u: userId, id: o.id, store: o.storeId, sku: o.skuId, units: o.units, fac: o.facilityId, t: clampSec(o.simTime) }));
  }

  async cancelStoreOrder(userId: number, orderId: string): Promise<void> {
    await this.tx(userId, (c) => c.execute('BEGIN wt_retail.cancel_order(:u, :id); END;', { u: userId, id: orderId }));
  }

  async containerMoves(o: { limit: number; container?: string; vesselId?: string }): Promise<ContainerMoveRow[]> {
    const r = await this.q(null, `SELECT * FROM (SELECT * FROM v_container_moves
                                    WHERE (:box IS NULL OR container_no = :box) AND (:vessel IS NULL OR vessel_id = :vessel)
                                    ORDER BY move_id DESC) WHERE ROWNUM <= :lim`,
      { box: o.container ?? null, vessel: o.vesselId ?? null, lim: o.limit });
    return r.map((x) => ({
      id: Number(x.MOVE_ID), at: iso(x.CREATED_AT) ?? '', simTime: Number(x.SIM_TIME_S), containerNo: x.CONTAINER_NO, line: x.SHIPPING_LINE,
      move: x.MOVE_TYPE, vesselId: x.VESSEL_ID ?? null, vesselName: x.VESSEL_NAME ?? null, craneId: x.CRANE_ID ?? null,
      truckId: x.TRUCK_ID ?? null, facilityId: x.FACILITY_ID ?? null,
    }));
  }

  async vesselCalls(limit: number): Promise<VesselCallRow[]> {
    const r = await this.q(null, `SELECT * FROM (SELECT c.*, v.name AS vessel_name FROM vessel_calls c JOIN vessels v ON v.vessel_id = c.vessel_id
                                    ORDER BY c.call_id DESC) WHERE ROWNUM <= :lim`, { lim: limit });
    return r.map((x) => ({
      id: Number(x.CALL_ID), vesselId: x.VESSEL_ID, vesselName: x.VESSEL_NAME, voyage: x.VOYAGE_NO, berthId: x.BERTH_CODE,
      arrivedAt: iso(x.ARRIVED_AT) ?? '', departedAt: iso(x.DEPARTED_AT), discharged: Number(x.BOXES_DISCHARGED), loaded: Number(x.BOXES_LOADED),
      status: x.CALL_STATUS,
    }));
  }

  async storeOrders(o: { storeId?: string; facilities: FacilityId[]; limit: number }): Promise<StoreOrderRow[]> {
    const ph = placeholders('f', o.facilities);
    const r = await this.q(null, `SELECT * FROM (SELECT v.*, u.username FROM v_store_orders v LEFT JOIN app_users u ON u.user_id = v.placed_by
                                    WHERE (:store IS NULL OR v.store_id = :store) AND v.facility_id IN (${ph.sql})
                                    ORDER BY v.placed_at DESC) WHERE ROWNUM <= :lim`,
      { store: o.storeId ?? null, lim: o.limit, ...ph.binds });
    return r.map((x) => ({
      id: x.ORDER_ID, status: x.ORDER_STATUS, source: x.ORDER_SOURCE, storeId: x.STORE_ID, storeName: x.STORE_NAME, skuId: x.SKU_ID,
      units: Number(x.UNITS), facilityId: x.FACILITY_ID, vanId: x.VAN_ID ?? null, placedBy: x.USERNAME ?? null,
      placedAt: iso(x.PLACED_AT) ?? '', dispatchedAt: iso(x.DISPATCHED_AT), deliveredAt: iso(x.DELIVERED_AT),
    }));
  }

  // ---------------------------------------------------------------- live database feed
  async liveCounts(tables: string[]): Promise<Record<string, number>> {
    // table names come from the server's fixed LIVE_COUNT_TABLES list
    const safe = tables.filter((t) => /^[A-Z_]+$/.test(t));
    const sql = `SELECT ${safe.map((t, i) => `(SELECT COUNT(*) FROM ${t.toLowerCase()}) AS c${i}`).join(', ')} FROM dual`;
    const r = await this.tx(null, async (c) => (await c.execute(sql)).rows ?? [], 'live');
    const row = (r[0] ?? {}) as Row;
    return Object.fromEntries(safe.map((t, i) => [t, Number(row[`C${i}`] ?? 0)]));
  }

  async liveRow(table: string, key: string, id: string): Promise<DbLiveRow | null> {
    if (!/^[A-Z_]+$/.test(table) || !/^[A-Z_]+$/.test(key)) throw new AppError(400, 'Bad table');
    const sql = `SELECT * FROM ${table.toLowerCase()} WHERE ${key.toLowerCase()} = :id`;
    const t0 = performance.now();
    return this.tx(null, async (c) => {
      const r = await c.execute(sql, { id }, { outFormat: this.oracledb.OUT_FORMAT_ARRAY });
      const row = ((r.rows ?? []) as unknown[][])[0];
      if (!row) return null;
      return {
        engine: 'oracle' as const, table, key, id, sql, fetchedAt: new Date().toISOString(), ms: Math.round((performance.now() - t0) * 10) / 10,
        columns: (r.metaData ?? []).map((m: any) => m.name), values: row.map(cell),
      };
    }, 'live');
  }
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** Recreate a truck's route legs from its persisted status and dock. */
export function rebuildLegs(t: Truck): Leg[] {
  switch (t.phase) {
    case 'en_route':
    case 'at_gate':
      return [legRoadIn(t.facilityId, t.direction === 'inbound' ? t.lane : 'ROAD')];
    case 'docking':
      return t.dockId ? [legYardIn(t.facilityId, t.dockId), legReverseIn(t.facilityId, t.dockId)] : [legRoadIn(t.facilityId)];
    case 'departing':
    case 'leaving': {
      // the dock is kept until the truck is off site, so the yard leg can be rebuilt exactly
      const lane = t.direction === 'outbound' ? t.lane : 'ROAD';
      return t.dockId ? [legYardOut(t.facilityId, t.dockId), legRoadOut(t.facilityId, lane)] : [legRoadOut(t.facilityId, lane), legRoadOut(t.facilityId, lane)];
    }
    default:
      return [];
  }
}


function dateOnly(d: unknown): string {
  if (d instanceof Date) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return String(d ?? '').slice(0, 10);
}

/** JSON-safe value for the SQL console and table samples. */
function cell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return `0x${v.toString('hex').slice(0, 64)}`;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
