# Phase 0 — Current State Lock and UX Direction

**Goal:** Freeze the current Leads, Customers, and Opportunities behavior before implementation starts, then turn the design direction into concrete audit evidence and UI contracts. After this phase, implementers know which existing code is being reused, redirected, or retired, and the team has a baseline for rollback comparison.

**Prerequisite:** `plans/leads-customers-unified-view/leads-customers-unified-view-design.md` is accepted as the MVP scope. No schema, route, or navigation changes have shipped for this feature.

**Runs in PARALLEL with:** Nothing at the phase level — this is the shared foundation for all later phases. Within the phase, 0A, 0B, 0C, and 0D can run concurrently because they inspect different surfaces and only converge in 0E.

**Skills to invoke:**
- `frontend-design` — translate the compact executive ledger direction into implementation-ready UI rules.
- `web-design-guidelines` — review accessibility, focus, responsive overflow, and no-hidden-detail requirements before code starts.
- `next-best-practices` — validate route and App Router assumptions for later route shims and new pages.
- `convex-performance-audit` — only if the current-state audit exposes unexpectedly expensive list/detail reads that should influence Phase 1 caps.

**Acceptance Criteria:**
1. The team has a written inventory of current `/workspace/leads`, `/workspace/customers`, `/workspace/opportunities`, and `/workspace/opportunities/new` routes, including route gates, Convex functions, and UI components.
2. The audit identifies which current components are reused, replaced, or kept only as rollback references.
3. The UX lock document defines the compact executive ledger rules, including density, section hierarchy, no tab-hidden detail, no nested cards, mobile behavior, and dark-mode expectations.
4. The permission and PII contract states which data can appear for `tenant_master`, `tenant_admin`, `closer`, and `lead_generator`, and forbids logging raw search terms or identifiers.
5. The sample-data matrix covers at least one active lead, one converted customer, one side-deal opportunity, one Slack-qualified opportunity, one lead with multiple meetings, one lead with comments, and one merged lead.
6. Rollback expectations are documented: old routes and old nav can remain available until Phase 5 flips the canonical entry point.
7. Phase 1 implementers can start without rereading the design because open questions, component reuse decisions, and current-state gaps are captured in phase artifacts.
8. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
0A (route/code inventory) ───────────────┐
                                        ├── 0E (implementation readiness brief)
0B (data sample matrix) ────────────────┤
                                        │
0C (permissions + PII contract) ────────┤
                                        │
0D (UX/component direction lock) ───────┘

