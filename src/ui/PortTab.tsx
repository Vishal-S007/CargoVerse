// Work panel tab: the container port (ships, port calls, container log) and the
// vendor stores (stock across town, restock orders). History comes from the database.
import { useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import type { ContainerMoveRow, VesselCallRow, StoreOrderRow } from '../api/types';
import { SKUS } from '../data/seed';
import { api } from '../api/client';
import { getWorld, useApp } from '../store';
import { fmtClock, vesselActivity, storeHealth } from './derive';
import { useData } from './DataTabs';
import type { EntityRef } from '../data/types';

type View = 'ships' | 'containers' | 'stores' | 'orders';

const goTo = (ref: EntityRef) => {
  const s = useApp.getState();
  s.select(ref);
  setTimeout(() => s.camera({ kind: 'focus', ref }), 30);
};
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
const MOVE_LABEL: Record<ContainerMoveRow['move'], string> = { DISCHARGE: 'Off ship', LOAD: 'On ship', GATE_OUT: 'Out by truck', GATE_IN: 'In by truck' };

export function PortTab() {
  const [view, setView] = useState<View>('ships');
  return (
    <div className="tab">
      <div className="seg db-seg">
        <button className={view === 'ships' ? 'on' : ''} onClick={() => setView('ships')}>Ships</button>
        <button className={view === 'containers' ? 'on' : ''} onClick={() => setView('containers')}>Container log</button>
        <button className={view === 'stores' ? 'on' : ''} onClick={() => setView('stores')}>Stores</button>
        <button className={view === 'orders' ? 'on' : ''} onClick={() => setView('orders')}>Store orders</button>
      </div>
      {view === 'ships' && <ShipsView />}
      {view === 'containers' && <ContainersView />}
      {view === 'stores' && <StoresView />}
      {view === 'orders' && <OrdersView />}
    </div>
  );
}

function ShipsView() {
  useApp((s) => s.tick);
  const calls = useData<VesselCallRow[]>(() => api.portCalls(20), []);
  const w = getWorld();
  const P = w.port;
  return (
    <>
      <div className="rep-title">Ships now · import stack {P.importStack.length} · export stack {P.exportStack.length} · {P.movesToday} crane moves today</div>
      <table className="tbl">
        <thead><tr><th>Ship</th><th>Line</th><th>Status</th><th>Berth</th><th>Off / to go</th><th>On</th></tr></thead>
        <tbody>
          {Object.values(P.vessels).map((v) => {
            const a = vesselActivity(w, v);
            return (
              <tr key={v.id} className="click" onClick={() => (v.status === 'AT_SEA' ? useApp.getState().select({ kind: 'vessel', id: v.id }) : goTo({ kind: 'vessel', id: v.id }))}>
                <td><b>{v.name}</b> <span className="muted small">{v.voyage}</span></td>
                <td>{v.line}</td>
                <td><span className={`badge sm tone-${a.badge.tone}`}>{a.badge.label}</span></td>
                <td>{v.berthId ? P.berths[v.berthId]?.name : '—'}</td>
                <td>{v.discharged} / {v.importBoxes}</td>
                <td>{v.loaded} / {v.exportTarget}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="toolbar"><div className="rep-title">Port calls</div><button className="sq" title="Refresh" aria-label="Refresh" onClick={calls.reload}><RefreshCw size={14} /></button></div>
      {calls.error && <div className="err">{calls.error}</div>}
      <table className="tbl">
        <thead><tr><th>Ship</th><th>Voyage</th><th>Berth</th><th>Arrived</th><th>Sailed</th><th>Off</th><th>On</th></tr></thead>
        <tbody>
          {(calls.data ?? []).map((c) => (
            <tr key={c.id}>
              <td>{c.vesselName}</td><td>{c.voyage}</td><td>{c.berthId}</td><td>{time(c.arrivedAt)}</td>
              <td>{c.departedAt ? time(c.departedAt) : <span className="badge sm tone-blue">alongside</span>}</td>
              <td>{c.discharged}</td><td>{c.loaded}</td>
            </tr>
          ))}
          {calls.data && !calls.data.length && <tr><td colSpan={7} className="muted">No port calls recorded yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}

function ContainersView() {
  const [q, setQ] = useState('');
  const [box, setBox] = useState('');
  const moves = useData<ContainerMoveRow[]>(() => api.portMoves({ limit: 120, container: box || undefined }), [box]);
  return (
    <>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setBox(q.trim().toUpperCase()); }}>
        <div className="search-inline"><Search size={14} /><input className="inp" placeholder="Trace a container number, e.g. OSLU4123057" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {box && <button type="button" className="btn-ghost sm" onClick={() => { setQ(''); setBox(''); }}>Show all</button>}
        <button type="button" className="sq" title="Refresh" aria-label="Refresh" onClick={moves.reload}><RefreshCw size={14} /></button>
      </form>
      <div className="rep-title">{box ? `History of ${box}` : 'Every container lifted on or off a ship and every box through the terminal gate'}</div>
      {moves.error && <div className="err">{moves.error}</div>}
      <table className="tbl">
        <thead><tr><th>Time</th><th>Container</th><th>Line</th><th>Move</th><th>Ship / crane</th><th>Truck</th><th>Site</th></tr></thead>
        <tbody>
          {(moves.data ?? []).map((m) => (
            <tr key={m.id}>
              <td>{fmtClock(m.simTime)}</td>
              <td><button className="link mono" onClick={() => { setQ(m.containerNo); setBox(m.containerNo); }}>{m.containerNo}</button></td>
              <td>{m.line}</td>
              <td><span className={`badge sm tone-${m.move === 'DISCHARGE' || m.move === 'GATE_OUT' ? 'blue' : 'orange'}`}>{MOVE_LABEL[m.move]}</span></td>
              <td>{m.vesselName ? <button className="link" onClick={() => goTo({ kind: 'vessel', id: m.vesselId! })}>{m.vesselName}</button> : '—'}{m.craneId ? <span className="muted small"> · {m.craneId}</span> : ''}</td>
              <td>{m.truckId ? <button className="link" onClick={() => goTo({ kind: 'truck', id: m.truckId! })}>{m.truckId}</button> : m.move.startsWith('GATE') ? <span className="muted">other haulier</span> : '—'}</td>
              <td>{m.facilityId ?? '—'}</td>
            </tr>
          ))}
          {moves.data && !moves.data.length && <tr><td colSpan={7} className="muted">No container moves found.</td></tr>}
        </tbody>
      </table>
    </>
  );
}

function StoresView() {
  useApp((s) => s.tick);
  const w = getWorld();
  return (
    <>
      <div className="rep-title">Shelf stock across Port Harbor · stores reorder from the warehouses when a line reaches its reorder point</div>
      <table className="tbl">
        <thead><tr><th>Store</th><th>Supplier</th><th>Product</th><th>On shelf</th><th>Reorder at</th><th>Sold today</th><th>Order</th></tr></thead>
        <tbody>
          {Object.values(w.retail.stores).flatMap((st) => st.lines.map((l, i) => {
            const o = Object.values(w.retail.orders).find((x) => x.storeId === st.id && x.skuId === l.skuId && (x.status === 'PLACED' || x.status === 'LOADING' || x.status === 'OUT_FOR_DELIVERY'));
            return (
              <tr key={`${st.id}-${l.skuId}`} className="click" onClick={() => goTo({ kind: 'store', id: st.id })}>
                <td>{i === 0 ? <><b>{st.name}</b> <span className={`badge sm tone-${storeHealth(st).badge.tone}`}>{storeHealth(st).badge.label}</span></> : ''}</td>
                <td>{i === 0 ? st.facilityId : ''}</td>
                <td>{SKUS[l.skuId]?.name ?? l.skuId}</td>
                <td className={l.units <= l.reorderAt ? 'warn' : ''}>{l.units} / {l.maxUnits}</td>
                <td>{l.reorderAt}</td>
                <td>{l.soldToday}</td>
                <td>{o ? `${o.units} · ${o.status.replace(/_/g, ' ').toLowerCase()}` : '—'}</td>
              </tr>
            );
          }))}
        </tbody>
      </table>
    </>
  );
}

function OrdersView() {
  const user = useApp((s) => s.user)!;
  const [store, setStore] = useState('');
  const orders = useData<StoreOrderRow[]>(() => api.storeOrders({ store: store || undefined, limit: 120 }), [store]);
  const stores = Object.values(getWorld().retail.stores);
  return (
    <>
      <div className="toolbar">
        <select className="sel" value={store} onChange={(e) => setStore(e.target.value)} aria-label="Store">
          <option value="">All stores</option>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <span className="muted small">supplied by {user.role === 'ADMIN' ? 'all sites' : user.facilities.join(', ')}</span>
        <button className="sq" title="Refresh" aria-label="Refresh" onClick={orders.reload}><RefreshCw size={14} /></button>
      </div>
      {orders.error && <div className="err">{orders.error}</div>}
      <table className="tbl">
        <thead><tr><th>Order</th><th>Store</th><th>Product</th><th>Units</th><th>From</th><th>Van</th><th>Placed</th><th>Delivered</th><th>Status</th></tr></thead>
        <tbody>
          {(orders.data ?? []).map((o) => (
            <tr key={o.id}>
              <td className="mono">{o.id}{o.source === 'MANUAL' && <span className="muted small"> · {o.placedBy ?? 'manual'}</span>}</td>
              <td><button className="link" onClick={() => goTo({ kind: 'store', id: o.storeId })}>{o.storeName}</button></td>
              <td>{SKUS[o.skuId]?.name ?? o.skuId}</td>
              <td>{o.units}</td>
              <td>{o.facilityId}</td>
              <td>{o.vanId ?? '—'}</td>
              <td>{time(o.placedAt)}</td>
              <td>{time(o.deliveredAt)}</td>
              <td><span className={`badge sm tone-${o.status === 'DELIVERED' ? 'green' : o.status === 'CANCELLED' ? 'grey' : 'blue'}`}>{o.status.replace(/_/g, ' ').toLowerCase()}</span></td>
            </tr>
          ))}
          {orders.data && !orders.data.length && <tr><td colSpan={9} className="muted">No store orders yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
