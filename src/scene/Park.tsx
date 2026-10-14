// The logistics park around the CargoVerse sites: highway, avenues and streets,
// neighbouring companies' buildings and plants, the park gates, the container
// terminal where imports come from, and the public traffic on the roads.
// Buildings and vehicles are records from the database (park_buildings, park_vehicles).
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  HWY_Z, HWY_HALF, HWY_X0, HWY_X1, ART_W, ART_E, ART_HALF, ART_Z0, STREETS, STREET_HALF, PARK_GATES,
  TOWN_Z1, MARKET_Z, BAY_Z, SHORE_Z, CENTRAL_X, MARKET_X0, PORT_IN_X, PORT_OUT_X,
  OCEAN_X, CEDAR_X, BEACH_Z0, SEA_Z0, SUB_X0, SUB_X1, MAPLE_X, SUB_STREETS, SUB_Z0, WIL_X0, WIL_X1, BIRCH_X,
  toPark, type ParkBuilding, type ParkVehicle, type GateCode,
} from '../data/park';
import { PortScene } from './Port';
import { Scenery } from './Scenery';
import { People, BeachProps } from './People';
import { storeByBuilding } from '../data/city';
import { getPark, findCompany, vehicleNow, parkTime } from '../data/parkClient';
import { getWorld, useApp } from '../store';
import { C, mat, companySign, roadSign, groundText, windowTexture } from './materials';
import { Box } from './models';
import { useSelectHandlers } from './Dynamic';

type V3 = [number, number, number];

function Flat({ x, z, w, d, color, y = 0.02, rot = 0 }: { x: number; z: number; w: number; d: number; color: string; y?: number; rot?: number }) {
  return (
    <mesh position={[x, y, z]} rotation={[-Math.PI / 2, 0, rot]} receiveShadow material={mat(color, { rough: 1 })}>
      <planeGeometry args={[w, d]} />
    </mesh>
  );
}

function Decal({ tex, x, z, w, d, rot = 0, y = 0.07 }: { tex: THREE.Texture; x: number; z: number; w: number; d: number; rot?: number; y?: number }) {
  const m = useMemo(() => new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }), [tex]);
  return (
    <mesh position={[x, y, z]} rotation={[-Math.PI / 2, 0, rot]} material={m}>
      <planeGeometry args={[w, d]} />
    </mesh>
  );
}

const ROAD = C.road;
const LINE = C.roadLine;
const LAWN = '#dcebdc';
const LAWN2 = '#d3e6d6';
const WATER = '#b9d4f2';

