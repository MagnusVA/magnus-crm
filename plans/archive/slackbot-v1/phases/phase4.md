# Phase 4 — Calendly ↔ Slack Join

**Goal:** Close the loop. When Calendly's `invitee.created` webhook resolves a booking to a lead that already has an open `qualified_pending` opportunity from Slack, attach the meeting to that pre-existing opportunity (transitioning it to `scheduled`) instead of creating a duplicate. After this phase, the metric "Slack-qualified → booked-meeting conversion" becomes computable end-to-end.

**Prerequisite:** Phase 3 complete:
- `opportunities.status` accepts `"qualified_pending"` and `opportunities.source` accepts `"slack_qualified"` (3A schema widen).
- `validateTransition("qualified_pending", "scheduled")` returns `true` (3B widening).
- The composite index `by_tenantId_and_leadId_and_source_and_status_and_createdAt` exists on `opportunities` (3A).
- `resolveLeadIdentity` accepts optional email and creates social-handle-only leads (3C); `syncLeadFromBooking` backfills `lead.email` from `inviteeEmail` when matched (3C Step 6).
- `createQualifiedLead.create` writes the `qualified_pending` opportunity rows that this phase will attach to (3D + 3G).

**Runs in PARALLEL with:** Phase 5 (channel notifications + stale digest — zero shared files). Phase 6 starts after Phase 5 and consumes the join signal produced here for metrics.

> **Critical path:** This phase is on the critical path for the **product-value claim**. Phases 1–3 produce qualified-pending opportunities; Phase 4 is the *only* phase whose absence makes those opportunities meaningless. Lone Phase 3 lands the data; Phase 4 makes it convertible.

> **Smallest phase by LOC, largest by leverage.** ~80–120 lines of code added in two files; transforms two disconnected funnels (Slack qualification + Calendly booking) into one. Per [`slackbot-design.md` §7.1](../slackbot-design.md): "Single branch, large effect."

**Skills to invoke:**
- `convex-performance-audit` — *recommended after this phase ships* — verify the new dedup-style query inside `inviteeCreated.process` is hitting the composite index (Phase 3 3A) and not adding measurable latency to the Calendly webhook hot path. The webhook ingestion is already a critical path; the new branch must not slow it.
- `design-doc-review` — *recommended before merge* — review the modified `inviteeCreated.process` against the §7.3 edge-case table to confirm every case has a code branch. Catches missed edge cases before tenants hit them.

**Acceptance Criteria:**
1. Slack-qualify a lead with Instagram handle `@janetest`, then book a Calendly meeting whose custom handle answer also yields `@janetest`. Verify exactly **one** opportunity exists for that lead, with `source: "slack_qualified"`, `status: "scheduled"`, and the new meeting attached. **No second opportunity** is created.
2. Book a Calendly meeting from a fresh email (`bob@acme.com`) that was never Slack-qualified. Verify a fresh opportunity is created with `source: "calendly"`, `status: "scheduled"` — exactly as today. (No regression of the Calendly-only path.)
3. Slack-qualify a lead with **only an Instagram handle** (`@janetest`, no email). Then book a Calendly meeting whose invitee email is unrelated (`other@acme.com`) but whose Calendly-question answer fields yield the same normalized `@janetest`. Verify the join still succeeds via the social-handle path; verify `lead.email` is backfilled to `other@acme.com` per Phase 3 3C Step 6.
4. Book a Calendly meeting that matches a `qualified_pending` opportunity created **31 days ago**. Verify a fresh opportunity is created (past `SLACK_JOIN_LOOKBACK_MS = 30 days`), not a join. The old `qualified_pending` row remains open.
5. The existing `existingFollowUp` reuse path (lines ~1406–1462 of `inviteeCreated.ts`) is **unchanged when no eligible Slack opp exists**. If both a recent `qualified_pending` Slack opp and a `follow_up_scheduled` opp exist for the same lead, the Slack opp takes priority by design; verify that precedence explicitly.
6. The branch logs `[Pipeline:invitee.created] Slack-qualified opportunity joined | opportunityId=… leadId=…` on every successful join.
7. The branch emits a `domainEvents` row with `eventType: "slack_qualified_lead_booked"`, `fromStatus: "qualified_pending"`, `toStatus: "scheduled"`, `metadata: { leadId, meetingId }` — joinable by Phase 6 metrics.
8. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (lookup helper) ────────┐
                            ├── 4C (E2E test gates — manual)
