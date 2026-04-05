# Parallelization Strategy — Authorization Revamp

**Purpose:** This document defines the parallelization strategy across all 6 implementation phases, identifying the critical path, dependency graph, and maximum concurrency opportunities for converting the workspace authorization model from scattered client-side role checks to server-enforced, RSC-first permission gates.

**Prerequisite:** All 6 phases of the Closer, Tenant Admin & Owner Dashboards flow are complete. Schema, WorkOS AuthKit, Convex auth, workspace layout, and all role-specific dashboard pages are fully operational.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **1** | Foundation | Full-Stack | Medium | None |
| **2** | Workspace Layout Conversion | Full-Stack | Medium | Phase 1 |
| **3** | Page-by-Page Wrapper Conversion | Full-Stack | Medium-High | Phase 1 + 2 |
| **4** | Client Affordance Cleanup | Frontend | Medium | Phase 1 + 2 + 3 |
| **5** | Session Freshness Improvements | Full-Stack | Low | Phase 3 |
| **6** | Optional WorkOS Permission Promotion | Full-Stack | Medium-High | Phase 5 |

---

## Master Dependency Graph

```
┌─────────────────────────────────────────────────────────────────────┐
│                           PHASE 1                                   │
│  Foundation: lib/auth.ts, permissions.ts, auth components, proxy.ts │
│  (BLOCKS EVERYTHING)                                                │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                ┌───────────────▼───────────────┐
                │           PHASE 2             │
                │  Workspace Layout Conversion  │
                │  (RSC layout, workspace-shell, │
                │   not-provisioned-screen)      │
                └───────────────┬───────────────┘
                                │
                ┌───────────────▼───────────────┐
                │           PHASE 3             │
                │  Page-by-Page Wrapper          │
                │  Conversion (9 subphases)      │
                │  3A─3I all independent         │
                └──────┬────────────────┬───────┘
                       │                │
            ┌──────────▼──────┐  ┌──────▼──────────┐
            │    PHASE 4      │  │    PHASE 5       │
            │  Client         │  │  Session          │
            │  Affordance     │  │  Freshness        │
            │  Cleanup        │  │  Improvements     │
            │  (Frontend)     │  │  (Full-Stack)     │
            └─────────────────┘  └──────┬───────────┘
                                        │
                                 ┌──────▼───────────┐
                                 │    PHASE 6        │
                                 │  WorkOS Permission │
                                 │  Promotion         │
                                 │  (Optional)        │
                                 └───────────────────┘
```

---

## Maximum Parallelism Windows

### Window 1: Foundation (Phase 1 — Must Complete First)

**Concurrency:** Up to 3 subphases in parallel initially, then 2 sequential subphases.

Phase 1 is the **critical foundation**. Every subsequent phase depends on it. However, three of its five subphases have zero mutual dependencies and can run simultaneously. The context and permission-gate components follow once the permission vocabulary is established.

```
Timeline: ████████████████████████████████████████
          1A (lib/auth.ts) ──────────────────────────────────────────┐
          1B (permissions.ts) ───────────────────────────┬───────────┤
          1E (proxy.ts) ─────────────────────────────────┘           │
                                                                     │
                                                          1C (role-context.tsx) ──┐
                                                             depends on 1B       │
                                                                                  │
                                                          1D (require-permission) ┘
                                                             depends on 1B + 1C
```

**Internal parallelism detail:**
```
  Parallel group 1:    1A ───┐
                       1B ───┼── (all 3 in parallel, no shared dependencies)
                       1E ───┘
                              │
  Sequential group:    1C ────┤  (needs 1B: permission types)
                              │
                       1D ────┘  (needs 1B + 1C: types + context)
```

---

### Window 2: Layout Conversion (Phase 2 — Sequential After Phase 1)

**Concurrency:** Up to 2 subphases in parallel, then sequential assembly.

Phase 2 converts the workspace layout from a client component to an RSC with server-side access checks. The shell and not-provisioned screen can be extracted in parallel, then the layout itself depends on both.

```
Timeline:                     ██████████████████████████████████
                              2A (workspace-shell.tsx) ──────────────┐
                              2B (not-provisioned-screen.tsx) ───────┤  (2A + 2B parallel)
                                                                     │
                                                          2C (layout.tsx RSC) ──┐
                                                             depends on 2A + 2B │
                                                                                 │
                                                          2D (verify) ──────────┘
                                                             depends on 2C
```

**Internal parallelism detail:**
```
  Parallel group:      2A ───┐
                       2B ───┘  (independent component extractions)
                              │
  Sequential:          2C ────┤  (assembles 2A + 2B into RSC layout)
                       2D ────┘  (integration verification)
```

---

### Window 3: Maximum Parallelism (Phase 3 — 9 Independent Page Conversions)

