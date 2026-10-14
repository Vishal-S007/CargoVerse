// Deterministic demonstration data. Values that were legible in the reference
// recording are used as-is; everything else is a conservative assumption.
import type {
  WorldState, Facility, Dock, Truck, Shipment, Forklift, Charger, Sku, FacilityId, Carrier,
} from './types';
import { LAYOUTS } from './layouts';
import { legRoadIn, legYardIn, legReverseIn, pathLength, ROAD_SPEED } from '../sim/paths';
import { seedPort, seedRetail } from './city';

export const WORLD_VERSION = 6;
export const SIM_START = hm('09:40');

export function hm(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 3600 + m * 60;
}

export const SKUS: Record<string, Sku> = {
  'BOX-M': { id: 'BOX-M', name: 'Cardboard Box (M)', category: 'Packaging', unitsPerPallet: 60, kgPerPallet: 180, look: 'cardboard', icon: 'box' },
  'CNT-P': { id: 'CNT-P', name: 'Plastic Container', category: 'Storage', unitsPerPallet: 24, kgPerPallet: 140, look: 'blue', icon: 'container' },
  'PPE-HLM-Y': { id: 'PPE-HLM-Y', name: 'Safety Helmet', category: 'PPE', unitsPerPallet: 82, kgPerPallet: 56, look: 'cardboard', icon: 'helmet' },
  'PKG-TAPE': { id: 'PKG-TAPE', name: 'Packing Tape', category: 'Packaging', unitsPerPallet: 144, kgPerPallet: 96, look: 'cardboard', icon: 'tape' },
  'LED-6060': { id: 'LED-6060', name: 'LED Panel 60×60', category: 'Lighting', unitsPerPallet: 40, kgPerPallet: 210, look: 'white', icon: 'panel' },
  'CHR-OFC': { id: 'CHR-OFC', name: 'Office Chair', category: 'Furniture', unitsPerPallet: 12, kgPerPallet: 160, look: 'cardboard', icon: 'chair' },
  'GLV-NIT': { id: 'GLV-NIT', name: 'Nitrile Gloves', category: 'PPE', unitsPerPallet: 200, kgPerPallet: 120, look: 'blue', icon: 'gloves' },
};

/** Short display name of a carrier ('WareTrack' is the database key of the company's own fleet, shown as CargoVerse). */
export const carrierName = (c: string): string => (c === 'WareTrack' ? 'CargoVerse' : c);

export const CARRIER_LABEL: Record<Carrier, string> = {
  WareTrack: 'CargoVerse Freight',
  Bluepeak: 'Bluepeak',
  Nordline: 'Nordline Logistics',
  Cargoviva: 'Cargoviva',
};

function facility(f: Omit<Facility, 'stockStart'> & { delta: number }): Facility {
  const { delta, ...rest } = f;
  return { ...rest, stockStart: f.stock - delta };
}

