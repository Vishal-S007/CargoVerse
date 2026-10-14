// The working container terminal (quay, cranes, stacks, ships) and the town's
// delivery vans. Everything moving here is read from WorldState.port / .retail,
// which the server simulates and stores in Oracle.
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getWorld, useApp } from '../store';
import {
  TERMINAL, QUAY_Z, MOOR_Z, SHIP_LENGTH, SHIP_BEAM, YARD_BLOCKS, YARD_CAPACITY, yardSlot, CRANE_DEFS, BERTH_DEFS, CRANE_CYCLE_S,
  storeBuilding,
} from '../data/city';
import { PORT_IN_X, PORT_OUT_X, PORT_GATE_Z, PORT_AISLE_IN_Z, PORT_AISLE_OUT_Z, HWY_Z, HWY_HALF } from '../data/park';
import { C, mat, containerTexture, companySign, groundText } from './materials';
import { Box } from './models';
import { useSelectHandlers, follow } from './Dynamic';

type V3 = [number, number, number];
const BOX_COLORS = ['#d9480f', '#1971c2', '#2b8a3e', '#e67700', '#5f3dc4', '#1d3557', '#c92a2a', '#0b7285', '#f08c00', '#495057'];
export const boxColor = (no: string): string => {
  let h = 0;
  for (let i = 0; i < no.length; i++) h = (h * 31 + no.charCodeAt(i)) >>> 0;
  return BOX_COLORS[h % BOX_COLORS.length];
};

function Flat({ x, z, w, d, color, y = 0.02 }: { x: number; z: number; w: number; d: number; color: string; y?: number }) {
  return (
    <mesh position={[x, y, z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={mat(color, { rough: 1 })}>
      <planeGeometry args={[w, d]} />
    </mesh>
  );
}

function useBoxMaterial(): THREE.MeshStandardMaterial {
  return useMemo(() => {
    const t = containerTexture('#ffffff').clone();
    t.repeat.set(3, 1);
    t.needsUpdate = true;
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.8 });
  }, []);
}