4B (inviteeCreated branch) ─┘
```

**Optimal execution:**
1. **4A** + **4B** can land in the same PR because they touch different files but logically depend on each other (4B imports 4A's helper). Reviewer prefers them together.
2. **4C** is the manual end-to-end QA gate — fires after the PR merges to dev. Tenant-facing prod deploy gated on these checks passing.

**Estimated time:** 2–3 days. Code is small; the time goes into:
- Reading the existing 1600-line `inviteeCreated.ts` to find the right insertion point and *not* break the existing reuse paths.
- Running the four test scenarios in 4C against real Calendly + real Slack — the Calendly side requires the test helper from `convex/testing/calendly.ts` (`bookTestInvitee`).

---

## Subphases

### 4A — Slack Opportunity Lookup Helper

**Type:** Backend (utility)
**Parallelizable:** Yes — independent of 4B's logic location, but 4B imports it.

**What:** A small typed helper `findOpenSlackQualifiedOpportunity(ctx, { tenantId, leadId })` that returns the most recent open `qualified_pending` opportunity for the given `(tenantId, leadId)` within the lookback window, or `null`. Lives in a new file `convex/pipeline/slackJoinLookup.ts` so the modification in 4B reads as a single function call rather than an inline query block.

**Why:** Three reasons to extract:
1. **Locality** — `inviteeCreated.process` is already 1600+ lines. Adding 30 inline lines for a lookup makes the diff harder to review than a 5-line call.
2. **Testability** — the helper is callable from a one-off action for E2E verification (4C).
3. **Reuse** — Phase 5's confirmation-message path may need the same lookup (e.g. to disambiguate which opportunity a confirmation refers to). Centralizing avoids duplicating the index name.

**Where:**
- `convex/pipeline/slackJoinLookup.ts` (new)

**How:**

**Step 1: Implement the helper**

```typescript
// Path: convex/pipeline/slackJoinLookup.ts

import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Window for joining a Calendly booking to a previously Slack-qualified
 * opportunity. After this, treat as cold lead — create a fresh opportunity.
 * Per slackbot-design.md §7.3 edge-case table.
 */
export const SLACK_JOIN_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Finds the most recent OPEN slack-qualified opportunity for `leadId`, eligible
 * to be joined by an incoming Calendly booking.
 *
 * Eligibility:
 *   - Same tenant.
 *   - source = "slack_qualified".
 *   - status = "qualified_pending" (still open — not booked, not lost).
 *   - createdAt within `SLACK_JOIN_LOOKBACK_MS` (30 days).
 *
 * Pre-Phase 3 callers won't compile (the literal `"qualified_pending"` doesn't exist).
 *
 * The query is bound to the composite index added in Phase 3 3A
 * `by_tenantId_and_leadId_and_source_and_status_and_createdAt`.
 */
export async function findOpenSlackQualifiedOpportunity(
  ctx: QueryCtx | MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    /** For tests — defaults to `Date.now()`. */
    referenceTime?: number;
    /** For tests — defaults to `SLACK_JOIN_LOOKBACK_MS`. */
    lookbackMs?: number;
  },
): Promise<Doc<"opportunities"> | null> {
  const ref = args.referenceTime ?? Date.now();
  const lookback = args.lookbackMs ?? SLACK_JOIN_LOOKBACK_MS;
  const cutoff = ref - lookback;

  return await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId_and_source_and_status_and_createdAt", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("leadId", args.leadId)
        .eq("source", "slack_qualified")
        .eq("status", "qualified_pending")
        .gt("createdAt", cutoff))
    .order("desc")  // most-recent first
    .first();
}
```

**Step 2: Verify the index is hit**

The composite index from 3A is exactly `[tenantId, leadId, source, status, createdAt]`. Convex's `.withIndex` requires the prefix match in declared order — our `q.eq → q.eq → q.eq → q.eq → q.gt` traversal hits all five fields. Verify with the Convex dashboard's "Query analyzer" (or `npx convex insights` after a few real calls in dev) that this query reports as indexed, not as a scan.

**Step 3: Spot-check from a temporary action**

```typescript
// Path: convex/slack/_temp_joinLookupTest.ts (REMOVE after verification)
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

