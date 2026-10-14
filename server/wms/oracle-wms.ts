// Smart Warehouse on Oracle: loads and saves the engine's state, and answers every report
// with SQL against the database (analytic functions, MODEL clause, recursive WITH,
// MATCH_RECOGNIZE, blockchain verification, vector search, GRAPH_TABLE).
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FacilityId } from '../../src/data/types';
import type {
  WmsFeatures, AbcRow, LotRow, FefoViolation, BreachRow, LedgerRow, ReplenishRow, SearchHit, QcStatus, AbcClass,
} from '../../src/api/wms-types';
import type { SqlSource } from '../db/repo';
import type { WmsLot, WmsBinStock, PendingChanges } from './engine';

type Conn = any;
type Row = Record<string, any>;
export interface WmsDeps {
  oracledb: any;
  tx<T>(userId: number | null, fn: (c: Conn) => Promise<T>, source?: SqlSource): Promise<T>;
}

/**
 * Timestamps: columns filled by SYSTIMESTAMP hold the database server's wall-clock time, which can
 * differ from the time zone this server runs in. Times therefore cross the boundary as UTC text,
 * converted inside SQL: UTC(col) reads one out, FROM_UTC(:bind) writes one in.
 */
const UTC = (col: string) => `TO_CHAR(SYS_EXTRACT_UTC(FROM_TZ(CAST(${col} AS TIMESTAMP), TO_CHAR(SYSTIMESTAMP, 'TZH:TZM'))), 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"')`;
const FROM_UTC = (bind: string) => `CAST(FROM_TZ(TO_TIMESTAMP(:${bind}, 'YYYY-MM-DD"T"HH24:MI:SS.FF3'), '+00:00') AT TIME ZONE TO_CHAR(SYSTIMESTAMP, 'TZH:TZM') AS TIMESTAMP)`;
const utcIn = (isoStr: string) => isoStr.replace(/Z$/, '').slice(0, 23);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
/** Vector literal for TO_VECTOR: 5 decimals keep 384 numbers under 4000 characters (a plain VARCHAR2 bind). */
const vec = (v: number[]) => `[${v.map((x) => Math.round(x * 1e5) / 1e5).join(',')}]`;
const inList = (prefix: string, values: string[]) => {
  const binds: Record<string, string> = {};
  const sql = values.map((v, i) => { binds[`${prefix}${i}`] = v; return `:${prefix}${i}`; }).join(', ') || 'NULL';
  return { sql, binds };
};

