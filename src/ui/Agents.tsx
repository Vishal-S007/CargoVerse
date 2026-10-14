// AI agents in the Work panel: the exception watcher (Alerts) and the operations assistant (chat).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Sparkles, Send, Crosshair, ClipboardPlus, AlertTriangle, BatteryLow, Clock3, PackageX, Ban, Wrench } from 'lucide-react';
import type { FacilityId, EntityRef } from '../data/types';
import { api, type Alert } from '../api/client';
import { useApp } from '../store';

const FAC: Record<FacilityId, string> = { 'WH-01': 'Riverside Hub', 'WH-02': 'Northgate DC', 'WH-04': 'Southfield Cross-Dock' };

function goTo(ref: EntityRef) {
  const s = useApp.getState();
  s.select(ref);
  setTimeout(() => s.camera(ref.kind === 'facility' ? { kind: 'home' } : { kind: 'focus', ref }), 30);
}

const KIND_ICON: Record<Alert['kind'], JSX.Element> = {
  late_shipment: <Clock3 size={14} />, low_battery: <BatteryLow size={14} />, gate_wait: <AlertTriangle size={14} />,
  low_stock: <PackageX size={14} />, blocked_task: <Ban size={14} />,
};

// ---------------------------------------------------------------- exception watcher

export function AlertsTab() {
  const user = useApp((s) => s.user)!;
  const notify = useApp((s) => s.notify);
  const version = useApp((s) => s.versions.tasks);
  const [facility, setFacility] = useState<FacilityId | 'ALL'>('ALL');
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const canAssign = user.permissions.includes('MANAGE_TASKS');
  useEffect(() => {
    let alive = true;
    const load = () => api.alerts(facility === 'ALL' ? undefined : facility)
      .then((a) => { if (alive) { setAlerts(a); setError(null); } })
      .catch((e) => { if (alive) setError((e as Error).message); });
    load();
    const t = window.setInterval(load, 5000); // operations change continuously; re-scan every few seconds
    return () => { alive = false; window.clearInterval(t); };
  }, [facility, version]);
  const raise = async (a: Alert) => {
    setBusy(a.id);
    try {
      const t = await api.alertTask(a.id);
      notify(`Task created${t.assigneeName ? ` and assigned to ${t.assigneeName}` : ''}`);
    } catch (e) { notify((e as Error).message, 'error'); } finally { setBusy(null); }
  };
  const counts = { high: 0, medium: 0, low: 0 };
  for (const a of alerts ?? []) counts[a.severity]++;
  return (
    <div className="tab">
      <div className="toolbar">
        <select className="sel" value={facility} onChange={(e) => setFacility(e.target.value as FacilityId | 'ALL')} aria-label="Site">
          <option value="ALL">All my sites</option>
          {user.facilities.map((f) => <option key={f} value={f}>{f} · {FAC[f]}</option>)}
        </select>
        <span className="summary"><span className="sev sev-high">{counts.high} high</span><span className="sev sev-medium">{counts.medium} medium</span><span className="sev sev-low">{counts.low} low</span></span>
      </div>
      <p className="muted small hint">The exception watcher checks live operations every few seconds for late shipments, forklifts low on battery mid-job, trucks stuck at the gate, low stock and blocked tasks.</p>
      {error && <div className="err">{error}</div>}
      {alerts && !alerts.length && <div className="empty">All clear — nothing needs attention right now.</div>}
      <div className="alert-list">
        {(alerts ?? []).map((a) => (
          <div key={a.id} className={`card alert sev-${a.severity}`}>
            <span className={`alert-ico sev-${a.severity}`}>{KIND_ICON[a.kind]}</span>
            <div className="alert-main">
              <b>{a.title}</b>
              <span className="muted small">{a.detail}</span>
              <span className="alert-meta"><span className="fac-chip">{a.facilityId}</span>{a.suggestion && <span className="muted small"><Wrench size={11} /> Suggested: {a.suggestion.title}</span>}</span>
              <div className="alert-actions">
                {a.ref && <button className="btn-ghost sm" onClick={() => goTo(a.ref!)}><Crosshair size={13} /> Show</button>}
                {a.suggestion && canAssign && (
                  <button className="btn-primary sm" disabled={busy === a.id} onClick={() => raise(a)}><ClipboardPlus size={13} /> {busy === a.id ? 'Creating…' : 'Create task'}</button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- operations assistant

interface Msg { role: 'user' | 'assistant'; content: string; tools?: string[]; error?: boolean }

const TOOL_LABEL: Record<string, string> = {
  get_site_overview: 'site KPIs', list_trucks: 'trucks', get_truck: 'truck details', list_forklifts: 'forklifts', list_alerts: 'alerts',
  list_tasks: 'tasks', list_team: 'team', get_imports_exports: 'imports/exports', list_park_tenants: 'park tenants', search: 'search', create_task: 'created a task', show_in_3d: 'showed it in 3D',
};

/** Tiny formatter for assistant replies: paragraphs, "- " bullets and **bold**. */
function Rich({ text }: { text: string }) {
  const bold = (s: string, key: string) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <b key={`${key}-${i}`}>{part.slice(2, -2)}</b> : <span key={`${key}-${i}`}>{part}</span>);
  const blocks: JSX.Element[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { const items = list; blocks.push(<ul key={`ul${blocks.length}`}>{items.map((l, i) => <li key={i}>{bold(l, `li${i}`)}</li>)}</ul>); list = []; } };
  text.split('\n').forEach((line, i) => {
    const m = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (m) { list.push(m[1]); return; }
    flush();
    if (line.trim()) blocks.push(<p key={`p${i}`}>{bold(line.replace(/^#+\s*/, ''), `p${i}`)}</p>);
  });
  flush();
  return <>{blocks}</>;
}

export function AssistantTab() {
  const user = useApp((s) => s.user)!;
  const facility = useApp((s) => s.facilityId);
  const storeKey = `waretrack.chat.${user.userId}`;
  const [status, setStatus] = useState<{ configured: boolean; model: string } | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try { return JSON.parse(sessionStorage.getItem(storeKey) ?? '[]') as Msg[]; } catch { return []; }
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { api.assistantStatus().then(setStatus).catch(() => setStatus({ configured: false, model: '' })); }, []);
  useEffect(() => {
    try { sessionStorage.setItem(storeKey, JSON.stringify(msgs.slice(-30))); } catch { /* ignore */ }
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgs, storeKey]);

  const manager = user.permissions.includes('MANAGE_TASKS');
  const suggestions = manager
    ? ['How is this site doing right now?', 'Which shipments are at risk of being late?', 'How many imports and exports today?', 'Who on the team has the most open work?']
    : ['What should I work on next?', 'Where is my forklift and how is its battery?', 'Which trucks are arriving soon?'];

  const ask = async (text: string, e?: FormEvent) => {
    e?.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    const next: Msg[] = [...msgs, { role: 'user', content: q }];
    setMsgs(next);
    setInput('');
    setBusy(true);
    try {
      const history = next.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
      const r = await api.assistant(history, facility);
      setMsgs([...next, { role: 'assistant', content: r.reply, tools: r.tools }]);
      for (const a of r.actions) if (a.type === 'focus') goTo(a.ref);
    } catch (err) {
      setMsgs([...next, { role: 'assistant', content: (err as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tab chat">
      {status && !status.configured && (
        <div className="setup-note">
          <b>Connect the assistant</b>
          <span>The assistant uses Claude through the Anthropic API. Add your key to the <code>.env</code> file in the project folder and restart the server:</span>
          <code className="block">ANTHROPIC_API_KEY=sk-ant-…</code>
          <span className="muted small">The key stays on the server — it is never sent to the browser. The exception watcher in the Alerts tab works without a key.</span>
        </div>
      )}
      <div className="chat-log">
        {!msgs.length && (
          <div className="chat-empty">
            <Sparkles size={22} className="blue" />
            <b>Ask about live operations at {FAC[facility]}</b>
            <span className="muted small">Answers come from the same live data as the dashboard, limited to what your role can see.{manager ? ' It can also create tasks when you ask it to.' : ''}</span>
            <div className="chips">{suggestions.map((s) => <button key={s} className="chip-btn" onClick={() => ask(s)}>{s}</button>)}</div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role} ${m.error ? 'error' : ''}`}>
            {m.role === 'assistant' ? <Rich text={m.content} /> : m.content}
            {m.tools && m.tools.length > 0 && (
              <span className="msg-tools">checked: {Array.from(new Set(m.tools)).map((t) => TOOL_LABEL[t] ?? t).join(' · ')}</span>
            )}
          </div>
        ))}
        {busy && <div className="msg assistant thinking"><span className="dots"><i /><i /><i /></span> Checking live operations…</div>}
        <div ref={endRef} />
      </div>
      <form className="chat-input" onSubmit={(e) => ask(input, e)}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about trucks, docks, stock, tasks…" maxLength={1000} aria-label="Ask the assistant" />
        <button className="btn-primary sm" type="submit" disabled={busy || !input.trim()} aria-label="Send"><Send size={14} /></button>
      </form>
      {msgs.length > 0 && <button className="link small clear-chat" onClick={() => setMsgs([])}>Clear conversation</button>}
    </div>
  );
}
