// Detail panels for the logistics park (tenant buildings, public vehicles, park gates)
// and the imports / exports KPI card. Records come from Oracle via /api/park.
import { useEffect, useState } from 'react';
import { Crosshair, X, Building2, Car, ShieldCheck, ArrowDownToLine, ArrowUpFromLine, Pencil, Map as MapIcon } from 'lucide-react';
import type { EntityRef, FacilityId } from '../data/types';
import type { GateEntry } from '../api/types';
import { PARK_GATES, PARK_ROUTES, roadAt, type GateCode, type BuildingStatus, type ParkBuilding } from '../data/park';
import { findBuilding, findVehicle, findCompany, getPark, setPark, vehicleNow } from '../data/parkClient';
import { api } from '../api/client';
import { getWorld, useApp } from '../store';
import { fmtClock, fmtNum } from './derive';
import { carrierName } from '../data/seed';

const KIND_LABEL: Record<ParkBuilding['kind'], string> = {
  WAREHOUSE: 'Warehouse', PLANT: 'Manufacturing plant', OFFICE: 'Office building', COLD_STORE: 'Cold store', FUEL_STATION: 'Fuel & EV station',
  PARKING: 'Car park', GATEHOUSE: 'Gatehouse', SERVICES: 'Public services', TERMINAL: 'Container terminal',
  SUPERMARKET: 'Supermarket', STORE: 'Store', RESIDENTIAL: 'Apartments',
};
const STATUS_TONE: Record<BuildingStatus, string> = { OPERATING: 'green', MAINTENANCE: 'orange', VACANT: 'grey', CONSTRUCTION: 'yellow' };
const STATUS_TEXT: Record<BuildingStatus, string> = { OPERATING: 'Operating', MAINTENANCE: 'Maintenance', VACANT: 'Vacant', CONSTRUCTION: 'Under construction' };

export function Head({ icon, kicker, title, sub, focus, color }: { icon: JSX.Element; kicker: string; title: string; sub: string; focus: EntityRef; color?: string }) {
  const camera = useApp((s) => s.camera);
  const select = useApp((s) => s.select);
  return (
    <div className="ph">
      <div className="ph-glyph park-glyph" style={color ? { background: color } : undefined}>{icon}</div>
      <div className="ph-text">
        <div className="ph-kicker">{kicker}</div>
        <div className="ph-title">{title}</div>
        <div className="ph-sub">{sub}</div>
      </div>
      <div className="ph-actions">
        <button className="sq" title="Locate in scene" aria-label="Locate in scene" onClick={() => camera({ kind: 'focus', ref: focus })}><Crosshair size={15} /></button>
        <button className="sq plain" title="Close" aria-label="Close" onClick={() => select(null)}><X size={15} /></button>
      </div>
    </div>
  );
}

export function KV({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div className="kv">
      {rows.map(([k, v]) => <div key={k} className="kv-row"><span className="kv-k">{k}</span><span className="kv-v">{v}</span></div>)}
    </div>
  );
}

