# Phase 2 — Pipeline Extraction: `inviteeCreated`

**Goal:** Modify the `inviteeCreated` pipeline handler to extract the `tracking` object from Calendly's webhook payload and store it as `utmParams` on the created meeting and opportunity. UTM data flows into the CRM automatically with every new booking.

**Prerequisite:** Phase 1 complete — the `utmParams` fields must exist on both tables and the schema must be deployed.

**Runs in PARALLEL with:** Nothing — Phase 3 depends on this implementation (to add logging on cancel/no-show handlers).

**Skills to invoke:**
- `simplify` — After implementation, review the modified `inviteeCreated.ts` for code quality and consistency with existing extraction patterns.

**Acceptance Criteria:**
1. `convex/lib/utmParams.ts` includes the `extractUtmParams(tracking: unknown): UtmParams | undefined` helper function.
2. `convex/pipeline/inviteeCreated.ts` imports the extraction helper and calls it on `payload.tracking`.
3. The extracted `utmParams` is passed to the meeting insert call (new opportunities).
4. The extracted `utmParams` is passed to the new opportunity insert call.
5. Follow-up opportunity patches intentionally omit `utmParams` (preserving original attribution) — confirmed via comment in the code.
6. Structured logs are added showing UTM extraction results (`[Pipeline:invitee.created] UTM extraction | ...`).
7. A development-only debug query `convex/pipeline/debugUtm.ts` is created for verification.
8. Manual test: Trigger a Calendly booking with `?utm_source=test&utm_medium=manual` and verify the meeting/opportunity document includes `utmParams: { utm_source: "test", utm_medium: "manual" }`.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (Extraction helper)  ───────────────────────────────┐
                                                       ├── 2C (Deploy and test)
2B (Modify inviteeCreated.ts + debug query) ──────────┤
                                                       │
2B also depends on 2A (import the helper)             │
                                                       │
                                        2C complete ──→ 2D (Manual verification)
```

**Optimal execution:**
1. Complete 2A (extraction helper with all edge case handling).
2. Complete 2B (update inviteeCreated.ts, add debug query) — depends on 2A being done.
3. Complete 2C (deploy and verify TypeScript).
4. Complete 2D (manual test with a real or simulated Calendly booking).

**Estimated time:** 1–2 days (implementation + testing).

---

## Subphases

### 2A — UTM Extraction Helper

**Type:** Backend
**Parallelizable:** Yes — independent utility function. Does not depend on pipeline modifications.

**What:** Extend `convex/lib/utmParams.ts` (created in Phase 1) with the `extractUtmParams(tracking: unknown): UtmParams | undefined` helper function. This function handles all edge cases: missing, null, malformed, or partial tracking objects.

**Why:** The extraction logic needs to be robust against all variants of Calendly's tracking payload. Centralizing it in a helper makes the pipeline code cleaner, testable, and reusable. The helper is called from `inviteeCreated`, and potentially from other handlers in future phases.

**Where:**
- `convex/lib/utmParams.ts` (modify — add helper function)

**How:**

**Step 1: Add the extraction helper**

Add the following function to the existing `convex/lib/utmParams.ts` (after the `UtmParams` type definition):

```typescript
// Path: convex/lib/utmParams.ts

/**
 * Extract and validate UTM parameters from a Calendly tracking object.
 *
 * Handles all edge cases from the Calendly API:
 * - tracking is missing (undefined/null) → returns undefined
 * - tracking is not an object → returns undefined
 * - individual fields are null (Calendly sends null, not undefined) → omitted
 * - individual fields are non-string → omitted
 * - all fields are null/missing → returns undefined (no empty objects)
 *
 * @param tracking - The raw `payload.tracking` value from the webhook
 * @returns UtmParams object if any UTM field has a value, undefined otherwise
 */
