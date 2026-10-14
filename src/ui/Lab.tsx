// Database Lab: four things you can only do because the city lives in Oracle.
//  - Control from SQL: change a row in SQL Developer, the city reacts (DB_COMMANDS + triggers)
//  - Time machine: Oracle Flashback Query shows the city as it was minutes ago
//  - Row-level security: Oracle VPD gives each database account only its own sites' rows
//  - Concurrency lab: two real sessions race each other (locks, lost updates, deadlocks)
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  History, Play, Pause, Rewind, FastForward, X, Terminal, ShieldCheck, Zap, Copy, Crosshair, Code2, RefreshCw, Radio, Lock,
  CheckCircle2, AlertTriangle, Undo2, Database, Clock3,
} from 'lucide-react';
import type { EntityRef } from '../data/types';
import type { LabStatus, SqlFeedItem, RowHistory, VpdReport, LabRun, LabScenario, LabStep, ExternalSqlResult } from '../api/types';
import { api } from '../api/client';
import { useApp, getLiveWorld } from '../store';
import { fmtClock } from './derive';
import { useData } from './DataTabs';

const fmtAgo = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const timeOf = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');

function locate(ref: EntityRef) {
  const s = useApp.getState();
  s.select(ref);
  window.setTimeout(() => s.camera({ kind: 'focus', ref }), 40);
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(() => useApp.getState().notify('Copied — paste it into SQL Developer')).catch(() => undefined);
}

let statusCache: { at: number; data: LabStatus } | null = null;
function useLabStatus(): LabStatus | null {
  const [s, setS] = useState<LabStatus | null>(statusCache?.data ?? null);
  useEffect(() => {
    if (statusCache && Date.now() - statusCache.at < 20000) return;
    api.labStatus().then((d) => { statusCache = { at: Date.now(), data: d }; setS(d); }).catch(() => undefined);
  }, []);
  return s;
}

// ================================================================ header button
export function TimeMachineButton() {
  const user = useApp((s) => s.user);
  const tt = useApp((s) => s.timeTravel);
  const open = useApp((s) => s.openTimeMachine);
  if (!user) return null;
  return (
    <button className={`icon-btn tm-btn ${tt.open ? 'on' : ''} ${tt.ago !== null ? 'past' : ''}`} onClick={() => open(!tt.open)}
      aria-label="Time machine" title="Time machine — see the city as it was (Oracle Flashback)">
      <History size={18} />
    </button>
  );
}

