# Late-Start Review Feature — Gap Report

**Date:** 2026-04-14
**Scope:** Full review of Phases 1–6 implementation vs. design spec and phase plans
**Verdict:** 3 real gaps found, 1 design deviation noted. Everything else is clean.

---

## Status: What Passed

Before listing gaps, here's what was verified clean:

| Check | Status |
|---|---|
| `pnpm tsc --noEmit` | ✅ No errors |
| `pending_review` fully renamed to `meeting_overran` | ✅ Zero stale references in .ts/.tsx |
| `closer_no_show` fully removed | ✅ Zero stale references |
| `overranDurationMs` renamed to `exceededScheduledDurationMs` | ✅ Zero stale references |
| WIP files removed (`lateStartReview.ts`, `late-start-reason-dialog.tsx`) | ✅ Gone |
| `evidence_uploaded`, `evidence_not_uploaded`, `lateStartCategory`, `minutesPastWindow` removed | ✅ All gone |
| Schema: `meetingReviews` table matches design spec | ✅ All fields, indexes correct |
| Schema: `meetings` table has `attendanceCheckId`, `overranDetectedAt`, `reviewId` | ✅ |
| Schema: `opportunities` and `meetings` status unions include `meeting_overran` | ✅ |
| Status transitions: `meeting_overran` in `VALID_TRANSITIONS` with correct outbound targets | ✅ |
| `ACTIVE_OPPORTUNITY_STATUSES` includes `meeting_overran` | ✅ |
| `PIPELINE_DISPLAY_ORDER` includes `meeting_overran` at correct position | ✅ |
| Attendance check scheduled in all 3 creation paths in `inviteeCreated.ts` | ✅ |
| Attendance check cancelled in `startMeeting`, `inviteeCanceled`, `inviteeNoShow`, `adminResolveMeeting` | ✅ |
| Webhook isolation guard with domain event in `inviteeCanceled` and `inviteeNoShow` | ✅ |
| `checkMeetingAttendance` idempotent guard (status !== "scheduled") | ✅ |
| `respondToOverranReview` validates ownership, double-response, required fields | ✅ |
| `scheduleFollowUpFromOverran` validates transition, creates followUp, updates stats | ✅ |
| `followUps` insert matches schema required fields | ✅ |
| `createPaymentRecord` call matches function signature | ✅ |
| `createManualReminder` call matches function signature | ✅ |
| `emitDomainEvent` calls use valid field types | ✅ |
| `updateOpportunityMeetingRefs` correctly handles `meeting_overran` | ✅ |
| `listPendingReviews` query with enrichment | ✅ |
| `getReviewDetail` query with resolver name | ✅ |
| `getPendingReviewCount` with bounded `.take(100)` | ✅ |
| Frontend: Status config entries (`opportunityStatusConfig`, `meetingStatusConfig`) | ✅ |
| Frontend: Closer dashboard includes `meeting_overran` in pipeline counts | ✅ |
| Frontend: Reviews nav item admin-only (sidebar + server-side auth) | ✅ |
| Frontend: Sidebar badge with reactive pending count | ✅ |
| Frontend: Review list page with tabs + skeleton + empty state | ✅ |
| Frontend: Review detail with SSR preloading pattern | ✅ |
| Frontend: Resolution bar handles opportunity drift (highlights Acknowledge) | ✅ |
| Frontend: Context dialog form validation + reset on close | ✅ |
| Frontend: Resolution dialog dynamic schema per action + reset on close | ✅ |
| Frontend: `OutcomeActionBar` returns null for `meeting_overran` | ✅ |
| Frontend: `MeetingOverranBanner` with context dialog + follow-up form | ✅ |
| Domain events emitted at all state transitions | ✅ |
| Reporting aggregates called on all status changes | ✅ |
| RHF + Zod with `standardSchemaResolver` (not `zodResolver`) | ✅ |

---

## GAP 1 — Payment/Reminder Side Effects Gated by Opportunity Status (Plan Deviation)

**Severity:** Medium-High
**Files:** `convex/reviews/mutations.ts` (lines 186–207)

### What happened

In the `resolveReview` mutation, `createPaymentRecord` and `createManualReminder` are inside `if (opportunityCanTransition)`:

```typescript
// Implementation (lines 186-207):
if (opportunityCanTransition) {          // ← THIS GATE
  if (args.resolutionAction === "log_payment" && args.paymentData) {
    await createPaymentRecord(ctx, { ... });
  } else if (args.resolutionAction === "schedule_follow_up") {
    await createManualReminder(ctx, { ... });
  }
}
```

The plan (phase4.md lines 468–494) has these side effects **outside** the opportunity gate:

```typescript
// Plan (phase4.md lines 468-494):
// ── Outcome side effects (same transaction) ──────────────────────
if (args.resolutionAction === "log_payment" && args.paymentData) {
  await createPaymentRecord(ctx, { ... });         // ← NOT GATED
} else if (args.resolutionAction === "schedule_follow_up") {
  await createManualReminder(ctx, { ... });        // ← NOT GATED
}
```

### The problem scenario

1. System flags meeting as `meeting_overran`
2. Closer schedules a follow-up → opportunity moves to `follow_up_scheduled`
3. Admin reviews and resolves with "Log Payment" (the closer actually made a sale)
4. `opportunityCanTransition` is `false` (opportunity is `follow_up_scheduled`, not `meeting_overran`)
5. **Result:** Review is marked `resolved` with `resolutionAction: "log_payment"`, but no payment record exists in the system. No customer conversion runs. No revenue tracking. The `wonDeals` counter is not incremented (since `createPaymentRecord` handles that internally).

The review says a payment was logged. The payments table disagrees. This is a data consistency gap.

