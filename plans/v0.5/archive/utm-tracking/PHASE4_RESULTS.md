# Phase 4 — Validation Results

**Date:** 2026-04-09
**Tester:** Codex
**Status:** Implementation complete; real Calendly click-through QA still optional
**Scope:** Local extraction tests plus synthetic end-to-end verification on the dev Convex deployment.

## Completed Today

- `pnpm tsc --noEmit` passes.
- `node --test tests/utm-tracking.test.mjs` covers all 10 extraction scenarios from the phase-4 matrix.
- `convex/lib/utmParams.ts` was audited against the validation matrix.
- `convex/pipeline/inviteeCreated.ts` was audited to confirm:
  - UTM extraction happens from `payload.tracking`
  - meeting inserts include `utmParams`
  - new opportunity inserts include `utmParams`
  - follow-up opportunity patches intentionally omit `utmParams`
- Synthetic end-to-end verification was run on the dev Convex deployment through `webhooks/calendlyMutations:persistRawEvent`, exercising the real `persistRawEvent -> processRawEvent -> inviteeCreated.process` chain.
- `npx convex insights --details` was run. It reported one unrelated WorkOS AuthKit OCC retry in the last 72 hours and no UTM-specific warning signal.
- `convex/pipeline/debugUtm.ts` was deleted from the repo after verification cleanup. A fresh Convex deploy is still required to remove it from any already-running deployment.

## Code Audit Notes

### Input matrix coverage by implementation

`extractUtmParams(tracking: unknown)` currently:

- returns `undefined` when `tracking` is missing, `null`, or an array
- ignores non-string field values
- ignores empty strings
- returns `undefined` instead of an empty object when no valid UTM field survives validation
- preserves partial valid UTM objects

This matches the expected phase-4 handling for scenarios 6-10 at the helper level and is now covered by the automated test file.

### Follow-up attribution preservation

`convex/pipeline/inviteeCreated.ts` omits `utmParams` from the follow-up opportunity patch and includes an explicit preservation comment. This was also verified against the dev deployment by creating an initial synthetic booking with `facebook/ad/spring`, transitioning that opportunity into `follow_up_scheduled`, then processing a second synthetic booking with `ptdom/follow_up/{opportunityId}`. The new meeting stored the follow-up UTMs while the reused opportunity kept the original `facebook/ad/spring` attribution.

### Synthetic deployment verification

The dev deployment was exercised directly through internal functions:

- Initial synthetic `invitee.created` produced a meeting with:
  - `utm_source=facebook`
  - `utm_medium=ad`
  - `utm_campaign=spring`
- The paired opportunity stored the same original attribution.
- A synthetic `invitee_no_show.created` plus `closer/followUpMutations:transitionToFollowUp` moved that opportunity into `follow_up_scheduled`.
- A second synthetic `invitee.created` for the same lead reused the existing opportunity and created a new meeting with:
  - `utm_source=ptdom`
  - `utm_medium=follow_up`
  - `utm_campaign={opportunityId}`
- The opportunity's `utmParams` remained `facebook/ad/spring`, confirming non-overwrite behavior.

## Input Matrix Results

| # | Scenario | Status | Notes |
|---|---|---|---|
| 1 | Standard with UTMs | PASS | Verified on the dev deployment via synthetic `invitee.created`; meeting and opportunity stored `facebook/ad/spring`. |
| 2 | Full UTMs (5 fields) | PASS | Covered by `tests/utm-tracking.test.mjs`. |
| 3 | No UTMs | PASS | Covered by `tests/utm-tracking.test.mjs` via missing tracking input returning `undefined`. |
| 4 | Partial UTMs | PASS | Covered by `tests/utm-tracking.test.mjs`. |
| 5 | Extra parameters | PASS | Covered by `tests/utm-tracking.test.mjs`. |
| 6 | All null fields | PASS | Covered by `tests/utm-tracking.test.mjs`. |
| 7 | Tracking null | PASS | Covered by `tests/utm-tracking.test.mjs`. |
| 8 | Tracking array | PASS | Covered by `tests/utm-tracking.test.mjs`. |
| 9 | Empty string field | PASS | Covered by `tests/utm-tracking.test.mjs`. |
| 10 | Non-string value | PASS | Covered by `tests/utm-tracking.test.mjs`. |

## Follow-Up Attribution Preservation

| Test | Status | Notes |
|---|---|---|
| Opportunity UTMs unchanged after follow-up rebooking | PASS | Verified on the dev deployment: opportunity preserved `facebook/ad/spring` after the second booking. |
| New meeting has its own UTMs (independent of opportunity) | PASS | Verified on the dev deployment: reused opportunity, new meeting stored `ptdom/follow_up/{opportunityId}`. |

## Performance

| Metric | Before UTM | After UTM | Delta |
|---|---|---|---|
| `inviteeCreated.process` avg duration | No explicit baseline captured before rollout | No regression signal from current CLI snapshot | N/A |

**Current CLI snapshot (`npx convex insights --details`):**

- One warning in the last 72 hours: unrelated OCC retry in `workOSAuthKit/eventWorkpool:loop.js:updateRunStatus`
- No UTM-specific warning surfaced by the CLI output

## Debug Query

- Tested: Yes
- Output matches documents: Yes
- Deleted after verification: Yes, in the repo. Deployment cleanup is pending the next Convex push/deploy.

## Remaining Optional QA

1. Run a real Calendly booking URL with browser query params if you want one final external-system check in addition to the synthetic deployment verification.
2. Re-check dashboard timing after more organic UTM-tagged traffic arrives if you want a longer-term baseline for `inviteeCreated.process`.

## Blockers / Issues

- No implementation blocker remains.
- The `simplify` skill referenced by the plan is not available in this workspace, so final code review was done manually.
