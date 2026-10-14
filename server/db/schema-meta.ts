// Reads db/oracle/01_schema.sql into a structured description of the schema
// (tables, columns, constraints, indexes, comments). Used by the Database tab
// when the server runs without Oracle, and by tests that check every SQL
// statement in the app only uses columns that exist.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DbColumn, DbConstraint } from '../../src/api/types';

export interface MetaTable {
  name: string;
  columns: DbColumn[];
  constraints: DbConstraint[];
  indexes: { name: string; columns: string; unique: boolean }[];
  comment: string;
}

export interface SchemaMeta {
  tables: Record<string, MetaTable>;
  views: string[];
  packages: string[];
  triggers: string[];
}

/** Split on commas that are not inside parentheses or quotes. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, q = false, cur = '';
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Text inside the parenthesis group that starts at index i (s[i] === '('). */
function group(s: string, i: number): { inner: string; end: number } {
  let depth = 0, q = false;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (ch === "'") q = !q;
    if (q) continue;
    if (ch === '(') depth++;
    if (ch === ')') { depth--; if (depth === 0) return { inner: s.slice(i + 1, j), end: j }; }
  }
  return { inner: s.slice(i + 1), end: s.length };
}

const stripComments = (s: string) => s.split('\n').map((l) => {
  let q = false;
  for (let i = 0; i < l.length - 1; i++) {
    if (l[i] === "'") q = !q;
    if (!q && l[i] === '-' && l[i + 1] === '-') return l.slice(0, i);
  }
  return l;
}).join('\n');

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function parseSchema(sqlText: string): SchemaMeta {
  const text = stripComments(sqlText);
  const meta: SchemaMeta = { tables: {}, views: [], packages: [], triggers: [] };
  const re = /CREATE\s+TABLE\s+(\w+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[1].toUpperCase();
    const g = group(text, m.index + m[0].length - 1);
    const t: MetaTable = { name, columns: [], constraints: [], indexes: [], comment: '' };
    for (const item of splitTop(g.inner)) {
      const it = norm(item);
      const tc = /^CONSTRAINT\s+(\w+)\s+(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK)\s*(.*)$/i.exec(it);
      if (tc) {
        const kind = tc[2].toUpperCase() as DbConstraint['type'];
        const rest = tc[3];
        const cols = kind === 'CHECK' ? '' : (/^\(([^)]*)\)/.exec(rest)?.[1] ?? '').toUpperCase().replace(/\s/g, '');
        t.constraints.push({ name: tc[1].toUpperCase(), type: kind, columns: cols, detail: kind === 'CHECK' ? rest : rest.replace(/^\([^)]*\)\s*/, '') });
        continue;
      }
      const cm = /^(\w+)\s+([A-Z0-9_]+(?:\s*\([^)]*\))?)(.*)$/i.exec(it);
      if (!cm) continue;
      const col = cm[1].toUpperCase();
      const rest = cm[3];
      const virtual = /GENERATED\s+ALWAYS\s+AS\s*\(/i.test(rest) && /VIRTUAL/i.test(rest);
      const identity = /GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i.exec(rest);
      const def = /DEFAULT\s+(.+?)(?:\s+NOT\s+NULL|\s+CONSTRAINT|$)/i.exec(rest);
      t.columns.push({
        name: col,
        type: cm[2].toUpperCase().replace(/\s+/g, '') + (virtual ? ' (virtual)' : identity ? ` (identity ${identity[1].toLowerCase().replace(/\s+/g, ' ')})` : ''),
        nullable: !/NOT\s+NULL/i.test(rest) && !/PRIMARY\s+KEY/i.test(rest),
        defaultValue: def ? def[1].trim() : null,
      });
      // inline constraints: CONSTRAINT name PRIMARY KEY | UNIQUE | REFERENCES t (c) | CHECK (...)
      const ic = /CONSTRAINT\s+(\w+)\s+(PRIMARY\s+KEY|UNIQUE|REFERENCES\s+(\w+)\s*\(([^)]*)\)(\s+ON\s+DELETE\s+CASCADE)?(\s+DEFERRABLE\s+INITIALLY\s+DEFERRED)?|CHECK\s*\(([^)]*)\))/gi;
      let c: RegExpExecArray | null;
      while ((c = ic.exec(rest))) {
        const word = c[2].toUpperCase();
        if (word.startsWith('PRIMARY')) t.constraints.push({ name: c[1].toUpperCase(), type: 'PRIMARY KEY', columns: col, detail: '' });
        else if (word === 'UNIQUE') t.constraints.push({ name: c[1].toUpperCase(), type: 'UNIQUE', columns: col, detail: '' });
        else if (word.startsWith('REFERENCES')) {
          t.constraints.push({ name: c[1].toUpperCase(), type: 'FOREIGN KEY', columns: col, detail: `→ ${c[3].toUpperCase()} (${c[4].toUpperCase().trim()})${c[5] ? ' ON DELETE CASCADE' : ''}${c[6] ? ' DEFERRABLE' : ''}` });
        } else t.constraints.push({ name: c[1].toUpperCase(), type: 'CHECK', columns: col, detail: `(${c[7]})` });
      }
    }
    meta.tables[name] = t;
    re.lastIndex = g.end;
  }
  // ALTER TABLE x ADD CONSTRAINT y FOREIGN KEY (c) REFERENCES t (c) ...
  const alt = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+CONSTRAINT\s+(\w+)\s+FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+(\w+)\s*\(([^)]*)\)([^;]*);/gi;
  while ((m = alt.exec(text))) {
    meta.tables[m[1].toUpperCase()]?.constraints.push({
      name: m[2].toUpperCase(), type: 'FOREIGN KEY', columns: m[3].toUpperCase().replace(/\s/g, ''),
      detail: `→ ${m[4].toUpperCase()} (${m[5].toUpperCase().trim()})${/DEFERRABLE/i.test(m[6]) ? ' DEFERRABLE' : ''}`,
    });
  }
  const idx = /CREATE\s+(UNIQUE\s+)?INDEX\s+(\w+)\s+ON\s+(\w+)\s*\(/gi;
  while ((m = idx.exec(text))) {
    const g = group(text, m.index + m[0].length - 1);
    meta.tables[m[3].toUpperCase()]?.indexes.push({ name: m[2].toUpperCase(), columns: norm(g.inner).toUpperCase(), unique: !!m[1] });
  }
  for (const t of Object.values(meta.tables)) {
    for (const c of t.constraints) {
      if (c.type === 'PRIMARY KEY' || c.type === 'UNIQUE') t.indexes.push({ name: c.name, columns: c.columns, unique: true });
    }
  }
  const com = /COMMENT\s+ON\s+TABLE\s+(\w+)\s+IS\s+'((?:[^']|'')*)'/gi;
  while ((m = com.exec(text))) { const t = meta.tables[m[1].toUpperCase()]; if (t) t.comment = m[2].replace(/''/g, "'"); }
  return meta;
}