0E complete ─────────────────────────────── 0F (handoff checklist + phase gate)
```

**Optimal execution:**
1. Start 0A, 0B, 0C, and 0D together. They touch planning artifacts only and gather independent evidence.
2. Run 0E after those audits finish so the readiness brief can make explicit reuse/replace decisions.
3. Finish with 0F, which turns the evidence into a go/no-go checklist for Phase 1.

**Estimated time:** 1-2 days

---

## Subphases

### 0A — Route, Function, and Component Inventory

**Type:** Manual / Architecture
**Parallelizable:** Yes — independent from data sampling and UX work; it reads source files and writes a planning artifact only.

**What:** Create a current-state inventory of route files, permissions, Convex functions, and client components for the three legacy browse/detail experiences.

**Why:** The unified workspace replaces visible navigation and page composition, but Phase 4 still needs route shims and rollback confidence. Missing an old dependency here creates broken links later.

**Where:**
- `plans/leads-customers-unified-view/artifacts/current-state-inventory.md` (new)
- `app/workspace/leads/**` (read)
- `app/workspace/customers/**` (read)
- `app/workspace/opportunities/**` (read)
- `convex/leads/queries.ts` (read)
- `convex/customers/queries.ts` (read)
- `convex/opportunities/detailQuery.ts` (read)
- `convex/opportunities/listQueries.ts` (read)

**How:**

**Step 1: Capture the current file surface.**

```bash
# Path: terminal
find app/workspace/leads app/workspace/customers app/workspace/opportunities -maxdepth 4 -type f | sort
rg -n "requirePermission|useQuery|usePaginatedQuery|useMutation|fetchQuery|preloadQuery" app/workspace/leads app/workspace/customers app/workspace/opportunities
rg -n "export const (list|search|get|create|update|record|mark|delete)" convex/leads convex/customers convex/opportunities convex/closer convex/pipeline
```

**Step 2: Record route gates and data sources.**

```markdown
<!-- Path: plans/leads-customers-unified-view/artifacts/current-state-inventory.md -->

# Leads & Customers Unified View — Current State Inventory

## Route Inventory

| Route | Gate | Primary client | Convex APIs | Phase decision |
|---|---|---|---|---|
| `/workspace/leads` | `lead:view-all` | `LeadsPageClient` | `api.leads.queries.listLeads`, `api.leads.queries.searchLeads` | Replace with redirect in Phase 4. |
| `/workspace/leads/[leadId]` | `lead:view-all` | `LeadDetailPageClient` | `api.leads.queries.getLeadDetail` | Replace with redirect in Phase 4; keep merge child route. |
| `/workspace/customers` | `customer:view-own` or existing page gate | `CustomersPageClient` | `api.customers.queries.listCustomers` | Replace with redirect in Phase 4. |
| `/workspace/customers/[customerId]` | `customer:view-own` | `CustomerDetailPageClient` | `api.customers.queries.getCustomerDetail` | Resolve customer -> lead route in Phase 4. |
| `/workspace/opportunities` | `pipeline:view-own` | `OpportunitiesPageClient` | `api.opportunities.listQueries.*` | Replace with redirect in Phase 4. |
| `/workspace/opportunities/[opportunityId]` | `pipeline:view-own` | `OpportunityDetailClient` | `api.opportunities.detailQuery.getOpportunityDetail` | Reuse payload in sheet; redirect route in Phase 4. |
| `/workspace/opportunities/new` | `pipeline:view-own` | `CreateOpportunityPageClient` | `api.opportunities.createManual.*` | Move/copy under `/workspace/leads-customers/new-opportunity`. |
```

**Step 3: Mark reuse, replacement, and rollback files.**

```markdown
<!-- Path: plans/leads-customers-unified-view/artifacts/current-state-inventory.md -->

## Reuse Decisions

| Existing asset | Decision | Reason |
|---|---|---|
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-meetings-list.tsx` | Reuse or extract to shared section if density fits. | The sheet needs the same meeting semantics. |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-payments-list.tsx` | Reuse or extract. | Payment actions must keep existing guards. |
| `app/workspace/_components/entity-attribution-card.tsx` | Reuse data mapping; redesign display density. | Attribution model is already available. |
| `app/workspace/leads/[leadId]/_components/tabs/*` | Reference only. | Detail content must be visible on-page, not tab-gated. |
| `app/workspace/customers/[customerId]/_components/payment-history-table.tsx` | Reuse table patterns if compact enough. | Customer payment history remains required. |
```

**Key implementation notes:**
- Inventory route gates from source files, not assumptions from the design.
- Record old route behavior even if it looks redundant; Phase 4 redirects must preserve browser history and report links.
- Mark uncertain reuse as "extract candidate" instead of committing to a refactor in Phase 0.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/artifacts/current-state-inventory.md` | Create | Route, function, and component baseline |

---

### 0B — Sample Data and Edge Case Matrix

**Type:** Manual / QA
**Parallelizable:** Yes — it can run while 0A inventories code and 0D locks UX.

**What:** Identify and document real or test-tenant records that exercise every required lead/customer/opportunity state before the new projection is built.

**Why:** Phase 1 and Phase 5 need known records to verify projection backfill, search results, redirects, comments, payment summaries, and role-specific access.

**Where:**
- `plans/leads-customers-unified-view/artifacts/sample-data-matrix.md` (new)
- Convex dashboard or `npx convex data` output (read-only)
- `TESTING.MD` (read)

**How:**

**Step 1: Create the sample matrix skeleton.**

```markdown
<!-- Path: plans/leads-customers-unified-view/artifacts/sample-data-matrix.md -->

# Leads & Customers Unified View — Sample Data Matrix

| Scenario | Lead ID | Customer ID | Opportunity ID | Meeting ID | Viewer role | Expected behavior |
|---|---|---|---|---|---|---|
| Active lead by social handle | TBD | N/A | TBD | TBD | Admin + closer | Search returns one lead row; detail shows opportunities and fields. |
| Converted customer by email | TBD | TBD | TBD | TBD | Admin + closer | Search returns customer lifecycle; detail shows customer strip and payments. |
| Opportunity ID direct lookup | TBD | N/A/TBD | TBD | TBD | Admin | Search result carries selected opportunity; detail opens sheet. |
| Meeting comments inline | TBD | N/A/TBD | TBD | TBD | Assigned closer | Detail shows active comments only. |
| Merged lead legacy route | Source TBD, target TBD | N/A | TBD | N/A | Admin | Source legacy route redirects to target lead. |
| Unassigned opportunity for closer | TBD | N/A/TBD | TBD | TBD | Closer | Summary-only context; no sheet/comments/payments if guard denies. |
```

**Step 2: Gather record IDs without dumping PII into the plan.**

```bash
# Path: terminal
npx convex data leads --limit 20
npx convex data customers --limit 20
npx convex data opportunities --limit 20
npx convex data meetings --limit 20
npx convex data meetingComments --limit 20
```

**Step 3: Add redacted evidence only.**

```markdown
<!-- Path: plans/leads-customers-unified-view/artifacts/sample-data-matrix.md -->

## Redaction Rule

Do not paste names, emails, phone numbers, social handles, raw search terms, or payment references into this plan. Store only Convex IDs, scenario labels, lifecycle state, role, and expected result.
```

**Key implementation notes:**
- Prefer production test-tenant records if available; otherwise note which fixtures must be created before Phase 5 QA.
- Keep raw PII out of plans, PostHog, console logs, and screenshots.
- Capture assigned closer context for any closer QA scenario; the new entity view must not accidentally grant opportunity detail access.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/artifacts/sample-data-matrix.md` | Create | Redacted test-record matrix |

---

### 0C — Permission, PII, and Logging Contract

**Type:** Security / Manual
**Parallelizable:** Yes — depends only on existing permission definitions and design decisions.

**What:** Write the access and logging contract that all later Convex and UI work must follow.

**Why:** The new page consolidates data that was previously spread across multiple screens. Without a clear contract, a closer could see comments/payments/opportunity actions the existing guards would deny.

**Where:**
- `plans/leads-customers-unified-view/artifacts/security-contract.md` (new)
- `convex/lib/permissions.ts` (read)
- `convex/requireTenantUser.ts` (read)
- `lib/auth.ts` (read)

**How:**

**Step 1: Document server-side gates.**

```markdown
<!-- Path: plans/leads-customers-unified-view/artifacts/security-contract.md -->

# Leads & Customers Unified View — Security Contract

## Route Gates

| Surface | Route gate | Convex guard |
|---|---|---|
| Search/list | `requirePermission("lead:view-all")` | `requireTenantUser(ctx, ["tenant_master", "tenant_admin", "closer"])` |
| Entity detail | `requirePermission("lead:view-all")` | Same tenant check plus per-related-record permission metadata |
| Opportunity sheet | `requirePermission("pipeline:view-own")` or parent route access | Existing `api.opportunities.detailQuery.getOpportunityDetail` guard |
| Meeting links | Existing meeting route gate | Existing admin/closer meeting detail guards |
| New side deal | `requirePermission("pipeline:view-own")` | Existing create manual opportunity guard |
```

**Step 2: Define closer data rules.**

```markdown
<!-- Path: plans/leads-customers-unified-view/artifacts/security-contract.md -->

## Closer Rule

Broad person lookup can remain consistent with current Leads/Customers behavior for MVP, but related records must be permission-aware:

| Related record | Assigned to viewer | Not assigned to viewer |
|---|---|---|
| Opportunity row | Full summary and Details action | Summary-only row, no Details action if backend would deny |
| Meeting row | Link to closer meeting route, active comments visible | No comments and no meeting detail link unless existing guard allows it |
| Payment row | Visible only if existing customer/payment access allows it | Hidden or aggregate-only |
```

**Step 3: Lock logging and analytics constraints.**

```typescript
// Path: app/workspace/leads-customers/_components/use-leads-customers-analytics.ts
import posthog from "posthog-js";

export function captureLeadCustomerSearchSubmitted(input: {
  hasQuery: boolean;
  queryLengthBucket: "0" | "1" | "2-4" | "5-10" | "11+";
  lifecycle: "all" | "lead" | "customer";
}) {
  posthog.capture("leads_customers_search_submitted", input);
}
```

**Key implementation notes:**
- Analytics can record booleans, enum filters, counts, capped flags, and length buckets; never raw query text, email, phone, handle, ID, or payment references.
- The entity detail query should return `permissions` metadata per opportunity/meeting rather than letting UI infer access from role alone.
- Redirect resolvers must return `null` instead of throwing distinguishable tenant-leak errors for cross-tenant IDs.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/artifacts/security-contract.md` | Create | Permission, role, and logging contract |

---

### 0D — UX Direction and Component Reuse Lock

**Type:** Frontend / Design
**Parallelizable:** Yes — independent from backend and sample-data work.

**What:** Convert the design's compact executive ledger direction into a short UI contract, including density, component choices, and what must not be hidden behind tabs.

**Why:** Phase 2 and Phase 3 can run faster if teams agree on layout primitives before building separate list/detail surfaces.

**Where:**
- `plans/leads-customers-unified-view/artifacts/ux-direction-lock.md` (new)
- `components/ui/*` (read)
- `app/workspace/_components/entity-attribution-card.tsx` (read)
- `app/workspace/opportunities/[opportunityId]/_components/*` (read)

**How:**

**Step 1: Write the density and component rules.**

```markdown
<!-- Path: plans/leads-customers-unified-view/artifacts/ux-direction-lock.md -->

# Leads & Customers Unified View — UX Direction Lock

## Visual Contract

- Use the existing Tailwind 4 and `radix-nova` semantic tokens.
- Prefer full-width sections with hairline separators over nested cards.
- Use `Table` for desktop browse results and compact row/cards for mobile.
- Use `Badge` sparingly for lifecycle, customer status, opportunity status, and permission-limited rows.
- Use `SheetContent side="left"` for opportunity detail.
- Use icons from `lucide-react` inside buttons: search, plus, external link, filter, download, panel open.
- Do not hide detail data behind tabs. Anchor links and filter tabs are allowed.
- Use `role="status"` and `aria-label` for loading states.
```

**Step 2: Define the section order and reusable primitives.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-detail.tsx
"use client";

export function EntityDetailFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
      {children}
    </div>
  );
}
```

**Step 3: Define responsive expectations.**

```css
/* Path: app/workspace/leads-customers/_components/leads-customers-layout.css */
/* If component-local CSS is needed, keep it focused on fixed-format layouts. */
.leads-customers-result-grid {
  grid-template-columns: minmax(14rem, 1.6fr) minmax(8rem, 0.8fr) minmax(12rem, 1fr) minmax(8rem, 0.7fr);
}
```

**Key implementation notes:**
- The actual implementation should prefer Tailwind classes; component CSS is only acceptable for fixed-format responsive grids that are awkward in utilities.
- Keep cards at small radius if used for individual repeated items; do not place UI cards inside UI cards.
- Every row action must be a `Link` or `Button asChild` so Cmd/Ctrl-click and middle-click work.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/artifacts/ux-direction-lock.md` | Create | UI rules and component reuse decisions |

