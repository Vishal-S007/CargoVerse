// Smart warehouse: the storage layout inside each building (racks, bins, the aisle
// network), product handling rules, GS1 helpers and the deterministic seed data the
// warehouse-management features start from. Pure data and geometry: shared by the
// server (simulation, Oracle seed generator) and the 3D view.
import type { FacilityId, Vec2 } from './types';
import { LAYOUTS } from './layouts';

// ---------------------------------------------------------------- product handling rules
export type TempZone = 'AMBIENT' | 'COLD';
export interface SkuHandling {
  skuId: string;
  shelfLifeDays: number | null; // null = does not expire (FIFO by receipt instead of FEFO)
  tempZone: TempZone;
  minC: number;
  maxC: number;
  leadTimeDays: number;  // supplier lead time, for the reorder point
  unitCost: number;      // USD, for the economic order quantity
  orderCost: number;     // USD per purchase order
  supplier: string;
  description: string;   // catalogue text (semantic search)
}

export const SKU_HANDLING: Record<string, SkuHandling> = {
  'BOX-M': { skuId: 'BOX-M', shelfLifeDays: null, tempZone: 'AMBIENT', minC: -10, maxC: 40, leadTimeDays: 3, unitCost: 1.2, orderCost: 60, supplier: 'Keystone Paper',
    description: 'Medium corrugated cardboard shipping box, flat packed, for parcels and moving' },
  'CNT-P': { skuId: 'CNT-P', shelfLifeDays: null, tempZone: 'AMBIENT', minC: -10, maxC: 40, leadTimeDays: 5, unitCost: 6.5, orderCost: 80, supplier: 'Paulista Plásticos',
    description: 'Stackable plastic storage container with lid, reusable tote for shelves and bins' },
  'PPE-HLM-Y': { skuId: 'PPE-HLM-Y', shelfLifeDays: 1825, tempZone: 'AMBIENT', minC: -10, maxC: 40, leadTimeDays: 7, unitCost: 14, orderCost: 90, supplier: 'Nordic Workwear A/S',
    description: 'Yellow safety helmet hard hat, head protection for construction and warehouse workers' },
  'PKG-TAPE': { skuId: 'PKG-TAPE', shelfLifeDays: 730, tempZone: 'AMBIENT', minC: 5, maxC: 35, leadTimeDays: 4, unitCost: 2.5, orderCost: 60, supplier: 'Keystone Paper',
    description: 'Clear adhesive packing tape roll for sealing cartons' },
  'LED-6060': { skuId: 'LED-6060', shelfLifeDays: null, tempZone: 'AMBIENT', minC: -10, maxC: 40, leadTimeDays: 14, unitCost: 38, orderCost: 150, supplier: 'Straits Lighting Pte',
    description: 'Recessed LED ceiling light panel 60 by 60 cm, fragile glass diffuser, office lighting' },
  'CHR-OFC': { skuId: 'CHR-OFC', shelfLifeDays: null, tempZone: 'AMBIENT', minC: -10, maxC: 40, leadTimeDays: 21, unitCost: 120, orderCost: 200, supplier: 'Pearl River Office Co.',
    description: 'Ergonomic office chair with wheels, flat packed furniture, needs assembly' },
  'GLV-NIT': { skuId: 'GLV-NIT', shelfLifeDays: 1095, tempZone: 'AMBIENT', minC: 5, maxC: 30, leadTimeDays: 10, unitCost: 6, orderCost: 70, supplier: 'Brightline Medical',
    description: 'Box of disposable blue nitrile examination gloves, medical and food handling' },
  'MED-INS': { skuId: 'MED-INS', shelfLifeDays: 270, tempZone: 'COLD', minC: 2, maxC: 8, leadTimeDays: 7, unitCost: 25, orderCost: 120, supplier: 'Brightline Medical',
    description: 'Insulin pen injectors, refrigerated pharmaceutical, cold chain 2 to 8 degrees, pharmacy' },
};

