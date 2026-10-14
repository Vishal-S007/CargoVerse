// AI operations agents.
//  1. Exception watcher — scans live operations for problems (late shipments, forklifts low
//     on battery mid-job, trucks stuck at the gate, low stock, blocked tasks) and proposes a task.
//  2. Operations assistant — answers questions in plain language using Claude with tool use.
//     Tools read the same data the dashboard shows and respect the caller's role and sites.
// The Anthropic API key stays on the server (ANTHROPIC_API_KEY); the browser never sees it.
import type { FacilityId, EntityRef, WorldState } from '../src/data/types';
import type { SessionUser, TaskType, Priority, Task } from '../src/api/types';
import { SKUS, carrierName } from '../src/data/seed';
import {
  kpis, facilityHeadline, deliveryWatch, truckView, forkliftView, forkliftActivity, truckBadge, search, dockStatus, fmtClock,
} from '../src/ui/derive';
import { AppError, type Repo } from './db/repo';
import type { SimHost } from './simhost';

// ---------------------------------------------------------------- exception watcher

export interface Alert {
  id: string;
  facilityId: FacilityId;
  severity: 'high' | 'medium' | 'low';
  kind: 'late_shipment' | 'low_battery' | 'gate_wait' | 'low_stock' | 'blocked_task';
  title: string;
  detail: string;
  ref: EntityRef | null;
  suggestion: { title: string; description: string; type: TaskType; priority: Priority; truckId?: string; dockId?: string; jobCode: string } | null;
}

const SEV_ORDER = { high: 0, medium: 1, low: 2 };

export async function computeAlerts(w: WorldState, repo: Repo, facilities: FacilityId[]): Promise<Alert[]> {
  const out: Alert[] = [];
  for (const fac of facilities) {
    const f = w.facilities[fac];
    if (!f) continue;
    for (const d of deliveryWatch(w, fac)) {
      if (d.label !== 'At risk') continue;
      const t = w.trucks[d.truckId];
      out.push({
        id: `late_shipment:${d.id}`, facilityId: fac, severity: 'high', kind: 'late_shipment',
        title: `Shipment #${d.id} may miss its promised time`, detail: `${d.truckId} · ${d.text}`,
        ref: { kind: 'truck', id: d.truckId },
        suggestion: {
          title: `Expedite ${d.truckId} (#${d.id})`, type: 'DOCK_CHECK', priority: 'URGENT', truckId: d.truckId, dockId: t?.dockId ?? undefined,
          description: `Shipment #${d.id} is running late (${d.text}). Free up a forklift or dock and notify the customer if it will still miss the window.`,
          jobCode: 'DOCK_SUPERVISOR',
        },
      });
    }
    for (const fl of Object.values(w.forklifts)) {
      if (fl.facilityId !== fac || !fl.truckId || fl.battery >= 30) continue;
      out.push({
        id: `low_battery:${fl.id}`, facilityId: fac, severity: fl.battery < 20 ? 'high' : 'medium', kind: 'low_battery',
        title: `${fl.id} is at ${Math.round(fl.battery)}% battery mid-job`, detail: forkliftActivity(w, fl).text,
        ref: { kind: 'forklift', id: fl.id },
        suggestion: {
          title: `Swap in a charged forklift for ${fl.id}`, type: 'MAINTENANCE', priority: 'HIGH', truckId: fl.truckId,
          description: `${fl.id} is below 30% while working on ${fl.truckId}. Send it to charger ${fl.chargerId.split('-').pop()} after this pallet and hand the job to a charged forklift.`,
          jobCode: 'FORKLIFT_OPERATOR',
        },
      });
    }
    for (const t of Object.values(w.trucks)) {
      if (t.facilityId !== fac || t.phase !== 'at_gate') continue;
      out.push({
        id: `gate_wait:${t.id}`, facilityId: fac, severity: 'medium', kind: 'gate_wait',
        title: `${t.id} is waiting at the gate`, detail: t.dockId ? `Booked for ${w.docks[t.dockId]?.name} — yard lane busy` : 'No free dock for its direction',
        ref: { kind: 'truck', id: t.id },
        suggestion: {
          title: `Clear a dock for ${t.id}`, type: 'DOCK_CHECK', priority: 'HIGH', truckId: t.id, dockId: t.dockId ?? undefined,
          description: `${t.id} (${carrierName(t.carrier)}) is held at the gate. Check which dock can be freed first and guide the truck in.`,
          jobCode: 'DOCK_SUPERVISOR',
        },
      });
    }
    for (const l of f.inventory) {
      if (l.units >= l.lowBelow) continue;
      const name = SKUS[l.skuId]?.name ?? l.skuId;
      out.push({
        id: `low_stock:${fac}:${l.skuId}`, facilityId: fac, severity: l.units < l.lowBelow * 0.5 ? 'high' : 'low', kind: 'low_stock',
        title: `${name} is below its reorder level`, detail: `${l.units.toLocaleString()} units on hand, reorder at ${l.lowBelow.toLocaleString()}`,
        ref: null,
        suggestion: {
          title: `Reorder ${name}`, type: 'CYCLE_COUNT', priority: 'NORMAL',
          description: `Count ${name} on hand at ${f.name}, confirm the shortfall against the system (${l.units} units vs reorder level ${l.lowBelow}) and raise a replenishment order.`,
          jobCode: 'INVENTORY_CLERK',
        },
      });
    }
  }
  const blocked = (await repo.listTasks({ facilities, includeClosed: false, limit: 200 })).filter((t) => t.status === 'BLOCKED');
  for (const t of blocked) {
    out.push({
      id: `blocked_task:${t.id}`, facilityId: t.facilityId, severity: t.priority === 'URGENT' || t.priority === 'HIGH' ? 'high' : 'medium',
      kind: 'blocked_task', title: `Task blocked: ${t.title}`, detail: `${t.assigneeName ?? 'Unassigned'} — “${t.lastNote ?? 'no reason given'}”`,
      ref: t.truckId ? { kind: 'truck', id: t.truckId } : null, suggestion: null,
    });
  }
  return out.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
}

