# CargoVerse — 3D logistics operations on Oracle

A warehouse and logistics operations system:
- an isometric 3D map of a whole logistics park: three CargoVerse sites, ten neighbouring companies
  (plants, warehouses, a cold store, offices, a fuel station, the port container terminal), the
  highway and park roads with moving traffic;
- **imports and exports you can watch**: trucks bring goods in from the port through the West Gate,
  unload at the docks, and loaded trucks leave through the East Gate. Every gate pass is logged in Oracle;
- **a working container port**: ships arrive, wait at anchor, berth, and four quay cranes lift import
  containers off into the import stack and load export containers on. CargoVerse trucks collect import
  containers at the terminal and bring export containers to it. Every container move is in Oracle;
- **a town with vendor stores and supermarkets**: shoppers empty the shelves, stores reorder from the
  warehouses, and CargoVerse delivery vans load at the sites, drive to the stores and unload;
- sign-in with three access roles (Administrator, Operations Manager, Operator);
- work assigned to staff according to their job;
- a permanent audit trail. Everything is stored in **Oracle Database**;
- a **Database Lab** that shows what only a real database can do: drive the 3D city with an `UPDATE`
  typed in SQL Developer, rewind the whole city with **Oracle Flashback**, give every operator a database
  account that **Oracle itself** limits to their sites (**Virtual Private Database**), and replay
  **concurrency** problems — double booking, lost update, deadlock — with two real sessions;
- a **Smart Warehouse** where every pallet has a lot, a rack bin and a GS1 label, and Oracle decides what to
  pick (FEFO), where to store it (ABC slotting), when to stop (cold-chain breaches) and where a recalled lot went.

```
Browser (React + Three.js)  ──HTTP / live stream──▶  Node API server  ──node-oracledb──▶  Oracle Database
   login · 3D yard · tasks                          auth · roles · live ops              tables · PL/SQL · triggers · views
```

## Quick start on a Mac (Apple Silicon or Intel)

You need Node.js 18+ and Docker Desktop (or Colima) for the Oracle container.

```bash
git clone https://github.com/Vishal-S007/CargoVerse.git && cd CargoVerse
npm install                 # installs React, Three.js, Vite and the Oracle driver
cp .env.example .env        # then set SESSION_SECRET to any long random text
npm run db:up               # starts Oracle Database Free in Docker (first start: ~1–2 min)
npm run db:setup            # creates tables, PL/SQL, views and loads the seed data
                            # (already set up an older version? run npm run db:reset — it recreates everything)
npm run dev                 # API on :4000 + website on http://localhost:5173
```

Sign in with one of the demo accounts (shown on the login page):

| Role | Username | Password | Can do |
| --- | --- | --- | --- |
| Administrator | `admin` | `Admin@123` | Everything; manage users, roles and site access; full audit history |
| Operations Manager | `alex.chen` (Riverside + Southfield), `meera.iyer` (Northgate) | `Manager@123` | Assign and track work at their sites; see their sites' activity; reports; pause/speed operations |
| Operator | `zoe.reyes`, `dana.brooks`, `carla.mendes`, `sam.patel` | `Operator@123` | See their site; start, block and complete their own tasks |

Change these passwords (Users tab, signed in as admin) before showing the system to anyone else.

## Finding your way around

- The first view is the **whole park**. The map button (under the zoom controls) returns to it, the
  house button goes back to the current site, and the panels button hides the panels for a map-only view.
- Click anything: a site, a truck, a forklift, a neighbouring company's building, a car, a park gate.
  Each one opens a panel built from its database record. Trucks on the roads carry a tag: green for
  imports (goods in), orange for exports (goods out), grey when empty.
- **Work → Imports/Exports**: today's imports and exports per site (`v_trade_today`) and the gate log.
- **The port** (click the terminal, a ship or a crane): ships and their cargo, berths, cranes and the
  stacks. Managers and administrators can hold a ship at anchor or alongside, and close a berth.
- **The stores** (click a supermarket or shop in town): shelf stock per product with the reorder line,
  orders on the way and the van bringing them. Managers and administrators can place a restock order.
- **Work → Port & stores**: ships and port calls, the container log (search a container number to see
  its whole journey), stock across every store, and all store orders.
