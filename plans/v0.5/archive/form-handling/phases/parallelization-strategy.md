# Parallelization Strategy — Form Handling Modernization

**Purpose:** This document defines the parallelization strategy across all 5 implementation phases of the Form Handling Modernization feature, identifying the critical path, dependency graph, and maximum concurrency opportunities.

**Prerequisite:** Nothing — Phase 1 (Infrastructure Setup) is the foundation with no external dependencies. This feature is the first phase of v0.5 and has no prior feature prerequisites.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **1** | Infrastructure Setup | Config | Low | None |
| **2** | Payment Form Dialog Migration | Frontend | Medium-High | Phase 1 |
| **3** | Invite User Dialog Migration | Frontend | Medium | Phase 1 |
| **4** | Follow-Up Dialog Assessment | Manual | Low | Phase 1 (for regression check only) |
| **5** | Mark Lost & Role Edit Dialog Migration | Frontend | Medium | Phase 1 |

---

## Master Dependency Graph

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              PHASE 1                                     │
│  Infrastructure Setup (FOUNDATION)                                       │
│  Install RHF + Zod + resolver, add shadcn Form, update next.config.ts   │
└───────┬──────────────────────┬──────────────────────┬────────────────────┘
        │                      │                      │
┌───────▼───────────┐  ┌──────▼───────────┐  ┌───────▼──────────────────┐
│     PHASE 2       │  │    PHASE 3       │  │       PHASE 5            │
│  Payment Form     │  │  Invite User     │  │  Mark Lost + Role Edit   │
│  Dialog Migration │  │  Dialog Migration │  │  Dialog Migration        │
│  (reference impl) │  │  (cond. valid.)  │  │  (2 simple dialogs)      │
└───────────────────┘  └──────────────────┘  └──────────────────────────┘

                       ┌──────────────────┐
                       │    PHASE 4       │
                       │  Follow-Up       │
                       │  Assessment      │  ← No code changes; runs anytime
                       │  (no migration)  │     after Phase 1
                       └──────────────────┘
```

**Key insight:** After Phase 1 completes, Phases 2, 3, 4, and 5 are **all independent** — they touch entirely different files with zero overlap. Maximum parallelism is 4 concurrent streams.

---

## Maximum Parallelism Windows

### Window 1: Foundation (Sequential — Must Complete First)

**Concurrency:** Up to 2 subphases in parallel within Phase 1 (after 1A completes).

Phase 1 installs packages, generates the shadcn Form component, and updates next.config.ts. The subphases are sequential (1A → 1B → 1C) because each depends on the previous:

```
Timeline: ████████████████████████████
          1A (install packages) ──→ 1B (add shadcn form) ──→ 1C (update next.config.ts)
```

**Duration:** ~15 minutes. This is the shortest window.

---

### Window 2: Full Parallelism (All 4 Dialog Phases Simultaneously)

**Concurrency:** 4 completely independent streams running simultaneously.

After Phase 1 completes, Phases 2, 3, 4, and 5 have **zero shared dependencies**. They each modify a single, distinct file:

- **Phase 2** modifies: `app/workspace/closer/meetings/_components/payment-form-dialog.tsx`
- **Phase 3** modifies: `app/workspace/team/_components/invite-user-dialog.tsx`
- **Phase 4** modifies: _(nothing — read-only assessment)_
- **Phase 5** modifies: `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx` AND `app/workspace/team/_components/role-edit-dialog.tsx`

No two phases touch the same file. No merge conflicts possible. No shared state. All phases import from `components/ui/form.tsx` (created in Phase 1), but only read from it — no modifications.

```
Timeline:              ████████████████████████████████████████████████████████████████████
                       Phase 2 (Payment Form — 3-4 hrs)      ─────────────────────────────┐
                       Phase 3 (Invite User — 2-3 hrs)   ─────────────────────────────────┤
                       Phase 4 (Follow-Up — 15-30 min)  ──────┤                            ├── Done
                       Phase 5 (Mark Lost + Role — 1.5-2.5 hrs) ──────────────────────────┘