---

### 0E — Implementation Readiness Brief

**Type:** Architecture / Manual
**Parallelizable:** No — depends on 0A through 0D.

**What:** Combine the inventories into a readiness brief with explicit phase dependencies, open decisions, and known risks.

**Why:** This is the last chance to prevent Phase 1 from drifting into UI work or Phase 2 from depending on unstable backend contracts.

**Where:**
- `plans/leads-customers-unified-view/artifacts/implementation-readiness.md` (new)
- `plans/leads-customers-unified-view/artifacts/current-state-inventory.md` (read)
- `plans/leads-customers-unified-view/artifacts/sample-data-matrix.md` (read)
- `plans/leads-customers-unified-view/artifacts/security-contract.md` (read)
- `plans/leads-customers-unified-view/artifacts/ux-direction-lock.md` (read)

**How:**

**Step 1: Summarize blocking decisions.**

```markdown
<!-- Path: plans/leads-customers-unified-view/artifacts/implementation-readiness.md -->

# Leads & Customers Unified View — Implementation Readiness

## Phase Gate

| Gate | Required state | Owner |
|---|---|---|
| Current route behavior captured | `artifacts/current-state-inventory.md` complete | Phase 0 |
| Redacted QA IDs available | `artifacts/sample-data-matrix.md` complete or fixture gaps listed | Phase 0 |
| Security rules accepted | `artifacts/security-contract.md` complete | Phase 0 |
| UX rules accepted | `artifacts/ux-direction-lock.md` complete | Phase 0 |

## Start Conditions For Phase 1

- `leadCustomerSearchRows` is accepted as derived data, not source of truth.
- Migration/backfill will use `@convex-dev/migrations`, not ad hoc `.collect()` loops.
- Old routes remain intact until redirects are implemented and verified.
```

