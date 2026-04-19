# Parallelization Strategy — Meeting Comments

**Purpose:** Defines the parallelization strategy across the four implementation phases of the Meeting Comments feature. Identifies the critical path (1 → 2 → 3), the non-blocking optional phase (4), file ownership boundaries so multiple devs/agents can work concurrently without conflicts, and the quality gates between phases.

**Prerequisite:** The existing `meetings`, `opportunities`, `users`, `tenants` schema is deployed and healthy. No prior feature work must complete before this feature starts. `requireTenantUser` (`convex/requireTenantUser.ts`), `loadMeetingContext` (`convex/closer/meetingActions.ts`), `getUserDisplayName` (`convex/reporting/lib/helpers.ts`), and the `useRole()` hook (`components/auth/role-context.tsx`) all already exist.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **1** | Schema & Backend — Comments Table + Mutations | Backend | Low–Medium | None (foundation) |
| **2** | Frontend — Comment System UI | Frontend | Medium | Phase 1 |
| **3** | Outcome Dropdown Removal & Notes Cleanup | Full-Stack (mostly deletions) | Low | Phase 2 |
| **4** | Data Migration — Notes → Comments | Backend (internal mutation) | Low | Phase 1 (only) |

**Total estimated time (solo):** 2–3 days
**Total estimated time (2 devs, parallel where possible):** 1.5–2 days

---

## Master Dependency Graph

```
                    ┌──────────────────────────────────────────────────────────┐
                    │                         PHASE 1                          │
                    │  Schema + 3 Mutations + 1 Query (FOUNDATION)             │
                    │  convex/schema.ts, convex/closer/meetingComments.ts      │
                    └──────────┬──────────────────────────────────┬────────────┘
                               │                                  │
                               │                                  │
                    ┌──────────▼──────────┐           ┌───────────▼────────────┐
                    │      PHASE 2        │           │       PHASE 4          │
                    │  Comment UI         │           │   Data Migration       │
                    │  (Full-Stack front) │           │   (Optional,           │
                    │                     │           │    operational)        │
                    └──────────┬──────────┘           └───────────┬────────────┘
                               │                                  │
                               │                                  │
                    ┌──────────▼──────────┐                       │
                    │      PHASE 3        │                       │
                    │  Outcome Removal    │                       │
                    │  + Notes Cleanup    │                       │
                    └──────────┬──────────┘                       │
                               │                                  │
                               └──────────────────┬───────────────┘
                                                  │
                                          Feature complete
```

**Key observation:** Phase 4 has **zero dependencies** on Phase 2 or Phase 3. It is deliberately optional and operational — the feature is complete without it.

---

## Maximum Parallelism Windows

### Window 1: Phase 1 Foundation (Sequential Gate, Internal Parallelism)

**Concurrency:** Up to **4 subphases** in parallel within Phase 1.

Phase 1 is the critical foundation — everything blocks on **1A (schema)**. However, once 1A deploys and the Convex type generator emits `Id<"meetingComments">`, the remaining four subphases (1B, 1C, 1D, 1E) all live in a single new file (`convex/closer/meetingComments.ts`) as independent `export const` blocks. They can be written concurrently and concatenated at commit time.

```
Timeline: ██████████████████████████████████
          1A (schema) ──┐
                        │
                        ├── 1B (addComment)   ────┐
                        │                         │
                        ├── 1C (editComment)  ────┤
                        │                         ├── Phase 1 ✓
                        ├── 1D (deleteComment)────┤
                        │                         │
                        └── 1E (getComments)  ────┘
```

**Internal dependencies:** 1A ← {1B, 1C, 1D, 1E}. No other ordering constraints.

---

### Window 2: Phase 2 + Phase 4 in Parallel (Full Independence)

**Concurrency:** **2 completely independent streams.**

After Phase 1 ships, **Phase 2** and **Phase 4** have zero shared files. They can execute simultaneously on different developers / agents / branches:

- **Phase 2** touches:
  - `app/workspace/closer/meetings/_components/*` (new component files)
  - `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` (modify)
  - `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx` (modify)
- **Phase 4** touches:
  - `convex/closer/meetingCommentsMigration.ts` (new file)
  - `plans/meeting-comments/phases/phase4.md` (documentation)

```
Timeline:                ████████████████████████████████████████████
                         Phase 2 (Comment UI + page swaps) ──────────┐
                         Phase 4 (Migration mutation)    ────────────┤
                                                                     ▼
                                                              Window 3
```

**Within Phase 2 (internal parallelism):**

