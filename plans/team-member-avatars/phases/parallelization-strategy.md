# Parallelization Strategy — Team Member Avatars

**Purpose:** This document defines the parallelization strategy across all 5 team-member avatar implementation phases, identifying the critical path, maximum concurrency windows, file ownership boundaries, quality gates, and recommended agent allocation.

**Prerequisite:** `plans/team-member-avatars/team-member-avatars-design.md` is accepted for MVP scope. Phase 1 schema changes must remain widen-only optional fields. Any required-field change, destructive data change, or broad backfill escalation invokes `convex-migration-helper` before implementation continues.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **1** | Profile Data Contract | Backend | Medium-High | Design accepted; Convex guidelines read |
| **2** | Shared Avatar UI | Frontend | Medium | Phase 1B identity contract |
| **3** | Profile Page Upload | Full-Stack | Medium-High | Phase 1A/1B/1D, Phase 2B/2C |
| **4** | Workspace Surface Rollout | Full-Stack | High | Phase 1F, Phase 2E, Phase 3B for current-user payload |
| **5** | Backfill and Verification | Backend / QA | Medium-High | Phase 1C for backfill implementation; Phase 3/4 for final verification |

---

## Master Dependency Graph

```
                    ┌─────────────────────────────────────────────────────────────┐
                    │                         PHASE 1                             │
                    │  Profile Data Contract                                      │
                    │  1A schema, 1B helpers, 1C WorkOS, 1D lead-gen, 1E DM link  │
                    └───────────────┬───────────────────────┬─────────────────────┘
                                    │                       │
                   1B identity      │                       │ 1C backfill-capable
                   contract         │                       │ WorkOS profile sync
                                    ▼                       ▼
                    ┌──────────────────────────┐   ┌──────────────────────────────┐
                    │        PHASE 2           │   │           PHASE 5A/5B         │
                    │  Shared Avatar UI        │   │  Backfill internals/runbook   │
                    │  (can overlap 1C-1E)     │   │  (can overlap Phase 4)        │
                    └───────────────┬──────────┘   └──────────────────┬───────────┘
                                    │                                 │
                 2B/2C components   │                                 │ final QA waits
                 + 3A/3B API        ▼                                 │ for Phase 4
                    ┌──────────────────────────┐                      │
                    │        PHASE 3           │                      │
                    │  Profile Page Upload     │                      │
                    └───────────────┬──────────┘                      │
                                    │                                 │
                     1F + 2E + 3B   │                                 │
                                    ▼                                 ▼
                    ┌─────────────────────────────────────────────────────────────┐
                    │                         PHASE 4                             │
                    │  Workspace Surface Rollout                                  │
                    │  4A foundation, then 4B-4G maximum parallel streams          │
                    └───────────────┬─────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────────────────────────────────────────────┐
                    │                         PHASE 5                             │
                    │  Backfill Execution, Verification, Release Decision          │
                    └─────────────────────────────────────────────────────────────┘
```

**Important dependency nuance:** Phase 2 does not wait for all of Phase 1. It can start after 1B publishes the identity contract. Phase 5 backfill implementation can start after 1C, but production execution and final release verification wait for Phase 4.

---

## Maximum Parallelism Windows

### Window 1: Contract Foundation

**Concurrency:** Up to 4 streams after 1A.

Phase 1A must complete first because it widens schema and generates new Convex types. After that, 1B, 1C, 1D, and 1E can run with clear ownership boundaries.

```
Timeline: ███████████████████████████████

1A Schema widen ───────┬── 1B Member identity helpers ───────┬── Phase 2 starts
                       ├── 1C WorkOS sync actions ───────────┤
                       ├── 1D Lead-gen denormalization ──────┤── 1F Contract verification
                       └── 1E DM closer link contract ───────┘
```

**Why independent:**
- 1B owns `convex/lib/memberIdentity.ts`.
- 1C owns `convex/workos/*`.
- 1D owns `convex/leadGen/workers.ts`.
- 1E owns `convex/attribution/dmClosers.ts`.
- 1F is the only gate that needs all streams complete.

**Internal parallelism:**

