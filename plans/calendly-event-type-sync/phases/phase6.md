# Phase 6 — Verification and Rollout

**Goal:** Validate the backend sync, webhook reconciliation, Settings UI, portal safety, and production rollout path before enabling daily reconciliation for the current production tenant.

**Prerequisite:** Phases 1-5 are implemented and passing local TypeScript. The production Calendly OAuth app has `event_types:read`, `webhooks:read`, and `webhooks:write`, and the tenant is connected with an account that can read organization event types.

**Runs in PARALLEL with:** Nothing — this is the final integration, rollout, and rollback phase.

**Skills to invoke:**
- `convex` — run and inspect Convex functions, scheduled jobs, and dashboard data.
- `playwright` — browser verification for Settings and public portal flows if manual inspection is insufficient.
- `frontend-design` — final Settings UI pass for dense operational readability.
- `convex-migration-helper` — only if rollout discovers a need to narrow schema or backfill required fields, which MVP avoids.

**Acceptance Criteria:**
1. Manual event type sync creates zero-booking event types and preserves CRM-owned settings.
2. Manual event type sync with expired token refreshes once and completes or fails with a clear status.
3. Multi-page Calendly responses upsert every page before marking missing rows.
4. Deleted event type webhook marks the row deleted and disables portal visibility.
5. Repeated `event_type.updated` deliveries for the same event type are both persisted when delivery timestamps differ.
6. Existing webhook subscriptions missing `event_type.*` are detected and repaired with replacement-before-delete ordering.
7. Settings > Event Types shows synced active, inactive, deleted, and not-returned rows with stable layout.
8. Public portal bootstrap and copy tracking reject deleted, inactive, and not-returned event types.
9. Rollback can disable cron/manual UI while leaving optional metadata fields in place.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
6A (Backend verification matrix) ─────┬── 6C (Production manual sync)
                                      │
6B (Webhook verification matrix) ─────┤
                                      │
6D (UI + portal verification) ────────┘

6C + 6D complete ─────────────────────── 6E (Enable cron + monitor)
6E complete ──────────────────────────── 6F (Rollback notes + handoff)
```

**Optimal execution:**
1. Run 6A and 6B in development or staging first.
2. Run 6D against local UI with realistic data states.
3. Perform 6C manually for the current production tenant.
4. Enable or leave enabled the cron only after the manual sync and webhook repair checks pass.
5. Finish by documenting rollback status and residual risks.

**Estimated time:** 1-2 days, depending on Calendly tenant access and webhook repair timing.

---

## Subphases

### 6A — Backend Sync Verification Matrix

**Type:** Manual
**Parallelizable:** Yes — can run independently of UI verification.

**What:** Exercise core full sync behavior across success, preservation, token refresh, rate limit, and missing/deleted state scenarios.

**Why:** The full sync is the source of truth and the online metadata backfill. Incorrect stale marking or ownership overwrites would affect production configuration.

**Where:**
- `convex/calendly/eventTypes.ts` (verify)
- `convex/calendly/eventTypeMutations.ts` (verify)
- Convex dashboard data

**How:**

**Step 1: Run compile gates.**

```bash
// Path: terminal
npx convex dev --once
pnpm tsc --noEmit
```

**Step 2: Verify success path on a connected dev tenant.**

```typescript
// Path: convex/calendly/eventTypes.ts

// Call api.calendly.eventTypes.syncMyTenantEventTypes as a tenant admin.
// Expected:
// - status === "success"
// - created + updated + unchanged equals Calendly organization event type count
// - lastEventTypeSyncStatus === "success"
// - lastEventTypeSyncCount is set on tenantCalendlyConnections
```

**Step 3: Verify ownership preservation.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

// Seed or identify an existing config:
// displayNameSource: "admin_entered"
// displayName: "CRM Custom Name"
// bookingUrlSource: "admin_entered"
// bookingBaseUrl: "https://example.com/custom"
//
// After sync:
// displayName remains "CRM Custom Name"
// bookingBaseUrl remains "https://example.com/custom"
// calendlyName and calendlySchedulingUrl update from Calendly
```

**Step 4: Verify missing/deleted handling.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

// Deleted payload or deleted_at response:
// calendlySyncStatus === "deleted"
// calendlyActive === false
// linkPortalEnabled === false
//
// Previously synced row absent from a completed full sync:
// calendlySyncStatus === "not_returned"
// document is not deleted
```

**Key implementation notes:**
- Do not run stale/missing checks against a partial failed sync.
- If real Calendly rate limits are hard to trigger, inspect the `429` branch and scheduled retry in code review.
- Record the Calendly UI event type count before production manual sync.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypes.ts` | Verify | Full sync action behavior |
| `convex/calendly/eventTypeMutations.ts` | Verify | Ownership and state transitions |

---

### 6B — Webhook Verification Matrix

**Type:** Manual
**Parallelizable:** Yes — can run independently of 6A after Phase 4.

**What:** Verify subscription event names, health repair ordering, raw webhook idempotency, and event type processor behavior.

**Why:** Webhooks provide low-latency updates, but a wrong dedupe key or repair sequence can silently lose events.

