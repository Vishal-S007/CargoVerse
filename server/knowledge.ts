// What the assistant knows beyond the operations tools:
//  · any object in the 3D city (trucks, forklifts, pallets, docks, ships, cranes, berths, stores, delivery vans,
//    park buildings, gates and the public traffic — buses, cars, taxis, tankers…): find it, describe it, and say
//    where it is in words ("on Harbor Avenue, next to FreshCart Supermarket");
//  · how the project works: a search over README.md, docs/DATABASE.md and docs/DEMO.md.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorldState, EntityRef, FacilityId, EntityKind } from '../src/data/types';
import { SKUS, carrierName } from '../src/data/seed';
import { PARK_BUILDINGS, PARK_VEHICLES, PARK_COMPANIES, PARK_ROUTES, PARK_GATES, vehiclePose, type ParkVehicle } from '../src/data/park';
import { storeBuilding } from '../src/data/city';
import {
  search, entityWorldPos, truckView, forkliftView, palletView, dockView, chargerView, siteView, vesselActivity, vanActivity, truckBadge,
} from '../src/ui/derive';

// ---------------------------------------------------------------- where things are, in words

const LANDMARKS = () => PARK_BUILDINGS.map((b) => ({ name: b.name, street: b.street, x: b.x, z: b.z, r: Math.max(b.w, b.d) / 2 }));

/** "on Harbor Avenue, next to FreshCart Supermarket" for a point in park coordinates. */
export function placeName(x: number, z: number): { text: string; near: string | null; street: string | null; metres: number | null } {
  let best: ReturnType<typeof LANDMARKS>[number] | null = null;
  let bd = Infinity;
  for (const l of LANDMARKS()) {
    const d = Math.max(0, Math.hypot(l.x - x, l.z - z) - l.r);
    if (d < bd) { bd = d; best = l; }
  }
  for (const g of Object.values(PARK_GATES)) {
    const d = Math.hypot(g.pos.x - x, g.pos.z - z);
    if (d < bd && d < 30) { bd = d; best = { name: g.name, street: 'the park entrance', x: g.pos.x, z: g.pos.z, r: 0 }; }
  }
  if (!best) return { text: 'somewhere in the park', near: null, street: null, metres: null };
  const m = Math.round(bd);
  const rel = m < 8 ? 'at' : m < 45 ? 'next to' : m < 140 ? 'near' : 'some way from';
  return { text: `${rel} ${best.name} (${best.street})${m >= 8 ? `, about ${m} m away` : ''}`, near: best.name, street: best.street, metres: m };
}

const findVehicle = (id: string): ParkVehicle | undefined => PARK_VEHICLES.find((v) => v.id === id || v.plate.toUpperCase() === id.toUpperCase());

/** Position of any object in park coordinates (public traffic follows the server's own clock). */
function positionOf(w: WorldState, ref: EntityRef): { x: number; z: number } | null {
  if (ref.kind === 'vehicle') {
    const v = findVehicle(ref.id);
    return v ? vehiclePose(v, w.realTime) : null;
  }
  return entityWorldPos(w, ref);
}

// ---------------------------------------------------------------- describe any object

type Rows = { k: string; v: string }[];
const fromView = (v: { header?: string; title?: string; subtitle?: string; activity?: string; rows?: Rows; badge?: { label: string } } | null) =>
  v ? { what: v.header ?? null, name: v.title ?? null, id_and_type: v.subtitle ?? null, status: v.badge?.label ?? null, doing: v.activity ?? null, ...Object.fromEntries((v.rows ?? []).map((r) => [r.k.toLowerCase(), r.v])) } : null;

