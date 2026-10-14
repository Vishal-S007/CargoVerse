import { useEffect, useRef, useState } from 'react';
import {
  Plus, Minus, RotateCcw, RotateCw, Home, Crosshair, ArrowUpRight, X, ChevronRight, Truck as TruckIcon,
  Box as BoxIcon, Clock3, FileText, ClipboardCheck, Package, Check, ArrowUp, Warehouse, ArrowDownUp, Map as MapIcon, PanelsTopLeft,
} from 'lucide-react';
import type { EntityRef } from '../data/types';
import { SKUS, carrierName } from '../data/seed';
import { getWorld, useApp } from '../store';
import {
  kpis, fmtNum, truckView, forkliftView, palletView, dockView, chargerView, siteView, dockRows, forkliftRows,
  truckRows, defaultTimelineTruck, timeline, timelineCard, forkliftsOf, docksOf, trucksOf, assetView, deliveryWatch,
  palletsOfSku, palletLocation, fmtClock,
  type Badge as BadgeT, type FleetRow, type TimelineStep,
} from './derive';
import { anchors, labelSpecs } from '../scene/labels';
import { BuildingPanel, VehiclePanel, GatePanel, TradeKpi } from './ParkPanels';
import { TerminalPanel, VesselPanel, BerthPanel, CranePanel, StorePanel, VanPanel, isStoreBuilding } from './PortPanels';
import { findBuilding, findVehicle } from '../data/parkClient';
import type { GateCode } from '../data/park';
import { SkuGlyph, TruckGlyph, ForkliftGlyph, WarehouseGlyph, DockGlyph, ChargerGlyph, CarrierGlyph, carrierColor } from './icons';

export function Badge({ b, small }: { b: BadgeT; small?: boolean }) {
  return <span className={`badge tone-${b.tone} ${small ? 'sm' : ''}`}>{b.label}</span>;
}

function Bar({ value, tone = 'blue' }: { value: number; tone?: string }) {
  return (
    <span className={`bar tone-${tone}`}>
      <span style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </span>
  );
}

// ---------------------------------------------------------------- shared helpers

function useOutside<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [open, close]);
  return ref;
}

/** Select an entity and bring it into view (facilities return to the site overview). */
export function goTo(ref: EntityRef): void {
  const s = useApp.getState();
  s.select(ref);
  setTimeout(() => s.camera(ref.kind === 'facility' ? { kind: 'home' } : { kind: 'focus', ref }), 30);
}

function useFlash(eventName: string): boolean {
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    let t: number | undefined;
    const on = () => { setFlash(true); window.clearTimeout(t); t = window.setTimeout(() => setFlash(false), 900); };
    window.addEventListener(eventName, on);
    return () => { window.removeEventListener(eventName, on); window.clearTimeout(t); };
  }, [eventName]);
  return flash;
}

// ---------------------------------------------------------------- KPI cards