// ---------------------------------------------------------------- static terminal layout
function TerminalGround() {
  const t = TERMINAL;
  const x0 = t.x - t.w / 2, x1 = t.x + t.w / 2;
  const imp = useMemo(() => groundText('IMPORT STACK', '#ffffff'), []);
  const exp = useMemo(() => groundText('EXPORT STACK', '#ffffff'), []);
  const signTex = useMemo(() => companySign('Port Newark', 'Container terminal · gate', '#0b7285'), []);
  const signMat = useMemo(() => new THREE.MeshBasicMaterial({ map: signTex, transparent: true, depthWrite: false }), [signTex]);
  const label = (tex: THREE.Texture) => new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const els: JSX.Element[] = [];
  els.push(<Flat key="apron" x={t.x} z={t.z} w={t.w} d={t.d} color="#cfd5e1" y={0.021} />);
  // quay wall and fenders along the water
  els.push(<Box key="quay" p={[t.x, -0.6, QUAY_Z + 0.9]} s={[t.w, 2.6, 1.8]} c="#aab3c4" shadow={false} />);
  for (let x = x0 + 6; x < x1; x += 10) els.push(<Box key={`fender${x}`} p={[x, 0.2, QUAY_Z + 1.9]} s={[1.4, 1.2, 0.5]} c="#2b2f3a" shadow={false} />);
  for (let x = x0 + 4; x < x1; x += 14) els.push(<mesh key={`bollard${x}`} position={[x, 0.5, QUAY_Z + 0.6]} material={mat('#2c3242')}><cylinderGeometry args={[0.35, 0.45, 1, 10]} /></mesh>);
  // crane rails and the apron where boxes are set down
  for (const rz of [QUAY_Z - 12, QUAY_Z - 1.5]) els.push(<Flat key={`rail${rz}`} x={t.x} z={rz} w={t.w} d={0.5} color="#7c8597" y={0.04} />);
  els.push(<Flat key="apronlane" x={t.x} z={QUAY_Z - 6.5} w={t.w} d={5} color="#c3cad8" y={0.03} />);
  // stacking blocks
  for (const [k, b] of Object.entries(YARD_BLOCKS)) {
    els.push(<Flat key={`blk${k}`} x={b.x} z={b.z} w={b.w + 2} d={b.d + 2} color="#bfc7d6" y={0.03} />);
    els.push(
      <mesh key={`lbl${k}`} position={[b.x, 0.06, b.z + b.d / 2 + 3]} rotation={[-Math.PI / 2, 0, 0]} material={label(k === 'IMPORT' ? imp : exp)}>
        <planeGeometry args={[22, 3]} />
      </mesh>,
    );
  }
  // truck aisles
  els.push(<Flat key="aisle" x={(PORT_OUT_X + x0) / 2 + 4} z={(PORT_AISLE_IN_Z + PORT_AISLE_OUT_Z) / 2} w={PORT_OUT_X - x0 - 8} d={12} color="#d6dbe6" y={0.032} />);
  for (let x = x0 + 12; x < PORT_OUT_X - 8; x += 9) els.push(<Flat key={`ad${x}`} x={x} z={(PORT_AISLE_IN_Z + PORT_AISLE_OUT_Z) / 2} w={4} d={0.3} color={C.roadLine} y={0.05} />);
  // access road from the highway to the gate
  const hz1 = HWY_Z + HWY_HALF;
  els.push(<Flat key="access" x={(PORT_IN_X + PORT_OUT_X) / 2} z={(hz1 + t.z - t.d / 2) / 2 + 1} w={18} d={t.z - t.d / 2 - hz1 + 4} color={C.road} y={0.031} />);
  // gate canopy with lanes in and out
  const gx = (PORT_IN_X + PORT_OUT_X) / 2;
  els.push(<Box key="canopy" p={[gx, 6, PORT_GATE_Z]} s={[22, 0.6, 7]} c="#0b7285" />);
  for (const px of [gx - 10.5, gx, gx + 10.5]) els.push(<Box key={`cp${px}`} p={[px, 3, PORT_GATE_Z]} s={[0.6, 6, 0.6]} c="#dde3ed" />);
  els.push(<Box key="booth" p={[gx, 1.4, PORT_GATE_Z]} s={[1.6, 2.8, 2.4]} c={C.white} />);
  els.push(<mesh key="gsign" position={[gx, 7.8, PORT_GATE_Z - 3.6]} rotation={[0, Math.PI, 0]} material={signMat}><planeGeometry args={[16, 4]} /></mesh>);
  els.push(<mesh key="gsign2" position={[gx, 7.8, PORT_GATE_Z + 3.6]} material={signMat}><planeGeometry args={[16, 4]} /></mesh>);
  // terminal office and reefer rack along the north edge
  els.push(<Box key="office" p={[x0 + 14, 5, t.z - t.d / 2 + 8]} s={[20, 10, 10]} c="#f1f4f9" />);
  els.push(<Box key="officeband" p={[x0 + 14, 8.5, t.z - t.d / 2 + 13.05]} s={[20, 1.4, 0.1]} c="#0b7285" shadow={false} />);
  els.push(<Box key="ctower" p={[x0 + 30, 9, t.z - t.d / 2 + 7]} s={[5, 18, 5]} c="#e3e8f1" />);
  els.push(<Box key="ctowercab" p={[x0 + 30, 19, t.z - t.d / 2 + 7]} s={[7, 3, 7]} c={C.glass} />);
  // flood-light masts
  for (const lx of [x0 + 50, t.x, x1 - 50]) {
    els.push(<Box key={`mast${lx}`} p={[lx, 12, t.z - 2]} s={[0.5, 24, 0.5]} c="#9aa4b8" />);
    els.push(<Box key={`lamp${lx}`} p={[lx, 24.2, t.z - 2]} s={[3, 0.6, 1.2]} c="#e9edf5" shadow={false} />);
  }
  return <group>{els}</group>;
}

