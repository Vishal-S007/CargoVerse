--------------------------------------------------------------------------------
-- CargoVerse — PL/SQL packages and triggers
-- The application identifies the signed-in user to Oracle by setting the
-- session CLIENT_IDENTIFIER (DBMS_SESSION.SET_IDENTIFIER('<user_id>') at the start of each transaction),
-- so audit triggers record who made each change.
--------------------------------------------------------------------------------
SET DEFINE OFF

-- ============================================================================
-- Package WT_CORE: identity, permissions, audit helper, formatting
-- ============================================================================
CREATE OR REPLACE PACKAGE wt_core AS
  FUNCTION current_user_id RETURN NUMBER;
  FUNCTION has_permission (p_user_id IN NUMBER, p_perm IN VARCHAR2) RETURN CHAR;
  FUNCTION can_access_facility (p_user_id IN NUMBER, p_facility IN VARCHAR2) RETURN CHAR;
  FUNCTION otd_pct (p_facility IN VARCHAR2) RETURN NUMBER;
  FUNCTION fmt_clock (p_seconds IN NUMBER) RETURN VARCHAR2;
  PROCEDURE log_audit (
    p_action    IN VARCHAR2,
    p_entity    IN VARCHAR2,
    p_entity_id IN VARCHAR2,
    p_facility  IN VARCHAR2,
    p_details   IN VARCHAR2,
    p_user_id   IN NUMBER DEFAULT NULL);
END wt_core;
/

CREATE OR REPLACE PACKAGE BODY wt_core AS

  FUNCTION current_user_id RETURN NUMBER IS
    v_raw VARCHAR2(64) := SYS_CONTEXT('USERENV', 'CLIENT_IDENTIFIER');
  BEGIN
    IF v_raw IS NULL THEN
      RETURN NULL;
    END IF;
    RETURN TO_NUMBER(v_raw);
  EXCEPTION
    WHEN VALUE_ERROR OR INVALID_NUMBER THEN
      RETURN NULL;
  END current_user_id;

  FUNCTION has_permission (p_user_id IN NUMBER, p_perm IN VARCHAR2) RETURN CHAR IS
    v_count NUMBER;
  BEGIN
    SELECT COUNT(*)
      INTO v_count
      FROM app_users u
      JOIN role_permissions rp ON rp.role_code = u.role_code
     WHERE u.user_id = p_user_id
       AND u.is_active = 'Y'
       AND rp.perm_code = p_perm;
    RETURN CASE WHEN v_count > 0 THEN 'Y' ELSE 'N' END;
  END has_permission;

  FUNCTION can_access_facility (p_user_id IN NUMBER, p_facility IN VARCHAR2) RETURN CHAR IS
    v_count NUMBER;
  BEGIN
    IF has_permission(p_user_id, 'VIEW_ALL_FACILITIES') = 'Y' THEN
      RETURN 'Y';
    END IF;
    SELECT COUNT(*)
      INTO v_count
      FROM user_facility_access a
      JOIN app_users u ON u.user_id = a.user_id
     WHERE a.user_id = p_user_id
       AND a.facility_id = p_facility
       AND u.is_active = 'Y';
    RETURN CASE WHEN v_count > 0 THEN 'Y' ELSE 'N' END;
  END can_access_facility;

  FUNCTION otd_pct (p_facility IN VARCHAR2) RETURN NUMBER IS
    v_total   NUMBER;
    v_on_time NUMBER;
  BEGIN
    SELECT COUNT(*), NVL(SUM(CASE WHEN on_time = 'Y' THEN 1 ELSE 0 END), 0)
      INTO v_total, v_on_time
      FROM shipments
     WHERE facility_id = p_facility
       AND ship_status = 'DELIVERED'
       AND delivered_ts >= SYSTIMESTAMP - INTERVAL '30' DAY;
    IF v_total = 0 THEN
      RETURN 0;
    END IF;
    RETURN ROUND(100 * v_on_time / v_total, 2);
  END otd_pct;

  FUNCTION fmt_clock (p_seconds IN NUMBER) RETURN VARCHAR2 IS
    v_s NUMBER := MOD(FLOOR(NVL(p_seconds, 0)), 86400);
  BEGIN
    RETURN LPAD(FLOOR(v_s / 3600), 2, '0') || ':' || LPAD(FLOOR(MOD(v_s, 3600) / 60), 2, '0');
  END fmt_clock;

  PROCEDURE log_audit (
    p_action    IN VARCHAR2,
    p_entity    IN VARCHAR2,
    p_entity_id IN VARCHAR2,
    p_facility  IN VARCHAR2,
    p_details   IN VARCHAR2,
    p_user_id   IN NUMBER DEFAULT NULL)
  IS
  BEGIN
    INSERT INTO audit_log (user_id, action, entity, entity_id, facility_id, details, client_info)
    VALUES (NVL(p_user_id, current_user_id), p_action, p_entity, p_entity_id, p_facility,
            SUBSTR(p_details, 1, 2000), SYS_CONTEXT('USERENV', 'MODULE'));
  END log_audit;

END wt_core;
/

-- ============================================================================
-- Package WT_AUTH: logins, sessions and user administration
-- Passwords are hashed by the application (scrypt); only hashes are stored.
-- ============================================================================
CREATE OR REPLACE PACKAGE wt_auth AS
  PROCEDURE record_login (p_user_id IN NUMBER, p_success IN CHAR, p_username IN VARCHAR2);
  PROCEDURE create_session (p_session_id IN VARCHAR2, p_user_id IN NUMBER, p_days IN NUMBER, p_agent IN VARCHAR2);
  PROCEDURE revoke_session (p_session_id IN VARCHAR2);
  PROCEDURE create_user (
    p_admin_id    IN NUMBER,
    p_username    IN VARCHAR2,
    p_hash        IN VARCHAR2,
    p_role        IN VARCHAR2,
    p_full_name   IN VARCHAR2,
    p_email       IN VARCHAR2,
    p_phone       IN VARCHAR2,
    p_job_code    IN VARCHAR2,
    p_home_fac    IN VARCHAR2,
    p_facilities  IN VARCHAR2,   -- comma-separated facility ids
    o_user_id     OUT NUMBER);
  PROCEDURE update_user (
    p_admin_id    IN NUMBER,
    p_user_id     IN NUMBER,
    p_role        IN VARCHAR2,   -- NULL = unchanged
    p_active      IN CHAR,       -- NULL = unchanged
    p_facilities  IN VARCHAR2,   -- NULL = unchanged, '' handled as none
    p_hash        IN VARCHAR2);  -- NULL = unchanged
END wt_auth;
/

