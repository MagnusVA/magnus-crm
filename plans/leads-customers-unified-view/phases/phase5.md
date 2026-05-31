# Phase 5 — Verification and Rollout

**Goal:** Verify the unified workspace end to end, flip canonical navigation/internal links to `/workspace/leads-customers`, monitor projection/redirect behavior in the production test tenant, and keep a clear rollback path. After this phase, Leads & Customers is the primary user-facing browse/detail workspace while old URLs continue to redirect.

**Prerequisite:** Phases 1-4 are implemented. Phase 1 backfill and assertion pass in development. Phase 4 redirect QA passes for old list/detail/new routes. The production test tenant is the first rollout target.

**Runs in PARALLEL with:** Nothing at final enablement time. Subphase 5A documentation, 5B production-test projection verification, and 5C security QA can run concurrently before the navigation flip. 5D and 5E are sequential because they change what users see.

**Skills to invoke:**
- `convex-migration-helper` — use for production test tenant backfill/assertion and any projection repair run.
- `convex-performance-audit` — inspect search/detail read cost and projection write side effects before nav flips.
- `web-design-guidelines` — final accessibility, focus, overflow, mobile, and dark-mode audit.
- `frontend-design` — final polish of compact operational surfaces.
- `next-best-practices` — validate redirects, route shims, and RSC/client boundaries before release.

**Acceptance Criteria:**
1. Phase 1 projection backfill and assertion pass against the production test tenant.
2. `searchEntities`, `listEntities`, `getEntityDetail`, and redirect resolvers are manually verified against the sample-data matrix for admin and closer roles.
3. Old route redirects work from direct browser entry, internal links, and browser back/forward navigation without redirect loops.
4. Sidebar navigation replaces Leads, Customers, and Opportunities with one Leads & Customers item for admin and closer roles.
5. Command palette page entries and quick actions point to Leads & Customers and `/workspace/leads-customers/new-opportunity`.
6. Breadcrumbs show "Leads & Customers" and do not show raw route slugs for the new workspace.
7. Reports, operations, reminders, and other internal row links prefer the new lead-centric route when linking to a person; opportunity-specific links either use the new sheet URL or intentionally rely on verified redirects.
8. PostHog/client events, logs, and QA artifacts do not contain raw search terms, emails, phone numbers, handles, or payment references.
9. The rollback runbook can restore old nav/command links without deleting the derived projection table.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (final QA runbook) ───────────────┐
                                    ├── 5D (nav/command/breadcrumb flip) ─── 5E (production test rollout)
5B (projection prod-test verify) ───┤
                                    │
5C (security/perf/accessibility) ───┘

5E complete ─────────────────────────── 5F (monitoring + rollback evidence)
```

**Optimal execution:**
1. Run 5A, 5B, and 5C in parallel after Phase 4 QA passes.
2. Start 5D only after those gates are green; this is the visible navigation flip.
3. Run 5E in the production test tenant with monitoring open.
4. Complete 5F after collecting release evidence and confirming rollback steps.

**Estimated time:** 2-4 days

---

## Subphases

### 5A — Final QA Runbook and Scenario Matrix

**Type:** Manual / QA
**Parallelizable:** Yes — can run while projection production-test verification and security/performance checks proceed.

**What:** Consolidate Phase 2-4 QA into one final end-to-end runbook with concrete scenarios, roles, expected URLs, and pass/fail evidence.

**Why:** This feature changes canonical navigation, detail routes, and old URL behavior. Release needs one checklist that verifies the whole workflow, not separate phase notes.

**Where:**
- `plans/leads-customers-unified-view/release-qa-runbook.md` (new)
- `plans/leads-customers-unified-view/artifacts/sample-data-matrix.md` (read)
- `plans/leads-customers-unified-view/phase2-qa.md` (read)
- `plans/leads-customers-unified-view/phase3-qa.md` (read)
- `plans/leads-customers-unified-view/phase4-qa.md` (read)

**How:**

**Step 1: Create the runbook.**

```markdown
<!-- Path: plans/leads-customers-unified-view/release-qa-runbook.md -->

# Leads & Customers Unified View — Release QA Runbook

## Roles

| Role | Test account | Required checks |
|---|---|---|
| Tenant owner/admin | TBD | Full search/detail/sheet/payments/comments/redirect/nav checks |
| Closer assigned | TBD | Assigned opportunity sheet, meeting links, comments |
| Closer unassigned | TBD | Summary-only or unavailable opportunity behavior |
| Lead generator | TBD | Access denied/redirect from new route |

## Core Scenarios

