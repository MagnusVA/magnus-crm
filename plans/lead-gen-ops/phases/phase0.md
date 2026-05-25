# Phase 0 — Scope, Blast Radius, and Migration Guardrails

**Goal:** Lock the Lead Gen Ops implementation boundaries before any schema, auth, Slack, Calendly, or UI code lands. After this phase, the team has a deployment order, role/config preflight, file ownership map, and QA matrix that keeps Lead Gen Ops separate from the CRM funnel.

**Prerequisite:** `plans/lead-gen-ops/lead-gen-ops-design.md` is accepted as the source of truth. No WorkOS `lead-generator` invites have been sent in dev or production.

**Runs in PARALLEL with:** Nothing — every implementation phase depends on the role, migration, and blast-radius decisions in this foundation phase.

**Skills to invoke:**
- `convex-migration-helper` — confirm the MVP is widen-only and identify when `@convex-dev/migrations` becomes required.
- `workos` — verify role-slug setup and membership-role update edge cases.
- `convex-dev-workos-authkit` — confirm AuthKit identity, invite claiming, and user lifecycle sync implications.
- `next-best-practices` — keep route gates as Server Components and preserve existing streaming conventions.
- `frontend-design` — set the UX bar for mobile capture and desktop admin surfaces before implementation starts.
- `web-design-guidelines` — audit responsive, accessible form/table patterns during later UI phases.

**Acceptance Criteria:**
1. The WorkOS `lead-generator` role slug has a documented dev/prod setup checklist before any invite path exposes the role.
2. The migration plan explicitly classifies MVP changes as widen-only: one `users.role` union expansion and new `leadGen*` tables.
3. A blocker is recorded requiring `convex-migration-helper` if implementation converts existing users, adds required fields to existing tables, or reshapes CRM data.
4. A blast-radius checklist identifies every forbidden write to `leads` and `opportunities` from Lead Gen Ops capture code.
5. Slack integration scope is limited to `convex/slack/createQualifiedLead.ts` plus a new internal Lead Gen audit helper.
6. Calendly integration scope is limited to preserving an existing audit match in `convex/pipeline/inviteeCreated.ts`; cold-booking lookup is explicitly forbidden.
7. Route, sidebar, command palette, keyboard shortcut, and breadcrumb assumptions for non-admin users are inventoried before `lead_generator` can sign in.
8. QA scenarios cover mobile capture, admin reporting, worker role transitions, Slack duplicate paths, Calendly cold bookings, and export hardening.
9. The file ownership boundaries in `parallelization-strategy.md` are accepted before multiple agents start implementation.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
0A (Scope lock) ─────────────┬── 0C (WorkOS/RBAC preflight) ─────┐
                             ├── 0D (Route blast-radius audit) ─┤
0B (Migration guardrails) ───┤                                    ├── 0F (Execution gates)
                             └── 0E (QA matrix) ─────────────────┘
```

**Optimal execution:**
1. Run 0A and 0B first because they define what implementation is allowed to change.
2. Run 0C, 0D, and 0E in parallel; they inspect different systems and produce independent checklists.
3. Finish with 0F, folding the outputs into the phase plans and parallelization strategy.

**Estimated time:** 0.5 day

---

## Subphases

### 0A — Scope Lock and Forbidden Change Register

**Type:** Manual / Planning  
**Parallelizable:** No — this is the root contract for every other subphase.

**What:** Create the implementation checklist that repeats the design's non-negotiable boundaries: no Lead Gen capture writes to CRM funnel tables, no Slack modal redesign, no Calendly cold-booking prospect lookup, and no worker self-selection.

**Why:** Lead Gen Ops is operational capture, not qualification. If implementers blur that boundary, reporting, attribution, opportunity lifecycle, and compensation assumptions become unreliable.

**Where:**
- `plans/lead-gen-ops/phases/phase0-implementation-checklist.md` (new)
- `plans/lead-gen-ops/lead-gen-ops-design.md` (read-only source)

**How:**

**Step 1: Add the checklist skeleton.**

```markdown
<!-- Path: plans/lead-gen-ops/phases/phase0-implementation-checklist.md -->