```

**Within Phase 2 (internal: sequential):**
```
2A (Zod schema) ──→ 2B (useForm hook) ──→ 2C (Rewrite JSX) ──→ 2D (Verify)
```
All subphases modify the same file — must be sequential.

**Within Phase 3 (internal: sequential):**
```
3A (Zod schema + superRefine) ──→ 3B (useForm + watch) ──→ 3C (Rewrite JSX) ──→ 3D (Verify)
```
All subphases modify the same file — must be sequential.

**Within Phase 4 (internal: sequential):**
```
4A (Code audit) ──→ 4B (Document decision) ──→ 4C (Regression verify)
```
No code changes. 4C can optionally wait until Phases 2/3/5 complete to verify no cross-dialog regressions.

**Within Phase 5 (internal: parallel, then sequential):**
```
5A (Mark Lost dialog) ─────────────────┐
                                        ├── 5C (Verify & test both)
5B (Role Edit dialog) ─────────────────┘
```
5A and 5B touch different files — they can run in parallel. 5C verifies both.

---

## Critical Path Analysis

The **critical path** (longest sequential chain determining minimum delivery time):

```
Phase 1 (15 min) ──→ Phase 2 (3-4 hrs)
   │                     │
   │                     └── Payment Form is the most complex dialog
   └── Foundation — all phases block on this