// ================================================================ the time machine bar
export function TimeBar() {
  const tt = useApp((s) => s.timeTravel);
  const travelTo = useApp((s) => s.travelTo);
  const openTm = useApp((s) => s.openTimeMachine);
  const setPlaying = useApp((s) => s.setPlaying);
  const db = useApp((s) => s.db);
  const status = useLabStatus();
  const max = status?.flashbackMaxS ?? 600;
  const [drag, setDrag] = useState<number | null>(null);
  const [showSql, setShowSql] = useState(false);
  const shown = drag ?? tt.ago ?? 0;

  useEffect(() => {
    if (drag === null) return;
    const t = window.setTimeout(() => { void travelTo(drag <= 0 ? null : drag); setDrag(null); }, 200);
    return () => window.clearTimeout(t);
  }, [drag, travelTo]);

  // replay: move forward through history at 4× (2 s of history every 0.5 s)
  useEffect(() => {
    if (!tt.playing) return;
    const t = window.setInterval(() => {
      const s = useApp.getState().timeTravel;
      if (s.loading) return;
      const next = (s.ago ?? 0) - 2;
      if (next <= 0) { void travelTo(null); return; }
      void travelTo(next);
    }, 500);
    return () => window.clearInterval(t);
  }, [tt.playing, travelTo]);

  if (!tt.open) return null;
  const f = tt.frame;
  const live = tt.ago === null && drag === null;
  const rows = f ? Object.values(f.rows).reduce((a, n) => a + n, 0) : 0;
  const ticks = Array.from({ length: Math.floor(max / 60) + 1 }, (_, i) => i * 60).reverse();
  const jump = (d: number) => { const next = Math.max(0, Math.min(max, (tt.ago ?? 0) + d)); void travelTo(next <= 0 ? null : next); };
  return (
    <div className={`tm-bar ${live ? '' : 'past'}`} role="region" aria-label="Time machine">
      <div className="tm-top">
        <div className="tm-now">
          {live ? (
            <><span className="tm-live"><Radio size={13} /> LIVE</span><span className="muted small">Drag left to travel back up to {Math.round(max / 60)} minutes</span></>
          ) : (
            <>
              <span className="tm-ago"><History size={14} /> {fmtAgo(shown)} ago</span>
              {f && <span className="tm-when">{timeOf(f.at)} · operations clock {fmtClock(f.simTime)}</span>}
              {tt.loading && <span className="muted small">reading…</span>}
            </>
          )}
        </div>
        <div className="tm-btns">
          <button className="sq" title="1 minute further back" onClick={() => jump(60)}><Rewind size={14} /></button>
          {tt.playing
            ? <button className="sq on" title="Pause replay" onClick={() => setPlaying(false)}><Pause size={14} /></button>
            : <button className="sq" title="Replay forward at 4× speed" disabled={live} onClick={() => setPlaying(true)}><Play size={14} /></button>}
          <button className="sq" title="1 minute forward" onClick={() => jump(-60)} disabled={live}><FastForward size={14} /></button>
          <button className="btn-ghost sm" disabled={live} onClick={() => { void travelTo(null); }}>Back to live</button>
          <button className="sq plain" title="Close the time machine" onClick={() => openTm(false)}><X size={15} /></button>
        </div>
      </div>
      <div className="tm-slider">
        <input type="range" min={-max} max={0} step={2} value={-shown} aria-label="Seconds into the past"
          onChange={(e) => { setPlaying(false); setDrag(-Number(e.target.value)); }} />
        <div className="tm-ticks">{ticks.map((s) => <span key={s} style={{ left: `${100 - (s / max) * 100}%` }}>{s === 0 ? 'now' : `−${s / 60}m`}</span>)}</div>
      </div>
      {!live && (
        <div className="tm-src">
          {f?.source === 'flashback' ? (
            <>
              <span className="badge sm tone-indigo"><Database size={11} /> Oracle Flashback Query</span>
              <span className="muted small">AS OF SCN <b>{f.scn?.toLocaleString()}</b> · {rows.toLocaleString()} rows from {Object.keys(f.rows).length} tables</span>
              <button className="link" onClick={() => setShowSql((x) => !x)}><Code2 size={12} /> {showSql ? 'Hide' : 'Show'} SQL</button>
            </>
          ) : f ? (
            <span className="muted small">{f.note ?? 'From the server\'s in-memory history'}{db !== 'oracle' ? '' : ''}</span>
          ) : null}
          {tt.error && <span className="err small">{tt.error}</span>}
        </div>
      )}
      {showSql && f?.sql.length ? <pre className="tm-sql">{f.sql.join(';\n\n')}</pre> : null}
    </div>
  );
}

// ================================================================ toasts for changes made in SQL
export function SqlToasts() {
  const feed = useApp((s) => s.sqlFeed);
  const [shown, setShown] = useState<SqlFeedItem[]>([]);
  const last = useRef<number | null>(null);
  useEffect(() => {
    const newest = feed[0]?.id ?? 0;
    if (last.current === null) { last.current = newest; return; }
    const fresh = feed.filter((x) => x.id > (last.current ?? 0));
    if (!fresh.length) return;
    last.current = newest;
    setShown((s) => [...fresh, ...s].slice(0, 3));
    const ids = new Set(fresh.map((x) => x.id));
    window.setTimeout(() => setShown((s) => s.filter((x) => !ids.has(x.id))), 9000);
  }, [feed]);
  if (!shown.length) return null;
  return (
    <div className="sql-toasts" aria-live="polite">
      {shown.map((x) => (
        <div key={x.id} className={`sql-toast ${x.status === 'REJECTED' ? 'bad' : ''}`}>
          <div className="st-head">
            <Terminal size={13} />
            <b>Changed in {x.program || 'an outside client'}</b>
            <span className="badge sm tone-indigo">{x.dbUser}</span>
            <button className="sq plain st-x" onClick={() => setShown((s) => s.filter((y) => y.id !== x.id))} aria-label="Dismiss"><X size={13} /></button>
          </div>
          <code className="st-sql">{x.table.toLowerCase()}.{x.column.toLowerCase()} [{x.key}]  {x.oldValue ?? '∅'} → {x.newValue ?? '∅'}</code>
          <div className="st-msg">{x.status === 'REJECTED' ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />} {x.message}</div>
          {x.ref && <button className="link" onClick={() => locate(x.ref!)}><Crosshair size={12} /> Show in 3D</button>}
        </div>
      ))}
    </div>
  );
}

