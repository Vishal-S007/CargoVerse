// Browser client for the CargoVerse API.
import type { FacilityId, EntityRef } from '../data/types';
import type {
  SessionUser, Task, TaskUpdate, TaskStatus, AuditEntry, Employee, UserRecord, SimControl, KpiRow, WorkloadRow,
  LowStockRow, JobTitle, RoleInfo, Role, TaskType, Priority, ParkData, BuildingPatch, GateEntry, TradeRow,
  DbOverview, DbTableDetail, SqlResult, SqlActivity, SavedQuery, DbLive, DbLiveRow,
  ContainerMoveRow, VesselCallRow, StoreOrderRow,
} from './types';
import type { Vessel, Berth, StoreOrder } from '../data/types';
import type { ParkBuilding } from '../data/park';

const TOKEN_KEY = 'waretrack.token';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const tokenStore = {
  get(): string | null { try { return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(token: string, remember: boolean) {
    try {
      (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
      (remember ? sessionStorage : localStorage).removeItem(TOKEN_KEY);
    } catch { /* storage unavailable */ }
  },
  clear() { try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the CargoVerse server. Is it running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') onUnauthorized?.();
    throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  health: () => call<{ ok: boolean; db: 'oracle' | 'memory' }>('GET', '/health'),
  login: (username: string, password: string, remember: boolean) =>
    call<{ token: string; user: SessionUser }>('POST', '/auth/login', { username, password, remember }),
  logout: () => call<{ ok: boolean }>('POST', '/auth/logout', {}),
  me: () => call<{ user: SessionUser }>('GET', '/auth/me'),
  meta: () => call<{ roles: RoleInfo[]; jobTitles: JobTitle[]; db: 'oracle' | 'memory' }>('GET', '/meta'),

  tasks: (o: { facility?: FacilityId; scope?: 'mine'; closed?: boolean }) =>
    call<Task[]>('GET', `/tasks${qs({ facility: o.facility, scope: o.scope, closed: o.closed ? 1 : undefined })}`),
  createTask: (t: { facilityId: FacilityId; title: string; description: string; type: TaskType; priority: Priority; assigneeId: number | null; truckId?: string | null; dockId?: string | null; dueMinutes?: number | null }) =>
    call<Task>('POST', '/tasks', t),
  taskStatus: (id: number, status: TaskStatus, note?: string) => call<Task>('PATCH', `/tasks/${id}/status`, { status, note }),
  assignTask: (id: number, assigneeId: number, note?: string) => call<Task>('PATCH', `/tasks/${id}/assign`, { assigneeId, note }),
  taskUpdates: (id: number) => call<TaskUpdate[]>('GET', `/tasks/${id}/updates`),

  employees: (facility?: FacilityId) => call<Employee[]>('GET', `/employees${qs({ facility })}`),
  users: () => call<UserRecord[]>('GET', '/users'),
  createUser: (u: { username: string; password: string; role: Role; fullName: string; email: string; phone?: string; jobCode: string; homeFacility: FacilityId | null; facilities: FacilityId[] }) =>
    call<UserRecord>('POST', '/users', u),
  updateUser: (id: number, patch: { role?: Role; active?: boolean; facilities?: FacilityId[]; password?: string }) =>
    call<UserRecord>('PATCH', `/users/${id}`, patch),

  audit: (o: { facility?: FacilityId; before?: number; limit?: number }) => call<AuditEntry[]>('GET', `/audit${qs(o)}`),
  kpis: (facility?: FacilityId) => call<KpiRow[]>('GET', `/reports/kpis${qs({ facility })}`),
  workload: (facility?: FacilityId) => call<WorkloadRow[]>('GET', `/reports/workload${qs({ facility })}`),
  lowStock: (facility?: FacilityId) => call<LowStockRow[]>('GET', `/reports/low-stock${qs({ facility })}`),
  simControl: (c: Partial<SimControl>) => call<SimControl>('POST', '/sim/control', c),

  park: () => call<ParkData>('GET', '/park'),
  updateBuilding: (id: string, patch: BuildingPatch) => call<ParkBuilding>('PATCH', `/park/buildings/${encodeURIComponent(id)}`, patch),
  gateLog: (o: { facility?: FacilityId; limit?: number }) => call<GateEntry[]>('GET', `/park/gate-log${qs(o)}`),
  trade: (facility?: FacilityId) => call<TradeRow[]>('GET', `/park/trade${qs({ facility })}`),

  portMoves: (o: { limit?: number; container?: string; vessel?: string } = {}) => call<ContainerMoveRow[]>('GET', `/port/moves${qs(o)}`),
  portCalls: (limit = 30) => call<VesselCallRow[]>('GET', `/port/calls${qs({ limit })}`),
  holdVessel: (id: string, hold: boolean) => call<Vessel>('POST', `/port/vessels/${encodeURIComponent(id)}/hold`, { hold }),
  openBerth: (id: string, open: boolean) => call<Berth>('POST', `/port/berths/${encodeURIComponent(id)}/open`, { open }),
  storeOrders: (o: { store?: string; limit?: number } = {}) => call<StoreOrderRow[]>('GET', `/retail/orders${qs(o)}`),
  placeStoreOrder: (o: { storeId: string; skuId: string; units: number }) => call<StoreOrder>('POST', '/retail/orders', o),
  cancelStoreOrder: (id: string) => call<StoreOrder>('POST', `/retail/orders/${encodeURIComponent(id)}/cancel`, {}),

  dbOverview: () => call<DbOverview>('GET', '/db/overview'),
  dbTable: (name: string) => call<DbTableDetail>('GET', `/db/tables/${encodeURIComponent(name)}`),
  dbQueries: () => call<SavedQuery[]>('GET', '/db/queries'),
  runSql: (sql: string) => call<SqlResult>('POST', '/db/sql', { sql }),
  dbLive: () => call<DbLive>('GET', '/db/live'),
  dbRow: (kind: string, id: string) => call<DbLiveRow>('GET', `/db/row/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`),
  dbActivity: (all: boolean) => call<(SqlActivity & { source: string })[]>('GET', `/db/activity${qs({ source: all ? 'all' : undefined })}`),

  alerts: (facility?: FacilityId) => call<Alert[]>('GET', `/alerts${qs({ facility })}`),
  alertTask: (alertId: string, assigneeId?: number) => call<Task>('POST', '/alerts/task', { alertId, assigneeId }),
  assistantStatus: () => call<{ configured: boolean; model: string }>('GET', '/assistant/status'),
  assistant: (messages: { role: 'user' | 'assistant'; content: string }[], facilityId: FacilityId) =>
    call<{ reply: string; actions: { type: 'focus'; ref: EntityRef }[]; tools: string[] }>('POST', '/assistant', { messages, facilityId }),
};

export interface Alert {
  id: string;
  facilityId: FacilityId;
  severity: 'high' | 'medium' | 'low';
  kind: 'late_shipment' | 'low_battery' | 'gate_wait' | 'low_stock' | 'blocked_task';
  title: string;
  detail: string;
  ref: EntityRef | null;
  suggestion: { title: string; description: string; type: TaskType; priority: Priority; jobCode: string } | null;
}

export function streamUrl(): string {
  return `/api/stream?token=${encodeURIComponent(tokenStore.get() ?? '')}`;
}