**Step 2: Document open questions that must not block MVP.**

```markdown
<!-- Path: plans/leads-customers-unified-view/artifacts/implementation-readiness.md -->

## MVP Non-Blocking Questions

| Question | MVP decision | Follow-up |
|---|---|---|
| Tighten closer visibility to assigned entities only? | No; preserve current broad person lookup, but restrict related detail/actions. | Product decision after launch. |
| Full comment search? | No; comments render inline but are not globally indexed. | Separate search feature. |
| Full unified export? | No; export currently loaded rows only for admins. | Server export job later if needed. |
```

**Key implementation notes:**
- Do not let open questions become hidden implementation choices; write the MVP default and deferred follow-up.
- Keep this brief short enough to be read at the start of every later phase.
- Any schema or data concern found here moves into Phase 1, not Phase 2+.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/artifacts/implementation-readiness.md` | Create | Phase 1 start gate |

---

### 0F — Handoff Checklist and Phase Gate

**Type:** Manual / QA
**Parallelizable:** No — runs after 0E and closes Phase 0.

**What:** Produce a short go/no-go checklist that marks Phase 0 complete and lists exact commands or manual checks used.

**Why:** Later phases depend on Phase 0 as a stable foundation. The handoff prevents rediscovering current-state behavior during implementation.

**Where:**
- `plans/leads-customers-unified-view/artifacts/phase0-handoff.md` (new)

**How:**

**Step 1: Create the handoff checklist.**

```markdown
<!-- Path: plans/leads-customers-unified-view/artifacts/phase0-handoff.md -->