export function extractUtmParams(tracking: unknown): UtmParams | undefined {
  if (typeof tracking !== "object" || tracking === null || Array.isArray(tracking)) {
    return undefined;
  }

  const record = tracking as Record<string, unknown>;
  const result: UtmParams = {};
  let hasAnyValue = false;

  const fields = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
  ] as const;

  for (const field of fields) {
    const value = record[field];
    // Calendly sends null for empty UTM fields — treat as absent
    if (typeof value === "string" && value.length > 0) {
      result[field] = value;
      hasAnyValue = true;
    }
  }

  // Return undefined instead of empty object when no UTMs are present
  return hasAnyValue ? result : undefined;
}
```

**Key implementation notes:**
- The function checks three cases where tracking is not a valid object: `typeof tracking !== "object"`, `tracking === null`, or `Array.isArray(tracking)`.
- Calendly sends `null` for empty UTM fields, not `undefined`. We check `typeof value === "string" && value.length > 0` to filter out both null and empty strings.
- We accumulate fields in a `result` object and only return it if `hasAnyValue` is true. This ensures we return `undefined` (field absent) when there are no UTMs, not an empty object.
- The `as const` on the `fields` array ensures TypeScript knows the field names are literal strings matching the validator keys.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/utmParams.ts` | Modify | Add `extractUtmParams` helper function |

---

### 2B — Modify `inviteeCreated` Pipeline Handler

**Type:** Backend
**Parallelizable:** No — depends on 2A (imports the helper).

**What:** Update `convex/pipeline/inviteeCreated.ts` to extract the tracking object and store it on meetings and opportunities. Call the helper immediately after extracting other fields, log the result, and pass the `utmParams` to both insert/patch calls.

**Why:** This is the core delivery mechanism — every new booking from Calendly flows through this handler. By adding UTM extraction here, all meetings and opportunities automatically get attribution data.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify)

**How:**

**Step 1: Import the extraction helper**

At the top of `convex/pipeline/inviteeCreated.ts`, add the import:

```typescript
// Path: convex/pipeline/inviteeCreated.ts

import { extractUtmParams } from "../lib/utmParams";
```

**Step 2: Extract UTM parameters**

Locate the field extraction section in the `process` handler (around line 174, after extracting other fields like `questionsAndAnswers`). Add the following code:

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// Inside the process handler, after other field extractions

    // ── NEW: Extract UTM tracking parameters ──
    const utmParams = extractUtmParams(payload.tracking);
    console.log(
      `[Pipeline:invitee.created] UTM extraction | ` +
      `hasUtm=${!!utmParams} ` +
      `source=${utmParams?.utm_source ?? "none"} ` +
      `medium=${utmParams?.utm_medium ?? "none"} ` +
      `campaign=${utmParams?.utm_campaign ?? "none"}`
    );
```

**Step 3: Add `utmParams` to the new opportunity insert**

Locate the new opportunity insert call (around line 275). It looks like:

```typescript
      opportunityId = await ctx.db.insert("opportunities", {
        tenantId,
        leadId: lead._id,
        assignedCloserId,
        hostCalendlyUserUri: hostUserUri,
        hostCalendlyEmail,
        hostCalendlyName,
        eventTypeConfigId,
        status: "scheduled",
        calendlyEventUri,
        createdAt: now,
        updatedAt: now,
      });
```

Add `utmParams,` to the insert object:

```typescript
      opportunityId = await ctx.db.insert("opportunities", {
        tenantId,
        leadId: lead._id,
        assignedCloserId,
        hostCalendlyUserUri: hostUserUri,
        hostCalendlyEmail,
        hostCalendlyName,
        eventTypeConfigId,
        status: "scheduled",
        calendlyEventUri,
        createdAt: now,
        updatedAt: now,
        utmParams,  // NEW: First booking's attribution
      });
```

**Step 4: Add `utmParams` to the meeting insert**

Locate the meeting insert call (around line 299). It looks like:

```typescript
    const meetingId = await ctx.db.insert("meetings", {
      tenantId,
      opportunityId,
      calendlyEventUri,
      calendlyInviteeUri,
      zoomJoinUrl,
      scheduledAt,
      durationMinutes,
      status: "scheduled",
      notes: meetingNotes,
      leadName: lead.fullName ?? lead.email,
      createdAt: now,
    });
```

Add `utmParams,` to the insert object:

```typescript
    const meetingId = await ctx.db.insert("meetings", {
      tenantId,
      opportunityId,
      calendlyEventUri,
      calendlyInviteeUri,
      zoomJoinUrl,
      scheduledAt,
      durationMinutes,
      status: "scheduled",
      notes: meetingNotes,
      leadName: lead.fullName ?? lead.email,
      createdAt: now,
      utmParams,  // NEW: UTM attribution from Calendly tracking object
    });
