// Work-panel tabs backed directly by Oracle: imports/exports through the park gates,
// the park tenant directory, and the Database workspace (schema browser, SQL console,
// saved report queries and the log of SQL the server runs).
import { useEffect, useMemo, useState } from 'react';
import { Database, Play, RefreshCw, Table2, Code2, Activity, ChevronRight, Search, Crosshair } from 'lucide-react';
import type { FacilityId } from '../data/types';
import type { GateEntry, TradeRow, DbOverview, DbTableDetail, SqlResult, SqlActivity, SavedQuery } from '../api/types';
import { api } from '../api/client';
import { useApp } from '../store';
import { getPark, findCompany } from '../data/parkClient';
import { GateRow } from './ParkPanels';

export function useData<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    fn().then((d) => { if (alive) { setData(d); setError(null); } }).catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

const fmtCell = (v: unknown): string => {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.replace('T', ' ').slice(0, 19);
  return String(v);
};

function ResultTable({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
  return (
    <div className="sql-grid">
      <table className="tbl sql-tbl">
        <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={v === null ? 'null' : ''}>{fmtCell(v)}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- imports & exports
export function TradeTab() {
  const user = useApp((s) => s.user)!;
  const version = useApp((s) => s.versions.gate);
  const [fac, setFac] = useState<FacilityId | 'ALL'>('ALL');
  const facility = fac === 'ALL' ? undefined : fac;
  const trade = useData<TradeRow[]>(() => api.trade(facility), [fac, version]);
  const log = useData<GateEntry[]>(() => api.gateLog({ facility, limit: 80 }), [fac, version]);
  const [filter, setFilter] = useState<'ALL' | 'IMPORT' | 'EXPORT' | 'EMPTY'>('ALL');
  const rows = (log.data ?? []).filter((r) => filter === 'ALL' || r.trade === filter);
  const select = useApp((s) => s.select);
  const camera = useApp((s) => s.camera);
  return (
    <div className="tab">
      <div className="toolbar">
        <select className="sel" value={fac} onChange={(e) => setFac(e.target.value as FacilityId | 'ALL')} aria-label="Site">
          <option value="ALL">All my sites</option>
          {user.facilities.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <div className="seg">
          {(['ALL', 'IMPORT', 'EXPORT', 'EMPTY'] as const).map((t) => (
            <button key={t} className={filter === t ? 'on' : ''} onClick={() => setFilter(t)}>{t === 'ALL' ? 'All' : t.charAt(0) + t.slice(1).toLowerCase()}</button>
          ))}
        </div>
        <button className="sq" title="Refresh" aria-label="Refresh" onClick={() => { trade.reload(); log.reload(); }}><RefreshCw size={14} /></button>
      </div>
      <div className="rep-title">Goods through the park gates today</div>
      <table className="tbl trade-tbl">
        <thead><tr><th>Site</th><th>Imports</th><th>Pallets in</th><th>Exports</th><th>Pallets out</th><th>Balance</th></tr></thead>
        <tbody>
          {(trade.data ?? []).map((t) => (
            <tr key={t.facilityId}>
              <td><b>{t.facilityId}</b> <span className="muted">{t.name}</span></td>
              <td className="imp">{t.importTrucks}</td><td>{t.importPallets}</td>
              <td className="exp">{t.exportTrucks}</td><td>{t.exportPallets}</td>
              <td className={t.importPallets - t.exportPallets >= 0 ? 'imp' : 'exp'}>{t.importPallets - t.exportPallets >= 0 ? '+' : ''}{t.importPallets - t.exportPallets}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="trade-gates">
        <button className="btn-ghost sm" onClick={() => { select({ kind: 'gate', id: 'WEST' }); camera({ kind: 'focus', ref: { kind: 'gate', id: 'WEST' } }); }}><Crosshair size={13} /> West Gate (imports)</button>
        <button className="btn-ghost sm" onClick={() => { select({ kind: 'gate', id: 'EAST' }); camera({ kind: 'focus', ref: { kind: 'gate', id: 'EAST' } }); }}><Crosshair size={13} /> East Gate (exports)</button>
      </div>
      <div className="rep-title">Gate log <span className="muted small">newest first · click a row to find the truck</span></div>
      {(trade.error || log.error) && <div className="err">{trade.error ?? log.error}</div>}
      <div className="gate-rows">{rows.map((r) => <GateRow key={r.id} r={r} />)}</div>
      {log.data && !rows.length && <div className="empty small">No gate movements match.</div>}
    </div>
  );
}

// ---------------------------------------------------------------- park directory
export function ParkTab() {
  useApp((s) => s.parkVersion);
  const select = useApp((s) => s.select);
  const camera = useApp((s) => s.camera);
  const [q, setQ] = useState('');
  const park = getPark();
  const list = park.buildings.filter((b) => {
    const c = findCompany(b.companyId);
    return !q || `${b.name} ${c?.name} ${c?.industry} ${b.kind} ${b.street}`.toLowerCase().includes(q.toLowerCase());
  });
  const totalStaff = park.buildings.reduce((n, b) => n + b.staff, 0);
  return (
    <div className="tab">
      <div className="toolbar">
        <span className="search-in"><Search size={13} /><input className="inp" placeholder="Search tenants, buildings…" value={q} onChange={(e) => setQ(e.target.value)} /></span>
        <span className="muted small">{park.companies.length} companies · {park.buildings.length} buildings · {totalStaff.toLocaleString()} staff · {park.vehicles.length} vehicles</span>
      </div>
      <div className="rep-title">Harborside Logistics Park directory</div>
      <table className="tbl park-tbl">
        <thead><tr><th>Building</th><th>Tenant</th><th>Type</th><th>Staff</th><th>Status</th><th>Lease ends</th></tr></thead>
        <tbody>
          {list.map((b) => {
            const c = findCompany(b.companyId);
            return (
              <tr key={b.id} className="click" onClick={() => {
                const ref = b.facilityId ? { kind: 'facility' as const, id: b.facilityId } : { kind: 'building' as const, id: b.id };
                select(ref);
                setTimeout(() => camera(b.facilityId ? { kind: 'home' } : { kind: 'focus', ref }), 30);
              }}>
                <td><b>{b.name}</b> <span className="muted small">{b.id}</span></td>
                <td><i className="dotc" style={{ background: c?.color }} />{c?.name}</td>
                <td>{b.kind.replace('_', ' ').toLowerCase()}</td>
                <td>{b.kind === 'PARKING' ? '—' : b.staff.toLocaleString()}</td>
                <td><span className={`badge sm tone-${b.status === 'OPERATING' ? 'green' : b.status === 'MAINTENANCE' ? 'orange' : 'grey'}`}>{b.status.toLowerCase()}</span></td>
                <td>{b.leaseEnd}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- database workspace
type DbView = 'schema' | 'sql' | 'activity';

export function DatabaseTab() {
  const can = useApp((s) => s.can);
  const db = useApp((s) => s.db);
  const sqlAllowed = can('RUN_SQL');
  const [view, setView] = useState<DbView>('schema');
  const overview = useData<DbOverview>(() => api.dbOverview(), []);
  return (
    <div className="tab db-tab">
      <div className="db-banner">
        <Database size={18} />
        <div>
          <b>{overview.data?.engine ?? (db === 'oracle' ? 'Oracle Database' : 'Database')}</b>
          <span className="muted small">Schema {overview.data?.schema ?? '…'} · {overview.data ? `${overview.data.tables.length} tables · ${overview.data.objects.filter((o) => o.type === 'VIEW').length} views · ${overview.data.objects.filter((o) => o.type === 'TRIGGER').length} triggers · ${overview.data.objects.filter((o) => o.type === 'PACKAGE').length} PL/SQL packages` : ''}</span>
        </div>
        <span className={`badge sm tone-${overview.data?.mode === 'oracle' ? 'green' : 'orange'}`}>{overview.data?.mode === 'oracle' ? 'Connected' : overview.data ? 'Not connected' : '…'}</span>
      </div>
      {overview.data?.note && <div className="setup-note small">{overview.data.note}</div>}
      <div className="seg db-seg">
        <button className={view === 'schema' ? 'on' : ''} onClick={() => setView('schema')}><Table2 size={13} /> Tables</button>
        {sqlAllowed && <button className={view === 'sql' ? 'on' : ''} onClick={() => setView('sql')}><Code2 size={13} /> SQL console</button>}
        {sqlAllowed && <button className={view === 'activity' ? 'on' : ''} onClick={() => setView('activity')}><Activity size={13} /> SQL activity</button>}
      </div>
      {overview.error && <div className="err">{overview.error}</div>}
      {view === 'schema' && overview.data && <SchemaBrowser o={overview.data} />}
      {view === 'sql' && sqlAllowed && <SqlConsole />}
      {view === 'activity' && sqlAllowed && <SqlActivityLog />}
    </div>
  );
}

function SchemaBrowser({ o }: { o: DbOverview }) {
  const [table, setTable] = useState<string | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, DbOverview['tables']>();
    for (const t of o.tables) { if (!m.has(t.group)) m.set(t.group, []); m.get(t.group)!.push(t); }
    return [...m.entries()];
  }, [o]);
  if (table) return <TableDetail name={table} onBack={() => setTable(null)} onOpen={setTable} />;
  const invalid = o.objects.filter((x) => x.status === 'INVALID');
  return (
    <div className="schema">
      {groups.map(([g, tabs]) => (
        <div key={g} className="schema-group">
          <div className="rep-title">{g}</div>
          <div className="table-list">
            {tabs.map((t) => (
              <button key={t.name} className="table-row" onClick={() => setTable(t.name)} title={t.comment || t.name}>
                <Table2 size={13} className="muted" /><b>{t.name.toLowerCase()}</b><span className="muted small">{t.rows.toLocaleString()} rows</span><ChevronRight size={13} className="muted" />
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="rep-title">Views, triggers and packages {invalid.length > 0 && <span className="badge sm tone-orange">{invalid.length} invalid</span>}</div>
      <div className="obj-list">
        {o.objects.map((x) => (
          <span key={x.type + x.name} className={`obj ${x.status === 'VALID' ? 'ok' : x.status === 'INVALID' ? 'bad' : ''}`} title={`${x.type} · ${x.status}`}>
            <span className="obj-type">{x.type === 'PACKAGE BODY' ? 'BODY' : x.type}</span>{x.name.toLowerCase()}
          </span>
        ))}
      </div>
    </div>
  );
}

function TableDetail({ name, onBack, onOpen }: { name: string; onBack: () => void; onOpen: (t: string) => void }) {
  const d = useData<DbTableDetail>(() => api.dbTable(name), [name]);
  return (
    <div className="schema">
      <button className="link small" onClick={onBack}>← All tables</button>
      <div className="rep-title"><code>{name.toLowerCase()}</code></div>
      {d.error && <div className="err">{d.error}</div>}
      {d.data && (
        <>
          <table className="tbl col-tbl">
            <thead><tr><th>Column</th><th>Type</th><th>Null?</th><th>Default</th></tr></thead>
            <tbody>
              {d.data.columns.map((c) => (
                <tr key={c.name}>
                  <td><b>{c.name.toLowerCase()}</b>{d.data!.constraints.some((k) => k.type === 'PRIMARY KEY' && k.columns.split(',').includes(c.name)) && <span className="badge sm tone-blue">PK</span>}
                    {d.data!.constraints.some((k) => k.type === 'FOREIGN KEY' && k.columns.split(',').includes(c.name)) && <span className="badge sm tone-indigo">FK</span>}</td>
                  <td><code>{c.type}</code></td><td>{c.nullable ? 'yes' : <b>not null</b>}</td><td className="muted small">{c.defaultValue ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="rep-title">Constraints</div>
          <div className="cons-list">
            {d.data.constraints.map((k) => {
              const ref = k.type === 'FOREIGN KEY' ? /→\s*(\w+)/.exec(k.detail)?.[1] : null;
              return (
                <div key={k.name} className="cons">
                  <span className={`badge sm tone-${k.type === 'PRIMARY KEY' ? 'blue' : k.type === 'FOREIGN KEY' ? 'indigo' : k.type === 'UNIQUE' ? 'green' : 'grey'}`}>{k.type}</span>
                  <code>{k.name.toLowerCase()}</code>
                  <span className="muted small">{k.columns.toLowerCase()} {ref ? '' : k.detail}</span>
                  {ref && <button className="link small" onClick={() => onOpen(ref)}>{k.detail}</button>}
                </div>
              );
            })}
          </div>
          {d.data.indexes.length > 0 && (
            <>
              <div className="rep-title">Indexes</div>
              <div className="cons-list">{d.data.indexes.map((i) => <div key={i.name} className="cons"><code>{i.name.toLowerCase()}</code><span className="muted small">{i.unique ? 'unique · ' : ''}{i.columns.toLowerCase()}</span></div>)}</div>
            </>
          )}
          <div className="rep-title">First rows</div>
          {d.data.sample.rows.length ? <ResultTable columns={d.data.sample.columns} rows={d.data.sample.rows} /> : <div className="empty small">No rows.</div>}
        </>
      )}
    </div>
  );
}

function SqlConsole() {
  const db = useApp((s) => s.db);
  const saved = useData<SavedQuery[]>(() => api.dbQueries(), []);
  const [sql, setSql] = useState('SELECT facility_id, name, imports_today, exports_today, pallet_balance\n  FROM v_trade_today\n ORDER BY facility_id');
  const [res, setRes] = useState<SqlResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setErr(null);
    try { setRes(await api.runSql(sql)); } catch (e) { setRes(null); setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="sql">
      <div className="sql-saved">
        <select className="sel" value="" onChange={(e) => { const q = saved.data?.find((x) => x.id === e.target.value); if (q) { setSql(q.sql); setRes(null); setErr(null); } }} aria-label="Saved queries">
          <option value="">Example queries from 05_reports.sql…</option>
          {(saved.data ?? []).map((q) => <option key={q.id} value={q.id}>{q.id}. {q.title}{q.description ? ` (${q.description})` : ''}</option>)}
        </select>
      </div>
      <textarea className="sql-input" spellCheck={false} value={sql} onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(); } }} aria-label="SQL statement" />
      <div className="sql-bar">
        <button className="btn-primary sm" disabled={busy || !sql.trim()} onClick={() => { void run(); }}><Play size={13} /> {busy ? 'Running…' : 'Run query'}</button>
        <span className="muted small">Read-only: one SELECT / WITH statement, run inside <code>SET TRANSACTION READ ONLY</code>, max 500 rows · Ctrl/⌘ + Enter</span>
      </div>
      {err && <div className="err sql-err">{err}{db !== 'oracle' ? '' : ''}</div>}
      {res && (
        <>
          <div className="muted small sql-meta">{res.rowCount} row{res.rowCount === 1 ? '' : 's'}{res.truncated ? ' (first 500)' : ''} · {res.ms} ms · recorded in the audit log</div>
          <ResultTable columns={res.columns} rows={res.rows} />
        </>
      )}
    </div>
  );
}

function SqlActivityLog() {
  const [all, setAll] = useState(false);
  const [n, setN] = useState(0);
  const log = useData<(SqlActivity & { source: string })[]>(() => api.dbActivity(all), [all, n]);
  useEffect(() => { const t = window.setInterval(() => setN((x) => x + 1), 3000); return () => window.clearInterval(t); }, []);
  return (
    <div className="sql-act">
      <div className="toolbar">
        <label className="chk"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Include live-operations writes (every 2 s)</label>
        <span className="muted small">Statements this server sent to Oracle, newest first</span>
      </div>
      {log.data && !log.data.length && <div className="empty small">No SQL has run yet{useApp.getState().db !== 'oracle' ? ' — the server is not connected to Oracle' : ''}.</div>}
      <div className="act-list">
        {(log.data ?? []).map((a, i) => (
          <div key={i} className={`act ${a.ok ? '' : 'bad'}`}>
            <span className="muted small">{new Date(a.at).toLocaleTimeString()}</span>
            <code>{a.sql}</code>
            <span className="muted small">{a.ms} ms · {a.rows} row{a.rows === 1 ? '' : 's'}{a.source === 'sim' ? ' · ops' : ''}</span>
            {a.error && <span className="err small">{a.error}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
