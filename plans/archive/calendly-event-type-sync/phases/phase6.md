# Phase 6 — Verification and Rollout

**Goal:** Validate the backend sync, manual admin operation, Settings UI, portal safety, and production rollout path before running sync for the current production tenant.

**Prerequisite:** Phases 1-5 are implemented and passing local TypeScript. The production Calendly OAuth app has `event_types:read`, and the tenant is connected with an account that can read organization event types.

**Runs in PARALLEL with:** Nothing — this is the final integration, rollout, and rollback phase.

**Skills to invoke:**
- `convex` — run and inspect Convex functions, dashboard data, and tenant sync state.
- `playwright` — browser verification for Settings and public portal flows if manual inspection is insufficient.
- `frontend-design` — final Settings UI pass for dense operational readability.
- `convex-migration-helper` — only if rollout discovers a need to narrow schema or backfill required fields, which MVP avoids.

**Acceptance Criteria:**
1. Manual event type sync creates zero-booking event types and preserves CRM-owned settings.
2. Manual event type sync with expired token refreshes once and completes or fails with a clear status.
3. Multi-page Calendly responses upsert every page before marking not-returned rows.
4. Deleted event types returned by sync are marked deleted and have `linkPortalEnabled = false`.
5. Existing admin display names and admin/imported booking URLs are preserved.
6. Settings > Event Types shows synced active, inactive, deleted, not-returned, and legacy rows with stable layout.
7. Public portal bootstrap and copy tracking reject deleted, inactive, and not-returned event types.
8. No OAuth trigger, cron, or `event_type.*` webhook subscription is present in the MVP.
9. Rollback can disable the manual UI while leaving optional metadata fields in place.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
6A (Compile + schema gates) ───────┬── 6B (Backend scenario matrix)
                                   │
6C (UI + portal verification) ─────┤
                                   └── 6D (Production manual sync)

6B + 6C + 6D complete ─────────────── 6E (Rollback notes + handoff)
```

**Optimal execution:**
1. Run 6A first so rollout does not start with known type/schema failures.
2. Run 6B in development or staging with realistic Calendly responses.
3. Run 6C against the local app with realistic data states.
4. Perform 6D manually for the current production tenant.
5. Finish with 6E rollback and residual-risk notes.

**Estimated time:** 1-2 days, depending on Calendly tenant access.

---

## Subphases

### 6A — Compile and Schema Gates

**Type:** Manual  
**Parallelizable:** No — must pass before behavioral verification.

**What:** Run Convex schema/type generation and the repo TypeScript gate.

**Why:** The feature touches schema, generated Convex function references, Node actions, and React component types.

**Where:**
- Terminal (verify)
- `convex/schema.ts` (verify)

**How:**

**Step 1: Run Convex once.**

```bash
# Path: terminal
npx convex dev --once
```

**Step 2: Run TypeScript.**

```bash
# Path: terminal
pnpm tsc --noEmit
```

**Step 3: Confirm the migration shape is still widen-only.**

```typescript
// Path: convex/schema.ts

