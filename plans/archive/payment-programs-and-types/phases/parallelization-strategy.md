# Parallelization Strategy — Payment Programs & Payment Types

**Purpose:** Define the parallel execution roadmap for the 9 phases of `payment-programs-and-types` (5 backend + 4 frontend), identify the critical path, enumerate file-ownership boundaries so concurrent streams never collide on merge, and lay out three concrete execution strategies (solo, 2-developer, 3+-agent). The feature decomposes into one destructive schema window, a narrow critical-path backend spine (Phase 3 → 4 → 5), and a wide frontend fan-out (Phases 6–9) that becomes fully parallel the moment Phase 5 lands.

**Prerequisite (blocking — verify before ANY phase starts):**

- v0.5 Feature D (Lead → Customer conversion) and v0.5b domain-events infrastructure are live on `main`.
- `paymentRecords` and `customers` row counts are **zero** in every environment (dev + preview + prod). Run `npx convex data --prod paymentRecords --limit 1` and `npx convex data --prod customers --limit 1` immediately before merging Phase 2; abort if non-zero. This is the precondition that makes the destructive schema rewrite in Phase 2 safe.
- `npx convex dev` accepts the current schema without errors on `main`.
- `pnpm tsc --noEmit` and `pnpm lint` are both green on `main`.
- The single test tenant on production is identified and has at least one admin account ready to be re-onboarded into `tenantPrograms` (via Phase 1's `ensureInitialProgramForTenant`) before the frontend ships.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **1** | Tenant Programs Registry | Backend | Medium | None (parallel with Phase 2; coordinates on `schema.ts` merge) |
| **2** | Payment / Customer / Stats Schema Rewrite (Destructive) | Backend | High | None (parallel with Phase 1; coordinates on `schema.ts` merge) |
| **3** | Shared Payment Helpers & Conversion | Backend | Low-Medium | Phase 1 + Phase 2 |
| **4** | Payment Write Paths + Admin Reminder Query | Backend | High | Phase 1 + Phase 2 + Phase 3 |
| **5** | Reporting & Read-Surface Backend Queries | Backend | High | Phase 1 + Phase 2 + Phase 3 + Phase 4 (**hard gate** for Phases 8 + 9) |
| **6** | Settings Programs UI + Shared `ProgramSelect` | Frontend | Medium | Phase 1 (only — can start during Phase 2); 6A is a mini-gate for Phases 7 + 8 |
| **7** | Commissionable Payment Dialogs + Admin Reminder Route | Frontend | Medium-High | Phases 1–4 + Phase 6A (not blocked by Phase 5) |
| **8** | Customer Read-Surface + Non-Commissionable Dialog + Payment Display Refreshes | Frontend | Medium-High | Phases 1–5 + Phase 6A |
| **9** | Reporting UI + Dashboard + Activity Feed | Frontend | High | Phases 1–5 (Phase 5 is HARD gate; Phase 6A NOT required) |

**Reading the table:**

- **Phase 1 and Phase 2 run fully in parallel** — they modify different blocks inside `convex/schema.ts` (Phase 1 adds a new `tenantPrograms` block; Phase 2 rewrites existing `paymentRecords` / `customers` / `tenantStats` blocks) and touch entirely separate subdirectories otherwise. They coordinate ONLY at the `convex/schema.ts` merge.
- **Phase 3 is the narrowest point on the whole critical path** — ~250 LOC, mostly mechanical, but every Phase 4 write path imports from it.
- **Phase 5 is the last backend gate** before Phases 8 + 9 can start in earnest. Phase 7 is the one frontend phase that does not need Phase 5 — it only writes, never reads the new reporting shape.
- **Phase 6A (the shared `ProgramSelect` component) is a mini-gate** for Phases 7 and 8. It's a ~50-LOC component that can ship in under an hour on day 2, so it effectively does not appear on the critical path.

---

## Master Dependency Graph

```
                    ┌──────────────────────────────────────────────────────────────────┐
                    │              PRE-EXISTING MAIN (2026-04-20)                      │
                    │  v0.5 Feature D + v0.5b events live; paymentRecords + customers  │
                    │  both empty in dev + preview + prod (verify immediately before   │
                    │  Phase 2 merges — destructive-rewrite precondition).             │
                    └──────────────────────────────────────────────────────────────────┘
                                           │
                           ┌───────────────┴───────────────┐
                           │                               │
                  ┌────────▼────────┐             ┌────────▼────────────────┐
                  │     PHASE 1     │             │        PHASE 2          │
                  │ Tenant Programs │             │ Payment/Customer/Stats  │
                  │    Registry     │  PARALLEL   │  Schema Rewrite         │
                  │   (Backend)     │◀──────────▶│   (Backend, destructive)│
                  │                 │             │                         │
                  │ convex/         │             │ convex/schema.ts        │
                  │   tenantProgs/  │             │ convex/reporting/       │
                  │ convex/schema.ts│             │ convex/tenantProgs/sync │
                  └────────┬────────┘             └────────┬────────────────┘
                           │                               │
                           └───────────────┬───────────────┘
                                           │
                                  ┌────────▼────────┐
                                  │     PHASE 3     │
                                  │ Shared Payment  │ ← CRITICAL PATH (narrowest)
                                  │ Helpers &       │    ~250 LOC, mechanical
                                  │ Conversion      │
                                  │  (Backend)      │
                                  └────────┬────────┘
                                           │
                                  ┌────────▼────────┐
                                  │     PHASE 4     │ ← CRITICAL PATH
                                  │ Payment Write   │    5 parallel streams
                                  │ Paths + Admin   │    (4A–4E)
                                  │ Reminder Query  │
                                  │   (Backend)     │
                                  └────────┬────────┘
                                           │
                                  ┌────────▼────────┐
                                  │     PHASE 5     │ ← CRITICAL PATH (hard gate)
                                  │ Reporting &     │    5A serial gate
                                  │ Read-Surface    │    → 5B/5C/5D/5E parallel
                                  │    Queries      │
                                  │   (Backend)     │
                                  └────────┬────────┘
                                           │
                  ┌────────────────────────┼────────────────────────┐
                  │                        │                        │
         ┌────────▼────────┐      ┌────────▼────────┐      ┌───────▼─────────┐
         │     PHASE 7     │      │     PHASE 8     │      │     PHASE 9     │
         │ Commissionable  │      │ Customer Read-  │      │ Reporting UI +  │
         │ Payment Dialogs │      │ Surface + Non-  │      │ Dashboard +     │
         │ + Admin Reminder│      │ Commissionable  │      │ Activity Feed   │
         │     Route       │      │ Dialog +        │      │   (Frontend)    │
         │  (Frontend)     │      │ Display Refresh │      │                 │
         │                 │      │  (Frontend)     │      │ Critical-path   │
         │ Needs 1–4 + 6A  │      │ Needs 1–5 + 6A  │      │ endpoint: last  │
         │ (does NOT need  │      │                 │      │ surface on 5's  │
         │   Phase 5)      │      │                 │      │ shape           │
         └─────────────────┘      └─────────────────┘      └─────────────────┘

  ┌────────▼─────────────────────────────────────────────────────────┐
  │                         PHASE 6                                  │
  │  Settings Programs UI + Shared ProgramSelect (Frontend)          │
  │  Gated only on Phase 1. Starts in parallel with Phase 2.         │
  │  6A (ProgramSelect) is a mini-gate for Phases 7 + 8.             │
  │  6B–6E can tail through Phase 4/5/6/7.                           │
  └──────────────────────────────────────────────────────────────────┘
```

**Reading the graph:**

- The **top of the graph** is one pair (Phase 1 || Phase 2) — the one and only place in this feature where two phases share a file (`convex/schema.ts`) but not a block.
- The **backend spine** (Phases 3 → 4 → 5) is strictly sequential because each phase's API signature feeds the next.
- The **frontend fan-out** (Phases 6–9) shares zero files beyond Phase 6A's single shared component. Three of the four frontend phases (6, 7, 8, 9) can run fully in parallel after the backend spine lands. Phase 7 is the one that can slot in earlier because it does not need Phase 5.
- **Phase 6 is the off-spine phase.** It doesn't block any backend work, doesn't depend on any backend phase beyond Phase 1, and delivers a shipping surface (Settings → Programs) independently. In a two-developer layout, it is the natural "backgrounded" stream for the frontend dev while the backend dev pushes the spine.

---

## Maximum Parallelism Windows

### Window 1: Schema Foundation (Phases 1 || 2)

**Concurrency:** **2 fully independent streams.** The only shared file is `convex/schema.ts`, and each phase rewrites DIFFERENT table blocks — no textual merge conflict, only a single `npx convex dev` deploy coordination.

**Why this parallelism is possible:**

- **Phase 1** adds the new `tenantPrograms` table block and creates a new directory `convex/tenantPrograms/`. Zero files in the pre-existing tree are modified outside `schema.ts`.
- **Phase 2** rewrites existing blocks (`paymentRecords`, `customers`, `tenantStats`) in `schema.ts` and modifies existing files under `convex/reporting/` + `convex/tenantPrograms/sync.ts`. Phase 1 lands `sync.ts` as a paginated no-op stub; Phase 2 fills in the body.
- The two phases coordinate **only** on the `schema.ts` merge order: whichever lands second rebases against the first. The `tenantPrograms` / `paymentRecords` / `customers` table blocks never overlap textually.

```
Timeline (days):  0.0 ── 0.25 ── 0.5 ── 0.75 ── 1.0
                   ▼
  Phase 1  ██████████████████████                ← schema + CRUD + seed
  Phase 2  ██████████████████████                ← schema rewrite + writeHooks + sync
                   │                 │
                   │                 └── Merge gate: `npx convex dev` deploys
                   │                     BOTH migrations together. Both phases
                   │                     must pass `tsc --noEmit` on the combined
                   │                     schema before Phase 3 starts.
```

**Internal parallelism — Phase 1 (5 subphases):**

```
1A (schema — serial gate) ─────────────────────────────┐
                                                       │
   Once schema deploys and dataModel types regenerate: │
                                                       │
                    1B (mutations — upsert/archive/restore) ──┐
                    1C (query — listPrograms) ────────────────┤
                    1D (rename-sync internal mutation stub) ──┤  All four in parallel
                    1E (seed helper ensureInitialProgram) ────┘  after 1A ships.
```

**Internal parallelism — Phase 2 (6 subphases):**

```
2A (paymentRecords rewrite) ───────┐
2B (customers reshape)  ───────────┤  All three in parallel:
2C (tenantStats additive counters) ┤  different blocks in schema.ts.
                                   ▼
                            Deploy `npx convex dev` — dataModel types regenerate.
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
                    ▼              ▼              ▼
             2D (paymentSums   2E (sync.ts body  2F (operational tooling
                 aggregate +       now live —        — backfill /
                 writeHooks)       paginated)        verification /
                                                     migrations)
```

**Critical parallelism within the window:** 2A/2B/2C in one stream ship in ~30 min by a single engineer; 1A in a second stream ships in ~15 min. Then both dev stacks block on a single coordinated `npx convex dev` deploy before fanning out to (1B/1C/1D/1E) and (2D/2E/2F) in up to **8 concurrent subphase streams**.

---

### Window 2: Critical-Path Spine (Phase 3)

**Concurrency:** **Up to 3 parallel subphase streams** inside one phase. No other phase can start; Phase 3 is the narrowest point on the whole critical path.

**Why this is a serial gate:**

- Every Phase 4 write path imports `assertPaymentRow`, `requireActiveProgram`, and `applyPaymentStatsDelta` from Phase 3. Until these compile, no downstream work typechecks.
- Phase 3 is small (~250 LOC) and mechanical. One engineer can ship the whole phase in ~half a day.

```
Timeline (days):  1.0 ── 1.25 ── 1.5
                   ▼
  Phase 3A  ████████             ← paymentHelpers.ts (assertPaymentRow + requireActiveProgram)
  Phase 3B  ████████             ← tenantStatsHelper.ts (applyPaymentStatsDelta + widened type)
  Phase 3C  ████████             ← customers/conversion.ts (executeConversion rewrite)
  Phase 3D              ████     ← customers/mutations.ts (convertLeadToCustomer arg drop) — needs 3C
```

**Internal parallelism:**

```
3A (paymentHelpers.ts) ──┐
                         │
3B (tenantStatsHelper.ts)┤ (all 3 in parallel)
                         │
3C (conversion.ts)       ┘
              │
              └───▶ 3D (convertLeadToCustomer arg drop — depends on 3C only)
```

---

### Window 3: Critical-Path Mutation Rewrites (Phase 4) || Phase 6 Settings UI

**Concurrency:** **Up to 5 parallel Phase 4 streams + 4 parallel Phase 6 streams = 9 concurrent streams.** Phase 4 and Phase 6 touch completely different directories (backend `convex/*` vs. frontend `app/*`).

**Why this parallelism is possible:**

- Phase 4's five subphases each own a distinct backend file (`convex/closer/payments.ts`, `convex/closer/reminderOutcomes.ts`, `convex/customers/mutations.ts`, `convex/lib/outcomeHelpers.ts` + `convex/reviews/mutations.ts`, `convex/pipeline/reminderDetail.ts`).
- Phase 6's gates match: **6A ships first** (the shared `ProgramSelect` component, ~20 min) and unblocks Phases 7 + 8. **6B + 6C are independent** (the form modal and the row presentational component). **6D integrates them** into `programs-tab.tsx`. **6E wires the tab** into `settings-page-client.tsx`.
- Phase 6 has been a latent parallel stream since Phase 1 merged — it only needs `listPrograms` (Phase 1C). A frontend engineer can carry Phase 6 through Windows 1 + 2 + 3 while the backend spine runs.

```
Timeline (days):  1.5 ── 1.75 ── 2.0 ── 2.25 ── 2.5 ── 2.75 ── 3.0
                   ▼
  Phase 4A  ██████████████████                ← logPayment rewrite
  Phase 4B  ██████████████████                ← logReminderPayment + admin extension
  Phase 4C  ██████████████████                ← recordCustomerPayment (admin-only)
  Phase 4D  ██████████████████                ← createPaymentRecord + resolveReview dispute
  Phase 4E  ██████████████████                ← getAdminReminderDetail (new query)

  (Phase 6 runs in parallel all window, carried over from Window 1:)
  Phase 6A  ████                              ← ProgramSelect (20 min, ships FIRST)
  Phase 6B  ────████████                      ← program-form-dialog
  Phase 6C  ────████████                      ← program-row
  Phase 6D  ────────────████████              ← programs-tab (consumes 6B + 6C)
  Phase 6E  ────────────────────████          ← settings-page-client wiring
```

**Internal parallelism — Phase 4:**

```
4A (logPayment) ──────────┐
4B (logReminderPayment) ──┤
4C (recordCustomerPayment)┤── Phase 4 complete → Phase 5
4D (createPaymentRecord + resolveReview)
4E (getAdminReminderDetail)
```

All five subphases touch different files. Zero shared imports. Up to 5 parallel developers or streams.

**Internal parallelism — Phase 6:**

```
6A (ProgramSelect) ── serial gate for Phases 7 + 8 ─────────┐
                                                             │
                 ┌─────── 6B (program-form-dialog) ──┐       │
                 │                                    │       │
                 ├─────── 6C (program-row) ──────────┤       │
                 │                                    │       │
                 │        (6B + 6C parallel)          │       │
                 │                                    ▼       │
                 │        6D (programs-tab — consumes 6B+6C)  │
                 │                   │                        │
                 │                   ▼                        │
                 │        6E (settings-page-client wiring)    │
                 │                                            │
                 └────────────────────────────────────────────┘
```

---

### Window 4: Reporting Backend (Phase 5)

**Concurrency:** **1 serial gate (5A) → 4 parallel streams (5B, 5C, 5D, 5E).** Phase 5 is the last backend phase; Phases 8 + 9 block on it.

**Why 5A is a serial gate:**

- `splitPaymentsForRevenueReporting` lives in `convex/reporting/lib/helpers.ts` (5A) and is imported by every consumer (5B, 5C, 5D). 5A is small (<100 LOC); one engineer ships it in ~1 hour.
- 5E (read-surface queries) is genuinely parallel to 5A — it rewrites `getMeetingDetail`, `getReminderDetail`, `getCustomerDetail`, `getReviewDetail` to map Phase 2's new payment fields into their return shapes, and does not import the reporting helper.

```
Timeline (days):  3.0 ── 3.25 ── 3.5 ── 3.75 ── 4.0 ── 4.25 ── 4.5
                   ▼
  Phase 5A  ████                          ← reporting/lib/helpers.ts (serial gate)
  Phase 5E  ████████████████              ← read-surface queries (parallel to 5A)
  Phase 5B  ────████████████              ← revenue.ts + revenueTrend.ts (after 5A)
  Phase 5C  ────████████████              ← remindersReporting.ts + teamPerformance.ts (after 5A)
  Phase 5D  ────████████                  ← adminStats.ts + activityFeed.ts (after 5A)

  (Phase 7 can start mid-Window 4:)
  Phase 7A  ────────████████              ← payment-form-dialog (needs 1-4 + 6A; not 5)
  Phase 7B  ────────████████              ← reminder-payment-dialog
  Phase 7C  ────────████████              ← review-resolution-dialog
  Phase 7D  ────────████████              ← admin reminder route
  Phase 7E                   ████         ← verification pass (after 7A-7D)

  (Phase 6 tail:)
  Phase 6D  ────────████                  ← programs-tab (if not already done)
  Phase 6E  ────────────████              ← settings-page-client wiring
```

**Internal parallelism — Phase 5:**

```
5A (reporting/lib/helpers.ts) ──┬─▶ 5B (revenue.ts + revenueTrend.ts)
                                │
                                ├─▶ 5C (remindersReporting.ts + teamPerformance.ts)
                                │
                                └─▶ 5D (adminStats.ts + activityFeed.ts)

5E (read-surface queries)  ────────▶ (parallel to 5A; no helper dependency)
    → getMeetingDetail, getReminderDetail, listCustomers + getCustomerDetail,
      getReviewDetail
```

**Key observation:** Phase 7 (commissionable payment dialogs) does NOT need Phase 5 — it only uses Phase 4 mutations. An aggressive multi-agent schedule slots Phase 7 INTO this window, starting at the 3.5-day mark the moment Phase 4 + Phase 6A are green.

---

### Window 5: Frontend Fan-Out (Phases 7 + 8 + 9 all in parallel)

**Concurrency:** **Up to 14 parallel frontend streams** across three phases — Phase 7 (4 streams), Phase 8 (6 streams), Phase 9 (6 streams). After Phase 5 lands, every remaining frontend subphase is file-disjoint.

**Why this is possible:**

- **Phase 7** touches four files: `payment-form-dialog.tsx` (closer meeting flow — shared by closer + admin action bars), `reminder-payment-dialog.tsx`, `review-resolution-dialog.tsx`, and the new `app/workspace/pipeline/reminders/[followUpId]/` route. Zero shared files with Phases 8 + 9.
- **Phase 8** touches six files across four directories: `customers/_components/` (3 files: dialog, page-client, table), `closer/meetings/_components/deal-won-card.tsx`, `closer/reminders/_components/reminder-history-panel.tsx`, `reviews/_components/review-outcome-card.tsx`. Zero shared files with Phases 7 + 9. (8D's `deal-won-card.tsx` is shared by closer + admin meeting detail pages, but both pages consume the same file — no duplication needed.)
- **Phase 9** touches the three report routes (`reports/revenue/`, `reports/reminders/`, `reports/team/`), the activity feed (`reports/activity/`), and the dashboard (`_components/stats-row.tsx` + `dashboard-page-client.tsx`). Zero shared files with Phases 7 + 8.

```
Timeline (days):  4.5 ── 4.75 ── 5.0 ── 5.25 ── 5.5 ── 5.75 ── 6.0
                   ▼
  Phase 7E  ████                          ← (tail from Window 4)

  Phase 8A  ████████                      ← record-payment-dialog (non-commissionable)
  Phase 8B  ████████                      ← customer-detail-page-client
  Phase 8C  ████████                      ← payment-history-table
  Phase 8D  ████████                      ← deal-won-card
  Phase 8E  ████████                      ← reminder-history-panel
  Phase 8F  ████████                      ← review-outcome-card
  Phase 8G              ████              ← verification pass (after 8A-8F)

  Phase 9A  ████                          ← 3 shared filter components (serial gate)
  Phase 9B  ────████████                  ← revenue report rewrite (5 sub-files)
  Phase 9C  ────████                      ← reminders report extension
  Phase 9D  ████████                      ← team report refresh (does NOT need 9A)
  Phase 9E  ████████                      ← dashboard stats row (does NOT need 9A)
  Phase 9F  ────████                      ← activity feed badges + filters
  Phase 9G              ████              ← verification pass (after 9A-9F)
```

**Internal parallelism — Phase 7:**

```
7A (payment-form-dialog) ──┐
7B (reminder-payment-dialog) ─┤
7C (review-resolution-dialog) ─┤── 7E (verification pass)
7D (admin reminder route)  ──┘
```

All four in parallel; 7E runs last as grep + tsc + lint + smoke-test sweep.

**Internal parallelism — Phase 8:**

```
8A (record-payment-dialog) ──┐
8B (customer-detail-page-client) ─┤  (8A/8B/8C natural cluster;
8C (payment-history-table) ───────┤   one PR, half-day sprint)
                                  │
8D (deal-won-card) ───────────────┤  (three independent display refreshes)
8E (reminder-history-panel) ──────┤
8F (review-outcome-card) ─────────┤
                                  │
                                  └── 8G (verification pass — runs last)
```

**Internal parallelism — Phase 9:**

```
9A (3 shared filter components) ──┐
                                   │
                                   ├─▶ 9B (Revenue report rewrite)       ──┐
                                   │                                       │
                                   ├─▶ 9C (Reminders report extension)   ──┤
                                   │                                       │
                                   └─▶ 9F (Activity feed extension)       ──┤
                                                                           ├── 9G
9D (Team report refresh)         ───────────────────────────────────────── ┤   (verify)
                                                                           │
9E (Dashboard stats row rewrite) ───────────────────────────────────────── ┘
```

9D + 9E do NOT need 9A (team + dashboard have no per-program / per-paymentType filters). They can start the moment Phase 5 lands, in parallel with 9A itself.

---

## Critical Path Analysis

The **critical path** — the longest sequential chain that determines minimum delivery time — is:

```
Phase 1 / 2   →   Phase 3   →   Phase 4   →   Phase 5   →   Phase 9
(Day 0 - 1)       (1 - 1.5)     (1.5 - 3)     (3 - 4.5)     (4.5 - 6)
  │                 │             │             │             │
  │                 │             │             │             └── Dashboard + reports
  │                 │             │             │                 cannot render correct
  │                 │             │             │                 totals until this
  │                 │             │             │                 consumer lands.
  │                 │             │             │
  │                 │             │             └── Last backend gate. Reporting
  │                 │             │                 queries emit the four-way
  │                 │             │                 split that Phase 9 binds to.
  │                 │             │
  │                 │             └── Mutations produce the new `paymentRecords`
  │                 │                 shape. Without this, Phase 5 reads `undefined`
  │                 │                 for `commissionable` / `attributedCloserId`.
  │                 │
  │                 └── ~250 LOC of invariant + delta-routing helpers. Mechanical
  │                     but every Phase 4 write path imports from here.
  │
  └── Schema foundation. Phase 1 and Phase 2 in parallel; the merged deploy
      of both is the gate Phase 3 blocks on.
```

**Critical-path length:** ~6 days for a solo developer; ~3 days for a well-parallelized 3-developer team.

**Alternative shorter paths** that finish earlier and unblock frontend testing:

- **Phase 1 → Phase 6A → Phase 6B-6E** (Settings Programs UI) finishes as early as Day 1.5 on the solo plan, Day 1 on the 2-dev plan. Admins can configure programs end-to-end while the rest of the backend is still being rewritten. The frontend is graceful: payment dialogs render an "Ask an admin to configure a program" empty state until the backend catches up.
- **Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 7** (commissionable payment dialogs, without Phase 5) is a valid shorter path: Phase 7 can ship as soon as Phase 4 deploys and Phase 6A exists. It skips Phase 5 because the dialogs only WRITE — they never read the new reporting shape. Running a smoke test against Phase 7 before Phase 5 ships validates the write side of the feature in isolation.

**Implications:**

- **Start Phase 3 as early as possible.** It is the narrowest point (~0.5 day) and every downstream phase blocks on it. A small optimization: split Phase 3 so 3A/3B/3C run concurrently on Day 1.5 the moment the Window 1 schema deploy is green.
- **Start Phase 6A immediately after Phase 1C deploys.** 6A unblocks Phases 7 and 8 and is ~20 min of work. Failing to ship it early means the Phase 7 and Phase 8 frontend developers are idle waiting on Phase 5 to finish.
- **Phase 5 is the hard gate for Phase 9.** Do NOT start Phase 9 PRs until Phase 5 is merged and the smoke test in `phase5.md` passes on a preview deployment. If Phase 5 ships with a shape bug, every Phase 9 component breaks at mount.
- **Phase 7 and Phase 9 should deploy together with Phase 4 + Phase 5.** A Phase 4-only deploy without Phase 7 means the old payment-form-dialog submits `provider` + `referenceCode` that the Convex validator now rejects. The rollout checklist must bundle Phase 4 + Phase 5 + Phase 7 + Phase 8 + Phase 9 as one coordinated release (per design §18).

---

## File Ownership Boundaries (Merge Conflict Prevention)

When running phases in parallel, each phase owns specific directories and files. Any file listed twice is a **coordination point** — callers must sequence the phases or split the file changes.

### Backend Files

| File / Directory | Phase Owner | Notes |
|---|---|---|
| `convex/schema.ts` | **Phase 1 (new block) + Phase 2 (modified blocks)** | The one file touched by both parallel backend phases. Phase 1 adds the `tenantPrograms` block; Phase 2 rewrites `paymentRecords` / `customers` / `tenantStats`. Blocks do NOT textually overlap. Coordinate the merge order so one rebases on the other cleanly. |
| `convex/tenantPrograms/queries.ts` | **Phase 1C** | New. `listPrograms`. |
| `convex/tenantPrograms/mutations.ts` | **Phase 1B** | New. `upsertProgram` / `archiveProgram` / `restoreProgram`. |
| `convex/tenantPrograms/sync.ts` | **Phase 1D (stub) + Phase 2E (body)** | Phase 1 ships a no-op paginated skeleton; Phase 2 fills in the body that patches `paymentRecords.programName` and `customers.programName`. Phase 2E depends on Phase 2A + 2B having deployed. |
| `convex/tenantPrograms/seed.ts` | **Phase 1E** | New. `ensureInitialProgramForTenant` internal mutation. |
| `convex/reporting/writeHooks.ts` | **Phase 2D** | Modified. `insertPaymentAggregate` + `replacePaymentAggregate` commissionable-only guard. |
| `convex/reporting/aggregates.ts` | **Phase 2D** | Modified. `paymentSums` sortKey re-keying. |
| `convex/reporting/backfill.ts`, `convex/reporting/verification.ts`, `convex/admin/migrations.ts` | **Phase 2F** | Modified. Drop references to removed fields. |
| `convex/lib/paymentHelpers.ts` | **Phase 3A** | Modified (append-only). Adds `assertPaymentRow`, `requireActiveProgram`, `CommissionableOrigin` / `NonCommissionableOrigin` / `PaymentType` types. Existing helpers untouched. |
| `convex/lib/paymentTypes.ts` | **Phase 3A amendment** | New file (per Phase 4 prerequisite). Re-exports the origin and payment-type union literals for broader consumption. |
| `convex/lib/tenantStatsHelper.ts` | **Phase 3B** | Modified. Widens `TenantStatsDelta` type; adds `applyPaymentStatsDelta`. |
| `convex/customers/conversion.ts` | **Phase 3C** | Modified. `executeConversion` resolves program from winning payment. |
| `convex/customers/mutations.ts` | **Phase 3D + Phase 4C** | Phase 3D drops the `programType` arg from `convertLeadToCustomer`. Phase 4C rewrites `recordCustomerPayment` to admin-only with `customer_direct` origin. Two subphases, one file — Phase 3D merges first; Phase 4C builds on it. |
| `convex/closer/payments.ts` | **Phase 4A** | Modified. `logPayment` rewrite. |
| `convex/closer/reminderOutcomes.ts` | **Phase 4B** | Modified. `logReminderPayment` rewrite + admin caller extension. |
| `convex/lib/outcomeHelpers.ts` | **Phase 4D** | Modified. `createPaymentRecord` rewrite. |
| `convex/reviews/mutations.ts` | **Phase 4D** | Modified. `resolveReview` dispute branch routes through `applyPaymentStatsDelta`. |
| `convex/pipeline/reminderDetail.ts` | **Phase 4E** | New file; new directory if `convex/pipeline/` does not already exist. `getAdminReminderDetail` query. |
| `convex/reporting/lib/helpers.ts` | **Phase 5A** | Modified. `splitPaymentsForRevenueReporting` + trivial `attributePaymentsToClosers` passthrough. |
| `convex/reporting/revenue.ts` | **Phase 5B** | Modified. `getRevenueMetrics` + `getRevenueDetails` rewrite with filter args. |
| `convex/reporting/revenueTrend.ts` | **Phase 5B** | Modified. `getRevenueTrend` four-series emission. |
| `convex/reporting/remindersReporting.ts` | **Phase 5C** | Modified. Broaden origin filter + new filter args + final/deposit split. |
| `convex/reporting/teamPerformance.ts` | **Phase 5C** | Modified. Commissionable-only KPI math + `recordedByUserId` for admin-on-behalf. |
| `convex/dashboard/adminStats.ts` | **Phase 5D** | Modified. Read the four new split counters. |
| `convex/reporting/activityFeed.ts` | **Phase 5D** | Modified. Metadata enrichment passthrough verification. |
| `convex/closer/meetingDetail.ts`, `convex/closer/reminderDetail.ts`, `convex/customers/queries.ts`, `convex/reviews/queries.ts` | **Phase 5E** | Modified. Expose new payment fields on read surfaces. |

### Frontend Files

| File / Directory | Phase Owner | Notes |
|---|---|---|
| `app/workspace/closer/_components/program-select.tsx` | **Phase 6A** | New. Consumed by Phase 7 (3 dialogs) + Phase 8 (record-payment-dialog). Phase 6A is the mini-gate for Phases 7 + 8. |
| `app/workspace/settings/_components/program-form-dialog.tsx` | **Phase 6B** | New. |
| `app/workspace/settings/_components/program-row.tsx` | **Phase 6C** | New. |
| `app/workspace/settings/_components/programs-tab.tsx` | **Phase 6D** | New. Consumes 6B + 6C. |
| `app/workspace/settings/_components/settings-page-client.tsx` | **Phase 6E** | Modified. Adds the `programs` tab entry. |
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | **Phase 7A** | Modified (rewrite). Shared by closer `outcome-action-bar` + admin `admin-action-bar`. |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog.tsx` | **Phase 7B** | Modified (rewrite). Shared by closer reminder detail + Phase 7D admin reminder detail. |
| `app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx` | **Phase 7C** | Modified. `log_payment` branch only. |
| `app/workspace/pipeline/reminders/[followUpId]/page.tsx` + `_components/admin-reminder-detail-page-client.tsx` | **Phase 7D** | New route. |
| `app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx` | **Phase 8A** | Modified (rewrite). Admin-only, non-commissionable. |
| `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` | **Phase 8B** | Modified. `programType` → `programName`; admin gate on RecordPaymentDialog. |
| `app/workspace/customers/[customerId]/_components/payment-history-table.tsx` | **Phase 8C** | Modified. Column rewrite. |
| `app/workspace/closer/meetings/_components/deal-won-card.tsx` | **Phase 8D** | Modified. Shared by closer + admin meeting detail; one rewrite updates both. |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel.tsx` | **Phase 8E** | Modified. Two-line payment row. |
| `app/workspace/reviews/[reviewId]/_components/review-outcome-card.tsx` | **Phase 8F** | Modified. `PaymentSection` rewrite. |
| `app/workspace/reports/_components/report-program-filter.tsx` + `report-payment-type-filter.tsx` + `report-revenue-slice-filter.tsx` | **Phase 9A** | 3 new files. Consumed by 9B, 9C, 9F. |
| `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx` | **Phase 9B** | Modified. State for filters + passes args to 3 queries. |
| `app/workspace/reports/revenue/_components/revenue-kpi-cards.tsx` | **Phase 9B** | New. 4-card row. |
| `app/workspace/reports/revenue/_components/revenue-by-program-section.tsx` | **Phase 9B** | New. Two-column bar layout. |
| `app/workspace/reports/revenue/_components/revenue-by-payment-type-section.tsx` | **Phase 9B** | New. 4-column grid. |
| `app/workspace/reports/revenue/_components/revenue-trend-chart.tsx` | **Phase 9B** | Modified. Four-series line chart. |
| `app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx` | **Phase 9B** | Modified. `ORIGIN_META` keyspace rewrite. |
| `app/workspace/reports/revenue/_components/top-deals-table.tsx` | **Phase 9B** | Modified. Adds Program + Payment Type columns. |
| `app/workspace/reports/reminders/_components/reminders-report-page-client.tsx` | **Phase 9C** | Modified. Filter state + args. |
| `app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx` | **Phase 9C** | Modified. Final + deposits split layout. |
| `app/workspace/reports/team/_components/team-report-page-client.tsx` | **Phase 9D** | Modified. Passes new `postConversionRevenueMinor`. |
| `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx` | **Phase 9D** | Modified. Adds Post-Conversion Revenue card. |
| `app/workspace/reports/team/_components/closer-performance-table.tsx` | **Phase 9D** | Modified. Column rename + tooltips. |
| `app/workspace/reports/team/_components/team-report-types.ts` | **Phase 9D** | Modified. `TeamTotals` gains `postConversionRevenueMinor`. |
| `app/workspace/_components/stats-row.tsx` | **Phase 9E** | Modified (rewrite). 4+4 two-row layout. |
| `app/workspace/_components/dashboard-page-client.tsx` | **Phase 9E** | Modified. Interface extension. |
| `app/workspace/reports/activity/_components/activity-event-row.tsx` | **Phase 9F** | Modified. Payment-event badge row. |
| `app/workspace/reports/activity/_components/activity-feed-filters.tsx` | **Phase 9F** | Modified. Conditional program + paymentType filters. |
| `app/workspace/reports/activity/_components/activity-feed-page-client.tsx` | **Phase 9F** | Modified. Filters interface + `feedArgs` + reset tuple. |

**Double-touched files (coordination points):**

1. **`convex/schema.ts`** — Phase 1 (new `tenantPrograms` block) + Phase 2 (modified blocks). Different blocks; no textual conflict. Merge order is fungible; whichever lands second rebases cleanly.
2. **`convex/tenantPrograms/sync.ts`** — Phase 1D (paginated no-op stub) + Phase 2E (body fills in paginated patches). Sequential: Phase 1D must land first so the function exists with the correct signature.
3. **`convex/customers/mutations.ts`** — Phase 3D (drops `programType` from `convertLeadToCustomer` args) + Phase 4C (rewrites `recordCustomerPayment`). Different functions in the same file; Phase 3D merges first.

All other files are owned by exactly one phase. Parallel streams never collide beyond these three explicit coordination points.

---

## Recommended Execution Strategies

### Solo Developer (~10.5 days sequential; ~7 days with within-phase parallelism)

Execute in order, leveraging within-phase parallelism to stage multiple subphases in a single sitting:

1. **Day 1 (AM)** — Ship **Phase 1** (all 5 subphases, schema first, then 1B/1C/1D/1E concurrently). Deploy `npx convex dev`.
2. **Day 1 (PM)** — Ship **Phase 2** (schema edits 2A/2B/2C together, deploy, then 2D/2E/2F in one sitting).
3. **Day 2** — Ship **Phase 3** (3A/3B/3C staged in one sitting, 3D as a cleanup pass).
4. **Day 2.5 – Day 4** — Ship **Phase 4** (5 subphases; one engineer does them sequentially in ~1.5 days; batch grep/tsc sweep after all land).
5. **Day 4 (PM)** — Ship **Phase 6** (6A first — 20 min — so Phases 7+8 are unblocked; 6B-6E follow in the evening).
6. **Day 4.5 – Day 6** — Ship **Phase 5** (5A + 5E first, then 5B/5C/5D). Run the Phase 5 smoke test on preview.
7. **Day 6 – Day 7** — Ship **Phase 7** (4 parallel subphases done sequentially; 7E verification sweep).
8. **Day 7 – Day 8** — Ship **Phase 8** (8A/8B/8C cluster first, then 8D/8E/8F display refreshes, then 8G).
9. **Day 8 – Day 9** — Ship **Phase 9** (9A first, then 9B/9C/9D/9E/9F, then 9G).
10. **Day 9 (PM) – Day 10.5** — Full end-to-end smoke test across every surface on one fresh test tenant. Coordinate the single coordinated release (schema + functions + seed + frontend) per design §18.

**Estimated total:** **9–10.5 days.**

### Two Developers (Backend Lead + Frontend Lead) (~7 days)

| Sprint (day) | Developer A (Backend Lead) | Developer B (Frontend Lead) |
|---|---|---|
| **1** | Phase 1 (1A deploy, then 1B/1C/1D/1E concurrently) + Phase 2 (2A/2B/2C concurrently, then 2D/2E/2F) | Block on `listPrograms` typegen; review Phase 1 + Phase 2 design; prepare Phase 6 scaffolds |
| **2** | Phase 3 (3A/3B/3C + 3D) | Phase 6A (`ProgramSelect`) first; then 6B/6C in parallel; finish with 6D/6E |
| **3** | Phase 4 (5 subphases sequentially) | Phase 7A/7B (start mid-day; 7A shared by closer + admin action bars) |
| **4** | Phase 5A serial gate + Phase 5E (read-surface queries) | Phase 7C + 7D + 7E verification |
| **5** | Phase 5B + Phase 5C + Phase 5D | Phase 8A/8B/8C cluster |
| **6** | Phase 5 smoke test on preview; Phase 9D + 9E (backend-dev writes dashboard + team report since they know the Phase 5 shape best) | Phase 8D/8E/8F + 8G |
| **7** | Integration smoke test + production deploy coordination | Phase 9A + 9B + 9C + 9F + 9G |

**Estimated total:** **7 days.**

### Three+ Developers / Agents (~5 days)

| Sprint (day) | Agent A (Backend Spine) | Agent B (Backend Lateral) | Agent C (Frontend) |
|---|---|---|---|
| **1** | Phase 1A schema; Phase 1B mutations | Phase 2A/2B/2C schema rewrite; Phase 2D writeHooks + aggregate re-key | Phase 6A ProgramSelect (ships late Day 1 after Phase 1C lands) |
| **2** | Phase 3A/3B (paymentHelpers + tenantStatsHelper) | Phase 2E sync body + Phase 2F operational tooling; Phase 1C/1D/1E | Phase 6B + 6C in parallel |
| **3** | Phase 3C/3D (conversion + convertLeadToCustomer) + Phase 4A (logPayment) | Phase 4B/4C/4D/4E (4 parallel streams by the end of day) | Phase 6D + 6E wiring |
| **4** | Phase 5A serial gate; Phase 5B (revenue.ts + revenueTrend.ts) | Phase 5C + 5D + 5E (parallel streams after 5A) | Phase 7A/7B/7C/7D in parallel (Phase 6A already done) |
| **5** | Phase 9D (team report refresh — knows `postConversionRevenueMinor` shape) + Phase 5 smoke-test on preview | Phase 9E (dashboard stats row — knows split-counter shape) + integration QA | Phase 7E + Phase 8 (cluster 8A-8C then 8D-8F) + 9A + 9B/9C/9F |
| **6** | Phase 9G verification sweep + release coordination | Regression triage | Phase 9G smoke test (shared with Agents A+B) |

**Estimated total:** **5–6 days.**

**Recommendation:** For the production rollout of this feature, use the **Two Developer** cadence. The Three+ plan is feasible but the coordination overhead (daily sync on the `schema.ts` merge + the Phase 4/7 deploy-pairing rule) erases much of the parallelism benefit. A backend lead carrying the spine (1 → 2 → 3 → 4 → 5) while a frontend lead carries 6 → 7 → 8 → 9 is the cleanest split of responsibilities.

---

## Quality Gates

Every gate below is a **stop-and-verify** checkpoint. Do NOT advance until all checks are green.

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 0 — Preflight** | Before ANY phase starts | `npx convex data --prod paymentRecords --limit 1` returns `[]`. `npx convex data --prod customers --limit 1` returns `[]`. `main` branch is green on `pnpm tsc --noEmit` and `pnpm lint`. Single test tenant identified in production; admin email documented. |
| **Gate 1 — Schema Foundation** | After Phase 1 + Phase 2 merge (coordinated `npx convex dev` deploy) | `npx convex dev` deploys the combined schema without errors. Generated `dataModel.ts` types compile. `pnpm tsc --noEmit` passes (downstream call sites may still reference dropped fields — that's expected until Phase 3/4 land, but `convex/schema.ts` consumers must compile). Grep: `grep -R "paymentRecords.closerId" convex/schema.ts` returns zero. |
| **Gate 2 — Helper Layer** | After Phase 3 merge | `pnpm tsc --noEmit` passes. `convex/lib/paymentHelpers.ts::assertPaymentRow` rejects all 5 invariant violations in unit-style repl (call the function directly from the Convex dashboard). `convex/lib/tenantStatsHelper.ts::applyPaymentStatsDelta` routes a commissionable PIF to `totalCommissionableFinalRevenueMinor` (spot-check via `npx convex run`). |
| **Gate 3 — Write Paths** | After Phase 4 merge | `pnpm tsc --noEmit` passes. Grep sweep: `grep -R "paymentRecords.closerId" convex/` returns zero; same for `.provider`, `.loggedByAdminUserId`, `"customer_flow"`. Smoke test: book a test invitee via `testing/calendly:bookTestInvitee`, start a meeting, log a PIF payment from both closer and admin identities → confirm one correctly-shaped `paymentRecords` row per test, `paymentSums` entry when commissionable, `tenantStats.totalCommissionableFinalRevenueMinor` incremented. Dispute flow: `resolveReview → dispute` on the PIF → confirm `tenantStats` decremented, `paymentSums.sumValue` = 0 (not removed). |
| **Gate 4 — Reporting Backend** | After Phase 5 merge | `pnpm tsc --noEmit` passes. Grep sweep: zero `payment.closerId` in `convex/reporting/**`, `convex/dashboard/**`, `convex/closer/**`, `convex/customers/**`, `convex/reviews/**`. Zero `"customer_flow"`. Smoke test per `phase5.md`: seed `Launchpad` program, one test invitee, log 1 PIF + 1 deposit + 1 customer-direct post-conversion. Open `/workspace/reports/revenue` → KPIs show the PIF in Closed-Won, the deposit in Deposits, the customer-direct in Post-Conversion. **This is the hard gate for Phases 8 + 9 — do not start those frontend PRs until this gate is green on preview.** |
| **Gate 5 — Settings UI** | After Phase 6 merge | `pnpm tsc --noEmit` + `pnpm lint` pass. Smoke test per `phase6.md`: admin-only. Navigate to `/workspace/settings/programs`. Create `Launchpad` → ship. Duplicate-name error catches `launchpad`. Create `Accelerator` → ship. Archive `Accelerator` → card gains `Archived` pill behind Show Archived toggle. Archive `Launchpad` → last-active guard fires. Restore `Accelerator` → card returns. Open a meeting from `/workspace/closer/meetings/<id>` → `Log Payment` dialog's `Program` dropdown shows `Launchpad` only (active-only in dialog). |
| **Gate 6 — Commissionable Dialogs** | After Phase 7 merge | `pnpm tsc --noEmit` + `pnpm lint` pass. Grep: zero `PROVIDERS` enum, zero `"Fathom Link"` label, zero `provider` RHF field across `app/workspace/closer/meetings/**` + `app/workspace/closer/reminders/**`. Smoke test per `phase7.md`: log a meeting payment as closer, as admin-on-behalf; log a reminder payment as closer, as admin-on-behalf (via new `pipeline/reminders/<id>` route); log a review-resolution payment as admin. Five origin variants in Convex logs: `closer_meeting`, `admin_meeting`, `closer_reminder`, `admin_reminder`, `admin_review_resolution`. |
| **Gate 7 — Customer + Display Refreshes** | After Phase 8 merge | `pnpm tsc --noEmit` + `pnpm lint` pass. Grep: zero `customer.programType` across `app/**`; zero `payment.provider`, `payment.closerId`, `payment.closerName` across `app/**` (Phase 5 renamed; Phase 8 catches stragglers). Smoke test per `phase8.md`: 3-payment walk across customer detail, closer meeting detail, admin meeting detail, closer reminder detail, review detail — every surface shows consistent `Program: Launchpad`, `Payment Type`, `Attributed To`, and the "Recorded by X on behalf of Y" muted line on admin-logged rows. |
| **Gate 8 — Reporting + Dashboard + Activity Feed** | After Phase 9 merge | `pnpm tsc --noEmit` + `pnpm lint` pass. Grep: zero `customer_flow`, `ORIGIN_META.customer_flow`, `ORIGIN_META.unknown`, `deal.closerName` across `app/**`. Smoke test per `phase9.md` §Smoke Test Script: 6 scenarios with specific expected values ($4,500 commissionable final + $500 deposits + $500 post-conv final + $200 post-conv deposits with 2 active + 1 archived program). Filter bar on `/workspace/reports/revenue` changes each KPI card, each bar chart, the trend, and the top-deals table. Activity feed shows Program + Payment Type + Commissionable/Post-conversion badges on payment events. Dashboard shows the 4+4 two-row layout. |
| **Gate 9 — Production Deploy** | After all 9 gates are green on preview | Coordinated release per design §18: (1) Convex deploy (schema + functions atomically — Phase 1 + 2 blocks rewritten); (2) run `internal.tenantPrograms.seed.ensureInitialProgramForTenant` against the production test tenant (idempotent, seeds `Launchpad`); (3) Vercel deploy. Verify the test tenant admin can log a payment end-to-end within 15 minutes of deploy. |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| **Destructive schema rewrite on non-empty `paymentRecords` / `customers`** | **Critical** | Gate 0 preflight REQUIRES `npx convex data --prod <table> --limit 1` returns empty. Add the check to the rollout runbook. If any row exists, abort and switch to a widen-migrate-narrow plan (not in scope for this feature). |
| **`convex/schema.ts` merge conflict between Phase 1 + Phase 2** | Medium | Different table blocks — no textual conflict. The second-to-merge rebases cleanly. If conflict arises, the merge tool's 3-way merge resolves it because the hunks are disjoint. |
| **Phase 3 helpers ship with a bug that corrupts stats math** | High | Gate 2 unit-style spot-check via `npx convex run convex.lib.tenantStatsHelper:applyPaymentStatsDelta` before Phase 4 starts. The four split counters in `tenantStats` are ADDITIVE — a bad delta can be corrected by writing the inverse delta. Not permanently corrupting. |
| **Phase 4 deploys without matching Phase 7 frontend → closers submit old-shape payloads that server rejects** | High | The rollout checklist bundles Phase 4 + Phase 5 + Phase 7 + Phase 8 + Phase 9 as a single coordinated release (per design §18). Preview stacks deploy all 5 before promoting to prod. Do NOT ship Phase 4 to production without the matching frontend ready to go in the same release window. |
| **Phase 5 query shape bug breaks every Phase 9 component at mount** | High | Gate 4 is the hard gate — Phase 9 PRs do not start until Phase 5 passes its smoke test on a preview deployment. Phase 9's smoke test script (6 scenarios) uses specific expected values so a shape bug is caught in minutes, not days. |
| **`tenantPrograms` is empty on first tenant load → payment dialogs unusable** | Medium | `internal.tenantPrograms.seed.ensureInitialProgramForTenant` is invoked by deploy orchestration BEFORE Vercel deploy (Gate 9 step 2). `ProgramSelect` also renders a graceful empty state directing admins to `Settings → Programs` if the seed is skipped. |
| **Closer loses commission attribution on an in-flight payment during deploy** | Low | In-flight `paymentRecords` count is zero in all environments (Gate 0). No in-flight state to protect. |
| **Archived program referenced by existing payment still renders in reports** | Low (by design) | Phase 9's `<ReportProgramFilter>` passes `includeArchived: true` so archived programs still appear in the dropdown for historical slices. The payment dialog filter (`ProgramSelect`) passes `includeArchived: false` so closers can't select archived programs for new payments. |
| **`paymentSums` aggregate re-key corrupts denormalized sums** | High | Phase 2D re-keys from `[closerId, recordedAt]` to `[attributedCloserId, recordedAt]`. Zero rows exist at deploy time (Gate 0), so the aggregate re-populates from empty. No migration of existing sums needed. |
| **Activity-feed event metadata missing fields on pre-Phase-4 events** | Medium | Phase 9F's `activity-event-row.tsx` gates every metadata read on `event.metadata !== null` AND per-field type checks. Pre-Phase-4 payment events will lack `programId` / `programName` / `paymentType` / `commissionable` — the badge row is simply absent on those events, not broken. |
| **Frontend phase ships without matching backend → runtime errors on mount** | Medium | Each frontend phase plan lists exact backend prerequisites in its `Prerequisites` section. The Quality Gates above are the enforcement mechanism. |
| **Performance regression from new filter-aware reporting queries** | Medium | Phase 2 adds three new indexes specifically for the filter paths (`by_tenantId_and_programId_and_recordedAt`, `by_tenantId_and_paymentType_and_recordedAt`, `by_tenantId_and_commissionable_and_recordedAt`). Invoke `convex-performance-audit` after Phase 5 deploys and verify each filter query uses the expected index via Convex Insights. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | `convex-create-component` (discipline); `convex-performance-audit` | Create isolated `convex/tenantPrograms/` module; verify three indexes are the only ones needed (no over-indexing). |
| **2** | `convex-migration-helper`; `convex-performance-audit` | Confirm "destructive on empty tables" is the correct strategy; document pre-flight verification; audit the 4 new indexes do not duplicate or cardinality-explode. |
| **3** | `convex-performance-audit`; `convex-migration-helper` | Verify `applyPaymentStatsDelta` produces a single `ctx.db.patch`; cross-check the `programType` arg drop against in-flight frontend code. |
| **4** | `convex-performance-audit`; `convex-migration-helper`; `workos` (reference) | Verify rewritten mutations don't leak unbounded reads; document the Phase 4 + Phase 7 deploy coupling; confirm the new `recordCustomerPayment` admin gate aligns with WorkOS role mapping. |
| **5** | `convex-performance-audit`; `convex-migration-helper`; `web-design-guidelines` (reference) | Audit `splitPaymentsForRevenueReporting` read boundedness; document return-shape breakages for frontend readers; ensure new KPI labels map cleanly to accessible cards. |
| **6** | `shadcn`; `frontend-design`; `vercel-composition-patterns`; `web-design-guidelines`; `convex-performance-audit` (reference) | No new shadcn primitives; mirror existing Settings tab language; `ProgramSelect` is the three-state composition pattern; verify AlertDialog-for-destructive + aria-labels + keyboard order. |
| **7** | `shadcn`; `frontend-design` (reference); `vercel-composition-patterns`; `vercel-react-best-practices`; `web-design-guidelines`; `convex-performance-audit` (reference) | Compose existing Dialog/Form/Select; defer compound `<CommissionablePaymentFields>` extraction; avoid unnecessary `useEffect`; verify required-field asterisks + a11y + route-level role gate. |
| **8** | `shadcn`; `frontend-design` (reference); `vercel-composition-patterns`; `vercel-react-best-practices`; `web-design-guidelines`; `convex-performance-audit` (reference) | Same primitives as Phase 7; defer compound `<PaymentMetaRow>` extraction; ensure commissionability chip has `aria-label`; confirm the admin CTA is absent (not disabled) for closers. |
| **9** | `frontend-design`; `shadcn`; `vercel-react-best-practices`; `vercel-react-view-transitions`; `vercel-composition-patterns`; `web-design-guidelines`; `convex-performance-audit` | Apply `<StatsCard>` API consistently; compose existing `<ChartContainer>`; Recharts handles view-transition animation; three filter components are deliberately three composition units (not one generic config); verify a11y grouping + Convex Insights index usage. |

---

## Key Principles Applied

These are the explicit rules this strategy follows (from `.docs/internal/parallelization.md` §Key Principles + this feature's specific topology):

1. **Phase 1 and Phase 2 are the only same-file parallel pair.** They coordinate on `convex/schema.ts` via disjoint table blocks. All other parallel pairs in this feature are file-disjoint.
2. **File ownership is enforced by the table above.** The three coordination-point files (`schema.ts`, `tenantPrograms/sync.ts`, `customers/mutations.ts`) each have a clear merge order documented.
3. **Phase 3 is the critical-path bottleneck.** Start it the moment Gate 1 is green. Do NOT try to split it further — 4 subphases is the right grain for a ~250-LOC phase.
4. **Phase 5 is the hard gate for Phases 8 + 9.** Phase 7 is deliberately scoped to NOT need Phase 5 so it can start during Window 4 and compress the critical path.
5. **Phase 6A is a mini-gate for Phases 7 + 8 but not on the critical path.** It ships in ~20 minutes and must land before the other frontend phases import `<ProgramSelect>`.
6. **Phase 4 + Phase 7 deploy together.** The Convex arg validator rejects unknown keys; a Phase 4 deploy without matching Phase 7 breaks the closer UX. The rollout checklist bundles 4 + 5 + 7 + 8 + 9 as one coordinated release per design §18.
7. **Quality gates enforce the "stop and verify" discipline.** Each gate has concrete, automatable checks (tsc, grep, smoke-test scenarios with expected values). Subsequent phase PRs do NOT open until the prior gate is green.
8. **Deposits are tracked separately from final revenue on EVERY surface.** Both the data model (four `tenantStats` counters; four-way split in `splitPaymentsForRevenueReporting`) and the UI (4-card KPI row; 4-card dashboard row; dual-bar payment-type section; four-line trend chart). The parallelization strategy treats this as a single semantic unit across backend + frontend.

---

*This strategy maximizes parallelization while respecting the narrow critical-path spine (Phase 1+2 → 3 → 4 → 5) and the wide frontend fan-out (Phases 6–9). The key insight: Phase 6 runs entirely off-spine, Phase 7 can compress into Window 4 by skipping Phase 5 dependency, and Phases 8 + 9 are fully file-disjoint so they fan out to as many agents as you have available. Two developers in cadence ship this feature in seven days; three agents cut it to five.*
