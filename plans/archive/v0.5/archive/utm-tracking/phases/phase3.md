# Phase 3 — Pipeline Logging: `inviteeCanceled` & `inviteeNoShow`

**Goal:** Add UTM tracking-presence debug logs to the `inviteeCanceled` and `inviteeNoShow` pipeline handlers. No UTM data is stored or modified — these handlers only update status. The logs enable developers to verify that Calendly preserves tracking data on cancellation and no-show events, and to debug any future payload inconsistencies.

**Prerequisite:** Phase 2 complete — the `extractUtmParams` helper exists in `convex/lib/utmParams.ts`, and the `inviteeCreated` handler already stores UTMs. Phase 3 adds observability to the other two handlers.

**Runs in PARALLEL with:** Phase 4 (validation & edge case hardening). Both are independent backend enhancements.

> **Critical path:** This phase is NOT on the critical path. It adds debug observability only. If skipped, the UTM feature still functions correctly — only diagnostic logging is missing on cancel/no-show events.

**Skills to invoke:**
- `simplify` — After implementation, review the modified files for consistency with existing logging patterns.

**Acceptance Criteria:**
1. `convex/pipeline/inviteeCanceled.ts` logs `[Pipeline:invitee.canceled] UTM check | hasTracking={boolean}` on every processed event.
2. `convex/pipeline/inviteeNoShow.ts` `process` handler logs `[Pipeline:no-show] UTM check | hasTracking={boolean}` on every processed event.
3. `convex/pipeline/inviteeNoShow.ts` `revert` handler logs `[Pipeline:no-show] Revert UTM check | hasTracking={boolean}` on every processed event.
4. No UTM data is written, overwritten, or deleted on meetings or opportunities by these handlers.
5. Existing handler behavior (status transitions, cancellation metadata, opportunity patching) is unchanged.
6. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (inviteeCanceled debug log) ────────────────┐
                                                ├── 3C (Deploy and verify)
3B (inviteeNoShow debug logs — process+revert) ┘
```

**Optimal execution:**
1. Start 3A and 3B in parallel (they touch different files with zero overlap).
2. Once both are done → start 3C (deploy and verify logs appear in Convex dashboard).

**Estimated time:** 0.5 day (minimal code changes + verification).

---

## Subphases

### 3A — Add UTM Debug Log to `inviteeCanceled.ts`

**Type:** Backend
**Parallelizable:** Yes — independent of 3B. Touches only `convex/pipeline/inviteeCanceled.ts`.

**What:** Add a single structured log line to the `inviteeCanceled` process handler that reports whether the `tracking` object is present on the cancellation payload. Uses the `isRecord()` helper that already exists in the file (line 6–8).

**Why:** When a lead cancels a booking, Calendly sends the `invitee.canceled` event with the same tracking data as the original `invitee.created`. We don't re-extract or store UTMs here (they were already captured at creation time), but logging the tracking presence allows developers to verify Calendly's behavior and debug any future payload changes. Without this log, a cancellation event's tracking state is invisible.

**Where:**
- `convex/pipeline/inviteeCanceled.ts` (modify)

**How:**

**Step 1: Add the UTM tracking log after the processed check**

Locate the early-return guard for already-processed events (lines 24–28). Insert the tracking log between that guard and the `scheduledEvent` extraction (line 30):

```typescript
// Path: convex/pipeline/inviteeCanceled.ts
// BEFORE (lines 27–30):

      return;
    }

    const scheduledEvent =

// AFTER:

      return;
    }

    // Log tracking presence for debugging (UTMs already stored at creation time)
    const hasTracking = isRecord(payload) && isRecord(payload.tracking);
    console.log(
      `[Pipeline:invitee.canceled] UTM check | hasTracking=${hasTracking}`
    );

    const scheduledEvent =
```

**Key implementation notes:**
- Uses `isRecord(payload) && isRecord(payload.tracking)` — the `isRecord()` helper already exists in this file (lines 6–8). This is the established pattern in the codebase for safe object type checking; no inline typeof/null/Array checks needed.
- The log tag `[Pipeline:invitee.canceled]` matches the existing convention in this file (e.g., line 22: `[Pipeline:invitee.canceled] Entry | ...`).
- The log fires on every event that gets past the idempotency guard — before any meeting/opportunity logic.
- This is a read-only diagnostic — no database writes, no mutation to existing behavior.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCanceled.ts` | Modify | Add 4-line UTM tracking log after entry validation |

---

### 3B — Add UTM Debug Logs to `inviteeNoShow.ts`

**Type:** Backend
**Parallelizable:** Yes — independent of 3A. Touches only `convex/pipeline/inviteeNoShow.ts`.

**What:** Add structured UTM tracking-presence log lines to both the `process` handler (for `invitee_no_show.created`, line 29) and the `revert` handler (for `invitee_no_show.deleted`, line 107). Both handlers receive Calendly payloads that may contain the tracking object.

**Why:** The no-show handler has two exported mutations — `process` and `revert`. Both receive Calendly payloads that may include tracking data. Adding logs to both gives complete observability over the no-show lifecycle. This is especially valuable for debugging the future auto-reschedule detection (Feature Area B3 in v0.5), which will need to compare UTM data between the original no-show meeting and the new rebooking.

