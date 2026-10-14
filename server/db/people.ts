// Organisation seed data: roles, permissions, job titles, staff, login accounts,
// carriers and drivers. Used by the Oracle seed generator and the in-memory store,
// so both start from exactly the same records.
import type { FacilityId } from '../../src/data/types';
import type { Role, Permission, TaskType, Priority, TaskStatus } from '../../src/api/types';

export const ROLES: { code: Role; name: string; description: string }[] = [
  { code: 'ADMIN', name: 'Administrator', description: 'Full access: all facilities, user accounts, roles, audit history and system settings.' },
  { code: 'MANAGER', name: 'Operations Manager', description: 'Runs assigned facilities: plans and assigns work, monitors operations and reviews the activity history of their sites.' },
  { code: 'OPERATOR', name: 'Operator', description: 'Floor staff: sees their own facility and works through the tasks assigned to them.' },
];

export const PERMISSIONS: { code: Permission; description: string }[] = [
  { code: 'VIEW_DASHBOARD', description: 'View the live operations dashboard' },
  { code: 'VIEW_ALL_FACILITIES', description: 'Access every facility regardless of assignment' },
  { code: 'MANAGE_USERS', description: 'Create, edit, deactivate users and grant facility access' },
  { code: 'VIEW_AUDIT', description: 'Read the audit history of changes' },
  { code: 'MANAGE_TASKS', description: 'Create, assign, re-assign and cancel tasks' },
  { code: 'UPDATE_OWN_TASKS', description: 'Start, block and complete tasks assigned to oneself' },
  { code: 'CONTROL_SIMULATION', description: 'Pause, resume and change the speed of live operations' },
  { code: 'VIEW_REPORTS', description: 'View SQL reports and KPIs across facilities' },
  { code: 'VIEW_TEAM', description: 'View staff, job roles and workload' },
  { code: 'MANAGE_PARK', description: 'Edit park tenants: building status, staff numbers and leases' },
  { code: 'VIEW_DATABASE', description: 'Browse the Oracle schema: tables, columns, constraints, row counts' },
  { code: 'RUN_SQL', description: 'Run read-only SQL queries against the Oracle database' },
  { code: 'MANAGE_PORT', description: 'Container terminal: hold or release ships, open or close berths' },
  { code: 'MANAGE_RETAIL', description: 'Vendor stores: place and cancel restock orders on the warehouses' },
];

export const ROLE_PERMS: Record<Role, Permission[]> = {
  ADMIN: ['VIEW_DASHBOARD', 'VIEW_ALL_FACILITIES', 'MANAGE_USERS', 'VIEW_AUDIT', 'MANAGE_TASKS', 'UPDATE_OWN_TASKS', 'CONTROL_SIMULATION', 'VIEW_REPORTS', 'VIEW_TEAM', 'MANAGE_PARK', 'VIEW_DATABASE', 'RUN_SQL', 'MANAGE_PORT', 'MANAGE_RETAIL'],
  MANAGER: ['VIEW_DASHBOARD', 'VIEW_AUDIT', 'MANAGE_TASKS', 'UPDATE_OWN_TASKS', 'CONTROL_SIMULATION', 'VIEW_REPORTS', 'VIEW_TEAM', 'VIEW_DATABASE', 'MANAGE_PORT', 'MANAGE_RETAIL'],
  OPERATOR: ['VIEW_DASHBOARD', 'UPDATE_OWN_TASKS'],
};

export const JOB_TITLES: { code: string; title: string; responsibilities: string }[] = [
  { code: 'SYS_ADMIN', title: 'System Administrator', responsibilities: 'Manages user accounts, roles and facility access; reviews the full audit trail.' },
  { code: 'OPS_MANAGER', title: 'Operations Manager', responsibilities: 'Plans daily operations, assigns work to staff, monitors docks, inventory and on-time delivery.' },
  { code: 'DOCK_SUPERVISOR', title: 'Dock Supervisor', responsibilities: 'Coordinates truck arrivals, dock bookings, safety checks and loading sequences.' },
  { code: 'FORKLIFT_OPERATOR', title: 'Forklift Operator', responsibilities: 'Loads and unloads trucks, moves pallets between docks, yard slots and storage.' },
  { code: 'INVENTORY_CLERK', title: 'Inventory Clerk', responsibilities: 'Receives goods, performs cycle counts and keeps stock records accurate.' },
];

