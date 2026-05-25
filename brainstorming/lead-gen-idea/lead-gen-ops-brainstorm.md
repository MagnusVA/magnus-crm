# Lead Gen Ops Brainstorm

> Date: 2026-05-25
> Status: Brainstorm / pre-plan
> Inputs: `leads_form.html`, `leads_dashboard.html`, `handoff.md`, current CRM architecture, and the prior discussion about keeping lead generation signal separate from qualified CRM leads.
> Note: `handoff.md` is the original mock creator's handoff notes for how the two prototype files are intended to be used.

## One-Line Recommendation

Build this inside the existing CRM as a separate **Lead Gen Ops** module, not as rows in the existing `leads` and `opportunities` funnel. The module should be mobile-first for lead-gen workers, provide a strong full desktop experience for admins and reporting, use real WorkOS users with explicit roles/permissions, and give tenant admins a dedicated Lead Gen Ops section for configuration and accurate reporting. Social-handle matching to CRM leads/opportunities can exist for auditability, but not as a reporting or conversion metric.

## Why This Exists

DM lead generators work at a much higher volume than setters and closers. A single generator may start 100-200 conversations per day, and multiple generators can be active for one tenant. That volume is operationally important for accountability and compensation, but it is not the same thing as a qualified CRM lead.

The current CRM funnel should continue to start at the first high-signal point:

```text
qualified Slack submission or Calendly booking -> lead/opportunity -> meeting -> outcome/revenue
```

Lead generation is a lower-signal operational layer before that:

```text
social post/profile scanned -> contact attempt submitted -> repeated attempts aggregated -> operational reporting
```

The system needs to support both layers without making CRM conversion rates meaningless.

## What The Prototype Proves

The prototype is not only a visual mock. It captures a practical workflow that the team already understands.

The creator handoff is clear about the intended split:

| File | Intended audience | Purpose |
| --- | --- | --- |
| `leads_form.html` | VAs / lead-gen workers | Open this to log leads quickly. |
| `leads_dashboard.html` | Manager / admin | Full analytics view for performance, posts, teams, and reports. |

The handoff also clarifies that both files currently sync only through browser `localStorage`, so they must be opened in the same browser on the same computer to share data in real time. Production should replace that local storage model with tenant-scoped server data.

### Entry Form

File: `brainstorming/lead-gen-idea/leads_form.html`

The form supports:

| Area | Prototype behavior |
| --- | --- |
| Worker identity | Prototype uses self-selection from a name list; production should remove this because the authenticated WorkOS user is already known. |
| Source | Toggle between `Instagram` and `Meta Business`. |
| Instagram flow | Paste Instagram profile link, auto-detect username, optionally paste post/reel link or a keyword source. |
| Meta Business flow | Enter username only; profile URL is generated as `https://instagram.com/{username}`. |
| Timestamp | Date is automatic, plus a millisecond timestamp in storage. |
| Daily feedback | Shows "you have X leads added today" for the current user. |
| Admin setup | PIN-gated user management, team assignment, and scheduled hours per day. |
| Usability | Prototype includes English/Spanish labels and light/dark mode; production should be English-only unless tenant demand changes. |

The actual stored lead object is lightweight:

```ts
{
  user: "@username",
  profile: "https://instagram.com/username",
  post: "https://instagram.com/p/...",
  date: "05/25/2026",
  ts: Date.now(),
  addedBy: "Worker name",
  source: "instagram" // or "meta"
}
```

Configuration is also lightweight:

```text
ig_users      -> worker names
ig_teams      -> worker name -> team name
ig_schedules  -> worker name -> scheduled hours by weekday
ig_leads      -> submitted lead-gen rows
```

### Dashboard

File: `brainstorming/lead-gen-idea/leads_dashboard.html`

The dashboard supports:

| Tab | Prototype behavior |
| --- | --- |
| IG Posts | Counts Instagram leads, unique posts, best post, top post/reel rankings, and team breakdown. |
| VAs | Counts leads by worker, split by Instagram and Meta, with per-worker detail views. |
| All leads | Raw row list with filters for worker, team, and source. |
| Report | Preview and download an HTML report with summary cards, team totals, worker totals, top posts, and recent lead detail. |

