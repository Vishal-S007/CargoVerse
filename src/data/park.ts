// The logistics park around the CargoVerse sites: road network, neighbouring
// companies and their buildings, the park gates (imports in, exports out) and the
// vehicles that use the public roads. Pure data + geometry, shared by the
// simulation, the 3D scene and the Oracle seed generator.
import type { FacilityId, Vec2, TradeLane } from './types';
import { roundCorners, pathLength } from '../sim/geometry';

// ---------------------------------------------------------------- road network (park coordinates)
export const HWY_Z = 236; // highway centre line (runs east–west along the south edge)
export const HWY_HALF = 13;
export const HWY_EAST_LANES = [240.5, 245.5]; // eastbound (south carriageway)
export const HWY_WEST_LANES = [231.5, 226.5]; // westbound (north carriageway)
export const HWY_X0 = -620; // where the highway leaves the map (to the port: imports arrive from here)
export const HWY_X1 = 620; // to the interstate: exports leave this way
export const ART_W = -340; // west arterial ("Harbor Avenue") centre
export const ART_E = 340; // east arterial ("Industrial Avenue") centre
export const ART_HALF = 7;
export const ART_Z0 = -330; // arterials run from the highway north to here
export const STREET_HALF = 7;
/** Street centre lines (z). Each CargoVerse site sits on the north side of a street. */
export const STREETS = { A: 52, B: -148 } as const;
export type StreetId = keyof typeof STREETS;
export const STREET_NAMES: Record<StreetId, string> = { A: 'Riverside Road', B: 'Northgate Way' };
export const ROAD_NAMES = { hwy: 'Route 1 & 9 (Port Highway)', artW: 'Harbor Avenue', artE: 'Industrial Avenue' };

// ---------------------------------------------------------------- the town south of the highway (Port Harbor)
export const HWY_SOUTH_EDGE = HWY_Z + HWY_HALF; // 249
/** Avenues continue south of the highway into town as far as Shore Road. */
export const TOWN_Z1 = 560;
export const MARKET_Z = 330; // Market Street (shops on both sides)
export const BAY_Z = 470; // Bay Road
export const SHORE_Z = TOWN_Z1; // Shore Road
export const CENTRAL_X = 0; // Central Avenue (highway → Shore Road)
export const MARKET_X0 = -560; // Market Street starts at the port's freight station
/** The east district: Market St, Bay Rd and Shore Rd continue east to Cedar Avenue; Ocean Avenue runs between. */
export const OCEAN_X = 640;
export const CEDAR_X = 900;
export const TOWN_X1 = CEDAR_X; // east end of the town streets
export const BEACH_Z0 = SHORE_Z + 16; // the beach starts south of Shore Road
export const SEA_Z0 = SHORE_Z + 44; // open water south of the beach
export const TOWN_NAMES = {
  market: 'Market Street', bay: 'Bay Road', shore: 'Shore Road', central: 'Central Avenue', ocean: 'Ocean Avenue', cedar: 'Cedar Avenue',
};

// Maple Heights: the housing estate north of the highway, east of Industrial Avenue.
// Maple Avenue continues Ocean Avenue north; Cedar Avenue crosses the highway; Riverside Road and
// Northgate Way carry on east from the park.
export const SUB_X0 = ART_E; // west edge (Industrial Avenue)
export const SUB_X1 = CEDAR_X; // east edge (Cedar Avenue)
export const MAPLE_X = OCEAN_X;
export const SUB_STREETS = { hill: -260, elm: -48, oak: 142 } as const;
export const SUB_Z0 = SUB_STREETS.hill; // the estate's avenues run from Hillcrest Road to the highway
export const SUB_NAMES = { hill: 'Hillcrest Road', elm: 'Elm Street', oak: 'Oak Lane', maple: 'Maple Avenue' };

// Willow Grove: the second housing estate, north of the highway and west of Harbor Avenue.
// Willow Avenue and Birch Lane run from Hillcrest Road to the highway; the estate's streets
// (Hillcrest Rd, Northgate Way, Elm St, Riverside Rd, Oak Ln) carry on west from Harbor Avenue.
export const WIL_X0 = -600; // Willow Avenue (west edge)
export const BIRCH_X = -470; // Birch Lane (through the middle)
export const WIL_X1 = ART_W; // east edge (Harbor Avenue)
export const WIL_NAMES = { willow: 'Willow Avenue', birch: 'Birch Lane', estate: 'Willow Grove' };

// ---------------------------------------------------------------- the container terminal's landside lanes
export const PORT_OUT_X = -624; // northbound: terminal → highway (import containers leaving)
export const PORT_IN_X = -632; // southbound: highway → terminal (export containers arriving)
export const PORT_GATE_Z = 268; // terminal in-gate / out-gate canopy
export const PORT_AISLE_IN_Z = 283; // trucks bringing exports drive west along here
export const PORT_AISLE_OUT_Z = 289; // trucks collecting imports drive east along here
export const PORT_PICKUP_X = -760; // import block (trucks load here)
export const PORT_DROP_X = -690; // export block (trucks unload here)

/** Where each CargoVerse site's local layout sits in the park. */
export const FACILITY_OFFSET: Record<FacilityId, Vec2> = {
  'WH-01': { x: -200, z: 0 },
  'WH-02': { x: 175, z: 0 },
  'WH-04': { x: -130, z: -200 },
};
export const FACILITY_STREET: Record<FacilityId, StreetId> = { 'WH-01': 'A', 'WH-02': 'A', 'WH-04': 'B' };

export const toPark = (fac: FacilityId, p: Vec2): Vec2 => ({ x: p.x + FACILITY_OFFSET[fac].x, z: p.z + FACILITY_OFFSET[fac].z });
export const toLocal = (fac: FacilityId, p: Vec2): Vec2 => ({ x: p.x - FACILITY_OFFSET[fac].x, z: p.z - FACILITY_OFFSET[fac].z });

// ---------------------------------------------------------------- park gates (customs / security)
export type GateCode = 'WEST' | 'EAST';
export interface ParkGate {
  code: GateCode;
  name: string;
  pos: Vec2; // booth position (park coordinates)
  lane: Vec2; // point on the lane the barrier spans
  barrierAxis: 'x' | 'z';
  purpose: string;
}
export const PARK_GATES: Record<GateCode, ParkGate> = {
  WEST: {
    code: 'WEST', name: 'West Gate · Imports', pos: { x: ART_W + 12, z: 198 }, lane: { x: ART_W + 3, z: 198 }, barrierAxis: 'x',
    purpose: 'Entry checkpoint on Harbor Avenue. Every truck arriving from the port highway is checked in here.',
  },
  EAST: {
    code: 'EAST', name: 'East Gate · Exports', pos: { x: ART_E - 12, z: 198 }, lane: { x: ART_E - 3, z: 198 }, barrierAxis: 'x',
    purpose: 'Exit checkpoint on Industrial Avenue. Every truck leaving for the interstate is checked out here.',
  },
};

// ---------------------------------------------------------------- truck routes between the highway and a site
/**
 * Inbound route (park coordinates): highway eastbound from the port, north on Harbor
 * Avenue through the West Gate, then east along the site's street to its gate.
 */
export function parkRouteIn(fac: FacilityId, gateLocalX: number, roadLaneLocalZ: number, gateStopLocalZ: number, lane: TradeLane = 'ROAD'): Vec2[] {
  const o = FACILITY_OFFSET[fac];
  const laneZ = roadLaneLocalZ + o.z;
  const gx = gateLocalX + o.x;
  // import containers are collected inside the terminal and leave through its out-gate
  const start: Vec2[] = lane === 'SEA'
    ? [{ x: PORT_PICKUP_X, z: PORT_AISLE_OUT_Z }, { x: PORT_OUT_X, z: PORT_AISLE_OUT_Z }, { x: PORT_OUT_X, z: HWY_EAST_LANES[1] }]
    : [{ x: HWY_X0, z: HWY_EAST_LANES[1] }];
  return [
    ...start,
    { x: ART_W + 3, z: HWY_EAST_LANES[1] },
    { x: ART_W + 3, z: laneZ },
    { x: gx, z: laneZ },
    { x: gx, z: gateStopLocalZ + o.z },
  ];
}

/** Outbound route: from the site's exit along its street, south on Industrial Avenue through the East Gate, then east. */
export function parkRouteOut(fac: FacilityId, exitLocalX: number, roadLaneLocalZ: number, exitStartLocalZ: number, lane: TradeLane = 'ROAD'): Vec2[] {
  const o = FACILITY_OFFSET[fac];
  const laneZ = roadLaneLocalZ + o.z;
  const ex = exitLocalX + o.x;
  const head: Vec2[] = [
    { x: ex, z: exitStartLocalZ + o.z },
    { x: ex, z: laneZ },
    { x: ART_E - 3, z: laneZ },
  ];
  if (lane === 'SEA') {
    // sea exports: right onto the westbound highway, then into the container terminal to drop the box
    return [
      ...head,
      { x: ART_E - 3, z: HWY_WEST_LANES[1] },
      { x: PORT_IN_X, z: HWY_WEST_LANES[1] },
      { x: PORT_IN_X, z: PORT_AISLE_IN_Z },
      { x: PORT_DROP_X, z: PORT_AISLE_IN_Z },
    ];
  }
  return [...head, { x: ART_E - 3, z: HWY_EAST_LANES[1] }, { x: HWY_X1, z: HWY_EAST_LANES[1] }];
}

