--------------------------------------------------------------------------------
-- CargoVerse — Smart Warehouse (run as the schema owner, after 01–06)
--
-- Inventory by lot and storage bin, on top of the core schema:
--   * storage bins in racks and the aisle network between them (a graph),
--   * lots with expiry dates, quality status and first-expiry-first-out picking,
--   * a movement ledger per lot, mirrored into a tamper-proof BLOCKCHAIN TABLE,
--   * temperature sensors (readings partitioned by day) and cold-chain breaches,
--   * daily demand per product (ABC analysis, forecasting, reorder points),
--   * GS1 SSCC pallet labels and scans, damage reports for semantic search,
--   * an event log that is also published on an Oracle Transactional Event Queue.
-- Features that need Oracle Database 23ai or extra privileges are added by
-- 12_wms_optional.sql, which skips what this database cannot do.
--------------------------------------------------------------------------------
SET DEFINE OFF

BEGIN
  BEGIN
    EXECUTE IMMEDIATE 'DROP PROPERTY GRAPH cv_warehouse_graph';
  EXCEPTION
    WHEN OTHERS THEN NULL; -- not there, or not Oracle 23ai
  END;
  FOR j IN (SELECT job_name FROM user_scheduler_jobs WHERE job_name LIKE 'CV\_%' ESCAPE '\') LOOP
    DBMS_SCHEDULER.DROP_JOB(j.job_name, force => TRUE);
  END LOOP;
  FOR t IN (SELECT table_name FROM user_tables
             WHERE table_name IN ('SCAN_LOG', 'DAMAGE_REPORTS', 'COLD_BREACHES', 'SENSOR_READINGS', 'SENSORS', 'SKU_DAILY_DEMAND',
                                  'LOT_MOVES', 'BIN_STOCK', 'LOTS', 'STORAGE_BINS', 'WH_EDGES', 'WH_NODES', 'SKU_HANDLING',
                                  'WMS_SETTINGS', 'WMS_EVENTS')) LOOP
    EXECUTE IMMEDIATE 'DROP TABLE ' || t.table_name || ' CASCADE CONSTRAINTS PURGE';
  END LOOP;
END;
/

-- ============================================================================
-- Product handling rules (one row per product)
-- ============================================================================
CREATE TABLE sku_handling (
  sku_id           VARCHAR2(20)  CONSTRAINT pk_sku_handling PRIMARY KEY CONSTRAINT fk_skh_sku REFERENCES skus (sku_id),
  shelf_life_days  NUMBER(5),
  temp_zone        VARCHAR2(8)   DEFAULT 'AMBIENT' NOT NULL,
  min_c            NUMBER(4,1)   NOT NULL,
  max_c            NUMBER(4,1)   NOT NULL,
  lead_time_days   NUMBER(3)     NOT NULL,
  unit_cost        NUMBER(10,2)  NOT NULL,
  order_cost       NUMBER(10,2)  NOT NULL,
  supplier         VARCHAR2(60)  NOT NULL,
  description      VARCHAR2(300) NOT NULL,
  embed_model      VARCHAR2(60),
  CONSTRAINT ck_skh_zone  CHECK (temp_zone IN ('AMBIENT', 'COLD')),
  CONSTRAINT ck_skh_range CHECK (min_c < max_c),
  CONSTRAINT ck_skh_life  CHECK (shelf_life_days IS NULL OR shelf_life_days > 0),
  CONSTRAINT ck_skh_cost  CHECK (unit_cost > 0 AND order_cost > 0 AND lead_time_days > 0)
);
COMMENT ON TABLE sku_handling IS 'Storage and supply rules per product: shelf life (FEFO), temperature range, lead time and costs (reorder point, EOQ)';

-- ============================================================================
-- The aisle network inside each building: a graph of points and aisle segments
-- ============================================================================
CREATE TABLE wh_nodes (
  node_id      VARCHAR2(20)  CONSTRAINT pk_wh_nodes PRIMARY KEY,
  facility_id  VARCHAR2(10)  NOT NULL CONSTRAINT fk_whn_facility REFERENCES facilities (facility_id),
  node_kind    VARCHAR2(6)   NOT NULL,
  pos_x        NUMBER(7,2)   NOT NULL,
  pos_z        NUMBER(7,2)   NOT NULL,
  node_label   VARCHAR2(60)  NOT NULL,
  CONSTRAINT ck_whn_kind CHECK (node_kind IN ('DOCK', 'CROSS', 'AISLE'))
);
CREATE INDEX ix_whn_facility ON wh_nodes (facility_id);

CREATE TABLE wh_edges (
  edge_id      NUMBER        CONSTRAINT pk_wh_edges PRIMARY KEY,
  facility_id  VARCHAR2(10)  NOT NULL CONSTRAINT fk_whe_facility REFERENCES facilities (facility_id),
  from_node    VARCHAR2(20)  NOT NULL CONSTRAINT fk_whe_from REFERENCES wh_nodes (node_id),
  to_node      VARCHAR2(20)  NOT NULL CONSTRAINT fk_whe_to REFERENCES wh_nodes (node_id),
  metres       NUMBER(7,2)   NOT NULL,
  CONSTRAINT ck_whe_metres CHECK (metres > 0),
  CONSTRAINT ck_whe_loop   CHECK (from_node <> to_node),
  CONSTRAINT uq_whe_pair   UNIQUE (from_node, to_node)
);
CREATE INDEX ix_whe_to ON wh_edges (to_node);
COMMENT ON TABLE wh_edges IS 'Aisle segments (two-way). WT_WMS.SHORTEST_PATH runs Dijkstra over them; 12_wms_optional.sql also defines them as a SQL property graph';

-- ============================================================================
-- Storage bins: one pallet position each (aisle, bay, side, level)
-- ============================================================================
CREATE TABLE storage_bins (
  bin_id       VARCHAR2(20)  CONSTRAINT pk_storage_bins PRIMARY KEY,
  facility_id  VARCHAR2(10)  NOT NULL CONSTRAINT fk_bin_facility REFERENCES facilities (facility_id),
  aisle        CHAR(1)       NOT NULL,
  bay          NUMBER(3)     NOT NULL,
  rack_side    CHAR(1)       NOT NULL,
  lvl          NUMBER(1)     NOT NULL,
  pos_x        NUMBER(7,2)   NOT NULL,
  pos_z        NUMBER(7,2)   NOT NULL,
  node_id      VARCHAR2(20)  NOT NULL CONSTRAINT fk_bin_node REFERENCES wh_nodes (node_id),
  temp_zone    VARCHAR2(8)   NOT NULL,
  dock_metres  NUMBER(6,2)   NOT NULL,
  bin_status   VARCHAR2(8)   DEFAULT 'OK' NOT NULL,
  CONSTRAINT ck_bin_side   CHECK (rack_side IN ('L', 'R')),
  CONSTRAINT ck_bin_level  CHECK (lvl BETWEEN 1 AND 5),
  CONSTRAINT ck_bin_zone   CHECK (temp_zone IN ('AMBIENT', 'COLD')),
  CONSTRAINT ck_bin_status CHECK (bin_status IN ('OK', 'BLOCKED')),
  CONSTRAINT uq_bin_place  UNIQUE (facility_id, aisle, bay, rack_side, lvl)
);
CREATE INDEX ix_bin_node ON storage_bins (node_id);
COMMENT ON TABLE storage_bins IS 'Pallet positions in the racks; dock_metres = shortest travel from the nearest dock door over WH_EDGES (slotting)';

-- ============================================================================
-- Lots (one per inbound shipment and product) and what is in each bin
-- ============================================================================
CREATE TABLE lots (
  lot_id          VARCHAR2(20)  CONSTRAINT pk_lots PRIMARY KEY,
  facility_id     VARCHAR2(10)  NOT NULL CONSTRAINT fk_lot_facility REFERENCES facilities (facility_id),
  sku_id          VARCHAR2(20)  NOT NULL CONSTRAINT fk_lot_sku REFERENCES skus (sku_id),
  supplier        VARCHAR2(80)  NOT NULL,
  shipment_id     VARCHAR2(20),
  container_no    VARCHAR2(11),
  received_at     TIMESTAMP     NOT NULL,
  expiry_date     DATE,
  qc_status       VARCHAR2(9)   DEFAULT 'RELEASED' NOT NULL,
  qc_reason       VARCHAR2(200),
  qc_changed_at   TIMESTAMP,
  units_received  NUMBER(10)    DEFAULT 0 NOT NULL,
  units_on_hand   NUMBER(10)    DEFAULT 0 NOT NULL,   -- maintained by trg_lot_moves_ai
  CONSTRAINT ck_lot_qc     CHECK (qc_status IN ('RELEASED', 'HOLD', 'RECALLED')),
  CONSTRAINT ck_lot_reason CHECK (qc_status = 'RELEASED' OR qc_reason IS NOT NULL)
);
CREATE INDEX ix_lot_pick ON lots (facility_id, sku_id, qc_status, expiry_date);
CREATE INDEX ix_lot_shipment ON lots (shipment_id);
COMMENT ON TABLE lots IS 'Batches of one product received together; expiry_date drives FEFO picking, qc_status HOLD/RECALLED blocks picking';

CREATE TABLE bin_stock (
  bin_id     VARCHAR2(20)  CONSTRAINT pk_bin_stock PRIMARY KEY CONSTRAINT fk_bs_bin REFERENCES storage_bins (bin_id),
  sscc       CHAR(18)      NOT NULL CONSTRAINT uq_bs_sscc UNIQUE,
  lot_id     VARCHAR2(20)  NOT NULL CONSTRAINT fk_bs_lot REFERENCES lots (lot_id),
  units      NUMBER(8)     NOT NULL,
  placed_at  TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT ck_bs_units CHECK (units > 0),
  -- GS1 SSCC-18: 18 digits, the last one a mod-10 check digit (weights 3,1,3,… from the left)
  CONSTRAINT ck_bs_sscc
    CHECK (REGEXP_LIKE(sscc, '^[0-9]{18}$') AND
           MOD(10 - MOD(
            TO_NUMBER(SUBSTR(sscc, 1, 1)) * 3 + TO_NUMBER(SUBSTR(sscc, 2, 1)) + TO_NUMBER(SUBSTR(sscc, 3, 1)) * 3 +
            TO_NUMBER(SUBSTR(sscc, 4, 1)) + TO_NUMBER(SUBSTR(sscc, 5, 1)) * 3 + TO_NUMBER(SUBSTR(sscc, 6, 1)) +
            TO_NUMBER(SUBSTR(sscc, 7, 1)) * 3 + TO_NUMBER(SUBSTR(sscc, 8, 1)) + TO_NUMBER(SUBSTR(sscc, 9, 1)) * 3 +
            TO_NUMBER(SUBSTR(sscc, 10, 1)) + TO_NUMBER(SUBSTR(sscc, 11, 1)) * 3 + TO_NUMBER(SUBSTR(sscc, 12, 1)) +
            TO_NUMBER(SUBSTR(sscc, 13, 1)) * 3 + TO_NUMBER(SUBSTR(sscc, 14, 1)) + TO_NUMBER(SUBSTR(sscc, 15, 1)) * 3 +
            TO_NUMBER(SUBSTR(sscc, 16, 1)) + TO_NUMBER(SUBSTR(sscc, 17, 1)) * 3, 10), 10) = TO_NUMBER(SUBSTR(sscc, 18, 1)))
);
CREATE INDEX ix_bs_lot ON bin_stock (lot_id);
COMMENT ON TABLE bin_stock IS 'The pallet in each occupied bin, identified by its GS1 SSCC (check digit enforced by ck_bs_sscc)';

-- ============================================================================
-- Movement ledger per lot (signed units); the trigger keeps lots and demand up to date
-- ============================================================================
CREATE TABLE lot_moves (
  move_id      NUMBER GENERATED ALWAYS AS IDENTITY CONSTRAINT pk_lot_moves PRIMARY KEY,
  lot_id       VARCHAR2(20)  NOT NULL CONSTRAINT fk_lm_lot REFERENCES lots (lot_id),
  facility_id  VARCHAR2(10)  NOT NULL CONSTRAINT fk_lm_facility REFERENCES facilities (facility_id),
  sku_id       VARCHAR2(20)  NOT NULL CONSTRAINT fk_lm_sku REFERENCES skus (sku_id),
  move_type    VARCHAR2(10)  NOT NULL,
  units        NUMBER(10)    NOT NULL,
  bin_id       VARCHAR2(20),
  to_bin_id    VARCHAR2(20),
  sscc         CHAR(18),
  ref_kind     VARCHAR2(8),
  ref_id       VARCHAR2(30),
  metres       NUMBER(7,1),
  fefo_ok      CHAR(1),
  sim_time_s   NUMBER(7),
  created_by   NUMBER        CONSTRAINT fk_lm_user REFERENCES app_users (user_id),
  created_at   TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT ck_lm_type CHECK (move_type IN ('OPENING', 'RECEIVE', 'PICK', 'SHIP_STORE', 'RETURN', 'RELOCATE', 'ADJUST')),
  CONSTRAINT ck_lm_sign CHECK ((move_type IN ('OPENING', 'RECEIVE', 'RETURN') AND units > 0)
                            OR (move_type IN ('PICK', 'SHIP_STORE') AND units < 0)
                            OR (move_type = 'RELOCATE' AND units = 0)
                            OR move_type = 'ADJUST'),
  CONSTRAINT ck_lm_ref  CHECK (ref_kind IS NULL OR ref_kind IN ('SHIPMENT', 'ORDER', 'TASK', 'SCAN')),
  CONSTRAINT ck_lm_fefo CHECK (fefo_ok IS NULL OR fefo_ok IN ('Y', 'N'))
);
CREATE INDEX ix_lm_lot ON lot_moves (lot_id, created_at);
CREATE INDEX ix_lm_site ON lot_moves (facility_id, sku_id, created_at);
CREATE INDEX ix_lm_ref ON lot_moves (ref_kind, ref_id);
COMMENT ON TABLE lot_moves IS 'Every change to a lot: receipts, picks to trucks, deliveries to stores, relocations. Copied into the blockchain table STOCK_LEDGER';

-- Daily demand (units leaving stock) per site and product: history + today
CREATE TABLE sku_daily_demand (
  facility_id  VARCHAR2(10)  NOT NULL CONSTRAINT fk_dd_facility REFERENCES facilities (facility_id),
  sku_id       VARCHAR2(20)  NOT NULL CONSTRAINT fk_dd_sku REFERENCES skus (sku_id),
  demand_date  DATE          NOT NULL,
  units_out    NUMBER(10)    DEFAULT 0 NOT NULL,
  picks        NUMBER(8)     DEFAULT 0 NOT NULL,
  CONSTRAINT pk_sku_daily_demand PRIMARY KEY (facility_id, sku_id, demand_date),
  CONSTRAINT ck_dd_date  CHECK (demand_date = TRUNC(demand_date)),
  CONSTRAINT ck_dd_units CHECK (units_out >= 0 AND picks >= 0)
);

-- ============================================================================
-- Temperature monitoring
-- ============================================================================
CREATE TABLE sensors (
  sensor_id    VARCHAR2(12)  CONSTRAINT pk_sensors PRIMARY KEY,
  facility_id  VARCHAR2(10)  NOT NULL CONSTRAINT fk_sen_facility REFERENCES facilities (facility_id),
  temp_zone    VARCHAR2(8)   NOT NULL,
  sensor_label VARCHAR2(60)  NOT NULL,
  min_c        NUMBER(4,1)   NOT NULL,
  max_c        NUMBER(4,1)   NOT NULL,
  setpoint_c   NUMBER(4,1)   NOT NULL,
  pos_x        NUMBER(7,2)   NOT NULL,
  pos_z        NUMBER(7,2)   NOT NULL,
  door_open    CHAR(1)       DEFAULT 'N' NOT NULL,
  CONSTRAINT ck_sen_zone  CHECK (temp_zone IN ('AMBIENT', 'COLD')),
  CONSTRAINT ck_sen_range CHECK (min_c < max_c AND setpoint_c BETWEEN min_c AND max_c),
  CONSTRAINT ck_sen_door  CHECK (door_open IN ('Y', 'N'))
);
COMMENT ON COLUMN sensors.door_open IS 'Set to Y (from the app or SQL Developer) to simulate the cold room door being left open';

-- sensor_readings is created in 12_wms_optional.sql when interval partitioning is available;
-- this plain table is the fallback (and is replaced there).
CREATE TABLE sensor_readings (
  sensor_id  VARCHAR2(12)  NOT NULL CONSTRAINT fk_sr_sensor REFERENCES sensors (sensor_id),
  read_at    TIMESTAMP     NOT NULL,
  temp_c     NUMBER(5,2)   NOT NULL
);
CREATE INDEX ix_sr_sensor ON sensor_readings (sensor_id, read_at);

CREATE TABLE cold_breaches (
  breach_id      NUMBER GENERATED ALWAYS AS IDENTITY CONSTRAINT pk_cold_breaches PRIMARY KEY,
  sensor_id      VARCHAR2(12)  NOT NULL CONSTRAINT fk_cb_sensor REFERENCES sensors (sensor_id),
  facility_id    VARCHAR2(10)  NOT NULL CONSTRAINT fk_cb_facility REFERENCES facilities (facility_id),
  started_at     TIMESTAMP     NOT NULL,
  ended_at       TIMESTAMP,
  peak_c         NUMBER(5,2)   NOT NULL,
  readings_out   NUMBER(6)     NOT NULL,
  lots_held      NUMBER(6)     DEFAULT 0 NOT NULL,
  breach_status  VARCHAR2(6)   DEFAULT 'OPEN' NOT NULL,
  detected_by    VARCHAR2(30)  DEFAULT 'WT_WMS.DETECT_BREACHES' NOT NULL,
  detected_at    TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT ck_cb_status CHECK (breach_status IN ('OPEN', 'CLOSED')),
  CONSTRAINT uq_cb_start  UNIQUE (sensor_id, started_at)
);

-- ============================================================================
-- Scans, damage reports, settings and the event log
-- ============================================================================
CREATE TABLE scan_log (
  scan_id      NUMBER GENERATED ALWAYS AS IDENTITY CONSTRAINT pk_scan_log PRIMARY KEY,
  facility_id  VARCHAR2(10)  CONSTRAINT fk_scan_facility REFERENCES facilities (facility_id),
  scanned_code VARCHAR2(60)  NOT NULL,
  sscc         CHAR(18),
  is_valid     CHAR(1)       NOT NULL,
  result       VARCHAR2(300) NOT NULL,
  scanned_by   NUMBER        CONSTRAINT fk_scan_user REFERENCES app_users (user_id),
  created_at   TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT ck_scan_valid CHECK (is_valid IN ('Y', 'N'))
);

CREATE TABLE damage_reports (
  report_id    NUMBER GENERATED BY DEFAULT AS IDENTITY CONSTRAINT pk_damage_reports PRIMARY KEY,
  facility_id  VARCHAR2(10)  NOT NULL CONSTRAINT fk_dr_facility REFERENCES facilities (facility_id),
  sku_id       VARCHAR2(20)  NOT NULL CONSTRAINT fk_dr_sku REFERENCES skus (sku_id),
  lot_id       VARCHAR2(20),
  sscc         CHAR(18),
  severity     VARCHAR2(6)   NOT NULL,
  report_text  VARCHAR2(500) NOT NULL,
  reported_by  VARCHAR2(60)  NOT NULL,
  created_at   TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
  embed_model  VARCHAR2(60),
  CONSTRAINT ck_dr_severity CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH'))
);
COMMENT ON TABLE damage_reports IS 'Free-text damage and incident reports; 12_wms_optional.sql adds an EMBEDDING VECTOR column for semantic search (Oracle 23ai)';

CREATE TABLE wms_settings (
  facility_id     VARCHAR2(10)  CONSTRAINT pk_wms_settings PRIMARY KEY CONSTRAINT fk_ws_facility REFERENCES facilities (facility_id),
  putaway_policy  VARCHAR2(6)   DEFAULT 'RANDOM' NOT NULL,
  updated_at      TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT ck_ws_policy CHECK (putaway_policy IN ('RANDOM', 'ABC'))
);

CREATE TABLE wms_events (
  event_id     NUMBER GENERATED ALWAYS AS IDENTITY CONSTRAINT pk_wms_events PRIMARY KEY,
  event_type   VARCHAR2(20)   NOT NULL,
  facility_id  VARCHAR2(10),
  title        VARCHAR2(200)  NOT NULL,
  detail       VARCHAR2(1000),
  ref_kind     VARCHAR2(12),
  ref_id       VARCHAR2(40),
  created_at   TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL
);
COMMENT ON TABLE wms_events IS 'Durable log of warehouse events; WT_EVENTS.PUBLISH also puts each one on the CV_EVENTS queue';

-- ============================================================================
-- Package WT_EVENTS: publish warehouse events (table + Transactional Event Queue)
-- ============================================================================
CREATE OR REPLACE PACKAGE wt_events AS
  -- Writes the event to WMS_EVENTS and enqueues it on CV_EVENTS (when the queue exists).
  -- The message becomes visible to the server only when the caller commits: an event
  -- of a transaction that rolls back is never delivered.
  PROCEDURE publish (
    p_type     IN VARCHAR2,
    p_facility IN VARCHAR2,
    p_title    IN VARCHAR2,
    p_detail   IN VARCHAR2 DEFAULT NULL,
    p_ref_kind IN VARCHAR2 DEFAULT NULL,
    p_ref_id   IN VARCHAR2 DEFAULT NULL);
  -- Takes up to p_max messages off the queue, waiting up to p_wait seconds for the first.
  -- Returns a JSON array (the caller commits to remove them from the queue).
  FUNCTION dequeue_batch (p_wait IN NUMBER, p_max IN NUMBER DEFAULT 50) RETURN CLOB;
  FUNCTION queue_ready RETURN CHAR;
END wt_events;
/

CREATE OR REPLACE PACKAGE BODY wt_events AS

  FUNCTION queue_ready RETURN CHAR IS
    v_n NUMBER;
  BEGIN
    SELECT COUNT(*) INTO v_n FROM user_queues WHERE name = 'CV_EVENTS' AND TRIM(enqueue_enabled) = 'YES';
    RETURN CASE WHEN v_n > 0 THEN 'Y' ELSE 'N' END;
  END queue_ready;

  PROCEDURE publish (
    p_type     IN VARCHAR2,
    p_facility IN VARCHAR2,
    p_title    IN VARCHAR2,
    p_detail   IN VARCHAR2 DEFAULT NULL,
    p_ref_kind IN VARCHAR2 DEFAULT NULL,
    p_ref_id   IN VARCHAR2 DEFAULT NULL)
  IS
    v_id   NUMBER;
    v_json VARCHAR2(4000);
  BEGIN
    INSERT INTO wms_events (event_type, facility_id, title, detail, ref_kind, ref_id)
    VALUES (p_type, p_facility, SUBSTR(p_title, 1, 200), SUBSTR(p_detail, 1, 1000), p_ref_kind, p_ref_id)
    RETURNING event_id INTO v_id;
    SELECT JSON_OBJECT('id' VALUE v_id, 'type' VALUE p_type, 'facility' VALUE p_facility,
                       'title' VALUE SUBSTR(p_title, 1, 200), 'detail' VALUE SUBSTR(p_detail, 1, 1000),
                       'refKind' VALUE p_ref_kind, 'refId' VALUE p_ref_id,
                       'at' VALUE TO_CHAR(SYS_EXTRACT_UTC(SYSTIMESTAMP), 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'))
      INTO v_json FROM dual;
    -- dynamic PL/SQL: the package compiles (and the table log works) even without DBMS_AQ
    BEGIN
      EXECUTE IMMEDIATE q'[
        DECLARE
          o DBMS_AQ.ENQUEUE_OPTIONS_T;
          p DBMS_AQ.MESSAGE_PROPERTIES_T;
          h RAW(16);
        BEGIN
          DBMS_AQ.ENQUEUE(queue_name => 'CV_EVENTS', enqueue_options => o, message_properties => p,
                          payload => UTL_RAW.CAST_TO_RAW(:m), msgid => h);
        END;]' USING v_json;
    EXCEPTION
      WHEN OTHERS THEN NULL; -- no queue: the server reads WMS_EVENTS instead
    END;
  END publish;

  FUNCTION dequeue_batch (p_wait IN NUMBER, p_max IN NUMBER DEFAULT 50) RETURN CLOB IS
    v_out   CLOB := '[';
    v_msg   VARCHAR2(4000);
    v_count PLS_INTEGER := 0;
    v_wait  NUMBER := p_wait;
  BEGIN
    LOOP
      EXIT WHEN v_count >= p_max;
      BEGIN
        EXECUTE IMMEDIATE q'[
          DECLARE
            o DBMS_AQ.DEQUEUE_OPTIONS_T;
            p DBMS_AQ.MESSAGE_PROPERTIES_T;
            h RAW(16);
            m RAW(4000);
          BEGIN
            o.wait := :w;
            o.navigation := DBMS_AQ.FIRST_MESSAGE;
            DBMS_AQ.DEQUEUE(queue_name => 'CV_EVENTS', dequeue_options => o, message_properties => p, payload => m, msgid => h);
            :msg := UTL_RAW.CAST_TO_VARCHAR2(m);
          END;]' USING IN v_wait, OUT v_msg;
      EXCEPTION
        WHEN OTHERS THEN
          IF SQLCODE = -25228 THEN EXIT; END IF; -- timeout / no more messages
          RAISE;
      END;
      v_out := v_out || CASE WHEN v_count > 0 THEN ',' END || v_msg;
      v_count := v_count + 1;
      v_wait := 0; -- the rest of the batch: only what is already there
    END LOOP;
    RETURN v_out || ']';
  END dequeue_batch;

END wt_events;
/

-- ============================================================================
-- Package WT_WMS: warehouse rules in the database
-- ============================================================================
CREATE OR REPLACE PACKAGE wt_wms AS
  -- GS1 mod-10 check digit of the first 17 digits of an SSCC
  FUNCTION sscc_check_digit (p_body IN VARCHAR2) RETURN NUMBER DETERMINISTIC;
  FUNCTION valid_sscc (p_code IN VARCHAR2) RETURN CHAR DETERMINISTIC;
  -- The lot to pick next for a site and product: first expiry, first out (released lots with stock only)
  FUNCTION fefo_lot (p_facility IN VARCHAR2, p_sku IN VARCHAR2) RETURN VARCHAR2;
  -- Shortest route over WH_EDGES (Dijkstra): JSON {"metres":…, "nodes":[…]}
  FUNCTION shortest_path (p_from IN VARCHAR2, p_to IN VARCHAR2) RETURN CLOB;
  -- Quality actions (audited, published as events, tasks for the people who must act)
  FUNCTION recall_lot (p_lot IN VARCHAR2, p_reason IN VARCHAR2, p_user IN NUMBER) RETURN NUMBER;
  PROCEDURE release_lot (p_lot IN VARCHAR2, p_user IN NUMBER);
  -- Puts on HOLD the released lots stored in a zone whose product range a temperature left
  FUNCTION hold_zone (p_facility IN VARCHAR2, p_zone IN VARCHAR2, p_high_c IN NUMBER, p_low_c IN NUMBER, p_reason IN VARCHAR2) RETURN NUMBER;
  -- Cold chain: finds 3+ consecutive readings outside a sensor's range (MATCH_RECOGNIZE),
  -- records new breaches and puts the lots in that zone on HOLD. Run by the CV_DETECT_BREACHES job.
  FUNCTION detect_breaches RETURN NUMBER;
  -- Scanning: looks a code up (bin stock or a pallet on the yard), logs the scan, returns JSON
  FUNCTION scan (p_code IN VARCHAR2, p_user IN NUMBER) RETURN CLOB;
  -- Maintenance: drops sensor readings older than p_days (partition-wise when partitioned)
  PROCEDURE purge_readings (p_days IN NUMBER DEFAULT 2);
  FUNCTION pick_clerk (p_facility IN VARCHAR2) RETURN NUMBER;
END wt_wms;
/

CREATE OR REPLACE PACKAGE BODY wt_wms AS

  FUNCTION sscc_check_digit (p_body IN VARCHAR2) RETURN NUMBER DETERMINISTIC IS
    v_sum NUMBER := 0;
  BEGIN
    FOR i IN 1 .. 17 LOOP
      v_sum := v_sum + TO_NUMBER(SUBSTR(p_body, i, 1)) * CASE WHEN MOD(i, 2) = 1 THEN 3 ELSE 1 END;
    END LOOP;
    RETURN MOD(10 - MOD(v_sum, 10), 10);
  END sscc_check_digit;

  FUNCTION valid_sscc (p_code IN VARCHAR2) RETURN CHAR DETERMINISTIC IS
  BEGIN
    IF p_code IS NULL OR NOT REGEXP_LIKE(p_code, '^[0-9]{18}$') THEN
      RETURN 'N';
    END IF;
    RETURN CASE WHEN sscc_check_digit(SUBSTR(p_code, 1, 17)) = TO_NUMBER(SUBSTR(p_code, 18, 1)) THEN 'Y' ELSE 'N' END;
  END valid_sscc;

  FUNCTION fefo_lot (p_facility IN VARCHAR2, p_sku IN VARCHAR2) RETURN VARCHAR2 IS
    v_lot lots.lot_id%TYPE;
  BEGIN
    SELECT lot_id INTO v_lot
      FROM (SELECT l.lot_id
              FROM lots l
             WHERE l.facility_id = p_facility
               AND l.sku_id = p_sku
               AND l.qc_status = 'RELEASED'
               AND EXISTS (SELECT 1 FROM bin_stock b JOIN storage_bins s ON s.bin_id = b.bin_id
                            WHERE b.lot_id = l.lot_id AND s.bin_status = 'OK')
             ORDER BY l.expiry_date NULLS LAST, l.received_at, l.lot_id)
     WHERE ROWNUM = 1;
    RETURN v_lot;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN RETURN NULL;
  END fefo_lot;

  FUNCTION shortest_path (p_from IN VARCHAR2, p_to IN VARCHAR2) RETURN CLOB IS
    TYPE t_num IS TABLE OF NUMBER INDEX BY VARCHAR2(20);
    TYPE t_str IS TABLE OF VARCHAR2(20) INDEX BY VARCHAR2(20);
    v_dist  t_num;
    v_done  t_num;
    v_prev  t_str;
    v_fac   wh_nodes.facility_id%TYPE;
    v_u     VARCHAR2(20);
    v_best  NUMBER;
    v_k     VARCHAR2(20);
    v_path  VARCHAR2(4000);
    v_json  CLOB;
  BEGIN
    SELECT facility_id INTO v_fac FROM wh_nodes WHERE node_id = p_from;
    v_dist(p_from) := 0;
    LOOP
      -- the unvisited node with the smallest tentative distance
      v_u := NULL;
      v_best := NULL;
      v_k := v_dist.FIRST;
      WHILE v_k IS NOT NULL LOOP
        IF NOT v_done.EXISTS(v_k) AND (v_best IS NULL OR v_dist(v_k) < v_best) THEN
          v_best := v_dist(v_k);
          v_u := v_k;
        END IF;
        v_k := v_dist.NEXT(v_k);
      END LOOP;
      EXIT WHEN v_u IS NULL OR v_u = p_to;
      v_done(v_u) := 1;
      -- relax every aisle segment touching it (segments are two-way)
      FOR e IN (SELECT to_node AS nb, metres FROM wh_edges WHERE from_node = v_u
                UNION ALL
                SELECT from_node, metres FROM wh_edges WHERE to_node = v_u) LOOP
        IF NOT v_dist.EXISTS(e.nb) OR v_best + e.metres < v_dist(e.nb) THEN
          v_dist(e.nb) := v_best + e.metres;
          v_prev(e.nb) := v_u;
        END IF;
      END LOOP;
    END LOOP;
    IF NOT v_dist.EXISTS(p_to) THEN
      RETURN '{"metres":null,"nodes":[]}';
    END IF;
    v_k := p_to;
    v_path := '"' || p_to || '"';
    WHILE v_k <> p_from LOOP
      v_k := v_prev(v_k);
      v_path := '"' || v_k || '",' || v_path;
    END LOOP;
    v_json := '{"facility":"' || v_fac || '","metres":' || TO_CHAR(ROUND(v_dist(p_to), 2), 'FM99990.00') || ',"nodes":[' || v_path || ']}';
    RETURN v_json;
  END shortest_path;

  FUNCTION pick_clerk (p_facility IN VARCHAR2) RETURN NUMBER IS
    v_emp NUMBER;
  BEGIN
    SELECT employee_id INTO v_emp
      FROM (SELECT e.employee_id
              FROM employees e
             WHERE e.facility_id = p_facility
               AND e.emp_status = 'ACTIVE'
               AND e.job_code IN ('INVENTORY_CLERK', 'DOCK_SUPERVISOR', 'FORKLIFT_OPERATOR')
             ORDER BY CASE e.job_code WHEN 'INVENTORY_CLERK' THEN 1 WHEN 'DOCK_SUPERVISOR' THEN 2 ELSE 3 END,
                      (SELECT COUNT(*) FROM tasks t WHERE t.assigned_to = e.employee_id AND t.task_status IN ('ASSIGNED', 'IN_PROGRESS', 'BLOCKED')),
                      e.employee_id)
     WHERE ROWNUM = 1;
    RETURN v_emp;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN RETURN NULL;
  END pick_clerk;

  FUNCTION recall_lot (p_lot IN VARCHAR2, p_reason IN VARCHAR2, p_user IN NUMBER) RETURN NUMBER IS
    v_lot     lots%ROWTYPE;
    v_bins    NUMBER;
    v_task    NUMBER;
    v_stores  NUMBER := 0;
    v_name    skus.name%TYPE;
  BEGIN
    IF p_user IS NOT NULL AND wt_core.has_permission(p_user, 'MANAGE_TASKS') = 'N' THEN
      RAISE_APPLICATION_ERROR(-20003, 'Not permitted: a recall requires MANAGE_TASKS');
    END IF;
    BEGIN
      SELECT * INTO v_lot FROM lots WHERE lot_id = p_lot FOR UPDATE;
    EXCEPTION
      WHEN NO_DATA_FOUND THEN RAISE_APPLICATION_ERROR(-20001, 'Lot ' || p_lot || ' not found');
    END;
    IF p_user IS NOT NULL AND wt_core.can_access_facility(p_user, v_lot.facility_id) = 'N' THEN
      RAISE_APPLICATION_ERROR(-20005, 'No access to facility ' || v_lot.facility_id);
    END IF;
    SELECT name INTO v_name FROM skus WHERE sku_id = v_lot.sku_id;
    UPDATE lots SET qc_status = 'RECALLED', qc_reason = SUBSTR(NVL(p_reason, 'Recall'), 1, 200), qc_changed_at = SYSTIMESTAMP
     WHERE lot_id = p_lot;
    SELECT COUNT(*) INTO v_bins FROM bin_stock WHERE lot_id = p_lot;
    -- the warehouse quarantines what is still in stock
    wt_work.create_task(NULL, v_lot.facility_id, 'Quarantine recalled lot ' || p_lot,
      'Move ' || v_bins || ' pallet(s) of ' || v_name || ' (lot ' || p_lot || ') to the quarantine cage. Reason: ' || p_reason,
      'OTHER', 'URGENT', pick_clerk(v_lot.facility_id), NULL, NULL, NULL, NULL, 60, 'SYSTEM', v_task);
    -- every store that received the lot pulls it from the shelf
    FOR s IN (SELECT DISTINCT o.store_id, st.name, o.facility_id
                FROM lot_moves m
                JOIN store_orders o ON o.order_id = m.ref_id
                JOIN stores st ON st.store_id = o.store_id
               WHERE m.lot_id = p_lot AND m.move_type = 'SHIP_STORE' AND m.ref_kind = 'ORDER') LOOP
      wt_work.create_task(NULL, s.facility_id, 'Recall: pull lot ' || p_lot || ' at ' || s.name,
        'Collect every unit of ' || v_name || ' from lot ' || p_lot || ' at ' || s.name || ' and return it. Reason: ' || p_reason,
        'OTHER', 'HIGH', pick_clerk(s.facility_id), NULL, NULL, NULL, NULL, 240, 'SYSTEM', v_task);
      v_stores := v_stores + 1;
    END LOOP;
    wt_core.log_audit('LOT_RECALLED', 'LOT', p_lot, v_lot.facility_id, p_reason || ' · ' || v_bins || ' pallets in stock · ' || v_stores || ' stores', p_user);
    wt_events.publish('RECALL', v_lot.facility_id, 'Lot ' || p_lot || ' recalled (' || v_name || ')',
      v_bins || ' pallets quarantined, ' || v_stores || ' stores notified. ' || p_reason, 'lot', p_lot);
    RETURN v_stores;
  END recall_lot;

  PROCEDURE release_lot (p_lot IN VARCHAR2, p_user IN NUMBER) IS
    v_lot lots%ROWTYPE;
  BEGIN
    IF p_user IS NOT NULL AND wt_core.has_permission(p_user, 'MANAGE_TASKS') = 'N' THEN
      RAISE_APPLICATION_ERROR(-20003, 'Not permitted: releasing a lot requires MANAGE_TASKS');
    END IF;
    BEGIN
      SELECT * INTO v_lot FROM lots WHERE lot_id = p_lot FOR UPDATE;
    EXCEPTION
      WHEN NO_DATA_FOUND THEN RAISE_APPLICATION_ERROR(-20001, 'Lot ' || p_lot || ' not found');
    END;
    IF v_lot.qc_status = 'RELEASED' THEN
      RETURN;
    END IF;
    UPDATE lots SET qc_status = 'RELEASED', qc_reason = NULL, qc_changed_at = SYSTIMESTAMP WHERE lot_id = p_lot;
    wt_core.log_audit('LOT_RELEASED', 'LOT', p_lot, v_lot.facility_id, 'Released after quality check (was ' || v_lot.qc_status || ')', p_user);
    wt_events.publish('RELEASE', v_lot.facility_id, 'Lot ' || p_lot || ' released', 'Quality check passed; the lot can be picked again', 'lot', p_lot);
  END release_lot;

  FUNCTION hold_zone (p_facility IN VARCHAR2, p_zone IN VARCHAR2, p_high_c IN NUMBER, p_low_c IN NUMBER, p_reason IN VARCHAR2) RETURN NUMBER IS
    v_n NUMBER;
  BEGIN
    UPDATE lots l
       SET qc_status = 'HOLD', qc_reason = SUBSTR(p_reason, 1, 200), qc_changed_at = SYSTIMESTAMP
     WHERE l.facility_id = p_facility
       AND l.qc_status = 'RELEASED'
       AND EXISTS (SELECT 1 FROM sku_handling h
                    WHERE h.sku_id = l.sku_id AND (p_high_c > h.max_c OR p_low_c < h.min_c))
       AND EXISTS (SELECT 1 FROM bin_stock b JOIN storage_bins s ON s.bin_id = b.bin_id
                    WHERE b.lot_id = l.lot_id AND s.temp_zone = p_zone);
    v_n := SQL%ROWCOUNT;
    RETURN v_n;
  END hold_zone;

  FUNCTION detect_breaches RETURN NUMBER IS
    v_new   NUMBER := 0;
    v_held  NUMBER;
    v_task  NUMBER;
  BEGIN
    -- Row pattern matching: runs of 3+ consecutive readings outside the sensor's range
    FOR b IN (
      SELECT *
        FROM (SELECT r.sensor_id, r.read_at, r.temp_c, s.min_c, s.max_c, s.facility_id, s.temp_zone, s.sensor_label
                FROM sensor_readings r
                JOIN sensors s ON s.sensor_id = r.sensor_id
               WHERE r.read_at > SYSTIMESTAMP - INTERVAL '60' MINUTE)
      MATCH_RECOGNIZE (
        PARTITION BY sensor_id, facility_id, temp_zone, sensor_label
        ORDER BY read_at
        MEASURES FIRST(out_of_range.read_at) AS started_at,
                 MAX(out_of_range.min_c)     AS min_c,
                 MAX(out_of_range.max_c)     AS max_c,
                 LAST(out_of_range.read_at)  AS last_out_at,
                 MAX(out_of_range.temp_c)    AS peak_c,
                 MIN(out_of_range.temp_c)    AS low_c,
                 COUNT(out_of_range.*)       AS readings_out
        ONE ROW PER MATCH
        AFTER MATCH SKIP PAST LAST ROW
        PATTERN (out_of_range{3,})
        DEFINE out_of_range AS out_of_range.temp_c > out_of_range.max_c OR out_of_range.temp_c < out_of_range.min_c
      )) LOOP
      MERGE INTO cold_breaches c
      USING (SELECT b.sensor_id AS sensor_id, b.started_at AS started_at FROM dual) x
         ON (c.sensor_id = x.sensor_id AND c.started_at = x.started_at)
      WHEN MATCHED THEN UPDATE SET c.peak_c = GREATEST(c.peak_c, b.peak_c), c.readings_out = b.readings_out
      WHEN NOT MATCHED THEN INSERT (sensor_id, facility_id, started_at, peak_c, readings_out)
                            VALUES (b.sensor_id, b.facility_id, b.started_at, b.peak_c, b.readings_out);
      -- act once per breach: hold the zone's lots, raise a task, publish the event
      FOR c IN (SELECT breach_id, lots_held FROM cold_breaches
                 WHERE sensor_id = b.sensor_id AND started_at = b.started_at AND breach_status = 'OPEN' AND lots_held = 0
                   AND NOT EXISTS (SELECT 1 FROM wms_events e WHERE e.event_type = 'BREACH' AND e.ref_id = 'BR-' || breach_id)) LOOP
        v_held := hold_zone(b.facility_id, b.temp_zone, b.peak_c, b.low_c,
                    'Temperature excursion at ' || b.sensor_id || ' (' || b.sensor_label || '), peak ' || TO_CHAR(b.peak_c, 'FM990.0') || ' °C');
        UPDATE cold_breaches SET lots_held = v_held WHERE breach_id = c.breach_id;
        wt_work.create_task(NULL, b.facility_id, 'Cold chain breach at ' || b.sensor_id,
          b.sensor_label || ': ' || b.readings_out || ' readings outside ' || b.min_c || '–' || b.max_c || ' °C (peak ' || TO_CHAR(b.peak_c, 'FM990.0')
          || ' °C). ' || v_held || ' lot(s) put on hold until quality assurance checks them.',
          'OTHER', 'URGENT', pick_clerk(b.facility_id), NULL, NULL, NULL, NULL, 30, 'SYSTEM', v_task);
        wt_events.publish('BREACH', b.facility_id, 'Cold chain breach at ' || b.sensor_id || ' — peak ' || TO_CHAR(b.peak_c, 'FM990.0') || ' °C',
          b.readings_out || ' readings in a row outside ' || b.min_c || '–' || b.max_c || ' °C; ' || v_held || ' lot(s) on hold', 'breach', 'BR-' || c.breach_id);
        v_new := v_new + 1;
      END LOOP;
      -- the match is greedy, so any reading after its last one is back in range: the breach is over
      UPDATE cold_breaches c
         SET c.breach_status = 'CLOSED',
             c.ended_at = (SELECT MIN(r.read_at) FROM sensor_readings r WHERE r.sensor_id = b.sensor_id AND r.read_at > b.last_out_at)
       WHERE c.sensor_id = b.sensor_id AND c.started_at = b.started_at AND c.breach_status = 'OPEN'
         AND EXISTS (SELECT 1 FROM sensor_readings r WHERE r.sensor_id = b.sensor_id AND r.read_at > b.last_out_at);
    END LOOP;
    RETURN v_new;
  END detect_breaches;

  FUNCTION scan (p_code IN VARCHAR2, p_user IN NUMBER) RETURN CLOB IS
    v_code   VARCHAR2(60) := REGEXP_REPLACE(p_code, '[^0-9]', '');
    v_valid  CHAR(1);
    v_json   CLOB;
    v_fac    VARCHAR2(10);
    v_result VARCHAR2(300);
  BEGIN
    -- GS1-128 text "(00)…" carries the SSCC after application identifier 00
    IF LENGTH(v_code) = 20 AND SUBSTR(v_code, 1, 2) = '00' THEN
      v_code := SUBSTR(v_code, 3);
    END IF;
    v_valid := valid_sscc(v_code);
    IF v_valid = 'N' THEN
      v_result := 'Invalid SSCC: ' || CASE WHEN LENGTH(v_code) <> 18 THEN 'needs 18 digits' ELSE 'check digit does not match' END;
      INSERT INTO scan_log (scanned_code, sscc, is_valid, result, scanned_by) VALUES (SUBSTR(p_code, 1, 60), NULL, 'N', v_result, p_user);
      SELECT JSON_OBJECT('valid' VALUE 'N', 'code' VALUE v_code, 'result' VALUE v_result RETURNING CLOB) INTO v_json FROM dual;
      RETURN v_json;
    END IF;
    BEGIN
      SELECT JSON_OBJECT('valid' VALUE 'Y', 'sscc' VALUE b.sscc, 'where' VALUE 'BIN', 'binId' VALUE b.bin_id, 'facility' VALUE s.facility_id,
                         'zone' VALUE s.temp_zone, 'binStatus' VALUE s.bin_status, 'lotId' VALUE l.lot_id, 'skuId' VALUE l.sku_id,
                         'sku' VALUE k.name, 'units' VALUE b.units, 'expiry' VALUE TO_CHAR(l.expiry_date, 'YYYY-MM-DD'),
                         'qc' VALUE l.qc_status, 'qcReason' VALUE l.qc_reason, 'supplier' VALUE l.supplier,
                         'fefoLot' VALUE wt_wms.fefo_lot(l.facility_id, l.sku_id), 'dockMetres' VALUE s.dock_metres RETURNING CLOB),
             s.facility_id
        INTO v_json, v_fac
        FROM bin_stock b
        JOIN storage_bins s ON s.bin_id = b.bin_id
        JOIN lots l ON l.lot_id = b.lot_id
        JOIN skus k ON k.sku_id = l.sku_id
       WHERE b.sscc = v_code;
      v_result := 'Pallet found in bin';
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        v_json := NULL;
    END;
    IF v_json IS NULL THEN
      -- a pallet on the yard or a forklift: SSCC serial = pallet number
      BEGIN
        SELECT JSON_OBJECT('valid' VALUE 'Y', 'sscc' VALUE v_code, 'where' VALUE CASE WHEN p.yard_slot IS NOT NULL THEN 'YARD' ELSE 'MOVING' END,
                           'palletId' VALUE p.pallet_id, 'facility' VALUE p.facility_id, 'slot' VALUE p.yard_slot,
                           'forkliftId' VALUE p.forklift_id, 'lotId' VALUE p.lot_no, 'skuId' VALUE p.sku_id, 'sku' VALUE k.name,
                           'units' VALUE p.qty, 'expiry' VALUE TO_CHAR(l.expiry_date, 'YYYY-MM-DD'), 'qc' VALUE NVL(l.qc_status, 'RELEASED'),
                           'qcReason' VALUE l.qc_reason, 'supplier' VALUE l.supplier RETURNING CLOB),
               p.facility_id
          INTO v_json, v_fac
          FROM pallets p
          JOIN skus k ON k.sku_id = p.sku_id
          LEFT JOIN lots l ON l.lot_id = p.lot_no
         WHERE p.pallet_id = 'PAL-' || TO_NUMBER(SUBSTR(v_code, 9, 9));
        v_result := 'Pallet found on the yard';
      EXCEPTION
        WHEN NO_DATA_FOUND THEN
          v_result := 'Valid SSCC, but no pallet with this label is in stock';
          SELECT JSON_OBJECT('valid' VALUE 'Y', 'sscc' VALUE v_code, 'where' VALUE 'NONE', 'result' VALUE v_result RETURNING CLOB)
            INTO v_json FROM dual;
      END;
    END IF;
    INSERT INTO scan_log (facility_id, scanned_code, sscc, is_valid, result, scanned_by)
    VALUES (v_fac, SUBSTR(p_code, 1, 60), v_code, 'Y', v_result, p_user);
    wt_events.publish('SCAN', v_fac, 'Pallet ' || v_code || ' scanned', v_result, 'sscc', v_code);
    RETURN v_json;
  END scan;

  PROCEDURE purge_readings (p_days IN NUMBER DEFAULT 2) IS
    v_part NUMBER;
  BEGIN
    SELECT COUNT(*) INTO v_part FROM user_part_tables WHERE table_name = 'SENSOR_READINGS';
    IF v_part > 0 THEN
      -- interval partitions: drop whole days at once (no row-by-row delete, no undo)
      FOR p IN (SELECT partition_name, high_value FROM user_tab_partitions
                 WHERE table_name = 'SENSOR_READINGS' AND partition_position > 1) LOOP
        DECLARE
          v_hi TIMESTAMP;
        BEGIN
          EXECUTE IMMEDIATE 'SELECT ' || p.high_value || ' FROM dual' INTO v_hi;
          IF v_hi < SYSTIMESTAMP - NUMTODSINTERVAL(p_days, 'DAY') THEN
            EXECUTE IMMEDIATE 'ALTER TABLE sensor_readings DROP PARTITION ' || p.partition_name;
          END IF;
        END;
      END LOOP;
    ELSE
      DELETE FROM sensor_readings WHERE read_at < SYSTIMESTAMP - NUMTODSINTERVAL(p_days, 'DAY');
    END IF;
  END purge_readings;

END wt_wms;
/

-- ============================================================================
-- Triggers
-- ============================================================================
-- Fallback ledger (replaced by a BLOCKCHAIN TABLE in 12_wms_optional.sql when supported).
BEGIN
  EXECUTE IMMEDIATE q'[
    CREATE TABLE stock_ledger (
      move_id      NUMBER        NOT NULL,
      lot_id       VARCHAR2(20)  NOT NULL,
      facility_id  VARCHAR2(10)  NOT NULL,
      sku_id       VARCHAR2(20)  NOT NULL,
      move_type    VARCHAR2(10)  NOT NULL,
      units        NUMBER(10)    NOT NULL,
      bin_id       VARCHAR2(20),
      ref_id       VARCHAR2(30),
      recorded_at  TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL)]';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE <> -955 THEN RAISE; END IF; -- already there: an immutable ledger survives reinstalls
