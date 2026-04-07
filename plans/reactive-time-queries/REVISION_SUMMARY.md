# Reactive Time Queries — Design Document Revision Summary

**Date:** 2026-04-06  
**Revision:** 0.1 → 1.0  
**Status:** Complete and Ready for Implementation

---

## Changes Made

### 1. Executive Summary (NEW)
- Added clear, concise overview at the top
- Highlighted core insight: discretized time boundaries enable caching/reactivity
- Listed 4-phase scope
- Version bumped to 1.0 (Approved)

### 2. Hook Implementation (`useTimeBucket`)

#### Enhanced with React Best Practices
- **Added `useRef` for timeout cleanup** — Guarantees cleanup of pending timeouts
- **Lazy initialization** — `useState(() => computeBucket())` avoids per-render computation
- **Corrected effect dependencies** — Changed from `[strategy, bucket, computeBucket]` to `[strategy, computeBucket]` to prevent infinite loops
- **Added detailed performance rationale** — Explains memoization strategy and why `computeBucket` (not `bucket`) is in dependencies

#### Added `visibilitychange` Listener
- Prevents stale dashboards after laptop sleep/tab backgrounding
- Forces bucket recomputation when tab becomes visible
- Zero cost when tab is in focus
- Improves UX by ensuring data is current on wake

#### Expanded Design Decision Documentation
- Added rationale table comparing alternatives
- Explained local-time vs UTC choice with concrete examples
- Justified setTimeout + scheduling pattern over polling

### 3. Composition Patterns & Architecture

#### New Section 4.3: Hook Extraction & Composition Patterns
- Clarified why `useTimeBucket` should remain a standalone hook
- Rejected compound hook idea (`useTimeBucketQuery`)
- **Decision:** Keep separation of concerns:
  - `useTimeBucket` = timing primitive (returns value)
  - `useQuery` = async data management (handles reactivity/caching)
- Cited `vercel-composition-patterns` rule against over-abstraction

### 4. Implementation Architecture (Section 9)

#### New Subsection 9.2: Convex Function Guidelines
- Added mapping of `convex/_generated/ai/guidelines.md` rules to this design
- Covered: validation, auth enforcement, index usage, async patterns
- Ensures implementation follows Convex best practices

#### New Subsection 9.3: Next.js / Convex Integration
- Referenced `.docs/convex/nextjs.md` patterns
- Clarified Client Components requirement for `useQuery` subscriptions
- Documented RSC preloading considerations (deferred)

### 5. Testing Strategy (NEW SECTION 13)

#### Comprehensive Test Plan
- **Unit tests for `useTimeBucket`**
  - Day bucket computation and stability
  - 5-minute bucket math and transitions
  - Timezone handling (local time)
  - Visibility change event handling
  - DST edge cases

- **Integration tests for Convex queries**
  - `getAdminDashboardStats` with asOf argument
  - `getNextMeeting` with asOf argument
  - Authorization enforcement
  - Index utilization

- **Component integration tests**
  - Reactive updates in dashboard components
  - Bucket boundary transitions
  - Loading states during transitions

#### Test File Locations
- `hooks/__tests__/use-time-bucket.test.ts`
- `convex/dashboard/__tests__/adminStats.test.ts`
- `app/workspace/__tests__/dashboard-page-client.test.tsx`

### 6. Open Questions Reorganization (Section 14)

#### Added Resolution Column
- All 8 open questions now include:
  - **Current Thinking** — Design rationale
  - **Resolution** — Clear decision made
- Examples:
  - Q1: visibilitychange listener → **Yes, include in Phase 1**
  - Q2: Admin RSC preloading → **Defer, do not preload**
  - Q5: Remove getStartAndEndOfToday → **Yes, delete during Phase 2**

#### Increased Scope of Decisions
- No longer "open" — all questions have clear answers
- Reduces ambiguity for implementer

### 7. Implementation Checklist (NEW SECTION 17)

#### Detailed Per-Phase Checklist
- **Phase 1:** `useTimeBucket` hook
  - Implementation tasks (useMemo, useRef, dependencies)
  - Testing requirements
  - Code review with `vercel-react-best-practices` skill

