# Team Member Avatars - Missing Surface Inventory

**Status:** Audit artifact  
**Purpose:** Inventory codebase surfaces that display CRM users, closers, lead generators, Slack qualifiers, DM closers, or app actors but are missing from, or under-specified by, `team-member-avatars-design.md`.

This document does not modify the design spec. It is meant to give the next implementation/design pass a concrete checklist of what still needs to be reconciled.

## Scope Notes

- "Missing" means the current design inventory does not name the surface or its backing data path clearly enough for implementation.
- "Under-specified" means the design has a broad row that may include the surface, but the exact files/data fields should be called out before implementation.
- Public DM portal behavior should remain privacy-safe. If avatars are added there, use initials-only unless product explicitly approves public WorkOS/Slack image exposure.

## High Priority Missing Surfaces

### Activity Feed Report

The activity report is a full app-user actor surface, but the plan does not list it under reports.

Frontend:

- `app/workspace/reports/activity/_components/activity-event-row.tsx`
  - Renders `event.actorName ?? "System"` in each activity row.
- `app/workspace/reports/activity/_components/activity-feed-filters.tsx`
  - Renders actor filter options from `actorBreakdown`.
- `app/workspace/reports/activity/_components/activity-summary-cards.tsx`
  - Renders "Most Active Closer" from `actorBreakdown`.

Convex/data source:

- `convex/reporting/activityFeed.ts`
  - `getActivityEvents` enriches `domainEvents.actorUserId` into `actorName`.
  - `getActivitySummary` returns `actorBreakdown` with `actorUserId`, `actorName`, `actorRole`, and `count`.

Current identity fields:

- `actorUserId`
- `actorName`
- `actorRole`

Avatar work needed:

- Return an actor identity object with `id`, `name`, `email`, `imageUrl`, `isActive`, and `source: "workos"` for user-backed events.
- Preserve `System` as non-user/unknown identity with initials fallback or no avatar depending row layout.
- Update row, actor filter options, and most-active-closer card.

### Pipeline Health Report

Pipeline Health has separate closer and actor displays that are not covered by the existing report rows in the plan.

Frontend:

- `app/workspace/reports/pipeline/_components/stale-pipeline-list.tsx`
  - Renders `assignedCloserName`.
- `app/workspace/reports/pipeline/_components/loss-attribution-chart.tsx`
  - Renders loss actors by `actor.actorName` and `actor.actorRole`.

Convex/data source:

- `convex/reporting/pipelineHealth.ts`
  - `getPipelineHealthReport` returns `staleOpps[].assignedCloserName`.
  - `getLossAttribution` returns `byActor[]`.

Current identity fields:

- `assignedCloserId`
- `assignedCloserName`
- `userId`
- `actorName`
- `actorRole`

Avatar work needed:

- Add assigned closer identity to `staleOpps`.
- Add actor identity to `lossAttribution.byActor`.
- Render `MemberIdentity` in stale opportunity rows and loss actor rows.

## Medium Priority Missing Surfaces

### Customers

The Customers area displays CRM users as converters, assigned closers, and payment attribution people, but the plan does not list `/workspace/customers`.

Frontend:

- `app/workspace/customers/_components/customers-table.tsx`
  - Renders `convertedByName`.
- `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx`
  - Renders `convertedByName` and `closerName`.
- `app/workspace/customers/[customerId]/_components/payment-history-table.tsx`
  - Renders `attributedCloserName`; receives `recordedByName` in the row type but does not currently display it.

Convex/data source:

- `convex/customers/queries.ts`
  - `listCustomers` maps `convertedByUserId` to `convertedByName`.
  - `getCustomerDetail` maps converter, assigned closer, attributed closer, and recorded-by users.

Current identity fields:

- `convertedByUserId`
- `convertedByName`
- `closerName`
- `attributedCloserId`
- `attributedCloserName`
- `recordedByUserId`
- `recordedByName`

Avatar work needed:

- Return converter identity for customer list/detail.
- Return assigned closer identity for detail conversion panel.
- Return attributed closer identity in payment history rows.
- Decide whether recorded-by should be displayed and avatarized in payment history, since the backend already computes it.

### Legacy Leads Routes

The design mentions "opportunity/lead detail attribution components" broadly, but the legacy `/workspace/leads` surfaces have their own data shapes and should be called out explicitly.

Frontend:

- `app/workspace/leads/_components/leads-table.tsx`
  - Renders `assignedCloserName`.
- `app/workspace/leads/[leadId]/_components/tabs/lead-overview-tab.tsx`
  - Renders Slack qualification `slackUserLabel`.
- `app/workspace/leads/[leadId]/_components/tabs/lead-opportunities-tab.tsx`
  - Renders opportunity `closerName`.
