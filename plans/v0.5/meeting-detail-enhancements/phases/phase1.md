# Phase 1 — Schema & Backend

**Goal:** Add the `meetingOutcome` field to the `meetings` table, enrich the `getMeetingDetail` query to return proof file URLs and closer names inline, and add a new `updateMeetingOutcome` mutation. After this phase, the backend is ready to serve all data the frontend needs.

**Prerequisite:** v0.4 fully deployed. Feature G (UTM Tracking) complete — `utmParams` fields present on `meetings` and `opportunities` tables. `convex/lib/utmParams.ts` utility exists. Schema is deployable via `npx convex dev`.

**Runs in PARALLEL with:** Nothing — all subsequent phases (2, 3, 4) depend on this phase for generated types and backend functions.

**Skills to invoke:**
- Read `convex/_generated/ai/guidelines.md` before any Convex work — Convex coding standards, file storage API, system table access patterns.

**Acceptance Criteria:**
1. `npx convex dev` succeeds without schema errors after adding `meetingOutcome` to the `meetings` table.
2. The `meetingOutcome` field accepts exactly five literal values: `"interested"`, `"needs_more_info"`, `"price_objection"`, `"not_qualified"`, `"ready_to_buy"` — and `undefined` (not set).
3. Existing meetings have `meetingOutcome === undefined` with no data migration required.
4. `getMeetingDetail` returns each payment record enriched with `proofFileUrl` (signed URL or null), `proofFileContentType` (string or null), `proofFileSize` (number or null), and `closerName` (string or null).
5. When a payment has a `proofFileId`, `getMeetingDetail` resolves the URL via `ctx.storage.getUrl()` and metadata via `ctx.db.system.get()`.
6. When a payment has no `proofFileId`, the enriched fields are all `null`.
7. `updateMeetingOutcome` mutation validates tenant isolation and closer authorization (closers can only update their own meetings; admins can update any).
8. `updateMeetingOutcome` patches the meeting document with the selected outcome value.
9. Calling `updateMeetingOutcome` with `meetingOutcome: undefined` clears the outcome tag.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (Schema: meetingOutcome field) ─────────────────────────────────┐
                                                                    │
                                                                    ├── 1B (Query: enrich getMeetingDetail)
                                                                    │
                                                                    ├── 1C (Mutation: updateMeetingOutcome)
                                                                    │
                                                                    └── 1D (Deploy & verify)
```

**Optimal execution:**
1. Start 1A (schema change — must deploy first to generate types).
2. After 1A deploys → start 1B and 1C **in parallel** (they modify different files, no shared state).
3. After 1B and 1C complete → 1D (deploy + verify full backend).

**Estimated time:** ~30 minutes

---

## Subphases

### 1A — Schema: Add `meetingOutcome` to `meetings` Table

**Type:** Backend
**Parallelizable:** No — must complete first. All other subphases depend on the generated types from this schema change.

**What:** Add a new optional `meetingOutcome` field to the `meetings` table definition in `convex/schema.ts`.

**Why:** The meeting outcome classification is the foundation for I6 (Richer Notes). Without this field in the schema, TypeScript types are not generated and neither the query enrichment (1B) nor the mutation (1C) can compile. The field must deploy before any code references it.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add the `meetingOutcome` field to the `meetings` table**

Locate the `meetings: defineTable({...})` block in `convex/schema.ts` and add the new field after the existing `utmParams` field:

```typescript
// Path: convex/schema.ts

// BEFORE (end of meetings table definition):
    utmParams: v.optional(utmParamsValidator),
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_scheduledAt", ["tenantId", "scheduledAt"])
    .index("by_tenantId_and_calendlyEventUri", ["tenantId", "calendlyEventUri"]),

// AFTER:
    utmParams: v.optional(utmParamsValidator),

    // Feature I: Meeting outcome classification tag.
    // Set by the closer after a meeting via dropdown on the detail page.
    // Captures the lead's intent signal — independent of opportunity status.
    // Undefined = not yet classified.
    meetingOutcome: v.optional(
      v.union(
        v.literal("interested"),
        v.literal("needs_more_info"),
        v.literal("price_objection"),
        v.literal("not_qualified"),
        v.literal("ready_to_buy"),
      ),
    ),
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_scheduledAt", ["tenantId", "scheduledAt"])
    .index("by_tenantId_and_calendlyEventUri", ["tenantId", "calendlyEventUri"]),
