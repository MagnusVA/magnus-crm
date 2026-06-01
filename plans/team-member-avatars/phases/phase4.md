# Phase 4 — Workspace Surface Rollout

**Goal:** Replace one-off name/avatar rendering across authenticated workspace surfaces with the shared identity contract. After this phase, every CRM user, lead generator, closer, Slack qualifier/setter, DM closer, and app actor shown in the workspace has a circular avatar on the left when layout allows it, with deterministic initials fallback.

**Prerequisite:** Phase 1F and Phase 2E are complete. Phase 3A and 3B are complete for current-user/profile surfaces. For any Next.js route or client boundary touched in this phase, read the relevant guide under `node_modules/next/dist/docs/` before editing.

**Runs in PARALLEL with:** Phase 3 profile UI after 4A owners avoid `convex/users/queries.ts` until 3B merges. Phase 5 backfill implementation can run in parallel, but Phase 5 verification waits for Phase 4 completion.

**Skills to invoke:**
- `frontend-design` — dense tables, cards, reports, and selectors need compact, non-marketing UI.
- `shadcn` — compose Avatar, Table, Select, Dialog, Badge, Skeleton, Tooltip, and Button primitives.
- `next-best-practices` — preserve App Router server/client boundaries and thin route pages.
- `vercel-react-best-practices` — avoid extra client subscriptions/read waterfalls; enrich rows in Convex.
- `convex-performance-audit` — use if a rollout stream creates expensive query enrichment or read amplification.
- `web-design-guidelines` — accessibility and responsive verification for avatar rows.

**Acceptance Criteria:**
1. Workspace sidebar, profile, team, reports, operations, lead-gen, customers, leads, opportunities, billing, settings, and closer detail surfaces render member avatars where team-member names are visible.
2. Every new identity payload is created in an already-authorized Convex query or server helper; client components do not fetch user records just to render avatars.
3. Slack-only people continue using `slackUsers.avatarUrl` and do not prefer WorkOS unless a later explicit Slack-to-CRM mapping exists.
4. DM closer rows in authenticated workspace surfaces use linked CRM avatars when `dmClosers.userId` is set and initials otherwise.
5. Public DM link portal payloads remain initials-only and expose no WorkOS, Slack, Convex storage, or CRM email image data.
6. Exports and spreadsheet/report builders remain text-only, even when matching UI rows use avatar identities.
7. Existing route auth, role gates, and `requireTenantUser` checks remain unchanged or stricter.
8. Loading skeletons include `role="status"` and `aria-label` where surrounding page patterns already use skeleton states.
9. Manual responsive QA confirms no avatar/name overlap on mobile and no row-height shifts when images fail.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (shell + users/team contract) ──────┬── 4B (overview + operations) ──────┐
                                       ├── 4C (reports) ───────────────────┤
                                       ├── 4D (lead-gen ops) ──────────────┤
                                       ├── 4E (customers/leads/pipeline) ──┤
                                       ├── 4F (billing/closer/comments) ───┤
                                       └── 4G (settings + public portal) ──┤
                                                                            ├── 4H (cross-surface QA)