export const SQL = {
  abc: `SELECT facility_id, sku_id, sku_name, units_30d, picks_30d, share_pct, cumulative_pct, velocity_rank, abc_class, avg_dock_metres
  FROM v_sku_abc            -- RATIO_TO_REPORT, running SUM() OVER (ORDER BY …), ROW_NUMBER()
 WHERE facility_id = :fac
 ORDER BY velocity_rank`,
  lots: `SELECT lot_id, facility_id, sku_id, sku_name, supplier, shipment_id, container_no, ${UTC('received_at')} AS received_utc,
       TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry, days_to_expiry, qc_status, qc_reason, units_on_hand, units_received, pallets_in_bins, fefo_rank
  FROM v_lot_stock          -- RANK() OVER (PARTITION BY site, product ORDER BY expiry_date) = FEFO order
 WHERE (units_on_hand > 0 OR qc_status <> 'RELEASED')
 ORDER BY facility_id, sku_id, fefo_rank`,
  violations: `SELECT move_id, ${UTC('picked_at')} AS picked_utc, facility_id, sku_id, picked_lot, TO_CHAR(picked_expiry, 'YYYY-MM-DD') AS picked_exp,
       older_lot, TO_CHAR(older_expiry, 'YYYY-MM-DD') AS older_exp, units, ref_id
  FROM v_fefo_violations   -- a pick while an older-expiring released lot still had stock (balance from the ledger)
 ORDER BY move_id DESC FETCH FIRST 30 ROWS ONLY`,
  traceDown: `WITH t (kind, id, parent_key, depth, units) AS (
  SELECT CAST(:kind AS VARCHAR2(10)), CAST(:id AS VARCHAR2(60)), CAST(NULL AS VARCHAR2(80)), 0, CAST(NULL AS NUMBER) FROM dual
  UNION ALL
  SELECT l.child_kind, l.child_id, t.kind || ':' || t.id, t.depth + 1, l.units
    FROM t JOIN v_trace_links l ON l.parent_kind = t.kind AND l.parent_id = t.id
   WHERE t.depth < 6
) SEARCH DEPTH FIRST BY kind, id SET ord
  CYCLE kind, id SET is_cycle TO 'Y' DEFAULT 'N'
SELECT kind, id, parent_key, depth, units FROM t WHERE is_cycle = 'N' ORDER BY ord`,
  traceUp: `WITH t (kind, id, parent_key, depth, units) AS (
  SELECT CAST(:kind AS VARCHAR2(10)), CAST(:id AS VARCHAR2(60)), CAST(NULL AS VARCHAR2(80)), 0, CAST(NULL AS NUMBER) FROM dual
  UNION ALL
  SELECT l.parent_kind, l.parent_id, t.kind || ':' || t.id, t.depth + 1, l.units
    FROM t JOIN v_trace_links l ON l.child_kind = t.kind AND l.child_id = t.id
   WHERE t.depth < 6
) SEARCH DEPTH FIRST BY kind, id SET ord
  CYCLE kind, id SET is_cycle TO 'Y' DEFAULT 'N'
SELECT kind, id, parent_key, depth, units FROM t WHERE is_cycle = 'N' ORDER BY ord`,
  breaches: `-- the detector (WT_WMS.DETECT_BREACHES, run by the CV_DETECT_BREACHES scheduler job):
SELECT *
  FROM (SELECT r.sensor_id, r.read_at, r.temp_c, s.min_c, s.max_c FROM sensor_readings r JOIN sensors s ON s.sensor_id = r.sensor_id)
MATCH_RECOGNIZE (
  PARTITION BY sensor_id ORDER BY read_at
  MEASURES FIRST(out_of_range.read_at) AS started_at, MAX(out_of_range.temp_c) AS peak_c, COUNT(out_of_range.*) AS readings_out
  ONE ROW PER MATCH
  PATTERN (out_of_range{3,})
  DEFINE out_of_range AS out_of_range.temp_c > out_of_range.max_c OR out_of_range.temp_c < out_of_range.min_c)`,
  ledger: `DECLARE n NUMBER;
BEGIN
  DBMS_BLOCKCHAIN_TABLE.VERIFY_ROWS(schema_name => USER, table_name => 'STOCK_LEDGER',
                                    low_timestamp => SYSTIMESTAMP - INTERVAL '2' HOUR,
                                    number_of_rows_verified => n);
END;
-- then, to prove it: UPDATE stock_ledger SET units = units + 1 WHERE ROWNUM = 1;  → ORA-05715`,
  forecast: `SELECT TO_CHAR(forecast_date, 'YYYY-MM-DD') AS forecast_date, forecast_units, trend_units, weekday_index
  FROM v_demand_forecast    -- MODEL … RULES (trend[ANY] = intercept[CV()] + slope[CV()] * CV(day_no)) × weekday index
 WHERE facility_id = :fac AND sku_id = :sku ORDER BY forecast_date`,
  replenish: `SELECT * FROM v_replenishment   -- reorder point = demand × lead time + 1.65·σ·√lead time; EOQ = √(2DS/H)
 ORDER BY CASE action WHEN 'REORDER' THEN 0 ELSE 1 END, days_of_cover`,
  scan: `BEGIN :r := wt_wms.scan(:code, :user_id); END;   -- validates the GS1 check digit, logs the scan, publishes an event`,
  route: `SELECT wt_wms.shortest_path(:from_node, :to_node) FROM dual   -- Dijkstra in PL/SQL over WH_EDGES`,
  graph: `SELECT COUNT(DISTINCT node_id) AS n, MIN(node_id) AS first_node
  FROM GRAPH_TABLE (cv_warehouse_graph
         MATCH (d IS location WHERE d.node_id = :dock) -[e IS aisle]-{1,6} (n IS location)
         WHERE n.node_kind = 'AISLE'
         COLUMNS (n.node_id AS node_id))`,
  search: `SELECT kind, id, sku_id, facility_id, doc_text, severity, ${UTC('created_at')} AS created_utc, distance
  FROM (SELECT CAST('DAMAGE' AS VARCHAR2(8)) AS kind, TO_CHAR(report_id) AS id, sku_id, facility_id, report_text AS doc_text, severity, created_at,
               VECTOR_DISTANCE(embedding, TO_VECTOR(:q, 384, FLOAT32), COSINE) AS distance
          FROM damage_reports WHERE embedding IS NOT NULL
        UNION ALL
        SELECT 'PRODUCT', sku_id, sku_id, NULL, description, NULL, NULL,
               VECTOR_DISTANCE(embedding, TO_VECTOR(:q, 384, FLOAT32), COSINE)
          FROM sku_handling WHERE embedding IS NOT NULL)
 ORDER BY distance
 FETCH FIRST 8 ROWS ONLY`,
};

export class OracleWms {
  private feat: { at: number; f: WmsFeatures } | null = null;

  constructor(private d: WmsDeps) {}

