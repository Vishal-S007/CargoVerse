// Types shared by the browser client and the Node API server.
import type { FacilityId, EntityRef } from '../data/types';

export type Role = 'ADMIN' | 'MANAGER' | 'OPERATOR';

export type Permission =
  | 'VIEW_DASHBOARD'
  | 'VIEW_ALL_FACILITIES'
  | 'MANAGE_USERS'
  | 'VIEW_AUDIT'
  | 'MANAGE_TASKS'
  | 'UPDATE_OWN_TASKS'
  | 'CONTROL_SIMULATION'
  | 'VIEW_REPORTS'
  | 'VIEW_TEAM'
  | 'MANAGE_PARK'
  | 'VIEW_DATABASE'
  | 'RUN_SQL'
  | 'MANAGE_PORT'
  | 'MANAGE_RETAIL';

export interface SessionUser {
  userId: number;
  username: string;
  fullName: string;
  email: string;
  role: Role;
  roleName: string;
  jobCode: string;
  jobTitle: string;
  employeeId: number;
  homeFacility: FacilityId | null;
  facilities: FacilityId[];
  permissions: Permission[];
  forkliftId: string | null;
}

export type TaskStatus = 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED';
export type TaskType = 'UNLOAD' | 'LOAD' | 'PUTAWAY' | 'CYCLE_COUNT' | 'MAINTENANCE' | 'DOCK_CHECK' | 'OTHER';
export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export interface Task {
  id: number;
  facilityId: FacilityId;
  title: string;
  description: string;
  type: TaskType;
  priority: Priority;
  status: TaskStatus;
  source: 'MANUAL' | 'SYSTEM';
  assigneeId: number | null;
  assigneeName: string | null;
  createdById: number | null;
  createdByName: string;
  truckId: string | null;
  dockId: string | null;
  forkliftId: string | null;
  dueAt: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastNote: string | null;
}

export interface TaskUpdate {
  id: number;
  taskId: number;
  userId: number | null;
  userName: string;
  oldStatus: TaskStatus | null;
  newStatus: TaskStatus;
  note: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  userId: number | null;
  username: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  facilityId: FacilityId | null;
  details: string | null;
}

export interface Employee {
  id: number;
  fullName: string;
  email: string;
  phone: string | null;
  jobCode: string;
  jobTitle: string;
  facilityId: FacilityId | null;
  status: 'ACTIVE' | 'ON_LEAVE' | 'INACTIVE';
  userId: number | null;
  username: string | null;
  role: Role | null;
  forkliftId: string | null;
  openTasks: number;
}

export interface UserRecord {
  id: number;
  username: string;
  role: Role;
  active: boolean;
  employeeId: number;
  fullName: string;
  email: string;
  jobCode: string;
  jobTitle: string;
  facilities: FacilityId[];
  lastLoginAt: string | null;
  createdAt: string;
}

export interface JobTitle { code: string; title: string; responsibilities: string }
export interface RoleInfo { code: Role; name: string; description: string; permissions: Permission[] }

export interface SimControl { paused: boolean; speed: number }

export interface KpiRow {
  facilityId: FacilityId;
  name: string;
  stock: number;
  capacity: number;
  fillPct: number;
  trucksOnSite: number;
  inbound: number;
  otdPct: number;
  deliveries30d: number;
  openTasks: number;
  lowStockLines: number;
}

export interface WorkloadRow { employeeId: number; fullName: string; jobTitle: string; facilityId: FacilityId | null; open: number; inProgress: number; doneToday: number }
export interface LowStockRow { facilityId: FacilityId; skuId: string; skuName: string; units: number; reorderLevel: number }

export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  OPEN: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['BLOCKED', 'DONE', 'CANCELLED'],
  BLOCKED: ['IN_PROGRESS', 'CANCELLED'],
  DONE: [],
  CANCELLED: [],
};

/** Transitions an operator may make on a task assigned to them. */
export const OPERATOR_TRANSITIONS: Partial<Record<TaskStatus, TaskStatus[]>> = {
  ASSIGNED: ['IN_PROGRESS'],
  IN_PROGRESS: ['BLOCKED', 'DONE'],
  BLOCKED: ['IN_PROGRESS'],
};