Phase 3B current-user avatar ───────────────┘                               │
Phase 2E component contract ─────────────────────────────────────────────────┘
```

**Optimal execution:**
1. Start 4A first because it reserves `convex/users/queries.ts`, shell props, and team-management data shapes.
2. Start 4B-4G in parallel once 4A publishes any shared user-list/closer option shapes. These streams mostly touch different route directories and Convex modules.
3. Inside each stream, backend query enrichment should land before UI wiring, but independent components in the same stream can be split across agents.
4. Keep file ownership strict: if two streams need the same helper, update `convex/lib/memberIdentity.ts` in a tiny coordination branch before either stream proceeds.
5. Finish with 4H after all streams merge.

**Estimated time:** 4-7 days with 3+ agents, 8-12 days solo

---

## Subphases

### 4A — Shell, Team, and User Option Surfaces

**Type:** Full-Stack
**Parallelizable:** No — owns shared current-user/team query shapes that several other streams consume.

**What:** Add current-user identity to the workspace shell/sidebar, team member table/dialogs, active closer options, recent reassignments, and the redistribution wizard.

**Why:** These are the highest-shared user surfaces. Stabilizing them first reduces downstream ambiguity about how active/inactive/pending users should be represented.

**Where:**
- `app/workspace/_components/workspace-auth.tsx` (modify)
- `app/workspace/_components/workspace-shell-client.tsx` (modify)
- `convex/users/queries.ts` (modify)
- `app/workspace/team/_components/team-members-table.tsx` (modify)
- `app/workspace/team/_components/*-dialog.tsx` (modify targeted dialogs)
- `app/workspace/team/_components/recent-reassignments.tsx` (modify)
- `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx` (modify)
- `convex/unavailability/queries.ts` (modify)
- `convex/unavailability/shared.ts` (modify)

**How:**

**Step 1: Pass the current-user identity into the workspace shell.**

```tsx
// Path: app/workspace/_components/workspace-auth.tsx
<WorkspaceShellClient
  initialRole={access.crmUser.role}
  initialDisplayName={access.crmUser.fullName ?? access.crmUser.email}
  initialEmail={access.crmUser.email}
  initialAvatar={access.crmUser.avatar}
  workosUserId={access.crmUser.workosUserId}
  workosOrgId={access.tenant.workosOrgId}
  tenantName={access.tenant.companyName}
  billingOpsEnabled={access.tenant.billingOpsEnabled === true}
>
  {children}
</WorkspaceShellClient>
```

**Step 2: Render the sidebar account area with `MemberIdentity`.**

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx
import { MemberIdentity } from "./member-identity";
import type { MemberAvatarIdentity } from "./member-avatar";

interface WorkspaceShellClientProps {
  initialAvatar: MemberAvatarIdentity;
  // Existing props remain.
}

<div className="px-2 py-1.5 group-data-[collapsible=icon]:hidden">
  <MemberIdentity
    identity={{
      ...initialAvatar,
      secondaryLabel: role.replace(/_/g, " "),
    }}
  />
</div>
```

**Step 3: Add avatars to team members and closer options.**

```typescript
// Path: convex/users/queries.ts
return await Promise.all(
  users.map(async (user) => ({
    ...user,
    avatar: await userMemberIdentity(ctx, user),
    calendlyMemberName:
      user.calendlyMemberName ??
      (user.calendlyUserUri
        ? calendlyMemberNameByUri.get(user.calendlyUserUri)
        : undefined),
    isPendingInvite: user.invitationStatus === "pending",
  })),
);
```

```tsx
// Path: app/workspace/team/_components/team-members-table.tsx
import { MemberIdentity } from "@/app/workspace/_components/member-identity";

<MemberIdentity
  identity={member.avatar}
  badge={member.isActive ? null : <Badge variant="secondary">Inactive</Badge>}
/>
```

**Step 4: Enrich unavailability/reassignment rows.**

```typescript
// Path: convex/unavailability/queries.ts
return {
  ...row,
  fromCloser: await userMemberIdentity(ctx, fromCloser),
  toCloser: await userMemberIdentity(ctx, toCloser),
  reassignedBy: await userMemberIdentity(ctx, reassignedBy),
};
```

**Key implementation notes:**
- Do not add a second current-user query in the sidebar; use the RSC-resolved access payload.
- Team dialogs should receive the selected member's identity from page state, not refetch it.
- Inactive/pending users keep initials fallback and visible status badges.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/workspace-auth.tsx` | Modify | Pass current-user avatar into shell. |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | Render sidebar account identity. |
| `convex/users/queries.ts` | Modify | Add team/current-user/closer identity payloads. |
| `app/workspace/team/_components/team-members-table.tsx` | Modify | Render member identity rows. |
| `app/workspace/team/_components/*-dialog.tsx` | Modify | Use selected member identity where useful. |
| `app/workspace/team/_components/recent-reassignments.tsx` | Modify | Render from/to/by identities. |
| `convex/unavailability/queries.ts` | Modify | Add reassignment identities. |
| `convex/unavailability/shared.ts` | Modify | Add redistribution closer identity rows. |
| `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx` | Modify | Render unavailable/available closer identity rows. |

---

### 4B — Overview and Operations Dashboard Surfaces

**Type:** Full-Stack
**Parallelizable:** Yes — owns dashboard and operations modules after 4A publishes shared user option shapes.

**What:** Add identities to overview lead-gen, top DM closers, phone closer operations, Slack cards, and operations tables.

**Why:** The overview dashboard is the most visible team-member rollup. Operations tables mix CRM users, Slack users, and DM closers, so they prove the identity contract across all source types.

**Where:**
- `convex/dashboard/overviewTypes.ts` (modify)
- `convex/dashboard/overviewLeadGen.ts` (modify)
- `convex/dashboard/overviewOperations.ts` (modify)
- `app/workspace/_components/lead-gen-overview-card.tsx` (modify)
- `app/workspace/_components/top-dm-closers-card.tsx` (modify)
- `app/workspace/_components/phone-closer-operations-table.tsx` (modify)
- `app/workspace/_components/top-qualifiers-card.tsx` (modify)
- `app/workspace/_components/slack-user-leaderboard-card.tsx` (modify)
- `app/workspace/_components/setter-contribution-table.tsx` (modify)
- `convex/operations/scheduling.ts` (modify)
- `convex/operations/phoneSales.ts` (modify)
- `convex/operations/qualifications.ts` (modify)
- `app/workspace/operations/_components/*.tsx` (modify targeted tables/filter bar)

**How:**

**Step 1: Promote overview row names to identities.**

```typescript
// Path: convex/dashboard/overviewTypes.ts
import type { MemberAvatarIdentity } from "../lib/memberIdentity";

export type PhoneCloserOperations = {
  rows: Array<{
    closerId: Id<"users">;
    closer: MemberAvatarIdentity;
    scheduled: number;
    completed: number;
    noShows: number;
    showRate: number | null;
  }>;
};
```

**Step 2: Enrich overview rows in Convex.**

```typescript
// Path: convex/dashboard/overviewOperations.ts
const closer = closerById.get(row.closerId) ?? null;
return {
  closerId: row.closerId,
  closer: await userMemberIdentity(ctx, closer),
  scheduled: row.scheduled,
  completed: row.completed,
  noShows: row.noShows,
  showRate: calculateRate(row.completed, row.scheduled),
};
```

**Step 3: Render rows with `MemberIdentity`.**

```tsx
// Path: app/workspace/_components/phone-closer-operations-table.tsx
<TableCell>
  <MemberIdentity identity={row.closer} />
</TableCell>
```

**Step 4: Keep Slack row sources Slack-first.**

```typescript
// Path: convex/operations/qualifications.ts
return {
  ...row,
  qualifier: slackMemberIdentity(slackUser, row.slackUserId),
};
```

**Key implementation notes:**
- Do not convert Slack-only users to CRM avatars in this stream.
- Operations filters can show avatars only where row height stays stable; otherwise enrich data but render text-only until a second pass.
- Keep exports untouched.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/dashboard/overviewTypes.ts` | Modify | Add identity row types. |
| `convex/dashboard/overviewLeadGen.ts` | Modify | Add worker identity. |
| `convex/dashboard/overviewOperations.ts` | Modify | Add phone closer and DM closer identity. |
| `app/workspace/_components/lead-gen-overview-card.tsx` | Modify | Render worker identity rows. |
| `app/workspace/_components/top-dm-closers-card.tsx` | Modify | Render DM closer identity rows. |
| `app/workspace/_components/phone-closer-operations-table.tsx` | Modify | Render closer identity rows. |
| `app/workspace/_components/top-qualifiers-card.tsx` | Modify | Use shared Slack identity row. |
| `app/workspace/_components/slack-user-leaderboard-card.tsx` | Modify | Use shared Slack identity row. |
| `app/workspace/_components/setter-contribution-table.tsx` | Modify | Use shared Slack identity row. |
| `convex/operations/scheduling.ts` | Modify | Add operations identities. |
| `convex/operations/phoneSales.ts` | Modify | Add phone closer/DM identities. |
| `convex/operations/qualifications.ts` | Modify | Add Slack/closer filter identities. |
| `app/workspace/operations/_components/*.tsx` | Modify | Render targeted identity rows. |

---

### 4C — Reports Rollout

**Type:** Full-Stack
**Parallelizable:** Yes — owns `app/workspace/reports` and `convex/reporting` while other streams own operational/product areas.

**What:** Add identity payloads to team performance, team outcomes/actions, lead conversion, revenue, reminders, activity feed, pipeline health, and Slack qualification reports.

**Why:** Reports contain many historical and actor surfaces. They need avatar rendering without losing system/removed-user fallback semantics.

**Where:**
- `convex/reporting/lib/helpers.ts` (modify)
- `convex/reporting/teamPerformance.ts` (modify)
- `convex/reporting/teamOutcomes.ts` (modify)
- `convex/reporting/teamActions.ts` (modify)
- `convex/reporting/leadConversion.ts` (modify)
- `convex/reporting/revenue.ts` (modify)
- `convex/reporting/remindersReporting.ts` (modify)
- `convex/reporting/activityFeed.ts` (modify)
- `convex/reporting/pipelineHealth.ts` (modify)
- `app/workspace/reports/**/_components/*.tsx` (modify targeted tables/cards/filters)

**How:**

**Step 1: Extend a shared reporting display helper.**

```typescript
// Path: convex/reporting/lib/helpers.ts
export async function reportingUserIdentity(
  ctx: QueryCtx,
  user: Doc<"users"> | null,
  fallbackLabel = "Removed user",
) {
  if (!user) return unknownMemberIdentity(fallbackLabel, "unknown");
  return await userMemberIdentity(ctx, user);
}
```

**Step 2: Add actor identities to Activity Feed.**

```typescript
// Path: convex/reporting/activityFeed.ts
const actor = event.actorUserId ? usersById.get(event.actorUserId) ?? null : null;
return {
  ...event,
  actorIdentity: actor
    ? await userMemberIdentity(ctx, actor)
    : unknownMemberIdentity("System", "system"),
};
```

**Step 3: Render report rows with shared components.**

```tsx
// Path: app/workspace/reports/activity/_components/activity-event-row.tsx
<MemberIdentity identity={event.actorIdentity} />
```

**Step 4: Keep Top Deals and revenue exports separate.**

```typescript
// Path: convex/reporting/revenue.ts
// UI payload gets `attributedCloser`; export builders continue returning
// plain closer labels so spreadsheets remain text-only.
```

**Key implementation notes:**
- Historical rows with missing users must not throw; return `Removed user` or stored snapshot labels.
- Do not add a broad roster query on the client for filters; return actor/closer filter identities with the report payload.
- If a report already caps source reads, preserve that cap while enriching identities.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/lib/helpers.ts` | Modify | Add reporting identity helper. |
| `convex/reporting/teamPerformance.ts` | Modify | Add closer identities. |
| `convex/reporting/teamOutcomes.ts` | Modify | Add closer/outcome identities. |
| `convex/reporting/teamActions.ts` | Modify | Add action actor identities. |
| `convex/reporting/leadConversion.ts` | Modify | Add conversion closer identities. |
| `convex/reporting/revenue.ts` | Modify | Add revenue/top deal identities. |
| `convex/reporting/remindersReporting.ts` | Modify | Add per-closer identities. |
| `convex/reporting/activityFeed.ts` | Modify | Add actor identities and filters. |
| `convex/reporting/pipelineHealth.ts` | Modify | Add stale closer and loss actor identities. |
| `app/workspace/reports/**/_components/*.tsx` | Modify | Render report identities. |

---

### 4D — Lead-Gen Ops and Worker Surfaces

**Type:** Full-Stack
**Parallelizable:** Yes — owns lead-gen route components and `convex/leadGen/*` UI report payloads.

**What:** Render lead-generator worker identities in settings, performance tables, filter bars, raw submissions, and UI report builders while keeping exports text-only.

**Why:** Lead generators are first-class CRM users with custom uploads. Lead-gen operational surfaces should show the same profile identity as the rest of the CRM.

**Where:**
- `convex/leadGen/reporting.ts` (modify)
- `convex/leadGen/reportBuilders.ts` (modify)
- `convex/leadGen/exports.ts` (verify text-only)
- `app/workspace/lead-gen/_components/lead-gen-settings-page-client.tsx` (modify)
- `app/workspace/lead-gen/_components/worker-performance-table.tsx` (modify)
- `app/workspace/lead-gen/_components/lead-gen-filter-bar.tsx` (modify if stable)
- `app/workspace/lead-gen/_components/raw-submissions-table.tsx` (modify)

**How:**

**Step 1: Add worker identity in report builders.**

```typescript
// Path: convex/leadGen/reportBuilders.ts
return {
  workerId: worker._id,
  worker: await leadGenWorkerMemberIdentity(ctx, worker),
  submissions,
  uniqueProspects,
  leadsPerHour,
};
```

**Step 2: Render worker tables.**

```tsx
// Path: app/workspace/lead-gen/_components/worker-performance-table.tsx
<TableCell>
  <MemberIdentity identity={row.worker} />
</TableCell>
```

**Step 3: Keep exports text-only.**

```typescript
// Path: convex/leadGen/exports.ts
// Do not include `worker.imageUrl`, `customProfilePictureStorageId`, or
// signed Convex storage URLs in CSV/XLSX/export payloads.
```

**Key implementation notes:**
- Lead-gen worker identity should come from `leadGenWorkers` unless the surface already has a CRM user document.
- Select/filter avatars are optional if they introduce unstable row heights.
- Preserve existing raw export max-row behavior.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/reporting.ts` | Modify | Return worker identities for UI reports. |
| `convex/leadGen/reportBuilders.ts` | Modify | Add worker identity objects. |
| `convex/leadGen/exports.ts` | Verify | Keep exported rows text-only. |
| `app/workspace/lead-gen/_components/lead-gen-settings-page-client.tsx` | Modify | Render worker identities. |
| `app/workspace/lead-gen/_components/worker-performance-table.tsx` | Modify | Render worker identities. |
| `app/workspace/lead-gen/_components/lead-gen-filter-bar.tsx` | Modify | Optional stable identity options. |
| `app/workspace/lead-gen/_components/raw-submissions-table.tsx` | Modify | Render worker identities in UI. |

---

### 4E — Customers, Leads, Unified View, and Opportunities

**Type:** Full-Stack
**Parallelizable:** Yes — owns customer/lead/opportunity route areas and does not modify reports except shared helper imports.

**What:** Add identities to converter, assigned closer, attributed closer, Slack qualifier, DM closer, phone closer, merge actor, opportunity activity actor, and pipeline table rows.

**Why:** These are the primary CRM object detail surfaces. They need identity consistency without changing public portal privacy or export behavior.

**Where:**
- `convex/customers/queries.ts` (modify)
- `app/workspace/customers/_components/customers-table.tsx` (modify)
- `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` (modify)
- `app/workspace/customers/[customerId]/_components/payment-history-table.tsx` (modify)
- `convex/leads/queries.ts` (modify)
- `app/workspace/leads/**/_components/*.tsx` (modify targeted lead rows/tabs)
- `convex/leadCustomers/detailPayload.ts` (modify)
- `convex/lib/attribution/detailPayload.ts` (modify)
- `app/workspace/leads-customers/[leadId]/_components/*.tsx` (modify targeted unified rows/sheets)
- `convex/opportunities/queries.ts` (modify)
- `convex/opportunities/detailQuery.ts` (modify)
- `app/workspace/_components/pipeline/opportunities-table.tsx` (modify)
- `app/workspace/opportunities/**/_components/*.tsx` (modify targeted list/detail/timeline/filter rows)

**How:**

**Step 1: Add customer converter/closer identities.**

```typescript
// Path: convex/customers/queries.ts
return {
  ...customer,
  convertedBy: await userMemberIdentity(ctx, convertedByUser),
  assignedCloser: await userMemberIdentity(ctx, assignedCloser),
};
```

**Step 2: Promote attribution payloads from labels to identities.**

```typescript
// Path: convex/lib/attribution/detailPayload.ts
return {
  slackQualifier: slackUser ? slackMemberIdentity(slackUser) : null,
  dmCloser: dmCloser
    ? await dmCloserMemberIdentity(ctx, dmCloser, linkedDmCloserUser)
    : null,
  phoneCloser: phoneCloser ? await userMemberIdentity(ctx, phoneCloser) : null,
};
```

**Step 3: Render list/detail rows with `MemberIdentity`.**

```tsx
// Path: app/workspace/leads/_components/leads-table.tsx
<TableCell>
  {lead.assignedCloser ? (
    <MemberIdentity identity={lead.assignedCloser} />
  ) : (
    <span className="text-muted-foreground">Unassigned</span>
  )}
</TableCell>
```

**Step 4: Keep public context separate.**

```typescript
// Path: convex/leadCustomers/detailPayload.ts
// This authenticated workspace payload may include signed storage URLs.
// Public link portal payloads must use public initials-only helpers instead.
```

**Key implementation notes:**
- Do not introduce client-side broad roster lookups for customer or lead detail pages.
- Opportunity timelines should render actor identity only where the timeline already displays actor/user information.
- Preserve all existing detail route authorization and tenant checks.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/customers/queries.ts` | Modify | Add converter/closer/payment actor identities. |
| `app/workspace/customers/_components/customers-table.tsx` | Modify | Render converter identity. |
| `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` | Modify | Render detail identities. |
| `app/workspace/customers/[customerId]/_components/payment-history-table.tsx` | Modify | Render attributed closer identity. |
| `convex/leads/queries.ts` | Modify | Add closer/Slack/merge actor identities. |
| `app/workspace/leads/**/_components/*.tsx` | Modify | Render lead list/detail identities. |
| `convex/leadCustomers/detailPayload.ts` | Modify | Add unified view identity payloads. |
| `convex/lib/attribution/detailPayload.ts` | Modify | Add attribution identities. |
| `app/workspace/leads-customers/[leadId]/_components/*.tsx` | Modify | Render unified identities. |
| `convex/opportunities/queries.ts` | Modify | Add list/filter identities. |
| `convex/opportunities/detailQuery.ts` | Modify | Add detail/timeline identities. |
| `app/workspace/_components/pipeline/opportunities-table.tsx` | Modify | Render pipeline table identities. |
| `app/workspace/opportunities/**/_components/*.tsx` | Modify | Render opportunity identities. |

---

### 4F — Billing, Closer Detail, Meeting Comments, and Reminder Detail

**Type:** Full-Stack
**Parallelizable:** Yes — owns billing/closer/reminder detail areas and can run alongside 4B-4E.

**What:** Add identities to billing entered-by/reviewer/audit/Slack contributor rows, closer dashboard/detail labels, meeting comments, and admin reminder on-behalf displays.

**Why:** These surfaces are identity-heavy but operationally separate from the main reports and customer/lead routes.

**Where:**
- `convex/billing/enrichment.ts` (modify)
- `convex/billing/types.ts` (modify)
- `convex/billing/export.ts` (verify text-only)
- `app/workspace/billing/_components/billing-payment-summary.tsx` (modify)
- `app/workspace/billing/_components/billing-event-history.tsx` (modify)
- `app/workspace/billing/_components/slack-contributor-timeline.tsx` (modify)
- `convex/closer/meetingComments.ts` (modify)
- `app/workspace/closer/meetings/_components/comment-entry.tsx` (modify)
- `convex/pipeline/reminderDetail.ts` (modify)
- `app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-detail-page-client.tsx` (modify)
- `app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-outcome-action-bar.tsx` (modify)

**How:**

**Step 1: Add billing identity payloads while preserving exports.**

```typescript
// Path: convex/billing/enrichment.ts
return {
  ...summary,
  enteredBy: enteredByUser ? await userMemberIdentity(ctx, enteredByUser) : null,
  phoneCloser: phoneCloser ? await userMemberIdentity(ctx, phoneCloser) : null,
  reviewer: reviewer ? await userMemberIdentity(ctx, reviewer) : null,
  dmCloser: dmCloser ? await dmCloserMemberIdentity(ctx, dmCloser, linkedUser) : null,
};
```

**Step 2: Replace manual comment initials.**

```tsx
// Path: app/workspace/closer/meetings/_components/comment-entry.tsx
<MemberAvatar identity={comment.author} size="sm" />
```

**Step 3: Return assigned closer directly for admin reminder detail.**

```typescript
// Path: convex/pipeline/reminderDetail.ts
return {
  ...detail,
  assignedCloser: await userMemberIdentity(ctx, assignedCloser),
};
```

**Key implementation notes:**
- Billing export code must not receive image URLs or storage IDs.
- Meeting comments should keep `isOwn` behavior; avatar rendering should not change permissions.
- Admin reminder detail should avoid broad `listTeamMembers` just for display metadata.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/billing/enrichment.ts` | Modify | Add billing identity payloads. |
| `convex/billing/types.ts` | Modify | Add identity types. |
| `convex/billing/export.ts` | Verify | Keep exports text-only. |
| `app/workspace/billing/_components/billing-payment-summary.tsx` | Modify | Render billing identities. |
| `app/workspace/billing/_components/billing-event-history.tsx` | Modify | Render audit actor identities. |
| `app/workspace/billing/_components/slack-contributor-timeline.tsx` | Modify | Render Slack identities. |
| `convex/closer/meetingComments.ts` | Modify | Add author identity. |
| `app/workspace/closer/meetings/_components/comment-entry.tsx` | Modify | Replace manual initials circle. |
| `convex/pipeline/reminderDetail.ts` | Modify | Add assigned closer identity. |
| `app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-detail-page-client.tsx` | Modify | Render on-behalf identity. |
| `app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-outcome-action-bar.tsx` | Modify | Render assigned closer identity. |

---

### 4G — Settings Attribution and Public Portal Privacy

**Type:** Full-Stack
**Parallelizable:** Yes — owns settings attribution and public DM portal routes; coordinate only on `convex/attribution/dmClosers.ts` from Phase 1E.

**What:** Add optional CRM user linking UI for DM closers in settings, render linked/unlinked DM closer identities in authenticated settings/report surfaces, and keep public portal choices initials-only.

**Why:** DM closer linking is useful for authenticated reports, but public pages should not expose CRM profile images or emails without explicit product approval.

**Where:**
- `convex/attribution/dmClosers.ts` (modify)
- `app/workspace/settings/_components/attribution-tab.tsx` (modify)
- `app/workspace/settings/_components/dm-closer-dialog.tsx` (modify)
- `app/workspace/settings/_components/portal-usage-card.tsx` (modify)
- `app/workspace/reports/_components/report-attribution-filters.tsx` (modify)
- `convex/linkPortal/copyQueries.ts` (modify)
- `convex/linkPortal/portalQueries.ts` (modify)
- `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` (modify)

**How:**

**Step 1: Add linked-user select data to settings.**

```typescript
// Path: convex/attribution/dmClosers.ts
return {
  ...dmCloser,
  identity: await dmCloserMemberIdentity(ctx, dmCloser, linkedUser),
  linkedUserId: linkedUser?._id ?? null,
};
```

**Step 2: Render and edit linked CRM user in the dialog.**

```tsx
// Path: app/workspace/settings/_components/dm-closer-dialog.tsx
<Select
  value={selectedUserId ?? "none"}
  onValueChange={(value) => setSelectedUserId(value === "none" ? null : value)}
>
  {/* SelectItem rows may use MemberIdentityOption if height remains stable. */}