/** Everything the dashboard knows about one object, plus where it is. Facility-bound objects need site access. */
export function inspectEntity(w: WorldState, ref: EntityRef, sites: FacilityId[]): Record<string, unknown> | { error: string } {
  const id = ref.id;
  const denied = (fac: FacilityId) => !sites.includes(fac) ? { error: `${id} belongs to ${fac}, which you do not have access to` } : null;
  let info: Record<string, unknown> | null = null;
  switch (ref.kind) {
    case 'facility': { if (!w.facilities[id as FacilityId]) break; const d = denied(id as FacilityId); if (d) return d; info = { kind: 'site', ...fromView(siteView(w, id as FacilityId) as never) }; break; }
    case 'truck': { const t = w.trucks[id]; if (!t) break; const d = denied(t.facilityId); if (d) return d; info = { kind: 'truck', carrier: carrierName(t.carrier), driver: t.driver, plate: t.plate, site: t.facilityId, ...fromView({ ...truckView(w, t), badge: truckBadge(t) } as never), away: t.phase === 'away' }; break; }
    case 'forklift': { const f = w.forklifts[id]; if (!f) break; const d = denied(f.facilityId); if (d) return d; info = { kind: 'forklift', operator: f.operator, battery_pct: Math.round(f.battery), site: f.facilityId, ...fromView(forkliftView(w, f) as never) }; break; }
    case 'pallet': { const p = w.pallets[id]; if (!p) break; const d = denied(p.facilityId); if (d) return d; info = { kind: 'pallet', product: SKUS[p.skuId]?.name, site: p.facilityId, ...fromView(palletView(w, id) as never) }; break; }
    case 'dock': { const k = w.docks[id]; if (!k) break; const d = denied(k.facilityId); if (d) return d; info = { kind: 'dock', site: k.facilityId, ...fromView(dockView(w, k) as never) }; break; }
    case 'charger': { const c = w.chargers[id]; if (!c) break; const d = denied(c.facilityId); if (d) return d; info = { kind: 'charger', site: c.facilityId, ...fromView(chargerView(w, id) as never) }; break; }
    case 'vessel': {
      const v = w.port?.vessels[id]; if (!v) break;
      const a = vesselActivity(w, v);
      info = { kind: 'ship', name: v.name, line: v.line, flag: v.flag, imo: v.imo, voyage: v.voyage, status: a.badge.label, doing: a.text, berth: v.berthId, on_hold: v.hold, from: v.origin, next_port: v.nextPort, boxes_to_discharge: v.importBoxes, discharged: v.discharged, loaded: v.loaded, at_sea: v.status === 'AT_SEA' };
      break;
    }
    case 'crane': { const c = w.port?.cranes[id]; if (!c) break; info = { kind: 'quay crane', id: c.id, berth: w.port.berths[c.berthId]?.name, working: c.phase, moves_today: c.movesToday }; break; }
    case 'berth': { const b = w.port?.berths[id]; if (!b) break; info = { kind: 'berth', name: b.name, open: b.open, ship: b.vesselId ? w.port.vessels[b.vesselId]?.name : null }; break; }
    case 'store': {
      const s = w.retail?.stores[id]; if (!s) break;
      const low = s.lines.filter((l) => l.units <= l.reorderAt);
      info = { kind: 'store', name: s.name, chain: s.chain, type: s.kind.toLowerCase(), supplied_by: s.facilityId, deliveries_today: s.deliveriesToday,
        shelves: s.lines.map((l) => `${SKUS[l.skuId]?.name} ${l.units}/${l.maxUnits}`).join(', '),
        low_on_shelf: low.length ? low.map((l) => `${SKUS[l.skuId]?.name} (${l.units}, reorder at ${l.reorderAt})`).join(', ') : 'nothing — every shelf is above its reorder point',
        open_orders: Object.values(w.retail.orders).filter((o) => o.storeId === id && o.status !== 'DELIVERED' && o.status !== 'CANCELLED').length, street: storeBuilding(id)?.street };
      break;
    }
    case 'van': {
      const v = w.retail?.vans[id]; if (!v) break;
      const a = vanActivity(w, v);
      info = { kind: 'delivery van', plate: v.plate, driver: v.driver, depot: v.facilityId, status: a.badge.label, doing: a.text, order: v.orderId, store: v.storeId ? w.retail.stores[v.storeId]?.name : null, parked_at_depot: v.status === 'IDLE' };
      break;
    }
    case 'vehicle': {
      const v = findVehicle(id); if (!v) break;
      const co = PARK_COMPANIES.find((c) => c.id === v.companyId);
      info = { kind: v.kind.toLowerCase(), plate: v.plate, id: v.id, owner: co?.name ?? 'public traffic', route: PARK_ROUTES[v.route]?.name ?? v.route, speed_kmh: v.speedKmh, colour: colourName(v.color) };
      ref = { kind: 'vehicle', id: v.id };
      break;
    }
    case 'building': {
      const b = PARK_BUILDINGS.find((x) => x.id === id); if (!b) break;
      const co = PARK_COMPANIES.find((c) => c.id === b.companyId);
      info = { kind: `building (${b.kind.toLowerCase()})`, name: b.name, company: co?.name, industry: co?.industry, street: b.street, floors: b.floors, staff: b.staff, status: b.status, lease_end: b.leaseEnd, description: b.description, cargoverse_site: b.facilityId };
      break;
    }
    case 'gate': { const g = PARK_GATES[id as keyof typeof PARK_GATES]; if (!g) break; info = { kind: 'park gate', name: g.name, code: g.code, role: g.code === 'WEST' ? 'imports come in here' : 'exports leave here' }; break; }
    default: break;
  }
  if (!info) return { error: `Nothing called ${ref.kind} ${id} in the city` };
  const pos = positionOf(w, ref);
  return { ...info, where: pos ? placeName(pos.x, pos.z).text : (info.at_sea ? 'at sea, out of sight' : info.parked_at_depot ? 'parked at its depot' : info.away ? 'on the road outside the park' : 'not on the map right now') };
}