  // ---------------------------------------------------------------- installation
  async features(embedModel: string, force = false): Promise<WmsFeatures> {
    if (!force && this.feat && Date.now() - this.feat.at < 20000) return { ...this.feat.f, embedModel };
    const f = await this.d.tx(null, async (c) => {
      const one = async (sql: string): Promise<Row | null> => { try { return ((await c.execute(sql)).rows ?? [])[0] ?? null; } catch { return null; } };
      const t = await one(`SELECT COUNT(*) AS n FROM user_tables WHERE table_name IN ('LOTS', 'BIN_STOCK', 'LOT_MOVES', 'STORAGE_BINS', 'SENSORS')`);
      const installed = Number(t?.N ?? 0) === 5;
      if (!installed) return { engine: 'oracle', installed: false, partitioned: false, partitions: 0, blockchain: false, vector: false, queue: null, jobs: [], graph: false, embedModel, note: 'Run `npm run db:lab` to install the Smart Warehouse tables in Oracle.' } as WmsFeatures;
      const p = await one(`SELECT COUNT(*) AS n FROM user_tab_partitions WHERE table_name = 'SENSOR_READINGS'`);
      const bc = await one(`SELECT COUNT(*) AS n FROM user_blockchain_tables WHERE table_name = 'STOCK_LEDGER'`);
      const v = await one(`SELECT data_type FROM user_tab_columns WHERE table_name = 'DAMAGE_REPORTS' AND column_name = 'EMBEDDING'`);
      const q = await one(`SELECT (SELECT COUNT(*) FROM user_queues WHERE name = 'CV_EVENTS') AS q, (SELECT COUNT(*) FROM user_queue_tables WHERE queue_table = 'CV_EVENTS_QT') AS classic FROM dual`);
      const jobs = ((await c.execute(`SELECT job_name FROM user_scheduler_jobs WHERE job_name LIKE 'CV\\_%' ESCAPE '\\' AND enabled = 'TRUE'`).catch(() => ({ rows: [] }))).rows ?? []).map((r: Row) => String(r.JOB_NAME));
      const g = await one(`SELECT COUNT(*) AS n FROM user_property_graphs WHERE graph_name = 'CV_WAREHOUSE_GRAPH'`);
      return {
        engine: 'oracle', installed: true, partitioned: Number(p?.N ?? 0) > 0, partitions: Number(p?.N ?? 0), blockchain: Number(bc?.N ?? 0) > 0,
        vector: String(v?.DATA_TYPE ?? '') === 'VECTOR', queue: Number(q?.Q ?? 0) > 0 ? (Number(q?.CLASSIC ?? 0) > 0 ? 'AQ' : 'TEQ') : null,
        jobs, graph: Number(g?.N ?? 0) > 0, embedModel, note: null,
      } as WmsFeatures;
    }, 'live');
    this.feat = { at: Date.now(), f };
    return f;
  }

  // ---------------------------------------------------------------- state
  async load(): Promise<{ lots: WmsLot[]; bins: WmsBinStock[]; policy: Record<string, 'RANDOM' | 'ABC'>; doors: Record<string, boolean>; empty: boolean }> {
    return this.d.tx(null, async (c) => {
      const rows = async (sql: string) => ((await c.execute(sql)).rows ?? []) as Row[];
      const lots = (await rows(`SELECT l.*, ${UTC('received_at')} AS received_utc, TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry FROM lots l WHERE units_on_hand <> 0 OR qc_status <> 'RELEASED' OR received_at > SYSTIMESTAMP - INTERVAL '1' DAY
                                   OR lot_id IN (SELECT lot_id FROM bin_stock)`)).map((r): WmsLot => ({
        id: r.LOT_ID, facilityId: r.FACILITY_ID, skuId: r.SKU_ID, supplier: r.SUPPLIER, shipmentId: r.SHIPMENT_ID ?? null, containerNo: r.CONTAINER_NO ?? null,
        receivedAt: r.RECEIVED_UTC, expiry: r.EXPIRY ?? null, qc: r.QC_STATUS as QcStatus, qcReason: r.QC_REASON ?? null,
        unitsReceived: Number(r.UNITS_RECEIVED), units: Number(r.UNITS_ON_HAND),
      }));
      const bins = (await rows(`SELECT b.*, ${UTC('placed_at')} AS placed_utc FROM bin_stock b`)).map((r): WmsBinStock => ({ binId: r.BIN_ID, sscc: String(r.SSCC), lotId: r.LOT_ID, units: Number(r.UNITS), placedAt: r.PLACED_UTC }));
      const policy: Record<string, 'RANDOM' | 'ABC'> = {};
      for (const r of await rows('SELECT facility_id, putaway_policy FROM wms_settings')) policy[r.FACILITY_ID] = r.PUTAWAY_POLICY;
      const doors: Record<string, boolean> = {};
      for (const r of await rows('SELECT sensor_id, door_open FROM sensors')) doors[r.SENSOR_ID] = r.DOOR_OPEN === 'Y';
      const any = await rows('SELECT COUNT(*) AS n FROM lots');
      return { lots, bins, policy, doors, empty: Number(any[0].N) === 0 };
    });
  }

