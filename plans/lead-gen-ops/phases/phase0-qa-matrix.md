# Lead Gen Ops QA Matrix

This matrix protects the new Lead Gen Ops flows and the existing CRM, Slack,
and Calendly behavior. QA should use a narrow mobile viewport for worker
capture and a desktop viewport for admin reporting.

## Seed Requirements

- One active tenant owner or tenant admin.
- One active closer with a Calendly member assignment.
- Two lead-generator users: one active, one pending invitation.
- Two Lead Gen teams.
- Worker schedules for at least two weekdays.
- One new Instagram prospect submitted by one worker.
- One shared normalized Instagram handle submitted by both workers.
- One Meta Business prospect.
- One origin label that begins with `=`, `+`, `-`, or `@` for CSV hardening.
- One Slack-qualified lead with a matching Instagram handle.
- One cold Calendly booking whose form fields contain the same handle to prove no Lead Gen lookup occurs.

## Auth and Routing

| Scenario | Expected Result | Evidence |
|---|---|---|
| `tenant_master` opens `/workspace` | Admin dashboard renders. | Page load succeeds; sidebar uses admin nav. |
| `tenant_admin` opens `/workspace` | Admin dashboard renders. | Page load succeeds; sidebar uses admin nav. |
| `closer` opens `/workspace` | Redirects to `/workspace/closer`. | Final URL and page title. |
| `lead_generator` opens `/workspace` | Redirects to `/workspace/lead-gen/capture`. | Final URL and page title. |
| `lead_generator` opens `/workspace/pipeline` or other admin route | Server redirects to capture or denies access. | Final URL and no protected data response. |
| `lead_generator` opens `/workspace/closer/pipeline` | Server redirects to capture or denies access. | Final URL and no closer data response. |
| `lead_generator` calls admin Convex function directly | Convex rejects with insufficient permissions. | Function error in client/dev logs. |
| `lead_generator` opens command palette | Only Lead Gen pages/actions are visible. | No opportunity, customer, payment, or invite actions. |
| `lead_generator` presses Cmd+1-4 | Shortcuts navigate within Lead Gen nav only. | Final URLs. |

## WorkOS and Role Lifecycle

| Scenario | Expected Result | Evidence |
|---|---|---|
| Admin invites `lead_generator` | WorkOS invitation uses role slug `lead-generator`; CRM user row is pending; worker profile is created inactive or pending as designed. | WorkOS invitation record and Convex rows. |
| Admin invites `lead_generator` without Calendly member | Invite succeeds. | No Calendly validation error. |
| Admin invites `closer` without Calendly member | Existing validation still blocks submit. | Inline Calendly member error. |
| Pending invite changes from `closer` to `lead_generator` | Old invitation revoked if present; new invitation uses `lead-generator`; worker profile is synced. | WorkOS invitation ID changes; Convex role/profile state. |
| Active closer changes to `lead_generator` | WorkOS membership role updates by membership ID; CRM role changes; closer stats decrement; worker profile activates. | WorkOS membership and Convex rows. |
| Active lead generator changes away from `lead_generator` | Worker profile deactivates; historical submissions remain. | Worker profile and submission rows. |
| Lead generator is removed | WorkOS membership/invitation is removed or revoked; CRM user soft-deletes; worker profile deactivates; submissions remain. | Convex rows and WorkOS membership. |

## Capture and Dedupe

| Scenario | Expected Result | Evidence |
|---|---|---|
| Worker submits new Instagram handle | New `leadGenProspects` and `leadGenSubmissions`; no CRM lead/opportunity. | Convex rows and `rg` write gate. |
| Worker submits Meta Business source | Submission records source distinctly for reporting. | Submission row source. |
| Worker submits malformed/empty handle | Inline validation blocks submit. | Field error near handle input. |
| Worker retries with same `clientSubmissionKey` | Existing submission returned; counters unchanged. | Same submission ID and aggregate totals. |
| Two workers submit same normalized handle | One prospect, two submissions, distinct worker count increments. | Prospect and submission rows. |
| Duplicate handle submitted from different source | Existing prospect updates latest source; source remains on each submission. | Prospect and submission rows. |
| Capture is tested on mobile width | Form is usable without horizontal scroll; controls fit; keyboard input modes are correct. | Browser screenshot. |