// ---------------------------------------------------------------- roads
function Roads() {
  const els: JSX.Element[] = [];
  const hz0 = HWY_Z - HWY_HALF, hz1 = HWY_Z + HWY_HALF;
  const XL = -1100, XR = 1100;
  // highway: two carriageways with a median
  els.push(<Flat key="hwy" x={0} z={HWY_Z} w={XR - XL} d={HWY_HALF * 2} color={ROAD} y={0.03} />);
  els.push(<Flat key="hwy-e0" x={0} z={hz0 + 0.6} w={XR - XL} d={0.3} color={LINE} y={0.05} />);
  els.push(<Flat key="hwy-e1" x={0} z={hz1 - 0.6} w={XR - XL} d={0.3} color={LINE} y={0.05} />);
  for (let x = XL; x < XR; x += 12) {
    els.push(<Flat key={`hd1${x}`} x={x} z={229} w={4.5} d={0.28} color={LINE} y={0.05} />);
    els.push(<Flat key={`hd2${x}`} x={x} z={243} w={4.5} d={0.28} color={LINE} y={0.05} />);
  }
  // median barrier with openings where the avenues cross
  const pgx = (PORT_IN_X + PORT_OUT_X) / 2;
  const gaps = [[pgx - 12, pgx + 12], [ART_W - 11, ART_W + 11], [ART_E - 11, ART_E + 11], [OCEAN_X - 11, OCEAN_X + 11], [CEDAR_X - 11, CEDAR_X + 11],
    [WIL_X0 - 11, WIL_X0 + 11], [BIRCH_X - 11, BIRCH_X + 11]].sort((p, q) => p[0] - q[0]);
  let x0 = XL;
  for (const [a, b] of [...gaps, [XR, XR]]) {
    if (a > x0) els.push(<Box key={`med${x0}`} p={[(x0 + a) / 2, 0.35, HWY_Z]} s={[a - x0, 0.7, 0.9]} c="#c4ccdc" shadow={false} />);
    x0 = b;
  }
  els.push(<Flat key="verge-n" x={0} z={hz0 - 9} w={XR - XL} d={18} color={LAWN} y={0.012} />);
  els.push(<Flat key="verge-s" x={0} z={hz1 + 8} w={XR - XL} d={16} color={LAWN} y={0.012} />);
  // avenues (north–south)
  for (const ax of [ART_W, ART_E]) {
    const len = hz0 - ART_Z0;
    els.push(<Flat key={`art${ax}`} x={ax} z={(hz0 + ART_Z0) / 2} w={ART_HALF * 2} d={len + 0.2} color={ROAD} y={0.031} />);
    for (let z = ART_Z0 + 4; z < hz0 - 4; z += 10) els.push(<Flat key={`ad${ax}${z}`} x={ax} z={z} w={0.28} d={4} color={LINE} y={0.05} />);
    els.push(<Flat key={`awalk0${ax}`} x={ax - ART_HALF - 1.6} z={(hz0 + ART_Z0) / 2} w={3.2} d={len} color={C.curb} y={0.035} />);
    els.push(<Flat key={`awalk1${ax}`} x={ax + ART_HALF + 1.6} z={(hz0 + ART_Z0) / 2} w={3.2} d={len} color={C.curb} y={0.035} />);
  }
  // Port Harbor town: the avenues continue south, with Market Street, Bay Road, Shore Road and Central Avenue
  for (const ax of [ART_W, ART_E]) {
    const len = TOWN_Z1 + ART_HALF - hz1;
    els.push(<Flat key={`tart${ax}`} x={ax} z={hz1 + len / 2} w={ART_HALF * 2} d={len} color={ROAD} y={0.031} />);
    for (let z = hz1 + 8; z < TOWN_Z1 - 4; z += 10) els.push(<Flat key={`tad${ax}${z}`} x={ax} z={z} w={0.28} d={4} color={LINE} y={0.05} />);
    els.push(<Flat key={`twalk0${ax}`} x={ax - ART_HALF - 1.6} z={hz1 + len / 2} w={3.2} d={len} color={C.curb} y={0.035} />);
    els.push(<Flat key={`twalk1${ax}`} x={ax + ART_HALF + 1.6} z={hz1 + len / 2} w={3.2} d={len} color={C.curb} y={0.035} />);
  }
  {
    const len = TOWN_Z1 + STREET_HALF - hz1;
    els.push(<Flat key="central" x={CENTRAL_X} z={hz1 + len / 2} w={STREET_HALF * 2} d={len} color={ROAD} y={0.032} />);
    for (let z = hz1 + 8; z < TOWN_Z1 - 4; z += 8) els.push(<Flat key={`cd${z}`} x={CENTRAL_X} z={z} w={0.3} d={3.6} color={LINE} y={0.05} />);
  }
  // Central, Ocean and Cedar Avenues (highway → Shore Road) with sidewalks
  for (const [k, ax, half] of [['ocean', OCEAN_X, STREET_HALF], ['cedar', CEDAR_X, ART_HALF]] as [string, number, number][]) {
    const len = SHORE_Z + half - hz1;
    els.push(<Flat key={`na${k}`} x={ax} z={hz1 + len / 2} w={half * 2} d={len} color={ROAD} y={0.032} />);
    for (let z = hz1 + 8; z < SHORE_Z - 4; z += 9) els.push(<Flat key={`nad${k}${z}`} x={ax} z={z} w={0.3} d={3.6} color={LINE} y={0.05} />);
  }
  for (const [k, ax, half] of [['central', CENTRAL_X, STREET_HALF], ['ocean', OCEAN_X, STREET_HALF], ['cedar', CEDAR_X, ART_HALF]] as [string, number, number][]) {
    const len = SHORE_Z - hz1;
    els.push(<Flat key={`naw0${k}`} x={ax - half - 1.7} z={hz1 + len / 2} w={3.4} d={len} color={C.curb} y={0.035} />);
    els.push(<Flat key={`naw1${k}`} x={ax + half + 1.7} z={hz1 + len / 2} w={3.4} d={len} color={C.curb} y={0.035} />);
  }
  for (const [k, sz, x0, x1] of [['market', MARKET_Z, MARKET_X0, CEDAR_X + ART_HALF], ['bay', BAY_Z, ART_W - ART_HALF, CEDAR_X + ART_HALF], ['shore', SHORE_Z, ART_W - ART_HALF, CEDAR_X + ART_HALF]] as [string, number, number, number][]) {
    const w = x1 - x0;
    els.push(<Flat key={`ts${k}`} x={(x0 + x1) / 2} z={sz} w={w} d={STREET_HALF * 2} color={ROAD} y={0.032} />);
    for (let x = x0 + 6; x < x1 - 4; x += 8) els.push(<Flat key={`tsd${k}${x}`} x={x} z={sz} w={3.6} d={0.3} color={LINE} y={0.05} />);
    els.push(<Flat key={`tsw0${k}`} x={(x0 + x1) / 2} z={sz - STREET_HALF - 1.7} w={w} d={3.4} color={C.curb} y={0.035} />);
    els.push(<Flat key={`tsw1${k}`} x={(x0 + x1) / 2} z={sz + STREET_HALF + 1.7} w={w} d={3.4} color={C.curb} y={0.035} />);
    for (const jx of [ART_W + ART_HALF + 4, CENTRAL_X - STREET_HALF - 4, CENTRAL_X + STREET_HALF + 4, ART_E - ART_HALF - 4, ART_E + ART_HALF + 4,
      OCEAN_X - STREET_HALF - 4, OCEAN_X + STREET_HALF + 4, CEDAR_X - ART_HALF - 4]) {
      for (let i = -5; i <= 5; i += 1.6) els.push(<Flat key={`tzb${k}${jx}${i}`} x={jx} z={sz + i} w={3.2} d={0.7} color={LINE} y={0.055} />);
    }
  }
  // Maple Heights: the estate's avenues (Hillcrest Road → highway) and streets (Industrial Ave → Cedar Ave)
  for (const [k, ax, half] of [['indn', SUB_X0, ART_HALF], ['maple', MAPLE_X, STREET_HALF], ['cedarn', SUB_X1, ART_HALF]] as [string, number, number][]) {
    const z0 = SUB_Z0 - half, len = hz0 - z0;
    if (k !== 'indn') {
      els.push(<Flat key={`sa${k}`} x={ax} z={z0 + len / 2} w={half * 2} d={len} color={ROAD} y={0.031} />);
      for (let z = z0 + 8; z < hz0 - 4; z += 9) els.push(<Flat key={`sad${k}${z}`} x={ax} z={z} w={0.3} d={3.6} color={LINE} y={0.05} />);
      els.push(<Flat key={`saw0${k}`} x={ax - half - 1.7} z={z0 + len / 2} w={3.4} d={len} color={C.curb} y={0.035} />);
    }
    els.push(<Flat key={`saw1${k}`} x={ax + half + 1.7} z={z0 + len / 2} w={3.4} d={len} color={C.curb} y={0.035} />);
  }
  for (const [k, sz] of [['hill', SUB_STREETS.hill], ['nw', STREETS.B], ['elm', SUB_STREETS.elm], ['rr', STREETS.A], ['oak', SUB_STREETS.oak]] as [string, number][]) {
    const x0 = SUB_X0 + ART_HALF, x1 = SUB_X1 + ART_HALF, w = x1 - x0;
    els.push(<Flat key={`ss${k}`} x={(x0 + x1) / 2} z={sz} w={w} d={STREET_HALF * 2} color={ROAD} y={0.032} />);
    for (let x = x0 + 8; x < x1 - 6; x += 8) if (Math.abs(x - MAPLE_X) > 9) els.push(<Flat key={`ssd${k}${x}`} x={x} z={sz} w={3.6} d={0.3} color={LINE} y={0.05} />);
    els.push(<Flat key={`ssw0${k}`} x={(x0 + x1) / 2 + 1.7} z={sz - STREET_HALF - 1.7} w={w - 3.4} d={3.4} color={C.curb} y={0.035} />);
    els.push(<Flat key={`ssw1${k}`} x={(x0 + x1) / 2 + 1.7} z={sz + STREET_HALF + 1.7} w={w - 3.4} d={3.4} color={C.curb} y={0.035} />);
    for (const jx of [SUB_X0 + ART_HALF + 4, MAPLE_X - STREET_HALF - 4, MAPLE_X + STREET_HALF + 4, SUB_X1 - ART_HALF - 4]) {
      for (let i = -5; i <= 5; i += 1.6) els.push(<Flat key={`szb${k}${jx}${i}`} x={jx} z={sz + i} w={3.2} d={0.7} color={LINE} y={0.055} />);
    }
  }
  // Willow Grove: Willow Avenue and Birch Lane (Hillcrest Road → highway), and the streets west of Harbor Avenue
  for (const [k, ax, half] of [['willow', WIL_X0, ART_HALF], ['birch', BIRCH_X, STREET_HALF]] as [string, number, number][]) {
    const z0 = SUB_Z0 - half, len = hz0 - z0;
    els.push(<Flat key={`wa${k}`} x={ax} z={z0 + len / 2} w={half * 2} d={len} color={ROAD} y={0.031} />);
    for (let z = z0 + 8; z < hz0 - 4; z += 9) els.push(<Flat key={`wad${k}${z}`} x={ax} z={z} w={0.3} d={3.6} color={LINE} y={0.05} />);
    els.push(<Flat key={`waw0${k}`} x={ax - half - 1.7} z={z0 + len / 2} w={3.4} d={len} color={C.curb} y={0.035} />);
    els.push(<Flat key={`waw1${k}`} x={ax + half + 1.7} z={z0 + len / 2} w={3.4} d={len} color={C.curb} y={0.035} />);
  }
  for (const [k, sz] of [['hill', SUB_STREETS.hill], ['nw', STREETS.B], ['elm', SUB_STREETS.elm], ['rr', STREETS.A], ['oak', SUB_STREETS.oak]] as [string, number][]) {
    const x0 = WIL_X0 - ART_HALF, x1 = WIL_X1 - ART_HALF, w = x1 - x0;
    els.push(<Flat key={`ws${k}`} x={(x0 + x1) / 2} z={sz} w={w} d={STREET_HALF * 2} color={ROAD} y={0.032} />);
    for (let x = x0 + 14; x < x1 - 6; x += 8) if (Math.abs(x - BIRCH_X) > 9) els.push(<Flat key={`wsd${k}${x}`} x={x} z={sz} w={3.6} d={0.3} color={LINE} y={0.05} />);
    els.push(<Flat key={`wsw0${k}`} x={(x0 + x1) / 2 - 1.7} z={sz - STREET_HALF - 1.7} w={w - 3.4} d={3.4} color={C.curb} y={0.035} />);
    els.push(<Flat key={`wsw1${k}`} x={(x0 + x1) / 2 - 1.7} z={sz + STREET_HALF + 1.7} w={w - 3.4} d={3.4} color={C.curb} y={0.035} />);
    for (const jx of [WIL_X0 + ART_HALF + 4, BIRCH_X - STREET_HALF - 4, BIRCH_X + STREET_HALF + 4, WIL_X1 - ART_HALF - 4]) {
      for (let i = -5; i <= 5; i += 1.6) els.push(<Flat key={`wzb${k}${jx}${i}`} x={jx} z={sz + i} w={3.2} d={0.7} color={LINE} y={0.055} />);
    }
  }
  // bridge piers where the highway crosses the water west of the terminal
  for (let x = -1180; x < -820; x += 40) els.push(<Box key={`pier${x}`} p={[x, -1, HWY_Z]} s={[3, 4, HWY_HALF * 2 - 2]} c="#b7c0d0" shadow={false} />);
  els.push(<Box key="rail-n" p={[-1000, 0.7, hz0 - 0.4]} s={[400, 1.4, 0.4]} c="#c4ccdc" shadow={false} />);
  els.push(<Box key="rail-s" p={[-1000, 0.7, hz1 + 0.4]} s={[400, 1.4, 0.4]} c="#c4ccdc" shadow={false} />);
  // streets (east–west) between the avenues
  for (const [k, sz] of Object.entries(STREETS)) {
    const w = ART_E - ART_W;
    els.push(<Flat key={`st${k}`} x={0} z={sz} w={w} d={STREET_HALF * 2} color={ROAD} y={0.032} />);
    for (let x = ART_W + 12; x < ART_E - 10; x += 8) els.push(<Flat key={`sd${k}${x}`} x={x} z={sz} w={3.6} d={0.3} color={LINE} y={0.05} />);
    els.push(<Flat key={`sw0${k}`} x={0} z={sz - STREET_HALF - 0.4} w={w - ART_HALF * 2 - 6.4} d={0.8} color={C.curb} y={0.035} />);
    els.push(<Flat key={`sw1${k}`} x={0} z={sz + STREET_HALF + 1.7} w={w - ART_HALF * 2 - 6.4} d={3.4} color={C.curb} y={0.035} />);
    // zebra crossings next to each junction
    for (const jx of [ART_W + ART_HALF + 4, ART_E - ART_HALF - 4]) {
      for (let i = -5; i <= 5; i += 1.6) els.push(<Flat key={`zb${k}${jx}${i}`} x={jx} z={sz + i} w={3.2} d={0.7} color={LINE} y={0.055} />);
    }
  }
  return <group>{els}</group>;
}