```

**Alternative paths (shorter):**
```
Phase 1 (15 min) ──→ Phase 3 (2-3 hrs)         ← ~1 hour shorter than critical path
Phase 1 (15 min) ──→ Phase 5 (1.5-2.5 hrs)     ← ~1.5 hours shorter
Phase 1 (15 min) ──→ Phase 4 (15-30 min)       ← trivially short (no code changes)
```

**Implication:** Phase 2 (Payment Form) determines the minimum delivery time because it's the most complex migration (file upload, multi-step Convex flow, 5 fields). Start it immediately after Phase 1 completes. The other phases are shorter and can finish while Phase 2 is still in progress.

**Minimum total time:**
- **Sequential (solo):** ~15 min + ~3.5 hrs + ~2.5 hrs + ~0.5 hrs + ~2 hrs = **~8.5 hours**
- **Fully parallel (4 agents):** ~15 min + ~3.5 hrs = **~3.75 hours** (bounded by Phase 2)

---

## File Ownership Boundaries (Merge Conflict Prevention)

When running phases in parallel, each phase owns specific files to prevent conflicts:

| File | Phase Owner | Notes |
|---|---|---|
| `package.json` | **Phase 1 only** | Dependencies added once. No other phase modifies it. |
| `pnpm-lock.yaml` | **Phase 1 only** | Auto-generated. No other phase touches it. |
| `components/ui/form.tsx` | **Phase 1 only** | Created by shadcn CLI. All other phases import from it (read-only). |
| `next.config.ts` | **Phase 1 only** | `optimizePackageImports` updated once. No other phase modifies it. |
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | **Phase 2 only** | Single-file migration. |
| `app/workspace/team/_components/invite-user-dialog.tsx` | **Phase 3 only** | Single-file migration. |
| `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` | **Phase 4 (read-only)** | Assessed, not modified. No conflicts possible. |
| `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx` | **Phase 5A only** | Single-file migration. |
| `app/workspace/team/_components/role-edit-dialog.tsx` | **Phase 5B only** | Single-file migration. |
| `components/ui/field.tsx` | **No phase** | Existing file. Referenced by current dialogs. Imports removed by Phases 2/3/5 but the file itself is never modified. |

**Zero shared file modifications across Phases 2–5.** This is the ideal scenario for parallel execution.

---

## Recommended Execution Strategies

### Solo Developer

Execute Phase 1, then batch the migrations by difficulty. Leverage Phase 5's internal parallelism (5A + 5B touch different files):

1. **Phase 1** — Install packages, add form component, update config. (~15 min)
2. **Phase 2** — Payment Form Dialog. Hardest migration — do this first while focus is fresh. (~3.5 hrs)
3. **Phase 3** — Invite User Dialog. Second hardest — conditional validation. (~2.5 hrs)
4. **Phase 5** — Mark Lost + Role Edit. Two simple dialogs, sequential. (~2 hrs)
5. **Phase 4** — Follow-Up assessment and regression check. (~30 min)

**Estimated total time:** ~8.5 hours (1 working day)

**Optimization:** Do Phase 4 (assessment) during a break between Phase 2 and Phase 3 — it's only 15 minutes of reading and requires no code changes.

### Two Developers / Agents

| Sprint | Developer A | Developer B |
|---|---|---|
| Sprint 1 (15 min) | Phase 1 (infrastructure) | _(blocked — wait for Phase 1)_ |
| Sprint 2 (3-4 hrs) | Phase 2 (Payment Form — hardest) | Phase 3 (Invite User) + Phase 4 (Follow-Up assessment) |
| Sprint 3 (1.5-2.5 hrs) | Phase 5A (Mark Lost) | Phase 5B (Role Edit) |
| Sprint 4 (30 min) | Phase 5C (verify both) + Phase 4C (regression verify) | Code review of Phases 2 + 3 |

**Estimated total time:** ~5 hours (half day)

**Why this split works:** Developer A takes the critical path (Phase 1 → Phase 2 → Phase 5A). Developer B takes the shorter path (Phase 3 + Phase 4 → Phase 5B). Both converge at Sprint 3 for the final two simple dialogs.

### Three+ Developers / Agents

| Sprint | Agent A | Agent B | Agent C |
|---|---|---|---|
| Sprint 1 (15 min) | Phase 1 (infrastructure) | _(blocked)_ | _(blocked)_ |
| Sprint 2 (parallel) | Phase 2 (Payment Form) | Phase 3 (Invite User) | Phase 5 (Mark Lost + Role Edit) |
| Sprint 3 (30 min) | Phase 2D (verify) | Phase 3D (verify) | Phase 5C (verify) + Phase 4 (assess + regress) |

**Estimated total time:** ~4 hours

**Diminishing returns:** A 4th agent would have nothing to do — Phase 4 is trivial and doesn't justify a dedicated resource. 3 agents is the practical maximum for this feature.

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 1: Infrastructure Ready** | After Phase 1 | `pnpm tsc --noEmit` passes. `components/ui/form.tsx` exists and exports `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage`, `FormDescription`. `"zod"` is in `optimizePackageImports`. |
| **Gate 2: Reference Pattern Proven** | After Phase 2 | Payment Form Dialog: empty submit shows inline errors. Valid submit logs payment. File upload works. PostHog event fires. `form.reset()` clears on cancel/success. No `<Field>` imports remain. |
| **Gate 3: Conditional Validation Works** | After Phase 3 | Invite User Dialog: role change to "closer" shows Calendly field. Submit without Calendly member shows inline error under the dropdown. Role change to "admin" clears Calendly field. |
| **Gate 4: Assessment Complete** | After Phase 4 | Follow-Up Dialog: `git diff` shows zero changes. Dialog still works end-to-end in browser. Skip decision is documented with criteria checklist. |
| **Gate 5: All Dialogs Migrated** | After Phase 5 | Mark Lost: 500-char limit shows inline error. AlertDialog focus trap works with Form wrapper. Role Edit: `useEffect` resets form on reopen with different user. Save disabled when role unchanged. |
| **Gate 6: Full Regression** | After all phases | `pnpm tsc --noEmit` passes. All 5 dialogs work in browser. No toast-only validation errors remain (inline errors everywhere). `pnpm build` succeeds. Run `expect` accessibility audit on all 4 dialog routes. |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Phase 1 `npx shadcn@latest add form` fails or generates incompatible code | **Critical** — blocks all phases | Run `pnpm tsc --noEmit` immediately after generation. If shadcn generates code incompatible with `radix-nova` preset, manually adjust the generated `form.tsx`. |
| `z.instanceof(File)` doesn't work in SSR context | **Medium** — affects Phase 2 only | The file schema only runs in client components (`"use client"`). Verify with `pnpm build` that the Zod schema isn't accidentally imported by a server component. |
| `<Form>` wrapper breaks `<AlertDialog>` focus trap | **Medium** — affects Phase 5A (Mark Lost) | `Form` renders no DOM (it's just `FormProvider`). If focus trap breaks, move `<Form>` inside `<AlertDialogContent>` rather than wrapping the entire dialog. Test immediately. |
| `useEffect` reset causes stale state in Role Edit Dialog | **Medium** — affects Phase 5B | The `useEffect` depends on `[open, currentRole, form]`. If `form` reference changes on every render (unlikely with RHF), memoize or use `form.reset` inside an `onOpenChange` callback instead. |
| Merge conflicts if phases modify shared files | **Low** — mitigated by design | File ownership table shows zero shared file modifications across Phases 2–5. The only shared dependency (`components/ui/form.tsx`) is read-only after Phase 1. |
| `form.watch("role")` causes excess re-renders in Phase 3 | **Low** — minor performance | RHF's `watch()` is optimized to re-render only when the watched value changes. If profiling shows issues, switch to `useWatch()` which is even more granular. |
| Zod bundle size bloats client | **Low** — mitigated in Phase 1 | `"zod"` is in `optimizePackageImports`, enabling tree-shaking. Zod schemas are co-located in dialog files (not a shared bundle). Each page only loads the schemas for its own dialogs. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | `shadcn`, `next-best-practices` | Adding the Form component via CLI; verifying tree-shaking config. |
| **2** | `vercel-react-best-practices`, `web-design-guidelines`, `expect` | Verify RHF doesn't conflict with Convex subscriptions; WCAG compliance of inline errors; browser verification. |
| **3** | `vercel-react-best-practices`, `expect` | Verify `form.watch()` performance; browser verification of conditional validation. |
| **4** | `expect` | Regression verification of the unchanged follow-up dialog. |
| **5** | `vercel-react-best-practices`, `expect` | Verify `useEffect` reset pattern; browser verification of both dialogs. |

---

## Summary Timeline

```
                        Window 1           Window 2 (Full Parallelism)
                        ┌───────┐  ┌──────────────────────────────────────────────────┐
