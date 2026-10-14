# CargoVerse — 5-minute demonstration

A script for showing the project to an examiner or coordinator. It is built around one idea:
**the 3D city is not an animation, it is the database.** Every step proves that with something
that would be impossible without Oracle.

## Before you start (5 minutes, once)

```bash
npm run db:up          # Oracle in Docker
npm run db:lab         # or db:setup on a new database
npm run db:selftest    # all checks must say PASS
npm run dev            # http://localhost:5173
```

1. Sign in as `admin` / `Admin@123`. Let it run for at least **3 minutes** before the demo, so the time
   machine has something to rewind.
2. Open **SQL Developer** with five connections (host `localhost`, port `1521`, service `FREEPDB1`):
   * `waretrack` / `WareTrack_2026`
   * `cv_admin`, `cv_alex`, `cv_meera`, `cv_zoe` / `Cargo_2026`
3. Put the browser and SQL Developer side by side.

> SQL Developer tip: changes from a worksheet are invisible to everyone else until **COMMIT**
> (F11). For step 4, open the second worksheet with **Ctrl+Shift+N** (unshared worksheet), so it
> is a separate session.

## The demo

### 1 · The city (30 s)

"This is a logistics city: a container port, three warehouses, a town with shops. Ships unload,
trucks carry containers, forklifts move pallets, vans restock shops. Every one of these objects
is a row in Oracle, written every two seconds."

Click a ship, then a truck: each panel is read from its row.

### 2 · Control the city from SQL (90 s)

In SQL Developer as `waretrack`:

```sql
UPDATE port_berths SET is_open = 'N' WHERE berth_code = 'B1';
COMMIT;
```

Within a second a notification appears, the camera flies to the port and berth 1 closes; the next
ship waits at anchor. "I didn't touch the application. A trigger saw that the change came from
SQL Developer, not from the server, and queued it."

```sql
SELECT table_name, row_key, old_value, new_value, db_user, client_program, cmd_status
  FROM db_commands ORDER BY cmd_id DESC;
```

Show `client_program = SQL Developer`. Then try to break a rule:

```sql
UPDATE port_berths SET is_open = 'N';   -- close every berth
```

`ORA-20004: At least one berth must stay open` — "the rules live in the database, so they hold for
every client, not only for my app." Re-open the berth (`is_open = 'Y'`, `COMMIT`).

Optional, crowd-pleaser: `UPDATE sim_state SET speed = 4; COMMIT;` — the whole city speeds up.

### 3 · Time machine (60 s)

Click the **clock** in the header and drag the slider to 3 minutes ago. Every truck, ship and forklift
jumps back to where it was. Press play: 4× replay up to now. Click **Show SQL**:

"That is one `SELECT … AS OF SCN` per table. Oracle keeps the old versions of rows in its undo — I wrote
no history table and no logging code." Then **Work → DB Lab → Time machine**, pick the ship from step 2:
the row's history with every version (`VERSIONS BETWEEN TIMESTAMP`).

### 4 · Row-level security (60 s)

In SQL Developer, run the same query as `cv_admin`, then `cv_zoe`:

```sql
SELECT facility_id, COUNT(*) FROM trucks GROUP BY facility_id;
```

Admin sees every site; Zoe sees only `WH-04`. Try to cheat as `cv_zoe`:

```sql
SELECT * FROM trucks WHERE facility_id = 'WH-01';   -- no rows
SELECT * FROM waretrack.app_users;                    -- ORA-00942
```

"Oracle rewrites every query with a Virtual Private Database policy. It's the same access the app
gives Zoe — change her sites in the app and her database account follows." Show **DB Lab → Row-level
security**: the four accounts side by side, with the `WHERE` clause Oracle adds.

### 5 · Concurrency (60 s)

**DB Lab → Concurrency lab**:

* **Double booking** — two managers book the same dock slot at the same moment. Session B waits
  for A's lock, then is refused: one booking, never two.
* **Lost update** — two tills sell from the same stock without a lock: one sale vanishes (red).
* **The fix: FOR UPDATE** — same tills, the second waits; both sales count.
* **Deadlock** — Oracle detects the cycle and raises `ORA-00060` within seconds.

"These are real sessions against Oracle; the timeline shows the exact waits."

### 6 · Smart Warehouse (2 minutes, optional)

**Work → Warehouse.**

1. **Overview → X-ray in 3D** for Southfield: the roof comes off; every pallet is a coloured box in its rack bin.
2. **Slotting (ABC) → Apply ABC slotting**: "Analytic functions rank the products; the fast movers move next to the
   docks — the expected walk per pick drops by about half." Switch the X-ray to *ABC class*.
3. **Cold chain → Leave it open** on TS-04-C1. Within a minute the scheduler job's `MATCH_RECOGNIZE` finds three warm
   readings in a row, puts the insulin lots **on hold** and raises an urgent task — a toast appears. "The database did
   that on its own; the app only shows it."
4. **Scan (GS1)** → click the *mistyped label*: refused by the check digit. Click an insulin label: on hold, cannot be picked.
5. **Tamper-proof ledger**: *UPDATE … → ORA-05715*. "Not even the schema owner can change history."
6. **Recall trace → Trace**: one recursive query from the lot to the stores that received it (ringed in red in 3D).

### Closing line

"Four things a spreadsheet or a plain app can't do: other programs drive the system through the
database, the database remembers the past, the database enforces who sees what, and the database
keeps concurrent users correct."

## If something goes wrong

| Symptom | Fix |
| --- | --- |
| The UPDATE does nothing in the city | Did you `COMMIT`? Is `npm run dev` running? |
| `ORA-01017` for `cv_zoe` | Run `npm run db:lab` again; it creates the accounts through Docker |
| Time machine says "in-memory history" | The database was reset less than a few minutes ago, or undo was overwritten; wait and retry |
| Warehouse features show ✗ in *Overview* | Run `npm run db:lab` again; it needs Oracle 23ai (the Docker image) and the grants it applies through Docker |
| `ORA-00942` for `trucks` as `cv_zoe` | Use `waretrack.trucks`, or run `npm run db:lab` to create the synonyms |
