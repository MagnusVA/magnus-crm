# Phase 0 Handoff - Leads & Customers Unified View

**Phase:** 0F - Handoff Checklist and Phase Gate  
**Date captured:** 2026-05-31

## Required Artifacts

- [x] `artifacts/current-state-inventory.md`
- [x] `artifacts/sample-data-matrix.md`
- [x] `artifacts/security-contract.md`
- [x] `artifacts/ux-direction-lock.md`
- [x] `artifacts/implementation-readiness.md`

## Verification Commands

| Command | Result | Notes |
|---|---|---|
| `pnpm tsc --noEmit` | Passed | Completed locally with exit code 0 on 2026-05-31. |
| `npx convex insights --details` | Passed with unrelated warnings | Reported OCC retries in `operationsMeetingDailyStats` and `tenantCalendlyConnections`; no browse/detail hot-path warning found. |
| `npx convex data ... --prod --format json/jsonl` | Completed read-only inspection | Output was filtered and redacted before writing sample IDs. |

## Go / No-Go

| Item | Status | Notes |
|---|---|---|
| Phase 1 schema/backfill planning can begin | Go | Phase 1 must invoke `convex-migration-helper`. |
| Production/test tenant records identified | Conditional | Core records found in production read-only sample, including multi-meeting. Side-deal and merged-lead fixtures are missing. |
| Rollback route strategy accepted | Go | Old routes stay until Phase 4 redirects and Phase 5 nav flip. |
| Security/PII contract ready | Go | Raw search terms and identifiers forbidden in new logs/analytics. |
| UX direction ready | Go | Compact ledger, no hidden detail, no nested cards, accessible row/link behavior. |

## Commands Run

- `sed -n ... plans/leads-customers-unified-view/leads-customers-unified-view-design.md`
- `sed -n ... plans/leads-customers-unified-view/phases/phase0.md`
- `sed -n ... plans/leads-customers-unified-view/phases/parallelization-strategy.md`
- `sed -n ... .agents/skills/frontend-design/SKILL.md`
- `sed -n ... .agents/skills/web-design-guidelines/SKILL.md`
- `sed -n ... .agents/skills/next-best-practices/SKILL.md`
- `sed -n ... .agents/skills/convex-performance-audit/SKILL.md`
- `curl -fsSL https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md`
- `sed -n ... .docs/convex/nextjs.md`
- `sed -n ... .docs/convex/module-nextjs.md`
- `sed -n ... convex/_generated/ai/guidelines.md`
- `sed -n ... TESTING.MD`
- `rg --files node_modules/next/dist/docs`
- `find app/workspace/leads app/workspace/customers app/workspace/opportunities -maxdepth 5 -type f | sort`
- `rg -n "requirePermission|requireRole|useQuery|usePaginatedQuery|useMutation|useAction|fetchQuery|preloadQuery|api\\." app/workspace/leads app/workspace/customers app/workspace/opportunities`
- `rg -n "export const ..." convex/leads convex/customers convex/opportunities convex/closer convex/pipeline`
- `npx convex insights --details`
- `npx convex data <table> --prod --limit <n> --format json/jsonl` for `leads`, `customers`, `opportunities`, `meetings`, `meetingComments`, `paymentRecords`, `leadMergeHistory`, `slackQualificationEvents`, and `leadIdentifiers`

## Handoff Notes

- Do not start Phase 1 schema edits without reading `convex-migration-helper`.
- Do not flip sidebar or command palette entries until Phase 5.
- Do not deploy route redirects until Phase 4 route targets and redirect resolvers exist.
- Do not copy current raw search-term logging from `leads.queries.searchLeads`.
- Fill missing side-deal and merged-lead fixture IDs before Phase 4/5 QA closes.
