# ClickHouse reporting layer

Status: built on branch `t3/clickhouse-reporting-layer-plan` (2026-10-28): the engine, the views, every page in Phase B and the API (Phase C). Nothing is deployed and no page is switched; §12.3 is the rollout. One change from the budget: answers live in a fourth table, `analyticsPayloads`, so the budget, batch and cleanup scans never read large payloads. Phases D (exports) and E (narrow) are still to do. Only production feeds ClickHouse, so every ClickHouse check runs on production, and each page ships dark behind a per-page switch (§12.1). CSV export limits are still to be agreed (§10).

Terms follow [`CONTEXT.md`](../../CONTEXT.md) and [ADR 0001](../adr/0001-lead-lifecycle-model.md). This file holds IDs, counts and table names only. It contains no personal data.

## 1. Summary

Every report page keeps its current layout and opens on **Today**. Today is read live from Convex. Every other range (Yesterday, This week, This month, Last month, Last 90 days, custom) is read from ClickHouse, which Fivetran fills from Convex every 6 hours, and is labelled "Data as of 14:31".

1. **Today in Convex, everything else in ClickHouse** (§4). There's no merging of the two. A range that includes today, such as This month, shows ClickHouse's data up to the last sync.
2. **ClickHouse wakes only when a sync wakes it** (§5). Fivetran already wakes the service four times a day. Convex hears that a sync ended from Fivetran, never by querying ClickHouse. It then runs one batch while the service is awake: it reads the watermark and recomputes every report key someone asked for in the last 7 days. Between syncs, report pages read cached results from Convex. The only other wake is a range nobody has asked for before.
3. **Today's queries are built to scale** (§6), after [Queries that scale](https://stack.convex.dev/queries-that-scale). Every read goes through an index over today's range, with the range passed as an argument so results are cached and shared. Low-volume tables use one query. Captures and domain events, the two high-volume ones, split into a closed-hours query that changes once an hour and a current-hour query that re-runs on each new row. No new counter tables.
4. **Convex aggregates stay only for current-state counts** (§6.4): deals by stage, open deal aging, the respark pool, and the billing queue. Nine of the 18 aggregate instances go, along with the meeting projection system and its workpool, the lead gen bucket tables, the dashboard snapshot path, and every backfill and verification flag that guards them (§11).
5. **Results are cached in a table we own** (§8), `analyticsResults`, keyed by the report, its arguments and the watermark. `@convex-dev/action-cache` can't be read from a query, doesn't deduplicate misses, and expires on a TTL instead of on a sync (§8.4).
6. **External API v1** (§9): read-only aggregate metrics, per-tenant API keys that owners and admins manage, served from the same cache, with today's numbers from Convex on request and a signed webhook after each sync.

## 2. Decisions (tenant admin, 2026-10-27)

| Question | Decision |
| --- | --- |
| Sync frequency | Stay at 6 hours for now |
| ClickHouse cost | Keep wake-ups to a minimum. The service is 8 GB RAM, 2 vCPU. |
| Report pages | Keep them as they are. Default every page to Today. Today reads Convex; every other range reads ClickHouse. |
| Date boundaries | The viewer's browser clock |
| Person names in ClickHouse | Allowed |
| CSV exports | Later, with hard limits to agree (§10) |
| Who manages API keys | Owners and admins |
| Where it's tested | On production. ClickHouse holds only production data (§12.1). |

## 3. Where things stand

### 3.1 Convex reporting today

About 11,000 lines across `convex/reporting/`, `convex/operations/` (meeting projections and `reports/`), `convex/leadGen/` (aggregates, rebuilds, report builders) and `convex/dashboard/` exist to answer report reads inside Convex limits:

- **18 aggregate instances** (`convex/convex.config.ts`), all namespaced by tenant. `paymentSums` has no reader.
- **Hand-kept bucket tables**: `operationsMeetingStatsV2` with `meetingProjections` and `opportunityProjectionJobs` behind the `reportingWorkpool`; `leadGenDailyStats`, `leadGenOriginStats` and `leadGenTeamOriginStats`. Each has its own business-day rebuild and readiness gate.
- **Verification flags** on `tenants` (`pipelineHealthAggregatesVerifiedAt`, `leadGenDealsAggregateVerifiedAt`, `activityEventCountsVerification`, …), set only after a backfill and an assert.
- **The report job system** (`convex/operations/reports/`, 27 files): any operations dashboard range over 7 days (`app/workspace/_components/dashboard-date-utils.ts:65`) becomes a job that pages through source rows in an action, reduces them, and stores result rows in `operationsReportRows`. Exports use the same path.
- **Caps that cut reports off**: Revenue reads the first 2,500 payments in range (`reporting/lib/helpers.ts:15`); outcomes, reminders and form answers stop at 2,000; actions per closer at 5,000; activity falls back to 10,000 events; lead gen ranges stop at 120 days.

