// Storage interface used by the API. OracleRepo is the system of record;
// MemoryRepo implements the same rules in-process for development and tests.
import type {
  WorldState, FacilityId, Truck, Shipment, Forklift, Pallet, Dock, Charger, Facility,
  Vessel, Berth, QuayCrane, Store, StoreLine, StoreOrder, DeliveryVan,
} from '../../src/data/types';
import type {
  SessionUser, Task, TaskUpdate, TaskStatus, TaskType, Priority, AuditEntry, Employee, UserRecord,
  SimControl, KpiRow, WorkloadRow, LowStockRow, Role, JobTitle, RoleInfo,
  ParkData, BuildingPatch, GateEntry, TradeRow, DbOverview, DbTableDetail, SqlResult, SqlActivity, DbLiveRow,
  ContainerMoveRow, VesselCallRow, StoreOrderRow,
} from '../../src/api/types';
import type { SimOp } from '../../src/sim/engine';

export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type StockOp = Extract<SimOp, { k: 'stock' }>;
export type EventOp = Extract<SimOp, { k: 'event' }>;
export type GateOp = Extract<SimOp, { k: 'gate' }>;
export type BoxOp = Extract<SimOp, { k: 'box' }>;
export type CallOp = Extract<SimOp, { k: 'call' }>;

export interface PersistBatch {
  world: WorldState;
  stock: StockOp[];
  events: EventOp[];
  gate: GateOp[];
  trucks: Truck[];
  shipments: Shipment[];
  forklifts: Forklift[];
  pallets: Pallet[];
  deletedPallets: string[];
  docks: Dock[];
  chargers: Charger[];
  facilities: Facility[];
  // container port
  box: BoxOp[];
  calls: CallOp[];
  vessels: Vessel[];
  berths: Berth[];
  cranes: QuayCrane[];
  // vendor stores and deliveries
  storeLines: { storeId: string; line: StoreLine }[];
  stores: Store[];
  orders: StoreOrder[];
  vans: DeliveryVan[];
}

export interface NewStoreOrder { id: string; storeId: string; skuId: string; units: number; facilityId: FacilityId; simTime: number }

export interface LoginRow { userId: number; username: string; passwordHash: string; active: boolean }
export interface SessionRow { userId: number; expiresAt: Date; revoked: boolean; remember: boolean }

export interface NewTask {
  facilityId: FacilityId;
  title: string;
  description: string;
  type: TaskType;
  priority: Priority;
  assigneeId: number | null;
  truckId?: string | null;
  dockId?: string | null;
  forkliftId?: string | null;
  shipmentId?: string | null;
  dueMinutes?: number | null;
  source: 'MANUAL' | 'SYSTEM';
}

export interface NewUser {
  username: string;
  passwordHash: string;
  role: Role;
  fullName: string;
  email: string;
  phone: string | null;
  jobCode: string;
  homeFacility: FacilityId | null;
  facilities: FacilityId[];
}

export interface UserPatch {
  role?: Role;
  active?: boolean;
  facilities?: FacilityId[];
  passwordHash?: string;
}

export interface TaskFilter {
  facilities: FacilityId[];
  assigneeId?: number;
  includeClosed?: boolean;
  limit?: number;
}

export interface AuditFilter {
  facilities: FacilityId[] | null; // null = all, including entries with no facility
  limit: number;
  beforeId?: number;
}

export interface Repo {
  readonly kind: 'oracle' | 'memory';
  init(): Promise<void>;
  close(): Promise<void>;

  // operations state
  loadWorld(): Promise<{ world: WorldState; control: SimControl; operators: Record<string, number> }>;
  persist(batch: PersistBatch): Promise<void>;
  saveControl(control: SimControl, userId: number | null): Promise<void>;

  // authentication & sessions
  findLogin(username: string): Promise<LoginRow | null>;
  recordLogin(userId: number | null, username: string, success: boolean): Promise<void>;
  createSession(sessionId: string, userId: number, days: number, agent: string): Promise<void>;
  getSession(sessionId: string): Promise<SessionRow | null>;
  extendSession(sessionId: string, days: number): Promise<void>;
  revokeSession(sessionId: string): Promise<void>;
  sessionUser(userId: number): Promise<SessionUser | null>;

