// Detail panels for the container terminal (terminal, ships, berths, quay cranes)
// and the town (vendor stores, delivery vans). Live state comes from the operations
// stream; actions and history go through the API to the database.
import { useEffect, useState } from 'react';
import { Anchor, Ship as ShipIcon, Container, Store as StoreIcon, Truck, Pause, Play, Lock, Unlock, PackagePlus, X as XIcon } from 'lucide-react';
import type { EntityRef, Store, StoreOrder, Vessel } from '../data/types';
import type { ContainerMoveRow, StoreOrderRow } from '../api/types';
import { SKUS } from '../data/seed';
import { YARD_CAPACITY, storeBuilding } from '../data/city';
import { findCompany } from '../data/parkClient';
import { api } from '../api/client';
import { getWorld, useApp } from '../store';
import { fmtClock, fmtNum, vesselActivity, vanActivity, storeHealth } from './derive';
import { Head, KV } from './ParkPanels';

const goTo = (ref: EntityRef) => {
  const s = useApp.getState();
  s.select(ref);
  setTimeout(() => s.camera({ kind: 'focus', ref }), 30);
};

function useAction() {
  const notify = useApp((s) => s.notify);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); notify(ok); } catch (e) { notify((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return { busy, run };
}

function Bar({ value, tone }: { value: number; tone: string }) {
  return <span className={`bar tone-${tone}`}><span style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} /></span>;
}

function MoveRow({ m }: { m: ContainerMoveRow }) {
  const label = m.move === 'DISCHARGE' ? 'Off ship' : m.move === 'LOAD' ? 'On ship' : m.move === 'GATE_OUT' ? 'Out by truck' : 'In by truck';
  const ref: EntityRef | null = m.truckId ? { kind: 'truck', id: m.truckId } : m.vesselId ? { kind: 'vessel', id: m.vesselId } : null;
  return (
    <button className="gate-row" onClick={() => ref && goTo(ref)} disabled={!ref}>
      <span className={`trade-dot ${m.move === 'DISCHARGE' || m.move === 'GATE_OUT' ? 'import' : 'export'}`}><Container size={12} /></span>
      <span className="gate-main"><b className="mono">{m.containerNo}</b> <span className="muted">{label}</span>
        <span className="gate-sub">{m.vesselName ?? m.truckId ?? 'other haulier'}{m.craneId ? ` · ${m.craneId}` : ''}{m.facilityId ? ` · ${m.facilityId}` : ''}</span></span>
      <span className="muted small">{fmtClock(m.simTime)}</span>
    </button>
  );
}

// ---------------------------------------------------------------- the terminal (PB-PORT)
export function TerminalPanel() {
  useApp((s) => s.tick);
  const can = useApp((s) => s.can);
  const mode = useApp((s) => s.mode);
  const openWork = useApp((s) => s.openWork);
  const { busy, run } = useAction();
  const P = getWorld().port;
  if (!P) return null;
  const c = findCompany('PORTNWK');
  const manage = mode === 'live' && can('MANAGE_PORT');
  const order = ['BERTHED', 'BERTHING', 'ANCHORED', 'ARRIVING', 'DEPARTING', 'AT_SEA'];
  const ships = Object.values(P.vessels).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    <>
      <Head icon={<Anchor size={20} />} kicker="CONTAINER TERMINAL · PB-PORT" title="Port Newark Container Terminal" sub={`${c?.name ?? 'Port Newark'} · 2 berths · 4 quay cranes`} focus={{ kind: 'building', id: 'PB-PORT' }} color={c?.color} />
      <div className="tiles">
        <div className="tile"><div className="tile-k">Import stack</div><div className="tile-v">{P.importStack.length} <span>/ {YARD_CAPACITY} boxes</span></div><Bar value={P.importStack.length / YARD_CAPACITY} tone="blue" /></div>
        <div className="tile"><div className="tile-k">Export stack</div><div className="tile-v">{P.exportStack.length} <span>/ {YARD_CAPACITY} boxes</span></div><Bar value={P.exportStack.length / YARD_CAPACITY} tone="orange" /></div>
        <div className="tile"><div className="tile-k">Crane moves today</div><div className="tile-v">{fmtNum(P.movesToday)}</div></div>
        <div className="tile"><div className="tile-k">Gate in / out</div><div className="tile-v">{P.gateInToday} <span>/ {P.gateOutToday}</span></div></div>
      </div>
      <div className="sec-head"><span>Berths</span><span className="muted">{P.callsToday} ship calls today</span></div>
      <div className="port-list">
        {Object.values(P.berths).map((b) => {
          const v = b.vesselId ? P.vessels[b.vesselId] : undefined;
          return (
            <div key={b.id} className="port-row">
              <button className="port-main" onClick={() => goTo({ kind: 'berth', id: b.id })}>
                <b>{b.name}</b>
                <span className="muted small">{!b.open ? 'Closed to new arrivals' : v ? `${v.name} · ${vesselActivity(getWorld(), v).badge.label}` : 'Free'}</span>
              </button>
              {manage && (
                <button className="btn-ghost sm" disabled={busy} title={b.open ? 'Close this berth to new ships' : 'Reopen this berth'}
                  onClick={() => { void run(() => api.openBerth(b.id, !b.open), `${b.name} ${b.open ? 'closed' : 'reopened'}`); }}>
                  {b.open ? <Lock size={13} /> : <Unlock size={13} />}{b.open ? 'Close' : 'Open'}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="sec-head"><span>Ships</span><span className="muted">click to follow</span></div>
      <div className="port-list">
        {ships.map((v) => <ShipRow key={v.id} v={v} />)}
      </div>
      <div className="sec-head"><span>Latest at the terminal</span>{mode === 'live' && <button className="link small" onClick={() => openWork('port')}>Container log</button>}</div>
      <div className="port-log">
        {P.log.slice(0, 7).map((e, i) => (
          <button key={`${e.t}-${i}`} className="log-row" onClick={() => e.ref && goTo(e.ref)}><span className="muted small">{fmtClock(e.t)}</span><span>{e.text}</span></button>
        ))}
        {!P.log.length && <div className="muted small">Cranes and gates are working; new events appear here.</div>}
      </div>
    </>
  );
}

function ShipRow({ v }: { v: Vessel }) {
  const a = vesselActivity(getWorld(), v);
  return (
    <button className="port-row ship" onClick={() => (v.status === 'AT_SEA' ? useApp.getState().select({ kind: 'vessel', id: v.id }) : goTo({ kind: 'vessel', id: v.id }))}>
      <span className="ship-swatch" style={{ background: v.color }} />
      <span className="port-main"><b>{v.name}</b><span className="muted small">{a.text}</span></span>
      <span className={`badge sm tone-${a.badge.tone}`}>{a.badge.label}</span>
    </button>
  );
}

// ---------------------------------------------------------------- one ship
export function VesselPanel({ id }: { id: string }) {
  useApp((s) => s.tick);
  const can = useApp((s) => s.can);
  const mode = useApp((s) => s.mode);
  const { busy, run } = useAction();
  const [moves, setMoves] = useState<ContainerMoveRow[] | null>(null);
  const w = getWorld();
  const v = w.port?.vessels[id];
  const movesKey = v ? v.discharged + v.loaded : 0;
  useEffect(() => {
    if (mode !== 'live') return;
    let alive = true;
    api.portMoves({ vessel: id, limit: 6 }).then((r) => { if (alive) setMoves(r); }).catch(() => setMoves([]));
    return () => { alive = false; };
  }, [id, mode, movesKey]);
  if (!v) return null;
  const a = vesselActivity(w, v);
  const aboard = v.through + v.importBoxes + v.exportBoxes;
  const berth = v.berthId ? w.port.berths[v.berthId] : undefined;
  return (
    <>
      <Head icon={<ShipIcon size={20} />} kicker={`CONTAINER SHIP · ${v.imo}`} title={v.name} sub={`${v.line} · ${v.flag} flag`} focus={{ kind: 'vessel', id }} color={v.color} />
      <div className="status-line"><span className={`badge tone-${a.badge.tone}`}>{a.badge.label}</span><span>{a.text}</span></div>
      <div className="prog"><Bar value={a.progress} tone="blue" /><span className="muted">voyage {v.voyage}</span></div>
      <KV rows={[
        ['From', v.origin],
        ['Next port', v.nextPort],
        ['Berth', berth ? <button key="b" className="link" onClick={() => goTo({ kind: 'berth', id: berth.id })}>{berth.name}</button> : v.status === 'ANCHORED' ? 'At anchor in the bay' : '—'],
        ['Boxes aboard', `${aboard} of ${v.capacity} (${v.through} for other ports)`],
        ['Discharged here', `${v.discharged}${v.importBoxes ? ` · ${v.importBoxes} to go` : ''}`],
        ['Loaded here', `${v.loaded} of ${v.exportTarget} booked`],
        ['Alongside since', v.arrivedAt !== null && (v.status === 'BERTHED' || v.status === 'DEPARTING') ? fmtClock(v.arrivedAt) : '—'],
        ['Port calls', fmtNum(v.calls)],
      ]} />
      {mode === 'live' && can('MANAGE_PORT') && v.status !== 'DEPARTING' && (
        <button className={`btn-ghost sm park-edit ${v.hold ? 'on' : ''}`} disabled={busy}
          onClick={() => { void run(() => api.holdVessel(v.id, !v.hold), `${v.name} ${v.hold ? 'released' : 'is on hold'}`); }}>
          {v.hold ? <Play size={13} /> : <Pause size={13} />}{v.hold ? 'Release ship' : v.status === 'BERTHED' ? 'Hold alongside' : 'Hold at sea / anchor'}
        </button>
      )}
      {mode === 'live' && (
        <>
          <div className="sec-head"><span>Latest container moves</span></div>
          <div className="gate-rows">
            {(moves ?? []).map((m) => <MoveRow key={m.id} m={m} />)}
            {moves && !moves.length && <div className="muted small">No boxes moved on this call yet.</div>}
          </div>
        </>
      )}
    </>
  );
}

export function BerthPanel({ id }: { id: string }) {
  useApp((s) => s.tick);
  const can = useApp((s) => s.can);
  const mode = useApp((s) => s.mode);
  const { busy, run } = useAction();
  const P = getWorld().port;
  const b = P?.berths[id];
  if (!b) return null;
  const v = b.vesselId ? P.vessels[b.vesselId] : undefined;
  const cranes = Object.values(P.cranes).filter((c) => c.berthId === id);
  return (
    <>
      <Head icon={<Anchor size={20} />} kicker={`BERTH · ${b.id}`} title={b.name} sub="Port Newark Container Terminal · 90 m quay" focus={{ kind: 'berth', id }} color="#0b7285" />
      <div className="status-line"><span className={`badge tone-${!b.open ? 'orange' : v ? 'blue' : 'green'}`}>{!b.open ? 'Closed' : v ? 'Occupied' : 'Free'}</span><span>{v ? `${v.name} · ${vesselActivity(getWorld(), v).text}` : 'No ship alongside'}</span></div>
      <div className="port-list">
        {v && <ShipRow v={v} />}
        {cranes.map((c) => (
          <button key={c.id} className="port-row" onClick={() => goTo({ kind: 'crane', id: c.id })}>
            <span className="port-main"><b>Quay crane {c.id}</b><span className="muted small">{c.movesToday} moves today</span></span>
            <span className={`badge sm tone-${c.phase === 'idle' ? 'grey' : c.phase === 'discharge' ? 'indigo' : 'green'}`}>{c.phase === 'idle' ? 'Idle' : c.phase === 'discharge' ? 'Discharging' : 'Loading'}</span>
          </button>
        ))}
      </div>
      {mode === 'live' && can('MANAGE_PORT') && (
        <button className="btn-ghost sm park-edit" disabled={busy} onClick={() => { void run(() => api.openBerth(b.id, !b.open), `${b.name} ${b.open ? 'closed' : 'reopened'}`); }}>
          {b.open ? <Lock size={13} /> : <Unlock size={13} />}{b.open ? 'Close berth to new arrivals' : 'Reopen berth'}
        </button>
      )}
    </>
  );
}

export function CranePanel({ id }: { id: string }) {
  useApp((s) => s.tick);
  const P = getWorld().port;
  const c = P?.cranes[id];
  if (!c) return null;
  const b = P.berths[c.berthId];
  const v = b?.vesselId ? P.vessels[b.vesselId] : undefined;
  const label = c.phase === 'idle' ? 'Idle' : c.phase === 'discharge' ? 'Discharging' : 'Loading';
  return (
    <>
      <Head icon={<Container size={20} />} kicker="SHIP-TO-SHORE CRANE" title={`Quay crane ${c.id}`} sub={`${b?.name ?? c.berthId} · 65 t spreader`} focus={{ kind: 'crane', id }} color="#e03131" />
      <div className="status-line"><span className={`badge tone-${c.phase === 'idle' ? 'grey' : c.phase === 'discharge' ? 'indigo' : 'green'}`}>{label}</span>
        <span>{c.phase === 'idle' ? (v ? `Waiting · ${v.name}` : 'No ship at this berth') : c.phase === 'discharge' ? `Lifting boxes off ${v?.name ?? 'the ship'} into the import stack` : `Loading export boxes onto ${v?.name ?? 'the ship'}`}</span></div>
      {c.phase !== 'idle' && <div className="prog"><Bar value={c.cycle} tone="blue" /><span className="muted">this move</span></div>}
      <KV rows={[
        ['Berth', <button key="b" className="link" onClick={() => goTo({ kind: 'berth', id: c.berthId })}>{b?.name ?? c.berthId}</button>],
        ['Ship', v ? <button key="v" className="link" onClick={() => goTo({ kind: 'vessel', id: v.id })}>{v.name}</button> : '—'],
        ['Moves today', fmtNum(c.movesToday)],
        ['Cycle time', 'about 1 container per minute'],
      ]} />
    </>
  );
}

// ---------------------------------------------------------------- vendor stores
export function StorePanel({ id }: { id: string }) {
  useApp((s) => s.tick);
  const can = useApp((s) => s.can);
  const mode = useApp((s) => s.mode);
  const w = getWorld();
  const st = w.retail?.stores[id];
  const [history, setHistory] = useState<StoreOrderRow[] | null>(null);
  const [ordering, setOrdering] = useState<string | null>(null);
  const [units, setUnits] = useState('');
  const { busy, run } = useAction();
  const delivered = st?.deliveriesToday ?? 0;
  useEffect(() => {
    if (mode !== 'live') return;
    let alive = true;
    api.storeOrders({ store: id, limit: 6 }).then((r) => { if (alive) setHistory(r); }).catch(() => setHistory([]));
    return () => { alive = false; };
  }, [id, mode, delivered]);
  useEffect(() => { setOrdering(null); }, [id]);
  if (!st) return null;
  const b = storeBuilding(id);
  const c = b ? findCompany(b.companyId) : undefined;
  const health = storeHealth(st);
  const open = Object.values(w.retail.orders).filter((o) => o.storeId === id && (o.status === 'PLACED' || o.status === 'LOADING' || o.status === 'OUT_FOR_DELIVERY'));
  const manage = mode === 'live' && can('MANAGE_RETAIL');
  return (
    <>
      <Head icon={<StoreIcon size={20} />} kicker={`${st.kind} · ${st.id}`} title={st.name} sub={`${b?.street ?? 'Market Street'} · Port Harbor`} focus={b ? { kind: 'building', id: b.id } : { kind: 'store', id }} color={c?.color} />
      <div className="status-line"><span className={`badge tone-${health.badge.tone}`}>{health.badge.label}</span><span>Supplied by {w.facilities[st.facilityId]?.name ?? st.facilityId} · {st.deliveriesToday} deliveries today</span></div>
      <div className="sec-head"><span>Shelf stock</span><span className="muted">reorders automatically at the line</span></div>
      <div className="shelf">
        {st.lines.map((l) => {
          const sku = SKUS[l.skuId];
          const o = open.find((x) => x.skuId === l.skuId);
          const tone = l.units === 0 ? 'orange' : l.units <= l.reorderAt ? 'yellow' : 'green';
          return (
            <div key={l.skuId} className="shelf-row">
              <div className="shelf-top">
                <b>{sku?.name ?? l.skuId}</b>
                <span className="muted small">{l.units} / {l.maxUnits}</span>
              </div>
              <div className="shelf-bar">
                <Bar value={l.units / l.maxUnits} tone={tone} />
                <i className="reorder-mark" style={{ left: `${(l.reorderAt / l.maxUnits) * 100}%` }} title={`Reorder at ${l.reorderAt}`} />
              </div>
              <div className="shelf-sub muted small">
                <span>{l.soldToday} sold today · {Math.round(l.salesPerHour)}/h</span>
                {o ? <OrderChip o={o} /> : manage && ordering !== l.skuId && (
                  <button className="link small" onClick={() => { setOrdering(l.skuId); setUnits(String(Math.max(5, Math.ceil((l.maxUnits - l.units) / 5) * 5))); }}><PackagePlus size={12} /> Restock</button>
                )}
              </div>
              {ordering === l.skuId && !o && (
                <div className="restock">
                  <input className="inp" type="number" min={1} max={l.maxUnits * 2} value={units} onChange={(e) => setUnits(e.target.value)} aria-label="Units to order" />
                  <span className="muted small">units</span>
                  <button className="btn-ghost sm" onClick={() => setOrdering(null)}>Cancel</button>
                  <button className="btn-primary sm" disabled={busy || !(Number(units) > 0)}
                    onClick={() => { void run(async () => { await api.placeStoreOrder({ storeId: id, skuId: l.skuId, units: Number(units) }); setOrdering(null); }, `Order placed for ${st.name}`); }}>
                    Order
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {open.length > 0 && (
        <>
          <div className="sec-head"><span>On the way</span></div>
          <div className="port-list">
            {open.map((o) => <OpenOrder key={o.id} o={o} manage={manage} busy={busy} run={run} />)}
          </div>
        </>
      )}
      {mode === 'live' && (
        <>
          <div className="sec-head"><span>Recent orders</span></div>
          <div className="gate-rows">
            {(history ?? []).map((r) => (
              <div key={r.id} className="order-row">
                <span className="mono small">{r.id}</span>
                <span>{r.units} × {SKUS[r.skuId]?.name ?? r.skuId}<span className="muted small"> · {r.facilityId}{r.source === 'MANUAL' ? ` · by ${r.placedBy ?? 'manager'}` : ''}</span></span>
                <span className={`badge sm tone-${r.status === 'DELIVERED' ? 'green' : r.status === 'CANCELLED' ? 'grey' : 'blue'}`}>{r.status.replace(/_/g, ' ').toLowerCase()}</span>
              </div>
            ))}
            {history && !history.length && <div className="muted small">No orders yet.</div>}
          </div>
        </>
      )}
    </>
  );
}

function OrderChip({ o }: { o: StoreOrder }) {
  const label = o.status === 'PLACED' ? 'ordered' : o.status === 'LOADING' ? 'loading' : 'on the way';
  return <span className="order-chip">{o.units} {label}</span>;
}

function OpenOrder({ o, manage, busy, run }: { o: StoreOrder; manage: boolean; busy: boolean; run: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const w = getWorld();
  const van = o.vanId ? w.retail.vans[o.vanId] : undefined;
  return (
    <div className="port-row">
      <button className="port-main" onClick={() => van && van.status !== 'IDLE' && goTo({ kind: 'van', id: van.id })}>
        <b>{o.units} × {SKUS[o.skuId]?.name ?? o.skuId}</b>
        <span className="muted small">{o.id} · from {o.facilityId}{van ? ` · ${van.id} (${vanActivity(w, van).badge.label.toLowerCase()})` : ' · waiting for a van'}</span>
      </button>
      {manage && o.status === 'PLACED' && (
        <button className="sq plain" title="Cancel order" aria-label="Cancel order" disabled={busy} onClick={() => { void run(() => api.cancelStoreOrder(o.id), `${o.id} cancelled`); }}><XIcon size={14} /></button>
      )}
    </div>
  );
}

export function VanPanel({ id }: { id: string }) {
  useApp((s) => s.tick);
  const w = getWorld();
  const v = w.retail?.vans[id];
  if (!v) return null;
  const a = vanActivity(w, v);
  const o = v.orderId ? w.retail.orders[v.orderId] : undefined;
  const st = v.storeId ? w.retail.stores[v.storeId] : undefined;
  return (
    <>
      <Head icon={<Truck size={20} />} kicker={`CARGOVERSE ${v.kind === 'VAN' ? 'DELIVERY VAN' : 'BOX TRUCK'} · ${v.plate}`} title={v.id} sub={`${v.driver} · based at ${w.facilities[v.facilityId]?.name ?? v.facilityId}`} focus={{ kind: 'van', id }} color="#2c5be4" />
      <div className="status-line"><span className={`badge tone-${a.badge.tone}`}>{a.badge.label}</span><span>{a.text}</span></div>
      <KV rows={[
        ['Order', o ? `${o.id} · ${o.source === 'MANUAL' ? 'placed by a manager' : 'automatic reorder'}` : '—'],
        ['Cargo', o ? `${o.units} × ${SKUS[o.skuId]?.name ?? o.skuId}` : 'Empty'],
        ['Store', st ? <button key="s" className="link" onClick={() => goTo({ kind: 'store', id: st.id })}>{st.name}</button> : '—'],
        ['Trips today', fmtNum(v.tripsToday)],
      ]} />
    </>
  );
}

export function isStoreBuilding(buildingId: string): Store | undefined {
  return Object.values(getWorld().retail?.stores ?? {}).find((s) => s.buildingId === buildingId);
}
