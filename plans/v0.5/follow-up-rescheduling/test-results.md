# Follow-Up & Rescheduling — Test Results

**Date:** 2026-04-10
**Tester:** Codex
**Method:** Convex CLI validation first, then Expect browser verification
**Environment:** local app at `http://localhost:3000`, Convex dev deployment `cautious-donkey-511`
**Status:** Partial run completed

## Summary

This run verified the deployment state, schema surface, seeded data, and part of the admin Team-page flow. The closer meeting-detail flow is currently blocked by a reproducible UI regression: on real eligible meeting pages, the expected OutcomeActionBar actions are absent, including `Schedule Follow-up`.

Because that entry point is missing, the main follow-up dialog cases could not be executed from the UI:

- TC-A: blocked
- TC-B: blocked
- TC-C: blocked
- TC-D: blocked
- TC-F: blocked
- TC-G/H/J: not started in this pass

Admin Team-page coverage was partially completed:

- TC-E1: passed
- TC-E4: passed
- TC-E2/E3/E5: not executed yet to avoid mutating closer2 before the blocked closer-path cases can be resumed

## Backend Validation

### Passed

- App reachable: `curl -I http://localhost:3000` returned `HTTP/1.1 200 OK`.
- Known user state verified in `npx convex data users`:
  - `closer1` has `personalEventTypeUri = "https://calendly.com/vas-claudio15-closer1/closer-1-meeting"`.
  - `closer2` still has no `personalEventTypeUri`.
- `npx convex data followUps --limit 5` returned no documents. This is consistent with no v0.5 follow-up flow having been created yet in this environment.
- `npx convex data opportunities --limit 20` confirmed usable seeded data:
  - `k979nsw9s2ebenydhzz235xkcn84j9x0` assigned to `closer1` is `in_progress`.
  - multiple `closer2` opportunities exist in `scheduled`.
- `npx convex data meetings --limit 20` confirmed meeting records exist for both closers.
- `npx convex data rawWebhookEvents --limit 5` confirmed recent `invitee.created` events were received and `processed = true`.
- `npx convex data leads --limit 10` confirmed lead records match recent webhook payloads.
- Permission code checks passed in [convex/lib/permissions.ts](/Users/nimbus/dev/ptdom-crm/convex/lib/permissions.ts):
  - line 13: `team:assign-event-type`
  - line 14: `follow-up:create`
  - line 15: `follow-up:complete`
- Public function registration partially verified:
  - `closer/followUpQueries:getActiveReminders` reached `requireTenantUser` and failed with `Not authenticated`, which confirms the function exists and is auth-gated.
  - `createSchedulingLinkFollowUp`, `createManualReminderFollowUpPublic`, and `markReminderComplete` all failed validator checks for placeholder IDs before auth. This confirms they are registered, but the exact auth-failure expectation in the test plan was not met because the validator rejects invalid IDs first.

### Evidence

- `testing/calendly:listEventTypes` returned 1 active event type:
  - `Closer-1-Meeting`
  - `https://calendly.com/vas-claudio15-closer1/closer-1-meeting`
  - `https://api.calendly.com/event_types/3c31d0a5-3613-40d0-91c9-e7fc5a724b0c`
- Bounded Convex log sample from `npx convex logs --history 20 --jsonl | head -n 40` showed successful admin/team queries and no immediate pipeline errors during the observed sample.

## Browser Verification

## TC-A / TC-B / TC-C / TC-D / TC-F

### Result: Blocked by defect

I signed in as `vas.claudio15+closer1@icloud.com` and opened two separate eligible meeting detail pages:

- `/workspace/closer/meetings/k570qfk3t8c7gr6dq9b0zcmp5184kjpa`
- `/workspace/closer/meetings/k57d42eqcte4hvs4qgs6s3t1q984cw1j`

Observed behavior on both pages:

- no `Schedule Follow-up` button
- no `Log Payment` button
- no `Mark as Lost` button
- only breadcrumb, back button, lead info, attribution, outcome select, and notes were present

This blocks:

- TC-A path selection dialog coverage
- TC-B scheduling-link happy path and error path
- TC-C reminder creation and validation
- TC-D dashboard reminder rendering, because no reminder can be created through the intended UI
- TC-F deterministic UTM relinking setup, because no scheduling-link follow-up can be created first

### Defect

**Severity:** high

**Description:** The OutcomeActionBar does not render its action buttons on eligible closer meeting-detail pages, preventing access to the follow-up workflow entirely.

**Reproduction:**

1. Sign in as `vas.claudio15+closer1@icloud.com`
2. Open `/workspace/closer/meetings/k570qfk3t8c7gr6dq9b0zcmp5184kjpa`
3. Observe that `Schedule Follow-up` is absent despite the related opportunity being `in_progress`

## TC-E: Personal Event Type Assignment (Admin)

### TC-E1: Passed

Verified on `/workspace/team` as `vas.claudio15+tenantowner@icloud.com`:

- `Personal Event Type` column is present
- `closer1` row shows `https://calendly.com/vas-claudio15-closer1/closer-1-meeting`
- `closer2` row shows `Not assigned`
- owner row shows `—`

### TC-E4: Passed

Opened `Assign Personal Event Type` for `closer2` and verified validation messages:

- empty submit: `Event type URL is required`
- `not-a-url`: `Must be a valid URL`
- `https://google.com/calendar`: `Must be a Calendly booking page URL (e.g., https://calendly.com/your-name/30min)`

Dialog was closed without saving, so `closer2` remains unassigned for future reruns.

### TC-E2 / TC-E3 / TC-E5

Not executed in this pass.

Reason:

- I intentionally did not mutate `closer2` yet, because the test plan requires preserving the no-event-type state until TC-B3 is complete.
- Since TC-B3 is currently blocked by the missing closer meeting actions, assigning the URL now would destroy that pending test precondition.

## Browser QA Signals

### Console

`console_logs(type='error')` returned repeated CSP report-only messages:

- `The Content Security Policy directive 'upgrade-insecure-requests' is ignored when delivered in a report-only policy.`

No app-specific runtime exception surfaced during the tested pages.

### Accessibility

`accessibility_audit` on the Team page returned 10 serious issues. Notable app-side findings included:

- visible-label issues on icon-only controls such as the sidebar toggle, theme toggle, and notifications button
- invalid `aria-controls` IDs on Radix-triggered controls
- invalid `role="presentation"` usage on a breadcrumb separator `<li>`

Some audit noise appears to come from the Expect overlay itself, but several findings clearly point to app markup.

### Performance

`performance_metrics` on the Team page:

- FCP: 400ms, good
- LCP: 1372ms, good
- CLS: 0.004, good
- INP: 600ms, poor

This fails the Expect performance gate due to poor INP.

## Next Recommended Order

1. Fix the missing OutcomeActionBar actions on closer meeting-detail pages.
2. Re-run TC-A through TC-D in order.
3. Run TC-B3 before any assignment mutation for `closer2`.
4. After TC-B3, continue with TC-E2 and TC-E3.
5. Use the created scheduling-link follow-up to run TC-F.
6. Finish remaining authorization, responsive, accessibility, and performance cases.
