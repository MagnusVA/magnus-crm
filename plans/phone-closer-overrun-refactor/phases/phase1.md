# Phase 1 - Outcome Contract and Status Machine

**Goal:** Make `scheduled` the source state for direct meeting outcomes while keeping the deployed schema wide enough for existing `in_progress` and `meeting_overran` rows. After this phase, backend code has a single eligibility contract for "who can record an outcome and when," but no existing legacy data has been changed yet.

**Prerequisite:** `plans/phone-closer-overrun-refactor/phone-closer-overrun-refactor-design.md` is accepted through Section 4 and Section 10. No schema narrow or data cleanup has run.

**Runs in PARALLEL with:** Nothing at phase level. This is the foundation for Phases 2-6. After 1A and 1B land, Phase 2 implementation can start.

**Skills to invoke:**
- `convex-migration-helper` - keep the status-machine work widen-safe and avoid narrowing literals before production data is repaired.
- `convex-performance-audit` - use if transition/helper changes create extra aggregate writes or broad reads.

**Docs and references to read first:**
- `plans/phone-closer-overrun-refactor/phone-closer-overrun-refactor-design.md` Sections 4, 10, 11, 13, and 14.
- `convex/_generated/ai/guidelines.md` for Convex validators, internal/public function rules, bounded queries, and auth rules.
- `.agents/skills/convex-migration-helper/SKILL.md` and `.agents/skills/convex-migration-helper/references/migration-patterns.md`.
- `convex/lib/statusTransitions.ts`, `convex/lib/tenantStatsHelper.ts`, `convex/closer/payments.ts`, `convex/closer/noShowActions.ts`, `convex/closer/followUpMutations.ts`, and `convex/closer/meetingActions.ts`.

**Deploy / backfill / manual operations:**
- **Deploy required:** Yes. Deploy this as a backend-only contract change before Phase 2.
- **Backfill or migration required:** No. Do not mutate production rows in this phase.
- **Manual operations:** After deploy, manually smoke-check that a scheduled test meeting still renders and that no Convex schema validation errors appear. Do not run cleanup commands yet.

**Acceptance Criteria:**
1. `scheduled -> payment_received`, `scheduled -> follow_up_scheduled`, `scheduled -> no_show`, `scheduled -> lost`, and `scheduled -> canceled` are valid opportunity transitions.
2. `scheduled -> completed`, `scheduled -> canceled`, and `scheduled -> no_show` are valid meeting transitions.
3. No code path added in this phase removes `in_progress` or `meeting_overran` from `convex/schema.ts`, `convex/opportunities/validators.ts`, or generated data types.
4. `convex/lib/outcomeEligibility.ts` centralizes the 5-minute closer lead window and admin bypass rules.
5. `assertCanRecordMeetingOutcome` derives role/ownership from server-loaded documents and never accepts tenant, user, or role identity from client arguments.
6. Legacy rows remain readable during the migration window; helpers distinguish "legacy tolerated temporarily" from "allowed new write."
7. `ACTIVE_OPPORTUNITY_STATUSES` is not narrowed until Phase 5 cleanup is complete, preventing active-opportunity stat drift for existing legacy rows.
8. A manual grep confirms Phase 1 introduced no new writes of `in_progress`, `meeting_overran`, `startedAt`, `stoppedAt`, or `attendanceCheckId`.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (status maps) ----------\
1B (eligibility helper) ---/
                            +--> 1D (contract verification)
1C (legacy-status fence) ---/