# Lead Gen Ops Implementation Checklist

## Forbidden Changes

- [ ] No Lead Gen capture mutation inserts or patches `leads`.
- [ ] No Lead Gen capture mutation inserts or patches `opportunities`.
- [ ] No Slack slash command, modal callback, or ACK timing changes.
- [ ] No Calendly webhook HTTP route, signature verification, raw event storage, or broad processor reordering changes.
- [ ] No Calendly cold-booking lookup against `leadGenProspects`.
- [ ] No `lead_generator` fallback into closer/admin route sets.

## Allowed Integration Points

- [ ] `convex/slack/createQualifiedLead.ts` may schedule an internal audit-match mutation after successful qualification.
- [ ] `convex/pipeline/inviteeCreated.ts` may preserve an accepted audit match after it joins a Slack-qualified opportunity.
- [ ] `app/workspace/page.tsx` may redirect `lead_generator` users to `/workspace/lead-gen/capture`.
```

**Step 2: Require the checklist in implementation PRs.**

````markdown
<!-- Path: plans/lead-gen-ops/phases/phase0-implementation-checklist.md -->

## PR Verification

Before merge, paste these command results into the PR:

```bash
rg "ctx\\.db\\.(insert|patch|replace)\\(\\\"(leads|opportunities)\\\"" convex/leadGen
rg "leadGen" convex/slack convex/pipeline
rg "lead_generator|lead-generator|lead-gen" app components convex lib
```
````

**Key implementation notes:**
- The checklist is deliberately blunt. It should catch accidental CRM-funnel coupling before code review has to infer intent.
- `rg` results should be empty for Lead Gen writes to CRM funnel tables; audit matching can read CRM records and write only `leadGenAuditMatches`.
- Keep the checklist separate from the design so implementation PRs can link directly to a compact gate.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/lead-gen-ops/phases/phase0-implementation-checklist.md` | Create | PR-ready blast-radius checklist |

---

### 0B — Migration Classification and Deployment Order

**Type:** Backend / Migration Planning  
**Parallelizable:** Yes — depends on 0A scope, but can run alongside route and QA inventory.

**What:** Record the safe deployment order for the role union, new tables, and external WorkOS role slug. Identify the exact changes that would turn this into a true data migration.

**Why:** Production has one test tenant, but Convex schema validation still rejects incompatible data-at-rest changes. The MVP must deploy as a widen-only change unless implementation scope expands.

**Where:**
- `plans/lead-gen-ops/phases/phase0-migration-notes.md` (new)
- `convex/schema.ts` (read-only during Phase 0)
- `convex/lib/roleMapping.ts` (read-only during Phase 0)

**How:**

**Step 1: Create migration notes with the widen-only contract.**

```markdown
<!-- Path: plans/lead-gen-ops/phases/phase0-migration-notes.md -->

# Lead Gen Ops Migration Notes

## MVP Classification

This rollout is widen-only if implementation only:

1. Adds `lead_generator` to the existing `users.role` validator.
2. Adds `lead-generator` to the WorkOS role mapping helpers.
3. Adds new `leadGen*` tables and indexes.
4. Adds new permission literals.

No `@convex-dev/migrations` job is required for those changes because existing
`users` documents remain valid and the new tables start empty.

## Required Deployment Order

1. Create WorkOS role slug `lead-generator` in dev and production.
2. Deploy schema/role/permission widening and new `leadGen*` tables.
3. Deploy workspace route/nav/command-palette handling for `lead_generator`.
4. Deploy admin invite/role-edit UI that exposes `lead_generator`.
5. Invite real lead-gen workers only after route guards are live.
```

**Step 2: Document migration escalation triggers.**

```markdown
<!-- Path: plans/lead-gen-ops/phases/phase0-migration-notes.md -->

## Escalation Triggers

Use the `convex-migration-helper` widen-migrate-narrow workflow before production
if implementation later:

- Converts existing `closer` users to `lead_generator` automatically.
- Adds required fields to existing tables.
- Renames or deletes existing `users`, `leads`, `opportunities`, or reporting fields.
- Splits existing team/schedule data into Lead Gen Ops tables.
- Backfills historical Slack or Calendly records into Lead Gen Ops.
```

