-- The login Convex uses (docs/plans/clickhouse-reporting.md §7.3). Run once in
-- the ClickHouse Cloud SQL console as the admin user, after the migrations.
-- Replace REPLACE_WITH_A_LONG_RANDOM_PASSWORD with a random ASCII password and
-- set the same value in Convex as CLICKHOUSE_PASSWORD. Never commit it.

-- Read the analytics views, nothing else. The views are SQL SECURITY DEFINER,
-- so the role needs no grant on convex_app or the component databases.
CREATE ROLE IF NOT EXISTS analytics_reader;
GRANT SELECT ON analytics.* TO analytics_reader;

-- Read-only, and the client can't raise its own limits. readonly = 2 still
-- lets Convex send per-query settings such as SQL_tenant_id.
CREATE SETTINGS PROFILE IF NOT EXISTS magnus_app_profile SETTINGS
    readonly = 2,
    max_execution_time = 30 MAX 30,
    max_result_rows = 200000 MAX 200000,
    max_result_bytes = 50000000 MAX 50000000,
    max_memory_usage = 2000000000 MAX 2000000000,
    max_concurrent_queries_for_user = 4 MAX 4;

CREATE USER IF NOT EXISTS magnus_app
    IDENTIFIED WITH sha256_password BY 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD'
    SETTINGS PROFILE 'magnus_app_profile';
GRANT analytics_reader TO magnus_app;
ALTER USER magnus_app DEFAULT ROLE analytics_reader;

-- A runaway loop stops here instead of keeping the service awake.
CREATE QUOTA IF NOT EXISTS magnus_app_quota
    FOR INTERVAL 1 hour MAX queries = 600, errors = 100, execution_time = 900
    TO magnus_app;

-- Check: run as magnus_app (or with the user switcher) and expect a count,
-- then expect "Not enough privileges" from the second query.
-- SELECT count() FROM analytics.meetings;
-- SELECT count() FROM convex_app.meetings;
