// Street-level detail for the town and the Maple Heights estate, all instanced so that hundreds
// of houses, parked cars, lamps and trees cost only a few draw calls.
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { SCENERY, GREENS } from '../data/scenery';
import { C, mat } from './materials';

type Item = { p: [number, number, number]; r?: number; s: [number, number, number]; c?: string };

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** One instanced mesh: unit geometry, each item placed, rotated about Y, scaled and optionally coloured. */
function Inst({ geo, items, color = '#ffffff', shadow = false, rough = 0.85, emissive }: { geo: THREE.BufferGeometry; items: Item[]; color?: string; shadow?: boolean; rough?: number; emissive?: string }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const material = useMemo(() => mat(color, { rough, emissive }), [color, rough, emissive]);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((it, i) => {
      _e.set(0, it.r ?? 0, 0);
      _q.setFromEuler(_e);
      _m.compose(_v.set(...it.p), _q, _s.set(...it.s));
      m.setMatrixAt(i, _m);
      if (it.c) m.setColorAt(i, _c.set(it.c));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items]);
  if (!items.length) return null;
  return <instancedMesh ref={ref} args={[geo, material, items.length]} castShadow={shadow} receiveShadow />;
}

const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
const SPHERE = new THREE.SphereGeometry(0.5, 10, 8);
// a gable roof: triangular prism, ridge along local X, base at y=0, unit size
const ROOF = (() => {
  const sh = new THREE.Shape();
  sh.moveTo(-0.5, 0); sh.lineTo(0.5, 0); sh.lineTo(0, 1); sh.lineTo(-0.5, 0);
  const g = new THREE.ExtrudeGeometry(sh, { depth: 1, bevelEnabled: false });
  g.translate(0, 0, -0.5);
  g.rotateY(Math.PI / 2);
  return g;
})();

/** rotate a local offset (along the house's front = local +z) into world space */
function local(x: number, z: number, rot: number, lx: number, lz: number): [number, number] {
  const c = Math.cos(rot), s = Math.sin(rot);
  return [x + lx * c + lz * s, z - lx * s + lz * c];
}