CREATE OR REPLACE PACKAGE BODY wt_auth AS

  PROCEDURE require_admin (p_admin_id IN NUMBER) IS
  BEGIN
    IF p_admin_id IS NULL OR wt_core.has_permission(p_admin_id, 'MANAGE_USERS') = 'N' THEN
      RAISE_APPLICATION_ERROR(-20003, 'Not permitted: managing users requires the MANAGE_USERS permission');
    END IF;
  END require_admin;

  -- p_facilities: comma-separated ids; '-' (or any non-matching value) removes all access.
  PROCEDURE set_facilities (p_user_id IN NUMBER, p_facilities IN VARCHAR2) IS
    v_list VARCHAR2(400) := ',' || REPLACE(NVL(p_facilities, '-'), ' ', '') || ',';
  BEGIN
    DELETE FROM user_facility_access
     WHERE user_id = p_user_id
       AND INSTR(v_list, ',' || facility_id || ',') = 0;
    INSERT INTO user_facility_access (user_id, facility_id)
    SELECT p_user_id, f.facility_id
      FROM facilities f
     WHERE INSTR(v_list, ',' || f.facility_id || ',') > 0
       AND NOT EXISTS (SELECT 1 FROM user_facility_access a
                        WHERE a.user_id = p_user_id AND a.facility_id = f.facility_id);
  END set_facilities;

  PROCEDURE record_login (p_user_id IN NUMBER, p_success IN CHAR, p_username IN VARCHAR2) IS
  BEGIN
    IF p_success = 'Y' THEN
      UPDATE app_users
         SET last_login_at = SYSTIMESTAMP, failed_logins = 0
       WHERE user_id = p_user_id;
      wt_core.log_audit('LOGIN', 'SESSION', p_username, NULL, 'Signed in', p_user_id);
    ELSE
      IF p_user_id IS NOT NULL THEN
        UPDATE app_users SET failed_logins = failed_logins + 1 WHERE user_id = p_user_id;
      END IF;
      wt_core.log_audit('LOGIN_FAILED', 'SESSION', p_username, NULL, 'Wrong username or password', p_user_id);
    END IF;
  END record_login;

  PROCEDURE create_session (p_session_id IN VARCHAR2, p_user_id IN NUMBER, p_days IN NUMBER, p_agent IN VARCHAR2) IS
  BEGIN
    INSERT INTO user_sessions (session_id, user_id, expires_at, remember_me, user_agent)
    VALUES (p_session_id, p_user_id, SYSTIMESTAMP + NUMTODSINTERVAL(p_days, 'DAY'),
            CASE WHEN p_days >= 1 THEN 'Y' ELSE 'N' END, SUBSTR(p_agent, 1, 200));
  END create_session;

  PROCEDURE revoke_session (p_session_id IN VARCHAR2) IS
    v_user NUMBER;
  BEGIN
    UPDATE user_sessions SET revoked = 'Y'
     WHERE session_id = p_session_id
     RETURNING user_id INTO v_user;
    IF v_user IS NOT NULL THEN
      wt_core.log_audit('LOGOUT', 'SESSION', NULL, NULL, 'Signed out', v_user);
    END IF;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN NULL;
  END revoke_session;

  PROCEDURE create_user (
    p_admin_id    IN NUMBER,
    p_username    IN VARCHAR2,
    p_hash        IN VARCHAR2,
    p_role        IN VARCHAR2,
    p_full_name   IN VARCHAR2,
    p_email       IN VARCHAR2,
    p_phone       IN VARCHAR2,
    p_job_code    IN VARCHAR2,
    p_home_fac    IN VARCHAR2,
    p_facilities  IN VARCHAR2,
    o_user_id     OUT NUMBER)
  IS
    v_emp_id NUMBER;
  BEGIN
    require_admin(p_admin_id);
    INSERT INTO employees (full_name, email, phone, job_code, facility_id)
    VALUES (p_full_name, LOWER(p_email), p_phone, p_job_code, p_home_fac)
    RETURNING employee_id INTO v_emp_id;

    INSERT INTO app_users (username, password_hash, role_code, employee_id, created_by)
    VALUES (LOWER(p_username), p_hash, p_role, v_emp_id, p_admin_id)
    RETURNING user_id INTO o_user_id;

    set_facilities(o_user_id, NVL(p_facilities, p_home_fac));
  END create_user;

  PROCEDURE update_user (
    p_admin_id    IN NUMBER,
    p_user_id     IN NUMBER,
    p_role        IN VARCHAR2,
    p_active      IN CHAR,
    p_facilities  IN VARCHAR2,
    p_hash        IN VARCHAR2)
  IS
  BEGIN
    require_admin(p_admin_id);
    IF p_user_id = p_admin_id AND (p_active = 'N' OR (p_role IS NOT NULL AND p_role <> 'ADMIN')) THEN
      RAISE_APPLICATION_ERROR(-20006, 'Administrators cannot deactivate or demote their own account');
    END IF;
    UPDATE app_users
       SET role_code     = NVL(p_role, role_code),
           is_active     = NVL(p_active, is_active),
           password_hash = NVL(p_hash, password_hash),
           failed_logins = CASE WHEN p_hash IS NOT NULL THEN 0 ELSE failed_logins END
     WHERE user_id = p_user_id;
    IF SQL%ROWCOUNT = 0 THEN
      RAISE_APPLICATION_ERROR(-20001, 'User ' || p_user_id || ' not found');
    END IF;
    IF p_facilities IS NOT NULL THEN
      set_facilities(p_user_id, p_facilities);
    END IF;
    IF p_active = 'N' THEN
      UPDATE user_sessions SET revoked = 'Y' WHERE user_id = p_user_id AND revoked = 'N';
    END IF;
  END update_user;

END wt_auth;
/

-- ============================================================================
-- Package WT_WORK: tasks assigned to staff, with role-based rules
-- Errors: -20001 not found, -20002 transition not allowed, -20003 not permitted,
--         -20004 invalid assignee, -20005 facility access denied
-- ============================================================================
CREATE OR REPLACE PACKAGE wt_work AS
  PROCEDURE create_task (
    p_user_id     IN NUMBER,     -- NULL = created by the system
    p_facility    IN VARCHAR2,
    p_title       IN VARCHAR2,
    p_description IN VARCHAR2,
    p_type        IN VARCHAR2,
    p_priority    IN VARCHAR2,
    p_assignee    IN NUMBER,
    p_truck       IN VARCHAR2,
    p_dock        IN VARCHAR2,
    p_forklift    IN VARCHAR2,
    p_shipment    IN VARCHAR2,
    p_due_minutes IN NUMBER,
    p_source      IN VARCHAR2,
    o_task_id     OUT NUMBER);
  PROCEDURE change_status (p_user_id IN NUMBER, p_task_id IN NUMBER, p_new_status IN VARCHAR2, p_note IN VARCHAR2);
  PROCEDURE assign (p_user_id IN NUMBER, p_task_id IN NUMBER, p_assignee IN NUMBER, p_note IN VARCHAR2);
  FUNCTION transition_allowed (p_old IN VARCHAR2, p_new IN VARCHAR2, p_operator IN CHAR) RETURN CHAR;
