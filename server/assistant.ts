// Operations assistant: answers questions in plain language with tools that read the live operation,
// the Smart Warehouse and — on Oracle — the database itself.
//
//  · With ANTHROPIC_API_KEY set, Claude chooses the tools (tool use) and writes the answer.
//  · Without a key it runs in demo mode: built-in rules pick the tool from the question and format
//    the answer, so the assistant still works for anyone who clones the project.
//
// Every tool respects the caller's role and sites. query_database runs as the user's own Oracle
// account, so Oracle's row-level security decides which rows the AI can see.
import type { FacilityId, EntityRef } from '../src/data/types';
import type { SessionUser, TaskType, Priority, AiQueryResult, AssistantReply, AssistantAction, AssistantQuery } from '../src/api/types';
import { SKUS, carrierName } from '../src/data/seed';
import {
  kpis, facilityHeadline, truckView, forkliftView, truckBadge, search, dockStatus, fmtClock,
} from '../src/ui/derive';
import { AppError, type Repo } from './db/repo';
import { TABLE_GROUPS } from './db/schema-meta';
import type { SimHost } from './simhost';
import { computeAlerts } from './agent';
import { DEMO_SQL } from './assistant-sql';
import { findEntities, inspectEntity, searchDocs, questionTerms, PROJECT_OVERVIEW } from './knowledge';

// ---------------------------------------------------------------- reply shape

export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export type { AssistantReply, AssistantAction, AssistantQuery };

const SITES: FacilityId[] = ['WH-01', 'WH-02', 'WH-04'];
const FAC_PROP = { facility_id: { type: 'string', enum: SITES, description: 'Site id. Omit to use the site the user is looking at.' } };
const SENSITIVE = /\b(APP_USERS|USER_SESSIONS|DB_ACCOUNTS|PASSWORD_HASH)\b/i;

interface ToolDef { name: string; description: string; input_schema: Record<string, unknown>; perm?: SessionUser['permissions'][number] }

const TOOLS: ToolDef[] = [
  // ---- live operations
  { name: 'get_site_overview', description: 'Live KPIs for a site: stock on hand vs capacity, trucks on site and inbound, on-time delivery rate, docks in use, outbound trucks and put-aways today, and inventory lines with their reorder levels. Use first for any general question about how a site is doing.', input_schema: { type: 'object', properties: FAC_PROP } },
  { name: 'list_trucks', description: 'Every truck assigned to a site with status (en route, at gate, docking, loading/unloading, departing, in transit), dock, cargo progress, shipment and ETA.', input_schema: { type: 'object', properties: FAC_PROP } },
  { name: 'get_truck', description: 'Full details for one truck by id (e.g. TRK-2051): carrier, driver, status, shipment, customer, destination, ETA, dock and cargo.', input_schema: { type: 'object', properties: { truck_id: { type: 'string' } }, required: ['truck_id'] } },
  { name: 'list_forklifts', description: 'Forklifts at a site with operator, battery level, current job and moves today.', input_schema: { type: 'object', properties: FAC_PROP } },
  { name: 'list_alerts', description: 'Current exceptions from the exception watcher: shipments at risk of being late, forklifts low on battery mid-job, trucks waiting at the gate, products below reorder level and blocked tasks, each with a suggested task.', input_schema: { type: 'object', properties: FAC_PROP } },
  { name: 'list_tasks', description: 'Open tasks (or all, with include_closed) at a site with assignee, status, priority and the latest note. mine=true lists only the signed-in user\'s tasks.', input_schema: { type: 'object', properties: { ...FAC_PROP, mine: { type: 'boolean' }, include_closed: { type: 'boolean' } } } },
  { name: 'list_team', description: 'Staff at a site with job titles, login roles, forklifts and open tasks each. Use before assigning work.', input_schema: { type: 'object', properties: FAC_PROP }, perm: 'VIEW_TEAM' },
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
  { name: 'get_imports_exports', description: 'Goods through the park gates today per site (imports in through the West Gate, exports out through the East Gate) plus the latest gate movements.', input_schema: { type: 'object', properties: { ...FAC_PROP, limit: { type: 'number' } } } },
  { name: 'list_park_tenants', description: 'Companies and buildings in the logistics park with status, staff and lease end.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_port_status', description: 'The container terminal now: every ship (status, berth, boxes to discharge, loaded), berths, quay cranes and the import / export stacks.', input_schema: { type: 'object', properties: {} } },
  { name: 'trace_container', description: 'History of one container number (e.g. OSLU4123057): which ship, crane, truck and site.', input_schema: { type: 'object', properties: { container_no: { type: 'string' } }, required: ['container_no'] } },
  { name: 'get_store_stock', description: 'Vendor stores supplied by the warehouses: shelf stock, reorder points, sales today, open restock orders and vans on the road. Optionally one store_id (ST-01…ST-08).', input_schema: { type: 'object', properties: { store_id: { type: 'string' } } } },
  { name: 'show_in_3d', description: 'Select an object and move the 3D camera to it. Use when the user asks to see, show, find or locate something.', input_schema: { type: 'object', required: ['kind', 'id'], properties: { kind: { type: 'string', enum: ['truck', 'forklift', 'pallet', 'dock', 'charger', 'facility', 'building', 'gate', 'vehicle', 'vessel', 'crane', 'berth', 'store', 'van'] }, id: { type: 'string' } } } },

  // ---- anything in the city, and how the project works
  { name: 'locate', description: 'Find objects anywhere in the 3D city and say where they are right now, in words (street and nearest building): trucks, forklifts, pallets, docks, ships, cranes, berths, stores, delivery vans, park buildings, gates and public traffic (buses, cars, taxis, tankers, tractors). Query by id, plate, name or kind word, e.g. "bus", "the red bus", "NJ-BUS-014", "Ocean Star", "FreshCart", "delivery vans".', input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
  { name: 'inspect', description: 'Everything known about one object (any kind) and where it is now. Use for "this"/"it" when the user has selected something on screen.', input_schema: { type: 'object', required: ['kind', 'id'], properties: { kind: { type: 'string', enum: ['facility', 'truck', 'forklift', 'pallet', 'dock', 'charger', 'vessel', 'crane', 'berth', 'store', 'van', 'vehicle', 'building', 'gate'] }, id: { type: 'string' } } } },
  { name: 'project_docs', description: 'Search the CargoVerse documentation (README, database design, demo guide) to explain how the project works: features, screens, roles, the database design, PL/SQL, triggers, how a feature is implemented, commands, setup and troubleshooting.', input_schema: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } } },

  // ---- Smart Warehouse
  { name: 'warehouse_lots', description: 'Stock by lot: product, supplier, expiry date, days to expiry, quality status (RELEASED / HOLD / RECALLED and why), units, pallets and FEFO rank (1 = the lot to pick next). Filter by site, product, status or expiring within N days. Also returns how many picks broke FEFO.', input_schema: { type: 'object', properties: { ...FAC_PROP, product: { type: 'string', description: 'Product id (e.g. MED-INS) or part of its name' }, status: { type: 'string', enum: ['RELEASED', 'HOLD', 'RECALLED'] }, expiring_within_days: { type: 'integer' } } } },
  { name: 'trace', description: 'Trace a lot (LOT-10050), container, shipment or vessel through the supply chain: from the ship to the lot to every store order and store that received it (direction down), or back to its origin (up). Uses a recursive SQL query on Oracle.', input_schema: { type: 'object', required: ['kind', 'id'], properties: { kind: { type: 'string', enum: ['LOT', 'CONTAINER', 'SHIPMENT', 'VESSEL', 'ORDER', 'STORE'] }, id: { type: 'string' }, direction: { type: 'string', enum: ['down', 'up'] } } }, perm: 'VIEW_REPORTS' },
  { name: 'cold_chain_status', description: 'Temperature sensors (cold room 2–8 °C and ambient), their latest reading, range, door state and status; cold-chain breaches found by MATCH_RECOGNIZE; and the lots put on hold because of them.', input_schema: { type: 'object', properties: FAC_PROP } },
  { name: 'reorder_suggestions', description: 'Replenishment per site and product: on hand, available, daily demand and its spread, supplier lead time, safety stock, reorder point, economic order quantity, days of cover and REORDER / OK.', input_schema: { type: 'object', properties: FAC_PROP }, perm: 'VIEW_REPORTS' },
  { name: 'demand_forecast', description: '14-day demand forecast for one product at one site (trend and weekday pattern from the demand history), with its reorder point.', input_schema: { type: 'object', required: ['product'], properties: { ...FAC_PROP, product: { type: 'string' } } }, perm: 'VIEW_REPORTS' },
  { name: 'slotting_report', description: 'ABC analysis for a site: products ranked by demand with their share, class A/B/C, average distance from the dock and pallets; plus the expected walk per pick now and the put-away policy.', input_schema: { type: 'object', properties: FAC_PROP }, perm: 'VIEW_REPORTS' },
  { name: 'pick_route', description: 'Shortest walking route through the aisles from the dock to a set of bins (Dijkstra over the aisle graph), compared with picking them in the order given. Omit bin_ids to plan a sample pick list.', input_schema: { type: 'object', properties: { ...FAC_PROP, bin_ids: { type: 'array', items: { type: 'string' } } } } },
  { name: 'scan_label', description: 'Look up a GS1 SSCC pallet label (18 digits, optionally with "(00)"): validates the check digit and returns the bin, lot, product, expiry, status and whether FEFO allows picking it.', input_schema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } },
  { name: 'search_damage_reports', description: 'Semantic search of damage reports and product descriptions by meaning (vector search), e.g. "broken glass" finds "cracked diffusers".', input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
  { name: 'show_warehouse_xray', description: 'Open the 3D X-ray of a warehouse (roof off, every pallet in its bin) coloured by product (sku), ABC class (abc), days to expiry (expiry) or quality status (qc); optionally highlight bins.', input_schema: { type: 'object', required: ['facility_id'], properties: { ...FAC_PROP, mode: { type: 'string', enum: ['sku', 'abc', 'expiry', 'qc'] }, bin_ids: { type: 'array', items: { type: 'string' } } } } },
  { name: 'recall_lot', description: 'Recall a lot: quarantines its stock and creates a task for every store that received it. Only when the user has explicitly asked for a recall.', input_schema: { type: 'object', required: ['lot_id', 'reason'], properties: { lot_id: { type: 'string' }, reason: { type: 'string' } } }, perm: 'MANAGE_TASKS' },

  // ---- the database itself
  { name: 'describe_tables', description: 'Columns, types and comments of database tables or views (give up to 8 names). Call before query_database when unsure of column names.', input_schema: { type: 'object', required: ['tables'], properties: { tables: { type: 'array', items: { type: 'string' } } } }, perm: 'VIEW_REPORTS' },
  { name: 'query_database', description: 'Run ONE read-only Oracle SQL query (SELECT or WITH) and get up to 50 rows. It runs as the user\'s own database account, so Oracle\'s row-level security limits the rows to their sites. Use for questions the other tools cannot answer (counts, totals, rankings, history, comparisons). Oracle SQL dialect: FETCH FIRST n ROWS ONLY, TRUNC(dates), NVL, LISTAGG.', input_schema: { type: 'object', required: ['sql', 'purpose'], properties: { sql: { type: 'string' }, purpose: { type: 'string', description: 'One short line: what this query finds out' } } }, perm: 'VIEW_REPORTS' },
];

