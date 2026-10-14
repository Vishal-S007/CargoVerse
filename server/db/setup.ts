// Installs the CargoVerse schema into Oracle: npm run db:setup  (add -- --reset to drop first)
// Runs db/oracle/01..04 in order. Statements end with ';' (SQL) or a line containing only '/' (PL/SQL).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config';

export function splitSql(text: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let plsql = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!buf.length) {
      if (!line.trim() || line.trim().startsWith('--')) continue;
      if (/^\s*(SET|PROMPT|SPOOL|WHENEVER)\b/i.test(line)) continue; // SQL*Plus commands
      plsql = /^\s*(CREATE\s+OR\s+REPLACE\s+(PACKAGE|TRIGGER|PROCEDURE|FUNCTION|TYPE)|BEGIN|DECLARE)\b/i.test(line);
    }
    if (plsql) {
      if (line.trim() === '/') { out.push(buf.join('\n')); buf = []; continue; }
      buf.push(line);
    } else {
      buf.push(line);
      if (/;\s*(--.*)?$/.test(line)) {
        out.push(buf.join('\n').replace(/;\s*(--.*)?$/, ''));
        buf = [];
      }
    }
  }
  if (buf.join('').trim()) out.push(buf.join('\n'));
  return out;
}

const ADMIN_ACCOUNTS = ['CV_ADMIN', 'CV_ALEX', 'CV_MEERA', 'CV_ZOE'];

/** A SYS script with this installation's PDB, schema owner and demo password filled in. */
function sysScript(file: string): string {
  const pdb = (config.oracle.connectString.split('/').pop() || 'FREEPDB1').split('?')[0].toUpperCase();
  const owner = config.oracle.user;
  return readFileSync(resolve(process.cwd(), 'db/oracle', file), 'utf8')
    .replace(/CONTAINER = FREEPDB1/g, `CONTAINER = ${pdb}`)
    .replace(/'WARETRACK'/g, `'${owner.toUpperCase()}'`)
    .replace(/WARETRACK\./g, `${owner.toUpperCase()}.`)
    .replace(/\bTO waretrack;/g, `TO ${owner};`)
    .replace(/"Cargo_2026"/g, `"${config.lab.accountPassword.replace(/"/g, '')}"`);
}

/**
 * Runs a privileged script (07 / 09). First through `docker exec … sqlplus / as sysdba` in the
 * Oracle container (works with the docker-compose setup), otherwise as SYSTEM over the network.
 */
async function runSys(oracledb: any, file: string): Promise<{ ok: boolean; how: string; detail: string }> {
  const text = sysScript(file);
  const { spawnSync } = await import('node:child_process');
  const d = spawnSync('docker', ['exec', '-i', config.lab.container, 'sqlplus', '-S', '-L', '/ as sysdba'], { input: text, encoding: 'utf8', timeout: 120000 });
  const out = `${d.stdout ?? ''}${d.stderr ?? ''}`;
  if (!d.error && d.status === 0 && !/ORA-\d|SP2-\d/.test(out)) return { ok: true, how: `SYSDBA in container ${config.lab.container}`, detail: '' };
  const dockerWhy = d.error ? 'docker not available' : (out.match(/(ORA-\d+[^\n]*|SP2-\d+[^\n]*|Error[^\n]*)/)?.[1] ?? `exit ${d.status}`).trim();
  // fallback: SYSTEM over the network (can create the accounts; granting DBMS_RLS may need SYS)
  let conn: any;
  try {
    conn = await oracledb.getConnection({ user: 'system', password: config.lab.adminPassword, connectString: config.oracle.connectString });
  } catch (e) {
    return { ok: false, how: 'none', detail: `${dockerWhy}; SYSTEM login failed: ${String((e as Error).message).split('\n')[0]}` };
  }
  const errs: string[] = [];
  try {
    const body = text.split(/\r?\n/).filter((l) => !/^\s*(EXIT|ALTER\s+SESSION\s+SET\s+CONTAINER)\b/i.test(l)).join('\n');
    for (const st of splitSql(body)) {
      try { await conn.execute(st); } catch (e) { errs.push(String((e as Error).message).split('\n')[0]); }
    }
  } finally {
    await conn.close();
  }
  return errs.length ? { ok: false, how: 'SYSTEM', detail: errs.join('; ') } : { ok: true, how: 'SYSTEM', detail: '' };
}

