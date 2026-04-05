# Phase Plan Creation — Prompt & Template

**Purpose:** This document defines the prompt, structural template, and quality standards for creating detailed phase plans from a design document. Each phase plan "zooms in" on a single phase from the design, breaking it into parallelizable subphases with concrete implementation guidance.

---

## When to Use

Create phase plans **after** the design document is finalized. Each major phase identified in the design becomes its own markdown file at:

```
plans/{feature-name}/phases/phase{N}.md
```

---

## Prompt

Use the following prompt (adapt the `{placeholders}` to your phase):

```
I need a detailed phase plan for Phase {N} of the {FEATURE_NAME} feature.

**Design document:** Read `plans/{feature-name}/{feature-name}-design.md` — specifically
the section for Phase {N} and the Data Model section.

**Context:**
- Read the existing codebase at {relevant directories} to understand the current state.
- This phase's design section describes {summary of what the phase covers}.
- {Any constraints: "schema must deploy first", "runs in parallel with Phase M", etc.}

Produce a phase plan at `plans/{feature-name}/phases/phase{N}.md` following this exact structure:

1. **Header** — `# Phase {N} — {Phase Name}` followed by:
   - **Goal:** 1-2 sentences describing what this phase accomplishes.
   - **Prerequisite:** What must be done before this phase starts (prior phases, schema deployment, env vars).
   - **Runs in PARALLEL with:** Which other phases can execute simultaneously (or "Nothing" if this is a foundation phase).
   - **Skills to invoke:** List of Claude Code skills relevant to this phase.

2. **Acceptance Criteria** — 5-10 numbered, testable, pass/fail statements. Each should be verifiable
   without looking at code — describe the observable behavior or state.
   Always end with: `N. pnpm tsc --noEmit passes without errors.`

3. **Subphase Dependency Graph** — An ASCII art diagram showing:
   - Which subphases can run in parallel (same horizontal level).
   - Which subphases block others (arrows).
   - Optimal execution order annotation below the diagram.
   - Estimated time for the phase.

4. **Subphases** — Break the phase into 4-7 focused subphases (labeled {N}A, {N}B, {N}C, etc.).
   Each subphase has this exact structure:

   ```
   ### {N}A — {Subphase Name}

   **Type:** Backend / Frontend / Full-Stack / Manual / Config
   **Parallelizable:** Yes/No — {brief reason referencing what it depends on or what depends on it}

   **What:** {Concrete deliverable — specific files, functions, components.}

   **Why:** {Motivation — what this enables, what breaks without it.}

   **Where:**
   - `{exact/file/path.ts}` ({new / modify})
   - `{exact/file/path.tsx}` ({new / modify})

   **How:**

   {Step-by-step implementation with realistic TypeScript code examples.
   Every code block has a `// Path: {file}` comment on the first line.
   Show before/after pairs for modifications.
   Include inline comments explaining decisions.}

   **Key implementation notes:**
   - {Important detail 1}
   - {Important detail 2}
   - {Edge case and how to handle it}

   **Files touched:**

   | File | Action | Notes |
   |---|---|---|
   | `{path}` | Create / Modify / Delete | {Brief description} |
   ```

5. **Phase Summary** — A combined table showing all files modified/created across all subphases:

   | File | Action | Subphase |
   |---|---|---|
   | `{path}` | Create | {N}A |
   | `{path}` | Modify | {N}C |

**Formatting rules:**
- Use GitHub-flavored Markdown.
- Code blocks with `typescript`, `tsx`, `css`, `bash` language tags.
- Every code example has a `// Path:` comment.
- Show complete, realistic code — not pseudo-code. Include types, validators, imports.
- For modifications, show the relevant section (not the entire file), with enough surrounding
  context to locate where the change goes.
- Step-by-step instructions within "How" should be numbered: **Step 1**, **Step 2**, etc.
```

---

## Template Structure

```markdown
# Phase {N} — {Phase Name}

**Goal:** {1-2 sentences on what this phase accomplishes and what state the system is in after completion.}

**Prerequisite:** {What must be done first — specific phases, schema deployments, env vars.}

**Runs in PARALLEL with:** {Other phases that can execute simultaneously, or "Nothing — all subsequent phases depend on this."}

**Skills to invoke:**
- `{skill-1}` — {why this skill is needed for this phase}
- `{skill-2}` — {why}

