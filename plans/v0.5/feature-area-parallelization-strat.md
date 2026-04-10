# Parallelization Strategy — v0.5 Feature Areas

**Purpose:** This document defines the parallelization strategy across all 10 v0.5 feature areas, identifying the critical path, dependency graph, file ownership boundaries, and maximum concurrency opportunities. It operates at the **feature-area level** (A through J) — individual phase plans within each feature area will have their own internal subphase parallelization.

**Current state:** Feature Areas **J** (Form Handling Modernization) and **G** (UTM Tracking & Attribution) are **complete**. The remaining 8 feature areas are the scope of this strategy.

**Prerequisite:** v0.4 fully deployed. RHF + Zod form infrastructure in place (J). Pipeline UTM extraction and `utmParams` fields on meetings/opportunities deployed (G). `convex/lib/utmParams.ts` utility exists.

---

## Feature Area Overview

| Area | Name                                      | Type        | Complexity    | Dependencies     | Status     |
|------|-------------------------------------------|-------------|---------------|------------------|------------|
| **J** | Form Handling Modernization              | Frontend    | Low           | None             | **Done** |
| **G** | UTM Tracking & Attribution               | Backend     | Medium        | None             | **Done** |
| **I** | Meeting Detail Enhancements              | Full-Stack  | Medium        | G                | Ready      |
| **F** | Event Type Field Mappings                | Full-Stack  | Low-Medium    | G                | Ready      |
| **A** | Follow-Up & Rescheduling Overhaul        | Full-Stack  | High          | G + I            | Blocked    |
| **H** | Closer Unavailability & Redistribution   | Full-Stack  | High          | I                | Blocked    |
| **E** | Lead Identity Resolution                 | Backend+    | High          | F                | Blocked    |
| **B** | No-Show Management                       | Full-Stack  | Medium-High   | A                | Blocked    |
| **C** | Lead Manager                             | Full-Stack  | High          | E                | Blocked    |
| **D** | Lead-to-Customer Conversion              | Full-Stack  | Medium        | C                | Blocked    |

---

## Master Dependency Graph

```
  ┌──────────────────┐    ┌──────────────────┐
  │   FEATURE J      │    │   FEATURE G      │
  │  Form Handling   │    │  UTM Tracking    │
  │     DONE         │    │     DONE         │
  └──────────────────┘    └────────┬─────────┘
                                   │
                     ┌─────────────┼─────────────┐
                     │             │             │
           ┌─────────▼────────┐   │   ┌─────────▼────────┐
           │   FEATURE I      │   │   │   FEATURE F      │
           │  Meeting Detail  │   │   │  Field Mappings  │
           │  (Medium)        │   │   │  (Low-Medium)    │
           └────┬─────────┬───┘   │   └────────┬─────────┘
                │         │       │            │
      ┌─────────▼───┐  ┌─▼───────▼──┐  ┌──────▼─────────┐
      │ FEATURE A   │  │ FEATURE H  │  │  FEATURE E     │
      │ Follow-Up & │  │ Closer     │  │  Lead Identity │
      │ Rescheduling│  │ Unavail &  │  │  Resolution    │
      │ (High)      │  │ Redistrib. │  │  (High)        │
      └──────┬──────┘  │ (High)     │  └───────┬────────┘
             │         └────────────┘          │
      ┌──────▼──────┐               ┌──────────▼────────┐
      │ FEATURE B   │               │  FEATURE C        │
      │ No-Show     │               │  Lead Manager     │
      │ Management  │               │  (High)           │
      │ (Med-High)  │               └──────────┬────────┘
      └─────────────┘                          │
                                     ┌─────────▼─────────┐
                                     │  FEATURE D        │
                                     │  Customer         │
                                     │  Conversion       │
                                     │  (Medium)         │
                                     └───────────────────┘
```

**Three independent tracks emerge after G:**

| Track | Chain                   | Length | Focus                    |
|-------|-------------------------|--------|--------------------------|
| **1** | I → A → B               | 3      | Pipeline / Meeting flow  |
| **2** | F → E → C → D           | 4      | Identity / Lead / Customer |
| **3** | I → H                   | 2      | Operations / Workload    |