const FACILITIES: Facility[] = [
  facility({
    id: 'WH-01', name: 'Riverside Hub', shortName: 'Riverside', kindLabel: 'Depot', address: '12 Riverside Dr, Newark NJ',
    capacity: 1800, stock: 1412, delta: 15, outboundToday: 23, putawaysToday: 15,
    onTime30d: 966, deliveries30d: 1000, otdPrevPct: 96.2, trucksOnSiteStart: 0,
    importsToday: 9, importPalletsToday: 54, exportsToday: 12, exportPalletsToday: 71,
    inventory: [
      { skuId: 'BOX-M', units: 1906, lowBelow: 600 },
      { skuId: 'CNT-P', units: 297, lowBelow: 120 },
      { skuId: 'PPE-HLM-Y', units: 212, lowBelow: 250 },
      { skuId: 'PKG-TAPE', units: 4448, lowBelow: 800 },
    ],
  }),
  facility({
    id: 'WH-04', name: 'Southfield Cross-Dock', shortName: 'Southfield', kindLabel: 'Cross-dock', address: '2200 Telegraph Rd, Southfield MI',
    capacity: 1600, stock: 610, delta: 20, outboundToday: 31, putawaysToday: 18,
    onTime30d: 962, deliveries30d: 1000, otdPrevPct: 95.8, trucksOnSiteStart: 0,
    importsToday: 17, importPalletsToday: 128, exportsToday: 15, exportPalletsToday: 96,
    inventory: [
      { skuId: 'LED-6060', units: 1240, lowBelow: 300 },
      { skuId: 'BOX-M', units: 860, lowBelow: 600 },
      { skuId: 'CNT-P', units: 410, lowBelow: 120 },
      { skuId: 'GLV-NIT', units: 2600, lowBelow: 800 },
    ],
  }),
  facility({
    id: 'WH-02', name: 'Northgate DC', shortName: 'Northgate', kindLabel: 'Distribution center', address: '480 Northgate Blvd, Newark NJ',
    capacity: 4200, stock: 3310, delta: 35, outboundToday: 21, putawaysToday: 35,
    onTime30d: 982, deliveries30d: 1000, otdPrevPct: 97.8, trucksOnSiteStart: 1,
    importsToday: 14, importPalletsToday: 88, exportsToday: 10, exportPalletsToday: 63,
    inventory: [
      { skuId: 'LED-6060', units: 1787, lowBelow: 300 },
      { skuId: 'CHR-OFC', units: 174, lowBelow: 60 },
      { skuId: 'BOX-M', units: 993, lowBelow: 1000 },
      { skuId: 'GLV-NIT', units: 5793, lowBelow: 800 },
    ],
  }),
];

const DOCKS: Dock[] = [
  { id: 'WH-01-B1', facilityId: 'WH-01', name: 'Bay 1', kind: 'any', description: 'Dock door with leveler', truckId: 'TRK-2051', trucksToday: 6 },
  { id: 'WH-01-B2', facilityId: 'WH-01', name: 'Bay 2', kind: 'any', description: 'Dock door with leveler', truckId: null, trucksToday: 4 },
  { id: 'WH-04-I1', facilityId: 'WH-04', name: 'In 1', kind: 'in', description: 'Dock door with leveler', truckId: 'TRK-2205', trucksToday: 4 },
  { id: 'WH-04-I2', facilityId: 'WH-04', name: 'In 2', kind: 'in', description: 'Dock door with leveler', truckId: 'TRK-2481', trucksToday: 5 },
  { id: 'WH-04-I3', facilityId: 'WH-04', name: 'In 3', kind: 'in', description: 'Dock door with leveler', truckId: 'TRK-2307', trucksToday: 3 },
  { id: 'WH-04-O1', facilityId: 'WH-04', name: 'Out 1', kind: 'out', description: 'Dock door with leveler', truckId: null, trucksToday: 4 },
  { id: 'WH-04-O2', facilityId: 'WH-04', name: 'Out 2', kind: 'out', description: 'Dock door with leveler', truckId: 'TRK-2229', trucksToday: 3 },
  { id: 'WH-04-O3', facilityId: 'WH-04', name: 'Out 3', kind: 'out', description: 'Dock door with leveler', truckId: null, trucksToday: 2 },
  { id: 'WH-02-B1', facilityId: 'WH-02', name: 'Bay 1', kind: 'any', description: 'Dock door with leveler', truckId: 'TRK-2104', trucksToday: 5 },
  { id: 'WH-02-B2', facilityId: 'WH-02', name: 'Bay 2', kind: 'any', description: 'Dock door with leveler', truckId: 'TRK-2658', trucksToday: 4 },
  { id: 'WH-02-B3', facilityId: 'WH-02', name: 'Bay 3', kind: 'any', description: 'Dock door with leveler', truckId: 'TRK-2127', trucksToday: 5 },
  { id: 'WH-02-B4', facilityId: 'WH-02', name: 'Bay 4', kind: 'any', description: 'Dock door with leveler', truckId: null, trucksToday: 3 },
];