function Houses() {
  const parts = useMemo(() => {
    const walls: Item[] = [], roofs: Item[] = [], doors: Item[] = [], wins: Item[] = [], chim: Item[] = [], drives: Item[] = [], yards: Item[] = [], hedges: Item[] = [];
    for (const h of SCENERY.houses) {
      walls.push({ p: [h.x, h.h / 2, h.z], r: h.rot, s: [h.w, h.h, h.d], c: h.wall });
      roofs.push({ p: [h.x, h.h, h.z], r: h.rot, s: [h.w + 0.8, h.roof, h.d + 1.2], c: h.roofColor });
      const fz = h.d / 2 + 0.06;
      const [dx, dz] = local(h.x, h.z, h.rot, -h.w * 0.18, fz);
      doors.push({ p: [dx, 1.1, dz], r: h.rot, s: [1.1, 2.2, 0.12] });
      for (const lx of [-h.w * 0.38, h.w * 0.12, h.w * 0.34]) {
        const [wx, wz] = local(h.x, h.z, h.rot, lx, fz);
        wins.push({ p: [wx, 1.9, wz], r: h.rot, s: [1.5, 1.2, 0.1] });
        if (h.h > 5) {
          const [ux, uz] = local(h.x, h.z, h.rot, lx - h.w * 0.05, fz);
          wins.push({ p: [ux, 4.7, uz], r: h.rot, s: [1.4, 1.1, 0.1] });
        }
      }
      // back windows so the houses look lived-in from every side
      for (const lx of [-h.w * 0.25, h.w * 0.25]) {
        const [bx, bz] = local(h.x, h.z, h.rot, lx, -fz);
        wins.push({ p: [bx, 1.9, bz], r: h.rot, s: [1.4, 1.1, 0.1] });
      }
      if (h.chimney) {
        const [cx, cz] = local(h.x, h.z, h.rot, h.w * 0.3, -h.d * 0.12);
        chim.push({ p: [cx, h.h + h.roof * 0.6, cz], r: h.rot, s: [0.9, h.roof * 1.1, 0.9] });
      }
      // front path, lawn and a low hedge along the pavement
      const [px, pz] = local(h.x, h.z, h.rot, -h.w * 0.18, h.d / 2 + 4);
      drives.push({ p: [px, 0.04, pz], r: h.rot, s: [1.4, 0.02, 8] });
      const [yx, yz] = local(h.x, h.z, h.rot, 0, 0.5);
      yards.push({ p: [yx, 0.015, yz], r: h.rot, s: [h.w + 8, 0.01, h.d + 16] });
      const [hx, hz] = local(h.x, h.z, h.rot, h.w * 0.22, h.d / 2 + 7.5);
      hedges.push({ p: [hx, 0.45, hz], r: h.rot, s: [h.w * 0.5, 0.9, 0.8] });
    }
    return { walls, roofs, doors, wins, chim, drives, yards, hedges };
  }, []);
  return (
    <group>
      <Inst geo={BOX} items={parts.yards} color="#d4e8d0" rough={1} />
      <Inst geo={BOX} items={parts.drives} color="#d9dde6" rough={1} />
      <Inst geo={BOX} items={parts.walls} shadow />
      <Inst geo={ROOF} items={parts.roofs} shadow />
      <Inst geo={BOX} items={parts.doors} color="#6b4a35" />
      <Inst geo={BOX} items={parts.wins} color={C.glass} rough={0.3} />
      <Inst geo={BOX} items={parts.chim} color="#9a6b55" shadow />
      <Inst geo={BOX} items={parts.hedges} color={C.leafDark} rough={1} />
    </group>
  );
}

function ParkedCars() {
  const parts = useMemo(() => {
    const body: Item[] = [], cab: Item[] = [], glass: Item[] = [], wheel: Item[] = [];
    for (const c of [...SCENERY.driveways, ...SCENERY.kerb]) {
      body.push({ p: [c.x, 0.75, c.z], r: c.rot, s: [4.4, 0.9, 2.0], c: c.color });
      const [cx, cz] = local(c.x, c.z, c.rot, -0.3, 0);
      cab.push({ p: [cx, 1.5, cz], r: c.rot, s: [2.3, 0.75, 1.8], c: c.color });
      const [gx, gz] = local(c.x, c.z, c.rot, 0.86, 0);
      glass.push({ p: [gx, 1.5, gz], r: c.rot, s: [0.06, 0.62, 1.66] });
      for (const [lx, lz] of [[1.35, 0.95], [1.35, -0.95], [-1.35, 0.95], [-1.35, -0.95]]) {
        const [wx, wz] = local(c.x, c.z, c.rot, lx, lz);
        wheel.push({ p: [wx, 0.36, wz], r: c.rot, s: [0.72, 0.72, 0.28] });
      }
    }
    return { body, cab, glass, wheel };
  }, []);
  return (
    <group>
      <Inst geo={BOX} items={parts.body} />
      <Inst geo={BOX} items={parts.cab} />
      <Inst geo={BOX} items={parts.glass} color={C.glass} rough={0.3} />
      <Inst geo={BOX} items={parts.wheel} color={C.tire} />
    </group>
  );
}

function Lamps() {
  const parts = useMemo(() => {
    const poles: Item[] = [], heads: Item[] = [];
    for (const l of SCENERY.lamps) {
      poles.push({ p: [l.x, 2.6, l.z], s: [0.18, 5.2, 0.18] });
      heads.push({ p: [l.x, 5.3, l.z], s: [0.7, 0.45, 0.7] });
    }
    return { poles, heads };
  }, []);
  return (
    <group>
      <Inst geo={CYL} items={parts.poles} color="#7d879a" />
      <Inst geo={SPHERE} items={parts.heads} color="#fff6d8" emissive="#ffe8a3" />
    </group>
  );
}