/** Arc length along a polyline to the point closest to p. */
export function distanceAlong(pts: Vec2[], p: Vec2): number {
  let best = Infinity;
  let at = 0;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const seg = Math.sqrt(len2);
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
    const qx = a.x + dx * t, qz = a.z + dz * t;
    const d = Math.hypot(p.x - qx, p.z - qz);
    if (d < best) { best = d; at = acc + seg * t; }
    acc += seg;
  }
  return at;
}

// ---------------------------------------------------------------- companies and buildings
export type BuildingKind =
  | 'WAREHOUSE' | 'PLANT' | 'OFFICE' | 'COLD_STORE' | 'FUEL_STATION' | 'PARKING' | 'GATEHOUSE' | 'SERVICES' | 'TERMINAL'
  | 'SUPERMARKET' | 'STORE' | 'RESIDENTIAL';
export type BuildingStatus = 'OPERATING' | 'MAINTENANCE' | 'VACANT' | 'CONSTRUCTION';

export interface ParkCompany {
  id: string;
  name: string;
  industry: string;
  contactName: string;
  email: string;
  phone: string;
  color: string; // brand colour (hex)
  isOperator: boolean; // true for CargoVerse (runs the park's logistics sites)
}

export interface ParkBuilding {
  id: string;
  companyId: string;
  facilityId: FacilityId | null; // set for CargoVerse's own sites
  name: string;
  kind: BuildingKind;
  street: string;
  x: number; // centre (park coordinates)
  z: number;
  w: number; // size along x
  d: number; // size along z
  h: number;
  rotation: 0 | 90 | 180 | 270; // which way the front faces: 0 = south (+z), 180 = north (-z)
  floors: number;
  staff: number;
  status: BuildingStatus;
  leaseStart: string; // YYYY-MM-DD
  leaseEnd: string;
  description: string;
}

export const PARK_COMPANIES: ParkCompany[] = [
  { id: 'WARETRACK', name: 'CargoVerse Logistics', industry: 'Warehousing & 3PL', contactName: 'Riya Sharma', email: 'ops@cargoverse.example', phone: '+1 973 555 0100', color: '#2c5be4', isOperator: true },
  { id: 'APEX', name: 'Apex Auto Parts', industry: 'Automotive components', contactName: 'Daniel Brooks', email: 'facility@apexparts.example', phone: '+1 973 555 0141', color: '#e0533d', isOperator: false },
  { id: 'GREENLEAF', name: 'GreenLeaf Beverages', industry: 'Bottling plant', contactName: 'Hannah Moore', email: 'site@greenleaf.example', phone: '+1 973 555 0177', color: '#2f9e5b', isOperator: false },
  { id: 'HELIOS', name: 'Helios Solar Components', industry: 'Solar panel manufacturing', contactName: 'Victor Lin', email: 'plant@helios.example', phone: '+1 973 555 0193', color: '#f2a516', isOperator: false },
  { id: 'NORDIC', name: 'Nordic Fresh Foods', industry: 'Cold-chain storage', contactName: 'Astrid Holm', email: 'coldstore@nordicfresh.example', phone: '+1 973 555 0125', color: '#1e8fb3', isOperator: false },
  { id: 'BRIGHTLINE', name: 'Brightline Medical Supply', industry: 'Medical distribution', contactName: 'Sofia Reyes', email: 'dc@brightline.example', phone: '+1 973 555 0168', color: '#7a5af5', isOperator: false },
  { id: 'MERIDIAN', name: 'Meridian Freight Brokers', industry: 'Freight brokerage (offices)', contactName: 'Owen Clarke', email: 'hq@meridianfreight.example', phone: '+1 973 555 0110', color: '#33415c', isOperator: false },
  { id: 'ATLAS', name: 'Atlas Furniture Works', industry: 'Furniture manufacturing', contactName: 'Grace Patel', email: 'works@atlasfurniture.example', phone: '+1 973 555 0156', color: '#b86b2e', isOperator: false },
  { id: 'BAYVIEW', name: 'Bayview Foods', industry: 'Grocery distribution', contactName: 'Marco Silva', email: 'dc@bayviewfoods.example', phone: '+1 973 555 0182', color: '#d6336c', isOperator: false },
  { id: 'PARKAUTH', name: 'Harborside Logistics Park Authority', industry: 'Park management & security', contactName: 'Ellen Ward', email: 'office@harborsidepark.example', phone: '+1 973 555 0001', color: '#4b5563', isOperator: false },
  { id: 'PORTNWK', name: 'Port Newark Container Terminal', industry: 'Seaport container terminal', contactName: 'Luis Ortega', email: 'gate@portnewark.example', phone: '+1 973 555 0300', color: '#0b7285', isOperator: false },
  { id: 'PARKFUEL', name: 'ParkFuel', industry: 'Fuel & EV charging', contactName: 'Tom Becker', email: 'station@parkfuel.example', phone: '+1 973 555 0133', color: '#0f9d8a', isOperator: false },
  // the town of Port Harbor south of the highway: vendor stores supplied by the CargoVerse warehouses
  { id: 'FRESHCART', name: 'FreshCart Supermarkets', industry: 'Supermarket chain', contactName: 'Nina Alvarez', email: 'store12@freshcart.example', phone: '+1 973 555 0410', color: '#2b8a3e', isOperator: false },
  { id: 'VALUMART', name: 'ValuMart', industry: 'Discount superstores', contactName: 'Ray Donovan', email: 'portharbor@valumart.example', phone: '+1 973 555 0420', color: '#1c7ed6', isOperator: false },
  { id: 'HOMEMART', name: 'HomeMart', industry: 'Home & office superstore', contactName: 'Priya Nair', email: 'manager@homemart.example', phone: '+1 973 555 0430', color: '#e8590c', isOperator: false },
  { id: 'CITYCARE', name: 'CityCare Pharmacy', industry: 'Pharmacy', contactName: 'Dr. Ethan Cole', email: 'portharbor@citycare.example', phone: '+1 973 555 0440', color: '#0ca678', isOperator: false },
  { id: 'OFFICEWORKS', name: 'OfficeWorks Depot', industry: 'Office supplies', contactName: 'Laura Kim', email: 'depot@officeworks.example', phone: '+1 973 555 0450', color: '#364fc7', isOperator: false },
  { id: 'BUILDRIGHT', name: 'BuildRight Hardware', industry: 'Hardware & tools', contactName: 'Sean Murphy', email: 'store@buildright.example', phone: '+1 973 555 0460', color: '#f08c00', isOperator: false },
  { id: 'CORNER', name: 'Corner Express', industry: 'Convenience store', contactName: 'Ahmed Rahman', email: 'hello@cornerexpress.example', phone: '+1 973 555 0470', color: '#c2255c', isOperator: false },
  { id: 'GARDEN', name: 'Harbor Home & Garden', industry: 'Home & garden centre', contactName: 'Olivia Grant', email: 'shop@harborgarden.example', phone: '+1 973 555 0480', color: '#5c940d', isOperator: false },
  { id: 'TOWN', name: 'Town of Port Harbor', industry: 'Municipal services', contactName: 'Ruth Bennett', email: 'clerk@portharbor.example', phone: '+1 973 555 0500', color: '#495057', isOperator: false },
  { id: 'BAYSIDE', name: 'Bayside Living', industry: 'Residential housing', contactName: 'Carlos Mendes', email: 'leasing@baysideliving.example', phone: '+1 973 555 0510', color: '#ae3ec9', isOperator: false },
  { id: 'HARBORPOINT', name: 'Harbor Point Mall', industry: 'Shopping centre', contactName: 'Grace Lin', email: 'office@harborpoint.example', phone: '+1 973 555 0530', color: '#0c8599', isOperator: false },
  { id: 'VOLTCITY', name: 'VoltCity Electronics', industry: 'Electronics & lighting', contactName: 'Mark Ellis', email: 'store@voltcity.example', phone: '+1 973 555 0540', color: '#f59f00', isOperator: false },
  { id: 'FISHMKT', name: "Fisherman's Market", industry: 'Market hall & household goods', contactName: 'Rosa Diaz', email: 'hall@fishermans.example', phone: '+1 973 555 0550', color: '#1971c2', isOperator: false },
  { id: 'HSBANK', name: 'Harbor Savings Bank', industry: 'Banking', contactName: 'Henry Walsh', email: 'branch@harborsavings.example', phone: '+1 973 555 0560', color: '#2f9e44', isOperator: false },
  { id: 'STARLIGHT', name: 'Starlight Cinemas', industry: 'Cinema', contactName: 'Mia Torres', email: 'portharbor@starlight.example', phone: '+1 973 555 0570', color: '#c2255c', isOperator: false },
  { id: 'EATERIES', name: 'Harbor Eateries', industry: 'Cafés & restaurants', contactName: 'Luca Romano', email: 'hello@harboreats.example', phone: '+1 973 555 0580', color: '#e8590c', isOperator: false },
  { id: 'CUSTOMS', name: 'Port Customs Authority', industry: 'Import & export inspections', contactName: 'Dana Price', email: 'inspections@portcustoms.example', phone: '+1 973 555 0520', color: '#1d3557', isOperator: false },
];

