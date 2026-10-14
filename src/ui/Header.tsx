import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronRight, ChevronDown, Bell, RotateCcw, LogOut, ClipboardList, Pause, Play, Database, LogIn, Sparkles } from 'lucide-react';
import type { FacilityId } from '../data/types';
import { getWorld, useApp, signOut } from '../store';
import { api } from '../api/client';
import { search, fmtClock, facilityHeadline, type SearchResult } from './derive';
import { LogoCube } from './icons';

function useDismiss<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}

function SearchBox() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const select = useApp((s) => s.select);
  const camera = useApp((s) => s.camera);
  const tick = useApp((s) => s.tick);
  const results = useMemo(() => search(getWorld(), q), [q, tick]);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); input.current?.focus(); setOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const choose = (r: SearchResult) => {
    select(r.ref);
    if (r.ref.kind === 'facility') camera({ kind: 'home' });
    else setTimeout(() => camera({ kind: 'focus', ref: r.ref }), 30);
    setOpen(false);
    setQ('');
    input.current?.blur();
  };

  return (
    <div className="search" ref={ref}>
      <Search size={16} className="search-ico" />
      <input
        ref={input}
        value={q}
        placeholder="Search sites, trucks, forklifts, pallets, shipments..."
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          if (e.key === 'Enter' && results[active]) choose(results[active]);
          if (e.key === 'Escape') { setOpen(false); input.current?.blur(); }
        }}
        aria-label="Search"
      />
      <kbd>/</kbd>
      {open && q.trim() && (
        <div className="dropdown search-results" role="listbox">
          {results.length === 0 && <div className="dd-empty">No matches for “{q}”</div>}
          {results.map((r, i) => (
            <button key={`${r.ref.kind}-${r.ref.id}`} className={`dd-item ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => choose(r)}>
              <span className="dd-kind">{r.kind}</span>
              <span className="dd-main">
                <span className="dd-title">{r.title}</span>
                <span className="dd-sub">{r.sub}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FacilityPicker() {
  const facilityId = useApp((s) => s.facilityId);
  const setFacility = useApp((s) => s.setFacility);
  const select = useApp((s) => s.select);
  useApp((s) => s.tick);
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const w = getWorld();
  const f = w.facilities[facilityId];
  const h = facilityHeadline(w, facilityId);
  return (
    <div className="fac" ref={ref}>
      <button className="fac-pill" onClick={() => select({ kind: 'facility', id: facilityId })} title="Show site overview">
        <span className="fac-badge">{f.id}</span>
        <span className="fac-text">
          <span className="fac-name">{f.name}</span>
          <span className="fac-sub">{h.fullPct}% full · {h.docked}/{h.docksTotal} docked</span>
        </span>
        <ChevronRight size={15} className="muted" />
      </button>
      <button className="fac-drop" onClick={() => setOpen((o) => !o)} aria-label="Switch warehouse" aria-expanded={open}>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="dropdown fac-menu">
          {((useApp.getState().user?.facilities ?? ['WH-01', 'WH-02', 'WH-04']) as FacilityId[]).filter((id) => w.facilities[id]).map((id) => {
            const ff = w.facilities[id];
            const hh = facilityHeadline(w, id);
            return (
              <button key={id} className={`dd-item ${id === facilityId ? 'active' : ''}`} onClick={() => { setFacility(id); setOpen(false); }}>
                <span className="fac-badge">{id}</span>
                <span className="dd-main">
                  <span className="dd-title">{ff.name}</span>
                  <span className="dd-sub">{hh.fullPct}% full · {hh.docked}/{hh.docksTotal} docked</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const readEvents = useApp((s) => s.readEvents);
  const markRead = useApp((s) => s.markEventsRead);
  const select = useApp((s) => s.select);
  const camera = useApp((s) => s.camera);
  useApp((s) => s.tick);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const w = getWorld();
  const unread = w.eventSeq > readEvents;
  return (
    <div className="bell-wrap" ref={ref}>
      <button className="icon-btn" aria-label="Notifications" onClick={() => { setOpen((o) => !o); markRead(); }}>
        <Bell size={19} />
        {unread && <span className="dot" />}
      </button>
      {open && (
        <div className="dropdown notif">
          <div className="dd-head">Activity</div>
          {w.events.slice(0, 12).map((e, i) => (
            <button key={`${e.t}-${i}`} className="dd-item" onClick={() => { if (e.ref) { select(e.ref); setTimeout(() => camera({ kind: 'focus', ref: e.ref! }), 30); } setOpen(false); }}>
              <span className="dd-time">{fmtClock(e.t)}</span>
              <span className="dd-main">
                <span className="dd-title">{e.text}</span>
                <span className="dd-sub">{w.facilities[e.facilityId].name}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const FAC_LABEL: Record<string, string> = { 'WH-01': 'Riverside Hub', 'WH-02': 'Northgate DC', 'WH-04': 'Southfield Cross-Dock' };

function Profile() {
  const [open, setOpen] = useState(false);
  const user = useApp((s) => s.user);
  const mode = useApp((s) => s.mode);
  const db = useApp((s) => s.db);
  const reset = useApp((s) => s.resetDemo);
  const openWork = useApp((s) => s.openWork);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const name = user?.fullName ?? 'Offline demo';
  const role = user ? user.jobTitle : 'Not signed in';
  return (
    <div className="profile-wrap" ref={ref}>
      <button className="profile" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Account menu">
        <span className={`avatar-init ${user ? user.role.toLowerCase() : 'guest'}`}>{user ? user.fullName.split(' ').map((p) => p[0]).join('').slice(0, 2) : 'WT'}</span>
        <span className="profile-text">
          <span className="profile-name">{name}</span>
          <span className="profile-role">{role}</span>
        </span>
        <ChevronDown size={16} className="muted" />
      </button>
      {open && (
        <div className="dropdown profile-menu">
          {user ? (
            <>
              <div className="pm-card">
                <b>{user.fullName}</b>
                <span className="muted small">@{user.username} · {user.email}</span>
                <span className="pm-chips">
                  <span className={`role-chip r-${user.role.toLowerCase()}`}>{user.roleName}</span>
                  {(user.role === 'ADMIN' ? ['All sites'] : user.facilities.map((f) => FAC_LABEL[f] ?? f)).map((f) => <span key={f} className="fac-chip">{f}</span>)}
                </span>
                <span className="muted small db-line"><Database size={12} /> {db === 'oracle' ? 'Oracle Database' : 'Development store (no Oracle)'}</span>
              </div>
              <button className="dd-item" onClick={() => { openWork(user.role === 'ADMIN' ? 'users' : 'tasks'); setOpen(false); }}>
                <ClipboardList size={15} />
                <span className="dd-main"><span className="dd-title">{user.role === 'ADMIN' ? 'Administration' : user.role === 'MANAGER' ? 'Tasks & team' : 'My tasks'}</span><span className="dd-sub">Open the work panel</span></span>
              </button>
              <button className="dd-item" onClick={() => { void signOut(); }}>
                <LogOut size={15} />
                <span className="dd-main"><span className="dd-title">Sign out</span><span className="dd-sub">End this session on this device</span></span>
              </button>
            </>
          ) : (
            <>
              <div className="dd-head">Offline demo — data stays in this browser</div>
              {mode === 'offline' && (
                <button className="dd-item" onClick={() => { void reset(); setOpen(false); }}>
                  <RotateCcw size={15} />
                  <span className="dd-main"><span className="dd-title">Reset demo data</span><span className="dd-sub">Restore the seeded demonstration state</span></span>
                </button>
              )}
              <button className="dd-item" onClick={() => window.location.reload()}>
                <LogIn size={15} />
                <span className="dd-main"><span className="dd-title">Sign in</span><span className="dd-sub">Connect to the CargoVerse server</span></span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LiveClock() {
  useApp((s) => s.tick);
  const control = useApp((s) => s.control);
  const connection = useApp((s) => s.connection);
  const can = useApp((s) => s.can);
  const setControl = useApp((s) => s.setControl);
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const t = getWorld().simTime;
  const allowed = can('CONTROL_SIMULATION');
  const state = connection === 'reconnecting' ? 'reconnecting' : control.paused ? 'paused' : 'live';
  const label = state === 'reconnecting' ? 'Reconnecting' : state === 'paused' ? 'Paused' : 'Live';
  return (
    <div className="live-wrap" ref={ref}>
      <button className={`live ${state}`} onClick={() => allowed && setOpen((o) => !o)} disabled={!allowed}
        title={allowed ? 'Operations clock — pause, resume or change speed' : 'Operations clock'} aria-expanded={open}>
        <span className="live-dot" />{label} <b>{fmtClock(t)}</b>{control.speed > 1 && <i className="speed">{control.speed}×</i>}
      </button>
      {open && (
        <div className="dropdown live-menu">
          <div className="dd-head">Operations clock</div>
          <button className="dd-item" onClick={() => { void setControl({ paused: !control.paused }); setOpen(false); }}>
            {control.paused ? <Play size={15} /> : <Pause size={15} />}
            <span className="dd-main"><span className="dd-title">{control.paused ? 'Resume operations' : 'Pause operations'}</span><span className="dd-sub">{control.paused ? 'Vehicles start moving again' : 'Freezes all trucks and forklifts for everyone'}</span></span>
          </button>
          <div className="speed-row">
            <span className="muted small">Speed</span>
            {[1, 2, 4].map((sp) => (
              <button key={sp} className={control.speed === sp ? 'on' : ''} onClick={() => { void setControl({ speed: sp }); }}>{sp}×</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AskAiButton() {
  const user = useApp((s) => s.user);
  const openWork = useApp((s) => s.openWork);
  if (!user) return null;
  return (
    <button className="icon-btn ai-btn" onClick={() => openWork('assistant')} aria-label="Ask the AI assistant" title="Ask the AI operations assistant">
      <Sparkles size={18} />
    </button>
  );
}

function WorkButton() {
  const user = useApp((s) => s.user);
  const version = useApp((s) => s.versions.tasks);
  const openWork = useApp((s) => s.openWork);
  const workOpen = useApp((s) => s.workOpen);
  const closeWork = useApp((s) => s.closeWork);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    api.tasks({ scope: 'mine' }).then((t) => { if (alive) setCount(t.filter((x) => x.status === 'ASSIGNED' || x.status === 'IN_PROGRESS' || x.status === 'BLOCKED').length); }).catch(() => undefined);
    return () => { alive = false; };
  }, [user, version]);
  if (!user) return null;
  return (
    <button className={`work-btn ${workOpen ? 'on' : ''}`} onClick={() => (workOpen ? closeWork() : openWork())} aria-label="Work panel" title="Tasks, activity and team">
      <ClipboardList size={17} />
      <span>{user.role === 'OPERATOR' ? 'My tasks' : 'Work'}</span>
      {count > 0 && <span className="count">{count}</span>}
    </button>
  );
}

export function Header() {
  const camera = useApp((s) => s.camera);
  const select = useApp((s) => s.select);
  return (
    <header className="hdr">
      <button className="brand" onClick={() => { select(null); camera({ kind: 'home' }); }} title="Back to the site overview"><LogoCube /> <span>CargoVerse</span></button>
      <SearchBox />
      <div className="hdr-right">
        <FacilityPicker />
        <LiveClock />
        <AskAiButton />
        <WorkButton />
        <Notifications />
        <Profile />
      </div>
    </header>
  );
}
