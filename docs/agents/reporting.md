# Reporting from ClickHouse

Every report page reads today live from Convex, on its own or as part of a longer range. Once a page is switched for the tenant, the days before today read ClickHouse. The exception is a report whose days can't be split, Team's outcome mix: a range that includes today reads it whole from ClickHouse, as of the last sync. Fivetran copies Convex to ClickHouse every 6 hours, and answers are cached in Convex, so ClickHouse only runs while a sync already woke it. The design and its decisions are in `docs/plans/clickhouse-reporting.md`.

## How a range is answered

| Range | Page not switched | Page switched (or `?analytics=preview`) |
| --- | --- | --- |
| Today, or any range that starts today | The page's Convex reader | The page's Convex reader |
| A custom range of one day, before today | The page's Convex reader | The page's Convex reader |
| Ended before today | The page's Convex reader (Operations: snapshot job over 7 days) | `analyticsResults`, filled from ClickHouse |
| Days before today and today (This week, This month, Last 90 days, custom) | The page's Convex reader (Operations: snapshot job over 7 days) | ClickHouse for the days before today, the Convex reader from the start of today, merged in the page (Team's outcome mix: the whole range from ClickHouse) |

- `tenants.analyticsReports` lists the switched pages, and `getCurrentTenant` returns it.
- `dashboardRangePlan` in `lib/analyticsRange.ts` plans every page's range in the tenant's business days (Overview, Operations, lead gen and Reports; Reports reach it through `useReportRange`, which also turns the picker's business dates into the readers' timestamps and day keys). It plans a range as `live`, `warehouse` or `split`. A custom range of one day is always `live`: one day is a small read for Convex. A split's history is the preset with `throughYesterday: true` ("this month through yesterday"), or custom dates ending yesterday.
- `useAnalyticsReport` (`app/workspace/_components/analytics/`) reads each panel. It takes the reader's arguments for the whole range (`liveArgs`), for the part from the start of today (`todayArgs`, from `dashboardRangeFromToday`), and the report's `merge`. It merges only an answer that covers exactly the days before today. A report whose days can't be split passes `merge: null` and reads the whole range from ClickHouse as of the last sync: Team's outcome mix, where a payment or reschedule today changes an earlier call's outcome.
- `AnalyticsFreshnessLine` shows "Live", "Data as of …", "Today live · earlier days as of …", or the loading, waiting, delayed and failed states.
- A preset ("this month") is one cache key all month. It's resolved when its answer is computed. A preset through yesterday ends on a fixed day, so the first request after midnight runs it again, and on its first day (this week, on Monday) it has nothing to run.
- Between the evening sync and the first sync after midnight, the hours from that evening sync to midnight are in neither source. Reports close that gap: `useReportRange` reads the sync watermark (`analytics/sync:getSyncWatermark`) and passes `settledThroughDate(...)` to the plan, so until a sync whose watermark is past the start of today lands, yesterday reads live too (the split's `liveStartDate`). Overview, Operations and lead gen still plan through yesterday. A late change to an earlier day, such as last Tuesday's call marked held today, shows after the next sync.

## The engine (`convex/analytics/`)

| File | What it holds |
| --- | --- |
| `definition.ts` | `defineReport` and the report contract: filters, SQL, finalize, and the Convex reader it replaces |
| `definitions/*.ts` | One file per page, each with a parity test |
| `merge/*.ts` | One file per page: joins ClickHouse's answer for the days before today with the reader's answer from today. Pages import the merge functions at runtime, so a merge module imports server modules as types only |
| `registry.ts` | Every report; add a page's definitions here |
| `reports.ts` | `get` (the query pages subscribe to) and `request` (registers a key and runs it on a miss) |
| `results.ts` | The `analyticsResults` lifecycle (answers live in `analyticsPayloads`, in parts of up to 900 KB, so bookkeeping reads small rows), the optional daily budget, and finalize |
| `pool.ts` | `analyticsPool`, which runs what pages and API callers start, 2 at a time |
| `run.ts` | `runReport` and `runPostSyncBatch` |
| `runNode.ts` | The Node build path: reports with a `node` block fetch, build and save here |
| `sync.ts` | The heartbeat cron, the Fivetran `sync_end` webhook (`/analytics/fivetran`), and the stale-sync alert |
| `switch.ts`, `parity.ts` | CLI tools for switching pages and comparing sources on production |
| `api/` | The external API: keys, metrics, and `/api/v1` routes |

### Lifecycle of a key

1. A page opens a key with `request`. If no answer covers the current sync and period, `request` runs it on `analyticsPool`. The pool runs 2 at a time, so a page's panels and the batch stay within `magnus_app`'s 4 simultaneous queries. There's no daily limit unless `ANALYTICS_DAILY_RUN_BUDGET` sets one; past it, a tenant's new keys wait for the next batch (`queued`), and retries of a failing key count too. An open panel renews its key hourly.
2. After each sync, Fivetran calls `/analytics/fivetran`, and `runPostSyncBatch` reruns every key opened in the last 7 days, two at a time, while ClickHouse is awake.
3. `analyticsSync` is one row. A 5-minute heartbeat stamps it, and Fivetran copies it, so ClickHouse's copy is the watermark: the newest write the sync included. No page reads this table.

### The Node build path

Most reports aggregate in SQL and finalize inside the `complete` mutation, which takes at most 4M characters of rows and about a second of CPU. A report that returns raw rows to reuse its Convex reader's builder can outgrow that (People's role reports read 44-54M characters for a year of production data). Such a report sets `node` in its definition (`NodeBuild` in `definition.ts`):