  /** Writes one flush of warehouse changes in a single transaction. */
  async persist(p: PendingChanges): Promise<number> {
    if (!p.lots.length && !p.bins.size && !p.moves.length && !p.readings.length && !p.events.length && !p.policies.size) return 0;
    let rows = 0;
    await this.d.tx(null, async (c) => {
      const raw = c.raw;
      const many = async (sql: string, data: Row[], bindDefs?: Record<string, unknown>) => {
        if (!data.length) return;
        await raw.executeMany(sql, data, bindDefs ? { bindDefs } : {});
        rows += data.length;
      };
      const S = this.d.oracledb.STRING, N = this.d.oracledb.NUMBER;
      await many(`INSERT INTO lots (lot_id, facility_id, sku_id, supplier, shipment_id, container_no, received_at, expiry_date, qc_status, qc_reason)
                  VALUES (:id, :fac, :sku, :sup, :ship, :box, ${FROM_UTC('recv')}, TO_DATE(:exp, 'YYYY-MM-DD'), :qc, :reason)`,
        p.lots.map((l) => ({ id: l.id, fac: l.facilityId, sku: l.skuId, sup: l.supplier.slice(0, 80), ship: l.shipmentId, box: l.containerNo, recv: utcIn(l.receivedAt), exp: l.expiry, qc: l.qc, reason: l.qcReason })),
        { id: { type: S, maxSize: 20 }, fac: { type: S, maxSize: 10 }, sku: { type: S, maxSize: 20 }, sup: { type: S, maxSize: 80 }, ship: { type: S, maxSize: 20 },
          box: { type: S, maxSize: 11 }, recv: { type: S, maxSize: 23 }, exp: { type: S, maxSize: 10 }, qc: { type: S, maxSize: 9 }, reason: { type: S, maxSize: 200 } });
      // bins: clear every changed bin first, so a pallet can move between bins in one flush (SSCC is unique)
      const changed = [...p.bins.keys()];
      for (let i = 0; i < changed.length; i += 400) {
        const ph = inList('b', changed.slice(i, i + 400));
        const r = await c.execute(`DELETE FROM bin_stock WHERE bin_id IN (${ph.sql})`, ph.binds);
        rows += r.rowsAffected ?? 0;
      }
      await many(`INSERT INTO bin_stock (bin_id, sscc, lot_id, units, placed_at) VALUES (:bin, :sscc, :lot, :units, ${FROM_UTC('at')})`,
        [...p.bins.values()].filter((b): b is WmsBinStock => !!b).map((b) => ({ bin: b.binId, sscc: b.sscc, lot: b.lotId, units: b.units, at: utcIn(b.placedAt) })),
        { bin: { type: S, maxSize: 20 }, sscc: { type: S, maxSize: 18 }, lot: { type: S, maxSize: 20 }, units: { type: N }, at: { type: S, maxSize: 23 } });
      // the ledger: the trigger updates the lot balance, the daily demand and the blockchain table
      await many(`INSERT INTO lot_moves (lot_id, facility_id, sku_id, move_type, units, bin_id, to_bin_id, sscc, ref_kind, ref_id, metres, fefo_ok, sim_time_s, created_by)
                  VALUES (:lot, :fac, :sku, :type, :units, :bin, :tobin, :sscc, :refKind, :refId, :metres, :fefo, :t, :usr)`,
        p.moves.filter((m) => m.lotId !== 'UNTRACKED').map((m) => ({
          lot: m.lotId, fac: m.facilityId, sku: m.skuId, type: m.type, units: m.units, bin: m.binId, tobin: m.toBinId, sscc: m.sscc, refKind: m.refKind,
          refId: m.refId ? m.refId.slice(0, 30) : null, metres: m.metres, fefo: m.fefoOk === null ? null : m.fefoOk ? 'Y' : 'N',
          t: Math.max(0, Math.min(9999999, Math.round(m.simTime))), usr: m.userId,
        })),
        { lot: { type: S, maxSize: 20 }, fac: { type: S, maxSize: 10 }, sku: { type: S, maxSize: 20 }, type: { type: S, maxSize: 10 }, units: { type: N },
          bin: { type: S, maxSize: 20 }, tobin: { type: S, maxSize: 20 }, sscc: { type: S, maxSize: 18 }, refKind: { type: S, maxSize: 8 }, refId: { type: S, maxSize: 30 },
          metres: { type: N }, fefo: { type: S, maxSize: 1 }, t: { type: N }, usr: { type: N } });
      await many(`INSERT INTO sensor_readings (sensor_id, read_at, temp_c) VALUES (:s, ${FROM_UTC('at')}, :c)`,
        p.readings.map((r) => ({ s: r.sensorId, at: utcIn(r.at), c: r.tempC })),
        { s: { type: S, maxSize: 12 }, at: { type: S, maxSize: 23 }, c: { type: N } });
      for (const [fac, policy] of p.policies) {
        await c.execute(`UPDATE wms_settings SET putaway_policy = :p, updated_at = SYSTIMESTAMP WHERE facility_id = :f`, { p: policy, f: fac });
      }
      for (const e of p.events) {
        await c.execute(`BEGIN wt_events.publish(:type, :fac, :title, :detail, :rk, :ri); END;`,
          { type: e.type, fac: e.facilityId, title: e.title.slice(0, 200), detail: e.detail?.slice(0, 1000) ?? null, rk: e.refKind, ri: e.refId });
      }
    }, 'sim');
    return rows;
  }

  /** Quality status and door changes made in the database (recalls, holds by the breach job, SQL Developer). */
  async refresh(): Promise<{ qc: { lotId: string; qc: QcStatus; reason: string | null }[]; doors: Record<string, boolean>; policy: Record<string, 'RANDOM' | 'ABC'> }> {
    return this.d.tx(null, async (c) => {
      // a short look-back window is enough: this runs after every flush (every two seconds)
      const qc = (((await c.execute(`SELECT lot_id, qc_status, qc_reason FROM lots WHERE qc_changed_at > SYSTIMESTAMP - INTERVAL '20' SECOND`)).rows ?? []) as Row[])
        .map((r) => ({ lotId: r.LOT_ID, qc: r.QC_STATUS as QcStatus, reason: r.QC_REASON ?? null }));
      const doors: Record<string, boolean> = {};
      for (const r of ((await c.execute('SELECT sensor_id, door_open FROM sensors')).rows ?? []) as Row[]) doors[r.SENSOR_ID] = r.DOOR_OPEN === 'Y';
      const policy: Record<string, 'RANDOM' | 'ABC'> = {};
      for (const r of ((await c.execute('SELECT facility_id, putaway_policy FROM wms_settings')).rows ?? []) as Row[]) policy[r.FACILITY_ID] = r.PUTAWAY_POLICY;
      return { qc, doors, policy };
    }, 'live');
  }

