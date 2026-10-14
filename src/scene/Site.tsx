// Static site geometry for a facility: ground, roads, yard markings, building, props.
import { useMemo } from 'react';
import * as THREE from 'three';
import type { FacilityLayout } from '../data/layouts';
import { FENCE_Z, LANE_Z, ROAD_Z, ROAD_HALF, CORRIDOR_Z } from '../data/layouts';
import { C, mat, roofLogo, wallSign, glassTexture } from './materials';
import { Box, PalletModel, Tree, Rack, CrateStack, ShippingContainer } from './models';

function Flat({ x, z, w, d, color, y = 0.02 }: { x: number; z: number; w: number; d: number; color: string; y?: number }) {
  return (
    <mesh position={[x, y, z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={mat(color, { rough: 1 })}>
      <planeGeometry args={[w, d]} />
    </mesh>
  );
}

function Ground({ L }: { L: FacilityLayout }) {
  // the street, avenues and the rest of the park are drawn by the park scene
  const yardW = L.yard.x1 - L.yard.x0;
  const yardD = FENCE_Z - L.yard.z0;
  return (
    <group>
      <Flat x={(L.yard.x0 + L.yard.x1) / 2} z={(L.yard.z0 + FENCE_Z) / 2} w={yardW} d={yardD} color={C.yard} y={0.01} />
      {/* gate aprons from the fence to the street */}
      <Flat x={L.gateX} z={(FENCE_Z + ROAD_Z - ROAD_HALF) / 2} w={12} d={ROAD_Z - ROAD_HALF - FENCE_Z + 0.6} color={C.road} y={0.038} />
      <Flat x={L.exitX} z={(FENCE_Z + ROAD_Z - ROAD_HALF) / 2} w={12} d={ROAD_Z - ROAD_HALF - FENCE_Z + 0.6} color={C.road} y={0.038} />
    </group>
  );
}

function YardMarkings({ L }: { L: FacilityLayout }) {
  const els: JSX.Element[] = [];
  const Y = C.marking;
  Object.entries(L.doors).forEach(([id, x]) => {
    els.push(<Flat key={`${id}a`} x={x - 2.3} z={7.5} w={0.18} d={13} color={Y} y={0.04} />);
    els.push(<Flat key={`${id}b`} x={x + 2.3} z={7.5} w={0.18} d={13} color={Y} y={0.04} />);
    els.push(<Flat key={`${id}c`} x={x} z={14} w={4.78} d={0.18} color={Y} y={0.04} />);
    els.push(<Flat key={`${id}d`} x={x} z={0.9} w={3.6} d={1.6} color="#b9c2d6" y={0.045} />);
  });
  L.slots.forEach((s, i) => {
    const h = 1.0;
    els.push(<Flat key={`s${i}a`} x={s.x} z={s.z - h} w={2.1} d={0.12} color={Y} y={0.04} />);
    els.push(<Flat key={`s${i}b`} x={s.x} z={s.z + h} w={2.1} d={0.12} color={Y} y={0.04} />);
    els.push(<Flat key={`s${i}c`} x={s.x - h} z={s.z} w={0.12} d={2.1} color={Y} y={0.04} />);
    els.push(<Flat key={`s${i}d`} x={s.x + h} z={s.z} w={0.12} d={2.1} color={Y} y={0.04} />);
  });
  // lane centre dashes and forklift corridor line
  for (let x = L.gateX + 6; x < L.exitX - 4; x += 6) {
    els.push(<Flat key={`l${x}`} x={x} z={LANE_Z + 5} w={2.6} d={0.16} color="#ffffff" y={0.04} />);
  }
  els.push(<Flat key="corr" x={(L.gateX + L.exitX) / 2} z={CORRIDOR_Z + 2.2} w={L.exitX - L.gateX - 10} d={0.14} color={Y} y={0.04} />);
  return <group>{els}</group>;
}

function Fence({ L }: { L: FacilityLayout }) {
  const posts: JSX.Element[] = [];
  const panels: JSX.Element[] = [];
  const panelMat = mat('#c7d1e6', { opacity: 0.45 });
  const gaps = [L.gateX, L.exitX];
  const blocked = (x: number) => gaps.some((g) => Math.abs(x - g) < 7);
  for (let x = L.yard.x0; x <= L.yard.x1; x += 4) {
    if (blocked(x) || blocked(x + 4)) continue;
    posts.push(<Box key={`p${x}`} p={[x, 1.1, FENCE_Z]} s={[0.12, 2.2, 0.12]} c={C.fence} />);
    if (x + 4 <= L.yard.x1) {
      panels.push(
        <mesh key={`f${x}`} position={[x + 2, 1.1, FENCE_Z]} material={panelMat}>
          <planeGeometry args={[4, 2.0]} />
        </mesh>,
      );
      posts.push(<Box key={`r${x}`} p={[x + 2, 2.15, FENCE_Z]} s={[4, 0.07, 0.07]} c={C.fence} shadow={false} />);
    }
  }
  return <group>{posts}{panels}</group>;
}

function Door({ x, faceZ, kind }: { x: number; faceZ: number; kind: 'dock' | 'small' }) {
  if (kind === 'small') {
    return (
      <group position={[x, 0, faceZ]}>
        <Box p={[0, 1.7, 0.06]} s={[2.9, 3.4, 0.12]} c={C.wallGrey} shadow={false} />
        <Box p={[0, 2.1, 0.13]} s={[2.5, 2.6, 0.04]} c={C.rollDoor} shadow={false} />
        <Box p={[0, 0.4, 0.13]} s={[2.5, 0.8, 0.04]} c={C.doorDark} shadow={false} />
      </group>
    );
  }
  return (
    <group position={[x, 0, faceZ]}>
      <Box p={[0, 2.3, 0.04]} s={[3.9, 4.6, 0.06]} c={C.doorDark} shadow={false} />
      <Box p={[0, 4.15, 0.09]} s={[3.9, 0.7, 0.05]} c={C.rollDoor} shadow={false} />
      <Box p={[-2.1, 2.4, 0.2]} s={[0.36, 4.8, 0.4]} c={C.blue} />
      <Box p={[2.1, 2.4, 0.2]} s={[0.36, 4.8, 0.4]} c={C.blue} />
      <Box p={[0, 4.75, 0.2]} s={[4.56, 0.36, 0.4]} c={C.blue} />
      <Box p={[-1.55, 0.7, 0.35]} s={[0.35, 0.5, 0.3]} c={C.steel} />
      <Box p={[1.55, 0.7, 0.35]} s={[0.35, 0.5, 0.3]} c={C.steel} />
      <group position={[0, 1.0, 0.2]} scale={[1.5, 1.4, 0.3]}>
        <PalletModel look="cardboard" layers={2} />
      </group>
    </group>
  );
}

function gable(depth: number, rise: number): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.7, 0);
  s.lineTo(depth + 0.7, 0);
  s.lineTo(depth / 2, rise);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
}

