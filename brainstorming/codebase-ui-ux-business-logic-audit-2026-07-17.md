# Whole-codebase UI/UX and business-logic audit

**Audit date:** 2026-07-17  
**Repository snapshot:** `main` at `42c4303d9577e96241726bb1b86c1cdf24d5ca88`, plus the working tree as found  
**Working-tree note:** 55 paths were already modified, added, deleted, or untracked when this audit began. Current attribution, settings, schedule, command-palette, breadcrumb, and Slack work is therefore included in this snapshot but may not represent a committed release.  
**Audit mode:** Read-only source and static-analysis review. This document is the only file created by the audit. No application code, schema, data, configuration, dependencies, or external systems were changed.

## Executive conclusion

The product has a stronger foundation than its inconsistency count initially suggests: tenant-aware backend guards exist, inbound Calendly signatures are verified, the workspace has a semantic shell and skip link, most forms use shared primitives, operational queries are generally bounded, and several destructive workflows have good confirmations.

The main risk is **split authority**. Important concepts are defined more than once and have drifted:

- authentication policy versus mutation authorization;
- tenant lifecycle state versus routing/recovery UX;
- opportunity, meeting, payment, and customer state transitions;
- dashboard, report, closer, and Slack definitions of business time;
- route navigation, breadcrumbs, keyboard shortcuts, and command-palette metadata;
- status/payment labels and their visual presentation;
- integration state in Convex versus WorkOS/Calendly side effects;
- bounded operational reads versus UI claims that totals are complete.

This is not only polish debt. The review found immediate security and data-integrity blockers, followed by a larger group of recoverability and semantic-trust problems. The most urgent work is:

1. Remove or authorize public maintenance mutations.
2. Bind owner creation to the validated invite and intended recipient.
3. Repair the Calendly OAuth trust boundary and make reconnect atomic.
4. Reconcile backend role-update authorization with the declared owner-only policy.
5. Define a correct currency/accounting model or temporarily enforce one currency.
6. Turn partial follow-up, redistribution, and integration operations into durable, resumable workflows.
7. Consolidate route metadata, permissions, time windows, status language, and report completeness into shared contracts.

## How to read this report

- **[Verified]** means the behavior follows directly from current source.
- **[Consistency]** means current implementation conflicts with another current implementation, plan, or design-system rule.
- **[Hypothesis]** is a product/business idea that should be validated with users or production data before implementation.
- **P0** means fix or explicitly accept before the next production release.
- **P1** means high-impact correctness, recoverability, or workflow work for the next sprint.
- **P2** means meaningful UX/design-system improvement after correctness work.
- **P3** means cleanup or polish.

Line references identify the reviewed snapshot and will move as the working tree changes.

## Scope, method, and limitations

### Repository coverage

The repository-wide inventory covered:

| Area | Files found |
| --- | ---: |
| `app/` | 476 |
| `components/` | 70 |
| `hooks/` | 8 |
| `lib/` | 14 |
| `convex/` | 307 |
| `plans/**/*.md` | 383 |

The manual review concentrated on every live route family, shared workspace shell and UI primitives, auth/RBAC, tenant lifecycle, onboarding, Calendly and WorkOS integration paths, webhook ingestion and processing, leads/customers/opportunities, payments and reports, follow-ups, redistribution, Lead Gen, admin/support, active plans, and product/design documentation. Redirect-only legacy routes were reviewed as information-architecture aliases rather than as independent interfaces.

Static analysis scanned 878 JavaScript/TypeScript files. The UI rubric used the repository's design rules and the current [Vercel Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md).

### Limitations

- This was a code audit, not an authenticated browser QA session.
- No production Convex data, logs, PostHog funnels, WorkOS organization, Calendly account, Slack workspace, or real assistive technology was exercised.
- Responsive, visual, copy, and keyboard findings are source-grounded but still need device/browser validation.
- Security findings are static code findings, not a penetration test.
- Revenue impact depends on actual payment volume and currency usage; the code currently permits the risky states even if production data has not reached them.
- Static dead-code and duplication results are leads for cleanup, not proof that every flagged symbol is safe to remove.

## Strengths to preserve

1. **Tenant guard design.** `convex/requireTenantUser.ts:17-122` validates identity, CRM user activity, organization/tenant consistency, and role for the functions that use it.
2. **Webhook ingress boundary.** `convex/webhooks/calendly.ts:95-176` verifies signature and timestamp before parsing/persisting; `convex/webhooks/calendlyMutations.ts:5-50` persists raw events and schedules internal processing transactionally.
3. **Lead Gen capture safety.** `convex/leadGen/capture.ts:31-193` derives tenant/worker identity server-side and includes idempotent capture behavior.
4. **Payment write normalization.** `convex/lib/paymentHelpers.ts:22-59` centralizes important payment row invariants; the problem is aggregation/reversal semantics, not the absence of all structure.
5. **Semantic workspace shell.** The skip link and focus target in `app/workspace/_components/workspace-shell-frame.tsx:15-30` and `app/workspace/_components/workspace-shell-client.tsx:503-520`, plus the semantic `<main>` in `components/ui/sidebar.tsx:304-313`, are good foundations.
6. **Good mobile pattern in the entity browser.** Mobile entity results use real links with focus behavior in `app/workspace/leads-customers/_components/entity-result-mobile-card.tsx:29-33`.
7. **Good URL-state pattern already exists.** `app/workspace/_components/use-dashboard-range.ts:108-151` is a useful model for shareable filters.
8. **Lead Gen capture interaction quality.** The capture page has explicit labels, localized phone formatting, focus progression, mobile-sized primary controls, and guarded submission in `app/workspace/lead-gen/_components/lead-gen-capture-page-client.tsx:242-279,328-330,407-418,494-515`.
9. **Destructive reset pattern.** `app/admin/_components/reset-tenant-dialog.tsx:78-208` uses a strong explicit confirmation pattern worth standardizing.
10. **Some report truncation states are honest.** Reminders, pipeline, leads, activity, team, and booked-vs-sold surfaces expose at least some bounded-result warnings; this should become the universal contract.

---

## P0 — Release blockers

### SEC-01 — Public maintenance functions can write across tenants

