--------------------------------------------------------------------------------
-- CargoVerse — row-level security, part 3 (run as SYSDBA after 08_security.sql)
-- Gives each demonstration account private synonyms, so in SQL Developer they can
-- write SELECT * FROM trucks instead of SELECT * FROM waretrack.trucks.
--------------------------------------------------------------------------------
WHENEVER SQLERROR EXIT FAILURE
ALTER SESSION SET CONTAINER = FREEPDB1;

BEGIN
  FOR p IN (SELECT grantee, table_name FROM dba_tab_privs
             WHERE owner = 'WARETRACK' AND privilege = 'SELECT'
               AND grantee IN ('CV_ADMIN', 'CV_ALEX', 'CV_MEERA', 'CV_ZOE')) LOOP
    EXECUTE IMMEDIATE 'CREATE OR REPLACE SYNONYM ' || p.grantee || '.' || p.table_name || ' FOR WARETRACK.' || p.table_name;
  END LOOP;
END;
/
EXIT