export const test = internalAction({
  args: { tenantId: v.id("tenants"), leadId: v.id("leads") },
  handler: async (ctx, args) => {
    return await ctx.runQuery(internal.pipeline._temp_joinLookupQuery.lookup, args);
  },
});
```

```typescript
// Path: convex/pipeline/_temp_joinLookupQuery.ts (REMOVE after verification)
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { findOpenSlackQualifiedOpportunity } from "./slackJoinLookup";

export const lookup = internalQuery({
  args: { tenantId: v.id("tenants"), leadId: v.id("leads") },
  handler: async (ctx, args) => {
    return await findOpenSlackQualifiedOpportunity(ctx, args);
  },
});
```

```bash
# Path: terminal — after Phase 3D has produced at least one qualified_pending row
npx convex run slack/_temp_joinLookupTest:test '{"tenantId":"<id>","leadId":"<id>"}'
# Expect: the row, or null if nothing qualifies.
```

Delete both `_temp_*` files when satisfied.

**Key implementation notes:**
- **Function takes `QueryCtx | MutationCtx`** so it can be called from `inviteeCreated.process` (which is a mutation) and from any future query.
- **`SLACK_JOIN_LOOKBACK_MS` is exported** so Phase 5 / 6 can refer to the same constant if they ever need to align UI hints with this branch's behavior.
- **The `referenceTime` and `lookbackMs` arguments are for testing only** — production callers omit them. Convex doesn't have a global mockable clock; passing the time in is the only way to write a deterministic test.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/slackJoinLookup.ts` | Create | The lookup helper + the lookback constant |

---

### 4B — `inviteeCreated.process` Slack-Join Branch

**Type:** Backend (modification of the central pipeline mutation)
**Parallelizable:** No — single insertion point in `inviteeCreated.process`. Tiny diff but reviewer needs context. Pair with 4A in the same PR.

**What:** Modify `convex/pipeline/inviteeCreated.ts:process` (the existing 1600-line mutation that ingests Calendly's `invitee.created` event) to look for an open Slack-qualified opportunity *before* falling through to the existing follow-up-reuse / fresh-create branches. If found, attach the meeting to it instead.

**Why:** Per [§7.2](../slackbot-design.md), this is the closed-loop step. The existing process at line ~1406 has two branches:
1. Reuse an `existingFollowUp` opportunity (status `follow_up_scheduled`) if one exists for this lead.
2. Otherwise, create a new opportunity with `source: "calendly"`.

Phase 4 inserts a new branch **above** these two: if a `qualified_pending` Slack opportunity exists for the lead, transition it to `scheduled` and attach the meeting. The existing two branches handle every other case.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify — single insertion point near line 1406)

**How:**

**Step 1: Read the existing mutation around line 1406**

Open `convex/pipeline/inviteeCreated.ts` and locate the section that begins around line 1403–1463:

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// EXISTING — DO NOT MODIFY. Reproduced here for branch-insertion context.

let opportunityId: Id<"opportunities">;
let meetingEventTypeConfigId: Id<"eventTypeConfigs"> | undefined =
  eventTypeConfigId;
if (existingFollowUp) {
  // ... patch existing follow-up to scheduled, line 1406-1462 ...
  opportunityId = existingFollowUp._id;
  // ... etc ...
} else {
  // Fresh opportunity — line 1463-1500
  opportunityId = await ctx.db.insert("opportunities", {
    tenantId,
    leadId: lead._id,
    // ... rest ...
    source: "calendly",
    // ...
  });
  // ...
}
```

The new branch lives *above* `if (existingFollowUp)`. If a Slack-qualified opportunity exists, it claims the booking; otherwise the existing logic runs unchanged.

**Step 2: Add imports at the top of the file**

```typescript
// Path: convex/pipeline/inviteeCreated.ts (top imports)