END wt_work;
/

CREATE OR REPLACE PACKAGE BODY wt_work AS

  FUNCTION transition_allowed (p_old IN VARCHAR2, p_new IN VARCHAR2, p_operator IN CHAR) RETURN CHAR IS
  BEGIN
    IF p_operator = 'Y' THEN
      RETURN CASE
        WHEN p_old = 'ASSIGNED'    AND p_new = 'IN_PROGRESS'            THEN 'Y'
        WHEN p_old = 'IN_PROGRESS' AND p_new IN ('BLOCKED', 'DONE')     THEN 'Y'
        WHEN p_old = 'BLOCKED'     AND p_new = 'IN_PROGRESS'            THEN 'Y'
        ELSE 'N' END;
    END IF;
    RETURN CASE
      WHEN p_old = 'OPEN'        AND p_new IN ('ASSIGNED', 'CANCELLED')               THEN 'Y'
      WHEN p_old = 'ASSIGNED'    AND p_new IN ('IN_PROGRESS', 'CANCELLED')            THEN 'Y'
      WHEN p_old = 'IN_PROGRESS' AND p_new IN ('BLOCKED', 'DONE', 'CANCELLED')        THEN 'Y'
      WHEN p_old = 'BLOCKED'     AND p_new IN ('IN_PROGRESS', 'CANCELLED')            THEN 'Y'
      ELSE 'N' END;
  END transition_allowed;

  PROCEDURE check_assignee (p_assignee IN NUMBER, p_facility IN VARCHAR2) IS
    v_count NUMBER;
  BEGIN
    IF p_assignee IS NULL THEN
      RETURN;
    END IF;
    SELECT COUNT(*) INTO v_count
      FROM employees
     WHERE employee_id = p_assignee
       AND emp_status = 'ACTIVE'
       AND (facility_id = p_facility OR facility_id IS NULL);
    IF v_count = 0 THEN
      RAISE_APPLICATION_ERROR(-20004, 'Employee ' || p_assignee || ' is not active at ' || p_facility);
    END IF;
  END check_assignee;

  PROCEDURE create_task (
    p_user_id     IN NUMBER,
    p_facility    IN VARCHAR2,
    p_title       IN VARCHAR2,
    p_description IN VARCHAR2,
    p_type        IN VARCHAR2,
    p_priority    IN VARCHAR2,
    p_assignee    IN NUMBER,
    p_truck       IN VARCHAR2,
    p_dock        IN VARCHAR2,
    p_forklift    IN VARCHAR2,
    p_shipment    IN VARCHAR2,
    p_due_minutes IN NUMBER,
    p_source      IN VARCHAR2,
    o_task_id     OUT NUMBER)
  IS
  BEGIN
    IF p_user_id IS NOT NULL THEN
      IF wt_core.has_permission(p_user_id, 'MANAGE_TASKS') = 'N' THEN
        RAISE_APPLICATION_ERROR(-20003, 'Not permitted: creating tasks requires MANAGE_TASKS');
      END IF;
      IF wt_core.can_access_facility(p_user_id, p_facility) = 'N' THEN
        RAISE_APPLICATION_ERROR(-20005, 'No access to facility ' || p_facility);
      END IF;
    END IF;
    check_assignee(p_assignee, p_facility);

    INSERT INTO tasks (facility_id, title, description, task_type, priority, task_status, source,
                       assigned_to, created_by, truck_id, dock_id, forklift_id, shipment_id, due_at)
    VALUES (p_facility, p_title, p_description, p_type, NVL(p_priority, 'NORMAL'),
            CASE WHEN p_assignee IS NULL THEN 'OPEN'
                 WHEN p_source = 'SYSTEM' THEN 'IN_PROGRESS'
                 ELSE 'ASSIGNED' END,
            NVL(p_source, 'MANUAL'), p_assignee, p_user_id, p_truck, p_dock, p_forklift, p_shipment,
            CASE WHEN p_due_minutes IS NULL THEN NULL
                 ELSE SYSTIMESTAMP + NUMTODSINTERVAL(p_due_minutes, 'MINUTE') END)
    RETURNING task_id INTO o_task_id;

    INSERT INTO task_updates (task_id, user_id, old_status, new_status, note)
    SELECT o_task_id, p_user_id, NULL, task_status,
           CASE WHEN p_source = 'SYSTEM' THEN 'Created automatically by operations' ELSE 'Task created' END
      FROM tasks WHERE task_id = o_task_id;
  END create_task;

  PROCEDURE change_status (p_user_id IN NUMBER, p_task_id IN NUMBER, p_new_status IN VARCHAR2, p_note IN VARCHAR2) IS
    v_task     tasks%ROWTYPE;
    v_emp_id   NUMBER;
    v_operator CHAR(1) := 'N';
  BEGIN
    BEGIN
      SELECT * INTO v_task FROM tasks WHERE task_id = p_task_id FOR UPDATE;
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        RAISE_APPLICATION_ERROR(-20001, 'Task ' || p_task_id || ' not found');
    END;

    IF p_user_id IS NOT NULL THEN
      IF wt_core.can_access_facility(p_user_id, v_task.facility_id) = 'N' THEN
        RAISE_APPLICATION_ERROR(-20005, 'No access to facility ' || v_task.facility_id);
      END IF;
      IF wt_core.has_permission(p_user_id, 'MANAGE_TASKS') = 'N' THEN
        SELECT employee_id INTO v_emp_id FROM app_users WHERE user_id = p_user_id;
        IF wt_core.has_permission(p_user_id, 'UPDATE_OWN_TASKS') = 'N'
           OR v_task.assigned_to IS NULL OR v_task.assigned_to <> v_emp_id THEN
          RAISE_APPLICATION_ERROR(-20003, 'Not permitted: you can only update tasks assigned to you');
        END IF;
        v_operator := 'Y';
      END IF;
    END IF;

    IF transition_allowed(v_task.task_status, p_new_status, v_operator) = 'N' THEN
      RAISE_APPLICATION_ERROR(-20002, 'Cannot move task from ' || v_task.task_status || ' to ' || p_new_status);
    END IF;

    UPDATE tasks SET task_status = p_new_status WHERE task_id = p_task_id;
    INSERT INTO task_updates (task_id, user_id, old_status, new_status, note)
    VALUES (p_task_id, p_user_id, v_task.task_status, p_new_status, p_note);
  END change_status;

  PROCEDURE assign (p_user_id IN NUMBER, p_task_id IN NUMBER, p_assignee IN NUMBER, p_note IN VARCHAR2) IS
    v_task tasks%ROWTYPE;
  BEGIN
    BEGIN
      SELECT * INTO v_task FROM tasks WHERE task_id = p_task_id FOR UPDATE;
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        RAISE_APPLICATION_ERROR(-20001, 'Task ' || p_task_id || ' not found');
    END;
    IF p_user_id IS NOT NULL AND (wt_core.has_permission(p_user_id, 'MANAGE_TASKS') = 'N'
        OR wt_core.can_access_facility(p_user_id, v_task.facility_id) = 'N') THEN
      RAISE_APPLICATION_ERROR(-20003, 'Not permitted: assigning tasks requires MANAGE_TASKS for ' || v_task.facility_id);
    END IF;
    IF v_task.task_status IN ('DONE', 'CANCELLED') THEN
      RAISE_APPLICATION_ERROR(-20002, 'Task ' || p_task_id || ' is already ' || v_task.task_status);
    END IF;
    check_assignee(p_assignee, v_task.facility_id);

    UPDATE tasks
       SET assigned_to = p_assignee,
           task_status = CASE WHEN task_status = 'OPEN' THEN 'ASSIGNED' ELSE task_status END
     WHERE task_id = p_task_id;
    INSERT INTO task_updates (task_id, user_id, old_status, new_status, note)
    SELECT p_task_id, p_user_id, v_task.task_status, task_status,
           NVL(p_note, 'Assigned to ' || (SELECT full_name FROM employees WHERE employee_id = p_assignee))
      FROM tasks WHERE task_id = p_task_id;
  END assign;