/** Creates the suggested task for an alert, assigned to someone with the matching job at that site. */
export async function taskFromAlert(w: WorldState, repo: Repo, user: SessionUser, alertId: string, assigneeId: number | null): Promise<Task | null> {
  const alerts = await computeAlerts(w, repo, user.facilities);
  const a = alerts.find((x) => x.id === alertId);
  if (!a) throw new AppError(404, 'This alert has already cleared');
  if (!a.suggestion) throw new AppError(400, 'This alert has no suggested task');
  let assignee = assigneeId;
  if (assignee === null) {
    const staff = (await repo.listEmployees([a.facilityId])).filter((e) => e.status === 'ACTIVE' && e.jobCode === a.suggestion!.jobCode);
    staff.sort((x, y) => x.openTasks - y.openTasks);
    assignee = staff[0]?.id ?? null;
  }
  const id = await repo.createTask(user.userId, {
    facilityId: a.facilityId, title: a.suggestion.title, description: `${a.suggestion.description}\n\nRaised from alert: ${a.title}.`,
    type: a.suggestion.type, priority: a.suggestion.priority, assigneeId: assignee, truckId: a.suggestion.truckId ?? null,
    dockId: a.suggestion.dockId ?? null, dueMinutes: a.severity === 'high' ? 20 : 60, source: 'MANUAL',
  });
  return repo.getTask(id);
}

// ---------------------------------------------------------------- operations assistant (Claude tool use)

export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export interface AssistantReply { reply: string; actions: { type: 'focus'; ref: EntityRef }[]; tools: string[] }

interface ToolDef { name: string; description: string; input_schema: Record<string, unknown>; perm?: SessionUser['permissions'][number] }

const FAC_PROP = { facility_id: { type: 'string', enum: ['WH-01', 'WH-02', 'WH-04'], description: 'Site id. Omit to use the site the user is looking at.' } };

