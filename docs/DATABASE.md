# CargoVerse database (Oracle)

CargoVerse stores everything in an Oracle database: people and their access rights,
the fleet, shipments, inventory, the work assigned to staff, and a permanent history
of every change. The scripts live in `db/oracle/` and work on Oracle Database 19c, 21c
and 23ai (including the free editions).

| Script | What it does |
| --- | --- |
| `00_create_user.sql` | Optional: creates the `WARETRACK` schema owner (run as `SYSTEM`) |
| `01_schema.sql` | 44 tables with primary/foreign keys, check constraints, identity columns, virtual columns, function-based unique indexes and comments |
| `02_plsql.sql` | Packages `WT_CORE`, `WT_AUTH`, `WT_WORK`, `WT_PARK`, `WT_PORT`, `WT_RETAIL` and 14 triggers |
| `03_views.sql` | 17 views used by the KPIs, reports, the park directory, the import/export log, the port and the stores |
| `04_seed.sql` | Seed data (generated from the app's data by `npm run db:gen-seed`) |
| `05_reports.sql` | 25 sample queries: joins, ROLLUP, HAVING, window functions, PIVOT, anti-joins, MINUS, date arithmetic and the PL/SQL API. They also appear in the app's SQL console |
| `99_drop_all.sql` | Removes every CargoVerse object |

## Entity–relationship diagram

```mermaid
erDiagram
    ROLES ||--o{ ROLE_PERMISSIONS : grants
    PERMISSIONS ||--o{ ROLE_PERMISSIONS : "granted by"
    ROLES ||--o{ APP_USERS : "role of"
    JOB_TITLES ||--o{ EMPLOYEES : "job of"
    FACILITIES ||--o{ EMPLOYEES : "home site of"
    EMPLOYEES ||--o| APP_USERS : "signs in as"
    APP_USERS ||--o{ USER_FACILITY_ACCESS : "may access"
    FACILITIES ||--o{ USER_FACILITY_ACCESS : "accessible by"
    APP_USERS ||--o{ USER_SESSIONS : "has"

    FACILITIES ||--o{ DOCKS : has
    FACILITIES ||--o{ CHARGERS : has
    FACILITIES ||--o{ INVENTORY : stocks
    SKUS ||--o{ INVENTORY : "stocked as"
    FACILITIES ||--o{ STOCK_MOVEMENTS : "ledger of"
    SKUS ||--o{ STOCK_MOVEMENTS : moves

    CARRIERS ||--o{ DRIVERS : employs
    CARRIERS ||--o{ TRUCKS : operates
    DRIVERS ||--o{ TRUCKS : drives
    FACILITIES ||--o{ TRUCKS : serves
    DOCKS |o--o| TRUCKS : "occupied by"
    TRUCKS ||--o{ SHIPMENTS : carries
    SKUS ||--o{ SHIPMENTS : contains

    FACILITIES ||--o{ FORKLIFTS : has
    EMPLOYEES |o--o{ FORKLIFTS : operates
    CHARGERS ||--|| FORKLIFTS : charges
    FORKLIFTS |o--o| PALLETS : carries
    FACILITIES ||--o{ PALLETS : holds
    SKUS ||--o{ PALLETS : "packed on"

    FACILITIES ||--o{ TASKS : "work at"
    EMPLOYEES |o--o{ TASKS : "assigned to"
    APP_USERS |o--o{ TASKS : "created by"
    TASKS ||--o{ TASK_UPDATES : "history of"
    TRUCKS |o--o{ TASKS : about
    DOCKS |o--o{ TASKS : at

    FACILITIES ||--o{ OPERATION_EVENTS : "events at"
    APP_USERS |o--o{ AUDIT_LOG : "changes by"

    PARK_COMPANIES ||--o{ PARK_BUILDINGS : "leases"
    FACILITIES |o--o| PARK_BUILDINGS : "housed in"
    PARK_COMPANIES |o--o{ PARK_VEHICLES : owns
    PARK_ROUTES ||--o{ PARK_VEHICLES : "driven by"
    PARK_BUILDINGS ||--o| PARK_GATES : "gatehouse of"
    PARK_GATES ||--o{ PARK_GATE_LOG : records
    TRUCKS ||--o{ PARK_GATE_LOG : "passes"
    FACILITIES ||--o{ PARK_GATE_LOG : "imports/exports of"
    SKUS |o--o{ PARK_GATE_LOG : carries
    SHIPMENTS |o--o{ PARK_GATE_LOG : "moved by"

    SHIPPING_LINES ||--o{ VESSELS : operates
    PARK_BUILDINGS ||--o{ PORT_BERTHS : "quay of"
    PORT_BERTHS |o--o| VESSELS : "alongside"
    PORT_BERTHS ||--o{ QUAY_CRANES : "worked by"
    VESSELS ||--o{ VESSEL_CALLS : "calls"
    SHIPPING_LINES ||--o{ CONTAINER_MOVES : "boxes of"
    VESSELS |o--o{ CONTAINER_MOVES : "discharged / loaded"
    QUAY_CRANES |o--o{ CONTAINER_MOVES : lifts
    TRUCKS |o--o{ CONTAINER_MOVES : "collects / delivers"
    YARD_BLOCKS ||--o{ YARD_CONTAINERS : stacks

    PARK_BUILDINGS ||--o| STORES : houses
    FACILITIES ||--o{ STORES : "usually supplies"
    STORES ||--o{ STORE_STOCK : shelves
    SKUS ||--o{ STORE_STOCK : "sold as"
    STORE_STOCK ||--o{ STORE_ORDERS : "restocked by"
    FACILITIES ||--o{ STORE_ORDERS : "ships"
    DELIVERY_VANS |o--o{ STORE_ORDERS : delivers
    FACILITIES ||--o{ DELIVERY_VANS : "depot of"
    STORE_ORDERS ||--o{ STORE_ORDER_HISTORY : "history of"
```

## The logistics park, imports and exports

The three CargoVerse sites sit in the **Harborside Logistics Park** with ten other companies:
a car-parts plant, a bottling plant, a solar-panel factory, a cold store, a medical-supplies
warehouse, a grocery warehouse, an office tower, a fuel station, the park authority and the
Port Newark container terminal. All of these are rows in the database:

| Table | Holds |
| --- | --- |
| `PARK_COMPANIES` | Tenants, their industry, contact and brand colour. At most one company is the logistics operator (function-based unique index `UX_COMPANY_OPERATOR`) |
| `PARK_BUILDINGS` | Every building on the map: position, size, floors, staff, status and lease. `FLOOR_AREA_M2` is a virtual column. Rows with `FACILITY_ID` are CargoVerse's own sites |
| `PARK_ROUTES`, `PARK_VEHICLES` | The roads' traffic: cars, vans, a shuttle bus, tenants' trucks and public traffic, each on a route at a speed |
| `PARK_GATES` | The West Gate (imports in) and East Gate (exports out) |
| `PARK_GATE_LOG` | **Every CargoVerse truck through a gate**: direction, `IMPORT` / `EXPORT` / `EMPTY`, product and pallets |

Rules in the database:
- `CK_GL_GATE_DIR`: trucks only enter at the West Gate and leave at the East Gate.
- `CK_GL_CARGO`: an import must come in loaded, an export must leave loaded, and an empty
  move carries 0 pallets.
- `TRG_GATE_LOG_AI` keeps `FACILITIES.IMPORTS_TODAY / EXPORTS_TODAY` (and the pallet counts) in
  step with the log, the same way the stock ledger keeps stock totals.
- `WT_PARK.UPDATE_BUILDING` needs `MANAGE_PARK` and refuses to mark a running CargoVerse
  site as vacant or under construction. Leases cannot end before they start.
  `TRG_PARK_BUILDINGS_AUDIT` writes every change to the audit log.
- `V_TRADE_TODAY` (imports vs exports per site), `V_GATE_LOG` and `V_PARK_DIRECTORY` feed the
  dashboards.

## The container port

Ships call at the Port Newark terminal on the bay; four quay cranes work the two berths.

| Table | Holds |
| --- | --- |
| `SHIPPING_LINES` | Lines whose boxes pass through, with the ISO 6346 owner code (`CK_LINE_OWNER`: line code + `U`) |
| `PORT_BERTHS` | The two berths, open or closed, and the ship alongside |
| `VESSELS` | Each ship: line, IMO number, status (`AT_SEA` → `ARRIVING` → `ANCHORED` → `BERTHING` → `BERTHED` → `DEPARTING`), boxes to discharge and loaded, hold flag, position |
| `QUAY_CRANES` | Crane per berth, what it is doing and its moves today |
| `VESSEL_CALLS` | One row per port call: berthed, sailed, boxes off and on. `CALL_STATUS` is a virtual column |
| `CONTAINER_MOVES` | **The container ledger**: every lift off a ship (`DISCHARGE`), onto a ship (`LOAD`), and every box through the terminal gate (`GATE_OUT` by truck to a warehouse, `GATE_IN` for export). `LINE_CODE` is a virtual column with a foreign key to `SHIPPING_LINES` |
| `YARD_BLOCKS`, `YARD_CONTAINERS` | The import and export stacks and the boxes in them now |

Rules in the database:
- `TRG_CONTAINER_MOVES_BI` rejects any container number whose ISO 6346 check digit is wrong
  (`WT_PORT.CHECK_DIGIT` computes it in PL/SQL).
- `TRG_CONTAINER_MOVES_AI` keeps `YARD_CONTAINERS` in step with the ledger: discharged and gated-in
  boxes are stacked, loaded and gated-out boxes leave the stack.
- `CK_MOVE_SHIP`: ship moves need a ship and a crane; gate moves have neither.
- `WT_PORT.LOG_CALL` opens and closes `VESSEL_CALLS`; `WT_PORT.SET_VESSEL_HOLD` and
  `WT_PORT.SET_BERTH_OPEN` need `MANAGE_PORT`, keep at least one berth open and write the audit log.
- `SHIPMENTS.TRADE_LANE` / `CONTAINER_NO` (and `TRUCKS.TRADE_LANE`) mark sea freight: an import
  collected at the terminal or an export taken there, with `CK_SHIP_CONTAINER` requiring a valid
  container number for `SEA` and none for `ROAD`.
- Views: `V_VESSEL_SCHEDULE`, `V_PORT_BERTHS`, `V_YARD_SUMMARY`, `V_CONTAINER_MOVES`.

## Vendor stores and deliveries

| Table | Holds |
| --- | --- |
| `STORES` | Supermarkets and shops in Port Harbor, the building they occupy and their usual supplying warehouse |
| `STORE_STOCK` | Shelf stock per store and product, reorder point, maximum, sales rate. `STOCK_STATUS` is a virtual column (`OK` / `REORDER` / `EMPTY`) |
| `STORE_ORDERS` | Restock orders on the warehouses: `PLACED` → `LOADING` → `OUT_FOR_DELIVERY` → `DELIVERED` (or `CANCELLED`), automatic or placed by a manager |
| `STORE_ORDER_HISTORY` | Every status change of every order (written by `TRG_STORE_ORDERS_AIU`) |
| `DELIVERY_VANS` | CargoVerse vans and box trucks, their depot, status and current order |

Rules in the database:
- `FK_SO_LINE` is a composite foreign key `(STORE_ID, SKU_ID)` onto `STORE_STOCK`: a store can only
  order products it sells.
- `CK_SO_VAN`: an order being loaded or delivered must have a van; `CK_VAN_ORDER`: a van is idle
  exactly when it has no order.
- Loading a van takes the units off the warehouse through the stock ledger
  (`STOCK_MOVEMENTS.REASON = 'STORE_SHIP'`), so `TRG_STOCK_MOVEMENTS_AI` updates `INVENTORY`.
- `TRG_STORE_ORDERS_BIU` stamps dispatch and delivery times.
- `WT_RETAIL.PLACE_ORDER` / `CANCEL_ORDER` need `MANAGE_RETAIL`, refuse a second open order for
  the same shelf line, check the warehouse has the units, and write the audit log.
  `WT_RETAIL.BEST_SUPPLIER` and `WT_RETAIL.COVER_HOURS` are helper functions.
- Views: `V_STORE_STOCK`, `V_STORE_ORDERS`, `V_DELIVERY_FLEET`. Reports 19–26 in `05_reports.sql`
  cover port throughput, turnaround, container tracing, yard occupancy, store stock and deliveries.

## Database workspace in the app

Administrators and managers have a **Database** tab in the Work panel:
- **Tables**: every table with its row count, columns, keys, constraints, indexes and first rows,
  read live from Oracle's data dictionary (`USER_TABLES`, `USER_TAB_COLS`,
  `USER_CONSTRAINTS`…). It also shows the compile status of every view, trigger and package.
