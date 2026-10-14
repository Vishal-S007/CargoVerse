// Oracle side of the Database Lab: the DB_COMMANDS queue (live control from SQL),
// Flashback Query / Flashback Versions Query (time machine), the Virtual Private
// Database comparison (row-level security) and the concurrency lab, which runs two
// real database sessions against each other.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FacilityId } from '../../src/data/types';
import type {
  ExternalCommand, ExternalSqlResult, LabRun, LabScenario, LabStep, RowHistory, RowVersion, VpdAccount, VpdReport,
} from '../../src/api/types';
import type { TimeFrame } from '../../src/data/timeframe';
import { AppError, type SqlSource } from './repo';
import { checkDml, LAB_TITLES, VPD_TABLES, VPD_PROBE_TABLES, LAB_ACCOUNTS } from '../lab';

type Conn = any;
type Row = Record<string, any>;

export interface LabSession { c: Conn; raw: any; done(): Promise<void> }
export interface LabDeps {
  oracledb: any;
  owner: string;
  connectString: string;
  accountPassword: string;
  flashbackMaxS: number;
  tx<T>(userId: number | null, fn: (c: Conn) => Promise<T>, source?: SqlSource): Promise<T>;
  /** A pool connection identifying itself to Oracle with the given module name (not the server's). */
  session(module: string, userId: number | null): Promise<LabSession>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lc = (s: unknown) => String(s ?? '').toLowerCase();
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : d ? new Date(String(d)).toISOString() : null);
const oraMsg = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0];
const oraNum = (e: unknown) => Number((e as any)?.errorNum ?? 0);

function inList(prefix: string, values: string[]): { sql: string; binds: Record<string, string> } {
  const binds: Record<string, string> = {};
  const names = values.map((v, i) => { binds[`${prefix}${i}`] = v; return `:${prefix}${i}`; });
  return { sql: names.length ? names.join(', ') : 'NULL', binds };
}

/** Which table and columns hold the history of each selectable thing (Flashback Versions Query). */
const HISTORY: Record<string, { table: string; key: string; cols: string[] }> = {
  vessel: { table: 'VESSELS', key: 'VESSEL_ID', cols: ['VESSEL_STATUS', 'BERTH_CODE', 'ON_HOLD', 'IMPORT_BOXES', 'DISCHARGED', 'LOADED'] },
  berth: { table: 'PORT_BERTHS', key: 'BERTH_CODE', cols: ['IS_OPEN', 'VESSEL_ID'] },
  crane: { table: 'QUAY_CRANES', key: 'CRANE_ID', cols: ['CRANE_PHASE', 'MOVES_TODAY'] },
  truck: { table: 'TRUCKS', key: 'TRUCK_ID', cols: ['STATUS', 'DOCK_ID', 'CARGO_PALLETS', 'TRADE_LANE'] },
  forklift: { table: 'FORKLIFTS', key: 'FORKLIFT_ID', cols: ['TASK_STATE', 'BATTERY_PCT', 'TRUCK_ID', 'MOVES_TODAY'] },
  dock: { table: 'DOCKS', key: 'DOCK_ID', cols: ['TRUCK_ID', 'TRUCKS_TODAY'] },
  van: { table: 'DELIVERY_VANS', key: 'VAN_ID', cols: ['VAN_STATUS', 'ORDER_ID', 'STORE_ID', 'TRIPS_TODAY'] },
};
export const HISTORY_KINDS = Object.keys(HISTORY);

/** Oracle errors that mean "Flashback cannot reach that far back". */
function flashbackError(e: unknown): AppError | null {
  switch (oraNum(e)) {
    case 8180: case 8181: return new AppError(409, 'Oracle has no undo data from that far back yet (ORA-08180). Pick a more recent moment.');
    case 1555: return new AppError(409, 'The undo data for that moment has been overwritten (ORA-01555 snapshot too old). Pick a more recent moment.');
    case 1466: return new AppError(409, 'The tables were recreated after that moment (ORA-01466), so Oracle cannot show it. Pick a later moment.');
    default: return null;
  }
}

export class OracleLab {
  private installed: { at: number; control: boolean; concurrency: boolean; vpd: { installed: boolean; accounts: string[]; tables: string[]; reason: string | null } } | null = null;
  private labBusy = false;
  private vpdCache: { at: number; report: VpdReport } | null = null;

  constructor(private d: LabDeps) {}