// ---------------------------------------------------------------- landscaping
function useTreeSpots(): [number, number, number][] {
  return useMemo(() => {
    const out: [number, number, number][] = [];
    const ok = (x: number, z: number) => {
      for (const b of getPark().buildings) {
        const [w, d] = b.rotation === 90 || b.rotation === 270 ? [b.d, b.w] : [b.w, b.d];
        if (Math.abs(x - b.x) < w / 2 + 4 && Math.abs(z - b.z) < d / 2 + 4) return false;
      }
      return true;
    };
    let n = 0;
    const add = (x: number, z: number) => { if (ok(x, z)) out.push([x, z, 0.9 + ((n++ * 37) % 7) / 10]); };
    for (let x = -600; x <= 640; x += 21) {
      if ([ART_W, ART_E, WIL_X0, BIRCH_X].every((ax) => Math.abs(x - ax) > 18)) add(x, HWY_Z - HWY_HALF - 8);
      if (x > -610) add(x + 9, HWY_Z + HWY_HALF + 9);
    }
    for (let z = 200; z >= ART_Z0 + 10; z -= 23) {
      if ([SUB_STREETS.hill, STREETS.B, SUB_STREETS.elm, STREETS.A, SUB_STREETS.oak].every((s) => Math.abs(z - s) > 12)) add(ART_W - ART_HALF - 9, z);
      add(ART_E + ART_HALF + 9, z);
    }
    for (let x = ART_W + 20; x <= ART_E - 20; x += 26) add(x, ART_Z0 + 4);
    // street trees in town
    for (let x = ART_W + 16; x <= ART_E - 14; x += 22) {
      if (Math.abs(x - CENTRAL_X) < 14) continue;
      add(x, MARKET_Z + STREET_HALF + 5);
      add(x + 11, BAY_Z - STREET_HALF - 5);
      add(x, BAY_Z + STREET_HALF + 5);
      add(x + 11, SHORE_Z - STREET_HALF - 5);
    }
    for (let i = 0; i < 12; i++) add(-185 + (i % 4) * 16, 438 + Math.floor(i / 4) * 8);
    for (let i = 0; i < 10; i++) add(110 + (i % 5) * 22, 446 + Math.floor(i / 5) * 8);
    // small parks
    for (let i = 0; i < 9; i++) add(-318 + (i % 3) * 9, -40 - Math.floor(i / 3) * 9);
    for (let i = 0; i < 6; i++) add(312 + (i % 2) * 10, -10 - Math.floor(i / 2) * 11);
    return out;
  }, []);
}

function Trees() {
  const spots = useTreeSpots();
  const trunk = useRef<THREE.InstancedMesh>(null);
  const crown = useRef<THREE.InstancedMesh>(null);
  const crown2 = useRef<THREE.InstancedMesh>(null);
  const apply = () => {
    const m = new THREE.Matrix4();
    spots.forEach(([x, z, s], i) => {
      m.makeScale(s, s, s).setPosition(x, 0.9 * s, z);
      trunk.current?.setMatrixAt(i, m);
      m.makeScale(s, s, s).setPosition(x, 3.0 * s, z);
      crown.current?.setMatrixAt(i, m);
      m.makeScale(s, s, s).setPosition(x + 0.5 * s, 2.4 * s, z + 0.4 * s);
      crown2.current?.setMatrixAt(i, m);
    });
    for (const r of [trunk, crown, crown2]) if (r.current) r.current.instanceMatrix.needsUpdate = true;
  };
  return (
    <group ref={() => apply()}>
      <instancedMesh ref={trunk} args={[undefined, undefined, spots.length]} castShadow material={mat(C.trunk)}>
        <cylinderGeometry args={[0.18, 0.24, 1.8, 6]} />
      </instancedMesh>
      <instancedMesh ref={crown} args={[undefined, undefined, spots.length]} castShadow material={mat(C.leaf, { rough: 0.9 })}>
        <sphereGeometry args={[1.55, 12, 9]} />
      </instancedMesh>
      <instancedMesh ref={crown2} args={[undefined, undefined, spots.length]} castShadow material={mat(C.leafDark, { rough: 0.9 })}>
        <sphereGeometry args={[0.9, 10, 8]} />
      </instancedMesh>
    </group>
  );
}