END;
/

-- Each movement updates the lot's balance, today's demand and the immutable ledger.
CREATE OR REPLACE TRIGGER trg_lot_moves_ai
AFTER INSERT ON lot_moves
FOR EACH ROW
BEGIN
  IF :NEW.units <> 0 THEN
    UPDATE lots
       SET units_on_hand = units_on_hand + :NEW.units,
           units_received = units_received + CASE WHEN :NEW.move_type IN ('OPENING', 'RECEIVE') THEN :NEW.units ELSE 0 END
     WHERE lot_id = :NEW.lot_id;
  END IF;
  IF :NEW.move_type IN ('PICK', 'SHIP_STORE') THEN
    MERGE INTO sku_daily_demand d
    USING (SELECT :NEW.facility_id AS facility_id, :NEW.sku_id AS sku_id, TRUNC(:NEW.created_at) AS demand_date FROM dual) s
       ON (d.facility_id = s.facility_id AND d.sku_id = s.sku_id AND d.demand_date = s.demand_date)
    WHEN MATCHED THEN UPDATE SET d.units_out = d.units_out - :NEW.units, d.picks = d.picks + 1
    WHEN NOT MATCHED THEN INSERT (facility_id, sku_id, demand_date, units_out, picks)
                          VALUES (s.facility_id, s.sku_id, s.demand_date, -:NEW.units, 1);
  END IF;
  INSERT INTO stock_ledger (move_id, lot_id, facility_id, sku_id, move_type, units, bin_id, ref_id)
  VALUES (:NEW.move_id, :NEW.lot_id, :NEW.facility_id, :NEW.sku_id, :NEW.move_type, :NEW.units, NVL(:NEW.to_bin_id, :NEW.bin_id), :NEW.ref_id);
