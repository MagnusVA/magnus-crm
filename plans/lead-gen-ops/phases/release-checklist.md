# Lead Gen Ops Release Checklist

This is the Phase 5F release gate for the Lead Gen Ops MVP. Do not expose real
lead-gen workers in production until every required item is checked or an
explicit exception is recorded with an owner and rollback decision.

## Preflight

- [ ] Phase 0 guardrails are still accepted: Lead Gen capture does not create
      CRM `leads` or `opportunities`, Slack changes are post-success audit only,
      and Calendly never searches Lead Gen prospects for cold bookings.
- [ ] Phase 0 migration notes still classify the rollout as widen-only:
      `users.role` is widened, new `leadGen*` tables exist, and no production
      backfill or required existing-field change is included.
- [ ] No escalation trigger from `phase0-migration-notes.md` is present. If an
      escalation trigger appears, stop and use the `convex-migration-helper`
      widen-migrate-narrow workflow before production rollout.
- [ ] WorkOS production has an environment-level role named Lead Generator with
      slug `lead-generator`.
- [ ] WorkOS dev has the same `lead-generator` role and has already been used
      for invite and role-change QA.
- [ ] Operators understand that active WorkOS role updates require the
      organization membership ID, not the WorkOS user ID.
- [ ] If IdP group role mapping is enabled, release notes state that WorkOS API
      or Dashboard role changes may be overwritten on next login.
- [ ] A production test tenant owner/admin account is available.
- [ ] A production test `lead_generator` account is available or can be invited
      after route safety checks pass.
- [ ] One active closer with Calendly assignment remains available for existing
      Calendly and Slack regression checks.
- [ ] Seed data exists for one Instagram prospect, one duplicate normalized
      handle, one Meta Business prospect, and one formula-like origin label
      beginning with `=`, `+`, `-`, or `@`.
- [ ] No real workers are invited until route, command palette, keyboard
      shortcut, export, Slack, and Calendly smoke checks pass on the test tenant.

## Automated Checks

Run these on the release branch before production deploy:

```bash
npx convex dev --once
pnpm tsc --noEmit
pnpm lint
```

Required static verification:

```bash
rg "ctx\\.db\\.(insert|patch|replace)\\(\\\"(leads|opportunities)\\\"" convex/leadGen
rg "leadGenProspects" convex/pipeline/inviteeCreated.ts
rg "leadGen" convex/slack convex/pipeline
rg "args: \\{[^}]*tenantId" convex/leadGen
rg "requireTenantUser" convex/leadGen
rg "lead_generator|lead-generator|lead-gen" app components convex lib
```

Expected results:

- [ ] `convex/leadGen` has no writes to `leads` or `opportunities`.
- [ ] `convex/pipeline/inviteeCreated.ts` has no `leadGenProspects` lookup.
- [ ] Slack Lead Gen references are limited to the approved
      `convex/slack/createQualifiedLead.ts` audit scheduling hook.
- [ ] Calendly Lead Gen references are limited to preserving an existing
      accepted audit match when an already Slack-qualified opportunity schedules.
- [ ] Public Lead Gen functions do not accept client-supplied `tenantId`.
- [ ] Public Lead Gen functions derive tenant/user context through
      `requireTenantUser()`.
- [ ] TypeScript, lint, and Convex startup/codegen checks pass.

## Manual Smoke

The release operator should run these manually in a browser. Use the test tenant
before any real worker rollout.

- [ ] Tenant owner/admin opens `/workspace` and sees the admin workspace, not a
      Lead Gen worker fallback.
- [ ] Tenant owner/admin opens `/workspace/lead-gen` and sees the Lead Gen admin
      dashboard.
- [ ] Tenant owner/admin opens `/workspace/lead-gen/capture` and can submit as
      self if admin capture is enabled.
- [ ] Lead generator opens `/workspace` and is redirected to
      `/workspace/lead-gen/capture`.
- [ ] Lead generator can open `/workspace/lead-gen/capture` and
      `/workspace/lead-gen/my-activity`.
- [ ] Lead generator probing admin workspace URLs is redirected or denied by
      server route gates.
- [ ] Lead generator probing closer workspace URLs is redirected or denied by
      server route gates.
- [ ] Closer cannot open Lead Gen capture, reporting, correction, or export
      routes.
- [ ] System admin still routes to `/admin`, not workspace Lead Gen routes.
- [ ] Lead generator command palette shows only Lead Gen safe pages/actions.
- [ ] Lead generator keyboard shortcuts navigate within the Lead Gen nav set
      only.
