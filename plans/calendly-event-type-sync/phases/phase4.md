# Phase 4 — Event Type Webhook Reconciliation

**Goal:** Subscribe to Calendly event type webhooks, persist each delivery with correct idempotency keys, process event type payloads through the shared upsert path, and repair existing webhook subscriptions without a delete-first delivery gap.

**Prerequisite:** Phase 1 raw webhook schema widening is in place. Phase 2 exposes shared event type normalization/upsert helpers. Phase 3 is not required, but the delayed reconciliation scheduled by this phase uses `internal.calendly.eventTypes.syncForTenant`.

**Runs in PARALLEL with:** Phase 5 UI work can continue independently. Phase 6 verification should wait until this phase is complete.

**Skills to invoke:**
- `convex` — HTTP action payload handling, internal mutations, scheduler, and action/mutation boundaries.
- `convex-migration-helper` — only if webhook idempotency fields are changed from optional to required, which is not part of MVP.

**Acceptance Criteria:**
1. New Calendly webhook subscriptions include `event_type.created`, `event_type.updated`, and `event_type.deleted`.
2. Health check detects active subscriptions that are missing required event names.
3. Webhook repair creates the replacement subscription before deleting the old subscription.
4. Event type webhook deliveries are deduped by `webhookEventKey`, not by `payload.uri` alone.
5. `calendlyResourceUri` stores the event type resource URI for support/debugging.
6. `event_type.created` and `event_type.updated` upsert metadata immediately and schedule delayed full reconciliation.
7. `event_type.deleted` marks the row deleted, disables portal visibility, and schedules delayed full reconciliation.
8. Unknown webhook event types are still marked processed as before.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (Required event list) ─────────┬── 4B (Health repair)
                                  │
4C (Webhook idempotency keys) ────┼── 4D (Processor dispatch)
                                  │
2B (Shared upsert helper) ────────┘

4D complete ───────────────────────── 4E (Webhook upsert mutation)
4B + 4C + 4E complete ─────────────── 4F (Webhook verification)
```

**Optimal execution:**
1. Start 4A and 4C first because they define the subscription and persistence contracts.
2. Implement 4B after 4A exports the required event list.
3. Implement 4D and 4E after Phase 2 upsert helpers are available.
4. Finish with 4F using local webhook payload samples or Calendly dashboard test deliveries.

**Estimated time:** 1.5-2 days

---

## Subphases

### 4A — Add Event Type Subscription Events

**Type:** Backend
**Parallelizable:** Yes — independent of processing changes.

**What:** Extend the Calendly webhook subscription event list and export it for health checks.

**Why:** New tenants should receive event type signals immediately, and existing tenants need a single required-event source of truth for repair.

**Where:**
- `convex/calendly/webhookSetup.ts` (modify)

**How:**

**Step 1: Export the required event list.**

```typescript
// Path: convex/calendly/webhookSetup.ts

export const REQUIRED_WEBHOOK_EVENTS = [
  "invitee.created",
  "invitee.canceled",
  "invitee_no_show.created",
  "invitee_no_show.deleted",
  "routing_form_submission.created",
  "event_type.created",
  "event_type.updated",
  "event_type.deleted",
] as const;

const SUBSCRIBED_EVENTS = REQUIRED_WEBHOOK_EVENTS;
```

**Step 2: Keep subscription creation using the shared list.**

```typescript
// Path: convex/calendly/webhookSetup.ts

body: JSON.stringify({
  url: callbackUrl,
  events: SUBSCRIBED_EVENTS,
  organization: organizationUri,
  scope: "organization",
  signing_key: signingSecret,
}),
```

**Key implementation notes:**
- Keep `routing_form_submission.created` because it is already subscribed even if currently unhandled.
- Do not rename existing constants in a way that breaks generated references.
- The event list should be reused by health check instead of duplicated.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/webhookSetup.ts` | Modify | Add event_type.* events and export required list |

---

### 4B — Repair Subscriptions Without Delete-First Gap

**Type:** Backend
**Parallelizable:** Yes — depends on 4A required event list.

**What:** Enhance health check to inspect subscription event names, create a replacement webhook with a versioned callback URL when events mismatch, store the replacement, then delete the old subscription.

**Why:** Existing tenants have active webhooks without event type events. Delete-first repair can permanently miss events that occur during the gap.

**Where:**
- `convex/calendly/healthCheck.ts` (modify)
- `convex/calendly/webhookSetup.ts` (modify)
- `convex/calendly/webhookSetupMutations.ts` (reference)

**How:**

