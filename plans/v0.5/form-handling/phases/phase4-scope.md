# Phase 4 — Follow-Up Dialog Assessment — Agent Scope & QA Plan

**Agent Role**: Form Handling Modernization — Phase 4 (Assessment & Documentation)

**Status**: Ready to execute (Phase 1 complete; Phases 2, 3, 5 in parallel)

**Time Estimate**: 15–30 minutes for assessment + documentation

**Execution Model**: Sequential subphases (4A → 4B → 4C)

---

## Phase 4 Overview

**Goal**: Assess the Follow-Up Dialog (`follow-up-dialog.tsx`) for React Hook Form (RHF) + Zod migration eligibility and formally document the skip decision. This dialog is a **state-machine UI** with zero user-editable form fields — **no code changes required**.

**Key Insight**: Phase 4 is **parallel-safe** — it has zero shared files with Phases 2, 3, and 5. Assessment can happen while other dialogs are being migrated.

---

## Scope: What This Agent Will Do

### 4A — Code Review and Eligibility Audit (READ-ONLY)

1. **Open and read** `app/workspace/closer/meetings/_components/follow-up-dialog.tsx`
2. **Enumerate all `useState` hooks** — classify each as "UI state" or "form field state"
3. **Scan JSX for user-editable elements** — search for `<Input>`, `<Select>`, `<Textarea>`, or `<form>` tags
4. **Document findings** in a structured audit table (already defined in phase4.md)
5. **Conclusion**: Confirm zero user-editable fields → no RHF migration needed

**Files touched**: None (read-only)

### 4B — Formal No-Migration Decision

1. **Evaluate migration criteria** against the 4-point checklist from phase4.md:
   - Has user-editable input fields? **No**
   - Has manual validation logic in submit handler? **No**
   - Would benefit from inline error display (`<FormMessage>`)? **No**
   - Has `useState` hooks managing field values that RHF could replace? **No**
2. **Document the decision** with concrete evidence from 4A audit
3. **Note future redesign scope** — v0.5 Phase 4 Follow-Up Overhaul will add a "Set Reminder" form with RHF + Zod

**Files touched**: None (documentation only)

### 4C — Regression Verification (DEFERRED)

**This step is marked for later execution** once Phases 2, 3, and 5 are complete. See "QA Execution Plan" below.

Tasks for 4C:
- Run `pnpm tsc --noEmit` to verify type-safety across all migrations
- Open Follow-Up Dialog in browser and test end-to-end workflow
- Verify no cross-dialog regressions from import changes in other phases
- Confirm `git diff HEAD -- follow-up-dialog.tsx` shows zero changes

---

## Skills to Invoke

Per phase4.md, the `expect` skill is used **only in 4C (regression verification)**, which is deferred. For 4A and 4B (current scope), no skills are invoked — this is a manual code audit and documentation task.

**To be invoked later during QA**:
- `expect` — Browser verification + accessibility audit + console error check

---

## Acceptance Criteria (This Scope: 4A + 4B)

1. ✅ **Code audit complete** — All 5 `useState` hooks are classified and documented
2. ✅ **JSX scan complete** — Zero user-editable input fields confirmed
3. ✅ **Migration criteria checklist** — All 4 criteria evaluated with evidence
4. ✅ **Skip decision documented** — Formal rationale recorded with future redesign notes
5. ✅ **Type safety maintained** — `pnpm tsc --noEmit` passes (no changes made, so this is trivial)

---

## Files Involved

| File                                                              | Action    | Notes                                                  |
| ---------------------------------------------------------------- | --------- | ------------------------------------------------------ |
| `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` | Read-only | Target for audit; zero modifications expected          |
| `.docs/convex/nextjs.md`                                         | Reference | Context on Next.js patterns (if needed)                |
| `.docs/posthog/nextjs-setup.md`                                  | Reference | PostHog event patterns (if needed)                     |
| `plans/v0.5/form-handling/phases/phase4.md`                      | Reference | Source of truth for phase requirements                 |
| `AGENTS.md`                                                       | Reference | Form patterns, authorization, RSC standards            |

---

## Subphase Sequence

### Subphase 4A: Code Review & Eligibility Audit

**Duration**: ~10 minutes

**Steps**:
1. Read `follow-up-dialog.tsx` in full
2. Identify and list all `useState` hooks with their purposes
3. Scan the JSX for any user-editable elements (Input, Select, Textarea, form)
4. Create an audit table classifying each hook as "UI state" or "form field state"
5. Note: The read-only `<InputGroupInput>` for the booking URL is **not a form field**

**Deliverable**: Audit findings documented in response

---

### Subphase 4B: Formal No-Migration Decision

**Duration**: ~5 minutes

**Steps**:
1. Evaluate all 4 migration criteria from phase4.md lines 114–119
2. Document decision with evidence from 4A
3. Note the future v0.5 Phase 4 redesign scope (two-path dialog with "Send Link" + "Set Reminder" form)
4. Confirm this decision aligns with the design document's assessment

**Deliverable**: Decision documented in response + future scope noted

---

### Subphase 4C: Regression Verification (DEFERRED)

**Status**: Not executed in this phase. Will be triggered when Phases 2, 3, and 5 are complete.

**Trigger**: User runs the separate QA checklist file (created below)

---

## QA Execution Plan (Separate File)

A dedicated QA checklist will be created at:

```
plans/v0.5/form-handling/phases/phase4-qa.md
```

This file will contain:
- **Gate conditions**: "Run this after Phases 2, 3, 5 are merged to main"
- **Step-by-step QA procedures** for 4C (regression verification)
- **Browser verification checklist** (to be executed with `expect` skill)
- **Accessibility audit** (via expect MCP tools)
- **Console error check** (via expect MCP tools)
- **Final sign-off criteria**

---

## Related Files & Context

### Design Document
- `plans/v0.5/form-handling/form-handling-design.md` — Full feature design; Phase 4 identified as "state-machine dialog" on page ~5

### Parallelization Strategy
- `plans/v0.5/form-handling/phases/parallelization-strategy.md` — Window 2 spans Phases 2–5 in parallel; Phase 4 is trivial (15–30 min) and can start anytime after Phase 1

### Complementary Codebase Docs
- `AGENTS.md` — Form patterns (manual state, toast errors), authorization rules, RSC standards
- `.docs/convex/nextjs.md` — Next.js patterns (RSC, streaming, Suspense)
- `.docs/posthog/nextjs-setup.md` — PostHog event tracking patterns

---

## Notes for Future Phases

**When the v0.5 Phase 4 (Follow-Up & Rescheduling Overhaul) redesigns this dialog**, the implementer should:
1. Use RHF + Zod patterns established in Phases 2, 3, and 5 for the new "Set Reminder" form fields
2. Keep the "Send Link" path as a state-machine (no form fields)
3. Refer back to this assessment for context on why the original dialog was not migrated

---

## Execution Checklist

- [ ] **4A: Audit the follow-up dialog source** — Read file, classify hooks, scan JSX
- [ ] **4B: Document no-migration decision** — Evaluate criteria, record rationale
- [ ] **4C: Regression verification** — Deferred; QA checklist created separately
- [ ] **QA file created** — `phase4-qa.md` with browser verification steps
- [ ] **Phase 4 complete** — Ready for sign-off when Phases 2, 3, 5 are also done

---

*This scope document guides the Phase 4 agent through a focused, parallel-safe assessment. No code changes. No merge conflicts. Formal documentation ready for future development.*
