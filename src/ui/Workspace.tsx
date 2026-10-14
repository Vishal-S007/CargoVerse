// Work panel: tasks, activity history, team, reports and user administration.
// Tabs and actions follow the signed-in user's role permissions.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  X, Plus, RefreshCw, ChevronDown, ChevronRight, Crosshair, Play, Pause, CheckCircle2, Ban, UserRound, History,
  ClipboardList, Users, BarChart3, ShieldCheck, Truck as TruckIcon, Clock3, AlertTriangle, KeyRound, Sparkles, ArrowDownUp, Building2, Database, Anchor,
} from 'lucide-react';
import { AlertsTab, AssistantTab } from './Agents';
import { TradeTab, ParkTab, DatabaseTab } from './DataTabs';
import { PortTab } from './PortTab';
import { carrierName } from '../data/seed';
import type { FacilityId, EntityRef } from '../data/types';
import type {
  Task, TaskUpdate, TaskStatus, TaskType, Priority, AuditEntry, Employee, UserRecord, KpiRow, WorkloadRow, LowStockRow,
  JobTitle, RoleInfo, Role,
} from '../api/types';
import { TASK_TRANSITIONS, OPERATOR_TRANSITIONS } from '../api/types';
import { api } from '../api/client';
import { getWorld, useApp, type WorkTab } from '../store';
import { fmtClock } from './derive';

const FAC_NAMES: Record<FacilityId, string> = { 'WH-01': 'Riverside Hub', 'WH-02': 'Northgate DC', 'WH-04': 'Southfield Cross-Dock' };
const STATUS_LABEL: Record<TaskStatus, string> = { OPEN: 'Open', ASSIGNED: 'Assigned', IN_PROGRESS: 'In progress', BLOCKED: 'Blocked', DONE: 'Done', CANCELLED: 'Cancelled' };
const STATUS_TONE: Record<TaskStatus, string> = { OPEN: 'grey', ASSIGNED: 'blue', IN_PROGRESS: 'green', BLOCKED: 'orange', DONE: 'indigo', CANCELLED: 'grey' };
const TYPE_LABEL: Record<TaskType, string> = { UNLOAD: 'Unload', LOAD: 'Load', PUTAWAY: 'Put-away', CYCLE_COUNT: 'Cycle count', MAINTENANCE: 'Maintenance', DOCK_CHECK: 'Dock check', OTHER: 'Other' };
const PRIORITY_TONE: Record<Priority, string> = { LOW: 'grey', NORMAL: 'blue', HIGH: 'orange', URGENT: 'red' };
const ACTION_LABEL: Record<string, string> = {
  LOGIN: 'Signed in', LOGIN_FAILED: 'Failed sign-in', LOGOUT: 'Signed out', TASK_CREATED: 'Created task', TASK_STATUS: 'Task status',
  TASK_ASSIGNED: 'Assigned task', TASK_PRIORITY: 'Task priority', USER_CREATED: 'Created user', USER_UPDATED: 'Updated user',
  USER_DELETED: 'Deleted user', ACCESS_GRANTED: 'Granted access', ACCESS_REVOKED: 'Revoked access', EMPLOYEE_ADDED: 'Added employee',
  EMPLOYEE_UPDATED: 'Updated employee', OPS_PAUSED: 'Paused operations', OPS_RESUMED: 'Resumed operations', OPS_SPEED: 'Changed speed',
  BUILDING_UPDATED: 'Updated building', SQL_QUERY: 'Ran SQL query',
};

const AUTO_NOTES = new Set(['Task created', 'Created automatically by operations']);

const when = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (Math.abs(diff) < 60) return diff >= 0 ? 'just now' : 'in <1 min';
  if (diff > 0 && diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 0 && diff > -86400) return `in ${Math.ceil(-diff / 60) >= 60 ? `${Math.round(-diff / 3600)} h` : `${Math.ceil(-diff / 60)} min`}`;
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
};

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`badge sm tone-${tone}`}>{children}</span>;
}

function useLoader<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn().then((d) => { if (alive) { setData(d); setError(null); } }).catch((e) => { if (alive) setError((e as Error).message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1) };
}

function locate(ref: EntityRef) {
  const s = useApp.getState();
  s.select(ref);
  setTimeout(() => s.camera({ kind: 'focus', ref }), 30);
}

// ---------------------------------------------------------------- panel shell