- `context` reads the small Convex lookups the builder needs (directories, schedules, users) and returns plain JSON data, never a `Map`; `keys` names the IDs it needs from the rows. Without `keys`, the context loads before the SQL, and `sql(input, context)` can use it.
- `build` is pure: rows and context in, the reader's answer out.
- `finalize: nodeFinalize(node)` runs the same context and build in tests and `previewFinalize`, with the context sent through JSON as in production.

`runReport` sends these reports to `runNode.ts:finalizeInNode`: the rows stay in the Node action (512 MiB, up to 16M characters of ClickHouse response), and only the answer, split into parts, goes to `complete`. Each run logs `analytics.node_build` with its rows, answer bytes, time and peak memory. An answer may be up to 12 MB; past that, or past the rows budget, the key fails with "Choose a shorter range". A response that carries an `exception`, or fewer rows than it says, fails the run: ClickHouse answers 200 once rows are on the wire, so a limit hit after that would otherwise save part of the rows as the answer. Parity runs the same build without saving (`previewInNode`).

## The Reports pages (`convex/reports/`)

The rebuilt Reports area (plan: `docs/reviews/reports-overhaul.html`, decisions: `docs/reviews/reports-decisions.html`) is Scorecard, Calls, People with a member report, Attribution, Pipeline and Log. Its Convex readers live in `convex/reports/`, its definitions and merges under `convex/analytics/definitions/` and `merge/` (`scorecard`, `calls`, `people`, `peopleRoles`, `attribution`), and every label, formula and help line comes from the dictionary in `lib/reporting/definitions.ts`.

- Pipeline (`reports/pipeline:getPipelineNow`) and Log (`reports/log:listLog`, `listMemberLog`) are present tense and paginated, read from Convex only.
- A meeting's closer in a report is the closer at the time: the latest closer row in `dealAttributions` for that meeting, else `assignedCloserId` (`convex/reports/lib/callFacts.ts`). Reassignment rewrites `assignedCloserId` on every meeting of a deal, because access follows it.
- Credited cash counts each payment in full for every person credited in a role, once per person, from credit rows made on or before the payment; closer cash follows the payment's `attributedCloserId` (`convex/reports/lib/creditFacts.ts`). Distinct deal counts carry their IDs so a split's merge stays distinct.
- Money is per currency everywhere; nothing adds currencies.
- Admins read every page. A closer or lead generator reads only their own member report: `resolveMemberFilter` (`convex/reports/lib/access.ts`) forces the member to the viewer in every people and member query, and the roster stays admin-only.
- Export: the band's menu sends the document the page shows to `reports/export:renderReportFile` for Excel and PDF (the Operations renderers), builds the summary CSV in the browser (`lib/reporting/export.ts`), and asks `reports/rowsExport:exportRows` for every record behind the page.

