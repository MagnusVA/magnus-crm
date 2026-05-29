# Phase 3 — Verification and Rollout

**Goal:** Verify the redesigned overview dashboard end to end across auth, range semantics, section caps, Convex performance, and responsive UI behavior. After this phase, the team has a recorded rollout decision, known residual risks, and a backout path.

**Prerequisite:** Phase 1 and Phase 2 are complete, `api.dashboard.overview.getOverviewDashboard` is generated, `/workspace` renders the redesigned UI locally, and no schema migration was introduced during MVP implementation.

**Runs in PARALLEL with:** Nothing at phase level. Inside this phase, static validation, manual role QA, Convex performance inspection, and browser viewport QA can be split across agents after the app builds.

**Skills to invoke:**
- `convex-performance-audit` — inspect bounded reads, reactive subscription cost, caps, logs, and potential need to split the composed query.
- `browser:browser` — verify `/workspace` in desktop and mobile viewports with real interactions.
- `next-best-practices` — confirm the RSC page stays thin and instant-navigation/streaming structure has not regressed.
- `frontend-design` — evaluate final visual polish, density, hierarchy, and responsive fit.
- `convex-migration-helper` — only if verification proves a new rollup table, index, or backfill is required.

**Acceptance Criteria:**
1. `tenant_master` and `tenant_admin` users can open `/workspace` and see the redesigned overview dashboard.
2. `closer` users opening `/workspace` are redirected to `/workspace/closer`.
3. `lead_generator` users opening `/workspace` are redirected to `/workspace/lead-gen/capture`.
4. Day, Week, Month, and valid Custom ranges produce expected labels and do not create invalid Convex query subscriptions.
5. Lead Gen and Slack use Honduras 1am-to-1am business-date windows; operations sections are documented and verified as UTC `dayKey` rollups.
6. Lead Gen cap, Top Origins cap, Slack truncation, Operations cap, empty DM attribution, and removed entity fallback states are each verified or explicitly marked untestable with a reason.
7. Convex dashboard/log/insights review shows no unbounded dashboard reads, no transaction-size errors, and no unexpected auth errors from the new query.
8. Browser QA at about 1440x1000 and 390x844 shows no page-level horizontal overflow, incoherent overlaps, unusable Custom popover, or clipped primary controls.
9. `pnpm lint`, `pnpm build`, and `npx convex logs --history 100` have been run and findings are recorded.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (static validation) ────────────┬── 3B (role + range functional QA)
                                  ├── 3C (Convex performance + cap audit)
                                  └── 3D (browser responsive QA)