```
2A (CommentContent)   ─────────────────────┐
                                           │
2B (CommentInput)     ─────────────────────┤
                                           │
2C (CommentEntry)     ─── depends on 2A ───┤── 2D (MeetingComments — depends on 2B, 2C)
                                           │                         │
                                           │                         ├── 2E (closer swap) ──┐
                                           │                         │                      ├── Phase 2 ✓
                                           │                         └── 2F (admin swap) ───┘
                                           │
                                           │
                                           ▼
                                    Phase 2 backlog
```

**Within Phase 4 (internal parallelism):**

```
4A (migration mutation) ────┐
4B (operational runbook) ───┴── Phase 4 ✓ (optional)
```

---

### Window 3: Phase 3 (Sequential after Phase 2)

**Concurrency:** **5 subphases** in parallel within Phase 3.

Phase 3 **cannot** start until Phase 2 deploys — deleting `MeetingNotes` before the page clients stop importing it breaks the build. However, once Phase 2 ships, the internal Phase 3 subphases all touch **different files** and are completely parallelizable.

```
Timeline:                                                   ████████████████
                                                            3A (frontend deletes) ──┐
                                                            3B (lead tab column)   ─┤
                                                            3C (backend deletes)   ─┤── 3F (grep + tsc)
                                                            3D (deriveCallOutcome) ─┤
                                                            3E (schema comments)   ─┘
```

**Why they're independent:**
- 3A: `app/workspace/closer/meetings/_components/{meeting-notes,meeting-outcome-select}.tsx` — file deletions.
- 3B: `app/workspace/leads/[leadId]/_components/tabs/lead-meetings-tab.tsx` — JSX edit.
- 3C: `convex/closer/meetingActions.ts` — mutation deletes (two non-adjacent blocks).
- 3D: `convex/reporting/lib/outcomeDerivation.ts` — single branch removal.
- 3E: `convex/schema.ts` — comment additions only (no structural change).

Zero overlap.

---

### Window 4: Verification Checkpoint (Sequential, Required)

After Phase 3 subphases complete, **3F** is the blocking verification step: grep sweep, `pnpm tsc --noEmit`, `npx convex dev`, PostHog event check, and `expect` browser sweep. This cannot parallelize — it is a gate.

```
Timeline:                                                                   ████
                                                                            3F (sweep + gate)
                                                                            │
                                                                            ▼
                                                                      Feature complete
```

---

## Critical Path Analysis

The **critical path** (longest sequential chain determining minimum delivery time):

```
Phase 1 → Phase 2 → Phase 3
  │           │         │
  │           │         └── Outcome removal + notes cleanup (0.5 day)
  │           └── Frontend UI + page swaps (1–2 days)
  └── Schema + backend functions (0.5–1 day)
```

**Alternative shorter path:**

```
Phase 1 → Phase 4
```

Phase 4 alone can ship in ~0.5 day after Phase 1. It does not deliver the user-visible feature — Phase 2 is what users actually see — but it is available as soon as the schema is in place.

**Implication:** Start Phase 2 (specifically 2A) immediately after Phase 1A deploys. Phase 2 is the longest sequential step and determines the minimum delivery time. Phase 4 can slip or be deferred entirely without affecting Phase 3.

**Sequential minimum:** ~2.5 days on the critical path. With sub-phase-level parallelism, ~1.5 days with 2 devs.

---

## File Ownership Boundaries (Merge Conflict Prevention)

When running phases in parallel, each phase **owns** specific files. A file listed under one phase is not touched by any other phase.