// EXISTING imports unchanged. ADD:
import { findOpenSlackQualifiedOpportunity } from "./slackJoinLookup";
```

**Step 3: Insert the new branch**

Insert **before** `if (existingFollowUp)` (i.e. at the `let opportunityId:` declaration; insert *between* the `let opportunityId` declaration and the `if (existingFollowUp)`):

```typescript
// Path: convex/pipeline/inviteeCreated.ts (NEW — inserted just above line 1406)

  // ── Slack join branch (Phase 4) ───────────────────────────────────────
  // If the same lead has an open `qualified_pending` Slack opportunity within
  // the 30-day lookback, attach this booking to it instead of creating a fresh
  // opportunity. This closes the loop on the Slack-qualified → booked metric.
  // Per slackbot-design.md §7.2.
  let slackJoinEventOpportunityId: Id<"opportunities"> | undefined;
  const slackOpp = await findOpenSlackQualifiedOpportunity(ctx, {
    tenantId,
    leadId: lead._id,
  });

  if (slackOpp) {
    if (!validateTransition(slackOpp.status, "scheduled")) {
      throw new Error(
        "[Pipeline] Invalid slack-qualified opportunity transition to scheduled",
      );
    }

    opportunityId = slackOpp._id;
    meetingEventTypeConfigId =
      eventTypeConfigId ?? slackOpp.eventTypeConfigId ?? undefined;

    // Calendly assigned-closer wins over the (unset) Slack opportunity. The
    // Slack opportunity has no assignedCloserId on creation — we set it now.
    const nextAssignedCloserId =
      assignedCloserId ?? slackOpp.assignedCloserId ?? meetingAssignedCloserId;

    await patchOpportunityLifecycle(ctx, opportunityId, {
      status: "scheduled",
      calendlyEventUri,
      assignedCloserId: nextAssignedCloserId,
      hostCalendlyUserUri: hostUserUri,
      hostCalendlyEmail,
      hostCalendlyName,
      eventTypeConfigId: meetingEventTypeConfigId,
      updatedAt: now,
      // utmParams intentionally omitted — preserve Slack-side attribution.
      // The new meeting captures its own UTMs independently.
    });

    // If we picked up a closer here that wasn't on the opportunity before,
    // sync any meetings already attached (there shouldn't be any for a
    // qualified_pending opp, but the helper is idempotent).
    if (nextAssignedCloserId !== slackOpp.assignedCloserId) {
      await syncOpportunityMeetingsAssignedCloser(
        ctx,
        opportunityId,
        nextAssignedCloserId,
      );
    }

    // Emit the join domain event after the existing meeting insert below, once
    // `meetingId` is available for metadata.
    slackJoinEventOpportunityId = opportunityId;

    console.log(
      "[Pipeline:invitee.created] Slack-qualified opportunity joined | " +
      `opportunityId=${opportunityId} leadId=${lead._id} ` +
      `slackOppCreatedAt=${new Date(slackOpp.createdAt).toISOString()} ` +
      `qualifiedBy=${slackOpp.qualifiedBy?.slackUserId ?? "unknown"}`,
    );
  } else if (existingFollowUp) {
    // ── EXISTING branch — no logic change ────────────────────────────────
    // (Move the existing if-existingFollowUp body here; line 1407-1462 verbatim.)
    if (!validateTransition(existingFollowUp.status, "scheduled")) {
      throw new Error(
        "[Pipeline] Invalid follow-up opportunity transition",
      );
    }
    opportunityId = existingFollowUp._id;
    meetingEventTypeConfigId =
      eventTypeConfigId ??
      existingFollowUp.eventTypeConfigId ??
      undefined;
    const nextAssignedCloserId =
      assignedCloserId ?? existingFollowUp.assignedCloserId;
    const closerChanged =
      nextAssignedCloserId !== existingFollowUp.assignedCloserId;
    await patchOpportunityLifecycle(ctx, opportunityId, {
      status: "scheduled",
      calendlyEventUri,
      assignedCloserId: nextAssignedCloserId,
      hostCalendlyUserUri: hostUserUri,
      hostCalendlyEmail,
      hostCalendlyName,
      eventTypeConfigId: meetingEventTypeConfigId,
      updatedAt: now,
    });
    if (closerChanged) {
      await syncOpportunityMeetingsAssignedCloser(
        ctx,
        opportunityId,
        nextAssignedCloserId,
      );
    }
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.status_changed",
      source: "pipeline",
      fromStatus: existingFollowUp.status,
      toStatus: "scheduled",
      occurredAt: now,
    });
    console.log(
      `[Pipeline:invitee.created] Follow-up opportunity reused | opportunityId=${opportunityId} status=follow_up_scheduled->scheduled`,
    );
    await ctx.runMutation(
      internal.closer.followUpMutations.markFollowUpBooked,
      {
        opportunityId,
        calendlyEventUri,
      },
    );
  } else {
    // ── EXISTING branch — fresh opportunity insert (no change) ───────────
    opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId: lead._id,
      assignedCloserId: meetingAssignedCloserId,
      hostCalendlyUserUri: hostUserUri,
      hostCalendlyEmail,
      hostCalendlyName,
      eventTypeConfigId,
      status: "scheduled",
      source: "calendly",
      calendlyEventUri,
      createdAt: now,
      updatedAt: now,
      latestActivityAt: now,
      utmParams,
      potentialDuplicateLeadId: resolution.potentialDuplicateLeadId,
    });
    await insertOpportunityAggregate(ctx, opportunityId);
    await updateTenantStats(ctx, tenantId, {
      totalOpportunities: 1,
      activeOpportunities: 1,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.created",
      source: "pipeline",
      toStatus: "scheduled",
      metadata: { leadId: lead._id },
      occurredAt: now,
    });
    console.log(
      `[Pipeline:invitee.created] New opportunity created | opportunityId=${opportunityId}`,
    );
  }