/** Colour of each product in the X-ray view and the warehouse tables. */
export const SKU_COLORS: Record<string, string> = {
  'BOX-M': '#c8955a', 'CNT-P': '#3b82f6', 'PPE-HLM-Y': '#f2b33d', 'PKG-TAPE': '#8b5e3c', 'LED-6060': '#a78bfa', 'CHR-OFC': '#64748b', 'GLV-NIT': '#14b8a6', 'MED-INS': '#ef4444',
};

// ---------------------------------------------------------------- racks, bins and the aisle network
export const LEVELS = 3;
const AISLE_STEP = 7;      // metres between aisle centre lines
const RACK_OFF = 2.3;      // rack face from the aisle centre line
const BAY_STEP = 2.8;
const FRONT_Z = -3.2;      // cross aisle along the dock wall
const DOCK_Z = -1.2;       // inside each dock door
const COLD_AISLES: Partial<Record<FacilityId, number>> = { 'WH-04': 2 }; // east end of Southfield is a 2–8 °C cold room

export interface Bin {
  id: string;            // e.g. WH-04-C07L2 = aisle C, bay 07, left side, level 2
  facilityId: FacilityId;
  aisle: string;
  bay: number;
  side: 'L' | 'R';
  level: number;
  x: number;             // site coordinates (the building's front wall is z = 0)
  z: number;
  y: number;
  nodeId: string;        // the aisle point a forklift stops at to reach this bin
  zone: TempZone;
  dockMetres: number;    // shortest travel from the nearest dock door
}
export interface WhNode { id: string; facilityId: FacilityId; kind: 'DOCK' | 'CROSS' | 'AISLE'; x: number; z: number; label: string }
export interface WhEdge { id: number; facilityId: FacilityId; from: string; to: string; metres: number }
export interface SiteStorage {
  facilityId: FacilityId;
  bins: Bin[];
  nodes: WhNode[];
  edges: WhEdge[];
  aisles: { letter: string; x: number; zone: TempZone }[];
  bays: number[];        // z of each bay
  backZ: number;
  coldX0: number | null; // west edge of the cold room
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function buildSite(fac: FacilityId): SiteStorage {
  const L = LAYOUTS[fac];
  const { x0, x1, depth } = L.building;
  const aisleXs: number[] = [];
  for (let x = x0 + 5; x <= x1 - 4.6; x += AISLE_STEP) aisleXs.push(r2(x));
  const bays: number[] = [];
  for (let z = -6.6; z >= -depth + 4.6; z -= BAY_STEP) bays.push(r2(z));
  const backZ = r2(-depth + 2.4);
  const cold = COLD_AISLES[fac] ?? 0;
  const aisles = aisleXs.map((x, i) => ({ letter: LETTERS[i], x, zone: (i >= aisleXs.length - cold ? 'COLD' : 'AMBIENT') as TempZone }));
  const nodes: WhNode[] = [];
  const edges: WhEdge[] = [];
  let eid = 1;
  const node = (id: string, kind: WhNode['kind'], x: number, z: number, label: string) => { nodes.push({ id, facilityId: fac, kind, x: r2(x), z: r2(z), label }); return id; };
  const link = (a: WhNode | undefined, b: WhNode | undefined) => {
    if (!a || !b) return;
    edges.push({ id: eid++, facilityId: fac, from: a.id, to: b.id, metres: r2(Math.hypot(a.x - b.x, a.z - b.z)) });
  };
  const byId = (id: string) => nodes.find((n) => n.id === id);
  // front cross aisle: one point per aisle and per dock door, joined left to right
  const front: WhNode[] = [];
  for (const a of aisles) front.push(byId(node(`${fac}-F${a.letter}`, 'CROSS', a.x, FRONT_Z, `Cross aisle at ${a.letter}`))!);
  for (const [dockId, dx] of Object.entries(L.doors)) {
    const f = byId(node(`${fac}-F${dockId.slice(fac.length + 1)}`, 'CROSS', dx, FRONT_Z, `Cross aisle at ${dockId}`))!;
    front.push(f);
    const d = byId(node(dockId, 'DOCK', dx, DOCK_Z, dockId))!;
    link(d, f);
  }
  front.sort((a, b) => a.x - b.x);
  for (let i = 1; i < front.length; i++) link(front[i - 1], front[i]);
  // each aisle: front → bay points → back cross aisle
  const back: WhNode[] = [];
  for (const a of aisles) {
    let prev = byId(`${fac}-F${a.letter}`);
    bays.forEach((z, j) => {
      const n = byId(node(`${fac}-${a.letter}${String(j + 1).padStart(2, '0')}`, 'AISLE', a.x, z, `Aisle ${a.letter} bay ${j + 1}`))!;
      link(prev, n);
      prev = n;
    });
    const b = byId(node(`${fac}-K${a.letter}`, 'CROSS', a.x, backZ, `Back aisle at ${a.letter}`))!;
    link(prev, b);
    back.push(b);
  }
  for (let i = 1; i < back.length; i++) link(back[i - 1], back[i]);
  // bins on both rack faces of every aisle, three levels
  const bins: Bin[] = [];
  for (const a of aisles) {
    bays.forEach((z, j) => {
      for (const side of ['L', 'R'] as const) {
        for (let level = 1; level <= LEVELS; level++) {
          const bay = j + 1;
          bins.push({
            id: `${fac}-${a.letter}${String(bay).padStart(2, '0')}${side}${level}`, facilityId: fac, aisle: a.letter, bay, side, level,
            x: r2(a.x + (side === 'L' ? -RACK_OFF : RACK_OFF)), z, y: r2(0.15 + (level - 1) * 1.55),
            nodeId: `${fac}-${a.letter}${String(bay).padStart(2, '0')}`, zone: a.zone, dockMetres: 0,
          });
        }
      }
    });
  }
  const site: SiteStorage = { facilityId: fac, bins, nodes, edges, aisles, bays, backZ, coldX0: cold ? r2(aisles[aisles.length - cold].x - RACK_OFF - 1.4) : null };
  const dist = distancesFrom(site, nodes.filter((n) => n.kind === 'DOCK').map((n) => n.id));
  for (const b of bins) b.dockMetres = r2((dist.get(b.nodeId) ?? 999) + (b.level - 1) * 1.5); // higher levels cost reach-truck time
  return site;
}

const SITES = new Map<FacilityId, SiteStorage>();
export function siteStorage(fac: FacilityId): SiteStorage {
  let s = SITES.get(fac);
  if (!s) { s = buildSite(fac); SITES.set(fac, s); }
  return s;
}
export const WMS_FACILITIES: FacilityId[] = ['WH-01', 'WH-02', 'WH-04'];
export function allBins(): Bin[] { return WMS_FACILITIES.flatMap((f) => siteStorage(f).bins); }
const BIN_INDEX = new Map<string, Bin>();
export function binById(id: string): Bin | undefined {
  if (!BIN_INDEX.size) for (const b of allBins()) BIN_INDEX.set(b.id, b);
  return BIN_INDEX.get(id);
}

function adjacency(site: SiteStorage): Map<string, { to: string; m: number }[]> {
  const adj = new Map<string, { to: string; m: number }[]>();
  for (const e of site.edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push({ to: e.to, m: e.metres });
    adj.get(e.to)!.push({ to: e.from, m: e.metres });
  }
  return adj;
}

/** Dijkstra from one or more start nodes over the aisle network (edges are two-way). */
export function distancesFrom(site: SiteStorage, starts: string[]): Map<string, number> {
  const adj = adjacency(site);
  const dist = new Map<string, number>();
  const done = new Set<string>();
  for (const s of starts) dist.set(s, 0);
  for (;;) {
    let u: string | null = null;
    let best = Infinity;
    for (const [k, d] of dist) if (!done.has(k) && d < best) { best = d; u = k; }
    if (u === null) break;
    done.add(u);
    for (const { to, m } of adj.get(u) ?? []) {
      const nd = best + m;
      if (nd < (dist.get(to) ?? Infinity)) dist.set(to, nd);
    }
  }
  return dist;
}

/** Shortest route between two nodes: the node ids along it and its length in metres. */
export function shortestPath(site: SiteStorage, from: string, to: string): { nodes: string[]; metres: number } {
  const adj = adjacency(site);
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  for (;;) {
    let u: string | null = null;
    let best = Infinity;
    for (const [k, d] of dist) if (!done.has(k) && d < best) { best = d; u = k; }
    if (u === null || u === to) break;
    done.add(u);
    for (const { to: v, m } of adj.get(u) ?? []) {
      const nd = best + m;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); }
    }
  }
  if (!dist.has(to)) return { nodes: [], metres: Infinity };
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0])!);
  return { nodes: path, metres: r2(dist.get(to)!) };
}