</Select>
```

**Step 3: Keep public portal identities initials-only.**

```typescript
// Path: convex/linkPortal/portalQueries.ts
return {
  ...dmCloser,
  identity: publicDmCloserIdentity(dmCloser),
};
```

```tsx
// Path: app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx
<MemberIdentity identity={row.identity} />
```

**Key implementation notes:**
- Public portal payloads must not include `email`, WorkOS `profilePictureUrl`, Slack `avatarUrl`, or Convex signed URLs.
- Authenticated copy activity can use linked-user identity; public bootstrap cannot.
- Validate linked `userId` tenant ownership on every write, even if the UI options are tenant-scoped.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/attribution/dmClosers.ts` | Modify | Add authenticated linked identity payloads. |
| `app/workspace/settings/_components/attribution-tab.tsx` | Modify | Render DM closer identities. |
| `app/workspace/settings/_components/dm-closer-dialog.tsx` | Modify | Select/clear linked CRM user. |
| `app/workspace/settings/_components/portal-usage-card.tsx` | Modify | Render authenticated copy activity identity. |
| `app/workspace/reports/_components/report-attribution-filters.tsx` | Modify | Render stable DM closer filter identities if layout allows. |
| `convex/linkPortal/copyQueries.ts` | Modify | Authenticated copy activity identity. |
| `convex/linkPortal/portalQueries.ts` | Modify | Public initials-only identity. |
| `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` | Modify | Render initials-only choices. |