export function KpiCards() {
  const facilityId = useApp((s) => s.facilityId);
  const select = useApp((s) => s.select);
  const focusPanel = useApp((s) => s.focusPanel);
  const setFleetTab = useApp((s) => s.setFleetTab);
  useApp((s) => s.tick);
  const [otdOpen, setOtdOpen] = useState(false);
  const otdRef = useOutside<HTMLDivElement>(otdOpen, () => setOtdOpen(false));
  const w = getWorld();
  const k = kpis(w, facilityId);
  const f = w.facilities[facilityId];
  const sign = (n: number, d = 0) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(d)}`;
  const watch = otdOpen ? deliveryWatch(w, facilityId) : [];
  return (
    <div className="kpis">
      <button className="kpi" title="Show inventory for this site" onClick={() => { select({ kind: 'facility', id: facilityId }); focusPanel('inventory'); }}>
        <div className="kpi-ico"><BoxIcon size={18} /></div>
        <div>
          <div className="kpi-label">Stock on hand</div>
          <div className="kpi-val">{fmtNum(k.stock)} <Delta up={k.stockDelta >= 0} text={sign(k.stockDelta)} /></div>
          <div className="kpi-sub">pallets · {facilityId}</div>
        </div>
      </button>
      <button className="kpi" title="List the trucks at this site" onClick={() => { setFleetTab('trucks'); window.dispatchEvent(new CustomEvent('wt:fleet-flash')); }}>
        <div className="kpi-ico"><TruckIcon size={18} /></div>
        <div>
          <div className="kpi-label">Trucks on site</div>
          <div className="kpi-val">{k.onSite} <Delta up={k.onSiteDelta >= 0} text={sign(k.onSiteDelta)} /></div>
          <div className="kpi-sub">{k.inbound} inbound · {facilityId}</div>
        </div>
      </button>
      <div className="kpi-wrap" ref={otdRef}>
        <button className={`kpi ${otdOpen ? 'on' : ''}`} title="Deliveries in progress and at risk" aria-expanded={otdOpen} onClick={() => setOtdOpen((o) => !o)}>
          <div className="kpi-ico"><Clock3 size={18} /></div>
          <div>
            <div className="kpi-label">On-time delivery</div>
            <div className="kpi-val">{k.otd.toFixed(1)}% <Delta up={k.otdDelta >= 0} text={`${sign(k.otdDelta, 1)}%`} /></div>
            <div className="kpi-sub">last 30 days · {facilityId}</div>
          </div>
        </button>
        {otdOpen && (
          <div className="pop otd-pop">
            <div className="pop-head"><b>Deliveries · {f.shortName}</b><span className="muted small">{fmtNum(f.onTime30d)} of {fmtNum(f.deliveries30d)} on time in 30 days</span></div>
            {watch.map((d) => (
              <button key={d.id} className="pop-row" onClick={() => { goTo({ kind: 'truck', id: d.truckId }); setOtdOpen(false); }}>
                <span className="pop-main"><b>#{d.id}</b> <span className="muted">{d.truckId}</span><span className="pop-sub">{d.text}</span></span>
                <Badge b={{ label: d.label, tone: d.tone }} small />
              </button>
            ))}
            <div className="muted small pop-foot">Compared against each shipment's promised time</div>
          </div>
        )}
      </div>
      <TradeKpi />
    </div>
  );
}

function Delta({ up, text }: { up: boolean; text: string }) {
  return (
    <span className={`delta ${up ? 'up' : 'down'}`}>
      <ArrowUp size={10} strokeWidth={3} style={{ transform: up ? 'none' : 'rotate(180deg)' }} /> {text}
    </span>
  );
}

// ---------------------------------------------------------------- scene controls

export function SceneControls() {
  const camera = useApp((s) => s.camera);
  const showPanels = useApp((s) => s.showPanels);
  const togglePanels = useApp((s) => s.togglePanels);
  return (
    <div className="scene-ctrl">
      <button aria-label="Zoom in" title="Zoom in" onClick={() => camera({ kind: 'zoomIn' })}><Plus size={17} /></button>
      <button aria-label="Zoom out" title="Zoom out" onClick={() => camera({ kind: 'zoomOut' })}><Minus size={17} /></button>
      <span className="sep" />
      <button aria-label="Rotate left" title="Rotate left" onClick={() => camera({ kind: 'rotateLeft' })}><RotateCcw size={15} /></button>
      <button aria-label="Rotate right" title="Rotate right" onClick={() => camera({ kind: 'rotateRight' })}><RotateCw size={15} /></button>
      <button aria-label="Reset view" title="Back to this site" onClick={() => camera({ kind: 'home' })}><Home size={16} /></button>
      <span className="sep" />
      <button aria-label="Whole park" title="Show the whole logistics park" onClick={() => camera({ kind: 'overview' })}><MapIcon size={15} /></button>
      <button aria-label={showPanels ? 'Hide panels' : 'Show panels'} title={showPanels ? 'Hide panels (map only)' : 'Show panels'} className={showPanels ? '' : 'on'} onClick={togglePanels}><PanelsTopLeft size={15} /></button>
    </div>
  );
}

// ---------------------------------------------------------------- info panel

interface Row { k: string; v: string; link?: boolean; ref?: EntityRef }

function PanelHead({ glyph, header, title, subtitle, focusRef, followable, closable }: {
  glyph: JSX.Element; header: string; title: string; subtitle: string; focusRef: EntityRef; followable?: boolean; closable?: boolean;
}) {
  const camera = useApp((s) => s.camera);
  const follow = useApp((s) => s.follow);
  const toggleFollow = useApp((s) => s.toggleFollow);
  const select = useApp((s) => s.select);
  return (
    <div className="ph">
      <div className="ph-glyph">{glyph}</div>
      <div className="ph-text">
        <div className="ph-kicker">{header}</div>
        <div className="ph-title">{title}</div>
        <div className="ph-sub">{subtitle}</div>
      </div>
      <div className="ph-actions">
        <button className="sq" title={focusRef.kind === 'facility' ? 'Reset view' : 'Locate in scene'} aria-label="Locate in scene"
          onClick={() => camera(focusRef.kind === 'facility' ? { kind: 'home' } : { kind: 'focus', ref: focusRef })}>
          <Crosshair size={15} />
        </button>
        {followable && (
          <button className={`sq ${follow ? 'on' : ''}`} title={follow ? 'Stop following' : 'Follow in scene'} aria-label="Follow" aria-pressed={follow} onClick={toggleFollow}>
            <ArrowUpRight size={15} />
          </button>
        )}
        {closable && (
          <button className="sq plain" title="Close" aria-label="Close" onClick={() => select(null)}><X size={15} /></button>
        )}
      </div>
    </div>
  );
}

function Rows({ rows, onLink }: { rows: Row[]; onLink?: () => void }) {
  return (
    <div className="kv">
      {rows.map((r) => (
        <div key={r.k} className="kv-row">
          <span className="kv-k">{r.k}</span>
          {r.ref ? (
            <button className="kv-v link" title={r.ref.kind === 'facility' ? 'Back to the site overview' : `Show ${r.v} in the yard`} onClick={() => goTo(r.ref!)}>{r.v}</button>
          ) : r.link && onLink ? (
            <button className="kv-v link" title="Show this shipment's tracking" onClick={onLink}>{r.v}</button>
          ) : <span className="kv-v">{r.v}</span>}
        </div>
      ))}
    </div>
  );
}

function SitePanel() {
  const facilityId = useApp((s) => s.facilityId);
  const panelFocus = useApp((s) => s.panelFocus);
  const highlight = useApp((s) => s.highlightSku);
  const setHighlight = useApp((s) => s.setHighlightSku);
  const setFleetTab = useApp((s) => s.setFleetTab);
  const focusPanel = useApp((s) => s.focusPanel);
  const [expand, setExpand] = useState<'outbound' | null>(null);
  const [invFlash, setInvFlash] = useState(false);
  const invRef = useRef<HTMLDivElement>(null);
  const w = getWorld();
  const v = siteView(w, facilityId);
  useEffect(() => {
    if (!panelFocus.seq || panelFocus.section !== 'inventory') return;
    invRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setInvFlash(true);
    const t = window.setTimeout(() => setInvFlash(false), 900);
    return () => window.clearTimeout(t);
  }, [panelFocus]);
  const departures = expand === 'outbound'
    ? w.events.filter((e) => e.facilityId === facilityId && /departed|delivered|loaded/.test(e.text)).slice(0, 6) : [];
  const firstDock = docksOf(w, facilityId)[0];
  return (
    <>
      <PanelHead glyph={<WarehouseGlyph />} header={v.header} title={v.title} subtitle={v.subtitle} focusRef={{ kind: 'facility', id: facilityId }} />
      <div className="status-line"><Badge b={{ label: 'Operational', tone: 'green' }} /><span>{v.summary}</span></div>
      <div className="tiles">
        <button className="tile" title="Show inventory" onClick={() => focusPanel('inventory')}>
          <div className="tile-k">Stock on hand</div>
          <div className="tile-v">{fmtNum(v.stock)} <span>/ {fmtNum(v.capacity)}</span></div>
          <Bar value={v.stock / v.capacity} />
        </button>
        <button className="tile" title="Show the dock list" onClick={() => { setFleetTab('docks'); window.dispatchEvent(new CustomEvent('wt:fleet-flash')); }}>
          <div className="tile-k">Truck bays</div>
          <div className="tile-v">{v.baysBusy} <span>/ {v.baysTotal} busy</span></div>
          <Bar value={v.baysBusy / v.baysTotal} tone="green" />
        </button>
        <button className={`tile ${expand === 'outbound' ? 'on' : ''}`} title="Recent departures" aria-expanded={expand === 'outbound'} onClick={() => setExpand((x) => (x === 'outbound' ? null : 'outbound'))}>
          <div className="tile-k">Outbound today</div>
          <div className="tile-v">{v.outbound} <span>trucks</span></div>
        </button>
        <button className="tile" title="Show where pallets are put away" onClick={() => firstDock && goTo({ kind: 'asset', id: `${facilityId}|putaway|${firstDock.id}` })}>
          <div className="tile-k">Put-aways today</div>
          <div className="tile-v">{v.putaways} <span>pallets</span></div>
        </button>
      </div>
      {expand === 'outbound' && (
        <div className="mini-list">
          {departures.length === 0 && <div className="muted small">No departures yet in this session.</div>}
          {departures.map((e, i) => (
            <button key={i} className="mini-row" onClick={() => e.ref && goTo(e.ref)}>
              <span className="muted small">{fmtClock(e.t)}</span><span>{e.text}</span>
            </button>
          ))}
        </div>
      )}
      <div className="sec-head"><span>Inventory</span><span className="muted">units</span></div>
      <div className={`inv ${invFlash ? 'flash' : ''}`} ref={invRef}>
        {v.inventory.map((l) => {
          const on = highlight === l.sku.id;
          const pallets = on ? palletsOfSku(w, facilityId, l.sku.id) : [];
          return (
            <div key={l.sku.id}>
              <button className={`inv-row ${on ? 'on' : ''}`} aria-pressed={on} title={on ? 'Stop highlighting' : `Highlight ${l.sku.name} pallets in the yard`}
                onClick={() => setHighlight(on ? null : l.sku.id)}>
                <span className="inv-ico"><SkuGlyph icon={l.sku.icon} /></span>
                <span className="inv-name">{l.sku.name}</span>
                <span className="inv-units">{fmtNum(l.units)}</span>
                <Badge b={l.badge} small />
              </button>
              {on && (
                <div className="inv-pallets">
                  <span className="muted small">{pallets.length ? `${pallets.length} pallet${pallets.length > 1 ? 's' : ''} in the yard (ringed in orange); the rest is in storage` : 'No pallets of this product in the yard right now — all stock is in storage'}</span>
                  {pallets.map((p) => (
                    <button key={p.id} className="chip-btn" onClick={() => goTo({ kind: 'pallet', id: p.id })}>{p.id} · {palletLocation(w, p.id).replace(`${facilityId} · `, '')}</button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="sec-head"><span>Forklift fleet</span>
        <button className="link small" onClick={() => { setFleetTab('forklifts'); window.dispatchEvent(new CustomEvent('wt:fleet-flash')); }}>{v.fleet.working}/{v.fleet.total} working</button>
      </div>
      {v.fleet.lead && (
        <button className="fleet-lead" onClick={() => goTo({ kind: 'forklift', id: v.fleet.lead.id })}>
          <b>{v.fleet.lead.id}</b>
          <span className="fl-text">{v.fleet.leadText}</span>
          <Bar value={v.fleet.lead.battery / 100} tone="green" />
          <span className="muted">{Math.round(v.fleet.lead.battery)}%</span>
        </button>
      )}
    </>
  );
}

export function InfoPanel() {
  const sel = useApp((s) => s.selection);
  useApp((s) => s.tick);
  const w = getWorld();
  const [pulse, setPulse] = useState(0);
  let body: JSX.Element;
  if (!sel || sel.kind === 'facility') {
    body = <SitePanel />;
  } else if (sel.kind === 'truck' && w.trucks[sel.id]) {
    const t = w.trucks[sel.id];
    const v = truckView(w, t);
    body = (
      <>
        <PanelHead glyph={<CarrierGlyph carrier={t.carrier} />} header={v.header} title={v.title} subtitle={v.subtitle} focusRef={sel} followable closable />
        <div className="status-line"><Badge b={v.badge} /><span>{v.activity}</span></div>
        <div className="prog"><Bar value={v.progress} tone={v.badge.tone === 'green' ? 'green' : 'blue'} /><span className="muted">{v.right}</span></div>
        <Rows rows={v.rows} onLink={() => { setPulse((p) => p + 1); window.dispatchEvent(new CustomEvent('wt:timeline-flash')); }} />
      </>
    );
  } else if (sel.kind === 'forklift' && w.forklifts[sel.id]) {
    const v = forkliftView(w, w.forklifts[sel.id]);
    body = (
      <>
        <PanelHead glyph={<ForkliftGlyph />} header={v.header} title={v.title} subtitle={v.subtitle} focusRef={sel} followable closable />
        <div className="status-line"><Badge b={v.badge} /><span>{v.activity}</span></div>
        <div className="prog"><Bar value={v.progress} tone={v.progress < 0.25 ? 'orange' : 'green'} /><span className="muted">{v.right}</span></div>
        <Rows rows={v.rows} />
      </>
    );
  } else if (sel.kind === 'pallet' && w.pallets[sel.id]) {
    const p = w.pallets[sel.id];
    const v = palletView(w, sel.id);
    body = (
      <>
        <PanelHead glyph={<SkuGlyph icon={SKUS[p.skuId].icon} size={30} />} header={v.header} title={v.title} subtitle={v.subtitle} focusRef={sel} closable />
        <div className="status-line"><Badge b={v.badge} /><span>{v.activity}</span></div>
        <Rows rows={v.rows} />
      </>
    );
  } else if (sel.kind === 'dock' && w.docks[sel.id]) {
    const v = dockView(w, w.docks[sel.id]);
    body = (
      <>
        <PanelHead glyph={<DockGlyph />} header={v.header} title={v.title} subtitle={v.subtitle} focusRef={sel} closable />
        <div className="status-line"><Badge b={v.badge} /><span>{v.activity}</span></div>
        <Rows rows={v.rows} />
      </>
    );
  } else if (sel.kind === 'charger' && w.chargers[sel.id]) {
    const v = chargerView(w, sel.id);
    body = (
      <>
        <PanelHead glyph={<ChargerGlyph />} header={v.header} title={v.title} subtitle={v.subtitle} focusRef={sel} closable />
        <div className="status-line"><Badge b={v.badge} /><span>{v.activity}</span></div>
        <Rows rows={v.rows} />
      </>
    );
  } else if (sel.kind === 'asset' && assetView(w, sel.id)) {
    const v = assetView(w, sel.id)!;
    body = (
      <>
        <PanelHead glyph={v.asset.type === 'putaway' ? <DockGlyph /> : <WarehouseGlyph />} header={v.header} title={v.title} subtitle={v.subtitle} focusRef={sel} closable />
        <div className="status-line"><Badge b={{ label: 'Yard asset', tone: 'indigo' }} /><span>{v.activity}</span></div>
        <Rows rows={v.rows} />
      </>
    );
  } else if (sel.kind === 'building' && sel.id === 'PB-PORT') {
    body = <TerminalPanel />;
  } else if (sel.kind === 'building' && isStoreBuilding(sel.id)) {
    body = <StorePanel id={isStoreBuilding(sel.id)!.id} />;
  } else if (sel.kind === 'building' && findBuilding(sel.id)) {
    body = <BuildingPanel id={sel.id} />;
  } else if (sel.kind === 'vessel' && w.port?.vessels[sel.id]) {
    body = <VesselPanel id={sel.id} />;
  } else if (sel.kind === 'berth' && w.port?.berths[sel.id]) {
    body = <BerthPanel id={sel.id} />;
  } else if (sel.kind === 'crane' && w.port?.cranes[sel.id]) {
    body = <CranePanel id={sel.id} />;
  } else if (sel.kind === 'store' && w.retail?.stores[sel.id]) {
    body = <StorePanel id={sel.id} />;
  } else if (sel.kind === 'van' && w.retail?.vans[sel.id]) {
    body = <VanPanel id={sel.id} />;
  } else if (sel.kind === 'vehicle' && findVehicle(sel.id)) {
    body = <VehiclePanel id={sel.id} />;
  } else if (sel.kind === 'gate') {
    body = <GatePanel code={sel.id as GateCode} />;
  } else {
    body = <SitePanel />;
  }
  return <aside className="panel info" data-pulse={pulse} aria-label="Details">{body}</aside>;
}

// ---------------------------------------------------------------- shipment tracking

const STEP_ICON: Record<TimelineStep['icon'], JSX.Element> = {
  order: <FileText size={14} />,
  picked: <ClipboardCheck size={14} />,
  box: <Package size={14} />,
  truck: <TruckIcon size={14} />,
  check: <Check size={14} />,
};

const STATE_TEXT: Record<TimelineStep['state'], string> = { done: 'Completed', current: 'In progress now', todo: 'Not started yet' };

export function ShipmentTracking() {
  const facilityId = useApp((s) => s.facilityId);
  const preferred = useApp((s) => s.timelineTruck[s.facilityId]);
  const sel = useApp((s) => s.selection);
  useApp((s) => s.tick);
  const flash = useFlash('wt:timeline-flash');
  const [step, setStep] = useState<string | null>(null);
  const popRef = useOutside<HTMLOListElement>(step !== null, () => setStep(null));
  const w = getWorld();
  const selTruck = sel?.kind === 'truck' ? sel.id : null;
  const t = defaultTimelineTruck(w, facilityId, selTruck ?? preferred);
  useEffect(() => setStep(null), [t?.id]);
  if (!t) return <section className="panel tracking"><div className="tr-head"><TruckIcon size={16} /> Shipment Tracking</div></section>;
  const tl = timeline(w, t);
  const card = timelineCard(w, t);
  const s = tl.shipment;
  const dock = t.dockId ? w.docks[t.dockId] : null;
  const detail = (st: TimelineStep): { text: string; ref: EntityRef | null; refLabel: string } => {
    switch (st.icon) {
      case 'order': return { text: s ? `Order ${s.id} for ${s.customer} · ${s.pallets} pallets of ${SKUS[s.skuId]?.name ?? s.skuId}` : '', ref: null, refLabel: '' };
      case 'picked': return { text: t.direction === 'outbound' ? 'Picked from storage at this site' : `Picked at the supplier (${s?.customer ?? ''})`, ref: null, refLabel: '' };
      case 'box': return { text: dock ? `At ${dock.name} with ${t.forkliftId ?? 'no forklift yet'}` : 'Loading happens at the origin', ref: t.forkliftId ? { kind: 'forklift', id: t.forkliftId } : dock ? { kind: 'dock', id: dock.id } : null, refLabel: t.forkliftId ?? dock?.name ?? '' };
      case 'truck': return { text: `${t.id} · ${t.driver} (${t.plate})`, ref: { kind: 'truck', id: t.id }, refLabel: t.id };
      case 'check': return { text: s ? `To ${s.destination} · promised by ${fmtClock(s.promisedAt)}` : '', ref: dock && t.direction === 'inbound' ? { kind: 'dock', id: dock.id } : { kind: 'truck', id: t.id }, refLabel: dock && t.direction === 'inbound' ? dock.name : t.id };
    }
  };
  return (
    <section className={`panel tracking ${flash ? 'flash' : ''}`} aria-label="Shipment tracking">
      <div className="tr-left">
        <div className="tr-head">
          <span className="tr-title"><TruckIcon size={16} className="blue" /> Shipment Tracking</span>
          <button className="link muted-link" title={`Show ${t.id} in the yard`} onClick={() => goTo({ kind: 'truck', id: t.id })}>{t.id} · {carrierName(t.carrier)}</button>
        </div>
        <ol className="steps" ref={popRef}>
          {tl.steps.map((st, i) => {
            const d = step === st.key ? detail(st) : null;
            return (
              <li key={st.key} className={`step ${st.state} ${step === st.key ? 'picked' : ''}`}>
                {i > 0 && <span className={`line ${tl.steps[i - 1].state === 'done' && st.state !== 'todo' ? 'done' : ''}`} />}
                <button className="node" title={`${st.label} — ${STATE_TEXT[st.state]}`} aria-expanded={step === st.key}
                  onClick={() => setStep((x) => (x === st.key ? null : st.key))}>{STEP_ICON[st.icon]}</button>
                <span className="step-label">{st.label}</span>
                <span className="step-time">{st.time}</span>
                {d && (
                  <div className="pop step-pop" role="dialog">
                    <b>{st.label}</b> <Badge b={{ label: STATE_TEXT[st.state], tone: st.state === 'done' ? 'green' : st.state === 'current' ? 'blue' : 'grey' }} small />
                    <span className="pop-sub">{st.time}</span>
                    <span className="pop-sub">{d.text}</span>
                    {d.ref && <button className="link small" onClick={() => { goTo(d.ref!); setStep(null); }}><Crosshair size={12} /> Show {d.refLabel}</button>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      <button className="tr-card" title={`Show ${t.id} in the yard`} onClick={() => goTo({ kind: 'truck', id: t.id })}>
        <TruckGlyph color={carrierColor(t.carrier)} w={44} />
        <span className="tr-card-text">
          <b>{card.id}</b>
          <span className="muted ellipsis">{card.to}</span>
          <Badge b={card.badge} small />
          <span className="muted small ellipsis" style={{ maxWidth: '100%' }}>{card.line}</span>
        </span>
        <ChevronRight size={16} className="muted" />
      </button>
    </section>
  );
}

// ---------------------------------------------------------------- fleet list

type SortKey = 'default' | 'status' | 'id';
const SORT_LABEL: Record<SortKey, string> = { default: 'Default order', status: 'By status', id: 'By name' };

export function FleetList() {
  const facilityId = useApp((s) => s.facilityId);
  const tab = useApp((s) => s.fleetTab);
  const setTab = useApp((s) => s.setFleetTab);
  const sel = useApp((s) => s.selection);
  useApp((s) => s.tick);
  const flash = useFlash('wt:fleet-flash');
  const [sort, setSort] = useState<SortKey>('default');
  const listRef = useRef<HTMLDivElement>(null);
  const w = getWorld();
  const f = w.facilities[facilityId];
  const docks = docksOf(w, facilityId);
  const forks = forkliftsOf(w, facilityId);
  const busyDocks = docks.filter((d) => d.truckId).length;
  const working = forks.filter((x) => x.truckId).length;
  let rows: FleetRow[] = tab === 'docks' ? dockRows(w, facilityId) : tab === 'forklifts' ? forkliftRows(w, facilityId) : truckRows(w, facilityId);
  if (sort === 'status') rows = rows.slice().sort((a, b) => a.badge.label.localeCompare(b.badge.label) || a.title.localeCompare(b.title));
  if (sort === 'id') rows = rows.slice().sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  const nextSort = () => setSort((s) => (s === 'default' ? 'status' : s === 'status' ? 'id' : 'default'));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.fl-row') ?? []);
    if (!buttons.length) return;
    e.preventDefault();
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? Math.min(buttons.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
    buttons[next].focus();
    buttons[next].click();
  };
  return (
    <section className={`panel fleet ${flash ? 'flash' : ''}`} aria-label="Fleet and equipment">
      <div className="fl-head">
        <button className="fl-ico" title={`${SORT_LABEL[sort]} — click to change`} aria-label={`Sort: ${SORT_LABEL[sort]}`} onClick={nextSort}>
          {sort === 'default' ? <Warehouse size={15} /> : <ArrowDownUp size={15} />}
        </button>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'docks'} className={tab === 'docks' ? 'on' : ''} onClick={() => setTab('docks')}>Docks <span>{busyDocks}/{docks.length}</span></button>
          <button role="tab" aria-selected={tab === 'forklifts'} className={tab === 'forklifts' ? 'on' : ''} onClick={() => setTab('forklifts')}>Forklifts <span>{working}/{forks.length}</span></button>
          <button role="tab" aria-selected={tab === 'trucks'} className={tab === 'trucks' ? 'on' : ''} onClick={() => setTab('trucks')}>Trucks <span>{trucksOf(w, facilityId).length}</span></button>
        </div>
        <button className="fl-site" title="Site overview" onClick={() => goTo({ kind: 'facility', id: facilityId })}>{f.name}</button>
      </div>
      <div className="fl-rows" ref={listRef} onKeyDown={onKey} aria-label="Use the arrow keys to move through the list">
        {rows.map((r) => {
          const active = sel && sel.kind === r.ref.kind && sel.id === r.ref.id;
          return (
            <button key={r.key} className={`fl-row ${active ? 'active' : ''}`} onClick={() => goTo(r.ref)}>
              <span className="fl-id"><b>{r.title}</b><span>{r.sub}</span></span>
              <span className={`fl-text ${r.muted ? 'muted' : ''}`}>{r.dot && <i className="dotm" />}{r.text}</span>
              <Badge b={r.badge} small />
              <span className="fl-right">
                {r.bar !== undefined && <Bar value={r.bar} tone={r.barTone ?? 'green'} />}
                <span className="muted">{r.right}</span>
              </span>
              <ChevronRight size={15} className="muted" />
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 3D labels overlay

export function LabelsOverlay() {
  const facilityId = useApp((s) => s.facilityId);
  const sel = useApp((s) => s.selection);
  const hovered = useApp((s) => s.hovered);
  useApp((s) => s.tick);
  const specs = labelSpecs(getWorld(), facilityId, sel, hovered);
  const refs = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      for (const [k, el] of Object.entries(refs.current)) {
        if (!el) continue;
        const a = anchors.get(k);
        if (!a || !a.on) { el.style.opacity = '0'; continue; }
        el.style.opacity = '1';
        el.style.transform = `translate(${Math.round(a.x)}px, ${Math.round(a.y)}px) translate(-50%, -100%)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="labels" aria-hidden>
      {specs.map((s) => (
        <div key={s.key} ref={(el) => { refs.current[s.key] = el; }} className={`tag ${s.tone}`}>
          <b>{s.text}</b>{s.chip && <span>{s.chip}</span>}
        </div>
      ))}
    </div>
  );
}

