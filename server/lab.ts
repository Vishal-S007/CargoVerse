// Database Lab helpers shared by the Oracle and in-memory repositories:
// the statement guard for "run as an outside client", the small UPDATE parser the
// in-memory store uses to imitate the Oracle triggers, and simulated concurrency
// runs for when no Oracle database is connected.
import type { ExternalCommand, LabRun, LabScenario, LabStep } from '../src/api/types';

/** Tables whose changes made outside the server are picked up by the live city (see 06_lab.sql). */
export const CONTROL_TABLES: Record<ExternalCommand['table'], { key: string[]; columns: string[] }> = {
  PORT_BERTHS: { key: ['BERTH_CODE'], columns: ['IS_OPEN'] },
  VESSELS: { key: ['VESSEL_ID'], columns: ['ON_HOLD'] },
  STORE_STOCK: { key: ['STORE_ID', 'SKU_ID'], columns: ['UNITS'] },
  FORKLIFTS: { key: ['FORKLIFT_ID'], columns: ['BATTERY_PCT'] },
  SIM_STATE: { key: ['STATE_ID'], columns: ['PAUSED', 'SPEED'] },
  PARK_BUILDINGS: { key: ['BUILDING_ID'], columns: ['BLDG_STATUS'] },
  TASKS: { key: ['TASK_ID'], columns: ['TASK_STATUS'] },
};

/** Removes leading comments and a trailing semicolon; refuses a second statement. */
function clean(input: string): string {
  let sql = input.trim();
  for (;;) {
    if (sql.startsWith('--')) { const nl = sql.indexOf('\n'); sql = nl < 0 ? '' : sql.slice(nl + 1).trim(); continue; }
    if (sql.startsWith('/*')) { const e = sql.indexOf('*/'); sql = e < 0 ? '' : sql.slice(e + 2).trim(); continue; }
    break;
  }
  sql = sql.replace(/;\s*$/, '').trim();
  let q = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") q = !q;
    else if (!q && ch === ';') throw new Error('Run one statement at a time (remove the extra semicolon).');
  }
  return sql;
}

/**
 * Guard for the "run as an outside client" box: exactly one UPDATE, INSERT or DELETE.
 * (DDL, PL/SQL blocks and queries belong elsewhere: SQL Developer or the read-only console.)
 */
export function checkDml(input: string): string {
  const sql = clean(input);
  if (!sql) throw new Error('Enter an UPDATE, INSERT or DELETE statement.');
  if (!/^(UPDATE|INSERT|DELETE)\b/i.test(sql)) throw new Error('Only UPDATE, INSERT and DELETE statements can be run here (use the SQL console for queries).');
  if (/\b(DROP|TRUNCATE|ALTER|GRANT|REVOKE|CREATE)\b/i.test(sql.replace(/'(?:[^']|'')*'/g, "''"))) throw new Error('Schema changes are not allowed here.');
  if (/\b(APP_USERS|USER_SESSIONS|ROLE_PERMISSIONS|AUDIT_LOG|DB_ACCOUNTS)\b/i.test(sql)) throw new Error('Accounts, permissions and the audit trail cannot be changed from here.');
  return sql;
}

const unquote = (v: string) => {
  const t = v.trim();
  if (/^'.*'$/s.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  throw new Error(`Cannot read the value ${t} (use a number or a 'quoted' text)`);
};

/**
 * Understands the simple statements of the Database Lab presets, e.g.
 *   UPDATE port_berths SET is_open = 'N' WHERE berth_code = 'B1'
 *   UPDATE store_stock SET units = 0 WHERE store_id = 'ST-09' AND sku_id = 'BOX-M'
 *   UPDATE sim_state SET speed = 4
 * Used only without Oracle, where there are no triggers to do the real work.
 */
export function parseSimpleUpdate(input: string): { table: ExternalCommand['table']; key: string; column: string; value: string } {
  const sql = checkDml(input);
  const m = /^UPDATE\s+(\w+)\s+SET\s+(\w+)\s*=\s*('(?:[^']|'')*'|-?\d+(?:\.\d+)?)\s*(?:WHERE\s+(.+))?$/is.exec(sql);
  if (!m) throw new Error('Without Oracle only simple statements are understood: UPDATE <table> SET <column> = <value> WHERE <key> = \'<id>\'');
  const table = m[1].toUpperCase() as ExternalCommand['table'];
  const spec = CONTROL_TABLES[table];
  if (!spec) throw new Error(`Without Oracle the lab understands changes to ${Object.keys(CONTROL_TABLES).join(', ')}`);
  const column = m[2].toUpperCase();
  if (!spec.columns.includes(column)) throw new Error(`${table}.${column} does not steer the city; try ${spec.columns.join(' or ')}`);
  const value = unquote(m[3]);
  if (table === 'SIM_STATE') return { table, key: '1', column, value };
  const conds: Record<string, string> = {};
  for (const part of (m[4] ?? '').split(/\s+AND\s+/i)) {
    const c = /^\s*(\w+)\s*=\s*('(?:[^']|'')*'|-?\d+)\s*$/.exec(part);
    if (c) conds[c[1].toUpperCase()] = unquote(c[2]);
  }
  const keys = spec.key.map((k) => conds[k]);
  if (keys.some((k) => k === undefined)) throw new Error(`Name the row with WHERE ${spec.key.map((k) => `${k.toLowerCase()} = '…'`).join(' AND ')}`);
  return { table, key: keys.join(':'), column, value };
}