### Same issue for `schedule_follow_up`

If the admin resolves with "Schedule Follow-Up" but the opportunity has drifted, no `followUps` record or manual reminder is created. The review says a follow-up was scheduled but none exists.

### Why this matters

The frontend `ReviewResolutionBar` explicitly allows all 5 resolution actions even when the opportunity has drifted. It shows explanatory text and highlights "Acknowledge," but the admin CAN choose "Log Payment." When they do, they expect the payment to be recorded.

### Fix direction

Move `createPaymentRecord` and `createManualReminder` calls outside the `if (opportunityCanTransition)` block, matching the plan. The tenant stats delta for `activeOpportunities` should remain gated (as the plan intended), but payment/reminder creation should not be.

---

## GAP 2 — No Meeting Status Transition Validation Map

**Severity:** Low-Medium (pre-existing architectural gap, surfaced by this feature)
**Files:** `convex/lib/statusTransitions.ts`, `convex/reviews/mutations.ts` (line 178)

### What happened

The codebase has a formal `VALID_TRANSITIONS` map for **opportunity** statuses, and `resolveReview` validates opportunity transitions via `validateTransition()` (line 154). But there is **no equivalent map for meeting statuses**.

The false-positive correction (`meeting_overran` → `completed`) in `resolveReview` is a raw patch with only a status guard:

```typescript
if (isFalsePositiveCorrection && meeting.status === "meeting_overran") {
  await ctx.db.patch(review.meetingId, {
    status: "completed",
    completedAt: now,
  });
}
```

### Why this matters

This is not a bug today — the guard is correct and the transition is valid. But:
- It's the first instance of a meeting status being "corrected" after initial assignment
- Any future meeting status patches bypass validation entirely
- Opportunity transitions have defense-in-depth (type system + transition map + runtime validation); meeting transitions only have the type system

### Fix direction

Add a `MEETING_VALID_TRANSITIONS` map to `statusTransitions.ts` and a `validateMeetingTransition()` helper. This is a small addition but formalizes what's currently implicit. Not urgent — the current code is correct — but it closes a future risk.

---

## GAP 3 — Dead-End UI When meetingReview is Null for meeting_overran

**Severity:** Low (unlikely scenario, but high impact if it occurs)
**Files:** `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` (lines 204–213), `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` (line 155)

### What happened

The `MeetingOverranBanner` is only rendered when `meetingReview` is truthy:

```tsx
{(opportunity.status === "meeting_overran" ||
  meeting.status === "meeting_overran") &&
  meetingReview && (           // ← REQUIRES NON-NULL
    <MeetingOverranBanner ... />
  )}
```

The `OutcomeActionBar` returns null for `meeting_overran`:

```tsx
if (opportunity.status === "meeting_overran") return null;
```

### The problem scenario

If `meeting.status === "meeting_overran"` but `meetingReview` is null (e.g., the `reviewId` was never set on the meeting due to a bug, or the review document was deleted), the closer sees:
- A "Meeting Overran" status badge at the top
- **No banner** (meetingReview is null)
- **No "Provide Context" button** (lives in the banner)
- **No "Schedule Follow-Up" button** (lives in the banner)
- **No outcome action bar** (returns null for meeting_overran)
- **Dead-end page** — the closer can't do anything

### When could this happen?

- Normal flow: shouldn't happen. `checkMeetingAttendance` always creates the review and patches `reviewId` atomically.
- Edge case: manual database intervention, data corruption, or a future bug in the detection flow.

### Fix direction

Add a minimal fallback in the meeting detail page: when `meeting.status === "meeting_overran"` but `meetingReview` is null, show a simple informational banner ("This meeting was flagged — contact your supervisor") instead of nothing. Alternatively, make `OutcomeActionBar` not return null when review data is missing.

---

## DESIGN DEVIATION — "Start Meeting → Context Dialog" vs. Banner Button

**Severity:** Informational (not a bug, likely intentional evolution)
**Files:** Design spec Section 3 vs. `outcome-action-bar.tsx`, `meeting-overran-banner.tsx`

### What the design says

Design spec, Section 3, line 117–118:
> `C->>C: Presses "Start Meeting" → Context Dialog opens`

### What was implemented

- The `OutcomeActionBar` (which contains the "Start Meeting" button) returns `null` for `meeting_overran` status
- Instead, the `MeetingOverranBanner` provides a "Provide Context" button that opens the `MeetingOverranContextDialog`
- The closer accesses the context dialog through the banner, not through "Start Meeting"

### Impact

The user experience is equivalent — the closer sees the overran state and can provide context. The entry point is different (banner button vs. repurposed Start button), but the outcome is the same. This is likely a deliberate design evolution during Phase 5 implementation, since showing a "Start Meeting" button for a meeting that has already been flagged could be confusing.

**No fix needed** — just documenting the deviation for traceability.

---

## MINOR OBSERVATION — Duplicated Helper

**Severity:** Cosmetic (not a functional gap)
**Files:** `convex/closer/meetingOverrun.ts`, `convex/reviews/mutations.ts`

The `getActiveOpportunityDelta(fromStatus, toStatus)` function is duplicated in both files with identical logic. Consider extracting to `convex/lib/tenantStatsHelper.ts` alongside `isActiveOpportunityStatus`. Not urgent.

---

## PLAN CORRECTION — wonDeals Double-Count Avoided

**Not a gap — noting for completeness.**

The plan (phase4.md line 508) includes `wonDeals: 1` in the `resolveReview` tenant stats block. But `createPaymentRecord` also internally calls `updateTenantStats({ wonDeals: 1 })`. The implementation correctly omitted `wonDeals` from `resolveReview`'s stats update to avoid double-counting. The plan had a latent bug; the implementation fixed it.