function GableRoof({ x0, x1, zFront, depth, h, rise }: { x0: number; x1: number; zFront: number; depth: number; h: number; rise: number }) {
  const geo = useMemo(() => gable(depth, rise), [depth, rise]);
  return (
    <mesh geometry={geo} position={[x0 - 0.7, h, zFront]} rotation={[0, Math.PI / 2, 0]} scale={[1, 1, x1 - x0 + 1.4]} castShadow receiveShadow
      material={[mat('#f2f5fb'), mat(C.blueRoof, { rough: 0.7 })]} />
  );
}

function RoofDecal({ cx, zFront, depth, h, rise, text }: { cx: number; zFront: number; depth: number; h: number; rise: number; text: string }) {
  const tex = useMemo(() => roofLogo(text), [text]);
  const theta = Math.atan2(rise, depth / 2 + 0.7);
  const m = useMemo(() => new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }), [tex]);
  const zMid = zFront - (depth / 2 + 0.7) / 2;
  const yMid = h + rise / 2;
  return (
    <mesh position={[cx, yMid + 0.08 * Math.cos(theta), zMid + 0.08 * Math.sin(theta)]} rotation={[-(Math.PI / 2 - theta), 0, 0]} material={m}>
      <planeGeometry args={[6, 6]} />
    </mesh>
  );
}

function Sign({ p, rot = 0, text, sub, w = 9 }: { p: [number, number, number]; rot?: number; text: string; sub: string; w?: number }) {
  const tex = useMemo(() => wallSign(text, sub), [text, sub]);
  const m = useMemo(() => new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }), [tex]);
  return (
    <mesh position={p} rotation={[0, rot, 0]} material={m}>
      <planeGeometry args={[w, w * 0.3125]} />
    </mesh>
  );
}