const B = (b: ParkBuilding) => b;
export const PARK_BUILDINGS: ParkBuilding[] = [
  // CargoVerse's own sites (geometry comes from the detailed site layouts)
  B({ id: 'PB-WH01', companyId: 'WARETRACK', facilityId: 'WH-01', name: 'Riverside Hub', kind: 'WAREHOUSE', street: STREET_NAMES.A, x: -202, z: -13, w: 60, d: 26, h: 9, rotation: 0, floors: 1, staff: 42, status: 'OPERATING', leaseStart: '2019-04-01', leaseEnd: '2034-03-31', description: 'CargoVerse depot with two dock bays and a yard for staging.' }),
  B({ id: 'PB-WH02', companyId: 'WARETRACK', facilityId: 'WH-02', name: 'Northgate DC', kind: 'WAREHOUSE', street: STREET_NAMES.A, x: 166, z: -17, w: 110, d: 34, h: 10, rotation: 0, floors: 1, staff: 96, status: 'OPERATING', leaseStart: '2017-09-01', leaseEnd: '2037-08-31', description: 'CargoVerse distribution centre with four dock bays.' }),
  B({ id: 'PB-WH04', companyId: 'WARETRACK', facilityId: 'WH-04', name: 'Southfield Cross-Dock', kind: 'WAREHOUSE', street: STREET_NAMES.B, x: -129, z: -219, w: 114, d: 38, h: 11, rotation: 0, floors: 1, staff: 74, status: 'OPERATING', leaseStart: '2021-01-01', leaseEnd: '2036-12-31', description: 'CargoVerse cross-dock: inbound doors on the west, outbound doors on the east.' }),
  // Riverside Road, north side (between the two CargoVerse sites)
  B({ id: 'PB-APEX', companyId: 'APEX', facilityId: null, name: 'Apex Auto Parts Plant', kind: 'PLANT', street: STREET_NAMES.A, x: -40, z: -24, w: 110, d: 40, h: 12, rotation: 0, floors: 1, staff: 310, status: 'OPERATING', leaseStart: '2016-06-01', leaseEnd: '2031-05-31', description: 'Stamping and assembly plant for brake and suspension parts. Two process stacks on the roof.' }),
  // Riverside Road, south side (facing the street)
  B({ id: 'PB-MERIDIAN', companyId: 'MERIDIAN', facilityId: null, name: 'Meridian Tower', kind: 'OFFICE', street: STREET_NAMES.A, x: -272, z: 112, w: 46, d: 40, h: 34, rotation: 180, floors: 9, staff: 420, status: 'OPERATING', leaseStart: '2018-02-01', leaseEnd: '2033-01-31', description: 'Nine-storey office tower: freight brokers, customs agents and the park canteen on the ground floor.' }),
  B({ id: 'PB-P2', companyId: 'PARKAUTH', facilityId: null, name: 'Visitor Car Park P2', kind: 'PARKING', street: STREET_NAMES.A, x: -175, z: 112, w: 90, d: 60, h: 0, rotation: 180, floors: 1, staff: 0, status: 'OPERATING', leaseStart: '2015-01-01', leaseEnd: '2045-12-31', description: 'Surface car park for staff and visitors (160 spaces).' }),
  B({ id: 'PB-ATLAS', companyId: 'ATLAS', facilityId: null, name: 'Atlas Furniture Works', kind: 'PLANT', street: STREET_NAMES.A, x: -20, z: 125, w: 130, d: 70, h: 13, rotation: 180, floors: 1, staff: 260, status: 'OPERATING', leaseStart: '2020-05-01', leaseEnd: '2035-04-30', description: 'Furniture factory with a sawmill hall, finishing line and dust-extraction silos.' }),
  B({ id: 'PB-BAYVIEW', companyId: 'BAYVIEW', facilityId: null, name: 'Bayview Foods DC', kind: 'WAREHOUSE', street: STREET_NAMES.A, x: 165, z: 122, w: 120, d: 60, h: 11, rotation: 180, floors: 1, staff: 180, status: 'OPERATING', leaseStart: '2019-10-01', leaseEnd: '2029-09-30', description: 'Grocery distribution centre supplying supermarkets across New Jersey.' }),
  B({ id: 'PB-CLINIC', companyId: 'PARKAUTH', facilityId: null, name: 'Park Services & Clinic', kind: 'SERVICES', street: STREET_NAMES.A, x: 285, z: 112, w: 40, d: 36, h: 9, rotation: 180, floors: 2, staff: 35, status: 'OPERATING', leaseStart: '2015-01-01', leaseEnd: '2045-12-31', description: 'Park authority offices, first-aid clinic and the security control room.' }),
  // Northgate Way, south side (facing north onto the street)
  B({ id: 'PB-NORDIC', companyId: 'NORDIC', facilityId: null, name: 'Nordic Fresh Cold Store', kind: 'COLD_STORE', street: STREET_NAMES.B, x: -262, z: -100, w: 96, d: 50, h: 14, rotation: 180, floors: 1, staff: 85, status: 'OPERATING', leaseStart: '2022-03-01', leaseEnd: '2037-02-28', description: 'Temperature-controlled warehouse (−25 °C to +4 °C) with refrigeration units on the roof.' }),
  B({ id: 'PB-FUEL', companyId: 'PARKFUEL', facilityId: null, name: 'ParkFuel Station', kind: 'FUEL_STATION', street: STREET_NAMES.B, x: -150, z: -105, w: 54, d: 36, h: 6, rotation: 180, floors: 1, staff: 8, status: 'OPERATING', leaseStart: '2018-07-01', leaseEnd: '2028-06-30', description: 'Diesel, petrol and EV fast chargers for trucks and cars in the park.' }),
  B({ id: 'PB-P1', companyId: 'PARKAUTH', facilityId: null, name: 'Staff Car Park P1', kind: 'PARKING', street: STREET_NAMES.B, x: -55, z: -100, w: 90, d: 56, h: 0, rotation: 180, floors: 1, staff: 0, status: 'OPERATING', leaseStart: '2015-01-01', leaseEnd: '2045-12-31', description: 'Surface car park for park staff (140 spaces).' }),
  B({ id: 'PB-BRIGHT', companyId: 'BRIGHTLINE', facilityId: null, name: 'Brightline Medical DC', kind: 'WAREHOUSE', street: STREET_NAMES.B, x: 75, z: -98, w: 110, d: 54, h: 11, rotation: 180, floors: 1, staff: 140, status: 'OPERATING', leaseStart: '2021-08-01', leaseEnd: '2031-07-31', description: 'Medical-supplies warehouse with a GDP-certified clean room.' }),
  B({ id: 'PB-OFFICE2', companyId: 'PARKAUTH', facilityId: null, name: 'Harborside Business Centre', kind: 'OFFICE', street: STREET_NAMES.B, x: 238, z: -100, w: 70, d: 44, h: 18, rotation: 180, floors: 5, staff: 0, status: 'VACANT', leaseStart: '2015-01-01', leaseEnd: '2045-12-31', description: 'Five-storey office block. Two floors available to let.' }),
  // Northgate Way, north side (east of Southfield)
  B({ id: 'PB-GREENLEAF', companyId: 'GREENLEAF', facilityId: null, name: 'GreenLeaf Bottling Plant', kind: 'PLANT', street: STREET_NAMES.B, x: 70, z: -230, w: 130, d: 80, h: 14, rotation: 0, floors: 1, staff: 230, status: 'OPERATING', leaseStart: '2017-03-01', leaseEnd: '2032-02-28', description: 'Bottling plant with syrup tanks, a filling hall and a stack for the boiler house.' }),
  B({ id: 'PB-HELIOS', companyId: 'HELIOS', facilityId: null, name: 'Helios Solar Components', kind: 'PLANT', street: STREET_NAMES.B, x: 245, z: -232, w: 120, d: 84, h: 12, rotation: 0, floors: 1, staff: 190, status: 'MAINTENANCE', leaseStart: '2023-01-01', leaseEnd: '2038-12-31', description: 'Solar-panel factory with a rooftop PV array. Line 2 is down for scheduled maintenance.' }),
  // where imports come from: the container terminal at the west end of the port highway
  B({ id: 'PB-PORT', companyId: 'PORTNWK', facilityId: null, name: 'Port Newark Container Terminal', kind: 'TERMINAL', street: ROAD_NAMES.hwy, x: -700, z: 301, w: 200, d: 78, h: 0, rotation: 0, floors: 1, staff: 640, status: 'OPERATING', leaseStart: '2010-01-01', leaseEnd: '2060-12-31', description: 'Container terminal with two berths and four quay cranes. Ships discharge import containers into the import block, where CargoVerse trucks collect them; export containers delivered by truck are loaded onto the next ship.' }),
  B({ id: 'PB-CFS', companyId: 'PORTNWK', facilityId: null, name: 'Port Container Freight Station', kind: 'WAREHOUSE', street: TOWN_NAMES.market, x: -490, z: 292, w: 100, d: 50, h: 10, rotation: 0, floors: 1, staff: 70, status: 'OPERATING', leaseStart: '2012-01-01', leaseEnd: '2042-12-31', description: 'Bonded warehouse where mixed containers are stripped and stuffed before customs clearance.' }),
  B({ id: 'PB-CUSTOMS', companyId: 'CUSTOMS', facilityId: null, name: 'Customs Port Office', kind: 'OFFICE', street: TOWN_NAMES.market, x: -393, z: 292, w: 28, d: 34, h: 14, rotation: 0, floors: 3, staff: 55, status: 'OPERATING', leaseStart: '2012-01-01', leaseEnd: '2042-12-31', description: 'Inspection office for import and export containers moving through the terminal.' }),
  // Port Harbor town — Market Street, north side (shop fronts face the street)
  B({ id: 'PB-FRESHCART', companyId: 'FRESHCART', facilityId: null, name: 'FreshCart Supermarket', kind: 'SUPERMARKET', street: TOWN_NAMES.market, x: -250, z: 290, w: 96, d: 48, h: 9, rotation: 0, floors: 1, staff: 85, status: 'OPERATING', leaseStart: '2018-03-01', leaseEnd: '2033-02-28', description: 'Neighbourhood supermarket. Restocked by CargoVerse delivery vans from Riverside Hub.' }),
  B({ id: 'PB-CITYCARE', companyId: 'CITYCARE', facilityId: null, name: 'CityCare Pharmacy', kind: 'STORE', street: TOWN_NAMES.market, x: -150, z: 300, w: 32, d: 30, h: 7, rotation: 0, floors: 1, staff: 14, status: 'OPERATING', leaseStart: '2020-06-01', leaseEnd: '2030-05-31', description: 'Pharmacy and medical supplies.' }),
  B({ id: 'PB-OFFICEWORKS', companyId: 'OFFICEWORKS', facilityId: null, name: 'OfficeWorks Depot', kind: 'STORE', street: TOWN_NAMES.market, x: -80, z: 296, w: 54, d: 38, h: 8, rotation: 0, floors: 1, staff: 22, status: 'OPERATING', leaseStart: '2019-09-01', leaseEnd: '2029-08-31', description: 'Office furniture and supplies.' }),
  B({ id: 'PB-VALUMART', companyId: 'VALUMART', facilityId: null, name: 'ValuMart Superstore', kind: 'SUPERMARKET', street: TOWN_NAMES.market, x: 110, z: 290, w: 120, d: 50, h: 10, rotation: 0, floors: 1, staff: 140, status: 'OPERATING', leaseStart: '2017-11-01', leaseEnd: '2037-10-31', description: 'Discount superstore. Restocked from Northgate DC.' }),
  B({ id: 'PB-BUILDRIGHT', companyId: 'BUILDRIGHT', facilityId: null, name: 'BuildRight Hardware', kind: 'STORE', street: TOWN_NAMES.market, x: 240, z: 294, w: 70, d: 42, h: 9, rotation: 0, floors: 1, staff: 30, status: 'OPERATING', leaseStart: '2021-02-01', leaseEnd: '2031-01-31', description: 'Hardware, safety gear and lighting.' }),
  B({ id: 'PB-CORNER', companyId: 'CORNER', facilityId: null, name: 'Corner Express', kind: 'STORE', street: TOWN_NAMES.market, x: 305, z: 302, w: 26, d: 26, h: 6, rotation: 0, floors: 1, staff: 6, status: 'OPERATING', leaseStart: '2022-04-01', leaseEnd: '2027-03-31', description: 'Convenience store open 6am–midnight.' }),
  // Market Street, south side (fronts face north onto the street)
  B({ id: 'PB-GARDEN', companyId: 'GARDEN', facilityId: null, name: 'Harbor Home & Garden', kind: 'STORE', street: TOWN_NAMES.market, x: -230, z: 375, w: 80, d: 50, h: 8, rotation: 180, floors: 1, staff: 26, status: 'OPERATING', leaseStart: '2020-03-01', leaseEnd: '2030-02-28', description: 'Home and garden centre with a covered outdoor yard.' }),
  B({ id: 'PB-APT1', companyId: 'BAYSIDE', facilityId: null, name: 'Bayside Apartments A', kind: 'RESIDENTIAL', street: TOWN_NAMES.market, x: -110, z: 392, w: 40, d: 34, h: 30, rotation: 180, floors: 10, staff: 4, status: 'OPERATING', leaseStart: '2016-01-01', leaseEnd: '2066-12-31', description: 'Ten-storey apartment block (96 homes).' }),
  B({ id: 'PB-APT2', companyId: 'BAYSIDE', facilityId: null, name: 'Bayside Apartments B', kind: 'RESIDENTIAL', street: TOWN_NAMES.bay, x: -50, z: 425, w: 34, d: 30, h: 22, rotation: 180, floors: 7, staff: 2, status: 'OPERATING', leaseStart: '2016-01-01', leaseEnd: '2066-12-31', description: 'Seven-storey apartment block (56 homes).' }),
  B({ id: 'PB-SCHOOL', companyId: 'TOWN', facilityId: null, name: 'Harbor Primary School', kind: 'SERVICES', street: TOWN_NAMES.bay, x: -260, z: 440, w: 60, d: 30, h: 8, rotation: 180, floors: 2, staff: 48, status: 'OPERATING', leaseStart: '2000-09-01', leaseEnd: '2099-08-31', description: 'Primary school for 420 pupils.' }),
  B({ id: 'PB-CLINIC2', companyId: 'TOWN', facilityId: null, name: 'Port Harbor Medical Center', kind: 'SERVICES', street: TOWN_NAMES.market, x: 60, z: 405, w: 70, d: 50, h: 20, rotation: 180, floors: 5, staff: 310, status: 'OPERATING', leaseStart: '2005-01-01', leaseEnd: '2099-12-31', description: 'Hospital with an emergency department.' }),
  B({ id: 'PB-HOMEMART', companyId: 'HOMEMART', facilityId: null, name: 'HomeMart Superstore', kind: 'SUPERMARKET', street: TOWN_NAMES.market, x: 170, z: 382, w: 120, d: 60, h: 11, rotation: 180, floors: 1, staff: 120, status: 'OPERATING', leaseStart: '2019-05-01', leaseEnd: '2039-04-30', description: 'Home, office and storage superstore. Restocked from Southfield Cross-Dock.' }),
  B({ id: 'PB-TOWNHALL', companyId: 'TOWN', facilityId: null, name: 'Port Harbor Town Hall', kind: 'OFFICE', street: TOWN_NAMES.market, x: 290, z: 405, w: 50, d: 40, h: 16, rotation: 180, floors: 4, staff: 90, status: 'OPERATING', leaseStart: '1998-01-01', leaseEnd: '2099-12-31', description: 'Town council offices and the permits desk.' }),
  // Bay Road, south side
  B({ id: 'PB-APT3', companyId: 'BAYSIDE', facilityId: null, name: 'Shoreline Residences', kind: 'RESIDENTIAL', street: TOWN_NAMES.bay, x: -265, z: 515, w: 60, d: 40, h: 26, rotation: 180, floors: 8, staff: 3, status: 'OPERATING', leaseStart: '2019-01-01', leaseEnd: '2069-12-31', description: 'Eight-storey residences with sea views.' }),
  B({ id: 'PB-APT4', companyId: 'BAYSIDE', facilityId: null, name: 'Harbor View Flats', kind: 'RESIDENTIAL', street: TOWN_NAMES.bay, x: -160, z: 512, w: 50, d: 36, h: 18, rotation: 180, floors: 6, staff: 2, status: 'OPERATING', leaseStart: '2014-01-01', leaseEnd: '2064-12-31', description: 'Six-storey flats.' }),
  B({ id: 'PB-P3', companyId: 'TOWN', facilityId: null, name: 'Town Car Park P3', kind: 'PARKING', street: TOWN_NAMES.bay, x: -50, z: 515, w: 70, d: 50, h: 0, rotation: 180, floors: 1, staff: 0, status: 'OPERATING', leaseStart: '2010-01-01', leaseEnd: '2060-12-31', description: 'Public car park for Market Street shoppers (120 spaces).' }),
  B({ id: 'PB-APT5', companyId: 'BAYSIDE', facilityId: null, name: 'Marina Court', kind: 'RESIDENTIAL', street: TOWN_NAMES.bay, x: 95, z: 512, w: 70, d: 36, h: 20, rotation: 180, floors: 6, staff: 3, status: 'OPERATING', leaseStart: '2021-01-01', leaseEnd: '2071-12-31', description: 'Six-storey apartments around a courtyard.' }),
  // more shops on the west blocks
  B({ id: 'PB-CAFE1', companyId: 'EATERIES', facilityId: null, name: 'Bluebird Café', kind: 'STORE', street: TOWN_NAMES.market, x: -184, z: 304, w: 26, d: 24, h: 6, rotation: 0, floors: 1, staff: 9, status: 'OPERATING', leaseStart: '2021-05-01', leaseEnd: '2031-04-30', description: 'Coffee, breakfast and lunch.' }),
  B({ id: 'PB-PIZZA', companyId: 'EATERIES', facilityId: null, name: 'Pizza Palace', kind: 'STORE', street: TOWN_NAMES.market, x: 188, z: 304, w: 26, d: 24, h: 6, rotation: 0, floors: 1, staff: 11, status: 'OPERATING', leaseStart: '2019-08-01', leaseEnd: '2029-07-31', description: 'Wood-fired pizza, open late.' }),
  B({ id: 'PB-LIBRARY', companyId: 'TOWN', facilityId: null, name: 'Port Harbor Library', kind: 'SERVICES', street: TOWN_NAMES.bay, x: 168, z: 512, w: 30, d: 36, h: 10, rotation: 180, floors: 2, staff: 14, status: 'OPERATING', leaseStart: '1995-01-01', leaseEnd: '2099-12-31', description: 'Public library and community rooms.' }),
  // east district — Market Street, north side
  B({ id: 'PB-MALL', companyId: 'HARBORPOINT', facilityId: null, name: 'Harbor Point Mall', kind: 'SUPERMARKET', street: TOWN_NAMES.market, x: 470, z: 290, w: 150, d: 52, h: 12, rotation: 0, floors: 2, staff: 260, status: 'OPERATING', leaseStart: '2018-04-01', leaseEnd: '2043-03-31', description: 'Two-storey shopping centre with a department store, food court and 40 shops.' }),
  B({ id: 'PB-CINEMA', companyId: 'STARLIGHT', facilityId: null, name: 'Starlight Cinema', kind: 'STORE', street: TOWN_NAMES.market, x: 590, z: 298, w: 50, d: 38, h: 14, rotation: 0, floors: 1, staff: 28, status: 'OPERATING', leaseStart: '2020-11-01', leaseEnd: '2035-10-31', description: 'Eight-screen cinema.' }),
  B({ id: 'PB-BANK', companyId: 'HSBANK', facilityId: null, name: 'Harbor Savings Bank', kind: 'OFFICE', street: TOWN_NAMES.market, x: 700, z: 294, w: 40, d: 40, h: 22, rotation: 0, floors: 5, staff: 85, status: 'OPERATING', leaseStart: '2012-01-01', leaseEnd: '2042-12-31', description: 'Bank branch and regional offices.' }),
  B({ id: 'PB-PLAZA', companyId: 'MERIDIAN', facilityId: null, name: 'Meridian Plaza', kind: 'OFFICE', street: TOWN_NAMES.market, x: 780, z: 292, w: 48, d: 44, h: 58, rotation: 0, floors: 16, staff: 640, status: 'OPERATING', leaseStart: '2022-06-01', leaseEnd: '2052-05-31', description: 'Sixteen-storey office tower — the tallest building in Port Harbor.' }),
  B({ id: 'PB-FUEL2', companyId: 'PARKFUEL', facilityId: null, name: 'ParkFuel Town Centre', kind: 'FUEL_STATION', street: TOWN_NAMES.cedar, x: 862, z: 296, w: 54, d: 36, h: 6, rotation: 0, floors: 1, staff: 6, status: 'OPERATING', leaseStart: '2019-01-01', leaseEnd: '2029-12-31', description: 'Fuel and EV fast chargers next to Cedar Avenue.' }),
  // east district — Market Street, south side
  B({ id: 'PB-POLICE', companyId: 'TOWN', facilityId: null, name: 'Port Harbor Police', kind: 'SERVICES', street: TOWN_NAMES.market, x: 398, z: 378, w: 48, d: 40, h: 12, rotation: 180, floors: 3, staff: 95, status: 'OPERATING', leaseStart: '2001-01-01', leaseEnd: '2099-12-31', description: 'Police station and emergency dispatch.' }),
  B({ id: 'PB-FIRE', companyId: 'TOWN', facilityId: null, name: 'Fire Station 3', kind: 'SERVICES', street: TOWN_NAMES.market, x: 468, z: 376, w: 40, d: 36, h: 10, rotation: 180, floors: 2, staff: 32, status: 'OPERATING', leaseStart: '2001-01-01', leaseEnd: '2099-12-31', description: 'Fire and rescue station with three engines.' }),
  B({ id: 'PB-VOLT', companyId: 'VOLTCITY', facilityId: null, name: 'VoltCity Electronics', kind: 'STORE', street: TOWN_NAMES.market, x: 560, z: 380, w: 70, d: 48, h: 9, rotation: 180, floors: 1, staff: 34, status: 'OPERATING', leaseStart: '2021-09-01', leaseEnd: '2031-08-31', description: 'Electronics, lighting and office furniture.' }),
  B({ id: 'PB-APT6', companyId: 'BAYSIDE', facilityId: null, name: 'Ocean Heights', kind: 'RESIDENTIAL', street: TOWN_NAMES.ocean, x: 705, z: 394, w: 44, d: 40, h: 42, rotation: 180, floors: 14, staff: 5, status: 'OPERATING', leaseStart: '2020-01-01', leaseEnd: '2070-12-31', description: 'Fourteen-storey apartment tower (130 homes).' }),
  B({ id: 'PB-APT7', companyId: 'BAYSIDE', facilityId: null, name: 'Cedar Court', kind: 'RESIDENTIAL', street: TOWN_NAMES.cedar, x: 835, z: 400, w: 56, d: 44, h: 24, rotation: 180, floors: 8, staff: 3, status: 'OPERATING', leaseStart: '2017-01-01', leaseEnd: '2067-12-31', description: 'Eight-storey apartments.' }),
  // east district — Bay Road, south side
  B({ id: 'PB-APT8', companyId: 'BAYSIDE', facilityId: null, name: 'Sunset Terraces', kind: 'RESIDENTIAL', street: TOWN_NAMES.bay, x: 410, z: 514, w: 60, d: 40, h: 16, rotation: 180, floors: 5, staff: 2, status: 'OPERATING', leaseStart: '2015-01-01', leaseEnd: '2065-12-31', description: 'Five-storey terraced flats.' }),
  B({ id: 'PB-SCHOOL2', companyId: 'TOWN', facilityId: null, name: 'Bayview High School', kind: 'SERVICES', street: TOWN_NAMES.bay, x: 510, z: 514, w: 70, d: 40, h: 10, rotation: 180, floors: 3, staff: 76, status: 'OPERATING', leaseStart: '1999-09-01', leaseEnd: '2099-08-31', description: 'High school for 900 students with a sports field.' }),
  B({ id: 'PB-P4', companyId: 'TOWN', facilityId: null, name: 'Beach Car Park P4', kind: 'PARKING', street: TOWN_NAMES.bay, x: 595, z: 515, w: 60, d: 46, h: 0, rotation: 180, floors: 1, staff: 0, status: 'OPERATING', leaseStart: '2010-01-01', leaseEnd: '2060-12-31', description: 'Car park for the beach and the high school (110 spaces).' }),
  B({ id: 'PB-FISH', companyId: 'FISHMKT', facilityId: null, name: "Fisherman's Market", kind: 'STORE', street: TOWN_NAMES.bay, x: 720, z: 515, w: 80, d: 44, h: 9, rotation: 180, floors: 1, staff: 48, status: 'OPERATING', leaseStart: '2016-04-01', leaseEnd: '2036-03-31', description: 'Covered market hall with household goods and fresh stalls.' }),
  B({ id: 'PB-APT9', companyId: 'BAYSIDE', facilityId: null, name: 'Seaview Apartments', kind: 'RESIDENTIAL', street: TOWN_NAMES.bay, x: 838, z: 512, w: 56, d: 38, h: 30, rotation: 180, floors: 10, staff: 3, status: 'OPERATING', leaseStart: '2023-01-01', leaseEnd: '2073-12-31', description: 'Ten-storey apartments facing the beach.' }),
  B({ id: 'PB-HOTEL', companyId: 'MERIDIAN', facilityId: null, name: 'Bayview Hotel', kind: 'OFFICE', street: TOWN_NAMES.bay, x: 235, z: 515, w: 60, d: 44, h: 38, rotation: 180, floors: 11, staff: 120, status: 'OPERATING', leaseStart: '2018-06-01', leaseEnd: '2048-05-31', description: 'Eleven-storey business hotel used by visiting ship crews and freight buyers.' }),
  // Willow Grove
  B({ id: 'PB-WSCHOOL', companyId: 'TOWN', facilityId: null, name: 'Willow Grove Primary School', kind: 'SERVICES', street: STREET_NAMES.A, x: -408, z: 4, w: 64, d: 40, h: 9, rotation: 0, floors: 2, staff: 41, status: 'OPERATING', leaseStart: '2004-09-01', leaseEnd: '2099-08-31', description: 'Primary school for 420 children, with a playground on Riverside Road.' }),
  B({ id: 'PB-WCAFE', companyId: 'EATERIES', facilityId: null, name: 'Willow Corner Café', kind: 'STORE', street: WIL_NAMES.birch, x: -528, z: 72, w: 28, d: 22, h: 6, rotation: 180, floors: 1, staff: 7, status: 'OPERATING', leaseStart: '2022-03-01', leaseEnd: '2032-02-28', description: 'Neighbourhood café and bakery on the corner of Riverside Road.' }),
  // the two park gates
  B({ id: 'PB-GATE-W', companyId: 'PARKAUTH', facilityId: null, name: PARK_GATES.WEST.name, kind: 'GATEHOUSE', street: ROAD_NAMES.artW, x: PARK_GATES.WEST.pos.x, z: PARK_GATES.WEST.pos.z, w: 6, d: 8, h: 4, rotation: 270, floors: 1, staff: 6, status: 'OPERATING', leaseStart: '2015-01-01', leaseEnd: '2045-12-31', description: PARK_GATES.WEST.purpose }),
  B({ id: 'PB-GATE-E', companyId: 'PARKAUTH', facilityId: null, name: PARK_GATES.EAST.name, kind: 'GATEHOUSE', street: ROAD_NAMES.artE, x: PARK_GATES.EAST.pos.x, z: PARK_GATES.EAST.pos.z, w: 6, d: 8, h: 4, rotation: 90, floors: 1, staff: 6, status: 'OPERATING', leaseStart: '2015-01-01', leaseEnd: '2045-12-31', description: PARK_GATES.EAST.purpose }),
];

