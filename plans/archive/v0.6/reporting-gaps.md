# v0.6 Reporting Gaps Audit

**Date:** 2026-04-13  
**Scope audited:** `plans/v0.6/*`, `convex/reporting/*`, reporting pages under `app/workspace/reports/*`, and the closer meeting UI/time-tracking path.

## Bottom line

The overrun / meeting-time work was **not ignored entirely**, but it was **never carried through to delivery**.

- The design and KPI catalog explicitly require Tier 3 meeting-time KPIs, including overrun statistics: `plans/v0.6/reporting-design.md:37-47`, `plans/v0.6/version-06-reporting-feature.md:1468-1480`.
- The backend time-tracking mutations were built: `convex/closer/meetingActions.ts:86-245`.
- The reporting layer never consumes those fields, and the closer UI never calls the new mutations:
  - Team reporting only counts status buckets and payment metrics: `convex/reporting/teamPerformance.ts:15-246`
  - The team report page only renders 4 summary cards plus two basic tables: `app/workspace/reports/team/_components/team-report-page-client.tsx:32-73`
  - The closer meeting action bar exposes `startMeeting`, but no `stopMeeting` or `setLateStartReason`: `app/workspace/closer/meetings/_components/outcome-action-bar.tsx:95-223`

**Conclusion:** overrun reporting was partially implemented at the data-model / mutation level, then effectively dropped from the UI and reporting read side.

## Where the plan drift happened

There is a clear mismatch between the top-level v0.6 design and the phase execution docs:

- The design says v0.6 should ship **42 KPIs across 5 tiers** and explicitly includes meeting time tracking: `plans/v0.6/reporting-design.md:37-47`.
- The feature spec says all Tier 1, Tier 2, Tier 3, and Tier 4 KPIs should ship in v0.6: `plans/v0.6/version-06-reporting-feature.md:1428-1494`.
- Phase 3 acceptance criteria were narrowed to a much smaller query set and do **not** require Tier 2 / Tier 3 team metrics, lead-conversion supplements, or form-response rate/top-answer metrics: `plans/v0.6/phases/phase3.md:14-25`.
- Phase 5 acceptance criteria were narrowed again to a minimal UI surface:
  - Team page: only 4 summary cards + two basic tables
  - Leads page: only 3 KPI cards + by-closer table + answer distribution
  - Activity page: only by-source cards + filters + feed
  `plans/v0.6/phases/phase5.md:18-28`
- Phase 6 still expects the broader behavior, including End Meeting and late-start UX: `plans/v0.6/phases/phase6.md:13-25`.

**Assessment:** the overrun KPI gap is both an implementation gap and a planning gap. The detailed phase docs stopped aiming at the full 42-KPI scope, even though the top-level design never removed it.

## Confirmed gaps

### 1. Tier 3 meeting-time KPIs are absent from reports

Promised KPIs:

- On-Time Start Rate
- Avg Late Start Duration
- Overran Rate
- Avg Overrun Duration
- Avg Actual Meeting Duration
- Schedule Adherence
- Late Start Reasons

Source of promise: `plans/v0.6/version-06-reporting-feature.md:1468-1480`

What exists:

- `startMeeting`, `setLateStartReason`, and `stopMeeting` write `startedAt`, `lateStartDurationMs`, `lateStartReason`, `stoppedAt`, and `overranDurationMs`: `convex/closer/meetingActions.ts:111-245`

What is missing:

- No reporting query computes any Tier 3 metric. `convex/reporting/teamPerformance.ts:15-246` only counts statuses and attributes payments.
- No reporting page renders any Tier 3 section. `app/workspace/reports/team/_components/team-report-page-client.tsx:32-73`
- No reporting helper reads these fields anywhere under `convex/reporting/*`.

Impact:

- Overrun stats do not exist in the reports today.
- Even if the backend fields are present in documents, admins have no read path for them.

### 2. The time-tracking data capture UX is incomplete

Phase 2 explicitly required:

