# Phase 2 QA — Unified Search Workspace

| Check | Desktop | Mobile | Notes |
|---|---|---|---|
| Route gate redirects `lead_generator` | TBD | TBD | Requires role-specific manual session. |
| Search by active lead handle | TBD | TBD | Uses `searchEntities`. |
| Search by customer email | TBD | TBD | Uses `searchEntities`. |
| Direct opportunity ID opens detail URL with `opportunityId` | TBD | TBD | Direct-hit affordance rendered in result row/card. |
| Lifecycle filter changes URL and results | TBD | TBD | URL param omitted for `all`. |
| Browse load more preserves lifecycle | TBD | N/A | Uses `listEntities` pagination. |
| Empty search state is compact | TBD | TBD | Empty component rendered. |
| Skeleton does not cause visible layout jump | TBD | TBD | Segment and in-route result skeletons added. |
| Dark mode contrast passes visual review | TBD | TBD | Semantic tokens only. |
| Row links support Cmd/Ctrl-click | TBD | TBD | Rows use `Link`, not click navigation. |

## Viewports

- Desktop: 1440 x 1000
- Narrow desktop: 1024 x 768
- Tablet: 768 x 1024
- Mobile: 390 x 844

## Automated Checks

- `pnpm tsc --noEmit`: pass
- `pnpm exec eslint app/workspace/leads-customers app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx`: pass
- `pnpm lint`: blocked by pre-existing repository errors outside this change set (`.agents/skills/workos-widgets/references/scripts/query-spec.cjs`, `components/theme-toggle.tsx`, `hooks/use-polling-query.ts`, and settings files).