  // ---------------------------------------------------------------- what is installed
  async info() {
    if (this.installed && Date.now() - this.installed.at < 30000) return this.installed;
    const r = (await this.d.tx(null, async (c) => (await c.execute(`
      SELECT (SELECT COUNT(*) FROM user_tables WHERE table_name IN ('DB_COMMANDS', 'DOCK_BOOKINGS', 'LAB_STOCK')) AS lab_tables,
             (SELECT COUNT(*) FROM user_triggers WHERE trigger_name LIKE 'TRG\\_EXT\\_%' ESCAPE '\\' AND status = 'ENABLED') AS ext_triggers,
             (SELECT LISTAGG(object_name, ',') WITHIN GROUP (ORDER BY object_name) FROM user_policies WHERE policy_name = 'CV_SITE_ROWS') AS policies,
             (SELECT LISTAGG(username, ',') WITHIN GROUP (ORDER BY username) FROM all_users
               WHERE username IN ('CV_ADMIN', 'CV_ALEX', 'CV_MEERA', 'CV_ZOE')) AS accounts
        FROM dual`)).rows ?? [], 'live'))[0] as Row;
    const tables = String(r.POLICIES ?? '').split(',').filter(Boolean);
    const accounts = String(r.ACCOUNTS ?? '').split(',').filter(Boolean);
    const vpdOk = tables.length > 0 && accounts.length === LAB_ACCOUNTS.length;
    this.installed = {
      at: Date.now(),
      control: num(r.LAB_TABLES) === 3 && num(r.EXT_TRIGGERS) >= 7,
      concurrency: num(r.LAB_TABLES) === 3,
      vpd: {
        installed: vpdOk, accounts, tables,
        reason: vpdOk ? null : accounts.length < LAB_ACCOUNTS.length
          ? 'The demo database accounts are missing: run db/oracle/07_security_sys.sql as SYS, then npm run db:lab'
          : 'No row-level security policies: the schema owner needs EXECUTE on DBMS_RLS (07_security_sys.sql), then npm run db:lab',
      },
    };
    return this.installed;
  }

  // ---------------------------------------------------------------- 1. live control from SQL
  async poll(): Promise<ExternalCommand[]> {
    if (!(await this.info()).control) return [];
    const rows = await this.d.tx(null, async (c) => (await c.execute(`
      SELECT cmd_id, table_name, row_key, column_name, old_value, new_value, db_user, client_program, client_host, created_at
        FROM db_commands WHERE cmd_status = 'PENDING' ORDER BY cmd_id FETCH FIRST 50 ROWS ONLY`)).rows ?? [], 'live') as Row[];
    return rows.map((r) => ({
      id: num(r.CMD_ID), table: r.TABLE_NAME, key: r.ROW_KEY, column: r.COLUMN_NAME, oldValue: r.OLD_VALUE ?? null, newValue: r.NEW_VALUE ?? null,
      dbUser: r.DB_USER, program: r.CLIENT_PROGRAM ?? null, host: r.CLIENT_HOST ?? null, at: iso(r.CREATED_AT) ?? new Date().toISOString(),
    }));
  }

  async ack(results: { id: number; status: 'APPLIED' | 'REJECTED'; message: string }[]): Promise<void> {
    if (!results.length) return;
    await this.d.tx(null, async (c) => {
      for (const x of results) {
        await c.execute(`UPDATE db_commands SET cmd_status = :s, result_msg = :m, applied_at = SYSTIMESTAMP WHERE cmd_id = :id`,
          { s: x.status, m: x.message.slice(0, 300), id: x.id });
      }
    }, 'live');
  }

  async runExternalSql(userId: number, input: string): Promise<ExternalSqlResult> {
    let sql: string;
    try { sql = checkDml(input); } catch (e) { throw new AppError(400, (e as Error).message); }
    const t0 = performance.now();
    const s = await this.d.session('CargoVerse SQL Lab', userId);
    let rows = 0;
    try {
      s.raw.callTimeout = 15000;
      const r = await s.c.execute(sql);
      rows = r.rowsAffected ?? 0;
      await s.raw.commit();
    } catch (e) {
      try { await s.raw.rollback(); } catch { /* ignore */ }
      throw new AppError(400, oraMsg(e));
    } finally {
      await s.done();
    }
    const ms = Math.round(performance.now() - t0);
    const queued = await this.d.tx(userId, async (c) => {
      await c.execute(`BEGIN wt_core.log_audit('SQL_DML', 'DATABASE', NULL, NULL, :d); END;`, { d: `${rows} rows · ${sql.replace(/\s+/g, ' ').slice(0, 1800)}` });
      const q = await c.execute(`SELECT COUNT(*) AS n FROM db_commands WHERE cmd_status = 'PENDING'`);
      return num((q.rows?.[0] as Row)?.N);
    });
    return { statement: sql, rowsAffected: rows, ms, queued, source: 'oracle' };
  }

