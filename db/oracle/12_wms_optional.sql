--------------------------------------------------------------------------------
-- CargoVerse — Smart Warehouse, advanced Oracle features (run as the schema owner)
--
-- Each block below upgrades one part of 10_wms.sql to an Oracle feature that needs
-- Oracle Database 21c/23ai or a privilege granted in 07_security_sys.sql. A block
-- that fails leaves the plain version from 10_wms.sql in place, so the application
-- keeps working; `npm run db:lab` lists what was installed.
--
--   1. SENSOR_READINGS  → interval partitioning, one partition per day
--   2. STOCK_LEDGER     → BLOCKCHAIN TABLE (rows chained by SHA2-512, no update/delete)
--   3. EMBEDDING        → VECTOR(384, FLOAT32) columns for AI Vector Search
--   4. CV_EVENTS        → Transactional Event Queue for warehouse events
--   5. CV_DETECT_BREACHES, CV_PURGE_READINGS → DBMS_SCHEDULER jobs
--   6. CV_WAREHOUSE_GRAPH → SQL property graph over the aisle network (SQL/PGQ)
--------------------------------------------------------------------------------
SET DEFINE OFF

-- 1. Interval partitioning: a new partition is created automatically for each day;
--    WT_WMS.PURGE_READINGS drops old days with ALTER TABLE … DROP PARTITION.
DECLARE
  v_n NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_n FROM user_part_tables WHERE table_name = 'SENSOR_READINGS';
  IF v_n = 0 THEN
    EXECUTE IMMEDIATE q'[
      CREATE TABLE sensor_readings_p (
        sensor_id  VARCHAR2(12)  NOT NULL CONSTRAINT fk_srp_sensor REFERENCES sensors (sensor_id),
        read_at    TIMESTAMP     NOT NULL,
        temp_c     NUMBER(5,2)   NOT NULL)
      PARTITION BY RANGE (read_at) INTERVAL (NUMTODSINTERVAL(1, 'DAY'))
        (PARTITION p_start VALUES LESS THAN (TIMESTAMP '2026-01-01 00:00:00'))]';
    EXECUTE IMMEDIATE 'INSERT INTO sensor_readings_p (sensor_id, read_at, temp_c) SELECT sensor_id, read_at, temp_c FROM sensor_readings';
    EXECUTE IMMEDIATE 'DROP TABLE sensor_readings PURGE';
    EXECUTE IMMEDIATE 'ALTER TABLE sensor_readings_p RENAME TO sensor_readings';
    EXECUTE IMMEDIATE 'CREATE INDEX ix_sr_sensor ON sensor_readings (sensor_id, read_at) LOCAL';
  END IF;
END;
/

-- 2. Blockchain table: every row is chained to the previous one by a SHA2-512 hash; rows cannot be
--    updated, and cannot be deleted for 16 days. DBMS_BLOCKCHAIN_TABLE.VERIFY_ROWS checks the chain.
DECLARE
  v_bc NUMBER := 0;
  PROCEDURE create_ledger (p_version IN VARCHAR2) IS
  BEGIN
    EXECUTE IMMEDIATE '
      CREATE BLOCKCHAIN TABLE stock_ledger (
        move_id      NUMBER        NOT NULL,
        lot_id       VARCHAR2(20)  NOT NULL,
        facility_id  VARCHAR2(10)  NOT NULL,
        sku_id       VARCHAR2(20)  NOT NULL,
        move_type    VARCHAR2(10)  NOT NULL,
        units        NUMBER(10)    NOT NULL,
        bin_id       VARCHAR2(20),
        ref_id       VARCHAR2(30),
        recorded_at  TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL)
      NO DROP UNTIL 0 DAYS IDLE
      NO DELETE UNTIL 16 DAYS AFTER INSERT
      HASHING USING "SHA2_512"' || p_version;
  END create_ledger;
BEGIN
  BEGIN
    EXECUTE IMMEDIATE 'SELECT COUNT(*) FROM user_blockchain_tables WHERE table_name = ''STOCK_LEDGER''' INTO v_bc;
  EXCEPTION
    WHEN OTHERS THEN v_bc := 0;
  END;
  IF v_bc = 0 THEN
    EXECUTE IMMEDIATE 'DROP TABLE stock_ledger PURGE'; -- the plain fallback from 10_wms.sql
    BEGIN
      create_ledger(' VERSION "v2"');
    EXCEPTION
      WHEN OTHERS THEN
        BEGIN
          create_ledger('');
        EXCEPTION
          WHEN OTHERS THEN
            -- put the plain ledger back, then report why the blockchain table failed
            EXECUTE IMMEDIATE q'[
              CREATE TABLE stock_ledger (
                move_id NUMBER NOT NULL, lot_id VARCHAR2(20) NOT NULL, facility_id VARCHAR2(10) NOT NULL,
                sku_id VARCHAR2(20) NOT NULL, move_type VARCHAR2(10) NOT NULL, units NUMBER(10) NOT NULL,
                bin_id VARCHAR2(20), ref_id VARCHAR2(30), recorded_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL)]';
            RAISE;
        END;
    END;
  END IF;
