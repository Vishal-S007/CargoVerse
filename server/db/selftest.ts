// Database Lab self-test: checks the four Oracle features against the real database.
//   npm run db:selftest
// Safe to run while `npm run dev` is running; every change it makes is put back.
import { config } from '../config';
import { OracleRepo } from './oracle';
import type { FacilityId } from '../../src/data/types';
import type { LabScenario } from '../../src/api/types';

type Result = { name: string; ok: boolean; detail: string; ms: number };
const results: Result[] = [];
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, ms: Date.now() - t0 });
    console.log(`  ${green('PASS')}  ${name}  ${dim(detail)}`);
  } catch (e) {
    const detail = String((e as Error).message ?? e).split('\n')[0];
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
  await check('Flashback Query (AS OF TIMESTAMP)', async () => {
    const r = await one(`SELECT COUNT(*) AS n FROM trucks AS OF TIMESTAMP (SYSTIMESTAMP - INTERVAL '20' SECOND)`);
    return `${r!.N} trucks 20 s ago`;
  });
  await check('the time machine reads a whole frame from the past', async () => {
    const sites = (await q('SELECT facility_id FROM facilities')).map((r: any) => r.FACILITY_ID as FacilityId);
    const f = await repo.flashback(30, sites);
    assert(f.source === 'flashback', `fell back to ${f.source}: ${f.note ?? ''}`);
    const n = Object.values(f.rows).reduce((a, b) => a + b, 0);
    assert(n > 0, 'no rows read');
    return `SCN ${f.scn}, ${Object.keys(f.rows).length} tables, ${n} rows`;
  });
  await check('Flashback Versions Query (row history)', async () => {
    const v = await one(`SELECT vessel_id FROM vessels ORDER BY vessel_id FETCH FIRST 1 ROW ONLY`);
    assert(v, 'no vessels');
    const h = await repo.rowHistory('vessel', v.VESSEL_ID, 300);
    assert(h.source === 'flashback', `fell back to ${h.source}: ${h.note ?? ''}`);
    return `${v.VESSEL_ID}: ${h.entries.length} version(s) in the last 5 minutes`;
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

  await ext.close();
  await repo.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? red(`${failed.length} of ${results.length} checks failed`) : green(`All ${results.length} checks passed`)}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(red(String((e as Error).stack ?? e))); process.exit(1); });
