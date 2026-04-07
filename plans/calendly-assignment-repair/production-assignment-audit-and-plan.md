# Production Calendly Assignment Audit And Repair Plan

Date: 2026-04-07
Deployment inspected: `prod:usable-guineapig-697`
Method: read-only Convex CLI inspection using the production `CONVEX_DEPLOY_KEY`

## Production state

Tenant:
- `k57dqjfyf8qqy31bq375ng8gb984b24q`
- `PT DOM`

Counts:
- Opportunities: 40
- `scheduled`: 35
- `canceled`: 5
- `invitee.created` raw webhook events: 41
- Users: 10
- Users with `calendlyUserUri`: 10
- Calendly org members: 20

Assignment state:
- Opportunities with `assignedCloserId`: 4
- Opportunities without `assignedCloserId`: 36
- Unassigned opportunities that are already resolvable from current host mappings: 29
- Unassigned opportunities that are not yet resolvable: 7
- Opportunities assigned to the wrong closer based on current host mapping: 0

## Main finding

This is mostly a timing problem.

Most closer user records were created on `2026-04-07` between roughly `19:35Z` and `19:45Z`.
Most webhook-created opportunities were inserted before those user-to-Calendly links existed.

That means the `invitee.created` pipeline correctly stored:
- `hostCalendlyUserUri`
- `hostCalendlyEmail`
- `hostCalendlyName`

But it had no closer user to resolve against at creation time, so `assignedCloserId` stayed empty.

## What is currently recoverable

There are 29 opportunities that can be repaired immediately from existing data.

Examples:
- Host `tyler@pt-domination.com` now resolves to closer `k9794xrncs1mpwr1kjb5jk9rxx84c0vq`
- Host `johann@pt-domination.com` now resolves to closer `k97byegszggfbvr6xhmcv1xx3h84c5zc`
- Host `luke@pt-domination.com` now resolves to closer `k977jydkt3x1a20nskwrb8btn984cbqd`
- Host `reece@pt-domination.com` now resolves to closer `k9797j7tfxexatn9twt94cgh9184dfsd`
- Host `jonathan@pt-domination.com` now resolves to closer `k97e9brsgqyqcbwyzd58kps82x84dnrt`

These are exactly the records the existing maintenance repair should patch.

## What is not yet recoverable

There are 7 unassigned opportunities whose hosts do not currently map to any closer user.

Current unresolved hosts:
- `oystraining@gmail.com`
- `operations@pt-domination.com`

Current state for those hosts:
- Calendly org member exists
- `matchedUserId` is empty
- No closer user currently linked to that Calendly URI

Interpretation:
- These 7 cannot be safely auto-assigned until you decide who those Calendly hosts should map to.

## Existing code paths that matter

- Assignment at webhook ingest: `convex/pipeline/inviteeCreated.ts`
- Existing repair mutation: `convex/opportunities/maintenance.ts`
- Invite/link flow creating pending closers with Calendly links:
  - `convex/workos/userManagement.ts`
  - `convex/workos/userMutations.ts`

## Proposed fix plan

### Phase 1. Run the existing repair for all currently resolvable opportunities

Goal:
- Backfill `assignedCloserId` from stored webhook host data using current user/member mappings.

Why this is safe:
- I found `0` opportunities currently assigned to a different closer than the host mapping indicates.
- The missing assignment pattern aligns with users being created after the webhook events.

Expected result:
- 29 unassigned opportunities become assigned.
- The remaining unresolved set should drop from 36 to 7.

### Phase 2. Decide explicit ownership for the 7 unresolved opportunities

Goal:
- Resolve hosts that still have no closer user mapping.

Needed decisions:
- Should `oystraining@gmail.com` map to a closer?
- Should `operations@pt-domination.com` map to a closer, or should opportunities hosted by that admin remain unassigned?

Only after that:
- Create/link the corresponding closer user records
- Re-run the same repair mutation

### Phase 3. Add one small audit tool before doing future backfills

Goal:
- Make this operationally visible next time.

Recommended query or admin tool output:
- opportunities with no `assignedCloserId`
- host URI/email from the stored raw webhook
- current resolvable closer, if any
- unresolved hosts with no closer mapping

This should be a dry-run report first, then a separate repair mutation.

### Phase 4. Optional hardening

Recommended improvements:
- Add a dry-run variant of `repairAssignmentsFromCalendlyHosts`
- Add a query to report unresolved host URIs grouped by host email
- Consider whether assignments to `pending` invited closers are intended product behavior
  - current code does allow assignment to pending closers because it checks `role === "closer"` and does not require `invitationStatus === "accepted"`
- If that behavior is correct, keep it
- If not, change the assignment rules deliberately rather than implicitly

## Recommended execution order

1. Run the existing repair mutation for tenant `k57dqjfyf8qqy31bq375ng8gb984b24q`
2. Verify unassigned opportunities drop from 36 to about 7
3. Decide who owns `oystraining@gmail.com` and `operations@pt-domination.com`
4. Link or create the appropriate closer users
5. Re-run the repair mutation
6. Add an audit query so this is observable going forward
