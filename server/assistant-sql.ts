// Ready-made database questions answered in demo mode (no API key). db:selftest runs each one on Oracle.
/** Ready-made database questions for demo mode: the question pattern and its SQL. */
export const DEMO_SQL: { re: RegExp; purpose: string; sql: string }[] = [
  { re: /(busiest|most).*(dock|bay)/, purpose: 'Docks ranked by trucks handled today', sql: `SELECT dock_id, facility_id, trucks_today\n  FROM docks\n ORDER BY trucks_today DESC\n FETCH FIRST 8 ROWS ONLY` },
  { re: /(top|best|most).*(product|sku|seller|demand|moving)|fast(est)? mov/, purpose: 'Products ranked by units shipped in the last 30 days', sql: `SELECT d.facility_id, s.name AS product, SUM(d.units_out) AS units_30d,\n       ROUND(100 * RATIO_TO_REPORT(SUM(d.units_out)) OVER (PARTITION BY d.facility_id), 1) AS share_pct\n  FROM sku_daily_demand d JOIN skus s ON s.sku_id = d.sku_id\n WHERE d.demand_date >= TRUNC(SYSDATE) - 30\n GROUP BY d.facility_id, s.name\n ORDER BY units_30d DESC\n FETCH FIRST 10 ROWS ONLY` },
  { re: /how many.*(truck)/, purpose: 'Trucks per site and status', sql: `SELECT facility_id, status, COUNT(*) AS trucks\n  FROM trucks\n GROUP BY facility_id, status\n ORDER BY facility_id, trucks DESC` },
  { re: /how many.*(pallet)/, purpose: 'Pallets per site', sql: `SELECT facility_id, COUNT(*) AS pallets\n  FROM pallets\n GROUP BY ROLLUP (facility_id)\n ORDER BY facility_id` },
  { re: /how many.*(shipment)/, purpose: 'Shipments per site and status', sql: `SELECT facility_id, ship_status, COUNT(*) AS shipments\n  FROM shipments\n GROUP BY facility_id, ship_status\n ORDER BY facility_id, shipments DESC` },
  { re: /how many.*(lot)/, purpose: 'Lots per site and quality status', sql: `SELECT facility_id, qc_status, COUNT(*) AS lots, SUM(units_on_hand) AS units\n  FROM lots\n GROUP BY facility_id, qc_status\n ORDER BY facility_id, qc_status` },
  { re: /(supplier)/, purpose: 'Stock by supplier', sql: `SELECT supplier, COUNT(*) AS lots, SUM(units_on_hand) AS units\n  FROM lots\n WHERE units_on_hand > 0\n GROUP BY supplier\n ORDER BY units DESC` },
  { re: /(audit|who changed|history of changes)/, purpose: 'Latest changes in the audit trail', sql: `SELECT TO_CHAR(created_at, 'HH24:MI:SS') AS at, action, entity, entity_id, details\n  FROM audit_log\n ORDER BY audit_id DESC\n FETCH FIRST 10 ROWS ONLY` },
];