  // people
  listUsers(): Promise<UserRecord[]>;
  createUser(adminId: number, input: NewUser): Promise<number>;
  updateUser(adminId: number, userId: number, patch: UserPatch): Promise<void>;
  listEmployees(facilities: FacilityId[] | null): Promise<Employee[]>;
  listJobTitles(): Promise<JobTitle[]>;
  listRoles(): Promise<RoleInfo[]>;

  // work
  listTasks(filter: TaskFilter): Promise<Task[]>;
  getTask(id: number): Promise<Task | null>;
  createTask(userId: number | null, input: NewTask): Promise<number>;
  changeTaskStatus(userId: number | null, taskId: number, status: TaskStatus, note: string | null): Promise<void>;
  assignTask(userId: number | null, taskId: number, assigneeId: number, note: string | null): Promise<void>;
  taskUpdates(taskId: number): Promise<TaskUpdate[]>;
  openSystemTasks(truckId: string): Promise<Task[]>;

  // history & reports
  listAudit(filter: AuditFilter): Promise<AuditEntry[]>;
  latestAuditId(): Promise<number>;
  kpis(facilities: FacilityId[]): Promise<KpiRow[]>;
  workload(facilities: FacilityId[]): Promise<WorkloadRow[]>;
  lowStock(facilities: FacilityId[]): Promise<LowStockRow[]>;

  // logistics park
  park(): Promise<ParkData>;
  updateBuilding(userId: number, buildingId: string, patch: BuildingPatch): Promise<void>;
  gateLog(facilities: FacilityId[], limit: number): Promise<GateEntry[]>;
  trade(facilities: FacilityId[]): Promise<TradeRow[]>;

  // container port and vendor stores (actions go through the WT_PORT / WT_RETAIL packages)
  setVesselHold(userId: number, vesselId: string, hold: boolean): Promise<void>;
  setBerthOpen(userId: number, berthId: string, open: boolean): Promise<void>;
  placeStoreOrder(userId: number, order: NewStoreOrder): Promise<void>;
  cancelStoreOrder(userId: number, orderId: string): Promise<void>;
  containerMoves(o: { limit: number; container?: string; vesselId?: string }): Promise<ContainerMoveRow[]>;
  vesselCalls(limit: number): Promise<VesselCallRow[]>;
  storeOrders(o: { storeId?: string; facilities: FacilityId[]; limit: number }): Promise<StoreOrderRow[]>;

  // database workspace
  dbOverview(): Promise<DbOverview>;
  dbTable(name: string): Promise<DbTableDetail>;
  runSql(userId: number, sql: string): Promise<SqlResult>;
  sqlActivity(): (SqlActivity & { source: SqlSource })[];
  /** Current row counts of the busiest tables (read live from the database). */
  liveCounts(tables: string[]): Promise<Record<string, number>>;
  /** One row read live by primary key. Table and key column come from LIVE_ROW_TABLES, never from the client. */
  liveRow(table: string, key: string, id: string): Promise<DbLiveRow | null>;
}

export type SqlSource = 'api' | 'sim' | 'live';

/** Tables whose row counts are shown in the live database feed. */
export const LIVE_COUNT_TABLES = [
  'TRUCKS', 'SHIPMENTS', 'PALLETS', 'FORKLIFTS', 'STOCK_MOVEMENTS', 'OPERATION_EVENTS', 'PARK_GATE_LOG',
  'TASKS', 'TASK_UPDATES', 'AUDIT_LOG', 'USER_SESSIONS', 'INVENTORY',
];

/** Selectable things in the 3D scene and the table/primary key that stores each one. */
export const LIVE_ROW_TABLES: Record<string, { table: string; key: string }> = {
  facility: { table: 'FACILITIES', key: 'FACILITY_ID' },
  truck: { table: 'TRUCKS', key: 'TRUCK_ID' },
  forklift: { table: 'FORKLIFTS', key: 'FORKLIFT_ID' },
  pallet: { table: 'PALLETS', key: 'PALLET_ID' },
  dock: { table: 'DOCKS', key: 'DOCK_ID' },
  charger: { table: 'CHARGERS', key: 'CHARGER_ID' },
  shipment: { table: 'SHIPMENTS', key: 'SHIPMENT_ID' },
  building: { table: 'PARK_BUILDINGS', key: 'BUILDING_ID' },
  vehicle: { table: 'PARK_VEHICLES', key: 'VEHICLE_ID' },
  gate: { table: 'PARK_GATES', key: 'GATE_CODE' },
};
