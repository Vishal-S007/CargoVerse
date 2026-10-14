--------------------------------------------------------------------------------
-- CargoVerse — sample SQL reports (run in SQL Developer / SQL*Plus as WARETRACK)
-- Each query demonstrates a different SQL feature.
--------------------------------------------------------------------------------
SET DEFINE OFF

-- 1. KPI cards for every facility (view + scalar subqueries)
SELECT facility_id, name, stock_pallets, fill_pct, trucks_on_site, otd_pct, open_tasks
  FROM v_facility_kpi
 ORDER BY facility_id;

-- 2. Who is working on what right now (multi-table join)
SELECT e.full_name, j.title, k.title AS task, k.task_status, k.priority, f.name AS facility
  FROM tasks k
  JOIN employees e  ON e.employee_id = k.assigned_to
  JOIN job_titles j ON j.job_code = e.job_code
  JOIN facilities f ON f.facility_id = k.facility_id
 WHERE k.task_status IN ('ASSIGNED', 'IN_PROGRESS', 'BLOCKED')
 ORDER BY f.name, k.priority DESC;

-- 3. On-time delivery by facility and direction, with subtotals (GROUP BY ROLLUP)
SELECT NVL(facility_id, 'ALL')  AS facility,
       NVL(direction, 'ALL')    AS direction,
       COUNT(*)                 AS delivered,
       ROUND(100 * AVG(CASE WHEN on_time = 'Y' THEN 1 ELSE 0 END), 2) AS on_time_pct
  FROM shipments
 WHERE ship_status = 'DELIVERED'
 GROUP BY ROLLUP (facility_id, direction)
 ORDER BY 1, 2;

-- 4. Facilities whose on-time rate is below the network average (HAVING + subquery)
SELECT facility_id, ROUND(100 * AVG(CASE WHEN on_time = 'Y' THEN 1 ELSE 0 END), 2) AS otd
  FROM shipments
 WHERE ship_status = 'DELIVERED'
 GROUP BY facility_id
HAVING AVG(CASE WHEN on_time = 'Y' THEN 1 ELSE 0 END) <
       (SELECT AVG(CASE WHEN on_time = 'Y' THEN 1 ELSE 0 END) FROM shipments WHERE ship_status = 'DELIVERED');

-- 5. Running stock level per facility from the ledger (analytic window function)
SELECT facility_id, movement_id, reason, pallets_delta,
       SUM(pallets_delta) OVER (PARTITION BY facility_id ORDER BY movement_id) AS running_stock
  FROM stock_movements
 ORDER BY facility_id, movement_id
 FETCH FIRST 50 ROWS ONLY;

-- 6. Busiest forklift operators today (join + aggregation + ranking)
SELECT e.full_name, fl.forklift_id, fl.moves_today, fl.battery_pct,
       RANK() OVER (ORDER BY fl.moves_today DESC) AS rank_today
  FROM forklifts fl
  JOIN employees e ON e.employee_id = fl.operator_id
 ORDER BY rank_today;

-- 7. Low stock lines and how short they are (view)
SELECT facility_name, sku_name, units, reorder_level, shortfall
  FROM v_low_stock
 ORDER BY shortfall DESC;

-- 8. Audit history: what did each manager change in the last 7 days (join + date filter)
SELECT a.created_at, a.username, a.action, a.facility_id, a.details
  FROM v_audit_feed a
  JOIN app_users u ON u.user_id = a.user_id
 WHERE u.role_code = 'MANAGER'
   AND a.created_at >= SYSTIMESTAMP - INTERVAL '7' DAY
 ORDER BY a.created_at DESC;

-- 9. Employees with no open work (NOT EXISTS anti-join)
SELECT e.full_name, j.title, e.facility_id
  FROM employees e
  JOIN job_titles j ON j.job_code = e.job_code
 WHERE e.emp_status = 'ACTIVE'
   AND NOT EXISTS (SELECT 1 FROM tasks k
                    WHERE k.assigned_to = e.employee_id
                      AND k.task_status IN ('ASSIGNED', 'IN_PROGRESS', 'BLOCKED'));

-- 10. Permissions matrix (pivot of role_permissions)
SELECT *
  FROM (SELECT role_code, perm_code, 'Y' AS granted FROM role_permissions)
 PIVOT (MAX(granted) FOR role_code IN ('ADMIN' AS admin, 'MANAGER' AS manager, 'OPERATOR' AS operator))
 ORDER BY perm_code;

