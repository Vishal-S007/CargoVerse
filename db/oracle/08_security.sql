--------------------------------------------------------------------------------
-- CargoVerse — row-level security, part 2 (run as the schema owner)
--
-- Oracle Virtual Private Database (VPD): a policy function adds a WHERE clause to
-- every query on the site-specific tables. When an operator signs in to SQL
-- Developer with their own database account, Oracle itself hides the rows of the
-- sites they are not allowed to see — no application code is involved, and the
-- filter cannot be bypassed with a cleverer query.
--
-- The CargoVerse server connects as the schema owner and is not filtered (it
-- checks site access itself and runs the shared operation for every site).
-- Needs EXECUTE on DBMS_RLS and the demo accounts from 07_security_sys.sql; the
-- setup script skips this part with a message if they are missing.
--------------------------------------------------------------------------------
SET DEFINE OFF

BEGIN
  FOR t IN (SELECT table_name FROM user_tables WHERE table_name = 'DB_ACCOUNTS') LOOP
    EXECUTE IMMEDIATE 'DROP TABLE ' || t.table_name || ' CASCADE CONSTRAINTS PURGE';
  END LOOP;
END;
/

-- Which CargoVerse user each database account stands for
CREATE TABLE db_accounts (
  db_username     VARCHAR2(128)  CONSTRAINT pk_db_accounts PRIMARY KEY,
  user_id         NUMBER         NOT NULL CONSTRAINT fk_dba_user REFERENCES app_users (user_id) ON DELETE CASCADE,
  note            VARCHAR2(200),
  CONSTRAINT ck_dba_upper CHECK (db_username = UPPER(db_username))
);
COMMENT ON TABLE db_accounts IS 'Database accounts (for SQL Developer) mapped to CargoVerse users; the row-level security policy follows that user''s site access';

INSERT INTO db_accounts (db_username, user_id, note)
SELECT 'CV_ADMIN', user_id, 'Administrator: every site' FROM app_users WHERE username = 'admin';
INSERT INTO db_accounts (db_username, user_id, note)
SELECT 'CV_ALEX', user_id, 'Operations manager: Riverside Hub and Southfield Cross-Dock' FROM app_users WHERE username = 'alex.chen';
INSERT INTO db_accounts (db_username, user_id, note)
SELECT 'CV_MEERA', user_id, 'Operations manager: Northgate DC' FROM app_users WHERE username = 'meera.iyer';
INSERT INTO db_accounts (db_username, user_id, note)
SELECT 'CV_ZOE', user_id, 'Forklift operator: Southfield Cross-Dock' FROM app_users WHERE username = 'zoe.reyes';
COMMIT;

-- ============================================================================
-- Package WT_SECURITY: the VPD policy function
-- ============================================================================
CREATE OR REPLACE PACKAGE wt_security AS
  -- Policy function (signature required by DBMS_RLS): returns the WHERE clause
  -- Oracle appends to every statement on a protected table.
  FUNCTION site_filter (p_schema IN VARCHAR2, p_object IN VARCHAR2) RETURN VARCHAR2;
  -- The clause a given database account gets (shown in the Database Lab).
  FUNCTION predicate_for (p_db_user IN VARCHAR2) RETURN VARCHAR2;
END wt_security;
/