function Benches() {
  const parts = useMemo(() => {
    const seats: Item[] = [], backs: Item[] = [];
    for (const b of SCENERY.benches) {
      seats.push({ p: [b.x, 0.5, b.z], r: b.rot, s: [2.2, 0.15, 0.6] });
      const [bx, bz] = local(b.x, b.z, b.rot, 0, -0.3);
      backs.push({ p: [bx, 0.85, bz], r: b.rot, s: [2.2, 0.6, 0.1] });
    }
    return { seats, backs };
  }, []);
  return (
    <group>
      <Inst geo={BOX} items={parts.seats} color="#a0764f" />
      <Inst geo={BOX} items={parts.backs} color="#a0764f" />
    </group>
  );
}

function Greens() {
  const parts = useMemo(() => {
    const lawns: Item[] = [], paths: Item[] = [], pond: Item[] = [], play: Item[] = [];
    for (const g of GREENS) {
      const cx = (g.x0 + g.x1) / 2, cz = (g.z0 + g.z1) / 2, w = g.x1 - g.x0, d = g.z1 - g.z0;
      lawns.push({ p: [cx, 0.016, cz], s: [w, 0.01, d] });
      paths.push({ p: [cx, 0.03, cz], s: [w - 4, 0.01, 2.4] }, { p: [cx, 0.03, cz], s: [2.4, 0.01, d - 4] });
      if (w > 120) {
        pond.push({ p: [cx + w * 0.25, 0.04, cz], s: [w * 0.18, 0.01, d * 0.4] });
        // a small playground: frame, slide and a sandpit
        play.push({ p: [cx - w * 0.28, 1.3, cz - d * 0.18], s: [4, 0.2, 0.2] }, { p: [cx - w * 0.28 - 2, 0.65, cz - d * 0.18], s: [0.2, 1.3, 0.2] }, { p: [cx - w * 0.28 + 2, 0.65, cz - d * 0.18], s: [0.2, 1.3, 0.2] });
      }
    }
    return { lawns, paths, pond, play };
  }, []);
  return (
    <group>
      <Inst geo={BOX} items={parts.lawns} color="#cfe6cc" rough={1} />
      <Inst geo={BOX} items={parts.paths} color="#e8e1d2" rough={1} />
      <Inst geo={SPHERE} items={parts.pond} color="#9cc6ee" rough={0.2} />
      <Inst geo={BOX} items={parts.play} color="#e8590c" />
    </group>
  );
}

function MoreTrees() {
  const parts = useMemo(() => {
    const trunks: Item[] = [], crowns: Item[] = [], crowns2: Item[] = [];
    for (const [x, z, s] of SCENERY.trees) {
      trunks.push({ p: [x, 0.9 * s, z], s: [0.42 * s, 1.8 * s, 0.42 * s] });
      crowns.push({ p: [x, 3.0 * s, z], s: [3.1 * s, 3.1 * s, 3.1 * s] });
      crowns2.push({ p: [x + 0.5 * s, 2.4 * s, z + 0.4 * s], s: [1.8 * s, 1.8 * s, 1.8 * s] });
    }
    return { trunks, crowns, crowns2 };
  }, []);
  return (
    <group>
      <Inst geo={CYL} items={parts.trunks} color={C.trunk} />
      <Inst geo={SPHERE} items={parts.crowns} color={C.leaf} rough={0.9} shadow />
      <Inst geo={SPHERE} items={parts.crowns2} color={C.leafDark} rough={0.9} />
    </group>
  );
}

export function Scenery() {
  return (
    <group>
      <Greens />
      <Houses />
      <ParkedCars />
      <Lamps />
      <Benches />
      <MoreTrees />
    </group>
  );
}
