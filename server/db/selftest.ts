// Database Lab self-test: checks the four Oracle features against the real database.
//   npm run db:selftest
// Safe to run while `npm run dev` is running; every change it makes is put back.
import { config } from '../config';
import { OracleRepo } from './oracle';
import { WmsEngine } from '../wms/engine';
import { OracleWms } from '../wms/oracle-wms';
import { sscc, siteStorage, shortestPath } from '../../src/data/wms';
import type { FacilityId } from '../../src/data/types';
import type { LabScenario } from '../../src/api/types';

type Result = { name: string; ok: boolean; detail: string; ms: number; skipped?: boolean };
class Skip extends Error {}
const results: Result[] = [];
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, ms: Date.now() - t0 });
    console.log(`  ${green('PASS')}  ${name}  ${dim(detail)}`);
  } catch (e) {
    const detail = String((e as Error).message ?? e).split('\n')[0];
    if (e instanceof Skip) {
      results.push({ name, ok: true, skipped: true, detail, ms: Date.now() - t0 });
      console.log(`  ${yellow('SKIP')}  ${name}  ${dim(detail)}`);
      return;
    }
    results.push({ name, ok: false, detail, ms: Date.now() - t0 });
    console.log(`  ${red('FAIL')}  ${name}  ${detail}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

async function main(): Promise<void> {
  let oracledb: any;
  const pkg = 'oracledb';
  try { const m = await import(pkg); oracledb = m.default ?? m; } catch { console.error('Install dependencies first: npm install'); process.exit(1); }
  oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

  console.log(`CargoVerse Database Lab self-test · ${config.oracle.connectString} as ${config.oracle.user}\n`);
  let ext: any;
  try {
    ext = await oracledb.getConnection(config.oracle);
  } catch (e) {
    console.error(red(`Cannot connect: ${(e as Error).message}`));
    console.error('Start the database first (npm run db:up) and check .env.');
    process.exit(1);
  }
  // This connection plays "SQL Developer": a different module than the CargoVerse server.
  ext.module = 'CargoVerse selftest';
  ext.action = 'external client';
  const q = async (sql: string, binds: Record<string, unknown> = {}) => (await ext.execute(sql, binds)).rows ?? [];
  const one = async (sql: string, binds: Record<string, unknown> = {}) => (await q(sql, binds))[0] as Record<string, any> | undefined;

  const repo = new OracleRepo(config.oracle);
  await repo.init();

  // ---------------------------------------------------------------------------
  console.log('Installation');
  await check('lab objects exist and are valid', async () => {
    const need = ['DB_COMMANDS', 'DOCK_BOOKINGS', 'LAB_STOCK', 'WT_LAB', 'TRG_EXT_PORT_BERTHS', 'TRG_EXT_VESSELS', 'TRG_EXT_STORE_STOCK',
      'TRG_EXT_FORKLIFTS', 'TRG_EXT_SIM_STATE', 'TRG_EXT_PARK_BUILDINGS', 'TRG_EXT_TASKS', 'TRG_PORT_BERTHS_ONE_OPEN'];
    const rows = await q(`SELECT object_name, MIN(status) AS status FROM user_objects WHERE object_name IN (${need.map((n) => `'${n}'`).join(', ')}) GROUP BY object_name`);
    const found = new Map(rows.map((r: any) => [r.OBJECT_NAME, r.STATUS]));
    const missing = need.filter((n) => !found.has(n));
    assert(!missing.length, `missing: ${missing.join(', ')} — run npm run db:lab`);
    const invalid = need.filter((n) => found.get(n) !== 'VALID');
    assert(!invalid.length, `invalid: ${invalid.join(', ')}`);
    return `${need.length} objects VALID`;
  });

  // ---------------------------------------------------------------------------
  console.log('\n1 · Control the city from SQL');
  const fl = await one(`SELECT forklift_id, battery_pct FROM forklifts ORDER BY forklift_id FETCH FIRST 1 ROW ONLY`);
  await check('an outside UPDATE is queued in DB_COMMANDS', async () => {
    assert(fl, 'no forklifts in the database');
    const before = Number((await one('SELECT NVL(MAX(cmd_id), 0) AS m FROM db_commands'))!.M);
    const target = Number(fl.BATTERY_PCT) > 50 ? 40 : 80;
    await ext.execute('UPDATE forklifts SET battery_pct = :b WHERE forklift_id = :id', { b: target, id: fl.FORKLIFT_ID });
    await ext.execute('UPDATE forklifts SET battery_pct = :b WHERE forklift_id = :id', { b: fl.BATTERY_PCT, id: fl.FORKLIFT_ID });
    await ext.commit();
    const rows = await q(`SELECT cmd_id, table_name, row_key, column_name, old_value, new_value, cmd_status, client_program
                            FROM db_commands WHERE cmd_id > :b AND table_name = 'FORKLIFTS' AND row_key = :id ORDER BY cmd_id`,
      { b: before, id: fl.FORKLIFT_ID });
    assert(rows.length >= 2, `expected 2 queued changes, found ${rows.length}`);
    const r: any = rows[0];
    assert(r.CLIENT_PROGRAM === 'CargoVerse selftest', `client_program was ${r.CLIENT_PROGRAM}`);
    // if no server is running, remove the test rows so they are not replayed later
    await ext.execute(`DELETE FROM db_commands WHERE cmd_id > :b AND client_program = 'CargoVerse selftest' AND cmd_status = 'PENDING'`, { b: before });
    await ext.commit();
    return `${r.ROW_KEY}.${r.COLUMN_NAME}: ${r.OLD_VALUE} → ${r.NEW_VALUE} (${rows.map((x: any) => x.CMD_STATUS).join(', ')})`;
  });
  await check("the server's own writes are not queued", async () => {
    assert(fl, 'no forklifts');
    const before = Number((await one('SELECT NVL(MAX(cmd_id), 0) AS m FROM db_commands'))!.M);
    ext.module = 'cargoverse-api';
    try {
      await ext.execute('UPDATE forklifts SET battery_pct = :b WHERE forklift_id = :id', { b: Number(fl.BATTERY_PCT) > 50 ? 40 : 80, id: fl.FORKLIFT_ID });
      const n = Number((await one('SELECT COUNT(*) AS n FROM db_commands WHERE cmd_id > :b', { b: before }))!.N);
      assert(n === 0, `${n} rows were queued`);
    } finally {
      await ext.rollback();
      ext.module = 'CargoVerse selftest';
    }
    return 'module cargoverse-api ignored by the triggers';
  });
  await check('rules hold for outside SQL too (at least one berth open)', async () => {
    try {
      await ext.execute(`UPDATE port_berths SET is_open = 'N'`);
      throw new Error('closing every berth was allowed');
    } catch (e) {
      const m = String((e as Error).message);
      assert(/ORA-20004/.test(m), m.split('\n')[0]);
    } finally {
      await ext.rollback();
    }
    return 'ORA-20004 raised, change rolled back';
  });
  await check('the server queue reads and acknowledges', async () => {
    const pending = await repo.pollCommands();
    return `${pending.length} pending command(s) visible to the server`;
  });

  // ---------------------------------------------------------------------------
  console.log('\n2 · Time travel (Flashback)');
  // Flashback cannot look back past the last DDL on a table (ORA-01466). Right after npm run db:setup or
  // db:lab (which re-grants access) there is no history yet, so wait until the tables are 30 s old.
  const FLASHBACK_TABLES = ['TRUCKS', 'FORKLIFTS', 'PALLETS', 'DOCKS', 'VESSELS', 'PORT_BERTHS', 'QUAY_CRANES', 'YARD_CONTAINERS',
    'STORE_ORDERS', 'STORE_STOCK', 'DELIVERY_VANS', 'SIM_STATE'];
  const tableAge = async () => Number((await one(`SELECT NVL(ROUND((SYSDATE - MAX(last_ddl_time)) * 86400), 99999) AS s FROM user_objects
     WHERE object_type = 'TABLE' AND object_name IN (${FLASHBACK_TABLES.map((t) => `'${t}'`).join(', ')})`))?.S ?? 99999);
  const age0 = await tableAge();
  if (age0 < 30) {
    console.log(`  (the tables were created or re-granted ${age0} s ago; waiting ${30 - age0} s so there is history to rewind)`);
    await new Promise((r) => setTimeout(r, (30 - age0) * 1000));
  }
  const historyS = Math.max(10, Math.min(300, (await tableAge()) - 10));
  await check('Flashback Query (AS OF TIMESTAMP)', async () => {
    const r = await one(`SELECT COUNT(*) AS n FROM trucks AS OF TIMESTAMP (SYSTIMESTAMP - INTERVAL '15' SECOND)`);
    return `${r!.N} trucks 15 s ago`;
  });
  await check('the time machine reads a whole frame from the past', async () => {
    const sites = (await q('SELECT facility_id FROM facilities')).map((r: any) => r.FACILITY_ID as FacilityId);
    const f = await repo.flashback(15, sites);
    assert(f.source === 'flashback', `fell back to ${f.source}: ${f.note ?? ''}`);
    const n = Object.values(f.rows).reduce((a, b) => a + b, 0);
    assert(n > 0, 'no rows read');
    return `SCN ${f.scn}, ${Object.keys(f.rows).length} tables, ${n} rows`;
  });
  await check('Flashback Versions Query (row history)', async () => {
    const v = await one(`SELECT vessel_id FROM vessels ORDER BY vessel_id FETCH FIRST 1 ROW ONLY`);
    assert(v, 'no vessels');
    const h = await repo.rowHistory('vessel', v.VESSEL_ID, historyS);
    assert(h.source === 'flashback', `fell back to ${h.source}: ${h.note ?? ''}`);
    return `${v.VESSEL_ID}: ${h.entries.length} version(s) in the last ${historyS} s`;
  });

  // ---------------------------------------------------------------------------
  console.log('\n3 · Row-level security (VPD)');
  await check('policies are attached', async () => {
    const r = await q(`SELECT object_name FROM user_policies WHERE policy_name = 'CV_SITE_ROWS' ORDER BY object_name`);
    assert(r.length >= 10, `only ${r.length} tables protected — run npm run db:lab`);
    return `${r.length} tables`;
  });
  await check('each account sees only its own sites', async () => {
    const rep = await repo.vpdReport();
    assert(rep.source === 'oracle', 'report was simulated');
    const errs = rep.accounts.filter((a) => a.error);
    assert(!errs.length, errs.map((a) => `${a.account}: ${a.error}`).join('; '));
    for (const a of rep.accounts) {
      const leak = a.predicate ? a.sitesSeen.filter((s) => !a.sites.includes(s)) : [];
      assert(!leak.length, `${a.account} saw ${leak.join(', ')}`);
    }
    const t = rep.tables[0];
    const counts = rep.accounts.map((a) => `${a.account} ${a.counts[t]}`).join(', ');
    const distinct = new Set(rep.accounts.map((a) => a.counts[t])).size;
    assert(distinct > 1, `every account saw the same number of ${t}`);
    return `${t}: owner ${rep.owner[t]}, ${counts}`;
  });
  await check('demo accounts cannot read passwords', async () => {
    let c: any;
    try {
      c = await oracledb.getConnection({ user: 'CV_ZOE', password: config.lab.accountPassword, connectString: config.oracle.connectString });
      await c.execute(`SELECT COUNT(*) FROM ${config.oracle.user}.app_users`);
      throw new Error('CV_ZOE could read APP_USERS');
    } catch (e) {
      const m = String((e as Error).message);
      if (/could read/.test(m)) throw e;
      assert(/ORA-00942|ORA-01031/.test(m), m.split('\n')[0]);
    } finally {
      await c?.close();
    }
    return 'ORA-00942 for APP_USERS';
  });

  // ---------------------------------------------------------------------------
  console.log('\n4 · Concurrency lab');
  const admin = await one(`SELECT user_id FROM app_users WHERE username = 'admin'`);
  const expect: Record<LabScenario, string> = { double_booking: 'protected', lost_update: 'anomaly', safe_update: 'protected', deadlock: 'detected' };
  for (const s of Object.keys(expect) as LabScenario[]) {
    await check(s.replace('_', ' '), async () => {
      const run = await repo.runLab(Number(admin?.USER_ID ?? 1), s);
      assert(run.source === 'oracle', 'run was simulated');
      assert(run.verdict === expect[s], `verdict ${run.verdict}, expected ${expect[s]}: ${run.outcome}`);
      return `${run.verdict} in ${(run.ms / 1000).toFixed(1)} s · ${run.final.map((f) => `${f.label} ${f.value}`).join(', ')}`;
    });
  }

  await wmsChecks(ext, q, one, repo, oracledb);

  await ext.close();
  await repo.close();
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${failed.length ? red(`${failed.length} of ${results.length} checks failed`) : green(`All ${results.length - skipped} checks passed`)}${skipped ? yellow(` · ${skipped} skipped (feature not available in this database)`) : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(red(String((e as Error).stack ?? e))); process.exit(1); });

// ================================================================ Smart Warehouse (10–12)
async function wmsChecks(ext: any, q: (sql: string, b?: Record<string, unknown>) => Promise<any[]>, one: (sql: string, b?: Record<string, unknown>) => Promise<Record<string, any> | undefined>, repo: OracleRepo, oracledb: any): Promise<void> {
  console.log('\n5 · Smart Warehouse');
  const has = async (sql: string) => { try { return Number((await one(sql))?.N ?? 0) > 0; } catch { return false; } };
  await check('warehouse objects exist and are valid', async () => {
    const need = ['LOTS', 'BIN_STOCK', 'LOT_MOVES', 'STORAGE_BINS', 'WH_NODES', 'WH_EDGES', 'SENSORS', 'SENSOR_READINGS', 'STOCK_LEDGER', 'WT_WMS', 'WT_EVENTS',
      'TRG_LOT_MOVES_AI', 'V_SKU_ABC', 'V_FEFO_VIOLATIONS', 'V_TRACE_LINKS', 'V_DEMAND_FORECAST', 'V_REPLENISHMENT'];
    const rows = await q(`SELECT object_name, MIN(status) AS status FROM user_objects WHERE object_name IN (${need.map((n) => `'${n}'`).join(', ')}) GROUP BY object_name`);
    const found = new Map(rows.map((r: any) => [r.OBJECT_NAME, r.STATUS]));
    const missing = need.filter((n) => !found.has(n));
    assert(!missing.length, `missing: ${missing.join(', ')} — run npm run db:lab`);
    // objects invalidated by 12_wms_optional.sql recompile on first use
    await ext.execute(`BEGIN DBMS_UTILITY.COMPILE_SCHEMA(schema => USER, compile_all => FALSE); END;`);
    const bad = (await q(`SELECT object_name FROM user_objects WHERE status = 'INVALID' AND object_name IN (${need.map((n) => `'${n}'`).join(', ')})`)).map((r: any) => r.OBJECT_NAME);
    assert(!bad.length, `invalid: ${bad.join(', ')}`);
    const bins = await one('SELECT COUNT(*) AS n FROM storage_bins');
    return `${need.length} objects VALID · ${bins!.N} storage bins`;
  });

  // lots are created from the inventory by the server's first start; do it here if it never ran
  const lotsN = Number((await one('SELECT COUNT(*) AS n FROM lots'))?.N ?? 0);
  if (!lotsN) {
    await check('opening stock placed in bins', async () => {
      const { world } = await repo.loadWorld();
      const eng = new WmsEngine();
      const n = eng.initFromInventory(world);
      await new OracleWms(repo.wmsDeps()!).persist(eng.takePending());
      return `${n} pallets in ${eng.lots.size} lots`;
    });
  }

  await check('GS1 check digit enforced by a CHECK constraint', async () => {
    const good = sscc(424242);
    const bad = `${good.slice(0, 17)}${(Number(good[17]) + 1) % 10}`;
    const v = await one(`SELECT wt_wms.valid_sscc(:g) AS g, wt_wms.valid_sscc(:b) AS b FROM dual`, { g: good, b: bad });
    assert(v?.G === 'Y' && v?.B === 'N', `valid_sscc gave ${v?.G}/${v?.B}`);
    const free = await one(`SELECT b.bin_id FROM storage_bins b WHERE NOT EXISTS (SELECT 1 FROM bin_stock s WHERE s.bin_id = b.bin_id) FETCH FIRST 1 ROW ONLY`);
    const lot = await one(`SELECT lot_id FROM lots FETCH FIRST 1 ROW ONLY`);
    assert(free && lot, 'no free bin or no lot to test with');
    try {
      await ext.execute(`INSERT INTO bin_stock (bin_id, sscc, lot_id, units) VALUES (:b, :c, :l, 1)`, { b: free.BIN_ID, c: bad, l: lot.LOT_ID });
      throw new Error('a wrong check digit was accepted');
    } catch (e) {
      const m = String((e as Error).message);
      if (/accepted/.test(m)) throw e;
      assert(/ORA-02290/.test(m), m.split('\n')[0]);
    } finally {
      await ext.rollback();
    }
    return `${bad} → ORA-02290 (ck_bs_sscc)`;
  });

  await check('FEFO: WT_WMS.FEFO_LOT picks the earliest expiry', async () => {
    const r = await one(`SELECT l.facility_id, l.sku_id, wt_wms.fefo_lot(l.facility_id, l.sku_id) AS lot,
                                (SELECT MIN(x.expiry_date) FROM lots x WHERE x.facility_id = l.facility_id AND x.sku_id = l.sku_id AND x.qc_status = 'RELEASED'
                                    AND EXISTS (SELECT 1 FROM bin_stock b WHERE b.lot_id = x.lot_id)) AS min_exp
                           FROM lots l WHERE l.expiry_date IS NOT NULL AND l.qc_status = 'RELEASED' AND EXISTS (SELECT 1 FROM bin_stock b WHERE b.lot_id = l.lot_id)
                          FETCH FIRST 1 ROW ONLY`);
    if (!r) throw new Skip('no released lot with an expiry date in the racks');
    const chosen = await one(`SELECT expiry_date AS e FROM lots WHERE lot_id = :l`, { l: r.LOT });
    assert(String(chosen?.E) === String(r.MIN_EXP), `picked ${r.LOT} (${chosen?.E}) but the earliest is ${r.MIN_EXP}`);
    const v = await one(`SELECT COUNT(*) AS n FROM v_fefo_violations`);
    return `${r.SKU_ID} at ${r.FACILITY_ID}: ${r.LOT} · ${v!.N} FEFO violation(s) in the audit`;
  });

  await check('ABC analysis, forecast (MODEL) and reorder points', async () => {
    const abc = await q(`SELECT facility_id, sku_id, abc_class FROM v_sku_abc`);
    assert(abc.length > 0, 'v_sku_abc returned no rows');
    const fc = await q(`SELECT * FROM v_demand_forecast WHERE facility_id = 'WH-04' AND sku_id = 'MED-INS'`);
    assert(fc.length === 14, `forecast has ${fc.length} days, expected 14`);
    const rp = await q(`SELECT action FROM v_replenishment`);
    assert(rp.length > 0, 'v_replenishment returned no rows');
    return `${abc.length} products classified (${abc.filter((r: any) => r.ABC_CLASS === 'A').length} A) · 14-day forecast · ${rp.filter((r: any) => r.ACTION === 'REORDER').length} to reorder`;
  });

  await check('recall trace (recursive WITH over V_TRACE_LINKS)', async () => {
    const root = await one(`SELECT lot_id FROM lots ORDER BY units_received - units_on_hand DESC FETCH FIRST 1 ROW ONLY`);
    if (!root) throw new Skip('no lots yet');
    const rows = await new OracleWms(repo.wmsDeps()!).trace('LOT', root.LOT_ID, 'down');
    return `lot ${root.LOT_ID}: ${rows.length - 1} linked record(s)${rows.some((r) => r.kind === 'STORE') ? ' incl. stores' : ''}`;
  });

  await check('cold chain: MATCH_RECOGNIZE finds a breach and holds the lots', async () => {
    // three warm readings, inside a transaction that is rolled back afterwards
    try {
      // a second or two ahead, so no real reading from a running server falls in between
      for (const s of [1, 2, 3]) {
        await ext.execute(`INSERT INTO sensor_readings (sensor_id, read_at, temp_c) VALUES ('TS-04-C1', SYSTIMESTAMP + NUMTODSINTERVAL(:s, 'SECOND'), 12.5)`, { s });
      }
      const r = await ext.execute('BEGIN :n := wt_wms.detect_breaches; END;', { n: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } });
      const n = Number(r.outBinds.n);
      const b = await one(`SELECT peak_c, readings_out, lots_held FROM cold_breaches WHERE sensor_id = 'TS-04-C1' ORDER BY breach_id DESC FETCH FIRST 1 ROW ONLY`);
      assert(b, 'no breach recorded');
      return `${n} new breach(es) · peak ${b.PEAK_C} °C · ${b.LOTS_HELD} lot(s) held (rolled back)`;
    } finally {
      await ext.rollback();
    }
  });

  await check('Dijkstra in PL/SQL agrees with the application', async () => {
    const site = siteStorage('WH-04');
    const target = site.bins[site.bins.length - 1].nodeId;
    const r = await one(`SELECT wt_wms.shortest_path('WH-04-I1', :t) AS j FROM dual`, { t: target });
    const db = JSON.parse(String(r!.J));
    const app = shortestPath(site, 'WH-04-I1', target);
    assert(Math.abs(Number(db.metres) - app.metres) < 0.05, `database ${db.metres} m, application ${app.metres} m`);
    return `WH-04-I1 → ${target}: ${db.metres} m over ${db.nodes.length} nodes`;
  });

  await check('interval partitioning of SENSOR_READINGS', async () => {
    if (!(await has(`SELECT COUNT(*) AS n FROM user_part_tables WHERE table_name = 'SENSOR_READINGS'`))) throw new Skip('not partitioned (12_wms_optional.sql skipped it)');
    const p = await one(`SELECT COUNT(*) AS n FROM user_tab_partitions WHERE table_name = 'SENSOR_READINGS'`);
    return `${p!.N} partition(s), one per day`;
  });

  await check('blockchain table refuses changes', async () => {
    if (!(await has(`SELECT COUNT(*) AS n FROM user_blockchain_tables WHERE table_name = 'STOCK_LEDGER'`))) throw new Skip('STOCK_LEDGER is not a blockchain table here');
    let refused: string | null = null;
    try {
      await ext.execute('UPDATE stock_ledger SET units = units + 1 WHERE ROWNUM = 1');
    } catch (e) {
      refused = String((e as Error).message);
    } finally {
      await ext.rollback();
    }
    if (refused === null) {
      const n = Number((await one('SELECT COUNT(*) AS n FROM stock_ledger'))?.N ?? 0);
      if (n) throw new Error('an UPDATE of the ledger was allowed');
      return 'ledger is empty (start the server to fill it)';
    }
    assert(/ORA-05715/.test(refused), refused.split('\n')[0]);
    const v = await ext.execute(`DECLARE n NUMBER; BEGIN DBMS_BLOCKCHAIN_TABLE.VERIFY_ROWS(schema_name => USER, table_name => 'STOCK_LEDGER', number_of_rows_verified => n); :n := n; END;`,
      { n: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } });
    return `UPDATE → ORA-05715 · VERIFY_ROWS ok (${v.outBinds.n} rows)`;
  });

  await check('AI Vector Search', async () => {
    const t = await one(`SELECT data_type AS t FROM user_tab_columns WHERE table_name = 'DAMAGE_REPORTS' AND column_name = 'EMBEDDING'`);
    if (String(t?.T) !== 'VECTOR') throw new Skip('no VECTOR type (Oracle 23ai needed); the server compares embeddings itself');
    const d = await one(`SELECT ROUND(VECTOR_DISTANCE(TO_VECTOR('[1,0,0]'), TO_VECTOR('[0.8,0.6,0]'), COSINE), 3) AS d FROM dual`);
    const e = await one(`SELECT COUNT(*) AS n, MAX(embed_model) AS m FROM damage_reports WHERE embedding IS NOT NULL`);
    return `VECTOR_DISTANCE works (${d!.D}) · ${e!.N} reports embedded${e!.M ? ` with ${e!.M}` : ' (start the server to embed them)'}`;
  });

  await check('Transactional Event Queue', async () => {
    if (!(await has(`SELECT COUNT(*) AS n FROM user_queues WHERE name = 'CV_EVENTS'`))) throw new Skip('no CV_EVENTS queue; events are read from WMS_EVENTS');
    const before = Number((await one('SELECT NVL(MAX(event_id), 0) AS n FROM wms_events'))?.N ?? 0);
    await ext.execute(`BEGIN wt_events.publish('SELFTEST', NULL, 'db:selftest event'); END;`);
    await ext.commit();
    const r = await ext.execute('BEGIN :r := wt_events.dequeue_batch(3, 50); END;', { r: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 32767 } });
    await ext.commit();
    const msgs = JSON.parse(String(r.outBinds.r || '[]')) as { id: number; type: string }[];
    const mine = msgs.find((m) => m.type === 'SELFTEST' && m.id > before);
    return mine ? `published and dequeued (event ${mine.id})` : 'published (a running server took it off the queue first)';
  });

  await check('scheduler job watches the cold chain', async () => {
    const j = await one(`SELECT enabled, state, ${"TO_CHAR(last_start_date, 'HH24:MI:SS')"} AS last FROM user_scheduler_jobs WHERE job_name = 'CV_DETECT_BREACHES'`);
    if (!j) throw new Skip('no CV_DETECT_BREACHES job (needs CREATE JOB); the server runs the detector instead');
    assert(j.ENABLED === 'TRUE', `job is ${j.STATE}`);
    return `enabled · ${j.STATE}${j.LAST ? ` · last run ${j.LAST}` : ''}`;
  });

  await check('SQL property graph (GRAPH_TABLE)', async () => {
    if (!(await has(`SELECT COUNT(*) AS n FROM user_property_graphs WHERE graph_name = 'CV_WAREHOUSE_GRAPH'`))) throw new Skip('no property graph (Oracle 23ai needed)');
    const r = await new OracleWms(repo.wmsDeps()!).graphQuery('WH-04-I1');
    assert(r.ok, r.error ?? 'query failed');
    return `${r.rows} aisle points within 6 segments of WH-04-I1`;
  });
}