// ---------------------------------------------------------------- logistics park
import type { ParkCompany, ParkBuilding, ParkVehicle, BuildingStatus, GateCode } from '../data/park';
export interface ParkData { companies: ParkCompany[]; buildings: ParkBuilding[]; vehicles: ParkVehicle[] }
export interface BuildingPatch { status?: BuildingStatus; staff?: number; leaseEnd?: string }

export interface GateEntry {
  id: number;
  at: string; // timestamp
  simTime: number;
  gate: GateCode;
  direction: 'IN' | 'OUT';
  trade: 'IMPORT' | 'EXPORT' | 'EMPTY';
  truckId: string;
  carrier: string;
  facilityId: FacilityId;
  shipmentId: string | null;
  skuId: string | null;
  skuName: string | null;
  pallets: number;
}

export interface TradeRow {
  facilityId: FacilityId;
  name: string;
  importTrucks: number;
  importPallets: number;
  exportTrucks: number;
  exportPallets: number;
  emptyMoves: number;
}

// ---------------------------------------------------------------- database workspace
export interface DbColumn { name: string; type: string; nullable: boolean; defaultValue: string | null; comment?: string | null }
export interface DbConstraint { name: string; type: 'PRIMARY KEY' | 'FOREIGN KEY' | 'UNIQUE' | 'CHECK'; columns: string; detail: string }
export interface DbTable { name: string; rows: number; group: string; comment: string }
export interface DbObject { name: string; type: string; status: string }
export interface DbOverview {
  mode: 'oracle' | 'memory';
  engine: string;
  schema: string;
  tables: DbTable[];
  objects: DbObject[];
  note?: string;
}
export interface DbTableDetail {
  name: string;
  columns: DbColumn[];
  constraints: DbConstraint[];
  indexes: { name: string; columns: string; unique: boolean }[];
  sample: { columns: string[]; rows: unknown[][] };
}
export interface SqlResult { columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean; ms: number; statement: string }
/** A read-only query the AI assistant ran as the user's own database account (row-level security applies). */
export interface AiQueryResult extends SqlResult { account: string; filter: string | null }
export interface TableInfo { table: string; comment: string | null; columns: { name: string; type: string; comment: string | null }[] }
/** AI operations assistant (server/assistant.ts). */
export type XrayMode = 'sku' | 'abc' | 'expiry' | 'qc';
export type AssistantAction =
  | { type: 'focus'; ref: EntityRef }
  | { type: 'xray'; facility: FacilityId; mode?: XrayMode; highlight?: string[]; route?: { facility: FacilityId; path: { x: number; z: number }[]; stops: string[] } | null };
export interface AssistantQuery { purpose: string; sql: string; account: string | null; filter: string | null; columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean; ms: number; error: string | null }
export interface AssistantReply { reply: string; actions: AssistantAction[]; tools: string[]; queries: AssistantQuery[]; mode: 'claude' | 'demo' }

export interface AssistantStatus { configured: boolean; mode: 'claude' | 'demo'; model: string; oracle: boolean }

export interface SqlActivity { at: string; ms: number; rows: number; ok: boolean; sql: string; error?: string }
/** Live write-through status of the database, streamed with every snapshot. */
export interface DbLiveStatus {
  engine: 'oracle' | 'memory';
  commits: number;          // successful write transactions since the server started
  failures: number;
  rowsWritten: number;
  lastCommitAt: string | null;
  lastCommitMs: number;
  lastRows: number;
  lastTables: Record<string, number>;
  lastError: string | null;
  lastErrorAt: string | null;
}
export interface DbCommit { seq: number; at: string; ms: number; rows: number; tables: Record<string, number>; ok: boolean; error?: string }
export interface DbLive {
  status: DbLiveStatus;
  target: string;           // e.g. waretrack@localhost:1521/FREEPDB1
  commits: DbCommit[];
  counts: Record<string, number>;
  countsAt: string;
  statements: (SqlActivity & { source: string })[];
}
export interface DbLiveRow { engine: 'oracle' | 'memory'; table: string; key: string; id: string; sql: string; fetchedAt: string; ms: number; columns: string[]; values: unknown[] }
export interface SavedQuery { id: string; title: string; description: string; sql: string }