interface TruckSeed {
  id: string; fac: FacilityId; carrier: Carrier; driver: string; plate: string;
  dir: 'inbound' | 'outbound'; phase: 'en_route' | 'docking' | 'working';
  dock: string | null; cap: number; done: number; sku: string;
  remaining?: number; // en_route: distance left on the road
  dockLeg?: number; dockDist?: number; // docking progress
  ship: Omit<Shipment, 'truckId' | 'facilityId' | 'direction' | 'skuId' | 'pallets' | 'onTime' | 'lane' | 'containerNo'>;
}

const TRUCKS: TruckSeed[] = [
  {
    id: 'TRK-2051', fac: 'WH-01', carrier: 'WareTrack', driver: 'Marcus Hill', plate: 'NJ-4KD281', dir: 'outbound', phase: 'working',
    dock: 'WH-01-B1', cap: 6, done: 2, sku: 'BOX-M',
    ship: { id: 'SHP-78442', customer: 'Liberty Supply Co.', destination: 'Philadelphia, PA', confirmedAt: hm('06:48'), pickedAt: hm('08:18'), loadedAt: null, transitAt: null, deliveredAt: null, promisedAt: hm('10:33'), transitMinutes: 32 },
  },
  {
    id: 'TRK-2287', fac: 'WH-01', carrier: 'Bluepeak', driver: 'Priya Nair', plate: 'PA-7HT904', dir: 'inbound', phase: 'en_route',
    dock: null, cap: 6, done: 0, sku: 'PKG-TAPE', remaining: 150,
    ship: { id: 'SHP-78447', customer: 'Keystone Paper', destination: 'WH-01 Riverside Hub', confirmedAt: hm('05:55'), pickedAt: hm('07:10'), loadedAt: hm('07:42'), transitAt: hm('07:58'), deliveredAt: null, promisedAt: hm('10:20'), transitMinutes: 0 },
  },
  {
    id: 'TRK-2205', fac: 'WH-04', carrier: 'WareTrack', driver: 'Sam Chen', plate: 'ZBY-5648', dir: 'inbound', phase: 'working',
    dock: 'WH-04-I1', cap: 6, done: 2, sku: 'LED-6060',
    ship: { id: 'SHP-78450', customer: 'Oakridge Market', destination: 'WH-04 Southfield Cross-Dock', confirmedAt: hm('06:58'), pickedAt: hm('08:25'), loadedAt: hm('09:11'), transitAt: hm('09:37'), deliveredAt: null, promisedAt: hm('10:05'), transitMinutes: 0 },
  },
  {
    id: 'TRK-2229', fac: 'WH-04', carrier: 'Nordline', driver: 'Noah Tanaka', plate: 'CRX-5820', dir: 'outbound', phase: 'working',
    dock: 'WH-04-O2', cap: 6, done: 3, sku: 'BOX-M',
    ship: { id: 'SHP-78452', customer: 'Harbor & Co.', destination: 'Providence, RI', confirmedAt: hm('07:07'), pickedAt: hm('08:28'), loadedAt: null, transitAt: null, deliveredAt: null, promisedAt: hm('10:55'), transitMinutes: 34 },
  },
  {
    id: 'TRK-2307', fac: 'WH-04', carrier: 'Nordline', driver: 'Ada Larsen', plate: 'EKT-2897', dir: 'inbound', phase: 'docking',
    dock: 'WH-04-I3', cap: 8, done: 0, sku: 'CNT-P', dockLeg: 1, dockDist: 4,
    ship: { id: 'SHP-78456', customer: 'Sunvale Grocers', destination: 'WH-04 Southfield Cross-Dock', confirmedAt: hm('06:37'), pickedAt: hm('08:31'), loadedAt: hm('09:12'), transitAt: hm('09:26'), deliveredAt: null, promisedAt: hm('10:25'), transitMinutes: 0 },
  },
  {
    id: 'TRK-2481', fac: 'WH-04', carrier: 'Cargoviva', driver: 'Alex Haddad', plate: 'WKH-3157', dir: 'inbound', phase: 'en_route',
    dock: 'WH-04-I2', cap: 10, done: 0, sku: 'GLV-NIT', remaining: 120,
    ship: { id: 'SHP-78466', customer: 'Halcyon Retail', destination: 'WH-04 Southfield Cross-Dock', confirmedAt: hm('07:04'), pickedAt: hm('08:29'), loadedAt: hm('09:13'), transitAt: hm('09:27'), deliveredAt: null, promisedAt: hm('10:25'), transitMinutes: 0 },
  },
  {
    id: 'TRK-2127', fac: 'WH-02', carrier: 'Bluepeak', driver: 'Lena Ortiz', plate: 'NJ-2PL554', dir: 'outbound', phase: 'working',
    dock: 'WH-02-B3', cap: 7, done: 4, sku: 'LED-6060',
    ship: { id: 'SHP-78441', customer: 'Metro Office Supply', destination: 'Hoboken, NJ', confirmedAt: hm('06:20'), pickedAt: hm('08:02'), loadedAt: null, transitAt: null, deliveredAt: null, promisedAt: hm('10:40'), transitMinutes: 28 },
  },
  {
    id: 'TRK-2104', fac: 'WH-02', carrier: 'Nordline', driver: 'Omar Diaz', plate: 'NY-8RC117', dir: 'inbound', phase: 'working',
    dock: 'WH-02-B1', cap: 5, done: 1, sku: 'CHR-OFC',
    ship: { id: 'SHP-78444', customer: 'Atlas Furnishings', destination: 'WH-02 Northgate DC', confirmedAt: hm('06:43'), pickedAt: hm('08:20'), loadedAt: hm('09:15'), transitAt: hm('09:41'), deliveredAt: null, promisedAt: hm('10:00'), transitMinutes: 0 },
  },
  {
    id: 'TRK-2658', fac: 'WH-02', carrier: 'Cargoviva', driver: 'Jonas Weber', plate: 'PA-3MV620', dir: 'inbound', phase: 'docking',
    dock: 'WH-02-B2', cap: 6, done: 0, sku: 'GLV-NIT', dockLeg: 0, dockDist: 30,
    ship: { id: 'SHP-78448', customer: 'Brightline Medical', destination: 'WH-02 Northgate DC', confirmedAt: hm('06:51'), pickedAt: hm('08:12'), loadedAt: hm('08:57'), transitAt: hm('09:08'), deliveredAt: null, promisedAt: hm('10:15'), transitMinutes: 0 },
  },
  {
    id: 'TRK-2526', fac: 'WH-02', carrier: 'WareTrack', driver: 'Grace Kim', plate: 'NJ-9WT338', dir: 'outbound', phase: 'en_route',
    dock: null, cap: 6, done: 0, sku: 'GLV-NIT', remaining: 95,
    ship: { id: 'SHP-78449', customer: 'Hudson Clinics', destination: 'Jersey City, NJ', confirmedAt: hm('07:30'), pickedAt: hm('09:05'), loadedAt: null, transitAt: null, deliveredAt: null, promisedAt: hm('11:05'), transitMinutes: 26 },
  },
  {
    id: 'TRK-2310', fac: 'WH-01', carrier: 'Cargoviva', driver: 'Hugo Martins', plate: 'NJ-6CV412', dir: 'inbound', phase: 'en_route',
    dock: null, cap: 8, done: 0, sku: 'CNT-P', remaining: 520,
    ship: { id: 'SHP-78451', customer: 'Sunvale Grocers', destination: 'WH-01 Riverside Hub', confirmedAt: hm('06:10'), pickedAt: hm('07:35'), loadedAt: hm('08:20'), transitAt: hm('08:44'), deliveredAt: null, promisedAt: hm('10:45'), transitMinutes: 0 },
  },
  {
    id: 'TRK-2333', fac: 'WH-01', carrier: 'WareTrack', driver: 'Ruth Adeyemi', plate: 'NJ-3WT905', dir: 'outbound', phase: 'en_route',
    dock: null, cap: 6, done: 0, sku: 'PKG-TAPE', remaining: 300,
    ship: { id: 'SHP-78453', customer: 'Crestline Hardware', destination: 'Stamford, CT', confirmedAt: hm('07:12'), pickedAt: hm('08:50'), loadedAt: null, transitAt: null, deliveredAt: null, promisedAt: hm('11:20'), transitMinutes: 36 },
  },
  {
    id: 'TRK-2402', fac: 'WH-04', carrier: 'WareTrack', driver: 'Felix Braun', plate: 'MI-4WT220', dir: 'outbound', phase: 'en_route',
    dock: null, cap: 8, done: 0, sku: 'GLV-NIT', remaining: 330,
    ship: { id: 'SHP-78457', customer: 'Bayview Foods', destination: 'Wilmington, DE', confirmedAt: hm('07:02'), pickedAt: hm('08:40'), loadedAt: null, transitAt: null, deliveredAt: null, promisedAt: hm('11:10'), transitMinutes: 30 },
  },
  {
    id: 'TRK-2415', fac: 'WH-04', carrier: 'Bluepeak', driver: 'Nadia Petrova', plate: 'OH-8BP377', dir: 'inbound', phase: 'en_route',
    dock: null, cap: 8, done: 0, sku: 'BOX-M', remaining: 640,
    ship: { id: 'SHP-78459', customer: 'Keystone Paper', destination: 'WH-04 Southfield Cross-Dock', confirmedAt: hm('06:30'), pickedAt: hm('08:05'), loadedAt: hm('08:52'), transitAt: hm('09:10'), deliveredAt: null, promisedAt: hm('10:50'), transitMinutes: 0 },
  },
  {
    id: 'TRK-2611', fac: 'WH-02', carrier: 'Bluepeak', driver: 'Ethan Cole', plate: 'NJ-5BP661', dir: 'inbound', phase: 'en_route',
    dock: null, cap: 7, done: 0, sku: 'LED-6060', remaining: 450,
    ship: { id: 'SHP-78461', customer: 'Brightline Medical', destination: 'WH-02 Northgate DC', confirmedAt: hm('06:44'), pickedAt: hm('08:15'), loadedAt: hm('08:58'), transitAt: hm('09:14'), deliveredAt: null, promisedAt: hm('10:40'), transitMinutes: 0 },
  },
];

