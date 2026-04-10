# Parallelization Strategy — Event Type Field Mappings (Feature F)

**Purpose:** This document defines the parallelization strategy across all 4 implementation phases of Feature F, identifying the critical path, dependency graph, file ownership boundaries, and maximum concurrency opportunities. Feature F is part of the v0.5 Window 1 work and sits on the critical path of Track 2 (F → E → C → D).

**Prerequisite:** v0.4 fully deployed. Feature G (UTM Tracking & Attribution) complete — `convex/lib/utmParams.ts` exists, pipeline extracts UTMs. Feature J (Form Handling Modernization) complete — RHF + Zod infrastructure in place. Schema deployed via `npx convex dev`. Feature I (Meeting Detail Enhancements) is being built in parallel by another agent — coordinate schema deployments per `plans/v0.5/feature-area-parallelization-strat.md`.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **1** | Schema: Custom Field Mapping Fields | Backend (Config) | Low | None (G complete) |
| **2** | Auto-Discovery of Custom Field Keys | Backend | Low | Phase 1 |
| **3** | Backend: Field Mapping Mutation & Aggregation Query | Backend | Low-Medium | Phase 1 |
| **4** | Settings UI: Field Mappings Tab & Dialog | Frontend | Medium | Phase 3 |

---

## Master Dependency Graph

```
┌──────────────────────────────────────────────────────────────────────┐
│                           PHASE 1                                    │
│  Schema: Custom Field Mapping Fields (FOUNDATION)                    │
│  Type: Config  |  Complexity: Low  |  Est: 15-20 min                 │
└─────────────────────┬────────────────────────┬───────────────────────┘
                      │                        │
           ┌──────────▼───────────┐  ┌─────────▼──────────────────────┐
           │      PHASE 2         │  │         PHASE 3                 │
           │  Auto-Discovery of   │  │  Backend: Mutation + Query      │
           │  Custom Field Keys   │  │  Type: Backend | Low-Medium     │
           │  (Pipeline change)   │  │  Est: 1-1.5 hours               │
           │  Type: Backend | Low │  │                                  │
           │  Est: 30-45 min      │  │  CRITICAL PATH                  │
           └──────────────────────┘  └──────────────┬─────────────────┘
                                                    │
                                     ┌──────────────▼─────────────────┐
                                     │         PHASE 4                 │
                                     │  Settings UI: Tab + Dialog      │
                                     │  Type: Frontend | Medium        │
                                     │  Est: 2-3 hours                 │
                                     │                                  │
                                     │  CRITICAL PATH                  │
                                     └────────────────────────────────┘
```

**Key observation:** Phase 2 and Phase 3 are completely independent after Phase 1. Phase 4 depends only on Phase 3 (not Phase 2). Phase 2 can complete at any point before the final quality gate.

---

## Maximum Parallelism Windows

### Window 1: Foundation (Sequential — Must Complete First)

**Concurrency:** 1 stream. Phase 1 has only 2 tiny subphases that must be sequential (modify schema → deploy).

Phase 1 adds two optional fields to the `eventTypeConfigs` table in `convex/schema.ts`. Everything else blocks on this because:
- Phase 2 writes to `knownCustomFieldKeys` — the field must exist.
- Phase 3 defines a mutation that reads/writes both new fields — TypeScript types must include them.
- Phase 4 displays both fields — generated types must be available.

```
Timeline: ██████████████
          1A (schema mod) ── 1B (deploy & verify)
                                     │
                                     ▼
                              Window 2
```

**Estimated time:** 15-20 minutes

**Schema coordination with Feature I:** Feature I (Meeting Detail Enhancements) also adds schema fields in v0.5 Window 1. Per `plans/v0.5/feature-area-parallelization-strat.md`:
- Feature I modifies the `meetings` table (adds `meetingOutcome`)
- Feature F modifies the `eventTypeConfigs` table (adds `customFieldMappings`, `knownCustomFieldKeys`)
- **Different tables — no conflict.** Deploy I's schema first, then F's, serializing `npx convex dev` invocations.