END;
/

-- A new lot is announced on the event queue.
CREATE OR REPLACE TRIGGER trg_lots_ai
AFTER INSERT ON lots
FOR EACH ROW
WHEN (NEW.shipment_id IS NOT NULL)
BEGIN
  wt_events.publish('LOT_RECEIVED', :NEW.facility_id, 'Lot ' || :NEW.lot_id || ' received',
    :NEW.sku_id || ' from ' || :NEW.supplier || CASE WHEN :NEW.container_no IS NOT NULL THEN ' (container ' || :NEW.container_no || ')' END
    || CASE WHEN :NEW.expiry_date IS NOT NULL THEN ', expires ' || TO_CHAR(:NEW.expiry_date, 'YYYY-MM-DD') END, 'lot', :NEW.lot_id);
END;
/

-- Quality status changes made outside the app (e.g. UPDATE lots … in SQL Developer) are announced too.
CREATE OR REPLACE TRIGGER trg_lots_qc_au
AFTER UPDATE OF qc_status ON lots
FOR EACH ROW
WHEN (NEW.qc_status <> OLD.qc_status)
BEGIN
  IF NVL(SYS_CONTEXT('USERENV', 'MODULE'), '-') <> 'cargoverse-api' AND NVL(SYS_CONTEXT('USERENV', 'MODULE'), '-') NOT LIKE 'DBMS_SCHEDULER%' THEN
    wt_events.publish('QC_CHANGE', :NEW.facility_id, 'Lot ' || :NEW.lot_id || ': ' || :OLD.qc_status || ' → ' || :NEW.qc_status,
      'Changed from ' || NVL(SYS_CONTEXT('USERENV', 'MODULE'), 'an outside client') || ' by ' || SYS_CONTEXT('USERENV', 'SESSION_USER')
      || CASE WHEN :NEW.qc_reason IS NOT NULL THEN ': ' || :NEW.qc_reason END, 'lot', :NEW.lot_id);
  END IF;