// Verify all new eventTypeConfigs and tenantCalendlyConnections fields are optional.
// Verify no existing field was removed, renamed, or narrowed.
```

**Key implementation notes:**
- If schema validation fails because a field became required, stop and re-plan with `convex-migration-helper`.
- Do not run production sync before TypeScript and schema checks pass.
- Generated Convex files may change after `npx convex dev --once`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Verify | Widen-only schema |
| `convex/_generated/*` | Generated / Verify | Convex generated output |

---

### 6B — Backend Sync Scenario Matrix

**Type:** Manual  
**Parallelizable:** Yes — can run independently of UI verification after 6A.

**What:** Exercise core sync behavior across success, preservation, token refresh, rate limit, pagination, and deleted/not-returned states.

**Why:** The full sync is the online metadata backfill. Incorrect stale marking or ownership overwrites would affect production configuration.

**Where:**
- `convex/calendly/eventTypes.ts` (verify)
- `convex/calendly/eventTypeMutations.ts` (verify)
- Convex dashboard data (verify)

**How:**

**Step 1: Verify success path on a connected dev tenant.**

```typescript
// Path: convex/calendly/eventTypes.ts

// Call api.calendly.eventTypes.syncMyTenantEventTypes as a tenant admin.
// Expected:
// - status === "success"
// - totalSeen equals the Calendly organization event type count
// - created + updated + unchanged is explainable from existing rows
// - lastEventTypeSyncStatus === "success"
// - lastEventTypeSyncCount === totalSeen
```

**Step 2: Verify ownership preservation.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

// Existing config before sync:
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

**Step 3: Verify failure and edge cases.**

```typescript
// Path: convex/calendly/eventTypes.ts

// Scenarios:
// - Expired access token: refreshes once and retries current page.
// - Repeated 401: sync fails and records lastEventTypeSyncStatus = "failed".
// - 403: sync fails with reconnect/permission guidance and preserves rows.
// - 429: sync fails, clears lock, and does not schedule retry.
// - Page 2 failure: page 1 writes remain, but not-returned marking does not run.
```

**Step 4: Verify deleted and not-returned states.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

// Returned with deleted_at:
// calendlySyncStatus === "deleted"
// calendlyActive === false
// linkPortalEnabled === false
//
// Previously synced and absent from a completed full sync:
// calendlySyncStatus === "not_returned"
// document is not deleted
```

**Key implementation notes:**
- Use real Calendly data for final validation where possible.
- If multi-page real data is unavailable, mock or temporarily lower page size in development only.
- Record the production Calendly UI count before the production manual sync.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypes.ts` | Verify | Full sync action behavior |
| `convex/calendly/eventTypeMutations.ts` | Verify | Upsert and status behavior |

---

### 6C — UI and Portal Verification

**Type:** Manual / Frontend  
**Parallelizable:** Yes — can run independently of backend edge-case tests after realistic rows exist.

**What:** Verify Settings and public portal behavior across relevant sync states and viewport sizes.

**Why:** Admins need accurate operational state, and public portal users must not see unsafe event types.

**Where:**
- `app/workspace/settings/_components/calendly-connection.tsx` (verify)
- `app/workspace/settings/_components/event-type-config-list.tsx` (verify)
- `app/workspace/settings/_components/field-mappings-tab.tsx` (verify)
- `convex/linkPortal/portalQueries.ts` (verify)
- `convex/linkPortal/copyMutations.ts` (verify)

**How:**

**Step 1: Start the app.**

```bash
# Path: terminal
pnpm dev
```

**Step 2: Verify Settings > Calendly.**

```tsx
// Path: app/workspace/settings/_components/calendly-connection.tsx

// Expected:
// - Button disabled when disconnected.
// - Button disabled while local action is in flight.
// - Button disabled when eventTypeSyncInProgress is true.
// - Last sync status/count/error render compactly.
```

**Step 3: Verify Settings > Event Types and Field Mappings.**

```tsx
// Path: app/workspace/settings/_components/event-type-config-list.tsx

// Expected:
// - Zero-booking synced event types are visible.
// - Calendly name is shown when different from CRM display name.
// - Deleted/inactive/not-returned badges fit on mobile.
// - Long URLs truncate and do not overflow cards.
```

**Step 4: Verify public portal safety.**

```typescript
// Path: convex/linkPortal/portalQueries.ts

// Expected:
// - active + mapped + published rows appear.
// - inactive/deleted/not_returned rows do not appear.
// - calendly_synced booking URL without calendlySchedulingUrl does not appear.
```

**Key implementation notes:**
- Use the in-app browser or Playwright screenshots if layout is uncertain.
- Check desktop and mobile widths.
- Confirm stale client copy attempts fail through `copyMutations`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Settings UI files | Verify | Browser QA |
| `convex/linkPortal/portalQueries.ts` | Verify | Public portal filtering |
| `convex/linkPortal/copyMutations.ts` | Verify | Stale copy rejection |

---

### 6D — Production Tenant Manual Sync

**Type:** Manual / Operations  
**Parallelizable:** No — perform after local verification.

**What:** Run manual sync for the current production tenant and reconcile counts against Calendly.

**Why:** The app has one production test tenant, and the first manual sync acts as the online metadata backfill.

**Where:**
- Production Settings page (manual)
- Convex dashboard (verify)
- Calendly UI (verify)

**How:**

**Step 1: Record pre-sync state.**

```typescript
// Path: production checklist

// Record:
// - Existing eventTypeConfigs count.
// - Calendly organization event type count.
// - Existing published portal rows.
// - Any admin-entered display names or booking URLs.
```

**Step 2: Run the sync from Settings.**

```tsx
// Path: app/workspace/settings/_components/calendly-connection.tsx

// Click "Sync Event Types" as tenant_master or tenant_admin.
// Expected toast includes totalSeen, created, and updated counts.
```

**Step 3: Reconcile after sync.**

```typescript
// Path: production checklist

// Verify:
// - lastEventTypeSyncStatus === "success".
// - lastEventTypeSyncCount matches Calendly UI count.
// - Existing CRM-owned fields are preserved.
// - Deleted/inactive rows are not public portal bookable.
```

**Key implementation notes:**
- Do not run schema-narrowing or data-deleting migrations.
- If Calendly returns 403, preserve data and reconnect with an org owner/admin account.
- Keep existing scheduling webhook subscription unchanged.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Production data | Verify / Update via sync | Manual metadata backfill |

---

### 6E — Rollback Notes and Handoff

**Type:** Documentation / Manual  
**Parallelizable:** No — final phase output.

**What:** Document the exact rollback path, residual risks, and future follow-ups.

**Why:** Optional metadata fields make rollback straightforward, but the team needs to know which behavior to disable if sync causes issues.

**Where:**
- `plans/calendly-event-type-sync/rollout-notes.md` (new, optional)
- PR description / handoff notes (create when publishing)

**How:**

**Step 1: Document rollback.**

```markdown
<!-- Path: plans/calendly-event-type-sync/rollout-notes.md -->

# Calendly Event Type Sync Rollout Notes

Rollback:
1. Hide the Sync Event Types button in Settings.
2. Leave optional schema fields in place.
3. Keep invitee.created fallback creation running.
4. Do not delete eventTypeConfigs or field catalog rows.
```

**Step 2: Document residual risks.**

```markdown
<!-- Path: plans/calendly-event-type-sync/rollout-notes.md -->

Residual risks:
- Calendly metadata is stale until an admin clicks Sync Event Types again.
- Calendly may omit custom_questions from list responses in some cases.
- Settings uses a bounded 500-row MVP query until pagination is implemented.
```

**Key implementation notes:**
- Creating a separate rollout notes file is optional if the PR description captures the same information.
- Do not present event type webhooks or cron reconciliation as part of MVP completion.
- Future event type webhook support needs its own design because idempotency and repair semantics are different.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/calendly-event-type-sync/rollout-notes.md` | Create / Optional | Rollback and residual risks |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Verify | 6A |
| `convex/_generated/*` | Generated / Verify | 6A |
| `convex/calendly/eventTypes.ts` | Verify | 6B |
| `convex/calendly/eventTypeMutations.ts` | Verify | 6B |
| `app/workspace/settings/_components/calendly-connection.tsx` | Verify | 6C |
| `app/workspace/settings/_components/event-type-config-list.tsx` | Verify | 6C |
| `app/workspace/settings/_components/field-mappings-tab.tsx` | Verify | 6C |
| `convex/linkPortal/portalQueries.ts` | Verify | 6C |
| `convex/linkPortal/copyMutations.ts` | Verify | 6C |
| Production data | Verify / Update via sync | 6D |
| `plans/calendly-event-type-sync/rollout-notes.md` | Create / Optional | 6E |
