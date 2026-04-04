# Phase 3 — Webhook Event Processing Pipeline

**Goal:** Implement the processing pipeline that transforms raw Calendly webhook events (already persisted in `rawWebhookEvents`) into domain entities: Leads, Opportunities, and Meetings. After this phase, incoming `invitee.created`, `invitee.canceled`, and `invitee_no_show` events automatically create and update the full Lead → Opportunity → Meeting chain with correct Closer assignment.

**Prerequisite:** Phase 1 complete (schema with `leads`, `opportunities`, `meetings` tables; `requireTenantUser` guard; status transition utilities). The existing webhook handler in `convex/webhooks/calendly.ts` already persists raw events to `rawWebhookEvents` with `processed: false`.

**Runs in PARALLEL with:** Phase 2 (Tenant Owner Identification & WorkOS User Management). No shared files or dependencies.

**Acceptance Criteria:**
1. When a raw `invitee.created` event is persisted, the pipeline processor automatically creates a Lead (or updates existing), an Opportunity (`status: scheduled`), and a Meeting record.
2. The Closer is correctly resolved from `event_memberships[0].user` URI via the `users.by_tenantId_and_calendlyUserUri` index.
3. If no Closer matches, the opportunity is assigned to the tenant owner (fallback).
4. A raw `invitee.canceled` event updates the corresponding Meeting and Opportunity to `status: canceled`.
5. A raw `invitee_no_show.created` event updates the corresponding Meeting and Opportunity to `status: no_show`.
6. When a lead with an existing `follow_up_scheduled` opportunity books a new meeting, the pipeline links the new Meeting to the existing Opportunity (instead of creating a new one) and transitions it back to `scheduled`.
7. All raw events are marked `processed: true` after successful processing.
8. Duplicate processing is prevented — calling the processor on an already-processed event is a no-op.

---

## Subphases

### 3A — Pipeline Helper Queries

**Type:** Backend
**Parallelizable:** Yes — no dependencies within Phase 3. After Phase 1 complete.

**What:** Create the helper queries used by the pipeline processor to read raw events and look up existing entities (leads, opportunities, meetings).

**Why:** The pipeline processor (3B) and individual event handlers (3C, 3D, 3E) need to query raw events, find existing leads by email, find opportunities by lead ID, and find meetings by Calendly event URI. Centralizing these queries keeps the handler code focused on business logic.

**Where:** `convex/pipeline/queries.ts` (new file)

**How:**

```typescript
// convex/pipeline/queries.ts
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

/**
 * Get a raw webhook event by ID.
 * Used by the pipeline processor to load the event payload.
 */
export const getRawEvent = internalQuery({
  args: { rawEventId: v.id("rawWebhookEvents") },
  handler: async (ctx, { rawEventId }) => {
    return await ctx.db.get(rawEventId);
  },
});

/**
 * Find a lead by email within a tenant.
 * Used by invitee.created to check if a returning lead already exists.
 */
export const getLeadByEmail = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    email: v.string(),
  },
  handler: async (ctx, { tenantId, email }) => {
    return await ctx.db
      .query("leads")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", tenantId).eq("email", email)
      )
      .unique();
  },
});

/**
 * Find a meeting by Calendly event URI within a tenant.
 * Used by invitee.canceled and invitee_no_show to find the affected meeting.
 */
export const getMeetingByCalendlyEventUri = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    calendlyEventUri: v.string(),
  },
  handler: async (ctx, { tenantId, calendlyEventUri }) => {
    return await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventUri", calendlyEventUri)
      )
      .first();
  },
});

/**
 * Find the CRM user (Closer) by their Calendly user URI within a tenant.
 * Used by invitee.created to resolve the assigned host to a CRM Closer.
 */
export const getUserByCalendlyUri = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    calendlyUserUri: v.string(),
  },
  handler: async (ctx, { tenantId, calendlyUserUri }) => {
    return await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyUserUri", calendlyUserUri)
      )
      .unique();
  },
});

/**
 * Find an existing follow-up opportunity for a lead.
 * Used by invitee.created to detect if this is a follow-up booking.
 */
export const getFollowUpOpportunity = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    leadId: v.id("leads"),
  },
  handler: async (ctx, { tenantId, leadId }) => {
    return await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", leadId)
      )
      .filter((q) => q.eq(q.field("status"), "follow_up_scheduled"))
      .first();
  },
});

/**
 * Find event type config by Calendly event type URI.
 * Used by invitee.created to link opportunities to event type configurations.
 */
export const getEventTypeConfig = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    calendlyEventTypeUri: v.string(),
  },
  handler: async (ctx, { tenantId, calendlyEventTypeUri }) => {
    return await ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventTypeUri", calendlyEventTypeUri)
      )
      .unique();
  },
});
```

