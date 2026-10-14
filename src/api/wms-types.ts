// Smart Warehouse API types (shared by the server and the web app).
import type { FacilityId, EntityRef } from '../data/types';

export type QcStatus = 'RELEASED' | 'HOLD' | 'RECALLED';
export type Source = 'oracle' | 'memory';
export type AbcClass = 'A' | 'B' | 'C';

/** Which Oracle features this database has (12_wms_optional.sql installs what it can). */
export interface WmsFeatures {
  engine: Source;
  installed: boolean;            // 10/11 present (tables, packages)
  partitioned: boolean;          // SENSOR_READINGS interval-partitioned
  partitions: number;
  blockchain: boolean;           // STOCK_LEDGER is a blockchain table
  vector: boolean;               // EMBEDDING columns are VECTOR
  queue: 'TEQ' | 'AQ' | null;    // CV_EVENTS
  jobs: string[];                // CV_* scheduler jobs
  graph: boolean;                // CV_WAREHOUSE_GRAPH property graph
  embedModel: string;            // model used for embeddings
  note: string | null;
}

export interface WmsSiteKpi {
  facilityId: FacilityId;
  bins: number;
  occupied: number;
  lots: number;
  held: number;
  expiring: number;            // released lots expiring within 30 days
  policy: 'RANDOM' | 'ABC';
  metresPerPick: number | null; // average of the last picks (round trip)
  expectedMetresPerPick: number | null;
  sensorsOk: number;
  sensorsOut: number;
}
export interface WmsOverview { source: Source; features: WmsFeatures; sites: WmsSiteKpi[]; events: WmsEvent[] }

export interface WmsEvent {
  id: string;
  type: string;          // LOT_RECEIVED, BREACH, RECALL, RELEASE, SCAN, DAMAGE, RESLOT, REORDER, FEFO_OVERRIDE, QC_CHANGE, DOOR
  facilityId: string | null;
  title: string;
  detail: string | null;
  refKind: string | null;
  refId: string | null;
  at: string;            // published (ISO)
  receivedAt: string;    // delivered to the server
  via: 'queue' | 'table' | 'memory';
}

/** One bin for the 3D view. Only occupied bins are listed. */
export interface BinCell {
  b: string;   // bin id
  s: string;   // sku
  l: string;   // lot
  u: number;   // units
  e: number | null; // days to expiry
  q: QcStatus;
  c: AbcClass | null;
}
export interface BinMap { facilityId: FacilityId; policy: 'RANDOM' | 'ABC'; cells: BinCell[]; blocked: string[] }

export interface AbcRow {
  facilityId: FacilityId; skuId: string; skuName: string; units30d: number; picks30d: number; sharePct: number; cumulativePct: number;
  rank: number; abc: AbcClass; avgDockMetres: number | null; pallets: number;
}
export interface AbcReport { source: Source; facilityId: FacilityId; policy: 'RANDOM' | 'ABC'; rows: AbcRow[]; expectedMetresPerPick: number | null; metresPerPick: number | null; sql: string }
export interface ReslotResult { facilityId: FacilityId; moved: number; beforeMetres: number; afterMetres: number; taskId: number | null; moves: { sscc: string; skuId: string; from: string; to: string }[] }

export interface LotRow {
  lotId: string; facilityId: FacilityId; skuId: string; skuName: string; supplier: string; shipmentId: string | null; containerNo: string | null;
  receivedAt: string; expiry: string | null; daysToExpiry: number | null; qc: QcStatus; qcReason: string | null; units: number; unitsReceived: number; pallets: number; fefoRank: number;
}
export interface LotsReport { source: Source; lots: LotRow[]; violations: FefoViolation[]; sql: string }
export interface FefoViolation { moveId: number; pickedAt: string; facilityId: string; skuId: string; pickedLot: string; pickedExpiry: string | null; olderLot: string; olderExpiry: string | null; units: number; ref: string | null }

export interface TraceNode { key: string; kind: string; id: string; label: string; depth: number; units: number | null; ref: EntityRef | null; parent: string | null }
export interface TraceReport { source: Source; root: { kind: string; id: string }; direction: 'down' | 'up'; nodes: TraceNode[]; stores: string[]; customers: string[]; sql: string }

export interface SensorStatus { id: string; facilityId: FacilityId; zone: 'AMBIENT' | 'COLD'; label: string; minC: number; maxC: number; doorOpen: boolean; tempC: number | null; at: string | null; status: 'OK' | 'WARN' | 'OUT' | 'NO DATA'; series: { t: string; c: number }[] }
export interface BreachRow { id: string; sensorId: string; facilityId: string; startedAt: string; endedAt: string | null; peakC: number; readings: number; lotsHeld: number; status: 'OPEN' | 'CLOSED' }
export interface ColdReport { source: Source; sensors: SensorStatus[]; breaches: BreachRow[]; held: LotRow[]; detector: string; sql: string; partitions: { name: string; rows: number | null; highValue: string }[] }

export interface LedgerRow { seq: number; moveId: number; lotId: string; facilityId: string; skuId: string; type: string; units: number; binId: string | null; refId: string | null; at: string; hash: string | null }
export interface LedgerReport {
  source: Source; kind: 'blockchain' | 'hash-chain' | 'plain'; rows: number; verified: number | null; ok: boolean | null; ms: number;
  recent: LedgerRow[]; tamper: { attempted: string; error: string | null; blocked: boolean } | null; sql: string; note: string | null;
}

export interface ForecastPoint { date: string; actual: number | null; forecast: number | null }
export interface ReplenishRow {
  facilityId: FacilityId; skuId: string; skuName: string; onHand: number; available: number; dailyDemand: number | null; dailySd: number | null; leadTimeDays: number;
  safetyStock: number | null; reorderPoint: number | null; eoq: number | null; daysOfCover: number | null; action: 'REORDER' | 'OK';
}
export interface ForecastReport { source: Source; facilityId: FacilityId; skuId: string; points: ForecastPoint[]; slopePerDay: number | null; weekday: number[]; replenish: ReplenishRow | null; sql: string }
export interface ReplenishReport { source: Source; rows: ReplenishRow[]; sql: string }

export interface ScanResult {
  valid: boolean; code: string; sscc: string | null; where: 'BIN' | 'YARD' | 'MOVING' | 'NONE' | null; result: string;
  binId?: string; palletId?: string; facilityId?: string; lotId?: string; skuId?: string; sku?: string; units?: number; expiry?: string | null;
  qc?: QcStatus; qcReason?: string | null; supplier?: string; fefoLot?: string | null; zone?: string; dockMetres?: number; source: Source;
}
export interface PalletLabel { sscc: string; binId: string | null; palletId: string | null; facilityId: FacilityId; skuId: string; lotId: string; units: number; expiry: string | null }

export interface RouteReport {
  source: Source; facilityId: FacilityId; dock: string; stops: { binId: string; nodeId: string; skuId: string | null }[];
  order: string[];            // node ids in visiting order
  path: { x: number; z: number }[];
  metres: number; naiveMetres: number; sql: string; graph: { ok: boolean; rows: number; sample: string[]; error: string | null; sql: string } | null;
}

export interface SearchHit { kind: 'DAMAGE' | 'PRODUCT'; id: string; title: string; text: string; facilityId: string | null; skuId: string | null; score: number; at: string | null; severity: string | null }
export interface SearchReport { source: Source; query: string; model: string; hits: SearchHit[]; ms: number; sql: string }
export interface DamageInput { facilityId: FacilityId; skuId: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'; text: string; sscc?: string | null; lotId?: string | null }