// ================================================================ the Work panel tab
type LabView = 'control' | 'time' | 'security' | 'concurrency';

export function DbLabTab() {
  const [view, setView] = useState<LabView>('control');
  const status = useLabStatus();
  const views: { id: LabView; label: string; icon: JSX.Element }[] = [
    { id: 'control', label: 'Control from SQL', icon: <Terminal size={13} /> },
    { id: 'time', label: 'Time machine', icon: <History size={13} /> },
    { id: 'security', label: 'Row-level security', icon: <ShieldCheck size={13} /> },
    { id: 'concurrency', label: 'Concurrency lab', icon: <Zap size={13} /> },
  ];
  return (
    <div className="tab lab">
      <div className="lab-intro">
        <b>Database Lab</b>
        <span className="muted small">Four things the city can do only because it lives in {status?.engine === 'memory' ? 'a database (running without Oracle: simulated)' : 'Oracle'}.</span>
      </div>
      <div className="seg lab-seg">
        {views.map((v) => <button key={v.id} className={view === v.id ? 'on' : ''} onClick={() => setView(v.id)}>{v.icon} {v.label}</button>)}
      </div>
      {view === 'control' && <ControlView status={status} />}
      {view === 'time' && <TimeView status={status} />}
      {view === 'security' && <SecurityView status={status} />}
      {view === 'concurrency' && <ConcurrencyView status={status} />}
    </div>
  );
}

// ---------------------------------------------------------------- 1. control from SQL
interface Preset { id: string; label: string; sql: string; undo: string; what: string; oracleOnly?: boolean }
const PRESETS: Preset[] = [
  { id: 'berth', label: 'Close berth 1', sql: "UPDATE port_berths SET is_open = 'N' WHERE berth_code = 'B1'", undo: "UPDATE port_berths SET is_open = 'Y' WHERE berth_code = 'B1'",
    what: 'The ship alongside finishes; the next ship waits at anchor or goes to berth 2.' },
  { id: 'hold', label: 'Hold a ship', sql: "UPDATE vessels SET on_hold = 'Y' WHERE vessel_id = 'VSL-02'", undo: "UPDATE vessels SET on_hold = 'N' WHERE vessel_id = 'VSL-02'",
    what: 'Nordhavn Express stops wherever it is — at sea, at anchor or alongside.' },
  { id: 'shelf', label: 'Empty a shelf', sql: "UPDATE store_stock SET units = 0 WHERE store_id = 'ST-09' AND sku_id = 'BOX-M'", undo: "UPDATE store_stock SET units = 240 WHERE store_id = 'ST-09' AND sku_id = 'BOX-M'",
    what: 'Harbor Point Mall orders a restock; a van loads at Northgate DC and drives it over.' },
  { id: 'battery', label: 'Drain a forklift', sql: "UPDATE forklifts SET battery_pct = 6 WHERE forklift_id = 'FL-01'", undo: "UPDATE forklifts SET battery_pct = 90 WHERE forklift_id = 'FL-01'",
    what: 'FL-01 finishes its move, drives to its charger and an alert appears.' },
  { id: 'speed', label: 'Run 4× faster', sql: 'UPDATE sim_state SET speed = 4', undo: 'UPDATE sim_state SET speed = 1', what: 'The whole city speeds up.' },
  { id: 'mall', label: 'Close the mall', sql: "UPDATE park_buildings SET bldg_status = 'MAINTENANCE' WHERE building_id = 'PB-MALL'",
    undo: "UPDATE park_buildings SET bldg_status = 'OPERATING' WHERE building_id = 'PB-MALL'", what: 'Harbor Point Mall shows maintenance cones.' },
  { id: 'task', label: 'Create a task', oracleOnly: true,
    sql: "INSERT INTO tasks (facility_id, title, description, task_type, priority)\nVALUES ('WH-01', 'Check the leveler at Bay 2', 'Raised from SQL Developer', 'DOCK_CHECK', 'HIGH')",
    undo: "UPDATE tasks SET task_status = 'CANCELLED' WHERE title = 'Check the leveler at Bay 2' AND task_status = 'OPEN'", what: 'The task appears in the Tasks tab for Riverside Hub.' },
];

