# Side Deals Migration Notes

## Phase 1 Widen Deploy

- Deploy the widened schema/code before running any backfill:
  - `opportunities.source` is optional during rollout.
  - `opportunities.latestActivityAt` is optional during rollout.
  - `opportunities.manualCreationKey` remains optional permanently.
  - `opportunities.notes` was added as optional for manually-created opportunities.
  - `leadIdentifiers.source` now accepts `side_deal`.
  - `paymentRecords.origin` now accepts `closer_side_deal` and `admin_side_deal`.
- New runtime writers now write `source: "calendly"` / `latestActivityAt` for Calendly flows and `source: "side_deal"` / `latestActivityAt` for manual flows.
- Do not narrow `source` or `latestActivityAt` in this deploy.

## Backfill To Run After Widen Deploy

The migrations are defined in `convex/migrations.ts` as:

- `migrations:backfillOpportunitySourceAndActivity`
- `migrations:assertOpportunitySourceAndActivityBackfilled`
- `migrations:backfillOpportunitySearchProjection`
- `migrations:assertOpportunitySearchProjectionBackfilled`

Dev dry run was executed successfully on 2026-04-24:

- Command: `npx convex run migrations:run '{"fn":"migrations:backfillOpportunitySourceAndActivity","dryRun":true}'`
- Result: `processed: 60`, status `DRY RUN: Migration was started and finished in one batch.`
- No changes were committed by the dry run.

Dev execution was then run successfully on 2026-04-24:

- Command: `npx convex run migrations:run '{"fn":"migrations:backfillOpportunitySourceAndActivity"}'`
- Result: `processed: 60`, status `Migration was started and finished in one batch.`

Use the installed `@convex-dev/migrations` runner syntax:

```bash
npx convex run migrations:run '{"fn":"migrations:backfillOpportunitySourceAndActivity","dryRun":true}'
npx convex run migrations:run '{"fn":"migrations:backfillOpportunitySourceAndActivity"}'
npx convex run migrations:run '{"fn":"migrations:assertOpportunitySourceAndActivityBackfilled","dryRun":true}'
npx convex run migrations:run '{"fn":"migrations:backfillOpportunitySearchProjection","dryRun":true}'
npx convex run migrations:run '{"fn":"migrations:backfillOpportunitySearchProjection"}'
npx convex run migrations:run '{"fn":"migrations:assertOpportunitySearchProjectionBackfilled","dryRun":true}'
```

Production, after dev dry run/execution is verified:

```bash
npx convex run --prod migrations:run '{"fn":"migrations:backfillOpportunitySourceAndActivity","dryRun":true}'
npx convex run --prod migrations:run '{"fn":"migrations:backfillOpportunitySourceAndActivity"}'
npx convex run --prod migrations:run '{"fn":"migrations:assertOpportunitySourceAndActivityBackfilled","dryRun":true}'
npx convex run --prod migrations:run '{"fn":"migrations:backfillOpportunitySearchProjection","dryRun":true}'
npx convex run --prod migrations:run '{"fn":"migrations:backfillOpportunitySearchProjection"}'
npx convex run --prod migrations:run '{"fn":"migrations:assertOpportunitySearchProjectionBackfilled","dryRun":true}'
```

Expected behavior:

- Legacy opportunities with missing `source` are patched to `source: "calendly"`.
- Legacy opportunities with missing `latestActivityAt` are patched to `Math.max(paymentReceivedAt, lostAt, latestMeetingAt, updatedAt, createdAt)`.
- `assertOpportunitySourceAndActivityBackfilled` fails if any opportunity is still missing `source` or `latestActivityAt`.
- `backfillOpportunitySearchProjection` creates or refreshes one `opportunitySearch` projection row per opportunity for projection-backed opportunity search.
- `assertOpportunitySearchProjectionBackfilled` fails if any opportunity is missing its search projection or if a projection has stale tenant, lead, or status fields.
- The migrations are idempotent. Re-running them should leave already-patched rows unchanged.

## Verification Before Narrow Deploy