- **SQL console** (administrators only): runs one `SELECT` / `WITH` statement inside
  `SET TRANSACTION READ ONLY`, so Oracle itself rejects any change. The console caps results at 500
  rows and cancels a query after 15 s. Every query is recorded in the audit log, and
  the examples from `05_reports.sql` are one click away.
- **SQL activity**: the statements the server has sent to Oracle, with timings, including
  the live-operations writes every 2 seconds.

## Design notes

**Normalization.** The schema is in third normal form. Lookups are separate tables:
roles, permissions, job titles, carriers, drivers and SKUs. Many-to-many relationships
use junction tables (`ROLE_PERMISSIONS`, `USER_FACILITY_ACCESS`). Facts depend only on
their key: a truck row holds the truck's own data, and the carrier name lives in
`CARRIERS`.

**Controlled denormalization.** `FACILITIES.STOCK_PALLETS` and `INVENTORY.UNITS` are
running totals. They are never written directly. Every change is a row in
`STOCK_MOVEMENTS`, and the trigger `TRG_STOCK_MOVEMENTS_AI` keeps the totals in step,
so stock is always traceable to its movements. Report 5 rebuilds the running total from
the ledger with a window function.

**People vs. accounts.** `EMPLOYEES` holds who someone is and their job (Forklift
Operator, Dock Supervisor…). `APP_USERS` holds how they sign in and their access role
(Administrator, Manager, Operator). An employee can exist without a login, for example
a driver. Access rights come from the role (`ROLE_PERMISSIONS`) plus the sites granted
in `USER_FACILITY_ACCESS`.

