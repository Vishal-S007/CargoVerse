// API endpoints. Every route checks the caller's role permissions and facility access
// before calling the repository (which enforces the same rules again in Oracle).
import type { IncomingMessage } from 'node:http';
import type { FacilityId } from '../src/data/types';
import type { SessionUser, TaskStatus, TaskType, Priority, Role, SimControl } from '../src/api/types';
import { AppError, type Repo, LIVE_COUNT_TABLES, LIVE_ROW_TABLES } from './db/repo';
import { config } from './config';
import { Router, send, str, oneOf, int, type Ctx } from './http';
import { hashPassword, verifyPassword, validatePassword, newSessionId, signToken, readToken } from './auth';
import type { SimHost } from './simhost';
import { savedQueries } from './db/schema-meta';
import type { BuildingStatus } from '../src/data/park';
import { placeOrder, hasOpenOrder, chooseSupplier } from '../src/sim/retail';
import { portLog } from '../src/sim/port';
import { computeAlerts, taskFromAlert, runAssistant, assistantConfigured, type ChatTurn } from './agent';

const FACILITIES: FacilityId[] = ['WH-01', 'WH-02', 'WH-04'];
const TASK_TYPES: TaskType[] = ['UNLOAD', 'LOAD', 'PUTAWAY', 'CYCLE_COUNT', 'MAINTENANCE', 'DOCK_CHECK', 'OTHER'];
const PRIORITIES: Priority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const STATUSES: TaskStatus[] = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'];
const ROLES: Role[] = ['ADMIN', 'MANAGER', 'OPERATOR'];

interface Opts { secret: string; rememberDays: number; shortHours: number; streamEveryMs: number }