-- 11. Imports vs exports today per site (view with counters kept by a trigger)
SELECT facility_id, name, imports_today, import_pallets_today, exports_today, export_pallets_today, pallet_balance
  FROM v_trade_today
 ORDER BY facility_id;

-- 12. Gate traffic per hour and direction (TRUNC on timestamps + PIVOT)
SELECT *
  FROM (SELECT TO_CHAR(TRUNC(created_at, 'HH24'), 'YYYY-MM-DD HH24:MI') AS hour_start, trade_type, pallets
          FROM park_gate_log)
 PIVOT (COUNT(*) AS trucks, SUM(pallets) AS pallets FOR trade_type IN ('IMPORT' AS imp, 'EXPORT' AS exp, 'EMPTY' AS empty))
 ORDER BY hour_start DESC;

-- 13. Which products are imported and exported the most (join + conditional aggregation)
SELECT s.name AS product,
       SUM(CASE WHEN g.trade_type = 'IMPORT' THEN g.pallets ELSE 0 END) AS imported_pallets,
       SUM(CASE WHEN g.trade_type = 'EXPORT' THEN g.pallets ELSE 0 END) AS exported_pallets
  FROM park_gate_log g
  JOIN skus s ON s.sku_id = g.sku_id
 GROUP BY s.name
 ORDER BY imported_pallets + exported_pallets DESC;

-- 14. Park tenants: staff and floor area per industry (GROUP BY + virtual column)
SELECT c.industry, COUNT(*) AS buildings, SUM(b.staff_count) AS staff, SUM(b.floor_area_m2) AS floor_area_m2
  FROM park_buildings b
  JOIN park_companies c ON c.company_id = b.company_id
 GROUP BY c.industry
 ORDER BY staff DESC;

-- 15. Leases ending within the next 5 years (date arithmetic on a view)
SELECT company_name, building_name, lease_end, lease_months_left
  FROM v_park_directory
 WHERE lease_end < ADD_MONTHS(TRUNC(SYSDATE), 60)
 ORDER BY lease_end;

-- 16. Vehicles on the park roads by owner, including public traffic (LEFT JOIN + NVL)
SELECT NVL(c.name, 'Public traffic') AS owner, v.vehicle_kind, COUNT(*) AS vehicles, ROUND(AVG(v.speed_kmh)) AS avg_kmh
  FROM park_vehicles v
  LEFT JOIN park_companies c ON c.company_id = v.company_id
 GROUP BY NVL(c.name, 'Public traffic'), v.vehicle_kind
 ORDER BY owner, vehicle_kind;

-- 17. Trucks that came in through the West Gate but have not left yet (MINUS set operation)
SELECT truck_id FROM park_gate_log WHERE direction = 'IN'
MINUS
SELECT g.truck_id FROM park_gate_log g
 WHERE g.direction = 'OUT'
   AND g.created_at > (SELECT MAX(i.created_at) FROM park_gate_log i WHERE i.truck_id = g.truck_id AND i.direction = 'IN');

-- 18. Use the PL/SQL API directly: create and progress a task as manager alex.chen (user 2)
--     (wrap in a transaction; the audit trigger records each step)
-- DECLARE v_id NUMBER;
-- BEGIN
--   DBMS_SESSION.SET_IDENTIFIER('2');
--   wt_work.create_task(2, 'WH-01', 'Sweep Bay 1 apron', 'Clear debris before next truck', 'DOCK_CHECK',
--                       'LOW', 16, NULL, 'WH-01-B1', NULL, NULL, 30, 'MANUAL', v_id);
--   wt_work.change_status(2, v_id, 'IN_PROGRESS', 'Started by manager');
--   COMMIT;
-- END;
-- /