  // ---------------------------------------------------------------- 2. time machine
  async flashback(secondsAgo: number, facilities: FacilityId[]): Promise<TimeFrame> {
    const ago = Math.max(1, Math.min(this.d.flashbackMaxS, Math.round(secondsAgo)));
    const fac = inList('f', facilities);
    const sql: string[] = [];
    const rows: Record<string, number> = {};
    try {
      return await this.d.tx(null, async (c) => {
        const head = (await c.execute(`SELECT TIMESTAMP_TO_SCN(SYSTIMESTAMP - NUMTODSINTERVAL(:s, 'SECOND')) AS scn,
                                              SYSTIMESTAMP - NUMTODSINTERVAL(:s, 'SECOND') AS at FROM dual`, { s: ago })).rows?.[0] as Row;
        const scn = num(head.SCN);
        sql.push(`SELECT TIMESTAMP_TO_SCN(SYSTIMESTAMP - INTERVAL '${ago}' SECOND) FROM dual  →  SCN ${scn}`);
        const q = async (name: string, text: string, binds: Record<string, unknown> = {}) => {
          const r = (await c.execute(text, { scn, ...binds })).rows ?? [];
          rows[name] = r.length;
          sql.push(text.replace(/\s+/g, ' ').trim());
          return r as Row[];
        };
        const st = (await q('SIM_STATE', 'SELECT sim_time_s, real_time_s FROM sim_state AS OF SCN :scn WHERE state_id = 1'))[0] ?? {};
        const f: TimeFrame = {
          source: 'flashback', at: iso(head.AT) ?? new Date(Date.now() - ago * 1000).toISOString(), secondsAgo: ago, scn,
          simTime: num(st.SIM_TIME_S), realTime: num(st.REAL_TIME_S),
          trucks: {}, forklifts: {}, pallets: {}, docks: {}, vessels: {}, berths: {}, cranes: {}, importStack: [], exportStack: [],
          storeLines: {}, vans: {}, orders: {}, rows, sql,
        };
        for (const r of await q('TRUCKS', `SELECT truck_id, status, dock_id, cargo_pallets, current_shipment_id, sku_id, forklift_id, leg_idx, leg_dist,
                                                  pos_x, pos_z, heading, speed, away_remaining_s, trade_lane
                                             FROM trucks AS OF SCN :scn WHERE facility_id IN (${fac.sql})`, fac.binds)) {
          f.trucks[r.TRUCK_ID] = {
            phase: lc(r.STATUS) as any, dockId: r.DOCK_ID ?? null, cargo: num(r.CARGO_PALLETS), shipmentId: r.CURRENT_SHIPMENT_ID ?? '', skuId: r.SKU_ID,
            forkliftId: r.FORKLIFT_ID ?? null, legIdx: num(r.LEG_IDX), legDist: num(r.LEG_DIST), x: num(r.POS_X), z: num(r.POS_Z), heading: num(r.HEADING),
            speed: num(r.SPEED), away: num(r.AWAY_REMAINING_S), lane: r.TRADE_LANE === 'SEA' ? 'SEA' : 'ROAD',
          };
        }
        for (const r of await q('FORKLIFTS', `SELECT forklift_id, battery_pct, task_state, truck_id, pallet_id, moves_today, pos_x, pos_z, heading, timer_s,
                                                     pick_json, drop_json
                                                FROM forklifts AS OF SCN :scn WHERE facility_id IN (${fac.sql})`, fac.binds)) {
          f.forklifts[r.FORKLIFT_ID] = {
            battery: num(r.BATTERY_PCT), task: lc(r.TASK_STATE) as any, truckId: r.TRUCK_ID ?? null, palletId: r.PALLET_ID ?? null, moves: num(r.MOVES_TODAY),
            x: num(r.POS_X), z: num(r.POS_Z), heading: num(r.HEADING), timer: num(r.TIMER_S),
            pick: r.PICK_JSON ? JSON.parse(r.PICK_JSON) : null, drop: r.DROP_JSON ? JSON.parse(r.DROP_JSON) : null,
          };
        }
        for (const r of await q('PALLETS', `SELECT pallet_id, facility_id, sku_id, qty, weight_kg, lot_no, received_label, yard_slot, forklift_id, is_featured, is_reserved
                                              FROM pallets AS OF SCN :scn WHERE facility_id IN (${fac.sql})`, fac.binds)) {
          f.pallets[r.PALLET_ID] = {
            facilityId: r.FACILITY_ID, skuId: r.SKU_ID, qty: num(r.QTY), weightKg: num(r.WEIGHT_KG), lot: r.LOT_NO, received: r.RECEIVED_LABEL,
            slot: r.YARD_SLOT === null || r.YARD_SLOT === undefined ? null : num(r.YARD_SLOT), forkliftId: r.FORKLIFT_ID ?? null,
            featured: r.IS_FEATURED === 'Y', reserved: r.IS_RESERVED === 'Y',
          };
        }
        for (const r of await q('DOCKS', `SELECT dock_id, truck_id, trucks_today FROM docks AS OF SCN :scn WHERE facility_id IN (${fac.sql})`, fac.binds)) {
          f.docks[r.DOCK_ID] = { truckId: r.TRUCK_ID ?? null, trucksToday: num(r.TRUCKS_TODAY) };
        }
        for (const r of await q('VESSELS', `SELECT vessel_id, vessel_status, berth_code, on_hold, import_boxes, export_boxes, discharged, loaded,
                                                   leg_dist, timer_s, waited_s, pos_x, pos_z, heading
                                              FROM vessels AS OF SCN :scn`)) {
          f.vessels[r.VESSEL_ID] = {
            status: r.VESSEL_STATUS, berthId: r.BERTH_CODE ?? null, hold: r.ON_HOLD === 'Y', importBoxes: num(r.IMPORT_BOXES), exportBoxes: num(r.EXPORT_BOXES),
            discharged: num(r.DISCHARGED), loaded: num(r.LOADED), dist: num(r.LEG_DIST), timer: num(r.TIMER_S), waited: num(r.WAITED_S),
            x: num(r.POS_X), z: num(r.POS_Z), heading: num(r.HEADING),
          };
        }
        for (const r of await q('PORT_BERTHS', 'SELECT berth_code, is_open, vessel_id FROM port_berths AS OF SCN :scn')) {
          f.berths[r.BERTH_CODE] = { open: r.IS_OPEN === 'Y', vesselId: r.VESSEL_ID ?? null };
        }
        for (const r of await q('QUAY_CRANES', 'SELECT crane_id, crane_phase, cycle_pct, moves_today FROM quay_cranes AS OF SCN :scn')) {
          f.cranes[r.CRANE_ID] = { phase: lc(r.CRANE_PHASE) as any, cycle: num(r.CYCLE_PCT), moves: num(r.MOVES_TODAY) };
        }
        for (const r of await q('YARD_CONTAINERS', 'SELECT container_no, block_code FROM yard_containers AS OF SCN :scn ORDER BY arrived_move_id')) {
          (r.BLOCK_CODE === 'IMPORT' ? f.importStack : f.exportStack).push(r.CONTAINER_NO);
        }
        for (const r of await q('STORE_STOCK', 'SELECT store_id, sku_id, units, sold_today FROM store_stock AS OF SCN :scn')) {
          f.storeLines[`${r.STORE_ID}:${r.SKU_ID}`] = { units: num(r.UNITS), soldToday: num(r.SOLD_TODAY) };
        }
        for (const r of await q('DELIVERY_VANS', `SELECT van_id, van_status, order_id, store_id, leg_dist, timer_s, pos_x, pos_z, heading
                                                    FROM delivery_vans AS OF SCN :scn`)) {
          f.vans[r.VAN_ID] = {
            status: r.VAN_STATUS, orderId: r.ORDER_ID ?? null, storeId: r.STORE_ID ?? null, dist: num(r.LEG_DIST), timer: num(r.TIMER_S),
            x: num(r.POS_X), z: num(r.POS_Z), heading: num(r.HEADING),
          };
        }
        for (const r of await q('STORE_ORDERS', `SELECT order_id, order_status, units, van_id FROM store_orders AS OF SCN :scn
                                                   WHERE order_status IN ('PLACED', 'LOADING', 'OUT_FOR_DELIVERY')
                                                      OR placed_at > SYSTIMESTAMP - NUMTODSINTERVAL(:win, 'SECOND')`, { win: ago + 1800 })) {
          f.orders[r.ORDER_ID] = { status: r.ORDER_STATUS, units: num(r.UNITS), vanId: r.VAN_ID ?? null };
        }
        return f;
      }, 'live');
    } catch (e) {
      throw flashbackError(e) ?? e;
    }
  }

