// Floating 2D tags attached to 3D positions. The scene projects anchors each
// frame; the DOM overlay reads the projected positions.
import type { WorldState, EntityRef, FacilityId, Truck } from '../data/types';
import { LAYOUTS } from '../data/layouts';
import { SKUS } from '../data/seed';
import { toPark, PARK_GATES, type GateCode } from '../data/park';
import { getPark, findBuilding, findVehicle, findCompany } from '../data/parkClient';
import { entityWorldPos, truckBadge, forkliftActivity, dockStatus, chargerView, findAsset, vesselActivity, vanActivity } from '../ui/derive';
import { storeByBuilding, storeBuilding } from '../data/city';

export interface LabelSpec {
  key: string;
  text: string;
  chip: string;
  tone: 'blue' | 'plain' | 'park' | 'import' | 'export' | 'unladen' | 'ship' | 'retail';
  world: { x: number; y: number; z: number } | null;
  /** far = only when zoomed out (park overview), near = only when zoomed in */
  range?: 'far' | 'near';
}

export const anchors = new Map<string, { x: number; y: number; on: boolean }>();

const HEIGHT: Record<EntityRef['kind'], number> = {
  truck: 5.6, forklift: 4.6, pallet: 3.0, dock: 5.4, charger: 2.4, facility: 0, asset: 5, building: 10, vehicle: 3.2, gate: 6,
  vessel: 18, crane: 32, berth: 4, store: 12, van: 4.4,
};
const VEH_LABEL: Record<string, string> = { CAR: 'Car', VAN: 'Van', BUS: 'Bus', TRUCK: 'Truck', TANKER: 'Tanker', TAXI: 'Taxi', TRACTOR: 'Terminal tractor' };

function entityTag(w: WorldState, ref: EntityRef, key: string, tone: LabelSpec['tone']): LabelSpec {
  const p = entityWorldPos(w, ref);
  let chip = '';
  let text = ref.id;
  let h = HEIGHT[ref.kind];
  switch (ref.kind) {
    case 'truck': { const t = w.trucks[ref.id]; if (t) chip = truckBadge(t).label; break; }
    case 'forklift': { const fl = w.forklifts[ref.id]; if (fl) chip = forkliftActivity(w, fl).badge.label; break; }
    case 'pallet': { const pl = w.pallets[ref.id]; if (pl) chip = SKUS[pl.skuId].name; if (pl?.featured) text = pl.id; break; }
    case 'dock': { const d = w.docks[ref.id]; if (d) { text = d.name; chip = dockStatus(w, d).badge.label; } break; }
    case 'asset': { const a = findAsset(ref.id); if (a) { text = a.name; chip = a.facilityId; } break; }
    case 'charger': { if (w.chargers[ref.id]) { const v = chargerView(w, ref.id); text = v.title; chip = v.badge.label; } break; }
    case 'building': {
      const b = findBuilding(ref.id);
      if (b) { text = b.name; chip = findCompany(b.companyId)?.name ?? ''; h = Math.max(6, b.h + (b.kind === 'PLANT' ? 6 : 3)); if (chip === text) chip = b.kind.toLowerCase().replace('_', ' '); }
      break;
    }
    case 'vehicle': {
      const v = findVehicle(ref.id);
      if (v) { text = v.plate; chip = `${VEH_LABEL[v.kind]} · ${findCompany(v.companyId)?.name ?? 'public traffic'}`; h = v.kind === 'CAR' ? 3 : 5; }
      break;
    }
    case 'gate': { const g = PARK_GATES[ref.id as GateCode]; if (g) { text = g.name; chip = 'Park gate'; } break; }
    case 'vessel': { const v = w.port?.vessels[ref.id]; if (v) { text = v.name; chip = vesselActivity(w, v).badge.label; } break; }
    case 'crane': { const c = w.port?.cranes[ref.id]; if (c) { text = `Quay crane ${c.id}`; chip = c.phase === 'idle' ? 'Idle' : c.phase === 'discharge' ? 'Discharging' : 'Loading'; } break; }
    case 'berth': { const b = w.port?.berths[ref.id]; if (b) { text = b.name; chip = b.open ? (b.vesselId ? w.port.vessels[b.vesselId]?.name ?? 'Occupied' : 'Free') : 'Closed'; } break; }
    case 'store': { const st = w.retail?.stores[ref.id]; const b = storeBuilding(ref.id); if (st) { text = st.name; chip = st.kind.toLowerCase(); h = (b?.h ?? 8) + 4; } break; }
    case 'van': { const v = w.retail?.vans[ref.id]; if (v) { text = v.id; chip = vanActivity(w, v).badge.label; } break; }
    case 'facility': break;
  }
  const pallet = ref.kind === 'pallet' ? w.pallets[ref.id] : null;
  const extra = pallet?.featured && pallet.slot !== null ? 4.2 : 0;
  const asset = ref.kind === 'asset' ? findAsset(ref.id) : null;
  if (asset) h = asset.size[1] + 1.2;
  let z = p?.z ?? 0;
  if (ref.kind === 'dock') { const d = w.docks[ref.id]; if (d) z = toPark(d.facilityId, { x: 0, z: 7 }).z; }
  return { key, text, chip, tone, world: p ? { x: p.x, y: h + extra, z } : null };
}