/**
 * Order in which to visit a list of nodes from a dock and back: nearest neighbour,
 * then 2-opt improvement (a classic travelling-salesman heuristic). Returns the stop order.
 */
export function pickSequence(site: SiteStorage, dock: string, stops: string[]): { order: string[]; metres: number; naiveMetres: number } {
  const uniq = [...new Set(stops)];
  const pts = [dock, ...uniq];
  const D = new Map<string, Map<string, number>>();
  for (const p of pts) D.set(p, distancesFrom(site, [p]));
  const d = (a: string, b: string) => D.get(a)?.get(b) ?? 1e6;
  const tour = (seq: string[]) => { let m = 0; let at = dock; for (const s of seq) { m += d(at, s); at = s; } return m + d(at, dock); };
  const naive = tour(uniq);
  const left = new Set(uniq);
  const seq: string[] = [];
  let at = dock;
  while (left.size) {
    let best = ''; let bm = Infinity;
    for (const s of left) if (d(at, s) < bm) { bm = d(at, s); best = s; }
    seq.push(best); left.delete(best); at = best;
  }
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < seq.length - 1; i++) {
      for (let k = i + 1; k < seq.length; k++) {
        const cand = [...seq.slice(0, i), ...seq.slice(i, k + 1).reverse(), ...seq.slice(k + 1)];
        if (tour(cand) + 1e-6 < tour(seq)) { seq.splice(0, seq.length, ...cand); improved = true; }
      }
    }
  }
  return { order: seq, metres: r2(tour(seq)), naiveMetres: r2(naive) };
}