  async rowHistory(kind: string, id: string, seconds: number): Promise<RowHistory> {
    const h = HISTORY[kind];
    if (!h) throw new AppError(404, `No row history for ${kind}`);
    const win = Math.max(10, Math.min(this.d.flashbackMaxS, Math.round(seconds)));
    const text = `SELECT versions_starttime AS vs, versions_endtime AS ve, versions_operation AS op, ${h.cols.join(', ')}
  FROM ${h.table.toLowerCase()} VERSIONS BETWEEN TIMESTAMP SYSTIMESTAMP - INTERVAL '${win}' SECOND AND SYSTIMESTAMP
 WHERE ${h.key.toLowerCase()} = :id
 ORDER BY versions_startscn NULLS FIRST, versions_endscn NULLS LAST`;
    let raw: Row[];
    try {
      raw = await this.d.tx(null, async (c) => (await c.execute(text, { id })).rows ?? [], 'live') as Row[];
    } catch (e) {
      throw flashbackError(e) ?? new AppError(400, oraMsg(e));
    }
    const norm = (col: string, v: unknown) => (v === null || v === undefined ? null : col === 'BATTERY_PCT' ? Math.round(Number(v)) : typeof v === 'number' ? v : String(v));
    const entries: RowVersion[] = [];
    for (const r of raw) {
      const values = Object.fromEntries(h.cols.map((col) => [col, norm(col, r[col])]));
      const last = entries[entries.length - 1];
      if (last && JSON.stringify(last.values) === JSON.stringify(values)) {
        last.to = iso(r.VE);
        last.versions++;
        continue;
      }
      entries.push({ from: iso(r.VS), to: iso(r.VE), op: (r.OP ?? null) as RowVersion['op'], values, versions: 1 });
    }
    return { kind, id, table: h.table, columns: h.cols, source: 'flashback', sql: text, entries: entries.slice(-60) };
  }