interface ForkSeed {
  id: string; fac: FacilityId; op: string; model: string; battery: number; charger: string;
  moves: number; work?: { truck: string; task: 'to_pick' | 'to_drop'; at: { x: number; z: number }; pallet?: { id: string; sku: string }; pick?: Forklift['pick']; drop?: Forklift['drop'] };
}

const FORKS: ForkSeed[] = [
  { id: 'FL-01', fac: 'WH-01', op: 'Dana Brooks', model: 'Toyota 8FBE20', battery: 75, charger: 'WH-01-C1', moves: 27,
    work: { truck: 'TRK-2051', task: 'to_drop', at: { x: -2, z: 16 }, pallet: { id: 'PAL-1040', sku: 'BOX-M' }, drop: { type: 'truck', truckId: 'TRK-2051' } } },
  { id: 'FL-02', fac: 'WH-01', op: 'Luis Romero', model: 'Toyota 8FBE20', battery: 64, charger: 'WH-01-C2', moves: 19 },
  { id: 'FL-10', fac: 'WH-04', op: 'Zoe Reyes', model: 'Jungheinrich EFG 216', battery: 84, charger: 'WH-04-C1', moves: 38,
    work: { truck: 'TRK-2205', task: 'to_drop', at: { x: -36, z: 16 }, pallet: { id: 'PAL-1060', sku: 'LED-6060' }, drop: { type: 'slot', slot: 2 } } },
  { id: 'FL-11', fac: 'WH-04', op: 'Ben Okafor', model: 'Jungheinrich EFG 216', battery: 82, charger: 'WH-04-C2', moves: 31,
    work: { truck: 'TRK-2229', task: 'to_pick', at: { x: 30, z: 16 }, pick: { type: 'store', dockId: 'WH-04-O2' } } },
  { id: 'FL-12', fac: 'WH-04', op: 'Mia Park', model: 'Jungheinrich EFG 216', battery: 85, charger: 'WH-04-C3', moves: 22 },
  { id: 'FL-13', fac: 'WH-04', op: 'Theo Grant', model: 'Jungheinrich EFG 216', battery: 92, charger: 'WH-04-C4', moves: 26 },
  { id: 'FL-14', fac: 'WH-04', op: 'Ivy Chen', model: 'Jungheinrich EFG 216', battery: 71, charger: 'WH-04-C5', moves: 17 },
  { id: 'FL-03', fac: 'WH-02', op: 'Carla Mendes', model: 'Linde E20', battery: 78, charger: 'WH-02-C1', moves: 33,
    work: { truck: 'TRK-2127', task: 'to_drop', at: { x: 10, z: 16 }, pallet: { id: 'PAL-1080', sku: 'LED-6060' }, drop: { type: 'truck', truckId: 'TRK-2127' } } },
  { id: 'FL-04', fac: 'WH-02', op: 'Ravi Shah', model: 'Linde E20', battery: 66, charger: 'WH-02-C2', moves: 24,
    work: { truck: 'TRK-2104', task: 'to_pick', at: { x: -24, z: 16 }, pick: { type: 'truck', truckId: 'TRK-2104' } } },
  { id: 'FL-05', fac: 'WH-02', op: 'Kofi Mensah', model: 'Linde E20', battery: 90, charger: 'WH-02-C3', moves: 20 },
  { id: 'FL-06', fac: 'WH-02', op: 'Elena Rossi', model: 'Linde E20', battery: 100, charger: 'WH-02-C4', moves: 15 },
];

