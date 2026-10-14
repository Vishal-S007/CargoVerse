// In-process implementation of the storage interface, persisted to a JSON file.
// Mirrors the rules enforced by the Oracle PL/SQL packages and triggers so the
// application can be developed and tested without a database server.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WorldState, FacilityId } from '../../src/data/types';
import type {
  SessionUser, Task, TaskUpdate, TaskStatus, AuditEntry, Employee, UserRecord, SimControl, KpiRow, WorkloadRow,
  LowStockRow, Role, JobTitle, RoleInfo, Permission, ParkData, BuildingPatch, GateEntry, TradeRow, DbOverview, DbTableDetail, SqlResult,
  DbLiveRow, ContainerMoveRow, VesselCallRow, StoreOrderRow,
} from '../../src/api/types';
import type { StoreOrder } from '../../src/data/types';
import { VESSEL_LINES, YARD_CAPACITY } from '../../src/data/city';
import { PARK_COMPANIES, PARK_BUILDINGS, PARK_VEHICLES, PARK_ROUTES, PARK_GATES, gateBuildingId } from '../../src/data/park';
import type { GateOp, BoxOp, NewStoreOrder } from './repo';
import { schemaMeta, TABLE_GROUPS } from './schema-meta';
import { TASK_TRANSITIONS, OPERATOR_TRANSITIONS } from '../../src/api/types';
import { createSeedWorld, SKUS, WORLD_VERSION, seedGateHistory } from '../../src/data/seed';
import {
  AppError, type Repo, type PersistBatch, type LoginRow, type SessionRow, type NewTask, type NewUser,
  type UserPatch, type TaskFilter, type AuditFilter,
} from './repo';
import {
  ROLES, ROLE_PERMS, JOB_TITLES, EMPLOYEES, USERS, DEMO_PASSWORDS, FORKLIFT_OPERATORS, SEED_TASKS, PERMISSIONS, CARRIERS, LICENSES,
} from './people';
import { hashPassword } from '../auth';

interface MemEmployee { id: number; fullName: string; email: string; phone: string | null; jobCode: string; facilityId: FacilityId | null; status: Employee['status'] }
interface MemUser { id: number; username: string; hash: string; role: Role; employeeId: number; active: boolean; facilities: FacilityId[]; createdAt: string; createdBy: number | null; lastLoginAt: string | null; failedLogins: number }
interface MemTask extends Omit<Task, 'assigneeName' | 'createdByName' | 'lastNote'> { shipmentId: string | null }
interface MemSession { id: string; userId: number; createdAt: number; expiresAt: number; revoked: boolean; remember: boolean }

interface MemGate { id: number; at: string; op: Omit<GateOp, 'k'> }

interface MemMove { id: number; at: string; op: Omit<BoxOp, 'k'> }
interface MemOrder { order: StoreOrder; placedAt: string; dispatchedAt: string | null; deliveredAt: string | null }

interface MemData {
  version: 4;
  moves: MemMove[];
  calls: VesselCallRow[];
  orders: Record<string, MemOrder>;
  park: ParkData;
  gateLog: MemGate[];
  employees: MemEmployee[];
  users: MemUser[];
  sessions: MemSession[];
  tasks: MemTask[];
  taskUpdates: TaskUpdate[];
  audit: AuditEntry[];
  world: WorldState | null;
  control: SimControl;
  deliveredLog: { facilityId: FacilityId; onTime: boolean; at: number }[];
  seq: { employee: number; user: number; task: number; update: number; audit: number };
}

const now = () => new Date().toISOString();
const OPEN: TaskStatus[] = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED'];