  async detectBreaches(): Promise<number> {
    return this.d.tx(null, async (c) => {
      const r = await c.execute('BEGIN :n := wt_wms.detect_breaches; END;', { n: { dir: this.d.oracledb.BIND_OUT, type: this.d.oracledb.NUMBER } });
      return Number(r.outBinds.n ?? 0);
    }, 'sim');
  }

  /** Waits up to `wait` seconds for events on the CV_EVENTS queue. */
  async dequeue(wait: number): Promise<Row[]> {
    return this.d.tx(null, async (c) => {
      const r = await c.execute('BEGIN :r := wt_events.dequeue_batch(:w, 40); END;',
        { r: { dir: this.d.oracledb.BIND_OUT, type: this.d.oracledb.STRING, maxSize: 32767 }, w: wait });
      return JSON.parse(String(r.outBinds.r || '[]')) as Row[];
    }, 'live');
  }
  /** Without a queue: new rows of WMS_EVENTS. */
  async eventsAfter(lastId: number): Promise<Row[]> {
    return this.d.tx(null, async (c) => (((await c.execute(`SELECT event_id AS "id", event_type AS "type", facility_id AS "facility", title AS "title", detail AS "detail",
        ref_kind AS "refKind", ref_id AS "refId", ${UTC('created_at')} AS "at" FROM wms_events WHERE event_id > :id ORDER BY event_id FETCH FIRST 100 ROWS ONLY`, { id: lastId })).rows ?? []) as Row[]), 'live');
  }
  async lastEventId(): Promise<number> {
    return this.d.tx(null, async (c) => Number((((await c.execute('SELECT NVL(MAX(event_id), 0) AS n FROM wms_events')).rows ?? [])[0] as Row).N), 'live');
  }

  // ---------------------------------------------------------------- reports
  async abc(fac: FacilityId): Promise<AbcRow[]> {
    return this.d.tx(null, async (c) => {
      const pallets = new Map<string, number>();
      for (const r of ((await c.execute(`SELECT l.sku_id, COUNT(*) AS n FROM bin_stock b JOIN lots l ON l.lot_id = b.lot_id WHERE l.facility_id = :fac GROUP BY l.sku_id`, { fac })).rows ?? []) as Row[]) pallets.set(r.SKU_ID, Number(r.N));
      return (((await c.execute(SQL.abc, { fac })).rows ?? []) as Row[]).map((r) => ({
        facilityId: fac, skuId: r.SKU_ID, skuName: r.SKU_NAME, units30d: Number(r.UNITS_30D), picks30d: Number(r.PICKS_30D), sharePct: Number(r.SHARE_PCT),
        cumulativePct: Number(r.CUMULATIVE_PCT), rank: Number(r.VELOCITY_RANK), abc: r.ABC_CLASS as AbcClass, avgDockMetres: num(r.AVG_DOCK_METRES), pallets: pallets.get(r.SKU_ID) ?? 0,
      }));
    }, 'live');
  }

  async metresPerPick(): Promise<Record<string, number>> {
    return this.d.tx(null, async (c) => {
      const out: Record<string, number> = {};
      for (const r of ((await c.execute(`SELECT facility_id, ROUND(AVG(metres), 1) AS m
          FROM (SELECT facility_id, metres, ROW_NUMBER() OVER (PARTITION BY facility_id ORDER BY move_id DESC) AS rn
                  FROM lot_moves WHERE move_type IN ('PICK', 'SHIP_STORE') AND metres > 0 AND created_at > SYSTIMESTAMP - INTERVAL '6' HOUR)
         WHERE rn <= 50 GROUP BY facility_id`)).rows ?? []) as Row[]) out[r.FACILITY_ID] = Number(r.M);
      return out;
    }, 'live');
  }

  async lots(): Promise<{ lots: LotRow[]; violations: FefoViolation[] }> {
    return this.d.tx(null, async (c) => {
      const lots = (((await c.execute(SQL.lots)).rows ?? []) as Row[]).map((r): LotRow => ({
        lotId: r.LOT_ID, facilityId: r.FACILITY_ID, skuId: r.SKU_ID, skuName: r.SKU_NAME, supplier: r.SUPPLIER, shipmentId: r.SHIPMENT_ID ?? null,
        containerNo: r.CONTAINER_NO ?? null, receivedAt: r.RECEIVED_UTC, expiry: r.EXPIRY ?? null, daysToExpiry: num(r.DAYS_TO_EXPIRY),
        qc: r.QC_STATUS, qcReason: r.QC_REASON ?? null, units: Number(r.UNITS_ON_HAND), unitsReceived: Number(r.UNITS_RECEIVED), pallets: Number(r.PALLETS_IN_BINS), fefoRank: Number(r.FEFO_RANK),
      }));
      const violations = (((await c.execute(SQL.violations)).rows ?? []) as Row[]).map((r): FefoViolation => ({
        moveId: Number(r.MOVE_ID), pickedAt: r.PICKED_UTC, facilityId: r.FACILITY_ID, skuId: r.SKU_ID, pickedLot: r.PICKED_LOT,
        pickedExpiry: r.PICKED_EXP ?? null, olderLot: r.OLDER_LOT, olderExpiry: r.OLDER_EXP ?? null, units: Number(r.UNITS), ref: r.REF_ID ?? null,
      }));
      return { lots, violations };
    }, 'live');
  }

