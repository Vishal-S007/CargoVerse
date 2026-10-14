// Procedural 3D models for vehicles, cargo and props.
import { forwardRef, useMemo } from 'react';
import * as THREE from 'three';
import type { Carrier, PalletLook } from '../data/types';
import { C, mat, trailerLogo, CARRIER_STYLE, lookColors, containerTexture } from './materials';

type V3 = [number, number, number];

export function Box({ p, s, c, shadow = true, m }: { p: V3; s: V3; c?: string; shadow?: boolean; m?: THREE.Material }) {
  return (
    <mesh position={p} castShadow={shadow} receiveShadow material={m ?? mat(c ?? '#ffffff')}>
      <boxGeometry args={s} />
    </mesh>
  );
}

function Wheel({ p, r = 0.52, w = 0.36 }: { p: V3; r?: number; w?: number }) {
  return (
    <mesh position={p} rotation={[Math.PI / 2, 0, 0]} castShadow material={mat(C.tire, { rough: 0.9 })}>
      <cylinderGeometry args={[r, r, w, 14]} />
    </mesh>
  );
}

/** Truck facing +x, origin at the centre of its footprint on the ground. Length ~12. */
export function TruckModel({ carrier }: { carrier: Carrier }) {
  const st = CARRIER_STYLE[carrier];
  const logo = useMemo(() => trailerLogo(carrier), [carrier]);
  const logoMat = useMemo(() => new THREE.MeshBasicMaterial({ map: logo, transparent: true, depthWrite: false }), [logo]);
  return (
    <group>
      {/* chassis */}
      <Box p={[-0.2, 0.8, 0]} s={[11.6, 0.34, 2.2]} c={C.steel} />
      {/* trailer */}
      <Box p={[-1.55, 2.75, 0]} s={[8.9, 3.3, 2.6]} c={C.white} />
      <Box p={[-1.55, 1.45, 0]} s={[8.92, 0.75, 2.64]} c={st.stripe} shadow={false} />
      <Box p={[-1.55, 4.43, 0]} s={[8.95, 0.08, 2.64]} c={C.wallGrey} shadow={false} />
      {/* rear doors frame */}
      <Box p={[-6.02, 2.75, 0]} s={[0.06, 3.3, 2.5]} c={C.wallGrey} shadow={false} />
      {/* logos */}
      <mesh position={[-1.4, 3.05, 1.311]} material={logoMat}>
        <planeGeometry args={[5.6, 1.75]} />
      </mesh>
      <mesh position={[-1.4, 3.05, -1.311]} rotation={[0, Math.PI, 0]} material={logoMat}>
        <planeGeometry args={[5.6, 1.75]} />
      </mesh>
      {/* cab */}
      <Box p={[4.5, 2.25, 0]} s={[2.7, 2.6, 2.5]} c={st.cab} />
      <Box p={[4.25, 3.75, 0]} s={[2.1, 0.45, 2.3]} c={st.cab} />
      <Box p={[5.87, 2.95, 0]} s={[0.05, 1.05, 2.2]} c={C.glass} shadow={false} />
      <Box p={[4.7, 2.95, 1.26]} s={[1.0, 0.85, 0.03]} c={C.glass} shadow={false} />
      <Box p={[4.7, 2.95, -1.26]} s={[1.0, 0.85, 0.03]} c={C.glass} shadow={false} />
      <Box p={[5.9, 1.25, 0]} s={[0.22, 0.45, 2.5]} c={C.steel} />
      <Box p={[5.98, 1.75, 0.85]} s={[0.04, 0.22, 0.45]} c="#fff6d6" shadow={false} />
      <Box p={[5.98, 1.75, -0.85]} s={[0.04, 0.22, 0.45]} c="#fff6d6" shadow={false} />
      {carrier !== 'WareTrack' && <Box p={[5.0, 2.05, 0]} s={[1.75, 0.18, 2.52]} c={st.stripe} shadow={false} />}
      {/* wheels */}
      {[4.6, -3.2, -4.4].map((x) => (
        <group key={x}>
          <Wheel p={[x, 0.52, 1.12]} />
          <Wheel p={[x, 0.52, -1.12]} />
        </group>
      ))}
    </group>
  );
}

