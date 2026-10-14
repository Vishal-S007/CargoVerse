--------------------------------------------------------------------------------
-- CargoVerse — Database Lab (run as the schema owner, after 01–04)
--
--  1. Live control from SQL. Triggers notice changes made OUTSIDE the CargoVerse
--     server (SQL Developer, SQL*Plus, any other client) to the columns that steer
--     the operation — a berth closed, a ship held, a shelf emptied, a forklift's
--     battery, the operations clock, a building's status, a task — and queue them
--     in DB_COMMANDS. The server picks the queue up every second and the 3D city
--     reacts. The server's own sessions identify themselves with the module name
--     'cargoverse-api', so its writes are not queued again.
--  2. Concurrency lab. Dock-slot bookings serialised with SELECT … FOR UPDATE and
--     a unique key, and a two-row sandbox table for lost-update and deadlock demos.
--
-- Safe to run again on an existing schema (npm run db:lab): the lab tables are
-- recreated, everything else is CREATE OR REPLACE.
--------------------------------------------------------------------------------
SET DEFINE OFF

BEGIN
  FOR t IN (SELECT table_name FROM user_tables WHERE table_name IN ('DB_COMMANDS', 'DOCK_BOOKINGS', 'LAB_STOCK')) LOOP
    EXECUTE IMMEDIATE 'DROP TABLE ' || t.table_name || ' CASCADE CONSTRAINTS PURGE';
  END LOOP;
END;
/

-- ============================================================================
-- 1. Changes made outside the application, waiting to be applied to the live city
-- ============================================================================
CREATE TABLE db_commands (
  cmd_id          NUMBER GENERATED ALWAYS AS IDENTITY CONSTRAINT pk_db_commands PRIMARY KEY,
  table_name      VARCHAR2(30)   NOT NULL,
  row_key         VARCHAR2(60)   NOT NULL,                -- primary key of the changed row (store_id:sku_id for store stock)
  column_name     VARCHAR2(30)   NOT NULL,
  old_value       VARCHAR2(200),
  new_value       VARCHAR2(200),
  db_user         VARCHAR2(128)  NOT NULL,                -- database account that made the change
  client_program  VARCHAR2(64),                           -- e.g. SQL Developer, SQL*Plus
  client_host     VARCHAR2(128),
  os_user         VARCHAR2(128),
  cmd_status      VARCHAR2(10)   DEFAULT 'PENDING' NOT NULL,
  result_msg      VARCHAR2(300),
  created_at      TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
  applied_at      TIMESTAMP,
  CONSTRAINT ck_cmd_status CHECK (cmd_status IN ('PENDING', 'APPLIED', 'REJECTED')),
  CONSTRAINT ck_cmd_table  CHECK (table_name IN ('PORT_BERTHS', 'VESSELS', 'STORE_STOCK', 'FORKLIFTS', 'SIM_STATE', 'PARK_BUILDINGS', 'TASKS'))
);
CREATE INDEX ix_db_commands_status ON db_commands (cmd_status, cmd_id);
COMMENT ON TABLE db_commands IS 'Changes made outside the CargoVerse server (e.g. in SQL Developer), queued by triggers and applied to the live city';

-- ============================================================================
-- 2. Concurrency lab
-- ============================================================================
CREATE TABLE dock_bookings (
  booking_id      NUMBER GENERATED ALWAYS AS IDENTITY CONSTRAINT pk_dock_bookings PRIMARY KEY,
  dock_id         VARCHAR2(20)   NOT NULL CONSTRAINT fk_dbk_dock REFERENCES docks (dock_id),
  slot_start      DATE           NOT NULL,                -- one-hour slot
  truck_id        VARCHAR2(20)   NOT NULL,
  booked_by       VARCHAR2(60)   NOT NULL,
  session_tag     VARCHAR2(20),                           -- LAB = made by the concurrency lab
  created_at      TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT uq_dock_slot  UNIQUE (dock_id, slot_start),  -- a slot can be booked once, whatever the application does
  CONSTRAINT ck_slot_hour  CHECK (slot_start = TRUNC(slot_start, 'HH24'))
);
COMMENT ON TABLE dock_bookings IS 'Dock time-slot bookings; double booking is impossible (row lock on the dock + unique key)';

CREATE TABLE lab_stock (
  item_id         VARCHAR2(10)   CONSTRAINT pk_lab_stock PRIMARY KEY,
  item_name       VARCHAR2(60)   NOT NULL,
  units           NUMBER(6)      NOT NULL,
  updated_by      VARCHAR2(30),
  updated_at      TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT ck_lab_units CHECK (units >= 0)
);
COMMENT ON TABLE lab_stock IS 'Sandbox rows for the concurrency lab (lost update and deadlock demonstrations)';
INSERT INTO lab_stock (item_id, item_name, units) VALUES ('LAB-A', 'Demo stock: Cardboard Box (M), Riverside Hub', 100);
INSERT INTO lab_stock (item_id, item_name, units) VALUES ('LAB-B', 'Demo stock: Nitrile Gloves, Northgate DC', 100);
COMMIT;

