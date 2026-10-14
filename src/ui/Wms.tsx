// Smart Warehouse: lot-level inventory with the database doing the thinking.
//   Overview · Slotting (ABC) · Lots & FEFO · Recall trace · Cold chain · Ledger · Forecast · Scan · Pick route · Search
// Every view shows where its answer comes from (Oracle SQL, or the server without Oracle).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Warehouse, LayoutGrid, CalendarClock, GitBranch, Thermometer, Link2, TrendingUp, ScanLine, Route, Search, Crosshair, Code2, RefreshCw,
  CheckCircle2, AlertTriangle, ShieldAlert, ShieldCheck, DoorOpen, DoorClosed, Camera, Database, Radio, Boxes, X, PackageX, Sparkles,
} from 'lucide-react';
import type { FacilityId, EntityRef } from '../data/types';
import type {
  WmsOverview, AbcReport, LotsReport, LotRow, TraceReport, ColdReport, SensorStatus, LedgerReport, ForecastReport, ReplenishReport, ScanResult,
  PalletLabel, RouteReport, SearchReport, WmsEvent, ReslotResult, Source, WmsFeatures,
} from '../api/wms-types';
import { api } from '../api/client';
import { useApp, type XrayMode } from '../store';
import { SKUS } from '../data/seed';
import { siteStorage, SKU_COLORS } from '../data/wms';
import { gs1Bits } from './barcode';
import { xrayCells, cellColor } from '../scene/XRay';
import { useData } from './DataTabs';

const FAC_NAMES: Record<string, string> = { 'WH-01': 'Riverside Hub', 'WH-02': 'Northgate DC', 'WH-04': 'Southfield Cross-Dock' };
const skuName = (id: string) => SKUS[id]?.name ?? id;
const timeOf = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const dayOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '—');

function locate(ref: EntityRef) {
  const s = useApp.getState();
  s.select(ref);
  window.setTimeout(() => s.camera({ kind: 'focus', ref }), 40);
}
/** Opens the building with its roof off (X-ray) and points the camera at it. */
export function showXray(facility: FacilityId, patch: Partial<{ mode: XrayMode; highlight: string[]; route: { facility: FacilityId; path: { x: number; z: number }[]; stops: string[] } | null }> = {}) {
  const s = useApp.getState();
  s.setXray({ facility, ...patch });
  if (s.facilityId !== facility) s.setFacility(facility);
  window.setTimeout(() => useApp.getState().camera({ kind: 'xray', facility }), 120);
}

function SourceBadge({ source, what }: { source: Source; what?: string }) {
  return source === 'oracle'
    ? <span className="badge sm tone-indigo"><Database size={11} /> {what ?? 'Oracle SQL'}</span>
    : <span className="badge sm tone-grey">computed by the server (no Oracle)</span>;
}
function SqlBox({ sql, label = 'Show the SQL' }: { sql: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="wms-sql">
      <button className="link" onClick={() => setOpen((x) => !x)}><Code2 size={12} /> {open ? 'Hide the SQL' : label}</button>
      {open && <pre className="tm-sql">{sql}</pre>}
    </div>
  );
}
function SitePicker({ value, onChange }: { value: FacilityId; onChange: (f: FacilityId) => void }) {
  const user = useApp((s) => s.user);
  return (
    <select className="wms-select" value={value} onChange={(e) => onChange(e.target.value as FacilityId)}>
      {(user?.facilities ?? []).map((f) => <option key={f} value={f}>{f} · {FAC_NAMES[f]}</option>)}
    </select>
  );
}
function useSite(): [FacilityId, (f: FacilityId) => void] {
  const user = useApp((s) => s.user);
  const cur = useApp((s) => s.facilityId);
  const [f, setF] = useState<FacilityId>(user?.facilities.includes(cur) ? cur : (user?.facilities[0] ?? 'WH-01'));
  return [f, setF];
}
function err(e: unknown) { useApp.getState().notify((e as Error).message, 'error'); }

// ================================================================ the Work panel tab
type View = 'overview' | 'abc' | 'lots' | 'trace' | 'cold' | 'ledger' | 'forecast' | 'scan' | 'route' | 'search';

export function WmsTab() {
  const [view, setView] = useState<View>('overview');
  const can = useApp((s) => s.can);
  const views: { id: View; label: string; icon: JSX.Element; show: boolean }[] = [
    { id: 'overview', label: 'Overview', icon: <Warehouse size={13} />, show: true },
    { id: 'abc', label: 'Slotting (ABC)', icon: <LayoutGrid size={13} />, show: can('VIEW_REPORTS') },
    { id: 'lots', label: 'Lots & FEFO', icon: <CalendarClock size={13} />, show: true },
    { id: 'trace', label: 'Recall trace', icon: <GitBranch size={13} />, show: can('VIEW_REPORTS') },
    { id: 'cold', label: 'Cold chain', icon: <Thermometer size={13} />, show: true },
    { id: 'ledger', label: 'Tamper-proof ledger', icon: <Link2 size={13} />, show: can('VIEW_REPORTS') },
    { id: 'forecast', label: 'Forecast & reorder', icon: <TrendingUp size={13} />, show: can('VIEW_REPORTS') },
    { id: 'scan', label: 'Scan (GS1)', icon: <ScanLine size={13} />, show: true },
    { id: 'route', label: 'Pick route', icon: <Route size={13} />, show: true },
    { id: 'search', label: 'Semantic search', icon: <Search size={13} />, show: true },
  ];
  return (
    <div className="tab lab wms">
      <div className="lab-intro">
        <b>Smart Warehouse</b>
        <span className="muted small">Every pallet has a lot, a bin and a GS1 label; the database decides what to pick, where to store it, and when to stop.</span>
      </div>
      <div className="seg lab-seg">
        {views.filter((v) => v.show).map((v) => <button key={v.id} className={view === v.id ? 'on' : ''} onClick={() => setView(v.id)}>{v.icon} {v.label}</button>)}
      </div>
      {view === 'overview' && <OverviewView go={setView} />}
      {view === 'abc' && <AbcView />}
      {view === 'lots' && <LotsView />}
      {view === 'trace' && <TraceView />}
      {view === 'cold' && <ColdView />}
      {view === 'ledger' && <LedgerView />}
      {view === 'forecast' && <ForecastView />}
      {view === 'scan' && <ScanView />}
      {view === 'route' && <RouteView />}
      {view === 'search' && <SearchView />}
    </div>
  );
}

// ---------------------------------------------------------------- overview
const FEATURE_ROWS: { key: keyof WmsFeatures | 'queue2'; label: string; detail: (f: WmsFeatures) => string; ok: (f: WmsFeatures) => boolean }[] = [
  { key: 'partitioned', label: 'Interval partitioning', detail: (f) => `SENSOR_READINGS: one partition per day (${f.partitions})`, ok: (f) => f.partitioned },
  { key: 'blockchain', label: 'Blockchain table', detail: () => 'STOCK_LEDGER: rows chained by SHA2-512, no update or delete', ok: (f) => f.blockchain },
  { key: 'vector', label: 'AI Vector Search', detail: (f) => `VECTOR(384) embeddings · ${f.embedModel}`, ok: (f) => f.vector },
  { key: 'queue', label: 'Transactional Event Queue', detail: (f) => f.queue ? `CV_EVENTS (${f.queue === 'TEQ' ? 'TxEventQ' : 'classic AQ'})` : 'not available — events read from WMS_EVENTS', ok: (f) => !!f.queue },
  { key: 'jobs', label: 'Scheduler jobs', detail: (f) => f.jobs.length ? f.jobs.join(', ') : 'none — the server runs the breach detector', ok: (f) => f.jobs.length > 0 },
  { key: 'graph', label: 'SQL property graph', detail: () => 'CV_WAREHOUSE_GRAPH over the aisle network (GRAPH_TABLE)', ok: (f) => f.graph },
];

