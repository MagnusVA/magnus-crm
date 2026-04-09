# Phase 4 — Validation & Edge Case Hardening

**Goal:** Systematically verify that UTM extraction is robust against all payload variants Calendly might send, that follow-up rebooking preserves original attribution, and that the debug tooling from Phase 2 works as expected. Conclude with cleanup of development-only artifacts. No new production code is deployed — all validation logic is built into the `extractUtmParams` helper from Phase 2.

**Prerequisite:** Phase 2 complete — the extraction helper, modified `inviteeCreated.ts`, and `debugUtm.ts` must be deployed. Phase 3 is recommended but not required (its logs aid debugging but are not needed for validation).

**Runs in PARALLEL with:** Phase 3 (logging on cancel/no-show handlers). Both are independent backend enhancements.

**Skills to invoke:**
- `convex-performance-audit` — Post-verification, run `npx convex insights` to confirm UTM extraction hasn't regressed pipeline function durations.
- `simplify` — Final review of all UTM-related code after validation is complete.

**Acceptance Criteria:**
1. All 10 input validation scenarios from the matrix below are tested — each passing with correct `utmParams` on the resulting document.
2. The debug query `pipeline.debugUtm.recentMeetingUtms` returns correct UTM data for recently created meetings.
3. Follow-up rebooking test confirms the opportunity's `utmParams` is preserved (not overwritten by the new meeting's UTMs).
4. Manual tests confirm the extraction helper handles missing, null, malformed, and partial tracking data without crashing the pipeline.
5. Pipeline function durations have not regressed (verified via `npx convex insights` or Convex dashboard metrics).
6. `convex/pipeline/debugUtm.ts` is deleted (or marked for exclusion) after all verification is complete — it is not part of the production API.

---

## Subphase Dependency Graph

```
4A (Input matrix verification) ─────────────────────┐
                                                     ├── 4D (Document results + cleanup)
4B (Follow-up attribution preservation test) ────────┤
                                                     │
4C (Debug query verification + performance check) ───┘
```

**Optimal execution:**
1. Start 4A, 4B, and 4C in parallel (all are independent manual tests).
2. Once all three are done → complete 4D (document results, delete debug query, final review).

**Estimated time:** 1–1.5 days (comprehensive manual testing + documentation + cleanup).

---

## Subphases

### 4A — Input Validation Matrix Verification

**Type:** Manual / Testing
**Parallelizable:** Yes — independent of 4B and 4C.

**What:** Systematically test each row from the UTM input validation matrix (design doc section 7.2) against the deployed pipeline. Verify that the `extractUtmParams` helper handles all 10 scenarios correctly — producing the right `utmParams` value on the resulting meeting document.

**Why:** The `extractUtmParams` helper was written to handle every known Calendly tracking payload variant. Testing against the full matrix ensures no scenario was missed. A single unhandled edge case could crash the pipeline for all tenants on a specific webhook delivery.

**Where:**
- Calendly platform (for real booking tests)
- Convex dashboard (for data inspection + synthetic payload injection)
- Convex function logs (for extraction outcome verification)

**How:**

**Step 1: Test real bookings via Calendly URLs (scenarios 1–5)**

| # | Scenario | Test URL | Expected `utmParams` on Meeting |
|---|---|---|---|
| 1 | Standard with UTMs | `https://calendly.com/{event}?utm_source=facebook&utm_medium=ad&utm_campaign=spring` | `{ utm_source: "facebook", utm_medium: "ad", utm_campaign: "spring" }` |
| 2 | Full UTMs (all 5) | `https://calendly.com/{event}?utm_source=ptdom&utm_medium=follow_up&utm_campaign=k57abc&utm_term=k57closer&utm_content=k57xyz` | All 5 fields populated |
| 3 | No UTMs | `https://calendly.com/{event}` (no query string) | `undefined` (field absent) |
| 4 | Partial (source only) | `https://calendly.com/{event}?utm_source=facebook` | `{ utm_source: "facebook" }` |
| 5 | Extra params | `https://calendly.com/{event}?utm_source=fb&unrelated_param=value` | `{ utm_source: "fb" }` |