**Concurrency:** Up to 9 completely independent subphases running simultaneously.

This is the **maximum parallelism window**. All 9 subphases touch completely different route directories. Zero shared files, zero merge conflicts. Each subphase wraps a single page with an RSC authorization gate and moves client code into a `_components/` subdirectory.

```
Timeline:                                           ████████████████████████████████████████████████
                                                    3A (team page) ──────────────────────────────┐
                                                    3B (settings page) ──────────────────────────┤
                                                    3C (pipeline page) ──────────────────────────┤
                                                    3D (admin dashboard) ────────────────────────┤
                                                    3E (closer dashboard) ───────────────────────┤  ALL 9 IN
                                                    3F (closer pipeline) ────────────────────────┤  PARALLEL
                                                    3G (meeting detail) ─────────────────────────┤
                                                    3H (profile page) ──────────────────────────┤
                                                    3I (admin page) ─────────────────────────────┘
```

**Internal parallelism detail:**
```
  Each subphase is a self-contained unit:
    3X = create RSC wrapper (page.tsx) + move client code to _components/ + preload queries

  No ordering constraints:
    3A ─── /workspace/team/
    3B ─── /workspace/settings/
    3C ─── /workspace/pipeline/
    3D ─── /workspace/ (dashboard)
    3E ─── /workspace/closer/
    3F ─── /workspace/closer/pipeline/
    3G ─── /workspace/closer/meetings/[meetingId]/
    3H ─── /workspace/profile/
    3I ─── /admin/
```

---

### Window 4: Dual-Track (Phase 4 + Phase 5 — In Parallel After Phase 3)

**Concurrency:** 2 completely independent streams running simultaneously.

After Phase 3 completes, Phase 4 (client affordance cleanup) and Phase 5 (session freshness) are **completely independent tracks**. Phase 4 removes scattered role checks from UI components. Phase 5 adds `router.refresh()` calls to dialog success handlers.

**One conflict:** `role-edit-dialog.tsx` is modified by both Phase 4B (role check cleanup) and Phase 5A (add router.refresh). Resolution: Phase 4B runs first, Phase 5A applies on top.

```
Timeline:                                                                              ██████████████████████████████████████
                                                                                       Stream A: Phase 4 (Client Affordance) ──────┐
                                                                                       Stream B: Phase 5 (Session Freshness) ──────┘
                                                                                                                                    │
                                                                                       Conflict resolution:                         │
                                                                                       role-edit-dialog.tsx: 4B first, then 5A      │
                                                                                                                                    ▼
                                                                                                                              Window 5
```

**Within Phase 4 (internal parallelism):**
```
  4A (audit) ─────────────────────────────┐  (must run first — identifies all targets)
                                          │
                               4B ────────┤
                               4C ────────┤  (4B + 4C + 4D all parallel after 4A)
                               4D ────────┘
```

**Within Phase 5 (internal parallelism):**
```
  5A (dialog refresh handlers) ──────────┐
  5B (nav update after role change) ─────┤  (5A + 5B in parallel)
                                         │
                              5C (verify) ┘  (depends on 5A + 5B)
```

---

### Window 5: Optional Extension (Phase 6 — Sequential After Phase 5)

**Concurrency:** 2 subphases in parallel after initial setup, then verification.

Phase 6 is optional and runs last. It promotes CRM role checks to WorkOS permission slug checks behind a feature flag, enabling centralized permission management. Internal parallelism: session refresh and auth.ts promotion can proceed in parallel after the permission mapping is created.

```
Timeline:                                                                                                                     ██████████████████████████████████
                                                                                                                              6A (WorkOS permission slugs) ──────┐
                                                                                                                                                                 │
                                                                                                                              6B (session refresh) ──────────────┤  (6B + 6C parallel)
                                                                                                                              6C (promote in auth.ts) ───────────┤
                                                                                                                                                                 │
                                                                                                                              6D (verify) ────────────────────────┘
                                                                                                                                 depends on 6B + 6C
```

**Internal parallelism detail:**
```
  Sequential:          6A ────┐  (creates workos-permissions.ts mapping)
                              │
  Parallel group:      6B ────┤  (session refresh integration)
                       6C ────┘  (promote checks in lib/auth.ts)
                              │
  Sequential:          6D ────┘  (end-to-end verification with feature flag)
```

---

## Critical Path Analysis

The **critical path** (longest sequential chain determining minimum implementation time):

```
Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 5 ──→ Phase 6
  │            │            │            │            │
  │            │            │            │            └── WorkOS permission promotion (optional)
  │            │            │            └── Session freshness (dialog refresh + nav update)
  │            │            └── 9 page wrappers (max parallelism opportunity)
  │            └── RSC layout conversion (workspace-shell + layout.tsx)
  └── Foundation (auth.ts + permissions + context + proxy)
```