**Where:**
- `convex/calendly/webhookSetup.ts` (verify)
- `convex/calendly/healthCheck.ts` (verify)
- `convex/webhooks/calendly.ts` (verify)
- `convex/webhooks/calendlyMutations.ts` (verify)
- `convex/pipeline/processor.ts` (verify)

**How:**

**Step 1: Inspect required subscription events.**

```typescript
// Path: convex/calendly/webhookSetup.ts

// REQUIRED_WEBHOOK_EVENTS must include all existing scheduling events plus:
// "event_type.created"
// "event_type.updated"
// "event_type.deleted"
```

**Step 2: Verify health check mismatch repair.**

```typescript
// Path: convex/calendly/healthCheck.ts

// For a webhook missing event_type.*:
// 1. getWebhookSubscriptionState returns "events_mismatch".
// 2. health check creates a replacement with webhookVersion.
// 3. storeWebhookAndActivate stores the new webhook URI.
// 4. deleteWebhookSubscription deletes the old webhook URI.
```

**Step 3: Verify idempotency keys.**

```typescript
// Path: convex/webhooks/calendly.ts

// For event_type.updated:
// webhookEventKey = `${event}:${payload.uri}:${created_at}`
// calendlyResourceUri = payload.uri
// calendlyEventUri = webhookEventKey for legacy compatibility
```

**Step 4: Verify processor dispatch.**

```typescript
// Path: convex/pipeline/processor.ts

// event_type.created / updated / deleted:
// - calls internal.calendly.eventTypeMutations.upsertEventTypeFromWebhook
// - schedules internal.calendly.eventTypes.syncForTenant after 5 seconds
// - marks raw event processed after successful scheduling
```

**Key implementation notes:**
- If Calendly dashboard can send test event type webhooks, use it and inspect `rawWebhookEvents`.
- If direct test delivery is unavailable, use a local signed payload only in development.
- Confirm `payload.uri` is not the only dedupe component for event type updates.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/webhookSetup.ts` | Verify | Required events |
| `convex/calendly/healthCheck.ts` | Verify | Replacement-before-delete |
| `convex/webhooks/calendly.ts` | Verify | Event key extraction |
| `convex/webhooks/calendlyMutations.ts` | Verify | Dedupe behavior |
| `convex/pipeline/processor.ts` | Verify | Event type dispatch |

---

### 6C — Production Tenant Manual Sync

**Type:** Manual
**Parallelizable:** No — run after backend verification passes.

**What:** Trigger one manual event type sync for the current production tenant and compare results to Calendly.

**Why:** The app currently has one production tenant; manual sync before relying on cron gives a controlled first backfill.

**Where:**
- Production Settings > Calendly
- Convex dashboard
- Calendly organization UI

**How:**

**Step 1: Capture pre-sync state.**

```typescript
// Path: rollout-notes

// Record:
// - current number of eventTypeConfigs rows
// - current published portal event types
// - Calendly organization event type count from Calendly UI
// - existing webhook URI
```

**Step 2: Trigger manual sync from Settings.**

```tsx
// Path: app/workspace/settings/_components/calendly-connection.tsx

// Click "Sync Event Types" as tenant_master or tenant_admin.
// Expected toast: synced count or clear skipped/failure reason.
```

**Step 3: Validate post-sync state.**

```typescript
// Path: convex/eventTypeConfigs/queries.ts

// Expected:
// - zero-booking event types appear in Settings
// - CRM-owned fields are preserved
// - knownCustomFieldKeys includes Calendly custom question labels
// - lastEventTypeSyncStatus === "success"
```

**Key implementation notes:**
- If the result is `403`, preserve rows and reconnect Calendly with an owner/admin account.
- Do not proceed to webhook repair if event type sync cannot read organization event types.
- Keep a note of any rows marked inactive/deleted before publishing portal changes.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Production data | Verify | Manual backfill and status |

---

### 6D — Settings and Portal Verification

**Type:** Full-Stack
**Parallelizable:** Yes — can run after 5A-5E with seeded or synced data.

**What:** Verify Settings display and portal hiding/copy protections for every sync state.

**Why:** The feature changes visible admin workflows and public link availability.

**Where:**
- `app/workspace/settings/_components/calendly-connection.tsx` (verify)
- `app/workspace/settings/_components/event-type-config-list.tsx` (verify)
- `app/workspace/settings/_components/field-mappings-tab.tsx` (verify)
- `convex/linkPortal/portalQueries.ts` (verify)
- `convex/linkPortal/copyMutations.ts` (verify)

**How:**

**Step 1: Start local app for browser inspection.**

```bash
// Path: terminal
pnpm dev
```

**Step 2: Inspect Settings pages.**

```tsx
// Path: app/workspace/settings/_components/event-type-config-list.tsx

// Verify:
// - long Calendly names truncate
// - long booking URLs truncate
// - active/inactive/deleted/not_returned badges fit
// - "Calendly:" secondary name appears only when different from CRM name
```

**Step 3: Verify portal helper behavior.**

```typescript
// Path: convex/lib/eventTypeBookability.ts