export const gateBuildingId = (g: GateCode) => (g === 'WEST' ? 'PB-GATE-W' : 'PB-GATE-E');

// ---------------------------------------------------------------- public traffic
export type VehicleKind = 'CAR' | 'VAN' | 'BUS' | 'TRUCK' | 'TANKER' | 'TAXI' | 'TRACTOR';
export type RouteCode =
  | 'HWY_E1' | 'HWY_E2' | 'HWY_W1' | 'HWY_W2' | 'RING_CW' | 'RING_CCW' | 'THROUGH'
  | 'TOWN_W' | 'TOWN_E' | 'TOWN_RING' | 'TOWN_LINK' | 'PORT_YARD'
  | 'EAST_RING' | 'EAST_BLOCK' | 'OCEAN_LINK' | 'MARKET_RUN'
  | 'MAPLE_LOOP' | 'ELM_LOOP' | 'SUBURB_LINK'
  | 'WILLOW_LOOP' | 'BIRCH_LOOP' | 'WILLOW_LINK';

export interface ParkRoute { code: RouteCode; name: string; loop: boolean; pts: Vec2[]; length: number }

function route(code: RouteCode, name: string, loop: boolean, raw: Vec2[], r = 8): ParkRoute {
  let src = raw;
  if (loop) {
    // start mid-way along the first edge so that every corner of the ring gets rounded
    const m = { x: (raw[0].x + raw[1].x) / 2, z: (raw[0].z + raw[1].z) / 2 };
    src = [m, ...raw.slice(1), raw[0], m];
  }
  const pts = roundCorners(src, r);
  return { code, name, loop, pts, length: pathLength(pts) };
}