const MAX_RESULT = 14000;

// ---------------------------------------------------------------- the toolbox (shared by Claude and demo mode)

export function makeToolbox(host: SimHost, repo: Repo, user: SessionUser, currentFacility: FacilityId) {
  const home = user.facilities.includes(currentFacility) ? currentFacility : user.facilities[0];
  const w = host.world;
  const W = host.wms;
  const tools = TOOLS.filter((t) => !t.perm || user.permissions.includes(t.perm));
  const allowed = new Set(tools.map((t) => t.name));
  const actions: AssistantAction[] = [];
  const used: string[] = [];
  const queries: AssistantQuery[] = [];

  const facOf = (input: Record<string, unknown>): FacilityId => {
    const f = (input.facility_id as FacilityId | undefined) ?? home;
    if (!user.facilities.includes(f)) throw new AppError(403, `${user.fullName} has no access to ${f}`);
    return f;
  };
  const facsOf = (input: Record<string, unknown>): FacilityId[] => input.facility_id ? [facOf(input)] : user.facilities;
  const allowedEntity = (fac: FacilityId | undefined | null) => !!fac && user.facilities.includes(fac);
  const skuOf = (text: unknown): string | null => {
    const t = String(text ?? '').trim();
    if (!t) return null;
    if (SKUS[t.toUpperCase()]) return t.toUpperCase();
    const low = t.toLowerCase();
    const hit = Object.values(SKUS).find((s) => s.name.toLowerCase().includes(low) || low.includes(s.name.toLowerCase().split(' (')[0]))
      ?? Object.values(SKUS).find((s) => low.split(/\W+/).some((word) => word.length > 3 && s.name.toLowerCase().includes(word)));
    return hit?.id ?? null;
  };
  const lotFac = (lotId: string): FacilityId => {
    const lot = W.engine.lots.get(lotId);
    if (!lot) throw new AppError(404, `There is no lot ${lotId}`);
    if (!user.facilities.includes(lot.facilityId)) throw new AppError(403, `You do not have access to ${lot.facilityId}`);
    return lot.facilityId;
  };

  const exec = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    if (!allowed.has(name)) throw new AppError(403, `The ${name} tool is not available to the ${user.roleName} role`);
    used.push(name);
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
      case 'list_alerts':
        return (await computeAlerts(w, repo, facsOf(input))).map((a) => ({ id: a.id, site: a.facilityId, severity: a.severity, title: a.title, detail: a.detail, suggested_task: a.suggestion?.title ?? null, ref: a.ref }));
      case 'list_tasks': {
        const fac = facOf(input);
        const mine = input.mine === true || !user.permissions.includes('MANAGE_TASKS');
        const tasks = await repo.listTasks({ facilities: [fac], assigneeId: mine ? user.employeeId : undefined, includeClosed: input.include_closed === true, limit: 40 });
        return tasks.map((t) => ({ id: t.id, title: t.title, type: t.type, priority: t.priority, status: t.status, assignee: t.assigneeName, due: t.dueAt, last_note: t.lastNote, automatic: t.source === 'SYSTEM' }));
      }
      case 'list_team':
        return (await repo.listEmployees([facOf(input)])).map((e) => ({ employee_id: e.id, name: e.fullName, job: e.jobTitle, login_role: e.role, forklift: e.forkliftId, open_tasks: e.openTasks }));
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
        const facs = facsOf(input);
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
      case 'show_in_3d':
        actions.push({ type: 'focus', ref: { kind: input.kind, id: String(input.id) } as EntityRef });
        return { ok: true, note: 'The view will move to it when you reply.' };

      // ---- anything in the city, and the docs
      case 'locate': {
        const found = findEntities(w, String(input.query ?? ''), user.facilities);
        if (found[0]) actions.push({ type: 'focus', ref: found[0].ref });
        return found.length ? found.map((f) => ({ kind: f.ref.kind, id: f.ref.id, name: f.title, detail: f.detail, where: f.where })) : { found: 0, note: 'Nothing matches. Try an id, plate or name (or the search box at the top).' };
      }
      case 'inspect': {
        const ref = { kind: String(input.kind ?? ''), id: String(input.id ?? '') } as EntityRef;
        const r = inspectEntity(w, ref, user.facilities);
        if (!('error' in r)) actions.push({ type: 'focus', ref });
        return r;
      }
      case 'project_docs':
        return searchDocs(String(input.question ?? ''), 3);

      // ---- Smart Warehouse
      case 'warehouse_lots': {
        const r = await W.lots(facsOf(input));
        const sku = input.product ? skuOf(input.product) : null;
        if (input.product && !sku) return { error: `No product matches "${input.product}". Products: ${Object.values(SKUS).map((s) => `${s.id} ${s.name}`).join('; ')}` };
        const days = typeof input.expiring_within_days === 'number' ? input.expiring_within_days : null;
        const lots = r.lots.filter((l) => (!sku || l.skuId === sku) && (!input.status || l.qc === input.status)
          && (days === null || (l.daysToExpiry !== null && l.daysToExpiry <= days)) && l.units > 0)
          .sort((a, b) => (a.daysToExpiry ?? 1e9) - (b.daysToExpiry ?? 1e9));
        return {
          source: r.source, lots_found: lots.length,
          lots: lots.slice(0, 25).map((l) => ({ lot: l.lotId, site: l.facilityId, product: l.skuName, supplier: l.supplier, expiry: l.expiry, days_to_expiry: l.daysToExpiry, status: l.qc, why: l.qcReason, units: l.units, pallets: l.pallets, fefo_rank: l.fefoRank })),
          fefo_violations: r.violations.length,
        };
      }
      case 'trace': {
        const kind = String(input.kind ?? 'LOT').toUpperCase();
        const id = String(input.id ?? '').toUpperCase().trim();
        if (kind === 'LOT') lotFac(id);
        const r = await W.trace(kind, id, input.direction === 'up' ? 'up' : 'down');
        return { source: r.source, root: r.root, stores_reached: r.stores, customers: r.customers, path: r.nodes.slice(0, 40).map((n) => ({ depth: n.depth, kind: n.kind, id: n.id, label: n.label, units: n.units })) };
      }
      case 'cold_chain_status': {
        const r = await W.cold(facsOf(input));
        return {
          source: r.source, detector: r.detector,
          sensors: r.sensors.map((s) => ({ sensor: s.id, site: s.facilityId, zone: s.zone, where: s.label, temp_c: s.tempC === null ? null : Number(s.tempC.toFixed(1)), range: `${s.minC}–${s.maxC} °C`, door_open: s.doorOpen, status: s.status })),
          breaches: r.breaches.slice(0, 10).map((b) => ({ sensor: b.sensorId, site: b.facilityId, started: b.startedAt, ended: b.endedAt, peak_c: b.peakC, readings: b.readings, lots_held: b.lotsHeld, status: b.status })),
          lots_on_hold: r.held.map((l) => ({ lot: l.lotId, product: l.skuName, site: l.facilityId, units: l.units, why: l.qcReason })),
        };
      }
      case 'reorder_suggestions': {
        const r = await W.replenishment(facsOf(input));
        return { source: r.source, rows: r.rows.map((x) => ({ site: x.facilityId, product: x.skuName, sku: x.skuId, on_hand: x.onHand, daily_demand: x.dailyDemand, lead_time_days: x.leadTimeDays, safety_stock: x.safetyStock, reorder_point: x.reorderPoint, order_qty_eoq: x.eoq, days_of_cover: x.daysOfCover, action: x.action })) };
      }
      case 'demand_forecast': {
        const fac = facOf(input);
        const sku = skuOf(input.product);
        if (!sku) return { error: `No product matches "${input.product}"` };
        const r = await W.forecast(fac, sku);
        const actual = r.points.filter((p) => p.actual !== null).slice(-14);
        const future = r.points.filter((p) => p.actual === null && p.forecast !== null);
        const avg = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
        return {
          source: r.source, site: fac, product: SKUS[sku]?.name, last_14_days_avg_per_day: avg(actual.map((p) => p.actual!)),
          next_14_days_total: Math.round(future.reduce((a, p) => a + (p.forecast ?? 0), 0)), trend_units_per_day_per_day: r.slopePerDay,
          weekday_index_sun_to_sat: r.weekday.map((x) => Number(x.toFixed(2))),
          forecast: future.map((p) => ({ date: p.date, units: Math.round(p.forecast ?? 0) })),
          replenishment: r.replenish ? { on_hand: r.replenish.onHand, reorder_point: r.replenish.reorderPoint, order_qty_eoq: r.replenish.eoq, days_of_cover: r.replenish.daysOfCover, action: r.replenish.action } : null,
        };
      }
      case 'slotting_report': {
        const fac = facOf(input);
        const r = await W.abc(fac);
        return { source: r.source, site: fac, putaway_policy: r.policy, expected_metres_per_pick: r.expectedMetresPerPick, measured_metres_per_pick: r.metresPerPick, products: r.rows.map((x) => ({ rank: x.rank, product: x.skuName, class: x.abc, share_pct: x.sharePct, cumulative_pct: x.cumulativePct, units_30d: x.units30d, avg_dock_metres: x.avgDockMetres, pallets: x.pallets })) };
      }
      case 'pick_route': {
        const fac = facOf(input);
        let bins = Array.isArray(input.bin_ids) ? (input.bin_ids as unknown[]).map(String).slice(0, 12) : [];
        if (!bins.length) {
          const cells = W.binMap(fac).cells.filter((c) => c.q === 'RELEASED');
          const step = Math.max(1, Math.floor(cells.length / 6));
          bins = cells.filter((_, i) => i % step === 0).slice(0, 6).map((c) => c.b);
        }
        const r = await W.route(fac, null, bins);
        actions.push({ type: 'xray', facility: fac, highlight: r.stops.map((s) => s.binId), route: { facility: fac, path: r.path, stops: r.stops.map((s) => s.binId) } });
        return { source: r.source, site: fac, from_dock: r.dock, visit_order: r.stops.map((s) => `${s.binId}${s.skuId ? ` (${SKUS[s.skuId]?.name ?? s.skuId})` : ''}`), metres: r.metres, metres_in_given_order: r.naiveMetres, saved_pct: r.naiveMetres ? Math.round((1 - r.metres / r.naiveMetres) * 100) : 0, shown_in_3d: true };
      }
      case 'scan_label': {
        const r = await W.scan(String(input.code ?? ''), user.userId);
        if (r.facilityId && !user.facilities.includes(r.facilityId as FacilityId)) return { valid: r.valid, result: 'This pallet is at a site you do not have access to.' };
        if (r.binId && r.facilityId) actions.push({ type: 'xray', facility: r.facilityId as FacilityId, highlight: [r.binId], mode: 'qc' });
        return r;
      }
      case 'search_damage_reports': {
        const r = await W.search(String(input.query ?? ''));
        return { source: r.source, model: r.model, hits: r.hits.filter((h) => !h.facilityId || user.facilities.includes(h.facilityId as FacilityId)).map((h) => ({ kind: h.kind, id: h.id, site: h.facilityId, product: h.skuId, severity: h.severity, text: h.text, similarity: Number(h.score.toFixed(3)) })) };
      }
      case 'show_warehouse_xray': {
        const fac = facOf(input);
        const mode = (['sku', 'abc', 'expiry', 'qc'] as const).find((m) => m === input.mode);
        actions.push({ type: 'xray', facility: fac, mode, highlight: Array.isArray(input.bin_ids) ? (input.bin_ids as unknown[]).map(String).slice(0, 40) : [] });
        return { ok: true, note: `The X-ray of ${fac} opens when you reply.` };
      }
      case 'recall_lot': {
        const lot = String(input.lot_id ?? '').toUpperCase().trim();
        lotFac(lot);
        const r = await W.recall(lot, String(input.reason ?? 'Recall requested through the assistant').slice(0, 180), user.userId);
        host.bump('tasks'); host.bump('audit');
        return { recalled: lot, store_tasks_created: r.stores };
      }

      // ---- the database
      case 'describe_tables': {
        const names = Array.isArray(input.tables) ? (input.tables as unknown[]).map(String).filter((n) => !SENSITIVE.test(n)).slice(0, 8) : [];
        if (!names.length) return { error: 'Give the table names to describe.' };
        return await repo.describeTables(names);
      }
      case 'query_database': {
        const sql = String(input.sql ?? '').trim();
        const purpose = String(input.purpose ?? '').slice(0, 160);
        const entry: AssistantQuery = { purpose, sql, account: null, filter: null, columns: [], rows: [], rowCount: 0, truncated: false, ms: 0, error: null };
        queries.push(entry);
        if (SENSITIVE.test(sql)) { entry.error = 'Passwords, sessions and database accounts are not available to the assistant.'; return { error: entry.error }; }
        try {
          const r: AiQueryResult = await repo.aiQuery(user.userId, sql);
          Object.assign(entry, { sql: r.statement, account: r.account, filter: r.filter, columns: r.columns, rows: r.rows, rowCount: r.rowCount, truncated: r.truncated, ms: r.ms });
          host.bump('audit');
          return { ran_as: r.account, row_filter: r.filter ?? 'none (all sites)', columns: r.columns, rows: r.rows, row_count: r.rowCount, truncated: r.truncated };
        } catch (e) {
          entry.error = (e as Error).message;
          return { error: entry.error };
        }
      }
      default:
        return { error: `Unknown tool ${name}` };
    }
  };

  return { tools, allowed, exec, actions, used, queries, home, w };
}
type Toolbox = ReturnType<typeof makeToolbox>;