**Key implementation notes:**
- All queries are `internalQuery` — only callable from other Convex functions (the pipeline processor actions/mutations).
- Each query uses a specific index for efficient lookups. No full-table scans.
- `getFollowUpOpportunity` specifically filters for `status: "follow_up_scheduled"` to detect when a new booking is a follow-up to an existing opportunity.

**Files touched:** `convex/pipeline/queries.ts` (create)

---

### 3B — Pipeline Dispatcher (Main Processor)

**Type:** Backend
**Parallelizable:** Yes — can start alongside 3A (references 3A queries but can be written simultaneously).

**What:** Create the main pipeline dispatcher action that reads a raw webhook event, parses the payload, and dispatches to the appropriate handler based on event type.

**Why:** This is the entry point for all webhook event processing. It's triggered by `ctx.scheduler.runAfter(0, ...)` from the webhook ingestion handler. It delegates to specific mutation handlers (3C, 3D, 3E) for each event type.

**Where:** `convex/pipeline/processor.ts` (new file)

**How:**

```typescript
// convex/pipeline/processor.ts
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

/**
 * Main pipeline dispatcher.
 *
 * Reads a raw webhook event, parses the JSON payload, and dispatches
 * to the appropriate handler based on event type.
 *
 * Triggered by: ctx.scheduler.runAfter(0, internal.pipeline.processor.processRawEvent, { rawEventId })
 * This is called from the webhook ingestion handler in convex/webhooks/calendly.ts.
 *
 * Idempotent: if the event is already processed, this is a no-op.
 */
export const processRawEvent = internalAction({
  args: { rawEventId: v.id("rawWebhookEvents") },
  handler: async (ctx, { rawEventId }) => {
    // Load the raw event
    const rawEvent = await ctx.runQuery(internal.pipeline.queries.getRawEvent, {
      rawEventId,
    });

    if (!rawEvent) {
      console.error(`[Pipeline] Raw event ${rawEventId} not found`);
      return;
    }

    // Idempotency check — skip already-processed events
    if (rawEvent.processed) {
      console.log(`[Pipeline] Event ${rawEventId} already processed, skipping`);
      return;
    }

    // Parse the payload
    let payload: any;
    try {
      payload = JSON.parse(rawEvent.payload);
    } catch (e) {
      console.error(`[Pipeline] Failed to parse payload for event ${rawEventId}:`, e);
      return;
    }

    // Dispatch to the appropriate handler
    try {
      switch (rawEvent.eventType) {
        case "invitee.created":
          await ctx.runMutation(internal.pipeline.inviteeCreated.process, {
            tenantId: rawEvent.tenantId,
            payload,
            rawEventId,
          });
          break;

        case "invitee.canceled":
          await ctx.runMutation(internal.pipeline.inviteeCanceled.process, {
            tenantId: rawEvent.tenantId,
            payload,
            rawEventId,
          });
          break;

        case "invitee_no_show.created":
          await ctx.runMutation(internal.pipeline.inviteeNoShow.process, {
            tenantId: rawEvent.tenantId,
            payload,
            rawEventId,
          });
          break;

        case "invitee_no_show.deleted":
          // No-show reversal: revert meeting/opportunity back to scheduled
          await ctx.runMutation(internal.pipeline.inviteeNoShow.revert, {
            tenantId: rawEvent.tenantId,
            payload,
            rawEventId,
          });
          break;

        default:
          console.log(
            `[Pipeline] Unhandled event type "${rawEvent.eventType}" for event ${rawEventId}`
          );
          // Mark as processed to avoid retrying unknown event types
          await ctx.runMutation(internal.pipeline.mutations.markProcessed, {
            rawEventId,
          });
      }
    } catch (error) {
      console.error(
        `[Pipeline] Error processing event ${rawEventId} (type: ${rawEvent.eventType}):`,
        error
      );
      // Do NOT mark as processed — the event will be retried on next run
      throw error;
    }
  },
});
```