-- 19. Port throughput by shipping line today (GROUP BY ROLLUP gives the terminal total)
SELECT NVL(l.name, 'All lines') AS shipping_line,
       SUM(CASE WHEN m.move_type = 'DISCHARGE' THEN 1 ELSE 0 END) AS discharged,
       SUM(CASE WHEN m.move_type = 'LOAD' THEN 1 ELSE 0 END)      AS loaded,
       SUM(CASE WHEN m.move_type = 'GATE_OUT' THEN 1 ELSE 0 END)  AS gate_out,
       SUM(CASE WHEN m.move_type = 'GATE_IN' THEN 1 ELSE 0 END)   AS gate_in
  FROM container_moves m
  JOIN shipping_lines l ON l.line_code = m.line_code
 WHERE m.created_at >= TRUNC(SYSTIMESTAMP)
 GROUP BY ROLLUP (l.name)
 ORDER BY GROUPING(l.name), l.name;

-- 20. Ship turnaround: minutes alongside for every completed port call (interval arithmetic)
SELECT v.name AS vessel, c.voyage_no, c.berth_code, c.boxes_discharged, c.boxes_loaded,
       ROUND((CAST(c.departed_at AS DATE) - CAST(c.arrived_at AS DATE)) * 24 * 60, 1) AS minutes_alongside
  FROM vessel_calls c
  JOIN vessels v ON v.vessel_id = c.vessel_id
 WHERE c.call_status = 'COMPLETED'
 ORDER BY c.departed_at DESC;

-- 21. Trace import containers from ship to warehouse (self-join of the ledger: DISCHARGE → GATE_OUT)
SELECT d.container_no, v.name AS vessel, d.created_at AS discharged_at, g.truck_id, g.facility_id AS delivered_to,
       ROUND((CAST(g.created_at AS DATE) - CAST(d.created_at AS DATE)) * 24 * 60, 1) AS minutes_in_yard
  FROM container_moves d
  JOIN container_moves g ON g.container_no = d.container_no AND g.move_type = 'GATE_OUT' AND g.move_id > d.move_id
  JOIN vessels v ON v.vessel_id = d.vessel_id
 WHERE d.move_type = 'DISCHARGE'
   AND g.truck_id IS NOT NULL
 ORDER BY g.move_id DESC;

-- 22. Yard occupancy and the oldest box in each block (analytic ROW_NUMBER)
SELECT block_code, boxes_in_block, oldest_container, arrived_at
  FROM (SELECT y.block_code, y.container_no AS oldest_container, y.arrived_at,
               COUNT(*) OVER (PARTITION BY y.block_code) AS boxes_in_block,
               ROW_NUMBER() OVER (PARTITION BY y.block_code ORDER BY y.arrived_move_id) AS rn
          FROM yard_containers y)
 WHERE rn = 1;

-- 23. Store shelves at or below their reorder point, with cover in hours (uses wt_retail.cover_hours)
SELECT s.name AS store, k.name AS product, t.units, t.reorder_at, t.max_units,
       wt_retail.cover_hours(t.store_id, t.sku_id) AS cover_hours, t.stock_status
  FROM store_stock t
  JOIN stores s ON s.store_id = t.store_id
  JOIN skus k ON k.sku_id = t.sku_id
 WHERE t.stock_status <> 'OK'
 ORDER BY cover_hours NULLS FIRST;

-- 24. Deliveries to stores per warehouse (PIVOT on the order status)
SELECT *
  FROM (SELECT facility_id, order_status FROM store_orders)
 PIVOT (COUNT(*) FOR order_status IN ('PLACED' AS placed, 'LOADING' AS loading, 'OUT_FOR_DELIVERY' AS out_for_delivery,
                                      'DELIVERED' AS delivered, 'CANCELLED' AS cancelled))
 ORDER BY facility_id;

-- 25. Units shipped from each warehouse to stores (stock ledger, reason STORE_SHIP)
SELECT m.facility_id, k.name AS product, -SUM(m.units_delta) AS units_to_stores, COUNT(*) AS van_loads
  FROM stock_movements m
  JOIN skus k ON k.sku_id = m.sku_id
 WHERE m.reason = 'STORE_SHIP'
 GROUP BY m.facility_id, k.name
 ORDER BY m.facility_id, units_to_stores DESC;

-- 26. Average order lead time per store, placed → delivered (minutes)
SELECT store_name, COUNT(*) AS delivered_orders, ROUND(AVG(lead_minutes), 1) AS avg_lead_minutes, MAX(lead_minutes) AS worst
  FROM v_store_orders
 WHERE order_status = 'DELIVERED'
 GROUP BY store_name
 ORDER BY avg_lead_minutes DESC;
