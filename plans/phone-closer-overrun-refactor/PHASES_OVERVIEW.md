# Phone Closer Overrun Refactor - Phase Overview

**Design Reference:** `plans/phone-closer-overrun-refactor/phone-closer-overrun-refactor-design.md`
**Status:** Phase plans created for implementation.

---

## Purpose

This rollout removes the closer Start/End meeting lifecycle, overrun detection, `meetingReviews`, `meeting_overran`, `in_progress`, and actual-duration tracking. The sequence is intentionally conservative: first change the outcome contract, then stop new legacy writes, then remove UI/reporting dependencies, then clean production data, and only then narrow the schema.

---

## Phase Breakdown

### Phase 1 - Outcome Contract and Status Machine

**File:** `phases/phase1.md`

Defines `scheduled` as the valid source state for direct meeting outcomes and adds the backend eligibility contract. It keeps schema and validators wide so production data remains deployable.

**Deploy:** Yes, backend contract deploy.
**Backfill/migration:** No.

### Phase 2 - Backend: Stop Producing Legacy Lifecycle Data

**File:** `phases/phase2.md`

Removes attendance-check scheduling, disables the stale sweep, keeps a temporary scheduler no-op shim, and updates payment/follow-up/no-show/lost mutations to resolve scheduled meetings directly.

**Deploy:** Yes, behavior deploy.
**Backfill/migration:** No, but inspect `_scheduled_functions`.

### Phase 3 - Frontend: Join Link and Direct Outcomes

**File:** `phases/phase3.md`

Replaces Start/End UI with a passive Join link and direct scheduled outcome actions for closers/admins. Deletes the operational review inbox route and old lifecycle guard/banner components.

**Deploy:** Yes, UI deploy after Phase 2.
**Backfill/migration:** No.

### Phase 4 - Reporting Simplification

**File:** `phases/phase4.md`

Deletes review and meeting-time report surfaces, standardizes show rate to `completed / (booked - canceled)`, removes legacy buckets from charts/filters, and documents manual PostHog funnel changes.

**Deploy:** Yes, reporting deploy before cleanup.
**Backfill/migration:** No direct migration; aggregate repair is Phase 5.

### Phase 5 - Data Cleanup

**File:** `phases/phase5.md`

Runs temporary Convex migrations and audits to cancel queued attendance checks, strip legacy fields, repair legacy statuses using evidence precedence, delete `meetingReviews`, and refresh projections/aggregates.

**Deploy:** Yes, temporary migration/audit code.
**Backfill/migration:** Yes, manual production migrations with dry runs and hard verification.

### Phase 6 - Schema Narrow

**File:** `phases/phase6.md`

After Phase 5 returns all zeros, removes legacy schema literals, timing fields, `meetingReviews`, temporary migrations/audits, the no-op shim, and all remaining generated-type references.

**Deploy:** Yes, final schema narrow deploy.
**Backfill/migration:** No new migration; return to Phase 5 if schema validation fails.

---

## Recommended Execution Order

```
Phase 1 -> Phase 2 -> Phase 3
                    \-> Phase 4

Phase 3 + Phase 4 complete -> Phase 5 -> Phase 6
```

Phase 5 and Phase 6 are the critical safety gates. Do not start Phase 5 until the deployed app has stopped producing legacy state. Do not start Phase 6 until production audits show zero legacy source/projection rows, zero `meetingReviews`, no pending attendance-check jobs, and clean aggregate comparisons.