END wt_work;
/

-- ============================================================================
-- Triggers
-- ============================================================================

-- Stock ledger keeps facility totals and per-SKU inventory in step.
CREATE OR REPLACE TRIGGER trg_stock_movements_ai
AFTER INSERT ON stock_movements
FOR EACH ROW
BEGIN
  UPDATE facilities
     SET stock_pallets = stock_pallets + :NEW.pallets_delta
   WHERE facility_id = :NEW.facility_id;

  IF :NEW.sku_id IS NOT NULL AND :NEW.units_delta <> 0 THEN
    UPDATE inventory
       SET units = units + :NEW.units_delta
     WHERE facility_id = :NEW.facility_id
       AND sku_id = :NEW.sku_id;
    IF SQL%ROWCOUNT = 0 AND :NEW.units_delta > 0 THEN
      INSERT INTO inventory (facility_id, sku_id, units, reorder_level)
      VALUES (:NEW.facility_id, :NEW.sku_id, :NEW.units_delta, 0);
    END IF;
  END IF;
END;
/

-- Shipment status and on-time flag are derived from the milestone times.
CREATE OR REPLACE TRIGGER trg_shipments_biu
BEFORE INSERT OR UPDATE ON shipments
FOR EACH ROW
BEGIN
  IF :NEW.delivered_s IS NOT NULL THEN
    :NEW.ship_status := 'DELIVERED';
    IF :NEW.on_time IS NULL THEN
      :NEW.on_time := CASE WHEN :NEW.delivered_s <= :NEW.promised_s THEN 'Y' ELSE 'N' END;
    END IF;
    IF :NEW.delivered_ts IS NULL THEN
      :NEW.delivered_ts := SYSTIMESTAMP;
    END IF;
  ELSIF :NEW.direction = 'INBOUND' THEN
    :NEW.ship_status := 'IN_TRANSIT';
  ELSIF :NEW.transit_s IS NOT NULL THEN
    :NEW.ship_status := 'IN_TRANSIT';
  ELSIF :NEW.loaded_s IS NOT NULL THEN
    :NEW.ship_status := 'IN_PROGRESS';
  ELSE
    :NEW.ship_status := 'OPEN';
  END IF;
END;
/

-- Task timestamps follow the status.
CREATE OR REPLACE TRIGGER trg_tasks_biu
BEFORE INSERT OR UPDATE ON tasks
FOR EACH ROW
BEGIN
  IF :NEW.task_status = 'IN_PROGRESS' AND :NEW.started_at IS NULL THEN
    :NEW.started_at := SYSTIMESTAMP;
  END IF;
  IF :NEW.task_status IN ('DONE', 'CANCELLED') AND :NEW.completed_at IS NULL THEN
    :NEW.completed_at := SYSTIMESTAMP;
  END IF;
END;
/

-- Audit trail: every human change to a task.
CREATE OR REPLACE TRIGGER trg_tasks_audit
AFTER INSERT OR UPDATE OF task_status, assigned_to, priority, title ON tasks
FOR EACH ROW
DECLARE
  v_user NUMBER := wt_core.current_user_id;
  FUNCTION emp_name (p_id NUMBER) RETURN VARCHAR2 IS
    v_name employees.full_name%TYPE;
  BEGIN
    IF p_id IS NULL THEN RETURN 'nobody'; END IF;
    SELECT full_name INTO v_name FROM employees WHERE employee_id = p_id;
    RETURN v_name;
  EXCEPTION WHEN NO_DATA_FOUND THEN RETURN '#' || p_id;
  END;
BEGIN
  IF v_user IS NULL AND :NEW.source = 'SYSTEM' THEN
    RETURN; -- automatic operations tasks are recorded in operation_events instead
  END IF;
  IF INSERTING THEN
    wt_core.log_audit('TASK_CREATED', 'TASK', TO_CHAR(:NEW.task_id), :NEW.facility_id,
      :NEW.title || ' · ' || :NEW.priority || ' · assigned to ' || emp_name(:NEW.assigned_to), v_user);
  ELSE
    IF NVL(:OLD.task_status, '-') <> NVL(:NEW.task_status, '-') THEN
      wt_core.log_audit('TASK_STATUS', 'TASK', TO_CHAR(:NEW.task_id), :NEW.facility_id,
        :NEW.title || ': ' || :OLD.task_status || ' → ' || :NEW.task_status, v_user);
    END IF;
    IF NVL(:OLD.assigned_to, -1) <> NVL(:NEW.assigned_to, -1) THEN
      wt_core.log_audit('TASK_ASSIGNED', 'TASK', TO_CHAR(:NEW.task_id), :NEW.facility_id,
        :NEW.title || ': ' || emp_name(:OLD.assigned_to) || ' → ' || emp_name(:NEW.assigned_to), v_user);
    END IF;
    IF NVL(:OLD.priority, '-') <> NVL(:NEW.priority, '-') THEN
      wt_core.log_audit('TASK_PRIORITY', 'TASK', TO_CHAR(:NEW.task_id), :NEW.facility_id,
        :NEW.title || ': ' || :OLD.priority || ' → ' || :NEW.priority, v_user);
    END IF;
  END IF;
END;
/

