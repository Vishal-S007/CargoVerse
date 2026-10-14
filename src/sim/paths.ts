// Route geometry for trucks and forklifts. Pure functions over layout data.
import type { Leg, Vec2, Spot, FacilityId, TradeLane } from '../data/types';
import {
  LAYOUTS, LANE_Z, FENCE_Z, ROAD_LANE_Z, TRUCK_STOP_Z, CORRIDOR_Z,
} from '../data/layouts';
import { parkRouteIn, parkRouteOut, toLocal, distanceAlong, PARK_GATES } from '../data/park';

export const ROAD_SPEED = 13; // public roads (highway, avenues, streets)
export const YARD_SPEED = 4;
export const REVERSE_SPEED = 3.0;
export const FORK_SPEED = 3.2;
export const FORK_REACH = 2.55; // distance from forklift centre to the pallet on its forks

export { roundCorners, pathLength, sampleAt, remainingPts, type Sample } from './geometry';
import { roundCorners } from './geometry';

const doorX = (fac: FacilityId, dockId: string) => LAYOUTS[fac].doors[dockId] ?? 0;

/** Highway → West Gate → street → site gate. Points are in the site's local coordinates. */
export function legRoadIn(fac: FacilityId, lane: TradeLane = 'ROAD'): Leg {
  const L = LAYOUTS[fac];
  const park = parkRouteIn(fac, L.gateX, ROAD_LANE_Z, FENCE_Z - 3, lane);
  return { pts: roundCorners(park.map((p) => toLocal(fac, p)), 8), reverse: false, speed: ROAD_SPEED };
}

/** Site exit → street → East Gate → highway (local coordinates). */
export function legRoadOutPts(fac: FacilityId, lane: TradeLane = 'ROAD'): Vec2[] {
  const L = LAYOUTS[fac];
  const park = parkRouteOut(fac, L.exitX, ROAD_LANE_Z, FENCE_Z - 3, lane);
  return roundCorners(park.map((p) => toLocal(fac, p)), 8);
}

const gateCache = new Map<string, number>();
/** Distance along the inbound road leg at which a truck passes the West Gate (imports in). */
export function gateInDistance(fac: FacilityId, lane: TradeLane = 'ROAD'): number {
  const k = `in:${fac}:${lane}`;
  let d = gateCache.get(k);
  if (d === undefined) { d = distanceAlong(legRoadIn(fac, lane).pts, toLocal(fac, PARK_GATES.WEST.lane)); gateCache.set(k, d); }
  return d;
}
/** Distance along the outbound road leg at which a truck passes the East Gate (exports out). */
export function gateOutDistance(fac: FacilityId): number {
  const k = `out:${fac}`;
  let d = gateCache.get(k);
  if (d === undefined) { d = distanceAlong(legRoadOutPts(fac), toLocal(fac, PARK_GATES.EAST.lane)); gateCache.set(k, d); }
  return d;
}

export function legYardIn(fac: FacilityId, dockId: string): Leg {
  const L = LAYOUTS[fac];
  const dx = doorX(fac, dockId);
  return {
    pts: roundCorners([{ x: L.gateX, z: FENCE_Z - 3 }, { x: L.gateX, z: LANE_Z }, { x: dx + 18, z: LANE_Z }], 7),
    reverse: false,
    speed: YARD_SPEED,
  };
}

export function legReverseIn(fac: FacilityId, dockId: string): Leg {
  const dx = doorX(fac, dockId);
  return {
    pts: roundCorners([{ x: dx + 18, z: LANE_Z }, { x: dx, z: LANE_Z }, { x: dx, z: TRUCK_STOP_Z }], 8, 10),
    reverse: true,
    speed: REVERSE_SPEED,
  };
}

export function legYardOut(fac: FacilityId, dockId: string): Leg {
  const L = LAYOUTS[fac];
  const dx = doorX(fac, dockId);
  return {
    pts: roundCorners(
      [{ x: dx, z: TRUCK_STOP_Z }, { x: dx, z: LANE_Z }, { x: L.exitX, z: LANE_Z }, { x: L.exitX, z: FENCE_Z - 3 }],
      7,
    ),
    reverse: false,
    speed: YARD_SPEED,
  };
}

const outCache = new Map<string, Vec2[]>();
export function legRoadOut(fac: FacilityId, lane: TradeLane = 'ROAD'): Leg {
  const k = `${fac}:${lane}`;
  let pts = outCache.get(k);
  if (!pts) { pts = legRoadOutPts(fac, lane); outCache.set(k, pts); }
  return { pts, reverse: false, speed: ROAD_SPEED };
}

export function dockedPose(fac: FacilityId, dockId: string): { pos: Vec2; heading: number } {
  return { pos: { x: doorX(fac, dockId), z: TRUCK_STOP_Z }, heading: Math.PI / 2 };
}

/** Target point (where the pallet sits) and approach point for a forklift spot. */
export function spotGeometry(fac: FacilityId, spot: Spot, trucks: Record<string, { dockId: string | null }>): {
  target: Vec2;
  approach: Vec2;
} {
  const L = LAYOUTS[fac];
  if (spot.type === 'slot') {
    const s = L.slots[spot.slot];
    return { target: s, approach: { x: s.x, z: s.z - 6 } };
  }
  if (spot.type === 'store') {
    const x = doorX(fac, spot.dockId) + L.storeOffset;
    return { target: { x, z: 0.2 }, approach: { x, z: 6.5 } };
  }
  const dockId = trucks[spot.truckId]?.dockId ?? Object.keys(L.doors)[0];
  const x = doorX(fac, dockId);
  return { target: { x: x + 1.5, z: 4.6 }, approach: { x: x + 7.5, z: 4.6 } };
}

export function forkliftRoute(from: Vec2, approach: Vec2, target: Vec2): Vec2[] {
  const dirx = target.x - approach.x, dirz = target.z - approach.z;
  const len = Math.hypot(dirx, dirz) || 1;
  const stop = { x: target.x - (dirx / len) * FORK_REACH, z: target.z - (dirz / len) * FORK_REACH };
  const pts: Vec2[] = [from];
  if (Math.abs(from.z - CORRIDOR_Z) > 0.5) pts.push({ x: from.x, z: CORRIDOR_Z });
  if (Math.abs(approach.x - from.x) > 0.5) pts.push({ x: approach.x, z: CORRIDOR_Z });
  pts.push(approach, stop);
  const clean = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) > 0.05);
  return roundCorners(clean, 2.2, 5);
}

export function homeRoute(from: Vec2, pad: Vec2): Vec2[] {
  const approach = { x: pad.x + 5, z: pad.z };
  const pts: Vec2[] = [from, { x: from.x, z: CORRIDOR_Z }, { x: approach.x, z: CORRIDOR_Z }, approach, pad];
  const clean = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) > 0.05);
  return roundCorners(clean, 2.2, 5);
}