**[Verified]** `convex/attribution/backfills.ts:63-238` exports `mutation(...)` functions, scans the first 100 tenants through `listTenantIds` at `:37-40`, and mutates meeting/opportunity attribution without any identity, tenant, role, or system-admin guard. `convex/leadGen/backfills.ts:180-314` explicitly declares a rollout backfill public and non-auth-gated; it can patch, merge, and delete operational rows.

Because these are public `mutation` exports rather than `internalMutation` exports, they are generated in the public Convex API, as the repo-local Convex guidance explains at `convex/_generated/ai/guidelines.md:79-84`. CLI convenience is not an authorization boundary.

**Impact:** An unauthenticated caller could trigger cross-tenant bulk writes. Limits reduce batch size, not authorization risk.

**Recommendation:** Immediately convert maintenance functions to `internalMutation`/`internalAction`, or require a system-admin session inside every handler. Remove public verification queries that expose cross-tenant operational shape. Add a static CI rule that rejects public Convex functions in `*backfill*`, `*migration*`, `*repair*`, and `*maintenance*` modules unless an allowlisted guard is present.

### SEC-02 — Any authenticated member of an organization can claim tenant ownership

**[Verified]** `convex/onboarding/complete.ts:12-146` accepts only `workosOrgId`, verifies that it matches the caller's organization claim, and then creates/uses a user, assigns or schedules the `tenant_master`/owner role, overwrites `tenantOwnerId`, and advances onboarding. It does not require the signed invite token, invite hash, intended email/recipient, `pending_signup` lifecycle, or absence of an existing owner. At `:88-101`, an existing globally found user can be moved from another tenant.

The stronger validation already exists separately in `convex/onboarding/invite.ts:9-81`, but successful validation is not bound to redemption.

**Impact:** A non-owner organization member can potentially become the CRM owner; an existing identity can be rehomed; an existing tenant owner can be replaced.

**Recommendation:** Make redemption one transaction that accepts the signed token, revalidates signature/hash/expiry/non-redemption, binds it to the intended recipient and tenant, requires `pending_signup`, requires no conflicting owner, creates a tenant membership, consumes the invite, and only then schedules the WorkOS role change. Add concurrent-redemption and wrong-recipient tests.

### SEC-03 — Calendly OAuth has unsafe failure mutation and an incomplete correlation/trust boundary

**[Verified]** `convex/calendly/oauth.ts:251-485` places authentication inside a `try`, but its `catch` always clears the tenant PKCE verifier and updates tenant status. An anonymous call that fails at `:265-270` therefore still reaches privileged internal mutations at `:473-479`. The same public action:

- accepts a caller-supplied `convexSiteUrl` at `:252-256`, which becomes the webhook callback at `convex/calendly/webhookSetup.ts:214-228`;
- authorizes a successful exchange by organization membership, not CRM admin permission, at `oauth.ts:293-297`;
- has no OAuth `state` correlation in the authorization URL at `oauth.ts:150-157`;
- stores one PKCE verifier on the tenant at `oauth.ts:119-129`, so concurrent flows can overwrite one another.

**Impact:** Tenant status/PKCE can be mutated on an unauthorized failure path. An authenticated organization member may be able to influence integration provisioning, and caller-controlled callback origins create a token/data-exposure risk.

**Recommendation:** Derive the callback base URL from trusted server configuration. Create a short-lived, single-use OAuth intent keyed by random `state`, actor, tenant, return target, PKCE verifier, expiry, and consumed timestamp. Require an owner/admin policy before creating and consuming the intent. Perform no tenant mutation until authentication, state, actor, tenant, and callback validation succeed. In the catch path, mutate only an already-authorized intent—not arbitrary tenant state.

### SEC-04 — Backend role updates do not enforce the declared owner-only policy

**[Verified/Consistency]** The canonical permission map says only `tenant_master` may perform `team:update-role` in `convex/lib/permissions.ts:1-5`, and the Team UI hides editing from tenant admins. However, `convex/workos/userManagement.ts:42-59,408-425` uses `requireAdminContext`, which permits both master and admin, for `updateUserRole`.

**Impact:** A tenant admin can call the action directly and change roles despite the product's owner-only rule.

**Recommendation:** Enforce `team:update-role` in the action using the same canonical permission policy. Generate UI visibility, route gates, and backend checks from one role/action matrix and contract-test every role/action pair.

### FIN-01 — The application permits currencies that its accounting model cannot aggregate correctly

**[Verified]** Payment forms permit USD, EUR, GBP, CAD, AUD, and JPY, while reporting sums raw `amountMinor` values without grouping or conversion in `convex/reporting/lib/helpers.ts:145-180`. Revenue details do return each row's currency at `convex/reporting/revenue.ts:270-290`, but `app/workspace/reports/revenue/_components/top-deals-table.tsx:30-48` drops the currency from its prop and hardcodes `$`. The same report's aggregate cards/charts receive currencyless totals.

`convex/lib/paymentHelpers.ts:86-109` also builds a customer's total from only 100 records, sums currencies together, and merely clears the currency label when multiple currencies exist. JPY and two-decimal currencies make even the minor-unit scale non-comparable.

**Impact:** Revenue, average deal size, customer lifetime value, leaderboards, and denominated displays can be mathematically false. After 100 payments, customer counts/totals can also be incomplete.

**Recommendation:** Make an explicit product decision before adding more reports:

- simplest near-term: one tenant base currency, enforce it on every write, and migrate existing rows;
- full model: store original amount/currency plus base amount/currency and an immutable FX rate/source/timestamp at recognition time, then aggregate base amounts while displaying originals where useful.

Until the model is implemented, reject unsupported/mixed-currency writes rather than presenting false totals. This is a significant schema/data change and requires a widen–migrate–narrow plan.

### INT-01 — Reconnect revokes the working Calendly connection before replacement succeeds

**[Verified]** `/api/calendly/start` calls `prepareReconnect` before redirecting to Calendly at `app/api/calendly/start/route.ts:58-69`. `convex/calendly/oauth.ts:169-248` revokes both current tokens, clears the connection, and marks the tenant `calendly_disconnected` before the user authorizes the replacement. Canceling, closing, or failing OAuth leaves a previously working tenant broken.