| File / Directory | Phase Owner | Notes |
|---|---|---|
| `convex/schema.ts` | **Phase 1 (additions), Phase 3 (comments only)** | Phase 1 adds the `meetingComments` table block. Phase 3 adds deprecation comments to existing fields. **No conflict**: different sections. Sequential merge (Phase 1 first). |
| `convex/closer/meetingComments.ts` | **Phase 1 only** | Created in Phase 1. Never touched again. |
| `convex/closer/meetingCommentsMigration.ts` | **Phase 4 only** | New file. Never touched by any other phase. |
| `convex/closer/meetingActions.ts` | **Phase 3 only** | Existing file. Phase 3 deletes two mutations. No other phase modifies it. |
| `convex/reporting/lib/outcomeDerivation.ts` | **Phase 3 only** | Phase 3 deletes one branch + adds TODO. |
| `convex/requireTenantUser.ts` | **None — read-only** | Shared utility. All phases import; none modify. |
| `convex/reporting/lib/helpers.ts` | **None — read-only** | Shared utility (`getUserDisplayName`). Phase 1 imports. None modify. |
| `app/workspace/closer/meetings/_components/comment-content.tsx` | **Phase 2 only (create)** | New file in 2A. |
| `app/workspace/closer/meetings/_components/comment-input.tsx` | **Phase 2 only (create)** | New file in 2B. |
| `app/workspace/closer/meetings/_components/comment-entry.tsx` | **Phase 2 only (create)** | New file in 2C. |
| `app/workspace/closer/meetings/_components/meeting-comments.tsx` | **Phase 2 only (create)** | New file in 2D. |
| `app/workspace/closer/meetings/_components/meeting-notes.tsx` | **Phase 3 only (delete)** | Phase 2 stops importing it; Phase 3 deletes the file. No overlap. |
| `app/workspace/closer/meetings/_components/meeting-outcome-select.tsx` | **Phase 3 only (delete)** | Same as above. |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | **Phase 2 only (modify)** | 2E swaps the render + import. No other phase touches. |
| `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx` | **Phase 2 only (modify)** | 2F mirrors 2E. |
| `app/workspace/leads/[leadId]/_components/tabs/lead-meetings-tab.tsx` | **Phase 3 only (modify)** | 3B removes the "Outcome" column. No other phase touches. |
| `components/ui/*.tsx` | **None — read-only** | shadcn primitives (Card, Textarea, Button, Badge, DropdownMenu, Spinner). All already installed; no phase adds or modifies. |
| `components/auth/role-context.tsx` | **None — read-only** | `useRole()` hook. Phase 2 imports. None modify. |
| `plans/meeting-comments/phases/*.md` | **Their own phase** | Documentation lives with its phase. |

**Key rule:** `convex/schema.ts` is the only file modified by **two** phases (1 and 3), but the edits are in **different regions** (new table in Phase 1 vs. deprecation comments on existing fields in Phase 3). Because Phase 1 ships before Phase 3 (sequential on the critical path), there is no merge conflict window.

---

## Recommended Execution Strategies

### Solo Developer (1 person)

Work sequentially on the critical path and slot Phase 4 in as time permits:

1. **Phase 1** — 1A, then 1B/1C/1D/1E (can batch into one commit since they share a file).
2. **Phase 2** — 2A + 2B + 2C in one session, then 2D, then 2E + 2F together.
3. **Phase 3** — 3A + 3B + 3C + 3D + 3E all in one PR (deletions + comments only), then 3F verification.
4. **Phase 4** — optional. Write 4A + 4B. Execute per tenant when operations request.

**Estimated time:** 2–3 days.

### Two Developers (Backend + Frontend)

| Sprint | Developer A (Backend) | Developer B (Frontend) |
|---|---|---|
| **1** | Phase 1 (all — schema + 4 fns) | — (blocked on schema) |
| **2** | Phase 4A (migration mutation) | Phase 2A + 2B + 2C (components) |
| **3** | Phase 3C + 3D + 3E (backend deletes) | Phase 2D + 2E + 2F (main card + page swaps) |
| **4** | Phase 4B (runbook); assist on 3F | Phase 3A + 3B (frontend deletes + lead tab); 3F with A |

**Estimated time:** 1.5–2 days.

### Three Developers / Agents (Full Parallelism)

| Sprint | Agent A (Backend) | Agent B (Frontend) | Agent C (Cleanup + Migration) |
|---|---|---|---|
| **1** | Phase 1A | — (blocked) | — (blocked) |
| **2** | Phase 1B, 1D | Phase 2A (CommentContent) | Phase 4A (migration mutation) |
| **2** | Phase 1C, 1E | Phase 2B (CommentInput) | Phase 4B (runbook) |
| **3** | — | Phase 2C (CommentEntry), 2D (MeetingComments) | Prepare Phase 3 scripts |
| **4** | Phase 3C, 3D | Phase 2E, 2F (page swaps) | Phase 3A, 3B, 3E |
| **5** | — | 3F verification (all 3 agents together) | — |