```

**Step 4: Emit the Slack join domain event after the meeting insert**

Do **not** emit `slack_qualified_lead_booked` inside the branch above. The acceptance criterion requires `metadata.meetingId`, and that ID does not exist until the existing post-branch meeting insert runs.

Locate the existing `ctx.db.insert("meetings", ...)` later in `inviteeCreated.process`. Immediately after the insert returns `meetingId`, add:

```typescript
if (slackJoinEventOpportunityId) {
  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "opportunity",
    entityId: slackJoinEventOpportunityId,
    eventType: "slack_qualified_lead_booked",       // Phase 6: metric source
    source: "pipeline",
    fromStatus: "qualified_pending",
    toStatus: "scheduled",
    metadata: {
      leadId: lead._id,
      meetingId,
    },
    occurredAt: now,
  });
}
```

This keeps the `if-else if-else` branch structure intact while making the domain event complete and queryable.

**Step 5: Branch precedence — confirmed correct**

The if-else-if-else chain orders Slack-join *first*, then existing follow-up, then fresh-create. Justification:

- A lead with both a `qualified_pending` Slack opp **and** a `follow_up_scheduled` Calendly opp should be rare after Phase 3's active-opportunity guard, but it can still exist from legacy/dev data or concurrent requests.
- Joining to the Slack opportunity is the right behavior when both rows exist: the Slack qualification is the explicit pending conversion target, and joining it gives the conversion-metric credit.
- If product disagrees, the `else if (existingFollowUp)` clause can swap order — but document the decision in this PR.

**Step 6: Confirm `tenantStats` aren't double-counted**

In the **fresh-create** branch we call `updateTenantStats(ctx, tenantId, { totalOpportunities: 1, activeOpportunities: 1 })`. In the **Slack-join** branch (and the **existingFollowUp** branch) we *do not* — because the opportunity was already counted at creation time:
- 3D's `createQualifiedLead.create` increments `activeOpportunities` when it inserts the `qualified_pending` row.
- Phase 4's transition `qualified_pending → scheduled` keeps it active (both states are in `ACTIVE_OPPORTUNITY_STATUSES` per 3B).
- `totalOpportunities` is a lifetime count — incremented once at insert, not per status change.

If `updateTenantStats` is double-called here, Phase 6's metric becomes wrong. Confirm by running 4C Step 1 (happy path) and observing `tenants.activeOpportunities` increments by exactly 1 across the qualify + book.

**Step 7: Lead-side: ensure `lead.email` backfill on Slack-then-Calendly join**

This is **already handled in 3C Step 6** — `syncLeadFromBooking` patches `lead.email` when the matched lead was created without one. Double-check that the path Phase 4 takes runs `syncLeadFromBooking` (it should — it's part of the existing pipeline). If not, add a defensive call here:

```typescript
// (Inside the slackOpp branch, BEFORE patchOpportunityLifecycle)
if (lead.email === undefined && inviteeEmail) {
  // Existing helper; idempotent.
  await syncLeadFromBooking(ctx, lead._id, { inviteeEmail });
}
```

**Step 8: Verify**

```bash
# Path: terminal
pnpm tsc --noEmit
# Should pass — the new literal `"qualified_pending"` is in OpportunityStatus per 3B.
```

Run a Calendly webhook against a lead that already has a `qualified_pending` Slack opp:

```bash
# Per TESTING.MD — use the Calendly test helper to book against the test tenant.
npx convex run testing/calendly:bookTestInvitee \
  '{"tenantId":"<id>","eventTypeUri":"<uri>","inviteeName":"Jane","email":"jane@acme.com"}'