```
             ┌── 1B ──→ Phase 2
1A complete ─┼── 1C ──┐
             ├── 1D ──┼── 1F
             └── 1E ──┘
```

---

### Window 2: UI Component Overlap

**Concurrency:** Up to 5 streams when 1B is complete and 1C-1E are still active.

This is the first schedule compression opportunity. The frontend component contract can be built while backend sync/linking streams continue.

```
Timeline:             █████████████████████████████████

Backend stream A:     1C WorkOS profile sync ─────────────────────┐
Backend stream B:     1D Lead-gen worker sync ────────────────────┤── 1F
Backend stream C:     1E DM closer link contract ─────────────────┘
Frontend stream A:    2A Type + initials helper ──────┬── 2B MemberAvatar
Frontend stream B:                                    └── 2C MemberIdentity
Frontend polish:      2D size/accessibility ─────────────── 2E usage gate
```

**Why safe:**
- Phase 2 creates `app/workspace/_components/member-avatar.tsx` and `member-identity.tsx`.
- Phase 1 backend streams do not touch those frontend files.
- The only shared artifact is the identity shape from 1B.

**Within Phase 2:**

```
2A (type/helper) ─────┬── 2B (avatar)
                      └── 2C (identity row)
2D (polish) ───────────────────────────┐
2B + 2C + 2D ──────────────────────────┴── 2E (usage gate)
```

---

### Window 3: Profile Upload and Backfill Preparation

**Concurrency:** Up to 4 streams after Phase 1F and Phase 2B/2C.

Profile upload work and backfill preparation touch different files and can proceed before broad surface rollout finishes.

```
Timeline:                         ███████████████████████████

3A Storage mutations ───────────┬── 3C Profile upload control ─────┐
3B Current-user avatar query ───┘                                  ├── 3E Upload QA
3D Profile loading polish ─────────────────────────────────────────┘

5A Backfill internals ─────────────── 5B Backfill runbook
```

**Why independent:**
- 3A owns `convex/users/profilePictures.ts`.
- 3B owns `convex/users/queries.ts` and must be coordinated with 4A.
- 3C/3D own `app/workspace/profile/*`.
- 5A owns `convex/workos/profileBackfill*.ts` and `profileMutations.ts`.
- 5B owns planning/runbook docs.

**Coordination rule:** Do not start 4A edits to `convex/users/queries.ts` until 3B lands, or explicitly combine those changes in one branch.

---

### Window 4: Maximum Workspace Rollout Fan-Out

**Concurrency:** Up to 6 full-stack streams after 4A.

Phase 4 is the largest parallelism window. 4A stabilizes shared shell/team/user option shapes first; then 4B-4G can run simultaneously with directory ownership.

```
Timeline:                                      ██████████████████████████████████████

4A Shell/team/users foundation ─────┬── 4B Overview + operations ─────────────┐
                                    ├── 4C Reports ──────────────────────────┤
                                    ├── 4D Lead-gen ops ─────────────────────┤
                                    ├── 4E Customers/leads/pipeline ─────────┤── 4H Cross-surface QA
                                    ├── 4F Billing/closer/comments ──────────┤
                                    └── 4G Settings/public portal ───────────┘
```

**Why independent:**
- 4B owns `convex/dashboard`, `convex/operations`, and overview/operations components.
- 4C owns `convex/reporting` and report route components.
- 4D owns `convex/leadGen` report payloads and `app/workspace/lead-gen`.
- 4E owns customer/lead/opportunity route areas.
- 4F owns billing, closer comments, and reminder detail.
- 4G owns settings attribution and public DM portal privacy.

**Within each 4B-4G stream:**

```
Backend query enrichment ─────┬── Frontend table/card wiring A
                              ├── Frontend dialog/detail wiring B
                              └── Local route smoke check
All local checks complete ───────────────→ Stream ready for 4H
```

**Merge rule:** Only 4A should touch `convex/users/queries.ts` and workspace shell files. If another stream needs user option data, request a 4A helper addition instead of editing that file independently.

---

### Window 5: Verification, Backfill Execution, and Release Decision

**Concurrency:** Up to 3 QA streams after Phase 4 merges.