```

**Step 5: Verify follow-up opportunity patch intentionally omits `utmParams`**

Locate the follow-up opportunity patch (around line 252). It should look like:

```typescript
      await ctx.db.patch(opportunityId, {
        status: "scheduled",
        calendlyEventUri,
        assignedCloserId,
        hostCalendlyUserUri: hostUserUri,
        hostCalendlyEmail,
        hostCalendlyName,
        eventTypeConfigId:
          eventTypeConfigId ?? existingFollowUp.eventTypeConfigId ?? undefined,
        updatedAt: now,
      });
```

Confirm that `utmParams` is **NOT** in this patch call. Add a comment if it's not already there:

```typescript
      await ctx.db.patch(opportunityId, {
        status: "scheduled",
        calendlyEventUri,
        assignedCloserId,
        hostCalendlyUserUri: hostUserUri,
        hostCalendlyEmail,
        hostCalendlyName,
        eventTypeConfigId:
          eventTypeConfigId ?? existingFollowUp.eventTypeConfigId ?? undefined,
        updatedAt: now,
        // NOTE: utmParams intentionally NOT included here.
        // The opportunity preserves attribution from its original creation.
        // The new meeting stores its own UTMs independently.
      });
```

**Key implementation notes:**
- The extraction happens once, early in the handler, before both the new opportunity and new meeting branches.
- The structured log includes `hasUtm` boolean and the first three UTM fields (most important for debugging). The log is tagged `[Pipeline:invitee.created]` for filtering in dashboards.
- Both insert calls receive the same `utmParams` value. The meeting and opportunity have independent copies.
- The follow-up opportunity patch **intentionally omits** `utmParams` to preserve the original attribution. This is documented with a comment.
- The extraction and logging add minimal overhead (~1ms) to the existing pipeline handler.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Add import, extraction call, logging, and field inserts |

---

### 2C — Create Debug Query

**Type:** Backend
**Parallelizable:** Yes — independent utility. Does not depend on modifications to inviteeCreated.ts.

**What:** Create `convex/pipeline/debugUtm.ts` with a development-only internal query that lists recent meetings and their UTM status. This is used for verification during testing.

**Why:** Before Phase 3 (UI) is implemented, developers need a way to inspect the UTM data that was extracted and stored. This debug query provides direct access to the raw data without needing to write custom Convex dashboard queries each time.

**Where:**
- `convex/pipeline/debugUtm.ts` (new)

**How:**

**Step 1: Create the debug query file**

```typescript
// Path: convex/pipeline/debugUtm.ts

import { internalQuery } from "../_generated/server";
import { v } from "convex/values";

/**
 * Debug query: list recent meetings and their UTM status.
 * DEVELOPMENT ONLY — Use from Convex dashboard to verify UTM extraction is working.
 * This query is not part of the production API.
 */
export const recentMeetingUtms = internalQuery({
  args: { tenantId: v.id("tenants"), limit: v.optional(v.number()) },
  handler: async (ctx, { tenantId, limit }) => {
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId),
      )
      .order("desc")
      .take(limit ?? 10);

    return meetings.map((m) => ({
      _id: m._id,
      scheduledAt: new Date(m.scheduledAt).toISOString(),
      leadName: m.leadName,
      hasUtm: !!m.utmParams,
      utmParams: m.utmParams ?? null,
    }));
  },
});
```

**Key implementation notes:**
- This is an `internalQuery`, not a public query. It's callable only from the Convex dashboard or internal handlers, not from the frontend.
- The query takes a `tenantId` and optional `limit` (defaults to 10 meetings).
- Results are sorted by `scheduledAt` descending (newest first).
- Each result shows the meeting ID, scheduled time, lead name, a boolean `hasUtm`, and the full `utmParams` object.
- The query is tagged as "DEVELOPMENT ONLY" in comments. For cleanup, delete this file after Phase 2 verification, or gate it behind a feature flag.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/debugUtm.ts` | Create | Development-only debug query |

---

### 2D — Deploy and Verify TypeScript

**Type:** Backend
**Parallelizable:** No — must occur after 2A and 2B are complete.

**What:** Deploy the modified `inviteeCreated.ts`, import of the helper in 2A, and the new debug query. Run TypeScript compilation to ensure all imports and types are correct.

**Why:** Deployment makes the UTM extraction live. TypeScript verification ensures there are no import or type errors before going to production.

**Where:**
- Convex dev/production environment
- TypeScript compiler (`pnpm tsc`)

**How:**

**Step 1: Run TypeScript compilation**

```bash
pnpm tsc --noEmit
```

