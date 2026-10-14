--------------------------------------------------------------------------------
-- CargoVerse — remove every object created by 01–12 (run as WARETRACK).
-- Row-level security policies are dropped together with their tables; the
-- demonstration accounts (CV_*) belong to the database and are kept.
-- Safe to run on an empty schema: missing objects are skipped. The blockchain
-- ledger STOCK_LEDGER is dropped only if Oracle allows it (it is designed to resist).
--------------------------------------------------------------------------------
BEGIN
  FOR j IN (SELECT job_name FROM user_scheduler_jobs WHERE job_name LIKE 'CV\_%' ESCAPE '\') LOOP
    DBMS_SCHEDULER.DROP_JOB(j.job_name, force => TRUE);
  END LOOP;
  BEGIN
    EXECUTE IMMEDIATE 'DROP PROPERTY GRAPH cv_warehouse_graph';
  EXCEPTION
    WHEN OTHERS THEN NULL;
  END;
  FOR q IN (SELECT name FROM user_queues WHERE name = 'CV_EVENTS') LOOP
    BEGIN
      EXECUTE IMMEDIATE q'[BEGIN DBMS_AQADM.STOP_QUEUE(queue_name => 'CV_EVENTS'); END;]';
      EXECUTE IMMEDIATE q'[BEGIN DBMS_AQADM.DROP_TRANSACTIONAL_EVENT_QUEUE(queue_name => 'CV_EVENTS', force => TRUE); END;]';
    EXCEPTION
      WHEN OTHERS THEN
        BEGIN
          EXECUTE IMMEDIATE q'[BEGIN DBMS_AQADM.DROP_QUEUE_TABLE(queue_table => 'CV_EVENTS_QT', force => TRUE); END;]';
        EXCEPTION
          WHEN OTHERS THEN NULL;
        END;
    END;
  END LOOP;
  BEGIN
    EXECUTE IMMEDIATE 'DROP TABLE stock_ledger PURGE';
  EXCEPTION
    WHEN OTHERS THEN NULL; -- a blockchain table may refuse; 10_wms.sql keeps using it
  END;
  FOR v IN (SELECT view_name FROM user_views WHERE view_name LIKE 'V\_%' ESCAPE '\') LOOP
    EXECUTE IMMEDIATE 'DROP VIEW ' || v.view_name;
  END LOOP;
  FOR p IN (SELECT object_name FROM user_objects WHERE object_type = 'PACKAGE' AND object_name LIKE 'WT\_%' ESCAPE '\') LOOP
    EXECUTE IMMEDIATE 'DROP PACKAGE ' || p.object_name;
  END LOOP;
  FOR t IN (SELECT table_name FROM user_tables
             WHERE table_name IN ('SCAN_LOG', 'DAMAGE_REPORTS', 'COLD_BREACHES', 'SENSOR_READINGS', 'SENSORS', 'SKU_DAILY_DEMAND',
                                  'LOT_MOVES', 'BIN_STOCK', 'LOTS', 'STORAGE_BINS', 'WH_EDGES', 'WH_NODES', 'SKU_HANDLING',
                                  'WMS_SETTINGS', 'WMS_EVENTS', 'DB_ACCOUNTS', 'DB_COMMANDS', 'DOCK_BOOKINGS', 'LAB_STOCK',
                                  'STORE_ORDER_HISTORY', 'STORE_ORDERS', 'DELIVERY_VANS', 'STORE_STOCK', 'STORES',
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