---

### Window 2: Backend Parallelism (After Phase 1)

**Concurrency:** 2 completely independent backend streams running simultaneously.

After Phase 1 deploys, Phase 2 and Phase 3 can start immediately and run in parallel. They touch **entirely different files**:

- **Phase 2** modifies `convex/pipeline/inviteeCreated.ts` (auto-discovery at end of handler)
- **Phase 3** modifies `convex/eventTypeConfigs/mutations.ts` (new mutation) and `convex/eventTypeConfigs/queries.ts` (new query)

No shared files. No shared imports beyond `convex/_generated/` (which is auto-generated and read-only). No merge conflicts possible.

```
Timeline:           ██████████████████████████████████████████████████████
                    Phase 2 (Auto-Discovery) ────────────────────────────┐
                    Phase 3 (Backend Mutation + Query) ──────────────────┤
                                                                         ▼
                                                                   Window 3
```

**Within Phase 2 (internal):**
```
2A (Add discovery logic to inviteeCreated.ts) ── 2B (Deploy & verify)
```

**Within Phase 3 (internal parallelism):**
```
3A (updateCustomFieldMappings mutation) ─────────────────┐
                                                         ├── 3C (Deploy & verify)
3B (getEventTypeConfigsWithStats query) ─────────────────┘
```

3A and 3B can run in parallel (different files: `mutations.ts` vs `queries.ts`). 3C waits for both.

**Note:** Phase 2 is NOT on the critical path. If Phase 3 finishes before Phase 2, Phase 4 can start immediately. Phase 2 can complete later — its output (populated `knownCustomFieldKeys`) is needed for _testing_ Phase 4's dropdowns, but not for _building_ Phase 4.

**Estimated time:** 1-1.5 hours (Phase 3 is the longer of the two; Phase 2 takes ~30-45 min)

---

### Window 3: Frontend (After Phase 3)

**Concurrency:** Up to 2 frontend subphases in parallel, then 2 sequential subphases.

Phase 4 depends on Phase 3 for the mutation and query endpoints. It does NOT depend on Phase 2 (the UI handles empty `knownCustomFieldKeys` gracefully).

```
Timeline:                                                   ██████████████████████████████████████████████████
                                                            Phase 4 (Settings UI: Tab + Dialog) ─────────────┐
                                                                                                              ▼
                                                                                                         QUALITY GATE
```

**Within Phase 4 (internal parallelism):**
```
4A (field-mappings-tab.tsx — new file) ──────────────────────┐
                                                              ├── 4C (wire into settings-page-client.tsx)
4B (field-mapping-dialog.tsx — new file) ────────────────────┘
                                                              │
                                                              └── 4D (Browser verification — Expect)
```

4A and 4B can run in parallel (they create separate new files with no dependencies on each other). 4C imports both components and wires them into the existing settings page. 4D is the final browser QA step.

**Estimated time:** 2-3 hours

---

## Critical Path Analysis

The **critical path** (longest sequential chain determining minimum delivery time):

```
Phase 1 ──── Phase 3 ──── Phase 4
  │              │            │
  │              │            └── Settings UI: Tab + Dialog (Medium, 2-3h)
  │              └── Backend: Mutation + Query (Low-Medium, 1-1.5h)
  └── Schema: add 2 optional fields (Low, 15-20 min)
```

**Length:** 3 sequential phases. Estimated critical path time: ~3.5-5 hours.

**Alternative shorter path:**

```
Phase 1 ──── Phase 2
  │              │
  │              └── Auto-Discovery: pipeline change (Low, 30-45 min)
  └── Schema (Low, 15-20 min)
```

**Length:** 2 sequential phases. Estimated: ~45-65 minutes. This path completes before the critical path — auto-discovery is ready before the UI, so `knownCustomFieldKeys` will be populated by the time Phase 4 is tested.