**Integrity rules enforced by the database:**
- Check constraints: valid statuses and priorities; cargo between 0 and capacity;
  battery 0–100 %; stock ≥ 0; lower-case usernames; scrypt-format password hashes;
  JSON columns validated with `IS JSON`.
- `CK_TASK_ASSIGNED`: a task that is assigned, in progress, blocked or done must have
  an assignee.
- `UX_PALLET_SLOT`: a function-based unique index, so a yard slot holds one pallet at a time.
- `CK_PAL_PLACE`: a pallet is either in a yard slot or on a forklift, never both. The
  virtual column `PALLET_STATUS` derives STAGED / IN_TRANSIT from that.
- Circular references (truck ↔ dock, forklift ↔ pallet, truck ↔ current shipment) use
  `DEFERRABLE INITIALLY DEFERRED` foreign keys, so a whole state change commits atomically.

**Business rules in PL/SQL.** The API calls these procedures instead of updating
tables directly, so the same rules apply no matter which client changes the data:

| Procedure | Rule it enforces |
| --- | --- |
| `WT_WORK.CREATE_TASK` | Caller needs `MANAGE_TASKS` and access to the site; the assignee must be an active employee of that site |
| `WT_WORK.CHANGE_STATUS` | Allowed transitions only (e.g. ASSIGNED → IN_PROGRESS → DONE). Operators may only move their own tasks, and only Start / Block / Resume / Complete |
| `WT_WORK.ASSIGN` | Managers re-assign within their sites; closed tasks cannot be re-assigned |
| `WT_AUTH.CREATE_USER` / `UPDATE_USER` | Needs `MANAGE_USERS`; admins cannot deactivate or demote themselves; deactivating revokes the user's sessions |
| `WT_AUTH.RECORD_LOGIN` / `CREATE_SESSION` / `REVOKE_SESSION` | Sign-in history, failed attempts and sessions |