interface PalletSeed { id: string; fac: FacilityId; sku: string; slot: number; qty?: number; kg?: number; lot: string; received: string; featured?: boolean }
const PALLETS: PalletSeed[] = [
  { id: 'PAL-1026', fac: 'WH-01', sku: 'PPE-HLM-Y', slot: 2, qty: 82, kg: 56, lot: 'L2501-870', received: 'Apr 19, 16:29', featured: true },
  { id: 'PAL-1031', fac: 'WH-01', sku: 'BOX-M', slot: 11, lot: 'L2501-902', received: 'Apr 20, 08:12', featured: true },
  { id: 'PAL-1034', fac: 'WH-01', sku: 'CNT-P', slot: 12, lot: 'L2501-915', received: 'Apr 20, 09:03', featured: true },
  { id: 'PAL-1052', fac: 'WH-04', sku: 'LED-6060', slot: 9, lot: 'L2502-114', received: 'Apr 20, 07:48' },
  { id: 'PAL-1055', fac: 'WH-04', sku: 'BOX-M', slot: 10, lot: 'L2502-120', received: 'Apr 20, 08:05', featured: true },
  { id: 'PAL-1057', fac: 'WH-04', sku: 'CNT-P', slot: 11, lot: 'L2502-131', received: 'Apr 20, 08:40', featured: true },
  { id: 'PAL-1058', fac: 'WH-04', sku: 'BOX-M', slot: 12, lot: 'L2502-133', received: 'Apr 20, 08:44' },
  { id: 'PAL-1071', fac: 'WH-02', sku: 'CHR-OFC', slot: 1, lot: 'L2503-021', received: 'Apr 19, 18:02', featured: true },
  { id: 'PAL-1072', fac: 'WH-02', sku: 'CHR-OFC', slot: 2, lot: 'L2503-022', received: 'Apr 19, 18:05' },
  { id: 'PAL-1074', fac: 'WH-02', sku: 'GLV-NIT', slot: 7, lot: 'L2503-040', received: 'Apr 20, 06:30', featured: true },
  { id: 'PAL-1075', fac: 'WH-02', sku: 'GLV-NIT', slot: 8, lot: 'L2503-041', received: 'Apr 20, 06:31' },
  { id: 'PAL-1077', fac: 'WH-02', sku: 'BOX-M', slot: 9, lot: 'L2503-052', received: 'Apr 20, 07:15' },
];

