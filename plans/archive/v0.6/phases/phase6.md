# Phase 6 — QA & Polish

**Goal:** Cross-reference all KPIs against the Excel source data, verify aggregate integrity after live mutations, validate all edge cases, run performance and accessibility audits, and fix any issues found. After this phase, the reporting feature is production-ready.

**Prerequisite:** Phase 2 complete (aggregate hooks active), Phase 3 complete (all queries), Phase 5 complete (all report pages rendered). In other words: everything else is done.

**Runs in PARALLEL with:** Nothing — this is the final verification gate.

**Skills to invoke:**
- `convex-performance-audit` — verify query costs, subscription overhead, function execution times
- `web-design-guidelines` — WCAG compliance audit on all report pages

**Acceptance Criteria:**
1. Team Performance KPIs for January and February 2026 match the Excel workbook values (within 5% tolerance for edge-case timing differences).
2. All 9 Tier 1 KPIs (booked calls, cancellations, no-shows, calls showed, show-up rate, sales, cash collected, close rate, avg deal size) are verified against expected values.
3. Aggregate counts remain in sync after a live mutation (create a test meeting via Calendly → verify count increments in Team Performance report).
4. "End Meeting" button records `stoppedAt`, computes `overranDurationMs`, transitions meeting to `completed`.
5. Late start detection: `lateStartDurationMs` is computed at start. Late-start prompt shown when `> 0`.
6. Activity Feed displays domain events with correct actor attribution and human-readable labels for all ~20 event types.
7. Form Insights shows answer distribution for at least one Calendly form field.
8. Live bookings (post-Phase 2E) create `meetingFormResponses` rows that appear in Form Insights.
9. Empty date ranges show styled empty states, not errors.
10. Closers with zero data show "—" for rates, 0 for counts.
11. Auth gate: closers navigating to `/workspace/reports/*` are redirected.
12. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
6A (data validation — Excel cross-reference) ──────────────────────────┐
                                                                        │
6B (aggregate integrity — live mutation test) ──────────────────────────┤
                                                                        ├── 6D (fixes — address issues from 6A-6C)
6C (edge case verification) ────────────────────────────────────────────┤
                                                                        │