For each test:
1. Complete the booking through Calendly.
2. Open Convex dashboard → **Data** → **meetings** table → find the new meeting.
3. Verify the `utmParams` field matches the expected value.
4. Check logs for `[Pipeline:invitee.created] UTM extraction | hasUtm=...`.

**Step 2: Test synthetic payloads via Convex dashboard (scenarios 6–10)**

For edge cases that can't be triggered via URL, inject test payloads directly into the pipeline. Use the Convex dashboard **Functions** section to invoke `pipeline.processor.processRawEvent` with a crafted `rawWebhookEvents` record, or use a test webhook tool.

| # | Scenario | `payload.tracking` Value | Expected `utmParams` |
|---|---|---|---|
| 6 | All null fields | `{ "utm_campaign": null, "utm_source": null, "utm_medium": null, "utm_content": null, "utm_term": null }` | `undefined` |
| 7 | Tracking is `null` | `null` | `undefined` |
| 8 | Tracking is array | `["utm_source", "facebook"]` | `undefined` |
| 9 | Empty string field | `{ "utm_source": "", "utm_medium": "ad" }` | `{ utm_medium: "ad" }` |
| 10 | Non-string value | `{ "utm_source": 42, "utm_medium": "ad" }` | `{ utm_medium: "ad" }` |

For each synthetic test:
1. Verify no pipeline error or exception in the function logs.
2. Verify the resulting document has the expected `utmParams` (or absent).
3. Verify the log output matches the expected `hasUtm` boolean.

**Key implementation notes:**
- Real Calendly bookings (scenarios 1–5) are the gold standard — they exercise the full webhook flow from signature verification through pipeline processing.
- Synthetic payloads (scenarios 6–10) test defensive code paths that should never fire with real Calendly data, but protect against API changes.
- If any scenario fails, check `convex/lib/utmParams.ts` → `extractUtmParams()` implementation against the failing case.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Convex dashboard (data & logs) | Inspection only | No code changes |

---

### 4B — Follow-Up Attribution Preservation Test

**Type:** Manual / Testing
**Parallelizable:** Yes — independent of 4A and 4C.

**What:** Verify that when a lead books a follow-up meeting on an existing opportunity, the **opportunity's** `utmParams` is NOT overwritten — only the **new meeting** gets its own `utmParams`. This is the critical attribution preservation guarantee described in design section 5.3.

**Why:** If the follow-up opportunity patch accidentally includes `utmParams`, the original acquisition channel is lost. A lead who arrived via `utm_source=facebook` would incorrectly show as `utm_source=ptdom` (the CRM-generated follow-up UTM) after a rebooking. This test verifies the intentional omission documented in the code comment at `inviteeCreated.ts` ~line 252.

**Where:**
- Calendly platform (for creating initial + follow-up bookings)
- Convex dashboard (for data inspection)

**How:**

**Step 1: Create an initial booking with UTMs**

1. Book via `https://calendly.com/{event}?utm_source=facebook&utm_medium=ad&utm_campaign=initial_test`.
2. Wait for the pipeline to process the webhook.
3. In the Convex dashboard, find the created **opportunity** and note:
   - `opportunityId`: `{id}`
   - `utmParams`: `{ utm_source: "facebook", utm_medium: "ad", utm_campaign: "initial_test" }`

**Step 2: Trigger a follow-up booking on the same opportunity**

1. Transition the opportunity to `follow_up_scheduled` (via the CRM UI or a direct Convex dashboard patch).
2. Book a new meeting via a different URL (with different or no UTMs):
   - Option A: `https://calendly.com/{event}?utm_source=ptdom&utm_medium=follow_up&utm_campaign={opportunityId}`
   - Option B: `https://calendly.com/{event}` (no UTMs at all)
3. Wait for the pipeline to process the new `invitee.created` webhook.

**Step 3: Verify attribution preservation**