/** Plain colour name of a hex colour (for "the red bus"). */
export function colourName(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 'unknown';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d < 0.12) return l > 0.85 ? 'white' : l < 0.2 ? 'black' : 'grey';
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 340) return 'red';
  if (h < 40) return 'orange';
  if (h < 68) return 'yellow';
  if (h < 165) return 'green';
  if (h < 255) return 'blue';
  if (h < 300) return 'purple';
  return 'pink';
}

// ---------------------------------------------------------------- find objects by name, id, plate or kind word

const KIND_WORDS: { re: RegExp; kind: EntityKind; vehicle?: ParkVehicle['kind'] }[] = [
  { re: /\bbus(es)?\b/, kind: 'vehicle', vehicle: 'BUS' }, { re: /\btaxis?\b|\bcabs?\b/, kind: 'vehicle', vehicle: 'TAXI' },
  { re: /\btankers?\b/, kind: 'vehicle', vehicle: 'TANKER' }, { re: /\btractors?\b/, kind: 'vehicle', vehicle: 'TRACTOR' },
  { re: /\bcars?\b/, kind: 'vehicle', vehicle: 'CAR' },
  { re: /\b(ships?|vessels?|boats?)\b/, kind: 'vessel' }, { re: /\bcranes?\b/, kind: 'crane' }, { re: /\bberths?\b/, kind: 'berth' },
  { re: /\b(delivery vans?|vans?)\b/, kind: 'van' }, { re: /\b(stores?|shops?|supermarkets?)\b/, kind: 'store' },
  { re: /\bforklifts?\b/, kind: 'forklift' }, { re: /\btrucks?\b|\blorr(y|ies)\b/, kind: 'truck' }, { re: /\bgates?\b/, kind: 'gate' },
  { re: /\bchargers?\b/, kind: 'charger' },
];

export interface Found { ref: EntityRef; title: string; detail: string; where: string }

