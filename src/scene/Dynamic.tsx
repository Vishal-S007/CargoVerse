// Moving and state-driven scene objects. Transforms are read from the world
// state every frame; structural changes (cargo, pallets) follow the UI tick.
import { useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import type * as THREE from 'three';
import type { EntityRef, FacilityId, PalletLook } from '../data/types';
import { LAYOUTS } from '../data/layouts';
import { SKUS } from '../data/seed';
import { getWorld, useApp } from '../store';
import { LIFT_TIME } from '../sim/engine';
import { assetsOf } from '../ui/derive';
import { TruckModel, ForkliftModel, PalletModel, Pin, ChargerUnit } from './models';

export function useSelectHandlers(ref: EntityRef) {
  const select = useApp((s) => s.select);
  const setHovered = useApp((s) => s.setHovered);
  const camera = useApp((s) => s.camera);
  return {
    onClick: (e: ThreeEvent<MouseEvent>) => {
      if (e.delta > 6) return;
      e.stopPropagation();
      select(ref);
    },
    onDoubleClick: (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      select(ref);
      camera({ kind: 'focus', ref });
    },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      document.body.style.cursor = 'pointer';
      setHovered(ref);
    },
    onPointerOut: () => {
      document.body.style.cursor = '';
      const h = useApp.getState().hovered;
      if (h && h.kind === ref.kind && h.id === ref.id) setHovered(null);
    },
  };
}