---

### 4H — Cross-Surface Rollout QA

**Type:** Manual / Full-Stack
**Parallelizable:** No — this gate verifies the parallel streams together after merge.

**What:** Run static checks, targeted searches, role QA, privacy checks, and responsive UI verification.

**Why:** The risk in Phase 4 is not one component; it is inconsistent rollout across many surfaces and accidental public exposure.

**Where:**
- `app/workspace/**` (verify)
- `app/dm-links/**` (verify)
- `convex/**` (verify)

**How:**

**Step 1: Static validation.**

```bash
# Path: terminal
pnpm exec convex codegen
pnpm tsc --noEmit
rg "AvatarFallback|AvatarImage|rounded-full.*[A-Z]" app/workspace app/dm-links
```

**Step 2: Privacy validation.**

```bash
# Path: terminal
rg "profilePictureUrl|customProfilePictureStorageId|avatarUrl|email" convex/linkPortal app/dm-links
```

**Step 3: Manual route matrix.**

```bash
# Path: terminal
# Verify as owner/admin:
# /workspace, /workspace/team, /workspace/reports/team,
# /workspace/reports/activity, /workspace/reports/pipeline,
# /workspace/reports/revenue, /workspace/reports/reminders,
# /workspace/reports/slack-qualifications, /workspace/operations,
# /workspace/lead-gen, /workspace/customers, /workspace/leads,
# /workspace/leads-customers, /workspace/opportunities,
# /workspace/billing, /workspace/settings
#
# Verify as closer:
# /workspace/closer, /workspace/closer/pipeline, meeting comments
#
# Verify as lead_generator:
# /workspace/lead-gen/capture, /workspace/lead-gen/my-activity
#
# Verify public:
# /dm-links/[portalSlug]
```

