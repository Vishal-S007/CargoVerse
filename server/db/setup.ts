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

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
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
  const files = [...(reset ? ['99_drop_all.sql'] : []), '01_schema.sql', '02_plsql.sql', '03_views.sql', '04_seed.sql'];
  try {
    if (!reset) {
      const r = await conn.execute(`SELECT COUNT(*) AS n FROM user_tables WHERE table_name = 'FACILITIES'`, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      if (Number(r.rows[0].N) > 0) {
        console.error('The schema already exists. Use `npm run db:reset` to drop and recreate it (this deletes all data).');
        process.exit(1);
      }
    }
    for (const f of files) {
      const stmts = splitSql(readFileSync(resolve(process.cwd(), 'db/oracle', f), 'utf8'));
      process.stdout.write(`  ${f} (${stmts.length} statements) … `);
      for (const s of stmts) {
        try {
          await conn.execute(s);
        } catch (e) {
          console.error(`\n\nFailed in ${f}:\n${s.slice(0, 400)}\n\n${(e as Error).message}`);
          process.exit(1);
        }
      }
      // surface PL/SQL compilation errors, which Oracle reports as warnings
      if (f === '02_plsql.sql') {
        const errs = await conn.execute(`SELECT name, type, line, text FROM user_errors ORDER BY name, sequence`, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        if (errs.rows.length) {
          console.error('\nPL/SQL compilation errors:');
          for (const e of errs.rows) console.error(`  ${e.TYPE} ${e.NAME} line ${e.LINE}: ${e.TEXT}`);
          process.exit(1);
        }
      }
      await conn.commit();
      console.log('ok');
    }
    const c = await conn.execute(`SELECT (SELECT COUNT(*) FROM shipments) s, (SELECT COUNT(*) FROM app_users) u, (SELECT COUNT(*) FROM tasks) t,
                                         (SELECT COUNT(*) FROM park_buildings) b, (SELECT COUNT(*) FROM park_gate_log) g FROM dual`, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    console.log(`Done: ${c.rows[0].U} users, ${c.rows[0].S} shipments, ${c.rows[0].T} tasks, ${c.rows[0].B} park buildings, ${c.rows[0].G} gate log rows.`);
    // the seed's ALTER TABLE … IDENTITY statements invalidate dependent code; recompile it
    await conn.execute(`BEGIN DBMS_UTILITY.COMPILE_SCHEMA(schema => USER, compile_all => FALSE); END;`);
    const bad = await conn.execute(`SELECT object_type, object_name FROM user_objects WHERE status = 'INVALID'`, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    if (bad.rows.length) console.warn('Warning: invalid objects: ' + bad.rows.map((r: any) => `${r.OBJECT_TYPE} ${r.OBJECT_NAME}`).join(', '));
    else console.log('All views, triggers and PL/SQL packages compiled VALID.');
  } finally {
    await conn.close();
  }
}

if (process.argv[1] && /setup\.(ts|mjs|js)$/.test(process.argv[1])) void main();