Filtering exists for:

- Last 24 hours
- Last 48 hours
- Last week
- All time
- Custom date range
- Team
- Worker
- Source

The prototype also calculates productivity against scheduled hours:

```text
leads per hour = submitted rows / scheduled hours in selected date range
```

The handoff notes one important analytics rule: if a worker types `Follower`, `Application`, or `Story Poll` in the post link field, the lead is counted in general lead totals but excluded from the IG Posts ranking.

### Important Prototype Limitation

The current prototype uses browser `localStorage` and a hardcoded admin PIN. That is good for shaping workflow, but not acceptable for production compensation or auditability.

Production requirements need server-side identity, tenant-scoped records, append-only audit where possible, and role-aware admin access.

The prototype's name picker and language toggle should not carry forward into the production workflow. The worker is already identified through WorkOS, and the product target is English-only for now.

## Product Decisions

These are no longer open questions:

- **Mobile-first is mandatory for workers, desktop-first is expected for admin.** The lead capture experience is primarily for workers operating from phones while moving through social media, so the worker flow should be designed from a narrow viewport first. The admin/reporting experience should be primarily desktop-oriented, with room for dense tables, comparison, exports, and review workflows. Mobile support for admin is a plus, not a core requirement.
- **Lead-gen workers are real WorkOS users.** Workers should not self-select a name from a shared list in production. Every submitted row must be attributable to the authenticated WorkOS user.
- **Lead-gen access requires explicit role/permission coverage.** Lead generators need permission to create and view their own lead-gen activity, but they should not automatically receive closer/admin CRM access.
- **Admins get a Lead Gen Ops section.** Tenant owners/admins need configuration, worker/team management, schedules, dedupe/review tools, and accurate reporting in one admin-facing area.
- **English-only for MVP.** The production UI does not need internationalization or a language toggle.
- **No action/state machine for MVP.** A worker submission is a contact attempt. If the same prospect is submitted again by the same or another worker, aggregate it onto the existing prospect and increment attempt counts.
- **No prospect-to-lead handoff workflow or reporting.** Lead-gen prospects should not be promoted into CRM leads, and they should not become a funnel stage that reports conversion to qualified leads, booked meetings, or revenue. That metric will trend toward 0% and create signal noise.
- **CRM matching is audit-only.** Matching a lead-gen prospect to a later CRM lead/opportunity by social handle, mainly Instagram, is useful for traceability. It should not feed Lead Gen Ops reporting, compensation, or funnel conversion metrics.

## Product Boundary

The key product distinction:

> A lead-gen record is not a CRM lead.

Use separate language and separate data:

| Concept | Meaning | Existing CRM entity? |
| --- | --- | --- |
| Lead-gen prospect | A social profile/post that a generator contacted or marked as a possible prospect. | No |
| Lead-gen submission | A worker-submitted contact attempt against a prospect. | No |
| Audit match | Optional social-handle match from a lead-gen prospect to an existing CRM lead/opportunity for traceability only. | Audit bridge only |
| Qualified lead | A lead submitted through Slack qualification or created through Calendly. | Yes |
| Opportunity | The qualified sales pipeline object. | Yes |

This keeps the CRM pipeline clean while still allowing audit traceability when a CRM lead/opportunity happens to share a social handle with prior lead-gen activity.

## Proposed In-App Architecture

Add a new module inside this app:

```text
/workspace/lead-gen
  Admin Lead Gen Ops section for tenant owners/admins:
  configuration, worker/team setup, schedules, reporting, exports, dedupe/review

/workspace/lead-gen/capture
  Mobile-first fast entry surface for authenticated lead-gen workers

/workspace/lead-gen/my-activity
  Worker-facing personal activity, today count, recent submissions, and basic corrections
```

The implementation should follow the existing app direction:

- Tenant-scoped Convex tables.
- Indexed/paginated reads.
- Separate reporting projections and daily aggregates.
- No writes into `leads` or `opportunities` until a real qualification or booking happens.
- Admin views inside the workspace shell under Lead Gen Ops.
- A mobile-first worker entry experience with production-grade identity.
- A full desktop admin/reporting experience for configuration, analysis, exports, and review.
- WorkOS-backed users and permissions for both worker capture and admin reporting/configuration.