# This generates a real Calendly webhook against the dev Convex deployment.
```

Verify the join occurred:

```bash
npx convex data opportunities | grep slack_qualified
# Should show 1 row, status: "scheduled" (joined!), with calendlyEventUri populated.

npx convex data domainEvents | grep slack_qualified_lead_booked
# Should show 1 row.
```

**Key implementation notes:**
- **The new branch is `if-else if-else`, not `if + early return`.** Early-returning would skip the post-branch logic that runs for all three cases (meeting insert, opportunity refs update, etc.). Keeping the structure parallel preserves correctness.
- **`emitDomainEvent` with `eventType: "slack_qualified_lead_booked"`** is intentionally a distinct event type from the existing `opportunity.status_changed`. Emit it after the meeting insert so `metadata.meetingId` is present; Phase 6 can then count booked joins from complete domain events.
- **`utmParams` is preserved** — the slack opp's UTMs are `undefined` (Slack doesn't have UTMs); the new meeting captures Calendly UTMs independently. The opportunity does not get retroactively-attributed Calendly UTMs.
- **The 30-day lookback is by `createdAt`, not `latestActivityAt`.** A `qualified_pending` opp that's stale by activity (no Slack engagement in 25 days) but still within the createdAt window is eligible. Activity-aware lookback adds complexity without product value in v1.
- **Why does this branch run *before* `existingFollowUp`?** A lead with both a stale follow-up *and* a recent Slack qualification: the Slack signal is more recent and more intentional. Joining to it gives the conversion-credit and makes UI ordering match user intent. Edge case is rare; document the decision; revisit if user feedback says otherwise.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Add `findOpenSlackQualifiedOpportunity` import + insert new branch above `existingFollowUp` |

---

### 4C — End-to-End Test Gates

**Type:** Manual QA
**Parallelizable:** No — runs after 4A + 4B are deployed to dev. Pre-prod gate.

**What:** Five end-to-end test scenarios that validate the entire Slack→Calendly product hypothesis. **No code in this subphase.** The gate is the design doc's [§7.4 test gates](../slackbot-design.md): if these fail, the feature has zero value regardless of how well the rest is built.

**Why:** Per [`AGENTS.md` § Testing](../../../AGENTS.md), this codebase relies on manual QA. The Calendly + Slack integration cannot be verified in isolation — it needs the real test helpers and the real Convex deployment. Skipping this subphase would mean shipping the feature blind.

**Where:** No project files. Verification target: dev Slack workspace + dev Convex + Calendly sandbox.

**How:**

> **You must run all five scenarios.** A pass on 1 + 2 alone is not enough — the social-handle path (3) is the most common Slack v1 case, and the dedup edge (5) is the most failure-prone.

**Pre-flight: confirm test fixtures**

```bash
# Path: terminal
# 1. Confirm the dev Slack installation is active.
npx convex data slackInstallations
#   tenantId, status=active, tokenExpiresAt > now+1h.