**Recommendation:** Use atomic replacement semantics: keep the current credential/webhook active while an OAuth intent is in flight, validate and provision the new credential, swap atomically, then revoke the old credential. Preserve an audit trail and rollback pointer.

---

## P1 — Correctness, recoverability, and semantic trust

### LIFE-01 — Seven tenant states collapse into one onboarding redirect

**[Verified]** Tenant states include `pending_signup`, `pending_calendly`, `provisioning_webhooks`, `active`, `calendly_disconnected`, `suspended`, and `invite_expired` in `convex/schema.ts:35-43`. `lib/auth.ts:128-163` maps every non-active state to `pending_onboarding`, and `app/workspace/_components/workspace-auth.tsx:15-22` redirects all of them to `/onboarding/connect`.

This makes status-specific recovery unreachable or misleading. A suspended user, expired invite, provisioning tenant, and disconnected integration do not have the same problem or permitted action.

**Recommendation:** Make lifecycle routing exhaustive. For every state define permitted surfaces, read-only access, primary CTA, retry/rollback, responsible role, and support escalation. Suggested destinations:

- `pending_signup` → invite acceptance;
- `invite_expired` → request/regenerate invite;
- `pending_calendly` → connect;
- `provisioning_webhooks` → progress plus safe retry;
- `calendly_disconnected` → workspace/integration repair;
- `suspended` → suspension explanation/contact path;
- `active` → workspace, with a separate readiness model.

### WF-01 — Follow-up link creation has an invisible partial-success state that blocks later work

**[Verified]** `app/workspace/closer/meetings/_components/follow-up-dialog.tsx:215-365` deliberately splits link creation and status confirmation to avoid a reactive unmount. `convex/closer/followUpMutations.ts:166-250` inserts a pending follow-up before status transition. The dialog remains dismissible; confirmation identifies the opportunity/meeting rather than a specific follow-up; on confirmation failure the UI closes anyway at `follow-up-dialog.tsx:283-295`. A pending follow-up can then block normal outcome actions while remaining absent from the manual-reminder dashboard.

`convex/lib/paymentHelpers.ts:117-147` contains an expiry helper, but no current call site was found.

**Recommendation:** Use one idempotent domain command if possible. If the human must copy before confirmation, model a durable workflow: `draft → link_created → shared/confirmed → booked/completed/canceled/expired`. Persist and resume by `followUpId`, show unfinished work, offer cancel/cleanup, and never close on failed confirmation without a recovery CTA.

### REDIST-01 — Redistribution mixes meeting-level choices with opportunity-level ownership

**[Verified]** The wizard selects and loops over meetings in `convex/unavailability/redistribution.ts:132-194,206-288`, but assignment changes the opportunity owner and `convex/lib/syncOpportunityMeetingsAssignedCloser.ts:5-25` then synchronizes all meetings. Selecting multiple meetings from one opportunity can record different intended assignees while the final write makes one closer own all. Canceling one meeting can cancel the whole opportunity at `redistribution.ts:424-440`.

Candidate loading also checks tenant and role but not `isActive`/`deletedAt` in `convex/unavailability/shared.ts:137-159`; the manual validator has the same omission in `convex/lib/unavailabilityValidation.ts:68-83`.

**Recommendation:** Decide the ownership invariant first: opportunity-owned or meeting-owned. Then make selection, audit rows, reassignment, and cancellation operate on that entity. Make a durable redistribution case with preview, idempotent apply, partial-failure reporting, resume, and rollback. Exclude inactive/deleted assignees at the shared validator.

### WEBHOOK-01 — Event deduplication cannot represent repeated lifecycle events

**[Verified]** Raw uniqueness is effectively tenant + event type + Calendly scheduled-event URI in `convex/schema.ts:420-437` and `convex/webhooks/calendlyMutations.ts:15-30`. The no-show processor supports created/deleted reversal, but a valid `created → deleted → created` sequence drops the second `created` as a duplicate.

The webhook subscription includes `routing_form_submission.created` in `convex/calendly/webhookSetup.ts:9-16`, while `convex/pipeline/processor.ts:69-127` has no handler and marks unknown events processed.

The raw record has only `processed: boolean`; parsing errors return without recording a reason, and handler failures do not persist attempt/error/next-retry metadata (`convex/pipeline/processor.ts:45-62,128-135`). `convex/operations/bookingHealth.ts:4-29` detects recent stuck invitee-created events, but the UI CTA points to attribution mappings rather than a webhook repair action in `app/workspace/operations/_components/operations-health-banner.tsx:24-38`.

**Recommendation:** Use provider delivery/event IDs when available, otherwise a canonical payload hash plus lifecycle occurrence. Track `received/processing/succeeded/retryable_failed/dead_lettered/ignored`, attempt count, error class, next retry, and processor version. Add replay from a safe operations/admin surface. Either implement routing-form events or remove the subscription.

### DATA-01 — Several bounded mutations silently finalize partial work

**[Verified]** Bounds are good for transaction safety, but these functions treat a cap as completion:

- customer payment summary: first 100 rows, `convex/lib/paymentHelpers.ts:86-109`;
- customer rollback: inspects/detaches only the first 100 payments, `paymentHelpers.ts:149-188`;
- lead merge: caps related opportunities/identifiers/notes/search rows/duplicate refs, then marks the source merged, `convex/leads/merge.ts:130-201,223-262,281-305`;
- conversion backfill: 100 opportunities × 50 payments, `convex/customers/conversion.ts:162-196`;
- opportunity status propagation: first 200 meetings, `convex/reporting/writeHooks.ts:87-110`;
- sold-program cache: first 100 rows, `convex/lib/soldProgramCache.ts:101-109`.

**Impact:** Denormalized summaries, search/report projections, and referential cleanup can become silently stale at realistic long-term cardinalities.

**Recommendation:** For domain invariants, query `limit + 1` and fail loudly before partial finalization. For legitimate bulk work, persist a job/cursor and schedule bounded continuation until completion. Only mark source state final after all pages succeed. Add reconciliation queries.

### WORKOS-01 — External WorkOS writes and Convex state can split

