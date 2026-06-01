# Phase 5 — Dashboard Presentation, Rollout, and QA

**Goal:** Finish visible dashboard changes, update explanatory copy, verify all affected surfaces, and execute the manual schedule-coverage rollout gate. After this phase, the MVP can ship without breaking adjacent dashboard, settings, Lead Gen, Slack, or DM attribution surfaces.

**Prerequisite:** Phases 1-4 complete. Schedule management UI is available for manual data entry.

**Runs in PARALLEL with:** Late Phase 4 component work for copy-only changes. Final QA and rollout are sequential.

**Skills to invoke:**
- `convex-performance-audit` — verify final read/subscription costs and no broad scans.
- `web-design-guidelines` — review UI accessibility, density, skeletons, and empty states.
- `frontend-design` — polish dashboard cards and expanded table presentation.
- `next-best-practices` — preserve client boundaries and settings Suspense behavior.
- `shadcn` — ensure UI composition follows project primitives.

**Acceptance Criteria:**
1. Lead Gen card ranks by `leadsPerHour` and displays submissions plus scheduled hours.
2. Top Qualifiers card ranks by `qualifiedPerHour` and displays qualified count, booked count, and scheduled hours.
3. Top DM Closers card ranks by `bookedPerHour` and displays booked count plus scheduled hours.
4. Missing schedules render `--` or equivalent null-rate display without throwing.
5. `overview-help-tooltip.tsx` explains efficiency ranking and missing schedule behavior.
6. Settings schedules can be populated for the production test tenant before ranking is accepted as final.
7. Lead Gen Ops reports/exports outside `/workspace` keep existing quantity-first behavior.
8. Existing Slack reporting and operations reporting routes still render.
9. Convex function caps and subscription behavior match Phase 0 budgets.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (card display + copy) ───────────┬── 5C (role/range QA) ───────┐
5B (type/formatter sync) ───────────┤                            │
                                    ├── 5D (Convex perf audit) ──┤── 5F (rollout decision)
Phase 4 complete ───────────────────┤                            │
                                    └── 5E (browser/UI QA) ──────┘
```

**Optimal execution:**
1. Run 5A and 5B as soon as Phase 3 types stabilize.
2. Start QA streams after Phase 4 interaction work is complete.
3. Make rollout decision only after role/range QA, Convex audit, browser QA, and schedule coverage all pass.

**Estimated time:** 1-2 days

---

## Subphases

### 5A — Card Metrics and Help Copy

**Type:** Frontend  
**Parallelizable:** Yes — can run after Phase 3 row types stabilize.

**What:** Update card display to emphasize per-hour rates with raw count and scheduled-hour context.

**Why:** Efficiency metrics can be misleading without denominator context, especially for tiny scheduled-hour values.

**Where:**
- `app/workspace/_components/lead-gen-overview-card.tsx` (modify)
- `app/workspace/_components/top-qualifiers-card.tsx` (modify)
- `app/workspace/_components/top-dm-closers-card.tsx` (modify)
- `app/workspace/_components/overview-help-tooltip.tsx` (modify)

**How:**

```tsx
// Path: app/workspace/_components/top-dm-closers-card.tsx
<span className="font-semibold tabular-nums">
  {formatDecimal(row.bookedPerHour)}
</span>
<p className="truncate text-xs text-muted-foreground">
  {formatWholeNumber(row.booked)} booked - {formatDecimal(row.scheduledHours)}h scheduled
</p>
```

**Key implementation notes:**
- Use compact operational copy.
- Do not hide raw counts.
- Null rates must display as `--`, not `0`, because zero efficiency and unknown denominator mean different things.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/lead-gen-overview-card.tsx` | Modify | Leads/hr display |
| `app/workspace/_components/top-qualifiers-card.tsx` | Modify | Qualified/hr display |
| `app/workspace/_components/top-dm-closers-card.tsx` | Modify | Bookings/hr display |
| `app/workspace/_components/overview-help-tooltip.tsx` | Modify | Ranking explanation |

### 5B — Types and Formatters Sync

**Type:** Frontend  
**Parallelizable:** Yes — can run with 5A.

**What:** Update frontend overview types and formatter behavior for new nullable rate fields.

**Why:** Runtime payload and frontend type aliases must stay aligned with Convex return types.

**Where:**
- `app/workspace/_components/overview-dashboard-types.ts` (modify)
- `app/workspace/_components/overview-formatters.ts` (modify if null handling needs adjustment)

**How:**

```typescript
// Path: app/workspace/_components/overview-dashboard-types.ts
export type TopDmCloserRow = {
  dmCloserId: string;
  displayName: string;
  teamName: string | null;
  booked: number;
  scheduledHours: number;
  bookedPerHour: number | null;
};
```