The write side pays for all of this. A payment insert updates four billing trees and `paymentSums`. A meeting write updates `meetingsByStatus` and enqueues a projection job. `emitDomainEvent` inserts five `activityEventCounts` entries per event.

### 3.2 ClickHouse today

Checked 2026-10-25, read-only:

- ClickHouse Cloud 26.6, 8 GB RAM, 2 vCPU. Database `convex_app` holds 72 tables, one per Convex table, about 1.3 M rows in total (the largest, `domainevents`, has 203 K). Each Convex component is synced as its own database (`convex_activityeventcounts`, `convex_reportingworkpool`, …), and its B-tree nodes are useless for analysis.
- Every table is `SharedReplacingMergeTree(…, _fivetran_synced)`, ordered by `_id`. Rows stay duplicated until a merge, so `leads` reads 142,291 rows without `FINAL` and 93,547 with it. **Every read needs `FINAL`.**
- Column names are lowercased. Every number, timestamps included, is `Nullable(Float64)`. Objects and arrays arrive as JSON strings. Dropped Convex fields stay as columns (`opportunities.status`).
- None of the six largest tables has a `_fivetran_deleted = true` row, so whether Convex deletes arrive is unverified.
- Contact columns are synced: email, phone, handles, names, notes, and the raw Slack and webhook payloads.
- The connector is set to 360 minutes. It failed from 10-16 to 10-25 and was fixed on 10-25. The first clean sync ended at 10-26 02:33 UTC and took 404 s.
- There are no row policies, views or materialized views. `allow_nonconst_timezone_arguments = 0`, which doesn't matter here: the time zone is one constant per query (§7.2).
- One `FINAL` query timed out at 120 s while three others ran beside it. Run alone, it succeeded. Phase A1 measures latency warm, from idle and under concurrency.

### 3.3 Daily volumes

Business days 2026-09-26 to 2026-10-24:

| Rows per day | Average | Max |
| --- | --- | --- |
| `domainEvents` | 1,982 | 6,208 |
| `leadGenSubmissions` (captures) | 1,404 | 2,189 |
| `dealAttributions` | 191 | 244 |
| `opportunities` created | 73 | 108 |
| `slackQualificationEvents` | 59 | 76 |
| `meetings` by scheduled time | 39 | 64 |
| `paymentRecords` | 3.5 | 10 |

These numbers decide how each Today query reads (§6).

## 4. Which source answers a range