**Key implementation notes:**
- This is an `internalAction` (not mutation) because it orchestrates multiple mutations. Using an action wrapper lets us call `ctx.runMutation` for each handler while keeping each handler's DB writes transactional.
- The dispatcher itself does no DB writes — it delegates entirely to mutation handlers.
- Failed events are NOT marked as processed. They remain `processed: false` for retry.
- The `invitee_no_show.deleted` event is a **reversal** — it undoes a no-show marking.

**Files touched:** `convex/pipeline/processor.ts` (create)

---

### 3C — `invitee.created` Handler

**Type:** Backend
**Parallelizable:** Depends on 3A (helper queries) and 3B (processor pattern). Can start after 3A is written.

**What:** Create the mutation handler for `invitee.created` events. This is the core pipeline entry point that creates the full Lead → Opportunity → Meeting chain.

**Why:** This handler transforms a Calendly booking event into CRM domain entities. It handles lead upsert (returning leads get updated, new leads get created), Closer resolution from Calendly `event_memberships`, follow-up detection, and idempotent opportunity/meeting creation.

**Where:** `convex/pipeline/inviteeCreated.ts` (new file)

**How:**

```typescript
// convex/pipeline/inviteeCreated.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

/**
 * Process an invitee.created webhook event.
 *
 * Creates the full chain: Lead (upsert) → Opportunity → Meeting
 *
 * Flow:
 * 1. Extract key fields from the Calendly payload
 * 2. Upsert Lead by email (create if new, update if returning)
 * 3. Resolve Closer from event_memberships[0].user URI
 * 4. Detect follow-up scenario (existing opportunity with follow_up_scheduled)
 * 5. Create or update Opportunity
 * 6. Create Meeting record
 * 7. Mark raw event as processed
 */
export const process = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    payload: v.any(), // Parsed Calendly webhook payload
    rawEventId: v.id("rawWebhookEvents"),
  },
  handler: async (ctx, { tenantId, payload, rawEventId }) => {
    // ==== Step 1: Extract key fields from payload ====
    const inviteeEmail = payload.email?.toLowerCase();
    const inviteeName = payload.name;
    const inviteePhone = payload.text_reminder_number ?? null;
    const scheduledEvent = payload.scheduled_event;
    const eventTypeUri = scheduledEvent?.event_type;
    const eventMemberships = scheduledEvent?.event_memberships ?? [];
    const scheduledAt = new Date(scheduledEvent.start_time).getTime();
    const endTime = new Date(scheduledEvent.end_time).getTime();
    const durationMinutes = Math.round((endTime - scheduledAt) / 60000);
    const calendlyEventUri = scheduledEvent.uri;
    const calendlyInviteeUri = payload.uri;
    const zoomJoinUrl = scheduledEvent.location?.join_url ?? null;

    if (!inviteeEmail || !calendlyEventUri || !calendlyInviteeUri) {
      console.error("[Pipeline] Missing required fields in invitee.created payload");
      return;
    }

    // ==== Step 2: Upsert Lead ====
    let lead = await ctx.db
      .query("leads")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", tenantId).eq("email", inviteeEmail)
      )
      .unique();

    if (!lead) {
      // New lead — create record
      const leadId = await ctx.db.insert("leads", {
        tenantId,
        email: inviteeEmail,
        fullName: inviteeName,
        phone: inviteePhone,
        customFields: extractQuestionsAndAnswers(payload.questions_and_answers),
        firstSeenAt: Date.now(),
        updatedAt: Date.now(),
      });
      lead = (await ctx.db.get(leadId))!;
    } else {
      // Returning lead — update with latest info
      await ctx.db.patch(lead._id, {
        fullName: inviteeName || lead.fullName,
        phone: inviteePhone || lead.phone,
        updatedAt: Date.now(),
      });
    }

    // ==== Step 3: Resolve Closer from event_memberships ====
    let closerId: any = null;
    const assignedHost = eventMemberships[0]; // Primary assigned host

    if (assignedHost?.user) {
      // Try direct match via users table
      const closerUser = await ctx.db
        .query("users")
        .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
          q.eq("tenantId", tenantId).eq("calendlyUserUri", assignedHost.user)
        )
        .unique();

      if (closerUser) {
        closerId = closerUser._id;
      } else {
        // Secondary lookup: check calendlyOrgMembers for matchedUserId
        const orgMember = await ctx.db
          .query("calendlyOrgMembers")
          .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
            q.eq("tenantId", tenantId).eq("calendlyUserUri", assignedHost.user)
          )
          .unique();

        if (orgMember?.matchedUserId) {
          closerId = orgMember.matchedUserId;
        }
      }
    }

    // Fallback: assign to tenant owner if no closer matched
    if (!closerId) {
      const tenant = await ctx.db.get(tenantId);
      closerId = tenant?.tenantOwnerId ?? null;
      if (assignedHost?.user) {
        console.warn(
          `[Pipeline] Unmatched Calendly host URI: ${assignedHost.user}. Falling back to tenant owner.`
        );
      }
    }

    // ==== Step 4: Resolve Event Type Config ====
    let eventTypeConfigId = null;
    if (eventTypeUri) {
      const config = await ctx.db
        .query("eventTypeConfigs")
        .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
          q.eq("tenantId", tenantId).eq("calendlyEventTypeUri", eventTypeUri)
        )
        .unique();
      if (config) {
        eventTypeConfigId = config._id;
      }
    }

    // ==== Step 5: Check for follow-up scenario ====
    let opportunityId;
    const existingFollowUp = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", lead._id)
      )
      .filter((q) => q.eq(q.field("status"), "follow_up_scheduled"))
      .first();

    if (existingFollowUp) {
      // Follow-up: link to existing opportunity, transition back to scheduled
      opportunityId = existingFollowUp._id;
      await ctx.db.patch(opportunityId, {
        status: "scheduled",
        calendlyEventUri,
        updatedAt: Date.now(),
      });
    } else {
      // New opportunity
      opportunityId = await ctx.db.insert("opportunities", {
        tenantId,
        leadId: lead._id,
        assignedCloserId: closerId,
        eventTypeConfigId,
        status: "scheduled",
        calendlyEventUri,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // ==== Step 6: Create Meeting record ====
    await ctx.db.insert("meetings", {
      tenantId,
      opportunityId,
      calendlyEventUri,
      calendlyInviteeUri,
      zoomJoinUrl,
      scheduledAt,
      durationMinutes,
      status: "scheduled",
      notes: "",
      createdAt: Date.now(),
    });

    // ==== Step 7: Mark raw event as processed ====
    await ctx.db.patch(rawEventId, { processed: true });

    console.log(
      `[Pipeline] Processed invitee.created: lead=${lead._id}, opp=${opportunityId}, closer=${closerId}`
    );
  },
});

/**
 * Extract questions and answers from Calendly booking form.
 * Returns a simplified object for storage in the lead's customFields.
 */
function extractQuestionsAndAnswers(
  qna: Array<{ question: string; answer: string }> | undefined
): Record<string, string> | undefined {
  if (!qna || qna.length === 0) return undefined;

  const result: Record<string, string> = {};
  for (const item of qna) {
    result[item.question] = item.answer;
  }
  return result;
}
```

