// X-ray view of a warehouse: the roof comes off and every rack bin is drawn, coloured by
// product, ABC class, days to expiry or quality status, with the planned pick route on the
// floor and the cold room shaded. Also: red rings on stores that received a recalled lot.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { FacilityId } from '../data/types';
import type { BinMap, BinCell } from '../api/wms-types';
import { LAYOUTS } from '../data/layouts';
import { siteStorage, sensorDefs, SKU_COLORS } from '../data/wms';
import { PARK_BUILDINGS } from '../data/park';
import { storeDef } from '../data/city';
import { api } from '../api/client';
import { useApp, type XrayMode } from '../store';

/** Latest bin contents per site (also read by the legend for the hovered bin). */
export const xrayCells = new Map<string, BinCell>();

export function cellColor(mode: XrayMode, c: BinCell | undefined): string {
  if (!c) return '#d5dbe6';
  switch (mode) {
    case 'abc': return c.c === 'A' ? '#ef4444' : c.c === 'B' ? '#f59e0b' : c.c === 'C' ? '#60a5fa' : '#94a3b8';
    case 'expiry': return c.e === null ? '#cbd5e1' : c.e < 0 ? '#7f1d1d' : c.e <= 7 ? '#ef4444' : c.e <= 30 ? '#f59e0b' : c.e <= 120 ? '#a3e635' : '#22c55e';
    case 'qc': return c.q === 'RECALLED' ? '#dc2626' : c.q === 'HOLD' ? '#f59e0b' : '#cbd5e1';
    default: return SKU_COLORS[c.s] ?? '#94a3b8';
  }
}

const BOX = new THREE.BoxGeometry(1.15, 1.15, 1.7);
const SHELF = new THREE.BoxGeometry(1.35, 0.07, 2.5);
const tmp = new THREE.Object3D();
const col = new THREE.Color();

function useBinMap(facilityId: FacilityId, active: boolean): BinMap | null {
  const v = useApp((s) => s.wmsVersion);
  const [map, setMap] = useState<BinMap | null>(null);
  const last = useRef(0);
  useEffect(() => {
    if (!active) return;
    const wait = Math.max(0, 2500 - (Date.now() - last.current));
    const t = window.setTimeout(() => {
      last.current = Date.now();
      api.wmsBins(facilityId).then((m) => {
        for (const c of m.cells) xrayCells.set(c.b, c);
        setMap(m);
      }).catch(() => undefined);
    }, wait);
    return () => window.clearTimeout(t);
  }, [facilityId, active, v]);
  return map;
}