// ---------------------------------------------------------------- simulated concurrency runs (no Oracle)
export const LAB_TITLES: Record<LabScenario, string> = {
  double_booking: 'Two people book the same dock slot at the same moment',
  lost_update: 'Lost update: read, then write, without a lock',
  safe_update: 'The fix: SELECT … FOR UPDATE',
  deadlock: 'Deadlock: two sessions wait for each other',
};

export function simulateLab(scenario: LabScenario, dock: string, slot: string): LabRun {
  const s: LabStep[] = [];
  const add = (session: LabStep['session'], t: number, kind: LabStep['kind'], text: string, sql?: string, end?: number) => s.push({ session, t, kind, text, sql, end });
  const base = { scenario, title: LAB_TITLES[scenario], source: 'simulated' as const };
  switch (scenario) {
    case 'double_booking': {
      const call = (truck: string, who: string, hold: number) =>
        `BEGIN :id := wt_lab.book_dock('${dock}', TO_DATE('${slot}', 'YYYY-MM-DD HH24:MI'), '${truck}', '${who}', ${hold}, 'LAB'); END;`;
      add('A', 0, 'sql', 'Session A books the slot (and keeps its transaction open for 2.5 s)', call('TRK-2051', 'Session A', 2.5));
      add('A', 4, 'info', `Locked dock ${dock} (SELECT … FOR UPDATE), slot is free, row inserted`);
      add('B', 400, 'sql', 'Session B books the same slot', call('TRK-2287', 'Session B', 0));
      add('B', 402, 'wait', `Waiting for session A's lock on dock ${dock}`, undefined, 2516);
      add('A', 2510, 'ok', 'Booking #1 created');
      add('A', 2514, 'commit', 'COMMIT — the lock is released');
      add('B', 2522, 'error', `ORA-20002: Dock ${dock} is already booked at ${slot.slice(11)} for TRK-2051 (by Session A)`);
      add('B', 2524, 'rollback', 'ROLLBACK');
      return { ...base, steps: s, verdict: 'protected', ms: 2530,
        outcome: 'Session B had to wait for A and was then refused. One booking exists, never two.',
        final: [{ label: 'Bookings for this slot', value: '1 (TRK-2051)' }, { label: 'Session B waited', value: '2.1 s' }] };
    }
    case 'lost_update': {
      add('A', 0, 'sql', 'A reads the stock', "SELECT units FROM lab_stock WHERE item_id = 'LAB-A'");
      add('A', 3, 'ok', 'units = 100');
      add('B', 100, 'sql', 'B reads the stock', "SELECT units FROM lab_stock WHERE item_id = 'LAB-A'");
      add('B', 103, 'ok', 'units = 100');
      add('A', 700, 'sql', 'A sells 10 and writes back 100 − 10', "UPDATE lab_stock SET units = 90 WHERE item_id = 'LAB-A'");
      add('A', 704, 'commit', 'COMMIT');
      add('B', 1000, 'sql', 'B sells 15 and writes back 100 − 15', "UPDATE lab_stock SET units = 85 WHERE item_id = 'LAB-A'");
      add('B', 1004, 'commit', 'COMMIT');
      return { ...base, steps: s, verdict: 'anomaly', ms: 1010,
        outcome: 'Both sales were committed, but the stock shows 85 instead of 75: session A\'s sale of 10 was silently lost.',
        final: [{ label: 'Final stock', value: '85' }, { label: 'Correct stock', value: '75' }, { label: 'Units lost', value: '10' }] };
    }
    case 'safe_update': {
      add('A', 0, 'sql', 'A reads the stock and locks the row', "SELECT units FROM lab_stock WHERE item_id = 'LAB-A' FOR UPDATE");
      add('A', 3, 'ok', 'units = 100 (row locked)');
      add('B', 100, 'sql', 'B wants the same row', "SELECT units FROM lab_stock WHERE item_id = 'LAB-A' FOR UPDATE");
      add('B', 102, 'wait', "Waiting for session A's row lock", undefined, 708);
      add('A', 700, 'sql', 'A writes 100 − 10', "UPDATE lab_stock SET units = 90 WHERE item_id = 'LAB-A'");
      add('A', 704, 'commit', 'COMMIT — lock released');
      add('B', 709, 'ok', 'units = 90 (reads A\'s committed value)');
      add('B', 1000, 'sql', 'B writes 90 − 15', "UPDATE lab_stock SET units = 75 WHERE item_id = 'LAB-A'");
      add('B', 1004, 'commit', 'COMMIT');
      return { ...base, steps: s, verdict: 'protected', ms: 1010,
        outcome: 'B waited for A, then read 90 and wrote 75. Both sales count.',
        final: [{ label: 'Final stock', value: '75' }, { label: 'Correct stock', value: '75' }, { label: 'Session B waited', value: '0.6 s' }] };
    }
    case 'deadlock': {
      add('A', 0, 'sql', 'A updates LAB-A', "UPDATE lab_stock SET units = units - 1 WHERE item_id = 'LAB-A'");
      add('B', 100, 'sql', 'B updates LAB-B', "UPDATE lab_stock SET units = units - 1 WHERE item_id = 'LAB-B'");
      add('A', 300, 'sql', 'A now needs LAB-B (held by B)', "UPDATE lab_stock SET units = units - 1 WHERE item_id = 'LAB-B'");
      add('A', 302, 'wait', 'Waiting for B', undefined, 3640);
      add('B', 600, 'sql', 'B now needs LAB-A (held by A): a cycle', "UPDATE lab_stock SET units = units - 1 WHERE item_id = 'LAB-A'");
      add('B', 602, 'wait', 'Waiting for A', undefined, 3600);
      add('DB', 3600, 'info', 'Oracle detects the deadlock and picks a victim');
      add('B', 3600, 'error', 'ORA-00060: deadlock detected while waiting for resource');
      add('B', 3604, 'rollback', 'ROLLBACK — B gives its row back');
      add('A', 3640, 'ok', 'A gets LAB-B and continues');
      add('A', 3644, 'commit', 'COMMIT');
      return { ...base, steps: s, verdict: 'detected', ms: 3650,
        outcome: 'Oracle found the cycle in about 3 seconds, rolled back one statement of session B and let A finish. No one waits forever.',
        final: [{ label: 'LAB-A', value: '99' }, { label: 'LAB-B', value: '99' }, { label: 'Victim', value: 'Session B' }] };
    }
  }
}