- [ ] Profile and sign-out remain available to lead generators.
- [ ] User should manually check mobile capture at about 390px width: no
      horizontal scroll, no overlapping controls, labels focus the matching
      inputs, and the submit action remains reachable.
- [ ] User should manually check desktop admin at about 1440px width: filters,
      metric summaries, tables, dialogs, and empty states fit without text
      overlap.
- [ ] User should manually check tablet admin at about 1024px width: tables
      remain usable, with intentional overflow where needed.
- [ ] User should manually check loading and empty states: skeleton dimensions
      match final content and empty states do not imply setup failure.

## Capture And Reporting Checks

- [ ] New Instagram capture creates one `leadGenProspects` row and one
      `leadGenSubmissions` row.
- [ ] New capture does not create or patch CRM `leads` or `opportunities`.
- [ ] Same worker submitting the same normalized handle creates a new
      submission, reuses the prospect, increments duplicate count, and does not
      increment distinct worker count.
- [ ] Different worker submitting the same normalized handle reuses the
      prospect and increments distinct worker count.
- [ ] Same `clientSubmissionKey` retry returns the existing submission and does
      not change counters.
- [ ] Meta Business capture records source distinctly for reporting.
- [ ] Dashboard totals reconcile to aggregate rows for the selected date range.
- [ ] Worker/team/source filters update dashboard totals.
- [ ] Scheduled hours are deduped by `(workerId, dayKey)` when aggregating
      across multiple sources.
- [ ] Dashboard reads aggregate tables for default views, not unbounded raw
      submission scans.
- [ ] Empty report ranges render an empty state instead of a broken table or
      misleading zero-data error.

## Slack And Calendly Regression

Slack regression:

- [ ] Slack qualifying a new handle with a prior Lead Gen prospect keeps the
      existing Slack success behavior and creates an accepted audit match after
      qualification.
- [ ] Slack duplicate-pending qualification keeps the existing duplicate
      response behavior and reuses or creates the accepted audit match for the
      existing qualified opportunity.
- [ ] Slack already-booked qualification keeps existing already-booked behavior
      and does not create an accepted Lead Gen audit match by default.
- [ ] Slack qualification without a matching Lead Gen prospect keeps existing
      behavior and creates no audit match.
- [ ] Slack modal shape, slash command, callback ID, and ACK timing are
      unchanged.

Calendly regression:

- [ ] Calendly scheduling a Slack-qualified opportunity with an existing
      accepted audit match transitions the opportunity as before and preserves
      or fills the match `opportunityId`.
- [ ] Calendly scheduling a Slack-qualified opportunity without an existing
      audit match transitions the opportunity as before and creates no Lead Gen
      audit match.
- [ ] Calendly cold booking with a matching social handle follows existing cold
      booking behavior and creates no Lead Gen audit match.
- [ ] Calendly cold booking without a matching social handle follows existing
      cold booking behavior.
- [ ] Calendly follow-up booking reuse still works.
- [ ] Calendly auto-reschedule branch still works.
- [ ] Duplicate Calendly webhook handling still avoids duplicate meetings.
- [ ] No Calendly OAuth, webhook registration, signature verification, raw event
      storage, or broad processor ordering changed for this feature.

## Correction And Export Checks

- [ ] Admin can void a submission only with a required reason.
- [ ] Voiding sets `voidedAt`, `voidedByUserId`, and `voidReason`; it does not
      delete the raw submission.
- [ ] Voiding inserts a `leadGenCorrectionEvents` row with before/after
      snapshots and correcting user ID.
- [ ] Worker direct calls to correction mutations are rejected.
- [ ] Closer direct calls to correction mutations are rejected.
- [ ] Correction UI consistently says "void", not "delete".
- [ ] Correction row actions are keyboard reachable and not hover-only.
- [ ] Aggregate reverse deltas update reportable totals in the same transaction,
      or the affected bounded range is marked for reconciliation.
- [ ] Reconciliation repair, if implemented, is bounded by tenant/date range and
      does not use unbounded `.collect()`.
- [ ] Summary CSV export is date-bounded.
- [ ] Worker CSV export is date-bounded.
- [ ] Raw submissions CSV export is date-bounded and paginated or guarded by a
      row-limit confirmation/refusal.