```

**Step 2: Deploy the schema**

```bash
npx convex dev
```

Verify the `meetings` table shows the new `meetingOutcome` field in the Convex dashboard. Existing meetings will have `meetingOutcome: undefined`.

**Step 3: Schema coordination with Feature F**

Per the parallelization strategy, Feature I's schema deploys **first**, then Feature F's. If Feature F is working simultaneously, coordinate: deploy this schema change, wait for `npx convex dev` to succeed, then signal Feature F that it's safe to deploy their schema additions (to the `eventTypeConfigs` table — no overlap).

**Key implementation notes:**
- The field is `v.optional(...)` — no data migration needed. Existing documents are unchanged.
- No new indexes are required. The outcome is never queried independently — it's always read as part of the meeting document via `getMeetingDetail`.
- The five literal values match the v0.5 spec (Section I6): "Interested", "Needs more info", "Price objection", "Not qualified", "Ready to buy" — normalized to snake_case for consistency with the rest of the schema.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add `meetingOutcome` optional union field to `meetings` table |

---

### 1B — Query: Enrich `getMeetingDetail` with Proof File URLs and Closer Names

**Type:** Backend
**Parallelizable:** Yes — independent of 1C. Both modify different files after schema (1A) deploys.

**What:** Modify the `getMeetingDetail` query in `convex/closer/meetingDetail.ts` to resolve proof file signed URLs, file metadata (content type, size), and the closer name for each payment record.

**Why:** The Deal Won card (Phase 2) needs to display payment proof files inline and show "Recorded By" information. Currently, `getMeetingDetail` returns raw `paymentRecords` with just a `proofFileId` — the frontend would need N additional `getPaymentProofUrl` calls to resolve URLs. Resolving inline is more efficient (single query, no extra subscriptions) and provides file metadata needed for image-vs-PDF rendering.

**Where:**
- `convex/closer/meetingDetail.ts` (modify)

**How:**

**Step 1: Define the enriched payment type**

Add a type for the enriched payment data at the top of the file, below the existing `MeetingHistoryEntry` type:

```typescript
// Path: convex/closer/meetingDetail.ts

type MeetingHistoryEntry = Doc<"meetings"> & {
  opportunityStatus: Doc<"opportunities">["status"];
  isCurrentMeeting: boolean;
};

// NEW: Enriched payment with proof file URL and closer info
type EnrichedPayment = Doc<"paymentRecords"> & {
  proofFileUrl: string | null;
  proofFileContentType: string | null;
  proofFileSize: number | null;
  closerName: string | null;
};
```

**Step 2: Replace the payment loading loop**

In the `getMeetingDetail` handler, replace the existing payment loading section (currently uses a simple `payments: Doc<"paymentRecords">[]` array) with the enriched version:

```typescript
// Path: convex/closer/meetingDetail.ts

    // BEFORE:
    // const payments: Doc<"paymentRecords">[] = [];
    // const paymentRecords = ctx.db
    //   .query("paymentRecords")
    //   .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id));
    // for await (const payment of paymentRecords) {
    //   if (payment.tenantId === tenantId) {
    //     payments.push(payment);
    //   }
    // }
    // payments.sort((a, b) => b.recordedAt - a.recordedAt);

    // AFTER:
    const payments: EnrichedPayment[] = [];
    const paymentRecords = ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", opportunity._id),
      );

    for await (const payment of paymentRecords) {
      if (payment.tenantId !== tenantId) continue;

      // Resolve proof file URL and metadata from Convex file storage
      let proofFileUrl: string | null = null;
      let proofFileContentType: string | null = null;
      let proofFileSize: number | null = null;

      if (payment.proofFileId) {
        proofFileUrl = await ctx.storage.getUrl(payment.proofFileId);
        // Query the _storage system table for file metadata (contentType, size)
        const fileMeta = await ctx.db.system.get(payment.proofFileId);
        if (fileMeta) {
          proofFileContentType = fileMeta.contentType ?? null;
          proofFileSize = fileMeta.size ?? null;
        }
      }

      // Resolve the closer who recorded this payment
      let closerName: string | null = null;
      const closer = await ctx.db.get(payment.closerId);
      if (closer && closer.tenantId === tenantId) {
        closerName = closer.fullName ?? closer.email;
      }

      payments.push({
        ...payment,
        proofFileUrl,
        proofFileContentType,
        proofFileSize,
        closerName,
      });
    }
    payments.sort((a, b) => b.recordedAt - a.recordedAt);
```

**Step 3: Update the log line to reflect enrichment**

```typescript
// Path: convex/closer/meetingDetail.ts

    console.log("[Closer:MeetingDetail] getMeetingDetail completed", {
      meetingId,
      meetingHistoryCount: meetingHistory.length,
      paymentCount: payments.length,
      hasEventType: !!eventTypeName,
      hasPaymentLinks: !!paymentLinks,
      hasUtmParams: !!(meeting.utmParams || opportunity.utmParams),
    });
```

**Key implementation notes:**
- `ctx.storage.getUrl(proofFileId)` returns `null` if the file has been deleted — handle gracefully by setting `proofFileUrl = null`.
- `ctx.db.system.get(proofFileId)` accesses the `_storage` system table. Per the Convex guidelines (`convex/_generated/ai/guidelines.md`), this is the correct way to get file metadata. Do NOT use the deprecated `ctx.storage.getMetadata()`.
- The return type signature does not need to change — Convex infers the return type from the handler. The `payments` array now has richer elements, and the client-side `MeetingDetailData` type in the page client will need to be updated in Phase 4.
- Performance: 1-2 payments per opportunity is expected. The extra `ctx.db.get(closerId)` and `ctx.storage.getUrl()` calls add negligible latency for this cardinality.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingDetail.ts` | Modify | Add `EnrichedPayment` type; enrich payment loop with proof URL, file metadata, closer name |

