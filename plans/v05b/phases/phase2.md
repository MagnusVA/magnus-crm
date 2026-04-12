# Phase 2 — Backfill + Data Cleanup

| Field | Value |
| --- | --- |
| **Goal** | Fill all new fields (added in Phase 1) with correct data. Deduplicate and clean orphaned records. Extract booking answers from `rawWebhookEvents` before 30-day retention cron deletes them. |
| **Prerequisite** | Phase 1 complete — all 5 new tables deployed, all 15 optional fields added, all 24 indexes live |
| **Runs in PARALLEL with** | Phase 5 (OAuth State Extraction) — zero shared data, independent table targets |
| **Skills to invoke** | `convex-migration-helper` — widen-migrate-narrow migration scripts |
| **Breaking change risk** | **Zero.** Only writes to new/optional fields. No reads changed. No schema narrowing. |
| **Data footprint** | 1 tenant, ~200 leads, 213 meetings, 213 opportunities, ~50 payments, 288 raw webhook events, ~5 users |

---

## Acceptance Criteria

1. Every `leads` row has `status` defined (zero rows where `status === undefined`).
2. Every `users` row has `isActive: true` (zero rows where `isActive === undefined`).
3. Every `meetings` row with a parent opportunity that has `assignedCloserId` also has `meetings.assignedCloserId` set to the same value.
4. Every `paymentRecords` row has `amountMinor` set to `Math.round(amount * 100)` and `contextType` set to `"opportunity"` or `"customer"`.
5. Every `customers` row has `totalPaidMinor`, `totalPaymentCount`, and `paymentCurrency` populated from linked non-disputed payment records.
6. Every `followUps` row has `type` defined — inferred as `"scheduling_link"` (if `schedulingLinkUrl` present) or `"manual_reminder"`.
7. A `tenantStats` document exists for each active tenant with accurate counts matching source tables.
8. Zero duplicate `eventTypeConfigs` exist per `(tenantId, calendlyEventTypeUri)` key, and all `opportunities.eventTypeConfigId` references point to the surviving canonical record.
9. `meetingFormResponses` rows exist for every `rawWebhookEvents` record of type `invitee.created` that contains `questions_and_answers` data, with correct meeting/opportunity/lead linkage.
10. Audit scripts produce logs confirming zero orphaned tenant-scoped rows, zero orphaned user references, and a single-currency-per-tenant payment model (or documented exceptions).
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
Phase 1 complete
       |
       v
  +---------+
  |   2A    |  CRITICAL: Booking answers backfill (must beat 30-day retention)
  +---------+
       |
       v  (can start immediately after Phase 1, parallel with 2A)
  +---------+     +---------+
  |   2B    |     |   2E    |
  | Simple  |     | Dedup & |
  | fields  |     | cleanup |
  +---------+     +---------+
       |               |
       v               |
  +---------+          |
  |   2C    |          |
  | Related |          |
  | fields  |          |
  +---------+          |
       |               |
       v               v
  +---------+
  |   2D    |  (depends on 2B + 2C — needs accurate data for summary)
  | Summary |
  | seeding |
  +---------+
       |
       v
  +---------+
  |   2F    |  (validation — runs last, confirms everything)
  |  Audit  |
  +---------+
       |
       v
  Phase 2 complete --> Phase 3