### Mobile-First Worker UX And Desktop-First Admin UX

The worker capture flow should optimize for one-handed, repeated entry:

- Large tap targets and no dense desktop tables.
- Minimal fields on the first screen.
- No worker picker; derive worker identity from the authenticated session.
- Sticky submit action.
- Fast reset after submit.
- Today counter visible after every save.
- Source switcher for Instagram vs. Meta Business.
- Native mobile keyboard hints for handles and URLs.
- English-only labels and validation messages.
- Offline/poor-connection handling should be considered after the server-backed MVP, because this workflow may happen while workers are moving quickly through social apps.

The admin Lead Gen Ops section should be desktop-first and use the extra room well:

- Dense but readable reporting tables.
- Side-by-side worker, team, source, and post/reel comparisons.
- Filter bars that stay efficient with many workers and teams.
- Export/report controls that are easy to review before downloading.
- Correction and dedupe review flows optimized for desktop.
- Optional mobile usability for quick admin checks, without compromising the desktop workflow.

### Roles And Permissions

Add a dedicated lead-gen worker access level instead of overloading the existing `closer` role.

Tentative role/permission shape:

| Role | Intended access |
| --- | --- |
| `tenant_master` | Full Lead Gen Ops configuration, reporting, correction, and export. |
| `tenant_admin` | Full Lead Gen Ops configuration, reporting, correction, and export. |
| `lead_generator` | Mobile capture, own activity, own correction window, no CRM pipeline access by default. |

Tentative permissions:

| Permission | Roles |
| --- | --- |
| `lead-gen:capture` | `lead_generator`, `tenant_master`, `tenant_admin` |
| `lead-gen:view-own` | `lead_generator`, `tenant_master`, `tenant_admin` |
| `lead-gen:view-all` | `tenant_master`, `tenant_admin` |
| `lead-gen:manage-workers` | `tenant_master`, `tenant_admin` |
| `lead-gen:manage-config` | `tenant_master`, `tenant_admin` |
| `lead-gen:correct` | `tenant_master`, `tenant_admin` |
| `lead-gen:export` | `tenant_master`, `tenant_admin` |

If implemented by extending `users.role`, this is a schema and RBAC migration and should use the `convex-migration-helper` process. The WorkOS RBAC slug could be `lead-generator`, mapped to CRM role `lead_generator` alongside the existing role mapping.

## Suggested Data Model

Names are tentative.

### `leadGenWorkers`

Represents the person doing outreach. In production this should be backed by a real tenant-scoped CRM `users` row and WorkOS user.

```ts
{
  tenantId,
  userId,
  workosUserId,
  displayName,
  teamId?,
  isActive,
  createdAt,
  updatedAt
}
```

Useful indexes:

- `by_tenantId`
- `by_tenantId_and_userId`
- `by_tenantId_and_isActive`
- `by_tenantId_and_teamId`

### `leadGenTeams`

Groups workers for reporting and management.

```ts
{
  tenantId,
  name,
  isActive,
  createdAt,
  updatedAt
}
```

### `leadGenWorkerSchedules`

Stores scheduled capacity for productivity metrics.

```ts
{
  tenantId,
  workerId,
  weekday,
  scheduledHours,
  updatedAt
}
```

This mirrors the prototype's per-day scheduled hours, but moves it out of local storage.

### `leadGenProspects`

One row per unique social prospect candidate, deduped by tenant/source/handle where possible. If another lead generator submits the same prospect, do not create a new prospect row; increment the aggregate attempt counters and update the latest submission metadata.

```ts
{
  tenantId,
  normalizedHandle,
  rawHandle,
  profileUrl,
  source: "instagram" | "meta_business",
  firstCapturedByWorkerId,
  firstCapturedAt,
  lastSubmittedByWorkerId,
  lastSubmittedAt,
  contactAttemptCount,
  distinctWorkerCount,
  latestOriginKind?,
  latestOriginUrl?,
  latestOriginLabel?,
  latestActivityAt,
  auditMatchedLeadId?,
  auditMatchedOpportunityId?,
  auditMatchedAt?,
  auditMatchedVia?: "social_handle",
  createdAt,
  updatedAt
}
```