export function parseObjects(plsql: string, views: string, meta: SchemaMeta): void {
  const pk = /CREATE\s+OR\s+REPLACE\s+PACKAGE\s+(BODY\s+)?(\w+)/gi;
  let m: RegExpExecArray | null;
  const pkgs = new Set<string>();
  while ((m = pk.exec(plsql))) pkgs.add(m[2].toUpperCase());
  meta.packages = [...pkgs];
  const tr = /CREATE\s+OR\s+REPLACE\s+TRIGGER\s+(\w+)/gi;
  while ((m = tr.exec(plsql))) meta.triggers.push(m[1].toUpperCase());
  const vw = /CREATE\s+OR\s+REPLACE\s+VIEW\s+(\w+)/gi;
  while ((m = vw.exec(views))) meta.views.push(m[1].toUpperCase());
}

let cached: SchemaMeta | null = null;
/** The schema as described by the project's SQL scripts. */
export function schemaMeta(dir = resolve(process.cwd(), 'db/oracle')): SchemaMeta {
  if (cached) return cached;
  const meta = parseSchema(readFileSync(resolve(dir, '01_schema.sql'), 'utf8'));
  parseObjects(readFileSync(resolve(dir, '02_plsql.sql'), 'utf8'), readFileSync(resolve(dir, '03_views.sql'), 'utf8'), meta);
  cached = meta;
  return meta;
}