**Key implementation notes:**
- Prefer importing generated Convex return types if existing code does so.
- Keep formatter output stable for `null`, `undefined`, and finite decimals.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/overview-dashboard-types.ts` | Modify | Efficiency fields |
| `app/workspace/_components/overview-formatters.ts` | Modify | Null/decimal formatting if needed |

### 5C — Role, Range, and Feature-Area QA

**Type:** QA  
**Parallelizable:** Yes — can run after Phase 4 is complete.

**What:** Verify admin-only access, dashboard ranges, and no adjacent surface regression.

**Why:** The blast radius includes dashboard cards, settings, Lead Gen reports, Slack reporting, and DM attribution.

**How:**

| Scenario | Expected Result |
|---|---|
| Tenant admin opens `/workspace` | Efficiency cards render with rates/counts/hours. |
| Closer opens `/workspace` | Existing redirect behavior remains unchanged. |
| Lead generator opens `/workspace` | Existing redirect behavior remains unchanged. |
| Admin opens `/workspace/settings?tab=schedules` | Schedule editors render. |
| Admin switches all existing settings tabs | Existing tabs still render. |
| Date range is Monday-Tuesday | Scheduled hours sum Monday plus Tuesday. |
| Date range is Sunday only | Sunday schedule is used, not Monday. |
| No schedule exists | Rate is null display and row sorts below configured actors. |
| Lead Gen Ops reports/exports | Existing report sort order remains quantity-first. |
| Slack qualification report | Existing totals and truncation behavior remain intact. |
| Operations phone sales report | Existing stats remain intact. |

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | QA only | Manual/browser verification |

### 5D — Convex Performance Audit

**Type:** Backend / QA  
**Parallelizable:** Yes — can run with 5C and 5E.

**What:** Verify final read sets, caps, aggregate behavior, and subscriptions.

**Why:** The dashboard is reactive; extra reads and broad query invalidations can become expensive.

**How:**

1. Inspect every new/modified Convex function for `.collect()`, `.filter()`, unbounded reads, and public `ctx.runQuery` composition.
2. Confirm all schedule reads use actor/tenant indexes and `.take()`.
3. Confirm Slack unique opportunity numerator uses aggregate counts where implemented.
4. Confirm DM closer booking scan keeps the existing cap.
5. Confirm expanded query is skipped while collapsed.
6. If available, run:

```bash
npx convex insights --details
```

**Pass criteria:**
- No unexpected high-read functions for the new schedule API or expanded query.
- No transaction limit warnings.
- No excessive subscription count from expanded cards.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | QA only | Convex inspection/insights |

### 5E — Browser and Accessibility QA

**Type:** Frontend / QA  
**Parallelizable:** Yes — can run with 5C and 5D.

**What:** Verify responsive behavior, skeleton stability, filter ergonomics, and accessibility.

**Why:** The expanded cards add dense tables into an existing dashboard grid. Layout shifts or overflow would make the dashboard harder to use.

**How:**

1. Test desktop and mobile viewports.
2. Confirm expanded content has stable max height and internal scrolling.
3. Confirm text does not overflow buttons, tabs, or table cells.
4. Confirm skeletons include `role="status"` and accessible labels.
5. Confirm table has caption or `aria-label`.
6. Confirm icons inside buttons use `data-icon`.
7. Confirm no card is nested inside another card.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | QA only | Browser verification |

### 5F — Schedule Coverage and Rollout Decision

**Type:** Manual / Release  
**Parallelizable:** No — final gate.

**What:** Populate production test tenant schedules and decide whether efficiency-first ranking is ready to expose.

**Why:** The schema is additive, but the user experience depends on schedule coverage.

**How:**

1. Enter Slack qualifier weekly schedules for expected production test tenant actors.
2. Enter DM closer weekly schedules for expected production test tenant actors.
3. Open `/workspace` for today, this week, and this month.
4. Check top cards for obviously wrong null-rate rows.
5. Decide:
   - ship efficiency-first ranking,
   - ship with visible missing-schedule context,
   - or temporarily keep old quantity-first ranking while schedules are completed.

**Rollback note:**
If the ranking is confusing, revert dashboard sorting/display changes only. Keep the additive schedule tables and settings UI.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | Manual | Production test tenant schedule setup |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/_components/lead-gen-overview-card.tsx` | Modify | 5A |
| `app/workspace/_components/top-qualifiers-card.tsx` | Modify | 5A |
| `app/workspace/_components/top-dm-closers-card.tsx` | Modify | 5A |
| `app/workspace/_components/overview-help-tooltip.tsx` | Modify | 5A |
| `app/workspace/_components/overview-dashboard-types.ts` | Modify | 5B |
| `app/workspace/_components/overview-formatters.ts` | Modify | 5B |