  async trace(kind: string, id: string, dir: 'down' | 'up'): Promise<{ kind: string; id: string; parent: string | null; depth: number; units: number | null }[]> {
    return this.d.tx(null, async (c) => (((await c.execute(dir === 'down' ? SQL.traceDown : SQL.traceUp, { kind, id })).rows ?? []) as Row[]).map((r) => ({
      kind: String(r.KIND), id: String(r.ID), parent: r.PARENT_KEY ?? null, depth: Number(r.DEPTH), units: num(r.UNITS),
    })), 'live');
  }

  async recall(lot: string, reason: string, userId: number): Promise<number> {
    return this.d.tx(userId, async (c) => {
      const r = await c.execute('BEGIN :n := wt_wms.recall_lot(:lot, :reason, :u); END;', { n: { dir: this.d.oracledb.BIND_OUT, type: this.d.oracledb.NUMBER }, lot, reason, u: userId });
      return Number(r.outBinds.n ?? 0);
    });
  }
  async release(lot: string, userId: number): Promise<void> {
    await this.d.tx(userId, async (c) => { await c.execute('BEGIN wt_wms.release_lot(:lot, :u); END;', { lot, u: userId }); });
  }
  async setDoor(sensorId: string, open: boolean, userId: number): Promise<void> {
    await this.d.tx(userId, async (c) => {
      await c.execute(`UPDATE sensors SET door_open = :o WHERE sensor_id = :s`, { o: open ? 'Y' : 'N', s: sensorId });
      await c.execute(`BEGIN wt_core.log_audit('SENSOR_DOOR', 'SENSOR', :s, NULL, :d); END;`, { s: sensorId, d: open ? 'Cold room door opened (demonstration)' : 'Cold room door closed' });
    });
  }

  async cold(): Promise<{ series: Row[]; breaches: BreachRow[]; partitions: { name: string; rows: number | null; highValue: string }[] }> {
    return this.d.tx(null, async (c) => {
      const series = ((await c.execute(`SELECT sensor_id, ${UTC('read_at')} AS read_utc, temp_c FROM sensor_readings WHERE read_at > SYSTIMESTAMP - INTERVAL '20' MINUTE ORDER BY sensor_id, read_at`)).rows ?? []) as Row[];
      const breaches = (((await c.execute(`SELECT b.*, ${UTC('started_at')} AS started_utc, CASE WHEN ended_at IS NOT NULL THEN ${UTC('ended_at')} END AS ended_utc
                                               FROM cold_breaches b ORDER BY breach_id DESC FETCH FIRST 15 ROWS ONLY`)).rows ?? []) as Row[]).map((r): BreachRow => ({
        id: `BR-${r.BREACH_ID}`, sensorId: r.SENSOR_ID, facilityId: r.FACILITY_ID, startedAt: r.STARTED_UTC, endedAt: r.ENDED_UTC ?? null, peakC: Number(r.PEAK_C),
        readings: Number(r.READINGS_OUT), lotsHeld: Number(r.LOTS_HELD), status: r.BREACH_STATUS,
      }));
      const parts: { name: string; rows: number | null; highValue: string }[] = [];
      const pr = ((await c.execute(`SELECT partition_name, high_value FROM user_tab_partitions WHERE table_name = 'SENSOR_READINGS' ORDER BY partition_position`).catch(() => ({ rows: [] }))).rows ?? []) as Row[];
      for (const p of pr.slice(-6)) {
        let n: number | null = null;
        try { n = Number((((await c.execute(`SELECT COUNT(*) AS n FROM sensor_readings PARTITION (${String(p.PARTITION_NAME).replace(/[^A-Z0-9_$#]/gi, '')})`)).rows ?? [])[0] as Row).N); } catch { /* ignore */ }
        parts.push({ name: p.PARTITION_NAME, rows: n, highValue: String(p.HIGH_VALUE ?? '').replace(/^TIMESTAMP' ?/, '').replace(/'$/, '') });
      }
      return { series, breaches, partitions: parts };
    }, 'live');
  }