- [ ] Formula-like values beginning with `=`, `+`, `-`, `@`, tab, or carriage
      return are hardened in CSV output.
- [ ] CSV quoting handles commas, quotes, CR/LF, and line breaks.
- [ ] Export hardening is applied during serialization only; raw Convex values
      remain unchanged for audit display.
- [ ] `lead_generator` users cannot access raw export queries or export UI.

## Production Rollout

- [ ] Deploy schema/code widen before exposing invite UI for Lead Generator.
- [ ] Confirm production Convex deployment starts successfully after the schema
      widen.
- [ ] Confirm production WorkOS `lead-generator` role exists before inviting or
      changing any user to `lead_generator`.
- [ ] Keep Lead Generator invite/role-edit UI hidden or unused until production
      test tenant smoke passes.
- [ ] Run production smoke with the one test tenant.
- [ ] Invite or role-change only the test lead-generator account first.
- [ ] Ask the test lead-generator account to sign out and sign back in after any
      active role change so session claims are refreshed.
- [ ] Verify test lead-generator capture, my-activity, command palette, and
      route fallback in production.
- [ ] Verify admin dashboard, correction dialog, and export smoke in production.
- [ ] Run one Slack qualification regression against the test tenant.
- [ ] Run one Calendly cold-booking regression against the test tenant.
- [ ] Run one Calendly Slack-qualified scheduling regression against the test
      tenant if seed data is available.
- [ ] After production smoke passes, invite a small first batch of real workers.
- [ ] Monitor Convex logs for `[LeadGen]`, `[Pipeline]`, `[Calendly]`, `[Slack]`,
      and `[Auth]` errors during the first worker session.
- [ ] Monitor dashboard aggregate totals against raw submissions during the
      first production day.
- [ ] Keep a named owner available for backout decisions during the first
      production day.

## Backout

Prefer disabling surfaces and hooks over destructive schema or data changes.
Lead Gen tables with data at rest should remain deployed unless a separate
migration plan is approved.

- [ ] If WorkOS `lead-generator` role is missing or misconfigured, stop rollout,
      hide or avoid Lead Generator invite/role-edit options, create/fix the role,
      then retry with the test tenant.
- [ ] If route safety fails, hide or stop using Lead Generator invite/role-edit
      options and deactivate test worker profiles until route fallback is fixed.
- [ ] If capture creates CRM funnel records, stop release immediately, disable
      capture UI/routes, and repair any unintended CRM rows through a separate
      reviewed data plan.
- [ ] If Slack regression appears, remove or guard the Lead Gen audit scheduling
      hook while preserving existing Slack qualification behavior.
- [ ] If Calendly regression appears, remove or guard the audit-match
      preservation call while preserving existing Calendly scheduling behavior.
- [ ] If reports or exports are wrong, hide admin reporting/export navigation and
      keep capture disabled until aggregate reconciliation is fixed.
- [ ] If CSV hardening fails, disable exports before allowing production worker
      data to accumulate.
- [ ] If correction deltas are wrong, disable correction UI/mutations and mark
      affected date ranges for bounded reconciliation.
- [ ] Deactivate worker profiles instead of deleting users or submissions.
- [ ] Do not auto-convert existing closers as a rollback tactic.
- [ ] Do not delete `leadGen*` tables or remove schema fields containing
      production data without a migration plan.

## Known MVP Limitations

- Lead Gen Ops does not create CRM `leads` or `opportunities`.
- Lead Gen Ops is not a CRM funnel stage.
- Lead Gen activity does not count as CRM conversion reporting.
- Audit matches are traceability only and do not imply compensation.
- Cold Calendly bookings never search Lead Gen prospects and never create Lead
      Gen audit matches.
- Calendly only preserves an audit match that Slack qualification already
      created.
- Slack `/qualify-lead` remains the only qualification entry point for audit
      matching.
- Workers cannot edit saved submissions unless a later product decision adds a
      bounded, audited edit window.
- Admin voiding excludes a submission from reporting but preserves raw history.
- Offline-first capture, background sync, social scraping, automated DM sending,
      mobile share-sheet integrations, and platform API enrichment are not in
      MVP.
- Payout automation and compensation approval workflows are deferred to a
      separate compensation design.
- Multilingual production UI is deferred; MVP UI is English-only.
- Candidate/ambiguous audit-match review is optional and must not affect
      reporting if not implemented.
- Large raw exports are intentionally bounded; operators should narrow the date
      range instead of bypassing row limits.