  // ---------------------------------------------------------------- 3. row-level security
  async vpdReport(): Promise<VpdReport> {
    if (this.vpdCache && Date.now() - this.vpdCache.at < 4000) return this.vpdCache.report;
    const owner = this.d.owner.toUpperCase();
    const counts = VPD_PROBE_TABLES.map((t) => `(SELECT COUNT(*) FROM ${owner}.${t}) AS ${t}`).join(',\n       ');
    const probe = `SELECT ${counts},\n       (SELECT LISTAGG(facility_id, ',') WITHIN GROUP (ORDER BY facility_id)\n          FROM (SELECT DISTINCT facility_id FROM ${owner}.TRUCKS)) AS SITES\n  FROM dual`;
    const read = (r: Row) => Object.fromEntries(VPD_PROBE_TABLES.map((t) => [t, num(r[t])]));
    const base = await this.d.tx(null, async (c) => {
      const o = ((await c.execute(probe)).rows ?? [])[0] as Row;
      const users = ((await c.execute(`SELECT u.username, u.role_code,
                                              (SELECT LISTAGG(a.facility_id, ',') WITHIN GROUP (ORDER BY a.facility_id)
                                                 FROM user_facility_access a WHERE a.user_id = u.user_id) AS sites
                                         FROM app_users u`)).rows ?? []) as Row[];
      const preds: Record<string, string | null> = {};
      for (const a of LAB_ACCOUNTS) {
        try { preds[a.account] = (((await c.execute('SELECT wt_security.predicate_for(:u) AS p FROM dual', { u: a.account })).rows ?? [])[0] as Row)?.P ?? null; }
        catch { preds[a.account] = '(WT_SECURITY not installed)'; }
      }
      return { owner: read(o), users, preds };
    }, 'live');
    const accounts: VpdAccount[] = [];
    for (const a of LAB_ACCOUNTS) {
      const u = base.users.find((x) => x.USERNAME === a.username);
      const t0 = performance.now();
      const entry: VpdAccount = {
        account: a.account, appUser: a.username, role: u?.ROLE_CODE ?? '—', sites: String(u?.SITES ?? '').split(',').filter(Boolean),
        predicate: base.preds[a.account] ?? null, counts: {}, sitesSeen: [], ms: 0,
      };
      let conn: any = null;
      try {
        conn = await this.d.oracledb.getConnection({ user: a.account, password: this.d.accountPassword, connectString: this.d.connectString });
        conn.module = 'CargoVerse VPD check';
        conn.callTimeout = 10000;
        const r = ((await conn.execute(probe, {}, { outFormat: this.d.oracledb.OUT_FORMAT_OBJECT })).rows ?? [])[0] as Row;
        entry.counts = read(r);
        entry.sitesSeen = String(r.SITES ?? '').split(',').filter(Boolean);
      } catch (e) {
        entry.error = oraNum(e) === 1017 ? `Cannot sign in as ${a.account} (ORA-01017): run npm run db:lab` : oraMsg(e);
      } finally {
        if (conn) { try { await conn.close(); } catch { /* ignore */ } }
      }
      entry.ms = Math.round(performance.now() - t0);
      accounts.push(entry);
    }
    const report: VpdReport = { source: 'oracle', tables: VPD_TABLES, owner: base.owner, accounts, at: new Date().toISOString(), sql: probe };
    this.vpdCache = { at: Date.now(), report };
    return report;
  }

