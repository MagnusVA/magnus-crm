-- The reporting watermark (docs/plans/clickhouse-reporting.md §8.2): the newest
-- heartbeat the last sync copied. Apply after the first sync that includes the
-- analyticsSync table, which Convex creates on its first heartbeat.
CREATE OR REPLACE VIEW analytics.watermark
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    fromUnixTimestamp64Milli(CAST(beatat AS Int64)) AS beat_at
FROM convex_app.analyticssync FINAL
WHERE NOT _fivetran_deleted AND beatat IS NOT NULL;