END;
/

CREATE OR REPLACE TRIGGER trg_damage_reports_ai
AFTER INSERT ON damage_reports
FOR EACH ROW
BEGIN
  wt_events.publish('DAMAGE', :NEW.facility_id, 'Damage reported: ' || :NEW.sku_id || ' (' || LOWER(:NEW.severity) || ')',
    SUBSTR(:NEW.report_text, 1, 300), 'damage', TO_CHAR(:NEW.report_id));
END;
/

-- ============================================================================
-- Views
-- ============================================================================
-- Stock by lot with days to expiry
CREATE OR REPLACE VIEW v_lot_stock AS
SELECT l.lot_id, l.facility_id, l.sku_id, k.name AS sku_name, l.supplier, l.shipment_id, l.container_no,
       l.received_at, l.expiry_date, TRUNC(l.expiry_date) - TRUNC(SYSDATE) AS days_to_expiry,
       l.qc_status, l.qc_reason, l.units_on_hand, l.units_received,
       (SELECT COUNT(*) FROM bin_stock b WHERE b.lot_id = l.lot_id) AS pallets_in_bins,
       RANK() OVER (PARTITION BY l.facility_id, l.sku_id
                    ORDER BY CASE WHEN l.qc_status = 'RELEASED' AND l.units_on_hand > 0 THEN 0 ELSE 1 END,
                             l.expiry_date NULLS LAST, l.received_at) AS fefo_rank
  FROM lots l
  JOIN skus k ON k.sku_id = l.sku_id;