export function findEntities(w: WorldState, text: string, sites: FacilityId[], limit = 12): Found[] {
  const q = text.trim();
  const out: Found[] = [];
  const seen = new Set<string>();
  const add = (ref: EntityRef, title: string, detail: string) => {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key) || out.length >= limit) return;
    const info = inspectEntity(w, ref, sites);
    if ('error' in info) return;
    seen.add(key);
    out.push({ ref, title, detail, where: String(info.where ?? '') });
  };
  // 1. ids and plates (TRK-2051, NJ-BUS-014, OSLU4123057): an exact hit is the answer
  const ids = q.match(/\b[A-Za-z]{2,5}-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b|\b[A-Z]{4}\d{7}\b/g) ?? [];
  for (const t of ids) {
    for (const v of PARK_VEHICLES) if (v.plate.toUpperCase() === t.toUpperCase() || v.id === t.toUpperCase()) add({ kind: 'vehicle', id: v.id }, `${v.kind.toLowerCase()} ${v.plate}`, PARK_ROUTES[v.route]?.name ?? '');
    for (const r of search(w, t)) if (r.title.toUpperCase().includes(t.toUpperCase()) || r.ref.id.toUpperCase() === t.toUpperCase()) add(r.ref, r.title, r.sub);
  }
  if (out.length) return out;
  // 2. kind words: "the bus", "ships", "delivery vans" — list every one of that kind
  const low = q.toLowerCase().replace(/\b[a-z]{2,5}-[a-z0-9-]+\b/g, ' ');
  const kinds = KIND_WORDS.filter((k) => k.re.test(low));
  // 3. names ("Ocean Star", "FreshCart") through the dashboard's search box — not when a kind word was used
  //    ("bus" must not match "Business Centre")
  if (!kinds.length) {
    const names = q.match(/\b[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*/g) ?? [];
    for (const t of [...names, q]) if (t.trim().length >= 3) for (const r of search(w, t)) add(r.ref, r.title, r.sub);
  }
  for (const k of kinds) {
    if (k.kind === 'vehicle') for (const v of PARK_VEHICLES.filter((x) => x.kind === k.vehicle)) add({ kind: 'vehicle', id: v.id }, `${colourName(v.color)} ${v.kind.toLowerCase()} ${v.plate}`, `${PARK_COMPANIES.find((c) => c.id === v.companyId)?.name ?? 'public traffic'} · ${PARK_ROUTES[v.route]?.name ?? ''}`);
    if (k.kind === 'vessel') for (const v of Object.values(w.port.vessels)) add({ kind: 'vessel', id: v.id }, v.name, `${v.line} · ${vesselActivity(w, v).badge.label}`);
    if (k.kind === 'crane') for (const c of Object.values(w.port.cranes)) add({ kind: 'crane', id: c.id }, `Quay crane ${c.id}`, c.phase);
    if (k.kind === 'berth') for (const b of Object.values(w.port.berths)) add({ kind: 'berth', id: b.id }, b.name, b.open ? 'open' : 'closed');
    if (k.kind === 'van') for (const v of Object.values(w.retail.vans)) add({ kind: 'van', id: v.id }, `${v.id} (${v.driver})`, vanActivity(w, v).badge.label);
    if (k.kind === 'store') for (const s of Object.values(w.retail.stores)) add({ kind: 'store', id: s.id }, s.name, s.kind.toLowerCase());
    if (k.kind === 'forklift') for (const f of Object.values(w.forklifts)) if (sites.includes(f.facilityId)) add({ kind: 'forklift', id: f.id }, `${f.id} (${f.operator})`, f.facilityId);
    if (k.kind === 'truck') for (const t of Object.values(w.trucks)) if (sites.includes(t.facilityId) && t.phase !== 'away') add({ kind: 'truck', id: t.id }, t.id, `${carrierName(t.carrier)} · ${truckBadge(t).label}`);
    if (k.kind === 'gate') for (const g of Object.values(PARK_GATES)) add({ kind: 'gate', id: g.code }, g.name, '');
    if (k.kind === 'charger') for (const c of Object.values(w.chargers)) if (sites.includes(c.facilityId)) add({ kind: 'charger', id: c.id }, c.id, c.facilityId);
  }
  // 4. colours for vehicles ("the red bus")
  const colour = /\b(red|blue|green|yellow|orange|white|black|grey|gray|purple|pink)\b/.exec(low)?.[1]?.replace('gray', 'grey');
  if (colour && out.some((f) => f.ref.kind === 'vehicle')) {
    const match = out.filter((f) => f.ref.kind !== 'vehicle' || colourName(findVehicle(f.ref.id)?.color ?? '') === colour);
    return match;
  }
  return out;
}

