# Window 5 Implementation Gaps — `payment-programs-and-types`

> **Scope:** Post-implementation findings surfaced while executing Parallelization
> Window 5 (Phases 6B–6E, 7A–7E, 8A–8G, 9B–9F). This document is a triage / decision
> artifact — each gap lists root cause, impact, remediation options, and a recommended
> action so product + engineering can decide together.
>
> **Source material:** `payment-programs-and-types-design.md`, `phases/phase6.md`–`phase9.md`,
> `phases/parallelization-strategy.md`, agent reports from Window 5 execution.
>
> **Verification baseline:** `pnpm tsc --noEmit` → exit 0. `pnpm lint` → 8 errors + 51 warnings,
> 100% pre-existing (none introduced by Phase 6–9). All phase-specific grep checks clean
> (`customer_flow`, `ORIGIN_META.unknown`, `programType`, `payment.closerId`, `stats.totalRevenue`,
> `deal.closerName`, `Closed by`, `PROVIDERS`, `name="provider"`, `Fathom Link`).

---

## 1. Executive Summary

| # | Gap | Severity | Effort | Category |
|---|---|---|---|---|
| 1 | `recordCustomerPayment` missing `paidAt` + `note` | **Major** | S | Backend contract |
| 2 | Admin cannot close stuck reminders (lost / no-response) | Minor | S–M | Design tension |
| 3 | `team-report-types.ts` auto-derives (doc is stale) | Cosmetic | S | Doc drift |
| 4 | `StatsCard` variant palette mismatch | Minor | S | Design-system |
| 5 | `Badge` has no `muted` variant | Minor | S | Design-system |
| 6 | PostHog event name: `program_saved` vs `program_upserted` | Minor | S | Analytics contract |
| 7 | Currency dropdown uses raw ISO codes | Minor | S | UX / a11y |
| 8 | "Cash Collected" → "Team Commissionable Revenue" — historical data comparison risk | **Major** | M | User communication |
| 9 | "All archived" empty state collapsed into single branch | Minor | S | Edge case |
| 10 | Archive-error toast loses server remediation text | Minor | S | UX polish |
| 11 | 4-series trend chart — legibility / a11y risk | Minor | M | Data-viz |
| 12 | Activity feed auto-clears program/paymentType filter on scope change | Minor | 0–S | UX preference |
| 13 | `reference` (form key) vs `referenceCode` (backend arg) naming drift | Cosmetic | S | Consistency |
| 14 | `admin_meeting` / `admin_reminder` origin labels may imply admin closed the deal | Minor | S | Copy / UX |

**Totals:** 2 Major · 9 Minor · 2 Cosmetic · 1 Design-tension (needs product call).

**Top recommended ship-blockers:** Gap 1 (paidAt/note) and Gap 8 (historical comparison communication).
Everything else is shippable with a follow-up polish pass.

---

## 2. Severity Legend

- **Major** — lost capability vs. design intent, or a user-visible correctness/comprehension risk. Should be resolved before production rollout.
- **Minor** — UX or code-quality issue that does not block functionality. Can land in a follow-up PR.
- **Cosmetic** — documentation or naming drift; no user impact.
- **Effort** — S ≤ 30 min, M ≤ 2 hr, L > 2 hr.

---

## 3. Gaps — Complete Analysis

### Gap 1 — `recordCustomerPayment` signature missing `paidAt` and `note`

**Severity:** Major · **Effort:** S · **Category:** Backend contract

**Files involved**
- `convex/customers/mutations.ts` — mutation definition (narrower than design expected)
- `app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx` — dialog trimmed to match
- `plans/payment-programs-and-types/phases/phase8.md` — design said `paidAt` + `note` present

**Current behavior**
- Admin logs a post-conversion payment. Form collects `{ programId, paymentType, amount, currency, reference? }`.
- Backend stamps `recordedAt = Date.now()` — the payment is always "now" from the admin's perspective.
- No free-form note can accompany the payment.

