# Parallelization Strategy — Reminder Outcomes

**Purpose:** This document defines the parallelization strategy across all 6 implementation phases of the Reminder Outcomes feature, identifying the critical path, dependency graph, file-ownership boundaries, and maximum concurrency opportunities. It is the execution roadmap that complements the 6 phase plans in `plans/reminder-outcomes/phases/phase1.md` through `phase6.md`.

**Prerequisite (before any phase starts):**
- A running local Convex dev deployment (`npx convex dev` green) on the target tenant.
- The reminder-outcomes design doc is read and approved (`plans/reminder-outcomes/reminder-outcomes-design.md`).
- The existing closer dashboard (`RemindersSection`, `getActiveReminders`) is working — Phase 6's end-state depends on it. If the dashboard is broken, fix it before starting Phase 1.
- At least 3 `manual_reminder` follow-ups seeded across varied urgency states on the dev tenant for Phase 6 QA (`overdue`, `due soon`, `upcoming`).
- Access to the PostHog dev project for event verification in Phase 5/6.
- `expect` MCP tooling verified (`pnpm install` run; `.mcp.json` resolves `expect-cli`).

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **1** | Schema & Status Transition Extensions | Backend | Low | None (foundation) |
| **2** | Reminder Detail Query | Backend | Medium | Phase 1 |
| **3** | Outcome Mutations | Backend | High | Phase 1 |
| **4** | Reminder Detail Page (Route + RSC) | Full-Stack | Medium-High | Phase 2 |
| **5** | Reminder Outcome Action Bar + Dialogs | Full-Stack | High | Phase 3 + Phase 4 (stub) |
| **6** | Dashboard Integration & Cleanup | Full-Stack | Medium | Phase 4 + Phase 5 |

**Total wall-clock estimate:** 6 days solo • 4 days two-dev • 3 days three+-dev/agent.

---

## Master Dependency Graph

```
                    ┌────────────────────────────────────────────────────────────────┐
                    │                          PHASE 1                                │
                    │   Schema & Status Transition Extensions (FOUNDATION)            │
                    │   • widen VALID_TRANSITIONS.follow_up_scheduled                 │
                    │   • add optional followUps.completionOutcome                    │
                    └────────────┬──────────────────────────────────┬─────────────────┘
                                 │                                  │
                    ┌────────────▼─────────────┐       ┌────────────▼─────────────┐
                    │         PHASE 2          │       │         PHASE 3          │
                    │  Reminder Detail Query   │       │   Outcome Mutations      │
                    │  (Backend only)          │       │   (Backend only)         │
                    │  • getReminderDetail     │       │  • logReminderPayment    │
                    │                          │       │  • markReminderLost      │
                    │                          │       │  • markReminderNoResponse│
                    └────────────┬─────────────┘       └────────────┬─────────────┘
                                 │                                  │
                    ┌────────────▼─────────────┐       ┌────────────▼─────────────┐
                    │         PHASE 4          │       │         PHASE 5          │
                    │  Reminder Detail Page    │◄──────┤  Action Bar + Dialogs    │
                    │  (Full-Stack RSC)        │ stub  │  (Full-Stack)            │
                    │  • page.tsx/loading/err  │ swap  │  • ReminderOutcomeAction │
                    │  • client shell          │       │    Bar (replaces stub)   │
                    │  • 3 info panels         │       │  • 3 outcome dialogs     │
                    │  • STUB action bar       │       │  • PostHog events        │
                    └────────────┬─────────────┘       └────────────┬─────────────┘
                                 │                                  │
                                 └──────────────┬───────────────────┘
                                                │
                                    ┌───────────▼───────────────┐
                                    │         PHASE 6           │
                                    │  Dashboard Integration    │
                                    │  & Cleanup (FINALISER)    │
                                    │  • router.push swap       │
                                    │  • delete dead dialog     │
                                    │  • expect browser QA      │
                                    └───────────────────────────┘
```