function OverviewView({ go }: { go: (v: View) => void }) {
  const v = useApp((s) => s.wmsVersion);
  const [n, setN] = useState(0);
  const { data, error } = useData<WmsOverview>(() => api.wmsOverview(), [n]);
  useEffect(() => { const t = window.setInterval(() => setN((x) => x + 1), 5000); return () => window.clearInterval(t); }, []);
  void v;
  if (error) return <p className="err">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const f = data.features;
  return (
    <div className="lab-view">
      <div className="wms-sites">
        {data.sites.map((s) => (
          <div key={s.facilityId} className="wms-site">
            <div className="ws-head"><b>{FAC_NAMES[s.facilityId]}</b><span className="muted small">{s.facilityId}</span>
              <button className="chip-btn" onClick={() => showXray(s.facilityId)}><Boxes size={11} /> X-ray in 3D</button></div>
            <div className="ws-bar" title={`${s.occupied} of ${s.bins} bins in use`}><span style={{ width: `${(100 * s.occupied) / s.bins}%` }} /></div>
            <div className="ws-stats">
              <span><b>{s.occupied}</b>/{s.bins} bins</span>
              <span><b>{s.lots}</b> lots</span>
              <span className={s.held ? 'warn' : ''}><b>{s.held}</b> on hold</span>
              <span className={s.expiring ? 'warn' : ''}><b>{s.expiring}</b> expiring ≤30 d</span>
              <span><b>{s.metresPerPick ?? '—'}</b> m/pick</span>
              <span className={s.sensorsOut ? 'bad' : ''}><Thermometer size={11} /> {s.sensorsOut ? `${s.sensorsOut} out of range` : 'all in range'}</span>
            </div>
            <div className="muted small">Put-away: <b>{s.policy === 'ABC' ? 'ABC slotting' : 'random (as found)'}</b>{s.expectedMetresPerPick !== null ? ` · expected ${s.expectedMetresPerPick} m per pick` : ''}</div>
          </div>
        ))}
      </div>
      <div className="wms-two">
        <div className="wms-card">
          <div className="wc-title"><Database size={13} /> Oracle features in use <SourceBadge source={data.source} what={f.engine === 'oracle' ? 'this database' : undefined} /></div>
          {f.engine === 'oracle' ? FEATURE_ROWS.map((r) => (
            <div key={r.key} className={`feat ${r.ok(f) ? 'ok' : ''}`}>{r.ok(f) ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}<b>{r.label}</b><span className="muted small">{r.detail(f)}</span></div>
          )) : <p className="muted small">Without Oracle the server applies the same rules in memory. Start Oracle and run <code>npm run db:lab</code> for partitioning, the blockchain ledger, vector search, the event queue, scheduler jobs and the property graph.</p>}
          {f.note && <p className="muted small">{f.note}</p>}
        </div>
        <div className="wms-card">
          <div className="wc-title"><Radio size={13} /> Event stream <span className="muted small">{f.queue ? 'delivered by the Transactional Event Queue on commit' : f.engine === 'oracle' ? 'from WMS_EVENTS' : 'in memory'}</span></div>
          <EventList events={data.events.slice(0, 12)} go={go} />
        </div>
      </div>
    </div>
  );
}

const EVENT_ICON: Record<string, JSX.Element> = {
  BREACH: <Thermometer size={13} />, RECALL: <ShieldAlert size={13} />, RELEASE: <ShieldCheck size={13} />, SCAN: <ScanLine size={13} />, DAMAGE: <PackageX size={13} />,
  RESLOT: <LayoutGrid size={13} />, REORDER: <TrendingUp size={13} />, FEFO_OVERRIDE: <AlertTriangle size={13} />, LOT_RECEIVED: <Boxes size={13} />, DOOR: <DoorOpen size={13} />, QC_CHANGE: <Database size={13} />,
};
const latency = (e: WmsEvent) => Math.max(0, Date.parse(e.receivedAt) - Date.parse(e.at));
function EventList({ events, go }: { events: WmsEvent[]; go?: (v: View) => void }) {
  if (!events.length) return <p className="muted small">No events yet.</p>;
  const target: Record<string, View> = { BREACH: 'cold', DOOR: 'cold', RECALL: 'trace', RELEASE: 'lots', FEFO_OVERRIDE: 'lots', DAMAGE: 'search', RESLOT: 'abc', REORDER: 'forecast', SCAN: 'scan', LOT_RECEIVED: 'lots' };
  return (
    <div className="wms-events">
      {events.map((e) => (
        <button key={e.id} className={`wev t-${e.type}`} onClick={() => go && target[e.type] && go(target[e.type])}>
          <span className="wev-ico">{EVENT_ICON[e.type] ?? <Radio size={13} />}</span>
          <span className="wev-body"><b>{e.title}</b>{e.detail && <span className="muted small">{e.detail}</span>}</span>
          <span className="wev-meta muted small">{timeOf(e.at)}{e.via === 'queue' ? <><br />{latency(e)} ms via queue</> : null}</span>
        </button>
      ))}
    </div>
  );
}