**Design vs. reality delta**
The commissionable dialogs (`logPayment`, `logReminderPayment`) both accept `paidAt` + `note`. The non-commissionable dialog (`recordCustomerPayment`) does not. This asymmetry was not called out in the design doc; Phase 2 implementation of the mutation likely predates the Phase 8 UI spec.

**Impact**

1. **Back-dating is impossible.** A payment received last Tuesday but only logged today will show today's date in revenue reports. Reports over "Last Week" will miss it. Prior-period / current-period deltas will be wrong if admins batch-enter historical payments.
2. **No audit context.** Admins cannot record *why* a post-conversion payment exists (e.g., "re-enrollment after 6-month gap", "refund → re-charge", "partial chargeback resolved"). This loses forensic value for tenant_master audits.
3. **Symmetry break with commissionable flow.** Training materials and UX patterns for closers (who see `paidAt` + `note` fields) will not transfer cleanly to admin workflows.

**Remediation options**

| Option | Pros | Cons |
|---|---|---|
| **A. Extend backend** — Add `paidAt: v.number()` (required, default = Date.now() client-side) and `note: v.optional(v.string())` to `recordCustomerPayment` args. Re-add fields to dialog. | Restores design intent. Parity with commissionable flow. Low effort. | Minor schema contract churn. |
| B. Update design doc — Drop the two fields from phase8.md. Accept the loss of fidelity. | Zero code churn. | Leaves a real capability gap user-visible. |

**Recommended action:** Option A. Ship as a Phase 10 patch. Changes:
- `convex/customers/mutations.ts` — add validators + spread onto insert.
- `record-payment-dialog.tsx` — re-introduce `paidAt` (Calendar picker) + `note` (Textarea).
- Zod schema: `paidAt: z.string().min(1, "Date required")`, `note: z.string().trim().max(500).optional()`.

---

### Gap 2 — Admin reminder action bar only exposes "Log Payment"

**Severity:** Minor · **Effort:** S (copy-only) or M (full parity) · **Category:** Design tension (product decision required)

**Files involved**
- `app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-outcome-action-bar.tsx`
- `convex/closer/reminderOutcomes.ts` — `markReminderLost`, `markReminderNoResponse` remain closer-scoped per design §7.3.

**Current behavior**
- Admin viewing a closer's reminder sees only **Log Payment**. Other outcomes (mark lost, mark no-response, reschedule) are closer-only.
- A footer note explains: "Marking lost / no-response remains with the assigned closer."

**Design vs. reality delta**
This is by design (§7.3: "admin can intervene on payment, closer owns closure"). However, Window 5's prompt loosely suggested "same outcomes as the closer's bar (log payment, mark won, mark lost, reschedule)" — Agent 2 correctly resolved the conflict in favor of the design spec.

**Impact**

1. **Admin workflow bottleneck.** If a closer is OOO and has a dead reminder (customer emailed directly saying "not interested"), the admin cannot close it. The reminder stays in the follow-up queue, possibly triggering SLA alerts.
2. **Role ambiguity.** Tenant_master users may reasonably expect full override powers — the current UX implies they have less authority than a closer on this one axis.
3. **Scales linearly with team size.** Not a big deal at 3 closers; becomes a real coordination tax at 20+.

**Remediation options**

| Option | Pros | Cons |
|---|---|---|
| **A. Accept as designed** — tighten footer copy to explain *why* ("Reminder closure is the closer's decision so commission attribution stays with the person who owns the relationship"). | Zero backend work. Preserves clear separation of duties. | Bottleneck remains. |
| B. Extend `markReminderLost` / `markReminderNoResponse` to admin callers with an `overriddenByAdminUserId` audit field. Requires schema addition + mutation role widening + UI gating. | Full admin override capability. | Muddies attribution semantics. Schema change. |
| C. Add an admin-only "Force Close (Audit)" action — creates a `followUps.forceCosedByAdmin = userId` entry and emits a `reminder_force_closed` audit event. Does NOT log a lost/no-response outcome (those remain closer-owned), just removes from queue. | Escape hatch without muddying outcome semantics. | Extra data model concept. |

**Recommended action:** Product call. Default to Option A for Window 5 ship, revisit if customer feedback surfaces the bottleneck.