**Key implementation notes:**
- WorkOS role creation is external configuration, not an env var. It still blocks inviting workers.
- Do not add a migration component job "just in case." Add it only when a breaking or backfill change actually exists.
- Any auto-conversion of users must be a separate planned migration, not a side effect of Phase 1.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/lead-gen-ops/phases/phase0-migration-notes.md` | Create | Widen-only deployment and escalation rules |

---

### 0C — WorkOS and RBAC Preflight

**Type:** Config / Backend Planning  
**Parallelizable:** Yes — depends on 0A, independent from route and QA inventory.

**What:** Verify the new WorkOS role slug, CRM role mapping, permission literals, and user lifecycle paths that must sync `leadGenWorkers`.

**Why:** Current validators and role helpers only know `tenant_master`, `tenant_admin`, and `closer`. A `lead_generator` user must not be invited until WorkOS, Convex, and routing all agree on the role.

**Where:**
- `convex/lib/roleMapping.ts` (modify in Phase 1)
- `convex/lib/permissions.ts` (modify in Phase 1)
- `convex/workos/userManagement.ts` (modify in Phase 1)
- `convex/workos/userMutations.ts` (modify in Phase 1)
- `app/workspace/team/_components/invite-user-dialog.tsx` (modify in Phase 1)
- `app/workspace/team/_components/role-edit-dialog.tsx` (modify in Phase 1)

**How:**

**Step 1: Record the role-contract audit.**

```markdown
<!-- Path: plans/lead-gen-ops/phases/phase0-implementation-checklist.md -->

## WorkOS and RBAC Preflight

- [ ] WorkOS environment role exists with slug `lead-generator`.
- [ ] `mapCrmRoleToWorkosSlug("lead_generator")` returns `lead-generator`.
- [ ] `mapWorkosSlugToCrmRole("lead-generator")` returns `lead_generator`.
- [ ] `ADMIN_ROLES` remains only `tenant_master` and `tenant_admin`.
- [ ] `lead_generator` is not allowed for CRM pipeline, meeting, payment, customer, or report permissions.
- [ ] Invite action accepts `lead_generator` without a Calendly member.
- [ ] Role-change action deactivates worker profile when changing away from `lead_generator`.
- [ ] Remove-user action deactivates worker profile and preserves historical submissions.
```

**Step 2: Identify every role validator to widen.**

```bash
# Path: terminal
rg "tenant_admin|closer|tenant_master" convex/workos convex/lib app/workspace/team components/auth lib/auth.ts
```

**Key implementation notes:**
- WorkOS role assignment uses the organization membership ID, not the user ID. The current code already follows this with `listOrganizationMemberships()` then `updateOrganizationMembership()`.
- If IdP role mapping exists later, WorkOS API role updates may be overwritten on next login; keep this documented for production setup.
- The app still uses CRM role data as the authoritative authorization source until the future WorkOS-permission migration noted in `lib/auth.ts`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/lead-gen-ops/phases/phase0-implementation-checklist.md` | Modify | Add WorkOS/RBAC preflight checks |

---

### 0D — Workspace Route and Shell Blast-Radius Inventory

**Type:** Frontend / Auth Planning  
**Parallelizable:** Yes — depends on 0A, independent from WorkOS config.

**What:** Inventory every existing non-admin fallback that currently assumes "not admin means closer" and mark it as a Phase 1 blocker.

**Why:** The current shell uses `isAdmin ? adminNavItems : closerNavItems`, and the command palette follows the same pattern. Without a dedicated `lead_generator` branch, workers can see or navigate into CRM workflows they should not use.

**Where:**
- `app/workspace/page.tsx` (modify in Phase 1)
- `app/workspace/_components/workspace-shell-client.tsx` (modify in Phase 1)
- `components/command-palette.tsx` (modify in Phase 1)
- `components/workspace-breadcrumbs.tsx` (modify in Phase 1)
- `hooks/use-keyboard-shortcut.ts` (read-only unless shortcuts are centralized)
- `lib/auth.ts` (modify in Phase 1)