export function Workspace() {
  const open = useApp((s) => s.workOpen);
  const tab = useApp((s) => s.workTab);
  const user = useApp((s) => s.user);
  const close = useApp((s) => s.closeWork);
  const openWork = useApp((s) => s.openWork);
  const [prefill, setPrefill] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);
  if (!open || !user) return null;
  const has = (p: string) => user.permissions.includes(p as never);
  const tabs: { id: WorkTab; label: string; icon: JSX.Element; show: boolean }[] = [
    { id: 'tasks', label: has('MANAGE_TASKS') ? 'Tasks' : 'My tasks', icon: <ClipboardList size={15} />, show: true },
    { id: 'alerts', label: 'Alerts', icon: <AlertTriangle size={15} />, show: has('VIEW_TEAM') },
    { id: 'assistant', label: 'Assistant', icon: <Sparkles size={15} />, show: true },
    { id: 'activity', label: 'Activity', icon: <History size={15} />, show: has('VIEW_AUDIT') },
    { id: 'team', label: 'Team', icon: <Users size={15} />, show: has('VIEW_TEAM') },
    { id: 'trade', label: 'Imports/Exports', icon: <ArrowDownUp size={15} />, show: true },
    { id: 'port', label: 'Port & stores', icon: <Anchor size={15} />, show: true },
    { id: 'reports', label: 'Reports', icon: <BarChart3 size={15} />, show: has('VIEW_REPORTS') },
    { id: 'park', label: 'Park', icon: <Building2 size={15} />, show: true },
    { id: 'database', label: 'Database', icon: <Database size={15} />, show: has('VIEW_DATABASE') },
    { id: 'users', label: 'Users', icon: <ShieldCheck size={15} />, show: has('MANAGE_USERS') },
  ];
  const visible = tabs.filter((t) => t.show);
  const current = visible.some((t) => t.id === tab) ? tab : 'tasks';
  return (
    <aside className={`work ${current === 'database' || current === 'trade' || current === 'park' || current === 'port' ? 'wide' : ''}`} role="dialog" aria-label="Work and activity">
      <div className="work-head">
        <div>
          <div className="work-title">{user.role === 'OPERATOR' ? 'My work' : user.role === 'ADMIN' ? 'Administration' : 'Operations management'}</div>
          <div className="muted small">{user.fullName} · {user.jobTitle} · {user.role === 'ADMIN' ? 'all sites' : user.facilities.map((f) => FAC_NAMES[f]).join(', ')}</div>
        </div>
        <button className="sq plain" onClick={close} aria-label="Close"><X size={16} /></button>
      </div>
      <div className="work-tabs" role="tablist">
        {visible.map((t) => (
          <button key={t.id} role="tab" aria-selected={current === t.id} className={current === t.id ? 'on' : ''} onClick={() => openWork(t.id)}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>
      <div className="work-body">
        {current === 'tasks' && <TasksTab prefillAssignee={prefill} clearPrefill={() => setPrefill(null)} />}
        {current === 'alerts' && <AlertsTab />}
        {current === 'assistant' && <AssistantTab />}
        {current === 'activity' && <ActivityTab />}
        {current === 'team' && <TeamTab onAssign={(id) => { setPrefill(id); openWork('tasks'); }} />}
        {current === 'reports' && <ReportsTab />}
        {current === 'users' && <UsersTab />}
        {current === 'trade' && <TradeTab />}
        {current === 'park' && <ParkTab />}
        {current === 'port' && <PortTab />}
        {current === 'database' && <DatabaseTab />}
      </div>
    </aside>
  );
}

function FacilitySelect({ value, onChange, allowAll }: { value: FacilityId | 'ALL'; onChange: (f: FacilityId | 'ALL') => void; allowAll?: boolean }) {
  const user = useApp((s) => s.user)!;
  return (
    <select className="sel" value={value} onChange={(e) => onChange(e.target.value as FacilityId | 'ALL')} aria-label="Facility">
      {allowAll && <option value="ALL">All sites</option>}
      {user.facilities.map((f) => <option key={f} value={f}>{f} · {FAC_NAMES[f]}</option>)}
    </select>
  );
}

// ---------------------------------------------------------------- tasks

function TasksTab({ prefillAssignee, clearPrefill }: { prefillAssignee: number | null; clearPrefill: () => void }) {
  const user = useApp((s) => s.user)!;
  const current = useApp((s) => s.facilityId);
  const version = useApp((s) => s.versions.tasks);
  const manager = user.permissions.includes('MANAGE_TASKS');
  const [facility, setFacility] = useState<FacilityId>(current);
  const [showClosed, setShowClosed] = useState(false);
  const [mineOnly, setMineOnly] = useState(!manager);
  const [creating, setCreating] = useState(false);
  useEffect(() => setFacility(current), [current]);
  useEffect(() => { if (prefillAssignee !== null) setCreating(true); }, [prefillAssignee]);
  const tasks = useLoader(
    () => api.tasks({ facility: manager ? facility : undefined, scope: mineOnly ? 'mine' : undefined, closed: showClosed }),
    [facility, showClosed, mineOnly, version, manager],
  );
  const employees = useLoader(() => (manager ? api.employees(facility) : Promise.resolve([] as Employee[])), [facility, manager]);
  const list = tasks.data ?? [];
  const counts = useMemo(() => {
    const c: Partial<Record<TaskStatus, number>> = {};
    for (const t of list) c[t.status] = (c[t.status] ?? 0) + 1;
    return c;
  }, [list]);

  return (
    <div className="tab">
      <div className="toolbar">
        {manager ? <FacilitySelect value={facility} onChange={(f) => setFacility(f as FacilityId)} /> : <span className="muted small">{FAC_NAMES[user.facilities[0]]}</span>}
        <div className="seg">
          {manager && <button className={!mineOnly ? 'on' : ''} onClick={() => setMineOnly(false)}>Site</button>}
          {manager && <button className={mineOnly ? 'on' : ''} onClick={() => setMineOnly(true)}>Mine</button>}
          <button className={!showClosed ? 'on' : ''} onClick={() => setShowClosed(false)}>Open</button>
          <button className={showClosed ? 'on' : ''} onClick={() => setShowClosed(true)}>All</button>
        </div>
        <button className="sq" title="Refresh" aria-label="Refresh" onClick={tasks.reload}><RefreshCw size={14} /></button>
        {manager && (
          <button className="btn-primary sm" onClick={() => setCreating((c) => !c)}><Plus size={14} /> New task</button>
        )}
      </div>
      {!manager && user.forkliftId && (
        <button className="my-forklift" onClick={() => locate({ kind: 'forklift', id: user.forkliftId! })}>
          <Crosshair size={14} /> Show my forklift {user.forkliftId} in the yard
        </button>
      )}
      {creating && manager && (
        <NewTaskForm facility={facility} employees={employees.data ?? []} prefillAssignee={prefillAssignee}
          onDone={() => { setCreating(false); clearPrefill(); tasks.reload(); }} onCancel={() => { setCreating(false); clearPrefill(); }} />
      )}
      <div className="summary">
        {(['ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'OPEN'] as TaskStatus[]).map((s) => (
          <span key={s}><Pill tone={STATUS_TONE[s]}>{STATUS_LABEL[s]}</Pill> {counts[s] ?? 0}</span>
        ))}
      </div>
      {tasks.error && <div className="err">{tasks.error}</div>}
      {!tasks.loading && !list.length && <div className="empty">{mineOnly ? 'No tasks assigned to you right now.' : 'No tasks match this filter.'}</div>}
      <div className="task-list">
        {list.map((t) => <TaskCard key={t.id} task={t} manager={manager} employees={employees.data ?? []} onChanged={tasks.reload} />)}
      </div>
    </div>
  );
}

function NewTaskForm({ facility, employees, prefillAssignee, onDone, onCancel }: {
  facility: FacilityId; employees: Employee[]; prefillAssignee: number | null; onDone: () => void; onCancel: () => void;
}) {
  const notify = useApp((s) => s.notify);
  useApp((s) => s.tick);
  const w = getWorld();
  const trucks = Object.values(w.trucks).filter((t) => t.facilityId === facility);
  const docks = Object.values(w.docks).filter((d) => d.facilityId === facility);
  const [f, setF] = useState({ title: '', description: '', type: 'OTHER' as TaskType, priority: 'NORMAL' as Priority, assigneeId: prefillAssignee ? String(prefillAssignee) : '', truckId: '', dockId: '', dueMinutes: '60' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const staff = employees.filter((e) => e.status === 'ACTIVE' && e.facilityId === facility);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createTask({
        facilityId: facility, title: f.title, description: f.description, type: f.type, priority: f.priority,
        assigneeId: f.assigneeId ? Number(f.assigneeId) : null, truckId: f.truckId || null, dockId: f.dockId || null,
        dueMinutes: f.dueMinutes ? Number(f.dueMinutes) : null,
      });
      notify('Task created');
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="card form" onSubmit={submit}>
      <div className="form-title">New task · {FAC_NAMES[facility]}</div>
      <label className="fld"><span>Title</span><input value={f.title} onChange={set('title')} placeholder="What needs doing?" required minLength={3} maxLength={160} /></label>
      <label className="fld"><span>Details</span><textarea value={f.description} onChange={set('description')} rows={2} maxLength={1000} placeholder="Instructions, location, safety notes…" /></label>
      <div className="grid2">
        <label className="fld"><span>Type</span><select value={f.type} onChange={set('type')}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="fld"><span>Priority</span><select value={f.priority} onChange={set('priority')}>{(['LOW', 'NORMAL', 'HIGH', 'URGENT'] as Priority[]).map((p) => <option key={p} value={p}>{p[0] + p.slice(1).toLowerCase()}</option>)}</select></label>
        <label className="fld"><span>Assign to</span>
          <select value={f.assigneeId} onChange={set('assigneeId')}>
            <option value="">Unassigned (open)</option>
            {staff.map((e) => <option key={e.id} value={e.id}>{e.fullName} · {e.jobTitle}{e.openTasks ? ` (${e.openTasks} open)` : ''}</option>)}
          </select>
        </label>
        <label className="fld"><span>Due in</span>
          <select value={f.dueMinutes} onChange={set('dueMinutes')}>
            {[['15', '15 min'], ['30', '30 min'], ['60', '1 hour'], ['120', '2 hours'], ['240', '4 hours'], ['480', 'End of shift'], ['1440', 'Tomorrow']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="fld"><span>Truck (optional)</span>
          <select value={f.truckId} onChange={set('truckId')}><option value="">—</option>{trucks.map((t) => <option key={t.id} value={t.id}>{t.id} · {carrierName(t.carrier)}</option>)}</select>
        </label>
        <label className="fld"><span>Dock (optional)</span>
          <select value={f.dockId} onChange={set('dockId')}><option value="">—</option>{docks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        </label>
      </div>
      {error && <div className="err">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary sm" disabled={busy}>{busy ? 'Saving…' : 'Create task'}</button>
      </div>
    </form>
  );
}

function TaskCard({ task, manager, employees, onChanged }: { task: Task; manager: boolean; employees: Employee[]; onChanged: () => void }) {
  const user = useApp((s) => s.user)!;
  const notify = useApp((s) => s.notify);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<TaskUpdate[] | null>(null);
  const mine = task.assigneeId === user.employeeId;
  const allowed: TaskStatus[] = manager ? TASK_TRANSITIONS[task.status] : mine ? OPERATOR_TRANSITIONS[task.status] ?? [] : [];
  const overdue = task.dueAt && new Date(task.dueAt).getTime() < Date.now() && !['DONE', 'CANCELLED'].includes(task.status);

  const loadHistory = useCallback(() => { api.taskUpdates(task.id).then(setHistory).catch(() => setHistory([])); }, [task.id]);
  useEffect(() => { if (open) loadHistory(); }, [open, task.status, task.lastNote, loadHistory]);

  const change = async (status: TaskStatus) => {
    if (status === 'BLOCKED' && !note.trim()) { notify('Add a note saying what is blocking the task', 'error'); setOpen(true); return; }
    setBusy(true);
    try {
      await api.taskStatus(task.id, status, note.trim() || undefined);
      setNote('');
      notify(`Task ${STATUS_LABEL[status].toLowerCase()}`);
      onChanged();
    } catch (e) { notify((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const reassign = async (id: string) => {
    if (!id) return;
    setBusy(true);
    try { await api.assignTask(task.id, Number(id), note.trim() || undefined); setNote(''); notify('Task reassigned'); onChanged(); }
    catch (e) { notify((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const ACTION: Partial<Record<TaskStatus, { label: string; icon: JSX.Element; cls: string }>> = {
    IN_PROGRESS: { label: task.status === 'BLOCKED' ? 'Resume' : 'Start', icon: <Play size={13} />, cls: 'btn-primary sm' },
    DONE: { label: 'Complete', icon: <CheckCircle2 size={13} />, cls: 'btn-primary sm green' },
    BLOCKED: { label: 'Report blocked', icon: <Pause size={13} />, cls: 'btn-ghost sm' },
    CANCELLED: { label: 'Cancel task', icon: <Ban size={13} />, cls: 'btn-ghost sm danger' },
  };
  const link: EntityRef | null = task.forkliftId ? { kind: 'forklift', id: task.forkliftId } : task.truckId ? { kind: 'truck', id: task.truckId } : task.dockId ? { kind: 'dock', id: task.dockId } : null;

  return (
    <div className={`card task ${open ? 'open' : ''} ${task.status === 'DONE' || task.status === 'CANCELLED' ? 'closed' : ''}`}>
      <button className="task-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`prio prio-${PRIORITY_TONE[task.priority]}`} title={`${task.priority} priority`} />
        <span className="task-main">
          <span className="task-title">{task.title}</span>
          <span className="task-meta">
            {TYPE_LABEL[task.type]} · {task.assigneeName ?? 'Unassigned'}
            {task.source === 'SYSTEM' && <span className="auto">auto</span>}
            {task.dueAt && <span className={overdue ? 'overdue' : ''}> · due {when(task.dueAt)}</span>}
          </span>
          {task.lastNote && !open && !AUTO_NOTES.has(task.lastNote) && <span className="task-note">“{task.lastNote}”</span>}
        </span>
        <Pill tone={STATUS_TONE[task.status]}>{STATUS_LABEL[task.status]}</Pill>
        {open ? <ChevronDown size={15} className="muted" /> : <ChevronRight size={15} className="muted" />}
      </button>
      {open && (
        <div className="task-detail">
          {task.description && <p className="task-desc">{task.description}</p>}
          <div className="task-facts">
            <span><UserRound size={12} /> Created by {task.createdByName} · {when(task.createdAt)}</span>
            {task.startedAt && <span><Clock3 size={12} /> Started {when(task.startedAt)}</span>}
            {task.completedAt && <span><CheckCircle2 size={12} /> Closed {when(task.completedAt)}</span>}
            {link && <button className="link" onClick={() => locate(link)}><Crosshair size={12} /> Show {link.id} in 3D</button>}
          </div>
          {(allowed.length > 0 || manager) && !['DONE', 'CANCELLED'].includes(task.status) && (
            <>
              <input className="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={allowed.includes('BLOCKED') ? 'Add a note (required when blocked)…' : 'Add a note (optional)…'} maxLength={1000} />
              <div className="task-actions">
                {allowed.filter((s) => s !== 'ASSIGNED').map((s) => {
                  const a = ACTION[s];
                  return a ? <button key={s} className={a.cls} disabled={busy} onClick={() => change(s)}>{a.icon}{a.label}</button> : null;
                })}
                {manager && (
                  <select className="sel" value="" disabled={busy} onChange={(e) => reassign(e.target.value)} aria-label="Reassign">
                    <option value="">{task.assigneeId ? 'Reassign to…' : 'Assign to…'}</option>
                    {employees.filter((e) => e.status === 'ACTIVE' && e.facilityId === task.facilityId && e.id !== task.assigneeId)
                      .map((e) => <option key={e.id} value={e.id}>{e.fullName} · {e.jobTitle}</option>)}
                  </select>
                )}
              </div>
            </>
          )}
          <div className="hist">
            <div className="hist-head">History</div>
            {!history && <div className="muted small">Loading…</div>}
            {history?.map((h) => (
              <div key={h.id} className="hist-row">
                <span className="hist-dot" />
                <span className="hist-text">
                  <b>{h.userName}</b> {h.oldStatus ? <>moved it {STATUS_LABEL[h.oldStatus]} → <b>{STATUS_LABEL[h.newStatus]}</b></> : <>created it as <b>{STATUS_LABEL[h.newStatus]}</b></>}
                  {h.note && <span className="hist-note">“{h.note}”</span>}
                </span>
                <span className="muted small">{when(h.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- activity (audit trail)

function ActivityTab() {
  const user = useApp((s) => s.user)!;
  const version = useApp((s) => s.versions.audit);
  useApp((s) => s.tick);
  const admin = user.permissions.includes('VIEW_ALL_FACILITIES');
  const current = useApp((s) => s.facilityId);
  const [facility, setFacility] = useState<FacilityId | 'ALL'>(admin ? 'ALL' : current);
  const [view, setView] = useState<'audit' | 'floor'>('audit');
  const [older, setOlder] = useState<AuditEntry[]>([]);
  const audit = useLoader(() => api.audit({ facility: facility === 'ALL' ? undefined : facility, limit: 60 }), [facility, version]);
  useEffect(() => setOlder([]), [facility]);
  const rows = [...(audit.data ?? []), ...older];
  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    const more = await api.audit({ facility: facility === 'ALL' ? undefined : facility, before: last.id, limit: 60 });
    setOlder((o) => [...o, ...more]);
  };
  const floor = getWorld().events.filter((e) => facility === 'ALL' || e.facilityId === facility);
  return (
    <div className="tab">
      <div className="toolbar">
        <FacilitySelect value={facility} onChange={setFacility} allowAll={admin} />
        <div className="seg">
          <button className={view === 'audit' ? 'on' : ''} onClick={() => setView('audit')}>Changes by people</button>
          <button className={view === 'floor' ? 'on' : ''} onClick={() => setView('floor')}>Floor events</button>
        </div>
      </div>
      <p className="muted small hint">
        {view === 'audit'
          ? `Every sign-in, task change and account change, recorded by database triggers in AUDIT_LOG${admin ? ' — all sites' : ' — your sites'}.`
          : 'Live operations events (trucks, docks, deliveries) stored in OPERATION_EVENTS.'}
      </p>
      {view === 'audit' && (
        <>
          {audit.error && <div className="err">{audit.error}</div>}
          <div className="audit">
            {rows.map((a) => (
              <div key={a.id} className="audit-row">
                <span className={`audit-ico a-${a.action.split('_')[0].toLowerCase()}`}>{a.action.startsWith('LOGIN_FAILED') ? <AlertTriangle size={13} /> : a.action.startsWith('USER') || a.action.startsWith('ACCESS') ? <ShieldCheck size={13} /> : a.action.startsWith('TASK') ? <ClipboardList size={13} /> : a.action.startsWith('OPS') ? <Clock3 size={13} /> : <KeyRound size={13} />}</span>
                <span className="audit-main">
                  <span><b>{a.username ?? 'System'}</b> · {ACTION_LABEL[a.action] ?? a.action}{a.facilityId && <span className="fac-chip">{a.facilityId}</span>}</span>
                  {a.details && a.details !== ACTION_LABEL[a.action] && <span className="audit-details">{a.details}</span>}
                </span>
                <span className="muted small" title={new Date(a.at).toLocaleString()}>{when(a.at)}</span>
              </div>
            ))}
          </div>
          {rows.length >= 60 && <button className="btn-ghost sm more" onClick={loadMore}>Load older</button>}
        </>
      )}
      {view === 'floor' && (
        <div className="audit">
          {floor.map((e, i) => (
            <button key={i} className="audit-row as-btn" onClick={() => e.ref && locate(e.ref)}>
              <span className="audit-ico a-ops"><TruckIcon size={13} /></span>
              <span className="audit-main"><span>{e.text}</span><span className="audit-details">{FAC_NAMES[e.facilityId]}</span></span>
              <span className="muted small">{fmtClock(e.t)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- team

function TeamTab({ onAssign }: { onAssign: (employeeId: number) => void }) {
  const user = useApp((s) => s.user)!;
  const current = useApp((s) => s.facilityId);
  const version = useApp((s) => s.versions.tasks);
  const [facility, setFacility] = useState<FacilityId>(current);
  const team = useLoader(() => api.employees(facility), [facility, version]);
  const canAssign = user.permissions.includes('MANAGE_TASKS');
  const byJob = useMemo(() => {
    const g = new Map<string, Employee[]>();
    for (const e of team.data ?? []) g.set(e.jobTitle, [...(g.get(e.jobTitle) ?? []), e]);
    return [...g.entries()];
  }, [team.data]);
  return (
    <div className="tab">
      <div className="toolbar"><FacilitySelect value={facility} onChange={(f) => setFacility(f as FacilityId)} /></div>
      {team.error && <div className="err">{team.error}</div>}
      {byJob.map(([job, people]) => (
        <div key={job} className="team-group">
          <div className="sec-head"><span>{job}</span><span className="muted">{people.length}</span></div>
          {people.map((e) => (
            <div key={e.id} className="team-row">
              <span className="avatar-sm">{e.fullName.split(' ').map((p) => p[0]).join('').slice(0, 2)}</span>
              <span className="team-main">
                <b>{e.fullName}</b>
                <span className="muted small">{e.username ? `@${e.username} · ${e.role?.toLowerCase()}` : 'no login'}{e.forkliftId ? ` · drives ${e.forkliftId}` : ''}</span>
              </span>
              <Pill tone={e.openTasks ? 'blue' : 'grey'}>{e.openTasks} open</Pill>
              {e.forkliftId && <button className="sq" title={`Show ${e.forkliftId}`} aria-label={`Show ${e.forkliftId}`} onClick={() => locate({ kind: 'forklift', id: e.forkliftId! })}><Crosshair size={13} /></button>}
              {canAssign && <button className="btn-ghost sm" onClick={() => onAssign(e.id)}>Assign task</button>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- reports

function ReportsTab() {
  const db = useApp((s) => s.db);
  const version = useApp((s) => s.versions.tasks);
  const [n, setN] = useState(0);
  const kpi = useLoader<KpiRow[]>(() => api.kpis(), [version, n]);
  const low = useLoader<LowStockRow[]>(() => api.lowStock(), [version, n]);
  const work = useLoader<WorkloadRow[]>(() => api.workload(), [version, n]);
  return (
    <div className="tab">
      <div className="toolbar">
        <span className="muted small">{db === 'oracle' ? 'Queried live from Oracle views' : 'Computed by the development store'}</span>
        <button className="sq" title="Refresh" aria-label="Refresh" onClick={() => setN((x) => x + 1)}><RefreshCw size={14} /></button>
      </div>
      <div className="rep-title">Site KPIs</div>
      <table className="tbl">
        <thead><tr><th>Site</th><th>Stock</th><th>Fill</th><th>On site</th><th>On-time</th><th>Open tasks</th></tr></thead>
        <tbody>
          {(kpi.data ?? []).map((k) => (
            <tr key={k.facilityId}>
              <td><b>{k.facilityId}</b> <span className="muted">{k.name}</span></td>
              <td>{k.stock.toLocaleString()}</td><td>{k.fillPct}%</td><td>{k.trucksOnSite}</td>
              <td>{k.otdPct.toFixed(1)}% <span className="muted small">({k.deliveries30d})</span></td><td>{k.openTasks}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rep-title">Below reorder level</div>
      {!low.data?.length && <div className="empty small">Nothing below reorder level.</div>}
      {!!low.data?.length && (
        <table className="tbl">
          <thead><tr><th>Site</th><th>Product</th><th>Units</th><th>Reorder at</th></tr></thead>
          <tbody>{low.data.map((r) => <tr key={r.facilityId + r.skuId}><td>{r.facilityId}</td><td>{r.skuName}</td><td className="warn">{r.units.toLocaleString()}</td><td>{r.reorderLevel.toLocaleString()}</td></tr>)}</tbody>
        </table>
      )}
      <div className="rep-title">Workload</div>
      <table className="tbl">
        <thead><tr><th>Employee</th><th>Job</th><th>Open</th><th>Working</th><th>Done today</th></tr></thead>
        <tbody>{(work.data ?? []).map((r) => <tr key={r.employeeId}><td>{r.fullName} <span className="muted small">{r.facilityId}</span></td><td>{r.jobTitle}</td><td>{r.open}</td><td>{r.inProgress}</td><td>{r.doneToday}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- users (administrators)

function UsersTab() {
  const me = useApp((s) => s.user)!;
  const notify = useApp((s) => s.notify);
  const users = useLoader<UserRecord[]>(() => api.users(), []);
  const meta = useLoader<{ roles: RoleInfo[]; jobTitles: JobTitle[] }>(() => api.meta(), []);
  const [creating, setCreating] = useState(false);
  const update = async (u: UserRecord, patch: Parameters<typeof api.updateUser>[1], msg: string) => {
    try { await api.updateUser(u.id, patch); notify(msg); users.reload(); } catch (e) { notify((e as Error).message, 'error'); }
  };
  return (
    <div className="tab">
      <div className="toolbar">
        <span className="muted small">{users.data?.length ?? 0} accounts</span>
        <button className="btn-primary sm" onClick={() => setCreating((c) => !c)}><Plus size={14} /> New user</button>
      </div>
      {creating && meta.data && <NewUserForm meta={meta.data} onDone={() => { setCreating(false); users.reload(); }} onCancel={() => setCreating(false)} />}
      {meta.data && (
        <details className="roles-help">
          <summary>What each role can do</summary>
          {meta.data.roles.map((r) => (
            <div key={r.code} className="role-help"><b>{r.name}</b> — {r.description}<div className="perm-list">{r.permissions.map((p) => <code key={p}>{p}</code>)}</div></div>
          ))}
        </details>
      )}
      {users.error && <div className="err">{users.error}</div>}
      <div className="users">
        {(users.data ?? []).map((u) => (
          <UserRow key={u.id} u={u} self={u.id === me.userId} onUpdate={update} />
        ))}
      </div>
    </div>
  );
}

function UserRow({ u, self, onUpdate }: { u: UserRecord; self: boolean; onUpdate: (u: UserRecord, p: Parameters<typeof api.updateUser>[1], msg: string) => void }) {
  const [pw, setPw] = useState('');
  const [resetting, setResetting] = useState(false);
  const facilities: FacilityId[] = ['WH-01', 'WH-02', 'WH-04'];
  return (
    <div className={`card user ${u.active ? '' : 'inactive'}`}>
      <div className="user-top">
        <span className="avatar-sm">{u.fullName.split(' ').map((p) => p[0]).join('').slice(0, 2)}</span>
        <span className="team-main"><b>{u.fullName}{self && ' (you)'}</b><span className="muted small">@{u.username} · {u.jobTitle} · last sign-in {when(u.lastLoginAt)}</span></span>
        <select className="sel" value={u.role} disabled={self} onChange={(e) => onUpdate(u, { role: e.target.value as Role }, `${u.username} is now ${e.target.value.toLowerCase()}`)} aria-label="Role">
          <option value="ADMIN">Administrator</option><option value="MANAGER">Manager</option><option value="OPERATOR">Operator</option>
        </select>
      </div>
      <div className="user-bottom">
        <span className="muted small">Sites:</span>
        {facilities.map((f) => (
          <label key={f} className="chk sm">
            <input type="checkbox" checked={u.role === 'ADMIN' || u.facilities.includes(f)} disabled={u.role === 'ADMIN'}
              onChange={(e) => onUpdate(u, { facilities: e.target.checked ? [...u.facilities, f] : u.facilities.filter((x) => x !== f) }, `Updated ${u.username}'s site access`)} />
            <span>{f}</span>
          </label>
        ))}
        <span className="spacer" />
        {resetting ? (
          <span className="pw-reset">
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password" aria-label="New password" />
            <button className="btn-primary sm" onClick={() => { onUpdate(u, { password: pw }, `Password reset for ${u.username}`); setPw(''); setResetting(false); }}>Save</button>
            <button className="btn-ghost sm" onClick={() => setResetting(false)}>Cancel</button>
          </span>
        ) : (
          <button className="btn-ghost sm" onClick={() => setResetting(true)}><KeyRound size={13} /> Reset password</button>
        )}
        <button className={`btn-ghost sm ${u.active ? 'danger' : ''}`} disabled={self} onClick={() => onUpdate(u, { active: !u.active }, `${u.username} ${u.active ? 'deactivated' : 'activated'}`)}>
          {u.active ? 'Deactivate' : 'Activate'}
        </button>
      </div>
    </div>
  );
}

function NewUserForm({ meta, onDone, onCancel }: { meta: { roles: RoleInfo[]; jobTitles: JobTitle[] }; onDone: () => void; onCancel: () => void }) {
  const notify = useApp((s) => s.notify);
  const [f, setF] = useState({ fullName: '', username: '', email: '', phone: '', password: '', role: 'OPERATOR' as Role, jobCode: 'FORKLIFT_OPERATOR', homeFacility: 'WH-01' as FacilityId, facilities: ['WH-01'] as FacilityId[] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.createUser({ ...f, phone: f.phone || undefined, facilities: f.role === 'ADMIN' ? [] : f.facilities });
      notify(`Created ${f.username}`);
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <form className="card form" onSubmit={submit}>
      <div className="form-title">New user account</div>
      <div className="grid2">
        <label className="fld"><span>Full name</span><input value={f.fullName} onChange={set('fullName')} required /></label>
        <label className="fld"><span>Username</span><input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} required placeholder="first.last" /></label>
        <label className="fld"><span>Email</span><input type="email" value={f.email} onChange={set('email')} required /></label>
        <label className="fld"><span>Phone</span><input value={f.phone} onChange={set('phone')} /></label>
        <label className="fld"><span>Role (access rights)</span>
          <select value={f.role} onChange={set('role')}>{meta.roles.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select>
        </label>
        <label className="fld"><span>Job title</span>
          <select value={f.jobCode} onChange={set('jobCode')}>{meta.jobTitles.map((j) => <option key={j.code} value={j.code}>{j.title}</option>)}</select>
        </label>
        <label className="fld"><span>Home site</span>
          <select value={f.homeFacility} onChange={(e) => setF({ ...f, homeFacility: e.target.value as FacilityId, facilities: Array.from(new Set([...f.facilities, e.target.value as FacilityId])) })}>
            {(['WH-01', 'WH-02', 'WH-04'] as FacilityId[]).map((x) => <option key={x} value={x}>{x} · {FAC_NAMES[x]}</option>)}
          </select>
        </label>
        <label className="fld"><span>Temporary password</span><input type="password" value={f.password} onChange={set('password')} required minLength={8} placeholder="8+ chars, letters & digits" /></label>
      </div>
      {f.role !== 'ADMIN' && (
        <div className="chk-row">
          <span className="muted small">Site access:</span>
          {(['WH-01', 'WH-02', 'WH-04'] as FacilityId[]).map((x) => (
            <label key={x} className="chk sm"><input type="checkbox" checked={f.facilities.includes(x)} onChange={(e) => setF({ ...f, facilities: e.target.checked ? [...f.facilities, x] : f.facilities.filter((y) => y !== x) })} /><span>{x}</span></label>
          ))}
        </div>
      )}
      <p className="muted small">{meta.jobTitles.find((j) => j.code === f.jobCode)?.responsibilities}</p>
      {error && <div className="err">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary sm" disabled={busy}>{busy ? 'Creating…' : 'Create user'}</button>
      </div>
    </form>
  );
}

export function Toast() {
  const toast = useApp((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || !visible) return null;
  return <div className={`toast ${toast.tone}`} role="status">{toast.text}</div>;
}