**Acceptance Criteria:**
1. {Observable behavior or state — e.g., "`npx convex dev` runs without schema errors."}
2. {Observable behavior — e.g., "`requireTenantUser(ctx, ['tenant_master'])` correctly resolves a tenant user from a valid JWT."}
3. {Observable behavior — e.g., "Navigating to `/workspace` renders the layout shell with role-appropriate sidebar navigation."}
4. {Observable behavior — e.g., "All new indexes follow the Convex naming convention (`by_<field1>_and_<field2>`)."}
...
N. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
{N}A ({short name}) ───────────────────────────────────────┐
                                                           ├── {N}D ({short name} — depends on {N}B, {N}C)
{N}B ({short name}) ──────────────────────────────────────┤
                                                           │
{N}C ({short name}) ──────────────────────────────────────┘

{N}D complete ──→ {N}E ({short name — depends on {N}D})
```

**Optimal execution:**
1. Start {N}A, {N}B, {N}C all in parallel (they touch different files).
2. Once {N}B and {N}C are done -> start {N}D.
3. Once {N}D is done -> start {N}E.

**Estimated time:** {N-M} days

---

## Subphases

### {N}A — {Subphase Name}

**Type:** Backend
**Parallelizable:** No — must complete first. All other subphases depend on the generated types from this schema.

**What:** {Concrete deliverable.}

**Why:** {Motivation. E.g., "Every subsequent phase imports types from `convex/_generated/dataModel`. Without these table definitions, TypeScript compilation fails."}

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: {Description}**

```typescript
// Path: convex/schema.ts