Solo (8.5 hrs):         │ Ph 1  │──│ Ph 2 ──→ Ph 3 ──→ Ph 5 ──→ Ph 4               │
                        └───────┘  └──────────────────────────────────────────────────┘

                        ┌───────┐  ┌──────────────────────────────────────────────────┐
2 Devs (5 hrs):         │ Ph 1  │──│ Dev A: Ph 2 ────────────→ Ph 5A ──→ Verify     │
                        │       │  │ Dev B: Ph 3 + Ph 4 ──────→ Ph 5B ──→ Review    │
                        └───────┘  └──────────────────────────────────────────────────┘

                        ┌───────┐  ┌──────────────────────────────────────────────────┐
3 Agents (4 hrs):       │ Ph 1  │──│ Agent A: Ph 2 ─────────────────→ Verify        │
                        │       │  │ Agent B: Ph 3 ───────────→ Verify               │
                        │       │  │ Agent C: Ph 5 ──→ Ph 4 ──→ Verify               │
                        └───────┘  └──────────────────────────────────────────────────┘
```

---

*This strategy maximizes parallelization by leveraging the key insight: each dialog lives in its own file, on its own route, serving its own user role. After the shared infrastructure (Phase 1), all migrations are independent and can run concurrently with zero merge conflict risk.*
