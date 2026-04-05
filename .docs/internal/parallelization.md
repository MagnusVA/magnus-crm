# Parallelization Strategy — Prompt & Template

**Purpose:** This document defines the prompt, structural template, and quality standards for creating a parallelization strategy. The parallelization strategy is a **standalone document** that sits alongside the phase plans and provides the execution roadmap — which phases and subphases can run simultaneously, the critical path, file ownership boundaries, team allocation, and quality gates.

---

## When to Use

Create a parallelization strategy when:

- The feature has 3+ phases
- Phases have internal subphases that can run concurrently
- Multiple developers or agents will work on the feature simultaneously
- You need to identify the critical path and optimize total delivery time

The parallelization strategy lives at:

```
plans/{feature-name}/phases/parallelization-strategy.md
```

---

## Prompt

Use the following prompt:

```
I need a parallelization strategy for the {FEATURE_NAME} implementation.

**Design document:** Read `plans/{feature-name}/{feature-name}-design.md` for the full scope.
**Phase plans:** Read `plans/{feature-name}/phases/phase*.md` for all phase details.

**Context:**
- This feature has {N} phases: {list phase names}.
- {Any constraints: "Phases 2 and 3 touch different directories", "Phase 4 and 5 serve different user roles", etc.}

Produce a parallelization strategy at `plans/{feature-name}/phases/parallelization-strategy.md` following this exact structure:

1. **Header** — Purpose statement, prerequisite (what must exist before any phase starts).

2. **Phase Overview Table** — All phases in a single table. Columns: Phase number, Name, Type (Backend / Full-Stack / Frontend), Estimated Complexity (Low / Medium / Medium-High / High), Dependencies (which phases must complete first).

3. **Master Dependency Graph** — A large ASCII box diagram showing ALL phases and their dependency relationships. Each phase is a labeled box. Arrows show dependencies. Phases at the same horizontal level can run in parallel.

4. **Maximum Parallelism Windows** — Numbered windows (Window 1, Window 2, etc.), each representing a time period where specific phases/subphases can run simultaneously. For each window:
   - Window name and description.
   - **Concurrency:** How many independent streams run simultaneously.
   - Explanation of why the phases in this window are independent (different directories, different user roles, no shared state).
   - ASCII timeline diagram showing the phases in this window.
   - **Internal parallelism:** Sub-diagram showing which subphases within each phase can run in parallel.

5. **Critical Path Analysis** — The longest sequential chain that determines minimum delivery time. Show it as an ASCII diagram with the phases on the critical path. Identify the shorter alternative paths. State the implication (e.g., "Start Phase 3 as early as possible — it's on the critical path").

6. **File Ownership Boundaries** — A table showing which phase "owns" each directory or file, to prevent merge conflicts during parallel execution. Columns: Directory/File, Phase Owner, Notes. This is critical for parallel work — if two phases touch the same file, they cannot truly run in parallel.

7. **Recommended Execution Strategies** — Three subsections:
   - **Solo Developer:** Optimal sequence leveraging within-phase parallelism.
   - **Two Developers:** Sprint-by-sprint allocation table (Sprint | Dev A | Dev B).
   - **Three+ Developers/Agents:** Sprint-by-sprint allocation table with more columns.
   Each includes an estimated total time.

8. **Quality Gates** — A table of checkpoints after each major milestone. Columns: Gate name, Trigger (after which phase), Checks (what to verify). These are the "stop and verify" points before proceeding.

9. **Risk Mitigation** — A table of risks. Columns: Risk, Impact (Critical / High / Medium), Mitigation strategy.

10. **Applicable Skills Per Phase** — A table mapping skills to phases. Columns: Phase, Skills to Invoke, Reason.

**Formatting rules:**
- ASCII art for all diagrams (no Mermaid in this document — it should render in any markdown viewer).
- Box-drawing characters for the master dependency graph.
- Timeline bars (████) for window diagrams.
- Tables with aligned pipes.
```

---

## Template Structure