function Building({ L, label }: { L: FacilityLayout; label: string }) {
  const { x0, x1, depth, height: h } = L.building;
  const w = x1 - x0;
  const cx = (x0 + x1) / 2;
  const parts: JSX.Element[] = [];
  let faceZ = 0.02;

  if (L.style === 'riverside') {
    parts.push(<Box key="walls" p={[cx, h / 2, -depth / 2]} s={[w, h, depth]} c={C.blue} />);
    parts.push(<Box key="band" p={[cx, 2.9, 0.1]} s={[w - 0.6, 5.8, 0.2]} c={C.white} />);
    parts.push(<Box key="bandside" p={[x1 + 0.1, 2.9, -depth / 2]} s={[0.2, 5.8, depth - 0.6]} c={C.white} />);
    parts.push(<GableRoof key="roof" x0={x0} x1={x1} zFront={0} depth={depth} h={h} rise={3.6} />);
    parts.push(<RoofDecal key="logo" cx={cx + 6} zFront={0} depth={depth} h={h} rise={3.6} text={label} />);
    faceZ = 0.22;
    if (L.annex) {
      const a = L.annex;
      parts.push(<Box key="aw" p={[(a.x0 + a.x1) / 2, a.height / 2, a.z1 - a.depth / 2]} s={[a.x1 - a.x0, a.height, a.depth]} c={C.blue} />);
      parts.push(<GableRoof key="ar" x0={a.x0} x1={a.x1} zFront={a.z1} depth={a.depth} h={a.height} rise={3.2} />);
      parts.push(<Door key="ad" x={(a.x0 + a.x1) / 2} faceZ={a.z1 + 0.02} kind="dock" />);
    }
  } else if (L.style === 'southfield') {
    parts.push(<Box key="walls" p={[cx, h / 2, -depth / 2]} s={[w, h, depth]} c={C.white} />);
    parts.push(<Box key="fascia" p={[cx, h - 0.35, 0.12]} s={[w + 0.3, 0.7, 0.3]} c={C.blue} />);
    parts.push(<Box key="fasciaE" p={[x1 + 0.12, h - 0.35, -depth / 2]} s={[0.3, 0.7, depth]} c={C.blue} />);
    const doors = Object.values(L.doors);
    const pil = new Set<number>([x0 + 0.3, x1 - 0.3]);
    doors.forEach((d) => { pil.add(d - 7); pil.add(d + 7); });
    [...pil].filter((x) => x >= x0 && x <= x1).forEach((x) => parts.push(<Box key={`pl${x}`} p={[x, h / 2, 0.15]} s={[0.6, h, 0.3]} c={C.blue} />));
    const N = Math.max(4, Math.round(w / 12));
    const T = w / N;
    const toothH = 4.6;
    for (let i = 0; i < N; i++) parts.push(<SawTooth key={`t${i}`} x={x0 + i * T} T={T} H={toothH} depth={depth} h={h} />);
    parts.push(<Sign key="sign" p={[x1 - 9, h - 3.2, 0.32]} text="CargoVerse" sub="Southfield Cross-Dock" />);
    parts.push(<Sign key="signE" p={[x1 + 0.32, h - 3.2, -depth / 2]} rot={Math.PI / 2} text="CargoVerse" sub="WH-04" w={10} />);
  } else {
    parts.push(<Box key="walls" p={[cx, h / 2, -depth / 2]} s={[w, h, depth]} c={C.white} />);
    parts.push(<Box key="band" p={[cx, h - 1.2, 0.08]} s={[w, 0.9, 0.16]} c={C.blue} />);
    parts.push(<Box key="bandE" p={[x1 + 0.08, h - 1.2, -depth / 2]} s={[0.16, 0.9, depth]} c={C.blue} />);
    parts.push(<Box key="roof" p={[cx, h + 0.05, -depth / 2]} s={[w, 0.1, depth]} c="#e4e9f3" />);
    parts.push(<Box key="parF" p={[cx, h + 0.45, 0]} s={[w, 0.8, 0.35]} c={C.blue} />);
    parts.push(<Box key="parB" p={[cx, h + 0.45, -depth]} s={[w, 0.8, 0.35]} c={C.blue} />);
    parts.push(<Box key="parE" p={[x1, h + 0.45, -depth / 2]} s={[0.35, 0.8, depth]} c={C.blue} />);
    for (let i = 0; i < 4; i++) parts.push(<Box key={`sky${i}`} p={[x0 + 10 + i * 20, h + 0.2, -depth / 2]} s={[10, 0.2, 2.2]} c="#7f9ff0" shadow={false} />);
    for (let i = 0; i < 3; i++) parts.push(<Box key={`hv${i}`} p={[x0 + 18 + i * 24, h + 1.0, -depth * 0.72]} s={[3.4, 1.8, 2.6]} c="#d5dbe7" />);
    parts.push(<Sign key="sign" p={[x0 + 14, h - 3.4, 0.2]} text="Northgate DC" sub="WH-02 · CargoVerse" w={11} />);
    if (L.annex) {
      const a = L.annex;
      parts.push(<GlassBlock key="glass" x0={a.x0} x1={a.x1} depth={a.depth} h={a.height} />);
    }
  }

  const doors = Object.values(L.doors).map((x) => <Door key={`d${x}`} x={x} faceZ={faceZ} kind="dock" />);
  const extra = L.extraDoors.map((x) => <Door key={`e${x}`} x={x} faceZ={faceZ} kind="dock" />);
  const small = Object.values(L.doors).map((x) => <Door key={`s${x}`} x={x + L.storeOffset} faceZ={faceZ} kind="small" />);
  return <group>{parts}{doors}{extra}{small}</group>;
}