function Lawns() {
  return (
    <group>
      {/* green belts around the sites and the plants */}
      <Flat x={-322} z={-60} w={22} d={190} color={LAWN2} y={0.011} />
      <Flat x={318} z={-40} w={30} d={150} color={LAWN2} y={0.011} />
      <Flat x={0} z={-305} w={ART_E - ART_W - 20} d={30} color={LAWN2} y={0.011} />
      {/* Newark Bay: the terminal's quay and the shipping lane, and the water west of the terminal */}
      <Flat x={-955} z={560} w={1090} d={438} color={WATER} y={0.02} />
      <Flat x={-1155} z={245} w={690} d={194} color={WATER} y={0.019} />
      <Flat x={-805} z={290} w={10} d={102} color="#aab3c4" y={0.03} />
      {/* Port Harbor Beach: promenade, sand and the sea along the whole south shore */}
      <Flat x={(ART_W - 60 + 1300) / 2} z={(SHORE_Z + STREET_HALF + 3.4 + BEACH_Z0) / 2} w={1300 - ART_W + 60} d={BEACH_Z0 - SHORE_Z - STREET_HALF - 3.4} color="#e9e4da" y={0.014} />
      <Flat x={(ART_W - 60 + 1300) / 2} z={(BEACH_Z0 + SEA_Z0) / 2 + 1} w={1300 - ART_W + 60} d={SEA_Z0 - BEACH_Z0 + 2} color="#f2e2b8" y={0.016} />
      <Flat x={(ART_W - 60 + 1300) / 2} z={SEA_Z0 + 0.5} w={1300 - ART_W + 60} d={3} color="#e6f2fb" y={0.021} />
      <Flat x={(-420 + 1500) / 2} z={SEA_Z0 + 400} w={1920} d={800} color={WATER} y={0.019} />
      {/* the estate's lawns north of the highway */}
      <Flat x={(SUB_X0 + SUB_X1) / 2 + 20} z={(SUB_Z0 - 80 + HWY_Z - HWY_HALF) / 2} w={SUB_X1 - SUB_X0 + 80} d={HWY_Z - HWY_HALF - SUB_Z0 + 80} color="#e2eddf" y={0.009} />
      <Flat x={(WIL_X0 + WIL_X1) / 2 - 20} z={(SUB_Z0 - 80 + HWY_Z - HWY_HALF) / 2} w={WIL_X1 - WIL_X0 + 80} d={HWY_Z - HWY_HALF - SUB_Z0 + 80} color="#e2eddf" y={0.009} />
      {/* town parks */}
      <Flat x={-160} z={445} w={70} d={30} color={LAWN2} y={0.011} />
      <Flat x={160} z={450} w={120} d={22} color={LAWN2} y={0.011} />
    </group>
  );
}

function SignPost({ p, rot, title, sub, arrow }: { p: V3; rot: number; title: string; sub: string; arrow: 'left' | 'right' | 'up' }) {
  const tex = useMemo(() => roadSign(title, sub, arrow), [title, sub, arrow]);
  const m = useMemo(() => new THREE.MeshBasicMaterial({ map: tex }), [tex]);
  return (
    <group position={p} rotation={[0, rot, 0]}>
      <Box p={[-4.5, 3, 0]} s={[0.3, 6, 0.3]} c="#9aa4b8" />
      <Box p={[4.5, 3, 0]} s={[0.3, 6, 0.3]} c="#9aa4b8" />
      <mesh position={[0, 6.4, 0.18]} material={m}><planeGeometry args={[11, 3.8]} /></mesh>
      <Box p={[0, 6.4, 0]} s={[11.2, 3.9, 0.25]} c="#1b6b43" shadow={false} />
    </group>
  );
}

function Signs() {
  const imp = useMemo(() => groundText('IMPORTS ▲', '#ffffff'), []);
  const exp = useMemo(() => groundText('EXPORTS ▼', '#ffffff'), []);
  return (
    <group>
      <SignPost p={[ART_W - 40, 0, HWY_Z + HWY_HALF + 5]} rot={0} title="Harborside Park" sub="Imports · Harbor Ave" arrow="up" />
      <SignPost p={[ART_E + 60, 0, HWY_Z + HWY_HALF + 5]} rot={0} title="I-95 · Customers" sub="Exports leave east" arrow="right" />
      <SignPost p={[HWY_X0 + 40, 0, HWY_Z + HWY_HALF + 5]} rot={0} title="Port Newark" sub="Container terminal" arrow="left" />
      <Decal tex={imp} x={ART_W + 3} z={180} w={12} d={3} rot={Math.PI / 2} />
      <Decal tex={exp} x={ART_E - 3} z={180} w={12} d={3} rot={-Math.PI / 2} />
    </group>
  );
}

// ---------------------------------------------------------------- buildings
function Sign({ p, rot = 0, name, sub, color, w = 16 }: { p: V3; rot?: number; name: string; sub: string; color: string; w?: number }) {
  const tex = useMemo(() => companySign(name, sub, color), [name, sub, color]);
  const m = useMemo(() => new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }), [tex]);
  return <mesh position={p} rotation={[0, rot, 0]} material={m}><planeGeometry args={[w, w / 4]} /></mesh>;
}

function Windows({ w, h, d }: { w: number; h: number; d: number }) {
  const m = useMemo(() => {
    const a = windowTexture().clone(); a.repeat.set(w / 5, h / 4); a.needsUpdate = true;
    const b = windowTexture().clone(); b.repeat.set(d / 5, h / 4); b.needsUpdate = true;
    const top = mat('#e9edf5');
    return [new THREE.MeshStandardMaterial({ map: b, roughness: 0.9 }), new THREE.MeshStandardMaterial({ map: b, roughness: 0.9 }), top, top,
      new THREE.MeshStandardMaterial({ map: a, roughness: 0.9 }), new THREE.MeshStandardMaterial({ map: a, roughness: 0.9 })];
  }, [w, h, d]);
  return <mesh position={[0, h / 2, 0]} castShadow receiveShadow material={m}><boxGeometry args={[w, h, d]} /></mesh>;
}

/** Smoke puffs rising from a stack; follows the operations clock (stops when paused). */
function Smoke({ p, h }: { p: V3; h: number }) {
  const g = useRef<THREE.Group>(null);
  const m = useMemo(() => new THREE.MeshStandardMaterial({ color: '#f4f6fa', transparent: true, opacity: 0.7, depthWrite: false, roughness: 1 }), []);
  useFrame(() => {
    const t = parkTime();
    g.current?.children.forEach((c, i) => {
      const k = ((t * 0.25 + i / 4) % 1);
      c.position.set(k * 3, h + k * 10, -k * 1.5);
      const s = 0.8 + k * 2.4;
      c.scale.set(s, s, s);
      ((c as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = 0.75 * (1 - k);
    });
  });
  const mats = useMemo(() => [0, 1, 2, 3].map(() => m.clone()), [m]);
  return (
    <group ref={g} position={p}>
      {mats.map((mm, i) => <mesh key={i} material={mm}><sphereGeometry args={[1, 10, 8]} /></mesh>)}
    </group>
  );
}

function Stack({ x, z, h, color }: { x: number; z: number; h: number; color: string }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, h / 2, 0]} castShadow material={mat('#d5dbe6')}><cylinderGeometry args={[1.1, 1.4, h, 14]} /></mesh>
      <mesh position={[0, h - 2, 0]} material={mat(color)}><cylinderGeometry args={[1.13, 1.13, 1.4, 14]} /></mesh>
      <mesh position={[0, h - 5, 0]} material={mat('#ffffff')}><cylinderGeometry args={[1.18, 1.18, 1.2, 14]} /></mesh>
      <Smoke p={[0, 0, 0]} h={h + 1} />
    </group>
  );
}

function Tank({ x, z, r, h, color }: { x: number; z: number; r: number; h: number; color: string }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow material={mat('#e6eaf2', { rough: 0.5, metal: 0.2 })}><cylinderGeometry args={[r, r, h, 20]} /></mesh>
      <mesh position={[0, h + 0.6, 0]} castShadow material={mat('#d3d9e5')}><coneGeometry args={[r, 1.4, 20]} /></mesh>
      <mesh position={[0, h * 0.7, 0]} material={mat(color)}><cylinderGeometry args={[r + 0.04, r + 0.04, 0.9, 20]} /></mesh>
    </group>
  );
}

