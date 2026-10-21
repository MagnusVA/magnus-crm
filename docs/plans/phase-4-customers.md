# Phase 4: customers

Status: accepted, 2026-10-21. The tenant admin (`k97fgy2ckqhn8w2xynw3etwdf984dwb9`) accepted D1 to D16 and answered Q1 to Q4 (§11.1); every production run in §9 and §10 is approved. PR 0 (this plan) is open.

Scope comes from §7 of the [lead lifecycle review](../reviews/lead-lifecycle-review.html#roadmap) (finding F4, target rule "A customer is a stage, not a table" in §6) and the Phase 4 row of [ADR 0001](../adr/0001-lead-lifecycle-model.md). Terms follow [`CONTEXT.md`](../../CONTEXT.md). Phase 3 is in [phase-3-attribution.md](phase-3-attribution.md).

This file holds IDs and counts only. It contains no personal data.

## 1. Summary

Phase 4 removes the customer copy:

1. **`enrollments`**: one row per person and program bought, with its own status (active, paused, churned) and its times. The earliest payment for a program on any of the person's deals that isn't disputed creates it, and one function derives a person's enrollments from their payments for every write path, the backfill and the assert (§4.1).
2. **The person is the customer.** A person with at least one enrollment is a customer: `leads.status` is `converted` and the lifecycle stage is Customer, as today. The email requirement goes, so a person with no email can become a customer (§4.2).
3. **Readers move**: the person page, the leads and customers list and search, billing, the Leads & Conversions report and the admin dashboard read the person for contact details and enrollments for programs and status. Each number is checked against the customer rows in production before it switches (§10.3).
4. **An admin payment for a new program goes through a new deal.** `recordCustomerPayment`, `convertLeadToCustomer` and `updateCustomerStatus` are retired, with the customer pages and dialogs that no route reaches (§2.7).
5. **Merges** accept people who are customers and move their enrollments (§4.7).
6. **The narrow**: no `customers` row survives (D1). Its 274 rows are deleted after an export, and the table, `paymentRecords.customerId`, `leadCustomerSearchRows.customerId` and the payment fields only `recordCustomerPayment` wrote leave the schema with their indexes (§3.3).

It ships in five code PRs after this plan (§9). Each is safe to deploy alone.

## 2. Production snapshot (2026-10-21)

Read-only inline queries against tenant `k57dqjfyf8qqy31bq375ng8gb984b24q`, the only tenant.

### 2.1 Customers

- 274 `customers` rows, one per person; no person has two. All 274 are `active`; none has `churnedAt`, `pausedAt` or `notes`.
- Their people: 274 leads with `status: "converted"`, all at the Customer stage, none merged. No converted lead lacks a customer row.
- 7 programs (of the tenant's 8, none archived):

| Program | Customers |
| --- | --- |
| `mx70755nxxzr80cesagjn2264185btj1` | 122 |
| `mx7fpgh9jc0htr20ezccpc57fn85bfym` | 65 |
| `mx723y0qdwcr2nwncymgxxcfjh86r35v` | 63 |
| `mx70pebx3afkzps6bsedpc7d0d85a2b0` | 18 |
| `mx71785xgvfq0bex8929059p5d85axbe` | 4 |
| `mx74s08yn6xmrt528ftd2sw86n85atwz` | 1 |
| `mx7fxpw2azzd4j9pexvxwvg0dx85ah3b` | 1 |

- 266 have a `winningMeetingId`; the other 8 were won by side deals, which have no meeting.
- `tenantStats.totalCustomers` is 274.

### 2.2 Payments

- 279 `paymentRecords`, recorded 2026-04-21 to 2026-10-20. All are `recorded`, commissionable, `contextType: "opportunity"`, on a deal, with an `attributedCloserId` and a `customerId`.
- By origin: 262 `closer_meeting`, 8 `closer_side_deal`, 5 `closer_additional`, 4 `closer_reminder`. No payment has `contextType: "customer"`, origin `customer_direct` or `bookkeeper_direct`, or an `originatingOpportunityId`: `recordCustomerPayment` has never run in production.
- Every payment's program is its customer's program. No payment is on a deal that isn't won.
- 13 payments have no meeting: the 8 side deal payments and the 5 additional payments.
- No `admin_*` origin has a row. `admin_review_resolution` and `bookkeeper_direct` have no writer in the code either.

### 2.3 Won deals

- 274 won deals (`payment_received`): 136 from Calendly, 130 from Slack, 8 side deals. One per person, and each is its customer's `winningOpportunityId`. Every one has an `assignedCloserId` and at least one payment.
- 10 won deals, created 2026-04-19 to 2026-05-20 and paid 2026-04-21 to 2026-05-21, have no `soldProgramId`. Each has one `closer_meeting` payment naming the customer's program. `recordAdditionalPayment` refuses these deals today (§5, D14).
- So the backfill writes one enrollment per customer, 274 in all; the review's "one per later program purchase found in payments" finds none.

### 2.4 What a customer row holds

Compared with the records it was copied from, on all 274 rows:

| Field | Same as | Rows equal |
| --- | --- | --- |
| `convertedAt` | the first payment's `recordedAt` | 274 |
| `convertedAt` | the person's Customer stage entry time | 274 |
| `convertedByUserId` | the first payment's `recordedByUserId` | 274 |
| `winningOpportunityId` | the first payment's deal | 274 |
| `winningMeetingId` | the first payment's meeting | 274 |
| `totalPaidMinor`, `totalPaymentCount` | the customer's payments | 274 |
| `programName` | the program's current name | 254 (20 stale after renames) |
| `fullName` | the person's name | 270 (4 differ) |
| `socialHandles` | the person's handles | 272 (2 differ) |
| `email`, `phone` | the person's | 274 |

The only facts no other record holds are `status` (all active) and `notes` (all empty).

### 2.5 People who can't become customers today

Conversion throws `customer.lead_email_missing` when the person has no email, and the payment rolls back. 1,231 open deals belong to people with no email: 1,221 Slack deals waiting for a booking, 10 canceled, 9 scheduled and 1 with a follow-up. Another 4,189 lost deals do too.

### 2.6 What names a customer

| Where | Rows |
| --- | --- |
| `paymentRecords.customerId` | 279 |
| `leadCustomerSearchRows.customerId` (`customerStatus: "active"`, `lifecycle: "customer"`) | 274 |
| `domainEvents`, `entityType: "customer"` | 274 `customer.converted`; no `customer.status_changed` or `customer.conversion_rolled_back` |
| `customerConversions` aggregate, keyed by `convertedByUserId` and `convertedAt` | one entry per customer; read only by `reporting/verification.ts` |
| `tenantStats.totalCustomers` | 274; written, never read |

The 279 `payment.recorded` events name no customer.

### 2.7 Code that reaches customers

- Both `/workspace/customers` routes only redirect to `/workspace/leads-customers`. The customer list and detail clients, the status control, the record payment dialog and the convert dialog are rendered by no route, so `listCustomers`, `getCustomerDetail`, `updateCustomerStatus`, `recordCustomerPayment` and `convertLeadToCustomer` have no live caller.
- The canonical person page (`/workspace/leads-customers/[leadId]`) shows the customer row's status, total, conversion date, program and winning deal, and contact details from the person.
- `mergeLead` and `getMergePreview` accept only people whose status is `active`, so a customer can't be merged today.
- 39 files in `convex/` touch `customers` or a `customerId`; §5, §6 and §8 place each one.

## 3. Schema

### 3.1 `enrollments` (PR 1)

```ts
// convex/enrollments/validators.ts
export const enrollmentStatusValidator = v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("churned"),
);

enrollments: defineTable({
  tenantId: v.id("tenants"),
  leadId: v.id("leads"),
  programId: v.id("tenantPrograms"),
  // From the earliest payment for this program, on any of the person's
  // deals, that isn't disputed (§4.1). Re-derived when payments change.
  opportunityId: v.id("opportunities"),
  enrolledAt: v.number(), // that payment's recordedAt
  status: enrollmentStatusValidator,
  // Set when an admin changes the status; unset while it was never changed.
  statusChangedAt: v.optional(v.number()),
  statusChangedByUserId: v.optional(v.id("users")),
  createdAt: v.number(),
})
  .index("by_tenantId_and_leadId_and_programId", ["tenantId", "leadId", "programId"])
  .index("by_tenantId_and_enrolledAt", ["tenantId", "enrolledAt"]),
```

- No program name, contact field, total or recorder: the program, the person and the payments own those (rule 5). `opportunityId` and `enrolledAt` follow the first payment and are re-derived with it; `enrolledAt` is indexed.
- The first index finds a person's enrollments and a payment's enrollment (its deal's person and its program). The second serves the Leads & Conversions report and the admin dashboard (§6.3).
- `domainEvents.entityType` gains `"enrollment"` (§4.10).

### 3.2 PR 4

- `paymentRecords.contextType` becomes optional, so PR 4 can stop writing it and the clear can unset it (D12).
- `customers` and `paymentRecords.customerId` stay as they are; PR 4 stops writing them and its migrations empty them.

### 3.3 The narrow (PR 5)

| Table | Removed | Indexes removed |
| --- | --- | --- |
| `customers` | the table, after its 274 rows are deleted (D1, D15) | all six |
| `paymentRecords` | `customerId`, `contextType`, `originatingOpportunityId` (D12) | `by_customerId_and_recordedAt`, `by_originatingOpportunityId_and_recordedAt`, `by_originatingOpportunityId_and_status_and_recordedAt` |
| `leadCustomerSearchRows` | `customerId` | `by_tenantId_and_customerId` |
| `convex.config.ts` | the `customerConversions` aggregate, cleared first | |

These stay:

- `domainEvents.entityType: "customer"`: the 274 `customer.converted` events are history and keep their stored `leadId`.
- `leadCustomerSearchRows.customerStatus`: it now holds the person-level status (§4.4).
- `leads.status: "converted"`: it marks a person with an enrollment, as it marked a person with a customer row.
- The permissions `customer:view-all`, `customer:view-own` and `customer:edit`: routes check them, and `customer:edit` gates the enrollment status control.
- `paymentRecords.commissionable` and the non-commissionable origins. After PR 4 nothing writes them (Q3); PR 4 adds them to Phase 6's dead fields in the ADR.

## 4. Rules

### 4.1 What an enrollment is

`syncPersonEnrollments(ctx, { tenantId, leadId })` in `convex/lib/enrollments.ts` is the one place enrollments are written, apart from an admin's status change and a merge (§4.7). It reads the person's deals (`opportunities.by_tenantId_and_leadId`) and each deal's payments, as `collectLifecycleEvidence` does, and throws past 100 deals or 50 payments a deal rather than derive from part of them (the largest person has 19 deals). The derivation on its own is `derivePersonEnrollments`, which the assert uses.

1. It groups the payments that aren't disputed by `programId`, and takes the earliest of each group by `recordedAt`, then `_creationTime`. A payment with no deal doesn't count: only `recordCustomerPayment` writes one, and it has never run in production (§2.2).
2. A program with such a payment has one enrollment: its `opportunityId` and `enrolledAt` come from that payment. A missing one is inserted as `active`; an existing one whose times differ is patched.
3. An enrollment whose program has no such payment left is deleted (§4.3), except in the program correction case (§4.6). If two enrollments exist for one person and program, the oldest by creation stays and the others are deleted.
4. From PR 2, it rebuilds the person's search row when anything changed. In PR 1 nothing reads enrollments, so it writes only enrollments: no event, counter, lead status or search row.

It returns what it created, moved, repointed and deleted, and whether the person had an enrollment before and has one after, which is what PR 4's conversion side effects need (§4.2, §4.3).

A second deal for a program the person already has adds its payments to that enrollment and creates nothing. Payments don't store their enrollment: a payment's enrollment is its deal's person and its program, one indexed read (D1).

### 4.2 The person becomes a customer

From PR 4, when `syncPersonEnrollments` takes a person from no enrollments to one or more, it does what `executeConversion` does today, minus the copy:

- `leads.status` from `active` to `converted` (through `validateLeadTransition`), `tenantStats.totalCustomers` +1, and `totalLeads` −1 when the person counted as a lead;
- a `lead.status_changed` event, and an `enrollment.created` event for each enrollment (§4.10).

It needs no email. The lifecycle stage comes from `recordPayment`, which every payment path already calls; `recordCustomer` goes (D9).

Until PR 4, `executeConversion` keeps doing all of this and keeps writing the customer row; `syncPersonEnrollments` only writes enrollments beside it.

### 4.3 When the last payment goes

Voiding a side deal payment is the only way a payment becomes disputed today. When it leaves a program with no payment, that enrollment is deleted with an `enrollment.removed` event. When it leaves the person with no enrollment, the person goes back to `active`, `totalCustomers` −1 and `totalLeads` +1, with a `lead.status_changed` event, as `rollbackCustomerConversionIfEmpty` does today; `voidPayment` then calls `correctLeadLifecycle` as now. One difference: today the rollback only deletes the customer if the voided deal was its winning deal. An enrollment stays while any deal still has a payment for its program, and takes its times from the earliest one left.

### 4.4 Status

Status belongs to the enrollment (D3). An admin changes it per enrollment (`updateEnrollmentStatus`, `customer:edit`), which sets `statusChangedAt` and `statusChangedByUserId` and emits `enrollment.status_changed`. Nobody pauses or churns a customer today, and the tenant admin asked for the control anyway (Q2), so PR 3 builds it:

- The person page's Programs section shows each enrollment's status with a select for users with `customer:edit` (Active, Paused, Churned).
- Moving to Paused or Churned opens a dialog with an optional reason (up to 500 characters). Moving back to Active needs no reason.
- The reason lives only in the event's metadata, beside `fromStatus` and `toStatus`; the enrollment stores no note. The timeline shows the change and its reason.
- Under a changed status the section shows when and by whom, from `statusChangedAt` and `statusChangedByUserId`; a deleted user shows as "Removed user".
- A select to the current status, or a stale one (the enrollment changed since the page loaded), changes nothing. The person-level status the list shows (`leadCustomerSearchRows.customerStatus`) is `active` if any enrollment is active, else `paused` if any is paused, else `churned`.

Until PR 4, the two statuses are kept equal in both directions. `updateCustomerStatus` sets the status of the enrollment for the customer's program as well, with `statusChangedAt` and `statusChangedByUserId`; a person the backfill hasn't reached has no enrollment yet, and the backfill carries the status. Nothing calls it from the app (§2.7). `updateEnrollmentStatus` sets the customer row's status (with `pausedAt` or `churnedAt`) when the enrollment is for the customer's program, then rebuilds the search row. That mirror only keeps `assertEnrollments` true: nothing reads the customer row's status once PR 2 is live, and PR 2 merges before PR 3, so the status control never exists while the list reads the customer row. The list's status is always the person-level status of every enrollment.

### 4.5 A second program

A second program is a new deal (decision 3, rule 7), and its first payment creates the enrollment. Today that works through a new Calendly booking or a side deal: the side deal form's person picker includes customers, and Phase 0 removed the rules that blocked a second deal for the same person. `createManual` already writes its credit rows through `recordDealCreation`. No customer has bought a second program yet, so the tenant admin chose not to build a dedicated control for it (Q1): the side deal form and a new booking stay the ways in, and enrollments handle either.

### 4.6 Program corrections

`correctPayment` in billing can change a payment's program, and today it then patches the customer's program if the payment is on the winning deal. From PR 1 it calls `syncPersonEnrollments`: the payment joins the enrollment for its new program, created if none exists. When that leaves the old program's enrollment with no payment and the new program had none, the enrollment changes program instead of being deleted and recreated, so it keeps its ID, status and status history (D13).

One correction pairs one enrollment with one program. When a sync finds several of each, as one that catches up on several changes can, it pairs them in a fixed order. First an enrollment pairs with the program whose earliest payment is the one the enrollment followed (same deal and time), since that payment changed program. The rest pair oldest with oldest: enrollments by `enrolledAt`, then creation, and programs by their earliest payment.

### 4.7 Merges

From PR 4, `mergeLead` accepts a source or target that is a customer (D7):

1. Deals move with their payments as now (`moveOpportunityToLead`).
2. Each source enrollment whose program the target has no enrollment for moves to the target (its `leadId` changes; it keeps its ID and status). Where both have one, the target's stays, with the status of whichever an admin changed most recently (`active` if neither was changed), and the source's is deleted with an `enrollment.removed` event whose reason is `merge`.
3. `syncPersonEnrollments(target)` re-derives the times from every payment the target now has, and makes the target a customer if the source was one (§4.2).
4. A source that was a customer stops counting: `totalCustomers` −1. So two customers merge to `totalCustomers` −1, and a customer merged into a non-customer leaves it unchanged.

The lifecycle and touches combine as now. The merge page's target search includes customers, and `getMergePreview` lists the enrollments that move and the ones that combine. `syncCustomerSnapshot` goes.

### 4.8 One row per fact

Every writer of an enrollment runs inside one mutation: `syncPersonEnrollments` reads the person's enrollments and writes the difference, so a retried batch, a concurrent payment or the backfill finds what the first writer wrote (mutations are serializable). The identity is the person and the program. `assertEnrollments` fails on two enrollments with the same person and program, on an enrollment with no payment behind it, and on a payment with no enrollment.

### 4.9 Revenue credit

`paymentRecords.attributedCloserId` stays (D5). It records who is credited for that payment when it is recorded: a closer credits themself, and an admin credits the deal's working owner. The deal's `closer` rows hold who booked and was reassigned, not who closed a later payment, and a closer can record an additional payment on a deal another closer booked. Every revenue number reads it and none reads revenue by another role (§7).

### 4.10 Events

- New entity type `enrollment`, with `enrollment.created`, `enrollment.status_changed` and `enrollment.removed`. Each carries `leadId`, `programId` and `opportunityId` in its metadata, so `domainEventLinks` finds the person after the enrollment is gone. None is a touch.
- From PR 4, `customer.converted`, `customer.status_changed` and `customer.conversion_rolled_back` are no longer emitted. The person's conversion is its `lead.status_changed` event and its first `enrollment.created`.
- The activity feed's entity filter gains Enrollment and keeps Customer for the old events. The timeline colours `enrollment.*` as it does `customer.*`.

## 5. Write paths

| Event | Where | PR 1 | PR 4 |
| --- | --- | --- | --- |
| Payment on a meeting | `closer/payments.ts:logPayment` | `syncPersonEnrollments` after the payment | replaces `executeConversion` and the customer link |
| Payment on a reminder | `closer/reminderOutcomes.ts` | same | same |
| Payment on a side deal | `sideDeals/logPayment.ts` | same | same |
| Additional payment | `closer/additionalPayment.ts` | same; the program falls back to the deal's earliest payment's when the deal has no sold program (D14), and `opportunities/detailQuery.ts` offers the control on those deals and names that program | stops linking the customer |
| Customer payment | `customers/mutations.ts:recordCustomerPayment` | same; the payment has no deal, so it counts toward no enrollment and the sync changes nothing | retired |
| Side deal payment voided | `sideDeals/voidPayment.ts` | same, after the dispute and the rollback | replaces `rollbackCustomerConversionIfEmpty` |
| Payment corrected | `billing/mutations.ts:correctPayment` | same, after every correction of a payment on a deal; only a program change moves an enrollment (§4.6) | stops syncing the customer's totals |
| Customer status | `customers/mutations.ts:updateCustomerStatus` | also sets the enrollment's status (§4.4) | retired; `updateEnrollmentStatus` |
| Manual conversion | `customers/mutations.ts:convertLeadToCustomer` | | retired |
| Person merged | `leads/merge.ts` | | moves enrollments (§4.7) |
| Person edited, booking updates the person | `leads/mutations.ts:updateLead`, `pipeline/inviteeCreated.ts` | | stop calling `syncCustomerSnapshot` |
| Program renamed | `tenantPrograms/sync.ts` | | stops patching customers; enrollments hold no name |
| Program corrected | `lib/soldProgramCache.ts` | | stops patching the customer's program |
| Side deal for a new person | `opportunities/createManual.ts` | | email optional; at least one of email, phone or handle (D8) |
| Tenant data purge | `admin/tenantsMutations.ts`, `testing/operationalData.ts` | delete enrollments too | stop deleting customers |

Other writes to payments and deals need no sync in PR 1. `billing/mutations.ts:markReviewed` moves a payment from recorded to verified, and both count. `tenantPrograms/sync.ts` renames, `reporting/backfill.ts` sets `origin`, and conversion and its rollback set `customerId`; an enrollment reads none of them. A merge is the only write that moves a deal to another person (`moveOpportunityToLead`), and until PR 4 it accepts only active people, who have no payment that counts, since a payment converts its person. The one-off `purgePhase6BlockerRecords` in `admin/migrations.ts` ran before this phase and isn't run again.

Every path that inserts a payment already calls `recordPayment` (lifecycle), `insertPaymentAggregate`, `applyPaymentStatsDelta` and `emitDomainEvent`; none of that changes. `assertPaymentRow` stops requiring a customer for a non-commissionable row in PR 4: every payment is on a deal.

## 6. Readers

### 6.1 Leads and customers list and search (PR 2)

`rebuildLeadCustomerSearchRow` reads enrollments instead of the customer row:

- `lifecycle` is `customer` when the person has an enrollment;
- `customerStatus` is the person-level status (§4.4);
- `displayName`, `email` and `phone` come from the person only;
- `totalPaidMinor` and `paymentCurrency` come from the payments on the person's deals that aren't disputed, the same payments the customer's total counted. They are read only for a person with an enrollment, from the person's newest 100 deals and up to 100 payments on each, so a person with none keeps the reads they have today;
- `convertedAt` is the earliest `enrolledAt`; `latestActivityAt` takes it instead of `convertedAt`, and the latest of those payments instead of the customer's;
- `customerId` is no longer written, and a rebuild unsets it (the patch passes it as undefined until the narrow drops the field). The list and search results stop returning it; no page read it.

The search text drops the customer copy; the person's own name, email, phone and identifiers are already in it. Pasting a customer ID into search keeps working until the narrow, which removes it with the table: `identifierResolution.ts` resolves the ID to the customer's person before the text search runs. `rebuildCustomerSearchRows` re-projects the 274 customers' rows after the deploy (§10.4).

Since the row reads enrollments, a payment path must rebuild it after `syncPersonEnrollments`, not only before. And a payment that leaves the enrollments as they were still changes the total: an additional payment for a program the person has, or an amount correction. Today `syncCustomerPaymentSummary` rebuilds the row for those; once PR 4 removes it, `recordAdditionalPayment` and `correctPayment` need their own rebuild, or `syncPersonEnrollments` rebuilds whether or not an enrollment changed.

### 6.2 Person page (PR 3)

`getEntityDetail` returns the person's enrollments instead of the customer row: for each, the program and its current name, status, `enrolledAt`, the deal, and the total and count of its payments. The header shows Customer when the person has an enrollment, the person-level status, the total paid across programs, "Customer since" (the earliest enrollment) and the programs. A new Programs section lists each enrollment with its status, its deal and what it has paid, with the status control for admins (§4.4). The payments section lists the payments on the person's deals; there are no customer-only payments (§2.2). The snapshot aside's identity path shows the first enrollment's deal as the winning deal.

### 6.3 Reports (PR 2)

- **Leads & Conversions** (`reporting/leadConversion.ts`): conversions in the range are the enrollments in the range that are their person's first, with the enrollment's deal as the winning deal and the recorder of its first payment as the fallback closer, as `convertedByUserId` was (all 274 won deals have a closer, so the fallback isn't used today). The first payment is the one on the enrollment's deal, for its program, not disputed, whose `recordedAt` equals `enrolledAt`, earliest created. Counting every enrollment would count a person twice once they buy a second program. The report reads at most 2,500 enrollments in a range, as it read customers, and stops returning `isCustomersTruncated`, which no page read; `isConversionDataTruncated` stays.
- **Admin dashboard `newCustomers`** (`dashboard/adminStats.ts`, not shown in the app): the same first enrollments, read through the same bounded helper (2,500 a period) instead of the open loop over customers.
- **Revenue top deals** (`reporting/revenue.ts`): stop returning `customerId`, which the table ignores.

### 6.4 Billing (PR 2)

- The customer name, email and phone on the queue, the review page and the export come from the person (`billing/enrichment.ts`, `billing/types.ts`, `billing/export.ts`): the person of the payment's deal. The name is the person's full name, else their email, as the customer copy was built. The row's `customer.id` becomes `customer.leadId`; no page read it.
- A payment with no meeting (the 13 in §2.2) falls back to the meeting of the earliest payment on its deal that has one, whatever that payment's status, instead of the customer's `winningMeetingId`. For the 5 additional payments that is the same meeting; the 8 side deal payments have none either way. Then the deal's first and latest meeting, as now.
- The deal fallback through `customer.winningOpportunityId` goes; every payment has its deal.
- The audit's `missingCustomerId` and `unresolvedCustomer` checks become `missingEnrollment`: a payment that isn't disputed with no enrollment for its person and program. Its sample diagnostics report `enrollment.resolved` instead of the customer ID.

### 6.5 Removed

- PR 3: `convex/customers/queries.ts`; the orphaned customer list and detail components under `app/workspace/customers/`, the record payment dialog, the convert dialog and the orphaned `lead-detail-page-client.tsx` that renders it. The two redirect pages stay.
- PR 4: `customers/conversion.ts`, `customers/mutations.ts`, `lib/syncCustomerSnapshot.ts`, `syncCustomerPaymentSummary` and `rollbackCustomerConversionIfEmpty`, the `customerConversions` write hooks and backfill, `reporting/lib/programDimensions.ts` (no importers), and the customer parts of the old one-off migrations in `admin/migrations.ts`.
- PR 5: `leadCustomers/redirects.ts`, the customer ID branch of `identifierResolution.ts`, the parity module (`enrollments/parity.ts` and `enrollments/customerCopy.ts`, which holds the customer-row computations the readers used before PR 2), and the `customerId: undefined` line in `rebuildLeadCustomerSearchRow`. `/workspace/customers/[customerId]` redirects to the customers list, since a customer ID no longer names anything; only the deleted components linked to it.

## 7. Report numbers

| Report | Change |
| --- | --- |
| Leads & Conversions: conversions, by closer, excluded, conversion rate, meetings per sale, time to conversion | none; §10.3 proves it month by month. Once someone buys a second program, it still counts them once, at their first. |
| Admin dashboard `newCustomers` (not shown) | none |
| Leads and customers list: lifecycle, status, total paid | none for the 274 customers |
| Leads and customers list and billing: name, email, phone | the person's current details instead of the copy: the 4 names and 2 handle lists in §2.4 change |
| Billing phone closer and DM credit for payments without a meeting | none (§6.4) |
| Activity summary by entity and event type | from PR 4, a new customer counts as one `lead.status_changed` and one `enrollment.created` per program instead of `customer.converted`; earlier events don't change |
| Revenue, team report, sales calls, closer dashboard, operations export, billing counts | none: they read payment fields that this phase doesn't change |
| Lead gen prospect conversion, Customer column | none: the Customer stage times don't change (§2.4) |

## 8. What else moves

- Tests that insert customer rows or expect the customer behaviour: `opportunities/secondPrograms.test.ts`, `opportunities/createManual.test.ts` (expects `customer.lead_email_missing`), `leads/lifecycleBackfill.test.ts`, `leads/lifecycleWrites.test.ts`, `lib/opportunityActivity.test.ts`, `lib/teamMembers.test.ts`, `attribution/writePaths.test.ts` and `operations/meetingStats.test.ts`. Each gets the enrollment equivalent; `leads/merge.test.ts`'s check that nothing still names the source person covers enrollments.
- `admin/migrations.ts:seedTenantStatsInternal` counts converted people for `totalCustomers`.
- `migrations.ts:assertLeadCustomerSearchRowsBackfilled` checks the row against the projection instead of `row.customerId`: `lifecycle`, visibility, `customerStatus`, `totalPaidMinor`, `paymentCurrency` and `convertedAt` as derived from enrollments, and no `customerId`. It doesn't check `latestActivityAt` or the contact fields, which writes outside this phase move; `compareSearchRows` counts the contact changes.
- `reporting/verification.ts` drops the `customerConversions` count.

## 9. Deploy order

| PR | What | Safe alone because |
| --- | --- | --- |
| 0 | This plan | docs |
| 1 | Widen: `enrollments` (§3.1), the `enrollment` event type, `syncPersonEnrollments` beside every payment write path (§5, PR 1 column), the additional payment fallback (D14), the backfill, asserts and parity queries (§10) | a new table written beside the customer rows; nothing reads it yet |
| 2 | List and search, reports, billing (§6.1, §6.3, §6.4) | runs after the PR 1 backfill and assert pass and the parity queries agree in production; the customer rows are still written, so a revert is safe |
| 3 | The person page with its Programs section and the enrollment status control (§4.4, §6.2), `updateEnrollmentStatus`, the orphaned customer UI removed (§6.5) | as PR 2 |
| 4 | Stop writing customers: conversion through `syncPersonEnrollments`, no email requirement, the merge, the retirements, `contextType` optional and every reader of `contextType`, `customerId` and `originatingOpportunityId` removed (§3.2, §4.2 to §4.7, §5 PR 4 column, D12); the clear and delete migrations; the non-commissionable origins added to the ADR's Phase 6 row (Q3) | no reader reads the customer rows after PRs 2 and 3 |
| 5 | Narrow (§3.3), the ADR status, the review's Phase 4 card, this plan's status | after the clears, the deletion and their asserts pass in production |

PR 2 merges before PR 3, so the list reads the person-level status from enrollments before the status control exists (§4.4).

Production runs, in this order (§10.6 has the commands):

1. After PR 1: `backfillEnrollments` dry run, run, then `assertEnrollments` and `assertPaymentEnrollments`; the parity queries (§10.3).
2. After PR 2: `rebuildCustomerSearchRows`, then `assertLeadCustomerSearchRowsBackfilled`; the parity queries again.
3. After PR 4: the production export of `customers` (§10.7); `clearPaymentCustomerFields` dry run, run, assert; `deleteCustomers` dry run, run, assert; `clearCustomerConversions`; `assertEnrollments` and `assertPaymentEnrollments` (reset); `assertDealAttributions` (reset), since PR 4 changes the side deal form; `assertLeadLifecycle` in the background, since PR 4 changes how the Customer stage is derived.
4. After PR 5: the schema push checks that no row carries a removed field; `assertEnrollments` (reset) once more. The export is deleted when the phase ends.

## 10. Backfill, parity and assert migrations

All are `migrations.define` in `convex/migrations.ts` unless named otherwise. None emits events, moves a stage or changes a counter. Batch sizes are a first guess; each dry run sets the real one.

The expected counts are the §2 snapshot. Payments and customers keep arriving between runs, so a run can process more rows than expected. No migration or assert checks a count; the asserts check each row. The log records each run's processed count, and the recheck accounts for any difference with rows created after the snapshot (`_creationTime` after 2026-10-21).

### 10.1 `backfillEnrollments` (PR 1)

Over `customers`, batch 50. For each customer, `syncPersonEnrollments` for its person, then the enrollment for the customer's program takes the customer's status (with `statusChangedAt` from `churnedAt` or `pausedAt` when the status isn't active). `statusChangedByUserId` stays unset, since the row doesn't say who changed it. It writes only what differs, so a rerun changes nothing. A customer whose program has no enrollment after the sync stops the run with the customer's and program's IDs, since its status would have nowhere to go; production has none (§2.2). Expected: 274 enrollments, one per customer, all active, each with the customer's program, `enrolledAt` equal to its `convertedAt` and `opportunityId` its `winningOpportunityId`. 6 batches.

### 10.2 `assertEnrollments` and `assertPaymentEnrollments` (PR 1)

`assertEnrollments`, over `enrollments`, batch 100: each one re-derives to the same `opportunityId` and `enrolledAt` (§4.1); has at least one payment behind it; is the only one for its person and program; belongs to a converted person who isn't merged; and, while customer rows exist, agrees with the person's customer row. Only two comparisons are made against the row: the enrollment for the row's program has the row's status, and the person's first enrollment (earliest `enrolledAt`) has `enrolledAt` equal to `convertedAt`, with the row's program among the person's enrollments. A later enrollment for another program is checked only against its payments, as every enrollment is. It throws on the first problem, with IDs and times only.

`assertPaymentEnrollments`, over `paymentRecords`, batch 100: each payment that isn't disputed and has a deal has an enrollment for its deal's person and its program, with `enrolledAt` no later than the payment.

The read-only recheck after each run checks the other direction: every converted person has an enrollment and every person with an enrollment is converted (the 274 converted people, read through `leads.by_tenantId_and_status`).

### 10.3 Parity (PR 1, run before PRs 2 and 3 deploy)

Internal queries in `convex/enrollments/parity.ts` compute each number both ways and return the differences:

- `compareLeadConversion`, for each month from 2026-04 and the last 7 days: every Leads & Conversions metric from the customer rows and from first enrollments.
- `compareSearchRows`: for each of the 274 customers, the search row projected from the customer and from the enrollments: `lifecycle`, `customerStatus`, `totalPaidMinor`, `paymentCurrency`, `convertedAt`, `latestActivityAt`; and the count of rows whose name, email, phone or social handles change (expected: the drift in §2.4).
- `compareBillingRows`: for each of the 279 payments, the deal and meeting billing resolves both ways, and the count whose customer labels change.

Each takes the `tenantId` and returns IDs and values, no contact details. `compareLeadConversion` takes optional `ranges` (each business month from 2026-04 and the last 7 days by default) and a `cursor`, the index of the next range; it stops after about 200 conversions read both ways and returns `continueCursor` until it is null. The other two page by `cursor` and `numItems` (100 by default, 200 at most) over `customers.by_tenantId` and `paymentRecords.by_tenantId_and_recordedAt`, so production's 274 customers take 3 calls and 279 payments 3 calls. Both ways of each number are functions beside the reader that shows it: `conversionsFromCustomers` and `conversionsFromEnrollments` in `reporting/leadConversion.ts`, `countNewCustomersFromCustomers` and `countNewCustomersFromEnrollments` in `dashboard/adminStats.ts`, `customerFieldsFromCustomerRow` and `customerFieldsFromEnrollments` in `leadCustomers/projection.ts`, and `resolveBillingFromCustomer` and `resolveBillingFromPerson` in `billing/enrichment.ts`. First enrollments come from `enrollments/firstEnrollments.ts`.

Every "none" in §7 must come back with no difference before PRs 2 and 3 deploy. The results go into §13.

### 10.4 `rebuildCustomerSearchRows` (PR 2)

Over `customers`, batch 50: rebuilds each customer's person's search row with the PR 2 projection, which leaves `customerId` unset. Expected: 274 rows. Then the existing `assertLeadCustomerSearchRowsBackfilled`, amended (§8); before the rebuild it fails on the first customer's row, which still names the customer.

### 10.5 The clears and the deletion (PR 4)

- `clearPaymentCustomerFields`, over `paymentRecords`, batch 100: unsets `customerId` and `contextType`. Expected: 279 rows. `assertPaymentCustomerFieldsCleared` checks none is left. Before its dry run, a search of the deployed commit shows no reader of `contextType`, `customerId` or `originatingOpportunityId` outside the schema and these migrations (D12); if one is left, the clear waits for a reviewed fix.
- `deleteCustomers`, over `customers`, batch 100: deletes each row. Expected: 274. `assertCustomersDeleted` (read-only) counts none left. The export taken before it is the rollback (§12).
- `clearCustomerConversions`, an internal mutation: clears the aggregate's namespace for each tenant. Expected: 274 entries gone.

### 10.6 Commands

Every command runs against production with `--env-file .env.vercel.production`; without it the CLI targets the dev deployment. Filter dry-run output with `grep -E '"processed"|"DryRun"|error'`, since a dry run prints whole documents.

```
npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:backfillEnrollments","dryRun":true}'
npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:backfillEnrollments"}'
npx convex run --env-file .env.vercel.production --component migrations lib:getStatus '{"names":["migrations:backfillEnrollments"]}'
```

The other migrations run the same way, in §9's order. The dry run must finish without an error and process rows of the table it names; an error, or a dry run that would write rows the plan doesn't expect, stops the phase for a fix in a reviewed PR. Then the run, then poll `lib:getStatus` until it reports `"isDone": true` (a background loop that waits 30 seconds between calls), read any error, and only then run its assert, polled the same way. A batch that fails on a known Convex limit commits nothing and resumes from its cursor at a smaller batch. Any other failure, and any failed assert, stops the phase until a reviewed fix ships and the failed step and its assert pass again (§12). The parity queries run with `npx convex run --env-file .env.vercel.production enrollments/parity:<name> '<args>'`, for example `enrollments/parity:compareSearchRows '{"tenantId":"k57dqjfyf8qqy31bq375ng8gb984b24q","cursor":null}'`, then again with each `continueCursor` until `isDone`.

### 10.7 The export

Before the clear, only the `customers` table is exported, into a new directory from `mktemp -d` outside the repository, with mode 700:

```
DIR=$(mktemp -d) && chmod 700 "$DIR"
npx convex data --env-file .env.vercel.production customers --format jsonl --limit 1000 > "$DIR/customers.jsonl" \
  || { rm -rf "$DIR"; false; }
wc -l < "$DIR/customers.jsonl"
```

A failed or interrupted export deletes the directory at once (`rm -rf "$DIR"` on a non-zero exit; after an interruption, the operator removes it before retrying), so no partial file is left. The retention deadline below counts from when the directory is created.

PR 4 has stopped writing customer rows by then, so their count is fixed. A read-only inline query counts the `customers` rows (274 expected), and the export's line count must equal it, with the limit above it. Any other count stops the phase before `clearPaymentCustomerFields` runs. The file stays on the operator's machine: it is never printed, committed, copied or uploaded, and only its line count is read. The operator's disk is encrypted (FileVault on). The file is deleted with its directory when the phase ends, or 7 days after the directory was created if the phase stops before then, whichever comes first; a stopped phase's handoff names the deadline. The deletion is checked by listing the parent directory, and the log records the row count and when it was deleted. Recovery doesn't depend on the export: every field but `status` re-derives from the person and the first payment (§2.4), and all 274 statuses are active, so a repair after the export is gone rebuilds the rows from those. No other table is exported; the payments, search rows and aggregate are rebuilt from the customer rows and the payments (§12).

The health checks that stay after the phase: `assertEnrollments` and `assertPaymentEnrollments`, with `"reset":true`, beside Phase 3's.

## 11. Decisions

Accepted as recommended on 2026-10-21, with D6 as amended by Q1.

- **D1. Whether a `customers` row survives.** Recommended: no. Every field but `status` is a copy of the person or of the first payment, and §2.4 shows them equal on all 274 rows, except where the copies have drifted. Status moves to the enrollments, and the person's stage and `leads.status` already say who is a customer. So the 274 rows are deleted after an export and the table is dropped. `paymentRecords.customerId` is dropped, not replaced: a payment's enrollment is its deal's person and its program. `leadCustomerSearchRows.customerId` is dropped. The 274 `customer.converted` events stay as history. Old `/workspace/customers/<id>` links go to the customers list. The other option keeps a slim row with `leadId`, `convertedAt` and `convertedByUserId`, which copies the person's stage time and the first enrollment.
- **D2. What an enrollment is.** Recommended: one per person and program, created by the earliest payment for that program, on any of the person's deals, that isn't disputed; a later deal for the same program adds its payments to it. It stores that payment's deal and time beside its status (§3.1), and one function derives it from the payments for every write path, the backfill and the assert (§4.1). The other option, one enrollment per won deal, would give a person who renews a program two enrollments in it, which "one row per person and program" rules out.
- **D3. Where status lives.** Recommended: on the enrollment. The list shows one status per person: active if any enrollment is active, else paused if any is, else churned. The person page shows each program's own, with a control for admins (Q2, §4.4).
- **D4. Customer totals.** Recommended: not stored. The person page sums each enrollment's payments and the person's at read time, from the deals and payments it already loads; the list's total stays on the search row, projected from the person's payments as now. With 279 payments in all, an aggregate isn't worth its write hooks. The other options store totals on the enrollment, which recreates `syncCustomerPaymentSummary` and its 100-payment cap.
- **D5. Revenue credit.** Recommended: the payment keeps `attributedCloserId`, for the reasons in §4.9, and every revenue number keeps reading it. Revenue by any other role reads payments joined to `dealAttributions` when commissions arrive (decision 2); nothing asks for it yet. The other option credits revenue to the deal's `closer` rows, which would move closer revenue wherever a later booking changed host or a closer recorded a payment on another closer's deal.
- **D6. A second program.** It is a new deal: a side deal or a new Calendly booking, and the payment is recorded there; an admin can open the side deal and record the payment on the closer's behalf. No dedicated button is built, since it hasn't happened yet (Q1). `recordCustomerPayment` and everything only it used are retired.
- **D7. Merging two customers.** Recommended: `mergeLead` accepts customers. The source's enrollments move to the target; where both have the same program, one remains, with the status an admin set most recently (§4.7). The merge page offers customers as targets and the preview lists the enrollments. Today no customer can be merged at all, and the ADR's Phase 4 row needs it.
- **D8. Email.** Recommended: conversion needs no email, and the side deal's new-person form takes an email, a phone or a social handle, at least one, instead of requiring an email; a placeholder email is still refused. The email was required only because the payment converted the person.
- **D9. Lifecycle.** Recommended: the Customer stage comes from payments only. `customerEvidence` and `recordCustomer` go, since the first payment gives the same time on all 274 (§2.4), and `collectLifecycleEvidence` stops reading customers. `assertLeadLifecycle` runs after PR 4.
- **D10. Events.** Recommended: an `enrollment` entity type with created, status changed and removed events (§4.10); the `customer.*` events stop with PR 4 and their rows stay. The activity summary counts new customers under Enrollment from then on (§7). The other option keeps emitting `customer.converted` under a lead entity, a second event for what `lead.status_changed` already records.
- **D11. Report numbers.** Recommended: every number stays the same except the contact labels where the copy drifted and the activity summary's event types (§7). Leads & Conversions counts a person's first enrollment, so a second program doesn't count a person twice.
- **D12. Payment fields.** Recommended: the narrow drops `customerId`, `originatingOpportunityId` (no rows; only `recordCustomerPayment` wrote it) with its two indexes, and `contextType` (all 279 rows are `opportunity`, and its other value existed only for customer payments). PR 4 removes every branch that reads them, in billing, revenue, booked vs sold, team outcomes, the operations export, the sold program cache, the timeline and the person page, treating every payment as a deal payment. Only then does the clear unset `contextType` (§10.5), so no report changes when the value goes. The other option leaves `contextType` and `originatingOpportunityId` for Phase 6's dead fields.
- **D13. Program corrections.** Recommended: a corrected payment joins its new program's enrollment, and an enrollment the correction empties changes program when the new program had none, keeping its ID and status (§4.6). Today the customer's program follows a correction on the winning deal; this keeps that behaviour per program.
- **D14. Additional payments on the 10 deals with no sold program.** Recommended: `recordAdditionalPayment` takes the program from the deal's earliest payment that isn't disputed when the deal has no `soldProgramId`, so those 10 customers can pay again. No data changes. The other option backfills `soldProgramId` on the 10 deals, which moves them into sold program filters and buckets that leave them out today.
- **D15. The deletions.** Recommended: export `customers` (274 rows) to a temp dir, unset `customerId` and `contextType` on 279 payments, rebuild 274 search rows without `customerId`, delete the 274 customer rows, clear the `customerConversions` aggregate (274 entries) and unmount it, then drop the table, fields and indexes in §3.3. No payment, deal, meeting or person is deleted or changed otherwise. The export is deleted when the phase ends.
- **D16. Production runs.** Recommended: the order in §9, dry run first for each backfill, clear and deletion, batch sizes from the dry runs (first guesses in §10), each run as soon as the previous assert passes, with no approval stop in between. Migrations on different tables may run side by side, and the log says so.

### 11.1 Questions about how the team works

Answered by the tenant admin on 2026-10-21.

- **Q1. A second program.** It hasn't happened yet; no dedicated control. The side deal form (whose person picker includes customers) and a new booking stay the ways in (§4.5, D6).
- **Q2. Paused and churned.** Nobody does it today; build a control anyway. PR 3 adds the per-program status select with an optional reason (§4.4).
- **Q3. Payments with no closer credit.** Not for now. Nothing writes the non-commissionable origins after PR 4, and PR 4 adds them to Phase 6's dead fields in the ADR.
- **Q4. Production runs.** Yes: every run in §9 and §10 is approved, and the phase runs end to end.

## 12. Rollback

Fix forward, reviewed. Every repair is an internal migration with its own assert, run as §10.6 says, and the phase continues only after that assert and the assert of the step it repaired pass again.

- **PR 1.** Revert. The enrollments are new and nothing reads them yet; a wrong one is fixed by re-running `syncPersonEnrollments` for its person in a reviewed repair.
- **PRs 2 and 3.** Revert: the readers go back to the customer rows, which PR 4 hasn't stopped writing.
- **PR 4.** Before the clear and the deletion run, revert. After them, revert PR 4 (and PRs 2 and 3 if the readers must go back too), except that `recordCustomerPayment` and `convertLeadToCustomer` stay deleted: no screen has reached them since PR 3, and with them gone nothing can write a payment off a deal. Before any repair write, a read-only preflight over every payment must find none with no deal or with origin `customer_direct` or `bookkeeper_direct`; if it finds one, the repair doesn't start. Then one reviewed, idempotent repair migration rebuilds every cleared artifact from the current records, each with its assert:
  1. writes a customer row for every converted person, inserting a missing one and replacing every field of an existing one (a `deleteCustomers` that stopped part way leaves some), derived as §2.4 shows every field can be: contact fields from the person, `convertedAt`, `convertedByUserId`, `winningOpportunityId` and `winningMeetingId` from the first enrollment's first payment, program from the first enrollment, totals from the person's payments, `status` from the enrollment for that program, with `pausedAt` or `churnedAt` from its `statusChangedAt`, so `assertEnrollments` holds (§10.2). That covers people who became customers after the export and statuses changed after it. `notes` comes from the export, which holds every customer row there was when PR 4 stopped creating and editing them; a person who became a customer after the export has no row in it and gets no notes. The assert checks the notes of each row the export holds against it and skips the rest. None of the 274 rows has notes (§2.1);
  2. sets `contextType: "opportunity"` on every payment, and `customerId` from its deal's current person's customer row where one exists (a person whose last enrollment went has none, and their payments keep `customerId` unset; after a merge the deal's person is the target, whose row step 1 wrote). Every payment is on a deal: no payment has origin `customer_direct` or `bookkeeper_direct` (§2.2), none can be written after PR 4, and the preflight checked it, so `opportunity` was every payment's value;
  3. rebuilds the customers' search rows with the reverted projection, which writes the new `customerId`;
  4. refills `customerConversions` with its backfill, which the revert brings back.

  Writes don't stop during the repair, and don't need to. The reverted write paths maintain customer rows again, as they did before PR 4: a payment during the repair converts its person or updates the row's totals and links itself, and a status change or merge writes the row as it used to. Every step re-derives from current records, so rerunning one gives the same rows. The asserts run after the last step, and if one fails because a write landed between steps, the whole repair reruns before anything else.

  Only payments, search rows, the aggregate and the 274 old `customer.converted` events name a customer ID. The events keep their stored `leadId` and stay history, so the original IDs don't need to come back. `assertLeadCustomerSearchRowsBackfilled` and `reporting/verification.ts` read the restored values.

- **PR 5.** Revert brings the table and fields back as optional; the values come back through the same repair.

## 13. Production log

All runs on tenant `k57dqjfyf8qqy31bq375ng8gb984b24q`, times in UTC, with `--env-file .env.vercel.production`.

### 13.1 Baseline, 2026-10-21

§2.

### 13.2 Deploys

| PR | What | Deployed |
| --- | --- | --- |
| #153 | the plan | docs, merged 10-21 09:10 |
| #154 | widen: `enrollments`, `syncPersonEnrollments` beside every payment path, D14, the backfill and asserts | 10-21 09:26 |

### 13.3 Runs

| When | Run | Result |
| --- | --- | --- |
| 10-21 09:26 | read-only count before the backfill | 274 customers, 274 converted people, 279 payments, 0 enrollments: the §2 snapshot still held |
| 10-21 09:26 | `backfillEnrollments` dry run, batch 50 | 50, nothing committed |
| 10-21 09:26 | `backfillEnrollments`, batch 50 | done 09:26, 274 customers: 274 enrollments, all `active` |
| 10-21 09:26 | `assertEnrollments` | passed, 274 enrollments |
| 10-21 09:27 | `assertPaymentEnrollments` | passed, 279 payments |
| 10-21 09:27 | read-only recheck | 274 enrollments for 274 people; every converted person has one and every enrolled person is converted; each matches its customer row's program, status, `convertedAt` and winning deal |
