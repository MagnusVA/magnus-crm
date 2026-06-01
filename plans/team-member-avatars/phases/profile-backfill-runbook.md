# Team Member Avatar Profile Backfill Runbook

## Scope

This runbook covers Phase 5A/5B backfill preparation for existing active CRM
users' WorkOS `profilePictureUrl` values. It is safe to prepare during
parallelization window 3, but production execution waits for Phase 4 surface QA
and dry-run signoff.

## Preconditions

- Phase 1 optional avatar schema fields are deployed.
- Phase 3 profile upload code is deployed.
- `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` are set in the target Convex
  deployment.
- The target tenant ID is known and belongs to the production test tenant.
- No one has requested a cross-tenant backfill.

## Dry Run

Run the same action with `dryRun: true` first:

```bash
pnpm exec convex run internal.workos.profileBackfill.backfillUserProfilePictures \
  '{"tenantId":"<tenantId>","cursor":null,"dryRun":true}'
```

Record:

- Date:
- Deployment:
- Tenant ID:
- Result JSON:
- Notes for any `failed` users:

The action returns bounded-batch counts:

- `scanned`: active users read from the tenant page.
- `skipped`: pending invite placeholders, deleted rows, or rows skipped by the
  patch mutation.
- `updated`: rows that would receive a different WorkOS profile picture URL.
- `unchanged`: rows where the WorkOS profile picture URL already matches.
- `failed`: WorkOS fetch or patch failures.
- `continueCursor` / `isDone`: pagination state.
- `scheduledContinuation`: whether the action queued the next page.

## Production Test-Tenant Run

Only run after the dry-run result is accepted:

```bash
pnpm exec convex run internal.workos.profileBackfill.backfillUserProfilePictures \
  '{"tenantId":"<tenantId>","cursor":null,"dryRun":false}'
```

Record:

- Date:
- Deployment:
- Tenant ID:
- Result JSON:
- Scheduled continuation observed:
- Notes for any `failed` users:

If `scheduledContinuation` is true, monitor logs until the final page returns
`isDone: true`.

## Data Verification

Spot-check stored fields after the run:

```bash
pnpm exec convex data users
pnpm exec convex data leadGenWorkers
pnpm exec convex logs
```

Verify:

- Active users with WorkOS pictures have `profilePictureUrl`.
- Backfilled users have `profilePictureSyncedAt`.
- Pending invite placeholder users remain skipped.
- Inactive or deleted users remain unchanged.
- Lead-generator rows mirror the user avatar fields after the backfill.

## Static and Privacy Checks

Run these after Phase 4 surface rollout has merged:

```bash
pnpm exec convex codegen
pnpm tsc --noEmit
rg "profilePictureUrl|customProfilePictureStorageId|avatarUrl|email" convex/linkPortal app/dm-links
rg "AvatarImage|AvatarFallback|rounded-full.*initial|authorName|actorName|closerName" app/workspace
```

Public DM portal payloads must not include WorkOS profile picture URLs, Convex
signed storage URLs, Slack avatar URLs, or CRM emails.

## Rollback Posture

- Do not delete optional avatar fields during rollback.
- Do not delete WorkOS-derived profile picture URLs unless product requests data
  removal.
- If upload controls regress, hide the controls and keep initials/WorkOS
  fallback rendering.
- If a workspace surface regresses, temporarily render text-only identity rows
  while retaining the backfilled data.