**[Verified]** Invitation/membership changes happen before CRM mutations in `convex/workos/userManagement.ts:264-346,495-523,539-620`; a later failure can leave external authorization different from Convex. Pending-invite reuse resends without reliably reconciling the requested role; the role slug is applied on new invitations at `:363-390`.

**Recommendation:** Treat identity-provider changes as a saga/outbox: persist an intended operation and idempotency key, apply WorkOS, confirm/reconcile local state, surface retries, and periodically detect drift. Revoke/reissue an existing pending invitation when its role differs.

### REPORT-01 — Some bounded reports signal incompleteness to code but not to users

**[Verified]** Payment reporting caps a scan at 2,500 rows in `convex/reporting/lib/helpers.ts:15,186-207`. Revenue queries return `isPaymentDataTruncated` at `convex/reporting/revenue.ts:179,293`, but `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx:88-230` never renders that flag. Other report pages expose truncation inconsistently.

**Impact:** A report can present precise-looking totals that are known to be incomplete.

**Recommendation:** Create one report-result contract: `data`, `completeness`, `scannedThrough`, `rowCap`, and recommended narrowing action. Put a shared completeness banner above every affected metric, export, and chart. Longer term, use aggregate tables for totals and bounded detail queries for rows.

### REPORT-02 — “Today,” “This week,” and pipeline periods do not mean the same thing

**[Verified]** The overview uses a Honduras 01:00 cutoff and ISO Monday in `app/workspace/_components/dashboard-date-utils.ts:8-30`. Reports use viewer-local midnight and date-fns' default Sunday week in `app/workspace/reports/_components/report-date-controls.tsx:45-95`. Closer dashboard sections mix local ranges/week conventions. Slack stale reminders fire at 08:00 New York in `convex/slack/staleReminders.ts:31-46`. The tenant schema has no canonical business timezone/week-start/cutoff configuration.

Pipeline periods also filter opportunity creation in `convex/closer/pipeline.ts:41-71`, while dashboard performance uses meeting scheduling/outcome windows in `convex/closer/dashboard.ts:140-203`.

**Recommendation:** Define a tenant business clock: IANA timezone, optional business-day cutoff, and week start. Server-side helpers should produce all date windows. For every metric, name the event clock—booked at, meeting scheduled at, outcome recorded at, payment recorded at, or revenue recognized at—and use the same definition across Dashboard, Pipeline, Reports, exports, and Slack.

### ADMIN-01 — System-admin totals are calculated from the current filtered page

**[Verified]** `app/admin/_components/admin-page-client.tsx:80-88` requests a paginated/filtered set of 25 tenants, then `:441-480` calculates “Total” and “Active” stats from those rows. Filters therefore alter cards labeled as global totals.

**Recommendation:** Query global aggregates independently and label the page result count separately, such as “38 total tenants · 7 matching this filter.”

### LEADGEN-01 — Voiding a submission does not fully reverse prospect-level state

**[Verified]** Capture updates submission, daily/origin/team, and prospect state in `convex/leadGen/capture.ts:122-153` and `convex/leadGen/aggregates.ts:621-715`. Correction/void logic in `convex/leadGen/corrections.ts:22-82` reverses several aggregates but not prospect attempt count, distinct workers, or latest-submission pointers. A prospect with only a voided submission can remain classified as a duplicate. The intended reconciliation is noted in `plans/lead-gen-ops/lead-gen-ops-design.md:1201`.

**Recommendation:** Make submission correction emit a domain event and recompute the affected prospect plus all derived aggregates from surviving source rows, or maintain a complete symmetric apply/revert contract with invariant tests.

### STATE-01 — “Terminal” statuses are reversible through paths outside the canonical transition model

**[Verified/Consistency]** `convex/lib/statusTransitions.ts:23-43,92-96` treats `payment_received`, `lost`, and converted states as terminal. Payment dispute/void paths can reverse them directly in `convex/sideDeals/voidPayment.ts:60-82` and `convex/lib/paymentHelpers.ts:187-207`. `convex/tenants.ts:122-147` also provides an internal status setter without an explicit transition graph.

**Recommendation:** Model reversal as a first-class command/event rather than an exception to the state machine. Centralize allowed tenant, opportunity, payment, follow-up, and customer transitions; require reason/actor/timestamp; rebuild projections from the domain event; and contract-test forbidden transitions.

### SUPPORT-01 — Support is a write-only queue rather than a support lifecycle

**[Verified]** `convex/support.ts:34-89` is a public unauthenticated write with length and honeypot controls but no rate limit, deduplication, or challenge. The system-admin support list is read-only at `app/admin/_components/support-tickets-section.tsx:25-34,74-115`.

**Recommendation:** Add rate limiting and deduplication immediately. Then model `new → triaged → assigned → waiting_on_customer → resolved`, with tenant/user context, response history, ownership, SLA timestamps, and deep links to relevant setup/health screens.

---

## UX and information-architecture audit

### Navigation, wayfinding, and state