Should pass without errors. If there are errors, check:
- Is the import path correct? (`import { extractUtmParams } from "../lib/utmParams"`)
- Is the function exported from `convex/lib/utmParams.ts`?
- Are type annotations correct in the debug query?

**Step 2: Deploy to Convex (dev or production)**

```bash
# For development:
npx convex dev

# For production:
npx convex deploy
```

The deployment should succeed. No schema changes are happening in this phase (all schema changes were in Phase 1).

**Step 3: Verify in the Convex dashboard**

1. Open the Convex dashboard.
2. Navigate to **Functions** → search for `recentMeetingUtms` (the debug query).
3. Click into it and run it with a test tenant ID. You should see a list of recent meetings (before real bookings with UTMs, all will show `hasUtm: false`).

**Key implementation notes:**
- No breaking changes to existing API. The modifications to `inviteeCreated.ts` are purely additive — the function signature and return type remain unchanged.
- The import of `extractUtmParams` resolves at runtime (no separate compilation step).
- The debug query is available immediately after deployment and can be used for testing.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Convex deployment environment | N/A | Functions deployed; no rollback needed if successful |

---

### 2E — Manual Test with Calendly Booking

**Type:** Manual / Testing
**Parallelizable:** No — must occur after 2D is deployed and verified.

**What:** Trigger a real or simulated Calendly booking with UTM parameters in the booking URL. Inspect the resulting meeting and opportunity documents in the Convex dashboard to confirm `utmParams` was extracted and stored correctly.

**Why:** This is the functional verification that end-to-end UTM extraction works. Manual testing ensures the pipeline correctly processes real Calendly payloads before moving to Phase 3.

**Where:**
- Calendly platform (test event)
- Convex dashboard (data inspection)

**How:**

**Step 1: Generate a test booking URL with UTMs**

Use your dev/staging Calendly event type. Append UTM parameters:

```
https://calendly.com/{your-event-type}?utm_source=test&utm_medium=manual&utm_campaign=phase2_verify
```

**Step 2: Complete a test booking**

Visit the URL in your browser and complete the booking form. Calendly will fire the `invitee.created` webhook to your dev Convex backend.

**Step 3: Inspect the created meeting**

1. Open the Convex dashboard.
2. Navigate to **Data** → **meetings** table.
3. Find the meeting you just created (should be at the top, sorted by creation time).
4. Click into the document and verify the `utmParams` field shows:
   ```json
   {
     "utm_source": "test",
     "utm_medium": "manual",
     "utm_campaign": "phase2_verify"
   }
   ```

**Step 4: Inspect the created/updated opportunity**

1. In the same dashboard, navigate to **Data** → **opportunities** table.
2. Find the opportunity linked to your test lead (filter by the lead's email if needed).
3. Click into the document and verify `utmParams` matches the meeting.

**Step 5: Check the structured logs**

1. In the Convex dashboard, navigate to **Logs** or **Function Logs**.
2. Filter for `[Pipeline:invitee.created]` or search for your test lead's email.
3. Confirm the log entry shows:
   ```
   [Pipeline:invitee.created] UTM extraction | hasUtm=true source=test medium=manual campaign=phase2_verify
   ```

**Step 6: Test edge cases (optional)**

To verify robustness, create additional test bookings with:
- No UTM parameters at all (`?` omitted or empty query string) — should result in `hasUtm=false`, `utmParams: undefined` on document.
- Partial UTMs (`?utm_source=facebook` only) — should result in `utmParams: { utm_source: "facebook" }`.
- Extra parameters (`?utm_source=test&unrelated_param=value`) — should ignore the extra parameter.

**Key implementation notes:**
- Manual testing with real Calendly webhooks is the most reliable verification. It exercises the full payload parsing, extraction, validation, and database write.
- If the test booking does not appear in the CRM, check:
  - Is the dev Convex backend running (`npx convex dev`)?
  - Is the webhook registered on the test Calendly event type?
  - Do the Convex logs show an error in the pipeline processor?
- If `utmParams` is missing from the resulting document, check:
  - Was the extraction helper deployed? (`pnpm tsc --noEmit` passes?)
  - Are the import paths in `inviteeCreated.ts` correct?
  - Do the logs show the extraction was attempted?

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Convex dashboard (inspection only) | N/A | No code changes; manual verification only |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/utmParams.ts` | Modify | 2A |
| `convex/pipeline/inviteeCreated.ts` | Modify | 2B |
| `convex/pipeline/debugUtm.ts` | Create | 2C |