// ---------------------------------------------------------------- the project's own documentation

interface Section { file: string; title: string; text: string; tokens: string[] }
let SECTIONS: Section[] | null = null;
const STOP = new Set('the a an and or of to in on for is are be it this that with as by at from how what does do which when why where who can i we you my our your its into than then there their them they was were has have had will would should could'.split(' '));
const tok = (s: string) => s.toLowerCase().replace(/[`*_|>#()[\]]/g, ' ').split(/[^a-z0-9$+-]+/).filter((t) => t.length > 1 && !STOP.has(t)).map((t) => t.replace(/(ies)$/, 'y').replace(/([^s])s$/, '$1'));

function sections(): Section[] {
  if (SECTIONS) return SECTIONS;
  const out: Section[] = [];
  for (const file of ['README.md', 'docs/DATABASE.md', 'docs/DEMO.md']) {
    let text = '';
    try { text = readFileSync(resolve(process.cwd(), file), 'utf8'); } catch { continue; }
    let title = file;
    let buf: string[] = [];
    const flush = () => { const body = buf.join('\n').trim(); if (body.length > 40) out.push({ file, title, text: body, tokens: tok(`${title} ${title} ${body}`) }); buf = []; };
    for (const line of text.split(/\r?\n/)) {
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) { flush(); title = h[2].replace(/[`*]/g, ''); continue; }
      buf.push(line);
    }
    flush();
  }
  SECTIONS = out;
  return out;
}

/** BM25 search over the documentation sections. */
/** Words of a question as the index sees them (for picking matching table rows). */
export const questionTerms = (q: string): string[] => [...new Set(tok(q))];

export function searchDocs(question: string, k = 3): { file: string; section: string; text: string; score: number }[] {
  const docs = sections();
  if (!docs.length) return [];
  const q = [...new Set(tok(question))];
  const N = docs.length;
  const avg = docs.reduce((a, d) => a + d.tokens.length, 0) / N;
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.tokens.includes(t)).length]));
  return docs.map((d) => {
    let s = 0;
    for (const t of q) {
      const f = d.tokens.filter((x) => x === t).length;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.tokens.length / avg));
    }
    if (d.file === 'README.md') s *= 1.15; // the overview explains features; DEMO.md is a script
    return { file: d.file, section: d.title, text: d.text.length > 2200 ? `${d.text.slice(0, 2200)}…` : d.text, score: Math.round(s * 100) / 100 };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

/** A short overview the assistant always has, so it can answer "what is CargoVerse?" without a lookup. */
export const PROJECT_OVERVIEW = [
  'CargoVerse is a 3D logistics digital twin on Oracle Database: a logistics park with three CargoVerse warehouses (WH-01 Riverside Hub, WH-02 Northgate DC, WH-04 Southfield Cross-Dock),',
  'neighbouring companies, a container port (ships, berths, quay cranes, import/export stacks), a town with stores supplied by delivery vans, and public traffic (cars, buses, taxis, tankers).',
  'A Node.js server runs the simulation and writes every change to Oracle (64 tables, PL/SQL packages, triggers, views); the React + Three.js web app draws it live.',
  'Database Lab: control the city with SQL UPDATEs, Flashback time machine, row-level security (VPD), concurrency lab. Smart Warehouse: lots and rack bins, FEFO, ABC slotting,',
  'recall trace (recursive WITH), cold chain (MATCH_RECOGNIZE + scheduler job), blockchain ledger, forecasting (MODEL clause), GS1 labels, event queue, pick routes (Dijkstra, property graph), vector search.',
].join(' ');