-- ============================================================================
-- Package WT_LAB
-- ============================================================================
CREATE OR REPLACE PACKAGE wt_lab AS
  c_app_module CONSTANT VARCHAR2(30) := 'cargoverse-api';

  -- TRUE when the current session is not the CargoVerse server (SQL Developer, SQL*Plus, …)
  FUNCTION is_external RETURN BOOLEAN;

  PROCEDURE enqueue (
    p_table  IN VARCHAR2,
    p_key    IN VARCHAR2,
    p_column IN VARCHAR2,
    p_old    IN VARCHAR2,
    p_new    IN VARCHAR2);

  -- Books one dock slot. Locks the dock row first, so two bookings for the same dock
  -- are serialised; the second one sees the first and is refused. p_hold_s keeps the
  -- lock for a few seconds before returning (used by the concurrency lab to make the
  -- wait visible). Returns the new booking id. The caller commits.
  FUNCTION book_dock (
    p_dock_id   IN VARCHAR2,
    p_slot      IN DATE,
    p_truck_id  IN VARCHAR2,
    p_booked_by IN VARCHAR2,
    p_hold_s    IN NUMBER DEFAULT 0,
    p_tag       IN VARCHAR2 DEFAULT NULL) RETURN NUMBER;

  -- Puts the concurrency lab back to its starting state.
  PROCEDURE reset_lab;
END wt_lab;
/

CREATE OR REPLACE PACKAGE BODY wt_lab AS

  FUNCTION is_external RETURN BOOLEAN IS
  BEGIN
    RETURN NVL(SYS_CONTEXT('USERENV', 'MODULE'), '-') <> c_app_module;
  END is_external;

  PROCEDURE enqueue (
    p_table  IN VARCHAR2,
    p_key    IN VARCHAR2,
    p_column IN VARCHAR2,
    p_old    IN VARCHAR2,
    p_new    IN VARCHAR2)
  IS
  BEGIN
    INSERT INTO db_commands (table_name, row_key, column_name, old_value, new_value, db_user, client_program, client_host, os_user)
    VALUES (p_table, SUBSTR(p_key, 1, 60), p_column, SUBSTR(p_old, 1, 200), SUBSTR(p_new, 1, 200),
            SYS_CONTEXT('USERENV', 'SESSION_USER'),
            SUBSTR(SYS_CONTEXT('USERENV', 'MODULE'), 1, 64),
            SUBSTR(SYS_CONTEXT('USERENV', 'HOST'), 1, 128),
            SUBSTR(SYS_CONTEXT('USERENV', 'OS_USER'), 1, 128));
  END enqueue;

  FUNCTION book_dock (
    p_dock_id   IN VARCHAR2,
    p_slot      IN DATE,
    p_truck_id  IN VARCHAR2,
    p_booked_by IN VARCHAR2,
    p_hold_s    IN NUMBER DEFAULT 0,
    p_tag       IN VARCHAR2 DEFAULT NULL) RETURN NUMBER
  IS
    v_dock   docks.dock_id%TYPE;
    v_taken  dock_bookings.truck_id%TYPE;
    v_by     dock_bookings.booked_by%TYPE;
    v_id     NUMBER;
    e_busy   EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_busy, -30006);
  BEGIN
    BEGIN
      -- the lock: a second booking for this dock waits here until the first one commits
      SELECT dock_id INTO v_dock FROM docks WHERE dock_id = p_dock_id FOR UPDATE WAIT 15;
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        RAISE_APPLICATION_ERROR(-20001, 'Dock ' || p_dock_id || ' not found');
      WHEN e_busy THEN
        RAISE_APPLICATION_ERROR(-20002, 'Dock ' || p_dock_id || ' is being booked by another session; try again');
    END;
    BEGIN
      SELECT truck_id, booked_by INTO v_taken, v_by
        FROM dock_bookings
       WHERE dock_id = p_dock_id AND slot_start = TRUNC(p_slot, 'HH24');
      RAISE_APPLICATION_ERROR(-20002, 'Dock ' || p_dock_id || ' is already booked at ' || TO_CHAR(TRUNC(p_slot, 'HH24'), 'HH24:MI')
        || ' for ' || v_taken || ' (by ' || v_by || ')');
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        NULL; -- the slot is free
    END;
    INSERT INTO dock_bookings (dock_id, slot_start, truck_id, booked_by, session_tag)
    VALUES (p_dock_id, TRUNC(p_slot, 'HH24'), p_truck_id, p_booked_by, p_tag)
    RETURNING booking_id INTO v_id;
    IF NVL(p_hold_s, 0) > 0 THEN
      DBMS_SESSION.SLEEP(LEAST(p_hold_s, 10));
    END IF;
    RETURN v_id;
  END book_dock;

  PROCEDURE reset_lab IS
  BEGIN
    DELETE FROM dock_bookings WHERE session_tag = 'LAB';
    UPDATE lab_stock SET units = 100, updated_by = 'reset', updated_at = SYSTIMESTAMP;
  END reset_lab;