```

**Parallelism**: 2A runs first (time-critical). 2B and 2E can run in parallel with each other (and with 2A if desired). 2C depends on 2B. 2D depends on 2B + 2C. 2F runs last.

---

## Subphase 2A — CRITICAL: Booking Answers Backfill from Raw Webhook Events

| Field | Value |
| --- | --- |
| **Type** | Data migration (internalAction + supporting internalQuery/internalMutation) |
| **Parallelizable** | No — must run FIRST. Time-critical: `rawWebhookEvents` older than 30 days are deleted by `convex/webhooks/cleanup.ts` on a 24-hour cron cycle. Once deleted, booking answers are irrecoverable. |
| **Item** | 2.12 |
| **Finding** | F2 — `leads.customFields` untyped blob loses per-interaction provenance |

### What

Extract `questions_and_answers` from every retained `invitee.created` raw webhook event and insert normalized rows into the new `meetingFormResponses` table. Also seed `eventTypeFieldCatalog` entries for discovered field keys.

### Why

The 30-day cleanup cron (`convex/crons.ts` line 28, running `internal.webhooks.cleanup.cleanupExpiredEvents` every 24 hours) permanently deletes processed raw webhook events older than 30 days. The `meetingFormResponses` table (Phase 1) is empty. If we don't extract booking answers before the cron runs, historical Q&A data is lost forever. The oldest events in the system may already be approaching the retention window.

### Where

- `convex/admin/migrations.ts` (new file — all Phase 2 migration scripts live here)

### How

**Step 1**: Create the helper query to fetch invitee.created events for a tenant.

```typescript
// Path: convex/admin/migrations.ts
import { v } from "convex/values";
import { internalQuery, internalMutation, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

export const getRawEventsForBackfill = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    // Fetch all invitee.created events — these contain questions_and_answers
    const events = await ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_tenantId_and_eventType", (q) =>
        q.eq("tenantId", tenantId).eq("eventType", "invitee.created"),
      )
      .collect();
    console.log(
      `[Migration:2A] Found ${events.length} invitee.created events for tenant ${tenantId}`,
    );
    return events;
  },
});
```

**Step 2**: Create the helper query to look up a meeting by its Calendly event URI.

```typescript
// Path: convex/admin/migrations.ts
export const getMeetingByCalendlyUri = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    calendlyEventUri: v.string(),
  },
  handler: async (ctx, { tenantId, calendlyEventUri }) => {
    const meeting = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventUri", calendlyEventUri),
      )
      .first();
    return meeting;
  },
});
```

**Step 3**: Create the mutation to insert a single form response row.

```typescript
// Path: convex/admin/migrations.ts
export const insertFormResponse = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    meetingId: v.id("meetings"),
    opportunityId: v.id("opportunities"),
    leadId: v.string(),
    fieldKey: v.string(),
    questionLabelSnapshot: v.string(),
    answerText: v.string(),
    capturedAt: v.number(),
  },
  handler: async (ctx, args) => {
    // Deduplicate: skip if this exact meetingId + fieldKey combination already exists
    const existing = await ctx.db
      .query("meetingFormResponses")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", args.meetingId))
      .collect();
    const alreadyExists = existing.some((r) => r.fieldKey === args.fieldKey);
    if (alreadyExists) return { inserted: false };

    await ctx.db.insert("meetingFormResponses", {
      tenantId: args.tenantId,
      meetingId: args.meetingId,
      opportunityId: args.opportunityId,
      leadId: args.leadId as any, // leadId from meeting may be string or Id<"leads">
      fieldKey: args.fieldKey,
      questionLabelSnapshot: args.questionLabelSnapshot,
      answerText: args.answerText,
      capturedAt: args.capturedAt,
    });
    return { inserted: true };
  },
});
```

**Step 4**: Create the helper mutation to upsert field catalog entries.

```typescript
// Path: convex/admin/migrations.ts
export const upsertFieldCatalogEntry = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    eventTypeConfigId: v.id("eventTypeConfigs"),
    fieldKey: v.string(),
    currentLabel: v.string(),
    seenAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("eventTypeFieldCatalog")
      .withIndex("by_tenantId_and_eventTypeConfigId", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("eventTypeConfigId", args.eventTypeConfigId),
      )
      .collect();
    const match = existing.find((e) => e.fieldKey === args.fieldKey);

    if (match) {
      // Update lastSeenAt if this event is newer
      if (args.seenAt > match.lastSeenAt) {
        await ctx.db.patch(match._id, {
          lastSeenAt: args.seenAt,
          currentLabel: args.currentLabel,
        });
      }
      return { upserted: "updated" };
    }

    await ctx.db.insert("eventTypeFieldCatalog", {
      tenantId: args.tenantId,
      eventTypeConfigId: args.eventTypeConfigId,
      fieldKey: args.fieldKey,
      currentLabel: args.currentLabel,
      firstSeenAt: args.seenAt,
      lastSeenAt: args.seenAt,
    });
    return { upserted: "created" };
  },
});
```

**Step 5**: Create the main action that orchestrates the backfill. This is an `internalAction` because it calls multiple queries and mutations in a loop (which cannot be done inside a single mutation transaction without exceeding limits for complex cross-table logic).

```typescript
// Path: convex/admin/migrations.ts
export const backfillMeetingFormResponses = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const rawEvents: any[] = await ctx.runQuery(
      internal.admin.migrations.getRawEventsForBackfill,
      { tenantId },
    );

    let responsesCreated = 0;
    let eventsProcessed = 0;
    let eventsSkippedNoQA = 0;
    let eventsSkippedNoMeeting = 0;

    for (const rawEvent of rawEvents) {
      const payload = JSON.parse(rawEvent.payload);
      const qas = payload?.payload?.questions_and_answers;
      if (!qas?.length) {
        eventsSkippedNoQA++;
        continue;
      }

      const meeting: any = await ctx.runQuery(
        internal.admin.migrations.getMeetingByCalendlyUri,
        { tenantId, calendlyEventUri: rawEvent.calendlyEventUri },
      );
      if (!meeting) {
        eventsSkippedNoMeeting++;
        continue;
      }

      // Resolve eventTypeConfigId from the meeting's opportunity
      const opportunity: any = await ctx.runQuery(
        internal.admin.migrations.getOpportunityById,
        { opportunityId: meeting.opportunityId },
      );

      // Seed field catalog entries if we have an eventTypeConfigId
      if (opportunity?.eventTypeConfigId) {
        for (const qa of qas) {
          const fieldKey =
            qa.question?.toLowerCase().replace(/\s+/g, "_") ?? "unknown";
          await ctx.runMutation(
            internal.admin.migrations.upsertFieldCatalogEntry,
            {
              tenantId,
              eventTypeConfigId: opportunity.eventTypeConfigId,
              fieldKey,
              currentLabel: qa.question ?? "",
              seenAt: rawEvent.receivedAt,
            },
          );
        }
      }

      // Insert form response rows
      for (const qa of qas) {
        const fieldKey =
          qa.question?.toLowerCase().replace(/\s+/g, "_") ?? "unknown";
        const result: any = await ctx.runMutation(
          internal.admin.migrations.insertFormResponse,
          {
            tenantId,
            meetingId: meeting._id,
            opportunityId: meeting.opportunityId,
            leadId: meeting.leadId ?? "",
            fieldKey,
            questionLabelSnapshot: qa.question ?? "",
            answerText: qa.answer ?? "",
            capturedAt: rawEvent.receivedAt,
          },
        );
        if (result.inserted) responsesCreated++;
      }
      eventsProcessed++;
    }

    console.log(
      `[Migration:2A] Complete: ${responsesCreated} responses created from ${eventsProcessed} events. ` +
        `Skipped: ${eventsSkippedNoQA} (no Q&A), ${eventsSkippedNoMeeting} (no matching meeting).`,
    );
    return {
      responsesCreated,
      eventsProcessed,
      eventsSkippedNoQA,
      eventsSkippedNoMeeting,
    };
  },
});
```

**Step 6**: Add the helper query used by 2A to look up an opportunity by ID.

```typescript
// Path: convex/admin/migrations.ts
export const getOpportunityById = internalQuery({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, { opportunityId }) => {
    return await ctx.db.get(opportunityId);
  },
});
```

### Key Implementation Notes

- **Run this BEFORE any other subphase.** If the 30-day cleanup cron fires first, data is gone.
- Consider temporarily pausing the cleanup cron during Phase 2 by commenting out the `cleanup-expired-webhook-events` entry in `convex/crons.ts` (line 27-32). Re-enable after 2A completes.
- The action uses `internalAction` (not `internalMutation`) because it orchestrates multiple queries and mutations across tables. Each `ctx.runMutation` call is its own transaction, giving per-row atomicity.
- The `insertFormResponse` mutation includes deduplication via `meetingId + fieldKey` check, making the backfill safe to re-run.
- The `leadId` field on meetings may be an `Id<"leads">` or absent — the script handles both via fallback to empty string.
- Field catalog seeding happens alongside response insertion to populate `eventTypeFieldCatalog` for downstream analytics.

### Files Touched

| File | Action | Lines/Details |
| --- | --- | --- |
| `convex/admin/migrations.ts` | **Create** | `getRawEventsForBackfill`, `getMeetingByCalendlyUri`, `getOpportunityById`, `insertFormResponse`, `upsertFieldCatalogEntry`, `backfillMeetingFormResponses` |
| `convex/crons.ts` | **Temporary edit** | Optionally comment out `cleanup-expired-webhook-events` cron (lines 27-32) during backfill window |

---

## Subphase 2B — Simple Field Backfills

| Field | Value |
| --- | --- |
| **Type** | Data migration (5 independent internalMutations) |
| **Parallelizable** | Yes — all 5 scripts are independent. Each targets a different table with no cross-table reads. Can also run in parallel with 2A and 2E. |
| **Items** | 2.1, 2.2, 2.4, 2.6, 2.9 |
| **Findings** | F6, F8, F3, F18, F18 |

### What

Backfill five single-field patches on existing tables:
1. `leads.status`: `undefined` -> `"active"` (item 2.1)
2. `users.isActive`: `undefined` -> `true` (item 2.2)
3. `paymentRecords.amountMinor`: `undefined` -> `Math.round(amount * 100)` (item 2.4)
4. `paymentRecords.contextType`: `undefined` -> `"opportunity"` or `"customer"` based on FK presence (item 2.6)
5. `followUps.type`: `undefined` -> `"scheduling_link"` or `"manual_reminder"` based on `schedulingLinkUrl` (item 2.9)

### Why

These fields were added as `v.optional()` in Phase 1 but existing records don't have them. Phase 3 mutations will start writing them, Phase 4 queries will start reading them, and Phase 6 will make them required. The backfill ensures zero gaps when schema narrows.

### Where

- `convex/admin/migrations.ts` (append to file created in 2A)

### How

**Step 1**: Backfill `leads.status`.

```typescript
// Path: convex/admin/migrations.ts
export const backfillLeadStatus = internalMutation({
  args: {},
  handler: async (ctx) => {
    const leads = await ctx.db.query("leads").collect();
    let updated = 0;
    for (const lead of leads) {
      if (lead.status === undefined) {
        await ctx.db.patch(lead._id, { status: "active" });
        updated++;
      }
    }
    console.log(
      `[Migration:2B] Backfilled ${updated}/${leads.length} leads with status="active"`,
    );
    return { updated, total: leads.length };
  },
});
```

**Step 2**: Backfill `users.isActive`.

```typescript
// Path: convex/admin/migrations.ts
export const backfillUserIsActive = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    let updated = 0;
    for (const user of users) {
      if (user.isActive === undefined) {
        await ctx.db.patch(user._id, { isActive: true });
        updated++;
      }
    }
    console.log(
      `[Migration:2B] Backfilled ${updated}/${users.length} users with isActive=true`,
    );
    return { updated, total: users.length };
  },
});
```

**Step 3**: Backfill `paymentRecords.amountMinor`.

```typescript
// Path: convex/admin/migrations.ts
export const backfillPaymentAmountMinor = internalMutation({
  args: {},
  handler: async (ctx) => {
    const payments = await ctx.db.query("paymentRecords").collect();
    let updated = 0;
    for (const payment of payments) {
      if (payment.amountMinor === undefined) {
        await ctx.db.patch(payment._id, {
          amountMinor: Math.round(payment.amount * 100),
        });
        updated++;
      }
    }
    console.log(
      `[Migration:2B] Backfilled ${updated}/${payments.length} payments with amountMinor`,
    );
    return { updated, total: payments.length };
  },
});
```

**Step 4**: Backfill `paymentRecords.contextType`.

```typescript
// Path: convex/admin/migrations.ts
export const backfillPaymentContextType = internalMutation({
  args: {},
  handler: async (ctx) => {
    const payments = await ctx.db.query("paymentRecords").collect();
    let updated = 0;
    for (const payment of payments) {
      if (payment.contextType === undefined) {
        const contextType = payment.opportunityId
          ? ("opportunity" as const)
          : ("customer" as const);
        await ctx.db.patch(payment._id, { contextType });
        updated++;
      }
    }
    console.log(
      `[Migration:2B] Backfilled ${updated}/${payments.length} payments with contextType`,
    );
    return { updated, total: payments.length };
  },
});
```

**Step 5**: Backfill `followUps.type`.

```typescript
// Path: convex/admin/migrations.ts
export const backfillFollowUpType = internalMutation({
  args: {},
  handler: async (ctx) => {
    const followUps = await ctx.db.query("followUps").collect();
    let updated = 0;
    for (const fu of followUps) {
      if (fu.type === undefined) {
        const inferredType = fu.schedulingLinkUrl
          ? ("scheduling_link" as const)
          : ("manual_reminder" as const);
        await ctx.db.patch(fu._id, { type: inferredType });
        updated++;
      }
    }
    console.log(
      `[Migration:2B] Backfilled ${updated}/${followUps.length} followUps with type`,
    );
    return { updated, total: followUps.length };
  },
});
```

### Key Implementation Notes

- All 5 scripts use `.collect()` which is safe at ~700 total records across these tables.
- Each script is idempotent — only patches rows where the field is `undefined`, so re-runs are safe.
- The `amountMinor` conversion uses `Math.round(amount * 100)` to handle floating-point precision (e.g., `99.99 * 100 = 9998.999...` rounds to `9999`).
- The `contextType` inference checks `opportunityId` presence: if set, the payment was recorded against an opportunity; otherwise against a customer directly.
- The `followUps.type` inference checks `schedulingLinkUrl`: if a URL was set, the follow-up sent a scheduling link; otherwise it was a manual reminder.

### Files Touched

| File | Action | Lines/Details |
| --- | --- | --- |
| `convex/admin/migrations.ts` | **Append** | `backfillLeadStatus`, `backfillUserIsActive`, `backfillPaymentAmountMinor`, `backfillPaymentContextType`, `backfillFollowUpType` |

---

## Subphase 2C — Relationship-Dependent Backfills

| Field | Value |
| --- | --- |
| **Type** | Data migration (2 internalMutations requiring parent lookups) |
| **Parallelizable** | After 2B completes (2.5 reads `amountMinor` which 2.4 writes). Can run in parallel with 2E. |
| **Items** | 2.3, 2.5 |
| **Findings** | F12, F4 |

### What

1. `meetings.assignedCloserId`: Copy from parent `opportunity.assignedCloserId` (item 2.3)
2. `customers.totalPaidMinor`: Aggregate from linked `paymentRecords` per customer (item 2.5)

### Why

These backfills require reading a related record to compute the value. Item 2.3 denormalizes the closer dimension from opportunity to meeting, eliminating O(n*m) joins in 5+ query paths. Item 2.5 pre-computes customer payment totals so list views avoid per-row `.collect()` loops.

Item 2.5 depends on 2.4 (amountMinor backfill) being complete — it falls back to `Math.round(amount * 100)` but should read the already-backfilled `amountMinor` for consistency.

### Where

- `convex/admin/migrations.ts` (append)

### How

**Step 1**: Backfill `meetings.assignedCloserId` from parent opportunity.

```typescript
// Path: convex/admin/migrations.ts
export const backfillMeetingCloserId = internalMutation({
  args: {},
  handler: async (ctx) => {
    const meetings = await ctx.db.query("meetings").collect();
    let updated = 0;
    let skippedNoCloser = 0;
    for (const meeting of meetings) {
      if (meeting.assignedCloserId === undefined) {
        const opp = await ctx.db.get(meeting.opportunityId);
        if (opp?.assignedCloserId) {
          await ctx.db.patch(meeting._id, {
            assignedCloserId: opp.assignedCloserId,
          });
          updated++;
        } else {
          skippedNoCloser++;
        }
      }
    }
    console.log(
      `[Migration:2C] Backfilled ${updated}/${meetings.length} meetings with assignedCloserId. ` +
        `${skippedNoCloser} skipped (parent opp has no closer).`,
    );
    return { updated, skippedNoCloser, total: meetings.length };
  },
});
```

**Step 2**: Backfill `customers.totalPaidMinor`, `totalPaymentCount`, and `paymentCurrency`.

```typescript
// Path: convex/admin/migrations.ts
export const backfillCustomerTotals = internalMutation({
  args: {},
  handler: async (ctx) => {
    const customers = await ctx.db.query("customers").collect();
    let updated = 0;
    for (const customer of customers) {
      const payments = await ctx.db
        .query("paymentRecords")
        .withIndex("by_customerId", (q) => q.eq("customerId", customer._id))
        .collect();
      const nonDisputed = payments.filter((p) => p.status !== "disputed");
      const totalMinor = nonDisputed.reduce(
        (sum, p) => sum + (p.amountMinor ?? Math.round(p.amount * 100)),
        0,
      );
      const currency = nonDisputed[0]?.currency ?? "USD";
      await ctx.db.patch(customer._id, {
        totalPaidMinor: totalMinor,
        totalPaymentCount: nonDisputed.length,
        paymentCurrency: currency,
      });
      updated++;
    }
    console.log(
      `[Migration:2C] Backfilled ${updated}/${customers.length} customers with totalPaidMinor`,
    );
    return { updated, total: customers.length };
  },
});
```

### Key Implementation Notes

- The `backfillMeetingCloserId` script logs how many meetings were skipped because their parent opportunity had no `assignedCloserId`. These are likely meetings from before closer assignment was implemented — they will get `assignedCloserId` when an admin assigns a closer to the opportunity in the future.
- The `backfillCustomerTotals` script uses `by_customerId` index (already exists on `paymentRecords`). It falls back to `Math.round(p.amount * 100)` if `amountMinor` hasn't been backfilled yet, but running 2B first ensures this fallback is never needed.
- Both scripts iterate ~200-250 records max and perform one parent lookup per record. Well within Convex mutation transaction limits.

### Files Touched

| File | Action | Lines/Details |
| --- | --- | --- |
| `convex/admin/migrations.ts` | **Append** | `backfillMeetingCloserId`, `backfillCustomerTotals` |

---

## Subphase 2D — Summary Document Seeding

| Field | Value |
| --- | --- |
| **Type** | Data migration (internalMutation, 1 per tenant) |
| **Parallelizable** | No — depends on 2B and 2C being complete (needs `isActive`, `amountMinor`, `status` etc. to produce accurate counts) |
| **Item** | 2.7 |
| **Finding** | F4 — Dashboard aggregate queries scan full tables |

### What

Create one `tenantStats` summary document per active tenant by counting all source tables. This seeds the document that Phase 3 mutations will maintain atomically, and Phase 4 queries will read instead of scanning 4+ tables.

### Why

The admin dashboard currently runs 4+ full table scans on every reactive render. After seeding, `getAdminDashboardStats` reads a single document. But the counts must be accurate — so we run after all field backfills are complete (status, isActive, amountMinor all populated).

### Where

- `convex/admin/migrations.ts` (append)

### How

**Step 1**: Create the seeding mutation that accepts a tenant ID and aggregates all counts.

```typescript
// Path: convex/admin/migrations.ts
export const seedTenantStats = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    // Check if already seeded (idempotent)
    const existing = await ctx.db
      .query("tenantStats")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();
    if (existing) {
      console.log(
        `[Migration:2D] tenantStats already exists for ${tenantId}, skipping.`,
      );
      return { action: "skipped" };
    }

    // Users
    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();
    const activeUsers = users.filter((u) => u.isActive !== false);
    const closers = activeUsers.filter((u) => u.role === "closer");

    // Opportunities
    const opps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();
    const activeStatuses = [
      "scheduled",
      "in_progress",
      "follow_up_scheduled",
      "reschedule_link_sent",
    ];
    const active = opps.filter((o) => activeStatuses.includes(o.status));
    const won = opps.filter((o) => o.status === "payment_received");
    const lost = opps.filter((o) => o.status === "lost");

    // Payments
    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();
    const nonDisputed = payments.filter((p) => p.status !== "disputed");
    const totalRevenue = nonDisputed.reduce(
      (sum, p) => sum + (p.amountMinor ?? Math.round(p.amount * 100)),
      0,
    );

    // Leads
    const leads = await ctx.db
      .query("leads")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();
    const activeLeads = leads.filter(
      (l) => l.status === "active" || l.status === undefined,
    );

    // Customers
    const customers = await ctx.db
      .query("customers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();

    await ctx.db.insert("tenantStats", {
      tenantId,
      totalTeamMembers: activeUsers.length,
      totalClosers: closers.length,
      totalOpportunities: opps.length,
      activeOpportunities: active.length,
      wonDeals: won.length,
      lostDeals: lost.length,
      totalRevenueMinor: totalRevenue,
      totalPaymentRecords: nonDisputed.length,
      totalLeads: activeLeads.length,
      totalCustomers: customers.length,
      lastUpdatedAt: Date.now(),
    });

    console.log(
      `[Migration:2D] Seeded tenantStats for ${tenantId}: ` +
        `${activeUsers.length} users, ${opps.length} opps, ${totalRevenue} revenue (minor), ` +
        `${activeLeads.length} leads, ${customers.length} customers`,
    );
    return { action: "created" };
  },
});
```

**Step 2**: Create a wrapper action to seed stats for all active tenants.

```typescript
// Path: convex/admin/migrations.ts
export const seedAllTenantStats = internalAction({
  args: {},
  handler: async (ctx) => {
    const tenants: any[] = await ctx.runQuery(
      internal.admin.migrations.getActiveTenants,
    );
    let seeded = 0;
    let skipped = 0;
    for (const tenant of tenants) {
      const result: any = await ctx.runMutation(
        internal.admin.migrations.seedTenantStats,
        { tenantId: tenant._id },
      );
      if (result.action === "created") seeded++;
      else skipped++;
    }
    console.log(
      `[Migration:2D] Complete: seeded ${seeded} tenants, skipped ${skipped}.`,
    );
    return { seeded, skipped };
  },
});