3B + 3C + 3D complete ─────────────── 3E (rollout decision + backout notes)
```

**Optimal execution:**
1. Run 3A first. If TypeScript, lint, build, or generated API checks fail, fix those before spending time on manual QA.
2. Run 3B, 3C, and 3D in parallel after the build is green.
3. Finish with 3E so rollout notes reflect actual functional, performance, and browser results.

**Estimated time:** 1-2 days

---

## Subphases

### 3A — Static Validation and Contract Guard

**Type:** Manual / Backend / Frontend
**Parallelizable:** No — this gate establishes whether the integrated feature is coherent enough for role, performance, and browser QA.

**What:** Run typecheck, lint, build, Convex codegen, and targeted source searches for forbidden dashboard patterns.

**Why:** The redesigned dashboard depends on generated Convex references, one client subscription, no schema changes, and bounded indexed reads. Static checks catch most integration mistakes quickly.

**Where:**
- `plans/overview-dashboard-redesign/phases/phase3-verification-log.md` (new during verification)
- `convex/dashboard/**` (verify)
- `app/workspace/_components/**` (verify)
- `app/workspace/page.tsx` (verify)

**How:**

**Step 1: Create the verification log.**

```markdown
// Path: plans/overview-dashboard-redesign/phases/phase3-verification-log.md
# Overview Dashboard Redesign — Phase 3 Verification Log

**Verifier:** Fill during verification.
**Date:** Fill during verification.
**Branch:** Fill during verification.
**Commit:** Fill during verification.

## Static Validation

| Check | Result | Notes |
|---|---|---|
| `npx convex dev --once` | Pending | |
| `pnpm tsc --noEmit` | Pending | |
| `pnpm lint` | Pending | |
| `pnpm build` | Pending | |
```

**Step 2: Run required commands.**

```bash
# Path: terminal
npx convex dev --once
pnpm tsc --noEmit
pnpm lint
pnpm build
```

**Step 3: Search for forbidden or risky patterns.**

```bash
# Path: terminal
rg -n "ctx\\.runQuery|\\.collect\\(|\\.filter\\(\\(?q" convex/dashboard convex/leadGen convex/slack
rg -n "getCurrentUser|getAdminDashboardStats|getTimePeriodStats|SlackMetricsSection|StatsRow|PipelineSummary|SystemHealth" app/workspace/_components/dashboard-page-client.tsx
rg -n "tenantId: v\\.id\\(\"tenants\"\\)|userId: v\\.id\\(\"users\"\\)|role: v\\.string" convex/dashboard
rg -n "defineTable|\\.index\\(" convex/dashboard convex/schema.ts
```

**Step 4: Record the static results.**

```markdown
// Path: plans/overview-dashboard-redesign/phases/phase3-verification-log.md
## Static Validation

| Check | Result | Notes |
|---|---|---|
| `npx convex dev --once` | Pass | Generated `api.dashboard.overview.getOverviewDashboard`. |
| `pnpm tsc --noEmit` | Pass | |
| `pnpm lint` | Pass | |
| `pnpm build` | Pass | |
| Forbidden pattern search | Pass | No dashboard `ctx.runQuery`, `.collect()`, or client-supplied tenant args found. |
```

**Key implementation notes:**
- If `convex/schema.ts` changed during implementation, stop and review whether the change is truly required. Significant schema/data changes require `convex-migration-helper`.
- `rg` findings are not automatically failures. Some `.filter()` calls in ordinary TypeScript arrays are fine; database `.filter((q) => ...)` in new hot reads is not.
- Do not proceed to rollout decision while `pnpm build` is failing.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/overview-dashboard-redesign/phases/phase3-verification-log.md` | Create | Static validation record |

---

### 3B — Role, Range, and Section Functional QA

**Type:** Manual / Full-Stack
**Parallelizable:** Yes — can run after 3A while another stream audits performance and another checks browser layout.

**What:** Verify role routing, Day/Week/Month/Custom behavior, section states, empty states, and fallback labels with a tenant owner/admin session.

**Why:** The dashboard's correctness is mostly in boundaries: who can read it, which time window each section uses, and how partial/capped sections degrade.

**Where:**
- `plans/overview-dashboard-redesign/phases/phase3-verification-log.md` (modify)
- `app/workspace/page.tsx` (verify)
- `convex/dashboard/overviewRange.ts` (verify)
- `convex/dashboard/overviewBuilders.ts` (verify)

**How:**

**Step 1: Add the functional QA matrix to the log.**

```markdown
// Path: plans/overview-dashboard-redesign/phases/phase3-verification-log.md
## Functional QA

| Scenario | Expected | Result | Notes |
|---|---|---|---|
| Tenant owner opens `/workspace` | Overview renders | Pending | |
| Tenant admin opens `/workspace` | Overview renders | Pending | |
| Closer opens `/workspace` | Redirects to `/workspace/closer` | Pending | |
| Lead generator opens `/workspace` | Redirects to `/workspace/lead-gen/capture` | Pending | |
| Day range | Current Honduras business date | Pending | |
| Week range | Current business ISO week to date | Pending | |
| Month range | Current business month to date | Pending | |
| Valid Custom range | Inclusive selected dates | Pending | |
| Invalid Custom range | Query skipped; old data remains | Pending | |
| No DM attribution rows | Empty DM closer state | Pending | |
```

**Step 2: Verify route-level roles.**

```text
// Path: manual QA
1. Sign in as tenant owner and open `/workspace`.
2. Sign in as tenant admin and open `/workspace`.
3. Sign in as closer and open `/workspace`.
4. Sign in as lead generator and open `/workspace`.
5. Record final URL and visible page for each role.
```

**Step 3: Verify range semantics through the UI and Convex logs.**

```text
// Path: manual QA
1. Select Day and confirm the label matches the current Honduras business date.
2. Select Week and confirm it starts on the current business ISO Monday.
3. Select Month and confirm it starts on day 01 of the current business month.
4. Select a valid Custom range and confirm the displayed label is `YYYY-MM-DD to YYYY-MM-DD`.
5. Select an incomplete or reversed Custom range and confirm the previous dashboard remains visible.
6. Confirm operations copy and verification notes say UTC day-key rollups, not exact Honduras 1am parity.
```

**Step 4: Verify section state behavior.**

```markdown
// Path: plans/overview-dashboard-redesign/phases/phase3-verification-log.md
## Section State QA

| State | How Tested | Result | Notes |
|---|---|---|---|
| Lead Gen capped | Record range or seed used | Pending | |
| Top Origins capped | Record range or seed used | Pending | |
| Slack truncated | Record range or seed used | Pending | |
| Operations capped | Record range or seed used | Pending | |
| Empty Top DM Closers | Record range or seed used | Pending | |
| Removed phone closer fallback | Record range or seed used | Pending | |
```

**Key implementation notes:**
- It is acceptable to mark a cap path "Not reproducible with current test tenant data" if the exact cap cannot be triggered safely. Record the reason and verify the source code path instead.
- Do not seed production tenant data purely to force caps. Use dev or a safe preview deployment for artificial cap tests.
- If role redirects fail, fix `app/workspace/page.tsx` or auth routing before investigating UI components.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/overview-dashboard-redesign/phases/phase3-verification-log.md` | Modify | Functional QA matrix and results |

---

### 3C — Convex Performance and Cap Audit

**Type:** Backend / Manual
**Parallelizable:** Yes — can run after 3A while role and browser QA proceed.

**What:** Inspect dashboard read paths, logs, and available Convex insights for read amplification, transaction pressure, high subscription cost, and cap frequency.

**Why:** The design starts with one composed public query for simplicity and one subscription. This phase decides whether that remains safe or whether section queries are needed without changing DTO shapes.

**Where:**
- `plans/overview-dashboard-redesign/phases/phase3-verification-log.md` (modify)
- `convex/dashboard/**` (verify or modify if defects are found)
- `convex/leadGen/**` (verify or modify if helper extraction regressed existing reports)
- `convex/slack/**` (verify or modify if helper extraction regressed existing reports)

**How:**

**Step 1: Run log and insights commands.**

```bash
# Path: terminal
npx convex logs --history 100
npx convex insights --details
```

If the local CLI does not support insights:

```bash
# Path: terminal
npx -y convex@latest insights --details
```

**Step 2: Record signals.**

```markdown
// Path: plans/overview-dashboard-redesign/phases/phase3-verification-log.md
## Convex Performance Audit

| Signal | Result | Notes |
|---|---|---|
| New overview auth errors | Pending | |
| Query transaction/read errors | Pending | |
| High bytes/documents read | Pending | |
| High active subscriptions from `/workspace` | Pending | |
| Section cap frequency | Pending | |
| Need to split query by section | Pending | |
```

**Step 3: Verify expected bounded read patterns in code.**

```bash
# Path: terminal
rg -n "take\\(.*\\+ 1\\)|take\\(5\\)|take\\(10\\)|withIndex" convex/dashboard convex/reporting/lib/slackQualificationLedger.ts convex/leadGen/reportReaders.ts
rg -n "operationsMeetingDailyStats|leadGenDailyStats|leadGenOriginStats|slackQualificationEvents" convex/dashboard
```

**Step 4: Apply decision rules.**

```text
// Path: rollout decision notes
Keep one composed query if:
- No query transaction/read-size errors appear.
- Month and representative Custom ranges do not cap unexpectedly.
- UI benefits from one subscription and payload remains small.

Split into section queries if:
- The composed query approaches transaction/read budget.
- One section's read set invalidates too frequently for the whole dashboard.
- A section is slow enough that independent loading improves usability.

Escalate to migration planning if:
- Top DM Closers or operations tables commonly cap on normal Month ranges.
- A new daily DM closer rollup table is required.
- New indexes or backfills become necessary for correctness.
```

**Key implementation notes:**
- Splitting section queries should preserve the exact `SectionResult` shape so Phase 2 UI needs minimal changes.
- Do not add a dashboard snapshot table as a late Phase 3 optimization. That is outside MVP and likely migration-heavy.
- Treat absence of insights as "not observed", not proof of health. Code audit still matters.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/overview-dashboard-redesign/phases/phase3-verification-log.md` | Modify | Performance audit signals and query-split decision |
| `convex/dashboard/**` | Modify if needed | Only for confirmed performance or correctness defects |

---

### 3D — Browser Responsive and Interaction Verification

**Type:** Frontend / Manual
**Parallelizable:** Yes — can run after 3A while Convex audit and role QA proceed.

**What:** Use Browser to verify the final dashboard at desktop and mobile sizes, including range controls, section states, table overflow, links, focus, and loading skeletons.

**Why:** The design goal is a compact operational dashboard. Responsive fit and interaction details are part of acceptance, not cosmetic cleanup.

**Where:**
- `plans/overview-dashboard-redesign/phases/phase3-verification-log.md` (modify)
- `app/workspace/_components/**` (modify if browser QA finds UI defects)

**How:**

**Step 1: Start the app.**

```bash
# Path: terminal
pnpm dev
```

Use another port only if 3000 is already occupied.

**Step 2: Open Browser and verify desktop.**

```text
// Path: Browser
URL: http://localhost:3000/workspace
Viewport: about 1440x1000

Checks:
1. Header, label, and range control fit on one row when space allows.
2. Three top cards are equal-width and scannable.
3. Phone Operations and Top Origins tables use internal overflow only.
4. No dashboard text overlaps other content.
5. Skeleton dimensions are close to final layout.
```

**Step 3: Verify mobile.**

```text
// Path: Browser
URL: http://localhost:3000/workspace
Viewport: about 390x844

Checks:
1. Top cards stack cleanly.
2. Range controls wrap without clipped labels.
3. Custom popover can be opened, used, and dismissed.
4. Table wrappers scroll horizontally without making the full page wider.
5. Focus rings are visible when tabbing through controls and links.
```

**Step 4: Record browser findings.**

```markdown
// Path: plans/overview-dashboard-redesign/phases/phase3-verification-log.md
## Browser QA

| Viewport | Result | Notes |
|---|---|---|
| Desktop 1440x1000 | Pending | |
| Mobile 390x844 | Pending | |
| Keyboard range control | Pending | |
| Custom popover | Pending | |
| Table overflow | Pending | |
| Loading skeleton | Pending | |
```

**Key implementation notes:**
- Do not fix browser issues by shrinking all text. Use layout changes, wrapping, `min-w-0`, `truncate`, and stable table widths.
- If a state message makes a card much taller than siblings, keep it readable and accept height variation rather than hiding the message.
- If a visual issue requires broader design changes, update Phase 2 components and rerun 3A before rollout.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/overview-dashboard-redesign/phases/phase3-verification-log.md` | Modify | Browser QA results |
| `app/workspace/_components/**` | Modify if needed | Responsive or interaction fixes from Browser QA |

---

### 3E — Rollout Decision, Backout Notes, and Follow-Up Triage

**Type:** Manual / Release
**Parallelizable:** No — depends on 3B, 3C, and 3D findings.

**What:** Summarize verification results, decide whether to ship, document a backout path, and create explicit follow-up items for non-MVP performance or migration work.

**Why:** This app has a production tenant. A dashboard redesign is reversible at the UI/query layer, but follow-up schema or rollup work must not slip into rollout without migration planning.

**Where:**
- `plans/overview-dashboard-redesign/phases/phase3-verification-log.md` (modify)
- `plans/overview-dashboard-redesign/phases/phase3-rollout-notes.md` (new)

**How:**

**Step 1: Create rollout notes.**

```markdown
// Path: plans/overview-dashboard-redesign/phases/phase3-rollout-notes.md
# Overview Dashboard Redesign — Rollout Notes

**Decision:** Pending
**Date:** Fill during rollout.
**Branch/Commit:** Fill during rollout.

## Ship Criteria

| Criterion | Status | Notes |
|---|---|---|
| Static validation green | Pending | |
| Role/range QA complete | Pending | |
| Convex logs/insights acceptable | Pending | |
| Browser desktop/mobile acceptable | Pending | |
| No schema/data migration introduced | Pending | |

## Backout Path

1. Revert the `/workspace` dashboard client changes.
2. Leave Phase 1 helper extraction only if existing lead-gen and Slack report parity is verified.
3. If helper extraction is suspect, revert the Phase 1 backend changes as a single PR.
4. Confirm `/workspace` returns to the previous dashboard and `pnpm tsc --noEmit` passes.

## Follow-Ups

| Follow-up | Trigger | Owner | Migration Required |
|---|---|---|---|
| Split overview into section queries | Composed query too heavy | Assign during rollout | No |
| Daily DM closer rollup | Normal Month ranges hit operations cap | Assign during rollout | Yes |
| Exact Honduras operations rollups | Product requires 1am parity | Assign during rollout | Yes |
```

**Step 2: Make the release decision.**

```text
// Path: release decision
Ship if:
- Phase 3 acceptance criteria are pass or documented non-blockers.
- No schema/data change was added without migration planning.
- The production test tenant's normal Day/Week/Month dashboard ranges do not fail.

Hold if:
- Auth leakage or role routing is wrong.
- The overview query fails on normal tenant data.
- Mobile or desktop layout has primary control overlap.
- Typecheck, lint, or build fails.
```

**Step 3: Record follow-up migration triggers.**

```markdown
// Path: plans/overview-dashboard-redesign/phases/phase3-rollout-notes.md
## Migration Escalation Triggers

- Add `dmCloserDailyStats` only if normal Month or Custom ranges frequently cap operations-backed sections.
- Add or change indexes only after confirming the existing tenant/day indexes cannot support the MVP read pattern.
- Migrate operations rollups to Honduras business-day boundaries only if product explicitly accepts the changed semantics and rollout plan.
```

**Key implementation notes:**
- Backout should prefer reverting the UI first if the issue is presentation-only.
- If the issue is helper extraction that affects existing lead-gen or Slack reports, treat it as broader than the dashboard redesign.
- Do not mark the phase complete with "ship later" ambiguity. The output is either ship, hold with blockers, or ship with documented non-blocking follow-ups.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/overview-dashboard-redesign/phases/phase3-verification-log.md` | Modify | Final verification summary |
| `plans/overview-dashboard-redesign/phases/phase3-rollout-notes.md` | Create | Ship/hold decision, backout, and follow-up triggers |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `plans/overview-dashboard-redesign/phases/phase3-verification-log.md` | Create / Modify | 3A, 3B, 3C, 3D, 3E |
| `plans/overview-dashboard-redesign/phases/phase3-rollout-notes.md` | Create | 3E |
| `convex/dashboard/**` | Modify if needed | 3A, 3C |
| `convex/leadGen/**` | Modify if needed | 3A, 3C |
| `convex/slack/**` | Modify if needed | 3A, 3C |
| `app/workspace/_components/**` | Modify if needed | 3D |
| `app/workspace/page.tsx` | Verify | 3B |
