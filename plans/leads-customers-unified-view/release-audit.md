# Leads & Customers Unified View - Release Audit

## Status

Pre-flight checklist created. Local static checks recorded on 2026-05-31 after the Phase 5 patch.

## Security

- [ ] No public Convex function accepts `tenantId`, `userId`, or `role` as a client-controlled authorization argument.
- [ ] Search/list/detail derive tenant and viewer through `requireTenantUser`.
- [ ] Opportunity sheet uses `api.opportunities.detailQuery.getOpportunityDetail`.
- [ ] Unassigned closer opportunity detail does not expose comments, payments, or actions.
- [ ] Redirect resolvers return `null` for missing, cross-tenant, or inaccessible records.
- [ ] Logs and analytics avoid raw search terms and PII.

## Performance

- [ ] Search uses the projection search index.
- [ ] Browse/list paths use tenant-first indexes or search index constraints before pagination.
- [ ] Detail payload caps opportunities, meetings, comments, payments, and activity.
- [ ] No new unbounded `.collect()` in the unified workspace path.
- [ ] No database `.filter()` for tenant or lifecycle constraints in unified workspace queries.

## UI And Accessibility

- [ ] Sidebar shows one Leads & Customers item for admins and closers.
- [ ] Command palette page entries point to Leads & Customers.
- [ ] Create opportunity quick action points to `/workspace/leads-customers/new-opportunity`.
- [ ] Breadcrumbs show "Leads & Customers" and "New Side Deal".
- [ ] Row links use `Link`/`Button asChild` for browser affordances.
- [ ] Sheet closes with Escape and preserves non-`opportunityId` query params.
- [ ] Mobile viewport has no horizontal scroll or content overlap.
- [ ] Dark mode uses semantic tokens.

## Analytics And Logs

- [ ] PostHog events use counts, booleans, enums, route names, or length buckets only.
- [ ] No raw names, emails, phones, handles, payment references, comments, or notes in structured logs.
- [ ] Redirect failures do not reveal cross-tenant existence details.

## Local Checks

- [x] `pnpm tsc --noEmit`
- [ ] `pnpm lint` - fails on pre-existing repo-wide issues outside Phase 5 touched files, including `.agents/skills/workos-widgets/references/scripts/query-spec.cjs`, existing React hook lint errors in settings/theme/polling files, and generated Convex eslint-disable warnings.
- [x] `pnpm exec eslint app/workspace/_components/workspace-shell-client.tsx components/command-palette.tsx hooks/use-breadcrumbs.ts app/workspace/operations/_components/qualification-table.tsx app/workspace/operations/_components/scheduling-table.tsx app/workspace/closer/_components/reminders-section.tsx 'app/workspace/closer/reminders/[followUpId]/_components/reminder-outcome-action-bar.tsx' app/workspace/_components/pipeline/opportunities-table.tsx`
- [x] `npx convex dev --once`