---

### Gap 3 — `team-report-types.ts` needed no manual change

**Severity:** Cosmetic · **Effort:** S · **Category:** Doc drift (positive finding)

**Files involved**
- `app/workspace/reports/team/_components/team-report-types.ts`
- `plans/payment-programs-and-types/phases/phase9.md` §9D steps 14, 26, 88

**Current behavior**
```ts
export type TeamTotals = TeamPerformanceMetrics["teamTotals"];
```
`TeamPerformanceMetrics` is `FunctionReturnType<typeof api.reporting.teamPerformance.getTeamPerformanceMetrics>`. Phase 5 added `postConversionRevenueMinor` to that return shape; TypeScript propagated the field automatically. No manual interface extension was needed.

**Design vs. reality delta**
phase9.md instructed: "Extend `TeamTotals` interface with `postConversionRevenueMinor: number`." This step was a no-op — the type already derives from the Convex function signature.

**Impact**

- **Positive:** Avoided type-duplication drift risk. This is the correct long-term pattern for Convex-backed UIs.
- **Negative:** Future authors reading phase9.md may waste time looking for an interface they cannot find.

**Remediation options**

| Option | Pros | Cons |
|---|---|---|
| **A. Update phase9.md** — annotate step 14 with "No manual change required; `TeamTotals` auto-derives from `FunctionReturnType`. This step is informational only." | Prevents future confusion. | Doc edit only. |
| B. Leave as-is. | Zero work. | Future-author speed-bump. |

**Recommended action:** Option A during next plan-doc pass.

---

### Gap 4 — `StatsCard` variant palette mismatch

**Severity:** Minor · **Effort:** S · **Category:** Design-system

**Files involved**
- `components/_components/stats-card.tsx` — ships `default | success | warning | destructive`
- `app/workspace/reports/revenue/_components/revenue-kpi-cards.tsx` — consumes
- `app/workspace/_components/stats-row.tsx` — consumes
- `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx` — consumes

**Current behavior**
Agents mapped the design doc's semantic `primary | secondary | muted` onto the shipped palette:
- Primary commissionable-final → `variant="success"` (green accent)
- Commissionable deposits / non-commissionable / prior-period → `variant="default"`

**Impact**

1. **Visual hierarchy askew.** `success` reads as "goal met / positive outcome" — overweights the commissionable-final card vs. other three in the 4-card cluster.
2. **Post-Conversion cards look the same as Commissionable-Deposit cards.** Both fall back to `default`. The semantic separation the design intended is not visually communicated.
3. **Class-override churn.** Where agents needed lower-emphasis treatment, they layered `bg-muted`/`text-muted-foreground` on top of `default` — fragile and hard to grep for.

**Remediation options**

| Option | Pros | Cons |
|---|---|---|
| **A. Extend `StatsCard`** — add `muted` (low-contrast bg, for informational cards) and `primary` (accent border/ring, for headline metrics). Swap consumers: commissionable-final → `primary`, post-conversion → `muted`, deposits → `default`. | Matches design vocabulary. Reusable going forward. | ~20 min component work + consumer updates. |
| B. Accept `success` as stand-in for `primary`. | Zero work. | Mixed semantics persist. |

**Recommended action:** Option A in a follow-up design-system polish pass.

---

### Gap 5 — `Badge` has no `muted` variant

**Severity:** Minor · **Effort:** S · **Category:** Design-system

**Files involved**
- `components/ui/badge.tsx` — ships `default | secondary | destructive | outline`
- `app/workspace/reports/activity/_components/activity-event-row.tsx`
- `app/workspace/customers/[customerId]/_components/payment-history-table.tsx`
- `app/workspace/closer/meetings/_components/deal-won-card.tsx` (and others)

**Current behavior**
For "Post-Conversion" badges, multiple agents applied `variant="outline"` with `bg-muted text-muted-foreground` class overrides:
```tsx
<Badge variant="outline" className="bg-muted text-muted-foreground">
  Post-Conversion
</Badge>
```

**Impact**

