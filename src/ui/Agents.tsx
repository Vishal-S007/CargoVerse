// AI agents in the Work panel: the exception watcher (Alerts) and the operations assistant (chat).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Sparkles, Send, Database, ShieldCheck, Crosshair, ClipboardPlus, AlertTriangle, BatteryLow, Clock3, PackageX, Ban, Wrench } from 'lucide-react';
import type { FacilityId, EntityRef } from '../data/types';
import { api, type Alert } from '../api/client';
import type { AssistantAction, AssistantQuery, AssistantStatus } from '../api/types';
import { showXray } from './Wms';
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

interface Msg { role: 'user' | 'assistant'; content: string; tools?: string[]; queries?: AssistantQuery[]; mode?: 'claude' | 'demo'; error?: boolean }

const TOOL_LABEL: Record<string, string> = {
  get_site_overview: 'site KPIs', list_trucks: 'trucks', get_truck: 'truck details', list_forklifts: 'forklifts', list_alerts: 'alerts',
  list_tasks: 'tasks', list_team: 'team', get_imports_exports: 'imports/exports', list_park_tenants: 'park tenants', search: 'search',
  create_task: 'created a task', show_in_3d: 'showed it in 3D', get_port_status: 'port', trace_container: 'container history', get_store_stock: 'stores',
  warehouse_lots: 'lots & FEFO', trace: 'recall trace', cold_chain_status: 'cold chain', reorder_suggestions: 'reorder points', demand_forecast: 'forecast',
  slotting_report: 'ABC slotting', pick_route: 'pick route', scan_label: 'GS1 scan', search_damage_reports: 'vector search', show_warehouse_xray: 'X-ray',
  recall_lot: 'recalled a lot', describe_tables: 'table columns', query_database: 'Oracle SQL',
  locate: 'map', inspect: 'details', project_docs: 'project docs',
};