CREATE OR REPLACE PACKAGE BODY wt_security AS

  FUNCTION predicate_for (p_db_user IN VARCHAR2) RETURN VARCHAR2 IS
    v_user_id NUMBER;
    v_active  CHAR(1);
    v_list    VARCHAR2(400);
  BEGIN
    BEGIN
      SELECT a.user_id, u.is_active INTO v_user_id, v_active
        FROM db_accounts a
        JOIN app_users u ON u.user_id = a.user_id
       WHERE a.db_username = UPPER(p_db_user);
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        RETURN '1 = 0'; -- any other account sees no site data at all
    END;
    IF v_active <> 'Y' THEN
      RETURN '1 = 0';
    END IF;
    IF wt_core.has_permission(v_user_id, 'VIEW_ALL_FACILITIES') = 'Y' THEN
      RETURN NULL; -- no filter
    END IF;
    SELECT LISTAGG('''' || facility_id || '''', ', ') WITHIN GROUP (ORDER BY facility_id)
      INTO v_list
      FROM user_facility_access
     WHERE user_id = v_user_id;
    IF v_list IS NULL THEN
      RETURN '1 = 0';
    END IF;
    RETURN 'facility_id IN (' || v_list || ')';
  END predicate_for;

  FUNCTION site_filter (p_schema IN VARCHAR2, p_object IN VARCHAR2) RETURN VARCHAR2 IS
    v_session_user VARCHAR2(128) := SYS_CONTEXT('USERENV', 'SESSION_USER');
  BEGIN
    IF v_session_user = p_schema THEN
      RETURN NULL; -- the schema owner (the CargoVerse server) is not filtered
    END IF;
    RETURN predicate_for(v_session_user);
  END site_filter;

END wt_security;
/

-- ============================================================================
-- Read access for the demonstration accounts (password hashes and sessions excluded).
-- Each grant on its own: Oracle's internal tables (queue tables, AQ$ views) cannot be
-- granted, and one refusal must not leave the accounts with no access at all.
-- ============================================================================
BEGIN
  FOR u IN (SELECT username FROM all_users WHERE username IN ('CV_ADMIN', 'CV_ALEX', 'CV_MEERA', 'CV_ZOE')) LOOP
    FOR o IN (SELECT object_name FROM user_objects
               WHERE object_type IN ('TABLE', 'VIEW')
                 AND object_name NOT IN ('APP_USERS', 'USER_SESSIONS', 'DB_ACCOUNTS')
                 AND object_name NOT LIKE 'BIN$%'
                 AND object_name NOT LIKE 'AQ$%'
                 AND object_name NOT LIKE 'SYS\_%' ESCAPE '\'
                 AND object_name NOT LIKE 'DR$%') LOOP
      BEGIN
        EXECUTE IMMEDIATE 'GRANT SELECT ON "' || o.object_name || '" TO ' || u.username;
      EXCEPTION
        WHEN OTHERS THEN NULL;  -- not grantable (an internal object): skip it
      END;
    END LOOP;
  END LOOP;
END;
/

-- ============================================================================
-- The policies: one per site-specific table
-- ============================================================================
BEGIN
  FOR p IN (SELECT object_name, policy_name FROM user_policies WHERE policy_name = 'CV_SITE_ROWS') LOOP
    DBMS_RLS.DROP_POLICY(object_schema => USER, object_name => p.object_name, policy_name => p.policy_name);
  END LOOP;
  FOR t IN (SELECT table_name FROM user_tab_columns
             WHERE column_name = 'FACILITY_ID'
               AND table_name IN ('FACILITIES', 'DOCKS', 'CHARGERS', 'INVENTORY', 'PALLETS', 'TRUCKS', 'SHIPMENTS',
                                  'FORKLIFTS', 'STOCK_MOVEMENTS', 'TASKS', 'OPERATION_EVENTS', 'PARK_GATE_LOG',
                                  'EMPLOYEES', 'STORE_ORDERS', 'DELIVERY_VANS',
                                  -- Smart Warehouse (10_wms.sql)
                                  'LOTS', 'STORAGE_BINS', 'LOT_MOVES', 'SENSORS', 'COLD_BREACHES', 'DAMAGE_REPORTS',
                                  'SKU_DAILY_DEMAND', 'SCAN_LOG', 'WH_NODES', 'WH_EDGES', 'WMS_EVENTS', 'WMS_SETTINGS')) LOOP
    DBMS_RLS.ADD_POLICY(
      object_schema   => USER,
      object_name     => t.table_name,
      policy_name     => 'CV_SITE_ROWS',
      function_schema => USER,
      policy_function => 'WT_SECURITY.SITE_FILTER',
      statement_types => 'SELECT, INSERT, UPDATE, DELETE',
      update_check    => TRUE,
      policy_type     => DBMS_RLS.CONTEXT_SENSITIVE);
  END LOOP;
END;
/