function SawTooth({ x, T, H, depth, h }: { x: number; T: number; H: number; depth: number; h: number }) {
  const geo = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(0, 0); s.lineTo(T, 0); s.lineTo(T, H); s.closePath();
    return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
  }, [T, H, depth]);
  return (
    <group>
      <mesh geometry={geo} position={[x, h, -depth]} castShadow receiveShadow material={[mat('#eef1f7'), mat(C.blueRoof, { rough: 0.7 })]} />
      <mesh position={[x + T + 0.03, h + H / 2, -depth / 2]} rotation={[0, Math.PI / 2, 0]} material={mat('#d9e1f1', { rough: 0.5 })}>
        <planeGeometry args={[depth, H]} />
      </mesh>
    </group>
  );
}

function GlassBlock({ x0, x1, depth, h }: { x0: number; x1: number; depth: number; h: number }) {
  const m = useMemo(() => {
    const t = glassTexture().clone();
    t.repeat.set((x1 - x0) / 4, h / 4);
    t.needsUpdate = true;
    const t2 = glassTexture().clone();
    t2.repeat.set(depth / 4, h / 4);
    t2.needsUpdate = true;
    const front = new THREE.MeshStandardMaterial({ map: t, roughness: 0.3, metalness: 0.1 });
    const side = new THREE.MeshStandardMaterial({ map: t2, roughness: 0.3, metalness: 0.1 });
    const top = mat(C.blue);
    return [side, side, top, top, front, front];
  }, [x0, x1, depth, h]);
  return (
    <mesh position={[(x0 + x1) / 2, h / 2, -depth / 2]} castShadow receiveShadow material={m}>
      <boxGeometry args={[x1 - x0, h, depth]} />
    </mesh>
  );
}

export function Site({ L, label }: { L: FacilityLayout; label: string }) {
  return (
    <group>
      <Ground L={L} />
      <YardMarkings L={L} />
      <Fence L={L} />
      <Building L={L} label={label} />
      {L.trees.map((t, i) => (
        <group key={`tr${i}`} position={[t.x, 0, t.z]}><Tree s={1 + ((i * 37) % 5) / 10} /></group>
      ))}
      {L.decoPallets.map((p, i) => (
        <group key={`dp${i}`} position={[p.x, 0, p.z]} rotation={[0, (i % 3) * 0.2, 0]} scale={1.45}><PalletModel look={p.look} layers={p.layers} /></group>
      ))}
      {L.racks.map((r, i) => <group key={`rk${i}`} position={[r.x, 0, r.z]}><Rack /></group>)}
      {L.crateStacks.map((c, i) => <group key={`cs${i}`} position={[c.x, 0, c.z]} rotation={[0, c.rot, 0]}><CrateStack /></group>)}
      {L.shippingContainers.map((c, i) => (
        <group key={`sc${i}`} position={[c.x, 0, c.z]} rotation={[0, c.rot, 0]}><ShippingContainer color={c.color} /></group>
      ))}
    </group>
  );
}