  async ledger(): Promise<{ kind: 'blockchain' | 'plain'; rows: number; verified: number | null; ok: boolean | null; ms: number; recent: LedgerRow[]; tamper: { attempted: string; error: string | null; blocked: boolean } }> {
    const kind = (await this.features('')).blockchain ? 'blockchain' : 'plain';
    const base = await this.d.tx(null, async (c) => {
      const rows = Number((((await c.execute('SELECT COUNT(*) AS n FROM stock_ledger')).rows ?? [])[0] as Row).N);
      const recent = (((await c.execute(kind === 'blockchain'
        ? `SELECT move_id, lot_id, facility_id, sku_id, move_type, units, bin_id, ref_id, ${UTC('recorded_at')} AS recorded_utc, ORABCTAB_SEQ_NUM$ AS seq, RAWTOHEX(ORABCTAB_HASH$) AS hash
             FROM stock_ledger ORDER BY ORABCTAB_CREATION_TIME$ DESC, ORABCTAB_SEQ_NUM$ DESC FETCH FIRST 12 ROWS ONLY`
        : `SELECT move_id, lot_id, facility_id, sku_id, move_type, units, bin_id, ref_id, ${UTC('recorded_at')} AS recorded_utc, move_id AS seq, NULL AS hash
             FROM stock_ledger ORDER BY move_id DESC FETCH FIRST 12 ROWS ONLY`)).rows ?? []) as Row[]).map((r): LedgerRow => ({
        seq: Number(r.SEQ), moveId: Number(r.MOVE_ID), lotId: r.LOT_ID, facilityId: r.FACILITY_ID, skuId: r.SKU_ID, type: r.MOVE_TYPE, units: Number(r.UNITS),
        binId: r.BIN_ID ?? null, refId: r.REF_ID ?? null, at: r.RECORDED_UTC, hash: r.HASH ? String(r.HASH).slice(0, 32) : null,
      }));
      return { rows, recent };
    }, 'live');
    let verified: number | null = null, ok: boolean | null = null;
    const t0 = performance.now();
    if (kind === 'blockchain') {
      try {
        verified = await this.d.tx(null, async (c) => {
          const r = await c.execute(`DECLARE n NUMBER; BEGIN DBMS_BLOCKCHAIN_TABLE.VERIFY_ROWS(schema_name => USER, table_name => 'STOCK_LEDGER',
                                      low_timestamp => SYSTIMESTAMP - INTERVAL '2' HOUR, number_of_rows_verified => n); :n := n; END;`,
            { n: { dir: this.d.oracledb.BIND_OUT, type: this.d.oracledb.NUMBER } });
          return Number(r.outBinds.n ?? 0);
        }, 'live');
        ok = true;
      } catch (e) {
        ok = false;
        verified = null;
        base.recent.unshift({ seq: 0, moveId: 0, lotId: '', facilityId: '', skuId: '', type: 'VERIFY FAILED', units: 0, binId: null, refId: String((e as Error).message).split('\n')[0], at: new Date().toISOString(), hash: null });
      }
    }
    const ms = Math.round(performance.now() - t0);
    // try to change history: a blockchain table refuses, a plain table would allow it (rolled back here)
    const attempted = 'UPDATE stock_ledger SET units = units + 1 WHERE ROWNUM = 1';
    let error: string | null = null;
    try {
      await this.d.tx(null, async (c) => {
        await c.execute(attempted);
        throw new Error('__rollback__');
      }, 'live');
    } catch (e) {
      const m = String((e as Error).message).split('\n')[0];
      error = m === '__rollback__' ? null : m;
    }
    return { kind, rows: base.rows, verified, ok, ms, recent: base.recent, tamper: { attempted, error, blocked: !!error } };
  }

  async demand(fac: FacilityId, sku: string): Promise<{ history: Row[]; forecast: Row[]; fit: Row | null }> {
    return this.d.tx(null, async (c) => {
      const history = ((await c.execute(`SELECT TO_CHAR(demand_date, 'YYYY-MM-DD') AS d, units_out FROM sku_daily_demand WHERE facility_id = :fac AND sku_id = :sku AND demand_date > TRUNC(SYSDATE) - 57 ORDER BY demand_date`, { fac, sku })).rows ?? []) as Row[];
      const forecast = ((await c.execute(SQL.forecast, { fac, sku })).rows ?? []) as Row[];
      const fit = (((await c.execute(`SELECT REGR_SLOPE(units_out, demand_date - TRUNC(SYSDATE)) AS slope, REGR_R2(units_out, demand_date - TRUNC(SYSDATE)) AS r2
          FROM sku_daily_demand WHERE facility_id = :fac AND sku_id = :sku AND demand_date BETWEEN TRUNC(SYSDATE) - 56 AND TRUNC(SYSDATE) - 1`, { fac, sku })).rows ?? [])[0] ?? null) as Row | null;
      return { history, forecast, fit };
    }, 'live');
  }

  async replenishment(): Promise<ReplenishRow[]> {
    return this.d.tx(null, async (c) => (((await c.execute(SQL.replenish)).rows ?? []) as Row[]).map((r): ReplenishRow => ({
      facilityId: r.FACILITY_ID, skuId: r.SKU_ID, skuName: r.SKU_NAME, onHand: Number(r.ON_HAND), available: Number(r.AVAILABLE), dailyDemand: num(r.DAILY_DEMAND),
      dailySd: num(r.DAILY_SD), leadTimeDays: Number(r.LEAD_TIME_DAYS), safetyStock: num(r.SAFETY_STOCK), reorderPoint: num(r.REORDER_POINT), eoq: num(r.EOQ),
      daysOfCover: num(r.DAYS_OF_COVER), action: r.ACTION,
    })), 'live');
  }

  async scan(code: string, userId: number): Promise<Row> {
    return this.d.tx(userId, async (c) => {
      const r = await c.execute('BEGIN :r := wt_wms.scan(:code, :u); END;', { r: { dir: this.d.oracledb.BIND_OUT, type: this.d.oracledb.STRING, maxSize: 32767 }, code, u: userId });
      return JSON.parse(String(r.outBinds.r)) as Row;
    });
  }

  async shortestPath(from: string, to: string): Promise<{ metres: number | null; nodes: string[] }> {
    return this.d.tx(null, async (c) => {
      const r = await c.execute('BEGIN :r := wt_wms.shortest_path(:a, :b); END;', { r: { dir: this.d.oracledb.BIND_OUT, type: this.d.oracledb.STRING, maxSize: 32767 }, a: from, b: to });
      return JSON.parse(String(r.outBinds.r)) as { metres: number | null; nodes: string[] };
    }, 'live');
  }