const CAR_COLORS = ['#f6f8fc', '#2b2d42', '#e4572e', '#3a86ff', '#8d99ae', '#ffb703', '#adb5bd', '#06d6a0', '#ef476f', '#1d3557'];

function CarModel({ color, parked = false }: { color: string; parked?: boolean }) {
  return (
    <group>
      <Box p={[0, 0.75, 0]} s={[4.4, 0.9, 2.0]} c={color} shadow={!parked} />
      <Box p={[-0.3, 1.5, 0]} s={[2.3, 0.75, 1.8]} c={color} shadow={!parked} />
      <Box p={[0.86, 1.5, 0]} s={[0.05, 0.62, 1.66]} c={C.glass} shadow={false} />
      <Box p={[-0.3, 1.5, 0.91]} s={[2.0, 0.55, 0.02]} c={C.glass} shadow={false} />
      <Box p={[-0.3, 1.5, -0.91]} s={[2.0, 0.55, 0.02]} c={C.glass} shadow={false} />
      {[[1.35, 0.95], [1.35, -0.95], [-1.35, 0.95], [-1.35, -0.95]].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, 0.36, z]} rotation={[Math.PI / 2, 0, 0]} material={mat(C.tire)}><cylinderGeometry args={[0.36, 0.36, 0.26, 10]} /></mesh>
      ))}
    </group>
  );
}

function VanModel({ color }: { color: string }) {
  return (
    <group>
      <Box p={[-0.4, 1.45, 0]} s={[4.6, 2.3, 2.1]} c={color} />
      <Box p={[2.25, 1.0, 0]} s={[1.1, 1.4, 2.0]} c={color} />
      <Box p={[2.0, 1.85, 0]} s={[0.05, 0.8, 1.8]} c={C.glass} shadow={false} />
      {[[1.8, 1.0], [1.8, -1.0], [-1.7, 1.0], [-1.7, -1.0]].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, 0.4, z]} rotation={[Math.PI / 2, 0, 0]} material={mat(C.tire)}><cylinderGeometry args={[0.4, 0.4, 0.28, 10]} /></mesh>
      ))}
    </group>
  );
}

function BusModel({ color }: { color: string }) {
  return (
    <group>
      <Box p={[0, 1.8, 0]} s={[11, 2.9, 2.6]} c={color} />
      <Box p={[0, 2.3, 1.31]} s={[9.6, 0.9, 0.03]} c={C.glass} shadow={false} />
      <Box p={[0, 2.3, -1.31]} s={[9.6, 0.9, 0.03]} c={C.glass} shadow={false} />
      <Box p={[5.51, 2.2, 0]} s={[0.03, 1.4, 2.3]} c={C.glass} shadow={false} />
      {[[3.6, 1.2], [3.6, -1.2], [-3.4, 1.2], [-3.4, -1.2]].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, 0.5, z]} rotation={[Math.PI / 2, 0, 0]} material={mat(C.tire)}><cylinderGeometry args={[0.5, 0.5, 0.3, 12]} /></mesh>
      ))}
    </group>
  );
}

function RigModel({ color, tanker }: { color: string; tanker: boolean }) {
  return (
    <group>
      <Box p={[-0.2, 0.8, 0]} s={[11.4, 0.34, 2.2]} c={C.steel} />
      {tanker ? (
        <mesh position={[-1.6, 2.6, 0]} rotation={[0, 0, Math.PI / 2]} castShadow material={mat('#cfd6e2', { rough: 0.35, metal: 0.4 })}>
          <cylinderGeometry args={[1.35, 1.35, 8.4, 18]} />
        </mesh>
      ) : (
        <>
          <Box p={[-1.55, 2.7, 0]} s={[8.6, 3.2, 2.5]} c={C.white} />
          <Box p={[-1.55, 1.4, 0]} s={[8.62, 0.6, 2.54]} c={color} shadow={false} />
        </>
      )}
      <Box p={[4.4, 2.2, 0]} s={[2.6, 2.5, 2.4]} c={color} />
      <Box p={[5.72, 2.85, 0]} s={[0.05, 1.0, 2.1]} c={C.glass} shadow={false} />
      {[4.4, -3.0, -4.3].map((x) => (
        <group key={x}>
          <mesh position={[x, 0.5, 1.1]} rotation={[Math.PI / 2, 0, 0]} material={mat(C.tire)}><cylinderGeometry args={[0.5, 0.5, 0.34, 12]} /></mesh>
          <mesh position={[x, 0.5, -1.1]} rotation={[Math.PI / 2, 0, 0]} material={mat(C.tire)}><cylinderGeometry args={[0.5, 0.5, 0.34, 12]} /></mesh>
        </group>
      ))}
    </group>
  );
}

export const VEHICLE_DIMS: Record<ParkVehicle['kind'], [number, number, number]> = {
  CAR: [4.6, 2.0, 2.1], VAN: [5.8, 2.7, 2.2], BUS: [11.2, 3.4, 2.7], TRUCK: [12, 4.4, 2.6], TANKER: [12, 4.0, 2.8],
  TAXI: [4.6, 2.4, 2.1], TRACTOR: [13, 4.2, 2.8],
};

function TaxiModel({ color }: { color: string }) {
  return (
    <group>
      <CarModel color={color} />
      <Box p={[-0.3, 2.05, 0]} s={[0.9, 0.35, 0.5]} c="#ffffff" shadow={false} />
    </group>
  );
}

/** Terminal tractor with a container chassis (shuttles boxes between the cranes and the stacks). */
function TractorModel({ color, box }: { color: string; box: string }) {
  return (
    <group>
      <Box p={[4.6, 1.5, 0]} s={[2.4, 2.2, 2.4]} c={color} />
      <Box p={[5.82, 1.9, 0]} s={[0.05, 0.9, 2.0]} c={C.glass} shadow={false} />
      <Box p={[-1.2, 0.85, 0]} s={[10.6, 0.3, 2.3]} c={C.steel} />
      <Box p={[-1.2, 2.3, 0]} s={[10, 2.6, 2.5]} c={box} />
      {[4.6, -4.4, -5.6].map((x) => (
        <group key={x}>
          <mesh position={[x, 0.5, 1.1]} rotation={[Math.PI / 2, 0, 0]} material={mat(C.tire)}><cylinderGeometry args={[0.5, 0.5, 0.34, 12]} /></mesh>
          <mesh position={[x, 0.5, -1.1]} rotation={[Math.PI / 2, 0, 0]} material={mat(C.tire)}><cylinderGeometry args={[0.5, 0.5, 0.34, 12]} /></mesh>
        </group>
      ))}
    </group>
  );
}

function ParkedCars({ b }: { b: ParkBuilding }) {
  const cars: JSX.Element[] = [];
  const cols = Math.floor((b.w - 8) / 3.2);
  const rows = [-b.d / 2 + 6, -b.d / 2 + 13, b.d / 2 - 13, b.d / 2 - 6];
  rows.forEach((rz, ri) => {
    for (let i = 0; i < cols; i++) {
      const x = -b.w / 2 + 4 + i * 3.2 + 1.6;
      const seed = (i * 7 + ri * 13 + b.id.length * 3) % 10;
      cars.push(<Flat key={`l${ri}-${i}`} x={x - 1.6} z={rz} w={0.14} d={5.6} color={LINE} y={0.06} />);
      if (seed < 6) {
        cars.push(
          <group key={`c${ri}-${i}`} position={[x, 0, rz]} rotation={[0, Math.PI / 2 + (ri % 2 ? Math.PI : 0), 0]} scale={0.85}>
            <CarModel color={CAR_COLORS[(i + ri * 3) % CAR_COLORS.length]} parked />
          </group>,
        );
      }
    }
  });
  return <group>{cars}</group>;
}