- **Work → Park**: the tenant directory. Administrators can edit a building's status, staff and lease.
  The change runs `WT_PARK.UPDATE_BUILDING` in Oracle and is audited.
- **Work → Database** (administrators and managers): browse every table, its columns, keys,
  constraints and rows, and the views, triggers and packages. Administrators also get a read-only
  **SQL console** with the example queries from `05_reports.sql`, and a log of the SQL the server runs.

## Database Lab

**Work → DB Lab** (administrators and managers) and the clock button in the header.
`npm run db:setup` installs it; on a database you already have, `npm run db:lab` adds it **without
touching your data**. Check it end to end with `npm run db:selftest` (about 30 checks, PASS/FAIL/SKIP).
A 5-minute presentation script is in [`docs/DEMO.md`](docs/DEMO.md).

| Feature | What you see | What Oracle does |
| --- | --- | --- |
| **Control the city from SQL** | Run `UPDATE port_berths SET is_open = 'N' WHERE berth_code = 'B1'; COMMIT;` in SQL Developer — within a second the berth closes in 3D and the next ship waits at anchor. Shelves, ships, forklifts, buildings, tasks and the simulation speed all react. | Row triggers (`TRG_EXT_*`) recognise changes not made by the server (`SYS_CONTEXT('USERENV','MODULE')`) and queue them in `DB_COMMANDS`; check constraints and triggers still reject bad values. |
| **Time machine** | Drag a slider up to 10 minutes back: every truck, ship, forklift, pallet and van returns to where it was. Replay at 4×. Row history for any ship, truck or forklift. | **Flashback Query** (`SELECT … AS OF SCN`) over 12 tables, and **Flashback Versions Query** (`VERSIONS BETWEEN TIMESTAMP`). No history tables. |
| **Row-level security** | Sign in to SQL Developer as `cv_zoe`, `cv_alex`, `cv_meera` or `cv_admin` (password `Cargo_2026`) and run the same `SELECT` — each sees only their own sites. | A **VPD policy** (`DBMS_RLS`, function `WT_SECURITY.SITE_FILTER`) on 15 tables adds `WHERE facility_id IN (…)` from the user's site access. It cannot be bypassed with a cleverer query. |
| **Concurrency lab** | Four experiments on a timeline: double booking (prevented), lost update (shown), the `FOR UPDATE` fix, and a deadlock. | Two real sessions; row locks, `SELECT … FOR UPDATE WAIT`, a unique key, and `ORA-00060` deadlock detection. |

Without Oracle (`npm run dev:memory`) every tab still works with simulated results, clearly labelled.

## Smart Warehouse

**Work → Warehouse** (everyone; actions need a manager). Each building has racks with bins (an *X-ray* view in 3D
takes the roof off), every pallet a lot and a GS1 SSCC label. Installed by `npm run db:lab` (`db:wms` is the same).

| Feature | What it does | Oracle / SQL |
| --- | --- | --- |
| **ABC slotting** | Ranks products by demand, re-slots fast movers next to the docks; walk per pick drops by about half | `RATIO_TO_REPORT`, running `SUM() OVER`, bins' distance over the aisle graph |
| **Lots & FEFO** | Every pick takes the lot that expires first; an audit lists any pick that did not | `WT_WMS.FEFO_LOT`, `RANK() OVER`, `V_FEFO_VIOLATIONS` (balance from the ledger) |
| **Recall trace** | Ship → container → lot → store order → store in one query; recall creates the tasks | Recursive `WITH … SEARCH DEPTH FIRST … CYCLE` over `V_TRACE_LINKS`, `WT_WMS.RECALL_LOT` |
| **Cold chain** | 2–8 °C cold room with sensors; prop the door open and watch the lots go on hold | `MATCH_RECOGNIZE`, interval-partitioned `SENSOR_READINGS`, `DBMS_SCHEDULER` job |
| **Tamper-proof ledger** | Every stock movement in a ledger nobody can edit | **Blockchain table** + `DBMS_BLOCKCHAIN_TABLE.VERIFY_ROWS` |
| **Forecast & reorder** | 14-day demand forecast, reorder point, safety stock, EOQ; raises purchase-order tasks | `MODEL` clause, `REGR_SLOPE`, `STDDEV` |
| **GS1 scanning** | Scan a pallet label (camera, USB scanner or click); the check digit is enforced in the database | `CHECK` constraint for the SSCC check digit, `WT_WMS.SCAN` |
| **Event stream** | Breaches, recalls, scans, receipts arrive the moment they are committed | **Transactional Event Queue** `CV_EVENTS` |
| **Pick route** | Shortest route through the aisles for a pick list, drawn on the floor | Dijkstra in PL/SQL, **SQL property graph** `GRAPH_TABLE` |
| **Semantic search** | "broken glass" finds "cracked diffusers" in the damage reports | **AI Vector Search**: `VECTOR(384)`, `VECTOR_DISTANCE` |