# 2. Confirm Calendly test helper exists.
ls convex/testing/calendly.ts
#   File should exist; export `bookTestInvitee` per TESTING.MD.

# 3. Confirm a test event-type URI is configured for the dev tenant.
npx convex data eventTypeConfigs
#   Note one calendlyEventTypeUri to use as the booking target.
```

**Step 1: Happy path — social-handle match**

1. In dev Slack, run `/qualify-lead` with: full name `Jane Test`, platform Instagram, handle `@janetest`. Submit.
2. Confirm the opportunity row exists:
   ```bash
   npx convex data opportunities | grep slack_qualified
   # 1 row: status=qualified_pending, qualifiedBy.slackUserId set.
   ```
3. Use the Calendly test helper to book with a matching custom handle answer:
   ```bash
   npx convex run testing/calendly:bookTestInvitee \
     '{"tenantId":"<id>","eventTypeUri":"<calendly-uri>","inviteeName":"Jane Test","email":"jane.test@acme.com","questionAnswers":{"instagram":"@janetest"}}'
   ```
4. Wait ~3 seconds for the Calendly webhook to land + process.
5. Verify:
   ```bash
   npx convex data opportunities | grep slack_qualified
   #   Still 1 row — but status=scheduled now. calendlyEventUri populated.
   npx convex data meetings | tail -1
   #   1 new meeting, opportunityId points at the same row.
   npx convex data domainEvents | grep slack_qualified_lead_booked
   #   1 new event.
   ```

✅ **Pass**: 1 opportunity, transitioned `qualified_pending → scheduled`, meeting attached, conversion event emitted.
❌ **Fail**: 2 opportunities (one Slack, one Calendly). The social-handle branch ordering is wrong or the lookup helper is misindexed.

**Step 2: No-regression — Calendly-only path**

1. Use the test helper to book a meeting from a fresh email **never** Slack-qualified:
   ```bash
   npx convex run testing/calendly:bookTestInvitee \
     '{"tenantId":"<id>","eventTypeUri":"<uri>","inviteeName":"Bob","email":"bob.fresh@acme.com"}'
   ```
2. Verify:
   ```bash
   npx convex data opportunities | tail -1
   #   1 fresh row: source=calendly, status=scheduled.
   ```

✅ **Pass**: Calendly-only path is unchanged — fresh opportunity, source `calendly`.
❌ **Fail**: The Slack-join branch is incorrectly catching cases it shouldn't.

**Step 3: Social-handle join with Calendly email backfill**

1. Run `/qualify-lead`: full name `Carol Social`, platform Instagram, handle `@carolsocial`. Submit.
2. Confirm:
   ```bash
   npx convex data leads | tail -1
   #   1 lead: fullName=Carol Social, email undefined.
   npx convex data leadIdentifiers | grep slack_qualified
   #   1 identifier: type=instagram, value=@carolsocial.
   npx convex data opportunities | grep slack_qualified
   #   1 row: qualified_pending.
   ```
3. **Configure the Calendly event type** in the dev sandbox to ask "Instagram handle" as a question (or whatever question field Calendly supports for social-handle capture in your sandbox config).
4. Book against an unrelated email but the same handle:
   ```bash
   # Adjust args based on your test helper's signature for adding question answers:
   npx convex run testing/calendly:bookTestInvitee \
     '{"tenantId":"<id>","eventTypeUri":"<uri>","inviteeName":"Carol","email":"different@acme.com","questionAnswers":{"instagram":"@carolsocial"}}'
   ```
5. Verify:
   ```bash
   npx convex data opportunities | grep slack_qualified
   #   Same row, now scheduled. (NOT 2 rows.)
   npx convex data leads | tail -1
   #   email field is now populated with "different@acme.com" (3C Step 6 backfill).
   ```

✅ **Pass**: Social-handle resolution joined the Slack opp; email backfilled.
❌ **Fail**: Two opportunities exist. The resolver's social-handle path or the backfill path is broken.

**Step 4: Out-of-window check — past `SLACK_JOIN_LOOKBACK_MS`**

1. Synthetically backdate a `qualified_pending` opportunity. Use a temporary Convex action:
   ```typescript
   // Path: convex/slack/_temp_backdateOpp.ts (REMOVE after verification)
   import { v } from "convex/values";
   import { internalMutation } from "../_generated/server";

   export const backdate = internalMutation({
     args: { id: v.id("opportunities"), ageDays: v.number() },
     handler: async (ctx, args) => {
       const past = Date.now() - args.ageDays * 24 * 60 * 60 * 1000;
       await ctx.db.patch(args.id, { createdAt: past });
     },
   });
   ```
2. Slack-qualify a fresh lead, then run:
   ```bash
   npx convex run slack/_temp_backdateOpp:backdate '{"id":"<oppId>","ageDays":31}'
   ```
3. Book a Calendly meeting with a matching custom handle answer.
4. Verify:
   ```bash
   npx convex data opportunities | grep <leadId>
   #   2 rows: original Slack (qualified_pending, 31 days old) and new Calendly (scheduled, fresh).
   ```

✅ **Pass**: Stale Slack opp left untouched; fresh Calendly opp created.
❌ **Fail**: Single row joined despite stale window — the lookback constant or the index `gt(createdAt, cutoff)` clause is wrong.

5. Delete the `_temp_backdateOpp.ts` file.

**Step 5: Dedup edge — second Slack qualification of an already-qualified lead**

1. Slack-qualify a lead. (`/qualify-lead` with handle `@dedup_test`.) Note the opportunity's `qualifiedBy.slackUserId` (your dev Slack user).
2. From the **same** Slack workspace (different user is harder to set up; same user reproduces the path), run `/qualify-lead` again with the same handle.
3. Verify:
   - Modal stays open with inline error: `"Already qualified by <@U…> 0 days ago."` (or omitted-duration variant per 3G implementation note).
   - `npx convex data opportunities | grep dedup_test` shows **only 1 row**.

✅ **Pass**: Dedup guard fired; user sees actionable inline error.
❌ **Fail**: Two rows. 3D's dedup index query is misindexed or the lookback comparison is wrong.

**Step 6: Document findings**

Append a one-line ✅/❌ result per scenario to the team's QA log. Phase 4 is **not done** until all five pass on dev.

**Promotion to prod**: Phase 4 code may deploy after all five scenarios pass on dev. The public Slack launch still waits for Phase 5 + Phase 6 and the final go-live gate. Re-run these five scenarios against prod with a real Slack workspace install + a real Calendly account before activating Public Distribution.

**Key implementation notes:**
- **Scenario 3 is the hardest to set up** because it requires a Calendly event type configured to capture a social handle as a question. If your dev Calendly sandbox doesn't have one, configure it in the Calendly dashboard before running this test (see Calendly's "Booking page → Questions" setup). This setup work is a one-time investment for ongoing QA.
- **Scenario 4's `_temp_backdateOpp.ts`** is a development-only escape hatch. Delete it before merging. (Phase 6 may add a similar admin-only mutation as part of the metrics tooling; for now it's a temp.)
- **Scenario 5 with two distinct Slack users** is more realistic than same-user but harder to set up — a single dev account is fine for v1 verification. If product wants the cross-user message tested, manually add a second dev Slack user; otherwise rely on the field-level UX (the inline error is a single string template, identical across submitters).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/_temp_backdateOpp.ts` | Create + delete | Temporary dev helper for Scenario 4 |
| (manual QA log — external) | Append | One ✅/❌ per scenario |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/pipeline/slackJoinLookup.ts` | Create | 4A |
| `convex/pipeline/inviteeCreated.ts` | Modify | 4B |
| (manual QA — `_temp_*.ts` created and deleted) | Verify | 4C |
| (team QA log) | Manual | 4C |