| Scenario | Starting URL/input | Expected result | Admin | Closer |
|---|---|---|---|---|
| Search active lead by handle | `/workspace/leads-customers?q=<redacted>` | Lead row and detail load | TBD | TBD |
| Search customer by email | `/workspace/leads-customers?q=<redacted>` | Customer lifecycle strip | TBD | TBD |
| Direct opportunity ID | Search box or old URL | Entity detail with sheet open | TBD | TBD |
| Meeting link | Detail meeting row | New tab opens role-correct route | TBD | TBD |
| Legacy customer URL | `/workspace/customers/[id]` | Redirects to lead detail | TBD | TBD |
| Legacy opportunity URL | `/workspace/opportunities/[id]` | Redirects to lead detail + sheet | TBD | TBD |
| Merged lead URL | `/workspace/leads/[sourceId]` | Redirects to target lead | TBD | TBD |
| Mobile detail | 390 x 844 | No overlap or horizontal scroll | TBD | TBD |
```

**Step 2: Add release commands.**

```markdown
<!-- Path: plans/leads-customers-unified-view/release-qa-runbook.md -->

## Commands

- `pnpm tsc --noEmit`
- `pnpm lint`
- `npx convex dev --once`

## Browser Targets

- `/workspace/leads-customers`
- `/workspace/leads-customers/[leadId]`
- `/workspace/leads-customers/[leadId]?opportunityId=[opportunityId]`
- `/workspace/leads-customers/new-opportunity`
```

**Key implementation notes:**
- Keep raw PII out of the runbook. Use scenario labels and redacted IDs from the sample matrix.
- Capture failures with route, role, viewport, and section name.
- Do not flip nav before this runbook exists.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/release-qa-runbook.md` | Create | End-to-end release QA |

---

### 5B — Production Test Tenant Projection Verification

**Type:** Backend / Migration / Manual
**Parallelizable:** Yes — can run while UI/security QA proceeds, but must finish before navigation flips.

**What:** Run projection backfill/assertion in the production test tenant, verify sampled rows, and document monitoring expectations.

**Why:** The projection is derived and safe to rebuild, but the canonical browse route depends on it being complete and current.

**Where:**
- `plans/leads-customers-unified-view/projection-production-verification.md` (new)
- `convex/migrations.ts` (read/run)
- Convex logs and dashboard (read)

**How:**

**Step 1: Create production verification artifact.**

```markdown
<!-- Path: plans/leads-customers-unified-view/projection-production-verification.md -->

# Projection Production Test Tenant Verification

## Migration Commands

| Step | Command | Result | Notes |
|---|---|---|---|
| Backfill dry run | `npx convex run migrations:run '{"fn":"backfillLeadCustomerSearchRows","dryRun":true}'` | TBD |  |
| Backfill run | `npx convex run migrations:run '{"fn":"backfillLeadCustomerSearchRows"}'` | TBD |  |
| Assertion dry run | `npx convex run migrations:run '{"fn":"assertLeadCustomerSearchRowsBackfilled","dryRun":true}'` | TBD |  |
| Assertion run | `npx convex run migrations:run '{"fn":"assertLeadCustomerSearchRowsBackfilled"}'` | TBD |  |

## Sample Verification

| Scenario | Source state | Projection state | Result |
|---|---|---|---|
| Active lead | TBD | TBD | TBD |
| Converted customer | TBD | TBD | TBD |
| Merged lead | TBD | TBD | TBD |
| Opportunity direct lookup | TBD | TBD | TBD |
```

**Step 2: Verify logs and no PII.**

```markdown
<!-- Path: plans/leads-customers-unified-view/projection-production-verification.md -->

## Log Review

- [ ] `[LeadCustomers:Projection]` logs include tenant/lead IDs and counts only.
- [ ] No raw search terms are logged.
- [ ] No names, emails, phone numbers, handles, or payment references are logged.
- [ ] No repeated projection rebuild errors after normal writes.
```

**Step 3: Run spot-check queries.**

```bash
# Path: terminal
npx convex run leadCustomers/queries:listEntities '{"paginationOpts":{"numItems":25,"cursor":null},"lifecycle":"all"}'
npx convex run leadCustomers/queries:searchEntities '{"searchTerm":"<redacted-direct-id>"}'
```