1. **Maintenance fragility.** If the design system changes the muted token, overrides won't track — only the `variant` prop resolves through `cva`.
2. **Grep-ability suffers.** `grep Badge` returns mixed-variant results; finding "all muted badges" requires grep on the class string.
3. **Inconsistency risk.** Three agents touched badge-rendering code; they may have applied slightly different class combinations.

**Remediation options**

| Option | Pros | Cons |
|---|---|---|
| **A. Add `muted` variant to Badge.** Grep existing `bg-muted text-muted-foreground` on `<Badge>` calls and replace. | Clean, canonical. Reusable. | ~20 min. |
| B. Standardize on `variant="secondary"` (closest existing variant in intent) and strip overrides. | Zero new variants. | `secondary` may carry other connotations elsewhere. |

**Recommended action:** Option A.

---

### Gap 6 — PostHog event: `program_saved` vs `program_upserted`

**Severity:** Minor · **Effort:** S · **Category:** Analytics contract

**Files involved**
- `app/workspace/settings/_components/program-form-dialog.tsx` — emits `program_upserted`
- `plans/payment-programs-and-types/payment-programs-and-types-design.md` — specifies `program_saved`

**Current behavior**
On successful `upsertProgram` mutation, the dialog fires:
```ts
posthog.capture("program_upserted", { action: "created" | "updated", programId });
```
The design doc specified `program_saved`. The Window 5 parallelization prompt said `program_upserted` (drift between prompt and plan).

**Impact**

1. **PostHog dashboards watching `program_saved`** (if any were pre-wired) will show zero events.
2. **Funnel analyses** like "program created → first commissionable payment" may break if the funnel spec uses `program_saved`.
3. **Cross-phase naming convention.** `*_saved` is more consistent with other events in the codebase (grep `posthog.capture` in `app/` confirms `settings_saved`, `user_invited`, etc. follow a `noun_verbed` past-tense pattern).

**Remediation options**

| Option | Pros | Cons |
|---|---|---|
| **A. Rename to `program_saved`** in `program-form-dialog.tsx`. Update design doc to reflect decision. | Matches convention. Matches design doc. | Single-line code change. |
| B. Keep `program_upserted` and update design doc + PostHog dashboards. | Accurately describes the technical operation. | Inconsistent with other events. |

**Recommended action:** Option A.

---

### Gap 7 — Currency dropdown uses raw ISO codes

**Severity:** Minor · **Effort:** S · **Category:** UX / accessibility

**Files involved**
- `app/workspace/settings/_components/program-form-dialog.tsx` — `CURRENCY_OPTIONS`
- `plans/payment-programs-and-types/phases/phase6.md` — design called for "USD — US Dollar" format

**Current behavior**
```tsx
const CURRENCY_OPTIONS = [
  { value: "USD", label: "USD" },
  { value: "EUR", label: "EUR" },
  { value: "GBP", label: "GBP" },
  { value: "CAD", label: "CAD" },
  { value: "AUD", label: "AUD" },
];
```

**Impact**

1. **Ambiguity for non-English locales.** "CAD" vs "AUD" is not obvious to all users.
2. **Screen-reader UX.** NVDA / VoiceOver read "C A D" letter-by-letter. "CAD — Canadian Dollar" reads as one semantic unit and confirms the code meaning.
3. **Tenant is scaling internationally.** Once non-US tenants onboard, ambiguity compounds.

**Remediation options**

| Option | Pros | Cons |
|---|---|---|
| **A. Use human-readable labels** — `{ value: "USD", label: "USD — US Dollar" }`, etc. Value stays raw. | Clearer, a11y-friendly. | Slightly longer dropdown width. |
| B. Keep raw codes. | No change. | Ambiguity for non-US / screen-reader users. |

**Recommended action:** Option A.

---

### Gap 8 — "Cash Collected" → "Team Commissionable Revenue" semantic shift

**Severity:** Major · **Effort:** M · **Category:** User communication / change management

**Files involved**
- `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx` — renamed card
- `convex/reporting/teamPerformance.ts` — `totalRevenueMinor` semantic changed to "commissionable-final only"