-- Lots to sell or move first: expiring within 30 days (or already expired)
CREATE OR REPLACE VIEW v_expiring_lots AS
SELECT lot_id, facility_id, sku_id, sku_name, expiry_date, days_to_expiry, units_on_hand, qc_status,
       CASE WHEN days_to_expiry < 0 THEN 'EXPIRED'
            WHEN days_to_expiry <= 7 THEN 'CRITICAL'
            WHEN days_to_expiry <= 30 THEN 'SOON' END AS urgency
  FROM v_lot_stock
 WHERE expiry_date IS NOT NULL
   AND units_on_hand > 0
   AND days_to_expiry <= 30;

-- ABC analysis: products ranked by units picked in the last 30 days; A = up to 80 % of the volume
-- (always at least the fastest mover), B = up to 95 %, C = the slow tail
CREATE OR REPLACE VIEW v_sku_abc AS
WITH d AS (
  SELECT facility_id, sku_id, SUM(units_out) AS units_30d, SUM(picks) AS picks_30d
    FROM sku_daily_demand
   WHERE demand_date > TRUNC(SYSDATE) - 30
   GROUP BY facility_id, sku_id
), r AS (
  SELECT d.*,
         ROUND(100 * RATIO_TO_REPORT(units_30d) OVER (PARTITION BY facility_id), 1) AS share_pct,
         ROUND(100 * SUM(units_30d) OVER (PARTITION BY facility_id ORDER BY units_30d DESC, sku_id
                                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
                   / NULLIF(SUM(units_30d) OVER (PARTITION BY facility_id), 0), 1) AS cumulative_pct,
         ROW_NUMBER() OVER (PARTITION BY facility_id ORDER BY units_30d DESC, sku_id) AS velocity_rank
    FROM d
)
SELECT r.facility_id, r.sku_id, k.name AS sku_name, r.units_30d, r.picks_30d, r.share_pct, r.cumulative_pct, r.velocity_rank,
       CASE WHEN r.cumulative_pct <= 80 OR r.velocity_rank = 1 THEN 'A'
            WHEN r.cumulative_pct <= 95 THEN 'B'
            ELSE 'C' END AS abc_class,
       (SELECT ROUND(AVG(s.dock_metres), 1) FROM bin_stock b JOIN storage_bins s ON s.bin_id = b.bin_id
                                            JOIN lots l ON l.lot_id = b.lot_id
         WHERE l.facility_id = r.facility_id AND l.sku_id = r.sku_id) AS avg_dock_metres
  FROM r
  JOIN skus k ON k.sku_id = r.sku_id;

-- Every bin with what is in it (the 3D heat map and the slotting report)
CREATE OR REPLACE VIEW v_bin_contents AS
SELECT s.bin_id, s.facility_id, s.aisle, s.bay, s.rack_side, s.lvl, s.temp_zone, s.dock_metres, s.bin_status,
       b.sscc, b.units, l.lot_id, l.sku_id, l.expiry_date, l.qc_status, a.abc_class
  FROM storage_bins s
  LEFT JOIN bin_stock b ON b.bin_id = s.bin_id
  LEFT JOIN lots l ON l.lot_id = b.lot_id
  LEFT JOIN v_sku_abc a ON a.facility_id = l.facility_id AND a.sku_id = l.sku_id;

-- FEFO audit: picks that took a lot while a released lot of the same product with an EARLIER
-- expiry still had stock at that moment (balance re-computed from the ledger)
CREATE OR REPLACE VIEW v_fefo_violations AS
SELECT m.move_id, m.created_at AS picked_at, m.facility_id, m.sku_id, m.lot_id AS picked_lot, l.expiry_date AS picked_expiry,
       o.lot_id AS older_lot, o.expiry_date AS older_expiry, -m.units AS units, m.ref_kind, m.ref_id
  FROM lot_moves m
  JOIN lots l ON l.lot_id = m.lot_id
  JOIN lots o ON o.facility_id = m.facility_id AND o.sku_id = m.sku_id AND o.lot_id <> m.lot_id
             AND o.expiry_date < l.expiry_date AND o.qc_status = 'RELEASED'
 WHERE m.move_type IN ('PICK', 'SHIP_STORE')
   AND l.expiry_date IS NOT NULL
   AND (SELECT NVL(SUM(x.units), 0) FROM lot_moves x
         WHERE x.lot_id = o.lot_id AND x.move_id < m.move_id) > 0;

-- Genealogy (one row per link): ship → container → inbound shipment → lot → outbound shipment / store order → customer / store
CREATE OR REPLACE VIEW v_trace_links AS
SELECT CAST('VESSEL' AS VARCHAR2(10)) AS parent_kind, CAST(cm.vessel_id AS VARCHAR2(60)) AS parent_id,
       CAST('CONTAINER' AS VARCHAR2(10)) AS child_kind, CAST(cm.container_no AS VARCHAR2(60)) AS child_id, CAST(NULL AS NUMBER) AS units
  FROM container_moves cm
 WHERE cm.move_type = 'DISCHARGE' AND cm.vessel_id IS NOT NULL
UNION ALL
SELECT 'CONTAINER', s.container_no, 'SHIPMENT', s.shipment_id, NULL
  FROM shipments s
 WHERE s.direction = 'INBOUND' AND s.container_no IS NOT NULL
UNION ALL
SELECT 'SHIPMENT', l.shipment_id, 'LOT', l.lot_id, l.units_received
  FROM lots l
 WHERE l.shipment_id IS NOT NULL
UNION ALL
SELECT 'LOT', m.lot_id, m.ref_kind, m.ref_id, -SUM(m.units)
  FROM lot_moves m
 WHERE m.move_type IN ('PICK', 'SHIP_STORE') AND m.ref_id IS NOT NULL
 GROUP BY m.lot_id, m.ref_kind, m.ref_id
UNION ALL
SELECT 'ORDER', o.order_id, 'STORE', o.store_id, o.units
  FROM store_orders o
UNION ALL
SELECT 'SHIPMENT', s.shipment_id, 'CUSTOMER', s.customer, s.pallets
  FROM shipments s
 WHERE s.direction = 'OUTBOUND';

-- Demand forecast for the next 14 days: MODEL clause with a linear trend (REGR_SLOPE /
-- REGR_INTERCEPT over 56 days) times the weekday's seasonal index
CREATE OR REPLACE VIEW v_demand_forecast AS
WITH hist AS (
  SELECT facility_id, sku_id, demand_date, units_out,
         TRUNC(SYSDATE) - demand_date AS days_ago
    FROM sku_daily_demand
   WHERE demand_date BETWEEN TRUNC(SYSDATE) - 56 AND TRUNC(SYSDATE) - 1
), fit AS (
  SELECT facility_id, sku_id,
         REGR_SLOPE(units_out, -days_ago) AS slope,
         REGR_INTERCEPT(units_out, -days_ago) AS intercept,
         AVG(units_out) AS mean_units
    FROM hist
   GROUP BY facility_id, sku_id
), season AS (
  SELECT h.facility_id, h.sku_id, TO_CHAR(h.demand_date, 'D') AS dow,
         AVG(h.units_out) / NULLIF(MAX(f.mean_units), 0) AS idx
    FROM hist h
    JOIN fit f ON f.facility_id = h.facility_id AND f.sku_id = h.sku_id
   GROUP BY h.facility_id, h.sku_id, TO_CHAR(h.demand_date, 'D')
), base AS (
  SELECT f.facility_id, f.sku_id, f.slope, f.intercept, d.day_no
    FROM fit f
   CROSS JOIN (SELECT LEVEL - 1 AS day_no FROM dual CONNECT BY LEVEL <= 14) d
)
SELECT m.facility_id, m.sku_id, TRUNC(SYSDATE) + m.day_no AS forecast_date, m.day_no,
       GREATEST(0, ROUND(m.trend * NVL(s.idx, 1))) AS forecast_units,
       ROUND(m.trend) AS trend_units, ROUND(NVL(s.idx, 1), 3) AS weekday_index
  FROM (SELECT facility_id, sku_id, day_no, trend
          FROM base
         MODEL PARTITION BY (facility_id, sku_id)
               DIMENSION BY (day_no)
               MEASURES (slope, intercept, 0 AS trend)
               RULES (trend[ANY] = intercept[CV()] + slope[CV()] * CV(day_no))) m
  LEFT JOIN season s ON s.facility_id = m.facility_id AND s.sku_id = m.sku_id
                    AND s.dow = TO_CHAR(TRUNC(SYSDATE) + m.day_no, 'D');

-- Replenishment: reorder point = demand during lead time + safety stock (95 % service, z = 1.65),
-- economic order quantity = SQRT(2 · annual demand · order cost / holding cost)
CREATE OR REPLACE VIEW v_replenishment AS
WITH stats AS (
  SELECT facility_id, sku_id, AVG(units_out) AS daily_avg, STDDEV(units_out) AS daily_sd
    FROM sku_daily_demand
   WHERE demand_date > TRUNC(SYSDATE) - 28
   GROUP BY facility_id, sku_id
)
SELECT i.facility_id, i.sku_id, k.name AS sku_name, i.units AS on_hand,
       NVL((SELECT SUM(l.units_on_hand) FROM lots l WHERE l.facility_id = i.facility_id AND l.sku_id = i.sku_id AND l.qc_status = 'RELEASED'), 0) AS available,
       ROUND(s.daily_avg, 1) AS daily_demand, ROUND(s.daily_sd, 1) AS daily_sd, h.lead_time_days,
       ROUND(1.65 * NVL(s.daily_sd, 0) * SQRT(h.lead_time_days)) AS safety_stock,
       ROUND(s.daily_avg * h.lead_time_days + 1.65 * NVL(s.daily_sd, 0) * SQRT(h.lead_time_days)) AS reorder_point,
       ROUND(SQRT(2 * s.daily_avg * 365 * h.order_cost / (0.25 * h.unit_cost))) AS eoq,
       ROUND(i.units / NULLIF(s.daily_avg, 0), 1) AS days_of_cover,
       CASE WHEN i.units <= s.daily_avg * h.lead_time_days + 1.65 * NVL(s.daily_sd, 0) * SQRT(h.lead_time_days)
            THEN 'REORDER' ELSE 'OK' END AS action
  FROM inventory i
  JOIN skus k ON k.sku_id = i.sku_id
  JOIN sku_handling h ON h.sku_id = i.sku_id
  LEFT JOIN stats s ON s.facility_id = i.facility_id AND s.sku_id = i.sku_id;

-- Cycle count: the book (inventory) against the lots in the racks and on the yard
CREATE OR REPLACE VIEW v_stock_reconciliation AS
SELECT i.facility_id, i.sku_id, i.units AS book_units,
       NVL((SELECT SUM(l.units_on_hand) FROM lots l WHERE l.facility_id = i.facility_id AND l.sku_id = i.sku_id), 0) AS lot_units,
       i.units - NVL((SELECT SUM(l.units_on_hand) FROM lots l WHERE l.facility_id = i.facility_id AND l.sku_id = i.sku_id), 0) AS difference
  FROM inventory i;

-- Latest reading per sensor
CREATE OR REPLACE VIEW v_cold_status AS
SELECT s.sensor_id, s.facility_id, s.temp_zone, s.sensor_label, s.min_c, s.max_c, s.door_open, r.temp_c, r.read_at,
       CASE WHEN r.temp_c IS NULL THEN 'NO DATA'
            WHEN r.temp_c > s.max_c OR r.temp_c < s.min_c THEN 'OUT'
            WHEN r.temp_c > s.max_c - 1 OR r.temp_c < s.min_c + 0.5 THEN 'WARN'
            ELSE 'OK' END AS status
  FROM sensors s
  LEFT JOIN (SELECT sensor_id, temp_c, read_at,
                    ROW_NUMBER() OVER (PARTITION BY sensor_id ORDER BY read_at DESC) AS rn
               FROM sensor_readings
              WHERE read_at > SYSTIMESTAMP - INTERVAL '10' MINUTE) r
    ON r.sensor_id = s.sensor_id AND r.rn = 1;