**Reading the graph:**
- **Boxes at the same horizontal level can run in parallel.** Phase 2 and Phase 3 are the classic "two-stream backend" fork; Phase 4 and Phase 5 are the "two-stream full-stack" fork (after the stub exchange — see Window 3 below).
- **The arrow labelled "stub swap"** between Phase 5 and Phase 4 captures the single cross-stream handoff: Phase 4 writes a no-op placeholder file; Phase 5 overwrites it with the real implementation. This is the only shared file between the two parallel streams.
- **Phase 6 is a pure finaliser** — it cannot start until both frontend streams have landed because it rewires the dashboard card that sends users into those streams.

---

## Maximum Parallelism Windows

### Window 1: Schema Foundation (Sequential — Must Complete First)

**Concurrency:** Up to 2 subphases in parallel within Phase 1.

Phase 1 is the critical foundation. Everything blocks on it. However, 1A (`VALID_TRANSITIONS` widening) and 1B (`followUps.completionOutcome` field) touch **different files** with zero shared imports, so they can be written in parallel by two people or in rapid succession by one. The deploy + verify step (1C) is the synchronisation point that gates Phase 2 and Phase 3.

```
Timeline: ████████
          1A (statusTransitions.ts)  ───┐
                                        ├── 1C (deploy + tsc + verify)
          1B (schema.ts followUps)   ───┘
```

**Why independent:**
- 1A edits only `convex/lib/statusTransitions.ts` — a single row change in `VALID_TRANSITIONS`.
- 1B edits only `convex/schema.ts` — adds an optional union field to the `followUps` table.
- Neither file imports the other; neither reads the other's symbols.

**Gate to exit:** `npx convex dev` shows a green push; `pnpm tsc --noEmit` passes; generated `Doc<"followUps">` includes the new optional `completionOutcome` literal union.

---

### Window 2: Parallel Backend Streams (Full Parallelism)

**Concurrency:** 2 completely independent backend streams running simultaneously.

After Phase 1 deploys, Phase 2 and Phase 3 have **zero shared dependencies**. They touch entirely different files, different directories, and consume only read-only shared utilities (`requireTenantUser.ts`, `statusTransitions.ts`, `permissions.ts`).

- **Phase 2** works in `convex/closer/reminderDetail.ts` (new file).
- **Phase 3** works in `convex/closer/reminderOutcomes.ts` (new file).

No merge conflicts possible. No shared mutable state. Both can be picked up the moment Phase 1's `convex dev` is green.

```
Timeline:          ██████████████████████████████████████
                   Phase 2 (reminder detail query)  ──────────┐
                   Phase 3 (outcome mutations)      ──────────┤
                                                              ▼
                                                        Window 3
```

**Within Phase 2 (internal parallelism — limited):**

```
2A (query skeleton + guards returning null)  ─── 2B (joins + indexed lookups + real return shape)
```

2A and 2B are **sequential only** — they edit the same file (`reminderDetail.ts`), and 2B extends the same `handler` function that 2A scaffolds. Estimated ~3 hours total; the split exists to make the first commit reviewable on its own.

**Within Phase 3 (internal parallelism — co-located file, conditional):**

```
3A (file shell + assertOwnedPendingReminder helper)  ───┐
                                                        ├── 3B (logReminderPayment)    ─┐
                                                        ├── 3C (markReminderLost)      ─┤
                                                        └── 3D (markReminderNoResponse) ┘
```

3A must land first (it exports the shared helper). 3B, 3C, 3D are **logically independent mutation bodies** but **co-located in `reminderOutcomes.ts`**. True file-level parallelism requires feature branches per mutation + merge. On a solo developer the optimal order is: 3B (longest, reuses `logPayment` as template) → 3C (smallest) → 3D (branching logic). On a multi-agent run, each mutation gets its own worktree + branch.

**Cross-phase verification:** Neither Phase 2 nor Phase 3 has a Phase 4/5 dependency; both can be fully shipped + dashboard-tested via the Convex function runner before any frontend exists.

---

### Window 3: Parallel Full-Stack Streams (with Stub Exchange)