**How:**

**Step 1: Add the route audit list.**

```markdown
<!-- Path: plans/lead-gen-ops/phases/phase0-implementation-checklist.md -->

## Route and Navigation Audit

- [ ] `/workspace` redirects `lead_generator` to `/workspace/lead-gen/capture`.
- [ ] `requireRole()` fallback handles `lead_generator` separately from closer.
- [ ] `requirePermission()` exists before Lead Gen pages use permission slugs.
- [ ] Sidebar has a dedicated Lead Gen nav set.
- [ ] Brand/home link sends `lead_generator` to capture, not closer dashboard.
- [ ] Command palette pages and quick actions use role-specific lists.
- [ ] Cmd+1-4 shortcuts use the active role nav list.
- [ ] Breadcrumb labels include `lead-gen`, `capture`, `my-activity`, and `prospects`.
- [ ] Direct admin and closer URLs redirect through server route gates.
```

**Step 2: Verify page wrappers stay thin RSCs.**

```tsx
// Path: app/workspace/lead-gen/capture/page.tsx
import { requirePermission } from "@/lib/auth";
import { LeadGenCapturePageClient } from "../_components/lead-gen-capture-page-client";

export const unstable_instant = false;

export default async function LeadGenCapturePage() {
  await requirePermission("lead-gen:capture");
  return <LeadGenCapturePageClient />;
}
```

**Key implementation notes:**
- Route authorization belongs in RSC wrappers and Convex functions. Sidebar visibility is a convenience only.
- Keep `"use client"` out of page files unless there is no alternative; existing workspace pages use thin RSC wrappers around `*-page-client` components.
- Use `redirect()` from `next/navigation` outside `try/catch` blocks because it throws by design.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/lead-gen-ops/phases/phase0-implementation-checklist.md` | Modify | Add route/nav audit list |

---

### 0E — QA Matrix and Seed Data Plan

**Type:** QA / Planning  
**Parallelizable:** Yes — depends on 0A, can run with 0C and 0D.

**What:** Create a QA matrix that covers the new Lead Gen Ops flows and protects existing Slack, Calendly, and CRM behavior.

**Why:** This feature intentionally touches auth, user roles, high-volume capture, reporting, Slack qualification, Calendly scheduling, and CSV export safety. Manual QA needs to be explicit before release pressure arrives.

**Where:**
- `plans/lead-gen-ops/phases/phase0-qa-matrix.md` (new)

**How:**

**Step 1: Create the QA matrix with observable scenarios.**

```markdown
<!-- Path: plans/lead-gen-ops/phases/phase0-qa-matrix.md -->

# Lead Gen Ops QA Matrix

| Area | Scenario | Expected Result |
|---|---|---|
| Auth | `lead_generator` opens `/workspace` | Redirects to `/workspace/lead-gen/capture`. |
| Auth | `lead_generator` opens `/workspace/pipeline` | Server redirects to capture; Convex rejects direct admin calls. |
| Capture | Worker submits new Instagram handle | New prospect and submission; no CRM lead/opportunity. |
| Capture | Same worker retries with same `clientSubmissionKey` | Existing submission returned; counters unchanged. |
| Dedupe | Two workers submit same normalized handle | One prospect, two submissions, distinct worker count increments. |
| Reporting | Admin date filter spans multiple sources | Scheduled hours are deduped by `(workerId, dayKey)`. |
| Slack | Duplicate-pending qualification with prior prospect | Existing Slack behavior remains; accepted audit match is reused or created. |
| Calendly | Cold booking matches lead-gen prospect handle | Existing cold-booking behavior; no Lead Gen lookup or audit match. |
| Export | Formula-like origin label is exported | CSV cell is escaped and formula-hardened. |
```

**Step 2: Add seed data requirements.**

```markdown
<!-- Path: plans/lead-gen-ops/phases/phase0-qa-matrix.md -->

## Seed Requirements