# Phase 0 Handoff — Leads & Customers Unified View

## Required Artifacts

- [ ] `artifacts/current-state-inventory.md`
- [ ] `artifacts/sample-data-matrix.md`
- [ ] `artifacts/security-contract.md`
- [ ] `artifacts/ux-direction-lock.md`
- [ ] `artifacts/implementation-readiness.md`

## Verification Commands

- `pnpm tsc --noEmit`

## Go / No-Go

| Item | Status | Notes |
|---|---|---|
| Phase 1 schema/backfill can begin | TBD |  |
| Production test tenant records identified | TBD |  |
| Rollback route strategy accepted | TBD |  |
```

**Step 2: Attach the command result summary.**

```markdown
<!-- Path: plans/leads-customers-unified-view/artifacts/phase0-handoff.md -->

## Command Results

| Command | Result | Notes |
|---|---|---|
| `pnpm tsc --noEmit` | TBD | Must pass before Phase 1 edits begin. |
```

**Key implementation notes:**
- This file is not a release note; it is a phase gate.
- If any required artifact is incomplete, Phase 1 can still do exploratory reading but should not modify Convex schema yet.
- Keep the final `pnpm tsc --noEmit` output summarized, not pasted wholesale.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/artifacts/phase0-handoff.md` | Create | Phase closeout and Phase 1 gate |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `plans/leads-customers-unified-view/artifacts/current-state-inventory.md` | Create | 0A |
| `plans/leads-customers-unified-view/artifacts/sample-data-matrix.md` | Create | 0B |
| `plans/leads-customers-unified-view/artifacts/security-contract.md` | Create | 0C |
| `plans/leads-customers-unified-view/artifacts/ux-direction-lock.md` | Create | 0D |
| `plans/leads-customers-unified-view/artifacts/implementation-readiness.md` | Create | 0E |
| `plans/leads-customers-unified-view/artifacts/phase0-handoff.md` | Create | 0F |
