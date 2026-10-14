// Application state. The operations world lives in a mutable object (read every
// frame by the 3D scene); React UI re-renders on a throttled `tick`.
//
// Two modes:
//  - live:    signed in to the CargoVerse API. The server runs operations and stores
//             everything in Oracle; this client renders the live snapshots it streams.
//  - offline: no server reachable. A local demo runs in the browser (localStorage).
import { create } from 'zustand';
import type { WorldState, FacilityId, EntityRef } from './data/types';
import type { SessionUser, SimControl, DbLiveStatus } from './api/types';
import { dataSource } from './data/adapter';
import { createSeedWorld } from './data/seed';
import { stepWorld, syncPoses } from './sim/engine';
import { api, tokenStore, streamUrl, setUnauthorizedHandler } from './api/client';
import { findBuilding, findVehicle, setPark, syncParkClock } from './data/parkClient';
import { PARK_GATES, type GateCode } from './data/park';

export type FleetTab = 'docks' | 'forklifts' | 'trucks';
export type WorkTab = 'tasks' | 'alerts' | 'assistant' | 'activity' | 'team' | 'users' | 'reports' | 'trade' | 'port' | 'park' | 'database';
export type CameraCommand =
  | { kind: 'zoomIn' | 'zoomOut' | 'rotateLeft' | 'rotateRight' | 'home' | 'overview' }
  | { kind: 'focus'; ref: EntityRef };

let world: WorldState = createSeedWorld();
syncPoses(world);
export const getWorld = (): WorldState => world;

interface AppState {
  mode: 'live' | 'offline' | null;
  user: SessionUser | null;
  db: 'oracle' | 'memory' | null;
  connection: 'connecting' | 'live' | 'reconnecting';
  control: SimControl;
  versions: { tasks: number; audit: number; gate: number };
  /** Database write-through status from the live stream (null offline). */
  dbLive: DbLiveStatus | null;
  parkVersion: number;
  startView: 'park' | 'site';
  showPanels: boolean;
  togglePanels: () => void;
  ready: boolean;
  tick: number;
  facilityId: FacilityId;
  selection: EntityRef | null;
  hovered: EntityRef | null;
  fleetTab: FleetTab;
  follow: boolean;
  readEvents: number;
  cameraCmd: { seq: number; cmd: CameraCommand | null };
  timelineTruck: Record<string, string | null>;
  workOpen: boolean;
  workTab: WorkTab;
  toast: { id: number; text: string; tone: 'ok' | 'error' } | null;
  highlightSku: string | null;
  panelFocus: { section: 'inventory' | 'top'; seq: number };
  setHighlightSku: (sku: string | null) => void;
  focusPanel: (section: 'inventory' | 'top') => void;
  setFacility: (id: FacilityId) => void;
  select: (ref: EntityRef | null) => void;
  setHovered: (ref: EntityRef | null) => void;
  setFleetTab: (tab: FleetTab) => void;
  toggleFollow: () => void;
  camera: (cmd: CameraCommand) => void;
  markEventsRead: () => void;
  resetDemo: () => Promise<void>;
  openWork: (tab?: WorkTab) => void;
  closeWork: () => void;
  setControl: (c: Partial<SimControl>) => Promise<void>;
  notify: (text: string, tone?: 'ok' | 'error') => void;
  can: (perm: SessionUser['permissions'][number]) => boolean;
}

