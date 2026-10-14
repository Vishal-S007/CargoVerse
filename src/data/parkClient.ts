// Client-side copy of the park records (loaded from Oracle through /api/park; the
// built-in seed is used offline) and the clock that drives public traffic.
import type { ParkData } from '../api/types';
import { PARK_COMPANIES, PARK_BUILDINGS, PARK_VEHICLES, vehiclePose, type ParkBuilding, type ParkVehicle, type ParkCompany } from './park';

let park: ParkData = { companies: PARK_COMPANIES, buildings: PARK_BUILDINGS, vehicles: PARK_VEHICLES };
let version = 0;
export const getPark = (): ParkData => park;
export const parkVersion = (): number => version;
export function setPark(p: ParkData): void { park = p; version++; }
export const findBuilding = (id: string): ParkBuilding | undefined => park.buildings.find((b) => b.id === id);
export const findVehicle = (id: string): ParkVehicle | undefined => park.vehicles.find((v) => v.id === id);
export const findCompany = (id: string | null): ParkCompany | undefined => (id ? park.companies.find((c) => c.id === id) : undefined);

// Traffic follows the operations clock (it stops when operations are paused).
let base = { t: 0, at: 0, rate: 1 };
let last = 0;
export function syncParkClock(runTime: number, paused: boolean, speed: number): void {
  base = { t: runTime, at: performance.now(), rate: paused ? 0 : speed };
}
export function parkTime(): number {
  const t = base.t + Math.min(0.6, (performance.now() - base.at) / 1000) * base.rate;
  // never run backwards because of snapshot jitter (but follow real jumps, e.g. a reset)
  if (t < last && last - t < 1) return last;
  last = t;
  return t;
}
export function vehicleNow(v: ParkVehicle) { return vehiclePose(v, parkTime()); }