| Priority | Finding | Evidence | Recommendation |
| --- | --- | --- | --- |
| P1 | **[Verified] Keyboard shortcuts disagree with navigation when Billing is enabled.** Sidebar insertion changes nav indexes, while the palette advertises fixed labels. | `app/workspace/_components/workspace-shell-client.tsx:148-174,356-376`; `components/command-palette.tsx:32-52,95-105` | One route/IA registry should own label, href, roles, feature flag, icon, breadcrumb, palette presence, and shortcut. Bind shortcuts by route ID, never array index. |
| P1 | **[Verified] Breadcrumbs emit literal `...` and omit live route vocabulary.** Reports, billing, revenue, activity, reminders, profile, and dynamic labels are not in the map. | `hooks/use-breadcrumbs.ts:15-76`; `components/workspace-breadcrumbs.tsx:24-32` | Generate breadcrumbs from the route registry and supply dynamic entity names. Do not render unresolved placeholders. |
| P1 | **[Verified] The global notification bell is a shipped placeholder.** It always uses an empty local array while its comment claims recent events. | `components/notification-center.tsx:11-32,66-69`; shell placement at `workspace-shell-client.tsx:508-512` | Hide it until it is real, or turn it into a role-aware operational inbox for readiness blockers, failed webhooks, disconnected integrations, incomplete follow-ups, and assignments. |
| P1 | **[Verified] Tenant recovery and support routes are missing from workspace wayfinding.** Error/recovery states often offer Home/sign-out or “contact support” without a support link. | `app/support/**`; workspace recovery/error components | Provide Help/Support in the user menu and contextual “Report this issue” links carrying tenant, route, correlation ID, and sanitized error class. |
| P2 | **[Verified] Report and Billing filters are local state, while Operations has shareable URL state.** Refresh/back/share behavior varies by module. | `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx:44-86`; `app/workspace/billing/_components/billing-page-client.tsx:63-70`; `app/workspace/_components/use-dashboard-range.ts:108-151` | Use one URL-state convention for filters. Include reset/default serialization and analytics derived from canonical state. |
| P2 | **[Verified] Settings tab links are one-way.** The page reads `?tab=` only as `defaultValue`, does not write it, and reconnect returns to Settings without restoring Integrations. | `app/workspace/settings/_components/settings-page-client.tsx:44-88`; `app/workspace/settings/_components/integrations/calendly-connection.tsx:155-165` | Make tabs controlled by the URL; return integration flows to `?tab=integrations` with an outcome status. |
| P2 | **[Verified] Opportunity sheet state is only half deep-linked.** It reads/removes a URL ID but ordinary opens remain local. | `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-context.tsx:27-62` | Make open/close canonical URL transitions so Back, refresh, and sharing work. |
| P2 | **[Verified] Entity search does not fully follow Back/Forward.** Local `query` initializes from `q` once; lifecycle has URL→state synchronization but query does not. | `app/workspace/leads-customers/_components/use-entity-browser-url-state.ts:27-73` | Make URL canonical or carefully synchronize URL changes without clobbering active typing. |
| P2 | **[Consistency] Canonical routes coexist with multiple redirect aliases.** | `app/workspace/opportunities`, `customers`, `leads`, `pipeline`, and new consolidated routes | Keep redirects for compatibility, but emit canonical analytics/page titles/breadcrumbs and stop linking to aliases internally. Track usage before removal. |

### Semantics and accessibility

| Priority | Finding | Evidence | Recommendation |
| --- | --- | --- | --- |
| P1 | **[Verified] Desktop entity rows are pointer-only.** A `<TableRow onClick>` cannot be focused and loses normal link actions; the mobile card is correct. | `app/workspace/leads-customers/_components/entity-result-row.tsx:24-36`; mobile comparison at `entity-result-mobile-card.tsx:29-33` | Put a real `<Link>` on the primary identity/open action. Keep the `<tr>` non-interactive. |
| P1 | **[Verified] Several visible labels are not programmatically associated, and one active switch is unnamed.** | Billing controls: `billing-page-client.tsx:124-188`; attribution dialog: `dm-closer-dialog.tsx:117-140,159-185`; Lead Gen settings: `lead-gen-settings-page-client.tsx:371-390,519-560,596-646`; `components/ui/field.tsx:101-115` | Use stable `id`/`htmlFor` or `aria-labelledby`. Give switches action-specific accessible names. |
| P1 | **[Verified] Shared title primitives erase hierarchy.** `CardTitle`, `EmptyTitle`, and `EmptyDescription` render as divs; some sections jump from page `h1` to nested `h3`. | `components/ui/card.tsx:36-46`; `components/ui/empty.tsx:58-80`; reminder funnel at `reminder-funnel-chart.tsx:38-68` | Add `asChild`/semantic-level support. Render descriptions as `<p>` and require page/section heading order. |
| P1 | **[Verified] Form/range errors are not announced consistently.** | `components/ui/form.tsx:160-180`; good comparison `components/ui/field.tsx:176-224`; `dashboard-date-range-filter.tsx:114-145` | Errors use `role="alert"`; non-error updates use `role="status"` or `aria-live="polite"`. Centralize in primitives. |
| P1 | **[Verified] Dialog primitives are not viewport-bounded.** Long forms can place actions beyond small viewports, zoomed layouts, or the on-screen keyboard. | `components/ui/dialog.tsx:50-84`; `components/ui/alert-dialog.tsx:47-66`; examples `weekly-schedule-dialog.tsx:115-199`, `billing/_components/correction-dialog.tsx:207` | Add a primitive contract using `100dvh`, scroll containment, safe-area padding, and preferably fixed header/footer with a scroll body. |
| P2 | **[Verified] Sort state is on the wrong ARIA element.** | `components/sortable-header.tsx:24-35` | Put `aria-sort` on `<th role="columnheader">`; make the nested button `type="button"` and include explicit sorted-state text. |
| P2 | **[Verified] Touch targets are systemically dense.** Shared buttons/selects/inputs expose 24–36px heights, while the Lead Gen capture page correctly overrides primary controls to 44px. | `components/ui/button.tsx:23-34`; `input.tsx:11`; `select.tsx:34-57`; good example `lead-gen-capture-page-client.tsx:407-418,494-515` | Preserve dense desktop visuals but create a minimum 44px effective target on coarse pointers and use `touch-manipulation`. |
| P2 | **[Verified] Loading semantics vary.** Some skeleton regions lack one status/label announcement. | Pipeline `pipeline-page-client.tsx:23-34,180-195`; calendar `calendar-view.tsx:86-126`; good report pattern `leads-report-skeleton.tsx:3-9` | Announce each loading region once with `role="status"` and a meaningful label, not every cell. |
| P2 | **[Verified] Native proof images lack explicit dimensions.** | `app/workspace/billing/_components/billing-proof-preview.tsx:116,171`; `app/workspace/closer/_components/deal-won-card.tsx:232,304` | Supply intrinsic dimensions/aspect ratio to prevent layout shift; use the image component where appropriate. |
| P3 | **[Verified] Help tooltip trigger imitates a button without activation behavior.** | `app/workspace/_components/overview-help-tooltip.tsx:30-48` | Use a real button with click/Enter/Space behavior and a larger target; do not put essential explanations only behind hover. |

### Visual and design-system consistency