const CHARGER_STATS: Record<string, [number, number]> = {
  'WH-01-C1': [5, 28.4], 'WH-01-C2': [6, 33.0],
  'WH-04-C1': [7, 40.1], 'WH-04-C2': [6, 35.6], 'WH-04-C3': [5, 31.2], 'WH-04-C4': [6, 36.8], 'WH-04-C5': [4, 24.9],
  'WH-02-C1': [6, 34.5], 'WH-02-C2': [5, 29.9], 'WH-02-C3': [7, 41.3], 'WH-02-C4': [4, 22.7],
};

export function createSeedWorld(): WorldState {
  const w: WorldState = {
    version: WORLD_VERSION,
    simTime: SIM_START,
    realTime: 0,
    nextShipment: 78470,
    nextPallet: 1100,
    facilities: {},
    docks: {},
    trucks: {},
    shipments: {},
    forklifts: {},
    pallets: {},
    chargers: {},
    laneLock: { 'WH-01': null, 'WH-02': null, 'WH-04': null },
    events: [],
    eventSeq: 0,
    port: seedPort(),
    retail: seedRetail(),
  };
  for (const f of FACILITIES) w.facilities[f.id] = structuredClone(f);
  for (const d of DOCKS) w.docks[d.id] = { ...d };

  for (const s of TRUCKS) {
    const t: Truck = {
      id: s.id, facilityId: s.fac, carrier: s.carrier, driver: s.driver, plate: s.plate, direction: s.dir,
      phase: s.phase, dockId: s.dock, shipmentId: s.ship.id, capacity: s.cap,
      cargo: s.dir === 'inbound' ? s.cap - s.done : s.done,
      skuId: s.sku, legs: [], legIdx: 0, legDist: 0, pos: { x: 0, z: 0 }, heading: 0, speed: 0, awayUntil: 0, forkliftId: null, lane: 'ROAD',
    };
    if (s.phase === 'en_route') {
      const leg = legRoadIn(s.fac);
      t.legs = [leg];
      t.legDist = Math.max(0, pathLength(leg.pts) - (s.remaining ?? 100));
      t.speed = ROAD_SPEED;
    } else if (s.phase === 'docking' && s.dock) {
      t.legs = [legYardIn(s.fac, s.dock), legReverseIn(s.fac, s.dock)];
      t.legIdx = s.dockLeg ?? 0;
      t.legDist = s.dockDist ?? 0;
      w.laneLock[s.fac] = s.id;
    }
    w.trucks[t.id] = t;
    w.shipments[s.ship.id] = { ...s.ship, truckId: s.id, facilityId: s.fac, direction: s.dir, skuId: s.sku, pallets: s.cap, onTime: null, lane: 'ROAD', containerNo: null };
  }

  for (const p of PALLETS) {
    const sku = SKUS[p.sku];
    w.pallets[p.id] = {
      id: p.id, facilityId: p.fac, skuId: p.sku, qty: p.qty ?? sku.unitsPerPallet, weightKg: p.kg ?? sku.kgPerPallet,
      lot: p.lot, received: p.received, slot: p.slot, forkliftId: null, featured: !!p.featured, reserved: false,
    };
  }

  for (const s of FORKS) {
    const pad = LAYOUTS[s.fac].chargers[s.charger];
    const f: Forklift = {
      id: s.id, facilityId: s.fac, operator: s.op, model: s.model, battery: s.battery, task: 'idle', truckId: null,
      palletId: null, movesToday: s.moves, chargerId: s.charger, pos: { ...pad }, heading: Math.PI, speed: 0,
      path: [], pathDist: 0, timer: 0, pick: null, drop: null,
    };
    if (s.battery < 95) f.task = 'charging';
    if (s.work) {
      f.task = s.work.task;
      f.truckId = s.work.truck;
      f.pos = { ...s.work.at };
      f.pick = s.work.pick ?? null;
      f.drop = s.work.drop ?? null;
      w.trucks[s.work.truck].forkliftId = s.id;
      if (s.work.pallet) {
        const sku = SKUS[s.work.pallet.sku];
        w.pallets[s.work.pallet.id] = {
          id: s.work.pallet.id, facilityId: s.fac, skuId: sku.id, qty: sku.unitsPerPallet, weightKg: sku.kgPerPallet,
          lot: 'L2502-' + s.work.pallet.id.slice(-3), received: 'Today, 09:3' + s.work.pallet.id.slice(-1),
          slot: null, forkliftId: s.id, featured: false, reserved: false,
        };
        f.palletId = s.work.pallet.id;
      }
    }
    w.forklifts[f.id] = f;
  }

  for (const [fac, L] of Object.entries(LAYOUTS)) {
    for (const id of Object.keys(L.chargers)) {
      const [sessions, energy] = CHARGER_STATS[id] ?? [3, 20];
      const c: Charger = { id, facilityId: fac as FacilityId, description: '48 V lithium-ion forklift charger', sessionsToday: sessions, energyKwh: energy, ratePctPerMin: 8 };
      w.chargers[id] = c;
    }
  }

  w.events.push(
    { t: hm('09:31'), facilityId: 'WH-04', text: 'TRK-2205 docked at In 1', ref: { kind: 'truck', id: 'TRK-2205' } },
    { t: hm('09:34'), facilityId: 'WH-02', text: 'TRK-2127 started loading at Bay 3', ref: { kind: 'truck', id: 'TRK-2127' } },
    { t: hm('09:36'), facilityId: 'WH-01', text: 'Safety Helmet below reorder level', ref: { kind: 'pallet', id: 'PAL-1026' } },
  );
  w.eventSeq = w.events.length;
  return w;
}