// ---------------------------------------------------------------- container port and vendor stores (history from the database)
export interface ContainerMoveRow {
  id: number;
  at: string;
  simTime: number;
  containerNo: string;
  line: string;
  move: 'DISCHARGE' | 'LOAD' | 'GATE_OUT' | 'GATE_IN';
  vesselId: string | null;
  vesselName: string | null;
  craneId: string | null;
  truckId: string | null;
  facilityId: string | null;
}
export interface VesselCallRow {
  id: number;
  vesselId: string;
  vesselName: string;
  voyage: string;
  berthId: string;
  arrivedAt: string;
  departedAt: string | null;
  discharged: number;
  loaded: number;
  status: 'ALONGSIDE' | 'COMPLETED';
}
export interface StoreOrderRow {
  id: string;
  status: string;
  source: 'AUTO' | 'MANUAL';
  storeId: string;
  storeName: string;
  skuId: string;
  units: number;
  facilityId: string;
  vanId: string | null;
  placedBy: string | null;
  placedAt: string;
  dispatchedAt: string | null;
  deliveredAt: string | null;
}

// ---------------------------------------------------------------- Database Lab
/** A change made outside the CargoVerse server, queued by a trigger in DB_COMMANDS. */
export interface ExternalCommand {
  id: number;
  table: 'PORT_BERTHS' | 'VESSELS' | 'STORE_STOCK' | 'FORKLIFTS' | 'SIM_STATE' | 'PARK_BUILDINGS' | 'TASKS';
  key: string;
  column: string;
  oldValue: string | null;
  newValue: string | null;
  dbUser: string;
  program: string | null;
  host: string | null;
  at: string; // when the row was changed (ISO)
}
/** The same change after the server applied it to the live city. */
export interface SqlFeedItem extends ExternalCommand {
  status: 'APPLIED' | 'REJECTED';
  message: string;
  appliedAt: string;
  ref: EntityRef | null;
}

export interface LabStatus {
  engine: 'oracle' | 'memory';
  /** Live control from SQL: the DB_COMMANDS queue and its triggers exist. */
  control: boolean;
  flashback: boolean;
  flashbackMaxS: number;
  historyFrames: number;
  oldestFrameAt: string | null;
  concurrency: boolean;
  vpd: { installed: boolean; accounts: string[]; tables: string[]; reason: string | null };
  connect: { host: string; port: number; service: string; schema: string };
  /** Password of the demo database accounts (shown to administrators only). */
  accountPassword: string | null;
}

export interface RowVersion {
  from: string | null; // when this version became current (ISO); null = before the window
  to: string | null;   // when it was replaced; null = still current
  op: 'I' | 'U' | 'D' | null;
  values: Record<string, string | number | null>;
  versions: number;    // how many raw row versions this entry covers (consecutive ones with the same values)
}
export interface RowHistory { kind: string; id: string; table: string; columns: string[]; source: 'flashback' | 'memory'; sql: string | null; entries: RowVersion[]; note?: string }

export interface VpdAccount {
  account: string;
  appUser: string;
  role: string;
  sites: string[];          // what the policy allows
  predicate: string | null; // the WHERE clause Oracle adds (null = no filter)
  counts: Record<string, number>;
  sitesSeen: string[];      // DISTINCT facility_id actually returned to that account
  error?: string;
  ms: number;
}
export interface VpdReport { source: 'oracle' | 'simulated'; tables: string[]; owner: Record<string, number>; accounts: VpdAccount[]; at: string; sql: string }

export type LabScenario = 'double_booking' | 'lost_update' | 'safe_update' | 'deadlock';
export interface LabStep {
  session: 'A' | 'B' | 'DB';
  t: number;  // ms from the start of the run
  end?: number; // for waits: when the wait ended
  kind: 'sql' | 'ok' | 'error' | 'wait' | 'info' | 'commit' | 'rollback';
  text: string;
  sql?: string;
}
export interface LabRun {
  scenario: LabScenario;
  title: string;
  source: 'oracle' | 'simulated';
  steps: LabStep[];
  verdict: 'protected' | 'anomaly' | 'detected';
  outcome: string;
  final: { label: string; value: string }[];
  ms: number;
}
export interface ExternalSqlResult { statement: string; rowsAffected: number; ms: number; queued: number; source: 'oracle' | 'simulated' }