1. **Page headers vary without a semantic reason.** Overview uses a 2xl semibold header with an accent/divider, Settings/Team/Pipeline use 3xl bold, Profile uses 2xl bold, and Lead Gen uses 2xl semibold. Representative evidence: `dashboard-page-client.tsx:47-54`, `settings-page-client.tsx:61-68`, `team-page-client.tsx:205-213`, `pipeline-page-client.tsx:143-151`, and `profile-page-client.tsx:73-80`.

   **Recommendation:** Introduce `WorkspacePageHeader` with title, description, eyebrow/accent, actions, and filter slots plus one responsive spacing/type contract.

2. **The written design system is stricter than both the code and its own examples.** `DESIGN_SYSTEM.md:143` says every status presentation is centralized; `:293` says never use raw Tailwind colors; `:297` says never use `space-*`; and `:299` requires motion-safe animation. Yet the document itself defines raw status palettes at `:149-155`. Source heuristics found raw color-family utilities in 41 UI files, `space-x/y` in 15, `transition-all` in 12, and explicit `motion-safe`/`motion-reduce` utilities in only 7.

   **Recommendation:** Replace absolute rules with a usable tiered policy:

   - structural UI uses semantic theme tokens;
   - status colors come from centralized status palettes;
   - charts/data visualization use a centralized accessible categorical palette;
   - arbitrary local colors are prohibited;
   - spacing utilities may be allowed only when they do not conflict with dynamic/conditional content;
   - transitions list intended properties and include reduced-motion behavior.

3. **Theme documentation disagrees with runtime.** `DESIGN_SYSTEM.md:301` says dark is default; `app/layout.tsx:83-87` sets light and disables system preference.

   **Recommendation:** Decide whether the product is light-default, system-default, or dark-default, then align docs, onboarding screenshots, `color-scheme`, and mobile browser `theme-color` metadata.

4. **Status/payment vocabulary drifts.** Payment type appears as “PIF,” “Paid in Full,” and “Paid in full.” A `recorded` payment appears as “Recorded” on opportunity surfaces and “Needs review” in Billing. Meeting badge maps are repeated despite the centralization rule, including `reminder-history-panel.tsx:25-39`, `meeting-overview-card.tsx:40-48`, and `meeting-info-panel.tsx:31-43`.

   **Recommendation:** Create a product glossary plus presentation registry. Separate domain state from task state: for example, `recorded` can be the payment state while `needs_review` is a billing-review state, not two labels for one field.

5. **Motion coverage is partial.** `transition-all` is embedded in shared Button, Toggle, Tabs, Sidebar, and ThemeToggle controls. `app/globals.css:267-295` disables named animations/view transitions, not all property transitions/transforms.

   **Recommendation:** Transition only the properties that need motion, keep durations short, and add primitive-level reduced-motion behavior.

6. **Mobile gutters can stack.** The shell adds unconditional `p-6` at `workspace-shell-client.tsx:514-520`; the consolidated entity page adds its own responsive horizontal padding at `leads-customers-page-client.tsx:22-30`.

   **Recommendation:** Define whether the shell or route owns page gutters. Use one responsive token such as `p-4 sm:p-6` and opt out explicitly for edge-to-edge modules.

7. **Empty-state language is inconsistent.** Title case, sentence case, and terminal punctuation are mixed across Reports, Leads & Customers, Lead Gen, Operations, and Billing.

   **Recommendation:** Use sentence case for UI headings, typically without a terminal period; reserve title case for proper product names.

### Process simplification and recoverability

| Priority | Current experience | Improvement |
| --- | --- | --- |
| P1 | Outcome actions disappear until a five-minute eligibility window, so the user cannot learn when/why. | Render disabled actions with the reason and countdown. Backend remains authoritative. Evidence: `app/workspace/closer/meetings/_components/outcome-action-bar.tsx:68-78`; `convex/lib/outcomeEligibility.ts:42-44`. |
| P1 | A closer without an active program or personal booking link receives a dead-end instruction to ask an admin. | Add “Notify owner” with context and a deep link; put the resulting task in the owner's operational inbox. |
| P1 | Removing a team member displays a hardcoded preflight result, while the backend can still reject the action. | Query the real dependency/preflight state and offer reassignment/remediation before removal. Evidence: `team-page-client.tsx:135-160`; `remove-user-dialog.tsx:70-102`; `convex/workos/userManagement.ts:554-565`. |
| P1 | Calendly maintenance exposes separate Refresh token, Sync members, Sync event types, and Reconnect operations. | Compute health and offer one safe **Repair** plan/result. Keep individual operations under Advanced. |
| P2 | “New Side Deal,” “Create opportunity,” and “New Opportunity” describe the same journey. | Choose one user term and one route title. If side deal is a distinct business case, explain the distinction and give it a purpose-built fast path. |
| P2 | The long new-opportunity form can be abandoned via Back/Cancel with no dirty-state warning. | Confirm only when the form is dirty; bypass after save. Evidence: `create-opportunity-page-client.tsx:159-172,233-242,534-541`. |
| P2 | Support submit is disabled before validation can explain incomplete fields. | Keep submit enabled except while in flight, mark required fields, validate on submit, and focus the first invalid control. Evidence: `app/support/_components/support-request-form.tsx:43-59,228-241`. |
| P2 | Team invite for a closer depends on a synced Calendly member, but the empty state offers no repair action. | Show sync status, “Sync members,” and exact unmet requirements in the dialog. |
| P2 | Onboarding says the workspace is ready immediately after Calendly, although programs, mappings, closer links, and assignments may still be absent. | Separate identity activation from operational readiness and lead the owner through next-best actions. |

---

## Business-logic improvement brainstorm

These are proposals, not all defects. Each should have an owner, decision record, success measure, and—where schema/data changes are involved—a migration plan.

### B1 — Operational-readiness graph

**[Hypothesis]** `active` should mean the user may enter the workspace, not that the sales operation is fully configured.

Model readiness checks independently: Calendly credential healthy, webhook healthy, members synced, event types mapped, at least one active program, closer booking links assigned, required attribution configured, optional Slack healthy. Return role-specific blockers and next actions. Owners get repair CTAs; closers get actionable escalation instead of impossible configuration links.

**First slice:** A read-only readiness query and shared banner/inbox—no automatic mutation.

### B2 — Durable workflow cases

**[Hypothesis]** Follow-up, redistribution, integration repair, bulk correction, and tenant provisioning are business processes, not transient dialogs.