-- Audit trail: account administration (password hashes are never written to the log).
CREATE OR REPLACE TRIGGER trg_app_users_audit
AFTER INSERT OR DELETE OR UPDATE OF role_code, is_active, password_hash, username ON app_users
FOR EACH ROW
DECLARE
  v_changes VARCHAR2(1000);
BEGIN
  IF INSERTING THEN
    wt_core.log_audit('USER_CREATED', 'USER', :NEW.username, NULL, 'Role ' || :NEW.role_code);
  ELSIF DELETING THEN
    wt_core.log_audit('USER_DELETED', 'USER', :OLD.username, NULL, 'Role ' || :OLD.role_code);
  ELSE
    IF :OLD.role_code <> :NEW.role_code THEN
      v_changes := v_changes || 'role ' || :OLD.role_code || ' → ' || :NEW.role_code || '; ';
    END IF;
    IF :OLD.is_active <> :NEW.is_active THEN
      v_changes := v_changes || CASE WHEN :NEW.is_active = 'Y' THEN 'activated' ELSE 'deactivated' END || '; ';
    END IF;
    IF :OLD.password_hash <> :NEW.password_hash THEN
      v_changes := v_changes || 'password reset; ';
    END IF;
    IF :OLD.username <> :NEW.username THEN
      v_changes := v_changes || 'renamed from ' || :OLD.username || '; ';
    END IF;
    IF v_changes IS NOT NULL THEN
      wt_core.log_audit('USER_UPDATED', 'USER', :NEW.username, NULL, RTRIM(v_changes, '; '));
    END IF;
  END IF;
END;
/

CREATE OR REPLACE TRIGGER trg_user_access_audit
AFTER INSERT OR DELETE ON user_facility_access
FOR EACH ROW
DECLARE
  v_username app_users.username%TYPE;
BEGIN
  BEGIN
    SELECT MAX(username) INTO v_username FROM app_users WHERE user_id = NVL(:NEW.user_id, :OLD.user_id);
  EXCEPTION
    WHEN OTHERS THEN v_username := TO_CHAR(NVL(:NEW.user_id, :OLD.user_id)); -- e.g. app_users mutating during a cascade delete
  END;
  IF INSERTING THEN
    wt_core.log_audit('ACCESS_GRANTED', 'USER', v_username, :NEW.facility_id, 'Facility access granted');
  ELSE
    wt_core.log_audit('ACCESS_REVOKED', 'USER', v_username, :OLD.facility_id, 'Facility access revoked');
  END IF;
END;
/

CREATE OR REPLACE TRIGGER trg_employees_audit
AFTER INSERT OR UPDATE OF job_code, facility_id, emp_status ON employees
FOR EACH ROW
BEGIN
  IF INSERTING THEN
    wt_core.log_audit('EMPLOYEE_ADDED', 'EMPLOYEE', TO_CHAR(:NEW.employee_id), :NEW.facility_id,
      :NEW.full_name || ' · ' || :NEW.job_code);
  ELSE
    wt_core.log_audit('EMPLOYEE_UPDATED', 'EMPLOYEE', TO_CHAR(:NEW.employee_id), :NEW.facility_id,
      :NEW.full_name || ': ' || :OLD.job_code || '/' || :OLD.emp_status || ' → ' || :NEW.job_code || '/' || :NEW.emp_status);
  END IF;
END;
/

CREATE OR REPLACE TRIGGER trg_sim_state_audit
AFTER UPDATE OF paused, speed ON sim_state
FOR EACH ROW
BEGIN
  IF :OLD.paused <> :NEW.paused THEN
    wt_core.log_audit(CASE WHEN :NEW.paused = 'Y' THEN 'OPS_PAUSED' ELSE 'OPS_RESUMED' END,
      'OPERATIONS', NULL, NULL, 'Operations clock ' || CASE WHEN :NEW.paused = 'Y' THEN 'paused' ELSE 'resumed' END,
      :NEW.updated_by);
  END IF;
  IF :OLD.speed <> :NEW.speed THEN
    wt_core.log_audit('OPS_SPEED', 'OPERATIONS', NULL, NULL, 'Speed ' || :OLD.speed || '× → ' || :NEW.speed || '×', :NEW.updated_by);
  END IF;
END;
/

-- ============================================================================
-- Package WT_PARK: tenant management (building status, staff, leases) and the
-- import / export summary used by the dashboards
-- ============================================================================
CREATE OR REPLACE PACKAGE wt_park AS
  PROCEDURE update_building (
    p_user_id     IN NUMBER,
    p_building_id IN VARCHAR2,
    p_status      IN VARCHAR2,
    p_staff       IN NUMBER,
    p_lease_end   IN DATE);
  FUNCTION trade_balance (p_facility IN VARCHAR2) RETURN NUMBER;
END wt_park;
/

CREATE OR REPLACE PACKAGE BODY wt_park AS

  PROCEDURE update_building (
    p_user_id     IN NUMBER,
    p_building_id IN VARCHAR2,
    p_status      IN VARCHAR2,
    p_staff       IN NUMBER,
    p_lease_end   IN DATE)
  IS
    v_b park_buildings%ROWTYPE;
  BEGIN
    IF wt_core.has_permission(p_user_id, 'MANAGE_PARK') <> 'Y' THEN
      RAISE_APPLICATION_ERROR(-20003, 'Not permitted: editing park buildings requires the MANAGE_PARK permission');
    END IF;
    BEGIN
      SELECT * INTO v_b FROM park_buildings WHERE building_id = p_building_id FOR UPDATE;
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        RAISE_APPLICATION_ERROR(-20001, 'Building ' || p_building_id || ' not found');
    END;
    IF v_b.facility_id IS NOT NULL AND p_status IN ('VACANT', 'CONSTRUCTION') THEN
      RAISE_APPLICATION_ERROR(-20004, 'A CargoVerse site that is running operations cannot be marked ' || p_status);
    END IF;
    IF p_lease_end IS NOT NULL AND p_lease_end <= v_b.lease_start THEN
      RAISE_APPLICATION_ERROR(-20004, 'The lease cannot end before it starts (' || TO_CHAR(v_b.lease_start, 'YYYY-MM-DD') || ')');
    END IF;
    UPDATE park_buildings
       SET bldg_status = NVL(p_status, bldg_status),
           staff_count = NVL(p_staff, staff_count),
           lease_end   = NVL(p_lease_end, lease_end),
           updated_at  = SYSTIMESTAMP
     WHERE building_id = p_building_id;
  END update_building;

  -- pallets imported minus pallets exported today (positive = stock building up)
  FUNCTION trade_balance (p_facility IN VARCHAR2) RETURN NUMBER IS
    v_in  NUMBER;
    v_out NUMBER;
  BEGIN
    SELECT import_pallets_today, export_pallets_today INTO v_in, v_out
      FROM facilities WHERE facility_id = p_facility;
    RETURN v_in - v_out;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RETURN NULL;
  END trade_balance;