- `app/workspace/leads/[leadId]/_components/tabs/lead-meetings-tab.tsx`
  - Renders meeting `closerName`.
- `app/workspace/leads/[leadId]/_components/tabs/lead-activity-tab.tsx`
  - Renders meeting closer names and merge actor `mergedByUserName`.

Convex/data source:

- `convex/leads/queries.ts`
  - `listLeads` computes `assignedCloserName`.
  - `getLeadDetail` computes opportunity `closerName`, meeting `closerName`, Slack labels, and merge actor names.

Current identity fields:

- `assignedCloserName`
- `closerName`
- `slackUserId`
- `slackUserLabel`
- `mergedByUserId`
- `mergedByUserName`

Avatar work needed:

- Add closer identity to lead list rows, lead opportunity rows, and lead meeting rows.
- Add Slack identity, including `avatarUrl`, to lead qualification rows.
- Add merge actor identity to lead activity timeline.

### Settings Attribution And Portal Admin Surfaces

Settings contains DM closer management and recent DM portal copy activity. These are not listed in the rollout inventory, even though the DM closer linking work would likely land here.

Frontend:

- `app/workspace/settings/_components/attribution-tab.tsx`
  - Renders DM closer rows by `closer.displayName`.
- `app/workspace/settings/_components/dm-closer-dialog.tsx`
  - Creates/edits DM closer records; this is the natural place for optional CRM user linking.
- `app/workspace/settings/_components/portal-usage-card.tsx`
  - Renders recent copy activity `event.dmCloserName`.
- `app/workspace/reports/_components/report-attribution-filters.tsx`
  - Renders active DM closer select options.

Convex/data source:

- `convex/attribution/dmClosers.ts`
  - `listDmClosers`, create/update/toggle functions.
- `convex/linkPortal/copyQueries.ts`
  - Recent copy events include `dmCloserName`.

Current identity fields:

- `dmCloserId`
- `displayName`
- `teamLabel`
- `dmCloserName`

Avatar work needed:

- Add optional linked-user identity to `listDmClosers`.
- Extend `DmCloserDialog` to select/clear the linked CRM user if the design keeps `dmClosers.userId`.
- Add initials avatar for unlinked DM closers.
- Add linked CRM image only in authenticated workspace settings/report surfaces.

### Public DM Link Portal

The design has a privacy rule for public portals, but the route itself is not in the rollout inventory.

Frontend:

- `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx`
  - Renders selectable DM closer options with `row.displayName` and `row.teamDisplayName`.

Convex/data source:

- `convex/linkPortal/portalQueries.ts`
  - Public bootstrap includes `dmClosers`.

Current identity fields:

- `dmCloserId`
- `displayName`
- `teamDisplayName`

Avatar work needed:

- If avatars are added, render initials-only for public DM closer choices.
- Do not expose linked `users.profilePictureUrl`, WorkOS email, or Slack image URLs in the public bootstrap payload unless explicitly approved.

### Team Redistribution Wizard

Recent reassignments are covered, but the active redistribution flow also displays closers and should be included.

Frontend:

- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx`
  - Displays unavailable closer name.
  - Displays available closer cards.
  - Displays manual resolve closer select options.

Convex/data source:

- `convex/unavailability/queries.ts`
  - `getUnavailabilityWithMeetings`
  - `getAvailableClosersForDate`
- `convex/unavailability/shared.ts`
  - Builds closer schedules with `closerName`.

Current identity fields:

- `closerId`
- `closerName`
- `toCloserId`
- `toCloserName`

Avatar work needed:

- Return identity for unavailable closer and available closers.
- Render `MemberIdentity` in candidate closer cards.
- Consider compact identity rows in manual resolve select items if select layout remains stable.

### Billing Detail Sub-Surfaces

The plan lists billing detail broadly, but several identity displays are outside the named summary fields.

Frontend:

- `app/workspace/billing/_components/billing-payment-summary.tsx`
  - Renders `enteredBy.name`, `phoneCloser.name`, `dmAttribution.dmCloserName`, and `review.reviewerName`.
- `app/workspace/billing/_components/billing-event-history.tsx`
  - Renders audit event `actorName`.
- `app/workspace/billing/_components/slack-contributor-timeline.tsx`
  - Renders Slack contributor `event.label` and `event.slackUserId`.

Convex/data source:

- `convex/billing/enrichment.ts`
  - Builds entered-by, phone closer, reviewer, audit actor, DM closer, and Slack contributor labels.
- `convex/billing/types.ts`
  - Detail payload types for review and event actors.
- `convex/billing/export.ts`
  - Exports some of the same identity labels.

Current identity fields:

- `enteredBy.name`
- `phoneCloser.name`
- `dmCloserName`
- `reviewerName`
- `actorName`
- `slackUserId`
- `label`

Avatar work needed:

- Add identity payloads for entered-by, phone closer, reviewer, and event actor.
- Add Slack identity with `avatarUrl` for Slack contributor timeline.
- Add DM closer identity for the billing attribution block.

### Revenue Top Deals

The plan covers `closer-revenue-table.tsx` but not the Top Deals table, which also renders attributed closers.

Frontend:

- `app/workspace/reports/revenue/_components/top-deals-table.tsx`
  - Renders `deal.attributedCloserName`.

Convex/data source:

- `convex/reporting/revenue.ts`
  - `getTopDealsAndDistribution` maps `effectiveCloserId` to `attributedCloserName`.

Current identity fields:

- `attributedCloserId`
- `attributedCloserName`

Avatar work needed:

- Add attributed closer identity to each top deal row.
- Render compact `MemberIdentity` in the closer column.

### Meeting Comments

Closer detail surfaces are mentioned, but comment authors are a distinct app-user surface with an existing initials bubble.

Frontend:

- `app/workspace/closer/meetings/_components/comment-entry.tsx`
  - Renders a manual initials circle from `comment.authorName`.

Convex/data source:

- `convex/closer/meetingComments.ts`
  - `listComments` maps `authorId` to `authorName` and `authorRole`.

Current identity fields:

- `authorId`
- `authorName`
- `authorRole`
- `isOwn`

Avatar work needed:

- Return author identity with avatar URL.
- Replace manual initials circle with shared `MemberAvatar` or `MemberIdentity`.

### Admin Reminder Detail

The admin reminder detail reuses closer reminder components but separately resolves the assigned closer for the on-behalf banner.

Frontend:

- `app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-detail-page-client.tsx`
  - Resolves assigned closer from `listTeamMembers`.
- `app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-outcome-action-bar.tsx`
  - Renders `assignedCloserName`.

Convex/data source:

- `convex/pipeline/reminderDetail.ts`
  - Admin reminder detail payload.
- `convex/users/queries.ts`
  - `listTeamMembers` used client-side for assigned closer display.

Current identity fields:

- `followUp.closerId`
- `assignedCloserName`

Avatar work needed:

- Prefer returning assigned closer identity directly in the admin reminder detail payload to avoid a broad roster query for display metadata.
- Render the on-behalf callout with a compact avatar row.

## Low Priority Missing Surfaces

### Profile Page

Sidebar current user is covered, but `/workspace/profile` is not.

Frontend:

- `app/workspace/profile/_components/profile-page-client.tsx`
  - Renders current user name, email, role, and Calendly link status.

Convex/data source:

- `convex/users/queries.ts`
  - `getCurrentUser`

Current identity fields:

- `fullName`
- `email`
- `role`

Avatar work needed:

- Include current user's `profilePictureUrl`.
- Render profile avatar in the account card header or first info row.

### Team Action Dialogs

The team table is covered, but user-specific dialogs still display a selected member name without a shared identity row.

Frontend:

- `app/workspace/team/_components/remove-user-dialog.tsx`
- `app/workspace/team/_components/role-edit-dialog.tsx`
- `app/workspace/team/_components/calendly-link-dialog.tsx`
- `app/workspace/team/_components/event-type-assignment-dialog.tsx`
- `app/workspace/team/_components/mark-unavailable-dialog.tsx`

Current identity fields:

- `userId`
- `userName`

Avatar work needed:

- Optional: pass selected member identity from `team-page-client.tsx` instead of only `userName`.
- Use a compact identity row in destructive/role-changing dialogs where it reduces ambiguity.

### Closer And Opportunity Selector Controls

The design says selects/dropdowns are a second pass, but the exact closer selector files are not listed.

Frontend:

- `app/workspace/opportunities/new/_components/closer-select.tsx`
- `app/workspace/opportunities/_components/opportunity-filters.tsx`
- `app/workspace/_components/pipeline/pipeline-filters.tsx`
- `app/workspace/operations/_components/operations-filter-bar.tsx`
- `app/workspace/lead-gen/_components/lead-gen-filter-bar.tsx`

Convex/data source:

- `convex/users/queries.ts`
  - `listActiveClosers`
- `convex/operations/qualifications.ts`
  - Operation filter options for Slack users, closers, DM closers.
- `convex/leadGen/workers.ts`
  - Lead-gen worker options.

Current identity fields:

- `closer.fullName`
- `closer.email`
- `worker.displayName`
- `worker.email`
- option `id`
- option `name`

Avatar work needed:

- If select-menu avatars are in scope, enrich option rows with identity payloads.
- Keep row height stable; otherwise defer visual avatars in filters and keep text-only.

## Under-Specified Existing Plan Rows

These are probably covered by broad rows in the design, but implementation needs explicit field-level treatment.

### Leads And Customers Unified View

The plan says "opportunity/lead detail attribution components"; the unified view has multiple separate components that render closer, Slack qualifier, and DM closer labels.

Frontend:

- `app/workspace/leads-customers/[leadId]/_components/entity-opportunity-row.tsx`
  - Renders `Closer: {closerLabel}`.
- `app/workspace/leads-customers/[leadId]/_components/entity-attribution-grid.tsx`
  - Renders Slack qualifier, DM closer, and phone closer.
- `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-summary.tsx`
  - Renders Slack qualifier and closer summary.
- `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-body.tsx`
  - Renders sheet attribution fields.

Convex/data source:

- `convex/leadCustomers/detailPayload.ts`
  - Builds compact closer payloads.
- `convex/lib/attribution/detailPayload.ts`
  - Builds Slack, DM, and phone closer attribution payloads.

Current identity fields:

- `closer.fullName`
- `closer.email`
- `slackUserId`
- `slackUserLabel`
- `dmCloserName`
- `phoneCloser.name`

Avatar work needed:

- Promote attribution payload fields from label-only to identity objects.
- Ensure closer payloads include `profilePictureUrl`.
- Ensure Slack payload includes `avatarUrl`.
- Ensure DM closer payload supports linked user image only in authenticated workspace contexts.

### Opportunity Detail And Pipeline Tables

The plan mentions pipeline/opportunity tables, but the following selectors/detail fields need explicit rollout to avoid only updating the overview pipeline table.

Frontend:

- `app/workspace/_components/pipeline/opportunities-table.tsx`
- `app/workspace/opportunities/_components/opportunities-table.tsx`
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx`
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-activity-timeline.tsx`

Convex/data source:

- `convex/opportunities/queries.ts`
- `convex/opportunities/detailQuery.ts`

Current identity fields:

- `closerName`
- `closerEmail`
- `assignedCloser`
- `slackUserLabel`
- `actorUserId` on activity events, although the timeline currently renders source/status more than actor identity.

Avatar work needed:

- Add assigned closer identity to list and detail payloads.
- Decide whether opportunity activity timeline should remain source-only or render actor identity when `actorUserId` is present.

### Lead Gen Exports And Raw Rows

The plan covers Lead Gen Ops, but export and raw row payloads should be treated deliberately.

Frontend:

- `app/workspace/lead-gen/_components/raw-submissions-table.tsx`
  - Renders worker display name and team.
- `app/workspace/lead-gen/_components/lead-gen-export-menu.tsx`
  - Exports worker names/emails.
- `app/workspace/lead-gen/_components/lead-gen-excel-report.ts`
  - Generates spreadsheet rows with worker names/emails.

Convex/data source:

- `convex/leadGen/exports.ts`
- `convex/leadGen/reportBuilders.ts`
- `convex/leadGen/reporting.ts`

Current identity fields:

- `workerId`
- `workerDisplayName`
- `workerEmail`
- `displayName`
- `email`

Avatar work needed:

- UI raw rows can use worker avatar identity if `leadGenWorkers.profilePictureUrl` is added.
- Spreadsheet/export files should likely remain text-only unless a future export requirement says otherwise.

## Backend Helper Coverage Needed

The design proposes `convex/lib/memberIdentity.ts`, but the audit shows it should cover more than plain CRM users.

Recommended helper shapes:

- `userMemberIdentity(user, fallbackLabel?)`
  - WorkOS/CRM users.
- `slackMemberIdentity(slackUser, fallbackSlackUserId)`
  - Slack-only qualifiers/setters.
- `dmCloserMemberIdentity(dmCloser, linkedUser?)`
  - DM closer attribution records with optional CRM link.
- `unknownMemberIdentity(label, source)`
  - Removed users, system actors, and historical rows.

Likely Convex modules that need helper adoption:

- `convex/reporting/activityFeed.ts`
- `convex/reporting/pipelineHealth.ts`
- `convex/customers/queries.ts`
- `convex/leads/queries.ts`
- `convex/lib/attribution/detailPayload.ts`
- `convex/leadCustomers/detailPayload.ts`
- `convex/billing/enrichment.ts`
- `convex/linkPortal/copyQueries.ts`
- `convex/linkPortal/portalQueries.ts`
- `convex/unavailability/queries.ts`
- `convex/closer/meetingComments.ts`
- `convex/opportunities/queries.ts`
- `convex/opportunities/detailQuery.ts`

## Privacy And Rollout Decisions To Resolve

- Public portal: initials-only by default; no WorkOS or Slack image URLs in public payloads.
- Select/dropdown avatars: only add where row height remains stable. Otherwise keep text-only and treat as a follow-up pass.
- Export files: keep text-only unless product explicitly wants embedded images.
- Historical/deleted users: all backend identity helpers need a stable "Removed user" or stored-label fallback.
- System actors: activity feed should represent system rows consistently without pretending there is a CRM user.