const TOOLS: ToolDef[] = [
  { name: 'get_site_overview', description: 'Get the live KPIs for a site: stock on hand vs capacity, trucks on site and inbound, on-time delivery rate, docks in use, outbound trucks and put-aways today, and inventory lines with their reorder levels. Use this first for any general question about how a site is doing.', input_schema: { type: 'object', properties: FAC_PROP } },
  { name: 'list_trucks', description: 'List every truck assigned to a site with its status (en route, at gate, docking, loading/unloading, departing, in transit), dock, cargo progress, shipment and ETA. Use for questions about trucks, docks or arrivals.', input_schema: { type: 'object', properties: FAC_PROP } },
  { name: 'get_truck', description: 'Get full details for one truck by id (e.g. TRK-2051): carrier, driver, status, shipment, customer, destination, ETA, speed, dock and cargo.', input_schema: { type: 'object', properties: { truck_id: { type: 'string' } }, required: ['truck_id'] } },
  { name: 'list_forklifts', description: 'List the forklifts at a site with their operator, battery level, current job and moves today.', input_schema: { type: 'object', properties: FAC_PROP } },
  { name: 'list_alerts', description: 'Get the current exceptions found by the exception watcher: shipments at risk of being late, forklifts low on battery mid-job, trucks waiting at the gate, products below reorder level and blocked tasks, each with a suggested task.', input_schema: { type: 'object', properties: FAC_PROP } },
  { name: 'list_tasks', description: 'List open tasks (or all, including closed) at a site with assignee, status, priority and the latest note. Set mine=true to list only the signed-in user\'s tasks.', input_schema: { type: 'object', properties: { ...FAC_PROP, mine: { type: 'boolean' }, include_closed: { type: 'boolean' } } } },
  { name: 'list_team', description: 'List staff at a site with job titles, login roles, forklifts they drive and how many open tasks each has. Use before assigning work.', input_schema: { type: 'object', properties: FAC_PROP }, perm: 'VIEW_TEAM' },
  { name: 'search', description: 'Search trucks, forklifts, pallets, docks, chargers, shipments and sites by id, name, product, customer or driver.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  {
    name: 'create_task', perm: 'MANAGE_TASKS',
    description: 'Create a task and assign it to an employee. Only call this when the user has clearly asked for a task to be created or assigned; otherwise suggest it. Use list_team first to find the right employee_id.',
    input_schema: {
      type: 'object', required: ['facility_id', 'title', 'type', 'priority'],
      properties: {
        ...FAC_PROP, title: { type: 'string' }, description: { type: 'string' },
        type: { type: 'string', enum: ['UNLOAD', 'LOAD', 'PUTAWAY', 'CYCLE_COUNT', 'MAINTENANCE', 'DOCK_CHECK', 'OTHER'] },
        priority: { type: 'string', enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] },
        assignee_employee_id: { type: 'integer' }, truck_id: { type: 'string' }, dock_id: { type: 'string' }, due_minutes: { type: 'integer' },
      },
    },
  },
  { name: 'get_imports_exports', description: 'Goods through the park gates: imports (trucks bringing goods in through the West Gate) and exports (trucks taking goods out through the East Gate) per site today, plus the latest gate movements with product and pallets. Use for questions about imports, exports, the gates or goods flow.', input_schema: { type: 'object', properties: { ...FAC_PROP, limit: { type: 'number' } } } },
  { name: 'list_park_tenants', description: 'List the companies and buildings in the Harborside Logistics Park (plants, warehouses, offices, cold store, fuel station, container terminal) with status, staff and lease end.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_port_status', description: 'The Port Newark container terminal right now: every ship (status, berth, boxes still to discharge, boxes loaded), the berths and quay cranes, and how many containers wait in the import and export stacks. Use for questions about ships, the port, containers, imports by sea or exports by sea.', input_schema: { type: 'object', properties: {} } },
  { name: 'trace_container', description: 'History of one container number (e.g. OSLU4123057): discharged from which ship, which crane, collected by which truck for which site.', input_schema: { type: 'object', properties: { container_no: { type: 'string' } }, required: ['container_no'] } },
  { name: 'get_store_stock', description: 'Vendor stores and supermarkets in town supplied by the warehouses: shelf stock per product, reorder points, sales today, open restock orders and the delivery vans on the road. Optionally one store_id (ST-01…ST-08).', input_schema: { type: 'object', properties: { store_id: { type: 'string' } } } },
  { name: 'show_in_3d', description: 'Select an object and move the 3D camera to it on the user\'s screen. Use when the user asks to see, show, find or locate something, or when pointing at the thing you are talking about helps.', input_schema: { type: 'object', required: ['kind', 'id'], properties: { kind: { type: 'string', enum: ['truck', 'forklift', 'pallet', 'dock', 'charger', 'facility', 'building', 'gate', 'vehicle', 'vessel', 'crane', 'berth', 'store', 'van'] }, id: { type: 'string' } } } },
];