export function nodeById(fac: FacilityId, id: string): WhNode | undefined { return siteStorage(fac).nodes.find((n) => n.id === id); }
export function nodePos(fac: FacilityId, id: string): Vec2 | null { const n = nodeById(fac, id); return n ? { x: n.x, z: n.z } : null; }

// ---------------------------------------------------------------- temperature sensors
export interface SensorDef { id: string; facilityId: FacilityId; zone: TempZone; label: string; minC: number; maxC: number; setpoint: number; x: number; z: number }
export function sensorDefs(): SensorDef[] {
  const out: SensorDef[] = [];
  for (const fac of WMS_FACILITIES) {
    const s = siteStorage(fac);
    const mid = s.bays[Math.floor(s.bays.length / 2)];
    if (s.coldX0 !== null) {
      const cold = s.aisles.filter((a) => a.zone === 'COLD');
      out.push({ id: `TS-${fac.slice(3)}-C1`, facilityId: fac, zone: 'COLD', label: 'Cold room · door side', minC: 2, maxC: 8, setpoint: 4.5, x: cold[0].x, z: s.bays[1] });
      out.push({ id: `TS-${fac.slice(3)}-C2`, facilityId: fac, zone: 'COLD', label: 'Cold room · back wall', minC: 2, maxC: 8, setpoint: 4.2, x: cold[cold.length - 1].x, z: s.bays[s.bays.length - 2] });
    }
    out.push({ id: `TS-${fac.slice(3)}-A1`, facilityId: fac, zone: 'AMBIENT', label: 'Ambient store', minC: 5, maxC: 30, setpoint: 19, x: s.aisles[Math.floor(s.aisles.length / 3)].x, z: mid });
  }
  return out;
}

