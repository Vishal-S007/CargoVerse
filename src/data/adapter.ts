// Data-access boundary. The UI and simulation only talk to `WarehouseDataSource`.
// Today it is backed by local demonstration data persisted in localStorage.
// A future SQL-backed REST/GraphQL adapter implements the same interface,
// so neither the 3D scene nor the interface needs to change.
import type { WorldState, FacilityId, EntityRef } from './types';
import { createSeedWorld, WORLD_VERSION } from './seed';

export interface UiSnapshot {
  facilityId: FacilityId;
  selection: EntityRef | null;
  fleetTab: 'docks' | 'forklifts' | 'trucks';
  readEvents: number;
}

export interface WarehouseDataSource {
  loadWorld(): Promise<WorldState>;
  saveWorld(world: WorldState): Promise<void>;
  resetWorld(): Promise<WorldState>;
  loadUi(): Promise<Partial<UiSnapshot>>;
  saveUi(ui: UiSnapshot): Promise<void>;
}

const WORLD_KEY = 'waretrack.world';
const UI_KEY = 'waretrack.ui';

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: keep running in memory */ }
}

export class LocalDemoDataSource implements WarehouseDataSource {
  async loadWorld(): Promise<WorldState> {
    const raw = safeGet(WORLD_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as WorldState;
        if (parsed && parsed.version === WORLD_VERSION && parsed.trucks) return parsed;
      } catch { /* fall through to seed */ }
    }
    return createSeedWorld();
  }
  async saveWorld(world: WorldState): Promise<void> {
    safeSet(WORLD_KEY, JSON.stringify(world));
  }
  async resetWorld(): Promise<WorldState> {
    try { localStorage.removeItem(WORLD_KEY); localStorage.removeItem(UI_KEY); } catch { /* ignore */ }
    return createSeedWorld();
  }
  async loadUi(): Promise<Partial<UiSnapshot>> {
    const raw = safeGet(UI_KEY);
    if (!raw) return {};
    try { return JSON.parse(raw) as Partial<UiSnapshot>; } catch { return {}; }
  }
  async saveUi(ui: UiSnapshot): Promise<void> {
    safeSet(UI_KEY, JSON.stringify(ui));
  }
}

export const dataSource: WarehouseDataSource = new LocalDemoDataSource();