/** Tables protected by the row-level security policy (08_security.sql). */
export const VPD_TABLES = ['FACILITIES', 'DOCKS', 'CHARGERS', 'INVENTORY', 'PALLETS', 'TRUCKS', 'SHIPMENTS', 'FORKLIFTS', 'STOCK_MOVEMENTS',
  'TASKS', 'OPERATION_EVENTS', 'PARK_GATE_LOG', 'EMPLOYEES', 'STORE_ORDERS', 'DELIVERY_VANS'];
/** Tables counted in the row-level security comparison. */
export const VPD_PROBE_TABLES = ['TRUCKS', 'SHIPMENTS', 'FORKLIFTS', 'INVENTORY', 'TASKS', 'PALLETS'];
/** The demonstration database accounts and the CargoVerse user each stands for. */
export const LAB_ACCOUNTS = [
  { account: 'CV_ADMIN', username: 'admin' },
  { account: 'CV_ALEX', username: 'alex.chen' },
  { account: 'CV_MEERA', username: 'meera.iyer' },
  { account: 'CV_ZOE', username: 'zoe.reyes' },
];

/** Validates a value the way the table's CHECK constraints would (used without Oracle). */
export function checkControlValue(table: ExternalCommand['table'], column: string, value: string): void {
  const bad = (c: string) => { throw new Error(`ORA-02290: check constraint (${c}) violated`); };
  if (table === 'PORT_BERTHS' && !['Y', 'N'].includes(value)) bad('CK_BERTH_OPEN');
  if (table === 'VESSELS' && !['Y', 'N'].includes(value)) bad('CK_VSL_HOLD');
  if (table === 'STORE_STOCK' && (!/^\d+$/.test(value) || Number(value) > 999999)) bad('CK_SS_UNITS');
  if (table === 'FORKLIFTS' && !(Number(value) >= 0 && Number(value) <= 100)) bad('CK_FL_BATTERY');
  if (table === 'SIM_STATE' && column === 'PAUSED' && !['Y', 'N'].includes(value)) bad('CK_SIM_PAUSED');
  if (table === 'SIM_STATE' && column === 'SPEED' && !['1', '2', '4'].includes(value)) bad('CK_SIM_SPEED');
  if (table === 'PARK_BUILDINGS' && !['OPERATING', 'MAINTENANCE', 'VACANT', 'CONSTRUCTION'].includes(value)) bad('CK_PB_STATUS');
  if (table === 'TASKS' && !['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'].includes(value)) bad('CK_TASK_STATUS');
}