**Current behavior**
The card formerly titled **"Cash Collected"** is now **"Team Commissionable Revenue"**. The underlying `totalRevenueMinor` value on `teamTotals` changed meaning: previously = ALL cash collected by the team in the period; now = commissionable-final only (excludes commissionable-deposit, excludes both post-conversion slices).

**Design vs. reality delta**
This is intentional per design + Phase 5. But the rename + semantic shift is a breaking change for users who anchor on this number.

**Impact**

1. **Historical comparison risk.** A tenant_master glances at their weekly report, sees "Team Commissionable Revenue = $X" which is *smaller* than last month's "Cash Collected = $Y" (same data), and may conclude the team regressed. They did not — the denominator shrank.
2. **Dashboard bookmarks / saved views** (if any) still read the old field name mentally. Team meetings may quote stale comparisons.
3. **Commission reconciliation.** Payroll / commission payout workflows that read reports off-CRM (e.g., finance team exports) will change numbers. Without explicit communication, finance may question whether CRM is broken.
4. **Tenant trust.** Unannounced metric semantic shifts erode trust in reporting.

**Remediation options**

| Option | Pros | Cons |
|---|---|---|
| **A. In-app "What's new" notice.** On first load of Team Performance report post-deploy, show a one-time `<Alert>` explaining the four-way split + what moved where. Include a "Learn more" link to a help doc. Gate via `localStorage` flag. | Proactive. Low friction. | Requires a help doc + small state plumbing. |
| B. Changelog-only. Email tenant admins with the shift explanation. No in-app surface. | Lighter effort. | Most admins won't read the email. |
| C. Keep the card titled "Cash Collected" and add a subtext "(commissionable-final only)". Adds a second card "Post-Conversion Revenue" separately. | Preserves familiar naming. | Confusing if admins expect "cash collected" to mean all cash. |
| D. Accept the rename without proactive comms. | Zero work. | Highest tenant-trust risk. |

**Recommended action:** Option A. The rename is correct; the issue is communication. Spend 2 hours on a one-time in-app banner + 1 paragraph help doc. This is the cheapest insurance against tenant confusion.

---

### Gap 9 — "All archived" empty state collapsed into single branch

**Severity:** Minor · **Effort:** S · **Category:** Edge case

**Files involved**
- `app/workspace/settings/_components/programs-tab.tsx`
- `plans/payment-programs-and-types/phases/phase6.md` — called out two distinct empty states

**Current behavior**
When `programs.length === 0`, shows the "No programs yet" empty state with a Create CTA. When all programs are archived (active = 0, archived > 0) and `showArchived = false`, the user sees an empty main area with only the "Show archived" switch visible in the header.

**Impact**

1. **Near-unreachable via UI.** `archiveProgram` mutation rejects archiving the last active program. Reachable only via Convex CLI / data edits / migration bugs.
2. **But reachable in support scenarios.** A support engineer restoring a tenant's data from a broken migration could land here. The blank-list UX provides no remediation path (no "All programs are archived — toggle the switch or create a new one" affordance).

**Remediation options**

| Option | Pros | Cons |
|---|---|---|
| **A. Add conditional branch.** When `activePrograms.length === 0 && archivedPrograms.length > 0`, render a distinct empty state: icon + heading "All programs are archived" + "Restore one below or create a new program." Auto-enable `showArchived` in this branch so restore CTAs are visible. | Covers the edge case cleanly. | ~15 min work. |
| B. Accept as unsupported UI path (CLI only). | Zero work. | Support engineers land here blind. |

**Recommended action:** Option A.

---

### Gap 10 — Archive-error toast loses server remediation text

**Severity:** Minor · **Effort:** S · **Category:** UX polish

**Files involved**
- `app/workspace/settings/_components/program-row.tsx`
- `convex/tenantPrograms/mutations.ts` — `archiveProgram` throws verbose Error

**Current behavior**
Backend throws: `"At least one active program is required — create another active program before archiving this one."`
UI toast shows: `"Cannot archive — at least one active program must remain."`

The server-provided remediation hint ("create another active program before archiving this one") is dropped.

**Impact**