export function BuildingPanel({ id }: { id: string }) {
  useApp((s) => s.parkVersion);
  const can = useApp((s) => s.can);
  const notify = useApp((s) => s.notify);
  const mode = useApp((s) => s.mode);
  const [editing, setEditing] = useState(false);
  const b = findBuilding(id);
  const [form, setForm] = useState({ status: b?.status ?? 'OPERATING', staff: String(b?.staff ?? 0), leaseEnd: b?.leaseEnd ?? '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (b) setForm({ status: b.status, staff: String(b.staff), leaseEnd: b.leaseEnd }); setEditing(false); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!b) return null;
  const c = findCompany(b.companyId);
  const area = Math.round(b.w * b.d * b.floors);
  const leaseYears = Math.max(0, (new Date(b.leaseEnd).getTime() - Date.now()) / (365.25 * 86400000));
  const save = async () => {
    setBusy(true);
    try {
      const updated = await api.updateBuilding(b.id, { status: form.status as BuildingStatus, staff: Number(form.staff), leaseEnd: form.leaseEnd });
      const p = getPark();
      setPark({ ...p, buildings: p.buildings.map((x) => (x.id === updated.id ? updated : x)) });
      useApp.setState({ parkVersion: useApp.getState().parkVersion + 1 });
      notify(`${b.name} updated — saved in the database and recorded in the audit trail`);
      setEditing(false);
    } catch (e) { notify((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <>
      <Head icon={<Building2 size={20} />} kicker={`${KIND_LABEL[b.kind].toUpperCase()} · ${b.id}`} title={b.name} sub={`${c?.name ?? ''} · ${b.street}`} focus={{ kind: 'building', id: b.id }} color={c?.color} />
      <div className="status-line"><span className={`badge tone-${STATUS_TONE[b.status]}`}>{STATUS_TEXT[b.status]}</span><span>{c?.industry}</span></div>
      <p className="park-desc">{b.description}</p>
      <KV rows={[
        ['Tenant', c?.name ?? b.companyId],
        ['Contact', c ? `${c.contactName} · ${c.phone}` : '—'],
        ['Floor area', `${fmtNum(area)} m² · ${b.floors} floor${b.floors > 1 ? 's' : ''}`],
        ['Staff on site', b.kind === 'PARKING' ? '—' : fmtNum(b.staff)],
        ['Lease', `${b.leaseStart} → ${b.leaseEnd} (${leaseYears.toFixed(1)} years left)`],
      ]} />
      {mode === 'live' && can('MANAGE_PARK') && !editing && (
        <button className="btn-ghost sm park-edit" onClick={() => setEditing(true)}><Pencil size={13} /> Edit tenant record</button>
      )}
      {editing && (
        <div className="park-form">
          <label>Status
            <select className="sel" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as BuildingStatus })}>
              {(Object.keys(STATUS_TEXT) as BuildingStatus[]).map((s) => <option key={s} value={s}>{STATUS_TEXT[s]}</option>)}
            </select>
          </label>
          <label>Staff<input className="inp" type="number" min={0} value={form.staff} onChange={(e) => setForm({ ...form, staff: e.target.value })} /></label>
          <label>Lease ends<input className="inp" type="date" value={form.leaseEnd} onChange={(e) => setForm({ ...form, leaseEnd: e.target.value })} /></label>
          <div className="row-actions">
            <button className="btn-ghost sm" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn-primary sm" disabled={busy} onClick={() => { void save(); }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
    </>
  );
}

export function VehiclePanel({ id }: { id: string }) {
  useApp((s) => s.tick);
  const v = findVehicle(id);
  if (!v) return null;
  const c = findCompany(v.companyId);
  const pose = vehicleNow(v);
  const route = PARK_ROUTES[v.route];
  const paused = useApp.getState().control.paused;
  return (
    <>
      <Head icon={<Car size={20} />} kicker={`${v.kind} · ${v.id}`} title={v.plate} sub={c ? c.name : 'Public traffic'} focus={{ kind: 'vehicle', id }} color={c?.color ?? '#64748b'} />
      <div className="status-line"><span className={`badge tone-${paused ? 'grey' : 'green'}`}>{paused ? 'Stopped' : 'Driving'}</span><span>{roadAt(pose)}</span></div>
      <div className="prog"><span className="bar tone-blue"><span style={{ width: `${Math.round(pose.t * 100)}%` }} /></span><span className="muted">{Math.round(pose.t * 100)}% of route</span></div>
      <KV rows={[
        ['Owner', c?.name ?? 'Public (not a park tenant)'],
        ['Route', route.name],
        ['Speed', paused ? '0 km/h' : `${v.speedKmh} km/h`],
        ['Colour', <span key="c" className="swatch" style={{ background: v.color }} />],
      ]} />
    </>
  );
}

export function GatePanel({ code }: { code: GateCode }) {
  const g = PARK_GATES[code];
  const user = useApp((s) => s.user);
  const version = useApp((s) => s.versions.gate);
  const mode = useApp((s) => s.mode);
  const [rows, setRows] = useState<GateEntry[] | null>(null);
  useEffect(() => {
    if (mode !== 'live') return;
    let alive = true;
    api.gateLog({ limit: 40 }).then((r) => { if (alive) setRows(r.filter((x) => x.gate === code).slice(0, 8)); }).catch(() => setRows([]));
    return () => { alive = false; };
  }, [code, version, mode]);
  useApp((s) => s.tick);
  const w = getWorld();
  const facs = Object.keys(w.facilities) as FacilityId[];
  const trucks = facs.reduce((n, f) => n + (code === 'WEST' ? w.facilities[f].importsToday : w.facilities[f].exportsToday), 0);
  const pallets = facs.reduce((n, f) => n + (code === 'WEST' ? w.facilities[f].importPalletsToday : w.facilities[f].exportPalletsToday), 0);
  return (
    <>
      <Head icon={<ShieldCheck size={20} />} kicker={`PARK GATE · ${code}`} title={g.name} sub={code === 'WEST' ? 'Harbor Avenue · inbound lane' : 'Industrial Avenue · outbound lane'} focus={{ kind: 'gate', id: code }} color={code === 'WEST' ? '#2f9e44' : '#e8590c'} />
      <p className="park-desc">{g.purpose}</p>
      <div className="tiles">
        <div className="tile"><div className="tile-k">{code === 'WEST' ? 'Imports today' : 'Exports today'}</div><div className="tile-v">{trucks} <span>trucks</span></div></div>
        <div className="tile"><div className="tile-k">Pallets</div><div className="tile-v">{fmtNum(pallets)} <span>{code === 'WEST' ? 'in' : 'out'}</span></div></div>
      </div>
      <div className="sec-head"><span>Latest movements</span><span className="muted">{user ? (user.role === 'ADMIN' ? 'all sites' : user.facilities.join(', ')) : ''}</span></div>
      {mode !== 'live' && <div className="muted small">The gate log is stored in Oracle; sign in to the server to see it.</div>}
      <div className="gate-rows">
        {(rows ?? []).map((r) => <GateRow key={r.id} r={r} />)}
        {rows && !rows.length && <div className="muted small">No movements yet.</div>}
      </div>
    </>
  );
}

export function GateRow({ r }: { r: GateEntry }) {
  const tone = r.trade === 'IMPORT' ? 'import' : r.trade === 'EXPORT' ? 'export' : 'unladen';
  return (
    <button className="gate-row" onClick={() => { const s = useApp.getState(); s.select({ kind: 'truck', id: r.truckId }); setTimeout(() => s.camera({ kind: 'focus', ref: { kind: 'truck', id: r.truckId } }), 30); }}>
      <span className={`trade-dot ${tone}`}>{r.direction === 'IN' ? <ArrowDownToLine size={12} /> : <ArrowUpFromLine size={12} />}</span>
      <span className="gate-main"><b>{r.truckId}</b> <span className="muted">{carrierName(r.carrier)} · {r.facilityId}</span>
        <span className="gate-sub">{r.trade === 'EMPTY' ? 'empty truck' : `${r.trade === 'IMPORT' ? 'Import' : 'Export'} · ${r.pallets} pallets ${r.skuName ?? ''}`}</span></span>
      <span className="muted small">{fmtClock(r.simTime)}</span>
    </button>
  );
}

/** KPI card: goods that came into the park for this site today and goods that left. */
export function TradeKpi() {
  const facilityId = useApp((s) => s.facilityId);
  const openWork = useApp((s) => s.openWork);
  const mode = useApp((s) => s.mode);
  useApp((s) => s.tick);
  const f = getWorld().facilities[facilityId];
  if (!f) return null;
  return (
    <button className="kpi" title="Imports and exports through the park gates" onClick={() => {
      if (mode === 'live') openWork('trade');
      else { useApp.getState().select({ kind: 'gate', id: 'WEST' }); }
    }}>
      <div className="kpi-ico trade"><ArrowDownToLine size={16} /></div>
      <div>
        <div className="kpi-label">Imports · Exports today</div>
        <div className="kpi-val">{f.importsToday} <span className="kpi-mid">in</span> · {f.exportsToday} <span className="kpi-mid">out</span></div>
        <div className="kpi-sub">{fmtNum(f.importPalletsToday)} / {fmtNum(f.exportPalletsToday)} pallets · {facilityId}</div>
      </div>
    </button>
  );
}

/** Small legend shown with the map. */
export function MapLegend() {
  const camera = useApp((s) => s.camera);
  return (
    <div className="map-legend">
      <button className="link small" onClick={() => camera({ kind: 'overview' })}><MapIcon size={12} /> Harborside Logistics Park</button>
      <span><i className="lg import" /> Import (goods in)</span>
      <span><i className="lg export" /> Export (goods out)</span>
      <span><i className="lg unladen" /> Empty truck</span>
    </div>
  );
}