export function buildRouter(repo: Repo, host: SimHost, opts: Opts): Router {
  // ------------------------------------------------------------ sessions (cached)
  const sessionCache = new Map<string, { userId: number; expires: number; remember: boolean; checked: number; extended: number }>();
  const userCache = new Map<number, { user: SessionUser; at: number }>();
  const invalidateUser = (id: number) => userCache.delete(id);

  async function authenticate(req: IncomingMessage, url: URL) {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
    const sid = readToken(token, opts.secret);
    if (!sid) return null;
    const now = Date.now();
    let s = sessionCache.get(sid);
    if (!s || now - s.checked > 30000) {
      const row = await repo.getSession(sid);
      if (!row || row.revoked) { sessionCache.delete(sid); return null; }
      s = { userId: row.userId, expires: row.expiresAt.getTime(), remember: row.remember, checked: now, extended: s?.extended ?? 0 };
      sessionCache.set(sid, s);
    }
    if (s.expires < now) return null;
    // keep "remember me" sessions alive while they are used (renewed at most hourly)
    if (s.remember && now - s.extended > 3600000) {
      s.extended = now;
      s.expires = now + opts.rememberDays * 86400000;
      void repo.extendSession(sid, opts.rememberDays).catch(() => undefined);
    }
    let u = userCache.get(s.userId);
    if (!u || now - u.at > 15000) {
      const user = await repo.sessionUser(s.userId);
      if (!user) { sessionCache.delete(sid); return null; }
      u = { user, at: now };
      userCache.set(s.userId, u);
    }
    return { user: u.user, sessionId: sid };
  }

  const router = new Router(authenticate);
  const failures = new Map<string, { n: number; first: number }>();

  const facilityScope = (user: SessionUser, requested: string | null): FacilityId[] => {
    if (!requested) return user.facilities;
    const f = requested as FacilityId;
    if (!user.facilities.includes(f)) throw new AppError(403, `You do not have access to ${requested}`);
    return [f];
  };

  // ------------------------------------------------------------ auth
  router.add('POST', '/api/auth/login', async (ctx) => {
    const username = str(ctx.body?.username, 'Username', { max: 40 }).toLowerCase();
    const password = str(ctx.body?.password, 'Password', { max: 200 });
    const remember = ctx.body?.remember !== false;
    const key = `${username}|${ctx.ip}`;
    const f = failures.get(key);
    if (f && f.n >= 5 && Date.now() - f.first < 300000) throw new AppError(429, 'Too many failed attempts. Try again in a few minutes.');
    const login = await repo.findLogin(username);
    const passwordOk = !!login && verifyPassword(password, login.passwordHash);
    const ok = passwordOk && !!login && login.active;
    await repo.recordLogin(login?.userId ?? null, username, ok);
    host.bump('audit');
    if (!ok || !login) {
      const cur = failures.get(key);
      failures.set(key, cur && Date.now() - cur.first < 300000 ? { n: cur.n + 1, first: cur.first } : { n: 1, first: Date.now() });
      // only reveal that an account is deactivated to someone who knows its password
      throw new AppError(401, passwordOk && login && !login.active ? 'This account has been deactivated. Contact your administrator.' : 'Wrong username or password');
    }
    failures.delete(key);
    const sid = newSessionId();
    const days = remember ? opts.rememberDays : opts.shortHours / 24;
    await repo.createSession(sid, login.userId, days, String(ctx.req.headers['user-agent'] ?? '').slice(0, 200));
    const user = await repo.sessionUser(login.userId);
    return { token: signToken(sid, opts.secret), user };
  }, { auth: false });

  router.add('POST', '/api/auth/logout', async (ctx) => {
    if (ctx.sessionId) { await repo.revokeSession(ctx.sessionId); sessionCache.delete(ctx.sessionId); host.bump('audit'); }
    return { ok: true };
  });

  router.add('GET', '/api/auth/me', (ctx) => ({ user: ctx.user }));

  router.add('GET', '/api/health', () => ({ ok: true, db: repo.kind }), { auth: false });

  router.add('GET', '/api/meta', async () => ({
    roles: await repo.listRoles(), jobTitles: await repo.listJobTitles(), db: repo.kind,
  }));

  // ------------------------------------------------------------ live stream (Server-Sent Events)
  router.add('GET', '/api/stream', (ctx) => {
    const user = ctx.user!;
    const res = ctx.res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const push = () => res.write(`event: snapshot\ndata: ${host.snapshot(user.facilities)}\n\n`);
    push();
    const timer = setInterval(push, opts.streamEveryMs);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    ctx.req.on('close', () => { clearInterval(timer); clearInterval(ping); });
    return new Promise<void>(() => undefined); // keep the response open
  });

  // ------------------------------------------------------------ operations control
  router.add('POST', '/api/sim/control', async (ctx) => {
    const next: SimControl = { ...host.control };
    if (ctx.body?.paused !== undefined) next.paused = !!ctx.body.paused;
    if (ctx.body?.speed !== undefined) next.speed = Number(oneOf(String(ctx.body.speed), 'speed', ['1', '2', '4']));
    await repo.saveControl(next, ctx.user!.userId);
    host.setControl(next);
    host.bump('audit');
    return next;
  }, { perm: 'CONTROL_SIMULATION' });

  // ------------------------------------------------------------ tasks
  router.add('GET', '/api/tasks', async (ctx) => {
    const u = ctx.user!;
    const facilities = facilityScope(u, ctx.query.get('facility'));
    const closed = ctx.query.get('closed') === '1';
    const mine = ctx.query.get('scope') === 'mine' || !u.permissions.includes('MANAGE_TASKS');
    if (mine && !u.permissions.includes('UPDATE_OWN_TASKS')) throw new AppError(403, 'Not permitted');
    return repo.listTasks({ facilities, assigneeId: mine ? u.employeeId : undefined, includeClosed: closed, limit: 300 });
  });

  router.add('POST', '/api/tasks', async (ctx) => {
    const b = ctx.body ?? {};
    const u = ctx.user!;
    const facilityId = oneOf(b.facilityId, 'facilityId', FACILITIES);
    facilityScope(u, facilityId);
    const id = await repo.createTask(u.userId, {
      facilityId,
      title: str(b.title, 'Title', { min: 3, max: 160 }),
      description: str(b.description, 'Description', { optional: true, max: 1000 }),
      type: oneOf(b.type, 'type', TASK_TYPES),
      priority: oneOf(b.priority ?? 'NORMAL', 'priority', PRIORITIES),
      assigneeId: int(b.assigneeId, 'assigneeId', { optional: true, min: 1 }),
      truckId: b.truckId ? str(b.truckId, 'truckId', { max: 20 }) : null,
      dockId: b.dockId ? str(b.dockId, 'dockId', { max: 20 }) : null,
      dueMinutes: int(b.dueMinutes, 'dueMinutes', { optional: true, min: 1, max: 60 * 24 * 14 }),
      source: 'MANUAL',
    });
    host.bump('tasks'); host.bump('audit');
    return repo.getTask(id);
  }, { perm: 'MANAGE_TASKS' });

  router.add('GET', '/api/tasks/:id/updates', async (ctx) => {
    const id = int(ctx.params.id, 'id')!;
    const task = await repo.getTask(id);
    if (!task) throw new AppError(404, 'Task not found');
    const u = ctx.user!;
    facilityScope(u, task.facilityId);
    if (!u.permissions.includes('MANAGE_TASKS') && task.assigneeId !== u.employeeId) throw new AppError(403, 'Not permitted');
    return repo.taskUpdates(id);
  });

  router.add('PATCH', '/api/tasks/:id/status', async (ctx) => {
    const id = int(ctx.params.id, 'id')!;
    const status = oneOf(ctx.body?.status, 'status', STATUSES);
    const note = ctx.body?.note ? str(ctx.body.note, 'Note', { max: 1000 }) : null;
    if (status === 'BLOCKED' && !note) throw new AppError(400, 'Please say what is blocking the task');
    await repo.changeTaskStatus(ctx.user!.userId, id, status, note);
    host.bump('tasks'); host.bump('audit');
    return repo.getTask(id);
  }, { perm: 'UPDATE_OWN_TASKS' });

  router.add('PATCH', '/api/tasks/:id/assign', async (ctx) => {
    const id = int(ctx.params.id, 'id')!;
    const assignee = int(ctx.body?.assigneeId, 'assigneeId', { min: 1 })!;
    const note = ctx.body?.note ? str(ctx.body.note, 'Note', { max: 1000 }) : null;
    await repo.assignTask(ctx.user!.userId, id, assignee, note);
    host.bump('tasks'); host.bump('audit');
    return repo.getTask(id);
  }, { perm: 'MANAGE_TASKS' });

  // ------------------------------------------------------------ people
  router.add('GET', '/api/employees', async (ctx) => {
    const u = ctx.user!;
    const facilities = facilityScope(u, ctx.query.get('facility'));
    const all = u.permissions.includes('VIEW_ALL_FACILITIES') && !ctx.query.get('facility');
    return repo.listEmployees(all ? null : facilities);
  }, { perm: 'VIEW_TEAM' });

  router.add('GET', '/api/users', () => repo.listUsers(), { perm: 'MANAGE_USERS' });

  router.add('POST', '/api/users', async (ctx) => {
    const b = ctx.body ?? {};
    const password = str(b.password, 'Password', { max: 200 });
    const pwErr = validatePassword(password);
    if (pwErr) throw new AppError(400, pwErr);
    const username = str(b.username, 'Username', { min: 3, max: 40 }).toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(username)) throw new AppError(400, 'Username may contain only letters, digits, dot, dash and underscore');
    const email = str(b.email, 'Email', { max: 120 });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError(400, 'Email address is not valid');
    const facilities = Array.isArray(b.facilities) ? b.facilities.map((f: unknown) => oneOf(f, 'facility', FACILITIES)) : [];
    const id = await repo.createUser(ctx.user!.userId, {
      username, passwordHash: hashPassword(password), role: oneOf(b.role, 'role', ROLES),
      fullName: str(b.fullName, 'Full name', { min: 2, max: 80 }), email, phone: b.phone ? str(b.phone, 'Phone', { max: 30 }) : null,
      jobCode: str(b.jobCode, 'Job title', { max: 30 }), homeFacility: b.homeFacility ? oneOf(b.homeFacility, 'homeFacility', FACILITIES) : null,
      facilities,
    });
    host.bump('audit');
    return (await repo.listUsers()).find((x) => x.id === id);
  }, { perm: 'MANAGE_USERS' });

  router.add('PATCH', '/api/users/:id', async (ctx) => {
    const id = int(ctx.params.id, 'id')!;
    const b = ctx.body ?? {};
    let passwordHash: string | undefined;
    if (b.password) {
      const err = validatePassword(String(b.password));
      if (err) throw new AppError(400, err);
      passwordHash = hashPassword(String(b.password));
    }
    await repo.updateUser(ctx.user!.userId, id, {
      role: b.role === undefined ? undefined : oneOf(b.role, 'role', ROLES),
      active: b.active === undefined ? undefined : !!b.active,
      facilities: Array.isArray(b.facilities) ? b.facilities.map((f: unknown) => oneOf(f, 'facility', FACILITIES)) : undefined,
      passwordHash,
    });
    invalidateUser(id);
    if (b.active === false) for (const [sid, s] of sessionCache) if (s.userId === id) sessionCache.delete(sid);
    host.bump('audit');
    return (await repo.listUsers()).find((x) => x.id === id);
  }, { perm: 'MANAGE_USERS' });

  // ------------------------------------------------------------ history & reports
  router.add('GET', '/api/audit', async (ctx) => {
    const u = ctx.user!;
    const requested = ctx.query.get('facility');
    const all = u.permissions.includes('VIEW_ALL_FACILITIES') && !requested;
    return repo.listAudit({
      facilities: all ? null : facilityScope(u, requested),
      limit: int(ctx.query.get('limit') ?? 100, 'limit', { min: 1, max: 500 })!,
      beforeId: int(ctx.query.get('before'), 'before', { optional: true }) ?? undefined,
    });
  }, { perm: 'VIEW_AUDIT' });

  router.add('GET', '/api/reports/kpis', async (ctx) => repo.kpis(facilityScope(ctx.user!, ctx.query.get('facility'))), { perm: 'VIEW_REPORTS' });
  router.add('GET', '/api/reports/workload', async (ctx) => repo.workload(facilityScope(ctx.user!, ctx.query.get('facility'))), { perm: 'VIEW_REPORTS' });
  router.add('GET', '/api/reports/low-stock', async (ctx) => repo.lowStock(facilityScope(ctx.user!, ctx.query.get('facility'))), { perm: 'VIEW_REPORTS' });

  // ------------------------------------------------------------ logistics park (tenants, buildings, gates, imports / exports)
  // The park map and directory are visible to every signed-in user; changes need MANAGE_PARK.
  router.add('GET', '/api/park', () => repo.park());

  router.add('PATCH', '/api/park/buildings/:id', async (ctx) => {
    const b = ctx.body ?? {};
    const leaseEnd = b.leaseEnd === undefined || b.leaseEnd === null || b.leaseEnd === '' ? undefined : str(b.leaseEnd, 'Lease end', { max: 10 });
    if (leaseEnd && !/^\d{4}-\d{2}-\d{2}$/.test(leaseEnd)) throw new AppError(400, 'Lease end must be a date (YYYY-MM-DD)');
    await repo.updateBuilding(ctx.user!.userId, str(ctx.params.id, 'id', { max: 20 }), {
      status: b.status === undefined ? undefined : oneOf<BuildingStatus>(b.status, 'status', ['OPERATING', 'MAINTENANCE', 'VACANT', 'CONSTRUCTION']),
      staff: int(b.staff, 'staff', { optional: true, min: 0, max: 99999 }) ?? undefined,
      leaseEnd,
    });
    host.bump('audit');
    return (await repo.park()).buildings.find((x) => x.id === ctx.params.id);
  }, { perm: 'MANAGE_PARK' });

  router.add('GET', '/api/park/gate-log', async (ctx) =>
    repo.gateLog(facilityScope(ctx.user!, ctx.query.get('facility')), int(ctx.query.get('limit') ?? 60, 'limit', { min: 1, max: 500 })!));
  router.add('GET', '/api/park/trade', async (ctx) => repo.trade(facilityScope(ctx.user!, ctx.query.get('facility'))));

  // ------------------------------------------------------------ container port
  router.add('GET', '/api/port/moves', async (ctx) => {
    const box = ctx.query.get('container');
    const vessel = ctx.query.get('vessel');
    return repo.containerMoves({
      limit: int(ctx.query.get('limit') ?? '60', 'limit', { min: 1, max: 500 })!,
      container: box ? str(box, 'container', { max: 11 }).toUpperCase() : undefined,
      vesselId: vessel ? str(vessel, 'vessel', { max: 10 }) : undefined,
    });
  });
  router.add('GET', '/api/port/calls', async (ctx) => repo.vesselCalls(int(ctx.query.get('limit') ?? '30', 'limit', { min: 1, max: 200 })!));
  router.add('POST', '/api/port/vessels/:id/hold', async (ctx) => {
    const v = host.world.port.vessels[ctx.params.id];
    if (!v) throw new AppError(404, 'Vessel not found');
    const hold = !!ctx.body?.hold;
    if (v.hold === hold) throw new AppError(409, `${v.name} is ${hold ? 'already on hold' : 'not on hold'}`);
    await repo.setVesselHold(ctx.user!.userId, v.id, hold);
    v.hold = hold;
    portLog(host.world, `${v.name} ${hold ? 'held by' : 'released by'} ${ctx.user!.fullName}`, { kind: 'vessel', id: v.id });
    host.bump('audit');
    return v;
  }, { perm: 'MANAGE_PORT' });
  router.add('POST', '/api/port/berths/:id/open', async (ctx) => {
    const P = host.world.port;
    const b = P.berths[ctx.params.id];
    if (!b) throw new AppError(404, 'Berth not found');
    const open = !!ctx.body?.open;
    if (b.open === open) throw new AppError(409, `${b.name} is already ${open ? 'open' : 'closed'}`);
    if (!open && !Object.values(P.berths).some((x) => x.id !== b.id && x.open)) throw new AppError(400, 'At least one berth must stay open');
    await repo.setBerthOpen(ctx.user!.userId, b.id, open);
    b.open = open;
    portLog(host.world, `${b.name} ${open ? 'reopened' : 'closed to new arrivals'} by ${ctx.user!.fullName}`, { kind: 'berth', id: b.id });
    host.bump('audit');
    return b;
  }, { perm: 'MANAGE_PORT' });

  // ------------------------------------------------------------ vendor stores
  router.add('GET', '/api/retail/orders', async (ctx) => {
    const store = ctx.query.get('store');
    return repo.storeOrders({
      storeId: store ? str(store, 'store', { max: 8 }) : undefined,
      facilities: ctx.user!.facilities,
      limit: int(ctx.query.get('limit') ?? '40', 'limit', { min: 1, max: 300 })!,
    });
  });
  router.add('POST', '/api/retail/orders', async (ctx) => {
    const w = host.world;
    const st = w.retail.stores[str(ctx.body?.storeId, 'storeId', { max: 8 })];
    if (!st) throw new AppError(404, 'Store not found');
    const skuId = str(ctx.body?.skuId, 'skuId', { max: 20 });
    const line = st.lines.find((l) => l.skuId === skuId);
    if (!line) throw new AppError(400, `${st.name} does not stock ${skuId}`);
    const units = int(ctx.body?.units, 'units', { min: 1, max: line.maxUnits * 2 })!;
    if (hasOpenOrder(w, st.id, skuId)) throw new AppError(409, `${st.name} already has an open order for this product`);
    const wanted = ctx.body?.facilityId ? oneOf(ctx.body.facilityId, 'facilityId', FACILITIES) : null;
    const facilityId = wanted ?? chooseSupplier(w, st.facilityId, skuId, units);
    if (!facilityId) throw new AppError(400, 'No warehouse has enough stock for this order');
    facilityScope(ctx.user!, facilityId);
    const have = w.facilities[facilityId]?.inventory.find((l) => l.skuId === skuId)?.units ?? 0;
    if (have < units) throw new AppError(400, `${facilityId} has only ${have} units of ${skuId}`);
    const id = `SO-${w.retail.nextOrder++}`;
    await repo.placeStoreOrder(ctx.user!.userId, { id, storeId: st.id, skuId, units, facilityId, simTime: w.simTime });
    const order = placeOrder(w, { id, storeId: st.id, skuId, units, facilityId, source: 'MANUAL', placedBy: ctx.user!.userId });
    host.bump('audit');
    return order;
  }, { perm: 'MANAGE_RETAIL' });
  router.add('POST', '/api/retail/orders/:id/cancel', async (ctx) => {
    const o = host.world.retail.orders[ctx.params.id];
    if (!o) throw new AppError(404, 'Order not found (or already finished)');
    facilityScope(ctx.user!, o.facilityId);
    if (o.status !== 'PLACED') throw new AppError(409, `Only orders that are not yet loaded can be cancelled (this one is ${o.status})`);
    await repo.cancelStoreOrder(ctx.user!.userId, o.id);
    o.status = 'CANCELLED';
    host.bump('audit');
    return o;
  }, { perm: 'MANAGE_RETAIL' });

  // ------------------------------------------------------------ database workspace
  router.add('GET', '/api/db/overview', () => repo.dbOverview(), { perm: 'VIEW_DATABASE' });
  router.add('GET', '/api/db/tables/:name', async (ctx) => {
    const name = str(ctx.params.name, 'table', { max: 60 });
    if (!/^[A-Za-z][A-Za-z0-9_$#]*$/.test(name)) throw new AppError(400, 'Not a table name');
    return repo.dbTable(name);
  }, { perm: 'VIEW_DATABASE' });
  router.add('GET', '/api/db/queries', () => savedQueries(), { perm: 'VIEW_DATABASE' });
  router.add('POST', '/api/db/sql', async (ctx) => {
    const r = await repo.runSql(ctx.user!.userId, str(ctx.body?.sql, 'SQL', { max: 20000 }));
    host.bump('audit');
    return r;
  }, { perm: 'RUN_SQL' });
  router.add('GET', '/api/db/activity', (ctx) => {
    const all = repo.sqlActivity();
    return ctx.query.get('source') === 'all' ? all : all.filter((a) => a.source === 'api');
  }, { perm: 'RUN_SQL' });

  // ------------------------------------------------------------ live database feed (every signed-in user)
  // Row counts are read from the database at most once a second, however many browsers are polling.
  let countsCache: { at: number; iso: string; counts: Record<string, number> } | null = null;
  let countsPending: Promise<void> | null = null;
  const liveCounts = async () => {
    if (!countsCache || Date.now() - countsCache.at > 1000) {
      countsPending ??= repo.liveCounts(LIVE_COUNT_TABLES)
        .then((counts) => { countsCache = { at: Date.now(), iso: new Date().toISOString(), counts }; })
        .finally(() => { countsPending = null; });
      await countsPending;
    }
    return countsCache!;
  };
  router.add('GET', '/api/db/live', async (ctx) => {
    const c = await liveCounts();
    const canSee = ctx.user!.permissions.includes('VIEW_DATABASE');
    return {
      status: host.db,
      target: repo.kind === 'oracle' ? `${config.oracle.user}@${config.oracle.connectString}` : 'in-memory development store',
      commits: host.commits.slice().reverse(),
      counts: c.counts, countsAt: c.iso,
      statements: canSee ? repo.sqlActivity().filter((a) => a.source !== 'live').slice(0, 40) : [],
    };
  });
  router.add('GET', '/api/db/row/:kind/:id', async (ctx) => {
    const map = LIVE_ROW_TABLES[String(ctx.params.kind)];
    if (!map) throw new AppError(404, 'This item is not stored as a single row');
    const id = str(ctx.params.id, 'id', { max: 40 });
    const row = await repo.liveRow(map.table, map.key, id);
    if (!row) throw new AppError(404, `No row in ${map.table} with ${map.key} = ${id}`);
    const fi = row.columns.indexOf('FACILITY_ID');
    const fac = fi >= 0 ? row.values[fi] : null;
    if (fac && !ctx.user!.facilities.includes(fac as FacilityId)) throw new AppError(403, `You do not have access to ${String(fac)}`);
    return row;
  });

  // ------------------------------------------------------------ AI agents: exception watcher + assistant
  router.add('GET', '/api/alerts', async (ctx) => computeAlerts(host.world, repo, facilityScope(ctx.user!, ctx.query.get('facility'))), { perm: 'VIEW_TEAM' });

  router.add('POST', '/api/alerts/task', async (ctx) => {
    const id = str(ctx.body?.alertId, 'alertId', { max: 120 });
    const task = await taskFromAlert(host.world, repo, ctx.user!, id, int(ctx.body?.assigneeId, 'assigneeId', { optional: true, min: 1 }));
    host.bump('tasks'); host.bump('audit');
    return task;
  }, { perm: 'MANAGE_TASKS' });

  router.add('GET', '/api/assistant/status', () => ({ configured: assistantConfigured(), model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5' }));

  const askTimes = new Map<number, number[]>();
  router.add('POST', '/api/assistant', async (ctx) => {
    const u = ctx.user!;
    const now = Date.now();
    const recent = (askTimes.get(u.userId) ?? []).filter((t) => now - t < 60000);
    if (recent.length >= 12) throw new AppError(429, 'Too many questions in a minute — please wait a moment.');
    askTimes.set(u.userId, [...recent, now]);
    const raw = Array.isArray(ctx.body?.messages) ? ctx.body.messages : [];
    const history: ChatTurn[] = raw
      .filter((m: { role?: string; content?: unknown }) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map((m: { role: 'user' | 'assistant'; content: string }) => ({ role: m.role, content: m.content }));
    const fac = (ctx.body?.facilityId as FacilityId) ?? u.facilities[0];
    return runAssistant(host, repo, u, history, fac);
  }, { perm: 'VIEW_DASHBOARD' });

  return router;
}

export { send };
export type { Ctx };