function BuildingBody({ b }: { b: ParkBuilding }) {
  const company = findCompany(b.companyId);
  const color = company?.color ?? '#5b6476';
  const name = company?.name ?? b.name;
  const front = b.d / 2;
  const parts: JSX.Element[] = [];
  const signSub = b.kind === 'PLANT' ? 'Plant' : b.kind === 'COLD_STORE' ? 'Cold store' : b.kind === 'OFFICE' ? `${b.floors} floors` : b.kind.charAt(0) + b.kind.slice(1).toLowerCase().replace('_', ' ');
  switch (b.kind) {
    case 'PLANT': {
      const hallW = b.w * 0.72, hallD = b.d * 0.62;
      parts.push(<Box key="hall" p={[-b.w * 0.1, b.h / 2, front - hallD / 2 - 6]} s={[hallW, b.h, hallD]} c={C.white} />);
      parts.push(<Box key="roof" p={[-b.w * 0.1, b.h + 0.15, front - hallD / 2 - 6]} s={[hallW + 0.4, 0.3, hallD + 0.4]} c={b.companyId === 'HELIOS' ? '#2b3a67' : color} />);
      if (b.companyId === 'HELIOS') {
        for (let i = 0; i < 6; i++) parts.push(<Box key={`pv${i}`} p={[-b.w * 0.1 - hallW / 2 + 8 + i * (hallW - 16) / 5, b.h + 0.6, front - hallD / 2 - 6]} s={[(hallW - 16) / 6.5, 0.2, hallD - 8]} c="#3554a5" shadow={false} />);
      } else {
        for (let i = 0; i < 4; i++) parts.push(<Box key={`mon${i}`} p={[-b.w * 0.1 - hallW / 2 + 12 + i * (hallW - 24) / 3, b.h + 1.2, front - hallD / 2 - 6]} s={[6, 2, hallD - 10]} c="#e3e8f2" />);
      }
      parts.push(<Box key="band" p={[-b.w * 0.1, 2.2, front - 6 + 0.06]} s={[hallW, 4.4, 0.2]} c={color} />);
      // loading doors on the front
      for (let i = 0; i < 4; i++) parts.push(<Box key={`dr${i}`} p={[-b.w * 0.1 - hallW / 2 + 10 + i * 9, 2.4, front - 6 + 0.2]} s={[5, 4.4, 0.12]} c={C.rollDoor} shadow={false} />);
      // annexe with stacks and tanks
      const ax = b.w / 2 - b.w * 0.14;
      parts.push(<Box key="boiler" p={[ax, b.h * 0.45, front - 18]} s={[b.w * 0.2, b.h * 0.9, 18]} c="#e9edf5" />);
      parts.push(<Stack key="s1" x={ax - 3} z={front - 26} h={b.h * 2.4} color={color} />);
      parts.push(<Stack key="s2" x={ax + 5} z={front - 26} h={b.h * 2.0} color={color} />);
      parts.push(<Tank key="t1" x={ax - 2} z={-b.d / 2 + 9} r={4} h={10} color={color} />);
      parts.push(<Tank key="t2" x={ax + 8} z={-b.d / 2 + 9} r={4} h={10} color={color} />);
      if (b.companyId === 'GREENLEAF') parts.push(<Tank key="t3" x={ax - 12} z={-b.d / 2 + 9} r={4} h={12} color={color} />);
      parts.push(<Sign key="sign" p={[-b.w * 0.1 - hallW / 2 + 16, b.h - 3, front - 6 + 0.3]} name={name} sub={signSub} color={color} w={22} />);
      parts.push(<Flat key="yard" x={0} z={front - 3} w={b.w} d={6} color="#e8ecf4" y={0.015} />);
      break;
    }
    case 'WAREHOUSE': {
      parts.push(<Box key="walls" p={[0, b.h / 2, -2]} s={[b.w, b.h, b.d - 4]} c={C.white} />);
      parts.push(<Box key="roof" p={[0, b.h + 0.2, -2]} s={[b.w + 0.4, 0.4, b.d - 3.6]} c={color} />);
      parts.push(<Box key="fascia" p={[0, b.h - 0.6, front - 4 + 0.08]} s={[b.w, 1.2, 0.16]} c={color} />);
      const n = Math.max(3, Math.floor(b.w / 14));
      for (let i = 0; i < n; i++) {
        const x = -b.w / 2 + (i + 0.5) * (b.w / n);
        parts.push(<Box key={`d${i}`} p={[x, 2.3, front - 4 + 0.12]} s={[4, 4.4, 0.1]} c={C.doorDark} shadow={false} />);
        parts.push(<Flat key={`m${i}`} x={x} z={front + 4} w={0.16} d={10} color={C.marking} y={0.04} />);
      }
      parts.push(<Sign key="sign" p={[b.w / 2 - 14, b.h - 3.2, front - 4 + 0.25]} name={name} sub={b.name.replace(name, '').trim() || 'Distribution centre'} color={color} w={20} />);
      break;
    }
    case 'COLD_STORE': {
      parts.push(<Box key="walls" p={[0, b.h / 2, -2]} s={[b.w, b.h, b.d - 4]} c="#f7f9fc" />);
      parts.push(<Box key="band" p={[0, b.h - 1.5, front - 4 + 0.08]} s={[b.w, 1.6, 0.16]} c={color} />);
      for (let i = 0; i < 6; i++) {
        parts.push(
          <group key={`fan${i}`} position={[-b.w / 2 + 10 + i * (b.w - 20) / 5, b.h, -2]}>
            <Box p={[0, 0.8, 0]} s={[6, 1.6, 3]} c="#d7dde8" />
            <mesh position={[-1.4, 1.65, 0]} material={mat('#9aa4b8')}><cylinderGeometry args={[1.1, 1.1, 0.12, 14]} /></mesh>
            <mesh position={[1.4, 1.65, 0]} material={mat('#9aa4b8')}><cylinderGeometry args={[1.1, 1.1, 0.12, 14]} /></mesh>
          </group>,
        );
      }
      for (let i = 0; i < 4; i++) parts.push(<Box key={`d${i}`} p={[-b.w / 2 + 14 + i * 12, 2.3, front - 4 + 0.12]} s={[4, 4.4, 0.1]} c="#5a6f8f" shadow={false} />);
      parts.push(<Sign key="sign" p={[b.w / 2 - 16, b.h - 4.5, front - 4 + 0.25]} name={name} sub="−25 °C to +4 °C" color={color} w={22} />);
      break;
    }
    case 'OFFICE':
    case 'SERVICES': {
      parts.push(<group key="body" position={[0, 0, 0]}><Windows w={b.w} h={b.h} d={b.d} /></group>);
      parts.push(<Box key="crown" p={[0, b.h + 0.4, 0]} s={[b.w + 0.3, 0.8, b.d + 0.3]} c={color} />);
      parts.push(<Box key="hvac" p={[b.w * 0.2, b.h + 1.6, 0]} s={[6, 1.8, 5]} c="#d5dbe7" />);
      parts.push(<Box key="canopy" p={[0, 3.6, front + 1.5]} s={[10, 0.3, 3]} c={color} />);
      const parkSvc = b.kind === 'SERVICES' && b.companyId === 'PARKAUTH';
      const medical = /clinic|medical/i.test(b.name) || parkSvc;
      const svcSub = parkSvc ? 'Clinic · Security' : /school/i.test(b.name) ? 'School' : /police/i.test(b.name) ? 'Police' : /fire/i.test(b.name) ? 'Fire & rescue' : /library/i.test(b.name) ? 'Public library' : medical ? 'Hospital · Emergency' : 'Town services';
      parts.push(<Sign key="sign" p={[0, b.h - 2.2, front + 0.2]} name={parkSvc ? 'Park Services' : b.kind === 'SERVICES' ? b.name : name} sub={b.kind === 'SERVICES' ? svcSub : b.status === 'VACANT' ? 'Office space to let' : 'Offices'} color={color} w={Math.min(22, b.w - 4)} />);
      if (b.kind === 'SERVICES' && medical) {
        parts.push(<Box key="x1" p={[b.w / 2 - 4, 6, front + 0.25]} s={[3.6, 1.1, 0.1]} c="#e03131" shadow={false} />);
        parts.push(<Box key="x2" p={[b.w / 2 - 4, 6, front + 0.25]} s={[1.1, 3.6, 0.1]} c="#e03131" shadow={false} />);
      }
      break;
    }
    case 'FUEL_STATION': {
      parts.push(<Box key="canopy" p={[-6, 6.2, 2]} s={[30, 0.8, 18]} c={C.white} />);
      parts.push(<Box key="canopyband" p={[-6, 6.2, 11.05]} s={[30, 0.82, 0.1]} c={color} />);
      for (const [x, z] of [[-18, -5], [6, -5], [-18, 9], [6, 9]]) parts.push(<Box key={`p${x}${z}`} p={[x, 3, z]} s={[0.6, 6, 0.6]} c="#c8d0de" />);
      for (const x of [-14, -6, 2]) for (const z of [-1, 5]) parts.push(<Box key={`pump${x}${z}`} p={[x, 0.9, z]} s={[1.2, 1.8, 0.8]} c={color} />);
      parts.push(<Box key="shop" p={[18, 2.4, -6]} s={[14, 4.8, 12]} c={C.white} />);
      parts.push(<Box key="shopband" p={[18, 4.2, 0.05]} s={[14, 1, 0.1]} c={color} />);
      parts.push(<Box key="pole" p={[22, 4, 14]} s={[0.5, 8, 0.5]} c="#9aa4b8" />);
      parts.push(<Sign key="sign" p={[22, 8.6, 14.3]} name={name} sub="Diesel · EV" color={color} w={10} />);
      break;
    }
    case 'PARKING': {
      parts.push(<Flat key="lot" x={0} z={0} w={b.w} d={b.d} color="#d9dfeb" y={0.02} />);
      parts.push(<ParkedCars key="cars" b={b} />);
      break;
    }
    case 'SUPERMARKET': {
      // big-box store: shop front with glass and canopy facing the street, car park strip in front
      const bodyD = b.d - 8;
      parts.push(<Box key="walls" p={[0, b.h / 2, -4]} s={[b.w, b.h, bodyD]} c="#f7f8fb" />);
      parts.push(<Box key="roof" p={[0, b.h + 0.2, -4]} s={[b.w + 0.4, 0.4, bodyD + 0.4]} c="#dfe4ee" />);
      parts.push(<Box key="fascia" p={[0, b.h - 1.2, front - 8 + 0.1]} s={[b.w, 2.4, 0.2]} c={color} />);
      parts.push(<Box key="glass" p={[-b.w * 0.18, 2.4, front - 8 + 0.12]} s={[b.w * 0.5, 4.2, 0.1]} c={C.glass} shadow={false} />);
      parts.push(<Box key="canopy" p={[-b.w * 0.18, 5, front - 6.2]} s={[b.w * 0.54, 0.35, 3.6]} c={color} />);
      for (let i = 0; i < 4; i++) parts.push(<Box key={`hv${i}`} p={[-b.w / 2 + 12 + i * (b.w - 24) / 3, b.h + 1.1, -6]} s={[5, 1.6, 3.2]} c="#cfd6e2" />);
      parts.push(<Box key="dock" p={[b.w / 2 - 8, 2, front - 8 + 0.12]} s={[6, 4, 0.1]} c={C.doorDark} shadow={false} />);
      parts.push(<Flat key="bay" x={b.w / 2 - 8} z={front - 4} w={8} d={8} color="#e7ebf3" y={0.03} />);
      parts.push(<Sign key="sign" p={[-b.w * 0.18, b.h - 1.2, front - 8 + 0.3]} name={name} sub="Supermarket · open 7–22" color={color} w={Math.min(26, b.w * 0.45)} />);
      for (let i = 0; i < Math.floor(b.w / 9); i++) {
        const x = -b.w / 2 + 5 + i * 9;
        if (Math.abs(x - (b.w / 2 - 8)) < 7) continue;
        parts.push(<Flat key={`ps${i}`} x={x} z={front - 2.5} w={0.14} d={4.5} color={LINE} y={0.04} />);
        if ((i * 7 + b.id.length) % 3 !== 0) {
          parts.push(<group key={`pc${i}`} position={[x + 2, 0, front - 2.6]} rotation={[0, Math.PI / 2, 0]} scale={0.8}><CarModel color={CAR_COLORS[(i * 3 + b.w) % CAR_COLORS.length]} parked /></group>);
        }
      }
      break;
    }
    case 'STORE': {
      const bodyD = b.d - 6;
      parts.push(<Box key="walls" p={[0, b.h / 2, -3]} s={[b.w, b.h, bodyD]} c="#fbfbfd" />);
      parts.push(<Box key="roof" p={[0, b.h + 0.2, -3]} s={[b.w + 0.4, 0.4, bodyD + 0.4]} c="#e2e6ee" />);
      parts.push(<Box key="parapet" p={[0, b.h - 0.4, front - 6 + 0.12]} s={[b.w + 0.4, 1.6, 0.25]} c={color} />);
      parts.push(<Box key="hvac" p={[b.w * 0.2, b.h + 1, -5]} s={[4, 1.4, 3]} c="#cfd6e2" />);
      parts.push(<Box key="glass" p={[0, 2.2, front - 6 + 0.1]} s={[b.w - 4, 3.6, 0.1]} c={C.glass} shadow={false} />);
      // striped awning over the shop window
      for (let i = 0; i < Math.floor((b.w - 2) / 2); i++) {
        parts.push(<Box key={`aw${i}`} p={[-b.w / 2 + 2 + i * 2, 4.6, front - 4.8]} s={[2, 0.25, 2.6]} c={i % 2 ? '#ffffff' : color} shadow={false} />);
      }
      parts.push(<Sign key="sign" p={[0, b.h - 1.4, front - 6 + 0.25]} name={name} sub={b.name === name ? (storeByBuilding(b.id)?.kind ?? 'Store').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : b.name} color={color} w={Math.min(18, b.w - 4)} />);
      break;
    }
    case 'RESIDENTIAL': {
      parts.push(<group key="body"><Windows w={b.w} h={b.h} d={b.d} /></group>);
      parts.push(<Box key="crown" p={[0, b.h + 0.4, 0]} s={[b.w + 0.3, 0.8, b.d + 0.3]} c="#dfe3ec" />);
      parts.push(<Box key="roofbox" p={[b.w * 0.15, b.h + 1.8, 0]} s={[b.w * 0.3, 2, b.d * 0.3]} c="#cfd5e1" />);
      parts.push(<Box key="band" p={[0, b.h - 0.6, front + 0.06]} s={[b.w, 1.2, 0.12]} c={color} shadow={false} />);
      for (let f = 1; f < Math.min(b.floors, 12); f += 2) {
        parts.push(<Box key={`bal${f}`} p={[0, f * (b.h / b.floors), front + 0.7]} s={[b.w * 0.8, 0.25, 1.4]} c="#e9ecf2" shadow={false} />);
      }
      parts.push(<Box key="entry" p={[0, 1.6, front + 1.2]} s={[6, 3.2, 2.4]} c={color} />);
      break;
    }
    case 'TERMINAL': {
      // the working terminal (quay, cranes, stacks, ships) is drawn by PortScene
      break;
    }
    default:
      break;
  }
  // north-facing buildings also carry their name on the south wall, which faces the default camera
  if (b.rotation === 180) {
    const backZ = b.kind === 'PLANT' ? front - 6 - b.d * 0.62 : -b.d / 2;
    const x = b.kind === 'PLANT' ? -b.w * 0.1 : 0;
    const y = b.kind === 'OFFICE' || b.kind === 'SERVICES' ? b.h - 2.2 : b.h - 3.4;
    if (b.kind !== 'PARKING' && b.kind !== 'FUEL_STATION' && b.kind !== 'TERMINAL' && b.kind !== 'RESIDENTIAL') {
      parts.push(<Sign key="backsign" p={[x, y, backZ - 0.3]} rot={Math.PI} name={name} sub={signSub} color={color} w={Math.min(22, b.w - 4)} />);
    }
  }
  if (b.status === 'MAINTENANCE') {
    for (let i = 0; i < 5; i++) parts.push(<mesh key={`cone${i}`} position={[-10 + i * 5, 0.6, front + 2]} material={mat('#f76707')}><coneGeometry args={[0.45, 1.2, 10]} /></mesh>);
  }
  return <group>{parts}</group>;
}