- Confirm migration runner reports completion in dev and production.
- Verify there are zero opportunity rows with `source === undefined`.
- Verify there are zero opportunity rows with `latestActivityAt === undefined`.
- Verify every opportunity has a current `opportunitySearch` projection.
- Smoke test a Calendly webhook-created opportunity and confirm it writes `source: "calendly"` plus `latestActivityAt`.
- Smoke test `opportunities.createManual.createManual` in dev and confirm it writes `source: "side_deal"`, `manualCreationKey`, and `latestActivityAt`.

Production verification output recorded on 2026-04-26:

```md
Production source/activity dry run was executed on 2026-04-26:

- Command: `npx convex run --prod migrations:run '{"fn":"migrations:backfillOpportunitySourceAndActivity","dryRun":true}'`
- Result: `processed: 200`, status `DRY RUN: Migration started.`

Production source/activity execution was executed on 2026-04-26:

- Command: `npx convex run --prod migrations:run '{"fn":"migrations:backfillOpportunitySourceAndActivity"}'`
- Result: `processed: 209`, status `success` from `lib:getStatus`.

Production source/activity verification was executed on 2026-04-26:

- Command: `npx convex run --prod migrations:run '{"fn":"migrations:assertOpportunitySourceAndActivityBackfilled","dryRun":true}'`
- Result: first page `processed: 200`, status `DRY RUN: Migration started.`
- Command: `npx convex run --prod migrations:run '{"fn":"migrations:assertOpportunitySourceAndActivityBackfilled","dryRun":true,"cursor":"075dab3ddb0d37dcff662bc95347ea6703ebf17515ab1ea10480c9bd60e6f80da951d38ed015df4590a7d804fe8b70762e0a4f398c6793b5e6240d49191061e1afa5858e40a60f412b5292214c41c0e0969e6ee1793b198aff1b4bb831ecb922a677509cb2afaa8d6fc7460389e739a1fdfb630919a78566"}'`
- Result: remaining page `processed: 9`, status `DRY RUN: Migration was started and finished in one batch.`

Production search projection dry run was executed on 2026-04-26:

- Command: `npx convex run --prod migrations:run '{"fn":"migrations:backfillOpportunitySearchProjection","dryRun":true}'`
- Result: `processed: 100`, status `DRY RUN: Migration started.`

Production search projection execution was executed on 2026-04-26:

- Command: `npx convex run --prod migrations:run '{"fn":"migrations:backfillOpportunitySearchProjection"}'`
- Result: `processed: 209`, status `success` from `lib:getStatus`.

Production search projection verification was executed on 2026-04-26:

- Command: `npx convex run --prod migrations:run '{"fn":"migrations:assertOpportunitySearchProjectionBackfilled","dryRun":true}'`
- Result: first page `processed: 200`, status `DRY RUN: Migration started.`
- Command: `npx convex run --prod migrations:run '{"fn":"migrations:assertOpportunitySearchProjectionBackfilled","dryRun":true,"cursor":"075dab3ddb0d37dcff662bc95347ea6703ebf17515ab1ea10480c9bd60e6f80da951d38ed015df4590a7d804fe8b70762e0a4f398c6793b5e6240d49191061e1afa5858e40a60f412b5292214c41c0e0969e6ee1793b198aff1b4bb831ecb922a677509cb2afaa8d6fc7460389e739a1fdfb630919a78566"}'`
- Result: remaining page `processed: 9`, status `DRY RUN: Migration was started and finished in one batch.`

Production migration runner status was checked on 2026-04-26:

- Command: `npx convex run --prod --component migrations lib:getStatus '{"names":["migrations:backfillOpportunitySourceAndActivity","migrations:backfillOpportunitySearchProjection"]}'`
- Result: both backfills returned `state: "success"`, `isDone: true`, and `processed: 209`.
```

## Future Narrow Deploy

Only after production verification passes:

- Change `opportunities.source` from optional to required.
- Change `opportunities.latestActivityAt` from optional to required.
- Keep `manualCreationKey` optional.
- Keep `normalizeOpportunitySource()` until all read paths are audited, then simplify in a later cleanup.
