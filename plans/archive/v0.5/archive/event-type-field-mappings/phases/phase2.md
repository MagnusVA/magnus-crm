# Phase 2 — Auto-Discovery of Custom Field Keys

**Goal:** The pipeline automatically discovers custom field keys (question texts) from incoming Calendly bookings and stores them on the corresponding `eventTypeConfig`. After this phase, each `eventTypeConfig` accumulates a `knownCustomFieldKeys` array that grows with every new booking, enabling the Settings UI (Phase 4) to populate field-mapping dropdowns from real data.

**Prerequisite:** Phase 1 complete — `customFieldMappings` and `knownCustomFieldKeys` fields exist on `eventTypeConfigs` in the deployed schema.

**Runs in PARALLEL with:** Phase 3 (Backend Mutation & Query). Phase 2 modifies `convex/pipeline/inviteeCreated.ts`; Phase 3 modifies `convex/eventTypeConfigs/mutations.ts` and `convex/eventTypeConfigs/queries.ts`. **Zero file overlap.** Both can start immediately after Phase 1 deploys.

> **Not on the critical path.** The critical path is Phase 1 → Phase 3 → Phase 4. Phase 2 is an independent stream that can complete at any time before the final quality gate. However, completing Phase 2 early means real booking data populates `knownCustomFieldKeys` sooner, which is needed to test Phase 4's dropdown UI.

> **Pipeline file ownership:** Per `plans/v0.5/feature-area-parallelization-strat.md`, Feature F's pipeline changes go at the **end** of `inviteeCreated.ts`, in a clearly delimited `// === Feature F ===` block. No other Feature F phase touches this file. Future features (A, E, B in Window 2+) modify earlier sections of the same file — merge order is F → A → E → B.

**Skills to invoke:**
- None required — this is a small, focused backend modification to an existing pipeline handler.

**Acceptance Criteria:**
1. When an `invitee.created` webhook fires for an event type that has an `eventTypeConfig` AND the booking has `questions_and_answers`, the config's `knownCustomFieldKeys` is updated with any newly discovered question texts.
2. If all question keys are already in `knownCustomFieldKeys`, no database write occurs (idempotent).
3. Keys are appended in discovery order (new keys added to the end of the array).
4. If the booking has no `questions_and_answers` (or it's empty), the discovery block is skipped — no error, no write.
5. If the event type has no corresponding `eventTypeConfig` record, the discovery block is skipped.
6. Existing pipeline processing (lead creation, opportunity creation, meeting creation, UTM extraction) is completely unaffected.
7. The discovery logic runs **before** the `processed: true` patch so the entire operation remains atomic within the Convex mutation transaction.
8. Log output includes `[Pipeline:invitee.created] [Feature F] Auto-discovered N new custom field key(s)` when new keys are found.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (Add discovery logic to inviteeCreated.ts) ────── 2B (Deploy & verify)
```

**Optimal execution:**
1. Complete 2A (add the auto-discovery block).
2. Deploy via `npx convex dev` and verify with a real or simulated webhook (2B).

**Estimated time:** 30-45 minutes

---

## Subphases

### 2A — Add Auto-Discovery Block to `inviteeCreated.ts`

**Type:** Backend
**Parallelizable:** No — 2B depends on this. However, this subphase runs in parallel with all Phase 3 subphases (different files).

**What:** Add a ~20-line code block at the end of the `process` handler in `convex/pipeline/inviteeCreated.ts` that extracts question keys from the current booking and updates the event type config's `knownCustomFieldKeys` if new keys are found.

**Why:** The field mapping UI (Phase 4) needs to display dropdown options populated from real Calendly form questions. Without auto-discovery, admins would need to manually type question texts — error-prone and poor UX. Auto-discovery ensures that as soon as the first booking arrives for an event type, the system knows what questions Calendly asked.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify — append to end of handler)

**How:**

**Step 1: Locate the insertion point**

The discovery block goes **before** the final `await ctx.db.patch(rawEventId, { processed: true })` line. Currently the end of the handler looks like this (lines 326-334):

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// CURRENT end of handler (lines 326-334):

    // Update denormalized meeting refs on opportunity for efficient queries
    // (see @plans/caching/caching.md)
    await updateOpportunityMeetingRefs(ctx, opportunityId);
    console.log(`[Pipeline:invitee.created] Updated opportunity meeting refs | opportunityId=${opportunityId}`);

    await ctx.db.patch(rawEventId, { processed: true });
    console.log(`[Pipeline:invitee.created] Marked processed | rawEventId=${rawEventId}`);
  },
});
```

**Step 2: Insert the auto-discovery block between the meeting refs update and the `processed: true` patch**

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// AFTER modification — insert between meeting refs update and processed patch:

    // Update denormalized meeting refs on opportunity for efficient queries
    // (see @plans/caching/caching.md)
    await updateOpportunityMeetingRefs(ctx, opportunityId);
    console.log(`[Pipeline:invitee.created] Updated opportunity meeting refs | opportunityId=${opportunityId}`);

    // === Feature F: Auto-discover custom field keys ===
    // If this booking had questions_and_answers AND we have an eventTypeConfig,
    // ensure the config's knownCustomFieldKeys includes all question texts from this booking.
    // This populates the dropdown options in Settings > Field Mappings.
    if (latestCustomFields && eventTypeConfigId) {
      const incomingKeys = Object.keys(latestCustomFields);
      if (incomingKeys.length > 0) {
        const config = await ctx.db.get(eventTypeConfigId);
        if (config) {
          const existingKeys = config.knownCustomFieldKeys ?? [];
          const existingSet = new Set(existingKeys);
          const newKeys = incomingKeys.filter((k) => !existingSet.has(k));

          if (newKeys.length > 0) {
            const updatedKeys = [...existingKeys, ...newKeys];
            await ctx.db.patch(eventTypeConfigId, {
              knownCustomFieldKeys: updatedKeys,
            });
            console.log(
              `[Pipeline:invitee.created] [Feature F] Auto-discovered ${newKeys.length} new custom field key(s) | configId=${eventTypeConfigId} newKeys=${JSON.stringify(newKeys)} totalKeys=${updatedKeys.length}`,
            );
          }
        }
      }
    }
    // === End Feature F ===

    await ctx.db.patch(rawEventId, { processed: true });
    console.log(`[Pipeline:invitee.created] Marked processed | rawEventId=${rawEventId}`);
  },
});
```

**Key implementation notes:**
- **Variables already in scope:** `latestCustomFields` (line 176, `Record<string, string> | undefined`) and `eventTypeConfigId` (line 215-227, `Id<"eventTypeConfigs"> | undefined`). No new arguments or imports needed.
- **`ctx.db.get(eventTypeConfigId)`** is a point read by document ID — O(1), no index needed. This is a second read of the config (first was the lookup at line 217-223 by URI index). We re-read here because the earlier lookup only retrieved the `_id`; we need the `knownCustomFieldKeys` field. An alternative is to store the full config doc at line 222, but that would require refactoring the variable scope — not worth it for this small addition.
- **Set-based deduplication:** `new Set(existingKeys)` ensures O(1) lookup per incoming key. For typical Calendly forms (5-10 questions), this is negligible, but it's correct regardless of array size.
- **Append-only:** New keys are appended to the end of the array (`[...existingKeys, ...newKeys]`). This preserves discovery order. The UI dropdown in Phase 4 can sort alphabetically for display if desired.
- **Transaction atomicity:** This code runs inside the existing `process` internalMutation. The `ctx.db.patch(eventTypeConfigId, ...)` and the subsequent `ctx.db.patch(rawEventId, { processed: true })` are part of the same Convex transaction. If either fails, both roll back.
- **OCC safety:** If two webhooks for the same event type arrive simultaneously, Convex's OCC retry will handle the write conflict on `knownCustomFieldKeys` transparently — the retried transaction re-reads the config (which now includes the first webhook's keys) and computes the correct union.
- **Comment boundaries:** The `// === Feature F ===` and `// === End Feature F ===` markers are required by the parallelization strategy for merge conflict prevention. Future features (A, E, B) that modify this file will have their own clearly delimited blocks at different locations.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Add ~20 lines before the final `processed: true` patch |