// ---------------------------------------------------------------- GS1 serial shipping container codes
export const GS1_PREFIX = '0614141'; // GS1's published example company prefix (not a real company)
export function gs1CheckDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = Number(digits[digits.length - 1 - i]);
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}
/** SSCC-18: extension digit + company prefix + serial, then the check digit. */
export function sscc(serial: number, extension = 3): string {
  const body = `${extension}${GS1_PREFIX}${String(serial).padStart(16 - GS1_PREFIX.length, '0')}`;
  return `${body}${gs1CheckDigit(body)}`;
}
export function validSscc(code: string): boolean {
  return /^\d{18}$/.test(code) && gs1CheckDigit(code.slice(0, 17)) === Number(code[17]);
}
/** Accepts a bare SSCC or GS1-128 / scanner text with application identifier (00). */
export function parseScan(text: string): string {
  const t = text.replace(/[\s\u001d()]/g, '');
  const m = t.match(/^(?:\]C1)?(?:00)?(\d{18})$/);
  return m ? m[1] : t;
}

// ---------------------------------------------------------------- deterministic seed data
/** Small deterministic hash → [0, 1). */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const WEEKDAY = [0.55, 1.12, 1.08, 1.0, 1.05, 1.22, 0.72]; // Sun..Sat
/**
 * Daily demand (units picked) per site and product for the last `days` days, oldest first.
 * `stock` (the site's opening stock of the product) scales it to a realistic 4–35 days of cover.
 */
export function demandHistory(fac: FacilityId, skuId: string, days = 90, stock: number | null = null, today = new Date()): { daysAgo: number; date: string; units: number; picks: number; weekday: number }[] {
  const h = hash01(`${fac}:${skuId}:base`);
  const base = stock ? stock / (4 + 31 * h * h) : 30 + 380 * h * h;
  const trend = (hash01(`${fac}:${skuId}:trend`) - 0.4) * 0.012; // per day, relative
  const out = [];
  for (let k = days; k >= 1; k--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - k));
    const wd = d.getUTCDay();
    const noise = 0.82 + hash01(`${fac}:${skuId}:${k}`) * 0.36;
    const units = Math.max(0, Math.round(base * (1 + trend * (days - k)) * WEEKDAY[wd] * noise));
    out.push({ daysAgo: k, date: d.toISOString().slice(0, 10), units, picks: Math.max(1, Math.round(units / (8 + hash01(skuId) * 20))), weekday: wd });
  }
  return out;
}