// ---------------------------------------------------------------- stacks
function YardStacks() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const material = useBoxMaterial();
  const sig = useRef('');
  useFrame(() => {
    const m = ref.current;
    const P = getWorld().port;
    if (!m || !P) return;
    const key = `${P.importStack.length}:${P.importStack[0] ?? ''}:${P.exportStack.length}:${P.exportStack[0] ?? ''}`;
    if (key === sig.current) return;
    sig.current = key;
    const mtx = new THREE.Matrix4();
    const col = new THREE.Color();
    let n = 0;
    const put = (block: 'IMPORT' | 'EXPORT', list: string[]) => {
      list.slice(0, YARD_CAPACITY).forEach((no, i) => {
        const p = yardSlot(block, i);
        mtx.makeTranslation(p.x, p.y, p.z);
        m.setMatrixAt(n, mtx);
        m.setColorAt(n, col.set(boxColor(no)));
        n++;
      });
    };
    put('IMPORT', P.importStack);
    put('EXPORT', P.exportStack);
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, YARD_CAPACITY * 2]} castShadow receiveShadow material={material} frustumCulled={false}>
      <boxGeometry args={[12, 2.6, 2.6]} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------- ships
function hullGeometry(): THREE.ExtrudeGeometry {
  const L = SHIP_LENGTH / 2, B = SHIP_BEAM / 2;
  const s = new THREE.Shape();
  s.moveTo(-L, -B);
  s.lineTo(L - 12, -B);
  s.quadraticCurveTo(L, -B * 0.6, L + 1, 0);
  s.quadraticCurveTo(L, B * 0.6, L - 12, B);
  s.lineTo(-L, B);
  s.lineTo(-L, -B);
  const g = new THREE.ExtrudeGeometry(s, { depth: 5.2, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -1.6, 0);
  return g;
}

const DECK_BAYS = 5;
const DECK_ROWS = 4;
const deckSlot = (i: number): V3 => {
  const bay = i % DECK_BAYS;
  const row = Math.floor(i / DECK_BAYS) % DECK_ROWS;
  const tier = Math.floor(i / (DECK_BAYS * DECK_ROWS));
  return [-20 + bay * 12.6, 4.9 + tier * 2.6, -4.5 + row * 3];
};

function Ship({ id }: { id: string }) {
  const g = useRef<THREE.Group>(null);
  const boxes = useRef<THREE.InstancedMesh>(null);
  const init = useRef({ done: false });
  const shown = useRef(-1);
  const v0 = getWorld().port.vessels[id];
  const handlers = useSelectHandlers({ kind: 'vessel', id });
  const hull = useMemo(() => hullGeometry(), []);
  const material = useBoxMaterial();
  const nameTex = useMemo(() => companySign(v0?.name ?? id, v0?.line ?? '', v0?.color ?? '#1d3557'), [v0?.name, v0?.line, v0?.color, id]);
  const nameMat = useMemo(() => new THREE.MeshBasicMaterial({ map: nameTex, transparent: true, depthWrite: false }), [nameTex]);
  useFrame((_, dt) => {
    const v = getWorld().port.vessels[id];
    if (!g.current || !v) return;
    g.current.visible = v.status !== 'AT_SEA';
    follow(g.current, v.pos.x, v.pos.z, v.heading, dt, init.current);
    const aboard = Math.min(v.capacity, v.through + v.importBoxes + v.exportBoxes);
    if (boxes.current && aboard !== shown.current) {
      shown.current = aboard;
      const m = boxes.current;
      const mtx = new THREE.Matrix4();
      const col = new THREE.Color();
      for (let i = 0; i < aboard; i++) {
        const p = deckSlot(i);
        mtx.makeTranslation(p[0], p[1], p[2]);
        m.setMatrixAt(i, mtx);
        m.setColorAt(i, col.set(BOX_COLORS[(i * 7 + id.charCodeAt(5)) % BOX_COLORS.length]));
      }
      m.count = aboard;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  });
  if (!v0) return null;
  const L = SHIP_LENGTH / 2;
  return (
    <group ref={g} {...handlers} name={`vessel-${id}`}>
      <mesh geometry={hull} castShadow receiveShadow material={mat(v0.color, { rough: 0.6 })} />
      {/* waterline stripe and deck */}
      <Box p={[-1, -0.9, 0]} s={[SHIP_LENGTH - 4, 1.2, SHIP_BEAM + 0.08]} c="#a61e1e" shadow={false} />
      <Box p={[-2, 3.62, 0]} s={[SHIP_LENGTH - 12, 0.12, SHIP_BEAM - 1]} c="#c7ced9" shadow={false} />
      {/* accommodation block and bridge at the stern */}
      <Box p={[-L + 6, 8.2, 0]} s={[7, 9, SHIP_BEAM - 2]} c={C.white} />
      <Box p={[-L + 6, 12.9, 0]} s={[8, 1.4, SHIP_BEAM + 2]} c={C.white} />
      <Box p={[-L + 9.55, 11.4, 0]} s={[0.1, 1.2, SHIP_BEAM - 2.5]} c={C.glass} shadow={false} />
      <Box p={[-L + 2, 12, 0]} s={[3, 6, 3]} c={v0.color} />
      <Box p={[-L + 2, 15.2, 0]} s={[3.1, 0.6, 3.1]} c="#1b1f29" shadow={false} />
      {/* name on both sides of the bow */}
      <mesh position={[L - 16, 1.4, SHIP_BEAM / 2 + 0.06]} material={nameMat}><planeGeometry args={[14, 3.5]} /></mesh>
      <mesh position={[L - 16, 1.4, -SHIP_BEAM / 2 - 0.06]} rotation={[0, Math.PI, 0]} material={nameMat}><planeGeometry args={[14, 3.5]} /></mesh>
      <instancedMesh ref={boxes} args={[undefined, undefined, 60]} castShadow material={material} frustumCulled={false}>
        <boxGeometry args={[12, 2.6, 2.6]} />
      </instancedMesh>
    </group>
  );
}

// ---------------------------------------------------------------- quay cranes
/** Spreader path for one move: down to the pick side, up, across, down to the drop side, back. */
const KEYS: [number, 'P' | 'D', number][] = [[0, 'P', 1], [0.15, 'P', 0], [0.25, 'P', 0], [0.38, 'P', 1], [0.5, 'D', 1], [0.6, 'D', 0], [0.65, 'D', 0], [0.78, 'D', 1], [1, 'P', 1]];
function spreader(cycle: number): { side: number; low: number } {
  for (let i = 1; i < KEYS.length; i++) {
    const [t1, s1, h1] = KEYS[i];
    const [t0, s0, h0] = KEYS[i - 1];
    if (cycle <= t1) {
      const k = (cycle - t0) / (t1 - t0 || 1);
      const a = s0 === 'P' ? 0 : 1, b = s1 === 'P' ? 0 : 1;
      return { side: a + (b - a) * k, low: 1 - (h0 + (h1 - h0) * k) };
    }
  }
  return { side: 0, low: 0 };
}

function Crane({ id, berthX, offset }: { id: string; berthX: number; offset: number }) {
  const handlers = useSelectHandlers({ kind: 'crane', id });
  const trolley = useRef<THREE.Group>(null);
  const hoist = useRef<THREE.Group>(null);
  const cargo = useRef<THREE.Mesh>(null);
  const cable = useRef<THREE.Mesh>(null);
  const local = useRef(0);
  const boxMat = useBoxMaterial();
  const H = 26; // boom height
  const zApron = QUAY_Z - 6.5;
  const zShip = MOOR_Z;
  useFrame((_, dt) => {
    const c = getWorld().port?.cranes[id];
    if (!c) return;
    const { control } = useApp.getState();
    const rate = control.paused ? 0 : control.speed;
    let cyc = local.current;
    if (c.phase === 'idle') cyc = 0;
    else {
      cyc = (cyc + (dt * rate) / CRANE_CYCLE_S) % 1;
      let diff = c.cycle - cyc;
      if (diff > 0.5) diff -= 1;
      if (diff < -0.5) diff += 1;
      if (Math.abs(diff) > 0.2) cyc = c.cycle; // resync with the server
    }
    local.current = cyc;
    const discharge = c.phase === 'discharge';
    const s = spreader(cyc);
    // P = pick side: the ship when discharging, the apron when loading
    const pickZ = discharge ? zShip : zApron, dropZ = discharge ? zApron : zShip;
    const z = pickZ + (dropZ - pickZ) * s.side;
    const lowY = (z > QUAY_Z ? 7 : 3.2);
    const y = H - 2 - (H - 2 - lowY) * s.low;
    if (trolley.current) trolley.current.position.z = z;
    if (hoist.current) hoist.current.position.y = y;
    if (cable.current) {
      const len = H - 1 - y;
      cable.current.scale.y = Math.max(0.1, len);
      cable.current.position.y = y + len / 2;
    }
    if (cargo.current) cargo.current.visible = c.phase !== 'idle' && cyc > 0.25 && cyc < 0.65;
  });
  const x = berthX + offset;
  const legs: V3[] = [[-6, 0, QUAY_Z - 12], [6, 0, QUAY_Z - 12], [-6, 0, QUAY_Z - 1.5], [6, 0, QUAY_Z - 1.5]];
  return (
    <group position={[x, 0, 0]} {...handlers} name={`crane-${id}`}>
      {legs.map((p, i) => <Box key={i} p={[p[0], 11, p[2]]} s={[0.9, 22, 0.9]} c="#e03131" />)}
      <Box p={[0, 1, QUAY_Z - 12]} s={[13, 1.2, 1.2]} c="#c92a2a" />
      <Box p={[0, 1, QUAY_Z - 1.5]} s={[13, 1.2, 1.2]} c="#c92a2a" />
      <Box p={[0, 21.5, QUAY_Z - 6.75]} s={[13, 1.2, 12]} c="#c92a2a" />
      {/* machinery house and the boom reaching over the ship */}
      <Box p={[0, 24.2, QUAY_Z - 16]} s={[6, 4, 8]} c="#f1f3f7" />
      <Box p={[-2.2, H, QUAY_Z + 4]} s={[0.8, 1.2, 46]} c="#e03131" />
      <Box p={[2.2, H, QUAY_Z + 4]} s={[0.8, 1.2, 46]} c="#e03131" />
      <Box p={[0, 30, QUAY_Z - 10]} s={[0.6, 8, 0.6]} c="#e03131" />
      <group ref={trolley} position={[0, 0, zApron]}>
        <Box p={[0, H - 0.6, 0]} s={[3, 1.2, 5.4]} c="#343a40" />
        <mesh ref={cable} position={[0, H - 4, 0]} material={mat('#343a40')}><boxGeometry args={[0.12, 1, 0.12]} /></mesh>
        <group ref={hoist} position={[0, H - 6, 0]}>
          <Box p={[0, 1.6, 0]} s={[12.2, 0.4, 2.8]} c="#f6b818" />
          <mesh ref={cargo} position={[0, 0, 0]} castShadow material={boxMat}>
            <boxGeometry args={[12, 2.6, 2.6]} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

// ---------------------------------------------------------------- delivery vans
function VanBody({ box }: { box: boolean }) {
  return box ? (
    <group>
      <Box p={[-0.9, 2.1, 0]} s={[6.4, 3.4, 2.5]} c={C.white} />
      <Box p={[-0.9, 1.0, 0]} s={[6.42, 0.5, 2.52]} c={C.blue} shadow={false} />
      <Box p={[3.2, 1.6, 0]} s={[1.9, 2.4, 2.4]} c={C.blue} />
      <Box p={[4.16, 2.1, 0]} s={[0.05, 1.0, 2.1]} c={C.glass} shadow={false} />
      {[3.2, -2.4, -3.5].map((x) => (
        <group key={x}>
          <mesh position={[x, 0.45, 1.15]} rotation={[Math.PI / 2, 0, 0]} material={mat(C.tire)}><cylinderGeometry args={[0.45, 0.45, 0.3, 12]} /></mesh>
          <mesh position={[x, 0.45, -1.15]} rotation={[Math.PI / 2, 0, 0]} material={mat(C.tire)}><cylinderGeometry args={[0.45, 0.45, 0.3, 12]} /></mesh>
        </group>
      ))}
    </group>
  ) : (
    <group>
      <Box p={[-0.4, 1.45, 0]} s={[4.6, 2.3, 2.1]} c={C.white} />
      <Box p={[-0.4, 1.0, 0]} s={[4.62, 0.4, 2.12]} c={C.blue} shadow={false} />
      <Box p={[2.25, 1.0, 0]} s={[1.1, 1.4, 2.0]} c={C.blue} />
      <Box p={[2.0, 1.85, 0]} s={[0.05, 0.8, 1.8]} c={C.glass} shadow={false} />
      {[[1.8, 1.0], [1.8, -1.0], [-1.7, 1.0], [-1.7, -1.0]].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, 0.4, z]} rotation={[Math.PI / 2, 0, 0]} material={mat(C.tire)}><cylinderGeometry args={[0.4, 0.4, 0.28, 10]} /></mesh>
      ))}
    </group>
  );
}