Errors come back as `ORA-20001…20006`, and the API turns them into clear messages.

**Audit trail.** At the start of each transaction the API runs
`DBMS_SESSION.SET_IDENTIFIER(user_id)`. The audit triggers on `TASKS`, `APP_USERS`,
`USER_FACILITY_ACCESS`, `EMPLOYEES` and `SIM_STATE` read it through
`SYS_CONTEXT('USERENV','CLIENT_IDENTIFIER')`. Every human change is therefore written
to `AUDIT_LOG` together with who made it, inside the same transaction. Password hashes
are never written to the log. Administrators see the full log. Managers see entries for
their own sites (`V_AUDIT_FEED`).

**Operations data.** The server runs the live yard: trucks, docks, forklifts and pallets.
Every 2 seconds it writes changes in one transaction:
- `MERGE` for shipments and pallets;
- `UPDATE` for trucks, forklifts, docks and chargers;
- `INSERT` into the `STOCK_MOVEMENTS` and `OPERATION_EVENTS` ledgers.

Trucks passing a park gate add a row to `PARK_GATE_LOG` in the same transaction.
On restart it rebuilds the yard from these tables. When a forklift starts on a truck,
the server calls `WT_WORK.CREATE_TASK` to give that forklift's operator an
Unload or Load task. When the truck is finished, the task is completed.

