// Polyline helpers shared by the simulation, the park model and the scene.
import type { Vec2 } from '../data/types';

/** Replace interior corners with smooth quadratic arcs of radius r. */
export function roundCorners(pts: Vec2[], r: number, steps = 7): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const out: Vec2[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const l1 = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    const l2 = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    if (rr < 0.01) { out.push(p1); continue; }
    const a = { x: p1.x - ((p1.x - p0.x) / l1) * rr, z: p1.z - ((p1.z - p0.z) / l1) * rr };
    const b = { x: p1.x + ((p2.x - p1.x) / l2) * rr, z: p1.z + ((p2.z - p1.z) / l2) * rr };
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      out.push({
        x: u * u * a.x + 2 * u * t * p1.x + t * t * b.x,
        z: u * u * a.z + 2 * u * t * p1.z + t * t * b.z,
      });
    }
  }
  out.push(pts[pts.length - 1]);
  // drop duplicate consecutive points
  return out.filter((p, i) => i === 0 || Math.hypot(p.x - out[i - 1].x, p.z - out[i - 1].z) > 1e-4);
}

export function pathLength(pts: Vec2[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return L;
}

export interface Sample {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

export function sampleAt(pts: Vec2[], d: number): Sample {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (seg <= 0) continue;
    if (acc + seg >= d || i === pts.length - 1) {
      const t = Math.max(0, Math.min(1, (d - acc) / seg));
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: (b.x - a.x) / seg, dz: (b.z - a.z) / seg };
    }
    acc += seg;
  }
  const p = pts[pts.length - 1] ?? { x: 0, z: 0 };
  return { x: p.x, z: p.z, dx: 1, dz: 0 };
}

/** Remaining polyline from distance d to the end (for route ribbons). */
export function remainingPts(pts: Vec2[], d: number): Vec2[] {
  const out: Vec2[] = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (acc + seg > d) {
      if (out.length === 0) {
        const t = Math.max(0, (d - acc) / (seg || 1));
        out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      }
      out.push(b);
    }
    acc += seg;
  }
  return out;
}