Tracks 1 and 3 share Feature I as a starting dependency, then diverge completely.
Tracks 1 and 2 share one contested file (`convex/pipeline/inviteeCreated.ts`) — see [File Ownership Boundaries](#file-ownership-boundaries-merge-conflict-prevention).

---

## Maximum Parallelism Windows

### Window 1: Foundation Layer (Immediate Start)

**Concurrency:** 2 independent streams running simultaneously.

Features I and F are both unblocked now that G is complete. They touch **entirely different directories**:

- **Feature I** works in `app/workspace/closer/meetings/_components/` (UI cards), `convex/closer/` or `convex/meetings/` (queries)
- **Feature F** works in `app/workspace/settings/_components/` (field mappings tab), `convex/eventTypeConfigs/` (mutations), `convex/pipeline/inviteeCreated.ts` (auto-discovery — additive, end-of-function)

No frontend overlap. Backend overlap limited to `convex/schema.ts` (both add optional fields — coordinate deployment order, both additive).

```
Timeline:  ███████████████████████████████████████████████
           Feature I (Meeting Detail Enhancements) ──────────┐
           Feature F (Event Type Field Mappings)   ──────────┤
                                                              ▼
                                                        Window 2
```

**Schema coordination:** Both features add fields to `convex/schema.ts`. Deploy I's schema additions first (adds `meetingOutcome` to `meetings`), then F's (adds `customFieldMappings` and `knownCustomFieldKeys` to `eventTypeConfigs`). Both are optional fields — order doesn't matter functionally, but serialize the actual `npx convex dev` deployments.

---

### Window 2: Triple Parallelism (After Window 1)

**Concurrency:** Up to 3 independent streams running simultaneously.

After Window 1 completes, three features are unblocked:

- **Feature A** (Follow-Up & Rescheduling) — needs I complete, G complete
- **Feature H** (Closer Unavailability) — needs I complete
- **Feature E** (Lead Identity Resolution) — needs F complete

```
Timeline:                                     ████████████████████████████████████████████
                                              Feature A (Follow-Up Overhaul)   ──────────┐
                                              Feature H (Closer Unavailability) ─────────┤
                                              Feature E (Identity Resolution)  ──────────┤
                                                                                          ▼
                                                                                    Window 3
```

**Why these are independent:**

| Pair  | Frontend directories          | Backend directories                 | Conflict? |
|-------|-------------------------------|--------------------------------------|-----------|
| A ↔ H | `closer/meetings/`, `closer/_components/` vs `team/_components/` | `convex/closer/`, `convex/pipeline/` vs `convex/admin/` (new) | **No** (separate routes, separate backend dirs) |
| A ↔ E | `closer/meetings/` (follow-up dialog) vs no new frontend | `convex/pipeline/inviteeCreated.ts` (both modify) | **Yes** — pipeline file conflict. See mitigation below. |
| H ↔ E | `team/_components/` vs no new frontend | Entirely different dirs | **No** |

**Pipeline file mitigation (A ↔ E):**

`convex/pipeline/inviteeCreated.ts` is modified by both A and E, but at **different code locations**:

- **Feature A** adds UTM intelligence at the **top** of the processing flow — before entity creation. It checks `utm_source === "ptdom"` and routes to deterministic opportunity linking.
- **Feature E** adds identity resolution in the **lead lookup/creation** section — it replaces the simple email-match with a multi-identifier lookup.

These are logically independent sections. **Recommended approach:**
1. Feature A merges its pipeline changes first (UTM routing is upstream).
2. Feature E begins with schema (`leadIdentifiers` table), normalization utilities, and pipeline prep work.
3. Feature E's final pipeline integration step (modifying `inviteeCreated.ts`) starts after Feature A's pipeline changes have merged.

This means E runs ~90% in parallel with A, with only the final pipeline integration step serialized.

**Team page coordination (A ↔ H):**

Both features add UI to `app/workspace/team/`:
- **Feature A** adds a "Personal Event Type" assignment column/dialog to the team member list
- **Feature H** adds a "Mark Unavailable" action button and redistribution flow

These are **separate files** within the same `_components/` directory. No merge conflict if each creates its own component files. The team page layout (`page.tsx` or page client component) may need minor coordination if both add action buttons to the same table row — resolve by having one feature add a generic "Actions" dropdown that the other extends.

---

### Window 3: Downstream Parallelism (After Window 2)

**Concurrency:** 2 independent streams running simultaneously.

After Window 2 completes:

- **Feature B** (No-Show Management) — needs A complete
- **Feature C** (Lead Manager) — needs E complete

```
Timeline:                                                                        ██████████████████████████████████
                                                                                 Feature B (No-Show Mgmt)   ──────┐
                                                                                 Feature C (Lead Manager)   ──────┤
                                                                                                                   ▼
                                                                                                             Window 4
```

**Why these are independent:**

- **Feature B** works in `app/workspace/closer/meetings/_components/` (no-show action bar), `convex/pipeline/inviteeCreated.ts` (heuristic detection)
- **Feature C** works in `app/workspace/leads/` (**new route**), `convex/leads/` (**new directory**), `convex/lib/permissions.ts`

Zero frontend overlap (B extends existing meeting page, C creates an entirely new route). Backend overlap limited to `convex/schema.ts` (both additive). B touches the pipeline; C does not.

**Pipeline note:** Feature B adds heuristic reschedule detection to `inviteeCreated.ts`. By this point, both A and E have already merged their pipeline changes. B's heuristic sits **between** A's UTM check and E's identity resolution in the processing priority chain:

```
Processing order in inviteeCreated.ts (after all features):
1. UTM extraction (G - done)
2. utm_source === "ptdom" → deterministic linking (A)
3. Heuristic reschedule detection (B)           ◄── Window 3 addition
4. Identity resolution / multi-identifier lookup (E)
5. Create/update lead and opportunity (existing)
6. Auto-discover custom field keys (F)
7. Extract social handle via field mapping (E)
```

---

### Window 4: Final Feature (After Window 3)

**Concurrency:** 1 stream (plus any Window 3 stragglers).

```
Timeline:                                                                                                          ██████████████████████████
                                                                                                                   Feature D (Customer Conv.)
```

Feature D (Lead-to-Customer Conversion) depends on Feature C (Lead Manager) because:
- Customers link to leads — the lead data model and UI must exist first
- The customer detail sheet links back to the Lead Manager
- `customer:view-own` permission relies on the lead/customer relationship established in C

Feature D is scoped as a **placeholder** (minimal list + detail sheet), so it's the shortest of the remaining features. If Feature B is still in progress from Window 3, D and B can overlap.

---

## Critical Path Analysis

The **critical path** (longest sequential chain determining minimum delivery time):

```
Feature F → Feature E → Feature C → Feature D
   │            │            │            │
   │            │            │            └── Customer conversion + placeholder UI (Medium)
   │            │            └── Full lead manager: list, search, detail, merge (High)
   │            └── Multi-identifier model, normalization, pipeline resolution (High)
   └── Field mapping config UI + auto-discovery (Low-Medium)
```

**Length:** 4 sequential feature areas, including 2 High complexity features (E, C).

**Alternative paths:**

```
Track 1:  Feature I → Feature A → Feature B     (3 features, 1 High + 1 Medium-High)
Track 3:  Feature I → Feature H                  (2 features, 1 High)
```

**Implication:** Track 2 (F → E → C → D) is the bottleneck. Start Feature F immediately and prioritize its completion — every day F is delayed pushes out E, C, and D by the same amount. Feature C (Lead Manager) is the highest-risk item on the critical path due to its large UI surface area and the complexity of the merge flow.

**Earliest completion timeline (assuming equal-size windows):**

```
Window:   1          2              3              4
          ├──────────┼──────────────┼──────────────┼──────────┤
Track 1:  I ─────────A ─────────────B                          
Track 2:  F ─────────E ─────────────C ─────────────D           ◄── CRITICAL PATH
Track 3:  (I)────────H
```

---

## File Ownership Boundaries (Merge Conflict Prevention)

When running feature areas in parallel, each area owns specific directories and files. This table covers **all contested files** — files that multiple features need to modify.

### Shared / Contested Files

| File | Owner(s) | Coordination Rule |
|---|---|---|
| `convex/schema.ts` | **All features** (I, F, A, H, E, B, C, D) | Serialize `npx convex dev` deployments. Each feature adds tables/fields in its own section with a comment header. Changes are additive (new optional fields, new tables) — no destructive modifications. Deploy in window order: W1 (I, F) → W2 (A, H, E) → W3 (B, C) → W4 (D). |
| `convex/pipeline/inviteeCreated.ts` | **F** (end-of-fn, auto-discovery), **A** (top, UTM routing), **E** (middle, identity resolution), **B** (middle, heuristic detection) | Merge order: **F → A → E → B**. F's change is at the end of the function (independent). A → E → B add logic in the pre-creation section, in that processing order. Each feature adds a clearly delimited code block with a `// [Feature X]` comment boundary. |
| `convex/pipeline/processor.ts` | **A** (UTM routing dispatch), **B** (no-show reschedule dispatch) | A merges first. B extends the dispatch table A establishes. |
| `convex/lib/permissions.ts` | **C** (lead permissions), **D** (customer permissions), **H** (closer/meeting reassign permissions) | Each feature appends new permission entries. No modifications to existing entries. Merge in any order — all additive. |
| `convex/crons.ts` | **A** (follow-up link expiry cron) | Only A adds a cron in v0.5 scope. No conflict. |
| `convex/lib/statusTransitions.ts` | **A** (follow-up transitions), **B** (no-show transitions) | A merges first (adds `follow_up_scheduled` transitions). B extends (adds no-show → reschedule transitions). |
| `app/workspace/closer/meetings/_components/` | **I** (new cards: deal won, attribution, proof, outcome), **A** (follow-up dialog redesign), **B** (no-show action bar), **E** (duplicate banner) | **Separate files per feature.** I creates new card components. A replaces the follow-up dialog (after I merges). B creates a no-show action bar component (after A). E adds a duplicate banner component (after F). The meeting detail page client component is the integration point — each feature adds its component to the page layout. |
| `app/workspace/team/_components/` | **A** (personal event type assignment), **H** (mark unavailable + redistribution) | Separate component files. If both add action buttons to the team table, coordinate via a shared "Actions" column/dropdown. |

### Exclusively Owned Directories (No Conflicts)

| Directory / File | Feature Owner | Notes |
|---|---|---|
| `app/workspace/settings/_components/` (field mappings tab) | **F** | New tab + dialog. No other feature touches settings in v0.5. |
| `app/workspace/leads/` | **C** | Entirely new route. Created by C. |
| `convex/leads/` | **C** | New backend directory for lead queries/mutations. |
| `app/workspace/customers/` | **D** | Entirely new route. Created by D. |
| `convex/customers/` | **D** | New backend directory for customer queries/mutations. |
| `app/workspace/closer/_components/` (reminders section) | **A** | New dashboard section for closer reminders. |
| `convex/lib/normalization.ts` (or similar) | **E** | New utility for social handle / phone normalization. |
| `convex/eventTypeConfigs/` | **F** | Existing dir — F adds field mapping mutation. No other feature modifies event type configs. |

---

## Recommended Execution Strategies

**Throughput baseline:** A coding agent completes a Low-Medium feature area (schema + backend + frontend) in ~1-2 hours and a High complexity feature area in ~3-5 hours. The bottleneck is not implementation speed — it's dependency gates (waiting for a prior feature to merge + deploy before the next can start) and the `convex/schema.ts` / `inviteeCreated.ts` serialization points.

### Single Agent (Sequential)

Execute in dependency order, prioritizing the critical path. Agent works one feature at a time, no idle waiting.

| Block | Feature(s) | Hours (est.) | Rationale |
|---|---|---|---|
| 1 | **F** then **I** | ~1h + ~2h | F is faster — finish it first to unblock E sooner. Then I to unblock A and H. |
| 2 | **A** | ~4h | High complexity. Pipeline UTM intelligence + dialog redesign + reminders section. |
| 3 | **E** | ~4h | Critical path. Schema + normalization + pipeline identity resolution. Pipeline merges cleanly after A. |
| 4 | **H** | ~4h | Independent of Track 2. Good break from pipeline work before B. |
| 5 | **B** | ~2h | Reuses A's scheduling link infra. Heuristic detection is the main new logic. |
| 6 | **C** | ~5h | Largest new UI surface. List + search + detail sheet + merge flow. |
| 7 | **D** | ~2h | Placeholder scope. Auto-conversion hook + minimal list. |

**Estimated total:** ~24 hours of agent execution, spread across ~2 days (accounting for schema deploys, QA gates, and human review between features).

### Two Parallel Agents

| Window | Agent A (Track 1: Pipeline/Meeting) | Agent B (Track 2: Identity/Lead) | Wall time |
|---|---|---|---|
| **W1** | Feature I (Meeting Detail) | Feature F (Field Mappings) | ~2h |
| _gate_ | _Deploy schema (I then F). Verify Gate 1._ | | ~15min |
| **W2** | Feature A (Follow-Up Overhaul) | Feature E (Identity Resolution) | ~4h |
| _gate_ | _A's pipeline changes merge first. E finishes pipeline integration. Deploy. Verify Gate 2a + 2b + Gate 3 (pipeline chain)._ | | ~30min |
| **W3** | Feature B (No-Show) → Feature H (Redistribution) | Feature C (Lead Manager) | ~5h |
| _gate_ | _Deploy. Verify Gate 4._ | | ~15min |
| **W4** | _(done or QA assist)_ | Feature D (Customer Conversion) | ~2h |
| _gate_ | _Verify Gate 5 + Final gate._ | | ~30min |

**Estimated total wall time:** ~14-15 hours (~1.5 days).

**Key coordination points:**
- Between W1 and W2: Serialize schema deployments (I first, then F). Both agents idle for ~15 min.
- Mid-W2: Agent A signals when A's pipeline changes are committed. Agent B then merges E's pipeline integration on top. This is the tightest coordination point.
- W3: Agent A takes B (~2h) then H (~4h). Agent B works C the whole window. C is the critical path bottleneck — Agent A should not block Agent B here.

### Three Parallel Agents

| Window | Agent A (Track 1) | Agent B (Track 2) | Agent C (Track 3) | Wall time |
|---|---|---|---|---|
| **W1** | Feature I | Feature F | Schema coordinator: deploys I+F schema, runs Gate 1 | ~2h |
| **W2** | Feature A | Feature E | Feature H | ~4h |
| _gate_ | _Schema coordinator (any idle agent): deploy A+E+H schema. A pipeline merges → E pipeline integration. Gate 2a/2b/2c + Gate 3._ | | | ~30min |
| **W3** | Feature B | Feature C | Feature D (starts after C's schema deploys, backend stubs from C) | ~4h |
| _gate_ | _Gate 4 + Gate 5. Final integration._ | | | ~30min |

**Estimated total wall time:** ~11-12 hours (under 1.5 days).

**Agent C role:** In W1, Agent C acts as the schema deployment coordinator (deploys both I and F schema changes in sequence, runs type checks). In W2, Agent C builds Feature H (fully independent). In W3, Agent C starts Feature D as soon as C's schema (customers table) is deployed — D's backend can be built while C's frontend is still in progress.

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 0** (Current) | J + G complete | `npx convex dev` succeeds. `pnpm tsc --noEmit` passes. Pipeline extracts UTMs from webhook payloads. Existing forms use RHF + Zod. |
| **Gate 1** | After I + F | Meeting detail shows Deal Won card with proof file display. UTM Attribution card renders. Meeting outcome tags persist. Settings > Field Mappings tab shows event types with auto-discovered field keys. Admin can configure social handle mapping. |
| **Gate 2a** | After A | Follow-up dialog shows two paths (link / reminder). Scheduling link uses closer's personal event type with UTM params. Lead books via link → pipeline links to existing opportunity (no duplicate created). Reminders section appears on closer dashboard with visual escalation. |
| **Gate 2b** | After E | `leadIdentifiers` table populated on new bookings. Social handle extracted via field mapping. Same social handle across bookings → resolved to same lead. Potential duplicates flagged on meeting detail. |
| **Gate 2c** | After H | Admin can mark closer unavailable. Auto-distribute assigns meetings to available closers. Reassigned meetings show badge on new closer's dashboard. `meetingReassignments` audit trail populated. |
| **Gate 3** | After A + E (pipeline integration) | **Full pipeline processing chain test:** Book with `utm_source=ptdom` → deterministic linking. Book same email after no-show → heuristic linking. Book same social handle, different email → identity resolution linking. All three paths work without interfering with each other. |
| **Gate 4** | After B + C | No-show action bar works (confirm / reschedule / follow-up). Reschedule chain displayed on meeting detail. Lead Manager at `/workspace/leads` — search, detail sheet, merge (admin direct + closer suggestion). |
| **Gate 5** | After D | Payment recording auto-creates customer record. `/workspace/customers` shows customer list. All relationship links navigable (Customer → Lead → Opportunity → Meeting). Lead status transitions to `converted`. |
| **Final** | All features complete | End-to-end smoke test: new lead books → meeting detail shows attribution → closer does follow-up → lead rebooks → pipeline links correctly → closer records payment → lead converts to customer → customer visible in customer list with full relationship graph. Run Expect: accessibility audit, performance metrics, console error check, 4 viewport responsive test. |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| **`inviteeCreated.ts` merge conflicts** across A, E, B, F | **Critical** | Strict merge order (F → A → E → B). Each feature's pipeline changes go in a clearly delimited block with `// === Feature X: description ===` comment boundaries. Code review after each merge to verify the processing priority chain is intact. |
| **Schema deployment collisions** (multiple features deploying to `convex/schema.ts` simultaneously) | **High** | Designate a single schema coordinator (or serialize deploys per window). All schema changes are additive (new optional fields, new tables) — no widen-migrate-narrow needed for initial additions. Each feature's schema additions are grouped under a comment header. |
| **Feature C (Lead Manager) complexity exceeds estimate** | **High** | C is on the critical path and is the largest new UI surface. Mitigate by: (1) splitting merge flow into a follow-up sub-task if it slips, (2) shipping the list/search/detail sheet first without merge, (3) using shadcn/ui primitives exclusively (no custom components). |
| **Feature H (Workload Redistribution) algorithm edge cases** | **Medium** | H is NOT on the critical path — it can slip without affecting Track 2. The auto-distribute algorithm should start simple (round-robin by lowest load) and refine later. Manual assignment is the fallback. |
| **Feature E identity resolution produces false positives** (merging wrong leads) | **High** | Only auto-merge on exact-match identifiers (email, phone, verified social handle). All fuzzy/partial matches surface as "Potential Duplicate" suggestions for human review. Never auto-merge on name similarity alone. Include `confidence` field on all `leadIdentifier` records. |
| **Feature A personal event type not assigned** blocks scheduling links | **Medium** | Graceful degradation: if `personalEventTypeUri` is null, show an actionable error ("Ask your admin to assign a personal calendar in Team settings") instead of a broken link. Feature A's UI must handle this state explicitly. |
| **Pipeline processing order regression** after multiple features modify `inviteeCreated.ts` | **High** | Gate 3 (after A + E pipeline integration) is a mandatory stop. Run the full pipeline test matrix: (1) organic booking, (2) CRM-generated follow-up, (3) no-show reschedule, (4) same-email rebooking, (5) same-social-handle different email. All five paths must work before proceeding to Window 3. |
| **Frontend built against missing backend** during parallel development | **Medium** | Each feature's design doc lists the backend functions the frontend depends on. Frontend can start with `useQuery` calls against stub data. Convex's type generation (`npx convex dev`) catches mismatches at compile time. |

---

## Applicable Skills Per Feature Area

| Feature Area | Skills to Invoke | Reason |
|---|---|---|
| **I** — Meeting Detail | `frontend-design`, `shadcn`, `expect` | New UI cards (Deal Won, Attribution, Proof display). Lightbox for image proofs. Browser QA for responsive card layouts. |
| **F** — Field Mappings | `shadcn`, `expect` | Settings tab UI with dropdowns. Simple form dialog. |
| **A** — Follow-Up Overhaul | `frontend-design`, `shadcn`, `vercel-react-best-practices`, `expect` | Dialog redesign (two-card selection), reminders dashboard section with time-based visual escalation, personal event type assignment UI. |
| **H** — Workload Redistribution | `frontend-design`, `shadcn`, `expect` | Multi-step redistribution wizard, auto-distribute algorithm visualization, manual resolution UI. |
| **E** — Identity Resolution | `convex-performance-audit` | Pipeline hot-path modifications — `leadIdentifiers` lookups on every webhook. Index design critical for performance. Normalization utils are pure backend. |
| **B** — No-Show Management | `frontend-design`, `shadcn`, `expect` | No-show action bar UI, reschedule chain display. Reuses scheduling link infrastructure from A. |
| **C** — Lead Manager | `frontend-design`, `shadcn`, `vercel-react-best-practices`, `vercel-composition-patterns`, `expect`, `web-design-guidelines` | Largest new UI surface: paginated table, search, detail sheet with 5 tabs, merge flow with side-by-side preview. Composition patterns for the tabbed detail sheet. Accessibility audit for the merge confirmation flow. |
| **D** — Customer Conversion | `shadcn`, `expect` | Minimal list + detail sheet (placeholder scope). Relationship navigation links. |

---

## Summary: Maximum Parallelism by Window

```
Window 1 (Immediate):   I ═══════════╗   F ═══════════╗
                                      ║                ║
                         2 streams    ║                ║
                                      ▼                ▼
Window 2 (After W1):    A ════════════════════╗  E ════════════════╗  H ═══════════╗
                                              ║                    ║               ║
                         3 streams            ║  (pipeline after A)║               ║
                                              ▼                    ▼               ▼
Window 3 (After W2):    B ═══════════╗               C ════════════════════════╗
                                     ║                                         ║
                         2 streams   ║                                         ║
                                     ▼                                         ▼
Window 4 (After C):                                  D ═══════════╗
                                                                   ║
                         1 stream                                  ▼
                                                                 DONE
```

| Metric | Value |
|---|---|
| **Total feature areas remaining** | 8 |
| **Maximum concurrency** | 3 (Window 2) |
| **Critical path** | F → E → C → D (4 sequential, ~60% of total work) |
| **Critical path bottleneck** | Feature C (Lead Manager) — highest complexity on the critical path |
| **Most contested file** | `convex/pipeline/inviteeCreated.ts` (4 features modify it) |
| **Safest parallel pair** | B ∥ C (zero file overlap, different routes, different backend dirs) |
| **Riskiest parallel pair** | A ∥ E (shared pipeline file — mitigated by section ownership + merge ordering) |
| **Est. wall time (1 agent)** | ~24h execution / ~2 days with gates |
| **Est. wall time (2 agents)** | ~15h execution / ~1.5 days with gates |
| **Est. wall time (3 agents)** | ~12h execution / <1.5 days with gates |
| **True bottleneck** | Not implementation — it's schema deploy serialization + pipeline merge ordering + QA gates between windows |

---

*This strategy maximizes parallelization while respecting the pipeline file bottleneck. The key insight: Track 2 (Identity/Lead) is the critical path — keep it moving at all costs. Track 1 (Pipeline/Meeting) and Track 3 (Operations) are shorter and more forgiving of delays. With coding agents, the wall-clock constraint is dependency gates and deploy serialization, not implementation speed.*