export const useApp = create<AppState>((set, get) => ({
  mode: null,
  user: null,
  db: null,
  connection: 'connecting',
  control: { paused: false, speed: 1 },
  versions: { tasks: 0, audit: 0, gate: 0 },
  dbLive: null,
  parkVersion: 0,
  startView: typeof location !== 'undefined' && new URLSearchParams(location.search).get('view') === 'site' ? 'site' : 'park',
  showPanels: true,
  togglePanels: () => set({ showPanels: !get().showPanels }),
  ready: false,
  tick: 0,
  facilityId: 'WH-01',
  selection: null,
  hovered: null,
  fleetTab: 'docks',
  follow: false,
  readEvents: 0,
  cameraCmd: { seq: 0, cmd: null },
  timelineTruck: {},
  workOpen: false,
  workTab: 'tasks',
  toast: null,
  highlightSku: null,
  panelFocus: { section: 'top', seq: 0 },
  setHighlightSku: (sku) => set({ highlightSku: sku }),
  focusPanel: (section) => set({ panelFocus: { section, seq: get().panelFocus.seq + 1 } }),
  setFacility: (id) => {
    if (id === get().facilityId) return;
    const u = get().user;
    if (u && !u.facilities.includes(id)) return;
    set({ facilityId: id, selection: null, follow: false, hovered: null, highlightSku: null });
    get().camera({ kind: 'home' });
  },
  select: (ref) => {
    const patch: Partial<AppState> = { selection: ref };
    if (!ref || (ref.kind !== 'truck' && ref.kind !== 'forklift')) patch.follow = false;
    if (ref?.kind === 'truck') {
      const t = world.trucks[ref.id];
      if (t) {
        patch.timelineTruck = { ...get().timelineTruck, [t.facilityId]: t.id };
        if (t.facilityId !== get().facilityId) patch.facilityId = t.facilityId;
      }
    } else if (ref && ref.kind !== 'facility') {
      const fac = facilityOf(ref);
      if (fac && fac !== get().facilityId) patch.facilityId = fac;
    } else if (ref?.kind === 'facility') {
      const u = get().user;
      if (!u || u.facilities.includes(ref.id as FacilityId)) patch.facilityId = ref.id as FacilityId;
    }
    if (patch.facilityId && get().user && !get().user!.facilities.includes(patch.facilityId)) delete patch.facilityId;
    set(patch);
  },
  setHovered: (ref) => set({ hovered: ref }),
  setFleetTab: (tab) => set({ fleetTab: tab }),
  toggleFollow: () => set({ follow: !get().follow }),
  camera: (cmd) => set({ cameraCmd: { seq: get().cameraCmd.seq + 1, cmd } }),
  markEventsRead: () => set({ readEvents: world.eventSeq }),
  resetDemo: async () => {
    if (get().mode !== 'offline') return;
    world = await dataSource.resetWorld();
    syncPoses(world);
    set({ selection: null, follow: false, facilityId: 'WH-01', fleetTab: 'docks', readEvents: 0, timelineTruck: {}, tick: get().tick + 1 });
    get().camera({ kind: 'home' });
  },
  openWork: (tab) => set({ workOpen: true, workTab: tab ?? get().workTab }),
  closeWork: () => set({ workOpen: false }),
  setControl: async (c) => {
    if (get().mode === 'live') {
      try {
        const next = await api.simControl(c);
        set({ control: next });
      } catch (e) {
        get().notify((e as Error).message, 'error');
      }
    } else {
      set({ control: { ...get().control, ...c } });
    }
  },
  notify: (text, tone = 'ok') => set({ toast: { id: Date.now(), text, tone } }),
  can: (perm) => {
    const u = get().user;
    // offline demo: no accounts, so only the dashboard and local operations controls are available
    if (get().mode === 'offline') return perm === 'VIEW_DASHBOARD' || perm === 'CONTROL_SIMULATION';
    return !!u && u.permissions.includes(perm);
  },
}));

export function facilityOf(ref: EntityRef): FacilityId | null {
  switch (ref.kind) {
    case 'facility': return ref.id as FacilityId;
    case 'truck': return world.trucks[ref.id]?.facilityId ?? null;
    case 'forklift': return world.forklifts[ref.id]?.facilityId ?? null;
    case 'pallet': return world.pallets[ref.id]?.facilityId ?? null;
    case 'dock': return world.docks[ref.id]?.facilityId ?? null;
    case 'charger': return world.chargers[ref.id]?.facilityId ?? null;
    case 'asset': { const f = ref.id.split('|')[0] as FacilityId; return world.facilities[f] ? f : null; }
    case 'building': return findBuilding(ref.id)?.facilityId ?? null;
    case 'van': return (world.retail?.vans[ref.id]?.facilityId as FacilityId | undefined) ?? null;
    case 'vehicle':
    case 'gate':
    case 'vessel':
    case 'crane':
    case 'berth':
    case 'store': return null;
  }
}

export function entityExists(ref: EntityRef | null): boolean {
  if (!ref) return false;
  switch (ref.kind) {
    case 'facility': return !!world.facilities[ref.id];
    case 'truck': return !!world.trucks[ref.id];
    case 'forklift': return !!world.forklifts[ref.id];
    case 'pallet': return !!world.pallets[ref.id];
    case 'dock': return !!world.docks[ref.id];
    case 'charger': return !!world.chargers[ref.id];
    case 'asset': return !!world.facilities[ref.id.split('|')[0]];
    case 'building': return !!findBuilding(ref.id);
    case 'vehicle': return !!findVehicle(ref.id);
    case 'gate': return !!PARK_GATES[ref.id as GateCode];
    case 'vessel': return !!world.port?.vessels[ref.id];
    case 'crane': return !!world.port?.cranes[ref.id];
    case 'berth': return !!world.port?.berths[ref.id];
    case 'store': return !!world.retail?.stores[ref.id];
    case 'van': return !!world.retail?.vans[ref.id];
  }
}

function restoreUi(ui: Awaited<ReturnType<typeof dataSource.loadUi>>, allowed: FacilityId[]) {
  const home = useApp.getState().user?.homeFacility;
  const facilityId = ui.facilityId && allowed.includes(ui.facilityId) ? ui.facilityId : home && allowed.includes(home) ? home : allowed[0];
  const sel = ui.selection && entityExists(ui.selection) && facilityOf(ui.selection) === facilityId ? ui.selection : null;
  return { facilityId, selection: sel, fleetTab: ui.fleetTab ?? 'docks', readEvents: ui.readEvents ?? 0 };
}