function AssetHit({ id, x, z, size, rotation }: { id: string; x: number; z: number; size: [number, number, number]; rotation: number }) {
  const handlers = useSelectHandlers({ kind: 'asset', id });
  return (
    <mesh position={[x, size[1] / 2, z]} rotation={[0, rotation, 0]} {...handlers} name={`asset-${id}`}>
      <boxGeometry args={size} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

function DoorHit({ id, x }: { id: string; x: number }) {
  const handlers = useSelectHandlers({ kind: 'dock', id });
  return (
    <mesh position={[x, 2.5, 0.5]} {...handlers} name={`door-${id}`}>
      <boxGeometry args={[4.6, 5, 1]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

/**
 * Moves a group towards its target pose. In live mode the server streams poses
 * ~5×/s, so the displayed pose eases toward the latest one; big jumps snap.
 */
export function follow(g: THREE.Group, x: number, z: number, heading: number, dt: number, init: { done: boolean }) {
  const live = useApp.getState().mode === 'live';
  const dx = x - g.position.x, dz = z - g.position.z;
  if (!live || !init.done || dx * dx + dz * dz > 400) {
    g.position.set(x, 0, z);
    g.rotation.y = -heading;
    init.done = true;
    return;
  }
  const k = 1 - Math.exp(-dt * 9);
  g.position.x += dx * k;
  g.position.z += dz * k;
  let dh = -heading - g.rotation.y;
  while (dh > Math.PI) dh -= Math.PI * 2;
  while (dh < -Math.PI) dh += Math.PI * 2;
  g.rotation.y += dh * k;
}

const SEA_BOX_COLORS = ['#d9480f', '#1971c2', '#2b8a3e', '#e67700', '#5f3dc4', '#c92a2a', '#0b7285'];

function TruckObj({ id }: { id: string }) {
  const g = useRef<THREE.Group>(null);
  const box = useRef<THREE.Mesh>(null);
  const init = useRef({ done: false });
  const t0 = getWorld().trucks[id];
  const handlers = useSelectHandlers({ kind: 'truck', id });
  useFrame((_, dt) => {
    const w = getWorld();
    const t = w.trucks[id];
    if (!g.current || !t) return;
    g.current.visible = t.phase !== 'away';
    follow(g.current, t.pos.x, t.pos.z, t.heading, dt, init.current);
    // sea freight: the trailer carries a shipping container to / from the port
    if (box.current) {
      const s = w.shipments[t.shipmentId];
      const show = t.lane === 'SEA' && !!s?.containerNo && t.cargo > 0 && (t.phase === 'en_route' || t.phase === 'leaving' || t.phase === 'at_gate');
      box.current.visible = show;
      if (show && s?.containerNo && box.current.userData.no !== s.containerNo) {
        box.current.userData.no = s.containerNo;
        let h = 0;
        for (const ch of s.containerNo) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        (box.current.material as THREE.MeshStandardMaterial).color.set(SEA_BOX_COLORS[h % SEA_BOX_COLORS.length]);
      }
    }
  });
  if (!t0) return null;
  return (
    <group ref={g} {...handlers} name={`truck-${id}`}>
      <TruckModel carrier={t0.carrier} />
      <mesh ref={box} position={[-1.55, 2.8, 0]} visible={false} castShadow>
        <boxGeometry args={[9.1, 3.25, 2.7]} />
        <meshStandardMaterial color="#1971c2" roughness={0.7} />
      </mesh>
    </group>
  );
}

function ForkliftObj({ id, carrying }: { id: string; carrying: PalletLook | null }) {
  const g = useRef<THREE.Group>(null);
  const lift = useRef<THREE.Group>(null);
  const init = useRef({ done: false });
  const handlers = useSelectHandlers({ kind: 'forklift', id });
  useFrame((_, dt) => {
    const f = getWorld().forklifts[id];
    if (!g.current || !f) return;
    follow(g.current, f.pos.x, f.pos.z, f.heading, dt, init.current);
    if (lift.current) {
      let h = f.palletId ? 0.5 : 0.12;
      const p = Math.max(0, Math.min(1, 1 - f.timer / LIFT_TIME));
      if (f.task === 'lifting') h = 0.12 + 0.38 * p;
      if (f.task === 'dropping') h = 0.5 - 0.38 * p;
      lift.current.position.y = h;
    }
  });
  return (
    <group ref={g} {...handlers} name={`forklift-${id}`}>
      <group scale={1.45}><ForkliftModel ref={lift} carrying={carrying} forkHeight={0.12} /></group>
    </group>
  );
}

function lookOf(palletId: string | null): PalletLook | null {
  if (!palletId) return null;
  const p = getWorld().pallets[palletId];
  return p ? SKUS[p.skuId].look : null;
}

function StagedPallet({ id, x, z, look, featured }: { id: string; x: number; z: number; look: PalletLook; featured: boolean }) {
  const handlers = useSelectHandlers({ kind: 'pallet', id });
  return (
    <group position={[x, 0, z]} {...handlers} name={`pallet-${id}`}>
      <group scale={1.45}><PalletModel look={look} layers={2} /></group>
      {featured && <Pin y={2.2} />}
    </group>
  );
}

function DockPad({ id, x }: { id: string; x: number }) {
  const handlers = useSelectHandlers({ kind: 'dock', id });
  return (
    <mesh position={[x, 0.06, 7.4]} rotation={[-Math.PI / 2, 0, 0]} {...handlers} name={`dock-${id}`}>
      <planeGeometry args={[4.6, 13]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

function ChargerObj({ id, x, z, active }: { id: string; x: number; z: number; active: boolean }) {
  const handlers = useSelectHandlers({ kind: 'charger', id });
  return (
    <group position={[x, 0, z]} {...handlers} name={`charger-${id}`}>
      <ChargerUnit active={active} />
    </group>
  );
}

export function Dynamic({ facilityId }: { facilityId: FacilityId }) {
  useApp((s) => s.tick); // re-render on throttled ticks for structural changes
  const w = getWorld();
  const L = LAYOUTS[facilityId];
  const trucks = Object.values(w.trucks).filter((t) => t.facilityId === facilityId);
  const forks = Object.values(w.forklifts).filter((f) => f.facilityId === facilityId);
  const staged = Object.values(w.pallets).filter((p) => p.facilityId === facilityId && p.slot !== null);
  const docks = Object.values(w.docks).filter((d) => d.facilityId === facilityId);
  return (
    <group>
      {trucks.map((t) => <TruckObj key={t.id} id={t.id} />)}
      {forks.map((f) => <ForkliftObj key={f.id} id={f.id} carrying={lookOf(f.palletId)} />)}
      {staged.map((p) => {
        const s = L.slots[p.slot as number];
        return <StagedPallet key={p.id} id={p.id} x={s.x} z={s.z} look={SKUS[p.skuId].look} featured={p.featured} />;
      })}
      {docks.map((d) => <DockPad key={d.id} id={d.id} x={L.doors[d.id]} />)}
      {docks.map((d) => <DoorHit key={`door-${d.id}`} id={d.id} x={L.doors[d.id]} />)}
      {assetsOf(facilityId).map((a) => <AssetHit key={a.id} id={a.id} x={a.pos.x} z={a.pos.z} size={a.size} rotation={a.rotation} />)}
      {Object.entries(L.chargers).map(([id, pos]) => {
        const f = forks.find((x) => x.chargerId === id);
        return <ChargerObj key={id} id={id} x={pos.x} z={pos.z} active={f?.task === 'charging'} />;
      })}
    </group>
  );
}