export interface SeedEmployee { id: number; name: string; email: string; phone: string; job: string; facility: FacilityId | null; hired: string }
export const EMPLOYEES: SeedEmployee[] = [
  { id: 1, name: 'Riya Sharma', email: 'riya.sharma@cargoverse.io', phone: '+1 201 555 0101', job: 'SYS_ADMIN', facility: null, hired: '2021-03-01' },
  { id: 2, name: 'Alex Chen', email: 'alex.chen@cargoverse.io', phone: '+1 201 555 0102', job: 'OPS_MANAGER', facility: 'WH-01', hired: '2021-06-14' },
  { id: 3, name: 'Meera Iyer', email: 'meera.iyer@cargoverse.io', phone: '+1 201 555 0103', job: 'OPS_MANAGER', facility: 'WH-02', hired: '2022-01-10' },
  { id: 4, name: 'Zoe Reyes', email: 'zoe.reyes@cargoverse.io', phone: '+1 248 555 0104', job: 'FORKLIFT_OPERATOR', facility: 'WH-04', hired: '2022-04-04' },
  { id: 5, name: 'Ben Okafor', email: 'ben.okafor@cargoverse.io', phone: '+1 248 555 0105', job: 'FORKLIFT_OPERATOR', facility: 'WH-04', hired: '2022-05-16' },
  { id: 6, name: 'Mia Park', email: 'mia.park@cargoverse.io', phone: '+1 248 555 0106', job: 'FORKLIFT_OPERATOR', facility: 'WH-04', hired: '2023-02-20' },
  { id: 7, name: 'Theo Grant', email: 'theo.grant@cargoverse.io', phone: '+1 248 555 0107', job: 'FORKLIFT_OPERATOR', facility: 'WH-04', hired: '2023-03-13' },
  { id: 8, name: 'Ivy Chen', email: 'ivy.chen@cargoverse.io', phone: '+1 248 555 0108', job: 'FORKLIFT_OPERATOR', facility: 'WH-04', hired: '2024-01-08' },
  { id: 9, name: 'Dana Brooks', email: 'dana.brooks@cargoverse.io', phone: '+1 973 555 0109', job: 'FORKLIFT_OPERATOR', facility: 'WH-01', hired: '2021-09-27' },
  { id: 10, name: 'Luis Romero', email: 'luis.romero@cargoverse.io', phone: '+1 973 555 0110', job: 'FORKLIFT_OPERATOR', facility: 'WH-01', hired: '2022-08-01' },
  { id: 11, name: 'Carla Mendes', email: 'carla.mendes@cargoverse.io', phone: '+1 973 555 0111', job: 'FORKLIFT_OPERATOR', facility: 'WH-02', hired: '2022-02-14' },
  { id: 12, name: 'Ravi Shah', email: 'ravi.shah@cargoverse.io', phone: '+1 973 555 0112', job: 'FORKLIFT_OPERATOR', facility: 'WH-02', hired: '2022-10-03' },
  { id: 13, name: 'Kofi Mensah', email: 'kofi.mensah@cargoverse.io', phone: '+1 973 555 0113', job: 'FORKLIFT_OPERATOR', facility: 'WH-02', hired: '2023-06-19' },
  { id: 14, name: 'Elena Rossi', email: 'elena.rossi@cargoverse.io', phone: '+1 973 555 0114', job: 'FORKLIFT_OPERATOR', facility: 'WH-02', hired: '2024-03-11' },
  { id: 15, name: 'Sam Patel', email: 'sam.patel@cargoverse.io', phone: '+1 248 555 0115', job: 'DOCK_SUPERVISOR', facility: 'WH-04', hired: '2021-11-22' },
  { id: 16, name: 'Owen Price', email: 'owen.price@cargoverse.io', phone: '+1 973 555 0116', job: 'DOCK_SUPERVISOR', facility: 'WH-01', hired: '2022-07-18' },
  { id: 17, name: 'Hana Sato', email: 'hana.sato@cargoverse.io', phone: '+1 973 555 0117', job: 'INVENTORY_CLERK', facility: 'WH-02', hired: '2023-09-05' },
  { id: 18, name: 'Leo Martin', email: 'leo.martin@cargoverse.io', phone: '+1 973 555 0118', job: 'INVENTORY_CLERK', facility: 'WH-01', hired: '2023-11-27' },
];

/** Forklift -> operator (employee id). */
export const FORKLIFT_OPERATORS: Record<string, number> = {
  'FL-01': 9, 'FL-02': 10, 'FL-10': 4, 'FL-11': 5, 'FL-12': 6, 'FL-13': 7, 'FL-14': 8,
  'FL-03': 11, 'FL-04': 12, 'FL-05': 13, 'FL-06': 14,
};

export const DEMO_PASSWORDS: Record<Role, string> = { ADMIN: 'Admin@123', MANAGER: 'Manager@123', OPERATOR: 'Operator@123' };

export interface SeedUser { id: number; username: string; role: Role; employeeId: number; facilities: FacilityId[] }
export const USERS: SeedUser[] = [
  { id: 1, username: 'admin', role: 'ADMIN', employeeId: 1, facilities: ['WH-01', 'WH-02', 'WH-04'] },
  { id: 2, username: 'alex.chen', role: 'MANAGER', employeeId: 2, facilities: ['WH-01', 'WH-04'] },
  { id: 3, username: 'meera.iyer', role: 'MANAGER', employeeId: 3, facilities: ['WH-02'] },
  { id: 4, username: 'zoe.reyes', role: 'OPERATOR', employeeId: 4, facilities: ['WH-04'] },
  { id: 5, username: 'dana.brooks', role: 'OPERATOR', employeeId: 9, facilities: ['WH-01'] },
  { id: 6, username: 'carla.mendes', role: 'OPERATOR', employeeId: 11, facilities: ['WH-02'] },
  { id: 7, username: 'sam.patel', role: 'OPERATOR', employeeId: 15, facilities: ['WH-04'] },
];