## Adding a report

1. Split the Convex reader without changing behavior. The query keeps auth and the Convex load; the rest moves to an exported `build*` function (see `reporting/revenue.ts`).
2. Write a definition that returns the reader's exact type (`defineReport<typeof reader, Filters>`):
   - The SQL returns the rows the reader would load. `finalize` maps them with `docsFromRows` and calls the same builder.
   - For high-volume sources (captures, domain events) or a reader that reads an aggregate or bucket table, aggregate in SQL to the grain the builder needs.
3. Add a parity test with `expectSameAnswer` and `rowFromDoc` (`tests/analyticsParity.ts`).
4. Write the report's merge in `merge/<page>.ts` with the helpers in `merge/helpers.ts`: counts and sums add, rates are worked out again from their parts, lists keyed by an id combine, and current people and labels come from today's answer. Test it with `expectMergedAnswer` (`tests/analyticsMerge.ts`): merging the reader's answers for two adjacent windows must equal its answer for both.
5. Wire the page with `useAnalyticsReport` and `AnalyticsFreshnessLine`.

## Schedules and goals

- Schedules are dated. `leadGenWorkerSchedules`, `slackQualifierSchedules` and `dmCloserSchedules` hold one row per weekday per change, with `effectiveFrom` (a business date; unset means from the beginning). A save applies from today on, so every report reads each day under the schedule in force that day (`rowInForce`, `hoursOverDays` in `convex/lib/workSchedule.ts`), and past per-hour figures never move. Read rows per owner through `readScheduleRows` or `loadScheduleRowsByOwner` (`convex/workSchedules/`), and write them only through `writeDatedWeek`.
- Goals count the days someone works. A target is the daily goal times `goalDayCount`: the days in the range someone in the group is scheduled, or every day until anyone in it has hours. The qualified-leads group is every Slack qualifier with a schedule who isn't deleted; a booked-calls team's group is its active DM closers (`convex/workSchedules/goalDays.ts`). Answers carry it as `goalDayCount` (Qualifications `goal`, Booked Calls `goal.teams[i]`, the Slack qualifications report's `totals`; its periods' `goalDays`). A merge adds both windows' goal days and falls back to a window's day count when its cached answer predates them.

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
- Rows handed to `finalize` in the mutation are capped at 4M characters; a Node-built report gets 16M. An answer is capped at 12 MB, stored in parts of up to 900 KB.

## ClickHouse objects

- `clickhouse/migrations/*.sql` are applied with `pnpm ch:migrate` (admin credentials in the shell, never in Convex) or pasted into the SQL console. Views are `CREATE OR REPLACE`, so a file can be applied again.
- `clickhouse/admin/magnus_app.sql` creates the login Convex uses: read-only on `analytics.*`, 30-second queries, an hourly quota.
- `clickhouse/admin/unsynced_view_columns.sql` lists the columns the views still fill with NULL that Fivetran has since added. Run it now and then; replace each one it returns in a new migration.
- There is one ClickHouse service, and it holds production data, so run SQL right after a sync.

## Operating on production

The Convex CLI ignores `--prod` while `CONVEX_DEPLOY_KEY` is set, in the shell or in `.env.local`, and runs against the key's deployment. If `.env.local` holds a dev key, export the production deploy key in the shell before these commands. `pnpm analytics:parity` stops when the key is for the wrong deployment.