1D complete --> 1E (deploy + smoke check)
```

**Optimal execution:**
1. Start 1A and 1B together; they touch separate files.
2. Run 1C before any deploy to confirm schema/validators remain wide.
3. Run 1D after code changes and before deploy.
4. Deploy 1E only after TypeScript and grep checks pass.

**Estimated time:** 0.5-1 day

---

## Subphases

### 1A - Rewrite Transition Maps for Direct Outcomes

**Type:** Backend
**Parallelizable:** Yes - can run alongside 1B because it only touches status transition definitions.

**What:** Update `convex/lib/statusTransitions.ts` so scheduled opportunities and meetings can transition directly to terminal outcome states. Keep legacy statuses in the exported status arrays until Phase 6.

**Why:** Removing Start/End without this change would make normal scheduled meetings unable to log payment, schedule follow-up, mark no-show, or mark lost.

**Where:**
- `convex/lib/statusTransitions.ts` (modify)

**How:**

**Step 1: Keep the status arrays wide.**

```typescript
// Path: convex/lib/statusTransitions.ts
export const OPPORTUNITY_STATUSES = [
  "qualified_pending",
  "scheduled",
  "in_progress", // legacy only until Phase 6 narrow
  "meeting_overran", // legacy only until Phase 6 narrow
  "payment_received",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "lost",
  "canceled",
  "no_show",
] as const;

export const MEETING_STATUSES = [
  "scheduled",
  "in_progress", // legacy only until Phase 6 narrow
  "completed",
  "canceled",
  "no_show",
  "meeting_overran", // legacy only until Phase 6 narrow
] as const;
```

**Step 2: Change new-write transitions to start from `scheduled`.**

```typescript
// Path: convex/lib/statusTransitions.ts
export const VALID_TRANSITIONS: Record<
  OpportunityStatus,
  OpportunityStatus[]
> = {
  qualified_pending: ["scheduled", "lost"],
  scheduled: [
    "payment_received",
    "follow_up_scheduled",
    "lost",
    "no_show",
    "canceled",
  ],

  // Migration-window compatibility only. Phase 2 outcome mutations may still
  // resolve a pre-existing legacy row; no new code may write these statuses.
  in_progress: ["payment_received", "follow_up_scheduled", "no_show", "lost"],
  meeting_overran: [
    "payment_received",
    "follow_up_scheduled",
    "no_show",
    "lost",
  ],

  canceled: ["follow_up_scheduled", "scheduled"],
  no_show: ["follow_up_scheduled", "reschedule_link_sent", "scheduled"],
  follow_up_scheduled: ["scheduled", "payment_received", "lost"],
  reschedule_link_sent: ["scheduled"],
  payment_received: [],
  lost: [],
};
```

**Step 3: Change meeting transitions to make `scheduled` actionable.**

```typescript
// Path: convex/lib/statusTransitions.ts
export const MEETING_VALID_TRANSITIONS: Record<
  MeetingStatus,
  MeetingStatus[]
> = {
  scheduled: ["completed", "canceled", "no_show"],

  // Migration-window compatibility only. Delete these keys in Phase 6.
  in_progress: ["completed", "no_show", "canceled"],
  meeting_overran: ["completed", "no_show"],

  completed: [],
  canceled: [],
  no_show: ["scheduled"],
};
```

**Key implementation notes:**
- Do not remove legacy literals here. Phase 5 must clean production data before Phase 6 can narrow validators.
- Do not leave `scheduled -> in_progress` or `scheduled -> meeting_overran` as valid transitions after this subphase.
- Keep warning logs in `validateTransition` and `validateMeetingTransition`; they are useful during the rollout.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/statusTransitions.ts` | Modify | Scheduled direct outcomes with legacy compatibility keys retained |

---

### 1B - Add Server-Side Outcome Eligibility

**Type:** Backend
**Parallelizable:** Yes - independent of 1A until Phase 2 imports it.

**What:** Add a helper that enforces the direct-outcome contract: closers can record outcomes only for their assigned scheduled meeting at or after `scheduledAt - 5 minutes`; tenant admins and masters can act on any tenant scheduled meeting without the time gate.

**Why:** UI visibility is not authorization. Every outcome mutation must re-check role, ownership, scheduled state, and the closer time window server-side.

**Where:**
- `convex/lib/outcomeEligibility.ts` (create)

**How:**

**Step 1: Create the eligibility module.**

