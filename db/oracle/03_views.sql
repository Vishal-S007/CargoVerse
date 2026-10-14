--------------------------------------------------------------------------------
-- CargoVerse — reporting views (used by the API's reports and KPI endpoints)
--------------------------------------------------------------------------------
SET DEFINE OFF

-- KPI cards per facility: stock, trucks on site, on-time delivery (30 days), work and stock alerts.
CREATE OR REPLACE VIEW v_facility_kpi AS
SELECT f.facility_id,
       f.name,
       f.stock_pallets,
       f.capacity_pallets,
       ROUND(100 * f.stock_pallets / f.capacity_pallets, 1)                      AS fill_pct,
       f.stock_pallets - f.stock_start_pallets                                   AS stock_delta,
       (SELECT COUNT(*) FROM trucks t
         WHERE t.facility_id = f.facility_id
           AND t.status IN ('AT_GATE', 'DOCKING', 'WORKING', 'READY', 'DEPARTING')) AS trucks_on_site,
       (SELECT COUNT(*) FROM trucks t
         WHERE t.facility_id = f.facility_id
           AND t.direction = 'INBOUND'
           AND t.status NOT IN ('AWAY', 'LEAVING'))                                AS trucks_inbound,
       NVL(d.deliveries_30d, 0)                                                   AS deliveries_30d,
       NVL(d.on_time_30d, 0)                                                      AS on_time_30d,
       CASE WHEN NVL(d.deliveries_30d, 0) = 0 THEN 0
            ELSE ROUND(100 * d.on_time_30d / d.deliveries_30d, 2) END             AS otd_pct,
       f.otd_prev_pct,
       (SELECT COUNT(*) FROM tasks k
         WHERE k.facility_id = f.facility_id
           AND k.task_status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED'))    AS open_tasks,
       (SELECT COUNT(*) FROM inventory i
         WHERE i.facility_id = f.facility_id
           AND i.units < i.reorder_level)                                         AS low_stock_lines
  FROM facilities f
  LEFT JOIN (SELECT facility_id,
                    COUNT(*)                                          AS deliveries_30d,
                    SUM(CASE WHEN on_time = 'Y' THEN 1 ELSE 0 END)    AS on_time_30d
               FROM shipments
              WHERE ship_status = 'DELIVERED'
                AND delivered_ts >= SYSTIMESTAMP - INTERVAL '30' DAY
              GROUP BY facility_id) d
    ON d.facility_id = f.facility_id;

-- Dock board: which truck is at or booked for each dock.
CREATE OR REPLACE VIEW v_dock_status AS
SELECT d.facility_id,
       d.dock_id,
       d.dock_name,
       d.dock_kind,
       t.truck_id,
       c.display_name   AS carrier,
       t.status         AS truck_status,
       t.direction,
       CASE WHEN t.truck_id IS NULL THEN 'AVAILABLE'
            WHEN t.status IN ('EN_ROUTE', 'AT_GATE') THEN 'BOOKED'
            WHEN t.status = 'DOCKING' THEN 'DOCKING'
            WHEN t.status = 'WORKING' THEN CASE WHEN t.direction = 'INBOUND' THEN 'UNLOADING' ELSE 'LOADING' END
            ELSE 'READY' END AS dock_state,
       CASE WHEN t.direction = 'INBOUND' THEN t.capacity_pallets - t.cargo_pallets ELSE t.cargo_pallets END AS pallets_done,
       t.capacity_pallets,
       d.trucks_today
  FROM docks d
  LEFT JOIN trucks t   ON t.truck_id = d.truck_id
  LEFT JOIN carriers c ON c.carrier_id = t.carrier_id;

-- Task board with people's names and the latest status note.
CREATE OR REPLACE VIEW v_task_board AS
SELECT k.task_id,
       k.facility_id,
       k.title,
       k.description,
       k.task_type,
       k.priority,
       k.task_status,
       k.source,
       k.assigned_to,
       e.full_name        AS assignee_name,
       j.title            AS assignee_job,
       k.created_by,
       NVL(ce.full_name, 'System') AS created_by_name,
       k.truck_id,
       k.dock_id,
       k.forklift_id,
       k.shipment_id,
       k.due_at,
       k.created_at,
       k.started_at,
       k.completed_at,
       (SELECT u.note FROM task_updates u
         WHERE u.task_id = k.task_id
           AND u.update_id = (SELECT MAX(u2.update_id) FROM task_updates u2 WHERE u2.task_id = k.task_id)) AS last_note,
       CASE WHEN k.due_at < SYSTIMESTAMP AND k.task_status NOT IN ('DONE', 'CANCELLED') THEN 'Y' ELSE 'N' END AS is_overdue
  FROM tasks k
  LEFT JOIN employees e   ON e.employee_id = k.assigned_to
  LEFT JOIN job_titles j  ON j.job_code = e.job_code
  LEFT JOIN app_users cu  ON cu.user_id = k.created_by
  LEFT JOIN employees ce  ON ce.employee_id = cu.employee_id;

-- Inventory lines below their reorder level.
CREATE OR REPLACE VIEW v_low_stock AS
SELECT i.facility_id, f.name AS facility_name, i.sku_id, s.name AS sku_name, i.units, i.reorder_level,
       i.reorder_level - i.units AS shortfall
  FROM inventory i
  JOIN skus s       ON s.sku_id = i.sku_id
  JOIN facilities f ON f.facility_id = i.facility_id
 WHERE i.units < i.reorder_level;

-- Workload per employee.
CREATE OR REPLACE VIEW v_employee_workload AS
SELECT e.employee_id,
       e.full_name,
       j.title AS job_title,
       e.facility_id,
       COUNT(CASE WHEN k.task_status IN ('OPEN', 'ASSIGNED', 'BLOCKED') THEN 1 END) AS open_tasks,
       COUNT(CASE WHEN k.task_status = 'IN_PROGRESS' THEN 1 END)                     AS in_progress,
       COUNT(CASE WHEN k.task_status = 'DONE' AND k.completed_at >= TRUNC(SYSTIMESTAMP) THEN 1 END) AS done_today
  FROM employees e
  JOIN job_titles j ON j.job_code = e.job_code
  LEFT JOIN tasks k ON k.assigned_to = e.employee_id
 WHERE e.emp_status = 'ACTIVE'
 GROUP BY e.employee_id, e.full_name, j.title, e.facility_id;

-- Directory of login accounts with their role, job and facility access.
CREATE OR REPLACE VIEW v_user_directory AS
SELECT u.user_id,
       u.username,
       u.role_code,
       r.role_name,
       u.is_active,
       u.employee_id,
       e.full_name,
       e.email,
       e.job_code,
       j.title AS job_title,
       e.facility_id AS home_facility,
       (SELECT LISTAGG(a.facility_id, ',') WITHIN GROUP (ORDER BY a.facility_id)
          FROM user_facility_access a WHERE a.user_id = u.user_id) AS facilities,
       (SELECT MIN(fl.forklift_id) FROM forklifts fl WHERE fl.operator_id = u.employee_id) AS forklift_id,
       u.last_login_at,
       u.created_at,
       u.failed_logins
  FROM app_users u
  JOIN roles r       ON r.role_code = u.role_code
  JOIN employees e   ON e.employee_id = u.employee_id
  JOIN job_titles j  ON j.job_code = e.job_code;

-- Audit trail with readable user names.
CREATE OR REPLACE VIEW v_audit_feed AS
SELECT a.audit_id,
       a.created_at,
       a.user_id,
       u.username,
       e.full_name,
       a.action,
       a.entity,
       a.entity_id,
       a.facility_id,
       a.details
  FROM audit_log a
  LEFT JOIN app_users u ON u.user_id = a.user_id
  LEFT JOIN employees e ON e.employee_id = u.employee_id;

-- Park directory: every building with its tenant, size and lease position.
CREATE OR REPLACE VIEW v_park_directory AS
SELECT b.building_id,
       b.name                                         AS building_name,
       b.building_kind,
       b.street,
       b.bldg_status,
       b.floors,
       b.floor_area_m2,
       b.staff_count,
       b.lease_start,
       b.lease_end,
       TRUNC(MONTHS_BETWEEN(b.lease_end, TRUNC(SYSDATE)))  AS lease_months_left,
       c.company_id,
       c.name                                         AS company_name,
       c.industry,
       c.brand_color,
       c.is_operator,
       b.facility_id,
       f.name                                         AS facility_name
  FROM park_buildings b
  JOIN park_companies c ON c.company_id = b.company_id
  LEFT JOIN facilities f ON f.facility_id = b.facility_id;

-- Gate log with carrier and product names (newest first in queries).
CREATE OR REPLACE VIEW v_gate_log AS
SELECT g.gate_event_id,
       g.created_at,
       g.sim_time_s,
       g.gate_code,
       g.direction,
       g.trade_type,
       g.truck_id,
       c.name        AS carrier,
       g.facility_id,
       g.shipment_id,
       g.sku_id,
       s.name        AS sku_name,
       g.pallets
  FROM park_gate_log g
  JOIN trucks t   ON t.truck_id = g.truck_id
  JOIN carriers c ON c.carrier_id = t.carrier_id
  LEFT JOIN skus s ON s.sku_id = g.sku_id;

-- Imports and exports per site (today's counters kept by trg_gate_log_ai, plus empty moves logged today).
CREATE OR REPLACE VIEW v_trade_today AS
SELECT f.facility_id,
       f.name,
       f.imports_today,
       f.import_pallets_today,
       f.exports_today,
       f.export_pallets_today,
       f.import_pallets_today - f.export_pallets_today          AS pallet_balance,
       (SELECT COUNT(*) FROM park_gate_log g
         WHERE g.facility_id = f.facility_id
           AND g.trade_type = 'EMPTY'
           AND g.created_at >= TRUNC(SYSTIMESTAMP))              AS empty_moves_today
  FROM facilities f;

-- ============================================================================
-- Container port
-- ============================================================================
-- Ships with their line, berth and progress of the current call.
CREATE OR REPLACE VIEW v_vessel_schedule AS
SELECT v.vessel_id,
       v.name                                        AS vessel_name,
       l.name                                        AS shipping_line,
       v.imo_no,
       v.flag,
       v.voyage_no,
       v.vessel_status,
       v.on_hold,
       v.berth_code,
       b.name                                        AS berth_name,
       v.origin_port,
       v.next_port,
       v.import_boxes                                AS boxes_to_discharge,
       v.discharged,
       v.loaded,
       v.export_target,
       v.through_boxes + v.import_boxes + v.export_boxes AS boxes_aboard,
       v.capacity_boxes,
       ROUND(100 * (v.through_boxes + v.import_boxes + v.export_boxes) / v.capacity_boxes) AS pct_full,
       CASE v.vessel_status WHEN 'AT_SEA' THEN v.timer_s END AS seconds_to_approach,
       wt_core.fmt_clock(v.arrived_s)                AS alongside_since
  FROM vessels v
  JOIN shipping_lines l ON l.line_code = v.line_code
  LEFT JOIN port_berths b ON b.berth_code = v.berth_code;

-- Berths with the ship alongside and the quay cranes working it.
CREATE OR REPLACE VIEW v_port_berths AS
SELECT b.berth_code,
       b.name,
       b.is_open,
       b.vessel_id,
       v.name                                        AS vessel_name,
       v.vessel_status,
       (SELECT COUNT(*) FROM quay_cranes c WHERE c.berth_code = b.berth_code AND c.crane_phase <> 'IDLE') AS cranes_working,
       (SELECT SUM(c.moves_today) FROM quay_cranes c WHERE c.berth_code = b.berth_code)                AS moves_today
  FROM port_berths b
  LEFT JOIN vessels v ON v.vessel_id = b.vessel_id;

-- Boxes in each stacking block against its capacity.
CREATE OR REPLACE VIEW v_yard_summary AS
SELECT k.block_code,
       k.description,
       k.capacity_boxes,
       COUNT(y.container_no)                         AS boxes,
       k.capacity_boxes - COUNT(y.container_no)      AS free_slots,
       ROUND(100 * COUNT(y.container_no) / k.capacity_boxes) AS pct_full
  FROM yard_blocks k
  LEFT JOIN yard_containers y ON y.block_code = k.block_code
 GROUP BY k.block_code, k.description, k.capacity_boxes;

-- The container ledger with ship, truck and site names.
CREATE OR REPLACE VIEW v_container_moves AS
SELECT m.move_id,
       m.created_at,
       m.sim_time_s,
       m.container_no,
       l.name                                        AS shipping_line,
       m.move_type,
       m.vessel_id,
       v.name                                        AS vessel_name,
       m.berth_code,
       m.crane_id,
       m.truck_id,
       m.facility_id,
       f.name                                        AS facility_name
  FROM container_moves m
  JOIN shipping_lines l ON l.line_code = m.line_code
  LEFT JOIN vessels v    ON v.vessel_id = m.vessel_id
  LEFT JOIN facilities f ON f.facility_id = m.facility_id;

-- ============================================================================
-- Vendor stores and deliveries
-- ============================================================================
-- Shelf stock per store with cover (hours of sales left) and open orders.
CREATE OR REPLACE VIEW v_store_stock AS
SELECT s.store_id,
       s.name                                        AS store_name,
       s.store_kind,
       s.facility_id                                 AS usual_supplier,
       k.sku_id,
       k.name                                        AS sku_name,
       t.units,
       t.reorder_at,
       t.max_units,
       t.stock_status,
       t.sales_per_hour,
       t.sold_today,
       CASE WHEN t.sales_per_hour > 0 THEN ROUND(t.units / t.sales_per_hour, 1) END AS cover_hours,
       (SELECT COUNT(*) FROM store_orders o
         WHERE o.store_id = t.store_id AND o.sku_id = t.sku_id
           AND o.order_status IN ('PLACED', 'LOADING', 'OUT_FOR_DELIVERY'))         AS open_orders
  FROM store_stock t
  JOIN stores s ON s.store_id = t.store_id
  JOIN skus k   ON k.sku_id = t.sku_id;

-- Store orders with store, product, supplying site and van.
CREATE OR REPLACE VIEW v_store_orders AS
SELECT o.order_id,
       o.order_status,
       o.order_source,
       o.store_id,
       s.name                                        AS store_name,
       o.sku_id,
       k.name                                        AS sku_name,
       o.units,
       o.facility_id,
       f.name                                        AS facility_name,
       o.van_id,
       v.driver_name,
       o.placed_by,
       o.placed_at,
       o.dispatched_at,
       o.delivered_at,
       ROUND((CAST(o.delivered_at AS DATE) - CAST(o.placed_at AS DATE)) * 24 * 60, 1) AS lead_minutes
  FROM store_orders o
  JOIN stores s     ON s.store_id = o.store_id
  JOIN skus k       ON k.sku_id = o.sku_id
  JOIN facilities f ON f.facility_id = o.facility_id
  LEFT JOIN delivery_vans v ON v.van_id = o.van_id;

-- The delivery fleet and what each van is doing now.
CREATE OR REPLACE VIEW v_delivery_fleet AS
SELECT v.van_id,
       v.facility_id,
       v.van_kind,
       v.plate,
       v.driver_name,
       v.van_status,
       v.order_id,
       s.name                                        AS store_name,
       o.sku_id,
       o.units,
       v.trips_today
  FROM delivery_vans v
  LEFT JOIN store_orders o ON o.order_id = v.order_id
  LEFT JOIN stores s       ON s.store_id = v.store_id;