const A = STREETS.A, Bz = STREETS.B;
const HWY_XL = -1100, HWY_XR = 1100; // the highway's drawn extent (bridge in the west, Cedar Avenue in the east)
const HILL = SUB_STREETS.hill, OAK = SUB_STREETS.oak;
export const PARK_ROUTES: Record<RouteCode, ParkRoute> = {
  HWY_E1: route('HWY_E1', 'Port Highway eastbound (lane 1)', false, [{ x: HWY_XL, z: HWY_EAST_LANES[0] }, { x: HWY_XR, z: HWY_EAST_LANES[0] }]),
  HWY_E2: route('HWY_E2', 'Port Highway eastbound (lane 2)', false, [{ x: HWY_XL, z: HWY_EAST_LANES[1] }, { x: HWY_XR, z: HWY_EAST_LANES[1] }]),
  HWY_W1: route('HWY_W1', 'Port Highway westbound (lane 1)', false, [{ x: HWY_XR, z: HWY_WEST_LANES[0] }, { x: HWY_XL, z: HWY_WEST_LANES[0] }]),
  HWY_W2: route('HWY_W2', 'Port Highway westbound (lane 2)', false, [{ x: HWY_XR, z: HWY_WEST_LANES[1] }, { x: HWY_XL, z: HWY_WEST_LANES[1] }]),
  // clockwise round the block: Riverside Rd westbound → Harbor Ave north → Northgate Way east → Industrial Ave south
  RING_CW: route('RING_CW', 'Park ring road (clockwise)', true, [
    { x: ART_E - 3, z: A - 3 }, { x: ART_W + 3, z: A - 3 }, { x: ART_W + 3, z: Bz + 3 }, { x: ART_E - 3, z: Bz + 3 },
  ]),
  RING_CCW: route('RING_CCW', 'Park ring road (anticlockwise)', true, [
    { x: ART_W - 3, z: Bz - 3 }, { x: ART_W - 3, z: A + 3 }, { x: ART_E + 3, z: A + 3 }, { x: ART_E + 3, z: Bz - 3 },
  ]),
  THROUGH: route('THROUGH', 'Highway → Harbor Ave → Riverside Rd → Industrial Ave → Highway', false, [
    { x: HWY_X0 - 60, z: HWY_EAST_LANES[0] }, { x: ART_W + 3, z: HWY_EAST_LANES[0] }, { x: ART_W + 3, z: A + 3 },
    { x: ART_E - 3, z: A + 3 }, { x: ART_E - 3, z: HWY_EAST_LANES[0] }, { x: HWY_X1 + 60, z: HWY_EAST_LANES[0] },
  ]),
  // Port Harbor town blocks (same lane rule: drive on the right)
  TOWN_W: route('TOWN_W', 'Market St · Harbor Ave · Bay Rd · Central Ave (west block)', true, [
    { x: CENTRAL_X - 3, z: BAY_Z - 3 }, { x: ART_W + 3, z: BAY_Z - 3 }, { x: ART_W + 3, z: MARKET_Z + 3 }, { x: CENTRAL_X - 3, z: MARKET_Z + 3 },
  ]),
  TOWN_E: route('TOWN_E', 'Market St · Central Ave · Bay Rd · Industrial Ave (east block)', true, [
    { x: CENTRAL_X - 3, z: MARKET_Z - 3 }, { x: CENTRAL_X - 3, z: BAY_Z + 3 }, { x: ART_E + 3, z: BAY_Z + 3 }, { x: ART_E + 3, z: MARKET_Z - 3 },
  ]),
  TOWN_RING: route('TOWN_RING', 'Port Harbor ring: Market St · Industrial Ave · Shore Rd · Harbor Ave', true, [
    { x: ART_E - 3, z: SHORE_Z - 3 }, { x: ART_W + 3, z: SHORE_Z - 3 }, { x: ART_W + 3, z: MARKET_Z + 3 }, { x: ART_E - 3, z: MARKET_Z + 3 },
  ]),
  TOWN_LINK: route('TOWN_LINK', 'Highway → Industrial Ave → Market St → Harbor Ave → Highway', true, [
    { x: ART_W + 3, z: HWY_EAST_LANES[0] }, { x: ART_E - 3, z: HWY_EAST_LANES[0] }, { x: ART_E - 3, z: MARKET_Z - 3 },
    { x: ART_W + 3, z: MARKET_Z - 3 },
  ]),
  // east district
  EAST_RING: route('EAST_RING', 'East ring: Market St · Cedar Ave · Shore Rd · Industrial Ave', true, [
    { x: CEDAR_X - 3, z: SHORE_Z - 3 }, { x: ART_E + 3, z: SHORE_Z - 3 }, { x: ART_E + 3, z: MARKET_Z + 3 }, { x: CEDAR_X - 3, z: MARKET_Z + 3 },
  ]),
  EAST_BLOCK: route('EAST_BLOCK', 'Ocean Ave · Bay Rd · Cedar Ave · Market St', true, [
    { x: OCEAN_X - 3, z: MARKET_Z - 3 }, { x: OCEAN_X - 3, z: BAY_Z + 3 }, { x: CEDAR_X + 3, z: BAY_Z + 3 }, { x: CEDAR_X + 3, z: MARKET_Z - 3 },
  ]),
  OCEAN_LINK: route('OCEAN_LINK', 'Highway → Ocean Ave → Shore Rd → Industrial Ave → Highway', true, [
    { x: ART_E + 3, z: HWY_EAST_LANES[0] }, { x: OCEAN_X - 3, z: HWY_EAST_LANES[0] }, { x: OCEAN_X - 3, z: SHORE_Z - 3 }, { x: ART_E + 3, z: SHORE_Z - 3 },
  ]),
  MARKET_RUN: route('MARKET_RUN', 'Market Street end to end (Harbor Ave → Cedar Ave)', true, [
    { x: CEDAR_X - 3, z: MARKET_Z - 3 }, { x: ART_W + 3, z: MARKET_Z - 3 }, { x: ART_W + 3, z: BAY_Z + 3 }, { x: CEDAR_X - 3, z: BAY_Z + 3 },
  ]),
  // Maple Heights housing estate
  MAPLE_LOOP: route('MAPLE_LOOP', 'Maple Heights: Industrial Ave · Oak Ln · Cedar Ave · Hillcrest Rd', true, [
    { x: SUB_X0 - 3, z: HILL - 3 }, { x: SUB_X0 - 3, z: OAK + 3 }, { x: SUB_X1 + 3, z: OAK + 3 }, { x: SUB_X1 + 3, z: HILL - 3 },
  ]),
  ELM_LOOP: route('ELM_LOOP', 'Maple Ave · Oak Ln · Cedar Ave · Northgate Way', true, [
    { x: MAPLE_X - 3, z: Bz - 3 }, { x: MAPLE_X - 3, z: OAK + 3 }, { x: SUB_X1 + 3, z: OAK + 3 }, { x: SUB_X1 + 3, z: Bz - 3 },
  ]),
  SUBURB_LINK: route('SUBURB_LINK', 'Highway → Cedar Ave → Hillcrest Rd → Industrial Ave → Highway', true, [
    { x: SUB_X0 - 3, z: HILL - 3 }, { x: SUB_X0 - 3, z: HWY_EAST_LANES[0] }, { x: SUB_X1 + 3, z: HWY_EAST_LANES[0] }, { x: SUB_X1 + 3, z: HILL - 3 },
  ]),
  // Willow Grove housing estate
  WILLOW_LOOP: route('WILLOW_LOOP', 'Willow Grove: Willow Ave · Oak Ln · Harbor Ave · Hillcrest Rd', true, [
    { x: WIL_X0 - 3, z: HILL - 3 }, { x: WIL_X0 - 3, z: OAK + 3 }, { x: WIL_X1 + 3, z: OAK + 3 }, { x: WIL_X1 + 3, z: HILL - 3 },
  ]),
  BIRCH_LOOP: route('BIRCH_LOOP', 'Birch Ln · Oak Ln · Harbor Ave · Northgate Way', true, [
    { x: BIRCH_X - 3, z: Bz - 3 }, { x: BIRCH_X - 3, z: OAK + 3 }, { x: WIL_X1 + 3, z: OAK + 3 }, { x: WIL_X1 + 3, z: Bz - 3 },
  ]),
  WILLOW_LINK: route('WILLOW_LINK', 'Highway → Birch Ln → Hillcrest Rd → Willow Ave → Highway', true, [
    { x: WIL_X0 - 3, z: HILL - 3 }, { x: WIL_X0 - 3, z: HWY_EAST_LANES[0] }, { x: BIRCH_X + 3, z: HWY_EAST_LANES[0] }, { x: BIRCH_X + 3, z: HILL - 3 },
  ]),
  PORT_YARD: route('PORT_YARD', 'Container terminal yard loop (quay ↔ stacks)', true, [
    { x: -608, z: 333 }, { x: -792, z: 333 }, { x: -792, z: 293 }, { x: -608, z: 293 },
  ], 6),
};