// Expected:
// isPortalBookable({ calendlySyncStatus: "active", linkPortalEnabled: true, ...mapped }) === true
// isPortalBookable({ calendlySyncStatus: "inactive", linkPortalEnabled: true, ...mapped }) === false
// isPortalBookable({ calendlySyncStatus: "deleted", linkPortalEnabled: true, ...mapped }) === false
// isPortalBookable({ calendlySyncStatus: "not_returned", linkPortalEnabled: true, ...mapped }) === false
// isPortalBookable({ calendlySyncStatus: undefined, linkPortalEnabled: true, ...mapped }) === true
```

**Step 4: Verify copy tracking rejects stale clients.**

```typescript
// Path: convex/linkPortal/copyMutations.ts

// Try copying a link whose row became deleted/inactive after bootstrap.
// Expected: "Portal event type is not available."
```

**Key implementation notes:**
- Use desktop and mobile viewports.
- Ensure Settings still loads for admins when `lastEventTypeSyncStatus` is null before first sync.
- Meeting detail should continue to show the existing CRM `displayName`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Settings UI | Verify | Calendly, Event Types, Field Mappings |
| Link portal flows | Verify | Bootstrap and copy protection |

---

### 6E — Enable Cron and Monitor

**Type:** Config
**Parallelizable:** No — run after production manual sync and webhook checks.

**What:** Confirm the daily cron is active and monitor the first scheduled reconciliation after manual backfill.

**Why:** Cron should be the ongoing backstop, but it should not be the first uncontrolled production write.

**Where:**
- `convex/crons.ts` (verify)
- Convex dashboard logs
- `tenantCalendlyConnections` latest sync fields

**How:**

**Step 1: Confirm cron registration.**

```typescript
// Path: convex/crons.ts

crons.interval(
  "sync-calendly-event-types",
  { hours: 24 },
  internal.calendly.eventTypes.syncAllTenants,
  {},
);
```

**Step 2: Monitor first cron run.**

```typescript
// Path: convex/calendly/eventTypes.ts

// Expected logs:
// [Calendly:EventTypes] syncAllTenants scheduling
// [Calendly:EventTypes] syncForTenant page synced
// lastEventTypeSyncStatus === "success" or clear failure reason
```

**Step 3: Confirm no unwanted portal publication.**

```typescript
// Path: convex/eventTypeConfigs/queries.ts

// Sync may initialize bookingBaseUrl from Calendly, but it must not set
// linkPortalEnabled = true.
```

**Key implementation notes:**
- If cron fails with `403`, disable/hide manual sync only if needed but leave schema fields in place.
- One tenant means fan-out pressure is negligible; keep stagger for future tenants.
- Monitor for duplicate webhook events after repair.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/crons.ts` | Verify | Daily reconciliation active |
| Production logs/data | Verify | First scheduled reconciliation |

---

### 6F — Rollback and Handoff Notes

**Type:** Manual
**Parallelizable:** No — final documentation step.

**What:** Record the rollback path, residual risks, and follow-up items discovered during rollout.

**Why:** Optional schema fields make rollback simple, but operators need to know which switches to turn off and what data can safely remain.

**Where:**
- `plans/calendly-event-type-sync/phases/phase6.md` (reference)
- Release notes or deployment checklist if the team keeps one

**How:**

**Step 1: Rollback sequence if sync causes issues.**

```typescript
// Path: rollout-notes

// 1. Remove or comment the "sync-calendly-event-types" cron.
// 2. Hide the "Sync Event Types" button from Settings.
// 3. Keep optional metadata fields in schema.
// 4. Keep invitee.created fallback path running.
// 5. If event_type.* webhook deliveries cause issues, repair subscription
//    back to the old event list.
```

**Step 2: Record residual risk.**

```typescript
// Path: rollout-notes

// Known MVP compromises:
// - Settings event type queries use .take(500), not full pagination.
// - No sync-run history table; only latest status is stored.
// - Source-less existing display names remain protected and may diverge from Calendly.
```

**Step 3: Final compile gate.**

```bash
// Path: terminal
pnpm tsc --noEmit
```

**Key implementation notes:**
- Do not delete synced metadata as part of rollback; it is optional and safe at rest.
- If a future phase makes fields required, create a new widen-migrate-narrow plan first.
- Capture exact production sync date/time in deployment notes.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Rollout notes | Create / Modify | Production sync outcome and rollback status |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/calendly/eventTypes.ts` | Verify | 6A, 6E |
| `convex/calendly/eventTypeMutations.ts` | Verify | 6A |
| `convex/calendly/webhookSetup.ts` | Verify | 6B |
| `convex/calendly/healthCheck.ts` | Verify | 6B |
| `convex/webhooks/calendly.ts` | Verify | 6B |
| `convex/webhooks/calendlyMutations.ts` | Verify | 6B |
| `convex/pipeline/processor.ts` | Verify | 6B |
| Production data | Verify | 6C |
| Settings UI | Verify | 6D |
| Link portal flows | Verify | 6D |
| `convex/crons.ts` | Verify | 6E |
| Rollout notes | Create / Modify | 6F |