1. **Opportunity check:** Re-inspect the same opportunity document. Confirm:
   - `utmParams` is STILL `{ utm_source: "facebook", utm_medium: "ad", utm_campaign: "initial_test" }` — unchanged from step 1.
   - The opportunity was NOT overwritten with the follow-up booking's UTMs.
2. **New meeting check:** Find the new meeting on this opportunity. Confirm:
   - If Option A: `utmParams: { utm_source: "ptdom", utm_medium: "follow_up", utm_campaign: "{opportunityId}" }`
   - If Option B: `utmParams` is absent (undefined).
3. **Log check:** Confirm `[Pipeline:invitee.created] UTM extraction` shows the correct UTMs for the new booking, and no log suggests the opportunity's UTMs were updated.

**Key implementation notes:**
- This is the most business-critical test in Phase 4. If it fails, the design's attribution model is broken.
- The follow-up path is triggered when `inviteeCreated.ts` finds an existing opportunity in `follow_up_scheduled` status (lines 223–243). The patch at ~line 252 must NOT include `utmParams`.
- If the test fails, check `convex/pipeline/inviteeCreated.ts` for an accidental `utmParams,` in the follow-up opportunity patch block.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Convex dashboard (data & logs) | Inspection only | No code changes |

---

### 4C — Debug Query Verification & Performance Check

**Type:** Manual / Testing
**Parallelizable:** Yes — independent of 4A and 4B.

**What:** Verify that the `debugUtm.ts` internal query (created in Phase 2C) works correctly with real data, then check pipeline performance metrics to confirm UTM extraction hasn't introduced latency regression.

**Why:** The debug query was created specifically for this verification phase. Confirming it works ensures developers have a reliable tool for post-deployment spot-checks. The performance check is a safety net — UTM extraction adds ~1ms, but verifying against actual metrics is best practice.

**Where:**
- Convex dashboard (Functions section + Insights/Metrics)

**How:**

**Step 1: Run the debug query**

1. Open the Convex dashboard → **Functions** section.
2. Find `pipeline.debugUtm.recentMeetingUtms`.
3. Invoke it with:
   ```json
   { "tenantId": "{your-test-tenant-id}", "limit": 10 }
   ```
4. **Verify the output** shows a list of recent meetings with:
   - `_id` — Convex document ID
   - `scheduledAt` — ISO timestamp
   - `leadName` — display name
   - `hasUtm` — boolean (should be `true` for UTM-tagged bookings, `false` for others)
   - `utmParams` — the full UTM object or `null`
5. Cross-reference at least 2 meetings against the **Data** table to confirm the debug query output matches the actual documents.

**Step 2: Check pipeline performance**

1. Run `npx convex insights` from the terminal (or check the Convex dashboard **Insights** section).
2. Filter for `pipeline.inviteeCreated.process` function.
3. Compare the average execution duration **before** and **after** the Phase 2 deployment.
4. **Expected:** <1ms increase. If the increase is >5ms, investigate whether the `extractUtmParams` call or the additional log statement is the cause.

**Key implementation notes:**
- The debug query is `internalQuery` — it's not accessible from the frontend, only from the Convex dashboard and internal function calls.
- If the debug query fails with a type error, check that the `meetings` table has the `by_tenantId_and_scheduledAt` index and that `utmParams` is optional in the schema.
- Performance regression is extremely unlikely (pure in-memory object traversal + one log statement), but measuring it provides confidence and a baseline for future phases.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Convex dashboard (Functions & Insights) | Inspection only | No code changes |

---

### 4D — Document Results & Cleanup

**Type:** Documentation / Config
**Parallelizable:** No — must follow 4A, 4B, and 4C completion.

**What:** Summarize test results in a brief report, delete the development-only debug query (`convex/pipeline/debugUtm.ts`), and run a final `simplify` review of all UTM-related code.

**Why:** The debug query was created for Phase 2–4 verification only — it pollutes the production function list if left in place. Documentation creates an audit trail. The simplify review catches any remaining code quality issues before the feature ships.