END wt_park;
/

-- Every truck through a park gate updates the facility's import / export counters.
CREATE OR REPLACE TRIGGER trg_gate_log_ai
AFTER INSERT ON park_gate_log
FOR EACH ROW
BEGIN
  IF :NEW.trade_type = 'IMPORT' THEN
    UPDATE facilities
       SET imports_today = imports_today + 1,
           import_pallets_today = import_pallets_today + :NEW.pallets
     WHERE facility_id = :NEW.facility_id;
  ELSIF :NEW.trade_type = 'EXPORT' THEN
    UPDATE facilities
       SET exports_today = exports_today + 1,
           export_pallets_today = export_pallets_today + :NEW.pallets
     WHERE facility_id = :NEW.facility_id;
  END IF;
END;
/

-- Changes to tenant buildings are recorded in the audit trail.
CREATE OR REPLACE TRIGGER trg_park_buildings_audit
AFTER UPDATE OF bldg_status, staff_count, lease_end ON park_buildings
FOR EACH ROW
DECLARE
  v_changes VARCHAR2(1000);
BEGIN
  IF :OLD.bldg_status <> :NEW.bldg_status THEN
    v_changes := v_changes || 'status ' || :OLD.bldg_status || ' → ' || :NEW.bldg_status || '; ';
  END IF;
  IF :OLD.staff_count <> :NEW.staff_count THEN
    v_changes := v_changes || 'staff ' || :OLD.staff_count || ' → ' || :NEW.staff_count || '; ';
  END IF;
  IF :OLD.lease_end <> :NEW.lease_end THEN
    v_changes := v_changes || 'lease end ' || TO_CHAR(:OLD.lease_end, 'YYYY-MM-DD') || ' → ' || TO_CHAR(:NEW.lease_end, 'YYYY-MM-DD') || '; ';
  END IF;
  IF v_changes IS NOT NULL THEN
    wt_core.log_audit('BUILDING_UPDATED', 'BUILDING', :NEW.building_id, :NEW.facility_id,
      :NEW.name || ': ' || RTRIM(v_changes, '; '));
  END IF;
END;
/

-- ============================================================================
-- Package WT_PORT: container terminal rules (check digits, port calls,
-- holding ships, opening and closing berths)
-- ============================================================================
CREATE OR REPLACE PACKAGE wt_port AS
  FUNCTION check_digit (p_container_no IN VARCHAR2) RETURN NUMBER;
  FUNCTION is_valid_container (p_container_no IN VARCHAR2) RETURN CHAR;
  PROCEDURE log_call (
    p_vessel_id  IN VARCHAR2,
    p_voyage_no  IN VARCHAR2,
    p_berth_code IN VARCHAR2,
    p_phase      IN VARCHAR2,
    p_discharged IN NUMBER,
    p_loaded     IN NUMBER,
    p_sim_time   IN NUMBER);
  PROCEDURE set_vessel_hold (p_user_id IN NUMBER, p_vessel_id IN VARCHAR2, p_hold IN CHAR);
  PROCEDURE set_berth_open (p_user_id IN NUMBER, p_berth_code IN VARCHAR2, p_open IN CHAR);
  FUNCTION yard_free (p_block_code IN VARCHAR2) RETURN NUMBER;
END wt_port;
/