export const CARRIERS: { id: string; name: string; display: string; phone: string }[] = [
  { id: 'WARETRACK', name: 'WareTrack', display: 'CargoVerse Freight', phone: '+1 800 555 0190' },
  { id: 'BLUEPEAK', name: 'Bluepeak', display: 'Bluepeak', phone: '+1 800 555 0191' },
  { id: 'NORDLINE', name: 'Nordline', display: 'Nordline Logistics', phone: '+1 800 555 0192' },
  { id: 'CARGOVIVA', name: 'Cargoviva', display: 'Cargoviva', phone: '+1 800 555 0193' },
];
export const carrierId = (name: string): string => name.toUpperCase();

export interface SeedTask { facility: FacilityId; title: string; description: string; type: TaskType; priority: Priority; status: TaskStatus; assignee: number | null; createdBy: number; truck?: string; dock?: string; dueMinutes: number; note?: string }
export const SEED_TASKS: SeedTask[] = [
  { facility: 'WH-04', title: 'Inspect leveler at In 2 before TRK-2481 arrives', description: 'Check the hydraulic dock leveler and bumpers at In 2; report any damage before the Cargoviva truck docks.', type: 'DOCK_CHECK', priority: 'HIGH', status: 'ASSIGNED', assignee: 15, createdBy: 2, truck: 'TRK-2481', dock: 'WH-04-I2', dueMinutes: 20 },
  { facility: 'WH-04', title: 'Cycle count LED Panel 60×60', description: 'Count all LED Panel pallets in yard slots and storage; reconcile with system stock.', type: 'CYCLE_COUNT', priority: 'NORMAL', status: 'ASSIGNED', assignee: 4, createdBy: 2, dueMinutes: 120 },
  { facility: 'WH-04', title: 'Move staged plastic containers to storage', description: 'Put away the staged Plastic Container pallet from the yard into storage aisle C.', type: 'PUTAWAY', priority: 'LOW', status: 'OPEN', assignee: null, createdBy: 2, dueMinutes: 240 },
  { facility: 'WH-01', title: 'Replenish Safety Helmet stock', description: 'Safety Helmet is below the reorder level. Stage PAL-1026 for the next outbound order and raise a reorder request.', type: 'PUTAWAY', priority: 'URGENT', status: 'IN_PROGRESS', assignee: 18, createdBy: 2, dueMinutes: 45, note: 'Raised reorder RQ-5521; staging now.' },
  { facility: 'WH-01', title: 'Weekly brake check FL-02', description: 'Run the weekly brake and mast inspection on forklift FL-02 after charging.', type: 'MAINTENANCE', priority: 'NORMAL', status: 'ASSIGNED', assignee: 10, createdBy: 2, dueMinutes: 180 },
  { facility: 'WH-01', title: 'Confirm Bay 2 booking for Bluepeak', description: 'Confirm TRK-2287 (Bluepeak) arrival window and prepare Bay 2.', type: 'DOCK_CHECK', priority: 'NORMAL', status: 'ASSIGNED', assignee: 16, createdBy: 2, truck: 'TRK-2287', dock: 'WH-01-B2', dueMinutes: 30 },
  { facility: 'WH-02', title: 'Cycle count Office Chair', description: 'Count Office Chair pallets in yard slots S02–S03 and storage.', type: 'CYCLE_COUNT', priority: 'NORMAL', status: 'ASSIGNED', assignee: 17, createdBy: 3, dueMinutes: 90 },
  { facility: 'WH-02', title: 'Cardboard Box (M) below reorder level', description: 'Cardboard Box (M) units are below the reorder level; check incoming receipts and expedite.', type: 'OTHER', priority: 'HIGH', status: 'BLOCKED', assignee: 17, createdBy: 3, dueMinutes: 60, note: 'Waiting on supplier confirmation.' },
];

/** Driver names keyed by truck id (drivers belong to carriers). */
export const LICENSES: Record<string, string> = {
  'TRK-2051': 'NJ-D-4410281', 'TRK-2287': 'PA-D-7720904', 'TRK-2205': 'MI-D-5648120', 'TRK-2229': 'RI-D-5820331',
  'TRK-2307': 'MI-D-2897554', 'TRK-2481': 'MI-D-3157668', 'TRK-2127': 'NJ-D-2554907', 'TRK-2104': 'NY-D-8117302',
  'TRK-2658': 'PA-D-3620741', 'TRK-2526': 'NJ-D-9338215',
};