```typescript
// Path: convex/lib/outcomeEligibility.ts
import type { Doc, Id } from "../_generated/dataModel";

const OUTCOME_LEAD_MS = 5 * 60_000;

export function isMeetingOutcomeEligible(
  meeting: Doc<"meetings">,
  now: number,
): boolean {
  return (
    meeting.status === "scheduled" &&
    now >= meeting.scheduledAt - OUTCOME_LEAD_MS
  );
}

export function assertCanRecordMeetingOutcome(args: {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  userId: Id<"users">;
  role: Doc<"users">["role"];
  now: number;
}): void {
  const isAdmin =
    args.role === "tenant_master" || args.role === "tenant_admin";

  if (args.meeting.opportunityId !== args.opportunity._id) {
    throw new Error("Meeting does not belong to this opportunity");
  }
  if (args.meeting.tenantId !== args.opportunity.tenantId) {
    throw new Error("Meeting tenant does not match opportunity tenant");
  }
  if (args.meeting.status !== "scheduled") {
    throw new Error(`Meeting is not scheduled (current: ${args.meeting.status})`);
  }
  if (args.opportunity.status !== "scheduled") {
    throw new Error(
      `Opportunity is not scheduled (current: ${args.opportunity.status})`,
    );
  }
  if (!isAdmin && args.opportunity.assignedCloserId !== args.userId) {
    throw new Error("Not your meeting");
  }
  if (!isAdmin && !isMeetingOutcomeEligible(args.meeting, args.now)) {
    throw new Error("Outcome actions open 5 minutes before the scheduled time.");
  }
}
```

**Step 2: Add migration-window escape only where explicitly needed in Phase 2.**

Do not add broad legacy acceptance to `assertCanRecordMeetingOutcome`. Phase 2 should handle legacy rows with a small, local compatibility branch and delete that branch after Phase 5.

```typescript
// Path: convex/closer/payments.ts
// Phase 2 local compatibility only:
const isLegacyResolvable =
  meeting.status === "in_progress" || meeting.status === "meeting_overran";
if (!isLegacyResolvable) {
  assertCanRecordMeetingOutcome({ meeting, opportunity, userId, role, now });
}
```

