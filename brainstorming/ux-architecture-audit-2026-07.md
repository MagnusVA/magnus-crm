# Full UX & Architecture Audit — Closer, DM Setter, and Tenant Admin/Owner Surfaces

> Date: 2026-07-07
> Method: code-only audit (no browser), 5 parallel deep-read passes over the closer workspace, DM portal + lead-gen, admin data management, admin config/ops/onboarding, and the backend money paths.
> Scope exclusions: `/workspace/reports` and reporting widgets (being redesigned separately).
> Related docs this builds on: `unprocessed-webhook-notifications.md`, `phone-closer-overrun-refactor-scope.md`, `billing-ops-review.md`, `mauro-feedback.md`, `../improvements.md`, `../notes.md`.

---

## 0. TL;DR — the five things that matter most

1. **Bookings can be silently lost.** A thrown pipeline handler leaves the webhook event `processed: false` forever — no retry, no dead-letter, no operator action (3 confirmed stuck real bookings in prod). Unknown-host bookings throw; known-non-closer-host bookings are dropped with no audit trail. This is the revenue-critical path and it fails silently.
2. **Two real security holes in onboarding.** Any org member (including a closer) who loads `/onboarding/connect` gets auto-promoted to tenant owner (`redeemInviteAndCreateUser` has no guard), and any org member can bind their personal Calendly account as the tenant connection (`startOAuth` has no role check). Both are reachable in practice because *every* non-`active` tenant status dumps *all* users onto that page.
3. **Honest mistakes are permanent.** No way to: edit a lead's name/email, reassign a closer, undo/override any opportunity status, void or edit a non-side-deal payment, un-review a billing record, or resolve a dispute. The live admin surface (`leads-customers`) contains **zero mutations** — several correction mutations exist in Convex but are orphaned (no UI calls them).
4. **Closers hit invisible dead ends.** Generating a follow-up scheduling link without clicking "Done" silently removes every outcome action from the meeting forever. Reminders on terminal opportunities can never be dismissed. Outcome buttons are *hidden* (not disabled) before the 5-minute window with no explanation. `follow_up_scheduled` deals have no queue and no actions.
5. **The setter identity model is the root friction for DMs.** Self-selected, unauthenticated identity in the shared-password portal (confirms Mauro's feedback); `dmClosers.userId` already exists in schema but is unused for auth. One architectural step — per-setter identity — resolves impersonation, state-loss pain, attribution trust, and "notes on any lead" together.

---

## 1. Business-critical code paths (the map)

### 1.1 Booking ingestion (the revenue path)
```
Calendly POST /webhooks/calendly?tenantId=…        convex/http.ts:12
  → HMAC verify (timing-safe, 180s window)         convex/webhooks/calendly.ts:95-177   ✅ solid
  → persistRawEvent (dedupe by event URI)          convex/webhooks/calendlyMutations.ts:5-51  ✅ idempotent
  → scheduler.runAfter(0, processRawEvent)         at-most-once, NO retry               ⚠️
  → dispatch by type                               convex/pipeline/processor.ts:26-137
  → inviteeCreated.process (one giant mutation)    convex/pipeline/inviteeCreated.ts:761-1767
      branches: UTM relink → non-closer skip → heuristic reschedule (14d) → normal create
      lead upsert → opportunity insert → closer via host-URI match (NOT round robin)
      → meeting insert → updateOpportunityMeetingRefs → stats/aggregates/projections
```
**Failure modes (ranked):**
- **CRITICAL — stuck forever on throw.** `processor.ts:128-135` re-throws without marking processed; no cron/retry/dead-letter exists. Causes: unknown host (`inviteeCreated.ts:1486-1488`), duplicate-email `.unique()` throw (`leads/identityResolution.ts:374-380`), invalid transition, OCC mid-flow. A stuck `invitee.created` = a sales call that never entered the pipeline.
- **CRITICAL — unknown Calendly host throws.** Org-member sync is a 24h cron (`crons.ts:20-25`), so every booking hosted by a newly added closer can be dropped for up to a day.
- **HIGH — silent skips.** Known-non-closer-host bookings marked `processed: true` with only a console.warn — no `skipReason`, invisible to ops (`inviteeCreated.ts:1166-1172`).
- **HIGH — out-of-order events discarded.** A cancel/no-show arriving before (or while) its `invitee.created` is stuck finds no meeting → marked processed and lost; when the created event later processes, the meeting resurrects as `scheduled` (phantom meeting on the calendar) (`inviteeCanceled.ts:84-90`).
- **MEDIUM — OCC hotspot.** `tenantStats` is one per-tenant doc patched inside the huge `inviteeCreated` transaction and every payment/cancel mutation (`lib/tenantStatsHelper.ts:80-129`).

Replay machinery already exists (`convex/admin/rawWebhookReplay.ts`) — it's just system-admin-only with no tenant-facing UI. The ops health banner (`operations/bookingHealth.ts`) counts these events but offers no action, so it cries wolf (see `unprocessed-webhook-notifications.md`).

### 1.2 Status state machine
`convex/lib/statusTransitions.ts` — genuinely enforced everywhere (pipeline, closer, admin, side deals all call `validateTransition`; no bypass writer found). Two design problems:
- `payment_received` and `lost` are absolute terminals with **no admin override mutation anywhere**. Raw DB edits skip aggregates/projections → corruption. (HIGH)
- `canceled → lost` is disallowed; canceled deals linger as non-terminal rows forever. (MEDIUM)

### 1.3 Payments
`closer/payments.logPayment` (`convex/closer/payments.ts:35-230`) is well-guarded: ownership check, transition validation, minor-unit integer currency, program invariants, aggregates, customer conversion. Gaps:
- **HIGH — no void/edit for regular payments.** `sideDeals/voidPayment.ts:48-59` explicitly rejects non-side-deal origins; combined with the terminal status, a mis-entered amount permanently corrupts revenue stats, wonDeals, and customer conversion.
- MEDIUM — no idempotency key on `logPayment` (additional-payment path is double-submit-prone); `syncCustomerPaymentSummary` reads `.take(100)` → silently wrong totals past 100 payments (`lib/paymentHelpers.ts:90-93`).
- Dispute status is a UI dead end: `billing/mutations.ts:182` says disputes need "a dispute flow" that doesn't exist, and nothing can even set `disputed` outside side-deal void.

### 1.4 Calendly token lifecycle
90-min refresh cron + 24h health check, transactional refresh lock, correct 429 handling. Gaps:
- **HIGH — disconnect is a silent, inconsistent, unrecovered state.** On refresh failure the code only patches `tenants.status = "calendly_disconnected"` — leaves `connectionStatus: "connected"` + stale credentials (`convex/tenants.ts:135-145`), sends **no notification** (banner-only), and excludes the tenant from both crons — so nothing ever retries. Bookings during the window are unrecoverable (no backfill/reconciliation). Given H-1/H-3 below, disconnect also locks every user out of the workspace.
- HIGH — tokens/signing keys stored application-plaintext and returned raw to any internal caller (`schema.ts:1935-1944`, `calendly/connectionQueries.ts:21-22`).
- MEDIUM — 30s refresh lock with no renewal held across the token HTTP call → narrow refresh-token-rotation race; 5xx errors get no retry until next cron.

### 1.5 Tenant/auth
`requireTenantUser` is solid on identity (org-claim cross-check prevents cross-tenant token reuse) but:
- **HIGH — never checks `tenant.status`.** Suspended/disconnected tenants can execute every function including payments (`convex/requireTenantUser.ts:90-108`).
- See §4 for the onboarding criticals (C-1/C-2).

---

## 2. Closer experience

### Flow reality check
Dashboard → featured meeting/calendar → meeting detail (well preloaded) → outcome dialogs. The plumbing is mostly good: server auth is belt-and-braces, transitions validated client+server, skeletons/empty states pervasive, no-show → reschedule-link → webhook-relink loop fully wired.

### Critical dead ends
| # | Finding | Where | Fix |
|---|---|---|---|
| CL-1 | **Abandoned scheduling link permanently strips ALL outcome actions.** Follow-up creates a `pending` followUp *before* the status transition; the transition only commits on "Done". Close the dialog after "Generate" (very natural — you got your link) → opportunity stays `scheduled`, but `outcome-action-bar.tsx:67-77` hides Log Payment / Lost / No-Show / Follow-up forever, with no explanation and no expiry (`expirePendingFollowUpsForOpportunity` in `lib/paymentHelpers.ts:117` is defined but **never called**). | `convex/closer/followUpMutations.ts:166-251` | Render a "Follow-up link pending — Resume / Cancel" banner + cancel mutation; wire the expiry helper into markAsLost/logPayment/markNoShow. |
| CL-2 | **Zombie reminders.** Reminder on a terminal opportunity hides all outcome dialogs and says "close it from the dashboard" — but the dashboard has no dismiss affordance. Backend `markReminderNoResponse close_only` has no status guard, so the capability exists; the UI never exposes it. | `reminder-outcome-action-bar.tsx:140-170`, `convex/closer/reminderOutcomes.ts:387-470` | Add "Dismiss reminder" in that branch. |

### High friction
- **Outcome buttons hidden, not disabled**, until 5 min before the call — a closer opening tomorrow's meeting has no idea actions will appear (`outcome-action-bar.tsx:68-73`). Show disabled + "available 5 min before the call". (The deeper fix is the Start/End-meeting removal already scoped in `phone-closer-overrun-refactor-scope.md`.)
- **Three contradictory pipeline counts in one click**: dashboard strip counts are period-scoped, the pipeline page's filter chips are all-time, its table defaults to today (`closer-pipeline-page-client.tsx:126`). Carry `?period=` through the link.
- **`follow_up_scheduled` deals have no queue** — after sending a link, nothing surfaces "waiting on lead to book"; if the lead never books, recovery is only the stale-nudge. Add a "Waiting to book" dashboard section with resend/mark-lost.
- **Not-found is broken**: `getMeetingDetail` throws (`convex/closer/meetingDetail.ts:64-86`) so the designed "Meeting Not Found" UI is unreachable — closers get the generic route error. Return `null` like `getReminderDetail` does.
- **Calendar → detail costs 2 clicks + a dialog** that repeats info already on the block (`meeting-block.tsx:120-196`). Navigate directly.
- Payment dialog: program not auto-selected when only one exists nor prefilled from the booked program; currency resets to USD every time.

### Consistency/architecture
- Payment form **triplicated** (closer dialog, reminder dialog, add-payment dialog) and the follow-up scheduling-link flow duplicated into `admin-follow-up-dialog.tsx` — currency/type/schema drift is already visible. Extract shared `PaymentFormFields` + a scheduling-link flow component.
- Closer vs admin meeting detail pages render the same entity with two different component sets/layouts (`meeting-overview-card` vs legacy `LeadInfoPanel`/`MeetingInfoPanel`). Converge with a role flag.
- All-time `getPipelineSummary` full-index-scans 8 statuses reactively (`convex/closer/dashboard.ts:224-236`) — the exact counting anti-pattern AGENTS.md bans. Meeting history fan-out can read ~1,050 docs per meeting load (`meetingDetail.ts:106-160`); it's collapsed by default — lazy-load it.
- Featured meeting is a 60s poll (not a subscription) and the dashboard has no `preloadQuery` despite being the highest-value screen; `router.refresh()` after outcomes double-fetches a page that's already reactive (`meeting-detail-page-client.tsx:72-73`).
- Dead code: 4 orphaned dashboard components, the abandoned Calendly-API follow-up action (`convex/closer/followUp.ts`), `markReminderComplete`, stale `meetings/_components/README.md`, PRODUCT.md §10.2/10.3 no longer match reality (comments-as-notes; UTM links, not single-use Calendly links).

---

## 3. DM setter (portal) + lead-gen

### The structural insight
Portal setters (shared password, no account) and lead-gen workers (full accounts) are **two disconnected identity systems doing one conceptual job**. `leadGenProspects` aren't `leads` (only audit-matched later); a person doing both jobs works in two unrelated surfaces. And the portal **cannot create leads** — the setter's richest context (the DM conversation) happens *before* booking, and there's nowhere to put it at that moment.

### The identity problem (Mauro's feedback, confirmed in code)
- Attribution identity is a **tap on a name card**, validated only as "an active closer of this tenant" (`dm-link-portal-client.tsx:888-902`). Notes, edits, copy events, and UTM attribution can all be recorded as the wrong person. Mitigating: attribution is registry-based (IDs, normalized UTMs) — impersonation is the exposure, not typos.
- The fix is already scaffolded: `dmClosers.userId: v.optional(v.id("users"))` (`schema.ts:672`) is maintained by admin CRUD but never used for auth. Per-setter identity (magic link or admin-issued PIN) resolves impersonation, session-loss pain, attribution trust, and enables a "my activity" view (audit tables `linkPortalCopyEvents`/`linkPortalLeadEdits` already exist — setters just can't see their own work).
- Notes are **half-shipped two-way**: schema reserves `authorKind: "user"` and the portal renders "Team" notes, but the workspace has three read surfaces and **zero write surfaces** for lead notes. Note edit/delete fields (`editedAt`/`deletedAt`) have no mutations or UI.

### Top friction (daily pain)
| # | Finding | Where | Fix |
|---|---|---|---|
| DM-1 | **60s link-expiry timer nukes unrelated work**: `resetPortalState` clears all 4 wizard selections *and* the closer identity, unmounting the Leads panel mid-note-typing on another tab. | `dm-link-portal-client.tsx:504-521` | On expiry clear only `generatedBatch`/`copyStates`. Never clear identity/selections. |
| DM-2 | **`@handle` search silently returns nothing** — the PII-probe filter rejects any term containing "@", but the UI displays `@handle` badges and invites handle search. Pasting `@fitjane` from Instagram → "No leads matched". | `convex/lib/linkPortal/validators.ts:65-71` | Strip leading `@` both sides; explain rejected terms. |
| DM-3 | Identity picker is plain `useState` — every reload/expiry forces re-picking (compounds DM-1 and the impersonation risk). | `dm-link-portal-client.tsx:408` | Persist in localStorage + "You are X — not you?" banner. |
| DM-4 | Session expiry mid-work: full-panel takeover loses draft notes (8h TTL → daily); on the Links tab, copies "succeed" while copy-audit attribution is silently dropped (`recordPortalCopy` returns `{recorded:false}`, UI shows "Copied." regardless). | `portal-leads-panel.tsx:195-215`, `actions.ts:194-211` | Inline re-auth dialog preserving state; surface expired session on any action. |
| DM-5 | Income field has no currency/period semantics ("e.g. 5000" — monthly? annual? USD?). Reporting built on it will be garbage-in. | `portal-leads-panel.tsx:518-532`, `schema.ts:504-506` | Label the unit; consider unit in schema. |

Also: per-keystroke search is a 3-hop round trip (browser → server action → node action → query) reading up to 20 leads × 60 notes; a transient bootstrap error renders the **password screen** (`page.tsx:38` catches to null), telling authed setters their password is needed again; per-IP lockout can lock out a whole NAT'd team; lead-gen schedule save is 7 parallel mutations with one success toast (partial-failure lies).

**What's good:** the backend trust model of this surface is unusually well done — tenant always derived from the signed token, deliberate minimal-PII projection, write rate limits everywhere, bounded queries, merge reparents notes. Both surfaces are genuinely mobile-first.

---

## 4. Tenant admin/owner

### 4.1 SECURITY — fix before anything else
| # | Finding | Where |
|---|---|---|
| SEC-1 | **Privilege escalation to tenant owner.** `redeemInviteAndCreateUser` only checks org membership, then: creates a `tenant_master` CRM user for any org member without a record, unconditionally reassigns `tenantOwnerId` to the caller, and schedules WorkOS `owner` role assignment. `/onboarding/connect` auto-fires it on mount — and because `lib/auth.ts:129` sends **all users of any non-`active` tenant** to that page, a closer loading the app during a Calendly disconnect silently becomes tenant owner. Also directly invocable anytime. | `convex/onboarding/complete.ts:69-77,111-113,126-133`; `app/onboarding/connect/page.tsx:106-149` |
| SEC-2 | **Any closer can bind their personal Calendly account as the tenant connection.** `startOAuth`/`exchangeCodeAndProvision` verify org membership only (`prepareReconnect` correctly requires admin — the other two don't). | `convex/calendly/oauth.ts:100-117,293-297` |
| SEC-3 | `requireTenantUser` never checks tenant status — suspended tenants keep full function access. | `convex/requireTenantUser.ts:90-108` |

### 4.2 Lifecycle & onboarding UX
- **Every non-`active` state collapses into first-run onboarding UI** — `calendly_disconnected`, `suspended`, `provisioning_webhooks`, `invite_expired` all render "Welcome! Connect Calendly…" to every role (`lib/auth.ts:129-131`). Closers see an owner-oriented setup page for a problem they can't fix. Need state-specific screens: disconnected (admin: reconnect CTA / others: "waiting on admin"), suspended (self-diagnosis; today the CTA throws a generic `oauth_start_failed` loop), provisioning (spinner + polling).
- **Reconnect disconnects first**: `prepareReconnect` revokes tokens *before* OAuth (`oauth.ts:230-236`); abandon the consent screen and the whole tenant is locked out until someone completes reconnect. Keep old tokens until the new exchange succeeds.
- **Pending invites are invisible and unresendable**: team table doesn't use the `isPendingInvite` flag the query already returns; expired WorkOS invitation → "email already exists" dead end; `sendOrResendInvitation` exists in the backend, unexposed (`convex/workos/userManagement.ts:363-391`).
- Closer invite requires a Calendly member but the dropdown can be empty with no "run Sync Members" hint; remove-user pre-flight is stubbed (`hasActiveAssignments = false // TODO`, `team-page-client.tsx:153`).

### 4.3 Data management — the correction gap
**The live person-record surface (`leads-customers`) contains zero mutations.** Verified: everything an admin can write flows through legacy-dir dialogs gated almost entirely to side deals (`convex/opportunities/detailQuery.ts:191-216`).

Orphaned mutations (exist in Convex, no live UI caller):
- `updateLead` (`convex/leads/mutations.ts:18`) — **a typo'd lead name/email cannot be fixed by anyone.**
- `updateCustomerStatus`, `convertLeadToCustomer`, `recordCustomerPayment` — all only called by dead components.
- `mergeLead` works but its UI (`/workspace/leads/[leadId]/merge`) is only linked from a dead page and the closer duplicate banner — **admins on the live entity page can't reach merge.**

Missing entirely (no mutation): reassign closer, change/undo opportunity status, void non-side-deal payment, un-review billing, resolve dispute, unmerge, edit payment date/attribution, admin notes on entities, resolve non-payment reminder outcomes (closer-only — reminders stall if the closer leaves).

### 4.4 Navigation & IA
- **Route consolidation is half-finished**: `/workspace/leads`, `/customers`, `/opportunities`, `/pipeline` are redirect shims, but 6 dead component trees live under them, live shared code is trapped inside them (opportunity sheet imports from `opportunities/[opportunityId]/_components/`; merge + meeting/reminder detail pages live under retired trees), and the `pipeline → opportunities → leads-customers` **double redirect drops query params** — old bookmarks land unfiltered. `workspace-shell.tsx` is deprecated dead code.
- **The admin pipeline board is gone with no replacement**: no kanban/all-open-deals view; ops sub-pages + entity browser don't cover "review all open deals across closers". `/workspace/pipeline/meetings/[id]` (the admin action surface) is orphaned from nav and the command palette — reachable only via circular links.
- **Entity browser lacks its core affordances**: search + lifecycle toggle only — no status/closer/date facets, no sort, no export, no total count, no bulk actions anywhere in the app (billing review is strictly one-by-one).
- Sheet deep-linking is asymmetric (`openOpportunity` never syncs the URL — refresh/share loses the open sheet, `opportunity-sheet-context.tsx:55-62`); payment rows on entity detail don't link to billing records; billing queue has no free-text search.
- Nav label ≠ page title ≠ document title ("Qualifications" vs "Qualified Leads"; "Sales Calls" vs "Phone Sales Ops"); breadcrumbs degrade to "..." across profile/billing/reports/settings children; keyboard shortcuts shift when the billing flag is on and ⌘2 targets a pure redirect page.
- Config sprawl: booking quota editable in 3 places, qualification goal in 2, settings across 7 tabs + a separate lead-gen settings page. Settings tabs aren't URL-controlled (deep links from the health banner only work on fresh mount) and all tabs block on 3 queries, defeating the page's own `preloadQuery`.
- Inconsistent confirmation ethics: irreversible "Mark reviewed" is one unguarded click while reversible actions demand reason + double confirm.

### 4.5 Backend smells behind admin screens
Mostly clean (no `.collect()`, real search indexes, aggregate-backed counts, denormalized `leadCustomerSearchRows` projection). Exceptions:
- **`mergeLead` bug**: clears stale duplicate flags via `by_tenantId` scan `.take(500)` + JS filter **ignoring the existing `by_tenantId_and_potentialDuplicateLeadId` index** — silent dangling flags past 500 opportunities (`convex/leads/merge.ts:281-294`). Also merge moves max 100 opportunities without batching.
- Billing enrichment is a heavy per-row N+1 (customer→opportunity→meeting→Slack per row, `convex/billing/enrichment.ts:366-468`) — denormalize display fields onto `paymentRecords`.
- One `followUps` query per opportunity per page for a nudge boolean (`opportunities/listQueries.ts:299`); client-side column sort over partially-loaded paginated data silently mis-sorts (`_components/pipeline/opportunities-table.tsx:113-130`).

---

## 5. Cross-cutting themes

1. **Silent failure is the house style.** Stuck webhooks, skipped bookings, dropped copy-audits, hidden outcome buttons, vanished toolbars, park-forever reminders, partial-save loops with success toasts. Adopt one principle: *every failed/blocked/skipped thing must be visible somewhere and have an action attached* (retry, dismiss, explain, or escalate).
2. **Terminal-state absolutism.** The state machine is admirably enforced but has no escape hatch, and the product is run by humans who mis-click. Build ONE audited "admin correction" layer (status override + payment void/adjust + lead edit + reassign) that replays all side effects (stats deltas, aggregates, projections, domain events) — the side-deal void already demonstrates the full reversal pattern; generalize it instead of scattering one-off fixes.
3. **Half-finished migrations are the biggest architecture debt.** leads/customers/opportunities/pipeline route consolidation, two-way notes, per-setter identity, dispute flow, `connectionStatus: "token_expired"` dead enum, orphaned mutations, dead component trees, deprecated shell, stale READMEs/PRODUCT.md. Each was ~80% shipped. A "finish or delete" sweep would remove more confusion than any new feature.
4. **Duplication drift.** Payment form ×3, scheduling-link flow ×2, status-color maps ×3, closer vs admin meeting pages, business-day logic re-implemented client-side with a hardcoded timezone (`lead-gen-capture-page-client.tsx:52-53` vs `convex/reporting/lib/hondurasBusinessTime.ts`), three generations of date filter (ops URL-synced / overview un-synced / closer legacy). Standardize on the ops-page conventions (they're the best of the three).
5. **Identity is the unlock for the DM side.** Per-setter identity (on the existing `dmClosers.userId`) + workspace note-writing + pre-booking lead capture turns the portal from a link vending machine into the setter's actual workflow home — and makes attribution trustworthy for the reporting redesign that's coming.

---

## 6. Prioritized plan

### P0 — this week (security + revenue)
1. Guard `redeemInviteAndCreateUser` (only `pending_signup` / valid invite; never reassign owner after first redemption) and add role checks to `startOAuth`/`exchangeCodeAndProvision`. (SEC-1/2)
2. Webhook dead-letter + bounded retry + operator replay/ack, and stop throwing on unknown host — create the opportunity unassigned/triaged instead; trigger org-member sync on demand. Add `processedOutcome`/`skipReason` so skips are auditable. (Reuses `admin/rawWebhookReplay.ts` + the plan in `unprocessed-webhook-notifications.md`.)
3. Tenant-status check in `requireTenantUser`; make disconnect consistent (clear `connectionStatus`, alert admins via Slack/email, keep retrying or surface a reconnect path). Fix `prepareReconnect` to keep old tokens until success.

### P1 — the correction layer (admin) + closer dead ends
4. Wire the orphaned mutations into the live entity surface: edit lead fields, customer status, convert, merge entry point. Fix the `mergeLead` index bug.
5. Build audited admin overrides: status correction, payment void/adjust for all origins, reassign closer, un-review, dismiss reminder (admin + closer `close_only`).
6. Closer dead-end fixes: follow-up pending banner + cancel (CL-1), zombie reminder dismiss (CL-2), disabled-with-explanation outcome buttons, `getMeetingDetail` returns null, "waiting to book" queue for `follow_up_scheduled`.

### P2 — daily-friction quick wins (small diffs, big relief)
7. Portal: expiry stops nuking state (DM-1), strip `@` in search (DM-2), persist identity (DM-3), inline re-auth (DM-4), income unit label (DM-5).
8. Admin: entity-browser facets (status/closer/sort), billing free-text search + bulk mark-reviewed, sheet URL sync on open, payment rows link to billing, fix the param-dropping double redirect, pending-invite badge + resend.
9. Closer: period carried into pipeline links, one-click calendar → detail, payment-form defaults (single/booked program, sticky currency).

### P3 — structural (schedule deliberately)
10. Per-setter identity on `dmClosers.userId` + workspace note-writing + setter "my activity" (Mauro's asks; prerequisite for trustworthy attribution in the reporting redesign).
11. Finish-or-delete sweep: remove 6 dead component trees + deprecated shell + dead convex actions; relocate live code out of redirect-shim dirs; reconcile PRODUCT.md/READMEs.
12. Decide the admin "all open deals" surface (restore a pipeline view or fold into entity browser facets) and unify closer/admin meeting detail.
13. Start/End-meeting removal per `phone-closer-overrun-refactor-scope.md` (unlocks outcome actions without the ceremony).
14. Contention/scale: shard `tenantStats`, split the `inviteeCreated` mega-mutation, denormalize billing enrichment + per-closer pipeline counts, encrypt Calendly tokens.

---

## 7. Traceability

| Source | Where it landed |
|---|---|
| `mauro-feedback.md` (setter accounts + notes on any lead) | §3 identity, P3-10 |
| `unprocessed-webhook-notifications.md` | §1.1, P0-2 |
| `phone-closer-overrun-refactor-scope.md` | §2 outcome gating, P3-13 |
| `billing-ops-review.md` | §4.4 billing search/bulk, P2-8 |
| `improvements.md` (follow-up options, no-show/reschedule same closer, lead-centered UI, configurable ranges) | §2 CL-1/H4, §4.4 entity browser, M-3 date filters |
| `notes.md` (missing no-show flow, nurture specialists) | no-show flow exists & is wired (§2 flow map); nurture-specialist role remains an open product idea, not covered here |