/** Pallet with load, origin at the base centre. ~1.2 x 1.2. */
export function PalletModel({ look, layers = 2 }: { look: PalletLook; layers?: number }) {
  const { main, dark } = lookColors(look);
  const items: JSX.Element[] = [];
  if (look === 'white') {
    items.push(<Box key="w" p={[0, 0.16 + layers * 0.3, 0]} s={[1.12, layers * 0.6, 1.12]} c={main} />);
    items.push(<Box key="b" p={[0, 0.16 + layers * 0.6 + 0.02, 0]} s={[1.0, 0.04, 1.0]} c={dark} shadow={false} />);
  } else {
    for (let l = 0; l < layers; l++) {
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
          items.push(
            <Box key={`${l}-${i}-${j}`} p={[(i - 0.5) * 0.56, 0.16 + 0.27 + l * 0.54, (j - 0.5) * 0.56]} s={[0.53, 0.52, 0.53]} c={(i + j + l) % 2 ? main : dark} />,
          );
        }
      }
      if (look === 'cardboard') {
        items.push(<Box key={`t${l}`} p={[0, 0.16 + 0.535 + l * 0.54, 0]} s={[1.1, 0.012, 0.12]} c={C.cardboardDark} shadow={false} />);
      }
    }
  }
  return (
    <group>
      <Box p={[0, 0.07, 0]} s={[1.2, 0.14, 1.2]} c={C.wood} />
      {items}
    </group>
  );
}

interface ForkliftProps { carrying: PalletLook | null; forkHeight: number }
/** Forklift facing +x. Forks reach to x≈2.4; carried pallet sits at x=1.75. */
export const ForkliftModel = forwardRef<THREE.Group, ForkliftProps>(function ForkliftModel({ carrying, forkHeight }, liftRef) {
  return (
    <group>
      <Box p={[-0.1, 0.75, 0]} s={[1.7, 0.9, 1.2]} c={C.yellow} />
      <Box p={[-0.95, 0.85, 0]} s={[0.4, 1.0, 1.15]} c={C.yellowDark} />
      <Box p={[0.35, 1.25, 0]} s={[0.6, 0.12, 1.1]} c={C.steel} shadow={false} />
      {/* overhead guard */}
      {[[-0.6, 0.5], [-0.6, -0.5], [0.55, 0.5], [0.55, -0.5]].map(([x, z]) => (
        <Box key={`${x}${z}`} p={[x, 1.85, z]} s={[0.08, 1.3, 0.08]} c={C.steel} />
      ))}
      <Box p={[-0.02, 2.52, 0]} s={[1.3, 0.08, 1.12]} c={C.steel} />
      {/* operator */}
      <mesh position={[-0.2, 1.62, 0]} castShadow material={mat('#f08a24')}>
        <cylinderGeometry args={[0.22, 0.25, 0.65, 10]} />
      </mesh>
      <mesh position={[-0.2, 2.1, 0]} castShadow material={mat('#e7b38c')}>
        <sphereGeometry args={[0.17, 10, 8]} />
      </mesh>
      <mesh position={[-0.2, 2.2, 0]} material={mat(C.yellow)}>
        <sphereGeometry args={[0.18, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2]} />
      </mesh>
      {/* mast */}
      <Box p={[0.92, 1.4, 0.36]} s={[0.12, 2.5, 0.12]} c={C.steelLight} />
      <Box p={[0.92, 1.4, -0.36]} s={[0.12, 2.5, 0.12]} c={C.steelLight} />
      <Box p={[0.92, 2.6, 0]} s={[0.12, 0.12, 0.84]} c={C.steelLight} />
      {/* lifting carriage */}
      <group ref={liftRef} position={[0, forkHeight, 0]}>
        <Box p={[1.0, 0.35, 0]} s={[0.08, 0.7, 0.9]} c={C.steel} />
        <Box p={[1.72, 0.03, 0.3]} s={[1.4, 0.06, 0.14]} c={C.steelLight} />
        <Box p={[1.72, 0.03, -0.3]} s={[1.4, 0.06, 0.14]} c={C.steelLight} />
        {carrying && (
          <group position={[1.75, 0.06, 0]}>
            <PalletModel look={carrying} layers={2} />
          </group>
        )}
      </group>
      {/* wheels */}
      <Wheel p={[0.55, 0.3, 0.58]} r={0.3} w={0.22} />
      <Wheel p={[0.55, 0.3, -0.58]} r={0.3} w={0.22} />
      <Wheel p={[-0.7, 0.26, 0.55]} r={0.26} w={0.2} />
      <Wheel p={[-0.7, 0.26, -0.55]} r={0.26} w={0.2} />
    </group>
  );
});