Create a small workflow/job model with type, tenant, actor, state, current step, idempotency key, source snapshot, progress, error, retry, and audit timestamps. UI can resume or cancel safely. Use it only for multi-step operations; keep simple mutations simple.

### B3 — One authorization policy surface

**[Hypothesis]** A declarative permission registry should drive:

- backend mutation/action guards;
- RSC route gates;
- client affordance visibility;
- denial reason/help text;
- role/action contract tests.

The backend remains the authority. Generated UI metadata reduces drift but never replaces server checks.

### B4 — Canonical business-event clock

Define named timestamps for qualification, booking, scheduled meeting, meeting occurrence, outcome, customer conversion, payment recording, payment verification, and revenue recognition. Every metric states which clock it uses. Pair this with tenant timezone/week/cutoff settings.

**Decision to make:** When someone asks “sales this week,” do they mean payment recorded, verified, or recognized?

### B5 — Money and revenue-recognition ledger

Separate:

- original payment amount/currency;
- normalized/base amount and immutable FX snapshot, if multi-currency remains;
- payment lifecycle (`recorded`, `verified`, `disputed`, `voided`, `refunded`);
- commissionability;
- revenue-recognition time;
- billing-review task state.

Derive customer/revenue summaries from ledger events or maintained aggregates with reconciliation. Do not overload one status label across sales and billing workflows.

### B6 — Integration intent + outbox + reconciliation

Use the Slack OAuth implementation's actor/tenant/state/TTL shape as the starting pattern for Calendly. For WorkOS and Calendly writes:

1. persist intent/idempotency key;
2. perform external operation;
3. store confirmed external identifiers/state;
4. retry safely;
5. reconcile periodically;
6. surface drift and repair.

This turns fragile dual writes into observable workflows.

### B7 — Event-ingestion operations console

Extend raw webhook storage into an operational ledger with attempt/error/dead-letter state, replay, processor version, and correlations to the meeting/opportunity created. Let authorized users answer: “Was the booking received?”, “Why was it ignored?”, and “Can it be safely replayed?”

### B8 — Role-specific next-best-action inbox

Replace the empty notification bell with useful work:

- owner/admin: readiness blockers, integration failures, unmapped attribution, failed webhooks, assignment gaps, unfinished redistribution, support tickets;
- closer: next meeting, overdue reminders, incomplete scheduling-link follow-ups, records awaiting outcomes;
- lead generator: quota/progress, validation/correction feedback.

Rank by urgency and provide a direct resolution path, not passive notifications.

### B9 — Owner/closer coordination primitive

**[Hypothesis]** A small contextual task/escalation object could remove many dead ends. “Notify owner” should include entity, unmet requirement, suggested action, actor, and deep link. Avoid building a general project manager; constrain it to system-detected operational blockers.

### B10 — Side-deal fast path

**[Hypothesis to validate]** If “side deal” usually means an already-won sale outside Calendly, combine lead lookup/create, opportunity creation, and payment recording into one transaction, with “Save without payment” as an escape hatch. Instrument current completion/abandonment first to validate frequency and failure points.

### B11 — Admin operations console

Move beyond tenant CRUD. A tenant detail view could show lifecycle timeline, readiness, integration health, webhook failures, membership drift, invite regeneration, safe provisioning retry, suspension/resume commands, audit log, and support tickets. Preserve the current strong irreversible-delete confirmation.

### B12 — Customer lifecycle semantics

**[Hypothesis]** `active`, `paused`, and `churned` need more than a freely editable string. Add transition rules and business context: reason, effective date, pause-until, health/owner, reactivation event, and downstream effects on reporting. Verify the actual customer-success process before choosing fields.

### B13 — Identity versus tenant membership

**[Hypothesis requiring product decision]** `users` currently contains one `tenantId`, while WorkOS identities may belong to multiple organizations. If cross-organization membership is valid, split global identity/person from tenant membership/role. If it is forbidden, enforce that invariant explicitly and never silently move an existing user during onboarding.

### B14 — Correction ledger and reversible projections

Generalize the good parts of correction history: meaningful business corrections emit an immutable event with actor, reason, before/after, and affected projections. Rebuild or symmetrically reverse Lead Gen aggregates, payment/customer summaries, assignment state, and reporting caches. Provide reconciliation commands for drift.

### B15 — Report truth contract

Every report should declare:

- event clock and timezone;
- currency/denomination;
- included/excluded statuses;
- whether deposits are included;
- completeness/truncation;
- freshness/as-of time;
- filter state in the URL;
- export parity.

Put a compact “How this is calculated” disclosure beside high-stakes metrics and reuse the same contract in API responses and CSV/Excel exports.

---

## Documentation and planning inconsistencies

1. **Two active plans contradict each other.** `plans/nim-17-operations-redesign/design.md:105-108` says to delete “Top Posts by Team” as redundant. `plans/lead-gen-top-posts-by-team/lead-gen-top-posts-by-team-design.md:1-6,335-344` is an active Draft that adds it. Make the product decision and archive/supersede one plan.

2. **The product specification no longer describes the product.** `PRODUCT.md:3-4` remains Version 0.1 Draft; `:32-38,134` describes Calendly as the primary/sole inbound source and closer workflow as the MVP; `:108-113` omits `lead_generator`. Current code also includes Slack qualification, billing, Lead Gen, DM portal, expanded operations, and reporting.

3. **The design system contains stale/absolute rules.** Theme default, raw-color guidance, status centralization, spacing, and motion rules do not match current primitives or feature needs.

4. **Many plans remain Draft after partial or apparent implementation.** Add front matter such as `status`, `owner`, `supersedes`, `implemented_by`, `last_verified`, and `migration_required`. A plan index should distinguish proposed, active, implemented, superseded, and archived.

5. **Existing cleanup work is still relevant.** `plans/dead-code-cleanup/report.md` identifies obsolete wrappers, orphaned Convex functions, stale palette code, and unused primitives/assets/dependencies. Current static analysis confirms substantial cleanup opportunity.

6. **The pre-existing audit should remain a companion document.** `brainstorming/ux-architecture-audit-2026-07.md` has valuable closer/DM/admin journey detail. This audit revalidates several of its concerns, adds current Reports/Lead Gen/Billing/Operations coverage, and elevates newly found authorization/OAuth/accounting issues.

