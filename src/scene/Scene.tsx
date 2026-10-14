// Isometric 3D warehouse scene (React Three Fiber).
import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import type { FacilityId, Vec2 } from '../data/types';
import { LAYOUTS } from '../data/layouts';
import { getWorld, useApp } from '../store';
import { entityWorldPos, entityLocalPos, findAsset, palletsOfSku } from '../ui/derive';
import { FACILITY_OFFSET, PARK_BOUNDS, toPark } from '../data/park';
import { findBuilding, findVehicle, vehicleNow } from '../data/parkClient';
import { ParkScene, VEHICLE_DIMS, buildingDims, OVERVIEW_TARGET } from './Park';
import { SHIP_DIMS, CRANE_DIMS, VAN_DIMS } from './Port';
import { storeBuilding } from '../data/city';
import { remainingPts, legYardIn, legReverseIn } from '../sim/paths';
import { cachedLength } from '../sim/engine';
import { Site } from './Site';
import { Dynamic, useSelectHandlers } from './Dynamic';
import { Pin } from './models';
import { glowTexture } from './materials';
import { anchors, labelSpecs } from './labels';

const POLAR = (54 * Math.PI) / 180; // angle from vertical (isometric-style)
const RADIUS = 900;

function CameraRig({ facilityId }: { facilityId: FacilityId }) {
  const { camera, gl, size } = useThree();
  const cam = camera as THREE.OrthographicCamera;
  const controls = useMemo(() => {
    const c = new MapControls(cam, gl.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.14;
    c.screenSpacePanning = false;
    c.minPolarAngle = POLAR;
    c.maxPolarAngle = POLAR;
    c.zoomToCursor = true;
    c.rotateSpeed = 0.6;
    return c;
  }, [cam, gl]);
  useEffect(() => () => controls.dispose(), [controls]);

  const anim = useRef<null | { t: number; dur: number; from: { tx: number; tz: number; az: number; zoom: number }; to: { tx: number; tz: number; az: number; zoom: number } }>(null);
  const followPrev = useRef<Vec2 | null>(null);

  const homeZoom = (fac: FacilityId = facilityId) => size.width / LAYOUTS[fac].camera.span;
  /** Zoom at which the whole park fits on screen. */
  const overviewZoom = () => {
    const dx = PARK_BOUNDS.x1 - PARK_BOUNDS.x0, dz = PARK_BOUNDS.z1 - PARK_BOUNDS.z0;
    const across = (dx + dz) / Math.SQRT2;
    return Math.min(size.width / (across * 1.02), size.height / (across * Math.cos(POLAR) * 1.12));
  };
  const homeOf = (fac: FacilityId) => {
    const L = LAYOUTS[fac];
    const p = toPark(fac, { x: L.camera.x, z: L.camera.z });
    return { tx: p.x, tz: p.z, az: Math.PI / 4, zoom: homeZoom(fac) };
  };
  const overview = () => ({ tx: OVERVIEW_TARGET.x, tz: OVERVIEW_TARGET.z, az: Math.PI / 4, zoom: overviewZoom() });
  controls.minZoom = overviewZoom() * 0.8;
  controls.maxZoom = homeZoom() * 5;

  const azimuth = () => Math.atan2(cam.position.x - controls.target.x, cam.position.z - controls.target.z);
  const setPose = (tx: number, tz: number, az: number, zoom: number) => {
    const r = RADIUS;
    controls.target.set(tx, 0, tz);
    cam.position.set(tx + Math.sin(az) * Math.sin(POLAR) * r, Math.cos(POLAR) * r, tz + Math.cos(az) * Math.sin(POLAR) * r);
    cam.zoom = zoom;
    cam.lookAt(controls.target);
    cam.updateProjectionMatrix();
  };
  const animateTo = (to: { tx?: number; tz?: number; az?: number; zoom?: number }, dur = 0.6) => {
    const from = { tx: controls.target.x, tz: controls.target.z, az: azimuth(), zoom: cam.zoom };
    anim.current = {
      t: 0,
      dur,
      from,
      to: { tx: to.tx ?? from.tx, tz: to.tz ?? from.tz, az: to.az ?? from.az, zoom: Math.min(controls.maxZoom, Math.max(controls.minZoom, to.zoom ?? from.zoom)) },
    };
  };

  // first view: the whole park; later facility changes fly to the site
  const first = useRef(true);
  useEffect(() => {
    anim.current = null;
    if (first.current) {
      first.current = false;
      const start = useApp.getState().startView === 'site' ? homeOf(facilityId) : overview();
      setPose(start.tx, start.tz, start.az, start.zoom);
    } else {
      animateTo(homeOf(facilityId), 0.9);
    }
    controls.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facilityId]);

  // stop follow / animation when the user drags
  useEffect(() => {
    const onStart = () => {
      anim.current = null;
      if (useApp.getState().follow) useApp.getState().toggleFollow();
    };
    controls.addEventListener('start', onStart);
    return () => controls.removeEventListener('start', onStart);
  }, [controls]);

  // camera commands from the UI
  const cmd = useApp((s) => s.cameraCmd);
  useEffect(() => {
    const c = cmd.cmd;
    if (!c) return;
    switch (c.kind) {
      case 'zoomIn': animateTo({ zoom: cam.zoom * 1.35 }); break;
      case 'zoomOut': animateTo({ zoom: cam.zoom / 1.35 }); break;
      case 'rotateLeft': animateTo({ az: azimuth() - Math.PI / 4 }); break;
      case 'rotateRight': animateTo({ az: azimuth() + Math.PI / 4 }); break;
      case 'home': animateTo(homeOf(facilityId)); break;
      case 'overview': animateTo(overview(), 0.9); break;
      case 'focus': {
        const p = entityWorldPos(getWorld(), c.ref);
        if (!p) break;
        if (c.ref.kind === 'building' || c.ref.kind === 'store' || c.ref.kind === 'vessel' || c.ref.kind === 'berth') {
          // frame the whole building / ship rather than zooming into one wall
          const b = c.ref.kind === 'store' ? storeBuilding(c.ref.id) : c.ref.kind === 'building' ? findBuilding(c.ref.id) : undefined;
          const span = b ? Math.max(b.w, b.d, 30) * 3.2 : c.ref.kind === 'vessel' || c.ref.kind === 'berth' ? 260 : 200;
          animateTo({ tx: p.x, tz: p.z, zoom: size.width / span }, 0.8);
        } else {
          const park = c.ref.kind === 'vehicle' || c.ref.kind === 'gate' || c.ref.kind === 'van' || c.ref.kind === 'crane';
          animateTo({ tx: p.x, tz: p.z, zoom: Math.max(cam.zoom, homeZoom() * (park ? 1.1 : 1.6)) }, 0.8);
        }
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmd.seq]);

  useFrame((_, dt) => {
    const a = anim.current;
    if (a) {
      a.t = Math.min(1, a.t + dt / a.dur);
      const e = a.t < 0.5 ? 2 * a.t * a.t : 1 - Math.pow(-2 * a.t + 2, 2) / 2;
      let daz = a.to.az - a.from.az;
      while (daz > Math.PI) daz -= Math.PI * 2;
      while (daz < -Math.PI) daz += Math.PI * 2;
      setPose(
        a.from.tx + (a.to.tx - a.from.tx) * e,
        a.from.tz + (a.to.tz - a.from.tz) * e,
        a.from.az + daz * e,
        a.from.zoom + (a.to.zoom - a.from.zoom) * e,
      );
      if (a.t >= 1) anim.current = null;
    } else {
      const s = useApp.getState();
      if (s.follow && s.selection) {
        const p = entityWorldPos(getWorld(), s.selection);
        if (p) {
          const prev = followPrev.current;
          if (prev) {
            const dx = p.x - prev.x, dz = p.z - prev.z;
            controls.target.x += dx; controls.target.z += dz;
            cam.position.x += dx; cam.position.z += dz;
          }
          followPrev.current = { x: p.x, z: p.z };
        }
      } else followPrev.current = null;
    }
    controls.update();
  });
  return <ShadowLight target={controls.target} />;
}

function ShadowLight({ target }: { target: THREE.Vector3 }) {
  const light = useRef<THREE.DirectionalLight>(null);
  const { scene, camera, size } = useThree();
  const half = useRef(120);
  useEffect(() => {
    const l = light.current;
    if (!l) return;
    scene.add(l.target);
    return () => { scene.remove(l.target); };
  }, [scene]);
  useFrame(() => {
    const l = light.current;
    if (!l) return;
    l.position.set(target.x + 120, 220, target.z + 90);
    l.target.position.set(target.x, 0, target.z);
    l.target.updateMatrixWorld();
    // keep the shadowed area matched to what is on screen (whole park when zoomed out)
    const visible = size.width / (camera as THREE.OrthographicCamera).zoom;
    const want = Math.max(120, Math.min(900, visible * 0.75));
    if (Math.abs(want - half.current) / half.current > 0.15) {
      half.current = want;
      const sc = l.shadow.camera;
      sc.left = -want; sc.right = want; sc.top = want; sc.bottom = -want; sc.far = 900;
      sc.updateProjectionMatrix();
    }
  });
  return (
    <directionalLight
      ref={light}
      intensity={1.85}
      castShadow
      shadow-mapSize={[2048, 2048]}
      shadow-bias={-0.0004}
      shadow-normalBias={0.04}
      shadow-camera-left={-120}
      shadow-camera-right={120}
      shadow-camera-top={120}
      shadow-camera-bottom={-120}
      shadow-camera-near={1}
      shadow-camera-far={900}
    />
  );
}

const DIMS: Record<string, [number, number, number]> = {
  truck: [12.8, 5.0, 3.3],
  forklift: [5.4, 4.2, 2.6],
  pallet: [2.4, 2.6, 2.4],
  dock: [4.9, 0.4, 13.4],
  charger: [3.6, 1.9, 4.0],
};

function RouteRibbon({ truckId }: { truckId: string }) {
  const tick = useApp((s) => s.tick);
  const data = useMemo(() => {
    const t = getWorld().trucks[truckId];
    if (!t || t.phase === 'away' || t.phase === 'working' || t.phase === 'ready') return null;
    let pts: Vec2[] = [];
    t.legs.forEach((leg, i) => {
      if (i < t.legIdx) return;
      const part = i === t.legIdx ? remainingPts(leg.pts, t.legDist) : leg.pts;
      pts = pts.concat(part);
    });
    if ((t.phase === 'en_route' || t.phase === 'at_gate') && t.dockId) {
      pts = pts.concat(legYardIn(t.facilityId, t.dockId).pts, legReverseIn(t.facilityId, t.dockId).pts);
    }
    if (pts.length < 2 || cachedLength(pts) < 1) return null;
    const pos: number[] = [];
    const idx: number[] = [];
    const half = 0.7;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l, nz = dx / l;
      pos.push(pts[i].x + nx * half, 0.09, pts[i].z + nz * half, pts[i].x - nx * half, 0.09, pts[i].z - nz * half);
      if (i > 0) { const k = i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return { g, end: pts[pts.length - 1] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [truckId, tick]);
  useEffect(() => () => data?.g.dispose(), [data]);
  if (!data) return null;
  return (
    <group>
      <mesh geometry={data.g} renderOrder={2}>
        <meshBasicMaterial color="#2f62e0" transparent opacity={0.85} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <group position={[data.end.x, 0, data.end.z]}><Pin y={0.2} /></group>
    </group>
  );
}

function SiteFrame({ truckId }: { truckId: string }) {
  const fac = getWorld().trucks[truckId]?.facilityId;
  if (!fac) return null;
  const o = FACILITY_OFFSET[fac];
  return <group position={[o.x, 0, o.z]}><RouteRibbon truckId={truckId} /></group>;
}

function dimsFor(ref: { kind: string; id: string } | null): [number, number, number] | null {
  if (!ref || ref.kind === 'facility') return null;
  if (ref.kind === 'asset') return findAsset(ref.id)?.size ?? null;
  if (ref.kind === 'building') { const b = findBuilding(ref.id); return b ? buildingDims(b) : null; }
  if (ref.kind === 'vehicle') { const v = findVehicle(ref.id); return v ? VEHICLE_DIMS[v.kind] : null; }
  if (ref.kind === 'gate') return [5, 4.5, 6];
  if (ref.kind === 'vessel') return SHIP_DIMS;
  if (ref.kind === 'crane') return CRANE_DIMS;
  if (ref.kind === 'berth') return [90, 2, 16];
  if (ref.kind === 'store') { const b = storeBuilding(ref.id); return b ? buildingDims(b) : null; }
  if (ref.kind === 'van') { const v = getWorld().retail?.vans[ref.id]; return v ? VAN_DIMS[v.kind] : null; }
  return DIMS[ref.kind] ?? null;
}

/** Where to draw selection / hover boxes (park coordinates; docks sit on their pad). */
function fxPos(ref: { kind: string; id: string }): { x: number; z: number } | null {
  if (ref.kind === 'dock') {
    const l = entityLocalPos(getWorld(), ref as never);
    return l && l.fac ? toPark(l.fac, { x: l.p.x, z: 7.4 }) : null;
  }
  return entityWorldPos(getWorld(), ref as never);
}

function headingOf(ref: { kind: string; id: string }): number {
  const w = getWorld();
  if (ref.kind === 'truck') return w.trucks[ref.id]?.heading ?? 0;
  if (ref.kind === 'forklift') return w.forklifts[ref.id]?.heading ?? 0;
  if (ref.kind === 'asset') return -(findAsset(ref.id)?.rotation ?? 0);
  if (ref.kind === 'vehicle') { const v = findVehicle(ref.id); return v ? vehicleNow(v).heading : 0; }
  if (ref.kind === 'vessel') return w.port?.vessels[ref.id]?.heading ?? 0;
  if (ref.kind === 'van') return w.retail?.vans[ref.id]?.heading ?? 0;
  return 0;
}

/** Light outline on whatever the pointer is over (when it isn't already selected). */
function HoverFx() {
  const hovered = useApp((s) => s.hovered);
  const sel = useApp((s) => s.selection);
  const g = useRef<THREE.Group>(null);
  const same = hovered && sel && hovered.kind === sel.kind && hovered.id === sel.id;
  const dims = same ? null : dimsFor(hovered);
  const edges = useMemo(() => (dims ? new THREE.EdgesGeometry(new THREE.BoxGeometry(...dims)) : null), [dims]);
  useFrame(() => {
    const grp = g.current;
    if (!grp || !hovered) return;
    const p = fxPos(hovered);
    grp.visible = !!p;
    if (!p) return;
    grp.position.set(p.x, 0, p.z);
    grp.rotation.y = -headingOf(hovered);
  });
  if (!hovered || !dims || !edges) return null;
  return (
    <group ref={g}>
      <lineSegments geometry={edges} position={[0, dims[1] / 2, 0]}>
        <lineBasicMaterial color="#7d9cf0" transparent opacity={0.9} />
      </lineSegments>
    </group>
  );
}

/** Pulsing rings under every pallet of the product chosen in the inventory list. */
function SkuHighlight() {
  const sku = useApp((s) => s.highlightSku);
  const fac = useApp((s) => s.facilityId);
  useApp((s) => s.tick);
  const ring = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!ring.current) return;
    const k = 1 + 0.18 * Math.sin(clock.elapsedTime * 4);
    ring.current.children.forEach((c) => c.scale.set(k, k, k));
  });
  if (!sku) return null;
  const pallets = palletsOfSku(getWorld(), fac, sku);
  return (
    <group ref={ring}>
      {pallets.map((p) => {
        const pos = entityWorldPos(getWorld(), { kind: 'pallet', id: p.id });
        if (!pos) return null;
        return (
          <mesh key={p.id} position={[pos.x, 0.08, pos.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={4}>
            <ringGeometry args={[1.6, 2.1, 40]} />
            <meshBasicMaterial color="#f0a030" transparent opacity={0.9} depthWrite={false} />
          </mesh>
        );
      })}
    </group>
  );
}

function SelectionFx() {
  const sel = useApp((s) => s.selection);
  const g = useRef<THREE.Group>(null);
  const glow = useMemo(() => glowTexture(), []);
  const dims = dimsFor(sel);
  const edges = useMemo(() => (dims ? new THREE.EdgesGeometry(new THREE.BoxGeometry(...dims)) : null), [dims]);
  useFrame(() => {
    const grp = g.current;
    if (!grp || !sel) return;
    const p = fxPos(sel);
    grp.visible = !!p;
    if (!p) return;
    const heading = headingOf(sel);
    grp.position.set(p.x, 0, p.z);
    grp.rotation.y = -heading;
  });
  if (!sel || !dims || !edges) return null;
  return (
    <group>
      <group ref={g}>
        <mesh position={[0, dims[1] / 2, 0]} renderOrder={3}>
          <boxGeometry args={dims} />
          <meshBasicMaterial color="#2f62e0" transparent opacity={0.07} depthWrite={false} />
        </mesh>
        <lineSegments geometry={edges} position={[0, dims[1] / 2, 0]}>
          <lineBasicMaterial color="#2f62e0" />
        </lineSegments>
        <mesh position={[0, 0.07, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[Math.max(dims[0], dims[2]) * 1.6, Math.max(dims[0], dims[2]) * 1.6]} />
          <meshBasicMaterial map={glow} transparent depthWrite={false} />
        </mesh>
      </group>
      {sel.kind === 'truck' && <SiteFrame truckId={sel.id} />}
    </group>
  );
}

function BuildingHitbox({ facilityId }: { facilityId: FacilityId }) {
  const L = LAYOUTS[facilityId];
  const handlers = useSelectHandlers({ kind: 'facility', id: facilityId });
  const b = L.building;
  return (
    <mesh position={[(b.x0 + b.x1) / 2, b.height / 2 + 1, -b.depth / 2]} {...handlers}>
      <boxGeometry args={[b.x1 - b.x0, b.height + 3, b.depth]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

/** Read-only camera state for the ?debug test hook. */
export const cameraProbe = {
  across: 0,
  target: { x: 0, z: 0 },
  project: (x: number, y: number, z: number): { x: number; y: number } | null => { void x; void y; void z; return null; },
};

function Projector() {
  const { camera, size } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  cameraProbe.project = (x, y, z) => {
    const p = new THREE.Vector3(x, y, z).project(camera);
    return { x: (p.x * 0.5 + 0.5) * size.width, y: (-p.y * 0.5 + 0.5) * size.height };
  };
  useFrame(() => {
    cameraProbe.across = size.width / (camera as THREE.OrthographicCamera).zoom;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    // where the view ray through the screen centre meets the ground
    const t = -camera.position.y / dir.y;
    cameraProbe.target = { x: camera.position.x + dir.x * t, z: camera.position.z + dir.z * t };
    const s = useApp.getState();
    const specs = labelSpecs(getWorld(), s.facilityId, s.selection, s.hovered);
    const seen = new Set<string>();
    // units visible across the screen: "far" labels only appear when zoomed out, "near" ones only when zoomed in
    const across = size.width / (camera as THREE.OrthographicCamera).zoom;
    for (const sp of specs) {
      seen.add(sp.key);
      if (!sp.world) { anchors.set(sp.key, { x: 0, y: 0, on: false }); continue; }
      v.set(sp.world.x, sp.world.y, sp.world.z).project(camera);
      const zoomOk = sp.range === 'far' ? across > 420 : sp.range === 'near' ? across < 520 : true;
      const x = (v.x * 0.5 + 0.5) * size.width, y = (-v.y * 0.5 + 0.5) * size.height;
      anchors.set(sp.key, { x, y, on: zoomOk && v.z < 1 && v.z > -1 && x > -40 && x < size.width + 40 && y > -20 && y < size.height + 60 });
    }
    for (const k of [...anchors.keys()]) if (!seen.has(k)) anchors.delete(k);
  });
  return null;
}

export function WarehouseScene() {
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const facilityId = useApp((s) => s.facilityId);
  useApp((s) => s.tick);
  const sites: FacilityId[] = ['WH-01', 'WH-02', 'WH-04'];
  return (
    <Canvas
      orthographic
      shadows
      flat
      dpr={[1, 2]}
      camera={{ position: [300, 540, 300], zoom: 2, near: 1, far: 3000 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onPointerDown={(e) => { downAt.current = { x: e.clientX, y: e.clientY }; }}
      onPointerMissed={(e) => {
        document.body.style.cursor = '';
        // a click on empty ground (not the end of a drag) clears the selection
        const d = downAt.current;
        if (e.type === 'click' && d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) {
          const s = useApp.getState();
          s.setHovered(null);
          if (s.selection) s.select(null);
        }
      }}
    >
      <color attach="background" args={['#e6ebf5']} />
      <hemisphereLight args={['#ffffff', '#c9d2e8', 1.3]} />
      <ambientLight intensity={0.35} />
      <CameraRig facilityId={facilityId} />
      <ParkScene />
      {sites.map((fac) => {
        const o = FACILITY_OFFSET[fac];
        const visible = !!getWorld().facilities[fac]; // sites outside the user's access show buildings only
        return (
          <group key={fac} position={[o.x, 0, o.z]}>
            <Site L={LAYOUTS[fac]} label={fac} />
            <BuildingHitbox facilityId={fac} />
            {visible && <Dynamic facilityId={fac} />}
          </group>
        );
      })}
      <SelectionFx />
      <HoverFx />
      <SkuHighlight />
      <Projector />
    </Canvas>
  );
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
