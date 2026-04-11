# Feature Area H Design Review — Alignment & Coverage Assessment

**Review Date:** 2026-04-10  
**Reviewer Scope:** Alignment with parallelization strategy (`feature-area-parallelization-strat.md`) and design standards (`.docs/internal/Design-document-creation.md`)  
**Document Reviewed:** `closer-unavailability-design.md` (v0.1 Draft)

---

## Executive Summary

The design document is **well-structured and comprehensive**. It follows the Design Document Creation template closely and provides realistic implementation detail. However, there are **5 critical alignment gaps** with the parallelization strategy that must be addressed before implementation starts:

| Severity | Issue | Impact | Remediation |
|----------|-------|--------|-------------|
| **Critical** | Pipeline file coordination not mentioned | Feature H runs in Window 2 in parallel with A & E (both modify `inviteeCreated.ts`); no mention of this in design | Add explicit note that H does NOT touch `inviteeCreated.ts` (CRM-only reassignment) |
| **Critical** | `convex/admin/` backend directory not mentioned | Parallelization strategy isolates H in separate backend dirs; design has H code in `convex/unavailability/` | Clarify that `convex/unavailability/` is entirely separate from A, E, B's pipeline dirs — confirm this isolation matches strategy |
| **High** | Team page coordination with Feature A unclear | Strategy notes A also adds UI to `app/workspace/team/` (personal event type); no conflict mitigation described | Add subsection describing how "Mark Unavailable" action coexists with A's personal event type assignment UI |
| **Medium** | File ownership boundaries incomplete | Strategy doc lists all contested files; design doesn't reference this table | Add explicit section mapping design files to parallelization strategy's File Ownership Boundaries table |
| **Medium** | Gate coordination not referenced | Design assumes Window 2 completion; no mention of Gate 2c validation scope | Add brief section confirming which QA gates from the strategy apply to H |

---

## Detailed Alignment Review

### 1. **Pipeline File Coordination** ✅ GOOD, but needs explicit clarification

**Status:** The design correctly avoids modifying `convex/pipeline/inviteeCreated.ts` (CRM-only reassignment in v0.5). This is correct per the parallelization strategy.

**Current state in design:**
- Section 11.5: "No external API calls are made by this feature in v0.5"
- Section 9 (Convex Function Architecture): Only shows `unavailability/`, `closer/`, and `lib/unavailabilityValidation.ts` modifications

**Issue:** The design does not **explicitly state** "Feature H does not modify `inviteeCreated.ts`" or reference the parallelization strategy's merge order constraint (F → A → E → B). A future implementer reading only this design might add pipeline logic out of scope.

**Recommendation:**
- Add a sentence to the Scope section (line 5): "Feature H is CRM-only reassignment; Calendly calendar modifications are deferred (v0.6+). This feature does not modify the pipeline processor or `inviteeCreated.ts`."
- Add a note to Section 9 (Convex Function Architecture): "**Design decision: no pipeline integration in v0.5.** Feature H reassigns meetings at the CRM level only. Calendly calendar changes, Zoom link reassignment, and webhook event processing remain out of scope. Pipeline modifications (if needed in v0.6+) will follow the merge order constraint: existing F → A → E → B chain remains unchanged."

---

### 2. **Backend Directory Isolation** ✅ GOOD, but needs strategy cross-reference

**Status:** The design places H's backend code in `convex/unavailability/` — a separate directory from:
- Feature A: `convex/closer/`, `convex/pipeline/`
- Feature E: `convex/leads/`, `convex/pipeline/`
- Feature B: `convex/pipeline/`

This perfectly matches the parallelization strategy's File Ownership Boundaries.

**Current state in design:**
- Section 9 clearly shows `convex/unavailability/` as a new directory with mutations, queries, and redistribution logic
- No overlap with A, E, B directories

**Issue:** The design does not **reference** the parallelization strategy's statement: "H ↔ E | Entirely different dirs | **No**" (no conflict). This makes it harder to verify alignment without reading both documents.

