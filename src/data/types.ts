// Domain types shared by the data adapter, the simulation and the UI.
// These mirror what a future SQL-backed API would return.

export type FacilityId = 'WH-01' | 'WH-02' | 'WH-04';
export type EntityKind =
  | 'facility' | 'truck' | 'forklift' | 'pallet' | 'dock' | 'charger' | 'asset' | 'building' | 'vehicle' | 'gate'
  | 'vessel' | 'crane' | 'berth' | 'store' | 'van';
export interface EntityRef {
  kind: EntityKind;
  id: string;
}

export interface Vec2 {
  x: number;
  z: number;
}

export type PalletLook = 'cardboard' | 'blue' | 'white';
export type SkuIcon = 'box' | 'container' | 'helmet' | 'tape' | 'panel' | 'chair' | 'gloves';

export interface Sku {
  id: string;
  name: string;
  category: string;
  unitsPerPallet: number;
  kgPerPallet: number;
  look: PalletLook;
  icon: SkuIcon;
}

export interface InventoryLine {
  skuId: string;
  units: number;
  lowBelow: number;
}

export interface Facility {
  id: FacilityId;
  name: string;
  shortName: string;
  kindLabel: string; // e.g. DEPOT
  address: string;
  capacity: number; // pallets
  stock: number; // pallets on hand
  stockStart: number; // at start of shift (for delta)
  outboundToday: number;
  putawaysToday: number;
  onTime30d: number;
  deliveries30d: number;
  otdPrevPct: number;
  trucksOnSiteStart: number;
  // goods through the park gates today (trucks and pallets)
  importsToday: number;
  importPalletsToday: number;
  exportsToday: number;
  exportPalletsToday: number;
  inventory: InventoryLine[];
}

export type DockKind = 'in' | 'out' | 'any';
export interface Dock {
  id: string;
  facilityId: FacilityId;
  name: string;
  kind: DockKind;
  description: string;
  truckId: string | null; // booked or occupying
  trucksToday: number;
}

export type Carrier = 'WareTrack' | 'Bluepeak' | 'Nordline' | 'Cargoviva';
export type TruckPhase =
  | 'en_route'
  | 'at_gate'
  | 'docking'
  | 'working'
  | 'ready'
  | 'departing'
  | 'leaving'
  | 'away';

export interface Leg {
  pts: Vec2[];
  reverse: boolean;
  speed: number; // units / real second
}

export interface Truck {
  id: string;
  facilityId: FacilityId;
  carrier: Carrier;
  driver: string;
  plate: string;
  direction: 'inbound' | 'outbound';
  phase: TruckPhase;
  dockId: string | null;
  shipmentId: string;
  capacity: number;
  cargo: number; // pallets currently on the truck
  skuId: string;
  legs: Leg[];
  legIdx: number;
  legDist: number;
  pos: Vec2;
  heading: number;
  speed: number; // units / real second (signed magnitude, >= 0)
  awayUntil: number; // real-time seconds
  forkliftId: string | null;
  /** SEA = this trip's container comes from / goes to the port terminal; ROAD = over the highway. */
  lane: TradeLane;
}

export type TradeLane = 'ROAD' | 'SEA';

export interface Shipment {
  id: string;
  truckId: string;
  facilityId: FacilityId;
  direction: 'inbound' | 'outbound';
  customer: string;
  destination: string;
  skuId: string;
  pallets: number;
  confirmedAt: number; // sim seconds of day
  pickedAt: number;
  loadedAt: number | null;
  transitAt: number | null;
  deliveredAt: number | null;
  promisedAt: number;
  transitMinutes: number;
  onTime: boolean | null;
  lane: TradeLane;
  containerNo: string | null; // sea freight: the container this shipment travels in
}

export type ForkliftTask =
  | 'idle'
  | 'charging'
  | 'to_pick'
  | 'lifting'
  | 'to_drop'
  | 'dropping'
  | 'to_home';

export type Spot =
  | { type: 'truck'; truckId: string }
  | { type: 'slot'; slot: number }
  | { type: 'store'; dockId: string };

export interface Forklift {
  id: string;
  facilityId: FacilityId;
  operator: string;
  model: string;
  battery: number;
  task: ForkliftTask;
  truckId: string | null;
  palletId: string | null;
  movesToday: number;
  chargerId: string;
  pos: Vec2;
  heading: number;
  speed: number;
  path: Vec2[];
  pathDist: number;
  timer: number;
  pick: Spot | null;
  drop: Spot | null;
}

export interface Pallet {
  id: string;
  facilityId: FacilityId;
  skuId: string;
  qty: number;
  weightKg: number;
  lot: string;
  received: string;
  slot: number | null; // staging slot index when staged
  forkliftId: string | null; // when being carried
  featured: boolean; // shown with a location pin
  reserved: boolean;
}

export interface Charger {
  id: string;
  facilityId: FacilityId;
  description: string;
  sessionsToday: number;
  energyKwh: number;
  ratePctPerMin: number;
}