Phase 5 final verification is partly parallel: static/privacy checks, manual role QA, and production test-tenant backfill can run at the same time after dry-run evidence is accepted.

```
Timeline:                                                        ████████████████████

5C Static/privacy/performance checks ───────────────┐
5D Manual role/surface QA ──────────────────────────┤── 5F Release decision
5E Production test-tenant backfill execution ───────┘
```

**Why independent:**
- 5C is static search, codegen/typecheck, and logs/insights review.
- 5D is UI and role-based manual QA.
- 5E is data mutation on the production test tenant after dry-run signoff.
- 5F must wait for all three because privacy, UI, and data state all affect release.

---

## Critical Path Analysis

The longest sequential chain determining minimum delivery time is:

```
1A Schema widen
  │
  ▼
1B Member identity helpers
  │
  ▼
2B/2C Shared avatar components
  │
  ▼
3B Current-user avatar query
  │
  ▼
4A Shell/team/user foundation
  │
  ▼
4B-4G Broad workspace rollout streams
  │
  ▼
4H Cross-surface QA
  │
  ▼
5C/5D/5E Verification + backfill
  │
  ▼
5F Release decision
```

**Shorter parallel paths:**

```
1A → 1C WorkOS sync → 5A Backfill internals
1A → 1D Lead-gen denormalization
1A → 1E DM closer link contract
1B → 2D Avatar polish
1F + 2E → 3A Profile storage mutations
```

**Implication:** Start Phase 2 immediately after 1B, and protect 4A from merge conflicts. The overall delivery time is dominated by Phase 4 fan-out and final QA, not by the WorkOS backfill implementation.

---

## File Ownership Boundaries