export function WmsToasts() {
  const events = useApp((s) => s.wmsEvents);
  const [shown, setShown] = useState<WmsEvent[]>([]);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (seen.current === null) { seen.current = new Set(events.map((e) => e.id)); return; }
    const fresh = events.filter((e) => !seen.current!.has(e.id) && ['BREACH', 'RECALL', 'FEFO_OVERRIDE', 'QC_CHANGE'].includes(e.type));
    for (const e of events) seen.current.add(e.id);
    if (!fresh.length) return;
    setShown((s) => [...fresh, ...s].slice(0, 3));
    const ids = new Set(fresh.map((x) => x.id));
    window.setTimeout(() => setShown((s) => s.filter((x) => !ids.has(x.id))), 10000);
  }, [events]);
  if (!shown.length) return null;
  return (
    <div className="sql-toasts wms-toasts" aria-live="polite">
      {shown.map((e) => (
        <div key={e.id} className={`sql-toast ${e.type === 'BREACH' || e.type === 'RECALL' ? 'bad' : ''}`}>
          <div className="st-head">{EVENT_ICON[e.type] ?? <Radio size={13} />}<b>{e.title}</b>
            <button className="sq plain st-x" onClick={() => setShown((s) => s.filter((y) => y.id !== e.id))} aria-label="Dismiss"><X size={13} /></button></div>
          {e.detail && <div className="st-msg">{e.detail}</div>}
          <div className="muted small">{e.via === 'queue' ? `Oracle Transactional Event Queue · ${latency(e)} ms after commit` : e.via === 'table' ? 'From WMS_EVENTS' : 'Warehouse event'}</div>
          <button className="link" onClick={() => useApp.getState().openWork('wms')}>Open Smart Warehouse</button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- ABC slotting
function AbcView() {
  const [fac, setFac] = useSite();
  const can = useApp((s) => s.can);
  const v = useApp((s) => s.wmsVersion);
  const [n, setN] = useState(0);
  const { data, error } = useData<AbcReport>(() => api.wmsAbc(fac), [fac, n]);
  const [res, setRes] = useState<ReslotResult | null>(null);
  const [busy, setBusy] = useState(false);
  void v;
  const apply = async () => {
    setBusy(true);
    try { const r = await api.wmsReslot(fac); setRes(r); setN((x) => x + 1); showXray(fac, { mode: 'abc' }); } catch (e) { err(e); } finally { setBusy(false); }
  };
  return (
    <div className="lab-view">
      <p className="lab-lead">Fast movers belong next to the dock doors. <b>ABC analysis</b> ranks each product by the units picked in the last 30 days with
        analytic functions (<code>RATIO_TO_REPORT</code>, a running <code>SUM() OVER (ORDER BY …)</code>): class A makes up the first 80 % of the volume. Every bin knows its
        distance to the nearest dock over the aisle graph, so the expected walk per pick can be computed — and cut by re-slotting.</p>
      <div className="toolbar"><SitePicker value={fac} onChange={(f) => { setFac(f); setRes(null); }} />
        <button className="btn-ghost sm" onClick={() => showXray(fac, { mode: 'abc' })}><Boxes size={13} /> Heat map in 3D</button>
        {data && <SourceBadge source={data.source} />}</div>
      {error && <p className="err">{error}</p>}
      {data && (
        <>
          <div className="wms-kpis">
            <div><span className="muted small">Put-away rule</span><b>{data.policy === 'ABC' ? 'ABC slotting' : 'Random (as found)'}</b></div>
            <div><span className="muted small">Expected walk per pick</span><b>{data.expectedMetresPerPick ?? '—'} m</b></div>
            <div><span className="muted small">Measured (last picks)</span><b>{data.metresPerPick ?? '—'} m</b></div>
            {can('MANAGE_TASKS') && <button className="btn-primary sm" disabled={busy} onClick={() => { void apply(); }}><LayoutGrid size={13} /> {data.policy === 'ABC' ? 'Re-slot again' : 'Apply ABC slotting'}</button>}
          </div>
          {res && (
            <div className="lab-result"><CheckCircle2 size={14} className="ok" /> Moved {res.moved} pallets: expected walk per pick <b>{res.beforeMetres} m → {res.afterMetres} m</b>
              ({res.beforeMetres ? Math.round(100 - (100 * res.afterMetres) / res.beforeMetres) : 0} % less){res.taskId ? ` · task #${res.taskId} for the crew` : ''}. New pallets now go to their ABC zone.</div>
          )}
          <table className="tbl wms-tbl">
            <thead><tr><th>#</th><th>Product</th><th>Class</th><th>Units (30 d)</th><th>Share</th><th>Cumulative</th><th>Pallets</th><th>Avg. distance to dock</th></tr></thead>
            <tbody>{data.rows.map((r) => (
              <tr key={r.skuId}>
                <td>{r.rank}</td><td><span className="sku-dot" style={{ background: SKU_COLORS[r.skuId] }} />{r.skuName}</td>
                <td><span className={`abc abc-${r.abc}`}>{r.abc}</span></td><td>{r.units30d.toLocaleString()}</td>
                <td><div className="mini-bar"><span style={{ width: `${r.sharePct}%` }} /></div>{r.sharePct}%</td><td>{r.cumulativePct}%</td>
                <td>{r.pallets}</td><td>{r.avgDockMetres ?? '—'} m</td>
              </tr>))}</tbody>
          </table>
          <SqlBox sql={data.sql} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- lots and FEFO
function ExpiryBadge({ days }: { days: number | null }) {
  if (days === null) return <span className="muted small">no expiry</span>;
  const tone = days < 0 ? 'tone-orange' : days <= 7 ? 'tone-orange' : days <= 30 ? 'tone-yellow' : 'tone-green';
  return <span className={`badge sm ${tone}`}>{days < 0 ? `expired ${-days} d ago` : `${days} d`}</span>;
}
function QcBadge({ qc, reason }: { qc: string; reason?: string | null }) {
  return <span className={`badge sm ${qc === 'RELEASED' ? 'tone-green' : qc === 'HOLD' ? 'tone-yellow' : 'tone-orange'}`} title={reason ?? ''}>{qc === 'RELEASED' ? 'released' : qc === 'HOLD' ? 'on hold' : 'recalled'}</span>;
}
function LotActions({ lot, onDone }: { lot: LotRow; onDone: () => void }) {
  const can = useApp((s) => s.can);
  const [busy, setBusy] = useState(false);
  if (!can('MANAGE_TASKS')) return null;
  const recall = async () => {
    const reason = window.prompt(`Recall lot ${lot.lotId} (${lot.skuName})? Reason:`, 'Supplier quality notice');
    if (!reason) return;
    setBusy(true);
    try { const r = await api.wmsRecall(lot.lotId, reason); useApp.getState().notify(`Lot ${lot.lotId} recalled · ${r.stores} store(s) notified`); onDone(); } catch (e) { err(e); } finally { setBusy(false); }
  };
  const release = async () => {
    setBusy(true);
    try { await api.wmsRelease(lot.lotId); useApp.getState().notify(`Lot ${lot.lotId} released`); onDone(); } catch (e) { err(e); } finally { setBusy(false); }
  };
  return lot.qc === 'RELEASED'
    ? <button className="chip-btn danger" disabled={busy} onClick={() => { void recall(); }}><ShieldAlert size={11} /> Recall</button>
    : <button className="chip-btn" disabled={busy} onClick={() => { void release(); }}><ShieldCheck size={11} /> Release</button>;
}

function LotsView() {
  const v = useApp((s) => s.wmsVersion);
  const [n, setN] = useState(0);
  const { data, error } = useData<LotsReport>(() => api.wmsLots(), [n]);
  const [sku, setSku] = useState<string>('MED-INS');
  void v;
  const groups = useMemo(() => {
    const m = new Map<string, LotRow[]>();
    for (const l of data?.lots ?? []) if (l.skuId === sku || sku === '*') m.set(`${l.facilityId}:${l.skuId}`, [...(m.get(`${l.facilityId}:${l.skuId}`) ?? []), l]);
    return [...m.entries()];
  }, [data, sku]);
  const skus = useMemo(() => [...new Set((data?.lots ?? []).map((l) => l.skuId))].sort(), [data]);
  return (
    <div className="lab-view">
      <p className="lab-lead"><b>First expiry, first out.</b> Every pick takes the released lot that expires first (<code>WT_WMS.FEFO_LOT</code>; <code>RANK() OVER (PARTITION BY site, product
        ORDER BY expiry_date)</code> below). Lots on hold or recalled are skipped. <code>V_FEFO_VIOLATIONS</code> audits the ledger: any pick taken while an older-expiring lot still had stock appears there.</p>
      <div className="toolbar">
        <select className="wms-select" value={sku} onChange={(e) => setSku(e.target.value)}>
          <option value="*">All products</option>
          {skus.map((s) => <option key={s} value={s}>{skuName(s)}</option>)}
        </select>
        <button className="btn-ghost sm" onClick={() => setN((x) => x + 1)}><RefreshCw size={13} /> Refresh</button>
        {data && <SourceBadge source={data.source} />}
      </div>
      {error && <p className="err">{error}</p>}
      {groups.map(([k, lots]) => (
        <div key={k} className="wms-card">
          <div className="wc-title"><span className="sku-dot" style={{ background: SKU_COLORS[lots[0].skuId] }} />{lots[0].skuName} <span className="muted small">{lots[0].facilityId} · {FAC_NAMES[lots[0].facilityId]}</span>
            <button className="chip-btn" onClick={() => showXray(lots[0].facilityId as FacilityId, { mode: 'expiry' })}><Boxes size={11} /> Expiry in 3D</button></div>
          <table className="tbl wms-tbl">
            <thead><tr><th>FEFO</th><th>Lot</th><th>Expires</th><th>Status</th><th>Units</th><th>Pallets</th><th>Supplier</th><th /></tr></thead>
            <tbody>{lots.map((l) => (
              <tr key={l.lotId} className={l.fefoRank === 1 && l.qc === 'RELEASED' ? 'next' : ''}>
                <td>{l.fefoRank === 1 && l.qc === 'RELEASED' ? <span className="badge sm tone-blue">pick next</span> : l.fefoRank}</td>
                <td className="mono">{l.lotId}</td><td>{l.expiry ? <>{l.expiry} <ExpiryBadge days={l.daysToExpiry} /></> : <span className="muted small">—</span>}</td>
                <td><QcBadge qc={l.qc} reason={l.qcReason} /></td><td>{l.units.toLocaleString()}</td><td>{l.pallets}</td>
                <td className="ellipsis" title={`${l.supplier} · received ${dayOf(l.receivedAt)}${l.containerNo ? ` · container ${l.containerNo}` : ''}`}>{l.supplier}</td>
                <td><LotActions lot={l} onDone={() => setN((x) => x + 1)} /></td>
              </tr>))}</tbody>
          </table>
        </div>
      ))}
      <div className="wms-card">
        <div className="wc-title"><AlertTriangle size={13} /> FEFO audit <span className="muted small">picks that skipped an older-expiring lot</span></div>
        {data && !data.violations.length && <p className="muted small"><CheckCircle2 size={12} /> None — every pick so far took the right lot. Try it: in <b>Scan</b>, pick a pallet of a later lot by hand.</p>}
        {!!data?.violations.length && (
          <table className="tbl wms-tbl">
            <thead><tr><th>When</th><th>Product</th><th>Picked lot</th><th>Expires</th><th>Should have been</th><th>Expires</th><th>Units</th></tr></thead>
            <tbody>{data.violations.map((x) => <tr key={x.moveId}><td>{timeOf(x.pickedAt)}</td><td>{skuName(x.skuId)}</td><td className="mono">{x.pickedLot}</td><td>{x.pickedExpiry}</td><td className="mono">{x.olderLot}</td><td>{x.olderExpiry}</td><td>{x.units}</td></tr>)}</tbody>
          </table>
        )}
      </div>
      {data && <SqlBox sql={data.sql} />}
    </div>
  );
}

// ---------------------------------------------------------------- recall trace
const KIND_ICON: Record<string, string> = { VESSEL: '🚢', CONTAINER: '📦', SHIPMENT: '🚚', LOT: '🏷️', ORDER: '🧾', STORE: '🏪', CUSTOMER: '🏢' };
function TraceView() {
  const lotsQ = useData<LotsReport>(() => api.wmsLots(), []);
  const [kind, setKind] = useState('LOT');
  const [id, setId] = useState('');
  const [dir, setDir] = useState<'down' | 'up'>('down');
  const [data, setData] = useState<TraceReport | null>(null);
  const [busy, setBusy] = useState(false);
  const can = useApp((s) => s.can);
  // lots that have already gone somewhere first (most units shipped)
  const candidates = useMemo(() => (lotsQ.data?.lots ?? []).slice().sort((a, b) => (b.unitsReceived - b.units) - (a.unitsReceived - a.units) || b.receivedAt.localeCompare(a.receivedAt)), [lotsQ.data]);
  useEffect(() => { if (!id && candidates[0]) setId(candidates[0].lotId); }, [candidates, id]);
  const run = async (k = kind, i = id, d = dir) => {
    if (!i) return;
    setBusy(true);
    try {
      const r = await api.wmsTrace(k, i, d);
      setData(r);
      useApp.getState().setXray({ recallStores: r.stores });
    } catch (e) { err(e); } finally { setBusy(false); }
  };
  const lot = (lotsQ.data?.lots ?? []).find((l) => l.lotId === id);
  return (
    <div className="lab-view">
      <p className="lab-lead"><b>One query from a ship to the shelf.</b> A recursive <code>WITH</code> walks the genealogy view <code>V_TRACE_LINKS</code> (vessel → container → inbound
        shipment → lot → outbound shipment / store order → customer / store) with <code>SEARCH DEPTH FIRST</code> and <code>CYCLE</code> clauses. Down: where did it go? Up: where did it come from?</p>
      <div className="toolbar">
        <select className="wms-select" value={kind} onChange={(e) => setKind(e.target.value)}>
          {['LOT', 'CONTAINER', 'SHIPMENT', 'VESSEL', 'STORE', 'ORDER'].map((k) => <option key={k} value={k}>{k.toLowerCase()}</option>)}
        </select>
        {kind === 'LOT'
          ? <select className="wms-select" value={id} onChange={(e) => setId(e.target.value)}>{candidates.map((l) => <option key={l.lotId} value={l.lotId}>{l.lotId} · {l.skuName} · {l.facilityId}{l.unitsReceived > l.units ? ` · ${(l.unitsReceived - l.units).toLocaleString()} shipped` : ''}</option>)}</select>
          : <input className="wms-input" value={id} onChange={(e) => setId(e.target.value)} placeholder={kind === 'VESSEL' ? 'VSL-01' : kind === 'STORE' ? 'ST-02' : 'id'} />}
        <div className="seg"><button className={dir === 'down' ? 'on' : ''} onClick={() => setDir('down')}>Where did it go?</button><button className={dir === 'up' ? 'on' : ''} onClick={() => setDir('up')}>Where from?</button></div>
        <button className="btn-primary sm" disabled={busy || !id} onClick={() => { void run(); }}><GitBranch size={13} /> Trace</button>
      </div>
      {data && (
        <div className="wms-card">
          <div className="wc-title">{data.nodes.length - 1} linked records <SourceBadge source={data.source} what="Oracle recursive WITH" />
            {!!data.stores.length && <span className="badge sm tone-orange">{data.stores.length} store(s) received it</span>}</div>
          <div className="trace">
            {data.nodes.map((n) => (
              <div key={`${n.key}:${n.parent}`} className={`tr-node k-${n.kind}`} style={{ paddingLeft: 8 + n.depth * 22 }}>
                <span className="tr-ico">{KIND_ICON[n.kind] ?? '•'}</span><span className="tr-kind">{n.kind.toLowerCase()}</span><b>{n.label}</b>
                {n.units !== null && <span className="muted small">{n.units.toLocaleString()} units</span>}
                {n.ref && <button className="link" onClick={() => locate(n.ref!)}><Crosshair size={11} /> 3D</button>}
              </div>
            ))}
          </div>
          {data.nodes.length === 1 && <p className="muted small">Nothing linked yet{dir === 'down' ? ': this lot has not been picked or shipped. Pick a lot received earlier, or wait for vans to load it.' : '.'}</p>}
          {!!data.stores.length && <p className="muted small">The stores are ringed in red in the 3D town.</p>}
          {kind === 'LOT' && lot && can('MANAGE_TASKS') && lot.qc === 'RELEASED' && (
            <div><button className="btn-ghost sm danger" onClick={async () => {
              const reason = window.prompt(`Recall lot ${lot.lotId}? Reason:`, 'Supplier quality notice');
              if (!reason) return;
              try { const r = await api.wmsRecall(lot.lotId, reason); useApp.getState().notify(`Recalled · ${r.stores} store(s) notified, quarantine task created`); void lotsQ.reload(); void run(); } catch (e) { err(e); }
            }}><ShieldAlert size={13} /> Recall this lot</button></div>
          )}
          <SqlBox sql={data.sql} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- cold chain
function Spark({ s }: { s: SensorStatus }) {
  const W = 260, H = 64;
  const pts = s.series;
  if (pts.length < 2) return <svg className="spark" width={W} height={H} />;
  const lo = Math.min(s.minC - 1, ...pts.map((p) => p.c)), hi = Math.max(s.maxC + 1, ...pts.map((p) => p.c));
  const y = (c: number) => H - 4 - ((c - lo) / (hi - lo)) * (H - 8);
  const x = (i: number) => 2 + (i / (pts.length - 1)) * (W - 4);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join('');
  return (
    <svg className="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${s.id} temperature`}>
      <rect x={0} y={y(s.maxC)} width={W} height={y(s.minC) - y(s.maxC)} className="band" />
      <line x1={0} x2={W} y1={y(s.maxC)} y2={y(s.maxC)} className="limit" />
      <path d={d} className={s.status === 'OUT' ? 'line bad' : 'line'} />
    </svg>
  );
}
function ColdView() {
  const v = useApp((s) => s.wmsVersion);
  const can = useApp((s) => s.can);
  const [n, setN] = useState(0);
  const { data, error } = useData<ColdReport>(() => api.wmsCold(), [n]);
  useEffect(() => { const t = window.setInterval(() => setN((x) => x + 1), 4000); return () => window.clearInterval(t); }, []);
  void v;
  const door = async (id: string, open: boolean, seconds = 0) => { try { await api.wmsDoor(id, open, seconds); setN((x) => x + 1); } catch (e) { err(e); } };
  return (
    <div className="lab-view">
      <p className="lab-lead">Sensors report every 5 seconds into <code>SENSOR_READINGS</code>, <b>interval-partitioned</b> by day. A scheduler job runs <code>WT_WMS.DETECT_BREACHES</code> every
        15 s: <b><code>MATCH_RECOGNIZE</code></b> finds three or more readings in a row outside the range, records the breach, puts the affected lots <b>on hold</b> (FEFO skips them)
        and raises an urgent task — inside the database, even with no application running.</p>
      {error && <p className="err">{error}</p>}
      {data && (
        <>
          <div className="toolbar"><SourceBadge source={data.source} /><span className="muted small">{data.detector}</span></div>
          <div className="sensors">
            {data.sensors.map((s) => (
              <div key={s.id} className={`sensor st-${s.status.replace(' ', '')}`}>
                <div className="sn-head"><b>{s.id}</b><span className="muted small">{s.label} · {FAC_NAMES[s.facilityId]}</span></div>
                <div className="sn-temp"><Thermometer size={15} /> {s.tempC?.toFixed(1) ?? '—'} °C <span className="muted small">range {s.minC}–{s.maxC} °C</span>
                  {s.doorOpen && <span className="badge sm tone-orange"><DoorOpen size={11} /> door open</span>}</div>
                <Spark s={s} />
                {can('MANAGE_TASKS') && s.zone === 'COLD' && (
                  <div className="preset-btns">
                    <button className="chip-btn" onClick={() => { void door(s.id, true, 40); }}><DoorOpen size={11} /> Prop the door open 40 s</button>
                    {s.doorOpen
                      ? <button className="chip-btn" onClick={() => { void door(s.id, false); }}><DoorClosed size={11} /> Close door</button>
                      : <button className="chip-btn" onClick={() => { void door(s.id, true); }}><DoorOpen size={11} /> Leave it open</button>}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="wms-two">
            <div className="wms-card">
              <div className="wc-title"><AlertTriangle size={13} /> Breaches</div>
              {!data.breaches.length ? <p className="muted small">None. Prop a cold-room door open and watch: three readings above 8 °C make a breach.</p> : (
                <table className="tbl wms-tbl"><thead><tr><th>Sensor</th><th>Started</th><th>Ended</th><th>Peak</th><th>Readings</th><th>Lots held</th></tr></thead>
                  <tbody>{data.breaches.map((b) => <tr key={b.id} className={b.status === 'OPEN' ? 'open' : ''}><td>{b.sensorId}</td><td>{timeOf(b.startedAt)}</td><td>{b.endedAt ? timeOf(b.endedAt) : <span className="badge sm tone-orange">ongoing</span>}</td><td>{b.peakC.toFixed(1)} °C</td><td>{b.readings}</td><td>{b.lotsHeld}</td></tr>)}</tbody></table>
              )}
            </div>
            <div className="wms-card">
              <div className="wc-title"><ShieldAlert size={13} /> Lots on hold</div>
              {!data.held.length ? <p className="muted small">None.</p> : data.held.map((l) => (
                <div key={l.lotId} className="held"><span className="mono">{l.lotId}</span> {l.skuName} · {l.units} units<span className="muted small">{l.qcReason}</span><LotActions lot={l} onDone={() => setN((x) => x + 1)} /></div>
              ))}
              {!!data.partitions.length && (
                <>
                  <div className="wc-title" style={{ marginTop: 8 }}><Database size={13} /> Partitions of SENSOR_READINGS</div>
                  {data.partitions.map((p) => <div key={p.name} className="part"><span className="mono">{p.name}</span><span className="muted small">up to {p.highValue}</span><b>{p.rows?.toLocaleString() ?? '?'}</b></div>)}
                </>
              )}
            </div>
          </div>
          <SqlBox sql={data.sql} label="Show the MATCH_RECOGNIZE query" />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- tamper-proof ledger
function LedgerView() {
  const [n, setN] = useState(0);
  const { data, error } = useData<LedgerReport>(() => api.wmsLedger(), [n]);
  return (
    <div className="lab-view">
      <p className="lab-lead">Every stock movement is copied by a trigger into <code>STOCK_LEDGER</code>, an Oracle <b>blockchain table</b>: each row carries a SHA2-512 hash of its contents
        and of the previous row. Rows can be added but never changed, and not deleted for 16 days — not even by the schema owner. <code>DBMS_BLOCKCHAIN_TABLE.VERIFY_ROWS</code> recomputes the chain.</p>
      <div className="toolbar"><button className="btn-primary sm" onClick={() => setN((x) => x + 1)}><RefreshCw size={13} /> Verify again</button>{data && <SourceBadge source={data.source} what="Oracle blockchain table" />}</div>
      {error && <p className="err">{error}</p>}
      {data && (
        <>
          <div className="wms-kpis">
            <div><span className="muted small">Ledger</span><b>{data.kind === 'blockchain' ? 'Blockchain table' : data.kind === 'hash-chain' ? 'SHA-256 hash chain' : 'Plain table'}</b></div>
            <div><span className="muted small">Rows</span><b>{data.rows.toLocaleString()}</b></div>
            <div><span className="muted small">Verified</span><b>{data.verified?.toLocaleString() ?? '—'}</b></div>
            <div className={data.ok ? 'good' : data.ok === false ? 'bad' : ''}><span className="muted small">Chain</span><b>{data.ok ? <><CheckCircle2 size={14} /> intact</> : data.ok === false ? 'BROKEN' : '—'}</b></div>
            <div><span className="muted small">Took</span><b>{data.ms} ms</b></div>
          </div>
          {data.tamper && (
            <div className={`tamper ${data.tamper.blocked ? 'blocked' : 'open'}`}>
              <div><b>Tamper test:</b> <code>{data.tamper.attempted}</code></div>
              {data.tamper.blocked ? <div><ShieldCheck size={13} /> Refused: <span className="mono">{data.tamper.error}</span></div> : <div><AlertTriangle size={13} /> Allowed (rolled back) — this database has no blockchain tables.</div>}
            </div>
          )}
          {data.note && <p className="muted small">{data.note}</p>}
          <table className="tbl wms-tbl">
            <thead><tr><th>#</th><th>Move</th><th>Lot</th><th>Product</th><th>Units</th><th>Bin</th><th>Ref</th><th>At</th><th>Hash</th></tr></thead>
            <tbody>{data.recent.map((r) => <tr key={`${r.seq}:${r.moveId}`}><td>{r.seq}</td><td>{r.type}</td><td className="mono">{r.lotId}</td><td>{skuName(r.skuId)}</td><td>{r.units}</td><td className="mono">{r.binId ?? ''}</td><td className="mono">{r.refId ?? ''}</td><td>{timeOf(r.at)}</td><td className="mono hash">{r.hash ? `${r.hash.slice(0, 10)}…` : ''}</td></tr>)}</tbody>
          </table>
          <SqlBox sql={data.sql} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- forecast and replenishment
function ForecastChart({ data }: { data: ForecastReport }) {
  const W = 620, H = 180, P = 28;
  const pts = data.points;
  const max = Math.max(1, ...pts.map((p) => Math.max(p.actual ?? 0, p.forecast ?? 0))) * 1.1;
  const x = (i: number) => P + (i / Math.max(1, pts.length - 1)) * (W - P - 6);
  const y = (v: number) => H - 20 - (v / max) * (H - 30);
  const line = (key: 'actual' | 'forecast') => pts.map((p, i) => (p[key] === null ? null : `${x(i).toFixed(1)},${y(p[key]!).toFixed(1)}`)).filter(Boolean).join(' ');
  const today = pts.findIndex((p) => p.forecast !== null);
  return (
    <svg className="fc-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Demand and forecast">
      {[0, 0.5, 1].map((t) => <g key={t}><line x1={P} x2={W - 6} y1={y(max * t / 1.1)} y2={y(max * t / 1.1)} className="grid" /><text x={P - 4} y={y(max * t / 1.1) + 3} className="ax" textAnchor="end">{Math.round(max * t / 1.1)}</text></g>)}
      {today > 0 && <><line x1={x(today)} x2={x(today)} y1={8} y2={H - 20} className="today" /><text x={x(today) + 4} y={14} className="ax">today</text></>}
      <polyline points={line('actual')} className="act" />
      <polyline points={line('forecast')} className="fc" />
      {[0, Math.floor(pts.length / 2), pts.length - 1].map((i) => pts[i] && <text key={i} x={x(i)} y={H - 6} className="ax" textAnchor="middle">{pts[i].date.slice(5)}</text>)}
    </svg>
  );
}
function ForecastView() {
  const [fac, setFac] = useSite();
  const [sku, setSku] = useState('MED-INS');
  const fc = useData<ForecastReport>(() => api.wmsForecast(fac, sku), [fac, sku]);
  const rp = useData<ReplenishReport>(() => api.wmsReplenishment(), []);
  const can = useApp((s) => s.can);
  const rows = (rp.data?.rows ?? []);
  const siteSkus = rows.filter((r) => r.facilityId === fac).map((r) => r.skuId);
  useEffect(() => { if (siteSkus.length && !siteSkus.includes(sku)) setSku(siteSkus[0]); }, [siteSkus.join(','), sku]); // eslint-disable-line react-hooks/exhaustive-deps
  const r = fc.data?.replenish;
  return (
    <div className="lab-view">
      <p className="lab-lead">56 days of demand per product (<code>SKU_DAILY_DEMAND</code>, kept up to date by the ledger trigger). <code>REGR_SLOPE</code>/<code>REGR_INTERCEPT</code> fit the
        trend and the <b><code>MODEL</code> clause</b> projects it 14 days ahead, times each weekday's seasonal index. The <b>reorder point</b> = demand over the supplier lead time + safety stock
        (1.65·σ·√lead time, 95 % service); the order size is the <b>economic order quantity</b> √(2·D·S/H).</p>
      <div className="toolbar"><SitePicker value={fac} onChange={setFac} />
        <select className="wms-select" value={sku} onChange={(e) => setSku(e.target.value)}>{siteSkus.map((s) => <option key={s} value={s}>{skuName(s)}</option>)}</select>
        {fc.data && <SourceBadge source={fc.data.source} what="Oracle MODEL clause" />}</div>
      {fc.error && <p className="err">{fc.error}</p>}
      {fc.data && (
        <div className="wms-card">
          <div className="wc-title">{skuName(sku)} at {FAC_NAMES[fac]} <span className="muted small">trend {fc.data.slopePerDay !== null ? `${fc.data.slopePerDay > 0 ? '+' : ''}${fc.data.slopePerDay} units/day` : '—'}</span>
            <span className="legend"><i className="act" /> actual <i className="fc" /> forecast</span></div>
          <ForecastChart data={fc.data} />
          <div className="wk">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => <span key={d}><i style={{ height: `${Math.min(100, (fc.data!.weekday[i] ?? 1) * 50)}%` }} />{d}</span>)}</div>
          {r && (
            <div className="wms-kpis">
              <div><span className="muted small">On hand</span><b>{r.onHand.toLocaleString()}</b></div>
              <div><span className="muted small">Demand/day</span><b>{r.dailyDemand ?? '—'}</b></div>
              <div><span className="muted small">Safety stock</span><b>{r.safetyStock ?? '—'}</b></div>
              <div><span className="muted small">Reorder point</span><b>{r.reorderPoint?.toLocaleString() ?? '—'}</b></div>
              <div><span className="muted small">EOQ</span><b>{r.eoq?.toLocaleString() ?? '—'}</b></div>
              <div className={r.action === 'REORDER' ? 'bad' : 'good'}><span className="muted small">Cover</span><b>{r.daysOfCover ?? '—'} days</b></div>
            </div>
          )}
        </div>
      )}
      <div className="wms-card">
        <div className="wc-title">Replenishment, all products {can('MANAGE_TASKS') && <button className="btn-primary sm" onClick={async () => { try { const x = await api.wmsReorder(); useApp.getState().notify(`${x.raised} purchase-order task(s) raised`); } catch (e) { err(e); } }}>Raise purchase orders</button>}</div>
        <table className="tbl wms-tbl">
          <thead><tr><th>Site</th><th>Product</th><th>On hand</th><th>Demand/day</th><th>Lead time</th><th>Reorder point</th><th>EOQ</th><th>Cover</th><th /></tr></thead>
          <tbody>{rows.map((x) => <tr key={`${x.facilityId}:${x.skuId}`} className={x.action === 'REORDER' ? 'open' : ''}><td>{x.facilityId}</td><td>{x.skuName}</td><td>{x.onHand.toLocaleString()}</td><td>{x.dailyDemand}</td><td>{x.leadTimeDays} d</td><td>{x.reorderPoint?.toLocaleString()}</td><td>{x.eoq?.toLocaleString()}</td><td>{x.daysOfCover} d</td><td>{x.action === 'REORDER' ? <span className="badge sm tone-orange">reorder</span> : <span className="badge sm tone-green">ok</span>}</td></tr>)}</tbody>
        </table>
      </div>
      {fc.data && <SqlBox sql={fc.data.sql} />}
    </div>
  );
}

// ---------------------------------------------------------------- scanning
function Barcode({ sscc, w = 230 }: { sscc: string; w?: number }) {
  const bits = useMemo(() => gs1Bits(`00${sscc}`), [sscc]);
  const q = 10;
  const total = bits.length + 2 * q;
  return (
    <svg className="barcode" viewBox={`0 0 ${total} 44`} width={w} height={(w * 44) / total * 1.6} preserveAspectRatio="none" role="img" aria-label={`GS1-128 (00)${sscc}`}>
      <rect x={0} y={0} width={total} height={44} fill="#fff" />
      {[...bits].map((b, i) => (b === '1' ? <rect key={i} x={q + i} y={2} width={1.02} height={40} fill="#000" /> : null))}
    </svg>
  );
}
function ScanView() {
  const labelsQ = useData<{ labels: PalletLabel[]; invalid: string }>(() => api.wmsLabels(), []);
  const [code, setCode] = useState('');
  const [res, setRes] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [cam, setCam] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const can = useApp((s) => s.can);
  const scan = async (c: string) => {
    if (!c.trim()) return;
    setBusy(true);
    try {
      const r = await api.wmsScan(c.trim());
      setRes(r);
      if (r.binId && r.facilityId) showXray(r.facilityId as FacilityId, { highlight: [r.binId], route: null });
    } catch (e) { err(e); } finally { setBusy(false); }
  };
  const stopCam = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; setCam(null); };
  useEffect(() => () => stopCam(), []);
  const startCam = async () => {
    const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    if (!BD) { setCam('This browser has no barcode reader (BarcodeDetector). Use Chrome, a USB scanner, or click a label below.'); return; }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      setCam('Point the camera at a label…');
      const det = new BD({ formats: ['code_128', 'qr_code'] });
      window.setTimeout(async function loop() {
        if (!stream.current || !video.current) return;
        if (!video.current.srcObject) { video.current.srcObject = stream.current; await video.current.play().catch(() => undefined); }
        try {
          const found = await det.detect(video.current);
          if (found[0]) { setCode(found[0].rawValue); stopCam(); void scan(found[0].rawValue); return; }
        } catch { /* keep trying */ }
        window.setTimeout(loop, 250);
      }, 100);
    } catch (e) { setCam(`Camera not available: ${(e as Error).message}`); }
  };
  const pick = async () => {
    if (!res?.sscc) return;
    try { const r = await api.wmsPick(res.sscc); useApp.getState().notify(r.message, r.fefoOk === false ? 'error' : 'ok'); setRes(null); labelsQ.reload(); } catch (e) { err(e); }
  };
  const damage = async () => {
    if (!res?.skuId || !res.facilityId) return;
    const text = window.prompt('Describe the damage', 'Carton crushed, contents may be damaged');
    if (!text) return;
    try { await api.wmsDamage({ facilityId: res.facilityId as FacilityId, skuId: res.skuId, severity: 'MEDIUM', text, sscc: res.sscc, lotId: res.lotId ?? null }); useApp.getState().notify('Damage report filed (and embedded for semantic search)'); } catch (e) { err(e); }
  };
  return (
    <div className="lab-view">
      <p className="lab-lead">Pallets carry a <b>GS1 SSCC</b> (18 digits, the last one a mod-10 check digit) printed as a GS1-128 barcode. The check digit is validated by
        <code>WT_WMS.SCAN</code> — and by a <code>CHECK</code> constraint on <code>BIN_STOCK</code>, so no program can store a wrong label. Scan with the camera, a USB scanner, or click a label.</p>
      <div className="toolbar">
        <input className="wms-input scan-in" autoFocus value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void scan(code); }} placeholder="(00)306141419000000123 — or scan" />
        <button className="btn-primary sm" disabled={busy} onClick={() => { void scan(code); }}><ScanLine size={13} /> Look up</button>
        <button className="btn-ghost sm" onClick={() => { if (stream.current) stopCam(); else void startCam(); }}><Camera size={13} /> {stream.current ? 'Stop camera' : 'Camera'}</button>
      </div>
      {cam && <div className="cam"><video ref={video} muted playsInline /><span className="muted small">{cam}</span></div>}
      {res && (
        <div className={`scan-res ${res.valid ? (res.qc && res.qc !== 'RELEASED' ? 'warn' : 'ok') : 'bad'}`}>
          <div className="sr-head">{res.valid ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}<b>{res.result}</b><SourceBadge source={res.source} what="WT_WMS.SCAN" /></div>
          {res.valid && res.skuId && (
            <div className="sr-grid">
              <span>Product</span><b>{res.sku}</b>
              <span>Where</span><b>{res.binId ? `${res.binId} (${res.zone?.toLowerCase()}, ${res.dockMetres} m from the dock)` : res.palletId ? `${res.palletId} on the ${res.where === 'YARD' ? 'yard' : 'move'}` : '—'}</b>
              <span>Lot</span><b className="mono">{res.lotId}</b>
              <span>Units</span><b>{res.units}</b>
              <span>Expires</span><b>{res.expiry ?? 'no expiry'}</b>
              <span>Status</span><b><QcBadge qc={res.qc ?? 'RELEASED'} reason={res.qcReason} /> {res.qcReason}</b>
              {res.fefoLot !== undefined && <><span>FEFO says</span><b>{res.fefoLot === res.lotId ? <span className="t-good">pick this lot</span> : res.fefoLot ? <span className="t-bad">pick lot {res.fefoLot} first</span> : '—'}</b></>}
            </div>
          )}
          <div className="preset-btns">
            {res.binId && <button className="chip-btn" onClick={() => showXray(res.facilityId as FacilityId, { highlight: [res.binId!] })}><Crosshair size={11} /> Show bin in 3D</button>}
            {res.binId && can('UPDATE_OWN_TASKS') && <button className="chip-btn" onClick={() => { void pick(); }}><Boxes size={11} /> Pick this pallet</button>}
            {res.skuId && can('UPDATE_OWN_TASKS') && <button className="chip-btn" onClick={() => { void damage(); }}><PackageX size={11} /> Report damage</button>}
          </div>
        </div>
      )}
      <div className="wms-card">
        <div className="wc-title"><ScanLine size={13} /> Pallet labels <span className="muted small">click one to scan it · for each product the lot to pick next and a later one</span></div>
        <div className="pal-labels">
          {labelsQ.data?.labels.map((l) => (
            <button key={l.sscc} className="pal-label" onClick={() => { setCode(`(00)${l.sscc}`); void scan(`(00)${l.sscc}`); }}>
              <span className="lb-top"><span className="sku-dot" style={{ background: SKU_COLORS[l.skuId] }} />{skuName(l.skuId)}<span className="muted small">{l.facilityId}</span></span>
              <Barcode sscc={l.sscc} />
              <span className="lb-num mono">(00) {l.sscc}</span>
              <span className="muted small">{l.binId ?? l.palletId} · lot {l.lotId} · {l.expiry ? `exp. ${l.expiry}` : 'no expiry'}</span>
            </button>
          ))}
          {labelsQ.data && (
            <button className="pal-label bad" onClick={() => { setCode(labelsQ.data!.invalid); void scan(labelsQ.data!.invalid); }}>
              <span className="lb-top">A mistyped label<span className="muted small">wrong check digit</span></span>
              <Barcode sscc={labelsQ.data.invalid} /><span className="lb-num mono">(00) {labelsQ.data.invalid}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pick route
function RouteView() {
  const [fac, setFac] = useSite();
  const site = siteStorage(fac);
  const docks = site.nodes.filter((n) => n.kind === 'DOCK');
  const [dock, setDock] = useState<string>('');
  const [data, setData] = useState<RouteReport | null>(null);
  const [busy, setBusy] = useState(false);
  const plan = async () => {
    setBusy(true);
    try {
      const r = await api.wmsRoute(fac, dock || undefined);
      setData(r);
      showXray(fac, { route: { facility: fac, path: r.path, stops: r.stops.map((s) => s.binId) }, highlight: r.stops.map((s) => s.binId) });
    } catch (e) { err(e); } finally { setBusy(false); }
  };
  return (
    <div className="lab-view">
      <p className="lab-lead">The aisles are a graph: <code>WH_NODES</code> and <code>WH_EDGES</code> (and, on Oracle 23ai, the SQL property graph <code>CV_WAREHOUSE_GRAPH</code>). A pick list —
        the FEFO bin of every product the waiting store orders need — is put in the shortest order (nearest neighbour + 2-opt), and each leg is routed by <b>Dijkstra in PL/SQL</b> (<code>WT_WMS.SHORTEST_PATH</code>).</p>
      <div className="toolbar"><SitePicker value={fac} onChange={(f) => { setFac(f); setDock(''); setData(null); }} />
        <select className="wms-select" value={dock} onChange={(e) => setDock(e.target.value)}><option value="">from the first dock</option>{docks.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}</select>
        <button className="btn-primary sm" disabled={busy} onClick={() => { void plan(); }}><Route size={13} /> Plan the pick route</button>
        {data && <SourceBadge source={data.source} what="PL/SQL Dijkstra" />}</div>
      {data && (
        <div className="wms-card">
          <div className="wms-kpis">
            <div><span className="muted small">Stops</span><b>{data.stops.length}</b></div>
            <div className="good"><span className="muted small">Optimised route</span><b>{data.metres} m</b></div>
            <div><span className="muted small">In list order</span><b>{data.naiveMetres} m</b></div>
            <div><span className="muted small">Saved</span><b>{data.naiveMetres ? Math.round(100 - (100 * data.metres) / data.naiveMetres) : 0} %</b></div>
          </div>
          <ol className="stops">
            {data.order.map((node) => {
              const st = data.stops.filter((s) => s.nodeId === node);
              return <li key={node}><span className="mono">{node.slice(fac.length + 1)}</span> {st.map((s) => <span key={s.binId} className="stop"><span className="sku-dot" style={{ background: SKU_COLORS[s.skuId ?? ''] }} />{s.binId.slice(fac.length + 1)} · {s.skuId ? skuName(s.skuId) : ''}</span>)}</li>;
            })}
          </ol>
          {data.graph && (
            <div className={`graphq ${data.graph.ok ? '' : 'bad'}`}>
              <b>SQL/PGQ:</b> {data.graph.ok ? `${data.graph.rows} aisle points within 6 segments of ${data.dock} (GRAPH_TABLE … MATCH (d)-[e]-{1,6}(n))` : `GRAPH_TABLE query failed: ${data.graph.error}`}
              <SqlBox sql={data.graph.sql} label="Show the graph query" />
            </div>
          )}
          <SqlBox sql={data.sql} />
          <p className="muted small">The route is drawn on the warehouse floor in 3D (blue line); the stops are highlighted.</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- semantic search
const EXAMPLES = ['broken glass', 'fridge medicine got warm', 'water damage', 'wrong barcode on the pallet', 'something to protect my head', 'old stock picked before new'];
function SearchView() {
  const [q, setQ] = useState('');
  const [data, setData] = useState<SearchReport | null>(null);
  const [busy, setBusy] = useState(false);
  const user = useApp((s) => s.user);
  const [form, setForm] = useState({ facilityId: (user?.facilities[0] ?? 'WH-01') as FacilityId, skuId: 'LED-6060', severity: 'MEDIUM' as 'LOW' | 'MEDIUM' | 'HIGH', text: '' });
  const run = async (text: string) => {
    if (!text.trim()) return;
    setQ(text);
    setBusy(true);
    try { setData(await api.wmsSearch(text)); } catch (e) { err(e); } finally { setBusy(false); }
  };
  const file = async () => {
    try { await api.wmsDamage(form); useApp.getState().notify('Damage report filed and embedded'); setForm({ ...form, text: '' }); if (q) void run(q); } catch (e) { err(e); }
  };
  return (
    <div className="lab-view">
      <p className="lab-lead"><b>Search by meaning, not by words.</b> Damage reports and product descriptions are turned into 384-number embeddings and stored in
        <code>VECTOR</code> columns; <code>VECTOR_DISTANCE(…, COSINE)</code> finds the closest ones — "broken glass" finds "cracked diffusers" and "shattered panel". The embeddings come
        from the all-MiniLM-L6-v2 sentence transformer once it is installed (<code>npm run ai:model</code>), otherwise from a built-in word-and-meaning embedding.</p>
      <div className="toolbar">
        <input className="wms-input" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(q); }} placeholder="Describe what you are looking for…" />
        <button className="btn-primary sm" disabled={busy} onClick={() => { void run(q); }}><Sparkles size={13} /> Search</button>
      </div>
      <div className="preset-btns">{EXAMPLES.map((x) => <button key={x} className="chip-btn" onClick={() => { void run(x); }}>{x}</button>)}</div>
      {data && (
        <div className="wms-card">
          <div className="wc-title">{data.hits.length} closest <SourceBadge source={data.source} what="Oracle AI Vector Search" /><span className="muted small">{data.model} · {data.ms} ms</span></div>
          {data.hits.map((h) => (
            <div key={`${h.kind}:${h.id}`} className="hit">
              <div className="mini-bar score"><span style={{ width: `${Math.max(0, h.score) * 100}%` }} /></div>
              <span className="muted small">{h.score.toFixed(2)}</span>
              <span className={`badge sm ${h.kind === 'DAMAGE' ? 'tone-orange' : 'tone-blue'}`}>{h.kind === 'DAMAGE' ? 'damage report' : 'product'}</span>
              <span className="hit-text"><b>{h.title}</b> {h.text}</span>
              <span className="muted small">{[h.facilityId, h.skuId && h.kind === 'DAMAGE' ? skuName(h.skuId) : null, h.severity?.toLowerCase(), h.at ? dayOf(h.at) : null].filter(Boolean).join(' · ')}</span>
            </div>
          ))}
          <SqlBox sql={data.sql} />
        </div>
      )}
      <div className="wms-card">
        <div className="wc-title"><PackageX size={13} /> Report damage</div>
        <div className="toolbar">
          <select className="wms-select" value={form.facilityId} onChange={(e) => setForm({ ...form, facilityId: e.target.value as FacilityId })}>{(user?.facilities ?? []).map((f) => <option key={f} value={f}>{f}</option>)}</select>
          <select className="wms-select" value={form.skuId} onChange={(e) => setForm({ ...form, skuId: e.target.value })}>{Object.values(SKUS).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <select className="wms-select" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as 'LOW' | 'MEDIUM' | 'HIGH' })}><option>LOW</option><option>MEDIUM</option><option>HIGH</option></select>
        </div>
        <textarea className="wms-text" rows={2} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="What happened? e.g. forklift tine pierced two cartons of gloves" />
        <div><button className="btn-ghost sm" disabled={form.text.trim().length < 8} onClick={() => { void file(); }}>File report</button></div>
      </div>
    </div>
  );
}

// ================================================================ X-ray legend (over the 3D view)
const MODE_LEGEND: Record<XrayMode, { label: string; items: [string, string][] }> = {
  sku: { label: 'Product', items: Object.entries(SKU_COLORS).map(([k, c]) => [c, skuName(k)]) },
  abc: { label: 'ABC class', items: [['#ef4444', 'A · fast movers'], ['#f59e0b', 'B'], ['#60a5fa', 'C · slow movers']] },
  expiry: { label: 'Days to expiry', items: [['#ef4444', '≤ 7 days'], ['#f59e0b', '≤ 30 days'], ['#a3e635', '≤ 120 days'], ['#22c55e', 'later'], ['#cbd5e1', 'no expiry']] },
  qc: { label: 'Quality status', items: [['#cbd5e1', 'released'], ['#f59e0b', 'on hold'], ['#dc2626', 'recalled']] },
};
export function XrayLegend() {
  const x = useApp((s) => s.xray);
  const setXray = useApp((s) => s.setXray);
  useApp((s) => s.wmsVersion);
  if (!x.facility && !x.recallStores.length) return null;
  const hover = x.hover ? xrayCells.get(x.hover) : undefined;
  const leg = MODE_LEGEND[x.mode];
  return (
    <div className="xray-legend" role="region" aria-label="X-ray view">
      {x.facility && (
        <>
          <div className="xl-head"><Boxes size={14} /><b>X-ray · {FAC_NAMES[x.facility]}</b>
            <button className="sq plain" aria-label="Close X-ray" onClick={() => setXray({ facility: null, route: null, highlight: [], hover: null })}><X size={14} /></button></div>
          <div className="seg">{(['sku', 'abc', 'expiry', 'qc'] as XrayMode[]).map((m) => <button key={m} className={x.mode === m ? 'on' : ''} onClick={() => setXray({ mode: m })}>{MODE_LEGEND[m].label}</button>)}</div>
          <div className="xl-items">{leg.items.filter(([, l]) => x.mode !== 'sku' || Object.values(SKUS).some((s) => s.name === l)).map(([c, l]) => <span key={l}><i style={{ background: c }} />{l}</span>)}</div>
          {x.route && <div className="muted small"><i className="route-key" /> pick route (blue) · stops outlined in yellow</div>}
          <div className="xl-hover">{hover ? (
            <><i style={{ background: cellColor(x.mode, hover) }} /><b>{hover.b.slice(6)}</b> {skuName(hover.s)} · lot {hover.l} · {hover.u} units{hover.e !== null ? ` · ${hover.e} d to expiry` : ''}{hover.q !== 'RELEASED' ? ` · ${hover.q.toLowerCase()}` : ''}</>
          ) : x.hover ? <span className="muted small">{x.hover.slice(6)} · empty bin</span> : <span className="muted small">Point at a pallet for its lot and expiry</span>}</div>
        </>
      )}
      {!!x.recallStores.length && (
        <div className="xl-recall"><ShieldAlert size={13} /> {x.recallStores.length} store(s) ringed in red received the traced lot
          <button className="link" onClick={() => setXray({ recallStores: [] })}>clear</button></div>
      )}
    </div>
  );
}