### `leadGenSubmissions`

Append-only worker submission rows for audit, compensation, and per-worker reporting. This is not a state machine and does not need an action selector in MVP; one submission means "this worker submitted this prospect/contact attempt."

```ts
{
  tenantId,
  prospectId,
  workerId,
  teamId?,
  source: "instagram" | "meta_business",
  originKind: "post" | "reel" | "story_poll" | "follower" | "application" | "meta_business" | "other",
  originUrl?,
  originLabel?,
  submittedAt,
  createdAt
}
```

This table can grow quickly, so reads should be date-bounded and admin dashboards should use projections/aggregates. On every insert, the matching `leadGenProspects` row should update aggregate counters such as `contactAttemptCount`, `distinctWorkerCount`, and latest submission fields.

### `leadGenDailyStats`

Pre-aggregated reporting counters by tenant/day/worker/team/source.

```ts
{
  tenantId,
  dayKey,
  workerId,
  teamId?,
  source,
  submissions,
  uniqueProspectsSubmitted,
  duplicateProspectSubmissions,
  scheduledHours,
  updatedAt
}
```

This lets the dashboard stay fast even with thousands of submissions per day.

## Audit Matching To Existing CRM Records

MVP does not need a separate handoff state machine, and it does not need a prospect-to-lead promotion workflow. When a CRM lead or opportunity later contains a social handle identifier, mainly Instagram, the backend can optionally search `leadGenProspects` by tenant/source/normalized handle and store an audit-only match if there is a clear match.

Example:

```text
1. Lead generator submits @somecoach as a lead-gen prospect.
2. Later, a setter uses Slack /qualify-lead and enters @somecoach.
3. Slack qualification creates/links the normal CRM lead and opportunity.
4. Lead Gen Ops records an audit-only match from @somecoach to that CRM lead/opportunity.
5. Reports still count only the original lead-gen submissions/attempts, not a prospect -> qualified conversion.
```

If multiple lead-gen workers submitted the same prospect, the prospect already carries aggregate attempt counts. Audit views can show that a CRM lead/opportunity had prior lead-gen activity, but that should not become a Lead Gen Ops conversion rate.

If matching is ambiguous, leave it unmatched or defer correction to a simple admin audit review tool. Do not add requested/accepted/rejected handoff states in MVP.

This audit link must not drive:

- Lead Gen Ops conversion reporting.
- Worker compensation.
- Pipeline conversion rates.
- Qualified lead, booked meeting, or revenue attribution.

## Reporting Model

Do not blend lead-gen volume into pipeline conversion rates.

Recommended reporting layers:

| Layer | Metrics |
| --- | --- |
| Lead Gen Ops | submissions, unique prospects, duplicate prospect submissions, contact attempt count, top posts, worker totals, team totals, leads/hour |
| Audit Views | optional social-handle matches to CRM leads/opportunities for traceability only |

Lead Gen Ops reporting should stop at operational activity. It should not report prospect-to-qualified, prospect-to-booked, or prospect-to-won conversion rates.

## Compensation Considerations

Because compensation is involved, the production version needs stronger rules than the prototype.

Recommended principles:

- Payable raw activity should be based on server-side records, not local browser data.
- A worker should not be able to impersonate another worker; worker attribution is derived from the authenticated WorkOS session.
- Duplicates should be visible and handled consistently.
- Admins need correction tools, but corrections should leave an audit trail.
- Compensation reports should distinguish quantity from quality.

Possible payable metrics:

| Metric | Pros | Risk |
| --- | --- | --- |
| Submissions/contact attempts | Simple and close to the current prototype. | Incentivizes low-quality volume. |
| Unique prospects contacted | Reduces duplicate spam. | Still does not prove quality. |
| Duplicate attempt visibility | Shows when the same prospect was contacted multiple times. | Needs clear business rules for who gets credit. |
| Weighted model | Balances volume and quality. | More complex to explain. |