- One tenant owner/admin.
- One closer with Calendly member assignment.
- Two lead-generator users, one active and one pending invitation.
- Two Lead Gen teams.
- At least one shared prospect submitted by both workers.
- At least one Slack-qualified lead with a matching Instagram handle.
- One cold Calendly booking with the same handle to prove no Lead Gen lookup occurs.
```

**Key implementation notes:**
- Keep QA pass/fail phrased as user-observable behavior or database state, not implementation guesses.
- Include negative authorization tests for direct Convex calls from unauthorized roles.
- Run mobile capture QA on a narrow viewport and admin reports on desktop.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/lead-gen-ops/phases/phase0-qa-matrix.md` | Create | End-to-end QA matrix and seed plan |

---

### 0F — Execution Gates and File Ownership Baseline

**Type:** Planning / Coordination  
**Parallelizable:** No — consolidates outputs from 0A through 0E.

**What:** Finalize the phase gate sequence and confirm file ownership boundaries before parallel implementation begins.

**Why:** Multiple phases touch adjacent auth, Convex, and UI surfaces. Without ownership boundaries, parallel agents will create merge conflicts or accidentally rework shared files in incompatible ways.

**Where:**
- `plans/lead-gen-ops/phases/parallelization-strategy.md` (new)
- `plans/lead-gen-ops/phases/phase0-implementation-checklist.md` (modify)

**How:**

**Step 1: Add gate requirements to the checklist.**

```markdown
<!-- Path: plans/lead-gen-ops/phases/phase0-implementation-checklist.md -->

## Required Gates

| Gate | Trigger | Required Checks |
|---|---|---|
| Gate 0 | Before Phase 1 | WorkOS role exists; migration notes accepted; blast-radius checklist complete. |
| Gate 1 | After Phase 1 | `npx convex dev --once`, route-gate QA, invite/role UI smoke test. |
| Gate 2 | After Phases 2 and 3 | Capture/dedupe/report aggregate reconciliation passes. |
| Gate 3 | After Phase 4 | Slack and Calendly regression QA pass with Lead Gen hooks enabled. |
| Gate 4 | After Phase 5 | Full release checklist, export hardening, and mobile/desktop browser QA pass. |
```

**Step 2: Lock shared-file ownership in the parallelization strategy.**

```markdown
<!-- Path: plans/lead-gen-ops/phases/parallelization-strategy.md -->

| Directory/File | Phase Owner | Notes |
|---|---|---|
| `convex/schema.ts` | Phase 1 only | All Lead Gen table and role-union changes happen together. |
| `convex/lib/roleMapping.ts` | Phase 1 only | Role contract must stabilize before WorkOS/user flows. |
| `convex/leadGen/capture.ts` | Phase 2 only | Phase 3 exposes aggregate helpers but does not rewrite capture. |
| `convex/leadGen/reporting.ts` | Phase 3 only | Admin reporting owns aggregate read DTOs. |
| `convex/slack/createQualifiedLead.ts` | Phase 4 only | Single audit scheduling hook; no modal changes. |
| `convex/pipeline/inviteeCreated.ts` | Phase 4 only | Existing audit preservation only. |
| `app/workspace/lead-gen/**` | Phase 2 and Phase 3 by route | Capture/activity owns worker routes; reporting owns admin routes. |
```

**Key implementation notes:**
- If a later phase needs to touch a Phase 1-owned shared file, update the parallelization strategy first.
- File ownership is stricter than conceptual ownership; two agents should not edit the same file in the same window.
- Quality gates should stop work when auth, schema, or webhook regression checks fail.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/lead-gen-ops/phases/parallelization-strategy.md` | Create | Cross-phase dependency and ownership roadmap |
| `plans/lead-gen-ops/phases/phase0-implementation-checklist.md` | Modify | Add gates and shared-file checks |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `plans/lead-gen-ops/phases/phase0-implementation-checklist.md` | Create | 0A, 0C, 0D, 0F |
| `plans/lead-gen-ops/phases/phase0-migration-notes.md` | Create | 0B |
| `plans/lead-gen-ops/phases/phase0-qa-matrix.md` | Create | 0E |
| `plans/lead-gen-ops/phases/parallelization-strategy.md` | Create | 0F |
