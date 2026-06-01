# Phase 4 — Manual Sync-Only Boundary

**Goal:** Preserve the MVP boundary that event type metadata freshness is controlled only by the admin clicking Sync Event Types. After this phase, the implementation has explicit checks that no Calendly `event_type.*` webhooks, OAuth-completion sync, or recurring reconciliation were added.

**Prerequisite:** Phase 2 internal sync exists and Phase 3 exposes the public manual action. This phase is an audit/guardrail phase and does not require schema changes.

**Runs in PARALLEL with:** Phase 5 UI work can proceed independently because this phase should not change user-facing APIs.

**Skills to invoke:**
- `convex` — audit function references, cron registration, webhook setup, and processor dispatch.
- `convex-migration-helper` — only if an implementer proposes webhook raw-event schema changes, which are outside MVP scope.

**Acceptance Criteria:**
1. New Calendly webhook subscriptions do not include `event_type.created`, `event_type.updated`, or `event_type.deleted`.
2. Existing scheduling webhook events remain subscribed and unchanged.
3. `convex/pipeline/processor.ts` does not dispatch `event_type.*` payloads to event type sync/upsert logic.
4. Calendly OAuth completion does not schedule event type sync.
5. `convex/crons.ts` does not register a recurring event type sync cron.
6. Unknown webhook event types are still marked processed as before.
7. Settings freshness is represented by `lastEventTypeSyncCompletedAt`, not by automatic webhook freshness.
8. A future event type webhook implementation is documented as a separate design/phase, not hidden inside this MVP.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (Webhook subscription audit) ─────┬── 4D (Boundary notes)
                                     │
4B (Processor audit) ────────────────┤
                                     │
4C (OAuth + cron audit) ─────────────┘

4A + 4B + 4C + 4D complete ───────────── 4E (Negative-scope verification)
```

**Optimal execution:**
1. Run 4A, 4B, and 4C in parallel because they inspect separate modules.
2. Add or update boundary notes only if the implementation needs clarification.
3. Finish with 4E to verify no automatic trigger is reachable.

**Estimated time:** 0.25-0.5 day

---

## Subphases

### 4A — Webhook Subscription Event Audit

**Type:** Backend / Manual  
**Parallelizable:** Yes — independent of processor and cron audits.

**What:** Verify the Calendly webhook subscription event list remains limited to existing scheduling/routing events.

**Why:** The MVP intentionally avoids event type webhook subscription repair, idempotency changes, and a second source of event type metadata freshness.

**Where:**
- `convex/calendly/webhookSetup.ts` (verify)

**How:**

**Step 1: Confirm the subscribed events do not include event type events.**

```typescript
// Path: convex/calendly/webhookSetup.ts

const SUBSCRIBED_EVENTS = [
  "invitee.created",
  "invitee.canceled",
  "invitee_no_show.created",
  "invitee_no_show.deleted",
  "routing_form_submission.created",
] as const;
```

**Step 2: Reject accidental event type subscription additions.**

```typescript
// Path: convex/calendly/webhookSetup.ts

// Do not add these in the MVP:
// "event_type.created"
// "event_type.updated"
// "event_type.deleted"
```

**Key implementation notes:**
- Do not modify webhook subscription repair logic for event type events.
- Do not add raw webhook schema fields for event type delivery idempotency in this MVP.
- Keep existing scheduling webhook coverage unchanged.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/webhookSetup.ts` | Verify | Subscription event list remains scheduling-only |

---

### 4B — Processor Dispatch Audit

**Type:** Backend / Manual  
**Parallelizable:** Yes — independent of webhook setup.

**What:** Verify `event_type.*` webhook payloads, if ever received, do not directly mutate event type configs in this MVP.

**Why:** Manual sync must remain the single metadata import path. Accidental processor dispatch would introduce freshness semantics not covered by rollout or rollback.

**Where:**
- `convex/pipeline/processor.ts` (verify)

**How:**

**Step 1: Keep dispatch limited to existing booking lifecycle handlers.**

```typescript
// Path: convex/pipeline/processor.ts

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

  default:
    await ctx.runMutation(internal.pipeline.mutations.markProcessed, {
      rawEventId,
    });
}
```

**Step 2: Confirm no event type processor function exists.**

```bash
# Path: terminal
rg "event_type\\.|upsertEventTypeFromWebhook|eventTypeWebhook" convex
```

**Key implementation notes:**
- Unknown event types should still be marked processed to avoid retry loops.
- Do not add a delayed full sync from webhook processing.
- If event type webhooks are introduced later, they need a separate idempotency design.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/processor.ts` | Verify | No event type webhook dispatch |

---

### 4C — OAuth and Cron Trigger Audit

**Type:** Backend / Manual  
**Parallelizable:** Yes — independent of webhook audits.

**What:** Verify event type sync is not scheduled after OAuth completion and not registered as a recurring cron.

**Why:** The design states that sync is explicit through the admin button for MVP. Automatic sync would surprise tenants and complicate rollback.

**Where:**
- `convex/calendly/oauth.ts` (verify)
- `convex/crons.ts` (verify)

**How:**

**Step 1: Keep OAuth post-provision behavior focused on existing setup.**

```typescript
// Path: convex/calendly/oauth.ts