CREATE OR REPLACE PACKAGE BODY wt_port AS

  -- ISO 6346: letters map to 10..38 skipping multiples of 11; weights are powers of two.
  FUNCTION check_digit (p_container_no IN VARCHAR2) RETURN NUMBER IS
    v_sum   NUMBER := 0;
    v_ch    VARCHAR2(1);
    v_val   NUMBER;
    v_n     NUMBER;
  BEGIN
    IF p_container_no IS NULL OR LENGTH(p_container_no) < 10 THEN
      RETURN NULL;
    END IF;
    FOR i IN 1 .. 10 LOOP
      v_ch := SUBSTR(p_container_no, i, 1);
      IF v_ch BETWEEN '0' AND '9' THEN
        v_val := TO_NUMBER(v_ch);
      ELSE
        v_n := ASCII(v_ch) - ASCII('A');            -- 0 for A
        v_val := 10 + v_n + CASE WHEN v_n = 0 THEN 0 WHEN v_n <= 10 THEN 1 WHEN v_n <= 20 THEN 2 ELSE 3 END;
      END IF;
      v_sum := v_sum + v_val * POWER(2, i - 1);
    END LOOP;
    RETURN MOD(MOD(v_sum, 11), 10);
  END check_digit;

  FUNCTION is_valid_container (p_container_no IN VARCHAR2) RETURN CHAR IS
  BEGIN
    IF NOT REGEXP_LIKE(p_container_no, '^[A-Z]{3}U[0-9]{7}$') THEN
      RETURN 'N';
    END IF;
    RETURN CASE WHEN check_digit(p_container_no) = TO_NUMBER(SUBSTR(p_container_no, 11, 1)) THEN 'Y' ELSE 'N' END;
  END is_valid_container;

  PROCEDURE log_call (
    p_vessel_id  IN VARCHAR2,
    p_voyage_no  IN VARCHAR2,
    p_berth_code IN VARCHAR2,
    p_phase      IN VARCHAR2,
    p_discharged IN NUMBER,
    p_loaded     IN NUMBER,
    p_sim_time   IN NUMBER)
  IS
  BEGIN
    IF p_phase = 'ARRIVE' THEN
      MERGE INTO vessel_calls c
      USING (SELECT p_vessel_id AS vessel_id, p_voyage_no AS voyage_no FROM dual) s
         ON (c.vessel_id = s.vessel_id AND c.voyage_no = s.voyage_no)
       WHEN NOT MATCHED THEN
         INSERT (vessel_id, voyage_no, berth_code, arrived_s)
         VALUES (p_vessel_id, p_voyage_no, p_berth_code, p_sim_time);
    ELSIF p_phase = 'DEPART' THEN
      UPDATE vessel_calls
         SET departed_s = p_sim_time,
             departed_at = SYSTIMESTAMP,
             boxes_discharged = p_discharged,
             boxes_loaded = p_loaded
       WHERE vessel_id = p_vessel_id
         AND voyage_no = p_voyage_no;
      IF SQL%ROWCOUNT = 0 THEN
        -- the ship was already alongside when the database was created
        INSERT INTO vessel_calls (vessel_id, voyage_no, berth_code, arrived_s, departed_s, boxes_discharged, boxes_loaded, departed_at)
        VALUES (p_vessel_id, p_voyage_no, p_berth_code, p_sim_time, p_sim_time, p_discharged, p_loaded, SYSTIMESTAMP);
      END IF;
    ELSE
      RAISE_APPLICATION_ERROR(-20004, 'Unknown port call phase ' || p_phase);
    END IF;
  END log_call;

  PROCEDURE require_port_manager (p_user_id IN NUMBER) IS
  BEGIN
    IF wt_core.has_permission(p_user_id, 'MANAGE_PORT') <> 'Y' THEN
      RAISE_APPLICATION_ERROR(-20003, 'Not permitted: port operations require the MANAGE_PORT permission');
    END IF;
  END require_port_manager;

  PROCEDURE set_vessel_hold (p_user_id IN NUMBER, p_vessel_id IN VARCHAR2, p_hold IN CHAR) IS
    v_v vessels%ROWTYPE;
  BEGIN
    require_port_manager(p_user_id);
    IF p_hold NOT IN ('Y', 'N') THEN
      RAISE_APPLICATION_ERROR(-20004, 'Hold must be Y or N');
    END IF;
    BEGIN
      SELECT * INTO v_v FROM vessels WHERE vessel_id = p_vessel_id FOR UPDATE;
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        RAISE_APPLICATION_ERROR(-20001, 'Vessel ' || p_vessel_id || ' not found');
    END;
    IF v_v.on_hold = p_hold THEN
      RAISE_APPLICATION_ERROR(-20002, v_v.name || CASE WHEN p_hold = 'Y' THEN ' is already on hold' ELSE ' is not on hold' END);
    END IF;
    UPDATE vessels SET on_hold = p_hold, updated_at = SYSTIMESTAMP WHERE vessel_id = p_vessel_id;
    wt_core.log_audit(CASE WHEN p_hold = 'Y' THEN 'VESSEL_HELD' ELSE 'VESSEL_RELEASED' END, 'VESSEL', p_vessel_id, NULL,
      v_v.name || ' (' || v_v.voyage_no || ', ' || LOWER(REPLACE(v_v.vessel_status, '_', ' ')) || ')' ||
      CASE WHEN p_hold = 'Y' THEN ' held by the port manager' ELSE ' released' END, p_user_id);
  END set_vessel_hold;

  PROCEDURE set_berth_open (p_user_id IN NUMBER, p_berth_code IN VARCHAR2, p_open IN CHAR) IS
    v_b port_berths%ROWTYPE;
    v_open NUMBER;
  BEGIN
    require_port_manager(p_user_id);
    BEGIN
      SELECT * INTO v_b FROM port_berths WHERE berth_code = p_berth_code FOR UPDATE;
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        RAISE_APPLICATION_ERROR(-20001, 'Berth ' || p_berth_code || ' not found');
    END;
    IF v_b.is_open = p_open THEN
      RAISE_APPLICATION_ERROR(-20002, v_b.name || CASE WHEN p_open = 'Y' THEN ' is already open' ELSE ' is already closed' END);
    END IF;
    IF p_open = 'N' THEN
      SELECT COUNT(*) INTO v_open FROM port_berths WHERE is_open = 'Y' AND berth_code <> p_berth_code;
      IF v_open = 0 THEN
        RAISE_APPLICATION_ERROR(-20004, 'At least one berth must stay open');
      END IF;
    END IF;
    UPDATE port_berths SET is_open = p_open, updated_at = SYSTIMESTAMP WHERE berth_code = p_berth_code;
    wt_core.log_audit(CASE WHEN p_open = 'Y' THEN 'BERTH_OPENED' ELSE 'BERTH_CLOSED' END, 'BERTH', p_berth_code, NULL,
      v_b.name || CASE WHEN p_open = 'Y' THEN ' reopened' ELSE ' closed to new arrivals' END, p_user_id);
  END set_berth_open;

  FUNCTION yard_free (p_block_code IN VARCHAR2) RETURN NUMBER IS
    v_cap  NUMBER;
    v_used NUMBER;
  BEGIN
    SELECT capacity_boxes INTO v_cap FROM yard_blocks WHERE block_code = p_block_code;
    SELECT COUNT(*) INTO v_used FROM yard_containers WHERE block_code = p_block_code;
    RETURN v_cap - v_used;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RETURN NULL;
  END yard_free;

END wt_port;
/

-- Every container move must carry a valid ISO 6346 number.
CREATE OR REPLACE TRIGGER trg_container_moves_bi
BEFORE INSERT ON container_moves
FOR EACH ROW
BEGIN
  IF wt_port.is_valid_container(:NEW.container_no) <> 'Y' THEN
    RAISE_APPLICATION_ERROR(-20004, 'Invalid container number ' || :NEW.container_no || ' (ISO 6346 check digit)');
  END IF;
END;
/

-- The container ledger drives the yard: discharged and gated-in boxes are stacked,
-- loaded and gated-out boxes leave the stacks.
CREATE OR REPLACE TRIGGER trg_container_moves_ai
AFTER INSERT ON container_moves
FOR EACH ROW
BEGIN
  IF :NEW.move_type IN ('DISCHARGE', 'GATE_IN') THEN
    MERGE INTO yard_containers y
    USING (SELECT :NEW.container_no AS container_no FROM dual) s
       ON (y.container_no = s.container_no)
     WHEN NOT MATCHED THEN
       INSERT (container_no, block_code, line_code, vessel_id, facility_id, arrived_move_id)
       VALUES (:NEW.container_no, CASE WHEN :NEW.move_type = 'DISCHARGE' THEN 'IMPORT' ELSE 'EXPORT' END,
               SUBSTR(:NEW.container_no, 1, 3), :NEW.vessel_id, :NEW.facility_id, :NEW.move_id);
  ELSE
    DELETE FROM yard_containers WHERE container_no = :NEW.container_no;
  END IF;
END;
/

-- ============================================================================
-- Package WT_RETAIL: store restock orders placed on the CargoVerse warehouses
-- ============================================================================
CREATE OR REPLACE PACKAGE wt_retail AS
  PROCEDURE place_order (
    p_user_id   IN NUMBER,
    p_order_id  IN VARCHAR2,
    p_store_id  IN VARCHAR2,
    p_sku_id    IN VARCHAR2,
    p_units     IN NUMBER,
    p_facility  IN VARCHAR2,
    p_sim_time  IN NUMBER);
  PROCEDURE cancel_order (p_user_id IN NUMBER, p_order_id IN VARCHAR2);
  FUNCTION cover_hours (p_store_id IN VARCHAR2, p_sku_id IN VARCHAR2) RETURN NUMBER;
  FUNCTION best_supplier (p_store_id IN VARCHAR2, p_sku_id IN VARCHAR2, p_units IN NUMBER) RETURN VARCHAR2;
END wt_retail;
/

