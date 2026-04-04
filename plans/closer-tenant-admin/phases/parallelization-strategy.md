# Parallelization Strategy — Closer, Tenant Admin & Owner Dashboards

**Purpose:** This document defines the parallelization strategy across all 7 implementation phases, identifying the critical path, dependency graph, and maximum concurrency opportunities for both backend and frontend workstreams.

**Prerequisite:** All 6 phases of the System Admin & Tenant Onboarding flow are complete. Schema, env vars, WorkOS SDK, Calendly OAuth, webhooks, cron jobs, and the existing admin dashboard are fully operational.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **1** | Schema Extensions, Auth Guards & Core Utilities | Backend + minimal Frontend | Medium | Sys-admin Phases 1–6 |
| **2** | Tenant Owner Identification & WorkOS User Management | Backend | Medium-High | Phase 1 |
| **3** | Webhook Event Processing Pipeline | Backend | High | Phase 1 |
| **4** | Admin Dashboard, Team Management & Settings | Full-Stack | High | Phase 1 + 2 |
| **5** | Closer Dashboard — Pipeline, Calendar & Featured Event | Full-Stack | High | Phase 1 + 3 |
| **6** | Meeting Detail Page & Outcome Actions | Full-Stack | Medium | Phase 5 |
| **7** | Payment Logging & Follow-Up Scheduling | Full-Stack | Medium | Phase 6 |

---

## Master Dependency Graph

```
                    ┌──────────────────────────────────────────────────────────────────┐
                    │                         PHASE 1                                  │
                    │  Schema Extensions, Auth Guards & Core Utilities (FOUNDATION)     │
                    └──────────┬───────────────────┬───────────────────────────────────┘
                               │                   │
                    ┌──────────▼──────────┐ ┌──────▼──────────┐
                    │     PHASE 2         │ │    PHASE 3      │
                    │  Owner ID & WorkOS  │ │  Pipeline       │
                    │  User Management    │ │  Processing     │
                    │  (Backend only)     │ │  (Backend only) │
                    └──────────┬──────────┘ └──────┬──────────┘
                               │                   │
                    ┌──────────▼──────────┐ ┌──────▼──────────┐
                    │     PHASE 4         │ │    PHASE 5      │
                    │  Admin Dashboard,   │ │  Closer         │
                    │  Team Mgmt &        │ │  Dashboard      │
                    │  Settings           │ │  (Full-Stack)   │
                    │  (Full-Stack)       │ │                  │
                    └─────────────────────┘ └──────┬──────────┘
                                                   │
                                            ┌──────▼──────────┐
                                            │    PHASE 6      │
                                            │  Meeting Detail  │
                                            │  & Outcomes      │
                                            │  (Full-Stack)   │
                                            └──────┬──────────┘
                                                   │
                                            ┌──────▼──────────┐
                                            │    PHASE 7      │
                                            │  Payments &      │
                                            │  Follow-Ups      │
                                            │  (Full-Stack)   │
                                            └─────────────────┘
```

---

## Maximum Parallelism Windows

### Window 1: Phase 1 (Sequential Foundation — Must Complete First)

**Concurrency:** Up to 5 backend subphases in parallel within Phase 1.

Phase 1 is the **critical foundation**. Everything blocks on it. However, after the schema (1A) deploys, subphases 1B (auth guard), 1C (user queries), 1D (status validation), and 1E (role mapping utils) can all run simultaneously. The frontend shell (1F) depends only on 1C.

```
Timeline: ████████████████████████████
          1A (schema)  ───────────────┐
                                      ├── 1B (auth guard) ──────────────────┐
                                      ├── 1C (user queries) ────────────────┤
                                      ├── 1D (status validation) ──────────┤── 1F (workspace layout shell)
                                      └── 1E (role mapping utils) ─────────┘
```

---

### Window 2: Phase 2 + Phase 3 (Full Backend Parallelism)

**Concurrency:** 2 completely independent backend streams running simultaneously.

After Phase 1 completes, Phase 2 (owner identification + WorkOS user management) and Phase 3 (pipeline processing) have **zero shared dependencies**. They touch entirely different directories and functionality:

- **Phase 2** works in `convex/onboarding/`, `convex/workos/`, `convex/users/`
- **Phase 3** works in `convex/pipeline/`, `convex/webhooks/`

No merge conflicts possible. No shared state.