  // ---------------------------------------------------------------- 4. concurrency lab (two real sessions)
  async runLab(userId: number, scenario: LabScenario): Promise<LabRun> {
    if (!(await this.info()).concurrency) throw new AppError(409, 'The concurrency lab is not installed: run npm run db:lab');
    if (this.labBusy) throw new AppError(409, 'Another experiment is running — try again in a few seconds');
    this.labBusy = true;
    const steps: LabStep[] = [];
    let t0 = performance.now();
    const now = () => Math.round(performance.now() - t0);
    const add = (session: LabStep['session'], kind: LabStep['kind'], text: string, sql?: string, at?: number) => {
      const st: LabStep = { session, t: at ?? now(), kind, text, sql };
      steps.push(st);
      return st;
    };
    let A: LabSession | null = null;
    let B: LabSession | null = null;
    try {
      await this.d.tx(userId, (c) => c.execute('BEGIN wt_lab.reset_lab; END;'));
      A = await this.d.session('CargoVerse Lab · session A', userId);
      B = await this.d.session('CargoVerse Lab · session B', userId);
      A.raw.callTimeout = 25000;
      B.raw.callTimeout = 25000;
      t0 = performance.now();
      let run: Omit<LabRun, 'steps' | 'ms' | 'scenario' | 'title' | 'source'>;
      switch (scenario) {
        case 'double_booking': run = await this.doubleBooking(A, B, add, now); break;
        case 'lost_update': run = await this.lostUpdate(A, B, add, now, false); break;
        case 'safe_update': run = await this.lostUpdate(A, B, add, now, true); break;
        case 'deadlock': run = await this.deadlock(A, B, add, now); break;
        default: throw new AppError(400, 'Unknown experiment');
      }
      steps.sort((x, y) => x.t - y.t);
      return { scenario, title: LAB_TITLES[scenario], source: 'oracle', steps, ms: now(), ...run };
    } finally {
      for (const s of [A, B]) {
        if (!s) continue;
        try { await s.raw.rollback(); } catch { /* ignore */ }
        await s.done();
      }
      this.labBusy = false;
    }
  }

