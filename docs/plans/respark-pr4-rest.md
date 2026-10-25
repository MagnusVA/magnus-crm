# Respark PR 4 completion

Implements the credit and query portion of the approved Respark plan, after
`74d1afb`. Local implementation only. No deployment, production reads, or
migration runs were authorized or performed in this worktree.

## Schema and rollout

This is an additive widening. The attribution source union accepts `respark`;
existing capture and other attribution rows remain valid. No existing data needs
rewriting or backfilling. Respark credit begins on new deal creation. Calling
`recordDealCreation` again can only add a missing source, never replace credit.

Two indexes are added:

- `dealAttributions.by_tenantId_and_source_kind_and_attributedAt`, for the tenant's
  Respark credit in a reporting range. The table has six indexes after this PR.
- `opportunities.by_tenantId_and_leadId_and_createdAt`, for the previous buying
  attempt and newest deal in a person card. Existing indexes remain in place.

Deploy the widened schema, indexes, and code together through the normal PR
pipeline. After deployment, the parent rollout must run `assertDealAttributions`
with reset and inspect its result. No narrow is needed. A rollback must continue
to accept the new source after any Respark row exists; do not deploy the old
source validator over those rows. Disable the new caller or fix forward instead.
This worktree has not verified deployed data or deployment compilation.

`convex/_generated/api.d.ts` was hand-edited in its existing pattern. No Convex
CLI generation, dev sync, or deployment command was run.

## Credit decisions

Capture and Respark are checked independently. The latest respark worked strictly
before deal creation qualifies only if it was worked strictly after the previous
deal's creation, across merged people. A later respark cannot change an existing
row. Only capture rows enter `leadGenDealsByWorker` and the Deals column.

The assertion checks the referenced item's result, person across merges, worker,
team member, event, and worked time. It permits zero or one Respark row alongside
the expected capture. It checks the buying-attempt window when credit was added,
using creation events' original person, timestamped merge history, and document
creation times. Later merges, backdated imports, and later resparks do not erase
historical credit. It fails closed above 200 potentially disqualifying prior
deals. Legacy deals without a creation event use their current person; new deals
have creation events before `recordDealCreation` runs.

Every attribution source reader was checked. The shared detail payload already
passes any source kind through to the shared credit list. That list now labels a
Respark row "Respark". Booked Calls' team/DM reads intentionally select only
booking sources and require no change.

## Query contract and limits

Every query calls the Respark permission guard directly. The person panel returns
`null` for absent, foreign-user, foreign-tenant, or expired-batch items. Worked
items remain readable until the batch expires. It returns selected fields only,
with no payments, credit rows, or admin links. Phone and email are masked before
returning. Notes and booking answers also redact contact details.

History reads use a shared 512 KiB byte budget and indexed row limits. Responses
include `capped` when older data was omitted. The panel reads at most 500 timeline
events in its response, 100 deals, 100 calls, 100 notes, and 100 answers per call.
Each merged person contributes bounded indexed reads. Cards inspect at most 40
events and 10 deals per merged person, and 10 calls per inspected deal. The panel
uses timeline labels and excludes payment events. Person Respark history uses the
existing 200-item fail-closed helper.

This resolves the request for all history plus bounded reads as a bounded history
snapshot with an explicit `capped` flag. A later UI must acknowledge that flag.
There is no history pagination in this backend PR.

Time zones come from the exact invitee's applied booking delivery and retained
raw webhook payload. They return `null` after retention removes that payload, or
when the booking supplied none. No person field or durable copy was added.

Pool counts describe the whole tenant pool, including held people, as specified.
They use explicit lower and upper tuple bounds because aggregate prefix bounds
cannot be combined with time bounds. Today uses the tenant's business day and
counts batches started, Resparked items, and Not a fit items. Above 1,000 batches
started by one user in one business day, it fails visibly instead of undercounting.