## Admin Reporting and Export

| Scenario | Expected Result | Evidence |
|---|---|---|
| Admin opens `/workspace/lead-gen` | Desktop admin dashboard renders and uses aggregate queries. | Page load and Convex query logs. |
| Admin filters by date range | URL reflects filter state; totals update. | URL query params and visible totals. |
| Admin filters across multiple sources | Scheduled hours are deduped by `(workerId, dayKey)`. | Reconciled total against schedules. |
| Admin views worker/team breakdown | Worker and team totals match daily aggregate rows. | Manual aggregate comparison. |
| Admin exports summary CSV | Export is date-bounded and formula-hardened. | CSV file content. |
| Formula-like origin label is exported | Cell is escaped so spreadsheet apps do not execute it. | CSV cell begins with safe prefix/escaping. |
| Large raw export exceeds safe threshold | UI requires confirmation or refuses with clear next step. | Dialog/error state. |

## Slack Regression

| Scenario | Expected Result | Evidence |
|---|---|---|
| Slack qualifies a new handle with prior Lead Gen prospect | Existing Slack success behavior remains; audit match is scheduled after success. | Slack response and audit row. |
| Slack duplicate-pending qualification with prior prospect | Existing duplicate response remains; audit match is reused or created for the existing qualified opportunity if allowed. | Slack response and audit row. |
| Slack already-booked qualification with prior prospect | Existing already-booked behavior remains; no accepted Lead Gen audit match is created by default. | Slack response and audit rows. |
| Slack qualification has no matching prospect | Existing behavior remains; no audit match row. | Slack response and audit rows. |

## Calendly Regression

| Scenario | Expected Result | Evidence |
|---|---|---|
| Calendly schedules a Slack-qualified opportunity with existing accepted audit match | Opportunity transitions to scheduled; existing audit match is preserved/updated. | Opportunity, meeting, audit rows. |
| Calendly cold booking matches a Lead Gen prospect handle | Existing cold-booking behavior; no Lead Gen prospect lookup or audit match. | No audit row and no `leadGenProspects` query in code path. |
| Calendly follow-up booking reuses follow-up opportunity | Existing follow-up behavior remains. | Opportunity/meeting rows. |
| Calendly auto-reschedule branch runs | Existing reschedule behavior remains. | Opportunity/meeting rows. |
| Duplicate Calendly webhook arrives | Existing duplicate handling marks processed without duplicate meeting. | Raw event and meeting count. |

## Accessibility and UI

| Scenario | Expected Result | Evidence |
|---|---|---|
| Capture form labels are clicked | Corresponding controls receive focus. | Browser interaction. |
| Capture validation fails | Errors are inline and announced politely where practical. | DOM inspection. |
| Icon-only controls are used | Each has `aria-label`. | DOM inspection. |
| Motion is reduced in OS/browser setting | Non-essential animation is disabled or reduced. | Browser setting check. |
| Long handles/origin labels render | Text truncates or wraps without layout overflow. | Mobile and desktop screenshots. |
| Empty report data range is selected | Empty state renders instead of broken table/card. | Page screenshot. |

## Static Verification Commands

Run these before each phase gate:

```bash
rg "ctx\\.db\\.(insert|patch|replace)\\(\\\"(leads|opportunities)\\\"" convex/leadGen
rg "leadGenProspects" convex/pipeline/inviteeCreated.ts
rg "leadGen" convex/slack convex/pipeline
pnpm tsc --noEmit
```

Expected:

- No Lead Gen capture writes to `leads` or `opportunities`.
- No `leadGenProspects` reference inside `convex/pipeline/inviteeCreated.ts`.
- Slack/Calendly `leadGen` references are limited to the approved Phase 4 hooks.
- TypeScript passes.
