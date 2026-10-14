--------------------------------------------------------------------------------
-- CargoVerse — remove every object created by 01–04 (run as WARETRACK).
-- Safe to run on an empty schema: missing objects are skipped.
--------------------------------------------------------------------------------
BEGIN
  FOR v IN (SELECT view_name FROM user_views WHERE view_name LIKE 'V\_%' ESCAPE '\') LOOP
    EXECUTE IMMEDIATE 'DROP VIEW ' || v.view_name;
  END LOOP;
  FOR p IN (SELECT object_name FROM user_objects WHERE object_type = 'PACKAGE' AND object_name LIKE 'WT\_%' ESCAPE '\') LOOP
    EXECUTE IMMEDIATE 'DROP PACKAGE ' || p.object_name;
  END LOOP;
  FOR t IN (SELECT table_name FROM user_tables
             WHERE table_name IN ('STORE_ORDER_HISTORY', 'STORE_ORDERS', 'DELIVERY_VANS', 'STORE_STOCK', 'STORES',
                                  'YARD_CONTAINERS', 'CONTAINER_MOVES', 'YARD_BLOCKS', 'VESSEL_CALLS', 'QUAY_CRANES',
                                  'VESSELS', 'PORT_BERTHS', 'SHIPPING_LINES',
                                  'PARK_GATE_LOG', 'PARK_GATES', 'PARK_VEHICLES', 'PARK_ROUTES', 'PARK_BUILDINGS', 'PARK_COMPANIES',
                                  'AUDIT_LOG', 'OPERATION_EVENTS', 'TASK_UPDATES', 'TASKS', 'STOCK_MOVEMENTS',
                                  'PALLETS', 'FORKLIFTS', 'SHIPMENTS', 'TRUCKS', 'CHARGERS', 'DOCKS', 'INVENTORY',
                                  'SKUS', 'DRIVERS', 'CARRIERS', 'USER_SESSIONS', 'USER_FACILITY_ACCESS',
                                  'APP_USERS', 'EMPLOYEES', 'FACILITIES', 'JOB_TITLES', 'ROLE_PERMISSIONS',
                                  'PERMISSIONS', 'ROLES', 'SIM_STATE')) LOOP
    EXECUTE IMMEDIATE 'DROP TABLE ' || t.table_name || ' CASCADE CONSTRAINTS PURGE';
  END LOOP;
END;
/