export interface ParkVehicle {
  id: string;
  companyId: string | null; // null = public traffic
  kind: VehicleKind;
  plate: string;
  color: string;
  route: RouteCode;
  speedKmh: number;
  offset: number; // 0..1 start position along the route
}

const V = (id: string, companyId: string | null, kind: VehicleKind, plate: string, color: string, r: RouteCode, speedKmh: number, offset: number): ParkVehicle =>
  ({ id, companyId, kind, plate, color, route: r, speedKmh, offset });

export const PARK_VEHICLES: ParkVehicle[] = [
  V('VEH-101', null, 'CAR', 'NJ-A41-KTR', '#e4572e', 'HWY_E1', 64, 0.05),
  V('VEH-102', null, 'CAR', 'NY-HB2-219', '#f3f6fb', 'HWY_E1', 64, 0.38),
  V('VEH-103', null, 'TRUCK', 'PA-TR7-551', '#4c6ef5', 'HWY_E2', 50, 0.2),
  V('VEH-104', null, 'CAR', 'NJ-C90-ZPL', '#2b2d42', 'HWY_E1', 64, 0.71),
  V('VEH-105', null, 'VAN', 'NJ-VN3-804', '#ffffff', 'HWY_E2', 54, 0.62),
  V('VEH-106', null, 'CAR', 'CT-7KL-330', '#ffb703', 'HWY_W1', 66, 0.1),
  V('VEH-107', null, 'TANKER', 'NJ-TK1-090', '#c0c7d6', 'HWY_W2', 48, 0.3),
  V('VEH-108', null, 'CAR', 'NJ-R22-MXA', '#3a86ff', 'HWY_W1', 66, 0.45),
  V('VEH-109', null, 'CAR', 'DE-5TT-118', '#8d99ae', 'HWY_W1', 66, 0.8),
  V('VEH-110', null, 'TRUCK', 'NY-TR4-772', '#2a9d8f', 'HWY_W2', 50, 0.75),
  V('VEH-111', null, 'VAN', 'NJ-VN8-215', '#f1f3f8', 'HWY_W2', 52, 0.02),
  V('VEH-201', 'PARKAUTH', 'BUS', 'NJ-BUS-001', '#f59f00', 'RING_CW', 30, 0.0),
  V('VEH-202', 'APEX', 'VAN', 'NJ-APX-112', '#e0533d', 'RING_CW', 36, 0.33),
  V('VEH-203', 'MERIDIAN', 'CAR', 'NJ-MRD-007', '#33415c', 'RING_CW', 38, 0.62),
  V('VEH-204', 'PARKAUTH', 'CAR', 'NJ-SEC-004', '#ffffff', 'RING_CW', 34, 0.84),
  V('VEH-205', 'GREENLEAF', 'TRUCK', 'NJ-GLB-560', '#2f9e5b', 'RING_CCW', 32, 0.12),
  V('VEH-206', 'BAYVIEW', 'VAN', 'NJ-BVF-310', '#d6336c', 'RING_CCW', 36, 0.45),
  V('VEH-207', 'HELIOS', 'CAR', 'NJ-HLS-220', '#f2a516', 'RING_CCW', 38, 0.7),
  V('VEH-208', 'NORDIC', 'TRUCK', 'NJ-NFF-901', '#1e8fb3', 'RING_CCW', 32, 0.9),
  V('VEH-301', 'ATLAS', 'TRUCK', 'NJ-ATL-414', '#b86b2e', 'THROUGH', 44, 0.15),
  V('VEH-302', 'BRIGHTLINE', 'VAN', 'NJ-BML-118', '#7a5af5', 'THROUGH', 46, 0.52),
  V('VEH-303', null, 'CAR', 'NJ-T55-QWE', '#06d6a0', 'THROUGH', 48, 0.8),
  // more highway traffic
  V('VEH-112', null, 'TRUCK', 'NJ-PRT-118', '#0b7285', 'HWY_E2', 48, 0.88),
  V('VEH-113', null, 'CAR', 'NJ-L80-DSK', '#adb5bd', 'HWY_E1', 66, 0.55),
  V('VEH-114', null, 'TRUCK', 'NY-CNT-401', '#e8590c', 'HWY_W2', 50, 0.52),
  V('VEH-115', null, 'CAR', 'NJ-F12-WQP', '#d00000', 'HWY_W1', 68, 0.28),
  V('VEH-116', null, 'TAXI', 'NJ-TXI-207', '#fcc419', 'HWY_E1', 62, 0.21),
  V('VEH-117', null, 'TANKER', 'PA-TK5-233', '#ced4da', 'HWY_E2', 46, 0.4),
  V('VEH-118', null, 'CAR', 'NJ-Z71-KQA', '#5f3dc4', 'HWY_W1', 66, 0.64),
  V('VEH-209', 'PARKAUTH', 'CAR', 'NJ-SEC-009', '#ffffff', 'RING_CCW', 34, 0.28),
  V('VEH-210', 'APEX', 'TRUCK', 'NJ-APX-220', '#e0533d', 'RING_CW', 32, 0.5),
  // town traffic
  V('VEH-401', 'TOWN', 'BUS', 'NJ-BUS-014', '#1c7ed6', 'TOWN_RING', 28, 0.0),
  V('VEH-402', null, 'CAR', 'NJ-H71-AAP', '#f76707', 'TOWN_RING', 34, 0.18),
  V('VEH-403', null, 'TAXI', 'NJ-TXI-118', '#fcc419', 'TOWN_RING', 36, 0.42),
  V('VEH-404', null, 'CAR', 'NJ-B08-PLM', '#37b24d', 'TOWN_RING', 34, 0.66),
  V('VEH-405', null, 'VAN', 'NJ-PLM-450', '#ffffff', 'TOWN_RING', 32, 0.83),
  V('VEH-406', null, 'CAR', 'NJ-M13-XRA', '#495057', 'TOWN_W', 30, 0.1),
  V('VEH-407', null, 'CAR', 'NJ-K44-BTY', '#e64980', 'TOWN_W', 30, 0.45),
  V('VEH-408', 'TOWN', 'CAR', 'NJ-PHD-001', '#1864ab', 'TOWN_W', 32, 0.75),
  V('VEH-409', null, 'CAR', 'NJ-V20-OOP', '#fab005', 'TOWN_E', 30, 0.05),
  V('VEH-410', null, 'TAXI', 'NJ-TXI-330', '#fcc419', 'TOWN_E', 32, 0.35),
  V('VEH-411', null, 'CAR', 'NJ-G56-LKJ', '#868e96', 'TOWN_E', 30, 0.62),
  V('VEH-412', 'TOWN', 'BUS', 'NJ-BUS-021', '#e03131', 'TOWN_E', 26, 0.88),
  V('VEH-413', null, 'CAR', 'NJ-R90-UYT', '#0c8599', 'TOWN_LINK', 40, 0.12),
  V('VEH-414', null, 'CAR', 'NY-W31-QAZ', '#f8f9fa', 'TOWN_LINK', 40, 0.48),
  V('VEH-415', null, 'VAN', 'NJ-DLV-781', '#ffd43b', 'TOWN_LINK', 38, 0.78),
  // east district traffic
  V('VEH-420', 'TOWN', 'BUS', 'NJ-BUS-033', '#2f9e44', 'EAST_RING', 26, 0.05),
  V('VEH-421', null, 'CAR', 'NJ-E21-HTR', '#e03131', 'EAST_RING', 32, 0.22),
  V('VEH-422', null, 'TAXI', 'NJ-TXI-412', '#fcc419', 'EAST_RING', 34, 0.38),
  V('VEH-423', null, 'CAR', 'NJ-P55-LMA', '#ced4da', 'EAST_RING', 32, 0.55),
  V('VEH-424', 'FISHMKT', 'VAN', 'NJ-FSH-118', '#1971c2', 'EAST_RING', 30, 0.72),
  V('VEH-425', null, 'CAR', 'NJ-Q12-WER', '#364fc7', 'EAST_RING', 32, 0.88),
  V('VEH-426', null, 'CAR', 'NJ-Y81-PLO', '#0ca678', 'EAST_BLOCK', 28, 0.1),
  V('VEH-427', 'HSBANK', 'VAN', 'NJ-HSB-007', '#2f9e44', 'EAST_BLOCK', 28, 0.45),
  V('VEH-428', null, 'TAXI', 'NJ-TXI-519', '#fcc419', 'EAST_BLOCK', 30, 0.78),
  V('VEH-429', null, 'CAR', 'NJ-D44-ZXC', '#f76707', 'OCEAN_LINK', 40, 0.15),
  V('VEH-430', null, 'CAR', 'NY-K02-MNB', '#212529', 'OCEAN_LINK', 40, 0.42),
  V('VEH-431', 'STARLIGHT', 'VAN', 'NJ-STR-220', '#c2255c', 'OCEAN_LINK', 36, 0.68),
  V('VEH-432', null, 'TRUCK', 'NJ-DLV-905', '#868e96', 'OCEAN_LINK', 34, 0.9),
  V('VEH-433', 'TOWN', 'BUS', 'NJ-BUS-040', '#f59f00', 'MARKET_RUN', 24, 0.0),
  V('VEH-434', null, 'CAR', 'NJ-U66-RTY', '#ae3ec9', 'MARKET_RUN', 30, 0.12),
  V('VEH-435', null, 'CAR', 'NJ-I90-GHJ', '#74c0fc', 'MARKET_RUN', 30, 0.25),
  V('VEH-436', null, 'TAXI', 'NJ-TXI-604', '#fcc419', 'MARKET_RUN', 32, 0.37),
  V('VEH-437', null, 'CAR', 'NJ-O31-VBN', '#f8f9fa', 'MARKET_RUN', 30, 0.5),
  V('VEH-438', 'EATERIES', 'VAN', 'NJ-EAT-301', '#e8590c', 'MARKET_RUN', 28, 0.62),
  V('VEH-439', null, 'CAR', 'NJ-A72-SDF', '#5c940d', 'MARKET_RUN', 30, 0.75),
  V('VEH-440', null, 'CAR', 'NJ-W48-QAS', '#495057', 'MARKET_RUN', 30, 0.87),
  V('VEH-441', null, 'CAR', 'NJ-B17-ZQW', '#fab005', 'TOWN_RING', 34, 0.55),
  V('VEH-442', null, 'CAR', 'NJ-C29-XSW', '#1c7ed6', 'TOWN_W', 30, 0.28),
  V('VEH-443', null, 'CAR', 'NJ-V36-CDE', '#e64980', 'TOWN_E', 30, 0.2),
  V('VEH-444', null, 'TRUCK', 'NJ-BLD-777', '#fd7e14', 'HWY_W2', 46, 0.12),
  V('VEH-445', null, 'CAR', 'NJ-N58-VFR', '#adb5bd', 'HWY_E1', 64, 0.92),
  // Maple Heights residents
  V('VEH-450', 'TOWN', 'BUS', 'NJ-BUS-022', '#fcc419', 'MAPLE_LOOP', 26, 0.0),
  V('VEH-451', null, 'CAR', 'NJ-M12-HTS', '#f8f9fa', 'MAPLE_LOOP', 30, 0.2),
  V('VEH-452', null, 'CAR', 'NJ-M33-OAK', '#c92a2a', 'MAPLE_LOOP', 30, 0.45),
  V('VEH-453', null, 'CAR', 'NJ-M47-ELM', '#364fc7', 'MAPLE_LOOP', 30, 0.7),
  V('VEH-454', null, 'CAR', 'NJ-M58-PNE', '#2f9e44', 'ELM_LOOP', 28, 0.1),
  V('VEH-455', null, 'CAR', 'NJ-M61-ASH', '#868e96', 'ELM_LOOP', 28, 0.42),
  V('VEH-456', null, 'VAN', 'NJ-M70-PST', '#e8590c', 'ELM_LOOP', 28, 0.76),
  V('VEH-457', null, 'CAR', 'NJ-M82-BRC', '#212529', 'SUBURB_LINK', 36, 0.05),
  V('VEH-458', null, 'CAR', 'NJ-M93-WLW', '#f59f00', 'SUBURB_LINK', 36, 0.35),
  V('VEH-459', null, 'TAXI', 'NJ-TX-0451', '#fab005', 'SUBURB_LINK', 36, 0.6),
  V('VEH-460', null, 'CAR', 'NJ-M04-FIR', '#a5d8ff', 'SUBURB_LINK', 36, 0.85),
  V('VEH-461', null, 'CAR', 'NJ-M15-YEW', '#e599f7', 'MAPLE_LOOP', 30, 0.9),
  // Willow Grove residents
  V('VEH-470', 'TOWN', 'BUS', 'NJ-BUS-031', '#37b24d', 'WILLOW_LOOP', 26, 0.0),
  V('VEH-471', null, 'CAR', 'NJ-W11-WLO', '#f1f3f5', 'WILLOW_LOOP', 30, 0.22),
  V('VEH-472', null, 'CAR', 'NJ-W24-BRH', '#1971c2', 'WILLOW_LOOP', 30, 0.48),
  V('VEH-473', null, 'CAR', 'NJ-W37-ASP', '#e8590c', 'WILLOW_LOOP', 30, 0.74),
  V('VEH-474', null, 'CAR', 'NJ-W45-LND', '#495057', 'BIRCH_LOOP', 28, 0.12),
  V('VEH-475', null, 'VAN', 'NJ-W52-PLM', '#fab005', 'BIRCH_LOOP', 28, 0.55),
  V('VEH-476', null, 'CAR', 'NJ-W68-HZL', '#9c36b5', 'WILLOW_LINK', 36, 0.1),
  V('VEH-477', null, 'TAXI', 'NJ-TX-0477', '#fab005', 'WILLOW_LINK', 36, 0.45),
  V('VEH-478', null, 'CAR', 'NJ-W83-RWN', '#2b8a3e', 'WILLOW_LINK', 36, 0.8),
  // terminal tractors shuttling boxes between the quay cranes and the stacks
  V('VEH-501', 'PORTNWK', 'TRACTOR', 'TT-01', '#f59f00', 'PORT_YARD', 20, 0.0),
  V('VEH-502', 'PORTNWK', 'TRACTOR', 'TT-02', '#f59f00', 'PORT_YARD', 20, 0.25),
  V('VEH-503', 'PORTNWK', 'TRACTOR', 'TT-03', '#f59f00', 'PORT_YARD', 20, 0.5),
  V('VEH-504', 'PORTNWK', 'TRACTOR', 'TT-04', '#f59f00', 'PORT_YARD', 20, 0.75),
];