**Recommendation:**
- Add a callout box to Section 9: "> **Parallelization note:** Feature H's backend (`convex/unavailability/`) is entirely separate from Features A, E, B's backend directories (pipeline, leads). No file ownership conflicts. See `feature-area-parallelization-strat.md` (Window 2 concurrent execution)."

---

### 3. **Team Page UI Coordination with Feature A** ⚠️ MISSING — Needs detailed mitigation

**Status:** The parallelization strategy explicitly calls this out:

> **Team page coordination (A ↔ H):** Both features add UI to `app/workspace/team/`:
> - **Feature A** adds a "Personal Event Type" assignment column/dialog to the team member list
> - **Feature H** adds a "Mark Unavailable" action button and redistribution flow
> 
> These are **separate files** within the same `_components/` directory. No merge conflict if each creates its own component files. The team page layout (`page.tsx` or page client component) may need minor coordination if both add action buttons to the same table row — resolve by having one feature add a generic "Actions" dropdown that the other extends.

**Current state in design:**
- Section 10 (Routing & Authorization) shows H adds `mark-unavailable-dialog.tsx` component
- Section 6 (Phase 3) describes the dropdown items on team member rows
- **No mention** of Feature A's personal event type column or how they share the row

**Issue:** An implementer of H will have no guidance on how to coordinate with A (which may already be merged or in parallel development). If both add separate "action" buttons, the table will look cluttered; if one uses a dropdown, the other should extend it.

**Recommendation:**
- Add a subsection to Section 5.2 (Team Page Integration):

```markdown
### 5.2.1 Action Button Coordination with Feature A

Feature A (Follow-Up Overhaul) also adds a UI element to the team member table: 
a "Personal Event Type" assignment dialog/flow. Both H and A modify the same 
table row layout. To avoid button clutter:

- **If A has not yet merged:** H should create a generic `<TeamMemberActionsDropdown>` 
  component with "Mark Unavailable" as the first item. Feature A will extend this 
  dropdown to add "Assign Personal Event Type" when it merges.
- **If A has already merged:** H extends A's existing `<TeamMemberActionsDropdown>` 
  by adding "Mark Unavailable" as an additional menu item.

See `feature-area-parallelization-strat.md` § "Team page coordination (A ↔ H)" 
for full coordination rules.
```

---

### 4. **File Ownership Boundaries — Missing Cross-Reference** ⚠️ INCOMPLETE

**Status:** The parallelization strategy defines a comprehensive File Ownership Boundaries table (Section 8, lines 248–277). H appears in several rows:

| File | Owner(s) | Coordination Rule |
|---|---|---|
| `convex/lib/permissions.ts` | **C** (lead permissions), **D** (customer permissions), **H** (closer/meeting reassign permissions) | Each feature appends new permission entries. No modifications to existing entries. Merge in any order — all additive. |
| `app/workspace/team/_components/` | **A** (personal event type assignment), **H** (mark unavailable + redistribution) | Separate component files. If both add action buttons to the team table, coordinate via a shared "Actions" dropdown. |

**Current state in design:**
- Section 8.4 (Modified: `permissions.ts`) shows 3 new permissions
- Section 10 shows team page components
- **No cross-reference** to the parallelization strategy's File Ownership Boundaries table

**Issue:** Implementer cannot easily verify that H's changes align with the strategy's coordination rules.

**Recommendation:**
- Add a new subsection at the end of Section 9 (after Convex Function Architecture):

