// AI operations agents.
//  1. Exception watcher — scans live operations for problems (late shipments, forklifts low
//     on battery mid-job, trucks stuck at the gate, low stock, blocked tasks) and proposes a task.
//  2. Operations assistant — see ./assistant.ts (Claude tool use, database questions, demo mode).
import type { FacilityId, EntityRef, WorldState } from '../src/data/types';
import type { SessionUser, TaskType, Priority, Task } from '../src/api/types';
import { SKUS, carrierName } from '../src/data/seed';
import { deliveryWatch, forkliftActivity } from '../src/ui/derive';
import { AppError, type Repo } from './db/repo';

// ---------------------------------------------------------------- exception watcher

export interface Alert {
  id: string;
  facilityId: FacilityId;
  severity: 'high' | 'medium' | 'low';
  kind: 'late_shipment' | 'low_battery' | 'gate_wait' | 'low_stock' | 'blocked_task';
  title: string;
  detail: string;
  ref: EntityRef | null;
  suggestion: { title: string; description: string; type: TaskType; priority: Priority; truckId?: string; dockId?: string; jobCode: string } | null;
}

const SEV_ORDER = { high: 0, medium: 1, low: 2 };

export async function computeAlerts(w: WorldState, repo: Repo, facilities: FacilityId[]): Promise<Alert[]> {
  const out: Alert[] = [];
  for (const fac of facilities) {
    const f = w.facilities[fac];
    if (!f) continue;
    for (const d of deliveryWatch(w, fac)) {
      if (d.label !== 'At risk') continue;
      const t = w.trucks[d.truckId];
      out.push({
        id: `late_shipment:${d.id}`, facilityId: fac, severity: 'high', kind: 'late_shipment',
        title: `Shipment #${d.id} may miss its promised time`, detail: `${d.truckId} · ${d.text}`,
        ref: { kind: 'truck', id: d.truckId },
        suggestion: {
          title: `Expedite ${d.truckId} (#${d.id})`, type: 'DOCK_CHECK', priority: 'URGENT', truckId: d.truckId, dockId: t?.dockId ?? undefined,
          description: `Shipment #${d.id} is running late (${d.text}). Free up a forklift or dock and notify the customer if it will still miss the window.`,
          jobCode: 'DOCK_SUPERVISOR',
        },
      });
    }
    for (const fl of Object.values(w.forklifts)) {
      if (fl.facilityId !== fac || !fl.truckId || fl.battery >= 30) continue;
      out.push({
        id: `low_battery:${fl.id}`, facilityId: fac, severity: fl.battery < 20 ? 'high' : 'medium', kind: 'low_battery',
        title: `${fl.id} is at ${Math.round(fl.battery)}% battery mid-job`, detail: forkliftActivity(w, fl).text,
        ref: { kind: 'forklift', id: fl.id },
        suggestion: {
          title: `Swap in a charged forklift for ${fl.id}`, type: 'MAINTENANCE', priority: 'HIGH', truckId: fl.truckId,
          description: `${fl.id} is below 30% while working on ${fl.truckId}. Send it to charger ${fl.chargerId.split('-').pop()} after this pallet and hand the job to a charged forklift.`,
          jobCode: 'FORKLIFT_OPERATOR',
        },
      });
    }
    for (const t of Object.values(w.trucks)) {
      if (t.facilityId !== fac || t.phase !== 'at_gate') continue;
      out.push({
        id: `gate_wait:${t.id}`, facilityId: fac, severity: 'medium', kind: 'gate_wait',
        title: `${t.id} is waiting at the gate`, detail: t.dockId ? `Booked for ${w.docks[t.dockId]?.name} — yard lane busy` : 'No free dock for its direction',
        ref: { kind: 'truck', id: t.id },
        suggestion: {
          title: `Clear a dock for ${t.id}`, type: 'DOCK_CHECK', priority: 'HIGH', truckId: t.id, dockId: t.dockId ?? undefined,
          description: `${t.id} (${carrierName(t.carrier)}) is held at the gate. Check which dock can be freed first and guide the truck in.`,
          jobCode: 'DOCK_SUPERVISOR',
        },
      });
    }
    for (const l of f.inventory) {
      if (l.units >= l.lowBelow) continue;
      const name = SKUS[l.skuId]?.name ?? l.skuId;
      out.push({
        id: `low_stock:${fac}:${l.skuId}`, facilityId: fac, severity: l.units < l.lowBelow * 0.5 ? 'high' : 'low', kind: 'low_stock',
        title: `${name} is below its reorder level`, detail: `${l.units.toLocaleString()} units on hand, reorder at ${l.lowBelow.toLocaleString()}`,
        ref: null,
        suggestion: {
          title: `Reorder ${name}`, type: 'CYCLE_COUNT', priority: 'NORMAL',
          description: `Count ${name} on hand at ${f.name}, confirm the shortfall against the system (${l.units} units vs reorder level ${l.lowBelow}) and raise a replenishment order.`,
          jobCode: 'INVENTORY_CLERK',
        },
      });
    }
  }
  const blocked = (await repo.listTasks({ facilities, includeClosed: false, limit: 200 })).filter((t) => t.status === 'BLOCKED');
  for (const t of blocked) {
    out.push({
      id: `blocked_task:${t.id}`, facilityId: t.facilityId, severity: t.priority === 'URGENT' || t.priority === 'HIGH' ? 'high' : 'medium',
      kind: 'blocked_task', title: `Task blocked: ${t.title}`, detail: `${t.assigneeName ?? 'Unassigned'} — “${t.lastNote ?? 'no reason given'}”`,
      ref: t.truckId ? { kind: 'truck', id: t.truckId } : null, suggestion: null,
    });
  }
  return out.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
}

/** Creates the suggested task for an alert, assigned to someone with the matching job at that site. */
export async function taskFromAlert(w: WorldState, repo: Repo, user: SessionUser, alertId: string, assigneeId: number | null): Promise<Task | null> {
  const alerts = await computeAlerts(w, repo, user.facilities);
  const a = alerts.find((x) => x.id === alertId);
  if (!a) throw new AppError(404, 'This alert has already cleared');
  if (!a.suggestion) throw new AppError(400, 'This alert has no suggested task');
  let assignee = assigneeId;
  if (assignee === null) {
    const staff = (await repo.listEmployees([a.facilityId])).filter((e) => e.status === 'ACTIVE' && e.jobCode === a.suggestion!.jobCode);
    staff.sort((x, y) => x.openTasks - y.openTasks);
    assignee = staff[0]?.id ?? null;
  }
  const id = await repo.createTask(user.userId, {
    facilityId: a.facilityId, title: a.suggestion.title, description: `${a.suggestion.description}\n\nRaised from alert: ${a.title}.`,
    type: a.suggestion.type, priority: a.suggestion.priority, assigneeId: assignee, truckId: a.suggestion.truckId ?? null,
    dockId: a.suggestion.dockId ?? null, dueMinutes: a.severity === 'high' ? 20 : 60, source: 'MANUAL',
  });
  return repo.getTask(id);
}

// The operations assistant lives in ./assistant.ts
export { runAssistant, assistantConfigured, type ChatTurn } from './assistant';
