-- The reporting layer's own database (docs/plans/clickhouse-reporting.md §7.1).
-- Fivetran's tables stay in convex_app; nothing here writes to them.
CREATE DATABASE IF NOT EXISTS analytics;

-- Applied migrations, recorded by `pnpm ch:migrate`.
CREATE TABLE IF NOT EXISTS analytics._migrations
(
    name String,
    applied_at DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY name;