**Implication:** Start Phase 3 immediately after Phase 1 deploys — it's on the critical path. Phase 2 can start at the same time but has slack. If resources are limited, prioritize Phase 3 over Phase 2.

---

## File Ownership Boundaries (Merge Conflict Prevention)

### Contested Files (Multiple Phases Touch)

| File | Phase Owner(s) | Coordination Rule |
|---|---|---|
| `convex/schema.ts` | **Phase 1 only** | All schema changes happen in Phase 1. No other phase modifies schema. Feature I (parallel agent) also modifies schema but for a **different table** (`meetings` vs `eventTypeConfigs`). Serialize `npx convex dev` invocations. |
| `app/workspace/settings/_components/settings-page-client.tsx` | **Phase 4C only** | Existing file. Phase 4C adds import, query subscription, loading gate check, tab trigger, and tab content. No other Feature F phase touches this file. |

### Exclusively Owned Files (No Conflicts)

| File | Phase Owner | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | **Phase 2** | Feature F appends at end of handler. Feature I does NOT touch this file. Future features (A, E, B) will modify earlier sections in Window 2+. Per parallelization strategy: merge order F → A → E → B. |
| `convex/eventTypeConfigs/mutations.ts` | **Phase 3A** | Append new mutation after existing `upsertEventTypeConfig`. |
| `convex/eventTypeConfigs/queries.ts` | **Phase 3B** | Append new query after existing `listEventTypeConfigs`. |
| `app/workspace/settings/_components/field-mappings-tab.tsx` | **Phase 4A** | New file. |
| `app/workspace/settings/_components/field-mapping-dialog.tsx` | **Phase 4B** | New file. |

### Cross-Feature-Area File Ownership

| File | Feature F Touch | Feature I Touch | Conflict? |
|---|---|---|---|
| `convex/schema.ts` | `eventTypeConfigs` table (Phase 1) | `meetings` table | **No** — different tables. Serialize deploys. |
| `convex/pipeline/inviteeCreated.ts` | End of function (Phase 2) | Not touched by I | **No** |
| `app/workspace/settings/_components/*` | New files + modify settings page (Phase 4) | Not touched by I (I works in `closer/meetings/`) | **No** |

---

## Recommended Execution Strategies

### Single Agent (Sequential — Optimal Order)

Execute phases in dependency order, leveraging internal parallelism where possible:

| Block | Phase | Hours (est.) | Rationale |
|---|---|---|---|
| 1 | **Phase 1** (Schema) | ~0.25h | Foundation — must deploy before anything else. |
| 2 | **Phase 3** (Mutation + Query) | ~1.25h | Critical path. Start immediately after Phase 1. Internal: 3A ∥ 3B, then 3C. |
| 3 | **Phase 2** (Auto-Discovery) | ~0.5h | Not on critical path but needed for test data. Run while Phase 3 deploys. |
| 4 | **Phase 4** (Settings UI) | ~2.5h | Largest phase. Internal: 4A ∥ 4B, then 4C, then 4D. |

**Estimated total:** ~4.5 hours

**Optimization:** Start Phase 2 during Phase 3's deploy step (3C). While waiting for `npx convex dev`, write the auto-discovery code. This shaves ~15 min by overlapping deploy wait time with coding.

### Two Parallel Agents

| Window | Agent A (Backend) | Agent B (Frontend / Pipeline) |
|---|---|---|
| **W1** | Phase 1 (Schema) | _(blocked on Phase 1)_ |
| _gate_ | _Deploy schema. Verify._ | |
| **W2** | Phase 3A (mutation) + Phase 3B (query) | Phase 2 (auto-discovery in pipeline) |
| _gate_ | _Deploy Phase 3. Agent B deploys Phase 2. Verify types._ | |
| **W3** | _(done or QA assist)_ | Phase 4A + 4B (parallel), then 4C, then 4D (Expect) |