  async graphQuery(dock: string): Promise<{ ok: boolean; rows: number; sample: string[]; error: string | null }> {
    try {
      return await this.d.tx(null, async (c) => {
        const r = (((await c.execute(SQL.graph, { dock })).rows ?? [])[0] ?? {}) as Row;
        return { ok: true, rows: Number(r.N ?? 0), sample: r.FIRST_NODE ? [String(r.FIRST_NODE)] : [], error: null };
      }, 'live');
    } catch (e) {
      return { ok: false, rows: 0, sample: [], error: String((e as Error).message).split('\n')[0] };
    }
  }

  // ---------------------------------------------------------------- semantic search
  async missingEmbeddings(model: string): Promise<{ table: 'DAMAGE_REPORTS' | 'SKU_HANDLING'; id: string; text: string }[]> {
    return this.d.tx(null, async (c) => {
      const a = ((await c.execute(`SELECT TO_CHAR(report_id) AS id, report_text AS text FROM damage_reports WHERE embed_model IS NULL OR embed_model <> :m`, { m: model })).rows ?? []) as Row[];
      const b = ((await c.execute(`SELECT sku_id AS id, description AS text FROM sku_handling WHERE embed_model IS NULL OR embed_model <> :m`, { m: model })).rows ?? []) as Row[];
      return [...a.map((r) => ({ table: 'DAMAGE_REPORTS' as const, id: String(r.ID), text: String(r.TEXT) })), ...b.map((r) => ({ table: 'SKU_HANDLING' as const, id: String(r.ID), text: String(r.TEXT) }))];
    }, 'live');
  }
  async saveEmbeddings(items: { table: 'DAMAGE_REPORTS' | 'SKU_HANDLING'; id: string; v: number[] }[], model: string, isVector: boolean): Promise<void> {
    if (!items.length) return;
    await this.d.tx(null, async (c) => {
      for (const it of items) {
        const key = it.table === 'DAMAGE_REPORTS' ? 'report_id = TO_NUMBER(:id)' : 'sku_id = :id';
        await c.execute(`UPDATE ${it.table} SET embedding = ${isVector ? 'TO_VECTOR(:v, 384, FLOAT32)' : ':v'}, embed_model = :m WHERE ${key}`, { v: vec(it.v), m: model, id: it.id });
      }
    }, 'live');
  }
  async search(q: number[]): Promise<SearchHit[]> {
    return this.d.tx(null, async (c) => (((await c.execute(SQL.search, { q: vec(q) })).rows ?? []) as Row[]).map((r): SearchHit => ({
      kind: String(r.KIND).trim() as 'DAMAGE' | 'PRODUCT', id: String(r.ID), title: String(r.KIND).trim() === 'DAMAGE' ? `Damage report #${r.ID}` : String(r.ID), text: String(r.DOC_TEXT), facilityId: r.FACILITY_ID ?? null,
      skuId: r.SKU_ID ?? null, score: Math.round((1 - Number(r.DISTANCE)) * 1000) / 1000, at: r.CREATED_UTC ?? null, severity: r.SEVERITY ?? null,
    })), 'live');
  }
  /** Before 23ai: embeddings stored as JSON text, compared in the server. */
  async allEmbeddings(): Promise<{ kind: 'DAMAGE' | 'PRODUCT'; id: string; text: string; facilityId: string | null; skuId: string | null; at: string | null; severity: string | null; v: number[] }[]> {
    return this.d.tx(null, async (c) => {
      const a = ((await c.execute(`SELECT TO_CHAR(report_id) AS id, report_text AS text, facility_id, sku_id, ${UTC('created_at')} AS created_utc, severity, embedding FROM damage_reports WHERE embedding IS NOT NULL`)).rows ?? []) as Row[];
      const b = ((await c.execute(`SELECT sku_id AS id, description AS text, sku_id, embedding FROM sku_handling WHERE embedding IS NOT NULL`)).rows ?? []) as Row[];
      return [
        ...a.map((r) => ({ kind: 'DAMAGE' as const, id: String(r.ID), text: String(r.TEXT), facilityId: r.FACILITY_ID, skuId: r.SKU_ID, at: r.CREATED_UTC ?? null, severity: r.SEVERITY, v: JSON.parse(String(r.EMBEDDING)) as number[] })),
        ...b.map((r) => ({ kind: 'PRODUCT' as const, id: String(r.ID), text: String(r.TEXT), facilityId: null, skuId: r.SKU_ID, at: null, severity: null, v: JSON.parse(String(r.EMBEDDING)) as number[] })),
      ];
    }, 'live');
  }
  async addDamage(d: { facilityId: string; skuId: string; severity: string; text: string; sscc: string | null; lotId: string | null; reportedBy: string }, userId: number): Promise<number> {
    return this.d.tx(userId, async (c) => {
      const r = await c.execute(`INSERT INTO damage_reports (facility_id, sku_id, lot_id, sscc, severity, report_text, reported_by) VALUES (:f, :s, :l, :c, :v, :t, :b) RETURNING report_id INTO :id`,
        { f: d.facilityId, s: d.skuId, l: d.lotId, c: d.sscc, v: d.severity, t: d.text.slice(0, 500), b: d.reportedBy.slice(0, 60), id: { dir: this.d.oracledb.BIND_OUT, type: this.d.oracledb.NUMBER } });
      return Number((r.outBinds.id as number[])[0]);
    });
  }
}