A pragmatic starting point is to track all of these, but initially pay from the existing business rule while the data is validated.

## MVP Scope

### Include

- Lead-gen worker/team setup.
- Mobile-first fast add form based on the prototype.
- Full desktop admin/reporting experience.
- Real WorkOS user identity for every worker.
- Lead-gen role and permission coverage.
- No self-select worker list in production capture.
- English-only UI for MVP.
- Instagram and Meta Business sources.
- Auto timestamping.
- Post/reel/profile URL capture.
- Source keywords such as follower, application, story poll.
- Prospect dedupe by tenant/source/normalized handle.
- Repeated submissions against the same prospect increment aggregate attempt counts.
- Optional audit-only social-handle matching to existing CRM leads/opportunities.
- Admin Lead Gen Ops dashboard with 24h, 48h, week, all, and date range filters.
- Admin configuration for workers, teams, schedules, and report/export settings.
- Worker, team, source, and top-post reporting.
- Scheduled hours and leads/hour.
- Exportable report.
- Tenant-scoped server storage.

### Exclude For MVP

- Creating CRM `leads` on every lead-gen entry.
- Creating CRM `opportunities` on every lead-gen entry.
- Social media scraping.
- Browser extension capture.
- Automated DM sending.
- Full compensation automation.
- Explicit handoff state machine.
- Prospect-to-qualified/booked/won conversion reporting.
- Using audit matches as a reporting or compensation signal.
- Complex duplicate resolution UI beyond basic admin review.

## Phased Plan

### Phase 0: Preserve Prototype Learnings

- Keep the prototype files as reference.
- Use this document to align product boundaries.
- Decide the exact WorkOS RBAC slug and CRM role/permission names for lead-gen workers.

### Phase 1: Productionize The Prototype As Lead Gen Ops

- Add tenant-scoped worker/team/schedule tables.
- Add mobile-first worker capture.
- Add admin Lead Gen Ops configuration and reporting dashboard.
- Add daily aggregate writes for fast reporting.
- Keep all records out of core CRM `leads` and `opportunities`.

### Phase 2: Add Audit Matching

- Match CRM social handles, mainly Instagram, to recent lead-gen prospects where the match is clear.
- Show audit-only prior lead-gen activity on relevant CRM lead/opportunity detail surfaces.
- Keep audit matches out of Lead Gen Ops reporting, compensation, and pipeline conversion metrics.
- Add admin correction only if ambiguous or wrong matches become a real support issue.

### Phase 3: Improve Reporting Accuracy

- Refine aggregate reporting around submissions, unique prospects, duplicates, teams, sources, posts/reels, and leads/hour.
- Validate compensation exports against real manager workflows.
- Keep CRM outcome data out of Lead Gen Ops reporting.

### Phase 4: Improve Capture Ergonomics

- Refine the mobile capture flow from real worker usage.
- Consider a browser extension or share-sheet style capture if manual copy/paste becomes the bottleneck.
- Consider retention policies for raw submissions once aggregates are stable.

## Security And Access Notes

The prototype's self-select identity is useful for speed, but production should use WorkOS-backed users only.

Admin PINs should not ship. Admin actions should use existing tenant admin/owner authorization.

Lead-gen workers should only be able to create and inspect their own lead-gen activity unless they also have an admin role. Backend Convex functions must derive the user and tenant from auth, not from client-submitted worker IDs.

## Open Questions

1. What exactly qualifies a row for compensation?
2. When multiple workers submit the same prospect, who gets compensation credit: first submitter, latest submitter, all submitters, or weighted credit?
3. Is Meta Business just another capture source for Instagram profiles, or should it have its own first-class platform identity?
4. How long should raw lead-gen submissions be retained?
5. Should post/reel ranking be tenant-wide, team-level, or worker-level by default?
6. What is the exact WorkOS role slug and CRM role name: `lead-generator`, `lead_gen_worker`, or `lead_generator`?

## Decision To Make Next

The next architectural decision is the exact RBAC contract:

```text
What WorkOS role slug, CRM role name, and permission set should define a lead-gen worker?
```

That choice affects schema migration, WorkOS role mapping, route access, Convex guards, navigation, and compensation auditability.