**Key implementation notes:**
- This is an `internalMutation` — all DB writes happen in a single transaction. If any step fails, the entire mutation rolls back (no partial state).
- Lead upsert: checks `by_tenantId_and_email` index. If the lead exists, updates their name/phone with latest info. If new, creates with all available data.
- Closer resolution uses a **two-step lookup**: first tries the `users` table directly, then falls back to `calendlyOrgMembers.matchedUserId`. This handles both direct and indirect Calendly linking.
- Follow-up detection: if the lead already has an opportunity with `status: "follow_up_scheduled"`, we link the new meeting to that opportunity instead of creating a new one. This preserves the full meeting history on a single opportunity.
- `extractQuestionsAndAnswers` converts Calendly's Q&A array into a flat object for easier querying.

**Files touched:** `convex/pipeline/inviteeCreated.ts` (create)

---

### 3D — `invitee.canceled` Handler

**Type:** Backend
**Parallelizable:** Yes — after 3A. Independent of 3C and 3E.

**What:** Create the mutation handler for `invitee.canceled` events. Updates the meeting and opportunity status to `canceled` with cancellation details.

**Why:** When a lead or host cancels a Calendly meeting, the CRM needs to reflect this status change. The opportunity may still be recoverable via a follow-up (Phase 7), so it's not terminal.