**Alternative shorter path (terminates at Phase 4):**
```
Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4
                                       │
                                       └── Client affordance cleanup (no downstream deps)
```

Phase 4 and Phase 5 can run in parallel after Phase 3. The critical path runs through Phase 5 because Phase 6 depends on it.

**Implication:** Phase 4 is off the critical path. If time is limited, Phase 4 can be deferred or deprioritized without affecting the Phase 5 → Phase 6 chain.

---

## File Ownership Boundaries (Merge Conflict Prevention)

When running phases in parallel, each phase owns specific files to prevent conflicts:

| Directory/File | Phase Owner | Notes |
|---|---|---|
| `lib/auth.ts` | **Phase 1 (create)**, Phase 6 (modify) | Server access layer. Phase 6 adds WorkOS permission checks behind feature flag. |
| `convex/lib/permissions.ts` | **Phase 1 only** | Permission vocabulary. Created once, consumed everywhere. |
| `components/auth/role-context.tsx` | **Phase 1 only** | Client role provider context. |
| `components/auth/require-permission.tsx` | **Phase 1 only** | Permission gate component for client use. |
| `proxy.ts` | **Phase 1 only** | Proxy upgrade for auth route handling. |
| `app/workspace/layout.tsx` | **Phase 2 only** | RSC conversion. Not modified by later phases. |
| `app/workspace/_components/workspace-shell.tsx` | **Phase 2 (create)**, Phase 4 (modify), Phase 5 (add TODO comment) | Client shell. Sequenced: 2 → 4 → 5. |
| `app/workspace/_components/not-provisioned-screen.tsx` | **Phase 2 only** | Extracted component for unprovisioned tenants. |
| `app/workspace/page.tsx` | **Phase 3D only** | Admin dashboard RSC wrapper. |
| `app/workspace/team/page.tsx` | **Phase 3A only** | Team page RSC wrapper. |
| `app/workspace/team/_components/team-page-client.tsx` | **Phase 3A (create)** | Moved client page content. |
| `app/workspace/team/_components/role-edit-dialog.tsx` | **Phase 4B (modify)**, Phase 5A (modify) | Sequenced: 4B first (role check cleanup), then 5A (add router.refresh). |
| `app/workspace/team/_components/remove-user-dialog.tsx` | **Phase 5A only** | Add router.refresh on success. |
| `app/workspace/team/_components/invite-user-dialog.tsx` | **Phase 5A only** | Add router.refresh on success. |
| `app/workspace/pipeline/page.tsx` | **Phase 3C only** | Pipeline RSC wrapper. |
| `app/workspace/settings/page.tsx` | **Phase 3B only** | Settings RSC wrapper. |
| `app/workspace/closer/page.tsx` | **Phase 3E only** | Closer dashboard RSC wrapper. |
| `app/workspace/closer/pipeline/page.tsx` | **Phase 3F only** | Closer pipeline RSC wrapper. |
| `app/workspace/closer/meetings/[meetingId]/page.tsx` | **Phase 3G only** | Meeting detail RSC wrapper. |
| `app/workspace/profile/page.tsx` | **Phase 3H only** | Profile RSC wrapper. |
| `app/admin/page.tsx` | **Phase 3I only** | Admin RSC wrapper. |
| `components/command-palette.tsx` | **Phase 4C only** | Drop isAdmin prop, consume context instead. |
| `lib/workos-permissions.ts` | **Phase 6A only** | WorkOS permission slug mapping. New file. |

---

## Recommended Execution Strategies

### Solo Developer

Execute in order, leveraging within-phase parallelism for efficient context-switching:

1. **Phase 1** — all subphases (1A, 1B, 1E in parallel, then 1C, then 1D)
2. **Phase 2** — layout conversion (2A + 2B, then 2C, then 2D)
3. **Phase 3** — 9 page conversions (batch by complexity: simpler pages first for momentum)
4. **Phase 4 + Phase 5 interleaved** — do 4A audit, then alternate between 4B/4C/4D and 5A/5B, finish with 5C
5. **Phase 6** (optional) — 6A, then 6B + 6C, then 6D

**Estimated time:** 7-12 days (excluding Phase 6: 5-9 days)

### Two Developers

| Sprint | Developer A | Developer B |
|---|---|---|
| **1** | Phase 1A, 1B, 1C, 1D (auth + permissions + context) | Phase 1E (proxy) |
| **2** | Phase 2A, 2C (workspace-shell + layout) | Phase 2B (not-provisioned-screen) |
| **3** | Phase 3A, 3B, 3C, 3D, 3H (5 pages) | Phase 3E, 3F, 3G, 3I (4 pages) |
| **4** | Phase 4 (full client affordance cleanup) | Phase 5 (full session freshness) |
| **5** | Phase 6A, 6C (optional: slugs + auth.ts) | Phase 6B, 6D (optional: refresh + verify) |

