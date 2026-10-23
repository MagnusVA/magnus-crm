# Pipeline Health aggregate rollout

PR 6 adds `openDealAging` and `personLosses`. Deploy the components, hooks,
optional `tenants.pipelineHealthAggregatesVerifiedAt` and gated readers together.
An absent flag keeps the current report reads. This worker does not deploy or
run production commands. The orchestrator runs the following after deployment,
then repeats them on dev before PR 13 narrows the schema.

## Run sequence

Use a Bash driver with `set -euo pipefail`. The commands below target production;
for dev omit `--env-file .env.vercel.production`. Do not copy production env files
into a worker checkout.

1. Start both backfills, with no cursor:

   ```bash
   npx convex run --env-file .env.vercel.production reporting/backfill:backfillOpenDealAging '{}'
   npx convex run --env-file .env.vercel.production reporting/backfill:backfillPersonLosses '{}'
   ```

   Each pages all opportunities, 200 at a time, and schedules its next page.
   They insert only eligible rows with `insertIfDoesNotExist`. Rerunning either
   from the beginning is safe. They do not patch source rows, emit events or
   change lifecycle stages. There is no dry-run mode on these component
   backfills, matching the existing reporting backfills.

2. Wait for each invocation's `reporting.backfill.completed` log, with
   `backfill` equal to `openDealAging` and `personLosses`. Check Scheduled
   Functions for failures; a returned `hasMore: true` means only the first
   batch committed. A failed batch stops the rollout. Repair the cause and
   restart the idempotent backfill.

3. Verify every month from April 2026 through the current month. For the
   October 2026 rollout, this single call checks aging and all seven UTC
   monthly loss buckets separately:

   ```bash
   npx convex run --env-file .env.vercel.production reporting/pipelineHealthVerification:verifyPipelineHealthAggregates '{"tenantId":"k57dqjfyf8qqy31bq375ng8gb984b24q","startDate":1775001600000,"endDate":1793491200000}'
   ```

   Require `[]`. The query also accepts a single month's `[startDate,endDate)`
   to investigate a mismatch. It returns differences only: stage or month/actor
   IDs, metric, source count/sum, aggregate count/sum. It checks missing and extra
   counts, creation sums and stale counts. Loss verification reads **all** Closed
   lost deals, including system losses and deals with later activity, before
   filtering by `lostAt` and `isPersonLoss`. Source reads use keyset pagination
   from `convex-helpers/server/stream`, 200 per page, within one snapshot. They
   have no report cap. The entire verification still shares Convex transaction
   limits; the supplied production inventory has about 11,600 deals. If a
   deployment limit is hit, stop and ship a paged verification protocol before
   enabling the flag. A partial result never enables it.

4. Supply the same verification range to the gate mutation:

   ```bash
   npx convex run --env-file .env.vercel.production reporting/pipelineHealthVerification:markPipelineHealthAggregatesVerified '{"tenantId":"k57dqjfyf8qqy31bq375ng8gb984b24q","startDate":1775001600000,"endDate":1793491200000}'
   ```

   It recomputes the verification inside its transaction and throws on any
   difference. It accepts no caller-provided success boolean or difference list.
   The range must include April 1, 2026 through the start of the month after the
   current month. Advance `endDate` when running in a later month. Concurrent
   writes participate in Convex conflict detection, so an old query result
   cannot enable the flag after drift. A successful call returns `null` and
   writes `pipelineHealthAggregatesVerifiedAt`.

5. Read the tenant flag independently, re-run the verifier expecting `[]`, and
   check both Pipeline Health queries. The new aging totals remain exact even
   when the stale sample stops at 500 source rows. The sample is globally oldest
   first across the four stages and stops at 20 stale deals. Losses retain at
   most 2,000 entries with the existing truncated flag. Velocity is unchanged.

## Write-site audit

- `reporting/writeHooks.ts`: insert, replace and delete call both filtered
  aggregates. This covers opportunity creation in `opportunities/createManual`,
  `slack/createQualifiedLead` and `pipeline/inviteeCreated`, plus deletion in
  `sideDeals/deleteEmptyOpportunity`.
- `lib/opportunityActivity.ts`: stage/outcome changes already call replace;
  add `nextMeetingAt`, `lostAt`, `lostByUserId` and `lostReason` to its change
  detection so corrections also call it. `createdAt` was already included.
- `lib/opportunityMeetingRefs.ts`: reads before/after its direct patch and calls
  only `replaceOpenDealAging`. It does not double-replace the other aggregates.
- `admin/migrations.ts`'s legacy `purgePhase6BlockerRecords` removes the new
  aggregate entries before its raw opportunity deletion.
- `admin/tenantsMutations.ts`'s generic tenant cleanup and
  `testing/operationalData.ts`'s generic wipe remove the new entries before
  deleting opportunities. Their other existing cleanup behavior stays.
- Other direct opportunity patches were inspected: `migrations.ts` changes
  source/activity or `qualifiedAt`; `admin/migrations.ts` repoints event config;
  `leads/merge.ts` clears duplicate flags; `leads/repointLeadReferences.ts` moves
  `leadId`; `pipeline/inviteeCreated.ts` writes first-booking/UTM fields;
  `lib/touches.ts` writes touch snapshots; `lib/soldProgramCache.ts` writes
  program caches. None changes these aggregates' keys, sum or eligibility.
  No remaining production write bypass for those inputs was found.

## Aggregate API

Production writes use `TableAggregate.insertIfDoesNotExist`, `replaceOrInsert`
and `deleteIfExists` until PR 13. Reads use `count`, `sum`, and `iter`, which
pages the component using `paginate` with 200 entries per page. Tests additionally
use `clear` and `paginate` to plant drift and inspect keys. The shared existing
`reporting/aggregates.ts` is unchanged.