- **Phase 2:** Admin Dashboard
  - Convex backend changes (arguments, indexes)
  - Client component updates
  - Testing procedures
  - Performance audit requirements

- **Phase 3:** Closer Dashboard
  - Query updates (5-minute bucket)
  - Component changes
  - Testing with realistic meeting data

- **Phase 4:** Cleanup
  - Grep for remaining usePollingQuery references
  - File deletion
  - Final build verification

### 8. Success Criteria (NEW SECTION 18)

#### Clear Exit Criteria for Each Phase
- What "complete" means for each phase
- Overall success metrics:
  - Zero polling requests in network tab
  - Real-time reactivity verified
  - Convex call volume reduction (~1,440 calls/day/user eliminated)
  - No regressions

---

## Key Improvements to Design

| Area | Before | After |
|------|--------|-------|
| **React Performance** | Basic hook design | Detailed rationale with dependency analysis |
| **Composition** | No mention | Explicit decision to avoid over-abstraction |
| **Testing** | Not covered | Comprehensive test plan with file locations |
| **Convex Integration** | General references | Specific links to `convex/_generated/ai/guidelines.md` |
| **Open Questions** | Unresolved | All questions have clear resolutions |
| **Implementation Path** | Vague phases | Detailed per-phase checklist with success criteria |
| **Skills Guidance** | Section 15 only | Now includes full methodology for when/how to invoke skills |

---

## Skills Applied During Revision

| Skill | Applied To | Outcome |
|---|---|---|
| **vercel-react-best-practices** | `useTimeBucket` hook design | Corrected effect dependencies, added lazy init, explained memoization |
| **vercel-composition-patterns** | Hook composition strategy | Decision to keep `useTimeBucket` separate from `useQuery` |
| **convex-guidelines** | Query architecture | Mapped specific guidelines to implementation (validation, auth, indexes) |

---

## Verification Checklist

- [x] Document follows AGENTS.md structure and CLAUDE.md guidelines
- [x] All Next.js references reviewed (App Router, Client Components, `useQuery`)
- [x] Convex guidelines integrated (`convex/_generated/ai/guidelines.md`)
- [x] React best practices applied (dependencies, memoization, cleanup)
- [x] Composition patterns considered (no over-abstraction)
- [x] Testing strategy is comprehensive and testable
- [x] Implementation path is clear and actionable
- [x] Success criteria are measurable
- [x] All code examples follow TypeScript + Convex patterns
- [x] Security considerations reviewed (no new attack vectors)
- [x] Edge cases documented (DST, sleep, clock skew, visibility)

---

## Next Steps

1. **Phase 1 Implementation**
   - Create `hooks/use-time-bucket.ts` with full implementation
   - Run `vercel-react-best-practices` skill for code review
   - Write tests in `hooks/__tests__/use-time-bucket.test.ts`
   - Verify `pnpm build` passes

2. **Phase 2 Implementation**
   - Update `convex/dashboard/adminStats.ts` query
   - Update `app/workspace/_components/dashboard-page-client.tsx`
   - Run `convex-performance-audit` skill
   - Test real-time updates locally

3. **Phase 3 Implementation**
   - Update `convex/closer/dashboard.ts` query
   - Update closer dashboard component
   - Test 5-minute bucket transitions

4. **Phase 4 Cleanup**
   - Delete `hooks/use-polling-query.ts`
   - Verify no remaining references
   - Run full test suite

---

## Document Statistics

- **New sections added:** 5 (Executive Summary, Testing Strategy, Implementation Checklist, Success Criteria, Composition Patterns subsection)
- **Sections enhanced:** 4 (Hook design, Architecture, Open Questions, Skills)
- **Decision clarity:** 8 open questions → 8 resolved decisions
- **Test cases added:** 15+ specific test scenarios
- **Checklist items:** 40+ implementation tasks
- **Code examples:** 10 maintained, 2 new (revised hook with useRef + visibilitychange)

---

