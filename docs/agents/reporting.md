# Reporting from ClickHouse

Every report page reads today live from Convex, on its own or as part of a longer range. Once a page is switched for the tenant, the days before today read ClickHouse. Fivetran copies Convex to ClickHouse every 6 hours, and answers are cached in Convex, so ClickHouse only runs while a sync already woke it. The design and its decisions are in `docs/plans/clickhouse-reporting.md`.

## How a range is answered

| Range | Page not switched | Page switched (or `?analytics=preview`) |
| --- | --- | --- |
| Today, or any range that starts today | The page's Convex reader | The page's Convex reader |
| Ended before today | The page's Convex reader (Operations: snapshot job over 7 days) | `analyticsResults`, filled from ClickHouse |
| Days before today and today (This week, This month, Last 90 days, custom) | The page's Convex reader (Operations: snapshot job over 7 days) | ClickHouse for the days before today, the Convex reader from the start of today, merged in the page |

- `tenants.analyticsReports` lists the switched pages, and `getCurrentTenant` returns it.
- `reportRangePlan` (Reports pages, browser days) and `dashboardRangePlan` (Overview, Operations, lead gen, business days) in `lib/analyticsRange.ts` plan a range as `live`, `warehouse` or `split`. A split's history is the preset with `throughYesterday: true` ("this month through yesterday"), or custom dates ending yesterday.
- `useAnalyticsReport` (`app/workspace/_components/analytics/`) reads each panel. It takes the reader's arguments for the whole range (`liveArgs`), for the part from the start of today (`todayArgs`, from `reportWindowFromToday` or `dashboardRangeFromToday`), and the report's `merge`. It merges only an answer that covers exactly the days before today. A report whose days can't be split passes `merge: null` and reads the whole range from ClickHouse as of the last sync: Team's outcome mix, where a payment or reschedule today changes an earlier call's outcome.
- `AnalyticsFreshnessLine` shows "Live", "Data as of …", "Today live · earlier days as of …", or the loading, waiting, delayed and failed states.
- A preset ("this month") is one cache key all month. It's resolved when its answer is computed. A preset through yesterday ends on a fixed day, so the first request after midnight runs it again, and on its first day (this week, on Monday) it has nothing to run.
- Between the evening sync and the first sync after midnight, the hours from that evening sync to midnight are in neither source. A late change to an earlier day, such as last Tuesday's call marked held today, shows after the next sync.

## The engine (`convex/analytics/`)

| File | What it holds |
| --- | --- |
| `definition.ts` | `defineReport` and the report contract: filters, SQL, finalize, and the Convex reader it replaces |
| `definitions/*.ts` | One file per page, each with a parity test |
| `merge/*.ts` | One file per page: joins ClickHouse's answer for the days before today with the reader's answer from today. Pages import them, so they import server code as types only |
| `registry.ts` | Every report; add a page's definitions here |
| `reports.ts` | `get` (the query pages subscribe to) and `request` (registers a key and runs it on a miss) |
| `results.ts` | The `analyticsResults` lifecycle (answers live in `analyticsPayloads`, so bookkeeping reads small rows), the optional daily budget, and finalize |
| `pool.ts` | `analyticsPool`, which runs what pages and API callers start, 2 at a time |
| `run.ts` | `runReport` and `runPostSyncBatch` |
| `sync.ts` | The heartbeat cron, the Fivetran `sync_end` webhook (`/analytics/fivetran`), and the stale-sync alert |
| `switch.ts`, `parity.ts` | CLI tools for switching pages and comparing sources on production |
| `api/` | The external API: keys, metrics, and `/api/v1` routes |

### Lifecycle of a key

1. A page opens a key with `request`. If no answer covers the current sync and period, `request` runs it on `analyticsPool`. The pool runs 2 at a time, so a page's panels and the batch stay within `magnus_app`'s 4 simultaneous queries. There's no daily limit unless `ANALYTICS_DAILY_RUN_BUDGET` sets one; past it, a tenant's new keys wait for the next batch (`queued`), and retries of a failing key count too. An open panel renews its key hourly.
2. After each sync, Fivetran calls `/analytics/fivetran`, and `runPostSyncBatch` reruns every key opened in the last 7 days, two at a time, while ClickHouse is awake.
3. `analyticsSync` is one row. A 5-minute heartbeat stamps it, and Fivetran copies it, so ClickHouse's copy is the watermark: the newest write the sync included. No page reads this table.

## Adding a report

1. Split the Convex reader without changing behavior. The query keeps auth and the Convex load; the rest moves to an exported `build*` function (see `reporting/revenue.ts`).
2. Write a definition that returns the reader's exact type (`defineReport<typeof reader, Filters>`):
   - The SQL returns the rows the reader would load. `finalize` maps them with `docsFromRows` and calls the same builder.
   - For high-volume sources (captures, domain events) or a reader that reads an aggregate or bucket table, aggregate in SQL to the grain the builder needs.
3. Add a parity test with `expectSameAnswer` and `rowFromDoc` (`tests/analyticsParity.ts`).
4. Write the report's merge in `merge/<page>.ts` with the helpers in `merge/helpers.ts`: counts and sums add, rates are worked out again from their parts, lists keyed by an id combine, and current people and labels come from today's answer. Test it with `expectMergedAnswer` (`tests/analyticsMerge.ts`): merging the reader's answers for two adjacent windows must equal its answer for both.
5. Wire the page with `useAnalyticsReport` and `AnalyticsFreshnessLine`.

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

The Convex CLI ignores `--prod` while `CONVEX_DEPLOY_KEY` is set, in the shell or in `.env.local`, and runs against the key's deployment. If `.env.local` holds a dev key, export the production deploy key in the shell before these commands. `pnpm analytics:parity` stops when the key is for the wrong deployment.

| Task | Command |
| --- | --- |
| Compare a page's sources (read-only) | `pnpm analytics:parity <page> --tenant <tenantId> [--range last_month] [--filters '{"fieldKey":"…"}']` (Leads needs a `fieldKey`, Overview's leaderboard a `kind`) |
| Switch a page to ClickHouse | `npx convex run --prod analytics/switch:enable '{"tenantId":"…","page":"revenue"}'` |
| Roll a page back | `npx convex run --prod analytics/switch:disable '{"tenantId":"…","page":"revenue"}'` |
| Rerun the batch by hand | `npx convex run --prod analytics/run:runPostSyncBatch '{"force":true}'` |
| Limit the runs a tenant starts in 24 hours | `npx convex env set --prod ANALYTICS_DAILY_RUN_BUDGET 100` (`env remove` lifts it) |
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
- `docs/api/metrics-api-guide.html` is the visual guide for API users: every endpoint, status code and error, with charts built from the responses. Open it in a browser. Its requests, headers and timings come from real production calls; the response bodies are sample data, because this repo is public. Keep real workspace data out of it.
