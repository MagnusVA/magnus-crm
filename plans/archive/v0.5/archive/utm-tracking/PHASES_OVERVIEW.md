# UTM Tracking & Attribution — Phase Plan Overview

**Design Reference:** `plans/v0.5/utm-tracking/utm-tracking-design.md`
**Version:** 0.1 (MVP)
**Status:** Phase plans complete, ready for implementation

---

## Purpose

This document provides a high-level overview of the four phases that implement UTM tracking in the ptdom-crm pipeline. Each phase is detailed in its own markdown file under `plans/v0.5/utm-tracking/phases/`.

---

## Phase Breakdown

### Phase 1: Schema Widen — Add `utmParams` Fields

**File:** `phases/phase1.md`

**What:** Add optional `utmParams` fields to the `meetings` and `opportunities` tables via a widen-only schema migration.

**Duration:** 0.5–1 day

**Deliverables:**
- `convex/lib/utmParams.ts` — Shared validator and type
- Updated `convex/schema.ts` — Both tables include `utmParams: v.optional(utmParamsValidator)`
- Schema deployed to Convex with zero data migration

**Critical path:** ✓ Yes — Phase 2 depends on this.

---

### Phase 2: Pipeline Extraction — `inviteeCreated`

**File:** `phases/phase2.md`

**What:** Modify the `inviteeCreated` pipeline handler to extract Calendly's `tracking` object and store it as `utmParams` on meetings and opportunities.

**Duration:** 1–2 days

**Deliverables:**
- `extractUtmParams()` helper in `convex/lib/utmParams.ts` — Robust extraction with full edge case handling
- Modified `convex/pipeline/inviteeCreated.ts` — UTM extraction, logging, and field inserts
- `convex/pipeline/debugUtm.ts` — Development-only debug query for verification
- Structured logs with `[Pipeline:invitee.created]` tag
- Manual test: Verify UTMs are extracted and stored correctly via Calendly bookings

**Critical path:** ✓ Yes — Phase 3 and Phase 4 depend on this.

---

### Phase 3: Pipeline Logging — `inviteeCanceled` & `inviteeNoShow`

**File:** `phases/phase3.md`

**What:** Add debug logging to cancel and no-show handlers to verify tracking data presence on all invitee-level webhooks (no data changes).

**Duration:** 0.5 day

**Deliverables:**
- Modified `convex/pipeline/inviteeCanceled.ts` — Tracking presence log
- Modified `convex/pipeline/inviteeNoShow.ts` — Tracking presence log
- Verification: Logs appear in Convex dashboard

**Critical path:** No — independent of Phase 4.

---

### Phase 4: Validation & Edge Case Hardening

**File:** `phases/phase4.md`

**What:** Comprehensive testing and validation of UTM extraction against all payload variants (missing, null, malformed, partial, etc.). Documentation of test results.

**Duration:** 1–2 days (manual testing + documentation)

**Deliverables:**
- Test execution against 10 validation scenarios (from design section 7.2)
- Results report: `PHASE4_RESULTS.md`
- Confirmation that edge case handling is robust

**Critical path:** No — independent verification phase.

---

## Execution Order

### Recommended Sequence

```
Phase 1 ──→ Phase 2 ──→ ┬─→ Phase 3
                        │
                        └─→ Phase 4
```

**Critical path:** Phase 1 → Phase 2 (sequential — Phase 2 depends on schema)

**Parallelizable:** Phase 3 and Phase 4 can execute in parallel after Phase 2 is complete.

### Estimated Total Duration

- Phase 1: 0.5–1 day
- Phase 2: 1–2 days
- Phase 3: 0.5 day (can run in parallel with Phase 4 after Phase 2)
- Phase 4: 1–2 days (can run in parallel with Phase 3 after Phase 2)

**Total elapsed time:** 3–5 days (with parallelization of Phases 3 & 4)

---

## Cross-Phase Dependencies

| Phase | Depends on | Blocks |
|---|---|---|
| **Phase 1** | None | Phase 2 |
| **Phase 2** | Phase 1 | Phase 3, Phase 4, Phase 3 |
| **Phase 3** | Phase 2 | Nothing |
| **Phase 4** | Phase 2 | Nothing |

---

## Implementation Checklist

Use this checklist to track progress through all four phases:

### Phase 1
- [ ] `convex/lib/utmParams.ts` created with validator and type
- [ ] `convex/schema.ts` updated: `meetings` table includes `utmParams`
- [ ] `convex/schema.ts` updated: `opportunities` table includes `utmParams`
- [ ] Schema deployed with `npx convex dev` or `npx convex deploy`
- [ ] Existing documents verified unchanged in Convex dashboard
- [ ] `pnpm tsc --noEmit` passes

### Phase 2
- [ ] `extractUtmParams()` helper implemented in `convex/lib/utmParams.ts`
- [ ] `convex/pipeline/inviteeCreated.ts` imports the helper
- [ ] UTM extraction logic added to `inviteeCreated.process` handler
- [ ] Structured logs added with `[Pipeline:invitee.created]` tag
- [ ] Meeting insert includes `utmParams` field
- [ ] New opportunity insert includes `utmParams` field
- [ ] Follow-up opportunity patch intentionally omits `utmParams` (with comment)
- [ ] `convex/pipeline/debugUtm.ts` created (development-only debug query)
- [ ] Deployed to Convex
- [ ] TypeScript compilation passes
- [ ] Manual test: Triggered Calendly booking with UTMs, verified document
- [ ] `pnpm tsc --noEmit` passes

### Phase 3
- [ ] `convex/pipeline/inviteeCanceled.ts` includes tracking presence log
- [ ] `convex/pipeline/inviteeNoShow.ts` includes tracking presence log
- [ ] Deployed to Convex
- [ ] Cancel/no-show events triggered, logs verified
- [ ] `pnpm tsc --noEmit` passes

### Phase 4
- [ ] All 10 validation scenarios tested (standard UTMs, full UTMs, no UTMs, partial, extras, empty string, non-string, null, array, non-object)
- [ ] Edge case handling verified (no crashes, correct document state, correct logs)
- [ ] Results documented in `PHASE4_RESULTS.md`
- [ ] All scenarios passed

---

## Files Modified & Created (Summary)

| File | Action | Phase |
|---|---|---|
| `convex/lib/utmParams.ts` | Create | 1, 2 |
| `convex/schema.ts` | Modify | 1 |
| `convex/pipeline/inviteeCreated.ts` | Modify | 2 |
| `convex/pipeline/debugUtm.ts` | Create | 2 |
| `convex/pipeline/inviteeCanceled.ts` | Modify | 3 |
| `convex/pipeline/inviteeNoShow.ts` | Modify | 3 |
| `plans/v0.5/utm-tracking/PHASE4_RESULTS.md` | Create | 4 |

---

## Rollback & Safety

### Phase 1 Rollback
- Widen-only schema change. To rollback: Remove the `utmParams` lines from both table definitions and redeploy. Existing documents remain unchanged. No data loss.

### Phase 2 Rollback
- Remove the import, extraction call, and field inserts from `inviteeCreated.ts`. Redeploy. New meetings/opportunities created after rollback will not have UTMs. Existing documents with UTMs remain intact.

### Phase 3 Rollback
- Remove the logging statements from cancel/no-show handlers. Redeploy. No data impact.

### Phase 4 Rollback
- No code changes in Phase 4 — rollback N/A.

---

## Notes for Implementation

1. **No external dependencies required.** This feature uses only built-in JavaScript and existing Convex APIs.

2. **Minimal performance impact.** UTM extraction is a pure in-memory operation adding <1ms to pipeline processing.

3. **Multi-tenant isolation maintained.** UTM data inherits the tenant isolation of the meeting/opportunity documents it's stored on. No cross-tenant leakage.

4. **Future-proofing.** If Calendly adds new tracking fields, the extraction logic can be extended without breaking existing code. If new UTM-like fields are needed, they can be added as optional fields to the validator.

5. **Phase 3+ dependencies.** Phase 3 (Meeting Detail Enhancements) will add a UI card to display UTMs. The data foundation from Phases 1–2 enables that.

---

## Next Steps After Completion

Once all four phases are complete, the UTM data will be fully integrated into the pipeline. The next feature areas that depend on UTM data are:

- **Phase 3 (v0.5):** Meeting Detail Enhancements — Display UTM attribution on the meeting detail page.
- **Phase 4 (v0.5):** Follow-Up & Rescheduling Overhaul — Use CRM-generated UTMs (`utm_source=ptdom`, `utm_campaign={opportunityId}`) to deterministically link follow-up bookings.
- **Phase 5 (v0.5):** No-Show Management — Use UTM absence heuristics to auto-detect reschedules.

This UTM foundation enables all downstream attribution and deterministic opportunity linking.