/** Trucks on the public roads carry a tag saying what they bring in or take out. */
function flowTag(t: Truck): LabelSpec | null {
  const onRoad = (t.phase === 'en_route' && t.legDist > 0) || (t.phase === 'leaving');
  if (!onRoad) return null;
  const p = toPark(t.facilityId, t.pos);
  const inbound = t.phase === 'en_route';
  const loaded = t.cargo > 0;
  const tone: LabelSpec['tone'] = !loaded ? 'unladen' : inbound ? 'import' : 'export';
  const sea = t.lane === 'SEA' && loaded;
  const what = sea ? `${inbound ? 'Import container · from the port' : 'Export container · to the port'}`
    : loaded ? `${inbound ? 'Import' : 'Export'} · ${t.cargo} pal ${SKUS[t.skuId]?.name ?? ''}`.trim() : inbound ? 'Empty · to load' : 'Empty · returning';
  return { key: `flow-${t.id}`, text: t.id, chip: `${what} · ${t.facilityId}`, tone, world: { x: p.x, y: 5.8, z: p.z } };
}

export function labelSpecs(w: WorldState, facilityId: FacilityId, selection: EntityRef | null, hovered: EntityRef | null = null): LabelSpec[] {
  const out: LabelSpec[] = [];
  for (const fac of Object.keys(LAYOUTS) as FacilityId[]) {
    const L = LAYOUTS[fac];
    const f = w.facilities[fac];
    const c = toPark(fac, { x: (L.building.x0 + L.building.x1) / 2, z: -L.building.depth / 2 });
    out.push({
      key: fac === facilityId ? 'building' : `building-${fac}`,
      text: fac,
      chip: f?.name ?? findBuilding(`PB-${fac.replace('-', '')}`)?.name ?? '',
      tone: 'plain',
      world: { x: c.x, y: L.building.height + 6.5, z: c.z },
    });
  }
  // neighbours and gates are named when looking at the whole park
  for (const b of getPark().buildings) {
    if (b.facilityId || b.kind === 'GATEHOUSE' || b.kind === 'PARKING' || b.kind === 'RESIDENTIAL') continue;
    const co = findCompany(b.companyId);
    const store = storeByBuilding(b.id);
    // in town, keep the overview readable: vendor stores, public services and landmarks only
    if (b.z > 250 && b.x > -600 && !store && b.kind !== 'SERVICES' && b.kind !== 'TERMINAL' && b.h < 40) continue;
    const chip = store ? (store.kind === 'SUPERMARKET' ? 'Supermarket' : `${store.kind.charAt(0)}${store.kind.slice(1).toLowerCase()} store`)
      : b.kind === 'PLANT' ? 'Plant' : b.kind === 'TERMINAL' ? 'Ships · containers' : b.kind.toLowerCase().replace('_', ' ');
    const shared = getPark().buildings.filter((x) => x.companyId === b.companyId).length > 1;
    const text = store ? store.name : shared || !co ? b.name : co.name;
    out.push({ key: `park-${b.id}`, text, chip, tone: store ? 'retail' : 'park', world: { x: b.x, y: Math.max(4, b.h) + 4, z: b.z }, range: 'far' });
  }
  // ships in the bay and alongside
  for (const v of Object.values(w.port?.vessels ?? {})) {
    if (v.status === 'AT_SEA' || (selection?.kind === 'vessel' && selection.id === v.id)) continue;
    out.push({ key: `ship-${v.id}`, text: v.name, chip: vesselActivity(w, v).badge.label, tone: 'ship', world: { x: v.pos.x, y: 18, z: v.pos.z } });
  }
  // delivery vans on their way to and from the stores
  for (const v of Object.values(w.retail?.vans ?? {})) {
    if (v.status === 'IDLE' || v.status === 'LOADING' || (selection?.kind === 'van' && selection.id === v.id)) continue;
    const st = v.storeId ? w.retail.stores[v.storeId] : undefined;
    const chip = v.status === 'RETURNING' ? `Returning to ${v.facilityId}` : v.status === 'UNLOADING' ? `Unloading · ${st?.name ?? ''}` : `Delivery → ${st?.name ?? ''}`;
    out.push({ key: `van-${v.id}`, text: v.id, chip, tone: 'retail', world: { x: v.pos.x, y: 4.6, z: v.pos.z } });
  }
  for (const g of Object.values(PARK_GATES)) {
    out.push({ key: `gate-${g.code}`, text: g.name, chip: g.code === 'WEST' ? 'goods in' : 'goods out', tone: g.code === 'WEST' ? 'import' : 'export', world: { x: g.pos.x, y: 6, z: g.pos.z }, range: 'far' });
  }
  for (const t of Object.values(w.trucks)) {
    if (selection?.kind === 'truck' && selection.id === t.id) continue;
    const tag = flowTag(t);
    if (tag) out.push(tag);
  }
  if (selection && selection.kind !== 'facility') out.push(entityTag(w, selection, 'selection', 'blue'));
  const same = hovered && selection && hovered.kind === selection.kind && hovered.id === selection.id;
  if (hovered && hovered.kind !== 'facility' && !same) out.push(entityTag(w, hovered, 'hover', 'plain'));
  return out;
}