async function runFile(conn: any, oracledb: any, f: string, opts: { soft?: boolean } = {}): Promise<string[]> {
  const stmts = splitSql(readFileSync(resolve(process.cwd(), 'db/oracle', f), 'utf8'));
  process.stdout.write(`  ${f} (${stmts.length} statements) … `);
  const warnings: string[] = [];
  for (const s of stmts) {
    try {
      await conn.execute(s);
    } catch (e) {
      const msg = String((e as Error).message).split('\n')[0];
      if (opts.soft) { warnings.push(msg); continue; }
      console.error(`\n\nFailed in ${f}:\n${s.slice(0, 400)}\n\n${(e as Error).message}`);
      process.exit(1);
    }
  }
  // surface PL/SQL compilation errors, which Oracle reports as warnings
  if (/plsql|lab|security/.test(f)) {
    const errs = await conn.execute(`SELECT name, type, line, text FROM user_errors ORDER BY name, sequence`, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    if (errs.rows.length) {
      console.error('\nPL/SQL compilation errors:');
      for (const e of errs.rows) console.error(`  ${e.TYPE} ${e.NAME} line ${e.LINE}: ${e.TEXT}`);
      process.exit(1);
    }
  }
  await conn.commit();
  console.log(warnings.length ? `done with ${warnings.length} skipped` : 'ok');
  return warnings;
}

/** 06–09: live control from SQL, concurrency lab, row-level security. */
async function installLab(conn: any, oracledb: any): Promise<void> {
  await runFile(conn, oracledb, '06_lab.sql');
  process.stdout.write('  07_security_sys.sql (as SYS) … ');
  const a = await runSys(oracledb, '07_security_sys.sql');
  console.log(a.ok ? `ok (${a.how})` : `skipped — ${a.detail}`);
  const vpd = await runFile(conn, oracledb, '08_security.sql', { soft: true });
  process.stdout.write('  09_security_sys.sql (as SYS) … ');
  const b = await runSys(oracledb, '09_security_sys.sql');
  console.log(b.ok ? `ok (${b.how})` : `skipped — ${b.detail}`);
  const r = await conn.execute(`SELECT (SELECT COUNT(*) FROM user_policies WHERE policy_name = 'CV_SITE_ROWS') AS p,
                                       (SELECT COUNT(*) FROM all_users WHERE username IN ('CV_ADMIN', 'CV_ALEX', 'CV_MEERA', 'CV_ZOE')) AS u FROM dual`,
    {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
  const policies = Number(r.rows[0].P), accounts = Number(r.rows[0].U);
  console.log('\nDatabase Lab:');
  console.log('  ✓ Live control from SQL (DB_COMMANDS queue + 7 triggers)');
  console.log('  ✓ Concurrency lab (DOCK_BOOKINGS, LAB_STOCK, WT_LAB.BOOK_DOCK)');
  console.log('  ✓ Time machine (Oracle Flashback Query — needs no setup)');
  if (policies > 0 && accounts === ADMIN_ACCOUNTS.length) {
    console.log(`  ✓ Row-level security: ${policies} tables protected; SQL Developer accounts ${ADMIN_ACCOUNTS.join(', ')} (password ${config.lab.accountPassword})`);
  } else {
    console.log(`  ✗ Row-level security not installed (${accounts} of 4 accounts, ${policies} policies).`);
    if (vpd.length) console.log(`    ${vpd[0]}`);
    console.log('    Run db/oracle/07_security_sys.sql as SYS, then npm run db:lab. The rest of CargoVerse works without it.');
  }
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const labOnly = process.argv.includes('--lab');
  let oracledb: any;
  const pkg = 'oracledb';
  try { const m = await import(pkg); oracledb = m.default ?? m; } catch { console.error('Install dependencies first: npm install'); process.exit(1); }
  console.log(`Connecting to ${config.oracle.connectString} as ${config.oracle.user}…`);
  // a freshly started Oracle container needs a minute or two before it accepts connections
  let conn: any = null;
  for (let attempt = 1; !conn; attempt++) {
    try {
      conn = await oracledb.getConnection(config.oracle);
    } catch (e) {
      const msg = String((e as Error).message);
      const starting = /ORA-12514|ORA-12541|ORA-12528|ORA-01033|ORA-12537|ORA-12547|NJS-503|NJS-500|NJS-511|ECONNREFUSED|ECONNRESET|listener/i.test(msg);
      // nothing listening and no Docker on this machine: Oracle was never started
      if (attempt === 1 && /ECONNREFUSED|NJS-503|NJS-500|NJS-511/i.test(msg)) {
        const { spawnSync } = await import('node:child_process');
        const docker = spawnSync('docker', ['--version'], { stdio: 'ignore' });
        if (docker.error || docker.status !== 0) {
          console.error('\nNo Oracle database is running on ' + config.oracle.connectString + ', and Docker is not installed.');
          console.error('Install Docker Desktop (https://www.docker.com/products/docker-desktop/), open it, then run: npm run db:up');
          console.error('To try the app without Oracle meanwhile: npm run dev:memory');
          process.exit(1);
        }
      }
      if (!starting || attempt >= 36) {
        console.error(`\nCould not connect: ${msg.split('\n')[0]}`);
        if (/ORA-01017/.test(msg)) console.error('Check ORACLE_USER / ORACLE_PASSWORD in .env (default: waretrack / WareTrack_2026).');
        else console.error('Is Oracle running? Start it with `npm run db:up` (needs Docker Desktop) and try again.');
        process.exit(1);
      }
      process.stdout.write(attempt === 1 ? 'Oracle is still starting, waiting' : '.');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.log('connected.');
  try {
    const exists = await conn.execute(`SELECT COUNT(*) AS n FROM user_tables WHERE table_name = 'FACILITIES'`, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    const hasSchema = Number(exists.rows[0].N) > 0;
    if (labOnly) {
      if (!hasSchema) { console.error('There is no CargoVerse schema yet. Run `npm run db:setup` first.'); process.exit(1); }
      console.log('Installing the Database Lab on the existing schema (your data is kept):');
    } else {
      if (!reset && hasSchema) {
        console.error('The schema already exists. Use `npm run db:reset` to drop and recreate it (this deletes all data),');
        console.error('or `npm run db:lab` to add the Database Lab to it without losing data.');
        process.exit(1);
      }
      for (const f of [...(reset ? ['99_drop_all.sql'] : []), '01_schema.sql', '02_plsql.sql', '03_views.sql', '04_seed.sql']) {
        await runFile(conn, oracledb, f);
      }
      const c = await conn.execute(`SELECT (SELECT COUNT(*) FROM shipments) s, (SELECT COUNT(*) FROM app_users) u, (SELECT COUNT(*) FROM tasks) t,
                                           (SELECT COUNT(*) FROM park_buildings) b, (SELECT COUNT(*) FROM park_gate_log) g FROM dual`, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      console.log(`Done: ${c.rows[0].U} users, ${c.rows[0].S} shipments, ${c.rows[0].T} tasks, ${c.rows[0].B} park buildings, ${c.rows[0].G} gate log rows.`);
    }
    await installLab(conn, oracledb);
    // the seed's ALTER TABLE … IDENTITY statements invalidate dependent code; recompile it
    await conn.execute(`BEGIN DBMS_UTILITY.COMPILE_SCHEMA(schema => USER, compile_all => FALSE); END;`);
    const bad = await conn.execute(`SELECT object_type, object_name FROM user_objects WHERE status = 'INVALID'`, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    if (bad.rows.length) console.warn('Warning: invalid objects: ' + bad.rows.map((r: any) => `${r.OBJECT_TYPE} ${r.OBJECT_NAME}`).join(', '));
    else console.log('\nAll views, triggers and PL/SQL packages compiled VALID.');
  } finally {
    await conn.close();
  }
}

if (process.argv[1] && /setup\.(ts|mjs|js)$/.test(process.argv[1])) void main();
