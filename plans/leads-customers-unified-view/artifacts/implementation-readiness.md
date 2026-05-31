# Leads & Customers Unified View - Implementation Readiness

**Phase:** 0E - Implementation Readiness Brief  
**Date captured:** 2026-05-31

## Phase Gate

| Gate | Required state | Status | Notes |
|---|---|---|---|
| Current route behavior captured | `artifacts/current-state-inventory.md` complete | Complete | Routes, guards, Convex functions, nav, reuse decisions, and performance evidence captured. |
| Redacted QA IDs available | `artifacts/sample-data-matrix.md` complete or fixture gaps listed | Conditional | Production read-only sample covers active lead, converted customer, Slack-qualified opportunity, comments, direct opportunity, direct meeting, unassigned closer, and multi-meeting cases. Side-deal and merged-lead fixtures are missing. |
| Security rules accepted | `artifacts/security-contract.md` complete | Complete | Includes role matrix, related-record guard rules, PII/logging restrictions, and current raw-search logging gap. |
| UX rules accepted | `artifacts/ux-direction-lock.md` complete | Complete | Compact ledger rules, no-hidden-detail rule, accessibility, responsive behavior, and reuse decisions recorded. |
| TypeScript verification | `pnpm tsc --noEmit` | Complete | Passed locally on 2026-05-31. |

## Start Conditions For Phase 1

- `leadCustomerSearchRows` is accepted as derived data, not source of truth.
- Phase 1 must use `convex-migration-helper` because it adds schema plus backfill/assertion work.
- Projection rows must be maintained by write hooks before any UI depends on them.
- Backfill must be batched and assertion-backed. Do not use unbounded `.collect()` loops.
- Search/list functions must use `withSearchIndex`, `withIndex`, `.take(n)`, or pagination.
- Search analytics/logging must use length buckets and result counts only.
- Direct ID resolution must verify tenant before returning a route target.
- Old routes and old navigation remain intact until redirect shims and rollback expectations are verified.

## Stable Contracts For Later Phases

| Contract | Decision |
|---|---|
| Route identity | Lead ID is canonical. Customer, opportunity, and meeting IDs resolve to lead route targets. |
| Browse data source | One projection row per non-deleted lead/customer entity. |
| Search minimum | Fuzzy search starts at 2 characters; direct Convex ID resolution can run before fuzzy search. |
| Lifecycle values | `lead`, `customer`, `merged`; default browse hides merged rows via `isSearchVisible`. |
| Detail payload | One bounded page payload for lead/customer/person context; sheet fetches full opportunity detail lazily. |
| Closer access | Preserve broad current person lookup for MVP, but keep opportunity/meeting/comment/payment detail permission-aware. |
| Legacy redirects | Resolve server-side and redirect to `/workspace/leads-customers` namespace. |
| Side deal route | New canonical route is `/workspace/leads-customers/new-opportunity`; old route redirects later. |

## Non-Blocking MVP Questions

| Question | MVP decision | Follow-up |
|---|---|---|
| Tighten closer visibility to assigned entities only? | No; preserve current broad person lookup, but restrict related detail/actions. | Product/security decision after MVP. |
| Full comment search? | No; render bounded comments inline but do not index comment content globally. | Separate search feature. |
| Full unified export? | No; allow loaded-row export for admins first if needed. | Server export job if product needs full exports. |
| Remove legacy route files? | No; redirect shims first. | Delete old surfaces only after Phase 5 production confidence. |
| Rebuild merge UX under unified route? | No; keep existing merge route. | Dedicated merge redesign later. |

## Risks And Mitigations

| Risk | Evidence | Mitigation |
|---|---|---|
| Read amplification if unified browse stitches current tables | Existing lead/customer/opportunity lists perform row enrichment with companion reads. | Use projection table for browse/search and cap detail payloads. |
| PII leakage in logs | Current `searchLeads` logs raw `searchTerm`. | New code logs length buckets only; schedule legacy cleanup before canonical rollout. |
| Closer sees opportunity/comment/payment detail not assigned to them | Unified page consolidates data from surfaces with different guards. | Return per-related-record permission metadata; reuse existing opportunity/meeting guards. |
| Redirects leak cross-tenant IDs | Current detail routes vary between throw/null/client redirect behavior. | Redirect resolvers return `null` for missing or inaccessible IDs. |
| QA fixtures incomplete | Production sample lacks side-deal and merged-lead cases. | Create missing fixtures before Phase 4/5 QA and record redacted IDs. |
| URL-state regressions | Current opportunity filters sync to URL; lead/customer pages mostly do not. | Phase 2 URL state must cover `q`, `lifecycle`, pagination/sort where applicable, and sheet `opportunityId`. |

## References Used

- `plans/leads-customers-unified-view/leads-customers-unified-view-design.md`
- `plans/leads-customers-unified-view/phases/phase0.md`
- `plans/leads-customers-unified-view/phases/parallelization-strategy.md`
- `.docs/convex/nextjs.md`
- `.docs/convex/module-nextjs.md`
- `convex/_generated/ai/guidelines.md`
- `TESTING.MD`
- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md` and local `next-best-practices` references for App Router, async params, data patterns, and Suspense.
- Latest Vercel Web Interface Guidelines fetched from `https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md` on 2026-05-31.
- `frontend-design`, `web-design-guidelines`, `next-best-practices`, and narrow `convex-performance-audit` skill instructions.

## Phase 1 Can Start When

- The TypeScript check in `artifacts/phase0-handoff.md` passes or records only unrelated pre-existing failures.
- The Phase 1 owner reads this brief plus the migration helper skill before editing `convex/schema.ts`.
- The missing QA fixture gaps are accepted as Phase 4/5 blockers, not Phase 1 blockers.