**Key implementation notes:**
- The helper takes already-loaded documents, not IDs. Callers must tenant-check before calling or load through a trusted context helper.
- The helper intentionally rejects `in_progress` and `meeting_overran`; those are compatibility-only states during migration, not part of the new product contract.
- Admin bypass applies only to the time window, not to tenant isolation or transition validity.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/outcomeEligibility.ts` | Create | Shared server-side direct-outcome predicate and assertion |

---

### 1C - Fence Legacy Statuses Until Cleanup

**Type:** Backend / Manual
**Parallelizable:** Yes - this is a focused audit that can run after 1A.

**What:** Confirm this phase does not narrow validators, schema, or active-status accounting before production data cleanup.

**Why:** Convex schema validation is data-at-rest validation. Removing literals or active accounting too early will either block deploys or cause stats drift for legacy rows that are still present.

**Where:**
- `convex/schema.ts` (read-only in this phase)
- `convex/opportunities/validators.ts` (read-only in this phase)
- `convex/lib/tenantStatsHelper.ts` (read-only in this phase)
- `lib/status-config.ts` (read-only in this phase)

**How:**

**Step 1: Keep schema validators wide.**

```typescript
// Path: convex/schema.ts
// Phase 1 must leave these literals in place. They are removed only in Phase 6.
status: v.union(
  v.literal("qualified_pending"),
  v.literal("scheduled"),
  v.literal("in_progress"),
  v.literal("meeting_overran"),
  v.literal("payment_received"),
  v.literal("follow_up_scheduled"),
  v.literal("reschedule_link_sent"),
  v.literal("lost"),
  v.literal("canceled"),
  v.literal("no_show"),
),
```

**Step 2: Keep active status accounting wide until cleanup.**

```typescript
// Path: convex/lib/tenantStatsHelper.ts
const ACTIVE_OPPORTUNITY_STATUSES = new Set<Doc<"opportunities">["status"]>([
  "qualified_pending",
  "scheduled",
  "in_progress", // remove only after Phase 5 verifies zero legacy rows
  "meeting_overran", // remove only after Phase 5 verifies zero legacy rows
  "follow_up_scheduled",
  "reschedule_link_sent",
]);
```

**Step 3: Record the rule for implementers in the phase handoff.**

Do not change UI status config in Phase 1. Phase 3 and Phase 4 remove UI references after backend stops producing legacy statuses; Phase 6 deletes remaining type literals after data cleanup.

**Key implementation notes:**
- If a lint/refactor tool suggests deleting "unused" legacy statuses in this phase, reject the deletion.
- The final product contract and the migration-window data contract are deliberately different.
- This subphase should produce no code diff unless an implementer adds an inline comment.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Read / preserve | Keep legacy literals for data-at-rest compatibility |
| `convex/opportunities/validators.ts` | Read / preserve | Keep client/API validators wide |
| `convex/lib/tenantStatsHelper.ts` | Read / preserve | Keep active accounting correct for existing legacy rows |
| `lib/status-config.ts` | Read / preserve | UI cleanup happens later |

---

### 1D - Contract Verification

**Type:** Manual / Backend
**Parallelizable:** No - run after 1A-1C.

**What:** Verify the new transition contract is visible in code and that Phase 1 did not introduce forbidden writes.

**Why:** This is the last cheap point to catch a contract mismatch before Phase 2 begins updating many mutations.

**Where:**
- `convex/lib/statusTransitions.ts` (verify)
- `convex/lib/outcomeEligibility.ts` (verify)

**How:**

**Step 1: Grep for forbidden new-write transitions.**

```bash
# Path: shell
rg -n 'scheduled: \\[.*in_progress|scheduled: \\[.*meeting_overran' convex/lib/statusTransitions.ts
```

Expected result: no matches.

**Step 2: Grep for old lifecycle writes that still need Phase 2 work.**

```bash
# Path: shell
rg -n 'status: "in_progress"|status: "meeting_overran"|attendanceCheckId|startedAt|stoppedAt' convex app hooks lib --glob '!convex/_generated/**'
```

Expected result: matches still exist. Record them as Phase 2-6 work; do not remove them in Phase 1 except the transition-map changes from 1A.

**Step 3: Type-check.**

```bash
# Path: shell
pnpm tsc --noEmit
```

**Key implementation notes:**
- This subphase intentionally allows old writes to remain because Phase 2 owns them.
- The important Phase 1 invariant is "scheduled can reach outcomes" and "scheduled cannot reach new legacy lifecycle states."

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/phone-closer-overrun-refactor/phases/phase1.md` | Read / follow | Verification checklist |

---

### 1E - Deploy and Smoke Check

**Type:** Manual / Release
**Parallelizable:** No - deploy only after 1D passes.

**What:** Deploy the status contract and eligibility helper without changing production data.

**Why:** Phase 2 depends on the generated backend containing direct scheduled outcome transitions.

**Where:**
- Convex deployment (manual)

**How:**

**Step 1: Deploy.**

```bash
# Path: shell
npx convex deploy
```

Use the repo's normal production deployment command if it wraps `npx convex deploy`.

**Step 2: Confirm there was no data cleanup.**

```bash
# Path: shell
npx convex data --prod meetings --limit 5
npx convex data --prod opportunities --limit 5
```

This is a smoke check only. Legacy rows may still exist.

**Step 3: Confirm the app still loads.**

Sign in as the production test tenant closer and open a meeting detail route. Existing Start/End UI may still be visible until Phase 3; that is expected.

**Key implementation notes:**
- Do not run migrations in Phase 1.
- Do not delete `meetingReviews` or scheduled functions in Phase 1.
- If the deploy fails because of schema validation, this phase accidentally narrowed something. Revert that narrowing and redeploy the wide contract.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Convex deployment | Deploy | Backend contract only; no backfill |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/statusTransitions.ts` | Modify | 1A |
| `convex/lib/outcomeEligibility.ts` | Create | 1B |
| `convex/schema.ts` | Preserve / verify | 1C |
| `convex/opportunities/validators.ts` | Preserve / verify | 1C |
| `convex/lib/tenantStatsHelper.ts` | Preserve / verify | 1C |
| `lib/status-config.ts` | Preserve / verify | 1C |