export function buildingDims(b: ParkBuilding): [number, number, number] {
  const h = b.kind === 'PARKING' || b.kind === 'TERMINAL' ? 3 : b.kind === 'PLANT' ? b.h + 4 : b.h + 1;
  return b.rotation === 90 || b.rotation === 270 ? [b.d, h, b.w] : [b.w, h, b.d];
}

function NeighbourBuilding({ b }: { b: ParkBuilding }) {
  const handlers = useSelectHandlers({ kind: 'building', id: b.id });
  const rot = (b.rotation * Math.PI) / 180;
  const dims = buildingDims(b);
  return (
    <group>
      <group position={[b.x, 0, b.z]} rotation={[0, rot, 0]}>
        <BuildingBody b={b} />
      </group>
      <mesh position={[b.x, dims[1] / 2, b.z]} {...handlers} name={`building-${b.id}`}>
        <boxGeometry args={dims} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------- gates with barriers
function Gate({ code }: { code: GateCode }) {
  const g = PARK_GATES[code];
  const handlers = useSelectHandlers({ kind: 'gate', id: code });
  const arm = useRef<THREE.Group>(null);
  const lift = useRef(0);
  const west = code === 'WEST';
  useFrame((_, dt) => {
    // the barrier opens while a truck or a car is passing through
    let near = false;
    const w = getWorld();
    for (const t of Object.values(w.trucks)) {
      if (t.phase === 'away') continue;
      const p = toPark(t.facilityId, t.pos);
      if (Math.abs(p.x - g.lane.x) < 6 && Math.abs(p.z - g.lane.z) < 20) { near = true; break; }
    }
    if (!near) {
      for (const v of Object.values(w.retail?.vans ?? {})) {
        if (v.status === 'IDLE') continue;
        if (Math.abs(v.pos.x - g.lane.x) < 8 && Math.abs(v.pos.z - g.lane.z) < 18) { near = true; break; }
      }
    }
    if (!near) {
      for (const v of getPark().vehicles) {
        const p = vehicleNow(v);
        if (Math.abs(p.x - g.lane.x) < 6 && Math.abs(p.z - g.lane.z) < 18) { near = true; break; }
      }
    }
    const target = near ? 1 : 0;
    lift.current += (target - lift.current) * Math.min(1, dt * 5);
    if (arm.current) arm.current.rotation.z = (west ? -1 : 1) * lift.current * 1.35;
  });
  const boothX = g.pos.x, z = g.pos.z;
  const pivotX = west ? ART_W + ART_HALF + 0.6 : ART_E - ART_HALF - 0.6;
  return (
    <group>
      <group position={[boothX, 0, z]} {...handlers} name={`gate-${code}`}>
        <Box p={[0, 1.6, 0]} s={[4, 3.2, 5]} c={C.white} />
        <Box p={[0, 2.3, 0]} s={[4.06, 1.1, 5.06]} c={C.glass} shadow={false} />
        <Box p={[0, 3.45, 0]} s={[5.2, 0.3, 6.2]} c="#4b5563" />
        <Box p={[0, 3.9, 0]} s={[5.2, 0.6, 0.2]} c={west ? '#2f9e44' : '#e8590c'} shadow={false} />
      </group>
      <Box p={[pivotX, 0.6, z]} s={[0.7, 1.2, 0.7]} c="#4b5563" />
      <group ref={arm} position={[pivotX, 1.15, z]}>
        <Box p={[west ? -3.3 : 3.3, 0, 0]} s={[6.6, 0.22, 0.22]} c="#e03131" shadow={false} />
        {[-1, -3, -5].map((o) => <Box key={o} p={[west ? o : -o, 0, 0]} s={[0.8, 0.24, 0.24]} c="#ffffff" shadow={false} />)}
      </group>
      {/* stop line */}
      <Flat x={west ? ART_W + 3.5 : ART_E - 3.5} z={z + (west ? 3 : -3)} w={6.4} d={0.5} color={LINE} y={0.06} />
    </group>
  );
}

// ---------------------------------------------------------------- traffic
function Vehicle({ v }: { v: ParkVehicle }) {
  const g = useRef<THREE.Group>(null);
  const handlers = useSelectHandlers({ kind: 'vehicle', id: v.id });
  useFrame(() => {
    const p = vehicleNow(v);
    if (!g.current) return;
    g.current.position.set(p.x, 0, p.z);
    g.current.rotation.y = -p.heading;
  });
  const company = findCompany(v.companyId);
  const accent = company?.color ?? v.color;
  return (
    <group ref={g} {...handlers} name={`vehicle-${v.id}`}>
      {v.kind === 'CAR' && <CarModel color={v.color} />}
      {v.kind === 'VAN' && <VanModel color={v.color} />}
      {v.kind === 'BUS' && <BusModel color={v.color} />}
      {(v.kind === 'TRUCK' || v.kind === 'TANKER') && <RigModel color={accent} tanker={v.kind === 'TANKER'} />}
      {v.kind === 'TAXI' && <TaxiModel color={v.color} />}
      {v.kind === 'TRACTOR' && <TractorModel color={v.color} box={['#1971c2', '#d9480f', '#2b8a3e', '#5f3dc4'][Number(v.id.slice(-1)) % 4]} />}
    </group>
  );
}

// ---------------------------------------------------------------- the park
export function ParkScene() {
  useApp((s) => s.parkVersion);
  const park = getPark();
  return (
    <group>
      <Flat x={-200} z={0} w={2600} d={1500} color={C.ground} y={0} />
      <Lawns />
      <Roads />
      <Signs />
      <Trees />
      <Scenery />
      <People />
      <BeachProps />
      {park.buildings.filter((b) => !b.facilityId && b.kind !== 'GATEHOUSE').map((b) => <NeighbourBuilding key={b.id} b={b} />)}
      <Gate code="WEST" />
      <Gate code="EAST" />
      {park.vehicles.map((v) => <Vehicle key={v.id} v={v} />)}
      <PortScene />
    </group>
  );
}

export const OVERVIEW_TARGET = { x: -60, z: 150 };
export { HWY_X0, HWY_X1 };