| Range | Source | Freshness shown |
| --- | --- | --- |
| Today (the default) | Convex, live | "Live" |
| Yesterday, This week, This month, Last month, Last 90 days, custom | ClickHouse, through the `analyticsResults` cache | "Data as of 14:31" (the watermark, in the viewer's time zone) |

- **Today** is the viewer's local day, from browser midnight to the next. The client computes the bounds and passes them as arguments.
- **Other ranges** run in the viewer's time zone and end at the earlier of the range end and the watermark. This month, opened at 16:00, shows data through the 14:31 sync. A late correction, such as last Tuesday's call marked held today, shows after the next sync.
- **Panels with no date range** keep their current source: stage distribution (Convex aggregate), open deal aging (Convex aggregate, so it agrees with the live stage counts beside it), stale deals list and reminder backlog (Convex work lists). Velocity, which covers deals from the last 90 days, reads ClickHouse as of the watermark.
- **Operational screens don't change**: work lists, queues, search, respark, the capture page, missed meetings, health and recovery, the billing queue, and the closer dashboard. Features that run on the business day (respark holds, Slack quotas, My day) keep it. Only the reports move to the browser clock.

## 5. Keeping ClickHouse asleep

The service runs only while something uses it, so this plan creates no reason to wake it beyond the syncs that already do.

| What touches ClickHouse | When | Wakes it? |
| --- | --- | --- |
| Fivetran sync | Every 6 hours, about 7 minutes | Yes, and it already does |
| Post-sync batch (§8.3) | Straight after each sync | No: the sync left it awake |
| A report or API range never requested before | On demand | Yes, rarely, and it shows a loading state |
| Freshness checks | Never: Convex asks Fivetran, not ClickHouse | No |
| Today views, cached ranges, crons | Never | No |

- **How Convex hears that a sync ended**: Fivetran's `sync_end` webhook, sent to a signed Convex HTTP route. If the webhook isn't on our Fivetran plan, a 5-minute Convex cron calls `GET https://api.fivetran.com/v1/connections/{id}` and compares `succeeded_at`. That's Fivetran's API, which costs nothing on ClickHouse.
- **Idle timeout**: set ClickHouse Cloud's idle timeout to its minimum (A1). The post-sync batch has to start within it, which the webhook ensures. The 5-minute poll may miss it and add one wake per sync.
- **Mart rebuilds**: none to start. Reports query views over the raw tables (§7.1). A mart rebuilt per sync is added only for a query that A1 measures over 2 s. It's rebuilt inside the post-sync batch, so it adds no wake.
- **On-demand misses**: a per-tenant budget of 30 uncached ClickHouse queries a day across the UI and the API. Past that, an uncached range waits for the next sync's batch and shows "Will be ready after the next refresh (~20:30)".
- **Optional: Convex starts the sync.** Fivetran's `POST /v1/connections/{id}/sync` lets a Convex cron trigger syncs at fixed times. A sync just after midnight in the team's time zone would make Yesterday complete at the start of the day. With today's schedule, the 08:30 UTC sync (02:30 Honduras) already does that. **(Later, if wanted.)**

## 6. Today in Convex

### 6.1 Rules for every Today query

These follow [Queries that scale](https://stack.convex.dev/queries-that-scale) and `docs/agents/convex.md`:

1. **Index ranges, no `.filter`.** Each read is `withIndex(…, q => q.eq("tenantId", t).gte(time, dayStart).lt(time, dayEnd))` on an index that already exists (`by_tenantId_and_scheduledAt`, `by_tenantId_and_createdAt`, `by_tenantId_and_recordedAt`, `by_tenantId_and_submittedAt`, `by_tenantId_and_occurredAt`, and the closer, worker, source and event type variants). A filter such as closer or program picks the index that starts with it.
2. **Bounded.** Each query has a hard cap above the worst day seen (meetings 500, events 10,000) and returns `partial: true` past it, as reports do now.
3. **Stable arguments.** The client sends `dayStartMs`, `dayEndMs` and, for split queries, `hourStartMs`. A small `useTodayWindow()` hook moves them at the hour and at midnight. Every viewer in a time zone sends the same arguments, so they share one cached result. No query reads `Date.now()`.
4. **One query per panel**, as the pages already do, so a new payment doesn't re-run the meetings panel.
5. **Joins by ID set.** Closer, team and program names come from one read of the tenant's users, team members or programs (capped at 300), not one read per row.

### 6.2 Low volume: one query

Meetings (~40 a day), payments (~4), Slack qualifications (~60), deals (~73), attributions (~190), follow-ups and respark items. A Today query reads the day's rows and computes the panel. It re-runs whenever one of those rows changes, which costs well under a thousand document reads.

### 6.3 High volume: closed hours and the current hour

Captures (~1,400 a day, 2,189 at most) and domain events (~2,000, 6,208 at most) arrive every few seconds during a shift. A single query over the whole day would re-read every row of the day on every new one.

Each of those panels runs two queries over the same index:

- **Closed hours**, `[dayStartMs, hourStartMs)`. Rows in past hours rarely change: captures and most events are inserted with the current time. A void (`voidedAt`) or an event dated in the past re-runs this query, and that stays correct. Otherwise the result stays cached until the hour turns. That's at most one full-day read an hour per time zone.
- **Current hour**, `[hourStartMs, dayEndMs)`. Up to about 100 captures or 300 events. It re-runs on each new row.

The client adds the two parts together with the report's own `merge` function (§8.1). Counts and sums add. A distinct count, such as unique prospects or distinct closers acting, returns its ID set from each part and the merge takes the union: at most a couple of thousand IDs a day.

**Lead gen unique credit.** Today, `leadGenDailyStats` decides at capture time which capture earns a worker the day's unique credit, and a void can move the credit. Once that rule is a pure function, the Today query applies it to the day's captures, ClickHouse mirrors it in SQL, and `leadGenDailyStats` retires. If the parity run (A4) finds a case the function can't reproduce from the captures alone, `leadGenDailyStats` stays as the Today source for that panel.

### 6.4 Aggregates and counters, the short answer

- **Keep a Convex aggregate** only where the count has no date range and someone works from it: `opportunityByStage` (Pipeline Health and the closer dashboard), `resparkPool`, `resparkTeamPool`, `resparkResultsByWorker`, and the four billing aggregates.
- **Today** doesn't need aggregates or sharded counters at these volumes. Index ranges, the hour split and cached arguments keep it cheap.
- **Revisit** if a high-volume stream grows about tenfold (over ~20,000 rows a day). Then the current-hour query gains an hourly counter, and that's the only part that changes.
- **Any range other than Today** is ClickHouse's job, so no full-history aggregate needs a backfill, an assert or a verification flag again.

## 7. ClickHouse side

### 7.1 Layers

All SQL lives in the repo under `clickhouse/`, as numbered migrations applied by `pnpm ch:migrate` (a small script over the HTTP interface that records applied files in `analytics._migrations`).

1. **Raw** (`convex_app`): Fivetran's tables. Only the views read them.
2. **Views** (`analytics.*`): one per Convex table that reports use, plus a few joined facts. Each reads `FINAL`, drops `_fivetran_deleted` rows, renames columns to snake_case, casts epoch-ms floats to `DateTime64(3, 'UTC')`, pulls out the JSON fields reports need with `JSONExtract*`, and leaves out dropped fields.

   | View | From | Grain |
   | --- | --- | --- |
   | `meetings` | meetings + deal + attributions | meeting |
   | `payments` | paymentRecords + deal | payment |
   | `deals` | opportunities | deal |
   | `attributions` | dealAttributions | attribution row |
   | `captures` | leadGenSubmissions + prospects | capture |
   | `events` | domainEvents | event |
   | `qualifications` | slackQualificationEvents | Slack submission |
   | `followups`, `respark_items`, `enrollments`, `form_answers` | one table each | row |
   | `person_stages` | leads (lifecycle JSON) | person × stage first reached |
   | `team_members`, `users`, `programs`, `teams` | | one row each |
   | `watermark` | `analyticsSync` (§8.2) | deployment |

3. **Marts**, only where needed: a table rebuilt in the post-sync batch (`INSERT INTO x__next SELECT …`, then `EXCHANGE TABLES`), for any view query that A1 measures over 2 s.

### 7.2 Time zones

The viewer's time zone is one constant per query, passed as a parameter (`{tz:String}`). Day, week and month grouping uses `toStartOfDay(ts, {tz:String})`, `toMonday(…)` and `toStartOfMonth(…)`, and range bounds are sent as UTC milliseconds the server works out from the viewer's dates and time zone. ClickHouse needs no calendar table and nothing to rebuild when the tenant's business day changes. A1 checks that a parameter is accepted as a time zone argument.

### 7.3 Access and tenant isolation

- **App user** `magnus_app`, role `analytics_reader`: `SELECT` on `analytics.*` only, with no access to `convex_app` or the component databases. If marts are added, a separate `magnus_etl` user writes them. The views are `SQL SECURITY DEFINER`, so the role needs no grant on the raw tables; by default ClickHouse checks the caller's access to a view's tables.
- **Settings profile**: `readonly = 2`, `max_execution_time = 30`, `max_result_rows = 200000`, `max_memory_usage` 2 GB, `max_concurrent_queries_for_user = 4`. Plus an hourly quota.
- **Tenant from auth only.** Convex sends the tenant as a query parameter (`{tenant_id:String}`). Templates live in code, and no value is ever interpolated into SQL. A unit test fails any template that reads a view without a `tenant_id = {tenant_id:String}` predicate.
- **Row policy as a second guard**: `USING tenant_id = getSetting('SQL_tenant_id')` on each view's base tables, sent as a custom setting with every query. A1 checks that ClickHouse accepts it and that it still applies through a `DEFINER` view, which runs as its definer. If it doesn't, the template test is the guard.
- **Secrets**: `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` and `FIVETRAN_WEBHOOK_SECRET` go in Convex env (three more, for Fivetran's API, only if the webhook isn't on our plan) and are declared in `convex.config.ts`. Convex egress has no fixed IP, so the guards are a long random password, TLS, the read-only role and the quota.

### 7.4 Fivetran hygiene

- **Block** the component databases (aggregates and workpools), the job and staging tables (`operationsReportRows`, `operationsReportCheckpoints`, `opportunityProjectionJobs`, `meetingProjections`), and the raw payload tables (`rawSlackEvents`, `rawWebhookEvents`, `webhookDeliveries`).
- **Block or hash** email, phone, social handles, `searchText` and `customFields` on leads and customers, `leadNotes`, and `linkPortalLeadEdits`. **Person names stay** (decision, §2), as do team member and user names.
- **New Convex tables** sync on their own unless the connector blocks them. Before A2 deploys, set new tables to blocked, then allow `analyticsSync`. `analyticsResults` and `apiKeys` never sync.
- **Values already synced.** Blocking or hashing a column stops new values. A1 checks whether the plain values already in ClickHouse stay, and whether hashing a synced column re-syncs its table. Any that stay get dropped by hand.
- **Confirm deletes** (A1): delete a test row in Convex and check whether the next sync marks `_fivetran_deleted`. The daily cleanup crons and deal deletions in merges depend on it.

## 8. The report engine

### 8.1 Modules

`convex/analytics/`:

- `clickhouse.ts`: `queryClickHouse(template, params)` over the HTTP interface with `fetch` (default runtime), JSON output, a timeout, and `log`/`reportError` on failure.
- `definitions/<report>.ts`: one file per report, with:
  - `today(ctx, args, window)`: the Convex read (§6), which may return closed-hour and current-hour parts
  - `sql`: the ClickHouse template, computing every preset in one query through `arrayJoin` over the preset bounds
  - `merge` and `finalize`: rates, sorting and top N

  Both sources produce the same output shape, so the page components don't change. The external API reads the same registry.
- `results.ts`: the `analyticsResults` table and its functions.
- `sync.ts`: the heartbeat, the Fivetran webhook, the post-sync batch, and `analyticsSync`.
- `parity.ts`: `run`, an internal action that compares a report's current reader with its new path over the same ranges and returns each difference. It only reads (§12.1).
- `switch.ts`: `enable` and `disable`, internal mutations that add or remove a report id in `tenants.analyticsReports`.
- `app/workspace/_components/use-report.ts`: picks the source from the tenant's switch and the range, and shows the freshness line and loading states. A page that isn't switched keeps its current reader, unless the URL has `?analytics=preview`.

### 8.2 Watermark

`analyticsSync` is one row. A 5-minute Convex cron patches its `beatAt`. No page or query reads the row, so the heartbeat re-runs nothing. After a sync, its value in ClickHouse is the newest write the sync included, which assumes a sync is a consistent snapshot (A1 checks). If it isn't, the watermark is the heartbeat minus 30 minutes. The post-sync batch reads it while ClickHouse is awake and writes `watermark`, `lastSyncEndedAt` and `lastBatchAt` back to the same row. Pages show the watermark stored on each answer, and the delayed banner when that is more than 8 hours old. Nothing else reads ClickHouse for freshness.

If `lastSyncEndedAt` is more than 8 hours old, the cron reports `analytics.sync_stale` to PostHog, and pages show "Reporting data is delayed since …". The 10-16 to 10-25 failure would have shown on its first day.

### 8.3 Read path, batch and misses

`analyticsResults`: `tenantId`, `reportId`, `argsKey` (filters, preset or custom dates, and time zone; never millisecond bounds, so the key stays stable across days), `watermark`, `status` (`pending`, `ready`, `failed`), `payload`, `requestedAt`, `completedAt`, `lastRequestedAt`. Indexed by `["tenantId", "reportId", "argsKey", "watermark"]`.

1. **Read.** A non-Today range calls `useQuery(api.analytics.reports.get, { reportId, args })`. The query checks auth and permission and returns the newest `ready` result for the key. If that result predates the current watermark, it's still shown, with "refreshing".
2. **Miss.** If no result exists, the client calls `api.analytics.reports.request` (a mutation). It records `lastRequestedAt`, inserts a `pending` row unless one exists (that deduplicates concurrent misses), checks the daily budget (§5), and schedules `runReport`. The reactive query shows the result when it lands. A cold start can take tens of seconds, so the panel says "Loading from the reporting database…".
3. **Post-sync batch** (`runPostSyncBatch`, started by the webhook or the poll): read the watermark, rebuild any marts, then run `runReport` for every key requested in the last 7 days, two at a time, capped at 300 keys per tenant. Each preset key is recomputed for the new watermark ("This month" now ends at the new watermark). At current volumes that's a few dozen queries, a minute or two of the time ClickHouse is awake anyway. The API's `analytics.refreshed` webhook goes out at the end.
4. **Cleanup.** A daily cron deletes results older than the previous watermark, and keys unrequested for 14 days.

### 8.4 Why not `@convex-dev/action-cache`

Checked against its README on 2026-10-25:

- `fetch` runs from actions only. A page couldn't read the cache reactively.
- Concurrent misses aren't deduplicated: competing requests "may race to all run the action".
- Entries expire by a TTL set per cache. Here a result goes stale when a sync lands, not after a fixed time.

The batch, the dedupe, the budget and showing the last result while it refreshes all need a table we can query. `analyticsResults` is that table.

## 9. External API

### 9.1 Shape

- **Host**: Convex HTTP actions under `/api/v1/*` in `convex/http.ts`, optionally rewritten from the app domain in `next.config.ts`.
- **Endpoints, v1:**
  - `GET /api/v1/metrics?metrics=…&from=YYYY-MM-DD&to=YYYY-MM-DD&tz=America/Tegucigalpa&granularity=day|week|month|total&group_by=none|closer|team|program|lead_generator`
  - `GET /api/v1/today?metrics=…&tz=…&group_by=…`: live, from the same Convex Today queries as the UI
  - `GET /api/v1/funnel?from&to&tz`: captured, qualified, booked, held, won
  - `GET /api/v1/dimensions/{team-members|teams|programs}`: IDs and display names for `group_by`
  - `GET /api/v1/freshness`
- **Metric catalog v1**, from the same definitions as the screens, so the numbers match the CRM: `leads_captured`, `unique_prospects`, `resparks`, `qualifications`, `new_qualified_people`, `calls_booked`, `calls_scheduled`, `calls_held`, `no_shows`, `cancellations`, `show_rate`, `deals_won`, `close_rate`, `cash_collected` (per currency), `deposits`, `average_deal_size`. Adrian's list will extend or trim it.
- **Response**:

  ```json
  { "data": [ … ],
    "meta": { "as_of": "2026-10-27T14:31:00Z", "source": "warehouse",
              "next_expected_refresh": "2026-10-27T20:30:00Z" } }
  ```

  `/today` returns `"source": "live"`. Responses carry an `ETag` (a hash of the watermark and the arguments) and `Cache-Control: private, max-age=300`.
- **Cost**: `/metrics` reads `analyticsResults`. A miss counts against the same daily budget as the UI (§5). It waits up to 25 s, then returns `202` with `Retry-After`, and the result lands in the cache. The post-sync batch recomputes keys the API asked for, so a dashboard that pulls after each `analytics.refreshed` webhook never wakes ClickHouse.
- **Push**: an optional webhook per key, `analytics.refreshed`, signed with HMAC-SHA256 over the timestamp and body.
- An OpenAPI 3.1 spec lives in the repo and defines every metric in plain words.

### 9.2 Security

- **Keys**: `mgn_live_<keyId>_<secret>`, where the secret is 32 random bytes in base62. Table `apiKeys` stores `tenantId`, `keyId`, `SHA-256(secret)` (the secret is random, so it needs no pepper), `scopes`, `name`, `createdByUserId`, `createdAt`, `expiresAt` (optional), `lastUsedAt` and `revokedAt`. The secret is shown once. Lookup is by `keyId`, then a constant-time compare. A revocation takes effect on the next request.
- **Who**: `settings:manage`, which `tenant_master` and `tenant_admin` already hold, on an API keys card in Settings › Integrations. The tenant always comes from the key.
- **Scopes**: `metrics:read` only in v1. Row-level access would be a later scope with its own review.
- **No personal data in v1**: aggregates and team member display names only.
- **Limits**: 60 requests a minute per key, counted on the key's own row the way `linkPortal/rateLimitMutations.ts` counts portal logins. Ranges up to 731 days, capped `group_by` cardinality, and no free-form SQL.
- **Audit**: `lastUsedAt` on the key, plus `api.request` server events to PostHog. Failed lookups are rate-limited per IP prefix.
- **Rejected**: giving the stakeholder a ClickHouse login. It would tie them to our schema, expose SQL, wake the service on their schedule, and couldn't be revoked per tenant without new row policies.

## 10. Exports

Exports stay as they are until their hard limits are agreed. They keep using the report job system, so the bucket tables they read stay until exports move (§11).

Questions for that discussion:
- maximum rows per file
- maximum range
- exports per user per day
- whether raw exports with person names need an extra permission
- whether exports move to ClickHouse, where a raw CSV can stream from `FORMAT CSVWithNames` in the post-sync window

## 11. What gets deleted

After each reader has moved, in Phase E:

| Item | Read by today | What it costs on writes |
| --- | --- | --- |
| `paymentSums` | Nothing | Every payment. Goes now (PR 0). |
| `meetingsByStatus` | Team Performance | Every meeting write |
| `personLosses` | Pipeline Health | Opportunity writes |
| `slackQualificationsByUser`, `slackQualificationsByTime` | Overview, Slack report | Opportunity writes |
| `activityEventCounts` and its verification | Activity summary | 5 inserts per domain event |
| `prospectConversions`, `leadGenDealsByWorker` | Prospect conversion | Capture, lifecycle, merge and attribution writes |
| `leadStageEntries` | Leads report, `leads/lifecycleChecks.ts` | Lifecycle writes. Goes if the check reads another way. Today's new leads come from `lead.lifecycle_stage_changed` events. |
| `operationsMeetingStatsV2`, `meetingProjections`, `opportunityProjectionJobs`, `reportingWorkpool`, the `reporting-work-health` cron, `meetingProjectionVersion` | Ops dashboards, Overview, exports | A workpool job per meeting write, deal re-projection sweeps |
| `leadGenDailyStats`, `leadGenOriginStats`, `leadGenTeamOriginStats`, the lead gen business-day rebuild | Lead gen reports, My day, exports | Capture and void writes. `leadGenDailyStats` goes only if the unique-credit parity holds (§6.3). |
| The snapshot purpose of report jobs, `operationsReportRows`, `operationsReportCheckpoints`, reducers | Ranges over 7 days | |
| `reporting/backfill.ts`, `reporting/verification.ts`, `pipelineHealthVerification.ts`, the verification fields on `tenants` | Gates | |
| `tenants.analyticsReports`, `?analytics=preview`, `analytics/parity.ts`, `analytics/switch.ts` | Every page during the move | Nothing. The field is unset on the tenant before it leaves the schema. |

Kept: `opportunityByStage`, `openDealAging`, `resparkPool`, `resparkTeamPool`, `resparkResultsByWorker`, and the four billing aggregates.

The tables that exports read (`operationsMeetingStatsV2`, the lead gen buckets) go after exports move. Removals follow `convex-migration-helper`: stop writing, deploy, then unmount the component or drop the table. Whether unmounting an aggregate deletes its data gets checked before the first one.

## 12. Phases and PRs

Each PR is safe to deploy alone. A page's port keeps the old reader until the narrow. The page moves to the new path only when its report id is added to `tenants.analyticsReports`, after its parity run on production passes.

### 12.1 Testing on production

Fivetran syncs only the production deployment, so ClickHouse holds only production data, and the dev tenant's IDs aren't in it. Every check that touches ClickHouse runs on production.

- **Dev and CI cover the rest.** CI runs the engine tests with a mocked ClickHouse `fetch`, the template tests, the Today queries in `convex-test`, and the HTTP routes. Dev runs the Today queries and the API keys card on dev data. Dev has no `CLICKHOUSE_URL`, so the engine there marks answers `failed` with "not configured". Dev never gets a production ClickHouse login.
- **Every PR deploys dark.** Until a page is switched, the only change its users see is the Today default, which works on the old readers too. A page's new path, its Today queries included, runs only when its report id is in `tenants.analyticsReports`, or when the URL has `?analytics=preview`. The preview keeps the page's role checks and counts against the daily budget.
- **Additive until the narrow.** New ClickHouse objects live in `analytics`, and nothing writes to `convex_app`. Convex gets three new tables and one optional field. Only the switch writes to an existing table (`tenants`), nothing needs a backfill, and nothing is deleted before Phase E.
- **A page switches in three steps**, right after a sync while ClickHouse is awake:
  1. `pnpm analytics:parity <reportId>` runs `npx convex run --prod analytics/parity:run` for today (Convex against Convex, no ClickHouse), yesterday, last month and last 90 days, and prints each difference with its reason.
  2. Open the page on production with `?analytics=preview` and check each range, the freshness line and the loading states.
  3. `npx convex run --prod analytics/switch:enable '{"tenantId":"…","reportId":"revenue"}'`. Open pages switch without a reload.
- **Rollback needs no deploy.** `analytics/switch:disable` puts a page back on its old reader at once. Removing `CLICKHOUSE_URL` from the production env stops every ClickHouse call, the post-sync batch included.
- **Tests cost wake-ups.** Migrations, parity runs, latency checks and SQL drafted through the ClickHouse MCP each wake the service if it's asleep. Do them in the minutes after a sync ends (`analyticsSync.lastSyncEndedAt`, or the Fivetran dashboard before A2), grouped into one session a day. A1's from-idle timings are the only deliberate wakes.
- **Watch each switch**: Convex insights for the Today queries' reads and `partial: true` hits; PostHog for `analytics.report_failed`, `analytics.batch_failed` and `analytics.sync_stale`; ClickHouse's `system.query_log` for any query outside a sync window or a parity session.
- **The narrow waits.** A page's old reader, and the aggregates only it reads, go two weeks after its switch if it hasn't been rolled back. Unmount each component on dev first to see whether its data goes with it. On production, dropping one can only be undone with a backfill.

### 12.2 PRs

**PR 0. Drop `paymentSums`.** It has no reader.

**Phase A. Foundations**

- **A1. Measure and configure** (config and SQL, no app change):
  - ClickHouse latency: p50 and p95 of five representative queries warm, from idle, and two at a time, in one session. Set the idle timeout to its minimum. Check that a time zone parameter works, that a `SQL SECURITY DEFINER` view keeps the raw tables from `magnus_app`, and that a row policy with a custom setting applies through it.
  - Fivetran: apply the blocks (§7.4), set new tables to blocked and allow `analyticsSync`, check deletes and snapshot consistency, and check what happens to values already synced in a column you block or hash. Find out whether webhooks are on the plan.
- **A2. Convex sync plumbing**: `analyticsSync` and its heartbeat cron, the Fivetran webhook route, the stale alert, env vars, and `clickhouse.ts`. Set the env vars on production before it deploys. The route must ignore Fivetran's test event, and the first real sync must stamp `lastSyncEndedAt` (`npx convex data analyticsSync --prod`).
- **A3. ClickHouse views**: the `clickhouse/` migrations, `pnpm ch:migrate`, the views, the user, role, profile and quota. Applied to production ClickHouse right after a sync, before the PR merges. `DROP DATABASE analytics` undoes all of it.
- **A4. Engine**: `analyticsResults`, `reports.get` and `reports.request`, `runReport`, the post-sync batch, the budget, cleanup, `useReport` with the freshness line and loading states, `useTodayWindow`, the template tenant test, `tenants.analyticsReports` with `analytics/switch`, the `?analytics=preview` override, and `pnpm analytics:parity <reportId>` (§12.1). With no page switched, the batch has no keys to rerun, so the first syncs after deploy only read the watermark.

**Phase B. One page per PR.** Each PR rewrites the page's Today queries (§6), adds its ClickHouse template, defaults the page to Today, and deploys dark. Parity, the preview and the switch then follow §12.1. In order:

1. Revenue (removes the 2,500 cap)
2. Team Performance
3. Ops Sales Calls and Overview phone operations
4. Ops Booked Calls, Ops Qualifications, Overview qualifiers and DM closers, and the Slack Qualifications report
5. Ops Lead Gen, Overview lead gen and origins, My Activity, prospect conversion, and respark performance
6. Activity summary
7. Pipeline Health, Leads & Conversions, and Reminders
8. Remove the snapshot path for ranges over 7 days, once every operations page is switched

Parity differences that come from today's caps or the switch to browser-clock days are expected and noted on the page's PR. Any other difference blocks the switch, and its fix ships as its own PR before the next run.

**Phase C. External API v1** (§9). Needs A4 and the metrics from B1 to B4. It can run alongside B5 to B8 once Adrian's metric list arrives. `/metrics` serves only metrics whose report is switched for the key's tenant. Test with a key of your own on production and revoke it before Adrian gets his.

**Phase D. Exports** (§10), after the limits are agreed.

**Phase E. Narrow** (§11), each piece two weeks after the last switch it depends on, then the docs:
- a new `docs/agents/analytics.md` covering the engine, adding a report, templates, the Today rules and the tenant rule
- "Write side effects" in `docs/agents/convex.md` without the retired hooks
- the topic list in `AGENTS.md`
- ADR 0002 for "Today in Convex, the rest in ClickHouse" and the watermark

### 12.3 Rollout runbook

In this order. Production is `usable-guineapig-697`; its HTTP actions are at `https://usable-guineapig-697.convex.site`.

1. **Fivetran, before the deploy.**
   - Set the Convex connector's schema change handling to "Allow columns". New tables then arrive blocked, while new columns on synced tables still sync, which the views' NULL placeholders rely on.
   - Block the component databases, the projection and job tables, and the raw payload tables (§7.4).
2. **Deploy the branch.** The ClickHouse env vars are optional, so the deploy works without them. The first heartbeat creates `analyticsSync`.
3. **Fivetran, after the deploy.**
   - Enable the new `analyticsSync` table.
   - Keep `analyticsResults` and `apiKeys` blocked.
   - Let the next sync run, or start one.
4. **ClickHouse, right after that sync.** In the SQL console as the admin user, or with `pnpm ch:migrate`:
   1. `clickhouse/migrations/0001_analytics_database.sql`
   2. `0002_views.sql`
   3. `0003_watermark.sql`, which needs `convex_app.analyticssync`
   4. `clickhouse/admin/magnus_app.sql`, with a new password
   5. Set the service's idle timeout to its minimum.
   6. Now and then, run `clickhouse/admin/unsynced_view_columns.sql`; each row is a column to replace in the views (the first capture void, for example).
5. **Convex production env.** Set `CLICKHOUSE_URL`, `CLICKHOUSE_USER` (`magnus_app`), `CLICKHOUSE_PASSWORD` and `FIVETRAN_WEBHOOK_SECRET`.
6. **The Fivetran webhook.** Point a `sync_end` webhook at `/analytics/fivetran` with the same secret. Fivetran's test delivery logs `analytics.fivetran.test_received`. After the next real sync, `npx convex data analyticsSync --prod` shows `lastSyncEndedAt`, `watermark` and `lastBatchAt`.
7. **Each page:**
   1. Run `pnpm analytics:parity <page>` after a sync.
   2. Open the page with `?analytics=preview`.
   3. Run `analytics/switch:enable`.
   4. Watch the signals in §12.1.
   Expected parity differences: the readers' caps (2,500 payments, 1,000 Slack events, 500 bucket rows, 120 days), the answer distribution's first-2,500-responses window, ties ordered differently, and the 2026-05-25 team-origin bucket the write path never filled.
8. **API.**
   1. Create a key on Settings › Integrations and call `/api/v1/freshness` and `/api/v1/metrics` with it.
   2. Revoke it.
   3. Send Adrian a key and `docs/api/openapi.yaml`.

## 13. Still open

1. **Export limits** (§10).
2. **Half-hour time zones.** The hour split in §6.3 assumes whole-hour offsets. Every user today is in one. A viewer in a half-hour zone would get a correct but uncached closed-hours query. Fine unless that changes.
3. **Ranges that include today.** They show ClickHouse data up to the last sync, as decided. Adding Convex's Today to them later is possible, because every metric that adds is already split into a `today` and a `sql` part.
4. **Who starts syncs.** Keep Fivetran's 6-hour schedule, or let Convex trigger syncs at fixed local times (§5).