// Add to the existing schema:
newTable: defineTable({
  tenantId: v.id("tenants"),
  fieldName: v.string(),
  status: v.union(
    v.literal("active"),
    v.literal("inactive"),
  ),
  createdAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_status", ["tenantId", "status"]),
```

**Step 2: Deploy and verify**

```bash
npx convex dev
```

Verify all tables are visible in the Convex dashboard.

**Key implementation notes:**
- {Important detail — e.g., "Keep all existing table definitions unchanged."}
- {Edge case — e.g., "`v.optional` because the field doesn't exist at record creation time."}

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add {N} new tables, modify tenants |

---

### {N}B — {Subphase Name}

**Type:** Backend
**Parallelizable:** Yes — independent of all other subphases except {N}A (schema).

**What:** {Concrete deliverable — e.g., "Auth guard function `requireTenantUser` in `convex/requireTenantUser.ts`."}

**Why:** {Motivation — e.g., "Every tenant-scoped function needs to verify the caller is authenticated and authorized. Centralizing this avoids copy-paste across 30+ functions."}

**Where:**
- `convex/requireTenantUser.ts` (new)

**How:**

```typescript
// Path: convex/requireTenantUser.ts

import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

type TenantUserResult = {
  userId: Id<"users">;
  tenantId: Id<"tenants">;
  role: "tenant_master" | "tenant_admin" | "closer";
};

export async function requireTenantUser(
  ctx: QueryCtx | MutationCtx,
  allowedRoles: Array<"tenant_master" | "tenant_admin" | "closer">,
): Promise<TenantUserResult> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");

  // ... resolve user from identity, validate role ...

  return { userId: user._id, tenantId: user.tenantId, role: user.role };
}
```

**Key implementation notes:**
- Returns `{ userId, tenantId, role }` — callers destructure what they need.
- Throws on failure (not null return) — fail loud for auth violations.
- Accepts `allowedRoles` array to restrict by role per-function.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/requireTenantUser.ts` | Create | Shared auth guard |

---

### {N}C — {Subphase Name}

**Type:** Frontend
**Parallelizable:** Yes — depends only on {N}B (queries), no overlap with {N}D.

**What:** {E.g., "Workspace layout shell with role-based sidebar navigation at `app/workspace/layout.tsx`."}

**Why:** {E.g., "All workspace pages nest inside this layout. Role detection here controls what nav items each user sees."}

**Where:**
- `app/workspace/layout.tsx` (new)

**How:**

**Step 1: Create the layout component**

```tsx
// Path: app/workspace/layout.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const user = useQuery(api.users.queries.getCurrentUser);

  if (user === undefined) return <WorkspaceSkeleton />;
  if (user === null) return null; // Not provisioned

  const isAdmin = user.role === "tenant_master" || user.role === "tenant_admin";
  const isCloser = user.role === "closer";

  return (
    <SidebarProvider>
      <Sidebar>
        {isAdmin && <NavLink href="/workspace">Overview</NavLink>}
        {isCloser && <NavLink href="/workspace/closer">Dashboard</NavLink>}
      </Sidebar>
      <main>{children}</main>
    </SidebarProvider>
  );
}
```

**Step 2: Verify in browser**

Navigate to `/workspace` — the layout should render with role-appropriate nav items.

**Key implementation notes:**
- `user === undefined` = query still loading (show skeleton).
- `user === null` = no CRM record found (user signed up outside normal flow).
- Sidebar nav items are conditionally rendered based on role, not hidden via CSS.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/layout.tsx` | Create | Workspace shell with role detection |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | {N}A |
| `convex/requireTenantUser.ts` | Create | {N}B |
| `convex/users/queries.ts` | Create | {N}B |
| `convex/lib/statusTransitions.ts` | Create | {N}C |
| `app/workspace/layout.tsx` | Create | {N}D |
```

---

## Structural Patterns Across Our Plans

These patterns were extracted from the actual phase files in `plans/sys-admin/phases/`, `plans/closer-tenant-admin/phases/`, and `plans/frontend-revamping/phases/`:

### Backend Phase Pattern

For phases that are purely backend (e.g., schema, auth guards, pipeline processing):

- Subphases are typically: Schema -> Auth guard -> Queries -> Mutations -> Actions -> Wire together
- Schema always comes first and blocks everything else
- Auth guards, queries, mutations, and utility functions can run in parallel after schema
- The "wire together" step (e.g., connecting webhook ingestion to pipeline dispatcher) comes last

### Full-Stack Phase Pattern

For phases with both backend and frontend (e.g., admin dashboard, closer dashboard):

- Backend subphases come first (queries, mutations)
- Frontend subphases come second (pages, components, dialogs)
- Backend subphases are parallelizable with each other
- Frontend subphases are parallelizable with each other
- Frontend subphases depend on their corresponding backend subphases

```
{N}A (backend query 1)  ──────┐
{N}B (backend query 2)  ──────┤── {N}D (frontend page — uses A, B)
{N}C (backend mutation)  ─────┤── {N}E (frontend page — uses B, C)
                               └── {N}F (frontend dialog — uses C)
```

### Frontend-Only Phase Pattern

For phases that modify only the frontend (e.g., typography fix, accessibility audit):

- Subphases are typically: Core change -> Dependent changes -> Documentation
- Independent changes (touching different files) can run in parallel
- Changes with cascading effects (e.g., status config that other components import) must come before their dependents

```
{N}A (typography fix)     ─────────────────┐
{N}B (status config)      ────────────────┤── {N}D (color audit — depends on B, C)
{N}C (CSS custom props)   ────────────────┘
                                           ���── {N}E (design doc rewrite — depends on D)
```

---

## Subphase Sizing Guide

| Size | Effort | Lines of Code | Typical Content |
|---|---|---|---|
| Small | < 2 hours | < 100 lines | Single utility function, config change, simple mutation |
| Medium | 2-6 hours | 100-400 lines | Query + mutation pair, single page component, auth guard |
| Large | 6-12 hours | 400+ lines | Full dashboard page, complex pipeline handler, multi-file refactor |

Aim for **4-7 subphases per phase**, with most being Small-Medium. If a subphase feels Large, consider splitting it.

---

## Cross-Phase Dependency Documentation

Every phase plan should include awareness of its position in the broader plan. The header section captures this:

```markdown
**Prerequisite:** Phase 1 complete (schema deployed, auth guard available).
**Runs in PARALLEL with:** Phase 3 (pipeline processing — zero shared files).
```

If the phase is on the **critical path**, note it:

```markdown
> **Critical path:** This phase is on the critical path (Phase 1 -> Phase 3 -> Phase 5 -> Phase 6 -> Phase 7).
> Start as early as possible after the prerequisite completes.
```

---

## Quality Checklist

Before considering a phase plan complete, verify:

- [ ] Goal is clear and describes the end state (not just "implement X")
- [ ] Prerequisite explicitly lists prior phases and any deployed artifacts
- [ ] Acceptance criteria are numbered, testable, and end with `pnpm tsc --noEmit`
- [ ] Dependency graph is ASCII art showing parallel/sequential relationships
- [ ] Optimal execution order is described below the graph
- [ ] Estimated time is provided
- [ ] Each subphase has: Type, Parallelizable (with reason), What, Why, Where (file paths), How (with code)
- [ ] Every code example has a `// Path:` comment and uses realistic TypeScript (not pseudo-code)
- [ ] Modifications show enough surrounding context to locate the change
- [ ] Each subphase has a "Files touched" table
- [ ] Phase Summary table lists all files across all subphases
- [ ] Key implementation notes call out edge cases and non-obvious decisions
- [ ] Skills to invoke are listed in the header
- [ ] The plan is self-contained — an implementer can follow it without re-reading the design document