The features in bold need Oracle 23ai (the Docker image is 23ai); on older releases they are skipped and the
rest still works. For real sentence embeddings run `npm run ai:model` once (downloads the all-MiniLM-L6-v2 model,
about 25 MB, on first use); without it a built-in embedding is used.

## AI agents

Two agents sit in the **Work** panel (and the ✦ button in the header):

- **Exception watcher (Alerts tab — managers and admins).** It re-checks live operations every few seconds for:
  - shipments that will miss their promised time;
  - forklifts under 30 % battery in the middle of a job;
  - trucks held at the gate;
  - products below their reorder level;
  - blocked tasks.

  Each warning has a suggested task. **Create task** assigns it to the least-busy person with the right job at that site, e.g. the inventory clerk for low stock. No API key needed.
- **Operations assistant (Assistant tab — every role).** It can also answer questions about imports, exports and park tenants. Ask in plain language ("Which shipments are at risk?", "What should I do next?"). It uses Claude with tools that read the live data, can move the 3D view to what it is talking about, and — for managers, only when asked — creates tasks. Every tool is limited to the user's role and sites, and anything it creates is recorded in the audit trail like any other change.

  To turn it on, put `ANTHROPIC_API_KEY=…` in `.env` and restart. The key stays on the server.

## Other commands

| Command | What it does |
| --- | --- |
| `npm run dev:memory` | Run without Oracle (in-memory store saved to `.data/`), handy for UI work |
| `npm run build` then `npm start` | Production build; the API also serves the website on http://localhost:4000 |
| `npm run typecheck` | TypeScript checks for the website and the server |
| `npm run db:lab` | Install or update the Database Lab on the existing schema (keeps your data) |
| `npm run db:selftest` | Check the Database Lab and Smart Warehouse features against Oracle (PASS/FAIL/SKIP) |
| `npm run ai:model` | Install the sentence-transformer for semantic search (optional) |
| `npm run db:reset` | Drop and recreate the schema with fresh seed data (**deletes all data**) |
| `npm run db:gen-seed` | Regenerate `db/oracle/04_seed.sql` from the app's seed data |
| `npm run db:down` | Stop the Oracle container (data is kept in a Docker volume) |

Using an existing Oracle install instead of Docker? Run `db/oracle/00_create_user.sql` as `SYSTEM`,
set `ORACLE_CONNECT_STRING` (e.g. `localhost:1521/XEPDB1`) in `.env`, then `npm run db:setup`.
The scripts also run by hand in SQL Developer in order 01 → 04.

## Project layout

```
db/oracle/        SQL scripts: schema, PL/SQL packages & triggers, views, seed, sample reports, lab, warehouse (10–12)
docs/DATABASE.md  ER diagram, normalization, constraints, PL/SQL API, roles & rights, Database Lab
docs/DEMO.md      5-minute demonstration script
server/           Node API: auth (scrypt + sessions), role checks, Oracle repository, live operations host
  db/oracle.ts    Oracle implementation (node-oracledb Thin mode — no Oracle client install needed)
  db/oracle-lab.ts Database Lab on Oracle: SQL control queue, Flashback, VPD report, concurrency runs
  wms/            Smart Warehouse: engine (lots, bins, FEFO, slotting, sensors), Oracle SQL, embeddings
  db/memory.ts    Same rules in memory, for development/tests without a database
  db/selftest.ts  npm run db:selftest
src/              Website: login, 3D scene, dashboard panels, Work panel (tasks, activity, team, reports, users)
```

All operational figures are demonstration data that the system generates and stores; there is no
connection to real carriers or customers.