---

### 1C — Mutation: `updateMeetingOutcome`

**Type:** Backend
**Parallelizable:** Yes — independent of 1B. Modifies a different file (`meetingActions.ts` vs `meetingDetail.ts`).

**What:** Add a new `updateMeetingOutcome` mutation to `convex/closer/meetingActions.ts` that sets or clears the `meetingOutcome` field on a meeting.

**Why:** The meeting outcome dropdown (Phase 3) needs a backend mutation to persist the closer's selection. The mutation follows the same authorization pattern as `updateMeetingNotes` (same file, same auth checks) — closers can only update their own meetings; admins can update any.

**Where:**
- `convex/closer/meetingActions.ts` (modify)

**How:**

**Step 1: Add the `updateMeetingOutcome` mutation**

Add after the existing `markAsLost` mutation at the bottom of the file:

```typescript
// Path: convex/closer/meetingActions.ts

/**
 * Set or clear the meeting outcome classification.
 *
 * The outcome is a structured tag that captures the closer's assessment
 * of the lead's intent after a meeting. It's separate from the
 * opportunity status (which tracks the deal lifecycle).
 *
 * Pass `undefined` for meetingOutcome to clear the tag.
 *
 * Only the assigned closer or an admin can update the outcome.
 */
export const updateMeetingOutcome = mutation({
  args: {
    meetingId: v.id("meetings"),
    meetingOutcome: v.optional(
      v.union(
        v.literal("interested"),
        v.literal("needs_more_info"),
        v.literal("price_objection"),
        v.literal("not_qualified"),
        v.literal("ready_to_buy"),
      ),
    ),
  },
  handler: async (ctx, { meetingId, meetingOutcome }) => {
    console.log("[Closer:MeetingActions] updateMeetingOutcome called", {
      meetingId,
      meetingOutcome,
    });
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const { opportunity } = await loadMeetingContext(ctx, meetingId, tenantId);

    // Closer authorization: only own meetings
    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    await ctx.db.patch(meetingId, { meetingOutcome });
    console.log("[Closer:MeetingActions] meetingOutcome updated", {
      meetingId,
      meetingOutcome,
    });
  },
});
```

**Key implementation notes:**
- Reuses the existing `loadMeetingContext` helper (defined at the top of `meetingActions.ts`) which loads the meeting + opportunity and validates tenant isolation.
- Authorization mirrors `updateMeetingNotes` exactly: closers restricted to their assigned meetings, admins unrestricted.
- `v.optional(v.union(...))` allows passing `undefined` to clear the outcome. Convex's `ctx.db.patch` with `meetingOutcome: undefined` removes the field from the document.
- No status validation needed — the outcome tag is independent of the meeting/opportunity status machine. A closer can tag any meeting regardless of its lifecycle stage.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingActions.ts` | Modify | Add `updateMeetingOutcome` mutation |

---

### 1D — Deploy & Verify Full Backend

**Type:** Manual / Config
**Parallelizable:** No — must run after 1B and 1C to verify the complete backend state.

**What:** Deploy all backend changes and verify the full `getMeetingDetail` query returns enriched data correctly.

**Why:** Quality gate before frontend phases begin. Ensures generated types are correct and queries return the expected shape.

**Where:**
- No file changes — verification only.

**How:**

**Step 1: Deploy**

```bash
npx convex dev
```

**Step 2: Verify type generation**

```bash
pnpm tsc --noEmit
```

Must pass without errors. The generated `api` types should now include `updateMeetingOutcome` and the enriched payment shape.

**Step 3: Verify in Convex dashboard**

- Open the Convex dashboard → Functions → `closer/meetingDetail:getMeetingDetail`.
- Run the query with a valid `meetingId` that has a payment with a proof file.
- Verify the response includes `proofFileUrl` (a signed URL string), `proofFileContentType`, `proofFileSize`, and `closerName` in the payment records.
- Verify `meeting.meetingOutcome` is `undefined` for existing meetings.

**Step 4: Verify the new mutation exists**

- In the Convex dashboard → Functions → `closer/meetingActions:updateMeetingOutcome`.
- Run it with a valid `meetingId` and `meetingOutcome: "interested"`.
- Verify the meeting document now has `meetingOutcome: "interested"`.
- Run it again with `meetingOutcome: undefined` to clear.

**Key implementation notes:**
- If Feature F has schema changes pending, coordinate: deploy I's changes first, verify, then Feature F deploys theirs.
- The generated `Doc<"meetings">` type should now include `meetingOutcome?: "interested" | "needs_more_info" | "price_objection" | "not_qualified" | "ready_to_buy"`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (none) | — | Verification-only subphase |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 1A |
| `convex/closer/meetingDetail.ts` | Modify | 1B |
| `convex/closer/meetingActions.ts` | Modify | 1C |