**Where:**
- `convex/pipeline/inviteeNoShow.ts` (modify)

**How:**

**Step 1: Add the UTM tracking log to the `process` handler**

Locate the early-return guard for already-processed events in the `process` handler (lines 38–42). Insert the tracking log between that guard and the `extractCalendlyEventUri` call (line 44):

```typescript
// Path: convex/pipeline/inviteeNoShow.ts
// BEFORE (lines 41–44) in the process handler:

      return;
    }

    const calendlyEventUri = extractCalendlyEventUri(payload);

// AFTER:

      return;
    }

    // Log tracking presence for debugging (UTMs already stored at creation time)
    const hasTracking = isRecord(payload) && isRecord(payload.tracking);
    console.log(
      `[Pipeline:no-show] UTM check | hasTracking=${hasTracking}`
    );

    const calendlyEventUri = extractCalendlyEventUri(payload);
```

**Step 2: Add the UTM tracking log to the `revert` handler**

Locate the early-return guard for already-processed events in the `revert` handler (lines 117–121). Insert the tracking log between that guard and the `extractCalendlyEventUri` call (line 123):

```typescript
// Path: convex/pipeline/inviteeNoShow.ts
// BEFORE (lines 120–123) in the revert handler:

      return;
    }

    const calendlyEventUri = extractCalendlyEventUri(payload);

// AFTER:

      return;
    }

    // Log tracking presence for debugging
    const hasTrackingRevert = isRecord(payload) && isRecord(payload.tracking);
    console.log(
      `[Pipeline:no-show] Revert UTM check | hasTracking=${hasTrackingRevert}`
    );

    const calendlyEventUri = extractCalendlyEventUri(payload);
```

**Key implementation notes:**
- Both handlers use the same `isRecord()` helper already defined in the file (lines 5–7) — no new imports or utilities needed.
- The variable in the `revert` handler is named `hasTrackingRevert` to avoid potential shadowing if both handlers are ever extracted into a shared function.
- The log tags follow the **existing convention** in this file: `[Pipeline:no-show]` for the process handler and `[Pipeline:no-show] Revert` for the revert handler — matching patterns like line 36 (`[Pipeline:no-show] Entry (process)`) and line 114 (`[Pipeline:no-show] Entry (revert)`).
- No data is written to meetings or opportunities. These are pure diagnostic logs.
- The `revert` handler processes `invitee_no_show.deleted` — when Calendly reverses a no-show marking. The tracking data on this event should match the original, and this log verifies that.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeNoShow.ts` | Modify | Add UTM tracking logs to both `process` (4 lines) and `revert` (4 lines) handlers |

---

### 3C — Deploy and Verify Logs

**Type:** Backend
**Parallelizable:** No — depends on 3A and 3B being complete.

**What:** Deploy the modified handlers to Convex (dev or production) and verify that the UTM tracking logs appear in the Convex dashboard when cancellation or no-show events are processed.

**Why:** Deployment activates the diagnostic logs. Verification ensures the log lines fire correctly and don't interfere with existing handler behavior (status transitions, opportunity patches, etc.).

**Where:**
- Convex dev/production environment
- Convex dashboard (log inspection)

**How:**

**Step 1: Run TypeScript compilation**

```bash
pnpm tsc --noEmit
```

Should pass without errors. The changes are purely additive — no type changes, no new imports.

**Step 2: Deploy to Convex**

```bash
# For development:
npx convex dev

# For production:
npx convex deploy
```

No schema changes in this phase — only function code is updated.

**Step 3: Verify logs appear on cancellation events**

1. Open the Convex dashboard → **Logs** section.
2. If a real cancellation event arrives (or trigger one via a test Calendly booking + cancel), filter logs for `[Pipeline:invitee.canceled] UTM check`.
3. Confirm the log line appears with `hasTracking=true` or `hasTracking=false` as appropriate.
4. Verify the existing cancellation behavior is unchanged: meeting status → `canceled`, opportunity status updated, cancellation metadata extracted.

**Step 4: Verify logs appear on no-show events**

1. If a real no-show event arrives (or trigger one via the Calendly dashboard — mark an attendee as no-show), filter logs for `[Pipeline:no-show] UTM check`.
2. Confirm the log line appears.
3. Verify existing no-show behavior: meeting status → `no_show`, opportunity status updated.

**Step 5: Verify logs appear on no-show revert events (if testable)**

1. If a no-show revert event arrives (or trigger one by removing the no-show mark in Calendly), filter logs for `[Pipeline:no-show] Revert UTM check`.
2. Confirm the log line appears.
3. Verify existing revert behavior: meeting status → `scheduled`, opportunity status → `scheduled`.

**Key implementation notes:**
- Cancellation and no-show events are less frequent than `invitee.created`, so log verification may require waiting for a real event or triggering a test scenario.
- The logs add zero latency to handler execution — a single `isRecord()` chain + `console.log()` is sub-millisecond.
- If logs don't appear, check: Were the functions deployed? Is `convex dev` running? Is the webhook subscription active for the test event type?

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Convex deployment environment | N/A | Functions deployed; no rollback needed |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/pipeline/inviteeCanceled.ts` | Modify | 3A |
| `convex/pipeline/inviteeNoShow.ts` | Modify | 3B |