/** Scene units per real second for a vehicle's speed in km/h. */
export const kmhToUnits = (kmh: number) => kmh / 4.6;

/** Position and heading of a vehicle at a given simulation run time (seconds). */
export function vehiclePose(v: ParkVehicle, runTime: number): { x: number; z: number; heading: number; t: number } {
  const r = PARK_ROUTES[v.route];
  const speed = kmhToUnits(v.speedKmh);
  let d = (v.offset * r.length + runTime * speed) % r.length;
  if (d < 0) d += r.length;
  // walk the polyline
  let acc = 0;
  for (let i = 1; i < r.pts.length; i++) {
    const a = r.pts[i - 1], b = r.pts[i];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (seg <= 0) continue;
    if (acc + seg >= d) {
      const t = (d - acc) / seg;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, heading: Math.atan2(b.z - a.z, b.x - a.x), t: d / r.length };
    }
    acc += seg;
  }
  const p = r.pts[r.pts.length - 1];
  return { x: p.x, z: p.z, heading: 0, t: 1 };
}

/** Which road a park position is on (for info panels). */
export function roadAt(p: Vec2): string {
  if (Math.abs(p.z - HWY_Z) <= HWY_HALF + 1) return ROAD_NAMES.hwy;
  if (p.x < -600 && p.z > 255) return 'Container terminal';
  if (p.z > HWY_SOUTH_EDGE) {
    if (Math.abs(p.z - MARKET_Z) <= STREET_HALF + 1) return TOWN_NAMES.market;
    if (Math.abs(p.z - BAY_Z) <= STREET_HALF + 1) return TOWN_NAMES.bay;
    if (Math.abs(p.z - SHORE_Z) <= STREET_HALF + 1) return TOWN_NAMES.shore;
    if (Math.abs(p.x - CENTRAL_X) <= STREET_HALF + 1) return TOWN_NAMES.central;
    if (Math.abs(p.x - OCEAN_X) <= STREET_HALF + 1) return TOWN_NAMES.ocean;
    if (Math.abs(p.x - CEDAR_X) <= ART_HALF + 1) return TOWN_NAMES.cedar;
    if (p.z > SHORE_Z + STREET_HALF) return 'Port Harbor Beach';
  }
  if (p.x > SUB_X0 + ART_HALF + 1 && p.z < HWY_Z - HWY_HALF) {
    if (Math.abs(p.z - SUB_STREETS.hill) <= STREET_HALF + 1) return SUB_NAMES.hill;
    if (Math.abs(p.z - SUB_STREETS.elm) <= STREET_HALF + 1) return SUB_NAMES.elm;
    if (Math.abs(p.z - SUB_STREETS.oak) <= STREET_HALF + 1) return SUB_NAMES.oak;
    if (Math.abs(p.x - MAPLE_X) <= STREET_HALF + 1) return SUB_NAMES.maple;
    if (Math.abs(p.x - SUB_X1) <= ART_HALF + 1) return TOWN_NAMES.cedar;
    if (Math.abs(p.z - STREETS.A) <= STREET_HALF + 1) return STREET_NAMES.A;
    if (Math.abs(p.z - STREETS.B) <= STREET_HALF + 1) return STREET_NAMES.B;
    return 'Maple Heights';
  }
  if (p.x < WIL_X1 - ART_HALF - 1 && p.x > WIL_X0 - ART_HALF - 2 && p.z < HWY_Z - HWY_HALF) {
    if (Math.abs(p.z - SUB_STREETS.hill) <= STREET_HALF + 1) return SUB_NAMES.hill;
    if (Math.abs(p.z - SUB_STREETS.elm) <= STREET_HALF + 1) return SUB_NAMES.elm;
    if (Math.abs(p.z - SUB_STREETS.oak) <= STREET_HALF + 1) return SUB_NAMES.oak;
    if (Math.abs(p.z - STREETS.A) <= STREET_HALF + 1) return STREET_NAMES.A;
    if (Math.abs(p.z - STREETS.B) <= STREET_HALF + 1) return STREET_NAMES.B;
    if (Math.abs(p.x - WIL_X0) <= ART_HALF + 1) return WIL_NAMES.willow;
    if (Math.abs(p.x - BIRCH_X) <= STREET_HALF + 1) return WIL_NAMES.birch;
    return WIL_NAMES.estate;
  }
  if (Math.abs(p.x - ART_W) <= ART_HALF + 1) return ROAD_NAMES.artW;
  if (Math.abs(p.x - ART_E) <= ART_HALF + 1) return ROAD_NAMES.artE;
  if (Math.abs(p.z - STREETS.A) <= STREET_HALF + 1) return STREET_NAMES.A;
  if (Math.abs(p.z - STREETS.B) <= STREET_HALF + 1) return STREET_NAMES.B;
  return 'Inside the park';
}

/** Overall extent of the park (used by the overview camera). */
export const PARK_BOUNDS = { x0: -900, x1: 920, z0: -320, z1: 620 };