## Static analysis and verification

### Commands/results

| Check | Result | Interpretation |
| --- | --- | --- |
| `pnpm exec tsc --noEmit --pretty false` | Pass | Current snapshot type-checks. |
| `pnpm lint` | Fail: 10 errors, 36 warnings | Includes six errors inside `.agents/skills/workos-widgets/**`; default lint scope mixes product and agent/tooling files. |
| `pnpm exec eslint app components hooks lib convex --ignore-pattern 'convex/_generated/**'` | Fail: 4 errors, 20 warnings | Product-scoped lint still has real defects. |
| Fallow static analysis | 878 files; no circular dependencies, route collisions, or invalid client exports | Useful structural signal; not runtime proof. |
| Test discovery | No `*.test.*`/`*.spec.*` files and no `test` script found | Critical state/auth/accounting behavior currently lacks an automated safety net in the repository. |

### Product lint errors to resolve

- `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-context.tsx:52` — synchronous state update inside an effect.
- `app/workspace/operations/booked-calls/attribution/_components/set-portal-password-dialog.tsx:87` — same pattern in current uncommitted work.
- `components/theme-toggle.tsx:15` — same pattern.
- `hooks/use-polling-query.ts:63` — same pattern.

Notable warnings include the invalid `aria-sort` placement, native proof images, compiler-incompatible form watching, redistribution hook dependencies, and unused locals.

**Tooling recommendation:** Give product lint an explicit scope and separately lint repository-owned skills/tooling. Do not hide product failures to silence third-party/generated noise.

### Static cleanup/duplication signal

Fallow reported:

- 64 unused-file candidates;
- 163 unused-export candidates;
- 9 unused-type candidates;
- 275 clone groups / 615 instances;
- 13,239 duplicated lines out of 134,668 analyzed lines (9.83%);
- average maintainability estimate 88.9;
- 938 functions above one or more configured complexity/size thresholds.

High-value duplication clusters include:

- closer and admin follow-up flows;
- add-opportunity and side-deal payment dialogs;
- reminder/customer/pipeline detail payload assembly;
- Operations qualification/schedule and booked-call/sales-call presentations;
- status/payment presentation maps.

Do not start with a broad deduplication project. Extract domain commands/policies first, then shared presentation components where behavior is genuinely identical.

## Recommended sequence

### Immediate: before the next production release

1. Internalize/authorize every public maintenance function; search the entire Convex API for similar exports.
2. Bind owner redemption to the signed invite and intended recipient; prevent owner replacement/user rehoming.
3. Fix OAuth failure mutation, trusted callback derivation, state/PKCE intent, and owner/admin authorization.
4. Make reconnect atomic.
5. Enforce the backend owner-only role update policy.
6. Temporarily enforce a single currency if a correct multi-currency model cannot ship immediately.
7. Add focused authorization and lifecycle tests for all six items.

### Next sprint

1. Implement status-specific tenant recovery routing.
2. Fix follow-up partial-state/orphan handling.
3. Correct redistribution ownership and inactive-assignee validation.
4. Fix webhook occurrence dedupe; add processing error/attempt state and an authorized replay path.
5. Stop finalizing capped merge/rollback/projection operations as complete.
6. Surface all report truncation; fix system-admin global metrics.
7. Add rate limiting/deduplication to support intake.
8. Hide the placeholder notification center or turn it into the first operational-inbox slice.

### Following 2–4 sprints

1. Establish tenant business-time and metric-event contracts.
2. Establish the currency/revenue-recognition model and migrate data.
3. Build the route/IA registry and canonical URL-state pattern.
4. Build shared page header, dialog, heading, form-message, loading, touch-target, and status-presentation contracts.
5. Add WorkOS/Calendly intent, outbox, reconciliation, and repair UX.
6. Add a durable workflow-case abstraction only for genuinely multi-step processes.
7. Refresh `PRODUCT.md`, `DESIGN_SYSTEM.md`, and plan statuses.

## Validation matrix for implementation work

| Concern | Minimum automated checks | Manual QA |
| --- | --- | --- |
| Public API authorization | Unauthenticated, wrong-org, wrong-role, correct-role tests for every public function; static guard rule | Attempt actions from each real test role and inspect audit logs. |
| Invite/owner claim | Invalid/expired/reused/wrong-recipient token; concurrent redemption; existing owner; multi-org identity | Fresh invite, expired invite, already-used invite, signed-in wrong member. |
| OAuth/reconnect | State mismatch, PKCE mismatch, expiry, concurrent flows, canceled flow, callback-origin tamper, old-token preservation | Connect/reconnect/cancel in two tabs; verify old integration remains healthy until swap. |
| State machines | Table/property tests for every allowed and forbidden transition plus reversal reason/actor | Exercise recovery and correction paths, not only happy paths. |
| Webhooks | Duplicate delivery, `created→deleted→created`, out-of-order delivery, poison event, retry, dead-letter, replay idempotency | Inspect operations ledger and repair CTA. |
| Money | Mixed currency rejection/conversion, JPY scale, dispute/void/refund, >100 customer payments, >2,500 report rows | Compare reports/export/customer detail against a hand-calculated fixture. |
| Time | DST zones, Honduras cutoff, Sunday/Monday week start, local viewer in another zone | Compare Dashboard/Pipeline/Reports/Slack for the same fixture. |
| Accessibility | Keyboard link navigation, label associations, heading outline, live errors/status, dialog zoom/viewport | Keyboard-only, 200% zoom, narrow phone, VoiceOver/NVDA smoke test. |
| URL state | Refresh, Back/Forward, copied link, canonical redirects, settings tab return | Share filtered reports and opened entity/opportunity states between sessions. |

## Definition of done for the audit findings

An item is not complete merely when the UI appears fixed. For security/correctness work, completion means:

- the backend invariant is explicit and authoritative;
- the failure/recovery path is designed;
- migrations/backfills are bounded and resumable where required;
- authorization/state/accounting tests exist;
- observability identifies failures without inspecting raw production data manually;
- UI copy and affordances reflect the same policy;
- relevant product/design documentation is updated or superseded.
