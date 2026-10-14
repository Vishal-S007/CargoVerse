import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import { startLive, startOffline, setStopper, preloadUi, useApp } from './store';
import { api, tokenStore, ApiError } from './api/client';
import { WarehouseScene, webglAvailable } from './scene/Scene';
import { Header } from './ui/Header';
import { KpiCards, SceneControls, InfoPanel, ShipmentTracking, FleetList, LabelsOverlay } from './ui/Panels';
import { LoginPage } from './ui/Login';
import { Workspace, Toast } from './ui/Workspace';
import { MapLegend } from './ui/ParkPanels';

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) { console.warn('3D scene failed to initialise', err); }
  render() { return this.state.failed ? <SceneFallback /> : this.props.children; }
}

function SceneFallback() {
  return (
    <div className="scene-fallback">
      <div>
        <b>3D view unavailable</b>
        <span>WebGL is disabled or not supported in this browser. Live data, panels and controls keep working.</span>
      </div>
    </div>
  );
}

type Boot = 'checking' | 'login' | 'app';

export default function App() {
  const ready = useApp((s) => s.ready);
  const mode = useApp((s) => s.mode);
  const showPanels = useApp((s) => s.showPanels);
  const [boot, setBoot] = useState<Boot>('checking');
  const [serverDown, setServerDown] = useState(false);
  const [db, setDb] = useState<'oracle' | 'memory' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [gl] = useState(() => webglAvailable());

  const enterLive = useCallback(async (user: Parameters<typeof startLive>[0], dbKind: 'oracle' | 'memory') => {
    await preloadUi();
    const stop = await startLive(user, dbKind);
    setStopper(stop);
    setBoot('app');
  }, []);

  // initial: find the server, then resume a remembered session if there is one
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let dbKind: 'oracle' | 'memory' | null = null;
      try {
        dbKind = (await api.health()).db;
        if (cancelled) return;
        setDb(dbKind);
      } catch {
        if (!cancelled) { setServerDown(true); setBoot('login'); }
        return;
      }
      if (!tokenStore.get()) { setBoot('login'); return; }
      try {
        const { user } = await api.me();
        if (!cancelled) await enterLive(user, dbKind);
      } catch (e) {
        tokenStore.clear();
        if (!cancelled) {
          if (e instanceof ApiError && e.status === 401) setNotice('Your session has expired. Please sign in again.');
          setBoot('login');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [enterLive]);

  // signing out returns to the login page
  useEffect(() => { if (boot === 'app' && mode === null) setBoot('login'); }, [boot, mode]);

  const login = async (username: string, password: string, remember: boolean) => {
    const { token, user } = await api.login(username, password, remember);
    tokenStore.set(token, remember);
    setNotice(null);
    await enterLive(user, db ?? 'oracle');
  };

  const offline = async () => {
    const stop = await startOffline();
    setStopper(stop);
    setBoot('app');
  };

  if (boot === 'checking') return <div className="boot"><div className="spinner" /> Connecting to CargoVerse…</div>;
  if (boot === 'login') {
    return (
      <>
        <LoginPage serverDown={serverDown} db={db} onLogin={login} onOffline={() => { void offline(); }} notice={notice} />
        <Toast />
      </>
    );
  }
  return (
    <div className="app">
      <div className="scene">
        {ready && (gl ? <SceneBoundary><WarehouseScene /></SceneBoundary> : <SceneFallback />)}
      </div>
      {ready && gl && <LabelsOverlay />}
      <Header />
      {ready && (
        <>
          <SceneControls />
          {showPanels ? (
            <>
              <KpiCards />
              <InfoPanel />
              <ShipmentTracking />
              <FleetList />
            </>
          ) : <MapLegend />}
          <Workspace />
        </>
      )}
      {mode === 'offline' && <div className="offline-banner">Offline demo — no server connection, nothing is saved to the database</div>}
      <Toast />
    </div>
  );
}