```

**Optimal execution:**
1. Start **6A**, **6B**, **6C** all in parallel (independent verification activities).
2. After all complete → **6D** (fix any issues found).

**Estimated time:** 1-2 days

---

## Subphases

### 6A — Data Validation: Excel Cross-Reference

**Type:** Manual
**Parallelizable:** Yes — independent of 6B and 6C.

**What:** Compare Team Performance and Revenue report outputs against the Excel workbook (`SALESTEAMREPORT2026-PTDOM.xlsx`) for January and February 2026 data.

**Why:** The Excel is the "source of truth" the admins currently use. Any discrepancy between the CRM report and the Excel will erode trust. This is the single most important validation step.

**Where:**
- Browser: `/workspace/reports/team` and `/workspace/reports/revenue`
- Reference: `SALESTEAMREPORT2026-PTDOM.xlsx`

**How:**

**Step 1: Set date range to January 2026**

Navigate to Team Performance report. Set date range to January 1 - January 31, 2026.

**Step 2: Compare per-closer values**

For each closer in the Excel's January sheet:

| KPI | Excel Column | CRM Field | Tolerance |
|---|---|---|---|
| Booked Calls (New) | "New Calls" table, "Booked" | `newCalls.bookedCalls` | Exact match |
| Canceled (New) | "New Calls" table, "Canceled" | `newCalls.canceledCalls` | Exact match |
| No Shows (New) | "New Calls" table, "No Show" | `newCalls.noShows` | Exact match |
| Showed (New) | "New Calls" table, "Showed" | `newCalls.callsShowed` | Exact match |
| Show-Up Rate (New) | "New Calls" table, "Show Rate" | `newCalls.showUpRate` | ±1% (rounding) |
| Booked Calls (FU) | "Follow Up" table, "Booked" | `followUpCalls.bookedCalls` | Exact match |
| Sales | "Sales" column | `sales` | Exact match |
| Cash Collected | "Cash" column | `cashCollectedMinor / 100` | ±$1 (rounding) |
| Close Rate | "Close Rate" column | `closeRate` | ±1% |

**Step 3: Repeat for February 2026**

Same comparison for February data.

**Step 4: Document discrepancies**

Any mismatch > tolerance must be investigated. Common causes:
- Meeting timezone boundary issues (scheduledAt is UTC; Excel may use local time)
- Classification differences (new vs follow-up determination)
- Payment inclusion criteria (disputed payments excluded from aggregate)

**Key implementation notes:**
- Focus on the 9 Tier 1 KPIs that are direct Excel replacements.
- Revenue comparison: ensure both CRM and Excel exclude disputed payments.
- The `callClassification` backfill logic determines which meetings are "new" vs "follow-up." If the classification disagrees with the Excel, investigate the classification logic in `backfillMeetingClassification`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| — | — | No file changes — manual verification |

---

### 6B — Aggregate Integrity: Live Mutation Test

**Type:** Manual
**Parallelizable:** Yes — independent of 6A and 6C.

**What:** Verify that aggregates stay in sync with the source tables after live mutations. Create a test booking, run through the meeting lifecycle, and confirm aggregate counts increment correctly at each step.

**Why:** If any of the 34 aggregate hooks were missed or implemented incorrectly, aggregates will drift from the source data. This is the "smoke test" for the entire aggregate integration.

**Where:**
- Calendly (trigger test booking)
- Convex dashboard (verify aggregate state)
- Browser: `/workspace/reports/team` (verify count changes)

**How:**

**Step 1: Record baseline**

Open Team Performance report for "This Month." Note the current total booked calls for a specific closer.

**Step 2: Trigger a test booking**

Create a Calendly test booking assigned to the tracked closer. Wait for the webhook to process.

**Step 3: Verify increment**

Refresh the Team Performance report. The closer's booked calls should have incremented by 1. Verify:
- The new meeting appears in the correct classification (new or follow_up)
- The correct status is counted (should be "scheduled")

**Step 4: Walk through meeting lifecycle**

1. **Start meeting** → verify `scheduled` count decreases, `in_progress` count increases
2. **Stop meeting** → verify `in_progress` count decreases, `completed` count increases
3. **Log payment** → verify revenue increases in Revenue report

**Step 5: Reconciliation spot-check**

Compare a few aggregate counts against direct Convex dashboard table scans:
- Count of meetings with `status === "completed"` in the dashboard
- Compare against `meetingsByStatus` aggregate count with `prefix: ["completed"]`

**Key implementation notes:**
- If counts don't match, the aggregate hook for that mutation is missing or broken. Check the Phase 2 touch point inventory.
- After fixes, re-run the backfill for the affected aggregate to resync. `insertIfDoesNotExist` is idempotent.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| — | — | No file changes — manual verification (potential fixes in Phase 2 files if hooks are missing) |

---

### 6C — Edge Case Verification

**Type:** Manual
**Parallelizable:** Yes — independent of 6A and 6B.

**What:** Systematically test all edge cases documented in the design (§14) across all 5 report pages.

**Why:** Edge cases like empty date ranges, closers with zero meetings, and auth expiry can produce confusing UX (NaN, blank pages, errors) if not handled properly.

**Where:**
- Browser: all 5 report pages

**How:**

**Step 1: Empty date range**

Set date range to a period with no data (e.g., January 2020). Verify:
- KPI cards show 0 values
- Tables show "No data for this period" or empty rows
- Charts show an empty state (not broken layout)
- No console errors

**Step 2: Closers with zero meetings**

If a closer was recently added and has no meetings: verify their row appears in the Team Performance table with all 0s. Show-up rate and close rate should show "—" (not "NaN" or "0%").

**Step 3: Single-day range**

Set range to a single day (e.g., start = end = "2026-03-15"). Verify:
- Queries handle inclusive start / exclusive end correctly
- Data for that day appears
- Trend chart shows a single point

**Step 4: Auth gate**

Log in as a closer. Navigate to `/workspace/reports/team` directly via URL. Verify:
- The page redirects (via `requireRole` in layout.tsx)
- The sidebar does not show "Reports" section

**Step 5: Auth expiry during viewing**

Open a report page. Wait for session to expire (or manually invalidate the token). Verify:
- The session expiry toast appears
- Report data freezes at last known state (doesn't error)

**Step 6: New tenant with no data**

If possible, test with a tenant that has no meetings, payments, or events. All reports should show graceful empty states.

**Step 7: `stopMeeting` idempotency**

Start a meeting, then click "End Meeting" twice quickly. Verify:
- First click succeeds (meeting → completed)
- Second click shows error toast ("Meeting already completed" or similar)
- No data corruption

**Step 8: Large date range (Activity Feed)**

Set Activity Feed date range to 1 year. Verify:
- Summary loads (may show `isTruncated: true` warning)
- Feed list loads with the specified limit
- No timeout errors

**Step 9: Form Insights empty state**

If tenant has no Calendly form fields, verify the Form Insights section shows: "No Calendly form fields have been captured yet."

**Key implementation notes:**
- Document each test result. Mark pass/fail.
- Any failures go to 6D for fixing.
- Console errors are failures — check browser dev tools during each test.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| — | — | No file changes — manual verification |

---

### 6D — Bug Fixes and Polish

**Type:** Full-Stack
**Parallelizable:** No — depends on findings from 6A-6C.

**What:** Fix any issues discovered during validation. Common categories: missing aggregate hooks, display formatting bugs, edge case handling, accessibility violations.

**Why:** This is the gap-closing step. Every issue from 6A-6C must be resolved before the feature ships.

**Where:**
- Varies based on findings. Likely candidates:
  - `convex/reporting/*.ts` (query fixes)
  - `app/workspace/reports/**/_components/*.tsx` (display fixes)
  - `convex/closer/meetingActions.ts` or `convex/pipeline/*.ts` (missing aggregate hooks)

**How:**

**Step 1: Triage findings**

Categorize issues from 6A-6C:
- **P0 (blockers):** Data inaccuracy, missing aggregate hooks, auth bypass
- **P1 (high):** Display bugs (NaN, broken layouts), console errors
- **P2 (medium):** Style inconsistencies, minor UX issues

**Step 2: Fix P0 issues first**

Each P0 fix should be verified by re-running the specific test case that found it.

**Step 3: Fix P1 and P2 issues**

Common fixes:
- Add division-by-zero guards (show "—" instead of NaN)
- Fix currency formatting (cents → dollars)
- Add empty state components for zero-data scenarios
- Fix chart color contrast for WCAG compliance
- Add `aria-label` attributes to interactive elements

**Step 4: Final verification**

Re-run `pnpm tsc --noEmit` to ensure no type errors were introduced.

**Key implementation notes:**
- This subphase has no predefined file list — it depends entirely on findings.
- If a missing aggregate hook is found, also check the touch point inventory (Design §5.2.2) for other missed hooks in the same file.
- If an edge case fix requires a query change, verify the change doesn't affect the happy-path data that was validated in 6A.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (varies) | Modify | Fixes based on 6A-6C findings |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| (varies — based on findings) | Modify | 6D |

> **Note:** Phase 6 is primarily a verification phase. The only file changes are in 6D (bug fixes), which depend on what 6A-6C discover. If validation passes cleanly, 6D may have zero file changes.