export function XRay({ facilityId }: { facilityId: FacilityId }) {
  const xray = useApp((s) => s.xray);
  const active = xray.facility === facilityId;
  const map = useBinMap(facilityId, active);
  const site = useMemo(() => siteStorage(facilityId), [facilityId]);
  const L = LAYOUTS[facilityId];
  const binsRef = useRef<THREE.InstancedMesh>(null);
  const shelvesRef = useRef<THREE.InstancedMesh>(null);
  const hl = useRef<THREE.Group>(null);
  const setXray = useApp((s) => s.setXray);

  // shelves (one per bin) never move
  useEffect(() => {
    const m = shelvesRef.current;
    if (!m) return;
    site.bins.forEach((b, i) => { tmp.position.set(b.x, b.y - 0.04, b.z); tmp.updateMatrix(); m.setMatrixAt(i, tmp.matrix); });
    m.instanceMatrix.needsUpdate = true;
  }, [site, active]);

  // pallets: occupied bins drawn as coloured boxes
  useEffect(() => {
    const m = binsRef.current;
    if (!m || !map) return;
    const cells = new Map(map.cells.map((c) => [c.b, c]));
    site.bins.forEach((b, i) => {
      const c = cells.get(b.id);
      tmp.position.set(b.x, b.y + 0.62, b.z);
      tmp.scale.setScalar(c ? 1 : 0.0001);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      m.setColorAt(i, col.set(cellColor(xray.mode, c)));
    });
    tmp.scale.setScalar(1);
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [map, site, xray.mode]);

  useFrame(({ clock }) => {
    if (!hl.current) return;
    const k = 1.05 + 0.12 * Math.sin(clock.elapsedTime * 5);
    hl.current.children.forEach((c) => c.scale.set(k, k, k));
  });

  if (!active) return null;
  const { x0, x1, depth } = L.building;
  const coldX0 = site.coldX0;
  const highlights = site.bins.filter((b) => xray.highlight.includes(b.id));
  const route = xray.route?.facility === facilityId ? xray.route.path : null;
  return (
    <group>
      {/* floor, aisle markings and the outline of the walls */}
      <mesh position={[(x0 + x1) / 2, 0.04, -depth / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[x1 - x0, depth]} />
        <meshStandardMaterial color="#eef2f8" roughness={1} />
      </mesh>
      {site.aisles.map((a) => (
        <mesh key={a.letter} position={[a.x, 0.06, -depth / 2 - 1]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[2.2, depth - 7]} />
          <meshBasicMaterial color={a.zone === 'COLD' ? '#cfe6ff' : '#e2e8f2'} />
        </mesh>
      ))}
      <lineSegments position={[(x0 + x1) / 2, 0.8, -depth / 2]}>
        <edgesGeometry args={[new THREE.BoxGeometry(x1 - x0, 1.6, depth)]} />
        <lineBasicMaterial color="#8da2c8" />
      </lineSegments>
      {coldX0 !== null && (
        <mesh position={[(coldX0 + x1) / 2, 2.6, -depth / 2]} renderOrder={2}>
          <boxGeometry args={[x1 - coldX0 - 0.4, 5.2, depth - 0.4]} />
          <meshBasicMaterial color="#38bdf8" transparent opacity={0.1} depthWrite={false} />
        </mesh>
      )}
      <instancedMesh ref={shelvesRef} args={[SHELF, undefined, site.bins.length]} frustumCulled={false}>
        <meshStandardMaterial color="#9aa8bf" roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={binsRef} args={[BOX, undefined, site.bins.length]} frustumCulled={false}
        onPointerMove={(e) => { e.stopPropagation(); const b = e.instanceId !== undefined ? site.bins[e.instanceId] : null; setXray({ hover: b?.id ?? null }); }}
        onPointerOut={() => setXray({ hover: null })}>
        <meshStandardMaterial roughness={0.75} />
      </instancedMesh>
      {sensorDefs().filter((s) => s.facilityId === facilityId).map((s) => (
        <group key={s.id} position={[s.x, 0, s.z + 1.4]}>
          <mesh position={[0, 2.2, 0]}><cylinderGeometry args={[0.08, 0.08, 4.4, 8]} /><meshStandardMaterial color="#64748b" /></mesh>
          <mesh position={[0, 4.6, 0]}><sphereGeometry args={[0.38, 16, 12]} /><meshStandardMaterial color={s.zone === 'COLD' ? '#0ea5e9' : '#22c55e'} emissive={s.zone === 'COLD' ? '#0ea5e9' : '#22c55e'} emissiveIntensity={0.4} /></mesh>
        </group>
      ))}
      <group ref={hl}>
        {highlights.map((b) => (
          <lineSegments key={b.id} position={[b.x, b.y + 0.62, b.z]} renderOrder={5}>
            <edgesGeometry args={[new THREE.BoxGeometry(1.5, 1.5, 2.1)]} />
            <lineBasicMaterial color="#facc15" linewidth={2} depthTest={false} />
          </lineSegments>
        ))}
      </group>
      {route && <RouteLine path={route} />}
    </group>
  );
}

function RouteLine({ path }: { path: { x: number; z: number }[] }) {
  const segs = useMemo(() => {
    const out: { x: number; z: number; len: number; rot: number }[] = [];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.01) continue;
      out.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, len, rot: -Math.atan2(b.z - a.z, b.x - a.x) });
    }
    return out;
  }, [path]);
  const dot = useRef<THREE.Mesh>(null);
  const total = useMemo(() => segs.reduce((a, s) => a + s.len, 0), [segs]);
  useFrame(({ clock }) => {
    if (!dot.current || !path.length) return;
    // a marker walking the route
    let d = (clock.elapsedTime * 9) % Math.max(1, total);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (d <= len) { const t = len ? d / len : 0; dot.current.position.set(a.x + (b.x - a.x) * t, 0.5, a.z + (b.z - a.z) * t); return; }
      d -= len;
    }
  });
  return (
    <group>
      {segs.map((s, i) => (
        <mesh key={i} position={[s.x, 0.12, s.z]} rotation={[0, s.rot, 0]} renderOrder={3}>
          <boxGeometry args={[s.len + 0.42, 0.06, 0.42]} />
          <meshBasicMaterial color="#2f5bea" />
        </mesh>
      ))}
      <mesh ref={dot}><sphereGeometry args={[0.55, 16, 12]} /><meshStandardMaterial color="#1d4ed8" emissive="#3b82f6" emissiveIntensity={0.6} /></mesh>
    </group>
  );
}

/** Red rings around the stores that received a recalled lot (world coordinates). */
export function RecallRings() {
  const ids = useApp((s) => s.xray.recallStores);
  const g = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!g.current) return;
    const k = 1 + 0.12 * Math.sin(clock.elapsedTime * 3.5);
    g.current.children.forEach((c) => c.scale.set(k, 1, k));
  });
  const blds = ids.map((id) => PARK_BUILDINGS.find((b) => b.id === storeDef(id)?.buildingId)).filter((b): b is NonNullable<typeof b> => !!b);
  if (!blds.length) return null;
  return (
    <group ref={g}>
      {blds.map((b) => (
        <mesh key={b.id} position={[b.x, 0.15, b.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={4}>
          <ringGeometry args={[Math.max(b.w, b.d) * 0.62, Math.max(b.w, b.d) * 0.62 + 1.6, 48]} />
          <meshBasicMaterial color="#dc2626" transparent opacity={0.85} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}