1. **User gets less actionable feedback.** "must remain" doesn't tell them *how* to proceed.
2. **Server/UI copy drift.** If the server message updates, the toast won't track.

**Remediation options**

| Option | Pros | Cons |
|---|---|---|
| **A. Show `error.message` directly** when the caught error is an `Error` instance thrown by this mutation. Fall back to the generic toast for unknown errors. | Surface server's contextual guidance. Auto-tracks future copy changes. | None meaningful. |
| B. Update toast copy to include the hint inline. | Also works. | Manual sync required. |

**Recommended action:** Option A.

---

### Gap 11 — 4-series trend chart dark-mode legibility

**Severity:** Minor · **Effort:** M · **Category:** Data-visualization / accessibility

**Files involved**
- `app/workspace/reports/revenue/_components/revenue-trend-chart.tsx`

**Current behavior**
Line chart with four series: commissionable-final (solid, `--chart-1`), commissionable-deposit (solid, `--chart-2`), post-conversion-final (dashed, `--chart-3`), post-conversion-deposit (dashed, `--chart-4`). Dash pattern doubles as the "slice type" channel; color as the "final vs. deposit" channel.

**Impact**

1. **Overlapping data points crowd the chart.** When all four series have non-zero values at the same bucket, colored dashes stack densely. Hover tooltips mitigate but don't solve for at-a-glance reading.
2. **Color-blind accessibility.** `--chart-1` through `--chart-4` use the shadcn default palette, which is chart-coordinated but not explicitly deuteranopia-safe at all widths.
3. **Mobile compression.** At phone widths the legend may wrap; lines get even denser.
4. **Dark-mode contrast.** Dashed strokes on `--chart-3`/`--chart-4` in dark mode are noticeably thinner visually than solid strokes on `--chart-1`/`--chart-2` — eye has to work harder.

**Remediation options**

| Option | Pros | Cons |
|---|---|---|
| **A. Offer "Stacked area" as an alternate view.** Adds a toggle in the chart header. Stacked areas communicate "total = commissionable + non-commissionable" visually and don't overlap. | Solves density. Natural for cumulative interpretation. | Doesn't show individual trends — user trades insight. |
| B. Add distinct marker shapes (circle / square / triangle / diamond) on each data point. Redundant color channel for color-blind users. | Cheap, incremental. | Crowds the chart further at dense data points. |
| C. Shift to 2 charts (Commissionable + Non-Commissionable) side-by-side, each with final-vs-deposit. | 2 series per chart is easy to read. | More vertical space. |
| D. Accept and iterate based on QA feedback. | Zero work. | Risk. |

**Recommended action:** Defer to QA feedback. If users complain, start with Option B (cheapest), escalate to A or C if needed.

---

### Gap 12 — Activity feed auto-clears program/paymentType filters on scope change

**Severity:** Minor · **Effort:** 0 (keep) or S (adjust) · **Category:** UX preference

**Files involved**
- `app/workspace/reports/activity/_components/activity-feed-page-client.tsx`
- `app/workspace/reports/activity/_components/activity-feed-filters.tsx`

**Current behavior**
New `programId` / `paymentType` filters only render when the entity-type filter is in payment scope (via `shouldShowPaymentFilters` predicate). When the user switches the entity-type filter out of payment scope, the two new filters auto-clear their values to prevent silent suppression.

**Impact**

1. **Positive:** Prevents confusion where "all events" mode would silently hide non-payment events that lack a programId.
2. **Potential negative:** User sets a program filter, toggles entity-type to "all" to glance at the broader feed, then switches back — the program filter is gone. Must re-set.
3. **Cognitive load.** The current behavior is implicit; no toast or visual cue explains "your filters were cleared because they no longer apply."

**Remediation options**

| Option | Pros | Cons |
|---|---|---|
| **A. Keep auto-clear.** Add an inline hint to the filter row: "Program and Payment Type filters apply only to payment events." | Simple. Prevents confusion. | Slight UI noise. |
| B. Preserve filter state; grey out + disable the two filters when out of scope with a tooltip "Only applies to payment events." | Filters survive scope toggles. | User may miss that filters aren't active — subtle. |
| C. Always apply filters. Non-payment events lacking programId are simply excluded. | Most literal interpretation of "filter." | Confusing — user expects scope filter to govern. |