| Directory/File | Phase Owner | Notes |
|---|---|---|
| `plans/team-member-avatars/phases/phase1.md` | Planning | Backend contract implementation guide. |
| `plans/team-member-avatars/phases/phase2.md` | Planning | Shared UI component guide. |
| `plans/team-member-avatars/phases/phase3.md` | Planning | Profile upload implementation guide. |
| `plans/team-member-avatars/phases/phase4.md` | Planning | Surface rollout implementation guide. |
| `plans/team-member-avatars/phases/phase5.md` | Planning | Backfill and verification guide. |
| `convex/schema.ts` | Phase 1A | Widen-only optional fields and DM closer index. No other phase edits schema. |
| `convex/lib/memberIdentity.ts` | Phase 1B | Shared backend identity helpers. Any later changes need coordination. |
| `app/workspace/_components/member-avatar.tsx` | Phase 2A/2B | Shared avatar component. Phase 4 consumes only. |
| `app/workspace/_components/member-identity.tsx` | Phase 2C/2D | Shared identity row. Phase 4 consumes only. |
| `convex/workos/userActions.ts` | Phase 1C | Invite claim profile data. |
| `convex/workos/userMutations.ts` | Phase 1C | Invite claim profile patch. |
| `convex/workos/profileActions.ts` | Phase 1C | Current-user WorkOS profile sync. |
| `convex/workos/profileMutations.ts` | Phase 1C / 5A | Phase 1 owns current profile patch; Phase 5 adds backfill patch. |
| `convex/workos/profileBackfill.ts` | Phase 5A | Node action only. |
| `convex/workos/profileBackfillQueries.ts` | Phase 5A | V8 internal query for bounded user pages. |
| `convex/leadGen/workers.ts` | Phase 1D | Worker profile denormalization; Phase 4D should avoid editing unless necessary. |
| `convex/attribution/dmClosers.ts` | Phase 1E / 4G | Phase 1 adds write contract; Phase 4G adds UI-facing identity payloads. |
| `convex/users/profilePictures.ts` | Phase 3A | Upload URL/save/remove mutations. |
| `convex/users/queries.ts` | Phase 3B / 4A | Coordinate current-user and team/list payload changes in one stream. |
| `app/workspace/profile/_components/profile-page-client.tsx` | Phase 3C | Profile upload UI only. |
| `app/workspace/profile/loading.tsx` | Phase 3D | Profile skeleton. |
| `app/workspace/_components/workspace-auth.tsx` | Phase 4A | Shell current-user avatar prop. |
| `app/workspace/_components/workspace-shell-client.tsx` | Phase 4A | Sidebar current-user identity. |
| `app/workspace/team/**` | Phase 4A | Team table/dialog/reassignment/redistribution UI. |
| `convex/unavailability/**` | Phase 4A | Recent reassignment and redistribution identities. |
| `convex/dashboard/**` | Phase 4B | Overview avatar payloads. |
| `convex/operations/**` | Phase 4B | Operations avatar payloads. |
| `app/workspace/_components/lead-gen-overview-card.tsx` | Phase 4B | Overview worker identity rows. |
| `app/workspace/_components/top-dm-closers-card.tsx` | Phase 4B | Overview DM closer identity rows. |
| `app/workspace/_components/phone-closer-operations-table.tsx` | Phase 4B | Overview phone closer identity rows. |
| `app/workspace/_components/top-qualifiers-card.tsx` | Phase 4B | Slack identity rows. |
| `app/workspace/_components/slack-user-leaderboard-card.tsx` | Phase 4B | Slack identity rows. |
| `app/workspace/_components/setter-contribution-table.tsx` | Phase 4B | Slack setter identity rows. |
| `app/workspace/operations/**` | Phase 4B | Operations table/filter UI. |
| `convex/reporting/**` | Phase 4C | Report avatar payloads. Coordinate only if helpers are shared. |
| `app/workspace/reports/**` | Phase 4C / 4G | 4C owns report pages; 4G owns shared attribution filters. |
| `convex/leadGen/reporting.ts` | Phase 4D | UI worker identities. |
| `convex/leadGen/reportBuilders.ts` | Phase 4D | UI worker identity rows. |
| `convex/leadGen/exports.ts` | Phase 4D verify only | Exports remain text-only. |
| `app/workspace/lead-gen/**` | Phase 4D | Lead-gen ops/capture/activity worker identities. |
| `convex/customers/queries.ts` | Phase 4E | Customer converter/closer identities. |
| `app/workspace/customers/**` | Phase 4E | Customer list/detail UI. |
| `convex/leads/queries.ts` | Phase 4E | Legacy lead identities. |
| `app/workspace/leads/**` | Phase 4E | Legacy lead list/detail UI. |
| `convex/leadCustomers/detailPayload.ts` | Phase 4E | Unified view payload. |
| `convex/lib/attribution/detailPayload.ts` | Phase 4E | Authenticated attribution identity payloads. Coordinate with 4G if DM behavior changes. |
| `app/workspace/leads-customers/**` | Phase 4E | Unified view UI. |
| `convex/opportunities/**` | Phase 4E | Opportunity list/detail identities. |
| `app/workspace/opportunities/**` | Phase 4E | Opportunity UI. |
| `app/workspace/_components/pipeline/opportunities-table.tsx` | Phase 4E | Pipeline table UI. |
| `convex/billing/**` | Phase 4F | Billing identities; exports verify text-only. |
| `app/workspace/billing/**` | Phase 4F | Billing detail/history/timeline UI. |
| `convex/closer/meetingComments.ts` | Phase 4F | Comment author identity. |
| `app/workspace/closer/meetings/_components/comment-entry.tsx` | Phase 4F | Replace manual initials. |
| `convex/pipeline/reminderDetail.ts` | Phase 4F | Admin reminder assigned closer identity. |
| `app/workspace/pipeline/reminders/**` | Phase 4F | Reminder detail UI. |
| `convex/linkPortal/copyQueries.ts` | Phase 4G | Authenticated copy activity identity. |
| `convex/linkPortal/portalQueries.ts` | Phase 4G | Public initials-only identity. |
| `app/dm-links/[portalSlug]/**` | Phase 4G | Public portal initials-only UI. |
| `plans/team-member-avatars/phases/profile-backfill-runbook.md` | Phase 5B-5E | Created during implementation, not before. |
| `plans/team-member-avatars/phases/release-checklist.md` | Phase 5F | Final release evidence. |

---

## Recommended Execution Strategies

### Solo Developer

Execute in dependency order while still using within-phase batching:

| Sprint | Work |
|---|---|
| 1 | Phase 1A, 1B, then 1C/1D/1E. Run 1F. |
| 2 | Phase 2A-2E, then Phase 3A/3B. |
| 3 | Phase 3C-3E and Phase 5A/5B backfill preparation. |
| 4 | Phase 4A, then 4B overview/operations. |
| 5 | Phase 4C reports and 4D lead-gen ops. |
| 6 | Phase 4E customers/leads/pipeline. |
| 7 | Phase 4F billing/closer/comments and 4G settings/public portal. |
| 8 | Phase 4H and Phase 5C-5F verification/backfill/release notes. |

**Estimated time:** 12-18 days

### Two Developers

| Sprint | Developer A | Developer B |
|---|---|---|
| 1 | Phase 1A, 1C, 1D | Phase 1B, 1E, start Phase 2A |
| 2 | Phase 1F, Phase 3A, Phase 5A | Phase 2B-2E, Phase 3B |
| 3 | Phase 3C-3E | Phase 4A |
| 4 | Phase 4B overview/operations | Phase 4C reports |
| 5 | Phase 4D lead-gen + 4F billing/closer | Phase 4E customers/leads/pipeline |
| 6 | Phase 4G settings/public portal | Phase 5B runbook, 5C static/privacy checks |
| 7 | Phase 5E backfill execution | Phase 4H/5D manual QA |
| 8 | Phase 5F release decision with Developer B | Phase 5F release decision with Developer A |

**Estimated time:** 8-11 days

### Three+ Developers / Agents

| Sprint | Agent A (Backend Foundation) | Agent B (Shared UI/Profile) | Agent C (Reports/Operations) | Agent D (Product Surfaces) | Agent E (QA/Backfill, optional) |
|---|---|---|---|---|---|
| 1 | 1A, then 1C | 1B, then 2A/2B/2C | 1D | 1E | Prepare QA matrix |
| 2 | 1F, 3A | 2D/2E, 3B/3C/3D | Read Phase 4C/4B files | Read Phase 4E/4F/4G files | 5A/5B |
| 3 | 4A | 3E and profile fixes | 4B + 4C | 4E | Static search prep |
| 4 | Support shared helper fixes | Support UI consistency | Finish 4B/4C, start local checks | 4D + 4F + 4G | 5C partial checks |
| 5 | Backend fixes from QA | Frontend polish fixes | Stream fixes | Stream fixes | 4H + 5D |
| 6 | 5E data execution | Release UI notes | Performance review support | Privacy review support | 5F release checklist |

**Estimated time:** 5-8 days

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 1: Widened Schema Ready** | After 1A | `convex/schema.ts` only adds optional fields/index; `pnpm exec convex codegen` succeeds; no required avatar field exists. |
| **Gate 2: Identity Contract Ready** | After 1B | `convex/lib/memberIdentity.ts` resolves custom/WorkOS/Slack/none sources; public helper is initials-only; Phase 2 can import mirrored type. |
| **Gate 3: Backend Contract Ready** | After 1F | WorkOS sync, lead-gen denormalization, DM closer link validation, codegen, and `pnpm tsc --noEmit` pass. |
| **Gate 4: Shared UI Ready** | After 2E | `MemberAvatar` and `MemberIdentity` typecheck; fallback initials verified; usage rule documented. |
| **Gate 5: Profile Upload Ready** | After 3E | Upload/replace/remove works by role; server metadata validation rejects bad files; old-file cleanup confirmed. |
| **Gate 6: Rollout Streams Ready** | After each 4B-4G stream | Local stream typecheck or targeted compile passes; no broad client roster queries; exports unchanged where applicable. |
| **Gate 7: Surface Rollout Ready** | After 4H | Static search, role route matrix, mobile/dark-mode checks, and public portal privacy checks pass. |
| **Gate 8: Backfill Dry Run Accepted** | Before 5E | Dry-run counts recorded; skipped/failed users reviewed; command targets only the production test tenant. |
| **Gate 9: Release Decision** | After 5F | Backfill execution, static checks, manual QA, privacy verification, and rollback notes are recorded. |

---

## Risk Mitigation