// ---------------------------------------------------------------- Claude

export function assistantConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

function tableList(): string {
  const groups = new Map<string, string[]>();
  for (const [t, g] of Object.entries(TABLE_GROUPS)) {
    if (SENSITIVE.test(t)) continue;
    groups.set(g, [...(groups.get(g) ?? []), t.toLowerCase()]);
  }
  return [...groups].map(([g, ts]) => `${g}: ${ts.join(', ')}`).join('\n');
}

export async function runAssistant(host: SimHost, repo: Repo, user: SessionUser, history: ChatTurn[], currentFacility: FacilityId, selection: EntityRef | null = null): Promise<AssistantReply> {
  const box = makeToolbox(host, repo, user, currentFacility);
  const last = history[history.length - 1];
  if (!last || last.role !== 'user' || !last.content.trim()) throw new AppError(400, 'Send a question');
  const key = process.env.ANTHROPIC_API_KEY;

  const base = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';
  const oracle = (await host.wms.features()).engine === 'oracle';
  // what the user has clicked in the 3D view: "this" / "it" in a question
  const sel = selection ? inspectEntity(box.w, selection, user.facilities) : null;
  const selected = selection && sel && !('error' in sel) ? { ref: selection, info: sel } : null;
  if (!key) return runDemo(box, user, last.content, oracle, selected);
  const canSql = box.allowed.has('query_database');
  const system = [
    'You are the CargoVerse operations assistant inside a live 3D warehouse and logistics dashboard backed by Oracle Database.',
    `About the project: ${PROJECT_OVERVIEW}`,
    'You can answer about anything in the city (use locate / inspect — buses, cars, ships, stores, buildings…) and about how the project itself works (use project_docs, then explain in your own words).',
    selected ? `The user has selected ${selected.ref.kind} ${selected.ref.id} on screen; "this", "it" or "that" means this object. Current details: ${JSON.stringify(selected.info).slice(0, 1500)}` : 'Nothing is selected on screen.',
    `You are helping ${user.fullName} (${user.jobTitle}; access role: ${user.roleName}). Sites they can access: ${user.facilities.join(', ')}. They are currently looking at ${box.home}.`,
    `The operations clock reads ${fmtClock(box.w.simTime)}. Always use the tools rather than guessing figures.`,
    'Answer briefly and concretely, in plain language a warehouse manager or operator uses. Use short lists when listing several items. Quote ids (TRK-2051, LOT-10050, WH-04-C03L2) so the user can find them.',
    'Prefer the specific tools (warehouse_lots, cold_chain_status, trace, reorder_suggestions, slotting_report, pick_route, …). When something can be shown on screen, call show_in_3d or show_warehouse_xray.',
    canSql && oracle
      ? `For questions the other tools cannot answer, write Oracle SQL and run it with query_database (one SELECT, at most 50 rows; it runs as the user's own database account with row-level security). The app shows the SQL to the user, so do not repeat it unless asked; say in one line what the query found. Tables:\n${tableList()}\nCall describe_tables when unsure of columns.`
      : canSql ? 'The database tools are unavailable because this server runs without Oracle; answer from the other tools.' : 'This user cannot run database queries; answer from the other tools.',
    box.allowed.has('create_task')
      ? 'You may create tasks with create_task or recall a lot with recall_lot, but only when the user clearly asks you to; otherwise propose it and ask.'
      : 'This user cannot create tasks or recall lots; if they need one, tell them to ask their manager.',
  ].join('\n');

  type Block = { type: string; [k: string]: unknown };
  const messages: { role: 'user' | 'assistant'; content: string | Block[] }[] = history.slice(-12).map((t) => ({ role: t.role, content: t.content.slice(0, 4000) }));
  if (messages[0]?.role !== 'user') messages.shift();

  for (let round = 0; round < 8; round++) {
    let res: Response;
    try {
      res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 1500, system, tools: box.tools.map(({ perm: _p, ...t }) => t), messages }),
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
      return { reply: reply || 'Done.', actions: box.actions, tools: box.used, queries: box.queries, mode: 'claude' };
    }
    const results: Block[] = [];
    for (const b of content.filter((x) => x.type === 'tool_use')) {
      try {
        const out = JSON.stringify(await box.exec(String(b.name), (b.input as Record<string, unknown>) ?? {}));
        results.push({ type: 'tool_result', tool_use_id: b.id, content: out.length > MAX_RESULT ? `${out.slice(0, MAX_RESULT)}… (truncated)` : out });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: b.id, content: (e as Error).message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: 'I looked into several things but could not finish — try asking a narrower question.', actions: box.actions, tools: box.used, queries: box.queries, mode: 'claude' };
}