```
Timeline:                    ██████████████████████████████████████
                             Phase 2 (Owner + WorkOS)  ──────────────┐
                             Phase 3 (Pipeline)  ────────────────────┤
                                                                     ▼
                                                              Window 3
```

**Within Phase 2 (internal parallelism):**
```
2A (WorkOS role assignment action) ─────────────┐
2B (modify onboarding/complete.ts) ─────────────┤  (2A+2B in parallel)
                                                 │
2C (CRM user creation mutation) ────────────────┤  (parallel with 2A/2B)
2D (Calendly member linking mutation) ──────────┤  (parallel with 2A/2B/2C)
                                                 │
                                                 ├── 2E (inviteUser action — needs 2A, 2C, 2D)
                                                 │
2G (user management queries) ───────────────────┤  (parallel with everything above)
                                                 │
                                                 └── 2F (updateUserRole + removeUser — needs 2A, 2G)
```

**Within Phase 3 (internal parallelism):**
```
3A (pipeline helper queries) ────────────────┐
                                             ├── 3B (pipeline dispatcher) ──┐
                                             │                              ├── 3C (invitee.created) ──┐
                                             │                              ├── 3D (invitee.canceled) ─┤── 3F (wire webhook trigger)
                                             │                              └── 3E (invitee_no_show) ──┘
                                             └──────────────────────────────────────────────────────────┘
```

---

### Window 3: Phase 4 + Phase 5 (Full-Stack Parallelism)

**Concurrency:** 2 completely independent full-stack streams running simultaneously.

Phase 4 (Admin dashboard / team / settings) and Phase 5 (Closer dashboard) are **completely independent UI surfaces** serving different user roles:

- **Phase 4** builds admin-only pages: `/workspace`, `/workspace/team`, `/workspace/pipeline`, `/workspace/settings`
- **Phase 5** builds closer-only pages: `/workspace/closer`, `/workspace/closer/pipeline`