/** Functional grouping of tables for the schema browser. */
export const TABLE_GROUPS: Record<string, string> = {
  ROLES: 'Security', PERMISSIONS: 'Security', ROLE_PERMISSIONS: 'Security', APP_USERS: 'Security', USER_FACILITY_ACCESS: 'Security', USER_SESSIONS: 'Security',
  JOB_TITLES: 'People', EMPLOYEES: 'People',
  FACILITIES: 'Sites & stock', SKUS: 'Sites & stock', INVENTORY: 'Sites & stock', DOCKS: 'Sites & stock', CHARGERS: 'Sites & stock', PALLETS: 'Sites & stock', STOCK_MOVEMENTS: 'Sites & stock',
  CARRIERS: 'Fleet & shipments', DRIVERS: 'Fleet & shipments', TRUCKS: 'Fleet & shipments', SHIPMENTS: 'Fleet & shipments', FORKLIFTS: 'Fleet & shipments',
  TASKS: 'Work', TASK_UPDATES: 'Work',
  OPERATION_EVENTS: 'History', AUDIT_LOG: 'History', SIM_STATE: 'History',
  PARK_COMPANIES: 'Logistics park', PARK_BUILDINGS: 'Logistics park', PARK_ROUTES: 'Logistics park', PARK_VEHICLES: 'Logistics park', PARK_GATES: 'Logistics park', PARK_GATE_LOG: 'Logistics park',
};

/** Read-only SQL guard: one SELECT / WITH statement, no trailing extras. Returns the cleaned statement. */
export function checkReadOnlySql(input: string): string {
  let sql = input.trim();
  // drop leading comments
  for (;;) {
    if (sql.startsWith('--')) { const nl = sql.indexOf('\n'); sql = nl < 0 ? '' : sql.slice(nl + 1).trim(); continue; }
    if (sql.startsWith('/*')) { const e = sql.indexOf('*/'); sql = e < 0 ? '' : sql.slice(e + 2).trim(); continue; }
    break;
  }
  sql = sql.replace(/;\s*$/, '').trim();
  if (!sql) throw new Error('Enter a SELECT statement to run.');
  if (!/^(SELECT|WITH)\b/i.test(sql)) throw new Error('Only queries are allowed here: the statement must start with SELECT or WITH.');
  // a second statement hidden after a semicolon (outside quotes and comments)
  let q = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") q = !q;
    else if (!q && ch === '-' && sql[i + 1] === '-') { const nl = sql.indexOf('\n', i); if (nl < 0) break; i = nl; }
    else if (!q && ch === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); if (e < 0) break; i = e + 1; }
    else if (!q && ch === ';') throw new Error('Run one statement at a time (remove the extra semicolon).');
  }
  if (/\bFOR\s+UPDATE\b/i.test(sql)) throw new Error('SELECT … FOR UPDATE locks rows and is not allowed in the read-only console.');
  return sql;
}

/** Saved queries: the numbered examples in db/oracle/05_reports.sql. */
export function savedQueries(dir = resolve(process.cwd(), 'db/oracle')): { id: string; title: string; description: string; sql: string }[] {
  const text = readFileSync(resolve(dir, '05_reports.sql'), 'utf8');
  const out: { id: string; title: string; description: string; sql: string }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const h = /^--\s*(\d+)\.\s*(.+?)(?:\s*\(([^)]*)\))?\s*$/.exec(lines[i]);
    if (!h) continue;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith('--')) j++; // extra comment lines
    for (; j < lines.length; j++) {
      body.push(lines[j]);
      if (/;\s*$/.test(lines[j])) break;
    }
    const sql = body.join('\n').replace(/;\s*$/, '').trim();
    if (/^(SELECT|WITH)\b/i.test(sql)) out.push({ id: h[1], title: h[2], description: h[3] ?? '', sql });
  }
  return out;
}