| Risk | Impact | Mitigation strategy |
|---|---|---|
| Required schema field slips into Phase 1 | Critical | Keep all new fields optional. Invoke `convex-migration-helper` before any required-field or destructive change. |
| Public DM portal leaks image URL or CRM email | Critical | Use `publicDmCloserIdentity` only in public portal queries; run targeted `rg` privacy checks before release. |
| WorkOS API calls are added to queries | Critical | Keep WorkOS calls in `"use node"` action files only. Mutations patch stored values; queries read stored values. |
| Node action file exports a query/mutation | High | Split V8 internal queries into separate files such as `profileBackfillQueries.ts`. |
| Phase 4 agents fight over `convex/users/queries.ts` | High | Reserve that file for 3B/4A. Other streams request user option shape changes through 4A. |
| Avatar enrichment creates read amplification | High | Enrich rows in existing bounded queries; batch load referenced users; run `convex-performance-audit` if logs/insights flag high reads. |
| Signed storage URLs are persisted | High | Store only `Id<"_storage">`; call `ctx.storage.getUrl()` in authorized queries. Static search for URL writes if needed. |
| Old uploaded files accumulate after replacement | Medium-High | `saveProfilePicture` and remove mutation delete previous storage IDs after successful patch; document orphan risk for failed saves. |
| Slack-only users accidentally prefer WorkOS avatars | Medium | Keep Slack identity helper source-specific. Do not infer Slack-to-CRM mapping in MVP. |
| Exports include image URLs | Medium | Phase 4D/4F verify export builders remain text-only. Static search export modules for image fields. |
| Dense table rows overflow on mobile | Medium | Use `MemberIdentity` truncation pattern, stable avatar sizes, and mobile browser QA in Phase 4H/5D. |
| Select menus become visually unstable | Medium | Make select-menu avatars optional. Required rollout is tables/cards/dialogs first. |
| Broken remote image renders blank | Medium | Use shadcn `AvatarFallback` everywhere through `MemberAvatar`. |
| Backfill hits WorkOS rate limits | Medium | Batch with `paginate`, use small batch size, schedule continuation, and record failed users for retry. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | `convex-migration-helper`, `convex`, `workos`, `convex-dev-workos-authkit` if AuthKit sync expands | Widen-only schema, internal actions/mutations, WorkOS profile fetch, tenant-safe identity helpers. |
| **2** | `frontend-design`, `shadcn`, `next-best-practices`, `web-design-guidelines` | Shared Avatar/Identity components, accessibility, stable dimensions, RSC/client boundaries. |
| **3** | `convex`, `frontend-design`, `shadcn`, `next-best-practices`, `web-design-guidelines` | Convex storage upload flow, profile settings UI, file input behavior, skeleton/error states. |
| **4** | `frontend-design`, `shadcn`, `next-best-practices`, `vercel-react-best-practices`, `convex-performance-audit`, `web-design-guidelines` | Broad route rollout, backend enrichment over client waterfalls, dense UI and responsive QA. |
| **5** | `convex-migration-helper`, `workos`, `convex-performance-audit`, `web-design-guidelines`, `browser:browser` | Backfill runbook, dry run, production data verification, privacy/static checks, local browser QA. |

---

## Reference Checklist

| Area | Reference |
|---|---|
| Design source of truth | `plans/team-member-avatars/team-member-avatars-design.md` |
| Missing surface audit | `plans/team-member-avatars/missing-surfaces-inventory.md` |
| Phase plan template | `.docs/internal/phases-planification-creation.md` |
| Parallelization rules | `.docs/internal/parallelization.md` |
| Convex generated guidelines | `convex/_generated/ai/guidelines.md` |
| Convex + Next.js SSR/preloading | `.docs/convex/nextjs.md`, `.docs/convex/module-nextjs.md` |
| Profile route | `app/workspace/profile/_components/profile-page-client.tsx` |
| Workspace shell | `app/workspace/_components/workspace-auth.tsx`, `app/workspace/_components/workspace-shell-client.tsx` |
| Schema source | `convex/schema.ts` |
| Auth guard | `convex/requireTenantUser.ts` |