export class MemoryRepo implements Repo {
  readonly kind = 'memory' as const;
  private d!: MemData;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private file: string) {}

  async init(): Promise<void> {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as MemData;
        if (parsed.version === 4) {
          this.d = parsed;
          if (this.d.world && this.d.world.version !== WORLD_VERSION) { this.d.world = null; this.d.gateLog = this.seedGateLog(); }
          return;
        }
      } catch { /* reseed */ }
    }
    this.d = this.seed();
    this.flushNow();
  }

  async close(): Promise<void> { this.flushNow(); }

  private seed(): MemData {
    const t = now();
    const d: MemData = {
      version: 4,
      moves: [],
      calls: [],
      orders: {},
      park: structuredClone({ companies: PARK_COMPANIES, buildings: PARK_BUILDINGS, vehicles: PARK_VEHICLES }),
      gateLog: [],
      employees: EMPLOYEES.map((e) => ({ id: e.id, fullName: e.name, email: e.email, phone: e.phone, jobCode: e.job, facilityId: e.facility, status: 'ACTIVE' })),
      users: USERS.map((u) => ({
        id: u.id, username: u.username, hash: hashPassword(DEMO_PASSWORDS[u.role]), role: u.role, employeeId: u.employeeId,
        active: true, facilities: u.facilities, createdAt: t, createdBy: null, lastLoginAt: null, failedLogins: 0,
      })),
      sessions: [],
      tasks: [],
      taskUpdates: [],
      audit: [],
      world: null,
      control: { paused: false, speed: 1 },
      deliveredLog: [],
      seq: { employee: EMPLOYEES.length, user: USERS.length, task: 0, update: 0, audit: 0 },
    };
    this.d = d;
    d.gateLog = this.seedGateLog();
    for (const s of SEED_TASKS) {
      const id = ++d.seq.task;
      const status: TaskStatus = s.status;
      d.tasks.push({
        id, facilityId: s.facility, title: s.title, description: s.description, type: s.type, priority: s.priority, status,
        source: 'MANUAL', assigneeId: s.assignee, createdById: s.createdBy, truckId: s.truck ?? null, dockId: s.dock ?? null,
        forkliftId: null, shipmentId: null, dueAt: new Date(Date.now() + s.dueMinutes * 60000).toISOString(), createdAt: t,
        startedAt: status === 'IN_PROGRESS' || status === 'BLOCKED' ? t : null, completedAt: null,
      });
      this.addUpdate(id, s.createdBy, null, s.assignee ? 'ASSIGNED' : 'OPEN', 'Task created');
      if (status !== 'ASSIGNED' && status !== 'OPEN') {
        const assigneeUser = d.users.find((u) => u.employeeId === s.assignee);
        this.addUpdate(id, assigneeUser?.id ?? null, 'ASSIGNED', status, s.note ?? null);
      }
    }
    return d;
  }

  private seedGateLog(): MemGate[] {
    const w = createSeedWorld();
    return seedGateHistory(w).map((r, i) => ({
      id: i + 1, at: new Date(Date.now() - r.minutesAgo * 60000).toISOString(),
      op: { gate: r.gate, direction: r.direction, trade: r.trade, truckId: r.truckId, facilityId: r.facilityId, shipmentId: '', skuId: r.skuId, pallets: r.pallets, t: r.simTime },
    }));
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flushNow(); }, 500);
  }

  private flushNow(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.d));
    renameSync(tmp, this.file);
  }

  // ---------------------------------------------------------------- helpers
  private perms(role: Role): Permission[] { return ROLE_PERMS[role]; }
  private user(id: number | null): MemUser | undefined { return id === null ? undefined : this.d.users.find((u) => u.id === id); }
  private emp(id: number | null): MemEmployee | undefined { return id === null ? undefined : this.d.employees.find((e) => e.id === id); }
  private can(userId: number, perm: Permission): boolean {
    const u = this.user(userId);
    return !!u && u.active && this.perms(u.role).includes(perm);
  }
  private canAccess(userId: number, fac: FacilityId): boolean {
    const u = this.user(userId);
    if (!u || !u.active) return false;
    return this.perms(u.role).includes('VIEW_ALL_FACILITIES') || u.facilities.includes(fac);
  }
  private audit(userId: number | null, action: string, entity: string, entityId: string | null, facilityId: FacilityId | null, details: string): void {
    const u = this.user(userId);
    this.d.audit.push({ id: ++this.d.seq.audit, at: now(), userId, username: u?.username ?? null, action, entity, entityId, facilityId, details });
    if (this.d.audit.length > 5000) this.d.audit.splice(0, this.d.audit.length - 5000);
  }
  private addUpdate(taskId: number, userId: number | null, oldS: TaskStatus | null, newS: TaskStatus, note: string | null): void {
    const u = this.user(userId);
    const e = u ? this.emp(u.employeeId) : undefined;
    this.d.taskUpdates.push({ id: ++this.d.seq.update, taskId, userId, userName: e?.fullName ?? 'System', oldStatus: oldS, newStatus: newS, note, createdAt: now() });
  }
  private checkAssignee(assigneeId: number | null, fac: FacilityId): void {
    if (assigneeId === null) return;
    const e = this.emp(assigneeId);
    if (!e || e.status !== 'ACTIVE' || (e.facilityId !== null && e.facilityId !== fac)) {
      throw new AppError(400, `Employee ${assigneeId} is not active at ${fac}`);
    }
  }
  private toTask(t: MemTask): Task {
    const assignee = this.emp(t.assigneeId);
    const creator = this.user(t.createdById);
    const updates = this.d.taskUpdates.filter((u) => u.taskId === t.id);
    const last = updates[updates.length - 1];
    return {
      ...t, assigneeName: assignee?.fullName ?? null,
      createdByName: creator ? this.emp(creator.employeeId)?.fullName ?? creator.username : 'System',
      lastNote: last?.note ?? null,
    };
  }

  // ---------------------------------------------------------------- world
  async loadWorld() {
    const world = this.d.world ?? createSeedWorld();
    return { world, control: this.d.control, operators: { ...FORKLIFT_OPERATORS } };
  }

  async persist(batch: PersistBatch): Promise<void> {
    this.d.world = batch.world;
    for (const m of batch.box) {
      const { k: _k, ...op } = m;
      this.d.moves.push({ id: (this.d.moves[this.d.moves.length - 1]?.id ?? 0) + 1, at: now(), op });
    }
    if (this.d.moves.length > 4000) this.d.moves.splice(0, this.d.moves.length - 4000);
    for (const k of batch.calls) {
      const v = batch.world.port.vessels[k.vesselId];
      if (k.phase === 'ARRIVE') {
        this.d.calls.push({ id: (this.d.calls[this.d.calls.length - 1]?.id ?? 0) + 1, vesselId: k.vesselId, vesselName: v?.name ?? k.vesselId, voyage: k.voyage, berthId: k.berthId, arrivedAt: now(), departedAt: null, discharged: 0, loaded: 0, status: 'ALONGSIDE' });
      } else {
        const c = this.d.calls.find((x) => x.vesselId === k.vesselId && x.voyage === k.voyage);
        if (c) Object.assign(c, { departedAt: now(), discharged: k.discharged, loaded: k.loaded, status: 'COMPLETED' });
      }
    }
    if (this.d.calls.length > 500) this.d.calls.splice(0, this.d.calls.length - 500);
    for (const o of batch.orders) {
      const prev = this.d.orders[o.id];
      const rec: MemOrder = prev ?? { order: o, placedAt: now(), dispatchedAt: null, deliveredAt: null };
      rec.order = { ...o };
      if (o.status === 'OUT_FOR_DELIVERY' && !rec.dispatchedAt) rec.dispatchedAt = now();
      if (o.status === 'DELIVERED' && !rec.deliveredAt) rec.deliveredAt = now();
      this.d.orders[o.id] = rec;
    }
    const ids = Object.keys(this.d.orders);
    if (ids.length > 1500) for (const id of ids.slice(0, ids.length - 1500)) delete this.d.orders[id];
    for (const g of batch.gate) {
      const { k: _k, ...op } = g;
      this.d.gateLog.push({ id: (this.d.gateLog[this.d.gateLog.length - 1]?.id ?? 0) + 1, at: now(), op });
    }
    if (this.d.gateLog.length > 5000) this.d.gateLog.splice(0, this.d.gateLog.length - 5000);
    this.scheduleSave();
  }

  async saveControl(control: SimControl, userId: number | null): Promise<void> {
    const old = this.d.control;
    if (old.paused !== control.paused) this.audit(userId, control.paused ? 'OPS_PAUSED' : 'OPS_RESUMED', 'OPERATIONS', null, null, `Operations clock ${control.paused ? 'paused' : 'resumed'}`);
    if (old.speed !== control.speed) this.audit(userId, 'OPS_SPEED', 'OPERATIONS', null, null, `Speed ${old.speed}× → ${control.speed}×`);
    this.d.control = { ...control };
    this.scheduleSave();
  }

  // ---------------------------------------------------------------- auth
  async findLogin(username: string): Promise<LoginRow | null> {
    const u = this.d.users.find((x) => x.username === username.toLowerCase());
    return u ? { userId: u.id, username: u.username, passwordHash: u.hash, active: u.active } : null;
  }

  async recordLogin(userId: number | null, username: string, success: boolean): Promise<void> {
    const u = this.user(userId);
    if (success && u) { u.lastLoginAt = now(); u.failedLogins = 0; this.audit(u.id, 'LOGIN', 'SESSION', username, null, 'Signed in'); }
    else { if (u) u.failedLogins += 1; this.audit(userId, 'LOGIN_FAILED', 'SESSION', username, null, 'Wrong username or password'); }
    this.scheduleSave();
  }

  async createSession(sessionId: string, userId: number, days: number): Promise<void> {
    const t = Date.now();
    this.d.sessions.push({ id: sessionId, userId, createdAt: t, expiresAt: t + days * 86400000, revoked: false, remember: days >= 1 });
    this.d.sessions = this.d.sessions.filter((s) => s.expiresAt > t);
    this.scheduleSave();
  }
  async getSession(sessionId: string): Promise<SessionRow | null> {
    const s = this.d.sessions.find((x) => x.id === sessionId);
    return s ? { userId: s.userId, expiresAt: new Date(s.expiresAt), revoked: s.revoked, remember: s.remember } : null;
  }
  async extendSession(sessionId: string, days: number): Promise<void> {
    const s = this.d.sessions.find((x) => x.id === sessionId);
    if (s) { s.expiresAt = Date.now() + days * 86400000; this.scheduleSave(); }
  }
  async revokeSession(sessionId: string): Promise<void> {
    const s = this.d.sessions.find((x) => x.id === sessionId);
    if (s && !s.revoked) { s.revoked = true; this.audit(s.userId, 'LOGOUT', 'SESSION', null, null, 'Signed out'); this.scheduleSave(); }
  }

  async sessionUser(userId: number): Promise<SessionUser | null> {
    const u = this.user(userId);
    if (!u || !u.active) return null;
    const e = this.emp(u.employeeId)!;
    const role = ROLES.find((r) => r.code === u.role)!;
    const perms = this.perms(u.role);
    const facilities = perms.includes('VIEW_ALL_FACILITIES') ? (['WH-01', 'WH-02', 'WH-04'] as FacilityId[]) : u.facilities;
    const forklift = Object.entries(FORKLIFT_OPERATORS).find(([, emp]) => emp === e.id)?.[0] ?? null;
    return {
      userId: u.id, username: u.username, fullName: e.fullName, email: e.email, role: u.role, roleName: role.name,
      jobCode: e.jobCode, jobTitle: JOB_TITLES.find((j) => j.code === e.jobCode)?.title ?? e.jobCode, employeeId: e.id,
      homeFacility: e.facilityId, facilities, permissions: perms, forkliftId: forklift,
    };
  }

  // ---------------------------------------------------------------- people
  async listUsers(): Promise<UserRecord[]> {
    return this.d.users.map((u) => {
      const e = this.emp(u.employeeId)!;
      return {
        id: u.id, username: u.username, role: u.role, active: u.active, employeeId: e.id, fullName: e.fullName, email: e.email,
        jobCode: e.jobCode, jobTitle: JOB_TITLES.find((j) => j.code === e.jobCode)?.title ?? e.jobCode,
        facilities: u.facilities, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
      };
    });
  }

  async createUser(adminId: number, input: NewUser): Promise<number> {
    if (!this.can(adminId, 'MANAGE_USERS')) throw new AppError(403, 'Not permitted: managing users requires the MANAGE_USERS permission');
    const username = input.username.toLowerCase();
    if (this.d.users.some((u) => u.username === username)) throw new AppError(409, `Username ${username} is already taken`);
    if (this.d.employees.some((e) => e.email === input.email.toLowerCase())) throw new AppError(409, `Email ${input.email} is already in use`);
    const empId = ++this.d.seq.employee;
    this.d.employees.push({ id: empId, fullName: input.fullName, email: input.email.toLowerCase(), phone: input.phone, jobCode: input.jobCode, facilityId: input.homeFacility, status: 'ACTIVE' });
    this.audit(adminId, 'EMPLOYEE_ADDED', 'EMPLOYEE', String(empId), input.homeFacility, `${input.fullName} · ${input.jobCode}`);
    const id = ++this.d.seq.user;
    const facilities = input.facilities.length ? input.facilities : input.homeFacility ? [input.homeFacility] : [];
    this.d.users.push({ id, username, hash: input.passwordHash, role: input.role, employeeId: empId, active: true, facilities, createdAt: now(), createdBy: adminId, lastLoginAt: null, failedLogins: 0 });
    this.audit(adminId, 'USER_CREATED', 'USER', username, null, `Role ${input.role}`);
    for (const f of facilities) this.audit(adminId, 'ACCESS_GRANTED', 'USER', username, f, 'Facility access granted');
    this.scheduleSave();
    return id;
  }

  async updateUser(adminId: number, userId: number, patch: UserPatch): Promise<void> {
    if (!this.can(adminId, 'MANAGE_USERS')) throw new AppError(403, 'Not permitted: managing users requires the MANAGE_USERS permission');
    if (userId === adminId && (patch.active === false || (patch.role && patch.role !== 'ADMIN'))) {
      throw new AppError(400, 'Administrators cannot deactivate or demote their own account');
    }
    const u = this.user(userId);
    if (!u) throw new AppError(404, `User ${userId} not found`);
    const changes: string[] = [];
    if (patch.role && patch.role !== u.role) { changes.push(`role ${u.role} → ${patch.role}`); u.role = patch.role; }
    if (patch.active !== undefined && patch.active !== u.active) {
      changes.push(patch.active ? 'activated' : 'deactivated');
      u.active = patch.active;
      if (!patch.active) this.d.sessions.forEach((s) => { if (s.userId === u.id) s.revoked = true; });
    }
    if (patch.passwordHash) { changes.push('password reset'); u.hash = patch.passwordHash; u.failedLogins = 0; }
    if (changes.length) this.audit(adminId, 'USER_UPDATED', 'USER', u.username, null, changes.join('; '));
    if (patch.facilities) {
      for (const f of u.facilities) if (!patch.facilities.includes(f)) this.audit(adminId, 'ACCESS_REVOKED', 'USER', u.username, f, 'Facility access revoked');
      for (const f of patch.facilities) if (!u.facilities.includes(f)) this.audit(adminId, 'ACCESS_GRANTED', 'USER', u.username, f, 'Facility access granted');
      u.facilities = [...patch.facilities];
    }
    this.scheduleSave();
  }

  async listEmployees(facilities: FacilityId[] | null): Promise<Employee[]> {
    return this.d.employees
      .filter((e) => facilities === null || (e.facilityId !== null && facilities.includes(e.facilityId)))
      .map((e) => {
        const u = this.d.users.find((x) => x.employeeId === e.id);
        return {
          id: e.id, fullName: e.fullName, email: e.email, phone: e.phone, jobCode: e.jobCode,
          jobTitle: JOB_TITLES.find((j) => j.code === e.jobCode)?.title ?? e.jobCode, facilityId: e.facilityId, status: e.status,
          userId: u?.id ?? null, username: u?.username ?? null, role: u?.role ?? null,
          forkliftId: Object.entries(FORKLIFT_OPERATORS).find(([, id]) => id === e.id)?.[0] ?? null,
          openTasks: this.d.tasks.filter((t) => t.assigneeId === e.id && OPEN.includes(t.status)).length,
        };
      });
  }

  async listJobTitles(): Promise<JobTitle[]> { return JOB_TITLES.map((j) => ({ code: j.code, title: j.title, responsibilities: j.responsibilities })); }
  async listRoles(): Promise<RoleInfo[]> { return ROLES.map((r) => ({ code: r.code, name: r.name, description: r.description, permissions: ROLE_PERMS[r.code] })); }

  // ---------------------------------------------------------------- tasks
  async listTasks(f: TaskFilter): Promise<Task[]> {
    return this.d.tasks
      .filter((t) => f.facilities.includes(t.facilityId))
      .filter((t) => f.assigneeId === undefined || t.assigneeId === f.assigneeId)
      .filter((t) => f.includeClosed || OPEN.includes(t.status))
      .sort((a, b) => b.id - a.id)
      .slice(0, f.limit ?? 200)
      .map((t) => this.toTask(t));
  }

  async getTask(id: number): Promise<Task | null> {
    const t = this.d.tasks.find((x) => x.id === id);
    return t ? this.toTask(t) : null;
  }

  async createTask(userId: number | null, input: NewTask): Promise<number> {
    if (userId !== null) {
      if (!this.can(userId, 'MANAGE_TASKS')) throw new AppError(403, 'Not permitted: creating tasks requires MANAGE_TASKS');
      if (!this.canAccess(userId, input.facilityId)) throw new AppError(403, `No access to facility ${input.facilityId}`);
    }
    this.checkAssignee(input.assigneeId, input.facilityId);
    const id = ++this.d.seq.task;
    const status: TaskStatus = input.assigneeId === null ? 'OPEN' : input.source === 'SYSTEM' ? 'IN_PROGRESS' : 'ASSIGNED';
    const t = now();
    this.d.tasks.push({
      id, facilityId: input.facilityId, title: input.title, description: input.description, type: input.type, priority: input.priority,
      status, source: input.source, assigneeId: input.assigneeId, createdById: userId, truckId: input.truckId ?? null,
      dockId: input.dockId ?? null, forkliftId: input.forkliftId ?? null, shipmentId: input.shipmentId ?? null,
      dueAt: input.dueMinutes ? new Date(Date.now() + input.dueMinutes * 60000).toISOString() : null,
      createdAt: t, startedAt: status === 'IN_PROGRESS' ? t : null, completedAt: null,
    });
    this.addUpdate(id, userId, null, status, input.source === 'SYSTEM' ? 'Created automatically by operations' : 'Task created');
    if (userId !== null || input.source === 'MANUAL') {
      this.audit(userId, 'TASK_CREATED', 'TASK', String(id), input.facilityId, `${input.title} · ${input.priority} · assigned to ${this.emp(input.assigneeId)?.fullName ?? 'nobody'}`);
    }
    this.scheduleSave();
    return id;
  }

  async changeTaskStatus(userId: number | null, taskId: number, status: TaskStatus, note: string | null): Promise<void> {
    const t = this.d.tasks.find((x) => x.id === taskId);
    if (!t) throw new AppError(404, `Task ${taskId} not found`);
    let operator = false;
    if (userId !== null) {
      if (!this.canAccess(userId, t.facilityId)) throw new AppError(403, `No access to facility ${t.facilityId}`);
      if (!this.can(userId, 'MANAGE_TASKS')) {
        const u = this.user(userId)!;
        if (!this.can(userId, 'UPDATE_OWN_TASKS') || t.assigneeId !== u.employeeId) throw new AppError(403, 'Not permitted: you can only update tasks assigned to you');
        operator = true;
      }
    }
    const allowed = operator ? OPERATOR_TRANSITIONS[t.status] ?? [] : TASK_TRANSITIONS[t.status];
    if (!allowed.includes(status)) throw new AppError(409, `Cannot move task from ${t.status} to ${status}`);
    const old = t.status;
    t.status = status;
    if (status === 'IN_PROGRESS' && !t.startedAt) t.startedAt = now();
    if ((status === 'DONE' || status === 'CANCELLED') && !t.completedAt) t.completedAt = now();
    this.addUpdate(taskId, userId, old, status, note);
    if (userId !== null || t.source === 'MANUAL') this.audit(userId, 'TASK_STATUS', 'TASK', String(taskId), t.facilityId, `${t.title}: ${old} → ${status}`);
    this.scheduleSave();
  }

  async assignTask(userId: number | null, taskId: number, assigneeId: number, note: string | null): Promise<void> {
    const t = this.d.tasks.find((x) => x.id === taskId);
    if (!t) throw new AppError(404, `Task ${taskId} not found`);
    if (userId !== null && (!this.can(userId, 'MANAGE_TASKS') || !this.canAccess(userId, t.facilityId))) {
      throw new AppError(403, `Not permitted: assigning tasks requires MANAGE_TASKS for ${t.facilityId}`);
    }
    if (t.status === 'DONE' || t.status === 'CANCELLED') throw new AppError(409, `Task ${taskId} is already ${t.status}`);
    this.checkAssignee(assigneeId, t.facilityId);
    const oldAssignee = t.assigneeId;
    const oldStatus = t.status;
    t.assigneeId = assigneeId;
    if (t.status === 'OPEN') t.status = 'ASSIGNED';
    const name = this.emp(assigneeId)?.fullName ?? `#${assigneeId}`;
    this.addUpdate(taskId, userId, oldStatus, t.status, note ?? `Assigned to ${name}`);
    if (userId !== null || t.source === 'MANUAL') {
      if (oldStatus !== t.status) this.audit(userId, 'TASK_STATUS', 'TASK', String(taskId), t.facilityId, `${t.title}: ${oldStatus} → ${t.status}`);
      this.audit(userId, 'TASK_ASSIGNED', 'TASK', String(taskId), t.facilityId, `${t.title}: ${this.emp(oldAssignee)?.fullName ?? 'nobody'} → ${name}`);
    }
    this.scheduleSave();
  }

  async taskUpdates(taskId: number): Promise<TaskUpdate[]> {
    return this.d.taskUpdates.filter((u) => u.taskId === taskId);
  }

  async openSystemTasks(truckId: string): Promise<Task[]> {
    return this.d.tasks.filter((t) => t.source === 'SYSTEM' && t.truckId === truckId && OPEN.includes(t.status)).map((t) => this.toTask(t));
  }

  // ---------------------------------------------------------------- history & reports
  async listAudit(f: AuditFilter): Promise<AuditEntry[]> {
    const out: AuditEntry[] = [];
    for (let i = this.d.audit.length - 1; i >= 0 && out.length < f.limit; i--) {
      const a = this.d.audit[i];
      if (f.beforeId && a.id >= f.beforeId) continue;
      if (f.facilities !== null) {
        if (a.facilityId === null) {
          // managers see facility-less entries only when they concern their own team
          const u = this.user(a.userId);
          const e = u ? this.emp(u.employeeId) : undefined;
          if (!e || !e.facilityId || !f.facilities.includes(e.facilityId)) continue;
        } else if (!f.facilities.includes(a.facilityId)) continue;
      }
      out.push(a);
    }
    return out;
  }

  async latestAuditId(): Promise<number> { return this.d.seq.audit; }

  private worldOrSeed(): WorldState { return this.d.world ?? createSeedWorld(); }

  async kpis(facilities: FacilityId[]): Promise<KpiRow[]> {
    const w = this.worldOrSeed();
    return facilities.map((id) => {
      const f = w.facilities[id];
      const trucks = Object.values(w.trucks).filter((t) => t.facilityId === id);
      return {
        facilityId: id, name: f.name, stock: f.stock, capacity: f.capacity, fillPct: Math.round((f.stock / f.capacity) * 1000) / 10,
        trucksOnSite: trucks.filter((t) => ['at_gate', 'docking', 'working', 'ready', 'departing'].includes(t.phase)).length,
        inbound: trucks.filter((t) => t.direction === 'inbound' && t.phase !== 'away' && t.phase !== 'leaving').length,
        otdPct: Math.round((f.onTime30d / Math.max(1, f.deliveries30d)) * 10000) / 100, deliveries30d: f.deliveries30d,
        openTasks: this.d.tasks.filter((t) => t.facilityId === id && OPEN.includes(t.status)).length,
        lowStockLines: f.inventory.filter((l) => l.units < l.lowBelow).length,
      };
    });
  }

  async workload(facilities: FacilityId[]): Promise<WorkloadRow[]> {
    const today = new Date().toISOString().slice(0, 10);
    return this.d.employees
      .filter((e) => e.status === 'ACTIVE' && e.facilityId && facilities.includes(e.facilityId))
      .map((e) => {
        const mine = this.d.tasks.filter((t) => t.assigneeId === e.id);
        return {
          employeeId: e.id, fullName: e.fullName, jobTitle: JOB_TITLES.find((j) => j.code === e.jobCode)?.title ?? e.jobCode,
          facilityId: e.facilityId,
          open: mine.filter((t) => ['OPEN', 'ASSIGNED', 'BLOCKED'].includes(t.status)).length,
          inProgress: mine.filter((t) => t.status === 'IN_PROGRESS').length,
          doneToday: mine.filter((t) => t.status === 'DONE' && (t.completedAt ?? '').startsWith(today)).length,
        };
      });
  }

  async lowStock(facilities: FacilityId[]): Promise<LowStockRow[]> {
    const w = this.worldOrSeed();
    const rows: LowStockRow[] = [];
    for (const id of facilities) {
      for (const l of w.facilities[id].inventory) {
        if (l.units < l.lowBelow) rows.push({ facilityId: id, skuId: l.skuId, skuName: SKUS[l.skuId]?.name ?? l.skuId, units: l.units, reorderLevel: l.lowBelow });
      }
    }
    return rows;
  }

  // ---------------------------------------------------------------- logistics park
  async park(): Promise<ParkData> { return structuredClone(this.d.park); }

  async updateBuilding(userId: number, buildingId: string, p: BuildingPatch): Promise<void> {
    if (!this.can(userId, 'MANAGE_PARK')) throw new AppError(403, 'Not permitted: editing park buildings requires the MANAGE_PARK permission');
    const b = this.d.park.buildings.find((x) => x.id === buildingId);
    if (!b) throw new AppError(404, `Building ${buildingId} not found`);
    if (b.facilityId && p.status && (p.status === 'VACANT' || p.status === 'CONSTRUCTION')) {
      throw new AppError(400, `A CargoVerse site that is running operations cannot be marked ${p.status}`);
    }
    if (p.leaseEnd && p.leaseEnd <= b.leaseStart) throw new AppError(400, `The lease cannot end before it starts (${b.leaseStart})`);
    if (p.staff !== undefined && p.staff < 0) throw new AppError(400, 'Rejected by a check constraint: CK_PB_STAFF');
    const changes: string[] = [];
    if (p.status && p.status !== b.status) { changes.push(`status ${b.status} → ${p.status}`); b.status = p.status; }
    if (p.staff !== undefined && p.staff !== b.staff) { changes.push(`staff ${b.staff} → ${p.staff}`); b.staff = p.staff; }
    if (p.leaseEnd && p.leaseEnd !== b.leaseEnd) { changes.push(`lease end ${b.leaseEnd} → ${p.leaseEnd}`); b.leaseEnd = p.leaseEnd; }
    if (changes.length) this.audit(userId, 'BUILDING_UPDATED', 'BUILDING', b.id, b.facilityId, `${b.name}: ${changes.join('; ')}`);
    this.scheduleSave();
  }

  async gateLog(facilities: FacilityId[], limit: number): Promise<GateEntry[]> {
    const w = this.worldOrSeed();
    const out: GateEntry[] = [];
    for (let i = this.d.gateLog.length - 1; i >= 0 && out.length < limit; i--) {
      const g = this.d.gateLog[i];
      if (!facilities.includes(g.op.facilityId)) continue;
      const empty = g.op.trade === 'EMPTY';
      out.push({
        id: g.id, at: g.at, simTime: g.op.t, gate: g.op.gate, direction: g.op.direction, trade: g.op.trade, truckId: g.op.truckId,
        carrier: w.trucks[g.op.truckId]?.carrier ?? '', facilityId: g.op.facilityId, shipmentId: g.op.shipmentId || null,
        skuId: empty ? null : g.op.skuId, skuName: empty ? null : SKUS[g.op.skuId]?.name ?? null, pallets: empty ? 0 : g.op.pallets,
      });
    }
    return out;
  }

  async trade(facilities: FacilityId[]): Promise<TradeRow[]> {
    const w = this.worldOrSeed();
    const today = new Date().toISOString().slice(0, 10);
    return facilities.map((id) => {
      const f = w.facilities[id];
      return {
        facilityId: id, name: f.name, importTrucks: f.importsToday, importPallets: f.importPalletsToday,
        exportTrucks: f.exportsToday, exportPallets: f.exportPalletsToday,
        emptyMoves: this.d.gateLog.filter((g) => g.op.facilityId === id && g.op.trade === 'EMPTY' && g.at.startsWith(today)).length,
      };
    });
  }

  // ---------------------------------------------------------------- database workspace (schema from the SQL scripts)
  private memRows(table: string): Record<string, unknown>[] | null {
    const w = this.worldOrSeed();
    const up = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase(), v]));
    switch (table) {
      case 'ROLES': return ROLES.map((r) => ({ ROLE_CODE: r.code, ROLE_NAME: r.name, DESCRIPTION: r.description }));
      case 'PERMISSIONS': return PERMISSIONS.map((x) => ({ PERM_CODE: x.code, DESCRIPTION: x.description }));
      case 'CARRIERS': return CARRIERS.map((c) => ({ CARRIER_ID: c.id, NAME: c.name, DISPLAY_NAME: c.display, PHONE: c.phone }));
      case 'DRIVERS': return Object.values(w.trucks).map((t, i) => ({ DRIVER_ID: i + 1, CARRIER_ID: t.carrier.toUpperCase(), FULL_NAME: t.driver, LICENSE_NO: LICENSES[t.id] ?? `LIC-${t.id}` }));
      case 'USER_FACILITY_ACCESS': return this.d.users.flatMap((u) => u.facilities.map((f) => ({ USER_ID: u.id, FACILITY_ID: f })));
      case 'ROLE_PERMISSIONS': return Object.entries(ROLE_PERMS).flatMap(([r, ps]) => ps.map((p) => ({ ROLE_CODE: r, PERM_CODE: p })));
      case 'JOB_TITLES': return JOB_TITLES.map((j) => ({ JOB_CODE: j.code, TITLE: j.title, RESPONSIBILITIES: j.responsibilities }));
      case 'EMPLOYEES': return this.d.employees.map((e) => ({ EMPLOYEE_ID: e.id, FULL_NAME: e.fullName, EMAIL: e.email, JOB_CODE: e.jobCode, FACILITY_ID: e.facilityId, EMP_STATUS: e.status }));
      case 'APP_USERS': return this.d.users.map((u) => ({ USER_ID: u.id, USERNAME: u.username, ROLE_CODE: u.role, EMPLOYEE_ID: u.employeeId, IS_ACTIVE: u.active ? 'Y' : 'N', LAST_LOGIN_AT: u.lastLoginAt }));
      case 'USER_SESSIONS': return this.d.sessions.map((x) => ({ USER_ID: x.userId, EXPIRES_AT: new Date(x.expiresAt).toISOString(), REVOKED: x.revoked ? 'Y' : 'N', REMEMBER_ME: x.remember ? 'Y' : 'N' }));
      case 'FACILITIES': return Object.values(w.facilities).map((f) => { const { inventory: _i, ...rest } = f; return up(rest); });
      case 'INVENTORY': return Object.values(w.facilities).flatMap((f) => f.inventory.map((l) => ({ FACILITY_ID: f.id, SKU_ID: l.skuId, UNITS: l.units, REORDER_LEVEL: l.lowBelow })));
      case 'SKUS': return Object.values(SKUS).map((x) => up(x as unknown as Record<string, unknown>));
      case 'DOCKS': return Object.values(w.docks).map((x) => up(x as unknown as Record<string, unknown>));
      case 'CHARGERS': return Object.values(w.chargers).map((x) => up(x as unknown as Record<string, unknown>));
      case 'TRUCKS': return Object.values(w.trucks).map((t) => ({ TRUCK_ID: t.id, FACILITY_ID: t.facilityId, CARRIER: t.carrier, PLATE: t.plate, DIRECTION: t.direction.toUpperCase(), STATUS: t.phase.toUpperCase(), DOCK_ID: t.dockId, CARGO_PALLETS: t.cargo, CAPACITY_PALLETS: t.capacity, CURRENT_SHIPMENT_ID: t.shipmentId }));
      case 'SHIPMENTS': return Object.values(w.shipments).map((x) => up(x as unknown as Record<string, unknown>));
      case 'FORKLIFTS': return Object.values(w.forklifts).map((f) => ({ FORKLIFT_ID: f.id, FACILITY_ID: f.facilityId, MODEL: f.model, BATTERY_PCT: Math.round(f.battery * 10) / 10, TASK_STATE: f.task.toUpperCase(), TRUCK_ID: f.truckId, PALLET_ID: f.palletId, MOVES_TODAY: f.movesToday }));
      case 'PALLETS': return Object.values(w.pallets).map((p) => ({ PALLET_ID: p.id, FACILITY_ID: p.facilityId, SKU_ID: p.skuId, QTY: p.qty, YARD_SLOT: p.slot, FORKLIFT_ID: p.forkliftId, PALLET_STATUS: p.slot !== null ? 'STAGED' : p.forkliftId ? 'IN_TRANSIT' : 'UNPLACED' }));
      case 'TASKS': return this.d.tasks.map((t) => ({ TASK_ID: t.id, FACILITY_ID: t.facilityId, TITLE: t.title, TASK_TYPE: t.type, PRIORITY: t.priority, TASK_STATUS: t.status, ASSIGNED_TO: t.assigneeId, SOURCE: t.source }));
      case 'TASK_UPDATES': return this.d.taskUpdates.map((u) => ({ UPDATE_ID: u.id, TASK_ID: u.taskId, USER_ID: u.userId, OLD_STATUS: u.oldStatus, NEW_STATUS: u.newStatus, NOTE: u.note, CREATED_AT: u.createdAt }));
      case 'OPERATION_EVENTS': return w.events.map((e) => ({ FACILITY_ID: e.facilityId, SIM_TIME_S: Math.round(e.t), MESSAGE: e.text }));
      case 'AUDIT_LOG': return this.d.audit.slice().reverse().map((a) => ({ AUDIT_ID: a.id, USER_ID: a.userId, ACTION: a.action, ENTITY: a.entity, ENTITY_ID: a.entityId, FACILITY_ID: a.facilityId, DETAILS: a.details, CREATED_AT: a.at }));
      case 'SIM_STATE': return [{ STATE_ID: 1, SIM_TIME_S: Math.round(w.simTime), REAL_TIME_S: Math.round(w.realTime), SPEED: this.d.control.speed, PAUSED: this.d.control.paused ? 'Y' : 'N', NEXT_SHIPMENT: w.nextShipment, NEXT_PALLET: w.nextPallet }];
      case 'PARK_COMPANIES': return this.d.park.companies.map((c) => ({ COMPANY_ID: c.id, NAME: c.name, INDUSTRY: c.industry, CONTACT_NAME: c.contactName, CONTACT_EMAIL: c.email, PHONE: c.phone, BRAND_COLOR: c.color, IS_OPERATOR: c.isOperator ? 'Y' : 'N' }));
      case 'PARK_BUILDINGS': return this.d.park.buildings.map((b) => ({ BUILDING_ID: b.id, COMPANY_ID: b.companyId, FACILITY_ID: b.facilityId, NAME: b.name, BUILDING_KIND: b.kind, STREET: b.street, POS_X: b.x, POS_Z: b.z, WIDTH_M: b.w, DEPTH_M: b.d, FLOORS: b.floors, STAFF_COUNT: b.staff, BLDG_STATUS: b.status, LEASE_START: b.leaseStart, LEASE_END: b.leaseEnd, FLOOR_AREA_M2: Math.round(b.w * b.d * b.floors) }));
      case 'PARK_ROUTES': return Object.values(PARK_ROUTES).map((r) => ({ ROUTE_CODE: r.code, ROUTE_NAME: r.name, IS_LOOP: r.loop ? 'Y' : 'N', LENGTH_M: Math.round(r.length * 10) / 10 }));
      case 'PARK_VEHICLES': return this.d.park.vehicles.map((v) => ({ VEHICLE_ID: v.id, COMPANY_ID: v.companyId, VEHICLE_KIND: v.kind, PLATE: v.plate, COLOR_HEX: v.color, ROUTE_CODE: v.route, SPEED_KMH: v.speedKmh, ROUTE_OFFSET: v.offset, IS_ACTIVE: 'Y' }));
      case 'PARK_GATES': return Object.values(PARK_GATES).map((g) => ({ GATE_CODE: g.code, NAME: g.name, BUILDING_ID: gateBuildingId(g.code), PURPOSE: g.purpose }));
      case 'PARK_GATE_LOG': return this.d.gateLog.slice().reverse().map((g) => ({ GATE_EVENT_ID: g.id, GATE_CODE: g.op.gate, DIRECTION: g.op.direction, TRADE_TYPE: g.op.trade, TRUCK_ID: g.op.truckId, FACILITY_ID: g.op.facilityId, SHIPMENT_ID: g.op.shipmentId || null, SKU_ID: g.op.trade === 'EMPTY' ? null : g.op.skuId, PALLETS: g.op.trade === 'EMPTY' ? 0 : g.op.pallets, SIM_TIME_S: Math.round(g.op.t), CREATED_AT: g.at }));
      case 'SHIPPING_LINES': return VESSEL_LINES.map((l) => ({ LINE_CODE: l.code, NAME: l.name, OWNER_CODE: `${l.code}U` }));
      case 'PORT_BERTHS': return Object.values(w.port.berths).map((b) => ({ BERTH_CODE: b.id, NAME: b.name, BUILDING_ID: 'PB-PORT', POS_X: b.x, LENGTH_M: 90, IS_OPEN: b.open ? 'Y' : 'N', VESSEL_ID: b.vesselId }));
      case 'VESSELS': return Object.values(w.port.vessels).map((v) => ({ VESSEL_ID: v.id, NAME: v.name, LINE_CODE: v.prefix, IMO_NO: v.imo, FLAG: v.flag, HULL_COLOR: v.color, CAPACITY_BOXES: v.capacity, THROUGH_BOXES: v.through, ANCHOR_SLOT: v.slot, ORIGIN_PORT: v.origin, NEXT_PORT: v.nextPort, VESSEL_STATUS: v.status, BERTH_CODE: v.berthId, VOYAGE_NO: v.voyage, CALLS_TOTAL: v.calls, IMPORT_BOXES: v.importBoxes, EXPORT_BOXES: v.exportBoxes, EXPORT_TARGET: v.exportTarget, DISCHARGED: v.discharged, LOADED: v.loaded, ON_HOLD: v.hold ? 'Y' : 'N' }));
      case 'QUAY_CRANES': return Object.values(w.port.cranes).map((c) => ({ CRANE_ID: c.id, BERTH_CODE: c.berthId, OFFSET_M: c.offset, CRANE_PHASE: c.phase.toUpperCase(), CYCLE_PCT: Math.round(c.cycle * 1000) / 1000, MOVES_TODAY: c.movesToday }));
      case 'VESSEL_CALLS': return this.d.calls.slice().reverse().map((c) => ({ CALL_ID: c.id, VESSEL_ID: c.vesselId, VOYAGE_NO: c.voyage, BERTH_CODE: c.berthId, BOXES_DISCHARGED: c.discharged, BOXES_LOADED: c.loaded, ARRIVED_AT: c.arrivedAt, DEPARTED_AT: c.departedAt, CALL_STATUS: c.status }));
      case 'YARD_BLOCKS': return [{ BLOCK_CODE: 'IMPORT', DESCRIPTION: 'Import stack: discharged boxes waiting for a truck', CAPACITY_BOXES: YARD_CAPACITY }, { BLOCK_CODE: 'EXPORT', DESCRIPTION: 'Export stack: boxes waiting for a ship', CAPACITY_BOXES: YARD_CAPACITY }];
      case 'CONTAINER_MOVES': return this.d.moves.slice().reverse().map((m) => ({ MOVE_ID: m.id, CONTAINER_NO: m.op.containerNo, LINE_CODE: m.op.containerNo.slice(0, 3), MOVE_TYPE: m.op.move, VESSEL_ID: m.op.vesselId, BERTH_CODE: m.op.berthId, CRANE_ID: m.op.craneId, TRUCK_ID: m.op.truckId, FACILITY_ID: m.op.facilityId, SIM_TIME_S: Math.round(m.op.t), CREATED_AT: m.at }));
      case 'YARD_CONTAINERS': return [...w.port.importStack.map((n) => ({ CONTAINER_NO: n, BLOCK_CODE: 'IMPORT', LINE_CODE: n.slice(0, 3) })), ...w.port.exportStack.map((n) => ({ CONTAINER_NO: n, BLOCK_CODE: 'EXPORT', LINE_CODE: n.slice(0, 3) }))];
      case 'STORES': return Object.values(w.retail.stores).map((st) => ({ STORE_ID: st.id, BUILDING_ID: st.buildingId, COMPANY_ID: st.chain, NAME: st.name, STORE_KIND: st.kind, FACILITY_ID: st.facilityId, DELIVERIES_TODAY: st.deliveriesToday }));
      case 'STORE_STOCK': return Object.values(w.retail.stores).flatMap((st) => st.lines.map((l) => ({ STORE_ID: st.id, SKU_ID: l.skuId, UNITS: l.units, REORDER_AT: l.reorderAt, MAX_UNITS: l.maxUnits, SALES_PER_HOUR: l.salesPerHour, SOLD_TODAY: l.soldToday, STOCK_STATUS: l.units === 0 ? 'EMPTY' : l.units <= l.reorderAt ? 'REORDER' : 'OK' })));
      case 'STORE_ORDERS': return Object.values(this.d.orders).map((r) => ({ ORDER_ID: r.order.id, STORE_ID: r.order.storeId, SKU_ID: r.order.skuId, FACILITY_ID: r.order.facilityId, UNITS: r.order.units, ORDER_STATUS: r.order.status, ORDER_SOURCE: r.order.source, PLACED_BY: r.order.placedBy, VAN_ID: r.order.vanId, PLACED_AT: r.placedAt, DISPATCHED_AT: r.dispatchedAt, DELIVERED_AT: r.deliveredAt })).reverse();
      case 'DELIVERY_VANS': return Object.values(w.retail.vans).map((v) => ({ VAN_ID: v.id, FACILITY_ID: v.facilityId, VAN_KIND: v.kind, PLATE: v.plate, DRIVER_NAME: v.driver, VAN_STATUS: v.status, ORDER_ID: v.orderId, STORE_ID: v.storeId, TRIPS_TODAY: v.tripsToday }));
      default: return null;
    }
  }

  async dbOverview(): Promise<DbOverview> {
    const meta = schemaMeta();
    return {
      mode: 'memory', engine: 'In-memory development store (Oracle not connected)', schema: 'WARETRACK (from db/oracle/01_schema.sql)',
      tables: Object.values(meta.tables).map((t) => ({ name: t.name, rows: this.memRows(t.name)?.length ?? 0, group: TABLE_GROUPS[t.name] ?? 'Other', comment: t.comment })),
      objects: [
        ...meta.packages.flatMap((p) => [{ name: p, type: 'PACKAGE', status: 'NOT INSTALLED' }, { name: p, type: 'PACKAGE BODY', status: 'NOT INSTALLED' }]),
        ...meta.triggers.map((t) => ({ name: t, type: 'TRIGGER', status: 'NOT INSTALLED' })),
        ...meta.views.map((v) => ({ name: v, type: 'VIEW', status: 'NOT INSTALLED' })),
      ],
      note: 'The server is running with DB_MODE=memory. The schema below is read from the SQL scripts and the rows are the in-memory records; start Oracle (npm run db:up, npm run db:setup, npm run dev) to browse the real database and run SQL.',
    };
  }

  async dbTable(name: string): Promise<DbTableDetail> {
    const t = schemaMeta().tables[name.toUpperCase()];
    if (!t) throw new AppError(404, `Table ${name.toUpperCase()} not found`);
    const rows = (this.memRows(t.name) ?? []).slice(0, 25);
    const cols = t.columns.map((c) => c.name);
    return {
      name: t.name, columns: t.columns, constraints: t.constraints, indexes: t.indexes,
      sample: { columns: cols, rows: rows.map((r) => cols.map((c) => (r[c] === undefined ? null : r[c]))) },
    };
  }

  async runSql(): Promise<SqlResult> {
    throw new AppError(501, 'The SQL console runs on Oracle. This server was started without a database (DB_MODE=memory) — start Oracle with npm run db:up, load it with npm run db:setup, then npm run dev.');
  }

  sqlActivity() { return []; }

  // ---------------------------------------------------------------- container port and vendor stores
  async setVesselHold(userId: number, vesselId: string, hold: boolean): Promise<void> {
    const v = this.d.world?.port.vessels[vesselId];
    this.audit(userId, hold ? 'VESSEL_HELD' : 'VESSEL_RELEASED', 'VESSEL', vesselId, null, `${v?.name ?? vesselId} ${hold ? 'held by the port manager' : 'released'}`);
    this.scheduleSave();
  }

  async setBerthOpen(userId: number, berthId: string, open: boolean): Promise<void> {
    const b = this.d.world?.port.berths[berthId];
    this.audit(userId, open ? 'BERTH_OPENED' : 'BERTH_CLOSED', 'BERTH', berthId, null, `${b?.name ?? berthId} ${open ? 'reopened' : 'closed to new arrivals'}`);
    this.scheduleSave();
  }

  async placeStoreOrder(userId: number, o: NewStoreOrder): Promise<void> {
    this.d.orders[o.id] = {
      order: { id: o.id, storeId: o.storeId, facilityId: o.facilityId, skuId: o.skuId, units: o.units, status: 'PLACED', source: 'MANUAL', placedBy: userId, placedAt: o.simTime, dispatchedAt: null, deliveredAt: null, vanId: null },
      placedAt: now(), dispatchedAt: null, deliveredAt: null,
    };
    this.audit(userId, 'STORE_ORDER_PLACED', 'STORE_ORDER', o.id, o.facilityId, `${o.storeId}: ${o.units} × ${o.skuId} from ${o.facilityId}`);
    this.scheduleSave();
  }

  async cancelStoreOrder(userId: number, orderId: string): Promise<void> {
    const rec = this.d.orders[orderId];
    if (rec) rec.order.status = 'CANCELLED';
    this.audit(userId, 'STORE_ORDER_CANCELLED', 'STORE_ORDER', orderId, rec?.order.facilityId ?? null, `${orderId} cancelled`);
    this.scheduleSave();
  }

  async containerMoves(o: { limit: number; container?: string; vesselId?: string }): Promise<ContainerMoveRow[]> {
    const lines = new Map(VESSEL_LINES.map((l) => [l.code, l.name]));
    const w = this.worldOrSeed();
    return this.d.moves
      .filter((m) => (!o.container || m.op.containerNo === o.container) && (!o.vesselId || m.op.vesselId === o.vesselId))
      .slice(-o.limit).reverse()
      .map((m) => ({
        id: m.id, at: m.at, simTime: Math.round(m.op.t), containerNo: m.op.containerNo, line: lines.get(m.op.containerNo.slice(0, 3)) ?? '', move: m.op.move,
        vesselId: m.op.vesselId, vesselName: m.op.vesselId ? w.port.vessels[m.op.vesselId]?.name ?? null : null, craneId: m.op.craneId,
        truckId: m.op.truckId, facilityId: m.op.facilityId,
      }));
  }

  async vesselCalls(limit: number): Promise<VesselCallRow[]> {
    return this.d.calls.slice(-limit).reverse();
  }

  async storeOrders(o: { storeId?: string; facilities: FacilityId[]; limit: number }): Promise<StoreOrderRow[]> {
    const w = this.worldOrSeed();
    return Object.values(this.d.orders)
      .filter((r) => (!o.storeId || r.order.storeId === o.storeId) && o.facilities.includes(r.order.facilityId))
      .sort((a, b) => b.placedAt.localeCompare(a.placedAt) || b.order.id.localeCompare(a.order.id))
      .slice(0, o.limit)
      .map((r) => ({
        id: r.order.id, status: r.order.status, source: r.order.source, storeId: r.order.storeId, storeName: w.retail.stores[r.order.storeId]?.name ?? r.order.storeId,
        skuId: r.order.skuId, units: r.order.units, facilityId: r.order.facilityId, vanId: r.order.vanId,
        placedBy: r.order.placedBy ? this.user(r.order.placedBy)?.username ?? null : null,
        placedAt: r.placedAt, dispatchedAt: r.dispatchedAt, deliveredAt: r.deliveredAt,
      }));
  }

  async liveCounts(tables: string[]): Promise<Record<string, number>> {
    return Object.fromEntries(tables.map((t) => [t, this.memRows(t)?.length ?? 0]));
  }

  async liveRow(table: string, key: string, id: string): Promise<DbLiveRow | null> {
    const t0 = performance.now();
    const found = (this.memRows(table) ?? []).find((r) => String(r[key] ?? r.ID) === id);
    if (!found) return null;
    const row = key in found ? found : { [key]: found.ID, ...found };
    const cols = schemaMeta().tables[table]?.columns.map((c) => c.name).filter((c) => c in row) ?? Object.keys(row);
    return {
      engine: 'memory', table, key, id, sql: `SELECT * FROM ${table.toLowerCase()} WHERE ${key.toLowerCase()} = :id`,
      fetchedAt: new Date().toISOString(), ms: Math.round((performance.now() - t0) * 10) / 10,
      columns: cols, values: cols.map((c) => (row[c] === undefined ? null : row[c])),
    };
  }
}
