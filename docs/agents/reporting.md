# Reporting from ClickHouse

Every report page reads Today live from Convex. Any other range reads ClickHouse once the page is switched for the tenant. Fivetran copies Convex to ClickHouse every 6 hours, and answers are cached in Convex, so ClickHouse only runs while a sync already woke it. The design and its decisions are in `docs/plans/clickhouse-reporting.md`.

## How a range is answered

| Range | Page not switched | Page switched (or `?analytics=preview`) |
| --- | --- | --- |
| Today | The page's Convex reader | The page's Convex reader |
| Anything else | The page's Convex reader (Operations: snapshot job over 7 days) | `analyticsResults`, filled from ClickHouse |

- `tenants.analyticsReports` lists the switched pages, and `getCurrentTenant` returns it.
- `useAnalyticsReport` (`app/workspace/_components/analytics/`) picks the source for each panel. `AnalyticsFreshnessLine` shows "Live", "Data as of …", or the loading, waiting, delayed and failed states.
- A Reports page range maps to a preset or custom dates with `reportRangeToAnalyticsRange`, a dashboard range with `dashboardRangeToAnalyticsRange` (`lib/analyticsRange.ts`).
- A preset ("this month") is one cache key all month. It's resolved when its answer is computed.

## The engine (`convex/analytics/`)

| File | What it holds |
| --- | --- |
| `definition.ts` | `defineReport` and the report contract: filters, SQL, finalize, and the Convex reader it replaces |
| `definitions/*.ts` | One file per page, each with a parity test |
| `registry.ts` | Every report; add a page's definitions here |
| `reports.ts` | `get` (the query pages subscribe to) and `request` (registers a key and runs it on a miss) |
| `results.ts` | The `analyticsResults` lifecycle (answers live in `analyticsPayloads`, so bookkeeping reads small rows), the daily budget, and finalize |
| `run.ts` | `runReport` and `runPostSyncBatch` |
| `sync.ts` | The heartbeat cron, the Fivetran `sync_end` webhook (`/analytics/fivetran`), and the stale-sync alert |
| `switch.ts`, `parity.ts` | CLI tools for switching pages and comparing sources on production |
| `api/` | The external API: keys, metrics, and `/api/v1` routes |

### Lifecycle of a key

1. A page opens a key with `request`. If no answer covers the current sync and period, `request` runs it. Each tenant gets 30 such runs a day, retries of a failing key included; past that the key waits for the next batch (`queued`). An open panel renews its key hourly.
2. After each sync, Fivetran calls `/analytics/fivetran`, and `runPostSyncBatch` reruns every key opened in the last 7 days, two at a time, while ClickHouse is awake.
3. `analyticsSync` is one row. A 5-minute heartbeat stamps it, and Fivetran copies it, so ClickHouse's copy is the watermark: the newest write the sync included. No page reads this table.

## Adding a report

1. Split the Convex reader without changing behavior. The query keeps auth and the Convex load; the rest moves to an exported `build*` function (see `reporting/revenue.ts`).
2. Write a definition that returns the reader's exact type (`defineReport<typeof reader, Filters>`):
   - The SQL returns the rows the reader would load. `finalize` maps them with `docsFromRows` and calls the same builder.
   - For high-volume sources (captures, domain events) or a reader that reads an aggregate or bucket table, aggregate in SQL to the grain the builder needs.
3. Add a parity test with `expectSameAnswer` and `rowFromDoc` (`tests/analyticsParity.ts`).
4. Wire the page with `useAnalyticsReport` and `AnalyticsFreshnessLine`.

## SQL rules

- Read only `analytics.*` views. Filter every view you read, joins included, with `tenant_id = {tenant_id:String}`. The engine sets the tenant; templates never do.
- Take the range from `rangeParams`: `{from_ms:Int64}`, `{to_ms:Int64}`, `{tz:String}`, `{day_start_hour:UInt8}`. Pass every other value as a `{name:Type}` parameter. `reports.test.ts` fails any template that breaks these rules.
- A business day in SQL is `toDate(toTimeZone(fromUnixTimestamp64Milli(x_ms), {tz:String}) - toIntervalHour({day_start_hour:UInt8}))`.
- View conventions (`clickhouse/migrations/0002_views.sql`):
  - snake_case columns
  - Int64 `*_ms` timestamps
  - `*_json` objects
  - no contact fields; `form_answers` shows a contact answer as `Hidden contact detail`
- Fivetran adds a column only once a row sets it, so the views list unsynced schema fields as typed NULLs. When one appears in `convex_app`, replace the NULL in a new migration.
- Rows handed to `finalize` are capped at 4 MB, and an answer at about 900 KB.

## ClickHouse objects

- `clickhouse/migrations/*.sql` are applied with `pnpm ch:migrate` (admin credentials in the shell, never in Convex) or pasted into the SQL console. Views are `CREATE OR REPLACE`, so a file can be applied again.
- `clickhouse/admin/magnus_app.sql` creates the login Convex uses: read-only on `analytics.*`, 30-second queries, an hourly quota.
- `clickhouse/admin/unsynced_view_columns.sql` lists the columns the views still fill with NULL that Fivetran has since added. Run it now and then; replace each one it returns in a new migration.
- There is one ClickHouse service, and it holds production data, so run SQL right after a sync.

## Operating on production

| Task | Command |
| --- | --- |
| Compare a page's sources (read-only) | `pnpm analytics:parity <page> --tenant <tenantId> [--range last_month] [--filters '{"fieldKey":"…"}']` (Leads needs a `fieldKey`) |
| Switch a page to ClickHouse | `npx convex run --prod analytics/switch:enable '{"tenantId":"…","page":"revenue"}'` |
| Roll a page back | `npx convex run --prod analytics/switch:disable '{"tenantId":"…","page":"revenue"}'` |
| Rerun the batch by hand | `npx convex run --prod analytics/run:runPostSyncBatch '{"force":true}'` |
| Stop every ClickHouse call | Remove `CLICKHOUSE_URL` from the production env |

To preview a page before it's switched, add `?analytics=preview` to its URL.

The PostHog events to watch are:

- `analytics.report_failed`
- `analytics.batch_failed`
- `analytics.sync_stale` (no sync in 8 hours)
- `analytics.fivetran.rejected`
- `api.request`

## External API

- Keys are `mgn_live_<keyId>_<secret>`, created on Settings › Integrations by `settings:manage`. Only the secret's SHA-256 is stored.
- Each key may make 60 requests a minute, counted on the key's row.
- `/api/v1/metrics` and `/funnel` use the same cache as the pages. `/today` reads Convex live with the same metric definitions (`api/metrics.ts`).
- The contract is `docs/api/openapi.yaml`.
