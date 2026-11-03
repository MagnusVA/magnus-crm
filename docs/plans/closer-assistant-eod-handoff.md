# Closer assistant end-of-day slice

The web and agent share the report builder and write core in
`convex/closer/endOfDay.ts`. The agent must resolve its tenant user before
calling a core. The cores check that the resolved user is an active closer in
that tenant. They never accept identity from a public argument.

```ts
type EndDayCaller = {
  tenantId: Id<"tenants">;
  userId: Id<"users">;
  role: Doc<"users">["role"];
};
type EndDayOptions = {
  narrative?: string;
  note?: string;
  timeZone?: string;
  endedVia: "web" | "agent";
  agentClient?: string;
};
type DaySummaryOptions = { now?: number; timeZone?: string };

endDayCore(
  ctx: MutationCtx,
  caller: EndDayCaller,
  options: EndDayOptions,
): Promise<Doc<"endOfDayReports">>;

getDaySummaryCore(
  ctx: QueryCtx,
  caller: EndDayCaller,
  options?: DaySummaryOptions,
): Promise<DaySummary>;

buildCloserDaySummary(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    userId: Id<"users">;
    periodStart: number;
    periodEnd: number;
    now: number;
  },
): Promise<CloserDaySummary>;
```

`CloserDaySummary` contains `numbers` and `gaps`, validated by the existing
EOD schema validators. `DaySummary` adds the window, zone, previous-day flag,
configured Slack channel ID/name and the latest report. A preview may have an
empty window immediately after ending a day. The saved report is returned
unchanged for requests less than 60 seconds apart.

The web functions are `endMyDay`, `getDaySummary`, `getMyReport` and
`retryEndOfDayPost`. Profile calls `users/timezone.updateMyTimezone`.

## Schema rollout

All changes widen `endOfDayReports` with optional fields. Existing snapshots
remain valid, no backfill is required, and `convex/schema.ts` is unchanged.
Deploy the widened schema together with the functions through the normal
release process. This slice does not deploy or run a migration.

- `numbers.people[].amounts` preserves separate currency, program and payment
  type totals on one person's line. The original scalar fields remain for
  compatibility. Slack can render snapshots without `amounts`.
- `slackChannelName` preserves the destination label when settings change.
- `slackThreadReportId` keeps the first report's identity while its scheduled
  post is still pending. `slackThreadTs` stores the Slack thread timestamp.
- `slackPostStartedAt` and `slackPostAttempt` form an atomic two-minute action
  lease. Completion checks the attempt, and an expired lease can be retried.

The existing optional `users.timezone` and `slackInstallations.eodReportChannel*`
fields need no migration. UTC and IANA aliases are accepted after
canonicalization; other zones must appear in `Intl.supportedValuesOf`.

## Boundaries and operational choices

- Repeat reports thread together when their end times fall in the same tenant
  business day and they use the same channel. The report's numbers always use
  the shift window, independent of that grouping.
- Calls and payments use half-open windows. Overdue tasks and unmatched
  recordings show the closer's current backlog, including older gaps.
- Reads cap at 200 calls, tasks per status, unmatched recordings, or payments
  per won deal; at 10 recordings per meeting; and at a shared 3 MiB read budget.
  Existing reporting helpers retain their own bounds. A capped read refuses
  to save a partial report. Saved summary payloads cap at 800 KB.
- A repeat post waits up to one minute for its root report, then records
  `thread_pending` for an explicit retry. Transport failures also require an
  explicit retry. Slack receives a stable `client_msg_id` on each attempt;
  the action lease prevents concurrent sends. A Slack success followed by a
  process failure before persistence still depends on Slack deduplication.
- There is no fallback Slack channel. A failed or missing destination never
  changes the saved numbers. Retrying uses the currently configured EOD
  channel and clears old thread references when the destination changes.
- A deposit-only won deal appears under Deposits. Mixed deposit and final
  payments appear under Won, with final payment amounts on that line; the
  Money section counts all window deposits separately from cash.

## Files

- `convex/closer/endOfDay.ts`: builder, shared cores, authenticated web API.
- `convex/closer/endOfDaySchema.ts`: optional snapshot and delivery fields.
- `convex/slack/eodMessage.ts`: Slack message formatting.
- `convex/slack/eodReports.ts`: scheduled posting, delivery lease, result and
  channel-error persistence.
- `convex/slack/channels.ts`: EOD channel save/status fields.
- `convex/users/timezone.ts`: timezone validation and authenticated update.
- `convex/_generated/api.d.ts`: generated module types.
- `app/workspace/closer/_components/end-my-day-row.tsx`,
  `end-my-day-sheet.tsx`, `end-day-status.tsx`: board footer, preview, note,
  delivery status and retry.
- `app/workspace/closer/_components/todays-calls-board.tsx`: import and mount.
- `app/workspace/profile/_components/profile-timezone-row.tsx`: zone picker
  and Set from your browser.
- `app/workspace/profile/_components/profile-page-client.tsx`: import and mount.
- `app/workspace/settings/_components/integrations/slack-channel-picker-dialog.tsx`:
  optional EOD channel picker, preserving unavailable saved channels.
- `app/workspace/settings/_components/integrations/slack-eod-channel-status.tsx`:
  configured destination and actionable channel errors.
- `app/workspace/settings/_components/integrations/slack-integration-card.tsx`:
  import/mount and two picker props.
- `hooks/use-browser-timezone.ts`: browser zone without an SSR zone mismatch.
- `convex/closer/endOfDay.test.ts`, `tests/closerEndOfDayFixtures.ts`: window,
  dashboard parity, currencies, gaps, Slack success/failure/threading,
  permissions and channel settings tests.

## Validation

Run `pnpm typecheck`, `pnpm lint`, and `WORKOS_CLIENT_ID=client_test pnpm test`.
The baseline auth helper requires a client ID in the test process; Vitest does
not load `.env.local`. The dummy test value fixes the baseline's missing-env
failures without changing auth code. Slack fetches are stubbed in all new
delivery tests. Convex types regenerate with `npx convex codegen`.

Verified on this branch: `npx convex codegen`, `pnpm typecheck` and `pnpm lint`
passed. The full suite passed with `WORKOS_CLIENT_ID=client_test pnpm test`: 178
files, 2,135 passing tests and one expected failure. The new EOD suite has 22
passing tests.