export interface DamageSeed { facilityId: FacilityId; skuId: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'; daysAgo: number; text: string; reporter: string }
export const DAMAGE_SEEDS: DamageSeed[] = [
  { facilityId: 'WH-04', skuId: 'LED-6060', severity: 'HIGH', daysAgo: 1, reporter: 'zoe.reyes', text: 'Three LED panels with cracked diffusers after the pallet tipped over on the ramp at In 2' },
  { facilityId: 'WH-02', skuId: 'LED-6060', severity: 'MEDIUM', daysAgo: 3, reporter: 'dana.brooks', text: 'Corner of the carton crushed by a forklift tine, one light panel shattered glass inside' },
  { facilityId: 'WH-01', skuId: 'BOX-M', severity: 'LOW', daysAgo: 2, reporter: 'sam.patel', text: 'Bundle of flat boxes soaked by rain at the yard slot, bottom layer soft and unusable' },
  { facilityId: 'WH-01', skuId: 'BOX-M', severity: 'LOW', daysAgo: 9, reporter: 'sam.patel', text: 'Water damage from roof leak above aisle B, cardboard warped and mouldy' },
  { facilityId: 'WH-04', skuId: 'GLV-NIT', severity: 'MEDIUM', daysAgo: 4, reporter: 'carla.mendes', text: 'Glove boxes punctured by a nail on a broken pallet board, gloves exposed and contaminated' },
  { facilityId: 'WH-02', skuId: 'GLV-NIT', severity: 'LOW', daysAgo: 12, reporter: 'dana.brooks', text: 'Shrink wrap torn, two cases of gloves fell off during put-away, boxes dented but sealed' },
  { facilityId: 'WH-04', skuId: 'MED-INS', severity: 'HIGH', daysAgo: 2, reporter: 'zoe.reyes', text: 'Reefer container arrived at 11 degrees, insulin pens warm, quarantined pending quality check' },
  { facilityId: 'WH-04', skuId: 'MED-INS', severity: 'HIGH', daysAgo: 15, reporter: 'carla.mendes', text: 'Cold room door left open overnight, temperature excursion above 8 °C on the data logger' },
  { facilityId: 'WH-04', skuId: 'MED-INS', severity: 'MEDIUM', daysAgo: 21, reporter: 'zoe.reyes', text: 'Insulated shipper missing ice packs, product label says keep refrigerated' },
  { facilityId: 'WH-02', skuId: 'CHR-OFC', severity: 'MEDIUM', daysAgo: 5, reporter: 'dana.brooks', text: 'Office chair box ripped open, armrest snapped and wheels missing from the kit' },
  { facilityId: 'WH-02', skuId: 'CHR-OFC', severity: 'LOW', daysAgo: 17, reporter: 'dana.brooks', text: 'Furniture carton scuffed and dirty from dragging on the floor, contents fine' },
  { facilityId: 'WH-01', skuId: 'CNT-P', severity: 'LOW', daysAgo: 6, reporter: 'sam.patel', text: 'Plastic tote lids cracked from cold, a few containers split when stacked too high' },
  { facilityId: 'WH-04', skuId: 'CNT-P', severity: 'MEDIUM', daysAgo: 8, reporter: 'carla.mendes', text: 'Stack of storage containers collapsed, overloaded pallet exceeded its weight limit' },
  { facilityId: 'WH-01', skuId: 'PKG-TAPE', severity: 'LOW', daysAgo: 11, reporter: 'sam.patel', text: 'Tape rolls stuck together and lost adhesion after sitting in a hot trailer' },
  { facilityId: 'WH-01', skuId: 'PPE-HLM-Y', severity: 'MEDIUM', daysAgo: 13, reporter: 'sam.patel', text: 'Safety helmets with expired manufacture date found mixed into a new lot, wrong stock rotation' },
  { facilityId: 'WH-01', skuId: 'PPE-HLM-Y', severity: 'LOW', daysAgo: 25, reporter: 'sam.patel', text: 'Short shipment: supplier delivered 74 hard hats instead of 82, count discrepancy on receipt' },
  { facilityId: 'WH-02', skuId: 'LED-6060', severity: 'LOW', daysAgo: 19, reporter: 'dana.brooks', text: 'Wrong label on the pallet, SKU barcode does not match the packing list' },
  { facilityId: 'WH-04', skuId: 'BOX-M', severity: 'LOW', daysAgo: 7, reporter: 'zoe.reyes', text: 'Pallet wrapped loosely, cartons shifted in transit and spilled onto the dock floor' },
  { facilityId: 'WH-02', skuId: 'BOX-M', severity: 'MEDIUM', daysAgo: 14, reporter: 'dana.brooks', text: 'Broken pallet base, forks went through the deck board while lifting' },
  { facilityId: 'WH-04', skuId: 'GLV-NIT', severity: 'LOW', daysAgo: 23, reporter: 'carla.mendes', text: 'Gloves stored next to the dock heater, boxes discoloured from heat' },
];