export function assistantConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export async function runAssistant(host: SimHost, repo: Repo, user: SessionUser, history: ChatTurn[], currentFacility: FacilityId): Promise<AssistantReply> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new AppError(503, 'The AI assistant is not set up yet. Add ANTHROPIC_API_KEY to the .env file and restart the server.');
  const base = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';
  const home = user.facilities.includes(currentFacility) ? currentFacility : user.facilities[0];
  const w = host.world;
  const tools = TOOLS.filter((t) => !t.perm || user.permissions.includes(t.perm));
  const actions: AssistantReply['actions'] = [];
  const used: string[] = [];

  const facOf = (input: Record<string, unknown>): FacilityId => {
    const f = (input.facility_id as FacilityId | undefined) ?? home;
    if (!user.facilities.includes(f)) throw new AppError(403, `${user.fullName} has no access to ${f}`);
    return f;
  };
  const allowedEntity = (fac: FacilityId | undefined | null) => !!fac && user.facilities.includes(fac);

  const allowedTools = new Set(tools.map((t) => t.name));
  const exec = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    if (!allowedTools.has(name)) throw new AppError(403, `The ${name} tool is not available to the ${user.roleName} role`);
    switch (name) {
      case 'get_site_overview': {
        const fac = facOf(input);
        const f = w.facilities[fac];
        const k = kpis(w, fac);
        const h = facilityHeadline(w, fac);
        return {
          site: `${fac} ${f.name}`, clock: fmtClock(w.simTime), stock_pallets: k.stock, capacity: f.capacity, fill_pct: h.fullPct,
          stock_change_today: k.stockDelta, trucks_on_site: k.onSite, trucks_inbound: k.inbound, on_time_delivery_pct: Number(k.otd.toFixed(1)),
          docks_occupied: `${h.docked}/${h.docksTotal}`, outbound_trucks_today: f.outboundToday, putaways_today: f.putawaysToday,
          inventory: f.inventory.map((l) => ({ product: SKUS[l.skuId]?.name ?? l.skuId, units: l.units, reorder_level: l.lowBelow, low: l.units < l.lowBelow })),
          docks: Object.values(w.docks).filter((d) => d.facilityId === fac).map((d) => ({ dock: d.name, status: dockStatus(w, d).badge.label, detail: dockStatus(w, d).detail })),
        };
      }
      case 'list_trucks': {
        const fac = facOf(input);
        return Object.values(w.trucks).filter((t) => t.facilityId === fac).map((t) => {
          const v = truckView(w, t);
          return { truck: t.id, carrier: carrierName(t.carrier), status: truckBadge(t).label, activity: v.activity, ...Object.fromEntries(v.rows.map((r) => [r.k.toLowerCase(), r.v])) };
        });
      }
      case 'get_truck': {
        const t = w.trucks[String(input.truck_id).toUpperCase()];
        if (!t || !allowedEntity(t.facilityId)) return { error: `No truck ${input.truck_id} at your sites` };
        const v = truckView(w, t);
        return { truck: t.id, carrier: v.header, driver: t.driver, plate: t.plate, site: t.facilityId, status: v.badge.label, activity: v.activity, progress: v.right, ...Object.fromEntries(v.rows.map((r) => [r.k.toLowerCase(), r.v])) };
      }
      case 'list_forklifts': {
        const fac = facOf(input);
        return Object.values(w.forklifts).filter((f) => f.facilityId === fac).map((f) => {
          const v = forkliftView(w, f);
          return { forklift: f.id, operator: f.operator, battery_pct: Math.round(f.battery), status: v.badge.label, job: v.activity, moves_today: f.movesToday };
        });
      }
      case 'list_alerts': {
        const facs = input.facility_id ? [facOf(input)] : user.facilities;
        return (await computeAlerts(w, repo, facs)).map((a) => ({ id: a.id, site: a.facilityId, severity: a.severity, title: a.title, detail: a.detail, suggested_task: a.suggestion?.title ?? null }));
      }
      case 'list_tasks': {
        const fac = facOf(input);
        const mine = input.mine === true || !user.permissions.includes('MANAGE_TASKS');
        const tasks = await repo.listTasks({ facilities: [fac], assigneeId: mine ? user.employeeId : undefined, includeClosed: input.include_closed === true, limit: 40 });
        return tasks.map((t) => ({ id: t.id, title: t.title, type: t.type, priority: t.priority, status: t.status, assignee: t.assigneeName, due: t.dueAt, last_note: t.lastNote, automatic: t.source === 'SYSTEM' }));
      }
      case 'list_team': {
        const fac = facOf(input);
        return (await repo.listEmployees([fac])).map((e) => ({ employee_id: e.id, name: e.fullName, job: e.jobTitle, login_role: e.role, forklift: e.forkliftId, open_tasks: e.openTasks }));
      }
      case 'search':
        return search(w, String(input.query ?? '')).filter((r) => r.ref.kind === 'facility' ? user.facilities.includes(r.ref.id as FacilityId) : true).slice(0, 8)
          .map((r) => ({ kind: r.ref.kind, id: r.ref.id, title: r.title, detail: r.sub }));
      case 'create_task': {
        const fac = facOf(input);
        const id = await repo.createTask(user.userId, {
          facilityId: fac, title: String(input.title).slice(0, 160), description: String(input.description ?? '').slice(0, 1000),
          type: input.type as TaskType, priority: (input.priority as Priority) ?? 'NORMAL',
          assigneeId: typeof input.assignee_employee_id === 'number' ? input.assignee_employee_id : null,
          truckId: (input.truck_id as string) ?? null, dockId: (input.dock_id as string) ?? null,
          dueMinutes: typeof input.due_minutes === 'number' ? input.due_minutes : 60, source: 'MANUAL',
        });
        host.bump('tasks'); host.bump('audit');
        const t = await repo.getTask(id);
        return { created_task_id: id, title: t?.title, assignee: t?.assigneeName, status: t?.status };
      }
      case 'get_imports_exports': {
        const facs = input.facility_id ? [facOf(input)] : user.facilities;
        const trade = await repo.trade(facs);
        const log = await repo.gateLog(facs, Math.min(30, Math.max(1, Number(input.limit ?? 12))));
        return {
          today: trade.map((t) => ({ site: `${t.facilityId} ${t.name}`, import_trucks: t.importTrucks, import_pallets: t.importPallets, export_trucks: t.exportTrucks, export_pallets: t.exportPallets, empty_moves: t.emptyMoves })),
          latest: log.map((g) => ({ time: fmtClock(g.simTime), gate: g.gate, trade: g.trade, truck: g.truckId, carrier: carrierName(g.carrier), site: g.facilityId, product: g.skuName, pallets: g.pallets })),
        };
      }
      case 'list_park_tenants': {
        const p = await repo.park();
        return p.buildings.map((b) => ({ building_id: b.id, name: b.name, company: p.companies.find((c) => c.id === b.companyId)?.name, kind: b.kind, status: b.status, staff: b.staff, lease_end: b.leaseEnd, street: b.street }));
      }
      case 'get_port_status': {
        const P = w.port;
        return {
          import_stack: P.importStack.length, export_stack: P.exportStack.length, stack_capacity_each: P.yardCapacity,
          crane_moves_today: P.movesToday, ship_calls_today: P.callsToday,
          berths: Object.values(P.berths).map((b) => ({ berth: b.id, name: b.name, open: b.open, ship: b.vesselId ? P.vessels[b.vesselId]?.name : null })),
          cranes: Object.values(P.cranes).map((c) => ({ crane: c.id, berth: c.berthId, working: c.phase, moves_today: c.movesToday })),
          ships: Object.values(P.vessels).map((v) => ({
            vessel_id: v.id, name: v.name, line: v.line, voyage: v.voyage, status: v.status, berth: v.berthId, on_hold: v.hold,
            from: v.origin, next_port: v.nextPort, to_discharge: v.importBoxes, discharged: v.discharged, loaded: v.loaded, export_booked: v.exportTarget,
          })),
          recent: P.log.slice(0, 8).map((e) => `${fmtClock(e.t)} ${e.text}`),
        };
      }
      case 'trace_container': {
        const no = String(input.container_no ?? '').toUpperCase().replace(/\s+/g, '');
        const moves = await repo.containerMoves({ limit: 20, container: no });
        const where = w.port.importStack.includes(no) ? 'in the import stack' : w.port.exportStack.includes(no) ? 'in the export stack' : null;
        const ship = Object.values(w.shipments).find((s) => s.containerNo === no);
        return { container_no: no, now: where ?? (ship ? `on truck ${ship.truckId} (${ship.id})` : 'not at the terminal'), moves: moves.reverse() };
      }
      case 'get_store_stock': {
        const R = w.retail;
        const list = Object.values(R.stores).filter((s) => !input.store_id || s.id === input.store_id);
        return {
          stores: list.map((s) => ({
            store_id: s.id, name: s.name, kind: s.kind, usual_supplier: s.facilityId, deliveries_today: s.deliveriesToday,
            lines: s.lines.map((l) => ({ sku: l.skuId, product: SKUS[l.skuId]?.name, on_shelf: l.units, reorder_at: l.reorderAt, max: l.maxUnits, sold_today: l.soldToday })),
          })),
          open_orders: Object.values(R.orders).filter((o) => o.status !== 'DELIVERED' && o.status !== 'CANCELLED' && (!input.store_id || o.storeId === input.store_id))
            .map((o) => ({ order_id: o.id, store: R.stores[o.storeId]?.name, sku: o.skuId, units: o.units, from: o.facilityId, status: o.status, van: o.vanId })),
          vans_on_the_road: Object.values(R.vans).filter((v) => v.status !== 'IDLE').map((v) => ({ van_id: v.id, depot: v.facilityId, status: v.status, store: v.storeId ? R.stores[v.storeId]?.name : null })),
        };
      }
      case 'show_in_3d': {
        const ref = { kind: input.kind, id: String(input.id) } as EntityRef;
        actions.push({ type: 'focus', ref });
        return { ok: true, note: 'The view will move to it when you reply.' };
      }
      default:
        return { error: `Unknown tool ${name}` };
    }
  };

  const system = [
    'You are the CargoVerse operations assistant inside a live 3D warehouse and logistics dashboard.',
    `You are helping ${user.fullName} (${user.jobTitle}; access role: ${user.roleName}). Sites they can access: ${user.facilities.join(', ')}. They are currently looking at ${home}.`,
    `The operations clock reads ${fmtClock(w.simTime)}. Data comes from the live operations model stored in the database; always use the tools rather than guessing figures.`,
    'Answer briefly and concretely, in plain language a warehouse manager or operator uses. Use short lists when listing several items. Quote ids (TRK-2051, FL-10, Bay 1) so the user can find them.',
    'When something can be shown on screen, call show_in_3d for the most relevant object.',
    user.permissions.includes('MANAGE_TASKS')
      ? 'You may create tasks with create_task, but only when the user clearly asks you to; otherwise propose the task and ask.'
      : 'This user cannot create or assign tasks; if they need one, tell them to ask their manager.',
  ].join('\n');

  type Block = { type: string; [k: string]: unknown };
  const messages: { role: 'user' | 'assistant'; content: string | Block[] }[] = history.slice(-12).map((t) => ({ role: t.role, content: t.content.slice(0, 4000) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw new AppError(400, 'Send a question');

  for (let round = 0; round < 6; round++) {
    let res: Response;
    try {
      res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 1024, system, tools: tools.map(({ perm: _p, ...t }) => t), messages }),
      });
    } catch {
      throw new AppError(502, 'Could not reach the Claude API. Check the server\'s internet connection.');
    }
    const data = await res.json().catch(() => ({})) as { content?: Block[]; stop_reason?: string; error?: { message?: string } };
    if (!res.ok) throw new AppError(502, `Claude API error (${res.status}): ${data.error?.message ?? 'unknown error'}`);
    const content = data.content ?? [];
    messages.push({ role: 'assistant', content });
    if (data.stop_reason !== 'tool_use') {
      const reply = content.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n').trim();
      return { reply: reply || 'Done.', actions, tools: used };
    }
    const results: Block[] = [];
    for (const b of content.filter((x) => x.type === 'tool_use')) {
      try {
        const out = await exec(String(b.name), (b.input as Record<string, unknown>) ?? {});
        used.push(String(b.name));
        results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: b.id, content: (e as Error).message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: 'I looked into several things but could not finish — try asking a narrower question.', actions, tools: used };
}