**Step 1: Inspect webhook event list.**

```typescript
// Path: convex/calendly/healthCheck.ts

import {
  deleteWebhookSubscription,
  provisionWebhookSubscription,
  REQUIRED_WEBHOOK_EVENTS,
} from "./webhookSetup";

type WebhookSubscriptionState =
  | "active"
  | "missing"
  | "disabled"
  | "events_mismatch";

async function getWebhookSubscriptionState(
  accessToken: string,
  webhookUri: string,
): Promise<WebhookSubscriptionState> {
  const webhookUuid = new URL(webhookUri).pathname
    .split("/")
    .filter(Boolean)
    .pop();
  if (!webhookUuid) {
    throw new Error(`Invalid Calendly webhook URI: ${webhookUri}`);
  }

  const response = await fetch(
    `https://api.calendly.com/webhook_subscriptions/${webhookUuid}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (response.status === 404) return "missing";
  if (!response.ok) {
    throw new Error(
      `Unable to inspect Calendly webhook subscription ${webhookUuid}: ${response.status} ${await response.text()}`,
    );
  }

  const data = (await response.json()) as {
    resource?: { state?: "active" | "disabled"; events?: string[] };
  };
  if (data.resource?.state === "disabled") return "disabled";

  const events = new Set(data.resource?.events ?? []);
  return REQUIRED_WEBHOOK_EVENTS.every((event) => events.has(event))
    ? "active"
    : "events_mismatch";
}
```

**Step 2: Allow versioned callback URLs for overlapping replacement.**

```typescript
// Path: convex/calendly/webhookSetup.ts

type ProvisionWebhookArgs = {
  tenantId: string;
  accessToken: string;
  organizationUri: string;
  convexSiteUrl: string;
  signingSecret?: string;
  webhookVersion?: string;
};

function buildCallbackUrl(args: ProvisionWebhookArgs) {
  const url = new URL(`${args.convexSiteUrl}/webhooks/calendly`);
  url.searchParams.set("tenantId", args.tenantId);
  if (args.webhookVersion) {
    url.searchParams.set("webhookVersion", args.webhookVersion);
  }
  return url.toString();
}
```

**Step 3: Repair mismatched active subscriptions by creating first.**

```typescript
// Path: convex/calendly/healthCheck.ts

if (webhookState === "events_mismatch" && tenant.webhookUri) {
  const oldWebhookUri = tenant.webhookUri;
  const { webhookUri, signingSecret } = await provisionWebhookSubscription({
    tenantId,
    accessToken,
    organizationUri: tenant.organizationUri,
    convexSiteUrl: getConvexSiteUrl(),
    signingSecret: tenant.webhookSecret ?? undefined,
    webhookVersion: Date.now().toString(),
  });

  await ctx.runMutation(
    internal.calendly.webhookSetupMutations.storeWebhookAndActivate,
    { tenantId, webhookUri, webhookSecret: signingSecret },
  );

  await deleteWebhookSubscription({ accessToken, webhookUri: oldWebhookUri });
}
```

**Key implementation notes:**
- If replacement creation fails, leave the old webhook active and return/report `events_mismatch`.
- `webhookVersion` is only for callback uniqueness; signature verification still relies on tenant signing key.
- Existing missing/disabled repair can keep the normal callback URL.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/healthCheck.ts` | Modify | Inspect required events and repair mismatch |
| `convex/calendly/webhookSetup.ts` | Modify | Versioned callback support |

---

### 4C — Persist Correct Webhook Idempotency Keys

**Type:** Backend
**Parallelizable:** Yes — depends on Phase 1 schema fields.

**What:** Change webhook ingestion and persistence to compute `webhookEventKey` separately from Calendly resource URI.

**Why:** For `event_type.updated`, `payload.uri` is the event type resource and repeats across deliveries. Deduping on it would drop later updates for the same event type.

**Where:**
- `convex/webhooks/calendly.ts` (modify)
- `convex/webhooks/calendlyMutations.ts` (modify)

**How:**

**Step 1: Extract resource URI and delivery key separately.**

```typescript
// Path: convex/webhooks/calendly.ts

function getPayloadBody(payload: unknown) {
  return isRecord(payload) && isRecord(payload.payload)
    ? payload.payload
    : undefined;
}

function getCalendlyResourceUri(payload: unknown) {
  const payloadBody = getPayloadBody(payload);
  return payloadBody ? getNonEmptyString(payloadBody, "uri") : undefined;
}

function getWebhookEventKey(envelope: Record<string, unknown>) {
  const eventType = getNonEmptyString(envelope, "event") ?? "unknown";
  const createdAt =
    getNonEmptyString(envelope, "created_at") ?? Date.now().toString();
  const resourceUri = getCalendlyResourceUri(envelope) ?? "unknown-resource";

  return `${eventType}:${resourceUri}:${createdAt}`;
}
```