**Key implementation notes:**
- If assertion fails, do not flip nav. Fix projection code, rerun backfill, then rerun assertion.
- Derived rows can remain in the schema during rollback.
- If write-hook rebuilds are noisy or conflict-prone, capture that as a Phase 1 follow-up before rollout.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/projection-production-verification.md` | Create | Backfill/assertion evidence |

---

### 5C — Security, Performance, Accessibility, and Analytics Audit

**Type:** Manual / Full-Stack QA
**Parallelizable:** Yes — can run before the visible nav flip.

**What:** Audit role access, query/read cost, UI accessibility, mobile behavior, dark mode, and analytics/logging constraints.

**Why:** The unified page exposes more data at once. Release must prove server-side guards and UI affordances agree.

**Where:**
- `plans/leads-customers-unified-view/release-audit.md` (new)
- `convex/leadCustomers/**` (read)
- `app/workspace/leads-customers/**` (read)
- PostHog/debug logs (read)

**How:**

**Step 1: Create audit checklist.**

```markdown
<!-- Path: plans/leads-customers-unified-view/release-audit.md -->

# Leads & Customers Unified View — Release Audit

## Security

- [ ] No public Convex function accepts `tenantId`, `userId`, or `role` as a client-controlled auth argument.
- [ ] Search/list/detail derive `tenantId` through `requireTenantUser`.
- [ ] Opportunity sheet uses existing `getOpportunityDetail` guard.
- [ ] Closer unassigned opportunity detail does not expose comments, payments, or actions.
- [ ] Redirect resolvers return `null` for cross-tenant or inaccessible records.

## Performance

- [ ] Search uses `search_lead_customer_entities`.
- [ ] Browse uses tenant-first indexes before pagination.
- [ ] Detail payload caps opportunities, meetings, comments, payments, and activity.
- [ ] No new unbounded `.collect()`.
- [ ] No database `.filter()` for tenant/filter constraints.

## UI / Accessibility

- [ ] Skeletons have `role="status"` and labels.
- [ ] Row links are real links.
- [ ] Keyboard focus is visible in toolbar, rows, sheet, and dialogs.
- [ ] Sheet closes with Escape and returns focus sensibly.
- [ ] Mobile has no horizontal scroll.
- [ ] Dark mode uses semantic tokens.

## Analytics / Logs

- [ ] No raw search term events.
- [ ] No PII in structured logs.
- [ ] PostHog events use counts, booleans, enums, or length buckets only.
```

**Step 2: Run automated checks.**

```bash
# Path: terminal
pnpm tsc --noEmit
pnpm lint
npx convex dev --once
```

**Key implementation notes:**
- Treat any access-control defect as release blocking.
- Treat visual overflow on core routes as release blocking for mobile.
- Performance concerns that are not release blocking should still be captured with function name and sample scenario.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/release-audit.md` | Create | Final security/perf/a11y audit |

---

### 5D — Sidebar, Command Palette, Breadcrumbs, and Internal Links

**Type:** Frontend / Rollout
**Parallelizable:** No — visible navigation should flip only after 5A, 5B, and 5C pass.

**What:** Replace visible Leads, Customers, and Opportunities entries with Leads & Customers, update quick actions, add breadcrumb labels, and migrate internal person/opportunity links where appropriate.

**Why:** The route is not canonical until users can find it from the shell, command palette, breadcrumbs, and high-traffic internal links.

**Where:**
- `app/workspace/_components/workspace-shell-client.tsx` (modify)
- `components/command-palette.tsx` (modify)
- `hooks/use-breadcrumbs.ts` (modify)
- `components/workspace-breadcrumbs.tsx` (read/modify only if dynamic overrides are needed)
- Reports/operations/reminders row link files found by `rg` (modify selectively)

**How:**

**Step 1: Replace sidebar entries.**

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx
import { ContactIcon } from "lucide-react";

const leadsCustomersNavItem: NavItem = {
  href: "/workspace/leads-customers",
  label: "Leads & Customers",
  icon: ContactIcon,
};

const adminNavItems: NavItem[] = [
  { href: "/workspace", label: "Overview", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/operations", label: "Operations", icon: KanbanIcon },
  { href: "/workspace/lead-gen", label: "Lead Gen", icon: ClipboardListIcon },
  leadsCustomersNavItem,
  { href: "/workspace/team", label: "Team", icon: UsersIcon },
  { href: "/workspace/settings", label: "Settings", icon: SettingsIcon },
];

const closerNavItems: NavItem[] = [
  { href: "/workspace/closer", label: "Dashboard", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/closer/pipeline", label: "My Pipeline", icon: KanbanIcon },
  leadsCustomersNavItem,
];
```

**Step 2: Update command palette pages and create action.**

```tsx
// Path: components/command-palette.tsx
const adminPages = [
  { label: "Overview", href: "/workspace", icon: LayoutDashboardIcon, shortcut: "1" },
  { label: "Operations", href: "/workspace/operations", icon: KanbanIcon, shortcut: "2" },
  { label: "Leads & Customers", href: "/workspace/leads-customers", icon: ContactIcon, shortcut: "3" },
  { label: "Lead Gen Ops", href: "/workspace/lead-gen", icon: ClipboardListIcon },
  { label: "Lead Gen Settings", href: "/workspace/lead-gen/settings", icon: SettingsIcon },
  { label: "Team", href: "/workspace/team", icon: UsersIcon },
  { label: "Settings", href: "/workspace/settings", icon: SettingsIcon },
];

const closerPages = [
  { label: "Dashboard", href: "/workspace/closer", icon: LayoutDashboardIcon, shortcut: "1" },
  { label: "My Pipeline", href: "/workspace/closer/pipeline", icon: KanbanIcon, shortcut: "2" },
  { label: "Leads & Customers", href: "/workspace/leads-customers", icon: ContactIcon, shortcut: "3" },
];

// Quick action:
<CommandItem onSelect={() => navigate("/workspace/leads-customers/new-opportunity")}>
  <PlusIcon />
  <span>Create opportunity</span>
</CommandItem>
```

**Step 3: Add breadcrumb labels.**

```typescript
// Path: hooks/use-breadcrumbs.ts
const SEGMENT_LABELS: Record<string, string> = {
  workspace: "Home",
  closer: "Dashboard",
  pipeline: "Pipeline",
  team: "Team",
  settings: "Settings",
  "lead-gen": "Lead Gen Ops",
  "leads-customers": "Leads & Customers",
  "new-opportunity": "New Side Deal",
  capture: "Capture",
  "my-activity": "My Activity",
  prospects: "Prospects",
  meetings: "Meetings",
  admin: "Admin",
};
```

**Step 4: Find and update high-traffic internal links.**

```bash
# Path: terminal
rg -n 'href=.*workspace/(leads|customers|opportunities)|router\\.push\\("/workspace/(leads|customers|opportunities)|/workspace/(leads|customers|opportunities)' app components hooks lib
```

Examples:

```tsx
// Path: app/workspace/operations/_components/qualification-table.tsx
<Link href={`/workspace/leads-customers/${row.leadId}`}>
  {row.leadName}
</Link>
```

```tsx
// Path: app/workspace/reports/pipeline/page.tsx
<Link href={`/workspace/leads-customers/${row.leadId}?opportunityId=${row.opportunityId}`}>
  Open Opportunity
</Link>
```

**Key implementation notes:**
- Do not update links blindly. If a report has only `opportunityId` and not `leadId`, leaving the old opportunity URL is acceptable because Phase 4 redirect is verified.
- Keep lead-generator navigation unchanged.
- If `ContactIcon` conflicts visually, choose another existing lucide icon once; do not reintroduce separate nav entries.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | Replace sidebar entries |
| `components/command-palette.tsx` | Modify | Replace page/action entries |
| `hooks/use-breadcrumbs.ts` | Modify | Add labels |
| `components/workspace-breadcrumbs.tsx` | Modify | Only if dynamic override support needs improvement |
| `app/workspace/operations/**` | Modify | High-traffic person/opportunity links where target IDs are available |
| `app/workspace/reports/**` | Modify | High-traffic report links where target IDs are available |
| `app/workspace/closer/**` | Modify | Only links that should leave closer-specific workflow |

---

### 5E — Production Test Tenant Rollout and Monitoring

**Type:** Release / Manual
**Parallelizable:** No — this is the visible rollout step.

**What:** Ship the nav/link flip to the production test tenant, monitor Convex logs, search/detail behavior, old redirects, and user-facing errors.

**Why:** The app has one test tenant on production. Rollout should be observable, reversible, and limited before broader cleanup.

**Where:**
- `plans/leads-customers-unified-view/production-rollout-log.md` (new)
- Convex logs/dashboard (read)
- Browser QA (manual)

**How:**

**Step 1: Create rollout log.**

```markdown
<!-- Path: plans/leads-customers-unified-view/production-rollout-log.md -->

# Leads & Customers Unified View — Production Test Tenant Rollout

## Pre-Flight

- [ ] Phase 1 projection assertion passed.
- [ ] Phase 4 redirects verified.
- [ ] Release QA runbook passed.
- [ ] Security/performance/accessibility audit passed.
- [ ] Rollback owner identified.

## Rollout

| Time | Action | Result |
|---|---|---|
| TBD | Deploy nav/link flip | TBD |
| TBD | Admin smoke test | TBD |
| TBD | Closer smoke test | TBD |
| TBD | Redirect smoke test | TBD |
| TBD | Convex logs review | TBD |

## Monitor For

- `[LeadCustomers:Projection]` errors.
- `getEntityDetail` null spikes for valid sample records.
- Redirect loops.
- User reports of missing opportunity/payment/comment data.
- Browser console errors on sheet open/close.
```

**Step 2: Run smoke checks immediately after deploy.**

```bash
# Path: terminal
pnpm tsc --noEmit
pnpm lint
```

Manual smoke checks:

- Admin sidebar shows Leads & Customers once.
- Closer sidebar shows Leads & Customers once.
- Command palette opens new route.
- Old customer and opportunity URLs redirect correctly.
- Search and detail load for sample active lead and converted customer.

**Key implementation notes:**
- Do not delete old route component files in this rollout. Redirect pages are the rollback buffer.
- If a critical issue appears, rollback nav/command/internal links first. Leave projection table and backfill code in place.
- Record exact times for monitoring windows.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/production-rollout-log.md` | Create | Rollout evidence |

---

### 5F — Rollback Runbook, Post-Release Evidence, and Follow-Ups

**Type:** Release / Manual
**Parallelizable:** No — follows rollout and monitoring.

**What:** Document rollback steps, post-release evidence, known gaps, and cleanup follow-ups.

**Why:** The feature intentionally keeps derived projection data and redirect shims. Cleanup/removal of legacy UI should happen only after stability is proven.

**Where:**
- `plans/leads-customers-unified-view/rollback-runbook.md` (new)
- `plans/leads-customers-unified-view/post-release-notes.md` (new)

**How:**

**Step 1: Create rollback runbook.**

```markdown
<!-- Path: plans/leads-customers-unified-view/rollback-runbook.md -->

# Leads & Customers Unified View — Rollback Runbook

## Fast Rollback

1. Restore sidebar entries for Leads, Customers, and Opportunities in `workspace-shell-client.tsx`.
2. Restore command palette entries and create opportunity action to old routes.
3. Leave `/workspace/leads-customers` route deployed but stop linking to it.
4. Leave `leadCustomerSearchRows` in schema; it is derived data and not source of truth.
5. Leave redirect shims only if verified safe; otherwise restore old route page components from git.

## Do Not Do

- Do not delete source lead/customer/opportunity/payment/meeting data.
- Do not drop `leadCustomerSearchRows` during fast rollback.
- Do not run destructive migrations.
```

**Step 2: Create post-release notes.**

```markdown
<!-- Path: plans/leads-customers-unified-view/post-release-notes.md -->

# Leads & Customers Unified View — Post-Release Notes

## Evidence

| Area | Result | Notes |
|---|---|---|
| Projection assertion | TBD |  |
| Admin smoke test | TBD |  |
| Closer smoke test | TBD |  |
| Redirect smoke test | TBD |  |
| Mobile smoke test | TBD |  |

## Follow-Ups

- Decide whether closer visibility should be tightened to assigned entities only.
- Decide when to remove legacy full-page opportunity UI.
- Decide whether full unified export needs a bounded server job.
- Decide whether payment reference search belongs in a separate feature.
```

**Step 3: Close the phase only after checks pass.**

```bash
# Path: terminal
pnpm tsc --noEmit
```

**Key implementation notes:**
- Post-release notes are not a substitute for issue tracking; create tickets for follow-ups that require code.
- Cleanup of old components/routes is intentionally deferred until after stable production use.
- If rollback happens, update `production-rollout-log.md` with cause and restored state.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/rollback-runbook.md` | Create | Rollback instructions |
| `plans/leads-customers-unified-view/post-release-notes.md` | Create | Evidence and follow-ups |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `plans/leads-customers-unified-view/release-qa-runbook.md` | Create | 5A |
| `plans/leads-customers-unified-view/projection-production-verification.md` | Create | 5B |
| `plans/leads-customers-unified-view/release-audit.md` | Create | 5C |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | 5D |
| `components/command-palette.tsx` | Modify | 5D |
| `hooks/use-breadcrumbs.ts` | Modify | 5D |
| `components/workspace-breadcrumbs.tsx` | Modify | 5D |
| `app/workspace/operations/**` | Modify | 5D |
| `app/workspace/reports/**` | Modify | 5D |
| `app/workspace/closer/**` | Modify | 5D |
| `plans/leads-customers-unified-view/production-rollout-log.md` | Create | 5E |
| `plans/leads-customers-unified-view/rollback-runbook.md` | Create | 5F |
| `plans/leads-customers-unified-view/post-release-notes.md` | Create | 5F |