**Estimated time:** 1–1.5 days.

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 1 — Schema Ready** | After Phase 1A deploys | `npx convex dev` succeeds; `meetingComments` table visible in dashboard; `Id<"meetingComments">` importable from `_generated/dataModel`. |
| **Gate 2 — Backend Ready** | After Phase 1 (all of 1B–1E) | Function runner: `addComment` rejects empty + >5000 chars; `editComment` enforces authorship; `deleteComment` closer-rejected + admin-allowed; `getComments` returns enriched + soft-delete-filtered. `pnpm tsc --noEmit` passes. |
| **Gate 3 — UI Live** | After Phase 2 (all subphases) | Both meeting detail pages render `<MeetingComments>`; post / edit / delete flows work; real-time sync across two tabs works; URL auto-linking works; `expect` a11y + perf audits pass; screenshots at 4 viewports saved. |
| **Gate 4 — Cleanup Verified** | After Phase 3F | Grep sweep returns zero matches for `meetingOutcome` / `MeetingNotes` / `MeetingOutcomeSelect` / `updateMeetingNotes` / `updateMeetingOutcome` outside `_generated` + `schema.ts`; `pnpm tsc --noEmit` passes; PostHog shows no new `meeting_outcome_set` events; product analytics notified. |
| **Gate 5 — Migration Verified (optional)** | After Phase 4A executes on test tenant | One migrated comment per non-empty-notes meeting; idempotent re-run = 0 new rows; batch continuation chained to `isDone=true`. |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Phase 1 schema error blocks everything | **Critical** | Deploy 1A immediately, before writing 1B–1E. Verify in the Convex dashboard before continuing. |
| Phase 2 ships with broken URL regex → XSS via malformed URL | **High** | Regex explicitly excludes `<>)"'\]`. React's JSX escaping prevents injection in the `{part.value}` text node. `rel="noopener noreferrer"` on all generated `<a>`. `web-design-guidelines` + `expect` skills verify at Gate 3. |
| Phase 3 deletes `MeetingNotes` before Phase 2 ships | **Critical** | Hard dependency: Phase 3 cannot start until Phase 2 is deployed to the test tenant and verified at Gate 3. File ownership table enforces ordering. |
| Phase 3 deletes `updateMeetingNotes`, breaks the Calendly webhook | **Medium** | Exploration confirmed the webhook writes `notes` via `ctx.db.insert`, not via the mutation. No breakage. `expect` + a manual Calendly test booking at Gate 4 verifies. |
| `deriveCallOutcome` DQ branch removal breaks a production reporter | **Medium** | Exploration confirmed zero production callers. Grep in 3D re-verifies. `pnpm tsc --noEmit` catches any residual import. |
| PostHog `meeting_outcome_set` event disappearance breaks a dashboard | **Medium** | Out-of-code mitigation: notify product analytics at Phase 3 release. Historical events preserved. |
| Lead meetings tab column removal surprises stakeholders | **Medium** | Communicate in release note. Point users to the new Comments card as the replacement signal. |
| Phase 4 migration mis-attributes author | **Low** | Runbook documents that the operator picks the `systemUserId`; idempotency makes re-runs safe. |
| Phase 4 executed on a tenant before Phase 2 ships UI | **Low** | No impact. The migrated comments sit in `meetingComments` invisibly until the UI lands. Intentionally decoupled. |
| Real-time subscription cost on large tenants | **Low** | `getComments` uses `.withIndex(...).take(200)` — bounded. Subscription opens only on meeting detail page mount. `convex-performance-audit` verifies at Gate 2. |
| Inline edit state loss on reactive update | **Low** | Inline edit state is local to `CommentEntry`. If the comment is edited or deleted by someone else while the user is mid-edit, Convex pushes a new `comment` prop; the local `editValue` state persists. If the comment is deleted, the row unmounts and the user sees a blank editor — acceptable (design §12.4). |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | `convex-setup-auth`, `convex-performance-audit` | Verify `requireTenantUser` is used correctly; confirm index naming + bounded queries. |
| **2** | `frontend-design`, `shadcn`, `web-design-guidelines`, `vercel-react-best-practices`, `expect` | Production-grade comment UI; reuse shadcn primitives; accessibility; React perf; browser verification at 4 viewports + a11y audit. |
| **3** | `simplify`, `expect` | Mechanical deletions benefit from a simplify pass (catch dead imports/types). Browser verification that the UI still looks right without the dropdown. |
| **4** | `convex-migration-helper`, `convex-performance-audit` | Confirm the cursored batch pattern + that widen-migrate-narrow isn't needed (it isn't — additive only). |

---

## Summary: Why This Is Simple

Three properties make the Meeting Comments feature well-suited for aggressive parallelization:

1. **Additive backend** — Phase 1 only **adds** a table and functions; no existing code is modified. The `_generated/api.d.ts` regeneration is automatic.
2. **Swap-in frontend** — Phase 2 replaces one component (`MeetingNotes`) with another (`MeetingComments`) at exactly two render sites. No cascade.
3. **Orthogonal cleanup** — Phase 3's five subphases each touch different files. They're all deletions or comment-only edits.

The feature has exactly **one strict ordering constraint** (Phase 2 must ship before Phase 3 to avoid a broken build). Everything else is decoupled enough for concurrent execution.

---

*Phase 4 is non-blocking and can ship whenever operational capacity allows. The feature is user-complete at the end of Phase 3.*