**Estimated total wall time:** ~3-3.5 hours

**Coordination points:**
- After W1: Agent A signals schema deployed → both agents start.
- After W2: Agent A signals mutation + query deployed → Agent B starts Phase 4.
- Agent B handles all frontend work since Agent A has no remaining backend tasks.

### Three+ Agents

Not beneficial for Feature F — only 4 phases with a narrow dependency graph. The maximum useful parallelism is 2 concurrent streams (Window 2). A third agent would be idle for most of the execution. Better to allocate the third agent to Feature I (the Window 1 parallel feature area).

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 1** (Schema) | After Phase 1 | `npx convex dev` succeeds without schema errors. `pnpm tsc --noEmit` passes. `Doc<"eventTypeConfigs">` includes `customFieldMappings` and `knownCustomFieldKeys` in generated types. Existing Settings page works unchanged. |
| **Gate 2** (Backend) | After Phase 2 + Phase 3 | `updateCustomFieldMappings` mutation callable from Convex dashboard Function Runner — saves mappings on a test config. `getEventTypeConfigsWithStats` query returns configs with `bookingCount`, `lastBookingAt`, and `fieldCount`. Trigger a test booking → `knownCustomFieldKeys` populated on the config. Pipeline processing (lead/opportunity/meeting creation) still works correctly — auto-discovery is additive, not disruptive. |
| **Gate 3** (Frontend) | After Phase 4 | Navigate to `/workspace/settings` → "Field Mappings" tab visible. Event type cards display with stats. "Configure" opens dialog with populated dropdowns. Select a social handle field + platform → save → toast confirmation → badge appears on card. Form validation works: platform required when social field selected; double-mapping blocked. Empty state renders when no event types exist. |
| **Gate 4** (QA) | After Phase 4D (Expect) | Accessibility audit passes (no critical/serious violations). Performance metrics: LCP < 2.5s, CLS < 0.1. No console errors. Responsive: 4 viewports (1440, 1024, 768, 375) — cards stack, dialog scrollable, buttons accessible. |
| **Feature F Complete** | All gates pass | Full end-to-end: booking arrives → field keys auto-discovered → admin opens Field Mappings → configures social handle mapping → saves → mapping persisted. This is the v0.5 Window 1 Gate 1 check for Feature F (per `plans/v0.5/feature-area-parallelization-strat.md`). |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| **Phase 1 schema syntax error blocks everything** | **Critical** | The schema change is 2 optional fields with straightforward validators. Test with `npx convex dev` immediately after writing. The change is small enough to review in < 2 minutes. |
| **`getEventTypeConfigsWithStats` query too slow for large tenants** | **Medium** | Current approach scans all opportunities for the tenant. For the single production tenant (< 200 opportunities), this is fine. If it becomes slow, add a `by_tenantId_and_eventTypeConfigId` index on `opportunities`. Apply `convex-performance-audit` skill post-deployment. This is a non-goal for Feature F MVP. |
| **Auto-discovery write conflict under concurrent webhooks** | **Low** | Convex OCC handles this transparently — the retried transaction re-reads the config and computes the correct union. Tested in Phase 2B with concurrent booking simulation. |
| **Frontend built against missing backend functions** | **Medium** | Phase 4 depends on Phase 3's mutation and query. The dependency graph enforces this — 4 cannot start until 3C (deploy) completes. TypeScript compilation catches mismatches via Convex's generated API types. |
| **Dialog form validation edge cases** | **Low** | Zod `.superRefine()` handles cross-field validation (platform required with social field, no double-mapping). Tested manually in Phase 4D browser verification. |
| **Feature I schema deploy conflicts with Feature F schema deploy** | **Medium** | Both features modify `convex/schema.ts` but touch **different tables**. Serialize `npx convex dev` invocations (I first, then F — per parallelization strategy). Both additions are optional fields — order doesn't matter functionally. |
| **`knownCustomFieldKeys` array grows unbounded** | **Low** | Calendly limits custom questions per event type (typical: 5-10). Even with question text changes over time, unlikely to exceed 50 entries. Convex arrays support up to 8192 values. If needed, add a pruning mechanism later. Non-goal for v0.5. |
| **Phase 4 complexity exceeds estimate** | **Low** | Feature F's UI is a simple tab + dialog with 3 dropdowns. It follows established patterns (dynamic import, RHF + Zod, Card list). No complex visualizations, no multi-step wizards. Compared to Feature C (Lead Manager — the critical path bottleneck), this is straightforward. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | — | Pure schema change, no skills needed. Follow `convex/_generated/ai/guidelines.md` for validator syntax. |
| **2** | — | Small pipeline modification (~20 lines). Follow existing `inviteeCreated.ts` patterns. Refer to `.docs/calendly/` for webhook payload structure (specifically `questions_and_answers` format). |
| **3** | `convex-performance-audit` (post-deploy, if needed) | The `getEventTypeConfigsWithStats` query scans opportunities. Monitor via `npx convex insights` after deployment. Apply the skill if read costs are high. |
| **4** | `shadcn`, `frontend-design`, `vercel-react-best-practices`, `expect` | **shadcn**: `Select`, `Card`, `Badge`, `Alert`, `Dialog`, `Form` components. **frontend-design**: Production-grade card list and dialog layout. **vercel-react-best-practices**: `useEffect` for form reset, `form.watch()` for conditional rendering, dynamic imports. **expect**: Final browser QA — accessibility audit, performance metrics, responsive check, console errors. |