export function Pin({ y = 3.4 }: { y?: number }) {
  return (
    <group position={[0, y, 0]}>
      <mesh position={[0, 1.55, 0]} castShadow material={mat(C.blue, { rough: 0.5 })}>
        <sphereGeometry args={[0.72, 18, 14]} />
      </mesh>
      <mesh position={[0, 0.75, 0]} rotation={[Math.PI, 0, 0]} castShadow material={mat(C.blue, { rough: 0.5 })}>
        <coneGeometry args={[0.6, 1.4, 18]} />
      </mesh>
      <mesh position={[0, 1.6, 0]} material={mat('#ffffff', { rough: 0.4 })}>
        <sphereGeometry args={[0.3, 12, 10]} />
      </mesh>
    </group>
  );
}

export function Tree({ s = 1 }: { s?: number }) {
  return (
    <group scale={s}>
      <mesh position={[0, 0.9, 0]} castShadow material={mat(C.trunk)}>
        <cylinderGeometry args={[0.18, 0.24, 1.8, 8]} />
      </mesh>
      <mesh position={[0, 3.0, 0]} castShadow material={mat(C.leaf, { rough: 0.9 })}>
        <sphereGeometry args={[1.55, 16, 12]} />
      </mesh>
      <mesh position={[0.5, 2.4, 0.4]} castShadow material={mat(C.leafDark, { rough: 0.9 })}>
        <sphereGeometry args={[0.9, 12, 10]} />
      </mesh>
    </group>
  );
}

export function Rack() {
  const levels = [0.2, 2.2, 4.2];
  return (
    <group>
      {[[-2.6, -0.6], [-2.6, 0.6], [0, -0.6], [0, 0.6], [2.6, -0.6], [2.6, 0.6]].map(([x, z]) => (
        <Box key={`${x}${z}`} p={[x, 3.1, z]} s={[0.14, 6.2, 0.14]} c={C.blue} />
      ))}
      {levels.map((y) => (
        <group key={y}>
          <Box p={[0, y + 0.05, 0.6]} s={[5.4, 0.14, 0.12]} c={C.blueDark} />
          <Box p={[0, y + 0.05, -0.6]} s={[5.4, 0.14, 0.12]} c={C.blueDark} />
          <group position={[-1.3, y + 0.12, 0]}><PalletModel look="cardboard" layers={y > 3 ? 1 : 2} /></group>
          <group position={[1.3, y + 0.12, 0]}><PalletModel look="cardboard" layers={2} /></group>
        </group>
      ))}
    </group>
  );
}

export function CrateStack() {
  const cells: V3[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) if (!(k === 1 && i === 2)) cells.push([i * 1.0, 0.45 + k * 0.85, j * 1.0]);
  return (
    <group>
      <Box p={[1.0, 0.07, 0.5]} s={[3.2, 0.14, 2.2]} c={C.wood} />
      {cells.map((p, n) => <Box key={n} p={[p[0], p[1] + 0.1, p[2]]} s={[0.92, 0.8, 0.92]} c={n % 3 ? C.crate : C.crateDark} />)}
    </group>
  );
}

export function ShippingContainer({ color }: { color: string }) {
  const tex = useMemo(() => {
    const t = containerTexture(color).clone();
    t.repeat.set(3, 1);
    t.needsUpdate = true;
    return t;
  }, [color]);
  const m = useMemo(() => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }), [tex]);
  return (
    <mesh position={[0, 1.4, 0]} castShadow receiveShadow material={m}>
      <boxGeometry args={[12, 2.8, 2.6]} />
    </mesh>
  );
}

export function ChargerUnit({ active }: { active: boolean }) {
  return (
    <group>
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={mat('#bfe8cf', { opacity: active ? 0.8 : 0.55 })}>
        <planeGeometry args={[3.0, 3.6]} />
      </mesh>
      <Box p={[2.0, 0.75, 0]} s={[0.55, 1.5, 0.9]} c={C.white} />
      <Box p={[1.71, 1.05, 0]} s={[0.03, 0.35, 0.5]} c={active ? '#36c06a' : '#9aa4b8'} shadow={false} />
    </group>
  );
}