export const getActiveTenants = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("tenants")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();
  },
});
```

### Key Implementation Notes

- Idempotent: checks for existing `tenantStats` before inserting.
- Reads from 5 tables per tenant. At ~700 total records, this fits comfortably in a single mutation transaction.
- The `activeStatuses` list matches the opportunity status values that represent open pipeline items.
- `totalRevenueMinor` falls back to `Math.round(amount * 100)` for any payment records somehow missed by 2B, but by execution order this should not be needed.
- With only 1 active tenant currently, `seedAllTenantStats` runs a single `seedTenantStats` call.

### Files Touched

| File | Action | Lines/Details |
| --- | --- | --- |
| `convex/admin/migrations.ts` | **Append** | `seedTenantStats`, `seedAllTenantStats`, `getActiveTenants` |

---

## Subphase 2E — Data Deduplication and Cleanup

| Field | Value |
| --- | --- |
| **Type** | Data migration (internalMutation, destructive — deletes duplicate rows) |
| **Parallelizable** | Yes — can run in parallel with 2B/2C. Independent target table (`eventTypeConfigs`) not read by other 2B/2C scripts. |
| **Item** | 2.8 |
| **Finding** | F9 — Business-key uniqueness is soft/convention-based |

### What

Deduplicate `eventTypeConfigs` rows that share the same `(tenantId, calendlyEventTypeUri)` composite key. Keep the oldest (canonical) record, re-point all `opportunities.eventTypeConfigId` references from duplicates to the canonical, then delete the duplicates.

### Why

The pipeline's event type config creation path uses a scan + JS comparison that can create duplicates under concurrent webhook processing. After dedup, Phase 3 adds a proper upsert guard with compound index lookup. The dedup must happen before Phase 3 so that `.first()` lookups in the new upsert guard return the single canonical record.

### Where

- `convex/admin/migrations.ts` (append)

### How

**Step 1**: Create the deduplication mutation.

```typescript
// Path: convex/admin/migrations.ts
export const deduplicateEventTypeConfigs = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const configs = await ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();

    // Group by calendlyEventTypeUri
    const groups = new Map<string, typeof configs>();
    for (const config of configs) {
      const key = config.calendlyEventTypeUri;
      const group = groups.get(key) ?? [];
      group.push(config);
      groups.set(key, group);
    }

    let totalDeleted = 0;
    let totalOppsRepointed = 0;

    for (const [uri, group] of groups) {
      if (group.length <= 1) continue;

      // Keep the oldest by createdAt
      group.sort((a, b) => a.createdAt - b.createdAt);
      const canonical = group[0];
      const duplicates = group.slice(1);

      for (const dup of duplicates) {
        // Re-point all opportunities referencing this duplicate
        // Requires the by_tenantId_and_eventTypeConfigId index from Phase 1
        const opps = await ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_eventTypeConfigId", (q) =>
            q.eq("tenantId", tenantId).eq("eventTypeConfigId", dup._id),
          )
          .collect();
        for (const opp of opps) {
          await ctx.db.patch(opp._id, {
            eventTypeConfigId: canonical._id,
          });
          totalOppsRepointed++;
        }
        await ctx.db.delete(dup._id);
        totalDeleted++;
      }

      console.log(
        `[Migration:2E] ${uri}: kept ${canonical._id}, deleted ${duplicates.length} dupes, ` +
          `re-pointed ${duplicates.length > 0 ? "opps" : "none"}`,
      );
    }

    console.log(
      `[Migration:2E] Complete: deleted ${totalDeleted} duplicates, re-pointed ${totalOppsRepointed} opportunities`,
    );
    return { deleted: totalDeleted, oppsRepointed: totalOppsRepointed };
  },
});
```

**Step 2**: Create a wrapper to run dedup for all tenants.

```typescript
// Path: convex/admin/migrations.ts
export const deduplicateAllEventTypeConfigs = internalAction({
  args: {},
  handler: async (ctx) => {
    const tenants: any[] = await ctx.runQuery(
      internal.admin.migrations.getActiveTenants,
    );
    let totalDeleted = 0;
    for (const tenant of tenants) {
      const result: any = await ctx.runMutation(
        internal.admin.migrations.deduplicateEventTypeConfigs,
        { tenantId: tenant._id },
      );
      totalDeleted += result.deleted;
    }
    console.log(
      `[Migration:2E] All tenants complete: ${totalDeleted} total duplicates removed.`,
    );
    return { totalDeleted };
  },
});
```

### Key Implementation Notes

- **Destructive operation**: this deletes rows. Run against a non-production environment first if possible, or verify with the audit script (2F) afterward.
- Requires the `by_tenantId_and_eventTypeConfigId` index on `opportunities` which is added in Phase 1. This index must be live before running 2E.
- The canonical record is chosen by earliest `createdAt` (first created wins). Any custom configuration (like `customFieldMappings` or `paymentLinks`) on duplicates is **not merged** — verify manually if duplicates have different config data.
- Idempotent: if run again after dedup, each group has 1 member and the script becomes a no-op.

### Files Touched

| File | Action | Lines/Details |
| --- | --- | --- |
| `convex/admin/migrations.ts` | **Append** | `deduplicateEventTypeConfigs`, `deduplicateAllEventTypeConfigs` |

---

## Subphase 2F — Audit and Validation Scripts

| Field | Value |
| --- | --- |
| **Type** | Audit / validation (internalQueries and internalMutations — read-only analysis, no data changes) |
| **Parallelizable** | No — runs last. Validates all prior subphases produced correct results. |
| **Items** | 2.10, 2.11, 2.13 |
| **Findings** | F7, F8, F3 |

### What

Three audit scripts that validate data integrity without modifying anything:
1. **Orphaned tenant-scoped rows** (item 2.10): Check if any rows in tenant-scoped tables reference a `tenantId` that no longer exists.
2. **Orphaned user references** (item 2.11): Check if any `assignedCloserId`, `closerId`, `convertedByUserId` etc. reference a `users` row that no longer exists (from prior hard-delete calls).
3. **Payment currency audit** (item 2.13): Verify each tenant uses a single consistent currency across all payment records, or log exceptions.

### Why

These audits confirm data integrity before Phase 3 deploys mutations that assume clean referential integrity. Orphaned references would cause `ctx.db.get()` to return `null` in new code paths that don't expect it. Mixed currencies would produce incorrect `totalPaidMinor` aggregates.

### Where

- `convex/admin/migrations.ts` (append)

### How

**Step 1**: Audit for orphaned tenant-scoped rows.

```typescript
// Path: convex/admin/migrations.ts
export const auditOrphanedTenantRows = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tenants = await ctx.db.query("tenants").collect();
    const tenantIds = new Set(tenants.map((t) => t._id));

    const tablesToCheck = [
      "users",
      "leads",
      "opportunities",
      "meetings",
      "paymentRecords",
      "customers",
      "followUps",
      "eventTypeConfigs",
      "calendlyOrgMembers",
      "rawWebhookEvents",
      "closerUnavailability",
      "meetingReassignments",
      "leadIdentifiers",
      "leadMergeHistory",
    ] as const;

    const orphans: Record<string, number> = {};
    let totalOrphans = 0;

    for (const table of tablesToCheck) {
      const rows = await ctx.db.query(table).collect();
      const orphanedRows = rows.filter(
        (r: any) => r.tenantId && !tenantIds.has(r.tenantId),
      );
      if (orphanedRows.length > 0) {
        orphans[table] = orphanedRows.length;
        totalOrphans += orphanedRows.length;
        console.warn(
          `[Audit:2F] ORPHANED: ${orphanedRows.length} rows in "${table}" reference non-existent tenantId`,
        );
      }
    }

    if (totalOrphans === 0) {
      console.log("[Audit:2F] No orphaned tenant-scoped rows found.");
    } else {
      console.warn(
        `[Audit:2F] TOTAL: ${totalOrphans} orphaned rows across ${Object.keys(orphans).length} tables.`,
      );
    }
    return { orphans, totalOrphans };
  },
});
```

**Step 2**: Audit for orphaned user references.

```typescript
// Path: convex/admin/migrations.ts
export const auditOrphanedUserRefs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const userIds = new Set(users.map((u) => u._id));

    const issues: Array<{
      table: string;
      field: string;
      recordId: string;
      missingUserId: string;
    }> = [];

    // Check opportunities.assignedCloserId
    const opps = await ctx.db.query("opportunities").collect();
    for (const opp of opps) {
      if (opp.assignedCloserId && !userIds.has(opp.assignedCloserId)) {
        issues.push({
          table: "opportunities",
          field: "assignedCloserId",
          recordId: opp._id,
          missingUserId: opp.assignedCloserId,
        });
      }
    }

    // Check meetings.assignedCloserId (newly backfilled)
    const meetings = await ctx.db.query("meetings").collect();
    for (const m of meetings) {
      if (m.assignedCloserId && !userIds.has(m.assignedCloserId)) {
        issues.push({
          table: "meetings",
          field: "assignedCloserId",
          recordId: m._id,
          missingUserId: m.assignedCloserId,
        });
      }
    }

    // Check paymentRecords.closerId
    const payments = await ctx.db.query("paymentRecords").collect();
    for (const p of payments) {
      if (p.closerId && !userIds.has(p.closerId)) {
        issues.push({
          table: "paymentRecords",
          field: "closerId",
          recordId: p._id,
          missingUserId: p.closerId,
        });
      }
    }

    // Check followUps.closerId
    const followUps = await ctx.db.query("followUps").collect();
    for (const f of followUps) {
      if (f.closerId && !userIds.has(f.closerId)) {
        issues.push({
          table: "followUps",
          field: "closerId",
          recordId: f._id,
          missingUserId: f.closerId,
        });
      }
    }

    // Check customers.convertedByUserId
    const customers = await ctx.db.query("customers").collect();
    for (const c of customers) {
      if (c.convertedByUserId && !userIds.has(c.convertedByUserId)) {
        issues.push({
          table: "customers",
          field: "convertedByUserId",
          recordId: c._id,
          missingUserId: c.convertedByUserId,
        });
      }
    }

    if (issues.length === 0) {
      console.log("[Audit:2F] No orphaned user references found.");
    } else {
      console.warn(
        `[Audit:2F] Found ${issues.length} orphaned user references:`,
      );
      for (const issue of issues) {
        console.warn(
          `  ${issue.table}.${issue.field} on ${issue.recordId} -> missing user ${issue.missingUserId}`,
        );
      }
    }
    return { issues, totalIssues: issues.length };
  },
});
```

**Step 3**: Audit payment currencies per tenant.

```typescript
// Path: convex/admin/migrations.ts
export const auditPaymentCurrencies = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tenants = await ctx.db.query("tenants").collect();
    const report: Array<{
      tenantId: string;
      currencies: string[];
      counts: Record<string, number>;
      isConsistent: boolean;
    }> = [];

    for (const tenant of tenants) {
      const payments = await ctx.db
        .query("paymentRecords")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenant._id))
        .collect();
      if (payments.length === 0) continue;

      const currencyCounts: Record<string, number> = {};
      for (const p of payments) {
        const cur = p.currency?.toUpperCase() ?? "UNKNOWN";
        currencyCounts[cur] = (currencyCounts[cur] ?? 0) + 1;
      }

      const currencies = Object.keys(currencyCounts);
      const isConsistent = currencies.length === 1;
      report.push({
        tenantId: tenant._id,
        currencies,
        counts: currencyCounts,
        isConsistent,
      });

      if (!isConsistent) {
        console.warn(
          `[Audit:2F] MIXED CURRENCIES for tenant ${tenant._id}: ${JSON.stringify(currencyCounts)}`,
        );
      } else {
        console.log(
          `[Audit:2F] Tenant ${tenant._id}: consistent currency ${currencies[0]} (${payments.length} records)`,
        );
      }
    }

    const inconsistent = report.filter((r) => !r.isConsistent);
    return {
      report,
      totalTenants: report.length,
      inconsistentTenants: inconsistent.length,
    };
  },
});
```

### Key Implementation Notes

- All audit scripts are **read-only** (despite being `internalMutation` — they only read and log). They use `internalMutation` instead of `internalQuery` to allow `.collect()` across multiple tables within a single consistent snapshot.
- Run these after all backfills complete but before declaring Phase 2 done.
- If orphaned user references are found (item 2.11), decide on a case-by-case basis whether to null them out or assign to a sentinel user. Document findings for Phase 3 to handle.
- If mixed currencies are found (item 2.13), document which tenants and what amounts. Phase 3's currency validation will enforce single-currency-per-tenant going forward, but existing mixed records need a manual resolution decision.
- The orphaned tenant check covers 14 tenant-scoped tables. The `domainEvents`, `tenantStats`, `meetingFormResponses`, and `eventTypeFieldCatalog` tables (new in Phase 1) are empty at this point and can be skipped.

### Files Touched

| File | Action | Lines/Details |
| --- | --- | --- |
| `convex/admin/migrations.ts` | **Append** | `auditOrphanedTenantRows`, `auditOrphanedUserRefs`, `auditPaymentCurrencies` |

---

## Phase Summary

### Execution Order

| Order | Subphase | Items | Est. Records | Run Via |
| --- | --- | --- | --- | --- |
| 1 | **2A** (CRITICAL) | 2.12 | ~288 raw events -> ~500 form responses | `npx convex run admin/migrations:backfillMeetingFormResponses --args '{"tenantId":"TENANT_ID"}'` |
| 2 | **2B** (parallel) | 2.1, 2.2, 2.4, 2.6, 2.9 | ~200 leads, ~5 users, ~50 payments, ~50 followUps | 5x `npx convex run` (can run simultaneously) |
| 2 | **2E** (parallel with 2B) | 2.8 | ~30 eventTypeConfigs | `npx convex run admin/migrations:deduplicateAllEventTypeConfigs` |
| 3 | **2C** | 2.3, 2.5 | ~213 meetings, ~20 customers | 2x `npx convex run` |
| 4 | **2D** | 2.7 | 1 tenantStats doc (reads ~700 total) | `npx convex run admin/migrations:seedAllTenantStats` |
| 5 | **2F** (last) | 2.10, 2.11, 2.13 | Full table scans (~700 total) | 3x `npx convex run` |

### Combined Files Touched

| File | Action | Contents |
| --- | --- | --- |
| `convex/admin/migrations.ts` | **Create** | All 20 exported functions: 6 for 2A (getRawEventsForBackfill, getMeetingByCalendlyUri, getOpportunityById, insertFormResponse, upsertFieldCatalogEntry, backfillMeetingFormResponses), 5 for 2B (backfillLeadStatus, backfillUserIsActive, backfillPaymentAmountMinor, backfillPaymentContextType, backfillFollowUpType), 2 for 2C (backfillMeetingCloserId, backfillCustomerTotals), 3 for 2D (getActiveTenants, seedTenantStats, seedAllTenantStats), 2 for 2E (deduplicateEventTypeConfigs, deduplicateAllEventTypeConfigs), 3 for 2F (auditOrphanedTenantRows, auditOrphanedUserRefs, auditPaymentCurrencies) |
| `convex/crons.ts` | **Temporary edit** | Optionally pause `cleanup-expired-webhook-events` cron (lines 27-32) during 2A execution window |

### Pre-Flight Checklist

- [ ] Phase 1 deployed: all 5 new tables exist, all 15 optional fields added, all 24 indexes live
- [ ] Verify `by_tenantId_and_eventTypeConfigId` index on `opportunities` is active (required by 2E)
- [ ] Verify `by_customerId` index on `paymentRecords` is active (required by 2C)
- [ ] Note current date vs. oldest `rawWebhookEvents.receivedAt` — confirm data is still within 30-day retention window
- [ ] Optionally pause cleanup cron before running 2A

### Post-Completion Checklist

- [ ] 2A: `meetingFormResponses` count > 0; `eventTypeFieldCatalog` count > 0
- [ ] 2B: Zero `leads` with `status === undefined`; zero `users` with `isActive === undefined`; zero `paymentRecords` with `amountMinor === undefined` or `contextType === undefined`; zero `followUps` with `type === undefined`
- [ ] 2C: Zero `meetings` with `assignedCloserId === undefined` where parent opp has one; every `customers` row has `totalPaidMinor` defined
- [ ] 2D: `tenantStats` count matches active tenant count
- [ ] 2E: Zero duplicate `eventTypeConfigs` per `(tenantId, calendlyEventTypeUri)` key
- [ ] 2F audit logs show zero orphaned tenants, zero orphaned users, consistent currencies
- [ ] Re-enable cleanup cron if it was paused
- [ ] `pnpm tsc --noEmit` passes without errors
- [ ] Declare Phase 2 complete -- Phase 3 can begin