**Step 2: Pass both fields to persistence.**

```typescript
// Path: convex/webhooks/calendly.ts

const envelope = isRecord(payload) ? payload : {};
const eventType =
  typeof envelope.event === "string" ? envelope.event : "unknown";
const calendlyResourceUri = getCalendlyResourceUri(envelope);
const webhookEventKey = getWebhookEventKey(envelope);
const calendlyEventUri =
  eventType.startsWith("event_type.")
    ? webhookEventKey
    : getCalendlyEventUri(envelope) ?? webhookEventKey;

await ctx.runMutation(internal.webhooks.calendlyMutations.persistRawEvent, {
  tenantId: tenant.tenantId,
  calendlyEventUri,
  webhookEventKey,
  calendlyResourceUri,
  eventType,
  payload: rawBody,
});
```

**Step 3: Prefer `webhookEventKey` for dedupe when present.**

```typescript
// Path: convex/webhooks/calendlyMutations.ts

export const persistRawEvent = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyEventUri: v.string(),
    webhookEventKey: v.optional(v.string()),
    calendlyResourceUri: v.optional(v.string()),
    eventType: v.string(),
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    const existingEvent = args.webhookEventKey
      ? await ctx.db
          .query("rawWebhookEvents")
          .withIndex("by_tenantId_and_eventType_and_webhookEventKey", (q) =>
            q
              .eq("tenantId", args.tenantId)
              .eq("eventType", args.eventType)
              .eq("webhookEventKey", args.webhookEventKey),
          )
          .first()
      : await ctx.db
          .query("rawWebhookEvents")
          .withIndex("by_tenantId_and_eventType_and_calendlyEventUri", (q) =>
            q
              .eq("tenantId", args.tenantId)
              .eq("eventType", args.eventType)
              .eq("calendlyEventUri", args.calendlyEventUri),
          )
          .first();

    if (existingEvent) {
      return null;
    }

    const rawEventId = await ctx.db.insert("rawWebhookEvents", {
      ...args,
      processed: false,
      receivedAt: Date.now(),
    });

    await ctx.scheduler.runAfter(
      0,
      internal.pipeline.processor.processRawEvent,
      { rawEventId },
    );

    return rawEventId;
  },
});
```

**Key implementation notes:**
- Scheduling webhook behavior should remain compatible with legacy `calendlyEventUri`.
- The HTTP handler must continue to ignore `webhookVersion` for auth; tenant ID and signature are authoritative.
- Do not use Calendly resource URI as the delivery dedupe key for event type webhooks.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/webhooks/calendly.ts` | Modify | Extract delivery/resource keys |
| `convex/webhooks/calendlyMutations.ts` | Modify | Dedupe by webhook event key when present |

---

### 4D — Dispatch Event Type Webhooks

**Type:** Backend
**Parallelizable:** No — depends on 4C persisted keys and Phase 2 upsert helpers.

**What:** Add `event_type.created`, `event_type.updated`, and `event_type.deleted` cases to the pipeline processor.

**Why:** Event type changes should update Settings quickly, while delayed full sync remains the reconciliation backstop.

**Where:**
- `convex/pipeline/processor.ts` (modify)
- `convex/calendly/eventTypeMutations.ts` (modify in 4E)

**How:**

**Step 1: Add dispatch cases.**

```typescript
// Path: convex/pipeline/processor.ts

case "event_type.created":
case "event_type.updated":
case "event_type.deleted":
  console.log(`[Pipeline] Handler selected: calendly.eventType webhook`);
  await ctx.runMutation(
    internal.calendly.eventTypeMutations.upsertEventTypeFromWebhook,
    {
      tenantId: rawEvent.tenantId,
      payload,
      receivedAt: rawEvent.receivedAt,
    },
  );
  await ctx.scheduler.runAfter(
    5_000,
    internal.calendly.eventTypes.syncForTenant,
    {
      tenantId: rawEvent.tenantId,
      reason: rawEvent.eventType,
    },
  );
  await ctx.runMutation(internal.pipeline.mutations.markProcessed, {
    rawEventId,
  });
  break;
```

**Step 2: Keep unknown event behavior unchanged.**

```typescript
// Path: convex/pipeline/processor.ts

