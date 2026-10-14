// Pedestrians: people walking the sidewalks round the town and estate blocks, strolling on the
// beach promenade, standing outside the shops, and relaxing on the beach. Instanced and animated
// on the client (decoration only).
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { SCENERY, PROMENADE, crowdSpots, loopPoint } from '../data/scenery';
import { mat } from './materials';

const SHIRTS = ['#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#f8f9fa', '#212529', '#0c8599', '#e64980', '#fab005', '#5c7cfa', '#868e96'];
const TROUSERS = ['#343a40', '#1c3d6e', '#495057', '#5f3dc4', '#6b4a35', '#2b2d42'];
const SKIN = ['#f1c7a5', '#d9a47c', '#a86f4c', '#7a4b2e', '#ffdbc0', '#c68b62'];
const SCALE = 1.25; // a touch larger than life so people read from the default camera height

type Walker =
  | { kind: 'loop'; loop: number; s0: number; v: number; off: number }
  | { kind: 'prom'; x0: number; span: number; v: number; z: number }
  | { kind: 'stand'; x: number; z: number; face: number };

function rnd(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function usePeople() {
  return useMemo(() => {
    const r = rnd(2026);
    const people: { w: Walker; shirt: string; legs: string; skin: string; phase: number }[] = [];
    const add = (w: Walker) => people.push({
      w, shirt: SHIRTS[Math.floor(r() * SHIRTS.length)], legs: TROUSERS[Math.floor(r() * TROUSERS.length)],
      skin: SKIN[Math.floor(r() * SKIN.length)], phase: r() * 10,
    });
    SCENERY.loops.forEach((l, i) => {
      const n = Math.round(l.length / 45);
      for (let k = 0; k < n; k++) add({ kind: 'loop', loop: i, s0: r() * l.length, v: (1.1 + r() * 0.6) * (r() < 0.5 ? -1 : 1), off: (r() - 0.5) * 1.8 });
    });
    for (let k = 0; k < 60; k++) {
      const span = 60 + r() * 220;
      add({ kind: 'prom', x0: PROMENADE.x0 + r() * (PROMENADE.x1 - PROMENADE.x0 - span), span, v: 0.9 + r() * 0.6, z: PROMENADE.z + (r() - 0.5) * 2.4 });
    }
    for (const [x, z] of crowdSpots()) {
      const n = 1 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) add({ kind: 'stand', x: x + (r() - 0.5) * 6, z: z + (r() - 0.5) * 3, face: r() * Math.PI * 2 });
    }
    // on the sand
    for (let k = 0; k < 70; k++) {
      add({ kind: 'stand', x: PROMENADE.x0 + 20 + r() * (PROMENADE.x1 - PROMENADE.x0 - 40), z: PROMENADE.beachZ0 + r() * (PROMENADE.beachZ1 - PROMENADE.beachZ0), face: r() * Math.PI * 2 });
    }
    return people;
  }, []);
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();

export function People() {
  const people = usePeople();
  const torso = useRef<THREE.InstancedMesh>(null);
  const head = useRef<THREE.InstancedMesh>(null);
  const legL = useRef<THREE.InstancedMesh>(null);
  const legR = useRef<THREE.InstancedMesh>(null);
  const geos = useMemo(() => ({
    torso: new THREE.BoxGeometry(0.55, 0.72, 0.32).translate(0, 1.23, 0),
    head: new THREE.SphereGeometry(0.2, 10, 8).translate(0, 1.82, 0),
    leg: new THREE.BoxGeometry(0.2, 0.86, 0.22).translate(0, -0.43, 0), // pivot at the hip
  }), []);
  const white = mat('#ffffff');
  const coloured = useRef(false);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const parts = [torso.current, head.current, legL.current, legR.current];
    if (parts.some((p) => !p)) return;
    const [T, H, L, R] = parts as THREE.InstancedMesh[];
    people.forEach((p, i) => {
      let x: number, z: number, face: number, moving = true;
      const w = p.w;
      if (w.kind === 'loop') {
        const l = SCENERY.loops[w.loop];
        const pt = loopPoint(l, w.s0 + w.v * t);
        const dx = pt.dx * Math.sign(w.v), dz = pt.dz * Math.sign(w.v);
        x = pt.x + pt.dz * w.off;
        z = pt.z - pt.dx * w.off;
        face = Math.atan2(dx, dz);
      } else if (w.kind === 'prom') {
        const u = (w.v * t + p.phase * 20) % (2 * w.span);
        const back = u > w.span;
        x = w.x0 + (back ? 2 * w.span - u : u);
        z = w.z;
        face = back ? -Math.PI / 2 : Math.PI / 2;
      } else {
        x = w.x; z = w.z; face = w.face + Math.sin(t * 0.3 + p.phase) * 0.4; moving = false;
      }
      const swing = moving ? Math.sin(t * 7 + p.phase) * 0.45 : 0;
      const bob = moving ? Math.abs(Math.sin(t * 7 + p.phase)) * 0.05 : 0;
      _e.set(0, face, 0); _q.setFromEuler(_e);
      _m.compose(_v.set(x, bob, z), _q, _s.set(SCALE, SCALE, SCALE));
      T.setMatrixAt(i, _m); H.setMatrixAt(i, _m);
      // legs hang from the hip (0.87 m) and swing in opposite directions
      const hip = 0.87 * SCALE;
      const ox = Math.cos(face) * 0.13 * SCALE, oz = -Math.sin(face) * 0.13 * SCALE;
      _e.set(swing, face, 0, 'YXZ'); _q.setFromEuler(_e);
      _m.compose(_v.set(x - ox, hip + bob, z - oz), _q, _s);
      L.setMatrixAt(i, _m);
      _e.set(-swing, face, 0, 'YXZ'); _q.setFromEuler(_e);
      _m.compose(_v.set(x + ox, hip + bob, z + oz), _q, _s);
      R.setMatrixAt(i, _m);
      _e.order = 'XYZ';
    });
    for (const m of [T, H, L, R]) m.instanceMatrix.needsUpdate = true;
    if (!coloured.current) {
      people.forEach((p, i) => {
        T.setColorAt(i, _c.set(p.shirt)); H.setColorAt(i, _c.set(p.skin));
        L.setColorAt(i, _c.set(p.legs)); R.setColorAt(i, _c.set(p.legs));
      });
      for (const m of [T, H, L, R]) { if (m.instanceColor) m.instanceColor.needsUpdate = true; m.computeBoundingSphere(); }
      coloured.current = true;
    }
  });

  const n = people.length;
  return (
    <group>
      <instancedMesh ref={torso} args={[geos.torso, white, n]} castShadow frustumCulled={false} />
      <instancedMesh ref={head} args={[geos.head, white, n]} frustumCulled={false} />
      <instancedMesh ref={legL} args={[geos.leg, white, n]} frustumCulled={false} />
      <instancedMesh ref={legR} args={[geos.leg, white, n]} frustumCulled={false} />
    </group>
  );
}