**Key implementation notes:**
- Broken image fallback should show initials, not a blank circle.
- Mobile tables/cards must not overlap identity rows.
- Any route requiring a broad query solely for avatars should be treated as a regression and moved to backend enrichment.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/team-member-avatars/phases/phase4.md` | Reference | QA matrix and rollout ownership. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/_components/workspace-auth.tsx` | Modify | 4A |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | 4A |
| `convex/users/queries.ts` | Modify | 4A |
| `app/workspace/team/_components/team-members-table.tsx` | Modify | 4A |
| `app/workspace/team/_components/*-dialog.tsx` | Modify | 4A |
| `app/workspace/team/_components/recent-reassignments.tsx` | Modify | 4A |
| `convex/unavailability/queries.ts` | Modify | 4A |
| `convex/unavailability/shared.ts` | Modify | 4A |
| `app/workspace/team/redistribute/[unavailabilityId]/_components/redistribute-wizard-page-client.tsx` | Modify | 4A |
| `convex/dashboard/overviewTypes.ts` | Modify | 4B |
| `convex/dashboard/overviewLeadGen.ts` | Modify | 4B |
| `convex/dashboard/overviewOperations.ts` | Modify | 4B |
| `app/workspace/_components/lead-gen-overview-card.tsx` | Modify | 4B |
| `app/workspace/_components/top-dm-closers-card.tsx` | Modify | 4B |
| `app/workspace/_components/phone-closer-operations-table.tsx` | Modify | 4B |
| `app/workspace/_components/top-qualifiers-card.tsx` | Modify | 4B |
| `app/workspace/_components/slack-user-leaderboard-card.tsx` | Modify | 4B |
| `app/workspace/_components/setter-contribution-table.tsx` | Modify | 4B |
| `convex/operations/scheduling.ts` | Modify | 4B |
| `convex/operations/phoneSales.ts` | Modify | 4B |
| `convex/operations/qualifications.ts` | Modify | 4B |
| `app/workspace/operations/_components/*.tsx` | Modify | 4B |
| `convex/reporting/lib/helpers.ts` | Modify | 4C |
| `convex/reporting/teamPerformance.ts` | Modify | 4C |
| `convex/reporting/teamOutcomes.ts` | Modify | 4C |
| `convex/reporting/teamActions.ts` | Modify | 4C |
| `convex/reporting/leadConversion.ts` | Modify | 4C |
| `convex/reporting/revenue.ts` | Modify | 4C |
| `convex/reporting/remindersReporting.ts` | Modify | 4C |
| `convex/reporting/activityFeed.ts` | Modify | 4C |
| `convex/reporting/pipelineHealth.ts` | Modify | 4C |
| `app/workspace/reports/**/_components/*.tsx` | Modify | 4C |
| `convex/leadGen/reporting.ts` | Modify | 4D |
| `convex/leadGen/reportBuilders.ts` | Modify | 4D |
| `convex/leadGen/exports.ts` | Verify | 4D |
| `app/workspace/lead-gen/_components/*.tsx` | Modify | 4D |
| `convex/customers/queries.ts` | Modify | 4E |
| `app/workspace/customers/**/_components/*.tsx` | Modify | 4E |
| `convex/leads/queries.ts` | Modify | 4E |
| `app/workspace/leads/**/_components/*.tsx` | Modify | 4E |
| `convex/leadCustomers/detailPayload.ts` | Modify | 4E |
| `convex/lib/attribution/detailPayload.ts` | Modify | 4E |
| `app/workspace/leads-customers/[leadId]/_components/*.tsx` | Modify | 4E |
| `convex/opportunities/queries.ts` | Modify | 4E |
| `convex/opportunities/detailQuery.ts` | Modify | 4E |
| `app/workspace/_components/pipeline/opportunities-table.tsx` | Modify | 4E |
| `app/workspace/opportunities/**/_components/*.tsx` | Modify | 4E |
| `convex/billing/enrichment.ts` | Modify | 4F |
| `convex/billing/types.ts` | Modify | 4F |
| `convex/billing/export.ts` | Verify | 4F |
| `app/workspace/billing/_components/*.tsx` | Modify | 4F |
| `convex/closer/meetingComments.ts` | Modify | 4F |
| `app/workspace/closer/meetings/_components/comment-entry.tsx` | Modify | 4F |
| `convex/pipeline/reminderDetail.ts` | Modify | 4F |
| `app/workspace/pipeline/reminders/[followUpId]/_components/*.tsx` | Modify | 4F |
| `convex/attribution/dmClosers.ts` | Modify | 4G |
| `app/workspace/settings/_components/*.tsx` | Modify | 4G |
| `app/workspace/reports/_components/report-attribution-filters.tsx` | Modify | 4G |
| `convex/linkPortal/copyQueries.ts` | Modify | 4G |
| `convex/linkPortal/portalQueries.ts` | Modify | 4G |
| `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` | Modify | 4G |
| `plans/team-member-avatars/phases/phase4.md` | Reference | 4H |