---

### 2B — Deploy and Verify Auto-Discovery

**Type:** Manual / Config
**Parallelizable:** No — depends on 2A.

**What:** Deploy the updated pipeline handler and verify that auto-discovery works by triggering a booking (or replaying a webhook) for an event type that has custom questions.

**Why:** Auto-discovery runs on a live webhook code path. Verifying it works end-to-end before Phase 4 starts ensures the field-mapping dropdowns will have data to display.

**Where:**
- Terminal (commands only)
- Convex dashboard (data verification)

**How:**

**Step 1: Deploy**

```bash
npx convex dev
pnpm tsc --noEmit
```

**Step 2: Trigger a booking or replay a webhook**

Option A — **Trigger a real booking:** Book a test meeting on a Calendly event type that has custom form questions (e.g., "What's your Instagram?"). Wait for the webhook to fire.

Option B — **Replay a raw event:** If a `rawWebhookEvents` record exists with `processed: true` from a prior booking that had `questions_and_answers`, temporarily reset it:

```bash
# In Convex dashboard → rawWebhookEvents → find a processed event for the target event type
# Set processed: false → the cron/scheduler will re-process it
# OR manually trigger via Convex dashboard function runner:
# internal.pipeline.processor.processRawEvent({ rawEventId: "<id>" })
```

**Step 3: Verify in Convex dashboard**

Navigate to the `eventTypeConfigs` table in the Convex dashboard. Find the config for the event type that was booked. Verify:
- `knownCustomFieldKeys` is populated with the question texts from the booking
- The array contains the expected question strings (e.g., `["What's your Instagram?", "How did you hear about us?"]`)
- No other fields on the config were modified

**Step 4: Verify idempotency**

Trigger a second booking for the same event type with the same form questions. Verify:
- `knownCustomFieldKeys` is unchanged (no duplicates)
- Convex function logs do NOT contain `[Feature F] Auto-discovered` (because no new keys were found)

**Step 5: Verify skip behavior**

Check that the discovery block is skipped when:
- The event type has no `eventTypeConfig` (booking for an unconfigured event type) → no error in logs
- The booking has no `questions_and_answers` (event type with no custom questions) → no error in logs

**Key implementation notes:**
- If no test event type with custom questions exists, create one in Calendly first (add 2-3 custom questions to any event type).
- The Convex function logs (`npx convex logs` or Convex dashboard → Logs) will show the `[Feature F] Auto-discovered` message if new keys were found.
- If replaying a webhook, ensure the `rawWebhookEvents` record has `processed: false` before triggering re-processing.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (none) | — | This subphase is verification only |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | 2A |