```markdown
# Parallelization Strategy — {Feature Name}

**Purpose:** This document defines the parallelization strategy across all {N} implementation phases, identifying the critical path, dependency graph, and maximum concurrency opportunities.

**Prerequisite:** {What must exist before any phase starts — prior features, deployed schema, env vars, etc.}

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **1** | {Phase name} | Backend | Medium | {Prior feature phases} |
| **2** | {Phase name} | Backend | Medium-High | Phase 1 |
| **3** | {Phase name} | Backend | High | Phase 1 |
| **4** | {Phase name} | Full-Stack | High | Phase 1 + 2 |
| **5** | {Phase name} | Full-Stack | High | Phase 1 + 3 |
| **6** | {Phase name} | Full-Stack | Medium | Phase 5 |
| **7** | {Phase name} | Full-Stack | Medium | Phase 6 |

---

## Master Dependency Graph

```
                    ┌──────────────────────────────────────────────────────────────────┐
                    │                         PHASE 1                                  │
                    │  {Phase 1 Name} (FOUNDATION)                                     │
                    └──────────┬───────────────────┬───────────────────────────────────┘
                               │                   │
                    ┌──────────▼──────────┐ ┌──────▼──────────┐
                    │     PHASE 2         │ │    PHASE 3      │
                    │  {Phase 2 Name}     │ │  {Phase 3 Name} │
                    │  (Backend only)     │ │  (Backend only) │
                    └──────────┬──────────┘ └──────┬──────────┘
                               │                   │
                    ┌──────────▼──────────┐ ┌──────▼──────────┐
                    │     PHASE 4         │ │    PHASE 5      │
                    │  {Phase 4 Name}     │ │  {Phase 5 Name} │
                    │  (Full-Stack)       │ │  (Full-Stack)   │
                    └─────────────────────┘ └──────┬──────────┘
                                                   │
                                            ┌──────▼──────────┐
                                            │    PHASE 6      │
                                            │  {Phase 6 Name} │
                                            └──────┬──────────┘
                                                   │
                                            ┌──────▼──────────┐
                                            │    PHASE 7      │
                                            │  {Phase 7 Name} │
                                            └─────────────────┘
```

---

## Maximum Parallelism Windows

### Window 1: {Name} (Sequential Foundation — Must Complete First)

**Concurrency:** Up to {N} subphases in parallel within Phase 1.

Phase 1 is the critical foundation. Everything blocks on it. However, after the schema ({N}A) deploys, subphases {N}B, {N}C, {N}D, and {N}E can all run simultaneously. The frontend shell ({N}F) depends only on {N}C.

```
Timeline: ████████████████████████████
          1A (schema)  ───────────────┐
                                      ├── 1B (auth guard) ──────────────────┐
                                      ├── 1C (user queries) ────────────────┤
                                      ├── 1D (status validation) ──────────┤── 1F (workspace layout shell)
                                      └── 1E (role mapping utils) ─────────┘
```

---

### Window 2: {Name} (Full Parallelism)

**Concurrency:** {N} completely independent streams running simultaneously.

After Phase 1 completes, Phase 2 and Phase 3 have **zero shared dependencies**. They touch entirely different directories:

- **Phase 2** works in `convex/{dir-a}/`, `convex/{dir-b}/`
- **Phase 3** works in `convex/{dir-c}/`, `convex/{dir-d}/`

No merge conflicts possible. No shared state.

```
Timeline:                    ██████████████████████████████████████
                             Phase 2 ({name})  ──────────────────────┐
                             Phase 3 ({name})  ──────────────────────┤
                                                                     ▼
                                                              Window 3
```

**Within Phase 2 (internal parallelism):**
```
2A ({name}) ─────────────────────────┐
2B ({name}) ─────────────────────────┤  (2A+2B in parallel)
                                     │
                                     ├── 2C ({name} — needs 2A, 2B)
                                     │
2D ({name}) ─────────────────────────┤  (parallel with everything above)
                                     │
                                     └── 2E ({name} — needs 2C, 2D)
```

**Within Phase 3 (internal parallelism):**
```
3A ({name}) ──────────────────────────┐
                                      ├── 3B ({name}) ──┐
                                      │                  ├── 3C ({name}) ──┐
                                      │                  ├── 3D ({name}) ─┤── 3F ({name})
                                      │                  └── 3E ({name}) ──┘
                                      └─────────────────────────────────────┘
```

---

### Window 3: {Name} (Full-Stack Parallelism)

**Concurrency:** {N} completely independent full-stack streams.

Phase 4 and Phase 5 are **completely independent UI surfaces** serving different user roles:

- **Phase 4** builds pages at: `/workspace/{admin-routes}`
- **Phase 5** builds pages at: `/workspace/{closer-routes}`

No shared components (other than the workspace layout shell built in Phase 1).

```
Timeline:                                         ████████████████████████████████████████
                                                  Phase 4 ({name})  ─────────────────────┐
                                                  Phase 5 ({name})  ─────────────────────┤
                                                                                          ▼
                                                                                   Window 4
```

**Within each phase (backend first, then frontend in parallel):**
```
{N}A (backend query 1) ──────────────┐
{N}B (backend query 2) ──────────────┤  (all backend parallel)
{N}C (backend query 3) ──────────────┤
                                     │
                                     ├── {N}D (frontend page 1) ──────┐
                                     ├── {N}E (frontend page 2) ──────┤  (all frontend parallel)
                                     ├── {N}F (frontend page 3) ──────┤
                                     └── {N}G (frontend page 4) ──────┘