```markdown
### 9.1 File Ownership Alignment with Feature Area Parallelization

This design's file modifications map to the `feature-area-parallelization-strat.md` 
File Ownership Boundaries table as follows:

| File | Strategy Owner(s) | This Design's Changes | Coordination |
|---|---|---|---|
| `convex/lib/permissions.ts` | C, D, H | **H adds 3 entries** (lines 139–141) | Additive only. Merge order independent. No conflicts with C or D. |
| `convex/schema.ts` | All features (I, F, A, H, E, B, C, D) | **H adds 2 tables** (closerUnavailability, meetingReassignments) + 1 modified field (meetings.reassignedFromCloserId) | Deploy in Window 2 order. Serialize with A & E schema deploys. See strategy § "Schema Coordination" (lines 100–101). |
| `app/workspace/team/_components/` | A, H | **H creates mark-unavailable-dialog.tsx** | Coordinate with A's personal event type UI via shared Actions dropdown. See strategy § "Team page coordination" (lines 145–152). |

No conflicts with other features' file ownership. H's backend is entirely isolated 
in `convex/unavailability/`.
```

---

### 5. **Quality Gates — Missing Reference** ⚠️ LOW PRIORITY, but improves clarity

**Status:** The parallelization strategy defines 6 gates (plus Final). Feature H is tested by Gate 2c:

> **Gate 2c** | After H | Admin can mark closer unavailable. Auto-distribute assigns meetings to available closers. Reassigned meetings show badge on new closer's dashboard. `meetingReassignments` audit trail populated.

**Current state in design:**
- Section 12 (Error Handling) covers scenarios that would be caught by testing
- No explicit reference to the gate's scope or acceptance criteria

**Issue:** Implementer may not understand what "done" looks like for H until they read the parallelization strategy separately.

**Recommendation:**
- Add a brief callout to the end of Section 1 (Goals & Non-Goals):

```markdown
### Quality Gate Reference

This feature's completion is validated by **Gate 2c** from the v0.5 parallelization strategy:
- Admin can mark closer unavailable with categorized reason
- System auto-distributes meetings to available closers based on workload + time-slot availability
- Reassigned meetings show "Reassigned" badge + original closer name on reassigned closer's dashboard
- Full `meetingReassignments` audit trail is populated
- Manual resolution flow works for meetings that cannot be auto-assigned

See `feature-area-parallelization-strat.md` § "Quality Gates" for full acceptance criteria.
```

---

## ✅ Strengths of the Design

1. **Comprehensive coverage:** Phases 1–4 logically progress from schema to UI to execution
2. **Realistic code examples:** Every phase has TypeScript code with path comments (not pseudo-code)
3. **Edge case depth:** 7 detailed edge cases (12.1–12.7) with detection, action, user-facing behavior
4. **Error handling:** Clear distinction between validation errors and runtime failures
5. **Security:** Multi-tenant isolation, role-based access, input validation all covered
6. **Applicable skills:** Correct identification of shadcn, frontend-design, expect, convex-performance-audit
7. **Dependencies:** Correctly notes no new packages needed (RHF + Zod already installed)
8. **Async/streaming:** Design respects Next.js App Router and Convex patterns established in AGENTS.md

---

## Summary of Required Changes

| Change | Section | Type | Effort |
|--------|---------|------|--------|
| Add explicit "no pipeline modification" statement to Scope | Scope (line 5) | Text addition | 1 line |
| Add parallelization strategy cross-reference to Convex Function Architecture | Section 9 | Callout box | 3–4 lines |
| Add team page coordination subsection with Feature A | Section 5.2 | Subsection + code example | 10–15 lines |
| Add File Ownership Boundaries alignment table | Section 9.1 (new) | New subsection | 20 lines |
| Add Quality Gate reference | Section 1 | Callout box | 6–8 lines |

**Total additions:** ~50 lines of clarifying text and tables. Design substance unchanged.

---

## ✅ Design Readiness Verdict

**Status:** ✅ **APPROVED FOR IMPLEMENTATION** with 5 optional but **strongly recommended** clarifications.

The design is **100% functionally aligned** with the parallelization strategy (no changes to logic, scope, or file ownership). The gaps are purely **cross-reference clarity** — making the design easier to implement and verify against the strategy without context-switching.

**Recommendation:** Apply the 5 clarifications above, re-export the design, and mark it as **v0.2 (Ready for Implementation)**.

---

*Review completed: 2026-04-10*
