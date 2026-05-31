# Phase 3 QA — Entity Detail

| Scenario | Admin | Closer assigned | Closer unassigned | Notes |
|---|---|---|---|---|
| Active lead with one opportunity | TBD | TBD | TBD |  |
| Converted customer with payment | TBD | TBD | TBD | Customer lifecycle strip visible. |
| Entity with 2+ opportunities | TBD | TBD | TBD | Opportunity rows remain compact. |
| Meeting with comments | TBD | TBD | TBD | Deleted comments hidden by backend payload. |
| Opportunity permission denied | N/A | N/A | TBD | Summary-only row. |
| Missing lead | TBD | TBD | TBD | Controlled not-found state. |
| Merged source lead | TBD | TBD | TBD | Client redirect to target lead. |
| Mobile viewport | TBD | TBD | TBD | No overlap. |
| Dark mode | TBD | TBD | TBD | Semantic tokens readable. |

## Link Checks

- [ ] Back link returns to `/workspace/leads-customers`.
- [ ] Opportunity Details links preserve current lead route and add only `opportunityId`.
- [ ] Meeting links open in a new tab with `rel="noreferrer"`.
- [ ] Cmd/Ctrl-click works on row/action links.

## Automated Checks

- `pnpm tsc --noEmit`: pass
- `pnpm exec eslint app/workspace/leads-customers app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx`: pass
- `pnpm lint`: blocked by pre-existing repository errors outside this change set (`.agents/skills/workos-widgets/references/scripts/query-spec.cjs`, `components/theme-toggle.tsx`, `hooks/use-polling-query.ts`, and settings files).