CREATE OR REPLACE PACKAGE BODY wt_retail AS

  PROCEDURE require_retail_manager (p_user_id IN NUMBER) IS
  BEGIN
    IF wt_core.has_permission(p_user_id, 'MANAGE_RETAIL') <> 'Y' THEN
      RAISE_APPLICATION_ERROR(-20003, 'Not permitted: store orders require the MANAGE_RETAIL permission');
    END IF;
  END require_retail_manager;

  -- the store's usual warehouse if it has enough units, otherwise the warehouse with the most
  FUNCTION best_supplier (p_store_id IN VARCHAR2, p_sku_id IN VARCHAR2, p_units IN NUMBER) RETURN VARCHAR2 IS
    v_pref VARCHAR2(10);
    v_fac  VARCHAR2(10);
    v_n    NUMBER;
  BEGIN
    SELECT facility_id INTO v_pref FROM stores WHERE store_id = p_store_id;
    SELECT COUNT(*) INTO v_n FROM inventory WHERE facility_id = v_pref AND sku_id = p_sku_id AND units >= p_units;
    IF v_n > 0 THEN
      RETURN v_pref;
    END IF;
    SELECT facility_id INTO v_fac
      FROM (SELECT facility_id FROM inventory
             WHERE sku_id = p_sku_id AND units >= p_units
             ORDER BY units DESC)
     WHERE ROWNUM = 1;
    RETURN v_fac;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RETURN NULL;
  END best_supplier;

  PROCEDURE place_order (
    p_user_id   IN NUMBER,
    p_order_id  IN VARCHAR2,
    p_store_id  IN VARCHAR2,
    p_sku_id    IN VARCHAR2,
    p_units     IN NUMBER,
    p_facility  IN VARCHAR2,
    p_sim_time  IN NUMBER)
  IS
    v_line  store_stock%ROWTYPE;
    v_open  NUMBER;
    v_have  NUMBER;
    v_name  stores.name%TYPE;
  BEGIN
    require_retail_manager(p_user_id);
    BEGIN
      SELECT * INTO v_line FROM store_stock WHERE store_id = p_store_id AND sku_id = p_sku_id;
      SELECT name INTO v_name FROM stores WHERE store_id = p_store_id;
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        RAISE_APPLICATION_ERROR(-20001, 'Store ' || p_store_id || ' does not stock ' || p_sku_id);
    END;
    IF p_units IS NULL OR p_units <= 0 OR p_units > v_line.max_units * 2 THEN
      RAISE_APPLICATION_ERROR(-20004, 'Order between 1 and ' || (v_line.max_units * 2) || ' units');
    END IF;
    SELECT COUNT(*) INTO v_open FROM store_orders
     WHERE store_id = p_store_id AND sku_id = p_sku_id AND order_status IN ('PLACED', 'LOADING', 'OUT_FOR_DELIVERY');
    IF v_open > 0 THEN
      RAISE_APPLICATION_ERROR(-20002, v_name || ' already has an open order for this product');
    END IF;
    SELECT NVL(MAX(units), 0) INTO v_have FROM inventory WHERE facility_id = p_facility AND sku_id = p_sku_id;
    IF v_have < p_units THEN
      RAISE_APPLICATION_ERROR(-20006, p_facility || ' has only ' || v_have || ' units of ' || p_sku_id);
    END IF;
    INSERT INTO store_orders (order_id, store_id, sku_id, facility_id, units, order_status, order_source, placed_by, placed_s)
    VALUES (p_order_id, p_store_id, p_sku_id, p_facility, p_units, 'PLACED', 'MANUAL', p_user_id, p_sim_time);
    wt_core.log_audit('STORE_ORDER_PLACED', 'STORE_ORDER', p_order_id, p_facility,
      v_name || ': ' || p_units || ' × ' || p_sku_id || ' from ' || p_facility, p_user_id);
  END place_order;

  PROCEDURE cancel_order (p_user_id IN NUMBER, p_order_id IN VARCHAR2) IS
    v_o store_orders%ROWTYPE;
  BEGIN
    require_retail_manager(p_user_id);
    BEGIN
      SELECT * INTO v_o FROM store_orders WHERE order_id = p_order_id FOR UPDATE;
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        RAISE_APPLICATION_ERROR(-20001, 'Order ' || p_order_id || ' not found');
    END;
    IF v_o.order_status <> 'PLACED' THEN
      RAISE_APPLICATION_ERROR(-20002, 'Only orders that are not yet loaded can be cancelled (this one is ' || v_o.order_status || ')');
    END IF;
    UPDATE store_orders SET order_status = 'CANCELLED' WHERE order_id = p_order_id;
    wt_core.log_audit('STORE_ORDER_CANCELLED', 'STORE_ORDER', p_order_id, v_o.facility_id,
      v_o.store_id || ': ' || v_o.units || ' × ' || v_o.sku_id || ' cancelled', p_user_id);
  END cancel_order;

  -- hours of trading the shelf stock will last at the store's sales rate
  FUNCTION cover_hours (p_store_id IN VARCHAR2, p_sku_id IN VARCHAR2) RETURN NUMBER IS
    v_units NUMBER;
    v_rate  NUMBER;
  BEGIN
    SELECT units, sales_per_hour INTO v_units, v_rate FROM store_stock WHERE store_id = p_store_id AND sku_id = p_sku_id;
    IF v_rate = 0 THEN
      RETURN NULL;
    END IF;
    RETURN ROUND(v_units / v_rate, 1);
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RETURN NULL;
  END cover_hours;

END wt_retail;
/

-- Order milestones are timestamped by the database.
CREATE OR REPLACE TRIGGER trg_store_orders_biu
BEFORE INSERT OR UPDATE OF order_status ON store_orders
FOR EACH ROW
BEGIN
  IF :NEW.order_status = 'OUT_FOR_DELIVERY' AND :NEW.dispatched_at IS NULL THEN
    :NEW.dispatched_at := SYSTIMESTAMP;
  ELSIF :NEW.order_status = 'DELIVERED' AND :NEW.delivered_at IS NULL THEN
    :NEW.delivered_at := SYSTIMESTAMP;
    IF :NEW.dispatched_at IS NULL THEN
      :NEW.dispatched_at := SYSTIMESTAMP;
    END IF;
  END IF;
END;
/

-- Every status change of a store order is kept in STORE_ORDER_HISTORY.
CREATE OR REPLACE TRIGGER trg_store_orders_aiu
AFTER INSERT OR UPDATE OF order_status ON store_orders
FOR EACH ROW
DECLARE
  v_old store_orders.order_status%TYPE;
BEGIN
  IF UPDATING THEN
    v_old := :OLD.order_status;
  END IF;
  IF INSERTING OR NVL(v_old, '-') <> :NEW.order_status THEN
    INSERT INTO store_order_history (order_id, old_status, new_status, van_id, changed_by)
    VALUES (:NEW.order_id, v_old, :NEW.order_status, :NEW.van_id, wt_core.current_user_id);
  END IF;
END;
/