**Where:** `convex/pipeline/inviteeCanceled.ts` (new file)

**How:**

```typescript
// convex/pipeline/inviteeCanceled.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

/**
 * Process an invitee.canceled webhook event.
 *
 * Flow:
 * 1. Find the meeting by calendlyEventUri
 * 2. Update meeting status to canceled
 * 3. Update opportunity status to canceled (if currently scheduled)
 * 4. Store cancellation details (reason, who canceled)
 * 5. Mark raw event as processed
 */
export const process = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    payload: v.any(),
    rawEventId: v.id("rawWebhookEvents"),
  },
  handler: async (ctx, { tenantId, payload, rawEventId }) => {
    const calendlyEventUri = payload.scheduled_event?.uri;
    if (!calendlyEventUri) {
      console.error("[Pipeline] Missing scheduled_event.uri in invitee.canceled payload");
      await ctx.db.patch(rawEventId, { processed: true });
      return;
    }

    // Find the meeting
    const meeting = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventUri", calendlyEventUri)
      )
      .first();

    if (!meeting) {
      console.warn(
        `[Pipeline] No meeting found for canceled event URI: ${calendlyEventUri}`
      );
      await ctx.db.patch(rawEventId, { processed: true });
      return;
    }

    // Update meeting status
    await ctx.db.patch(meeting._id, { status: "canceled" });

    // Update opportunity status (only if currently scheduled)
    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (opportunity && opportunity.status === "scheduled") {
      await ctx.db.patch(opportunity._id, {
        status: "canceled",
        cancellationReason: payload.cancellation?.reason ?? null,
        canceledBy: payload.cancellation?.canceler_type ?? null,
        updatedAt: Date.now(),
      });
    }

    // Mark processed
    await ctx.db.patch(rawEventId, { processed: true });

    console.log(
      `[Pipeline] Processed invitee.canceled: meeting=${meeting._id}`
    );
  },
});
```

**Key implementation notes:**
- Only transitions the opportunity if it's currently `scheduled`. If the opportunity is already `in_progress` or `payment_received`, the cancellation is noted on the meeting only.
- `cancellationReason` and `canceledBy` are extracted from Calendly's `cancellation` object in the payload.
- If no meeting is found (rare edge case — event arrived before `invitee.created` was processed), the event is marked as processed to avoid retry loops.

**Files touched:** `convex/pipeline/inviteeCanceled.ts` (create)

---

### 3E — `invitee_no_show` Handler

**Type:** Backend
**Parallelizable:** Yes — after 3A. Independent of 3C and 3D.

**What:** Create the mutation handler for `invitee_no_show.created` and `invitee_no_show.deleted` (reversal) events.

**Why:** When a host marks an invitee as a no-show, the CRM needs to reflect this. The reversal event (`invitee_no_show.deleted`) handles the case where the no-show marking is undone (e.g., the host made a mistake).