END wt_lab;
/

-- ============================================================================
-- Triggers: changes made outside the server are queued for the live city
-- ============================================================================
CREATE OR REPLACE TRIGGER trg_ext_port_berths
AFTER UPDATE OF is_open ON port_berths
FOR EACH ROW
BEGIN
  IF wt_lab.is_external AND :OLD.is_open <> :NEW.is_open THEN
    wt_lab.enqueue('PORT_BERTHS', :NEW.berth_code, 'IS_OPEN', :OLD.is_open, :NEW.is_open);
  END IF;
END;
/

-- At least one berth must stay open, whoever makes the change (statement-level: may read the table).
CREATE OR REPLACE TRIGGER trg_port_berths_one_open
AFTER UPDATE OF is_open ON port_berths
DECLARE
  v_open NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_open FROM port_berths WHERE is_open = 'Y';
  IF v_open = 0 THEN
    RAISE_APPLICATION_ERROR(-20004, 'At least one berth must stay open');
  END IF;
END;
/

CREATE OR REPLACE TRIGGER trg_ext_vessels
AFTER UPDATE OF on_hold ON vessels
FOR EACH ROW
BEGIN
  IF wt_lab.is_external AND :OLD.on_hold <> :NEW.on_hold THEN
    wt_lab.enqueue('VESSELS', :NEW.vessel_id, 'ON_HOLD', :OLD.on_hold, :NEW.on_hold);
  END IF;
END;
/

CREATE OR REPLACE TRIGGER trg_ext_store_stock
AFTER UPDATE OF units ON store_stock
FOR EACH ROW
BEGIN
  IF wt_lab.is_external AND :OLD.units <> :NEW.units THEN
    wt_lab.enqueue('STORE_STOCK', :NEW.store_id || ':' || :NEW.sku_id, 'UNITS', TO_CHAR(:OLD.units), TO_CHAR(:NEW.units));
  END IF;
END;
/

CREATE OR REPLACE TRIGGER trg_ext_forklifts
AFTER UPDATE OF battery_pct ON forklifts
FOR EACH ROW
BEGIN
  IF wt_lab.is_external AND ROUND(:OLD.battery_pct) <> ROUND(:NEW.battery_pct) THEN
    wt_lab.enqueue('FORKLIFTS', :NEW.forklift_id, 'BATTERY_PCT', TO_CHAR(ROUND(:OLD.battery_pct, 1)), TO_CHAR(ROUND(:NEW.battery_pct, 1)));
  END IF;
END;
/

CREATE OR REPLACE TRIGGER trg_ext_sim_state
AFTER UPDATE OF paused, speed ON sim_state
FOR EACH ROW
BEGIN
  IF wt_lab.is_external THEN
    IF :OLD.paused <> :NEW.paused THEN
      wt_lab.enqueue('SIM_STATE', '1', 'PAUSED', :OLD.paused, :NEW.paused);
    END IF;
    IF :OLD.speed <> :NEW.speed THEN
      wt_lab.enqueue('SIM_STATE', '1', 'SPEED', TO_CHAR(:OLD.speed), TO_CHAR(:NEW.speed));
    END IF;
  END IF;
END;
/

CREATE OR REPLACE TRIGGER trg_ext_park_buildings
AFTER UPDATE OF bldg_status ON park_buildings
FOR EACH ROW
BEGIN
  IF wt_lab.is_external AND :OLD.bldg_status <> :NEW.bldg_status THEN
    wt_lab.enqueue('PARK_BUILDINGS', :NEW.building_id, 'BLDG_STATUS', :OLD.bldg_status, :NEW.bldg_status);
  END IF;
END;
/

CREATE OR REPLACE TRIGGER trg_ext_tasks
AFTER INSERT OR UPDATE OF task_status, assigned_to, priority ON tasks
FOR EACH ROW
BEGIN
  IF wt_lab.is_external THEN
    IF INSERTING THEN
      wt_lab.enqueue('TASKS', TO_CHAR(:NEW.task_id), 'CREATED', NULL, SUBSTR(:NEW.title, 1, 200));
    ELSE
      wt_lab.enqueue('TASKS', TO_CHAR(:NEW.task_id), 'TASK_STATUS', :OLD.task_status, :NEW.task_status);
    END IF;
  END IF;
END;
/