| Task | Command |
| --- | --- |
| Compare a page's sources (read-only) | `pnpm analytics:parity <page> --tenant <tenantId> [--range last_month] [--filters '{"fieldKey":"…"}']` (Leads needs a `fieldKey`, Overview's leaderboard a `kind`). A report whose Convex reader read only part of the range prints SKIP; the Reports readers cap at 300 calls and 512 KiB, so compare them at `yesterday` or a few days |
| Switch a page to ClickHouse | `npx convex run --prod analytics/switch:enable '{"tenantId":"…","page":"revenue"}'` |
| Roll a page back | `npx convex run --prod analytics/switch:disable '{"tenantId":"…","page":"revenue"}'` |
| Rerun the batch by hand | `npx convex run --prod analytics/run:runPostSyncBatch '{"force":true}'` |
| Limit the runs a tenant starts in 24 hours | `npx convex env set --prod ANALYTICS_DAILY_RUN_BUDGET 100` (`env remove` lifts it) |
| Stop every ClickHouse call | Remove `CLICKHOUSE_URL` from the production env |
| Preview the call-type backfill (read-only) | `npx convex run --prod reporting/callTypeBackfill:previewCallTypeBackfill` |
| Run the call-type backfill, then its assert | `npx convex run --prod migrations:run '{"fn":"migrations:backfillCallTypes"}'`, then `'{"fn":"migrations:assertCallTypes"}'` |
| Put back every type the backfill changed | `npx convex run --prod migrations:run '{"fn":"migrations:reverseCallTypeBackfill"}'` |
| Re-project moved slots (dry run first), then assert | `npx convex run --prod operations/movedSlotProjections:requeueMovedSlotProjections '{"tenantId":"…","dryRun":true}'`, then without `dryRun`, then `assertMovedSlotProjections '{"tenantId":"…"}'` once the projections drain |

| Before deploying a revert | `npx convex run --prod analytics/results:deleteMultipartResults` until `remaining` is false (see "Reverting the reports overhaul") |

To preview a page before it's switched, add `?analytics=preview` to its URL.

### Switching the Reports pages

The Reports pages (`scorecard`, `calls`, `people`, `attribution`) go live in this order, after the deploy:

1. The call-type backfill: preview, run, assert (above).
2. The moved-slot re-projection: dry run, run, assert once the projections drain.
3. A full Fivetran sync whose watermark is past both.
4. `pnpm analytics:parity <page>` at `yesterday` and a few short custom ranges. Longer ranges SKIP, since the readers cap there.
5. Open the page with `?analytics=preview` at Year to date and wait for it to finish: that runs the full production path (the Node build, the stored parts, `reports.get`). Check `analytics.node_build` in the logs for its rows, answer size and peak memory.
6. `analytics/switch:enable` for that page; the `people` switch moves all four People reports. Do one page at a time (calls, scorecard, attribution, people), and after each check `magnus_app`'s queries and execution seconds per hour in `system.query_log` against its quota (600 queries, 900 seconds).

### Reverting the reports overhaul

A page that shows a wrong number goes back to its Convex readers with `switch:disable`; fix forward from there. Reverting the code is a last resort, and a plain `git revert` won't deploy once the new code has written data: Convex checks every stored document against the schema, and the old schema rejects `resultId` on `analyticsPayloads`, `payloadPartIds` on `analyticsResults`, a `moved` meeting contribution, and the new page names in a tenant's `analyticsReports`. To revert:

1. `switch:disable` for `scorecard`, `calls`, `people` and `attribution`, then `deleteMultipartResults` until `remaining` is false. The old code reads only an answer's first part.
2. If the call-type backfill ran, `reverseCallTypeBackfill`.
3. Revert the commit, then restore this version of `convex/schema.ts`, `convex/analytics/schema.ts` and `convex/operations/meetingProjectionSchema.ts`. In `convex/operations/reports/readers.ts`, return a `moved` contribution's status as `canceled` (the type checker fails on that one line until you do).
4. Deploy, then request a projection for every canceled meeting that has a successor, so the old code writes those contributions as `canceled` again.

The schema can be narrowed later, once no document holds the new fields.

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