**Where:** `convex/pipeline/inviteeNoShow.ts` (new file)

**How:**

```typescript
// convex/pipeline/inviteeNoShow.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

/**
 * Process an invitee_no_show.created webhook event.
 * Marks the meeting and opportunity as no_show.
 */
export const process = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    payload: v.any(),
    rawEventId: v.id("rawWebhookEvents"),
  },
  handler: async (ctx, { tenantId, payload, rawEventId }) => {
    // The no-show payload references the event URI differently
    const calendlyEventUri = payload.scheduled_event?.uri ?? payload.event;
    if (!calendlyEventUri) {
      console.error("[Pipeline] Missing event URI in invitee_no_show payload");
      await ctx.db.patch(rawEventId, { processed: true });
      return;
    }

    const meeting = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventUri", calendlyEventUri)
      )
      .first();

    if (!meeting) {
      console.warn(
        `[Pipeline] No meeting found for no-show event URI: ${calendlyEventUri}`
      );
      await ctx.db.patch(rawEventId, { processed: true });
      return;
    }

    // Update meeting status
    await ctx.db.patch(meeting._id, { status: "no_show" });

    // Update opportunity status
    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (opportunity && (opportunity.status === "scheduled" || opportunity.status === "in_progress")) {
      await ctx.db.patch(opportunity._id, {
        status: "no_show",
        updatedAt: Date.now(),
      });
    }

    await ctx.db.patch(rawEventId, { processed: true });

    console.log(
      `[Pipeline] Processed invitee_no_show.created: meeting=${meeting._id}`
    );
  },
});

/**
 * Process an invitee_no_show.deleted webhook event.
 * Reverts a no-show marking back to scheduled.
 */
export const revert = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    payload: v.any(),
    rawEventId: v.id("rawWebhookEvents"),
  },
  handler: async (ctx, { tenantId, payload, rawEventId }) => {
    const calendlyEventUri = payload.scheduled_event?.uri ?? payload.event;
    if (!calendlyEventUri) {
      await ctx.db.patch(rawEventId, { processed: true });
      return;
    }

    const meeting = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventUri", calendlyEventUri)
      )
      .first();

    if (!meeting) {
      await ctx.db.patch(rawEventId, { processed: true });
      return;
    }

    // Revert meeting status back to scheduled
    if (meeting.status === "no_show") {
      await ctx.db.patch(meeting._id, { status: "scheduled" });
    }

    // Revert opportunity status
    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (opportunity && opportunity.status === "no_show") {
      await ctx.db.patch(opportunity._id, {
        status: "scheduled",
        updatedAt: Date.now(),
      });
    }

    await ctx.db.patch(rawEventId, { processed: true });

    console.log(
      `[Pipeline] Processed invitee_no_show.deleted (revert): meeting=${meeting._id}`
    );
  },
});
```

**Key implementation notes:**
- The no-show payload may reference the event URI in different locations (`payload.scheduled_event.uri` or `payload.event`). We check both for robustness.
- The `process` handler marks both meeting and opportunity as `no_show`.
- The `revert` handler reverses the no-show, returning statuses to `scheduled`.
- Only reverts if the current status is actually `no_show` — prevents accidental overwrite of other status transitions.

**Files touched:** `convex/pipeline/inviteeNoShow.ts` (create)

---

### 3F — Wire Webhook Handler to Trigger Pipeline

**Type:** Backend
**Parallelizable:** Depends on 3B (processor must exist for the scheduler reference). Can start after 3B is written.

**What:** Modify the existing webhook handler in `convex/webhooks/calendly.ts` (or its associated mutation file) to schedule the pipeline processor immediately after persisting a raw webhook event.

**Why:** Currently, raw events are persisted but not processed. This wiring connects the ingestion layer to the processing pipeline, completing the event flow from Calendly → raw storage → domain entities.

**Where:** `convex/webhooks/calendlyMutations.ts` (modify existing file)

**How:**