**Estimated time:** ~5-7 days (excluding Phase 6: ~4-5 days)

### Three+ Developers / Agents

| Sprint | Agent A | Agent B | Agent C |
|---|---|---|---|
| **1** | Phase 1A (lib/auth.ts) | Phase 1B, 1C, 1D (permissions + context + gates) | Phase 1E (proxy) |
| **2** | Phase 2A + 2C (shell + layout) | Phase 2B (not-provisioned) | -- (blocked on Phase 2) |
| **3** | Phase 3A, 3B, 3C (team, settings, pipeline) | Phase 3D, 3E, 3F (dashboard, closer, closer pipeline) | Phase 3G, 3H, 3I (meeting, profile, admin) |
| **4** | Phase 4 (client affordance) | Phase 5 (session freshness) | Phase 6A (optional: WorkOS slugs) |
| **5** | -- | Phase 6B + 6D (optional: refresh + verify) | Phase 6C (optional: promote in auth.ts) |

**Estimated time:** ~4-5 days (excluding Phase 6: ~3-4 days)

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 1** | After Phase 1 | `pnpm tsc --noEmit` passes. `lib/auth.ts` exports compile. `proxy.ts` handles all route families correctly (public, workspace, admin, API). Permission types resolve. `RoleProvider` and `RequirePermission` render without error. |
| **Gate 2** | After Phase 2 | Workspace layout renders as RSC. System admin redirected to `/admin`. Pending tenant redirected to `/onboarding/connect`. Not-provisioned screen shows for unprovisioned users. Sidebar, keyboard shortcuts, command palette all functional. Soft navigation intact. |
| **Gate 3** | After Phase 3 | Every workspace page authorizes on the server before content renders. No protected HTML leaks in initial response. Closer cannot access admin routes (403/redirect). Admin cannot access closer routes (403/redirect). Preloaded data appears on first paint without loading spinners. |
| **Gate 4** | After Phase 4 + 5 | No scattered `currentUser?.role` checks remain in client components (except where non-role fields are needed). `router.refresh()` fires after role changes in all dialogs. Nav items update immediately after role changes without full page reload. |
| **Gate 5** | After Phase 6 | WorkOS permissions control server access when feature flag is on. CRM role-based auth resumes when feature flag is off. Session refresh keeps permission claims fresh. Rollback to CRM-only mode is instant via flag toggle. |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| proxy.ts change breaks auth flow | **Critical** | Test all route families (public, workspace, admin, API) before merging Phase 1. Keep `authkitProxy` as commented fallback for instant rollback. |
| Server-side invite claim fails | **High** | `resolveCrmUser` has fallback — if claim resolution fails, returns null and shows not-provisioned screen. Log errors for debugging. |
| Preloaded query token mismatch | **Medium** | Always pass `{ token: session.accessToken }` from the RSC wrapper. TypeScript will catch missing tokens at compile time via type constraints. |
| Layout conversion breaks soft navigation | **Medium** | Test keyboard shortcuts, breadcrumbs, command palette after Phase 2. The client shell preserves all client state across navigations. |
| Phase 4 + Phase 5 file conflict on role-edit-dialog.tsx | **Low** | Sequence: Phase 4B modifies role checks first, Phase 5A adds `router.refresh()` second. Communicate ordering between developers/agents. |
| WorkOS permission promotion causes stale sessions | **High** | Feature flag allows instant rollback. Both server-side and client-side refresh mechanisms required. Test with flag on and off before promoting to production. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | `workos`, `convex-setup-auth` | AuthKit session handling for `lib/auth.ts`, Convex auth integration for `permissions.ts`. |
| **2** | `vercel-react-best-practices`, `vercel-composition-patterns` | RSC/client boundary extraction for layout conversion, composition patterns for workspace-shell. |
| **3** | `vercel-react-best-practices` | RSC wrappers with `preloadQuery` patterns for each page conversion. |
| **4** | `vercel-composition-patterns` | Component refactoring, context consumption patterns for removing prop-drilled role checks. |
| **5** | `workos` | Session refresh APIs from AuthKit for `router.refresh()` integration. |
| **6** | `workos`, `convex-setup-auth` | WorkOS permission slugs for mapping, session management for refresh lifecycle. |

---

*This strategy maximizes parallelization while respecting critical dependencies. The key insight: Phase 3 is the maximum parallelism window with 9 fully independent page conversions. Phase 4 (client cleanup) and Phase 5 (session freshness) are independent tracks after Phase 3, with only a single file conflict (`role-edit-dialog.tsx`) requiring sequenced application. Phase 6 is optional and gated behind a feature flag for safe rollback.*