/** Beach umbrellas and towels (static). */
export function BeachProps() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const pole = useRef<THREE.InstancedMesh>(null);
  const towel = useRef<THREE.InstancedMesh>(null);
  const spots = useMemo(() => {
    const r = rnd(77);
    const out: [number, number, string][] = [];
    for (let k = 0; k < 90; k++) out.push([PROMENADE.x0 + 30 + r() * (PROMENADE.x1 - PROMENADE.x0 - 60), PROMENADE.beachZ0 + 2 + r() * (PROMENADE.beachZ1 - PROMENADE.beachZ0 - 4), SHIRTS[Math.floor(r() * SHIRTS.length)]]);
    return out;
  }, []);
  const geos = useMemo(() => ({
    canopy: new THREE.ConeGeometry(1.8, 0.9, 10).translate(0, 2.7, 0),
    pole: new THREE.CylinderGeometry(0.05, 0.05, 2.7, 6).translate(0, 1.35, 0),
    towel: new THREE.BoxGeometry(1.0, 0.03, 2.0).translate(1.4, 0.03, 0.6),
  }), []);
  const white = mat('#ffffff');
  const set = () => {
    const [a, b, c] = [ref.current, pole.current, towel.current];
    if (!a || !b || !c) return;
    spots.forEach(([x, z, col], i) => {
      _m.makeTranslation(x, 0, z);
      a.setMatrixAt(i, _m); b.setMatrixAt(i, _m); c.setMatrixAt(i, _m);
      a.setColorAt(i, _c.set(col)); c.setColorAt(i, _c.set(SHIRTS[(i * 5) % SHIRTS.length]));
    });
    for (const m of [a, b, c]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; m.computeBoundingSphere(); }
  };
  return (
    <group ref={() => set()}>
      <instancedMesh ref={ref} args={[geos.canopy, white, spots.length]} castShadow />
      <instancedMesh ref={pole} args={[geos.pole, mat('#e9ecef'), spots.length]} />
      <instancedMesh ref={towel} args={[geos.towel, white, spots.length]} />
    </group>
  );
}