**Recommended action:** Option A — cheapest hardening of the current behavior.

---

### Gap 13 — `reference` (form key) vs `referenceCode` (backend arg) naming drift

**Severity:** Cosmetic · **Effort:** S · **Category:** Consistency

**Files involved**
- `app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx:171`
- `app/workspace/closer/meetings/_components/payment-form-dialog.tsx`
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog.tsx`

**Current behavior**
Dialogs use Zod field name `reference` with label "Reference", then at submit map to backend arg `referenceCode`:
```ts
referenceCode: values.reference?.trim() || undefined,
```
Different dialogs chose different names across prior phases; the rewrite in Window 5 didn't normalize.

**Impact**

1. **Small cognitive tax during code review.** Reviewer has to trace the mapping.
2. **Grep-ability.** Searching for `reference` hits both form fields and unrelated matches; `referenceCode` is more specific.
3. **Not user-facing.** Label is "Reference" either way.

**Remediation options**

| Option | Pros | Cons |
|---|---|---|
| **A. Normalize form field name to `referenceCode`** in Zod schema + `name` prop + mapping. Label stays "Reference" (display). | Matches backend. One name to grep. | ~15 min touch-up across 3–4 files. |
| B. Normalize backend arg to `reference`. | Shorter. | Cross-cutting schema + mutation + every caller. Out of scope. |
| C. Leave as-is. | Zero work. | Drift persists. |

**Recommended action:** Option A during next refactor pass.

---

### Gap 14 — `admin_meeting` / `admin_reminder` origin labels may imply admin closed the deal

**Severity:** Minor · **Effort:** S · **Category:** Copy / UX

**Files involved**
- `app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx` — `ORIGIN_META`
- `app/workspace/reports/team/_components/closer-performance-table.tsx` — "Admin On Behalf" column

**Current behavior**
Revenue-by-origin chart lists:
- "Closer · Meeting"
- "Closer · Reminder"
- "Admin · Meeting"
- "Admin · Reminder"
- "Admin · Review"

The "Admin · Meeting" / "Admin · Reminder" labels mean **an admin logged the payment for a closer's meeting/reminder**. `attributedCloserId` still points to the closer, and commission flows to the closer. But a reader unfamiliar with the attribution model might interpret "Admin · Meeting" as "an admin closed this meeting" — which is wrong (admins don't close; they log on behalf).

The `deal-won-card` already mitigates this with the italic "Logged on behalf by {adminName}" line. The chart does not.

**Impact**

1. **Misinterpretation risk during team review meetings.** A tenant_master points at the chart and says "20% of revenue came from admin" — implying admin productivity. The actual meaning is "20% was logged by admin on behalf of closers."
2. **Commission disputes.** A closer glancing at their performance table sees "Admin On Behalf: $X" in a column. The current tooltip explains, but the revenue chart doesn't.

**Remediation options**

| Option | Pros | Cons |
|---|---|---|
| **A. Rename chart labels to "Admin-Logged · Meeting"** (and similar for Reminder / Review). Clarifies the verb. | More accurate. | Longer labels — may wrap on mobile. |
| B. Add an InfoIcon Popover next to "Revenue by Origin" chart title explaining: "Admin-prefixed origins mean the payment was logged by an admin on behalf of the attributed closer. Commission still flows to the closer." | Preserves short labels. | Requires user to discover the Popover. |
| C. Both. | Clearest. | Slightly more work. |

**Recommended action:** Option C. Rename to "Admin-Logged · Meeting" etc. (matches `closer-performance-table` column name "Admin On Behalf"), and add a Popover with the full attribution explanation.

---

## 4. Cross-Cutting Observations

### 4.1 Auto-derived Convex types are a positive pattern

Multiple files (`team-report-types.ts`, `revenue-by-origin-chart.tsx`) use `FunctionReturnType<typeof api.*.foo>` to derive types from backend function signatures. This eliminates an entire class of interface-drift bugs. New UI work should prefer this pattern over hand-written interfaces that mirror return shapes.

### 4.2 Design-system gaps surface repeatedly

Gaps 4 and 5 both stem from agents needing variants the design system doesn't ship. This suggests the shadcn primitives ingested into the codebase are the bare minimum — a Phase 10 polish pass could usefully:
- Extend `StatsCard` with `primary` and `muted` variants.
- Extend `Badge` with `muted` and perhaps `success` variants.
- Audit `cn(bg-muted text-muted-foreground)` usage elsewhere and consolidate.

### 4.3 Prompt / design-doc drift surfaces predictably

Gaps 6 (`program_saved` vs `program_upserted`), 7 (currency labels), 9 (collapsed empty state) all originate from the Window 5 parallelization prompt terseness vs. the fuller design doc. For future parallelization windows: agents should be instructed to prefer the design doc over the prompt when they conflict, with a short conflict log surfaced in their report. Agent 1's report followed this pattern (observation #1 and #2); others did not consistently.

### 4.4 Semantic metric shifts need a change-management channel

Gap 8 is the most tenant-visible risk in this entire implementation. A semantic change to a headline metric ("Cash Collected" → "Team Commissionable Revenue") without an in-app cue erodes tenant trust faster than any bug. Every future phase that re-scopes a metric should ship with: (a) a one-time in-app notice, (b) a help-doc paragraph, (c) a CHANGELOG entry. This is a template worth establishing once.

### 4.5 Admin-on-behalf flow is under-surfaced in aggregate views

Gaps 2 and 14 both touch the admin-on-behalf flow. The individual-deal surfaces (deal-won-card, review-outcome-card) correctly surface "Logged on behalf by {adminName}". But aggregate views (revenue-by-origin chart, team performance totals) use short labels that can mislead. A design pass on aggregate-view copy — ensuring every "admin" mention is explicitly framed as "logged by admin for closer" — would help.

---

## 5. Recommended Ship Plan

**Before production rollout:**

1. **Gap 1** (paidAt/note on `recordCustomerPayment`) — Ship as Phase 10a. Backend + UI.
2. **Gap 8** (Team Commissionable Revenue comms) — Ship in-app notice + help doc. Coordinate with product + CS.

**Follow-up PRs (within 2 weeks of rollout):**

3. Gap 6 (PostHog event rename)
4. Gap 4 + Gap 5 (design-system variants) as a bundled polish PR
5. Gap 7 (currency labels)
6. Gap 14 (admin-logged chart labels + Popover)
7. Gap 10 (server-message toasts)
8. Gap 9 (all-archived empty state)
9. Gap 12 (filter-scope inline hint)
10. Gap 13 (reference field normalization)
11. Gap 3 (phase9.md doc update)

**Defer / backlog:**

12. Gap 2 (admin reminder close powers) — product call
13. Gap 11 (chart alternative views) — wait for QA feedback

---

## 6. Verification Checklist (for reference)

Commands + greps that were run to confirm the Window 5 baseline is clean:

```bash
pnpm tsc --noEmit                                                  # exit 0
pnpm lint                                                          # 8 errors + 51 warnings, all pre-existing
grep -rn customer_flow app/                                        # clean
grep -rn "ORIGIN_META\.(unknown|customer_flow)" .                  # only docs
grep -rn programType app/                                          # clean
grep -rn "payment\.closerId\|payments\[.*\]\.closerId" app/        # clean
grep -rn "Fathom Link\|Fathom URL" app/workspace/closer            # clean
grep -rn 'name="provider"' app/                                    # clean
grep -rn "stats\.totalRevenue" app/                                # clean
grep -rn "deal\.closerName" app/                                   # clean
grep -rn "Closed by" app/                                          # clean
grep -rn PROVIDERS app/                                            # clean
grep -rn postConversionRevenueMinor .                              # present in backend + UI (correct)
```

---

_Document version: 1.0_
_Created: Window 5 implementation wrap-up (2026-04-21)_
_Authors: Phase 6B–9F parallel agent pass, consolidated by orchestrator._