await ctx.runMutation(
  internal.calendly.webhookSetupMutations.storeWebhookAndActivate,
  {
    tenantId,
    webhookUri,
    webhookSecret: signingSecret,
  },
);

await ctx.scheduler.runAfter(0, internal.calendly.orgMembers.syncForTenant, {
  tenantId,
});

// Do not schedule internal.calendly.eventTypes.syncForTenant here.
```

**Step 2: Keep the cron registry unchanged.**

```typescript
// Path: convex/crons.ts

crons.interval(
  "sync-calendly-org-members",
  { hours: 24 },
  internal.calendly.orgMembers.syncAllTenants,
  {},
);

// Do not register "sync-calendly-event-types" in the MVP.
```

**Key implementation notes:**
- Existing token refresh, health check, org member sync, and cleanup crons remain valid.
- If support wants a one-off production sync, use the manual admin action or an explicit operator call, not a cron.
- Keep OAuth success independent from event type sync failure.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/oauth.ts` | Verify | No OAuth-completion event type sync |
| `convex/crons.ts` | Verify | No recurring event type sync |

---

### 4D — Freshness Boundary Notes

**Type:** Documentation / Frontend  
**Parallelizable:** Yes — depends only on the Phase 3 status query shape.

**What:** Ensure implementation notes and UI copy treat `lastEventTypeSyncCompletedAt` as the freshness indicator.

**Why:** Without webhook or cron reconciliation, admins need to understand that Calendly changes after the last sync are not reflected until they click Sync Event Types again.

**Where:**
- `app/workspace/settings/_components/calendly-connection.tsx` (modify in Phase 5)
- `plans/calendly-event-type-sync/calendly-event-type-sync-design.md` (reference)

**How:**

**Step 1: Use freshness copy in the Settings card during Phase 5.**

```tsx
// Path: app/workspace/settings/_components/calendly-connection.tsx

<p className="text-xs text-muted-foreground">Last Event Type Sync</p>
<p className="mt-1 text-sm font-medium">
  {connectionStatus.lastEventTypeSyncCompletedAt
    ? formatCalendlyLastRefresh(connectionStatus.lastEventTypeSyncCompletedAt, Date.now())
    : "Never synced"}
</p>
```

**Step 2: Keep the copy factual.**

```tsx
// Path: app/workspace/settings/_components/calendly-connection.tsx

<p className="text-sm text-muted-foreground">
  Event type metadata updates when an admin runs manual sync.
</p>
```

**Key implementation notes:**
- Do not imply real-time event type metadata updates.
- Do not add visible instructional text beyond the compact operational status needed in Settings.
- Freshness copy belongs in Settings, not in the public portal.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/calendly-connection.tsx` | Modify in Phase 5 | Display manual-sync freshness status |
| `plans/calendly-event-type-sync/calendly-event-type-sync-design.md` | Reference | Source of manual-only boundary |

---

### 4E — Negative-Scope Verification

**Type:** Manual  
**Parallelizable:** No — verifies the full boundary.

**What:** Run code search and TypeScript checks proving the only event type sync trigger is the public manual admin action.

**Why:** This prevents scope creep before UI rollout.

**Where:**
- Repository-wide search (verify)

**How:**

**Step 1: Search for automatic event type sync references.**

```bash
# Path: terminal
rg "syncForTenant|syncMyTenantEventTypes|sync-calendly-event-types|event_type\\." convex app
```

**Step 2: Expected results.**

```typescript
// Path: convex/calendly/eventTypes.ts

// Allowed:
// - internal.calendly.eventTypes.syncForTenant definition
// - api.calendly.eventTypes.syncMyTenantEventTypes definition/call sites
//
// Not allowed in MVP:
// - cron registration
// - OAuth scheduler call
// - event_type.* subscription list entry
// - pipeline event_type.* dispatcher case
```

**Step 3: Run TypeScript.**

```bash
# Path: terminal
pnpm tsc --noEmit
```

**Key implementation notes:**
- If search finds automatic triggers, remove them or split them into a future plan.
- This phase should produce little or no code churn.
- Keep rollback simple: hide the button and leave optional metadata fields in place.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Repository search results | Verify | Confirm manual-only boundary |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/calendly/webhookSetup.ts` | Verify | 4A |
| `convex/pipeline/processor.ts` | Verify | 4B |
| `convex/calendly/oauth.ts` | Verify | 4C |
| `convex/crons.ts` | Verify | 4C |
| `app/workspace/settings/_components/calendly-connection.tsx` | Modify in Phase 5 | 4D |
| `plans/calendly-event-type-sync/calendly-event-type-sync-design.md` | Reference | 4D |