---

## Combined Execution Timeline

```
Phase:    1           2              3                 4
          ├───────────┼──────────────┼─────────────────┼──────────────────────────┤
          │           │              │                 │                          │
          │  Schema   │  Pipeline    │  Mutation+Query │  Settings UI + QA        │
          │  (15min)  │  (30-45min)  │  (1-1.5h)      │  (2-3h)                  │
          │           │              │                 │                          │

Window 1: ████████████
          1A → 1B

Window 2:              ████████████████████████████████
                       2A → 2B (parallel with Phase 3)
                       3A ∥ 3B → 3C

Window 3:                                              ████████████████████████████████████████████████
                                                       4A ∥ 4B → 4C → 4D (Expect)

Critical: ████████████                 ████████████████ ████████████████████████████████████████████████
Path:     Phase 1 ──────────────────── Phase 3 ──────── Phase 4
```

---

## Summary Metrics

| Metric | Value |
|---|---|
| **Total phases** | 4 |
| **Total subphases** | 11 (2 + 2 + 3 + 4) |
| **Maximum concurrency** | 2 (Window 2: Phase 2 ∥ Phase 3) |
| **Critical path** | Phase 1 → Phase 3 → Phase 4 |
| **Critical path bottleneck** | Phase 4 (Settings UI — largest frontend surface) |
| **Files created** | 2 (`field-mappings-tab.tsx`, `field-mapping-dialog.tsx`) |
| **Files modified** | 4 (`schema.ts`, `inviteeCreated.ts`, `mutations.ts`, `queries.ts`, `settings-page-client.tsx`) — 5 total |
| **Safest parallel pair** | Phase 2 ∥ Phase 3 (zero file overlap) |
| **Est. wall time (1 agent)** | ~4.5 hours |
| **Est. wall time (2 agents)** | ~3-3.5 hours |
| **True bottleneck** | Phase 4 (frontend) is the longest phase and must wait for Phase 3. Pipeline changes (Phase 2) have the most slack. |

---

*This strategy maximizes parallelization within Feature F's narrow dependency graph. The key insight: Phase 2 (pipeline auto-discovery) and Phase 3 (backend mutation/query) are completely independent — run them simultaneously after the schema deploys. Phase 4 (frontend) is the bottleneck; everything before it should aim to finish as early as possible to maximize time for UI work and QA.*