## Roles and rights

| Permission | Administrator | Manager | Operator |
| --- | :-: | :-: | :-: |
| View live dashboard | ✓ | ✓ | ✓ |
| Access every site | ✓ | assigned sites | home site |
| Create / assign / cancel tasks | ✓ | ✓ | – |
| Start / block / complete own tasks | ✓ | ✓ | ✓ |
| See audit history | all sites | own sites | – |
| Team & workload, SQL reports | ✓ | ✓ | – |
| Pause / resume / speed up operations | ✓ | ✓ | – |
| Create users, change roles and site access, reset passwords | ✓ | – | – |
| Imports / exports and the park directory | all sites | own sites | own site |
| Edit park tenants (status, staff, lease) | ✓ | – | – |
| Browse the database schema (Database tab) | ✓ | ✓ | – |
| Run SQL in the read-only console, see SQL activity | ✓ | – | – |

**Sign-in.** Passwords are stored as scrypt hashes. "Keep me signed in" sessions last
30 days and are renewed each time they're used, so an active user stays signed in
indefinitely. Signing out, or an admin deactivating the account, ends the session
straight away.

## Connecting with SQL Developer

* Host `localhost`, port `1521`, service name `FREEPDB1`
* User `waretrack`, password `WareTrack_2026` (or what you set in `docker-compose.yml` / `.env`)

The project was once called WareTrack. The database user, its password, the Docker container
(`waretrack-oracle`) and volume keep that original name so existing databases and connections
keep working; so do internal keys such as the company id `WARETRACK` and carrier `WareTrack`.

Then open `db/oracle/05_reports.sql` and run the queries.