// ---------------------------------------------------------------- demo mode (no API key)

const n = (x: number | null | undefined, d = 0) => (x === null || x === undefined ? '—' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d }));
const pick = <T,>(xs: T[], k: number) => xs.slice(0, k);

async function runDemo(box: Toolbox, user: SessionUser, question: string, oracle: boolean, selected: { ref: EntityRef; info: Record<string, unknown> } | null): Promise<AssistantReply> {
  const q = question.toLowerCase();
  const out = (reply: string): AssistantReply => ({ reply, actions: box.actions, tools: box.used, queries: box.queries, mode: 'demo' });
  const can = (t: string) => box.allowed.has(t);
  const facMatch = /wh-0[124]/i.exec(question)?.[0]?.toUpperCase() as FacilityId | undefined;
  const fac = facMatch && user.facilities.includes(facMatch) ? facMatch
    : /riverside/.test(q) && user.facilities.includes('WH-01') ? 'WH-01' : /northgate/.test(q) && user.facilities.includes('WH-02') ? 'WH-02'
      : /southfield/.test(q) && user.facilities.includes('WH-04') ? 'WH-04' : undefined;
  const at = fac ? { facility_id: fac } : {};
  const run = async <T,>(tool: string, input: Record<string, unknown>) => (await box.exec(tool, input)) as T;
  const lotId = /\bLOT-\d+\b/i.exec(question)?.[0]?.toUpperCase();
  const truckId = /\bTRK-\d+\b/i.exec(question)?.[0]?.toUpperCase();
  const containerNo = /\b[A-Z]{4}\s?\d{7}\b/i.exec(question)?.[0]?.toUpperCase().replace(/\s/g, '');
  const sscc = /(\(00\)\s*)?\d{18}/.exec(question)?.[0];

  const nice = (k: string) => k.replace(/_/g, ' ');
  const describe = (info: Record<string, any>, ref: EntityRef): string => {
    const title = String(info.name ?? info.plate ?? info.id ?? ref.id);
    const skip = new Set(['name', 'kind', 'where', 'status', 'doing', 'what', 'id_and_type', 'at_sea', 'parked_at_depot', 'away']);
    const facts = Object.entries(info).filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && v !== '' && typeof v !== 'object').slice(0, 9);
    const list = Object.entries(info).filter(([, v]) => Array.isArray(v) && (v as unknown[]).length).slice(0, 1);
    return [
      `**${title}** — ${info.kind ?? ref.kind}${info.status ? ` · ${info.status}` : ''}`,
      `- Where: ${info.where}`,
      ...(info.doing ? [`- Now: ${info.doing}`] : []),
      ...facts.map(([k, v]) => `- ${nice(k)}: ${typeof v === 'boolean' ? (v ? 'yes' : 'no') : v}`),
      ...list.map(([k, v]) => `- ${nice(k)}: ${(v as unknown[]).slice(0, 6).join(', ')}`),
    ].join('\n');
  };
  const fromDocs = async (question: string, minScore: number): Promise<string | null> => {
    const hits = await run<{ file: string; section: string; text: string; score: number }[]>('project_docs', { question });
    const top = hits[0];
    if (!top || top.score < minScore) return null;
    let lines = top.text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() && !/^\|\s*-{3}/.test(l) && !/^```/.test(l));
    // a feature table: keep the rows about what was asked (plus the header row)
    const terms = questionTerms(question).filter((t) => t.length > 2);
    const rows = lines.filter((l) => l.trim().startsWith('|'));
    const hitRows = rows.slice(1).filter((l) => terms.some((t) => l.toLowerCase().includes(t)));
    if (rows.length > 3 && hitRows.length && hitRows.length < rows.length - 1) lines = [...lines.filter((l) => !l.trim().startsWith('|')).slice(0, 2), ...hitRows];
    let body = '';
    for (const l of lines) {
      const row = /^\|(.*)\|$/.exec(l.trim());
      const line = row ? `- ${row[1].split('|').map((c) => c.trim()).filter(Boolean).join(' — ')}` : l;
      if ((body + line).length > 1100) break;
      body += `${line}\n`;
    }
    const more = hits.slice(1, 3).map((h) => `${h.section} (${h.file})`).join(' · ');
    return `**${top.section}** — from ${top.file}:\n${body.trim()}${more ? `\n\nRelated: ${more}.` : ''}`;
  };

  try {
    // ---- "this" / "it": the object selected in the 3D view
    if (selected && /\b(this|it|that|selected|here)\b/.test(q) && !/\b(lots?|cold|reorder|forecast|slot\w*|route|damage|sql|database)\b/.test(q)) {
      box.used.push('inspect');
      box.actions.push({ type: 'focus', ref: selected.ref });
      return out(describe(selected.info, selected.ref));
    }

    // ---- explanations of how the project works
    const explain = /^(how (does|do|is|are|can|did)|explain|why|tell me about|describe|what (is|are|does|do) (a |an |the )?(cargoverse|project|database lab|smart warehouse|vpd|row.level|flashback|fefo|abc|sscc|gs1|blockchain|match_recognize|model clause|eoq|reorder point|safety stock|property graph|graph_table|vector|teq|event queue|x-?ray|demo mode|assistant|exception watcher|pl\/sql|trigger|package|view|role|permission))/.test(q)
      && !/\b(doing|going|today|now|right now|status)\b/.test(q);
    if (explain) {
      const a = await fromDocs(question, 1.5);
      if (a) return out(a);
    }

    // ---- ids first
    if (sscc) {
      const r = await run<Record<string, any>>('scan_label', { code: sscc });
      return out(r.valid ? `**${r.result}**\n- Product: ${r.sku ?? '—'} · lot ${r.lotId ?? '—'}\n- Where: ${r.binId ?? r.where ?? '—'}${r.expiry ? `\n- Expires: ${r.expiry}` : ''}${r.qc ? `\n- Status: ${r.qc}${r.qcReason ? ` — ${r.qcReason}` : ''}` : ''}` : `**Not a valid GS1 label.** ${r.result}`);
    }
    const recallAsked = !!lotId && /\brecall\b/.test(q) && !/\?|should|would|what if|trace|where|which|who/.test(q);
    if (recallAsked && can('recall_lot')) {
      const r = await run<any>('recall_lot', { lot_id: lotId, reason: 'Recall requested through the assistant' });
      return out(`**${lotId} recalled.** Its stock is quarantined and ${r.store_tasks_created} store task(s) were created. The change is in the audit trail.`);
    }
    if (recallAsked) return out('Only managers can recall a lot. Ask your manager, or trace it first to see which stores received it.');
    if (lotId && !can('trace')) {
      const r = await run<any>('warehouse_lots', {});
      const l = (r.lots as any[]).find((x) => x.lot === lotId);
      return out(`${l ? `**${l.lot}** · ${l.product} at ${l.site}: ${n(l.units)} units, ${l.days_to_expiry === null ? 'no expiry' : `expires ${l.expiry}`} · ${l.status}${l.why ? ` — ${l.why}` : ''}.\n\n` : `${lotId} is not in stock at your sites.\n\n`}Tracing a lot to the stores is a manager report; ask your manager if you need it.`);
    }
    if (lotId && can('trace')) {
      const r = await run<any>('trace', { kind: 'LOT', id: lotId });
      const stores = r.stores_reached as string[];
      return out(`**${lotId}** — traced with a recursive query (${r.source === 'oracle' ? 'Oracle' : 'server'}):\n${pick(r.path as any[], 12).map((p) => `- ${'  '.repeat(Math.max(0, p.depth - 1))}${p.kind} ${p.id}${p.units ? ` · ${n(p.units)} units` : ''}`).join('\n')}\n\n${stores.length ? `It reached **${stores.length} store(s)**: ${stores.join(', ')}.` : 'It has not reached any store yet.'}${can('recall_lot') ? ' Say "recall ' + lotId + '" to quarantine it and create the store tasks.' : ''}`);
    }
    if (truckId) {
      const r = await run<any>('get_truck', { truck_id: truckId });
      if (r.error) return out(r.error);
      box.actions.push({ type: 'focus', ref: { kind: 'truck', id: truckId } });
      return out(`**${truckId}** (${r.carrier}) — ${r.status}\n- ${r.activity}\n- Driver: ${r.driver} · site ${r.site}${r.progress ? `\n- ${r.progress}` : ''}`);
    }
    if (containerNo && /[a-z]{4}\d{7}/i.test(containerNo)) {
      const r = await run<any>('trace_container', { container_no: containerNo });
      return out(`**${containerNo}** is ${r.now}.\n${(r.moves as any[]).length ? (r.moves as any[]).map((m) => `- ${m.moveType ?? m.move ?? ''} ${m.vesselId ?? ''} ${m.truckId ?? ''} ${m.facilityId ?? ''}`.replace(/\s+/g, ' ')).join('\n') : 'No moves recorded yet.'}`);
    }

    // ---- where is …? (anything in the city: buses, cars, ships, stores, buildings, vans …)
    if (/\bwhere\b|\bfind\b|\blocate\b|\bshow me\b|\bwhich\b.*\b(bus|car|taxi|ship|van|store|crane)/.test(q)) {
      const query = question.replace(/^(where('s| is| are)?|find|locate|show me)\s+(is |are )?(the |a |an |all |my )?/i, '').replace(/[?.!]+$/, '').trim();
      const found = await run<any>('locate', { query });
      if (Array.isArray(found) && found.length === 1) {
        const info = await run<Record<string, any>>('inspect', { kind: found[0].kind, id: found[0].id });
        return out(describe(info, { kind: found[0].kind, id: found[0].id } as EntityRef));
      }
      if (Array.isArray(found) && found.length > 1) {
        return out(`**${found.length} match${found.length === 1 ? '' : 'es'}** (the view moves to the first):\n${found.map((f: any) => `- ${f.name}${f.detail ? ` (${f.detail})` : ''}: ${f.where}`).join('\n')}`);
      }
      // a colour that does not exist ("the purple car"): say so and list what there is
      const colour = /\b(red|blue|green|yellow|orange|white|black|grey|gray|purple|pink)\b/.exec(q)?.[1];
      if (colour) {
        const all = findEntities(box.w, query.replace(new RegExp(`\\b${colour}\\b`, 'i'), ''), user.facilities);
        if (all.length) return out(`There is no ${colour} one right now. These are on the map:\n${all.map((f) => `- ${f.title}: ${f.where}`).join('\n')}`);
      }
    }

    // ---- about a vehicle or other object by kind ("who owns the tanker?", "what route does the taxi take?")
    if (/\b(bus(es)?|cars?|taxis?|tankers?|tractors?)\b/.test(q) || (/\b(who owns|owner|whose)\b/.test(q) && findEntities(box.w, question, user.facilities, 2).length)) {
      const found = findEntities(box.w, question, user.facilities);
      if (found.length === 1) {
        box.used.push('locate'); box.actions.push({ type: 'focus', ref: found[0].ref });
        const info = inspectEntity(box.w, found[0].ref, user.facilities);
        if (!('error' in info)) return out(describe(info, found[0].ref));
      }
      if (found.length > 1) {
        box.used.push('locate'); box.actions.push({ type: 'focus', ref: found[0].ref });
        const rows = found.map((f) => { const i = inspectEntity(box.w, f.ref, user.facilities) as Record<string, any>; return `- ${f.title} — ${i.owner ?? i.company ?? ''}${i.route ? `, ${i.route}` : ''}: ${f.where}`; });
        return out(`**${found.length} found** (the view moves to the first):\n${rows.join('\n')}`);
      }
    }

    // ---- warehouse
    if (/cold|temperatur|fridge|insulin|breach|sensor|°c|degrees/.test(q)) {
      const r = await run<any>('cold_chain_status', at);
      const bad = (r.sensors as any[]).filter((s) => s.status !== 'OK');
      const held = r.lots_on_hold as any[];
      if (held.length) box.actions.push({ type: 'xray', facility: held[0].site, mode: 'qc' });
      return out(`${bad.length ? `**${bad.length} sensor(s) need attention.**` : '**The cold chain is in range.**'}\n${(r.sensors as any[]).map((s) => `- ${s.sensor} ${s.where}: ${s.temp_c ?? '—'} °C (range ${s.range})${s.door_open ? ' · **door open**' : ''} — ${s.status}`).join('\n')}\n\n${(r.breaches as any[]).length ? `Breaches found by MATCH_RECOGNIZE: ${(r.breaches as any[]).map((b) => `${b.sensor} peak ${b.peak_c} °C (${b.status.toLowerCase()})`).join('; ')}.` : 'No breaches recorded.'}${held.length ? `\nLots on hold: ${held.map((l) => `${l.lot} ${l.product} (${n(l.units)} units)`).join('; ')}.` : ''}`);
    }
    if (/expir|fefo|\blots?\b|shelf.?life|use.?by|best.?before|on hold|quarantin/.test(q) && !/slot|abc/.test(q)) {
      const hold = /hold|quarantin|blocked/.test(q);
      const r = await run<any>('warehouse_lots', { ...at, ...(hold ? { status: 'HOLD' } : { expiring_within_days: 45 }) });
      const lots = r.lots as any[];
      if (!lots.length) return out(hold ? 'No lots are on hold right now.' : 'No lots expire in the next 45 days.');
      box.actions.push({ type: 'xray', facility: lots[0].site, mode: hold ? 'qc' : 'expiry' });
      return out(`${hold ? `**${r.lots_found} lot(s) on hold:**` : `**${r.lots_found} lot(s) expire within 45 days** — pick these first (FEFO):`}\n${pick(lots, 8).map((l) => `- ${l.lot} · ${l.product} at ${l.site}: ${n(l.units)} units, ${l.days_to_expiry === null ? 'no expiry' : `${l.days_to_expiry} days left (${l.expiry})`}${l.status !== 'RELEASED' ? ` · ${l.status}${l.why ? ` — ${l.why}` : ''}` : ''}`).join('\n')}\n\nFEFO audit: ${r.fefo_violations ? `**${r.fefo_violations} pick(s)** took a newer lot first.` : 'every pick took the oldest lot.'} The X-ray is coloured by ${hold ? 'quality status' : 'days to expiry'}.`);
    }
    if (/reorder|replenish|order more|running (low|out)|low stock|stock.?out|eoq|purchase/.test(q) && can('reorder_suggestions')) {
      const r = await run<any>('reorder_suggestions', at);
      const due = (r.rows as any[]).filter((x) => x.action === 'REORDER');
      return out(`${due.length ? `**${due.length} product line(s) to reorder:**` : '**Nothing needs reordering.** Lowest cover:'}\n${pick(due.length ? due : (r.rows as any[]), 8).map((x) => `- ${x.product} at ${x.site}: ${n(x.on_hand)} on hand, ${n(x.daily_demand, 1)}/day, reorder point ${n(x.reorder_point)} → order **${n(x.order_qty_eoq)}** (cover ${n(x.days_of_cover, 1)} days)`).join('\n')}\n\nReorder point = demand × lead time + safety stock (95 % service); order size = economic order quantity.`);
    }
    if (/forecast|predict|next (week|two weeks|14)|future demand/.test(q) && can('demand_forecast')) {
      const sku = Object.values(SKUS).find((s) => q.includes(s.id.toLowerCase()) || q.includes(s.name.toLowerCase().split(' (')[0].toLowerCase()))
        ?? Object.values(SKUS).find((s) => s.name.toLowerCase().split(/\W+/).some((wd) => wd.length > 3 && q.includes(wd)));
      if (!sku) return out(`Which product? For example: "forecast for ${Object.values(SKUS)[0].name}". Products: ${Object.values(SKUS).map((s) => s.name).join(', ')}.`);
      const site = fac ?? (user.facilities.find((f) => box.w.facilities[f]?.inventory.some((l) => l.skuId === sku.id)) ?? box.home);
      const r = await run<any>('demand_forecast', { facility_id: site, product: sku.id });
      return out(`**${r.product} at ${site}**: about **${n(r.next_14_days_total)} units** in the next 14 days (recent average ${n(r.last_14_days_avg_per_day)}/day, trend ${n(r.trend_units_per_day_per_day, 2)} units/day per day).${r.replenishment ? `\n- On hand ${n(r.replenishment.on_hand)}, reorder point ${n(r.replenishment.reorder_point)} → ${r.replenishment.action}` : ''}\n\nForecast with the MODEL clause: trend from REGR_SLOPE × weekday index.`);
    }
    if (/slot|abc|fast.?mov|slow.?mov|walk|travel distance/.test(q) && can('slotting_report')) {
      const site = fac ?? box.home;
      const r = await run<any>('slotting_report', { facility_id: site });
      box.actions.push({ type: 'xray', facility: site, mode: 'abc' });
      return out(`**ABC analysis for ${site}** (policy ${r.putaway_policy}, expected walk ${n(r.expected_metres_per_pick, 1)} m per pick):\n${pick(r.products as any[], 8).map((p) => `- ${p.class} · ${p.product}: ${p.share_pct}% of demand, avg ${n(p.avg_dock_metres, 1)} m from the dock`).join('\n')}\n\n${r.putaway_policy === 'RANDOM' ? 'Fast movers are scattered: **Apply ABC slotting** in Work → Warehouse would move them next to the docks.' : 'Fast movers are already slotted next to the docks.'}`);
    }
    if (/route|pick path|pick list|shortest|walking/.test(q)) {
      const site = fac ?? box.home;
      const r = await run<any>('pick_route', { facility_id: site });
      return out(`**Shortest pick route at ${site}**: ${n(r.metres)} m instead of ${n(r.metres_in_given_order)} m in list order (**${r.saved_pct}% less walking**).\n${(r.visit_order as string[]).map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nDijkstra over the aisle graph; the route is drawn on the floor in 3D.`);
    }
    if (/damage|broken|crack|leak|dent|wet|crush|torn|smash|spill/.test(q)) {
      const r = await run<any>('search_damage_reports', { query: question });
      const hits = (r.hits as any[]).filter((h) => h.kind === 'DAMAGE');
      return out(hits.length ? `**Closest damage reports** (vector search, ${r.model}):\n${pick(hits, 5).map((h) => `- #${h.id} ${h.site ?? ''} ${h.product ?? ''} (${h.severity?.toLowerCase() ?? ''}): "${h.text}" — similarity ${h.similarity}`).join('\n')}` : 'No similar damage reports.');
    }

    const managerOnly = /reorder|replenish|order more|eoq|purchase|forecast|predict|slot|abc|fast.?mov|slow.?mov/.test(q);
    if (managerOnly && !can('reorder_suggestions')) return out('Reorder points, forecasts and slotting are manager reports. I can show your tasks, lots, the cold chain, pick routes or damage reports.');

    // ---- questions answered with SQL
    const canned = DEMO_SQL.find((d) => d.re.test(q));
    if (canned && can('query_database') && !oracle) return out(`${canned.purpose} is answered with an Oracle query, and this server runs without a database. Start Oracle (npm run db:up, npm run db:setup) to try it.`);
    if (canned && can('query_database')) {
      const r = await run<any>('query_database', { sql: canned.sql, purpose: canned.purpose });
      if (r.error) return out(`${canned.purpose}: ${r.error}`);
      return out(`**${canned.purpose}** — ${r.row_count} row(s), read from Oracle as ${r.ran_as} (${r.row_filter === 'none (all sites)' ? 'all sites' : `row filter ${r.row_filter}`}):\n${pick(r.rows as unknown[][], 10).map((row) => `- ${row.map((c) => c ?? '—').join(' · ')}`).join('\n')}`);
    }

    // ---- live operations
    if (/late|at risk|delay|alert|problem|issue|exception|wrong|attention/.test(q)) {
      const r = await run<any[]>('list_alerts', at);
      const first = r.find((a) => a.ref);
      if (first) box.actions.push({ type: 'focus', ref: first.ref });
      return out(r.length ? `**${r.length} thing(s) need attention:**\n${pick(r, 8).map((a) => `- ${a.severity === 'high' ? '**' : ''}${a.title}${a.severity === 'high' ? '**' : ''} — ${a.detail}${a.suggested_task ? ` → ${a.suggested_task}` : ''}`).join('\n')}${can('create_task') ? '\n\nCreate any of these tasks from the Alerts tab.' : ''}` : 'Nothing needs attention right now.');
    }
    if (/ship|port|vessel|berth|crane|terminal|container/.test(q)) {
      const r = await run<any>('get_port_status', {});
      return out(`**Port:** ${r.import_stack} boxes in the import stack, ${r.export_stack} in the export stack, ${r.crane_moves_today} crane moves today.\n${(r.ships as any[]).map((s) => `- ${s.name} (${s.line}): ${s.status.toLowerCase().replace(/_/g, ' ')}${s.berth ? ` at ${s.berth}` : ''} — ${s.discharged}/${s.to_discharge + s.discharged} discharged, ${s.loaded} loaded${s.on_hold ? ' · on hold' : ''}`).join('\n')}`);
    }
    if (/store|supermarket|shop|van|retail|shelf|shelves/.test(q)) {
      const r = await run<any>('get_store_stock', {});
      const low = (r.stores as any[]).flatMap((s) => (s.lines as any[]).filter((l) => l.on_shelf <= l.reorder_at).map((l) => `${s.name}: ${l.product} ${l.on_shelf}/${l.max}`));
      return out(`**${(r.stores as any[]).length} stores**, ${(r.open_orders as any[]).length} restock order(s) open, ${(r.vans_on_the_road as any[]).length} van(s) on the road.\n${low.length ? `Low shelves:\n${pick(low, 8).map((l) => `- ${l}`).join('\n')}` : 'No shelf is below its reorder point.'}`);
    }
    if (/import|export|gate/.test(q)) {
      const r = await run<any>('get_imports_exports', at);
      return out(`**Imports and exports today:**\n${(r.today as any[]).map((t) => `- ${t.site}: ${t.import_trucks} import trucks (${t.import_pallets} pallets), ${t.export_trucks} export trucks (${t.export_pallets} pallets)`).join('\n')}`);
    }
    if (/forklift|battery|charg/.test(q)) {
      const r = await run<any[]>('list_forklifts', at);
      return out(`**Forklifts at ${fac ?? box.home}:**\n${r.map((f) => `- ${f.forklift} (${f.operator}): ${f.battery_pct}% · ${f.status} — ${f.job}`).join('\n')}`);
    }
    if (/my (task|work|job)|what should i|todo|to do|work on/.test(q)) {
      const r = await run<any[]>('list_tasks', { ...at, mine: true });
      return out(r.length ? `**Your open tasks:**\n${r.map((t) => `- #${t.id} ${t.title} — ${t.priority.toLowerCase()}, ${t.status.toLowerCase().replace('_', ' ')}`).join('\n')}\n\nStart with the most urgent one.` : 'You have no open tasks.');
    }
    if (/task/.test(q)) {
      const r = await run<any[]>('list_tasks', at);
      return out(r.length ? `**Open tasks at ${fac ?? box.home}:**\n${pick(r, 10).map((t) => `- #${t.id} ${t.title} — ${t.assignee ?? 'unassigned'}, ${t.priority.toLowerCase()}, ${t.status.toLowerCase().replace('_', ' ')}`).join('\n')}` : 'No open tasks.');
    }
    if (/team|staff|who|people|busiest/.test(q) && can('list_team')) {
      const r = await run<any[]>('list_team', at);
      const sorted = [...r].sort((a, b) => b.open_tasks - a.open_tasks);
      return out(`**Team at ${fac ?? box.home}** (most open work first):\n${pick(sorted, 10).map((e) => `- ${e.name}, ${e.job}: ${e.open_tasks} open task(s)`).join('\n')}`);
    }
    if (/truck|dock|arriv|inbound|outbound/.test(q)) {
      const r = await run<any[]>('list_trucks', at);
      return out(`**Trucks at ${fac ?? box.home}:**\n${pick(r, 10).map((t) => `- ${t.truck} (${t.carrier}): ${t.status} — ${t.activity}`).join('\n')}`);
    }
    if (/how .*(doing|going)|overview|status|summary|kpi|today|site/.test(q)) {
      const r = await run<any>('get_site_overview', at);
      const low = (r.inventory as any[]).filter((l) => l.low);
      return out(`**${r.site}** at ${r.clock}:\n- ${n(r.stock_pallets)} pallets (${r.fill_pct}% full), ${r.stock_change_today >= 0 ? '+' : ''}${r.stock_change_today} today\n- ${r.trucks_on_site} trucks on site, ${r.trucks_inbound} inbound; docks ${r.docks_occupied}\n- On-time delivery ${r.on_time_delivery_pct}%\n${low.length ? `- Below reorder level: ${low.map((l) => l.product).join(', ')}` : '- No product below its reorder level'}`);
    }
    const lastTry = await fromDocs(question, 2.5);
    if (lastTry) return out(lastTry);
    const named = findEntities(box.w, question, user.facilities, 3);
    if (named.length === 1) {
      box.used.push('locate');
      box.actions.push({ type: 'focus', ref: named[0].ref });
      const info = inspectEntity(box.w, named[0].ref, user.facilities);
      if (!('error' in info)) return out(describe(info, named[0].ref));
    }
    return out([
      'I\'m running in **demo mode** (no Anthropic API key on the server), so I answer from built-in rules. Try:',
      `- "Is the cold chain OK?" · "Which lots expire soon?"${can('trace') ? ' · "Trace LOT-10050"' : ' · "What should I work on next?"'}`,
      ...(can('reorder_suggestions') ? ['- "What should we reorder?" · "Forecast for Nitrile Gloves" · "Show ABC slotting"'] : []),
      '- "Shortest pick route" · "Any reports of broken glass?" · "What needs attention?"',
      '- Anything in the city: "Where is the red bus?" · "Where is Ocean Star?" · click something and ask "what is this?"',
      '- How it works: "How does FEFO work?" · "Explain row-level security" · "What is the Smart Warehouse?"',
      ...(can('query_database') && oracle ? ['- From Oracle: "top products by demand" · "how many trucks" · "stock by supplier" · "latest audit changes"'] : []),
      '',
      'With `ANTHROPIC_API_KEY` in `.env`, Claude answers any question and writes its own SQL.',
    ].join('\n'));
  } catch (e) {
    return out((e as Error).message);
  }
}