export interface SimEvent {
  t: number; // sim seconds
  facilityId: FacilityId;
  text: string;
  ref?: EntityRef;
}

export interface WorldState {
  version: number;
  simTime: number; // seconds since midnight (simulated)
  realTime: number; // seconds of simulation run time
  nextShipment: number;
  nextPallet: number;
  facilities: Record<string, Facility>;
  docks: Record<string, Dock>;
  trucks: Record<string, Truck>;
  shipments: Record<string, Shipment>;
  forklifts: Record<string, Forklift>;
  pallets: Record<string, Pallet>;
  chargers: Record<string, Charger>;
  laneLock: Record<string, string | null>;
  events: SimEvent[];
  eventSeq: number;
  port: PortState;
  retail: RetailState;
}

// ---------------------------------------------------------------- container port
export type VesselStatus = 'AT_SEA' | 'ARRIVING' | 'ANCHORED' | 'BERTHING' | 'BERTHED' | 'DEPARTING';
export interface Vessel {
  id: string;
  name: string;
  line: string; // shipping line
  prefix: string; // container owner code, e.g. OSLU
  flag: string;
  imo: string;
  color: string;
  slot: number; // anchorage slot (keeps waiting ships apart)
  capacity: number; // boxes on deck
  through: number; // boxes aboard for other ports (stay on the ship)
  status: VesselStatus;
  berthId: string | null;
  dist: number; // along the current leg (approach / berthing / departure)
  pos: Vec2;
  heading: number;
  timer: number; // AT_SEA: real seconds until it approaches; BERTHED: settle / departure countdown
  importBoxes: number; // still to discharge here
  exportBoxes: number; // loaded here
  exportTarget: number;
  discharged: number; // this call
  loaded: number;
  hold: boolean; // held at anchor / alongside by the port manager
  waited: number; // real seconds spent at anchor (berths go to the longest-waiting ship)
  voyage: string; // current voyage number, e.g. 041E
  calls: number;
  arrivedAt: number | null; // sim time alongside
  origin: string;
  nextPort: string;
}
export interface Berth {
  id: string;
  name: string;
  x: number; // centre of the berth along the quay (park coordinates)
  open: boolean;
  vesselId: string | null; // alongside or reserved
}
export interface QuayCrane {
  id: string;
  berthId: string;
  offset: number; // x offset from the berth centre
  phase: 'idle' | 'discharge' | 'load';
  cycle: number; // 0..1 through one container move
  movesToday: number;
}
export interface PortLogEntry { t: number; text: string; ref?: EntityRef }
export interface PortState {
  importStack: string[]; // container numbers discharged, waiting for a truck (oldest first)
  exportStack: string[]; // container numbers delivered by truck, waiting for a ship
  yardCapacity: number; // per block
  movesToday: number;
  callsToday: number;
  gateOutToday: number;
  gateInToday: number;
  nextBox: number;
  extTimer: number;
  vessels: Record<string, Vessel>;
  berths: Record<string, Berth>;
  cranes: Record<string, QuayCrane>;
  log: PortLogEntry[];
}

// ---------------------------------------------------------------- vendor stores and deliveries
export type StoreKind = 'SUPERMARKET' | 'HARDWARE' | 'OFFICE' | 'PHARMACY' | 'CONVENIENCE';
export interface StoreLine {
  skuId: string;
  units: number;
  reorderAt: number;
  maxUnits: number;
  salesPerHour: number; // units per simulated hour
  acc: number; // fractional sales not yet taken off the shelf
  soldToday: number;
}
export interface Store {
  id: string;
  buildingId: string;
  name: string;
  chain: string;
  kind: StoreKind;
  facilityId: FacilityId; // usual supplying warehouse
  lines: StoreLine[];
  deliveriesToday: number;
}
export type StoreOrderStatus = 'PLACED' | 'LOADING' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED';
export interface StoreOrder {
  id: string;
  storeId: string;
  facilityId: FacilityId;
  skuId: string;
  units: number;
  status: StoreOrderStatus;
  source: 'AUTO' | 'MANUAL';
  placedBy: number | null;
  placedAt: number; // sim seconds
  dispatchedAt: number | null;
  deliveredAt: number | null;
  vanId: string | null;
}
export type VanStatus = 'IDLE' | 'LOADING' | 'TO_STORE' | 'UNLOADING' | 'RETURNING';
export interface DeliveryVan {
  id: string;
  facilityId: FacilityId;
  kind: 'VAN' | 'BOX_TRUCK';
  plate: string;
  driver: string;
  status: VanStatus;
  orderId: string | null;
  storeId: string | null;
  dist: number;
  timer: number;
  pos: Vec2;
  heading: number;
  tripsToday: number;
}
export interface RetailState {
  stores: Record<string, Store>;
  orders: Record<string, StoreOrder>;
  vans: Record<string, DeliveryVan>;
  nextOrder: number;
  log: PortLogEntry[];
}