/** Today's earlier traffic through the park gates (matches the facilities' import/export counters). */
export interface GateHistoryRow {
  gate: 'WEST' | 'EAST'; direction: 'IN' | 'OUT'; trade: 'IMPORT' | 'EXPORT' | 'EMPTY';
  truckId: string; facilityId: FacilityId; skuId: string; pallets: number; simTime: number; minutesAgo: number;
}
export function seedGateHistory(w: WorldState): GateHistoryRow[] {
  const rows: GateHistoryRow[] = [];
  for (const f of Object.values(w.facilities)) {
    const trucks = Object.values(w.trucks).filter((t) => t.facilityId === f.id);
    const pick = (dir: 'inbound' | 'outbound', i: number) => {
      const list = trucks.filter((t) => t.direction === dir);
      return (list.length ? list : trucks)[i % (list.length || trucks.length)];
    };
    const spread = (n: number, total: number) => Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));
    const add = (trade: 'IMPORT' | 'EXPORT', n: number, total: number) => {
      spread(n, total).forEach((pallets, i) => {
        const t = pick(trade === 'IMPORT' ? 'inbound' : 'outbound', i);
        const minutesAgo = 20 + Math.round(((n - i) / n) * 300) + (trade === 'EXPORT' ? 7 : 0);
        rows.push({
          gate: trade === 'IMPORT' ? 'WEST' : 'EAST', direction: trade === 'IMPORT' ? 'IN' : 'OUT', trade,
          truckId: t.id, facilityId: f.id, skuId: f.inventory[i % f.inventory.length].skuId, pallets,
          simTime: Math.max(0, SIM_START - minutesAgo * 60), minutesAgo,
        });
        // the same truck passed the other gate empty
        rows.push({
          gate: trade === 'IMPORT' ? 'EAST' : 'WEST', direction: trade === 'IMPORT' ? 'OUT' : 'IN', trade: 'EMPTY',
          truckId: t.id, facilityId: f.id, skuId: f.inventory[i % f.inventory.length].skuId, pallets: 0,
          simTime: Math.max(0, SIM_START - (minutesAgo + (trade === 'IMPORT' ? -12 : 12)) * 60), minutesAgo: minutesAgo + (trade === 'IMPORT' ? -12 : 12),
        });
      });
    };
    add('IMPORT', f.importsToday, f.importPalletsToday);
    add('EXPORT', f.exportsToday, f.exportPalletsToday);
  }
  return rows.sort((a, b) => b.minutesAgo - a.minutesAgo);
}