function ConnectBox({ status, user, note }: { status: LabStatus | null; user: string; note?: string }) {
  if (!status) return null;
  const c = status.connect;
  return (
    <div className="lab-connect">
      <div className="lc-title"><Database size={13} /> SQL Developer connection</div>
      <div className="lc-grid">
        <span>Host</span><code>{c.host}</code><span>Port</span><code>{c.port}</code>
        <span>Service name</span><code>{c.service}</code><span>User</span><code>{user}</code>
      </div>
      {note && <div className="muted small">{note}</div>}
    </div>
  );
}

function ControlView({ status }: { status: LabStatus | null }) {
  const feed = useApp((s) => s.sqlFeed);
  const follow = useApp((s) => s.followSql);
  const setFollow = useApp((s) => s.setFollowSql);
  const can = useApp((s) => s.can);
  const [sql, setSql] = useState(PRESETS[0].sql);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<(ExternalSqlResult & { applied: SqlFeedItem[] }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const oracle = status?.engine === 'oracle';
  const run = async (text = sql) => {
    setBusy(true); setErr(null); setRes(null);
    try { setRes(await api.labSql(text)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="lab-view">
      <p className="lab-lead">
        Change one of these tables <b>from outside the app</b> — in SQL Developer, SQL*Plus or below — and the city reacts within a second.
        Triggers (<code>trg_ext_*</code>) notice every change not made by this server and queue it in <code>db_commands</code>; the server applies the queue.
      </p>
      {status && !status.control && <div className="err">Not installed in this database yet: run <code>npm run db:lab</code> once (keeps your data), then restart the app.</div>}
      <div className="lab-presets">
        {PRESETS.filter((p) => oracle || !p.oracleOnly).map((p) => (
          <div key={p.id} className="preset">
            <div className="preset-head"><b>{p.label}</b><span className="muted small">{p.what}</span></div>
            <code className="preset-sql">{p.sql}</code>
            <div className="preset-btns">
              <button className="chip-btn" onClick={() => setSql(p.sql)}>Edit</button>
              <button className="chip-btn" onClick={() => copy(`${p.sql};\nCOMMIT;`)}><Copy size={11} /> Copy for SQL Developer</button>
              {can('RUN_SQL') && <button className="chip-btn" disabled={busy} onClick={() => { setSql(p.sql); void run(p.sql); }}><Play size={11} /> Run</button>}
              {can('RUN_SQL') && <button className="chip-btn" disabled={busy} onClick={() => { setSql(p.undo); void run(p.undo); }}><Undo2 size={11} /> Undo</button>}
            </div>
          </div>
        ))}
      </div>
      {can('RUN_SQL') ? (
        <div className="lab-run">
          <textarea className="sql-input lab-sql" spellCheck={false} value={sql} onChange={(e) => setSql(e.target.value)} aria-label="SQL statement"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(); } }} />
          <div className="sql-bar">
            <button className="btn-primary sm" disabled={busy || !sql.trim()} onClick={() => { void run(); }}><Play size={13} /> {busy ? 'Running…' : 'Run as an outside client'}</button>
            <span className="muted small">{oracle ? 'Runs on its own Oracle session (module “CargoVerse SQL Lab”), commits, and the triggers queue it — exactly like SQL Developer.' : 'Without Oracle: simple UPDATE … SET … WHERE … statements are understood.'}</span>
          </div>
          {err && <div className="err">{err}</div>}
          {res && (
            <div className="lab-result">
              <CheckCircle2 size={14} className="ok" /> {res.rowsAffected} row{res.rowsAffected === 1 ? '' : 's'} changed and committed in {res.ms} ms ·{' '}
              {res.applied.length ? `${res.applied.length} change${res.applied.length === 1 ? '' : 's'} applied to the city` : 'nothing for the city to apply (no steering column changed)'}
            </div>
          )}
        </div>
      ) : (
        <div className="muted small">Copy a statement into SQL Developer, run it, then <b>COMMIT</b> — SQL Developer does not commit on its own.</div>
      )}
      <ConnectBox status={status} user={`${status?.connect.schema ?? 'waretrack'} (schema owner)`} note="SQL Developer does not commit automatically: run COMMIT (F11) after your UPDATE, or nothing happens — that is transactions at work." />
      <div className="rep-title">Changes applied from SQL <label className="chk lab-follow"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Fly the camera to each change</label></div>
      {!feed.length && <div className="empty small">Nothing yet. Run a statement above or in SQL Developer.</div>}
      <div className="feed-list">
        {feed.map((x) => (
          <div key={x.id} className={`feed-row ${x.status === 'REJECTED' ? 'bad' : ''}`}>
            <span className="muted small">{timeOf(x.appliedAt)}</span>
            <span className="feed-who"><b>{x.program || 'outside client'}</b><span className="muted small"> · {x.dbUser}{x.host ? ` @ ${x.host}` : ''}</span></span>
            <code>{x.table.toLowerCase()}.{x.column.toLowerCase()} [{x.key}] {x.oldValue ?? '∅'} → {x.newValue ?? '∅'}</code>
            <span className="feed-msg">{x.message}</span>
            {x.ref && <button className="sq plain" title="Show in 3D" onClick={() => locate(x.ref!)}><Crosshair size={13} /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 2. time machine
const HISTORY_KINDS: { kind: string; label: string }[] = [
  { kind: 'vessel', label: 'Ship' }, { kind: 'berth', label: 'Berth' }, { kind: 'crane', label: 'Quay crane' }, { kind: 'truck', label: 'Truck' },
  { kind: 'forklift', label: 'Forklift' }, { kind: 'dock', label: 'Dock' }, { kind: 'van', label: 'Delivery van' },
];

function TimeView({ status }: { status: LabStatus | null }) {
  const openTm = useApp((s) => s.openTimeMachine);
  const travelTo = useApp((s) => s.travelTo);
  const selection = useApp((s) => s.selection);
  const startKind: string = selection && HISTORY_KINDS.some((k) => k.kind === selection.kind) ? selection.kind : 'vessel';
  const [kind, setKind] = useState<string>(startKind);
  const options = useMemo(() => {
    const w = getLiveWorld();
    switch (kind) {
      case 'vessel': return Object.values(w.port?.vessels ?? {}).map((v) => ({ id: v.id, label: `${v.name} (${v.id})` }));
      case 'berth': return Object.values(w.port?.berths ?? {}).map((b) => ({ id: b.id, label: b.name }));
      case 'crane': return Object.values(w.port?.cranes ?? {}).map((c) => ({ id: c.id, label: c.id }));
      case 'truck': return Object.values(w.trucks).map((t) => ({ id: t.id, label: `${t.id} · ${t.facilityId}` }));
      case 'forklift': return Object.values(w.forklifts).map((f) => ({ id: f.id, label: `${f.id} · ${f.facilityId}` }));
      case 'dock': return Object.values(w.docks).map((d) => ({ id: d.id, label: `${d.name} · ${d.facilityId}` }));
      case 'van': return Object.values(w.retail?.vans ?? {}).map((v) => ({ id: v.id, label: `${v.id} · ${v.plate}` }));
      default: return [];
    }
  }, [kind]);
  const [id, setId] = useState<string>(selection && selection.kind === startKind ? selection.id : '');
  const target = options.some((o) => o.id === id) ? id : options[0]?.id ?? '';
  const [n, setN] = useState(0);
  const hist = useData<RowHistory | null>(() => (target ? api.labHistory(kind, target) : Promise.resolve(null)), [kind, target, n]);
  const h = hist.data;
  return (
    <div className="lab-view">
      <p className="lab-lead">
        Oracle keeps the old versions of every changed row for a while (undo data). <b>Flashback Query</b> reads the whole city
        <code> AS OF</code> a moment in the past; <b>Flashback Versions Query</b> lists every version of one row. No history table, no extra code.
      </p>
      <div className="toolbar">
        <button className="btn-primary sm" onClick={() => openTm(true)}><History size={13} /> Open the time machine</button>
        <button className="btn-ghost sm" onClick={() => { openTm(true); void travelTo(120); }}>Jump 2 minutes back</button>
        <span className="muted small">{status?.engine === 'oracle' ? `Up to ${Math.round((status?.flashbackMaxS ?? 600) / 60)} minutes back, as far as Oracle's undo data reaches.` : `Without Oracle: the server's in-memory history (${status?.historyFrames ?? 0} snapshots).`}</span>
      </div>
      <div className="rep-title">Row history <code>VERSIONS BETWEEN TIMESTAMP … AND SYSTIMESTAMP</code></div>
      <div className="toolbar">
        <select className="sel" value={kind} onChange={(e) => { setKind(e.target.value); setId(''); }} aria-label="Kind of thing">
          {HISTORY_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
        <select className="sel" value={target} onChange={(e) => setId(e.target.value)} aria-label="Which one">
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <button className="sq" title="Refresh" onClick={() => setN((x) => x + 1)}><RefreshCw size={13} /></button>
        {h && <span className={`badge sm ${h.source === 'flashback' ? 'tone-indigo' : 'tone-grey'}`}>{h.source === 'flashback' ? 'Oracle Flashback' : 'in-memory history'}</span>}
      </div>
      {hist.error && <div className="err">{hist.error}</div>}
      {h?.note && <div className="muted small">{h.note}</div>}
      {h && (
        <div className="sql-grid">
          <table className="tbl sql-tbl hist-tbl">
            <thead><tr><th>From</th><th>Until</th>{h.columns.map((c) => <th key={c}>{c.toLowerCase()}</th>)}<th>Versions</th></tr></thead>
            <tbody>
              {h.entries.slice().reverse().map((e, i) => (
                <tr key={i} className={i === 0 && !e.to ? 'current' : ''}>
                  <td>{e.from ? timeOf(e.from) : <span className="muted">before</span>}</td>
                  <td>{e.to ? timeOf(e.to) : <b>now</b>}</td>
                  {h.columns.map((c) => <td key={c} className={e.values[c] === null ? 'null' : ''}>{e.values[c] === null ? '∅' : String(e.values[c])}</td>)}
                  <td className="muted">{e.versions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {h?.sql && <pre className="tm-sql">{h.sql}</pre>}
    </div>
  );
}

// ---------------------------------------------------------------- 3. row-level security
function SecurityView({ status }: { status: LabStatus | null }) {
  const [n, setN] = useState(0);
  const rep = useData<VpdReport>(() => api.labVpd(), [n]);
  const r = rep.data;
  const tables = r ? Object.keys(r.owner) : [];
  const installed = status?.vpd.installed ?? false;
  return (
    <div className="lab-view">
      <p className="lab-lead">
        The <b>same query</b>, run by four different Oracle accounts. A Virtual Private Database policy (<code>wt_security.site_filter</code>) adds a
        <code> WHERE facility_id IN (…)</code> to every statement on {status?.vpd.tables.length ?? 15} tables, from each account's site access in <code>user_facility_access</code>.
        The application is not involved — an operator in SQL Developer cannot see the other sites, whatever query they write.
      </p>
      {status && !installed && status.engine === 'oracle' && <div className="err">{status.vpd.reason}</div>}
      <div className="toolbar">
        <button className="btn-ghost sm" onClick={() => setN((x) => x + 1)}><RefreshCw size={13} /> Run again</button>
        {r && <span className={`badge sm ${r.source === 'oracle' ? 'tone-indigo' : 'tone-grey'}`}>{r.source === 'oracle' ? 'Real Oracle sessions' : 'Simulated without Oracle'}</span>}
        {r && <span className="muted small">Each row = a separate login as that account · {new Date(r.at).toLocaleTimeString()}</span>}
      </div>
      {rep.error && <div className="err">{rep.error}</div>}
      {r && (
        <div className="sql-grid">
          <table className="tbl sql-tbl vpd-tbl">
            <thead>
              <tr><th>Oracle account</th><th>Oracle adds</th>{tables.map((t) => <th key={t}>{t.toLowerCase()}</th>)}<th>Sites it sees</th></tr>
            </thead>
            <tbody>
              <tr className="owner">
                <td><b>{status?.connect.schema.toUpperCase() ?? 'WARETRACK'}</b><div className="muted small">schema owner · the server</div></td>
                <td><span className="muted">no filter</span></td>
                {tables.map((t) => <td key={t}><b>{r.owner[t]}</b></td>)}
                <td>all</td>
              </tr>
              {r.accounts.map((a) => (
                <tr key={a.account}>
                  <td><b>{a.account}</b><div className="muted small">{a.appUser} · {a.role.toLowerCase()}</div></td>
                  <td>{a.error ? <span className="err small">{a.error}</span> : a.predicate ? <code className="pred">{a.predicate}</code> : <span className="muted">no filter</span>}</td>
                  {tables.map((t) => (
                    <td key={t}>
                      {a.error ? '—' : (
                        <div className="vpd-cell">
                          <b>{a.counts[t] ?? 0}</b>
                          <span className="vpd-bar"><span style={{ width: `${r.owner[t] ? Math.round(((a.counts[t] ?? 0) / r.owner[t]) * 100) : 0}%` }} /></span>
                        </div>
                      )}
                    </td>
                  ))}
                  <td>{a.sitesSeen.length ? a.sitesSeen.join(', ') : a.error ? '—' : 'none'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="lab-connect">
        <div className="lc-title"><Lock size={13} /> Try it yourself in SQL Developer</div>
        <div className="muted small">
          New connection → user <code>cv_zoe</code> (forklift operator, Southfield) or <code>cv_alex</code>, <code>cv_meera</code>, <code>cv_admin</code> · password{' '}
          {status?.accountPassword ? <code>{status.accountPassword}</code> : <i>ask your administrator</i>} · host <code>{status?.connect.host ?? 'localhost'}</code>,
          port <code>{status?.connect.port ?? 1521}</code>, service <code>{status?.connect.service ?? 'FREEPDB1'}</code>. Then run:
        </div>
        <code className="preset-sql">SELECT facility_id, COUNT(*) FROM trucks GROUP BY facility_id;</code>
        <div className="preset-btns"><button className="chip-btn" onClick={() => copy('SELECT facility_id, COUNT(*) FROM trucks GROUP BY facility_id;')}><Copy size={11} /> Copy</button></div>
      </div>
      {r && <pre className="tm-sql">{`-- the query every account runs\n${r.sql}`}</pre>}
    </div>
  );
}

// ---------------------------------------------------------------- 4. concurrency lab
const SCENARIOS: { id: LabScenario; title: string; text: string; tone: string }[] = [
  { id: 'double_booking', title: 'Double booking', text: 'Two managers book dock slot 14:00 at the same moment. A row lock and a unique key make sure only one wins.', tone: 'green' },
  { id: 'lost_update', title: 'Lost update', text: 'Two tills read the stock, both subtract, both write back. Without a lock one sale vanishes.', tone: 'red' },
  { id: 'safe_update', title: 'The fix: FOR UPDATE', text: 'Same two tills, but they lock the row while reading. The second waits — and both sales count.', tone: 'green' },
  { id: 'deadlock', title: 'Deadlock', text: 'Two sessions each hold a row the other needs. Oracle detects the cycle and breaks it.', tone: 'orange' },
];

function Timeline({ run }: { run: LabRun }) {
  const total = Math.max(run.ms, 1);
  const lanes = (['A', 'B', 'DB'] as LabStep['session'][]).filter((l) => run.steps.some((s) => s.session === l));
  const ticks = Array.from({ length: 5 }, (_, i) => (total * i) / 4);
  const pct = (t: number) => `${Math.min(100, Math.max(0, (t / total) * 100))}%`;
  return (
    <div className="tl">
      {lanes.map((lane) => (
        <div key={lane} className="tl-lane">
          <div className="tl-label">{lane === 'DB' ? 'Oracle' : `Session ${lane}`}</div>
          <div className="tl-track">
            {run.steps.filter((s) => s.session === lane).map((s, i) => (
              s.kind === 'wait' && s.end !== undefined
                ? <span key={i} className="tl-wait" style={{ left: pct(s.t), width: `calc(${pct(s.end)} - ${pct(s.t)})` }} title={s.text}><Clock3 size={10} /> waiting {((s.end - s.t) / 1000).toFixed(1)} s</span>
                : <span key={i} className={`tl-dot k-${s.kind}`} style={{ left: pct(s.t) }} title={`${(s.t / 1000).toFixed(2)} s · ${s.text}`} />
            ))}
          </div>
        </div>
      ))}
      <div className="tl-axis">{ticks.map((t) => <span key={t} style={{ left: pct(t) }}>{(t / 1000).toFixed(1)} s</span>)}</div>
    </div>
  );
}

function ConcurrencyView({ status }: { status: LabStatus | null }) {
  const [run, setRun] = useState<LabRun | null>(null);
  const [busy, setBusy] = useState<LabScenario | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async (sc: LabScenario) => {
    setBusy(sc); setErr(null);
    try { setRun(await api.labRun(sc)); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  return (
    <div className="lab-view">
      <p className="lab-lead">
        Each experiment opens <b>two real database sessions</b> and runs them against each other on the sandbox tables <code>dock_bookings</code> and
        <code> lab_stock</code>, with the exact timing shown below. Locks, waits and errors come from Oracle itself.
      </p>
      {status && !status.concurrency && <div className="err">Not installed in this database yet: run <code>npm run db:lab</code>.</div>}
      <div className="lab-scen">
        {SCENARIOS.map((s) => (
          <button key={s.id} className={`scen ${run?.scenario === s.id ? 'on' : ''}`} disabled={!!busy} onClick={() => { void go(s.id); }}>
            <b>{s.title}</b>
            <span className="muted small">{s.text}</span>
            <span className={`scen-go tone-${s.tone}`}>{busy === s.id ? 'Running…' : <><Play size={11} /> Run</>}</span>
          </button>
        ))}
      </div>
      {err && <div className="err">{err}</div>}
      {run && (
        <div className="lab-runres">
          <div className={`verdict v-${run.verdict}`}>
            {run.verdict === 'anomaly' ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            <div><b>{run.title}</b><div>{run.outcome}</div></div>
            <span className={`badge sm ${run.source === 'oracle' ? 'tone-indigo' : 'tone-grey'}`}>{run.source === 'oracle' ? `Oracle · ${(run.ms / 1000).toFixed(1)} s` : 'simulated'}</span>
          </div>
          <Timeline run={run} />
          <div className="final-row">{run.final.map((f) => <div key={f.label} className="final"><span className="muted small">{f.label}</span><b>{f.value}</b></div>)}</div>
          <div className="steps">
            {run.steps.map((s, i) => (
              <div key={i} className={`step k-${s.kind}`}>
                <span className="muted small step-t">{(s.t / 1000).toFixed(2)} s</span>
                <span className={`step-who w-${s.session}`}>{s.session === 'DB' ? 'Oracle' : s.session}</span>
                <div className="step-body">
                  <span>{s.text}</span>
                  {s.sql && <code>{s.sql}</code>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