/** Tiny formatter for assistant replies: paragraphs, "- " bullets, numbered lists, **bold** and `code`. */
function Rich({ text }: { text: string }) {
  const inline = (s: string, key: string) => s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <b key={`${key}-${i}`}>{part.slice(2, -2)}</b>
      : part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={`${key}-${i}`}>{part.slice(1, -1)}</code>
        : <span key={`${key}-${i}`}>{part}</span>);
  const blocks: JSX.Element[] = [];
  let list: string[] = [];
  let ordered = false;
  const flush = () => {
    if (!list.length) return;
    const items = list.map((l, i) => <li key={i}>{inline(l, `li${blocks.length}-${i}`)}</li>);
    blocks.push(ordered ? <ol key={`l${blocks.length}`}>{items}</ol> : <ul key={`l${blocks.length}`}>{items}</ul>);
    list = [];
  };
  text.split('\n').forEach((line, i) => {
    const m = /^\s*([-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (m) {
      const isNum = /\d/.test(m[1]);
      if (list.length && isNum !== ordered) flush();
      ordered = isNum;
      list.push(m[2]);
      return;
    }
    flush();
    if (line.trim()) blocks.push(<p key={`p${i}`}>{inline(line.replace(/^#+\s*/, ''), `p${i}`)}</p>);
  });
  flush();
  return <>{blocks}</>;
}

/** A database query the assistant ran: which account, which row filter, the SQL and the first rows. */
function QueryCard({ q }: { q: AssistantQuery }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`ai-query ${q.error ? 'bad' : ''}`}>
      <div className="ai-query-head">
        <Database size={13} />
        <b>{q.purpose || 'Database query'}</b>
        {q.error ? <span className="err small">{q.error}</span>
          : <span className="muted small">{q.rowCount}{q.truncated ? '+' : ''} row{q.rowCount === 1 ? '' : 's'} · {q.ms} ms</span>}
      </div>
      {q.account && (
        <div className="ai-query-sec small">
          <ShieldCheck size={12} /> ran as <code>{q.account}</code>
          {q.filter ? <> · Oracle added <code>WHERE {q.filter}</code></> : <> · no row filter (all sites)</>}
        </div>
      )}
      <button className="link small" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} the SQL{q.rows.length ? ' and rows' : ''}</button>
      {open && (
        <>
          <pre className="ai-sql">{q.sql}</pre>
          {q.columns.length > 0 && (
            <div className="ai-rows">
              <table>
                <thead><tr>{q.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{q.rows.slice(0, 12).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c === null || c === undefined ? '—' : String(c)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function runAction(a: AssistantAction) {
  if (a.type === 'focus') goTo(a.ref);
  else if (a.type === 'xray') {
    const patch: Parameters<typeof showXray>[1] = { highlight: a.highlight ?? [] };
    if (a.mode) patch.mode = a.mode;
    if (a.route !== undefined) patch.route = a.route;
    showXray(a.facility, patch);
  }
}

export function AssistantTab() {
  const user = useApp((s) => s.user)!;
  const facility = useApp((s) => s.facilityId);
  const storeKey = `waretrack.chat.${user.userId}`;
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try { return JSON.parse(sessionStorage.getItem(storeKey) ?? '[]') as Msg[]; } catch { return []; }
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [hideNote, setHideNote] = useState(() => { try { return localStorage.getItem('cargoverse.ai.demoNote') === 'hidden'; } catch { return false; } });
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { api.assistantStatus().then(setStatus).catch(() => setStatus({ configured: false, mode: 'demo', model: '', oracle: false })); }, []);
  useEffect(() => {
    try { sessionStorage.setItem(storeKey, JSON.stringify(msgs.slice(-30))); } catch { /* ignore */ }
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgs, storeKey]);

  const manager = user.permissions.includes('MANAGE_TASKS');
  const reports = user.permissions.includes('VIEW_REPORTS');
  const suggestions = [
    ...(manager ? ['What needs attention right now?', 'Is the cold chain OK?', 'What should we reorder?'] : ['What should I work on next?', 'Is the cold chain OK?']),
    'Which lots expire soon?',
    ...(reports ? ['Trace a lot to the stores', 'Show ABC slotting'] : []),
    'Shortest pick route',
    'Where is the red bus?',
    'How does FEFO work?',
    ...(reports && status?.oracle ? ['Top products by demand (SQL)'] : []),
  ];
  const demo = status?.mode === 'demo';

  const ask = async (text: string, e?: FormEvent) => {
    e?.preventDefault();
    let q = text.trim();
    if (!q || busy) return;
    if (q === 'Trace a lot to the stores') {
      try { const l = await api.wmsLots(); q = `Trace ${[...l.lots].sort((a, b) => (b.unitsReceived - b.units) - (a.unitsReceived - a.units))[0]?.lotId ?? 'LOT-10001'}`; } catch { q = 'Trace LOT-10001'; }
    }
    if (q === 'Top products by demand (SQL)') q = 'Top products by demand';
    const next: Msg[] = [...msgs, { role: 'user', content: q }];
    setMsgs(next);
    setInput('');
    setBusy(true);
    try {
      const history = next.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
      const r = await api.assistant(history, facility, useApp.getState().selection);
      setMsgs([...next, { role: 'assistant', content: r.reply, tools: r.tools, queries: r.queries, mode: r.mode }]);
      for (const a of r.actions) runAction(a);
    } catch (err) {
      setMsgs([...next, { role: 'assistant', content: (err as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tab chat">
      {demo && !hideNote && (
        <div className="setup-note demo-note">
          <b><Sparkles size={13} /> Demo mode</b>
          <span>No Anthropic API key is set, so the assistant answers common questions with built-in rules — it still reads the live data{status?.oracle ? ' and runs real Oracle queries' : ''}. For free-form questions (Claude writes its own SQL), add to <code>.env</code> and restart:</span>
          <code className="block">ANTHROPIC_API_KEY=sk-ant-…</code>
          <button className="link small" onClick={() => { setHideNote(true); try { localStorage.setItem('cargoverse.ai.demoNote', 'hidden'); } catch { /* ignore */ } }}>Hide this note</button>
        </div>
      )}
      <div className="chat-log">
        {!msgs.length && (
          <div className="chat-empty">
            <Sparkles size={22} className="blue" />
            <b>Ask about live operations{status ? '' : ''} at {FAC[facility]}</b>
            <span className="muted small">
              Answers come from the same live data as the dashboard, limited to what your role can see.
              {reports && status?.oracle ? ' Database questions run in Oracle as your own account, so row-level security applies.' : ''}
              {' Ask about anything on the map (click it and ask "what is this?") or how the project works.'}
              {manager ? ' It can also create tasks or recall a lot when you ask it to.' : ''}
            </span>
            <div className="chips">{suggestions.map((s) => <button key={s} className="chip-btn" onClick={() => ask(s)}>{s}</button>)}</div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role} ${m.error ? 'error' : ''}`}>
            {m.role === 'assistant' ? <Rich text={m.content} /> : m.content}
            {m.queries?.map((q, j) => <QueryCard key={j} q={q} />)}
            {m.tools && m.tools.length > 0 && (
              <span className="msg-tools">
                {m.mode === 'demo' ? 'demo · ' : ''}checked: {Array.from(new Set(m.tools)).map((t) => TOOL_LABEL[t] ?? t).join(' · ')}
              </span>
            )}
          </div>
        ))}
        {busy && <div className="msg assistant thinking"><span className="dots"><i /><i /><i /></span> Checking live operations…</div>}
        <div ref={endRef} />
      </div>
      <form className="chat-input" onSubmit={(e) => ask(input, e)}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={demo ? 'Ask about lots, cold chain, reorders, trucks…' : 'Ask anything about operations or the data…'} maxLength={1000} aria-label="Ask the assistant" />
        <button className="btn-primary sm" type="submit" disabled={busy || !input.trim()} aria-label="Send"><Send size={14} /></button>
      </form>
      {msgs.length > 0 && <button className="link small clear-chat" onClick={() => setMsgs([])}>Clear conversation</button>}
    </div>
  );
}