**Concurrency:** 2 completely independent full-stack streams sharing exactly one stub file.

Phase 4 and Phase 5 are **mostly independent full-stack work** living under `app/workspace/closer/reminders/[followUpId]/`:

- **Phase 4** owns: `page.tsx`, `loading.tsx`, `error.tsx`, `_components/reminder-detail-page-client.tsx`, `_components/reminder-contact-card.tsx`, `_components/reminder-metadata-card.tsx`, `_components/reminder-history-panel.tsx`.
- **Phase 5** owns: `_components/reminder-outcome-action-bar.tsx` (overwrites Phase 4's stub), `_components/reminder-payment-dialog.tsx`, `_components/reminder-mark-lost-dialog.tsx`, `_components/reminder-no-response-dialog.tsx`.

```
Timeline:                                  ████████████████████████████████████████
                                           Phase 4 (page + panels + STUB action bar) ──────┐
                                           Phase 5 (real action bar + 3 dialogs)     ──────┤
                                                                                            ▼
                                                                                       Window 4
```

**The stub-exchange handoff (critical detail):**

This is the only cross-stream contact surface between Phase 4 and Phase 5 — design it carefully:

```
    Phase 4 (4B — client shell)                Phase 5 (5A — real action bar)
    ───────────────────────────                ─────────────────────────────────
    Writes:                                    Overwrites:
      reminder-outcome-action-bar.tsx            reminder-outcome-action-bar.tsx
      (exports no-op ReminderOutcomeActionBar    (exports REAL ReminderOutcomeActionBar
       that renders "Actions coming soon")       with 3 outcome buttons + dialogs)

    Client shell imports via:                  Client shell imports via:
      dynamic(() => import("./reminder-          dynamic(() => import("./reminder-
              outcome-action-bar"))                      outcome-action-bar"))
      ──── no change to import path ────         ──── no change to import path ────
```

**Why this works:**
- The dynamic import in the client shell is path-only; Phase 5 never touches `reminder-detail-page-client.tsx`.
- The stub and the real component **must export the same component name + prop signature** — both take `{ followUp, opportunity, latestMeeting }`. Phase 4 writes the stub with the Phase 5 prop contract pre-baked (see §6.2 of the design doc for the signature).
- Merge conflict risk is bounded to a single file with a pre-agreed interface. Phase 5 fully overwrites; no three-way merge needed.

**Within Phase 4 (internal parallelism — 3 panels run fully parallel):**

```
4A (route files: page.tsx + loading.tsx + error.tsx) ─────┐
                                                           ├── 4B (client shell + stub ─┐
                                                           │      action bar)           │
                                                           │                            │
                                                           ├── 4C (ReminderContactCard) ─┐
                                                           ├── 4D (ReminderMetadataCard)─┤── (panels parallel)
                                                           └── 4E (ReminderHistoryPanel)─┘
```

4A is a 30-line 3-file RSC scaffold (~15 min). 4B is the client shell (~2 hours). 4C/4D/4E are each self-contained panel components — each in its own file, each consuming a slice of the preloaded query. A multi-agent setup assigns one panel per agent.

**Within Phase 5 (internal parallelism — 3 dialogs run fully parallel):**

```
5A (real ReminderOutcomeActionBar) ──────┐
                                          ├── 5B (ReminderPaymentDialog)    ─┐
                                          ├── 5C (ReminderMarkLostDialog)   ─┤── 5E (PostHog events)
                                          └── 5D (ReminderNoResponseDialog) ─┘
```

5A must land first (the action bar imports all three dialogs via `dynamic()` — until they exist, the imports would break the build). 5B/5C/5D are **fully independent dialog files**, each with its own Zod schema, RHF hook, and mutation wiring. 5E is a consolidation pass that adds PostHog events across the three dialogs.

**Cross-stream status-check cadence:** Phase 4 and Phase 5 do not share review cycles until Phase 5's 5A is ready to overwrite the stub. Before 5A commits, both streams should agree that the prop signature on `ReminderOutcomeActionBar` matches the design doc §6.2 byte-for-byte.

---

### Window 4: Sequential Finaliser

**Concurrency:** 1 stream (no parallelism — ordered by dependency).

Phase 6 cannot run in parallel with anything. Its three subphases are strictly sequential:

```
Timeline:                                                                   ████████
                                                                            6A (dashboard route swap) ──── 6B (dead code cleanup) ──── 6C (expect QA gate)
```

**Why sequential only:**
- 6A modifies `reminders-section.tsx` — the same file Phase 4/5's UI depends on indirectly (through user flow). Running 6A before Phase 4's route is live would break the dashboard (clicks navigate to a nonexistent route).
- 6B deletes `ReminderDetailDialog` + `selectedReminder` state. Running 6B before 6A would strand users in a dashboard with no way to see reminders mid-migration.
- 6C (browser QA via `expect`) needs the codebase in its final shape to validate the end-to-end flow.

**Gate to exit:** `expect` skill passes all three outcome paths on 4 viewports; zero critical accessibility violations; no console errors; PostHog receives the four expected events per flow.

---

## Critical Path Analysis

The **critical path** (longest sequential chain determining minimum implementation time):

```
Phase 1 → Phase 3 → Phase 5 → Phase 6
  │          │          │         │
  │          │          │         └── Dashboard rewire + browser QA gate (closes the feature)
  │          │          └── Action bar + 3 dialogs + PostHog events (exposes mutations as UI)
  │          └── 3 outcome mutations (the backend that Phase 5 wires to buttons)
  └── Schema widen + transition widen (unblocks everything)
```

**Alternative shorter path (read-only leaf):**

```
Phase 1 → Phase 2 → Phase 4 (with stub action bar)
```

This path produces a page that **renders the reminder detail but cannot record outcomes**. It is shorter by the length of Phase 3 + Phase 5. It is useful as an intermediate checkpoint — by the end of Phase 4 the page is clickable, navigable, and visually polished; closers just can't actually complete outcomes yet.

**Implication:**
- **Start Phase 3 as early as possible** after Phase 1 completes. It is the longest single-phase on the critical path (1–1.5 days) and determines minimum delivery time.
- Phase 2 is shorter than Phase 3 (~0.5 day vs. ~1.5 day). If allocated to the same developer, finish Phase 2 first to unblock Phase 4's frontend stream, then rotate onto Phase 3.
- Phase 5 (2–2.5 days) is nearly as long as Phase 3 — it is the second-longest phase on the critical path. Start 5A the moment Phase 3's mutations are deployable.
- Phase 6 is short (0.5–1 day) but is the **feature gate** — no amount of code review replaces the `expect` browser QA in 6C.

---

## File Ownership Boundaries (Merge Conflict Prevention)

When running phases in parallel, each phase owns specific files to prevent merge conflicts. Two phases must **never** edit the same file concurrently unless the file is a well-defined stub handoff (see Phase 4 ↔ Phase 5).

| Directory / File | Phase Owner | Notes |
|---|---|---|
| `convex/schema.ts` | **Phase 1 only** | Adds optional `completionOutcome`. Locked for the rest of the feature. |
| `convex/lib/statusTransitions.ts` | **Phase 1 only** | Widens `VALID_TRANSITIONS.follow_up_scheduled`. No later phase modifies the map. |
| `convex/_generated/*` | **Phase 1 (auto-regenerate)** | Regenerated by `npx convex dev` after every push. Do not hand-edit. |
| `convex/closer/reminderDetail.ts` | **Phase 2 only** | New file. Phase 4 **reads** `api.closer.reminderDetail.getReminderDetail` but never edits this file. |
| `convex/closer/reminderOutcomes.ts` | **Phase 3 only** | New file. Phase 5 **reads** the three mutations but never edits this file. Internal split (3B/3C/3D) is co-located — solo devs write sequentially; multi-dev uses feature branches. |
| `convex/requireTenantUser.ts` | **Shared (read-only)** | All phases import but none modify. |
| `convex/closer/payments.ts` | **Shared (read-only)** | Phase 5's payment dialog reuses `generateUploadUrl`. Not modified. |
| `convex/lib/opportunityMeetingRefs.ts` | **Shared (read-only)** | Phase 3's `logReminderPayment` calls `updateOpportunityMeetingRefs`. Not modified. |
| `app/workspace/closer/reminders/[followUpId]/page.tsx` | **Phase 4 only** | New file. |
| `app/workspace/closer/reminders/[followUpId]/loading.tsx` | **Phase 4 only** | New file. |
| `app/workspace/closer/reminders/[followUpId]/error.tsx` | **Phase 4 only** | New file. |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-detail-page-client.tsx` | **Phase 4 only** | New file. Imports `ReminderOutcomeActionBar` via dynamic — path is stable. |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-contact-card.tsx` | **Phase 4 only** | New file (4C). |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-metadata-card.tsx` | **Phase 4 only** | New file (4D). |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel.tsx` | **Phase 4 only** | New file (4E). |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-outcome-action-bar.tsx` | **Phase 4 (stub) → Phase 5 (overwrite)** | **Stub-exchange file.** Phase 4 writes a no-op stub with the Phase 5 prop contract; Phase 5 fully overwrites with the real implementation. No three-way merge; the stub is replaced outright. |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog.tsx` | **Phase 5 only** | New file (5B). |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-mark-lost-dialog.tsx` | **Phase 5 only** | New file (5C). |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-no-response-dialog.tsx` | **Phase 5 only** | New file (5D). |
| `app/workspace/closer/_components/reminders-section.tsx` | **Phase 6 only** | Only Phase 6 edits the dashboard card. The `useRouter().push` swap in 6A + dead-code cleanup in 6B are the only two touches in the whole feature. |
| `app/workspace/closer/_components/reminder-detail-dialog.tsx` | **Phase 6 only** | **Deleted** in 6B. No other phase touches it. |
| `components/lead-info-panel.tsx` | **Shared (read-only)** | Reused by Phase 4's page. Not modified. |
| `components/ui/*` | **Shared (read-only)** | shadcn primitives. Not modified — if a new primitive is needed, use the `shadcn` skill to add it. |

**Key rule:** The **only** contested file is `reminder-outcome-action-bar.tsx`, and its contract is explicit. Every other file has a single owner; merge conflicts are impossible when phases run in true parallel.

---

## Recommended Execution Strategies

### Solo Developer

Execute in critical-path order, leveraging within-phase parallelism for efficient context-switching. Branch naming follows `feat/reminder-outcomes-phase-{N}`.

1. **Day 1 AM:** Phase 1 — 1A + 1B in rapid succession (edit both files, same commit), then 1C (deploy + `pnpm tsc --noEmit`).
2. **Day 1 PM:** Phase 2 (full) — 2A + 2B back-to-back. Ships `getReminderDetail` to dev.
3. **Day 2 AM → Day 3 AM:** Phase 3 — 3A scaffolding, then 3B (`logReminderPayment` — longest), 3C, 3D in order of ascending complexity. Verify each via Convex function runner.
4. **Day 3 PM → Day 4 AM:** Phase 4 — 4A (15 min), 4B (client shell with stub), then 4C/4D/4E (three panels in rapid succession — ~2 hours each).
5. **Day 4 PM → Day 5 PM:** Phase 5 — 5A (real action bar), 5B (payment dialog — biggest), 5C, 5D, 5E (PostHog).
6. **Day 6:** Phase 6 — 6A (15 min swap), 6B (cleanup), 6C (browser QA via `expect`).

**Estimated time:** 6 days (with buffer for iteration, ~6.5 days realistic).

**Solo tips:**
- Keep Convex dev running in one terminal through all 6 phases; it auto-regenerates types on every save.
- Between Phase 3 and Phase 5 (longest gap), use the Convex dashboard's function runner to smoke-test the three mutations end-to-end. Catch bugs before they reach the UI.
- Resist the temptation to parallel-start Phase 4 before Phase 2 deploys. Frontend against a missing backend leads to imagined-API drift.

### Two Developers (Backend + Frontend)

| Sprint | Developer A (Backend) | Developer B (Frontend / Polish) |
|---|---|---|
| **1** (0.5 day) | Phase 1A + 1B + 1C (full) | *Waiting on Phase 1 — reviews design doc §5–§7; sets up `expect` MCP; seeds test data.* |
| **2** (1.5 days) | Phase 2 (full) | Phase 4A (route files) + starts 4B stub |
| **3** (1.5 days) | Phase 3 (full: 3A–3D) | Phase 4B + 4C + 4D + 4E (panels parallel) |
| **4** (2 days) | Reviews Phase 3 dashboard checks; pairs on Phase 5 backend-touching parts | Phase 5A (overwrites stub) + 5B + 5C + 5D + 5E |
| **5** (0.5 day) | Phase 6A + 6B (cleanup) | Phase 6C (browser QA via `expect`) — Developer B owns the QA gate |

**Estimated time:** 4 days. Saves ~2 days vs. solo by running Phase 2 + Phase 3 in parallel (Sprint 3) and Phase 4 + Phase 5 in serial-but-offset fashion (Sprint 4 overlaps with Sprint 3 panel work).

**Two-dev tips:**
- Developer B can start Phase 4A (route files) the moment Phase 1 deploys — the page skeleton doesn't need Phase 2's query to compile; stub the preload with `{} as any` temporarily.
- The Sprint 4 overlap is the riskiest — A + B should pair-review the stub contract in `reminder-outcome-action-bar.tsx` before Developer B writes 4B.

### Three+ Developers / Agents

This is the optimal configuration for multi-agent execution. Each agent gets an isolated worktree.

| Sprint | Agent A (Backend stream 1) | Agent B (Backend stream 2) | Agent C (Frontend) |
|---|---|---|---|
| **1** (0.5 day) | Phase 1A | Phase 1B | *Blocked on Phase 1; preps `expect` + reviews design* |
| **2** (0.5 day) | Phase 1C (deploy + verify) — owns gate | — | — |
| **3** (1.5 days) | Phase 2 (full) | Phase 3A + 3B (`logReminderPayment`) | Phase 4A + 4B (stub action bar) |
| **4** (1 day) | *Reviews Phase 2 against Phase 4's real usage* | Phase 3C + 3D (`markReminderLost`, `markReminderNoResponse`) | Phase 4C + 4D + 4E (3 panels in parallel worktrees — sub-agents D, E, F) |
| **5** (1 day) | Phase 5A (action bar overwrites stub) | Phase 5B (payment dialog — biggest) | Phase 5C (mark lost) + Phase 5D (no response) in parallel |
| **6** (0.5 day) | Phase 5E (PostHog consolidation across dialogs) | Phase 6A + 6B (dashboard swap + cleanup) | Phase 6C (`expect` browser QA — owns final gate) |

**Estimated time:** 3 days (with multi-worktree isolation and disciplined merge cadence).

**Three+-dev tips:**
- Phase 1 is the only fully-serial fork point. After 1C deploys, unleash parallel agents.
- The Phase 4 panels (4C/4D/4E) are ideal multi-agent work — each in its own worktree, branching off a common Phase 4B commit.
- For Sprint 6, Agent C owns the `expect` gate **only**. Agents A and B should not push new commits after 6B lands until the gate passes, to avoid invalidating the QA run.

---

## Quality Gates

Each gate is a "stop and verify" point before proceeding. Do not skip gates; they catch drift between backend contracts and frontend assumptions.

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 1** | After Phase 1 (1C complete) | `npx convex dev` shows green push; `pnpm tsc --noEmit` exits 0; `validateTransition("follow_up_scheduled", "payment_received"/"lost")` returns `true`; generated `Doc<"followUps">` includes the `completionOutcome` optional union; no existing `followUps` documents fail validation on the live dev deployment. |
| **Gate 2** | After Phase 2 | Convex dashboard function runner: invoke `api.closer.reminderDetail.getReminderDetail` with a real `followUpId` owned by the caller — returns `{ followUp, opportunity, lead, latestMeeting, payments, tenantPaymentLinks }`. Invoke with a `followUpId` owned by another closer — returns `null`. Invoke with an invalid id — returns `null`. `pnpm tsc --noEmit` passes. |
| **Gate 3** | After Phase 3 (all three mutations deployed) | Convex dashboard function runner, for each of the three mutations: (a) call with valid pending reminder → returns success; (b) call with already-completed reminder → throws `"Reminder is not pending"`; (c) call with reminder owned by another closer → throws ownership error; (d) verify side effects (opportunity patched, follow-up patched, aggregates updated, domain events emitted). `pnpm tsc --noEmit` passes. |
| **Gate 4** | After Phase 4 (page renders end-to-end) | Navigate to `/workspace/closer/reminders/<valid-id>` → full page renders (all 3 panels + stub action bar showing "Actions coming soon"). Navigate to invalid id → "Reminder Not Found" empty state. Navigate as another-closer owner → "Reminder Not Found". `pnpm tsc --noEmit` passes. |
| **Gate 5** | After Phase 5 (real action bar live) | All three outcome flows work end-to-end from the detail page (**not yet from the dashboard — that is Phase 6**): (a) Log Payment → form + file upload + success toast + navigation back; (b) Mark Lost → AlertDialog confirm + success; (c) No Response → conditional form for schedule_new / give_up / close_only + branch-specific toasts. PostHog receives three outcome events + `reminder_page_opened` in dev project. `pnpm tsc --noEmit` passes. |
| **Gate 6** | After Phase 6 (browser QA gate) | `expect` skill passes: dashboard → click reminder → detail page → complete each outcome → return → dashboard updated. Zero critical accessibility violations (axe-core + IBM Equal Access). LCP < 2.5s, INP < 200ms, zero console errors. 4 viewports tested (375, 768, 1024, 1440). `pnpm tsc --noEmit` passes. |

**Gate enforcement:** If a gate fails, **do not proceed** to the next phase. Backtrack, fix, re-verify. The `expect` gate (Gate 6) is the feature-ship gate — nothing merges to main without a passing gate.

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| **Phase 1 schema error blocks everything downstream** | **Critical** | Deploy schema first, before writing any Phase 2/3 code. Run `npx convex dev` and watch for validation errors. The `convex-migration-helper` skill will flag any existing documents that would violate the new union — the field is optional, so this should not fire, but verify. |
| **Stub-exchange merge conflict on `reminder-outcome-action-bar.tsx`** | **High** | The prop contract (`{ followUp, opportunity, latestMeeting }`) is baked into Phase 4's stub from day one — Phase 5's overwrite preserves the signature. Pair-review the stub commit before Phase 5 starts 5A. Worst case: Phase 5 rewrites the file in one commit; no three-way merge. |
| **Phase 3 mutation drift from Phase 5 dialog expectations** | **High** | Design doc §6.2 defines the mutation call shapes exactly. Phase 3 acceptance criteria 1–9 are byte-exact matches with the dialog schemas in Phase 5. If Phase 3 changes an arg name, Phase 5's tsc will flag it immediately. Run `pnpm tsc --noEmit` at the end of every Phase 3 subphase. |
| **`executeConversion` side-effect regression in `logReminderPayment`** | **High** | Phase 3B must mirror the existing `logPayment` mutation's call order: insert payment → patch opportunity → run `executeConversion` → update aggregates → emit events. Any deviation risks lead→customer conversion not firing. Use `logPayment` in `convex/closer/payments.ts` as the template and diff-review the new mutation against it. |
| **Frontend built against stale Convex types** | **Medium** | Keep `npx convex dev` running through all 6 phases. Generated types refresh on every schema/function push. If a developer edits Phase 4/5 with a stopped Convex watcher, types will go stale and `tsc` will miss drift. Enforce the "Convex dev is running" rule in each phase's acceptance criteria. |
| **Dashboard cache invalidation after Phase 6 swap** | **Medium** | Convex reactivity auto-refreshes `getActiveReminders` when a follow-up's `status` changes from `pending` to `completed`. No manual invalidation needed. Verify in Gate 6 by opening two tabs: outcome flow in tab A should remove the reminder from tab B's dashboard within ~500ms. |
| **`expect` browser QA flake on first run** | **Medium** | The `expect` skill is browser-based and non-deterministic on animation timing. If Gate 6 fails due to a flake (not a real bug), re-run. If flake persists across 2 runs, investigate console + network logs. Do not mark the gate passed until two consecutive clean runs. |
| **PostHog events missing or miscapitalized** | **Medium** | Phase 5's 5E subphase is a consolidation pass precisely to avoid key drift. Define the three event names as constants in a module-level object at the top of each dialog file; don't inline string literals. Verify in Gate 5 via PostHog dev project's "Live events" view. |
| **Payment upload URL reuse collision** | **Medium** | Phase 5B reuses `api.closer.payments.generateUploadUrl` — a shared mutation. No modifications should be needed, but if Phase 3B or 3D inadvertently writes to the same Convex storage surface, verify file cleanup. The `generateUploadUrl` contract returns a unique URL per call; no collision path exists as long as Phase 3 does not call it. |
| **Closer perceives two different "log a payment" UIs** | **Medium** | Phase 5B's `ReminderPaymentDialog` and the existing `PaymentFormDialog` (meeting detail) should be visually consistent (same field order, same primary button label, same error styling). Use the `frontend-design` skill to audit consistency before Gate 5 closes. If divergence is intentional (design doc §6.3), document the rationale. |
| **Multi-agent merge storm at Window 3 boundary** | **Medium** | The Phase 4 panels (4C/4D/4E) all land before Phase 4B stabilizes the stub contract. On a multi-agent run, agents D/E/F should rebase onto Phase 4B's commit before landing panels. Use git worktrees per agent to keep main clean; merge only after Phase 4B's stub commit is signed off. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | `convex-migration-helper`, `convex-performance-audit` | Validate the optional-field widen against live schema; confirm no unindexed field is adding hidden reporting cost. |
| **2** | `convex-performance-audit` | Verify indexed reads (`withIndex`, no `.filter()`, no `.collect()`); single query must not waterfall. Pattern mirrors `meetingDetail.ts`. |
| **3** | `convex-performance-audit`, `convex-create-component` | Audit bounded reads + write order; enforce the "clear boundaries" discipline on `assertOwnedPendingReminder` helper so each mutation body stays skinny. |
| **4** | `frontend-design`, `shadcn`, `web-design-guidelines`, `vercel-react-best-practices` | Polish contact card (mobile CTAs, `tel:`/`sms:` links); source shadcn primitives (`Card`, `Badge`, `Empty`, `Skeleton`); WCAG 2.2 AA on tappable targets; Suspense + dynamic imports for the stub action bar. |
| **5** | `shadcn`, `frontend-design`, `web-design-guidelines`, `vercel-react-best-practices`, `convex-performance-audit` | Source dialog + form primitives; polish the no-response dialog's conditional fields; WCAG on focus order + radio labelling; `dynamic()` imports for dialogs; no orphaned `useQuery` subscriptions. |
| **6** | `expect`, `simplify`, `web-design-guidelines` | **`expect` is the feature gate** — full browser QA across 4 viewports + accessibility + performance + console. `simplify` reviews for dead code (old dialog, orphaned state). `web-design-guidelines` final WCAG pass on dashboard → detail flow. |

---

*This strategy maximizes parallelization while respecting critical dependencies. The key insights: (1) Phase 1 is the only true bottleneck — after it deploys, two 2-stream windows open up; (2) the Phase 4 ↔ Phase 5 stub exchange is the only cross-stream contact surface in Window 3, and it's a clean overwrite, not a merge; (3) Phase 6's `expect` gate is the ship gate — no code review replaces browser verification. Solo delivery is ~6 days; optimal multi-agent delivery is ~3 days.*
