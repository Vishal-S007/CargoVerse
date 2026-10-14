--------------------------------------------------------------------------------
-- Optional: create the WARETRACK schema owner. Run as SYSTEM connected to the
-- pluggable database (e.g. FREEPDB1 / XEPDB1). Not needed with the Docker setup,
-- which creates the user automatically (APP_USER / APP_USER_PASSWORD).
--------------------------------------------------------------------------------
CREATE USER waretrack IDENTIFIED BY "WareTrack_2026" DEFAULT TABLESPACE users QUOTA UNLIMITED ON users;
GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE SEQUENCE, CREATE PROCEDURE, CREATE TRIGGER TO waretrack;