Add a `ctx.scheduler.runAfter(0, ...)` call after the raw event is inserted:

```typescript
// In the mutation that persists raw webhook events (convex/webhooks/calendlyMutations.ts):
// After inserting the raw event:

const rawEventId = await ctx.db.insert("rawWebhookEvents", {
  tenantId,
  calendlyEventUri,
  eventType,
  payload: JSON.stringify(payload),
  processed: false,
  receivedAt: Date.now(),
});

// ===== NEW: Trigger pipeline processing =====
await ctx.scheduler.runAfter(
  0, // Immediate execution
  internal.pipeline.processor.processRawEvent,
  { rawEventId }
);
```

**Key implementation notes:**
- `ctx.scheduler.runAfter(0, ...)` schedules the action to run immediately after the mutation commits. The mutation doesn't wait for the action.
- Import `internal` from `../_generated/api` to reference the pipeline processor.
- If the pipeline processor fails, the raw event remains `processed: false` and can be retried manually or by a future cleanup cron.
- The existing idempotency check on `calendlyEventUri` in the mutation prevents duplicate raw events. The pipeline processor also checks `processed: true` for defense-in-depth.

**Files touched:** `convex/webhooks/calendlyMutations.ts` (modify — add scheduler call)

---

### 3G — Pipeline Shared Mutation (markProcessed)

**Type:** Backend
**Parallelizable:** Yes — after 3A. Simple utility needed by 3B.

**What:** Create a shared internal mutation to mark a raw event as processed. Used by the dispatcher for unhandled event types.

**Why:** The dispatcher needs to mark unknown event types as processed to prevent infinite retry loops. This simple mutation is reused across all handlers.

**Where:** `convex/pipeline/mutations.ts` (new file)

**How:**

```typescript
// convex/pipeline/mutations.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

/**
 * Mark a raw webhook event as processed.
 * Used by the pipeline dispatcher for unhandled event types,
 * and as a fallback for edge cases.
 */
export const markProcessed = internalMutation({
  args: { rawEventId: v.id("rawWebhookEvents") },
  handler: async (ctx, { rawEventId }) => {
    await ctx.db.patch(rawEventId, { processed: true });
  },
});
```

**Files touched:** `convex/pipeline/mutations.ts` (create)

---

## Parallelization Summary

```
Phase 1 Complete
  │
  ├── 3A (pipeline helper queries) ────────────────┐
  ├── 3G (markProcessed mutation) ─────────────────┤
  │                                                 │
  │   Both independent, start immediately           │
  │                                                 │
  └── 3B (pipeline dispatcher) ────────────────────┤
       Needs: 3A, 3G for references                │
                                                    │
  After 3A complete:                                │
  ├── 3C (invitee.created handler) ────────────────┤
  ├── 3D (invitee.canceled handler) ───────────────┤  All 3 independent
  └── 3E (invitee_no_show handler) ────────────────┤
                                                    │
  After 3B complete:                                │
  └── 3F (wire webhook trigger) ───────────────────┘
```

**Optimal execution:**
1. Start 3A + 3G in parallel.
2. Once 3A is done → start 3B, 3C, 3D, 3E all in parallel.
3. Once 3B is done → start 3F.

**Estimated time:** 2–3 days

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/pipeline/queries.ts` | Created (helper queries) | 3A |
| `convex/pipeline/processor.ts` | Created (main dispatcher) | 3B |
| `convex/pipeline/inviteeCreated.ts` | Created (invitee.created handler) | 3C |
| `convex/pipeline/inviteeCanceled.ts` | Created (invitee.canceled handler) | 3D |
| `convex/pipeline/inviteeNoShow.ts` | Created (invitee_no_show handler) | 3E |
| `convex/webhooks/calendlyMutations.ts` | Modified (add scheduler call) | 3F |
| `convex/pipeline/mutations.ts` | Created (markProcessed utility) | 3G |

---

*End of Phase 3. This phase runs in PARALLEL with Phase 2. Together they unblock Phase 4 (Admin UI) and Phase 5 (Closer UI) respectively.*