```

---

### Window 4+: Sequential Extensions

For phases that extend earlier work (e.g., meeting detail extends closer dashboard):

```
Timeline:                                                                          ██████████████████████
                                                                                   {N}A (backend) ──────┐
                                                                                   {N}B (backend) ──────┤
                                                                                                        │
                                                                                                        ├── {N}C (frontend) ──┐
                                                                                                        └── {N}D (frontend) ──┘
```

---

## Critical Path Analysis

The **critical path** (longest sequential chain determining minimum implementation time):

```
Phase 1 → Phase 3 → Phase 5 → Phase 6 → Phase 7
  │          │          │         │         │
  │          │          │         │         └── {Phase 7 description}
  │          │          │         └── {Phase 6 description}
  │          │          └── {Phase 5 description}
  │          └── {Phase 3 description}
  └── {Phase 1 description}
```

**Alternative shorter path:**
```
Phase 1 → Phase 2 → Phase 4
```

This path is shorter, meaning the {alternative path feature} is available sooner for testing.

**Implication:** Start Phase 3 as early as possible after Phase 1 completes. It is on the critical path and determines the minimum delivery time.

---

## File Ownership Boundaries (Merge Conflict Prevention)

When running phases in parallel, each phase owns specific directories to prevent conflicts:

| Directory/File | Phase Owner | Notes |
|---|---|---|
| `convex/schema.ts` | **Phase 1 only** | All schema changes happen in Phase 1. |
| `convex/{guard}.ts` | **Phase 1 only** | Created once, consumed by all subsequent phases. |
| `convex/{dir-a}/` | **Phase 2 only** | New directory. |
| `convex/{dir-b}/` | **Phase 3 only** | New directory. |
| `convex/{dir-c}/` | **Phase 5 (create) -> Phase 6 (extend) -> Phase 7 (extend)** | Separate files per phase. No file overlap. |
| `app/workspace/layout.tsx` | **Phase 1** | Created once. Not modified by later phases. |
| `app/workspace/{admin-routes}/` | **Phase 4** | Admin UI. |
| `app/workspace/{closer-routes}/` | **Phase 5** | Closer UI. |

---

## Recommended Execution Strategies

### Solo Developer

Execute in order, leveraging within-phase parallelism for efficient context-switching:

1. **Phase 1** — all subphases (schema first, then rest)
2. **Phase 2** — backend stream A
3. **Phase 3** — backend stream B (interleave with Phase 2 review)
4. **Phase 4 backend** -> **Phase 5 backend** (batch all backend work)
5. **Phase 4 frontend** -> **Phase 5 frontend** (batch all frontend work)
6. **Phase 6** — detail page
7. **Phase 7** — final features

**Estimated time:** {N-M} days

### Two Developers (Backend + Frontend)

| Sprint | Developer A (Backend) | Developer B (Frontend) |
|---|---|---|
| 1 | Phase 1A-1E (all backend) | Phase 1F (workspace layout — blocked until 1C) |
| 2 | Phase 2 (full) + Phase 3 (full) in parallel | Phase 4 frontend (can stub backend calls) |
| 3 | Phase 5A-5C (backend) | Phase 4 frontend (complete) + Phase 5D-5F (frontend) |
| 4 | Phase 6A-6B + Phase 7A-7C (backend) | Phase 6C-6D + Phase 7D-7E (frontend) |
| 5 | Integration testing | Integration testing |

**Estimated time:** {N-M} days

### Three+ Developers / Agents

| Sprint | Agent A (Backend - Path 1) | Agent B (Backend - Path 2) | Agent C (Frontend) |
|---|---|---|---|
| 1 | Phase 1A, 1B, 1D, 1E | Phase 1C | -- (blocked on 1) |
| 2 | Phase 2 (full) | Phase 3 (full) | Phase 1F (workspace shell) |
| 3 | Phase 4 backend | Phase 5 backend | Phase 4 frontend |
| 4 | Phase 7 backend | Phase 6 backend | Phase 5 frontend |
| 5 | Integration + testing | -- | Phase 6 + 7 frontend |

**Estimated time:** {N-M} days

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 1** | After Phase 1 | `npx convex dev` succeeds. `pnpm tsc --noEmit` passes. Auth guard works. Workspace layout renders. |
| **Gate 2** | After Phase 2 + 3 | {Feature-specific verification — e.g., "Invite a test user -> CRM user created."} |
| **Gate 3** | After Phase 4 + 5 | {Feature-specific verification — e.g., "Admin dashboard loads with stats."} |
| **Gate 4** | After Phase 6 | {Feature-specific verification.} |
| **Gate 5** | After Phase 7 | {Feature-specific verification — e.g., "Full end-to-end flow works."} |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Phase 1 schema errors block everything | **Critical** | Deploy schema immediately after writing. Run `npx convex dev` before proceeding. |
| External API rate limits during testing | Medium | Use sandbox environment. Add retry with exponential backoff. |
| Pipeline bugs corrupt data | High | Include idempotency checks. Preserve raw events for safe replay. |
| Frontend built against missing backend | Medium | Phase plans list which backend functions each frontend subphase depends on. Frontend can start with stub data. |
| Component complexity exceeds estimate | Medium | Use shadcn/ui primitives. Avoid third-party library dependencies for MVP. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | `convex-setup-auth` | Auth guard references JWT claims. |
| **2** | `workos` | Programmatic user management via WorkOS Node SDK. |
| **3** | -- | Pure Convex backend. Refer to `.docs/` for webhook shapes. |
| **4** | `frontend-design`, `shadcn`, `vercel-react-best-practices`, `web-design-guidelines` | Full dashboard UI. |
| **5** | `frontend-design`, `shadcn`, `web-design-guidelines` | Closer dashboard with calendar. |
| **6** | `frontend-design`, `shadcn`, `web-design-guidelines` | Detail page with action bars. |
| **7** | `frontend-design`, `shadcn`, `web-design-guidelines` | Forms and dialogs. |

---

*This strategy maximizes parallelization while respecting critical dependencies. The key insight: identify pairs of phases that touch entirely different directories and user roles — these can always run in parallel.*
```