  private async doubleBooking(A: LabSession, B: LabSession, add: (s: LabStep['session'], k: LabStep['kind'], t: string, sql?: string, at?: number) => LabStep, now: () => number) {
    const { oracledb } = this.d;
    const dock = ((await A.c.execute(`SELECT dock_id FROM docks WHERE facility_id = 'WH-01' ORDER BY dock_id FETCH FIRST 1 ROWS ONLY`)).rows?.[0] as Row)?.DOCK_ID;
    const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1);
    const slot = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`;
    const call = 'BEGIN :id := wt_lab.book_dock(:dock, TO_DATE(:slot, \'YYYY-MM-DD HH24:MI\'), :truck, :who, :hold, \'LAB\'); END;';
    const shown = (truck: string, who: string, hold: number) =>
      `BEGIN :id := wt_lab.book_dock('${dock}', TO_DATE('${slot}', 'YYYY-MM-DD HH24:MI'), '${truck}', '${who}', ${hold}); END;`;
    const out = { dir: oracledb.BIND_OUT, type: oracledb.NUMBER };
    add('A', 'sql', `Session A books dock ${dock} for ${slot.slice(11)} and keeps its transaction open for 2.5 s`, shown('TRK-2051', 'Session A', 2.5));
    const pA = A.c.execute(call, { id: out, dock, slot, truck: 'TRK-2051', who: 'Session A', hold: 2.5 });
    await sleep(400);
    const bStart = now();
    add('B', 'sql', 'Session B books the same dock and slot', shown('TRK-2287', 'Session B', 0), bStart);
    const pB = B.c.execute(call, { id: out, dock, slot, truck: 'TRK-2287', who: 'Session B', hold: 0 }).then(
      (r: any) => ({ ok: true as const, id: r.outBinds?.id, at: now() }), (e: unknown) => ({ ok: false as const, e, at: now() }));
    const rA = await pA;
    add('A', 'ok', `Booking #${rA.outBinds?.id} created — the dock row is still locked`);
    await A.raw.commit();
    const aCommit = now();
    add('A', 'commit', 'COMMIT — the lock is released', undefined, aCommit);
    const rB = await pB;
    const waited = rB.at - bStart;
    if (waited > 250) add('B', 'wait', `Waited ${(waited / 1000).toFixed(1)} s for session A's lock on dock ${dock} (SELECT … FOR UPDATE)`, undefined, bStart + 2).end = Math.min(rB.at, aCommit + 5);
    let verdict: LabRun['verdict'];
    let outcome: string;
    if (rB.ok) {
      add('B', 'ok', `Booking #${rB.id} created`, undefined, rB.at);
      await B.raw.commit();
      add('B', 'commit', 'COMMIT');
      verdict = 'anomaly';
      outcome = 'Both sessions booked the slot — this should be impossible.';
    } else {
      add('B', 'error', oraMsg(rB.e), undefined, rB.at);
      await B.raw.rollback();
      add('B', 'rollback', 'ROLLBACK');
      verdict = 'protected';
      outcome = `Session B had to wait ${(waited / 1000).toFixed(1)} s for session A, then saw A's booking and was refused. One booking exists, never two.`;
    }
    const rows = ((await A.c.execute(`SELECT truck_id, booked_by FROM dock_bookings WHERE dock_id = :dock AND slot_start = TO_DATE(:slot, 'YYYY-MM-DD HH24:MI')`,
      { dock, slot })).rows ?? []) as Row[];
    return {
      verdict, outcome,
      final: [
        { label: 'Bookings for this slot', value: `${rows.length} (${rows.map((r) => r.TRUCK_ID).join(', ') || 'none'})` },
        { label: 'Session B waited', value: `${(waited / 1000).toFixed(1)} s` },
        { label: 'Dock / slot', value: `${dock} · ${slot}` },
      ],
    };
  }

  private async lostUpdate(A: LabSession, B: LabSession, add: (s: LabStep['session'], k: LabStep['kind'], t: string, sql?: string, at?: number) => LabStep, now: () => number, safe: boolean) {
    const sel = `SELECT units FROM lab_stock WHERE item_id = 'LAB-A'${safe ? ' FOR UPDATE' : ''}`;
    const upd = 'UPDATE lab_stock SET units = :v, updated_by = :who, updated_at = SYSTIMESTAMP WHERE item_id = \'LAB-A\'';
    const shownUpd = (v: number) => `UPDATE lab_stock SET units = ${v} WHERE item_id = 'LAB-A'`;
    add('A', 'sql', safe ? 'A reads the stock and locks the row' : 'A reads the stock', sel);
    const a0 = num(((await A.c.execute(sel)).rows?.[0] as Row)?.UNITS);
    add('A', 'ok', `units = ${a0}${safe ? ' (row locked)' : ''}`);
    await sleep(100);
    const bStart = now();
    add('B', 'sql', safe ? 'B wants the same row' : 'B reads the stock', sel, bStart);
    const pB = B.c.execute(sel).then((r: any) => ({ v: num((r.rows?.[0] as Row)?.UNITS), at: now() }));
    let b0: { v: number; at: number } | null = null;
    if (!safe) {
      const r = await pB;
      b0 = r;
      add('B', 'ok', `units = ${r.v}`, undefined, r.at);
    }
    await sleep(Math.max(0, 700 - now()));
    add('A', 'sql', `A sold 10, writes back ${a0} − 10`, shownUpd(a0 - 10));
    await A.c.execute(upd, { v: a0 - 10, who: 'Session A' });
    await A.raw.commit();
    const aCommit = now();
    add('A', 'commit', safe ? 'COMMIT — lock released' : 'COMMIT', undefined, aCommit);
    if (safe) {
      const r = await pB;
      b0 = r;
      if (r.at - bStart > 250) add('B', 'wait', `Waited ${((r.at - bStart) / 1000).toFixed(1)} s for session A's row lock`, undefined, bStart + 2).end = r.at;
      add('B', 'ok', `units = ${r.v} (A's committed value)`, undefined, r.at);
    }
    await sleep(Math.max(0, 1000 - now()));
    const bv = b0!.v;
    add('B', 'sql', `B sold 15, writes back ${bv} − 15`, shownUpd(bv - 15));
    await B.c.execute(upd, { v: bv - 15, who: 'Session B' });
    await B.raw.commit();
    add('B', 'commit', 'COMMIT');
    const final = num(((await A.c.execute(`SELECT units FROM lab_stock WHERE item_id = 'LAB-A'`)).rows?.[0] as Row)?.UNITS);
    const lost = 75 - final;
    return {
      verdict: (final === 75 ? 'protected' : 'anomaly') as LabRun['verdict'],
      outcome: final === 75
        ? `Session B waited for A, then read ${bv} and wrote ${final}. Both sales count.`
        : `Both sales were committed, but the stock shows ${final} instead of 75: session A's sale of ${Math.abs(lost)} was silently lost.`,
      final: [
        { label: 'Final stock', value: String(final) },
        { label: 'Correct stock', value: '75' },
        safe ? { label: 'Session B waited', value: `${(((b0!.at) - bStart) / 1000).toFixed(1)} s` } : { label: 'Units lost', value: String(Math.abs(lost)) },
      ],
    };
  }

  private async deadlock(A: LabSession, B: LabSession, add: (s: LabStep['session'], k: LabStep['kind'], t: string, sql?: string, at?: number) => LabStep, now: () => number) {
    const upd = (item: string) => `UPDATE lab_stock SET units = units - 1, updated_at = SYSTIMESTAMP WHERE item_id = '${item}'`;
    add('A', 'sql', 'A updates LAB-A (and holds its row lock)', upd('LAB-A'));
    await A.c.execute(upd('LAB-A'));
    await sleep(100);
    add('B', 'sql', 'B updates LAB-B (and holds its row lock)', upd('LAB-B'));
    await B.c.execute(upd('LAB-B'));
    await sleep(Math.max(0, 300 - now()));
    const aStart = now();
    add('A', 'sql', 'A now needs LAB-B, which B holds', upd('LAB-B'), aStart);
    const pA = A.c.execute(upd('LAB-B')).then(() => ({ s: 'A' as const, ok: true, at: now(), e: null as unknown }), (e: unknown) => ({ s: 'A' as const, ok: false, at: now(), e }));
    await sleep(Math.max(0, 600 - now()));
    const bStart = now();
    add('B', 'sql', 'B now needs LAB-A, which A holds: a cycle', upd('LAB-A'), bStart);
    const pB = B.c.execute(upd('LAB-A')).then(() => ({ s: 'B' as const, ok: true, at: now(), e: null as unknown }), (e: unknown) => ({ s: 'B' as const, ok: false, at: now(), e }));
    const first = await Promise.race([pA, pB]);
    const victim = first.s === 'A' ? A : B;
    const winner = first.s === 'A' ? B : A;
    const winnerName = first.s === 'A' ? 'B' : 'A';
    const winnerStart = first.s === 'A' ? bStart : aStart;
    const victimStart = first.s === 'A' ? aStart : bStart;
    add(first.s, 'wait', `Waiting for session ${winnerName}`, undefined, victimStart + 2).end = first.at;
    if (first.ok) {
      // no deadlock reported (should not happen): finish both
      await victim.raw.commit();
      add(first.s, 'commit', 'COMMIT');
    } else {
      add('DB', 'info', `Oracle detected the deadlock after ${((first.at - Math.max(aStart, bStart)) / 1000).toFixed(1)} s and chose session ${first.s} as the victim`, undefined, first.at);
      add(first.s, 'error', oraMsg(first.e), undefined, first.at);
      await victim.raw.rollback();
      add(first.s, 'rollback', `ROLLBACK — session ${first.s} gives its locks back`);
    }
    const second = await (first.s === 'A' ? pB : pA);
    add(winnerName as 'A' | 'B', 'wait', `Waiting for session ${first.s}`, undefined, winnerStart + 2).end = second.at;
    if (second.ok) {
      add(winnerName as 'A' | 'B', 'ok', 'Got the row and continued', undefined, second.at);
      await winner.raw.commit();
      add(winnerName as 'A' | 'B', 'commit', 'COMMIT');
    } else {
      add(winnerName as 'A' | 'B', 'error', oraMsg(second.e), undefined, second.at);
      await winner.raw.rollback();
    }
    const rows = ((await A.c.execute('SELECT item_id, units FROM lab_stock ORDER BY item_id')).rows ?? []) as Row[];
    return {
      verdict: (first.ok ? 'anomaly' : 'detected') as LabRun['verdict'],
      outcome: first.ok
        ? 'Oracle did not report a deadlock.'
        : `Oracle found the cycle by itself, rolled back the waiting statement of session ${first.s} (ORA-00060) and let session ${winnerName} finish. No session waits forever.`,
      final: [...rows.map((r) => ({ label: String(r.ITEM_ID), value: String(r.UNITS) })), { label: 'Victim', value: `Session ${first.s}` }],
    };
  }
}
