--------------------------------------------------------------------------------
-- CargoVerse — row-level security, part 1 (run as SYSDBA in the pluggable database)
--
-- npm run db:setup / db:reset / db:lab run this automatically through
--   docker exec -i waretrack-oracle sqlplus -S / as sysdba
-- Running Oracle without Docker? Run it yourself in SQL Developer as SYS
-- (connected to FREEPDB1 or your PDB), then run npm run db:lab again.
--
-- It lets the schema owner create Virtual Private Database policies (and use the
-- event queue, scheduler, property graphs and blockchain tables), and creates
-- four demonstration database accounts, one per kind of user. Each account sees
-- only the rows of the sites its CargoVerse user may work at (08_security.sql).
--   CV_ADMIN  → admin       all sites
--   CV_ALEX   → alex.chen   WH-01 Riverside Hub + WH-04 Southfield Cross-Dock
--   CV_MEERA  → meera.iyer  WH-02 Northgate DC
--   CV_ZOE    → zoe.reyes   WH-04 Southfield Cross-Dock
--------------------------------------------------------------------------------
WHENEVER SQLERROR EXIT FAILURE
ALTER SESSION SET CONTAINER = FREEPDB1;

GRANT EXECUTE ON SYS.DBMS_RLS TO waretrack;

-- Smart Warehouse (12_wms_optional.sql): event queue, scheduler jobs, property graph,
-- blockchain table. Each grant is optional: a database without the feature skips it.
DECLARE
  c_owner CONSTANT VARCHAR2(128) := 'WARETRACK';
  PROCEDURE g (p_grant IN VARCHAR2) IS
  BEGIN
    EXECUTE IMMEDIATE p_grant || ' TO ' || c_owner;
  EXCEPTION
    WHEN OTHERS THEN NULL;
  END g;
BEGIN
  g('GRANT EXECUTE ON SYS.DBMS_AQ');
  g('GRANT EXECUTE ON SYS.DBMS_AQADM');
  g('GRANT AQ_ADMINISTRATOR_ROLE');
  g('GRANT CREATE JOB');
  g('GRANT CREATE PROPERTY GRAPH');
  g('GRANT EXECUTE ON SYS.DBMS_BLOCKCHAIN_TABLE');
END;
/

DECLARE
  PROCEDURE account (p_name IN VARCHAR2) IS
    v_n NUMBER;
  BEGIN
    SELECT COUNT(*) INTO v_n FROM dba_users WHERE username = p_name;
    IF v_n = 0 THEN
      EXECUTE IMMEDIATE 'CREATE USER ' || p_name || ' IDENTIFIED BY "Cargo_2026"';
    ELSE
      EXECUTE IMMEDIATE 'ALTER USER ' || p_name || ' IDENTIFIED BY "Cargo_2026" ACCOUNT UNLOCK';
    END IF;
    EXECUTE IMMEDIATE 'GRANT CREATE SESSION TO ' || p_name;
  END account;
BEGIN
  account('CV_ADMIN');
  account('CV_ALEX');
  account('CV_MEERA');
  account('CV_ZOE');
END;
/
EXIT