default:
  console.log(
    `[Pipeline] Unhandled event type "${rawEvent.eventType}" for event ${rawEventId}`,
  );
  await ctx.runMutation(internal.pipeline.mutations.markProcessed, {
    rawEventId,
  });
```

**Key implementation notes:**
- Schedule delayed full sync for all three event type events to coalesce burst edits.
- Mark the raw event processed only after the upsert mutation and delayed sync scheduling succeed.
- Do not call external Calendly API directly from the processor action for this webhook path.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/processor.ts` | Modify | Dispatch event_type.* events |

---

### 4E — Upsert Event Type From Webhook

**Type:** Backend
**Parallelizable:** No — depends on Phase 2 shared upsert helper.

**What:** Expose an internal mutation that normalizes an event type webhook payload and writes it through the same path used by full sync.

**Why:** Webhook payload shape materially matches the Event Type API resource; duplicating write logic would risk different ownership behavior.

**Where:**
- `convex/calendly/eventTypeMutations.ts` (modify)

**How:**

**Step 1: Export webhook upsert mutation.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

export const upsertEventTypeFromWebhook = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    payload: v.any(),
    receivedAt: v.number(),
  },
  handler: async (ctx, { tenantId, payload, receivedAt }) => {
    const normalized = normalizeCalendlyEventTypeResource(payload);
    if (!normalized) {
      throw new Error("Malformed Calendly event type webhook payload");
    }

    const result = await upsertSingleEventTypeResource(ctx, {
      tenantId,
      normalized,
      syncStartedAt: receivedAt,
      source: "webhook",
    });

    console.log("[Calendly:EventTypes] webhook event type upserted", {
      tenantId,
      eventTypeConfigId: result.eventTypeConfigId,
      action: result.action,
      questionsMerged: result.questionsMerged,
    });

    return result;
  },
});
```

**Step 2: Ensure deleted webhook payloads disable portal links.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

// Already handled by buildEventTypeConfigSyncPatch:
if (normalized.deletedAt) {
  patch.calendlyActive = false;
  patch.calendlySyncStatus = "deleted";
  patch.calendlyDeletedAt = normalized.deletedAt;
  patch.linkPortalEnabled = false;
}
```

**Key implementation notes:**
- If Calendly ever sends a deleted event without `deleted_at`, use `active = false` plus event type from the raw event as a fallback only if needed.
- Webhook upsert should set `displayNameSource = "webhook_discovered"` only when creating a previously unknown row.
- Full sync can later upgrade source metadata and set `displayNameSource = "calendly_synced"` only for sync-created rows; do not reclassify admin-entered rows.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypeMutations.ts` | Modify | Webhook upsert mutation |

---

### 4F — Webhook Verification

**Type:** Manual
**Parallelizable:** No — runs after 4A-4E.

**What:** Validate subscription creation, repair behavior, event persistence, and event type processing.

**Why:** Webhook changes can drop real events if repair ordering or idempotency is wrong.

**Where:**
- Local terminal verification
- Convex dashboard logs
- Calendly webhook dashboard/test delivery

**How:**

**Step 1: Run codegen and TypeScript.**

```bash
// Path: terminal
npx convex dev --once
pnpm tsc --noEmit
```

**Step 2: Verify required event names.**

```typescript
// Path: convex/calendly/webhookSetup.ts

// REQUIRED_WEBHOOK_EVENTS should include:
// "event_type.created"
// "event_type.updated"
// "event_type.deleted"
```

**Step 3: Verify repeated update deliveries are not dropped.**

```typescript
// Path: convex/webhooks/calendlyMutations.ts

// Two event_type.updated payloads for the same payload.uri but different
// envelope created_at values should insert two rawWebhookEvents rows.
```

**Key implementation notes:**
- If Calendly refuses overlapping versioned callback URLs, do not delete the old webhook automatically; report `events_mismatch`.
- Inspect raw webhook rows and confirm `calendlyResourceUri` is the event type URI.
- Confirm `rawWebhookEvents.processed` becomes true after processor completion.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/_generated/*` | Generate | Webhook function references |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/calendly/webhookSetup.ts` | Modify | 4A, 4B |
| `convex/calendly/healthCheck.ts` | Modify | 4B |
| `convex/webhooks/calendly.ts` | Modify | 4C |
| `convex/webhooks/calendlyMutations.ts` | Modify | 4C |
| `convex/pipeline/processor.ts` | Modify | 4D |
| `convex/calendly/eventTypeMutations.ts` | Modify | 4E |
| `convex/_generated/*` | Generate | 4F |