END;
/

-- 3. AI Vector Search: 384-dimension embeddings of damage reports and product descriptions
--    (computed by the server with the all-MiniLM-L6-v2 model). Before 23ai: JSON text in a CLOB.
DECLARE
  PROCEDURE add_vector (p_table IN VARCHAR2) IS
    v_n NUMBER;
  BEGIN
    SELECT COUNT(*) INTO v_n FROM user_tab_columns WHERE table_name = p_table AND column_name = 'EMBEDDING';
    IF v_n = 0 THEN
      BEGIN
        EXECUTE IMMEDIATE 'ALTER TABLE ' || p_table || ' ADD (embedding VECTOR(384, FLOAT32))';
      EXCEPTION
        WHEN OTHERS THEN
          EXECUTE IMMEDIATE 'ALTER TABLE ' || p_table || ' ADD (embedding CLOB)';
          RAISE;
      END;
    END IF;
  END add_vector;
BEGIN
  add_vector('DAMAGE_REPORTS');
  add_vector('SKU_HANDLING');
END;
/

-- 4. Transactional Event Queue (classic AQ queue on older releases). WT_EVENTS.PUBLISH enqueues
--    each event inside the caller's transaction; the server dequeues them as they are committed.
DECLARE
  v_n NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_n FROM user_queues WHERE name = 'CV_EVENTS';
  IF v_n = 0 THEN
    BEGIN
      EXECUTE IMMEDIATE q'[
        BEGIN
          DBMS_AQADM.CREATE_TRANSACTIONAL_EVENT_QUEUE(
            queue_name         => 'CV_EVENTS',
            queue_payload_type => 'RAW',
            multiple_consumers => FALSE,
            comment            => 'CargoVerse warehouse events');
        END;]';
    EXCEPTION
      WHEN OTHERS THEN
        EXECUTE IMMEDIATE q'[
          BEGIN
            DBMS_AQADM.CREATE_QUEUE_TABLE(queue_table => 'CV_EVENTS_QT', queue_payload_type => 'RAW');
            DBMS_AQADM.CREATE_QUEUE(queue_name => 'CV_EVENTS', queue_table => 'CV_EVENTS_QT');
          END;]';
    END;
  END IF;
  EXECUTE IMMEDIATE q'[BEGIN DBMS_AQADM.START_QUEUE(queue_name => 'CV_EVENTS'); END;]';
END;
/

-- 5. Scheduler jobs: the database itself watches the cold chain every 15 seconds (even when no
--    application is running) and drops sensor readings older than two days every night.
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'CV_DETECT_BREACHES',
    job_type        => 'PLSQL_BLOCK',
    job_action      => 'DECLARE n NUMBER; BEGIN n := wt_wms.detect_breaches; COMMIT; END;',
    start_date      => SYSTIMESTAMP,
    repeat_interval => 'FREQ=SECONDLY;INTERVAL=15',
    enabled         => TRUE,
    comments        => 'CargoVerse: MATCH_RECOGNIZE over sensor readings; holds lots after a temperature excursion');
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'CV_PURGE_READINGS',
    job_type        => 'PLSQL_BLOCK',
    job_action      => 'BEGIN wt_wms.purge_readings(2); END;',
    start_date      => TRUNC(SYSTIMESTAMP) + INTERVAL '1' DAY + INTERVAL '3' HOUR,
    repeat_interval => 'FREQ=DAILY;BYHOUR=3',
    enabled         => TRUE,
    comments        => 'CargoVerse: drops sensor-reading partitions older than two days');
END;
/

-- 6. SQL property graph (Oracle 23ai): the aisle network as vertices and edges, queried with GRAPH_TABLE
BEGIN
  EXECUTE IMMEDIATE q'[
    CREATE PROPERTY GRAPH cv_warehouse_graph
      VERTEX TABLES (
        wh_nodes KEY (node_id) LABEL location
          PROPERTIES (node_id, facility_id, node_kind, pos_x, pos_z, node_label))
      EDGE TABLES (
        wh_edges KEY (edge_id)
          SOURCE KEY (from_node) REFERENCES wh_nodes (node_id)
          DESTINATION KEY (to_node) REFERENCES wh_nodes (node_id)
          LABEL aisle
          PROPERTIES (edge_id, metres))]';
END;
/