**Where:**
- `plans/v0.5/utm-tracking/PHASE4_RESULTS.md` (new)
- `convex/pipeline/debugUtm.ts` (delete)

**How:**

**Step 1: Create the results report**

```markdown
// Path: plans/v0.5/utm-tracking/PHASE4_RESULTS.md

# Phase 4 — Validation Results

**Date:** [Completion Date]
**Tester:** [Name]

## Input Matrix Results

| # | Scenario | Status | Notes |
|---|---|---|---|
| 1 | Standard with UTMs | ✓ PASS / ✗ FAIL | [details] |
| 2 | Full UTMs (5 fields) | ✓ PASS / ✗ FAIL | [details] |
| 3 | No UTMs | ✓ PASS / ✗ FAIL | [details] |
| 4 | Partial UTMs | ✓ PASS / ✗ FAIL | [details] |
| 5 | Extra parameters | ✓ PASS / ✗ FAIL | [details] |
| 6 | All null fields | ✓ PASS / ✗ FAIL | [details] |
| 7 | Tracking null | ✓ PASS / ✗ FAIL | [details] |
| 8 | Tracking array | ✓ PASS / ✗ FAIL | [details] |
| 9 | Empty string field | ✓ PASS / ✗ FAIL | [details] |
| 10 | Non-string value | ✓ PASS / ✗ FAIL | [details] |

## Follow-Up Attribution Preservation

| Test | Status | Notes |
|---|---|---|
| Opportunity UTMs unchanged after follow-up rebooking | ✓ PASS / ✗ FAIL | [details] |
| New meeting has its own UTMs (independent of opportunity) | ✓ PASS / ✗ FAIL | [details] |

## Performance

| Metric | Before UTM | After UTM | Delta |
|---|---|---|---|
| `inviteeCreated.process` avg duration | [X]ms | [Y]ms | [+Z]ms |

## Debug Query

- Tested: Yes / No
- Output matches documents: Yes / No
- Deleted after verification: Yes / No

## Blockers / Issues

[None — or describe any failures and corrective actions taken]
```

**Step 2: Delete the debug query**

```bash
rm convex/pipeline/debugUtm.ts
```

Then redeploy to remove the function from the Convex function list:

```bash
npx convex dev
# or for production:
npx convex deploy
```

**Step 3: Run `simplify` review**

Invoke the `simplify` skill to review all files modified across Phases 1–4:
- `convex/lib/utmParams.ts`
- `convex/schema.ts`
- `convex/pipeline/inviteeCreated.ts`
- `convex/pipeline/inviteeCanceled.ts`
- `convex/pipeline/inviteeNoShow.ts`

Focus areas: code reuse, naming consistency, log format consistency, dead code.

**Step 4: Final TypeScript check**

```bash
pnpm tsc --noEmit
```

Should pass without errors after the debug query deletion.

**Key implementation notes:**
- If any tests in 4A–4C failed and required code fixes, those fixes should be committed and redeployed before writing the results report.
- The debug query deletion is intentional — the design (section 12, question #2) recommends not deploying development-only queries to production permanently.
- If the team decides to keep the debug query, gate it behind a clearly named internal-only module or add a `// DEV-ONLY` comment and accept it in the production function list.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/v0.5/utm-tracking/PHASE4_RESULTS.md` | Create | Validation results report |
| `convex/pipeline/debugUtm.ts` | Delete | Development-only query — no longer needed |

---

## Phase Summary

| Artifact | Action | Subphase |
|---|---|---|
| Input validation matrix (10 scenarios) | Test & verify | 4A |
| Follow-up attribution preservation | Test & verify | 4B |
| Debug query (`debugUtm.ts`) output | Test & verify | 4C |
| Pipeline performance metrics | Verify | 4C |
| Validation results report | Create | 4D |
| `convex/pipeline/debugUtm.ts` | Delete | 4D |
| All UTM code (`simplify` review) | Review | 4D |