- an **End Meeting** button
- a **late-start prompt/dialog**

Source: `plans/v0.6/phases/phase2.md:15-25`, `plans/v0.6/phases/phase2.md:683-760`

What exists:

- `stopMeeting` and `setLateStartReason` mutations: `convex/closer/meetingActions.ts:161-245`

What is missing:

- No client component calls `api.closer.meetingActions.stopMeeting`
- No client component calls `api.closer.meetingActions.setLateStartReason`
- The current action bar only offers Start Meeting, Log Payment, Schedule Follow-up, Mark No-Show, and Mark as Lost: `app/workspace/closer/meetings/_components/outcome-action-bar.tsx:150-223`

Impact:

- The normal closer workflow does not populate overrun or late-start-reason data.
- Tier 3 reporting cannot become trustworthy until this UI gap is closed.

### 3. Team Performance only delivers a subset of the promised team KPIs

Tier 1 promised all of the following per closer and at team level:

- Booked Calls
- Cancelled Calls
- No Shows
- Calls Showed
- Show Up Rate
- Sales
- Cash Collected
- Close Rate
- Avg Cash Collected

Source: `plans/v0.6/version-06-reporting-feature.md:1428-1444`

What exists:

- The query does compute `sales`, `cashCollectedMinor`, `closeRate`, and `avgCashCollectedMinor`: `convex/reporting/teamPerformance.ts:168-180`, `219-245`

What is missing in the UI:

- The per-closer table only renders `Booked`, `Canceled`, `No Shows`, `Showed`, and `Show-Up Rate`: `app/workspace/reports/team/_components/closer-performance-table.tsx:105-156`
- The summary cards render only `Total Booked`, `Show-Up Rate`, `Cash Collected`, and `Close Rate`: `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx:56-135`
- `Avg Cash Collected` is computed but not displayed anywhere on the page.
- `Sales` is not surfaced as its own KPI; it only appears as supporting text inside other cards.

Impact:

- Even the direct Excel replacement is only partially surfaced in the Team Performance UI.

### 4. Team Performance is also missing the promised Tier 2 analytics

Promised on the team page:

- Lost Deals
- DQ Rate
- Rebook Rate
- Meeting Outcome Distribution
- Actions per Closer (daily avg)

Source: `plans/v0.6/version-06-reporting-feature.md:1446-1466`

What exists:

- A helper for derived outcomes exists: `convex/reporting/lib/outcomeDerivation.ts:3-60`

What is missing:

- That helper is not used anywhere in the reporting codebase.
- `convex/reporting/teamPerformance.ts:15-246` does not compute any of those KPIs.
- The Team Performance UI has no outcome chart or team-activity section: `app/workspace/reports/team/_components/team-report-page-client.tsx:32-73`

Impact:

- Team reporting currently ships only the narrow status-count view, not the richer analytics described in the v0.6 design.

### 5. Leads & Conversions is missing 4 planned KPIs

Promised Tier 4 KPIs beyond the current three headline metrics:

- Avg Meetings per Sale
- Avg Time to Conversion
- Form Response Rate
- Top Answer per Field

Source: `plans/v0.6/version-06-reporting-feature.md:1482-1494`

What exists:

- `getLeadConversionMetrics` returns only `newLeads`, `totalConversions`, `conversionRate`, `byCloser`, and truncation diagnostics: `convex/reporting/leadConversion.ts:14-93`
- Form analytics currently exposes only field catalog + answer distribution for a selected field: `convex/reporting/formResponseAnalytics.ts:10-135`
- The page renders only 3 KPI cards, by-closer conversions, and the form insights selector/distribution: `app/workspace/reports/leads/_components/leads-report-page-client.tsx:38-69`, `app/workspace/reports/leads/_components/form-response-analytics-section.tsx:47-98`

Impact:

- Leads reporting is materially short of the KPI catalog, especially around conversion efficiency and form-response completeness.

### 6. Activity Feed is missing part of the promised analytics surface

Promised activity KPIs:

- Actions per Closer (daily avg)
- Activity by Source
- Activity by Entity
- Most Active Closer

Source: `plans/v0.6/version-06-reporting-feature.md:1463-1466`

What exists:

- The backend summary does return `bySource`, `byEntity`, and `actorBreakdown`: `convex/reporting/activityFeed.ts:161-225`

What is missing:

- The page only renders by-source summary cards: `app/workspace/reports/activity/_components/activity-summary-cards.tsx:11-63`
- `actorBreakdown` is only used to populate the actor filter, not to present “most active closer”: `app/workspace/reports/activity/_components/activity-feed-page-client.tsx:109-123`
- There is no computation for “actions per closer (daily avg)” anywhere in `convex/reporting/activityFeed.ts`

Impact:

- The activity report delivers the audit trail itself, but not the full activity analytics promised in the KPI catalog.

### 7. Pipeline Health does not expose a true stale pipeline count

Promised KPI:

- Stale Pipeline Count

Source: `plans/v0.6/version-06-reporting-feature.md:1461-1463`

What exists:

- The backend builds a stale-candidate set but only returns the top 20 rows: `convex/reporting/pipelineHealth.ts:25-28`, `138-180`
- The page renders that list only: `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx:53-63`, `app/workspace/reports/pipeline/_components/stale-pipeline-list.tsx:42-98`

What is missing:

- No total stale count is returned.
- Because the list is sliced to 20, `staleOpps.length` is not a reliable KPI.

Impact:

- The page can show examples of stale opportunities, but not the promised stale-count metric.

### 8. Custom date-range selection is off by one day at the end boundary

The shared control stores the custom range end as `range.to.getTime()`: `app/workspace/reports/_components/report-date-controls.tsx:123-129`

But reporting queries consistently treat `endDate` as an **exclusive** upper bound, for example:

- `convex/reporting/leadConversion.ts:32-37`
- `convex/reporting/activityFeed.ts:99-125`, `183-187`
- `convex/reporting/formResponseAnalytics.ts:91-99`

Impact:

- If a user selects a custom range like April 1 to April 30, the effective upper bound becomes midnight at the start of April 30, so most or all of April 30 is excluded.
- This affects every report that uses `ReportDateControls`.

## What does look implemented

These areas do **not** appear to be the missing piece:

- Live form-response write path is wired into all three booking creation paths:
  - helper exists: `convex/pipeline/inviteeCreated.ts:63-83`
  - call sites: `convex/pipeline/inviteeCreated.ts:1219-1228`, `1480-1489`, `1692-1700`
  - writer implementation: `convex/lib/meetingFormResponses.ts:154-260`
- Aggregate/backfill verification exists for the five reporting aggregates: `convex/reporting/verification.ts:54-123`

So the main v0.6 reporting gaps are not around form-response ingestion or aggregate registration; they are primarily around **team KPI scope**, **time-tracking delivery**, and **UI/query drift from the original plan**.

## Recommended next steps

1. Decide whether v0.6 still means the original **42 KPI** promise. If yes, the phase docs should be updated back into alignment with the design before more implementation starts.
2. Finish Phase 2F for real:
   - add End Meeting UI
   - add late-start prompt / reason capture
3. Extend Team Performance reporting to include:
   - Tier 2 derived outcomes
   - Tier 3 meeting-time KPIs
   - missing Tier 1 presentation (`Avg Cash Collected`, explicit `Sales`)
4. Extend Leads / Activity / Pipeline reports to close the missing KPI gaps listed above.
5. Fix `ReportDateControls` so custom end dates use end-of-day semantics before feeding exclusive-upper-bound queries.

## Answer to the original question

For overrun meeting statistics specifically: **we did not ignore the concept entirely, but we did ignore the final delivery path**.

- The backend work was started and merged.
- The closer UI to capture the data was not finished.
- The reporting queries/pages never implemented the KPI.
- The phase docs themselves drifted away from the original 42-KPI scope, which made the omission easier to miss until now.
