import { useEffect, useState, type FormEvent } from 'react';
import { ShieldCheck, ClipboardList, HardHat, Database, Eye, EyeOff, LogIn, WifiOff } from 'lucide-react';
import { LogoCube } from './icons';

export interface DemoAccount { username: string; password: string; role: string; name: string; blurb: string; icon: 'admin' | 'manager' | 'operator' }

export const DEMO_ACCOUNTS: DemoAccount[] = [
  { username: 'admin', password: 'Admin@123', role: 'Administrator', name: 'Riya Sharma', icon: 'admin',
    blurb: 'All sites · user accounts & roles · full audit history' },
  { username: 'alex.chen', password: 'Manager@123', role: 'Operations Manager', name: 'Alex Chen', icon: 'manager',
    blurb: 'Riverside Hub & Southfield · assigns work · sees site activity' },
  { username: 'zoe.reyes', password: 'Operator@123', role: 'Forklift Operator', name: 'Zoe Reyes', icon: 'operator',
    blurb: 'Southfield Cross-Dock · forklift FL-10 · works on assigned tasks' },
];

const ICON = { admin: ShieldCheck, manager: ClipboardList, operator: HardHat };

interface Props {
  serverDown: boolean;
  db: 'oracle' | 'memory' | null;
  onLogin: (username: string, password: string, remember: boolean) => Promise<void>;
  onOffline: () => void;
  notice?: string | null;
}

export function LoginPage({ serverDown, db, onLogin, onOffline, notice }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { document.title = 'Sign in · CargoVerse'; return () => { document.title = 'CargoVerse'; }; }, []);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!username || !password) { setError('Enter your username and password'); return; }
    setBusy(true);
    setError(null);
    try {
      await onLogin(username.trim(), password, remember);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <section className="login-art" aria-hidden>
        <div className="login-brand"><LogoCube size={30} /> <span>CargoVerse</span></div>
        <div className="login-hero">
          <h1>Logistics operations,<br />live in 3D.</h1>
          <p>Docks, trucks, forklifts and inventory across every site — with work assigned to the right people and every change recorded.</p>
        </div>
        <IsoScene />
        <ul className="login-points">
          <li><Database size={15} /> Stored in Oracle Database — tables, PL/SQL, triggers and views</li>
          <li><ShieldCheck size={15} /> Role-based access for administrators, managers and operators</li>
          <li><ClipboardList size={15} /> Tasks, status history and a full audit trail</li>
        </ul>
      </section>

      <section className="login-panel">
        <form className="login-card" onSubmit={submit} noValidate>
          <h2>Sign in</h2>
          <p className="muted">Use your CargoVerse account.</p>
          {notice && <div className="login-note">{notice}</div>}
          {serverDown && (
            <div className="login-warn">
              <WifiOff size={16} />
              <span>The CargoVerse server isn't reachable. Start it with <code>npm run dev</code>, or open the offline demo (no accounts, data stays in this browser).</span>
            </div>
          )}
          <label className="fld">
            <span>Username</span>
            <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. alex.chen" />
          </label>
          <label className="fld">
            <span>Password</span>
            <span className="pw">
              <input type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" className="pw-eye" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
                {show ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
          </label>
          <label className="chk">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>Keep me signed in on this device</span>
          </label>
          {error && <div className="login-err" role="alert">{error}</div>}
          <button className="btn-primary" type="submit" disabled={busy || serverDown}>
            <LogIn size={16} /> {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {serverDown && <button type="button" className="btn-ghost" onClick={onOffline}>Open offline demo</button>}

          <div className="demo">
            <div className="demo-head"><span>Demo accounts</span><span className="muted">click to fill in</span></div>
            {DEMO_ACCOUNTS.map((a) => {
              const Icon = ICON[a.icon];
              return (
                <button type="button" key={a.username} className={`demo-acc ${username === a.username ? 'on' : ''}`}
                  onClick={() => { setUsername(a.username); setPassword(a.password); setError(null); }}>
                  <span className={`demo-ico ${a.icon}`}><Icon size={17} /></span>
                  <span className="demo-txt">
                    <b>{a.role}</b> <span className="muted">· {a.name}</span>
                    <span className="demo-sub">{a.blurb}</span>
                  </span>
                  <code>{a.username}</code>
                </button>
              );
            })}
          </div>
          <div className="login-foot">
            <Database size={13} />
            {serverDown ? 'Server offline' : db === 'oracle' ? 'Connected to Oracle Database' : db === 'memory' ? 'Development mode — in-memory store (no Oracle)' : 'Checking server…'}
          </div>
        </form>
      </section>
    </div>
  );
}

function IsoScene() {
  // decorative isometric warehouse illustration
  return (
    <svg className="login-iso" viewBox="0 0 520 300" role="presentation">
      <defs>
        <linearGradient id="g1" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#5b84f6" /><stop offset="1" stopColor="#2f5bea" /></linearGradient>
      </defs>
      <path d="M40 200 260 90 480 200 260 310z" fill="rgba(255,255,255,.08)" />
      <path d="M120 170 250 105 370 165 240 230z" fill="url(#g1)" />
      <path d="M120 170 240 230v40l-120-60z" fill="#1f45c4" />
      <path d="M240 230 370 165v40l-130 65z" fill="#2a52d6" />
      <path d="M155 202l22 11v28l-22-11zM190 220l22 11v28l-22-11z" fill="#1b2335" />
      <path d="M275 245l25-12v26l-25 12zM315 225l25-12v26l-25 12z" fill="#1b2335" />
      <g transform="translate(330 232)">
        <path d="M0 18 52 -8 92 12 40 38z" fill="#f4f6fb" />
        <path d="M0 18 40 38v22L0 40z" fill="#dfe5f1" />
        <path d="M40 38 92 12v22L40 60z" fill="#c8d2e6" />
        <path d="M76 20l24-12 14 7v18l-24 12z" fill="#2f5bea" />
      </g>
      <g transform="translate(90 222)">
        <path d="M0 8 14 1 28 8 14 15z" fill="#f6b818" /><path d="M0 8 14 15v10L0 18z" fill="#d99c0c" /><path d="M14 15 28 8v10l-14 7z" fill="#e8a910" />
        <path d="M30 6l14-7 10 5-14 7z" fill="#d9a86b" /><path d="M30 6l10 5v8l-10-5z" fill="#c3904f" />
      </g>
      {[[400, 120], [430, 140], [70, 150]].map(([x, y]) => (
        <g key={`${x}`} transform={`translate(${x} ${y})`}>
          <rect x="-2" y="0" width="4" height="16" fill="#9b8a74" /><circle cx="0" cy="-4" r="11" fill="#69c08a" />
        </g>
      ))}
      <g transform="translate(205 150)"><path d="M0 0c0-8 6-13 12-13s12 5 12 13c0 8-12 20-12 20S0 8 0 0z" fill="#fff" /><circle cx="12" cy="-1" r="5" fill="#2f5bea" /></g>
    </svg>
  );
}