Their backend queries also touch different data scopes (admin sees all tenants' data; closer sees only own). No shared components (other than the workspace layout shell built in Phase 1F).

```
Timeline:                                         ████████████████████████████████████████
                                                  Phase 4 (Admin UI)  ─────────────────────┐
                                                  Phase 5 (Closer UI)  ────────────────────┤
                                                                                            ▼
                                                                                     Window 4
```

**Within Phase 4 (backend first, then frontend in parallel):**
```
4A (admin stats query) ──────────────────┐
4B (event type config queries) ──────────┤  (4A+4B+4C all parallel)
4C (opportunity queries for admin) ──────┤
                                         │
                                         ├── 4D (admin overview page) ──────┐
                                         ├── 4E (team page + invite form) ──┤  (4D+4E+4F+4G all parallel)
                                         ├── 4F (admin pipeline page) ──────┤
                                         └── 4G (settings page) ───────────┘
```

**Within Phase 5 (backend first, then frontend in parallel):**
```
5A (closer dashboard queries) ───────────┐
5B (calendar range queries) ─────────────┤  (5A+5B+5C all parallel)
5C (opportunity list query) ─────────────┤
                                         │
                                         ├── 5D (closer dashboard page) ───┐
                                         ├── 5E (calendar view component) ─┤  (5D+5E+5F all parallel)
                                         └── 5F (closer pipeline page) ────┘
```

---

### Window 4: Phase 6 (Sequential — Extends Closer Dashboard)

**Concurrency:** Backend subphases parallel, then frontend subphases parallel.

Phase 6 adds the meeting detail page and outcome actions to the closer dashboard. It's a focused extension.

```
Timeline:                                                                          ██████████████████████
                                                                                   6A (meeting detail query) ──┐
                                                                                   6B (meeting actions) ───────┤  (parallel)
                                                                                                               │
                                                                                                               ├── 6C (detail page UI) ──┐
                                                                                                               └── 6D (outcome bar UI) ──┘  (parallel)
```

---

### Window 5: Phase 7 (Final — Two Parallel Backend Streams, Then Frontend)

**Concurrency:** Payment and follow-up backend streams run in parallel.

```
Timeline:                                                                                                      ██████████████████████
                                                                                                               7A (payment backend) ────────┐
                                                                                                               7B (follow-up backend) ──────┤  (parallel)
                                                                                                               7C (follow-up mutations) ────┤
                                                                                                                                            │
                                                                                                                                            ├── 7D (payment UI)
                                                                                                                                            └── 7E (follow-up UI)
                                                                                                                                                 (parallel)
```

---

## Critical Path Analysis

The **critical path** (longest sequential chain determining minimum implementation time):

```
Phase 1 → Phase 3 → Phase 5 → Phase 6 → Phase 7
  │          │          │         │         │
  │          │          │         │         └── Payment + Follow-up (backend + frontend)
  │          │          │         └── Meeting detail + outcomes
  │          │          └── Closer dashboard (backend + frontend)
  │          └── Pipeline processing (feeds closer dashboard with data)
  └── Schema + auth guards + core utilities
```

**Alternative shorter path (Admin stream):**
```
Phase 1 → Phase 2 → Phase 4
```

This path is shorter, meaning the Admin/Owner functionality is available sooner for testing. The pipeline → closer path is the actual bottleneck.

**Implication:** Start Phase 3 (pipeline) as early as possible after Phase 1 completes. It is on the critical path.

---

## File Ownership Boundaries (Merge Conflict Prevention)

When running phases in parallel, each phase owns specific directories to prevent conflicts:

| Directory/File | Phase Owner | Notes |
|---|---|---|
| `convex/schema.ts` | **Phase 1 only** | All schema changes happen in Phase 1. No other phase modifies schema. |
| `convex/requireTenantUser.ts` | **Phase 1 only** | Created once, consumed by all subsequent phases. |
| `convex/lib/statusTransitions.ts` | **Phase 1 only** | Opportunity state machine utility. |
| `convex/lib/roleMapping.ts` | **Phase 1 only** | CRM ↔ WorkOS role conversion. |
| `convex/users/queries.ts` | **Phase 1 (create) + Phase 2 (extend)** | Phase 1 creates `getCurrentUser`. Phase 2 adds `listTeamMembers`, `listUnmatchedCalendlyMembers`. Different functions, append-only. |
| `convex/onboarding/complete.ts` | **Phase 2 only** | Modified to set tenantOwnerId + trigger role assignment. |
| `convex/workos/` | **Phase 2 only** | New directory: `roles.ts`, `userManagement.ts`, `userMutations.ts`. |
| `convex/pipeline/` | **Phase 3 only** | New directory: `processor.ts`, `inviteeCreated.ts`, `inviteeCanceled.ts`, `inviteeNoShow.ts`, `queries.ts`. |
| `convex/webhooks/calendly.ts` | **Phase 3 only** | Modified to schedule pipeline processing after raw event persisted. |
| `convex/dashboard/` | **Phase 4 only** | New directory: `adminStats.ts`. |
| `convex/closer/` | **Phase 5 (create) → Phase 6 (extend) → Phase 7 (extend)** | Separate files per phase: `dashboard.ts`, `calendar.ts`, `pipeline.ts` (P5) → `meetingDetail.ts`, `meetingActions.ts` (P6) → `payments.ts`, `followUp.ts` (P7). No file overlap. |
| `app/workspace/layout.tsx` | **Phase 1F** | Created once with role detection. Not modified by later phases. |
| `app/workspace/page.tsx` | **Phase 4** | Admin dashboard overview. |
| `app/workspace/team/` | **Phase 4** | Team management UI. |
| `app/workspace/pipeline/` | **Phase 4** | Admin pipeline view. |
| `app/workspace/settings/` | **Phase 4** | Settings UI. |
| `app/workspace/closer/page.tsx` | **Phase 5** | Closer dashboard. |
| `app/workspace/closer/pipeline/` | **Phase 5** | Closer pipeline view. |
| `app/workspace/closer/meetings/` | **Phase 6** | Meeting detail page. |

---

## Recommended Execution Strategies

### Solo Developer

Execute in order, leveraging within-phase parallelism for efficient context-switching:

1. **Phase 1** — all subphases (schema first, then rest)
2. **Phase 2** — WorkOS integration + user management
3. **Phase 3** — pipeline processing (interleave with Phase 2 review)
4. **Phase 4 backend** → **Phase 5 backend** (batch all backend work)
5. **Phase 4 frontend** → **Phase 5 frontend** (batch all frontend work)
6. **Phase 6** — meeting detail
7. **Phase 7** — payments + follow-ups

**Estimated time:** 21–28 days

### Two Developers (Backend + Frontend)

| Sprint | Developer A (Backend) | Developer B (Frontend) |
|---|---|---|
| 1 | Phase 1A–1E (all backend) | Phase 1F (workspace layout shell, blocked until 1C done) |
| 2 | Phase 2 (full) + Phase 3 (full) in parallel | Phase 4 frontend (admin UI — can stub backend calls) |
| 3 | Phase 5A–5C (closer backend) | Phase 4 frontend (complete with real backend) + Phase 5D–5F (closer frontend) |
| 4 | Phase 6A–6B (meeting backend) + Phase 7A–7C | Phase 6C–6D (meeting detail UI) + Phase 7D–7E |
| 5 | Integration testing | Integration testing |

**Estimated time:** 14–18 days

### Three+ Developers / Agents

| Sprint | Agent A (Backend - Admin Path) | Agent B (Backend - Closer Path) | Agent C (Frontend) |
|---|---|---|---|
| 1 | Phase 1A, 1B, 1D, 1E | Phase 1C | — (blocked on 1) |
| 2 | Phase 2 (full) | Phase 3 (full) | Phase 1F (workspace shell) |
| 3 | Phase 4A, 4B, 4C (admin backend) | Phase 5A, 5B, 5C (closer backend) | Phase 4D, 4E, 4F, 4G (admin frontend) |
| 4 | Phase 7A, 7B, 7C (payment/follow-up backend) | Phase 6A, 6B (meeting backend) | Phase 5D, 5E, 5F (closer frontend) |
| 5 | Integration + testing | — | Phase 6C, 6D + Phase 7D, 7E |

**Estimated time:** 10–14 days

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 1** | After Phase 1 | `npx convex dev` succeeds. `pnpm tsc --noEmit` passes. Auth guard works. Workspace layout renders. |
| **Gate 2** | After Phase 2 + 3 | Invite a test user via Convex dashboard → CRM user created. Simulate webhook → pipeline creates Lead + Opp + Meeting. |
| **Gate 3** | After Phase 4 + 5 | Admin dashboard loads with stats. Team page shows invite form. Closer dashboard shows featured event + calendar. |
| **Gate 4** | After Phase 6 | Click meeting from closer dashboard → detail page loads with lead info, notes, Zoom link, outcome actions. |
| **Gate 5** | After Phase 7 | Log payment with proof upload → opportunity status updates. Create follow-up → scheduling link generated. Pipeline detects follow-up booking. |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Phase 1 schema errors block everything | **Critical** | Deploy schema immediately after writing. Run `npx convex dev` before proceeding to any other subphase. |
| WorkOS API rate limits during Phase 2 testing | Medium | Use sandbox environment. WorkOS sandbox has generous limits. Add retry with exponential backoff. |
| Pipeline processor bugs corrupt Lead/Opp/Meeting data | High | Phase 3 includes idempotency checks. All raw events are preserved with `processed: false` for safe replay. |
| Frontend built against stale or missing backend API | Medium | Phase 4/5 frontend subphases explicitly list which backend functions they depend on. Frontend can start with stub data. |
| Calendly API scope missing for follow-up scheduling | Medium | Phase 7 checks if `scheduling_links:write` scope is available. If not, follow-up feature degrades gracefully (manual follow-up without auto-link). |
| Calendar component complexity exceeds sprint estimate | Medium | Phase 5E uses shadcn/ui primitives for a minimal week-view calendar. No third-party calendar library dependency. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | `convex-setup-auth` | Auth guard references WorkOS JWT claims. Verify auth config is correct. |
| **2** | `workos` | Programmatic user management via WorkOS Node SDK. Role assignment, membership management. |
| **3** | — | Pure Convex backend. Refer to `.docs/calendly/index.md` for webhook payload shapes. |
| **4** | `frontend-design`, `shadcn`, `vercel-react-best-practices`, `vercel-composition-patterns`, `web-design-guidelines` | Full admin dashboard UI with complex data tables, forms, stats cards. |
| **5** | `frontend-design`, `shadcn`, `vercel-react-best-practices`, `web-design-guidelines` | Closer dashboard with calendar, pipeline visualization, featured event card. |
| **6** | `frontend-design`, `shadcn`, `web-design-guidelines` | Meeting detail page with action bars, notes editor, lead info panels. |
| **7** | `frontend-design`, `shadcn`, `web-design-guidelines` | Payment form with file upload, follow-up scheduling dialog. |

---

*This strategy maximizes parallelization while respecting critical dependencies. The key insight: Phase 2 (Admin backend) and Phase 3 (Pipeline backend) are completely independent and should always run in parallel. Similarly, Phase 4 (Admin UI) and Phase 5 (Closer UI) are completely independent and should always run in parallel.*