function Van({ id }: { id: string }) {
  const g = useRef<THREE.Group>(null);
  const init = useRef({ done: false });
  const handlers = useSelectHandlers({ kind: 'van', id });
  const v0 = getWorld().retail?.vans[id];
  useFrame((_, dt) => {
    const v = getWorld().retail?.vans[id];
    if (!g.current || !v) return;
    g.current.visible = v.status !== 'IDLE';
    follow(g.current, v.pos.x, v.pos.z, v.heading, dt, init.current);
  });
  if (!v0) return null;
  return <group ref={g} {...handlers} name={`van-${id}`}><VanBody box={v0.kind === 'BOX_TRUCK'} /></group>;
}

/** Pallet stack on the pavement while a van unloads at a store. */
function UnloadingPallets() {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const R = getWorld().retail;
    if (!g.current || !R) return;
    let i = 0;
    for (const v of Object.values(R.vans)) {
      const child = g.current.children[i++];
      if (!child) break;
      const b = v.storeId ? storeBuilding(v.storeId) : undefined;
      child.visible = v.status === 'UNLOADING' && !!b;
      if (child.visible && b) child.position.set(v.pos.x - Math.cos(v.heading) * 4, 0, v.pos.z - Math.sin(v.heading) * 4 + (b.rotation === 0 ? -2.5 : 2.5));
    }
  });
  const n = Object.keys(getWorld().retail?.vans ?? {}).length;
  return (
    <group ref={g}>
      {Array.from({ length: n }, (_, i) => (
        <group key={i} visible={false}>
          <Box p={[0, 0.15, 0]} s={[1.6, 0.3, 1.6]} c={C.wood} shadow={false} />
          <Box p={[0, 0.85, 0]} s={[1.4, 1.1, 1.4]} c={C.cardboard} />
        </group>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------- the whole port + delivery traffic
export function PortScene() {
  useApp((s) => s.ready);
  const w = getWorld();
  const vessels = Object.keys(w.port?.vessels ?? {});
  const vans = Object.keys(w.retail?.vans ?? {});
  return (
    <group>
      <TerminalGround />
      <YardStacks />
      {CRANE_DEFS.map((c) => <Crane key={c.id} id={c.id} berthX={BERTH_DEFS.find((b) => b.id === c.berthId)!.x} offset={c.offset} />)}
      {vessels.map((id) => <Ship key={id} id={id} />)}
      {vans.map((id) => <Van key={id} id={id} />)}
      <UnloadingPallets />
    </group>
  );
}

export const SHIP_DIMS: [number, number, number] = [SHIP_LENGTH + 2, 16, SHIP_BEAM + 1];
export const CRANE_DIMS: [number, number, number] = [14, 30, 14];
export const VAN_DIMS = { VAN: [5.8, 2.7, 2.2] as [number, number, number], BOX_TRUCK: [8.6, 4, 2.6] as [number, number, number] };