function saveUi() {
  const s = useApp.getState();
  void dataSource.saveUi({ facilityId: s.facilityId, selection: s.selection, fleetTab: s.fleetTab, readEvents: s.readEvents });
}

// ---------------------------------------------------------------- live mode (API + Oracle)

/** Connects to the live operations stream. Resolves once the first snapshot arrives. */
export function startLive(user: SessionUser, db: 'oracle' | 'memory'): Promise<() => void> {
  useApp.setState({ mode: 'live', user, db, connection: 'connecting', ready: false });
  setUnauthorizedHandler(() => { void signOut(true); });
  // tenants, buildings and vehicles of the logistics park come from the database
  void api.park().then((p) => { setPark(p); useApp.setState({ parkVersion: useApp.getState().parkVersion + 1 }); }).catch(() => undefined);
  return new Promise((resolve) => {
    let es: EventSource | null = null;
    let closed = false;
    let first = true;
    let retry: number | undefined;
    const uiTimer = window.setInterval(saveUi, 3000);
    const connect = () => {
      es = new EventSource(streamUrl());
      es.addEventListener('snapshot', (ev) => {
        const d = JSON.parse((ev as MessageEvent<string>).data) as { world: WorldState; control: SimControl; versions: { tasks: number; audit: number; gate: number }; db?: DbLiveStatus };
        world = d.world;
        syncParkClock(world.realTime, d.control.paused, d.control.speed);
        const s = useApp.getState();
        const patch: Partial<AppState> = { control: d.control, versions: d.versions, connection: 'live', tick: s.tick + 1, dbLive: d.db ?? null };
        if (first) {
          first = false;
          Object.assign(patch, restoreUi(loadUiSync(), user.facilities), { ready: true });
          useApp.setState(patch);
          resolve(stop);
          return;
        }
        if (s.selection && !entityExists(s.selection)) patch.selection = null;
        useApp.setState(patch);
      });
      es.onerror = () => {
        if (closed) return;
        useApp.setState({ connection: 'reconnecting' });
        es?.close();
        // check whether the session is still valid before reconnecting
        retry = window.setTimeout(() => {
          api.me().then(() => { if (!closed) connect(); }).catch(() => { if (!closed) retry = window.setTimeout(connect, 3000); });
        }, 1500);
      };
    };
    const stop = () => {
      closed = true;
      es?.close();
      window.clearTimeout(retry);
      window.clearInterval(uiTimer);
      saveUi();
    };
    connect();
  });
}

let uiCache: Awaited<ReturnType<typeof dataSource.loadUi>> = {};
export async function preloadUi(): Promise<void> { uiCache = await dataSource.loadUi(); }
function loadUiSync() { return uiCache; }

let stopCurrent: (() => void) | null = null;
export function setStopper(fn: (() => void) | null) { stopCurrent = fn; }

export async function signOut(expired = false): Promise<void> {
  if (!expired) { try { await api.logout(); } catch { /* ignore */ } }
  tokenStore.clear();
  stopCurrent?.();
  stopCurrent = null;
  useApp.setState({ mode: null, user: null, ready: false, selection: null, workOpen: false, follow: false });
  if (expired) useApp.getState().notify('Your session has ended. Please sign in again.', 'error');
}

// ---------------------------------------------------------------- offline demo mode

/** Runs the demo locally in the browser (used when no API server is reachable). */
export async function startOffline(): Promise<() => void> {
  world = await dataSource.loadWorld();
  syncPoses(world);
  const ui = await dataSource.loadUi();
  useApp.setState({ mode: 'offline', user: null, db: null, connection: 'live', ...restoreUi(ui, ['WH-01', 'WH-02', 'WH-04']), ready: true });

  let last = performance.now();
  let lastTick = 0;
  let lastSave = last;
  let raf = 0;
  const step = (dt: number) => {
    const c = useApp.getState().control;
    if (c.paused) return;
    let remaining = dt * c.speed;
    while (remaining > 1e-6) { const s = Math.min(0.2, remaining); stepWorld(world, s); remaining -= s; }
  };
  const loop = (now: number) => {
    step(Math.min(1, (now - last) / 1000));
    const ctl = useApp.getState().control;
    syncParkClock(world.realTime, ctl.paused, ctl.speed);
    last = now;
    const s = useApp.getState();
    if (s.selection && !entityExists(s.selection)) s.select(null);
    if (now - lastTick > 250) { lastTick = now; useApp.setState({ tick: s.tick + 1 }); }
    if (now - lastSave > 3000) { lastSave = now; persist(); }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  const bg = window.setInterval(() => {
    if (document.hidden) { const now = performance.now(); step(Math.min(1.5, (now - last) / 1000)); last = now; }
  }, 1000);
  const persist = () => { void dataSource.saveWorld(world); saveUi(); };
  window.addEventListener('beforeunload', persist);
  return () => {
    cancelAnimationFrame(raf);
    window.clearInterval(bg);
    window.removeEventListener('beforeunload', persist);
    persist();
  };
}