---

## Key Principles

These principles were extracted from the actual parallelization strategy used in `plans/closer-tenant-admin/phases/parallelization-strategy.md`:

### 1. Three Questions for Every Subphase

Before deciding if a subphase can run in parallel, ask:

1. **Does it depend on code from another subphase?** (imports, types, function calls)
   - Yes -> must wait until that subphase merges
   - No -> can start immediately

2. **Does it modify the same file as another subphase?** (merge conflict risk)
   - Yes -> sequence them or split the file
   - No -> can run in parallel

3. **Does it read/write the same database table/index?** (schema deployment)
   - Yes -> wait for schema to deploy
   - No -> can run in parallel

### 2. Parallelism Patterns in Our Codebase

**Backend-Backend Parallelism:** Phases that touch different `convex/` directories with no shared imports.
- Example: Phase 2 (`convex/workos/`, `convex/users/`) || Phase 3 (`convex/pipeline/`, `convex/webhooks/`)

**Frontend-Frontend Parallelism:** Phases that build different `app/` routes for different user roles.
- Example: Phase 4 (`app/workspace/{admin}`) || Phase 5 (`app/workspace/closer/`)

**Backend-then-Frontend within a Phase:** Backend subphases run first (queries, mutations), then frontend subphases run in parallel consuming those backends.
- Example: 4A+4B+4C (backend, parallel) -> 4D+4E+4F+4G (frontend, parallel)

### 3. File Ownership is Non-Negotiable

The file ownership table is the most important section for preventing merge conflicts. Rules:

- `convex/schema.ts` is **always** owned by Phase 1. No other phase modifies it.
- Each new `convex/{feature}/` directory is owned by the phase that creates it. Later phases add **new files** to the directory (never modify existing files from other phases).
- `app/workspace/layout.tsx` is owned by Phase 1. Later phases do not modify it.
- Each `app/workspace/{route}/` directory is owned by one phase.

### 4. Quality Gates are Deployment Checkpoints

Each quality gate verifies that the system is in a known-good state before proceeding. The gate checks should be:
- **Automated where possible:** `npx convex dev`, `pnpm tsc --noEmit`, test suite
- **Manual where necessary:** "Navigate to `/workspace`, verify layout renders"
- **Feature-specific:** "Invite a test user, verify CRM record is created before they log in"

---

## Quality Checklist

Before considering the parallelization strategy complete, verify:

- [ ] Phase Overview table includes all phases with type, complexity, and dependencies
- [ ] Master Dependency Graph shows all phases as boxes with arrows
- [ ] Every parallelism window explains WHY the phases are independent (different dirs, different roles)
- [ ] Internal parallelism diagrams exist for each window (showing subphase-level concurrency)
- [ ] Critical path is identified and annotated with the implication ("Start X early")
- [ ] Alternative shorter paths are noted
- [ ] File ownership table covers every shared/contested file
- [ ] Three execution strategies exist (solo, two devs, three+ devs) with estimated timelines
- [ ] Quality gates have concrete checks (not just "verify it works")
- [ ] Risk mitigation covers: schema errors, API limits, data corruption, stale frontend, complexity overrun
- [ ] Applicable skills are mapped to phases
- [ ] ASCII art diagrams render correctly in plain markdown (no Mermaid in this document)
